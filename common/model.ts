import { z } from 'zod';

const text = (max = 200) => z.string().trim().min(1).max(max);
export const identitySchema = z.object({ owner: text(), tenant: z.string().max(200) }).strict();
export type Identity = z.infer<typeof identitySchema>;
export const querySchema = z.object({ language: z.enum(['kuery', 'lucene']), query: z.string().max(10000) }).strict();
export const sourceRefSchema = z.object({ type: z.enum(['dashboard', 'visualization', 'search', 'index-pattern']), id: text(1000), version: z.string().optional() }).strict();
export const snapshotSchema = z.object({
  key: text(), title: text(), type: z.enum(['line', 'area', 'histogram', 'pie', 'metric', 'table']),
  refs: z.array(sourceRefSchema).min(1).max(100),
  importRef: sourceRefSchema, panelId: z.string().optional(),
  indexPattern: z.object({ id: text(1000), attributes: z.record(z.unknown()) }),
  vis: z.object({ type: z.string(), params: z.record(z.any()), aggs: z.array(z.any()).max(30) }),
  queries: z.array(querySchema).max(30), filters: z.array(z.record(z.any())).max(100)
}).strict();
export type Snapshot = z.infer<typeof snapshotSchema>;
export const brandingSchema = z.object({
  organization: z.string().max(120).default(''), header: z.string().max(180).default(''),
  footer: z.string().max(180).default(''), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#2457a7'),
  alignment: z.enum(['left', 'center', 'right']).default('left'),
  logo: z.string().max(1400000).regex(/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/).optional(),
  showPeriod: z.boolean().default(true), showGenerated: z.boolean().default(true), showPageNumbers: z.boolean().default(true)
}).strict();
export const sectionSchema = z.discriminatedUnion('kind', [
  z.object({ id: text(), kind: z.literal('panels'), columns: z.union([z.literal(1), z.literal(2)]), sources: z.array(text()).min(1).max(2) }).strict(),
  z.object({ id: text(), kind: z.literal('text'), text: z.string().max(20000), style: z.enum(['body', 'heading']), bold: z.boolean().default(false), alignment: z.enum(['left', 'center', 'right']).default('left') }).strict(),
  z.object({ id: text(), kind: z.literal('pageBreak') }).strict()
]);
export const reportSchema = z.object({
  title: text(), timezone: text(), timeRange: z.object({ from: text(), to: text() }).strict(),
  query: querySchema.default({ language: 'kuery', query: '' }), filters: z.array(z.record(z.any())).max(100).default([]),
  branding: brandingSchema, sources: z.array(snapshotSchema).max(100), sections: z.array(sectionSchema).min(1).max(100)
}).strict();
export type ReportInput = z.infer<typeof reportSchema>;
export interface ExecutionGrant { id: string; fingerprint: string; createdAt: string; authorization: 'until_revoked'; temporary?: boolean; specs: Record<string, any>; settings: Record<string, any>; }
export type Report = ReportInput & Identity & { id: string; revision: number; schemaVersion: 1; updatedAt: string; grant?: ExecutionGrant };
export const scheduleSchema = z.object({
  reportId: text(), cron: text(), timezone: text(), enabled: z.boolean(),
  senderId: z.string().min(1).max(1000), recipientGroupIds: z.array(z.string().min(1).max(1000)).min(1).max(50),
  subject: text(200).refine(v => !/[\r\n]/.test(v)), message: z.string().max(10000)
}).strict();
export type ScheduleInput = z.infer<typeof scheduleSchema>;
export type Schedule = ScheduleInput & Identity & { id: string; revision: number; nextAt: string; lastLocal?: string; skipped: number; updatedAt: string };
export type RunStatus = 'queued' | 'running' | 'sending' | 'complete' | 'failed' | 'cancelled' | 'delivery_unknown';
export interface Run extends Identity {
  id: string; report: Report; scheduleId?: string; trigger: 'preview' | 'manual' | 'schedule' | 'test';
  scheduledAt: string; createdAt: string; expiresAt: string; from: string; to: string;
  status: RunStatus; attempt: number; fence: number; leaseUntil?: string; worker?: string;
  error?: { code: string; message: string }; artifactId?: string; finishedAt?: string;
  delivery?: Pick<Schedule, 'senderId' | 'recipientGroupIds' | 'subject' | 'message'>; nextAttemptAt?: string; grantReleased?: boolean;
}
export interface Artifact extends Identity { id: string; runId: string; pdf: string; sha256: string; pages: number; expiresAt: string; }
export interface Cell { text: string; value: string | number | null; }
export interface PanelData { key: string; title: string; type: Snapshot['type']; columns: string[]; rows: Cell[][]; bucketCount: number; schemas: string[]; params: Record<string, any>; axis?: { min: number; max: number; interval: number; labels: Record<string, string> }; }
export interface Limits { concurrency: number; pages: number; rows: number; bytes: number; timeoutMs: number; artifactDays: number; historyDays: number; schedules: number; }
export const defaultLimits: Limits = { concurrency: 2, pages: 20, rows: 10000, bytes: 10 * 1024 * 1024, timeoutMs: 300000, artifactDays: 7, historyDays: 30, schedules: 100 };
export class ReportError extends Error { constructor(public code: string, message: string, public status = 400, public retryable = false) { super(message); } }
export function assertOwner(record: Identity, actor: Identity) {
  if (record.owner !== actor.owner || record.tenant !== actor.tenant) throw new ReportError('NOT_FOUND', 'Record not found.', 404);
}
export function safeError(error: unknown) {
  return error instanceof ReportError ? { code: error.code, message: error.message } : { code: 'INTERNAL_ERROR', message: 'The operation failed. See the server log for its run ID.' };
}
