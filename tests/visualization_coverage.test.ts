import test from 'node:test';
import assert from 'node:assert/strict';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { defaultLimits, PanelData, Snapshot } from '../common/model';
import { SourceService, validateSnapshot } from '../server/sources';
import { chartOption, renderPdf } from '../server/render';
import { countryName, geohashCenter } from '../server/geo';
import { parseTimeline } from '../server/timeline';
import { run, snapshot } from './fixtures';

const metric: PanelData = { key: 'x', title: 'Value', type: 'gauge', params: { gauge: { ranges: [{ from: 0, to: 100, color: '#0d9488' }] } }, columns: ['Count'], bucketCount: 0, schemas: ['metric'], rows: [[{ value: 42, text: '42' }]] };
const bucket: PanelData = { ...metric, type: 'tagcloud', columns: ['Country', 'Count'], bucketCount: 1, schemas: ['segment', 'metric'], rows: [[{ value: 'US', text: 'US' }, { value: 42, text: '42' }], [{ value: 'CA', text: 'CA' }, { value: 12, text: '12' }]] };

test('new aggregation visualization types choose their real document and chart forms', async () => {
  assert.equal(chartOption(metric, '#2457a7').series[0].type, 'gauge');
  assert.equal(chartOption({ ...metric, type: 'goal' }, '#2457a7').series[0].type, 'bar');
  const xy: PanelData = { ...bucket, type: 'heatmap', columns: ['Day', 'Host', 'Count'], bucketCount: 2, schemas: ['segment', 'group', 'metric'], rows: [[{ value: 'Mon', text: 'Mon' }, { value: 'a', text: 'a' }, { value: 42, text: '42' }]] };
  assert.equal(chartOption(xy, '#2457a7').series[0].type, 'heatmap');
  assert.equal(chartOption({ ...bucket, type: 'horizontal_bar' }, '#2457a7').yAxis.type, 'category');
  assert.equal(chartOption({ ...bucket, type: 'vertical_bar' }, '#2457a7').series[0].type, 'bar');
  assert.equal(countryName('US'), 'United States of America');
  assert.deepEqual(geohashCenter('s'), [22.5, 22.5]);
  assert.equal(chartOption({ ...bucket, type: 'region_map' }, '#2457a7').series[0].type, 'map');
  assert.equal(chartOption({ ...bucket, type: 'tile_map', rows: [[{ value: 's', text: 's' }, { value: 42, text: '42' }]] }, '#2457a7').series[0].coordinateSystem, 'geo');
  const report = structuredClone(run);
  report.report.sections = [{ id: 'a', kind: 'panels', columns: 1, sources: ['x'] }];
  const pdf = await renderPdf(report, [{ ...bucket, key: 'x' }], defaultLimits);
  const document = await getDocument({ data: new Uint8Array(pdf.pdf), isEvalSupported: false }).promise;
  const page = await document.getPage(1);
  assert.deepEqual(page.view, [0, 0, 612, 792]);
  const text = (await page.getTextContent()).items.map((item: any) => item.str).join(' ');
  assert.match(text, /US/); assert.match(text, /CA/);
  await document.destroy();
});

test('source validation rejects configurations that a new renderer cannot reproduce', () => {
  const gauge = { ...snapshot, type: 'gauge', vis: { ...snapshot.vis, type: 'gauge', aggs: [snapshot.vis.aggs[0]] } } as Snapshot;
  validateSnapshot(gauge);
  const bucketed = { ...gauge, vis: { ...gauge.vis, aggs: snapshot.vis.aggs } };
  assert.throws(() => validateSnapshot(bucketed), /bucketed gauges/);
  const map = { ...gauge, type: 'tile_map', indexPattern: { ...snapshot.indexPattern, attributes: { ...snapshot.indexPattern.attributes, fields: JSON.stringify([{ name: 'place', type: 'geo_point' }]) } }, vis: { ...gauge.vis, type: 'tile_map', aggs: [gauge.vis.aggs[0], { ...snapshot.vis.aggs[1], type: 'geohash_grid', params: { field: 'place' } }] } } as Snapshot;
  validateSnapshot(map);
  assert.throws(() => validateSnapshot({ ...map, vis: { ...map.vis, params: { mapType: 'heatmap' } } }), /scaled-circle/);
  assert.throws(() => validateSnapshot({ ...map, type: 'region_map', vis: { ...map.vis, type: 'region_map' } }), /terms bucket/);
});

test('imports a 3.8 Maps cluster as an authorized vector coordinate map', async () => {
  const objects: Record<string, any> = {
    'map:m': { id: 'm', type: 'map', attributes: { title: 'World clusters', layerList: JSON.stringify([
      { type: 'opensearch_vector_tile_map', visibility: 'visible' },
      { type: 'cluster', visibility: 'visible', source: { indexPatternId: 'geo', cluster: { agg: 'geohash_grid', field: 'point', precision: 3 }, metric: { agg: 'count' }, filters: [] }, style: { fillColor: '#2457a7' } }
    ]), mapState: JSON.stringify({ query: { language: 'kuery', query: 'status:ok' } }) }, references: [] },
    'index-pattern:geo': { id: 'geo', type: 'index-pattern', attributes: { title: 'geo-*', timeFieldName: '@timestamp', fields: JSON.stringify([{ name: 'point', type: 'geo_point' }]) }, references: [] }
  };
  const service = new SourceService({ get: async (type, id) => objects[`${type}:${id}`], find: async () => ({ total: 1, saved_objects: [objects['map:m']] }) });
  const [result] = await service.import('map', 'm');
  assert.equal(result.error, undefined);
  assert.equal(result.source?.type, 'tile_map');
  assert.equal(result.source?.vis.aggs[1].type, 'geohash_grid');
  assert.deepEqual(result.source?.refs.map(ref => ref.type), ['map', 'index-pattern']);
  assert.equal(result.source?.queries[0].query, 'status:ok');
  objects['map:m'].attributes.layerList = JSON.stringify([{ type: 'documents', visibility: 'visible' }]);
  const [rejected] = await service.import('map', 'm');
  assert.match(rejected.error?.message ?? '', /exactly one visible geohash cluster/);
});

test('imports basic Timeline expressions and rejects expression functions', async () => {
  assert.deepEqual(parseTimeline('.es(index=logs-*,metric=sum:bytes,split=host:5,q="status:ok")').metric, { type: 'sum', field: 'bytes' });
  assert.throws(() => parseTimeline('.es(index=logs-*).multiply(100)'), /one .es/);
  const visual = { id: 'v', type: 'visualization', attributes: { title: 'Traffic over time', visState: JSON.stringify({ type: 'timelion', params: { expression: '.es(index=logs-*,metric=sum:bytes,q="status:ok")', interval: '1d' }, aggs: [] }), kibanaSavedObjectMeta: { searchSourceJSON: '{}' } }, references: [] };
  const pattern = { id: 'logs', type: 'index-pattern', attributes: { title: 'logs-*', timeFieldName: '@timestamp', fields: JSON.stringify([{ name: '@timestamp', type: 'date' }, { name: 'bytes', type: 'number' }]) }, references: [] };
  const service = new SourceService({ get: async (type, id) => type === 'visualization' ? visual : pattern, find: async () => ({ total: 1, saved_objects: [pattern] }) });
  const [result] = await service.import('visualization', 'v');
  assert.equal(result.error, undefined);
  assert.equal(result.source?.type, 'line');
  assert.equal(result.source?.vis.aggs[0].type, 'sum');
  assert.equal(result.source?.queries[0].query, 'status:ok');
});

test('source discovery still works when the optional Maps plugin is absent', async () => {
  const service = new SourceService({ get: async () => { throw new Error('not used'); }, find: async (options: any) => {
    if (options.type.includes('map')) throw new Error('Saved object type map is not registered');
    return { total: 1, saved_objects: [{ id: 'v', type: 'visualization', attributes: { title: 'Line' } }] };
  } });
  assert.deepEqual((await service.discover('')).sources, [{ id: 'v', type: 'visualization', title: 'Line' }]);
});
