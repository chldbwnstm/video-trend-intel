import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateStaticApi, parseCliArgs, serializeStatic, writeStaticApi } from '../src/static-api.ts';
import { createApp } from '../src/app.ts';
import { fixtureIndex, NOW } from './fixtures.ts';

describe('static API', () => {
  it('produces the documented files in sorted order', () => {
    const files = generateStaticApi(fixtureIndex());
    const paths = files.map((f) => f.path);
    expect(paths).toEqual([...paths].sort());
    for (const p of [
      'meta.json',
      'coverage.json',
      'taxonomy.json',
      'openapi.json',
      'videos/activity/top-last7d-all.json',
      'videos/activity/top-last30d-youtube.json',
      'videos/activity/top-rolling7d-dailymotion.json',
      'videos/upload/top-last7d-niconico.json',
      'videos/upload/top-rolling30d-all.json',
      'trending/topic-last7d.json',
      'trending/category-rolling7d.json',
      'trending/creator-last7d.json',
      'trending/account-last7d.json',
      'creators/top-last30d.json',
      'creators/top-rolling30d.json',
    ]) {
      expect(paths, p).toContain(p);
    }
    // platforms without videos get no files
    expect(paths.some((p) => p.includes('-tiktok'))).toBe(false);
    // 4 + 2 modes x 4 presets x (all + 3 platforms) + 4 kinds x 2 presets + 2
    expect(files).toHaveLength(4 + 2 * 4 * 4 + 8 + 2);
  });

  it('top-video files have compact rows with value/status/asOf metrics', () => {
    const files = generateStaticApi(fixtureIndex(), { limit: 2 });
    const f = files.find((x) => x.path === 'videos/activity/top-rolling7d-all.json')!.data as any;
    expect(f).toMatchObject({ generatedAt: NOW, tz: 'Asia/Seoul', total: 5 });
    expect(f.query).toMatchObject({ mode: 'activity', platform: 'all', sort: 'views_period', limit: 2 });
    expect(f.query.range).toMatchObject({ spec: 'rolling7d', rollingHours: 168 });
    expect(f.window).toMatchObject({ endMs: NOW, rollingHours: 168 });
    expect(f.rows).toHaveLength(2);
    const row = f.rows[0];
    expect(Object.keys(row)).toEqual(['rank', 'id', 'platform', 'url', 'title', 'thumbnail', 'account', 'publishedAt', 'metrics']);
    expect(row).toMatchObject({ rank: 1, id: 'youtube:yt3', platform: 'youtube', account: { id: 'youtube:ch2', name: 'Game Lab' } });
    expect(Object.keys(row.metrics)).toEqual(['viewsTotal', 'viewsPeriod', 'likesPeriod', 'commentsPeriod', 'engagementRate', 'percentile']);
    expect(Object.keys(row.metrics.viewsPeriod)).toEqual(['value', 'status', 'asOf']);
    expect(row.metrics.viewsPeriod.status).toBe('exact');
    const up = files.find((x) => x.path === 'videos/upload/top-last7d-all.json')!.data as any;
    expect(up.query.sort).toBe('views_total');
    expect(up.notes[0]).toContain('업로드 기간 기준');
    const dm = files.find((x) => x.path === 'videos/activity/top-rolling7d-dailymotion.json')!.data as any;
    expect(dm.rows[0].metrics.viewsPeriod).toEqual({ value: 4_200, status: 'source_reported', asOf: NOW });
    const creators = files.find((x) => x.path === 'creators/top-last30d.json')!.data as any;
    expect(creators.rows[0].key).toBeDefined();
    expect(creators.total).toBe(3);
  });

  it('is deterministic', () => {
    const a = generateStaticApi(fixtureIndex()).map((f) => [f.path, serializeStatic(f.data)]);
    const b = generateStaticApi(fixtureIndex()).map((f) => [f.path, serializeStatic(f.data)]);
    expect(b).toEqual(a);
  });

  describe('writeStaticApi', () => {
    let out: string;
    beforeEach(() => {
      out = mkdtempSync(join(tmpdir(), 'vti-static-'));
    });
    afterEach(() => {
      rmSync(out, { recursive: true, force: true });
    });

    it('writes files + index.json and removes only stale files from a previous run', () => {
      writeFileSync(join(out, 'keep-me.txt'), 'not ours');
      writeFileSync(join(out, 'old.json'), '{}');
      writeFileSync(join(out, 'index.json'), JSON.stringify({ files: [{ path: 'old.json' }, { path: '../outside.json' }, { path: 'meta.json' }] }));
      const res = writeStaticApi(fixtureIndex(), out, { limit: 3 });
      expect(res.removed).toEqual(['old.json']);
      expect(existsSync(join(out, 'old.json'))).toBe(false);
      expect(existsSync(join(out, 'keep-me.txt'))).toBe(true);
      const index = JSON.parse(readFileSync(join(out, 'index.json'), 'utf8'));
      expect(index).toMatchObject({ generatedAt: NOW, tz: 'Asia/Seoul' });
      expect(index.files.length).toBe(res.written.length - 1);
      for (const f of index.files) {
        const text = readFileSync(join(out, ...f.path.split('/')), 'utf8');
        expect(Buffer.byteLength(text, 'utf8'), f.path).toBe(f.bytes);
        expect(f.description.length).toBeGreaterThan(0);
      }
      const first = readFileSync(join(out, 'videos', 'activity', 'top-last7d-all.json'), 'utf8');
      writeStaticApi(fixtureIndex(), out, { limit: 3 });
      expect(readFileSync(join(out, 'videos', 'activity', 'top-last7d-all.json'), 'utf8')).toBe(first);
    });
  });

  it('the server answers the same static paths live (parity with GitHub Pages)', async () => {
    const index = fixtureIndex();
    const app = createApp({ getIndex: () => index, rateLimit: false });
    const files = generateStaticApi(index);
    for (const path of ['meta.json', 'videos/activity/top-rolling7d-all.json', 'videos/upload/top-last7d-youtube.json', 'trending/topic-last7d.json', 'creators/top-rolling30d.json']) {
      const res = await app.request(`/api/v1/${path}`);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('etag'), path).toMatch(/^W\//);
      expect(await res.text(), path).toBe(serializeStatic(files.find((f) => f.path === path)!.data));
    }
    const idx = await (await app.request('/api/v1/index.json')).json();
    expect(idx.files.map((f: any) => f.path)).toEqual(files.map((f) => f.path));
    expect(idx.files.every((f: any) => typeof f.bytes === 'number' && f.bytes > 0)).toBe(true);
    // unknown .json paths are ordinary API 404s; video ids still route to the detail endpoint
    expect((await app.request('/api/v1/videos/activity/top-yesterday-all.json')).status).toBe(404);
    expect((await app.request('/api/v1/videos/youtube:yt1')).status).toBe(200);
  });

  it('CLI args: defaults, validation, relative paths against cwd', () => {
    const args = parseCliArgs(['--dataset', 'd.json', '--out=o', '--tz', 'Australia/Sydney', '--limit', '10'], '/base') as any;
    expect(args.dataset.replace(/\\/g, '/')).toMatch(/\/base\/d\.json$/);
    expect(args.out.replace(/\\/g, '/')).toMatch(/\/base\/o$/);
    expect(args).toMatchObject({ tz: 'Australia/Sydney', limit: 10 });
    expect(parseCliArgs(['--help'])).toEqual({ help: true });
    expect(() => parseCliArgs(['--dataset', 'd.json', '--tz', 'Nowhere/Zone'])).toThrow(/time zone/);
    expect(() => parseCliArgs(['--dataset', 'd.json', '--limit', '0'])).toThrow(/limit/);
    expect(() => parseCliArgs(['--bogus'])).toThrow(/unknown argument/);
  });
});
