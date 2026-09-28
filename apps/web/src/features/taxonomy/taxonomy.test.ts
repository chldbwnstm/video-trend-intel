/**
 * 분류 체계: per-node statistics, tree flattening, node detail and the server-rendered page.
 */
import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { buildIndex, presetRange, TAXONOMY, TOP_LEVEL_CATEGORY_IDS } from '@vti/core';
import { DatasetContext } from '../../data/context.ts';
import type { DatasetContextValue } from '../../data/context.ts';
import { generateSampleDataset } from '../../../scripts/sample-generator.ts';
import TaxonomyPage from '../../pages/Taxonomy.tsx';
import { computeNodeDetail, computeTaxonomyStats, flattenTree, nodeIdsOf, searchNodes } from './taxonomyModel.ts';
import type { TaxonomyStatsInput } from './taxonomyModel.ts';

const dataset = generateSampleDataset({ videos: 500 });
const index = buildIndex(dataset);
const now = dataset.generatedAt;
const tz = 'Asia/Seoul';
const base: TaxonomyStatsInput = { mode: 'activity', range: presetRange('rolling7d', tz, now), rollingHours: 168, tz, now };
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');

describe('computeTaxonomyStats', () => {
  const stats = computeTaxonomyStats(index, base);

  it('has an entry for every taxonomy node and consistent totals', () => {
    expect(Object.keys(stats.nodes).length).toBe(TAXONOMY.length);
    expect(stats.categorized + stats.uncategorized).toBe(stats.scopeVideos);
    expect(stats.scopeVideos).toBe(dataset.videos.filter((v) => v.publishedAt <= now && v.firstSeenAt <= now).length);
  });

  it('counts a parent as the union of itself and its descendants', () => {
    for (const top of TOP_LEVEL_CATEGORY_IDS) {
      const expected = dataset.videos.filter((v) => v.publishedAt <= now && nodeIdsOf(v).includes(top)).length;
      expect(stats.nodes[top].videos).toBe(expected);
      for (const n of TAXONOMY.filter((x) => x.parent === top)) {
        expect(stats.nodes[n.id].videos).toBeLessThanOrEqual(stats.nodes[top].videos);
      }
    }
  });

  it('never reports a period sum as a plain number when some videos were not measured', () => {
    for (const s of Object.values(stats.nodes)) {
      if (s.incomplete > 0) expect(['lower_bound', 'unavailable']).toContain(s.views.status);
      expect(s.uploads).toBeLessThanOrEqual(s.videos);
    }
  });

  it('upload mode counts only uploads in the window as rows', () => {
    const up = computeTaxonomyStats(index, { ...base, mode: 'upload' });
    const top = TOP_LEVEL_CATEGORY_IDS.find((id) => up.nodes[id].uploads > 0);
    if (top) expect(up.nodes[top].measured + up.nodes[top].incomplete).toBeLessThanOrEqual(up.nodes[top].uploads);
  });

  it('respects the platform filter', () => {
    const yt = computeTaxonomyStats(index, { ...base, platforms: ['youtube'] });
    expect(yt.scopeVideos).toBe(dataset.videos.filter((v) => v.platform === 'youtube' && v.publishedAt <= now && v.firstSeenAt <= now).length);
    for (const s of Object.values(yt.nodes)) expect(s.platforms.every((p) => p === 'youtube')).toBe(true);
  });

  it('reports assignment methods and versions', () => {
    const total = Object.values(stats.assignmentsByMethod).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(0);
    expect(stats.versions.length).toBeGreaterThan(0);
  });
});

describe('flattenTree', () => {
  const stats = computeTaxonomyStats(index, base);

  it('shows top-level nodes only until expanded', () => {
    const rows = flattenTree(stats, new Set(), 'videos');
    expect(rows.length).toBe(TOP_LEVEL_CATEGORY_IDS.length);
    expect(rows.every((r) => r.depth === 0)).toBe(true);
    for (let i = 1; i < rows.length; i++) expect(rows[i - 1].stats.videos).toBeGreaterThanOrEqual(rows[i].stats.videos);
  });

  it('puts children right under an expanded parent', () => {
    const rows = flattenTree(stats, new Set(['beauty']), 'taxonomy');
    const i = rows.findIndex((r) => r.id === 'beauty');
    const kids = TAXONOMY.filter((n) => n.parent === 'beauty').length;
    expect(rows.slice(i + 1, i + 1 + kids).every((r) => r.parent === 'beauty' && r.depth === 1)).toBe(true);
    expect(rows[0].id).toBe(TOP_LEVEL_CATEGORY_IDS[0]);
  });

  it('filters by search and keeps ancestors visible', () => {
    const filter = searchNodes('스킨케어')!;
    expect(filter.has('beauty/skincare')).toBe(true);
    expect(filter.has('beauty')).toBe(true);
    const rows = flattenTree(stats, new Set(), 'videos', 'desc', filter);
    expect(rows.map((r) => r.id)).toContain('beauty/skincare');
    expect(searchNodes('   ')).toBeNull();
  });

  it('keeps unrankable sums last when sorting by views', () => {
    const rows = flattenTree(stats, new Set(), 'views');
    const firstNull = rows.findIndex((r) => r.stats.views.status === 'unavailable');
    if (firstNull >= 0) expect(rows.slice(firstNull).every((r) => r.stats.views.status === 'unavailable')).toBe(true);
  });
});

describe('computeNodeDetail', () => {
  const stats = computeTaxonomyStats(index, base);
  const id = TOP_LEVEL_CATEGORY_IDS.filter((x) => stats.nodes[x].videos > 0).sort((a, b) => stats.nodes[b].videos - stats.nodes[a].videos)[0];
  const detail = computeNodeDetail(index, { ...base, id });

  it('returns topics, samples in the node and evidence behind the node', () => {
    expect(detail.known).toBe(true);
    expect(detail.samples.every((s) => nodeIdsOf(s.row.video).includes(id))).toBe(true);
    for (const s of detail.samples) if (s.assignment) expect(s.assignment.id === id || s.assignment.id.startsWith(`${id}/`)).toBe(true);
    const methods = Object.values(detail.methods).reduce((a, b) => a + b, 0);
    expect(methods).toBeGreaterThan(0);
    expect(detail.evidence.length).toBeGreaterThan(0);
    for (let i = 1; i < detail.topics.length; i++) expect(detail.topics[i - 1].videos).toBeGreaterThanOrEqual(detail.topics[i].videos);
    expect(detail.byPlatform.reduce((a, p) => a + p.videos, 0)).toBe(detail.rows);
  });

  it('handles unknown ids', () => {
    const d = computeNodeDetail(index, { ...base, id: 'nope/nothing' });
    expect(d.known).toBe(false);
    expect(d.rows).toBe(0);
  });
});

describe('TaxonomyPage', () => {
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
      h(DatasetContext.Provider, { value }, h(MemoryRouter, { initialEntries: [url] }, h(Routes, null, h(Route, { path: '/taxonomy', element: h(TaxonomyPage) })))),
    );

  it('renders the tree, the overview and how classification works', () => {
    const html = render('/taxonomy');
    const t = text(html);
    for (const s of ['분류 체계', '분야 트리', '분류 개요', '분류 방식', '키워드 규칙', '원천 분류 매핑', '분류기 버전', '뷰티']) expect(t).toContain(s);
    expect(t).toContain(dataset.classifierVersion);
  });

  it('renders a selected node with a click-through to /videos with the category filter', () => {
    const html = render('/taxonomy?node=beauty/skincare&range=last30d');
    const t = text(html);
    expect(t).toContain('스킨케어');
    expect(t).toContain('상위 주제');
    expect(t).toContain('샘플 영상과 분류 근거');
    expect(html).toContain('href="/videos?cats=beauty%2Fskincare&amp;mode=activity&amp;sort=views_period&amp;range=last30d"');
    // Its parent is expanded in the tree.
    expect(t).toContain('메이크업');
  });

  it('explains an unknown node instead of failing', () => {
    const t = text(render('/taxonomy?node=__nope__'));
    expect(t).toContain("알 수 없는 분야 '__nope__'");
  });
});
