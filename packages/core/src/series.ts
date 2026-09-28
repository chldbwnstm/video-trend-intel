/**
 * Observation-series math. The single source of truth for "what was the counter at time t"
 * and "how much did it grow in [a, b)". Every function returns a MetricValue with an honest
 * status (see MetricStatus in types.ts). OWNER: core-metrics agent.
 *
 * Notes (machine-readable `MetricValue.note` values produced here)
 * - before_publish            t <= publishedAt, value 0 by definition ('exact').
 * - counter_not_provided      the source never provided this counter, or the observations that
 *                             would have been used have it `null` (never treated as 0).
 * - before_first_observation  t is after publish but before our first observation (not anchorable).
 * - after_last_observation    t is beyond our last observation (+ tolerance).
 * - gap_too_wide              bracketing observations are further apart than the allowed gap.
 * - not_reached               valueAtAge: publishedAt + ageDays is after `now`.
 * - published_after_window    increment: video published at/after the (clipped) window end -> 0.
 * - empty_window              increment: endMs <= startMs -> 0.
 * - window_not_started        increment: window starts at/after `now`.
 * - counter_decreased         increment went negative ('decrease_flagged').
 * For 'lower_bound' increments the note is the reason the unknown boundary could not be read
 * (e.g. before_first_observation, after_last_observation, gap_too_wide).
 */
import type { AgeDays, MetricKey, MetricValue, ObservationPoint, Video } from './types.ts';
import { DAY, HOUR, addDays, daysBetween, localDateStartUtc } from './time.ts';

export interface SeriesOptions {
  /**
   * An observation within this distance of the requested instant counts as 'exact'. Default 2h.
   * For window increments it is further capped at BOUNDARY_TOLERANCE_WINDOW_FRACTION of the (clipped) window.
   */
  boundaryToleranceMs?: number;
  /** Max gap between two bracketing observations for 'interpolated'. Default 48h (age metrics: see valueAtAge). */
  maxInterpolationGapMs?: number;
}

export const DEFAULT_BOUNDARY_TOLERANCE_MS = 2 * HOUR;
export const DEFAULT_MAX_INTERPOLATION_GAP_MS = 48 * HOUR;
/**
 * For an increment over [start, end) a boundary observation counts as 'exact' only when it is within
 * min(boundary tolerance, this fraction of the clipped window length) of the boundary. The views gained in
 * the uncovered offset are missing from (or added to) the increment, so a fixed 2h tolerance would call a
 * 26-minute "today" window 'exact' from observations 13 minutes off each boundary (half the window). With 5%
 * the error of an 'exact' increment stays around 10% at worst for a steady counter; a 24h window keeps a
 * 72-minute tolerance, a 7-day window the full 2h. Boundaries further off are interpolated between
 * bracketing observations or fall back to 'lower_bound'.
 */
export const BOUNDARY_TOLERANCE_WINDOW_FRACTION = 0.05;

/* ------------------------------------------------------------------------------------------
 * Cached per-metric series (non-null points only)
 * ---------------------------------------------------------------------------------------- */

/** Observations of one counter where it was provided (non-null, finite), ascending by t. */
export interface MetricSeries {
  t: number[];
  v: number[];
  /** nullBetween[i]: some observation with this counter null lies between point i-1 and point i. */
  nullBetween: boolean[];
  /** Some observation with this counter null lies before the first point (or anywhere, if no points). */
  nullBefore: boolean;
  /** Some observation with this counter null lies after the last point (or anywhere, if no points). */
  nullAfter: boolean;
}

interface SeriesCacheEntry {
  len: number;
  first: ObservationPoint | undefined;
  last: ObservationPoint | undefined;
  sorted: ObservationPoint[];
  byMetric: Partial<Record<MetricKey, MetricSeries>>;
}

const seriesCache = new WeakMap<ObservationPoint[], SeriesCacheEntry>();

function cacheEntry(video: Video): SeriesCacheEntry {
  const obs = video.obs ?? [];
  const n = obs.length;
  const hit = seriesCache.get(obs);
  if (hit && hit.len === n && hit.first === obs[0] && hit.last === obs[n - 1]) return hit;
  let sorted = obs;
  for (let i = 1; i < n; i++) {
    if (obs[i].t < obs[i - 1].t) {
      sorted = [...obs].sort((a, b) => a.t - b.t);
      break;
    }
  }
  const entry: SeriesCacheEntry = { len: n, first: obs[0], last: obs[n - 1], sorted, byMetric: {} };
  seriesCache.set(obs, entry);
  return entry;
}

function isNum(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

/** Observations of `video` sorted by t ascending (the input order when already sorted). */
export function sortedObservations(video: Video): ObservationPoint[] {
  return cacheEntry(video).sorted;
}

/** Non-null points of `metric` for `video` (cached; do not mutate the result). */
export function metricSeries(video: Video, metric: MetricKey): MetricSeries {
  const entry = cacheEntry(video);
  const cached = entry.byMetric[metric];
  if (cached) return cached;
  const t: number[] = [];
  const v: number[] = [];
  const nullBetween: boolean[] = [];
  let nullBefore = false;
  let pendingNull = false;
  for (const p of entry.sorted) {
    const val = p[metric];
    if (isNum(val)) {
      if (t.length === 0) nullBefore = pendingNull;
      nullBetween.push(t.length > 0 && pendingNull);
      t.push(p.t);
      v.push(val);
      pendingNull = false;
    } else {
      pendingNull = true;
    }
  }
  const s: MetricSeries = { t, v, nullBetween, nullBefore: t.length ? nullBefore : pendingNull, nullAfter: pendingNull };
  entry.byMetric[metric] = s;
  return s;
}

/** First index i with arr[i] >= x (arr ascending). */
function lowerBound(arr: ArrayLike<number>, x: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index i with arr[i] > x (arr ascending). */
function upperBound(arr: ArrayLike<number>, x: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/* ------------------------------------------------------------------------------------------
 * MetricValue constructors
 * ---------------------------------------------------------------------------------------- */

/** An 'unavailable' MetricValue with a machine-readable note. */
export function unavailableMetric(note: string | null): MetricValue {
  return { value: null, status: 'unavailable', asOf: null, note };
}

function mv(value: number, status: MetricValue['status'], asOf: number | null, note: string | null = null): MetricValue {
  return { value, status, asOf, note };
}

/** exact or interpolated (the statuses that describe a known value at an instant / over a window). */
export function isKnownMetric(m: MetricValue): boolean {
  return (m.status === 'exact' || m.status === 'interpolated') && m.value !== null;
}

/* ------------------------------------------------------------------------------------------
 * Core lookups
 * ---------------------------------------------------------------------------------------- */

/**
 * valueAt on a prepared series. An 'exact' value snapped to an observation has `note === null` and
 * `asOf` = that observation's time (increment() relies on this to know which observation carries
 * the information).
 */
function valueAtSeries(
  publishedAt: number,
  s: MetricSeries,
  t: number,
  tol: number,
  maxGap: number,
): MetricValue {
  if (t <= publishedAt) return mv(0, 'exact', t, 'before_publish');
  const n = s.t.length;
  if (n === 0) return unavailableMetric('counter_not_provided');
  const next = lowerBound(s.t, t); // s.t[next] >= t
  const prev = next - 1; // s.t[prev] < t
  let best = -1;
  let bestD = Infinity;
  if (next < n) {
    const d = s.t[next] - t;
    if (d <= tol) {
      best = next;
      bestD = d;
    }
  }
  if (prev >= 0) {
    const d = t - s.t[prev];
    if (d <= tol && d < bestD) best = prev;
  }
  if (best >= 0) return mv(s.v[best], 'exact', s.t[best]);

  if (prev >= 0 && next < n) {
    const t0 = s.t[prev];
    const t1 = s.t[next];
    if (t1 - t0 <= maxGap) {
      const v0 = s.v[prev];
      const v1 = s.v[next];
      return mv(Math.round(v0 + ((v1 - v0) * (t - t0)) / (t1 - t0)), 'interpolated', t);
    }
    return unavailableMetric(s.nullBetween[next] ? 'counter_not_provided' : 'gap_too_wide');
  }
  if (next === 0) {
    // Before our first observation. The publish instant anchors (publishedAt, 0) only when the
    // first observation is close enough to it.
    const t1 = s.t[0];
    if (t1 > publishedAt && t1 - publishedAt <= maxGap) {
      return mv(Math.round((s.v[0] * (t - publishedAt)) / (t1 - publishedAt)), 'interpolated', t);
    }
    return unavailableMetric(s.nullBefore ? 'counter_not_provided' : 'before_first_observation');
  }
  return unavailableMetric(s.nullAfter ? 'counter_not_provided' : 'after_last_observation');
}

function tolOf(opts?: SeriesOptions): number {
  const x = opts?.boundaryToleranceMs;
  return isNum(x) && x >= 0 ? x : DEFAULT_BOUNDARY_TOLERANCE_MS;
}

function gapOf(opts: SeriesOptions | undefined, fallback: number): number {
  const x = opts?.maxInterpolationGapMs;
  return isNum(x) && x >= 0 ? x : fallback;
}

/**
 * Counter value at instant `t`.
 * - t < publishedAt -> 0 'exact' (by definition).
 * - observation within tolerance -> 'exact'.
 * - bracketed by observations with gap <= max -> 'interpolated' (linear in time).
 *   The publish instant acts as a synthetic (publishedAt, 0) anchor ONLY when the first real
 *   observation is within maxInterpolationGapMs of publishedAt.
 * - t after last observation: within tolerance -> 'exact' (last obs), else 'unavailable' note 'after_last_observation'.
 * - t before first observation (after publish, not anchorable) -> 'unavailable' note 'before_first_observation'.
 * - counter null in the relevant observations -> 'unavailable' note 'counter_not_provided'.
 *
 * Details: t == publishedAt is also 0 'exact'. 'exact' values carry the observation's own time as
 * `asOf`; interpolated values carry `t`. Interpolated counters are rounded to integers.
 */
export function valueAt(video: Video, metric: MetricKey, t: number, opts?: SeriesOptions): MetricValue {
  return valueAtSeries(
    video.publishedAt,
    metricSeries(video, metric),
    t,
    tolOf(opts),
    gapOf(opts, DEFAULT_MAX_INTERPOLATION_GAP_MS),
  );
}

/** Reference time a known boundary value carries information about. */
function refTime(m: MetricValue, fallback: number): number {
  return m.status === 'exact' && m.note === null && m.asOf !== null ? m.asOf : fallback;
}

/**
 * Increase of `metric` in half-open window [startMs, endMs), clipped to `now`.
 * - start boundary unknown but video published before start and observed later -> 'lower_bound'
 *   (value = v(end) - v(first observation inside window)).
 * - end boundary after last observation beyond tolerance -> 'lower_bound' using last observation.
 * - negative result -> 'decrease_flagged' (value kept, excluded from ranking).
 * - video published at/after endMs -> 0 'exact'.
 *
 * Details
 * - Both boundaries known: 'exact' when both are exact, otherwise 'interpolated'.
 * - Boundary tolerance: an observation counts as a boundary's exact value only within
 *   min(tolerance, BOUNDARY_TOLERANCE_WINDOW_FRACTION * (clipped window length)) of it, so a short window is
 *   never called exact from observations far off its boundaries.
 * - A window whose only information is one observation (both boundaries unreadable, one point inside) is
 *   'unavailable', never a fabricated 0.
 * - The same lower-bound fallback applies whenever a boundary is unreadable (gap too wide, counter
 *   hidden later): the nearest observation inside the window is used, which can only understate a
 *   non-decreasing counter. If no observation inside the window carries information, 'unavailable'.
 * - `asOf` = instant the end value refers to (observation time when snapped / fallen back).
 */
export function increment(
  video: Video,
  metric: MetricKey,
  startMs: number,
  endMs: number,
  now: number,
  opts?: SeriesOptions,
): MetricValue {
  if (!(endMs > startMs)) return mv(0, 'exact', Math.min(endMs, now), 'empty_window');
  const end = Math.min(endMs, now);
  if (end <= startMs) return unavailableMetric('window_not_started');
  if (video.publishedAt >= end) return mv(0, 'exact', end, 'published_after_window');

  const tol = Math.min(tolOf(opts), (end - startMs) * BOUNDARY_TOLERANCE_WINDOW_FRACTION);
  const maxGap = gapOf(opts, DEFAULT_MAX_INTERPOLATION_GAP_MS);
  const s = metricSeries(video, metric);
  const a = valueAtSeries(video.publishedAt, s, startMs, tol, maxGap);
  const b = valueAtSeries(video.publishedAt, s, end, tol, maxGap);
  // With tol <= 5% of the window, one observation can never be within tolerance of both boundaries (that
  // needs a tolerance of at least half the window), so the two snapped values always come from distinct
  // observations, in order. A fixed 2h tolerance used to let a 26-minute window read 0 'exact' from a single
  // observation serving as both boundaries.
  const aKnown = isKnownMetric(a);
  const bKnown = isKnownMetric(b);

  if (aKnown && bKnown) {
    const value = (b.value as number) - (a.value as number);
    if (value < 0) return mv(value, 'decrease_flagged', b.asOf, 'counter_decreased');
    return mv(value, a.status === 'exact' && b.status === 'exact' ? 'exact' : 'interpolated', b.asOf);
  }

  // Lower-bound fallback: replace an unreadable boundary by the nearest observation inside the window.
  let aVal: number;
  let aT: number;
  if (aKnown) {
    aVal = a.value as number;
    aT = refTime(a, startMs);
  } else {
    const i = lowerBound(s.t, startMs);
    if (i >= s.t.length || s.t[i] > end) return unavailableMetric(a.note);
    aVal = s.v[i];
    aT = s.t[i];
  }
  let bVal: number;
  let bT: number;
  if (bKnown) {
    bVal = b.value as number;
    bT = refTime(b, end);
  } else {
    const j = upperBound(s.t, end) - 1;
    if (j < 0 || s.t[j] < startMs) return unavailableMetric(b.note);
    bVal = s.v[j];
    bT = s.t[j];
  }
  // A single observation inside the window says nothing about the increase (never a fabricated 0).
  if (!(aT < bT)) return unavailableMetric(aKnown ? b.note : a.note);
  const value = bVal - aVal;
  if (value < 0) return mv(value, 'decrease_flagged', bT, 'counter_decreased');
  return mv(value, 'lower_bound', bT, aKnown ? b.note : a.note);
}

/** Max bracketing gap allowed for age metrics: max(6h, ageDays * 12h). */
export function ageMaxGapMs(ageDays: number): number {
  return Math.max(6 * HOUR, ageDays * 12 * HOUR);
}

/**
 * Counter at publishedAt + ageDays (Tubular "Video Ratings" V1/V2/V3/V7/V30).
 * - publishedAt + ageDays > now -> 'unavailable' note 'not_reached'.
 * - interpolation allowed only when the bracketing gap <= max(6h, ageDays * 12h).
 *   (An explicit `opts.maxInterpolationGapMs` overrides that rule.)
 */
export function valueAtAge(video: Video, metric: MetricKey, ageDays: AgeDays, now: number, opts?: SeriesOptions): MetricValue {
  const target = video.publishedAt + ageDays * DAY;
  if (target > now) return unavailableMetric('not_reached');
  return valueAtSeries(video.publishedAt, metricSeries(video, metric), target, tolOf(opts), gapOf(opts, ageMaxGapMs(ageDays)));
}

/**
 * Latest observed value at or before `t` (no interpolation). 'unavailable' if none.
 * `asOf` is the observation time. For t <= publishedAt with no observation the value is 0 'exact'.
 * Notes when unavailable: counter_not_provided (never provided / only null observations up to t),
 * before_first_observation.
 */
export function latestValue(video: Video, metric: MetricKey, t: number): MetricValue {
  const s = metricSeries(video, metric);
  const j = upperBound(s.t, t) - 1;
  if (j >= 0) return mv(s.v[j], 'exact', s.t[j]);
  if (t <= video.publishedAt) return mv(0, 'exact', t, 'before_publish');
  if (s.t.length === 0) return unavailableMetric('counter_not_provided');
  const sorted = sortedObservations(video);
  return unavailableMetric(sorted.length && sorted[0].t <= t ? 'counter_not_provided' : 'before_first_observation');
}

/**
 * Daily increments of `metric` for each local day in [startDate, endDate] (inclusive) in `tz`, for growth charts.
 * Each day is the half-open window [local 00:00, next local 00:00), so DST days are 23h / 25h long.
 * Days before publish are 0 'exact'; days at/after `now` are 'unavailable' ('window_not_started');
 * the current day is clipped to `now`. Returns [] when endDate < startDate; malformed dates throw RangeError.
 */
export function dailyIncrements(
  video: Video,
  metric: MetricKey,
  startDate: string,
  endDate: string,
  tz: string,
  now: number,
): { date: string; value: MetricValue }[] {
  const n = daysBetween(startDate, endDate);
  const out: { date: string; value: MetricValue }[] = [];
  let date = startDate;
  let dayStart = localDateStartUtc(date, tz);
  for (let i = 0; i <= n; i++) {
    const nextDate = addDays(date, 1);
    const nextStart = localDateStartUtc(nextDate, tz);
    out.push({ date, value: increment(video, metric, dayStart, nextStart, now) });
    date = nextDate;
    dayStart = nextStart;
  }
  return out;
}
