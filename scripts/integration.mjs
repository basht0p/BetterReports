// Intentionally fixed loopback ports. This script mutates only the disposable dev cluster.
import http from 'node:http';
import https from 'node:https';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createHash } from 'node:crypto';
const secrets = JSON.parse(await readFile('.platform/dev-secrets.json', 'utf8'));
function request(service, path, method = 'GET', body, username = 'admin', tenant = 'operations') {
  const password = ({ admin: secrets.admin, report_owner: secrets.owner, report_other: secrets.other })[username];
  return new Promise((resolve, reject) => {
    const client = service === 'os' ? https : http;
    const req = client.request({ hostname: '127.0.0.1', port: service === 'os' ? 19400 : service === 'osd2' ? 15602 : 15601, path: service === 'os' ? path : `/br${path}`, method, rejectUnauthorized: false, timeout: 30000,
      headers: { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`, securitytenant: tenant, 'osd-xsrf': 'integration', 'content-type': 'application/json' } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => { const text = Buffer.concat(chunks).toString(); let data; try { data = JSON.parse(text); } catch { data = text.slice(0, 1000); } if (res.statusCode >= 400) reject(Object.assign(new Error(`${service} ${method} ${path}: ${res.statusCode} ${JSON.stringify(data)}`), { status: res.statusCode })); else resolve(data); });
    }); req.on('error', reject); req.on('timeout', () => req.destroy(new Error('Request timeout'))); if (body !== undefined) req.write(JSON.stringify(body)); req.end();
  });
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(label, fn, seconds = 180) { let last; const deadline = Date.now() + seconds * 1000; while (Date.now() < deadline) { try { const result = await fn(); if (result) return result; } catch (error) { if (error.fatal) throw error; last = error; } await delay(2000); } throw new Error(`${label} timed out: ${last?.message ?? ''}`); }
await wait('OpenSearch', () => request('os', '/'));
const put = (path, body) => request('os', `/_plugins/_security/api/${path}`, 'PUT', body);
await put('tenants/operations', { description: 'BetterReports disposable fixture' });
await put('tenants/finance', { description: 'BetterReports second tenant fixture' });
await put('roles/betterreports_storage', { cluster_permissions: [], index_permissions: [{ index_patterns: ['.better-reports-v1-*'], allowed_actions: ['indices_all'] }], tenant_permissions: [] });
await put('rolesmapping/betterreports_storage', { users: ['kibanaserver'] });
await put('roles/betterreports_fixture', { cluster_permissions: ['cluster_composite_ops'], index_permissions: [{ index_patterns: ['br-fixture-*'], allowed_actions: ['read'], dls: JSON.stringify({ term: { environment: 'production' } }) }], tenant_permissions: [{ tenant_patterns: ['operations', 'finance'], allowed_actions: ['kibana_all_write'] }] });
for (const [name, password] of [['report_owner', secrets.owner], ['report_other', secrets.other], ['betterreports_runner', secrets.runner]]) await put(`internalusers/${name}`, { password, backend_roles: [] });
await put('rolesmapping/betterreports_fixture', { users: ['report_owner', 'report_other'] });
await put('roles/betterreports_user', JSON.parse(await readFile('companion/roles.json', 'utf8')).betterreports_user);
await put('rolesmapping/betterreports_user', { users: ['report_owner','report_other'] });
await put('roles/betterreports_worker', JSON.parse(await readFile('companion/roles.json', 'utf8')).betterreports_worker);
await put('rolesmapping/betterreports_worker', { users: ['betterreports_runner'] });
// Dashboards may have attempted storage initialization before roles existed.
const { spawnSync } = await import('node:child_process');
const restarted = spawnSync('docker', ['compose', '-f', 'dev/compose.yml', 'restart', 'dashboards', ...(process.argv.includes('--multi') ? ['dashboards-secondary'] : [])], { stdio: 'inherit', env: { ...process.env, BR_ADMIN_PASSWORD: secrets.admin, BR_RUNNER_PASSWORD: secrets.runner } });
assert.equal(restarted.status, 0);
await wait('Dashboards', () => request('osd', '/api/better_reports/health'), 240);
if (process.argv.includes('--multi')) await wait('Secondary Dashboards', () => request('osd2', '/api/better_reports/health'), 240);
await request('os', '/br-fixture-data', 'PUT', { mappings: { properties: { '@timestamp': { type: 'date' }, environment: { type: 'keyword' }, bytes: { type: 'long' } } } }).catch(error => { if (!error.message.includes('resource_already_exists_exception')) throw error; });
for (let i = 0; i < 20; i++) await request('os', `/br-fixture-data/_doc/${i}?refresh=true`, 'PUT', { '@timestamp': '2026-09-20T12:00:00Z', environment: i < 12 ? 'production' : 'development', bytes: i * 100 });
const so = (type, id, body) => request('osd', `/api/saved_objects/${type}/${id}?overwrite=true`, 'POST', body, 'report_owner');
await so('index-pattern', 'br-fixture-index', { attributes: { title: 'br-fixture-*', timeFieldName: '@timestamp', fields: JSON.stringify([{ name: '@timestamp', type: 'date', searchable: true, aggregatable: true }, { name: 'bytes', type: 'number', searchable: true, aggregatable: true }, { name: 'environment', type: 'string', searchable: true, aggregatable: true }]) } });
await so('visualization', 'br-fixture-metric', { attributes: { title: 'Production requests', visState: JSON.stringify({ type: 'metric', params: {}, aggs: [{ id: '1', enabled: true, type: 'count', schema: 'metric', params: {} }] }), kibanaSavedObjectMeta: { searchSourceJSON: JSON.stringify({ indexRefName: 'kibanaSavedObjectMeta.searchSourceJSON.index', query: { language: 'kuery', query: '' }, filter: [] }) } }, references: [{ type: 'index-pattern', id: 'br-fixture-index', name: 'kibanaSavedObjectMeta.searchSourceJSON.index' }] });
const api = (path, method = 'GET', body, username = 'report_owner', tenant = 'operations') => request('osd', `/api/better_reports${path}`, method, body, username, tenant);
const dataCheck = await request('os', '/br-fixture-data/_search', 'POST', { size: 0, track_total_hits: true }, 'report_owner'); assert.equal(dataCheck.hits.total.value, 12, 'DLS must exclude development records');
const imported = await api('/sources/import', 'POST', { type: 'visualization', id: 'br-fixture-metric' }); assert.ok(imported[0].source, JSON.stringify(imported));
const source = imported[0].source;
const report = await api('/reports', 'POST', { title: 'Integration report', timezone: 'UTC', timeRange: { from: '2026-09-19T00:00:00Z', to: '2026-09-21T00:00:00Z' }, query: { language: 'kuery', query: '' }, filters: [], branding: { organization: 'BetterReports integration', header: 'Synthetic data', footer: 'Test fixture', color: '#2457a7', alignment: 'left', showPeriod: true, showGenerated: true, showPageNumbers: true }, sources: [source], sections: [{ id: 'metric', kind: 'panels', columns: 1, sources: [source.key] }] });
await assert.rejects(api(`/reports/${report.id}`, 'GET', undefined, 'report_other'), error => error.status === 404);
await assert.rejects(api(`/reports/${report.id}`, 'GET', undefined, 'report_owner', 'finance'), error => error.status === 404);
const queued = await api(`/reports/${report.id}/runs`, 'POST', {});
const finished = await wait('Rendered run', async () => { const run = await api(`/runs/${queued.runId}`); if (run.status === 'failed') throw Object.assign(new Error(JSON.stringify(run.error)), { fatal: true }); return run.status === 'complete' ? run : false; }, 120);
await wait('Temporary permission cleanup', async () => (await api(`/runs/${finished.id}`)).grantReleased === true, 90);
const artifact = await api(`/runs/${finished.id}/pdf?encoding=base64`); const pdf = Buffer.from(artifact.pdf, 'base64'); assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
await mkdir('output/integration', { recursive: true }); await writeFile('output/integration/report.pdf', pdf);
assert.equal(createHash('sha256').update(pdf).digest('hex'), artifact.sha256);
async function textOf(bytes) { const doc = await getDocument({ data: new Uint8Array(bytes), isEvalSupported: false }).promise; let text = ''; for (let i = 1; i <= doc.numPages; i++) { const page = await doc.getPage(i); assert.deepEqual(page.view, [0, 0, 612, 792]); text += (await page.getTextContent()).items.map(item => item.str).join(' '); } await doc.destroy(); return text.replace(/\s+/g, ' '); }
assert.match(await textOf(pdf), /Count 12/);
await assert.rejects(api(`/runs/${finished.id}/pdf?encoding=base64`, 'GET', undefined, 'report_other'), error => error.status === 404);
// Exercise every supported visual type and aggregation through real 3.8.0 services.
const metric = (type, i) => ({ id: String(i), enabled: true, type, schema: 'metric', params: type === 'count' ? {} : type === 'cardinality' ? { field: 'environment' } : type === 'percentiles' ? { field: 'bytes', percents: [50, 95] } : { field: 'bytes' } });
const bucket = (type, params) => ({ id: 'b', enabled: true, type, schema: 'segment', params });
const cases = [
  ['table', [bucket('terms', { field: 'environment', size: 10, order: 'desc', orderBy: '1' }), ...['count', 'sum', 'avg', 'min', 'max', 'cardinality', 'percentiles'].map((type, i) => metric(type, i + 1))]],
  ['line', [bucket('date_histogram', { field: '@timestamp', interval: '1d', min_doc_count: 1 }), metric('count', 1)]],
  ['area', [bucket('histogram', { field: 'bytes', interval: 300, min_doc_count: 1 }), metric('sum', 1)]],
  ['histogram', [bucket('filters', { filters: [{ input: { query: 'environment: production', language: 'kuery' }, label: 'Production' }] }), metric('avg', 1)]],
  ['pie', [bucket('range', { field: 'bytes', ranges: [{ from: 0, to: 600 }, { from: 600, to: 1200 }] }), metric('count', 1)]]
];
const visualRefs = [];
for (const [type, aggs] of cases) {
  const id = `br-fixture-${type}`; visualRefs.push({ type: 'visualization', id, name: `panel_${type}` });
  await so('visualization', id, { attributes: { title: `${type} fixture`, visState: JSON.stringify({ type, params: { addLegend: true, isDonut: type === 'pie' }, aggs }), kibanaSavedObjectMeta: { searchSourceJSON: JSON.stringify({ indexRefName: 'index', query: { language: 'kuery', query: '' }, filter: [] }) } }, references: [{ type: 'index-pattern', id: 'br-fixture-index', name: 'index' }] });
}
await so('dashboard', 'br-fixture-dashboard', { attributes: { title: 'BetterReports fixtures', panelsJSON: JSON.stringify(visualRefs.map((ref, i) => ({ panelIndex: String(i), panelRefName: ref.name, type: 'visualization', version: '3.8.0', gridData: { x: (i % 2) * 24, y: Math.floor(i / 2) * 15, w: 24, h: 15, i: String(i) }, embeddableConfig: {} }))), kibanaSavedObjectMeta: { searchSourceJSON: JSON.stringify({ query: { language: 'kuery', query: 'bytes >= 0' }, filter: [] }) } }, references: visualRefs });
const panels = await api('/sources/import', 'POST', { type: 'dashboard', id: 'br-fixture-dashboard' });
assert.ok(panels.every(panel => panel.source), JSON.stringify(panels));
const { id, owner, tenant, revision, schemaVersion, updatedAt, ...definition } = report;
const allTypes = { ...definition, title: 'All supported visualizations', sources: [source, ...panels.map(panel => panel.source)] };
allTypes.sections = allTypes.sources.map((source, i) => ({ id: String(i), kind: 'panels', columns: 1, sources: [source.key] }));
async function completeRun(queued) { return wait('Fixture run', async () => { const run = await api(`/runs/${queued.runId}`); if (run.status === 'failed') throw Object.assign(new Error(JSON.stringify(run.error)), { fatal: true }); return run.status === 'complete' ? run : false; }, 180); }
const allRun = await completeRun(await api('/preview', 'POST', allTypes));
const allArtifact = await api(`/runs/${allRun.id}/pdf?encoding=base64`);
const allPdf = Buffer.from(allArtifact.pdf, 'base64'); await writeFile('output/integration/all-types.pdf', allPdf);
const allText = await textOf(allPdf); assert.ok(!allText.includes('1789862400000'), 'Dates must use field formatting'); for (const [type] of cases) assert.ok(allText.includes(`${type} fixture`), `Missing ${type}`);
assert.ok(allText.includes('6,600') || allText.includes('6600'), 'Sum must honor DLS');
// Change source configuration, then data; snapshots must stay pinned until refresh.
await so('visualization', 'br-fixture-metric', { attributes: { title: 'Changed sum', visState: JSON.stringify({ type: 'metric', params: {}, aggs: [metric('sum', 1)] }), kibanaSavedObjectMeta: { searchSourceJSON: JSON.stringify({ indexRefName: 'index', query: { language: 'kuery', query: '' }, filter: [] }) } }, references: [{ type: 'index-pattern', id: 'br-fixture-index', name: 'index' }] });
await request('os', '/br-fixture-data/_doc/12?refresh=true', 'PUT', { '@timestamp': '2026-09-20T12:00:00Z', environment: 'production', bytes: 1200 });
const pinned = await completeRun(await api(`/reports/${report.id}/runs`, 'POST', {}));
const pinnedPdf = await api(`/runs/${pinned.id}/pdf?encoding=base64`);
assert.match(await textOf(Buffer.from(pinnedPdf.pdf, 'base64')), /Count 13/);
await api(`/reports/${report.id}/refresh`, 'POST', { revision: report.revision });
const refreshed = await completeRun(await api(`/reports/${report.id}/runs`, 'POST', {}));
assert.match(await textOf(Buffer.from((await api(`/runs/${refreshed.id}/pdf?encoding=base64`)).pdf, 'base64')), /7,?800/);
let distributedWorkers = [];
if (process.argv.includes('--multi')) { const queued = await Promise.all(Array.from({ length: 8 }, () => api('/preview', 'POST', allTypes))); const complete = await Promise.all(queued.map(completeRun)); distributedWorkers = [...new Set(complete.map(run => run.worker))]; assert.equal(distributedWorkers.length, 2, 'Both instances should execute shared jobs'); }
const baselineMailCount = (await (await fetch('http://127.0.0.1:18081')).json()).count;
const latestForGrant = await api(`/reports/${report.id}`); await api(`/reports/${report.id}/authorize`, "POST", { revision: latestForGrant.revision });
const sender = await request('os', '/_plugins/_notifications/configs', 'POST', { config: { name: 'BetterReports fixture sender', config_type: 'smtp_account', is_enabled: true, smtp_account: { host: 'smtp', port: 2525, method: 'none', from_address: 'reports@example.test' } } }, 'report_owner');
const group = await request('os', '/_plugins/_notifications/configs', 'POST', { config: { name: 'BetterReports fixture recipients', config_type: 'email_group', is_enabled: true, email_group: { recipient_list: [{ recipient: 'fixture@example.test' }] } } }, 'report_owner');
const notificationOptions = await api('/notification-options'); assert.ok(notificationOptions.senders.some(option => option.id === sender.config_id)); assert.ok(notificationOptions.groups.some(option => option.id === group.config_id));
const schedule = await api('/schedules', 'POST', { reportId: report.id, cron: '* * * * *', timezone: 'UTC', enabled: true, senderId: sender.config_id, recipientGroupIds: [group.config_id], subject: 'BetterReports integration', message: 'Synthetic test report' });
const mail = await wait('Browser-independent scheduled email', async () => {
  const response = await fetch('http://127.0.0.1:18081'); const data = await response.json(); return data.count > baselineMailCount ? data : false;
}, 180);
assert.match(mail.messages.at(-1), /application\/pdf/);
const messageIds = mail.messages.slice(baselineMailCount).map(message => message.replace(/\r?\n[ \t]+/g, ' ').match(/^Message-ID: (.+)$/mi)?.[1]); assert.equal(new Set(messageIds).size, messageIds.length, 'Scheduled occurrences must not send duplicate Message-IDs');
const authorizedReport = await api(`/reports/${report.id}`);
await api(`/grants/${authorizedReport.grant.id}/revoke`, 'POST', {});
assert.equal((await api('/schedules')).find(s => s.id === schedule.id).enabled, false, 'Revocation pauses dependent schedules');
await assert.rejects(api(`/schedules/${schedule.id}/run`, 'POST', {}), error => error.status === 403);
await api(`/reports/${report.id}/authorize`, 'POST', { revision: authorizedReport.revision });
await assert.rejects(request('os', '/.better-reports-v1-artifacts/_search', 'POST', { size: 1 }, 'report_owner'), error => error.status === 403);
await put('rolesmapping/betterreports_fixture', { users: ['report_other'] });
try { await assert.rejects(api(`/runs/${finished.id}/pdf?encoding=base64`), error => error.status === 403); }
finally { await put('rolesmapping/betterreports_fixture', { users: ['report_owner', 'report_other'] }); }
await writeFile('output/integration/results.json', JSON.stringify({ platform: '3.8.0', senderId: sender.config_id, recipientGroupIds: [group.config_id], distributedWorkers, reportId: report.id, runId: finished.id, pagesExpected: 1, sha256: artifact.sha256, scheduledEmails: mail.count - baselineMailCount, allTypesRunId: allRun.id, dlsCount: 12, pinnedFreshCount: 13, refreshedSum: 7800, checkedAt: new Date().toISOString() }, null, 2));
console.log('PASS: 3.8.0 installation, source import, PDF generation, owner/tenant isolation, artifact authorization, and scheduled Notifications PDF email. Evidence: output/integration/.');
