import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeDataset, encodeDataset, type CompactDataset } from '@vti/core';
import { adapterTimeoutFromEnv, collectAndExport, persistResult, redactSecrets, runCollection, TAGS_MAX, TITLE_MAX_CHARS } from '../src/pipeline.ts';
import { refreshCapFor, selectRefreshIds } from '../src/refresh.ts';
import { peertube, setPeertubeHostResolver } from '../src/sources/peertube.ts';
import { buildDataset } from '../src/export.ts';
import { creatorsFromSeeds, emptySeeds, loadSeeds, loadSeedsDetailed } from '../src/seeds.ts';
import { memoryLogger } from '../src/log.ts';
import { openStore, type Store } from '../src/store.ts';
import type { CollectContext, CollectResult, HttpClient, RawAccount, RawVideo, Seeds, SourceAdapter } from '../src/types.ts';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const NOW = Date.parse('2026-09-28T03:00:00Z');

const dirs: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'vti-pipe-'));
  dirs.push(d);
  return d;
}
function fileStore(): Store {
  const s = openStore(join(tempDir(), 'store.sqlite'));
  stores.push(s);
  return s;
}

function fake(id: string, platform: SourceAdapter['platform'], collect: (ctx: CollectContext) => Promise<CollectResult> | CollectResult, over: Partial<SourceAdapter> = {}): SourceAdapter {
  return {
    id,
    platform,
    label: `Fake ${id}`,
    requiresCredentials: false,
    envKeys: [],
    metrics: ['views', 'likes'],
    discovery: '테스트용 가짜 원천',
    notes: ['가짜 원천 메모'],
    docsUrl: null,
    version: 2,
    isEnabled: () => true,
    collect: async (ctx) => collect(ctx),
    ...over,
  };
}

function acc(platform: RawAccount['platform'], platformId: string, name: string, extra: Partial<RawAccount> = {}): RawAccount {
  return { platform, platformId, handle: null, name, url: `https://example.org/${platformId}`, avatar: null, country: 'KR', followers: null, ...extra };
}

function raw(platform: RawVideo['platform'], platformId: string, account: RawAccount, extra: Partial<RawVideo> = {}): RawVideo {
  return {
    platform,
    platformId,
    url: `https://example.org/v/${platformId}`,
    title: `${platformId} 축구 하이라이트`,
    description: null,
    thumbnail: null,
    publishedAt: NOW - DAY,
    durationSec: 90,
    format: 'long',
    account,
    language: 'ko',
    languageSource: 'source',
    country: 'KR',
    sourceCategory: null,
    tags: [],
    counters: { views: 1000, likes: 10, comments: null, shares: null },
    observedAt: NOW,
    discoveredVia: `${platform}:seed`,
    ...extra,
  };
}

function seeds(): Seeds {
  const s = emptySeeds();
  s.creators = [{ id: 'creator-1', name: '크리에이터 1', accountIds: ['dailymotion:owner1', 'niconico:user/7'], note: 'test' }];
  return s;
}

describe('runCollection with fake adapters', () => {
  it('collects, persists, classifies, records runs and exports a round-trippable dataset', async () => {
    const store = fileStore();
    const owner = acc('dailymotion', 'owner1', 'Owner One', { followers: 1200 });
    const refreshSeen: string[][] = [];
    let dmRun = 0;
    const dm = fake('fake-dm', 'dailymotion', (ctx) => {
      dmRun++;
      refreshSeen.push([...ctx.refreshIds]);
      expect(ctx.maxRequests).toBe(7);
      expect(ctx.seeds.creators).toHaveLength(1);
      if (dmRun === 1) {
        return {
          videos: [
            raw('dailymotion', 'dm1', owner, { sourceWindows: [{ metric: 'views', windowHours: 24, value: 400 }], sourceCategory: 'dailymotion:sport' }),
            raw('dailymotion', 'dm2', owner, { publishedAt: NOW - 20 * DAY }),
            raw('dailymotion', 'dm3', owner, { counters: { views: null, likes: null, comments: null, shares: null } }),
          ],
          accounts: [acc('dailymotion', 'lonely', 'Lonely', { followers: 7 })],
          errors: [],
        };
      }
      return {
        videos: [raw('dailymotion', 'dm1', owner, { observedAt: ctx.now, counters: { views: 1500, likes: 12, comments: null, shares: null }, discoveredVia: 'dailymotion:refresh' })],
        accounts: [],
        errors: ['요청 한도 도달: 일부 미수집'],
        gone: [{ platformId: 'dm3', status: 'deleted' }, { platformId: 'dm1', status: 'deleted' }],
      };
    });
    const snapshotAt = NOW - 5 * HOUR;
    const nico = fake('fake-nico', 'niconico', () => ({
      videos: [raw('niconico', 'sm1', acc('niconico', 'user/7', 'niconico 사용자 7'), { observedAt: snapshotAt, tags: ['ゲーム'], sourceCategory: 'niconico:ゲーム' })],
      accounts: [],
      errors: [],
    }));
    const keyed = fake('fake-keyed', 'tiktok', () => ({ videos: [], accounts: [], errors: [] }), {
      requiresCredentials: true,
      envKeys: ['FAKE_TIKTOK_KEY'],
      isEnabled: (env) => !!env.FAKE_TIKTOK_KEY,
    });
    const broken = fake('fake-broken', 'peertube', () => {
      throw new Error('boom supersecret-token-123 at https://x.test/api?access_token=abc123456&q=1');
    });
    const adapters = [dm, nico, keyed, broken];
    const env = { MY_API_TOKEN: 'supersecret-token-123' };
    const log = memoryLogger();

    const r1 = await runCollection({ db: store, adapters, env, now: NOW, seeds: seeds(), maxRequestsPerSource: 7, log });
    expect(r1.summaries.map((s) => [s.source, s.status])).toEqual([
      ['fake-dm', 'ok'],
      ['fake-nico', 'ok'],
      ['fake-keyed', 'disabled'],
      ['fake-broken', 'error'],
    ]);
    expect(r1.attempted).toBe(3);
    expect(r1.succeeded).toBe(2);
    expect(r1.totalFailure).toBe(false);
    const s1 = r1.summaries[0];
    // dm3 came without any counter: its metadata is stored, but no empty observation
    expect(s1).toMatchObject({ videosSeen: 3, videosNew: 3, observations: 2, accountsSeen: 2, gone: 0 });
    expect(s1.notes.join(' ')).toMatch(/값이 하나도 없는 영상 1개/);
    expect(r1.summaries[3].errors[0]).toContain('boom');
    expect(r1.summaries[3].errors[0]).not.toContain('supersecret-token-123');
    expect(r1.summaries[3].errors[0]).not.toContain('abc123456');
    expect(r1.summaries[2].notes[0]).toContain('FAKE_TIKTOK_KEY');
    expect(r1.classification?.classified).toBe(4);
    expect(refreshSeen[0]).toEqual([]);

    // store contents
    const obs = store.getObservations('dailymotion:dm1');
    expect(obs).toEqual([{ t: NOW, views: 1000, likes: 10, comments: null, shares: null, src: 'fake-dm@2' }]);
    expect(store.getObservations('niconico:sm1')[0].t).toBe(snapshotAt); // snapshot time, not fetch time
    expect(store.getObservations('dailymotion:dm3')).toEqual([]);
    expect(store.getVideo('dailymotion:dm3')!.lastObservedAt).toBeNull(); // still due first for the refresh tiers
    expect(store.getSourceWindows('dailymotion:dm1')).toEqual([{ metric: 'views', windowHours: 24, value: 400, observedAt: NOW, src: 'fake-dm@2' }]);
    expect(store.getFollowerObservations('dailymotion:owner1')).toEqual([{ t: NOW, value: 1200, src: 'fake-dm@2' }]);
    expect(store.getFollowerObservations('dailymotion:lonely')).toEqual([{ t: NOW, value: 7, src: 'fake-dm@2' }]);
    expect(store.getAccount('dailymotion:owner1')!.discoveredVia).toEqual(['dailymotion:seed']);
    expect(store.getClassification('dailymotion:dm1')!.categories.some((c) => c.id.startsWith('sports'))).toBe(true);
    const runs = store.listRuns(10);
    expect(runs).toHaveLength(3);
    expect(runs.find((r) => r.source === 'fake-broken')!.errors[0]).not.toContain('supersecret');
    expect(store.getSourceState('fake-keyed')).toMatchObject({ lastStatus: 'disabled', lastRunAt: null });
    expect(store.getSourceState('fake-dm')).toMatchObject({ lastStatus: 'ok', firstRunAt: NOW, lastSuccessAt: NOW });
    expect(store.getSourceState('fake-broken')).toMatchObject({ lastStatus: 'error', lastSuccessAt: null });
    expect(store.listCreators().map((c) => c.id)).toEqual(['creator-1']);
    expect(log.lines.some((l) => l.msg.includes('[fake-dm]'))).toBe(true);

    // second run: refresh ids by tier, gone handling, new observation
    const later = NOW + 2 * HOUR;
    const r2 = await runCollection({ db: store, adapters, env, now: later, seeds: seeds(), maxRequestsPerSource: 7 });
    // fresh (dm1, dm3: 1 day old) every run; dm2 (20 days, observed 2h ago) not due
    expect(refreshSeen[1].sort()).toEqual(['dm1', 'dm3']);
    expect(r2.summaries[0]).toMatchObject({ status: 'partial', videosSeen: 1, videosNew: 0, observations: 1, gone: 1 });
    expect(store.getVideo('dailymotion:dm3')!.status).toBe('deleted');
    expect(store.getVideo('dailymotion:dm1')!.status).toBe('active'); // returned in the same result: gone ignored
    expect(store.getVideo('dailymotion:dm1')!.discoveredVia).toEqual(['dailymotion:seed']);
    expect(store.getObservations('dailymotion:dm1').map((o) => o.views)).toEqual([1000, 1500]);
    expect(store.getSourceState('fake-dm')).toMatchObject({ lastStatus: 'partial', firstRunAt: NOW, lastRunAt: later, lastError: '요청 한도 도달: 일부 미수집' });

    // export -> encode -> JSON -> decode round trip
    const ds = buildDataset(store, { now: later, env, adapters });
    expect(ds.videos).toHaveLength(4);
    expect(ds.videos.find((v) => v.id === 'dailymotion:dm3')!.status).toBe('deleted');
    const cov = new Map(ds.coverage.map((c) => [c.source, c]));
    expect(cov.get('fake-dm')).toMatchObject({ enabled: true, lastStatus: 'partial', videoCount: 3, accountCount: 2, notes: ['가짜 원천 메모'] });
    expect(cov.get('fake-keyed')).toMatchObject({ enabled: false, lastStatus: 'disabled', videoCount: 0 });
    expect(cov.get('fake-broken')).toMatchObject({ enabled: true, lastStatus: 'error' });
    expect(ds.creators.find((c) => c.id === 'creator-1')!.accountIds).toEqual(['dailymotion:owner1', 'niconico:user/7']);
    expect(ds.runs).toHaveLength(6);
    expect(ds.exportNotes.some((n) => n.includes('fake-keyed(FAKE_TIKTOK_KEY)'))).toBe(true);
    const decoded = decodeDataset(JSON.parse(JSON.stringify(encodeDataset(ds))) as CompactDataset);
    expect(decoded).toEqual(ds);
  });

  it('validates adapter output: invalid rows are skipped and reported, valid ones stored', async () => {
    const store = fileStore();
    const owner = acc('dailymotion', 'o', 'O');
    const bad = fake('fake-bad', 'dailymotion', () => ({
      videos: [
        raw('dailymotion', 'good', owner),
        raw('youtube', 'wrong-platform', owner),
        raw('dailymotion', '', owner),
        raw('dailymotion', 'nan', owner, { publishedAt: Number.NaN }),
        raw('dailymotion', 'future', owner, { observedAt: NOW + DAY }),
        null as unknown as RawVideo,
      ],
      accounts: [acc('youtube', 'x', 'wrong platform account')],
      errors: [],
    }));
    const r = await runCollection({ db: store, adapters: [bad], env: {}, now: NOW, seeds: emptySeeds() });
    const s = r.summaries[0];
    expect(s.status).toBe('partial');
    expect(s.videosSeen).toBe(2); // good + future (video stored, observation rejected)
    expect(s.observations).toBe(1);
    expect(s.errors.join('\n')).toMatch(/잘못된 영상 4개/);
    expect(s.errors.join('\n')).toMatch(/잘못된 계정 1개/);
    expect(s.errors.join('\n')).toMatch(/미래인 관측 1건/);
    expect(store.getObservations('dailymotion:future')).toEqual([]);
  });

  it('isolates failures: a hanging adapter times out, its HTTP client is closed, later adapters still run', async () => {
    const store = fileStore();
    let lateCall: Promise<unknown> | null = null;
    const hang = fake('fake-hang', 'peertube', (ctx) => new Promise<CollectResult>((resolve) => {
      setTimeout(() => {
        lateCall = ctx.http.getJson('https://example.invalid/after-timeout').catch((e: unknown) => e);
        resolve({ videos: [], accounts: [], errors: [] });
      }, 150);
    }));
    const ok = fake('fake-ok', 'dailymotion', () => ({ videos: [raw('dailymotion', 'v', acc('dailymotion', 'o', 'O'))], accounts: [], errors: [] }));
    const r = await runCollection({ db: store, adapters: [hang, ok], env: {}, now: NOW, seeds: emptySeeds(), adapterTimeoutMs: 50 });
    expect(r.summaries.map((s) => s.status)).toEqual(['error', 'ok']);
    expect(r.summaries[0].errors[0]).toMatch(/시간 한도 초과/);
    await new Promise((res) => setTimeout(res, 200));
    expect(lateCall).not.toBeNull();
    expect(String(await lateCall)).toMatch(/closed/);
  });

  it('reports total failure, honours the sources filter and rejects unknown sources', async () => {
    const store = fileStore();
    const fail = fake('fake-fail', 'dailymotion', () => ({ videos: [], accounts: [], errors: ['HTTP 503'] }));
    const other = fake('fake-other', 'niconico', () => ({ videos: [], accounts: [], errors: [] }));
    const r = await runCollection({ db: store, adapters: [fail, other], sources: ['fake-fail'], env: {}, now: NOW, seeds: emptySeeds() });
    expect(r.summaries.map((s) => s.source)).toEqual(['fake-fail']);
    expect(r.summaries[0].status).toBe('error');
    expect(r.totalFailure).toBe(true);
    await expect(runCollection({ db: store, adapters: [fail], sources: ['nope'], env: {}, now: NOW, seeds: emptySeeds() })).rejects.toThrow(/unknown source/);
    const none = await runCollection({ db: store, adapters: [fake('k', 'x', () => ({ videos: [], accounts: [], errors: [] }), { isEnabled: () => false })], env: {}, now: NOW, seeds: emptySeeds() });
    expect(none.attempted).toBe(0);
    expect(none.totalFailure).toBe(true);
  });

  it('caps refresh ids per source and notes it (no silent caps)', async () => {
    const store = fileStore();
    const owner = acc('dailymotion', 'o', 'O');
    let run = 0;
    const got: string[][] = [];
    const dm = fake('fake-cap', 'dailymotion', (ctx) => {
      got.push(ctx.refreshIds);
      run++;
      return run === 1 ? { videos: [1, 2, 3, 4, 5].map((i) => raw('dailymotion', `v${i}`, owner, { publishedAt: NOW - i * HOUR })), accounts: [], errors: [] } : { videos: [], accounts: [], errors: [] };
    });
    await runCollection({ db: store, adapters: [dm], env: {}, now: NOW, seeds: emptySeeds() });
    const r2 = await runCollection({ db: store, adapters: [dm], env: {}, now: NOW + HOUR, seeds: emptySeeds(), refreshCaps: { 'fake-cap': 2 } });
    expect(got[1]).toEqual(['v1', 'v2']); // newest first
    // the adapter returned nothing: 0 of the 5 due videos were re-observed, and the note says so
    expect(r2.summaries[0].refresh).toEqual({ requested: 2, due: 5, skipped: 3, observed: 0 });
    expect(r2.summaries[0].notes.join(' ')).toMatch(/상한 2개/);
    expect(store.getSourceState('fake-cap')!.notes.join(' ')).toMatch(/5개 중 0개.*나머지 5개/);
    // cap derived from the request budget: 1 id per request for unknown sources
    expect(selectRefreshIds(store, { id: 'fake-cap', platform: 'dailymotion' }, { now: NOW + 2 * HOUR, maxRequests: 3 }).ids).toHaveLength(3);
    expect(selectRefreshIds(store, { id: 'youtube-rss', platform: 'youtube' }, { now: NOW }).ids).toEqual([]); // cannot refresh by id
    // budget-bound keyless sources get the whole due list (their adapters skip what discovery returned)
    expect(refreshCapFor('peertube', 500)).toBe(Number.POSITIVE_INFINITY);
    expect(refreshCapFor('peertube', 500, { peertube: 7 })).toBe(7);
    expect(selectRefreshIds(store, { id: 'dailymotion', platform: 'dailymotion' }, { now: NOW + 2 * HOUR, maxRequests: 1 }).ids).toHaveLength(5);
  });

  it('PeerTube refresh is not starved by fresh ids that discovery returns again (origin requests reach older videos)', async () => {
    setPeertubeHostResolver(async () => ['93.184.216.34']);
    try {
      const store = fileStore();
      const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      const item = (i: number, publishedAt: number, views: number) => ({
        uuid: uuid(i),
        name: `video ${i}`,
        url: `https://tube.example.org/videos/watch/${uuid(i)}`,
        publishedAt: new Date(publishedAt).toISOString(),
        duration: 120,
        views,
        likes: 1,
        language: { id: 'en', label: 'English' },
        account: { name: 'alice', host: 'tube.example.org', displayName: 'Alice' },
        channel: { name: 'alice_channel', host: 'tube.example.org' },
      });
      // 200 fresh videos that SepiaSearch lists every run + 50 videos 3-14 days old that it no longer lists
      const fresh = Array.from({ length: 200 }, (_, i) => item(i, NOW - (i + 1) * 10 * 60_000, 5));
      const older = Array.from({ length: 50 }, (_, i) => item(1000 + i, NOW - (4 + (i % 9)) * DAY, 50));
      const origin: string[] = [];
      const http = (): HttpClient => {
        const client = {
          requestCount: 0,
          async getJson<T>(url: string): Promise<T> {
            client.requestCount++;
            const u = new URL(url);
            if (u.host === 'sepiasearch.org') {
              const start = Number(u.searchParams.get('start'));
              const count = Number(u.searchParams.get('count'));
              return { total: fresh.length, data: fresh.slice(start, start + count) } as T;
            }
            origin.push(u.pathname.split('/').pop()!);
            const id = u.pathname.split('/').pop()!;
            const v = [...fresh, ...older].find((x) => x.uuid === id)!;
            return { ...v, views: v.views + 7 } as T;
          },
          async getText(): Promise<string> {
            throw new Error('not used');
          },
        };
        return client;
      };
      const seedsWith = (): Seeds => ({ ...emptySeeds(), peertube: [{ search: null, languageOneOf: null, sort: '-publishedAt', limit: 200 }] });
      // the store already tracks all 250 (observed 13 h ago, so the 3-14 day tier is due every ~12 h)
      const acct = acc('peertube', 'alice@tube.example.org', 'Alice');
      for (const v of [...fresh, ...older]) {
        const { id } = store.upsertVideo(raw('peertube', `${v.uuid}@tube.example.org`, acct, { publishedAt: Date.parse(v.publishedAt) }), NOW - 13 * HOUR, 'peertube');
        store.addObservation(id, { t: NOW - 13 * HOUR, views: 1, likes: null, comments: null, shares: null, src: 'peertube@1' });
      }
      // budget large enough for every due id: the point is ordering, not the production default cap
      const r = await runCollection({ db: store, adapters: [peertube], env: {}, now: NOW, seeds: seedsWith(), createHttp: () => http(), maxRequestsPerSource: 500 });
      const s = r.summaries[0];
      expect(s.refresh.due).toBe(250);
      expect(s.refresh.requested).toBe(250); // no pre-discovery cap
      const olderRequested = older.filter((v) => origin.includes(v.uuid)).length;
      expect(olderRequested).toBe(50);
      expect(s.refresh.observed).toBe(250);
      expect(s.notes.some((n) => n.startsWith('갱신 대상'))).toBe(false); // everything due was re-observed
      // counters come from the origin (views + 7), never from the stale index copy
      expect(store.getObservations(`peertube:${uuid(1000)}@tube.example.org`).map((o) => o.views)).toEqual([1, 57]);
      expect(store.getObservations(`peertube:${uuid(0)}@tube.example.org`).map((o) => o.views)).toEqual([1, 12]);
    } finally {
      setPeertubeHostResolver(null);
    }
  });

  it('notes tracked videos a feed-only source could not re-observe (youtube-rss accounting)', async () => {
    const store = fileStore();
    const ch = acc('youtube', 'UCaaaaaaaaaaaaaaaaaaaaaa', 'Channel');
    let run = 0;
    const rss = fake('youtube-rss', 'youtube', (ctx) => {
      run++;
      expect(ctx.refreshIds).toEqual([]); // cannot refresh by id
      const ids = run === 1 ? ['a', 'b', 'c'] : ['c']; // a and b dropped out of the feed
      return { videos: ids.map((id) => raw('youtube', id, ch, { observedAt: ctx.now, publishedAt: NOW - 2 * HOUR })), accounts: [], errors: [] };
    });
    await runCollection({ db: store, adapters: [rss], env: {}, now: NOW, seeds: emptySeeds() });
    const r2 = await runCollection({ db: store, adapters: [rss], env: {}, now: NOW + 3 * HOUR, seeds: emptySeeds() });
    expect(r2.summaries[0].refresh).toEqual({ requested: 0, due: 3, skipped: 0, observed: 1 });
    expect(r2.summaries[0].notes.join(' ')).toMatch(/추적 영상 3개 중 1개만.*나머지 2개는 이 원천이 ID로 다시 조회할 수 없어/);
  });

  it('never stores promotional spam, non-http(s) URLs or unbounded titles / tags', async () => {
    const store = fileStore();
    const good = acc('dailymotion', 'good', 'YTN news');
    const ad = acc('dailymotion', 'ad', '카지노,바카라,골드카지노,마이다스카지노,호텔카지노pb-1414.com');
    const dm = fake('fake-dm', 'dailymotion', () => ({
      videos: [
        raw('dailymotion', 'news', good, { title: '"가만두면 삼천리에 카지노"...김용범 경질 총공세 / YTN' }),
        raw('dailymotion', 'spam1', acc('dailymotion', 'x', 'bvqbobwz2668'), { title: '수영출장마사지-후불제 {{ ㅋ ㅏ톡sxx77 }} 수영일상탈출 ⊀Ö1Ô-3O48-6264⊁ 수영출장안마' }),
        raw('dailymotion', 'spam2', ad, { title: '#ㅂㅏ카라 #ㅋㅏ지노 [#밴쯔] ▶ 자본 2000억원 환전3분컷 안전도메인' }),
        raw('dailymotion', 'xss', good, {
          url: 'javascript:alert(document.domain)//',
          thumbnail: 'data:image/svg+xml,<svg onload=alert(1)>',
          title: 'x'.repeat(TITLE_MAX_CHARS + 50),
          tags: Array.from({ length: TAGS_MAX + 10 }, (_, i) => `tag${i}`),
          account: { ...good, url: 'javascript:alert(1)', avatar: 'vbscript:x' },
        }),
      ],
      accounts: [],
      errors: [],
    }));
    const r = await runCollection({ db: store, adapters: [dm], env: {}, now: NOW, seeds: emptySeeds() });
    const s = r.summaries[0];
    expect(s.status).toBe('ok');
    expect(s.videosSeen).toBe(2);
    expect(store.getVideo('dailymotion:spam1')).toBeNull();
    expect(store.getVideo('dailymotion:spam2')).toBeNull();
    expect(store.getAccount('dailymotion:ad')).toBeNull();
    expect(store.getVideo('dailymotion:news')).not.toBeNull(); // news that mentions a casino is kept
    const xss = store.getVideo('dailymotion:xss')!;
    expect(xss.url).toBe('');
    expect(xss.thumbnail).toBeNull();
    expect(Array.from(xss.title)).toHaveLength(TITLE_MAX_CHARS);
    expect(xss.tags).toHaveLength(TAGS_MAX);
    expect(store.getAccount('dailymotion:good')!.url).toBe('https://example.org/good');
    const notes = s.notes.join('\n');
    expect(notes).toMatch(/홍보성 스팸.*영상 2개\(계정 2개\)/);
    expect(notes).toMatch(/http\(s\)가 아닌 URL 4개/);
    expect(notes).toMatch(/잘라서 저장함/);
  });

  it('reads the per-adapter time limit from COLLECT_ADAPTER_TIMEOUT_MIN', async () => {
    expect(adapterTimeoutFromEnv({ COLLECT_ADAPTER_TIMEOUT_MIN: '12' })).toBe(12 * 60_000);
    expect(adapterTimeoutFromEnv({ COLLECT_ADAPTER_TIMEOUT_MIN: '0.001' })).toBe(60);
    expect(adapterTimeoutFromEnv({ COLLECT_ADAPTER_TIMEOUT_MIN: 'x' })).toBeUndefined();
    expect(adapterTimeoutFromEnv({})).toBeUndefined();
    const store = fileStore();
    const hang = fake('fake-hang', 'peertube', () => new Promise<CollectResult>((resolve) => setTimeout(() => resolve({ videos: [], accounts: [], errors: [] }), 400)));
    const r = await runCollection({ db: store, adapters: [hang], env: { COLLECT_ADAPTER_TIMEOUT_MIN: '0.001' }, now: NOW, seeds: emptySeeds() });
    expect(r.summaries[0].status).toBe('error');
    expect(r.summaries[0].errors[0]).toMatch(/시간 한도 초과/);
  });

  it('collectAndExport writes dataset + meta even when collection fails', async () => {
    const dir = tempDir();
    const fail = fake('fake-fail', 'dailymotion', () => {
      throw new Error('down');
    });
    const res = await collectAndExport({ db: join(dir, 'db.sqlite'), outDir: join(dir, 'out'), adapters: [fail], env: {}, now: NOW, seeds: emptySeeds(), copyTo: join(dir, 'web.json') });
    expect(res.collection.totalFailure).toBe(true);
    expect(res.exportError).toBeNull();
    expect(existsSync(join(dir, 'out', 'dataset.json'))).toBe(true);
    const ds = decodeDataset(JSON.parse(readFileSync(join(dir, 'web.json'), 'utf8')) as CompactDataset);
    expect(ds.runs[0]).toMatchObject({ source: 'fake-fail', status: 'error' });
    expect(ds.coverage[0]).toMatchObject({ source: 'fake-fail', lastStatus: 'error', lastError: '수집 실패: down' });
  });
});

describe('seeds', () => {
  const CH = (n: number) => `UC${String(n).padStart(22, '0')}`;

  it('treats missing files as empty and validates entries (skip + warn, strict throws)', () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, 'youtube-channels.json'),
      JSON.stringify([
        { channelId: CH(1), handle: '@a', name: 'A', category: 'beauty', country: 'KR', language: 'ko', creatorId: 'c1' },
        { channelId: 'not-an-id', handle: null, name: 'B', category: 'music', country: null, language: null },
        { channelId: CH(1), handle: '@dup', name: 'Dup', category: 'music', country: null, language: null },
        { channelId: CH(2), name: 'No handle field', category: 'no-such-category', extra: 'kept' },
      ]),
    );
    writeFileSync(join(dir, 'dailymotion.json'), '{ not json');
    writeFileSync(join(dir, 'niconico.json'), JSON.stringify({ not: 'an array' }));
    writeFileSync(join(dir, 'peertube.json'), JSON.stringify([{ search: null, languageOneOf: ['ko'], sort: '-views', limit: 10, sinceDays: 30 }, { search: 1, sort: 'x', limit: 0 }]));
    writeFileSync(join(dir, 'creators.json'), JSON.stringify([{ id: 'c1', name: 'C1', accountIds: ['dailymotion:x1'], note: null }, { id: 'c2', name: 'C2', accountIds: ['bogus-id'] }]));
    const warned: string[] = [];
    const r = loadSeedsDetailed(dir, { log: { warn: (m) => warned.push(m) } });
    expect(r.missing).toEqual(['keywords.json']);
    expect(r.seeds.keywords).toEqual([]);
    expect(r.seeds.dailymotion).toEqual([]);
    expect(r.seeds.niconico).toEqual([]);
    expect(r.seeds.youtubeChannels.map((c) => c.channelId)).toEqual([CH(1), CH(2)]);
    expect(r.seeds.youtubeChannels[1]).toMatchObject({ handle: null, country: null, language: null, extra: 'kept' });
    expect(r.seeds.peertube).toEqual([{ search: null, languageOneOf: ['ko'], sort: '-views', limit: 10, sinceDays: 30 }]); // extra fields pass through
    expect(r.seeds.creators.map((c) => c.id)).toEqual(['c1']);
    expect(r.warnings).toEqual(warned);
    const text = r.warnings.join('\n');
    expect(text).toMatch(/youtube-channels.json\[1\]: channelId/);
    expect(text).toMatch(/duplicate channelId/);
    expect(text).toMatch(/"no-such-category" is not a taxonomy id/);
    expect(text).toMatch(/dailymotion.json: invalid JSON/);
    expect(text).toMatch(/niconico.json: expected a JSON array/);
    expect(text).toMatch(/peertube.json\[1\]/);
    expect(text).toMatch(/creators.json\[1\]: invalid account id/);
    expect(() => loadSeedsDetailed(dir, { strict: true })).toThrow();
    // creatorId on a channel seed joins that creator's portfolio
    expect(creatorsFromSeeds(r.seeds)).toEqual([{ id: 'c1', name: 'C1', accountIds: ['dailymotion:x1', `youtube:${CH(1)}`], note: null }]);
    expect(loadSeeds(join(dir, 'missing-dir'))).toEqual(emptySeeds());
  });

  it('the repository seed files load without warnings', () => {
    const r = loadSeedsDetailed();
    expect(r.warnings).toEqual([]);
    expect(r.seeds.youtubeChannels.length).toBeGreaterThan(0);
  });

  it('runCollection skips the creators sync when creators.json is missing (does not wipe verified creators)', async () => {
    const store = fileStore();
    store.upsertCreators([{ id: 'keep', name: 'Keep', accountIds: ['dailymotion:x'], note: null }], NOW, { replace: true });
    const dir = tempDir();
    await runCollection({ db: store, adapters: [], env: {}, now: NOW, seedsDir: dir });
    expect(store.listCreators().map((c) => c.id)).toEqual(['keep']);
    writeFileSync(join(dir, 'creators.json'), '[]');
    await runCollection({ db: store, adapters: [], env: {}, now: NOW, seedsDir: dir });
    expect(store.listCreators()).toEqual([]);
  });
});

describe('helpers', () => {
  it('redactSecrets removes credential values and secret URL params', () => {
    const env = { X_BEARER_TOKEN: 'AAAAbearer', OTHER: 'visible-value', SHORT_KEY: 'abc' };
    const out = redactSecrets('Bearer AAAAbearer failed for https://api.x.com/2/tweets?ids=1&access_token=zzz; visible-value', env, ['X_BEARER_TOKEN']);
    expect(out).not.toContain('AAAAbearer');
    expect(out).not.toContain('zzz');
    expect(out).toContain('visible-value');
    expect(out).toContain('access_token=***');
  });

  it('persistResult tolerates missing arrays', () => {
    const store = fileStore();
    const stats = persistResult(store, { id: 'x', platform: 'dailymotion', version: 1 }, {} as CollectResult, NOW);
    expect(stats).toMatchObject({ videosSeen: 0, observations: 0, errors: [] });
  });
});
