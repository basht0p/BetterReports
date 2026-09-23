import test from 'node:test';
import assert from 'node:assert/strict';
import { assertTenantAccess, PlatformAdapter } from '../server/platform';
test('fresh tenant checks distinguish read-only permission from missing permission', () => {
  const info = { user_name: 'alice', tenants: { operations: false, global_tenant: true, alice: true } };
  for (const tenant of ['operations', '', '__user__']) assertTenantAccess(info, tenant);
  assert.throws(() => assertTenantAccess(info, 'finance'), /no longer has access/);
  assert.throws(() => assertTenantAccess({ ...info, tenants: {} }, 'operations'), /no longer has access/);
  assert.throws(() => assertTenantAccess(info, 'operations', true), /Write access/);
  assert.doesNotThrow(() => assertTenantAccess(info, '', true));
});

test('context reports write access and restricts all tenant inventory to Global admins', async () => {
  const authInfo = { user_name: 'alice', roles: ['admin'], tenants: { operations: false, global_tenant: true, alice: true } };
  const core = { http: { auth: { get: (request: any) => ({ state: { selectedTenant: request.tenant, authInfo } }) } },
    opensearch: { client: { asScoped: () => ({ asCurrentUser: { transport: { request: async () => ({ body: authInfo }) } } }) } } };
  const platform = new PlatformAdapter(core, {}, { username: 'worker', password: 'password' }, {} as any);
  assert.deepEqual(await platform.context({ tenant: 'operations' }, ['admin']), { owner: 'alice', tenant: 'operations', canWrite: false, allTenants: false });
  assert.deepEqual(await platform.context({ tenant: '' }, ['admin']), { owner: 'alice', tenant: '', canWrite: true, allTenants: true });
  assert.deepEqual(await platform.context({ tenant: '__user__' }, ['admin']), { owner: 'alice', tenant: '__user__', canWrite: true, allTenants: false });
});
