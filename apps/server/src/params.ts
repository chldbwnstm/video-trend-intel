/**
 * Query-string parsing and validation for the REST API. OWNER: server.
 *
 * Parameter names follow the web app's URL keys (apps/web/src/lib/urlState.ts: `mode`, `range`, `age`,
 * `platforms`, `cats`, `topics`, `langs`, `countries`, `formats`, `q`, `sort`, `dir`, `sponsored`, `kind`), so a
 * web view's query string can be replayed against the API. Longer aliases (`dateMode`, `preset`, `categories`,
 * `languages`, `ageDays`, ...) are accepted too.
 *
 * Every validation failure throws a ParamError (-> HTTP 400) carrying a Korean and an English message.
 * Unknown parameters are rejected (typo protection); keys starting with `_` (cache busters) and the web-only
 * keys `v` / `keys` are ignored.
 */
import {
  AGE_DAYS,
  DEFAULT_TZ,
  HOUR,
  PLATFORMS,
  RANGE_PRESETS,
  addDays,
  daysBetween,
  isValidLocalDate,
  localDateOf,
  presetRange,
  presetRollingHours,
  taxonomyById,
} from '@vti/core';
import type { AgeDays, DatasetIndex, DateMode, LocalDateRange, Platform, RangePreset, SortKey, TrendEntityKind, VideoFormat, VideoQuery } from '@vti/core';

/* ------------------------------------------------------------------------------------------
 * Errors
 * ---------------------------------------------------------------------------------------- */

export class ParamError extends Error {
  readonly status = 400;
  constructor(
    readonly param: string | null,
    readonly messageKo: string,
    readonly messageEn: string,
    readonly code: string = 'invalid_parameter',
  ) {
    super(messageEn);
    this.name = 'ParamError';
  }
}

/* ------------------------------------------------------------------------------------------
 * Constants
 * ---------------------------------------------------------------------------------------- */

/** Default range for every period view: rolling 168 h ending exactly at the data's now (see SPEC / Dashboard). */
export const DEFAULT_RANGE_PRESET: RangePreset = 'rolling7d';
export const DEFAULT_DATE_MODE: DateMode = 'activity';
export const DEFAULT_SORT: SortKey = 'views_period';
export const DEFAULT_VIDEO_LIMIT = 50;
export const MAX_VIDEO_LIMIT = 500;
export const DEFAULT_CSV_LIMIT = 500;
export const MAX_CSV_LIMIT = 5000;
/** Longest custom calendar range (days, inclusive). */
export const MAX_RANGE_DAYS = 731;
/** Longest custom rolling window (hours). */
export const MAX_ROLLING_HOURS = 24 * 731;
/** How far back `asOf` may go (days before the dataset's generatedAt). */
export const MAX_AS_OF_DAYS = 400;
const MAX_LIST_ITEMS = 50;
const MAX_ITEM_CHARS = 200;
const MAX_Q_CHARS = 200;

export const SORT_KEYS: readonly SortKey[] = [
  'views_total',
  'views_period',
  'likes_period',
  'comments_period',
  'velocity',
  'growth_vs_prev',
  'engagement_rate',
  'outperformance',
  'views_at_age',
  'percentile',
  'published_at',
];
export const DATE_MODES: readonly DateMode[] = ['upload', 'activity', 'age'];
export const VIDEO_FORMATS: readonly VideoFormat[] = ['short', 'long', 'live', 'unknown'];
export const TREND_KINDS: readonly TrendEntityKind[] = ['topic', 'category', 'creator', 'account'];
export const CREATOR_SORTS = ['views_period', 'followers', 'uploads', 'engagement', 'median_v7', 'followers_growth'] as const;
export type CreatorSort = (typeof CREATOR_SORTS)[number];

/** Keys that are silently ignored (cache busters handled separately: any key starting with `_`). */
const IGNORED_KEYS = new Set(['v', 'keys']);

/* ------------------------------------------------------------------------------------------
 * Params reader
 * ---------------------------------------------------------------------------------------- */

/**
 * Wrapper over URLSearchParams with aliases, repeated-key merging and unknown-key detection.
 * Call `done()` after reading everything to reject unknown keys.
 */
export class Params {
  private readonly known = new Set<string>();
  constructor(readonly sp: URLSearchParams) {}

  static of(url: string | URL): Params {
    const u = typeof url === 'string' ? new URL(url, 'http://localhost') : url;
    return new Params(u.searchParams);
  }

  /** Raw values of every alias (in alias order), trimmed, empty values dropped. */
  private values(names: readonly string[]): { name: string; value: string }[] {
    const out: { name: string; value: string }[] = [];
    for (const n of names) {
      this.known.add(n);
      for (const v of this.sp.getAll(n)) {
        const t = v.trim();
        if (t !== '') out.push({ name: n, value: t });
      }
    }
    return out;
  }

  /** Single value (aliases allowed). Repeating it with different values is an error. */
  scalar(names: readonly string[]): string | undefined {
    const vals = this.values(names);
    if (!vals.length) return undefined;
    const distinct = new Set(vals.map((v) => v.value));
    if (distinct.size > 1) {
      throw new ParamError(names[0], `${names[0]} 값이 여러 개입니다: ${[...distinct].join(', ')}.`, `${names[0]} was given more than once with different values: ${[...distinct].join(', ')}.`);
    }
    return vals[0].value;
  }

  /** Comma-separated list merged over repeated keys and aliases; trimmed, de-duplicated. */
  list(names: readonly string[]): string[] {
    const out: string[] = [];
    for (const { value } of this.values(names)) {
      for (const part of value.split(',')) {
        const s = part.trim();
        if (!s || out.includes(s)) continue;
        if (s.length > MAX_ITEM_CHARS) {
          throw new ParamError(names[0], `${names[0]} 항목이 너무 깁니다(최대 ${MAX_ITEM_CHARS}자).`, `${names[0]} item is too long (max ${MAX_ITEM_CHARS} characters).`);
        }
        out.push(s);
      }
    }
    if (out.length > MAX_LIST_ITEMS) {
      throw new ParamError(names[0], `${names[0]} 항목은 최대 ${MAX_LIST_ITEMS}개입니다.`, `${names[0]} accepts at most ${MAX_LIST_ITEMS} items.`);
    }
    return out;
  }

  has(names: readonly string[]): boolean {
    return this.values(names).length > 0;
  }

  /** Throws for keys that were never read (except `_*`, `v`, `keys`). */
  done(): void {
    const unknown: string[] = [];
    for (const k of new Set(this.sp.keys())) {
      if (this.known.has(k) || k.startsWith('_') || IGNORED_KEYS.has(k)) continue;
      unknown.push(k);
    }
    if (unknown.length) {
      const allowed = [...this.known].join(', ');
      throw new ParamError(
        unknown[0],
        `알 수 없는 매개변수: ${unknown.join(', ')}. 사용할 수 있는 매개변수: ${allowed}.`,
        `Unknown parameter(s): ${unknown.join(', ')}. Allowed: ${allowed}.`,
        'unknown_parameter',
      );
    }
  }
}

/* ------------------------------------------------------------------------------------------
 * Primitive parsers
 * ---------------------------------------------------------------------------------------- */

export function parseEnum<T extends string>(p: Params, names: readonly string[], allowed: readonly T[], fallback: T): T;
export function parseEnum<T extends string>(p: Params, names: readonly string[], allowed: readonly T[], fallback: null): T | null;
export function parseEnum<T extends string>(p: Params, names: readonly string[], allowed: readonly T[], fallback: T | null): T | null {
  const raw = p.scalar(names);
  if (raw === undefined) return fallback;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new ParamError(names[0], `${names[0]} 값 '${raw}'은(는) 지원하지 않습니다. 가능한 값: ${allowed.join(', ')}.`, `Invalid ${names[0]} '${raw}'. Allowed: ${allowed.join(', ')}.`);
  }
  return raw as T;
}

export function parseEnumList<T extends string>(p: Params, names: readonly string[], allowed: readonly T[]): T[] {
  const items = p.list(names);
  const bad = items.filter((x) => !(allowed as readonly string[]).includes(x));
  if (bad.length) {
    throw new ParamError(names[0], `${names[0]}에 지원하지 않는 값이 있습니다: ${bad.join(', ')}. 가능한 값: ${allowed.join(', ')}.`, `Invalid ${names[0]} value(s): ${bad.join(', ')}. Allowed: ${allowed.join(', ')}.`);
  }
  return items as T[];
}

export function parseIntParam(p: Params, names: readonly string[], min: number, max: number, fallback: number): number;
export function parseIntParam(p: Params, names: readonly string[], min: number, max: number, fallback: null): number | null;
export function parseIntParam(p: Params, names: readonly string[], min: number, max: number, fallback: number | null): number | null {
  const raw = p.scalar(names);
  if (raw === undefined) return fallback;
  const n = /^-?\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new ParamError(names[0], `${names[0]}은(는) ${min} 이상 ${max} 이하의 정수여야 합니다.`, `${names[0]} must be an integer between ${min} and ${max}.`);
  }
  return n;
}

export function parseNumberParam(p: Params, names: readonly string[], min: number, max: number): number | null {
  const raw = p.scalar(names);
  if (raw === undefined) return null;
  const n = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new ParamError(names[0], `${names[0]}은(는) ${min} 이상 ${max} 이하의 숫자여야 합니다.`, `${names[0]} must be a number between ${min} and ${max}.`);
  }
  return n;
}

export function parseBoolParam(p: Params, names: readonly string[], fallback: boolean): boolean {
  const raw = p.scalar(names);
  if (raw === undefined) return fallback;
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  throw new ParamError(names[0], `${names[0]}은(는) 1/0 또는 true/false여야 합니다.`, `${names[0]} must be 1/0 or true/false.`);
}

const tzCache = new Map<string, boolean>();

export function isValidTimeZone(tz: string): boolean {
  const hit = tzCache.get(tz);
  if (hit !== undefined) return hit;
  let ok = false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    ok = true;
  } catch {
    ok = false;
  }
  if (tzCache.size < 1000) tzCache.set(tz, ok);
  return ok;
}

export function parseTz(p: Params): string {
  const raw = p.scalar(['tz', 'timeZone']);
  if (raw === undefined) return DEFAULT_TZ;
  if (raw.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(raw) || !isValidTimeZone(raw)) {
    throw new ParamError('tz', `알 수 없는 시간대입니다: ${raw}. IANA 이름(예: Asia/Seoul, Australia/Sydney)을 사용하세요.`, `Unknown time zone: ${raw}. Use an IANA name such as Asia/Seoul or Australia/Sydney.`);
  }
  return raw;
}

/** `asOf`: ISO date-time or epoch ms, within [generatedAt - 400 days, generatedAt]. Default: generatedAt. */
export function parseAsOf(p: Params, index: DatasetIndex): number {
  const gen = index.dataset.generatedAt;
  const raw = p.scalar(['asOf']);
  if (raw === undefined) return gen;
  const ms = /^\d{10,16}$/.test(raw) ? Number(raw) : Date.parse(raw);
  if (!Number.isFinite(ms)) {
    throw new ParamError('asOf', `asOf는 ISO 날짜·시각(예: 2026-09-28T12:00:00Z) 또는 epoch 밀리초여야 합니다.`, `asOf must be an ISO date-time (e.g. 2026-09-28T12:00:00Z) or epoch milliseconds.`);
  }
  if (ms > gen || ms < gen - MAX_AS_OF_DAYS * 24 * HOUR) {
    throw new ParamError(
      'asOf',
      `asOf는 데이터 기준 시각(${new Date(gen).toISOString()}) 이전 ${MAX_AS_OF_DAYS}일 이내여야 합니다.`,
      `asOf must be within ${MAX_AS_OF_DAYS} days before the data's generatedAt (${new Date(gen).toISOString()}).`,
    );
  }
  return ms;
}

/* ------------------------------------------------------------------------------------------
 * Ranges
 * ---------------------------------------------------------------------------------------- */

export interface ResolvedRangeParam {
  /** `rolling7d`, `last30d`, `2026-09-01..2026-09-28` or `36h` (custom rolling hours). */
  spec: string;
  preset: RangePreset | null;
  /** Inclusive local dates (for rolling windows: the local dates touched by the window). */
  range: LocalDateRange;
  /** Set for rolling windows: pass to core as `rollingHours`. */
  rollingHours: number | null;
  /** True when the request specified the range (false = default applied). */
  explicit: boolean;
}

function customRange(start: string, end: string, param: string): LocalDateRange {
  for (const d of [start, end]) {
    if (!isValidLocalDate(d)) {
      throw new ParamError(param, `날짜 형식이 올바르지 않습니다: ${d} (YYYY-MM-DD).`, `Invalid date: ${d} (expected YYYY-MM-DD).`);
    }
  }
  const span = daysBetween(start, end);
  if (span < 0) {
    throw new ParamError(param, `기간 시작일(${start})이 종료일(${end})보다 늦습니다.`, `Range start (${start}) is after its end (${end}).`);
  }
  if (span + 1 > MAX_RANGE_DAYS) {
    throw new ParamError(param, `기간은 최대 ${MAX_RANGE_DAYS}일까지 지정할 수 있습니다.`, `A range may span at most ${MAX_RANGE_DAYS} days.`);
  }
  return { start, end };
}

/**
 * Range parameters (one of):
 * - `range` (alias `preset`): a preset id (RANGE_PRESETS) or `YYYY-MM-DD..YYYY-MM-DD` (inclusive local dates);
 * - `start` + `end`: inclusive local dates;
 * - `hours` (alias `rollingHours`): rolling window [now - hours, now).
 * Omitted -> `fallback` (default rolling7d), unless `fallback` is null (then null is returned).
 */
export function parseRangeParams(p: Params, tz: string, now: number, fallback: RangePreset | null = DEFAULT_RANGE_PRESET): ResolvedRangeParam | null {
  const rangeRaw = p.scalar(['range', 'preset']);
  const start = p.scalar(['start', 'from']);
  const end = p.scalar(['end', 'to']);
  const hoursRaw = p.scalar(['hours', 'rollingHours']);
  const given = [rangeRaw !== undefined ? 'range' : null, start !== undefined || end !== undefined ? 'start/end' : null, hoursRaw !== undefined ? 'hours' : null].filter(Boolean);
  if (given.length > 1) {
    throw new ParamError(given[1], `기간은 range, start/end, hours 중 하나로만 지정하세요 (받은 값: ${given.join(', ')}).`, `Specify the period with only one of range, start/end or hours (got ${given.join(', ')}).`);
  }
  if (hoursRaw !== undefined) {
    const h = /^\d+(\.\d+)?$/.test(hoursRaw) ? Number(hoursRaw) : Number.NaN;
    if (!(h >= 1 && h <= MAX_ROLLING_HOURS)) {
      throw new ParamError('hours', `hours는 1 이상 ${MAX_ROLLING_HOURS} 이하의 숫자여야 합니다.`, `hours must be a number between 1 and ${MAX_ROLLING_HOURS}.`);
    }
    return { spec: `${h}h`, preset: null, range: { start: localDateOf(now - h * HOUR, tz), end: localDateOf(now, tz) }, rollingHours: h, explicit: true };
  }
  if (start !== undefined || end !== undefined) {
    if (start === undefined || end === undefined) {
      throw new ParamError(start === undefined ? 'start' : 'end', 'start와 end는 함께 지정해야 합니다.', 'start and end must be given together.');
    }
    const range = customRange(start, end, 'start');
    return { spec: `${range.start}..${range.end}`, preset: null, range, rollingHours: null, explicit: true };
  }
  if (rangeRaw !== undefined) {
    if ((RANGE_PRESETS as string[]).includes(rangeRaw)) {
      const preset = rangeRaw as RangePreset;
      return { spec: preset, preset, range: presetRange(preset, tz, now), rollingHours: presetRollingHours(preset), explicit: true };
    }
    const parts = rangeRaw.split('..');
    if (parts.length !== 2) {
      throw new ParamError('range', `range는 프리셋(${RANGE_PRESETS.join(', ')}) 또는 YYYY-MM-DD..YYYY-MM-DD 형식이어야 합니다.`, `range must be a preset (${RANGE_PRESETS.join(', ')}) or YYYY-MM-DD..YYYY-MM-DD.`);
    }
    const range = customRange(parts[0], parts[1], 'range');
    return { spec: `${range.start}..${range.end}`, preset: null, range, rollingHours: null, explicit: true };
  }
  if (fallback === null) return null;
  return { spec: fallback, preset: fallback, range: presetRange(fallback, tz, now), rollingHours: presetRollingHours(fallback), explicit: false };
}

/** Local dates [today - days + 1, today] in tz. */
export function lastLocalDays(days: number, tz: string, now: number): LocalDateRange {
  const end = localDateOf(now, tz);
  return { start: addDays(end, -(days - 1)), end };
}

/* ------------------------------------------------------------------------------------------
 * Filters
 * ---------------------------------------------------------------------------------------- */

export function parsePlatforms(p: Params, names: readonly string[] = ['platforms', 'platform']): Platform[] {
  return parseEnumList(p, names, PLATFORMS);
}

export function parseCategories(p: Params): string[] {
  const ids = p.list(['cats', 'categories', 'category']);
  const known = taxonomyById();
  const bad = ids.filter((id) => !known.has(id));
  if (bad.length) {
    throw new ParamError('cats', `알 수 없는 분야 ID: ${bad.join(', ')}. /api/v1/taxonomy에서 ID를 확인하세요.`, `Unknown category id(s): ${bad.join(', ')}. See /api/v1/taxonomy.`);
  }
  return ids;
}

export function parseLanguages(p: Params): string[] {
  const langs = p.list(['langs', 'languages', 'language']).map((x) => x.toLowerCase());
  const bad = langs.filter((x) => !/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(x));
  if (bad.length) {
    throw new ParamError('langs', `영상 언어 코드가 올바르지 않습니다: ${bad.join(', ')} (예: ko, en, ja).`, `Invalid language code(s): ${bad.join(', ')} (e.g. ko, en, ja).`);
  }
  return langs;
}

export function parseCountries(p: Params): string[] {
  const cs = p.list(['countries', 'country']).map((x) => x.toUpperCase());
  const bad = cs.filter((x) => !/^[A-Z]{2,3}$/.test(x));
  if (bad.length) {
    throw new ParamError('countries', `국가 코드가 올바르지 않습니다: ${bad.join(', ')} (예: KR, US, JP).`, `Invalid country code(s): ${bad.join(', ')} (e.g. KR, US, JP).`);
  }
  return cs;
}

export function parseQ(p: Params): string | undefined {
  const q = p.scalar(['q', 'query']);
  if (q === undefined) return undefined;
  if (q.length > MAX_Q_CHARS) {
    throw new ParamError('q', `검색어는 최대 ${MAX_Q_CHARS}자입니다.`, `q may be at most ${MAX_Q_CHARS} characters.`);
  }
  return q;
}

/* ------------------------------------------------------------------------------------------
 * /videos
 * ---------------------------------------------------------------------------------------- */

export interface ParsedVideoQuery {
  query: VideoQuery;
  range: ResolvedRangeParam | null;
  output: 'json' | 'csv';
  /** Canonical, normalized request echo (what the server actually used). */
  echo: Record<string, unknown>;
}

export function parseVideoQuery(p: Params, index: DatasetIndex): ParsedVideoQuery {
  const output = parseEnum(p, ['format', 'output'], ['json', 'csv'] as const, 'json');
  const mode = parseEnum(p, ['mode', 'dateMode'], DATE_MODES, DEFAULT_DATE_MODE);
  const tz = parseTz(p);
  const now = parseAsOf(p, index);
  // age mode: the range only restricts publishedAt when explicitly given.
  const range = parseRangeParams(p, tz, now, mode === 'age' ? null : DEFAULT_RANGE_PRESET);
  const ageRaw = parseIntParam(p, ['age', 'ageDays'], 1, 30, null);
  if (ageRaw !== null && !(AGE_DAYS as readonly number[]).includes(ageRaw)) {
    throw new ParamError('age', `age는 ${AGE_DAYS.join(', ')} 중 하나여야 합니다.`, `age must be one of ${AGE_DAYS.join(', ')}.`);
  }
  const ageDays = (ageRaw ?? (mode === 'age' ? 7 : null)) as AgeDays | null;
  const sort = parseEnum(p, ['sort'], SORT_KEYS, mode === 'age' ? 'views_at_age' : DEFAULT_SORT);
  const dir = parseEnum(p, ['dir', 'sortDir'], ['desc', 'asc'] as const, 'desc');
  const maxLimit = output === 'csv' ? MAX_CSV_LIMIT : MAX_VIDEO_LIMIT;
  const limit = parseIntParam(p, ['limit'], 1, maxLimit, output === 'csv' ? DEFAULT_CSV_LIMIT : DEFAULT_VIDEO_LIMIT);
  const offsetRaw = parseIntParam(p, ['offset'], 0, 1_000_000, null);
  const page = parseIntParam(p, ['page'], 1, 100_000, null);
  if (offsetRaw !== null && page !== null) {
    throw new ParamError('page', 'offset과 page는 함께 쓸 수 없습니다.', 'offset and page cannot be combined.');
  }
  const offset = offsetRaw ?? (page !== null ? (page - 1) * limit : 0);
  const sponsored = parseEnum(p, ['sponsored'], ['disclosed', 'any', 'none'] as const, null);
  const minViews = parseNumberParam(p, ['minViews'], 0, 1e15);
  const platforms = parsePlatforms(p);
  const categories = parseCategories(p);
  const topics = p.list(['topics', 'topic']);
  const languages = parseLanguages(p);
  const countries = parseCountries(p);
  const formats = parseEnumList(p, ['formats'], VIDEO_FORMATS);
  const accountIds = p.list(['accounts', 'accountIds', 'account']);
  const creatorIds = p.list(['creators', 'creatorIds', 'creator']);
  const q = parseQ(p);
  p.done();

  const query: VideoQuery = {
    dateMode: mode,
    tz,
    sort,
    sortDir: dir,
    limit,
    offset,
    now,
    ...(range ? { range: range.range } : {}),
    ...(range?.rollingHours ? { rollingHours: range.rollingHours } : {}),
    ...(ageDays !== null ? { ageDays } : {}),
    ...(q ? { q } : {}),
    ...(platforms.length ? { platforms } : {}),
    ...(categories.length ? { categories } : {}),
    ...(topics.length ? { topics } : {}),
    ...(languages.length ? { languages } : {}),
    ...(countries.length ? { countries } : {}),
    ...(formats.length ? { formats } : {}),
    ...(accountIds.length ? { accountIds } : {}),
    ...(creatorIds.length ? { creatorIds } : {}),
    ...(sponsored ? { sponsored } : {}),
    ...(minViews !== null ? { minViews } : {}),
  };
  const echo: Record<string, unknown> = {
    mode,
    range: range ? rangeEcho(range) : null,
    age: ageDays,
    tz,
    sort,
    dir,
    limit,
    offset,
    asOf: now,
    q: q ?? null,
    platforms,
    cats: categories,
    topics,
    langs: languages,
    countries,
    formats,
    accounts: accountIds,
    creators: creatorIds,
    sponsored: sponsored ?? null,
    minViews,
    format: output,
  };
  return { query, range, output, echo };
}

export function rangeEcho(r: ResolvedRangeParam): Record<string, unknown> {
  return { spec: r.spec, preset: r.preset, start: r.range.start, end: r.range.end, rollingHours: r.rollingHours, default: !r.explicit };
}
