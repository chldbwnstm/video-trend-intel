/**
 * Collection pipeline: run the enabled source adapters, persist what they return, classify, record runs.
 * OWNER: collector-pipeline.
 *
 * - Adapters run sequentially in ADAPTERS order; one failing (throwing, timing out) never stops the others.
 * - Disabled adapters (missing credentials) get source status 'disabled' and are listed in coverage/exportNotes.
 * - Observations are stamped `src = '<adapterId>@<version>'` and `t = RawVideo.observedAt` (NOT fetch time for
 *   snapshot sources such as niconico).
 * - Secrets (credential env values, secret URL parameters) are redacted from every stored error message.
 */
import type { Platform, SourceWindowMetric, VideoStatus } from '@vti/core';
import { ADAPTERS } from './sources/index.ts';
import type { CollectContext, CollectLogger, CollectResult, HttpClient, RawAccount, RawVideo, Seeds, SourceAdapter } from './types.ts';
import { createHttpClient, HostRateLimiter, redactUrl, type HttpClientOptions } from './http.ts';
import { classifyStoredVideos, type ClassifyStoredResult } from './classify.ts';
import { selectRefreshIds, type RefreshSelection } from './refresh.ts';
import { creatorsFromSeeds, DEFAULT_SEEDS_DIR, loadSeedsDetailed, SEED_FILES } from './seeds.ts';
import { openStore, videoIdOf, type Store } from './store.ts';
import { buildDataset, writeExport, type BuildDatasetOptions, type WriteExportResult } from './export.ts';
import { silentLogger } from './log.ts';

export const DEFAULT_MAX_REQUESTS = 500;
/** Per-source defaults that differ from DEFAULT_MAX_REQUESTS (youtube-rss spends 1 request per seed channel). */
export const DEFAULT_MAX_REQUESTS_BY_SOURCE: Readonly<Record<string, number>> = { 'youtube-rss': 1000 };
/** Wall-clock limit for one adapter's collect() (its HTTP client is closed afterwards). */
export const DEFAULT_ADAPTER_TIMEOUT_MS = 45 * 60_000;
/** Observations stamped further in the future than this (vs. the run clock) are rejected. */
const FUTURE_TOLERANCE_MS = 10 * 60_000;

export type SourceRunStatus = 'ok' | 'partial' | 'error' | 'disabled';

export interface SourceRunSummary {
  source: string;
  platform: Platform;
  status: SourceRunStatus;
  runId: string | null;
  startedAt: number;
  finishedAt: number;
  videosSeen: number;
  videosNew: number;
  observations: number;
  accountsSeen: number;
  gone: number;
  requests: number;
  refresh: { requested: number; due: number; skipped: number };
  errors: string[];
  notes: string[];
}

export interface RunCollectionResult {
  startedAt: number;
  finishedAt: number;
  summaries: SourceRunSummary[];
  classification: ClassifyStoredResult | null;
  /** Enabled sources that were attempted. */
  attempted: number;
  /** Attempted sources that ended ok/partial. */
  succeeded: number;
  /** True when nothing was attempted or every attempted source failed. */
  totalFailure: boolean;
  seedWarnings: string[];
}

export interface RunCollectionOptions {
  /** Open store, or a path to open (closed again when the run ends). */
  db: Store | string;
  /** Adapter ids to run (default: all). Unknown ids throw. */
  sources?: string[];
  env?: Record<string, string | undefined>;
  /** Fixed instant (tests) or clock; default Date.now. */
  now?: number | (() => number);
  maxRequestsPerSource?: number | Record<string, number>;
  log?: CollectLogger;
  /** Parsed seeds; default: loaded from `seedsDir`. */
  seeds?: Seeds;
  seedsDir?: string;
  /** Adapter registry override (tests use fake adapters). Default: ADAPTERS. */
  adapters?: readonly SourceAdapter[];
  httpOptions?: HttpClientOptions;
  /** Factory override for the per-adapter HTTP client. */
  createHttp?: (adapter: SourceAdapter, limiter: HostRateLimiter) => HttpClient;
  refreshCaps?: Record<string, number>;
  adapterTimeoutMs?: number;
  /** Classify new/changed videos after collection (default true). */
  classify?: boolean;
}

/* ------------------------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------------------- */

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return typeof err === 'string' ? err : String(err);
}

/** Replace credential values (env keys of the adapter + anything that looks secret) and secret URL params. */
export function redactSecrets(text: string, env: Record<string, string | undefined>, keys: readonly string[] = []): string {
  let out = text;
  const secretKeys = new Set(keys);
  for (const k of Object.keys(env)) if (/(KEY|SECRET|TOKEN|PASSWORD)/i.test(k)) secretKeys.add(k);
  const values = [...secretKeys]
    .map((k) => env[k])
    .filter((v): v is string => typeof v === 'string' && v.trim().length >= 6)
    .map((v) => v.trim())
    .sort((a, b) => b.length - a.length);
  for (const v of values) out = out.split(v).join('***');
  return out.replace(/https?:\/\/[^\s"'<>)]+/g, (u) => redactUrl(u));
}

function runIdFor(source: string, startedAt: number): string {
  const stamp = new Date(startedAt).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `run-${source}-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

function maxRequestsFor(source: string, opt: RunCollectionOptions['maxRequestsPerSource']): number {
  if (typeof opt === 'number' && Number.isFinite(opt)) return Math.max(0, Math.floor(opt));
  if (opt && typeof opt === 'object' && typeof opt[source] === 'number') return Math.max(0, Math.floor(opt[source]));
  return DEFAULT_MAX_REQUESTS_BY_SOURCE[source] ?? DEFAULT_MAX_REQUESTS;
}

/** HTTP client wrapper that refuses new requests once `closed()` returns true (after an adapter timeout). */
function guardClient(inner: HttpClient, closed: () => boolean): HttpClient {
  const refuse = () => Promise.reject(new Error('HTTP client closed: adapter exceeded its time limit'));
  return {
    getJson: (url, init) => (closed() ? refuse() : inner.getJson(url, init)),
    getText: (url, init) => (closed() ? refuse() : (inner.getText as (u: string, i?: unknown) => Promise<string>)(url, init)),
    get requestCount() {
      return inner.requestCount;
    },
  } as HttpClient;
}

async function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`수집 시간 한도 초과 (${Math.round(ms / 1000)}초)`));
    }, ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface InvalidTally {
  count: number;
  examples: string[];
}

function noteInvalid(t: InvalidTally, reason: string) {
  t.count++;
  if (t.examples.length < 3 && !t.examples.includes(reason)) t.examples.push(reason);
}

/** Validation of adapter output (adapters are written by others; the store must never receive garbage). */
function invalidVideoReason(v: RawVideo, platform: Platform): string | null {
  if (!v || typeof v !== 'object') return 'not an object';
  if (v.platform !== platform) return `platform ${String(v.platform)} != ${platform}`;
  if (typeof v.platformId !== 'string' || !v.platformId.trim() || v.platformId.length > 300) return 'missing platformId';
  if (typeof v.publishedAt !== 'number' || !Number.isFinite(v.publishedAt)) return `${v.platformId}: invalid publishedAt`;
  if (!v.account || typeof v.account !== 'object') return `${v.platformId}: missing account`;
  if (v.account.platform !== platform) return `${v.platformId}: account platform ${String(v.account.platform)}`;
  if (typeof v.account.platformId !== 'string' || !v.account.platformId.trim()) return `${v.platformId}: missing account id`;
  if (typeof v.observedAt !== 'number' || !Number.isFinite(v.observedAt)) return `${v.platformId}: invalid observedAt`;
  return null;
}

function invalidAccountReason(a: RawAccount, platform: Platform): string | null {
  if (!a || typeof a !== 'object') return 'not an object';
  if (a.platform !== platform) return `account platform ${String(a.platform)} != ${platform}`;
  if (typeof a.platformId !== 'string' || !a.platformId.trim()) return 'missing account platformId';
  return null;
}

/** Merge two sightings of the same account within one result: later non-null values win. */
function mergeRawAccount(a: RawAccount, b: RawAccount): RawAccount {
  return {
    platform: a.platform,
    platformId: a.platformId,
    handle: b.handle ?? a.handle,
    name: b.name?.trim() ? b.name : a.name,
    url: b.url?.trim() ? b.url : a.url,
    avatar: b.avatar ?? a.avatar,
    country: b.country ?? a.country,
    followers: b.followers ?? a.followers,
    seedCategory: b.seedCategory ?? a.seedCategory ?? null,
  };
}

interface PersistStats {
  videosSeen: number;
  videosNew: number;
  observations: number;
  accountsSeen: number;
  gone: number;
  errors: string[];
}

/** Write one adapter result to the store in a single transaction. */
export function persistResult(store: Store, adapter: Pick<SourceAdapter, 'id' | 'platform' | 'version'>, result: CollectResult, now: number): PersistStats {
  const src = `${adapter.id}@${adapter.version}`;
  const stats: PersistStats = { videosSeen: 0, videosNew: 0, observations: 0, accountsSeen: 0, gone: 0, errors: [] };
  const badVideos: InvalidTally = { count: 0, examples: [] };
  const badAccounts: InvalidTally = { count: 0, examples: [] };
  let futureObs = 0;

  const videos: RawVideo[] = [];
  for (const v of Array.isArray(result?.videos) ? result.videos : []) {
    const reason = invalidVideoReason(v, adapter.platform);
    if (reason) noteInvalid(badVideos, reason);
    else videos.push(v);
  }

  // Accounts: one upsert per account with merged sightings + discoveredVia.
  const accounts = new Map<string, { raw: RawAccount; via: Set<string>; followersAt: number }>();
  const addAccount = (raw: RawAccount, via: string | null, at: number) => {
    const id = videoIdOf(raw.platform, raw.platformId);
    const e = accounts.get(id);
    if (e) {
      e.raw = mergeRawAccount(e.raw, raw);
      if (via) e.via.add(via);
      if (raw.followers != null) e.followersAt = at;
    } else {
      accounts.set(id, { raw, via: new Set(via ? [via] : []), followersAt: at });
    }
  };
  for (const a of Array.isArray(result?.accounts) ? result.accounts : []) {
    const reason = invalidAccountReason(a, adapter.platform);
    if (reason) noteInvalid(badAccounts, reason);
    else addAccount(a, `${adapter.id}:account`, now);
  }
  for (const v of videos) addAccount(v.account, typeof v.discoveredVia === 'string' ? v.discoveredVia : null, v.observedAt);

  store.transaction(() => {
    for (const [id, e] of accounts) {
      store.upsertAccount(e.raw, now, [...e.via], adapter.id);
      if (typeof e.raw.followers === 'number' && Number.isFinite(e.raw.followers) && e.raw.followers >= 0) {
        store.addFollowerObservation(id, { t: Math.min(e.followersAt, now + FUTURE_TOLERANCE_MS), value: e.raw.followers, src });
      }
    }
    stats.accountsSeen = accounts.size;

    const seen = new Set<string>();
    for (const v of videos) {
      const { id, isNew } = store.upsertVideo(v, now, adapter.id);
      if (!seen.has(id)) {
        seen.add(id);
        if (isNew) stats.videosNew++;
      }
      if (v.observedAt > now + FUTURE_TOLERANCE_MS) {
        futureObs++;
        continue;
      }
      const c = v.counters ?? { views: null, likes: null, comments: null, shares: null };
      if (store.addObservation(id, { t: v.observedAt, views: c.views ?? null, likes: c.likes ?? null, comments: c.comments ?? null, shares: c.shares ?? null, src })) {
        stats.observations++;
      }
      if (Array.isArray(v.sourceWindows) && v.sourceWindows.length) {
        const windows: SourceWindowMetric[] = v.sourceWindows.map((w) => ({ metric: w.metric, windowHours: w.windowHours, value: w.value, observedAt: v.observedAt, src }));
        store.addSourceWindows(id, windows);
      }
    }
    stats.videosSeen = seen.size;

    for (const g of Array.isArray(result?.gone) ? result.gone : []) {
      if (!g || typeof g.platformId !== 'string') continue;
      const id = videoIdOf(adapter.platform, g.platformId);
      if (seen.has(id)) continue; // returned in this run: the video is visible, ignore the contradiction
      const status: VideoStatus = g.status === 'deleted' || g.status === 'private' || g.status === 'unknown' ? g.status : 'unknown';
      if (store.markGone(id, status, now)) stats.gone++;
    }
  });

  if (badVideos.count) stats.errors.push(`수집기 출력 검증: 잘못된 영상 ${badVideos.count}개를 저장하지 않음 (${badVideos.examples.join('; ')})`);
  if (badAccounts.count) stats.errors.push(`수집기 출력 검증: 잘못된 계정 ${badAccounts.count}개를 저장하지 않음 (${badAccounts.examples.join('; ')})`);
  if (futureObs) stats.errors.push(`관측 시각이 현재보다 미래인 관측 ${futureObs}건을 저장하지 않음`);
  return stats;
}

/* ------------------------------------------------------------------------------------------
 * runCollection
 * ---------------------------------------------------------------------------------------- */

export async function runCollection(opts: RunCollectionOptions): Promise<RunCollectionResult> {
  const clock: () => number = typeof opts.now === 'number' ? () => opts.now as number : typeof opts.now === 'function' ? opts.now : Date.now;
  const env = opts.env ?? (process.env as Record<string, string | undefined>);
  const log = opts.log ?? silentLogger;
  const registry = opts.adapters ?? ADAPTERS;

  if (opts.sources?.length) {
    const unknown = opts.sources.filter((s) => !registry.some((a) => a.id === s));
    if (unknown.length) throw new Error(`unknown source(s): ${unknown.join(', ')} (known: ${registry.map((a) => a.id).join(', ')})`);
  }
  const selected = opts.sources?.length ? registry.filter((a) => opts.sources!.includes(a.id)) : [...registry];

  const ownStore = typeof opts.db === 'string';
  const store = typeof opts.db === 'string' ? openStore(opts.db) : opts.db;
  const startedAt = clock();

  // Seeds
  let seeds: Seeds;
  let seedWarnings: string[] = [];
  let creatorsAuthoritative = true;
  if (opts.seeds) {
    seeds = opts.seeds;
  } else {
    const loaded = loadSeedsDetailed(opts.seedsDir ?? DEFAULT_SEEDS_DIR, { log });
    seeds = loaded.seeds;
    seedWarnings = loaded.warnings;
    creatorsAuthoritative = !loaded.missing.includes(SEED_FILES.creators) && !loaded.warnings.some((w) => w.startsWith(`seeds/${SEED_FILES.creators}:`));
  }

  const limiter = new HostRateLimiter(opts.httpOptions?.perHostRps, opts.httpOptions?.defaultRps);
  const summaries: SourceRunSummary[] = [];
  let classification: ClassifyStoredResult | null = null;

  try {
    if (creatorsAuthoritative) {
      try {
        store.upsertCreators(creatorsFromSeeds(seeds), startedAt, { replace: true, linkStatus: 'verified' });
      } catch (err) {
        log.error(`creators: sync from seeds failed: ${errMsg(err)}`);
      }
    }

    for (const adapter of selected) {
      summaries.push(await runOne(adapter));
    }

    if (opts.classify ?? true) {
      try {
        classification = classifyStoredVideos(store, { now: clock(), log });
      } catch (err) {
        log.error(`classify: failed: ${errMsg(err)}`);
      }
    }
  } finally {
    if (ownStore) store.close();
  }

  const attempted = summaries.filter((s) => s.status !== 'disabled');
  const succeeded = attempted.filter((s) => s.status === 'ok' || s.status === 'partial').length;
  return {
    startedAt,
    finishedAt: clock(),
    summaries,
    classification,
    attempted: attempted.length,
    succeeded,
    totalFailure: attempted.length === 0 || succeeded === 0,
    seedWarnings,
  };

  async function runOne(adapter: SourceAdapter): Promise<SourceRunSummary> {
    // Prefix with the adapter id unless the adapter already did (`[id] ...` / `id: ...`).
    const tag = (raw: unknown) => {
      const m = typeof raw === 'string' ? raw : errMsg(raw);
      return m.startsWith(`[${adapter.id}]`) || m.startsWith(`${adapter.id}:`) ? m : `[${adapter.id}] ${m}`;
    };
    const alog: CollectLogger = {
      info: (m) => log.info(tag(m)),
      warn: (m) => log.warn(tag(m)),
      error: (m) => log.error(tag(m)),
    };
    const t0 = clock();
    const base: SourceRunSummary = {
      source: adapter.id,
      platform: adapter.platform,
      status: 'disabled',
      runId: null,
      startedAt: t0,
      finishedAt: t0,
      videosSeen: 0,
      videosNew: 0,
      observations: 0,
      accountsSeen: 0,
      gone: 0,
      requests: 0,
      refresh: { requested: 0, due: 0, skipped: 0 },
      errors: [],
      notes: [],
    };

    let enabled = false;
    try {
      enabled = adapter.isEnabled(env);
    } catch (err) {
      base.errors.push(`isEnabled 실패: ${errMsg(err)}`);
    }
    if (!enabled) {
      const note = adapter.requiresCredentials
        ? `인증 정보가 없어 비활성화됨 (필요한 환경 변수: ${adapter.envKeys.join(', ') || '없음'})`
        : '비활성화됨';
      base.notes.push(note);
      try {
        store.updateSourceState(adapter.id, { runAt: null, status: 'disabled', error: base.errors[0] ?? null, notes: [note], now: t0 });
      } catch (err) {
        log.error(`[${adapter.id}] source state update failed: ${errMsg(err)}`);
      }
      alog.info('disabled (credentials missing)');
      return base;
    }

    const maxRequests = maxRequestsFor(adapter.id, opts.maxRequestsPerSource);
    const runId = runIdFor(adapter.id, t0);
    base.runId = runId;
    try {
      store.recordRun({ id: runId, source: adapter.id, startedAt: t0 });
    } catch (err) {
      log.error(`[${adapter.id}] recordRun failed: ${errMsg(err)}`);
    }

    // Refresh selection
    let selection: RefreshSelection | null = null;
    try {
      selection = selectRefreshIds(store, adapter, { now: t0, maxRequests, caps: opts.refreshCaps });
      base.refresh = { requested: selection.ids.length, due: selection.due, skipped: selection.skipped };
      if (selection.note) base.notes.push(selection.note);
    } catch (err) {
      base.errors.push(`갱신 대상 선택 실패: ${errMsg(err)}`);
    }

    let closed = false;
    const inner = opts.createHttp ? opts.createHttp(adapter, limiter) : createHttpClient({ ...opts.httpOptions, limiter, log: alog });
    const http = guardClient(inner, () => closed);
    const ctx: CollectContext = {
      now: t0,
      http,
      log: alog,
      env,
      seeds,
      refreshIds: selection?.ids ?? [],
      maxRequests,
    };

    alog.info(`start (maxRequests=${maxRequests}, refresh ${ctx.refreshIds.length}/${selection?.due ?? 0} due)`);
    let result: CollectResult | null = null;
    let threw: unknown = null;
    try {
      result = await withTimeout(Promise.resolve().then(() => adapter.collect(ctx)), opts.adapterTimeoutMs ?? DEFAULT_ADAPTER_TIMEOUT_MS, () => {
        closed = true;
      });
    } catch (err) {
      threw = err;
    }
    closed = true;
    base.requests = inner.requestCount;

    if (threw !== null) {
      base.errors.push(`수집 실패: ${errMsg(threw)}`);
    } else if (result) {
      for (const e of Array.isArray(result.errors) ? result.errors : []) if (typeof e === 'string' && e) base.errors.push(e);
      try {
        const stats = persistResult(store, adapter, result, t0);
        base.videosSeen = stats.videosSeen;
        base.videosNew = stats.videosNew;
        base.observations = stats.observations;
        base.accountsSeen = stats.accountsSeen;
        base.gone = stats.gone;
        base.errors.push(...stats.errors);
      } catch (err) {
        base.errors.push(`저장 실패: ${errMsg(err)}`);
        threw = err;
      }
    } else {
      base.errors.push('수집기가 결과를 반환하지 않음');
    }

    const secretsFrom = adapter.envKeys ?? [];
    base.errors = base.errors.map((e) => redactSecrets(e, env, secretsFrom));
    const collected = base.videosSeen + base.accountsSeen + base.gone;
    base.status = threw !== null ? 'error' : base.errors.length === 0 ? 'ok' : collected > 0 ? 'partial' : 'error';
    if (base.requests >= maxRequests && maxRequests > 0) base.notes.push(`요청 한도(실행당 ${maxRequests}회)에 도달함: 일부 시드·갱신 대상이 이번 실행에서 빠졌을 수 있음`);
    base.finishedAt = clock();

    try {
      store.finishRun(runId, {
        finishedAt: base.finishedAt,
        status: base.status as 'ok' | 'partial' | 'error',
        videosSeen: base.videosSeen,
        videosNew: base.videosNew,
        observations: base.observations,
        requests: base.requests,
        errors: base.errors,
      });
      store.updateSourceState(adapter.id, {
        runAt: t0,
        status: base.status,
        success: base.status === 'ok' || base.status === 'partial',
        error: base.errors[0] ?? null,
        notes: base.notes,
        now: base.finishedAt,
      });
    } catch (err) {
      log.error(`[${adapter.id}] run bookkeeping failed: ${errMsg(err)}`);
    }

    const line = `${base.status}: videos ${base.videosSeen} (new ${base.videosNew}), observations ${base.observations}, accounts ${base.accountsSeen}, gone ${base.gone}, requests ${base.requests}, errors ${base.errors.length}`;
    if (base.status === 'error') alog.error(`${line}${base.errors[0] ? ` - ${base.errors[0]}` : ''}`);
    else if (base.status === 'partial') alog.warn(line);
    else alog.info(line);
    return base;
  }
}

/* ------------------------------------------------------------------------------------------
 * collect + export (schedulers)
 * ---------------------------------------------------------------------------------------- */

export interface CollectAndExportOptions extends Omit<RunCollectionOptions, 'db'> {
  db: Store | string;
  outDir: string;
  /** Also copy dataset.json here; true = apps/web/public/data/dataset.json. */
  copyTo?: string | boolean | null;
  exportOptions?: Omit<BuildDatasetOptions, 'now' | 'env'>;
}

export interface CollectAndExportResult {
  collection: RunCollectionResult;
  export: WriteExportResult | null;
  exportError: string | null;
}

/** Run a collection, then export the dataset (even when the collection failed, so the coverage page shows it). */
export async function collectAndExport(opts: CollectAndExportOptions): Promise<CollectAndExportResult> {
  const ownStore = typeof opts.db === 'string';
  const store = typeof opts.db === 'string' ? openStore(opts.db) : opts.db;
  try {
    const collection = await runCollection({ ...opts, db: store });
    let exp: WriteExportResult | null = null;
    let exportError: string | null = null;
    try {
      const now = typeof opts.now === 'number' ? opts.now : typeof opts.now === 'function' ? opts.now() : Date.now();
      const dataset = buildDataset(store, { adapters: opts.adapters, log: opts.log, ...opts.exportOptions, now, env: opts.env });
      exp = writeExport(dataset, opts.outDir, { copyTo: opts.copyTo ?? null });
    } catch (err) {
      exportError = errMsg(err);
      (opts.log ?? silentLogger).error(`export failed: ${exportError}`);
    }
    return { collection, export: exp, exportError };
  } finally {
    if (ownStore) store.close();
  }
}
