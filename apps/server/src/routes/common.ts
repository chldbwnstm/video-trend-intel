/**
 * Shared helpers for the API routes: JSON serializers (stable field order), error bodies, the per-dataset
 * response cache. OWNER: server.
 */
import type { Context } from 'hono';
import {
  PLATFORM_LABELS,
  categoryPathLabel,
  formatInTz,
  latestFollowers,
  localDateOf,
} from '@vti/core';
import type { Account, DatasetIndex, MetricValue, UtcWindow, Video, VideoMetrics, VideoRow } from '@vti/core';
import { ParamError } from '../params.ts';

/** Bumped when the response shape changes (part of every ETag). */
export const API_VERSION = '1.0.0';
export const API_PREFIX = '/api/v1';

/* ------------------------------------------------------------------------------------------
 * Route context
 * ---------------------------------------------------------------------------------------- */

export interface RouteDeps {
  getIndex: () => DatasetIndex | null;
  cache: ResponseCache;
}

/** The loaded index, or a 503 HttpError. */
export function requireIndex(deps: RouteDeps): DatasetIndex {
  const index = deps.getIndex();
  if (!index) {
    throw new HttpError(
      503,
      'dataset_unavailable',
      '데이터셋이 아직 로드되지 않았습니다. 첫 수집·내보내기가 끝나면 다시 시도하세요 (/api/v1/health).',
      'The dataset is not loaded yet. Retry after the first collection/export finishes (see /api/v1/health).',
    );
  }
  return index;
}

/* ------------------------------------------------------------------------------------------
 * Errors
 * ---------------------------------------------------------------------------------------- */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly messageKo: string,
    readonly messageEn: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(messageEn);
    this.name = 'HttpError';
  }
}

export interface ErrorBody {
  error: { status: number; code: string; param?: string | null; message: string; messageEn: string } & Record<string, unknown>;
}

export function errorBody(status: number, code: string, messageKo: string, messageEn: string, extra: Record<string, unknown> = {}): ErrorBody {
  return { error: { status, code, message: messageKo, messageEn, ...extra } };
}

/** Convert anything thrown by a handler into (status, body). RangeErrors from @vti/core are client errors. */
export function toErrorResponse(err: unknown): { status: number; body: ErrorBody } {
  if (err instanceof ParamError) {
    return { status: 400, body: errorBody(400, err.code, err.messageKo, err.messageEn, { param: err.param }) };
  }
  if (err instanceof HttpError) {
    return { status: err.status, body: errorBody(err.status, err.code, err.messageKo, err.messageEn, err.extra) };
  }
  if (err instanceof RangeError) {
    return { status: 400, body: errorBody(400, 'invalid_request', `요청을 처리할 수 없습니다: ${err.message}`, `Invalid request: ${err.message}`) };
  }
  return { status: 500, body: errorBody(500, 'internal_error', '서버 오류가 발생했습니다.', 'Internal server error.') };
}

/* ------------------------------------------------------------------------------------------
 * Response cache (per dataset version, byte-bounded LRU)
 * ---------------------------------------------------------------------------------------- */

export interface CachedResponse {
  body: string;
  contentType: string;
  headers?: Record<string, string>;
}

export class ResponseCache {
  private readonly map = new Map<string, CachedResponse & { bytes: number }>();
  private bytes = 0;
  private version: unknown = null;
  hits = 0;
  misses = 0;

  constructor(readonly maxBytes = 48_000_000, readonly maxEntryBytes = 4_000_000) {}

  /** Drop everything when the dataset changes. */
  private sync(version: unknown) {
    if (version !== this.version) {
      this.map.clear();
      this.bytes = 0;
      this.version = version;
    }
  }

  get(version: unknown, key: string): CachedResponse | undefined {
    this.sync(version);
    const hit = this.map.get(key);
    if (!hit) {
      this.misses++;
      return undefined;
    }
    this.hits++;
    this.map.delete(key);
    this.map.set(key, hit);
    return hit;
  }

  set(version: unknown, key: string, value: CachedResponse): void {
    this.sync(version);
    const bytes = value.body.length * 2 + key.length * 2 + 256;
    if (bytes > this.maxEntryBytes || this.maxBytes <= 0) return;
    const old = this.map.get(key);
    if (old) {
      this.bytes -= old.bytes;
      this.map.delete(key);
    }
    this.map.set(key, { ...value, bytes });
    this.bytes += bytes;
    for (const [k, v] of this.map) {
      if (this.bytes <= this.maxBytes) break;
      this.map.delete(k);
      this.bytes -= v.bytes;
    }
  }

  get size(): number {
    return this.map.size;
  }
}

/** Cache key: path + sorted query (so parameter order does not matter). */
export function cacheKeyOf(c: Context): string {
  const url = new URL(c.req.url);
  const entries = [...url.searchParams.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return `${url.pathname}?${entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}`;
}

/**
 * Serve a JSON payload built by `build`, cached per dataset version + request URL. `build` may throw
 * (ParamError / HttpError); errors are not cached.
 */
export function sendJson(c: Context, deps: RouteDeps, build: (index: DatasetIndex) => unknown): Response {
  const index = requireIndex(deps);
  const key = cacheKeyOf(c);
  let hit = deps.cache.get(index, key);
  if (!hit) {
    hit = { body: JSON.stringify(build(index)), contentType: 'application/json; charset=utf-8' };
    deps.cache.set(index, key, hit);
  }
  return respond(c, hit);
}

export function respond(c: Context, r: CachedResponse, status = 200): Response {
  const headers: Record<string, string> = { 'Content-Type': r.contentType, ...(r.headers ?? {}) };
  return c.body(r.body, status as 200, headers);
}

/* ------------------------------------------------------------------------------------------
 * Serializers
 * ---------------------------------------------------------------------------------------- */

export function isoOf(ms: number | null | undefined): string | null {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function windowJson(w: UtcWindow | null, rollingHours: number | null = null) {
  if (!w) return null;
  return {
    startMs: w.startMs,
    endMs: w.endMs,
    start: isoOf(w.startMs),
    end: isoOf(w.endMs),
    tz: w.tz,
    /** Inclusive local dates covered by the window in `tz`. */
    startLocal: formatInTz(w.startMs, w.tz, 'datetime'),
    endLocal: formatInTz(w.endMs, w.tz, 'datetime'),
    firstDate: localDateOf(w.startMs, w.tz),
    lastDate: localDateOf(Math.max(w.startMs, w.endMs - 1), w.tz),
    rollingHours,
    incomplete: w.incomplete,
  };
}

/** Plain MetricValue (drops extra fields unless listed). */
export function metricJson(m: MetricValue) {
  return { value: m.value, status: m.status, asOf: m.asOf, note: m.note };
}

export function metricsJson(m: VideoMetrics) {
  return {
    viewsTotal: metricJson(m.viewsTotal),
    viewsPeriod: metricJson(m.viewsPeriod),
    likesPeriod: metricJson(m.likesPeriod),
    commentsPeriod: metricJson(m.commentsPeriod),
    velocity: metricJson(m.velocity),
    growthVsPrev: metricJson(m.growthVsPrev),
    engagementRate: { ...metricJson(m.engagementRate), components: m.engagementRate.components },
    viewsAtAge: metricJson(m.viewsAtAge),
    outperformance: { ...metricJson(m.outperformance), ageDays: m.outperformance.ageDays, peers: m.outperformance.peers },
    percentile: metricJson(m.percentile),
  };
}

/** Video without its observation series (list views). */
export function videoJson(v: Video) {
  return {
    id: v.id,
    platform: v.platform,
    platformId: v.platformId,
    url: v.url,
    title: v.title,
    description: v.description,
    thumbnail: v.thumbnail,
    publishedAt: v.publishedAt,
    durationSec: v.durationSec,
    format: v.format,
    accountId: v.accountId,
    language: v.language,
    languageSource: v.languageSource,
    country: v.country,
    sourceCategory: v.sourceCategory,
    tags: v.tags,
    categories: (v.categories ?? []).map((c) => ({ ...c, label: categoryPathLabel(c.id) })),
    topics: v.topics,
    sponsorship: v.sponsorship,
    status: v.status,
    firstSeenAt: v.firstSeenAt,
    lastObservedAt: v.lastObservedAt,
    discoveredVia: v.discoveredVia,
    observationCount: v.obs.length,
  };
}

/** Account with the latest follower count instead of the full series (list views). */
export function accountJson(a: Account | null | undefined, now: number) {
  if (!a) return null;
  const f = latestFollowers(a, now);
  return {
    id: a.id,
    platform: a.platform,
    platformId: a.platformId,
    handle: a.handle,
    name: a.name,
    url: a.url,
    avatar: a.avatar,
    country: a.country,
    creatorId: a.creatorId,
    seedCategory: a.seedCategory,
    trackedSince: a.trackedSince,
    followers: f ? { value: f.value, asOf: f.t } : null,
    followerObservations: (a.followers ?? []).length,
  };
}

export function rowJson(r: VideoRow, now: number) {
  return { video: videoJson(r.video), account: accountJson(r.account, now), metrics: metricsJson(r.metrics) };
}

/** Compact row for static / top lists: id, platform, url, title, account, publishedAt, metrics(value/status/asOf). */
export function compactRowJson(r: VideoRow, rank: number) {
  const m = (x: MetricValue) => ({ value: x.value, status: x.status, asOf: x.asOf });
  return {
    rank,
    id: r.video.id,
    platform: r.video.platform,
    url: r.video.url,
    title: r.video.title,
    thumbnail: r.video.thumbnail,
    account: { id: r.video.accountId, name: r.account?.name ?? null },
    publishedAt: r.video.publishedAt,
    metrics: {
      viewsTotal: m(r.metrics.viewsTotal),
      viewsPeriod: m(r.metrics.viewsPeriod),
      likesPeriod: m(r.metrics.likesPeriod),
      commentsPeriod: m(r.metrics.commentsPeriod),
      engagementRate: m(r.metrics.engagementRate),
      percentile: m(r.metrics.percentile),
    },
  };
}

export function platformLabel(p: string): string {
  return (PLATFORM_LABELS as Record<string, string>)[p] ?? p;
}

/** Sorted plain object from a Map (deterministic JSON). */
export function sortedRecord<V>(m: Map<string, V>): Record<string, V> {
  const out: Record<string, V> = {};
  for (const k of [...m.keys()].sort()) out[k] = m.get(k) as V;
  return out;
}
