import test from 'node:test';
import assert from 'node:assert/strict';
import { latestDue, localKey, nextOccurrence, resolveRange, validateCron } from '../server/time';

test('date math uses the scheduled instant, including timezone rounding', () => {
  assert.deepEqual(resolveRange({ from: 'now-1d/d', to: 'now-1d/d' }, new Date('2026-09-21T12:00:00Z'), 'America/New_York'), { from: '2026-09-20T04:00:00.000Z', to: '2026-09-21T03:59:59.999Z' });
});
test('rejects invalid cron, dates, and timezones', () => {
  assert.throws(() => validateCron('* * * * * *', 'UTC'));
  assert.throws(() => validateCron('garbage', 'UTC'));
  assert.throws(() => validateCron('0 8 * * *', 'Not/AZone'));
  assert.throws(() => resolveRange({ from: 'yesterday', to: 'now' }, new Date(), 'UTC'));
});
test('spring-forward nonexistent wall time is skipped', () => {
  const next = nextOccurrence('30 2 * * *', 'America/New_York', new Date('2026-03-07T08:00:00Z'));
  assert.equal(next.toISOString(), '2026-03-09T06:30:00.000Z');
});
test('fall-back repeated wall time executes once', () => {
  const first = nextOccurrence('30 1 * * *', 'America/New_York', new Date('2026-11-01T00:00:00Z'));
  const second = nextOccurrence('30 1 * * *', 'America/New_York', first, localKey(first, 'America/New_York'));
  assert.equal(second.toISOString(), '2026-11-02T06:30:00.000Z');
});
test('downtime coalesces missed occurrences into the latest one', () => {
  const due = latestDue('0 8 * * *', 'UTC', '2026-09-18T08:00:00Z', new Date('2026-09-21T12:00:00Z'));
  assert.equal(due.due.toISOString(), '2026-09-21T08:00:00.000Z'); assert.equal(due.skipped, 3);
});
