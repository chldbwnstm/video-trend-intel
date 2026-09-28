import { describe, expect, it } from 'vitest';
import { computeOpportunities, resolveExplorePlatform } from '../src/explore.ts';
import type { ExploreOptions } from '../src/explore.ts';
import type { Platform, Video } from '../src/types.ts';
import { HOUR_MS, makeIndex, makeObs, makeVideo, ts } from './fixtures.ts';

const H = HOUR_MS;
const SEOUL = 'Asia/Seoul';
const NOW = ts('2026-09-28T00:00Z');
const RANGE = { start: '2026-09-01', end: '2026-09-27' };

const cat = (id: string) => ({ id, confidence: 0.9, evidence: [], by: 'rule' as const, version: 'test' });

let seq = 0;
function up(topic: string | string[], views: number | null, extra: Partial<Video> & { platform?: Platform } = {}): Video {
  const platform = extra.platform ?? 'youtube';
  return makeVideo({
    id: `${platform}:e${++seq}`,
    publishedAt: ts('2026-09-10'),
    topics: Array.isArray(topic) ? topic : [topic],
    obs: [makeObs(ts('2026-09-10T06:00Z'), views === null ? null : Math.floor(views / 10), 1), makeObs(NOW - H, views, 2)],
    ...extra,
  });
}

const opts = (o: Partial<ExploreOptions> = {}): ExploreOptions => ({ range: RANGE, tz: SEOUL, now: NOW, ...o });

describe('computeOpportunities', () => {
  const A = [100, 200, 300].map((v) => up('a', v));
  const B = [10, 20, 30, 40, 50].map((v) => up('b', v));
  const C = [1000, 2000, 3000].map((v) => up('c', v, { categories: [cat('gaming')], language: 'ko' }));
  const others = [
    // another platform: excluded from a YouTube analysis
    up('a', 9_999_999, { platform: 'dailymotion' }),
    up('a', 9_999_999, { platform: 'dailymotion' }),
    // uploaded before the window: not supply of this window
    up('a', 5_000_000, { publishedAt: ts('2026-08-20') }),
    // only two videos: below minSupply
    up('d', 50_000),
    up('d', 60_000),
  ];
  const index = makeIndex({ videos: [...A, ...B, ...C, ...others], generatedAt: NOW });

  it('demand = median latest views, supply = uploads in window, score = demand pct - supply pct', () => {
    const r = computeOpportunities(index, opts());
    expect(r.map((x) => x.topic)).toEqual(['c', 'a', 'b']);
    const [c, a, b] = r;
    expect(c).toMatchObject({ topic: 'c', label: 'c', demand: 2000, supply: 3 });
    expect(a).toMatchObject({ demand: 200, supply: 3 });
    expect(b).toMatchObject({ demand: 30, supply: 5 });
    // demand ranks: b < a < c ; supply ranks: a = c < b (mid-rank)
    expect(c.demandPercentile).toBeCloseTo((2.5 / 3) * 100, 9);
    expect(a.demandPercentile).toBeCloseTo(50, 9);
    expect(b.demandPercentile).toBeCloseTo((0.5 / 3) * 100, 9);
    expect(a.supplyPercentile).toBeCloseTo((1 / 3) * 100, 9);
    expect(c.supplyPercentile).toBeCloseTo((1 / 3) * 100, 9);
    expect(b.supplyPercentile).toBeCloseTo((2.5 / 3) * 100, 9);
    for (const x of r) expect(x.score).toBeCloseTo(x.demandPercentile - x.supplyPercentile, 9);
    expect(c.score).toBeCloseTo(50, 9);
    expect(b.score).toBeCloseTo(-66.6667, 3);
    // samples: most viewed first
    expect(c.sampleVideoIds).toEqual([C[2].id, C[1].id, C[0].id]);
    expect(b.sampleVideoIds).toEqual([B[4].id, B[3].id, B[2].id, B[1].id, B[0].id]);
  });

  it('works within one platform: explicit, or the platform with the most uploads', () => {
    expect(resolveExplorePlatform(index, opts())).toBe('youtube');
    expect(resolveExplorePlatform(index, opts({ platform: 'dailymotion' }))).toBe('dailymotion');
    const dm = computeOpportunities(index, opts({ platform: 'dailymotion', minSupply: 2 }));
    expect(dm).toHaveLength(1);
    expect(dm[0]).toMatchObject({ topic: 'a', demand: 9_999_999, supply: 2, demandPercentile: 50, supplyPercentile: 50, score: 0 });
    expect(computeOpportunities(index, opts({ platform: 'tiktok' }))).toEqual([]);
    expect(resolveExplorePlatform(makeIndex({ videos: [], generatedAt: NOW }), opts())).toBeNull();
    expect(computeOpportunities(makeIndex({ videos: [], generatedAt: NOW }), opts())).toEqual([]);
  });

  it('minSupply (default 3), limit, category and language filters', () => {
    expect(computeOpportunities(index, opts()).some((x) => x.topic === 'd')).toBe(false);
    expect(computeOpportunities(index, opts({ minSupply: 2 })).find((x) => x.topic === 'd')).toMatchObject({ demand: 55_000, supply: 2 });
    expect(computeOpportunities(index, opts({ limit: 1 })).map((x) => x.topic)).toEqual(['c']);
    expect(computeOpportunities(index, opts({ categories: ['gaming'] })).map((x) => x.topic)).toEqual(['c']);
    expect(computeOpportunities(index, opts({ languages: ['KO'] })).map((x) => x.topic)).toEqual(['c']);
  });

  it('videos without a views counter count as supply but not demand (null is not zero)', () => {
    const vs = [...[100, 200, 300].map((v) => up('p', v)), up('p', null)];
    const r = computeOpportunities(makeIndex({ videos: vs, generatedAt: NOW }), opts());
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ demand: 200, supply: 4 });
    expect(r[0].sampleVideoIds).not.toContain(vs[3].id);
    // not enough videos with views -> not listed
    const few = [up('q', 100), up('q', null), up('q', null)];
    expect(computeOpportunities(makeIndex({ videos: few, generatedAt: NOW }), opts())).toEqual([]);
  });

  it('a video counts once per topic even if the topic is repeated; multi-topic videos feed each topic', () => {
    const vs = [up(['m', 'm', 'n'], 10), up(['m', 'n'], 20), up(['m', 'n'], 30)];
    const r = computeOpportunities(makeIndex({ videos: vs, generatedAt: NOW }), opts());
    expect(r.map((x) => [x.topic, x.supply, x.demand])).toEqual([
      ['m', 3, 20],
      ['n', 3, 20],
    ]);
  });

  it('a still-running window only counts uploads up to now; later observations are ignored', () => {
    const inside = [1, 2, 3].map((i) => up('r', 100 * i, { publishedAt: ts('2026-09-25') }));
    const future = makeVideo({ id: 'youtube:future', topics: ['r'], publishedAt: ts('2026-09-29'), obs: [makeObs('2026-09-30', 1_000_000)] });
    const grown = inside.map((v) => ({ ...v, obs: [...v.obs, makeObs('2026-10-02', 7_777_777)] }));
    const idx = makeIndex({ videos: [...grown, future], generatedAt: ts('2026-10-03') });
    const r = computeOpportunities(idx, opts({ range: { start: '2026-09-21', end: '2026-10-04' } }));
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ topic: 'r', supply: 3, demand: 200 });
  });

  it('latest views fall back to the latest earlier observation (lower bound) when nothing is observed at now', () => {
    const stale = [1, 2, 3].map((i) =>
      makeVideo({ id: `youtube:st${i}`, topics: ['s'], publishedAt: ts('2026-09-05'), obs: [makeObs('2026-09-06', 10 * i), makeObs('2026-09-15', 100 * i)] }),
    );
    const r = computeOpportunities(makeIndex({ videos: stale, generatedAt: NOW }), opts());
    expect(r[0]).toMatchObject({ topic: 's', demand: 200, supply: 3 });
  });
});
