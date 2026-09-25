import { readFile, writeFile } from 'node:fs/promises';
import http from 'node:http'; import https from 'node:https'; import assert from 'node:assert/strict';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
const secrets = JSON.parse(await readFile('.platform/dev-secrets.json', 'utf8'));
const fixture = JSON.parse(await readFile('output/integration/results.json', 'utf8'));
const request = (service,path,method='GET',body,user='report_other') => new Promise((resolve,reject)=>{
 const password=user==='admin'?secrets.admin:secrets.other;
 const req=(service==='os'?https:http).request({hostname:'127.0.0.1',port:service==='os'?19400:15601,path:service==='os'?path:'/br'+path,method,rejectUnauthorized:false,headers:{authorization:`Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`,securitytenant:'operations','osd-xsrf':'fls-fixture','content-type':'application/json'}},res=>{let s='';res.on('data',c=>s+=c);res.on('end',()=>{const d=JSON.parse(s);res.statusCode>=400?reject(new Error(JSON.stringify(d))):resolve(d);});});req.on('error',reject);if(body)req.write(JSON.stringify(body));req.end();
});
const put=(path,body)=>request('os','/_plugins/_security/api/'+path,'PUT',body,'admin');
await put('roles/betterreports_fls_fixture',{cluster_permissions:['cluster_composite_ops'],index_permissions:[{index_patterns:['br-fixture-*'],allowed_actions:['read','indices:admin/mappings/get'],fls:['@timestamp','environment','organization.name'],dls:JSON.stringify({term:{environment:'production'}})}],tenant_permissions:[{tenant_patterns:['operations'],allowed_actions:['kibana_all_read']}]});
await put('rolesmapping/betterreports_fls_fixture',{users:['report_other']});
await put('rolesmapping/betterreports_fixture',{users:['report_owner']});
try {
 const raw=await request('os','/br-fixture-data/_search','POST',{size:1});assert.equal(raw.hits.hits[0]._source.bytes,undefined);
 const sources=await request('osd','/api/better_reports/sources/import','POST',{type:'visualization',id:'br-fixture-metric'}); assert.ok(sources[0].source);
 const source=sources[0].source;
 const report={title:'FLS fixture',timezone:'UTC',timeRange:{from:'2026-09-19T00:00:00Z',to:'2026-09-21T00:00:00Z'},query:{language:'kuery',query:''},filters:[],branding:{organization:'FLS fixture'},sources:[source],sections:[{id:'sum',kind:'panels',columns:1,sources:[source.key]}]};
 const queued=await request('osd','/api/better_reports/preview','POST',report);
 let run;for(let i=0;i<90;i++){run=await request('osd',`/api/better_reports/runs/${queued.runId}`);if(['complete','failed'].includes(run.status))break;await new Promise(r=>setTimeout(r,2000));}
 assert.ok(['complete','failed'].includes(run.status));let result;
 if(run.status==='complete'){const artifact=await request('osd',`/api/better_reports/runs/${run.id}/pdf?encoding=base64`);const doc=await getDocument({data:new Uint8Array(Buffer.from(artifact.pdf,'base64')),isEvalSupported:false}).promise;const text=(await (await doc.getPage(1)).getTextContent()).items.map(i=>i.str).join(' ').replace(/\s+/g,' ');assert.ok(!/7,?800/.test(text));assert.match(text,/Sum of bytes 0/);await doc.destroy();result='Restricted field returned zero, matching OpenSearch aggregation semantics';}
 else {assert.ok(['PERMISSION_DENIED','INVALID_QUERY'].includes(run.error.code),JSON.stringify(run.error));result=run.error.code;}
 await writeFile('output/integration/fls.json',JSON.stringify({runId:run.id,status:run.status,result,checkedAt:new Date().toISOString()},null,2));console.log('PASS: field-level restrictions are applied to report queries.');
} finally {await put('rolesmapping/betterreports_fixture',{users:['report_owner','report_other']});await put('rolesmapping/betterreports_fls_fixture',{users:[]});}
