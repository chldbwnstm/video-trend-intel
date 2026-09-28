/**
 * HTTP client used by every source adapter. OWNER: collector-pipeline.
 *
 * SPEC "HTTP etiquette":
 * - descriptive User-Agent `VideoTrendIntel/0.1 (+https://github.com/chldbwnstm/video-trend-intel)`
 * - per-host rate limits (www.youtube.com 2 rps, api.dailymotion.com 4 rps, sepiasearch.org 1 rps,
 *   snapshot.search.nicovideo.jp 1 rps, anything else 2 rps)
 * - retries with exponential backoff on network errors / timeouts / 429 / 5xx, honouring `Retry-After`
 * - 20 s timeout per attempt (covers reading the body)
 *
 * Non-2xx responses (after retries) throw an `HttpError` carrying `status`, `url` (secrets redacted), `body`
 * (text, capped) and `headers`, so adapters can read provider error payloads (see sources/util.ts and
 * sources/keyed-util.ts, which look at `status` / `body` / `headers` / `retryAfterMs`).
 * `requestCount` counts every network attempt, retries included.
 */
import type { CollectLogger, HttpClient } from './types.ts';

export const DEFAULT_USER_AGENT = 'VideoTrendIntel/0.1 (+https://github.com/chldbwnstm/video-trend-intel)';
export const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_RETRIES = 3;
export const DEFAULT_RPS = 2;
/** Requests per second per host name (SPEC). Keys are lowercase host names without port. */
export const DEFAULT_HOST_RPS: Readonly<Record<string, number>> = {
  'www.youtube.com': 2,
  'api.dailymotion.com': 4,
  'sepiasearch.org': 1,
  'snapshot.search.nicovideo.jp': 1,
};
/** Max bytes of a response body kept on an HttpError (full enough for provider JSON error payloads). */
const ERROR_BODY_MAX = 64 * 1024;
/** Characters of the body quoted in the error message. */
const ERROR_SNIPPET_MAX = 200;

export interface HttpClientOptions {
  userAgent?: string;
  /** Overrides / additions to DEFAULT_HOST_RPS (host name -> requests per second). */
  perHostRps?: Record<string, number>;
  /** Rate for hosts not listed (default 2 rps). */
  defaultRps?: number;
  timeoutMs?: number;
  /** Retries after the first attempt (default 3 => up to 4 attempts). */
  retries?: number;
  /** First backoff delay; doubles per retry (default 1000 ms). */
  backoffBaseMs?: number;
  /** Cap for one backoff delay (default 30 s). */
  maxBackoffMs?: number;
  /** A Retry-After longer than this is not waited for: the request fails immediately (default 120 s). */
  maxRetryAfterMs?: number;
  /** Share one limiter between several clients (e.g. one client per adapter, one limiter per run). */
  limiter?: HostRateLimiter;
  /** Injected for tests. */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  log?: CollectLogger;
}

export interface RequestInitLite {
  headers?: Record<string, string>;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'HEAD' | 'PATCH';
  body?: string;
}

export interface VtiHttpClient extends HttpClient {
  /** Same as getText but also accepts method/body (e.g. a POST whose raw text must be parsed specially). */
  getText(url: string, init?: RequestInitLite): Promise<string>;
  getJson<T = unknown>(url: string, init?: RequestInitLite): Promise<T>;
  readonly requestCount: number;
  /** Attempts that were retries (subset of requestCount). */
  readonly retryCount: number;
  readonly limiter: HostRateLimiter;
}

/** Error thrown for a non-2xx response (after retries) or an unparsable JSON body. */
export class HttpError extends Error {
  readonly status: number;
  readonly statusText: string;
  /** URL with secret query parameters redacted. */
  readonly url: string;
  readonly method: string;
  /** Response body text (capped at 64 KiB). */
  readonly body: string;
  /** Response headers, lowercase names. */
  readonly headers: Record<string, string>;
  /** Parsed Retry-After in ms, when the server sent one. */
  readonly retryAfterMs: number | null;
  readonly attempts: number;

  constructor(init: {
    status: number;
    statusText: string;
    url: string;
    method: string;
    body: string;
    headers: Record<string, string>;
    retryAfterMs: number | null;
    attempts: number;
    message?: string;
  }) {
    const snippet = oneLine(init.body).slice(0, ERROR_SNIPPET_MAX);
    super(
      init.message ??
        `HTTP ${init.status}${init.statusText ? ` ${init.statusText}` : ''} ${init.method} ${init.url}` +
          (init.attempts > 1 ? ` (${init.attempts} attempts)` : '') +
          (snippet ? `: ${snippet}` : ''),
    );
    this.name = 'HttpError';
    this.status = init.status;
    this.statusText = init.statusText;
    this.url = init.url;
    this.method = init.method;
    this.body = init.body;
    this.headers = init.headers;
    this.retryAfterMs = init.retryAfterMs;
    this.attempts = init.attempts;
  }
}

/** Error thrown when every attempt failed at the network level (DNS, reset, timeout). */
export class NetworkError extends Error {
  readonly url: string;
  readonly method: string;
  readonly code: string | null;
  readonly timedOut: boolean;
  readonly attempts: number;
  constructor(init: { url: string; method: string; cause: unknown; timedOut: boolean; attempts: number; timeoutMs: number }) {
    const causeMsg = init.timedOut ? `timeout after ${init.timeoutMs}ms` : describeCause(init.cause);
    super(`network error ${init.method} ${init.url}${init.attempts > 1 ? ` (${init.attempts} attempts)` : ''}: ${causeMsg}`);
    this.name = 'NetworkError';
    this.url = init.url;
    this.method = init.method;
    this.code = causeCode(init.cause);
    this.timedOut = init.timedOut;
    this.attempts = init.attempts;
  }
}

/* ------------------------------------------------------------------------------------------
 * Rate limiter
 * ---------------------------------------------------------------------------------------- */

/**
 * Per-host minimum-interval limiter (a token bucket with burst 1). Slots are reserved synchronously, so
 * concurrent callers are serialized correctly: the n-th concurrent request to a host waits (n-1) intervals.
 */
export class HostRateLimiter {
  private readonly nextFree = new Map<string, number>();
  private readonly rps: Map<string, number>;

  constructor(
    perHostRps: Record<string, number> = {},
    private readonly defaultRps: number = DEFAULT_RPS,
    private readonly clock: () => number = Date.now,
  ) {
    this.rps = new Map();
    for (const [h, r] of Object.entries({ ...DEFAULT_HOST_RPS, ...perHostRps })) this.rps.set(h.toLowerCase(), r);
  }

  rateFor(host: string): number {
    const r = this.rps.get(host.toLowerCase()) ?? this.defaultRps;
    return Number.isFinite(r) && r > 0 ? r : this.defaultRps > 0 ? this.defaultRps : DEFAULT_RPS;
  }

  intervalMs(host: string): number {
    return 1000 / this.rateFor(host);
  }

  /** Reserve the next slot for `host`; returns how long the caller must wait before sending (ms, >= 0). */
  reserve(host: string): number {
    const key = host.toLowerCase();
    const now = this.clock();
    const slot = Math.max(now, this.nextFree.get(key) ?? 0);
    this.nextFree.set(key, slot + this.intervalMs(key));
    return slot - now;
  }

  /** Push the host's next free slot to at least `now + ms` (server asked us to slow down). */
  penalize(host: string, ms: number): void {
    const key = host.toLowerCase();
    const until = this.clock() + Math.max(0, ms);
    if ((this.nextFree.get(key) ?? 0) < until) this.nextFree.set(key, until);
  }
}

/* ------------------------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------------------- */

const SECRET_PARAM_RE = /(key|token|secret|password|passwd|signature|sig|auth|credential|session)/i;

/** URL with the values of secret-looking query parameters (key, access_token, client_secret...) replaced by `***`. */
export function redactUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url.replace(/([?&][^=&#]*(?:key|token|secret|password|signature|auth)[^=&#]*=)[^&#]*/gi, '$1***');
  }
  if (u.username || u.password) {
    u.username = u.username ? '***' : '';
    u.password = u.password ? '***' : '';
  }
  let changed = false;
  const params = new URLSearchParams(u.search);
  for (const k of [...new Set(params.keys())]) {
    if (SECRET_PARAM_RE.test(k)) {
      const n = params.getAll(k).length;
      params.delete(k);
      for (let i = 0; i < n; i++) params.append(k, '***');
      changed = true;
    }
  }
  if (changed) u.search = params.toString().replace(/=%2A%2A%2A/g, '=***');
  return u.toString();
}

/** Parse a Retry-After header (delta seconds or HTTP date) to ms from `now`; null when absent/invalid. */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const at = Date.parse(v);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, at - now);
}

/** Should this HTTP status be retried? 408, 425, 429 and 5xx (except 501 Not Implemented). */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599 && status !== 501);
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    const inner = (cause as Error & { cause?: unknown }).cause;
    const innerMsg = inner instanceof Error ? inner.message : inner && typeof inner === 'object' && 'code' in inner ? String((inner as { code: unknown }).code) : '';
    return innerMsg && !cause.message.includes(innerMsg) ? `${cause.message} (${innerMsg})` : cause.message;
  }
  return String(cause);
}

function causeCode(cause: unknown): string | null {
  const c = cause as { code?: unknown; cause?: { code?: unknown } } | null;
  if (c && typeof c.code === 'string') return c.code;
  if (c && c.cause && typeof c.cause.code === 'string') return c.cause.code;
  return null;
}

function headersToRecord(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

function mergeHeaders(defaults: Record<string, string>, extra: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = { ...defaults };
  if (!extra) return out;
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined || v === null) continue;
    for (const existing of Object.keys(out)) if (existing.toLowerCase() === k.toLowerCase()) delete out[existing];
    out[k] = String(v);
  }
  return out;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

/* ------------------------------------------------------------------------------------------
 * Client
 * ---------------------------------------------------------------------------------------- */

export function createHttpClient(opts: HttpClientOptions = {}): VtiHttpClient {
  const userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = Math.max(0, Math.floor(opts.retries ?? DEFAULT_RETRIES));
  const backoffBaseMs = Math.max(0, opts.backoffBaseMs ?? 1000);
  const maxBackoffMs = Math.max(backoffBaseMs, opts.maxBackoffMs ?? 30_000);
  const maxRetryAfterMs = opts.maxRetryAfterMs ?? 120_000;
  const limiter = opts.limiter ?? new HostRateLimiter(opts.perHostRps, opts.defaultRps ?? DEFAULT_RPS);
  const fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  const log = opts.log;

  let requestCount = 0;
  let retryCount = 0;

  function backoff(attempt: number): number {
    const base = Math.min(maxBackoffMs, backoffBaseMs * 2 ** attempt);
    // +-25% jitter so parallel runs do not retry in lock-step.
    return Math.round(base * (0.75 + random() * 0.5));
  }

  async function request(url: string, init: RequestInitLite | undefined, accept: string): Promise<{ text: string; status: number }> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new TypeError(`invalid URL: ${redactUrl(String(url))}`);
    }
    const host = parsed.hostname;
    const method = init?.method ?? (init?.body !== undefined ? 'POST' : 'GET');
    if (init?.body !== undefined && (method === 'GET' || method === 'HEAD')) {
      throw new TypeError(`${method} request cannot have a body: ${redactUrl(url)}`);
    }
    const safeUrl = redactUrl(url);
    const headers = mergeHeaders({ 'User-Agent': userAgent, Accept: accept }, init?.headers);

    for (let attempt = 0; ; attempt++) {
      const wait = limiter.reserve(host);
      if (wait > 0) await sleep(wait);

      requestCount++;
      if (attempt > 0) retryCount++;
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);

      let status = 0;
      let statusText = '';
      let text = '';
      let resHeaders: Record<string, string> = {};
      let networkErr: unknown = null;
      try {
        const res = await fetchImpl(url, { method, headers, body: init?.body, signal: controller.signal, redirect: 'follow' });
        status = res.status;
        statusText = res.statusText;
        resHeaders = headersToRecord(res.headers);
        text = await res.text();
      } catch (err) {
        networkErr = err;
      } finally {
        clearTimeout(timer);
      }

      const canRetry = attempt < retries;
      if (networkErr !== null) {
        if (canRetry) {
          const d = backoff(attempt);
          log?.warn(`http: ${method} ${safeUrl} failed (${timedOut ? `timeout ${timeoutMs}ms` : describeCause(networkErr)}); retry ${attempt + 1}/${retries} in ${d}ms`);
          await sleep(d);
          continue;
        }
        throw new NetworkError({ url: safeUrl, method, cause: networkErr, timedOut, attempts: attempt + 1, timeoutMs });
      }

      if (status >= 200 && status < 300) return { text, status };

      const retryAfterMs = parseRetryAfter(resHeaders['retry-after']);
      const body = text.length > ERROR_BODY_MAX ? text.slice(0, ERROR_BODY_MAX) : text;
      const fail = () =>
        new HttpError({ status, statusText, url: safeUrl, method, body, headers: resHeaders, retryAfterMs, attempts: attempt + 1 });
      if (!isRetryableStatus(status) || !canRetry) throw fail();
      if (retryAfterMs !== null && retryAfterMs > maxRetryAfterMs) {
        log?.warn(`http: ${method} ${safeUrl} -> ${status}, Retry-After ${retryAfterMs}ms exceeds ${maxRetryAfterMs}ms; giving up`);
        throw fail();
      }
      const d = Math.max(backoff(attempt), retryAfterMs ?? 0);
      if (status === 429 || retryAfterMs !== null) limiter.penalize(host, d);
      log?.warn(`http: ${method} ${safeUrl} -> HTTP ${status}; retry ${attempt + 1}/${retries} in ${d}ms`);
      await sleep(d);
    }
  }

  const client: VtiHttpClient = {
    async getText(url: string, init?: RequestInitLite): Promise<string> {
      return (await request(url, init, '*/*')).text;
    },
    async getJson<T = unknown>(url: string, init?: RequestInitLite): Promise<T> {
      const { text, status } = await request(url, init, 'application/json');
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new HttpError({
          status,
          statusText: 'invalid JSON',
          url: redactUrl(url),
          method: init?.method ?? (init?.body !== undefined ? 'POST' : 'GET'),
          body: text.slice(0, ERROR_BODY_MAX),
          headers: {},
          retryAfterMs: null,
          attempts: 1,
          message: `invalid JSON (HTTP ${status}) from ${redactUrl(url)}: ${oneLine(text).slice(0, ERROR_SNIPPET_MAX)}`,
        });
      }
    },
    get requestCount() {
      return requestCount;
    },
    get retryCount() {
      return retryCount;
    },
    limiter,
  };
  return client;
}
