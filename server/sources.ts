import { randomUUID } from 'crypto';
import { ReportError, Snapshot, reportSchema, ReportInput, SEARCH_ROW_LIMIT } from '../common/model';
import { validateTimezone, resolveRange } from './time';

export interface SavedObject { id: string; type: string; version?: string; attributes: Record<string, any>; references: Array<{ type: string; id: string; name: string }>; }
export interface SavedObjects { get(type: string, id: string): Promise<SavedObject>; find(options: any): Promise<any>; }
export type SourceType = 'dashboard' | 'visualization' | 'search';
export const sourceTypes: SourceType[] = ['dashboard', 'visualization', 'search'];
// Saved-search tables use the Letter page width, so keep them legible.
export const SEARCH_COLUMN_LIMIT = 20;
export const SEARCH_SORT_LIMIT = 5;
// Document metadata Discover can show as columns. They are read from the hit, not _source.
export const searchMetaFields = new Set(['_id', '_index', '_score']);
const supportedTypes = new Set(['line', 'area', 'histogram', 'horizontal_bar', 'vertical_bar', 'pie', 'metric', 'table', 'gauge', 'goal', 'heatmap', 'tagcloud', 'tile_map', 'region_map']);
const metrics = new Set(['count', 'sum', 'avg', 'min', 'max', 'cardinality', 'percentiles']);
const buckets = new Set(['terms', 'date_histogram', 'histogram', 'range', 'filters', 'geohash_grid']);
export function parseJson(value: any, fallback: any) {
  if (value === undefined || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { throw new ReportError('INVALID_SOURCE', 'The saved source contains invalid JSON.'); }
}
export function validateFilters(filters: any[]) {
  const forbidden = new Set(['script', 'script_fields', 'runtime_mappings', 'terms_lookup', 'percolate']);
  const visit = (node: any, depth: number) => {
    if (depth > 25) throw new ReportError('UNSUPPORTED_CONFIGURATION', 'Filter nesting exceeds 25 levels.');
    if (node && typeof node === 'object') for (const [key, value] of Object.entries(node)) {
      if (forbidden.has(key)) throw new ReportError('UNSUPPORTED_CONFIGURATION', `Filter option ${key} is not supported.`);
      visit(value, depth + 1);
    }
  };
  filters.forEach(filter => visit(filter, 0));
}
// Discover stores no columns, or ['_source'], to show whole documents.
export function searchColumns(columns: unknown): string[] {
  if (columns !== undefined && !Array.isArray(columns)) throw new ReportError('INVALID_SOURCE', 'The saved search columns are invalid.');
  const list = (columns ?? []) as unknown[];
  if (list.some(column => typeof column !== 'string' || !column)) throw new ReportError('INVALID_SOURCE', 'The saved search columns are invalid.');
  return list.length ? list as string[] : ['_source'];
}
// Saved searches store [[field, direction], ...]; older objects store one [field, direction] pair.
export function searchSort(sort: unknown): Array<[string, 'asc' | 'desc']> {
  if (sort === undefined || sort === null || (Array.isArray(sort) && !sort.length)) return [];
  if (!Array.isArray(sort)) throw new ReportError('INVALID_SOURCE', 'The saved search sort order is invalid.');
  const pairs = typeof sort[0] === 'string' ? [sort] : sort;
  return pairs.map((pair: unknown) => {
    const direction = Array.isArray(pair) ? String(pair[1] ?? '').toLowerCase() : '';
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || !pair[0] || (direction !== 'asc' && direction !== 'desc')) throw new ReportError('INVALID_SOURCE', 'The saved search sort order is invalid.');
    return [pair[0], direction];
  });
}
function validateIndexPattern(source: Snapshot) {
  if (source.indexPattern.attributes.dataSourceRef || source.indexPattern.attributes.type === 'rollup') throw new ReportError('UNSUPPORTED_CONFIGURATION', 'Only local, ordinary index patterns are supported.');
  const formats = parseJson(source.indexPattern.attributes.fieldFormatMap, {});
  if (Object.values(formats).some((f: any) => !['number', 'bytes', 'percent', 'date', 'string', 'duration'].includes(f.id))) throw new ReportError('UNSUPPORTED_CONFIGURATION', 'This index pattern uses an unsupported field formatter.');
}
function validateSearchSnapshot(source: Snapshot) {
  if (source.vis.type !== 'search' || source.vis.aggs.length) throw new ReportError('INVALID_SOURCE', `${source.title}: saved searches cannot contain aggregations.`);
  const { columns, sort, rowLimit, ...rest } = source.vis.params;
  if (Object.keys(rest).length) throw new ReportError('UNSUPPORTED_CONFIGURATION', `${source.title}: unsupported saved search options ${Object.keys(rest).join(', ')}.`);
  if (!Number.isInteger(rowLimit) || rowLimit < 1 || rowLimit > SEARCH_ROW_LIMIT) throw new ReportError('QUERY_LIMIT', `${source.title}: saved search tables are limited to ${SEARCH_ROW_LIMIT.toLocaleString('en-US')} rows.`);
  const names = searchColumns(columns), order = searchSort(sort);
  if (JSON.stringify(names) !== JSON.stringify(columns) || JSON.stringify(order) !== JSON.stringify(sort)) throw new ReportError('INVALID_SOURCE', `${source.title}: the saved search columns or sort order are invalid.`);
  if (names.length > SEARCH_COLUMN_LIMIT) throw new ReportError('LAYOUT_LIMIT', `${source.title}: saved search tables are limited to ${SEARCH_COLUMN_LIMIT} columns on a Letter page.`);
  if (new Set(names).size !== names.length) throw new ReportError('INVALID_SOURCE', `${source.title}: saved search columns must be unique.`);
  if (names.includes('_source') && names.length > 1) throw new ReportError('UNSUPPORTED_CONFIGURATION', `${source.title}: the whole-document column cannot be combined with field columns.`);
  if (order.length > SEARCH_SORT_LIMIT) throw new ReportError('UNSUPPORTED_CONFIGURATION', `${source.title}: saved searches can sort by at most ${SEARCH_SORT_LIMIT} fields.`);
  const fields: any[] = parseJson(source.indexPattern.attributes.fields, []);
  const field = (name: string) => fields.find((f: any) => f.name === name);
  for (const name of names) {
    if (name === '_source' || searchMetaFields.has(name)) continue;
    if (!field(name) || field(name).scripted) throw new ReportError('UNSUPPORTED_CONFIGURATION', `${source.title}: column ${name} is missing or scripted.`);
  }
  for (const [name] of order) {
    if (name === '_score') continue;
    if (!field(name) || field(name).scripted || field(name).aggregatable === false) throw new ReportError('UNSUPPORTED_CONFIGURATION', `${source.title}: sort field ${name} is missing, scripted, or not sortable.`);
  }
  validateIndexPattern(source);
  validateFilters(source.filters);
}
export function validateSnapshot(source: Snapshot) {
  if (source.type === 'search' || source.vis.type === 'search') {
    if (source.type !== source.vis.type) throw new ReportError('INVALID_SOURCE', `${source.title}: inconsistent saved search source.`);
    return validateSearchSnapshot(source);
  }
  if (!supportedTypes.has(source.vis.type) || source.type !== source.vis.type) throw new ReportError('UNSUPPORTED_VISUALIZATION', `${source.title}: unsupported visualization type ${source.vis.type}.`);
  const aggs = source.vis.aggs.filter(a => a.enabled !== false);
  if (!aggs.length) throw new ReportError('UNSUPPORTED_CONFIGURATION', `${source.title}: no aggregations configured.`);
  if (source.type === 'pie' && aggs.filter(a => metrics.has(a.type)).length !== 1) throw new ReportError('UNSUPPORTED_CONFIGURATION', 'Pie charts require exactly one metric.');
  const bucketAggs = aggs.filter(a => buckets.has(a.type));
  if (['gauge', 'goal', 'tile_map', 'region_map', 'tagcloud', 'heatmap'].includes(source.type) && aggs.filter(a => metrics.has(a.type)).length !== 1) throw new ReportError('UNSUPPORTED_CONFIGURATION', `${source.title}: this visualization requires exactly one metric.`);
  if (['gauge', 'goal'].includes(source.type) && bucketAggs.length) throw new ReportError('UNSUPPORTED_CONFIGURATION', `${source.title}: bucketed gauges and goals are not yet supported.`);
  if (source.type === 'heatmap' && bucketAggs.length !== 2) throw new ReportError('UNSUPPORTED_CONFIGURATION', `${source.title}: heat maps require two bucket dimensions.`);
  if (source.type === 'tagcloud' && (bucketAggs.length !== 1 || bucketAggs[0].type !== 'terms')) throw new ReportError('UNSUPPORTED_CONFIGURATION', `${source.title}: tag clouds require one terms bucket.`);
  if (source.type === 'tile_map' && (bucketAggs.length !== 1 || bucketAggs[0].type !== 'geohash_grid')) throw new ReportError('UNSUPPORTED_CONFIGURATION', `${source.title}: coordinate maps require one geohash bucket.`);
  if (source.type === 'region_map' && (bucketAggs.length !== 1 || bucketAggs[0].type !== 'terms')) throw new ReportError('UNSUPPORTED_CONFIGURATION', `${source.title}: region maps require one terms bucket.`);
  if (source.type === 'region_map' && source.vis.params?.selectedLayer && !/world.?countries/i.test(String(source.vis.params.selectedLayer))) throw new ReportError('UNSUPPORTED_CONFIGURATION', `${source.title}: only the World Countries region layer is available for vector PDF maps.`);
  if (source.type === 'tile_map' && (source.vis.params?.wms || source.vis.params?.mapType && !/scaled.?circle/i.test(String(source.vis.params.mapType)))) throw new ReportError('UNSUPPORTED_CONFIGURATION', `${source.title}: only scaled-circle coordinate maps can be rendered as vector PDFs.`);
  if (source.type === 'tagcloud' && Number(bucketAggs[0].params?.size ?? 5) > 40) throw new ReportError('LAYOUT_LIMIT', `${source.title}: tag clouds are limited to 40 terms on a Letter page.`);
  if (['gauge', 'goal'].includes(source.type) && source.vis.params?.gauge?.percentageMode) throw new ReportError('UNSUPPORTED_CONFIGURATION', `${source.title}: percentage-mode gauges and goals are not supported.`);
  const ids = new Set<string>();
  const colors = source.vis.params?.visColors;
  const safeColor = /^(?:#[0-9a-fA-F]{3,8}|[a-zA-Z]+|(?:rgb|rgba|hsl|hsla)\([0-9.,%\s+-]+\))$/;
  if (colors && (typeof colors !== 'object' || Array.isArray(colors) || Object.values(colors).some(color => typeof color !== 'string' || !safeColor.test(color)))) throw new ReportError('UNSUPPORTED_CONFIGURATION', 'Chart colors must be plain colors. Image patterns and external resources are not supported.');
  const fields = parseJson(source.indexPattern.attributes.fields, []);
  if (source.type === 'tile_map' && !fields.some((field: any) => field.name === bucketAggs[0].params?.field && field.type === 'geo_point')) throw new ReportError('UNSUPPORTED_CONFIGURATION', `${source.title}: coordinate maps require a geo_point field.`);
  validateIndexPattern(source);
  for (const agg of aggs) {
    if (!metrics.has(agg.type) && !buckets.has(agg.type)) throw new ReportError('UNSUPPORTED_CONFIGURATION', `${source.title}: aggregation ${agg.type} is not supported.`);
    if (!agg.id || ids.has(agg.id)) throw new ReportError('INVALID_SOURCE', 'Aggregation IDs must be unique.');
    ids.add(agg.id);
    if (!['metric', 'segment', 'group', 'split', 'bucket'].includes(agg.schema)) throw new ReportError('UNSUPPORTED_CONFIGURATION', `Unsupported aggregation schema ${agg.schema}.`);
    if (agg.params?.json || agg.params?.script || agg.params?.otherBucket || agg.params?.missingBucket) throw new ReportError('UNSUPPORTED_CONFIGURATION', 'Advanced JSON, scripts, and other/missing buckets are not supported.');
    if (agg.params?.field && !fields.some((f: any) => f.name === agg.params.field && !f.scripted)) throw new ReportError('UNSUPPORTED_CONFIGURATION', `Field ${agg.params.field} is missing or scripted.`);
    if (agg.params?.size > 10000) throw new ReportError('QUERY_LIMIT', 'Bucket size exceeds 10,000.');
  }
  if (!aggs.some(a => metrics.has(a.type))) throw new ReportError('UNSUPPORTED_CONFIGURATION', 'A visualization requires at least one metric.');
  if (source.vis.params?.percentageMode || source.vis.params?.showPartialRows || source.vis.params?.showMetricsAtAllLevels) throw new ReportError('UNSUPPORTED_CONFIGURATION', 'Percentage axes and partial/all-level table rows are not supported.');
  if (source.vis.params?.valueAxes?.some((a: any) => a.scale?.type && a.scale.type !== 'linear')) throw new ReportError('UNSUPPORTED_CONFIGURATION', 'Only linear value axes are supported.');
  if ((source.vis.params?.valueAxes?.length ?? 0) > 1 || source.vis.params?.valueAxes?.some((a: any) => a.scale?.mode === 'percentage' || a.scale?.setYExtents === true)) throw new ReportError('UNSUPPORTED_CONFIGURATION', 'Multiple value axes, percentage axes, and custom axis extents are not supported.');
  if (source.vis.params?.showTotal) throw new ReportError('UNSUPPORTED_CONFIGURATION', 'Table totals are not supported.');
  if (source.vis.params?.seriesParams?.some((s: any) => s.type && s.type !== source.type)) throw new ReportError('UNSUPPORTED_CONFIGURATION', 'Mixed chart types are not supported.');
  validateFilters(source.filters);
}
export function validateReport(value: unknown): ReportInput {
  const report = reportSchema.parse(value);
  validateTimezone(report.timezone); resolveRange(report.timeRange, new Date(), report.timezone);
  report.sources.forEach(validateSnapshot); validateFilters(report.filters);
  const ids = new Set(report.sources.map(s => s.key));
  if (ids.size !== report.sources.length || new Set(report.sections.map(s => s.id)).size !== report.sections.length) throw new ReportError('INVALID_LAYOUT', 'Section and source IDs must be unique.');
  for (const section of report.sections) if (section.kind === 'panels') {
    if (section.sources.length > section.columns || section.sources.some(id => !ids.has(id))) throw new ReportError('INVALID_LAYOUT', 'A panel section references missing sources or exceeds its column count.');
    if (section.columns === 2 && section.sources.some(id => report.sources.find(s => s.key === id)?.type === 'table' || report.sources.find(s => s.key === id)?.type === 'search')) throw new ReportError('INVALID_LAYOUT', 'Tables and saved searches require a full-width section.');
  }
  return report;
}
const ref = (object: SavedObject) => ({ type: object.type as Snapshot['refs'][number]['type'], id: object.id, version: object.version });
function resolveFilterRefs(filters: any[], object: SavedObject) {
  return filters.map(filter => {
    if (!filter.meta?.indexRefName) return filter;
    const reference = object.references?.find(r => r.name === filter.meta.indexRefName && r.type === 'index-pattern');
    if (!reference) throw new ReportError('INVALID_SOURCE', 'A saved filter references a missing index pattern.');
    const { indexRefName, ...meta } = filter.meta;
    return { ...filter, meta: { ...meta, index: reference.id } };
  });
}
export class SourceService {
  constructor(private saved: SavedObjects) {}
  async discover(search: string, page = 1) {
    const result = await this.saved.find({ type: sourceTypes, search: search ? `${search}*` : undefined, searchFields: ['title'], perPage: 50, page });
    return { total: result.total, sources: result.saved_objects.map((o: SavedObject) => ({ id: o.id, type: o.type, title: o.attributes.title })) };
  }
  async import(type: SourceType, id: string, selectedPanelId?: string) {
    const root = await this.saved.get(type, id);
    const results: Array<{ source?: Snapshot; title: string; panelId?: string; error?: { code: string; message: string } }> = [];
    const panels = type === 'dashboard' ? parseJson(root.attributes.panelsJSON, []) : [{ id, type, panelIndex: id }];
    for (const panel of panels) {
      const panelId = String(panel.panelIndex ?? panel.explicitInput?.id ?? panel.id);
      if (selectedPanelId && panelId !== selectedPanelId) continue;
      try {
        const referenced = root.references?.find(r => r.name === panel.panelRefName);
        const visualId = referenced?.id ?? panel.id, panelType = referenced?.type ?? panel.type;
        if (panelType === 'map') throw new ReportError('UNSUPPORTED_VISUALIZATION', 'Maps application panels are not supported.');
        if ((panelType !== 'visualization' && panelType !== 'search') || !visualId) throw new ReportError('UNSUPPORTED_VISUALIZATION', 'Only saved aggregation-based visualizations and saved searches are supported.');
        const isSearch = panelType === 'search';
        const visual = type !== 'dashboard' ? root : await this.saved.get(panelType, visualId);
        let vis: Snapshot['vis'];
        if (!isSearch) {
          vis = parseJson(visual.attributes.visState, {});
          if (!supportedTypes.has(vis.type)) throw new ReportError('UNSUPPORTED_VISUALIZATION', `${visual.attributes.title}: unsupported visualization type ${vis.type}.`);
          const uiState = parseJson(visual.attributes.uiStateJSON, {});
          if (uiState['vis.colors']) vis.params = { ...vis.params, visColors: { ...uiState['vis.colors'], ...vis.params?.visColors } };
        }
        const collected: SavedObject[] = type === 'dashboard' ? [root, visual] : [visual];
        const queries: any[] = [], filters: any[] = [];
        let indexId: string | undefined;
        const visited = new Set<string>();
        const collect = async (object: SavedObject) => {
          const key = `${object.type}:${object.id}`;
          if (visited.has(key)) throw new ReportError('INVALID_SOURCE', 'Cyclic saved search reference.');
          visited.add(key);
          const state = parseJson(object.attributes.kibanaSavedObjectMeta?.searchSourceJSON, {});
          if (typeof state.query === 'string' ? !!state.query : state.query?.query) queries.push(typeof state.query === 'string' ? { language: 'lucene', query: state.query } : state.query);
          filters.push(...resolveFilterRefs(state.filter ?? [], object));
          if (!indexId) indexId = typeof state.index === 'string' ? state.index : object.references?.find(r => r.name === (state.indexRefName ?? 'kibanaSavedObjectMeta.searchSourceJSON.index'))?.id;
          const searchId = object.attributes.savedSearchId ?? object.references?.find(r => r.name === 'search_0')?.id;
          if (searchId) { const search = await this.saved.get('search', searchId); collected.push(search); await collect(search); }
        };
        await collect(visual);
        if (type === 'dashboard') {
          const dashState = parseJson(root.attributes.kibanaSavedObjectMeta?.searchSourceJSON, {});
          if (dashState.query?.query) queries.push(dashState.query);
          filters.push(...resolveFilterRefs(dashState.filter ?? [], root));
        }
        const overrides = panel.embeddableConfig ?? panel.explicitInput ?? {};
        const allowedOverrides = ['title', 'hidePanelTitles', 'filters', 'query', 'timeRange', 'id', ...(isSearch ? ['columns', 'sort'] : [])];
        const unsupportedOverrides = Object.keys(overrides).filter(k => !allowedOverrides.includes(k));
        if (unsupportedOverrides.length) throw new ReportError('UNSUPPORTED_CONFIGURATION', `Unsupported panel overrides: ${unsupportedOverrides.join(', ')}.`);
        if (overrides.query?.query) queries.push(overrides.query);
        filters.push(...(overrides.filters ?? []));
        if (isSearch) vis = { type: 'search', params: { columns: searchColumns(overrides.columns ?? visual.attributes.columns), sort: searchSort(overrides.sort ?? visual.attributes.sort), rowLimit: SEARCH_ROW_LIMIT }, aggs: [] };
        if (!indexId) throw new ReportError('INVALID_SOURCE', isSearch ? 'The saved search has no local index pattern.' : 'The visualization has no local index pattern.');
        const index = await this.saved.get('index-pattern', indexId); collected.push(index);
        if (index.references?.some(r => r.type === 'data-source')) throw new ReportError('UNSUPPORTED_CONFIGURATION', 'Remote data sources are not supported.');
        const source: Snapshot = { key: randomUUID(), title: overrides.title ?? visual.attributes.title, type: vis!.type as Snapshot['type'], vis: vis!, refs: collected.map(ref), importRef: ref(root), panelId: type === 'dashboard' ? panelId : undefined, indexPattern: { id: indexId, attributes: index.attributes }, queries, filters };
        validateSnapshot(source); results.push({ source, title: source.title, panelId });
      } catch (e: any) { results.push({ title: panel.title ?? panelId, panelId, error: { code: e instanceof ReportError ? e.code : 'SOURCE_UNAVAILABLE', message: e instanceof ReportError ? e.message : 'Source is missing or inaccessible.' } }); }
    }
    if (!results.length) throw new ReportError('SOURCE_UNAVAILABLE', 'The requested source panel no longer exists.', 404);
    return results;
  }
  async authorize(sources: Snapshot[]) {
    const seen = new Set<string>();
    for (const source of sources) for (const reference of source.refs) {
      const key = `${reference.type}:${reference.id}`;
      if (!seen.has(key)) {
        try { await this.saved.get(reference.type, reference.id); }
        catch (error: any) {
          const status = error?.statusCode ?? error?.output?.statusCode ?? error?.meta?.statusCode;
          if (status === 401 || status === 403 || status === 404) throw new ReportError('SOURCE_UNAVAILABLE', 'A referenced source is missing or the owner no longer has access to it.', 403);
          throw error;
        }
        seen.add(key);
      }
    }
  }
}
