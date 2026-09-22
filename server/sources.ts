import { randomUUID } from 'crypto';
import { ReportError, Snapshot, reportSchema, ReportInput } from '../common/model';
import { validateTimezone, resolveRange } from './time';
import { parseTimeline } from './timeline';

export interface SavedObject { id: string; type: string; version?: string; attributes: Record<string, any>; references: Array<{ type: string; id: string; name: string }>; }
export interface SavedObjects { get(type: string, id: string): Promise<SavedObject>; find(options: any): Promise<any>; }
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
export function validateSnapshot(source: Snapshot) {
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
  if (source.type === 'tile_map' && source.vis.params?.mapColor && !/^#[0-9a-fA-F]{6}$/.test(source.vis.params.mapColor)) throw new ReportError('UNSUPPORTED_CONFIGURATION', `${source.title}: map color must be a six-digit hex color.`);
  if (['gauge', 'goal'].includes(source.type) && source.vis.params?.gauge?.percentageMode) throw new ReportError('UNSUPPORTED_CONFIGURATION', `${source.title}: percentage-mode gauges and goals are not supported.`);
  const ids = new Set<string>();
  const colors = source.vis.params?.visColors;
  const safeColor = /^(?:#[0-9a-fA-F]{3,8}|[a-zA-Z]+|(?:rgb|rgba|hsl|hsla)\([0-9.,%\s+-]+\))$/;
  if (colors && (typeof colors !== 'object' || Array.isArray(colors) || Object.values(colors).some(color => typeof color !== 'string' || !safeColor.test(color)))) throw new ReportError('UNSUPPORTED_CONFIGURATION', 'Chart colors must be plain colors. Image patterns and external resources are not supported.');
  const fields = parseJson(source.indexPattern.attributes.fields, []);
  if (source.type === 'tile_map' && !fields.some((field: any) => field.name === bucketAggs[0].params?.field && field.type === 'geo_point')) throw new ReportError('UNSUPPORTED_CONFIGURATION', `${source.title}: coordinate maps require a geo_point field.`);
  if (source.indexPattern.attributes.dataSourceRef || source.indexPattern.attributes.type === 'rollup') throw new ReportError('UNSUPPORTED_CONFIGURATION', 'Only local, ordinary index patterns are supported.');
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
  const formats = parseJson(source.indexPattern.attributes.fieldFormatMap, {});
  if (Object.values(formats).some((f: any) => !['number', 'bytes', 'percent', 'date', 'string', 'duration'].includes(f.id))) throw new ReportError('UNSUPPORTED_CONFIGURATION', 'This index pattern uses an unsupported field formatter.');
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
    if (section.columns === 2 && section.sources.some(id => report.sources.find(s => s.key === id)?.type === 'table')) throw new ReportError('INVALID_LAYOUT', 'Tables require a full-width section.');
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
    const options = { search: search ? `${search}*` : undefined, searchFields: ['title'], perPage: 50, page };
    let result: any;
    try { result = await this.saved.find({ ...options, type: ['dashboard', 'visualization', 'map'] }); }
    catch (error: any) {
      const message = String(error?.message ?? '');
      if (!/map/i.test(message) || !/unknown|not registered|not found/i.test(message)) throw error;
      result = await this.saved.find({ ...options, type: ['dashboard', 'visualization'] });
    }
    return { total: result.total, sources: result.saved_objects.map((o: SavedObject) => ({ id: o.id, type: o.type, title: o.attributes.title })) };
  }
  async import(type: 'dashboard' | 'visualization' | 'map', id: string, selectedPanelId?: string) {
    const root = await this.saved.get(type, id);
    const results: Array<{ source?: Snapshot; title: string; panelId?: string; error?: { code: string; message: string } }> = [];
    const panels = type === 'dashboard' ? parseJson(root.attributes.panelsJSON, []) : [{ id, type, panelIndex: id }];
    for (const panel of panels) {
      const panelId = String(panel.panelIndex ?? panel.explicitInput?.id ?? panel.id);
      if (selectedPanelId && panelId !== selectedPanelId) continue;
      try {
        const referenced = root.references?.find(r => r.name === panel.panelRefName);
        const visualId = referenced?.id ?? panel.id;
        if ((referenced?.type ?? panel.type) === 'map') {
          const map = type === 'map' ? root : await this.saved.get('map', visualId);
          const layers = parseJson(map.attributes.layerList, []);
          if (!Array.isArray(layers)) throw new ReportError('INVALID_SOURCE', 'The saved map has an invalid layer list.');
          const dataLayers = layers.filter((layer: any) => layer.visibility !== 'hidden' && !['opensearch_vector_tile_map'].includes(layer.type));
          if (dataLayers.length !== 1 || dataLayers[0].type !== 'cluster') throw new ReportError('UNSUPPORTED_CONFIGURATION', 'Maps require exactly one visible geohash cluster layer; document, custom, and multiple data layers are not yet supported.');
          const layer = dataLayers[0], config = layer.source;
          if (!config?.indexPatternId || config.cluster?.agg !== 'geohash_grid' || config.cluster?.changePrecision || config.cluster?.useCentroid || config.cluster?.json || config.metric?.json || !metrics.has(config.metric?.agg)) throw new ReportError('UNSUPPORTED_CONFIGURATION', 'This map requires a fixed-precision geohash cluster and a supported metric without advanced JSON or centroid settings.');
          if (!Number.isInteger(Number(config.cluster.precision)) || Number(config.cluster.precision) < 1 || Number(config.cluster.precision) > 12) throw new ReportError('UNSUPPORTED_CONFIGURATION', 'Map geohash precision must be between 1 and 12.');
          const state = parseJson(map.attributes.mapState, {});
          if (state.spatialMetaFilters?.length || config.useGeoBoundingBoxFilter) throw new ReportError('UNSUPPORTED_CONFIGURATION', 'Spatial filters and viewport-bound map layers are not supported in PDF maps.');
          if (type === 'dashboard' && config.applyGlobalFilters === false) throw new ReportError('UNSUPPORTED_CONFIGURATION', 'This map layer excludes dashboard filters, which BetterReports cannot reproduce.');
          const index = await this.saved.get('index-pattern', config.indexPatternId);
          const aggMetric = { id: '1', enabled: true, type: config.metric.agg, schema: 'metric', params: config.metric.agg === 'count' ? {} : { field: config.metric.field } };
          const aggBucket = { id: '2', enabled: true, type: 'geohash_grid', schema: 'segment', params: { field: config.cluster.field, precision: Number(config.cluster.precision) } };
          const queries = state.query?.query ? [state.query] : [];
          const filters = [...(config.filters ?? [])];
          const collected = [map, index];
          if (type === 'dashboard') {
            const dashboardState = parseJson(root.attributes.kibanaSavedObjectMeta?.searchSourceJSON, {});
            if (dashboardState.query?.query) queries.push(dashboardState.query);
            filters.push(...resolveFilterRefs(dashboardState.filter ?? [], root)); collected.unshift(root);
          }
          const overrides = panel.embeddableConfig ?? panel.explicitInput ?? {};
          const unsupportedOverrides = Object.keys(overrides).filter(key => !['title', 'hidePanelTitles', 'filters', 'query', 'timeRange', 'id'].includes(key));
          if (unsupportedOverrides.length) throw new ReportError('UNSUPPORTED_CONFIGURATION', `Unsupported map panel overrides: ${unsupportedOverrides.join(', ')}.`);
          if (overrides.query?.query) queries.push(overrides.query);
          filters.push(...(overrides.filters ?? []));
          const vis = { type: 'tile_map', params: { mapType: 'Scaled Circle', mapColor: layer.style?.fillColor }, aggs: [aggMetric, aggBucket] };
          const source: Snapshot = { key: randomUUID(), title: overrides.title ?? map.attributes.title, type: 'tile_map', vis, refs: collected.map(ref), importRef: ref(root), panelId: type === 'dashboard' ? panelId : undefined, indexPattern: { id: index.id, attributes: index.attributes }, queries, filters };
          validateSnapshot(source); results.push({ source, title: source.title, panelId }); continue;
        }
        if ((referenced?.type ?? panel.type) !== 'visualization' || !visualId) throw new ReportError('UNSUPPORTED_VISUALIZATION', 'Only saved aggregation-based visualizations are supported.');
        const visual = type === 'visualization' ? root : await this.saved.get('visualization', visualId);
        let vis = parseJson(visual.attributes.visState, {});
        let timelineIndex: string | undefined;
        let timelineQuery: { language: 'lucene'; query: string } | undefined;
        if (vis.type === 'timelion') {
          const expression = parseTimeline(vis.params?.expression ?? '');
          const patterns = await this.saved.find({ type: 'index-pattern', search: expression.index, searchFields: ['title'], perPage: 100 });
          const pattern = patterns.saved_objects.find((item: SavedObject) => item.attributes.title === expression.index);
          if (!pattern) throw new ReportError('SOURCE_UNAVAILABLE', `Timeline index pattern ${expression.index} is missing or inaccessible.`);
          if (expression.timefield && expression.timefield !== pattern.attributes.timeFieldName) throw new ReportError('UNSUPPORTED_CONFIGURATION', 'Timeline timefield must match the saved index pattern time field.');
          if (!pattern.attributes.timeFieldName) throw new ReportError('UNSUPPORTED_CONFIGURATION', 'Timeline requires a time-based index pattern.');
          timelineIndex = pattern.id;
          timelineQuery = expression.query ? { language: 'lucene', query: expression.query } : undefined;
          vis = { type: 'line', params: { addLegend: true }, aggs: [
            { id: '1', enabled: true, type: expression.metric.type, schema: 'metric', params: expression.metric.field ? { field: expression.metric.field } : {} },
            { id: '2', enabled: true, type: 'date_histogram', schema: 'segment', params: { field: pattern.attributes.timeFieldName, interval: vis.params?.interval || 'auto' } },
            ...(expression.split ? [{ id: '3', enabled: true, type: 'terms', schema: 'group', params: { field: expression.split.field, size: expression.split.size } }] : [])
          ] };
        }
        if (!supportedTypes.has(vis.type)) throw new ReportError('UNSUPPORTED_VISUALIZATION', `${visual.attributes.title}: unsupported visualization type ${vis.type}.`);
        const uiState = parseJson(visual.attributes.uiStateJSON, {});
        if (uiState['vis.colors']) vis.params = { ...vis.params, visColors: { ...uiState['vis.colors'], ...vis.params?.visColors } };
        const collected: SavedObject[] = type === 'dashboard' ? [root, visual] : [visual];
        const queries: any[] = [], filters: any[] = [];
        let indexId: string | undefined = timelineIndex;
        if (timelineQuery) queries.push(timelineQuery);
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
        const unsupportedOverrides = Object.keys(overrides).filter(k => !['title', 'hidePanelTitles', 'filters', 'query', 'timeRange', 'id'].includes(k));
        if (unsupportedOverrides.length) throw new ReportError('UNSUPPORTED_CONFIGURATION', `Unsupported panel overrides: ${unsupportedOverrides.join(', ')}.`);
        if (overrides.query?.query) queries.push(overrides.query);
        filters.push(...(overrides.filters ?? []));
        if (!indexId) throw new ReportError('INVALID_SOURCE', 'The visualization has no local index pattern.');
        const index = await this.saved.get('index-pattern', indexId); collected.push(index);
        if (index.references?.some(r => r.type === 'data-source')) throw new ReportError('UNSUPPORTED_CONFIGURATION', 'Remote data sources are not supported.');
        const source: Snapshot = { key: randomUUID(), title: overrides.title ?? visual.attributes.title, type: vis.type, vis, refs: collected.map(ref), importRef: ref(root), panelId: type === 'dashboard' ? panelId : undefined, indexPattern: { id: indexId, attributes: index.attributes }, queries, filters };
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
