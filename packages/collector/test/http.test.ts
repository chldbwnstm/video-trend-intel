import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_USER_AGENT,
  HostRateLimiter,
  HttpError,
  NetworkError,
  createHttpClient,
  isRetryableStatus,
  parseRetryAfter,
  redactUrl,
} from '../src/http.ts';
import { errorBody, httpStatusOf } from '../src/sources/util.ts';
import { describeHttpError } from '../src/sources/keyed-util.ts';

interface Hit {
  path: string;
  method: string;
  headers: IncomingMessage['headers'];
  body: string;
  at: number;
}

type Handler = (req: IncomingMessage, res: ServerResponse, body: string, n: number) => void;

let server: Server;
let base: string;
let hits: Hit[] = [];
const handlers = new Map<string, Handler>();
const counts = new Map<string, number>();

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const path = (req.url ?? '/').split('?')[0];
      hits.push({ path, method: req.method ?? 'GET', headers: req.headers, body, at: Date.now() });
      const n = (counts.get(path) ?? 0) + 1;
      counts.set(path, n);
      const h = handlers.get(path);
      if (h) h(req, res, body, n);
      else {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('no handler');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  hits = [];
  handlers.clear();
  counts.clear();
});

const json = (res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(value));
};

/** Fast client for tests: tiny backoff, generous rate. */
const fastClient = (extra: Parameters<typeof createHttpClient>[0] = {}) =>
  createHttpClient({ backoffBaseMs: 5, maxBackoffMs: 20, defaultRps: 1000, perHostRps: { '127.0.0.1': 1000 }, random: () => 0.5, ...extra });

describe('createHttpClient: basics', () => {
  it('sends the descriptive User-Agent and Accept headers and parses JSON', async () => {
    handlers.set('/ok', (_req, res) => json(res, 200, { hello: '세계' }));
    const http = fastClient();
    await expect(http.getJson('/ok'.replace(/^/, base))).resolves.toEqual({ hello: '세계' });
    expect(hits[0].headers['user-agent']).toBe(DEFAULT_USER_AGENT);
    expect(DEFAULT_USER_AGENT).toBe('VideoTrendIntel/0.1 (+https://github.com/chldbwnstm/video-trend-intel)');
    expect(hits[0].headers.accept).toBe('application/json');
    expect(http.requestCount).toBe(1);
    expect(http.retryCount).toBe(0);
  });

  it('getText returns the raw body; caller headers override defaults case-insensitively', async () => {
    handlers.set('/text', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/xml' });
      res.end('<feed/>');
    });
    const http = fastClient();
    await expect(http.getText(`${base}/text`, { headers: { accept: 'text/xml', 'X-Test': '1' } })).resolves.toBe('<feed/>');
    expect(hits[0].headers.accept).toBe('text/xml');
    expect(hits[0].headers['x-test']).toBe('1');
    expect(hits[0].headers['user-agent']).toBe(DEFAULT_USER_AGENT);
  });

  it('supports POST with a body (token endpoints, TikTok queries)', async () => {
    handlers.set('/post', (req, res, body) => json(res, 200, { method: req.method, body, type: req.headers['content-type'] }));
    const http = fastClient();
    const out = await http.getJson<{ method: string; body: string; type: string }>(`${base}/post`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'a=1&b=2',
    });
    expect(out).toEqual({ method: 'POST', body: 'a=1&b=2', type: 'application/x-www-form-urlencoded' });
  });

  it('throws HttpError with status, body and headers on 4xx without retrying', async () => {
    handlers.set('/missing', (_req, res) => json(res, 404, { error: { type: 'not_found', message: 'gone' } }, { 'x-rate': '5' }));
    const http = fastClient();
    const err = await http.getJson(`${base}/missing?api_key=SECRET123`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    const e = err as HttpError;
    expect(e.status).toBe(404);
    expect(e.body).toContain('not_found');
    expect(e.headers['x-rate']).toBe('5');
    expect(e.message).toMatch(/^HTTP 404 Not Found GET/);
    expect(e.message).toContain('not_found');
    expect(e.message).not.toContain('SECRET123');
    expect(e.url).toContain('api_key=***');
    expect(http.requestCount).toBe(1);
    // Adapter helpers can read the error shape.
    expect(httpStatusOf(e)).toBe(404);
    expect(errorBody(e)).toContain('not_found');
    expect(describeHttpError(e).status).toBe(404);
    expect((describeHttpError(e).body as { error: { type: string } }).error.type).toBe('not_found');
  });

  it('throws on invalid JSON with a body excerpt', async () => {
    handlers.set('/html', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>consent</html>');
    });
    const http = fastClient();
    await expect(http.getJson(`${base}/html`)).rejects.toThrow(/invalid JSON .*consent/);
  });

  it('rejects invalid URLs and GET bodies without making a request; a body alone implies POST', async () => {
    const http = fastClient();
    await expect(http.getText('not a url')).rejects.toThrow(/invalid URL/);
    await expect(http.getJson(`${base}/x`, { method: 'GET', body: '{}' })).rejects.toThrow(/cannot have a body/);
    expect(http.requestCount).toBe(0);
    handlers.set('/implied', (req, res) => json(res, 200, { method: req.method }));
    await expect(http.getJson(`${base}/implied`, { body: '{}' })).resolves.toEqual({ method: 'POST' });
  });
});

describe('createHttpClient: retries', () => {
  it('retries 5xx with backoff and succeeds', async () => {
    handlers.set('/flaky', (_req, res, _b, n) => (n < 3 ? json(res, 503, { err: n }) : json(res, 200, { ok: true })));
    const sleeps: number[] = [];
    const http = fastClient({ sleep: async (ms) => void sleeps.push(ms) });
    await expect(http.getJson(`${base}/flaky`)).resolves.toEqual({ ok: true });
    expect(http.requestCount).toBe(3);
    expect(http.retryCount).toBe(2);
    // exponential: 5ms, 10ms (random 0.5 => no jitter); rate-limiter waits (~1ms at 1000 rps) are ignored
    expect(sleeps.filter((s) => s >= 5)).toEqual([5, 10]);
  });

  it('gives up after `retries` and throws the last HttpError', async () => {
    handlers.set('/down', (_req, res) => json(res, 500, { err: 'boom' }));
    const http = fastClient({ retries: 2 });
    const err = (await http.getText(`${base}/down`).catch((e: unknown) => e)) as HttpError;
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(500);
    expect(err.attempts).toBe(3);
    expect(err.message).toContain('(3 attempts)');
    expect(http.requestCount).toBe(3);
  });

  it('honours Retry-After on 429 (seconds) and slows the host down', async () => {
    handlers.set('/limited', (_req, res, _b, n) => (n === 1 ? json(res, 429, { err: 'slow down' }, { 'retry-after': '1' }) : json(res, 200, { ok: n })));
    const http = fastClient();
    const t0 = Date.now();
    await expect(http.getJson(`${base}/limited`)).resolves.toEqual({ ok: 2 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(950);
    expect(hits[1].at - hits[0].at).toBeGreaterThanOrEqual(950);
  });

  it('does not wait for a Retry-After beyond maxRetryAfterMs', async () => {
    handlers.set('/quota', (_req, res) => json(res, 429, { err: 'quota' }, { 'retry-after': '3600' }));
    const http = fastClient({ maxRetryAfterMs: 1000 });
    const t0 = Date.now();
    const err = (await http.getJson(`${base}/quota`).catch((e: unknown) => e)) as HttpError;
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(3_600_000);
    expect(http.requestCount).toBe(1);
    expect(Date.now() - t0).toBeLessThan(900);
  });

  it('times out slow responses (AbortController) and retries them', async () => {
    handlers.set('/slow', (_req, res, _b, n) => {
      if (n === 1) setTimeout(() => json(res, 200, { late: true }), 400);
      else json(res, 200, { fast: true });
    });
    const http = fastClient({ timeoutMs: 100 });
    await expect(http.getJson(`${base}/slow`)).resolves.toEqual({ fast: true });
    expect(http.requestCount).toBe(2);
  });

  it('throws NetworkError (timedOut) when every attempt times out', async () => {
    handlers.set('/hang', (_req, res) => setTimeout(() => json(res, 200, {}), 500));
    const http = fastClient({ timeoutMs: 60, retries: 1 });
    const err = (await http.getJson(`${base}/hang`).catch((e: unknown) => e)) as NetworkError;
    expect(err).toBeInstanceOf(NetworkError);
    expect(err.timedOut).toBe(true);
    expect(err.message).toMatch(/timeout after 60ms/);
    expect(http.requestCount).toBe(2);
  });

  it('retries connection failures and throws NetworkError', async () => {
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const http = fastClient({ retries: 2 });
    const err = (await http.getText(`http://127.0.0.1:${port}/x?access_token=abcdef123456`).catch((e: unknown) => e)) as NetworkError;
    expect(err).toBeInstanceOf(NetworkError);
    expect(err.timedOut).toBe(false);
    expect(err.attempts).toBe(3);
    expect(err.message).not.toContain('abcdef123456');
    expect(http.requestCount).toBe(3);
  });
});

describe('createHttpClient: rate limiting', () => {
  it('spaces sequential requests to the same host by 1/rps', async () => {
    handlers.set('/r', (_req, res) => json(res, 200, {}));
    const http = createHttpClient({ perHostRps: { '127.0.0.1': 10 } });
    for (let i = 0; i < 4; i++) await http.getJson(`${base}/r`);
    const gaps = hits.slice(1).map((h, i) => h.at - hits[i].at);
    // Server-side arrival times jitter under load; the limiter spaces sends, so assert the total span tightly.
    expect(hits[hits.length - 1].at - hits[0].at).toBeGreaterThanOrEqual(270);
    for (const g of gaps) expect(g).toBeGreaterThanOrEqual(50);
  });

  it('serializes concurrent requests to one host', async () => {
    handlers.set('/c', (_req, res) => json(res, 200, {}));
    const http = createHttpClient({ perHostRps: { '127.0.0.1': 10 } });
    const t0 = Date.now();
    await Promise.all([0, 1, 2, 3].map(() => http.getJson(`${base}/c`)));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(290);
    const times = hits.map((h) => h.at).sort((a, b) => a - b);
    // Arrival times at the test server jitter with event-loop load (full parallel suite / CI), so check the
    // overall spacing tightly and each gap loosely: without serialization all four would arrive together.
    expect(times[times.length - 1] - times[0]).toBeGreaterThanOrEqual(270);
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(50);
  });

  it('shares a limiter between clients', async () => {
    handlers.set('/s', (_req, res) => json(res, 200, {}));
    const limiter = new HostRateLimiter({ '127.0.0.1': 10 });
    const a = createHttpClient({ limiter });
    const b = createHttpClient({ limiter });
    await Promise.all([a.getJson(`${base}/s`), b.getJson(`${base}/s`), a.getJson(`${base}/s`)]);
    const times = hits.map((h) => h.at).sort((x, y) => x - y);
    expect(times[2] - times[0]).toBeGreaterThanOrEqual(180);
    expect(a.requestCount).toBe(2);
    expect(b.requestCount).toBe(1);
  });
});

describe('HostRateLimiter', () => {
  it('uses SPEC defaults per host and a default for others', () => {
    const l = new HostRateLimiter();
    expect(l.rateFor('www.youtube.com')).toBe(2);
    expect(l.rateFor('api.dailymotion.com')).toBe(4);
    expect(l.rateFor('sepiasearch.org')).toBe(1);
    expect(l.rateFor('snapshot.search.nicovideo.jp')).toBe(1);
    expect(l.rateFor('example.org')).toBe(2);
    expect(new HostRateLimiter({ 'example.org': 5 }, 3).rateFor('EXAMPLE.org')).toBe(5);
    expect(new HostRateLimiter({}, 3).rateFor('other.org')).toBe(3);
  });

  it('reserves slots with a minimum interval (fake clock)', () => {
    let now = 1000;
    const l = new HostRateLimiter({ 'a.test': 4 }, 2, () => now);
    expect(l.reserve('a.test')).toBe(0);
    expect(l.reserve('a.test')).toBe(250);
    expect(l.reserve('a.test')).toBe(500);
    expect(l.reserve('b.test')).toBe(0); // other host independent
    now += 2000;
    expect(l.reserve('a.test')).toBe(0);
    l.penalize('a.test', 5000);
    expect(l.reserve('a.test')).toBe(5000);
  });
});

describe('helpers', () => {
  it('parseRetryAfter handles seconds, HTTP dates and garbage', () => {
    const now = Date.parse('2026-09-29T00:00:00Z');
    expect(parseRetryAfter('2', now)).toBe(2000);
    expect(parseRetryAfter('0', now)).toBe(0);
    expect(parseRetryAfter('Tue, 29 Sep 2026 00:00:30 GMT', now)).toBe(30_000);
    expect(parseRetryAfter('Mon, 28 Sep 2026 00:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfter('soon', now)).toBeNull();
    expect(parseRetryAfter(null, now)).toBeNull();
  });

  it('isRetryableStatus', () => {
    expect([408, 425, 429, 500, 502, 503, 504].every(isRetryableStatus)).toBe(true);
    expect([400, 401, 403, 404, 410, 501].some(isRetryableStatus)).toBe(false);
  });

  it('redactUrl hides secret query parameters and credentials', () => {
    expect(redactUrl('https://www.googleapis.com/youtube/v3/videos?id=a&key=AIzaSECRET')).toBe('https://www.googleapis.com/youtube/v3/videos?id=a&key=***');
    expect(redactUrl('https://graph.facebook.com/v20.0/1?fields=x&access_token=EAAB')).toContain('access_token=***');
    expect(redactUrl('https://x.test/?client_secret=s&client_id=c')).toContain('client_secret=***');
    expect(redactUrl('https://user:pass@x.test/p')).toBe('https://***:***@x.test/p');
    expect(redactUrl('https://api.dailymotion.com/videos?country=kr')).toBe('https://api.dailymotion.com/videos?country=kr');
  });
});
