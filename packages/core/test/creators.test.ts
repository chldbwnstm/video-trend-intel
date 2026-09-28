import { describe, expect, it } from 'vitest';
import { accountFollowerGrowth, creatorPortfolios, creatorTimeline, postingHeatmap, summarizeCreators } from '../src/creators.ts';
import type { CreatorOptions } from '../src/creators.ts';
import { localDateStartUtc, resolveWindow } from '../src/time.ts';
import type { CreatorSummary, FollowerPoint, Video } from '../src/types.ts';
import { DAY_MS, HOUR_MS, makeAccount, makeIndex, makeObs, makeVideo, obsOf, ts } from './fixtures.ts';

const H = HOUR_MS;
const D = DAY_MS;
const SEOUL = 'Asia/Seoul';
const RANGE = { start: '2026-09-21', end: '2026-09-27' };
const w = resolveWindow(RANGE, SEOUL, ts('2026-10-01'));
const NOW = w.endMs + H;

const cat = (id: string) => ({ id, confidence: 0.9, evidence: [], by: 'rule' as const, version: 'test' });
const fp = (t: number, value: number): FollowerPoint => ({ t, value, src: 'test@1' });
const opts = (o: Partial<CreatorOptions> = {}): CreatorOptions => ({ range: RANGE, tz: SEOUL, now: NOW, ...o });

/* --- fixture: a creator with YouTube + TikTok accounts, and several unlinked accounts ------------- */

const v1 = makeVideo({
  id: 'youtube:v1',
  accountId: 'youtube:c1yt',
  publishedAt: ts('2026-08-01'),
  categories: [cat('beauty'), cat('beauty/skincare')],
  obs: [makeObs('2026-08-01T12:00Z', 50), makeObs('2026-08-08', 500), makeObs(w.startMs, 1_000, 10), makeObs(w.endMs, 1_600, 60)],
});
const v2 = makeVideo({
  id: 'youtube:v2',
  accountId: 'youtube:c1yt',
  publishedAt: w.startMs + D,
  categories: [cat('beauty'), cat('beauty/makeup')],
  obs: [makeObs(w.startMs + D + H, 10, 1), makeObs(w.endMs, 400, 40)],
});
const v3 = makeVideo({
  id: 'tiktok:v3',
  accountId: 'tiktok:c1tt',
  publishedAt: ts('2026-08-05'),
  categories: [cat('food')],
  sponsorship: { level: 'disclosed', brands: ['브랜드'], evidence: [], version: 't' },
  obs: [makeObs('2026-08-05T12:00Z', 100), makeObs('2026-08-12', 2_000), obsOf(w.startMs, { views: 5_000, likes: 20, shares: 2 }), obsOf(w.endMs, { views: 5_300, likes: 30, shares: 3 })],
});
// unlinked account: one lower-bound contributor and one decreasing (deleted) video
const s1 = makeVideo({ id: 'youtube:s1', accountId: 'youtube:solo', publishedAt: ts('2026-01-01'), obs: [makeObs(w.startMs + 2 * D, 10_000), makeObs(w.endMs, 12_000)] });
const s2 = makeVideo({ id: 'youtube:s2', accountId: 'youtube:solo', publishedAt: ts('2026-08-01'), status: 'deleted', obs: [makeObs(w.startMs, 5_000), makeObs(w.endMs, 1_000)] });
// a platform that does not provide views
const x1 = makeVideo({ id: 'x:x1', accountId: 'x:xacc', publishedAt: ts('2026-08-01'), obs: [obsOf(w.startMs, { likes: 5 }), obsOf(w.endMs, { likes: 9 })] });

const accounts = [
  makeAccount({ id: 'youtube:c1yt', name: 'C1 유튜브', handle: '@c1', creatorId: 'c1', followers: [fp(w.startMs, 1_000), fp(w.endMs, 1_500)] }),
  makeAccount({ id: 'tiktok:c1tt', name: 'C1 틱톡', creatorId: 'c1', followers: [fp(w.startMs - 10 * H, 2_000), fp(w.startMs + 10 * H, 2_100), fp(w.endMs, 2_600)] }),
  makeAccount({ id: 'youtube:solo', name: '솔로 채널' }),
  makeAccount({ id: 'x:xacc', name: 'X 계정', followers: [fp(w.startMs + 3 * D, 700)] }),
  makeAccount({ id: 'youtube:c2a', name: 'C2 A', creatorId: 'c2', followers: [fp(w.startMs, 100), fp(w.endMs, 200)] }),
  makeAccount({ id: 'dailymotion:c2b', name: 'C2 B', creatorId: 'c2', followers: [fp(w.startMs + 3 * D, 50)] }),
  makeAccount({ id: 'youtube:shrink', name: '줄어드는 채널', seedCategory: 'gaming', followers: [fp(w.startMs, 1_000), fp(w.endMs, 900)] }),
];
const creators = [
  { id: 'c1', name: '크리에이터 원', accountIds: ['youtube:c1yt', 'tiktok:c1tt'], linkStatus: 'verified' as const, note: null },
  { id: 'c2', name: '크리에이터 투', accountIds: ['youtube:c2a', 'dailymotion:c2b'], linkStatus: 'suggested' as const, note: null },
];
const index = makeIndex({ videos: [v1, v2, v3, s1, s2, x1], accounts, creators, generatedAt: NOW });
const by = (list: CreatorSummary[], key: string) => list.find((s) => s.key === key)!;

describe('summarizeCreators: merged portfolios', () => {
  const all = summarizeCreators(index, opts());

  it('one summary per creator (accounts merged across platforms) or per unlinked account', () => {
    expect(all.map((s) => s.key).sort()).toEqual(['c1', 'c2', 'x:xacc', 'youtube:shrink', 'youtube:solo']);
    const c1 = by(all, 'c1');
    expect(c1.kind).toBe('creator');
    expect(c1.name).toBe('크리에이터 원');
    expect(c1.accounts.map((a) => a.id)).toEqual(['youtube:c1yt', 'tiktok:c1tt']);
    expect(c1.platforms).toEqual(['youtube', 'tiktok']);
    expect(by(all, 'youtube:solo')).toMatchObject({ kind: 'account', name: '솔로 채널', platforms: ['youtube'] });
  });

  it('views in window: sum of honest increments across platforms', () => {
    const c1 = by(all, 'c1');
    expect(c1.viewsInWindow).toEqual({ value: 600 + 400 + 300, status: 'exact', asOf: w.endMs, note: null });
    expect(c1.videoCount).toBe(3);
    expect(c1.uploadsInWindow).toBe(1);
    // a lower-bound contributor makes the total a lower bound; the decrease is excluded, never negative
    expect(by(all, 'youtube:solo').viewsInWindow).toMatchObject({ value: 2_000, status: 'lower_bound' });
    // a source without view counts: unavailable, not 0
    expect(by(all, 'x:xacc').viewsInWindow).toMatchObject({ value: null, status: 'unavailable', note: 'counter_not_provided' });
    // no tracked videos: 0 of OUR tracked views
    expect(by(all, 'c2').viewsInWindow).toMatchObject({ value: 0, status: 'exact', note: 'no_tracked_videos' });
    expect(by(all, 'c2').videoCount).toBe(0);
  });

  it('followers (latest, summed) and follower growth over the window', () => {
    const c1 = by(all, 'c1');
    expect(c1.followers).toBe(1_500 + 2_600);
    // YouTube exact +500, TikTok start interpolated (2,050) -> +550
    expect(c1.followersGrowth).toMatchObject({ value: 1_050, status: 'interpolated', asOf: w.endMs });
    expect(by(all, 'youtube:solo').followers).toBeNull();
    expect(by(all, 'youtube:solo').followersGrowth).toMatchObject({ value: null, status: 'unavailable', note: 'counter_not_provided' });
    // a real decline is a valid (negative) exact value
    expect(by(all, 'youtube:shrink').followersGrowth).toEqual({ value: -100, status: 'exact', asOf: w.endMs, note: null });
    // one account of the portfolio cannot be measured -> the merged growth is unknown (followers can go down)
    expect(by(all, 'c2').followers).toBe(250);
    expect(by(all, 'c2').followersGrowth.status).toBe('unavailable');
    expect(by(all, 'x:xacc').followersGrowth.status).toBe('unavailable');
  });

  it('engagement (median of videos, available components only), median V7, categories, sponsorships', () => {
    const c1 = by(all, 'c1');
    expect(c1.engagementRate).toMatchObject({ value: 60 / 1_600, status: 'exact', note: 'median_of_videos' });
    expect(c1.medianV7).toMatchObject({ value: 1_250, status: 'exact' });
    expect(c1.topCategories).toEqual(['beauty', 'food']);
    expect(c1.sponsoredCount).toBe(1);
    expect(by(all, 'youtube:solo').engagementRate).toMatchObject({ status: 'unavailable', note: 'counter_not_provided' });
    expect(by(all, 'youtube:shrink').topCategories).toEqual(['gaming']); // falls back to the seed category
    expect(by(all, 'c2').medianV7).toMatchObject({ status: 'unavailable', note: 'no_tracked_videos' });
  });

  it('engagement sort ranks only medians over enough videos and views; niconico comments are left out', () => {
    const big = [0, 1, 2].map((i) =>
      makeVideo({ id: `youtube:big${i}`, accountId: 'youtube:big', publishedAt: ts('2026-08-01'), obs: [obsOf(w.endMs - H, { views: 10_000, likes: 300 })] }),
    );
    const tiny = makeVideo({ id: 'dailymotion:tiny', accountId: 'dailymotion:tiny', publishedAt: ts('2026-08-01'), obs: [obsOf(w.endMs - H, { views: 6, likes: 4 })] });
    const nico = [0, 1, 2].map((i) =>
      makeVideo({ id: `niconico:sm${i}`, accountId: 'niconico:user/1', platform: 'niconico', publishedAt: ts('2026-08-01'), obs: [obsOf(w.endMs - H, { views: 2_458, likes: 132, comments: 7_103 })] }),
    );
    const idx = makeIndex({ videos: [...big, tiny, ...nico], generatedAt: NOW });
    const list = summarizeCreators(idx, opts({ sort: 'engagement' }));
    expect(list.map((s) => s.key)).toEqual(['niconico:user/1', 'youtube:big', 'dailymotion:tiny']);
    // niconico: likes / views only (comments are on-video timeline comments), not 294%
    expect(by(list, 'niconico:user/1').engagementRate.value).toBeCloseTo(132 / 2_458, 9);
    // 1 video with 6 views: shown, but last and marked
    expect(by(list, 'dailymotion:tiny').engagementRate).toMatchObject({ status: 'exact', note: 'small_sample' });
    expect(by(list, 'dailymotion:tiny').engagementRate.value).toBeCloseTo(4 / 6, 9);
    expect(by(list, 'youtube:big').engagementRate).toMatchObject({ value: 0.03, note: 'median_of_videos' });
  });

  it('sorts (default views_period) with unrankable values last and a stable tie-break', () => {
    expect(all.map((s) => s.key)).toEqual(['youtube:solo', 'c1', 'c2', 'youtube:shrink', 'x:xacc']);
    expect(summarizeCreators(index, opts({ sort: 'followers' })).map((s) => s.key)).toEqual(['c1', 'youtube:shrink', 'x:xacc', 'c2', 'youtube:solo']);
    expect(summarizeCreators(index, opts({ sort: 'followers_growth' })).map((s) => s.key)).toEqual(['c1', 'youtube:shrink', 'youtube:solo', 'c2', 'x:xacc']);
    expect(summarizeCreators(index, opts({ sort: 'uploads' }))[0].key).toBe('c1');
    expect(summarizeCreators(index, opts({ sort: 'engagement' }))[0].key).toBe('c1');
    expect(summarizeCreators(index, opts({ sort: 'median_v7' }))[0].key).toBe('c1');
    expect(summarizeCreators(index, opts({ limit: 2 })).map((s) => s.key)).toEqual(['youtube:solo', 'c1']);
  });

  it('filters: platforms restrict accounts and videos; q matches names / handles / ids; categories', () => {
    const tt = summarizeCreators(index, opts({ platforms: ['tiktok'] }));
    expect(tt.map((s) => s.key)).toEqual(['c1']);
    expect(tt[0]).toMatchObject({ platforms: ['tiktok'], followers: 2_600, videoCount: 1, uploadsInWindow: 0 });
    expect(tt[0].accounts.map((a) => a.id)).toEqual(['tiktok:c1tt']);
    expect(tt[0].viewsInWindow).toMatchObject({ value: 300, status: 'exact' });
    expect(summarizeCreators(index, opts({ q: '크리에이터' })).map((s) => s.key).sort()).toEqual(['c1', 'c2']);
    expect(summarizeCreators(index, opts({ q: '틱톡' })).map((s) => s.key)).toEqual(['c1']);
    expect(summarizeCreators(index, opts({ q: '@C1' })).map((s) => s.key)).toEqual(['c1']);
    expect(summarizeCreators(index, opts({ q: '솔로채널' })).map((s) => s.key)).toEqual(['youtube:solo']);
    expect(summarizeCreators(index, opts({ categories: ['food'] })).map((s) => s.key)).toEqual(['c1']);
    expect(summarizeCreators(index, opts({ categories: ['food'], platforms: ['youtube'] }))).toEqual([]);
    expect(summarizeCreators(index, opts({ categories: ['beauty/makeup'] })).map((s) => s.key)).toEqual(['c1']);
    expect(summarizeCreators(index, opts({ categories: ['gaming'] })).map((s) => s.key)).toEqual(['youtube:shrink']);
  });

  it('is deterministic and reads the data as of now', () => {
    expect(summarizeCreators(index, opts())).toEqual(all);
    const later = makeIndex({
      videos: [v1, v2, v3, s1, s2, x1].map((v) => ({ ...v, obs: [...v.obs, makeObs(NOW + 3 * D, 10_000_000)] })),
      accounts: accounts.map((a) => ({ ...a, followers: [...a.followers, fp(NOW + 3 * D, 99_999)] })),
      creators,
      generatedAt: NOW + 4 * D,
    });
    expect(summarizeCreators(later, opts())).toEqual(all);
  });
});

describe('portfolios', () => {
  it('accounts only referenced by videos form (or join) a portfolio', () => {
    const orphan = makeVideo({ id: 'peertube:o1', accountId: 'peertube:ghost', publishedAt: ts('2026-09-01') });
    const idx = makeIndex({ videos: [orphan], accounts: [], creators: [{ id: 'cg', name: 'Ghost', accountIds: ['peertube:ghost'], linkStatus: 'verified', note: null }] });
    const p = creatorPortfolios(idx).get('cg')!;
    expect(p).toMatchObject({ key: 'cg', kind: 'creator', name: 'Ghost', accounts: [], accountIds: ['peertube:ghost'] });
    const idx2 = makeIndex({ videos: [orphan], accounts: [] });
    expect(creatorPortfolios(idx2).get('peertube:ghost')).toMatchObject({ kind: 'account', name: 'peertube:ghost' });
    const s = summarizeCreators(idx2, { range: { start: '2026-09-01', end: '2026-09-07' }, tz: SEOUL, now: ts('2026-09-28') });
    expect(s[0]).toMatchObject({ key: 'peertube:ghost', platforms: ['peertube'], videoCount: 1, uploadsInWindow: 1 });
  });

  it('videos not yet published at now (scheduled premieres) are not counted', () => {
    const live = makeVideo({ id: 'youtube:pl', accountId: 'youtube:pp', publishedAt: w.startMs + D, obs: [makeObs(w.startMs + D + H, 1), makeObs(w.endMs, 11)] });
    const premiere = makeVideo({ id: 'youtube:pp1', accountId: 'youtube:pp', publishedAt: NOW + 2 * D, firstSeenAt: NOW - D, lastObservedAt: NOW - D });
    const idx = makeIndex({ videos: [live, premiere], generatedAt: NOW });
    const [s] = summarizeCreators(idx, opts());
    expect(s).toMatchObject({ key: 'youtube:pp', videoCount: 1, uploadsInWindow: 1 });
    expect(s.viewsInWindow).toMatchObject({ value: 11, status: 'exact' });
  });

  it('accountFollowerGrowth: a partial window is unknown (followers go down too, so it is no lower bound), missing data is null', () => {
    expect(accountFollowerGrowth(makeAccount({ followers: [] }), w, NOW)).toBeNull();
    const partial = makeAccount({ followers: [fp(w.startMs + D, 100), fp(w.startMs + 3 * D, 160)] });
    expect(accountFollowerGrowth(partial, w, NOW)).toMatchObject({ value: null, status: 'unavailable', note: 'before_first_observation' });
    const partialDown = makeAccount({ followers: [fp(w.startMs + D, 100), fp(w.startMs + 3 * D, 60)] });
    expect(accountFollowerGrowth(partialDown, w, NOW)).toMatchObject({ value: null, status: 'unavailable' });
    // two points 10 minutes apart before now, rolling 24h: not a ranked '>= 100'
    const recent = makeAccount({ id: 'youtube:acc-recent', followers: [fp(NOW - 10 * 60_000, 1_000), fp(NOW, 1_100)] });
    const day = { startMs: NOW - 24 * H, endMs: NOW, tz: SEOUL, incomplete: false };
    expect(accountFollowerGrowth(recent, day, NOW)!.status).toBe('unavailable');
    const notStarted = resolveWindow({ start: '2026-12-01', end: '2026-12-02' }, SEOUL, NOW);
    expect(accountFollowerGrowth(partial, notStarted, NOW)).toMatchObject({ status: 'unavailable', note: 'window_not_started' });
  });
});

/* ------------------------------------------------------------------------------------------ */

describe('creatorTimeline', () => {
  const d0 = localDateStartUtc('2026-09-21', SEOUL);
  const now = d0 + 7 * D + H; // 2026-09-28 01:00 KST
  const daily = (id: string, accountId: string, publishedAt: number, perDay: number, fromDay = 0): Video =>
    makeVideo({
      id,
      accountId,
      publishedAt,
      obs: Array.from({ length: 8 - fromDay }, (_, k) => makeObs(d0 + (k + fromDay) * D, 1_000 + (k + fromDay) * perDay)),
    });
  const yt = daily('youtube:t1', 'youtube:c9yt', ts('2026-08-01'), 100);
  const tt = daily('tiktok:t2', 'tiktok:c9tt', ts('2026-08-01'), 10);
  // published on 09-24 (KST) and observed from its first midnight
  const ytNew = makeVideo({ id: 'youtube:t3', accountId: 'youtube:c9yt', publishedAt: d0 + 3 * D + 2 * H, obs: [makeObs(d0 + 3 * D + 3 * H, 0), makeObs(d0 + 4 * D, 50), makeObs(d0 + 5 * D, 150), makeObs(d0 + 6 * D, 250), makeObs(d0 + 7 * D, 350)] });
  const idx = makeIndex({
    videos: [yt, tt, ytNew],
    accounts: [
      makeAccount({ id: 'youtube:c9yt', creatorId: 'c9' }),
      makeAccount({ id: 'tiktok:c9tt', creatorId: 'c9' }),
      makeAccount({ id: 'peertube:c9pt', creatorId: 'c9' }),
    ],
    creators: [{ id: 'c9', name: 'C9', accountIds: ['youtube:c9yt', 'tiktok:c9tt', 'peertube:c9pt'], linkStatus: 'verified', note: null }],
    generatedAt: now,
  });
  const tl = creatorTimeline(idx, 'c9', { range: { start: '2026-09-21', end: '2026-09-29' }, tz: SEOUL, now });

  it('one entry per local date, one value per platform of the portfolio', () => {
    expect(tl.map((x) => x.date)).toEqual(['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29']);
    expect(Object.keys(tl[0].byPlatform)).toEqual(['youtube', 'peertube', 'tiktok']); // PLATFORMS order
  });

  it('daily increments are summed per platform with honest statuses', () => {
    expect(tl[0].byPlatform.youtube).toMatchObject({ value: 100, status: 'exact' });
    expect(tl[0].byPlatform.tiktok).toMatchObject({ value: 10, status: 'exact' });
    // 09-24: the new video starts at 0 on its publish day (known by definition) and adds 50
    expect(tl[3].byPlatform.youtube).toMatchObject({ value: 150, status: 'exact' });
    expect(tl[4].byPlatform.youtube).toMatchObject({ value: 200, status: 'exact' });
    // today (clipped to now = 01:00): the only observation is the one at 00:00, so nothing is known about the
    // increase since midnight (never a fabricated exact 0 from one observation serving both boundaries);
    // then a day that has not started
    expect(tl[7].byPlatform.youtube).toMatchObject({ value: null, status: 'unavailable' });
    expect(tl[8].byPlatform.youtube).toMatchObject({ value: null, status: 'unavailable', note: 'window_not_started' });
    // a platform without tracked videos is 0 of OUR tracked views, not unknown
    expect(tl[0].byPlatform.peertube).toMatchObject({ value: 0, status: 'exact', note: 'no_tracked_videos' });
    expect(tl[8].byPlatform.peertube).toMatchObject({ status: 'unavailable', note: 'window_not_started' });
  });

  it('works for a single account key; unknown keys give []', () => {
    const acc = creatorTimeline(idx, 'tiktok:c9tt', { range: { start: '2026-09-21', end: '2026-09-22' }, tz: SEOUL, now });
    // the account is linked to c9, so its own key is not a portfolio
    expect(acc).toEqual([]);
    const idx2 = makeIndex({ videos: [tt], generatedAt: now });
    const solo = creatorTimeline(idx2, 'tiktok:c9tt', { range: { start: '2026-09-21', end: '2026-09-22' }, tz: SEOUL, now });
    expect(solo.map((x) => x.byPlatform.tiktok?.value)).toEqual([10, 10]);
    expect(creatorTimeline(idx, 'nobody', { range: { start: '2026-09-21', end: '2026-09-22' }, tz: SEOUL, now })).toEqual([]);
  });
});

/* ------------------------------------------------------------------------------------------ */

describe('postingHeatmap', () => {
  const now = ts('2026-09-28');
  // Mondays 10:00 KST (01:00Z) with V7 = 100 / 200 / 300
  const mon = [ts('2026-09-07T01:00Z'), ts('2026-09-14T01:00Z'), ts('2026-08-31T01:00Z')].map((t, i) =>
    makeVideo({ id: `youtube:m${i}`, accountId: 'youtube:hm', publishedAt: t, obs: [makeObs(t + 7 * D, 100 * (i + 1))] }),
  );
  // Sunday 23:00 KST (= Monday 00:00 in Sydney, AEST), V7 not readable
  const sun = makeVideo({ id: 'youtube:sun', accountId: 'youtube:other', publishedAt: ts('2026-09-20T14:00Z'), obs: [makeObs('2026-09-27T20:00Z', 5)] });
  const future = makeVideo({ id: 'youtube:future', accountId: 'youtube:hm', publishedAt: ts('2026-09-30T01:00Z') });
  const idx = makeIndex({ videos: [...mon, sun, future], generatedAt: ts('2026-10-01') });

  it('counts uploads per local weekday/hour and the median V7 per cell', () => {
    const h = postingHeatmap(idx, null, SEOUL, now);
    expect(h.counts).toHaveLength(7);
    expect(h.counts.every((r) => r.length === 24)).toBe(true);
    expect(h.counts[0][10]).toBe(3);
    expect(h.medianV7[0][10]).toBe(200);
    expect(h.counts[6][23]).toBe(1);
    expect(h.medianV7[6][23]).toBeNull();
    expect(h.counts.flat().reduce((a, b) => a + b, 0)).toBe(4); // the not-yet-published video is excluded
    expect(h.medianV7[3][3]).toBeNull();
  });

  it('respects the display time zone (Australia/Sydney) and the key', () => {
    const syd = postingHeatmap(idx, null, 'Australia/Sydney', now);
    expect(syd.counts[0][11]).toBe(3);
    expect(syd.counts[0][0]).toBe(1);
    const one = postingHeatmap(idx, 'youtube:hm', SEOUL, now);
    expect(one.counts.flat().reduce((a, b) => a + b, 0)).toBe(3);
    expect(postingHeatmap(idx, 'nobody', SEOUL, now).counts.flat().every((c) => c === 0)).toBe(true);
  });
});
