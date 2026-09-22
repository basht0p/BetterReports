import { Run, ReportError } from '../common/model';
import { GrantClient } from './grants';
export interface Mailer { send(run: Run, pdf: Buffer): Promise<void>; close?(): void; }
export class NotificationsMailer implements Mailer {
  constructor(private grants: GrantClient) {}
  async send(run: Run, pdf: Buffer) {
    if (!run.delivery) return;
    if (!run.delivery.senderId || !run.delivery.recipientGroupIds?.length) throw new ReportError('NOTIFICATIONS_REQUIRED', 'Edit this schedule and select a Notifications email sender and recipient groups.', 409);
    await this.grants.check(run.report);
    try {
      await this.grants.call('send', { id: run.report.grant!.id, fingerprint: run.report.grant!.fingerprint,
        ...run.delivery, runId: run.id, filename: run.report.title.replace(/[^\p{L}\p{N} _.-]/gu, '_').slice(0, 100) + '.pdf', pdf: pdf.toString('base64') });
    } catch (error: any) {
      // Notifications does not expose SMTP phase details. Never retry an uncertain send.
      if (error.message?.includes('NOTIFICATIONS_PREFLIGHT') || ['GRANT_REVOKED', 'GRANT_DENIED'].includes(error.code)) throw new ReportError('DELIVERY_REJECTED', error.message, error.status ?? 403);
      throw new ReportError('DELIVERY_UNKNOWN', 'Notifications did not confirm complete delivery. Check its event history before deliberately resending.', 502);
    }
  }
}
