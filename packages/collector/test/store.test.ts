import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { OBS_DEDUPE_WINDOW_MS, SCHEMA_VERSION, openStore, videoIdOf, type Store } from '../src/store.ts';
import type { RawAccount, RawVideo } from '../src/types.ts';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const NOW = Date.parse('2026-09-28T12:00:00Z');

const dirs: string[] = [];
const stores: Store[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'vti-store-'));
  dirs.push(d);
  return d;
}
function mem(): Store {
  const s = openStore(':memory:');
  stores.push(s);
  return s;
}
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function account(over: Partial<RawAccount> = {}): RawAccount {
  return {
    platform: 'dailymotion',
    platformId: 'acc1',
    handle: 'acc1handle',
    name: 'Account One',
    url: 'https://www.dailymotion.com/acc1',
    avatar: null,
    country: 'KR',
    followers: null,
    ...over,
  };
}

function video(over: Partial<RawVideo> = {}): RawVideo {
  return {
    platform: 'dailymotion',
    platformId: 'x1',
    url: 'https://www.dailymotion.com/video/x1',
    title: '뉴스 영상',
    description: '설명',
    thumbnail: null,
    publishedAt: NOW - 2 * DAY,
    durationSec: 120,
    format: 'long',
    account: account(),
    language: 'ko',
    languageSource: 'source',
    country: 'KR',
    sourceCategory: 'dailymotion:news',
    tags: ['뉴스'],
    counters: { views: 100, likes: 5, comments: null, shares: null },
    observedAt: NOW,
    discoveredVia: 'dailymotion:trending:kr',
    ...over,
  };
}

const obs = (t: number, views: number | null, extra: Partial<{ likes: number | null; comments: number | null; shares: number | null; src: string }> = {}) => ({
  t,
  views,
  likes: extra.likes ?? null,
  comments: extra.comments ?? null,
  shares: extra.shares ?? null,
  src: extra.src ?? 'dailymotion@1',
});

describe('migrations', () => {
  it('creates the schema, sets user_version and is idempotent on reopen', () => {
    const path = join(tempDir(), 'nested', 'store.sqlite');
    const s1 = openStore(path);
    expect(s1.schemaVersion).toBe(SCHEMA_VERSION);
    const tables = (s1.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    for (const t of ['accounts', 'videos', 'observations', 'source_windows', 'follower_obs', 'video_classification', 'creators', 'creator_accounts', 'runs', 'run_errors', 'source_state', 'video_sources', 'account_sources']) {
      expect(tables).toContain(t);
    }
    const mode = (s1.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode;
    expect(mode).toBe('wal');
    s1.upsertVideo(video(), NOW, 'dailymotion');
    s1.close();

    const s2 = openStore(path);
    expect(s2.schemaVersion).toBe(SCHEMA_VERSION);
    expect(s2.getVideo('dailymotion:x1')?.title).toBe('뉴스 영상');
    s2.close();
    const s3 = openStore(path); // third open: still fine
    expect(s3.counts().videos).toBe(1);
    s3.close();
  });

  it('migrates a database whose tables exist but user_version is 0', () => {
    const path = join(tempDir(), 'legacy.sqlite');
    const s1 = openStore(path);
    s1.db.exec('PRAGMA user_version = 0');
    s1.close();
    const s2 = openStore(path);
    expect(s2.schemaVersion).toBe(SCHEMA_VERSION);
    s2.close();
  });

  it('refuses a database from a newer collector', () => {
    const path = join(tempDir(), 'future.sqlite');
    const { DatabaseSync: Db } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (p: string) => DatabaseSync };
    const db = new Db(path);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 5}`);
    db.close();
    expect(() => openStore(path)).toThrow(/newer than this collector/);
  });
});

describe('accounts and videos', () => {
  it('upsertAccount keeps trackedSince, merges discoveredVia and never nulls known fields', () => {
    const s = mem();
    expect(s.upsertAccount(account({ seedCategory: 'news_politics' }), NOW, 'seed-a', 'dailymotion')).toBe(true);
    expect(s.upsertAccount(account({ handle: null, avatar: 'https://img/a.jpg', country: null, seedCategory: null }), NOW + DAY, ['seed-b', 'seed-a'])).toBe(false);
    const a = s.getAccount('dailymotion:acc1')!;
    expect(a.trackedSince).toBe(NOW);
    expect(a.lastSeenAt).toBe(NOW + DAY);
    expect(a.handle).toBe('acc1handle');
    expect(a.avatar).toBe('https://img/a.jpg');
    expect(a.country).toBe('KR');
    expect(a.seedCategory).toBe('news_politics');
    expect(a.discoveredVia).toEqual(['seed-a', 'seed-b']);
  });

  it('upsertVideo inserts, then updates mutable fields while keeping firstSeenAt and merging discoveredVia', () => {
    const s = mem();
    expect(s.upsertVideo(video(), NOW, 'dailymotion')).toEqual({ id: 'dailymotion:x1', isNew: true });
    const first = s.getVideo('dailymotion:x1')!;
    expect(first.firstSeenAt).toBe(NOW);
    expect(first.discoveredVia).toEqual(['dailymotion:trending:kr']);

    const r = s.upsertVideo(
      video({
        title: '수정된 제목',
        description: null,
        tags: [],
        durationSec: null,
        format: 'unknown',
        language: 'ja',
        languageSource: 'detected',
        discoveredVia: 'dailymotion:recent:kr',
      }),
      NOW + HOUR,
      'dailymotion',
    );
    expect(r.isNew).toBe(false);
    const v = s.getVideo('dailymotion:x1')!;
    expect(v.firstSeenAt).toBe(NOW);
    expect(v.lastSeenAt).toBe(NOW + HOUR);
    expect(v.title).toBe('수정된 제목');
    expect(v.description).toBe('설명'); // null does not erase
    expect(v.tags).toEqual(['뉴스']); // empty tags do not erase
    expect(v.durationSec).toBe(120);
    expect(v.format).toBe('long');
    expect(v.language).toBe('ko'); // detected language does not override a source language
    expect(v.languageSource).toBe('source');
    expect(v.discoveredVia).toEqual(['dailymotion:trending:kr', 'dailymotion:recent:kr']);
    expect(v.textHash).not.toBe(first.textHash); // title changed

    // refresh re-observations are not a discovery method
    s.upsertVideo(video({ discoveredVia: 'dailymotion:refresh' }), NOW + 2 * HOUR);
    expect(s.getVideo('dailymotion:x1')!.discoveredVia).toEqual(['dailymotion:trending:kr', 'dailymotion:recent:kr']);
  });

  it('prefers a native source category over a seed-derived one, and keeps text hash stable for identical text', () => {
    const s = mem();
    s.upsertVideo(video({ platform: 'youtube', platformId: 'yt1', account: account({ platform: 'youtube', platformId: 'UC1' }), sourceCategory: 'youtube:category:10' }), NOW);
    const h1 = s.getVideo('youtube:yt1')!.textHash;
    s.upsertVideo(video({ platform: 'youtube', platformId: 'yt1', account: account({ platform: 'youtube', platformId: 'UC1' }), sourceCategory: 'youtube:seed:music' }), NOW + HOUR);
    const v = s.getVideo('youtube:yt1')!;
    expect(v.sourceCategory).toBe('youtube:category:10');
    expect(v.textHash).toBe(h1);
  });

  it('markGone changes status only, never deletes; a returned video is re-activated', () => {
    const s = mem();
    s.upsertVideo(video(), NOW);
    s.addObservation('dailymotion:x1', obs(NOW, 100));
    expect(s.markGone('dailymotion:x1', 'deleted', NOW + HOUR)).toBe(true);
    expect(s.markGone('dailymotion:x1', 'deleted', NOW + 2 * HOUR)).toBe(false); // unchanged
    expect(s.markGone('dailymotion:missing', 'deleted', NOW)).toBe(false);
    expect(s.markGone('dailymotion:x1', 'active', NOW)).toBe(false);
    const v = s.getVideo('dailymotion:x1')!;
    expect(v.status).toBe('deleted');
    expect(v.statusChangedAt).toBe(NOW + HOUR);
    expect(s.getObservations('dailymotion:x1')).toHaveLength(1);
    s.upsertVideo(video(), NOW + DAY);
    expect(s.getVideo('dailymotion:x1')!.status).toBe('active');
  });
});

describe('observations', () => {
  it('skips exact duplicates (video, t, src)', () => {
    const s = mem();
    s.upsertVideo(video(), NOW);
    expect(s.addObservation('dailymotion:x1', obs(NOW, 100))).toBe(true);
    expect(s.addObservation('dailymotion:x1', obs(NOW, 100))).toBe(false);
    expect(s.addObservation('dailymotion:x1', obs(NOW, 999))).toBe(false); // same key, first write wins (append-only)
    expect(s.getObservations('dailymotion:x1')).toHaveLength(1);
  });

  it('skips identical counters less than 15 minutes after the previous observation', () => {
    const s = mem();
    s.upsertVideo(video(), NOW);
    expect(s.addObservation('dailymotion:x1', obs(NOW, 100, { likes: 5 }))).toBe(true);
    expect(s.addObservation('dailymotion:x1', obs(NOW + 10 * 60_000, 100, { likes: 5 }))).toBe(false);
    expect(s.addObservation('dailymotion:x1', obs(NOW + 10 * 60_000, 101, { likes: 5 }))).toBe(true); // changed counters
    expect(s.addObservation('dailymotion:x1', obs(NOW + 11 * 60_000, 101, { likes: null }))).toBe(true); // null differs from 5
    expect(s.addObservation('dailymotion:x1', obs(NOW + 11 * 60_000 + OBS_DEDUPE_WINDOW_MS, 101))).toBe(true); // >= 15 min later
    expect(s.getObservations('dailymotion:x1').map((o) => o.views)).toEqual([100, 101, 101, 101]);
  });

  it('keeps null counters as null (never 0) and rejects invalid values', () => {
    const s = mem();
    s.upsertVideo(video(), NOW);
    s.addObservation('dailymotion:x1', { t: NOW, views: 10, likes: null, comments: -3, shares: Number.NaN, src: 'dailymotion@1' });
    const [o] = s.getObservations('dailymotion:x1');
    expect(o).toEqual({ t: NOW, views: 10, likes: null, comments: null, shares: null, src: 'dailymotion@1' });
  });

  it('tracks last_observed_at / last_views from the latest observation, also for out-of-order inserts', () => {
    const s = mem();
    s.upsertVideo(video(), NOW);
    s.addObservation('dailymotion:x1', obs(NOW, 100));
    s.addObservation('dailymotion:x1', obs(NOW + 2 * HOUR, 300));
    s.addObservation('dailymotion:x1', obs(NOW + HOUR, 200)); // late arrival
    s.addObservation('dailymotion:x1', obs(NOW + 3 * HOUR, null)); // views not provided
    const v = s.getVideo('dailymotion:x1')!;
    expect(v.lastObservedAt).toBe(NOW + 3 * HOUR);
    expect(v.lastViews).toBe(300);
    expect(s.getObservations('dailymotion:x1').map((o) => o.t)).toEqual([NOW, NOW + HOUR, NOW + 2 * HOUR, NOW + 3 * HOUR]);
  });

  it('stores source windows and follower observations with dedupe', () => {
    const s = mem();
    s.upsertVideo(video(), NOW);
    const w = { metric: 'views' as const, windowHours: 24, value: 50, observedAt: NOW, src: 'dailymotion@1' };
    expect(s.addSourceWindows('dailymotion:x1', [w, { ...w, windowHours: 168, value: 90 }, { ...w, value: -1, windowHours: 720 }])).toBe(2);
    expect(s.addSourceWindows('dailymotion:x1', [w])).toBe(0);
    expect(s.getSourceWindows('dailymotion:x1')).toHaveLength(2);

    expect(s.addFollowerObservation('dailymotion:acc1', { t: NOW, value: 1000, src: 's@1' })).toBe(true);
    expect(s.addFollowerObservation('dailymotion:acc1', { t: NOW + 5 * 60_000, value: 1000, src: 's@1' })).toBe(false);
    expect(s.addFollowerObservation('dailymotion:acc1', { t: NOW + 5 * 60_000, value: 1001, src: 's@1' })).toBe(true);
    expect(s.addFollowerObservation('dailymotion:acc1', { t: NOW + DAY, value: 1001, src: 's@1' })).toBe(true);
    expect(s.getFollowerObservations('dailymotion:acc1').map((p) => p.value)).toEqual([1000, 1001, 1001]);
  });

  it('batch-writes 10k videos with observations quickly inside one transaction', () => {
    const s = mem();
    const t0 = Date.now();
    s.transaction(() => {
      for (let i = 0; i < 10_000; i++) {
        const { id } = s.upsertVideo(video({ platformId: `v${i}`, account: account({ platformId: `a${i % 300}` }) }), NOW, 'dailymotion');
        s.addObservation(id, obs(NOW, i));
      }
    });
    const elapsed = Date.now() - t0;
    expect(s.counts().videos).toBe(10_000);
    expect(s.counts().observations).toBe(10_000);
    expect(elapsed).toBeLessThan(15_000);
  });

  it('rolls back a failed transaction', () => {
    const s = mem();
    expect(() =>
      s.transaction(() => {
        s.upsertVideo(video(), NOW);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(s.getVideo('dailymotion:x1')).toBeNull();
    s.upsertVideo(video(), NOW); // store still usable
    expect(s.getVideo('dailymotion:x1')).not.toBeNull();
  });
});

describe('tiered refresh candidates', () => {
  function seed(s: Store, id: string, ageMs: number, lastObsAgo: number | null, views: number | null = 100, status?: 'deleted' | 'private' | 'unknown') {
    const { id: vid } = s.upsertVideo(video({ platformId: id, publishedAt: NOW - ageMs }), NOW - (lastObsAgo ?? 0));
    if (lastObsAgo !== null) s.addObservation(vid, obs(NOW - lastObsAgo, views));
    if (status) s.markGone(vid, status, NOW - (lastObsAgo ?? 0));
    return vid;
  }

  it('applies the SPEC tiers and orders by priority', () => {
    const s = mem();
    seed(s, 'fresh-new', 1 * HOUR, 10 * 60_000); // < 3d: every run, even if just observed
    seed(s, 'fresh-old', 2 * DAY, 30 * 60_000);
    seed(s, 'recent-due', 5 * DAY, 13 * HOUR); // 3-14d, 12h interval
    seed(s, 'recent-early', 5 * DAY, 6 * HOUR);
    seed(s, 'recent-slack', 5 * DAY, 11.5 * HOUR); // within the 95% slack of 12h
    seed(s, 'mature-due', 30 * DAY, 25 * HOUR); // 14-90d, daily
    seed(s, 'mature-early', 30 * DAY, 10 * HOUR);
    seed(s, 'never-observed', 20 * DAY, null);
    seed(s, 'deleted', 1 * HOUR, 5 * DAY, 100, 'deleted');
    seed(s, 'private-due', 10 * DAY, 8 * DAY, 100, 'private');
    seed(s, 'private-early', 10 * DAY, 2 * DAY, 100, 'private');
    // other platform must not appear
    s.upsertVideo(video({ platform: 'youtube', platformId: 'yt', account: account({ platform: 'youtube' }), publishedAt: NOW - HOUR }), NOW);

    const c = s.getRefreshCandidates('dailymotion', NOW);
    expect(c.map((x) => x.platformId)).toEqual(['fresh-new', 'fresh-old', 'recent-due', 'recent-slack', 'never-observed', 'mature-due', 'private-due']);
    expect(c.map((x) => x.tier)).toEqual(['fresh', 'fresh', 'recent', 'recent', 'mature', 'mature', 'unavailable']);
    // adapter id resolves to its platform
    expect(s.getRefreshCandidates('dailymotion', NOW).length).toBe(c.length);
    expect(() => s.getRefreshCandidates('no-such-source', NOW)).toThrow(/unknown source/);
  });

  it('refreshes old videos weekly and only in the top slice by views', () => {
    const s = mem();
    for (let i = 0; i < 10; i++) seed(s, `old${i}`, 200 * DAY, 8 * DAY, (i + 1) * 1000);
    seed(s, 'old-recently-seen', 200 * DAY, 2 * DAY, 1_000_000);
    const c = s.getRefreshCandidates('dailymotion', NOW, { oldTopMin: 3, oldTopFraction: 0.2 });
    // 11 old videos: slice = max(3, ceil(11*0.2)=3) => views >= 3rd highest (9000; 1M is the highest but not due)
    expect(c.map((x) => x.platformId).sort()).toEqual(['old8', 'old9']);
    expect(c.every((x) => x.tier === 'old')).toBe(true);
  });
});

describe('runs, source state, creators, classification', () => {
  it('records runs and errors (with cap), newest first; unfinished runs read as error', () => {
    const s = mem();
    s.recordRun({ id: 'r1', source: 'dailymotion', startedAt: NOW - HOUR });
    s.finishRun('r1', { finishedAt: NOW - HOUR + 1000, status: 'partial', videosSeen: 3, videosNew: 2, observations: 3, requests: 4, errors: ['e1', 'e2'] });
    s.recordRun({ id: 'r2', source: 'peertube', startedAt: NOW });
    s.recordRun({ id: 'r3', source: 'niconico', startedAt: NOW - 2 * HOUR });
    s.finishRun('r3', { finishedAt: NOW, status: 'error', videosSeen: 0, videosNew: 0, observations: 0, requests: 1, errors: Array.from({ length: 250 }, (_, i) => `err ${i}`) });
    const runs = s.listRuns(10);
    expect(runs.map((r) => r.id)).toEqual(['r2', 'r1', 'r3']);
    expect(runs[0].status).toBe('error');
    expect(runs[0].finishedAt).toBeNull();
    expect(runs[0].errors[0]).toMatch(/완료 기록 없음/);
    expect(runs[1]).toMatchObject({ status: 'partial', videosSeen: 3, videosNew: 2, observations: 3, requests: 4, errors: ['e1', 'e2'] });
    expect(runs[2].errors).toHaveLength(200);
    expect(runs[2].errors[199]).toMatch(/외 오류 51건/);
    expect(s.listRuns(1)).toHaveLength(1);
    expect(s.listRuns(10, 'dailymotion').map((r) => r.id)).toEqual(['r1']);
  });

  it('updates source state: first run kept, success tracked, disabled keeps last run', () => {
    const s = mem();
    s.updateSourceState('dailymotion', { runAt: NOW - DAY, status: 'ok', success: true, now: NOW - DAY });
    s.updateSourceState('dailymotion', { runAt: NOW, status: 'error', success: false, error: 'boom', notes: ['n1'], now: NOW });
    expect(s.getSourceState('dailymotion')).toMatchObject({ firstRunAt: NOW - DAY, lastRunAt: NOW, lastSuccessAt: NOW - DAY, lastStatus: 'error', lastError: 'boom', notes: ['n1'] });
    s.updateSourceState('dailymotion', { runAt: null, status: 'disabled', now: NOW + 1 });
    expect(s.getSourceState('dailymotion')).toMatchObject({ firstRunAt: NOW - DAY, lastRunAt: NOW, lastSuccessAt: NOW - DAY, lastStatus: 'disabled' });
    expect(s.getSourceState('x-api')).toBeNull();
    expect(s.listSourceStates().map((x) => x.source)).toEqual(['dailymotion']);
  });

  it('upsertCreators replaces verified creators from seeds', () => {
    const s = mem();
    s.upsertCreators([
      { id: 'c1', name: 'C1', accountIds: ['youtube:UCa', 'dailymotion:x'], note: null },
      { id: 'c2', name: 'C2', accountIds: ['youtube:UCb'], note: 'n' },
    ], NOW, { replace: true });
    s.upsertCreators([{ id: 'c1', name: 'C1 renamed', accountIds: ['youtube:UCa'], note: null }], NOW + 1, { replace: true });
    const cs = s.listCreators();
    expect(cs).toEqual([{ id: 'c1', name: 'C1 renamed', linkStatus: 'verified', note: null, accountIds: ['youtube:UCa'], updatedAt: NOW + 1 }]);
  });

  it('lists videos needing classification by version, text hash and account seed', () => {
    const s = mem();
    s.upsertAccount(account({ seedCategory: 'news_politics' }), NOW);
    s.upsertVideo(video(), NOW);
    expect(s.listVideosNeedingClassification('c1', 's1').map((v) => v.id)).toEqual(['dailymotion:x1']);
    const v = s.getVideo('dailymotion:x1')!;
    s.setClassification(v.id, { categories: [], topics: [], sponsorship: null, classifierVersion: 'c1', sponsorshipVersion: 's1', textHash: v.textHash, accountSeed: 'news_politics' }, NOW);
    expect(s.listVideosNeedingClassification('c1', 's1')).toHaveLength(0);
    expect(s.listVideosNeedingClassification('c2', 's1')).toHaveLength(1);
    expect(s.listVideosNeedingClassification('c1', 's2')).toHaveLength(1);
    s.upsertAccount(account({ seedCategory: 'sports' }), NOW);
    expect(s.listVideosNeedingClassification('c1', 's1')[0].accountSeedCategory).toBe('sports');
    s.setClassification(v.id, { categories: [], topics: [], sponsorship: null, classifierVersion: 'c1', sponsorshipVersion: 's1', textHash: v.textHash, accountSeed: 'sports' }, NOW);
    s.upsertVideo(video({ title: '새 제목' }), NOW + 1);
    expect(s.listVideosNeedingClassification('c1', 's1')).toHaveLength(1);
  });

  it('loadDatasetParts streams observations per video through mapObs', () => {
    const s = mem();
    for (const id of ['b', 'a', 'c']) {
      s.upsertVideo(video({ platformId: id }), NOW, 'dailymotion');
      s.addObservation(videoIdOf('dailymotion', id), obs(NOW, 1));
      s.addObservation(videoIdOf('dailymotion', id), obs(NOW + HOUR, 2));
    }
    s.upsertAccount(account(), NOW, [], 'dailymotion');
    s.addFollowerObservation('dailymotion:acc1', { t: NOW, value: 5, src: 'dailymotion@1' });
    const seen: string[] = [];
    const parts = s.loadDatasetParts({ mapObs: (o, id) => (seen.push(id), o.slice(-1)) });
    expect(seen.sort()).toEqual(['dailymotion:a', 'dailymotion:b', 'dailymotion:c']);
    expect(parts.videos.map((v) => v.obs.length)).toEqual([1, 1, 1]);
    expect(parts.videos[0].sources).toEqual(['dailymotion']);
    expect(parts.accounts[0].followers).toHaveLength(1);
    expect(parts.accounts[0].sources).toEqual(['dailymotion']);
  });
});
