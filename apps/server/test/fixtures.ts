/**
 * Small, fully observed fixture dataset for the server tests. OWNER: server.
 */
import { buildIndex, encodeDataset } from '@vti/core';
import type { Dataset, DatasetIndex, ObservationPoint, SourceCoverage } from '@vti/core';
import { HOUR_MS, makeAccount, makeDataset, makeObs, makeSourceWindow, makeVideo, ts } from '../../../packages/core/test/fixtures.ts';

export const NOW = ts('2026-09-28T12:00:00Z');

/** Observations every `stepH` hours from `from` to NOW (inclusive), views = rate * hours since publish. */
function series(publishedAt: number, from: number, stepH: number, rate: number, extra: (h: number) => Partial<ObservationPoint> = () => ({})): ObservationPoint[] {
  const out: ObservationPoint[] = [];
  for (let t = from; t <= NOW; t += stepH * HOUR_MS) {
    const h = (t - publishedAt) / HOUR_MS;
    const e = extra(h);
    out.push(makeObs(t, Math.round(rate * h), e.likes ?? Math.round(rate * h * 0.05), e.comments ?? null, null, 'youtube-rss@1'));
  }
  return out;
}

export function fixtureDataset(generatedAt: number = NOW): Dataset {
  const p1 = ts('2026-09-01T00:00:00Z');
  const p2 = ts('2026-09-25T00:00:00Z');
  const p3 = ts('2026-09-10T00:00:00Z');
  const videos = [
    makeVideo({
      id: 'youtube:yt1',
      title: '스킨케어 루틴 완벽 정리',
      accountId: 'youtube:ch1',
      publishedAt: p1,
      obs: series(p1, p1, 12, 1000),
      categories: [{ id: 'beauty/skincare', confidence: 0.9, evidence: [{ field: 'title', match: '스킨케어' }], by: 'rule', version: 'test' }],
      topics: ['kpop', 'skincare'],
      language: 'ko',
      country: 'KR',
      format: 'long',
      tags: ['skincare'],
    }),
    makeVideo({
      id: 'youtube:yt2',
      title: 'Morning routine vlog',
      accountId: 'youtube:ch1',
      publishedAt: p2,
      obs: series(p2, p2, 12, 400),
      categories: [{ id: 'beauty/makeup', confidence: 0.8, evidence: [{ field: 'title', match: 'routine' }], by: 'rule', version: 'test' }],
      topics: ['kpop', 'routine'],
      language: 'en',
      format: 'short',
    }),
    makeVideo({
      id: 'youtube:yt3',
      title: 'Minecraft 하드코어 100일',
      accountId: 'youtube:ch2',
      publishedAt: p3,
      obs: series(p3, p3, 12, 2500),
      categories: [{ id: 'gaming/sandbox', confidence: 0.9, evidence: [{ field: 'title', match: 'minecraft' }], by: 'rule', version: 'test' }],
      topics: ['kpop', 'minecraft'],
      language: 'ko',
      sponsorship: { level: 'disclosed', brands: ['BrandX'], evidence: [{ field: 'description', match: '유료 광고' }], version: 'test' },
    }),
    makeVideo({
      id: 'dailymotion:dm1',
      platform: 'dailymotion',
      title: 'News clip',
      accountId: 'dailymotion:dmacc1',
      publishedAt: ts('2026-06-01T00:00:00Z'),
      obs: [makeObs(NOW, 50_000, 120, null, null, 'dailymotion@1')],
      sourceWindows: [
        makeSourceWindow('views', 24, 700, NOW, 'dailymotion@1'),
        makeSourceWindow('views', 168, 4_200, NOW, 'dailymotion@1'),
        makeSourceWindow('views', 720, 12_000, NOW, 'dailymotion@1'),
      ],
      categories: [{ id: 'news_politics', confidence: 0.9, evidence: [{ field: 'sourceCategory', match: 'news' }], by: 'source', version: 'test' }],
      sourceCategory: 'news',
    }),
    makeVideo({
      id: 'niconico:sm1',
      platform: 'niconico',
      title: '初音ミク 新曲',
      accountId: 'niconico:user1',
      publishedAt: ts('2026-09-26T00:00:00Z'),
      obs: [makeObs(NOW - 2 * HOUR_MS, 9_000, 800, 300, null, 'niconico@1')],
      topics: ['vocaloid'],
      language: 'ja',
    }),
  ];
  const accounts = [
    makeAccount({
      id: 'youtube:ch1',
      name: '뷰티 채널',
      creatorId: 'creator-a',
      followers: [
        { t: ts('2026-09-01T00:00:00Z'), value: 10_000, src: 'youtube-rss@1' },
        { t: NOW, value: 12_000, src: 'youtube-rss@1' },
      ],
    }),
    makeAccount({ id: 'youtube:ch2', name: 'Game Lab' }),
    makeAccount({ id: 'dailymotion:dmacc1', platform: 'dailymotion', name: 'Beauty DM', creatorId: 'creator-a' }),
    makeAccount({ id: 'niconico:user1', platform: 'niconico', name: 'ミク職人' }),
  ];
  const coverage: SourceCoverage[] = [
    {
      source: 'youtube-rss',
      platform: 'youtube',
      label: 'YouTube RSS',
      enabled: true,
      requiresCredentials: false,
      discovery: '시드 채널 RSS',
      metrics: ['views', 'likes'],
      firstRunAt: ts('2026-09-01T00:00:00Z'),
      lastRunAt: NOW,
      lastSuccessAt: NOW,
      lastStatus: 'ok',
      lastError: null,
      videoCount: 3,
      accountCount: 2,
      notes: [],
      docsUrl: null,
    },
  ];
  return makeDataset({
    generatedAt,
    classifierVersion: 'test',
    videos,
    accounts,
    creators: [{ id: 'creator-a', name: '크리에이터 A', accountIds: ['youtube:ch1', 'dailymotion:dmacc1'], linkStatus: 'verified', note: null }],
    coverage,
    runs: [
      { id: 'run-1', startedAt: NOW - HOUR_MS, finishedAt: NOW - HOUR_MS / 2, source: 'youtube-rss', status: 'ok', videosSeen: 3, videosNew: 0, observations: 3, requests: 2, errors: [] },
    ],
    exportNotes: ['테스트 데이터셋'],
  });
}

export function fixtureIndex(generatedAt: number = NOW): DatasetIndex {
  return buildIndex(fixtureDataset(generatedAt));
}

export function fixtureCompactJson(generatedAt: number = NOW): string {
  return JSON.stringify(encodeDataset(fixtureDataset(generatedAt)));
}
