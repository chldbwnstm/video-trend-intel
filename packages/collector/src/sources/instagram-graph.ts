/**
 * Source adapter: instagram-graph (Instagram API with Facebook Login / Graph API).
 *
 * Docs
 * - business discovery  https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/business_discovery
 * - hashtag search      https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-hashtag-search
 * - hashtag top media   https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-hashtag/top-media
 * - hashtag recent      https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-hashtag/recent-media
 * - IG media fields     https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-media
 * - versions            https://developers.facebook.com/docs/graph-api/changelog (v26.0 released 2026-07-29)
 *
 * Flow per run (IG_USER_ID = our own IG professional account that performs the queries)
 * 1. For each IG_BUSINESS_USERNAMES entry: GET /{IG_USER_ID}?fields=business_discovery.username(u){id,username,name,
 *    profile_picture_url,followers_count,media_count,media.limit(50){id,caption,media_type,media_product_type,
 *    like_count,comments_count,view_count,timestamp,permalink,thumbnail_url,media_url}} → keep VIDEO / REELS.
 *    Further media pages (`media.after(cursor)`) up to IG_MEDIA_PAGES (default 1).
 * 2. For each IG_HASHTAGS entry (≤ 30): GET /ig_hashtag_search?user_id=&q= → id, then
 *    GET /{hashtag-id}/top_media and /recent_media (user_id, fields, limit=50) → keep VIDEO.
 *    Limit: 30 unique hashtags per rolling 7 days per IG account. Hashtag media do not expose the owner.
 *
 * The token is sent as `Authorization: Bearer` (never in the URL).
 */
import type { VideoFormat } from '@vti/core';
import type { CollectContext, CollectResult, RawAccount, RawVideo, SourceAdapter } from '../types.ts';
import {
  RequestBudget,
  describeHttpError,
  descriptionOf,
  envInt,
  envList,
  envStr,
  errorLine,
  hasAllEnv,
  hashtagsFromText,
  parseTime,
  titleFromText,
  toCount,
  type HttpFailure,
} from './keyed-util.ts';

const ID = 'instagram-graph';
const ENV_KEYS = ['IG_ACCESS_TOKEN', 'IG_USER_ID'];
export const IG_GRAPH_VERSION = 'v26.0';
export const IG_HASHTAG_WEEKLY_LIMIT = 30;
export const IG_MEDIA_PAGE_SIZE = 50;

export const IG_ACCOUNT_FIELDS = 'id,username,name,profile_picture_url,followers_count,media_count';
export const IG_BD_MEDIA_FIELDS =
  'id,caption,media_type,media_product_type,like_count,comments_count,view_count,timestamp,permalink,thumbnail_url,media_url';
/** Fields documented for hashtag top_media / recent_media (username, owner, thumbnail_url, view_count are not). */
export const IG_HASHTAG_MEDIA_FIELDS = 'id,caption,media_type,comments_count,like_count,permalink,timestamp,media_url';

/** Placeholder owner for hashtag media: the Graph API does not reveal who posted them. */
export const IG_UNATTRIBUTED_ACCOUNT_ID = '_unattributed';

const USERNAME_RE = /^[A-Za-z0-9._]{1,30}$/;

/* ------------------------------------------------------------------ response shapes */

export interface IgMedia {
  id?: string;
  caption?: string;
  media_type?: string;
  media_product_type?: string;
  like_count?: number;
  comments_count?: number;
  view_count?: number;
  timestamp?: string;
  permalink?: string;
  thumbnail_url?: string;
  media_url?: string;
}
interface IgPaging {
  cursors?: { before?: string; after?: string };
  next?: string;
}
interface IgBusinessDiscoveryResponse {
  business_discovery?: {
    id?: string;
    username?: string;
    name?: string;
    profile_picture_url?: string;
    followers_count?: number;
    media_count?: number;
    media?: { data?: IgMedia[]; paging?: IgPaging };
  };
  id?: string;
}
interface IgHashtagSearchResponse {
  data?: { id?: string }[];
}
interface IgMediaListResponse {
  data?: IgMedia[];
  paging?: IgPaging;
}
interface IgGraphError {
  error?: { message?: string; type?: string; code?: number; error_subcode?: number; fbtrace_id?: string };
}

/* ------------------------------------------------------------------ pure helpers */

/** Keep videos: VIDEO media (feed videos / Reels) or Reels product type. Albums, images, stories, ads are dropped. */
export function isIgVideo(m: IgMedia): boolean {
  if (m.media_product_type === 'STORY' || m.media_product_type === 'AD') return false;
  return m.media_type === 'VIDEO' || m.media_product_type === 'REELS';
}

/** Reels are Instagram's short-form surface; other videos have no duration in the API → unknown. */
export function igFormat(m: IgMedia): VideoFormat {
  return m.media_product_type === 'REELS' ? 'short' : 'unknown';
}

export function igBusinessDiscoveryFields(username: string, after: string | null, limit = IG_MEDIA_PAGE_SIZE): string {
  const media = `media${after ? `.after(${after})` : ''}.limit(${limit}){${IG_BD_MEDIA_FIELDS}}`;
  return `business_discovery.username(${username}){${IG_ACCOUNT_FIELDS},${media}}`;
}

function graphError(f: HttpFailure): { code: number | null; subcode: number | null; message: string | null } {
  const e = (f.body as IgGraphError | null)?.error;
  return { code: typeof e?.code === 'number' ? e.code : null, subcode: typeof e?.error_subcode === 'number' ? e.error_subcode : null, message: e?.message ?? null };
}

/** Graph error codes: 190 token invalid/expired; 4/17/32/613/80002 rate limits; 10 / 200-299 permission. */
function isFatalGraphError(status: number | null, code: number | null): 'token' | 'rate' | 'permission' | null {
  if (code === 190 || status === 401) return 'token';
  if (code === 4 || code === 17 || code === 32 || code === 613 || (code !== null && code >= 80001 && code <= 80014) || status === 429) return 'rate';
  if (code === 10 || (code !== null && code >= 200 && code <= 299)) return 'permission';
  return null;
}

function unattributedAccount(): RawAccount {
  return {
    platform: 'instagram',
    platformId: IG_UNATTRIBUTED_ACCOUNT_ID,
    handle: null,
    name: 'Instagram 해시태그 검색(작성자 미제공)',
    url: 'https://www.instagram.com/',
    avatar: null,
    country: null,
    followers: null,
  };
}

export function igToRawVideo(m: IgMedia, account: RawAccount, discoveredVia: string, now: number, viewsAvailable: boolean): RawVideo | null {
  const publishedAt = parseTime(m.timestamp);
  if (!m.id || publishedAt === null) return null;
  const caption = typeof m.caption === 'string' ? m.caption : '';
  return {
    platform: 'instagram',
    platformId: m.id,
    url: m.permalink || `https://www.instagram.com/`,
    title: titleFromText(caption),
    description: descriptionOf(caption),
    thumbnail: m.thumbnail_url || null,
    publishedAt,
    durationSec: null,
    format: igFormat(m),
    account,
    language: null,
    languageSource: null,
    country: null,
    sourceCategory: null,
    tags: hashtagsFromText(caption),
    counters: {
      // view_count exists for Reels via Business Discovery only; absent → null (not zero).
      views: viewsAvailable ? toCount(m.view_count) : null,
      // like_count is omitted when the owner hides like counts → null.
      likes: toCount(m.like_count),
      comments: toCount(m.comments_count),
      shares: null,
    },
    observedAt: now,
    status: 'active',
    discoveredVia,
  };
}

/* ------------------------------------------------------------------ adapter */

export const instagramGraph: SourceAdapter = {
  id: ID,
  platform: 'instagram',
  label: 'Instagram Graph API',
  requiresCredentials: true,
  envKeys: ENV_KEYS,
  metrics: ['views', 'likes', 'comments'],
  discovery:
    '비즈니스·크리에이터 계정 시드(IG_BUSINESS_USERNAMES)를 business_discovery로 조회해 최근 게시물 중 동영상·릴스를 수집하고, 해시태그 시드(IG_HASHTAGS)는 ig_hashtag_search → 인기(top_media)·최신(recent_media) 게시물 중 동영상을 수집.',
  notes: [
    '조회수는 business_discovery로 받은 릴스의 view_count(유료+오가닉 합산, 페이스북 교차 게시 시 합산)만 제공되며, 그 외(해시태그 검색 결과, 일반 동영상)는 null이다(0 아님).',
    '좋아요 수를 숨긴 게시물은 like_count가 응답에서 빠지므로 좋아요가 null이다. 공유·저장 수는 타 계정 게시물에 제공되지 않는다.',
    `해시태그 검색은 IG 계정당 7일 동안 고유 해시태그 ${IG_HASHTAG_WEEKLY_LIMIT}개까지 가능하다. IG_HASHTAGS는 앞에서부터 ${IG_HASHTAG_WEEKLY_LIMIT}개만 사용하며, 7일 안에 목록을 바꾸면 한도를 넘을 수 있다.`,
    `해시태그 결과는 작성자(username)를 제공하지 않아 '${IG_UNATTRIBUTED_ACCOUNT_ID}'(작성자 미제공) 계정으로 묶는다. 같은 게시물이 시드 계정의 business_discovery에도 나오면 그 계정으로 연결한다.`,
    '영상 길이·언어·국가는 API가 제공하지 않는다. 릴스는 숏폼으로, 그 외 동영상은 형식 미상으로 표시한다. 캐러셀(여러 장) 게시물 속 동영상은 제외한다.',
    '연령 제한 계정은 business_discovery 결과가 없다. 재관측은 시드 계정의 최근 게시물(IG_MEDIA_PAGES × 50개) 범위에서만 이뤄지며, 삭제 여부는 판단하지 않는다.',
    `Graph API ${IG_GRAPH_VERSION} 사용(IG_GRAPH_API_VERSION으로 변경 가능). 호출 한도는 앱·계정별 사용량(BUC) 기준이며 초과 시 이번 실행의 나머지 요청을 중단한다.`,
  ],
  docsUrl: 'https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/business_discovery',
  version: 1,
  isEnabled: (env) => hasAllEnv(env, ENV_KEYS),
  collect: collectInstagram,
};

async function collectInstagram(ctx: CollectContext): Promise<CollectResult> {
  const result: CollectResult = { videos: [], accounts: [], errors: [], gone: [] };
  const token = envStr(ctx.env, 'IG_ACCESS_TOKEN');
  const userId = envStr(ctx.env, 'IG_USER_ID');
  if (!token || !userId) {
    result.errors.push(`${ID}: IG_ACCESS_TOKEN / IG_USER_ID are not set`);
    return result;
  }
  if (!/^\d+$/.test(userId)) {
    result.errors.push(`${ID}: IG_USER_ID must be the numeric Instagram professional account id`);
    return result;
  }
  const version = envStr(ctx.env, 'IG_GRAPH_API_VERSION') ?? IG_GRAPH_VERSION;
  const base = `https://graph.facebook.com/${/^v\d+\.\d+$/.test(version) ? version : IG_GRAPH_VERSION}`;
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  const secrets = [token];
  const budget = new RequestBudget(ctx.maxRequests);
  let stopped = false;
  /** Set when the token lacks a permission/feature (code 10, 200-299): the current phase cannot succeed. */
  let permissionDenied = false;

  const get = async <T>(what: string, url: string): Promise<T | null> => {
    if (stopped) return null;
    if (!budget.take()) {
      result.errors.push(`${ID}: request budget (${budget.max}) exhausted — skipped ${what}`);
      stopped = true;
      return null;
    }
    try {
      return await ctx.http.getJson<T>(url, { headers });
    } catch (err) {
      const f = describeHttpError(err, ctx.now);
      const g = graphError(f);
      const detail = g.message ? `${g.code !== null ? `code ${g.code}${g.subcode !== null ? `/${g.subcode}` : ''}: ` : ''}${g.message}` : null;
      result.errors.push(errorLine(ID, what, f, detail, secrets));
      const fatal = isFatalGraphError(f.status, g.code);
      if (fatal === 'token' || fatal === 'rate') stopped = true;
      if (fatal === 'permission') permissionDenied = true;
      return null;
    }
  };

  const byId = new Map<string, RawVideo>();

  /* 1. business discovery */
  const usernames = envList(ctx.env, 'IG_BUSINESS_USERNAMES').map((u) => u.replace(/^@/, ''));
  const pages = envInt(ctx.env, 'IG_MEDIA_PAGES', 1, 1, 20);
  for (const username of usernames) {
    if (stopped || permissionDenied) break;
    if (!USERNAME_RE.test(username)) {
      result.errors.push(`${ID}: invalid Instagram username "${username}" skipped`);
      continue;
    }
    let after: string | null = null;
    let account: RawAccount | null = null;
    let videosOfAccount = 0;
    for (let page = 0; page < pages && !stopped; page++) {
      const url: string = `${base}/${userId}?${new URLSearchParams({ fields: igBusinessDiscoveryFields(username, after) }).toString()}`;
      const res: IgBusinessDiscoveryResponse | null = await get<IgBusinessDiscoveryResponse>(
        `business_discovery @${username}${page ? ` page ${page + 1}` : ''}`,
        url,
      );
      const bd = res?.business_discovery;
      if (!bd) {
        if (res) result.errors.push(`${ID}: business_discovery @${username} returned no account (not a business/creator account, or age-gated)`);
        break;
      }
      if (!account) {
        const handle = bd.username ?? username;
        account = {
          platform: 'instagram',
          platformId: bd.id ?? handle,
          handle: `@${handle}`,
          name: bd.name?.trim() || handle,
          url: `https://www.instagram.com/${handle}/`,
          avatar: bd.profile_picture_url || null,
          country: null,
          followers: toCount(bd.followers_count),
        };
      }
      for (const m of bd.media?.data ?? []) {
        if (!isIgVideo(m)) continue;
        const raw = igToRawVideo(m, account, `${ID}:business-discovery:${username}`, ctx.now, true);
        if (!raw) continue;
        videosOfAccount++;
        byId.set(raw.platformId, raw);
      }
      after = bd.media?.paging?.cursors?.after ?? null;
      if (!after || !(bd.media?.data?.length)) break;
    }
    // Follower count is still an observation even when no recent post is a video.
    if (account && videosOfAccount === 0) result.accounts.push(account);
  }
  permissionDenied = false; // hashtag search is a separate feature (Instagram Public Content Access)

  /* 2. hashtags */
  const allTags = envList(ctx.env, 'IG_HASHTAGS').map((t) => t.replace(/^#/, '').trim().toLowerCase()).filter(Boolean);
  const tags = [...new Set(allTags)];
  if (tags.length > IG_HASHTAG_WEEKLY_LIMIT) {
    result.errors.push(
      `${ID}: IG_HASHTAGS has ${tags.length} hashtags; only the first ${IG_HASHTAG_WEEKLY_LIMIT} are queried (30 unique hashtags per 7 days limit) — skipped: ${tags.slice(IG_HASHTAG_WEEKLY_LIMIT).join(', ')}`,
    );
  }
  for (const tag of tags.slice(0, IG_HASHTAG_WEEKLY_LIMIT)) {
    if (stopped || permissionDenied) break;
    const search = await get<IgHashtagSearchResponse>(
      `ig_hashtag_search #${tag}`,
      `${base}/ig_hashtag_search?${new URLSearchParams({ user_id: userId, q: tag }).toString()}`,
    );
    const hashtagId = search?.data?.[0]?.id;
    if (!hashtagId) {
      if (search) result.errors.push(`${ID}: hashtag #${tag} not found`);
      continue;
    }
    for (const edge of ['top_media', 'recent_media'] as const) {
      if (stopped) break;
      const list = await get<IgMediaListResponse>(
        `${edge} #${tag}`,
        `${base}/${hashtagId}/${edge}?${new URLSearchParams({ user_id: userId, fields: IG_HASHTAG_MEDIA_FIELDS, limit: String(IG_MEDIA_PAGE_SIZE) }).toString()}`,
      );
      for (const m of list?.data ?? []) {
        if (!isIgVideo(m) || !m.id) continue;
        // Already seen via business_discovery (owner + views known) or via another hashtag: keep that record.
        if (byId.has(m.id)) continue;
        const raw = igToRawVideo(m, unattributedAccount(), `${ID}:hashtag:${edge === 'top_media' ? 'top' : 'recent'}:${tag}`, ctx.now, false);
        if (raw) byId.set(raw.platformId, raw);
      }
    }
  }

  if (usernames.length === 0 && tags.length === 0) {
    result.errors.push(`${ID}: nothing to collect — set IG_BUSINESS_USERNAMES and/or IG_HASHTAGS`);
  }
  result.videos = [...byId.values()];
  ctx.log.info(`${ID}: ${result.videos.length} video(s) from ${budget.used} request(s)`);
  return result;
}
