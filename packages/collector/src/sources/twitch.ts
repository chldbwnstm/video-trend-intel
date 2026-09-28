/**
 * Source adapter: twitch (Twitch Helix API, app access token).
 *
 * Docs
 * - app token        https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/#client-credentials-grant-flow
 * - Get Top Games    https://dev.twitch.tv/docs/api/reference/#get-top-games
 * - Get Videos       https://dev.twitch.tv/docs/api/reference/#get-videos
 * - Get Clips        https://dev.twitch.tv/docs/api/reference/#get-clips
 * - Get Users        https://dev.twitch.tv/docs/api/reference/#get-users
 * - Channel Followers https://dev.twitch.tv/docs/api/reference/#get-channel-followers
 * - rate limits      https://dev.twitch.tv/docs/api/guide/#twitch-rate-limits
 *
 * Flow per run
 * 1. POST https://id.twitch.tv/oauth2/token (form: client_id, client_secret, grant_type=client_credentials)
 *    → app token (cached in-process until expiry; refreshed once on 401).
 * 2. GET /helix/games/top?first=TWITCH_TOP_GAMES (default 5).
 * 3. Per game: GET /helix/videos?game_id=&sort=views&period=week&language=<TWITCH_LANGUAGE, default ko>&first=100
 *    (game_id queries cannot paginate — `after` is only valid with user_id) and
 *    GET /helix/clips?game_id=&started_at=now-7d&ended_at=now&first=100 (clips have no language filter →
 *    filtered client-side by broadcaster language), `after` pagination ≤ TWITCH_CLIP_PAGES.
 * 4. Refresh: numeric ids → /helix/videos?id=..(≤100), other ids (clip slugs) → /helix/clips?id=..(≤100);
 *    ids missing from a successful response are gone (videos: 404 when none of the ids exist).
 * 5. Accounts: /helix/users?id=..(≤100) for login/avatar. Follower totals need a *user* access token
 *    (TWITCH_USER_TOKEN, optional) for /helix/channels/followers; with only the app token followers are null.
 * Headers on every Helix call: `Authorization: Bearer <token>` + `Client-Id: <TWITCH_CLIENT_ID>`.
 */
import type { VideoFormat } from '@vti/core';
import type { CollectContext, CollectResult, RawAccount, RawVideo, SourceAdapter } from '../types.ts';
import {
  DAY_MS,
  RequestBudget,
  TokenCache,
  chunk,
  describeHttpError,
  descriptionOf,
  envInt,
  envStr,
  errorLine,
  formEncode,
  hasAllEnv,
  normLang,
  parseTime,
  rfc3339,
  toCount,
  uniq,
  type HttpFailure,
} from './keyed-util.ts';

const ID = 'twitch';
const ENV_KEYS = ['TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET'];
export const TWITCH_TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
export const HELIX = 'https://api.twitch.tv/helix';
export const TWITCH_THUMB_W = 320;
export const TWITCH_THUMB_H = 180;

const tokens = new TokenCache();
/** Test hook: forget cached app tokens. */
export function resetTwitchTokenCache(): void {
  tokens.clear();
}

/* ------------------------------------------------------------------ response shapes */

export interface TwitchVideo {
  id?: string;
  stream_id?: string | null;
  user_id?: string;
  user_login?: string;
  user_name?: string;
  title?: string;
  description?: string;
  created_at?: string;
  published_at?: string;
  url?: string;
  thumbnail_url?: string;
  viewable?: string;
  view_count?: number;
  language?: string;
  type?: string;
  duration?: string;
}
export interface TwitchClip {
  id?: string;
  url?: string;
  broadcaster_id?: string;
  broadcaster_name?: string;
  creator_id?: string;
  creator_name?: string;
  video_id?: string;
  game_id?: string;
  language?: string;
  title?: string;
  view_count?: number;
  created_at?: string;
  thumbnail_url?: string;
  duration?: number;
  vod_offset?: number | null;
  is_featured?: boolean;
}
export interface TwitchUser {
  id?: string;
  login?: string;
  display_name?: string;
  profile_image_url?: string;
}
interface TwitchPage<T> {
  data?: T[];
  pagination?: { cursor?: string };
  total?: number;
}
interface TwitchTokenResponse {
  access_token?: string;
  expires_in?: number;
  token_type?: string;
  status?: number;
  message?: string;
}

/* ------------------------------------------------------------------ pure helpers */

/** Twitch VOD duration `1h2m3s` / `3m21s` / `45s` → seconds, null if unparseable. */
export function parseTwitchDuration(s: unknown): number | null {
  if (typeof s !== 'string') return null;
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(s.trim());
  if (!m || s.trim() === '') return null;
  const [h, min, sec] = m.slice(1).map((x) => (x === undefined ? 0 : Number(x)));
  return h * 3600 + min * 60 + sec;
}

/** `%{width}x%{height}` / `{width}x{height}` placeholders → 320x180 (the only size the API allows for VODs). */
export function twitchThumb(url: unknown): string | null {
  if (typeof url !== 'string' || url.trim() === '') return null;
  return url
    .replace(/%\{width\}/g, String(TWITCH_THUMB_W))
    .replace(/%\{height\}/g, String(TWITCH_THUMB_H))
    .replace(/\{width\}/g, String(TWITCH_THUMB_W))
    .replace(/\{height\}/g, String(TWITCH_THUMB_H));
}

/** archive (past broadcast VOD) → live; highlight/upload by length; clips are always short. */
export function twitchVideoFormat(type: string | undefined, durationSec: number | null): VideoFormat {
  if (type === 'archive') return 'live';
  if (durationSec === null || durationSec <= 0) return 'unknown';
  return durationSec <= 60 ? 'short' : 'long';
}

function accountFrom(userId: string, login: string | null, displayName: string | null, users: Map<string, TwitchUser>, followers: Map<string, number>): RawAccount {
  const u = users.get(userId);
  // Clips only carry the display name; for ASCII names the login is the lower-cased display name.
  const guessedLogin = !login && displayName && /^[A-Za-z0-9_]+$/.test(displayName) ? displayName.toLowerCase() : null;
  const handle = u?.login ?? login ?? guessedLogin;
  return {
    platform: 'twitch',
    platformId: userId,
    handle,
    name: u?.display_name?.trim() || displayName?.trim() || handle || userId,
    url: handle ? `https://www.twitch.tv/${handle}` : 'https://www.twitch.tv/',
    avatar: u?.profile_image_url || null,
    country: null,
    followers: followers.get(userId) ?? null,
  };
}

export function twitchVideoToRaw(
  v: TwitchVideo,
  users: Map<string, TwitchUser>,
  followers: Map<string, number>,
  gameName: string | null,
  discoveredVia: string,
  now: number,
): RawVideo | null {
  const publishedAt = parseTime(v.published_at) ?? parseTime(v.created_at);
  if (!v.id || !v.user_id || publishedAt === null) return null;
  const durationSec = parseTwitchDuration(v.duration);
  const language = normLang(v.language);
  return {
    platform: 'twitch',
    platformId: v.id,
    url: v.url || `https://www.twitch.tv/videos/${v.id}`,
    title: v.title ?? '',
    description: descriptionOf(v.description),
    thumbnail: twitchThumb(v.thumbnail_url),
    publishedAt,
    durationSec,
    format: twitchVideoFormat(v.type, durationSec),
    account: accountFrom(v.user_id, v.user_login ?? null, v.user_name ?? null, users, followers),
    language,
    languageSource: language ? 'source' : null,
    country: null,
    sourceCategory: gameName ? `twitch:game:${gameName}` : null,
    tags: [],
    counters: { views: toCount(v.view_count), likes: null, comments: null, shares: null },
    observedAt: now,
    status: 'active',
    discoveredVia,
  };
}

export function twitchClipToRaw(
  c: TwitchClip,
  users: Map<string, TwitchUser>,
  followers: Map<string, number>,
  gameName: string | null,
  discoveredVia: string,
  now: number,
): RawVideo | null {
  const publishedAt = parseTime(c.created_at);
  if (!c.id || !c.broadcaster_id || publishedAt === null) return null;
  const durationSec = typeof c.duration === 'number' && c.duration > 0 ? Math.round(c.duration) : null;
  const language = normLang(c.language);
  return {
    platform: 'twitch',
    platformId: c.id,
    url: c.url || `https://clips.twitch.tv/${c.id}`,
    title: c.title ?? '',
    description: null,
    thumbnail: twitchThumb(c.thumbnail_url),
    publishedAt,
    durationSec,
    format: 'short',
    account: accountFrom(c.broadcaster_id, null, c.broadcaster_name ?? null, users, followers),
    language,
    languageSource: language ? 'source' : null,
    country: null,
    sourceCategory: gameName ? `twitch:game:${gameName}` : null,
    tags: [],
    counters: { views: toCount(c.view_count), likes: null, comments: null, shares: null },
    observedAt: now,
    status: 'active',
    discoveredVia,
  };
}

function helixMessage(f: HttpFailure): string | null {
  const b = f.body as { message?: string; error?: string } | null;
  return b?.message ?? b?.error ?? null;
}

/* ------------------------------------------------------------------ adapter */

export const twitch: SourceAdapter = {
  id: ID,
  platform: 'twitch',
  label: 'Twitch Helix API',
  requiresCredentials: true,
  envKeys: ENV_KEYS,
  metrics: ['views'],
  discovery:
    'Twitch 인기 게임(카테고리) 상위 N개(기본 5)마다 지난 1주 한국어 방송 영상(다시보기·하이라이트·업로드, 조회수순 최대 100개)과 최근 7일 클립(조회수순, 방송 언어 ko만)을 조회. 추적 중인 영상·클립은 ID로 재관측.',
  notes: [
    '제공 지표는 조회수(view_count)뿐이다. 좋아요·댓글·공유는 Helix API가 제공하지 않아 null이다.',
    '다시보기(archive)의 조회수는 방송 종료 후 VOD 재생 수이며 생방송 시청자 수가 아니다. 다시보기는 형식을 라이브로 표시한다. 클립은 숏폼으로 표시한다.',
    '언어는 방송자가 설정한 방송 언어(원천 제공)이며 영상 내용 언어와 다를 수 있다. 국가 정보는 없다.',
    '게임 기준 영상 목록은 페이지 이동이 불가해(after는 user_id 조회 전용) 게임당 최대 100개만 수집한다. 클립은 게임당 약 1,000개까지 페이지 이동 가능하며 TWITCH_CLIP_PAGES(기본 1)로 제한한다.',
    '팔로워 수(/helix/channels/followers)는 사용자 액세스 토큰이 필요하다. TWITCH_USER_TOKEN이 없으면 팔로워는 null이다(앱 토큰으로는 조회 불가).',
    '재관측에서 응답에 없는 영상·클립은 삭제로 표시한다(Twitch는 비공개 VOD를 구분해 알려주지 않는다).',
    '분류: 게임 이름을 twitch:game:<이름>으로 저장한다(재관측 영상은 게임 정보가 없어 null).',
  ],
  docsUrl: 'https://dev.twitch.tv/docs/api/reference/',
  version: 1,
  isEnabled: (env) => hasAllEnv(env, ENV_KEYS),
  collect: collectTwitch,
};

async function collectTwitch(ctx: CollectContext): Promise<CollectResult> {
  const result: CollectResult = { videos: [], accounts: [], errors: [], gone: [] };
  const clientId = envStr(ctx.env, 'TWITCH_CLIENT_ID');
  const clientSecret = envStr(ctx.env, 'TWITCH_CLIENT_SECRET');
  if (!clientId || !clientSecret) {
    result.errors.push(`${ID}: TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET are not set`);
    return result;
  }
  const userToken = envStr(ctx.env, 'TWITCH_USER_TOKEN');
  const secrets = [clientSecret, userToken];
  const budget = new RequestBudget(ctx.maxRequests);
  let stopped = false;

  const fetchToken = async (): Promise<string | null> => {
    const cached = tokens.get(clientId, ctx.now);
    if (cached) return cached;
    if (!budget.take()) {
      result.errors.push(`${ID}: request budget (${budget.max}) exhausted before token request`);
      return null;
    }
    try {
      const res = await ctx.http.getJson<TwitchTokenResponse>(TWITCH_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formEncode({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' }),
      });
      if (!res || typeof res.access_token !== 'string' || !res.access_token) {
        result.errors.push(`${ID}: token request rejected - ${res?.message ?? 'no access_token'}`);
        return null;
      }
      tokens.set(clientId, res.access_token, ctx.now, typeof res.expires_in === 'number' ? res.expires_in : null);
      return res.access_token;
    } catch (err) {
      const f = describeHttpError(err, ctx.now);
      result.errors.push(errorLine(ID, 'token request', f, helixMessage(f), secrets));
      return null;
    }
  };

  let token = await fetchToken();
  if (!token) return result;

  /** Helix GET. Returns `{ notFound: true }` for 404 so callers can treat "no such ids" as gone. */
  const helix = async <T>(what: string, path: string, params: URLSearchParams, bearer?: string): Promise<TwitchPage<T> | { notFound: true } | null> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (stopped) return null;
      if (!budget.take()) {
        result.errors.push(`${ID}: request budget (${budget.max}) exhausted — skipped ${what}`);
        stopped = true;
        return null;
      }
      try {
        return await ctx.http.getJson<TwitchPage<T>>(`${HELIX}/${path}?${params.toString()}`, {
          headers: { Authorization: `Bearer ${bearer ?? token}`, 'Client-Id': clientId, Accept: 'application/json' },
        });
      } catch (err) {
        const f = describeHttpError(err, ctx.now);
        if (f.status === 404) return { notFound: true };
        if (f.status === 401 && !bearer && attempt === 0) {
          tokens.delete(clientId);
          token = await fetchToken();
          if (!token) {
            stopped = true;
            return null;
          }
          continue;
        }
        result.errors.push(errorLine(ID, what, f, helixMessage(f), secrets));
        if (f.status === 429 || (f.status === 401 && !bearer) || f.status === 403) stopped = true;
        return null;
      }
    }
    return null;
  };
  const page = <T>(r: TwitchPage<T> | { notFound: true } | null): TwitchPage<T> | null => (r && !('notFound' in r) ? r : null);

  const language = (envStr(ctx.env, 'TWITCH_LANGUAGE') ?? 'ko').toLowerCase();
  const topN = envInt(ctx.env, 'TWITCH_TOP_GAMES', 5, 0, 100);
  const clipPages = envInt(ctx.env, 'TWITCH_CLIP_PAGES', 1, 1, 10);
  const clipDays = envInt(ctx.env, 'TWITCH_CLIP_DAYS', 7, 1, 30);

  const videos: { v: TwitchVideo; game: string | null; via: string }[] = [];
  const clips: { c: TwitchClip; game: string | null; via: string }[] = [];
  const gameNames = new Map<string, string>();

  /* 1. discovery */
  if (topN > 0) {
    const games = page(await helix<{ id?: string; name?: string }>('games/top', 'games/top', new URLSearchParams({ first: String(topN) })));
    for (const g of games?.data ?? []) if (g.id && g.name) gameNames.set(g.id, g.name);
    for (const [gameId, gameName] of gameNames) {
      if (stopped) break;
      const vParams = new URLSearchParams({ game_id: gameId, sort: 'views', period: 'week', first: '100' });
      if (language !== 'any') vParams.set('language', language);
      const vRes = page(await helix<TwitchVideo>(`videos game "${gameName}"`, 'videos', vParams));
      for (const v of vRes?.data ?? []) videos.push({ v, game: gameName, via: `${ID}:videos:week:${gameName}` });

      let after: string | null = null;
      for (let p = 0; p < clipPages && !stopped; p++) {
        const cParams = new URLSearchParams({
          game_id: gameId,
          started_at: rfc3339(ctx.now - clipDays * DAY_MS),
          ended_at: rfc3339(ctx.now),
          first: '100',
        });
        if (after) cParams.set('after', after);
        const cRes = page(await helix<TwitchClip>(`clips game "${gameName}"${p ? ` page ${p + 1}` : ''}`, 'clips', cParams));
        if (!cRes) break;
        for (const c of cRes.data ?? []) {
          if (language !== 'any' && normLang(c.language) !== language) continue;
          clips.push({ c, game: gameName, via: `${ID}:clips:${clipDays}d:${gameName}` });
        }
        after = cRes.pagination?.cursor || null;
        if (!after) break;
      }
    }
  }

  /* 2. refresh */
  const seen = new Set([...videos.map((x) => x.v.id), ...clips.map((x) => x.c.id)]);
  const refresh = uniq((ctx.refreshIds ?? []).map((s) => String(s).trim()).filter(Boolean)).filter((id) => !seen.has(id));
  const refreshVideoIds = refresh.filter((id) => /^\d+$/.test(id));
  const refreshClipIds = refresh.filter((id) => !/^\d+$/.test(id) && /^[A-Za-z0-9_-]+$/.test(id));
  for (const batch of chunk(refreshVideoIds, 100)) {
    const params = new URLSearchParams();
    for (const id of batch) params.append('id', id);
    const r = await helix<TwitchVideo>(`videos refresh (${batch.length} ids)`, 'videos', params);
    if (r === null) continue;
    const got = new Set<string>();
    if (!('notFound' in r)) {
      for (const v of r.data ?? []) {
        if (v.id) got.add(v.id);
        videos.push({ v, game: null, via: `${ID}:refresh` });
      }
    }
    // 404 = none of the ids exist; otherwise missing ids were silently ignored by the API.
    for (const id of batch) if (!got.has(id)) result.gone!.push({ platformId: id, status: 'deleted' });
  }
  for (const batch of chunk(refreshClipIds, 100)) {
    const params = new URLSearchParams();
    for (const id of batch) params.append('id', id);
    const r = await helix<TwitchClip>(`clips refresh (${batch.length} ids)`, 'clips', params);
    if (r === null || 'notFound' in r) continue; // clips by id never 404 for unknown ids; a 404 is not proof of deletion
    const got = new Set<string>();
    for (const c of r.data ?? []) {
      if (c.id) got.add(c.id);
      clips.push({ c, game: c.game_id ? gameNames.get(c.game_id) ?? null : null, via: `${ID}:refresh` });
    }
    for (const id of batch) if (!got.has(id)) result.gone!.push({ platformId: id, status: 'deleted' });
  }

  /* 3. users + followers */
  const broadcasterIds = uniq([
    ...videos.map((x) => x.v.user_id).filter((x): x is string => !!x),
    ...clips.map((x) => x.c.broadcaster_id).filter((x): x is string => !!x),
  ]);
  const users = new Map<string, TwitchUser>();
  for (const batch of chunk(broadcasterIds, 100)) {
    if (stopped) break;
    const params = new URLSearchParams();
    for (const id of batch) params.append('id', id);
    const r = page(await helix<TwitchUser>(`users (${batch.length} ids)`, 'users', params));
    for (const u of r?.data ?? []) if (u.id) users.set(u.id, u);
  }
  const followers = new Map<string, number>();
  if (userToken) {
    const maxLookups = envInt(ctx.env, 'TWITCH_MAX_FOLLOWER_LOOKUPS', 50, 0, 1000);
    const targets = broadcasterIds.slice(0, maxLookups);
    if (broadcasterIds.length > targets.length) {
      ctx.log.warn(`${ID}: follower totals fetched for ${targets.length} of ${broadcasterIds.length} broadcasters (TWITCH_MAX_FOLLOWER_LOOKUPS)`);
    }
    for (const bid of targets) {
      if (stopped) break;
      const r = page(await helix<unknown>(`followers ${bid}`, 'channels/followers', new URLSearchParams({ broadcaster_id: bid, first: '1' }), userToken));
      const total = toCount(r?.total);
      if (total !== null) followers.set(bid, total);
      else if (r === null) break; // user token rejected / limited: stop follower lookups
    }
  }

  /* 4. map */
  const byId = new Map<string, RawVideo>();
  for (const { v, game, via } of videos) {
    const raw = twitchVideoToRaw(v, users, followers, game, via, ctx.now);
    if (raw && !byId.has(raw.platformId)) byId.set(raw.platformId, raw);
  }
  for (const { c, game, via } of clips) {
    const raw = twitchClipToRaw(c, users, followers, game, via, ctx.now);
    if (raw && !byId.has(raw.platformId)) byId.set(raw.platformId, raw);
  }
  result.videos = [...byId.values()];
  ctx.log.info(`${ID}: ${result.videos.length} video(s)/clip(s) from ${gameNames.size} game(s), ${result.gone!.length} gone, ${budget.used} request(s)`);
  return result;
}
