import { describe, expect, it } from 'vitest';
import type { CollectionRun, SourceCoverage } from '@vti/core';
import { makeDataset, makeObs, makeVideo, ts } from '../../../../packages/core/test/fixtures.ts';
import { adapterOf, collectionStartText, collectionTimeline, hasSnapshotLead, sourceShortLabel } from './collection.ts';

function run(source: string, startedAt: string, finishedAt: string | null): CollectionRun {
  return {
    id: `${source}-${startedAt}`,
    source,
    startedAt: ts(startedAt),
    finishedAt: finishedAt === null ? null : ts(finishedAt),
    status: 'ok',
    videosSeen: 0,
    videosNew: 0,
    observations: 0,
    requests: 0,
    errors: [],
  };
}

function cov(source: string, label: string, over: Partial<SourceCoverage> = {}): SourceCoverage {
  return {
    source,
    platform: 'niconico',
    label,
    enabled: true,
    requiresCredentials: false,
    discovery: '',
    metrics: ['views'],
    firstRunAt: null,
    lastRunAt: null,
    lastSuccessAt: null,
    lastStatus: 'ok',
    lastError: null,
    videoCount: 0,
    accountCount: 0,
    notes: [],
    docsUrl: null,
    ...over,
  };
}

/** Shape of the live export: collection started 15:13Z; niconico observations carry the 22:08Z snapshot time of the day before. */
function liveLike() {
  return makeDataset({
    generatedAt: ts('2026-09-28T15:26:16Z'),
    videos: [
      makeVideo({ id: 'youtube:a', firstSeenAt: ts('2026-09-28T15:13:23Z'), obs: [makeObs('2026-09-28T15:13:23Z', 10, null, null, null, 'youtube-rss@1')] }),
      makeVideo({ id: 'niconico:b', firstSeenAt: ts('2026-09-28T15:18:48Z'), obs: [makeObs('2026-09-27T22:08:32Z', 5, null, null, null, 'niconico@1')] }),
    ],
    runs: [
      run('youtube-rss', '2026-09-28T15:13:23Z', '2026-09-28T15:16:38Z'),
      run('niconico', '2026-09-28T15:18:48Z', '2026-09-28T15:19:15Z'),
      // Second round: re-observation with no new points, finishing after generatedAt.
      run('niconico', '2026-09-28T15:28:11Z', '2026-09-28T15:28:38Z'),
    ],
    coverage: [cov('niconico', 'niconico (스냅샷 검색 API)', { firstRunAt: ts('2026-09-28T15:18:48Z'), lastRunAt: ts('2026-09-28T15:28:11Z'), lastSuccessAt: ts('2026-09-28T15:28:11Z') })],
  });
}

describe('collectionTimeline', () => {
  it('separates the collection start from earlier snapshot-stamped observations', () => {
    const t = collectionTimeline(liveLike());
    expect(t.collectionStartAt).toBe(ts('2026-09-28T15:13:23Z'));
    expect(t.firstObservationAt).toBe(ts('2026-09-27T22:08:32Z'));
    expect(t.firstObservationSource).toBe('niconico');
    expect(t.lastObservationAt).toBe(ts('2026-09-28T15:13:23Z'));
    expect(hasSnapshotLead(t)).toBe(true);
  });

  it('reaches the last run finish even when it is after generatedAt (freshness reference)', () => {
    expect(collectionTimeline(liveLike()).collectedUntil).toBe(ts('2026-09-28T15:28:38Z'));
    const bare = makeDataset({ generatedAt: ts('2026-09-28T00:00:00Z') });
    expect(collectionTimeline(bare).collectedUntil).toBe(ts('2026-09-28T00:00:00Z'));
  });

  it('falls back to first-seen times and then to observations when there are no runs', () => {
    const ds = makeDataset({ videos: [makeVideo({ id: 'youtube:x', obs: [makeObs('2026-09-10T00:00:00Z', 1)] })] });
    expect(collectionTimeline(ds).collectionStartAt).toBe(ts('2026-09-10T00:00:00Z'));
    expect(collectionTimeline(makeDataset()).collectionStartAt).toBeNull();
    expect(collectionTimeline(makeDataset()).firstObservationAt).toBeNull();
  });

  it('is cached per dataset object', () => {
    const ds = liveLike();
    expect(collectionTimeline(ds)).toBe(collectionTimeline(ds));
  });
});

describe('collectionStartText', () => {
  it('names both instants explicitly, in the display zone', () => {
    const ds = liveLike();
    const t = collectionTimeline(ds);
    expect(collectionStartText(t, 'Asia/Seoul', (s) => sourceShortLabel(ds.coverage, s))).toBe(
      '수집 시작 2026-09-29 00:13 KST (niconico 관측은 원천 스냅샷 시각 기준이라 2026-09-28 07:08부터 있음)',
    );
    expect(collectionStartText(t, 'UTC')).toContain('수집 시작 2026-09-28 15:13 UTC');
  });

  it('shows only the collection start when no observation precedes it', () => {
    const ds = makeDataset({ videos: [makeVideo({ id: 'youtube:x', firstSeenAt: ts('2026-09-28T15:13:00Z'), obs: [makeObs('2026-09-28T15:13:00Z', 1)] })] });
    expect(collectionStartText(collectionTimeline(ds), 'Asia/Seoul')).toBe('수집 시작 2026-09-29 00:13 KST');
    expect(collectionStartText(collectionTimeline(makeDataset()), 'Asia/Seoul')).toBe('수집 기록 없음');
  });

  it('adapterOf / sourceShortLabel', () => {
    expect(adapterOf('niconico@1')).toBe('niconico');
    expect(adapterOf('plain')).toBe('plain');
    expect(sourceShortLabel([cov('peertube', 'PeerTube (SepiaSearch)')], 'peertube')).toBe('PeerTube');
    expect(sourceShortLabel([], 'x-api')).toBe('x-api');
  });
});
