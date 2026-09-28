import { describe, expect, it } from 'vitest';
import { buildIndex, presetRange, queryResultToCsv, queryVideos } from '@vti/core';
import type { Dataset, Video } from '@vti/core';
import { generateSampleDataset } from '../../../scripts/sample-generator.ts';
import {
  activeFilterCount,
  buildViewsChart,
  dailySpan,
  dataCoverage,
  defaultSortFor,
  effectiveSort,
  EMPTY_FILTERS,
  fullVideoQuery,
  isSortApplicable,
  matchTopics,
  metricSource,
  observedMetric,
  searchVideos,
  sortLabel,
  SORT_MENU,
  summarizeStatuses,
  toVideoQuery,
  videoFacets,
} from './model.ts';
import type { VideoSearchInput } from './model.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const TZ = 'Asia/Seoul';

const dataset = generateSampleDataset({ videos: 300 });
const index = buildIndex(dataset);
const now = dataset.generatedAt;

function input(over: Partial<VideoSearchInput> = {}): VideoSearchInput {
  return {
    ...EMPTY_FILTERS,
    mode: 'activity',
    range: presetRange('rolling7d', TZ, now),
    rollingHours: 168,
    age: 7,
    tz: TZ,
    now,
    sort: 'views_period',
    dir: 'desc',
    page: 1,
    pageSize: 50,
    ...over,
  };
}

function video(over: Partial<Video>): Video {
  return {
    id: 'youtube:t1',
    platform: 'youtube',
    platformId: 't1',
    url: 'https://www.youtube.com/watch?v=t1',
    title: 't',
    description: null,
    thumbnail: null,
    publishedAt: 0,
    durationSec: null,
    format: 'long',
    accountId: 'youtube:a1',
    language: 'ko',
    languageSource: 'source',
    country: 'KR',
    sourceCategory: null,
    tags: [],
    categories: [],
    topics: [],
    sponsorship: null,
    status: 'active',
    firstSeenAt: 0,
    lastObservedAt: 0,
    discoveredVia: [],
    obs: [],
    sourceWindows: [],
    ...over,
  };
}

const ob = (t: number, views: number | null, likes: number | null = null) => ({ t, views, likes, comments: null, shares: null, src: 'youtube-rss@1' });

describe('sort vocabulary', () => {
  it('has a default per date mode', () => {
    expect(defaultSortFor('upload')).toBe('views_total');
    expect(defaultSortFor('activity')).toBe('views_period');
    expect(defaultSortFor('age')).toBe('views_at_age');
  });

  it('offers every SortKey and disables only the ones that cannot rank in the mode', () => {
    expect(new Set(SORT_MENU).size).toBe(11);
    expect(isSortApplicable('views_at_age', 'activity')).toBe(false);
    expect(isSortApplicable('views_at_age', 'age')).toBe(true);
    expect(isSortApplicable('growth_vs_prev', 'upload')).toBe(false);
    expect(isSortApplicable('growth_vs_prev', 'age')).toBe(false);
    expect(isSortApplicable('growth_vs_prev', 'activity')).toBe(true);
    for (const k of SORT_MENU) expect(isSortApplicable(k, 'activity') || k === 'views_at_age').toBe(true);
  });

  it('falls back to the mode default for an inapplicable key from a shared link', () => {
    expect(effectiveSort('views_at_age', 'upload')).toBe('views_total');
    expect(effectiveSort('velocity', 'upload')).toBe('velocity');
  });

  it('labels period metrics by date mode', () => {
    expect(sortLabel('views_period', 'upload', 7)).toBe('게시 후 조회');
    expect(sortLabel('views_period', 'activity', 7)).toBe('기간 조회 증가');
    expect(sortLabel('views_period', 'age', 30)).toBe('V30 조회');
    expect(sortLabel('views_at_age', 'age', 3)).toContain('V3');
  });
});

describe('toVideoQuery', () => {
  it('passes rollingHours with the range in period modes and drops empty filters', () => {
    const q = toVideoQuery(input());
    expect(q.rollingHours).toBe(168);
    expect(q.range).toEqual(presetRange('rolling7d', TZ, now));
    expect(q.ageDays).toBeUndefined();
    expect(q.platforms).toBeUndefined();
    expect(q.q).toBeUndefined();
    expect(q.minViews).toBeUndefined();
    expect(q.sponsored).toBeUndefined();
  });

  it('age mode compares every video at the same age (no period restriction)', () => {
    const q = toVideoQuery(input({ mode: 'age', age: 30, sort: 'views_at_age' }));
    expect(q.range).toBeUndefined();
    expect(q.rollingHours).toBeUndefined();
    expect(q.ageDays).toBe(30);
  });

  it('maps URL filters to core filters', () => {
    const q = toVideoQuery(input({ q: '  추석 ', platforms: ['youtube'], cats: ['beauty'], topics: ['추석'], langs: ['ko'], countries: ['KR'], formats: ['short'], sponsored: 'disclosed', minViews: 1000, accounts: ['youtube:a'] }));
    expect(q).toMatchObject({ q: '추석', platforms: ['youtube'], categories: ['beauty'], topics: ['추석'], languages: ['ko'], countries: ['KR'], formats: ['short'], sponsored: 'disclosed', minViews: 1000, accountIds: ['youtube:a'] });
  });

  it('counts active filters', () => {
    expect(activeFilterCount(EMPTY_FILTERS)).toBe(0);
    expect(activeFilterCount({ ...EMPTY_FILTERS, q: 'x', platforms: ['youtube'], minViews: 10, sponsored: 'none' })).toBe(4);
  });
});

describe('searchVideos', () => {
  it('pages through the same ordering as queryVideos with limit/offset', () => {
    const p1 = searchVideos(index, input({ pageSize: 20 }));
    const p2 = searchVideos(index, input({ pageSize: 20, page: 2 }));
    const ref = queryVideos(index, { ...toVideoQuery(input()), limit: 20, offset: 20 });
    expect(p1.result.rows).toHaveLength(Math.min(20, p1.result.total));
    expect(p2.offset).toBe(20);
    expect(p2.result.rows.map((r) => r.video.id)).toEqual(ref.rows.map((r) => r.video.id));
    expect(p2.result.total).toBe(ref.total);
    expect(p2.result.notes).toEqual(ref.notes);
  });

  it('clamps the page and summarizes statuses over the whole filtered result', () => {
    const r = searchVideos(index, input({ page: 999 }));
    expect(r.page).toBe(r.pageCount);
    expect(r.primary.total).toBe(r.result.total);
    const sum = Object.values(r.primary.counts).reduce((a, b) => a + (b ?? 0), 0);
    expect(sum).toBe(r.result.total);
    expect(r.primary.known + r.primary.unavailable + r.primary.decreased).toBe(r.primary.total);
    expect(r.platforms.length).toBeGreaterThan(0);
  });

  it('reuses one cached full result for paging and export', () => {
    const q = toVideoQuery(input({ platforms: ['youtube'] }));
    expect(fullVideoQuery(index, { ...q, limit: 5 })).toBe(fullVideoQuery(index, { ...q, offset: 10 }));
  });

  it('upload mode keeps only videos published in the window', () => {
    const r = searchVideos(index, input({ mode: 'upload', sort: 'views_total', pageSize: 1000 }));
    const w = r.result.window!;
    for (const row of r.result.rows) {
      expect(row.video.publishedAt).toBeGreaterThanOrEqual(w.startMs);
      expect(row.video.publishedAt).toBeLessThan(w.endMs);
    }
  });

  it('returns an empty result (not an error) when nothing matches', () => {
    const r = searchVideos(index, input({ q: 'zz-no-such-video-zz' }));
    expect(r.result.total).toBe(0);
    expect(r.page).toBe(1);
    expect(dataCoverage(r.primary)).toBe('empty');
  });
});

describe('dataCoverage', () => {
  it('distinguishes nothing computable, partial and ok', () => {
    const st = (s: string, n: number) => Array.from({ length: n }, () => ({ status: s as 'exact' }));
    expect(dataCoverage(summarizeStatuses(st('unavailable', 5)))).toBe('none');
    expect(dataCoverage(summarizeStatuses([...st('exact', 7), ...st('unavailable', 3)]))).toBe('partial');
    expect(dataCoverage(summarizeStatuses([...st('exact', 9), ...st('unavailable', 1)]))).toBe('ok');
    expect(dataCoverage(summarizeStatuses([...st('decrease_flagged', 2)]))).toBe('none');
  });
});

describe('videoFacets', () => {
  const vids: Video[] = [
    video({ id: 'youtube:1', language: 'ko', country: 'kr', format: 'short', topics: ['뉴스', 'ytn'], categories: [{ id: 'news/politics', confidence: 0.9, evidence: [], by: 'rule', version: 'v' }], firstSeenAt: 5, obs: [ob(1, 1), ob(2, 2)] }),
    video({ id: 'dailymotion:2', platform: 'dailymotion', language: 'en', country: null, topics: ['뉴스'], categories: [{ id: 'news', confidence: 0.7, evidence: [], by: 'source', version: 'v' }], firstSeenAt: 3, obs: [ob(1, 1)] }),
  ];
  const f = videoFacets(vids);

  it('counts options and categories with ancestors once per video', () => {
    expect(f.platforms).toEqual(['youtube', 'dailymotion']);
    expect(f.platformCounts).toEqual({ youtube: 1, dailymotion: 1 });
    expect(f.languages.map((o) => o.value).sort()).toEqual(['en', 'ko']);
    expect(f.countries).toEqual([expect.objectContaining({ value: 'KR', count: 1 })]);
    expect(f.categoryCounts).toEqual({ news: 2, 'news/politics': 1 });
    expect(f.formats.find((o) => o.value === 'short')?.count).toBe(1);
    expect(f.formats.find((o) => o.value === 'long')?.count).toBe(1);
  });

  it('orders topics by count and knows how many videos have a curve', () => {
    expect(f.topics.map((t) => t.topic)).toEqual(['뉴스', 'ytn']);
    expect(f.multiObserved).toBe(1);
    // The collection start is not a facet: every page reads it from lib/collection.ts (one definition).
    expect('collectionStart' in f).toBe(false);
  });

  it('is cached per videos array', () => {
    expect(videoFacets(vids)).toBe(f);
  });
});

describe('matchTopics', () => {
  const topics = videoFacets([
    video({ id: 'y:1', topics: ['YTN뉴스', '뉴스', '스포츠뉴스'] }),
    video({ id: 'y:2', topics: ['뉴스', '스포츠뉴스'] }),
    video({ id: 'y:3', topics: ['뉴스'] }),
  ]).topics;

  it('puts prefix matches first, then substring matches, excluding selected ones', () => {
    expect(matchTopics(topics, '뉴스').map((t) => t.topic)).toEqual(['뉴스', '스포츠뉴스', 'YTN뉴스']);
    expect(matchTopics(topics, 'ytn').map((t) => t.topic)).toEqual(['YTN뉴스']);
    expect(matchTopics(topics, '', ['뉴스']).map((t) => t.topic)).toEqual(['스포츠뉴스', 'YTN뉴스']);
    expect(matchTopics(topics, '뉴', [], 1)).toHaveLength(1);
  });
});

describe('buildViewsChart', () => {
  it('separates interpolation, anchor, gap and decrease segments; each series breaks where the kind changes', () => {
    const v = video({
      publishedAt: 0,
      obs: [ob(1 * HOUR, 10), ob(4 * HOUR, 40), ob(7 * HOUR, 70), ob(7 * HOUR + 3 * DAY, 700), ob(7 * HOUR + 3 * DAY + 3 * HOUR, 650), ob(7 * HOUR + 3 * DAY + 6 * HOUR, 660)],
    });
    const m = buildViewsChart(v);
    expect(m.anchor).toEqual({ t: 0, v: 0 });
    expect(m.segments.map((s) => s.kind)).toEqual(['anchor', 'interp', 'interp', 'gap', 'decrease', 'interp']);
    expect(m.kinds).toEqual(['interp', 'anchor', 'gap', 'decrease']);
    // interp series: continuous over the first two interp segments, broken before the last one.
    const interp = m.rows.map((r) => r.interp);
    expect(interp.filter((x) => x !== null)).toEqual([10, 40, 40, 70, 650, 660]);
    const firstBreak = interp.indexOf(null, interp.indexOf(70));
    expect(firstBreak).toBeGreaterThan(-1);
    // dots only on observed points, never on the publish anchor.
    expect(m.rows.find((r) => r.isAnchor)?.obs).toBeNull();
    expect(new Set(m.rows.filter((r) => r.obs !== null).map((r) => r.x)).size).toBe(6);
  });

  it('does not anchor at publish when the first observation is too late, and keeps a lone point', () => {
    const v = video({ publishedAt: 0, obs: [ob(10 * DAY, 500)] });
    const m = buildViewsChart(v);
    expect(m.anchor).toBeNull();
    expect(m.segments).toEqual([]);
    expect(m.rows).toEqual([expect.objectContaining({ x: 10 * DAY, obs: 500 })]);
  });

  it('treats a hidden counter between observations as a gap', () => {
    const v = video({ publishedAt: 0, obs: [ob(1 * HOUR, 10), ob(2 * HOUR, null), ob(3 * HOUR, 30)] });
    expect(buildViewsChart(v).segments.map((s) => s.kind)).toEqual(['anchor', 'gap']);
  });
});

describe('detail helpers', () => {
  it('limits the daily span to the publish day and the last N days', () => {
    const t = Date.UTC(2026, 8, 28, 3); // 12:00 KST
    expect(dailySpan({ publishedAt: t - 2 * DAY }, TZ, t, 14)).toEqual({ start: '2026-09-26', end: '2026-09-28' });
    expect(dailySpan({ publishedAt: t - 400 * DAY }, TZ, t, 14)).toEqual({ start: '2026-09-15', end: '2026-09-28' });
  });

  it('turns raw counters into metric values without coercing null to 0', () => {
    expect(observedMetric(null, 5)).toEqual({ value: null, status: 'unavailable', asOf: 5, note: 'counter_not_provided' });
    expect(observedMetric(0, 5)).toEqual({ value: 0, status: 'exact', asOf: 5, note: null });
  });

  it('names the source adapter of a value', () => {
    const v = video({ obs: [ob(1, 1)], sourceWindows: [{ metric: 'views', windowHours: 24, value: 3, observedAt: 9, src: 'dailymotion@1' }] });
    expect(metricSource(v, { status: 'source_reported', asOf: 9 })).toBe('dailymotion@1');
    expect(metricSource(v, { status: 'exact', asOf: 1 })).toBe('youtube-rss@1');
  });
});

describe('CSV export of the full filtered result', () => {
  it('exports every filtered row (not just the page) and neutralizes formula-like titles', () => {
    const ds: Dataset = generateSampleDataset({ videos: 120 });
    const evil = ['=HYPERLINK("http://x","y")', '+SUM(1)', '-2+3', '@cmd'];
    evil.forEach((t, i) => (ds.videos[i].title = t));
    const idx = buildIndex(ds);
    const inp = input({ now: ds.generatedAt, range: presetRange('rolling30d', TZ, ds.generatedAt), rollingHours: 720, pageSize: 10 });
    const page = searchVideos(idx, inp);
    const csv = queryResultToCsv(fullVideoQuery(idx, toVideoQuery(inp)), TZ, { dateMode: 'activity' });
    const lines = csv.trim().split('\r\n');
    expect(lines.length - 1).toBe(page.result.total);
    expect(page.result.total).toBeGreaterThan(10);
    const exported = new Set(fullVideoQuery(idx, toVideoQuery(inp)).rows.map((r) => r.video.title));
    const checked = evil.filter((t) => exported.has(t));
    expect(checked.length).toBeGreaterThan(0);
    for (const t of checked) expect(csv).toContain(`'${t.replace(/"/g, '""')}`);
    expect(csv).not.toMatch(/,=HYPERLINK/);
  });
});
