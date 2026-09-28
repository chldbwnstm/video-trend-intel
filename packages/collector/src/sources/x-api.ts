/**
 * Source adapter: x-api (X API v2, app-only Bearer token).
 *
 * Docs
 * - recent search   https://docs.x.com/x-api/posts/search-recent-posts
 * - posts lookup    https://docs.x.com/x-api/posts/get-posts-by-ids
 * - query operators https://docs.x.com/x-api/posts/search/integrate/build-a-query
 * - metrics         https://docs.x.com/x-api/fundamentals/metrics
 * - rate limits     https://docs.x.com/x-api/fundamentals/rate-limits
 * - OpenAPI         https://api.x.com/2/openapi.json (v2.168: search/recent + lookup take `post.fields`,
 *                   PostPublicMetrics.repost_count; older payloads use `tweet.fields` / `retweet_count`)
 * - view counts     https://help.x.com/en/using-x/view-counts
 *
 * Flow per run
 * 1. For each keyword seed (≤ X_QUERIES_PER_RUN, rotating): GET https://api.x.com/2/tweets/search/recent
 *    query=`(<keyword>) has:videos -is:retweet lang:<seed language, default ko>`, max_results=100,
 *    sort_order=relevancy (X_SORT_ORDER=recency to switch),
 *    post.fields=created_at,public_metrics,lang,entities,attachments (+ author_id with legacy tweet.fields),
 *    expansions=author_id,attachments.media_keys, media.fields=duration_ms,preview_image_url,public_metrics,type,
 *    user.fields=username,name,public_metrics,profile_image_url; next_token pagination ≤ X_PAGES_PER_QUERY.
 * 2. Refresh: GET /2/tweets?ids=<≤100> with the same fields; `resource-not-found` → deleted,
 *    `not-authorized-for-resource` → private.
 * 429: the HttpClient already retried with backoff; a remaining 429 stops this run's X requests and the
 * reset time (x-rate-limit-reset) is reported.
 */
import type { VideoFormat, VideoStatus } from '@vti/core';
import type { CollectContext, CollectResult, RawAccount, RawVideo, SourceAdapter } from '../types.ts';
import {
  RequestBudget,
  chunk,
  describeHttpError,
  descriptionOf,
  envInt,
  envStr,
  errorLine,
  hasAllEnv,
  keywordSeeds,
  normLang,
  parseTime,
  rotatingSlice,
  titleFromText,
  toCount,
  uniq,
} from './keyed-util.ts';

const ID = 'x-api';
const ENV_KEYS = ['X_BEARER_TOKEN'];
export const X_API = 'https://api.x.com/2';
export const X_MAX_QUERY_LENGTH = 512; // self-serve recent search limit
export const X_POST_FIELDS = 'created_at,public_metrics,lang,entities,attachments';
export const X_EXPANSIONS = 'author_id,attachments.media_keys';
export const X_MEDIA_FIELDS = 'duration_ms,preview_image_url,public_metrics,type';
export const X_USER_FIELDS = 'username,name,public_metrics,profile_image_url';

const POST_ID_RE = /^\d{1,19}$/;

/* ------------------------------------------------------------------ response shapes */

export interface XPost {
  id?: string;
  text?: string;
  created_at?: string;
  author_id?: string;
  lang?: string;
  attachments?: { media_keys?: string[] };
  entities?: { hashtags?: { tag?: string }[] };
  public_metrics?: {
    retweet_count?: number;
    repost_count?: number;
    reply_count?: number;
    like_count?: number;
    quote_count?: number;
    bookmark_count?: number;
    impression_count?: number;
  };
}
export interface XMedia {
  media_key?: string;
  type?: string;
  duration_ms?: number;
  preview_image_url?: string;
  public_metrics?: { view_count?: number };
}
export interface XUser {
  id?: string;
  username?: string;
  name?: string;
  profile_image_url?: string;
  public_metrics?: { followers_count?: number };
}
interface XProblem {
  type?: string;
  title?: string;
  detail?: string;
  value?: string;
  resource_id?: string;
  resource_type?: string;
  parameter?: string;
}
export interface XPostsResponse {
  data?: XPost[];
  includes?: { users?: XUser[]; media?: XMedia[] };
  meta?: { result_count?: number; next_token?: string; newest_id?: string; oldest_id?: string };
  errors?: XProblem[];
}

/* ------------------------------------------------------------------ pure helpers */

/** `(<keyword>) has:videos -is:retweet lang:ko`; parentheses/quotes inside the keyword are stripped. */
export function buildXQuery(keyword: string, lang: string): string {
  const kw = keyword.replace(/[()"]/g, ' ').replace(/\s+/g, ' ').trim();
  return `(${kw}) has:videos -is:retweet lang:${lang}`;
}

/** Field query params; `fieldsParam` is `post.fields` (current spec) or legacy `tweet.fields`. */
export function xFieldParams(fieldsParam: 'post.fields' | 'tweet.fields'): Record<string, string> {
  return {
    [fieldsParam]: fieldsParam === 'tweet.fields' ? `${X_POST_FIELDS},author_id` : X_POST_FIELDS,
    expansions: X_EXPANSIONS,
    'media.fields': X_MEDIA_FIELDS,
    'user.fields': X_USER_FIELDS,
  };
}

export function xFormat(durationSec: number | null): VideoFormat {
  if (durationSec === null || durationSec <= 0) return 'unknown';
  return durationSec <= 60 ? 'short' : 'long';
}

/** shares = reposts (repost_count, legacy retweet_count) + quotes; null when reposts are not provided. */
export function xShares(pm: XPost['public_metrics']): number | null {
  const reposts = toCount(pm?.repost_count ?? pm?.retweet_count);
  if (reposts === null) return null;
  const quotes = toCount(pm?.quote_count);
  return reposts + (quotes ?? 0);
}

/** Maps one post + its expansions to a RawVideo; null when the post has no native video attached or no author. */
export function xToRawVideo(
  post: XPost,
  users: Map<string, XUser>,
  media: Map<string, XMedia>,
  discoveredVia: string,
  now: number,
): RawVideo | null {
  const id = post.id;
  const authorId = post.author_id;
  const publishedAt = parseTime(post.created_at);
  if (!id || !authorId || publishedAt === null) return null;
  const video = (post.attachments?.media_keys ?? []).map((k) => media.get(k)).find((m) => m?.type === 'video');
  if (!video) return null;
  const user = users.get(authorId);
  const username = user?.username ?? null;
  const account: RawAccount = {
    platform: 'x',
    platformId: authorId,
    handle: username ? `@${username}` : null,
    name: user?.name?.trim() || username || authorId,
    url: username ? `https://x.com/${username}` : `https://x.com/i/user/${authorId}`,
    avatar: user?.profile_image_url || null,
    country: null,
    followers: toCount(user?.public_metrics?.followers_count),
  };
  const durationSec = typeof video.duration_ms === 'number' && video.duration_ms > 0 ? Math.round(video.duration_ms / 1000) : null;
  const pm = post.public_metrics;
  const language = normLang(post.lang);
  const tags = uniq((post.entities?.hashtags ?? []).map((h) => (typeof h.tag === 'string' ? h.tag.toLowerCase() : '')).filter(Boolean));
  const text = post.text ?? '';
  return {
    platform: 'x',
    platformId: id,
    url: username ? `https://x.com/${username}/status/${id}` : `https://x.com/i/status/${id}`,
    title: titleFromText(text),
    description: descriptionOf(text),
    thumbnail: video.preview_image_url || null,
    publishedAt,
    durationSec,
    format: xFormat(durationSec),
    account,
    language,
    languageSource: language ? 'source' : null,
    country: null,
    sourceCategory: null,
    tags,
    counters: {
      // X "views" = impressions of the post (non-unique, includes the author), not video plays.
      views: toCount(pm?.impression_count),
      likes: toCount(pm?.like_count),
      comments: toCount(pm?.reply_count),
      shares: xShares(pm),
    },
    observedAt: now,
    status: 'active',
    discoveredVia,
  };
}

/** Status for a lookup problem: resource-not-found → deleted, not-authorized-for-resource → private. */
export function xProblemStatus(p: XProblem): VideoStatus | null {
  const t = p.type ?? '';
  if (t.endsWith('/resource-not-found')) return 'deleted';
  if (t.endsWith('/not-authorized-for-resource')) return 'private';
  return null;
}

/* ------------------------------------------------------------------ adapter */

export const xApi: SourceAdapter = {
  id: ID,
  platform: 'x',
  label: 'X API v2',
  requiresCredentials: true,
  envKeys: ENV_KEYS,
  metrics: ['views', 'likes', 'comments', 'shares'],
  discovery:
    'X API v2 최근 검색(최근 7일): 키워드 시드로 "(키워드) has:videos -is:retweet lang:ko" 조건의 동영상 게시물을 조회(요청당 최대 100개). 추적 중인 게시물은 ID 조회로 재관측.',
  notes: [
    'X의 조회수(views)는 게시물 노출 수(impression_count)다. 같은 사용자의 반복 열람과 작성자 본인 열람이 포함되며, 고유 시청자 수나 동영상 재생 수가 아니다. 다른 플랫폼 조회수와 같은 단위로 합산하면 안 된다.',
    '동영상 미디어의 view_count는 같은 동영상을 담은 모든 게시물의 합산값이라 게시물 단위 지표로 쓰지 않는다.',
    '댓글 = reply_count(답글), 공유 = repost_count(리포스트) + quote_count(인용). 북마크 수는 저장하지 않는다.',
    '검색 대상은 최근 7일 게시물이며 X 검색 색인 기준(전체 게시물의 표본이 아님, 관련도순). 언어는 X가 판별한 lang 값이다. 국가 정보는 없다.',
    '요금·한도: X API는 요청 빈도 한도(최근 검색 앱 기준 15분당 450회)와 별도로 읽은 게시물 수 기준으로 과금될 수 있다. X_QUERIES_PER_RUN(기본 5) × X_PAGES_PER_QUERY(기본 1) × 100개가 실행당 최대 읽기량이다.',
    '429(한도 초과)가 재시도 후에도 계속되면 이번 실행의 나머지 X 요청을 중단하고 초기화 시각(x-rate-limit-reset)을 오류에 기록한다.',
    '재관측(ID 조회)에서 찾을 수 없는 게시물은 삭제, 권한 없음(비공개 계정 전환 등)은 비공개로 표시한다.',
  ],
  docsUrl: 'https://docs.x.com/x-api/posts/search-recent-posts',
  version: 1,
  isEnabled: (env) => hasAllEnv(env, ENV_KEYS),
  collect: collectX,
};

async function collectX(ctx: CollectContext): Promise<CollectResult> {
  const result: CollectResult = { videos: [], accounts: [], errors: [], gone: [] };
  const bearer = envStr(ctx.env, 'X_BEARER_TOKEN');
  if (!bearer) {
    result.errors.push(`${ID}: X_BEARER_TOKEN is not set`);
    return result;
  }
  const fieldsParam = envStr(ctx.env, 'X_FIELDS_PARAM') === 'tweet.fields' ? 'tweet.fields' : 'post.fields';
  const headers = { Authorization: `Bearer ${bearer}`, Accept: 'application/json' };
  const secrets = [bearer];
  const budget = new RequestBudget(ctx.maxRequests);
  let stopped = false;
  const byId = new Map<string, RawVideo>();
  let nonVideo = 0;

  const get = async (what: string, url: string): Promise<XPostsResponse | null> => {
    if (stopped) return null;
    if (!budget.take()) {
      result.errors.push(`${ID}: request budget (${budget.max}) exhausted — skipped ${what}`);
      stopped = true;
      return null;
    }
    try {
      return await ctx.http.getJson<XPostsResponse>(url, { headers });
    } catch (err) {
      const f = describeHttpError(err, ctx.now);
      const b = f.body as { title?: string; detail?: string; errors?: { message?: string }[] } | null;
      const detail = b?.detail ?? b?.title ?? b?.errors?.[0]?.message ?? null;
      result.errors.push(errorLine(ID, what, f, detail, secrets));
      // 401 bad token, 403 endpoint not in access level / client not enrolled, 429 rate limit: stop the run.
      if (f.status === 401 || f.status === 403 || f.status === 429) stopped = true;
      return null;
    }
  };

  const ingest = (res: XPostsResponse, via: string) => {
    const users = new Map((res.includes?.users ?? []).filter((u) => u.id).map((u) => [u.id!, u]));
    const media = new Map((res.includes?.media ?? []).filter((m) => m.media_key).map((m) => [m.media_key!, m]));
    for (const post of res.data ?? []) {
      const raw = xToRawVideo(post, users, media, via, ctx.now);
      if (!raw) {
        nonVideo++;
        continue;
      }
      const prev = byId.get(raw.platformId);
      byId.set(raw.platformId, prev ? { ...raw, discoveredVia: prev.discoveredVia } : raw);
    }
  };

  /* 1. recent search */
  const perRun = envInt(ctx.env, 'X_QUERIES_PER_RUN', 5, 0, 450);
  const pages = envInt(ctx.env, 'X_PAGES_PER_QUERY', 1, 1, 10);
  const maxResults = envInt(ctx.env, 'X_MAX_RESULTS', 100, 10, 100);
  const sortOrder = envStr(ctx.env, 'X_SORT_ORDER') === 'recency' ? 'recency' : 'relevancy';
  const seeds = rotatingSlice(keywordSeeds(ctx), perRun, ctx.now);
  for (const s of seeds) {
    if (stopped) break;
    const query = buildXQuery(s.keyword, normLang(s.language) ?? 'ko');
    if (query.length > X_MAX_QUERY_LENGTH) {
      result.errors.push(`${ID}: query for "${s.keyword}" exceeds ${X_MAX_QUERY_LENGTH} characters — skipped`);
      continue;
    }
    let nextToken: string | null = null;
    for (let page = 0; page < pages && !stopped; page++) {
      const params = new URLSearchParams({
        query,
        max_results: String(maxResults),
        sort_order: sortOrder,
        ...xFieldParams(fieldsParam),
        ...(nextToken ? { next_token: nextToken } : {}),
      });
      const res = await get(`recent search "${s.keyword}"${page ? ` page ${page + 1}` : ''}`, `${X_API}/tweets/search/recent?${params.toString()}`);
      if (!res) break;
      ingest(res, `${ID}:search:${s.keyword}`);
      nextToken = res.meta?.next_token ?? null;
      if (!nextToken) break;
    }
  }

  /* 2. refresh by id */
  const refresh = uniq((ctx.refreshIds ?? []).map((s) => String(s).trim())).filter((id) => POST_ID_RE.test(id) && !byId.has(id));
  for (const batch of chunk(refresh, 100)) {
    if (stopped) break;
    const params = new URLSearchParams({ ids: batch.join(','), ...xFieldParams(fieldsParam) });
    const res = await get(`posts lookup (${batch.length} ids)`, `${X_API}/tweets?${params.toString()}`);
    if (!res) continue;
    ingest(res, `${ID}:refresh`);
    const returned = new Set((res.data ?? []).map((p) => p.id));
    for (const p of res.errors ?? []) {
      const pid = p.resource_id ?? p.value;
      const status = xProblemStatus(p);
      if (pid && status && batch.includes(pid) && !returned.has(pid)) result.gone!.push({ platformId: pid, status });
    }
  }

  if (nonVideo > 0) ctx.log.info(`${ID}: ${nonVideo} post(s) skipped (no attached native video / author)`);
  result.videos = [...byId.values()];
  ctx.log.info(`${ID}: ${result.videos.length} video post(s), ${result.gone!.length} gone, ${budget.used} request(s)`);
  return result;
}
