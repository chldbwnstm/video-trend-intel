/**
 * Hook behavior under server rendering (no DOM): reading URL state, range resolution, analytics caching
 * and error capture. Setter logic is covered by nextSearchFor in lib/urlState.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { buildIndex, presetRange } from '@vti/core';
import type { DateMode, Platform } from '@vti/core';
import { makeDataset, makeVideo, ts } from '../../../../packages/core/test/fixtures.ts';
import { DatasetContext } from './context.ts';
import type { DatasetContextValue } from './context.ts';
import { useAnalysis, useDataset, useGlobalFilters, useOptionalDataset, useRangeParam, useTz, useUrlParams, useUrlState } from './hooks.ts';
import { dateModeCodec, platformListCodec } from '../lib/urlState.ts';

const NOW = ts('2026-09-28T03:00:00Z');

function ctx(overrides: Partial<DatasetContextValue> = {}): DatasetContextValue {
  const dataset = makeDataset({ generatedAt: NOW, videos: [makeVideo({ id: 'youtube:a' }), makeVideo({ id: 'tiktok:b' })] });
  return {
    dataset,
    index: buildIndex(dataset),
    now: NOW,
    isSample: true,
    tz: 'Asia/Seoul',
    setTz: () => undefined,
    source: { url: './data/sample.json', bytes: 1, fallbackReason: null, loadedAt: 0 },
    reload: () => undefined,
    ...overrides,
  };
}

function renderAt(url: string, el: ReactElement, value: DatasetContextValue | null = ctx()): string {
  const tree = h(MemoryRouter, { initialEntries: [url] }, el);
  return renderToStaticMarkup(value ? h(DatasetContext.Provider, { value }, tree) : tree);
}

describe('useDataset / useOptionalDataset / useTz / useGlobalFilters', () => {
  it('throws a helpful error outside the provider', () => {
    function Probe() {
      useDataset();
      return null;
    }
    expect(() => renderAt('/', h(Probe), null)).toThrow(/DatasetProvider/);
  });
  it('optional variants work without the provider', () => {
    function Probe() {
      return h('span', null, `${useOptionalDataset() === null}|${useTz()}`);
    }
    expect(renderAt('/', h(Probe), null)).toBe('<span>true|Asia/Seoul</span>');
  });
  it('exposes global filters', () => {
    function Probe() {
      const g = useGlobalFilters();
      return h('span', null, `${g.tz}|${g.now}|${g.isSample}|${g.tzOptions.map((o) => o.id).join(',')}`);
    }
    expect(renderAt('/', h(Probe), ctx({ tz: 'Australia/Sydney' }))).toBe(`<span>Australia/Sydney|${NOW}|true|Asia/Seoul,Australia/Sydney,UTC</span>`);
  });
});

describe('useUrlState (read side)', () => {
  function Probe() {
    const [mode] = useUrlState<DateMode>('mode', 'activity', { codec: dateModeCodec });
    const [platforms] = useUrlState<Platform[]>('platforms', [], { codec: platformListCodec });
    const [page] = useUrlState('page', 1);
    const [q] = useUrlState('q', '');
    const [flag] = useUrlState('flag', false);
    return h('span', null, JSON.stringify({ mode, platforms, page, q, flag }));
  }
  it('uses defaults when keys are missing', () => {
    expect(renderAt('/videos', h(Probe))).toContain(JSON.stringify({ mode: 'activity', platforms: [], page: 1, q: '', flag: false }).replace(/"/g, '&quot;'));
  });
  it('parses values and drops invalid ones', () => {
    const html = renderAt('/videos?mode=upload&platforms=youtube,myspace,tiktok&page=3&q=%EC%B6%94%EC%84%9D&flag=1', h(Probe));
    expect(html).toContain(JSON.stringify({ mode: 'upload', platforms: ['youtube', 'tiktok'], page: 3, q: '추석', flag: true }).replace(/"/g, '&quot;'));
  });
  it('falls back to defaults for garbage', () => {
    const html = renderAt('/videos?mode=views&page=abc', h(Probe));
    expect(html).toContain('&quot;mode&quot;:&quot;activity&quot;');
    expect(html).toContain('&quot;page&quot;:1');
  });
  it('useUrlParams exposes the raw params', () => {
    function P() {
      const [params] = useUrlParams();
      return h('span', null, params.get('x') ?? 'none');
    }
    expect(renderAt('/a?x=1', h(P))).toBe('<span>1</span>');
  });
});

describe('useRangeParam', () => {
  function Probe() {
    const r = useRangeParam();
    return h('span', null, `${r.spec}|${r.preset}|${r.range.start}|${r.range.end}`);
  }
  it('defaults to last7d resolved in the context tz and data now', () => {
    const expected = presetRange('last7d', 'Asia/Seoul', NOW);
    expect(renderAt('/', h(Probe))).toBe(`<span>last7d|last7d|${expected.start}|${expected.end}</span>`);
  });
  it('accepts custom inclusive ranges', () => {
    expect(renderAt('/?range=2026-09-01..2026-09-07', h(Probe))).toBe('<span>2026-09-01..2026-09-07|null|2026-09-01|2026-09-07</span>');
  });
  it('falls back on invalid specs', () => {
    expect(renderAt('/?range=2026-09-07..2026-09-01', h(Probe))).toContain('last7d|last7d');
  });
});

describe('useAnalysis', () => {
  it('computes with the input, caches per index and name, and is not stale on first render', () => {
    let calls = 0;
    const value = ctx();
    function Probe({ n }: { n: number }) {
      const r = useAnalysis('test.count', { n }, (index, input) => {
        calls++;
        return index.videosById.size * input.n;
      });
      return h('span', null, `${r.data}|${r.error === null}|${r.isStale}`);
    }
    expect(renderAt('/', h(Probe, { n: 3 }), value)).toBe('<span>6|true|false</span>');
    expect(renderAt('/', h(Probe, { n: 3 }), value)).toBe('<span>6|true|false</span>');
    expect(calls).toBe(1); // second render hit the per-index cache
    expect(renderAt('/', h(Probe, { n: 5 }), value)).toBe('<span>10|true|false</span>');
    expect(calls).toBe(2);
    renderAt('/', h(Probe, { n: 3 }), ctx()); // a new index (reloaded dataset) recomputes
    expect(calls).toBe(3);
  });
  it('captures errors instead of throwing', () => {
    function Probe() {
      const r = useAnalysis('test.fail', {}, () => {
        throw new Error('not implemented');
      });
      return h('span', null, `${r.data === undefined}|${r.error?.message}`);
    }
    expect(renderAt('/', h(Probe))).toBe('<span>true|not implemented</span>');
  });
});
