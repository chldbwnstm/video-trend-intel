/**
 * Creator Intelligence page logic (pure, tested in logic.test.ts): portfolio lookups, follower totals with
 * provenance, compare-key handling, leader detection, timeline -> chart series, category mix, upload cadence,
 * sponsored videos, posting-heatmap helpers, and the per-page analytics bundles run through useAnalysis.
 *
 * All numbers describe OUR tracked videos of a portfolio (추적 영상 기준), read as known at the data `now`.
 */
import {
  addDays,
  creatorPortfolios,
  indexAsOf,
  latestFollowers,
  localDateOf,
  localDateStartUtc,
  medianOf,
  PLATFORMS,
  postingHeatmap,
  resolveAnalysisWindow,
  sumIncrements,
  summarizePortfolio,
  topLevelOf,
  weekdayHourInTz,
  creatorTimeline,
} from '@vti/core';
import type {
  Account,
  CreatorSummary,
  DatasetIndex,
  LocalDateRange,
  MetricStatus,
  MetricValue,
  Platform,
  Portfolio,
  UtcWindow,
  Video,
} from '@vti/core';
import type { GrowthSeries } from '../../components/index.ts';
import { platformColor, platformLabel } from '../../lib/platform.ts';
import { textMatchesSafe } from '../../lib/search.ts';
import { enumCodec, hrefWith } from '../../lib/urlState.ts';
import type { ParamPatch } from '../../lib/urlState.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/* ------------------------------------------------------------------------------------------ sorts */

export const CREATOR_SORTS = ['views_period', 'followers', 'uploads', 'engagement', 'median_v7', 'followers_growth'] as const;
export type CreatorSort = (typeof CREATOR_SORTS)[number];

export const CREATOR_SORT_LABELS: Record<CreatorSort, string> = {
  views_period: '기간 조회 증가',
  followers: '팔로워',
  uploads: '기간 업로드',
  engagement: '참여율',
  median_v7: 'V7 중앙값',
  followers_growth: '팔로워 증가',
};

export const creatorSortCodec = enumCodec<CreatorSort>(CREATOR_SORTS);

/** Sorts whose values come from observations inside the window (unknown for a window before the first one). */
export const WINDOW_OBSERVATION_SORTS: ReadonlySet<CreatorSort> = new Set<CreatorSort>(['views_period', 'followers_growth', 'engagement']);

/**
 * Sort actually applied: for a window that ends before the first observation, the observation-based sorts
 * would rank rows that are all 0 / ≥ 0 / —, so the list falls back to uploads in the window (known from the
 * publish dates).
 */
export function effectiveCreatorSort(sort: CreatorSort, beforeCollection: boolean): CreatorSort {
  return beforeCollection && WINDOW_OBSERVATION_SORTS.has(sort) ? 'uploads' : sort;
}

/* ------------------------------------------------------------------------------------------ collection window */

/**
 * True when nothing inside the window can have been observed: the window (clipped to `now`) ends at or before
 * the first observation of the dataset, or the dataset has no observation at all. View / follower increases of
 * such a window are unknown (≥ 0 / —), not 0.
 */
export function windowBeforeCollection(w: Pick<UtcWindow, 'endMs'>, firstObservationAt: number | null, now: number): boolean {
  if (firstObservationAt === null) return true;
  return Math.min(w.endMs, now) <= firstObservationAt;
}

/* ------------------------------------------------------------------------------------------ links */

/** Router path of a creator/account detail page. `:` and `@` stay readable (valid in a path segment). */
export function creatorHref(key: string, params: ParamPatch = {}): string {
  const seg = encodeURIComponent(key).replace(/%3A/gi, ':').replace(/%40/g, '@');
  return hrefWith(`/creators/${seg}`, params);
}

export const MAX_COMPARE = 4;

/** Trimmed, de-duplicated, non-empty keys, at most `max` (first ones win). */
export function normalizeCompareKeys(keys: readonly string[], max = MAX_COMPARE): string[] {
  const out: string[] = [];
  for (const k of keys) {
    const s = k.trim();
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/** Add `key` (when there is room) or remove it (when present). */
export function toggleCompareKey(keys: readonly string[], key: string, max = MAX_COMPARE): string[] {
  const cur = normalizeCompareKeys(keys, max);
  if (cur.includes(key)) return cur.filter((k) => k !== key);
  if (cur.length >= max) return cur;
  return [...cur, key];
}

/**
 * Video search (/videos) scoped to a portfolio's tracked videos: a linked creator by its creator id
 * (`creators=`), a single account by its account id (`accounts=`). `params` adds range / mode / sort / cats / v.
 */
export function portfolioVideosHref(p: Pick<Portfolio, 'key' | 'kind' | 'accountIds'>, params: ParamPatch = {}): string {
  const scope: ParamPatch = p.kind === 'creator' ? { creators: [p.key] } : { accounts: [...p.accountIds] };
  return hrefWith('/videos', { ...scope, ...params });
}

/** `/compare?keys=youtube:UC1,creator-x&range=…` (`:` and `@` left readable; both are valid in a query). */
export function compareHref(keys: readonly string[], params: ParamPatch = {}): string {
  return hrefWith('/compare', { keys: normalizeCompareKeys(keys), ...params }).replace(/%3A/gi, ':').replace(/%40/g, '@');
}

/**
 * Categorical series slot each platform color uses (index.css: `--platform-<p>: var(--series-N)`). Keep in
 * sync with index.css.
 */
const PLATFORM_SERIES: Record<Platform, number> = {
  youtube: 1,
  dailymotion: 2,
  peertube: 3,
  niconico: 4,
  tiktok: 5,
  instagram: 6,
  x: 7,
  twitch: 8,
};

/** Order in which compare slots take series colors (well separated first). */
const COMPARE_SERIES_ORDER = [7, 5, 8, 6, 1, 2, 3, 4] as const;

/**
 * Colors of the compare slots (MAX_COMPARE of them). Platform badges share the categorical palette, so slots
 * skip the series used by `platformsInUse` (the platforms shown on the page) while enough others remain; with
 * more platforms than free colors the rest is reused (the slot number stays as the non-color cue).
 */
export function comparePalette(platformsInUse: readonly Platform[] = []): string[] {
  const taken = new Set(platformsInUse.map((p) => PLATFORM_SERIES[p]).filter((n) => n !== undefined));
  const order = [...COMPARE_SERIES_ORDER.filter((n) => !taken.has(n)), ...COMPARE_SERIES_ORDER.filter((n) => taken.has(n))];
  return order.slice(0, MAX_COMPARE).map((n) => `var(--series-${n})`);
}

/** Series color of the i-th compared creator (color follows the entity's slot, never its rank). */
export function compareColor(i: number, palette: readonly string[] = comparePalette()): string {
  return palette[((i % palette.length) + palette.length) % palette.length];
}

/* ------------------------------------------------------------------------------------------ portfolios */

/** Videos of a portfolio published by `now` (all platforms), newest first. */
export function portfolioVideos(index: DatasetIndex, p: Portfolio, now: number): Video[] {
  const out: Video[] = [];
  for (const id of p.accountIds) for (const v of index.videosByAccount.get(id) ?? []) if (v.publishedAt <= now) out.push(v);
  out.sort((a, b) => b.publishedAt - a.publishedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

/** Portfolio by key as known at `now` (null for an unknown key). */
export function findPortfolio(index: DatasetIndex, key: string, now: number): Portfolio | null {
  if (!key) return null;
  return creatorPortfolios(indexAsOf(index, now)).get(key) ?? null;
}

export type LinkStatus = 'verified' | 'suggested' | null;

/** Link status of a portfolio: 'verified' (curated) / 'suggested' (auto name match) for creators, null for single accounts. */
export function linkStatusOf(index: DatasetIndex, key: string): LinkStatus {
  return index.creatorsById.get(key)?.linkStatus ?? null;
}

export const LINK_STATUS_LABELS: Record<'verified' | 'suggested', string> = {
  verified: '검증됨',
  suggested: '자동 추정',
};

export const LINK_STATUS_HINTS: Record<'verified' | 'suggested', string> = {
  verified: '운영자가 확인한 계정 묶음(수동 매핑).',
  suggested: '이름이 같아 자동으로 묶은 계정. 같은 크리에이터인지 확인되지 않음.',
};

export interface PortfolioOption {
  key: string;
  name: string;
  kind: 'creator' | 'account';
  platforms: Platform[];
  accounts: number;
  videos: number;
  linkStatus: LinkStatus;
  handle: string | null;
}

/** Every portfolio as a picker option: linked creators first, then by tracked video count, then name. */
export function portfolioOptions(index: DatasetIndex, now: number): PortfolioOption[] {
  const out: PortfolioOption[] = [];
  const idx = indexAsOf(index, now);
  for (const p of creatorPortfolios(idx).values()) {
    const set = new Set<Platform>();
    let videos = 0;
    for (const a of p.accounts) set.add(a.platform);
    for (const id of p.accountIds) {
      for (const v of idx.videosByAccount.get(id) ?? []) {
        if (v.publishedAt > now) continue;
        videos++;
        set.add(v.platform);
      }
    }
    out.push({
      key: p.key,
      name: p.name,
      kind: p.kind,
      platforms: PLATFORMS.filter((x) => set.has(x)),
      accounts: p.accountIds.length,
      videos,
      linkStatus: linkStatusOf(idx, p.key),
      handle: p.accounts.find((a) => a.handle)?.handle ?? null,
    });
  }
  out.sort(
    (a, b) =>
      (a.kind === 'creator' ? 0 : 1) - (b.kind === 'creator' ? 0 : 1) ||
      b.platforms.length - a.platforms.length ||
      b.videos - a.videos ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  return out;
}

/** Options matching `q` (name, handle, key), in option order, at most `limit`. */
export function searchPortfolioOptions(options: readonly PortfolioOption[], q: string, limit = 30): PortfolioOption[] {
  const needle = q.trim();
  const out: PortfolioOption[] = [];
  for (const o of options) {
    if (out.length >= limit) break;
    if (!needle || textMatchesSafe(o.name, needle) || (o.handle && textMatchesSafe(o.handle, needle)) || textMatchesSafe(o.key, needle)) out.push(o);
  }
  return out;
}

/* ------------------------------------------------------------------------------------------ followers */

export interface FollowersMetric extends MetricValue {
  /** Accounts whose source provides a follower count. */
  providedBy: number;
  /** Accounts considered. */
  accounts: number;
}

/**
 * Sum of the accounts' latest follower counts (at or before `now`) with provenance:
 * every account provides one -> 'exact'; only some -> 'lower_bound' (the others are unknown, not 0);
 * none -> 'unavailable' ('counter_not_provided').
 */
export function followersMetric(accounts: readonly Account[], now: number): FollowersMetric {
  let sum = 0;
  let provided = 0;
  let asOf: number | null = null;
  for (const a of accounts) {
    const f = latestFollowers(a, now);
    if (!f) continue;
    provided++;
    sum += f.value;
    if (asOf === null || f.t > asOf) asOf = f.t;
  }
  if (!provided) return { value: null, status: 'unavailable', asOf: null, note: 'counter_not_provided', providedBy: 0, accounts: accounts.length };
  const all = provided === accounts.length;
  return { value: sum, status: all ? 'exact' : 'lower_bound', asOf, note: all ? null : 'partial_accounts', providedBy: provided, accounts: accounts.length };
}

/** Platforms (of `platforms`) whose accounts in the dataset never carry follower counts. */
export function platformsWithoutFollowers(accounts: readonly Account[], platforms: readonly Platform[]): Platform[] {
  const has = new Set<Platform>();
  for (const a of accounts) if ((a.followers ?? []).length) has.add(a.platform);
  return platforms.filter((p) => !has.has(p));
}

/** Tooltip line explaining missing follower counts ('원천 미제공'). */
export function followersExtra(m: FollowersMetric, missingPlatforms: readonly Platform[]): string | undefined {
  const names = missingPlatforms.map(platformLabel).join('·');
  if (m.status === 'unavailable') return names ? `원천 미제공: ${names} 수집 경로는 팔로워 수를 주지 않음.` : '원천 미제공.';
  if (m.status === 'lower_bound') return `계정 ${m.accounts}개 중 ${m.providedBy}개만 팔로워 수 제공${names ? ` (원천 미제공: ${names})` : ''}. 실제 합계는 더 큼.`;
  return m.accounts > 1 ? `계정 ${m.accounts}개의 최신 팔로워 수 합계.` : undefined;
}

/* ------------------------------------------------------------------------------------------ leaders */

const FIRM: ReadonlySet<MetricStatus> = new Set<MetricStatus>(['exact', 'interpolated', 'source_reported']);

export interface Leaders {
  /** Indices holding the highest value (ties share the lead). Empty when nothing can be compared. */
  indices: number[];
  /**
   * False when another entity's value is a lower bound or unknown (its true value could exceed the leader),
   * so the lead is provisional ("잠정").
   */
  firm: boolean;
}

function rankable(m: Pick<MetricValue, 'value' | 'status'> | null | undefined): number | null {
  if (!m) return null;
  if (m.status === 'unavailable' || m.status === 'decrease_flagged') return null;
  return typeof m.value === 'number' && Number.isFinite(m.value) ? m.value : null;
}

const noLeader = (): Leaders => ({ indices: [], firm: false });

/**
 * Leader(s) of one metric across compared entities (needs >= 2 entities).
 * No leader when nothing leads: the best value is 0 or less (e.g. 참여율 0% everywhere, no uploads), or every
 * comparable value is the same (a tie of all is not a lead).
 */
export function metricLeaders(values: readonly (Pick<MetricValue, 'value' | 'status'> | null | undefined)[]): Leaders {
  if (values.length < 2) return noLeader();
  const nums = values.map(rankable);
  let best = -Infinity;
  let comparable = 0;
  for (const v of nums) {
    if (v === null) continue;
    comparable++;
    if (v > best) best = v;
  }
  if (best === -Infinity || best <= 0) return noLeader();
  const indices: number[] = [];
  let firm = true;
  for (let i = 0; i < values.length; i++) {
    const m = values[i];
    if (nums[i] === best) indices.push(i);
    else if (!m || !FIRM.has(m.status)) firm = false;
  }
  if (comparable >= 2 && indices.length === comparable) return noLeader();
  // Lower-bound ties cannot be ordered either.
  if (indices.length > 1 && indices.some((i) => !FIRM.has(values[i]!.status))) firm = false;
  return { indices, firm };
}

/** Leader(s) of plain counts of our own records (always firm). */
export function countLeaders(values: readonly (number | null)[]): Leaders {
  return metricLeaders(values.map((v) => (v === null ? null : { value: v, status: 'exact' as const })));
}

/* ------------------------------------------------------------------------------------------ status breakdown */

export type StatusCounts = Record<MetricStatus, number>;

export function statusCounts(values: readonly Pick<MetricValue, 'status'>[]): StatusCounts {
  const c: StatusCounts = { exact: 0, interpolated: 0, lower_bound: 0, source_reported: 0, unavailable: 0, decrease_flagged: 0 };
  for (const v of values) c[v.status]++;
  return c;
}

/** Share (0..1) of values that are not a direct measurement (lower bound / unavailable). */
export function partialShare(c: StatusCounts): number {
  const total = Object.values(c).reduce((a, b) => a + b, 0);
  return total ? (c.lower_bound + c.unavailable) / total : 0;
}

/* ------------------------------------------------------------------------------------------ timelines */

export type TimelineRow = { date: string; byPlatform: Partial<Record<Platform, MetricValue>> };

export function timelinePlatforms(rows: readonly TimelineRow[]): Platform[] {
  const set = new Set<Platform>();
  for (const r of rows) for (const p of Object.keys(r.byPlatform) as Platform[]) set.add(p);
  return PLATFORMS.filter((p) => set.has(p));
}

const NO_VIDEOS = 'no_tracked_videos';
const MEASURED: ReadonlySet<MetricStatus> = new Set<MetricStatus>(['exact', 'interpolated', 'source_reported']);

/**
 * Presentation rules for creatorTimeline rows:
 * - a platform-day before any tracked video existed ('no_tracked_videos', reported by core as 0) becomes
 *   "no data" (null): with RSS's latest-15 window the channel surely had older videos we do not track, so 0
 *   would read as "no views that day";
 * - the local day containing `now` is still running: its measured value becomes a lower bound
 *   ('window_incomplete') because the full day can only be larger.
 */
export function normalizeTimeline(rows: readonly TimelineRow[], now: number, tz: string): TimelineRow[] {
  let today: string | null = null;
  try {
    today = localDateOf(now, tz);
  } catch {
    today = null;
  }
  return rows.map((r) => {
    const byPlatform: Partial<Record<Platform, MetricValue>> = {};
    for (const [p, m] of Object.entries(r.byPlatform) as [Platform, MetricValue][]) {
      if (m.note === NO_VIDEOS) byPlatform[p] = { value: null, status: 'unavailable', asOf: null, note: NO_VIDEOS };
      else if (r.date === today && MEASURED.has(m.status)) byPlatform[p] = { ...m, status: 'lower_bound', note: 'window_incomplete' };
      else byPlatform[p] = m;
    }
    return { date: r.date, byPlatform };
  });
}

function pointOf(m: MetricValue | undefined): { value: number | null; status: MetricStatus } {
  if (!m) return { value: null, status: 'unavailable' };
  return { value: m.status === 'unavailable' ? null : m.value, status: m.status };
}

/** One bar series per platform (x = local date), colored by platform identity. */
export function platformTimelineSeries(rows: readonly TimelineRow[], platforms?: readonly Platform[]): GrowthSeries[] {
  const list = platforms ?? timelinePlatforms(rows);
  return list.map((p) => ({
    id: p,
    label: platformLabel(p),
    color: platformColor(p),
    points: rows.map((r) => ({ x: r.date, ...pointOf(r.byPlatform[p]) })),
  }));
}

/**
 * Daily totals across `platforms` (null = all) with sumIncrements semantics: unmeasurable platform-days make
 * the day a lower bound; a day with nothing measurable is unavailable. Platform-days without any tracked video
 * yet are left out (not unknown, not zero); a day where no platform had one is unavailable.
 */
export function combinedTimeline(rows: readonly TimelineRow[], platforms: readonly Platform[] | null): { date: string; metric: MetricValue }[] {
  const allow = platforms && platforms.length ? new Set(platforms) : null;
  return rows.map((r) => {
    const parts: MetricValue[] = [];
    for (const [p, m] of Object.entries(r.byPlatform) as [Platform, MetricValue][]) if ((!allow || allow.has(p)) && m.note !== NO_VIDEOS) parts.push(m);
    if (!parts.length) return { date: r.date, metric: { value: null, status: 'unavailable', asOf: null, note: NO_VIDEOS } };
    const s = sumIncrements(parts);
    return { date: r.date, metric: { value: s.value, status: s.status, asOf: s.asOf, note: s.note } };
  });
}

/** Status counts of the platform-days that could have been measured (not future days, not days before any video). */
export function timelineStatus(rows: readonly TimelineRow[]): StatusCounts {
  const all: MetricValue[] = [];
  for (const r of rows) for (const m of Object.values(r.byPlatform)) if (m && m.note !== 'window_not_started' && m.note !== NO_VIDEOS) all.push(m);
  return statusCounts(all);
}

/* ------------------------------------------------------------------------------------------ category mix */

export interface CategoryMix {
  rows: { id: string; count: number }[];
  videos: number;
  uncategorized: number;
}

/** Top-level categories by number of videos (a video in several categories counts once in each). */
export function categoryMix(videos: readonly Video[]): CategoryMix {
  const counts = new Map<string, number>();
  let uncategorized = 0;
  for (const v of videos) {
    const seen = new Set<string>();
    for (const c of v.categories ?? []) seen.add(topLevelOf(c.id) ?? c.id);
    if (!seen.size) uncategorized++;
    for (const id of seen) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const rows = [...counts.entries()].map(([id, count]) => ({ id, count })).sort((a, b) => b.count - a.count || (a.id < b.id ? -1 : 1));
  return { rows, videos: videos.length, uncategorized };
}

/* ------------------------------------------------------------------------------------------ cadence */

export interface PlatformCadence {
  platform: Platform;
  videos: number;
  firstPublished: number | null;
  lastPublished: number | null;
  /** Median gap between consecutive tracked uploads on this platform (hours); null with < 2 videos. */
  medianIntervalHours: number | null;
}

export interface UploadCadence {
  /** Weekly upload counts (Mon-start local weeks, oldest first); null = before our earliest tracked upload. */
  weeks: { start: string; count: number | null; current: boolean }[];
  uploads7d: number;
  uploads30d: number;
  firstPublished: number | null;
  lastPublished: number | null;
  perPlatform: PlatformCadence[];
}

function medianGapHours(times: number[]): number | null {
  if (times.length < 2) return null;
  const s = [...times].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < s.length; i++) gaps.push((s[i] - s[i - 1]) / HOUR);
  return medianOf(gaps);
}

/** Upload rhythm of a set of tracked videos: weekly counts for the last `weeks` local weeks and gaps per platform. */
export function uploadCadence(videos: readonly Video[], now: number, tz: string, weeks = 12): UploadCadence {
  const published = videos.filter((v) => v.publishedAt <= now);
  let first: number | null = null;
  let last: number | null = null;
  for (const v of published) {
    if (first === null || v.publishedAt < first) first = v.publishedAt;
    if (last === null || v.publishedAt > last) last = v.publishedAt;
  }
  const today = localDateOf(now, tz);
  const monday = addDays(today, -weekdayHourInTz(now, tz).weekday);
  const out: UploadCadence['weeks'] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const start = addDays(monday, -7 * i);
    const s = localDateStartUtc(start, tz);
    const e = localDateStartUtc(addDays(start, 7), tz);
    if (first === null || e <= first) {
      out.push({ start, count: null, current: i === 0 });
      continue;
    }
    let n = 0;
    for (const v of published) if (v.publishedAt >= s && v.publishedAt < e) n++;
    out.push({ start, count: n, current: i === 0 });
  }
  const byPlatform = new Map<Platform, number[]>();
  for (const v of published) {
    const list = byPlatform.get(v.platform);
    if (list) list.push(v.publishedAt);
    else byPlatform.set(v.platform, [v.publishedAt]);
  }
  const perPlatform: PlatformCadence[] = PLATFORMS.filter((p) => byPlatform.has(p)).map((p) => {
    const t = byPlatform.get(p)!;
    return {
      platform: p,
      videos: t.length,
      firstPublished: Math.min(...t),
      lastPublished: Math.max(...t),
      medianIntervalHours: medianGapHours(t),
    };
  });
  return {
    weeks: out,
    uploads7d: published.filter((v) => v.publishedAt > now - 7 * DAY).length,
    uploads30d: published.filter((v) => v.publishedAt > now - 30 * DAY).length,
    firstPublished: first,
    lastPublished: last,
    perPlatform,
  };
}

/** `36시간` / `2.5일` for an interval in hours. */
export function formatInterval(hours: number | null): string {
  if (hours === null || !Number.isFinite(hours)) return '—';
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}분`;
  if (hours < 48) return `${Math.round(hours)}시간`;
  const days = hours / 24;
  return `${days >= 10 ? Math.round(days) : Math.round(days * 10) / 10}일`;
}

/* ------------------------------------------------------------------------------------------ sponsorship */

/** Videos with a sponsorship signal: disclosed first, then newest first. */
export function sponsoredVideos(videos: readonly Video[]): Video[] {
  return videos
    .filter((v) => v.sponsorship)
    .sort((a, b) => (a.sponsorship!.level === 'disclosed' ? 0 : 1) - (b.sponsorship!.level === 'disclosed' ? 0 : 1) || b.publishedAt - a.publishedAt);
}

/** Detected brands by number of videos (desc, then name). */
export function brandCounts(videos: readonly Video[]): { brand: string; count: number }[] {
  const m = new Map<string, number>();
  for (const v of videos) for (const b of new Set(v.sponsorship?.brands ?? [])) m.set(b, (m.get(b) ?? 0) + 1);
  return [...m.entries()].map(([brand, count]) => ({ brand, count })).sort((a, b) => b.count - a.count || (a.brand < b.brand ? -1 : 1));
}

/* ------------------------------------------------------------------------------------------ heatmap */

export const WEEKDAY_LABELS = ['월', '화', '수', '목', '금', '토', '일'] as const;

export interface HeatSlot {
  weekday: number;
  hour: number;
  count: number;
  medianV7: number | null;
}

/** Non-empty slots (uploads > 0), busiest first (then by weekday/hour). */
export function heatmapSlots(h: { counts: number[][]; medianV7: (number | null)[][] }): HeatSlot[] {
  const out: HeatSlot[] = [];
  for (let d = 0; d < 7; d++) for (let hr = 0; hr < 24; hr++) if (h.counts[d]?.[hr]) out.push({ weekday: d, hour: hr, count: h.counts[d][hr], medianV7: h.medianV7[d]?.[hr] ?? null });
  return out.sort((a, b) => b.count - a.count || a.weekday - b.weekday || a.hour - b.hour);
}

export function matrixMax(m: readonly (readonly (number | null)[])[]): number {
  let max = 0;
  for (const row of m) for (const v of row) if (typeof v === 'number' && Number.isFinite(v) && v > max) max = v;
  return max;
}

/** Sequential level 0..4 (0 = none) for a cell value relative to the matrix max. */
export function heatLevel(value: number | null, max: number): number {
  if (value === null || !Number.isFinite(value) || value <= 0 || max <= 0) return 0;
  return Math.max(1, Math.min(4, Math.ceil((value / max) * 4)));
}

/** Busiest posting slot label: `수 18시`. */
export function slotLabel(s: Pick<HeatSlot, 'weekday' | 'hour'>): string {
  return `${WEEKDAY_LABELS[s.weekday]} ${s.hour}시`;
}

/* ------------------------------------------------------------------------------------------ analytics bundles */

export interface RangeInput {
  range: LocalDateRange;
  rollingHours: number | null;
  tz: string;
  now: number;
}

export interface PlatformBreakdown {
  platform: Platform;
  summary: CreatorSummary;
  followers: FollowersMetric;
}

export interface CreatorDetailData {
  portfolio: Portfolio;
  linkStatus: LinkStatus;
  note: string | null;
  window: UtcWindow;
  summary: CreatorSummary;
  followers: FollowersMetric;
  perPlatform: PlatformBreakdown[];
  videosByAccount: Record<string, number>;
  categoryMix: CategoryMix;
  cadence: UploadCadence;
  sponsored: Video[];
  brands: { brand: string; count: number }[];
  followerSeries: { account: Account; points: { t: number; value: number; src: string }[] }[];
  missingFollowerPlatforms: Platform[];
}

function perPlatformBreakdown(idx: DatasetIndex, p: Portfolio, w: UtcWindow, now: number, platforms: readonly Platform[]): PlatformBreakdown[] {
  return platforms.map((pf) => {
    const s = summarizePortfolio(idx, p, w, now, new Set([pf]));
    return { platform: pf, summary: s, followers: followersMetric(s.accounts, now) };
  });
}

/** Everything the detail page needs besides the timeline, heatmap and top videos (null for an unknown key). */
export function computeCreatorDetail(index: DatasetIndex, input: RangeInput & { key: string }): CreatorDetailData | null {
  const { key, range, rollingHours, tz, now } = input;
  const idx = indexAsOf(index, now);
  const p = creatorPortfolios(idx).get(key);
  if (!p) return null;
  const w = resolveAnalysisWindow(range, tz, now, rollingHours);
  const summary = summarizePortfolio(idx, p, w, now, null);
  const videos = portfolioVideos(idx, p, now);
  const videosByAccount: Record<string, number> = {};
  for (const v of videos) videosByAccount[v.accountId] = (videosByAccount[v.accountId] ?? 0) + 1;
  const followerSeries = p.accounts
    .filter((a) => (a.followers ?? []).some((f) => f.t <= now))
    .map((a) => ({ account: a, points: a.followers.filter((f) => f.t <= now && Number.isFinite(f.value)).sort((x, y) => x.t - y.t) }));
  const sponsored = sponsoredVideos(videos);
  return {
    portfolio: p,
    linkStatus: linkStatusOf(idx, key),
    note: idx.creatorsById.get(key)?.note ?? null,
    window: w,
    summary,
    followers: followersMetric(summary.accounts, now),
    perPlatform: perPlatformBreakdown(idx, p, w, now, summary.platforms),
    videosByAccount,
    categoryMix: categoryMix(videos),
    cadence: uploadCadence(videos, now, tz),
    sponsored,
    brands: brandCounts(sponsored),
    followerSeries,
    missingFollowerPlatforms: platformsWithoutFollowers(idx.dataset.accounts, summary.platforms),
  };
}

export interface CompareEntry {
  key: string;
  found: boolean;
  name: string;
  kind: 'creator' | 'account' | null;
  linkStatus: LinkStatus;
  summary: CreatorSummary | null;
  followers: FollowersMetric | null;
  perPlatform: PlatformBreakdown[];
  /** Daily totals over the compared platforms. */
  daily: { date: string; metric: MetricValue }[];
  /** Busiest posting slot over all tracked uploads (null without uploads). */
  peak: HeatSlot | null;
}

export interface CompareData {
  window: UtcWindow;
  entries: CompareEntry[];
  /** Platforms present in the compared (found) portfolios, canonical order. */
  platforms: Platform[];
  missingFollowerPlatforms: Platform[];
}

/** Side-by-side summaries for up to 4 keys; `platforms` restricts every number to those platforms. */
export function computeComparison(index: DatasetIndex, input: RangeInput & { keys: string[]; platforms: Platform[] }): CompareData {
  const { range, rollingHours, tz, now } = input;
  const idx = indexAsOf(index, now);
  const w = resolveAnalysisWindow(range, tz, now, rollingHours);
  const filter = input.platforms.length ? new Set(input.platforms) : null;
  const portfolios = creatorPortfolios(idx);
  const present = new Set<Platform>();
  const entries: CompareEntry[] = normalizeCompareKeys(input.keys).map((key) => {
    const p = portfolios.get(key);
    if (!p) return { key, found: false, name: key, kind: null, linkStatus: null, summary: null, followers: null, perPlatform: [], daily: [], peak: null };
    const summary = summarizePortfolio(idx, p, w, now, filter);
    for (const pf of summary.platforms) present.add(pf);
    const timeline = creatorTimeline(idx, key, { range, tz, now });
    const heat = postingHeatmap(idx, key, tz, now);
    return {
      key,
      found: true,
      name: p.name,
      kind: p.kind,
      linkStatus: linkStatusOf(idx, key),
      summary,
      followers: followersMetric(summary.accounts, now),
      perPlatform: perPlatformBreakdown(idx, p, w, now, summary.platforms),
      daily: combinedTimeline(normalizeTimeline(timeline, now, tz), filter ? [...filter] : null),
      peak: heatmapSlots(heat)[0] ?? null,
    };
  });
  const platforms = PLATFORMS.filter((p) => present.has(p));
  return { window: w, entries, platforms, missingFollowerPlatforms: platformsWithoutFollowers(idx.dataset.accounts, platforms) };
}

/** Overlaid daily series (one per found entry, colored and numbered by its compare slot). */
export function compareSeries(entries: readonly CompareEntry[], palette: readonly string[] = comparePalette()): GrowthSeries[] {
  const out: GrowthSeries[] = [];
  entries.forEach((e, i) => {
    if (!e.found) return;
    out.push({
      id: `c${i}`,
      label: `${i + 1}. ${e.name}`,
      color: compareColor(i, palette),
      points: e.daily.map((d) => ({ x: d.date, value: d.metric.status === 'unavailable' ? null : d.metric.value, status: d.metric.status })),
    });
  });
  return out;
}
