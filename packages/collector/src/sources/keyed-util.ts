/**
 * Helpers shared by the credentialed ("keyed") source adapters:
 * youtube-data-api, tiktok-research, instagram-graph, x-api, twitch.
 *
 * Owner: sources-keyed. Pure functions only — no network, no module state except the explicit TokenCache class.
 */
import type { CollectContext, KeywordSeed } from '../types.ts';

/* ------------------------------------------------------------------ env */

/** True when every key is present and non-blank. */
export function hasAllEnv(env: Record<string, string | undefined>, keys: readonly string[]): boolean {
  return keys.every((k) => typeof env[k] === 'string' && env[k]!.trim() !== '');
}

export function envStr(env: Record<string, string | undefined>, key: string): string | null {
  const v = env[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/** Integer env var clamped to [min, max]; falls back to `def` when missing or not an integer. */
export function envInt(env: Record<string, string | undefined>, key: string, def: number, min: number, max: number): number {
  const raw = envStr(env, key);
  if (raw === null || !/^-?\d+$/.test(raw)) return def;
  return Math.min(max, Math.max(min, Number(raw)));
}

/** Comma/whitespace separated list env var, trimmed, empty entries removed, de-duplicated (first wins). */
export function envList(env: Record<string, string | undefined>, key: string): string[] {
  const raw = envStr(env, key);
  if (raw === null) return [];
  return uniq(raw.split(/[,\n]/).map((s) => s.trim()).filter(Boolean));
}

/* ------------------------------------------------------------------ numbers / text */

/**
 * A public counter as a number, or null when absent / not a count.
 * Accepts JSON numbers and decimal strings (YouTube returns counters as strings).
 * Null is NOT zero: a missing or malformed counter stays null.
 */
export function toCount(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? Math.trunc(v) : null;
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function uniq<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Truncate by code points (never splits a surrogate pair), appending an ellipsis when cut. */
export function truncate(s: string, max: number): string {
  const cps = Array.from(s);
  if (cps.length <= max) return s;
  return cps.slice(0, Math.max(0, max - 1)).join('') + '…';
}

/** Description field: trimmed, <= 300 code points, null when empty. */
export function descriptionOf(s: unknown, max = 300): string | null {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  return t === '' ? null : truncate(t, max);
}

/** Title derived from a free-text post (caption / tweet): first non-empty line without t.co links, <= max. */
export function titleFromText(text: unknown, max = 100): string {
  if (typeof text !== 'string') return '';
  const line = text
    .split(/\r?\n/)
    .map((l) => l.replace(/https?:\/\/t\.co\/\w+/g, '').trim())
    .find((l) => l !== '');
  return line ? truncate(line, max) : '';
}

/** Lower-cased unique hashtags (without '#') found in free text. Unicode aware (Korean/Japanese hashtags). */
export function hashtagsFromText(text: unknown): string[] {
  if (typeof text !== 'string') return [];
  const out: string[] = [];
  for (const m of text.matchAll(/#([\p{L}\p{N}_]+)/gu)) out.push(m[1].toLowerCase());
  return uniq(out);
}

/**
 * ISO 639-1 language from a source language tag (`ko`, `en-US`, `zh-Hant`), or null for tags that do
 * not identify a language (`zxx` no linguistic content, `und`, X's `qme`/`qht`..., Twitch `other`).
 */
export function normLang(tag: unknown): string | null {
  if (typeof tag !== 'string') return null;
  const primary = tag.trim().toLowerCase().split(/[-_]/)[0];
  return /^[a-z]{2}$/.test(primary) ? primary : null;
}

/** Epoch ms from an ISO-8601 / RFC 3339 timestamp; also accepts Instagram's `+0000` offsets. Null if invalid. */
export function parseTime(s: unknown): number | null {
  if (typeof s !== 'string' || s.trim() === '') return null;
  const norm = s.trim().replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const t = Date.parse(norm);
  return Number.isFinite(t) ? t : null;
}

/** RFC 3339 UTC without milliseconds, e.g. `2026-09-21T03:00:00Z`. */
export function rfc3339(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** `YYYYMMDD` of the UTC calendar date of `ms`. */
export function ymdUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
}

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/* ------------------------------------------------------------------ seeds */

/** Keyword seeds with non-blank keywords, de-duplicated by (keyword, language). */
export function keywordSeeds(ctx: CollectContext): KeywordSeed[] {
  const seen = new Set<string>();
  const out: KeywordSeed[] = [];
  for (const k of ctx.seeds?.keywords ?? []) {
    const kw = typeof k?.keyword === 'string' ? k.keyword.trim() : '';
    if (!kw) continue;
    const key = `${kw.toLowerCase()}|${k.language ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...k, keyword: kw });
  }
  return out;
}

/**
 * Deterministic rotation: pick `n` items starting at an offset that advances every `slotMs`, so that
 * when there are more candidates than the per-run budget, successive runs cover different items
 * without persisting any state. Returns all items (in order) when they fit.
 */
export function rotatingSlice<T>(items: readonly T[], n: number, now: number, slotMs = HOUR_MS): T[] {
  if (n <= 0 || items.length === 0) return [];
  if (items.length <= n) return items.slice();
  const slot = Math.floor(now / slotMs);
  const start = (((slot * n) % items.length) + items.length) % items.length;
  return Array.from({ length: n }, (_, i) => items[(start + i) % items.length]);
}

/* ------------------------------------------------------------------ request budget */

/** Soft cap on HTTP requests for one adapter run (ctx.maxRequests). Counts only this adapter's requests. */
export class RequestBudget {
  used = 0;
  readonly max: number;
  constructor(max: number | undefined) {
    this.max = typeof max === 'number' && !Number.isNaN(max) ? Math.max(0, max) : Number.POSITIVE_INFINITY;
  }
  get remaining(): number {
    return Math.max(0, this.max - this.used);
  }
  /** Reserve `n` requests; false (and nothing reserved) when that would exceed the cap. */
  take(n = 1): boolean {
    if (this.used + n > this.max) return false;
    this.used += n;
    return true;
  }
}

/* ------------------------------------------------------------------ tokens */

/** In-memory OAuth app-token cache (client-credentials tokens are valid for hours/days). */
export class TokenCache {
  private readonly map = new Map<string, { token: string; expiresAt: number }>();
  get(key: string, now: number): string | null {
    const e = this.map.get(key);
    return e && e.expiresAt > now ? e.token : null;
  }
  /** Stores a token; refreshes 5 minutes (or 10%) before the provider's expiry. */
  set(key: string, token: string, now: number, expiresInSec: number | null): void {
    const life = expiresInSec !== null && expiresInSec > 0 ? expiresInSec * 1000 : HOUR_MS;
    const margin = Math.min(5 * 60_000, life * 0.1);
    this.map.set(key, { token, expiresAt: now + life - margin });
  }
  delete(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}

export function formEncode(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

/* ------------------------------------------------------------------ HTTP errors */

export interface HttpFailure {
  /** HTTP status if the error exposes it (or it can be read from the message), else null (network/timeout). */
  status: number | null;
  /** Parsed response body when the error carries one (JSON parsed when possible). */
  body: unknown;
  /** Epoch ms when the provider says the rate-limit window resets, if exposed. */
  resetAt: number | null;
  message: string;
}

function headerGetter(h: unknown): ((name: string) => string | null) | null {
  if (!h || typeof h !== 'object') return null;
  const maybe = h as { get?: unknown };
  if (typeof maybe.get === 'function') {
    return (name) => {
      const v = (h as { get(n: string): unknown }).get(name);
      return typeof v === 'string' ? v : null;
    };
  }
  const rec = h as Record<string, unknown>;
  return (name) => {
    const k = Object.keys(rec).find((x) => x.toLowerCase() === name.toLowerCase());
    const v = k === undefined ? undefined : rec[k];
    if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : null;
    return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null;
  };
}

function firstNumber(...vals: unknown[]): number | null {
  for (const v of vals) if (typeof v === 'number' && Number.isInteger(v) && v >= 100 && v <= 599) return v;
  return null;
}

/**
 * Normalises whatever the HttpClient throws into status/body/reset. The client is expected to throw on
 * non-2xx after its own retries; this reads the common shapes (`status`, `statusCode`, `response.status`,
 * `body`/`data`/`responseBody`, `headers`) and falls back to parsing `HTTP 429`-style messages.
 */
export function describeHttpError(err: unknown, now: number = Date.now()): HttpFailure {
  const e = (err && typeof err === 'object' ? err : {}) as Record<string, any>;
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : String(e.message ?? err);
  let status = firstNumber(e.status, e.statusCode, e.httpStatus, e.response?.status, e.cause?.status);
  if (status === null) {
    const m = /(?:HTTP|status(?:\s*code)?)\s*[:=]?\s*([1-5]\d{2})\b/i.exec(message) ?? /^([1-5]\d{2})\b/.exec(message);
    if (m) status = Number(m[1]);
  }
  let body: unknown = e.body ?? e.data ?? e.responseBody ?? e.response?.data ?? e.response?.body ?? e.json ?? null;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      /* keep text */
    }
  }
  let resetAt: number | null = null;
  if (typeof e.resetAt === 'number') resetAt = e.resetAt;
  else if (typeof e.retryAfterMs === 'number') resetAt = now + e.retryAfterMs;
  const get = headerGetter(e.headers) ?? headerGetter(e.response?.headers);
  if (resetAt === null && get) {
    const epoch = get('x-rate-limit-reset') ?? get('ratelimit-reset');
    const retryAfter = get('retry-after');
    if (epoch && /^\d+$/.test(epoch)) resetAt = Number(epoch) * 1000;
    else if (retryAfter && /^\d+$/.test(retryAfter)) resetAt = now + Number(retryAfter) * 1000;
    else if (retryAfter) resetAt = parseTime(retryAfter);
  }
  return { status, body, resetAt, message };
}

/** Message plus a textual (non-JSON) body, for regex fallbacks when the body could not be parsed. */
export function failureText(f: HttpFailure): string {
  return typeof f.body === 'string' ? `${f.message} ${f.body}` : f.message;
}

/** Short one-line error text for CollectResult.errors, with secrets and key/token query values redacted. */
export function errorLine(
  source: string,
  what: string,
  f: HttpFailure,
  detail?: string | null,
  secrets: readonly (string | null | undefined)[] = [],
): string {
  const parts = [`${source}: ${what} failed`];
  if (f.status !== null) parts.push(`(HTTP ${f.status})`);
  const d = detail || f.message;
  if (d) parts.push(`- ${truncate(d.replace(/\s+/g, ' '), 240)}`);
  if (f.resetAt !== null) parts.push(`[rate limit resets ${new Date(f.resetAt).toISOString()}]`);
  return redact(parts.join(' '), secrets);
}

/** Remove secrets (query-string keys/tokens) from a URL or message before it is logged. */
export function redact(text: string, secrets: readonly (string | null | undefined)[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join('***');
  return out.replace(/(^|[?&\s])((?:key|access_token|client_secret|client_key)=)[^&\s]+/gi, '$1$2***');
}
