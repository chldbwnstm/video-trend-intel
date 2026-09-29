/**
 * Watchlist analytics (pure; run through useAnalysis; tested in watchlist.test.ts).
 *
 * Every number describes OUR tracked videos read as known at the data `now` (indexAsOf), with core's honest
 * statuses: period metrics come from summarizePortfolio (same definitions as the creator pages), increases from
 * core `increment` / `windowIncrement` + `sumIncrements` (lower bounds, decreases excluded, null ≠ 0).
 *
 * "Since your last visit" uses a data-time reference `since` (see model.ts sinceLastVisit): new uploads are
 * tracked videos published in (since, now]; videos first collected after `since` but published earlier are
 * counted separately as late discoveries (the collector finds some videos after they were published).
 */
import {
  addDays,
  BOUNDARY_TOLERANCE_WINDOW_FRACTION,
  compileKeyword,
  creatorPortfolios,
  creatorTimeline,
  cumulativeAsOf,
  daysBetween,
  DEFAULT_BOUNDARY_TOLERANCE_MS,
  increment,
  indexAsOf,
  keywordMatches,
  latestValue,
  localDateOf,
  PLATFORMS,
  resolveAnalysisWindow,
  sortedObservations,
  sumIncrements,
  summarizePortfolio,
  unavailableMetric,
  valueAt,
  windowIncrement,
} from '@vti/core';
import type { Account, CompiledKeyword, CreatorSummary, DatasetIndex, LocalDateRange, MetricValue, Platform, Portfolio, UtcWindow, Video } from '@vti/core';
import { combinedTimeline, normalizeTimeline } from '../creators/logic.ts';
import { cleanKeyword } from './model.ts';
import type { PinnedCreator, PinnedKeyword, PinnedVideo, ViewsBaseline } from './model.ts';

/** Sparklines cover at least this many local days (ending at the range end), so short ranges still show a trend. */
export const SPARK_MIN_DAYS = 7;
/** Newest "new since last visit" uploads listed per creator / keyword. */
export const RECENT_LIMIT = 3;

export interface VideoLite {
  id: string;
  title: string;
  platform: Platform;
  publishedAt: number;
}

export interface SinceVisitStats {
  /** Tracked videos published after `since` (and by `now`). */
  newUploads: number;
  /** Videos first collected after `since` but published before it (late discovery). */
  lateFound: number;
  /** Newest new uploads first (≤ RECENT_LIMIT). */
  recent: VideoLite[];
  /** View increase over [since, now) summed over the videos (sumIncrements: lower bound when partly unknown). */
  views: MetricValue;
}

function plain(m: MetricValue): MetricValue {
  return { value: m.value, status: m.status, asOf: m.asOf, note: m.note };
}

/**
 * sumIncrements over the videos' increases; with no video at all the sum is unknown ('no_tracked_videos'), not an
 * exact 0 that reads as "no views" (same rule as the keyword page's analyzeKeywords).
 */
function sumOrUnavailable(parts: readonly MetricValue[]): MetricValue {
  return parts.length ? plain(sumIncrements(parts)) : unavailableMetric('no_tracked_videos');
}

function lite(v: Video): VideoLite {
  return { id: v.id, title: v.title, platform: v.platform, publishedAt: v.publishedAt };
}

/** New uploads / late discoveries / view increase of `videos` since the data time `since`. */
export function sinceVisitStats(videos: readonly Video[], since: number, now: number): SinceVisitStats {
  let newUploads = 0;
  let lateFound = 0;
  const fresh: Video[] = [];
  const parts: MetricValue[] = [];
  const w: UtcWindow = { startMs: since, endMs: now, tz: 'UTC', incomplete: false };
  for (const v of videos) {
    if (v.publishedAt > now) continue;
    if (v.publishedAt > since) {
      newUploads++;
      fresh.push(v);
    } else if (v.firstSeenAt > since) lateFound++;
    if (since < now) parts.push(windowIncrement(v, 'views', w, now));
  }
  fresh.sort((a, b) => b.publishedAt - a.publishedAt || (a.id < b.id ? -1 : 1));
  return {
    newUploads,
    lateFound,
    recent: fresh.slice(0, RECENT_LIMIT).map(lite),
    views: since < now ? sumOrUnavailable(parts) : unavailableMetric('window_not_started'),
  };
}

/** Local dates of the sparkline: the range, widened to SPARK_MIN_DAYS days ending at its end. */
export function sparkRange(range: LocalDateRange): LocalDateRange {
  const days = daysBetween(range.start, range.end) + 1;
  return days >= SPARK_MIN_DAYS ? range : { start: addDays(range.end, -(SPARK_MIN_DAYS - 1)), end: range.end };
}

/** A trend line is drawn only from at least this many finished, measurable days. */
export const SPARK_MIN_POINTS = 3;

export interface SparkSeries {
  /** Finished days only; days without a measured value (unavailable / decreased) are gaps, never 0. */
  values: (number | null)[];
  labels: string[];
  /** Number of non-null values. */
  measured: number;
  /** Most recent measurable days (the unfinished current day included), newest last, for a text fallback. */
  recent: { date: string; metric: MetricValue; partial: boolean }[];
}

/**
 * Sparkline data from daily totals. The current local day (`today`, and anything after it) is left out of the
 * line: it only runs up to the data time, so it would always look like a drop. With fewer than SPARK_MIN_POINTS
 * measured days the page shows `recent` as numbers instead of a line.
 */
export function sparkSeries(daily: readonly { date: string; metric: MetricValue }[], today: string | null): SparkSeries {
  const measurable = (m: MetricValue) => m.status !== 'unavailable' && m.status !== 'decrease_flagged' && m.value !== null;
  const isPartial = (date: string) => today !== null && date >= today;
  const finished = daily.filter((d) => !isPartial(d.date));
  const values = finished.map((d) => (measurable(d.metric) ? d.metric.value : null));
  const recent = daily
    .filter((d) => measurable(d.metric))
    .slice(-2)
    .map((d) => ({ date: d.date, metric: d.metric, partial: isPartial(d.date) }));
  return { values, labels: finished.map((d) => d.date), measured: values.filter((v) => v !== null).length, recent };
}

/* ------------------------------------------------------------------------------------------ creators */

export interface WatchCreatorsInput {
  keys: string[];
  range: LocalDateRange;
  rollingHours: number | null;
  tz: string;
  now: number;
  /** Data-time reference of "since your last visit" (null: first visit). */
  since: number | null;
}

export interface WatchCreatorRow {
  key: string;
  found: boolean;
  name: string;
  kind: 'creator' | 'account' | null;
  accounts: Account[];
  /** Every account id of the portfolio (video search scope). */
  accountIds: string[];
  platforms: Platform[];
  /** Period metrics (same definitions as /creators). null when the key is not in the dataset. */
  summary: CreatorSummary | null;
  /** Daily view increase over sparkRange, summed over the portfolio's platforms. */
  daily: { date: string; metric: MetricValue }[];
  since: SinceVisitStats | null;
  lastUpload: number | null;
}

export interface WatchCreatorsResult {
  window: UtcWindow;
  sparkRange: LocalDateRange;
  /** Local date of the data time in tz (the unfinished day), null for an unusable zone. */
  today: string | null;
  rows: WatchCreatorRow[];
  /** Platforms across the found portfolios (canonical order). */
  platforms: Platform[];
}

function videosOf(idx: DatasetIndex, p: Portfolio, now: number): Video[] {
  const out: Video[] = [];
  for (const id of p.accountIds) for (const v of idx.videosByAccount.get(id) ?? []) if (v.publishedAt <= now) out.push(v);
  return out;
}

export function computeWatchCreators(index: DatasetIndex, input: WatchCreatorsInput): WatchCreatorsResult {
  const { keys, range, rollingHours, tz, now, since } = input;
  const idx = indexAsOf(index, now);
  const w = resolveAnalysisWindow(range, tz, now, rollingHours);
  const spark = sparkRange(range);
  const portfolios = creatorPortfolios(idx);
  const present = new Set<Platform>();
  const rows = keys.map((key): WatchCreatorRow => {
    const p = portfolios.get(key);
    if (!p) return { key, found: false, name: key, kind: null, accounts: [], accountIds: [], platforms: [], summary: null, daily: [], since: null, lastUpload: null };
    const summary = summarizePortfolio(idx, p, w, now, null);
    for (const pf of summary.platforms) present.add(pf);
    const videos = videosOf(idx, p, now);
    let lastUpload: number | null = null;
    for (const v of videos) if (lastUpload === null || v.publishedAt > lastUpload) lastUpload = v.publishedAt;
    const timeline = creatorTimeline(idx, key, { range: spark, tz, now });
    return {
      key,
      found: true,
      name: p.name,
      kind: p.kind,
      accounts: p.accounts,
      accountIds: p.accountIds,
      platforms: summary.platforms,
      summary,
      daily: combinedTimeline(normalizeTimeline(timeline, now, tz), null),
      since: since === null ? null : sinceVisitStats(videos, since, now),
      lastUpload,
    };
  });
  let today: string | null = null;
  try {
    today = localDateOf(now, tz);
  } catch {
    today = null;
  }
  return { window: w, sparkRange: spark, today, rows, platforms: PLATFORMS.filter((x) => present.has(x)) };
}

/* ------------------------------------------------------------------------------------------ videos */

export interface WatchVideosInput {
  pins: Pick<PinnedVideo, 'id' | 'baseline' | 'dataNow'>[];
  now: number;
  since: number | null;
}

export interface WatchVideoRow {
  id: string;
  /** null when the video is no longer in the dataset (export budget, removed). */
  video: Video | null;
  accountName: string | null;
  /** Views when pinned: the stored observation (exact at its time), else read from the series at the pin's data time. */
  atPin: MetricValue;
  /** Cumulative views as of `now` (≥ the last observation when it is older than the boundary tolerance). */
  current: MetricValue;
  /** Views gained since the pin (see pinGrowth). */
  growth: MetricValue;
  /** Views gained since the last visit (null on the first visit). */
  sinceVisit: MetricValue | null;
}

export interface WatchVideosResult {
  rows: WatchVideoRow[];
  platforms: Platform[];
}

/** The latest views observation at or before `now`, as stored with a new pin (null when none). */
export function viewsBaseline(v: Video, now: number): ViewsBaseline | null {
  const m = latestValue(v, 'views', now);
  if (m.status !== 'exact' || m.value === null || m.asOf === null || m.note === 'before_publish') return null;
  const src = sortedObservations(v).find((o) => o.t === m.asOf)?.src ?? null;
  return { value: m.value, t: m.asOf, src };
}

/** Views at the pin: the stored baseline observation, else the series value at the pin's data time. */
export function pinValue(video: Video | null, pin: Pick<PinnedVideo, 'baseline' | 'dataNow'>): MetricValue {
  if (pin.baseline) return { value: pin.baseline.value, status: 'exact', asOf: pin.baseline.t, note: null };
  if (!video || pin.dataNow === null) return unavailableMetric('no_observations');
  return valueAt(video, 'views', pin.dataNow);
}

/**
 * Views gained since a video was pinned.
 * - With a stored baseline (value v0 observed at t0): latest observation (v1, t1) at or before `now`. t1 ≤ t0 ->
 *   'unavailable' (no observation since the pin); v1 < v0 -> 'decrease_flagged'; else v1 - v0, 'exact' when t1 is
 *   within core's boundary tolerance of `now` (min(2h, 5% of now - t0), as for any window increment), otherwise
 *   'lower_bound' (views after t1 are unknown but not negative).
 * - Without a baseline: core `increment` over [pin data time, now) (its own exact / interpolated / lower-bound rules).
 * - Video missing from the dataset -> 'unavailable'.
 */
export function pinGrowth(video: Video | null, pin: Pick<PinnedVideo, 'baseline' | 'dataNow'>, now: number): MetricValue {
  if (!video) return unavailableMetric('no_observations');
  const b = pin.baseline;
  if (b) {
    const last = latestValue(video, 'views', now);
    if (last.status !== 'exact' || last.value === null || last.asOf === null) return unavailableMetric(last.note ?? 'counter_not_provided');
    if (last.asOf <= b.t) return { value: null, status: 'unavailable', asOf: last.asOf, note: 'after_last_observation' };
    const diff = last.value - b.value;
    if (diff < 0) return { value: diff, status: 'decrease_flagged', asOf: last.asOf, note: 'counter_decreased' };
    const tol = Math.min(DEFAULT_BOUNDARY_TOLERANCE_MS, (now - b.t) * BOUNDARY_TOLERANCE_WINDOW_FRACTION);
    const fresh = now - last.asOf <= tol;
    return { value: diff, status: fresh ? 'exact' : 'lower_bound', asOf: last.asOf, note: fresh ? null : 'end_after_last_observation' };
  }
  if (pin.dataNow === null) return unavailableMetric('no_observations');
  if (pin.dataNow >= now) return unavailableMetric('window_not_started');
  return increment(video, 'views', pin.dataNow, now, now);
}

export function computeWatchVideos(index: DatasetIndex, input: WatchVideosInput): WatchVideosResult {
  const { pins, now, since } = input;
  const present = new Set<Platform>();
  const rows = pins.map((pin): WatchVideoRow => {
    const found = index.videosById.get(pin.id);
    const video = found && found.publishedAt <= now ? found : null;
    if (video) present.add(video.platform);
    return {
      id: pin.id,
      video,
      accountName: video ? (index.accountsById.get(video.accountId)?.name ?? null) : null,
      atPin: pinValue(video, pin),
      current: video ? cumulativeAsOf(video, 'views', now) : unavailableMetric('no_observations'),
      growth: pinGrowth(video, pin, now),
      sinceVisit:
        since === null ? null : !video ? unavailableMetric('no_observations') : since >= now ? unavailableMetric('window_not_started') : increment(video, 'views', since, now, now),
    };
  });
  return { rows, platforms: PLATFORMS.filter((p) => present.has(p)) };
}

/* ------------------------------------------------------------------------------------------ keywords */

export interface WatchKeywordsInput {
  keywords: string[];
  range: LocalDateRange;
  rollingHours: number | null;
  tz: string;
  now: number;
  since: number | null;
}

export interface WatchKeywordRow {
  kw: string;
  /** Tracked videos matching the keyword (published by now). */
  total: number;
  /** Matching videos published inside the window. */
  uploadsInWindow: number;
  /** View increase inside the window over the matching videos (activity semantics). */
  viewsInWindow: MetricValue;
  /** Matching videos per platform (most first). */
  platforms: { platform: Platform; count: number }[];
  since: SinceVisitStats | null;
  lastUpload: number | null;
}

export interface WatchKeywordsResult {
  window: UtcWindow;
  rows: WatchKeywordRow[];
}

/**
 * A predicate with the keyword page's default match (core compileKeyword / keywordMatches: every term of the
 * phrase in the title, tags, topics or description; short ASCII terms as whole words), so the counts here equal
 * what `/keywords?kw=` shows with its default settings. A keyword with nothing searchable matches nothing.
 */
export function keywordMatcher(kw: string): (v: Video) => boolean {
  let compiled: CompiledKeyword;
  try {
    compiled = compileKeyword(kw, 'all');
  } catch {
    return () => false;
  }
  return (v) => keywordMatches(v, compiled) !== null;
}

/** Keyword statistics over the tracked videos matching each keyword (see keywordMatcher). */
export function computeWatchKeywords(index: DatasetIndex, input: WatchKeywordsInput): WatchKeywordsResult {
  const { keywords, range, rollingHours, tz, now, since } = input;
  const idx = indexAsOf(index, now);
  const w = resolveAnalysisWindow(range, tz, now, rollingHours);
  const end = Math.min(w.endMs, now);
  const rows = keywords.map((kw): WatchKeywordRow => {
    const match = keywordMatcher(kw);
    const videos: Video[] = [];
    for (const v of idx.dataset.videos) if (v.publishedAt <= now && match(v)) videos.push(v);
    let uploadsInWindow = 0;
    let lastUpload: number | null = null;
    const per = new Map<Platform, number>();
    const parts: MetricValue[] = [];
    for (const v of videos) {
      if (v.publishedAt >= w.startMs && v.publishedAt < end) uploadsInWindow++;
      if (lastUpload === null || v.publishedAt > lastUpload) lastUpload = v.publishedAt;
      per.set(v.platform, (per.get(v.platform) ?? 0) + 1);
      parts.push(windowIncrement(v, 'views', w, now));
    }
    return {
      kw,
      total: videos.length,
      uploadsInWindow,
      viewsInWindow: sumOrUnavailable(parts),
      platforms: [...per.entries()].map(([platform, count]) => ({ platform, count })).sort((a, b) => b.count - a.count || PLATFORMS.indexOf(a.platform) - PLATFORMS.indexOf(b.platform)),
      since: since === null ? null : sinceVisitStats(videos, since, now),
      lastUpload,
    };
  });
  return { window: w, rows };
}

/* ------------------------------------------------------------------------------------------ pins */

function platformOfId(id: string): Platform | null {
  const p = id.slice(0, id.indexOf(':'));
  return (PLATFORMS as readonly string[]).includes(p) ? (p as Platform) : null;
}

/** A creator pin with the name and platforms known at data time `now`. */
export function creatorPinFor(index: DatasetIndex, key: string, now: number, at: number): PinnedCreator {
  const p = creatorPortfolios(indexAsOf(index, now)).get(key);
  const set = new Set<Platform>();
  for (const a of p?.accounts ?? []) set.add(a.platform);
  for (const id of p?.accountIds ?? []) {
    const pf = platformOfId(id);
    if (pf) set.add(pf);
  }
  return { key, name: p?.name || key, platforms: PLATFORMS.filter((x) => set.has(x)), pinnedAt: at, dataNow: now };
}

/** A video pin carrying the latest views observation known at data time `now` (the "since pinned" baseline). */
export function videoPinFor(index: DatasetIndex, id: string, now: number, at: number): PinnedVideo {
  const v = index.videosById.get(id);
  if (!v) return { id, title: '', platform: platformOfId(id), accountName: null, pinnedAt: at, dataNow: now, baseline: null };
  return {
    id,
    title: v.title,
    platform: v.platform,
    accountName: index.accountsById.get(v.accountId)?.name ?? null,
    pinnedAt: at,
    dataNow: now,
    baseline: viewsBaseline(v, now),
  };
}

export function keywordPinFor(kw: string, now: number | null, at: number): PinnedKeyword | null {
  const clean = cleanKeyword(kw);
  return clean ? { kw: clean, pinnedAt: at, dataNow: now } : null;
}
