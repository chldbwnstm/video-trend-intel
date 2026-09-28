/**
 * Pure page logic for 비디오 레이팅 (/ratings, Tubular Video Ratings V1..V30): per-platform age cohorts
 * (reached / not reached / value statuses / ranked values), the default platform, and log-scale histogram
 * bins of views-at-age. No React; unit-tested.
 */
import { AGE_DAYS, DAY, PLATFORMS, ageMaxGapMs, compileVideoFilter, indexAsOf, queryVideos, rankValue, resolveAnalysisWindow } from '@vti/core';
import type { AgeDays, DatasetIndex, LocalDateRange, MetricStatus, Platform, UtcWindow } from '@vti/core';
import { formatCompact } from '../../lib/format.ts';

export const RATING_AGES: readonly AgeDays[] = AGE_DAYS;

/* ------------------------------------------------------------------------------------------ cohort */

export interface CohortInput {
  ageDays: AgeDays;
  tz: string;
  now: number;
  categories?: string[];
  /** Optional publish-date restriction (the page's 게시일 filter). */
  range?: LocalDateRange;
  rollingHours?: number | null;
}

export interface CohortEntry {
  value: number;
  status: MetricStatus;
  /** In-platform percentile (0..100, mid-rank) computed by queryVideos. */
  percentile: number | null;
  /** 1-based rank within the platform (views-at-age desc). */
  rank: number;
  platform: Platform;
}

export interface PlatformCohort {
  platform: Platform;
  /** Videos in scope that reached the age (compared). */
  reached: number;
  /** Videos in scope not old enough yet (excluded). */
  notReached: number;
  /** Reached videos with a rankable V value (exact / interpolated / lower bound / source). */
  ranked: number;
  /** Reached videos whose V value cannot be computed. */
  unavailable: number;
  statusCounts: Partial<Record<MetricStatus, number>>;
  /** Ranked values, ascending. */
  values: number[];
  median: number | null;
  p25: number | null;
  p75: number | null;
}

export interface RatingsCohort {
  window: UtcWindow | null;
  ageDays: AgeDays;
  platforms: PlatformCohort[];
  /** Ranked videos by id. */
  entries: Map<string, CohortEntry>;
}

function quantile(sortedAsc: readonly number[], q: number): number | null {
  const n = sortedAsc.length;
  if (!n) return null;
  const pos = (n - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);
}

/**
 * The age cohort per platform: runs queryVideos in age mode over all platforms (percentiles are per platform
 * in core, so filtering to one platform afterwards keeps them valid) and counts the videos excluded because
 * they have not reached the age yet (same scope rules as queryVideos).
 */
export function ratingsCohort(index: DatasetIndex, input: CohortInput): RatingsCohort {
  const { ageDays, tz, now } = input;
  const hasRange = !!input.range;
  const result = queryVideos(index, {
    dateMode: 'age',
    ageDays,
    tz,
    now,
    sort: 'views_at_age',
    sortDir: 'desc',
    categories: input.categories,
    range: hasRange ? input.range : undefined,
    rollingHours: hasRange && input.rollingHours ? input.rollingHours : undefined,
  });

  const byPlatform = new Map<Platform, PlatformCohort>();
  const get = (p: Platform): PlatformCohort => {
    let c = byPlatform.get(p);
    if (!c) {
      c = { platform: p, reached: 0, notReached: 0, ranked: 0, unavailable: 0, statusCounts: {}, values: [], median: null, p25: null, p75: null };
      byPlatform.set(p, c);
    }
    return c;
  };
  const entries = new Map<string, CohortEntry>();
  for (const row of result.rows) {
    const c = get(row.video.platform);
    c.reached++;
    const m = row.metrics.viewsAtAge;
    c.statusCounts[m.status] = (c.statusCounts[m.status] ?? 0) + 1;
    const rv = rankValue(m);
    if (rv === null) {
      c.unavailable++;
      continue;
    }
    c.ranked++;
    c.values.push(rv);
    entries.set(row.video.id, {
      value: rv,
      status: m.status,
      percentile: row.metrics.percentile.value,
      rank: c.ranked,
      platform: row.video.platform,
    });
  }

  // Not-reached videos (queryVideos only reports their total in a note).
  const idx = indexAsOf(index, now);
  const matches = compileVideoFilter(idx, { categories: input.categories });
  const w = hasRange ? resolveAnalysisWindow(input.range as LocalDateRange, tz, now, input.rollingHours) : null;
  for (const v of idx.dataset.videos) {
    if (v.publishedAt > now) continue;
    if (!matches(v)) continue;
    if (w && !(v.publishedAt >= w.startMs && v.publishedAt < w.endMs)) continue;
    if (v.publishedAt + ageDays * DAY > now) get(v.platform).notReached++;
  }

  const platforms = PLATFORMS.filter((p) => byPlatform.has(p)).map((p) => {
    const c = byPlatform.get(p) as PlatformCohort;
    c.values.sort((a, b) => a - b);
    c.median = quantile(c.values, 0.5);
    c.p25 = quantile(c.values, 0.25);
    c.p75 = quantile(c.values, 0.75);
    return c;
  });
  return { window: result.window, ageDays, platforms, entries };
}

/**
 * The platform shown by default: the one with the most rankable V values; ties -> more reached videos ->
 * canonical platform order. null when there is no video at all.
 */
export function defaultRatingsPlatform(cohorts: readonly PlatformCohort[]): Platform | null {
  let best: PlatformCohort | null = null;
  for (const c of cohorts) {
    if (c.reached + c.notReached === 0) continue;
    if (!best || c.ranked > best.ranked || (c.ranked === best.ranked && c.reached > best.reached)) best = c;
  }
  return best?.platform ?? null;
}

/** Max bracketing gap (hours) for V{age} interpolation (core ageMaxGapMs). */
export function ageGapHours(age: AgeDays): number {
  return Math.round(ageMaxGapMs(age) / 3_600_000);
}

/* ------------------------------------------------------------------------------------------ histogram */

export interface HistBin {
  /** Inclusive lower edge. */
  lo: number;
  /** Exclusive upper edge (the last bin also includes its max value). */
  hi: number;
  count: number;
  label: string;
}

const MANTISSAS = [1, 2, 5] as const;

/** Largest 1-2-5 edge <= x (x > 0). */
function edgeAtOrBelow(x: number): { m: number; k: number } {
  let k = Math.floor(Math.log10(x));
  // Guard against floating error in log10 at exact powers of ten.
  if (10 ** (k + 1) <= x) k++;
  if (10 ** k > x) k--;
  const base = 10 ** k;
  let m: number = 1;
  for (const cand of MANTISSAS) if (cand * base <= x) m = cand;
  return { m, k };
}

function nextEdge(e: { m: number; k: number }): { m: number; k: number } {
  return e.m === 1 ? { m: 2, k: e.k } : e.m === 2 ? { m: 5, k: e.k } : { m: 1, k: e.k + 1 };
}

function edgeValue(e: { m: number; k: number }): number {
  return e.m * 10 ** e.k;
}

/**
 * Log-scale histogram with "nice" 1-2-5 edges (1, 2, 5, 10, 20, 50, ...), roughly uniform on a log axis.
 * Values <= 0 get their own "0" bin (0 views is a real value, not missing). Empty input -> [].
 */
export function logBins(values: readonly number[]): HistBin[] {
  const bins: HistBin[] = [];
  const finite = values.filter((v) => Number.isFinite(v));
  const zeros = finite.filter((v) => v <= 0).length;
  const pos = finite.filter((v) => v > 0).sort((a, b) => a - b);
  if (zeros > 0) bins.push({ lo: 0, hi: 0, count: zeros, label: '0' });
  if (!pos.length) return bins;
  const max = pos[pos.length - 1];
  let e = edgeAtOrBelow(pos[0]);
  let i = 0;
  // Safety cap: 1-2-5 edges over 1..1e13 are < 45 bins.
  for (let guard = 0; guard < 60; guard++) {
    const lo = edgeValue(e);
    const n = nextEdge(e);
    const hi = edgeValue(n);
    let count = 0;
    while (i < pos.length && pos[i] < hi) {
      count++;
      i++;
    }
    bins.push({ lo, hi, count, label: `${formatCompact(lo)}~${formatCompact(hi)}` });
    if (hi > max) break;
    e = n;
  }
  return bins;
}

/** Index of the bin containing `value` (-1 when outside every bin). */
export function binIndexOf(bins: readonly HistBin[], value: number | null | undefined): number {
  if (value === null || value === undefined || !Number.isFinite(value)) return -1;
  if (value <= 0) return bins.findIndex((b) => b.hi === 0);
  for (let i = 0; i < bins.length; i++) {
    const b = bins[i];
    if (b.hi === 0) continue;
    if (value >= b.lo && value < b.hi) return i;
  }
  const last = bins[bins.length - 1];
  return last && value === last.hi ? bins.length - 1 : -1;
}
