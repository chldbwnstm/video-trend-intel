import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeDataset } from '@vti/core';
import type { DatasetIndex } from '@vti/core';
import { createApp, TokenBucketLimiter, type CreateAppOptions } from '../src/app.ts';
import { fixtureCompactJson, fixtureIndex, NOW } from './fixtures.ts';
import { makeIndex, makeObs, makeVideo } from '../../../packages/core/test/fixtures.ts';

const DAY = 86_400_000;

function makeApp(over: Partial<CreateAppOptions> = {}) {
  const index = fixtureIndex();
  const compact = fixtureCompactJson();
  return createApp({ getIndex: () => index, getCompact: () => compact, rateLimit: false, ...over });
}

async function json(res: Response): Promise<any> {
  return JSON.parse(await res.text());
}

async function expect400(app: ReturnType<typeof makeApp>, url: string, param?: string) {
  const res = await app.request(url);
  const body = await json(res);
  expect(res.status, url).toBe(400);
  expect(body.error.status).toBe(400);
  expect(body.error.message).toMatch(/[가-힣]/); // Korean
  expect(body.error.messageEn).toMatch(/[a-z]/i);
  if (param) expect(body.error.param).toBe(param);
  expect(res.headers.get('cache-control')).toBe('no-store');
  return body;
}

describe('system routes', () => {
  const app = makeApp({ getStatus: () => ({ scheduler: { enabled: false } }) });

  it('GET /api/v1/health reports the dataset and is not cached', async () => {
    const res = await app.request('/api/v1/health');
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.status).toBe('ok');
    expect(body.dataset.generatedAt).toBe(NOW);
    expect(body.dataset.videos).toBe(5);
    expect(body.scheduler).toEqual({ enabled: false });
    expect(res.headers.get('etag')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('health says "starting" and data routes answer 503 without a dataset', async () => {
    const empty = createApp({ getIndex: () => null, rateLimit: false });
    const h = await json(await empty.request('/api/v1/health'));
    expect(h.status).toBe('starting');
    expect(h.dataset).toBeNull();
    for (const url of ['/api/v1/meta', '/api/v1/videos', '/api/v1/dataset']) {
      const res = await empty.request(url);
      expect(res.status, url).toBe(503);
      expect(res.headers.get('retry-after')).toBe('30');
      const body = await json(res);
      expect(body.error.code).toBe('dataset_unavailable');
    }
  });

  it('GET /api/v1/meta returns version, counts and coverage summary', async () => {
    const res = await app.request('/api/v1/meta');
    expect(res.status).toBe(200);
    const m = await json(res);
    expect(m.generatedAt).toBe(NOW);
    expect(m.classifierVersion).toBe('test');
    expect(m.counts).toMatchObject({ videos: 5, accounts: 4, creators: 1, runs: 1, sources: 1 });
    expect(m.platforms.map((p: any) => p.platform)).toEqual(['youtube', 'dailymotion', 'niconico']);
    expect(m.coverage.categorized).toBe(4);
    expect(m.coverage.sponsorship).toEqual({ disclosed: 1, likely: 0 });
    expect(m.coverage.creators).toEqual({ total: 1, verified: 1, suggested: 0 });
    expect(m.defaults).toMatchObject({ tz: 'Asia/Seoul', mode: 'activity', range: 'rolling7d', sort: 'views_period', limit: 50, maxLimit: 500 });
  });

  it('GET /api/v1 lists endpoints; unknown API paths are JSON 404s', async () => {
    const idx = await json(await app.request('/api/v1'));
    expect(idx.endpoints).toContain('/api/v1/videos');
    const res = await app.request('/api/v1/nope');
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe('not_found');
  });

  it('GET /api/v1/openapi.json is an OpenAPI 3.1 document covering every route', async () => {
    const doc = await json(await app.request('/api/v1/openapi.json'));
    expect(doc.openapi).toBe('3.1.0');
    for (const p of ['health', 'meta', 'videos', 'videos/{id}', 'trending', 'explore', 'creators', 'creators/{key}', 'taxonomy', 'coverage', 'dataset', 'openapi.json']) {
      expect(doc.paths[`/api/v1/${p}`], p).toBeDefined();
    }
    // every $ref resolves
    const text = JSON.stringify(doc);
    for (const m of text.matchAll(/"\$ref":"#\/components\/(\w+)\/(\w+)"/g)) {
      expect(doc.components[m[1]]?.[m[2]], `${m[1]}/${m[2]}`).toBeDefined();
    }
  });

  it('rejects writes with 405 and answers CORS preflights', async () => {
    const res = await app.request('/api/v1/videos', { method: 'POST' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD, OPTIONS');
    expect((await json(res)).error.code).toBe('method_not_allowed');
    const pre = await app.request('/api/v1/videos', { method: 'OPTIONS', headers: { origin: 'https://example.org', 'access-control-request-method': 'GET' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('*');
    expect(pre.headers.get('access-control-allow-methods')).toContain('GET');
  });

  it('sets CORS + security headers on API responses', async () => {
    const res = await app.request('/api/v1/meta', { headers: { origin: 'https://example.org' } });
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-expose-headers')).toContain('ETag');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
  });
});

describe('GET /api/v1/videos', () => {
  const app = makeApp();

  it('defaults: activity mode, rolling7d in Asia/Seoul, sort views_period, limit 50', async () => {
    const res = await app.request('/api/v1/videos');
    expect(res.status).toBe(200);
    const b = await json(res);
    expect(b.query).toMatchObject({ mode: 'activity', tz: 'Asia/Seoul', sort: 'views_period', dir: 'desc', limit: 50, offset: 0, format: 'json' });
    expect(b.query.range).toMatchObject({ spec: 'rolling7d', preset: 'rolling7d', rollingHours: 168, default: true });
    expect(b.window).toMatchObject({ startMs: NOW - 7 * DAY, endMs: NOW, tz: 'Asia/Seoul', rollingHours: 168, incomplete: false });
    expect(b.now).toBe(NOW);
    expect(b.total).toBe(5);
    expect(b.rows).toHaveLength(5);
    expect(b.notes.length).toBeGreaterThan(0);
    // ranked by views increase: yt3 (2500/h) > yt1 (1000/h) > yt2 (400/h since 09-25) ... unrankable last
    expect(b.rows.slice(0, 3).map((r: any) => r.video.id)).toEqual(['youtube:yt3', 'youtube:yt1', 'youtube:yt2']);
    const yt1 = b.rows.find((r: any) => r.video.id === 'youtube:yt1');
    expect(yt1.metrics.viewsPeriod).toEqual({ value: 168_000, status: 'exact', asOf: NOW, note: null });
    expect(yt1.video.observationCount).toBeGreaterThan(10);
    expect(yt1.video).not.toHaveProperty('obs');
    expect(yt1.video.categories[0].label).toContain('›');
    expect(yt1.account).toMatchObject({ id: 'youtube:ch1', name: '뷰티 채널', followers: { value: 12_000, asOf: NOW } });
    // Dailymotion uses the source-reported 168 h window
    const dm = b.rows.find((r: any) => r.video.id === 'dailymotion:dm1');
    expect(dm.metrics.viewsPeriod).toMatchObject({ value: 4_200, status: 'source_reported' });
    // niconico: one observation, but published inside the window (0 at publish is known by definition)
    const nn = b.rows.find((r: any) => r.video.id === 'niconico:sm1');
    expect(nn.metrics.viewsPeriod).toMatchObject({ value: 9_000, status: 'exact' });
    // growth vs the previous 168 h is undefined for it (published after that window): unavailable, never 0
    expect(nn.metrics.growthVsPrev.status).toBe('unavailable');
  });

  it('filters: platforms, cats (with descendants), q, langs, sponsored, formats, creators', async () => {
    const ids = async (qs: string) => (await json(await app.request(`/api/v1/videos?${qs}`))).rows.map((r: any) => r.video.id).sort();
    expect(await ids('platforms=dailymotion,niconico')).toEqual(['dailymotion:dm1', 'niconico:sm1']);
    expect(await ids('platform=youtube&platform=niconico')).toEqual(['niconico:sm1', 'youtube:yt1', 'youtube:yt2', 'youtube:yt3']);
    expect(await ids('cats=beauty')).toEqual(['youtube:yt1', 'youtube:yt2']);
    expect(await ids('q=스킨케어')).toEqual(['youtube:yt1']);
    expect(await ids('langs=KO')).toEqual(['youtube:yt1', 'youtube:yt3']);
    expect(await ids('sponsored=disclosed')).toEqual(['youtube:yt3']);
    expect(await ids('formats=short')).toEqual(['youtube:yt2']);
    expect(await ids('creators=creator-a')).toEqual(['dailymotion:dm1', 'youtube:yt1', 'youtube:yt2']);
    expect(await ids('topics=minecraft')).toEqual(['youtube:yt3']);
    expect(await ids('countries=kr')).toEqual(['youtube:yt1']);
  });

  it('upload mode, age mode, custom ranges, rolling hours, paging and direction', async () => {
    const up = await json(await app.request('/api/v1/videos?mode=upload&range=last7d&sort=views_total'));
    expect(up.query.range).toMatchObject({ spec: 'last7d', rollingHours: null, default: false });
    expect(up.rows.map((r: any) => r.video.id).sort()).toEqual(['niconico:sm1', 'youtube:yt2']);
    expect(up.notes[0]).toContain('업로드 기간 기준');

    const age = await json(await app.request('/api/v1/videos?mode=age&age=1'));
    expect(age.query).toMatchObject({ mode: 'age', age: 1, sort: 'views_at_age', range: null });
    expect(age.rows[0].metrics.viewsAtAge.status).toBe('exact');

    const ageDefault = await json(await app.request('/api/v1/videos?dateMode=age'));
    expect(ageDefault.query.age).toBe(7);

    const custom = await json(await app.request('/api/v1/videos?start=2026-09-20&end=2026-09-27'));
    expect(custom.query.range).toMatchObject({ spec: '2026-09-20..2026-09-27', start: '2026-09-20', end: '2026-09-27' });
    expect(custom.window.firstDate).toBe('2026-09-20');
    expect(custom.window.lastDate).toBe('2026-09-27');
    const same = await json(await app.request('/api/v1/videos?range=2026-09-20..2026-09-27'));
    expect(same.window).toEqual(custom.window);

    const hours = await json(await app.request('/api/v1/videos?hours=36'));
    expect(hours.window).toMatchObject({ startMs: NOW - 36 * 3_600_000, endMs: NOW, rollingHours: 36 });

    const p2 = await json(await app.request('/api/v1/videos?limit=2&page=2'));
    expect(p2).toMatchObject({ offset: 2, limit: 2, count: 2, total: 5 });
    const o = await json(await app.request('/api/v1/videos?limit=2&offset=2'));
    expect(o.rows.map((r: any) => r.video.id)).toEqual(p2.rows.map((r: any) => r.video.id));

    const asc = await json(await app.request('/api/v1/videos?platforms=youtube&dir=asc'));
    expect(asc.rows.map((r: any) => r.video.id)).toEqual(['youtube:yt2', 'youtube:yt1', 'youtube:yt3']);

    const tz = await json(await app.request('/api/v1/videos?tz=Australia/Sydney&range=last7d'));
    expect(tz.window.tz).toBe('Australia/Sydney');

    const asOf = await json(await app.request(`/api/v1/videos?asOf=${new Date(NOW - DAY).toISOString()}&platforms=youtube`));
    expect(asOf.now).toBe(NOW - DAY);
    expect(asOf.window.endMs).toBe(NOW - DAY);
  });

  it('ignores cache-buster keys starting with "_" and the web-only "v" key', async () => {
    const res = await app.request('/api/v1/videos?_=123&v=youtube:yt1');
    expect(res.status).toBe(200);
  });

  it('validates parameters with Korean + English messages', async () => {
    await expect400(app, '/api/v1/videos?limit=0', 'limit');
    await expect400(app, '/api/v1/videos?limit=501', 'limit');
    await expect400(app, '/api/v1/videos?limit=abc', 'limit');
    await expect400(app, '/api/v1/videos?mode=weekly', 'mode');
    await expect400(app, '/api/v1/videos?sort=likes', 'sort');
    await expect400(app, '/api/v1/videos?dir=up', 'dir');
    await expect400(app, '/api/v1/videos?range=lastYear', 'range');
    await expect400(app, '/api/v1/videos?range=2026-09-30..2026-09-01', 'range');
    await expect400(app, '/api/v1/videos?range=2026-02-30..2026-03-01', 'range');
    await expect400(app, '/api/v1/videos?range=2020-01-01..2026-01-01', 'range');
    await expect400(app, '/api/v1/videos?start=2026-09-01', 'end');
    await expect400(app, '/api/v1/videos?range=last7d&hours=24', 'hours');
    await expect400(app, '/api/v1/videos?hours=0', 'hours');
    await expect400(app, '/api/v1/videos?tz=Mars/Olympus', 'tz');
    await expect400(app, '/api/v1/videos?platforms=youtube,myspace', 'platforms');
    await expect400(app, '/api/v1/videos?cats=beauty/nope', 'cats');
    await expect400(app, '/api/v1/videos?langs=korean!', 'langs');
    await expect400(app, '/api/v1/videos?formats=vertical', 'formats');
    await expect400(app, '/api/v1/videos?mode=age&age=5', 'age');
    await expect400(app, '/api/v1/videos?sponsored=yes', 'sponsored');
    await expect400(app, '/api/v1/videos?minViews=-1', 'minViews');
    await expect400(app, '/api/v1/videos?offset=1&page=2', 'page');
    await expect400(app, '/api/v1/videos?mode=activity&mode=upload', 'mode');
    await expect400(app, `/api/v1/videos?asOf=${NOW + DAY}`, 'asOf');
    await expect400(app, '/api/v1/videos?asOf=yesterday', 'asOf');
    await expect400(app, `/api/v1/videos?q=${'x'.repeat(201)}`, 'q');
    const unknown = await expect400(app, '/api/v1/videos?platfrom=youtube', 'platfrom');
    expect(unknown.error.code).toBe('unknown_parameter');
    expect(unknown.error.message).toContain('platforms');
  });

  it('format=csv returns the query result as an Excel-friendly attachment', async () => {
    const res = await app.request('/api/v1/videos?format=csv&platforms=youtube');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    const cd = res.headers.get('content-disposition') ?? '';
    expect(cd).toMatch(/^attachment; filename="vti-videos-activity-rolling7d-\d{8}-\d{4}\.csv"$/);
    expect(res.headers.get('x-total-count')).toBe('3');
    expect(res.headers.get('etag')).toMatch(/^W\//);
    const bytes = Buffer.from(await res.arrayBuffer());
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 BOM for Excel
    const lines = bytes.subarray(3).toString('utf8').trimEnd().split('\r\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain('누적 조회수 상태');
    expect(lines[1]).toContain('youtube:yt3');
    // CSV allows a larger limit than JSON
    expect((await app.request('/api/v1/videos?format=csv&limit=5000')).status).toBe(200);
    await expect400(app, '/api/v1/videos?format=csv&limit=5001', 'limit');
    await expect400(app, '/api/v1/videos?format=xml', 'format');
  });

  it('GET /api/v1/videos/:id returns metrics, V-ratings, daily increments and raw observations', async () => {
    const res = await app.request('/api/v1/videos/youtube:yt1');
    expect(res.status).toBe(200);
    const d = await json(res);
    expect(d.video.id).toBe('youtube:yt1');
    expect(d.account.id).toBe('youtube:ch1');
    expect(d.account.followerSeries).toHaveLength(2);
    expect(d.creator).toMatchObject({ id: 'creator-a', linkStatus: 'verified' });
    expect(d.metrics.viewsPeriod).toMatchObject({ value: 168_000, status: 'exact' });
    expect(d.ratings.map((r: any) => r.label)).toEqual(['V1', 'V2', 'V3', 'V7', 'V30']);
    expect(d.ratings[0].views).toMatchObject({ value: 24_000, status: 'exact' });
    expect(d.ratings[4].views.note).toBe('not_reached'); // published 2026-09-01, V30 = 10-01 > now
    expect(d.daily.days).toHaveLength(30);
    expect(d.daily.end).toBe('2026-09-28');
    expect(d.daily.days[29].date).toBe('2026-09-28');
    expect(d.daily.days[20].views.status).toMatch(/exact|interpolated/);
    expect(d.observations.length).toBeGreaterThan(10);
    expect(d.observations[0]).toMatchObject({ src: 'youtube-rss@1' });
    // encoded id + days param
    const enc = await json(await app.request('/api/v1/videos/dailymotion%3Adm1?days=7'));
    expect(enc.video.id).toBe('dailymotion:dm1');
    expect(enc.daily.days).toHaveLength(7);
    expect(enc.sourceWindows).toHaveLength(3);
    expect(enc.metrics.viewsPeriod.status).toBe('source_reported');
  });

  it('GET /api/v1/videos/:id 404s with the id and validates params', async () => {
    const res = await app.request('/api/v1/videos/youtube:nope');
    expect(res.status).toBe(404);
    const b = await json(res);
    expect(b.error).toMatchObject({ code: 'not_found', id: 'youtube:nope' });
    expect(b.error.message).toContain('youtube:nope');
    await expect400(app, '/api/v1/videos/youtube:yt1?days=91', 'days');
  });
});

describe('analytics routes', () => {
  const app = makeApp();

  it('GET /api/v1/trending (default topic, rolling7d) and kinds', async () => {
    const res = await app.request('/api/v1/trending');
    expect(res.status).toBe(200);
    const t = await json(res);
    expect(t.query).toMatchObject({ kind: 'topic', limit: 20 });
    expect(t.query.range.spec).toBe('rolling7d');
    expect(t.window).toMatchObject({ startMs: NOW - 7 * DAY, endMs: NOW });
    expect(t.previousWindow).toMatchObject({ startMs: NOW - 14 * DAY, endMs: NOW - 7 * DAY });
    expect(Array.isArray(t.rising) && Array.isArray(t.falling) && Array.isArray(t.top)).toBe(true);
    const kpop = t.top.find((i: any) => i.key === 'kpop');
    expect(kpop).toMatchObject({ kind: 'topic', platform: 'youtube', videoCount: 3 });
    expect(t.notes.length).toBeGreaterThan(0);
    for (const kind of ['category', 'creator', 'account']) {
      const r = await json(await app.request(`/api/v1/trending?kind=${kind}&range=rolling30d&minVideos=1`));
      expect(r.query.kind).toBe(kind);
      expect(r.top.length).toBeGreaterThan(0);
    }
    await expect400(app, '/api/v1/trending?kind=hashtag', 'kind');
    await expect400(app, '/api/v1/trending?limit=101', 'limit');
  });

  it('GET /api/v1/explore analyses one platform', async () => {
    const e = await json(await app.request('/api/v1/explore?range=rolling30d&minSupply=1'));
    expect(e.platform).toBe('youtube');
    expect(e.platformLabel).toBe('YouTube');
    expect(e.items.length).toBeGreaterThan(0);
    expect(e.items[0]).toHaveProperty('demand');
    expect(e.notes.some((n: string) => n.includes('YouTube'))).toBe(true);
    const nn = await json(await app.request('/api/v1/explore?platform=niconico&range=rolling30d&minSupply=1'));
    expect(nn.platform).toBe('niconico');
    await expect400(app, '/api/v1/explore?platforms=youtube,niconico', 'platform');
  });

  it('GET /api/v1/creators lists portfolios (creator links merge platforms)', async () => {
    const c = await json(await app.request('/api/v1/creators'));
    expect(c.total).toBe(3); // creator-a (ch1 + dmacc1), ch2, user1
    const a = c.rows.find((r: any) => r.key === 'creator-a');
    expect(a).toMatchObject({ kind: 'creator', name: '크리에이터 A', platforms: ['youtube', 'dailymotion'], followers: 12_000, videoCount: 3 });
    expect(a.accounts.map((x: any) => x.id)).toEqual(['youtube:ch1', 'dailymotion:dmacc1']);
    expect(a.topCategories[0]).toMatchObject({ id: 'beauty' });
    const page = await json(await app.request('/api/v1/creators?limit=1&offset=1&sort=uploads'));
    expect(page).toMatchObject({ total: 3, count: 1 });
    const q = await json(await app.request('/api/v1/creators?q=game'));
    expect(q.rows.map((r: any) => r.key)).toEqual(['youtube:ch2']);
    await expect400(app, '/api/v1/creators?sort=subscribers', 'sort');
  });

  it('GET /api/v1/creators/:key returns summary, timeline, heatmap and top videos', async () => {
    const d = await json(await app.request('/api/v1/creators/creator-a?range=last7d'));
    expect(d).toMatchObject({ key: 'creator-a', kind: 'creator' });
    expect(d.creator.linkStatus).toBe('verified');
    expect(d.summary.platforms).toEqual(['youtube', 'dailymotion']);
    expect(d.timeline.days).toHaveLength(7);
    expect(Object.keys(d.timeline.days[0].byPlatform)).toEqual(['youtube', 'dailymotion']);
    expect(d.heatmap.counts).toHaveLength(7);
    expect(d.heatmap.counts[0]).toHaveLength(24);
    expect(d.topVideos.rows[0]).toMatchObject({ rank: 1 });
    expect(Object.keys(d.topVideos.rows[0]).sort()).toEqual(['account', 'id', 'metrics', 'platform', 'publishedAt', 'rank', 'thumbnail', 'title', 'url']);
    const acc = await json(await app.request('/api/v1/creators/youtube%3Ach2'));
    expect(acc).toMatchObject({ key: 'youtube:ch2', kind: 'account', creator: null });
    const nf = await app.request('/api/v1/creators/youtube:abc');
    expect(nf.status).toBe(404);
    const body = await json(nf);
    expect(body.error.key).toBe('youtube:abc');
    expect(body.error.message).toContain('youtube:abc');
  });

  it('ids / keys containing "/" or "@" work raw and percent-encoded (niconico channels, PeerTube)', async () => {
    const v1 = makeVideo({ id: 'niconico:so42', platform: 'niconico', accountId: 'niconico:channel/42', publishedAt: NOW - DAY, obs: [makeObs(NOW, 100)] });
    const v2 = makeVideo({ id: 'peertube:abc-1@video.example.org', platform: 'peertube', accountId: 'peertube:me@video.example.org', publishedAt: NOW - DAY, obs: [makeObs(NOW, 5)] });
    const index = makeIndex({ videos: [v1, v2], generatedAt: NOW });
    const app2 = createApp({ getIndex: () => index, rateLimit: false });
    for (const url of ['/api/v1/creators/niconico:channel/42', '/api/v1/creators/niconico%3Achannel%2F42']) {
      const res = await app2.request(url);
      expect(res.status, url).toBe(200);
      expect((await json(res)).key).toBe('niconico:channel/42');
    }
    for (const url of ['/api/v1/videos/peertube:abc-1@video.example.org', '/api/v1/videos/peertube%3Aabc-1%40video.example.org']) {
      const res = await app2.request(url);
      expect(res.status, url).toBe(200);
      expect((await json(res)).video.id).toBe('peertube:abc-1@video.example.org');
    }
    const acc = await app2.request('/api/v1/creators/peertube:me@video.example.org?range=last7d');
    expect(acc.status).toBe(200);
  });

  it('GET /api/v1/taxonomy returns the tree with rolled-up counts', async () => {
    const t = await json(await app.request('/api/v1/taxonomy'));
    expect(t.totals).toMatchObject({ videos: 5, categorized: 4, uncategorized: 1 });
    const beauty = t.tree.find((n: any) => n.id === 'beauty');
    expect(beauty.counts).toMatchObject({ total: 2, direct: 0, byPlatform: { youtube: 2 } });
    expect(beauty.children.find((n: any) => n.id === 'beauty/skincare').counts.direct).toBe(1);
    expect(beauty.keywords.length).toBeGreaterThan(0);
    const lean = await json(await app.request('/api/v1/taxonomy?keywords=0'));
    expect(lean.tree[0]).not.toHaveProperty('keywords');
    await expect400(app, '/api/v1/taxonomy?keywords=maybe', 'keywords');
  });

  it('GET /api/v1/coverage explains sources, density and window quality', async () => {
    const c = await json(await app.request('/api/v1/coverage'));
    expect(c.sources).toHaveLength(1);
    expect(c.runs[0].id).toBe('run-1');
    expect(c.exportNotes).toEqual(['테스트 데이터셋']);
    expect(c.windowQuality.map((w: any) => w.preset)).toEqual(['rolling24h', 'rolling7d', 'rolling30d']);
    const w7 = c.windowQuality[1];
    expect(w7.total).toBe(5);
    expect(w7.byStatus.source_reported).toBe(1);
    expect(w7.byStatus.exact).toBeGreaterThanOrEqual(3);
    expect(c.observationDensity.perVideo['1']).toBe(2);
    expect(c.unsupported.map((u: any) => u.feature)).toEqual(['Audience Ratings', 'Consumer Insights']);
    expect(c.statusLabels.lower_bound).toContain('하한');
  });
});

describe('dataset, caching, rate limit', () => {
  it('GET /api/v1/dataset and /data/dataset.json serve the compact dataset (gzip when accepted)', async () => {
    const app = makeApp();
    const plain = await app.request('/api/v1/dataset');
    expect(plain.status).toBe(200);
    expect(plain.headers.get('content-encoding')).toBeNull();
    const ds = decodeDataset(JSON.parse(await plain.text()));
    expect(ds.generatedAt).toBe(NOW);
    expect(ds.videos).toHaveLength(5);

    const gz = await app.request('/data/dataset.json', { headers: { 'accept-encoding': 'gzip, deflate' } });
    expect(gz.status).toBe(200);
    expect(gz.headers.get('content-encoding')).toBe('gzip');
    expect(gz.headers.get('cache-control')).toBe('no-cache');
    const unz = gunzipSync(Buffer.from(await gz.arrayBuffer())).toString('utf8');
    expect(unz).toBe(fixtureCompactJson());
    const tag = gz.headers.get('etag')!;
    const again = await app.request('/data/dataset.json', { headers: { 'if-none-match': tag } });
    expect(again.status).toBe(304);
    const noGzip = await app.request('/data/dataset.json', { headers: { 'accept-encoding': 'gzip;q=0' } });
    expect(noGzip.headers.get('content-encoding')).toBeNull();
    const head = await app.request('/api/v1/dataset', { method: 'HEAD', headers: { 'accept-encoding': 'gzip' } });
    expect(head.status).toBe(200);
    expect(Number(head.headers.get('content-length'))).toBeGreaterThan(0);
  });

  it('ETag / 304 per dataset version; a hot-swapped dataset changes the ETag and the content', async () => {
    let index: DatasetIndex = fixtureIndex();
    const app = createApp({ getIndex: () => index, rateLimit: false });
    const first = await app.request('/api/v1/meta');
    const tag = first.headers.get('etag')!;
    expect(tag).toMatch(/^W\/"vti-api-/);
    expect(first.headers.get('cache-control')).toContain('max-age=60');
    expect(first.headers.get('x-data-generated-at')).toBe(new Date(NOW).toISOString());
    const nm = await app.request('/api/v1/meta', { headers: { 'if-none-match': tag } });
    expect(nm.status).toBe(304);
    expect(await nm.text()).toBe('');
    const nmVideos = await app.request('/api/v1/videos?limit=1', { headers: { 'if-none-match': `"x", ${tag}` } });
    expect(nmVideos.status).toBe(304);
    // errors carry no ETag
    const bad = await app.request('/api/v1/videos?limit=0');
    expect(bad.headers.get('etag')).toBeNull();

    index = fixtureIndex(NOW + 3 * 3_600_000);
    const swapped = await app.request('/api/v1/meta', { headers: { 'if-none-match': tag } });
    expect(swapped.status).toBe(200);
    expect(swapped.headers.get('etag')).not.toBe(tag);
    expect((await json(swapped)).generatedAt).toBe(NOW + 3 * 3_600_000);
  });

  it('response cache is keyed by the normalized query', async () => {
    const app = makeApp();
    const a = await (await app.request('/api/v1/videos?platforms=youtube&limit=2')).text();
    const b = await (await app.request('/api/v1/videos?limit=2&platforms=youtube')).text();
    expect(b).toBe(a);
    const h = await json(await app.request('/api/v1/health'));
    expect(h.cache.hits).toBeGreaterThanOrEqual(1);
  });

  it('per-IP token bucket: 429 with Retry-After; other IPs and /health unaffected', async () => {
    const app = makeApp({ rateLimit: { perMinute: 3 }, trustProxy: true });
    const ip = (a: string) => ({ headers: { 'x-forwarded-for': `${a}, 10.0.0.1` } });
    for (let i = 0; i < 3; i++) {
      const r = await app.request('/api/v1/meta', ip('203.0.113.7'));
      expect(r.status).toBe(200);
      expect(r.headers.get('x-ratelimit-remaining')).toBe(String(2 - i));
    }
    const limited = await app.request('/api/v1/meta', ip('203.0.113.7'));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    const body = await json(limited);
    expect(body.error.code).toBe('rate_limited');
    expect(body.error.message).toContain('분당 3회');
    expect((await app.request('/api/v1/meta', ip('198.51.100.1'))).status).toBe(200);
    expect((await app.request('/api/v1/health', ip('203.0.113.7'))).status).toBe(200);
  });

  it('token bucket refills over time and prunes idle clients', () => {
    let t = 0;
    const lim = new TokenBucketLimiter(60, 2, () => t, 3);
    expect(lim.take('a').ok).toBe(true);
    expect(lim.take('a').ok).toBe(true);
    const denied = lim.take('a');
    expect(denied).toMatchObject({ ok: false, retryAfterSec: 1 });
    t += 1000;
    expect(lim.take('a').ok).toBe(true);
    lim.take('b');
    lim.take('c');
    t += 60_000;
    lim.take('d'); // map full -> idle buckets pruned
    expect(lim.size).toBeLessThanOrEqual(3);
  });
});

describe('static web serving', () => {
  let dist: string;
  let dataDir: string;
  beforeAll(() => {
    dist = mkdtempSync(join(tmpdir(), 'vti-dist-'));
    dataDir = mkdtempSync(join(tmpdir(), 'vti-data-'));
    mkdirSync(join(dist, 'assets'));
    mkdirSync(join(dist, 'data'));
    writeFileSync(join(dist, 'index.html'), '<!doctype html><html><head><script>window.x=1</script><script type="module" src="./assets/app.js"></script></head><body></body></html>');
    writeFileSync(join(dist, 'assets', 'app.js'), 'console.log(1)');
    writeFileSync(join(dist, 'data', 'sample.json'), '{"sample":true}');
    writeFileSync(join(dist, '.env'), 'SECRET=1');
    writeFileSync(join(dataDir, 'meta.json'), '{"generatedAt":1}');
  });
  afterAll(() => {
    rmSync(dist, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('serves index.html with a hashed-inline-script CSP, assets immutable, sample + meta data', async () => {
    const app = makeApp({ webDistDir: dist, dataDir });
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    const csp = res.headers.get('content-security-policy')!;
    expect(csp).toMatch(/script-src 'self' 'sha256-[A-Za-z0-9+/=]+'/);
    expect(csp).toContain("frame-ancestors 'none'");
    const etag = res.headers.get('etag')!;
    expect((await app.request('/', { headers: { 'if-none-match': etag } })).status).toBe(304);

    const js = await app.request('/assets/app.js');
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(js.headers.get('cache-control')).toContain('immutable');
    expect(await js.text()).toBe('console.log(1)');

    expect(await (await app.request('/data/sample.json')).json()).toEqual({ sample: true });
    expect(await (await app.request('/data/meta.json')).json()).toEqual({ generatedAt: 1 });
  });

  it('never serves files outside the root or dotfiles; deep links redirect to the hash route', async () => {
    const app = makeApp({ webDistDir: dist, dataDir });
    for (const p of ['/..%2f..%2fpackage.json', '/.env', '/assets/..%5c..%5cindex.html', '/nope.js', '/data/..%2f..%2fpackage.json']) {
      const res = await app.request(p);
      expect(res.status, p).toBe(404);
    }
    // `%2e%2e` segments are normalized by the URL parser to /etc/passwd: not a file in the root -> hash redirect, no file
    const dotted = await app.request('/%2e%2e/%2e%2e/etc/passwd');
    expect(dotted.status).toBe(302);
    expect(dotted.headers.get('location')).toBe('/#/etc/passwd');
    const r = await app.request('/videos?mode=upload&range=last7d');
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/#/videos?mode=upload&range=last7d');
  });

  it('/data/dataset.json falls back to the export dir file when nothing is loaded in memory', async () => {
    writeFileSync(join(dataDir, 'dataset.json'), '{"schemaVersion":1}');
    const app = createApp({ getIndex: () => null, webDistDir: dist, dataDir, rateLimit: false });
    const res = await app.request('/data/dataset.json');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"schemaVersion":1}');
    const none = createApp({ getIndex: () => null, webDistDir: dist, rateLimit: false });
    expect((await none.request('/data/dataset.json')).status).toBe(404);
  });

  it('without a web build, "/" explains how to build and the API still works', async () => {
    const app = makeApp();
    const res = await app.request('/');
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('npm run build');
    expect((await app.request('/api/v1/meta')).status).toBe(200);
  });
});
