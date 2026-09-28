import { describe, expect, it } from 'vitest';
import { encodeDataset, decodeDataset, buildIndex } from '../src/index.ts';
import type { CompactDataset, Dataset, Video } from '../src/index.ts';
import { makeObs, makeVideo, ts } from './fixtures.ts';

const empty = (): Dataset => ({
  schemaVersion: 1,
  generatedAt: 1,
  classifierVersion: 'rules-x',
  videos: [],
  accounts: [],
  creators: [],
  coverage: [],
  runs: [],
  exportNotes: [],
});

function roundTrip(ds: Dataset): Dataset {
  return decodeDataset(JSON.parse(JSON.stringify(encodeDataset(ds))) as CompactDataset);
}

describe('dataset codec', () => {
  it('round-trips an empty dataset', () => {
    const ds = empty();
    expect(roundTrip(ds)).toEqual(ds);
    expect(buildIndex(ds).videosById.size).toBe(0);
  });

  it('round-trips observations with nulls, zeros, decreases and mixed sources (format 2)', () => {
    const t0 = ts('2026-09-20T00:00:00Z');
    const v: Video = makeVideo({
      id: 'youtube:a',
      obs: [
        { ...makeObs(t0, 100, null, null, null), src: 'youtube-rss@1' },
        { ...makeObs(t0 + 3_600_000, 150, 0, null, null), src: 'youtube-rss@1' },
        { ...makeObs(t0 + 7_200_000, 140, null, 5, null), src: 'youtube-data-api@1' },
        { ...makeObs(t0 + 10_800_000, null, 7, 5, null), src: 'youtube-rss@1' },
        { ...makeObs(t0 + 14_400_000, 1_000_000_000, 8, 6, null), src: 'youtube-rss@1' },
      ],
      categories: [
        { id: 'music', confidence: 0.9, evidence: [{ field: 'sourceCategory', match: 'dailymotion:music' }], by: 'source', version: 'rules-x' },
        { id: 'music/kpop', confidence: 0.632, evidence: [{ field: 'title', match: 'k|pop' }, { field: 'tags', match: '케이팝' }], by: 'rule', version: 'rules-old' },
      ],
      sourceWindows: [{ metric: 'views', windowHours: 168, value: 42, observedAt: t0, src: 'dailymotion@1' }],
    });
    const ds = { ...empty(), videos: [v] };
    const enc = encodeDataset(ds);
    expect(enc.format).toBe(2);
    // shares never provided -> the whole column is null (not zeros)
    expect((enc.videos[0].o as unknown[])[4]).toBeNull();
    const back = roundTrip(ds);
    expect(back.videos[0].obs).toEqual(v.obs);
    expect(back.videos[0].categories).toEqual(v.categories);
    expect(back.videos[0].sourceWindows).toEqual(v.sourceWindows);
    expect(back).toEqual(ds);
  });

  it('stores a single src index when every point shares it', () => {
    const v = makeVideo({ id: 'dailymotion:x', obs: [makeObs(1_000_000, 1), makeObs(2_000_000, 2), makeObs(3_000_000, 3)] });
    const enc = encodeDataset({ ...empty(), videos: [v] });
    expect((enc.videos[0].o as unknown[][])[5]).toHaveLength(1);
    expect(roundTrip({ ...empty(), videos: [v] }).videos[0].obs).toEqual(v.obs);
  });

  it('still decodes format 1 (tuples + category objects)', () => {
    const legacy = {
      schemaVersion: 1,
      generatedAt: 5,
      classifierVersion: 'rules-x',
      srcTable: ['youtube-rss@1'],
      videos: [
        {
          ...makeVideo({ id: 'youtube:b', obs: [] }),
          obs: undefined,
          sourceWindows: undefined,
          o: [[1000, 10, null, null, null, 0], [2000, 20, 1, null, null, 0]],
        },
      ],
      accounts: [],
      creators: [],
      coverage: [],
      runs: [],
      exportNotes: [],
    } as unknown as CompactDataset;
    const ds = decodeDataset(legacy);
    expect(ds.videos[0].obs).toEqual([
      { t: 1_000_000, views: 10, likes: null, comments: null, shares: null, src: 'youtube-rss@1' },
      { t: 2_000_000, views: 20, likes: 1, comments: null, shares: null, src: 'youtube-rss@1' },
    ]);
  });

  it('rejects unknown formats', () => {
    expect(() => decodeDataset({ ...encodeDataset(empty()), format: 3 as unknown as 2 })).toThrow(/format/);
  });
});
