import test from 'node:test';
import assert from 'node:assert/strict';
import { assertTenantAccess, normalizeCompiledQueryDsl, PlatformAdapter } from '../server/platform';
test('fresh tenant checks distinguish read-only permission from missing permission', () => {
  const info = { user_name: 'alice', tenants: { operations: false, global_tenant: true, alice: true } };
  for (const tenant of ['operations', '', '__user__']) assertTenantAccess(info, tenant);
  assert.throws(() => assertTenantAccess(info, 'finance'), /no longer has access/);
  assert.throws(() => assertTenantAccess({ ...info, tenants: {} }, 'operations'), /no longer has access/);
  assert.throws(() => assertTenantAccess(info, 'operations', true), /Write access/);
  assert.doesNotThrow(() => assertTenantAccess(info, '', true));
});

test('context reports write access and restricts all tenant inventory to Global admins', async () => {
  const authInfo = { user_name: 'alice', roles: ['admin'], tenants: { operations: false, finance: true, global_tenant: true, alice: true } };
  let allowScopeAction = true;
  const core = { http: { auth: { get: (request: any) => ({ state: { selectedTenant: request.tenant, authInfo } }) } },
    opensearch: { client: { asScoped: () => ({ asCurrentUser: { transport: { request: async (request: any) => {
      if (request.path === '/_plugins/_better_reports/admin') {
        if (!allowScopeAction) throw { meta: { statusCode: 403, body: { error: { reason: 'forbidden' } } } };
        return { body: { ok: true } };
      }
      return { body: authInfo };
    } } } }) } } };
  const platform = new PlatformAdapter(core, {}, { username: 'worker', password: 'password' }, {} as any);
  assert.deepEqual(await platform.context({ tenant: 'operations' }, ['admin']), { owner: 'alice', tenant: 'operations', canWrite: false, allTenants: false });
  assert.deepEqual(await platform.context({ tenant: '' }, ['admin']), { owner: 'alice', tenant: '', canWrite: true, allTenants: true, canSetOrganizationScope: true, tenantNames: ['finance', 'operations'] });
  allowScopeAction = false;
  assert.deepEqual(await platform.context({ tenant: '' }, ['admin']), { owner: 'alice', tenant: '', canWrite: true, allTenants: true, canSetOrganizationScope: false, tenantNames: [] });
  allowScopeAction = true; authInfo.roles = [];
  assert.deepEqual(await platform.context({ tenant: '' }, ['admin']), { owner: 'alice', tenant: '', canWrite: true, allTenants: false, canSetOrganizationScope: true, tenantNames: ['finance', 'operations'] });
  assert.deepEqual(await platform.context({ tenant: '__user__' }, ['admin']), { owner: 'alice', tenant: '__user__', canWrite: true, allTenants: false });
});

test('compiled Lucene options remain structured and use the report timezone', () => {
  const serializedOptions = '{ "analyze_wildcard": true }';
  const malformed = Object.fromEntries([...serializedOptions].map((character, index) => [String(index), character]));
  const query = { bool: { must: [{ query_string: { ...malformed, query: 'organization.name:finance OR organization.name:operations*', time_zone: 'Africa/Abidjan' } }], filter: [{ term: { environment: 'production' } }], should: [], must_not: [] } };
  const normalized = normalizeCompiledQueryDsl(query, 'UTC', serializedOptions) as typeof query;
  assert.deepEqual(normalized.bool.filter, [{ term: { environment: 'production' } }]);
  assert.deepEqual(normalized.bool.must[0].query_string, { analyze_wildcard: true, query: 'organization.name:finance OR organization.name:operations*', time_zone: 'UTC' });
  const alreadyStructured = { bool: { must: [{ query_string: { analyze_wildcard: true, query: 'organization.name:operations', time_zone: 'Europe/London' } }], filter: [{ term: { owner: 'alice' } }] } };
  assert.deepEqual(normalizeCompiledQueryDsl(alreadyStructured, 'UTC', serializedOptions), alreadyStructured);
  const unrelatedField = { term: { query_string: { value: 'literal' } } };
  assert.deepEqual(normalizeCompiledQueryDsl(unrelatedField, 'UTC', serializedOptions), unrelatedField);
});
