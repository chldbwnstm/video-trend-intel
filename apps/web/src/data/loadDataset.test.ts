import { describe, expect, it } from 'vitest';
import { encodeDataset } from '@vti/core';
import type { Dataset } from '@vti/core';
import { DATASET_URL, loadDataset, parseDatasetText, SAMPLE_URL } from './loadDataset.ts';
import type { FetchLike } from './loadDataset.ts';

function tinyDataset(generatedAt = Date.UTC(2026, 8, 28)): Dataset {
  return {
    schemaVersion: 1,
    generatedAt,
    classifierVersion: 'test',
    videos: [
      {
        id: 'youtube:a',
        platform: 'youtube',
        platformId: 'a',
        url: 'https://example.com/a',
        title: '테스트 영상',
        description: null,
        thumbnail: null,
        publishedAt: generatedAt - 86_400_000,
        durationSec: 60,
        format: 'short',
        accountId: 'youtube:acc',
        language: 'ko',
        languageSource: 'detected',
        country: 'KR',
        sourceCategory: null,
        tags: [],
        categories: [],
        topics: [],
        sponsorship: null,
        status: 'active',
        firstSeenAt: generatedAt - 3_600_000,
        lastObservedAt: generatedAt,
        discoveredVia: ['test'],
        obs: [
          { t: generatedAt, views: 200, likes: null, comments: 1, shares: null, src: 'b@1' },
          { t: generatedAt - 3_600_000, views: 100, likes: null, comments: null, shares: null, src: 'a@1' },
        ],
        sourceWindows: [{ metric: 'views', windowHours: 24, value: 150, observedAt: generatedAt, src: 'a@1' }],
      },
    ],
    accounts: [],
    creators: [],
    coverage: [],
    runs: [],
    exportNotes: [],
  };
}

type Resp = { status: number; body: string; type?: string } | Error;

function fakeFetch(routes: Record<string, Resp>): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(url);
    const r = routes[url] ?? { status: 404, body: 'not found', type: 'text/plain' };
    if (r instanceof Error) throw r;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? (r.type ?? 'application/json') : null) },
      text: async () => r.body,
    };
  }) as FetchLike & { calls: string[] };
  fn.calls = calls;
  return fn;
}

const compactJson = (ds: Dataset) => JSON.stringify(encodeDataset(ds));

describe('parseDatasetText', () => {
  it('decodes the compact format and sorts observations', () => {
    const ds = parseDatasetText(compactJson(tinyDataset()));
    expect(ds.videos).toHaveLength(1);
    expect(ds.videos[0].obs.map((o) => o.views)).toEqual([100, 200]);
    expect(ds.videos[0].obs[0].likes).toBeNull();
    expect(ds.videos[0].sourceWindows[0].value).toBe(150);
  });
  it('accepts an expanded Dataset and normalizes missing optional arrays', () => {
    const raw = tinyDataset();
    const { creators: _c, coverage: _cv, runs: _r, exportNotes: _e, ...rest } = raw;
    const ds = parseDatasetText(JSON.stringify(rest));
    expect(ds.creators).toEqual([]);
    expect(ds.coverage).toEqual([]);
    expect(ds.exportNotes).toEqual([]);
    expect(ds.videos[0].obs[0].t).toBeLessThan(ds.videos[0].obs[1].t);
  });
  it('rejects invalid JSON, wrong schema and missing fields with Korean messages', () => {
    expect(() => parseDatasetText('{oops')).toThrow(/JSON 파싱 실패/);
    expect(() => parseDatasetText('[]')).toThrow(/객체가 아님/);
    expect(() => parseDatasetText(JSON.stringify({ schemaVersion: 2, generatedAt: 1, videos: [], accounts: [] }))).toThrow(/schemaVersion/);
    expect(() => parseDatasetText(JSON.stringify({ schemaVersion: 1, videos: [], accounts: [] }))).toThrow(/generatedAt/);
    expect(() => parseDatasetText(JSON.stringify({ schemaVersion: 1, generatedAt: 1, accounts: [] }))).toThrow(/videos/);
    expect(() => parseDatasetText(JSON.stringify({ schemaVersion: 1, generatedAt: 1, videos: [{}], accounts: [], srcTable: [] }))).toThrow(/관측값/);
    expect(() => parseDatasetText(JSON.stringify({ schemaVersion: 1, generatedAt: 1, videos: [{}], accounts: [] }))).toThrow(/srcTable/);
  });
});

describe('loadDataset', () => {
  it('uses the real dataset when present (never the sample)', async () => {
    const f = fakeFetch({ [DATASET_URL]: { status: 200, body: compactJson(tinyDataset()) } });
    const out = await loadDataset(f);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.isSample).toBe(false);
    expect(out.url).toBe(DATASET_URL);
    expect(out.fallbackReason).toBeNull();
    expect(out.bytes).toBeGreaterThan(100);
    expect(f.calls).toEqual([DATASET_URL]);
  });

  it('falls back to the sample on 404 and explains why', async () => {
    const f = fakeFetch({ [SAMPLE_URL]: { status: 200, body: compactJson(tinyDataset()) } });
    const out = await loadDataset(f);
    expect(out.ok && out.isSample).toBe(true);
    if (!out.ok) return;
    expect(out.url).toBe(SAMPLE_URL);
    expect(out.fallbackReason).toContain('HTTP 404');
    expect(f.calls).toEqual([DATASET_URL, SAMPLE_URL]);
  });

  it('treats an SPA HTML fallback page as missing', async () => {
    const html = '<!doctype html><html><body>app</body></html>';
    for (const variant of [
      { status: 200, body: html, type: 'text/html; charset=utf-8' },
      { status: 200, body: `  ${html}`, type: 'application/octet-stream' },
    ]) {
      const f = fakeFetch({ [DATASET_URL]: variant, [SAMPLE_URL]: { status: 200, body: compactJson(tinyDataset()) } });
      const out = await loadDataset(f);
      expect(out.ok && out.isSample).toBe(true);
      if (out.ok) expect(out.fallbackReason).toContain('HTML');
    }
  });

  it('treats a network error on the real file as missing', async () => {
    const f = fakeFetch({ [DATASET_URL]: new TypeError('Failed to fetch'), [SAMPLE_URL]: { status: 200, body: compactJson(tinyDataset()) } });
    const out = await loadDataset(f);
    expect(out.ok && out.isSample).toBe(true);
    if (out.ok) expect(out.fallbackReason).toContain('네트워크 오류');
  });

  it('does NOT silently switch to the sample when the real file is broken', async () => {
    const f = fakeFetch({ [DATASET_URL]: { status: 200, body: '{"schemaVersion":1,' }, [SAMPLE_URL]: { status: 200, body: compactJson(tinyDataset()) } });
    const out = await loadDataset(f);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.kind).toBe('invalid');
    expect(out.canUseSample).toBe(true);
    expect(f.calls).toEqual([DATASET_URL]);
  });

  it('reports non-JSON text as invalid', async () => {
    const f = fakeFetch({ [DATASET_URL]: { status: 200, body: 'hello', type: 'text/plain' } });
    const out = await loadDataset(f);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.kind).toBe('invalid');
  });

  it('loads the sample on explicit request without touching the real file', async () => {
    const f = fakeFetch({ [DATASET_URL]: { status: 200, body: compactJson(tinyDataset()) }, [SAMPLE_URL]: { status: 200, body: compactJson(tinyDataset(5)) } });
    const out = await loadDataset(f, { forceSample: true });
    expect(out.ok && out.isSample).toBe(true);
    if (out.ok) expect(out.dataset.generatedAt).toBe(5);
    expect(f.calls).toEqual([SAMPLE_URL]);
  });

  it('fails with "unavailable" when neither file exists', async () => {
    const f = fakeFetch({});
    const out = await loadDataset(f);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.kind).toBe('unavailable');
    expect(out.canUseSample).toBe(false);
    expect(out.message).toContain('HTTP 404');
  });

  it('honors custom URLs', async () => {
    const f = fakeFetch({ '/api/dataset.json': { status: 200, body: compactJson(tinyDataset()) } });
    const out = await loadDataset(f, { datasetUrl: '/api/dataset.json', sampleUrl: '/nope.json' });
    expect(out.ok && !out.isSample).toBe(true);
  });

  it('propagates aborts', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const f: FetchLike = async () => {
      throw new DOMException('aborted', 'AbortError');
    };
    await expect(loadDataset(f, { signal: ctrl.signal })).rejects.toThrow(/aborted/);
  });
});
