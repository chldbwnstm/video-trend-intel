/**
 * Per-video metric bundle for a query context. OWNER: core-metrics agent.
 */
import type { AgeDays, DateMode, MetricKey, MetricValue, UtcWindow, Video, VideoMetrics } from './types.ts';
import type { DatasetIndex } from './dataset.ts';
import { HOUR, previousWindow } from './time.ts';
import { increment, isKnownMetric, metricSeries, sortedObservations, unavailableMetric, valueAt, valueAtAge, latestValue } from './series.ts';

export interface MetricContext {
  mode: DateMode;
  /** Window for upload/activity modes (null in pure age mode without range). */
  window: UtcWindow | null;
  ageDays: AgeDays | null;
  now: number;
  index: DatasetIndex;
}

/** Tolerance for "the window ends at now" and for a source window's observedAt matching the window end. */
export const SOURCE_WINDOW_END_TOLERANCE_MS = 2 * HOUR;
/** Tolerance between the query window length and a SourceWindowMetric's windowHours. */
export const SOURCE_WINDOW_LENGTH_TOLERANCE_MS = HOUR;
/** Minimum same-account peers with a value at the same age for outperformance. */
export const OUTPERFORMANCE_MIN_PEERS = 3;
/** Ages tried for outperformance, largest first. */
export const OUTPERFORMANCE_AGES: readonly AgeDays[] = [30, 7, 3, 1];

const VELOCITY_SPAN_MS = 24 * HOUR;
const VELOCITY_MIN_SPAN_MS = HOUR;

/* ------------------------------------------------------------------------------------------
 * Building blocks (exported for detail views / other analytics)
 * ---------------------------------------------------------------------------------------- */

/**
 * A SourceWindowMetric that describes exactly `w` (window ends at `now` +-2h, a source window of the same
 * length +-1h observed at the window end +-2h), as a 'source_reported' MetricValue; null when none fits.
 * When several fit, the one observed closest to the window end wins.
 */
export function sourceWindowValue(video: Video, metric: MetricKey, w: UtcWindow, now: number): MetricValue | null {
  if (!video.sourceWindows?.length) return null;
  if (Math.abs(w.endMs - now) > SOURCE_WINDOW_END_TOLERANCE_MS) return null;
  const len = w.endMs - w.startMs;
  let best: Video['sourceWindows'][number] | null = null;
  let bestD = Infinity;
  for (const sw of video.sourceWindows) {
    if (sw.metric !== metric || typeof sw.value !== 'number' || !Number.isFinite(sw.value)) continue;
    if (Math.abs(len - sw.windowHours * HOUR) > SOURCE_WINDOW_LENGTH_TOLERANCE_MS) continue;
    const d = Math.abs(sw.observedAt - w.endMs);
    if (d > SOURCE_WINDOW_END_TOLERANCE_MS) continue;
    if (d < bestD) {
      best = sw;
      bestD = d;
    }
  }
  return best ? { value: best.value, status: 'source_reported', asOf: best.observedAt, note: 'source_window' } : null;
}

/**
 * Increase of `metric` over window `w` (clipped to `now`), falling back to a matching SourceWindowMetric
 * ('source_reported') when our observations cannot cover the window (unavailable / lower_bound).
 */
export function windowIncrement(
  video: Video,
  metric: MetricKey,
  w: UtcWindow,
  now: number,
  /** increment(video, metric, w.startMs, w.endMs, now) when already computed. */
  precomputed?: MetricValue,
): MetricValue {
  const inc = precomputed ?? increment(video, metric, w.startMs, w.endMs, now);
  if (inc.status === 'unavailable' || inc.status === 'lower_bound') {
    const src = sourceWindowValue(video, metric, w, now);
    if (src) return src;
  }
  return inc;
}

/**
 * Cumulative counter as of `t`: valueAt(t) when readable; otherwise the latest observation at or
 * before `t` as a 'lower_bound' (counters do not decrease, so the value at t is at least that).
 */
export function cumulativeAsOf(video: Video, metric: MetricKey, t: number): MetricValue {
  const v = valueAt(video, metric, t);
  if (isKnownMetric(v)) return v;
  const last = latestValue(video, metric, t);
  if (last.status === 'exact' && last.value !== null) {
    return { value: last.value, status: 'lower_bound', asOf: last.asOf, note: v.note };
  }
  return unavailableMetric(v.note);
}

/**
 * Views per hour over the ~24h ending at `end` (clipped to `now`). When the video was published inside that
 * span the rate is over the time since publish (at least 1h). Falls back to the last two observations at or
 * before `end` spanning >= 1h ('interpolated', note 'last_two_observations').
 */
export function velocityAt(video: Video, end: number, now: number): MetricValue {
  const e = Math.min(end, now);
  if (e <= video.publishedAt) return unavailableMetric('not_published');
  const s = e - VELOCITY_SPAN_MS;
  const inc = increment(video, 'views', s, e, now);
  if (inc.status === 'exact' || inc.status === 'interpolated' || inc.status === 'decrease_flagged') {
    const span = Math.max(e - Math.max(s, video.publishedAt), VELOCITY_MIN_SPAN_MS);
    return { value: (inc.value as number) / (span / HOUR), status: inc.status, asOf: inc.asOf, note: inc.note };
  }
  // Fallback: last two observations spanning >= 1h.
  const series = metricSeries(video, 'views');
  let j = series.t.length - 1;
  while (j >= 0 && series.t[j] > e) j--;
  if (j < 1) return unavailableMetric(series.t.length ? 'insufficient_observations' : 'counter_not_provided');
  let i = j - 1;
  while (i >= 0 && series.t[j] - series.t[i] < VELOCITY_MIN_SPAN_MS) i--;
  if (i < 0) return unavailableMetric('insufficient_observations');
  const dv = series.v[j] - series.v[i];
  const rate = dv / ((series.t[j] - series.t[i]) / HOUR);
  if (dv < 0) return { value: rate, status: 'decrease_flagged', asOf: series.t[j], note: 'counter_decreased' };
  return { value: rate, status: 'interpolated', asOf: series.t[j], note: 'last_two_observations' };
}

const ENGAGEMENT_COMPONENTS: MetricKey[] = ['likes', 'comments', 'shares'];

/**
 * (likes + comments + shares, whichever are non-null) / views, from the latest observation at or before `asOf`
 * that has views > 0 and at least one component. `components` lists what was summed. Missing counters are
 * never counted as 0.
 */
export function engagementAt(video: Video, asOf: number): MetricValue & { components: MetricKey[] } {
  const obs = sortedObservations(video);
  let sawZeroViews = false;
  for (let i = obs.length - 1; i >= 0; i--) {
    const p = obs[i];
    if (p.t > asOf) continue;
    const views = p.views;
    if (typeof views !== 'number' || !Number.isFinite(views)) continue;
    const components: MetricKey[] = [];
    let sum = 0;
    for (const k of ENGAGEMENT_COMPONENTS) {
      const c = p[k];
      if (typeof c === 'number' && Number.isFinite(c)) {
        components.push(k);
        sum += c;
      }
    }
    if (!components.length) continue;
    if (views <= 0) {
      sawZeroViews = true;
      continue;
    }
    return { value: sum / views, status: 'exact', asOf: p.t, note: null, components };
  }
  const note = sawZeroViews ? 'zero_views' : obs.some((p) => p.t <= asOf) ? 'counter_not_provided' : 'before_first_observation';
  return { ...unavailableMetric(note), components: [] };
}

/** V1/V2/V3/V7/V30 views (Tubular Video Ratings) for detail views. */
export function ageValues(video: Video, now: number, metric: MetricKey = 'views'): Record<AgeDays, MetricValue> {
  return {
    1: valueAtAge(video, metric, 1, now),
    2: valueAtAge(video, metric, 2, now),
    3: valueAtAge(video, metric, 3, now),
    7: valueAtAge(video, metric, 7, now),
    30: valueAtAge(video, metric, 30, now),
  };
}

/* ------------------------------------------------------------------------------------------
 * Outperformance (same-account peers at the same age), cached per (index, account, k, now)
 * ---------------------------------------------------------------------------------------- */

interface PeerTable {
  /** videoId -> views at age k (exact / interpolated only). */
  values: Map<string, { value: number; exact: boolean }>;
  /** All values ascending. */
  sorted: number[];
  nonExact: number;
}

const peerCache = new WeakMap<DatasetIndex, Map<string, PeerTable>>();
const PEER_CACHE_MAX = 200_000;

function peerTable(index: DatasetIndex, accountId: string, k: AgeDays, now: number): PeerTable {
  let byKey = peerCache.get(index);
  if (!byKey) {
    byKey = new Map();
    peerCache.set(index, byKey);
  }
  const key = `${accountId}\u0000${k}\u0000${now}`;
  const hit = byKey.get(key);
  if (hit) return hit;
  const values = new Map<string, { value: number; exact: boolean }>();
  const sorted: number[] = [];
  let nonExact = 0;
  for (const v of index.videosByAccount.get(accountId) ?? []) {
    if (values.has(v.id)) continue;
    const m = valueAtAge(v, 'views', k, now);
    if (!isKnownMetric(m)) continue;
    const exact = m.status === 'exact';
    values.set(v.id, { value: m.value as number, exact });
    sorted.push(m.value as number);
    if (!exact) nonExact++;
  }
  sorted.sort((a, b) => a - b);
  const table: PeerTable = { values, sorted, nonExact };
  if (byKey.size >= PEER_CACHE_MAX) byKey.clear();
  byKey.set(key, table);
  return table;
}

function lowerBoundNum(arr: number[], x: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Median of ascending `sorted` with one occurrence of `exclude` removed (if given). */
function medianExcluding(sorted: number[], exclude: number | null): number {
  let skip = -1;
  if (exclude !== null) {
    const i = lowerBoundNum(sorted, exclude);
    if (i < sorted.length && sorted[i] === exclude) skip = i;
  }
  const n = skip >= 0 ? sorted.length - 1 : sorted.length;
  const at = (i: number) => sorted[skip >= 0 && i >= skip ? i + 1 : i];
  return n % 2 === 1 ? at((n - 1) / 2) : (at(n / 2 - 1) + at(n / 2)) / 2;
}

/**
 * Views-at-age of `video` / median views-at-age of the same account's other videos, at the largest
 * k in [30, 7, 3, 1] where this video has a value and >= 3 peers do.
 */
export function outperformanceOf(
  video: Video,
  index: DatasetIndex,
  now: number,
): MetricValue & { ageDays: AgeDays | null; peers: number } {
  let reachedAny = false;
  let selfNote: string | null = null;
  let selfKnownAny = false;
  let bestPeers = 0;
  let zeroMedian = false;
  for (const k of OUTPERFORMANCE_AGES) {
    const self = valueAtAge(video, 'views', k, now);
    if (self.note === 'not_reached') continue;
    reachedAny = true;
    if (!isKnownMetric(self)) {
      selfNote ??= self.note;
      continue;
    }
    selfKnownAny = true;
    const table = peerTable(index, video.accountId, k, now);
    const own = table.values.get(video.id);
    const peers = table.sorted.length - (own ? 1 : 0);
    if (peers < OUTPERFORMANCE_MIN_PEERS) {
      bestPeers = Math.max(bestPeers, peers);
      continue;
    }
    const median = medianExcluding(table.sorted, own ? own.value : null);
    if (!(median > 0)) {
      zeroMedian = true;
      bestPeers = Math.max(bestPeers, peers);
      continue;
    }
    const peersNonExact = table.nonExact - (own && !own.exact ? 1 : 0);
    const status = self.status === 'exact' && peersNonExact === 0 ? 'exact' : 'interpolated';
    return { value: (self.value as number) / median, status, asOf: self.asOf, note: null, ageDays: k, peers };
  }
  const note = !reachedAny
    ? 'not_reached'
    : !selfKnownAny
      ? selfNote
      : zeroMedian
        ? 'peer_median_zero'
        : 'not_enough_peers';
  return { ...unavailableMetric(note), ageDays: null, peers: bestPeers };
}

/* ------------------------------------------------------------------------------------------
 * Bundle
 * ---------------------------------------------------------------------------------------- */

/**
 * Views increase in `w` / increase in the previous equal-length window - 1 (see previousWindow). When `w` is still
 * running (endMs > now) the previous window is truncated to the same elapsed length, so a partial period is not
 * compared with a full one. Unavailable when the previous increase is unknown ('previous_unavailable'),
 * decreasing ('previous_decreased') or <= 0 ('previous_zero'). A lower-bound current increase gives a
 * 'lower_bound' growth.
 */
export function growthVsPrevious(
  video: Video,
  w: UtcWindow,
  now: number,
  /** increment(video, 'views', w.startMs, w.endMs, now) when already computed. */
  precomputed?: MetricValue,
): MetricValue {
  const prevFull = previousWindow(w, now);
  const curEnd = Math.min(w.endMs, now);
  if (curEnd <= w.startMs) return unavailableMetric('window_not_started');
  const prevEnd = w.endMs > now ? Math.min(prevFull.startMs + (curEnd - w.startMs), prevFull.endMs) : prevFull.endMs;
  const prev = increment(video, 'views', prevFull.startMs, prevEnd, now);
  if (!isKnownMetric(prev)) return unavailableMetric(prev.status === 'decrease_flagged' ? 'previous_decreased' : 'previous_unavailable');
  if (!((prev.value as number) > 0)) return unavailableMetric('previous_zero');
  const cur = precomputed ?? increment(video, 'views', w.startMs, w.endMs, now);
  if (cur.value === null || cur.status === 'unavailable') return unavailableMetric(cur.note);
  const value = (cur.value as number) / (prev.value as number) - 1;
  if (cur.status === 'decrease_flagged') return { value, status: 'decrease_flagged', asOf: cur.asOf, note: cur.note };
  if (cur.status === 'lower_bound') return { value, status: 'lower_bound', asOf: cur.asOf, note: cur.note };
  const status = cur.status === 'exact' && prev.status === 'exact' ? 'exact' : 'interpolated';
  return { value, status, asOf: cur.asOf, note: null };
}

/**
 * Compute all VideoMetrics for `video` under `ctx`.
 * - upload mode: viewsPeriod = views since publish as of min(window.end, now).
 * - activity mode: viewsPeriod = increment over the window; if observations can't cover it, the window ends at
 *   `now` (+-2h) and a SourceWindowMetric of matching length exists (24h/168h/720h +-1h), use it as 'source_reported'.
 * - age mode: viewsAtAge = valueAtAge(ageDays); viewsPeriod mirrors viewsAtAge.
 * - velocity: views/hour over the ~24h ending at min(window.end, now); fallback: last two observations spanning >= 1h.
 * - growthVsPrev: increment(window) / increment(previousWindow) - 1 (unavailable when previous <= 0 or unknown).
 * - engagementRate: (likes + comments + shares, whichever non-null) / views, from the latest observation <= asOf.
 * - outperformance: largest k in [30,7,3,1] reached by this video with >= 3 same-account peers having
 *   valueAtAge(k); ratio = this / median(peers). Otherwise 'unavailable'.
 * - percentile: 'unavailable' here; filled by queryVideos across the result set.
 *
 * Details
 * - viewsTotal = views at min(window.end, now) (now when there is no window); when that instant is past our
 *   last observation (or otherwise unreadable) the latest earlier observation is returned as 'lower_bound'.
 * - likesPeriod / commentsPeriod follow the same per-mode rule as viewsPeriod (age mode: value at age).
 * - viewsAtAge outside age mode uses ctx.ageDays when given, else 'unavailable' ('no_age_selected').
 * - growthVsPrev on a still-running window compares against the same elapsed span of the previous window.
 * - The source-window fallback also applies to likes/comments when the source reports them.
 */
export function computeVideoMetrics(video: Video, ctx: MetricContext): VideoMetrics {
  const { mode, window: w, now } = ctx;
  const asOfEnd = w ? Math.min(w.endMs, now) : now;

  const viewsTotal = cumulativeAsOf(video, 'views', asOfEnd);

  // Raw observation-based views increase over the window (shared by activity viewsPeriod and growthVsPrev).
  const viewsWindowInc = w ? increment(video, 'views', w.startMs, w.endMs, now) : null;

  const viewsAtAge = ctx.ageDays != null ? valueAtAge(video, 'views', ctx.ageDays, now) : unavailableMetric('no_age_selected');

  const periodOf = (metric: MetricKey): MetricValue => {
    if (mode === 'age') {
      if (ctx.ageDays == null) return unavailableMetric('no_age_selected');
      return metric === 'views' ? viewsAtAge : valueAtAge(video, metric, ctx.ageDays, now);
    }
    if (mode === 'upload') {
      return increment(video, metric, video.publishedAt, w ? w.endMs : now, now);
    }
    // activity
    if (!w) return unavailableMetric('no_window');
    return windowIncrement(video, metric, w, now, metric === 'views' ? (viewsWindowInc ?? undefined) : undefined);
  };

  const viewsPeriod = periodOf('views');
  const likesPeriod = periodOf('likes');
  const commentsPeriod = periodOf('comments');

  const velocity = velocityAt(video, asOfEnd, now);
  const growthVsPrev = w ? growthVsPrevious(video, w, now, viewsWindowInc ?? undefined) : unavailableMetric('no_window');
  const engagementRate = engagementAt(video, asOfEnd);
  const outperformance = outperformanceOf(video, ctx.index, now);
  const percentile = unavailableMetric('computed_by_query');

  return {
    viewsTotal,
    viewsPeriod,
    likesPeriod,
    commentsPeriod,
    velocity,
    growthVsPrev,
    engagementRate,
    viewsAtAge,
    outperformance,
    percentile,
  };
}

/** Numeric value used for sorting; null for statuses that must not rank (unavailable, decrease_flagged). */
export function rankValue(m: { value: number | null; status: string }): number | null {
  if (m.status === 'unavailable' || m.status === 'decrease_flagged') return null;
  if (m.status !== 'exact' && m.status !== 'interpolated' && m.status !== 'lower_bound' && m.status !== 'source_reported') return null;
  return typeof m.value === 'number' && Number.isFinite(m.value) ? m.value : null;
}
