/**
 * React hooks for pages: dataset access, URL query-string state, global filters, deferred analytics.
 * See UI_GUIDE.md for usage patterns.
 */
import { useCallback, useContext, useDeferredValue, useMemo, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { DatasetIndex, RangePreset } from '@vti/core';
import { DatasetContext } from './context.ts';
import type { DatasetContextValue } from './context.ts';
import { applyParamPatch, inferCodec, nextSearchFor, readParam, resolveRangeSpec, searchFromHash, URL_KEYS } from '../lib/urlState.ts';
import type { ParamPatch, ResolvedRange, UrlCodec } from '../lib/urlState.ts';
import { cached, stableStringify } from '../lib/cache.ts';
import { TZ_OPTIONS } from '../lib/timezones.ts';
import type { TzOption } from '../lib/timezones.ts';

/* ------------------------------------------------------------------------------------------ dataset */

/** The loaded dataset + index + data `now` + display tz. Only usable below <DatasetProvider>. */
export function useDataset(): DatasetContextValue {
  const ctx = useContext(DatasetContext);
  if (!ctx) throw new Error('useDataset()는 <DatasetProvider> 안에서만 사용할 수 있음');
  return ctx;
}

/** Like useDataset() but returns null outside the provider (for components usable in isolation). */
export function useOptionalDataset(): DatasetContextValue | null {
  return useContext(DatasetContext);
}

/** Display tz; defaults to Asia/Seoul outside the provider. */
export function useTz(): string {
  return useContext(DatasetContext)?.tz ?? 'Asia/Seoul';
}

export interface GlobalFilters {
  /** Display / calendar time zone for every date range and timestamp. */
  tz: string;
  setTz: (tz: string) => void;
  tzOptions: TzOption[];
  /** Data "now" (dataset.generatedAt). */
  now: number;
  isSample: boolean;
}

/** Global (app-wide) filters. The time zone is persisted in localStorage per viewer. */
export function useGlobalFilters(): GlobalFilters {
  const { tz, setTz, now, isSample } = useDataset();
  return { tz, setTz, tzOptions: TZ_OPTIONS, now, isSample };
}

/* ------------------------------------------------------------------------------------------ URL state */

/**
 * The live location. HashRouter updates `window.location.hash` synchronously on navigate, while the
 * router's React state updates later; reading the live hash lets several setters called in the same
 * event compose instead of overwriting each other.
 */
function liveLocation(fallback: { pathname: string; search: string }): { pathname: string; search: string } {
  if (typeof window !== 'undefined') {
    const parsed = searchFromHash(window.location.hash);
    if (parsed && window.location.hash.startsWith('#/')) return parsed;
  }
  return fallback;
}

export interface UrlStateOptions<T> {
  /** Custom codec (e.g. enumCodec(['upload','activity','age'])). Inferred from the default otherwise. */
  codec?: UrlCodec<T>;
  /** Replace the history entry instead of pushing (default true: filters don't flood Back). */
  replace?: boolean;
  /** Other keys to clear when this one changes (e.g. `['page']`). */
  resets?: string[];
}

/**
 * One query-string key as React state: `const [mode, setMode] = useUrlState('mode', 'activity', { codec: dateModeCodec })`.
 * - Values equal to the default are removed from the URL (clean shareable links).
 * - Invalid values in the URL fall back to the default.
 * - Setter accepts a value or an updater function.
 */
export function useUrlState<T>(key: string, defaultValue: T, opts: UrlStateOptions<T> = {}): [T, (next: T | ((prev: T) => T)) => void] {
  const location = useLocation();
  const navigate = useNavigate();
  const defaultKey = typeof defaultValue === 'object' ? JSON.stringify(defaultValue) : `${typeof defaultValue}:${String(defaultValue)}`;
  const codec = opts.codec ?? inferCodec(defaultValue);
  const latest = useRef({ defaultValue, codec, location, opts });
  latest.current = { defaultValue, codec, location, opts };

  const raw = new URLSearchParams(location.search).get(key);
  const value = useMemo(
    () => (raw === null ? defaultValue : (codec.parse(raw) ?? defaultValue)),
    // defaultValue/codec identity may change every render; the serialized default is the real dependency
    // (and it keeps array values referentially stable between renders).
    [raw, defaultKey],
  );

  const setValue = useCallback(
    (next: T | ((prev: T) => T)) => {
      const { defaultValue: def, codec: c, location: loc, opts: o } = latest.current;
      const live = liveLocation({ pathname: loc.pathname, search: loc.search });
      const prev = readParam(new URLSearchParams(live.search), key, def, c);
      const resolved = typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
      const search = nextSearchFor(live.search, key, resolved, def, c, o.resets);
      if (search === live.search) return;
      navigate({ pathname: live.pathname, search }, { replace: o.replace ?? true });
    },
    [key, navigate],
  );

  return [value, setValue];
}

/**
 * The whole query string plus a batch updater:
 * `const [params, update] = useUrlParams(); update({ q: 'x', page: null })`.
 * `null` / `undefined` / '' / [] remove a key.
 */
export function useUrlParams(): [URLSearchParams, (patch: ParamPatch, opts?: { replace?: boolean }) => void] {
  const location = useLocation();
  const navigate = useNavigate();
  const locRef = useRef(location);
  locRef.current = location;
  const params = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const update = useCallback(
    (patch: ParamPatch, opts?: { replace?: boolean }) => {
      const live = liveLocation({ pathname: locRef.current.pathname, search: locRef.current.search });
      const search = applyParamPatch(live.search, patch);
      if (search === live.search) return;
      navigate({ pathname: live.pathname, search }, { replace: opts?.replace ?? true });
    },
    [navigate],
  );
  return [params, update];
}

export interface RangeParam extends ResolvedRange {
  /** Set a preset id or a custom `YYYY-MM-DD..YYYY-MM-DD` spec. */
  setSpec: (spec: string) => void;
}

/**
 * The shared `range` query key resolved to local dates in the current tz relative to data `now`.
 * `const { range, preset, spec, setSpec } = useRangeParam()`.
 */
export function useRangeParam(key: string = URL_KEYS.range, fallback: RangePreset = 'last7d', opts: { resets?: string[] } = {}): RangeParam {
  const { tz, now } = useDataset();
  const [spec, setSpec] = useUrlState<string>(key, fallback, { resets: opts.resets });
  const resolved = useMemo(() => resolveRangeSpec(spec, tz, now, fallback), [spec, tz, now, fallback]);
  return { ...resolved, setSpec };
}

/* ------------------------------------------------------------------------------------------ analytics */

export interface AnalysisState<T> {
  data: T | undefined;
  error: Error | null;
  /** True while the shown result belongs to older inputs and a newer one is being computed. */
  isStale: boolean;
}

/**
 * Run a (possibly heavy) pure analytics function against the dataset index with:
 * - memoization + a small per-index LRU cache (revisiting a view is instant),
 * - useDeferredValue so typing / clicking stays responsive: the previous result stays on screen
 *   (dimmed via `isStale`) while the new one computes,
 * - errors captured into `error` instead of throwing.
 *
 * `name` must uniquely identify `compute` (it namespaces the cache). `input` must be JSON-serializable;
 * it is what the result depends on (besides the index).
 *
 *   const { data, error, isStale } = useAnalysis('videos', query, (index, q) => queryVideos(index, q));
 */
export function useAnalysis<I, T>(name: string, input: I, compute: (index: DatasetIndex, input: I) => T): AnalysisState<T> {
  const { index } = useDataset();
  const key = `${name}\u0000${stableStringify(input)}`;
  const deferredKey = useDeferredValue(key);
  const computeRef = useRef(compute);
  computeRef.current = compute;
  // Remember inputs by key so the deferred computation uses the matching (older) input object.
  const inputs = useRef(new Map<string, I>());
  if (!inputs.current.has(key)) {
    inputs.current.set(key, input);
    if (inputs.current.size > 8) {
      const oldest = inputs.current.keys().next().value;
      if (oldest !== undefined && oldest !== deferredKey) inputs.current.delete(oldest);
    }
  }

  const result = useMemo((): { data: T | undefined; error: Error | null } => {
    const inp = inputs.current.has(deferredKey)
      ? (inputs.current.get(deferredKey) as I)
      : (JSON.parse(deferredKey.slice(deferredKey.indexOf('\u0000') + 1)) as I);
    try {
      return { data: cached(index, deferredKey, () => computeRef.current(index, inp)), error: null };
    } catch (e) {
      return { data: undefined, error: e instanceof Error ? e : new Error(String(e)) };
    }
  }, [index, deferredKey]);

  return { ...result, isStale: key !== deferredKey };
}
