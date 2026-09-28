/**
 * Video Intelligence query engine (filter + metrics + sort + percentile). OWNER: core-analytics agent.
 *
 * Also hosts the small analytics helpers shared by trending / explore / creators (as-of snapshots of the
 * index, video filters, medians, percentile ranks, status merging) so every page applies the same rules.
 */
import type {
  Account,
  AgeDays,
  DateMode,
  MetricStatus,
  MetricValue,
  Platform,
  QueryResult,
  SortKey,
  UtcWindow,
  Video,
  VideoFormat,
  VideoMetrics,
  VideoQuery,
  VideoRow,
} from './types.ts';
import { AGE_DAYS, PLATFORMS, PLATFORM_LABELS } from './types.ts';
import type { DatasetIndex } from './dataset.ts';
import { buildIndex } from './dataset.ts';
import { DAY, formatInTz, localDateOf, resolveWindow, rollingWindow } from './time.ts';
import { computeVideoMetrics, rankValue } from './metrics.ts';
import type { MetricContext } from './metrics.ts';
import { descendantsOf } from './taxonomy.ts';
import { compactText, normalizeText } from './text.ts';

/* ------------------------------------------------------------------------------------------
 * Shared helpers (used by trending / explore / creators too)
 * ---------------------------------------------------------------------------------------- */

/** Korean labels of MetricStatus used in notes and exports. */
export const METRIC_STATUS_LABELS_KO: Record<MetricStatus, string> = {
  exact: '정확',
  interpolated: '보간(≈)',
  lower_bound: '하한(≥)',
  source_reported: '원천 보고',
  unavailable: '계산 불가(—)',
  decrease_flagged: '감소 감지(⚠)',
};

/** Korean labels of the sort keys (video query). */
export const SORT_KEY_LABELS_KO: Record<SortKey, string> = {
  views_total: '누적 조회수',
  views_period: '기간 조회수',
  likes_period: '기간 좋아요',
  comments_period: '기간 댓글',
  velocity: '증가 속도(시간당 조회)',
  growth_vs_prev: '직전 기간 대비 성장률',
  engagement_rate: '참여율',
  outperformance: '계정 평소 대비 성과',
  views_at_age: '경과시간 조회수',
  percentile: '플랫폼 내 백분위',
  published_at: '게시 시각',
};

const SORT_KEYS: readonly SortKey[] = Object.keys(SORT_KEY_LABELS_KO) as SortKey[];

function isFiniteNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

/** Statuses whose value is a usable measurement of the quantity itself (not a bound, not a flag). */
export function isSummableMetric(m: MetricValue): boolean {
  return (m.status === 'exact' || m.status === 'interpolated' || m.status === 'source_reported') && isFiniteNumber(m.value);
}

/** Median of a list of finite numbers (null for an empty list). Does not mutate the input. */
export function medianOf(values: readonly number[]): number | null {
  const n = values.length;
  if (!n) return null;
  const s = [...values].sort((a, b) => a - b);
  return n % 2 === 1 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/**
 * Mid-rank percentile (0..100) of every value within `values`:
 * `100 * (count below + 0.5 * count equal) / n`. Ties share a percentile; a single value is 50.
 * Returned in input order.
 */
export function percentileRanks(values: readonly number[]): number[] {
  const n = values.length;
  const out = new Array<number>(n);
  if (!n) return out;
  const order = values.map((_, i) => i).sort((a, b) => values[a] - values[b]);
  let i = 0;
  while (i < n) {
    let j = i + 1;
    while (j < n && values[order[j]] === values[order[i]]) j++;
    const pct = (100 * (i + (j - i) / 2)) / n;
    for (let k = i; k < j; k++) out[order[k]] = pct;
    i = j;
  }
  return out;
}

/** Strict string comparison (locale independent, deterministic across runtimes). */
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Normalizes an optional array filter: undefined / empty means "no filter". */
function filterSet<T>(list: readonly T[] | undefined, map?: (x: T) => T): Set<T> | null {
  if (!list || !list.length) return null;
  return new Set(map ? list.map(map) : list);
}

/** All taxonomy ids matched by a category filter (each id plus its descendants), or null for "no filter". */
export function categoryFilterSet(categories: readonly string[] | undefined): Set<string> | null {
  if (!categories || !categories.length) return null;
  const s = new Set<string>();
  for (const c of categories) for (const d of descendantsOf(c)) s.add(d);
  return s;
}

/** True when the video has one of the category ids in `set` (a set produced by categoryFilterSet). */
export function videoInCategories(v: Video, set: Set<string>): boolean {
  for (const c of v.categories ?? []) if (set.has(c.id)) return true;
  return false;
}

/* --- search text (cached per object; titles/tags/names do not change within a dataset) --- */

const videoSearchCache = new WeakMap<Video, string>();
const accountSearchCache = new WeakMap<Account, string>();

function videoSearchText(v: Video): string {
  let s = videoSearchCache.get(v);
  if (s === undefined) {
    const parts = [normalizeText(v.title ?? ''), compactText(v.title ?? ''), normalizeText(v.id)];
    for (const t of v.tags ?? []) parts.push(normalizeText(t));
    for (const t of v.topics ?? []) parts.push(normalizeText(t));
    s = parts.join('\n');
    videoSearchCache.set(v, s);
  }
  return s;
}

function accountSearchText(a: Account | undefined): string {
  if (!a) return '';
  let s = accountSearchCache.get(a);
  if (s === undefined) {
    s = [normalizeText(a.name ?? ''), compactText(a.name ?? ''), normalizeText(a.handle ?? '')].join('\n');
    accountSearchCache.set(a, s);
  }
  return s;
}

/** Query terms for `q` (normalized, whitespace separated); empty array = no text filter. */
export function searchTerms(q: string | undefined): string[] {
  const n = normalizeText(q ?? '');
  return n ? n.split(' ') : [];
}

/** Content filters shared by the video query and other analytics (subset of VideoQuery). */
export type VideoFilterSpec = Pick<
  VideoQuery,
  'q' | 'platforms' | 'categories' | 'topics' | 'languages' | 'countries' | 'formats' | 'accountIds' | 'creatorIds' | 'sponsored'
>;

/**
 * Compile the content filters of a query into a predicate. Empty lists mean "no filter".
 * - q: every whitespace-separated term must occur (normalized, case/width-insensitive substring) in the
 *   title, tags, topics, video id, or the account name / handle. Korean spacing is tolerated for titles
 *   and account names ('나혼자산다' matches '나 혼자 산다').
 * - categories match the id or any descendant; languages are compared case-insensitively, countries too.
 * - creatorIds resolve through `index.creatorOfAccount`.
 * - sponsored: 'disclosed' = explicit disclosure; 'any' = disclosed or likely; 'none' = no signal.
 */
export function compileVideoFilter(index: DatasetIndex, f: VideoFilterSpec): (v: Video) => boolean {
  const platforms = filterSet<Platform>(f.platforms);
  const categories = categoryFilterSet(f.categories);
  const topics = f.topics && f.topics.length ? new Set(f.topics.flatMap((t) => [t, normalizeText(t)])) : null;
  const languages = filterSet(f.languages, (x) => x.toLowerCase());
  const countries = filterSet(f.countries, (x) => x.toUpperCase());
  const formats = filterSet<VideoFormat>(f.formats);
  const accountIds = filterSet(f.accountIds);
  const creatorIds = filterSet(f.creatorIds);
  const sponsored = f.sponsored;
  const terms = searchTerms(f.q);
  return (v: Video): boolean => {
    if (platforms && !platforms.has(v.platform)) return false;
    if (formats && !formats.has(v.format)) return false;
    if (languages && !(v.language && languages.has(v.language.toLowerCase()))) return false;
    if (countries && !(v.country && countries.has(v.country.toUpperCase()))) return false;
    if (accountIds && !accountIds.has(v.accountId)) return false;
    if (creatorIds) {
      const c = index.creatorOfAccount.get(v.accountId);
      if (!c || !creatorIds.has(c)) return false;
    }
    if (sponsored === 'disclosed' && v.sponsorship?.level !== 'disclosed') return false;
    if (sponsored === 'any' && !v.sponsorship) return false;
    if (sponsored === 'none' && v.sponsorship) return false;
    if (categories && !videoInCategories(v, categories)) return false;
    if (topics) {
      let hit = false;
      for (const t of v.topics ?? []) {
        if (topics.has(t)) {
          hit = true;
          break;
        }
      }
      if (!hit) return false;
    }
    if (terms.length) {
      const vt = videoSearchText(v);
      let at: string | null = null;
      for (const term of terms) {
        if (vt.includes(term)) continue;
        at ??= accountSearchText(index.accountsById.get(v.accountId));
        if (!at.includes(term)) return false;
      }
    }
    return true;
  };
}

/* --- as-of snapshots ------------------------------------------------------------------------ */

const maxTimeCache = new WeakMap<DatasetIndex, number>();
const asOfCache = new WeakMap<DatasetIndex, Map<number, DatasetIndex>>();
const AS_OF_CACHE_MAX = 8;

/**
 * Latest instant at which anything was collected (observation, source window, discovery, follower point).
 * `publishedAt` is deliberately not included: a scheduled premiere with a future publish time is not data
 * "collected after now" (analytics simply skip videos not yet published at `now`).
 */
function latestDataTime(index: DatasetIndex): number {
  const hit = maxTimeCache.get(index);
  if (hit !== undefined) return hit;
  let max = -Infinity;
  for (const v of index.dataset.videos) {
    if (v.firstSeenAt > max) max = v.firstSeenAt;
    if (v.lastObservedAt > max) max = v.lastObservedAt;
    for (const p of v.obs) if (p.t > max) max = p.t;
    for (const w of v.sourceWindows ?? []) if (w.observedAt > max) max = w.observedAt;
  }
  for (const a of index.dataset.accounts) for (const p of a.followers ?? []) if (p.t > max) max = p.t;
  maxTimeCache.set(index, max);
  return max;
}

/**
 * The dataset as it was known at `now`: videos published or first seen after `now` are dropped, and
 * observations, source windows and follower points after `now` are removed. Returns `index` itself when
 * nothing was collected after `now` (the normal case, now = generatedAt), otherwise a cached derived index.
 * (Callers still skip videos whose publishedAt is after `now`, which the fast path keeps.)
 *
 * This makes every analytics result a pure function of (dataset, query, now): regenerating last month's
 * report later with the same `now` gives the same numbers even after newer observations were collected.
 */
export function indexAsOf(index: DatasetIndex, now: number): DatasetIndex {
  if (!isFiniteNumber(now) || latestDataTime(index) <= now) return index;
  let byNow = asOfCache.get(index);
  if (!byNow) {
    byNow = new Map();
    asOfCache.set(index, byNow);
  }
  const hit = byNow.get(now);
  if (hit) return hit;

  const videos: Video[] = [];
  for (const v of index.dataset.videos) {
    if (v.publishedAt > now || v.firstSeenAt > now) continue;
    const future = v.obs.some((p) => p.t > now) || (v.sourceWindows ?? []).some((w) => w.observedAt > now);
    if (!future && !(v.lastObservedAt > now)) {
      videos.push(v);
      continue;
    }
    const obs = v.obs.filter((p) => p.t <= now);
    let last = -Infinity;
    for (const p of obs) if (p.t > last) last = p.t;
    videos.push({
      ...v,
      obs,
      sourceWindows: (v.sourceWindows ?? []).filter((w) => w.observedAt <= now),
      lastObservedAt: obs.length ? last : Math.min(v.lastObservedAt, now),
    });
  }
  const accounts = index.dataset.accounts.map((a) =>
    (a.followers ?? []).some((p) => p.t > now) ? { ...a, followers: a.followers.filter((p) => p.t <= now) } : a,
  );
  const derived = buildIndex({ ...index.dataset, videos, accounts });
  // A derived index is already "as of now": remember that so nested calls return it unchanged.
  maxTimeCache.set(derived, Math.min(latestDataTime(index), now));
  if (byNow.size >= AS_OF_CACHE_MAX) byNow.clear();
  byNow.set(now, derived);
  return derived;
}

/** `now` for an analytics call: the explicit value, else dataset.generatedAt. */
export function resolveNow(index: DatasetIndex, now: number | undefined): number {
  return isFiniteNumber(now) ? now : index.dataset.generatedAt;
}

/* --- merging windowed sums -------------------------------------------------------------------- */

const SUM_STATUS_RANK: Partial<Record<MetricStatus, number>> = { exact: 0, interpolated: 1, source_reported: 2, lower_bound: 3 };
const SUM_STATUS_BY_RANK: MetricStatus[] = ['exact', 'interpolated', 'source_reported', 'lower_bound'];

/**
 * Sum of increments of a non-decreasing counter over several videos (portfolio / platform totals).
 * - exact / interpolated / source_reported / lower_bound values are added; the result has the weakest
 *   status among them (exact < interpolated < source_reported < lower_bound).
 * - An 'unavailable' contributor whose counter is simply not provided by its source is skipped (null is not
 *   zero, and nothing is hidden: that video has no such counter). Any other unavailable contributor makes the
 *   sum a 'lower_bound' (its unknown increase is >= 0).
 * - 'decrease_flagged' contributors are excluded (never counted as negative popularity).
 * - No contributors at all -> 0 'exact' with `emptyNote`; nothing summable -> 'unavailable'.
 */
export function sumIncrements(values: readonly MetricValue[], emptyNote = 'no_tracked_videos'): MetricValue & { decreased: number; unknown: number } {
  let sum = 0;
  let rank = -1;
  let asOf: number | null = null;
  let unknown = 0;
  let decreased = 0;
  let firstNote: string | null = null;
  let notProvided = 0;
  for (const m of values) {
    if (m.status === 'decrease_flagged') {
      decreased++;
      continue;
    }
    const r = SUM_STATUS_RANK[m.status];
    if (r === undefined || !isFiniteNumber(m.value)) {
      if (m.note === 'counter_not_provided') notProvided++;
      else {
        unknown++;
        firstNote ??= m.note;
      }
      continue;
    }
    sum += m.value;
    if (r > rank) rank = r;
    if (m.asOf !== null && (asOf === null || m.asOf > asOf)) asOf = m.asOf;
  }
  if (rank < 0) {
    if (!values.length) return { value: 0, status: 'exact', asOf: null, note: emptyNote, decreased, unknown };
    const note = unknown ? firstNote : notProvided ? 'counter_not_provided' : decreased ? 'counter_decreased' : null;
    return { value: null, status: 'unavailable', asOf: null, note, decreased, unknown };
  }
  if (unknown > 0) rank = 3;
  const status = SUM_STATUS_BY_RANK[rank];
  return { value: sum, status, asOf, note: unknown > 0 ? (firstNote ?? 'partial') : null, decreased, unknown };
}

/* --- labels ---------------------------------------------------------------------------------- */

function dateRangeLabel(w: UtcWindow): string {
  const s = localDateOf(w.startMs, w.tz);
  const e = localDateOf(w.endMs - 1, w.tz);
  return s === e ? `${s}(${w.tz})` : `${s}~${e}(${w.tz})`;
}

/** "YYYY-MM-DD HH:mm (tz)" for notes. */
export function instantLabel(ms: number, tz: string): string {
  return `${formatInTz(ms, tz, 'datetime')} (${tz})`;
}

/** Korean platform list: "YouTube·X". */
export function platformListLabel(platforms: Iterable<Platform>): string {
  const set = new Set(platforms);
  return PLATFORMS.filter((p) => set.has(p))
    .map((p) => PLATFORM_LABELS[p])
    .join('·');
}

/** The cross-platform unit caveat (design doc §6), shared by all analytics notes. */
export function crossPlatformNote(platforms: Iterable<Platform>, what: string): string {
  return (
    `${what}에 여러 플랫폼(${platformListLabel(platforms)})이 섞여 있습니다. 플랫폼마다 조회수 정의가 달라 ` +
    `(예: X는 게시물 노출 횟수, YouTube Shorts는 2025년 3월 집계 방식 변경) 같은 단위로 비교·합산할 근거가 부족합니다.`
  );
}

/* ------------------------------------------------------------------------------------------
 * queryVideos
 * ---------------------------------------------------------------------------------------- */

/** The metric a sort key ranks by; `percentile` ranks by the date mode's primary metric (see percentileBaseKey). */
function sortMetricOf(key: SortKey, m: VideoMetrics, v: Video, mode: DateMode): MetricValue {
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
    case 'published_at':
      return { value: v.publishedAt, status: 'exact', asOf: v.publishedAt, note: null };
    case 'percentile':
      return sortMetricOf(percentileBaseKey(mode), m, v, mode);
    default: {
      const never: never = key;
      throw new RangeError(`Unknown sort key: ${String(never)}`);
    }
  }
}

/**
 * Metric used for the in-platform percentile when sorting by 'percentile':
 * upload -> views_total (cumulative as of the window end), activity -> views_period (increase in window),
 * age -> views_at_age.
 */
export function percentileBaseKey(mode: DateMode): Exclude<SortKey, 'percentile'> {
  return mode === 'upload' ? 'views_total' : mode === 'activity' ? 'views_period' : 'views_at_age';
}

/** Below this many rankable videos on a platform the percentile carries note 'few_platform_peers'. */
export const PERCENTILE_MIN_PEERS = 5;

const MODES: readonly DateMode[] = ['upload', 'activity', 'age'];

function isAgeDays(x: unknown): x is AgeDays {
  return (AGE_DAYS as readonly number[]).includes(x as number);
}

/**
 * - Filters: q (case-insensitive match on title/tags/topics/account name; Korean substring OK),
 *   platforms, categories (incl. descendants), topics, languages, countries, formats, accountIds,
 *   creatorIds (via creatorOfAccount), sponsored, minViews (latest views).
 * - upload mode: keep videos with publishedAt in window. activity mode: videos published before window end.
 *   age mode: videos that reached ageDays (others excluded and counted in notes); optional range filters publishedAt.
 * - Sort by q.sort using rankValue; unrankable values go last. Stable tie-break: views_total desc, id asc.
 * - percentile: per platform within the filtered set, on the sort metric.
 * - notes: Korean sentences explaining date semantics, incomplete window, lower_bound counts, platform unit caveat.
 *
 * Details
 * - `now` defaults to dataset.generatedAt. The dataset is read as known at `now` (see indexAsOf).
 * - Throws RangeError for a missing range (upload/activity), a missing/invalid ageDays (age), an unknown sort
 *   key or date mode, malformed dates or an unknown time zone.
 * - minViews compares the displayed viewsTotal (as of min(window end, now)); an unknown value is excluded,
 *   a lower bound passes only when the bound itself reaches minViews.
 * - sortDir only flips the primary order; unrankable rows stay last and the tie-break stays
 *   views_total desc, id asc.
 * - `limit` undefined = all rows; `total` is the filtered count before pagination.
 * - 'percentile' sorting ranks by the in-platform percentile of the mode's primary metric (percentileBaseKey);
 *   for every other key the percentile is that of the sort metric. Mid-rank definition (see percentileRanks).
 */
export function queryVideos(index: DatasetIndex, q: VideoQuery): QueryResult {
  const mode = q.dateMode;
  if (!MODES.includes(mode)) throw new RangeError(`Unknown dateMode: ${String(mode)}`);
  if (!SORT_KEYS.includes(q.sort)) throw new RangeError(`Unknown sort key: ${String(q.sort)}`);
  const tz = q.tz;
  const now = resolveNow(index, q.now);
  const window =
    q.rollingHours !== undefined && q.rollingHours !== null
      ? rollingWindow(q.rollingHours, now, tz)
      : q.range
        ? resolveWindow(q.range, tz, now)
        : null;
  if ((mode === 'upload' || mode === 'activity') && !window) {
    throw new RangeError(`queryVideos: dateMode '${mode}' requires a date range`);
  }
  if (mode === 'age' && !isAgeDays(q.ageDays)) {
    throw new RangeError(`queryVideos: dateMode 'age' requires ageDays in ${AGE_DAYS.join('/')}, got ${String(q.ageDays)}`);
  }
  const ageDays: AgeDays | null = isAgeDays(q.ageDays) ? q.ageDays : null;
  const idx = indexAsOf(index, now);
  const matches = compileVideoFilter(idx, q);
  const ctx: MetricContext = { mode, window, ageDays, now, index: idx };
  const minViews = isFiniteNumber(q.minViews) && q.minViews > 0 ? q.minViews : null;

  // 1. Filter (cheap predicates first) and compute each surviving video's metrics exactly once.
  const rows: VideoRow[] = [];
  let notReached = 0;
  for (const v of idx.dataset.videos) {
    if (v.publishedAt > now) continue; // not published yet at `now` (e.g. a scheduled premiere)
    if (!matches(v)) continue;
    if (mode === 'upload') {
      if (!(v.publishedAt >= window!.startMs && v.publishedAt < window!.endMs)) continue;
    } else if (mode === 'activity') {
      if (!(v.publishedAt < window!.endMs)) continue;
    } else {
      if (window && !(v.publishedAt >= window.startMs && v.publishedAt < window.endMs)) continue;
      if (v.publishedAt + (ageDays as number) * DAY > now) {
        notReached++;
        continue;
      }
    }
    const metrics = computeVideoMetrics(v, ctx);
    if (minViews !== null) {
      const tv = rankValue(metrics.viewsTotal);
      if (tv === null || tv < minViews) continue;
    }
    rows.push({ video: v, account: idx.accountsById.get(v.accountId) ?? null, metrics });
  }

  // 2. Per-platform percentile of the sort metric (base metric for 'percentile' sorting).
  const pctKey: Exclude<SortKey, 'percentile'> = q.sort === 'percentile' ? percentileBaseKey(mode) : q.sort;
  const base = rows.map((r) => sortMetricOf(pctKey, r.metrics, r.video, mode));
  const byPlatform = new Map<Platform, number[]>();
  base.forEach((m, i) => {
    if (rankValue(m) === null) return;
    const list = byPlatform.get(rows[i].video.platform);
    if (list) list.push(i);
    else byPlatform.set(rows[i].video.platform, [i]);
  });
  rows.forEach((r, i) => {
    if (rankValue(base[i]) === null) r.metrics.percentile = { value: null, status: 'unavailable', asOf: null, note: 'sort_metric_unavailable' };
  });
  for (const members of byPlatform.values()) {
    const pct = percentileRanks(members.map((i) => rankValue(base[i]) as number));
    members.forEach((i, k) => {
      const m = base[i];
      const status: MetricStatus = m.status === 'lower_bound' ? 'lower_bound' : m.status === 'exact' ? 'exact' : m.status === 'source_reported' ? 'source_reported' : 'interpolated';
      rows[i].metrics.percentile = {
        value: pct[k],
        status,
        asOf: m.asOf,
        note: members.length < PERCENTILE_MIN_PEERS ? 'few_platform_peers' : null,
      };
    });
  }

  // 3. Sort: primary key (unrankable last), then views_total desc, then id asc.
  const n = rows.length;
  const primary = new Array<number | null>(n);
  const tie = new Array<number | null>(n);
  for (let i = 0; i < n; i++) {
    const r = rows[i];
    primary[i] = rankValue(q.sort === 'percentile' ? r.metrics.percentile : base[i]);
    tie[i] = rankValue(r.metrics.viewsTotal);
  }
  const dir = q.sortDir === 'asc' ? 1 : -1;
  const order = rows.map((_, i) => i);
  order.sort((a, b) => {
    const pa = primary[a];
    const pb = primary[b];
    if (pa !== pb) {
      if (pa === null) return 1;
      if (pb === null) return -1;
      return dir * (pa - pb);
    }
    const ta = tie[a];
    const tb = tie[b];
    if (ta !== tb) {
      if (ta === null) return 1;
      if (tb === null) return -1;
      return tb - ta;
    }
    return compareIds(rows[a].video.id, rows[b].video.id);
  });
  const sorted = order.map((i) => rows[i]);

  // 4. Pagination.
  const offset = isFiniteNumber(q.offset) && q.offset > 0 ? Math.floor(q.offset) : 0;
  const limit = isFiniteNumber(q.limit) ? Math.max(0, Math.floor(q.limit)) : Infinity;
  const page = sorted.slice(offset, limit === Infinity ? undefined : offset + limit);

  // 5. Notes.
  const notes = queryNotes({
    mode,
    window,
    ageDays,
    tz,
    now,
    sort: q.sort,
    statusMetrics: base,
    platforms: new Set(rows.map((r) => r.video.platform)),
    notReached,
    truncated: idx !== index,
    pctKey,
  });

  return { rows: page, total: n, window, now, notes };
}

interface NotesInput {
  mode: DateMode;
  window: UtcWindow | null;
  ageDays: AgeDays | null;
  tz: string;
  now: number;
  sort: SortKey;
  statusMetrics: MetricValue[];
  platforms: Set<Platform>;
  notReached: number;
  truncated: boolean;
  pctKey: SortKey;
}

function sortLabel(key: SortKey, mode: DateMode, ageDays: AgeDays | null): string {
  if (key === 'views_period') {
    if (mode === 'upload') return '게시 후 조회수';
    if (mode === 'activity') return '기간 조회 증가량';
    return ageDays ? `V${ageDays} 조회수` : SORT_KEY_LABELS_KO[key];
  }
  if (key === 'views_at_age' && ageDays) return `V${ageDays} 조회수(게시 후 ${ageDays}일)`;
  return SORT_KEY_LABELS_KO[key];
}

function queryNotes(x: NotesInput): string[] {
  const notes: string[] = [];
  const { window: w, tz } = x;

  // Date semantics (design doc §5): always say which one is active and what it means.
  if (x.mode === 'upload' && w) {
    notes.push(
      `업로드 기간 기준: ${dateRangeLabel(w)}에 게시된 영상만 포함합니다. 누적 조회수 등은 ${instantLabel(Math.min(w.endMs, x.now), tz)} 기준 값입니다. ` +
        `이 기간 전에 올라와 기간 중 다시 인기를 얻은 영상은 제외되므로, 그런 영상은 '조회 발생 기간' 기준으로 확인하세요.`,
    );
  } else if (x.mode === 'activity' && w) {
    notes.push(
      `조회 발생 기간 기준: 게시일과 관계없이 ${dateRangeLabel(w)} 동안 늘어난 조회수·반응으로 비교합니다. ` +
        `기간 시작·종료 시점의 관측값(경계 관측이 없으면 원천이 직접 집계한 기간 지표)으로 계산합니다.`,
    );
  } else if (x.mode === 'age' && x.ageDays) {
    notes.push(
      `게시 후 경과시간 기준: 각 영상의 게시 후 ${x.ageDays}일 시점(V${x.ageDays}) 값으로 비교합니다. ` +
        `오래된 영상이 누적값에서 유리한 편향을 줄이기 위한 비교입니다.` +
        (w
          ? ` 게시일이 ${dateRangeLabel(w)}인 영상만 포함하며, 누적 조회수 등 다른 값은 ${instantLabel(Math.min(w.endMs, x.now), tz)} 기준입니다.`
          : ''),
    );
  }
  if (w && w.incomplete) {
    notes.push(
      `선택한 기간이 아직 끝나지 않았습니다(데이터 기준 ${instantLabel(x.now, tz)}). 기간 종료 전까지의 부분 집계이므로 완료된 기간과 직접 비교하지 마세요.`,
    );
  }
  if (x.truncated) {
    notes.push(`기준 시각 ${instantLabel(x.now, tz)} 이후에 수집된 관측값·영상은 제외하고 계산했습니다. 같은 기준 시각으로 다시 만들면 같은 결과가 나옵니다.`);
  }
  if (x.notReached > 0 && x.ageDays) {
    notes.push(`게시 후 ${x.ageDays}일이 아직 지나지 않은 영상 ${x.notReached.toLocaleString('ko-KR')}개는 비교에서 제외했습니다.`);
  }

  // Provenance of the ranked values.
  const counts: Partial<Record<MetricStatus, number>> = {};
  for (const m of x.statusMetrics) counts[m.status] = (counts[m.status] ?? 0) + 1;
  const total = x.statusMetrics.length;
  if (total > 0 && x.sort !== 'published_at') {
    const label = x.sort === 'percentile' ? `${SORT_KEY_LABELS_KO.percentile}(${sortLabel(x.pctKey, x.mode, x.ageDays)} 기준)` : sortLabel(x.sort, x.mode, x.ageDays);
    const parts: string[] = [];
    const add = (s: MetricStatus, text: string) => {
      const c = counts[s] ?? 0;
      if (c > 0) parts.push(`${text} ${c.toLocaleString('ko-KR')}개`);
    };
    add('lower_bound', '하한값(≥, 실제는 더 클 수 있음)');
    add('interpolated', '보간값(≈)');
    add('source_reported', '원천 보고값');
    add('unavailable', '계산 불가(—)');
    add('decrease_flagged', '감소 감지(⚠, 삭제·정정·수집 오류 가능)');
    if (parts.length) {
      notes.push(`정렬 기준 '${label}' 값 ${total.toLocaleString('ko-KR')}개 중 ${parts.join(', ')}입니다.`);
      const unranked = (counts.unavailable ?? 0) + (counts.decrease_flagged ?? 0);
      if (unranked > 0) notes.push(`계산 불가·감소 감지 값 ${unranked.toLocaleString('ko-KR')}개는 순위에 넣지 않고 목록 끝에 두었습니다(빈 값은 0으로 계산하지 않음).`);
    } else {
      notes.push(`정렬 기준 '${label}' 값 ${total.toLocaleString('ko-KR')}개가 모두 관측값으로 정확히 계산되었습니다.`);
    }
  }

  // Metric definitions for the less obvious sort keys.
  if (x.sort === 'engagement_rate') {
    notes.push('참여율 = (원천이 제공한 좋아요·댓글·공유의 합) / 조회수입니다. 제공되지 않은 항목은 0으로 계산하지 않고 빼며, 반응 지표가 하나도 없는 영상은 순위에서 제외합니다.');
  } else if (x.sort === 'outperformance') {
    notes.push('계정 평소 대비 성과 = 이 영상의 게시 후 경과시간 조회수 / 같은 계정 다른 영상(3개 이상)의 같은 경과시간 조회수 중앙값입니다.');
  } else if (x.sort === 'growth_vs_prev') {
    notes.push('성장률 = 기간 증가량 / 직전 같은 길이 기간 증가량 - 1입니다. 직전 기간 값이 0이거나 없으면 계산하지 않습니다.');
  } else if (x.sort === 'velocity') {
    notes.push('증가 속도 = 기간 종료(또는 데이터 기준 시각) 전 약 24시간 동안의 시간당 조회 증가량입니다.');
  }

  if (x.platforms.size > 1) {
    notes.push(`${crossPlatformNote(x.platforms, '결과')} 백분위는 같은 플랫폼 안에서 계산되므로 '플랫폼 내 백분위' 정렬을 함께 보세요.`);
  }
  return notes;
}
