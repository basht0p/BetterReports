// Disposable local fixture only. Run integration.mjs first; do not run alongside the workload test.
import http from 'node:http';
import https from 'node:https';
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const secrets = JSON.parse(await readFile('.platform/dev-secrets.json', 'utf8'));
const fixture = JSON.parse(await readFile('output/integration/results.json', 'utf8'));
function request(os, path, method = 'GET', body) {
  const auth = os && method === 'PUT' ? 'admin:' + secrets.admin : 'report_owner:' + secrets.owner;
  return new Promise((resolve, reject) => {
    const req = (os ? https : http).request({ hostname: '127.0.0.1', port: os ? 19400 : 15601,
      path: os ? '/_plugins/_notifications/configs' + path : '/br/api/better_reports' + path, method, rejectUnauthorized: false,
      headers: { authorization: 'Basic ' + Buffer.from(auth).toString('base64'), securitytenant: 'operations', 'osd-xsrf': 'fixture', 'content-type': 'application/json' } }, res => {
      let text = ''; res.on('data', chunk => text += chunk); res.on('end', () => { const data = text ? JSON.parse(text) : {}; res.statusCode < 300 ? resolve(data) : reject(new Error(JSON.stringify(data))); });
    }); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const sender = (await request(true, '/' + fixture.senderId)).config_list[0].config;
const groupId = fixture.recipientGroupIds[0], group = (await request(true, '/' + groupId)).config_list[0].config;
const schedule = await request(false, '/schedules', 'POST', { reportId: fixture.reportId, cron: '0 0 1 1 *', timezone: 'UTC', enabled: false,
  senderId: fixture.senderId, recipientGroupIds: fixture.recipientGroupIds, subject: 'Notifications live membership fixture', message: 'Synthetic PDF' });
async function run() {
  const { runId } = await request(false, '/schedules/' + schedule.id + '/run', 'POST', {});
  for (let i = 0; i < 90; i++) {
    const value = await request(false, '/runs/' + runId);
    if (['complete', 'failed', 'delivery_unknown'].includes(value.status)) return value;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('Delivery fixture timed out');
}
const mail = async () => (await (await fetch('http://127.0.0.1:18081')).json());
try {
  await request(true, '/' + groupId, 'PUT', { config: { ...group, email_group: { recipient_list: [{ recipient: 'updated-group@example.test' }] } } });
  const baseline = (await mail()).count;
  assert.equal((await run()).status, 'complete');
  const delivered = await mail(); assert.equal(delivered.count, baseline + 1);
  assert.match(delivered.messages.at(-1), /To: updated-group@example.test/i);
  assert.match(delivered.messages.at(-1), /application\/pdf/);
  await request(true, '/' + fixture.senderId, 'PUT', { config: { ...sender, is_enabled: false } });
  const rejected = await run(); assert.equal(rejected.status, 'failed'); assert.equal(rejected.error.code, 'DELIVERY_REJECTED');
  assert.equal((await mail()).count, baseline + 1);
  const remaining = await request(true, '?config_type=email&max_items=100');
  assert.ok(!remaining.config_list.some(item => item.config.name.startsWith('BetterReports delivery ')), 'Temporary channels should be removed');
  await writeFile('output/integration/notifications.json', JSON.stringify({ version: '0.0.2', freshGroupMembership: true, disabledSenderRejectedBeforeSend: true, temporaryChannelCleanup: true, checkedAt: new Date().toISOString() }, null, 2));
  console.log('PASS: live group membership, disabled sender rejection, PDF attachment, and temporary-channel cleanup.');
} finally {
  await request(true, '/' + fixture.senderId, 'PUT', { config: sender });
  await request(true, '/' + groupId, 'PUT', { config: group });
  await request(false, '/schedules/' + schedule.id, 'DELETE');
}
