/**
 * Dashboard aggregations: simple counts over the dataset plus thin wrappers around @vti/core (the metric math
 * lives in queryVideos / computeTrending). Pure functions: tested in dashboard.test.ts.
 */
import { addDays, localDateOf, queryVideos, rankValue } from '@vti/core';
import type { CollectionRun, Dataset, DatasetIndex, LocalDateRange, Platform, SourceCoverage, UtcWindow, Video, VideoQuery, VideoRow } from '@vti/core';
import { orderPlatforms } from './platform.ts';
import { topCategoryOf } from './display.ts';

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

export interface Span {
  startMs: number;
  endMs: number;
}

function inSpan(t: number, s: Span): boolean {
  return t >= s.startMs && t < s.endMs;
}

export function filterVideos(videos: Video[], platforms: Platform[] | undefined): Video[] {
  if (!platforms || platforms.length === 0) return videos;
  const set = new Set(platforms);
  return videos.filter((v) => set.has(v.platform));
}

/**
 * The previous window used for "vs previous period" comparisons. When the current window is still
 * running (endMs > now) the previous window is cut to the same elapsed length, so a partial week is
 * compared with the same number of hours of the week before (not with a full week).
 */
export function comparablePrevious(current: Span, now: number): Span {
  const length = current.endMs - current.startMs;
  const elapsed = Math.max(0, Math.min(current.endMs, now) - current.startMs);
  const startMs = current.startMs - length;
  return { startMs, endMs: startMs + elapsed };
}

export interface DashboardKpis {
  trackedVideos: number;
  activeVideos: number;
  /** Deleted / private videos kept for history. */
  goneVideos: number;
  accounts: number;
  /** Creators linking accounts on 2+ platforms. */
  multiPlatformCreators: number;
  platforms: Platform[];
  /** Observations with t in (now - 24h, now]. */
  observationsLast24h: number;
  /** Distinct videos with at least one observation in the last 24h. */
  videosObservedLast24h: number;
  uploadsInWindow: number;
  /** Uploads in the comparable previous window; null when that window has zero length or is not comparable. */
  uploadsPrevious: number | null;
  /** uploadsInWindow / uploadsPrevious - 1; null when previous is 0, unknown or not comparable. */
  uploadsGrowth: number | null;
  /**
   * Whether the upload count can be compared with the previous window:
   * - `ok`: both windows lie after the collection start (uploads were discovered live in both);
   * - `before_collection`: the previous window starts before the collection start. Uploads from before we
   *   started were only found by backfill (latest 15 per channel, "visited today" sorts...), so the older
   *   window is under-sampled by construction and a growth figure would be a discovery artifact;
   * - `none`: nothing to compare (zero-length previous window, e.g. before the window started).
   */
  uploadsComparison: 'ok' | 'before_collection' | 'none';
}

export interface KpiOptions {
  now: number;
  window: Span;
  platforms?: Platform[];
  /**
   * When our collection started (lib/collection.ts). With it, the upload growth is only reported when the
   * previous window starts after it; without it every previous window is treated as comparable.
   */
  collectionStartAt?: number | null;
}

export function computeKpis(dataset: Dataset, opts: KpiOptions): DashboardKpis {
  const { now, window } = opts;
  const videos = filterVideos(dataset.videos, opts.platforms);
  const platformSet = new Set<Platform>();
  let active = 0;
  let gone = 0;
  let obs24 = 0;
  let observedVideos = 0;
  let uploads = 0;
  let uploadsPrev = 0;
  const since = now - DAY_MS;
  const prev = comparablePrevious(window, now);
  for (const v of videos) {
    platformSet.add(v.platform);
    if (v.status === 'deleted' || v.status === 'private') gone++;
    else active++;
    let seen = false;
    // obs are sorted ascending: walk from the end.
    for (let i = v.obs.length - 1; i >= 0; i--) {
      const t = v.obs[i].t;
      if (t <= since) break;
      if (t <= now) {
        obs24++;
        seen = true;
      }
    }
    if (seen) observedVideos++;
    if (inSpan(v.publishedAt, window) && v.publishedAt <= now) uploads++;
    if (inSpan(v.publishedAt, prev)) uploadsPrev++;
  }
  const accounts = opts.platforms && opts.platforms.length ? dataset.accounts.filter((a) => opts.platforms!.includes(a.platform)).length : dataset.accounts.length;
  const accountPlatform = new Map(dataset.accounts.map((a) => [a.id, a.platform] as const));
  let multi = 0;
  for (const c of dataset.creators) {
    const ps = new Set(c.accountIds.map((id) => accountPlatform.get(id)).filter((p): p is Platform => !!p));
    if (ps.size >= 2) multi++;
  }
  const prevLen = prev.endMs - prev.startMs;
  const start = opts.collectionStartAt;
  const comparison: DashboardKpis['uploadsComparison'] =
    prevLen <= 0 ? 'none' : typeof start === 'number' && Number.isFinite(start) && prev.startMs < start ? 'before_collection' : 'ok';
  return {
    trackedVideos: videos.length,
    activeVideos: active,
    goneVideos: gone,
    accounts,
    multiPlatformCreators: multi,
    platforms: orderPlatforms(platformSet),
    observationsLast24h: obs24,
    videosObservedLast24h: observedVideos,
    uploadsInWindow: uploads,
    uploadsPrevious: comparison === 'ok' ? uploadsPrev : null,
    uploadsGrowth: comparison === 'ok' && uploadsPrev > 0 ? uploads / uploadsPrev - 1 : null,
    uploadsComparison: comparison,
  };
}

/** Local dates from start to end inclusive. */
export function datesInRange(range: LocalDateRange): string[] {
  const out: string[] = [];
  let d = range.start;
  for (let guard = 0; d <= range.end && guard < 1000; guard++) {
    out.push(d);
    d = addDays(d, 1);
  }
  return out;
}

/** Upload counts per local day of `range` in `tz` (days after `now` are null: not happened yet). */
export function dailyUploads(videos: Video[], range: LocalDateRange, tz: string, now: number): { date: string; count: number | null }[] {
  const dates = datesInRange(range);
  const counts = new Map<string, number>(dates.map((d) => [d, 0]));
  for (const v of videos) {
    if (v.publishedAt > now) continue;
    const d = localDateOf(v.publishedAt, tz);
    const c = counts.get(d);
    if (c !== undefined) counts.set(d, c + 1);
  }
  const today = localDateOf(now, tz);
  return dates.map((date) => ({ date, count: date > today ? null : counts.get(date)! }));
}

export interface PlatformSplitRow {
  platform: Platform;
  tracked: number;
  uploadsInWindow: number;
  accounts: number;
}

export function platformSplit(dataset: Dataset, window: Span, now: number): PlatformSplitRow[] {
  const rows = new Map<Platform, PlatformSplitRow>();
  const row = (p: Platform) => {
    let r = rows.get(p);
    if (!r) {
      r = { platform: p, tracked: 0, uploadsInWindow: 0, accounts: 0 };
      rows.set(p, r);
    }
    return r;
  };
  for (const v of dataset.videos) {
    const r = row(v.platform);
    r.tracked++;
    if (inSpan(v.publishedAt, window) && v.publishedAt <= now) r.uploadsInWindow++;
  }
  for (const a of dataset.accounts) row(a.platform).accounts++;
  return orderPlatforms(rows.keys()).map((p) => rows.get(p)!);
}

export interface CategorySplitRow {
  /** Top-level taxonomy id, or `__none__` for videos without any category. */
  id: string;
  count: number;
}

export const UNCATEGORIZED = '__none__';

/**
 * Videos per top-level category. A video with categories in two top-level branches counts in both
 * (multi-label), so counts can sum to more than the number of videos. Sorted by count desc, id asc.
 */
export function categorySplit(videos: Video[]): { rows: CategorySplitRow[]; videos: number; multiLabel: number } {
  const counts = new Map<string, number>();
  let multi = 0;
  for (const v of videos) {
    const tops = new Set(v.categories.map((c) => topCategoryOf(c.id)));
    if (tops.size === 0) tops.add(UNCATEGORIZED);
    if (tops.size > 1) multi++;
    for (const t of tops) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const rows = [...counts.entries()].map(([id, count]) => ({ id, count }));
  rows.sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
  return { rows, videos: videos.length, multiLabel: multi };
}

export function videosUploadedIn(videos: Video[], window: Span, now: number): Video[] {
  return videos.filter((v) => inSpan(v.publishedAt, window) && v.publishedAt <= now);
}

export type FreshnessState = 'ok' | 'late' | 'stale' | 'error' | 'partial' | 'disabled' | 'never';

export interface FreshnessRow {
  source: string;
  label: string;
  platform: Platform;
  state: FreshnessState;
  lastSuccessAt: number | null;
  lastRunAt: number | null;
  /** Hours between last success and the data's now. */
  ageHours: number | null;
  videoCount: number;
  lastError: string | null;
  requiresCredentials: boolean;
}

/** Freshness thresholds (hours since last successful run, relative to the reference instant). */
export const FRESHNESS_HOURS = { ok: 12, late: 48 } as const;

/**
 * Per-source freshness relative to `now`. Pass the collection's `collectedUntil` (lib/collection.ts), not
 * the data's generatedAt: a run can succeed after the newest observation (a round with 0 new points), and
 * an age is never negative.
 */
export function sourceFreshness(coverage: SourceCoverage[], now: number): FreshnessRow[] {
  const rows = coverage.map((c): FreshnessRow => {
    const age = c.lastSuccessAt !== null ? Math.max(0, (now - c.lastSuccessAt) / HOUR_MS) : null;
    let state: FreshnessState;
    if (!c.enabled || c.lastStatus === 'disabled') state = 'disabled';
    else if (c.lastSuccessAt === null) state = c.lastStatus === 'error' ? 'error' : 'never';
    else if (c.lastStatus === 'error') state = 'error';
    else if (age !== null && age > FRESHNESS_HOURS.late) state = 'stale';
    else if (age !== null && age > FRESHNESS_HOURS.ok) state = 'late';
    else if (c.lastStatus === 'partial') state = 'partial';
    else state = 'ok';
    return {
      source: c.source,
      label: c.label,
      platform: c.platform,
      state,
      lastSuccessAt: c.lastSuccessAt,
      lastRunAt: c.lastRunAt,
      ageHours: age === null ? null : Math.round(age * 10) / 10,
      videoCount: c.videoCount,
      lastError: c.lastError,
      requiresCredentials: c.requiresCredentials,
    };
  });
  const rank = (r: FreshnessRow) => (r.state === 'disabled' ? 1 : 0);
  const order = orderPlatforms(rows.map((r) => r.platform));
  rows.sort((a, b) => rank(a) - rank(b) || order.indexOf(a.platform) - order.indexOf(b.platform) || a.source.localeCompare(b.source));
  return rows;
}

/**
 * Runs that started in (now - hours, now] and those with status error/partial. Pass the collection's
 * `collectedUntil` (lib/collection.ts) as `now`: runs of the last round can start after the data's now.
 */
export function recentRunProblems(runs: CollectionRun[], now: number, hours = 24): { total: number; problems: number } {
  let total = 0;
  let problems = 0;
  for (const r of runs) {
    if (r.startedAt > now - hours * HOUR_MS && r.startedAt <= now) {
      total++;
      if (r.status !== 'ok') problems++;
    }
  }
  return { total, problems };
}

/* ------------------------------------------------------------------------------------------ top videos */

export interface TopRanked {
  /** Up to `limit` rows whose ranked metric has a value (never rows ranked only by the id tie-break). */
  rows: VideoRow[];
  /** Videos in scope (published before the window end, matching the filters). */
  total: number;
  /** Videos whose `viewsPeriod` can be ranked (exact / interpolated / lower bound / source reported). */
  rankable: number;
  window: UtcWindow | null;
  notes: string[];
}

/**
 * The top videos by period view increase (activity mode). queryVideos sorts unrankable values last and
 * breaks ties by id, so when few values exist a plain `limit: 10` would fill the list with the lowest ids
 * and a column of "—". Only rankable rows are kept; `rankable` says how many exist overall.
 */
export function topRankedVideos(index: DatasetIndex, q: VideoQuery, limit = 10): TopRanked {
  const full = queryVideos(index, { ...q, sort: 'views_period', sortDir: 'desc', limit: undefined, offset: undefined });
  let rankable = 0;
  for (const r of full.rows) if (rankValue(r.metrics.viewsPeriod) !== null) rankable++;
  // Rankable rows come first (desc sort puts nulls last).
  return { rows: full.rows.slice(0, Math.min(limit, rankable)), total: full.total, rankable, window: full.window, notes: full.notes };
}

export type TopVideosEmptyReason =
  /** The window ends before the first observation: no increase can be computed at all. */
  | 'before_collection'
  /** The window starts before the first observation / most videos have one observation. */
  | 'short_history'
  /** Enough history: nothing matches the filters or nothing gained views. */
  | 'none';

/** Why the top-videos list can be empty with the loaded data. */
export function topVideosEmptyReason(window: Span, firstObservationAt: number | null, now: number): TopVideosEmptyReason {
  if (firstObservationAt === null) return 'before_collection';
  if (Math.min(window.endMs, now) <= firstObservationAt) return 'before_collection';
  if (window.startMs < firstObservationAt) return 'short_history';
  return 'none';
}
