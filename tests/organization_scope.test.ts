import test from 'node:test';
import assert from 'node:assert/strict';
import { grantFingerprint } from '../server/grants';
import { assertStoredScope, scopeForInput } from '../server/scope';
import { report } from './fixtures';

const input = () => {
  const { id, owner, tenant, revision, schemaVersion, updatedAt, grant, organizationScope, ...definition } = structuredClone(report);
  return definition;
};

test('tenant reports derive their exact organization scope and reject client widening', () => {
  const tenant = { owner: 'alice', tenant: 'operations' };
  assert.equal(scopeForInput(input(), tenant, [], false).organizationScope, 'operations');
  assert.equal(scopeForInput({ ...input(), organizationScope: 'operations' }, tenant, [], false).organizationScope, 'operations');
  for (const attempted of ['', 'finance', 'Operations', 'operations-extra']) {
    assert.throws(() => scopeForInput({ ...input(), organizationScope: attempted }, tenant, [], false), { code: 'ORGANIZATION_SCOPE_MISMATCH' });
  }
  assert.equal(scopeForInput(input(), { owner: 'alice', tenant: '__user__' }, [], false).organizationScope, 'alice');
  assert.throws(() => scopeForInput({ ...input(), organizationScope: 'operations' }, { owner: 'alice', tenant: '__user__' }, [], false), { code: 'ORGANIZATION_SCOPE_MISMATCH' });
});

test('Global report scope requires administrator permission and explicit save acknowledgment', () => {
  const global = { owner: 'alice', tenant: '' };
  assert.throws(() => scopeForInput({ ...input(), organizationScope: 'finance' }, global, ['finance'], false), { code: 'FORBIDDEN' });
  assert.throws(() => scopeForInput(input(), global, ['finance'], true), { code: 'ORGANIZATION_SCOPE_REQUIRED' });
  assert.throws(() => scopeForInput({ ...input(), organizationScope: 'unknown' }, global, ['finance'], true), { code: 'ORGANIZATION_SCOPE_INVALID' });
  assert.equal(scopeForInput({ ...input(), organizationScope: 'finance' }, global, ['finance'], true, false, true).organizationScope, 'finance');
  assert.throws(() => scopeForInput({ ...input(), organizationScope: '' }, global, ['finance'], true, false, true), { code: 'GLOBAL_SCOPE_ACKNOWLEDGMENT_REQUIRED' });
  assert.equal(scopeForInput({ ...input(), organizationScope: '' }, global, ['finance'], true, true, true).organizationScope, '');
});

test('old or tampered stored reports fail closed; grants bind organization scope', () => {
  assert.throws(() => assertStoredScope({ ...report, organizationScope: undefined }), { code: 'ORGANIZATION_SCOPE_REQUIRED' });
  const scoped = report;
  assert.equal(assertStoredScope(scoped), 'operations');
  assert.throws(() => assertStoredScope({ ...scoped, organizationScope: 'finance' }), { code: 'ORGANIZATION_SCOPE_MISMATCH' });
  assert.notEqual(grantFingerprint(scoped), grantFingerprint({ ...scoped, organizationScope: 'finance' }));
  assert.notEqual(grantFingerprint(scoped), grantFingerprint({ ...scoped, organizationScope: '' }));
});
