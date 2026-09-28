import { describe, expect, it } from 'vitest';
import { queryVideos, rollingWindow, HOUR } from '../src/index.ts';
import { makeIndex, makeObs, makeSourceWindow, makeVideo, ts } from './fixtures.ts';

const NOW = ts('2026-09-28T12:00:00Z');

describe('rolling windows', () => {
  it('ends exactly at now and is never incomplete', () => {
    const w = rollingWindow(24, NOW, 'Asia/Seoul');
    expect(w).toEqual({ startMs: NOW - 24 * HOUR, endMs: NOW, tz: 'Asia/Seoul', incomplete: false });
    expect(() => rollingWindow(0, NOW, 'UTC')).toThrow(RangeError);
  });

  it('uses our observations when both boundaries are observed', () => {
    const v = makeVideo({
      id: 'dailymotion:a',
      platform: 'dailymotion',
      publishedAt: ts('2026-09-01T00:00:00Z'),
      obs: [makeObs(NOW - 24 * HOUR, 1000), makeObs(NOW, 1600)],
    });
    const r = queryVideos(makeIndex({ videos: [v], generatedAt: NOW }), {
      dateMode: 'activity',
      rollingHours: 24,
      tz: 'Asia/Seoul',
      sort: 'views_period',
      now: NOW,
    });
    expect(r.window?.endMs).toBe(NOW);
    expect(r.rows[0].metrics.viewsPeriod).toMatchObject({ value: 600, status: 'exact' });
  });

  it('falls back to a source-reported window of the same length', () => {
    const v = makeVideo({
      id: 'dailymotion:b',
      platform: 'dailymotion',
      publishedAt: ts('2026-01-01T00:00:00Z'),
      obs: [makeObs(NOW, 50_000)],
      sourceWindows: [makeSourceWindow('views', 168, 4_200, NOW)],
    });
    const r = queryVideos(makeIndex({ videos: [v], generatedAt: NOW }), {
      dateMode: 'activity',
      rollingHours: 168,
      tz: 'Asia/Seoul',
      sort: 'views_period',
      now: NOW,
    });
    expect(r.rows[0].metrics.viewsPeriod).toMatchObject({ value: 4_200, status: 'source_reported' });
  });
});
