// Real signed SAML assertion exchange against the disposable local cluster only.
import https from 'node:https';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { SignedXml } from 'xml-crypto';
const secrets = JSON.parse(await readFile('.platform/dev-secrets.json','utf8'));
const basic = user => `Basic ${Buffer.from(`${user}:${user==='admin'?secrets.admin:secrets.runner}`).toString('base64')}`;
function request(path,body,auth=basic('admin'),tenant='operations',method='POST') {
  return new Promise((resolve,reject)=> { const req=https.request({hostname:'127.0.0.1',port:19400,path,method,rejectUnauthorized:false,headers:{...(auth?{authorization:auth}:{}),securitytenant:tenant,'content-type':'application/json'}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>{let data;try{data=JSON.parse(text);}catch{data={message:text.slice(0,200)}}if(res.statusCode>=400)reject(Object.assign(new Error(`${path}: ${res.statusCode} ${JSON.stringify(data)}`),{status:res.statusCode}));else resolve(data);});});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body)); });
}
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const put=(path,body)=>request(`/_plugins/_security/api/${path}`,body,basic('admin'),'operations','PUT');
const original = await request('/_plugins/_security/api/securityconfig',undefined,basic('admin'),'operations','GET');
const cert=await readFile('.platform/dev-certs/server.crt','utf8'), key=await readFile('.platform/dev-certs/server.key','utf8');
const certificate=cert.replace(/-----[^-]+-----|\s/g,'');
const base='http://localhost:15601/br', acs=base+'/_opendistro/_security/saml/acs', issuer='urn:betterreports:fixture:idp', sp='urn:betterreports:fixture:sp';
const metadata=`<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${issuer}"><IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"><KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>${certificate}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></KeyDescriptor><SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="http://localhost:18081/saml"/></IDPSSODescriptor></EntityDescriptor>`;
async function apply(config) {
  await mkdir('.platform/saml',{recursive:true});
  await writeFile('.platform/saml/security-config.json',JSON.stringify({_meta:{type:'config',config_version:2},config:config.config??config}));
  for(const args of [['cp','.platform/saml/security-config.json','betterreports-dev-opensearch-1:/tmp/br-saml-config.json'],['exec','betterreports-dev-opensearch-1','bash','plugins/opensearch-security/tools/securityadmin.sh','-f','/tmp/br-saml-config.json','-t','config','-icl','-nhnv','-cacert','config/root-ca.pem','-cert','config/kirk.pem','-key','config/kirk-key.pem']]) {const p=spawnSync('docker',args,{encoding:'utf8'});if(p.status!==0)throw new Error(p.stderr||p.stdout);}
  await delay(1500);
}
const updated=structuredClone(original);
updated.config.dynamic.authc.basic_internal_auth_domain.http_authenticator.challenge=false;
updated.config.dynamic.authc.basic_internal_auth_domain.order=0;
updated.config.dynamic.authc.saml_fixture={http_enabled:true,transport_enabled:false,order:1,http_authenticator:{type:'saml',challenge:true,config:{idp:{metadata_content:metadata,entity_id:issuer},sp:{entity_id:sp},kibana_url:base,roles_key:'Role',exchange_key:randomBytes(48).toString('hex'),jwt:{expiry:'session',jwt_clock_skew_tolerance_seconds:0}}},authentication_backend:{type:'noop'}};
await put('roles/saml_reporting',{cluster_permissions:JSON.parse(await readFile('companion/roles.json','utf8')).betterreports_user.cluster_permissions,index_permissions:[{index_patterns:['br-fixture-*'],allowed_actions:['read'],dls:'{"term":{"environment":"production"}}'}],tenant_permissions:[{tenant_patterns:['operations'],allowed_actions:['kibana_all_read']}]});
await put('rolesmapping/saml_reporting',{backend_roles:['saml-reporters']});
function assertion(groups) {
 const now=new Date(), before=new Date(now-60000).toISOString(), after=new Date(+now+120000).toISOString(), instant=now.toISOString(), id='_br'+randomBytes(12).toString('hex');
 const xml=`<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="${id}r" Version="2.0" IssueInstant="${instant}" Destination="${acs}"><saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">${issuer}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status><saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}" Version="2.0" IssueInstant="${instant}"><saml:Issuer>${issuer}</saml:Issuer><saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified">saml_only_owner</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${after}" Recipient="${acs}"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${before}" NotOnOrAfter="${after}"><saml:AudienceRestriction><saml:Audience>${sp}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="${instant}" SessionIndex="${id}s" SessionNotOnOrAfter="${new Date(+now+10000).toISOString()}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement><saml:AttributeStatement><saml:Attribute Name="Role">${groups.map(g=>`<saml:AttributeValue>${g}</saml:AttributeValue>`).join('')}</saml:Attribute></saml:AttributeStatement></saml:Assertion></samlp:Response>`;
 const signer=new SignedXml({privateKey:key,publicCert:cert,signatureAlgorithm:'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',canonicalizationAlgorithm:'http://www.w3.org/2001/10/xml-exc-c14n#'});
 signer.addReference({xpath:"//*[local-name()='Assertion']",transforms:['http://www.w3.org/2000/09/xmldsig#enveloped-signature','http://www.w3.org/2001/10/xml-exc-c14n#'],digestAlgorithm:'http://www.w3.org/2001/04/xmlenc#sha256'});
 signer.computeSignature(xml,{location:{reference:"//*[local-name()='Assertion']/*[local-name()='Issuer']",action:'after'}});
 return Buffer.from(signer.getSignedXml()).toString('base64');
}
try {
 await request('/_plugins/_security/authinfo',undefined,basic('betterreports_runner'),'operations','GET');
 await apply(updated);
 await request('/_plugins/_security/authinfo',undefined,basic('betterreports_runner'),'operations','GET');
 const exchanged=await request('/_plugins/_security/api/authtoken',{SAMLResponse:assertion(['saml-reporters']),acsEndpoint:acs},null);
 const auth=exchanged.authorization;assert.ok(auth?.startsWith('bearer '),'SAML exchanged for signed JWT');
 const info=await request('/_plugins/_security/authinfo',undefined,auth,'operations','GET');assert.equal(info.user_name,'saml_only_owner');assert.ok(info.roles.includes('saml_reporting'));
 const payload={reportId:'saml-fixture',revision:1,fingerprint:'saml-fixture-1',from:'2026-09-20T00:00:00Z',to:'2026-09-21T00:00:00Z',panels:[{index:'br-fixture-*',timeField:'@timestamp',body:{size:0}}]};
 const grant=await request('/_plugins/_better_reports/authorize',payload,auth);
 await assert.rejects(request('/_plugins/_better_reports/authorize',payload,auth,'finance'),e=>e.status===403);
 await delay(12000);
 await assert.rejects(request('/_plugins/_security/authinfo',undefined,auth,'operations','GET'),e=>e.status===401);
 const result=await request('/_plugins/_better_reports/execute',{id:grant.id,fingerprint:payload.fingerprint,from:payload.from,to:payload.to},basic('betterreports_runner'));
 assert.equal(result.results[0].hits.total.value,13,'SAML owner DLS survives session expiry');
 const fixture=JSON.parse(await readFile('output/integration/results.json','utf8'));
 const baseline=(await (await fetch('http://127.0.0.1:18081')).json()).count;
 const delivered=await request('/_plugins/_better_reports/send',{id:grant.id,fingerprint:payload.fingerprint,senderId:fixture.senderId,recipientGroupIds:fixture.recipientGroupIds,subject:'SAML session expired report',message:'Synthetic fixture',runId:'saml-'+Date.now(),filename:'saml-report.pdf',pdf:(await readFile('output/integration/report.pdf')).toString('base64')},basic('betterreports_runner'));
 assert.equal(delivered.delivered,true);assert.equal((await (await fetch('http://127.0.0.1:18081')).json()).count,baseline+1);
 await request('/_plugins/_better_reports/revoke',{id:grant.id});
 await assert.rejects(request('/_plugins/_better_reports/execute',{id:grant.id,fingerprint:payload.fingerprint,from:payload.from,to:payload.to},basic('betterreports_runner')),e=>e.status===403);
 await writeFile('output/integration/saml.json',JSON.stringify({version:'3.8.0',signedAssertion:true,internalUserRequired:false,expiredSessionExecution:true,expiredSessionNotificationsDelivery:true,dlsCount:13,crossTenantDenied:true,revocation:true,checkedAt:new Date().toISOString()},null,2));
 console.log('PASS signed SAML group authorization, session expiry, Notifications attachment delivery, DLS, tenant isolation, and explicit revocation.');
} finally { await apply(original); }
