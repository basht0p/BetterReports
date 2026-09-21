import { createHash } from 'crypto';
import { Report, ReportError } from '../common/model';

// Exact serialized input fingerprint binds a grant to its saved report revision.
export function grantFingerprint(report: Report) {
  const { grant, ...definition } = report;
  return createHash('sha256').update(JSON.stringify(definition)).digest('hex');
}
export class GrantClient {
  constructor(private core: any, private credentials: { username: string; password: string }) {}
  async call(operation: string, body: any, request?: any) {
    if (!request && (!this.credentials.username || !this.credentials.password)) throw new ReportError('WORKER_NOT_CONFIGURED', 'Configure the BetterReports worker identity.', 503);
    const scoped = request ?? { headers: { authorization: `Basic ${Buffer.from(`${this.credentials.username}:${this.credentials.password}`).toString('base64')}` }, url: new URL('http://betterreports.internal/'), route: { options: {} } };
    try {
      const result = await this.core.opensearch.client.asScoped(scoped).asCurrentUser.transport.request({ method: 'POST', path: `/_plugins/_better_reports/${operation}`, body }); return result.body;
    } catch (error: any) {
      const status = error?.meta?.statusCode ?? 503;
      const message = error?.meta?.body?.error?.reason ?? error?.message ?? 'Companion plugin request failed';
      throw new ReportError(message.includes('GRANT_REVOKED') ? 'GRANT_REVOKED' : status === 403 ? 'GRANT_DENIED' : 'COMPANION_UNAVAILABLE', message, status, status >= 500);
    }
  }
  async check(report: Report) {
    if (!report.grant) throw new ReportError('GRANT_REQUIRED', 'Authorize this report revision before scheduling it.', 409);
    const fingerprint = grantFingerprint(report);
    if (fingerprint !== report.grant.fingerprint) throw new ReportError('GRANT_STALE', 'The report changed. Authorize this revision again.', 409);
    return this.call('check', { id: report.grant.id, fingerprint });
  }
}
