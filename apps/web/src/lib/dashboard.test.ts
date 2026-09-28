import { describe, expect, it } from 'vitest';
import { buildIndex } from '@vti/core';
import type { CollectionRun, SourceCoverage } from '@vti/core';
import { makeAccount, makeDataset, makeObs, makeVideo, ts } from '../../../../packages/core/test/fixtures.ts';
import { collectionTimeline } from './collection.ts';
import { formatAgo } from './format.ts';
import {
  categorySplit,
  comparablePrevious,
  computeKpis,
  dailyUploads,
  datesInRange,
  DAY_MS,
  filterVideos,
  HOUR_MS,
  platformSplit,
  recentRunProblems,
  sourceFreshness,
  topRankedVideos,
  topVideosEmptyReason,
  UNCATEGORIZED,
  videosUploadedIn,
} from './dashboard.ts';

const NOW = ts('2026-09-28T03:00:00Z'); // 12:00 KST
// Local week 2026-09-22..2026-09-28 in Asia/Seoul = [2026-09-21T15:00Z, 2026-09-28T15:00Z)
const WEEK = { startMs: ts('2026-09-21T15:00:00Z'), endMs: ts('2026-09-28T15:00:00Z') };

function cat(id: string) {
  return { id, confidence: 0.9, evidence: [], by: 'rule' as const, version: 't' };
}

function fixture() {
  const videos = [
    makeVideo({
      id: 'youtube:a',
      accountId: 'youtube:acc1',
      publishedAt: ts('2026-09-25T02:00:00Z'),
      categories: [cat('food'), cat('travel/domestic')],
      obs: [makeObs('2026-09-25T03:00:00Z', 10), makeObs('2026-09-27T20:00:00Z', 500), makeObs('2026-09-28T03:00:00Z', 900)],
    }),
    makeVideo({
      id: 'youtube:b',
      accountId: 'youtube:acc1',
      publishedAt: ts('2026-09-15T02:00:00Z'), // previous week, same elapsed part
      categories: [cat('food/recipe')],
      obs: [makeObs('2026-09-16T00:00:00Z', 100)],
    }),
    makeVideo({
      id: 'tiktok:c',
      accountId: 'tiktok:acc2',
      publishedAt: ts('2026-09-27T10:00:00Z'),
      status: 'deleted',
      obs: [makeObs('2026-09-27T12:00:00Z', 50)],
    }),
    makeVideo({
      id: 'tiktok:d',
      accountId: 'tiktok:acc2',
      publishedAt: ts('2026-09-28T10:00:00Z'), // after now: must not count as uploaded
      obs: [],
    }),
    makeVideo({
      id: 'niconico:e',
      accountId: 'niconico:acc3',
      publishedAt: ts('2026-08-01T00:00:00Z'),
      categories: [cat('gaming')],
      obs: [makeObs('2026-09-26T20:00:00Z', 3000), makeObs('2026-09-27T20:00:00Z', 3100)],
    }),
  ];
  const accounts = [
    makeAccount({ id: 'youtube:acc1', creatorId: 'c1' }),
    makeAccount({ id: 'tiktok:acc2', creatorId: 'c1' }),
    makeAccount({ id: 'niconico:acc3' }),
  ];
  return makeDataset({
    generatedAt: NOW,
    videos,
    accounts,
    creators: [
      { id: 'c1', name: '크리에이터', accountIds: ['youtube:acc1', 'tiktok:acc2'], linkStatus: 'verified', note: null },
      { id: 'c2', name: '단일', accountIds: ['niconico:acc3'], linkStatus: 'verified', note: null },
    ],
  });
}

describe('comparablePrevious', () => {
  it('uses the full previous window when the current one is complete', () => {
    const w = { startMs: 1000, endMs: 2000 };
    expect(comparablePrevious(w, 5000)).toEqual({ startMs: 0, endMs: 1000 });
  });
  it('cuts the previous window to the elapsed length while the current one runs', () => {
    const w = { startMs: 1000, endMs: 2000 };
    expect(comparablePrevious(w, 1250)).toEqual({ startMs: 0, endMs: 250 });
  });
  it('is empty before the window starts', () => {
    expect(comparablePrevious({ startMs: 1000, endMs: 2000 }, 500)).toEqual({ startMs: 0, endMs: 0 });
  });
});

describe('computeKpis', () => {
  it('counts tracked videos, statuses, accounts, platforms and multi-platform creators', () => {
    const k = computeKpis(fixture(), { now: NOW, window: WEEK });
    expect(k.trackedVideos).toBe(5);
    expect(k.activeVideos).toBe(4);
    expect(k.goneVideos).toBe(1);
    expect(k.accounts).toBe(3);
    expect(k.multiPlatformCreators).toBe(1);
    expect(k.platforms).toEqual(['youtube', 'niconico', 'tiktok']);
  });
  it('counts observations in (now-24h, now] only', () => {
    const k = computeKpis(fixture(), { now: NOW, window: WEEK });
    // a: 20:00Z and 03:00Z; c: 12:00Z on 27th (15h before now); e: 20:00Z on 27th. 26th 20:00Z is 31h old.
    expect(k.observationsLast24h).toBe(4);
    expect(k.videosObservedLast24h).toBe(3);
  });
  it('counts uploads in the window up to now and compares with the same elapsed time before', () => {
    const k = computeKpis(fixture(), { now: NOW, window: WEEK });
    expect(k.uploadsInWindow).toBe(2); // a and c (d is in the future)
    // previous window: [09-14T15:00Z, 09-14T15:00Z + elapsed (6.5 days)) contains b (09-15T02:00Z)
    expect(k.uploadsPrevious).toBe(1);
    expect(k.uploadsGrowth).toBeCloseTo(1);
  });
  it('filters by platform', () => {
    const k = computeKpis(fixture(), { now: NOW, window: WEEK, platforms: ['tiktok'] });
    expect(k.trackedVideos).toBe(2);
    expect(k.accounts).toBe(1);
    expect(k.platforms).toEqual(['tiktok']);
    expect(k.uploadsInWindow).toBe(1);
    expect(k.uploadsPrevious).toBe(0);
    expect(k.uploadsGrowth).toBeNull();
  });
  it('handles an empty dataset', () => {
    const k = computeKpis(makeDataset({ generatedAt: NOW }), { now: NOW, window: WEEK });
    expect(k.trackedVideos).toBe(0);
    expect(k.platforms).toEqual([]);
    expect(k.uploadsGrowth).toBeNull();
  });
  it('does not compare uploads with a previous window that starts before the collection started', () => {
    // Collection started 09-20: the previous week (from 09-14) was only backfilled -> discovery artifact.
    const k = computeKpis(fixture(), { now: NOW, window: WEEK, collectionStartAt: ts('2026-09-20T00:00:00Z') });
    expect(k.uploadsInWindow).toBe(2);
    expect(k.uploadsComparison).toBe('before_collection');
    expect(k.uploadsGrowth).toBeNull();
    expect(k.uploadsPrevious).toBeNull();
  });
  it('compares uploads once both windows lie after the collection start', () => {
    const k = computeKpis(fixture(), { now: NOW, window: WEEK, collectionStartAt: ts('2026-09-01T00:00:00Z') });
    expect(k.uploadsComparison).toBe('ok');
    expect(k.uploadsPrevious).toBe(1);
    expect(k.uploadsGrowth).toBeCloseTo(1);
  });
  it('reports nothing to compare before the window started', () => {
    const k = computeKpis(fixture(), { now: WEEK.startMs - HOUR_MS, window: WEEK, collectionStartAt: ts('2026-09-01T00:00:00Z') });
    expect(k.uploadsComparison).toBe('none');
    expect(k.uploadsGrowth).toBeNull();
  });
});

describe('topRankedVideos', () => {
  // Two videos with a computable increase in the window, two whose increase is unknown (one observation).
  function ds() {
    return makeDataset({
      generatedAt: NOW,
      videos: [
        makeVideo({ id: 'youtube:a', publishedAt: ts('2026-09-01T00:00:00Z'), obs: [makeObs('2026-09-26T00:00:00Z', 100), makeObs('2026-09-28T00:00:00Z', 900)] }),
        makeVideo({ id: 'youtube:b', publishedAt: ts('2026-09-01T00:00:00Z'), obs: [makeObs('2026-09-26T00:00:00Z', 100), makeObs('2026-09-28T00:00:00Z', 300)] }),
        makeVideo({ id: 'youtube:0', publishedAt: ts('2026-09-01T00:00:00Z'), obs: [makeObs('2026-09-28T00:00:00Z', 5_000_000)] }),
        makeVideo({ id: 'youtube:1', publishedAt: ts('2026-09-01T00:00:00Z'), obs: [makeObs('2026-09-28T00:00:00Z', 7)] }),
      ],
    });
  }
  const q = { dateMode: 'activity' as const, range: { start: '2026-09-27', end: '2026-09-28' }, rollingHours: 48, tz: 'Asia/Seoul', sort: 'views_period' as const, now: NOW };

  it('keeps only rows whose period increase can be ranked, in rank order', () => {
    const r = topRankedVideos(buildIndex(ds()), q, 10);
    expect(r.total).toBe(4);
    expect(r.rankable).toBe(2);
    expect(r.rows.map((x) => x.video.id)).toEqual(['youtube:a', 'youtube:b']);
  });
  it('never fills the list with unrankable rows ordered by id', () => {
    const only = makeDataset({ generatedAt: NOW, videos: ds().videos.filter((v) => v.obs.length === 1) });
    const r = topRankedVideos(buildIndex(only), q, 10);
    expect(r.total).toBe(2);
    expect(r.rankable).toBe(0);
    expect(r.rows).toEqual([]);
  });
  it('respects the limit', () => {
    expect(topRankedVideos(buildIndex(ds()), q, 1).rows.map((x) => x.video.id)).toEqual(['youtube:a']);
  });
});

describe('topVideosEmptyReason', () => {
  const first = ts('2026-09-28T15:13:00Z');
  it('explains windows that end before the first observation', () => {
    expect(topVideosEmptyReason({ startMs: ts('2026-08-01'), endMs: ts('2026-09-01') }, first, first + DAY_MS)).toBe('before_collection');
    expect(topVideosEmptyReason({ startMs: ts('2026-08-01'), endMs: ts('2026-09-01') }, null, first)).toBe('before_collection');
  });
  it('explains windows that start before it', () => {
    expect(topVideosEmptyReason({ startMs: first - 7 * DAY_MS, endMs: first + HOUR_MS }, first, first + HOUR_MS)).toBe('short_history');
  });
  it('has no special reason once the window lies after it', () => {
    expect(topVideosEmptyReason({ startMs: first + HOUR_MS, endMs: first + DAY_MS }, first, first + DAY_MS)).toBe('none');
  });
});

describe('daily uploads', () => {
  it('lists inclusive local dates', () => {
    expect(datesInRange({ start: '2026-09-27', end: '2026-09-29' })).toEqual(['2026-09-27', '2026-09-28', '2026-09-29']);
    expect(datesInRange({ start: '2026-09-29', end: '2026-09-27' })).toEqual([]);
  });
  it('buckets by local day in the tz and leaves future days null', () => {
    const ds = fixture();
    const rows = dailyUploads(ds.videos, { start: '2026-09-24', end: '2026-09-29' }, 'Asia/Seoul', NOW);
    expect(rows).toEqual([
      { date: '2026-09-24', count: 0 },
      { date: '2026-09-25', count: 1 }, // a: 09-25 11:00 KST
      { date: '2026-09-26', count: 0 },
      { date: '2026-09-27', count: 1 }, // c: 09-27 19:00 KST
      { date: '2026-09-28', count: 0 }, // d is after now
      { date: '2026-09-29', count: null },
    ]);
  });
  it('respects the time zone (Sydney shifts a late-UTC upload to the next day)', () => {
    const v = makeVideo({ id: 'youtube:z', publishedAt: ts('2026-09-24T20:00:00Z') });
    const seoul = dailyUploads([v], { start: '2026-09-25', end: '2026-09-25' }, 'Asia/Seoul', NOW);
    const sydney = dailyUploads([v], { start: '2026-09-25', end: '2026-09-25' }, 'Australia/Sydney', NOW);
    expect(seoul[0].count).toBe(1); // 05:00 KST on the 25th
    expect(sydney[0].count).toBe(1); // 06:00 AEST on the 25th
    const utc = dailyUploads([v], { start: '2026-09-25', end: '2026-09-25' }, 'UTC', NOW);
    expect(utc[0].count).toBe(0);
  });
});

describe('splits', () => {
  it('platformSplit counts tracked, uploads in window (up to now) and accounts in canonical order', () => {
    const rows = platformSplit(fixture(), WEEK, NOW);
    expect(rows.map((r) => r.platform)).toEqual(['youtube', 'niconico', 'tiktok']);
    expect(rows.find((r) => r.platform === 'tiktok')).toEqual({ platform: 'tiktok', tracked: 2, uploadsInWindow: 1, accounts: 1 });
    expect(rows.find((r) => r.platform === 'youtube')!.uploadsInWindow).toBe(1);
  });
  it('categorySplit counts top-level categories multi-label and uncategorized videos', () => {
    const ds = fixture();
    const s = categorySplit(ds.videos);
    expect(s.videos).toBe(5);
    expect(s.multiLabel).toBe(1);
    expect(s.rows).toEqual([
      { id: UNCATEGORIZED, count: 2 },
      { id: 'food', count: 2 },
      { id: 'gaming', count: 1 },
      { id: 'travel', count: 1 },
    ]);
  });
  it('videosUploadedIn and filterVideos', () => {
    const ds = fixture();
    expect(videosUploadedIn(ds.videos, WEEK, NOW).map((v) => v.id)).toEqual(['youtube:a', 'tiktok:c']);
    expect(filterVideos(ds.videos, ['niconico']).map((v) => v.id)).toEqual(['niconico:e']);
    expect(filterVideos(ds.videos, [])).toHaveLength(5);
    expect(filterVideos(ds.videos, undefined)).toHaveLength(5);
  });
});

function cov(partial: Partial<SourceCoverage> & Pick<SourceCoverage, 'source' | 'platform'>): SourceCoverage {
  return {
    label: partial.source,
    enabled: true,
    requiresCredentials: false,
    discovery: '',
    metrics: ['views'],
    firstRunAt: null,
    lastRunAt: null,
    lastSuccessAt: null,
    lastStatus: 'ok',
    lastError: null,
    videoCount: 0,
    accountCount: 0,
    notes: [],
    docsUrl: null,
    ...partial,
  };
}

describe('sourceFreshness', () => {
  it('classifies sources by status and age relative to the data now', () => {
    const rows = sourceFreshness(
      [
        cov({ source: 'x-api', platform: 'x', enabled: false, lastStatus: 'disabled', requiresCredentials: true }),
        cov({ source: 'youtube-rss', platform: 'youtube', lastSuccessAt: NOW - 2 * HOUR_MS }),
        cov({ source: 'dailymotion', platform: 'dailymotion', lastSuccessAt: NOW - 20 * HOUR_MS }),
        cov({ source: 'niconico', platform: 'niconico', lastSuccessAt: NOW - 3 * DAY_MS }),
        cov({ source: 'peertube', platform: 'peertube', lastSuccessAt: NOW - HOUR_MS, lastStatus: 'partial' }),
        cov({ source: 'tiktok-research', platform: 'tiktok', lastSuccessAt: null, lastStatus: 'never' }),
        cov({ source: 'twitch', platform: 'twitch', lastSuccessAt: NOW - HOUR_MS, lastStatus: 'error', lastError: 'boom' }),
      ],
      NOW,
    );
    const by = Object.fromEntries(rows.map((r) => [r.source, r]));
    expect(by['youtube-rss'].state).toBe('ok');
    expect(by['youtube-rss'].ageHours).toBe(2);
    expect(by.dailymotion.state).toBe('late');
    expect(by.niconico.state).toBe('stale');
    expect(by.peertube.state).toBe('partial');
    expect(by['tiktok-research'].state).toBe('never');
    expect(by.twitch.state).toBe('error');
    expect(by['x-api'].state).toBe('disabled');
    // disabled sources sort last; others follow canonical platform order
    expect(rows[rows.length - 1].source).toBe('x-api');
    expect(rows[0].source).toBe('youtube-rss');
  });
});

describe('recentRunProblems', () => {
  it('counts runs in the last 24h and those that were not ok', () => {
    const run = (startedAt: number, status: CollectionRun['status']): CollectionRun => ({
      id: String(startedAt),
      startedAt,
      finishedAt: startedAt + 1000,
      source: 's',
      status,
      videosSeen: 0,
      videosNew: 0,
      observations: 0,
      requests: 0,
      errors: [],
    });
    const out = recentRunProblems([run(NOW - HOUR_MS, 'ok'), run(NOW - 2 * HOUR_MS, 'partial'), run(NOW - 30 * HOUR_MS, 'error'), run(NOW + HOUR_MS, 'error')], NOW);
    expect(out).toEqual({ total: 2, problems: 1 });
  });
});

describe('freshness against the last collector activity (live export shape)', () => {
  // generatedAt = newest observation (15:26:16Z); the peertube / niconico runs of the second round (0 new
  // points) start and finish after it.
  const generatedAt = ts('2026-09-28T15:26:16Z');
  const runs: CollectionRun[] = [
    ['youtube-rss', '2026-09-28T15:13:23Z', '2026-09-28T15:16:38Z'],
    ['dailymotion', '2026-09-28T15:16:38Z', '2026-09-28T15:18:34Z'],
    ['peertube', '2026-09-28T15:18:34Z', '2026-09-28T15:18:48Z'],
    ['niconico', '2026-09-28T15:18:48Z', '2026-09-28T15:19:15Z'],
    ['youtube-rss', '2026-09-28T15:23:00Z', '2026-09-28T15:26:16Z'],
    ['dailymotion', '2026-09-28T15:26:16Z', '2026-09-28T15:27:57Z'],
    ['peertube', '2026-09-28T15:27:57Z', '2026-09-28T15:28:11Z'],
    ['niconico', '2026-09-28T15:28:11Z', '2026-09-28T15:28:38Z'],
  ].map(([source, s, f]) => ({ id: `${source}-${s}`, source, startedAt: ts(s), finishedAt: ts(f), status: 'ok' as const, videosSeen: 0, videosNew: 0, observations: 0, requests: 0, errors: [] }));
  const coverage = [cov({ source: 'peertube', platform: 'peertube', lastSuccessAt: ts('2026-09-28T15:27:57Z'), lastRunAt: ts('2026-09-28T15:27:57Z') })];
  const ds = makeDataset({ generatedAt, runs, coverage });
  const ref = collectionTimeline(ds).collectedUntil;

  it('counts every run of the last 24 hours', () => {
    expect(recentRunProblems(ds.runs, generatedAt).total).toBe(6); // the old behaviour (bug)
    expect(recentRunProblems(ds.runs, ref).total).toBe(8);
  });
  it('never reports a last success in the future', () => {
    const [row] = sourceFreshness(ds.coverage, ref);
    expect(row.ageHours).toBeGreaterThanOrEqual(0);
    expect(formatAgo(row.lastSuccessAt, ref)).toBe('방금');
    expect(formatAgo(row.lastSuccessAt, generatedAt)).not.toContain('후');
  });
});
