import { describe, expect, it } from 'vitest';
import {
  DAY,
  DEFAULT_TZ,
  HOUR,
  addDays,
  daysBetween,
  formatInTz,
  isValidLocalDate,
  localDateOf,
  localDateStartUtc,
  presetRange,
  previousWindow,
  resolveWindow,
  tzOffsetMs,
  weekdayHourInTz,
} from '../src/time.ts';
import { ts } from './fixtures.ts';

const SYD = 'Australia/Sydney';
const SEOUL = 'Asia/Seoul';

describe('localDateStartUtc', () => {
  it('Asia/Seoul is UTC+9 all year (no DST)', () => {
    expect(localDateStartUtc('2026-09-28', SEOUL)).toBe(ts('2026-09-27T15:00Z'));
    expect(localDateStartUtc('2026-01-01', SEOUL)).toBe(ts('2025-12-31T15:00Z'));
    expect(localDateStartUtc('2026-07-01', SEOUL)).toBe(ts('2026-06-30T15:00Z'));
    expect(DEFAULT_TZ).toBe(SEOUL);
  });

  it('UTC midnight is the date itself', () => {
    expect(localDateStartUtc('2026-09-28', 'UTC')).toBe(ts('2026-09-28'));
    expect(localDateStartUtc('2028-02-29', 'UTC')).toBe(ts('2028-02-29'));
  });

  it('Australia/Sydney DST end (2026-04-05): the day is 25h long', () => {
    // AEDT (+11) until 2026-04-05 03:00 local, then AEST (+10).
    const start = localDateStartUtc('2026-04-05', SYD);
    const next = localDateStartUtc('2026-04-06', SYD);
    expect(start).toBe(ts('2026-04-04T13:00Z'));
    expect(next).toBe(ts('2026-04-05T14:00Z'));
    expect(next - start).toBe(25 * HOUR);
    expect(localDateStartUtc('2026-04-04', SYD)).toBe(ts('2026-04-03T13:00Z'));
  });

  it('Australia/Sydney DST start (2026-10-04): the day is 23h long', () => {
    // AEST (+10) until 2026-10-04 02:00 local, then AEDT (+11).
    const start = localDateStartUtc('2026-10-04', SYD);
    const next = localDateStartUtc('2026-10-05', SYD);
    expect(start).toBe(ts('2026-10-03T14:00Z'));
    expect(next).toBe(ts('2026-10-04T13:00Z'));
    expect(next - start).toBe(23 * HOUR);
    expect(localDateStartUtc('2026-10-03', SYD)).toBe(ts('2026-10-02T14:00Z'));
  });

  it('handles northern-hemisphere DST and non-hour offsets', () => {
    expect(localDateStartUtc('2026-03-08', 'America/New_York')).toBe(ts('2026-03-08T05:00Z'));
    expect(localDateStartUtc('2026-03-09', 'America/New_York')).toBe(ts('2026-03-09T04:00Z'));
    expect(localDateStartUtc('2026-11-01', 'America/New_York')).toBe(ts('2026-11-01T04:00Z'));
    expect(localDateStartUtc('2026-11-02', 'America/New_York')).toBe(ts('2026-11-02T05:00Z'));
    expect(localDateStartUtc('2026-09-28', 'Asia/Kathmandu')).toBe(ts('2026-09-27T18:15Z'));
    expect(localDateStartUtc('2026-09-28', 'Pacific/Kiritimati')).toBe(ts('2026-09-27T10:00Z'));
  });

  it('when local midnight does not exist (DST gap at 00:00) the day starts at the transition', () => {
    // Chile springs forward at 24:00 on 2026-09-05 -> 2026-09-06 01:00 (-03).
    const start = localDateStartUtc('2026-09-06', 'America/Santiago');
    expect(start).toBe(ts('2026-09-06T04:00Z'));
    expect(localDateOf(start, 'America/Santiago')).toBe('2026-09-06');
    expect(localDateOf(start - 1, 'America/Santiago')).toBe('2026-09-05');
  });

  it('round-trips every local day over two years in several zones', () => {
    for (const tz of [SYD, SEOUL, 'UTC', 'America/New_York', 'Europe/London']) {
      let d = '2025-12-25';
      let prevStart = localDateStartUtc(addDays(d, -1), tz);
      for (let i = 0; i < 740; i++) {
        const start = localDateStartUtc(d, tz);
        expect(localDateOf(start, tz)).toBe(d);
        expect(localDateOf(start - 1, tz)).toBe(addDays(d, -1));
        const len = start - prevStart;
        expect([23 * HOUR, 24 * HOUR, 25 * HOUR]).toContain(len);
        prevStart = start;
        d = addDays(d, 1);
      }
    }
  });

  it('rejects malformed dates and unknown zones', () => {
    expect(() => localDateStartUtc('2026-02-30', SEOUL)).toThrow(RangeError);
    expect(() => localDateStartUtc('2026-9-1', SEOUL)).toThrow(RangeError);
    expect(() => localDateStartUtc('2026-13-01', SEOUL)).toThrow(RangeError);
    expect(() => localDateStartUtc('2026-09-01', 'Mars/Olympus')).toThrow(RangeError);
  });
});

describe('localDateOf / tzOffsetMs', () => {
  it('uses the zone calendar, not UTC', () => {
    expect(localDateOf(ts('2026-09-27T14:59:59.999Z'), SEOUL)).toBe('2026-09-27');
    expect(localDateOf(ts('2026-09-27T15:00Z'), SEOUL)).toBe('2026-09-28');
    expect(localDateOf(ts('2026-09-27T15:00Z'), 'UTC')).toBe('2026-09-27');
  });

  it('is correct on both sides of Sydney transitions', () => {
    expect(localDateOf(ts('2026-04-04T12:59:59.999Z'), SYD)).toBe('2026-04-04');
    expect(localDateOf(ts('2026-04-04T13:00Z'), SYD)).toBe('2026-04-05');
    expect(localDateOf(ts('2026-04-05T13:59:59.999Z'), SYD)).toBe('2026-04-05');
    expect(localDateOf(ts('2026-04-05T14:00Z'), SYD)).toBe('2026-04-06');
    expect(tzOffsetMs(ts('2026-04-04T15:59:59Z'), SYD)).toBe(11 * HOUR);
    expect(tzOffsetMs(ts('2026-04-04T16:00Z'), SYD)).toBe(10 * HOUR);
    expect(tzOffsetMs(ts('2026-10-03T15:59:59Z'), SYD)).toBe(10 * HOUR);
    expect(tzOffsetMs(ts('2026-10-03T16:00Z'), SYD)).toBe(11 * HOUR);
  });

  it('handles instants before 1970', () => {
    expect(localDateOf(ts('1969-12-31T20:00Z'), SEOUL)).toBe('1970-01-01');
    expect(localDateOf(ts('1969-12-31T14:00Z'), SEOUL)).toBe('1969-12-31');
  });

  it('is fast enough for ~20k videos', () => {
    const t0 = performance.now();
    const base = ts('2026-01-01');
    let n = 0;
    for (let i = 0; i < 20_000; i++) n += localDateOf(base + i * 1_579_000, SYD).length;
    expect(n).toBe(200_000);
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});

describe('resolveWindow', () => {
  it('turns inclusive local dates into a half-open UTC window', () => {
    const w = resolveWindow({ start: '2026-09-01', end: '2026-09-30' }, SEOUL, ts('2026-09-28'));
    expect(w.startMs).toBe(ts('2026-08-31T15:00Z'));
    expect(w.endMs).toBe(ts('2026-09-30T15:00Z'));
    expect(w.tz).toBe(SEOUL);
    expect(w.incomplete).toBe(true);
  });

  it('is complete once now reaches the end', () => {
    const range = { start: '2026-09-01', end: '2026-09-30' };
    expect(resolveWindow(range, SEOUL, ts('2026-09-30T15:00Z')).incomplete).toBe(false);
    expect(resolveWindow(range, SEOUL, ts('2026-09-30T14:59:59Z')).incomplete).toBe(true);
  });

  it('single day and DST-spanning windows in Sydney', () => {
    const day = resolveWindow({ start: '2026-10-04', end: '2026-10-04' }, SYD, ts('2027-01-01'));
    expect(day.endMs - day.startMs).toBe(23 * HOUR);
    const week = resolveWindow({ start: '2026-04-01', end: '2026-04-07' }, SYD, ts('2027-01-01'));
    expect(week.endMs - week.startMs).toBe(7 * DAY + HOUR);
  });

  it('normalizes an inverted range', () => {
    const a = resolveWindow({ start: '2026-09-10', end: '2026-09-01' }, SEOUL, 0);
    const b = resolveWindow({ start: '2026-09-01', end: '2026-09-10' }, SEOUL, 0);
    expect(a).toEqual(b);
  });
});

describe('previousWindow', () => {
  it('is the same number of local days immediately before', () => {
    const w = resolveWindow({ start: '2026-09-08', end: '2026-09-14' }, SEOUL, ts('2026-09-28'));
    const p = previousWindow(w, ts('2026-09-28'));
    expect(p.endMs).toBe(w.startMs);
    expect(p.startMs).toBe(localDateStartUtc('2026-09-01', SEOUL));
    expect(p.incomplete).toBe(false);
    expect(p.tz).toBe(SEOUL);
  });

  it('stays aligned to local midnight across a DST change', () => {
    const w = resolveWindow({ start: '2026-10-04', end: '2026-10-10' }, SYD, ts('2027-01-01'));
    expect(w.endMs - w.startMs).toBe(7 * DAY - HOUR);
    const p = previousWindow(w, ts('2027-01-01'));
    expect(p.startMs).toBe(localDateStartUtc('2026-09-27', SYD));
    expect(p.endMs).toBe(localDateStartUtc('2026-10-04', SYD));
    expect(p.endMs - p.startMs).toBe(7 * DAY);
  });

  it('falls back to equal duration for windows not aligned to midnight', () => {
    const w = { startMs: ts('2026-09-10T05:30Z'), endMs: ts('2026-09-11T05:30Z'), tz: SEOUL, incomplete: false };
    const p = previousWindow(w, ts('2026-09-28'));
    expect(p).toEqual({ startMs: ts('2026-09-09T05:30Z'), endMs: w.startMs, tz: SEOUL, incomplete: false });
  });

  it('marks the previous window incomplete only if it has not ended by now', () => {
    const w = resolveWindow({ start: '2026-10-01', end: '2026-10-07' }, SEOUL, ts('2026-09-28'));
    expect(previousWindow(w, ts('2026-09-28')).incomplete).toBe(true);
  });
});

describe('presetRange', () => {
  // 2026-09-28 is a Monday. 03:00Z = 12:00 in Seoul.
  const now = ts('2026-09-28T03:00Z');

  it('computes all presets in Asia/Seoul', () => {
    expect(presetRange('today', SEOUL, now)).toEqual({ start: '2026-09-28', end: '2026-09-28' });
    expect(presetRange('yesterday', SEOUL, now)).toEqual({ start: '2026-09-27', end: '2026-09-27' });
    expect(presetRange('last7d', SEOUL, now)).toEqual({ start: '2026-09-22', end: '2026-09-28' });
    expect(presetRange('last30d', SEOUL, now)).toEqual({ start: '2026-08-30', end: '2026-09-28' });
    expect(presetRange('last90d', SEOUL, now)).toEqual({ start: '2026-07-01', end: '2026-09-28' });
    expect(presetRange('thisWeek', SEOUL, now)).toEqual({ start: '2026-09-28', end: '2026-09-28' });
    expect(presetRange('lastWeek', SEOUL, now)).toEqual({ start: '2026-09-21', end: '2026-09-27' });
    expect(presetRange('thisMonth', SEOUL, now)).toEqual({ start: '2026-09-01', end: '2026-09-28' });
    expect(presetRange('lastMonth', SEOUL, now)).toEqual({ start: '2026-08-01', end: '2026-08-31' });
  });

  it('depends on the zone: the same instant is Monday in Seoul, Sunday in UTC', () => {
    const t = ts('2026-09-27T16:00Z');
    expect(presetRange('today', SEOUL, t).start).toBe('2026-09-28');
    expect(presetRange('thisWeek', SEOUL, t)).toEqual({ start: '2026-09-28', end: '2026-09-28' });
    expect(presetRange('thisWeek', 'UTC', t)).toEqual({ start: '2026-09-21', end: '2026-09-27' });
    expect(presetRange('lastWeek', 'UTC', t)).toEqual({ start: '2026-09-14', end: '2026-09-20' });
  });

  it('weeks start Monday; month and year boundaries', () => {
    const sunday = ts('2026-10-04T03:00Z');
    expect(presetRange('thisWeek', SEOUL, sunday)).toEqual({ start: '2026-09-28', end: '2026-10-04' });
    const jan = ts('2027-01-15T03:00Z');
    expect(presetRange('lastMonth', SEOUL, jan)).toEqual({ start: '2026-12-01', end: '2026-12-31' });
    const mar = ts('2028-03-10T03:00Z');
    expect(presetRange('lastMonth', SEOUL, mar)).toEqual({ start: '2028-02-01', end: '2028-02-29' });
  });

  it('last7d resolves to 7 local days and is incomplete', () => {
    const w = resolveWindow(presetRange('last7d', SYD, now), SYD, now);
    expect(w.incomplete).toBe(true);
    expect(daysBetween(localDateOf(w.startMs, SYD), localDateOf(w.endMs, SYD))).toBe(7);
  });
});

describe('formatting helpers', () => {
  it('formatInTz', () => {
    const t = ts('2026-09-28T05:05:30Z');
    expect(formatInTz(t, SEOUL)).toBe('2026-09-28 14:05');
    expect(formatInTz(t, SEOUL, 'date')).toBe('2026-09-28');
    expect(formatInTz(t, SEOUL, 'time')).toBe('14:05');
    expect(formatInTz(t, 'UTC', 'datetime')).toBe('2026-09-28 05:05');
    expect(formatInTz(ts('2026-04-04T15:30Z'), SYD)).toBe('2026-04-05 02:30'); // AEDT (first 02:30)
    expect(formatInTz(ts('2026-04-04T16:30Z'), SYD)).toBe('2026-04-05 02:30'); // AEST (repeated hour)
    expect(formatInTz(ts('2026-09-27T15:00Z'), SEOUL)).toBe('2026-09-28 00:00');
  });

  it('weekdayHourInTz (0=Mon..6=Sun)', () => {
    expect(weekdayHourInTz(ts('2026-09-28T05:00Z'), SEOUL)).toEqual({ weekday: 0, hour: 14 });
    expect(weekdayHourInTz(ts('2026-09-27T16:00Z'), SEOUL)).toEqual({ weekday: 0, hour: 1 });
    expect(weekdayHourInTz(ts('2026-09-27T16:00Z'), 'UTC')).toEqual({ weekday: 6, hour: 16 });
    expect(weekdayHourInTz(ts('2026-10-03T16:30Z'), SYD)).toEqual({ weekday: 6, hour: 3 }); // skipped 02:xx
    expect(weekdayHourInTz(ts('1970-01-01T00:00Z'), 'UTC')).toEqual({ weekday: 3, hour: 0 });
  });

  it('addDays / daysBetween / isValidLocalDate', () => {
    expect(addDays('2026-09-28', 1)).toBe('2026-09-29');
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
    expect(addDays('2026-09-28', 0)).toBe('2026-09-28');
    expect(addDays('2026-09-28', -365)).toBe('2025-09-28');
    expect(() => addDays('2026-09-28', 1.5)).toThrow(RangeError);
    expect(() => addDays('bogus', 1)).toThrow(RangeError);
    expect(daysBetween('2026-09-01', '2026-10-01')).toBe(30);
    expect(daysBetween('2026-10-01', '2026-09-01')).toBe(-30);
    expect(isValidLocalDate('2026-02-28')).toBe(true);
    expect(isValidLocalDate('2026-02-29')).toBe(false);
    expect(isValidLocalDate('2026-09-28T00:00')).toBe(false);
  });
});
