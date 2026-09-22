import { schema } from '@osd/config-schema';
export const config = { schema: schema.object({
  enabled: schema.boolean({ defaultValue: true }),
  adminRoles: schema.arrayOf(schema.string(), { defaultValue: ['all_access'] }),
  worker: schema.object({ username: schema.string({ defaultValue: '' }), passwordEnv: schema.string({ defaultValue: 'BETTER_REPORTS_WORKER_PASSWORD' }) }),
  limits: schema.object({ concurrency: schema.number({ defaultValue: 2, min: 1, max: 8 }), pages: schema.number({ defaultValue: 20, min: 1, max: 100 }), rows: schema.number({ defaultValue: 10000, min: 1, max: 10000 }), bytes: schema.number({ defaultValue: 10485760, min: 1024, max: 26214400 }), timeoutMs: schema.number({ defaultValue: 300000, min: 1000, max: 900000 }), artifactDays: schema.number({ defaultValue: 7, min: 1, max: 90 }), historyDays: schema.number({ defaultValue: 30, min: 1, max: 365 }), schedules: schema.number({ defaultValue: 100, min: 1, max: 1000 }) })
}) };
