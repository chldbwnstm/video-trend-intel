/**
 * Source adapter: tiktok-research (TikTok Research API v2, client-credentials).
 *
 * Docs
 * - client token   https://developers.tiktok.com/doc/client-access-token-management
 * - video query    https://developers.tiktok.com/doc/research-api-specs-query-videos
 * - limits / FAQ   https://developers.tiktok.com/doc/research-api-faq
 * - eligibility    https://developers.tiktok.com/doc/about-research-api
 * - terms          https://www.tiktok.com/legal/page/global/terms-of-service-research-api/en
 *
 * Flow per run
 * 1. POST https://open.tiktokapis.com/v2/oauth/token/ (form: client_key, client_secret,
 *    grant_type=client_credentials) → `clt.` token valid 2 h (cached in-process, refreshed on 401).
 * 2. For each keyword seed (≤ TIKTOK_QUERIES_PER_RUN, rotating): POST /v2/research/video/query/?fields=...
 *    with query and=[region_code IN <TIKTOK_REGION_CODES, default KR>], or=[keyword EQ kw, hashtag_name EQ kw],
 *    start_date/end_date (YYYYMMDD, UTC, span TIKTOK_LOOKBACK_DAYS ≤ 30), max_count=100, then cursor + search_id
 *    pagination while has_more (≤ TIKTOK_PAGES_PER_QUERY pages).
 * 3. Refresh: ctx.refreshIds are re-queried with video_id IN [...] inside date windows derived from the id
 *    (TikTok ids carry the creation second in their top 32 bits); windows ≤ 30 days, ≤ 100 ids per query.
 *
 * Limits: 1,000 requests/day and 100,000 records/day per research client (reset 00:00 UTC). Access needs an
 * approved research application (non-profit research only; commercial use is not permitted).
 */
import type { VideoFormat } from '@vti/core';
import type { CollectContext, CollectResult, RawVideo, SourceAdapter } from '../types.ts';
import {
  DAY_MS,
  RequestBudget,
  TokenCache,
  describeHttpError,
  descriptionOf,
  envInt,
  envList,
  envStr,
  errorLine,
  failureText,
  formEncode,
  hasAllEnv,
  keywordSeeds,
  rotatingSlice,
  titleFromText,
  toCount,
  uniq,
  ymdUtc,
  type HttpFailure,
} from './keyed-util.ts';

const ID = 'tiktok-research';
const ENV_KEYS = ['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET'];
export const TIKTOK_TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
export const TIKTOK_QUERY_URL = 'https://open.tiktokapis.com/v2/research/video/query/';
export const TIKTOK_FIELDS =
  'id,video_description,create_time,region_code,share_count,view_count,like_count,comment_count,music_id,hashtag_names,username,video_duration';
export const TIKTOK_MAX_COUNT = 100;
export const TIKTOK_MAX_SPAN_DAYS = 30;
export const TIKTOK_DAILY_REQUEST_LIMIT = 1000;

const tokens = new TokenCache();
/** Test hook: forget cached client tokens. */
export function resetTikTokTokenCache(): void {
  tokens.clear();
}

/* ------------------------------------------------------------------ types */

export interface TikTokCondition {
  operation: 'EQ' | 'IN' | 'GT' | 'GTE' | 'LT' | 'LTE';
  field_name: string;
  field_values: string[];
}
export interface TikTokQueryBody {
  query: { and?: TikTokCondition[]; or?: TikTokCondition[]; not?: TikTokCondition[] };
  start_date: string;
  end_date: string;
  max_count: number;
  cursor?: number;
  search_id?: string;
}
interface TikTokVideo {
  id?: unknown;
  video_id?: unknown;
  create_time?: unknown;
  username?: unknown;
  region_code?: unknown;
  video_description?: unknown;
  music_id?: unknown;
  like_count?: unknown;
  comment_count?: unknown;
  share_count?: unknown;
  view_count?: unknown;
  hashtag_names?: unknown;
  video_duration?: unknown;
}
interface TikTokQueryResponse {
  data?: { videos?: TikTokVideo[]; cursor?: number; has_more?: boolean; search_id?: string | number };
  error?: { code?: string; message?: string; log_id?: string };
}
interface TikTokTokenResponse {
  access_token?: string;
  expires_in?: number;
  token_type?: string;
  error?: string;
  error_description?: string;
}

/* ------------------------------------------------------------------ pure helpers */

/**
 * JSON.parse that keeps 64-bit integer ids exact (`id`, `video_id`, `music_id` become decimal strings).
 * TikTok returns ids as JSON numbers above 2^53 — a plain JSON.parse corrupts them. Usable once the
 * HttpClient can hand adapters the raw response text of a POST (see contract note in the report).
 */
export function parseTikTokJson(text: string): unknown {
  return JSON.parse(text, function (this: unknown, key: string, value: unknown, context?: { source?: string }) {
    if ((key === 'id' || key === 'video_id' || key === 'music_id') && typeof value === 'number') {
      if (context && typeof context.source === 'string' && /^-?\d+$/.test(context.source)) return context.source;
    }
    return value;
  } as (key: string, value: unknown) => unknown);
}

/** Exact decimal id string, or null when absent or when a JSON number has already lost precision. */
export function tiktokIdOf(v: unknown): { id: string | null; imprecise: boolean } {
  if (typeof v === 'string' && /^\d+$/.test(v)) return { id: v, imprecise: false };
  if (typeof v === 'bigint') return { id: v.toString(), imprecise: false };
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) {
    return Number.isSafeInteger(v) ? { id: String(v), imprecise: false } : { id: null, imprecise: true };
  }
  return { id: null, imprecise: false };
}

/** Creation time (epoch ms) encoded in a TikTok video id (top 32 bits = unix seconds), or null. */
export function tiktokIdTime(id: string): number | null {
  if (!/^\d{15,20}$/.test(id)) return null;
  const sec = Number(BigInt(id) >> 32n);
  return sec > 1_400_000_000 && sec < 4_000_000_000 ? sec * 1000 : null;
}

/** TikTok is short-form native: <= 180 s → short, longer uploads → long, unknown length → unknown. */
export function tiktokFormat(durationSec: number | null): VideoFormat {
  if (durationSec === null || durationSec <= 0) return 'unknown';
  return durationSec <= 180 ? 'short' : 'long';
}

/** Query body for one keyword seed. */
export function tiktokKeywordQuery(keyword: string, regions: string[], startDate: string, endDate: string): TikTokQueryBody {
  const or: TikTokCondition[] = [{ operation: 'EQ', field_name: 'keyword', field_values: [keyword] }];
  const tag = keyword.replace(/^#/, '').trim().toLowerCase();
  if (tag && !/\s/.test(tag)) or.push({ operation: 'EQ', field_name: 'hashtag_name', field_values: [tag] });
  const and: TikTokCondition[] = regions.length ? [{ operation: 'IN', field_name: 'region_code', field_values: regions }] : [];
  return { query: { ...(and.length ? { and } : {}), or }, start_date: startDate, end_date: endDate, max_count: TIKTOK_MAX_COUNT };
}

/**
 * Groups refresh ids into query windows: each group spans ≤ 30 days (by id-encoded creation time) and
 * holds ≤ 100 ids. Ids whose creation time cannot be decoded are returned separately.
 */
export function tiktokRefreshWindows(ids: string[], now: number): { groups: { ids: string[]; start: string; end: string }[]; undecodable: string[] } {
  const dated: { id: string; t: number }[] = [];
  const undecodable: string[] = [];
  for (const id of ids) {
    const t = tiktokIdTime(id);
    if (t === null) undecodable.push(id);
    else dated.push({ id, t: Math.min(t, now) });
  }
  dated.sort((a, b) => a.t - b.t);
  const groups: { ids: string[]; start: string; end: string }[] = [];
  let cur: { id: string; t: number }[] = [];
  const flush = () => {
    if (!cur.length) return;
    const start = cur[0].t;
    const end = Math.min(now, start + (TIKTOK_MAX_SPAN_DAYS - 1) * DAY_MS);
    groups.push({ ids: cur.map((x) => x.id), start: ymdUtc(start), end: ymdUtc(end) });
    cur = [];
  };
  for (const d of dated) {
    if (cur.length && (cur.length >= TIKTOK_MAX_COUNT || d.t - cur[0].t > (TIKTOK_MAX_SPAN_DAYS - 1) * DAY_MS)) flush();
    cur.push(d);
  }
  flush();
  return { groups, undecodable };
}

function tiktokErrorCode(f: HttpFailure): string | null {
  const b = f.body as { error?: { code?: string } | string } | null;
  if (b && typeof b.error === 'object' && b.error?.code) return b.error.code;
  if (b && typeof b.error === 'string') return b.error;
  const m = /\b(access_token_invalid|access_token_expired|scope_not_authorized|rate_limit_exceeded|invalid_params|daily_quota_limit_exceeded)\b/.exec(failureText(f));
  return m ? m[1] : null;
}

/* ------------------------------------------------------------------ adapter */

export const tiktokResearch: SourceAdapter = {
  id: ID,
  platform: 'tiktok',
  label: 'TikTok Research API',
  requiresCredentials: true,
  envKeys: ENV_KEYS,
  metrics: ['views', 'likes', 'comments', 'shares'],
  discovery:
    'Research API 영상 검색: 키워드 시드를 keyword 또는 해시태그로, 크리에이터 등록 국가 region_code=KR 조건으로 최근 7일(최대 30일) 게시 영상을 조회(요청당 최대 100개, cursor·search_id 페이지 이동).',
  notes: [
    'TikTok Research API는 승인된 연구 목적(비영리) 접근만 허용되며 상업적 이용은 약관상 허용되지 않는다. 사용 전 연구 신청 승인과 Research API 약관 준수가 필요하다.',
    '한도: 연구 클라이언트당 하루 1,000회 요청·100,000건(00:00 UTC 초기화). 실행당 검색 수(TIKTOK_QUERIES_PER_RUN, 기본 10) × 페이지 수(TIKTOK_PAGES_PER_QUERY, 기본 2) × 하루 실행 횟수가 1,000을 넘지 않게 설정해야 한다.',
    '데이터 지연: 새 영상은 검색에 반영되기까지 최대 48시간, 조회수 등 통계는 최대 10일 늦게 갱신될 수 있다(보관 데이터). 관측 시각은 수집 시각이지만 값은 그보다 오래된 것일 수 있어 짧은 기간 증가량은 과소·지연될 수 있다.',
    'region_code는 영상 작성자가 계정을 등록한 국가이며 시청자 지역이 아니다. 영상 언어는 제공되지 않는다.',
    '계정은 username 기준이며 팔로워 수는 이 어댑터에서 수집하지 않는다(null).',
    '재관측은 video_id 조건 검색으로 하며, 결과에 없더라도 색인 지연 가능성 때문에 삭제로 판단하지 않는다.',
    'TikTok 영상 ID는 64비트 정수로 JSON 숫자로 전달된다. HTTP 클라이언트가 JSON.parse로 정밀도를 잃은 ID는 잘못된 영상 링크를 만들지 않도록 제외하고 오류로 기록한다.',
  ],
  docsUrl: 'https://developers.tiktok.com/doc/research-api-specs-query-videos',
  version: 1,
  isEnabled: (env) => hasAllEnv(env, ENV_KEYS),
  collect: collectTikTok,
};

async function collectTikTok(ctx: CollectContext): Promise<CollectResult> {
  const result: CollectResult = { videos: [], accounts: [], errors: [], gone: [] };
  const clientKey = envStr(ctx.env, 'TIKTOK_CLIENT_KEY');
  const clientSecret = envStr(ctx.env, 'TIKTOK_CLIENT_SECRET');
  if (!clientKey || !clientSecret) {
    result.errors.push(`${ID}: TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET are not set`);
    return result;
  }
  const secrets = [clientSecret];
  const budget = new RequestBudget(ctx.maxRequests);
  let stopped = false;
  let imprecise = 0;
  let noUsername = 0;
  const byId = new Map<string, RawVideo>();

  const fetchToken = async (): Promise<string | null> => {
    const cached = tokens.get(clientKey, ctx.now);
    if (cached) return cached;
    if (!budget.take()) {
      result.errors.push(`${ID}: request budget (${budget.max}) exhausted before token request`);
      return null;
    }
    try {
      const res = await ctx.http.getJson<TikTokTokenResponse>(TIKTOK_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
        body: formEncode({ client_key: clientKey, client_secret: clientSecret, grant_type: 'client_credentials' }),
      });
      if (!res || typeof res.access_token !== 'string' || !res.access_token) {
        result.errors.push(`${ID}: token request rejected - ${res?.error ?? 'no access_token'}${res?.error_description ? `: ${res.error_description}` : ''}`);
        return null;
      }
      tokens.set(clientKey, res.access_token, ctx.now, typeof res.expires_in === 'number' ? res.expires_in : null);
      return res.access_token;
    } catch (err) {
      const f = describeHttpError(err, ctx.now);
      const b = f.body as TikTokTokenResponse | null;
      const detail = b && typeof b.error === 'string' ? `${b.error}${b.error_description ? `: ${b.error_description}` : ''}` : null;
      result.errors.push(errorLine(ID, 'token request', f, detail, secrets));
      return null;
    }
  };

  let token = await fetchToken();
  if (!token) return result;

  /** One query page; handles token expiry (one retry with a fresh token) and fatal/limit errors. */
  const queryPage = async (what: string, body: TikTokQueryBody): Promise<TikTokQueryResponse | null> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (stopped) return null;
      if (!budget.take()) {
        result.errors.push(`${ID}: request budget (${budget.max}) exhausted — skipped ${what}`);
        stopped = true;
        return null;
      }
      let res: TikTokQueryResponse;
      try {
        res = await ctx.http.getJson<TikTokQueryResponse>(`${TIKTOK_QUERY_URL}?fields=${TIKTOK_FIELDS}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (err) {
        const f = describeHttpError(err, ctx.now);
        const code = tiktokErrorCode(f);
        const msg = (f.body as TikTokQueryResponse | null)?.error?.message;
        if ((f.status === 401 || code === 'access_token_invalid' || code === 'access_token_expired') && attempt === 0) {
          tokens.delete(clientKey);
          token = await fetchToken();
          if (!token) {
            stopped = true;
            return null;
          }
          continue;
        }
        result.errors.push(errorLine(ID, what, f, code ? `${code}${msg ? `: ${msg}` : ''}` : null, secrets));
        if (f.status === 401 || f.status === 403 || f.status === 429 || code === 'scope_not_authorized' || code === 'rate_limit_exceeded' || code === 'daily_quota_limit_exceeded') {
          if (code === 'scope_not_authorized') result.errors.push(`${ID}: research access is not approved for this client (scope_not_authorized)`);
          stopped = true;
        }
        return null;
      }
      const code = res?.error?.code;
      if (code && code !== 'ok') {
        if ((code === 'access_token_invalid' || code === 'access_token_expired') && attempt === 0) {
          tokens.delete(clientKey);
          token = await fetchToken();
          if (!token) {
            stopped = true;
            return null;
          }
          continue;
        }
        result.errors.push(`${ID}: ${what} failed - ${code}${res.error?.message ? `: ${res.error.message}` : ''}`);
        if (code === 'scope_not_authorized' || code === 'rate_limit_exceeded' || code === 'daily_quota_limit_exceeded') stopped = true;
        return null;
      }
      return res;
    }
    return null;
  };

  const runQuery = async (what: string, base: TikTokQueryBody, maxPages: number, via: string) => {
    let body: TikTokQueryBody = base;
    for (let page = 0; page < maxPages && !stopped; page++) {
      const res = await queryPage(`${what} page ${page + 1}`, body);
      if (!res) return;
      for (const v of res.data?.videos ?? []) {
        const raw = tiktokToRawVideo(v, via, ctx.now);
        if (raw === 'imprecise') imprecise++;
        else if (raw === 'no-username') noUsername++;
        else if (raw) {
          // Latest counters win; the first discovery reason is kept.
          const prev = byId.get(raw.platformId);
          byId.set(raw.platformId, prev ? { ...raw, discoveredVia: prev.discoveredVia } : raw);
        }
      }
      const d = res.data;
      if (!d?.has_more || d.cursor === undefined || d.search_id === undefined || d.search_id === '') return;
      body = { ...base, cursor: d.cursor, search_id: String(d.search_id) };
    }
  };

  /* discovery */
  const regions = (envList(ctx.env, 'TIKTOK_REGION_CODES').length ? envList(ctx.env, 'TIKTOK_REGION_CODES') : ['KR']).map((r) => r.toUpperCase());
  const lookback = envInt(ctx.env, 'TIKTOK_LOOKBACK_DAYS', 7, 1, TIKTOK_MAX_SPAN_DAYS);
  const perRun = envInt(ctx.env, 'TIKTOK_QUERIES_PER_RUN', 10, 0, TIKTOK_DAILY_REQUEST_LIMIT);
  const pages = envInt(ctx.env, 'TIKTOK_PAGES_PER_QUERY', 2, 1, 50);
  const endDate = ymdUtc(ctx.now);
  const startDate = ymdUtc(ctx.now - lookback * DAY_MS);
  const seeds = rotatingSlice(keywordSeeds(ctx), perRun, ctx.now);
  for (const s of seeds) {
    if (stopped) break;
    await runQuery(`video query "${s.keyword}"`, tiktokKeywordQuery(s.keyword, regions, startDate, endDate), pages, `${ID}:keyword:${s.keyword}`);
  }

  /* refresh (no gone detection: absence may be indexing delay) */
  const refresh = uniq((ctx.refreshIds ?? []).map((s) => String(s).trim()).filter(Boolean)).filter((id) => !byId.has(id));
  if (refresh.length && !stopped) {
    const { groups, undecodable } = tiktokRefreshWindows(refresh, ctx.now);
    if (undecodable.length) ctx.log.warn(`${ID}: ${undecodable.length} refresh id(s) have no decodable creation time; not refreshed`);
    for (const g of groups) {
      if (stopped) break;
      const body: TikTokQueryBody = {
        query: { and: [{ operation: 'IN', field_name: 'video_id', field_values: g.ids }] },
        start_date: g.start,
        end_date: g.end,
        max_count: TIKTOK_MAX_COUNT,
      };
      await runQuery(`refresh query (${g.ids.length} ids ${g.start}-${g.end})`, body, Math.ceil(g.ids.length / TIKTOK_MAX_COUNT) + 1, `${ID}:refresh`);
    }
  }

  if (imprecise > 0) {
    result.errors.push(
      `${ID}: ${imprecise} video(s) skipped — video id arrived as a JSON number above 2^53 and lost precision; the HttpClient must return raw text (see parseTikTokJson)`,
    );
  }
  if (noUsername > 0) ctx.log.warn(`${ID}: ${noUsername} video(s) without username skipped (username field not returned)`);
  result.videos = [...byId.values()];
  ctx.log.info(`${ID}: ${result.videos.length} video(s) from ${budget.used} request(s)`);
  return result;
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

export function tiktokToRawVideo(v: TikTokVideo, discoveredVia: string, now: number): RawVideo | 'imprecise' | 'no-username' | null {
  const { id, imprecise } = tiktokIdOf(v.id ?? v.video_id);
  if (imprecise) return 'imprecise';
  if (!id) return null;
  const username = strOrNull(v.username);
  if (!username) return 'no-username';
  const created = toCount(v.create_time);
  if (created === null) return null;
  const text = typeof v.video_description === 'string' ? v.video_description : '';
  const durationSec = toCount(v.video_duration);
  const tags = Array.isArray(v.hashtag_names) ? uniq(v.hashtag_names.filter((t): t is string => typeof t === 'string' && t !== '').map((t) => t.toLowerCase())) : [];
  const region = strOrNull(v.region_code);
  return {
    platform: 'tiktok',
    platformId: id,
    url: `https://www.tiktok.com/@${encodeURIComponent(username)}/video/${id}`,
    title: titleFromText(text),
    description: descriptionOf(text),
    thumbnail: null,
    publishedAt: created * 1000,
    durationSec: durationSec && durationSec > 0 ? durationSec : null,
    format: tiktokFormat(durationSec),
    account: {
      platform: 'tiktok',
      platformId: username,
      handle: `@${username}`,
      name: username,
      url: `https://www.tiktok.com/@${encodeURIComponent(username)}`,
      avatar: null,
      // region_code = the country where the creator registered the account (not viewer geography).
      country: region ? region.toUpperCase() : null,
      followers: null,
    },
    language: null,
    languageSource: null,
    country: region ? region.toUpperCase() : null,
    sourceCategory: null,
    tags,
    counters: {
      views: toCount(v.view_count),
      likes: toCount(v.like_count),
      comments: toCount(v.comment_count),
      shares: toCount(v.share_count),
    },
    observedAt: now,
    status: 'active',
    discoveredVia,
  };
}
