/**
 * Real-data check: when the collected dataset (public/data/dataset.json) is present, run the same core calls the
 * creator pages make and server-render the three pages against it. The real export has a different shape than the
 * sample (few observations per video, followers from one source only), so this guards against blank or broken
 * sections. Skipped when the file is absent (e.g. a fresh clone).
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import type { ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { buildIndex, creatorTimeline, decodeDataset, postingHeatmap, presetRange, queryVideos, resolveAnalysisWindow, summarizeCreators } from '@vti/core';
import type { CompactDataset, DatasetIndex } from '@vti/core';
import { DatasetContext } from '../../data/context.ts';
import type { DatasetContextValue } from '../../data/context.ts';
import CreatorsPage from '../../pages/Creators.tsx';
import CreatorDetailPage from '../../pages/CreatorDetail.tsx';
import ComparePage from '../../pages/Compare.tsx';
import { dataReadiness } from '../trends/readiness.ts';
import { computeComparison, computeCreatorDetail, metricLeaders, portfolioOptions, windowBeforeCollection } from './logic.ts';
import type { CompareEntry } from './logic.ts';

const file = fileURLToPath(new URL('../../../public/data/dataset.json', import.meta.url));
const present = existsSync(file);

describe.skipIf(!present)('creator pages on the real dataset', () => {
  let index: DatasetIndex;
  let value: DatasetContextValue;
  const tz = 'Asia/Seoul';

  const load = () => {
    if (index) return;
    const dataset = decodeDataset(JSON.parse(readFileSync(file, 'utf8')) as CompactDataset);
    index = buildIndex(dataset);
    value = {
      dataset,
      index,
      now: dataset.generatedAt,
      isSample: false,
      tz,
      setTz: () => undefined,
      source: { url: './data/dataset.json', bytes: 0, fallbackReason: null, loadedAt: 0 },
      reload: () => undefined,
    };
  };

  const render = (url: string, path: string, Page: ComponentType) =>
    renderToStaticMarkup(h(DatasetContext.Provider, { value }, h(MemoryRouter, { initialEntries: [url] }, h(Routes, null, h(Route, { path, element: h(Page) })))));
  const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  it('core calls return data for every rolling preset', () => {
    load();
    const now = index.dataset.generatedAt;
    for (const [preset, hours] of [
      ['rolling24h', 24],
      ['rolling7d', 168],
      ['rolling30d', 720],
    ] as const) {
      const range = presetRange(preset, tz, now);
      const s = summarizeCreators(index, { range, rollingHours: hours, tz, now });
      expect(s.length).toBeGreaterThan(0);
      const creator = s.find((x) => x.kind === 'creator' && x.platforms.length > 1);
      if (!creator) continue;
      const d = computeCreatorDetail(index, { key: creator.key, range, rollingHours: hours, tz, now });
      expect(d?.summary.key).toBe(creator.key);
      expect(creatorTimeline(index, creator.key, { range, tz, now }).length).toBeGreaterThan(0);
      expect(postingHeatmap(index, creator.key, tz, now).counts).toHaveLength(7);
      const q = queryVideos(index, { dateMode: 'activity', range, rollingHours: hours, tz, now, accountIds: d!.portfolio.accountIds, sort: 'views_period', limit: 10 });
      expect(q.total).toBe(d!.summary.videoCount);
    }
    const opts = portfolioOptions(index, now);
    const keys = opts.filter((o) => o.kind === 'creator').slice(0, 4).map((o) => o.key);
    const cmp = computeComparison(index, { keys, range: presetRange('rolling30d', tz, now), rollingHours: 720, tz, now, platforms: [] });
    expect(cmp.entries.every((e) => e.found)).toBe(keys.length > 0);
  });

  it('does not present a leaderboard of zeros for a window before the first observation', () => {
    load();
    const now = index.dataset.generatedAt;
    const first = dataReadiness(index.dataset).firstObservationAt;
    const w = resolveAnalysisWindow(presetRange('lastMonth', tz, now), tz, now, null);
    const t = text(render('/creators?range=lastMonth', '/creators', CreatorsPage));
    if (windowBeforeCollection(w, first, now)) {
      expect(t).toContain('선택한 기간은 첫 관측 이전임');
      expect(t).toContain('크리에이터 목록 (기간 업로드 순)');
    } else {
      expect(t).not.toContain('선택한 기간은 첫 관측 이전임');
    }
  });

  it('never crowns every compared creator on a tie', () => {
    load();
    const now = index.dataset.generatedAt;
    // The first four options, and the set a reviewer saw all marked '최고 0%' (Dailymotion likes are all 0).
    const sets = [portfolioOptions(index, now).slice(0, 4).map((o) => o.key), ['channel-a', 'mbn', 'ytn', 'dailymotion:x2eco0h']];
    for (const keys of sets) {
      const cmp = computeComparison(index, { keys, range: presetRange('rolling30d', tz, now), rollingHours: 720, tz, now, platforms: [] });
      const found = cmp.entries.filter((e) => e.found && e.summary);
      for (const pick of [(e: CompareEntry) => e.summary!.engagementRate, (e: CompareEntry) => e.summary!.viewsInWindow]) {
        const l = metricLeaders(found.map(pick));
        if (found.length >= 2) expect(l.indices.length, keys.join(',')).toBeLessThan(found.length);
      }
      for (const p of cmp.platforms) {
        const rows = found.map((e) => e.perPlatform.find((x) => x.platform === p)).filter((x) => x !== undefined);
        if (rows.length < 2) continue;
        expect(metricLeaders(rows.map((r) => r.summary.engagementRate)).indices.length, `${keys.join(',')} ${p}`).toBeLessThan(rows.length);
      }
    }
  });

  it('renders the list, a creator, an account and the comparison without failed sections', () => {
    load();
    const now = index.dataset.generatedAt;
    const opts = portfolioOptions(index, now);
    const creator = opts.find((o) => o.kind === 'creator');
    const account = opts.find((o) => o.kind === 'account' && o.videos > 0);
    const pages: [string, string, ComponentType][] = [
      ['/creators', '/creators', CreatorsPage],
      ['/creators?sort=followers&platforms=dailymotion', '/creators', CreatorsPage],
      ['/creators?sort=median_v7&range=rolling24h', '/creators', CreatorsPage],
      ['/compare', '/compare', ComparePage],
    ];
    if (creator) pages.push([`/creators/${creator.key}`, '/creators/:key', CreatorDetailPage]);
    if (account) pages.push([`/creators/${account.key}?range=rolling7d`, '/creators/:key', CreatorDetailPage]);
    const keys = opts.slice(0, 4).map((o) => o.key);
    pages.push([`/compare?keys=${keys.join(',')}`, '/compare', ComparePage]);
    for (const [url, path, Page] of pages) {
      const t = text(render(url, path, Page));
      expect(t, url).not.toContain('계산하지 못함');
      expect(t, url).not.toContain('표시하지 못함');
      expect(t, url).not.toContain('찾을 수 없음');
    }
  });
});
