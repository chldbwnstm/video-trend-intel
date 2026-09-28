/**
 * 비디오 레이팅: cohort logic (vs core queryVideos), log-scale bins, default platform, and server-rendered
 * page states (sample data, a selected video, mixed platforms, single-observation "early" data).
 */
import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { buildIndex, queryVideos, rankValue } from '@vti/core';
import type { Dataset } from '@vti/core';
import { makeIndex, makeObs, makeVideo, ts } from '../../../../../packages/core/test/fixtures.ts';
import { DatasetContext } from '../../data/context.ts';
import type { DatasetContextValue } from '../../data/context.ts';
import { generateSampleDataset } from '../../../scripts/sample-generator.ts';
import RatingsPage from '../../pages/Ratings.tsx';
import { ageGapHours, binIndexOf, defaultRatingsPlatform, logBins, ratingsCohort } from './logic.ts';
import type { PlatformCohort } from './logic.ts';

const TZ = 'Asia/Seoul';
const DAY = 86_400_000;
const sample = generateSampleDataset({ videos: 400 });
const sampleIndex = buildIndex(sample);

function ctx(ds: Dataset): DatasetContextValue {
  return {
    dataset: ds,
    index: buildIndex(ds),
    now: ds.generatedAt,
    isSample: true,
    tz: TZ,
    setTz: () => undefined,
    source: { url: './data/sample.json', bytes: 0, fallbackReason: null, loadedAt: 0 },
    reload: () => undefined,
  };
}

function render(ds: Dataset, url: string): string {
  return renderToStaticMarkup(
    h(DatasetContext.Provider, { value: ctx(ds) }, h(MemoryRouter, { initialEntries: [url] }, h(Routes, null, h(Route, { path: '/ratings', element: h(RatingsPage) })))),
  );
}

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('logBins', () => {
  it('uses 1-2-5 edges, a separate zero bin, and counts every value once', () => {
    const values = [0, 0, 1, 3, 9, 10, 19, 20, 49, 50, 99, 1234, 99999];
    const bins = logBins(values);
    expect(bins[0]).toMatchObject({ lo: 0, hi: 0, count: 2, label: '0' });
    expect(bins.slice(1).map((b) => b.lo)).toEqual([1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000]);
    expect(bins.reduce((a, b) => a + b.count, 0)).toBe(values.length);
    expect(bins[bins.length - 1].hi).toBe(100000);
    expect(binIndexOf(bins, 0)).toBe(0);
    expect(bins[binIndexOf(bins, 19)].lo).toBe(10);
    expect(bins[binIndexOf(bins, 20)].lo).toBe(20);
    expect(bins[binIndexOf(bins, 99999)].lo).toBe(50000);
    expect(binIndexOf(bins, null)).toBe(-1);
    expect(binIndexOf(bins, 1e9)).toBe(-1);
  });

  it('handles exact powers of ten, a single value and empty input', () => {
    expect(logBins([1000]).map((b) => [b.lo, b.hi, b.count])).toEqual([[1000, 2000, 1]]);
    expect(logBins([100, 1000])[0].lo).toBe(100);
    expect(logBins([])).toEqual([]);
    expect(logBins([0])).toEqual([{ lo: 0, hi: 0, count: 1, label: '0' }]);
  });
});

describe('ratingsCohort', () => {
  const NOW = ts('2026-09-28T00:00:00Z');
  const pub = (daysAgo: number) => NOW - daysAgo * DAY;
  const index = makeIndex({
    generatedAt: NOW,
    videos: [
      // observed exactly at publish + 7d
      makeVideo({ id: 'youtube:a', publishedAt: pub(10), obs: [makeObs(pub(10) + 7 * DAY, 700), makeObs(NOW, 900)] }),
      makeVideo({ id: 'youtube:b', publishedAt: pub(9), obs: [makeObs(pub(9) + 7 * DAY, 300), makeObs(NOW, 400)] }),
      // reached but never observed near day 7 -> unavailable
      makeVideo({ id: 'youtube:c', publishedAt: pub(40), obs: [makeObs(NOW, 5000)] }),
      // not reached yet
      makeVideo({ id: 'youtube:d', publishedAt: pub(2), obs: [makeObs(NOW, 50)] }),
      makeVideo({ id: 'niconico:e', publishedAt: pub(8), obs: [makeObs(pub(8) + 7 * DAY, 20)] }),
    ],
  });

  it('counts reached / not reached / ranked per platform like queryVideos', () => {
    const c = ratingsCohort(index, { ageDays: 7, tz: TZ, now: NOW });
    const yt = c.platforms.find((p) => p.platform === 'youtube')!;
    expect(yt).toMatchObject({ reached: 3, notReached: 1, ranked: 2, unavailable: 1 });
    expect(yt.values).toEqual([300, 700]);
    expect(yt.median).toBe(500);
    const nc = c.platforms.find((p) => p.platform === 'niconico')!;
    expect(nc).toMatchObject({ reached: 1, ranked: 1, notReached: 0 });
    expect(c.entries.get('youtube:a')).toMatchObject({ value: 700, rank: 1, platform: 'youtube' });
    expect(c.entries.get('youtube:b')).toMatchObject({ value: 300, rank: 2 });
    expect(c.entries.has('youtube:c')).toBe(false);
    // Same reached count as the core query for one platform.
    const q = queryVideos(index, { dateMode: 'age', ageDays: 7, tz: TZ, now: NOW, sort: 'views_at_age', platforms: ['youtube'] });
    expect(q.total).toBe(yt.reached);
    expect(q.notes.join(' ')).toContain('1개는 비교에서 제외');
  });

  it('restricts publish dates with the upload range', () => {
    const c = ratingsCohort(index, { ageDays: 7, tz: TZ, now: NOW, range: { start: '2026-09-18', end: '2026-09-19' } });
    const yt = c.platforms.find((p) => p.platform === 'youtube')!;
    // 2026-09-18 00:00Z = pub(10) (09:00 KST on 09-18) and 2026-09-19 00:00Z = pub(9) are inside; c and d are not.
    expect(yt.reached).toBe(2);
    expect(yt.notReached).toBe(0);
  });

  it('picks the platform with the most values by default', () => {
    const mk = (platform: PlatformCohort['platform'], ranked: number, reached: number): PlatformCohort => ({
      platform,
      reached,
      notReached: 0,
      ranked,
      unavailable: reached - ranked,
      statusCounts: {},
      values: [],
      median: null,
      p25: null,
      p75: null,
    });
    expect(defaultRatingsPlatform([mk('youtube', 2, 100), mk('dailymotion', 5, 10)])).toBe('dailymotion');
    expect(defaultRatingsPlatform([mk('youtube', 0, 100), mk('dailymotion', 0, 10)])).toBe('youtube');
    expect(defaultRatingsPlatform([])).toBeNull();
  });

  it('agrees with queryVideos percentiles on the sample', () => {
    const c = ratingsCohort(sampleIndex, { ageDays: 7, tz: TZ, now: sample.generatedAt });
    const top = c.platforms.slice().sort((a, b) => b.ranked - a.ranked)[0];
    const q = queryVideos(sampleIndex, { dateMode: 'age', ageDays: 7, tz: TZ, now: sample.generatedAt, sort: 'views_at_age', platforms: [top.platform] });
    const ranked = q.rows.filter((r) => rankValue(r.metrics.viewsAtAge) !== null);
    expect(ranked.length).toBe(top.ranked);
    for (const r of ranked.slice(0, 10)) expect(c.entries.get(r.video.id)?.percentile).toBe(r.metrics.percentile.value);
    expect(ageGapHours(7)).toBe(84);
    expect(ageGapHours(1)).toBe(12);
  });
});

describe('RatingsPage (server render)', () => {
  it('renders the cohort, distribution, leaderboard and explanation', () => {
    const t = text(render(sample, '/ratings?age=7'));
    for (const s of ['비디오 레이팅', '비교 대상', 'V7 값 있음', '아직 도달 안 함', 'V7 분포', 'V7 순위', '왜 같은 나이로 비교하나', '플랫폼 자동 선택']) {
      expect(t).toContain(s);
    }
    expect(t).not.toContain('계산하지 못함');
  });

  it('shows the selected video with its V1..V30 values', () => {
    const c = ratingsCohort(sampleIndex, { ageDays: 7, tz: TZ, now: sample.generatedAt });
    const id = [...c.entries.keys()][0];
    const v = sampleIndex.videosById.get(id)!;
    const t = text(render(sample, `/ratings?age=7&platforms=${v.platform}&v=${encodeURIComponent(id)}`));
    expect(t).toContain('코호트');
    for (const s of ['V1', 'V2', 'V3', 'V7 (선택)', 'V30', '영상 탐색에서 성장 곡선 보기']) expect(t).toContain(s);
  });

  it('warns when platforms are mixed and offers the in-platform percentile sort', () => {
    const t = text(render(sample, '/ratings?age=3&platforms=youtube,dailymotion,peertube,niconico,tiktok'));
    expect(t).toContain('여러 플랫폼이 섞인 순위');
    expect(t).toContain('플랫폼 내 백분위로 정렬');
    expect(t).toContain('여러 플랫폼은 단위가 달라 중앙값을 합치지 않음');
  });

  it('explains missing V values when videos have a single observation', () => {
    const early: Dataset = { ...sample, videos: sample.videos.map((v) => ({ ...v, obs: v.obs.slice(-1) })) };
    const t = text(render(early, '/ratings?age=30'));
    expect(t).toContain('계산할 수 있는 영상이 아직 적음');
    expect(t).toContain('0으로 세지 않음');
    expect(t).not.toContain('계산하지 못함');
  });
});
