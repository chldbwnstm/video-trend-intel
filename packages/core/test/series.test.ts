import { describe, expect, it } from 'vitest';
import {
  dailyIncrements,
  increment,
  latestValue,
  metricSeries,
  valueAt,
  valueAtAge,
} from '../src/series.ts';
import { localDateStartUtc, resolveWindow } from '../src/time.ts';
import type { ObservationPoint } from '../src/types.ts';
import { DAY_MS, HOUR_MS, makeObs, makeVideo, obsOf, ts } from './fixtures.ts';

const H = HOUR_MS;
const D = DAY_MS;
const SEOUL = 'Asia/Seoul';
const SYD = 'Australia/Sydney';

describe('valueAt', () => {
  const pub = ts('2026-09-01');
  const v = makeVideo({
    publishedAt: pub,
    obs: [makeObs(pub + 10 * H, 1000), makeObs(pub + 34 * H, 3400), makeObs(pub + 10 * D, 10_000)],
  });

  it('is 0 exact before (and at) publish, by definition', () => {
    expect(valueAt(v, 'views', pub - D)).toEqual({ value: 0, status: 'exact', asOf: pub - D, note: 'before_publish' });
    expect(valueAt(v, 'views', pub).value).toBe(0);
    expect(valueAt(v, 'views', pub).status).toBe('exact');
  });

  it('snaps to an observation within the 2h tolerance (either side) as exact with the observation time', () => {
    expect(valueAt(v, 'views', pub + 10 * H)).toEqual({ value: 1000, status: 'exact', asOf: pub + 10 * H, note: null });
    expect(valueAt(v, 'views', pub + 8 * H)).toEqual({ value: 1000, status: 'exact', asOf: pub + 10 * H, note: null });
    expect(valueAt(v, 'views', pub + 12 * H)).toEqual({ value: 1000, status: 'exact', asOf: pub + 10 * H, note: null });
    expect(valueAt(v, 'views', pub + 36 * H).value).toBe(3400);
  });

  it('interpolates linearly between observations within 48h and rounds', () => {
    const m = valueAt(v, 'views', pub + 22 * H);
    expect(m).toEqual({ value: 2200, status: 'interpolated', asOf: pub + 22 * H, note: null });
    expect(valueAt(v, 'views', pub + 13 * H + 20 * 60_000).value).toBe(Math.round(1000 + 2400 * (3 + 1 / 3) / 24));
  });

  it('uses the publish instant as a (publishedAt, 0) anchor when the first observation is close', () => {
    const m = valueAt(v, 'views', pub + 5 * H);
    expect(m).toEqual({ value: 500, status: 'interpolated', asOf: pub + 5 * H, note: null });
  });

  it('does not anchor when the first observation is far from publish', () => {
    const late = makeVideo({ publishedAt: pub, obs: [makeObs(pub + 5 * D, 5000), makeObs(pub + 6 * D, 6000)] });
    expect(valueAt(late, 'views', pub + 2 * D)).toEqual({ value: null, status: 'unavailable', asOf: null, note: 'before_first_observation' });
  });

  it('refuses to interpolate across a gap wider than 48h', () => {
    expect(valueAt(v, 'views', pub + 5 * D)).toEqual({ value: null, status: 'unavailable', asOf: null, note: 'gap_too_wide' });
  });

  it('after the last observation: exact within tolerance, otherwise unavailable', () => {
    expect(valueAt(v, 'views', pub + 10 * D + 2 * H).value).toBe(10_000);
    expect(valueAt(v, 'views', pub + 10 * D + 3 * H)).toEqual({ value: null, status: 'unavailable', asOf: null, note: 'after_last_observation' });
  });

  it('respects custom tolerance and max gap', () => {
    expect(valueAt(v, 'views', pub + 5 * D, { maxInterpolationGapMs: 10 * D }).status).toBe('interpolated');
    expect(valueAt(v, 'views', pub + 11 * H, { boundaryToleranceMs: 0 }).status).toBe('interpolated');
  });

  it('never treats a missing counter as 0', () => {
    expect(valueAt(v, 'shares', pub + 10 * H)).toEqual({ value: null, status: 'unavailable', asOf: null, note: 'counter_not_provided' });
    expect(valueAt(v, 'likes', pub + 10 * D)).toEqual({ value: null, status: 'unavailable', asOf: null, note: 'counter_not_provided' });
  });

  it('a counter hidden later is counter_not_provided, not after_last_observation', () => {
    const hidden = makeVideo({
      publishedAt: pub,
      obs: [obsOf(pub + 1 * D, { views: 100, likes: 10 }), obsOf(pub + 2 * D, { views: 200, likes: 20 }), obsOf(pub + 5 * D, { views: 500 })],
    });
    expect(valueAt(hidden, 'likes', pub + 2 * D).value).toBe(20);
    expect(valueAt(hidden, 'likes', pub + 5 * D).note).toBe('counter_not_provided');
    expect(valueAt(hidden, 'views', pub + 5 * D).value).toBe(500);
  });

  it('a null observation inside a wide gap explains the gap as counter_not_provided', () => {
    const gappy = makeVideo({
      publishedAt: pub,
      obs: [obsOf(pub + 1 * D, { likes: 10 }), obsOf(pub + 3 * D, { likes: null }), obsOf(pub + 6 * D, { likes: 60 })],
    });
    expect(valueAt(gappy, 'likes', pub + 4 * D).note).toBe('counter_not_provided');
  });

  it('handles unsorted input and sees observations appended later', () => {
    const obs: ObservationPoint[] = [makeObs(pub + 34 * H, 3400), makeObs(pub + 10 * H, 1000)];
    const u = makeVideo({ publishedAt: pub });
    u.obs = obs; // bypass the fixture's sorting on purpose
    expect(valueAt(u, 'views', pub + 22 * H).value).toBe(2200);
    expect(valueAt(u, 'views', pub + 50 * H).note).toBe('after_last_observation');
    u.obs.push(makeObs(pub + 50 * H, 5000));
    expect(valueAt(u, 'views', pub + 50 * H).value).toBe(5000);
    expect(metricSeries(u, 'views').t).toEqual([pub + 10 * H, pub + 34 * H, pub + 50 * H]);
  });

  it('video with no observations', () => {
    const none = makeVideo({ publishedAt: pub, obs: [] });
    expect(valueAt(none, 'views', pub + D).note).toBe('counter_not_provided');
    expect(valueAt(none, 'views', pub - 1).value).toBe(0);
  });
});

describe('increment', () => {
  it('design doc §5 worked example: activity increments A=5M > B=2M > C=0.8M', () => {
    const now = ts('2026-10-02');
    const sep = resolveWindow({ start: '2026-09-01', end: '2026-09-30' }, SEOUL, now);
    expect(sep.incomplete).toBe(false);
    const A = makeVideo({ id: 'youtube:A', publishedAt: ts('2026-08-10'), obs: [makeObs(sep.startMs, 1_000_000), makeObs(sep.endMs, 6_000_000)] });
    const B = makeVideo({ id: 'youtube:B', publishedAt: ts('2026-09-10'), obs: [makeObs(ts('2026-09-10T06:00Z'), 10_000), makeObs(sep.endMs, 2_000_000)] });
    const C = makeVideo({ id: 'youtube:C', publishedAt: ts('2026-09-15'), obs: [makeObs(ts('2026-09-15T12:00Z'), 5_000), makeObs(sep.endMs, 800_000)] });
    const inc = (x: typeof A) => increment(x, 'views', sep.startMs, sep.endMs, now);
    expect(inc(A)).toEqual({ value: 5_000_000, status: 'exact', asOf: sep.endMs, note: null });
    expect(inc(B)).toEqual({ value: 2_000_000, status: 'exact', asOf: sep.endMs, note: null });
    expect(inc(C)).toEqual({ value: 800_000, status: 'exact', asOf: sep.endMs, note: null });
  });

  it('interpolated when a boundary is interpolated', () => {
    const v = makeVideo({ publishedAt: ts('2026-08-01'), obs: [makeObs('2026-09-01T00:00Z', 0 + 1000), makeObs('2026-09-02T00:00Z', 3400), makeObs('2026-09-03T00:00Z', 5800)] });
    const m = increment(v, 'views', ts('2026-09-01T12:00Z'), ts('2026-09-03T00:00Z'), ts('2026-10-01'));
    expect(m).toEqual({ value: 5800 - 2200, status: 'interpolated', asOf: ts('2026-09-03'), note: null });
  });

  it('video published at/after the window end -> 0 exact', () => {
    const v = makeVideo({ publishedAt: ts('2026-09-20'), obs: [makeObs('2026-09-21', 100)] });
    expect(increment(v, 'views', ts('2026-09-01'), ts('2026-09-20'), ts('2026-10-01'))).toMatchObject({ value: 0, status: 'exact', note: 'published_after_window' });
  });

  it('video published inside the window counts from 0', () => {
    const v = makeVideo({ publishedAt: ts('2026-09-20'), obs: [makeObs('2026-09-20T05:00Z', 100), makeObs('2026-09-30', 900)] });
    expect(increment(v, 'views', ts('2026-09-01'), ts('2026-09-30'), ts('2026-10-01'))).toMatchObject({ value: 900, status: 'exact' });
  });

  it('window starting before our first observation -> lower_bound from the first observation inside', () => {
    // Published long ago, we only started tracking on Sep 10.
    const v = makeVideo({ publishedAt: ts('2025-01-01'), obs: [makeObs('2026-09-10', 50_000), makeObs('2026-09-30', 80_000)] });
    const m = increment(v, 'views', ts('2026-09-01'), ts('2026-09-30'), ts('2026-10-01'));
    expect(m).toEqual({ value: 30_000, status: 'lower_bound', asOf: ts('2026-09-30'), note: 'before_first_observation' });
  });

  it('window ending after our last observation -> lower_bound from the last observation', () => {
    const v = makeVideo({ publishedAt: ts('2025-01-01'), obs: [makeObs('2026-09-01', 50_000), makeObs('2026-09-20', 70_000)] });
    const m = increment(v, 'views', ts('2026-09-01'), ts('2026-09-30'), ts('2026-10-01'));
    expect(m).toEqual({ value: 20_000, status: 'lower_bound', asOf: ts('2026-09-20'), note: 'after_last_observation' });
  });

  it('both boundaries unknown but observations inside -> lower_bound', () => {
    const v = makeVideo({ publishedAt: ts('2025-01-01'), obs: [makeObs('2026-09-05', 100), makeObs('2026-09-25', 400)] });
    expect(increment(v, 'views', ts('2026-09-01'), ts('2026-09-30'), ts('2026-10-01'))).toMatchObject({ value: 300, status: 'lower_bound' });
  });

  it('gap too wide around both boundaries with nothing inside -> unavailable', () => {
    const v = makeVideo({ publishedAt: ts('2025-01-01'), obs: [makeObs('2026-08-01', 100), makeObs('2026-10-15', 400)] });
    expect(increment(v, 'views', ts('2026-09-01'), ts('2026-09-08'), ts('2026-10-20'))).toEqual({
      value: null,
      status: 'unavailable',
      asOf: null,
      note: 'gap_too_wide',
    });
  });

  it('gap too wide at the start with an observation inside -> lower_bound', () => {
    const v = makeVideo({ publishedAt: ts('2025-01-01'), obs: [makeObs('2026-08-01', 100), makeObs('2026-09-04', 400), makeObs('2026-09-08', 900)] });
    expect(increment(v, 'views', ts('2026-09-01'), ts('2026-09-08'), ts('2026-10-20'))).toMatchObject({ value: 500, status: 'lower_bound', note: 'gap_too_wide' });
  });

  it('a single observation inside the window carries no growth information -> unavailable', () => {
    const v = makeVideo({ publishedAt: ts('2025-01-01'), obs: [makeObs('2026-09-01T01:00Z', 100)] });
    expect(increment(v, 'views', ts('2026-09-01'), ts('2026-09-30'), ts('2026-10-01'))).toMatchObject({ status: 'unavailable', note: 'after_last_observation' });
  });

  it('decreasing counter (deletion / correction) -> decrease_flagged, value kept', () => {
    const v = makeVideo({ publishedAt: ts('2026-08-01'), obs: [makeObs('2026-09-01', 10_000), makeObs('2026-09-30', 7_000)] });
    expect(increment(v, 'views', ts('2026-09-01'), ts('2026-09-30'), ts('2026-10-01'))).toEqual({
      value: -3000,
      status: 'decrease_flagged',
      asOf: ts('2026-09-30'),
      note: 'counter_decreased',
    });
    const dropped = makeVideo({ publishedAt: ts('2026-08-01'), obs: [makeObs('2026-09-01', 10_000), makeObs('2026-09-10', 0)] });
    expect(increment(dropped, 'views', ts('2026-09-01'), ts('2026-09-30'), ts('2026-10-01')).status).toBe('decrease_flagged');
  });

  it('counter not provided -> unavailable, never 0', () => {
    const v = makeVideo({ publishedAt: ts('2026-08-01'), obs: [makeObs('2026-09-01', 10_000), makeObs('2026-09-30', 20_000)] });
    expect(increment(v, 'likes', ts('2026-09-01'), ts('2026-09-30'), ts('2026-10-01'))).toEqual({
      value: null,
      status: 'unavailable',
      asOf: null,
      note: 'counter_not_provided',
    });
  });

  it('incomplete current window is clipped to now', () => {
    const now = ts('2026-09-28T03:00Z');
    const sep = resolveWindow({ start: '2026-09-01', end: '2026-09-30' }, SEOUL, now);
    expect(sep.incomplete).toBe(true);
    const v = makeVideo({ publishedAt: ts('2026-08-01'), obs: [makeObs(sep.startMs, 1000), makeObs(ts('2026-09-28T02:00Z'), 9000)] });
    expect(increment(v, 'views', sep.startMs, sep.endMs, now)).toEqual({ value: 8000, status: 'exact', asOf: ts('2026-09-28T02:00Z'), note: null });
  });

  it('empty and not-yet-started windows', () => {
    const v = makeVideo({ publishedAt: ts('2026-08-01'), obs: [makeObs('2026-09-01', 1000)] });
    expect(increment(v, 'views', ts('2026-09-05'), ts('2026-09-05'), ts('2026-10-01'))).toMatchObject({ value: 0, status: 'exact', note: 'empty_window' });
    expect(increment(v, 'views', ts('2026-10-05'), ts('2026-10-06'), ts('2026-10-01'))).toMatchObject({ value: null, status: 'unavailable', note: 'window_not_started' });
  });

  it('old video re-trending this month: large increment while its publish date is long before the window', () => {
    const now = ts('2026-09-28T03:00Z');
    const month = resolveWindow({ start: '2026-09-01', end: '2026-09-28' }, SEOUL, now);
    const old = makeVideo({
      publishedAt: ts('2024-03-01'),
      obs: [makeObs(ts('2026-08-25'), 120_000), makeObs(month.startMs, 121_000), makeObs(ts('2026-09-15'), 900_000), makeObs(ts('2026-09-28T02:30Z'), 3_121_000)],
    });
    expect(old.publishedAt).toBeLessThan(month.startMs);
    expect(increment(old, 'views', month.startMs, month.endMs, now)).toMatchObject({ value: 3_000_000, status: 'exact' });
  });
});

describe('increment: boundary tolerance scales with short windows', () => {
  // 'today' at 00:26 KST: a 26-minute window; the first collection ran at 00:13, the next at 00:23
  const start = localDateStartUtc('2026-09-29', SEOUL);
  const now = start + 26 * 60_000;

  it('a 26-minute window is not exact from observations 13 minutes off its start', () => {
    const v = makeVideo({ publishedAt: ts('2026-02-08T15:00Z'), obs: [makeObs(start + 13 * 60_000, 19_677_168), makeObs(start + 23 * 60_000, 19_693_711)] });
    const m = increment(v, 'views', start, start + D, now);
    // only what was observed inside the window: a lower bound, not 'exact'
    expect(m).toMatchObject({ value: 16_543, status: 'lower_bound' });
    // the daily bar for today is not labelled exact either
    expect(dailyIncrements(v, 'views', '2026-09-29', '2026-09-29', SEOUL, now)[0].value.status).toBe('lower_bound');
  });

  it('one observation never serves as both boundaries (no fabricated exact 0)', () => {
    const v = makeVideo({ id: 'youtube:f2oMCIMHYMg', publishedAt: ts('2026-02-08T15:00Z'), obs: [makeObs(start + 13 * 60_000, 14_444_825)] });
    const m = increment(v, 'views', start, start + D, now);
    expect(m.status === 'exact' && m.value === 0).toBe(false);
    expect(m.status).toBe('unavailable');
    // even with an explicit (large) tolerance
    expect(increment(v, 'views', start, start + D, now, { boundaryToleranceMs: 2 * H }).status).toBe('unavailable');
  });

  it('a 24h window keeps a 72-minute tolerance; farther boundaries are interpolated when bracketed', () => {
    const day = localDateStartUtc('2026-09-28', SEOUL);
    const near = makeVideo({ publishedAt: ts('2026-08-01'), obs: [makeObs(day + 20 * 60_000, 1_000), makeObs(day + D + 25 * 60_000, 2_000)] });
    expect(increment(near, 'views', day, day + D, day + 2 * D)).toMatchObject({ value: 1_000, status: 'exact' });
    const far = makeVideo({ publishedAt: ts('2026-08-01'), obs: [makeObs(day - 90 * 60_000, 1_000), makeObs(day + 90 * 60_000, 1_300), makeObs(day + D, 2_000)] });
    // 90 minutes off (Sydney-style offset): interpolated between the bracketing observations, not exact
    expect(increment(far, 'views', day, day + D, day + 2 * D)).toMatchObject({ value: 850, status: 'interpolated' });
  });
});

describe('valueAtAge', () => {
  const pub = ts('2026-09-01T09:00Z');
  const now = ts('2026-09-28T00:00Z');

  it('not_reached when publishedAt + age is after now', () => {
    const v = makeVideo({ publishedAt: ts('2026-09-25'), obs: [makeObs('2026-09-26', 100), makeObs('2026-09-27T23:00Z', 300)] });
    expect(valueAtAge(v, 'views', 1, now).status).toBe('exact');
    expect(valueAtAge(v, 'views', 7, now)).toEqual({ value: null, status: 'unavailable', asOf: null, note: 'not_reached' });
    expect(valueAtAge(v, 'views', 30, now).note).toBe('not_reached');
  });

  it('V1 interpolates only across gaps <= 12h', () => {
    const ok = makeVideo({ publishedAt: pub, obs: [makeObs(pub + 18 * H, 1800), makeObs(pub + 30 * H, 3000)] });
    expect(valueAtAge(ok, 'views', 1, now)).toMatchObject({ value: 2400, status: 'interpolated' });
    const wide = makeVideo({ publishedAt: pub, obs: [makeObs(pub + 10 * H, 1000), makeObs(pub + 30 * H, 3000)] });
    expect(valueAtAge(wide, 'views', 1, now)).toMatchObject({ status: 'unavailable', note: 'gap_too_wide' });
    // The same gap is fine for plain valueAt (48h default).
    expect(valueAt(wide, 'views', pub + 24 * H).status).toBe('interpolated');
  });

  it('V7 allows up to 84h and V30 up to 360h gaps', () => {
    const v7 = makeVideo({ publishedAt: pub, obs: [makeObs(pub + 5 * D, 500), makeObs(pub + 8 * D, 800)] });
    expect(valueAtAge(v7, 'views', 7, now)).toMatchObject({ value: 700, status: 'interpolated' });
    const v7wide = makeVideo({ publishedAt: pub, obs: [makeObs(pub + 3 * D, 300), makeObs(pub + 8 * D, 800)] });
    expect(valueAtAge(v7wide, 'views', 7, now).note).toBe('gap_too_wide');
    const v30 = makeVideo({ publishedAt: ts('2026-07-01'), obs: [makeObs('2026-07-25', 2500), makeObs('2026-08-06', 3700)] });
    expect(valueAtAge(v30, 'views', 30, now)).toMatchObject({ value: 3100, status: 'interpolated' });
  });

  it('exact within tolerance of the age instant; explicit options override the age rule', () => {
    const v = makeVideo({ publishedAt: pub, obs: [makeObs(pub + 7 * D - H, 777), makeObs(pub + 20 * D, 2000)] });
    expect(valueAtAge(v, 'views', 7, now)).toEqual({ value: 777, status: 'exact', asOf: pub + 7 * D - H, note: null });
    const w = makeVideo({ publishedAt: pub, obs: [makeObs(pub + 10 * H, 1000), makeObs(pub + 30 * H, 3000)] });
    expect(valueAtAge(w, 'views', 1, now, { maxInterpolationGapMs: 48 * H }).status).toBe('interpolated');
  });

  it('missing counter stays unavailable', () => {
    const v = makeVideo({ publishedAt: pub, obs: [makeObs(pub + 1 * D, 100)] });
    expect(valueAtAge(v, 'comments', 1, now).note).toBe('counter_not_provided');
  });
});

describe('latestValue', () => {
  const v = makeVideo({
    publishedAt: ts('2026-09-01'),
    obs: [obsOf('2026-09-02', { views: 100, likes: 5 }), obsOf('2026-09-05', { views: 400, likes: 9 }), obsOf('2026-09-09', { views: 900 })],
  });

  it('returns the latest observation at or before t, with its time', () => {
    expect(latestValue(v, 'views', ts('2026-09-06'))).toEqual({ value: 400, status: 'exact', asOf: ts('2026-09-05'), note: null });
    expect(latestValue(v, 'views', ts('2026-09-05'))).toMatchObject({ value: 400 });
    expect(latestValue(v, 'views', ts('2026-12-01'))).toMatchObject({ value: 900, asOf: ts('2026-09-09') });
  });

  it('skips observations where the counter is null', () => {
    expect(latestValue(v, 'likes', ts('2026-12-01'))).toMatchObject({ value: 9, asOf: ts('2026-09-05') });
  });

  it('unavailable before any observation / when never provided', () => {
    expect(latestValue(v, 'views', ts('2026-09-01T12:00Z'))).toMatchObject({ status: 'unavailable', note: 'before_first_observation' });
    expect(latestValue(v, 'views', ts('2026-08-01'))).toMatchObject({ value: 0, status: 'exact', note: 'before_publish' });
    expect(latestValue(v, 'shares', ts('2026-12-01'))).toMatchObject({ status: 'unavailable', note: 'counter_not_provided' });
  });
});

describe('dailyIncrements', () => {
  /** Hourly observations with views = 100 per hour since `from`. */
  function hourly(from: number, hours: number, pub = from) {
    const obs = [];
    for (let i = 0; i <= hours; i++) obs.push(makeObs(from + i * H, i * 100));
    return makeVideo({ publishedAt: pub, obs });
  }

  it('Australia/Sydney DST start: 2026-10-04 has 23 hours of views', () => {
    const v = hourly(ts('2026-10-01'), 24 * 6);
    const days = dailyIncrements(v, 'views', '2026-10-03', '2026-10-05', SYD, ts('2026-10-08'));
    expect(days.map((d) => d.date)).toEqual(['2026-10-03', '2026-10-04', '2026-10-05']);
    expect(days.map((d) => d.value.value)).toEqual([2400, 2300, 2400]);
    expect(days.every((d) => d.value.status === 'exact')).toBe(true);
  });

  it('Australia/Sydney DST end: 2026-04-05 has 25 hours of views', () => {
    const v = hourly(ts('2026-04-01'), 24 * 6);
    const days = dailyIncrements(v, 'views', '2026-04-04', '2026-04-06', SYD, ts('2026-04-08'));
    expect(days.map((d) => d.value.value)).toEqual([2400, 2500, 2400]);
  });

  it('days sum to the window increment (Seoul)', () => {
    const v = hourly(ts('2026-09-01'), 24 * 10);
    const days = dailyIncrements(v, 'views', '2026-09-02', '2026-09-08', SEOUL, ts('2026-10-01'));
    const w = resolveWindow({ start: '2026-09-02', end: '2026-09-08' }, SEOUL, ts('2026-10-01'));
    const total = days.reduce((s, d) => s + (d.value.value ?? 0), 0);
    expect(total).toBe(increment(v, 'views', w.startMs, w.endMs, ts('2026-10-01')).value);
    expect(days).toHaveLength(7);
  });

  it('days before publish are 0, future days unavailable, today clipped to now', () => {
    const pub = localDateStartUtc('2026-09-26', SEOUL) + 6 * H;
    const v = hourly(pub, 40, pub);
    const now = pub + 40 * H;
    const days = dailyIncrements(v, 'views', '2026-09-25', '2026-09-29', SEOUL, now);
    expect(days[0].value).toMatchObject({ value: 0, status: 'exact' }); // before publish
    expect(days[1].value).toMatchObject({ value: 1800, status: 'exact' }); // 18h of the first day
    expect(days[2].value).toMatchObject({ value: 2200, status: 'exact' }); // today until now
    expect(days[3].value).toMatchObject({ status: 'unavailable', note: 'window_not_started' });
    expect(days[4].value.status).toBe('unavailable');
  });

  it('empty for an inverted range; throws on malformed dates', () => {
    const v = hourly(ts('2026-09-01'), 10);
    expect(dailyIncrements(v, 'views', '2026-09-05', '2026-09-01', SEOUL, ts('2026-10-01'))).toEqual([]);
    expect(() => dailyIncrements(v, 'views', '2026-09-01', 'nope', SEOUL, ts('2026-10-01'))).toThrow(RangeError);
  });
});
