/**
 * 트렌드 page: pure logic (hand-made fixtures + the synthetic sample) and server-rendered page states,
 * including an "early history" dataset where every video has a single observation (like the first real
 * collection), which must render explanations instead of blank lists.
 */
import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { buildIndex, computeTrending, presetRange } from '@vti/core';
import type { Dataset } from '@vti/core';
import { makeIndex, makeObs, makeVideo, ts } from '../../../../../packages/core/test/fixtures.ts';
import { DatasetContext } from '../../data/context.ts';
import type { DatasetContextValue } from '../../data/context.ts';
import { generateSampleDataset } from '../../../scripts/sample-generator.ts';
import TrendsPage from '../../pages/Trends.tsx';
import { TrendList } from './TrendList.tsx';
import { emptyReason, entityDailySeries, entityKeysOf, isNewItem, itemHref, listedKeys, smallBase, spanLabel, topVideoRows, trendSum, videoHref } from './logic.ts';
import { dataReadiness, isEarlyHistory, languageCounts } from './readiness.ts';

const TZ = 'Asia/Seoul';
const HOUR = 3_600_000;

const sample = generateSampleDataset({ videos: 400 });
const sampleIndex = buildIndex(sample);

/** Like the first real collection: every video keeps only its latest observation. */
function singleObservation(ds: Dataset): Dataset {
  return { ...ds, videos: ds.videos.map((v) => ({ ...v, obs: v.obs.slice(-1), firstSeenAt: v.obs.length ? v.obs[v.obs.length - 1].t : v.firstSeenAt })) };
}

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
    h(DatasetContext.Provider, { value: ctx(ds) }, h(MemoryRouter, { initialEntries: [url] }, h(Routes, null, h(Route, { path: '/trends', element: h(TrendsPage) })))),
  );
}

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

/* ------------------------------------------------------------------------------------------ fixtures */

// now = 2026-09-28 00:00 KST (2026-09-27T15:00Z); hourly observations for 10 days on three topic videos.
const NOW = ts('2026-09-27T15:00:00Z');
function denseVideo(id: string, topics: string[], perHour: number, publishedAt = ts('2026-09-10T00:00:00Z')) {
  const obs = [];
  for (let t = ts('2026-09-15T00:00:00Z'); t <= NOW; t += HOUR) obs.push(makeObs(t, Math.round((t - publishedAt) / HOUR) * perHour));
  return makeVideo({ id, topics, publishedAt, obs });
}

describe('readiness', () => {
  it('finds the first observation and the share of videos with history', () => {
    const idx = makeIndex({
      videos: [
        makeVideo({ id: 'youtube:a', obs: [makeObs('2026-09-20', 1), makeObs('2026-09-21', 5)] }),
        makeVideo({ id: 'youtube:b', obs: [makeObs('2026-09-19', 3)] }),
        makeVideo({ id: 'youtube:c', obs: [] }),
      ],
    });
    const r = dataReadiness(idx.dataset);
    expect(r.firstObservationAt).toBe(ts('2026-09-19'));
    expect(r.lastObservationAt).toBe(ts('2026-09-21'));
    expect(r.withHistory).toBe(1);
    expect(r.historyShare).toBeCloseTo(1 / 3);
    expect(isEarlyHistory(r)).toBe(true);
    expect(isEarlyHistory(dataReadiness(sample))).toBe(false);
  });

  it('counts languages most frequent first, case-insensitively', () => {
    const counts = languageCounts([
      makeVideo({ language: 'ko' }),
      makeVideo({ language: 'KO' }),
      makeVideo({ language: 'ja' }),
      makeVideo({ language: null }),
    ]);
    expect(counts).toEqual([
      { code: 'ko', count: 2 },
      { code: 'ja', count: 1 },
    ]);
  });
});

describe('window labels', () => {
  it('uses inclusive local dates for midnight-aligned windows and date-times otherwise', () => {
    // 2026-09-22 00:00 KST .. 2026-09-29 00:00 KST
    expect(spanLabel(ts('2026-09-21T15:00:00Z'), ts('2026-09-28T15:00:00Z'), TZ)).toBe('2026-09-22 ~ 2026-09-28');
    expect(spanLabel(ts('2026-09-27T15:00:00Z'), ts('2026-09-28T15:00:00Z'), TZ)).toBe('2026-09-28');
    expect(spanLabel(ts('2026-09-21T15:21:00Z'), ts('2026-09-28T15:21:00Z'), TZ)).toBe('2026-09-22 00:21 ~ 2026-09-29 00:21');
  });
});

describe('entity keys and daily series', () => {
  const index = makeIndex({
    generatedAt: NOW,
    videos: [denseVideo('youtube:a', ['x'], 10), denseVideo('youtube:b', ['x', 'y'], 20), denseVideo('youtube:c', ['y'], 5)],
  });

  it('mirrors computeTrending membership (topics)', () => {
    const v = index.videosById.get('youtube:b')!;
    expect(entityKeysOf('topic', v, index).sort()).toEqual(['x', 'y']);
    expect(entityKeysOf('account', v, index)).toEqual(['youtube:acc1']);
    expect(entityKeysOf('creator', v, index)).toEqual(['youtube:acc1']);
  });

  it('sums like-for-like daily increments per entity (dense data -> exact daily values)', () => {
    // Local days 2026-09-21..2026-09-27 (KST): [2026-09-20T15:00Z, 2026-09-27T15:00Z)
    const r = entityDailySeries(index, { kind: 'topic', keys: ['x', 'y'], startMs: ts('2026-09-20T15:00:00Z'), endMs: NOW, tz: TZ, now: NOW });
    expect(r.skipped).toBeNull();
    expect(r.dates).toEqual(['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27']);
    expect(r.byKey.x.values).toEqual(new Array(7).fill(24 * 30));
    expect(r.byKey.y.values).toEqual(new Array(7).fill(24 * 25));
    expect(r.byKey.x.fullMembers).toBe(2);
    expect(r.byKey.x.totalMembers).toBe(2);
    expect(r.byKey.x.statuses.every((s) => s === 'exact')).toBe(true);
  });

  it('leaves out members that are not observed on every day, and skips too short / too long windows', () => {
    const sparse = makeIndex({
      generatedAt: NOW,
      videos: [denseVideo('youtube:a', ['x'], 10), makeVideo({ id: 'youtube:s', topics: ['x'], publishedAt: ts('2026-09-01'), obs: [makeObs(NOW - HOUR, 999)] })],
    });
    const r = entityDailySeries(sparse, { kind: 'topic', keys: ['x'], startMs: ts('2026-09-20T15:00:00Z'), endMs: NOW, tz: TZ, now: NOW });
    expect(r.byKey.x.fullMembers).toBe(1);
    expect(r.byKey.x.totalMembers).toBe(2);
    expect(r.byKey.x.values).toEqual(new Array(7).fill(240));
    expect(entityDailySeries(sparse, { kind: 'topic', keys: ['x'], startMs: NOW - 24 * HOUR, endMs: NOW, tz: TZ, now: NOW }).skipped).toBe('too_short');
    expect(entityDailySeries(sparse, { kind: 'topic', keys: ['x'], startMs: NOW - 90 * 24 * HOUR, endMs: NOW, tz: TZ, now: NOW }).skipped).toBe('too_long');
    expect(entityDailySeries(sparse, { kind: 'topic', keys: ['x'], startMs: NOW + HOUR, endMs: NOW + 48 * HOUR, tz: TZ, now: NOW }).skipped).toBe('not_started');
  });

  it('only-single-observation members give no series (null, not zeros)', () => {
    const single = makeIndex({
      generatedAt: NOW,
      videos: ['a', 'b', 'c'].map((id) => makeVideo({ id: `youtube:${id}`, topics: ['x'], publishedAt: ts('2026-09-01'), obs: [makeObs(NOW - HOUR, 100)] })),
    });
    const r = entityDailySeries(single, { kind: 'topic', keys: ['x'], startMs: ts('2026-09-20T15:00:00Z'), endMs: NOW, tz: TZ, now: NOW });
    expect(r.byKey.x.values).toBeNull();
    expect(r.byKey.x.totalMembers).toBe(3);
  });
});

describe('trend values and links', () => {
  it('marks a sum with incomplete videos as a lower bound', () => {
    expect(trendSum(100, { incompleteCount: 2 }, 1).status).toBe('lower_bound');
    expect(trendSum(100, { incompleteCount: 0 }, 1).status).toBe('interpolated');
    expect(isNewItem({ growth: null, previous: 0, current: 5 })).toBe(true);
    expect(isNewItem({ growth: 0.5, previous: 2, current: 3 })).toBe(false);
    expect(smallBase({ growth: 21641, previous: 6 })).toBe(true);
    expect(smallBase({ growth: 2.5, previous: 1000 })).toBe(false);
    expect(smallBase({ growth: null, previous: 0 })).toBe(false);
  });

  it('links topics / categories to the video search and creators / accounts to the creator page', () => {
    const p = { range: 'rolling7d', platforms: ['youtube' as const] };
    expect(itemHref('topic', '추석', p)).toBe('/videos?mode=activity&sort=views_period&range=rolling7d&platforms=youtube&topics=%EC%B6%94%EC%84%9D');
    expect(itemHref('category', 'beauty', p)).toBe('/videos?mode=activity&sort=views_period&range=rolling7d&platforms=youtube&cats=beauty');
    expect(itemHref('account', 'youtube:UC1', p)).toBe('/creators/youtube%3AUC1');
    expect(videoHref('youtube:abc', 'rolling7d')).toBe('/videos?mode=activity&sort=views_period&range=rolling7d&v=youtube%3Aabc');
  });

  it('explains empty lists when the previous window predates the first observation', () => {
    const r = { ...dataReadiness(sample), historyShare: 1 };
    const w = { startMs: 10, endMs: 20, tz: TZ, incomplete: false };
    const base = { window: w, previousWindow: { ...w, startMs: 0, endMs: 10 }, top: [] };
    expect(emptyReason(base, { ...r, firstObservationAt: 5 })).toBe('no_history');
    expect(emptyReason(base, { ...r, firstObservationAt: 15 })).toBe('window_before_collection');
    expect(emptyReason(base, { ...r, firstObservationAt: 0 })).toBe('none');
    expect(emptyReason(base, { ...r, firstObservationAt: 0, historyShare: 0.1 })).toBe('no_history');
  });
});

describe('sample dataset', () => {
  const range = presetRange('last7d', TZ, sample.generatedAt);
  const result = computeTrending(sampleIndex, { kind: 'topic', range, tz: TZ, now: sample.generatedAt, limit: 20 });

  it('top videos of an item carry the values computeTrending summed', () => {
    const item = result.top[0];
    expect(item).toBeDefined();
    const rows = topVideoRows(sampleIndex, {
      ids: item.topVideoIds,
      startMs: result.window.startMs,
      endMs: result.window.endMs,
      prevStartMs: result.previousWindow.startMs,
      prevEndMs: result.previousWindow.endMs,
      tz: TZ,
      now: sample.generatedAt,
    });
    expect(rows.map((r) => r.video.id)).toEqual(item.topVideoIds);
    const sumTop = rows.reduce((a, r) => a + (r.current.value ?? 0), 0);
    expect(sumTop).toBeLessThanOrEqual(item.current + 1e-6);
  });

  it('daily series cover every listed key with like-for-like members', () => {
    const keys = listedKeys(result);
    const r = entityDailySeries(sampleIndex, { kind: 'topic', keys, startMs: result.window.startMs, endMs: result.window.endMs, tz: TZ, now: sample.generatedAt });
    expect(Object.keys(r.byKey).sort()).toEqual(keys);
    for (const k of keys) {
      const d = r.byKey[k];
      expect(d.fullMembers).toBeLessThanOrEqual(d.totalMembers);
      if (d.values) expect(d.values).toHaveLength(r.dates.length);
    }
    expect(keys.some((k) => r.byKey[k].values !== null)).toBe(true);
  });
});

describe('TrendsPage (server render)', () => {
  it('renders the three lists, the comparison window and the notes', () => {
    const t = text(render(sample, '/trends?kind=topic&range=last7d'));
    expect(t).toContain('트렌드');
    for (const s of ['상승 주제', '하락 주제', '상위 주제', '직전 동일 기간', '이번 기간', '수집 범위·지표 정의']) expect(t).toContain(s);
    expect(t).not.toContain('트렌드를 계산하지 못함');
  });

  it('switches entity kind from the URL', () => {
    const t = text(render(sample, '/trends?kind=category&range=last30d'));
    expect(t).toContain('상위 분야');
    const c = text(render(sample, '/trends?kind=creator'));
    expect(c).toContain('상위 크리에이터');
  });

  it('explains partial history instead of rendering blank lists (single observation per video)', () => {
    const early = singleObservation(sample);
    const t = text(render(early, '/trends?kind=topic&range=rolling7d'));
    expect(t).toContain('관측 기록이 아직 짧음');
    expect(t).toContain('데이터 범위·수집 방식 보기');
    expect(t).not.toContain('트렌드를 계산하지 못함');
    // Empty rising / falling lists carry the reason and a shortcut to a shorter window.
    expect(t).toContain('상승 항목 없음');
    expect(t).toContain('직전 동일 기간의 관측이 아직 부족');
    expect(t).toContain('최근 24시간으로 보기');
  });
});

describe('TrendList expanded item (server render)', () => {
  it('shows both windows, the daily chart or its reason, and top videos linking to the video drawer', () => {
    const range = presetRange('last7d', TZ, sample.generatedAt);
    const result = computeTrending(sampleIndex, { kind: 'topic', range, tz: TZ, now: sample.generatedAt, limit: 20 });
    const daily = entityDailySeries(sampleIndex, {
      kind: 'topic',
      keys: listedKeys(result),
      startMs: result.window.startMs,
      endMs: result.window.endMs,
      tz: TZ,
      now: sample.generatedAt,
    });
    const item = result.top[0];
    const html = renderToStaticMarkup(
      h(
        DatasetContext.Provider,
        { value: ctx(sample) },
        h(
          MemoryRouter,
          null,
          h(TrendList, {
            list: 'top',
            items: result.top.slice(0, 3),
            result,
            kind: 'topic',
            daily,
            openKey: `top:${item.key}`,
            onToggle: () => undefined,
            linkParams: { range: 'last7d' },
            empty: null,
          }),
        ),
      ),
    );
    const t = text(html);
    expect(t).toContain('이번 기간 조회 증가 상위 영상');
    expect(t).toContain('직전 동일 기간');
    expect(t).toMatch(/일별 조회 증가|일별 추이/);
    expect(html).toContain(`href="/videos?mode=activity&amp;sort=views_period&amp;range=last7d&amp;v=${encodeURIComponent(item.topVideoIds[0]).replace(/%3A/g, '%3A')}"`);
    expect(html).toContain('aria-expanded="true"');
    expect(t).toContain('영상 탐색에서 모두 보기');
  });
});
