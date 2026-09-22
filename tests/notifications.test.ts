import test from 'node:test';
import assert from 'node:assert/strict';
import { NotificationsMailer } from '../server/mail';
import { ReportError, Run, scheduleSchema } from '../common/model';
import { report } from './fixtures';

const run = { id: 'run', report: { ...report, grant: { id: 'grant', fingerprint: 'hash' } }, delivery: { senderId: 'sender', recipientGroupIds: ['group'], subject: 'Report', message: 'Attached' } } as Run;
test('Notifications delivery binds the attachment and configured IDs to the protected report grant', async () => {
  let captured: any;
  const mailer = new NotificationsMailer({ check: async () => {}, call: async (op: string, body: any) => { captured = { op, body }; } } as any);
  await mailer.send(run, Buffer.from('%PDF-1.7 fixture'));
  assert.equal(captured.op, 'send'); assert.equal(captured.body.id, 'grant'); assert.equal(captured.body.fingerprint, 'hash');
  assert.equal(captured.body.senderId, 'sender'); assert.deepEqual(captured.body.recipientGroupIds, ['group']);
  assert.equal(Buffer.from(captured.body.pdf, 'base64').toString(), '%PDF-1.7 fixture');
  assert.equal(captured.body.runId, run.id); assert.ok(!('recipients' in captured.body));
});
test('Notifications preflight refusal is definitive; dispatch failures remain unknown', async () => {
  for (const [message, expected] of [['NOTIFICATIONS_PREFLIGHT: disabled sender', 'DELIVERY_REJECTED'], ['Timeout after dispatch', 'DELIVERY_UNKNOWN']]) {
    const mailer = new NotificationsMailer({ check: async () => {}, call: async () => { throw new ReportError('COMPANION_UNAVAILABLE', message, 503, true); } } as any);
    await assert.rejects(mailer.send(run, Buffer.from('%PDF')), (e: ReportError) => e.code === expected && !e.retryable);
  }
});
test('legacy SMTP schedules cannot dispatch or pass the new schedule API', async () => {
  let called = false;
  const mailer = new NotificationsMailer({ check: async () => { called = true; } } as any);
  await assert.rejects(mailer.send({ ...run, delivery: { recipients: ['old@example.test'] } } as any, Buffer.from('%PDF')), (e: ReportError) => e.code === 'NOTIFICATIONS_REQUIRED');
  assert.equal(called, false);
  assert.equal(scheduleSchema.safeParse({ reportId: report.id, cron: '* * * * *', timezone: 'UTC', enabled: true, recipients: ['old@example.test'], subject: 'Legacy', message: '' }).success, false);
});
