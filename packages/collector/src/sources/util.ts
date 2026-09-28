/**
 * Shared helpers for the keyless source adapters (youtube-rss, dailymotion, peertube, niconico).
 * OWNER: sources-keyless agent.
 *
 * Everything here is pure (no I/O) except `RequestBudget`, which only reads `HttpClient.requestCount`.
 */
import type { VideoFormat } from '@vti/core';
import type { HttpClient } from '../types.ts';

/** Descriptive User-Agent (SPEC.md "HTTP etiquette"). Adapters pass it explicitly where a source asks for one. */
export const USER_AGENT = 'VideoTrendIntel/0.1 (+https://github.com/chldbwnstm/video-trend-intel)';

/** Max length (UTF-16 code units) of `Video.description`. */
export const DESCRIPTION_MAX = 300;

/** Videos at or below this duration are classified as short-form when the source has no explicit flag. */
export const SHORT_MAX_SECONDS = 60;

/* ------------------------------------------------------------------ language by script */

// Hangul syllables, Jamo, compatibility Jamo, Jamo extended A/B, halfwidth Hangul.
const HANGUL_RE = /[ᄀ-ᇿ㄰-㆏ꥠ-꥿가-힯ힰ-퟿ﾠ-ￜ]/g;
// Hiragana, Katakana (minus U+30FB "・" which Korean text also uses), Katakana ext, halfwidth Katakana.
const KANA_RE = /[ぁ-ゟァ-ヺー-ヿㇰ-ㇿｦ-ﾟ]/g;

function countMatches(s: string, re: RegExp): number {
  re.lastIndex = 0;
  const m = s.match(re);
  return m ? m.length : 0;
}

/**
 * Detect the language of one text by writing system only: Hangul -> `ko`, Kana -> `ja`.
 * Returns null when neither script occurs (Latin, Han-only, emoji...). When both occur the script with more
 * characters wins (ties go to `ko`). Han-only text is NOT guessed (could be Chinese or Japanese).
 */
export function detectScriptLanguage(text: string | null | undefined): 'ko' | 'ja' | null {
  if (!text) return null;
  const hangul = countMatches(text, HANGUL_RE);
  const kana = countMatches(text, KANA_RE);
  if (hangul === 0 && kana === 0) return null;
  return hangul >= kana ? 'ko' : 'ja';
}

/**
 * Detect language from several texts in priority order (e.g. title, then description, then tags):
 * the first text with a detectable script decides.
 */
export function detectLanguage(...texts: (string | null | undefined)[]): 'ko' | 'ja' | null {
  for (const t of texts) {
    const lang = detectScriptLanguage(t);
    if (lang) return lang;
  }
  return null;
}

/* ------------------------------------------------------------------ text */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function codePointToString(cp: number, original: string): string {
  if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return original;
  return String.fromCodePoint(cp);
}

/**
 * Decode XML/HTML character references in ONE pass (so `&amp;#39;` becomes the literal `&#39;`, never `'`).
 * Handles the XML named entities, `&nbsp;`, decimal `&#39;` and hex `&#xAC00;` references. Unknown named
 * entities are left untouched.
 */
export function decodeEntities(s: string): string {
  if (!s || s.indexOf('&') === -1) return s;
  return s.replace(/&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z]{2,8});/g, (whole, body: string) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const cp = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return codePointToString(cp, whole);
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? whole;
  });
}

/**
 * Turn an HTML fragment (Dailymotion / niconico descriptions) into plain text:
 * `<br>` / block ends become newlines, other tags are removed, entities decoded, whitespace tidied.
 */
export function stripHtml(s: string | null | undefined): string {
  if (!s) return '';
  let out = s
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|li|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '');
  out = decodeEntities(out).replace(/ /g, ' ');
  return tidyWhitespace(out);
}

/** Collapse runs of spaces/tabs, trim each line, collapse 3+ newlines to 2, trim. */
export function tidyWhitespace(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Truncate to at most `max` UTF-16 code units without splitting a surrogate pair. When text is cut an
 * ellipsis `…` is appended (and counted inside `max`).
 */
export function truncate(s: string, max: number = DESCRIPTION_MAX): string {
  if (max <= 0) return '';
  if (s.length <= max) return s;
  const budget = max - 1; // room for the ellipsis
  let out = '';
  for (const ch of s) {
    if (out.length + ch.length > budget) break;
    out += ch;
  }
  return out.trimEnd() + '…';
}

/**
 * Description for `RawVideo.description`: plain text, tidy, truncated to 300; empty -> null.
 * `html: true` for sources that return HTML fragments (tags stripped, entities decoded once). Plain-text input
 * is NOT entity-decoded again (callers such as the RSS parser have already decoded it).
 */
export function cleanDescription(s: string | null | undefined, opts: { html?: boolean } = {}): string | null {
  if (s == null) return null;
  if (typeof s !== 'string') return null;
  const text = opts.html ? stripHtml(s) : tidyWhitespace(s);
  return text ? truncate(text, DESCRIPTION_MAX) : null;
}

/** Trimmed non-empty string, or null (for anything that is not a string). */
export function str(v: unknown): string | null {
  if (typeof v === 'string') {
    const t = v.trim();
    return t ? t : null;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

/* ------------------------------------------------------------------ numbers & time */

/** Finite number from a number or numeric string, else null. Never coerces null/''/booleans to 0. */
export function safeNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const t = v.trim().replace(/,/g, '');
    if (!t || !/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(t)) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Non-negative integer counter (views/likes/...) or null. Negative / fractional garbage -> null. */
export function safeCount(v: unknown): number | null {
  const n = safeNumber(v);
  if (n == null || n < 0 || !Number.isSafeInteger(Math.round(n))) return null;
  return Math.round(n);
}

/** Epoch ms from an ISO-8601 string or epoch seconds/ms number; null when unparsable. */
export function parseTime(v: unknown, unit: 'ms' | 's' = 'ms'): number | null {
  if (typeof v === 'string') {
    const t = v.trim();
    if (!t) return null;
    if (/^\d+(\.\d+)?$/.test(t)) return parseTime(Number(t), unit);
    const ms = Date.parse(t);
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof v === 'number' && Number.isFinite(v)) {
    const ms = unit === 's' ? v * 1000 : v;
    return Math.round(ms);
  }
  return null;
}

/* ------------------------------------------------------------------ normalizers */

/** ISO 639-1 lowercase (`ko`, `pt-BR` -> `pt`), or null for anything else (`zxx`, '', 'un'...). */
export function normalizeLanguage(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const m = /^([a-zA-Z]{2})(?:[-_][a-zA-Z0-9]+)*$/.exec(s);
  if (!m) return null;
  const code = m[1].toLowerCase();
  return code === 'un' || code === 'xx' ? null : code;
}

/** ISO 3166-1 alpha-2 uppercase or null. */
export function normalizeCountry(v: unknown): string | null {
  const s = str(v);
  if (!s || !/^[a-zA-Z]{2}$/.test(s)) return null;
  const c = s.toUpperCase();
  return c === 'XX' || c === 'ZZ' ? null : c;
}

/** Format from duration: live flag wins; <= 60s -> short; > 60s -> long; unknown duration -> unknown. */
export function formatFromDuration(durationSec: number | null, isLive = false): VideoFormat {
  if (isLive) return 'live';
  if (durationSec == null || durationSec <= 0) return 'unknown';
  return durationSec <= SHORT_MAX_SECONDS ? 'short' : 'long';
}

/** Split into chunks of at most `size`. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const n = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

/** Unique non-empty strings, first occurrence order. */
export function uniqueStrings(items: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    const s = str(it);
    if (s && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ errors */

/**
 * HTTP status carried by an error thrown from `HttpClient` (implementation-agnostic): looks at
 * `status` / `statusCode` / `response.status`, then at messages like `HTTP 404` / `status 404` / `404 Not Found`.
 */
export function httpStatusOf(err: unknown): number | null {
  if (err && typeof err === 'object') {
    const o = err as Record<string, unknown>;
    for (const k of ['status', 'statusCode', 'httpStatus']) {
      const v = o[k];
      if (typeof v === 'number' && v >= 100 && v <= 599) return v;
    }
    const resp = o.response as Record<string, unknown> | undefined;
    if (resp && typeof resp === 'object' && typeof resp.status === 'number') return resp.status;
  }
  const msg = errorMessage(err);
  const m =
    /\b(?:HTTP|status(?:\s*code)?)\s*[:=]?\s*([1-5]\d\d)\b/i.exec(msg) ??
    /\b([1-5]\d\d)\s+(?:Not Found|Forbidden|Unauthorized|Gone|Bad Request|Too Many Requests|Internal Server Error|Service Unavailable|Bad Gateway|Gateway Timeout)\b/i.exec(msg);
  return m ? Number(m[1]) : null;
}

/** Best-effort response body attached to an HttpClient error (`body` / `responseText` / `text`). */
export function errorBody(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const o = err as Record<string, unknown>;
  for (const k of ['body', 'responseText', 'responseBody', 'text']) {
    const v = o[k];
    if (typeof v === 'string' && v) return v;
    if (v && typeof v === 'object') {
      try {
        return JSON.stringify(v);
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

/** Parsed JSON body attached to an HttpClient error, if any. */
export function errorJson(err: unknown): unknown {
  if (err && typeof err === 'object') {
    const o = err as Record<string, unknown>;
    if (o.json && typeof o.json === 'object') return o.json;
    if (o.data && typeof o.data === 'object') return o.data;
  }
  const body = errorBody(err);
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/* ------------------------------------------------------------------ request budget */

/**
 * Tracks HTTP requests against `ctx.maxRequests`. Counts both the calls this adapter made and the growth of
 * `http.requestCount` (which also includes client-side retries) and uses the larger, so the cap is never
 * exceeded even if the client retries or is shared.
 */
export class RequestBudget {
  private readonly startCount: number;
  private own = 0;

  constructor(
    private readonly http: HttpClient,
    readonly max: number,
  ) {
    this.startCount = safeCount(http.requestCount) ?? 0;
  }

  get used(): number {
    const delta = (safeCount(this.http.requestCount) ?? 0) - this.startCount;
    return Math.max(this.own, delta);
  }

  get remaining(): number {
    const max = Number.isFinite(this.max) ? Math.floor(this.max) : 0;
    return Math.max(0, max - this.used);
  }

  /** True when at least `n` more requests fit. */
  has(n = 1): boolean {
    return this.remaining >= n;
  }

  /** Record one request about to be made. Call only after `has()` returned true. */
  take(): void {
    this.own += 1;
  }
}
