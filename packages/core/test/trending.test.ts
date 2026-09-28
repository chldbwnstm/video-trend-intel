import { describe, expect, it } from 'vitest';
import { computeTrending } from '../src/trending.ts';
import type { TrendingOptions } from '../src/trending.ts';
import { localDateStartUtc, previousWindow, resolveWindow } from '../src/time.ts';
import type { ObservationPoint, Platform, TrendItem, Video } from '../src/types.ts';
import { DAY_MS, HOUR_MS, makeAccount, makeIndex, makeObs, makeSourceWindow, makeVideo, ts } from './fixtures.ts';

const H = HOUR_MS;
const D = DAY_MS;
const SEOUL = 'Asia/Seoul';
const RANGE = { start: '2026-09-21', end: '2026-09-27' };
const w = resolveWindow(RANGE, SEOUL, ts('2026-10-01'));
const prev = previousWindow(w, ts('2026-10-01'));
/** The window has finished one hour ago. */
const NOW = w.endMs + H;

const cat = (id: string) => ({ id, confidence: 0.9, evidence: [], by: 'rule' as const, version: 'test' });

let seq = 0;
/**
 * A video observed exactly at the previous-window start, the window start and the window end. Videos rotate
 * over three channels unless an account is given (a topic needs two channels to be a trend).
 */
function vid(
  prevInc: number,
  curInc: number,
  extra: Partial<Video> & { platform?: Platform } = {},
  base = 1_000,
): Video {
  const platform = extra.platform ?? 'youtube';
  const n = ++seq;
  return makeVideo({
    id: `${platform}:t${n}`,
    accountId: `${platform}:ch${n % 3}`,
    publishedAt: ts('2026-08-01'),
    obs: [makeObs(prev.startMs, base), makeObs(w.startMs, base + prevInc), makeObs(w.endMs, base + prevInc + curInc)],
    ...extra,
  });
}

function topicVideos(topic: string, prevInc: number, curInc: number, n = 3, extra: Partial<Video> = {}): Video[] {
  return Array.from({ length: n }, () => vid(prevInc, curInc, { topics: [topic], ...extra }));
}

const opts = (o: Partial<TrendingOptions> = {}): TrendingOptions => ({ kind: 'topic', range: RANGE, tz: SEOUL, now: NOW, ...o });
const keys = (items: TrendItem[]) => items.map((i) => i.key);
const byKey = (items: TrendItem[], key: string) => items.find((i) => i.key === key)!;

/* ------------------------------------------------------------------------------------------ */

describe('growth math and lists', () => {
  const videos = [
    ...topicVideos('alpha', 100, 300), // 900 vs 300 -> +200%
    ...topicVideos('beta', 1000, 500), // 1500 vs 3000 -> -50%
    ...topicVideos('gamma', 40, 1000), // 3000 vs 120 -> +2400%
    ...topicVideos('delta', 200, 200), // 600 vs 600 -> 0
    ...topicVideos('tiny', 1, 5), // 15 vs 3 -> +400% but tiny volume
  ];
  const index = makeIndex({ videos, generatedAt: NOW });
  const r = computeTrending(index, opts());

  it('sums current / previous increments per entity and computes growth = current / previous - 1', () => {
    const alpha = byKey(r.top, 'alpha');
    expect(alpha).toMatchObject({ kind: 'topic', key: 'alpha', label: 'alpha', platform: 'youtube', current: 900, previous: 300, videoCount: 3, incompleteCount: 0 });
    expect(alpha.growth).toBeCloseTo(2, 12);
    expect(byKey(r.top, 'beta').growth).toBeCloseTo(-0.5, 12);
    expect(byKey(r.top, 'gamma').growth).toBeCloseTo(24, 12);
    expect(byKey(r.top, 'delta').growth).toBe(0);
    expect(r.window).toEqual(w);
    expect(r.previousWindow).toMatchObject({ startMs: prev.startMs, endMs: w.startMs });
  });

  it('rising by growth with a volume threshold (default: lower quartile of current), falling by growth, top by current', () => {
    // positive currents 15, 600, 900, 1500, 3000 -> lower quartile 600: 'tiny' (15) is not "rising"
    expect(keys(r.rising)).toEqual(['gamma', 'alpha']);
    expect(keys(r.falling)).toEqual(['beta']);
    expect(keys(r.top)).toEqual(['gamma', 'beta', 'alpha', 'delta', 'tiny']);
    expect(r.notes.some((n) => n.includes('이번 기간 증가량 600 이상'))).toBe(true);
    // an explicit volume threshold alone does not admit 'tiny': its baseline (3) is below the default baseline
    // threshold (max(100, lower quartile of previous: 3, 120, 300, 600, 3000 -> 120))
    expect(keys(computeTrending(index, opts({ minCurrent: 10 })).rising)).toEqual(['gamma', 'alpha']);
    const explicit = computeTrending(index, opts({ minCurrent: 10, minPrevious: 1 }));
    expect(keys(explicit.rising)).toEqual(['gamma', 'tiny', 'alpha']);
    expect(keys(computeTrending(index, opts({ minCurrent: 1000 })).rising)).toEqual(['gamma']);
  });

  it('notes explain the date semantics (Korean) and single-platform scope has no unit caveat', () => {
    expect(r.notes[0]).toContain('조회 발생 기간 기준');
    expect(r.notes[0]).toContain('2026-09-21~2026-09-27(Asia/Seoul)');
    expect(r.notes[0]).toContain('2026-09-14~2026-09-20');
    expect(r.notes.some((n) => n.includes('같은 영상 집합 비교') && n.includes('15개 중 15개'))).toBe(true);
    expect(r.notes.some((n) => n.includes('여러 플랫폼'))).toBe(false);
  });

  it('topVideoIds are the biggest contributors first (max 5), limit cuts every list', () => {
    const vs = [5, 1, 9, 3, 7, 2].map((k) => vid(10, k * 100, { topics: ['many'] }));
    const idx = makeIndex({ videos: vs, generatedAt: NOW });
    const t = computeTrending(idx, opts());
    const order = [...vs].sort((a, b) => b.obs[2].views! - a.obs[2].views!).map((v) => v.id);
    expect(byKey(t.top, 'many').topVideoIds).toEqual(order.slice(0, 5));
    const limited = computeTrending(index, opts({ limit: 1 }));
    expect(limited.top).toHaveLength(1);
    expect(limited.rising).toHaveLength(1);
    expect(limited.falling).toHaveLength(1);
  });

  it('minVideos filters entities (default 3)', () => {
    const idx = makeIndex({ videos: [...topicVideos('pair', 10, 20, 2), ...topicVideos('trio', 10, 20, 3)], generatedAt: NOW });
    expect(keys(computeTrending(idx, opts()).top)).toEqual(['trio']);
    expect(keys(computeTrending(idx, opts({ minVideos: 2 })).top)).toEqual(['trio', 'pair']);
    expect(r.notes.some((n) => n.includes('합산 영상이 3개 이상'))).toBe(true);
  });

  it('is deterministic for a fixed now', () => {
    expect(computeTrending(index, opts())).toEqual(r);
  });
});

/* ------------------------------------------------------------------------------------------ */

describe('coverage honesty', () => {
  it('new uploads count 0 in the previous window; an entity with no previous increase has no growth (top only)', () => {
    const fresh = [0, 1, 2].map((i) =>
      makeVideo({ id: `youtube:f${i}`, accountId: `youtube:fch${i}`, topics: ['fresh'], publishedAt: w.startMs + D, obs: [makeObs(w.startMs + D + H, 5), makeObs(w.endMs, 500 + i)] }),
    );
    const index = makeIndex({ videos: [...fresh, ...topicVideos('alpha', 100, 300)], generatedAt: NOW });
    const r = computeTrending(index, opts());
    const f = byKey(r.top, 'fresh');
    expect(f).toMatchObject({ current: 1503, previous: 0, growth: null, videoCount: 3 });
    expect(keys(r.rising)).toEqual(['alpha']);
    expect(r.notes.some((n) => n.includes('새 항목 1개'))).toBe(true);
  });

  it('videos whose increments cannot be measured in both windows are counted as incomplete, not summed', () => {
    const base = topicVideos('alpha', 100, 300);
    // discovered in the middle of the window: current is only a lower bound, previous unknown
    const late = makeVideo({ id: 'youtube:late', topics: ['alpha'], publishedAt: ts('2026-01-01'), obs: [makeObs(w.startMs + 2 * D, 50_000), makeObs(w.endMs, 90_000)] });
    // a source that does not provide views at all
    const noViews = makeVideo({ id: 'youtube:noviews', topics: ['alpha'], publishedAt: ts('2026-08-01'), obs: [makeObs(prev.startMs, null, 5), makeObs(w.startMs, null, 6), makeObs(w.endMs, null, 9)] });
    const index = makeIndex({ videos: [...base, late, noViews], generatedAt: NOW });
    const r = computeTrending(index, opts());
    const alpha = byKey(r.top, 'alpha');
    expect(alpha).toMatchObject({ current: 900, previous: 300, videoCount: 3, incompleteCount: 2 });
    expect(alpha.topVideoIds).not.toContain('youtube:late');
    expect(r.notes.some((n) => n.includes('영상 2개는 합산하지 않고') && n.includes('그중 1개는 원천이 조회수를 제공하지 않음'))).toBe(true);
    expect(r.notes.some((n) => n.includes('5개 중 3개를 합산'))).toBe(true);
  });

  it('a decreasing counter (deletion / correction) is excluded, never negative popularity', () => {
    const base = topicVideos('alpha', 100, 300);
    const deleted = makeVideo({ id: 'youtube:deleted', topics: ['alpha'], status: 'deleted', publishedAt: ts('2026-08-01'), obs: [makeObs(prev.startMs, 1_000), makeObs(w.startMs, 90_000), makeObs(w.endMs, 1_000)] });
    const index = makeIndex({ videos: [...base, deleted], generatedAt: NOW });
    const r = computeTrending(index, opts());
    expect(byKey(r.top, 'alpha')).toMatchObject({ current: 900, previous: 300, videoCount: 3, incompleteCount: 0 });
    expect(r.falling).toEqual([]);
    expect(r.notes.some((n) => n.includes('조회수가 줄어든 영상 1개'))).toBe(true);
  });

  it('a source-reported weekly value covers a current window our observations cannot close', () => {
    const base = topicVideos('alpha', 100, 300);
    const weekly = makeVideo({
      id: 'dailymotion:weekly',
      topics: ['alpha'],
      publishedAt: ts('2026-08-01'),
      obs: [makeObs(prev.startMs, 1_000), makeObs(w.startMs, 1_100), makeObs(w.startMs + 2 * D, 1_200)],
      sourceWindows: [makeSourceWindow('views', 168, 700, w.endMs)],
    });
    const index = makeIndex({ videos: [...base, weekly], generatedAt: NOW });
    const r = computeTrending(index, opts());
    expect(byKey(r.top, 'alpha')).toMatchObject({ current: 1600, previous: 400, videoCount: 4, platform: null });
    expect(r.notes.some((n) => n.includes('원천 보고값'))).toBe(true);
    expect(r.notes.some((n) => n.includes('여러 플랫폼(YouTube·Dailymotion)'))).toBe(true);
    // restricting to one platform removes the caveat
    const yt = computeTrending(index, opts({ platforms: ['youtube'] }));
    expect(byKey(yt.top, 'alpha')).toMatchObject({ current: 900, platform: 'youtube' });
    expect(yt.notes.some((n) => n.includes('여러 플랫폼'))).toBe(false);
  });
});

describe('growth baselines (rising / falling)', () => {
  it('ranks growth only over a real previous baseline: large enough and spread over several videos', () => {
    // 'tiny': previous total 1 (the publish ramp of videos uploaded minutes before the previous window ended),
    // current 10,000 each -> +2,999,900% if taken at face value
    const tinyBase = [0, 1, 2].map((i) =>
      vid(0, 10_000, { id: `youtube:tb${i}`, topics: ['tiny'], obs: [makeObs(w.startMs - 60_000, i === 0 ? 1 : 0), makeObs(w.endMs, 10_000 + (i === 0 ? 1 : 0))], publishedAt: w.startMs - 2 * 60_000 }),
    );
    // 'big': 100k -> 200k per video in the previous week, then +300k -> +200%
    const big = topicVideos('big', 100_000, 300_000);
    // 'solo-base': a large previous value, but carried by one video; the others are new uploads
    const soloBase = [
      vid(90_000, 100_000, { topics: ['solo-base'] }),
      ...[0, 1].map((i) => makeVideo({ id: `youtube:sb${i}`, accountId: `youtube:sbch${i}`, topics: ['solo-base'], publishedAt: w.startMs + D, obs: [makeObs(w.startMs + D + H, 10), makeObs(w.endMs, 900_000)] })),
    ];
    const index = makeIndex({ videos: [...tinyBase, ...big, ...soloBase], generatedAt: NOW });
    const r = computeTrending(index, opts({ minPrevious: 50 }));
    expect(byKey(r.top, 'tiny')).toMatchObject({ previous: 1, current: 30_000 });
    expect(keys(r.rising)).toEqual(['big']);
    expect(byKey(r.top, 'solo-base').growth).toBeGreaterThan(19);
    expect(r.notes.some((n) => n.includes('직전 기간 기준값이 작거나 몇 개 영상에만 기댄 항목 2개'))).toBe(true);
    // default baseline threshold (lower quartile of positive previous sums) also rejects 'tiny'
    expect(keys(computeTrending(index, opts()).rising)).not.toContain('tiny');
  });

  it('the default baseline is at least 100 views even when every entity is small', () => {
    const small = topicVideos('small', 20, 200); // 60 -> 600
    const index = makeIndex({ videos: small, generatedAt: NOW });
    expect(computeTrending(index, opts()).rising).toEqual([]);
    expect(keys(computeTrending(index, opts({ minPrevious: 50 })).rising)).toEqual(['small']);
  });

  it('falling needs the same baseline', () => {
    const shrinking = topicVideos('shrink', 1_000, 10);
    const oneCarrier = [vid(5_000, 0, { topics: ['carried'] }), ...[0, 1].map(() => vid(0, 0, { topics: ['carried'] }))];
    const index = makeIndex({ videos: [...shrinking, ...oneCarrier], generatedAt: NOW });
    const r = computeTrending(index, opts({ minPrevious: 1 }));
    expect(keys(r.falling)).toEqual(['shrink']);
  });
});

describe('topic entities', () => {
  it('a topic used by a single channel is not a trend (default minAccounts 2 for topics)', () => {
    const own = [0, 1, 2].map(() => vid(100, 300, { topics: ['my-series'], accountId: 'youtube:one' }));
    const shared = topicVideos('shared', 100, 300);
    const index = makeIndex({ videos: [...own, ...shared], generatedAt: NOW });
    const r = computeTrending(index, opts());
    expect(keys(r.top)).toEqual(['shared']);
    expect(r.notes.some((n) => n.includes('한 채널에서만 쓰인 주제 1개'))).toBe(true);
    expect(keys(computeTrending(index, opts({ minAccounts: 1 })).top).sort()).toEqual(['my-series', 'shared']);
    // creators / accounts / categories are not restricted
    expect(computeTrending(index, opts({ kind: 'account', minVideos: 3 })).top.map((i) => i.key)).toContain('youtube:one');
  });

  it("generic tags and a channel's own name used as a tag are not topics", () => {
    const channels = [
      { id: 'youtube:ytn', name: 'YTN news', handle: '@ytnnews24', tags: ['ytn news', 'ytnnews24', 'ytn'] },
      { id: 'youtube:pet', name: '노트펫', handle: '@notepet', tags: ['노트펫', 'notepet'] },
      { id: 'youtube:ogn', name: 'OGN PLUS', handle: null, tags: ['ogn plus', 'ognplus'] },
    ];
    const accounts = channels.map((c) => makeAccount({ id: c.id, name: c.name, handle: c.handle }));
    const videos = channels.flatMap((c) => [0, 1, 2].map(() => vid(100, 300, { accountId: c.id, topics: ['뉴스', ...c.tags, '태풍'] })));
    const index = makeIndex({ videos, accounts, generatedAt: NOW });
    // even with one channel allowed per topic, only the content topic remains
    const r = computeTrending(index, opts({ minAccounts: 1 }));
    expect(keys(r.top)).toEqual(['태풍']);
  });
});

/* ------------------------------------------------------------------------------------------ */

describe('windows', () => {
  it('a running window is compared with the same elapsed span of the previous window', () => {
    const now = w.startMs + 3.5 * D;
    const elapsed = 3.5 * D;
    const mk = (i: number): Video =>
      makeVideo({
        id: `youtube:r${i}`,
        accountId: `youtube:rch${i}`,
        topics: ['run'],
        publishedAt: ts('2026-08-01'),
        obs: [
          makeObs(prev.startMs, 1_000),
          makeObs(prev.startMs + elapsed, 1_100), // +100 in the first 3.5 days of the previous week
          makeObs(w.startMs, 5_000), // (rest of previous week: not compared)
          makeObs(now, 5_300), // +300 so far this week
        ],
      });
    const index = makeIndex({ videos: [mk(1), mk(2), mk(3)], generatedAt: now });
    const r = computeTrending(index, opts({ now }));
    expect(r.window.incomplete).toBe(true);
    expect(r.previousWindow).toMatchObject({ startMs: prev.startMs, endMs: prev.startMs + elapsed, incomplete: false });
    const item = byKey(r.top, 'run');
    expect(item).toMatchObject({ current: 900, previous: 300 });
    expect(item.growth).toBeCloseTo(2, 12);
    expect(r.notes.some((n) => n.includes('같은 경과 시간(약 84시간)'))).toBe(true);
  });

  it('rolling windows are labelled with date-times, and a short elapsed span in minutes', () => {
    const at = localDateStartUtc('2026-09-29', SEOUL) + 26 * 60_000; // 2026-09-29 00:26 KST
    const vs = [0, 1, 2].map((i) =>
      makeVideo({ id: `youtube:w${i}`, accountId: `youtube:wch${i}`, topics: ['x'], publishedAt: ts('2026-08-01'), obs: [makeObs(at - 72 * H, 100), makeObs(at - 48 * H, 200), makeObs(at - 24 * H, 400), makeObs(at, 900)] }),
    );
    const index = makeIndex({ videos: vs, generatedAt: at });
    const rolling = computeTrending(index, opts({ now: at, rollingHours: 24 }));
    expect(rolling.notes[0]).toContain('2026-09-28 00:26 ~ 2026-09-29 00:26 (Asia/Seoul)');
    expect(rolling.notes[0]).not.toContain('2026-09-28~2026-09-29');
    const today = computeTrending(index, opts({ now: at, range: { start: '2026-09-29', end: '2026-09-29' } }));
    expect(today.notes.join('\n')).toContain('같은 경과 시간(약 26분)');
    expect(today.notes.join('\n')).not.toContain('약 0시간');
  });

  it('a window that has not started yet returns empty lists with an explanation', () => {
    const index = makeIndex({ videos: topicVideos('alpha', 100, 300), generatedAt: NOW });
    const r = computeTrending(index, opts({ range: { start: '2026-12-01', end: '2026-12-07' } }));
    expect(r.rising).toEqual([]);
    expect(r.top).toEqual([]);
    expect(r.notes[0]).toContain('아직 집계할 조회 증가가 없습니다');
  });

  it('observations collected after now are ignored (as-of snapshot)', () => {
    const vs = topicVideos('alpha', 100, 300).map((v) => ({ ...v, obs: [...v.obs, makeObs(w.endMs + 5 * D, 999_999)] }));
    const index = makeIndex({ videos: vs, generatedAt: w.endMs + 6 * D });
    const r = computeTrending(index, opts());
    expect(byKey(r.top, 'alpha')).toMatchObject({ current: 900, previous: 300 });
    expect(r.notes.some((n) => n.includes('이후에 수집된 관측값'))).toBe(true);
  });

  it('rejects unknown kinds and malformed ranges', () => {
    const index = makeIndex({ videos: [], generatedAt: NOW });
    expect(() => computeTrending(index, opts({ kind: 'hashtag' as never }))).toThrow(RangeError);
    expect(() => computeTrending(index, opts({ range: { start: '2026-13-01', end: '2026-13-02' } }))).toThrow(RangeError);
  });
});

/* ------------------------------------------------------------------------------------------ */

describe('entity kinds', () => {
  it('category: subcategories roll up into their top-level family; labels are path labels', () => {
    const skin = topicVideos('x', 100, 200, 3, { categories: [cat('beauty/skincare')] });
    const makeup = topicVideos('y', 100, 400, 3, { categories: [cat('beauty/makeup')] });
    const game = topicVideos('z', 100, 50, 3, { categories: [cat('gaming'), cat('gaming/esports')] });
    const index = makeIndex({ videos: [...skin, ...makeup, ...game], generatedAt: NOW });
    const r = computeTrending(index, opts({ kind: 'category' }));
    expect(byKey(r.top, 'beauty')).toMatchObject({ kind: 'category', label: '뷰티', current: 1800, previous: 600, videoCount: 6 });
    expect(byKey(r.top, 'beauty/skincare')).toMatchObject({ label: '뷰티 › 스킨케어', current: 600, videoCount: 3 });
    expect(byKey(r.top, 'beauty/makeup')).toMatchObject({ current: 1200 });
    // a video tagged with both the family and a subcategory counts once in the family
    expect(byKey(r.top, 'gaming')).toMatchObject({ current: 150, videoCount: 3 });
    expect(byKey(r.top, 'gaming/esports')).toMatchObject({ current: 150, videoCount: 3 });
    expect(r.notes.some((n) => n.includes('상위 분야와 세부 분야'))).toBe(true);
    // a category filter keeps entities inside the filtered subtree
    const filtered = computeTrending(index, opts({ kind: 'category', categories: ['beauty/skincare'] }));
    expect(keys(filtered.top)).toEqual(['beauty/skincare']);
    const family = computeTrending(index, opts({ kind: 'category', categories: ['beauty'] }));
    expect(keys(family.top).sort()).toEqual(['beauty', 'beauty/makeup', 'beauty/skincare']);
  });

  it('creator: linked accounts merge across platforms; unlinked accounts stand alone', () => {
    const videos = [
      vid(100, 300, { platform: 'youtube', accountId: 'youtube:c1yt' }),
      vid(100, 300, { platform: 'youtube', accountId: 'youtube:c1yt' }),
      vid(50, 100, { platform: 'tiktok', id: 'tiktok:k1', accountId: 'tiktok:c1tt' }),
      vid(50, 100, { platform: 'tiktok', id: 'tiktok:k2', accountId: 'tiktok:c1tt' }),
      ...[1, 2, 3].map(() => vid(10, 20, { accountId: 'youtube:solo' })),
    ];
    const index = makeIndex({
      videos,
      accounts: [
        makeAccount({ id: 'youtube:c1yt', name: 'C1 YT', creatorId: 'c1' }),
        makeAccount({ id: 'tiktok:c1tt', name: 'C1 TT', creatorId: 'c1' }),
        makeAccount({ id: 'youtube:solo', name: '혼자 채널' }),
      ],
      creators: [{ id: 'c1', name: '크리에이터 원', accountIds: ['youtube:c1yt', 'tiktok:c1tt'], linkStatus: 'verified', note: null }],
      generatedAt: NOW,
    });
    const r = computeTrending(index, opts({ kind: 'creator' }));
    expect(byKey(r.top, 'c1')).toMatchObject({ kind: 'creator', label: '크리에이터 원', platform: null, current: 800, previous: 300, videoCount: 4 });
    expect(byKey(r.top, 'youtube:solo')).toMatchObject({ label: '혼자 채널', platform: 'youtube', current: 60, videoCount: 3 });
    expect(r.notes.some((n) => n.includes('크리에이터에 연결된 계정은 여러 플랫폼을 합산'))).toBe(true);
    expect(r.notes.some((n) => n.includes('여러 플랫폼(YouTube·TikTok)'))).toBe(true);

    const acc = computeTrending(index, opts({ kind: 'account', minVideos: 2 }));
    expect(byKey(acc.top, 'youtube:c1yt')).toMatchObject({ kind: 'account', label: 'C1 YT', platform: 'youtube', current: 600 });
    expect(byKey(acc.top, 'tiktok:c1tt')).toMatchObject({ label: 'C1 TT', platform: 'tiktok', current: 200 });
    expect(acc.top.find((i) => i.key === 'c1')).toBeUndefined();
  });

  it('language filter', () => {
    const videos = [...topicVideos('ko', 10, 20, 3, { language: 'ko' }), ...topicVideos('en', 10, 20, 3, { language: 'en' })];
    const index = makeIndex({ videos, generatedAt: NOW });
    expect(keys(computeTrending(index, opts({ languages: ['KO'] })).top)).toEqual(['ko']);
  });
});

/* ------------------------------------------------------------------------------------------ */

describe('scale', () => {
  it('20k videos x 40 observations stays fast', () => {
    const videos: Video[] = [];
    for (let i = 0; i < 20_000; i++) {
      const pub = NOW - (1 + (i % 90)) * D;
      const obs: ObservationPoint[] = [];
      for (let k = 0; k < 40; k++) obs.push(makeObs(pub + ((NOW - pub) * (k + 1)) / 41, (i % 500) * (k + 1)));
      videos.push(makeVideo({ id: `youtube:s${i}`, accountId: `youtube:a${i % 301}`, publishedAt: pub, obs, topics: [`t${i % 200}`] }));
    }
    const index = makeIndex({ videos, generatedAt: NOW });
    const t0 = performance.now();
    const r = computeTrending(index, opts());
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(r.top.length).toBeGreaterThan(0);
  });
});
