import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultLimits, ReportError, Run, Schedule } from '../common/model';
import { Runner } from '../server/runner';
import { MemoryStore, panels, report } from './fixtures';
const delay = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));
async function waitUntil(predicate: () => Promise<boolean>) { for (let i = 0; i < 300; i++) { if (await predicate()) return; await delay(); } throw new Error('Timed out waiting for run'); }
const executor = { authorize: async () => ({}), execute: async () => panels };
const render = async () => ({ pdf: Buffer.from('%PDF fixture'), pages: 1 });

test('temporary permissions survive retries and are released on completion and queued cancellation', async () => {
  const store = new MemoryStore(); let attempts = 0, releases = 0;
  const temporary = { ...report, grant: { id: 'temporary', fingerprint: 'fixture', createdAt: new Date().toISOString(), authorization: 'until_revoked' as const, temporary: true, specs: {}, settings: {} } };
  const runner = new Runner(store, { ...executor, execute: async () => { if (++attempts === 1) throw new ReportError('QUERY_INCOMPLETE', 'Retry', 503, true); return panels; }, release: async () => { releases++; } }, render, { send: async () => {} });
  const id = await runner.enqueue(temporary, 'manual'); await runner.tick();
  await waitUntil(async () => (await store.get<Run>('runs', id))?.value.attempt === 1 && (await store.get<Run>('runs', id))?.value.status === 'queued');
  assert.equal(releases, 0);
  const current = (await store.get<Run>('runs', id))!; await store.replace('runs', id, { ...current.value, nextAttemptAt: undefined }, current);
  await delay(); await runner.tick(); await waitUntil(async () => !!(await store.get<Run>('runs', id))?.value.grantReleased);
  assert.ok(releases >= 1);
  const cancelled = await runner.enqueue(temporary, 'preview'); await runner.cancel(cancelled, report);
  assert.equal((await store.get<Run>('runs', cancelled))?.value.grantReleased, true);
  runner.stop();
});

test('two runners claim one occurrence and deliver it once', async () => {
  const store = new MemoryStore(); await store.create('reports', report.id, report); let sent = 0;
  const a = new Runner(store, executor, render, { send: async () => { sent++; } }), b = new Runner(store, executor, render, { send: async () => { sent++; } });
  const when = new Date();
  const ids = await Promise.all([a.enqueue(report, 'schedule', when, { senderId: 'sender', recipientGroupIds: ['group'], subject: 'Report', message: '' }, 'schedule-1'), b.enqueue(report, 'schedule', when, { senderId: 'sender', recipientGroupIds: ['group'], subject: 'Report', message: '' }, 'schedule-1')]);
  assert.equal(ids[0], ids[1]); await Promise.all([a.tick(), b.tick()]);
  await waitUntil(async () => (await store.get<Run>('runs', ids[0]))?.value.status === 'complete'); assert.equal(sent, 1); a.stop(); b.stop();
});
test('ambiguous delivery is terminal and never automatically resent', async () => {
  const store = new MemoryStore(); let sent = 0;
  const runner = new Runner(store, executor, render, { send: async () => { sent++; throw new ReportError('DELIVERY_UNKNOWN', 'Relay result unknown.'); } });
  const id = await runner.enqueue(report, 'manual', new Date(), { senderId: 'sender', recipientGroupIds: ['group'], subject: 'Report', message: '' }); await runner.tick();
  await waitUntil(async () => (await store.get<Run>('runs', id))?.value.status === 'delivery_unknown');
  await runner.tick(); assert.equal(sent, 1); runner.stop();
});
test('crash during sending becomes delivery unknown after lease expiry', async () => {
  const store = new MemoryStore(); let sent = 0; const runner = new Runner(store, executor, render, { send: async () => { sent++; } });
  const id = await runner.enqueue(report, 'manual'); const current = (await store.get<Run>('runs', id))!;
  await store.replace('runs', id, { ...current.value, status: 'sending', worker: 'dead', leaseUntil: new Date(Date.now() - 1000).toISOString() }, current);
  await runner.tick(); assert.equal((await store.get<Run>('runs', id))?.value.status, 'delivery_unknown'); assert.equal(sent, 0); runner.stop();
});
test('retry preserves the frozen report and reporting interval', async () => {
  const store = new MemoryStore(); let calls = 0; const seen: Run[] = [];
  const runner = new Runner(store, { authorize: async () => ({}), execute: async run => { seen.push(structuredClone(run)); if (++calls === 1) throw new ReportError('QUERY_INCOMPLETE', 'Temporary', 503, true); return panels; } }, render, { send: async () => {} });
  const id = await runner.enqueue(report, 'manual'); await runner.tick(); await waitUntil(async () => (await store.get<Run>('runs', id))?.value.status === 'queued' && (await store.get<Run>('runs', id))?.value.attempt === 1);
  const current = (await store.get<Run>('runs', id))!; await store.replace('runs', id, { ...current.value, nextAttemptAt: undefined }, current);
  await runner.tick(); await waitUntil(async () => (await store.get<Run>('runs', id))?.value.status === 'complete');
  assert.equal(seen[0].from, seen[1].from); assert.equal(seen[0].to, seen[1].to); assert.deepEqual(seen[0].report, seen[1].report); runner.stop();
});
test('cancellation fences off a late renderer result', async () => {
  const store = new MemoryStore(); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const runner = new Runner(store, executor, async () => { await gate; return render(); }, { send: async () => assert.fail('Cancelled run must not send') });
  const id = await runner.enqueue(report, 'manual'); await runner.tick();
  await runner.cancel(id, report); release(); await delay(30);
  assert.equal((await store.get<Run>('runs', id))?.value.status, 'cancelled'); assert.equal((await store.list('artifacts')).length, 0); runner.stop();
});
test('100 schedules are enqueued while render concurrency stays at two', async () => {
  const store = new MemoryStore(); await store.create('reports', report.id, report);
  const nextAt = new Date(Date.now() - 60000).toISOString();
  for (let i = 0; i < 100; i++) { const schedule: Schedule = { id: `s${i}`, revision: 1, reportId: report.id, owner: report.owner, tenant: report.tenant, cron: '* * * * *', timezone: 'UTC', enabled: true, senderId: 'sender', recipientGroupIds: ['group'], subject: 'Report', message: '', skipped: 0, nextAt, updatedAt: nextAt }; await store.create('schedules', schedule.id, schedule); }
  let active = 0, max = 0; let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const runner = new Runner(store, executor, async () => { active++; max = Math.max(max, active); await gate; active--; return render(); }, { send: async () => {} });
  await runner.tick(); await delay(20); assert.equal((await store.list('runs')).length, 100); assert.equal(max, 2); release(); await delay(30); runner.stop();
});
test('revoked source permissions fail without rendering or email', async () => {
  const store = new MemoryStore(); const runner = new Runner(store, { authorize: async () => ({}), execute: async () => { throw new ReportError('FORBIDDEN', 'Source access revoked.', 403); } }, async () => { assert.fail('Must not render'); }, { send: async () => assert.fail('Must not email') });
  const id = await runner.enqueue(report, 'manual'); await runner.tick(); await waitUntil(async () => (await store.get<Run>('runs', id))?.value.status === 'failed'); assert.equal((await store.list('artifacts')).length, 0); runner.stop();
});

test('graceful shutdown preserves a generating lease for another instance to recover', async () => {
  const store = new MemoryStore(); let began = false;
  const first = new Runner(store, { authorize: async () => ({}), execute: async (_run, signal) => { began = true; return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('shutdown')), { once: true })); } }, render, { send: async () => {} });
  const id = await first.enqueue(report, 'manual'); await first.tick();
  await waitUntil(async () => began); first.stop();
  await waitUntil(async () => first.health.active === 0);
  assert.equal((await store.get<Run>('runs', id))?.value.status, 'running');
  const second = new Runner(store, executor, render, { send: async () => {} });
  await second.tick(new Date(Date.now() + 61000));
  await waitUntil(async () => (await store.get<Run>('runs', id))?.value.status === 'complete');
  assert.equal((await store.get<Run>('runs', id))?.value.fence, 2); second.stop();
});
