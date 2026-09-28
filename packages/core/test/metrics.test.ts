import { describe, expect, it } from 'vitest';
import {
  ageValues,
  computeVideoMetrics,
  cumulativeAsOf,
  engagementAt,
  growthVsPrevious,
  outperformanceOf,
  rankValue,
  sourceWindowImplausibility,
  sourceWindowValue,
  velocityAt,
  windowIncrement,
  type MetricContext,
} from '../src/metrics.ts';
import { localDateStartUtc, presetRange, resolveWindow, rollingWindow } from '../src/time.ts';
import { queryVideos } from '../src/query.ts';
import type { AgeDays, DateMode, UtcWindow, Video } from '../src/types.ts';
import type { DatasetIndex } from '../src/dataset.ts';
import { DAY_MS, HOUR_MS, makeIndex, makeObs, makeSourceWindow, makeVideo, obsOf, ts } from './fixtures.ts';

const H = HOUR_MS;
const D = DAY_MS;
const SEOUL = 'Asia/Seoul';
const SYD = 'Australia/Sydney';

function ctx(mode: DateMode, window: UtcWindow | null, now: number, index: DatasetIndex, ageDays: AgeDays | null = null): MetricContext {
  return { mode, window, now, index, ageDays };
}

function rankOrder(videos: Video[], key: (v: Video) => number | null): string[] {
  return videos
    .map((v) => ({ id: v.id, r: key(v) }))
    .filter((x) => x.r !== null)
    .sort((a, b) => (b.r as number) - (a.r as number))
    .map((x) => x.id);
}

describe('design doc §5 worked example (A/B/C)', () => {
  // September has finished and every boundary was observed exactly.
  const now = ts('2026-10-02T00:00Z');
  const sep = resolveWindow({ start: '2026-09-01', end: '2026-09-30' }, SEOUL, now);
  const A = makeVideo({ id: 'youtube:A', accountId: 'youtube:a', publishedAt: ts('2026-08-12'), obs: [makeObs(sep.startMs, 1_000_000), makeObs(sep.endMs, 6_000_000)] });
  const B = makeVideo({ id: 'youtube:B', accountId: 'youtube:b', publishedAt: ts('2026-09-10'), obs: [makeObs(ts('2026-09-10T08:00Z'), 30_000), makeObs(sep.endMs, 2_000_000)] });
  const C = makeVideo({ id: 'youtube:C', accountId: 'youtube:c', publishedAt: ts('2026-09-18'), obs: [makeObs(ts('2026-09-18T08:00Z'), 9_000), makeObs(sep.endMs, 800_000)] });
  const index = makeIndex({ videos: [A, B, C], generatedAt: now });

  it('activity mode: September increase ranks A (5,000,000) > B (2,000,000) > C (800,000)', () => {
    const m = (v: Video) => computeVideoMetrics(v, ctx('activity', sep, now, index));
    expect(m(A).viewsPeriod).toEqual({ value: 5_000_000, status: 'exact', asOf: sep.endMs, note: null });
    expect(m(B).viewsPeriod).toMatchObject({ value: 2_000_000, status: 'exact' });
    expect(m(C).viewsPeriod).toMatchObject({ value: 800_000, status: 'exact' });
    expect(rankOrder([C, A, B], (v) => rankValue(m(v).viewsPeriod))).toEqual(['youtube:A', 'youtube:B', 'youtube:C']);
  });

  it('upload mode: B > C among September uploads; A is published before the window (excluded by the query)', () => {
    const m = (v: Video) => computeVideoMetrics(v, ctx('upload', sep, now, index));
    // Values are the latest ones as of `now` (design doc section 5: current views of September uploads). The last
    // observation is 9h before now, so they are lower bounds (the count can only have grown since).
    expect(m(B).viewsPeriod).toMatchObject({ value: 2_000_000, status: 'lower_bound', asOf: sep.endMs });
    expect(m(C).viewsPeriod).toMatchObject({ value: 800_000, status: 'lower_bound' });
    // A's value since publish is its cumulative 6,000,000; the upload filter (publishedAt in window) is applied
    // by queryVideos, not here.
    expect(m(A).viewsPeriod).toMatchObject({ value: 6_000_000, status: 'lower_bound' });
    expect(A.publishedAt).toBeLessThan(sep.startMs);
    const uploads = [A, B, C].filter((v) => v.publishedAt >= sep.startMs && v.publishedAt < sep.endMs);
    expect(rankOrder(uploads, (v) => rankValue(m(v).viewsPeriod))).toEqual(['youtube:B', 'youtube:C']);
    expect(m(B).viewsTotal).toEqual(m(B).viewsPeriod);
  });

  it('upload mode reads current values even when no observation lies near the (finished) window end', () => {
    // Discovered after September ended: one observation on 10-01 23:00Z, one hour before now.
    const late = makeVideo({ id: 'youtube:late', publishedAt: ts('2026-09-20'), obs: [makeObs(now - H, 70_000)] });
    const m = computeVideoMetrics(late, ctx('upload', sep, now, makeIndex({ videos: [late] })));
    expect(m.viewsTotal).toEqual({ value: 70_000, status: 'exact', asOf: now - H, note: null });
    expect(m.viewsPeriod).toEqual(m.viewsTotal);
    expect(rankValue(m.viewsTotal)).toBe(70_000);
  });

  it('on the research date (2026-09-28) September is an incomplete window and values are as of now', () => {
    const today = ts('2026-09-28T03:00Z');
    const w = resolveWindow({ start: '2026-09-01', end: '2026-09-30' }, SEOUL, today);
    expect(w.incomplete).toBe(true);
    const v = makeVideo({ publishedAt: ts('2026-08-12'), obs: [makeObs(w.startMs, 1_000_000), makeObs(today - H, 5_500_000), makeObs(w.endMs, 6_000_000)] });
    const m = computeVideoMetrics(v, ctx('activity', w, today, makeIndex({ videos: [v] })));
    expect(m.viewsPeriod).toEqual({ value: 4_500_000, status: 'exact', asOf: today - H, note: null });
    expect(m.viewsTotal).toMatchObject({ value: 5_500_000, asOf: today - H });
  });
});

describe('design doc §13 metric-level scenarios', () => {
  const now = ts('2026-09-28T03:00Z');
  const month = resolveWindow(presetRange('thisMonth', SEOUL, now), SEOUL, now);

  it('old video re-trending this month: large activity increment while upload window excludes it', () => {
    const old = makeVideo({
      id: 'youtube:old',
      publishedAt: ts('2023-05-01'),
      obs: [makeObs('2026-08-20', 150_000), makeObs(month.startMs, 152_000), makeObs('2026-09-14', 1_000_000), makeObs(now - 30 * 60_000, 4_152_000)],
    });
    const fresh = makeVideo({ id: 'youtube:new', publishedAt: ts('2026-09-10'), obs: [makeObs('2026-09-10T06:00Z', 1000), makeObs(now - H, 900_000)] });
    const index = makeIndex({ videos: [old, fresh] });
    const act = (v: Video) => computeVideoMetrics(v, ctx('activity', month, now, index)).viewsPeriod;
    expect(act(old)).toMatchObject({ value: 4_000_000, status: 'exact' });
    expect(act(fresh)).toMatchObject({ value: 900_000, status: 'exact' });
    expect(rankOrder([fresh, old], (v) => rankValue(act(v)))).toEqual(['youtube:old', 'youtube:new']);
    // upload semantics: only `fresh` is inside the window.
    expect(old.publishedAt < month.startMs).toBe(true);
    expect(fresh.publishedAt >= month.startMs && fresh.publishedAt < month.endMs).toBe(true);
    expect(month.incomplete).toBe(true);
  });

  it('hidden / not-provided counters stay null, never 0', () => {
    const v = makeVideo({
      publishedAt: ts('2026-09-02'),
      obs: [obsOf('2026-09-02T05:00Z', { views: 10, comments: 0 }), obsOf(now - H, { views: 1000, comments: 20 })],
    });
    const m = computeVideoMetrics(v, ctx('activity', month, now, makeIndex({ videos: [v] })));
    expect(m.likesPeriod).toEqual({ value: null, status: 'unavailable', asOf: null, note: 'counter_not_provided' });
    expect(rankValue(m.likesPeriod)).toBeNull();
    expect(m.commentsPeriod).toMatchObject({ value: 20, status: 'exact' });
    expect(m.engagementRate).toMatchObject({ value: 0.02, status: 'exact', components: ['comments'] });
  });

  it('deleted / decreasing counter -> decrease_flagged and excluded from ranking', () => {
    const v = makeVideo({ publishedAt: ts('2026-08-01'), status: 'deleted', obs: [makeObs(month.startMs, 50_000), makeObs(now - H, 0)] });
    const m = computeVideoMetrics(v, ctx('activity', month, now, makeIndex({ videos: [v] })));
    expect(m.viewsPeriod).toMatchObject({ value: -50_000, status: 'decrease_flagged' });
    expect(rankValue(m.viewsPeriod)).toBeNull();
  });

  it('window starting before the first observation -> lower_bound (still rankable)', () => {
    const v = makeVideo({ publishedAt: ts('2025-01-01'), obs: [makeObs('2026-09-15', 10_000), makeObs(now - H, 25_000)] });
    const m = computeVideoMetrics(v, ctx('activity', month, now, makeIndex({ videos: [v] })));
    expect(m.viewsPeriod).toMatchObject({ value: 15_000, status: 'lower_bound', note: 'before_first_observation' });
    expect(rankValue(m.viewsPeriod)).toBe(15_000);
  });

  it('gap too wide -> unavailable', () => {
    const w = resolveWindow({ start: '2026-09-10', end: '2026-09-12' }, SEOUL, now);
    const v = makeVideo({ publishedAt: ts('2025-01-01'), obs: [makeObs('2026-09-01', 10_000), makeObs('2026-09-20', 25_000)] });
    const m = computeVideoMetrics(v, ctx('activity', w, now, makeIndex({ videos: [v] })));
    expect(m.viewsPeriod).toEqual({ value: null, status: 'unavailable', asOf: null, note: 'gap_too_wide' });
    expect(m.viewsTotal).toMatchObject({ value: 10_000, status: 'lower_bound', note: 'gap_too_wide' });
  });

  it('V1/V7/V30 not_reached for a 3-day-old video', () => {
    const pub = now - 3 * D - 2 * H;
    const v = makeVideo({ publishedAt: pub, obs: [makeObs(pub + 12 * H, 500), makeObs(pub + 24 * H, 1000), makeObs(pub + 30 * H, 1300)] });
    const ages = ageValues(v, now);
    expect(ages[1]).toMatchObject({ value: 1000, status: 'exact' });
    expect(ages[7]).toMatchObject({ status: 'unavailable', note: 'not_reached' });
    expect(ages[30]).toMatchObject({ status: 'unavailable', note: 'not_reached' });
    const index = makeIndex({ videos: [v] });
    const m7 = computeVideoMetrics(v, ctx('age', null, now, index, 7));
    expect(m7.viewsAtAge.note).toBe('not_reached');
    expect(m7.viewsPeriod).toEqual(m7.viewsAtAge);
    expect(rankValue(m7.viewsAtAge)).toBeNull();
    const m1 = computeVideoMetrics(v, ctx('age', null, now, index, 1));
    expect(m1.viewsAtAge).toMatchObject({ value: 1000, status: 'exact' });
    expect(m1.viewsPeriod).toEqual(m1.viewsAtAge);
  });

  it('DST-boundary daily window in Australia/Sydney (23h day)', () => {
    const obs = [];
    for (let i = 0; i <= 24 * 5; i++) obs.push(makeObs(ts('2026-10-01') + i * H, i * 100));
    const v = makeVideo({ publishedAt: ts('2026-09-01'), obs });
    const later = ts('2026-10-20');
    const day = resolveWindow({ start: '2026-10-04', end: '2026-10-04' }, SYD, later);
    const m = computeVideoMetrics(v, ctx('activity', day, later, makeIndex({ videos: [v] })));
    expect(m.viewsPeriod).toMatchObject({ value: 2300, status: 'exact' });
  });
});

describe('source_reported fallback (activity mode)', () => {
  const now = ts('2026-09-28T14:30Z'); // 23:30 in Seoul
  const tracked = (extra: Partial<Video> = {}) =>
    makeVideo({
      publishedAt: ts('2025-06-01'),
      obs: [makeObs(now - 48 * H, 100_000), makeObs(now - 20 * 60_000, 104_000)],
      ...extra,
    });

  it('uses a matching SourceWindowMetric when observations only give a lower bound', () => {
    const w = resolveWindow(presetRange('last7d', SEOUL, now), SEOUL, now); // ends 30 min after now, 168h long
    expect(w.endMs - now).toBe(30 * 60_000);
    const v = tracked({ sourceWindows: [makeSourceWindow('views', 168, 31_000, now - 10 * 60_000), makeSourceWindow('views', 24, 2_000, now - 10 * 60_000)] });
    const m = computeVideoMetrics(v, ctx('activity', w, now, makeIndex({ videos: [v] })));
    expect(m.viewsPeriod).toEqual({ value: 31_000, status: 'source_reported', asOf: now - 10 * 60_000, note: 'source_window' });
    expect(rankValue(m.viewsPeriod)).toBe(31_000);
  });

  it('matches 24h windows too, and likes when the source reports them', () => {
    const w: UtcWindow = { startMs: now - 24 * H, endMs: now, tz: 'UTC', incomplete: false };
    const v = makeVideo({
      publishedAt: ts('2025-06-01'),
      obs: [obsOf(now - 5 * H, { views: 10_000, likes: 100 }), obsOf(now - 60_000, { views: 10_500, likes: 102 })],
      sourceWindows: [makeSourceWindow('views', 24, 2_500, now - H), makeSourceWindow('likes', 24, 30, now - H)],
    });
    const m = computeVideoMetrics(v, ctx('activity', w, now, makeIndex({ videos: [v] })));
    expect(m.viewsPeriod).toMatchObject({ value: 2_500, status: 'source_reported' });
    expect(m.likesPeriod).toMatchObject({ value: 30, status: 'source_reported' });
    expect(m.commentsPeriod).toMatchObject({ status: 'unavailable', note: 'counter_not_provided' });
  });

  it('is not used when observations cover the window', () => {
    const w: UtcWindow = { startMs: now - 24 * H, endMs: now, tz: 'UTC', incomplete: false };
    const v = makeVideo({
      publishedAt: ts('2025-06-01'),
      obs: [makeObs(now - 24 * H, 1000), makeObs(now, 1500)],
      sourceWindows: [makeSourceWindow('views', 24, 9_999, now)],
    });
    expect(computeVideoMetrics(v, ctx('activity', w, now, makeIndex({ videos: [v] }))).viewsPeriod).toMatchObject({ value: 500, status: 'exact' });
  });

  it('is not used when the window does not end at now, the length differs, or it was observed at another time', () => {
    const v = tracked({ sourceWindows: [makeSourceWindow('views', 168, 31_000, now - 10 * 60_000)] });
    const endsEarlier: UtcWindow = { startMs: now - 5 * H - 168 * H, endMs: now - 5 * H, tz: 'UTC', incomplete: false };
    expect(sourceWindowValue(v, 'views', endsEarlier, now)).toBeNull();
    const longer: UtcWindow = { startMs: now - 170 * H, endMs: now, tz: 'UTC', incomplete: false };
    expect(sourceWindowValue(v, 'views', longer, now)).toBeNull();
    const withinHour: UtcWindow = { startMs: now - 168.5 * H, endMs: now, tz: 'UTC', incomplete: false };
    expect(sourceWindowValue(v, 'views', withinHour, now)).not.toBeNull();
    const stale = tracked({ sourceWindows: [makeSourceWindow('views', 168, 31_000, now - 3 * H)] });
    expect(sourceWindowValue(stale, 'views', { startMs: now - 168 * H, endMs: now, tz: 'UTC', incomplete: false }, now)).toBeNull();
    const m = computeVideoMetrics(v, ctx('activity', endsEarlier, now, makeIndex({ videos: [v] })));
    expect(m.viewsPeriod.status).toBe('lower_bound');
  });

  it('upload mode never uses source windows', () => {
    const w = resolveWindow(presetRange('last7d', SEOUL, now), SEOUL, now);
    const v = tracked({ sourceWindows: [makeSourceWindow('views', 168, 31_000, now - 10 * 60_000)] });
    expect(computeVideoMetrics(v, ctx('upload', w, now, makeIndex({ videos: [v] }))).viewsPeriod.status).not.toBe('source_reported');
  });
});

describe('implausible source windows (Dailymotion views_last_month = lifetime views)', () => {
  // Real example: dailymotion:x9jdbui, published 2025-05-12, 66,191 lifetime views, w24 = 0, w168 = 0, w720 = 66,191
  const T = ts('2026-09-28T15:26:16Z');
  const old = makeVideo({
    id: 'dailymotion:x9jdbui',
    publishedAt: ts('2025-05-12T11:31:49Z'),
    obs: [makeObs(T - 10 * 60_000, 66_191)],
    sourceWindows: [makeSourceWindow('views', 24, 0, T), makeSourceWindow('views', 168, 0, T), makeSourceWindow('views', 720, 66_191, T)],
  });
  const w720 = rollingWindow(720, T, SEOUL);

  it('a window value equal to the lifetime count of a video older than the window is rejected', () => {
    expect(sourceWindowImplausibility(old, old.sourceWindows[2])).toBe('window_equals_lifetime');
    expect(sourceWindowValue(old, 'views', w720, T)).toBeNull();
    expect(windowIncrement(old, 'views', w720, T)).toEqual({ value: null, status: 'unavailable', asOf: null, note: 'source_window_implausible' });
    // the day / week windows of the same report are consistent (0 for an inactive old video) and still used
    expect(sourceWindowImplausibility(old, old.sourceWindows[0])).toBeNull();
    expect(windowIncrement(old, 'views', rollingWindow(24, T, SEOUL), T)).toMatchObject({ value: 0, status: 'source_reported' });
  });

  it('never ranks such a video as a 30-day riser', () => {
    const riser = makeVideo({
      id: 'dailymotion:new',
      publishedAt: T - 5 * D,
      obs: [makeObs(T - 10 * 60_000, 40_000)],
      sourceWindows: [makeSourceWindow('views', 720, 40_000, T)], // younger than 30 days: all its views are in the window
    });
    const r = queryVideos(makeIndex({ videos: [old, riser], generatedAt: T }), { dateMode: 'activity', rollingHours: 720, tz: SEOUL, sort: 'views_period' });
    expect(r.rows.map((x) => [x.video.id, x.metrics.viewsPeriod.status])).toEqual([
      ['dailymotion:new', 'exact'], // published inside the window: 0 at its start by definition
      ['dailymotion:x9jdbui', 'unavailable'],
    ]);
  });

  it('rejects windows larger than a later lifetime count, and inconsistent reports', () => {
    const v = makeVideo({ publishedAt: T - 3 * D, obs: [makeObs(T + 5 * 60_000, 1_000)], sourceWindows: [makeSourceWindow('views', 168, 5_000, T)] });
    expect(sourceWindowImplausibility(v, v.sourceWindows[0])).toBe('window_exceeds_lifetime');
    const inc = makeVideo({ publishedAt: T - 60 * D, sourceWindows: [makeSourceWindow('views', 24, 500, T), makeSourceWindow('views', 168, 100, T)] });
    expect(sourceWindowImplausibility(inc, inc.sourceWindows[0])).toBe('windows_inconsistent');
    expect(sourceWindowImplausibility(inc, inc.sourceWindows[1])).toBe('windows_inconsistent');
    // nothing to check against: plausible
    const bare = makeVideo({ publishedAt: T - 60 * D, sourceWindows: [makeSourceWindow('views', 168, 100, T)] });
    expect(sourceWindowImplausibility(bare, bare.sourceWindows[0])).toBeNull();
  });

  it('a source value below our own lower bound keeps the lower bound', () => {
    const v = makeVideo({
      publishedAt: ts('2025-01-01'),
      obs: [makeObs(T - 100 * H, 10_000), makeObs(T - 5 * 60_000, 20_000)],
      sourceWindows: [makeSourceWindow('views', 168, 3_000, T)],
    });
    expect(windowIncrement(v, 'views', rollingWindow(168, T, SEOUL), T)).toMatchObject({ value: 10_000, status: 'lower_bound' });
  });
});

describe('viewsTotal', () => {
  const now = ts('2026-09-28T03:00Z');
  it('exact when an observation is within 2h of min(window end, now)', () => {
    const v = makeVideo({ publishedAt: ts('2026-09-01'), obs: [makeObs(now - H, 1234)] });
    expect(cumulativeAsOf(v, 'views', now)).toEqual({ value: 1234, status: 'exact', asOf: now - H, note: null });
  });
  it('lower_bound from the latest earlier observation when the last observation is stale', () => {
    const v = makeVideo({ publishedAt: ts('2026-09-01'), obs: [makeObs(now - 10 * H, 1234)] });
    const m = computeVideoMetrics(v, ctx('age', null, now, makeIndex({ videos: [v] }), 1));
    expect(m.viewsTotal).toEqual({ value: 1234, status: 'lower_bound', asOf: now - 10 * H, note: 'after_last_observation' });
  });
  it('activity mode: as of the window end for past windows; upload / age mode: as of now', () => {
    const w = resolveWindow({ start: '2026-09-01', end: '2026-09-10' }, SEOUL, now);
    const v = makeVideo({ publishedAt: ts('2026-08-01'), obs: [makeObs(w.endMs - H, 500), makeObs(now - H, 9000)] });
    const idx = makeIndex({ videos: [v] });
    expect(computeVideoMetrics(v, ctx('activity', w, now, idx)).viewsTotal).toMatchObject({ value: 500, status: 'exact' });
    expect(computeVideoMetrics(v, ctx('upload', w, now, idx)).viewsTotal).toMatchObject({ value: 9000, status: 'exact', asOf: now - H });
    expect(computeVideoMetrics(v, ctx('age', w, now, idx, 7)).viewsTotal).toMatchObject({ value: 9000, status: 'exact', asOf: now - H });
  });
  it('unavailable when views are never provided', () => {
    const v = makeVideo({ publishedAt: ts('2026-09-01'), obs: [obsOf(now - H, { likes: 5 })] });
    expect(cumulativeAsOf(v, 'views', now)).toMatchObject({ value: null, status: 'unavailable', note: 'counter_not_provided' });
  });
});

describe('velocity', () => {
  const now = ts('2026-09-28T03:00Z');
  it('views per hour over the last 24h', () => {
    const obs = [];
    for (let i = 0; i <= 48; i++) obs.push(makeObs(now - 48 * H + i * H, i * 250));
    const v = makeVideo({ publishedAt: ts('2026-09-01'), obs });
    expect(velocityAt(v, now, now)).toMatchObject({ value: 250, status: 'exact' });
    // ending at a past window end
    expect(velocityAt(v, now - 10 * H, now)).toMatchObject({ value: 250, status: 'exact', asOf: now - 10 * H });
  });

  it('uses the time since publish for videos younger than 24h', () => {
    const pub = now - 6 * H;
    const v = makeVideo({ publishedAt: pub, obs: [makeObs(pub + H, 100), makeObs(now, 1200)] });
    expect(velocityAt(v, now, now)).toMatchObject({ value: 200, status: 'exact' });
  });

  it('falls back to the last two recent observations spanning >= 1h', () => {
    // The 24h start precedes the first observation and the last one is 3h old: the 24h increase is only a
    // lower bound, so the rate between the last two observations (>= 1h apart) is used.
    const v = makeVideo({ publishedAt: ts('2025-01-01'), obs: [makeObs(now - 20 * H, 300), makeObs(now - 3 * H - 30 * 60_000, 900), makeObs(now - 3 * H, 1000)] });
    const m = velocityAt(v, now, now);
    expect(m.status).toBe('interpolated');
    expect(m.note).toBe('last_two_observations');
    expect(m.asOf).toBe(now - 3 * H);
    expect(m.value).toBeCloseTo(700 / 17, 9); // skips the pair only 30 min apart
  });

  it('never ranks a stale pair of observations as the current velocity', () => {
    // Observed only while it was new (a video that left its channel's RSS feed): weeks-old pace.
    const stale = makeVideo({ id: 'youtube:stale', publishedAt: ts('2026-06-01'), obs: [makeObs('2026-07-01', 1_000), makeObs('2026-07-08', 1_000_000)] });
    expect(velocityAt(stale, now, now)).toMatchObject({ value: null, status: 'unavailable', note: 'stale_observations' });
    // The last observation is recent but the previous one is more than the interpolation gap (48h) older.
    const wide = makeVideo({ publishedAt: ts('2025-01-01'), obs: [makeObs(now - 10 * D, 300), makeObs(now - 3 * H, 1000)] });
    expect(velocityAt(wide, now, now)).toMatchObject({ status: 'unavailable', note: 'stale_observations' });
    const fresh = makeVideo({ id: 'youtube:fresh', publishedAt: ts('2026-09-01'), obs: [makeObs(now - 24 * H, 50_000), makeObs(now, 74_000)] });
    expect(velocityAt(fresh, now, now)).toMatchObject({ value: 1_000, status: 'exact' });
    const idx = makeIndex({ videos: [stale, fresh], generatedAt: now });
    const w: UtcWindow = { startMs: now - 24 * H, endMs: now, tz: SEOUL, incomplete: false };
    const order = rankOrder([stale, fresh], (x) => rankValue(computeVideoMetrics(x, ctx('activity', w, now, idx)).velocity));
    expect(order).toEqual(['youtube:fresh']);
  });

  it('unavailable with fewer than two usable observations; flagged when decreasing', () => {
    const one = makeVideo({ publishedAt: ts('2025-01-01'), obs: [makeObs(now - 30 * 60_000, 100)] });
    expect(velocityAt(one, now, now)).toMatchObject({ status: 'unavailable', note: 'insufficient_observations' });
    const down = makeVideo({ publishedAt: ts('2025-01-01'), obs: [makeObs(now - 24 * H, 1000), makeObs(now, 520)] });
    expect(velocityAt(down, now, now)).toMatchObject({ value: -20, status: 'decrease_flagged' });
    expect(velocityAt(makeVideo({ publishedAt: now + H }), now, now).status).toBe('unavailable');
  });
});

describe('growthVsPrev', () => {
  const now = ts('2026-10-01');
  const w = resolveWindow({ start: '2026-09-08', end: '2026-09-14' }, SEOUL, now);
  const at = (d: string) => localDateStartUtc(d, SEOUL);

  it('current window increase / previous equal-length window increase - 1', () => {
    const v = makeVideo({ publishedAt: ts('2026-08-01'), obs: [makeObs(at('2026-09-01'), 1000), makeObs(at('2026-09-08'), 2000), makeObs(at('2026-09-15'), 5000)] });
    const m = computeVideoMetrics(v, ctx('activity', w, now, makeIndex({ videos: [v] })));
    expect(m.growthVsPrev).toEqual({ value: 2, status: 'exact', asOf: at('2026-09-15'), note: null });
  });

  it('unavailable when previous is 0 or unknown', () => {
    const newer = makeVideo({ publishedAt: at('2026-09-09'), obs: [makeObs(at('2026-09-09') + H, 10), makeObs(at('2026-09-15'), 5000)] });
    expect(computeVideoMetrics(newer, ctx('activity', w, now, makeIndex({ videos: [newer] }))).growthVsPrev).toMatchObject({ status: 'unavailable', note: 'previous_zero' });
    const untracked = makeVideo({ publishedAt: ts('2025-01-01'), obs: [makeObs(at('2026-09-08'), 2000), makeObs(at('2026-09-15'), 5000)] });
    expect(computeVideoMetrics(untracked, ctx('activity', w, now, makeIndex({ videos: [untracked] }))).growthVsPrev).toMatchObject({ status: 'unavailable', note: 'previous_unavailable' });
    expect(computeVideoMetrics(untracked, ctx('age', null, now, makeIndex({ videos: [untracked] }), 7)).growthVsPrev).toMatchObject({ status: 'unavailable', note: 'no_window' });
  });

  it('a video published inside the previous window has no growth (its "previous" is the publish ramp)', () => {
    // Real example youtube:GP2L9avRBPc: published 1 minute before the previous day ended, first observed a day later
    const exportAt = ts('2026-09-28T15:26Z');
    const day = resolveWindow({ start: '2026-09-28', end: '2026-09-28' }, SEOUL, exportAt);
    const artefact = makeVideo({ id: 'youtube:GP2L9avRBPc', publishedAt: ts('2026-09-27T14:58:53Z'), obs: [makeObs(ts('2026-09-28T15:13:23Z'), 6_613)] });
    expect(growthVsPrevious(artefact, day, exportAt)).toEqual({ value: null, status: 'unavailable', asOf: null, note: 'published_in_previous_window' });
    const real = makeVideo({
      id: 'youtube:real',
      publishedAt: ts('2026-09-01'),
      obs: [makeObs(ts('2026-09-26T15:00Z'), 100_000), makeObs(ts('2026-09-27T15:00Z'), 200_000), makeObs(ts('2026-09-28T15:00Z'), 500_000)],
    });
    expect(growthVsPrevious(real, day, exportAt)).toMatchObject({ value: 2, status: 'exact' });
    const r = queryVideos(makeIndex({ videos: [artefact, real], generatedAt: exportAt }), { dateMode: 'activity', range: { start: '2026-09-28', end: '2026-09-28' }, tz: SEOUL, sort: 'growth_vs_prev' });
    expect(r.rows[0].video.id).toBe('youtube:real');
    expect(r.notes.some((n) => n.includes('100회 미만') && n.includes('직전 기간 중에 게시'))).toBe(true);
  });

  it('a previous increase below 100 views gives no growth', () => {
    const v = makeVideo({ publishedAt: ts('2026-08-01'), obs: [makeObs(at('2026-09-01'), 1000), makeObs(at('2026-09-08'), 1050), makeObs(at('2026-09-15'), 5000)] });
    expect(computeVideoMetrics(v, ctx('activity', w, now, makeIndex({ videos: [v] }))).growthVsPrev).toMatchObject({ status: 'unavailable', note: 'previous_too_small' });
  });

  it('an incomplete window is compared with the same elapsed span of the previous window', () => {
    const today = at('2026-09-11'); // 10 days into September
    const sep = resolveWindow({ start: '2026-09-01', end: '2026-09-30' }, SEOUL, today);
    const obs = [];
    for (let d = at('2026-07-01'); d <= today; d += D) obs.push(makeObs(d, Math.round((d - at('2026-07-01')) / D) * 100));
    const v = makeVideo({ publishedAt: ts('2026-06-01'), obs });
    const m = computeVideoMetrics(v, ctx('activity', sep, today, makeIndex({ videos: [v] })));
    expect(m.viewsPeriod).toMatchObject({ value: 1000, status: 'exact' });
    expect(m.growthVsPrev).toMatchObject({ value: 0, status: 'exact' });
  });
});

describe('engagementRate', () => {
  const now = ts('2026-09-28');
  it('sums the available components over views of the same observation', () => {
    const v = makeVideo({ obs: [obsOf(now - 5 * H, { views: 1000, likes: 50, comments: 10, shares: null })] });
    const e = engagementAt(v, now);
    expect(e.value).toBeCloseTo(0.06, 12);
    expect(e).toMatchObject({ status: 'exact', asOf: now - 5 * H, components: ['likes', 'comments'] });
  });

  it('uses the latest observation at or before asOf (window end)', () => {
    const v = makeVideo({ obs: [obsOf('2026-09-10', { views: 100, likes: 10 }), obsOf('2026-09-20', { views: 1000, likes: 10 })] });
    expect(engagementAt(v, ts('2026-09-15')).value).toBeCloseTo(0.1, 12);
    expect(engagementAt(v, ts('2026-09-25')).value).toBeCloseTo(0.01, 12);
  });

  it('niconico: on-video timeline comments are not engagement (likes / views only)', () => {
    // Real example niconico:sm46818535: 2,458 views, 132 likes, 7,103 comments -> 294% if comments counted
    const v = makeVideo({ id: 'niconico:sm46818535', obs: [obsOf(now - H, { views: 2_458, likes: 132, comments: 7_103 })] });
    const e = engagementAt(v, now);
    expect(e.value).toBeCloseTo(132 / 2_458, 12);
    expect(e.components).toEqual(['likes']);
    const commentsOnly = makeVideo({ id: 'niconico:sm2', obs: [obsOf(now - H, { views: 100, comments: 500 })] });
    expect(engagementAt(commentsOnly, now)).toMatchObject({ status: 'unavailable', note: 'counter_not_provided' });
  });

  it('unavailable (not 0) when no component is provided; zero views is not divided', () => {
    const none = makeVideo({ obs: [obsOf(now - H, { views: 1000 })] });
    expect(engagementAt(none, now)).toEqual({ value: null, status: 'unavailable', asOf: null, note: 'counter_not_provided', components: [] });
    const zero = makeVideo({ obs: [obsOf(now - H, { views: 0, likes: 0 })] });
    expect(engagementAt(zero, now).note).toBe('zero_views');
    expect(engagementAt(makeVideo({ obs: [] }), now).note).toBe('before_first_observation');
  });
});

describe('outperformance', () => {
  const now = ts('2026-09-28');
  /** A video of `acc` whose views grow linearly: `perDay` views per day, observed daily. */
  function video(id: string, acc: string, publishedAt: number, perDay: number, days: number) {
    const obs = [];
    for (let d = 1; d <= days; d++) obs.push(makeObs(publishedAt + d * D, d * perDay));
    return makeVideo({ id, accountId: acc, publishedAt, obs });
  }

  it('ratio to the median of same-account peers at the largest reached age', () => {
    const acc = 'youtube:chan';
    const pub = now - 12 * D; // V30 not reached for anyone -> V7
    const peers = [video('youtube:p1', acc, pub, 10, 12), video('youtube:p2', acc, pub - D, 20, 13), video('youtube:p3', acc, pub - 2 * D, 30, 14)];
    const target = video('youtube:t', acc, pub, 60, 12);
    const index = makeIndex({ videos: [...peers, target] });
    const m = computeVideoMetrics(target, ctx('activity', null, now, index));
    expect(m.outperformance).toMatchObject({ value: 3, status: 'exact', ageDays: 7, peers: 3 });
    // A peer's own ratio uses the others (incl. target): p1 V7 = 70, others 140, 210, 420 -> median 210.
    expect(outperformanceOf(peers[0], index, now)).toMatchObject({ value: 70 / 210, ageDays: 7, peers: 3 });
  });

  it('prefers V30 when this video and >= 3 peers reached it', () => {
    const acc = 'youtube:big';
    const vids = [0, 1, 2, 3].map((i) => video(`youtube:b${i}`, acc, now - 40 * D - i * D, (i + 1) * 10, 40));
    const index = makeIndex({ videos: vids });
    const m = outperformanceOf(vids[3], index, now);
    expect(m).toMatchObject({ ageDays: 30, peers: 3, status: 'exact' });
    expect(m.value).toBeCloseTo(1200 / 600, 12); // 40*30 vs median(300, 600, 900)
  });

  it('falls back to a smaller age when V30 peers are too few', () => {
    const acc = 'youtube:mixed';
    const old = video('youtube:o', acc, now - 40 * D, 10, 40);
    const young = [1, 2, 3].map((i) => video(`youtube:y${i}`, acc, now - 10 * D, i * 10, 10));
    const index = makeIndex({ videos: [old, ...young] });
    expect(outperformanceOf(old, index, now)).toMatchObject({ ageDays: 7, peers: 3, value: 70 / 140 });
  });

  it('unavailable with fewer than 3 peers, not reached, or zero median', () => {
    const acc = 'youtube:small';
    const vids = [0, 1, 2].map((i) => video(`youtube:s${i}`, acc, now - 10 * D, 10, 10));
    const index = makeIndex({ videos: vids });
    expect(outperformanceOf(vids[0], index, now)).toMatchObject({ status: 'unavailable', note: 'not_enough_peers', ageDays: null, peers: 2 });
    const baby = makeVideo({ id: 'youtube:baby', accountId: acc, publishedAt: now - 5 * H, obs: [makeObs(now - H, 5)] });
    expect(outperformanceOf(baby, makeIndex({ videos: [...vids, baby] }), now)).toMatchObject({ status: 'unavailable', note: 'not_reached', peers: 0 });
    const zeros = [0, 1, 2].map((i) => video(`youtube:z${i}`, 'youtube:zero', now - 10 * D, 0, 10));
    const star = video('youtube:star', 'youtube:zero', now - 10 * D, 100, 10);
    expect(outperformanceOf(star, makeIndex({ videos: [...zeros, star] }), now)).toMatchObject({ status: 'unavailable', note: 'peer_median_zero' });
  });

  it('peers without a readable value at that age do not count', () => {
    const acc = 'youtube:gappy';
    const good = [1, 2, 3].map((i) => video(`youtube:g${i}`, acc, now - 10 * D, i * 10, 10));
    const gap = makeVideo({ id: 'youtube:gap', accountId: acc, publishedAt: now - 10 * D, obs: [makeObs(now - 8.5 * D, 5), makeObs(now - D, 50)] });
    const index = makeIndex({ videos: [...good, gap] });
    // gap has no readable V7/V3 (gap too wide) nor V1 (first observation 36h after publish).
    expect(outperformanceOf(good[0], index, now)).toMatchObject({ status: 'unavailable', note: 'not_enough_peers', peers: 2 });
    expect(outperformanceOf(gap, index, now)).toMatchObject({ status: 'unavailable', note: 'gap_too_wide' });
  });

  it('is computed once per (account, age, now): 3000 same-account videos stay fast', () => {
    const acc = 'youtube:huge';
    const vids: Video[] = [];
    for (let i = 0; i < 3000; i++) {
      const pub = now - (8 + (i % 30)) * D;
      vids.push(makeVideo({ id: `youtube:h${i}`, accountId: acc, publishedAt: pub, obs: [makeObs(pub + 6 * D, i * 6), makeObs(pub + 8 * D, i * 8), makeObs(now - H, i * 10)] }));
    }
    const index = makeIndex({ videos: vids });
    const w = resolveWindow({ start: '2026-09-01', end: '2026-09-27' }, SEOUL, now);
    const t0 = performance.now();
    let ok = 0;
    for (const v of vids) if (computeVideoMetrics(v, ctx('activity', w, now, index)).outperformance.status !== 'unavailable') ok++;
    const elapsed = performance.now() - t0;
    expect(ok).toBe(3000);
    expect(elapsed).toBeLessThan(3000);
  });
});

describe('bundle details', () => {
  const now = ts('2026-09-28');
  const v = makeVideo({
    publishedAt: now - 10 * D,
    obs: [obsOf(now - 9 * D, { views: 100, likes: 1 }), obsOf(now - 3 * D, { views: 700, likes: 7 }), obsOf(now - H, { views: 1000, likes: 10 })],
  });
  const index = makeIndex({ videos: [v] });

  it('percentile is left for queryVideos', () => {
    expect(computeVideoMetrics(v, ctx('upload', null, now, index)).percentile).toMatchObject({ value: null, status: 'unavailable' });
  });

  it('age mode mirrors viewsAtAge into viewsPeriod and uses the same age for likes', () => {
    const m = computeVideoMetrics(v, ctx('age', null, now, index, 7));
    expect(m.viewsAtAge).toMatchObject({ value: 700, status: 'exact' });
    expect(m.viewsPeriod).toEqual(m.viewsAtAge);
    expect(m.likesPeriod).toMatchObject({ value: 7, status: 'exact' });
    expect(m.commentsPeriod).toMatchObject({ status: 'unavailable', note: 'counter_not_provided' });
  });

  it('viewsAtAge is computed in other modes only when an age is given', () => {
    expect(computeVideoMetrics(v, ctx('upload', null, now, index)).viewsAtAge).toMatchObject({ status: 'unavailable', note: 'no_age_selected' });
    expect(computeVideoMetrics(v, ctx('upload', null, now, index, 7)).viewsAtAge).toMatchObject({ value: 700 });
    expect(computeVideoMetrics(v, ctx('age', null, now, index)).viewsPeriod).toMatchObject({ status: 'unavailable', note: 'no_age_selected' });
    expect(computeVideoMetrics(v, ctx('activity', null, now, index)).viewsPeriod).toMatchObject({ status: 'unavailable', note: 'no_window' });
  });

  it('upload mode without a window counts since publish as of now', () => {
    expect(computeVideoMetrics(v, ctx('upload', null, now, index)).viewsPeriod).toMatchObject({ value: 1000, status: 'exact' });
  });
});

describe('rankValue', () => {
  it('ranks exact / interpolated / lower_bound / source_reported; never unavailable or decrease_flagged', () => {
    expect(rankValue({ value: 5, status: 'exact' })).toBe(5);
    expect(rankValue({ value: 4.5, status: 'interpolated' })).toBe(4.5);
    expect(rankValue({ value: 3, status: 'lower_bound' })).toBe(3);
    expect(rankValue({ value: 7, status: 'source_reported' })).toBe(7);
    expect(rankValue({ value: 0, status: 'exact' })).toBe(0);
    expect(rankValue({ value: null, status: 'unavailable' })).toBeNull();
    expect(rankValue({ value: -3, status: 'decrease_flagged' })).toBeNull();
    expect(rankValue({ value: 3, status: 'unavailable' })).toBeNull();
    expect(rankValue({ value: null, status: 'exact' })).toBeNull();
    expect(rankValue({ value: Number.NaN, status: 'exact' })).toBeNull();
    expect(rankValue({ value: 1, status: 'bogus' })).toBeNull();
  });
});
