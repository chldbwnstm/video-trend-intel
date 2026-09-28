/**
 * URL query-string state (pure helpers; the React hooks live in src/data/hooks.ts).
 *
 * Views keep their filters in the HashRouter query string (`#/videos?mode=activity&range=last7d`) so a
 * URL fully reproduces a view and can be shared. Values equal to the default are omitted from the URL.
 * See UI_GUIDE.md "URL 상태 규칙" for the shared key names.
 */
import type { AgeDays, DateMode, LocalDateRange, Platform, SortKey } from '@vti/core';
import { AGE_DAYS, PLATFORMS, presetRange, presetRollingHours } from '@vti/core';
import type { RangePreset } from '@vti/core';

/* ------------------------------------------------------------------------------------------ codecs */

export interface UrlCodec<T> {
  /** Parse a raw query value. Return `undefined` for invalid input (the default is used instead). */
  parse(raw: string): T | undefined;
  /** Serialize; return `null` to omit the key. */
  serialize(value: T): string | null;
}

export const stringCodec: UrlCodec<string> = {
  parse: (raw) => raw,
  serialize: (v) => (v === '' ? null : v),
};

export const numberCodec: UrlCodec<number> = {
  parse: (raw) => {
    if (raw.trim() === '') return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  },
  serialize: (v) => (Number.isFinite(v) ? String(v) : null),
};

export const intCodec: UrlCodec<number> = {
  parse: (raw) => {
    if (!/^-?\d+$/.test(raw.trim())) return undefined;
    const n = Number.parseInt(raw, 10);
    return Number.isSafeInteger(n) ? n : undefined;
  },
  serialize: (v) => (Number.isFinite(v) ? String(Math.trunc(v)) : null),
};

export const boolCodec: UrlCodec<boolean> = {
  parse: (raw) => (raw === '1' || raw === 'true' ? true : raw === '0' || raw === 'false' ? false : undefined),
  serialize: (v) => (v ? '1' : '0'),
};

/** Comma-separated list; empty list omits the key. Items are trimmed, empty items dropped, de-duplicated. */
export const listCodec: UrlCodec<string[]> = {
  parse: (raw) => splitList(raw),
  serialize: (v) => (v.length ? v.join(',') : null),
};

export function splitList(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const s = part.trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/** Only values from `allowed` are accepted. */
export function enumCodec<T extends string>(allowed: readonly T[]): UrlCodec<T> {
  return {
    parse: (raw) => ((allowed as readonly string[]).includes(raw) ? (raw as T) : undefined),
    serialize: (v) => v,
  };
}

/** List of values from `allowed`; unknown items are dropped. */
export function enumListCodec<T extends string>(allowed: readonly T[]): UrlCodec<T[]> {
  return {
    parse: (raw) => splitList(raw).filter((x): x is T => (allowed as readonly string[]).includes(x)),
    serialize: (v) => (v.length ? v.join(',') : null),
  };
}

/** Integer values from `allowed` (e.g. AGE_DAYS). */
export function intEnumCodec<T extends number>(allowed: readonly T[]): UrlCodec<T> {
  return {
    parse: (raw) => {
      const n = intCodec.parse(raw);
      return n !== undefined && (allowed as readonly number[]).includes(n) ? (n as T) : undefined;
    },
    serialize: (v) => String(v),
  };
}

/** Infer a codec from a default value (string / number / boolean / string[]). */
export function inferCodec<T>(defaultValue: T): UrlCodec<T> {
  if (Array.isArray(defaultValue)) return listCodec as unknown as UrlCodec<T>;
  switch (typeof defaultValue) {
    case 'number':
      return numberCodec as unknown as UrlCodec<T>;
    case 'boolean':
      return boolCodec as unknown as UrlCodec<T>;
    default:
      return stringCodec as unknown as UrlCodec<T>;
  }
}

export function valuesEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => x === b[i]);
  return Object.is(a, b);
}

/** Read one key from a URLSearchParams with a codec and a default. */
export function readParam<T>(params: URLSearchParams, key: string, defaultValue: T, codec: UrlCodec<T> = inferCodec(defaultValue)): T {
  const raw = params.get(key);
  if (raw === null) return defaultValue;
  const parsed = codec.parse(raw);
  return parsed === undefined ? defaultValue : parsed;
}

/** Value to write for `key`, or `null` to delete it (when equal to the default or serializing to null). */
export function serializeParam<T>(value: T, defaultValue: T, codec: UrlCodec<T> = inferCodec(defaultValue)): string | null {
  if (valuesEqual(value, defaultValue)) return null;
  return codec.serialize(value);
}

/**
 * The search string after setting `key` to `value` (the core of useUrlState's setter):
 * default values are removed, `resets` keys are cleared (e.g. `page` when a filter changes).
 */
export function nextSearchFor<T>(currentSearch: string, key: string, value: T, defaultValue: T, codec: UrlCodec<T> = inferCodec(defaultValue), resets: readonly string[] = []): string {
  const params = new URLSearchParams(currentSearch.startsWith('?') ? currentSearch.slice(1) : currentSearch);
  const serialized = serializeParam(value, defaultValue, codec);
  if (serialized === null) params.delete(key);
  else params.set(key, serialized);
  for (const r of resets) if (r !== key) params.delete(r);
  return toSearchString(params);
}

export type ParamPatch = Record<string, string | number | boolean | readonly string[] | null | undefined>;

/**
 * Apply a patch to a query string. `null`/`undefined`/`''`/`[]` delete the key; arrays are comma-joined;
 * booleans become `1`/`0`. Returns the new search string with a leading `?` (or '' when empty).
 * Keys keep a stable order: existing keys in place, new keys appended.
 */
export function applyParamPatch(search: string, patch: ParamPatch): string {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  for (const [key, value] of Object.entries(patch)) {
    const s = toParamString(value);
    if (s === null) params.delete(key);
    else params.set(key, s);
  }
  return toSearchString(params);
}

/**
 * `?a=1&list=x,y` from URLSearchParams ('' when empty). Commas are left unescaped (valid in a query
 * string) so list values stay readable in shared links; URLSearchParams parses them back identically.
 */
export function toSearchString(params: URLSearchParams): string {
  const out = params.toString().replace(/%2C/gi, ',');
  return out ? `?${out}` : '';
}

function toParamString(value: ParamPatch[string]): string | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.length ? value.join(',') : null;
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  const s = String(value);
  return s === '' ? null : s;
}

/**
 * Router path with query params for `<Link to>` / `navigate()`:
 * `hrefWith('/videos', { mode: 'activity', range: 'last7d', topics: ['추석'] })`
 * -> `/videos?mode=activity&range=last7d&topics=%EC%B6%94%EC%84%9D`.
 */
export function hrefWith(path: string, params: ParamPatch = {}): string {
  return `${path}${applyParamPatch('', params)}`;
}

/* ------------------------------------------------------------------------------------------ ranges */

export const RANGE_PRESET_IDS: RangePreset[] = [
  'today',
  'yesterday',
  'last7d',
  'last30d',
  'last90d',
  'thisWeek',
  'lastWeek',
  'thisMonth',
  'lastMonth',
  'rolling24h',
  'rolling7d',
  'rolling30d',
];

export const RANGE_PRESET_LABELS: Record<RangePreset, string> = {
  today: '오늘',
  yesterday: '어제',
  last7d: '최근 7일',
  last30d: '최근 30일',
  last90d: '최근 90일',
  thisWeek: '이번 주',
  lastWeek: '지난주',
  thisMonth: '이번 달',
  lastMonth: '지난달',
  rolling24h: '최근 24시간',
  rolling7d: '최근 168시간(7일)',
  rolling30d: '최근 720시간(30일)',
};

/**
 * URL form of a date range: a preset id (`last7d`) or an inclusive custom range `2026-09-01..2026-09-28`.
 * Presets are stored as presets (not resolved dates) so a shared link keeps meaning "the last 7 days".
 */
export type RangeSpec = string;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Strict YYYY-MM-DD validation (real calendar date). */
export function isIsoDate(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return false;
  const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return d <= dim;
}

export function isRangePreset(s: string): s is RangePreset {
  return (RANGE_PRESET_IDS as string[]).includes(s);
}

export type ParsedRange = { kind: 'preset'; preset: RangePreset } | { kind: 'custom'; range: LocalDateRange };

/** Parse a RangeSpec; `null` when invalid (unknown preset, bad dates, start > end). */
export function parseRangeSpec(spec: string | null | undefined): ParsedRange | null {
  if (!spec) return null;
  if (isRangePreset(spec)) return { kind: 'preset', preset: spec };
  const parts = spec.split('..');
  if (parts.length !== 2) return null;
  const [start, end] = parts;
  if (!isIsoDate(start) || !isIsoDate(end) || start > end) return null;
  return { kind: 'custom', range: { start, end } };
}

export function formatRangeSpec(value: RangePreset | LocalDateRange): RangeSpec {
  return typeof value === 'string' ? value : `${value.start}..${value.end}`;
}

export interface ResolvedRange {
  spec: RangeSpec;
  preset: RangePreset | null;
  range: LocalDateRange;
  /**
   * Set for rolling presets (24/168/720): pass it to core analytics as `rollingHours` so the window is
   * [now - hours, now) instead of whole local days. `range` then only describes the local dates touched.
   */
  rollingHours: number | null;
}

/**
 * Resolve a spec to concrete local dates in `tz` relative to the data's `now`.
 * Invalid specs fall back to `fallback` (default `last7d`).
 */
export function resolveRangeSpec(spec: string | null | undefined, tz: string, now: number, fallback: RangePreset = 'last7d'): ResolvedRange {
  const parsed = parseRangeSpec(spec) ?? { kind: 'preset' as const, preset: fallback };
  if (parsed.kind === 'custom') return { spec: formatRangeSpec(parsed.range), preset: null, range: parsed.range, rollingHours: null };
  return { spec: parsed.preset, preset: parsed.preset, range: presetRange(parsed.preset, tz, now), rollingHours: presetRollingHours(parsed.preset) };
}

/** `2026-09-22 ~ 2026-09-28` (or a single date). */
export function formatLocalRange(range: LocalDateRange): string {
  return range.start === range.end ? range.start : `${range.start} ~ ${range.end}`;
}

/* ------------------------------------------------------------------------------------------ shared keys */

/**
 * Canonical query keys shared by all pages so links between pages carry filters over.
 * Page engineers: reuse these names; add page-specific keys only when nothing here fits.
 */
export const URL_KEYS = {
  /** Date semantics: `upload` | `activity` | `age`. */
  mode: 'mode',
  /** RangeSpec: preset id or `YYYY-MM-DD..YYYY-MM-DD`. */
  range: 'range',
  /** Age in days for age mode: 1|2|3|7|30. */
  age: 'age',
  /** Comma list of platforms. */
  platforms: 'platforms',
  /** Comma list of taxonomy ids. */
  categories: 'cats',
  /** Comma list of topic keys. */
  topics: 'topics',
  /** Comma list of ISO 639-1 language codes. */
  languages: 'langs',
  /** Comma list of source countries. */
  countries: 'countries',
  /** Comma list of formats (short,long,live,unknown). */
  formats: 'formats',
  /** Free-text search. */
  q: 'q',
  /** SortKey. */
  sort: 'sort',
  /** `asc` | `desc`. */
  dir: 'dir',
  /** 1-based page number. */
  page: 'page',
  /** Selected video id (opens the detail drawer). */
  video: 'v',
  /** Sponsorship filter: `disclosed` | `any` | `none`. */
  sponsored: 'sponsored',
  /** Trend entity kind: topic | category | creator | account. */
  kind: 'kind',
  /** Comma list of creator/account keys (compare page). */
  keys: 'keys',
} as const;

export const DATE_MODES: DateMode[] = ['upload', 'activity', 'age'];
export const dateModeCodec = enumCodec<DateMode>(DATE_MODES);
export const platformListCodec = enumListCodec<Platform>(PLATFORMS);
export const ageCodec = intEnumCodec<AgeDays>(AGE_DAYS);
export const SORT_KEYS: SortKey[] = [
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
export const sortCodec = enumCodec<SortKey>(SORT_KEYS);
export const dirCodec = enumCodec<'asc' | 'desc'>(['asc', 'desc']);

/* ------------------------------------------------------------------------------------------ history */

/**
 * How a URL key records browser history when it changes:
 * - `replace`: filters, sort, tabs. Changing them does not flood Back (the default for most keys);
 * - `push`: navigation-like steps (`page`). Back returns to the previous page of results;
 * - `selection`: a key that opens a drawer or a detail pane (`brand`, `node`, the video drawer's `v`).
 *   Opening pushes an entry so Back closes it; switching to another value replaces that entry; closing goes
 *   back to the entry before the open when this session pushed it (no duplicate entry is left behind, so the
 *   first Back after closing leaves the page), otherwise it replaces (shared links, links from other pages).
 */
export type HistoryMode = 'replace' | 'push' | 'selection';

/** Default history mode of keys used across pages; every other key defaults to `replace`. */
export const URL_HISTORY: Readonly<Record<string, HistoryMode>> = {
  [URL_KEYS.page]: 'push',
  brand: 'selection',
  node: 'selection',
};

/**
 * The mode for `key`: an explicit `history` wins, then `replace: true`; a selection key stays a selection
 * with `replace: false` (so its close still goes back); otherwise `replace: false` pushes; else the key default.
 */
export function historyModeFor(key: string, opts: { history?: HistoryMode; replace?: boolean } = {}): HistoryMode {
  if (opts.history) return opts.history;
  if (opts.replace === true) return 'replace';
  const d = URL_HISTORY[key];
  if (d === 'selection') return 'selection';
  if (opts.replace === false) return 'push';
  return d ?? 'replace';
}

/** Router location-state field marking an entry pushed by opening a selection key (value = the key). */
export const SELECTION_STATE = 'vtiOpened';

export type HistoryStep = { kind: 'push' | 'replace'; state: Record<string, unknown> | null } | { kind: 'back' };

function openedBy(state: unknown, key: string): boolean {
  return !!state && typeof state === 'object' && (state as Record<string, unknown>)[SELECTION_STATE] === key;
}

/**
 * What a setter does with history (pure; see HistoryMode).
 * @param wasSet    the key currently has a non-default value
 * @param willBeSet the new value is non-default
 * @param state     the current entry's router location state
 * @param canGoBack an earlier entry exists in this tab's router history
 */
export function historyStep(mode: HistoryMode, key: string, wasSet: boolean, willBeSet: boolean, state: unknown, canGoBack: boolean): HistoryStep {
  if (mode === 'push') return { kind: 'push', state: null };
  if (mode === 'replace') return { kind: 'replace', state: null };
  const opened = openedBy(state, key);
  if (willBeSet) {
    if (!wasSet) return { kind: 'push', state: { [SELECTION_STATE]: key } };
    // Another value while open: keep the marker so closing still returns to the entry before the open.
    return { kind: 'replace', state: opened ? { [SELECTION_STATE]: key } : null };
  }
  if (wasSet && opened && canGoBack) return { kind: 'back' };
  return { kind: 'replace', state: null };
}

/* ------------------------------------------------------------------------------------------ time zone */

/** Query key of the display time zone (global state; see DatasetProvider). */
export const TZ_PARAM = 'tz';

/**
 * The tz value the address bar should carry for `effective` (null = omit the key): omitted only when it is
 * the default zone AND the viewer's stored preference (a reload without the key resolves to the same zone).
 */
export function tzParamFor(effective: string, stored: string, defaultTz: string): string | null {
  return effective === defaultTz && stored === defaultTz ? null : effective;
}

/**
 * A shareable absolute URL of the current view that always names the time zone (even the default), so a
 * recipient whose own stored zone differs resolves the same local-date windows. `href` is location.href.
 */
export function shareableHref(href: string, tz: string): string {
  const hashAt = href.indexOf('#');
  if (hashAt < 0) return href;
  const parsed = searchFromHash(href.slice(hashAt));
  if (!parsed) return href;
  const search = applyParamPatch(parsed.search, { [TZ_PARAM]: tz });
  return `${href.slice(0, hashAt)}#${parsed.pathname}${search}`;
}

/** Parse the search part of a HashRouter URL (`#/videos?x=1` -> `?x=1`); `null` when not a hash route. */
export function searchFromHash(hash: string): { pathname: string; search: string } | null {
  if (!hash.startsWith('#/') && hash !== '#' && hash !== '') return null;
  const body = hash.startsWith('#') ? hash.slice(1) : hash;
  const q = body.indexOf('?');
  const pathname = (q >= 0 ? body.slice(0, q) : body) || '/';
  const search = q >= 0 ? body.slice(q) : '';
  return { pathname, search: search === '?' ? '' : search };
}
