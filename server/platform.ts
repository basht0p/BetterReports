import { Identity, Limits, PanelData, Report, ReportError, Run, Snapshot } from '../common/model';
import { parseJson, SourceService } from './sources';
import { GrantClient, grantFingerprint } from './grants';
import { resolveRange } from './time';
import { assertStoredScope } from './scope';

// SearchSource reads the user's cached UI settings internally. In 3.8.0 its
// Lucene builder spreads a JSON-encoded query-string setting as characters.
// Repair only nodes that contain that exact spread setting.
export function normalizeCompiledQueryDsl(query: any, timezone: string, rawOptions: unknown): any {
  if (Array.isArray(query)) return query.map(item => normalizeCompiledQueryDsl(item, timezone, rawOptions));
  if (!query || typeof query !== 'object') return query;
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(query)) result[key] = normalizeCompiledQueryDsl(value, timezone, rawOptions);
  if (result.query_string && typeof result.query_string === 'object' && !Array.isArray(result.query_string) && typeof result.query_string.query === 'string') {
    const options = result.query_string as Record<string, any>;
    const numeric = Object.keys(options).filter(key => /^(0|[1-9][0-9]*)$/.test(key)).sort((a, b) => Number(a) - Number(b));
    if (numeric.length) {
      if (typeof rawOptions !== 'string' || numeric.length > 10000 || numeric.some((key, index) => Number(key) !== index || typeof options[key] !== 'string' || options[key].length !== 1) || numeric.map(key => options[key]).join('') !== rawOptions) throw new ReportError('INVALID_QUERY', 'The saved Lucene query options are invalid.');
      let decoded: Record<string, any>;
      try {
        const parsed = JSON.parse(rawOptions);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected options object');
        decoded = parsed;
      } catch { throw new ReportError('INVALID_QUERY', 'The saved Lucene query options are invalid.'); }
      const valid = Object.fromEntries(Object.entries(options).filter(([key]) => !numeric.includes(key)));
      result.query_string = { ...decoded, ...valid, time_zone: timezone };
    }
  }
  return result;
}

export function assertTenantAccess(authInfo: any, tenant: string, write = false) {
  const name = tenant === '' ? 'global_tenant' : tenant === '__user__' ? authInfo.user_name : tenant;
  if (!Object.prototype.hasOwnProperty.call(authInfo.tenants ?? {}, name)) throw new ReportError('TENANT_FORBIDDEN', 'The owner no longer has access to this tenant.', 403);
  if (write && authInfo.tenants[name] !== true) throw new ReportError('TENANT_READ_ONLY', 'Write access to this tenant is required.', 403);
}

// All platform-specific calls live here. Contract paths are verified by
// npm run check:platform against upstream tag 3.8.0 (aa72a981).
export class PlatformAdapter {
  readonly grants: GrantClient;
  constructor(private core: any, private data: any, worker: { username: string; password: string }, private limits: Limits) { this.grants = new GrantClient(core, worker); }
  async identity(request: any): Promise<Identity> {
    const state = this.core.http.auth.get(request).state;
    if (!state?.authInfo?.user_name) throw new ReportError('UNAUTHENTICATED', 'Sign in to use BetterReports.', 401);
    const tenant = state.selectedTenant;
    if (typeof tenant !== 'string') throw new ReportError('TENANT_REQUIRED', 'Select a Security tenant before using BetterReports.', 403);
    // Get a fresh authinfo response instead of trusting a cached login session.
    const client = this.core.opensearch.client.asScoped(request).asCurrentUser;
    const { body } = await client.transport.request({ method: 'GET', path: '/_plugins/_security/authinfo' });
    if (body.user_name !== state.authInfo.user_name) throw new ReportError('IDENTITY_MISMATCH', 'Authentication identity changed.', 403);
    assertTenantAccess(body, tenant);
    return { owner: body.user_name, tenant };
  }
  async context(request: any, adminRoles: string[]): Promise<Identity & { canWrite: boolean; allTenants: boolean; canSetOrganizationScope?: boolean; tenantNames?: string[] }> {
    const identity = await this.identity(request);
    const { body } = await this.core.opensearch.client.asScoped(request).asCurrentUser.transport.request({ method: 'GET', path: '/_plugins/_security/authinfo' });
    if (body.user_name !== identity.owner) throw new ReportError('IDENTITY_MISMATCH', 'Authentication identity changed.', 403);
    assertTenantAccess(body, identity.tenant);
    const name = identity.tenant === '' ? 'global_tenant' : identity.tenant === '__user__' ? identity.owner : identity.tenant;
    const context = { ...identity, canWrite: body.tenants[name] === true, allTenants: identity.tenant === '' && (body.roles ?? []).some((role: string) => adminRoles.includes(role)) };
    if (identity.tenant !== '') return context;
    let canSetOrganizationScope = false;
    try { await this.grants.call('admin', {}, request); canSetOrganizationScope = true; }
    catch (error) { if (!(error instanceof ReportError) || error.status !== 403) throw error; }
    const tenantNames = canSetOrganizationScope ? Object.keys(body.tenants ?? {}).filter(tenant => tenant !== 'global_tenant' && tenant !== identity.owner).sort((a, b) => a.localeCompare(b)) : [];
    return { ...context, canSetOrganizationScope, tenantNames };
  }
  async isAdmin(request: any, roles: string[]) {
    const { body } = await this.core.opensearch.client.asScoped(request).asCurrentUser.transport.request({ method: 'GET', path: '/_plugins/_security/authinfo' });
    return (body.roles ?? []).some((role: string) => roles.includes(role));
  }
  sources(request: any) { return new SourceService(this.core.savedObjects.getScopedClient(request)); }
  async authorize(report: Report, request?: any) {
    assertStoredScope(report);
    if (!request) { await this.grants.check(report); return; }
    const scoped = request;
    if (request) {
      const actor = await this.identity(request);
      if (actor.tenant !== report.tenant || (report.tenant === '__user__' && actor.owner !== report.owner)) throw new ReportError('FORBIDDEN', 'Report tenant does not match this session.', 403);
      if (report.tenant === '') await this.grants.call('admin', {}, request);
    }
    await this.sources(scoped).authorize(report.sources);
    return scoped;
  }
  async createGrant(report: Report, request: any, persistent = false): Promise<Report> {
    await this.authorize(report, request);
    const panels: any[] = [], specs: Record<string, any> = {};
    const interval = resolveRange(report.timeRange, new Date(), report.timezone);
    const run = { report, ...interval } as Run;
    for (const source of report.sources) await this.query(source, run, new AbortController().signal, request, undefined, { panels, specs });
    let settings = {};
    try { settings = (await this.core.savedObjects.getScopedClient(request).get('config', '3.8.0')).attributes; } catch (e: any) { if (e?.output?.statusCode !== 404) throw e; }
    const fingerprint = grantFingerprint(report);
    const grant = await this.grants.call('authorize', { reportId: report.id, title: report.title, persistent, revision: report.revision, fingerprint, panels, organizationScope: report.organizationScope, ...interval }, request);
    return { ...report, grant: { id: grant.id, fingerprint, createdAt: grant.createdAt, authorization: 'until_revoked', temporary: !persistent, authorizedBy: grant.owner, specs, settings } };
  }
  async release(run: Run) {
    if (run.report.grant?.temporary) {
      try { await this.grants.call('release', { id: run.report.grant.id, fingerprint: run.report.grant.fingerprint }); }
      catch (error: any) { if (!error.message?.includes('Grant unavailable')) throw error; }
    }
  }
  async execute(run: Run, signal: AbortSignal, request?: any): Promise<PanelData[]> {
    assertStoredScope(run.report);
    await this.grants.check(run.report);
    const { results: raw } = await this.grants.call('execute', { id: run.report.grant!.id, fingerprint: run.report.grant!.fingerprint, from: run.from, to: run.to });
    const results: PanelData[] = [];
    for (const [index, source] of run.report.sources.entries()) {
      signal.throwIfAborted();
      results.push(await this.query(source, run, signal, undefined, raw[index]));
    }
    return results;
  }
  private async query(source: Snapshot, run: Run, signal: AbortSignal, request?: any, rawResult?: any, collecting?: { panels: any[]; specs: Record<string, any> }): Promise<PanelData> {
    const saved = request ? this.core.savedObjects.getScopedClient(request) : { get: async () => ({ id: '3.8.0', type: 'config', attributes: run.report.grant?.settings ?? {} }) };
    const configProxy = new Proxy(saved, { get(target, property) {
      if (property === 'get') return async (type: string, id: string, ...rest: any[]) => {
        const object = await target.get(type, id, ...rest);
        return type === 'config' ? { ...object, attributes: { ...object.attributes, 'dateFormat:tz': run.report.timezone } } : object;
      };
      const value = target[property]; return typeof value === 'function' ? value.bind(target) : value;
    } });
    const uiSettings = this.core.uiSettings.asScopedToClient(configProxy);
    const formatRegistry = await this.data.fieldFormats.fieldFormatServiceFactory(uiSettings);
    let pattern: any;
    if (request) {
      const patterns = await this.data.indexPatterns.indexPatternsServiceFactory(request);
      const spec = patterns.savedObjectToSpec({ id: source.indexPattern.id, version: 'snapshot', attributes: source.indexPattern.attributes, references: [] });
      if (collecting) collecting.specs[source.key] = spec;
      pattern = await patterns.create(spec, true);
    } else {
      const { IndexPattern } = require('../../../src/plugins/data/common/index_patterns/index_patterns/index_pattern');
      pattern = new IndexPattern({ spec: run.report.grant!.specs[source.key], fieldFormats: formatRegistry });
    }
    const aggsService = await this.data.search.aggs.asScopedToClient(configProxy);
    const aggs = aggsService.createAggConfigs(pattern, source.vis.aggs.filter(a => a.enabled !== false));
    aggs.setTimeRange({ from: run.from, to: run.to });
    let search: any;
    if (request) {
    const sources = await this.data.search.searchSource.asScoped(request);
    search = sources.createEmpty();
    search.setField('index', pattern);
    for (const query of [...source.queries, run.report.query].filter(q => q.query)) {
      search.setField('query', query); search = search.createChild();
    }
    const filters = [...source.filters, ...run.report.filters];
    // The companion adds the absolute reporting range at execution time.
    search.setField('filter', filters); search.setField('aggs', () => aggs.toDsl(false)); search.setField('size', 0);
    await aggs.onSearchRequestStart(search, { abortSignal: signal });
    const body = await search.getSearchRequestBody();
    body.query = normalizeCompiledQueryDsl(body.query, run.report.timezone, await uiSettings.get('query:queryString:options'));
    body.track_total_hits = true; body.timeout = `${Math.max(1, Math.floor(this.limits.timeoutMs / 1000) - 5)}s`;
    collecting!.panels.push({ index: pattern.title, body: { query: body.query, aggs: body.aggs, size: 0 }, timeField: pattern.timeFieldName ?? '' });
    search.destroy(); return {} as PanelData;
    }
    try {
      const raw = rawResult;
      if (raw.timed_out || raw._shards?.failed) throw new ReportError('QUERY_INCOMPLETE', 'The query timed out or returned failed shards.', 503, true);
      // Runtime dependency supplied by OpenSearch Dashboards, never npm Kibana packages.
      const { tabifyAggResponse } = require('../../../src/plugins/data/common/search/tabify');
      const table = tabifyAggResponse(aggs, { ...raw, hits: { ...raw.hits, total: typeof raw.hits.total === 'object' ? raw.hits.total.value : raw.hits.total } }, { partialRows: false, metricsAtAllLevels: false });
      if (table.rows.length > this.limits.rows) throw new ReportError('QUERY_LIMIT', `The result exceeds ${this.limits.rows} rows.`);
      const formats = await this.data.fieldFormats.fieldFormatServiceFactory(this.core.uiSettings.asScopedToClient(configProxy));
      // The server registry's deserialize() is intentionally an identity stub.
      // Use real registered converters plus the platform's range/terms wrappers.
      const { getFormatWithAggs } = require('../../../src/plugins/data/common/search/aggs/utils/get_format_with_aggs');
      const deserialize = getFormatWithAggs((mapping: any) => formats.getInstance(mapping?.id && formats.getType(mapping.id) ? mapping.id : 'string', mapping?.params ?? {}));
      const formatters = table.columns.map((col: any) => deserialize(col.aggConfig.toSerializedFieldFormat()).getConverterFor('text'));
      const firstMetric = table.columns.findIndex((col: any) => col.aggConfig.type.type === 'metrics');
      const values: number[] = table.rows.flatMap((row: any) => table.columns.slice(firstMetric).map((col: any) => row[col.id])).filter((v: any) => typeof v === 'number' && Number.isFinite(v));
      let axis: PanelData['axis'];
      if (values.length && firstMetric >= 0) {
        let low = 0, high = 0;
        for (const value of values) { low = Math.min(low, value); high = Math.max(high, value); }
        if (source.vis.params.seriesParams?.some((s: any) => s.mode === 'stacked')) {
          const segment = table.columns.find((col: any) => col.aggConfig.schema === 'segment') ?? table.columns[0];
          const sums = new Map<string, [number, number]>();
          for (const row of table.rows) {
            const key = String(row[segment.id]), sum = sums.get(key) ?? [0, 0];
            for (const col of table.columns.slice(firstMetric)) { const value = row[col.id]; if (typeof value === 'number' && Number.isFinite(value)) sum[value < 0 ? 0 : 1] += value; }
            sums.set(key, sum);
          }
          for (const [negative, positive] of sums.values()) { low = Math.min(low, negative); high = Math.max(high, positive); }
        }
        const rough = (high - low || 1) / 5, magnitude = 10 ** Math.floor(Math.log10(rough));
        const interval = ([1, 2, 5, 10].find(n => n * magnitude >= rough) ?? 10) * magnitude;
        const min = Math.floor(low / interval) * interval, max = Math.ceil(high / interval) * interval || interval;
        const labels: Record<string, string> = {};
        for (let value = min; value <= max + interval / 2; value += interval) labels[Number(value.toPrecision(12)).toString()] = String(formatters[firstMetric](value));
        axis = { min, max, interval, labels };
      }
      return { key: source.key, title: source.title, type: source.type, params: source.vis.params,
        axis,
        columns: table.columns.map((col: any) => col.name),
        bucketCount: table.columns.filter((col: any) => col.aggConfig.type.type === 'buckets').length,
        schemas: table.columns.map((col: any) => col.aggConfig.schema),
        rows: table.rows.map((row: any) => table.columns.map((col: any, index: number) => ({ value: row[col.id] ?? null, text: row[col.id] == null ? '-' : String(formatters[index](row[col.id])) }))) };
    } catch (error: any) {
      if (error instanceof ReportError) throw error;
      const status = error?.meta?.statusCode ?? error?.statusCode;
      if (status === 401 || status === 403) throw new ReportError('PERMISSION_DENIED', 'The owner no longer has permission to query this data.', 403);
      if (status === 429 || status >= 500 || ['ConnectionError', 'TimeoutError'].includes(error?.name)) throw new ReportError('QUERY_UNAVAILABLE', 'OpenSearch could not complete the query. A retry will use the same reporting interval.', 503, true);
      if (status === 400) throw new ReportError('INVALID_QUERY', 'OpenSearch rejected the saved query or aggregation configuration. Review the source and report filters.');
      throw error;
    } finally { search?.destroy(); }
  }
}
