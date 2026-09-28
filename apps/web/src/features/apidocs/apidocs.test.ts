/**
 * API page: spec consistency (endpoints / params / examples / static files) and the server-rendered page.
 */
import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { buildIndex, RANGE_PRESETS } from '@vti/core';
import { DatasetContext } from '../../data/context.ts';
import type { DatasetContextValue } from '../../data/context.ts';
import { generateSampleDataset } from '../../../scripts/sample-generator.ts';
import ApiDocsPage from '../../pages/ApiDocs.tsx';
import { API_PREFIX, curlCommand, ENDPOINTS, LIVE_STATIC_API, LOCAL_SERVER, STATIC_FILES, liveStaticUrl } from './apiSpec.ts';
import { CodeBlock } from './ApiDocsParts.tsx';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');

describe('API spec', () => {
  it('documents every endpoint of the server', () => {
    const paths = ENDPOINTS.map((e) => e.path);
    for (const p of ['health', 'meta', 'videos', 'videos/{id}', 'trending', 'explore', 'creators', 'creators/{key}', 'taxonomy', 'coverage', 'dataset', 'openapi.json']) {
      expect(paths).toContain(`${API_PREFIX}/${p}`);
    }
    expect(new Set(ENDPOINTS.map((e) => e.id)).size).toBe(ENDPOINTS.length);
  });

  it('gives every endpoint at least one well-formed example against the local server', () => {
    for (const ep of ENDPOINTS) {
      expect(ep.examples.length).toBeGreaterThan(0);
      for (const ex of ep.examples) {
        const url = new URL(ex.url);
        expect(url.origin).toBe(LOCAL_SERVER);
        expect(url.pathname.startsWith(API_PREFIX)).toBe(true);
        const cmd = curlCommand(ex);
        expect(cmd.startsWith('curl -s')).toBe(true);
        expect(cmd).toContain(ex.url);
      }
      const names = ep.params.map((p) => p.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it('only uses range presets core knows in examples', () => {
    for (const ep of ENDPOINTS) {
      for (const ex of ep.examples) {
        const range = new URL(ex.url).searchParams.get('range');
        if (range) expect(RANGE_PRESETS).toContain(range);
      }
    }
  });

  it('builds static URLs under the live site', () => {
    expect(LIVE_STATIC_API).toBe('https://chldbwnstm.github.io/video-trend-intel/api/v1/');
    for (const f of STATIC_FILES) {
      const url = new URL(liveStaticUrl(f.example));
      expect(url.href.startsWith(LIVE_STATIC_API)).toBe(true);
      expect(url.pathname.endsWith('.json')).toBe(true);
    }
  });

  it('quotes URLs safely in curl commands', () => {
    expect(curlCommand({ title: 't', url: 'http://localhost:8787/api/v1/videos?a=1&b=2' })).toBe("curl -s 'http://localhost:8787/api/v1/videos?a=1&b=2'");
    expect(curlCommand({ title: 't', url: 'http://x/y', flags: '-o f.csv', pipe: '| jq .' })).toBe("curl -s -o f.csv 'http://x/y' | jq .");
  });
});

describe('ApiDocsPage', () => {
  const dataset = generateSampleDataset({ videos: 50 });
  const value: DatasetContextValue = {
    dataset,
    index: buildIndex(dataset),
    now: dataset.generatedAt,
    isSample: true,
    tz: 'Asia/Seoul',
    setTz: () => undefined,
    source: { url: './data/sample.json', bytes: 0, fallbackReason: null, loadedAt: 0 },
    reload: () => undefined,
  };
  const html = renderToStaticMarkup(
    h(DatasetContext.Provider, { value }, h(MemoryRouter, { initialEntries: ['/api-docs'] }, h(Routes, null, h(Route, { path: '/api-docs', element: h(ApiDocsPage) })))),
  );
  const t = text(html);

  it('shows both API flavours with their base URLs', () => {
    expect(t).toContain('API');
    expect(t).toContain('https://chldbwnstm.github.io/video-trend-intel/api/v1/');
    expect(t).toContain('http://localhost:8787/api/v1');
    expect(t).toContain('정적 JSON');
    expect(t).toContain('REST');
  });

  it('documents MetricValue status semantics, every endpoint and curl examples', () => {
    for (const s of ['exact', 'interpolated', 'lower_bound', 'source_reported', 'unavailable', 'decrease_flagged']) expect(t).toContain(s);
    for (const ep of ENDPOINTS) expect(t).toContain(ep.path);
    expect(t).toContain("curl -s 'http://localhost:8787/api/v1/videos?mode=activity&range=rolling7d");
    expect(t).toContain('format=csv');
    expect(t).toContain('videos/activity/top-rolling7d-all.json');
    expect(t).toContain('trending/topic-rolling7d.json');
  });

  it('renders code as text', () => {
    const out = renderToStaticMarkup(h(CodeBlock, { code: '<script>alert(1)</script>', label: 'x' }));
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
  });
});
