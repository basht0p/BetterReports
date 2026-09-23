import { randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { schema } from '@osd/config-schema';
import { z } from 'zod';
import { Artifact, assertOwner, Identity, Report, ReportError, Run, safeError, Schedule, scheduleSchema } from '../common/model';
import { PlatformAdapter } from './platform';
import { Runner } from './runner';
import { Store, required } from './store';
import { validateReport } from './sources';
import { nextOccurrence, validateCron } from './time';

export interface Services { store: Store; runner: Runner; platform: PlatformAdapter; adminRoles: string[]; }
export function registerRoutes(router: any, ready: () => Promise<Services>, log: (message: string) => void) {
  const idParams = schema.object({ id: schema.string({ minLength: 1, maxLength: 1000 }) });
  const add = (method: string, path: string, handler: (s: Services, request: any, actor: Identity) => Promise<any>, options: { binary?: boolean; admin?: boolean } = {}) => {
    router[method]({ path: `/api/better_reports${path}`, validate: { params: path.includes('{id}') ? idParams : schema.object({}), query: schema.any(), ...(method === 'post' || method === 'put' ? { body: schema.any() } : {}) }, options: { body: { maxBytes: 5 * 1024 * 1024 } } }, async (_context: any, request: any, response: any) => {
      try {
        const services = await ready(), actor = await services.platform.identity(request);
        if (options.admin && !await services.platform.isAdmin(request, services.adminRoles)) throw new ReportError('FORBIDDEN', 'Administrator permission is required.', 403);
        const result = await handler(services, request, actor);
        if (options.binary) return response.ok({ body: result.body, headers: { 'content-type': result.type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...(result.disposition ? { 'content-disposition': result.disposition } : {}) } });
        return response.ok({ body: result ?? { ok: true }, headers: { 'cache-control': 'no-store' } });
      } catch (error) {
        if (error instanceof z.ZodError) return response.customError({ statusCode: 400, body: { message: error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '), attributes: { code: 'VALIDATION_FAILED' } } });
        const detail = safeError(error); log(`route=${method} ${path} code=${detail.code} ${String((error as any)?.stack ?? '').split('\n').filter(line => /^\s+at /.test(line)).slice(0, 4).join(' | ')}`);
        return response.customError({ statusCode: error instanceof ReportError ? error.status : 500, body: { message: detail.message, attributes: { code: detail.code } } });
      }
    });
  };
  const ownerRecord = async <T extends Identity>(s: Services, collection: 'reports' | 'runs' | 'schedules', id: string, actor: Identity) => { const record = await required<T>(s.store, collection, id); assertOwner(record.value, actor); return record; };
  const ownedList = async (s: Services, collection: 'reports' | 'runs' | 'schedules', actor: Identity) => (await s.store.list<any>(collection, actor)).map(r => r.value);
  const reportRecord = async (s: Services, id: string, actor: Identity) => {
    const record = await required<Report>(s.store, 'reports', id);
    if (record.value.tenant !== actor.tenant || (actor.tenant === '__user__' && record.value.owner !== actor.owner)) throw new ReportError('NOT_FOUND', 'Record not found.', 404);
    return record;
  };
  const writable = async (s: Services, r: any) => {
    const context = await s.platform.context(r, s.adminRoles);
    if (!context.canWrite) throw new ReportError('TENANT_READ_ONLY', 'Write access to this tenant is required.', 403);
    return context;
  };
  const reportForPeer = (report: Report, actor: Identity) => report.grant && (report.grant.authorizedBy ?? report.owner) !== actor.owner ? { ...report, grant: undefined } : report;
  const pauseSchedules = async (s: Services, report: Report) => {
    for (const schedule of await s.store.list<Schedule>('schedules', { reportId: report.id, tenant: report.tenant, enabled: true })) {
      if (!await s.store.replace('schedules', schedule.value.id, { ...schedule.value, enabled: false, revision: schedule.value.revision + 1, updatedAt: new Date().toISOString() }, schedule)) {
        const latest = await s.store.get<Schedule>('schedules', schedule.value.id);
        if (latest?.value.enabled) throw new ReportError('CONFLICT', 'A linked schedule changed. Retry the report change.', 409);
      }
    }
  };
  const invalidate = async (s: Services, report: Report) => {
    if (report.grant) await s.platform.grants.call('invalidate', { id: report.grant.id, fingerprint: report.grant.fingerprint });
    await pauseSchedules(s, report);
  };
  const revision = (received: unknown, current: number) => { if (received !== current) throw new ReportError('CONFLICT', 'The record changed. Reload it before saving.', 409); };
  add('get', '/sources', async (s, r) => s.platform.sources(r).discover(z.string().max(200).parse(r.query.search ?? ''), z.coerce.number().int().min(1).max(1000).parse(r.query.page ?? 1)));
  add('post', '/sources/import', async (s, r) => { const input = z.object({ type: z.enum(['dashboard', 'visualization']), id: z.string().min(1).max(1000) }).strict().parse(r.body); return s.platform.sources(r).import(input.type, input.id); });
  add('get', '/context', async (s, r) => s.platform.context(r, s.adminRoles));
  add('get', '/reports', async (s, r, actor) => {
    const context = await s.platform.context(r, s.adminRoles);
    const reports = await s.store.list<Report>('reports', context.allTenants ? {} : actor.tenant === '__user__' ? actor : { tenant: actor.tenant });
    return reports.map(({ value: report }) => {
      const requiresTenantSwitch = report.tenant !== actor.tenant || (report.tenant === '__user__' && report.owner !== actor.owner);
      const canWrite = !requiresTenantSwitch && context.canWrite;
      return { id: report.id, title: report.title, revision: report.revision, updatedAt: report.updatedAt, tenant: report.tenant, owner: report.owner,
        branding: { organization: report.branding.organization, logo: report.branding.logo, color: report.branding.color },
        canEdit: canWrite, canRun: !requiresTenantSwitch, canClone: canWrite, requiresTenantSwitch };
    });
  });
  add('get', '/reports/{id}', async (s, r, actor) => reportForPeer((await reportRecord(s, r.params.id, actor)).value, actor));
  add('post', '/reports/{id}/authorize', async (s, r, actor) => {
    await writable(s, r);
    const current = await reportRecord(s, r.params.id, actor); revision(r.body.revision, current.value.revision);
    const report = await s.platform.createGrant(current.value, r, true);
    try { await invalidate(s, current.value); }
    catch (error) { await s.platform.grants.call('invalidate', { id: report.grant!.id, fingerprint: report.grant!.fingerprint }); throw error; }
    if (!await s.store.replace('reports', report.id, report, current)) { await s.platform.grants.call('invalidate', { id: report.grant!.id, fingerprint: report.grant!.fingerprint }); throw new ReportError('CONFLICT', 'The report changed. Reload and authorize again.', 409); }
    return report;
  });
  add('get', '/grants', async (s, r) => s.platform.grants.call('list', {}, r));
  add('post', '/grants/{id}/revoke', async (s, r) => {
    const grant = await s.platform.grants.call('revoke', { id: r.params.id }, r);
    for (const schedule of await s.store.list<Schedule>('schedules', { owner: grant.owner, tenant: grant.tenant, reportId: grant.reportId })) {
      const report = await s.store.get<Report>('reports', schedule.value.reportId);
      if (report?.value.grant?.id === grant.id) await s.store.replace('schedules', schedule.value.id, { ...schedule.value, enabled: false, revision: schedule.value.revision + 1 }, schedule);
    }
    return grant;
  });
  add('post', '/reports', async (s, r, actor) => {
    await writable(s, r);
    const input = validateReport(r.body); await s.platform.sources(r).authorize(input.sources);
    const report: Report = { ...input, ...actor, id: randomUUID(), revision: 1, schemaVersion: 1, updatedAt: new Date().toISOString() };
    await s.store.create('reports', report.id, report); return report;
  });
  add('post', '/reports/{id}/clone', async (s, r, actor) => {
    await writable(s, r);
    const current = await reportRecord(s, r.params.id, actor); revision(r.body.revision, current.value.revision);
    const { id, owner, tenant, revision: _revision, schemaVersion, updatedAt, grant, ...definition } = current.value;
    const title = `${definition.title.slice(0, 193)} (copy)`;
    const input = validateReport({ ...definition, title });
    await s.platform.sources(r).authorize(input.sources);
    const clone: Report = { ...input, ...actor, id: randomUUID(), revision: 1, schemaVersion: 1, updatedAt: new Date().toISOString() };
    await s.store.create('reports', clone.id, clone);
    return clone;
  });
  add('put', '/reports/{id}', async (s, r, actor) => {
    await writable(s, r);
    const current = await reportRecord(s, r.params.id, actor); revision(r.body.revision, current.value.revision);
    const input = validateReport(r.body.report); await s.platform.sources(r).authorize(input.sources);
    const report: Report = { ...current.value, ...input, grant: undefined, revision: current.value.revision + 1, updatedAt: new Date().toISOString() };
    await invalidate(s, current.value);
    if (!await s.store.replace('reports', report.id, report, current)) throw new ReportError('CONFLICT', 'The report changed. Reload and retry.', 409); return report;
  });
  add('delete', '/reports/{id}', async (s, r, actor) => {
    await writable(s, r);
    const current = await reportRecord(s, r.params.id, actor);
    await invalidate(s, current.value);
    if (!await s.store.remove('reports', r.params.id, current)) throw new ReportError('CONFLICT', 'The report changed. Reload and retry.', 409);
  });
  add('post', '/reports/{id}/refresh', async (s, r, actor) => {
    await writable(s, r);
    const current = await reportRecord(s, r.params.id, actor); revision(r.body.revision, current.value.revision);
    const sources = [];
    for (const old of current.value.sources) {
      const results = await s.platform.sources(r).import(old.importRef.type as 'dashboard' | 'visualization', old.importRef.id, old.panelId);
      const replacement = results[0]; if (!replacement?.source || replacement.error) throw new ReportError(replacement?.error?.code ?? 'SOURCE_UNAVAILABLE', replacement?.error?.message ?? 'The source is unavailable.');
      sources.push({ ...replacement.source, key: old.key });
    }
    const report = { ...current.value, sources, grant: undefined, revision: current.value.revision + 1, updatedAt: new Date().toISOString() };
    await invalidate(s, current.value);
    if (!await s.store.replace('reports', report.id, report, current)) throw new ReportError('CONFLICT', 'The report changed. Reload and retry.', 409); return report;
  });
  add('post', '/preview', async (s, r, actor) => {
    const input = validateReport(r.body); const report: Report = { ...input, ...actor, id: randomUUID(), revision: 0, schemaVersion: 1, updatedAt: new Date().toISOString() };
    const authorized = await s.platform.createGrant(report, r); const runId = await s.runner.enqueue(authorized, 'preview', new Date(), undefined, undefined, r); void s.runner.tick(); return { runId };
  });
  add('post', '/reports/{id}/runs', async (s, r, actor) => {
    let report = (await reportRecord(s, r.params.id, actor)).value; await s.platform.authorize(report, r);
    report = await s.platform.createGrant({ ...report, grant: undefined }, r);
    const runId = await s.runner.enqueue(report, 'manual', new Date(), undefined, undefined, r, actor.owner); void s.runner.tick(); return { runId };
  });
  add('get', '/runs', async (s, _r, actor) => (await ownedList(s, 'runs', actor)).map(({ report, ...run }) => ({ ...run, title: report.title, revision: report.revision })).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  add('get', '/runs/{id}', async (s, r, actor) => { const { report, ...run } = (await ownerRecord<Run>(s, 'runs', r.params.id, actor)).value; return { ...run, title: report.title, revision: report.revision }; });
  add('post', '/runs/{id}/cancel', async (s, r, actor) => s.runner.cancel(r.params.id, actor));
  add('get', '/runs/{id}/pdf', async (s, r, actor) => {
    const run = (await ownerRecord<Run>(s, 'runs', r.params.id, actor)).value;
    if (!run.artifactId || !['complete', 'delivery_unknown', 'failed'].includes(run.status)) throw new ReportError('NOT_READY', 'This report does not have a completed PDF.', 409);
    const artifact = await required<Artifact>(s.store, 'artifacts', run.artifactId); assertOwner(artifact.value, actor);
    if (Date.parse(artifact.value.expiresAt) <= Date.now()) throw new ReportError('ARTIFACT_EXPIRED', 'This report has expired. Generate a new report.', 410);
    await s.platform.authorize(run.report, r);
    if (r.query.encoding === 'base64') return { body: JSON.stringify({ pdf: artifact.value.pdf, sha256: artifact.value.sha256 }), type: 'application/json' };
    return { body: Buffer.from(artifact.value.pdf, 'base64'), type: 'application/pdf', disposition: `inline; filename="BetterReports-${run.id}.pdf"` };
  }, { binary: true });
  add('get', '/pdf.worker.min.mjs', async () => ({ body: await readFile(join(__dirname, '../public/assets/pdf.worker.min.mjs')), type: 'text/javascript' }), { binary: true });
  add('post', '/schedules/next', async (_s, r) => {
    const input = z.object({ cron: z.string(), timezone: z.string() }).strict().parse(r.body); validateCron(input.cron, input.timezone);
    const dates = []; let date = new Date(); let key: string | undefined;
    const { localKey } = await import('./time');
    for (let i = 0; i < 5; i++) { date = nextOccurrence(input.cron, input.timezone, date, key); key = localKey(date, input.timezone); dates.push(date.toISOString()); } return dates;
  });
  add('get', '/notification-options', (s, r) => s.platform.grants.call('notifications', {}, r));
  add('get', '/schedules', (s, _r, actor) => ownedList(s, 'schedules', actor));
  for (const method of ['post', 'put']) add(method, method === 'post' ? '/schedules' : '/schedules/{id}', async (s, r, actor) => {
    const input = scheduleSchema.parse(method === 'post' ? r.body : r.body.schedule); validateCron(input.cron, input.timezone);
    const report = await reportRecord(s, input.reportId, actor);
    if (input.enabled) {
      if ((report.value.grant?.authorizedBy ?? report.value.owner) !== actor.owner) throw new ReportError('FORBIDDEN', 'Authorize this report yourself before enabling a schedule.', 403);
      await s.platform.grants.check(report.value);
    }
    await s.platform.grants.call('notifications', { senderId: input.senderId, recipientGroupIds: input.recipientGroupIds }, r);
    const current = method === 'put' ? await ownerRecord<Schedule>(s, 'schedules', r.params.id, actor) : undefined;
    if (current) revision(r.body.revision, current.value.revision);
    if (input.enabled && !current?.value.enabled && (await s.store.list<Schedule>('schedules', { enabled: true })).length >= s.runner.limits.schedules) throw new ReportError('SCHEDULE_LIMIT', 'The configured active-schedule limit has been reached.');
    const schedule: Schedule = { ...input, ...actor, id: current?.value.id ?? randomUUID(), revision: (current?.value.revision ?? 0) + 1,
      nextAt: nextOccurrence(input.cron, input.timezone, new Date()).toISOString(), skipped: current?.value.skipped ?? 0, updatedAt: new Date().toISOString() };
    if (current) { if (!await s.store.replace('schedules', schedule.id, schedule, current)) throw new ReportError('CONFLICT', 'The schedule changed. Reload and retry.', 409); }
    else await s.store.create('schedules', schedule.id, schedule);
    return schedule;
  });
  add('delete', '/schedules/{id}', async (s, r, actor) => { const current = await ownerRecord<Schedule>(s, 'schedules', r.params.id, actor); if (!await s.store.remove('schedules', r.params.id, current)) throw new ReportError('CONFLICT', 'The schedule changed.', 409); });
  add('post', '/schedules/{id}/run', async (s, r, actor) => {
    const schedule = (await ownerRecord<Schedule>(s, 'schedules', r.params.id, actor)).value;
    const report = (await reportRecord(s, schedule.reportId, actor)).value;
    if ((report.grant?.authorizedBy ?? report.owner) !== actor.owner) throw new ReportError('FORBIDDEN', 'Authorize this report yourself before testing a schedule.', 403);
    await s.platform.authorize(report, r); await s.platform.grants.check(report); const runId = await s.runner.enqueue(report, 'test', new Date(), { senderId: schedule.senderId, recipientGroupIds: schedule.recipientGroupIds, subject: schedule.subject, message: schedule.message }, undefined, r, actor.owner); void s.runner.tick(); return { runId };
  });
  add('get', '/health', async s => ({ ...s.runner.health, limits: s.runner.limits }), { admin: true });
  add('get', '/admin/schedules', async s => (await s.store.list<Schedule>('schedules')).map(({ value: { id, owner, tenant, enabled, nextAt, skipped, revision } }) => ({ id, owner, tenant, enabled, nextAt, skipped, revision })), { admin: true });
  add('post', '/admin/schedules/{id}/pause', async (s, r) => { const current = await required<Schedule>(s.store, 'schedules', r.params.id); if (!await s.store.replace('schedules', r.params.id, { ...current.value, enabled: false, revision: current.value.revision + 1 }, current)) throw new ReportError('CONFLICT', 'The schedule changed.', 409); }, { admin: true });
}
