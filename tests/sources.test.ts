import test from 'node:test';
import assert from 'node:assert/strict';
import { assertOwner, reportSchema } from '../common/model';
import { SourceService, validateReport, validateSnapshot, validateFilters } from '../server/sources';
import { report, snapshot } from './fixtures';

test('accepts supported aggregation configurations and rejects scripts/pipelines', () => {
  validateSnapshot(snapshot);
  const invalid = structuredClone(snapshot); invalid.vis.aggs[0].type = 'derivative'; assert.throws(() => validateSnapshot(invalid), /derivative/);
  invalid.vis.aggs[0].type = 'sum'; invalid.vis.aggs[0].params = { field: 'hidden' }; assert.throws(() => validateSnapshot(invalid), /missing or scripted/);
  assert.throws(() => validateFilters([{ bool: { must: [{ script: { script: 'malicious' } }] } }]), /not supported/);
  const patterned = structuredClone(snapshot); patterned.vis.params.visColors = { Count: { image: '/private/logo.png' } };
  assert.throws(() => validateSnapshot(patterned), /plain colors/);
});
test('tenant and owner isolation reject identifier guessing', () => {
  assertOwner(report, { owner: 'alice', tenant: 'operations' });
  assert.throws(() => assertOwner(report, { owner: 'bob', tenant: 'operations' }), /not found/);
  assert.throws(() => assertOwner(report, { owner: 'alice', tenant: 'finance' }), /not found/);
});
test('validates report layout and excludes executable template fields', () => {
  const { id, owner, tenant, revision, schemaVersion, updatedAt, ...input } = report;
  validateReport(input);
  assert.throws(() => validateReport({ ...input, sections: [{ id: 'bad', kind: 'panels', columns: 1, sources: ['missing'] }] }), /missing sources/);
  assert.equal(reportSchema.safeParse({ ...input, branding: { ...input.branding, html: '<script>alert(1)</script>' } }).success, false);
});
test('source import resolves dashboard references and inherited saved searches', async () => {
  const objects: any = {
    'dashboard:d': { id: 'd', type: 'dashboard', version: '1', attributes: { title: 'Dashboard', panelsJSON: JSON.stringify([{ panelIndex: 'p1', type: 'visualization', panelRefName: 'panel_0' }]), kibanaSavedObjectMeta: { searchSourceJSON: JSON.stringify({ query: { language: 'kuery', query: 'environment: production' } }) } }, references: [{ name: 'panel_0', type: 'visualization', id: 'v' }] },
    'visualization:v': { id: 'v', type: 'visualization', version: '2', attributes: { title: 'Traffic', savedSearchId: 's', visState: JSON.stringify(snapshot.vis), kibanaSavedObjectMeta: { searchSourceJSON: '{}' } }, references: [] },
    'search:s': { id: 's', type: 'search', version: '3', attributes: { kibanaSavedObjectMeta: { searchSourceJSON: JSON.stringify({ indexRefName: 'index', query: { language: 'lucene', query: 'status:200' } }) } }, references: [{ name: 'index', type: 'index-pattern', id: 'logs' }] },
    'index-pattern:logs': { id: 'logs', type: 'index-pattern', version: '4', attributes: snapshot.indexPattern.attributes, references: [] }
  };
  const service = new SourceService({ get: async (type, id) => structuredClone(objects[`${type}:${id}`]), find: async () => ({ saved_objects: [], total: 0 }) });
  const imported = await service.import('dashboard', 'd');
  assert.equal(imported[0].source?.queries.length, 2); assert.equal(imported[0].source?.refs.length, 4);
  objects['visualization:v'].attributes.title = 'Changed title';
  assert.equal(imported[0].source?.title, 'Traffic'); assert.equal((await service.import('dashboard', 'd'))[0].source?.title, 'Changed title');
});
