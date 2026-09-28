/**
 * Dashboard on the collected dataset (public/data/dataset.json; skipped when absent). The real export is in its
 * early collection phase (one or two observations per video, discovery biased to recent uploads), which is
 * exactly where the dashboard used to mislead: upload "growth" from discovery bias, a "top 10" of unrankable
 * videos ordered by id, "last success in 1 minute" and an undercounted run total.
 * Assertions are conditional on the data's own timeline, so they keep holding as history accumulates.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { buildIndex, decodeDataset, resolveAnalysisWindow } from '@vti/core';
import type { CompactDataset, Dataset, DatasetIndex } from '@vti/core';
import { DatasetContext } from '../data/context.ts';
import type { DatasetContextValue } from '../data/context.ts';
import DashboardPage from '../pages/Dashboard.tsx';
import { collectionTimeline } from './collection.ts';
import { comparablePrevious, computeKpis, recentRunProblems, topRankedVideos } from './dashboard.ts';
import { resolveRangeSpec } from './urlState.ts';

const file = fileURLToPath(new URL('../../public/data/dataset.json', import.meta.url));
const present = existsSync(file);
const tz = 'Asia/Seoul';
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe.skipIf(!present)('dashboard on the real dataset', () => {
  let dataset: Dataset;
  let index: DatasetIndex;
  let value: DatasetContextValue;
  const load = () => {
    if (index) return;
    dataset = decodeDataset(JSON.parse(readFileSync(file, 'utf8')) as CompactDataset);
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
  const render = (url: string) =>
    renderToStaticMarkup(h(DatasetContext.Provider, { value }, h(MemoryRouter, { initialEntries: [url] }, h(Routes, null, h(Route, { path: '/', element: h(DashboardPage) })))));

  it('never reports upload growth against a previous window from before the collection started', () => {
    load();
    const start = collectionTimeline(dataset).collectionStartAt;
    for (const preset of ['rolling7d', 'rolling30d', 'last7d', 'last30d', 'thisMonth', 'lastMonth'] as const) {
      const r = resolveRangeSpec(preset, tz, dataset.generatedAt);
      const w = resolveAnalysisWindow(r.range, tz, dataset.generatedAt, r.rollingHours);
      const k = computeKpis(dataset, { now: dataset.generatedAt, window: w, collectionStartAt: start });
      const prev = comparablePrevious(w, dataset.generatedAt);
      if (start !== null && prev.endMs > prev.startMs && prev.startMs < start) {
        expect(k.uploadsComparison, preset).toBe('before_collection');
        expect(k.uploadsGrowth, preset).toBeNull();
      }
    }
  });

  it('ranks only videos with a period increase (no id-ordered "top 10" of dashes)', () => {
    load();
    for (const preset of ['rolling24h', 'rolling7d', 'lastMonth'] as const) {
      const r = resolveRangeSpec(preset, tz, dataset.generatedAt);
      const top = topRankedVideos(index, { dateMode: 'activity', range: r.range, rollingHours: r.rollingHours ?? undefined, tz, sort: 'views_period', now: dataset.generatedAt });
      expect(top.rows.length, preset).toBe(Math.min(10, top.rankable));
      for (const row of top.rows) expect(row.metrics.viewsPeriod.status, preset).not.toBe('unavailable');
    }
  });

  it('counts every run of the last day and never shows a last success "in the future"', () => {
    load();
    const until = collectionTimeline(dataset).collectedUntil;
    const inDay = dataset.runs.filter((r) => r.startedAt > until - 86_400_000).length;
    expect(recentRunProblems(dataset.runs, until).total).toBe(inDay);
    const html = render('/');
    expect(text(html)).not.toMatch(/마지막 성공 \d+(분|시간|일) 후/);
  });

  it('renders the default view without discovery-bias growth and explains an empty rising list', () => {
    load();
    const t = text(render('/'));
    const start = collectionTimeline(dataset).collectionStartAt as number;
    const w = resolveAnalysisWindow(resolveRangeSpec('rolling7d', tz, dataset.generatedAt).range, tz, dataset.generatedAt, 168);
    if (comparablePrevious(w, dataset.generatedAt).startMs < start) {
      expect(t).toContain('이전 기간은 수집 시작');
      expect(t).not.toContain('이전 같은 경과 시간 대비');
    }
    expect(t).not.toContain('상승한 주제 없음 — 이전 기간보다');
  });

  it('shows an explained empty state instead of unrankable rows for a window before the collection', () => {
    load();
    const t = text(render('/?range=lastMonth'));
    const start = collectionTimeline(dataset).firstObservationAt as number;
    const w = resolveAnalysisWindow(resolveRangeSpec('lastMonth', tz, dataset.generatedAt).range, tz, dataset.generatedAt, null);
    if (w.endMs <= start) {
      expect(t).toContain('조회 증가를 계산할 수 있는 영상 없음');
      expect(t).toContain('업로드 기간 기준으로 보기');
      expect(t).not.toContain('130529 생생정보통 샤이니');
    }
  });
});
