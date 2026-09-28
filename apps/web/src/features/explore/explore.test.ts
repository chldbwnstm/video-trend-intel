/**
 * 기회 탐색: summary / platform choice (vs core resolveExplorePlatform), demand provenance (lower bounds),
 * quadrants, notes, and server-rendered page states.
 */
import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { buildIndex, computeOpportunities, presetRange, resolveExplorePlatform } from '@vti/core';
import type { Dataset, OpportunityItem } from '@vti/core';
import { makeIndex, makeObs, makeVideo, ts } from '../../../../../packages/core/test/fixtures.ts';
import { DatasetContext } from '../../data/context.ts';
import type { DatasetContextValue } from '../../data/context.ts';
import { generateSampleDataset } from '../../../scripts/sample-generator.ts';
import ExplorePage from '../../pages/Explore.tsx';
import { defaultExplorePlatform, demandMetric, demandProvenance, exploreNotes, exploreSummary, quadrantCounts, quadrantOf, sampleRows } from './logic.ts';

const TZ = 'Asia/Seoul';
const HOUR = 3_600_000;
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
    h(DatasetContext.Provider, { value: ctx(ds) }, h(MemoryRouter, { initialEntries: [url] }, h(Routes, null, h(Route, { path: '/explore', element: h(ExplorePage) })))),
  );
}

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('summary and platform choice', () => {
  it('counts uploads per platform in the window and picks the same platform as core', () => {
    for (const preset of ['rolling7d', 'rolling30d', 'last90d'] as const) {
      const range = presetRange(preset, TZ, sample.generatedAt);
      const rollingHours = preset === 'rolling7d' ? 168 : preset === 'rolling30d' ? 720 : null;
      const s = exploreSummary(sampleIndex, { range, rollingHours, tz: TZ, now: sample.generatedAt });
      expect(defaultExplorePlatform(s)).toBe(resolveExplorePlatform(sampleIndex, { range, rollingHours, tz: TZ, now: sample.generatedAt }));
      expect(s.platforms.reduce((a, p) => a + p.uploads, 0)).toBe(s.total);
      for (const p of s.platforms) expect(p.withTopics).toBeLessThanOrEqual(p.uploads);
    }
  });
});

describe('demand provenance', () => {
  const NOW = ts('2026-09-28T00:00:00Z');
  const index = makeIndex({
    generatedAt: NOW,
    videos: [
      makeVideo({ id: 'youtube:a', topics: ['t'], publishedAt: NOW - 48 * HOUR, obs: [makeObs(NOW, 100)] }),
      makeVideo({ id: 'youtube:b', topics: ['t'], publishedAt: NOW - 48 * HOUR, obs: [makeObs(NOW - 1 * HOUR, 200)] }),
      // last observation 10h before now -> latest views is a lower bound
      makeVideo({ id: 'youtube:c', topics: ['t', 'u'], publishedAt: NOW - 48 * HOUR, obs: [makeObs(NOW - 10 * HOUR, 300)] }),
      // no views counter -> supply only
      makeVideo({ id: 'youtube:d', topics: ['t'], publishedAt: NOW - 48 * HOUR, obs: [makeObs(NOW, null, 5)] }),
      makeVideo({ id: 'youtube:e', topics: [], publishedAt: NOW - 48 * HOUR, obs: [makeObs(NOW, 10)] }),
    ],
  });
  const scope = { range: { start: '2026-09-20', end: '2026-09-28' }, tz: TZ, now: NOW, platform: 'youtube' as const };

  it('marks topics whose latest views include a lower bound, and counts supply-only videos', () => {
    const p = demandProvenance(index, scope);
    expect(p.uploads).toBe(5);
    expect(p.withoutTopics).toBe(1);
    expect(p.noViews).toBe(1);
    expect(p.lowerBoundVideos).toBe(1);
    expect(p.byTopic.t).toMatchObject({ status: 'lower_bound', lowerBound: 1, valued: 3 });
    expect(p.byTopic.u).toMatchObject({ status: 'lower_bound', valued: 1 });
    const items = computeOpportunities(index, { ...scope, minSupply: 1 });
    const t = items.find((i) => i.topic === 't')!;
    expect(t.supply).toBe(4); // supply counts the no-views video too
    expect(t.demand).toBe(200);
    expect(demandMetric(t, p, NOW)).toMatchObject({ value: 200, status: 'lower_bound', note: 'partial' });
    expect(demandMetric(t, undefined, NOW).status).toBe('exact');
  });

  it('returns sample rows with their latest views', () => {
    const rows = sampleRows(index, { ids: ['youtube:c', 'youtube:missing', 'youtube:a'], now: NOW });
    expect(rows.map((r) => r.video.id)).toEqual(['youtube:c', 'youtube:a']);
    expect(rows[0].views.status).toBe('lower_bound');
    expect(rows[1].views).toMatchObject({ value: 100, status: 'exact' });
  });
});

describe('quadrants and notes', () => {
  const item = (dp: number, sp: number, supply = 3): OpportunityItem => ({
    topic: `t${dp}-${sp}`,
    label: 'x',
    demand: 1,
    supply,
    demandPercentile: dp,
    supplyPercentile: sp,
    score: dp - sp,
    sampleVideoIds: [],
  });

  it('splits at the 50th percentile', () => {
    expect(quadrantOf(item(80, 10))).toBe('opportunity');
    expect(quadrantOf(item(80, 60))).toBe('competitive');
    expect(quadrantOf(item(20, 10))).toBe('niche');
    expect(quadrantOf(item(20, 60))).toBe('saturated');
    expect(quadrantOf(item(50, 50))).toBe('competitive');
    expect(quadrantCounts([item(80, 10), item(90, 5), item(20, 60)])).toEqual({ opportunity: 2, competitive: 0, niche: 0, saturated: 1 });
  });

  it('explains the tracked-set supply, lower bounds and crowded minimum supply', () => {
    const notes = exploreNotes({
      items: [item(80, 10), item(90, 10), item(20, 60, 9)],
      prov: { byTopic: {}, uploads: 10, withoutTopics: 2, noViews: 1, lowerBoundVideos: 3 },
      platformLabel: 'YouTube',
      windowLabel: '2026-09-01 ~ 2026-09-28',
      minSupply: 3,
    }).join(' ');
    expect(notes).toContain('YouTube 추적 영상만');
    expect(notes).toContain('하한값(≥)인 영상 3개');
    expect(notes).toContain('공급이 최소치(3개)인 주제가 2개');
    expect(notes).toContain('조회수를 알 수 없는 영상 1개');
  });
});

describe('ExplorePage (server render)', () => {
  it('renders the tracked-set statement, the map, the table and the selected topic', () => {
    const t = text(render(sample, '/explore?range=last90d'));
    for (const s of ['기회 탐색', '공급은 우리가 추적하는 영상 집합 안에서만 센 업로드 수임', '데이터 범위·수집 방식 보기', '수요·공급 지도', '기회 점수 순위', '선택 주제', '플랫폼 자동 선택']) {
      expect(t).toContain(s);
    }
    expect(t).not.toContain('계산하지 못함');
  });

  it('uses the platform from the URL and the selected topic', () => {
    const range = presetRange('last90d', TZ, sample.generatedAt);
    const items = computeOpportunities(sampleIndex, { range, tz: TZ, now: sample.generatedAt, platform: 'dailymotion', limit: 5000 });
    const pick = items[Math.min(2, items.length - 1)];
    const t = text(render(sample, `/explore?range=last90d&platforms=dailymotion&topic=${encodeURIComponent(pick?.topic ?? '')}`));
    expect(t).toContain('Dailymotion 주제별 수요 백분위');
    if (pick) expect(t).toContain(`#${pick.label}`);
  });

  it('shows an empty state with guidance when there is nothing to compare', () => {
    const t = text(render(sample, '/explore?range=rolling24h&platforms=peertube&min=20'));
    expect(t).toContain('비교할 주제가 없음');
    expect(t).toContain('데이터 기준');
  });
});
