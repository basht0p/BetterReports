// Mutates only the disposable loopback development cluster.
import https from 'node:https';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const secrets = JSON.parse(await readFile('.platform/dev-secrets.json', 'utf8'));
function request(path, body, user = 'admin', tenant = 'operations', method = 'POST') {
  const passwords = { admin: secrets.admin, report_owner: secrets.owner, report_other: secrets.other, betterreports_runner: secrets.runner };
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: '127.0.0.1', port: 19200, path, method, rejectUnauthorized: false, headers: { authorization: `Basic ${Buffer.from(`${user}:${passwords[user]}`).toString('base64')}`, securitytenant: tenant, 'content-type': 'application/json' } }, res => {
      let text = ''; res.on('data', chunk => text += chunk); res.on('end', () => { let json; try { json = JSON.parse(text); } catch { json = { text }; } if (res.statusCode >= 400) reject(Object.assign(new Error(`${res.statusCode}: ${JSON.stringify(json)}`), { status: res.statusCode })); else resolve(json); });
    }); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
let ready = false; for (let i = 0; i < 120; i++) { try { await request('/', undefined, 'admin', '', 'GET'); ready = true; break; } catch { await new Promise(r => setTimeout(r, 1000)); } } assert.ok(ready, 'OpenSearch ready');
const put = (path, body) => request(`/_plugins/_security/api/${path}`, body, 'admin', '', 'PUT');
for (const tenant of ['operations','finance']) await put(`tenants/${tenant}`, { description: 'Companion fixture' });
for (const [user, password] of [['report_owner',secrets.owner], ['report_other',secrets.other], ['betterreports_runner',secrets.runner]]) await put(`internalusers/${user}`, { password, backend_roles: [] });
await put('roles/companion_owner', { cluster_permissions: ['cluster:admin/betterreports/authorize','cluster:admin/betterreports/list','cluster:admin/betterreports/revoke','cluster:admin/betterreports/check'], index_permissions: [{ index_patterns: ['br-companion-*'], allowed_actions: ['read'], dls: '{"term":{"department":"operations"}}', fls: ['~secret'] }], tenant_permissions: [{ tenant_patterns: ['operations'], allowed_actions: ['kibana_all_write'] }] });
await put('rolesmapping/companion_owner', { users: ['report_owner','report_other'] });
await put('roles/betterreports_worker', { cluster_permissions: ['cluster:admin/betterreports/execute','cluster:admin/betterreports/check','cluster:admin/betterreports/release'], index_permissions: [], tenant_permissions: [] });
await put('rolesmapping/betterreports_worker', { users: ['betterreports_runner'] });
await request('/br-companion-data', { mappings: { properties: { department: { type: 'keyword' }, '@timestamp': { type: 'date' }, secret: { type: 'long' } } } }, 'admin','', 'PUT').catch(e => { if (!e.message.includes('resource_already_exists')) throw e; });
for (const [id,department] of [[1,'operations'],[2,'finance']]) await request(`/br-companion-data/_doc/${id}?refresh=true`, { department, '@timestamp':'2026-09-20T12:00:00Z', secret:42 },'admin','', 'PUT');
const call = (op, body, user='report_owner', tenant='operations') => request(`/_plugins/_better_reports/${op}`, body, user, tenant);
const input = { reportId:'fixture', revision:1, fingerprint:'fixture-v1', from:'2026-09-20T00:00:00Z', to:'2026-09-21T00:00:00Z', panels:[{index:'br-companion-*', timeField:'@timestamp', body:{size:0, aggs:{hidden:{sum:{field:'secret'}}}}}] };
const grant = await call('authorize', input); assert.equal(grant.authorization,'until_revoked');
const run = {id:grant.id, fingerprint:input.fingerprint, from:input.from, to:input.to};
await assert.rejects(call('release',{id:grant.id,fingerprint:input.fingerprint},'betterreports_runner'),e=>e.status===403);
const temporary=await call('authorize',{...input,persistent:false,title:'One-off fixture'});
assert.ok(!(await call('list',{})).grants.some(g=>g.id===temporary.id),'One-off permissions stay out of the scheduling authorization list');
await call('release',{id:temporary.id,fingerprint:input.fingerprint},'betterreports_runner');
await assert.rejects(call('execute',{...run,id:temporary.id},'betterreports_runner'),e=>e.status===403);
const result = await call('execute',run,'betterreports_runner');
assert.equal(result.results[0].hits.total.value,1,'DLS applies to background queries');
assert.equal(result.results[0].aggregations.hidden.value,0,'FLS hides secret values');
const nextDay = await call('execute',{...run,from:'2026-09-21T00:00:00Z',to:'2026-09-22T00:00:00Z'},'betterreports_runner');
assert.equal(nextDay.results[0].hits.total.value,0,'Each execution uses its own reporting interval');
await assert.rejects(call('execute',run,'report_other'),e => e.status===403);
await assert.rejects(call('execute',{...run, username:'admin'},'betterreports_runner'), e => e.status===400);
await assert.rejects(call('execute',{...run, fingerprint:'changed'},'betterreports_runner'),e => e.status===403);
await assert.rejects(call('revoke',{id:grant.id},'report_other'),e => e.status===403);
await assert.rejects(call('check',{id:grant.id,fingerprint:input.fingerprint},'report_other'),e => e.status===403);
await assert.rejects(call('revoke',{id:grant.id},'report_owner','finance'),e => e.status===403);
await assert.rejects(request('/.better-reports-grants-v1/_search',{},'report_owner'),e => e.status===403);
await assert.rejects(request('/br-companion-data/_search',{},'betterreports_runner'),e => e.status===403);
// Removing membership does not cancel the deliberately durable grant.
await put('rolesmapping/companion_owner',{users:['report_other']});
try { const persisted = await call('execute',run,'betterreports_runner'); assert.equal(persisted.results[0].hits.total.value,1); }
finally { await put('rolesmapping/companion_owner',{users:['report_owner','report_other']}); }
// Permission definitions remain live even though membership is captured.
const currentRole = await request('/_plugins/_security/api/roles/companion_owner',undefined,'admin','','GET');
const role = currentRole.companion_owner;
delete role.reserved; delete role.hidden; delete role.static;
await put('roles/companion_owner',{...role,index_permissions:[{...role.index_permissions[0],dls:'{"term":{"department":"unavailable"}}'}]});
try { const restricted = await call('execute',run,'betterreports_runner'); assert.equal(restricted.results[0].hits.total.value,0,'Current role definitions apply'); }
finally { await put('roles/companion_owner',role); }
if (process.argv.includes('--restart')) {
  assert.equal(spawnSync('docker',['restart','betterreports-dev-opensearch-1'],{stdio:'inherit'}).status,0);
  let recovered = false;
  for (let i=0;i<120;i++) { try { const persisted=await call('execute',run,'betterreports_runner'); assert.equal(persisted.results[0].hits.total.value,1); recovered=true;break; } catch { await new Promise(r=>setTimeout(r,1000)); } }
  assert.ok(recovered,'Durable grant survives OpenSearch restart');
}
await call('revoke',{id:grant.id});
await assert.rejects(call('execute',run,'betterreports_runner'),e => e.status===403 && e.message.includes('GRANT_REVOKED'));
const managed = await call('authorize',input);
await put('roles/betterreports_tenant_manager',{cluster_permissions:['cluster:admin/betterreports/list','cluster:admin/betterreports/revoke'],index_permissions:[],tenant_permissions:[]});
await put('rolesmapping/betterreports_tenant_manager',{users:['report_other']});
try {
  assert.ok((await call('list',{},'report_other')).grants.some(g=>g.id===managed.id),'Tenant manager sees grants');
  await assert.rejects(call('revoke',{id:managed.id},'report_other','finance'),e=>e.status===403);
  const revoked=await call('revoke',{id:managed.id},'report_other');assert.equal(revoked.revoked,true);
  await assert.rejects(call('execute',{...run,id:managed.id},'betterreports_runner'),e=>e.status===403);
} finally { await put('rolesmapping/betterreports_tenant_manager',{users:[]}); }
await mkdir('output/integration',{recursive:true});
await writeFile('output/integration/companion.json',JSON.stringify({version:'3.8.0',grantId:grant.id,restartTested:process.argv.includes('--restart'),tests:['DLS','FLS','worker least privilege','tenant isolation','owner isolation','system index protection','query tampering','indefinite membership-independent grant','current role definitions','tenant manager revocation','revocation'],checkedAt:new Date().toISOString()},null,2));
console.log('PASS companion authorization, DLS/FLS, isolation, indefinite lifetime, and revocation.');
