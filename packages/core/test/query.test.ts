import { describe, expect, it } from 'vitest';
import {
  compileVideoFilter,
  indexAsOf,
  medianOf,
  percentileRanks,
  queryVideos,
  sumIncrements,
} from '../src/query.ts';
import { resolveWindow } from '../src/time.ts';
import type { MetricValue, Platform, QueryResult, Video, VideoQuery } from '../src/types.ts';
import { DAY_MS, HOUR_MS, makeAccount, makeIndex, makeObs, makeSourceWindow, makeVideo, obsOf, ts } from './fixtures.ts';

const H = HOUR_MS;
const D = DAY_MS;
const SEOUL = 'Asia/Seoul';
const SEP = { start: '2026-09-01', end: '2026-09-30' };

const ids = (r: QueryResult) => r.rows.map((x) => x.video.id);
const cat = (id: string) => ({ id, confidence: 0.9, evidence: [], by: 'rule' as const, version: 'test' });

function q(partial: Partial<VideoQuery>): VideoQuery {
  return { dateMode: 'activity', tz: SEOUL, sort: 'views_period', ...partial } as VideoQuery;
}

/* ------------------------------------------------------------------------------------------ */

describe('design doc §5 worked example (A/B/C) end-to-end', () => {
  // September has finished and every boundary was observed exactly.
  const now = ts('2026-10-02T00:00Z');
  const sep = resolveWindow(SEP, SEOUL, now);
  const A = makeVideo({ id: 'youtube:A', accountId: 'youtube:a', publishedAt: ts('2026-08-12'), obs: [makeObs(sep.startMs, 1_000_000), makeObs(sep.endMs, 6_000_000)] });
  const B = makeVideo({ id: 'youtube:B', accountId: 'youtube:b', publishedAt: ts('2026-09-10'), obs: [makeObs('2026-09-10T08:00Z', 30_000), makeObs(sep.endMs, 2_000_000)] });
  const C = makeVideo({ id: 'youtube:C', accountId: 'youtube:c', publishedAt: ts('2026-09-18'), obs: [makeObs('2026-09-18T08:00Z', 9_000), makeObs(sep.endMs, 800_000)] });
  const index = makeIndex({ videos: [C, A, B], generatedAt: now });

  it('upload mode for September ranks B first and excludes A (published in August)', () => {
    const r = queryVideos(index, q({ dateMode: 'upload', range: SEP, sort: 'views_total', now }));
    expect(ids(r)).toEqual(['youtube:B', 'youtube:C']);
    expect(r.total).toBe(2);
    expect(r.rows[0].metrics.viewsTotal).toMatchObject({ value: 2_000_000, status: 'exact', asOf: sep.endMs });
    expect(r.window).toEqual(sep);
    expect(r.window!.incomplete).toBe(false);
    expect(r.notes[0]).toContain('업로드 기간 기준');
    expect(r.notes[0]).toContain('2026-09-01~2026-09-30(Asia/Seoul)');
    expect(r.notes[0]).toContain('2026-10-01 00:00 (Asia/Seoul) 기준');
    // views since publish as of the window end ranks the same way
    expect(ids(queryVideos(index, q({ dateMode: 'upload', range: SEP, sort: 'views_period', now })))).toEqual(['youtube:B', 'youtube:C']);
  });

  it('activity mode for September ranks A first (5,000,000 > 2,000,000 > 800,000)', () => {
    const r = queryVideos(index, q({ dateMode: 'activity', range: SEP, sort: 'views_period', now }));
    expect(ids(r)).toEqual(['youtube:A', 'youtube:B', 'youtube:C']);
    expect(r.rows.map((x) => x.metrics.viewsPeriod.value)).toEqual([5_000_000, 2_000_000, 800_000]);
    expect(r.rows.every((x) => x.metrics.viewsPeriod.status === 'exact')).toBe(true);
    expect(r.notes[0]).toContain('조회 발생 기간 기준');
    expect(r.notes.some((n) => n.includes('모두 관측값으로 정확히'))).toBe(true);
    // in-platform percentile of the sort metric (mid-rank)
    const pcts = r.rows.map((x) => x.metrics.percentile.value as number);
    [(2.5 / 3) * 100, 50, (0.5 / 3) * 100].forEach((p, i) => expect(pcts[i]).toBeCloseTo(p, 9));
    expect(r.rows[0].metrics.percentile).toMatchObject({ status: 'exact', note: 'few_platform_peers' });
    expect(r.rows[0].account?.id).toBe('youtube:a');
  });

  it('on the survey date (2026-09-28) September is not finished: window incomplete + note, later data ignored', () => {
    const early = ts('2026-09-28T00:00Z');
    const r = queryVideos(index, q({ dateMode: 'activity', range: SEP, now: early }));
    expect(r.window!.incomplete).toBe(true);
    expect(r.now).toBe(early);
    expect(r.notes.some((n) => n.includes('아직 끝나지 않았습니다'))).toBe(true);
    expect(r.notes.some((n) => n.includes('이후에 수집된 관측값'))).toBe(true);
    // The September-end observations were collected after `now`, so they are not used.
    expect(r.rows.find((x) => x.video.id === 'youtube:A')!.metrics.viewsPeriod.value).not.toBe(5_000_000);
  });
});

/* ------------------------------------------------------------------------------------------ */

describe('§13 scenarios at query level', () => {
  const now = ts('2026-10-01T00:00Z');
  const sep = resolveWindow(SEP, SEOUL, now);

  it('re-trending old video: excluded by the upload filter, first by in-period increase', () => {
    const old = makeVideo({
      id: 'youtube:old',
      accountId: 'youtube:x',
      publishedAt: ts('2026-03-02'),
      obs: [makeObs('2026-03-03', 10_000), makeObs(sep.startMs, 50_000), makeObs(sep.endMs, 4_050_000)],
    });
    const new1 = makeVideo({ id: 'youtube:new1', accountId: 'youtube:y', publishedAt: ts('2026-09-05'), obs: [makeObs('2026-09-05T06:00Z', 1_000), makeObs(sep.endMs, 900_000)] });
    const new2 = makeVideo({ id: 'youtube:new2', accountId: 'youtube:z', publishedAt: ts('2026-09-20'), obs: [makeObs('2026-09-20T06:00Z', 1_000), makeObs(sep.endMs, 300_000)] });
    const index = makeIndex({ videos: [new2, old, new1], generatedAt: now });
    const upload = queryVideos(index, q({ dateMode: 'upload', range: SEP, sort: 'views_total', now }));
    expect(ids(upload)).toEqual(['youtube:new1', 'youtube:new2']);
    const activity = queryVideos(index, q({ dateMode: 'activity', range: SEP, sort: 'views_period', now }));
    expect(ids(activity)).toEqual(['youtube:old', 'youtube:new1', 'youtube:new2']);
    expect(activity.rows[0].metrics.viewsPeriod).toMatchObject({ value: 4_000_000, status: 'exact' });
    expect(upload.notes[0]).toContain('다시 인기를 얻은 영상은 제외');
  });

  it('counters a source does not provide are not counted as 0 in engagement ranking', () => {
    const mk = (id: string, likes: number | null, comments: number | null, shares: number | null) =>
      makeVideo({
        id,
        publishedAt: ts('2026-09-02'),
        obs: [
          makeObs('2026-09-02T03:00Z', 100, likes === null ? null : 0, comments === null ? null : 0, shares === null ? null : 0),
          makeObs(sep.endMs, 10_000, likes, comments, shares),
        ],
      });
    const yt1 = mk('youtube:yt1', 500, 50, null); // 0.055
    const yt2 = mk('youtube:yt2', 0, 0, null); // 0 (really zero reactions)
    const x1 = mk('x:x1', null, null, null); // nothing provided -> unavailable, NOT 0
    const tt1 = mk('tiktok:tt1', 300, null, 100); // 0.04 from likes + shares
    const index = makeIndex({ videos: [x1, yt2, tt1, yt1], generatedAt: now });
    const desc = queryVideos(index, q({ range: SEP, sort: 'engagement_rate', now }));
    expect(ids(desc)).toEqual(['youtube:yt1', 'tiktok:tt1', 'youtube:yt2', 'x:x1']);
    const byId = new Map(desc.rows.map((r) => [r.video.id, r.metrics]));
    expect(byId.get('youtube:yt1')!.engagementRate).toMatchObject({ value: 0.055, status: 'exact', components: ['likes', 'comments'] });
    expect(byId.get('tiktok:tt1')!.engagementRate).toMatchObject({ value: 0.04, components: ['likes', 'shares'] });
    expect(byId.get('youtube:yt2')!.engagementRate).toMatchObject({ value: 0, status: 'exact' });
    expect(byId.get('x:x1')!.engagementRate).toMatchObject({ value: null, status: 'unavailable', note: 'counter_not_provided', components: [] });
    expect(byId.get('x:x1')!.percentile).toMatchObject({ value: null, status: 'unavailable' });
    // ascending: the zero-engagement video comes first, the not-provided one is still last
    const asc = queryVideos(index, q({ range: SEP, sort: 'engagement_rate', sortDir: 'asc', now }));
    expect(ids(asc)).toEqual(['youtube:yt2', 'tiktok:tt1', 'youtube:yt1', 'x:x1']);
    expect(desc.notes.some((n) => n.includes('참여율 =') && n.includes('0으로 계산하지 않고'))).toBe(true);
    expect(desc.notes.some((n) => n.includes('계산 불가(—) 1개'))).toBe(true);
  });

  it('a counter decrease (deletion / correction) is flagged and never ranked', () => {
    const up = makeVideo({ id: 'youtube:up', publishedAt: ts('2026-08-01'), obs: [makeObs(sep.startMs, 1_000), makeObs(sep.endMs, 3_000)] });
    const deleted = makeVideo({ id: 'youtube:del', publishedAt: ts('2026-08-01'), status: 'deleted', obs: [makeObs(sep.startMs, 10_000), makeObs(sep.endMs, 2_000)] });
    const flat = makeVideo({ id: 'youtube:flat', publishedAt: ts('2026-08-01'), obs: [makeObs(sep.startMs, 500), makeObs(sep.endMs, 500)] });
    const index = makeIndex({ videos: [deleted, flat, up], generatedAt: now });
    for (const sortDir of ['desc', 'asc'] as const) {
      const r = queryVideos(index, q({ range: SEP, sort: 'views_period', sortDir, now }));
      expect(ids(r).at(-1)).toBe('youtube:del');
    }
    const r = queryVideos(index, q({ range: SEP, sort: 'views_period', now }));
    expect(ids(r)).toEqual(['youtube:up', 'youtube:flat', 'youtube:del']);
    expect(r.rows[2].metrics.viewsPeriod).toMatchObject({ value: -8_000, status: 'decrease_flagged' });
    expect(r.rows[2].metrics.percentile.status).toBe('unavailable');
    expect(r.notes.some((n) => n.includes('감소 감지(⚠') && n.includes('1개'))).toBe(true);
    expect(r.notes.some((n) => n.includes('순위에 넣지 않고 목록 끝'))).toBe(true);
    // growth vs previous is never ranked either when the window decreased
    expect(r.rows[2].metrics.growthVsPrev.status === 'unavailable' || r.rows[2].metrics.growthVsPrev.status === 'decrease_flagged').toBe(true);
  });

  it('same content on three platforms: one row per platform, percentile within each platform, unit caveat', () => {
    const mk = (id: string, inc: number, title = `Other ${id}`) =>
      makeVideo({ id, title, accountId: `${id.split(':')[0]}:creator`, publishedAt: ts('2026-09-03'), obs: [makeObs('2026-09-03T01:00Z', 0), makeObs(sep.endMs, inc)] });
    const same = '[같은영상] 여름 메이크업';
    const videos = [
      mk('youtube:s', 1000, same),
      mk('youtube:y1', 2000),
      mk('youtube:y2', 3000),
      mk('youtube:y3', 4000),
      mk('dailymotion:s', 1000, same),
      mk('dailymotion:d1', 10),
      mk('dailymotion:d2', 20),
      mk('dailymotion:d3', 30),
      mk('peertube:s', 1000, same),
    ];
    const index = makeIndex({ videos, generatedAt: now });
    const r = queryVideos(index, q({ range: SEP, sort: 'views_period', now }));
    expect(r.total).toBe(9);
    const pct = new Map(r.rows.map((x) => [x.video.id, x.metrics.percentile.value]));
    expect(pct.get('youtube:s')).toBe(12.5); // lowest of 4 on YouTube
    expect(pct.get('dailymotion:s')).toBe(87.5); // highest of 4 on Dailymotion
    expect(pct.get('peertube:s')).toBe(50); // alone on PeerTube
    expect(r.rows.find((x) => x.video.id === 'peertube:s')!.metrics.percentile.note).toBe('few_platform_peers');
    // raw sort: same-value ties resolved by views_total desc then id asc
    expect(ids(r)).toEqual([
      'youtube:y3',
      'youtube:y2',
      'youtube:y1',
      'dailymotion:s',
      'peertube:s',
      'youtube:s',
      'dailymotion:d3',
      'dailymotion:d2',
      'dailymotion:d1',
    ]);
    const caveat = r.notes.find((n) => n.includes('여러 플랫폼'));
    expect(caveat).toContain('YouTube·Dailymotion·PeerTube');
    expect(caveat).toContain('플랫폼 내 백분위');
    // percentile sort interleaves platforms by relative position
    const byPct = queryVideos(index, q({ range: SEP, sort: 'percentile', now }));
    expect(ids(byPct)).toEqual([
      'youtube:y3',
      'dailymotion:s',
      'youtube:y2',
      'dailymotion:d3',
      'peertube:s',
      'youtube:y1',
      'dailymotion:d2',
      'youtube:s',
      'dailymotion:d1',
    ]);
    // searching the shared title shows it once per platform, each kept separate
    const found = queryVideos(index, q({ range: SEP, q: '같은영상', now }));
    expect(found.rows.map((x) => x.video.platform).sort()).toEqual(['dailymotion', 'peertube', 'youtube']);
    expect(found.rows.every((x) => x.metrics.percentile.value === 50)).toBe(true);
    // a single platform has no caveat
    expect(queryVideos(index, q({ range: SEP, platforms: ['youtube'], now })).notes.some((n) => n.includes('여러 플랫폼'))).toBe(false);
  });

  it("regenerating last month's report later gives identical results for a fixed now", () => {
    const reportNow = ts('2026-10-05T00:00Z');
    const baseObs = (scale: number) => [
      makeObs('2026-08-20', 100 * scale),
      makeObs(sep.startMs, 1_000 * scale),
      makeObs('2026-09-15', 5_000 * scale),
      makeObs(sep.endMs, 9_000 * scale, 90 * scale, 9 * scale),
      makeObs('2026-10-04T12:00Z', 9_500 * scale, 95 * scale, 10 * scale),
    ];
    const later = (scale: number) => [makeObs('2026-10-20', 20_000 * scale, 200 * scale), makeObs('2026-11-03', 30_000 * scale, 300 * scale)];
    const spec = [
      { id: 'youtube:r1', pub: '2026-08-10', scale: 1 },
      { id: 'youtube:r2', pub: '2026-08-12', scale: 3 },
      { id: 'dailymotion:r3', pub: '2026-08-15', scale: 2 },
    ];
    const v1 = spec.map((s) => makeVideo({ id: s.id, accountId: `${s.id.split(':')[0]}:acc`, publishedAt: ts(s.pub), obs: baseObs(s.scale) }));
    const v2 = spec.map((s) => makeVideo({ id: s.id, accountId: `${s.id.split(':')[0]}:acc`, publishedAt: ts(s.pub), obs: [...baseObs(s.scale), ...later(s.scale)] }));
    // discovered after the report was made (published in September)
    const lateFind = makeVideo({ id: 'youtube:late', accountId: 'youtube:acc', publishedAt: ts('2026-09-12'), obs: [makeObs('2026-10-20', 999_999)] });
    const first = makeIndex({ videos: v1, generatedAt: reportNow });
    const second = makeIndex({ videos: [...v2, lateFind], generatedAt: ts('2026-11-03') });

    for (const query of [
      q({ dateMode: 'activity', range: SEP, sort: 'views_period', now: reportNow }),
      q({ dateMode: 'upload', range: { start: '2026-08-01', end: '2026-08-31' }, sort: 'views_total', now: reportNow }),
      q({ dateMode: 'age', ageDays: 30, sort: 'views_at_age', now: reportNow }),
      q({ dateMode: 'activity', range: SEP, sort: 'engagement_rate', now: reportNow }),
    ]) {
      const a = queryVideos(first, query);
      const b = queryVideos(second, query);
      expect(b.rows).toEqual(a.rows);
      expect(b.total).toBe(a.total);
      expect(b.window).toEqual(a.window);
      expect(b.notes.filter((n) => !n.includes('이후에 수집된'))).toEqual(a.notes);
      expect(b.notes.some((n) => n.includes('같은 기준 시각으로 다시 만들면 같은 결과'))).toBe(true);
      // and the same call twice is deterministic
      expect(queryVideos(second, query)).toEqual(b);
    }
    // without pinning now, the newer dataset reads the newer data
    const fresh = queryVideos(second, q({ dateMode: 'activity', range: { start: '2026-10-01', end: '2026-10-31' }, sort: 'views_period' }));
    expect(fresh.now).toBe(ts('2026-11-03'));
    expect(ids(fresh)).toContain('youtube:late');
  });
});

/* ------------------------------------------------------------------------------------------ */

describe('filters', () => {
  const now = ts('2026-09-28T00:00Z');
  const RANGE = { start: '2026-09-01', end: '2026-09-27' };
  const w = resolveWindow(RANGE, SEOUL, now);
  const obs = (a: number, b: number) => [makeObs(w.startMs, a), makeObs(w.endMs, b)];
  const v1 = makeVideo({
    id: 'youtube:v1',
    title: '데일리 뷰티 루틴',
    tags: ['Skincare'],
    topics: ['뷰티루틴'],
    language: 'ko',
    country: 'KR',
    format: 'short',
    categories: [cat('beauty'), cat('beauty/skincare')],
    sponsorship: { level: 'disclosed', brands: ['브랜드A'], evidence: [], version: 't' },
    accountId: 'youtube:ch1',
    publishedAt: ts('2026-08-01'),
    obs: obs(100, 400),
  });
  const v2 = makeVideo({
    id: 'dailymotion:v2',
    title: 'Morning makeup',
    language: 'EN',
    country: 'us',
    format: 'long',
    categories: [cat('beauty')],
    sponsorship: { level: 'likely', brands: [], evidence: [], version: 't' },
    accountId: 'dailymotion:u2',
    publishedAt: ts('2026-08-01'),
    obs: obs(100, 300),
  });
  const v3 = makeVideo({ id: 'peertube:v3', title: '나 혼자 산다 리뷰', categories: [cat('entertainment')], accountId: 'peertube:p3', publishedAt: ts('2026-08-01'), obs: obs(100, 200) });
  const v4 = makeVideo({ id: 'youtube:v4', title: 'Game review', topics: ['게임'], categories: [cat('gaming')], accountId: 'youtube:ch4', publishedAt: ts('2026-08-01'), obs: obs(100, 150) });
  const index = makeIndex({
    videos: [v1, v2, v3, v4],
    accounts: [
      makeAccount({ id: 'youtube:ch1', name: '뷰티채널', handle: '@beautych' }),
      makeAccount({ id: 'dailymotion:u2', name: 'Makeup FR' }),
      makeAccount({ id: 'peertube:p3', name: 'Some Instance' }),
      makeAccount({ id: 'youtube:ch4', name: 'Gamer', creatorId: 'c-game' }),
    ],
    creators: [{ id: 'c-game', name: '게임 크리에이터', accountIds: ['youtube:ch4'], linkStatus: 'verified', note: null }],
    generatedAt: now,
  });
  const run = (extra: Partial<VideoQuery>) => ids(queryVideos(index, q({ range: RANGE, now, ...extra }))).sort();

  it('q matches title, tags, topics, account name / handle (normalized, Korean substring, AND terms)', () => {
    expect(run({ q: '뷰티' })).toEqual(['youtube:v1']);
    expect(run({ q: 'SKINCARE' })).toEqual(['youtube:v1']);
    expect(run({ q: '뷰티루틴' })).toEqual(['youtube:v1']);
    expect(run({ q: '뷰티채널' })).toEqual(['youtube:v1']);
    expect(run({ q: '@BEAUTYCH' })).toEqual(['youtube:v1']);
    expect(run({ q: '나혼자산다' })).toEqual(['peertube:v3']); // Korean spacing tolerated
    expect(run({ q: '  morning   MAKEUP ' })).toEqual(['dailymotion:v2']);
    expect(run({ q: 'morning 뷰티' })).toEqual([]);
    expect(run({ q: 'Ｇａｍｅ' })).toEqual(['youtube:v4']); // full-width (NFKC)
    expect(run({ q: '   ' })).toHaveLength(4);
  });

  it('platform / category (with descendants) / topic / language / country / format / account / creator filters', () => {
    expect(run({ platforms: ['youtube'] })).toEqual(['youtube:v1', 'youtube:v4']);
    expect(run({ platforms: [] })).toHaveLength(4); // empty = no filter
    expect(run({ categories: ['beauty'] })).toEqual(['dailymotion:v2', 'youtube:v1']);
    expect(run({ categories: ['beauty/skincare'] })).toEqual(['youtube:v1']);
    expect(run({ categories: ['gaming', 'entertainment'] })).toEqual(['peertube:v3', 'youtube:v4']);
    expect(run({ topics: ['게임'] })).toEqual(['youtube:v4']);
    expect(run({ languages: ['en'] })).toEqual(['dailymotion:v2']);
    expect(run({ languages: ['KO'] })).toEqual(['youtube:v1']);
    expect(run({ countries: ['US'] })).toEqual(['dailymotion:v2']);
    expect(run({ countries: ['kr'] })).toEqual(['youtube:v1']);
    expect(run({ formats: ['long', 'unknown'] })).toEqual(['dailymotion:v2', 'peertube:v3', 'youtube:v4']);
    expect(run({ accountIds: ['peertube:p3'] })).toEqual(['peertube:v3']);
    expect(run({ creatorIds: ['c-game'] })).toEqual(['youtube:v4']);
    expect(run({ creatorIds: ['nobody'] })).toEqual([]);
  });

  it('sponsored filter: disclosed / any / none', () => {
    expect(run({ sponsored: 'disclosed' })).toEqual(['youtube:v1']);
    expect(run({ sponsored: 'any' })).toEqual(['dailymotion:v2', 'youtube:v1']);
    expect(run({ sponsored: 'none' })).toEqual(['peertube:v3', 'youtube:v4']);
  });

  it('minViews compares the displayed cumulative views; unknown excluded, a lower bound must itself reach it', () => {
    expect(run({ minViews: 300 })).toEqual(['dailymotion:v2', 'youtube:v1']);
    expect(run({ minViews: 0 })).toHaveLength(4);
    const stale = makeVideo({ id: 'youtube:stale', publishedAt: ts('2026-08-01'), obs: [makeObs(w.startMs, 500), makeObs(w.endMs - 5 * D, 800)] });
    const none = makeVideo({ id: 'youtube:none', publishedAt: ts('2026-08-01'), obs: [obsOf(w.startMs, { likes: 3 })] });
    const idx = makeIndex({ videos: [stale, none], generatedAt: now });
    const r = queryVideos(idx, q({ range: RANGE, now, sort: 'views_total' }));
    expect(r.rows.find((x) => x.video.id === 'youtube:stale')!.metrics.viewsTotal).toMatchObject({ value: 800, status: 'lower_bound' });
    expect(ids(queryVideos(idx, q({ range: RANGE, now, minViews: 800 })))).toEqual(['youtube:stale']);
    expect(ids(queryVideos(idx, q({ range: RANGE, now, minViews: 801 })))).toEqual([]);
  });

  it('compileVideoFilter is reusable on its own', () => {
    const f = compileVideoFilter(index, { categories: ['beauty'], languages: ['ko'] });
    expect([v1, v2, v3, v4].filter(f).map((v) => v.id)).toEqual(['youtube:v1']);
  });
});

/* ------------------------------------------------------------------------------------------ */

describe('date semantics', () => {
  const now = ts('2026-09-28T00:00Z');

  it('upload mode keeps publishedAt inside the half-open local window', () => {
    const w = resolveWindow({ start: '2026-09-10', end: '2026-09-10' }, SEOUL, now);
    const at = (id: string, t: number) => makeVideo({ id, publishedAt: t, obs: [makeObs(now - H, 10)] });
    const index = makeIndex({ videos: [at('youtube:start', w.startMs), at('youtube:before', w.startMs - 1), at('youtube:last', w.endMs - 1), at('youtube:end', w.endMs)], generatedAt: now });
    const r = queryVideos(index, q({ dateMode: 'upload', range: { start: '2026-09-10', end: '2026-09-10' }, sort: 'published_at', sortDir: 'asc', now }));
    expect(ids(r)).toEqual(['youtube:start', 'youtube:last']);
    expect(r.notes[0]).toContain('2026-09-10(Asia/Seoul)');
  });

  it('activity mode keeps every video published before the window end', () => {
    const w = resolveWindow({ start: '2026-09-10', end: '2026-09-12' }, SEOUL, now);
    const at = (id: string, t: number) => makeVideo({ id, publishedAt: t, obs: [makeObs(now - H, 10)] });
    const index = makeIndex({ videos: [at('youtube:ancient', ts('2020-01-01')), at('youtube:inside', w.startMs + H), at('youtube:after', w.endMs)], generatedAt: now });
    expect(ids(queryVideos(index, q({ range: { start: '2026-09-10', end: '2026-09-12' }, sort: 'published_at', now })))).toEqual(['youtube:inside', 'youtube:ancient']);
  });

  it('age mode compares at the same age, excludes (and counts) videos that have not reached it', () => {
    const v1 = makeVideo({ id: 'youtube:v1', publishedAt: ts('2026-09-01'), obs: [makeObs('2026-09-08', 7_000), makeObs('2026-09-20', 9_000)] });
    const v2 = makeVideo({ id: 'youtube:v2', publishedAt: ts('2026-09-10'), obs: [makeObs('2026-09-17', 9_000), makeObs('2026-09-27', 20_000)] });
    const young = makeVideo({ id: 'youtube:young', publishedAt: ts('2026-09-25'), obs: [makeObs('2026-09-27', 50_000)] });
    const gappy = makeVideo({ id: 'youtube:gappy', publishedAt: ts('2026-08-01'), obs: [makeObs('2026-08-02', 10), makeObs('2026-08-30', 90_000)] });
    const index = makeIndex({ videos: [young, gappy, v1, v2], generatedAt: now });
    const r = queryVideos(index, q({ dateMode: 'age', ageDays: 7, sort: 'views_at_age', now }));
    expect(ids(r)).toEqual(['youtube:v2', 'youtube:v1', 'youtube:gappy']);
    expect(r.rows[0].metrics.viewsAtAge).toMatchObject({ value: 9_000, status: 'exact' });
    expect(r.rows[2].metrics.viewsAtAge.status).toBe('unavailable');
    expect(r.window).toBeNull();
    expect(r.notes[0]).toContain('게시 후 경과시간 기준');
    expect(r.notes[0]).toContain('V7');
    expect(r.notes.some((n) => n.includes('게시 후 7일이 아직 지나지 않은 영상 1개'))).toBe(true);
    // optional range restricts publishedAt
    const ranged = queryVideos(index, q({ dateMode: 'age', ageDays: 7, range: { start: '2026-09-01', end: '2026-09-09' }, sort: 'views_at_age', now }));
    expect(ids(ranged)).toEqual(['youtube:v1']);
    expect(ranged.notes[0]).toContain('게시일이 2026-09-01~2026-09-09(Asia/Seoul)인 영상만');
    // views_period mirrors the age value in age mode
    expect(r.rows[0].metrics.viewsPeriod).toEqual(r.rows[0].metrics.viewsAtAge);
  });

  it('a scheduled premiere (published after now) is not listed and is not "data collected after now"', () => {
    const live = makeVideo({ id: 'youtube:live', publishedAt: ts('2026-09-20'), obs: [makeObs('2026-09-20T01:00Z', 5), makeObs(now - H, 50)] });
    const premiere = makeVideo({ id: 'youtube:premiere', publishedAt: now + 2 * D, firstSeenAt: now - D, lastObservedAt: now - D, obs: [] });
    const index = makeIndex({ videos: [live, premiere], generatedAt: now });
    expect(indexAsOf(index, now)).toBe(index);
    for (const dateMode of ['upload', 'activity'] as const) {
      const r = queryVideos(index, q({ dateMode, range: { start: '2026-09-20', end: '2026-10-05' }, now }));
      expect(ids(r)).toEqual(['youtube:live']);
      expect(r.notes.some((n) => n.includes('이후에 수집된'))).toBe(false);
    }
    // publish time is not a metric: no provenance-count note for that sort
    const byTime = queryVideos(index, q({ range: { start: '2026-09-20', end: '2026-10-05' }, sort: 'published_at', now }));
    expect(byTime.notes.some((n) => n.startsWith('정렬 기준'))).toBe(false);
  });

  it('validates the query', () => {
    const index = makeIndex({ videos: [], generatedAt: now });
    expect(() => queryVideos(index, q({ dateMode: 'upload' }))).toThrow(RangeError);
    expect(() => queryVideos(index, q({ dateMode: 'activity' }))).toThrow(RangeError);
    expect(() => queryVideos(index, q({ dateMode: 'age' }))).toThrow(RangeError);
    expect(() => queryVideos(index, q({ dateMode: 'age', ageDays: 5 as never }))).toThrow(RangeError);
    expect(() => queryVideos(index, q({ range: SEP, sort: 'bogus' as never }))).toThrow(RangeError);
    expect(() => queryVideos(index, q({ dateMode: 'weekly' as never, range: SEP }))).toThrow(RangeError);
    expect(() => queryVideos(index, q({ range: { start: '2026-02-30', end: '2026-03-01' } }))).toThrow(RangeError);
    const empty = queryVideos(index, q({ range: SEP, now }));
    expect(empty).toMatchObject({ rows: [], total: 0, now });
  });
});

/* ------------------------------------------------------------------------------------------ */

describe('sorting, ties and pagination', () => {
  const now = ts('2026-09-28T00:00Z');
  const RANGE = { start: '2026-09-01', end: '2026-09-27' };
  const w = resolveWindow(RANGE, SEOUL, now);
  const mk = (id: string, start: number, end: number) => makeVideo({ id, publishedAt: ts('2026-08-01'), obs: [makeObs(w.startMs, start), makeObs(w.endMs, end)] });
  const a = mk('youtube:a', 1000, 1300); // +300, total 1300
  const c = mk('youtube:c', 0, 300); // +300, total 300
  const b = mk('youtube:b', 100, 200); // +100, total 200
  const e = mk('youtube:e', 100, 200); // +100, total 200 (full tie with b -> id)
  const d = makeVideo({ id: 'youtube:d', publishedAt: ts('2026-08-01'), obs: [] }); // no data -> unrankable
  const index = makeIndex({ videos: [d, e, c, b, a], generatedAt: now });

  it('desc: unrankable last, ties by views_total desc then id asc', () => {
    expect(ids(queryVideos(index, q({ range: RANGE, now })))).toEqual(['youtube:a', 'youtube:c', 'youtube:b', 'youtube:e', 'youtube:d']);
  });

  it('asc flips only the primary order', () => {
    expect(ids(queryVideos(index, q({ range: RANGE, sortDir: 'asc', now })))).toEqual(['youtube:b', 'youtube:e', 'youtube:a', 'youtube:c', 'youtube:d']);
  });

  it('limit / offset paginate; total and percentiles come from the whole filtered set', () => {
    const all = queryVideos(index, q({ range: RANGE, now }));
    const page = queryVideos(index, q({ range: RANGE, now, limit: 2, offset: 1 }));
    expect(page.total).toBe(5);
    expect(ids(page)).toEqual(['youtube:c', 'youtube:b']);
    expect(page.rows.map((r) => r.metrics.percentile)).toEqual(all.rows.slice(1, 3).map((r) => r.metrics.percentile));
    // a, c tie at the top of 4 rankable values: (2 + 1) / 4
    expect(all.rows[0].metrics.percentile.value).toBe(75);
    expect(all.rows[1].metrics.percentile.value).toBe(75);
    expect(all.rows[2].metrics.percentile.value).toBe(25);
    expect(all.rows[4].metrics.percentile).toMatchObject({ value: null, status: 'unavailable', note: 'sort_metric_unavailable' });
    expect(ids(queryVideos(index, q({ range: RANGE, now, limit: 0 })))).toEqual([]);
    expect(ids(queryVideos(index, q({ range: RANGE, now, offset: 10 })))).toEqual([]);
    expect(ids(queryVideos(index, q({ range: RANGE, now, offset: -3, limit: 1 })))).toEqual(['youtube:a']);
    expect(queryVideos(index, q({ range: RANGE, now })).rows).toHaveLength(5); // no limit = all
  });

  it('every sort key ranks without throwing and keeps unrankable rows last', () => {
    const keys = ['views_total', 'views_period', 'likes_period', 'comments_period', 'velocity', 'growth_vs_prev', 'engagement_rate', 'outperformance', 'views_at_age', 'percentile', 'published_at'] as const;
    for (const sort of keys) {
      const r = queryVideos(index, q({ range: RANGE, now, sort, ageDays: 7 }));
      expect(r.total).toBe(5);
      let seenNull = false;
      for (const row of r.rows) {
        const m = row.metrics.percentile;
        if (m.value === null) seenNull = true;
        else expect(seenNull).toBe(false);
      }
    }
  });

  it('published_at sorts by publish time', () => {
    const v1 = makeVideo({ id: 'youtube:p1', publishedAt: ts('2026-09-02') });
    const v2 = makeVideo({ id: 'youtube:p2', publishedAt: ts('2026-09-05') });
    const idx = makeIndex({ videos: [v1, v2], generatedAt: now });
    expect(ids(queryVideos(idx, q({ range: RANGE, now, sort: 'published_at' })))).toEqual(['youtube:p2', 'youtube:p1']);
    expect(ids(queryVideos(idx, q({ range: RANGE, now, sort: 'published_at', sortDir: 'asc' })))).toEqual(['youtube:p1', 'youtube:p2']);
  });
});

/* ------------------------------------------------------------------------------------------ */

describe('notes: provenance counts', () => {
  // A 7-day window ending at `now` so a source-reported weekly value can apply.
  const RANGE = { start: '2026-09-21', end: '2026-09-27' };
  const w = resolveWindow(RANGE, SEOUL, ts('2026-09-28'));
  const now = w.endMs + H;

  it('counts lower_bound / interpolated / source_reported / unavailable values of the sort metric', () => {
    const exact = makeVideo({ id: 'dailymotion:exact', publishedAt: ts('2026-08-01'), obs: [makeObs(w.startMs, 100), makeObs(w.endMs, 500)] });
    const interp = makeVideo({ id: 'dailymotion:interp', publishedAt: ts('2026-08-01'), obs: [makeObs(w.startMs - 10 * H, 100), makeObs(w.startMs + 10 * H, 200), makeObs(w.endMs - H, 1000)] });
    const lower = makeVideo({ id: 'dailymotion:lower', publishedAt: ts('2026-01-01'), obs: [makeObs(w.startMs + 3 * D, 5_000), makeObs(w.endMs, 6_000)] });
    const source = makeVideo({ id: 'dailymotion:src', publishedAt: ts('2026-08-01'), obs: [makeObs(w.startMs - 5 * D, 10)], sourceWindows: [makeSourceWindow('views', 168, 777, w.endMs)] });
    const none = makeVideo({ id: 'dailymotion:none', publishedAt: ts('2026-08-01'), obs: [] });
    const index = makeIndex({ videos: [exact, interp, lower, source, none], generatedAt: now });
    const r = queryVideos(index, q({ range: RANGE, now }));
    const st = new Map(r.rows.map((x) => [x.video.id, x.metrics.viewsPeriod.status]));
    expect(Object.fromEntries(st)).toEqual({
      'dailymotion:exact': 'exact',
      'dailymotion:interp': 'interpolated',
      'dailymotion:lower': 'lower_bound',
      'dailymotion:src': 'source_reported',
      'dailymotion:none': 'unavailable',
    });
    const note = r.notes.find((n) => n.startsWith("정렬 기준 '기간 조회 증가량'"));
    expect(note).toBeDefined();
    expect(note).toContain('값 5개 중');
    expect(note).toContain('하한값(≥, 실제는 더 클 수 있음) 1개');
    expect(note).toContain('보간값(≈) 1개');
    expect(note).toContain('원천 보고값 1개');
    expect(note).toContain('계산 불가(—) 1개');
    expect(note).not.toContain('감소');
    expect(ids(r).at(-1)).toBe('dailymotion:none');
    // percentile status follows the sort metric's provenance
    const pst = new Map(r.rows.map((x) => [x.video.id, x.metrics.percentile.status]));
    expect(pst.get('dailymotion:lower')).toBe('lower_bound');
    expect(pst.get('dailymotion:src')).toBe('source_reported');
    expect(pst.get('dailymotion:interp')).toBe('interpolated');
  });

  it('percentile sort names its base metric', () => {
    const v = makeVideo({ id: 'youtube:x', publishedAt: ts('2026-09-22'), obs: [makeObs(w.endMs, 10)] });
    const r = queryVideos(makeIndex({ videos: [v], generatedAt: now }), q({ dateMode: 'upload', range: RANGE, sort: 'percentile', now }));
    expect(r.notes.some((n) => n.includes("'플랫폼 내 백분위(누적 조회수 기준)'"))).toBe(true);
  });
});

/* ------------------------------------------------------------------------------------------ */

describe('indexAsOf', () => {
  const now = ts('2026-09-20T00:00Z');
  const v = makeVideo({
    id: 'youtube:v',
    publishedAt: ts('2026-09-01'),
    obs: [makeObs('2026-09-10', 10), makeObs('2026-09-19', 20), makeObs('2026-09-25', 30)],
    sourceWindows: [makeSourceWindow('views', 24, 5, '2026-09-19'), makeSourceWindow('views', 24, 7, '2026-09-25')],
  });
  const future = makeVideo({ id: 'youtube:future', publishedAt: ts('2026-09-22'), obs: [makeObs('2026-09-23', 1)] });
  const lateSeen = makeVideo({ id: 'youtube:lateseen', publishedAt: ts('2026-09-05'), firstSeenAt: ts('2026-09-24'), obs: [makeObs('2026-09-24', 1)] });
  const untouched = makeVideo({ id: 'youtube:old', publishedAt: ts('2026-09-01'), obs: [makeObs('2026-09-02', 1)] });
  const acc = makeAccount({ id: 'youtube:acc1', followers: [{ t: ts('2026-09-10'), value: 5, src: 's' }, { t: ts('2026-09-25'), value: 9, src: 's' }] });
  const index = makeIndex({ videos: [v, future, lateSeen, untouched], accounts: [acc], generatedAt: ts('2026-09-28') });

  it('returns the index itself when nothing lies after now', () => {
    expect(indexAsOf(index, ts('2026-09-28'))).toBe(index);
    expect(indexAsOf(index, ts('2027-01-01'))).toBe(index);
  });

  it('drops later videos, observations, source windows and follower points; cached per now', () => {
    const snap = indexAsOf(index, now);
    expect(snap).not.toBe(index);
    expect(indexAsOf(index, now)).toBe(snap);
    expect(indexAsOf(snap, now)).toBe(snap);
    expect(snap.dataset.videos.map((x) => x.id)).toEqual(['youtube:v', 'youtube:old']);
    const tv = snap.videosById.get('youtube:v')!;
    expect(tv.obs.map((p) => p.views)).toEqual([10, 20]);
    expect(tv.sourceWindows.map((s) => s.value)).toEqual([5]);
    expect(tv.lastObservedAt).toBe(ts('2026-09-19'));
    expect(snap.videosById.get('youtube:old')).toBe(untouched);
    expect(snap.accountsById.get('youtube:acc1')!.followers.map((p) => p.value)).toEqual([5]);
    // the original is not mutated
    expect(v.obs).toHaveLength(3);
    expect(acc.followers).toHaveLength(2);
  });
});

describe('helpers', () => {
  it('percentileRanks uses mid-ranks', () => {
    expect(percentileRanks([10, 20, 20, 30])).toEqual([12.5, 50, 50, 87.5]);
    expect(percentileRanks([30, 10])).toEqual([75, 25]);
    expect(percentileRanks([7])).toEqual([50]);
    expect(percentileRanks([])).toEqual([]);
  });

  it('medianOf', () => {
    expect(medianOf([])).toBeNull();
    expect(medianOf([3, 1, 2])).toBe(2);
    expect(medianOf([4, 1, 3, 2])).toBe(2.5);
    const input = [3, 1, 2];
    medianOf(input);
    expect(input).toEqual([3, 1, 2]);
  });

  it('sumIncrements merges statuses honestly', () => {
    const m = (value: number | null, status: MetricValue['status'], note: string | null = null, asOf: number | null = 1): MetricValue => ({ value, status, asOf, note });
    expect(sumIncrements([])).toMatchObject({ value: 0, status: 'exact', note: 'no_tracked_videos' });
    expect(sumIncrements([m(1, 'exact'), m(2, 'exact', null, 5)])).toMatchObject({ value: 3, status: 'exact', asOf: 5, note: null });
    expect(sumIncrements([m(1, 'exact'), m(2, 'interpolated')])).toMatchObject({ value: 3, status: 'interpolated' });
    expect(sumIncrements([m(1, 'interpolated'), m(2, 'source_reported')])).toMatchObject({ value: 3, status: 'source_reported' });
    expect(sumIncrements([m(1, 'exact'), m(2, 'lower_bound', 'gap_too_wide')])).toMatchObject({ value: 3, status: 'lower_bound' });
    // an unmeasurable contributor makes the sum a lower bound (its increase is >= 0) ...
    expect(sumIncrements([m(1, 'exact'), m(null, 'unavailable', 'before_first_observation')])).toMatchObject({ value: 1, status: 'lower_bound', note: 'before_first_observation', unknown: 1 });
    // ... but a counter the source never provides is simply not part of the sum
    expect(sumIncrements([m(1, 'exact'), m(null, 'unavailable', 'counter_not_provided')])).toMatchObject({ value: 1, status: 'exact' });
    // decreases are excluded, never summed as negative popularity
    expect(sumIncrements([m(5, 'exact'), m(-3, 'decrease_flagged', 'counter_decreased')])).toMatchObject({ value: 5, status: 'exact', decreased: 1 });
    expect(sumIncrements([m(null, 'unavailable', 'counter_not_provided')])).toMatchObject({ value: null, status: 'unavailable', note: 'counter_not_provided' });
    expect(sumIncrements([m(null, 'unavailable', 'gap_too_wide')])).toMatchObject({ value: null, status: 'unavailable', note: 'gap_too_wide' });
  });
});

/* ------------------------------------------------------------------------------------------ */

describe('performance', () => {
  it('20k videos x 40 observations: one activity query well under 1s', () => {
    const now = ts('2026-09-28');
    const platforms: Platform[] = ['youtube', 'dailymotion', 'peertube', 'niconico'];
    const videos: Video[] = [];
    for (let i = 0; i < 20_000; i++) {
      const pub = now - (1 + (i % 120)) * D - (i % 24) * H;
      const span = now - pub;
      const obs = [];
      for (let k = 0; k < 40; k++) obs.push(makeObs(pub + (span * (k + 1)) / 41, (i % 997) * 100 * (k + 1), (i % 7) * k, k, null));
      const p = platforms[i % 4];
      videos.push(
        makeVideo({
          id: `${p}:v${i}`,
          title: `영상 ${i}`,
          accountId: `${p}:a${i % 800}`,
          publishedAt: pub,
          obs,
          topics: [`t${i % 300}`],
          categories: [cat(i % 2 ? 'beauty/skincare' : 'gaming')],
        }),
      );
    }
    const index = makeIndex({ videos, generatedAt: now });
    const t0 = performance.now();
    const r = queryVideos(index, q({ range: { start: '2026-09-01', end: '2026-09-27' }, sort: 'views_period', limit: 50, now }));
    const cold = performance.now() - t0;
    expect(r.total).toBe(20_000);
    expect(r.rows).toHaveLength(50);
    expect(cold).toBeLessThan(1000);
    const t1 = performance.now();
    queryVideos(index, q({ dateMode: 'upload', range: { start: '2026-09-01', end: '2026-09-27' }, sort: 'percentile', q: '영상', categories: ['beauty'], limit: 50, now }));
    queryVideos(index, q({ dateMode: 'age', ageDays: 7, sort: 'views_at_age', limit: 50, now }));
    expect(performance.now() - t1).toBeLessThan(1000);
  });
});
