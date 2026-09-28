import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeDataset, type CompactDataset } from '@vti/core';
import {
  CliUsageError,
  addYoutubeChannel,
  collectOptionsFrom,
  exportOptionsFrom,
  extractChannelId,
  loadDotEnv,
  main,
  parseArgs,
  parseChannelRef,
  parseDotEnv,
  resolvePath,
} from '../src/cli.ts';
import { DEFAULT_SEEDS_DIR } from '../src/seeds.ts';
import { openStore } from '../src/store.ts';
import type { HttpClient } from '../src/types.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'vti-cli-'));
  dirs.push(d);
  return d;
}

const ROOT = join(tmpdir(), 'vti-root');

describe('parseArgs', () => {
  it('parses commands, value options (both forms), flags and positionals', () => {
    const p = parseArgs(['collect', '--sources', 'youtube-rss,dailymotion', '--max-requests=50', '--db', 'x.sqlite', '--no-classify']);
    expect(p.command).toBe('collect');
    expect(p.values).toEqual({ sources: 'youtube-rss,dailymotion', 'max-requests': '50', db: 'x.sqlite' });
    expect([...p.flags]).toEqual(['no-classify']);
    const a = parseArgs(['add-youtube-channel', '@handle', '--category', 'beauty', '--country', 'KR', '--language=ko', '--force']);
    expect(a.positionals).toEqual(['@handle']);
    expect(a.values).toMatchObject({ category: 'beauty', country: 'KR', language: 'ko' });
    expect(a.flags.has('force')).toBe(true);
    expect(parseArgs(['export', '--copy-to-web=false']).flags.has('copy-to-web')).toBe(false);
    expect(parseArgs(['export', '--copy-to-web']).flags.has('copy-to-web')).toBe(true);
    expect(parseArgs(['stats', '--log-file', 'l.log', '--no-log-file']).values['log-file']).toBe('l.log');
  });

  it('returns help for empty argv / --help, including per-command help', () => {
    expect(parseArgs([]).command).toBe('help');
    expect(parseArgs(['--help']).command).toBe('help');
    expect(parseArgs(['-h']).command).toBe('help');
    expect(parseArgs(['add-youtube-channel', '--help']).flags.has('help')).toBe(true); // missing positional ok with --help
  });

  it('rejects bad input with CliUsageError', () => {
    expect(() => parseArgs(['bogus'])).toThrow(CliUsageError);
    expect(() => parseArgs(['collect', '--nope'])).toThrow(/unknown option --nope/);
    expect(() => parseArgs(['collect', '--sources'])).toThrow(/needs a value/);
    expect(() => parseArgs(['collect', '--sources', '--db', 'x'])).toThrow(/needs a value/);
    expect(() => parseArgs(['collect', '--sources='])).toThrow(/needs a value/);
    expect(() => parseArgs(['collect', 'extra'])).toThrow(/unexpected argument/);
    expect(() => parseArgs(['add-youtube-channel', '--category', 'beauty'])).toThrow(/needs 1 argument/);
    expect(() => parseArgs(['export', '--copy-to-web=maybe'])).toThrow(/flag/);
    expect(() => parseArgs(['export', '--category', 'x'])).toThrow(/unknown option/); // option of another command
  });
});

describe('option resolution', () => {
  it('collect options: sources list, request cap, repo-root relative paths', () => {
    const o = collectOptionsFrom(parseArgs(['collect', '--sources', ' dailymotion , niconico,dailymotion', '--max-requests', '25', '--db', 'data/t.sqlite']), ROOT);
    expect(o.sources).toEqual(['dailymotion', 'niconico']);
    expect(o.maxRequests).toBe(25);
    expect(o.db).toBe(join(ROOT, 'data', 't.sqlite'));
    expect(o.seedsDir).toBe(DEFAULT_SEEDS_DIR);
    expect(o.classify).toBe(true);
    const d = collectOptionsFrom(parseArgs(['collect']), ROOT);
    expect(d.sources).toBeUndefined();
    expect(d.maxRequests).toBeUndefined();
    expect(() => collectOptionsFrom(parseArgs(['collect', '--sources', 'nope']), ROOT)).toThrow(/unknown source/);
    expect(() => collectOptionsFrom(parseArgs(['collect', '--sources', ',']), ROOT)).toThrow(/at least one/);
    expect(() => collectOptionsFrom(parseArgs(['collect', '--max-requests', '-1']), ROOT)).toThrow(/integer/);
    expect(() => collectOptionsFrom(parseArgs(['collect', '--max-requests', '1.5']), ROOT)).toThrow(/integer/);
    // per-adapter time limit (CI keeps it well below the collect step's own timeout)
    expect(collectOptionsFrom(parseArgs(['collect', '--adapter-timeout-min', '12']), ROOT).adapterTimeoutMs).toBe(12 * 60_000);
    expect(collectOptionsFrom(parseArgs(['run', '--adapter-timeout-min=0.5']), ROOT).adapterTimeoutMs).toBe(30_000);
    expect(d.adapterTimeoutMs).toBeUndefined();
    expect(() => collectOptionsFrom(parseArgs(['collect', '--adapter-timeout-min', '0']), ROOT)).toThrow(/positive/);
  });

  it('export options: copy-to-web default depends on the command; budget; tz', () => {
    expect(exportOptionsFrom(parseArgs(['export']), ROOT)).toMatchObject({ copyToWeb: false, budgetBytes: 40_000_000, tz: 'Asia/Seoul', out: join(ROOT, 'data', 'export') });
    expect(exportOptionsFrom(parseArgs(['export', '--copy-to-web', '--budget-mb', '2.5', '--out', 'o']), ROOT)).toMatchObject({ copyToWeb: true, budgetBytes: 2_500_000, out: join(ROOT, 'o') });
    expect(exportOptionsFrom(parseArgs(['run']), ROOT).copyToWeb).toBe(true);
    expect(exportOptionsFrom(parseArgs(['run', '--no-copy-to-web']), ROOT).copyToWeb).toBe(false);
    expect(exportOptionsFrom(parseArgs(['export', '--tz', 'Australia/Sydney']), ROOT).tz).toBe('Australia/Sydney');
    expect(() => exportOptionsFrom(parseArgs(['export', '--tz', 'Mars/Base']), ROOT)).toThrow(/time zone/);
    expect(() => exportOptionsFrom(parseArgs(['export', '--budget-mb', '0']), ROOT)).toThrow(/positive/);
  });

  it('resolvePath keeps absolute paths', () => {
    const abs = join(tmpdir(), 'abs.sqlite');
    expect(resolvePath(abs, ROOT)).toBe(abs);
  });
});

describe('.env', () => {
  it('parses common .env syntax', () => {
    const env = parseDotEnv(
      [
        '# comment',
        'A=1',
        'export B = two words ',
        "C='single # not comment'",
        'D="line1\\nline2 \\"q\\""',
        'E=value # trailing comment',
        'F=',
        'not a line',
        'G="multi',
        'line"',
      ].join('\n'),
    );
    expect(env).toEqual({ A: '1', B: 'two words', C: 'single # not comment', D: 'line1\nline2 "q"', E: 'value', F: '', G: 'multi\nline' });
  });

  it('loadDotEnv never overrides existing values', () => {
    const dir = tempDir();
    writeFileSync(join(dir, '.env'), 'YOUTUBE_API_KEY=fromfile\nEXISTING=fromfile\n');
    const env: Record<string, string | undefined> = { EXISTING: 'shell' };
    expect(loadDotEnv(join(dir, '.env'), env)).toEqual(['YOUTUBE_API_KEY']);
    expect(env).toEqual({ EXISTING: 'shell', YOUTUBE_API_KEY: 'fromfile' });
    expect(loadDotEnv(join(dir, 'missing.env'), env)).toEqual([]);
  });
});

/* ------------------------------------------------------------------------------------------ */

const CHANNEL = 'UCabcdefghijklmnopqrstuv';
function feedXml(published: string, title = 'Test Channel'): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
 <title>${title}</title>
 <author><name>${title}</name><uri>https://www.youtube.com/channel/${CHANNEL}</uri></author>
 <entry>
  <id>yt:video:abc12345678</id>
  <yt:videoId>abc12345678</yt:videoId>
  <yt:channelId>${CHANNEL}</yt:channelId>
  <title>video</title>
  <link rel="alternate" href="https://www.youtube.com/watch?v=abc12345678"/>
  <published>${published}</published>
 </entry>
</feed>`;
}

function fakeHttp(pages: Record<string, string | Error>): HttpClient & { urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    requestCount: 0,
    async getJson() {
      throw new Error('not used');
    },
    async getText(url: string) {
      urls.push(url);
      const page = pages[url];
      if (page === undefined) throw Object.assign(new Error(`HTTP 404 Not Found GET ${url}`), { status: 404 });
      if (page instanceof Error) throw page;
      return page;
    },
  };
}

describe('add-youtube-channel', () => {
  const NOW = Date.parse('2026-09-28T00:00:00Z');

  it('parses channel references', () => {
    expect(parseChannelRef(CHANNEL)).toEqual({ channelId: CHANNEL, handle: null });
    expect(parseChannelRef('@RISABAE')).toEqual({ channelId: null, handle: '@RISABAE' });
    expect(parseChannelRef('RISABAE')).toEqual({ channelId: null, handle: '@RISABAE' });
    expect(parseChannelRef('https://www.youtube.com/@뚜식이/videos')).toEqual({ channelId: null, handle: '@뚜식이' });
    expect(parseChannelRef(`https://youtube.com/channel/${CHANNEL}`)).toEqual({ channelId: CHANNEL, handle: null });
    expect(() => parseChannelRef('https://example.com/@x')).toThrow(/youtube/);
    expect(() => parseChannelRef('two words')).toThrow(/cannot parse/);
  });

  it('extracts the canonical channel id from a channel page', () => {
    expect(extractChannelId(`<html><link rel="canonical" href="https://www.youtube.com/channel/${CHANNEL}"></html>`)).toBe(CHANNEL);
    expect(extractChannelId(`<meta itemprop="identifier" content="${CHANNEL}">`)).toBe(CHANNEL);
    expect(extractChannelId(`{"externalId":"${CHANNEL}"}`)).toBe(CHANNEL);
    expect(extractChannelId('<html>consent</html>')).toBeNull();
  });

  it('resolves a handle, verifies the RSS feed and appends the seed', async () => {
    const dir = tempDir();
    const file = join(dir, 'youtube-channels.json');
    writeFileSync(file, `${JSON.stringify([{ channelId: 'UC0000000000000000000000', handle: '@other', name: 'Other', category: 'music', country: 'KR', language: 'ko' }], null, 2)}\n`);
    const http = fakeHttp({
      'https://www.youtube.com/@%EB%9A%9C%EC%8B%9D%EC%9D%B4': `<link rel="canonical" href="https://www.youtube.com/channel/${CHANNEL}">`,
      [`https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL}`]: feedXml('2026-09-25T10:00:00+00:00', '뚜식이 &amp; 친구들'),
    });
    const res = await addYoutubeChannel({ ref: '@뚜식이', category: 'comedy', country: 'kr', language: 'KO' }, { http, seedsDir: dir, now: NOW });
    expect(res.seed).toEqual({ channelId: CHANNEL, handle: '@뚜식이', name: '뚜식이 & 친구들', category: 'comedy', country: 'KR', language: 'ko' });
    expect(res.newestUploadAgeDays).toBeCloseTo(2.6, 1);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    expect(saved).toHaveLength(2);
    expect(saved[1]).toEqual(res.seed);
    // duplicates are refused (by id and by handle)
    await expect(addYoutubeChannel({ ref: CHANNEL, category: 'comedy' }, { http, seedsDir: dir, now: NOW })).rejects.toThrow(/already/);
    await expect(addYoutubeChannel({ ref: '@뚜식이', category: 'comedy' }, { http, seedsDir: dir, now: NOW })).rejects.toThrow(/already/);
  });

  it('refuses inactive channels unless --force, unknown categories and unresolvable handles', async () => {
    const dir = tempDir();
    const http = fakeHttp({
      [`https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL}`]: feedXml('2025-01-01T00:00:00+00:00'),
      'https://www.youtube.com/@consent': '<html>Before you continue</html>',
    });
    await expect(addYoutubeChannel({ ref: CHANNEL, category: 'beauty' }, { http, seedsDir: dir, now: NOW })).rejects.toThrow(/inactive/);
    expect(existsSync(join(dir, 'youtube-channels.json'))).toBe(false);
    const forced = await addYoutubeChannel({ ref: CHANNEL, category: 'beauty/skincare', force: true, creatorId: 'c1' }, { http, seedsDir: dir, now: NOW });
    expect(forced.seed).toMatchObject({ channelId: CHANNEL, handle: null, name: 'Test Channel', category: 'beauty/skincare', creatorId: 'c1' });
    expect(JSON.parse(readFileSync(join(dir, 'youtube-channels.json'), 'utf8'))).toHaveLength(1);
    await expect(addYoutubeChannel({ ref: CHANNEL, category: 'not-a-category' }, { http, seedsDir: dir, now: NOW })).rejects.toThrow(/taxonomy id/);
    await expect(addYoutubeChannel({ ref: '@consent', category: 'beauty' }, { http, seedsDir: dir, now: NOW })).rejects.toThrow(/canonical/);
    await expect(addYoutubeChannel({ ref: '@missing', category: 'beauty' }, { http, seedsDir: dir, now: NOW })).rejects.toThrow(/cannot open/);
    await expect(addYoutubeChannel({ ref: CHANNEL, category: 'beauty', country: 'Korea' }, { http, seedsDir: dir, now: NOW })).rejects.toThrow(/alpha-2/);
  });
});

/* ------------------------------------------------------------------------------------------ */

describe('main', () => {
  function io() {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, deps: { stdout: { write: (s: string) => out.push(s) }, stderr: { write: (s: string) => err.push(s) } } };
  }

  it('prints usage (exit 0) and usage errors (exit 2)', async () => {
    const a = io();
    expect(await main(['--help'], { ...a.deps, loadEnv: false })).toBe(0);
    expect(a.out.join('')).toContain('add-youtube-channel');
    const b = io();
    expect(await main(['collect', '--sources', 'nope', '--no-log-file'], { ...b.deps, loadEnv: false, root: tempDir(), env: {} })).toBe(2);
    expect(b.err.join('')).toMatch(/unknown source/);
    const c = io();
    expect(await main(['frobnicate'], { ...c.deps, loadEnv: false })).toBe(2);
  });

  it('stats reports a missing store (exit 1) and an existing one (exit 0, JSON)', async () => {
    const root = tempDir();
    const a = io();
    expect(await main(['stats', '--no-log-file'], { ...a.deps, loadEnv: false, root, env: {} })).toBe(1);
    const store = openStore(join(root, 'data', 'store.sqlite'));
    store.updateSourceState('dailymotion', { runAt: 1, status: 'ok', success: true, now: 1 });
    store.close();
    const b = io();
    expect(await main(['stats', '--json', '--no-log-file'], { ...b.deps, loadEnv: false, root, env: {} })).toBe(0);
    const parsed = JSON.parse(b.out.join(''));
    expect(parsed.counts.videos).toBe(0);
    expect(parsed.sources[0].source).toBe('dailymotion');
    const c = io();
    expect(await main(['stats', '--no-log-file'], { ...c.deps, loadEnv: false, root, env: {} })).toBe(0);
    expect(c.out.join('')).toMatch(/videos 0/);
  });

  it('export writes dataset.json + meta.json from the store, loads .env and writes a log file', async () => {
    const root = tempDir();
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(join(root, '.env'), 'X_BEARER_TOKEN=from-dotenv-123\n');
    const seedsDir = join(root, 'seeds');
    mkdirSync(seedsDir);
    writeFileSync(join(seedsDir, 'creators.json'), JSON.stringify([{ id: 'c1', name: 'C1', accountIds: ['dailymotion:o'], note: null }]));
    const store = openStore(join(root, 'data', 'store.sqlite'));
    store.upsertVideo(
      {
        platform: 'dailymotion', platformId: 'v1', url: 'u', title: '먹방 영상', description: null, thumbnail: null, publishedAt: 1_790_000_000_000,
        durationSec: null, format: 'unknown', account: { platform: 'dailymotion', platformId: 'o', handle: null, name: 'O', url: 'u', avatar: null, country: null, followers: null },
        language: null, languageSource: null, country: null, sourceCategory: null, tags: [], counters: { views: 1, likes: null, comments: null, shares: null }, observedAt: 1_790_000_000_000, discoveredVia: 't',
      },
      1_790_000_000_000,
      'dailymotion',
    );
    store.upsertAccount({ platform: 'dailymotion', platformId: 'o', handle: null, name: 'O', url: 'u', avatar: null, country: null, followers: null }, 1_790_000_000_000);
    store.addObservation('dailymotion:v1', { t: 1_790_000_000_000, views: 1, likes: null, comments: null, shares: null, src: 'dailymotion@1' });
    store.close();

    const env: Record<string, string | undefined> = {};
    const a = io();
    const code = await main(['export', '--out', 'out', '--seeds', 'seeds', '--log-file', 'logs/x.log'], { ...a.deps, root, env, now: () => 1_790_000_100_000 });
    expect(code).toBe(0);
    expect(env.X_BEARER_TOKEN).toBe('from-dotenv-123');
    const ds = decodeDataset(JSON.parse(readFileSync(join(root, 'out', 'dataset.json'), 'utf8')) as CompactDataset);
    expect(ds.videos.map((v) => v.id)).toEqual(['dailymotion:v1']);
    expect(ds.videos[0].categories.some((c) => c.id.startsWith('food'))).toBe(true); // classified during export
    expect(ds.creators.map((c) => c.id)).toEqual(['c1']);
    expect(ds.coverage.find((c) => c.source === 'x-api')!.enabled).toBe(true); // credentials from .env
    const meta = JSON.parse(readFileSync(join(root, 'out', 'meta.json'), 'utf8'));
    expect(meta.counts.videos).toBe(1);
    expect(a.out.join('')).toMatch(/exported 1 video/);
    expect(readFileSync(join(root, 'logs', 'x.log'), 'utf8')).toMatch(/classify/);
  });
});
