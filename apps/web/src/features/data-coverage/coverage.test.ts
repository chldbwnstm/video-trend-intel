/**
 * 데이터 범위: model helpers and the server-rendered page (sample dataset).
 */
import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { buildIndex } from '@vti/core';
import type { CollectionRun, SourceCoverage } from '@vti/core';
import { DatasetContext } from '../../data/context.ts';
import type { DatasetContextValue } from '../../data/context.ts';
import { generateSampleDataset } from '../../../scripts/sample-generator.ts';
import CoveragePage from '../../pages/Coverage.tsx';
import {
  computability,
  coverageSummary,
  credentialEnvVars,
  formatDurationKo,
  formatHoursKo,
  observationDepth,
  rankableShare,
  runSummary,
  sortRuns,
  sourceRows,
} from './coverageModel.ts';

const dataset = generateSampleDataset({ videos: 400 });
const index = buildIndex(dataset);
const now = dataset.generatedAt;
const tz = 'Asia/Seoul';
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');

function cov(over: Partial<SourceCoverage>): SourceCoverage {
  return {
    source: 'x',
    platform: 'youtube',
    label: 'X',
    enabled: true,
    requiresCredentials: false,
    discovery: '',
    metrics: ['views'],
    firstRunAt: null,
    lastRunAt: null,
    lastSuccessAt: null,
    lastStatus: 'never',
    lastError: null,
    videoCount: 0,
    accountCount: 0,
    notes: [],
    docsUrl: null,
    ...over,
  };
}

describe('credentials', () => {
  it('knows the env vars of every credentialed adapter in the spec', () => {
    expect(credentialEnvVars(cov({ source: 'youtube-data-api', requiresCredentials: true }))).toEqual(['YOUTUBE_API_KEY']);
    expect(credentialEnvVars(cov({ source: 'tiktok-research', requiresCredentials: true }))).toEqual(['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET']);
    expect(credentialEnvVars(cov({ source: 'instagram-graph', requiresCredentials: true }))).toEqual(['IG_ACCESS_TOKEN', 'IG_USER_ID']);
    expect(credentialEnvVars(cov({ source: 'x-api', requiresCredentials: true }))).toEqual(['X_BEARER_TOKEN']);
    expect(credentialEnvVars(cov({ source: 'twitch', requiresCredentials: true }))).toEqual(['TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET']);
  });

  it('parses env vars of unknown adapters from the coverage notes', () => {
    expect(
      credentialEnvVars(cov({ source: 'new-api', requiresCredentials: true, notes: ['인증 정보가 없어 비활성화됨 (필요한 환경 변수: FOO_KEY, BAR_SECRET)'] })),
    ).toEqual(['FOO_KEY', 'BAR_SECRET']);
    expect(credentialEnvVars(cov({ source: 'youtube-rss' }))).toEqual([]);
  });
});

describe('coverage model', () => {
  it('summarizes the dataset', () => {
    const s = coverageSummary(dataset);
    expect(s.videos).toBe(dataset.videos.length);
    expect(s.enabled + s.disabled).toBe(s.sources);
    expect(s.categorizedShare).not.toBeNull();
    expect(s.historyHours).not.toBeNull();
  });

  it('builds source rows with freshness state, env vars and missing metrics', () => {
    const rows = sourceRows(dataset.coverage, now);
    expect(rows.length).toBe(dataset.coverage.length);
    for (const r of rows) {
      expect(r.missingMetrics.every((m) => !r.coverage.metrics.includes(m))).toBe(true);
      if (r.requiresCredentials) expect(r.env.length).toBeGreaterThan(0);
    }
    // Disabled sources sort after enabled ones.
    const firstDisabled = rows.findIndex((r) => r.state === 'disabled');
    if (firstDisabled >= 0) expect(rows.slice(firstDisabled).every((r) => r.state === 'disabled')).toBe(true);
  });

  it('computes observation depth per platform', () => {
    const rows = observationDepth(dataset);
    expect(rows.reduce((a, r) => a + r.videos, 0)).toBe(dataset.videos.length);
    for (const r of rows) expect(r.buckets.reduce((a, b) => a + b, 0)).toBe(r.videos);
  });

  it('computes the status mix of period views per rolling preset', () => {
    const rows = computability(index, { tz, now });
    expect(rows.map((r) => r.hours)).toEqual([24, 168, 720]);
    for (const r of rows) {
      const sum = Object.values(r.all.counts).reduce((a, b) => a + b, 0);
      expect(sum).toBe(r.all.total);
      expect(r.byPlatform.reduce((a, p) => a + p.total, 0)).toBe(r.all.total);
      const share = rankableShare(r.all);
      expect(share === null || (share >= 0 && share <= 1)).toBe(true);
    }
    expect(rankableShare({ total: 0, counts: { exact: 0, interpolated: 0, lower_bound: 0, source_reported: 0, unavailable: 0, decrease_flagged: 0 } })).toBeNull();
  });

  it('summarizes runs with a median interval per source', () => {
    const H = 3_600_000;
    const run = (id: string, source: string, startedAt: number, status: CollectionRun['status'] = 'ok'): CollectionRun => ({
      id,
      startedAt,
      finishedAt: startedAt + 60_000,
      source,
      status,
      videosSeen: 1,
      videosNew: 1,
      observations: 1,
      requests: 1,
      errors: status === 'ok' ? [] : ['boom'],
    });
    const t = 1_000 * H;
    const runs = [run('a', 's1', t - 6 * H), run('b', 's1', t - 3 * H, 'error'), run('c', 's1', t), run('d', 's2', t - 30 * H)];
    const s = runSummary(runs, t);
    expect(s.total).toBe(4);
    expect(s.problems).toBe(1);
    expect(s.last24h).toBe(3);
    expect(s.problems24h).toBe(1);
    expect(s.medianIntervalHours).toBe(3);
    expect(sortRuns(runs)[0].id).toBe('c');
    expect(runSummary([run('x', 's', t)], t).medianIntervalHours).toBeNull();
  });

  it('formats durations and spans in Korean', () => {
    expect(formatDurationKo(42)).toBe('42초');
    expect(formatDurationKo(185)).toBe('3분 5초');
    expect(formatDurationKo(3720)).toBe('1시간 2분');
    expect(formatDurationKo(null)).toBe('—');
    expect(formatHoursKo(0.5)).toBe('30분');
    expect(formatHoursKo(18)).toBe('18시간');
    expect(formatHoursKo(84)).toBe('3.5일');
  });
});

describe('CoveragePage', () => {
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
  const html = renderToStaticMarkup(
    h(DatasetContext.Provider, { value }, h(MemoryRouter, { initialEntries: ['/coverage'] }, h(Routes, null, h(Route, { path: '/coverage', element: h(CoveragePage) })))),
  );
  const t = text(html);

  it('shows freshness, the per-source table and cards', () => {
    expect(t).toContain('데이터 범위');
    expect(t).toContain('데이터 기준 시각');
    expect(t).toContain('2026-09-28 12:00');
    expect(t).toContain('원천별 수집 현황');
    for (const c of dataset.coverage) expect(t).toContain(c.label);
  });

  it('explains what can be computed now and the observation history', () => {
    expect(t).toContain('지금 데이터로 계산할 수 있는 범위');
    expect(t).toContain('최근 168시간(7일)');
    expect(t).toContain('관측 이력');
  });

  it('lists runs with errors, export notes and metric definitions', () => {
    expect(t).toContain('수집 실행 기록');
    expect(t).toContain('내보내기 메모');
    for (const n of dataset.exportNotes) expect(t).toContain(n.slice(0, 20));
    for (const s of ['X 조회수 = 노출 수', 'YouTube 조회 집계 변경', 'niconico는 하루 1회 스냅샷', 'Dailymotion 기간값은 원천 제공']) expect(t).toContain(s);
    expect(t).toContain('하한값');
    expect(t).toContain('계산 불가');
  });

  it('states what we do not offer and how to enable more sources', () => {
    expect(t).toContain('제공하지 않는 기능');
    expect(t).toContain('Audience Ratings');
    expect(t).toContain('Consumer Insights');
    expect(t).toContain('원천 추가하기');
    expect(t).toContain('GitHub Actions');
    expect(t).toContain('.env');
    for (const e of ['YOUTUBE_API_KEY', 'TIKTOK_CLIENT_KEY', 'IG_ACCESS_TOKEN', 'X_BEARER_TOKEN', 'TWITCH_CLIENT_ID']) {
      if (dataset.coverage.some((c) => !c.enabled && credentialEnvVars(c).includes(e))) expect(t).toContain(e);
    }
  });
});
