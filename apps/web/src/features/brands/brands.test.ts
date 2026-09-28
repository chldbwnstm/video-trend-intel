/**
 * 브랜드 협업: report logic (sample dataset + small hand-made fixtures) and server-rendered page / parts.
 */
import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { buildIndex, presetRange } from '@vti/core';
import type { Dataset, Video } from '@vti/core';
import { DatasetContext } from '../../data/context.ts';
import type { DatasetContextValue } from '../../data/context.ts';
import { generateSampleDataset } from '../../../scripts/sample-generator.ts';
import BrandsPage from '../../pages/Brands.tsx';
import { brandCsvRows, buildBrandReport, evidenceSnippet, isCuratedBrand, sortBrands, sumRankValue, uniqueEvidence } from './brandsModel.ts';
import type { BrandReportInput } from './brandsModel.ts';
import { EvidenceList } from './BrandParts.tsx';

const dataset = generateSampleDataset({ videos: 600 });
const index = buildIndex(dataset);
const now = dataset.generatedAt;
const tz = 'Asia/Seoul';

function input(over: Partial<BrandReportInput> = {}): BrandReportInput {
  return { mode: 'activity', range: presetRange('last90d', tz, now), rollingHours: null, tz, now, level: 'any', ...over };
}

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('buildBrandReport', () => {
  const report = buildBrandReport(index, input());

  it('keeps only videos with a sponsorship signal and counts levels consistently', () => {
    expect(report.rows.length).toBeGreaterThan(0);
    expect(report.rows.every((r) => r.video.sponsorship)).toBe(true);
    expect(report.totals.disclosed + report.totals.likely).toBe(report.totals.videos);
    expect(report.totals.videos).toBe(report.rows.length);
    const unbranded = report.rows.filter((r) => !r.video.sponsorship!.brands.length).length;
    expect(report.totals.unbranded).toBe(unbranded);
  });

  it('groups by brand with creators and per-platform sums', () => {
    expect(report.brands.length).toBeGreaterThan(0);
    for (const b of report.brands) {
      expect(b.videos).toBe(b.disclosed + b.likely);
      expect(b.videoIds.length).toBe(b.videos);
      expect(b.creators.reduce((a, c) => a + c.count, 0)).toBe(b.videos);
      expect(b.byPlatform.reduce((a, p) => a + p.videos, 0)).toBe(b.videos);
      // Sample brands are fictional -> not in the curated list.
      expect(b.curated).toBe(false);
    }
    // Sorted by summed views desc, unrankable last.
    const values = report.brands.map((b) => sumRankValue(b.views));
    const firstNull = values.indexOf(null);
    const ranked = (firstNull < 0 ? values : values.slice(0, firstNull)) as number[];
    for (let i = 1; i < ranked.length; i++) expect(ranked[i - 1]).toBeGreaterThanOrEqual(ranked[i]);
    if (firstNull >= 0) expect(values.slice(firstNull).every((v) => v === null)).toBe(true);
  });

  it('builds the creator -> brands view', () => {
    const total = report.creators.reduce((a, c) => a + c.videos, 0);
    expect(total).toBe(report.totals.videos);
    for (const c of report.creators) expect(c.disclosed + c.likely).toBe(c.videos);
  });

  it('filters disclosed / likely levels', () => {
    const disclosed = buildBrandReport(index, input({ level: 'disclosed' }));
    const likely = buildBrandReport(index, input({ level: 'likely' }));
    expect(disclosed.rows.every((r) => r.video.sponsorship!.level === 'disclosed')).toBe(true);
    expect(likely.rows.every((r) => r.video.sponsorship!.level === 'likely')).toBe(true);
    expect(disclosed.rows.length + likely.rows.length).toBe(report.rows.length);
  });

  it('matches the text filter against brand names', () => {
    const name = report.brands[0].name;
    const filtered = buildBrandReport(index, input({ q: name.toLowerCase() }));
    expect(filtered.rows.length).toBeGreaterThan(0);
    expect(filtered.brands.some((b) => b.name === name)).toBe(true);
  });

  it('upload mode only keeps videos published in the window', () => {
    const r = buildBrandReport(index, input({ mode: 'upload', range: presetRange('rolling7d', tz, now), rollingHours: 168 }));
    const w = r.result.window!;
    expect(r.rows.every((x) => x.video.publishedAt >= w.startMs && x.video.publishedAt < w.endMs)).toBe(true);
  });

  it('sortBrands supports every key and keeps unrankable sums last when ascending', () => {
    for (const key of ['views', 'videos', 'creators', 'latest'] as const) {
      expect(sortBrands(report.brands, key).length).toBe(report.brands.length);
    }
    const asc = sortBrands(report.brands, 'views', 'asc');
    const firstNull = asc.findIndex((b) => sumRankValue(b.views) === null);
    if (firstNull >= 0) expect(asc.slice(firstNull).every((b) => sumRankValue(b.views) === null)).toBe(true);
  });

  it('exports CSV rows with status and empty cells for unavailable sums', () => {
    const rows = brandCsvRows(report, (ms) => String(ms));
    expect(rows[0]).toContain('상태');
    expect(rows.length).toBe(report.brands.length + 1);
    for (const r of rows.slice(1)) if (r[9] === 'unavailable') expect(r[8]).toBeNull();
  });
});

describe('brand sums are honest', () => {
  function vid(id: string, brands: string[], views: [number, number | null][], published: number, level: 'disclosed' | 'likely' = 'disclosed'): Video {
    return {
      id: `youtube:${id}`,
      platform: 'youtube',
      platformId: id,
      url: `https://www.youtube.com/watch?v=${id}`,
      title: `영상 ${id}`,
      description: '유료 광고 포함',
      thumbnail: null,
      publishedAt: published,
      durationSec: null,
      format: 'long',
      accountId: 'youtube:acc',
      language: 'ko',
      languageSource: 'source',
      country: 'KR',
      sourceCategory: null,
      tags: [],
      categories: [],
      topics: [],
      sponsorship: { level, brands, evidence: [{ field: 'description', match: '유료 광고 포함' }], version: 'sponsor-test' },
      status: 'active',
      firstSeenAt: views[0][0],
      lastObservedAt: views[views.length - 1][0],
      discoveredVia: ['test'],
      obs: views.map(([t, v]) => ({ t, views: v, likes: null, comments: null, shares: null, src: 'test@1' })),
      sourceWindows: [],
    };
  }
  const H = 3_600_000;
  const t0 = Date.UTC(2026, 8, 20, 0, 0, 0);
  const nowT = t0 + 10 * 24 * H;
  const ds: Dataset = {
    schemaVersion: 1,
    generatedAt: nowT,
    classifierVersion: 'rules-test',
    videos: [
      // Fully observed across the last 24h -> exact.
      vid('a', ['브랜드A'], [[nowT - 30 * H, 100], [nowT - 24 * H, 200], [nowT, 500]], t0),
      // Only one observation (first seen 1h ago) -> increment over the last 24h is unknown.
      vid('b', ['브랜드A'], [[nowT - H, 1000]], t0),
      // No brand identified.
      vid('c', [], [[nowT - 24 * H, 10], [nowT, 20]], t0, 'likely'),
    ],
    accounts: [],
    creators: [],
    coverage: [],
    runs: [],
    exportNotes: [],
  };
  const idx = buildIndex(ds);
  const report = buildBrandReport(idx, {
    mode: 'activity',
    range: presetRange('rolling24h', tz, nowT),
    rollingHours: 24,
    tz,
    now: nowT,
    level: 'any',
  });

  it('turns a sum with an unmeasured video into a lower bound, never counting it as 0', () => {
    const a = report.brands.find((b) => b.name === '브랜드A')!;
    expect(a.videos).toBe(2);
    expect(a.views.status).toBe('lower_bound');
    expect(a.views.value).toBe(300);
  });

  it('counts unbranded videos separately', () => {
    expect(report.totals.unbranded).toBe(1);
    expect(report.brands.map((b) => b.name)).toEqual(['브랜드A']);
    expect(report.creators[0].unbranded).toBe(1);
  });
});

describe('evidence snippets', () => {
  const video = {
    title: '신제품 리뷰 [광고]',
    description: '이 영상은 유료광고를   포함하고 있습니다. 브랜드X 에서 제품을 제공받았습니다.',
    tags: ['리뷰', '브랜드X'],
  };

  it('finds the match with surrounding text, tolerating spacing differences', () => {
    const s = evidenceSnippet(video, { field: 'description', match: '유료 광고를 포함' }, 8);
    expect(s).not.toBeNull();
    expect(s!.match.replace(/\s/g, '')).toBe('유료광고를포함');
    expect(s!.cutEnd).toBe(true);
  });

  it('works for titles and tags and returns null when absent', () => {
    expect(evidenceSnippet(video, { field: 'title', match: '[광고]' })!.match).toBe('[광고]');
    expect(evidenceSnippet(video, { field: 'tags', match: '브랜드x' })!.match).toBe('브랜드X');
    expect(evidenceSnippet(video, { field: 'description', match: '없는 문구' })).toBeNull();
    expect(evidenceSnippet({ title: 'x', description: null, tags: [] }, { field: 'description', match: 'x' })).toBeNull();
  });

  it('de-duplicates evidence by field and normalized match', () => {
    expect(
      uniqueEvidence([
        { field: 'title', match: 'PPL' },
        { field: 'title', match: 'ppl' },
        { field: 'description', match: 'ppl' },
      ]).length,
    ).toBe(2);
  });

  it('renders detected text as escaped text, never HTML', () => {
    const v = {
      ...dataset.videos[0],
      description: '<img src=x onerror=alert(1)> 협찬: 나쁜브랜드',
      sponsorship: { level: 'disclosed' as const, brands: ['나쁜브랜드'], evidence: [{ field: 'description' as const, match: '협찬' }], version: 'v' },
    };
    const html = renderToStaticMarkup(h(EvidenceList, { video: v }));
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
    expect(html).toContain('<mark');
  });

  it('knows curated brand names', () => {
    expect(isCuratedBrand('무신사')).toBe(true);
    expect(isCuratedBrand('가상의브랜드')).toBe(false);
  });
});

describe('BrandsPage', () => {
  const value: DatasetContextValue = {
    dataset,
    index,
    now,
    isSample: true,
    tz,
    setTz: () => undefined,
    source: { url: './data/sample.json', bytes: 0, fallbackReason: null, loadedAt: 0 },
    reload: () => undefined,
  };
  const render = (url: string) =>
    renderToStaticMarkup(
      h(DatasetContext.Provider, { value }, h(MemoryRouter, { initialEntries: [url] }, h(Routes, null, h(Route, { path: '/brands', element: h(BrandsPage) })))),
    );

  it('renders the caveat, filters, KPIs and the brand leaderboard', () => {
    const t = text(render('/brands?range=last90d&mode=activity'));
    for (const s of ['브랜드 협업', '탐지 방식', '계약', '광고 표기', '협찬 추정', '협찬 신호 영상', '브랜드 미확인', '기간 조회 증가 합계', '크리에이터별']) {
      expect(t).toContain(s);
    }
    const report = buildBrandReport(index, input());
    expect(t).toContain(report.brands[0].name);
  });

  it('renders the sponsored video and creator tabs', () => {
    const videos = text(render('/brands?range=last90d&tab=videos'));
    expect(videos).toContain('근거');
    const creators = text(render('/brands?range=last90d&tab=creators'));
    expect(creators).toContain('함께한 브랜드');
  });

  it('shows an explicit empty state when nothing matches', () => {
    const t = text(render('/brands?q=__no_such_brand__'));
    expect(t).toContain('조건에 맞는 협찬 신호 영상 없음');
  });
});
