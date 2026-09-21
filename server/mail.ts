import nodemailer from 'nodemailer';
import { Run, ReportError } from '../common/model';

export interface Mailer { send(run: Run, pdf: Buffer): Promise<void>; close?(): void; }
export class SmtpMailer implements Mailer {
  private transport: ReturnType<typeof nodemailer.createTransport>;
  constructor(private config: { host: string; port: number; secure: boolean; username: string; password: string; from: string }) {
    this.transport = nodemailer.createTransport({ host: config.host, port: config.port, secure: config.secure,
      requireTLS: !config.secure, auth: config.username ? { user: config.username, pass: config.password } : undefined,
      tls: { rejectUnauthorized: true }, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 60000,
      disableFileAccess: true, disableUrlAccess: true });
  }
  async send(run: Run, pdf: Buffer) {
    if (!run.delivery) return;
    if (!this.config.host || !this.config.from) throw new ReportError('SMTP_NOT_CONFIGURED', 'Configure an SMTP relay and sender.', 503);
    try {
      const result = await this.transport.sendMail({ from: this.config.from, to: run.delivery.recipients,
        subject: run.delivery.subject, text: run.delivery.message,
        messageId: `<${run.id}@betterreports.local>`,
        attachments: [{ filename: `${run.report.title.replace(/[^\p{L}\p{N} _.-]/gu, '_').slice(0, 100)}.pdf`, content: pdf, contentType: 'application/pdf' }] });
      if (result.rejected?.length) throw new ReportError('DELIVERY_UNKNOWN', 'The relay accepted only some recipients. Review delivery before resending.', 502);
    } catch (error: any) {
      if (error instanceof ReportError) throw error;
      const command = String(error.command ?? '');
      const definite = ['CONN', 'AUTH', 'MAIL FROM', 'RCPT TO'].some(value => command.startsWith(value)) || Number(error.responseCode) >= 400;
      if (!definite) throw new ReportError('DELIVERY_UNKNOWN', 'The connection ended without a definitive delivery result. Review delivery before resending.', 502);
      throw new ReportError('SMTP_FAILED', 'The SMTP relay did not accept the message.', 502, Number(error.responseCode) < 500 || !error.responseCode);
    }
  }
  close() { this.transport.close(); }
}
