import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { DEFAULT_KEYWORD_SEEDS, generateStaticApi, loadKeywordSeeds, parseCliArgs, serializeStatic } from '../src/static-api.ts';
import { parseKeywordSeeds } from '../src/routes/keywords.ts';
import { fixtureIndex, NOW } from './fixtures.ts';

const index = fixtureIndex();
const app = createApp({ getIndex: () => index, rateLimit: false });

async function get(url: string): Promise<{ status: number; body: any; res: Response }> {
  const res = await app.request(url);
  const text = await res.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    // CSV
  }
  return { status: res.status, body, res };
}

describe('GET /api/v1/keywords', () => {
  it('compares keywords: matched videos, uploads, honest sums, platform split, share of voice, notes', async () => {
    const { status, body, res } = await get('/api/v1/keywords?q=kpop,Minecraft&range=rolling7d');
    expect(status).toBe(200);
    expect(res.headers.get('etag')).toMatch(/^W\//);
    expect(body.query).toMatchObject({ q: ['kpop', 'Minecraft'], match: 'all', range: { spec: 'rolling7d', rollingHours: 168 }, tz: 'Asia/Seoul', top: 10 });
    expect(body.now).toBe(NOW);
    expect(body.window).toMatchObject({ rollingHours: 168, endMs: NOW });
    expect(body.days).toHaveLength(8);
    const [kpop, mc] = body.keywords;
    // 'kpop' is a topic of the three YouTube videos; 'minecraft' (prefix match) is in one title
    expect(kpop).toMatchObject({ keyword: 'kpop', videos: 3, accounts: 2, terms: [{ text: 'kpop', mode: 'word' }] });
    expect(mc).toMatchObject({ keyword: 'Minecraft', videos: 1, terms: [{ text: 'minecraft', mode: 'prefix' }] });
    expect(kpop.fieldHits).toEqual({ title: 0, tags: 0, topics: 3, description: 0 });
    expect(kpop.viewsPeriod).toMatchObject({ status: 'exact', videos: 3, unknown: 0, crossPlatform: false, platforms: ['youtube'] });
    expect(typeof kpop.viewsPeriod.value).toBe('number');
    expect(kpop.platforms[0]).toMatchObject({ platform: 'youtube', label: 'YouTube', videos: 3 });
    expect(kpop.topVideos[0].video.id).toBeDefined(); // full rows (same shape as /videos)
    expect(Object.keys(kpop.topVideos[0].metrics)).toContain('percentile');
    expect(kpop.topCreators[0]).toMatchObject({ key: 'creator-a', kind: 'creator', name: '크리에이터 A' });
    expect(kpop.categories.map((c: any) => c.id)).toEqual(expect.arrayContaining(['beauty', 'gaming']));
    expect(kpop.categories.find((c: any) => c.id === 'beauty').label).toBe('뷰티');
    const yt = body.shareOfVoice.find((s: any) => s.platform === 'youtube');
    expect(yt.items.map((i: any) => i.keyword)).toEqual(['kpop', 'Minecraft']);
    expect(yt.items[0].viewShare.status).toBe('exact');
    // the overlapping video (yt3) counts for both keywords, in numerators and in the denominator
    expect(yt.items[1].viewShare.value).toBeCloseTo(yt.items[1].measuredViews / (yt.items[0].measuredViews + yt.items[1].measuredViews), 10);
    expect(yt.items[0].measuredViews).toBe(kpop.viewsPeriod.value);
    expect(body.overlapVideos).toBe(1);
    expect(body.notes.join(' ')).toContain('조회 발생 기간 기준');
    expect(body.notes.join(' ')).toContain('동시에 일치');
  });

  it('accepts the web URL keys (kw, langs, cats, platforms, match, fields)', async () => {
    const { status, body } = await get('/api/v1/keywords?kw=kpop&langs=ko&cats=beauty&platforms=youtube&match=any&fields=topics,title');
    expect(status).toBe(200);
    expect(body.query).toMatchObject({ q: ['kpop'], langs: ['ko'], cats: ['beauty'], platforms: ['youtube'], match: 'any', fields: ['topics', 'title'] });
    expect(body.keywords[0].videos).toBe(1);
  });

  it('a keyword without tracked videos says so and reports no numbers as 0', async () => {
    const { body } = await get('/api/v1/keywords?q=없는키워드');
    const r = body.keywords[0];
    expect(r.videos).toBe(0);
    expect(r.viewsPeriod).toMatchObject({ value: null, status: 'unavailable', note: 'no_tracked_videos' });
    expect(r.notes[0]).toContain('일치하는 영상이 없습니다');
  });

  it('mixed platforms are flagged (a Dailymotion source-reported value next to YouTube observations)', async () => {
    const { body } = await get('/api/v1/keywords?q=clip,routine&match=any');
    const clip = body.keywords[0];
    expect(clip.viewsPeriod).toMatchObject({ status: 'source_reported', value: 4200, platforms: ['dailymotion'] });
    expect(body.notes.join(' ')).toContain('여러 플랫폼');
  });

  it('validates parameters with Korean + English errors', async () => {
    for (const [url, param] of [
      ['/api/v1/keywords', 'q'],
      ['/api/v1/keywords?q=a,b,c,d,e,f', 'q'],
      ['/api/v1/keywords?q=%23%23%23', 'q'],
      ['/api/v1/keywords?q=kpop&match=some', 'match'],
      ['/api/v1/keywords?q=kpop&fields=body', 'fields'],
      ['/api/v1/keywords?q=kpop&top=99', 'top'],
      ['/api/v1/keywords?q=kpop&range=yesterweek', 'range'],
      ['/api/v1/keywords?q=kpop&platforms=myspace', 'platforms'],
      ['/api/v1/keywords?q=kpop&bogus=1', 'bogus'],
    ] as const) {
      const { status, body, res } = await get(url);
      expect(status, url).toBe(400);
      expect(body.error.param, url).toBe(param);
      expect(body.error.message).toMatch(/[가-힣]/);
      expect(body.error.messageEn).toMatch(/[a-z]/i);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('format=csv: top videos of every keyword with keyword + rank columns', async () => {
    const { status, body, res } = await get('/api/v1/keywords?q=kpop,minecraft&format=csv&top=2');
    expect(status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="vti-keywords-rolling7d-\d{8}-\d{4}\.csv"/);
    expect(res.headers.get('x-total-count')).toBe('3');
    const lines = (body as string).replace(new RegExp(`^${String.fromCharCode(0xfeff)}`), '').split('\r\n').filter(Boolean); // BOM, if not already stripped by text()
    expect(lines[0].startsWith('키워드,키워드 내 순위,플랫폼,영상 ID')).toBe(true);
    expect(lines).toHaveLength(4);
    expect(lines[1].startsWith('kpop,1,YouTube,')).toBe(true);
    expect(lines[3].startsWith('minecraft,1,YouTube,youtube:yt3')).toBe(true);
  });

  it('is documented in openapi.json and listed at /api/v1', async () => {
    const doc = (await get('/api/v1/openapi.json')).body;
    expect(doc.paths['/api/v1/keywords'].get.operationId).toBe('getKeywords');
    expect(doc.components.schemas.Keywords).toBeDefined();
    const text = JSON.stringify(doc);
    for (const m of text.matchAll(/"\$ref":"#\/components\/(\w+)\/(\w+)"/g)) expect(doc.components[m[1]]?.[m[2]], `${m[1]}/${m[2]}`).toBeDefined();
    expect((await get('/api/v1')).body.endpoints).toContain('/api/v1/keywords');
  });
});

describe('static keyword reports', () => {
  const seeds = [{ keyword: 'kpop', category: 'music/kpop', language: 'en' }, { keyword: '스킨케어' }, { keyword: '없는키워드' }];

  it('writes keywords/index.json + keywords/<i>.json (rolling7d, compact rows) only when seeds are given', () => {
    expect(generateStaticApi(index).some((f) => f.path.startsWith('keywords/'))).toBe(false);
    const files = generateStaticApi(index, { keywords: seeds });
    const paths = files.map((f) => f.path);
    expect(paths).toEqual([...paths].sort());
    expect(paths.filter((p) => p.startsWith('keywords/'))).toEqual(['keywords/0.json', 'keywords/1.json', 'keywords/2.json', 'keywords/index.json']);
    const idx = files.find((f) => f.path === 'keywords/index.json')!.data as any;
    expect(idx.range).toMatchObject({ spec: 'rolling7d', rollingHours: 168 });
    expect(idx.keywords[0]).toMatchObject({ index: 0, keyword: 'kpop', category: 'music/kpop', language: 'en', path: 'keywords/0.json', videos: 3 });
    expect(idx.keywords[2]).toMatchObject({ videos: 0, viewsPeriod: { value: null, status: 'unavailable' } });
    const one = files.find((f) => f.path === 'keywords/1.json')!.data as any;
    expect(one.seed).toMatchObject({ keyword: '스킨케어', category: null });
    expect(one.report).toMatchObject({ keyword: '스킨케어', videos: 1 });
    const row = one.report.topVideos[0];
    expect(Object.keys(row)).toEqual(['rank', 'id', 'platform', 'url', 'title', 'thumbnail', 'account', 'publishedAt', 'metrics']);
    expect(Object.keys(row.metrics)).toEqual(['viewsPeriod', 'viewsTotal', 'percentile']);
    expect(Object.keys(row.metrics.viewsPeriod)).toEqual(['value', 'status', 'asOf']);
    expect(one.shareOfVoice).toBeUndefined();
  });

  it('the server serves the same keyword files live when configured (parity)', async () => {
    const live = createApp({ getIndex: () => index, rateLimit: false, staticKeywords: seeds });
    const files = generateStaticApi(index, { keywords: seeds });
    for (const path of ['keywords/index.json', 'keywords/0.json']) {
      const res = await live.request(`/api/v1/${path}`);
      expect(res.status, path).toBe(200);
      expect(await res.text()).toBe(serializeStatic(files.find((f) => f.path === path)!.data));
    }
    const listed = await (await live.request('/api/v1/index.json')).json();
    expect(listed.files.map((f: any) => f.path)).toEqual(files.map((f) => f.path));
    // without the option the paths are ordinary 404s
    expect((await app.request('/api/v1/keywords/0.json')).status).toBe(404);
  });

  it('CLI: seed keywords default to the collector seeds file; --keywords none skips them', () => {
    const args = parseCliArgs(['--dataset', 'd.json'], '/base') as any;
    expect(args.keywords).toBe(existsSync(DEFAULT_KEYWORD_SEEDS) ? DEFAULT_KEYWORD_SEEDS : null);
    expect((parseCliArgs(['--dataset', 'd.json', '--keywords', 'none'], '/base') as any).keywords).toBeNull();
    expect((parseCliArgs(['--dataset', 'd.json', '--keywords=k.json'], '/base') as any).keywords.replace(/\\/g, '/')).toMatch(/\/base\/k\.json$/);
  });

  it('reads the real collector seeds and drops invalid entries', () => {
    if (existsSync(DEFAULT_KEYWORD_SEEDS)) {
      const real = loadKeywordSeeds(DEFAULT_KEYWORD_SEEDS);
      expect(real.length).toBeGreaterThan(100);
      expect(real[0]).toMatchObject({ keyword: expect.any(String), category: expect.any(String), language: expect.any(String) });
    }
    expect(parseKeywordSeeds(['먹방', { keyword: 'kpop', category: 'music' }, { keyword: '###' }, { nope: 1 }, 7, { keyword: '' }])).toEqual([
      { keyword: '먹방' },
      { keyword: 'kpop', category: 'music', language: null },
    ]);
    expect(parseKeywordSeeds({})).toEqual([]);
  });
});
