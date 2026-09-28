/**
 * Creator Intelligence: portfolios, comparison, timelines. OWNER: core-analytics agent.
 *
 * A portfolio is a linked creator (all accounts mapped to it, across platforms) or, for accounts without a
 * creator link, the single account. All numbers describe OUR tracked videos of the portfolio, read as known at
 * `now` (indexAsOf).
 */
import type { Account, CreatorSummary, LocalDateRange, MetricStatus, MetricValue, Platform, UtcWindow, Video } from './types.ts';
import { PLATFORMS } from './types.ts';
import type { DatasetIndex } from './dataset.ts';
import { DAY, addDays, localDateOf, localDateStartUtc, resolveAnalysisWindow, resolveWindow, weekdayHourInTz } from './time.ts';
import { increment, isKnownMetric, unavailableMetric, valueAt, valueAtAge } from './series.ts';
import { engagementAt, rankValue, windowIncrement } from './metrics.ts';
import { topLevelOf } from './taxonomy.ts';
import {
  categoryFilterSet,
  compareIds,
  indexAsOf,
  medianOf,
  resolveNow,
  searchTerms,
  sumIncrements,
  videoInCategories,
} from './query.ts';
import { compactText, normalizeText } from './text.ts';

export interface CreatorOptions {
  range: LocalDateRange;
  /** Rolling window [now - rollingHours, now) instead of the calendar range. */
  rollingHours?: number | null;
  tz: string;
  now?: number;
  platforms?: Platform[];
  categories?: string[];
  q?: string;
  sort?: 'views_period' | 'followers' | 'uploads' | 'engagement' | 'median_v7' | 'followers_growth';
  limit?: number;
}

/* ------------------------------------------------------------------------------------------
 * Portfolios
 * ---------------------------------------------------------------------------------------- */

export interface Portfolio {
  key: string;
  kind: 'creator' | 'account';
  name: string;
  /** Account records of the portfolio (PLATFORMS order, then id). */
  accounts: Account[];
  /** Every account id of the portfolio, including ids that only appear on videos (no Account record). */
  accountIds: string[];
}

function platformOrder(p: Platform): number {
  return PLATFORMS.indexOf(p);
}

function sortAccounts(accounts: Account[]): Account[] {
  return accounts.sort((a, b) => platformOrder(a.platform) - platformOrder(b.platform) || compareIds(a.id, b.id));
}

const portfolioCache = new WeakMap<DatasetIndex, Map<string, Portfolio>>();

/**
 * All portfolios of the index keyed by creator id (linked accounts) or account id (unlinked accounts).
 * Accounts that only appear as `video.accountId` (no Account record) form their own portfolio (or join
 * their creator's). Cached per index.
 */
export function creatorPortfolios(index: DatasetIndex): Map<string, Portfolio> {
  const hit = portfolioCache.get(index);
  if (hit) return hit;
  const map = new Map<string, Portfolio>();
  const add = (accountId: string, account: Account | undefined) => {
    const cid = index.creatorOfAccount.get(accountId);
    const key = cid ?? accountId;
    let p = map.get(key);
    if (!p) {
      p = {
        key,
        kind: cid ? 'creator' : 'account',
        name: cid ? (index.creatorsById.get(cid)?.name ?? '') : (account?.name ?? ''),
        accounts: [],
        accountIds: [],
      };
      map.set(key, p);
    }
    if (!p.accountIds.includes(accountId)) p.accountIds.push(accountId);
    if (account && !p.accounts.includes(account)) p.accounts.push(account);
  };
  for (const a of index.dataset.accounts) add(a.id, a);
  for (const accountId of index.videosByAccount.keys()) if (!index.accountsById.has(accountId)) add(accountId, undefined);
  for (const p of map.values()) {
    sortAccounts(p.accounts);
    p.accountIds.sort(compareIds);
    if (!p.name) p.name = p.accounts[0]?.name || p.key;
  }
  portfolioCache.set(index, map);
  return map;
}

/** Videos of a portfolio published by `now` (optionally restricted to platforms), in dataset order per account. */
function portfolioVideos(index: DatasetIndex, p: Portfolio, platforms: Set<Platform> | null, now: number): Video[] {
  const out: Video[] = [];
  for (const id of p.accountIds) {
    for (const v of index.videosByAccount.get(id) ?? []) {
      if (v.publishedAt <= now && (!platforms || platforms.has(v.platform))) out.push(v);
    }
  }
  return out;
}

/* ------------------------------------------------------------------------------------------
 * Followers
 * ---------------------------------------------------------------------------------------- */

const followerVideoCache = new WeakMap<Account, { src: Account['followers']; video: Video }>();

/** Follower points as an observation series (views = follower count) so the series math can read them. */
function followerSeries(a: Account): Video | null {
  const pts = (a.followers ?? []).filter((p) => typeof p.value === 'number' && Number.isFinite(p.value));
  if (!pts.length) return null;
  const hit = followerVideoCache.get(a);
  if (hit && hit.src === a.followers) return hit.video;
  const obs = pts
    .map((p) => ({ t: p.t, views: p.value, likes: null, comments: null, shares: null, src: p.src }))
    .sort((x, y) => x.t - y.t);
  const video: Video = {
    id: `followers:${a.id}`,
    platform: a.platform,
    platformId: a.platformId,
    url: a.url,
    title: a.name,
    description: null,
    thumbnail: null,
    // No "publish" anchor: follower counts are not 0 before tracking started.
    publishedAt: Number.NEGATIVE_INFINITY,
    durationSec: null,
    format: 'unknown',
    accountId: a.id,
    language: null,
    languageSource: null,
    country: a.country,
    sourceCategory: null,
    tags: [],
    categories: [],
    topics: [],
    sponsorship: null,
    status: 'active',
    firstSeenAt: obs[0].t,
    lastObservedAt: obs[obs.length - 1].t,
    discoveredVia: [],
    obs,
    sourceWindows: [],
  };
  followerVideoCache.set(a, { src: a.followers, video });
  return video;
}

/** Latest follower count at or before `now` (null when the platform/source provides none). */
export function latestFollowers(a: Account, now: number): { value: number; t: number } | null {
  let best: { value: number; t: number } | null = null;
  for (const p of a.followers ?? []) {
    if (p.t > now || typeof p.value !== 'number' || !Number.isFinite(p.value)) continue;
    if (!best || p.t > best.t) best = { value: p.value, t: p.t };
  }
  return best;
}

/**
 * Follower change of one account over window `w` (clipped to `now`); null when the account has no follower data.
 * Both boundaries readable (exact / interpolated, as for video counters) -> the difference, which may be negative
 * (unfollows are real, not an error). Otherwise the observed part of the window only: 'lower_bound' (or
 * 'decrease_flagged' when that partial change is negative), or 'unavailable' when no point lies in the window.
 */
export function accountFollowerGrowth(a: Account, w: UtcWindow, now: number): MetricValue | null {
  const fv = followerSeries(a);
  if (!fv) return null;
  const end = Math.min(w.endMs, now);
  if (end <= w.startMs) return unavailableMetric('window_not_started');
  const s = valueAt(fv, 'views', w.startMs);
  const e = valueAt(fv, 'views', end);
  if (isKnownMetric(s) && isKnownMetric(e)) {
    return {
      value: (e.value as number) - (s.value as number),
      status: s.status === 'exact' && e.status === 'exact' ? 'exact' : 'interpolated',
      asOf: e.asOf,
      note: null,
    };
  }
  return increment(fv, 'views', w.startMs, w.endMs, now);
}

const GROWTH_RANK: Partial<Record<MetricStatus, number>> = { exact: 0, interpolated: 1, lower_bound: 2, decrease_flagged: 3 };

/** Merge per-account follower changes: any unknown account makes the total unknown (followers can go down). */
function mergeFollowerGrowth(parts: MetricValue[]): MetricValue {
  if (!parts.length) return unavailableMetric('counter_not_provided');
  const bad = parts.find((m) => m.status === 'unavailable' || m.value === null);
  if (bad) return unavailableMetric(bad.note ?? 'partial_accounts');
  let sum = 0;
  let rank = 0;
  let asOf: number | null = null;
  let note: string | null = null;
  for (const m of parts) {
    sum += m.value as number;
    const r = GROWTH_RANK[m.status] ?? 2;
    if (r > rank) {
      rank = r;
      note = m.note;
    }
    if (m.asOf !== null && (asOf === null || m.asOf > asOf)) asOf = m.asOf;
  }
  const status: MetricStatus = rank === 0 ? 'exact' : rank === 1 ? 'interpolated' : rank === 2 ? 'lower_bound' : 'decrease_flagged';
  return { value: sum, status, asOf, note };
}

/* ------------------------------------------------------------------------------------------
 * Summaries
 * ---------------------------------------------------------------------------------------- */

function plain(m: MetricValue): MetricValue {
  return { value: m.value, status: m.status, asOf: m.asOf, note: m.note };
}

function portfolioMatchesQuery(p: Portfolio, terms: string[]): boolean {
  if (!terms.length) return true;
  const parts = [normalizeText(p.name), compactText(p.name), normalizeText(p.key)];
  for (const a of p.accounts) parts.push(normalizeText(a.name ?? ''), compactText(a.name ?? ''), normalizeText(a.handle ?? ''), normalizeText(a.id));
  const hay = parts.join('\n');
  return terms.every((t) => hay.includes(t));
}

/** Top-level categories by number of videos (ties: id asc), falling back to the accounts' seed categories. */
function topCategoriesOf(videos: Video[], accounts: Account[], max = 3): string[] {
  const counts = new Map<string, number>();
  for (const v of videos) {
    const seen = new Set<string>();
    for (const c of v.categories ?? []) seen.add(topLevelOf(c.id) ?? c.id);
    for (const id of seen) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  if (!counts.size) {
    for (const a of accounts) {
      if (!a.seedCategory) continue;
      const id = topLevelOf(a.seedCategory) ?? a.seedCategory;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || compareIds(a[0], b[0]))
    .slice(0, max)
    .map(([id]) => id);
}

/**
 * Summary of one portfolio for window `w` (see summarizeCreators for the metric definitions).
 * `platforms` restricts the accounts and videos considered (null = all).
 */
export function summarizePortfolio(index: DatasetIndex, p: Portfolio, w: UtcWindow, now: number, platforms: Set<Platform> | null = null): CreatorSummary {
  const accounts = platforms ? p.accounts.filter((a) => platforms.has(a.platform)) : p.accounts;
  const videos = portfolioVideos(index, p, platforms, now);
  const asOfEnd = Math.min(w.endMs, now);

  const platformSet = new Set<Platform>();
  for (const a of accounts) platformSet.add(a.platform);
  for (const v of videos) platformSet.add(v.platform);

  let followers: number | null = null;
  const growthParts: MetricValue[] = [];
  for (const a of accounts) {
    const f = latestFollowers(a, now);
    if (f) followers = (followers ?? 0) + f.value;
    const g = accountFollowerGrowth(a, w, now);
    if (g) growthParts.push(g);
  }

  let uploadsInWindow = 0;
  let sponsoredCount = 0;
  const increments: MetricValue[] = [];
  const engagement: number[] = [];
  let engagementAsOf: number | null = null;
  const v7: number[] = [];
  let v7Exact = true;
  let v7AsOf: number | null = null;
  let reached7 = 0;
  for (const v of videos) {
    if (v.publishedAt >= w.startMs && v.publishedAt < asOfEnd) uploadsInWindow++;
    if (v.sponsorship) sponsoredCount++;
    increments.push(windowIncrement(v, 'views', w, now));
    if (v.publishedAt < asOfEnd) {
      const e = engagementAt(v, asOfEnd);
      if (e.status !== 'unavailable' && typeof e.value === 'number' && Number.isFinite(e.value)) {
        engagement.push(e.value);
        if (e.asOf !== null && (engagementAsOf === null || e.asOf > engagementAsOf)) engagementAsOf = e.asOf;
      }
    }
    const a7 = valueAtAge(v, 'views', 7, now);
    if (a7.note !== 'not_reached') reached7++;
    if (isKnownMetric(a7)) {
      v7.push(a7.value as number);
      if (a7.status !== 'exact') v7Exact = false;
      if (a7.asOf !== null && (v7AsOf === null || a7.asOf > v7AsOf)) v7AsOf = a7.asOf;
    }
  }

  const engagementMedian = medianOf(engagement);
  const v7Median = medianOf(v7);
  return {
    key: p.key,
    kind: p.kind,
    name: p.name,
    accounts,
    platforms: PLATFORMS.filter((x) => platformSet.has(x)),
    followers,
    followersGrowth: mergeFollowerGrowth(growthParts),
    videoCount: videos.length,
    uploadsInWindow,
    viewsInWindow: plain(sumIncrements(increments)),
    engagementRate:
      engagementMedian === null
        ? unavailableMetric(videos.length ? 'counter_not_provided' : 'no_tracked_videos')
        : { value: engagementMedian, status: 'exact', asOf: engagementAsOf, note: 'median_of_videos' },
    medianV7:
      v7Median === null
        ? unavailableMetric(!videos.length ? 'no_tracked_videos' : reached7 === 0 ? 'not_reached' : 'no_v7_values')
        : { value: v7Median, status: v7Exact ? 'exact' : 'interpolated', asOf: v7AsOf, note: 'median_of_videos' },
    topCategories: topCategoriesOf(videos, accounts),
    sponsoredCount,
  };
}

function creatorSortValue(s: CreatorSummary, sort: NonNullable<CreatorOptions['sort']>): number | null {
  switch (sort) {
    case 'views_period':
      return rankValue(s.viewsInWindow);
    case 'followers':
      return s.followers;
    case 'uploads':
      return s.uploadsInWindow;
    case 'engagement':
      return rankValue(s.engagementRate);
    case 'median_v7':
      return rankValue(s.medianV7);
    case 'followers_growth':
      return rankValue(s.followersGrowth);
    default: {
      const never: never = sort;
      throw new RangeError(`Unknown creator sort: ${String(never)}`);
    }
  }
}

/**
 * One summary per creator (linked accounts merged) or per unlinked account.
 *
 * Definitions (window = opts.range in opts.tz, clipped to `now`; dataset read as known at `now`):
 * - accounts / platforms: the portfolio's accounts on opts.platforms (all when omitted); portfolios with no
 *   account and no video left are dropped.
 * - followers: sum of each account's latest follower count at or before `now`; null when no account has any.
 * - followersGrowth: sum of per-account follower changes over the window (accountFollowerGrowth). Accounts
 *   whose source provides no follower counts are left out; if any remaining account cannot be measured the
 *   total is 'unavailable' (followers can decrease, so an unknown part cannot be bounded).
 * - videoCount: tracked videos; uploadsInWindow: videos published inside the window.
 * - viewsInWindow: sum of every video's honest view increase in the window (windowIncrement, see sumIncrements):
 *   'lower_bound' when any contributor is a lower bound or unmeasurable, decreases excluded.
 * - engagementRate: median of the videos' engagement rates as of min(window end, now) (available components
 *   only, never counting missing counters as 0).
 * - medianV7: median views at 7 days after publish among videos with a readable V7.
 * - topCategories: up to 3 top-level categories by video count; sponsoredCount: videos with a sponsorship signal.
 * - Filters: q matches the creator / account names, handles and ids; categories (incl. descendants) keep
 *   portfolios with at least one matching video or a matching account seed category.
 * - Sort (default views_period) desc; unrankable values last; ties by viewsInWindow desc, then key asc.
 */
export function summarizeCreators(index: DatasetIndex, opts: CreatorOptions): CreatorSummary[] {
  const now = resolveNow(index, opts.now);
  const w = resolveAnalysisWindow(opts.range, opts.tz, now, opts.rollingHours);
  const idx = indexAsOf(index, now);
  const platforms = opts.platforms && opts.platforms.length ? new Set(opts.platforms) : null;
  const categories = categoryFilterSet(opts.categories);
  const terms = searchTerms(opts.q);
  const sort = opts.sort ?? 'views_period';

  const out: CreatorSummary[] = [];
  for (const p of creatorPortfolios(idx).values()) {
    if (!portfolioMatchesQuery(p, terms)) continue;
    if (platforms) {
      const hasAccount = p.accounts.some((a) => platforms.has(a.platform));
      if (!hasAccount && !portfolioVideos(idx, p, platforms, now).length) continue;
    }
    if (categories) {
      const seedHit = p.accounts.some((a) => (!platforms || platforms.has(a.platform)) && a.seedCategory && categories.has(a.seedCategory));
      if (!seedHit && !portfolioVideos(idx, p, platforms, now).some((v) => videoInCategories(v, categories))) continue;
    }
    out.push(summarizePortfolio(idx, p, w, now, platforms));
  }

  const primary = new Map<CreatorSummary, number | null>();
  const tie = new Map<CreatorSummary, number | null>();
  for (const s of out) {
    primary.set(s, creatorSortValue(s, sort));
    tie.set(s, rankValue(s.viewsInWindow));
  }
  const nullsLast = (a: number | null, b: number | null): number | null => {
    if (a === b) return null;
    if (a === null) return 1;
    if (b === null) return -1;
    return b - a;
  };
  out.sort((a, b) => nullsLast(primary.get(a)!, primary.get(b)!) ?? nullsLast(tie.get(a)!, tie.get(b)!) ?? compareIds(a.key, b.key));
  const limit = Number.isFinite(opts.limit) ? Math.max(0, Math.floor(opts.limit as number)) : Infinity;
  return limit === Infinity ? out : out.slice(0, limit);
}

/* ------------------------------------------------------------------------------------------
 * Timeline & heatmap
 * ---------------------------------------------------------------------------------------- */

/**
 * Daily view increments per platform for a creator/account key over the range (growth charts, 4-way comparison).
 *
 * Details: one entry per local date of the range (inclusive, in opts.tz; DST days are 23h/25h). Each platform
 * of the portfolio gets the sum of its videos' increments for that day (see sumIncrements: decreases excluded,
 * unmeasurable days make a 'lower_bound'); days at/after `now` are 'unavailable' ('window_not_started'); a platform
 * without videos published before the day ends has 0 ('no_tracked_videos'). Unknown key -> [].
 */
export function creatorTimeline(
  index: DatasetIndex,
  key: string,
  opts: { range: LocalDateRange; tz: string; now?: number },
): { date: string; byPlatform: Partial<Record<Platform, MetricValue>> }[] {
  const now = resolveNow(index, opts.now);
  const w = resolveWindow(opts.range, opts.tz, now);
  const idx = indexAsOf(index, now);
  const p = creatorPortfolios(idx).get(key);
  if (!p) return [];
  const videos = portfolioVideos(idx, p, null, now);
  const platformSet = new Set<Platform>();
  for (const a of p.accounts) platformSet.add(a.platform);
  for (const v of videos) platformSet.add(v.platform);
  const platforms = PLATFORMS.filter((x) => platformSet.has(x));
  const byPlatform = new Map<Platform, Video[]>(platforms.map((x) => [x, []]));
  for (const v of videos) byPlatform.get(v.platform)!.push(v);

  const out: { date: string; byPlatform: Partial<Record<Platform, MetricValue>> }[] = [];
  let date = localDateOf(w.startMs, opts.tz);
  let ds = w.startMs;
  while (ds < w.endMs) {
    const next = addDays(date, 1);
    const de = localDateStartUtc(next, opts.tz);
    const row: Partial<Record<Platform, MetricValue>> = {};
    for (const pf of platforms) {
      if (ds >= now) {
        row[pf] = unavailableMetric('window_not_started');
        continue;
      }
      const parts: MetricValue[] = [];
      for (const v of byPlatform.get(pf)!) if (v.publishedAt < de) parts.push(increment(v, 'views', ds, de, now));
      row[pf] = plain(sumIncrements(parts));
    }
    out.push({ date, byPlatform: row });
    date = next;
    ds = de;
  }
  return out;
}

/**
 * 7x24 matrix [weekday 0=Mon][hour] of upload counts and median V7 for a key (or whole dataset when key is null).
 *
 * Details: publish times are bucketed in `tz`; median V7 uses videos with a readable views-at-7-days value
 * (null for cells without one). Unknown key -> all-zero counts.
 */
export function postingHeatmap(
  index: DatasetIndex,
  key: string | null,
  tz: string,
  now?: number,
): { counts: number[][]; medianV7: (number | null)[][] } {
  const at = resolveNow(index, now);
  const idx = indexAsOf(index, at);
  let videos: Video[];
  if (key === null) videos = idx.dataset.videos;
  else {
    const p = creatorPortfolios(idx).get(key);
    videos = p ? portfolioVideos(idx, p, null, at) : [];
  }
  const counts = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  const cells = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => [] as number[]));
  for (const v of videos) {
    if (!(v.publishedAt <= at)) continue;
    const { weekday, hour } = weekdayHourInTz(v.publishedAt, tz);
    counts[weekday][hour]++;
    if (v.publishedAt + 7 * DAY > at) continue;
    const m = valueAtAge(v, 'views', 7, at);
    if (isKnownMetric(m)) cells[weekday][hour].push(m.value as number);
  }
  return { counts, medianV7: cells.map((row) => row.map((c) => medianOf(c))) };
}
