/**
 * Tests for the credentialed source adapters (youtube-data-api, tiktok-research, instagram-graph, x-api, twitch)
 * with a fake HttpClient. No credentials / network are used.
 *
 * Fixtures (test/fixtures/keyed/**) are built from the official documentation:
 * - youtube/*        Resource representations + list-response envelopes from
 *                    https://developers.google.com/youtube/v3/docs/videos, /docs/search/list, /docs/channels.
 *                    (The docs give schemas, not literal samples; field names/types follow them exactly:
 *                    counters are strings, likeCount/commentCount may be absent, P0D for live.)
 *                    error-quota.json: standard Google API error envelope with reason quotaExceeded
 *                    (https://developers.google.com/youtube/v3/docs/errors).
 * - tiktok/token*.json    verbatim examples, https://developers.tiktok.com/doc/client-access-token-management
 * - tiktok/query-page1    3rd item is the verbatim example response of
 *                    https://developers.tiktok.com/doc/research-api-specs-query-videos (numeric `video_id`
 *                    beyond 2^53); the other items follow the Video Object table (id int64 → sent as string
 *                    here to model a lossless parse), plus cursor/search_id/has_more pagination fields.
 * - tiktok/error-scope    error envelope {code,message,log_id} from the same page, code from
 *                    https://developers.tiktok.com/doc/research-api-faq (scope_not_authorized).
 * - instagram/business-discovery  extends the doc samples of
 *                    https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/business_discovery
 *                    (ids, followers_count 267788, media_count 1205, media metrics incl. view_count) with the IG Media
 *                    fields of .../reference/ig-media.
 * - instagram/hashtag-search      verbatim sample, .../reference/ig-hashtag-search
 * - instagram/hashtag-*-media     fields documented in .../reference/ig-hashtag/top-media and /recent-media.
 * - instagram/error-token         Graph API error envelope (code 190 OAuthException),
 *                    https://developers.facebook.com/docs/graph-api/guides/error-handling
 * - x/*              schema of https://docs.x.com/x-api/posts/search-recent-posts and
 *                    https://api.x.com/2/openapi.json (PostPublicMetrics repost_count…impression_count, media
 *                    public_metrics.view_count, user public_metrics); users/metrics values from
 *                    https://docs.x.com/x-api/fundamentals/data-dictionary examples; lookup errors from
 *                    https://docs.x.com/x-api/posts/get-posts-by-ids (resource-not-found problem).
 * - twitch/*         verbatim examples of https://dev.twitch.tv/docs/api/reference/ (Get Top Games, Get Videos,
 *                    Get Clips, Get Users, Get Channel Followers) and of the client-credentials flow at
 *                    https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/ ; extra Korean items added.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CollectContext, CollectResult, HttpClient, KeywordSeed, RawVideo } from '../src/types.ts';
import {
  RequestBudget,
  describeHttpError,
  errorLine,
  hashtagsFromText,
  normLang,
  parseTime,
  redact,
  rotatingSlice,
  titleFromText,
  toCount,
} from '../src/sources/keyed-util.ts';
import {
  YOUTUBE_CATEGORY_NAMES,
  estimateYoutubeQuota,
  parseIsoDuration,
  planYoutubeSearches,
  youtubeDataApi,
  youtubeFormat,
} from '../src/sources/youtube-data-api.ts';
import {
  TIKTOK_FIELDS,
  TIKTOK_QUERY_URL,
  TIKTOK_TOKEN_URL,
  parseTikTokJson,
  resetTikTokTokenCache,
  tiktokIdOf,
  tiktokIdTime,
  tiktokKeywordQuery,
  tiktokRefreshWindows,
  tiktokResearch,
} from '../src/sources/tiktok-research.ts';
import {
  IG_HASHTAG_MEDIA_FIELDS,
  IG_UNATTRIBUTED_ACCOUNT_ID,
  igBusinessDiscoveryFields,
  instagramGraph,
  isIgVideo,
} from '../src/sources/instagram-graph.ts';
import { X_EXPANSIONS, X_MEDIA_FIELDS, X_POST_FIELDS, X_USER_FIELDS, buildXQuery, xApi, xShares } from '../src/sources/x-api.ts';
import {
  TWITCH_TOKEN_URL,
  parseTwitchDuration,
  resetTwitchTokenCache,
  twitch,
  twitchThumb,
  twitchVideoFormat,
} from '../src/sources/twitch.ts';

/* ================================================================== harness */

const NOW = Date.UTC(2026, 8, 28, 3, 0, 0); // 2026-09-28T03:00:00Z

function fixtureText(path: string): string {
  return readFileSync(new URL(`./fixtures/keyed/${path}`, import.meta.url), 'utf8');
}
/** Parsed like a real HttpClient would (JSON.parse → large TikTok ids lose precision, as in production). */
function fx<T = any>(path: string): T {
  return JSON.parse(fixtureText(path)) as T;
}

interface Req {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

class FakeHttpError extends Error {
  status: number;
  body: unknown;
  headers: Record<string, string>;
  constructor(status: number, body: unknown = null, headers: Record<string, string> = {}) {
    super(`HTTP ${status}`);
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

type Responder = (req: Req) => unknown;

class FakeHttp implements HttpClient {
  readonly calls: Req[] = [];
  private readonly routes: { test: (r: Req) => boolean; respond: Responder; remaining: number }[] = [];
  get requestCount(): number {
    return this.calls.length;
  }
  /** Route by URL prefix / regex / predicate. `times` limits how often the route answers (then falls through). */
  on(test: string | RegExp | ((r: Req) => boolean), respond: Responder, times = Number.POSITIVE_INFINITY): this {
    const t = typeof test === 'string' ? (r: Req) => r.url.startsWith(test) : test instanceof RegExp ? (r: Req) => test.test(r.url) : test;
    this.routes.push({ test: t, respond, remaining: times });
    return this;
  }
  async getJson<T = unknown>(url: string, init?: { headers?: Record<string, string>; method?: 'GET' | 'POST'; body?: string }): Promise<T> {
    const req: Req = { url, method: init?.method ?? 'GET', headers: { ...(init?.headers ?? {}) }, body: init?.body };
    this.calls.push(req);
    const route = this.routes.find((r) => r.remaining > 0 && r.test(req));
    if (!route) throw new Error(`unexpected request ${req.method} ${url}`);
    route.remaining--;
    return route.respond(req) as T;
  }
  async getText(url: string): Promise<string> {
    throw new Error(`getText not expected: ${url}`);
  }
  callsTo(prefix: string): Req[] {
    return this.calls.filter((c) => c.url.startsWith(prefix));
  }
}

function makeCtx(
  opts: { env?: Record<string, string>; keywords?: KeywordSeed[]; refreshIds?: string[]; maxRequests?: number; now?: number } = {},
) {
  const http = new FakeHttp();
  const logs = { info: [] as string[], warn: [] as string[], error: [] as string[] };
  const ctx: CollectContext = {
    now: opts.now ?? NOW,
    http,
    env: opts.env ?? {},
    refreshIds: opts.refreshIds ?? [],
    maxRequests: opts.maxRequests ?? 1000,
    log: { info: (m) => logs.info.push(m), warn: (m) => logs.warn.push(m), error: (m) => logs.error.push(m) },
    seeds: { youtubeChannels: [], keywords: opts.keywords ?? [], dailymotion: [], niconico: [], peertube: [], creators: [] },
  };
  return { ctx, http, logs };
}

const kw = (keyword: string, language = 'ko', category = 'beauty'): KeywordSeed => ({ keyword, category, language });
const params = (r: Req) => new URL(r.url).searchParams;
const byId = (res: CollectResult) => new Map<string, RawVideo>(res.videos.map((v) => [v.platformId, v]));
const allErrors = (res: CollectResult) => res.errors.join('\n');

/* ================================================================== shared helpers */

describe('keyed-util', () => {
  it('toCount keeps null distinct from zero', () => {
    expect(toCount('0')).toBe(0);
    expect(toCount(0)).toBe(0);
    expect(toCount('154321')).toBe(154321);
    expect(toCount(12.7)).toBe(12);
    expect(toCount(undefined)).toBeNull();
    expect(toCount(null)).toBeNull();
    expect(toCount('')).toBeNull();
    expect(toCount('-5')).toBeNull();
    expect(toCount(-1)).toBeNull();
    expect(toCount('1e3')).toBeNull();
    expect(toCount(Number.NaN)).toBeNull();
  });

  it('normLang maps tags to ISO 639-1 and drops non-language codes', () => {
    expect(normLang('ko')).toBe('ko');
    expect(normLang('en-US')).toBe('en');
    expect(normLang('zh_Hant')).toBe('zh');
    expect(normLang('KO')).toBe('ko');
    expect(normLang('zxx')).toBeNull();
    expect(normLang('und')).toBeNull();
    expect(normLang('qme')).toBeNull();
    expect(normLang('other')).toBeNull();
    expect(normLang(undefined)).toBeNull();
  });

  it('parseTime accepts RFC 3339 and Instagram +0000 offsets', () => {
    expect(parseTime('2026-09-25T09:10:00+0000')).toBe(Date.UTC(2026, 8, 25, 9, 10));
    expect(parseTime('2026-09-25T18:10:00+09:00')).toBe(Date.UTC(2026, 8, 25, 9, 10));
    expect(parseTime('2026-09-27T09:15:00.000Z')).toBe(Date.UTC(2026, 8, 27, 9, 15));
    expect(parseTime('nope')).toBeNull();
    expect(parseTime('')).toBeNull();
    expect(parseTime(123)).toBeNull();
  });

  it('text helpers', () => {
    expect(titleFromText('\n\n첫 줄 https://t.co/AbC123\n둘째 줄')).toBe('첫 줄');
    expect(titleFromText('가'.repeat(150)).length).toBe(100);
    expect(hashtagsFromText('#스킨케어 and #SkinCare #스킨케어 #日本語')).toEqual(['스킨케어', 'skincare', '日本語']);
  });

  it('rotatingSlice covers every item across slots and returns all when they fit', () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    expect(rotatingSlice(items.slice(0, 5), 8, NOW)).toEqual([0, 1, 2, 3, 4]);
    expect(rotatingSlice(items, 0, NOW)).toEqual([]);
    const seen = new Set<number>();
    for (let h = 0; h < 5; h++) for (const x of rotatingSlice(items, 8, NOW + h * 3_600_000)) seen.add(x);
    expect(seen.size).toBe(20);
    expect(rotatingSlice(items, 8, NOW)).toHaveLength(8);
  });

  it('RequestBudget enforces the soft cap', () => {
    const b = new RequestBudget(2);
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(false);
    expect(b.used).toBe(2);
    expect(new RequestBudget(undefined).max).toBe(Number.POSITIVE_INFINITY);
  });

  it('describeHttpError reads status/body/reset from common error shapes', () => {
    const a = describeHttpError(new FakeHttpError(429, '{"title":"Too Many Requests"}', { 'X-Rate-Limit-Reset': '1790565300' }), NOW);
    expect(a.status).toBe(429);
    expect(a.body).toEqual({ title: 'Too Many Requests' });
    expect(a.resetAt).toBe(1790565300 * 1000);

    const h = new Headers({ 'retry-after': '60' });
    const b = describeHttpError({ message: 'boom', response: { status: 503, headers: h } }, NOW);
    expect(b.status).toBe(503);
    expect(b.resetAt).toBe(NOW + 60_000);

    const c = describeHttpError(new Error('HTTP 404 Not Found for https://x'), NOW);
    expect(c.status).toBe(404);
    const d = describeHttpError(new Error('request failed with status code 401'), NOW);
    expect(d.status).toBe(401);
    const e = describeHttpError(new Error('socket hang up'), NOW);
    expect(e.status).toBeNull();
    expect(e.resetAt).toBeNull();
    const f = describeHttpError({ statusCode: 403, headers: { 'ratelimit-reset': '1790565000' } }, NOW);
    expect(f.status).toBe(403);
    expect(f.resetAt).toBe(1790565000 * 1000);
  });

  it('errorLine / redact never leak secrets', () => {
    const line = errorLine(
      'src',
      'call',
      describeHttpError(new Error('HTTP 400 for https://a.test/v?key=SECRETKEY&x=1 token=TOPSECRET'), NOW),
      null,
      ['TOPSECRET'],
    );
    expect(line).toContain('(HTTP 400)');
    expect(line).not.toContain('SECRETKEY');
    expect(line).not.toContain('TOPSECRET');
    expect(redact('access_token=abc&client_secret=def', [])).toBe('access_token=***&client_secret=***');
  });
});

/* ================================================================== youtube-data-api */

describe('youtube-data-api', () => {
  const ENV = { YOUTUBE_API_KEY: 'yt-key-123' };
  const API = 'https://www.googleapis.com/youtube/v3/';

  it('declares credentials and is enabled only when the key is present', () => {
    expect(youtubeDataApi.id).toBe('youtube-data-api');
    expect(youtubeDataApi.platform).toBe('youtube');
    expect(youtubeDataApi.requiresCredentials).toBe(true);
    expect(youtubeDataApi.envKeys).toEqual(['YOUTUBE_API_KEY']);
    expect(youtubeDataApi.metrics).toEqual(['views', 'likes', 'comments']);
    expect(youtubeDataApi.isEnabled({})).toBe(false);
    expect(youtubeDataApi.isEnabled({ YOUTUBE_API_KEY: '  ' })).toBe(false);
    expect(youtubeDataApi.isEnabled(ENV)).toBe(true);
    expect(youtubeDataApi.notes.length).toBeGreaterThan(3);
    expect(youtubeDataApi.docsUrl).toMatch(/^https:\/\/developers\.google\.com\/youtube/);
  });

  it('returns an error without requests when the key is missing', async () => {
    const { ctx, http } = makeCtx({ keywords: [kw('a')] });
    const res = await youtubeDataApi.collect(ctx);
    expect(http.calls).toHaveLength(0);
    expect(res.errors[0]).toMatch(/YOUTUBE_API_KEY/);
  });

  it('parses ISO-8601 durations', () => {
    expect(parseIsoDuration('PT12M34S')).toBe(754);
    expect(parseIsoDuration('PT45S')).toBe(45);
    expect(parseIsoDuration('PT1H2M3S')).toBe(3723);
    expect(parseIsoDuration('P1DT1S')).toBe(86_401);
    expect(parseIsoDuration('PT15.6S')).toBe(16);
    expect(parseIsoDuration('P0D')).toBe(0);
    expect(parseIsoDuration('PT')).toBeNull();
    expect(parseIsoDuration('P')).toBeNull();
    expect(parseIsoDuration('P1M')).toBeNull(); // months are ambiguous, not used by YouTube
    expect(parseIsoDuration('12:00')).toBeNull();
    expect(parseIsoDuration(undefined)).toBeNull();
  });

  it('format heuristic: <=60 s short, 61–180 s short only with #shorts, live wins', () => {
    expect(youtubeFormat({ durationSec: 60 })).toBe('short');
    expect(youtubeFormat({ durationSec: 61 })).toBe('long');
    expect(youtubeFormat({ durationSec: 130, title: '비교 #Shorts' })).toBe('short');
    expect(youtubeFormat({ durationSec: 130, tags: ['shorts'] })).toBe('short');
    expect(youtubeFormat({ durationSec: 200, title: '#shorts' })).toBe('long');
    expect(youtubeFormat({ durationSec: 130, title: '#shortstop' })).toBe('long');
    expect(youtubeFormat({ durationSec: null })).toBe('unknown');
    expect(youtubeFormat({ durationSec: 0, liveBroadcastContent: 'live' })).toBe('live');
    expect(youtubeFormat({ durationSec: 30, liveBroadcastContent: 'upcoming' })).toBe('live');
    expect(youtubeFormat({ durationSec: 7200, hasLiveStreamingDetails: true })).toBe('live');
  });

  it('knows the standard category names', () => {
    expect(YOUTUBE_CATEGORY_NAMES['10'].en).toBe('Music');
    expect(YOUTUBE_CATEGORY_NAMES['20'].ko).toBe('게임');
    expect(YOUTUBE_CATEGORY_NAMES['26'].en).toBe('Howto & Style');
  });

  it('collects: search.list → videos.list → channels.list with documented params and maps fields', async () => {
    const { ctx, http, logs } = makeCtx({
      env: ENV,
      keywords: [kw('스킨케어')],
      refreshIds: ['vidRefrsh05', 'vidGoneXX06', 'x7abcdef', 'vidLongAAA1'],
    });
    http
      .on(`${API}search?`, () => fx('youtube/search-list.json'))
      .on(`${API}videos?`, () => fx('youtube/videos-list.json'))
      .on(`${API}channels?`, () => fx('youtube/channels-list.json'));
    const res = await youtubeDataApi.collect(ctx);

    // 1 keyword → 2 search candidates (viewCount, date) → 2 search calls, 1 videos.list, 1 channels.list
    expect(http.calls.map((c) => new URL(c.url).pathname)).toEqual([
      '/youtube/v3/search',
      '/youtube/v3/search',
      '/youtube/v3/videos',
      '/youtube/v3/channels',
    ]);
    const s1 = params(http.calls[0]);
    expect(Object.fromEntries(s1)).toEqual({
      part: 'snippet',
      type: 'video',
      order: 'viewCount',
      regionCode: 'KR',
      relevanceLanguage: 'ko',
      publishedAfter: '2026-09-21T03:00:00Z',
      q: '스킨케어',
      maxResults: '50',
      key: 'yt-key-123',
    });
    expect(params(http.calls[1]).get('order')).toBe('date');
    const v = params(http.calls[2]);
    expect(v.get('part')).toBe('snippet,statistics,contentDetails,liveStreamingDetails');
    expect(v.get('id')!.split(',')).toEqual(['vidLongAAA1', 'vidShortB02', 'vidLiveCC03', 'vidShrt2m04', 'vidRefrsh05', 'vidGoneXX06']);
    expect(v.has('maxResults')).toBe(false); // not valid together with id
    const c = params(http.calls[3]);
    expect(c.get('part')).toBe('snippet,statistics');
    expect(c.get('id')).toBe('UCchannelAAAAAAAAAAAAAAA,UCchannelBBBBBBBBBBBBBBB');

    expect(res.errors).toEqual([]);
    expect(res.gone).toEqual([{ platformId: 'vidGoneXX06', status: 'deleted' }]);
    expect(logs.warn.join()).toMatch(/1 refresh id/);
    const m = byId(res);
    expect(m.size).toBe(5);

    const long = m.get('vidLongAAA1')!;
    expect(long).toMatchObject({
      platform: 'youtube',
      url: 'https://www.youtube.com/watch?v=vidLongAAA1',
      title: '가을 스킨케어 루틴 (민감성 피부)',
      thumbnail: 'https://i.ytimg.com/vi/vidLongAAA1/hqdefault.jpg',
      publishedAt: Date.UTC(2026, 8, 25, 10),
      durationSec: 754,
      format: 'long',
      language: 'ko',
      languageSource: 'source',
      country: 'KR',
      sourceCategory: 'youtube:category:26',
      tags: ['스킨케어', '민감성 피부', '루틴'],
      counters: { views: 154321, likes: 4321, comments: 210, shares: null },
      observedAt: NOW,
      status: 'active',
      discoveredVia: 'youtube-data-api:search:viewCount:스킨케어',
    });
    expect(long.description).toContain('환절기');
    expect(long.account).toEqual({
      platform: 'youtube',
      platformId: 'UCchannelAAAAAAAAAAAAAAA',
      handle: '@channela',
      name: '채널A 뷰티',
      url: 'https://www.youtube.com/channel/UCchannelAAAAAAAAAAAAAAA',
      avatar: 'https://yt3.ggpht.com/channelA=s88',
      country: 'KR',
      followers: 1_230_000,
    });

    const short = m.get('vidShortB02')!;
    expect(short.format).toBe('short');
    expect(short.counters).toEqual({ views: 98000, likes: null, comments: 0, shares: null }); // hidden likes → null, 0 comments stays 0
    expect(short.language).toBe('ko'); // defaultLanguage ko-KR
    expect(short.description).toBeNull();

    const live = m.get('vidLiveCC03')!;
    expect(live.format).toBe('live');
    expect(live.durationSec).toBeNull(); // P0D while live
    expect(live.counters.comments).toBeNull(); // comments disabled → field absent
    expect(live.language).toBeNull(); // zxx
    expect(live.languageSource).toBeNull();
    expect(live.account.followers).toBeNull(); // hiddenSubscriberCount even though subscriberCount "0"
    expect(live.account.handle).toBeNull();
    expect(live.country).toBeNull();

    const shrt = m.get('vidShrt2m04')!;
    expect(shrt.durationSec).toBe(130);
    expect(shrt.format).toBe('short');
    expect(shrt.counters).toEqual({ views: 0, likes: 0, comments: 0, shares: null });

    const refreshed = m.get('vidRefrsh05')!;
    expect(refreshed.discoveredVia).toBe('youtube-data-api:refresh');
    expect(refreshed.durationSec).toBe(3723);
    expect(refreshed.language).toBe('en');
    expect(refreshed.thumbnail).toBe('https://i.ytimg.com/vi/vidRefrsh05/mqdefault.jpg');
  });

  it('refresh-only run batches videos.list by 50 ids and reports missing ids as gone', async () => {
    const ids = Array.from({ length: 120 }, (_, i) => `refresh${String(i).padStart(4, '0')}`);
    const missing = new Set(['refresh0007', 'refresh0100']);
    const template = fx<any>('youtube/videos-list.json').items[0];
    const { ctx, http } = makeCtx({ env: ENV, refreshIds: ids });
    http
      .on(`${API}videos?`, (r) => ({
        items: params(r)
          .get('id')!
          .split(',')
          .filter((id) => !missing.has(id))
          .map((id) => ({ ...template, id })),
      }))
      .on(`${API}channels?`, () => fx('youtube/channels-list.json'));
    const res = await youtubeDataApi.collect(ctx);
    const videoCalls = http.callsTo(`${API}videos?`);
    expect(videoCalls.map((c) => params(c).get('id')!.split(',').length)).toEqual([50, 50, 20]);
    expect(http.callsTo(`${API}search?`)).toHaveLength(0);
    expect(http.callsTo(`${API}channels?`)).toHaveLength(1);
    expect(res.videos).toHaveLength(118);
    expect(res.gone).toEqual([
      { platformId: 'refresh0007', status: 'deleted' },
      { platformId: 'refresh0100', status: 'deleted' },
    ]);
    expect(res.videos.every((v) => v.discoveredVia === 'youtube-data-api:refresh')).toBe(true);
  });

  it('respects YOUTUBE_SEARCHES_PER_RUN', async () => {
    const { ctx, http } = makeCtx({ env: { ...ENV, YOUTUBE_SEARCHES_PER_RUN: '1' }, keywords: [kw('a'), kw('b'), kw('c')] });
    http.on(`${API}search?`, () => ({ items: [] }));
    await youtubeDataApi.collect(ctx);
    expect(http.callsTo(`${API}search?`)).toHaveLength(1);
    expect(http.calls).toHaveLength(1);
  });

  it('plans at most the per-run budget and rotates across runs', () => {
    const keywords = Array.from({ length: 10 }, (_, i) => kw(`k${i}`, i % 2 ? 'en' : 'ko'));
    const { ctx } = makeCtx({ keywords });
    const plan = planYoutubeSearches(ctx, 8);
    expect(plan).toHaveLength(8);
    const covered = new Set<string>();
    for (let h = 0; h < 10; h++) {
      for (const p of planYoutubeSearches({ ...ctx, now: NOW + h * 3_600_000 }, 8)) covered.add(`${p.keyword}:${p.order}`);
    }
    expect(covered.size).toBe(20);
    expect(plan.find((p) => p.keyword === 'k1')?.relevanceLanguage ?? 'en').toBe('en');
    const q = estimateYoutubeQuota(8, 400, 30);
    expect(q).toEqual({ searchCalls: 8, standardUnits: 9, legacyUnits: 809 });
  });

  it('stops at the request budget and records it (no silent cap)', async () => {
    const { ctx, http } = makeCtx({ env: ENV, keywords: [kw('a'), kw('b'), kw('c'), kw('d'), kw('e')], maxRequests: 3 });
    http.on(`${API}search?`, () => fx('youtube/search-list.json'));
    const res = await youtubeDataApi.collect(ctx);
    expect(http.calls).toHaveLength(3);
    expect(allErrors(res)).toMatch(/budget \(3\) exhausted/);
    expect(res.videos).toEqual([]);
  });

  it('quotaExceeded on search stops further searches but still runs videos.list (separate buckets)', async () => {
    const { ctx, http } = makeCtx({ env: ENV, keywords: [kw('a'), kw('b')], refreshIds: ['vidRefrsh05'] });
    http
      .on(`${API}search?`, () => {
        throw new FakeHttpError(403, fx('youtube/error-quota.json'));
      })
      .on(`${API}videos?`, () => ({ items: [fx<any>('youtube/videos-list.json').items[4]] }))
      .on(`${API}channels?`, () => fx('youtube/channels-list.json'));
    const res = await youtubeDataApi.collect(ctx);
    expect(http.callsTo(`${API}search?`)).toHaveLength(1);
    expect(http.callsTo(`${API}videos?`)).toHaveLength(1);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toMatch(/HTTP 403/);
    expect(res.errors[0]).toMatch(/quotaExceeded: The request cannot be completed because you have exceeded your quota\./);
    expect(res.errors[0]).not.toContain('yt-key-123');
    expect(res.videos.map((v) => v.platformId)).toEqual(['vidRefrsh05']);
  });

  it('detects quotaExceeded from a non-JSON error body as well', async () => {
    const { ctx, http } = makeCtx({ env: ENV, keywords: [kw('a'), kw('b')] });
    http.on(`${API}search?`, () => {
      throw Object.assign(new Error('request failed'), { httpStatus: 403, body: '<html>quotaExceeded</html>' });
    });
    const res = await youtubeDataApi.collect(ctx);
    expect(http.callsTo(`${API}search?`)).toHaveLength(1);
    expect(res.errors[0]).toMatch(/\(HTTP 403\) - quotaExceeded/);
  });

  it('403 on videos.list is reported, stops the run, and never marks ids gone', async () => {
    const { ctx, http } = makeCtx({ env: ENV, refreshIds: ['vidRefrsh05', 'vidGoneXX06'] });
    http.on(`${API}videos?`, () => {
      throw new FakeHttpError(403, { error: { code: 403, message: 'The request is not properly authorized', errors: [{ reason: 'forbidden' }] } });
    });
    const res = await youtubeDataApi.collect(ctx);
    expect(res.gone).toEqual([]);
    expect(res.videos).toEqual([]);
    expect(allErrors(res)).toMatch(/forbidden/);
    expect(http.callsTo(`${API}channels?`)).toHaveLength(0);
  });

  it('a transient failure of one batch does not stop the others', async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `transient${String(i).padStart(2, '0')}`);
    const template = fx<any>('youtube/videos-list.json').items[0];
    const { ctx, http } = makeCtx({ env: ENV, refreshIds: ids });
    let n = 0;
    http
      .on(`${API}videos?`, (r) => {
        if (n++ === 0) throw new Error('socket hang up');
        return { items: params(r).get('id')!.split(',').slice(1).map((id) => ({ ...template, id })) };
      })
      .on(`${API}channels?`, () => ({ items: [] }));
    const res = await youtubeDataApi.collect(ctx);
    expect(http.callsTo(`${API}videos?`)).toHaveLength(2);
    expect(res.videos).toHaveLength(9);
    expect(res.gone).toEqual([{ platformId: 'transient50', status: 'deleted' }]); // only from the successful batch
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toMatch(/socket hang up/);
    // channel lookup returned nothing → fallback account from the video snippet, followers null
    expect(res.videos[0].account).toMatchObject({ name: '채널A', followers: null, country: null });
  });
});

/* ================================================================== tiktok-research */

describe('tiktok-research', () => {
  const ENV = { TIKTOK_CLIENT_KEY: 'ck-123', TIKTOK_CLIENT_SECRET: 'cs-secret-456' };
  const TOKEN = 'clt.example12345Example12345Example';
  beforeEach(() => resetTikTokTokenCache());

  const isToken = (r: Req) => r.url === TIKTOK_TOKEN_URL;
  const isQuery = (r: Req) => r.url.startsWith(TIKTOK_QUERY_URL);

  it('declares credentials; enabled only with both keys', () => {
    expect(tiktokResearch.requiresCredentials).toBe(true);
    expect(tiktokResearch.envKeys).toEqual(['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET']);
    expect(tiktokResearch.metrics).toEqual(['views', 'likes', 'comments', 'shares']);
    expect(tiktokResearch.isEnabled({ TIKTOK_CLIENT_KEY: 'x' })).toBe(false);
    expect(tiktokResearch.isEnabled(ENV)).toBe(true);
    expect(tiktokResearch.notes.join()).toMatch(/비영리|상업/);
  });

  it('client-credentials token → video query with documented body, cursor/search_id pagination, parsing', async () => {
    const { ctx, http } = makeCtx({ env: ENV, keywords: [kw('스킨케어')] });
    let page = 0;
    http.on(isToken, () => fx('tiktok/token.json')).on(isQuery, () => (page++ === 0 ? fx('tiktok/query-page1.json') : fx('tiktok/query-page2.json')));
    const res = await tiktokResearch.collect(ctx);

    expect(http.calls).toHaveLength(3);
    const [tok, q1, q2] = http.calls;
    expect(tok.method).toBe('POST');
    expect(tok.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(tok.body))).toEqual({
      client_key: 'ck-123',
      client_secret: 'cs-secret-456',
      grant_type: 'client_credentials',
    });

    expect(q1.method).toBe('POST');
    expect(q1.url).toBe(`${TIKTOK_QUERY_URL}?fields=${TIKTOK_FIELDS}`);
    expect(params(q1).get('fields')!.split(',')).toEqual([
      'id', 'video_description', 'create_time', 'region_code', 'share_count', 'view_count', 'like_count',
      'comment_count', 'music_id', 'hashtag_names', 'username', 'video_duration',
    ]);
    expect(q1.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(q1.headers['Content-Type']).toBe('application/json');
    const b1 = JSON.parse(q1.body!);
    expect(b1).toEqual({
      query: {
        and: [{ operation: 'IN', field_name: 'region_code', field_values: ['KR'] }],
        or: [
          { operation: 'EQ', field_name: 'keyword', field_values: ['스킨케어'] },
          { operation: 'EQ', field_name: 'hashtag_name', field_values: ['스킨케어'] },
        ],
      },
      start_date: '20260921',
      end_date: '20260928',
      max_count: 100,
    });
    const b2 = JSON.parse(q2.body!);
    expect(b2.cursor).toBe(100);
    expect(b2.search_id).toBe('7201388525814961198');
    expect(b2.query).toEqual(b1.query);

    // The verbatim doc example (numeric video_id > 2^53) cannot be represented exactly → skipped, reported.
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toMatch(/2\^53/);
    expect(res.errors.join()).not.toContain('cs-secret-456');
    const m = byId(res);
    expect([...m.keys()]).toEqual(['7689012374800827090', '7689812527208071890', '7690330500263969490']);

    const a = m.get('7689012374800827090')!;
    expect(a).toMatchObject({
      platform: 'tiktok',
      url: 'https://www.tiktok.com/@beauty_seoul/video/7689012374800827090',
      title: '민감성 피부 스킨케어 루틴 #스킨케어 #skincare',
      thumbnail: null,
      publishedAt: 1790237700 * 1000,
      durationSec: 42,
      format: 'short',
      language: null,
      languageSource: null,
      country: 'KR',
      sourceCategory: null,
      tags: ['스킨케어', 'skincare'],
      counters: { views: 250000, likes: 12500, comments: 340, shares: 0 },
      observedAt: NOW,
      discoveredVia: 'tiktok-research:keyword:스킨케어',
    });
    expect(a.account).toEqual({
      platform: 'tiktok',
      platformId: 'beauty_seoul',
      handle: '@beauty_seoul',
      name: 'beauty_seoul',
      url: 'https://www.tiktok.com/@beauty_seoul',
      avatar: null,
      country: 'KR',
      followers: null,
    });
    const b = m.get('7689812527208071890')!;
    expect(b.counters).toEqual({ views: 8800, likes: null, comments: 12, shares: 5 }); // like_count absent → null
    expect(b.format).toBe('long');
    expect(b.title).toBe('5분 자취 요리');
    expect(m.get('7690330500263969490')!.counters).toEqual({ views: 0, likes: 0, comments: 0, shares: 0 });
  });

  it('respects TIKTOK_PAGES_PER_QUERY, TIKTOK_QUERIES_PER_RUN and caches the token across runs', async () => {
    const { ctx, http } = makeCtx({
      env: { ...ENV, TIKTOK_PAGES_PER_QUERY: '1', TIKTOK_QUERIES_PER_RUN: '2', TIKTOK_REGION_CODES: 'kr,jp' },
      keywords: [kw('a'), kw('b'), kw('c d')],
    });
    http.on(isToken, () => fx('tiktok/token.json')).on(isQuery, () => fx('tiktok/query-page1.json'));
    await tiktokResearch.collect(ctx);
    await tiktokResearch.collect(ctx);
    expect(http.calls.filter(isToken)).toHaveLength(1);
    const queries = http.calls.filter(isQuery);
    expect(queries).toHaveLength(4); // 2 keywords × 1 page × 2 runs
    const body = JSON.parse(queries[0].body!);
    expect(body.query.and[0].field_values).toEqual(['KR', 'JP']);
    expect(body.cursor).toBeUndefined();
  });

  it('multi-word keywords are not sent as hashtag conditions', () => {
    const q = tiktokKeywordQuery('자취 요리', ['KR'], '20260901', '20260928');
    expect(q.query.or).toEqual([{ operation: 'EQ', field_name: 'keyword', field_values: ['자취 요리'] }]);
  });

  it('token endpoint error → error with description, no queries, secret redacted', async () => {
    const { ctx, http } = makeCtx({ env: ENV, keywords: [kw('a')] });
    http.on(isToken, () => {
      throw new FakeHttpError(400, fx('tiktok/token-error.json'));
    });
    const res = await tiktokResearch.collect(ctx);
    expect(http.calls).toHaveLength(1);
    expect(res.errors[0]).toMatch(/token request failed \(HTTP 400\) - invalid_request: Client secret is missed/);
    expect(res.videos).toEqual([]);
  });

  it('token response without access_token (error JSON with 200) is rejected', async () => {
    const { ctx, http } = makeCtx({ env: ENV, keywords: [kw('a')] });
    http.on(isToken, () => fx('tiktok/token-error.json'));
    const res = await tiktokResearch.collect(ctx);
    expect(http.calls).toHaveLength(1);
    expect(res.errors[0]).toMatch(/token request rejected - invalid_request/);
  });

  it('401 on a query refreshes the token once and retries', async () => {
    const { ctx, http } = makeCtx({ env: ENV, keywords: [kw('a')] });
    let q = 0;
    http.on(isToken, () => fx('tiktok/token.json')).on(isQuery, () => {
      if (q++ === 0) throw new FakeHttpError(401, { data: {}, error: { code: 'access_token_invalid', message: 'expired', log_id: 'x' } });
      return fx('tiktok/query-page2.json');
    });
    const res = await tiktokResearch.collect(ctx);
    expect(http.calls.filter(isToken)).toHaveLength(2);
    expect(http.calls.filter(isQuery)).toHaveLength(2);
    expect(res.errors).toEqual([]);
    expect(res.videos).toHaveLength(1);
  });

  it('scope_not_authorized (error envelope in a 200 body) stops the run with an approval hint', async () => {
    const { ctx, http } = makeCtx({ env: ENV, keywords: [kw('a'), kw('b')] });
    http.on(isToken, () => fx('tiktok/token.json')).on(isQuery, () => fx('tiktok/error-scope.json'));
    const res = await tiktokResearch.collect(ctx);
    expect(http.calls.filter(isQuery)).toHaveLength(1);
    expect(allErrors(res)).toMatch(/scope_not_authorized/);
  });

  it('403 scope_not_authorized / 429 rate limit thrown by the client stop further queries (no throw)', async () => {
    for (const [status, code] of [
      [403, 'scope_not_authorized'],
      [429, 'rate_limit_exceeded'],
    ] as const) {
      resetTikTokTokenCache();
      const { ctx, http } = makeCtx({ env: ENV, keywords: [kw('a'), kw('b')] });
      http.on(isToken, () => fx('tiktok/token.json')).on(isQuery, () => {
        throw new FakeHttpError(status, { data: {}, error: { code, message: 'nope', log_id: 'x' } });
      });
      const res = await tiktokResearch.collect(ctx);
      expect(http.calls.filter(isQuery)).toHaveLength(1);
      expect(allErrors(res)).toContain(code);
      expect(allErrors(res)).toContain(`HTTP ${status}`);
    }
  });

  it('recognises TikTok error codes in plain-text error bodies', async () => {
    const { ctx, http } = makeCtx({ env: ENV, keywords: [kw('a'), kw('b')] });
    http.on(isToken, () => fx('tiktok/token.json')).on(isQuery, () => {
      throw new FakeHttpError(400, 'error code=daily_quota_limit_exceeded');
    });
    const res = await tiktokResearch.collect(ctx);
    expect(http.calls.filter(isQuery)).toHaveLength(1);
    expect(allErrors(res)).toMatch(/daily_quota_limit_exceeded/);
  });

  it('request budget covers the token call', async () => {
    const { ctx, http } = makeCtx({ env: ENV, keywords: [kw('a')], maxRequests: 1 });
    http.on(isToken, () => fx('tiktok/token.json')).on(isQuery, () => fx('tiktok/query-page2.json'));
    const res = await tiktokResearch.collect(ctx);
    expect(http.calls).toHaveLength(1);
    expect(allErrors(res)).toMatch(/budget \(1\) exhausted/);
  });

  it('id helpers: exact ids, id-encoded creation time, lossless JSON parse', () => {
    expect(tiktokIdTime('7689012374800827090')).toBe(Date.parse('2026-09-24T08:15:00Z'));
    expect(tiktokIdTime('702874395068494965')).toBeNull(); // doc example id does not encode a plausible time
    expect(tiktokIdTime('abc')).toBeNull();
    expect(tiktokIdOf('7689012374800827090')).toEqual({ id: '7689012374800827090', imprecise: false });
    expect(tiktokIdOf(12345)).toEqual({ id: '12345', imprecise: false });
    expect(tiktokIdOf(702874395068494965)).toEqual({ id: null, imprecise: true });
    const parsed = parseTikTokJson(fixtureText('tiktok/query-page1.json')) as any;
    expect(parsed.data.videos[2].video_id).toBe('702874395068494965');
    expect(parsed.data.videos[2].music_id).toBe('703847506349838790');
    expect(parsed.data.videos[2].view_count).toBe(1050);
  });

  it('refresh: ids grouped into ≤30-day windows from the id time, video_id IN query, no gone marking', async () => {
    const ids = ['7657342574450311890', '7683689621830894290', '7689012374800827090', '702874395068494965'];
    const w = tiktokRefreshWindows(ids, NOW);
    expect(w.undecodable).toEqual(['702874395068494965']);
    expect(w.groups).toEqual([
      { ids: ['7657342574450311890'], start: '20260701', end: '20260730' },
      { ids: ['7683689621830894290', '7689012374800827090'], start: '20260910', end: '20260928' },
    ]);

    const { ctx, http } = makeCtx({ env: ENV, refreshIds: ids });
    http.on(isToken, () => fx('tiktok/token.json')).on(isQuery, (r) => {
      const body = JSON.parse(r.body!);
      return body.query.and[0].field_values.includes('7689012374800827090') ? fx('tiktok/query-page2.json') : { data: { videos: [], has_more: false }, error: { code: 'ok' } };
    });
    const res = await tiktokResearch.collect(ctx);
    const queries = http.calls.filter(isQuery).map((r) => JSON.parse(r.body!));
    expect(queries).toHaveLength(2);
    expect(queries[1]).toEqual({
      query: { and: [{ operation: 'IN', field_name: 'video_id', field_values: ['7683689621830894290', '7689012374800827090'] }] },
      start_date: '20260910',
      end_date: '20260928',
      max_count: 100,
    });
    expect(res.gone).toEqual([]);
    expect(res.videos).toHaveLength(1);
    expect(res.videos[0].discoveredVia).toBe('tiktok-research:refresh');
  });
});

/* ================================================================== instagram-graph */

describe('instagram-graph', () => {
  const IG_USER = '17841405309211844';
  const ENV = { IG_ACCESS_TOKEN: 'ig-token-xyz', IG_USER_ID: IG_USER };
  const GRAPH = 'https://graph.facebook.com/v26.0';
  const isBD = (r: Req) => r.url.startsWith(`${GRAPH}/${IG_USER}?`);

  it('declares credentials; enabled only with token + user id', () => {
    expect(instagramGraph.requiresCredentials).toBe(true);
    expect(instagramGraph.envKeys).toEqual(['IG_ACCESS_TOKEN', 'IG_USER_ID']);
    expect(instagramGraph.isEnabled({ IG_ACCESS_TOKEN: 'x' })).toBe(false);
    expect(instagramGraph.isEnabled(ENV)).toBe(true);
    expect(instagramGraph.notes.join()).toMatch(/30/);
  });

  it('business_discovery request: field expansion, bearer header (no token in URL), keeps video/reels only', async () => {
    const { ctx, http } = makeCtx({ env: { ...ENV, IG_BUSINESS_USERNAMES: '@bluebottle' } });
    http.on(isBD, () => fx('instagram/business-discovery.json'));
    const res = await instagramGraph.collect(ctx);

    expect(http.calls).toHaveLength(1);
    const call = http.calls[0];
    expect(params(call).get('fields')).toBe(
      'business_discovery.username(bluebottle){id,username,name,profile_picture_url,followers_count,media_count,' +
        'media.limit(50){id,caption,media_type,media_product_type,like_count,comments_count,view_count,timestamp,permalink,thumbnail_url,media_url}}',
    );
    expect(call.url).not.toContain('ig-token-xyz');
    expect(call.url).not.toContain('access_token');
    expect(call.headers.Authorization).toBe('Bearer ig-token-xyz');

    expect(res.errors).toEqual([]);
    const m = byId(res);
    expect([...m.keys()]).toEqual(['17858843269216389', '17894036119131554']); // IMAGE and CAROUSEL dropped
    const reel = m.get('17858843269216389')!;
    expect(reel).toMatchObject({
      platform: 'instagram',
      url: 'https://www.instagram.com/reel/DAbCdEfGhIj/',
      title: '새 시즌 원두 소개',
      thumbnail: 'https://scontent.cdninstagram.com/v/thumb_17858843269216389.jpg',
      publishedAt: Date.UTC(2026, 8, 25, 9, 10),
      durationSec: null,
      format: 'short',
      language: null,
      country: null,
      tags: ['coffee', '커피'],
      counters: { views: 7757, likes: 5837, comments: 50, shares: null },
      discoveredVia: 'instagram-graph:business-discovery:bluebottle',
    });
    expect(reel.account).toEqual({
      platform: 'instagram',
      platformId: '17841401441775531',
      handle: '@bluebottle',
      name: 'Blue Bottle Coffee',
      url: 'https://www.instagram.com/bluebottle/',
      avatar: 'https://scontent.cdninstagram.com/v/bluebottle_profile.jpg',
      country: null,
      followers: 267788,
    });
    // Hidden like count (field omitted) and no view_count → null, not 0.
    expect(m.get('17894036119131554')!.counters).toEqual({ views: null, likes: null, comments: 11, shares: null });
  });

  it('follows media cursors up to IG_MEDIA_PAGES', async () => {
    const { ctx, http } = makeCtx({ env: { ...ENV, IG_BUSINESS_USERNAMES: 'bluebottle', IG_MEDIA_PAGES: '3' } });
    let n = 0;
    http.on(isBD, () => {
      if (n++ === 0) return fx('instagram/business-discovery.json');
      const page = fx<any>('instagram/business-discovery.json');
      page.business_discovery.media = { data: [{ ...page.business_discovery.media.data[0], id: '17800000000000009' }] };
      return page;
    });
    const res = await instagramGraph.collect(ctx);
    expect(http.calls).toHaveLength(2); // second page has no `after` cursor → stop
    expect(params(http.calls[1]).get('fields')).toBe(
      igBusinessDiscoveryFields('bluebottle', 'QVFIUmRWN3BTVjZAqdXpfRVFrcV9nYWZAYaGR1b1JfV0VoR2JzN0E3WlhhdVFR'),
    );
    expect(params(http.calls[1]).get('fields')).toContain('media.after(QVFIUmRWN3BTVjZAqdXpfRVFrcV9nYWZAYaGR1b1JfV0VoR2JzN0E3WlhhdVFR).limit(50)');
    expect(res.videos).toHaveLength(3);
  });

  it('hashtags: ig_hashtag_search → top_media + recent_media; unattributed owner; business_discovery data wins', async () => {
    const { ctx, http } = makeCtx({ env: { ...ENV, IG_BUSINESS_USERNAMES: 'bluebottle', IG_HASHTAGS: '#coffee, Coffee' } });
    http
      .on(isBD, () => fx('instagram/business-discovery.json'))
      .on(`${GRAPH}/ig_hashtag_search?`, () => fx('instagram/hashtag-search.json'))
      .on(`${GRAPH}/17843857450040591/top_media?`, () => fx('instagram/hashtag-top-media.json'))
      .on(`${GRAPH}/17843857450040591/recent_media?`, () => fx('instagram/hashtag-recent-media.json'));
    const res = await instagramGraph.collect(ctx);

    expect(http.calls).toHaveLength(4); // de-duplicated hashtag list → one search
    const search = http.callsTo(`${GRAPH}/ig_hashtag_search?`)[0];
    expect(Object.fromEntries(params(search))).toEqual({ user_id: IG_USER, q: 'coffee' });
    const top = http.callsTo(`${GRAPH}/17843857450040591/top_media?`)[0];
    expect(Object.fromEntries(params(top))).toEqual({ user_id: IG_USER, fields: IG_HASHTAG_MEDIA_FIELDS, limit: '50' });
    expect(top.headers.Authorization).toBe('Bearer ig-token-xyz');

    const m = byId(res);
    expect(m.size).toBe(4);
    const fromBd = m.get('17858843269216389')!;
    expect(fromBd.account.handle).toBe('@bluebottle');
    expect(fromBd.counters.views).toBe(7757);
    const h1 = m.get('17999123450000001')!;
    expect(h1.account.platformId).toBe(IG_UNATTRIBUTED_ACCOUNT_ID);
    expect(h1.account.followers).toBeNull();
    expect(h1.counters).toEqual({ views: null, likes: 420, comments: 7, shares: null });
    expect(h1.discoveredVia).toBe('instagram-graph:hashtag:top:coffee');
    expect(h1.format).toBe('unknown'); // media_product_type is not available on hashtag edges
    expect(h1.thumbnail).toBeNull();
    const h3 = m.get('17999123450000003')!;
    expect(h3.counters.likes).toBeNull();
    expect(h3.discoveredVia).toBe('instagram-graph:hashtag:recent:coffee');
    expect(m.has('17999123450000002')).toBe(false); // IMAGE
  });

  it('caps hashtags at 30 per 7 days and records the skipped ones', async () => {
    const tags = Array.from({ length: 32 }, (_, i) => `tag${i}`).join(',');
    const { ctx, http } = makeCtx({ env: { ...ENV, IG_HASHTAGS: tags } });
    http
      .on(`${GRAPH}/ig_hashtag_search?`, (r) => ({ data: [{ id: `h_${params(r).get('q')}` }] }))
      .on(/\/(top|recent)_media\?/, () => ({ data: [] }));
    const res = await instagramGraph.collect(ctx);
    expect(http.callsTo(`${GRAPH}/ig_hashtag_search?`)).toHaveLength(30);
    expect(http.calls).toHaveLength(90);
    expect(allErrors(res)).toMatch(/only the first 30.*tag30, tag31/);
  });

  it('token error (code 190) stops the run; per-account errors do not', async () => {
    const env = { ...ENV, IG_BUSINESS_USERNAMES: 'first,second' };
    {
      const { ctx, http } = makeCtx({ env });
      http.on(isBD, () => {
        throw new FakeHttpError(400, fx('instagram/error-token.json'));
      });
      const res = await instagramGraph.collect(ctx);
      expect(http.calls).toHaveLength(1);
      expect(res.errors[0]).toMatch(/code 190\/463: Error validating access token/);
      expect(res.errors[0]).not.toContain('ig-token-xyz');
    }
    {
      const { ctx, http } = makeCtx({ env });
      let n = 0;
      http.on(isBD, () => {
        if (n++ === 0) throw new FakeHttpError(400, { error: { message: 'Invalid user id', type: 'OAuthException', code: 110 } });
        return fx('instagram/business-discovery.json');
      });
      const res = await instagramGraph.collect(ctx);
      expect(http.calls).toHaveLength(2);
      expect(res.errors).toHaveLength(1);
      expect(res.videos).toHaveLength(2);
    }
  });

  it('a permission error stops the phase (hashtag feature not approved) but not business discovery', async () => {
    const { ctx, http } = makeCtx({ env: { ...ENV, IG_BUSINESS_USERNAMES: 'bluebottle', IG_HASHTAGS: 'a,b,c' } });
    http.on(isBD, () => fx('instagram/business-discovery.json')).on(`${GRAPH}/ig_hashtag_search?`, () => {
      throw new FakeHttpError(403, { error: { message: '(#10) To use Instagram Public Content Access your use of this endpoint must be reviewed', type: 'OAuthException', code: 10 } });
    });
    const res = await instagramGraph.collect(ctx);
    expect(http.callsTo(`${GRAPH}/ig_hashtag_search?`)).toHaveLength(1);
    expect(res.videos).toHaveLength(2);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toMatch(/code 10: \(#10\) To use Instagram Public Content Access/);
  });

  it('reports accounts without business_discovery data and accounts without videos', async () => {
    const { ctx, http } = makeCtx({ env: { ...ENV, IG_BUSINESS_USERNAMES: 'personal,photosonly' } });
    http.on(isBD, (r) => {
      if (params(r).get('fields')!.includes('username(personal)')) return { id: IG_USER };
      const bd = fx<any>('instagram/business-discovery.json');
      bd.business_discovery.media.data = bd.business_discovery.media.data.filter((m: any) => m.media_type === 'IMAGE');
      return bd;
    });
    const res = await instagramGraph.collect(ctx);
    expect(allErrors(res)).toMatch(/@personal returned no account/);
    expect(res.videos).toEqual([]);
    expect(res.accounts).toHaveLength(1);
    expect(res.accounts[0].followers).toBe(267788);
  });

  it('validates configuration without making requests', async () => {
    for (const env of [{ ...ENV, IG_USER_ID: 'me' }, ENV, { ...ENV, IG_BUSINESS_USERNAMES: 'bad name!' }]) {
      const { ctx, http } = makeCtx({ env });
      const res = await instagramGraph.collect(ctx);
      expect(http.calls).toHaveLength(0);
      expect(res.errors.length).toBeGreaterThan(0);
    }
  });

  it('isIgVideo', () => {
    expect(isIgVideo({ media_type: 'VIDEO' })).toBe(true);
    expect(isIgVideo({ media_type: 'VIDEO', media_product_type: 'REELS' })).toBe(true);
    expect(isIgVideo({ media_type: 'VIDEO', media_product_type: 'STORY' })).toBe(false);
    expect(isIgVideo({ media_type: 'IMAGE', media_product_type: 'FEED' })).toBe(false);
    expect(isIgVideo({ media_type: 'CAROUSEL_ALBUM' })).toBe(false);
  });
});

/* ================================================================== x-api */

describe('x-api', () => {
  const ENV = { X_BEARER_TOKEN: 'x-bearer-abc' };
  const SEARCH = 'https://api.x.com/2/tweets/search/recent?';
  const LOOKUP = 'https://api.x.com/2/tweets?';

  it('declares credentials; enabled only with the bearer token', () => {
    expect(xApi.requiresCredentials).toBe(true);
    expect(xApi.envKeys).toEqual(['X_BEARER_TOKEN']);
    expect(xApi.metrics).toEqual(['views', 'likes', 'comments', 'shares']);
    expect(xApi.isEnabled({})).toBe(false);
    expect(xApi.isEnabled(ENV)).toBe(true);
    expect(xApi.notes.join()).toMatch(/impression_count/);
  });

  it('recent search request construction and parsing (views = impressions)', async () => {
    const { ctx, http } = makeCtx({ env: ENV, keywords: [kw('스킨케어')] });
    http.on(SEARCH, () => fx('x/search-recent.json'));
    const res = await xApi.collect(ctx);

    expect(http.calls).toHaveLength(1); // X_PAGES_PER_QUERY defaults to 1 even though next_token is present
    const p = params(http.calls[0]);
    expect(Object.fromEntries(p)).toEqual({
      query: '(스킨케어) has:videos -is:retweet lang:ko',
      max_results: '100',
      sort_order: 'relevancy',
      'post.fields': X_POST_FIELDS,
      expansions: X_EXPANSIONS,
      'media.fields': X_MEDIA_FIELDS,
      'user.fields': X_USER_FIELDS,
    });
    expect(X_EXPANSIONS).toBe('author_id,attachments.media_keys');
    expect(X_MEDIA_FIELDS).toBe('duration_ms,preview_image_url,public_metrics,type');
    expect(X_USER_FIELDS).toBe('username,name,public_metrics,profile_image_url');
    expect(http.calls[0].headers.Authorization).toBe('Bearer x-bearer-abc');

    expect(res.errors).toEqual([]);
    const m = byId(res);
    expect([...m.keys()]).toEqual(['1971234567890123456', '1971234567890123458']); // photo-only post skipped
    const a = m.get('1971234567890123456')!;
    expect(a).toMatchObject({
      platform: 'x',
      url: 'https://x.com/XDevelopers/status/1971234567890123456',
      title: '가을 스킨케어 꿀팁 영상 #스킨케어 #뷰티',
      thumbnail: 'https://pbs.twimg.com/ext_tw_video_thumb/1971234567000000001/pu/img/preview.jpg',
      publishedAt: Date.UTC(2026, 8, 27, 9, 15),
      durationSec: 47,
      format: 'short',
      language: 'ko',
      languageSource: 'source',
      country: null,
      sourceCategory: null,
      tags: ['스킨케어', '뷰티'],
      counters: { views: 1250, likes: 38, comments: 3, shares: 8 },
      discoveredVia: 'x-api:search:스킨케어',
    });
    expect(a.account).toEqual({
      platform: 'x',
      platformId: '2244994945',
      handle: '@XDevelopers',
      name: 'X Developers',
      url: 'https://x.com/XDevelopers',
      avatar: 'https://pbs.twimg.com/profile_images/1683325380441128960/yRsRRjGO_normal.jpg',
      country: null,
      followers: 570842,
    });
    const c = m.get('1971234567890123458')!;
    expect(c.counters).toEqual({ views: null, likes: 0, comments: 0, shares: 0 }); // no impression_count → null; legacy retweet_count
    expect(c.language).toBeNull(); // qme
    expect(c.format).toBe('long');
    expect(c.title).toBe('브이로그');
  });

  it('paginates with next_token up to X_PAGES_PER_QUERY', async () => {
    const { ctx, http } = makeCtx({ env: { ...ENV, X_PAGES_PER_QUERY: '3', X_MAX_RESULTS: '5' }, keywords: [kw('a')] });
    let n = 0;
    http.on(SEARCH, () => (n++ === 0 ? fx('x/search-recent.json') : fx('x/search-recent-page2.json')));
    const res = await xApi.collect(ctx);
    expect(http.calls).toHaveLength(2);
    expect(params(http.calls[0]).get('max_results')).toBe('10'); // clamped to API minimum
    expect(params(http.calls[1]).get('next_token')).toBe('b26v89c19zqg8o3fr5xwzgc6jwdjvvwxt3t3sz2r3ubwd');
    expect(res.videos).toHaveLength(3);
  });

  it('X_SORT_ORDER=recency switches the sort order', async () => {
    const { ctx, http } = makeCtx({ env: { ...ENV, X_SORT_ORDER: 'recency' }, keywords: [kw('a')] });
    http.on(SEARCH, () => ({ meta: { result_count: 0 } }));
    const res = await xApi.collect(ctx);
    expect(params(http.calls[0]).get('sort_order')).toBe('recency');
    expect(res.videos).toEqual([]);
    expect(res.errors).toEqual([]);
  });

  it('legacy tweet.fields mode adds author_id', async () => {
    const { ctx, http } = makeCtx({ env: { ...ENV, X_FIELDS_PARAM: 'tweet.fields' }, keywords: [kw('a', 'en')] });
    http.on(SEARCH, () => ({ meta: { result_count: 0 } }));
    await xApi.collect(ctx);
    const p = params(http.calls[0]);
    expect(p.get('tweet.fields')).toBe(`${X_POST_FIELDS},author_id`);
    expect(p.has('post.fields')).toBe(false);
    expect(p.get('query')).toBe('(a) has:videos -is:retweet lang:en');
  });

  it('429 after client retries: stops, reports the reset time, never throws', async () => {
    const reset = NOW / 1000 + 900;
    const { ctx, http } = makeCtx({ env: ENV, keywords: [kw('a'), kw('b')], refreshIds: ['1960000000000000001'] });
    http.on(SEARCH, () => {
      throw new FakeHttpError(429, fx('x/error-429.json'), { 'x-rate-limit-limit': '450', 'x-rate-limit-remaining': '0', 'x-rate-limit-reset': String(reset) });
    });
    const res = await xApi.collect(ctx);
    expect(http.calls).toHaveLength(1); // no second keyword, no refresh lookup
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toMatch(/HTTP 429/);
    expect(res.errors[0]).toContain('2026-09-28T03:15:00.000Z');
  });

  it('401 stops the run and does not leak the bearer token', async () => {
    const { ctx, http } = makeCtx({ env: ENV, keywords: [kw('a'), kw('b')] });
    http.on(SEARCH, () => {
      throw new FakeHttpError(401, { title: 'Unauthorized', type: 'about:blank', status: 401, detail: 'Unauthorized x-bearer-abc' });
    });
    const res = await xApi.collect(ctx);
    expect(http.calls).toHaveLength(1);
    expect(res.errors[0]).toMatch(/HTTP 401/);
    expect(res.errors[0]).not.toContain('x-bearer-abc');
  });

  it('refresh via posts lookup: not-found → deleted, not-authorized → private', async () => {
    const ids = ['1960000000000000001', '1960000000000000002', '1960000000000000003', 'bad-id'];
    const { ctx, http } = makeCtx({ env: ENV, refreshIds: ids });
    http.on(LOOKUP, () => fx('x/tweets-lookup.json'));
    const res = await xApi.collect(ctx);
    expect(http.calls).toHaveLength(1);
    const p = params(http.calls[0]);
    expect(p.get('ids')).toBe('1960000000000000001,1960000000000000002,1960000000000000003');
    expect(p.get('post.fields')).toBe(X_POST_FIELDS);
    expect(res.gone).toEqual([
      { platformId: '1960000000000000002', status: 'deleted' },
      { platformId: '1960000000000000003', status: 'private' },
    ]);
    expect(res.videos).toHaveLength(1);
    expect(res.videos[0]).toMatchObject({
      discoveredVia: 'x-api:refresh',
      counters: { views: 250000, likes: 980, comments: 45, shares: 132 },
      durationSec: 61,
      format: 'long',
    });
    expect(res.videos[0].account.avatar).toBeNull();
  });

  it('refresh batches lookups by 100 ids', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => String(1960000000000001000n + BigInt(i)));
    const { ctx, http } = makeCtx({ env: ENV, refreshIds: ids });
    http.on(LOOKUP, () => ({ data: [] }));
    const res = await xApi.collect(ctx);
    expect(http.calls.map((c) => params(c).get('ids')!.split(',').length)).toEqual([100, 100, 50]);
    expect(res.gone).toEqual([]); // absence without a problem entry is not proof of deletion
  });

  it('query helpers', () => {
    expect(buildXQuery('아이폰 "16" (프로)', 'ko')).toBe('(아이폰 16 프로) has:videos -is:retweet lang:ko');
    expect(xShares({ repost_count: 5 })).toBe(5);
    expect(xShares({ retweet_count: 2, quote_count: 3 })).toBe(5);
    expect(xShares({ quote_count: 3 })).toBeNull();
    expect(xShares(undefined)).toBeNull();
  });

  it('skips over-long queries', async () => {
    const { ctx, http } = makeCtx({ env: ENV, keywords: [kw('가'.repeat(600))] });
    const res = await xApi.collect(ctx);
    expect(http.calls).toHaveLength(0);
    expect(allErrors(res)).toMatch(/exceeds 512/);
  });
});

/* ================================================================== twitch */

describe('twitch', () => {
  const ENV = { TWITCH_CLIENT_ID: 'cid-123', TWITCH_CLIENT_SECRET: 'csecret-456', TWITCH_TOP_GAMES: '2' };
  const TOKEN = 'jostpf5q0uzmxmkba9iyug38kjtgh';
  const H = 'https://api.twitch.tv/helix/';
  beforeEach(() => resetTwitchTokenCache());
  const isToken = (r: Req) => r.url === TWITCH_TOKEN_URL;

  function discoveryRoutes(http: FakeHttp) {
    return http
      .on(isToken, () => fx('twitch/token.json'))
      .on(`${H}games/top?`, () => fx('twitch/games-top.json'))
      .on(`${H}videos?game_id=493057`, () => fx('twitch/videos.json'))
      .on(`${H}videos?game_id=509658`, () => ({ data: [], pagination: {} }))
      .on(`${H}clips?game_id=493057`, () => fx('twitch/clips.json'))
      .on(`${H}clips?game_id=509658`, () => ({ data: [], pagination: {} }))
      .on(`${H}users?`, () => fx('twitch/users.json'));
  }

  it('declares credentials; enabled only with both keys', () => {
    expect(twitch.requiresCredentials).toBe(true);
    expect(twitch.envKeys).toEqual(['TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET']);
    expect(twitch.metrics).toEqual(['views']);
    expect(twitch.isEnabled({ TWITCH_CLIENT_ID: 'x' })).toBe(false);
    expect(twitch.isEnabled(ENV)).toBe(true);
  });

  it('duration / thumbnail / format helpers', () => {
    expect(parseTwitchDuration('3m21s')).toBe(201);
    expect(parseTwitchDuration('1h2m3s')).toBe(3723);
    expect(parseTwitchDuration('45s')).toBe(45);
    expect(parseTwitchDuration('1h')).toBe(3600);
    expect(parseTwitchDuration('5h12m7s')).toBe(18727);
    expect(parseTwitchDuration('')).toBeNull();
    expect(parseTwitchDuration('3:21')).toBeNull();
    expect(parseTwitchDuration(201)).toBeNull();
    expect(twitchThumb('https://x/thumb/index-0000000000-%{width}x%{height}.jpg')).toBe('https://x/thumb/index-0000000000-320x180.jpg');
    expect(twitchThumb('https://x/{width}x{height}.jpg')).toBe('https://x/320x180.jpg');
    expect(twitchThumb('')).toBeNull();
    expect(twitchVideoFormat('archive', 30)).toBe('live');
    expect(twitchVideoFormat('upload', 201)).toBe('long');
    expect(twitchVideoFormat('highlight', 40)).toBe('short');
    expect(twitchVideoFormat('upload', null)).toBe('unknown');
  });

  it('app token → top games → videos + clips per game → users; request construction and parsing', async () => {
    const { ctx, http } = makeCtx({ env: ENV });
    discoveryRoutes(http);
    const res = await twitch.collect(ctx);

    const tok = http.calls[0];
    expect(tok.url).toBe('https://id.twitch.tv/oauth2/token');
    expect(tok.method).toBe('POST');
    expect(tok.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(tok.body))).toEqual({
      client_id: 'cid-123',
      client_secret: 'csecret-456',
      grant_type: 'client_credentials',
    });
    for (const c of http.calls.slice(1)) {
      expect(c.headers.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(c.headers['Client-Id']).toBe('cid-123');
    }
    expect(Object.fromEntries(params(http.callsTo(`${H}games/top?`)[0]))).toEqual({ first: '2' });
    expect(Object.fromEntries(params(http.callsTo(`${H}videos?game_id=493057`)[0]))).toEqual({
      game_id: '493057',
      sort: 'views',
      period: 'week',
      first: '100',
      language: 'ko',
    });
    expect(Object.fromEntries(params(http.callsTo(`${H}clips?game_id=493057`)[0]))).toEqual({
      game_id: '493057',
      started_at: '2026-09-21T03:00:00Z',
      ended_at: '2026-09-28T03:00:00Z',
      first: '100',
    });
    expect(http.callsTo(`${H}clips?game_id=493057`)).toHaveLength(1); // TWITCH_CLIP_PAGES default 1
    const users = params(http.callsTo(`${H}users?`)[0]).getAll('id');
    expect(users.sort()).toEqual(['141981764', '500000001', '700000001']);
    expect(http.callsTo(`${H}channels/followers`)).toHaveLength(0); // no user token → followers null
    expect(http.calls).toHaveLength(1 + 1 + 4 + 1);

    expect(res.errors).toEqual([]);
    const m = byId(res);
    expect([...m.keys()].sort()).toEqual(['2580000001', '335921245', 'AsciiNameClipPogChamp', 'BraveKoreanClipKappa-AbC123xyz']);

    expect(m.get('335921245')).toMatchObject({
      platform: 'twitch',
      url: 'https://www.twitch.tv/videos/335921245',
      title: 'Twitch Developers 101',
      thumbnail:
        'https://static-cdn.jtvnw.net/cf_vods/d2nvs31859zcd8/twitchdev/335921245/ce0f3a7f-57a3-4152-bc06-0c6610189fb3/thumb/index-0000000000-320x180.jpg',
      publishedAt: Date.parse('2018-11-14T22:04:30Z'),
      durationSec: 201,
      format: 'long',
      language: 'en',
      languageSource: 'source',
      sourceCategory: 'twitch:game:PUBG: BATTLEGROUNDS',
      tags: [],
      counters: { views: 1863062, likes: null, comments: null, shares: null },
      discoveredVia: 'twitch:videos:week:PUBG: BATTLEGROUNDS',
    });
    expect(m.get('335921245')!.account).toEqual({
      platform: 'twitch',
      platformId: '141981764',
      handle: 'twitchdev',
      name: 'TwitchDev',
      url: 'https://www.twitch.tv/twitchdev',
      avatar: 'https://static-cdn.jtvnw.net/jtv_user_pictures/8a6381c7-d0c0-4576-b179-38bd5ce1d6af-profile_image-300x300.png',
      country: null,
      followers: null,
    });
    const vod = m.get('2580000001')!;
    expect(vod.format).toBe('live');
    expect(vod.durationSec).toBe(18727);
    expect(vod.thumbnail).toBeNull(); // empty thumbnail_url while processing
    expect(vod.counters.views).toBe(0); // zero stays zero
    expect(vod.description).toBeNull();

    const clip = m.get('BraveKoreanClipKappa-AbC123xyz')!;
    expect(clip).toMatchObject({
      url: 'https://clips.twitch.tv/BraveKoreanClipKappa-AbC123xyz',
      format: 'short',
      durationSec: 13,
      language: 'ko',
      counters: { views: 5321, likes: null, comments: null, shares: null },
      discoveredVia: 'twitch:clips:7d:PUBG: BATTLEGROUNDS',
    });
    expect(clip.account).toMatchObject({ platformId: '500000001', handle: 'koreanstreamer', name: '한국스트리머', url: 'https://www.twitch.tv/koreanstreamer' });
    // Broadcaster missing from /users: ASCII display name → login guess.
    expect(m.get('AsciiNameClipPogChamp')!.account).toMatchObject({ handle: 'kogamer_1', url: 'https://www.twitch.tv/kogamer_1', avatar: null });
    expect(m.has('AwkwardHelplessSalamanderSwiftRage')).toBe(false); // language en filtered out
  });

  it('TWITCH_LANGUAGE=any keeps every language and omits the filter', async () => {
    const { ctx, http } = makeCtx({ env: { ...ENV, TWITCH_LANGUAGE: 'any' } });
    discoveryRoutes(http);
    const res = await twitch.collect(ctx);
    expect(params(http.callsTo(`${H}videos?game_id=493057`)[0]).has('language')).toBe(false);
    expect(byId(res).has('AwkwardHelplessSalamanderSwiftRage')).toBe(true);
  });

  it('follower totals only with TWITCH_USER_TOKEN (user token on that call)', async () => {
    const { ctx, http } = makeCtx({ env: { ...ENV, TWITCH_USER_TOKEN: 'user-tok-789', TWITCH_MAX_FOLLOWER_LOOKUPS: '2' } });
    discoveryRoutes(http).on(`${H}channels/followers?`, () => fx('twitch/channel-followers.json'));
    const res = await twitch.collect(ctx);
    const f = http.callsTo(`${H}channels/followers?`);
    expect(f).toHaveLength(2);
    expect(f[0].headers.Authorization).toBe('Bearer user-tok-789');
    expect(f[0].headers['Client-Id']).toBe('cid-123');
    expect(params(f[0]).get('first')).toBe('1');
    const withFollowers = res.videos.filter((v) => v.account.followers === 8);
    expect(withFollowers.length).toBeGreaterThan(0);
    expect(res.videos.some((v) => v.account.followers === null)).toBe(true); // beyond the lookup cap
  });

  it('refresh: numeric ids → videos?id=, slugs → clips?id=, missing → gone, 404 → all gone', async () => {
    const { ctx, http } = makeCtx({
      env: { ...ENV, TWITCH_TOP_GAMES: '0' },
      refreshIds: ['335921245', '999', 'AwkwardHelplessSalamanderSwiftRage', 'GoneClipSlug'],
    });
    http
      .on(isToken, () => fx('twitch/token.json'))
      .on(`${H}videos?`, () => ({ data: [fx<any>('twitch/videos.json').data[0]], pagination: {} }))
      .on(`${H}clips?`, () => ({ data: [fx<any>('twitch/clips.json').data[0]], pagination: {} }))
      .on(`${H}users?`, () => fx('twitch/users.json'));
    const res = await twitch.collect(ctx);
    expect(http.callsTo(`${H}games/top`)).toHaveLength(0);
    expect(params(http.callsTo(`${H}videos?`)[0]).getAll('id')).toEqual(['335921245', '999']);
    expect(params(http.callsTo(`${H}clips?`)[0]).getAll('id')).toEqual(['AwkwardHelplessSalamanderSwiftRage', 'GoneClipSlug']);
    expect(res.gone).toEqual([
      { platformId: '999', status: 'deleted' },
      { platformId: 'GoneClipSlug', status: 'deleted' },
    ]);
    expect(res.videos.map((v) => v.discoveredVia)).toEqual(['twitch:refresh', 'twitch:refresh']);
    expect(byId(res).get('335921245')!.sourceCategory).toBeNull();

    resetTwitchTokenCache();
    const second = makeCtx({ env: { ...ENV, TWITCH_TOP_GAMES: '0' }, refreshIds: ['111', '222'] });
    second.http.on(isToken, () => fx('twitch/token.json')).on(`${H}videos?`, () => {
      throw new FakeHttpError(404, { error: 'Not Found', status: 404, message: 'Video not found' });
    });
    const res2 = await twitch.collect(second.ctx);
    expect(res2.gone).toEqual([
      { platformId: '111', status: 'deleted' },
      { platformId: '222', status: 'deleted' },
    ]);
    expect(res2.errors).toEqual([]);
  });

  it('401 refreshes the app token once and retries; token cached across runs otherwise', async () => {
    const { ctx, http } = makeCtx({ env: { ...ENV, TWITCH_TOP_GAMES: '1' } });
    let g = 0;
    http
      .on(isToken, () => fx('twitch/token.json'))
      .on(`${H}games/top?`, () => {
        if (g++ === 0) throw new FakeHttpError(401, { error: 'Unauthorized', status: 401, message: 'Invalid OAuth token' });
        return { data: [], pagination: {} };
      });
    const res = await twitch.collect(ctx);
    expect(http.calls.filter(isToken)).toHaveLength(2);
    expect(http.callsTo(`${H}games/top?`)).toHaveLength(2);
    expect(res.errors).toEqual([]);

    await twitch.collect(ctx);
    expect(http.calls.filter(isToken)).toHaveLength(2); // cached
  });

  it('429 stops the run; token failure returns an error without Helix calls', async () => {
    {
      const { ctx, http } = makeCtx({ env: ENV });
      http
        .on(isToken, () => fx('twitch/token.json'))
        .on(`${H}games/top?`, () => fx('twitch/games-top.json'))
        .on(`${H}videos?`, () => {
          throw new FakeHttpError(429, { error: 'Too Many Requests', status: 429, message: '' }, { 'Ratelimit-Reset': String(NOW / 1000 + 30) });
        });
      const res = await twitch.collect(ctx);
      expect(http.callsTo(`${H}videos?`)).toHaveLength(1);
      expect(http.callsTo(`${H}clips?`)).toHaveLength(0);
      expect(res.errors[0]).toMatch(/HTTP 429/);
      expect(res.errors[0]).toContain('2026-09-28T03:00:30.000Z');
    }
    {
      resetTwitchTokenCache();
      const { ctx, http } = makeCtx({ env: ENV });
      http.on(isToken, () => {
        throw new FakeHttpError(403, { status: 403, message: 'invalid client secret' });
      });
      const res = await twitch.collect(ctx);
      expect(http.calls).toHaveLength(1);
      expect(res.errors[0]).toMatch(/token request failed \(HTTP 403\) - invalid client secret/);
      expect(res.errors[0]).not.toContain('csecret-456');
    }
  });
});
