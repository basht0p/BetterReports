import { ReportError } from '../common/model';

export type Collection = 'reports' | 'schedules' | 'runs' | 'artifacts';
export interface Versioned<T> { value: T; seq: number; term: number; }
export interface Store {
  init(): Promise<void>;
  get<T>(collection: Collection, id: string): Promise<Versioned<T> | undefined>;
  create<T>(collection: Collection, id: string, value: T): Promise<boolean>;
  replace<T>(collection: Collection, id: string, value: T, version: Versioned<unknown>): Promise<boolean>;
  remove(collection: Collection, id: string, version: Versioned<unknown>): Promise<boolean>;
  list<T>(collection: Collection, filters?: Record<string, unknown>, limit?: number): Promise<Array<Versioned<T>>>;
  cleanup(now: string): Promise<void>;
}
export class OpenSearchStore implements Store {
  constructor(private client: any, private prefix = '.better-reports-v1') {}
  private index(collection: Collection) { return `${this.prefix}-${collection}`; }
  async init() {
    for (const collection of ['reports', 'schedules', 'runs', 'artifacts'] as Collection[]) {
      try {
        await this.client.indices.create({ index: this.index(collection), body: {
          settings: { 'index.hidden': true, number_of_shards: 1, auto_expand_replicas: '0-1' },
          mappings: { dynamic: false, properties: {
            id: { type: 'keyword' }, owner: { type: 'keyword' }, tenant: { type: 'keyword' },
            status: { type: 'keyword' }, enabled: { type: 'boolean' }, reportId: { type: 'keyword' },
            nextAt: { type: 'date' }, expiresAt: { type: 'date' }, leaseUntil: { type: 'date' },
            createdAt: { type: 'date' }
          } }
        } });
      } catch (e: any) { if (e?.meta?.body?.error?.type !== 'resource_already_exists_exception') throw e; }
    }
  }
  async get<T>(collection: Collection, id: string): Promise<Versioned<T> | undefined> {
    try { const { body } = await this.client.get({ index: this.index(collection), id }); return { value: body._source, seq: body._seq_no, term: body._primary_term }; }
    catch (e: any) { if (e?.meta?.statusCode === 404) return undefined; throw e; }
  }
  async create<T>(collection: Collection, id: string, value: T) {
    try { await this.client.create({ index: this.index(collection), id, body: value, refresh: 'wait_for' }); return true; }
    catch (e: any) { if (e?.meta?.statusCode === 409) return false; throw e; }
  }
  async replace<T>(collection: Collection, id: string, value: T, version: Versioned<unknown>) {
    try { await this.client.index({ index: this.index(collection), id, body: value, if_seq_no: version.seq, if_primary_term: version.term, refresh: 'wait_for' }); return true; }
    catch (e: any) { if (e?.meta?.statusCode === 409) return false; throw e; }
  }
  async remove(collection: Collection, id: string, version: Versioned<unknown>) {
    try { await this.client.delete({ index: this.index(collection), id, if_seq_no: version.seq, if_primary_term: version.term, refresh: 'wait_for' }); return true; }
    catch (e: any) { if ([404, 409].includes(e?.meta?.statusCode)) return false; throw e; }
  }
  async list<T>(collection: Collection, filters: Record<string, unknown> = {}, limit = 1000) {
    const { body } = await this.client.search({ index: this.index(collection), body: {
      size: limit, seq_no_primary_term: true, sort: [{ createdAt: { order: 'desc', unmapped_type: 'date' } }, { id: 'asc' }], query: { bool: { filter: Object.entries(filters).map(([key, value]) => ({ [Array.isArray(value) ? 'terms' : 'term']: { [key]: value } })) } }
    } });
    return body.hits.hits.map((hit: any) => ({ value: hit._source, seq: hit._seq_no, term: hit._primary_term })) as Array<Versioned<T>>;
  }
  async cleanup(now: string) {
    for (const collection of ['artifacts', 'runs'] as Collection[]) await this.client.deleteByQuery({ index: this.index(collection), conflicts: 'proceed', body: { query: { range: { expiresAt: { lt: now } } } } });
  }
}
export async function required<T>(store: Store, collection: Collection, id: string) {
  const result = await store.get<T>(collection, id);
  if (!result) throw new ReportError('NOT_FOUND', 'Record not found.', 404);
  return result;
}
