import test from 'node:test';
import assert from 'node:assert/strict';
import { GrantClient, grantFingerprint } from '../server/grants';
import { Report } from '../common/model';

test('authorization binds owner, tenant, queries and revision and survives JSON persistence', () => {
  const report = { id: 'r', owner: 'alice', tenant: 'operations', revision: 1, sources: [{ query: 'approved' }] } as unknown as Report;
  const fingerprint = grantFingerprint(report);
  const authorized = { ...report, grant: { id: 'g', fingerprint, authorization: 'until_revoked' } } as Report;
  assert.equal(grantFingerprint(JSON.parse(JSON.stringify(authorized))), fingerprint);
  for (const change of [{ owner: 'bob' }, { tenant: 'finance' }, { revision: 2 }, { sources: [] }]) assert.notEqual(grantFingerprint({ ...authorized, ...change }), fingerprint);
});

test('worker requests contain no impersonation headers and reject missing or changed grants', async () => {
  const seen: any[] = [];
  const core = { opensearch: { client: { asScoped: (request: any) => { seen.push(request); return { asCurrentUser: { transport: { request: async (data: any) => { seen.push(data); return { body: { ok: true } }; } } } }; } } } };
  const client = new GrantClient(core, { username: 'worker', password: 'fixture' });
  await assert.rejects(client.check({ id: 'r' } as Report), /Authorize/);
  await client.call('execute', { id: 'approved' });
  assert.deepEqual(Object.keys(seen[0].headers), ['authorization']);
  assert.equal(seen[1].path, '/_plugins/_better_reports/execute');
  const stale = { id: 'r', grant: { id: 'g', fingerprint: 'old' } } as Report;
  await assert.rejects(client.check(stale), /changed/);
});
