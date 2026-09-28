/**
 * Source adapter: youtube-data-api (YouTube Data API v3, API key).
 *
 * Docs
 * - search.list   https://developers.google.com/youtube/v3/docs/search/list
 * - videos        https://developers.google.com/youtube/v3/docs/videos  (resource) + /videos/list
 * - channels      https://developers.google.com/youtube/v3/docs/channels (resource) + /channels/list
 * - quota         https://developers.google.com/youtube/v3/determine_quota_cost
 * - revisions     https://developers.google.com/youtube/v3/revision_history
 *
 * Flow per run
 * 1. Discovery: search.list (part=snippet, type=video, order=viewCount|date, regionCode=KR,
 *    relevanceLanguage=<seed language, default ko>, publishedAfter=now-7d, q=<keyword seed>, maxResults=50).
 *    At most YOUTUBE_SEARCHES_PER_RUN (default 8) calls; candidates (keyword × order) rotate across runs.
 * 2. Stats: videos.list (part=snippet,statistics,contentDetails,liveStreamingDetails) for discovered ids and
 *    ctx.refreshIds (any YouTube video id, including ones found by youtube-rss), batches of 50 ids.
 *    Refresh ids missing from a successful response are reported as gone.
 * 3. Subscribers: channels.list (part=snippet,statistics), batches of 50 channel ids.
 *
 * Quota (default project allocation, as documented on 2026-09):
 * - search.list: own bucket since 2026-06-01 — 100 calls/day, cost 1 per call.
 *   (Before 2026-06-01: 100 units per call out of the shared 10,000 units/day.)
 * - videos.list / channels.list: 1 unit per call (up to 50 ids) out of 10,000 units/day.
 * Default per run: 8 searches (→ ≤ 400 candidate ids) + ⌈(400 + refresh)/50⌉ videos.list + ⌈channels/50⌉
 * channels.list. 12 runs/day × 8 = 96 search calls/day (≤ 100); under the legacy scheme that is
 * 12 × 800 = 9,600 units (≤ 10,000). Keep runs/day × YOUTUBE_SEARCHES_PER_RUN ≤ 100.
 */
import type { VideoFormat } from '@vti/core';
import type { CollectContext, CollectResult, RawAccount, RawVideo, SourceAdapter } from '../types.ts';
import {
  DAY_MS,
  RequestBudget,
  chunk,
  describeHttpError,
  descriptionOf,
  envInt,
  envStr,
  errorLine,
  failureText,
  hasAllEnv,
  keywordSeeds,
  normLang,
  parseTime,
  rfc3339,
  rotatingSlice,
  toCount,
  uniq,
  type HttpFailure,
} from './keyed-util.ts';

const ID = 'youtube-data-api';
const API = 'https://www.googleapis.com/youtube/v3';
const ENV_KEYS = ['YOUTUBE_API_KEY'];

export const YOUTUBE_DEFAULT_SEARCHES_PER_RUN = 8;
export const YOUTUBE_SEARCH_LOOKBACK_DAYS = 7;
/** Documented default allocation (2026-09). */
export const YOUTUBE_QUOTA = {
  /** search.list bucket (since 2026-06-01): calls per day, 1 per call. */
  searchCallsPerDay: 100,
  /** Shared bucket for every other method. */
  unitsPerDay: 10_000,
  videosListUnits: 1,
  channelsListUnits: 1,
  /** Pre-2026-06-01 cost of one search.list call in the shared bucket. */
  legacySearchUnits: 100,
  maxIdsPerCall: 50,
} as const;

/** YouTube video ids are 11 chars of [A-Za-z0-9_-]. */
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/**
 * Standard YouTube video category ids (videoCategories.list, regionCode=KR/US) → names.
 * Used for notes / labels; the stored value stays the namespaced id `youtube:category:<id>`.
 */
export const YOUTUBE_CATEGORY_NAMES: Record<string, { en: string; ko: string }> = {
  '1': { en: 'Film & Animation', ko: '영화/애니메이션' },
  '2': { en: 'Autos & Vehicles', ko: '자동차' },
  '10': { en: 'Music', ko: '음악' },
  '15': { en: 'Pets & Animals', ko: '반려동물/동물' },
  '17': { en: 'Sports', ko: '스포츠' },
  '18': { en: 'Short Movies', ko: '단편 영화' },
  '19': { en: 'Travel & Events', ko: '여행/이벤트' },
  '20': { en: 'Gaming', ko: '게임' },
  '21': { en: 'Videoblogging', ko: '브이로그' },
  '22': { en: 'People & Blogs', ko: '인물/블로그' },
  '23': { en: 'Comedy', ko: '코미디' },
  '24': { en: 'Entertainment', ko: '엔터테인먼트' },
  '25': { en: 'News & Politics', ko: '뉴스/정치' },
  '26': { en: 'Howto & Style', ko: '노하우/스타일' },
  '27': { en: 'Education', ko: '교육' },
  '28': { en: 'Science & Technology', ko: '과학기술' },
  '29': { en: 'Nonprofits & Activism', ko: '비영리/사회운동' },
  '30': { en: 'Movies', ko: '영화' },
  '31': { en: 'Anime/Animation', ko: '애니메이션' },
  '32': { en: 'Action/Adventure', ko: '액션/모험' },
  '33': { en: 'Classics', ko: '고전' },
  '34': { en: 'Comedy', ko: '코미디' },
  '35': { en: 'Documentary', ko: '다큐멘터리' },
  '36': { en: 'Drama', ko: '드라마' },
  '37': { en: 'Family', ko: '가족' },
  '38': { en: 'Foreign', ko: '해외' },
  '39': { en: 'Horror', ko: '공포' },
  '40': { en: 'Sci-Fi/Fantasy', ko: 'SF/판타지' },
  '41': { en: 'Thriller', ko: '스릴러' },
  '42': { en: 'Shorts', ko: '쇼츠' },
  '43': { en: 'Shows', ko: '쇼' },
  '44': { en: 'Trailers', ko: '예고편' },
};

/* ------------------------------------------------------------------ pure helpers (exported for tests) */

/**
 * ISO-8601 duration (`PT1H2M3S`, `P1DT2H`, `PT15.5S`, `P0D`) → whole seconds, or null when unparseable.
 * Years/months are not used by YouTube and are rejected (ambiguous length).
 */
export function parseIsoDuration(s: unknown): number | null {
  if (typeof s !== 'string') return null;
  const m = /^P(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
    s.trim(),
  );
  if (!m || s.trim() === 'P' || s.trim().endsWith('T')) return null;
  const [w, d, h, min, sec] = m.slice(1).map((x) => (x === undefined ? 0 : Number(x)));
  return Math.round(w * 604_800 + d * 86_400 + h * 3_600 + min * 60 + sec);
}

/**
 * Format heuristic (the API has no "is Short" flag):
 * - live: currently live / scheduled (liveBroadcastContent live|upcoming) or a past live stream
 *   (liveStreamingDetails present).
 * - short: duration <= 60 s; or 61–180 s with an explicit `#shorts` marker in title/description/tags
 *   (Shorts may be up to 3 minutes since 2024-10-15, so length alone cannot tell 61–180 s apart).
 * - long: everything else with a known duration; unknown when the duration is missing.
 */
export function youtubeFormat(input: {
  durationSec: number | null;
  liveBroadcastContent?: string | null;
  hasLiveStreamingDetails?: boolean;
  title?: string | null;
  description?: string | null;
  tags?: readonly string[];
}): VideoFormat {
  const lbc = input.liveBroadcastContent ?? 'none';
  if (lbc === 'live' || lbc === 'upcoming' || input.hasLiveStreamingDetails) return 'live';
  const d = input.durationSec;
  if (d === null || d <= 0) return 'unknown';
  if (d <= 60) return 'short';
  if (d <= 180) {
    const text = `${input.title ?? ''}\n${input.description ?? ''}`.toLowerCase();
    const tagged = /#shorts?\b/.test(text) || (input.tags ?? []).some((t) => /^#?shorts?$/i.test(t.trim()));
    return tagged ? 'short' : 'long';
  }
  return 'long';
}

export interface YoutubeSearchPlanItem {
  keyword: string;
  order: 'viewCount' | 'date';
  relevanceLanguage: string;
  category: string;
}

/**
 * Search candidates = every keyword with order=viewCount, then every keyword with order=date; the first
 * `perRun` are taken from a position that rotates hourly, so all candidates are covered over several runs.
 */
export function planYoutubeSearches(ctx: CollectContext, perRun: number): YoutubeSearchPlanItem[] {
  const seeds = keywordSeeds(ctx);
  const candidates: YoutubeSearchPlanItem[] = [];
  for (const order of ['viewCount', 'date'] as const) {
    for (const s of seeds) {
      candidates.push({ keyword: s.keyword, order, relevanceLanguage: normLang(s.language) ?? 'ko', category: s.category });
    }
  }
  return rotatingSlice(candidates, perRun, ctx.now);
}

/** Documented quota estimate for a run (for logs / coverage notes). */
export function estimateYoutubeQuota(searchCalls: number, videoIds: number, channelIds: number) {
  const standardUnits =
    Math.ceil(videoIds / YOUTUBE_QUOTA.maxIdsPerCall) * YOUTUBE_QUOTA.videosListUnits +
    Math.ceil(channelIds / YOUTUBE_QUOTA.maxIdsPerCall) * YOUTUBE_QUOTA.channelsListUnits;
  return { searchCalls, standardUnits, legacyUnits: standardUnits + searchCalls * YOUTUBE_QUOTA.legacySearchUnits };
}

/* ------------------------------------------------------------------ API response shapes (subset) */

interface YtThumbs {
  [k: string]: { url?: string; width?: number; height?: number } | undefined;
}
interface YtSearchResponse {
  nextPageToken?: string;
  items?: { id?: { kind?: string; videoId?: string } }[];
}
interface YtVideo {
  id?: string;
  snippet?: {
    publishedAt?: string;
    channelId?: string;
    title?: string;
    description?: string;
    thumbnails?: YtThumbs;
    channelTitle?: string;
    tags?: string[];
    categoryId?: string;
    liveBroadcastContent?: string;
    defaultLanguage?: string;
    defaultAudioLanguage?: string;
  };
  contentDetails?: { duration?: string };
  statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
  liveStreamingDetails?: { actualStartTime?: string; scheduledStartTime?: string };
}
interface YtVideoListResponse {
  items?: YtVideo[];
}
interface YtChannel {
  id?: string;
  snippet?: { title?: string; customUrl?: string; thumbnails?: YtThumbs; country?: string };
  statistics?: { subscriberCount?: string; hiddenSubscriberCount?: boolean };
}
interface YtChannelListResponse {
  items?: YtChannel[];
}

function bestThumb(t: YtThumbs | undefined, order = ['high', 'medium', 'standard', 'default', 'maxres']): string | null {
  if (!t) return null;
  for (const k of order) {
    const u = t[k]?.url;
    if (typeof u === 'string' && u) return u;
  }
  return null;
}

/** YouTube API error reason (`quotaExceeded`, `keyInvalid`, `forbidden`...) from an error body. */
function ytReason(f: HttpFailure): string | null {
  const b = f.body as { error?: { errors?: { reason?: string }[]; status?: string } } | null;
  const r = b?.error?.errors?.[0]?.reason ?? b?.error?.status ?? null;
  if (r) return r;
  const m = /\b(quotaExceeded|dailyLimitExceeded|rateLimitExceeded|keyInvalid|keyExpired|accessNotConfigured|forbidden)\b/.exec(failureText(f));
  return m ? m[1] : null;
}

const QUOTA_REASONS = new Set(['quotaExceeded', 'dailyLimitExceeded', 'rateLimitExceeded', 'userRateLimitExceeded', 'RESOURCE_EXHAUSTED']);

type Bucket = 'search' | 'standard';

/* ------------------------------------------------------------------ adapter */

export const youtubeDataApi: SourceAdapter = {
  id: ID,
  platform: 'youtube',
  label: 'YouTube Data API v3',
  requiresCredentials: true,
  envKeys: ENV_KEYS,
  metrics: ['views', 'likes', 'comments'],
  discovery:
    '키워드 시드로 search.list 검색(한국 지역 regionCode=KR, 관련 언어 relevanceLanguage=ko, 최근 7일 게시, 조회수순·최신순, 최대 50개) 후 videos.list로 통계를, channels.list로 구독자 수를 조회. 추적 중인 YouTube 영상(RSS로 찾은 영상 포함)도 videos.list로 재관측.',
  notes: [
    '할당량: search.list는 2026-06-01부터 별도 버킷(기본 하루 100회, 호출당 1)이며, videos.list·channels.list는 호출당 1단위(최대 50개 ID)로 하루 10,000단위를 공유한다. 이전 방식(search 1회=100단위)에서도 기본값(실행당 8회 × 하루 12회 실행 = 9,600단위)은 한도 안이다.',
    `실행당 검색 횟수는 YOUTUBE_SEARCHES_PER_RUN(기본 ${YOUTUBE_DEFAULT_SEARCHES_PER_RUN})으로 제한한다. 키워드×정렬(조회수순/최신순) 후보가 더 많으면 실행마다 순환하며 검색하므로 한 번의 실행이 모든 키워드를 다루지는 않는다. 하루 실행 횟수 × 검색 횟수가 100을 넘지 않게 설정해야 한다.`,
    '검색 결과는 YouTube 검색 순위(regionCode=KR은 한국에서 시청 가능한 영상 기준, 업로드 국가가 아님)이며 전체 모집단이 아니다.',
    '형식 추정: API에 쇼츠 여부 필드가 없다. 60초 이하는 쇼츠, 2024-10부터 쇼츠가 최대 3분이므로 61~180초는 제목·설명·태그에 #shorts가 있을 때만 쇼츠로, 그 외는 롱폼으로 분류한다. 라이브 중·예정이거나 라이브 스트리밍 기록이 있으면 라이브(프리미어 최초 공개 영상도 스트리밍 기록이 남아 라이브로 분류될 수 있다).',
    '좋아요 수를 숨긴 영상은 좋아요가 null(0 아님), 댓글이 꺼진 영상은 댓글 수가 null이다. 공유 수는 API가 제공하지 않는다.',
    '구독자 수는 YouTube가 3자리 유효숫자로 내림한 값이며, 채널이 구독자 수를 숨기면(hiddenSubscriberCount) null이다.',
    '조회수 정의 변경: 2025-03-31부터 Shorts는 재생·반복 재생 시작 횟수로, 2026-08-27부터 모든 형식(롱폼·라이브·Shorts)이 재생 시작 시점에 집계된다. 변경 전후 값을 비교할 때 주의.',
    '언어: defaultAudioLanguage → defaultLanguage 순(원천 제공 값). 국가: 채널 설정 국가(snippet.country)로 시청자 지역이 아니다.',
    '분류: categoryId를 youtube:category:<id>로 저장한다(예: 10 음악, 17 스포츠, 20 게임, 22 인물/블로그, 23 코미디, 24 엔터테인먼트, 25 뉴스/정치, 26 노하우/스타일, 27 교육, 28 과학기술).',
    '재관측 대상 영상이 videos.list 응답에서 빠지면 삭제로 표시한다(비공개 전환과 API상 구분 불가).',
  ],
  docsUrl: 'https://developers.google.com/youtube/v3/docs',
  version: 1,
  isEnabled: (env) => hasAllEnv(env, ENV_KEYS),
  collect: collectYoutube,
};

async function collectYoutube(ctx: CollectContext): Promise<CollectResult> {
  const result: CollectResult = { videos: [], accounts: [], errors: [], gone: [] };
  const key = envStr(ctx.env, 'YOUTUBE_API_KEY');
  if (!key) {
    result.errors.push(`${ID}: YOUTUBE_API_KEY is not set`);
    return result;
  }
  const budget = new RequestBudget(ctx.maxRequests);
  const blocked = new Set<Bucket>();
  const secrets = [key];

  const call = async <T>(bucket: Bucket, what: string, path: string, params: Record<string, string>): Promise<T | null> => {
    if (blocked.has(bucket)) return null;
    if (!budget.take()) {
      result.errors.push(`${ID}: request budget (${budget.max}) exhausted — skipped ${what}`);
      blocked.add('search');
      blocked.add('standard');
      return null;
    }
    const url = `${API}/${path}?${new URLSearchParams({ ...params, key }).toString()}`;
    try {
      return await ctx.http.getJson<T>(url, { headers: { Accept: 'application/json' } });
    } catch (err) {
      const f = describeHttpError(err, ctx.now);
      const reason = ytReason(f);
      const apiMsg = (f.body as { error?: { message?: string } } | null)?.error?.message;
      const text = typeof apiMsg === 'string' ? apiMsg.replace(/<[^>]*>/g, '') : f.message;
      result.errors.push(errorLine(ID, what, f, reason ? `${reason}: ${text}` : typeof apiMsg === 'string' ? text : null, secrets));
      if ((reason && QUOTA_REASONS.has(reason)) || f.status === 429) {
        // Quota buckets are separate since 2026-06-01: an exhausted search bucket does not stop videos.list.
        blocked.add(bucket);
      } else if (f.status === 400 && reason && /key/i.test(reason)) {
        blocked.add('search').add('standard');
      } else if (f.status === 401 || f.status === 403) {
        blocked.add('search').add('standard');
      }
      return null;
    }
  };

  /* 1. discovery */
  const perRun = envInt(ctx.env, 'YOUTUBE_SEARCHES_PER_RUN', YOUTUBE_DEFAULT_SEARCHES_PER_RUN, 0, YOUTUBE_QUOTA.searchCallsPerDay);
  const regionCode = (envStr(ctx.env, 'YOUTUBE_REGION_CODE') ?? 'KR').toUpperCase();
  const plan = planYoutubeSearches(ctx, perRun);
  const publishedAfter = rfc3339(ctx.now - YOUTUBE_SEARCH_LOOKBACK_DAYS * DAY_MS);
  const discovered = new Map<string, string>(); // videoId -> discoveredVia
  let searchCalls = 0;
  for (const item of plan) {
    const res = await call<YtSearchResponse>('search', `search.list q="${item.keyword}" order=${item.order}`, 'search', {
      part: 'snippet',
      type: 'video',
      order: item.order,
      regionCode,
      relevanceLanguage: item.relevanceLanguage,
      publishedAfter,
      q: item.keyword,
      maxResults: '50',
    });
    if (res === null) {
      if (blocked.has('search')) break;
      continue;
    }
    searchCalls++;
    for (const it of res.items ?? []) {
      const vid = it.id?.videoId;
      if ((it.id?.kind === undefined || it.id.kind === 'youtube#video') && typeof vid === 'string' && VIDEO_ID_RE.test(vid)) {
        if (!discovered.has(vid)) discovered.set(vid, `${ID}:search:${item.order}:${item.keyword}`);
      }
    }
  }

  /* 2. videos.list for discovered + refresh ids */
  const refresh = uniq((ctx.refreshIds ?? []).map((s) => String(s).trim()));
  const invalidRefresh = refresh.filter((id) => !VIDEO_ID_RE.test(id));
  if (invalidRefresh.length) {
    ctx.log.warn(`${ID}: ignoring ${invalidRefresh.length} refresh id(s) that are not YouTube video ids`);
  }
  const refreshSet = new Set(refresh.filter((id) => VIDEO_ID_RE.test(id)));
  const allIds = uniq([...discovered.keys(), ...refreshSet]);
  const fetched = new Map<string, YtVideo>();
  const batches = chunk(allIds, YOUTUBE_QUOTA.maxIdsPerCall);
  let skippedIds = 0;
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const res = await call<YtVideoListResponse>('standard', `videos.list (${batch.length} ids)`, 'videos', {
      part: 'snippet,statistics,contentDetails,liveStreamingDetails',
      id: batch.join(','),
    });
    if (res === null) {
      if (blocked.has('standard')) {
        skippedIds += batches.slice(i + 1).reduce((n, b) => n + b.length, 0);
        break;
      }
      continue;
    }
    const got = new Set<string>();
    for (const v of res.items ?? []) {
      if (typeof v.id === 'string') {
        fetched.set(v.id, v);
        got.add(v.id);
      }
    }
    // Only a successful response proves absence. Deleted and private videos are both simply omitted.
    for (const id of batch) {
      if (!got.has(id) && refreshSet.has(id)) result.gone!.push({ platformId: id, status: 'deleted' });
    }
  }
  if (skippedIds > 0) ctx.log.warn(`${ID}: ${skippedIds} video id(s) not fetched this run (quota/budget)`);

  /* 3. channels.list */
  const channelIds = uniq([...fetched.values()].map((v) => v.snippet?.channelId).filter((c): c is string => typeof c === 'string' && c !== ''));
  const channels = new Map<string, YtChannel>();
  for (const batch of chunk(channelIds, YOUTUBE_QUOTA.maxIdsPerCall)) {
    const res = await call<YtChannelListResponse>('standard', `channels.list (${batch.length} ids)`, 'channels', {
      part: 'snippet,statistics',
      id: batch.join(','),
    });
    if (res === null) {
      if (blocked.has('standard')) break;
      continue;
    }
    for (const c of res.items ?? []) if (typeof c.id === 'string') channels.set(c.id, c);
  }

  /* 4. map */
  for (const [id, v] of fetched) {
    const raw = youtubeToRawVideo(v, channels, discovered.get(id) ?? `${ID}:refresh`, ctx.now);
    if (raw) result.videos.push(raw);
    else result.errors.push(`${ID}: video ${id} skipped (missing snippet.publishedAt / channelId)`);
  }

  const q = estimateYoutubeQuota(searchCalls, allIds.length, channelIds.length);
  ctx.log.info(
    `${ID}: ${searchCalls} search call(s), ${fetched.size} video(s), ${channels.size} channel(s), ${result.gone!.length} gone; ` +
      `quota ≈ ${q.searchCalls} search + ${q.standardUnits} units (legacy ${q.legacyUnits}); ${budget.used} request(s)`,
  );
  return result;
}

export function youtubeAccount(channelId: string, fallbackTitle: string | null, c: YtChannel | undefined): RawAccount {
  const hidden = c?.statistics?.hiddenSubscriberCount === true;
  const custom = c?.snippet?.customUrl?.trim() || null;
  return {
    platform: 'youtube',
    platformId: channelId,
    handle: custom ? (custom.startsWith('@') ? custom : `@${custom}`) : null,
    name: c?.snippet?.title?.trim() || fallbackTitle || channelId,
    url: `https://www.youtube.com/channel/${channelId}`,
    avatar: bestThumb(c?.snippet?.thumbnails, ['default', 'medium', 'high']),
    country: c?.snippet?.country ? c.snippet.country.toUpperCase() : null,
    followers: hidden ? null : toCount(c?.statistics?.subscriberCount),
  };
}

export function youtubeToRawVideo(v: YtVideo, channels: Map<string, YtChannel>, discoveredVia: string, now: number): RawVideo | null {
  const sn = v.snippet;
  const id = v.id;
  const publishedAt = parseTime(sn?.publishedAt);
  const channelId = sn?.channelId;
  if (!id || !sn || publishedAt === null || !channelId) return null;
  const tags = Array.isArray(sn.tags) ? sn.tags.filter((t): t is string => typeof t === 'string') : [];
  const lbc = sn.liveBroadcastContent ?? 'none';
  const isLiveNow = lbc === 'live' || lbc === 'upcoming';
  let durationSec = parseIsoDuration(v.contentDetails?.duration);
  // Live / upcoming broadcasts report `P0D`: the length is not known yet.
  if (isLiveNow && (durationSec === null || durationSec === 0)) durationSec = null;
  const language = normLang(sn.defaultAudioLanguage) ?? normLang(sn.defaultLanguage);
  const account = youtubeAccount(channelId, sn.channelTitle ?? null, channels.get(channelId));
  const st = v.statistics;
  return {
    platform: 'youtube',
    platformId: id,
    url: `https://www.youtube.com/watch?v=${id}`,
    title: sn.title ?? '',
    description: descriptionOf(sn.description),
    thumbnail: bestThumb(sn.thumbnails),
    publishedAt,
    durationSec,
    format: youtubeFormat({
      durationSec,
      liveBroadcastContent: lbc,
      hasLiveStreamingDetails: !!v.liveStreamingDetails,
      title: sn.title,
      description: sn.description,
      tags,
    }),
    account,
    language,
    languageSource: language ? 'source' : null,
    country: account.country,
    sourceCategory: sn.categoryId ? `youtube:category:${sn.categoryId}` : null,
    tags,
    counters: {
      views: toCount(st?.viewCount),
      likes: toCount(st?.likeCount),
      comments: toCount(st?.commentCount),
      shares: null,
    },
    observedAt: now,
    status: 'active',
    discoveredVia,
  };
}
