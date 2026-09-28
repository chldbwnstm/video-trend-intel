/**
 * Per-video metric bundle for a query context. OWNER: core-metrics agent.
 */
import type { AgeDays, DateMode, MetricKey, MetricValue, Platform, SourceWindowMetric, UtcWindow, Video, VideoMetrics } from './types.ts';
import type { DatasetIndex } from './dataset.ts';
import { HOUR, previousWindow } from './time.ts';
import {
  DEFAULT_MAX_INTERPOLATION_GAP_MS,
  increment,
  isKnownMetric,
  metricSeries,
  sortedObservations,
  unavailableMetric,
  valueAt,
  valueAtAge,
  latestValue,
} from './series.ts';

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
/**
 * growth_vs_prev is not computed when the previous window's increase is below this many views: a ratio over a
 * handful of views is noise (10 -> 1,000 views reads as +9,900%), design doc section 6.
 */
export const GROWTH_MIN_PREVIOUS = 100;

/* ------------------------------------------------------------------------------------------
 * Building blocks (exported for detail views / other analytics)
 * ---------------------------------------------------------------------------------------- */

/**
 * Why a source-reported window value cannot be right, or null when it is plausible. Checked against our own
 * observations and the other windows of the same report (same metric, observedAt and src):
 * - 'window_equals_lifetime': the video is older than the window, yet the window value (> 0) is at least the
 *   video's cumulative count at `observedAt` (read from our observations, exact or interpolated). That would
 *   mean the counter was 0 when the window started. Dailymotion reports `views_last_month` equal to the
 *   lifetime views for many long-inactive videos (aggregation lag), usually with the day/week windows at 0;
 *   used as a 30-day increase it inflates rankings with years-old videos.
 * - 'window_exceeds_lifetime': the window value is larger than the cumulative count read from an observation
 *   at or after `observedAt` (the lifetime count at `observedAt` can only be smaller or equal).
 * - 'windows_inconsistent': a longer window of the same report is smaller than a shorter one (or the value is
 *   negative / not a number).
 * Returns null (plausible) when there is nothing to check against.
 */
export function sourceWindowImplausibility(video: Video, sw: SourceWindowMetric): string | null {
  if (typeof sw.value !== 'number' || !Number.isFinite(sw.value) || sw.value < 0) return 'windows_inconsistent';
  for (const o of video.sourceWindows ?? []) {
    if (o === sw || o.metric !== sw.metric || o.observedAt !== sw.observedAt || o.src !== sw.src) continue;
    if (typeof o.value !== 'number' || !Number.isFinite(o.value)) continue;
    if ((o.windowHours < sw.windowHours && o.value > sw.value) || (o.windowHours > sw.windowHours && o.value < sw.value)) {
      return 'windows_inconsistent';
    }
  }
  if (sw.value <= 0) return null;
  const total = valueAt(video, sw.metric, sw.observedAt);
  if (!isKnownMetric(total)) return null;
  const cum = total.value as number;
  const olderThanWindow = video.publishedAt < sw.observedAt - sw.windowHours * HOUR;
  if (olderThanWindow && sw.value >= cum) return 'window_equals_lifetime';
  if (sw.value > cum && total.status === 'exact' && (total.asOf as number) >= sw.observedAt) return 'window_exceeds_lifetime';
  return null;
}

/** Source windows describing `w` (see sourceWindowValue): the best plausible one, and whether an implausible one was skipped. */
function matchSourceWindow(
  video: Video,
  metric: MetricKey,
  w: UtcWindow,
  now: number,
): { best: SourceWindowMetric | null; rejected: boolean } {
  if (!video.sourceWindows?.length) return { best: null, rejected: false };
  if (Math.abs(w.endMs - now) > SOURCE_WINDOW_END_TOLERANCE_MS) return { best: null, rejected: false };
  const len = w.endMs - w.startMs;
  let best: SourceWindowMetric | null = null;
  let bestD = Infinity;
  let rejected = false;
  for (const sw of video.sourceWindows) {
    if (sw.metric !== metric || typeof sw.value !== 'number' || !Number.isFinite(sw.value)) continue;
    if (Math.abs(len - sw.windowHours * HOUR) > SOURCE_WINDOW_LENGTH_TOLERANCE_MS) continue;
    const d = Math.abs(sw.observedAt - w.endMs);
    if (d > SOURCE_WINDOW_END_TOLERANCE_MS) continue;
    if (sourceWindowImplausibility(video, sw) !== null) {
      rejected = true;
      continue;
    }
    if (d < bestD) {
      best = sw;
      bestD = d;
    }
  }
  return { best, rejected };
}

/**
 * A SourceWindowMetric that describes exactly `w` (window ends at `now` +-2h, a source window of the same
 * length +-1h observed at the window end +-2h), as a 'source_reported' MetricValue; null when none fits.
 * When several fit, the one observed closest to the window end wins. Implausible source values (see
 * sourceWindowImplausibility) are never used.
 */
export function sourceWindowValue(video: Video, metric: MetricKey, w: UtcWindow, now: number): MetricValue | null {
  const { best } = matchSourceWindow(video, metric, w, now);
  return best ? { value: best.value, status: 'source_reported', asOf: best.observedAt, note: 'source_window' } : null;
}

/**
 * Increase of `metric` over window `w` (clipped to `now`), falling back to a matching SourceWindowMetric
 * ('source_reported') when our observations cannot cover the window (unavailable / lower_bound).
 *
 * Details
 * - A source value below our own lower bound contradicts what we observed: the lower bound is kept.
 * - When the only matching source windows are implausible (sourceWindowImplausibility) an 'unavailable'
 *   increment gets note 'source_window_implausible' so the reason is visible; a 'lower_bound' keeps its note.
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
    const { best, rejected } = matchSourceWindow(video, metric, w, now);
    if (best) {
      if (inc.status === 'lower_bound' && typeof inc.value === 'number' && best.value < inc.value) return inc;
      return { value: best.value, status: 'source_reported', asOf: best.observedAt, note: 'source_window' };
    }
    if (rejected && inc.status === 'unavailable') return unavailableMetric('source_window_implausible');
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
 * before `end` spanning >= 1h ('interpolated', note 'last_two_observations') only while they describe the
 * current pace: the later one must lie within the 24h before `end` and the pair at most the interpolation gap
 * (48h) apart. Older pairs (e.g. a video no longer refreshed after it left its channel's RSS feed) give
 * 'unavailable' note 'stale_observations' instead of weeks-old rates ranked as today's velocity.
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
  if (series.t[j] < e - VELOCITY_SPAN_MS) return unavailableMetric('stale_observations');
  let i = j - 1;
  while (i >= 0 && series.t[j] - series.t[i] < VELOCITY_MIN_SPAN_MS) i--;
  if (i < 0) return unavailableMetric('insufficient_observations');
  if (series.t[j] - series.t[i] > DEFAULT_MAX_INTERPOLATION_GAP_MS) return unavailableMetric('stale_observations');
  const dv = series.v[j] - series.v[i];
  const rate = dv / ((series.t[j] - series.t[i]) / HOUR);
  if (dv < 0) return { value: rate, status: 'decrease_flagged', asOf: series.t[j], note: 'counter_decreased' };
  return { value: rate, status: 'interpolated', asOf: series.t[j], note: 'last_two_observations' };
}

const ENGAGEMENT_COMPONENTS: MetricKey[] = ['likes', 'comments', 'shares'];
/**
 * niconico's comment counter counts on-video timeline comments (one viewer typically posts many), so comments
 * often exceed views (294% "engagement" on real data) and are not comparable with other platforms' comments.
 * They are left out of niconico's engagement rate.
 */
const ENGAGEMENT_COMPONENTS_BY_PLATFORM: Partial<Record<Platform, MetricKey[]>> = { niconico: ['likes', 'shares'] };

/** Counters summed into the engagement rate on `platform` (see engagementAt). */
export function engagementComponentsFor(platform: Platform): MetricKey[] {
  return ENGAGEMENT_COMPONENTS_BY_PLATFORM[platform] ?? ENGAGEMENT_COMPONENTS;
}

/**
 * (likes + comments + shares, whichever are non-null) / views, from the latest observation at or before `asOf`
 * that has views > 0 and at least one component. `components` lists what was summed. Missing counters are
 * never counted as 0. On niconico comments are excluded (on-video timeline comments, see
 * engagementComponentsFor), so its rate is likes / views.
 */
export function engagementAt(video: Video, asOf: number): MetricValue & { components: MetricKey[] } {
  const allowed = engagementComponentsFor(video.platform);
  const obs = sortedObservations(video);
  let sawZeroViews = false;
  for (let i = obs.length - 1; i >= 0; i--) {
    const p = obs[i];
    if (p.t > asOf) continue;
    const views = p.views;
    if (typeof views !== 'number' || !Number.isFinite(views)) continue;
    const components: MetricKey[] = [];
    let sum = 0;
    for (const k of allowed) {
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
 * decreasing ('previous_decreased'), 0 ('previous_zero', incl. videos published after the compared previous span)
 * or below GROWTH_MIN_PREVIOUS ('previous_too_small'), and for videos published inside the previous window
 * ('published_in_previous_window'): such a video existed for only part of the comparison span, so its
 * "previous" is a few minutes of the synthetic publish ramp and the ratio is meaningless (+132,060% on real
 * data). A lower-bound current increase gives a 'lower_bound' growth.
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
  if (video.publishedAt >= prevEnd) return unavailableMetric('previous_zero');
  if (video.publishedAt > prevFull.startMs) return unavailableMetric('published_in_previous_window');
  const prev = increment(video, 'views', prevFull.startMs, prevEnd, now);
  if (!isKnownMetric(prev)) return unavailableMetric(prev.status === 'decrease_flagged' ? 'previous_decreased' : 'previous_unavailable');
  if (!((prev.value as number) > 0)) return unavailableMetric('previous_zero');
  if ((prev.value as number) < GROWTH_MIN_PREVIOUS) return unavailableMetric('previous_too_small');
  const cur = precomputed ?? increment(video, 'views', w.startMs, w.endMs, now);
  if (cur.value === null || cur.status === 'unavailable') return unavailableMetric(cur.note);
  const value = (cur.value as number) / (prev.value as number) - 1;
  if (cur.status === 'decrease_flagged') return { value, status: 'decrease_flagged', asOf: cur.asOf, note: cur.note };
  if (cur.status === 'lower_bound') return { value, status: 'lower_bound', asOf: cur.asOf, note: cur.note };
  const status = cur.status === 'exact' && prev.status === 'exact' ? 'exact' : 'interpolated';
  return { value, status, asOf: cur.asOf, note: null };
}

/**
 * Instant the cumulative values (viewsTotal, engagement, velocity) of a query context refer to:
 * - activity mode: the window end (clipped to `now`), so they describe the period that is being ranked;
 * - upload / age mode and no window: `now`. The window only selects videos by publish time there (design doc
 *   section 5: videos uploaded in September ranked by their CURRENT views), so the values are the latest ones,
 *   as of the data's now, and may include views gained after the window ended (the query notes say so).
 *   Reading them at the window end instead would need an observation near that instant, which no video
 *   discovered after its window closed has: every finished past window would be unranked.
 */
export function metricsValueInstant(mode: DateMode, w: UtcWindow | null, now: number): number {
  return mode === 'activity' && w ? Math.min(w.endMs, now) : now;
}

/**
 * Compute all VideoMetrics for `video` under `ctx`.
 * - upload mode: viewsPeriod = views since publish as of `now` (the same value as viewsTotal).
 * - activity mode: viewsPeriod = increment over the window; if observations can't cover it, the window ends at
 *   `now` (+-2h) and a SourceWindowMetric of matching length exists (24h/168h/720h +-1h), use it as 'source_reported'.
 * - age mode: viewsAtAge = valueAtAge(ageDays); viewsPeriod mirrors viewsAtAge.
 * - velocity: views/hour over the ~24h ending at the value instant (metricsValueInstant); fallback: the recent
 *   last two observations spanning >= 1h.
 * - growthVsPrev: increment(window) / increment(previousWindow) - 1 (unavailable when the previous increase is
 *   small, 0 or unknown, or the video was published inside the previous window).
 * - engagementRate: (likes + comments + shares, whichever non-null; niconico without comments) / views, from the
 *   latest observation <= the value instant.
 * - outperformance: largest k in [30,7,3,1] reached by this video with >= 3 same-account peers having
 *   valueAtAge(k); ratio = this / median(peers). Otherwise 'unavailable'.
 * - percentile: 'unavailable' here; filled by queryVideos across the result set.
 *
 * Details
 * - viewsTotal = views at the value instant: min(window.end, now) in activity mode, `now` in upload / age mode;
 *   when that instant is past our last observation (or otherwise unreadable) the latest earlier observation is
 *   returned as 'lower_bound'.
 * - likesPeriod / commentsPeriod follow the same per-mode rule as viewsPeriod (age mode: value at age).
 * - viewsAtAge outside age mode uses ctx.ageDays when given, else 'unavailable' ('no_age_selected').
 * - growthVsPrev on a still-running window compares against the same elapsed span of the previous window.
 * - The source-window fallback also applies to likes/comments when the source reports them.
 */
export function computeVideoMetrics(video: Video, ctx: MetricContext): VideoMetrics {
  const { mode, window: w, now } = ctx;
  const asOfEnd = metricsValueInstant(mode, w, now);

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
      // Everything since publish, as of now: the cumulative value (never 'unavailable' just because the
      // window is over).
      return metric === 'views' ? viewsTotal : cumulativeAsOf(video, metric, now);
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
