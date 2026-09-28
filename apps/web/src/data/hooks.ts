/**
 * React hooks for pages: dataset access, URL query-string state, global filters, deferred analytics.
 * See UI_GUIDE.md for usage patterns.
 */
import { useCallback, useContext, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { DatasetIndex, RangePreset } from '@vti/core';
import { AppStatusContext, DatasetContext } from './context.ts';
import type { AppStatusValue, DatasetContextValue } from './context.ts';
import {
  applyParamPatch,
  historyModeFor,
  historyStep,
  inferCodec,
  nextSearchFor,
  readParam,
  resolveRangeSpec,
  searchFromHash,
  serializeParam,
  TZ_PARAM,
  tzParamFor,
  URL_KEYS,
} from '../lib/urlState.ts';
import type { HistoryMode, ParamPatch, ResolvedRange, UrlCodec } from '../lib/urlState.ts';
import { cached, stableStringify } from '../lib/cache.ts';
import { readStored, STORAGE_KEYS, writeStored } from '../lib/storage.ts';
import { DEFAULT_DISPLAY_TZ, normalizeTz, TZ_OPTIONS } from '../lib/timezones.ts';
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

/** Display tz; also available while the dataset loads; defaults to Asia/Seoul outside the provider. */
export function useTz(): string {
  const ds = useContext(DatasetContext);
  const app = useContext(AppStatusContext);
  return ds?.tz ?? app?.tz ?? DEFAULT_DISPLAY_TZ;
}

/** Loading status + time zone for the shell (null outside <DatasetProvider>). */
export function useAppStatus(): AppStatusValue | null {
  return useContext(AppStatusContext);
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

/**
 * Global (app-wide) filters. The time zone is part of the URL (`tz`, written when it differs from the
 * default) so shared links resolve the same windows; the viewer's choice is also remembered in localStorage.
 */
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

/** The live router state of the current entry (HashRouter keeps `{ usr, key, idx }` in history.state). */
function liveHistory(fallbackState: unknown): { state: unknown; canGoBack: boolean } {
  if (typeof window !== 'undefined' && window.location.hash.startsWith('#/')) {
    const hs = window.history.state as { usr?: unknown; idx?: number } | null;
    if (hs && typeof hs === 'object') return { state: hs.usr ?? null, canGoBack: typeof hs.idx === 'number' && hs.idx > 0 };
  }
  return { state: fallbackState ?? null, canGoBack: false };
}

export interface UrlStateOptions<T> {
  /** Custom codec (e.g. enumCodec(['upload','activity','age'])). Inferred from the default otherwise. */
  codec?: UrlCodec<T>;
  /**
   * `true` replaces the history entry, `false` pushes one. Default: the key's mode in URL_HISTORY
   * (`page` pushes, `brand` / `node` are selections), else replace (filters don't flood Back).
   */
  replace?: boolean;
  /** Explicit history mode (see HistoryMode in lib/urlState.ts), e.g. `'selection'` for a drawer key. */
  history?: HistoryMode;
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
      const { state, canGoBack } = liveHistory(loc.state);
      const step = historyStep(
        historyModeFor(key, o),
        key,
        serializeParam(prev, def, c) !== null,
        serializeParam(resolved, def, c) !== null,
        state,
        canGoBack,
      );
      if (step.kind === 'back') navigate(-1);
      else navigate({ pathname: live.pathname, search }, { replace: step.kind === 'replace', state: step.state });
    },
    [key, navigate],
  );

  return [value, setValue];
}

/**
 * The whole query string plus a batch updater:
 * `const [params, update] = useUrlParams(); update({ q: 'x', page: null })`.
 * `null` / `undefined` / '' / [] remove a key. A batch replaces the entry by default (and drops a selection
 * marker, so a drawer closed together with a filter change is closed by replacing, not by going back).
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

/**
 * The display time zone as global URL state (used once, by DatasetProvider):
 * - a valid `tz` in the URL (a shared link) wins over the stored preference and is adopted for the session
 *   (links inside the app don't carry it) without overwriting the viewer's stored choice;
 * - the address bar always carries a zone that differs from the default or from the stored preference, so
 *   copying it reproduces the same local-date windows (tzParamFor);
 * - setTz (the top-bar select) stores the choice and rewrites the URL (replace, router state kept).
 */
export function useUrlTz(): [string, (tz: string) => void] {
  const location = useLocation();
  const navigate = useNavigate();
  const raw = new URLSearchParams(location.search).get(TZ_PARAM);
  const fromUrl = raw !== null && normalizeTz(raw) === raw ? raw : null;
  const [chosen, setChosen] = useState<string>(() => fromUrl ?? normalizeTz(readStored(STORAGE_KEYS.tz)));
  // The zone the viewer just picked, until the URL reflects it: the router applies location updates in a
  // transition, so one render can still see the old `tz` in the URL and must not flip back to it.
  const [pending, setPending] = useState<string | null>(null);
  const tz = pending ?? fromUrl ?? chosen;

  // Adopt a zone only when the URL's `tz` itself changes (a shared link, Back/Forward), never because a
  // render briefly sees an older URL.
  const prevRaw = useRef(raw);
  useEffect(() => {
    if (prevRaw.current === raw) return;
    prevRaw.current = raw;
    setPending(null);
    if (fromUrl && fromUrl !== chosen) setChosen(fromUrl);
  }, [raw, fromUrl, chosen]);

  useEffect(() => {
    const want = tzParamFor(tz, normalizeTz(readStored(STORAGE_KEYS.tz)), DEFAULT_DISPLAY_TZ);
    if (raw === want) return;
    navigate({ pathname: location.pathname, search: applyParamPatch(location.search, { [TZ_PARAM]: want }) }, { replace: true, state: location.state });
  }, [tz, raw, location, navigate]);

  const locRef = useRef(location);
  locRef.current = location;
  const setTz = useCallback(
    (next: string) => {
      const n = normalizeTz(next);
      writeStored(STORAGE_KEYS.tz, n);
      setChosen(n);
      const live = liveLocation({ pathname: locRef.current.pathname, search: locRef.current.search });
      const liveRaw = new URLSearchParams(live.search).get(TZ_PARAM);
      const target = tzParamFor(n, n, DEFAULT_DISPLAY_TZ);
      if (liveRaw !== target) setPending(n);
      const { state } = liveHistory(locRef.current.state);
      const search = applyParamPatch(live.search, { [TZ_PARAM]: target });
      if (search !== live.search) navigate({ pathname: live.pathname, search }, { replace: true, state });
    },
    [navigate],
  );
  return [tz, setTz];
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
