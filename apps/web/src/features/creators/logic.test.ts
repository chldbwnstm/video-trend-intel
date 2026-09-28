/**
 * Creator Intelligence page logic: hand-made fixtures for the rules (null is not zero, lower bounds,
 * provisional leaders, compare keys) plus the synthetic sample for the analytics bundles.
 */
import { describe, expect, it } from 'vitest';
import { buildIndex, creatorPortfolios, presetRange, summarizeCreators } from '@vti/core';
import type { MetricValue } from '@vti/core';
import { makeAccount, makeIndex, makeObs, makeVideo, ts } from '../../../../../packages/core/test/fixtures.ts';
import { generateSampleDataset } from '../../../scripts/sample-generator.ts';
import {
  brandCounts,
  categoryMix,
  combinedTimeline,
  compareColor,
  compareHref,
  comparePalette,
  compareSeries,
  computeComparison,
  computeCreatorDetail,
  countLeaders,
  creatorHref,
  effectiveCreatorSort,
  findPortfolio,
  followersExtra,
  followersMetric,
  formatInterval,
  heatLevel,
  heatmapSlots,
  metricLeaders,
  normalizeCompareKeys,
  normalizeTimeline,
  partialShare,
  platformTimelineSeries,
  platformsWithoutFollowers,
  portfolioOptions,
  portfolioVideosHref,
  searchPortfolioOptions,
  slotLabel,
  sponsoredVideos,
  statusCounts,
  timelineStatus,
  toggleCompareKey,
  uploadCadence,
  windowBeforeCollection,
} from './logic.ts';

const mv = (value: number | null, status: MetricValue['status'] = 'exact'): MetricValue => ({ value, status, asOf: null, note: null });

describe('compare keys and links', () => {
  it('normalizes keys: trims, de-duplicates, drops empties, caps at 4', () => {
    expect(normalizeCompareKeys([' a ', 'b', 'a', '', 'c', 'd', 'e'])).toEqual(['a', 'b', 'c', 'd']);
  });

  it('toggles a key without exceeding the maximum', () => {
    expect(toggleCompareKey(['a', 'b'], 'c')).toEqual(['a', 'b', 'c']);
    expect(toggleCompareKey(['a', 'b'], 'a')).toEqual(['b']);
    expect(toggleCompareKey(['a', 'b', 'c', 'd'], 'e')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('builds readable detail and compare links', () => {
    expect(creatorHref('youtube:UC-abc_1')).toBe('/creators/youtube:UC-abc_1');
    expect(creatorHref('peertube:user@host.tld', { range: 'rolling7d' })).toBe('/creators/peertube:user@host.tld?range=rolling7d');
    expect(creatorHref('a/b c')).toBe('/creators/a%2Fb%20c');
    expect(compareHref(['a', 'b'], { range: 'rolling30d' })).toBe('/compare?keys=a,b&range=rolling30d');
  });

  it('links a portfolio to its videos in the video search (creator id or account ids)', () => {
    const creator = portfolioVideosHref({ key: 'channel-a', kind: 'creator', accountIds: ['youtube:UC1', 'dailymotion:x1'] }, { cats: ['entertainment'], range: 'rolling7d' });
    const u = new URL(creator, 'http://x');
    expect(u.pathname).toBe('/videos');
    expect(u.searchParams.get('creators')).toBe('channel-a');
    expect(u.searchParams.get('accounts')).toBeNull();
    expect(u.searchParams.get('cats')).toBe('entertainment');
    expect(u.searchParams.get('range')).toBe('rolling7d');
    const account = new URL(portfolioVideosHref({ key: 'youtube:UC9', kind: 'account', accountIds: ['youtube:UC9'] }, { v: 'youtube:abc' }), 'http://x');
    expect(account.searchParams.get('accounts')).toBe('youtube:UC9');
    expect(account.searchParams.get('creators')).toBeNull();
    expect(account.searchParams.get('v')).toBe('youtube:abc');
  });
});

describe('compare colors', () => {
  // Series slot each platform badge uses (index.css --platform-<p>).
  const platformSeries = { youtube: 1, dailymotion: 2, peertube: 3, niconico: 4 } as const;

  it('never reuses the colors of the platforms shown on the page', () => {
    const palette = comparePalette(['youtube', 'dailymotion', 'peertube', 'niconico']);
    expect(palette).toHaveLength(4);
    expect(new Set(palette).size).toBe(4);
    for (const n of Object.values(platformSeries)) expect(palette).not.toContain(`var(--series-${n})`);
    expect(compareColor(0, palette)).toBe(palette[0]);
    expect(compareColor(5, palette)).toBe(palette[1]);
  });

  it('skips a platform color when that platform is present, reuses colors only when all are taken', () => {
    expect(comparePalette(['x'])).not.toContain('var(--series-7)');
    const all = comparePalette(['youtube', 'dailymotion', 'peertube', 'niconico', 'tiktok', 'instagram', 'x', 'twitch']);
    expect(all).toHaveLength(4);
    expect(new Set(all).size).toBe(4);
  });
});

describe('followersMetric', () => {
  const now = ts('2026-09-28');
  const withF = makeAccount({ id: 'dailymotion:x1', followers: [{ t: ts('2026-09-27'), value: 100, src: 'dm@1' }, { t: ts('2026-09-29'), value: 999, src: 'dm@1' }] });
  const withF2 = makeAccount({ id: 'dailymotion:x2', followers: [{ t: ts('2026-09-26'), value: 50, src: 'dm@1' }] });
  const without = makeAccount({ id: 'youtube:y1' });

  it('is unavailable (not 0) when no account provides followers', () => {
    const m = followersMetric([without], now);
    expect(m).toMatchObject({ value: null, status: 'unavailable', note: 'counter_not_provided', providedBy: 0 });
    expect(followersExtra(m, ['youtube'])).toContain('원천 미제공');
  });

  it('sums the latest point at or before now and is exact when every account provides one', () => {
    const m = followersMetric([withF, withF2], now);
    expect(m).toMatchObject({ value: 150, status: 'exact', asOf: ts('2026-09-27'), providedBy: 2, accounts: 2 });
  });

  it('is a lower bound when only some accounts provide followers', () => {
    const m = followersMetric([withF, without], now);
    expect(m).toMatchObject({ value: 100, status: 'lower_bound', note: 'partial_accounts', providedBy: 1, accounts: 2 });
    expect(followersExtra(m, ['youtube'])).toContain('1개만');
  });

  it('lists platforms whose accounts never carry followers', () => {
    expect(platformsWithoutFollowers([withF, without], ['youtube', 'dailymotion'])).toEqual(['youtube']);
  });
});

describe('leaders', () => {
  it('marks the highest value; firm when every other value is a measurement', () => {
    expect(metricLeaders([mv(10), mv(30, 'interpolated'), mv(20, 'source_reported')])).toEqual({ indices: [1], firm: true });
  });

  it('is provisional when another value is a lower bound or unknown', () => {
    expect(metricLeaders([mv(10, 'lower_bound'), mv(30)])).toEqual({ indices: [1], firm: false });
    expect(metricLeaders([mv(null, 'unavailable'), mv(30)])).toEqual({ indices: [1], firm: false });
  });

  it('a lower-bound leader above measured values is still firm', () => {
    expect(metricLeaders([mv(50, 'lower_bound'), mv(30)])).toEqual({ indices: [0], firm: true });
  });

  it('never ranks decreases, needs two entities and at least one value', () => {
    expect(metricLeaders([mv(99, 'decrease_flagged'), mv(1)])).toEqual({ indices: [1], firm: false });
    expect(metricLeaders([mv(5)])).toEqual({ indices: [], firm: false });
    expect(metricLeaders([mv(null, 'unavailable'), null])).toEqual({ indices: [], firm: false });
  });

  it('shares the lead on ties', () => {
    expect(countLeaders([3, 1, 3])).toEqual({ indices: [0, 2], firm: true });
  });

  it('marks nobody when every comparable value is the same (a tie of all is not a lead)', () => {
    // e.g. 참여율 0% for all four compared creators, or the same count everywhere
    expect(metricLeaders([mv(0), mv(0), mv(0), mv(0)])).toEqual({ indices: [], firm: false });
    expect(countLeaders([2, 2, 2])).toEqual({ indices: [], firm: false });
    expect(metricLeaders([mv(5), mv(5, 'lower_bound')])).toEqual({ indices: [], firm: false });
    // two known values tie, the third is unknown: still nobody ahead
    expect(metricLeaders([mv(5), mv(5), mv(null, 'unavailable')])).toEqual({ indices: [], firm: false });
  });

  it('marks nobody when the best value is 0 or less', () => {
    expect(metricLeaders([mv(0), mv(null, 'unavailable')])).toEqual({ indices: [], firm: false });
    expect(countLeaders([0, 0, null])).toEqual({ indices: [], firm: false });
    expect(metricLeaders([mv(-3), mv(-1)])).toEqual({ indices: [], firm: false });
    expect(metricLeaders([mv(0, 'lower_bound'), mv(0)])).toEqual({ indices: [], firm: false });
  });
});

describe('windows before the first observation', () => {
  const first = ts('2026-09-27T22:08');
  const now = ts('2026-09-28T15:26');

  it('detects a window that ends at or before the first observation', () => {
    expect(windowBeforeCollection({ endMs: ts('2026-08-31T15:00') }, first, now)).toBe(true);
    expect(windowBeforeCollection({ endMs: first }, first, now)).toBe(true);
    expect(windowBeforeCollection({ endMs: first + 1 }, first, now)).toBe(false);
    expect(windowBeforeCollection({ endMs: now + 3_600_000 }, first, now)).toBe(false);
    // no observation at all: nothing can be measured
    expect(windowBeforeCollection({ endMs: now }, null, now)).toBe(true);
  });

  it('falls back to uploads for observation-based sorts only', () => {
    expect(effectiveCreatorSort('views_period', true)).toBe('uploads');
    expect(effectiveCreatorSort('followers_growth', true)).toBe('uploads');
    expect(effectiveCreatorSort('engagement', true)).toBe('uploads');
    expect(effectiveCreatorSort('followers', true)).toBe('followers');
    expect(effectiveCreatorSort('median_v7', true)).toBe('median_v7');
    expect(effectiveCreatorSort('views_period', false)).toBe('views_period');
  });
});

describe('status helpers', () => {
  it('counts statuses and the partial share', () => {
    const c = statusCounts([mv(1), mv(1, 'lower_bound'), mv(null, 'unavailable'), mv(2, 'source_reported')]);
    expect(c).toMatchObject({ exact: 1, lower_bound: 1, unavailable: 1, source_reported: 1 });
    expect(partialShare(c)).toBe(0.5);
  });
});

describe('timelines', () => {
  const rows = [
    { date: '2026-09-26', byPlatform: { youtube: mv(null, 'unavailable'), dailymotion: mv(5) } },
    { date: '2026-09-27', byPlatform: { youtube: mv(10, 'lower_bound'), dailymotion: mv(5) } },
    { date: '2026-09-28', byPlatform: { youtube: { value: null, status: 'unavailable' as const, asOf: null, note: 'window_not_started' } } },
  ];

  it('builds one series per platform with null (not 0) for unavailable days', () => {
    const s = platformTimelineSeries(rows);
    expect(s.map((x) => x.id)).toEqual(['youtube', 'dailymotion']);
    expect(s[0].points.map((p) => p.value)).toEqual([null, 10, null]);
    expect(s[1].points.map((p) => p.value)).toEqual([5, 5, null]);
  });

  it('combines platforms with sumIncrements semantics', () => {
    const c = combinedTimeline(rows, null);
    expect(c[0].metric).toMatchObject({ value: 5, status: 'lower_bound' });
    expect(c[1].metric).toMatchObject({ value: 15, status: 'lower_bound' });
    expect(c[2].metric).toMatchObject({ value: null, status: 'unavailable' });
    expect(combinedTimeline(rows, ['dailymotion'])[0].metric).toMatchObject({ value: 5, status: 'exact' });
  });
});

describe('videos of a portfolio', () => {
  const now = ts('2026-09-28T12:00');
  const vids = [
    makeVideo({ id: 'youtube:a', accountId: 'youtube:acc', publishedAt: ts('2026-09-27T10:00'), categories: [{ id: 'food/cooking', confidence: 1, evidence: [], by: 'rule', version: 't' }] }),
    makeVideo({ id: 'youtube:b', accountId: 'youtube:acc', publishedAt: ts('2026-09-25T10:00'), categories: [{ id: 'food', confidence: 1, evidence: [], by: 'rule', version: 't' }, { id: 'travel', confidence: 1, evidence: [], by: 'rule', version: 't' }] }),
    makeVideo({ id: 'youtube:c', accountId: 'youtube:acc', publishedAt: ts('2026-09-01T10:00'), sponsorship: { level: 'likely', brands: ['Acme'], evidence: [], version: 't' } }),
    makeVideo({ id: 'youtube:d', accountId: 'youtube:acc', publishedAt: ts('2026-09-20T10:00'), sponsorship: { level: 'disclosed', brands: ['Acme', 'Beta'], evidence: [], version: 't' } }),
  ];

  it('mixes top-level categories and counts uncategorized videos', () => {
    const m = categoryMix(vids);
    expect(m.rows).toEqual([
      { id: 'food', count: 2 },
      { id: 'travel', count: 1 },
    ]);
    expect(m.uncategorized).toBe(2);
  });

  it('orders sponsored videos disclosed first and counts brands', () => {
    expect(sponsoredVideos(vids).map((v) => v.id)).toEqual(['youtube:d', 'youtube:c']);
    expect(brandCounts(sponsoredVideos(vids))).toEqual([
      { brand: 'Acme', count: 2 },
      { brand: 'Beta', count: 1 },
    ]);
  });

  it('computes weekly cadence with null before the earliest tracked upload', () => {
    const c = uploadCadence(vids, now, 'UTC', 6);
    // 2026-09-28 is a Monday: weeks start 08-24, 08-31, 09-07, 09-14, 09-21, 09-28.
    expect(c.weeks.map((w) => w.start)).toEqual(['2026-08-24', '2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28']);
    expect(c.weeks.map((w) => w.count)).toEqual([null, 1, 0, 1, 2, 0]);
    expect(c.weeks[5].current).toBe(true);
    expect(c.uploads7d).toBe(2);
    expect(c.uploads30d).toBe(4);
    expect(c.perPlatform[0].platform).toBe('youtube');
    // gaps 456h, 120h, 48h -> median 120h
    expect(c.perPlatform[0].medianIntervalHours).toBe(120);
    expect(formatInterval(30)).toBe('30시간');
    expect(formatInterval(72)).toBe('3일');
    expect(formatInterval(null)).toBe('—');
  });
});

describe('heatmap helpers', () => {
  it('lists busy slots and quantizes levels', () => {
    const counts = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
    const medianV7 = Array.from({ length: 7 }, () => new Array<number | null>(24).fill(null));
    counts[2][18] = 3;
    counts[0][9] = 1;
    medianV7[2][18] = 1200;
    const slots = heatmapSlots({ counts, medianV7 });
    expect(slots).toEqual([
      { weekday: 2, hour: 18, count: 3, medianV7: 1200 },
      { weekday: 0, hour: 9, count: 1, medianV7: null },
    ]);
    expect(slotLabel(slots[0])).toBe('수 18시');
    expect(heatLevel(0, 3)).toBe(0);
    expect(heatLevel(null, 3)).toBe(0);
    expect(heatLevel(1, 3)).toBe(2);
    expect(heatLevel(3, 3)).toBe(4);
  });
});

describe('analytics bundles (fixtures)', () => {
  const now = ts('2026-09-28T12:00');
  const yt = makeAccount({ id: 'youtube:ch', name: 'Chef', creatorId: 'chef' });
  const dm = makeAccount({ id: 'dailymotion:ch', name: 'Chef DM', creatorId: 'chef', followers: [{ t: ts('2026-09-28T06:00'), value: 500, src: 'dm@1' }] });
  const solo = makeAccount({ id: 'youtube:solo', name: 'Solo' });
  const videos = [
    makeVideo({ id: 'youtube:1', accountId: yt.id, publishedAt: ts('2026-09-20'), obs: [makeObs('2026-09-21', 100, 5), makeObs('2026-09-28T06:00', 400, 10)] }),
    makeVideo({ id: 'dailymotion:1', accountId: dm.id, publishedAt: ts('2026-09-22'), obs: [makeObs('2026-09-28T06:00', 50, 1)] }),
    makeVideo({ id: 'youtube:2', accountId: solo.id, publishedAt: ts('2026-09-26'), obs: [makeObs('2026-09-26T01:00', 10, 1), makeObs('2026-09-28T06:00', 70, 3)] }),
  ];
  const index = makeIndex({
    generatedAt: now,
    videos,
    accounts: [yt, dm, solo],
    creators: [{ id: 'chef', name: 'Chef', accountIds: [yt.id, dm.id], linkStatus: 'suggested', note: null }],
  });
  const range = presetRange('rolling7d', 'UTC', now);

  it('finds portfolios and returns null for unknown keys', () => {
    expect(findPortfolio(index, 'chef', now)?.accountIds).toEqual(['dailymotion:ch', 'youtube:ch']);
    expect(findPortfolio(index, 'youtube:abc', now)).toBeNull();
    expect(computeCreatorDetail(index, { key: 'nope', range, rollingHours: 168, tz: 'UTC', now })).toBeNull();
  });

  it('computes the detail bundle with per-platform breakdowns and follower provenance', () => {
    const d = computeCreatorDetail(index, { key: 'chef', range, rollingHours: 168, tz: 'UTC', now })!;
    expect(d.linkStatus).toBe('suggested');
    expect(d.summary.platforms).toEqual(['youtube', 'dailymotion']);
    expect(d.perPlatform.map((p) => p.platform)).toEqual(['youtube', 'dailymotion']);
    expect(d.followers).toMatchObject({ value: 500, status: 'lower_bound', providedBy: 1, accounts: 2 });
    expect(d.perPlatform[1].followers).toMatchObject({ value: 500, status: 'exact' });
    expect(d.perPlatform[0].followers.status).toBe('unavailable');
    expect(d.videosByAccount).toEqual({ 'youtube:ch': 1, 'dailymotion:ch': 1 });
    expect(d.followerSeries.map((s) => s.account.id)).toEqual(['dailymotion:ch']);
    expect(d.missingFollowerPlatforms).toEqual(['youtube']);
  });

  it('compares keys, keeps unknown keys as not found and restricts to platforms', () => {
    const c = computeComparison(index, { keys: ['chef', 'youtube:solo', 'ghost'], range, rollingHours: 168, tz: 'UTC', now, platforms: [] });
    expect(c.entries.map((e) => [e.key, e.found])).toEqual([
      ['chef', true],
      ['youtube:solo', true],
      ['ghost', false],
    ]);
    expect(c.platforms).toEqual(['youtube', 'dailymotion']);
    expect(c.entries[0].daily.length).toBeGreaterThan(0);
    // Legend labels carry the slot number (non-color cue shared with the chips and table headers).
    expect(compareSeries(c.entries).map((s) => s.label)).toEqual(['1. Chef', '2. Solo']);
    const palette = comparePalette(['youtube', 'dailymotion']);
    expect(compareSeries(c.entries, palette).map((s) => s.color)).toEqual([palette[0], palette[1]]);
    const onlyYt = computeComparison(index, { keys: ['chef'], range, rollingHours: 168, tz: 'UTC', now, platforms: ['youtube'] });
    expect(onlyYt.entries[0].summary!.platforms).toEqual(['youtube']);
    expect(onlyYt.entries[0].followers?.status).toBe('unavailable');
  });

  it('lists picker options with linked creators first and searches them', () => {
    const opts = portfolioOptions(index, now);
    expect(opts[0]).toMatchObject({ key: 'chef', kind: 'creator', platforms: ['youtube', 'dailymotion'], videos: 2, linkStatus: 'suggested' });
    expect(searchPortfolioOptions(opts, 'solo').map((o) => o.key)).toEqual(['youtube:solo']);
    expect(searchPortfolioOptions(opts, '', 1)).toHaveLength(1);
  });
});

describe('analytics bundles (sample dataset)', () => {
  const dataset = generateSampleDataset({ videos: 400 });
  const index = buildIndex(dataset);
  const now = dataset.generatedAt;
  const tz = 'Asia/Seoul';
  const range = presetRange('rolling30d', tz, now);

  it('computes a detail bundle for every linked creator of the sample', () => {
    for (const c of dataset.creators) {
      const d = computeCreatorDetail(index, { key: c.id, range, rollingHours: 720, tz, now });
      expect(d, c.id).not.toBeNull();
      expect(d!.summary.key).toBe(c.id);
      expect(d!.cadence.weeks).toHaveLength(12);
      expect(d!.categoryMix.videos).toBe(d!.summary.videoCount);
    }
  });

  it('compares the first four sample creators', () => {
    const keys = dataset.creators.slice(0, 4).map((c) => c.id);
    const c = computeComparison(index, { keys, range, rollingHours: 720, tz, now, platforms: [] });
    expect(c.entries.every((e) => e.found)).toBe(true);
    expect(c.entries.every((e) => e.daily.length === c.entries[0].daily.length)).toBe(true);
    const leaders = metricLeaders(c.entries.map((e) => e.summary!.viewsInWindow));
    expect(leaders.indices.length).toBeGreaterThan(0);
  });

  it('every portfolio key round-trips through summarizeCreators', () => {
    const s = summarizeCreators(index, { range, rollingHours: 720, tz, now });
    const keys = new Set(creatorPortfolios(index).keys());
    for (const x of s) expect(keys.has(x.key)).toBe(true);
  });
});

describe('normalizeTimeline', () => {
  it('turns days without tracked videos into no data and marks today as a lower bound', () => {
    const now = ts('2026-09-28T03:00'); // 2026-09-28 12:00 KST
    const rows = [
      { date: '2026-09-27', byPlatform: { youtube: { value: 0, status: 'exact' as const, asOf: null, note: 'no_tracked_videos' }, dailymotion: mv(3) } },
      { date: '2026-09-28', byPlatform: { youtube: mv(10), dailymotion: mv(null, 'unavailable') } },
    ];
    const n = normalizeTimeline(rows, now, 'Asia/Seoul');
    expect(n[0].byPlatform.youtube).toMatchObject({ value: null, status: 'unavailable', note: 'no_tracked_videos' });
    expect(n[0].byPlatform.dailymotion).toMatchObject({ value: 3, status: 'exact' });
    expect(n[1].byPlatform.youtube).toMatchObject({ value: 10, status: 'lower_bound', note: 'window_incomplete' });
    expect(n[1].byPlatform.dailymotion?.status).toBe('unavailable');
    const c = combinedTimeline(n, null);
    expect(c[0].metric).toMatchObject({ value: 3, status: 'exact' });
    expect(c[1].metric).toMatchObject({ value: 10, status: 'lower_bound' });
    expect(combinedTimeline(n, ['youtube'])[0].metric).toMatchObject({ value: null, status: 'unavailable', note: 'no_tracked_videos' });
    expect(timelineStatus(n)).toMatchObject({ exact: 1, lower_bound: 1, unavailable: 1 });
  });
});
