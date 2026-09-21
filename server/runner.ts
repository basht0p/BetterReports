import { createHash, randomUUID } from 'crypto';
import { Artifact, defaultLimits, Identity, Limits, PanelData, Report, ReportError, Run, safeError, Schedule } from '../common/model';
import { Mailer } from './mail';
import { Store, required, Versioned } from './store';
import { latestDue, localKey, resolveRange } from './time';

export interface Executor { execute(run: Run, signal: AbortSignal, request?: any): Promise<PanelData[]>; authorize(report: Report, request?: any): Promise<any>; release?(run: Run): Promise<void>; }
export type Renderer = (run: Run, panels: PanelData[], limits: Limits, signal: AbortSignal) => Promise<{ pdf: Buffer; pages: number }>;
export class Runner {
  readonly id = randomUUID();
  readonly requests = new Map<string, any>();
  private active = new Map<string, AbortController>();
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private stopped = false;
  private lastCleanup = 0;
  private lastGrantCleanup = 0;
  health = { heartbeat: '', active: 0, failures: 0, completed: 0, deliveryUnknown: 0, lastDurationMs: 0, queueDepth: 0, lastError: '' };
  constructor(private store: Store, private executor: Executor, private render: Renderer, private mailer: Mailer, readonly limits: Limits = defaultLimits, private log: (message: string) => void = () => {}) {}
  async enqueue(report: Report, trigger: Run['trigger'], scheduledAt = new Date(), delivery?: Run['delivery'], scheduleId?: string, request?: any) {
    const id = scheduleId ? createHash('sha256').update(`${scheduleId}:${scheduledAt.toISOString()}`).digest('hex') : randomUUID();
    const createdAt = new Date().toISOString();
    const run: Run = { id, report: structuredClone(report), owner: report.owner, tenant: report.tenant, trigger, scheduleId, scheduledAt: scheduledAt.toISOString(), createdAt,
      expiresAt: new Date(Date.now() + this.limits.historyDays * 86400000).toISOString(), ...resolveRange(report.timeRange, scheduledAt, report.timezone),
      status: 'queued', attempt: 0, fence: 0, delivery };
    if (request) this.requests.set(id, request);
    await this.store.create('runs', id, run);
    return id;
  }
  start() { this.stopped = false; this.timer = setInterval(() => void this.tick(), 5000); void this.tick(); }
  stop() { this.stopped = true; if (this.timer) clearInterval(this.timer); for (const controller of this.active.values()) controller.abort(); this.requests.clear(); this.mailer.close?.(); }
  async tick(now = new Date()) {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      this.health.heartbeat = now.toISOString();
      await this.schedule(now);
      if (this.stopped) return;
      const jobs = await this.store.list<Run>('runs', { status: ['queued', 'running', 'sending'] });
      const pending = new Set(jobs.map(job => job.value.id));
      for (const id of this.requests.keys()) if (!pending.has(id) && !this.active.has(id)) this.requests.delete(id);
      this.health.queueDepth = jobs.filter(j => j.value.status === 'queued').length;
      for (const version of jobs.sort((a, b) => a.value.createdAt.localeCompare(b.value.createdAt))) {
        if (this.stopped) break;
        const run = version.value;
        if (run.status === 'sending' && Date.parse(run.leaseUntil ?? '') <= now.getTime()) {
          if (await this.store.replace('runs', run.id, { ...run, status: 'delivery_unknown', error: { code: 'DELIVERY_UNKNOWN', message: 'The sender stopped before recording the relay result. Review delivery before resending.' }, finishedAt: now.toISOString() }, version)) await this.release(run);
          continue;
        }
        const eligible = run.status === 'queued' || (run.status === 'running' && Date.parse(run.leaseUntil ?? '') <= now.getTime());
        if (!eligible || this.active.has(run.id) || (run.nextAttemptAt && Date.parse(run.nextAttemptAt) > now.getTime()) || this.active.size >= this.limits.concurrency) continue;
        if (run.attempt >= 3) { if (await this.store.replace('runs', run.id, { ...run, status: 'failed', error: { code: 'RETRIES_EXHAUSTED', message: 'Three generation attempts failed.' }, finishedAt: now.toISOString() }, version)) await this.release(run); continue; }
        const claimed: Run = { ...run, status: 'running', worker: this.id, fence: run.fence + 1, attempt: run.attempt + 1, leaseUntil: new Date(now.getTime() + 60000).toISOString(), error: undefined };
        if (await this.store.replace('runs', run.id, claimed, version)) {
          if (this.stopped) break;
          const controller = new AbortController(); this.active.set(run.id, controller);
          void this.process(claimed, controller).finally(() => { this.active.delete(run.id); this.requests.delete(run.id); this.health.active = this.active.size; });
        }
      }
      this.health.active = this.active.size;
      if (now.getTime() - this.lastGrantCleanup > 60000) {
        this.lastGrantCleanup = now.getTime();
        for (const record of await this.store.list<Run>('runs', { status: ['complete', 'failed', 'cancelled', 'delivery_unknown'] })) {
          if (record.value.report.grant?.temporary && !record.value.grantReleased) await this.release(record.value);
        }
      }
      if (now.getTime() - this.lastCleanup > 3600000) { await this.store.cleanup(now.toISOString()); this.lastCleanup = now.getTime(); }
      this.health.lastError = '';
    } catch (error) { this.health.lastError = safeError(error).code; this.log(`scheduler ${this.health.lastError}`); }
    finally { this.ticking = false; }
  }
  private async schedule(now: Date) {
    const schedules = await this.store.list<Schedule>('schedules', { enabled: true });
    for (let offset = 0; offset < schedules.length && !this.stopped; offset += 10) await Promise.all(schedules.slice(offset, offset + 10).map(async version => {
      const schedule = version.value;
      if (Date.parse(schedule.nextAt) > now.getTime()) return;
      try {
        const due = latestDue(schedule.cron, schedule.timezone, schedule.nextAt, now, schedule.lastLocal);
        const report = (await required<Report>(this.store, 'reports', schedule.reportId)).value;
        if (report.owner !== schedule.owner || report.tenant !== schedule.tenant) throw new ReportError('FORBIDDEN', 'Schedule ownership is inconsistent.');
        if (!due.duplicate) await this.enqueue(report, 'schedule', due.due, { recipients: schedule.recipients, subject: schedule.subject, message: schedule.message }, schedule.id);
        await this.store.replace('schedules', schedule.id, { ...schedule, nextAt: due.next.toISOString(), lastLocal: localKey(due.due, schedule.timezone), skipped: schedule.skipped + due.skipped, updatedAt: now.toISOString() }, version);
      } catch (error) {
        this.log(`schedule=${schedule.id} ${safeError(error).code}`);
        // Persistent source/report errors disable the schedule instead of spinning.
        if (error instanceof ReportError && !error.retryable) await this.store.replace('schedules', schedule.id, { ...schedule, enabled: false, updatedAt: now.toISOString() }, version);
      }
    }));
  }
  private async owned(run: Run): Promise<Versioned<Run>> {
    const current = await required<Run>(this.store, 'runs', run.id);
    if (current.value.worker !== this.id || current.value.fence !== run.fence || !['running', 'sending'].includes(current.value.status) || Date.parse(current.value.leaseUntil ?? '') <= Date.now()) throw new ReportError('LEASE_LOST', 'This run is no longer owned by this worker.', 409);
    return current;
  }
  private async transition(run: Run, changes: Partial<Run>) {
    for (let retry = 0; retry < 3; retry++) {
      const current = await this.owned(run);
      if (await this.store.replace('runs', run.id, { ...current.value, ...changes }, current)) return;
    }
    throw new ReportError('LEASE_LOST', 'The run changed while saving its result.', 409);
  }
  private async process(run: Run, controller: AbortController) {
    const start = Date.now(); let sending = false, phase = 'query';
    const timeout = setTimeout(() => controller.abort(), this.limits.timeoutMs);
    const heartbeat = setInterval(async () => {
      try { await this.transition(run, { leaseUntil: new Date(Date.now() + 60000).toISOString() }); }
      catch { controller.abort(); }
    }, 15000);
    try {
      const panels = await this.executor.execute(run, controller.signal, this.requests.get(run.id));
      controller.signal.throwIfAborted();
      phase = 'render';
      const { pdf, pages } = await this.render(run, panels, this.limits, controller.signal);
      controller.signal.throwIfAborted(); await this.owned(run);
      phase = 'artifact';
      const artifact: Artifact = { id: `${run.id}-${run.fence}`, runId: run.id, owner: run.owner, tenant: run.tenant, pdf: pdf.toString('base64'), pages, sha256: createHash('sha256').update(pdf).digest('hex'), expiresAt: new Date(Date.now() + this.limits.artifactDays * 86400000).toISOString() };
      await this.store.create('artifacts', artifact.id, artifact);
      await this.transition(run, { artifactId: artifact.id });
      if (run.delivery) {
        await this.executor.authorize(run.report);
        controller.signal.throwIfAborted();
        // Publish sending BEFORE touching SMTP. A crash after this point cannot
        // cause an automatic resend, even if the lease expires on another node.
        await this.transition(run, { status: 'sending' }); sending = true;
        phase = 'smtp'; await this.mailer.send(run, pdf);
      }
      await this.transition(run, { status: 'complete', finishedAt: new Date().toISOString() });
      this.health.completed++;
    } catch (error: any) {
      // Shutdown leaves the lease for recovery. In-flight SMTP remains sending
      // and becomes delivery_unknown; generation is reclaimed after expiry.
      if (this.stopped) return;
      const ambiguous = error?.code === 'DELIVERY_UNKNOWN' || (sending && !(error instanceof ReportError && error.code === 'SMTP_FAILED'));
      const retryable = error instanceof ReportError && error.retryable && run.attempt < 3 && !ambiguous;
      const status = ambiguous ? 'delivery_unknown' : retryable ? 'queued' : 'failed';
      try { await this.transition(run, { status, error: controller.signal.aborted && !ambiguous ? { code: 'RUN_TIMEOUT', message: 'Generation was cancelled or exceeded its deadline.' } : safeError(error),
        finishedAt: retryable ? undefined : new Date().toISOString(), nextAttemptAt: retryable ? new Date(Date.now() + run.attempt * 30000).toISOString() : undefined }); } catch { /* A newer owner or cancellation wins. */ }
      if (ambiguous) this.health.deliveryUnknown++; else this.health.failures++;
      const denied = String(error?.meta?.body?.error?.reason ?? '').match(/no permissions for \[([a-z_:*\/[\]]+)\]/)?.[1] ?? '';
      this.log(`run=${run.id} phase=${phase} fence=${run.fence} ${safeError(error).code} ${error?.name ?? ''} ${error?.code ?? ''} status=${error?.meta?.statusCode ?? ''} type=${error?.meta?.body?.error?.type ?? ''} deniedAction=${denied} ${String(error?.stack ?? '').split('\n').filter((line: string) => /^\s+at /.test(line)).slice(0, 6).join(' | ')}`);
    } finally {
      clearTimeout(timeout); clearInterval(heartbeat); this.health.lastDurationMs = Date.now() - start;
      try { const current = await this.store.get<Run>('runs', run.id); if (current && ['complete', 'failed', 'cancelled', 'delivery_unknown'].includes(current.value.status)) await this.release(run); }
      catch { this.log(`run=${run.id} grant_cleanup_pending`); }
    }
  }
  private async release(run: Run) {
    if (!run.report.grant?.temporary || !this.executor.release) return;
    try {
      await this.executor.release(run);
      const current = await this.store.get<Run>('runs', run.id);
      if (current && !current.value.grantReleased) await this.store.replace('runs', run.id, { ...current.value, grantReleased: true }, current);
    } catch { this.log(`run=${run.id} grant_cleanup_pending`); }
  }
  async cancel(id: string, actor: Identity) {
    const current = await required<Run>(this.store, 'runs', id);
    if (current.value.owner !== actor.owner || current.value.tenant !== actor.tenant) throw new ReportError('NOT_FOUND', 'Record not found.', 404);
    if (!['queued', 'running'].includes(current.value.status)) throw new ReportError('NOT_CANCELLABLE', 'Only queued or generating reports can be cancelled.', 409);
    if (!await this.store.replace('runs', id, { ...current.value, status: 'cancelled', fence: current.value.fence + 1, finishedAt: new Date().toISOString() }, current)) throw new ReportError('CONFLICT', 'The run changed. Refresh and retry.', 409);
    await this.release(current.value);
    this.active.get(id)?.abort();
  }
}
