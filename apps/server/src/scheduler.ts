/**
 * Collection scheduler: runs the collector (runCollection) and the export (buildDataset + writeExport) every
 * COLLECT_INTERVAL_MIN minutes inside the server process. OWNER: server.
 *
 * - Never two runs at once: a tick that finds a run in progress is skipped (logged) and rescheduled.
 * - A failing run (thrown error, total source failure, failed export) is logged and recorded in status();
 *   it never throws out of the scheduler, so the server keeps serving the last good dataset.
 * - status() feeds the public /api/v1/health: by default it carries only the public-safe summary (message) and a
 *   generic error note; raw error text and job details (which hold filesystem paths) need status(true).
 * - First run: at `firstRunAt` (main.ts passes "one interval after the loaded export was generated", or a short
 *   delay when that is already overdue / there is no export).
 */
import { mkdirSync } from 'node:fs';
import { buildDatasetDetailed, createLogger, defaultLogFile, openStore, runCollection, writeExport } from '@vti/collector';
import type { Logger, RunCollectionResult, Seeds, SourceAdapter, WriteExportResult } from '@vti/collector';
import type { AppLogger } from './app.ts';

export interface JobSummary {
  ok: boolean;
  /**
   * One-line summary for status + logs. Shown on the public /api/v1/health, so it must not contain filesystem
   * paths or raw error text (put those in `error` / `details`).
   */
  message: string;
  /** Raw diagnostic of a failed run (server log + verbose health only). Default: `message`. */
  error?: string | null;
  /** Diagnostics (may hold paths): server-side + verbose health only. */
  details?: Record<string, unknown>;
}

export type Job = () => Promise<JobSummary>;

export interface SchedulerOptions {
  /** Interval between run starts (ms). Must be > 0. */
  intervalMs: number;
  job: Job;
  log: AppLogger;
  /** Absolute time of the first run (default: now + intervalMs). */
  firstRunAt?: number;
  /** Minimum delay before any run after start / after a run (ms). Default 5 s. */
  minDelayMs?: number;
  clock?: () => number;
}

export interface RunRecord {
  startedAt: number;
  finishedAt: number;
  ok: boolean;
  message: string;
  error: string | null;
  details?: Record<string, unknown>;
}

export interface SchedulerStatus {
  enabled: boolean;
  intervalMin: number;
  running: boolean;
  currentRunStartedAt: number | null;
  nextRunAt: number | null;
  runs: number;
  failures: number;
  skippedTicks: number;
  lastRun: RunRecord | null;
}

/** Public stand-in for a failed run's raw error (the full text is in the server log). */
export const RUN_ERROR_PUBLIC = '수집 실행이 실패했습니다. 자세한 내용은 서버 로그를 확인하세요.';

function errText(err: unknown): string {
  return err instanceof Error ? err.message || err.name : String(err);
}

export class Scheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private current: Promise<RunRecord> | null = null;
  private currentStartedAt: number | null = null;
  private nextAt: number | null = null;
  private stopped = true;
  private runs = 0;
  private failures = 0;
  private skipped = 0;
  private last: RunRecord | null = null;
  private readonly clock: () => number;
  private readonly minDelay: number;

  constructor(private readonly opts: SchedulerOptions) {
    if (!(opts.intervalMs > 0)) throw new RangeError('Scheduler: intervalMs must be > 0');
    this.clock = opts.clock ?? Date.now;
    this.minDelay = opts.minDelayMs ?? 5_000;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const now = this.clock();
    this.schedule(Math.max(now + this.minDelay, this.opts.firstRunAt ?? now + this.opts.intervalMs));
  }

  private schedule(at: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.nextAt = at;
    const delay = Math.max(0, at - this.clock());
    // setTimeout caps at ~24.8 days; intervals are hours, but clamp anyway.
    this.timer = setTimeout(() => this.tick(), Math.min(delay, 2_000_000_000));
    this.timer.unref?.();
    this.opts.log.info(`scheduler: next collection at ${new Date(at).toISOString()}`);
  }

  private tick(): void {
    this.timer = null;
    if (this.stopped) return;
    if (this.current) {
      this.skipped++;
      this.opts.log.warn('scheduler: previous collection still running; skipping this tick');
      this.schedule(this.clock() + this.opts.intervalMs);
      return;
    }
    void this.runNow();
  }

  /**
   * Start a run now unless one is already running (then the running one is returned).
   * Always resolves (errors are captured in the RunRecord).
   */
  runNow(): Promise<RunRecord> {
    if (this.current) return this.current;
    const startedAt = this.clock();
    this.currentStartedAt = startedAt;
    this.nextAt = null;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.opts.log.info('scheduler: collection started');
    const p = (async (): Promise<RunRecord> => {
      let rec: RunRecord;
      try {
        const s = await this.opts.job();
        rec = { startedAt, finishedAt: this.clock(), ok: s.ok, message: s.message, error: s.ok ? null : (s.error ?? s.message), details: s.details };
      } catch (err) {
        rec = { startedAt, finishedAt: this.clock(), ok: false, message: 'collection failed', error: errText(err) };
      }
      this.runs++;
      if (!rec.ok) this.failures++;
      this.last = rec;
      const secs = Math.round((rec.finishedAt - startedAt) / 1000);
      if (rec.ok) this.opts.log.info(`scheduler: collection finished in ${secs}s — ${rec.message}`);
      else this.opts.log.error(`scheduler: collection failed after ${secs}s — ${rec.error ?? rec.message}`);
      return rec;
    })();
    this.current = p;
    void p.finally(() => {
      this.current = null;
      this.currentStartedAt = null;
      if (!this.stopped) this.schedule(Math.max(this.clock() + this.minDelay, startedAt + this.opts.intervalMs));
    });
    return p;
  }

  /** Stop scheduling. Resolves when timers are cleared (a running collection is NOT awaited unless `wait`). */
  async stop(wait = false): Promise<void> {
    this.stopped = true;
    this.nextAt = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (wait && this.current) await this.current.catch(() => undefined);
  }

  get running(): boolean {
    return this.current !== null;
  }

  /**
   * Scheduler state for /api/v1/health. Default (public): lastRun without `details` and with a generic `error`,
   * since both can hold filesystem paths or raw error text. `verbose` (HEALTH_VERBOSE=1) returns the full record.
   */
  status(verbose = false): SchedulerStatus {
    const last = this.last;
    return {
      enabled: !this.stopped,
      intervalMin: Math.round(this.opts.intervalMs / 60_000),
      running: this.current !== null,
      currentRunStartedAt: this.currentStartedAt,
      nextRunAt: this.nextAt,
      runs: this.runs,
      failures: this.failures,
      skippedTicks: this.skipped,
      lastRun:
        !last || verbose
          ? last
          : { startedAt: last.startedAt, finishedAt: last.finishedAt, ok: last.ok, message: last.message, error: last.error === null ? null : RUN_ERROR_PUBLIC },
    };
  }
}

/* ------------------------------------------------------------------------------------------
 * The real job: collect + export
 * ---------------------------------------------------------------------------------------- */

export interface CollectJobOptions {
  dbPath: string;
  exportDir: string;
  /** Data dir whose logs/ folder receives the collector log (data/logs/collector-YYYY-MM-DD.log). null = console only. */
  logDir?: string | null;
  /** Also copy dataset.json here (e.g. apps/web/public/data/dataset.json for `npm run dev`). */
  copyTo?: string | null;
  env?: Record<string, string | undefined>;
  budgetBytes?: number;
  /** Called after a successful export (main.ts reloads the index). */
  onExported?: (result: WriteExportResult) => void | Promise<void>;
  /** Console output of the collector logger (default true). */
  console?: boolean;
  /** Restrict the run to these adapter ids (COLLECT_SOURCES). Default: all enabled adapters. */
  sources?: string[];
  /** Per-source request cap override (COLLECT_MAX_REQUESTS). */
  maxRequestsPerSource?: number;
  /** Adapter registry / seeds override (tests). */
  adapters?: readonly SourceAdapter[];
  seeds?: Seeds;
}

function summarize(collection: RunCollectionResult): string {
  return collection.summaries
    .filter((s) => s.status !== 'disabled')
    .map((s) => `${s.source} ${s.status} (videos ${s.videosSeen}, new ${s.videosNew}, obs ${s.observations}, errors ${s.errors.length})`)
    .join('; ');
}

/**
 * Job that runs one collection and writes the export. The store is opened for the run and closed afterwards
 * (so the collector CLI can use it between runs). An export is written even after a failed collection so the
 * coverage page shows the failure (same as the CLI `run`).
 */
export function createCollectJob(opts: CollectJobOptions): Job {
  return async () => {
    const now = Date.now();
    if (opts.logDir) mkdirSync(opts.logDir, { recursive: true });
    const log: Logger = createLogger({ file: opts.logDir ? defaultLogFile(opts.logDir, now) : null, console: opts.console ?? true }).child('collect');
    const env = opts.env ?? (process.env as Record<string, string | undefined>);
    const store = openStore(opts.dbPath);
    try {
      const collection = await runCollection({
        db: store,
        env,
        log,
        ...(opts.sources?.length ? { sources: opts.sources } : {}),
        ...(opts.maxRequestsPerSource !== undefined ? { maxRequestsPerSource: opts.maxRequestsPerSource } : {}),
        ...(opts.adapters ? { adapters: opts.adapters } : {}),
        ...(opts.seeds ? { seeds: opts.seeds } : {}),
      });
      let exp: WriteExportResult | null = null;
      let exportError: string | null = null;
      try {
        const built = buildDatasetDetailed(store, {
          now: Date.now(),
          env,
          log,
          ...(opts.adapters ? { adapters: opts.adapters } : {}),
          ...(opts.budgetBytes ? { budgetBytes: opts.budgetBytes } : {}),
        });
        exp = writeExport(built.dataset, opts.exportDir, { copyTo: opts.copyTo ?? null });
        log.info(
          `export: ${built.dataset.videos.length} video(s), ${built.stats.exportedObservations} observation(s) (raw ${built.stats.rawObservations}), ${(exp.bytes / 1_000_000).toFixed(2)} MB -> ${exp.datasetPath}` +
            (built.stats.prunedVideos ? `; pruned ${built.stats.prunedVideos} video(s) for the size budget` : ''),
        );
      } catch (err) {
        exportError = errText(err);
        log.error(`export failed: ${exportError}`);
      }
      if (exp && opts.onExported) {
        try {
          await opts.onExported(exp);
        } catch (err) {
          log.error(`reload after export failed: ${errText(err)}`);
        }
      }
      const sources = `${collection.succeeded}/${collection.attempted} source(s) ok`;
      const ok = !collection.totalFailure && exportError === null;
      // `message` is public (health); the raw export error (it usually names a path) goes to `error` only.
      const message = exportError ? `${sources}; export failed (see the server log)` : collection.totalFailure ? `all sources failed (${summarize(collection)}); export written` : `${sources}; ${summarize(collection)}`;
      return {
        ok,
        message,
        error: exportError ? `${sources}; export failed: ${exportError}` : null,
        details: {
          attempted: collection.attempted,
          succeeded: collection.succeeded,
          sources: collection.summaries.map((s) => ({ source: s.source, status: s.status, videosSeen: s.videosSeen, videosNew: s.videosNew, observations: s.observations, errors: s.errors.length })),
          export: exp ? { path: exp.datasetPath, bytes: exp.bytes, generatedAt: exp.meta.generatedAt, videos: exp.meta.counts.videos } : null,
          exportError,
        },
      };
    } finally {
      store.close();
    }
  };
}
