/**
 * Hono app factory for the Video Trend Intel API + static web build. OWNER: server.
 *
 *   createApp({ getIndex, getCompact, webDistDir, dataDir })
 *
 * - REST API under /api/v1 (GET/HEAD only; see openapi.ts), computed with @vti/core over the in-memory index.
 * - CORS: any origin may GET the API and /data/*.
 * - Conditional requests: every /api/v1 response carries a weak ETag derived from the dataset's generatedAt
 *   (+ API_VERSION) and is answered with 304 before any work when it matches; Cache-Control allows a short
 *   public cache (the dataset changes every few hours).
 * - Per-IP token-bucket rate limit on /api/* (default 120 requests/minute; /api/v1/health is exempt).
 * - JSON errors everywhere under /api: { error: { status, code, message (ko), messageEn, param? } }.
 * - Security headers on every response; the SPA shell gets a strict CSP with hashed inline scripts.
 * - Static: apps/web/dist (index.html + hashed assets) and /data/dataset.json (the loaded dataset, gzip).
 * - Static-API parity: the GitHub Pages files written by static-api.ts (index.json, meta.json,
 *   videos/<mode>/top-<preset>-<platform>.json, ...) are answered live under /api/v1/<path>.
 */
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { compress } from 'hono/compress';
import { cors } from 'hono/cors';
import type { DatasetIndex } from '@vti/core';
import { API_PREFIX, API_VERSION, errorBody, isoOf, ResponseCache, toErrorResponse, type RouteDeps } from './routes/common.ts';
import { DatasetEncoder, datasetResponse, type CompactSource } from './routes/dataset.ts';
import { etagMatches, StaticFiles } from './routes/web.ts';
import { registerMeta } from './routes/meta.ts';
import { registerVideos } from './routes/videos.ts';
import { registerTrending } from './routes/trending.ts';
import { registerExplore } from './routes/explore.ts';
import { registerCreators } from './routes/creators.ts';
import { registerTaxonomy } from './routes/taxonomy.ts';
import { registerCoverage } from './routes/coverage.ts';
import { buildOpenApi } from './openapi.ts';
import { serializeStatic, staticApiEntries, staticIndex, type StaticEntry } from './static-api.ts';

export type { CompactSource } from './routes/dataset.ts';

export interface AppLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface RateLimitOptions {
  /** Sustained requests per minute per client IP. */
  perMinute: number;
  /** Bucket size (default = perMinute). */
  burst?: number;
}

export interface CreateAppOptions {
  /** The current dataset index (null while nothing is loaded -> 503 on data routes). */
  getIndex: () => DatasetIndex | null;
  /** The compact dataset for /api/v1/dataset and /data/dataset.json (object, JSON text or raw file bytes). */
  getCompact?: () => CompactSource | null;
  /** Web build to serve (apps/web/dist). null/undefined = API only. */
  webDistDir?: string | null;
  /** Data export dir (data/export): fallback for /data/dataset.json and source of /data/meta.json. */
  dataDir?: string | null;
  /** false disables rate limiting. Default { perMinute: 120 }. */
  rateLimit?: RateLimitOptions | false;
  /** Trust X-Forwarded-For / X-Real-IP for the client IP (behind a reverse proxy). Default false. */
  trustProxy?: boolean;
  /** Extra fields for /api/v1/health (loader / scheduler state). */
  getStatus?: () => Record<string, unknown>;
  /** Response cache size in bytes (0 disables). Default 48 MB. */
  cacheBytes?: number;
  clock?: () => number;
  log?: AppLogger;
}

/* ------------------------------------------------------------------------------------------
 * Rate limiting
 * ---------------------------------------------------------------------------------------- */

/** Token bucket per key: `burst` tokens, refilled continuously at perMinute / 60 s. */
export class TokenBucketLimiter {
  private readonly buckets = new Map<string, { tokens: number; t: number }>();
  readonly burst: number;

  constructor(
    readonly perMinute: number,
    burst?: number,
    private readonly clock: () => number = Date.now,
    readonly maxKeys = 50_000,
  ) {
    this.burst = Math.max(1, burst ?? perMinute);
  }

  take(key: string): { ok: boolean; remaining: number; retryAfterSec: number } {
    const now = this.clock();
    const rate = this.perMinute / 60_000;
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) this.prune(now);
      b = { tokens: this.burst, t: now };
      this.buckets.set(key, b);
    } else {
      b.tokens = Math.min(this.burst, b.tokens + Math.max(0, now - b.t) * rate);
      b.t = now;
    }
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { ok: true, remaining: Math.floor(b.tokens), retryAfterSec: 0 };
    }
    return { ok: false, remaining: 0, retryAfterSec: Math.max(1, Math.ceil((1 - b.tokens) / rate / 1000)) };
  }

  /** Drop buckets that are full again (idle clients); if still too many, drop the oldest half. */
  prune(now: number = this.clock()): void {
    const rate = this.perMinute / 60_000;
    for (const [k, b] of this.buckets) if (b.tokens + (now - b.t) * rate >= this.burst) this.buckets.delete(k);
    if (this.buckets.size >= this.maxKeys) {
      let drop = Math.ceil(this.buckets.size / 2);
      for (const k of this.buckets.keys()) {
        if (drop-- <= 0) break;
        this.buckets.delete(k);
      }
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}

/** Client address: X-Forwarded-For / X-Real-IP when trusted, else the socket address. */
export function clientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = c.req.header('x-forwarded-for');
    if (xff) {
      const first = xff.split(',')[0]?.trim();
      if (first) return first;
    }
    const real = c.req.header('x-real-ip')?.trim();
    if (real) return real;
  }
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress ?? 'unknown';
}

/* ------------------------------------------------------------------------------------------
 * Headers
 * ---------------------------------------------------------------------------------------- */

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Origin-Agent-Cluster': '?1',
  'X-DNS-Prefetch-Control': 'off',
};
const NON_HTML_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";
export const API_CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=300';
const EXPOSED_HEADERS = ['ETag', 'Content-Disposition', 'Retry-After', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-Total-Count', 'X-Data-Generated-At'];

function setIfAbsent(res: Response, name: string, value: string) {
  if (!res.headers.has(name)) res.headers.set(name, value);
}

function jsonError(c: Context, status: number, code: string, ko: string, en: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return c.json(errorBody(status, code, ko, en, extra), status as 400, { 'Cache-Control': 'no-store', ...headers });
}

/** ETag of every dataset-derived API response. */
export function datasetEtag(index: DatasetIndex, scope = 'api'): string {
  return `W/"vti-${scope}-${API_VERSION}-${index.dataset.generatedAt.toString(36)}"`;
}

/* ------------------------------------------------------------------------------------------
 * Static-API parity: the GitHub Pages files (static-api.ts) served live under the same paths
 * ---------------------------------------------------------------------------------------- */

interface StaticState {
  entries: Map<string, StaticEntry>;
  bodies: Map<string, string>;
  index: string | null;
}

const staticStates = new WeakMap<DatasetIndex, StaticState>();

function staticState(index: DatasetIndex): StaticState {
  let st = staticStates.get(index);
  if (!st) {
    st = { entries: new Map(staticApiEntries(index).map((e) => [e.path, e])), bodies: new Map(), index: null };
    staticStates.set(index, st);
  }
  return st;
}

/** Serialized body of one static file (`index.json` builds every file once to report sizes). Null = unknown path. */
export function staticBody(index: DatasetIndex, path: string): string | null {
  const st = staticState(index);
  const one = (p: string): string => {
    let b = st.bodies.get(p);
    if (b === undefined) {
      b = serializeStatic(st.entries.get(p)!.build());
      st.bodies.set(p, b);
    }
    return b;
  };
  if (path === 'index.json') {
    st.index ??= serializeStatic(
      staticIndex(
        index,
        [...st.entries.values()].map((e) => ({ path: e.path, description: e.description, bytes: Buffer.byteLength(one(e.path), 'utf8') })),
        'Asia/Seoul',
      ),
    );
    return st.index;
  }
  return st.entries.has(path) ? one(path) : null;
}

/* ------------------------------------------------------------------------------------------
 * App
 * ---------------------------------------------------------------------------------------- */

export function createApp(opts: CreateAppOptions): Hono {
  const clock = opts.clock ?? Date.now;
  const startedAt = clock();
  const log = opts.log;
  const trustProxy = opts.trustProxy ?? false;
  const cache = new ResponseCache(opts.cacheBytes ?? 48_000_000);
  const deps: RouteDeps = { getIndex: opts.getIndex, cache };
  const encoder = new DatasetEncoder();
  const files = new StaticFiles();
  const limiter = opts.rateLimit === false ? null : new TokenBucketLimiter(opts.rateLimit?.perMinute ?? 120, opts.rateLimit?.burst, clock);
  let openapi: string | null = null;

  const app = new Hono();

  const onError = (err: unknown, c: Context) => {
    const { status, body } = toErrorResponse(err);
    if (status >= 500) log?.error(`${c.req.method} ${c.req.path} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
    if (status === 503) headers['Retry-After'] = '30';
    return c.json(body, status as 400, headers);
  };
  app.onError(onError);

  // Security headers (all responses).
  app.use('*', async (c, next) => {
    await next();
    const res = c.res;
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) setIfAbsent(res, k, v);
    setIfAbsent(res, 'Content-Security-Policy', NON_HTML_CSP);
    const shared = c.req.path.startsWith('/api/') || c.req.path === '/api' || c.req.path.startsWith('/data/');
    setIfAbsent(res, 'Cross-Origin-Resource-Policy', shared ? 'cross-origin' : 'same-origin');
  });

  app.use('*', compress());

  const corsMw = cors({ origin: '*', allowMethods: ['GET', 'HEAD', 'OPTIONS'], allowHeaders: ['If-None-Match', 'Accept', 'Accept-Encoding', 'Content-Type'], exposeHeaders: EXPOSED_HEADERS, maxAge: 86_400 });
  app.use('/api/*', corsMw);
  app.use('/api', corsMw);
  app.use('/data/*', corsMw);

  // Read-only API: anything but GET / HEAD / OPTIONS is 405.
  const methodGuard: MiddlewareHandler = async (c, next) => {
    const m = c.req.method;
    if (m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS') {
      return jsonError(c, 405, 'method_not_allowed', `허용되지 않는 메서드입니다: ${m}. 이 API는 읽기 전용(GET)입니다.`, `Method ${m} not allowed. This API is read-only (GET).`, {}, { Allow: 'GET, HEAD, OPTIONS' });
    }
    return next();
  };
  app.use('/api/*', methodGuard);
  app.use('/api', methodGuard);

  // Rate limit.
  if (limiter) {
    app.use('/api/*', async (c, next) => {
      if (c.req.method === 'OPTIONS' || c.req.path === `${API_PREFIX}/health`) return next();
      const r = limiter.take(clientIp(c, trustProxy));
      if (!r.ok) {
        return jsonError(
          c,
          429,
          'rate_limited',
          `요청이 너무 많습니다. ${r.retryAfterSec}초 후 다시 시도하세요 (IP당 분당 ${limiter.perMinute}회).`,
          `Too many requests. Retry in ${r.retryAfterSec}s (limit ${limiter.perMinute}/min per IP).`,
          { retryAfterSec: r.retryAfterSec },
          { 'Retry-After': String(r.retryAfterSec), 'X-RateLimit-Limit': String(limiter.perMinute), 'X-RateLimit-Remaining': '0' },
        );
      }
      await next();
      c.res.headers.set('X-RateLimit-Limit', String(limiter.perMinute));
      c.res.headers.set('X-RateLimit-Remaining', String(r.remaining));
    });
  }

  // Conditional GET + caching headers for dataset-derived API responses.
  app.use(`${API_PREFIX}/*`, async (c, next) => {
    const m = c.req.method;
    if ((m !== 'GET' && m !== 'HEAD') || c.req.path === `${API_PREFIX}/health`) {
      await next();
      if (c.req.path === `${API_PREFIX}/health`) c.res.headers.set('Cache-Control', 'no-store');
      return;
    }
    const index = opts.getIndex();
    if (!index) {
      await next();
      c.res.headers.set('Cache-Control', 'no-store');
      return;
    }
    const tag = datasetEtag(index);
    const generated = isoOf(index.dataset.generatedAt) ?? '';
    if (etagMatches(c.req.header('if-none-match'), tag)) {
      return c.body(null, 304, { ETag: tag, 'Cache-Control': API_CACHE_CONTROL, 'X-Data-Generated-At': generated });
    }
    await next();
    if (c.res.status === 200) {
      c.res.headers.set('ETag', tag);
      c.res.headers.set('Cache-Control', API_CACHE_CONTROL);
      c.res.headers.set('X-Data-Generated-At', generated);
    } else if (!c.res.headers.has('Cache-Control')) {
      c.res.headers.set('Cache-Control', 'no-store');
    }
  });

  /* ---------------------------------------------------------------- API routes */
  const api = new Hono();
  api.onError(onError);

  // Static-API files (index.json, meta.json, videos/<mode>/top-<preset>-<platform>.json, ...) computed live.
  api.use('*', async (c, next) => {
    const path = c.req.path;
    if ((c.req.method !== 'GET' && c.req.method !== 'HEAD') || !path.endsWith('.json') || path === `${API_PREFIX}/openapi.json`) return next();
    const index = opts.getIndex();
    if (!index) return next();
    const body = staticBody(index, path.slice(API_PREFIX.length + 1));
    if (body === null) return next();
    return c.body(body, 200, { 'Content-Type': 'application/json; charset=utf-8' });
  });

  api.get('/', (c) =>
    c.json({
      name: 'Video Trend Intel API',
      apiVersion: API_VERSION,
      openapi: `${API_PREFIX}/openapi.json`,
      docs: '/#/api-docs',
      endpoints: [
        `${API_PREFIX}/health`,
        `${API_PREFIX}/meta`,
        `${API_PREFIX}/videos`,
        `${API_PREFIX}/videos/{id}`,
        `${API_PREFIX}/trending`,
        `${API_PREFIX}/explore`,
        `${API_PREFIX}/creators`,
        `${API_PREFIX}/creators/{key}`,
        `${API_PREFIX}/taxonomy`,
        `${API_PREFIX}/coverage`,
        `${API_PREFIX}/dataset`,
        `${API_PREFIX}/openapi.json`,
        `${API_PREFIX}/index.json`,
      ],
    }),
  );

  api.get('/health', (c) => {
    const index = opts.getIndex();
    const now = clock();
    return c.json({
      status: index ? 'ok' : 'starting',
      apiVersion: API_VERSION,
      time: isoOf(now),
      uptimeSec: Math.round((now - startedAt) / 1000),
      dataset: index
        ? {
            generatedAt: index.dataset.generatedAt,
            generatedAtIso: isoOf(index.dataset.generatedAt),
            ageMinutes: Math.round((now - index.dataset.generatedAt) / 60_000),
            videos: index.dataset.videos.length,
            accounts: index.dataset.accounts.length,
          }
        : null,
      cache: { entries: cache.size, hits: cache.hits, misses: cache.misses },
      ...(opts.getStatus?.() ?? {}),
    });
  });

  api.get('/openapi.json', (c) => {
    openapi ??= JSON.stringify(buildOpenApi());
    return c.body(openapi, 200, { 'Content-Type': 'application/json; charset=utf-8' });
  });

  api.get('/dataset', async (c) => {
    const src = opts.getCompact?.() ?? null;
    if (!src) {
      return jsonError(c, 503, 'dataset_unavailable', '데이터셋이 아직 로드되지 않았습니다.', 'The dataset is not loaded yet.', {}, { 'Retry-After': '30' });
    }
    const enc = await encoder.encode(src);
    return datasetResponse(c, enc, { 'Content-Disposition': 'inline; filename="dataset.json"' });
  });

  registerMeta(api, deps);
  registerVideos(api, deps);
  registerTrending(api, deps);
  registerExplore(api, deps);
  registerCreators(api, deps);
  registerTaxonomy(api, deps);
  registerCoverage(api, deps);

  app.route(API_PREFIX, api);

  /* ---------------------------------------------------------------- data + web */
  app.get('/data/dataset.json', async (c) => {
    const src = opts.getCompact?.() ?? null;
    const index = opts.getIndex();
    if (src && index) {
      const tag = datasetEtag(index, 'data');
      const headers = { ETag: tag, 'Cache-Control': 'no-cache', 'X-Data-Generated-At': isoOf(index.dataset.generatedAt) ?? '' };
      if (etagMatches(c.req.header('if-none-match'), tag)) return c.body(null, 304, headers);
      return datasetResponse(c, await encoder.encode(src), headers);
    }
    const res = (await files.serve(c, opts.dataDir, '/dataset.json')) ?? (await files.serve(c, opts.webDistDir, '/data/dataset.json'));
    return res ?? c.json(errorBody(404, 'not_found', '데이터셋 파일이 없습니다.', 'Dataset file not found.'), 404);
  });

  app.get('/data/meta.json', async (c) => {
    const res = (await files.serve(c, opts.dataDir, '/meta.json')) ?? (await files.serve(c, opts.webDistDir, '/data/meta.json'));
    return res ?? c.json(errorBody(404, 'not_found', '파일이 없습니다.', 'File not found.'), 404);
  });

  app.get('*', async (c) => {
    const path = c.req.path;
    if (path === '/api' || path.startsWith('/api/')) {
      return jsonError(c, 404, 'not_found', `API 경로가 없습니다: ${path}`, `No such API route: ${path}`);
    }
    const target = path === '/' ? '/index.html' : path;
    const res = await files.serve(c, opts.webDistDir, target);
    if (res) return res;
    if (path === '/' || path === '/index.html') {
      return c.text('웹 빌드(apps/web/dist)가 없습니다. `npm run build` 후 서버를 다시 시작하세요. API는 /api/v1 에서 사용할 수 있습니다.\n', 404);
    }
    // Deep links without the hash (e.g. /videos?mode=upload) -> the HashRouter route.
    const last = path.split('/').pop() ?? '';
    if (opts.webDistDir && !last.includes('.') && path.length < 512 && /^[\w\-/%:.~]*$/.test(path)) {
      const search = new URL(c.req.url).search;
      return c.redirect(`/#${path}${search}`, 302);
    }
    return c.text('찾을 수 없습니다 (404).\n', 404);
  });

  app.notFound((c) => {
    if (c.req.path.startsWith('/api')) return jsonError(c, 404, 'not_found', `API 경로가 없습니다: ${c.req.path}`, `No such API route: ${c.req.path}`);
    return c.text('찾을 수 없습니다 (404).\n', 404);
  });

  return app;
}
