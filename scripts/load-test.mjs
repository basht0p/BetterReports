// Disposable loopback deployment only; run integration.mjs --multi first.
import { readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import assert from 'node:assert/strict';
const secrets = JSON.parse(await readFile('.platform/dev-secrets.json', 'utf8'));
const fixture = JSON.parse(await readFile('output/integration/results.json', 'utf8'));
function api(path, method = 'GET', body, port = 15601, admin = false) {
  return new Promise((resolve, reject) => {
    const user = admin ? 'admin' : 'report_owner', password = admin ? secrets.admin : secrets.owner;
    const req = http.request({ hostname: '127.0.0.1', port, path: '/br/api/better_reports' + path, method, timeout: 30000, headers: { authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`, securitytenant: 'operations', 'osd-xsrf': 'load-fixture', 'content-type': 'application/json' } }, response => {
      let text = ''; response.on('data', c => text += c); response.on('end', () => { let result; try { result = JSON.parse(text); } catch { reject(new Error('Dashboards is not ready')); return; } response.statusCode >= 300 ? reject(new Error(JSON.stringify(result))) : resolve(result); });
    }); req.on('error', reject); req.on('timeout', () => req.destroy(new Error('Request deadline'))); if (body) req.write(JSON.stringify(body)); req.end();
  });
}
for (const port of [15601, 15602]) { let ready = false; for (let i = 0; i < 90; i++) { try { await api('/health', 'GET', undefined, port, true); ready = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 2000)); } } assert.ok(ready, `Instance ${port} did not become ready`); }
const existing = await api('/schedules'); assert.equal(existing.filter(s => s.enabled).length, 0, 'Pause fixture schedules before the benchmark');
const now = new Date(), target = new Date(Math.ceil((now.getTime() + 30000) / 60000) * 60000);
const cron = `${target.getUTCMinutes()} ${target.getUTCHours()} ${target.getUTCDate()} ${target.getUTCMonth() + 1} *`;
const input = { reportId: fixture.reportId, cron, timezone: 'UTC', enabled: true, senderId: fixture.senderId, recipientGroupIds: fixture.recipientGroupIds, subject: 'BetterReports workload fixture', message: 'Synthetic data' };
const mailBaseline = (await (await fetch('http://127.0.0.1:18081')).json()).count;
const schedules = [], peak = [0, 0]; const started = Date.now();
try {
  for (let offset = 0; offset < 100; offset += 10) schedules.push(...await Promise.all(Array.from({ length: 10 }, () => api('/schedules', 'POST', input))));
  const ids = new Set(schedules.map(s => s.id)); console.log(`Created 100 enabled schedules, due ${target.toISOString()}.`);
  let finished = [];
  while (Date.now() < target.getTime() + 12 * 60000) {
    const [runs, a, b] = await Promise.all([api('/runs'), api('/health', 'GET', undefined, 15601, true), api('/health', 'GET', undefined, 15602, true)]);
    peak[0] = Math.max(peak[0], a.active); peak[1] = Math.max(peak[1], b.active);
    const ours = runs.filter(r => ids.has(r.scheduleId));
    const failures = ours.filter(r => ['failed', 'delivery_unknown'].includes(r.status)); assert.equal(failures.length, 0, JSON.stringify(failures.map(r => r.error)));
    finished = ours.filter(r => r.status === 'complete');
    if (finished.length === 100) break;
    console.log(`Workload: ${finished.length}/100 complete; active ${a.active}+${b.active}; queue ${a.queueDepth}.`);
    await new Promise(resolve => setTimeout(resolve, 10000));
  }
  assert.equal(finished.length, 100, 'Workload deadline'); assert.ok(peak.every(n => n <= 2));
  const delivered = (await (await fetch('http://127.0.0.1:18081')).json()).messages.slice(mailBaseline).filter(message => /^Subject: BetterReports workload fixture$/mi.test(message));
  assert.equal(delivered.length, 100); assert.equal(new Set(delivered.map(message => message.replace(/\r?\n[ \t]+/g, ' ').match(/^Message-ID: (.+)$/mi)?.[1])).size, 100);
  const lateness = finished.map(r => Date.parse(r.finishedAt) - Date.parse(r.scheduledAt)).sort((a, b) => a - b);
  const evidence = { schedules: 100, completed: 100, uniqueEmails: 100, peakConcurrencyPerInstance: peak, workers: [...new Set(finished.map(r => r.worker))], elapsedMs: Date.now() - started, p95ScheduledToCompleteMs: lateness[94], maxScheduledToCompleteMs: lateness[99], checkedAt: new Date().toISOString() };
  await writeFile('output/integration/workload.json', JSON.stringify(evidence, null, 2)); console.log('PASS: 100 scheduled PDFs completed and delivered on two instances.', evidence);
} finally {
  for (let i = 0; i < schedules.length; i += 10) await Promise.all(schedules.slice(i, i + 10).map(s => api(`/schedules/${s.id}`, 'PUT', { revision: s.revision, schedule: { ...input, enabled: false } })));
}
