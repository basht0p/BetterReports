import { DateTime } from 'luxon';
import { CronExpressionParser } from 'cron-parser';
import { ReportError } from '../common/model';

export function validateTimezone(zone: string) {
  if (!DateTime.now().setZone(zone).isValid) throw new ReportError('INVALID_TIMEZONE', 'Choose a valid IANA timezone.');
}
export function resolveDate(value: string, anchor: Date, zone: string, roundUp: boolean): string {
  validateTimezone(zone);
  if (!value.startsWith('now')) {
    const absolute = DateTime.fromISO(value, { zone });
    if (!absolute.isValid) throw new ReportError('INVALID_DATE', `Invalid date: ${value}`);
    return absolute.toUTC().toISO()!;
  }
  const match = /^now((?:[+-]\d+[smhdwMy])*)(?:\/([smhdwMy]))?$/.exec(value);
  if (!match) throw new ReportError('INVALID_DATE', 'Use ISO dates or date math such as now-7d/d.');
  const units: Record<string, any> = { s: 'seconds', m: 'minutes', h: 'hours', d: 'days', w: 'weeks', M: 'months', y: 'years' };
  let date = DateTime.fromJSDate(anchor, { zone });
  for (const part of match[1].matchAll(/([+-])(\d+)([smhdwMy])/g)) date = date.plus({ [units[part[3]]]: Number(part[2]) * (part[1] === '-' ? -1 : 1) });
  if (match[2]) date = roundUp ? date.endOf(units[match[2]]) : date.startOf(units[match[2]]);
  return date.toUTC().toISO()!;
}
export function resolveRange(range: { from: string; to: string }, anchor: Date, zone: string) {
  const from = resolveDate(range.from, anchor, zone, false), to = resolveDate(range.to, anchor, zone, true);
  if (Date.parse(from) >= Date.parse(to)) throw new ReportError('INVALID_DATE_RANGE', 'The start must precede the end.');
  return { from, to };
}
export function localKey(value: Date, zone: string) { return DateTime.fromJSDate(value, { zone }).toFormat('yyyy-MM-dd HH:mm'); }
export function validateCron(cron: string, zone: string) {
  validateTimezone(zone);
  if (cron.trim().split(/\s+/).length !== 5) throw new ReportError('INVALID_CRON', 'Use five-field cron (minute hour day month weekday).');
  try { CronExpressionParser.parse(cron, { tz: zone }); } catch { throw new ReportError('INVALID_CRON', 'Invalid cron expression.'); }
}
// cron-parser may shift a nonexistent wall time forward. Match its returned wall
// time against an equivalent UTC expression to exclude that shifted occurrence.
function exactWallTime(cron: string, date: Date, zone: string) {
  const wall = DateTime.fromJSDate(date, { zone });
  const fake = DateTime.fromObject({ year: wall.year, month: wall.month, day: wall.day, hour: wall.hour, minute: wall.minute }, { zone: 'UTC' });
  const expected = CronExpressionParser.parse(cron, { currentDate: fake.minus({ minutes: 1 }).toJSDate(), tz: 'UTC' }).next().toDate();
  return expected.getTime() === fake.toMillis();
}
export function nextOccurrence(cron: string, zone: string, after: Date, lastLocal?: string): Date {
  validateCron(cron, zone);
  const expression = CronExpressionParser.parse(cron, { currentDate: after, tz: zone });
  for (let i = 0; i < 10000; i++) {
    const date = expression.next().toDate();
    if (localKey(date, zone) !== lastLocal && exactWallTime(cron, date, zone)) return date;
  }
  throw new ReportError('INVALID_CRON', 'No executable occurrence found.');
}
export function latestDue(cron: string, zone: string, nextAt: string, now: Date, lastLocal?: string) {
  let due = new Date(nextAt), skipped = 0;
  let next = nextOccurrence(cron, zone, due, localKey(due, zone));
  while (next <= now) {
    due = next; skipped++;
    if (skipped > 600000) throw new ReportError('SCHEDULE_BACKLOG', 'Schedule backlog exceeds the recovery limit.');
    next = nextOccurrence(cron, zone, due, localKey(due, zone));
  }
  return { due, next, skipped, duplicate: localKey(due, zone) === lastLocal };
}
