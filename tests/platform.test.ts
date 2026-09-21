import test from 'node:test';
import assert from 'node:assert/strict';
import { assertTenantAccess } from '../server/platform';
test('fresh tenant checks distinguish read-only permission from missing permission', () => {
  const info = { user_name: 'alice', tenants: { operations: false, global_tenant: true, alice: true } };
  for (const tenant of ['operations', '', '__user__']) assertTenantAccess(info, tenant);
  assert.throws(() => assertTenantAccess(info, 'finance'), /no longer has access/);
  assert.throws(() => assertTenantAccess({ ...info, tenants: {} }, 'operations'), /no longer has access/);
});
