/**
 * Pure page logic for 트렌드 (/trends): entity membership (mirrors core computeTrending), like-for-like daily
 * increment series for sparklines, top-video increments, window labels and empty-list reasons.
 * No React here so it can be unit-tested against fixtures and the real dataset.
 */
import {
  addDays,
  ancestorsOf,
  categoryFilterSet,
  compileVideoFilter,
  dailyIncrements,
  daysBetween,
  increment,
  indexAsOf,
  localDateOf,
  localDateStartUtc,
  windowIncrement,
} from '@vti/core';
import type {
  Account,
  DatasetIndex,
  MetricStatus,
  MetricValue,
  Platform,
  TrendEntityKind,
  TrendingResult,
  TrendItem,
  UtcWindow,
  Video,
} from '@vti/core';
import { fmtTime } from '../../lib/display.ts';
import { hrefWith } from '../../lib/urlState.ts';
import { isEarlyHistory } from './readiness.ts';
import type { DataReadiness } from './readiness.ts';

export const TREND_KINDS: TrendEntityKind[] = ['topic', 'category', 'creator', 'account'];

export const TREND_KIND_LABELS: Record<TrendEntityKind, string> = {
  topic: '주제',
  category: '분야',
  creator: '크리에이터',
  account: '계정',
};

export const TREND_KIND_DESCRIPTIONS: Record<TrendEntityKind, string> = {
  topic: '영상 제목·태그에서 뽑은 주제(해시태그·키워드)별 조회 증가 합계.',
  category: '분류 체계의 분야별 합계. 세부 분야 영상은 상위 분야 합계에도 포함됨.',
  creator: '여러 플랫폼 계정을 묶은 크리에이터 단위 합계. 연결되지 않은 계정은 계정 단위로 표시.',
  account: '플랫폼 계정(채널) 단위 합계.',
};

export type TrendListId = 'rising' | 'falling' | 'top';

/** Max local days for which the per-item daily series is computed (longer windows skip the sparkline). */
export const MAX_SPARK_DAYS = 45;
/** Fewer days than this make a sparkline meaningless (e.g. the rolling 24h window touches 2 dates). */
export const MIN_SPARK_DAYS = 3;

/* ------------------------------------------------------------------------------------------ windows */

function isLocalMidnight(ms: number, tz: string): boolean {
  try {
    return localDateStartUtc(localDateOf(ms, tz), tz) === ms;
  } catch {
    return false;
  }
}

/**
 * Label of a half-open span [startMs, endMs): local dates (inclusive) when both ends are local midnights,
 * otherwise start/end date-times (rolling windows, clipped previous windows).
 */
export function spanLabel(startMs: number, endMs: number, tz: string): string {
  if (isLocalMidnight(startMs, tz) && isLocalMidnight(endMs, tz)) {
    const s = fmtTime(startMs, tz, 'date');
    const e = fmtTime(endMs - 1, tz, 'date');
    return s === e ? s : `${s} ~ ${e}`;
  }
  return `${fmtTime(startMs, tz, 'datetime')} ~ ${fmtTime(endMs, tz, 'datetime')}`;
}

/** The part of the current window that has data (clipped to now). */
export function observedSpan(w: UtcWindow, now: number): { startMs: number; endMs: number } {
  return { startMs: w.startMs, endMs: Math.min(w.endMs, now) };
}

/* ------------------------------------------------------------------------------------------ entities */

/** Entity keys of a video for a trend kind — the same rules as core computeTrending. */
export function entityKeysOf(kind: TrendEntityKind, v: Video, index: DatasetIndex, categoryScope: Set<string> | null = null): string[] {
  let keys: string[];
  switch (kind) {
    case 'topic':
      keys = [...new Set(v.topics ?? [])];
      break;
    case 'category': {
      const s = new Set<string>();
      for (const c of v.categories ?? []) for (const a of ancestorsOf(c.id)) s.add(a);
      keys = [...s];
      break;
    }
    case 'creator':
      keys = [index.creatorOfAccount.get(v.accountId) ?? v.accountId];
      break;
    case 'account':
      keys = [v.accountId];
      break;
    default:
      keys = [];
  }
  return categoryScope && kind === 'category' ? keys.filter((k) => categoryScope.has(k)) : keys;
}

/** All distinct keys of the three lists (rising, falling, top), sorted (a stable cache key). */
export function listedKeys(result: Pick<TrendingResult, 'rising' | 'falling' | 'top'>): string[] {
  const s = new Set<string>();
  for (const list of [result.rising, result.falling, result.top]) for (const it of list) s.add(it.key);
  return [...s].sort();
}

/* ------------------------------------------------------------------------------------------ daily series */

export interface EntityDailyInput {
  kind: TrendEntityKind;
  keys: string[];
  startMs: number;
  endMs: number;
  tz: string;
  now: number;
  platforms?: Platform[];
  categories?: string[];
  languages?: string[];
}

export interface EntityDaily {
  /** Local dates covered (inclusive), oldest first. */
  dates: string[];
  /**
   * Daily view increase summed over the members whose increment is known on EVERY day (same video set on
   * each day, so days are comparable). null when no member is fully observed.
   */
  values: number[] | null;
  /** Weakest status among the summed member-days (exact < interpolated < source_reported). */
  statuses: MetricStatus[];
  /** Members summed (known on every day). */
  fullMembers: number;
  /** Members in scope (published before the window end and matching the filters). */
  totalMembers: number;
}

export interface EntityDailyResult {
  dates: string[];
  /** Why no series was computed ('too_long' / 'too_short'), else null. */
  skipped: 'too_long' | 'too_short' | 'not_started' | null;
  byKey: Record<string, EntityDaily>;
}

const DAY_STATUS_RANK: Partial<Record<MetricStatus, number>> = { exact: 0, interpolated: 1, source_reported: 2 };
const DAY_STATUS_BY_RANK: MetricStatus[] = ['exact', 'interpolated', 'source_reported'];

/**
 * Daily view increments per listed entity for the local dates the window touches (clipped to now).
 * Like-for-like: only members whose daily increment is known (exact / interpolated) on every day are
 * summed; members with a lower bound, an unknown or a decreasing day are left out (counted in
 * totalMembers - fullMembers). This mirrors computeTrending's "same video set" rule.
 */
export function entityDailySeries(index: DatasetIndex, input: EntityDailyInput): EntityDailyResult {
  const { kind, tz, now } = input;
  const end = Math.min(input.endMs, now);
  if (!(end > input.startMs)) return { dates: [], skipped: 'not_started', byKey: {} };
  const firstDate = localDateOf(input.startMs, tz);
  const lastDate = localDateOf(end - 1, tz);
  const nDays = daysBetween(firstDate, lastDate) + 1;
  if (nDays > MAX_SPARK_DAYS) return { dates: [], skipped: 'too_long', byKey: {} };
  if (nDays < MIN_SPARK_DAYS) return { dates: [], skipped: 'too_short', byKey: {} };

  const idx = indexAsOf(index, now);
  const matches = compileVideoFilter(idx, { platforms: input.platforms, categories: input.categories, languages: input.languages });
  const scope = kind === 'category' ? categoryFilterSet(input.categories) : null;
  const want = new Set(input.keys);
  const members = new Map<string, Video[]>();
  for (const v of idx.dataset.videos) {
    if (v.publishedAt >= end) continue;
    if (!matches(v)) continue;
    for (const k of entityKeysOf(kind, v, idx, scope)) {
      if (!want.has(k)) continue;
      const list = members.get(k);
      if (list) list.push(v);
      else members.set(k, [v]);
    }
  }

  // Each video's daily increments are computed once even when it belongs to several entities.
  const perVideo = new Map<string, MetricValue[] | null>();
  const dailyOf = (v: Video): MetricValue[] | null => {
    if (perVideo.has(v.id)) return perVideo.get(v.id) as MetricValue[] | null;
    const days = dailyIncrements(v, 'views', firstDate, lastDate, tz, now).map((d) => d.value);
    const complete = days.every((m) => DAY_STATUS_RANK[m.status] !== undefined && typeof m.value === 'number' && Number.isFinite(m.value));
    const out = complete ? days : null;
    perVideo.set(v.id, out);
    return out;
  };

  let dates: string[] = [];
  const byKey: Record<string, EntityDaily> = {};
  for (const key of input.keys) {
    const list = members.get(key) ?? [];
    const sums = new Array<number>(nDays).fill(0);
    const ranks = new Array<number>(nDays).fill(0);
    let full = 0;
    for (const v of list) {
      const days = dailyOf(v);
      if (!days) continue;
      full++;
      for (let i = 0; i < nDays; i++) {
        sums[i] += days[i].value as number;
        const r = DAY_STATUS_RANK[days[i].status] as number;
        if (r > ranks[i]) ranks[i] = r;
      }
    }
    byKey[key] = {
      dates: [],
      values: full > 0 ? sums : null,
      statuses: ranks.map((r) => DAY_STATUS_BY_RANK[r]),
      fullMembers: full,
      totalMembers: list.length,
    };
  }
  // Dates are the same for every entity.
  if (nDays > 0) {
    dates = [];
    let d = firstDate;
    for (let i = 0; i < nDays; i++) {
      dates.push(d);
      d = addDays(d, 1);
    }
    for (const k of Object.keys(byKey)) byKey[k].dates = dates;
  }
  return { dates, skipped: null, byKey };
}

/* ------------------------------------------------------------------------------------------ top videos */

export interface TopVideoRow {
  video: Video;
  account: Account | null;
  current: MetricValue;
  previous: MetricValue;
}

/** Current / previous-window view increase of an item's top videos (the values computeTrending summed). */
export function topVideoRows(
  index: DatasetIndex,
  input: { ids: string[]; startMs: number; endMs: number; prevStartMs: number; prevEndMs: number; tz: string; now: number },
): TopVideoRow[] {
  const idx = indexAsOf(index, input.now);
  const w: UtcWindow = { startMs: input.startMs, endMs: input.endMs, tz: input.tz, incomplete: input.endMs > input.now };
  const rows: TopVideoRow[] = [];
  for (const id of input.ids) {
    const v = idx.videosById.get(id);
    if (!v) continue;
    rows.push({
      video: v,
      account: idx.accountsById.get(v.accountId) ?? null,
      current: windowIncrement(v, 'views', w, input.now),
      previous: increment(v, 'views', input.prevStartMs, input.prevEndMs, input.now),
    });
  }
  return rows;
}

/* ------------------------------------------------------------------------------------------ item values */

/**
 * A trend sum as a MetricValue for MetricCell: the sum of like-for-like (exact / interpolated / source)
 * increments. When some videos of the item could not be summed (incompleteCount > 0) the item's true
 * total is at least this value, so it is a lower bound.
 */
export function trendSum(value: number, item: Pick<TrendItem, 'incompleteCount'>, asOf: number): MetricValue {
  return { value, status: item.incompleteCount > 0 ? 'lower_bound' : 'interpolated', asOf, note: item.incompleteCount > 0 ? 'partial' : null };
}

/** True when the item is new in this window (no views in the previous window, so growth is undefined). */
export function isNewItem(item: Pick<TrendItem, 'growth' | 'previous' | 'current'>): boolean {
  return item.growth === null && item.previous === 0 && item.current > 0;
}

/** Growth at least this ratio (x11, shown as "배") is flagged as coming from a very small previous base. */
export const SMALL_BASE_GROWTH = 10;

/**
 * True when the growth rate rests on a tiny previous sum (>= +1,000%): the rising list only guards the
 * current sum (core minCurrent), so e.g. 6 -> 13만 views would read as "+21,000배" without a caveat.
 */
export function smallBase(item: Pick<TrendItem, 'growth' | 'previous'>): boolean {
  return item.growth !== null && item.previous > 0 && item.growth >= SMALL_BASE_GROWTH;
}

/* ------------------------------------------------------------------------------------------ links */

export interface TrendLinkParams {
  range: string;
  platforms?: Platform[];
  cats?: string[];
  langs?: string[];
}

/** Where an item links to: the video search (topic / category) or the creator detail (creator / account). */
export function itemHref(kind: TrendEntityKind, key: string, p: TrendLinkParams): string {
  if (kind === 'creator' || kind === 'account') return `/creators/${encodeURIComponent(key)}`;
  const base = { mode: 'activity', sort: 'views_period', range: p.range, platforms: p.platforms, langs: p.langs };
  if (kind === 'topic') return hrefWith('/videos', { ...base, topics: [key], cats: p.cats });
  return hrefWith('/videos', { ...base, cats: [key] });
}

/** Link to the video detail drawer of the video search page. */
export function videoHref(id: string, range: string): string {
  return hrefWith('/videos', { mode: 'activity', sort: 'views_period', range, v: id });
}

/* ------------------------------------------------------------------------------------------ empty lists */

export type EmptyReason = 'no_history' | 'window_before_collection' | 'none';

/**
 * Why a list can be empty with the loaded data:
 * - window_before_collection: the current window starts before the first observation, and nothing could be
 *   compared at all (current increments unknown);
 * - no_history: the previous window starts before the first observation, or most videos still have a single
 *   observation, so previous increments are mostly unknown (only videos published after it — interpolated
 *   from 0 at publish — or with source-reported windows are comparable);
 * - none: enough history; the list is genuinely empty for these filters.
 */
export function emptyReason(result: Pick<TrendingResult, 'window' | 'previousWindow' | 'top'>, r: DataReadiness): EmptyReason {
  if (r.firstObservationAt === null) return 'no_history';
  if (result.top.length === 0 && result.window.startMs < r.firstObservationAt) return 'window_before_collection';
  if (result.previousWindow.startMs < r.firstObservationAt || isEarlyHistory(r)) return 'no_history';
  return 'none';
}
