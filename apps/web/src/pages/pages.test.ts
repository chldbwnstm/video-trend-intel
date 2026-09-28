/**
 * Server-render smoke tests for the Dashboard (against the synthetic sample) and the placeholder pages.
 */
import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import type { ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { buildIndex, computeTrending, presetRange, queryVideos } from '@vti/core';
import { DatasetContext } from '../data/context.ts';
import type { DatasetContextValue } from '../data/context.ts';
import { generateSampleDataset } from '../../scripts/sample-generator.ts';
import DashboardPage from './Dashboard.tsx';
import VideosPage from './Videos.tsx';
import TrendsPage from './Trends.tsx';
import RatingsPage from './Ratings.tsx';
import ExplorePage from './Explore.tsx';
import CreatorsPage from './Creators.tsx';
import CreatorDetailPage from './CreatorDetail.tsx';
import ComparePage from './Compare.tsx';
import BrandsPage from './Brands.tsx';
import TaxonomyPage from './Taxonomy.tsx';
import CoveragePage from './Coverage.tsx';
import ApiDocsPage from './ApiDocs.tsx';
import NotFoundPage from './NotFound.tsx';

const dataset = generateSampleDataset({ videos: 400 });
const value: DatasetContextValue = {
  dataset,
  index: buildIndex(dataset),
  now: dataset.generatedAt,
  isSample: true,
  tz: 'Asia/Seoul',
  setTz: () => undefined,
  source: { url: './data/sample.json', bytes: 0, fallbackReason: null, loadedAt: 0 },
  reload: () => undefined,
};

function render(url: string, path: string, Page: ComponentType): string {
  return renderToStaticMarkup(
    h(DatasetContext.Provider, { value }, h(MemoryRouter, { initialEntries: [url] }, h(Routes, null, h(Route, { path, element: h(Page) })))),
  );
}

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

function implemented(fn: () => unknown): boolean {
  try {
    fn();
    return true;
  } catch (e) {
    if (e instanceof Error && /not implemented/.test(e.message)) return false;
    throw e;
  }
}

describe('Dashboard', () => {
  const html = render('/', '/', DashboardPage);
  const t = text(html);

  it('renders the header, the filter row and all KPI tiles', () => {
    expect(html).toContain('<h1');
    expect(t).toContain('대시보드');
    for (const label of ['추적 영상', '추적 계정', '플랫폼', '최근 24시간 관측', '기간 업로드']) expect(t).toContain(label);
    expect(t).toContain('최근 168시간(7일)');
    expect(t).toContain(dataset.videos.length.toLocaleString('ko-KR'));
  });

  it('renders every section with a state (data or an explicit error), never a crash', () => {
    for (const title of ['기간 상위 영상', '뜨는 주제', '플랫폼 분포', '분야 분포', '데이터 신선도']) expect(t).toContain(title);
    expect(t).toContain('데이터 기준 2026-09-28 12:00');
  });

  it('shows the top videos from queryVideos (activity mode, views_period) once core implements it', () => {
    const range = presetRange('rolling7d', 'Asia/Seoul', value.now);
    if (!implemented(() => queryVideos(value.index, { dateMode: 'activity', range, tz: 'Asia/Seoul', sort: 'views_period', limit: 10, now: value.now }))) {
      expect(t).toContain('상위 영상을 계산하지 못함');
      return;
    }
    const result = queryVideos(value.index, { dateMode: 'activity', range, rollingHours: 168, tz: 'Asia/Seoul', sort: 'views_period', sortDir: 'desc', limit: 10, now: value.now });
    expect(t).not.toContain('상위 영상을 계산하지 못함');
    for (const row of result.rows.slice(0, 3)) {
      const escaped = row.video.title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      expect(html).toContain(escaped);
    }
  });

  it('shows rising topics from computeTrending once core implements it', () => {
    const range = presetRange('rolling7d', 'Asia/Seoul', value.now);
    if (!implemented(() => computeTrending(value.index, { kind: 'topic', range, tz: 'Asia/Seoul', now: value.now, limit: 8 }))) {
      expect(t).toContain('뜨는 주제를 계산하지 못함');
      return;
    }
    expect(t).not.toContain('뜨는 주제를 계산하지 못함');
  });

  it('links into detailed pages with pre-filled URL state', () => {
    expect(html).toContain('href="/videos?mode=activity&amp;sort=views_period&amp;range=rolling7d"');
    expect(html).toContain('href="/trends?kind=topic&amp;range=rolling7d"');
    expect(html).toContain('href="/ratings?age=7"');
    expect(html).toContain('href="/coverage"');
  });

  it('carries platform and range filters from the URL into the links', () => {
    const filtered = render('/?range=last30d&platforms=youtube', '/', DashboardPage);
    expect(filtered).toContain('href="/videos?mode=activity&amp;sort=views_period&amp;range=last30d&amp;platforms=youtube"');
    expect(text(filtered)).toContain('최근 30일');
  });
});

describe('placeholder pages', () => {
  const pages: [string, string, ComponentType, string][] = [
    ['/videos', '/videos', VideosPage, '영상 탐색'],
    ['/trends', '/trends', TrendsPage, '트렌드'],
    ['/ratings', '/ratings', RatingsPage, '비디오 레이팅'],
    ['/explore', '/explore', ExplorePage, '기회 탐색'],
    ['/creators', '/creators', CreatorsPage, '크리에이터'],
    ['/creators/youtube:abc', '/creators/:key', CreatorDetailPage, 'youtube:abc'],
    ['/compare', '/compare', ComparePage, '크리에이터 비교'],
    ['/brands', '/brands', BrandsPage, '브랜드 협업'],
    ['/taxonomy', '/taxonomy', TaxonomyPage, '분류 체계'],
    ['/coverage', '/coverage', CoveragePage, '데이터 범위'],
    ['/api-docs', '/api-docs', ApiDocsPage, 'API'],
    ['/nope', '*', NotFoundPage, '페이지를 찾을 수 없음'],
  ];
  it.each(pages)('%s renders', (url, path, Page, expected) => {
    expect(text(render(url, path, Page))).toContain(expected);
  });
});
