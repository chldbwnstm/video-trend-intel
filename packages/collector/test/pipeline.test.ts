import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeDataset, encodeDataset, type CompactDataset } from '@vti/core';
import { collectAndExport, persistResult, redactSecrets, runCollection } from '../src/pipeline.ts';
import { selectRefreshIds } from '../src/refresh.ts';
import { buildDataset } from '../src/export.ts';
import { creatorsFromSeeds, emptySeeds, loadSeeds, loadSeedsDetailed } from '../src/seeds.ts';
import { memoryLogger } from '../src/log.ts';
import { openStore, type Store } from '../src/store.ts';
import type { CollectContext, CollectResult, RawAccount, RawVideo, Seeds, SourceAdapter } from '../src/types.ts';

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
    expect(s1).toMatchObject({ videosSeen: 3, videosNew: 3, observations: 3, accountsSeen: 2, gone: 0 });
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
    expect(store.getObservations('dailymotion:dm3')[0]).toMatchObject({ views: null, likes: null });
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
    expect(r2.summaries[0].refresh).toEqual({ requested: 2, due: 5, skipped: 3 });
    expect(r2.summaries[0].notes.join(' ')).toMatch(/상한 2개/);
    expect(store.getSourceState('fake-cap')!.notes.join(' ')).toMatch(/나머지 3개/);
    // cap derived from the request budget: 1 id per request for unknown sources
    expect(selectRefreshIds(store, { id: 'fake-cap', platform: 'dailymotion' }, { now: NOW + 2 * HOUR, maxRequests: 3 }).ids).toHaveLength(3);
    expect(selectRefreshIds(store, { id: 'youtube-rss', platform: 'youtube' }, { now: NOW }).ids).toEqual([]); // cannot refresh by id
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
