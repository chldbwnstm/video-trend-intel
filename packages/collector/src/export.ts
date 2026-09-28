/**
 * Dataset export (store -> `dataset.json` in the compact core format). OWNER: collector-pipeline.
 *
 * SPEC "Export":
 * - Observation compaction for export only (raw stays in SQLite), per `src`, always keeping the first and last
 *   point: every point of the last 72 h; 3–14 days: the last point of each 6 h bucket plus both neighbours of
 *   every Asia/Seoul local-day boundary (daily windows of the last two weeks stay exact); 14–90 days: one point per
 *   local day (the last before midnight); older: one per local week. Boundary neighbours are NOT kept beyond 14
 *   days (they used to be kept at every age, i.e. ~2 points per day forever, contradicting the stated density).
 * - Size budget (default 40 MB raw JSON): when exceeded, videos are dropped in this order and every drop is
 *   documented in `exportNotes` with per-platform counts (no silent caps):
 *   1. deleted / private / unknown videos and videos not observed for 7 days (oldest last observation first);
 *   2. active videos published more than 7 days ago, lowest in-platform percentile of views per day of age first
 *      (view units differ between platforms, so ranking is never by raw views across platforms: every platform
 *      loses the same share);
 *   3. only then videos published in the last 7 days, by the same in-platform percentile.
 * - Promotional spam still in the store (gambling / sex-trade ads stored before the pipeline gate existed, see
 *   spam.ts) is left out of the export, with its accounts, and counted in `exportNotes`.
 * - URLs are exported only when they are http(s) (anything else becomes '' / null), so API / CSV consumers never
 *   receive e.g. a `javascript:` link.
 * - Creators: verified portfolios from the store (seeded from creators.json) + automatic 'suggested' links when
 *   normalized account names match exactly across platforms and the evidence is strong enough (see
 *   `suggestCreators`).
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { CLASSIFIER_VERSION, DEFAULT_TZ, PLATFORMS, SPONSORSHIP_VERSION, encodeDataset, normalizeText, tzOffsetMs } from '@vti/core';
import type { Account, CollectionRun, Creator, Dataset, SourceCoverage, SourceWindowMetric, Video } from '@vti/core';
import { ADAPTERS } from './sources/index.ts';
import { safeHttpUrl } from './sources/util.ts';
import { promoSpamReason } from './spam.ts';
import type { CollectLogger, SourceAdapter } from './types.ts';
import type { AccountForExport, SourceState, Store, VideoForExport } from './store.ts';

const HOUR = 3_600_000;
const DAY = 86_400_000;

export const DEFAULT_BUDGET_BYTES = 40_000_000;
export const DEFAULT_RUN_LIMIT = 50;
/** A video not observed for this long counts as "stale" for budget pruning. */
export const DEFAULT_STALE_AFTER_MS = 7 * DAY;
/** Videos published this recently are pruned only after every older video. */
export const DEFAULT_PROTECT_RECENT_MS = 7 * DAY;
/** Max `discoveredVia` entries per video in the export (the store keeps up to 30). */
export const EXPORT_DISCOVERED_VIA_MAX = 5;
/** Max error lines per run in the export (the last line says how many more there were). */
export const EXPORT_RUN_ERROR_LINES = 20;
export const WEB_DATASET_PATH = fileURLToPath(new URL('../../../apps/web/public/data/dataset.json', import.meta.url));

export interface CompactionPolicy {
  /** Keep every point younger than this. */
  keepAllMs: number;
  /** Up to this age: at most one point per `midBucketMs`. */
  midMaxAgeMs: number;
  midBucketMs: number;
  /** Up to this age: at most one point per local day; older: one per local week. */
  dailyMaxAgeMs: number;
  /** Both neighbours of each local-day boundary are kept only while the later one is younger than this. */
  exactBoundaryMaxAgeMs: number;
}

export const DEFAULT_COMPACTION: CompactionPolicy = {
  keepAllMs: 72 * HOUR,
  midMaxAgeMs: 14 * DAY,
  midBucketMs: 6 * HOUR,
  dailyMaxAgeMs: 90 * DAY,
  exactBoundaryMaxAgeMs: 14 * DAY,
};

export interface BuildDatasetOptions {
  /**
   * Export clock (compaction, staleness; default Date.now()). The dataset's `generatedAt` (the analytics "now")
   * is min(now, newest observation in the store), so a rebuild without a fresh collection does not push
   * rolling windows past the last observation.
   */
  now?: number;
  /** Zone for day-boundary preservation (default Asia/Seoul). */
  tz?: string;
  budgetBytes?: number;
  env?: Record<string, string | undefined>;
  /** Registry used for coverage metadata (default ADAPTERS). */
  adapters?: readonly SourceAdapter[];
  runLimit?: number;
  staleAfterMs?: number;
  /** Videos published this recently are pruned last (default 7 days). */
  protectRecentMs?: number;
  compaction?: Partial<CompactionPolicy>;
  /** Disable automatic 'suggested' creator links. */
  suggestCreators?: boolean;
  log?: CollectLogger;
}

export interface BuildDatasetStats {
  rawObservations: number;
  exportedObservations: number;
  prunedVideos: number;
  prunedVideoIds: string[];
  bytes: number;
}

/* ------------------------------------------------------------------------------------------
 * Compaction
 * ---------------------------------------------------------------------------------------- */

function localDayIndex(t: number, tz: string): number {
  return Math.floor((t + tzOffsetMs(t, tz)) / DAY);
}

/** Compaction of one series that shares a single `src` (points sorted by t ascending). */
function compactSingle<T extends { t: number }>(points: T[], now: number, tz: string, p: CompactionPolicy): T[] {
  const n = points.length;
  if (n <= 2) return points.slice();
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const day = new Array<number>(n);
  for (let i = 0; i < n; i++) day[i] = localDayIndex(points[i].t, tz);
  // Both neighbours of every recent local-day boundary (daily windows of the last two weeks stay exact). Older
  // boundaries are covered by the daily / weekly buckets below (the last point of the day / week).
  for (let i = 0; i < n - 1; i++) {
    if (day[i] !== day[i + 1] && now - points[i + 1].t < p.exactBoundaryMaxAgeMs) {
      keep[i] = 1;
      keep[i + 1] = 1;
    }
  }
  // Age buckets: keep the last point of each bucket.
  const bucketOf = (i: number): string | null => {
    const t = points[i].t;
    const age = now - t;
    if (age < p.keepAllMs) return null;
    if (age < p.midMaxAgeMs) return `m${Math.floor((t + tzOffsetMs(t, tz)) / p.midBucketMs)}`;
    if (age < p.dailyMaxAgeMs) return `d${day[i]}`;
    return `w${Math.floor(day[i] / 7)}`;
  };
  let prevKey: string | null = null;
  for (let i = n - 1; i >= 0; i--) {
    const key = bucketOf(i);
    if (key === null) {
      keep[i] = 1;
      prevKey = null;
      continue;
    }
    if (key !== prevKey) keep[i] = 1; // last (latest) point of its bucket
    prevKey = key;
  }
  const out: T[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i]);
  return out;
}

/**
 * Export compaction (see file header). Works for observations and follower points; points are grouped by `src`,
 * compacted per source and merged back in (t, src) order.
 */
export function compactSeries<T extends { t: number; src: string }>(
  points: readonly T[],
  now: number,
  tz: string = DEFAULT_TZ,
  policy: Partial<CompactionPolicy> = {},
): T[] {
  const p = { ...DEFAULT_COMPACTION, ...policy };
  if (points.length <= 2) return [...points].sort((a, b) => a.t - b.t);
  const bySrc = new Map<string, T[]>();
  for (const pt of points) {
    const list = bySrc.get(pt.src);
    if (list) list.push(pt);
    else bySrc.set(pt.src, [pt]);
  }
  const out: T[] = [];
  for (const list of bySrc.values()) {
    list.sort((a, b) => a.t - b.t);
    out.push(...compactSingle(list, now, tz, p));
  }
  out.sort((a, b) => a.t - b.t || (a.src < b.src ? -1 : a.src > b.src ? 1 : 0));
  return out;
}

/** Latest source window per (metric, windowHours). */
export function latestSourceWindows(windows: readonly SourceWindowMetric[]): SourceWindowMetric[] {
  const best = new Map<string, SourceWindowMetric>();
  for (const w of windows) {
    const k = `${w.metric}|${w.windowHours}`;
    const cur = best.get(k);
    if (!cur || w.observedAt > cur.observedAt) best.set(k, w);
  }
  return [...best.values()].sort((a, b) => a.observedAt - b.observedAt || a.metric.localeCompare(b.metric) || a.windowHours - b.windowHours);
}

/* ------------------------------------------------------------------------------------------
 * Creators
 * ---------------------------------------------------------------------------------------- */

const GENERIC_NAMES = new Set([
  'news', 'music', 'official', 'tv', 'vlog', 'channel', 'video', 'videos', 'user', 'admin', 'test', 'live', 'game', 'games',
  'gaming', 'sports', 'sport', 'kpop', 'korea', 'anime', 'movie', 'movies', 'shorts', 'clips', 'highlights', 'unknown',
  '뉴스', '음악', '채널', '공식', '영상', '게임', '스포츠', '방송',
]);

/** Name normalization for automatic creator suggestions: NFKC, lowercase, letters and digits only. */
export function normalizeAccountName(name: string): string {
  return normalizeText(name ?? '').replace(/[^\p{L}\p{N}]/gu, '');
}

function isSuggestableName(norm: string): boolean {
  const len = [...norm].length;
  if (len < 2 || /^\d+$/.test(norm) || GENERIC_NAMES.has(norm)) return false;
  // Latin-only names need at least 3 characters ('ab' is too ambiguous).
  if (/^[a-z0-9]+$/.test(norm) && len < 3) return false;
  return true;
}

/** Name weight: Hangul / CJK / Kana characters count 2 (a syllable carries more than a Latin letter), others 1. */
function nameWeight(norm: string): number {
  let w = 0;
  for (const ch of norm) w += /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(ch) ? 2 : 1;
  return w;
}

/** Minimum name weight for a name-only suggestion ('백종원' = 6, 'samename' = 8; 'haha ha' is repetitive anyway). */
export const SUGGEST_MIN_NAME_WEIGHT = 6;
/** Both accounts must have an upload this recent, or at least SUGGEST_MIN_FOLLOWERS followers. */
export const SUGGEST_ACTIVE_WITHIN_MS = 180 * DAY;
export const SUGGEST_MIN_FOLLOWERS = 1000;

/** A name made of one short unit repeated ('hahaha', 'ㅋㅋㅋㅋ', 'lalala') says nothing about who it is. */
function isRepetitiveName(norm: string): boolean {
  return /^(.{1,3})\1+$/u.test(norm);
}

export interface SuggestCandidate extends Pick<Account, 'id' | 'platform' | 'name'> {
  /** Account handle (compared without '@' / case). */
  handle?: string | null;
  /** Newest upload of the account in the store (undefined = not provided: activity is not checked). */
  lastUploadAt?: number | null;
  /** Latest follower count (undefined = not provided). */
  followers?: number | null;
}

function normHandle(h: string | null | undefined): string | null {
  const t = (h ?? '').trim().replace(/^@/, '').toLowerCase();
  return t || null;
}

function shortHash(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 10);
}

/**
 * Automatic 'suggested' creators: accounts on at least two platforms whose normalized names match exactly, with
 * exactly one account per platform for that name (ambiguous names are not linked). Accounts already in a
 * verified creator are never suggested. An exact name match alone is weak evidence ('haha ha' linked a KR cat
 * channel to a dormant 2017 Dailymotion account), so a link also needs EITHER the same handle on both platforms,
 * OR a distinctive name (weight >= SUGGEST_MIN_NAME_WEIGHT, not a repeated syllable) on accounts that are both
 * alive (an upload in the last 180 days or >= 1,000 followers, when that information is provided).
 */
export function suggestCreators(accounts: readonly SuggestCandidate[], excludeAccountIds: ReadonlySet<string>, opts: { now?: number } = {}): Creator[] {
  const now = opts.now ?? Date.now();
  const alive = (a: SuggestCandidate): boolean => {
    if (a.lastUploadAt === undefined && a.followers === undefined) return true; // no activity data: not checked
    return (typeof a.lastUploadAt === 'number' && now - a.lastUploadAt <= SUGGEST_ACTIVE_WITHIN_MS) || (typeof a.followers === 'number' && a.followers >= SUGGEST_MIN_FOLLOWERS);
  };
  const groups = new Map<string, SuggestCandidate[]>();
  for (const a of accounts) {
    if (excludeAccountIds.has(a.id)) continue;
    const norm = normalizeAccountName(a.name);
    if (!isSuggestableName(norm)) continue;
    const list = groups.get(norm);
    if (list) list.push(a);
    else groups.set(norm, [a]);
  }
  const out: Creator[] = [];
  for (const [norm, list] of groups) {
    const platforms = new Map<string, number>();
    for (const a of list) platforms.set(a.platform, (platforms.get(a.platform) ?? 0) + 1);
    if (platforms.size < 2) continue;
    if ([...platforms.values()].some((n) => n > 1)) continue; // ambiguous: several accounts with this name on one platform
    const handles = list.map((a) => normHandle(a.handle));
    const sameHandle = handles.every((h) => h !== null && h === handles[0]);
    const distinctive = nameWeight(norm) >= SUGGEST_MIN_NAME_WEIGHT && !isRepetitiveName(norm);
    if (!sameHandle && !(distinctive && list.every(alive))) continue;
    const sorted = [...list].sort((a, b) => PLATFORMS.indexOf(a.platform) - PLATFORMS.indexOf(b.platform) || a.id.localeCompare(b.id));
    out.push({
      id: `suggested-${shortHash(norm)}`,
      name: sorted[0].name,
      accountIds: sorted.map((a) => a.id),
      linkStatus: 'suggested',
      note: `자동 제안(확인 전): 플랫폼 간 계정 이름이 정규화 후 정확히 일치함${sameHandle ? '(핸들도 같음)' : ''} — ${sorted.map((a) => `${a.platform} "${a.name}"`).join(', ')}`,
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/* ------------------------------------------------------------------------------------------
 * Build
 * ---------------------------------------------------------------------------------------- */

/** Export-side description cap (the store keeps up to 300 chars; classification already used them). */
export const EXPORT_DESCRIPTION_MAX_CHARS = 120;

function clipDescription(d: string | null): string | null {
  if (!d) return d;
  const chars = Array.from(d);
  return chars.length <= EXPORT_DESCRIPTION_MAX_CHARS ? d : `${chars.slice(0, EXPORT_DESCRIPTION_MAX_CHARS).join('').trimEnd()}…`;
}

function toVideo(v: VideoForExport): Video {
  const cls = v.classification;
  return {
    id: v.id,
    platform: v.platform,
    platformId: v.platformId,
    url: safeHttpUrl(v.url) ?? '',
    title: v.title,
    description: clipDescription(v.description),
    thumbnail: safeHttpUrl(v.thumbnail),
    publishedAt: v.publishedAt,
    durationSec: v.durationSec,
    format: v.format,
    accountId: v.accountId,
    language: v.language,
    languageSource: v.languageSource,
    country: v.country,
    sourceCategory: v.sourceCategory,
    tags: v.tags,
    categories: cls?.categories ?? [],
    topics: cls?.topics ?? [],
    sponsorship: cls?.sponsorship ?? null,
    status: v.status,
    firstSeenAt: v.firstSeenAt,
    lastObservedAt: v.lastObservedAt ?? v.firstSeenAt,
    discoveredVia: v.discoveredVia.slice(0, EXPORT_DISCOVERED_VIA_MAX),
    obs: v.obs,
    sourceWindows: v.sourceWindows,
  };
}

function toAccount(a: AccountForExport, creatorId: string | null): Account {
  return {
    id: a.id,
    platform: a.platform,
    platformId: a.platformId,
    handle: a.handle,
    name: a.name,
    url: safeHttpUrl(a.url) ?? '',
    avatar: safeHttpUrl(a.avatar),
    country: a.country,
    followers: a.followers,
    creatorId,
    seedCategory: a.seedCategory,
    trackedSince: a.trackedSince,
    discoveredVia: a.discoveredVia,
  };
}

function capRunErrors(runs: CollectionRun[]): CollectionRun[] {
  return runs.map((r) =>
    r.errors.length > EXPORT_RUN_ERROR_LINES
      ? { ...r, errors: [...r.errors.slice(0, EXPORT_RUN_ERROR_LINES - 1), `… 외 오류 ${r.errors.length - (EXPORT_RUN_ERROR_LINES - 1)}건 (내보내기에는 앞의 ${EXPORT_RUN_ERROR_LINES - 1}줄만 포함, 전체는 저장소 runs/run_errors)`] }
      : r,
  );
}

function coverageFor(
  adapters: readonly SourceAdapter[],
  states: Map<string, SourceState>,
  env: Record<string, string | undefined>,
  videos: readonly VideoForExport[],
  accounts: readonly AccountForExport[],
): SourceCoverage[] {
  const videoCount = new Map<string, number>();
  for (const v of videos) for (const s of v.sources) videoCount.set(s, (videoCount.get(s) ?? 0) + 1);
  const accountCount = new Map<string, number>();
  for (const a of accounts) for (const s of a.sources) accountCount.set(s, (accountCount.get(s) ?? 0) + 1);

  return adapters.map((a) => {
    const st = states.get(a.id) ?? null;
    let enabled: boolean;
    if (st && st.lastStatus !== 'never') enabled = st.lastStatus !== 'disabled';
    else {
      try {
        enabled = a.isEnabled(env);
      } catch {
        enabled = false;
      }
    }
    const lastStatus: SourceCoverage['lastStatus'] = st?.lastStatus && st.lastStatus !== 'never' ? st.lastStatus : enabled ? 'never' : 'disabled';
    const notes = [...(a.notes ?? [])];
    for (const n of st?.notes ?? []) if (!notes.includes(n)) notes.push(n);
    if (!enabled && a.requiresCredentials && !notes.some((n) => n.includes('환경 변수'))) {
      notes.push(`인증 정보가 없어 비활성화됨 (필요한 환경 변수: ${a.envKeys.join(', ') || '없음'})`);
    }
    return {
      source: a.id,
      platform: a.platform,
      label: a.label,
      enabled,
      requiresCredentials: a.requiresCredentials,
      discovery: a.discovery,
      metrics: [...a.metrics],
      firstRunAt: st?.firstRunAt ?? null,
      lastRunAt: st?.lastRunAt ?? null,
      lastSuccessAt: st?.lastSuccessAt ?? null,
      lastStatus,
      lastError: st?.lastError ?? null,
      videoCount: videoCount.get(a.id) ?? 0,
      accountCount: accountCount.get(a.id) ?? 0,
      notes,
      docsUrl: a.docsUrl ?? null,
    };
  });
}

function fmtMB(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(2)}MB`;
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/** Build the export Dataset (see file header). Read-only on the store. */
export function buildDataset(store: Store, opts: BuildDatasetOptions = {}): Dataset {
  return buildDatasetDetailed(store, opts).dataset;
}

export function buildDatasetDetailed(store: Store, opts: BuildDatasetOptions = {}): { dataset: Dataset; stats: BuildDatasetStats } {
  const now = opts.now ?? Date.now();
  const tz = opts.tz ?? DEFAULT_TZ;
  const budget = opts.budgetBytes ?? DEFAULT_BUDGET_BYTES;
  const env = opts.env ?? (process.env as Record<string, string | undefined>);
  const adapters = opts.adapters ?? ADAPTERS;
  const staleAfter = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const exportNotes: string[] = [];

  let rawObservations = 0;
  let exportedObservations = 0;
  const parts = store.loadDatasetParts({
    mapObs: (obs) => {
      rawObservations += obs.length;
      const c = compactSeries(obs, now, tz, opts.compaction);
      exportedObservations += c.length;
      return c;
    },
    mapSourceWindows: (w) => latestSourceWindows(w),
    mapFollowers: (f) => compactSeries(f, now, tz, opts.compaction),
    runLimit: opts.runLimit ?? DEFAULT_RUN_LIMIT,
  });

  /* ---- promotional spam stored before the pipeline gate: excluded here (kept in the store) ---- */
  const accountById = new Map(parts.accounts.map((a) => [a.id, a] as const));
  const spamIds = new Set<string>();
  const spamPlatforms = new Map<string, number>();
  for (const v of parts.videos) {
    const a = accountById.get(v.accountId);
    if (promoSpamReason(v, a ? { name: a.name, handle: a.handle } : null)) {
      spamIds.add(v.id);
      spamPlatforms.set(v.platform, (spamPlatforms.get(v.platform) ?? 0) + 1);
    }
  }
  if (spamIds.size) {
    const hasCleanVideo = new Set(parts.videos.filter((v) => !spamIds.has(v.id)).map((v) => v.accountId));
    const spamAccounts = new Set(parts.videos.filter((v) => spamIds.has(v.id) && !hasCleanVideo.has(v.accountId)).map((v) => v.accountId));
    parts.videos = parts.videos.filter((v) => !spamIds.has(v.id));
    parts.accounts = parts.accounts.filter((a) => !spamAccounts.has(a.id));
    exportNotes.push(
      `홍보성 스팸(불법 도박·성매매·대출 광고로 판별) 영상 ${spamIds.size}개와 그 영상만 올린 계정 ${spamAccounts.size}개를 내보내기에서 제외함(저장소에는 보존). 플랫폼별: ${[...spamPlatforms].map(([pf, n]) => `${pf} ${n}`).join(', ')}.`,
    );
  }
  const unsafeUrls =
    parts.videos.filter((v) => (v.url && !safeHttpUrl(v.url)) || (v.thumbnail && !safeHttpUrl(v.thumbnail))).length +
    parts.accounts.filter((a) => (a.url && !safeHttpUrl(a.url)) || (a.avatar && !safeHttpUrl(a.avatar))).length;
  if (unsafeUrls) exportNotes.push(`http(s)가 아닌 URL을 가진 영상·계정 ${unsafeUrls}개는 해당 URL을 비워서 내보냄.`);
  const viaCapped = parts.videos.filter((v) => v.discoveredVia.length > EXPORT_DISCOVERED_VIA_MAX).length;
  if (viaCapped) exportNotes.push(`발견 경로가 ${EXPORT_DISCOVERED_VIA_MAX}개를 넘는 영상 ${viaCapped}개는 처음 ${EXPORT_DISCOVERED_VIA_MAX}개만 내보냄(전체는 저장소).`);

  // Data "as of": explicit clock, else the newest observation (never later than the export clock).
  let latestObserved = Number.NEGATIVE_INFINITY;
  for (const v of parts.videos) {
    const t = (v as { lastObservedAt?: number | null }).lastObservedAt;
    if (typeof t === 'number' && Number.isFinite(t) && t > latestObserved) latestObserved = t;
  }
  const generatedAt = Number.isFinite(latestObserved) ? Math.min(latestObserved, now) : now;

  /* ---- creators ---- */
  const accountIds = new Set(parts.accounts.map((a) => a.id));
  const creators: Creator[] = [];
  const creatorOf = new Map<string, string>();
  const verified = parts.creators.filter((c) => c.linkStatus === 'verified');
  const emptyCreators: string[] = [];
  let missingLinks = 0;
  for (const c of verified) {
    const present = c.accountIds.filter((id) => accountIds.has(id) && !creatorOf.has(id));
    missingLinks += c.accountIds.length - present.length;
    if (!present.length) {
      emptyCreators.push(c.id);
      continue;
    }
    for (const id of present) creatorOf.set(id, c.id);
    creators.push({ id: c.id, name: c.name, accountIds: present, linkStatus: 'verified', note: c.note });
  }
  if (emptyCreators.length) {
    exportNotes.push(`검증된 크리에이터 ${emptyCreators.length}명은 연결된 계정이 아직 수집되지 않아 제외함 (${emptyCreators.slice(0, 10).join(', ')}${emptyCreators.length > 10 ? ', …' : ''}).`);
  }
  if (missingLinks > 0) exportNotes.push(`검증된 크리에이터 연결 중 아직 수집되지 않은 계정 ${missingLinks}개는 포트폴리오에서 빠짐.`);
  if (opts.suggestCreators ?? true) {
    const lastUpload = new Map<string, number>();
    for (const v of parts.videos) if (v.publishedAt > (lastUpload.get(v.accountId) ?? Number.NEGATIVE_INFINITY)) lastUpload.set(v.accountId, v.publishedAt);
    const candidates: SuggestCandidate[] = parts.accounts.map((a) => ({
      id: a.id,
      platform: a.platform,
      name: a.name,
      handle: a.handle,
      lastUploadAt: lastUpload.get(a.id) ?? null,
      followers: a.followers.length ? a.followers[a.followers.length - 1].value : null,
    }));
    const suggested = suggestCreators(candidates, new Set(creatorOf.keys()), { now });
    for (const s of suggested) {
      for (const id of s.accountIds) creatorOf.set(id, s.id);
      creators.push(s);
    }
    if (suggested.length) {
      exportNotes.push(
        `자동 제안 크리에이터 연결 ${suggested.length}건: 계정 이름이 플랫폼 간 정확히 일치하고, 핸들이 같거나 이름이 충분히 고유하며 두 계정 모두 활동 중(180일 안에 업로드 또는 팔로워 1,000명 이상)인 경우로, 사람이 확인하지 않은 연결임(linkStatus=suggested).`,
      );
    }
  }
  // Store-persisted 'suggested' creators are derived data; the automatic ones above replace them.

  // Classification freshness (buildDataset is read-only: callers classify first, e.g. classifyStoredVideos).
  const unclassified = parts.videos.filter((v) => !v.classification).length;
  const staleClassified = parts.videos.filter(
    (v) => v.classification && (v.classification.classifierVersion !== CLASSIFIER_VERSION || v.classification.sponsorshipVersion !== SPONSORSHIP_VERSION || v.classification.textHash !== v.textHash),
  ).length;
  if (unclassified || staleClassified) {
    exportNotes.push(
      `분류 상태: 분류되지 않은 영상 ${unclassified}개, 이전 분류기 버전이거나 제목·설명이 바뀐 뒤 재분류되지 않은 영상 ${staleClassified}개(현재 ${CLASSIFIER_VERSION} / ${SPONSORSHIP_VERSION}).`,
    );
  }

  const accounts = parts.accounts.map((a) => toAccount(a, creatorOf.get(a.id) ?? null));
  const stateMap = new Map(parts.sourceStates.map((s) => [s.source, s] as const));
  const runs = capRunErrors(parts.runs);

  /* ---- notes ---- */
  exportNotes.unshift(
    `관측값은 내보내기에서만 압축함(원자료는 SQLite에 보존): 최근 72시간은 전체, 3~14일은 6시간당 1개와 ${tz} 자정 경계 앞뒤 관측(최근 2주의 일별 구간 값은 원자료와 같음), 14~90일은 현지 날짜당 1개(자정 전 마지막 관측), 그 이전은 현지 주당 1개. 원천별 처음·마지막 관측은 항상 유지함. 원자료 ${rawObservations.toLocaleString("en-US")}개 → 압축 후 ${exportedObservations.toLocaleString("en-US")}개.`,
  );
  const disabled = adapters.filter((a) => {
    const st = stateMap.get(a.id);
    if (st && st.lastStatus !== 'never') return st.lastStatus === 'disabled';
    try {
      return !a.isEnabled(env);
    } catch {
      return true;
    }
  });
  if (disabled.length) {
    exportNotes.push(
      `비활성 수집 원천 ${disabled.length}개(인증 정보 없음): ${disabled.map((a) => `${a.id}${a.envKeys.length ? `(${a.envKeys.join(', ')})` : ''}`).join(', ')}. 이 원천의 영상은 데이터에 없음.`,
    );
  }

  /* ---- assemble + budget ---- */
  const assemble = (vids: VideoForExport[], notes: string[]): Dataset => ({
    schemaVersion: 1,
    generatedAt,
    classifierVersion: CLASSIFIER_VERSION,
    videos: vids.map(toVideo),
    accounts,
    creators,
    coverage: coverageFor(adapters, stateMap, env, vids, parts.accounts),
    runs,
    exportNotes: notes,
  });

  let kept = parts.videos;
  let dataset = assemble(kept, exportNotes);
  let encoded = encodeDataset(dataset);
  let bytes = byteLength(JSON.stringify(encoded));
  const pruned: VideoForExport[] = [];

  if (bytes > budget) {
    const originalBytes = bytes;
    const sizes = new Map<string, number>();
    encoded.videos.forEach((cv) => sizes.set(cv.id, byteLength(JSON.stringify(cv)) + 1));
    const isStale = (v: VideoForExport) => v.status !== 'active' || (v.lastObservedAt ?? v.firstSeenAt) < now - staleAfter;
    const protectRecent = opts.protectRecentMs ?? DEFAULT_PROTECT_RECENT_MS;
    const order = pruneOrder(kept, now, isStale, protectRecent);
    const NOTE_RESERVE = 4096; // room for the pruning note itself
    const dropIds = new Set<string>();
    let cursor = 0;
    for (let pass = 0; pass < 5 && bytes > budget; pass++) {
      let estimate = bytes;
      while (estimate > budget - NOTE_RESERVE && cursor < order.length) {
        const v = order[cursor++];
        dropIds.add(v.id);
        estimate -= sizes.get(v.id) ?? 0;
      }
      kept = parts.videos.filter((v) => !dropIds.has(v.id));
      pruned.splice(0, pruned.length, ...parts.videos.filter((v) => dropIds.has(v.id)));
      const notes = [...exportNotes, pruneNote(pruned, isStale, budget, originalBytes, staleAfter, now, protectRecent, parts.videos)];
      dataset = assemble(kept, notes);
      encoded = encodeDataset(dataset);
      bytes = byteLength(JSON.stringify(encoded));
      if (cursor >= order.length) break;
    }
    if (bytes > budget) {
      dataset.exportNotes.push(`영상을 제외한 뒤에도 크기 예산 ${fmtMB(budget)}을 넘음(${fmtMB(bytes)}): 계정·실행 기록 등 영상 외 데이터가 큼.`);
    }
    opts.log?.warn(`export: budget ${fmtMB(budget)} exceeded (${fmtMB(originalBytes)}); pruned ${pruned.length} video(s) -> ${fmtMB(bytes)}`);
  }

  return {
    dataset,
    stats: {
      rawObservations,
      exportedObservations: dataset.videos.reduce((n, v) => n + v.obs.length, 0),
      prunedVideos: pruned.length,
      prunedVideoIds: pruned.map((v) => v.id),
      bytes,
    },
  };
}

/** Prune class: 0 stale/inactive, 1 active older than `protectRecent`, 2 active and recently published. */
function pruneClass(v: VideoForExport, now: number, isStale: (v: VideoForExport) => boolean, protectRecent: number): 0 | 1 | 2 {
  if (isStale(v)) return 0;
  return v.publishedAt >= now - protectRecent ? 2 : 1;
}

/**
 * Budget pruning order (first = dropped first), see the file header. Within classes 1 and 2 videos are ranked by
 * the percentile of views per day of age inside their own (platform, class) group, so pruning takes the same
 * share from every platform instead of wiping out the platforms whose view counts are small (PeerTube, niconico)
 * or the newest uploads (which have had no time to gather views).
 */
export function pruneOrder(videos: readonly VideoForExport[], now: number, isStale: (v: VideoForExport) => boolean, protectRecent: number): VideoForExport[] {
  const cls = new Map<string, 0 | 1 | 2>();
  const groups = new Map<string, VideoForExport[]>();
  for (const v of videos) {
    const c = pruneClass(v, now, isStale, protectRecent);
    cls.set(v.id, c);
    const key = `${c}|${v.platform}`;
    const g = groups.get(key);
    if (g) g.push(v);
    else groups.set(key, [v]);
  }
  const rate = (v: VideoForExport) => (v.lastViews === null ? -1 : v.lastViews / Math.max(1, (now - v.publishedAt) / DAY));
  const pct = new Map<string, number>();
  for (const g of groups.values()) {
    const sorted = [...g].sort((a, b) => rate(a) - rate(b) || a.id.localeCompare(b.id));
    sorted.forEach((v, i) => pct.set(v.id, sorted.length === 1 ? 0 : i / (sorted.length - 1)));
  }
  const lastSeen = (v: VideoForExport) => v.lastObservedAt ?? v.firstSeenAt;
  return [...videos].sort((a, b) => {
    const ca = cls.get(a.id)!;
    const cb = cls.get(b.id)!;
    if (ca !== cb) return ca - cb;
    if (ca === 0 && lastSeen(a) !== lastSeen(b)) return lastSeen(a) - lastSeen(b);
    return pct.get(a.id)! - pct.get(b.id)! || lastSeen(a) - lastSeen(b) || a.id.localeCompare(b.id);
  });
}

function pruneNote(
  pruned: VideoForExport[],
  isStale: (v: VideoForExport) => boolean,
  budget: number,
  originalBytes: number,
  staleAfter: number,
  now: number,
  protectRecent: number,
  all: readonly VideoForExport[],
): string {
  const byClass = [0, 0, 0];
  const byPlatform = new Map<string, number>();
  for (const v of pruned) {
    byClass[pruneClass(v, now, isStale, protectRecent)]++;
    byPlatform.set(v.platform, (byPlatform.get(v.platform) ?? 0) + 1);
  }
  const totalByPlatform = new Map<string, number>();
  for (const v of all) totalByPlatform.set(v.platform, (totalByPlatform.get(v.platform) ?? 0) + 1);
  const days = Math.round(staleAfter / DAY);
  const recentDays = Math.round(protectRecent / DAY);
  return (
    `크기 예산 ${fmtMB(budget)} 초과(압축 후 ${fmtMB(originalBytes)})로 영상 ${pruned.length}개를 내보내기에서 제외함: ` +
    `${days}일 이상 갱신되지 않았거나 삭제·비공개 상태인 영상 ${byClass[0]}개, 게시 ${recentDays}일이 지난 영상 ${byClass[1]}개, 최근 ${recentDays}일 안에 게시된 영상 ${byClass[2]}개. ` +
    `제외 순서: 갱신 중단·삭제 영상(마지막 관측이 오래된 순) → 게시 ${recentDays}일이 지난 영상 → 최근 ${recentDays}일 게시 영상. 뒤의 두 단계는 플랫폼마다 따로 매긴 일평균 조회수 백분위가 낮은 순이라 플랫폼별로 같은 비율이 빠짐(플랫폼 간 조회수 단위가 달라 원래 조회수로 비교하지 않음). ` +
    `플랫폼별 제외/전체: ${[...byPlatform].map(([pf, n]) => `${pf} ${n}/${totalByPlatform.get(pf) ?? n}`).join(', ')}. 원자료는 저장소(SQLite)에 그대로 있음.`
  );
}

/* ------------------------------------------------------------------------------------------
 * Write
 * ---------------------------------------------------------------------------------------- */

export interface WriteExportOptions {
  /** Also write dataset.json to this path; true = WEB_DATASET_PATH (apps/web/public/data/dataset.json). */
  copyTo?: string | boolean | null;
}

export interface ExportMeta {
  generatedAt: number;
  generatedAtIso: string;
  classifierVersion: string;
  counts: { videos: number; accounts: number; creators: number; observations: number; runs: number; sources: number; exportNotes: number };
  bytes: number;
}

export interface WriteExportResult {
  datasetPath: string;
  metaPath: string;
  copiedTo: string | null;
  bytes: number;
  meta: ExportMeta;
}

/** Write via a temp file + rename so readers never see a half-written file (retries on Windows sharing errors). */
export function writeFileAtomic(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, data, 'utf8');
  for (let i = 0; i < 5; i++) {
    try {
      renameSync(tmp, path);
      return;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') break;
      // A reader (e.g. the API server) may hold the target open on Windows: wait briefly and retry.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (i + 1));
    }
  }
  try {
    writeFileSync(path, data, 'utf8'); // last resort: non-atomic overwrite
  } finally {
    rmSync(tmp, { force: true });
  }
}

export function writeExport(dataset: Dataset, outDir: string, opts: WriteExportOptions = {}): WriteExportResult {
  const json = JSON.stringify(encodeDataset(dataset));
  const bytes = byteLength(json);
  const datasetPath = join(outDir, 'dataset.json');
  const metaPath = join(outDir, 'meta.json');
  writeFileAtomic(datasetPath, json);
  const meta: ExportMeta = {
    generatedAt: dataset.generatedAt,
    generatedAtIso: new Date(dataset.generatedAt).toISOString(),
    classifierVersion: dataset.classifierVersion,
    counts: {
      videos: dataset.videos.length,
      accounts: dataset.accounts.length,
      creators: dataset.creators.length,
      observations: dataset.videos.reduce((n, v) => n + v.obs.length, 0),
      runs: dataset.runs.length,
      sources: dataset.coverage.length,
      exportNotes: dataset.exportNotes.length,
    },
    bytes,
  };
  writeFileAtomic(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
  let copiedTo: string | null = null;
  const copyPath = opts.copyTo === true ? WEB_DATASET_PATH : typeof opts.copyTo === 'string' && opts.copyTo ? opts.copyTo : null;
  if (copyPath) {
    writeFileAtomic(copyPath, json);
    copiedTo = copyPath;
  }
  return { datasetPath, metaPath, copiedTo, bytes, meta };
}
