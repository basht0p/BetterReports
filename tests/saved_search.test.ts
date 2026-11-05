import test from 'node:test';
import assert from 'node:assert/strict';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { defaultLimits, PanelData, SEARCH_ROW_LIMIT, Snapshot } from '../common/model';
import { SourceService, validateReport, validateSnapshot } from '../server/sources';
import { searchRequestBody, searchTable, sourceValue, SEARCH_CELL_TEXT_LIMIT } from '../server/platform';
import { renderPdf, searchColumnWidths, searchSummary } from '../server/render';
import { report, run, snapshot } from './fixtures';

const fields = [
  { name: '@timestamp', type: 'date', aggregatable: true }, { name: 'host.name', type: 'string', aggregatable: true },
  { name: 'message', type: 'string', aggregatable: false }, { name: 'message.keyword', type: 'string', aggregatable: true, subType: { multi: { parent: 'message' } } },
  { name: 'tags', type: 'string', aggregatable: true }, { name: 'bytes', type: 'number', aggregatable: true },
  { name: 'doubled', type: 'number', scripted: true }, { name: '_id', type: 'string', aggregatable: true }
];
const indexPattern = { id: 'logs', attributes: { title: 'logs-*', timeFieldName: '@timestamp', fields: JSON.stringify(fields) } };
const search: Snapshot = { key: 'recent', title: 'Recent errors', type: 'search', refs: [{ type: 'search', id: 's' }, { type: 'index-pattern', id: 'logs' }], importRef: { type: 'search', id: 's' }, indexPattern,
  vis: { type: 'search', params: { columns: ['@timestamp', 'host.name', 'message'], sort: [['@timestamp', 'desc']], rowLimit: SEARCH_ROW_LIMIT }, aggs: [] }, queries: [{ language: 'kuery', query: 'level: error' }], filters: [] };
const savedObjects = (overrides: Record<string, any> = {}) => {
  const objects: any = {
    'search:s': { id: 's', type: 'search', version: '1', attributes: { title: 'Recent errors', columns: ['host.name', 'message'], sort: [['bytes', 'asc']], kibanaSavedObjectMeta: { searchSourceJSON: JSON.stringify({ indexRefName: 'kibanaSavedObjectMeta.searchSourceJSON.index', query: { language: 'kuery', query: 'level: error' }, filter: [{ meta: { indexRefName: 'kibanaSavedObjectMeta.searchSourceJSON.filter[0].meta.index' }, query: { match_phrase: { env: 'prod' } } }] }) } },
      references: [{ name: 'kibanaSavedObjectMeta.searchSourceJSON.index', type: 'index-pattern', id: 'logs' }, { name: 'kibanaSavedObjectMeta.searchSourceJSON.filter[0].meta.index', type: 'index-pattern', id: 'logs' }] },
    'dashboard:d': { id: 'd', type: 'dashboard', version: '2', attributes: { title: 'Ops', panelsJSON: JSON.stringify([{ panelIndex: 'p1', panelRefName: 'panel_0', embeddableConfig: { columns: ['_id', 'tags'], sort: ['@timestamp', 'asc'] } }]), kibanaSavedObjectMeta: { searchSourceJSON: JSON.stringify({ query: { language: 'kuery', query: 'region: east' } }) } }, references: [{ name: 'panel_0', type: 'search', id: 's' }] },
    'index-pattern:logs': { id: 'logs', type: 'index-pattern', version: '3', attributes: indexPattern.attributes, references: [] },
    ...overrides
  };
  const finds: any[] = [];
  return { finds, service: new SourceService({ get: async (type, id) => { const object = objects[`${type}:${id}`]; if (!object) throw Object.assign(new Error('missing'), { statusCode: 404 }); return structuredClone(object); }, find: async (options: any) => { finds.push(options); return { saved_objects: [], total: 0 }; } }) };
};

test('saved searches are discoverable and import as 1,000-row document tables', async () => {
  const { service, finds } = savedObjects();
  await service.discover('err');
  assert.deepEqual(finds[0].type, ['dashboard', 'visualization', 'search']);
  const [imported] = await service.import('search', 's');
  assert.equal(imported.error, undefined);
  const source = imported.source!;
  assert.equal(source.type, 'search'); assert.equal(source.title, 'Recent errors');
  assert.deepEqual(source.vis, { type: 'search', params: { columns: ['host.name', 'message'], sort: [['bytes', 'asc']], rowLimit: 1000 }, aggs: [] });
  assert.deepEqual(source.queries, [{ language: 'kuery', query: 'level: error' }]);
  assert.equal(source.filters[0].meta.index, 'logs');
  assert.deepEqual(source.refs.map(r => r.type), ['search', 'index-pattern']);
  assert.equal(source.panelId, undefined);
  const { id, owner, tenant, revision, schemaVersion, updatedAt, ...input } = report;
  validateReport({ ...input, sources: [source], sections: [{ id: 'one', kind: 'panels', columns: 1, sources: [source.key] }] });
});

test('dashboard saved-search panels import with dashboard queries and column and sort overrides', async () => {
  const { service } = savedObjects();
  const [panel] = await service.import('dashboard', 'd');
  assert.equal(panel.error, undefined);
  assert.deepEqual(panel.source!.vis.params, { columns: ['_id', 'tags'], sort: [['@timestamp', 'asc']], rowLimit: 1000 });
  assert.deepEqual(panel.source!.queries.map(q => q.query), ['level: error', 'region: east']);
  assert.equal(panel.source!.panelId, 'p1');
  const { service: whole } = savedObjects({ 'search:s': { id: 's', type: 'search', attributes: { title: 'All', columns: ['_source'], kibanaSavedObjectMeta: { searchSourceJSON: JSON.stringify({ index: 'logs' }) } }, references: [] } });
  assert.deepEqual((await whole.import('search', 's'))[0].source!.vis.params, { columns: ['_source'], sort: [], rowLimit: 1000 });
});

test('saved search validation enforces the row limit, columns, sorting, and full-width layout', () => {
  validateSnapshot(search);
  const change = (params: Record<string, any>) => { const copy = structuredClone(search); copy.vis.params = { ...copy.vis.params, ...params }; return copy; };
  assert.throws(() => validateSnapshot(change({ rowLimit: SEARCH_ROW_LIMIT + 1 })), /limited to 1,000 rows/);
  assert.throws(() => validateSnapshot(change({ rowLimit: 0 })), /limited to 1,000 rows/);
  assert.throws(() => validateSnapshot(change({ rowLimit: 10.5 })), /limited to 1,000 rows/);
  validateSnapshot(change({ rowLimit: 1 }));
  assert.throws(() => validateSnapshot(change({ columns: ['doubled'] })), /missing or scripted/);
  assert.throws(() => validateSnapshot(change({ columns: ['nope'] })), /missing or scripted/);
  assert.throws(() => validateSnapshot(change({ columns: ['_source', 'host.name'] })), /whole-document/);
  assert.throws(() => validateSnapshot(change({ columns: Array.from({ length: 21 }, () => 'host.name') })), /20 columns/);
  assert.throws(() => validateSnapshot(change({ sort: [['message', 'asc']] })), /not sortable/);
  assert.throws(() => validateSnapshot(change({ sort: [['bytes', 'sideways']] })), /sort order is invalid/);
  assert.throws(() => validateSnapshot(change({ script: 'x' })), /unsupported saved search options/);
  const withAggs = structuredClone(search); withAggs.vis.aggs = snapshot.vis.aggs; assert.throws(() => validateSnapshot(withAggs), /cannot contain aggregations/);
  const mismatched = structuredClone(search); mismatched.type = 'table'; assert.throws(() => validateSnapshot(mismatched), /inconsistent/);
  const { id, owner, tenant, revision, schemaVersion, updatedAt, ...input } = report;
  assert.throws(() => validateReport({ ...input, sources: [snapshot, search], sections: [{ id: 'two', kind: 'panels', columns: 2, sources: [snapshot.key, search.key] }] }), /full-width/);
});

test('saved search queries request at most 1,000 sorted documents with only the shown fields', () => {
  const query = { bool: { filter: [] } };
  const body = searchRequestBody(search, query, '295s');
  assert.deepEqual(body, { query, size: 1000, track_total_hits: true, timeout: '295s', sort: [{ '@timestamp': { order: 'desc', unmapped_type: 'boolean' } }], _source: { includes: ['@timestamp', 'host.name', 'message'] } });
  const keyword = structuredClone(search); keyword.vis.params = { columns: ['message.keyword', '_id', 'message'], sort: [], rowLimit: 25 };
  assert.deepEqual(searchRequestBody(keyword, query, '1s'), { query, size: 25, track_total_hits: true, timeout: '1s', sort: [{ '@timestamp': { order: 'desc', unmapped_type: 'boolean' } }], _source: { includes: ['message'] } });
  const whole = structuredClone(search); whole.vis.params = { columns: ['_source'], sort: [['_score', 'desc']], rowLimit: 5000 }; whole.indexPattern.attributes.timeFieldName = undefined;
  const wholeBody = searchRequestBody(whole, query, '1s');
  assert.equal(wholeBody.size, SEARCH_ROW_LIMIT); assert.equal(wholeBody._source, true); assert.deepEqual(wholeBody.sort, [{ _score: { order: 'desc' } }]);
});

test('saved search hits become formatted table rows', () => {
  assert.equal(sourceValue({ host: { name: 'web-1' } }, 'host.name'), 'web-1');
  assert.equal(sourceValue({ 'host.name': 'web-2' }, 'host.name'), 'web-2');
  assert.deepEqual(sourceValue({ user: [{ id: 1 }, { id: 2 }] }, 'user.id'), [1, 2]);
  assert.equal(sourceValue({ host: 'flat' }, 'host.name'), undefined);
  const source = structuredClone(search); source.vis.params = { columns: ['_id', 'host.name', 'message.keyword', 'tags', 'bytes'], sort: [], rowLimit: 1000 };
  const hits = [{ _id: 'a1', _source: { host: { name: 'web-1' }, message: 'x'.repeat(900), tags: ['red', 'blue'], bytes: 2048 } }, { _id: 'a2', _source: {} }];
  const table = searchTable(source, hits, (field, value) => field === 'bytes' ? `${Number(value) / 1024} KB` : String(value));
  assert.deepEqual(table.columns, ['_id', 'host.name', 'message.keyword', 'tags', 'bytes']);
  assert.deepEqual(table.rows[0].map(cell => cell.text).filter(text => text.length < 50), ['a1', 'web-1', 'red, blue', '2 KB']);
  assert.equal(table.rows[0][2].text.length, SEARCH_CELL_TEXT_LIMIT); assert.ok(table.rows[0][2].text.endsWith('…'));
  assert.deepEqual(table.rows[1].map(cell => cell.text), ['a2', '-', '-', '-', '-']);
  assert.equal(table.rows[0][4].value, 2048);
  const whole = structuredClone(search); whole.vis.params = { columns: ['_source'], sort: [], rowLimit: 1000 };
  const document = searchTable(whole, [{ _source: { host: { name: 'web-1' }, bytes: 1 } }], (_, value) => String(value));
  assert.deepEqual(document, { columns: ['Document'], rows: [[{ text: 'host.name: web-1; bytes: 1', value: null }]] });
  assert.equal(searchTable(search, Array.from({ length: 1200 }, () => ({ _source: {} })), String).rows.length, SEARCH_ROW_LIMIT);
});

const searchPanel = (rows: number, total = rows): PanelData => ({ key: 'recent', title: 'Recent errors', type: 'search', params: search.vis.params, bucketCount: 0, schemas: [], total: { value: total, relation: 'eq' },
  columns: ['@timestamp', 'host.name', 'status', 'message'],
  rows: Array.from({ length: rows }, (_, i) => [`Sep ${14 + (i % 7)}, 2026 @ 10:${String(i % 60).padStart(2, '0')}:00.000`, `web-${i % 12}.example.internal`, '500', `Upstream request ${i} failed`].map(text => ({ text, value: text }))) });

test('a 1,000-row saved search renders within the default limits and states the total', async () => {
  const fixture = structuredClone(run);
  fixture.report.sources = [search]; fixture.report.sections = [{ id: 'search', kind: 'panels', columns: 1, sources: ['recent'] }];
  const result = await renderPdf(fixture, [searchPanel(1000, 48213)], defaultLimits);
  assert.ok(result.pages > 1 && result.pages <= defaultLimits.pages, `${result.pages} pages`);
  const pdf = await getDocument({ data: new Uint8Array(result.pdf), disableFontFace: true }).promise;
  const text = async (page: number) => (await (await pdf.getPage(page)).getTextContent()).items.map((item: any) => item.str).join(' ').replace(/\s+/g, ' ');
  assert.match(await text(1), /Showing the first 1,000 of 48,213 matching documents\./);
  assert.match(await text(2), /@timestamp/, 'the header row repeats on later pages');
  assert.match(await text(result.pages), /Upstream request 999 failed/);
  await assert.rejects(renderPdf(fixture, [searchPanel(1001)], defaultLimits), /limited to 1000 rows/);
  assert.equal(searchSummary(searchPanel(1)), '1 matching document.');
  assert.equal(searchSummary({ ...searchPanel(3), total: { value: 10000, relation: 'gte' } }), 'Showing the first 3 of at least 10,000 matching documents.');
});

test('saved search columns keep short values on one line and give long values the remaining width', () => {
  const widths = searchColumnWidths(searchPanel(50), 540, 7);
  assert.ok(widths.reduce((sum, width) => sum + width, 0) <= 540 - 4 * 6);
  assert.ok(widths[2] < widths[3], 'the status column is narrower than the message column');
  assert.ok(widths[2] >= 3 * 7 * 0.56, 'three-digit status codes fit on one line');
});
