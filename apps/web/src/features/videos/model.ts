/**
 * Pure logic of the Video Intelligence page (영상 탐색): sort vocabulary per date mode, URL filters ->
 * VideoQuery, one cached full query per dataset (paging and CSV export reuse it), result summaries for the
 * "no data yet" explanations, dataset facets (filter options + counts), topic autocomplete and the
 * detail-drawer series (cumulative views segments, daily increments).
 *
 * No React here: everything is unit-tested in model.test.ts.
 */
import {
  addDays,
  AGE_DAYS,
  dailyIncrements,
  DEFAULT_MAX_INTERPOLATION_GAP_MS,
  localDateOf,
  metricSeries,
  normalizeText,
  queryVideos,
} from '@vti/core';
import type {
  AgeDays,
  DatasetIndex,
  DateMode,
  Evidence,
  LocalDateRange,
  MetricStatus,
  MetricValue,
  Platform,
  QueryResult,
  SortKey,
  Video,
  VideoFormat,
  VideoMetrics,
  VideoQuery,
  VideoStatus,
} from '@vti/core';
import { stableStringify } from '../../lib/cache.ts';
import { countryLabel, languageLabel } from '../../lib/display.ts';
import { orderPlatforms } from '../../lib/platform.ts';

/* ------------------------------------------------------------------------------------------ sort */

export const PAGE_SIZE = 50;

export const DEFAULT_SORT: Record<DateMode, SortKey> = {
  upload: 'views_total',
  activity: 'views_period',
  age: 'views_at_age',
};

export function defaultSortFor(mode: DateMode): SortKey {
  return DEFAULT_SORT[mode];
}

/** Order of the options in the sort menu. */
export const SORT_MENU: SortKey[] = [
  'views_period',
  'views_total',
  'views_at_age',
  'velocity',
  'growth_vs_prev',
  'likes_period',
  'comments_period',
  'engagement_rate',
  'outperformance',
  'percentile',
  'published_at',
];

/** Korean label of a sort key; the period metrics read differently per date mode. */
export function sortLabel(key: SortKey, mode: DateMode, age: AgeDays): string {
  switch (key) {
    case 'views_total':
      return '누적 조회';
    case 'views_period':
      return mode === 'upload' ? '게시 후 조회' : mode === 'activity' ? '기간 조회 증가' : `V${age} 조회`;
    case 'likes_period':
      return mode === 'upload' ? '게시 후 좋아요' : mode === 'activity' ? '기간 좋아요 증가' : `V${age} 좋아요`;
    case 'comments_period':
      return mode === 'upload' ? '게시 후 댓글' : mode === 'activity' ? '기간 댓글 증가' : `V${age} 댓글`;
    case 'velocity':
      return '증가 속도(시간당)';
    case 'growth_vs_prev':
      return '이전 기간 대비';
    case 'engagement_rate':
      return '참여율';
    case 'outperformance':
      return '평소 대비';
    case 'views_at_age':
      return `게시 후 ${age}일 조회(V${age})`;
    case 'percentile':
      return '플랫폼 내 백분위';
    case 'published_at':
      return '게시 시각';
  }
}

/** Why a sort key cannot rank anything in `mode` (null = usable). */
export function sortUnavailableReason(key: SortKey, mode: DateMode): string | null {
  if (key === 'views_at_age' && mode !== 'age') return '게시 후 경과 기준에서만 사용';
  if (key === 'growth_vs_prev' && mode === 'upload') return '기간 안에 게시된 영상은 이전 기간 조회가 없음';
  if (key === 'growth_vs_prev' && mode === 'age') return '기간이 없는 기준이라 비교할 이전 기간이 없음';
  return null;
}

export function isSortApplicable(key: SortKey, mode: DateMode): boolean {
  return sortUnavailableReason(key, mode) === null;
}

/** The sort that is actually used: an inapplicable key from a shared link falls back to the mode default. */
export function effectiveSort(key: SortKey, mode: DateMode): SortKey {
  return isSortApplicable(key, mode) ? key : defaultSortFor(mode);
}

/** The metric ranked by `key` (mirrors core queryVideos; `percentile` ranks by the mode's primary metric). */
export function sortMetric(key: SortKey, m: VideoMetrics, mode: DateMode): MetricValue | null {
  switch (key) {
    case 'views_total':
      return m.viewsTotal;
    case 'views_period':
      return m.viewsPeriod;
    case 'likes_period':
      return m.likesPeriod;
    case 'comments_period':
      return m.commentsPeriod;
    case 'velocity':
      return m.velocity;
    case 'growth_vs_prev':
      return m.growthVsPrev;
    case 'engagement_rate':
      return m.engagementRate;
    case 'outperformance':
      return m.outperformance;
    case 'views_at_age':
      return m.viewsAtAge;
    case 'percentile':
      return primaryMetric(m, mode);
    case 'published_at':
      return null;
  }
}

/** The metric that answers the date mode's question (upload: 누적, activity: 기간 증가, age: V_n). */
export function primaryMetric(m: VideoMetrics, mode: DateMode): MetricValue {
  return mode === 'upload' ? m.viewsTotal : mode === 'activity' ? m.viewsPeriod : m.viewsAtAge;
}

export function primaryMetricLabel(mode: DateMode, age: AgeDays): string {
  return mode === 'upload' ? '누적 조회' : mode === 'activity' ? '기간 조회 증가' : `게시 후 ${age}일 조회(V${age})`;
}

/* ------------------------------------------------------------------------------------------ filters */

export type SponsoredFilter = '' | 'disclosed' | 'any' | 'none';
export const SPONSORED_VALUES = ['disclosed', 'any', 'none'] as const;
export const FORMAT_VALUES: VideoFormat[] = ['short', 'long', 'live', 'unknown'];
export const MIN_VIEWS_PRESETS = [0, 1_000, 10_000, 100_000, 1_000_000];

export const SPONSORED_LABELS: Record<SponsoredFilter, string> = {
  '': '전체',
  disclosed: '공개 표기',
  any: '표기+추정',
  none: '없음',
};

export interface VideoFilters {
  q: string;
  platforms: Platform[];
  cats: string[];
  topics: string[];
  langs: string[];
  countries: string[];
  formats: VideoFormat[];
  sponsored: SponsoredFilter;
  minViews: number;
  /** Account ids (page-specific `accounts` URL key, set from the detail drawer). */
  accounts: string[];
  /** Creator ids (page-specific `creators` URL key, for links from creator pages). */
  creators: string[];
}

export const EMPTY_FILTERS: VideoFilters = {
  q: '',
  platforms: [],
  cats: [],
  topics: [],
  langs: [],
  countries: [],
  formats: [],
  sponsored: '',
  minViews: 0,
  accounts: [],
  creators: [],
};

/** Number of active content filters (the date mode / period is not a filter here). */
export function activeFilterCount(f: VideoFilters): number {
  let n = 0;
  if (f.q.trim()) n++;
  for (const list of [f.platforms, f.cats, f.topics, f.langs, f.countries, f.formats, f.accounts, f.creators]) if (list.length) n++;
  if (f.sponsored) n++;
  if (f.minViews > 0) n++;
  return n;
}

/** URL patch clearing every content filter (and the page). */
export const CLEAR_FILTERS_PATCH = {
  q: null,
  platforms: null,
  cats: null,
  topics: null,
  langs: null,
  countries: null,
  formats: null,
  sponsored: null,
  minViews: null,
  accounts: null,
  creators: null,
  page: null,
} as const;

/** Everything the result depends on; JSON-serializable (it is the analysis cache key). */
export interface VideoSearchInput extends VideoFilters {
  mode: DateMode;
  range: LocalDateRange;
  rollingHours: number | null;
  age: AgeDays;
  tz: string;
  now: number;
  sort: SortKey;
  dir: 'asc' | 'desc';
  /** 1-based requested page (clamped to the result). */
  page: number;
  pageSize: number;
}

function nonEmpty<T>(list: T[]): T[] | undefined {
  return list.length ? list : undefined;
}

/**
 * The core query for the page state, without paging. Age mode compares every tracked video at the same age
 * and ignores the period (a 7-day period would exclude every video that already reached V7).
 */
export function toVideoQuery(i: Omit<VideoSearchInput, 'page' | 'pageSize'>): VideoQuery {
  const age = i.mode === 'age';
  return {
    dateMode: i.mode,
    range: age ? undefined : i.range,
    rollingHours: age ? undefined : (i.rollingHours ?? undefined),
    ageDays: age ? i.age : undefined,
    tz: i.tz,
    now: i.now,
    sort: effectiveSort(i.sort, i.mode),
    sortDir: i.dir,
    q: i.q.trim() || undefined,
    platforms: nonEmpty(i.platforms),
    categories: nonEmpty(i.cats),
    topics: nonEmpty(i.topics),
    languages: nonEmpty(i.langs),
    countries: nonEmpty(i.countries),
    formats: nonEmpty(i.formats),
    accountIds: nonEmpty(i.accounts),
    creatorIds: nonEmpty(i.creators),
    sponsored: i.sponsored || undefined,
    minViews: i.minViews > 0 ? i.minViews : undefined,
  };
}

/* ------------------------------------------------------------------------------------------ query */

const fullCache = new WeakMap<DatasetIndex, { key: string; result: QueryResult }>();

/**
 * queryVideos without limit/offset, memoized per dataset index for the LAST query only (paging through
 * results and exporting them reuse it without recomputing metrics; memory stays bounded to one result).
 */
export function fullVideoQuery(index: DatasetIndex, q: VideoQuery): QueryResult {
  const base: VideoQuery = { ...q, limit: undefined, offset: undefined };
  const key = stableStringify(base);
  const hit = fullCache.get(index);
  if (hit && hit.key === key) return hit.result;
  const result = queryVideos(index, base);
  fullCache.set(index, { key, result });
  return result;
}

export interface StatusSummary {
  total: number;
  counts: Partial<Record<MetricStatus, number>>;
  /** Values that rank (exact / interpolated / lower_bound / source_reported). */
  known: number;
  unavailable: number;
  decreased: number;
}

export function summarizeStatuses(values: Iterable<Pick<MetricValue, 'status'>>): StatusSummary {
  const counts: Partial<Record<MetricStatus, number>> = {};
  let total = 0;
  for (const m of values) {
    counts[m.status] = (counts[m.status] ?? 0) + 1;
    total++;
  }
  const unavailable = counts.unavailable ?? 0;
  const decreased = counts.decrease_flagged ?? 0;
  return { total, counts, known: total - unavailable - decreased, unavailable, decreased };
}

/** How complete the mode's primary metric is across the filtered result. */
export type DataCoverage = 'empty' | 'none' | 'partial' | 'ok';

/** Share of unavailable values from which the page explains the gap prominently. */
export const PARTIAL_THRESHOLD = 0.2;

export function dataCoverage(s: StatusSummary): DataCoverage {
  if (s.total === 0) return 'empty';
  if (s.known === 0) return 'none';
  return s.unavailable / s.total >= PARTIAL_THRESHOLD ? 'partial' : 'ok';
}

export interface VideoSearchResult {
  /** The core result with `rows` = the current page only (notes / total / window describe everything). */
  result: QueryResult;
  page: number;
  pageSize: number;
  pageCount: number;
  offset: number;
  /** Status breakdown of the mode's primary metric over the whole filtered result. */
  primary: StatusSummary;
  /** Status breakdown of the sort metric (null for published_at). */
  sorted: StatusSummary | null;
  /** Platforms present in the filtered result (canonical order). */
  platforms: Platform[];
}

export function searchVideos(index: DatasetIndex, input: VideoSearchInput): VideoSearchResult {
  const full = fullVideoQuery(index, toVideoQuery(input));
  const size = Math.max(1, Math.floor(input.pageSize) || PAGE_SIZE);
  const pageCount = Math.max(1, Math.ceil(full.total / size));
  const page = Math.min(pageCount, Math.max(1, Math.floor(input.page) || 1));
  const offset = (page - 1) * size;
  const sort = effectiveSort(input.sort, input.mode);
  const primary = summarizeStatuses(full.rows.map((r) => primaryMetric(r.metrics, input.mode)));
  const sorted =
    sort === 'published_at' ? null : summarizeStatuses(full.rows.map((r) => sortMetric(sort, r.metrics, input.mode) as MetricValue));
  return {
    result: { ...full, rows: full.rows.slice(offset, offset + size) },
    page,
    pageSize: size,
    pageCount,
    offset,
    primary,
    sorted,
    platforms: orderPlatforms(full.rows.map((r) => r.video.platform)),
  };
}

/* ------------------------------------------------------------------------------------------ facets */

export interface FacetOption {
  value: string;
  label: string;
  count: number;
  keywords?: string[];
}

export interface TopicEntry {
  topic: string;
  norm: string;
  count: number;
}

export interface VideoFacets {
  platforms: Platform[];
  platformCounts: Partial<Record<Platform, number>>;
  languages: FacetOption[];
  countries: FacetOption[];
  formats: FacetOption[];
  /** Videos per taxonomy id, counting a video once under each of its ids and their ancestors. */
  categoryCounts: Record<string, number>;
  topics: TopicEntry[];
  /** Videos with at least 2 views observations (a growth curve exists). */
  multiObserved: number;
}

export const FORMAT_FILTER_LABELS: Record<VideoFormat, string> = {
  short: '쇼츠·숏폼',
  long: '일반 영상',
  live: '라이브',
  unknown: '형식 미상',
};

const facetCache = new WeakMap<readonly Video[], VideoFacets>();

function countsToOptions(counts: Map<string, number>, label: (v: string) => string, keywords?: (v: string) => string[]): FacetOption[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([value, count]) => ({ value, label: label(value), count, keywords: keywords?.(value) }));
}

/** Filter options with counts over the whole dataset (cached per videos array). */
export function videoFacets(videos: readonly Video[]): VideoFacets {
  const hit = facetCache.get(videos);
  if (hit) return hit;
  const platformCounts: Partial<Record<Platform, number>> = {};
  const langs = new Map<string, number>();
  const countries = new Map<string, number>();
  const formats = new Map<string, number>();
  const cats: Record<string, number> = {};
  const topics = new Map<string, number>();
  let multiObserved = 0;
  for (const v of videos) {
    platformCounts[v.platform] = (platformCounts[v.platform] ?? 0) + 1;
    if (v.language) langs.set(v.language, (langs.get(v.language) ?? 0) + 1);
    if (v.country) {
      const c = v.country.toUpperCase();
      countries.set(c, (countries.get(c) ?? 0) + 1);
    }
    formats.set(v.format, (formats.get(v.format) ?? 0) + 1);
    const ids = new Set<string>();
    for (const c of v.categories ?? []) {
      const parts = c.id.split('/');
      for (let i = 1; i <= parts.length; i++) ids.add(parts.slice(0, i).join('/'));
    }
    for (const id of ids) cats[id] = (cats[id] ?? 0) + 1;
    for (const t of v.topics ?? []) topics.set(t, (topics.get(t) ?? 0) + 1);
    let n = 0;
    for (const o of v.obs) if (o.views !== null) n++;
    if (n >= 2) multiObserved++;
  }
  const formatOptions: FacetOption[] = FORMAT_VALUES.filter((f) => f !== 'unknown' || formats.has(f)).map((f) => ({
    value: f,
    label: FORMAT_FILTER_LABELS[f],
    count: formats.get(f) ?? 0,
  }));
  const facets: VideoFacets = {
    platforms: orderPlatforms(videos.map((v) => v.platform)),
    platformCounts,
    languages: countsToOptions(langs, (c) => languageLabel(c), (c) => [c]),
    countries: countsToOptions(countries, (c) => `${countryLabel(c)} (${c})`, (c) => [c]),
    formats: formatOptions,
    categoryCounts: cats,
    topics: [...topics.entries()]
      .map(([topic, count]) => ({ topic, norm: normalizeText(topic), count }))
      .sort((a, b) => b.count - a.count || (a.topic < b.topic ? -1 : 1)),
    multiObserved,
  };
  facetCache.set(videos, facets);
  return facets;
}

/**
 * Topic autocomplete: entries whose normalized key contains the normalized query (prefix matches first,
 * then by video count), excluding already selected topics. Empty query = the most frequent topics.
 */
export function matchTopics(topics: readonly TopicEntry[], query: string, selected: readonly string[] = [], limit = 50): TopicEntry[] {
  const q = normalizeText(query);
  const skip = new Set(selected);
  const out: TopicEntry[] = [];
  if (!q) {
    for (const t of topics) {
      if (skip.has(t.topic)) continue;
      out.push(t);
      if (out.length >= limit) break;
    }
    return out;
  }
  const prefix: TopicEntry[] = [];
  const inner: TopicEntry[] = [];
  for (const t of topics) {
    if (skip.has(t.topic)) continue;
    const i = t.norm.indexOf(q);
    if (i === 0) prefix.push(t);
    else if (i > 0) inner.push(t);
    if (prefix.length >= limit) break;
  }
  return [...prefix, ...inner].slice(0, limit);
}

/* ------------------------------------------------------------------------------------------ detail */

export type SegmentKind = 'interp' | 'gap' | 'anchor' | 'decrease';

export const SEGMENT_LABELS: Record<SegmentKind, string> = {
  interp: '관측 사이 보간 구간(≈)',
  anchor: '게시 시점(0)부터 보간(≈)',
  gap: '관측 공백: 보간하지 않음',
  decrease: '감소 구간(⚠, 순위 제외)',
};

export interface ChartPoint {
  t: number;
  v: number;
}

export interface ViewsChartRow {
  x: number;
  interp: number | null;
  gap: number | null;
  anchor: number | null;
  decrease: number | null;
  /** Value at an observed point (dot). */
  obs: number | null;
  /** Row describes the publish anchor (0 by definition). */
  isAnchor: boolean;
}

export interface ViewsChartModel {
  /** Observations that carry a views value. */
  points: (ChartPoint & { src: string })[];
  /** (publishedAt, 0) when the first observation is close enough to publish to interpolate from it. */
  anchor: ChartPoint | null;
  segments: { a: ChartPoint; b: ChartPoint; kind: SegmentKind }[];
  /** Recharts rows: each segment contributes its two endpoints in its own series (see buildViewsChart). */
  rows: ViewsChartRow[];
  kinds: SegmentKind[];
}

/**
 * Cumulative views from our observations, split into segments by how trustworthy the line between two
 * points is: `interp` (gap <= the interpolation limit), `gap` (wider gap or the counter was hidden in
 * between: values there are not interpolated), `decrease` (counter went down) and `anchor` (from publish at 0).
 *
 * Rows: every segment emits its two endpoints with only its own series key set, so a series is continuous
 * across consecutive segments of the same kind and broken (null rows) where the kind changes.
 */
export function buildViewsChart(video: Video, maxGapMs = DEFAULT_MAX_INTERPOLATION_GAP_MS): ViewsChartModel {
  const s = metricSeries(video, 'views');
  const srcByT = new Map<number, string>();
  for (const o of video.obs) if (o.views !== null && !srcByT.has(o.t)) srcByT.set(o.t, o.src);
  const points = s.t.map((t, i) => ({ t, v: s.v[i], src: srcByT.get(t) ?? '' }));
  const segments: ViewsChartModel['segments'] = [];
  let anchor: ChartPoint | null = null;
  if (points.length && points[0].t > video.publishedAt && points[0].t - video.publishedAt <= maxGapMs && !s.nullBefore) {
    anchor = { t: video.publishedAt, v: 0 };
    segments.push({ a: anchor, b: points[0], kind: 'anchor' });
  }
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const kind: SegmentKind = b.v < a.v ? 'decrease' : b.t - a.t > maxGapMs || s.nullBetween[i] ? 'gap' : 'interp';
    segments.push({ a, b, kind });
  }
  const empty = (x: number, isAnchor = false): ViewsChartRow => ({ x, interp: null, gap: null, anchor: null, decrease: null, obs: null, isAnchor });
  const rows: ViewsChartRow[] = [];
  const observed = new Set(points.map((p) => p.t));
  for (const seg of segments) {
    for (const p of [seg.a, seg.b]) {
      const row = empty(p.t, anchor !== null && p === anchor);
      row[seg.kind] = p.v;
      if (observed.has(p.t) && p !== anchor) row.obs = p.v;
      rows.push(row);
    }
  }
  if (!segments.length) for (const p of points) rows.push({ ...empty(p.t), obs: p.v });
  const kinds = (['interp', 'anchor', 'gap', 'decrease'] as SegmentKind[]).filter((k) => segments.some((g) => g.kind === k));
  return { points, anchor, segments, rows, kinds };
}

/** Local-date span for the daily increment bars: the last `days` local days, not before the publish day. */
export function dailySpan(video: Pick<Video, 'publishedAt'>, tz: string, now: number, days = 14): { start: string; end: string } {
  const end = localDateOf(now, tz);
  const earliest = addDays(end, -(Math.max(1, days) - 1));
  const published = localDateOf(Math.min(video.publishedAt, now), tz);
  return { start: published > earliest ? published : earliest, end };
}

export function dailyViewIncrements(video: Video, tz: string, now: number, days = 14): { date: string; value: MetricValue }[] {
  const span = dailySpan(video, tz, now, days);
  return dailyIncrements(video, 'views', span.start, span.end, tz, now);
}

/** A raw observed counter as a MetricValue (null = the source did not provide it in this observation). */
export function observedMetric(value: number | null, t: number): MetricValue {
  return value === null
    ? { value: null, status: 'unavailable', asOf: t, note: 'counter_not_provided' }
    : { value, status: 'exact', asOf: t, note: null };
}

/** Source adapter for a metric cell: the source window's for source-reported values, else the last observation's. */
export function metricSource(video: Video, m: Pick<MetricValue, 'status' | 'asOf'> | null | undefined): string | null {
  if (m?.status === 'source_reported') {
    const sw = video.sourceWindows.find((w) => w.observedAt === m.asOf) ?? video.sourceWindows[0];
    if (sw) return sw.src;
  }
  const o = video.obs;
  return o.length ? o[o.length - 1].src : null;
}

/** Creator page key for an account: its creator id when linked, else the account id. */
export function creatorKeyOf(index: DatasetIndex, accountId: string): string {
  return index.creatorOfAccount.get(accountId) ?? accountId;
}

export const AGE_ROWS: readonly AgeDays[] = AGE_DAYS;

export const EVIDENCE_FIELD_LABELS: Record<Evidence['field'], string> = {
  title: '제목',
  tags: '태그',
  description: '설명',
  sourceCategory: '원천 분류',
  account: '계정',
  manual: '수동 지정',
};

export const ASSIGNED_BY_LABELS: Record<'rule' | 'source' | 'account' | 'manual', string> = {
  rule: '키워드 규칙',
  source: '원천 분류 매핑',
  account: '계정 분야',
  manual: '수동 지정',
};

export const SPONSOR_LEVEL_LABELS: Record<'disclosed' | 'likely', string> = {
  disclosed: '광고 표기',
  likely: '협찬 추정',
};

export const LANGUAGE_SOURCE_LABELS: Record<'source' | 'detected', string> = {
  source: '원천 제공',
  detected: '자동 감지',
};

export const VIDEO_STATUS_LABELS: Record<VideoStatus, string> = {
  active: '공개',
  deleted: '삭제됨',
  private: '비공개',
  unknown: '알 수 없음',
};

export function windowHoursLabel(hours: number): string {
  if (hours === 24) return '최근 24시간';
  if (hours === 168) return '최근 168시간(7일)';
  if (hours === 720) return '최근 720시간(30일)';
  return `최근 ${hours}시간`;
}

export const METRIC_KEY_LABELS: Record<string, string> = { views: '조회', likes: '좋아요', comments: '댓글', shares: '공유' };
