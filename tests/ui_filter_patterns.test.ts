import assert from 'node:assert/strict';
import test from 'node:test';
import { snapshot } from './fixtures';
import { reportFilterIndexPatterns } from '../public/report_filter_patterns';

test('native field hydration includes current .keyword multi-fields without changing report snapshots', async () => {
  const source = structuredClone(snapshot);
  const before = structuredClone(source);
  const liveFields = [{ name: 'message', type: 'string', searchable: true }, { name: 'message.keyword', type: 'string', searchable: true, aggregatable: true }];
  const calls: string[] = [];
  const saved = { toSpec: () => ({ id: 'logs', title: 'logs-*', fields: { message: { name: 'message', type: 'string' } } }) };
  const pattern = {
    fields: { values: [] as any[], replaceAll(fields: any[]) { this.values = fields; } },
    getScriptedFields: () => [],
  };
  const data = { indexPatterns: {
    async get(id: string) { calls.push(`get:${id}`); return saved; },
    async create(_spec: any, skipFetchFields: boolean) { assert.equal(skipFetchFields, true); calls.push('create'); return pattern; },
    async getFieldsForIndexPattern(instance: any) { assert.equal(instance, pattern); calls.push('fields'); return liveFields; },
  } };
  const result = await reportFilterIndexPatterns(data, [source, structuredClone(source)]);
  assert.deepEqual(calls, ['get:logs', 'create', 'fields']);
  assert.equal(result.length, 1);
  assert.deepEqual(pattern.fields.values.map(field => field.name), ['message', 'message.keyword']);
  assert.deepEqual(source, before);
});

test('field metadata failures surface to the filter UI', async () => {
  const data = { indexPatterns: {
    async get() { return { toSpec: () => ({ id: 'logs' }) }; },
    async create() { return { fields: { replaceAll() {} }, getScriptedFields: () => [] }; },
    async getFieldsForIndexPattern() { throw new Error('No field access'); },
  } };
  await assert.rejects(reportFilterIndexPatterns(data, [structuredClone(snapshot)]), /No field access/);
});

