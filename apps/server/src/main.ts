/**
 * Server entry point: loads the dataset, serves API + web, hot-swaps new exports, runs the collector on a
 * schedule. OWNER: server.
 *
 *   npm start                       (= tsx apps/server/src/main.ts)
 *
 * Environment (all optional; `.env` in the repo root is loaded, real env wins):
 *   PORT (8787) · HOST (0.0.0.0)
 *   DATA_DIR (<repo>/data) · EXPORT_DIR (<DATA_DIR>/export) · DB_PATH (<DATA_DIR>/store.sqlite)
 *   WEB_DIST_DIR (<repo>/apps/web/dist) · DATASET_PATH (extra dataset file to try when the export is missing)
 *   COLLECT_INTERVAL_MIN (180; 0 disables the scheduler) · COLLECT_START_DELAY_SEC (60) · COLLECT_ON_START (0/1)
 *   EXPORT_COPY_TO_WEB (0/1: also copy each export to apps/web/public/data for `npm run dev`)
 *   COLLECT_SOURCES (comma list of adapter ids; default all) · COLLECT_MAX_REQUESTS (per-source cap override)
 *   EXPORT_BUDGET_MB (collector default) · RATE_LIMIT_PER_MIN (120; 0 disables) · TRUST_PROXY (0/1)
 *   WATCH_POLL_SEC (30)
 *   HEALTH_VERBOSE (0/1: /api/v1/health also shows filesystem paths and raw load/collection errors. Off by
 *     default because the endpoint is public — CORS *, no auth, exempt from the rate limit)
 */
import { existsSync, mkdirSync, realpathSync, watch, type FSWatcher } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { buildIndex, decodeDataset } from '@vti/core';
import type { CompactDataset, DatasetIndex } from '@vti/core';
import { ADAPTERS, createLogger } from '@vti/collector';
import { createApp, type AppLogger } from './app.ts';
import { Scheduler, createCollectJob, type SchedulerStatus } from './scheduler.ts';

export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/* ------------------------------------------------------------------------------------------
 * Config
 * ---------------------------------------------------------------------------------------- */

export interface ServerConfig {
  port: number;
  host: string;
  dataDir: string;
  exportDir: string;
  dbPath: string;
  webDistDir: string;
  /** Tried in order when EXPORT_DIR/dataset.json is missing. */
  fallbackDatasets: string[];
  intervalMin: number;
  startDelaySec: number;
  collectOnStart: boolean;
  collectSources: string[];
  collectMaxRequests: number | undefined;
  copyToWeb: string | null;
  budgetBytes: number | undefined;
  rateLimitPerMin: number;
  trustProxy: boolean;
  pollSec: number;
  /** HEALTH_VERBOSE: include filesystem paths and raw errors in /api/v1/health. */
  healthVerbose: boolean;
}

function num(env: Record<string, string | undefined>, key: string, fallback: number, min = 0): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) throw new Error(`${key} must be a number >= ${min} (got "${raw}")`);
  return n;
}

function bool(env: Record<string, string | undefined>, key: string): boolean {
  const v = (env[key] ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function pathFrom(env: Record<string, string | undefined>, key: string, fallback: string, base: string = REPO_ROOT): string {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  return isAbsolute(raw) ? raw : resolve(base, raw);
}

export function configFromEnv(env: Record<string, string | undefined> = process.env): ServerConfig {
  const dataDir = pathFrom(env, 'DATA_DIR', join(REPO_ROOT, 'data'));
  const webDistDir = pathFrom(env, 'WEB_DIST_DIR', join(REPO_ROOT, 'apps', 'web', 'dist'));
  const publicDataset = join(REPO_ROOT, 'apps', 'web', 'public', 'data', 'dataset.json');
  const extra = env.DATASET_PATH?.trim() ? [pathFrom(env, 'DATASET_PATH', '')] : [];
  const budgetMb = env.EXPORT_BUDGET_MB?.trim() ? num(env, 'EXPORT_BUDGET_MB', 40, 1) : null;
  return {
    port: Math.floor(num(env, 'PORT', 8787, 0)),
    host: env.HOST?.trim() || '0.0.0.0',
    dataDir,
    exportDir: pathFrom(env, 'EXPORT_DIR', join(dataDir, 'export')),
    dbPath: pathFrom(env, 'DB_PATH', join(dataDir, 'store.sqlite')),
    webDistDir,
    fallbackDatasets: [...extra, publicDataset, join(webDistDir, 'data', 'dataset.json')],
    intervalMin: num(env, 'COLLECT_INTERVAL_MIN', 180, 0),
    startDelaySec: num(env, 'COLLECT_START_DELAY_SEC', 60, 0),
    collectOnStart: bool(env, 'COLLECT_ON_START'),
    collectSources: (env.COLLECT_SOURCES ?? '').split(',').map((x) => x.trim()).filter(Boolean),
    collectMaxRequests: env.COLLECT_MAX_REQUESTS?.trim() ? Math.floor(num(env, 'COLLECT_MAX_REQUESTS', 0, 0)) : undefined,
    copyToWeb: bool(env, 'EXPORT_COPY_TO_WEB') ? publicDataset : null,
    budgetBytes: budgetMb !== null ? Math.round(budgetMb * 1_000_000) : undefined,
    rateLimitPerMin: num(env, 'RATE_LIMIT_PER_MIN', 120, 0),
    trustProxy: bool(env, 'TRUST_PROXY'),
    pollSec: num(env, 'WATCH_POLL_SEC', 30, 1),
    healthVerbose: bool(env, 'HEALTH_VERBOSE'),
  };
}

/* ------------------------------------------------------------------------------------------
 * Dataset loader (hot swap)
 * ---------------------------------------------------------------------------------------- */

export interface LoadedData {
  index: DatasetIndex;
  /** Raw file bytes (served as /data/dataset.json and /api/v1/dataset). */
  raw: Buffer;
  path: string;
  mtimeMs: number;
  size: number;
  loadedAt: number;
  loadMs: number;
}

/** Parse + decode + index a compact dataset file. Throws on invalid content. */
export async function loadDatasetFile(path: string): Promise<LoadedData> {
  const st = await stat(path);
  const raw = await readFile(path);
  const t0 = performance.now();
  const text = raw.toString('utf8');
  if (text.trimStart()[0] !== '{') throw new Error('not a JSON object');
  const compact = JSON.parse(text) as CompactDataset;
  const index = buildIndex(decodeDataset(compact));
  return { index, raw, path, mtimeMs: st.mtimeMs, size: st.size, loadedAt: Date.now(), loadMs: Math.round(performance.now() - t0) };
}

/** Public stand-in for a raw load error (the full text, with the file path, is in the server log). */
export const LOAD_ERROR_PUBLIC = '데이터셋 파일을 읽지 못해 이전 데이터셋을 유지하고 있습니다. 자세한 내용은 서버 로그를 확인하세요.';

export interface DatasetLoaderStatus {
  /** File name of the loaded dataset (never the directory). */
  file: string | null;
  fromExport: boolean;
  loadedAt: number | null;
  generatedAt: number | null;
  bytes: number | null;
  loadMs: number | null;
  loads: number;
  failures: number;
  /** null after a successful load; otherwise LOAD_ERROR_PUBLIC, or the raw `<path>: <message>` when verbose. */
  lastError: string | null;
  lastErrorAt: number | null;
  watching: boolean;
  /** Verbose only: absolute path of the loaded file and the watched export dir. */
  path?: string | null;
  exportDir?: string;
}

export class DatasetLoader {
  current: LoadedData | null = null;
  loads = 0;
  failures = 0;
  /** Raw diagnostic (`<path>: <message>`); logged, and exposed by status() only when verbose. */
  lastError: string | null = null;
  lastErrorAt: number | null = null;
  private watcher: FSWatcher | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private checking: Promise<void> | null = null;
  private recheck = false;
  private failedStamp: string | null = null;

  constructor(
    readonly exportDir: string,
    readonly fallbacks: string[],
    private readonly log: AppLogger,
  ) {}

  get exportPath(): string {
    return join(this.exportDir, 'dataset.json');
  }

  get index(): DatasetIndex | null {
    return this.current?.index ?? null;
  }

  private async tryLoad(path: string): Promise<boolean> {
    try {
      const data = await loadDatasetFile(path);
      const prev = this.current;
      this.current = data;
      this.loads++;
      this.lastError = null;
      this.lastErrorAt = null;
      const ds = data.index.dataset;
      const back = prev && ds.generatedAt < prev.index.dataset.generatedAt ? ' (older than the previous dataset!)' : '';
      this.log.info(
        `dataset ${prev ? 'reloaded' : 'loaded'}: ${path} — ${ds.videos.length} videos, ${ds.accounts.length} accounts, generatedAt ${new Date(ds.generatedAt).toISOString()}${back}, ${(data.size / 1_000_000).toFixed(1)} MB, decode+index ${data.loadMs} ms`,
      );
      return true;
    } catch (err) {
      this.failures++;
      this.lastError = `${path}: ${err instanceof Error ? err.message : String(err)}`;
      this.lastErrorAt = Date.now();
      this.log.error(`dataset load failed (keeping the previous one): ${this.lastError}`);
      return false;
    }
  }

  /** Export first, then the fallbacks. */
  async loadInitial(): Promise<boolean> {
    for (const p of [this.exportPath, ...this.fallbacks]) {
      if (!existsSync(p)) continue;
      if (await this.tryLoad(p)) return true;
      if (p === this.exportPath) {
        const st = await stat(p).catch(() => null);
        if (st) this.failedStamp = `${st.mtimeMs}|${st.size}`; // retry only when the file changes
      }
    }
    this.log.warn(`no dataset found (looked at ${[this.exportPath, ...this.fallbacks].join(', ')}); API data routes answer 503 until an export appears`);
    return false;
  }

  /** Reload when the export file differs from what is loaded (path, mtime or size). Serialized. */
  checkForUpdate(): Promise<void> {
    if (this.checking) {
      this.recheck = true;
      return this.checking;
    }
    this.checking = (async () => {
      do {
        this.recheck = false;
        let st;
        try {
          st = await stat(this.exportPath);
        } catch {
          continue; // no export (yet)
        }
        const cur = this.current;
        if (cur && cur.path === this.exportPath && cur.mtimeMs === st.mtimeMs && cur.size === st.size) continue;
        // Do not retry a file that already failed with exactly this mtime/size (avoids log spam every poll).
        const stamp = `${st.mtimeMs}|${st.size}`;
        if (this.failedStamp === stamp) continue;
        const ok = await this.tryLoad(this.exportPath);
        this.failedStamp = ok ? null : stamp;
      } while (this.recheck);
    })().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  /** fs.watch on the export dir (best effort) + stat polling (works on network / container volumes too). */
  watch(pollSec: number): void {
    try {
      mkdirSync(this.exportDir, { recursive: true });
      this.watcher = watch(this.exportDir, (_event, filename) => {
        if (filename && String(filename) !== 'dataset.json') return;
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => void this.checkForUpdate(), 1_000);
        this.debounce.unref?.();
      });
      this.watcher.on('error', (err) => {
        this.log.warn(`fs.watch on ${this.exportDir} failed (${err.message}); polling only`);
        this.watcher?.close();
        this.watcher = null;
      });
    } catch (err) {
      this.log.warn(`fs.watch unavailable for ${this.exportDir} (${err instanceof Error ? err.message : String(err)}); polling only`);
    }
    this.poll = setInterval(() => void this.checkForUpdate(), pollSec * 1000);
    this.poll.unref?.();
  }

  close(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.poll) clearInterval(this.poll);
    if (this.debounce) clearTimeout(this.debounce);
    this.poll = null;
    this.debounce = null;
  }

  /**
   * Loader state for /api/v1/health. That endpoint is public (CORS *, no auth, rate-limit exempt), so by default
   * nothing about the host filesystem leaves the process: the file name instead of its path, and a generic
   * lastError (paths and raw error text stay in the server log). `verbose` (HEALTH_VERBOSE=1) adds them back.
   */
  status(verbose = false): DatasetLoaderStatus {
    const c = this.current;
    return {
      file: c ? basename(c.path) : null,
      fromExport: c ? c.path === this.exportPath : false,
      loadedAt: c?.loadedAt ?? null,
      generatedAt: c?.index.dataset.generatedAt ?? null,
      bytes: c?.size ?? null,
      loadMs: c?.loadMs ?? null,
      loads: this.loads,
      failures: this.failures,
      lastError: this.lastError === null ? null : verbose ? this.lastError : LOAD_ERROR_PUBLIC,
      lastErrorAt: this.lastErrorAt,
      watching: this.watcher !== null,
      ...(verbose ? { path: c?.path ?? null, exportDir: this.exportDir } : {}),
    };
  }
}

/** The loader + scheduler part of /api/v1/health (public-safe unless `verbose`). */
export function serverStatus(loader: DatasetLoader, scheduler: Scheduler | null, verbose = false): { loader: DatasetLoaderStatus; scheduler: SchedulerStatus | { enabled: false; intervalMin: 0 } } {
  return {
    loader: loader.status(verbose),
    scheduler: scheduler ? scheduler.status(verbose) : { enabled: false, intervalMin: 0 },
  };
}

/* ------------------------------------------------------------------------------------------
 * Main
 * ---------------------------------------------------------------------------------------- */

/** Time of the first scheduled collection: one interval after the loaded export, never sooner than the start delay. */
export function firstRunTime(cfg: Pick<ServerConfig, 'intervalMin' | 'startDelaySec' | 'collectOnStart'>, generatedAt: number | null, fromExport: boolean, now: number): number {
  const soonest = now + cfg.startDelaySec * 1000;
  if (cfg.collectOnStart || generatedAt === null || !fromExport) return soonest;
  return Math.max(soonest, generatedAt + cfg.intervalMin * 60_000);
}

export async function main(env: Record<string, string | undefined> = process.env): Promise<void> {
  const dotenv = join(REPO_ROOT, '.env');
  if (existsSync(dotenv)) {
    try {
      process.loadEnvFile(dotenv); // existing environment variables win
    } catch (err) {
      process.stderr.write(`.env could not be loaded: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  const cfg = configFromEnv(env);
  const log = createLogger({ file: null }).child('server');

  const loader = new DatasetLoader(cfg.exportDir, cfg.fallbackDatasets, log);
  await loader.loadInitial();
  loader.watch(cfg.pollSec);

  let scheduler: Scheduler | null = null;
  if (cfg.intervalMin > 0) {
    const unknownSources = cfg.collectSources.filter((id) => !ADAPTERS.some((a) => a.id === id));
    if (unknownSources.length) {
      log.error(`COLLECT_SOURCES: unknown adapter id(s) ignored: ${unknownSources.join(', ')} (known: ${ADAPTERS.map((a) => a.id).join(', ')})`);
      cfg.collectSources = cfg.collectSources.filter((id) => !unknownSources.includes(id));
    }
    const job = createCollectJob({
      dbPath: cfg.dbPath,
      exportDir: cfg.exportDir,
      logDir: cfg.dataDir,
      copyTo: cfg.copyToWeb,
      budgetBytes: cfg.budgetBytes,
      sources: cfg.collectSources,
      maxRequestsPerSource: cfg.collectMaxRequests,
      env,
      onExported: () => loader.checkForUpdate(),
    });
    const st = loader.status();
    scheduler = new Scheduler({
      intervalMs: cfg.intervalMin * 60_000,
      job,
      log,
      firstRunAt: firstRunTime(cfg, st.generatedAt, st.fromExport, Date.now()),
    });
    scheduler.start();
  } else {
    log.info('scheduler disabled (COLLECT_INTERVAL_MIN=0); the server still hot-swaps new exports written by the collector CLI');
  }

  const app = createApp({
    getIndex: () => loader.index,
    getCompact: () => loader.current?.raw ?? null,
    webDistDir: existsSync(cfg.webDistDir) ? cfg.webDistDir : null,
    dataDir: cfg.exportDir,
    rateLimit: cfg.rateLimitPerMin > 0 ? { perMinute: cfg.rateLimitPerMin } : false,
    trustProxy: cfg.trustProxy,
    log,
    getStatus: () => serverStatus(loader, scheduler, cfg.healthVerbose),
  });
  if (cfg.healthVerbose) log.warn('HEALTH_VERBOSE=1: /api/v1/health shows filesystem paths and raw errors to anyone who can reach this server');
  if (!existsSync(cfg.webDistDir)) log.warn(`web build not found at ${cfg.webDistDir} (run \`npm run build\`); serving the API only`);

  const server = serve({ fetch: app.fetch, port: cfg.port, hostname: cfg.host }, (info) => {
    log.info(`listening on http://${info.address.includes(':') ? `[${info.address}]` : info.address}:${info.port} (API ${'/api/v1'}, web ${existsSync(cfg.webDistDir) ? cfg.webDistDir : 'not built'})`);
  });
  server.on('error', (err) => {
    log.error(`HTTP server error: ${err.message}`);
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    log.error(`unhandled rejection (server keeps running): ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
  });
  process.on('uncaughtException', (err) => {
    log.error(`uncaught exception (server keeps running): ${err.stack ?? err.message}`);
  });

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) {
      log.warn(`${signal} again: exiting now`);
      process.exit(1);
    }
    stopping = true;
    log.info(`${signal} received: shutting down`);
    if (scheduler?.running) log.warn('a collection run is in progress and will be interrupted (the SQLite store stays consistent: each source is written in one transaction)');
    void scheduler?.stop();
    loader.close();
    const force = setTimeout(() => {
      log.warn('graceful shutdown timed out; closing remaining connections');
      (server as { closeAllConnections?: () => void }).closeAllConnections?.();
      process.exit(0);
    }, 8_000);
    force.unref();
    server.close(() => {
      log.info('server closed');
      process.exit(0);
    });
    (server as { closeIdleConnections?: () => void }).closeIdleConnections?.();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const a = pathToFileURL(realpathSync(entry)).href;
    const b = pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href;
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((err) => {
    process.stderr.write(`server failed to start: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  });
}
