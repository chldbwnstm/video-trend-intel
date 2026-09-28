/**
 * SQLite store (node:sqlite, `data/store.sqlite`). OWNER: collector-pipeline.
 *
 * Raw observations are append-only and never compacted here (compaction happens only in the export).
 * Deleted / private videos are never removed: their `status` changes (SPEC "Store").
 *
 * Schema versions are tracked with `PRAGMA user_version`; every migration is idempotent
 * (`CREATE ... IF NOT EXISTS`), so opening an existing database twice is safe.
 */
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { PLATFORMS } from '@vti/core';
import type {
  CategoryAssignment,
  CollectionRun,
  FollowerPoint,
  MetricKey,
  ObservationPoint,
  Platform,
  SourceCoverage,
  SourceWindowMetric,
  SponsorshipSignal,
  VideoFormat,
  VideoStatus,
} from '@vti/core';
import { adapterById } from './sources/index.ts';
import type { RawAccount, RawVideo } from './types.ts';

/* ------------------------------------------------------------------------------------------
 * node:sqlite loading (suppress the one-time ExperimentalWarning)
 * ---------------------------------------------------------------------------------------- */

type SqliteModule = typeof import('node:sqlite');
let sqliteModule: SqliteModule | null = null;

function loadSqlite(): SqliteModule {
  if (sqliteModule) return sqliteModule;
  const original = process.emitWarning;
  process.emitWarning = function patched(this: unknown, warning: string | Error, ...rest: unknown[]) {
    const msg = typeof warning === 'string' ? warning : warning?.message ?? '';
    const first = rest[0];
    const type = typeof first === 'string' ? first : first && typeof first === 'object' ? (first as { type?: string }).type : typeof warning === 'object' ? warning?.name : undefined;
    if (type === 'ExperimentalWarning' && /sqlite/i.test(msg)) return;
    return (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    sqliteModule = createRequire(import.meta.url)('node:sqlite') as SqliteModule;
  } finally {
    process.emitWarning = original;
  }
  return sqliteModule;
}

/* ------------------------------------------------------------------------------------------
 * Constants
 * ---------------------------------------------------------------------------------------- */

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** An observation identical to the previous one less than this earlier is not stored. */
export const OBS_DEDUPE_WINDOW_MS = 15 * MINUTE;
/** Max `discoveredVia` entries kept per video/account (first ones win). */
export const MAX_DISCOVERED_VIA = 30;
/** Max error lines stored per run (the last stored line says how many more there were). */
export const MAX_RUN_ERRORS = 200;

export interface RefreshTier {
  name: 'fresh' | 'recent' | 'mature' | 'old' | 'unavailable';
  /** Video age (now - publishedAt) upper bound, exclusive. */
  maxAgeMs: number;
  /** Re-observe when the last observation is at least this old (0 = every run). */
  intervalMs: number;
}

/** SPEC tiered refresh: age < 3 d every run; 3–14 d every ~12 h; 14–90 d daily; older weekly (top slice by views). */
export const REFRESH_TIERS: readonly RefreshTier[] = [
  { name: 'fresh', maxAgeMs: 3 * DAY, intervalMs: 0 },
  { name: 'recent', maxAgeMs: 14 * DAY, intervalMs: 12 * HOUR },
  { name: 'mature', maxAgeMs: 90 * DAY, intervalMs: DAY },
  { name: 'old', maxAgeMs: Number.POSITIVE_INFINITY, intervalMs: 7 * DAY },
];
/** Videos whose last known status is private/unknown are re-checked weekly. */
export const UNAVAILABLE_RECHECK_MS = 7 * DAY;
/** A tier interval counts as elapsed at 95% (runs are scheduled, e.g. hourly: 11h50m after the last one is "~12 h"). */
export const REFRESH_INTERVAL_SLACK = 0.95;
/** Old tier: only videos in the top fraction (at least OLD_TOP_MIN) of the platform's old videos by views. */
export const OLD_TOP_FRACTION = 0.2;
export const OLD_TOP_MIN = 100;

export const SCHEMA_VERSION = 1;

/* ------------------------------------------------------------------------------------------
 * Migrations
 * ---------------------------------------------------------------------------------------- */

const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  platform_id TEXT NOT NULL,
  handle TEXT,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  avatar TEXT,
  country TEXT,
  seed_category TEXT,
  tracked_since INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  discovered_via TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS accounts_platform ON accounts(platform);

CREATE TABLE IF NOT EXISTS videos (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  platform_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  thumbnail TEXT,
  published_at INTEGER NOT NULL,
  duration_sec REAL,
  format TEXT NOT NULL DEFAULT 'unknown',
  account_id TEXT NOT NULL,
  language TEXT,
  language_source TEXT,
  country TEXT,
  source_category TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  status_changed_at INTEGER,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  last_observed_at INTEGER,
  last_views INTEGER,
  discovered_via TEXT NOT NULL DEFAULT '[]',
  text_hash TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS videos_platform_published ON videos(platform, published_at);
CREATE INDEX IF NOT EXISTS videos_account ON videos(account_id);

CREATE TABLE IF NOT EXISTS video_sources (
  video_id TEXT NOT NULL,
  source TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (video_id, source)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS video_sources_source ON video_sources(source);

CREATE TABLE IF NOT EXISTS account_sources (
  account_id TEXT NOT NULL,
  source TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, source)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS account_sources_source ON account_sources(source);

CREATE TABLE IF NOT EXISTS observations (
  video_id TEXT NOT NULL,
  t INTEGER NOT NULL,
  views INTEGER,
  likes INTEGER,
  comments INTEGER,
  shares INTEGER,
  src TEXT NOT NULL,
  PRIMARY KEY (video_id, t, src)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS source_windows (
  video_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  window_hours REAL NOT NULL,
  value REAL NOT NULL,
  observed_at INTEGER NOT NULL,
  src TEXT NOT NULL,
  PRIMARY KEY (video_id, metric, window_hours, observed_at, src)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS follower_obs (
  account_id TEXT NOT NULL,
  t INTEGER NOT NULL,
  value INTEGER NOT NULL,
  src TEXT NOT NULL,
  PRIMARY KEY (account_id, t, src)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS video_classification (
  video_id TEXT PRIMARY KEY,
  categories TEXT NOT NULL,
  topics TEXT NOT NULL,
  sponsorship TEXT,
  classifier_version TEXT NOT NULL,
  sponsorship_version TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  account_seed TEXT,
  classified_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS creators (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  link_status TEXT NOT NULL,
  note TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS creator_accounts (
  creator_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (creator_id, account_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS creator_accounts_account ON creator_accounts(account_id);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL DEFAULT 'running',
  videos_seen INTEGER NOT NULL DEFAULT 0,
  videos_new INTEGER NOT NULL DEFAULT 0,
  observations INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS runs_started ON runs(started_at);
CREATE INDEX IF NOT EXISTS runs_source_started ON runs(source, started_at);
CREATE TABLE IF NOT EXISTS run_errors (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  message TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS source_state (
  source TEXT PRIMARY KEY,
  first_run_at INTEGER,
  last_run_at INTEGER,
  last_success_at INTEGER,
  last_status TEXT NOT NULL DEFAULT 'never',
  last_error TEXT,
  notes TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER
);
`,
  },
];

/* ------------------------------------------------------------------------------------------
 * Public row types
 * ---------------------------------------------------------------------------------------- */

export interface StoredAccount {
  id: string;
  platform: Platform;
  platformId: string;
  handle: string | null;
  name: string;
  url: string;
  avatar: string | null;
  country: string | null;
  seedCategory: string | null;
  trackedSince: number;
  lastSeenAt: number;
  discoveredVia: string[];
}

export interface StoredClassification {
  categories: CategoryAssignment[];
  topics: string[];
  sponsorship: SponsorshipSignal | null;
  classifierVersion: string;
  sponsorshipVersion: string;
  textHash: string;
  accountSeed: string | null;
  classifiedAt: number;
}

export interface StoredVideo {
  id: string;
  platform: Platform;
  platformId: string;
  url: string;
  title: string;
  description: string | null;
  thumbnail: string | null;
  publishedAt: number;
  durationSec: number | null;
  format: VideoFormat;
  accountId: string;
  language: string | null;
  languageSource: 'source' | 'detected' | null;
  country: string | null;
  sourceCategory: string | null;
  tags: string[];
  status: VideoStatus;
  statusChangedAt: number | null;
  firstSeenAt: number;
  lastSeenAt: number;
  lastObservedAt: number | null;
  lastViews: number | null;
  discoveredVia: string[];
  textHash: string;
}

export interface VideoForExport extends StoredVideo {
  obs: ObservationPoint[];
  sourceWindows: SourceWindowMetric[];
  classification: StoredClassification | null;
  /** Adapter ids that returned this video at least once. */
  sources: string[];
}

export interface AccountForExport extends StoredAccount {
  followers: FollowerPoint[];
  sources: string[];
}

export interface StoredCreator {
  id: string;
  name: string;
  linkStatus: 'verified' | 'suggested';
  note: string | null;
  accountIds: string[];
  updatedAt: number;
}

export type SourceStatus = SourceCoverage['lastStatus'];

export interface SourceState {
  source: string;
  firstRunAt: number | null;
  lastRunAt: number | null;
  lastSuccessAt: number | null;
  lastStatus: SourceStatus;
  lastError: string | null;
  notes: string[];
  updatedAt: number | null;
}

export interface RefreshCandidate {
  videoId: string;
  platformId: string;
  tier: RefreshTier['name'];
  publishedAt: number;
  lastObservedAt: number | null;
  lastViews: number | null;
  status: VideoStatus;
  /** Elapsed-since-last-observation / tier interval (Infinity when never observed or interval 0). */
  overdue: number;
}

export interface RefreshCandidateOptions {
  /** Platform whose videos are candidates (default: the adapter's platform, or `source` itself if it is a platform). */
  platform?: Platform;
  tiers?: readonly RefreshTier[];
  oldTopFraction?: number;
  oldTopMin?: number;
}

export interface StoreCounts {
  videos: number;
  accounts: number;
  observations: number;
  sourceWindows: number;
  followerObs: number;
  classified: number;
  creators: number;
  runs: number;
  videosByPlatform: Record<string, number>;
  videosByStatus: Record<string, number>;
  accountsByPlatform: Record<string, number>;
  videosBySource: Record<string, number>;
  accountsBySource: Record<string, number>;
}

export interface DatasetParts {
  videos: VideoForExport[];
  accounts: AccountForExport[];
  creators: StoredCreator[];
  runs: CollectionRun[];
  sourceStates: SourceState[];
}

export interface LoadDatasetPartsOptions {
  /** Transform each video's full, sorted observation list (e.g. export compaction) while streaming. */
  mapObs?: (obs: ObservationPoint[], videoId: string) => ObservationPoint[];
  /** Transform each video's source windows (default: keep all). */
  mapSourceWindows?: (windows: SourceWindowMetric[], videoId: string) => SourceWindowMetric[];
  /** Transform each account's follower series. */
  mapFollowers?: (points: FollowerPoint[], accountId: string) => FollowerPoint[];
  /** Number of most recent runs to include (default 50). */
  runLimit?: number;
}

export interface FinishRunInput {
  finishedAt: number;
  status: CollectionRun['status'];
  videosSeen: number;
  videosNew: number;
  observations: number;
  requests: number;
  errors: string[];
}

export interface SourceStateUpdate {
  runAt?: number | null;
  status: SourceStatus;
  /** Marks a successful (ok/partial) run at `runAt`. */
  success?: boolean;
  error?: string | null;
  notes?: string[];
  now: number;
}

/* ------------------------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------------------- */

type Row = Record<string, unknown>;
type Param = null | number | string;

function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'bigint') return Number(v);
  return null;
}

function reqNum(v: unknown, fallback = 0): number {
  return num(v) ?? fallback;
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function jsonArray<T = string>(v: unknown): T[] {
  if (typeof v !== 'string' || !v) return [];
  try {
    const p = JSON.parse(v);
    return Array.isArray(p) ? (p as T[]) : [];
  } catch {
    return [];
  }
}

function jsonValue<T>(v: unknown, fallback: T): T {
  if (typeof v !== 'string' || !v) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

/** Non-negative finite integer counter, else null (null is never coerced to 0). */
export function cleanCounter(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  return Math.round(v);
}

function cleanStr(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
}

function mergeList(existing: string[], add: readonly string[], max = MAX_DISCOVERED_VIA): string[] {
  const out = [...existing];
  for (const a of add) {
    if (!a || out.includes(a)) continue;
    if (out.length >= max) break;
    out.push(a);
  }
  return out;
}

export function videoIdOf(platform: string, platformId: string): string {
  return `${platform}:${platformId}`;
}

/** Stable hash of the fields the classifier reads from a video (title, description, tags, source category, language). */
export function videoTextHash(v: { title: string; description: string | null; tags: string[]; sourceCategory: string | null; language: string | null }): string {
  return createHash('sha1')
    .update(JSON.stringify([v.title ?? '', v.description ?? null, v.tags ?? [], v.sourceCategory ?? null, v.language ?? null]))
    .digest('hex')
    .slice(0, 20);
}

/** `youtube:seed:<category>` style categories are channel-level hints; a native source category is preferred. */
function isSeedCategory(c: string | null): boolean {
  return !!c && /:seed:/.test(c);
}

const VIDEO_STATUSES: VideoStatus[] = ['active', 'deleted', 'private', 'unknown'];
const FORMATS: VideoFormat[] = ['short', 'long', 'live', 'unknown'];
const METRICS: MetricKey[] = ['views', 'likes', 'comments', 'shares'];

function asStatus(v: unknown): VideoStatus {
  return VIDEO_STATUSES.includes(v as VideoStatus) ? (v as VideoStatus) : 'unknown';
}

function asFormat(v: unknown): VideoFormat {
  return FORMATS.includes(v as VideoFormat) ? (v as VideoFormat) : 'unknown';
}

function sameCounters(a: Row, p: ObservationPoint): boolean {
  return num(a.views) === p.views && num(a.likes) === p.likes && num(a.comments) === p.comments && num(a.shares) === p.shares;
}

function rowToVideo(r: Row): StoredVideo {
  const ls = strOrNull(r.language_source);
  return {
    id: String(r.id),
    platform: String(r.platform) as Platform,
    platformId: String(r.platform_id),
    url: String(r.url),
    title: String(r.title ?? ''),
    description: strOrNull(r.description),
    thumbnail: strOrNull(r.thumbnail),
    publishedAt: reqNum(r.published_at),
    durationSec: num(r.duration_sec),
    format: asFormat(r.format),
    accountId: String(r.account_id),
    language: strOrNull(r.language),
    languageSource: ls === 'source' || ls === 'detected' ? ls : null,
    country: strOrNull(r.country),
    sourceCategory: strOrNull(r.source_category),
    tags: jsonArray<string>(r.tags),
    status: asStatus(r.status),
    statusChangedAt: num(r.status_changed_at),
    firstSeenAt: reqNum(r.first_seen_at),
    lastSeenAt: reqNum(r.last_seen_at),
    lastObservedAt: num(r.last_observed_at),
    lastViews: num(r.last_views),
    discoveredVia: jsonArray<string>(r.discovered_via),
    textHash: String(r.text_hash ?? ''),
  };
}

function rowToAccount(r: Row): StoredAccount {
  return {
    id: String(r.id),
    platform: String(r.platform) as Platform,
    platformId: String(r.platform_id),
    handle: strOrNull(r.handle),
    name: String(r.name ?? ''),
    url: String(r.url ?? ''),
    avatar: strOrNull(r.avatar),
    country: strOrNull(r.country),
    seedCategory: strOrNull(r.seed_category),
    trackedSince: reqNum(r.tracked_since),
    lastSeenAt: reqNum(r.last_seen_at),
    discoveredVia: jsonArray<string>(r.discovered_via),
  };
}

function rowToClassification(r: Row): StoredClassification {
  return {
    categories: jsonValue<CategoryAssignment[]>(r.categories, []),
    topics: jsonValue<string[]>(r.topics, []),
    sponsorship: jsonValue<SponsorshipSignal | null>(r.sponsorship, null),
    classifierVersion: String(r.classifier_version ?? ''),
    sponsorshipVersion: String(r.sponsorship_version ?? ''),
    textHash: String(r.text_hash ?? ''),
    accountSeed: strOrNull(r.account_seed),
    classifiedAt: reqNum(r.classified_at),
  };
}

function rowToSourceState(r: Row): SourceState {
  const st = String(r.last_status ?? 'never');
  const statuses: SourceStatus[] = ['ok', 'partial', 'error', 'disabled', 'never'];
  return {
    source: String(r.source),
    firstRunAt: num(r.first_run_at),
    lastRunAt: num(r.last_run_at),
    lastSuccessAt: num(r.last_success_at),
    lastStatus: statuses.includes(st as SourceStatus) ? (st as SourceStatus) : 'never',
    lastError: strOrNull(r.last_error),
    notes: jsonArray<string>(r.notes),
    updatedAt: num(r.updated_at),
  };
}

/* ------------------------------------------------------------------------------------------
 * Store
 * ---------------------------------------------------------------------------------------- */

export class Store {
  readonly db: DatabaseSync;
  readonly path: string;
  private readonly stmts = new Map<string, StatementSync>();
  private txDepth = 0;
  private closed = false;

  constructor(path: string) {
    const { DatabaseSync } = loadSqlite();
    this.path = path;
    if (path !== ':memory:' && !path.startsWith('file:')) mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA busy_timeout = 5000');
      if (path !== ':memory:') {
        this.db.exec('PRAGMA journal_mode = WAL');
        this.db.exec('PRAGMA synchronous = NORMAL');
      }
      this.db.exec('PRAGMA temp_store = MEMORY');
      this.migrate();
    } catch (err) {
      this.db.close(); // do not leak the file handle (Windows keeps the file locked)
      throw err;
    }
  }

  /* ---------------------------------------------------------------- infrastructure */

  get schemaVersion(): number {
    return reqNum((this.db.prepare('PRAGMA user_version').get() as Row).user_version);
  }

  private migrate(): void {
    const current = this.schemaVersion;
    if (current > SCHEMA_VERSION) {
      throw new Error(`store ${this.path} has schema version ${current}, newer than this collector (${SCHEMA_VERSION})`);
    }
    for (const m of MIGRATIONS) {
      if (m.version <= current) continue;
      this.transaction(() => {
        this.db.exec(m.sql);
        this.db.exec(`PRAGMA user_version = ${m.version}`);
      });
    }
  }

  private st(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  private run(sql: string, ...params: Param[]) {
    return this.st(sql).run(...params);
  }

  private get(sql: string, ...params: Param[]): Row | undefined {
    return this.st(sql).get(...params) as Row | undefined;
  }

  private all(sql: string, ...params: Param[]): Row[] {
    return this.st(sql).all(...params) as Row[];
  }

  /** Run `fn` in a transaction (nested calls join the outer one). Rolls back on throw. */
  transaction<T>(fn: () => T): T {
    if (this.txDepth > 0) {
      this.txDepth++;
      try {
        return fn();
      } finally {
        this.txDepth--;
      }
    }
    this.db.exec('BEGIN IMMEDIATE');
    this.txDepth = 1;
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* already rolled back */
      }
      throw err;
    } finally {
      this.txDepth = 0;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stmts.clear();
    this.db.close();
  }

  /* ---------------------------------------------------------------- accounts */

  /**
   * Insert or update an account. Nullable fields are only overwritten by non-null values; `trackedSince` keeps
   * the first sighting; `discoveredVia` is merged. Returns true when the account is new.
   */
  upsertAccount(a: RawAccount, now: number, discoveredVia: string | readonly string[] = [], source?: string): boolean {
    const id = videoIdOf(a.platform, a.platformId);
    const via = (typeof discoveredVia === 'string' ? [discoveredVia] : discoveredVia).filter(Boolean);
    const existing = this.get('SELECT * FROM accounts WHERE id = ?', id);
    const name = cleanStr(a.name);
    let isNew = false;
    if (!existing) {
      isNew = true;
      this.run(
        `INSERT INTO accounts (id, platform, platform_id, handle, name, url, avatar, country, seed_category, tracked_since, last_seen_at, discovered_via)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        a.platform,
        a.platformId,
        cleanStr(a.handle),
        name ?? a.platformId,
        cleanStr(a.url) ?? '',
        cleanStr(a.avatar),
        cleanStr(a.country),
        cleanStr(a.seedCategory ?? null),
        now,
        now,
        JSON.stringify(mergeList([], via)),
      );
    } else {
      const old = rowToAccount(existing);
      this.run(
        `UPDATE accounts SET handle = ?, name = ?, url = ?, avatar = ?, country = ?, seed_category = ?,
           tracked_since = ?, last_seen_at = ?, discovered_via = ? WHERE id = ?`,
        cleanStr(a.handle) ?? old.handle,
        name ?? old.name,
        cleanStr(a.url) ?? old.url,
        cleanStr(a.avatar) ?? old.avatar,
        cleanStr(a.country) ?? old.country,
        cleanStr(a.seedCategory ?? null) ?? old.seedCategory,
        Math.min(old.trackedSince, now),
        Math.max(old.lastSeenAt, now),
        JSON.stringify(mergeList(old.discoveredVia, via)),
        id,
      );
    }
    if (source) this.touchAccountSource(id, source, now);
    return isNew;
  }

  private touchAccountSource(accountId: string, source: string, now: number): void {
    this.run(
      `INSERT INTO account_sources (account_id, source, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(account_id, source) DO UPDATE SET last_seen_at = MAX(last_seen_at, excluded.last_seen_at),
         first_seen_at = MIN(first_seen_at, excluded.first_seen_at)`,
      accountId,
      source,
      now,
      now,
    );
  }

  getAccount(id: string): StoredAccount | null {
    const r = this.get('SELECT * FROM accounts WHERE id = ?', id);
    return r ? rowToAccount(r) : null;
  }

  /* ---------------------------------------------------------------- videos */

  /**
   * Insert a video or update its mutable fields. Keeps `firstSeenAt`, merges `discoveredVia`, never replaces a
   * known value with an unknown one (null description, empty tags, 'unknown' format...), prefers a source
   * language over a detected one and a native source category over a seed-derived one. A video that is
   * returned by a source again is 'active' unless the source says otherwise.
   */
  upsertVideo(v: RawVideo, now: number, source?: string): { id: string; isNew: boolean } {
    const id = videoIdOf(v.platform, v.platformId);
    const accountId = videoIdOf(v.account.platform, v.account.platformId);
    const existingRow = this.get('SELECT * FROM videos WHERE id = ?', id);
    const incomingTags = Array.isArray(v.tags) ? [...new Set(v.tags.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim()))] : [];
    const incomingStatus: VideoStatus = v.status && VIDEO_STATUSES.includes(v.status) ? v.status : 'active';
    const via = cleanStr(v.discoveredVia);
    const duration = typeof v.durationSec === 'number' && Number.isFinite(v.durationSec) && v.durationSec >= 0 ? v.durationSec : null;
    const format = asFormat(v.format);
    const lang = cleanStr(v.language);
    const langSource = lang ? (v.languageSource === 'source' || v.languageSource === 'detected' ? v.languageSource : null) : null;
    const sourceCategory = cleanStr(v.sourceCategory);

    if (!existingRow) {
      const merged = {
        title: typeof v.title === 'string' ? v.title : '',
        description: cleanStr(v.description),
        tags: incomingTags,
        sourceCategory,
        language: lang,
      };
      this.run(
        `INSERT INTO videos (id, platform, platform_id, url, title, description, thumbnail, published_at, duration_sec, format,
           account_id, language, language_source, country, source_category, tags, status, status_changed_at, first_seen_at,
           last_seen_at, last_observed_at, last_views, discovered_via, text_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
        id,
        v.platform,
        v.platformId,
        cleanStr(v.url) ?? '',
        merged.title,
        merged.description,
        cleanStr(v.thumbnail),
        Math.round(v.publishedAt),
        duration,
        format,
        accountId,
        lang,
        langSource,
        cleanStr(v.country),
        sourceCategory,
        JSON.stringify(incomingTags),
        incomingStatus,
        incomingStatus === 'active' ? null : now,
        now,
        now,
        JSON.stringify(via ? [via] : []),
        videoTextHash(merged),
      );
      if (source) this.touchVideoSource(id, source, now);
      return { id, isNew: true };
    }

    const old = rowToVideo(existingRow);
    // Language: a source-declared language beats a detected one.
    let language = old.language;
    let languageSource = old.languageSource;
    if (lang && !(old.languageSource === 'source' && langSource !== 'source')) {
      language = lang;
      languageSource = langSource;
    }
    // Source category: native category beats a seed-derived one.
    let mergedCategory = old.sourceCategory;
    if (sourceCategory && !(isSeedCategory(sourceCategory) && old.sourceCategory && !isSeedCategory(old.sourceCategory))) {
      mergedCategory = sourceCategory;
    }
    const isRefresh = !!via && /:refresh$/.test(via);
    const discovered = via && !(isRefresh && old.discoveredVia.length > 0) ? mergeList(old.discoveredVia, [via]) : old.discoveredVia;
    const merged = {
      title: typeof v.title === 'string' && v.title.trim() ? v.title : old.title,
      description: cleanStr(v.description) ?? old.description,
      tags: incomingTags.length ? incomingTags : old.tags,
      sourceCategory: mergedCategory,
      language,
    };
    const statusChanged = incomingStatus !== old.status;
    this.run(
      `UPDATE videos SET url = ?, title = ?, description = ?, thumbnail = ?, published_at = ?, duration_sec = ?, format = ?,
         account_id = ?, language = ?, language_source = ?, country = ?, source_category = ?, tags = ?, status = ?,
         status_changed_at = ?, last_seen_at = ?, discovered_via = ?, text_hash = ? WHERE id = ?`,
      cleanStr(v.url) ?? old.url,
      merged.title,
      merged.description,
      cleanStr(v.thumbnail) ?? old.thumbnail,
      Number.isFinite(v.publishedAt) ? Math.round(v.publishedAt) : old.publishedAt,
      duration ?? old.durationSec,
      format !== 'unknown' ? format : old.format,
      accountId,
      language,
      language ? languageSource : null,
      cleanStr(v.country) ?? old.country,
      merged.sourceCategory,
      JSON.stringify(merged.tags),
      incomingStatus,
      statusChanged ? now : old.statusChangedAt,
      Math.max(old.lastSeenAt, now),
      JSON.stringify(discovered),
      videoTextHash(merged),
      id,
    );
    if (source) this.touchVideoSource(id, source, now);
    return { id, isNew: false };
  }

  private touchVideoSource(videoId: string, source: string, now: number): void {
    this.run(
      `INSERT INTO video_sources (video_id, source, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(video_id, source) DO UPDATE SET last_seen_at = MAX(last_seen_at, excluded.last_seen_at),
         first_seen_at = MIN(first_seen_at, excluded.first_seen_at)`,
      videoId,
      source,
      now,
      now,
    );
  }

  getVideo(id: string): StoredVideo | null {
    const r = this.get('SELECT * FROM videos WHERE id = ?', id);
    return r ? rowToVideo(r) : null;
  }

  /**
   * Update the status of a video a source confirmed as deleted/private/unknown. Never deletes anything.
   * Returns true when the status changed. 'active' is ignored (a returned video is re-activated by upsertVideo).
   */
  markGone(videoId: string, status: VideoStatus, now: number): boolean {
    if (status === 'active' || !VIDEO_STATUSES.includes(status)) return false;
    const r = this.run('UPDATE videos SET status = ?, status_changed_at = ? WHERE id = ? AND status != ?', status, now, videoId, status);
    return Number(r.changes) > 0;
  }

  /* ---------------------------------------------------------------- observations */

  /**
   * Append an observation. Skipped (returns false) when an identical (video, t, src) row exists, or when the
   * counters equal the previous observation's and that one is less than 15 minutes earlier.
   */
  addObservation(videoId: string, p: ObservationPoint): boolean {
    const t = Math.round(p.t);
    if (!Number.isFinite(t)) return false;
    const point: ObservationPoint = {
      t,
      views: cleanCounter(p.views),
      likes: cleanCounter(p.likes),
      comments: cleanCounter(p.comments),
      shares: cleanCounter(p.shares),
      src: p.src,
    };
    const prev = this.get(
      'SELECT t, views, likes, comments, shares, src FROM observations WHERE video_id = ? AND t <= ? ORDER BY t DESC LIMIT 1',
      videoId,
      t,
    );
    if (prev) {
      const dt = t - reqNum(prev.t);
      if (dt < OBS_DEDUPE_WINDOW_MS && sameCounters(prev, point)) return false;
    }
    const r = this.run(
      'INSERT OR IGNORE INTO observations (video_id, t, views, likes, comments, shares, src) VALUES (?, ?, ?, ?, ?, ?, ?)',
      videoId,
      t,
      point.views,
      point.likes,
      point.comments,
      point.shares,
      point.src,
    );
    if (Number(r.changes) === 0) return false;
    this.run(
      `UPDATE videos SET
         last_views = CASE WHEN ? >= IFNULL(last_observed_at, -1) AND ? IS NOT NULL THEN ? ELSE last_views END,
         last_observed_at = MAX(IFNULL(last_observed_at, ?), ?)
       WHERE id = ?`,
      t,
      point.views,
      point.views,
      t,
      t,
      videoId,
    );
    return true;
  }

  getObservations(videoId: string): ObservationPoint[] {
    return this.all('SELECT t, views, likes, comments, shares, src FROM observations WHERE video_id = ? ORDER BY t, src', videoId).map((r) => ({
      t: reqNum(r.t),
      views: num(r.views),
      likes: num(r.likes),
      comments: num(r.comments),
      shares: num(r.shares),
      src: String(r.src),
    }));
  }

  /** Store source-reported window metrics (duplicates ignored). Returns how many rows were added. */
  addSourceWindows(videoId: string, windows: readonly SourceWindowMetric[]): number {
    let added = 0;
    for (const w of windows) {
      if (!METRICS.includes(w.metric)) continue;
      if (typeof w.value !== 'number' || !Number.isFinite(w.value) || w.value < 0) continue;
      if (typeof w.windowHours !== 'number' || !(w.windowHours > 0)) continue;
      if (!Number.isFinite(w.observedAt)) continue;
      const r = this.run(
        'INSERT OR IGNORE INTO source_windows (video_id, metric, window_hours, value, observed_at, src) VALUES (?, ?, ?, ?, ?, ?)',
        videoId,
        w.metric,
        w.windowHours,
        w.value,
        Math.round(w.observedAt),
        w.src,
      );
      added += Number(r.changes);
    }
    return added;
  }

  getSourceWindows(videoId: string): SourceWindowMetric[] {
    return this.all('SELECT metric, window_hours, value, observed_at, src FROM source_windows WHERE video_id = ? ORDER BY observed_at, metric, window_hours', videoId).map(
      (r) => ({
        metric: String(r.metric) as MetricKey,
        windowHours: reqNum(r.window_hours),
        value: reqNum(r.value),
        observedAt: reqNum(r.observed_at),
        src: String(r.src),
      }),
    );
  }

  /** Follower count observation; same dedupe rules as video observations. */
  addFollowerObservation(accountId: string, p: FollowerPoint): boolean {
    const t = Math.round(p.t);
    const value = cleanCounter(p.value);
    if (!Number.isFinite(t) || value === null) return false;
    const prev = this.get('SELECT t, value FROM follower_obs WHERE account_id = ? AND t <= ? ORDER BY t DESC LIMIT 1', accountId, t);
    if (prev && t - reqNum(prev.t) < OBS_DEDUPE_WINDOW_MS && num(prev.value) === value) return false;
    const r = this.run('INSERT OR IGNORE INTO follower_obs (account_id, t, value, src) VALUES (?, ?, ?, ?)', accountId, t, value, p.src);
    return Number(r.changes) > 0;
  }

  getFollowerObservations(accountId: string): FollowerPoint[] {
    return this.all('SELECT t, value, src FROM follower_obs WHERE account_id = ? ORDER BY t, src', accountId).map((r) => ({
      t: reqNum(r.t),
      value: reqNum(r.value),
      src: String(r.src),
    }));
  }

  /* ---------------------------------------------------------------- classification */

  setClassification(videoId: string, c: Omit<StoredClassification, 'classifiedAt'>, now: number): void {
    this.run(
      `INSERT INTO video_classification (video_id, categories, topics, sponsorship, classifier_version, sponsorship_version, text_hash, account_seed, classified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(video_id) DO UPDATE SET categories = excluded.categories, topics = excluded.topics,
         sponsorship = excluded.sponsorship, classifier_version = excluded.classifier_version,
         sponsorship_version = excluded.sponsorship_version, text_hash = excluded.text_hash,
         account_seed = excluded.account_seed, classified_at = excluded.classified_at`,
      videoId,
      JSON.stringify(c.categories ?? []),
      JSON.stringify(c.topics ?? []),
      c.sponsorship ? JSON.stringify(c.sponsorship) : null,
      c.classifierVersion,
      c.sponsorshipVersion,
      c.textHash,
      c.accountSeed ?? null,
      now,
    );
  }

  getClassification(videoId: string): StoredClassification | null {
    const r = this.get('SELECT * FROM video_classification WHERE video_id = ?', videoId);
    return r ? rowToClassification(r) : null;
  }

  /**
   * Videos whose classification is missing or stale: classifier/sponsorship version changed, the video text
   * changed, or the account seed category changed.
   */
  listVideosNeedingClassification(classifierVersion: string, sponsorshipVersion: string): (StoredVideo & { accountSeedCategory: string | null })[] {
    return this.all(
      `SELECT v.*, a.seed_category AS account_seed_category FROM videos v
       LEFT JOIN video_classification c ON c.video_id = v.id
       LEFT JOIN accounts a ON a.id = v.account_id
       WHERE c.video_id IS NULL OR c.classifier_version IS NOT ? OR c.sponsorship_version IS NOT ?
          OR c.text_hash IS NOT v.text_hash OR c.account_seed IS NOT a.seed_category`,
      classifierVersion,
      sponsorshipVersion,
    ).map((r) => ({ ...rowToVideo(r), accountSeedCategory: strOrNull(r.account_seed_category) }));
  }

  /* ---------------------------------------------------------------- creators */

  /**
   * Upsert creator portfolios. With `replace`, creators of the same link status that are not in `creators` are
   * removed (seed files are the source of truth for verified creators).
   */
  upsertCreators(
    creators: readonly { id: string; name: string; accountIds: readonly string[]; note: string | null; linkStatus?: 'verified' | 'suggested' }[],
    now: number,
    opts: { replace?: boolean; linkStatus?: 'verified' | 'suggested' } = {},
  ): void {
    const status = opts.linkStatus ?? 'verified';
    this.transaction(() => {
      const keep = new Set<string>();
      for (const c of creators) {
        const id = cleanStr(c.id);
        if (!id) continue;
        keep.add(id);
        this.run(
          `INSERT INTO creators (id, name, link_status, note, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, link_status = excluded.link_status, note = excluded.note,
             updated_at = excluded.updated_at`,
          id,
          cleanStr(c.name) ?? id,
          c.linkStatus ?? status,
          c.note ?? null,
          now,
        );
        this.run('DELETE FROM creator_accounts WHERE creator_id = ?', id);
        let seq = 0;
        for (const a of new Set(c.accountIds)) {
          const acc = cleanStr(a);
          if (acc) this.run('INSERT OR IGNORE INTO creator_accounts (creator_id, account_id, seq) VALUES (?, ?, ?)', id, acc, seq++);
        }
      }
      if (opts.replace) {
        for (const r of this.all('SELECT id FROM creators WHERE link_status = ?', status)) {
          const id = String(r.id);
          if (keep.has(id)) continue;
          this.run('DELETE FROM creator_accounts WHERE creator_id = ?', id);
          this.run('DELETE FROM creators WHERE id = ?', id);
        }
      }
    });
  }

  listCreators(): StoredCreator[] {
    const accounts = new Map<string, string[]>();
    for (const r of this.all('SELECT creator_id, account_id FROM creator_accounts ORDER BY creator_id, seq, account_id')) {
      const id = String(r.creator_id);
      const list = accounts.get(id);
      if (list) list.push(String(r.account_id));
      else accounts.set(id, [String(r.account_id)]);
    }
    return this.all('SELECT * FROM creators ORDER BY id').map((r) => ({
      id: String(r.id),
      name: String(r.name),
      linkStatus: r.link_status === 'suggested' ? 'suggested' : 'verified',
      note: strOrNull(r.note),
      accountIds: accounts.get(String(r.id)) ?? [],
      updatedAt: reqNum(r.updated_at),
    }));
  }

  /* ---------------------------------------------------------------- runs & source state */

  recordRun(run: { id: string; source: string; startedAt: number }): void {
    this.run("INSERT INTO runs (id, source, started_at, status) VALUES (?, ?, ?, 'running')", run.id, run.source, run.startedAt);
  }

  finishRun(id: string, r: FinishRunInput): void {
    const errors = r.errors.filter((e) => typeof e === 'string' && e);
    this.transaction(() => {
      this.run(
        `UPDATE runs SET finished_at = ?, status = ?, videos_seen = ?, videos_new = ?, observations = ?, requests = ?, error_count = ?
         WHERE id = ?`,
        r.finishedAt,
        r.status,
        r.videosSeen,
        r.videosNew,
        r.observations,
        r.requests,
        errors.length,
        id,
      );
      this.run('DELETE FROM run_errors WHERE run_id = ?', id);
      const stored = errors.length > MAX_RUN_ERRORS ? errors.slice(0, MAX_RUN_ERRORS - 1) : errors;
      stored.forEach((msg, i) => this.run('INSERT INTO run_errors (run_id, seq, message) VALUES (?, ?, ?)', id, i, msg.slice(0, 2000)));
      if (errors.length > MAX_RUN_ERRORS) {
        this.run(
          'INSERT INTO run_errors (run_id, seq, message) VALUES (?, ?, ?)',
          id,
          stored.length,
          `… 외 오류 ${errors.length - stored.length}건 (저장 한도 ${MAX_RUN_ERRORS}줄)`,
        );
      }
    });
  }

  /** Most recent runs first. Runs that never finished are reported as 'error' with an explanatory line. */
  listRuns(limit = 50, source?: string): CollectionRun[] {
    const rows = source
      ? this.all('SELECT * FROM runs WHERE source = ? ORDER BY started_at DESC, id DESC LIMIT ?', source, limit)
      : this.all('SELECT * FROM runs ORDER BY started_at DESC, id DESC LIMIT ?', limit);
    return rows.map((r) => {
      const id = String(r.id);
      const errors = this.all('SELECT message FROM run_errors WHERE run_id = ? ORDER BY seq', id).map((e) => String(e.message));
      let status = String(r.status);
      if (status !== 'ok' && status !== 'partial' && status !== 'error') {
        status = 'error';
        errors.push('실행 완료 기록 없음 (중단되었거나 아직 실행 중)');
      }
      return {
        id,
        startedAt: reqNum(r.started_at),
        finishedAt: num(r.finished_at),
        source: String(r.source),
        status: status as CollectionRun['status'],
        videosSeen: reqNum(r.videos_seen),
        videosNew: reqNum(r.videos_new),
        observations: reqNum(r.observations),
        requests: reqNum(r.requests),
        errors,
      };
    });
  }

  getSourceState(source: string): SourceState | null {
    const r = this.get('SELECT * FROM source_state WHERE source = ?', source);
    return r ? rowToSourceState(r) : null;
  }

  listSourceStates(): SourceState[] {
    return this.all('SELECT * FROM source_state ORDER BY source').map(rowToSourceState);
  }

  updateSourceState(source: string, u: SourceStateUpdate): void {
    const runAt = u.runAt ?? null;
    this.run(
      `INSERT INTO source_state (source, first_run_at, last_run_at, last_success_at, last_status, last_error, notes, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source) DO UPDATE SET
         first_run_at = COALESCE(source_state.first_run_at, excluded.first_run_at),
         last_run_at = COALESCE(excluded.last_run_at, source_state.last_run_at),
         last_success_at = COALESCE(excluded.last_success_at, source_state.last_success_at),
         last_status = excluded.last_status,
         last_error = excluded.last_error,
         notes = excluded.notes,
         updated_at = excluded.updated_at`,
      source,
      runAt,
      runAt,
      u.success && runAt !== null ? runAt : null,
      u.status,
      u.error ?? null,
      JSON.stringify(u.notes ?? []),
      u.now,
    );
  }

  /* ---------------------------------------------------------------- tiered refresh */

  /**
   * Videos of the source's platform that are due for re-observation at `now`, in priority order:
   * fresh (age < 3 d, newest first) → recent (3–14 d, every ~12 h) → mature (14–90 d, daily) → old (≥ 90 d,
   * weekly, only the top slice by views) → unavailable (private/unknown status, weekly re-check).
   * Within a tier the most overdue come first. Deleted videos are never refreshed.
   */
  getRefreshCandidates(source: string, now: number, opts: RefreshCandidateOptions = {}): RefreshCandidate[] {
    const platform = opts.platform ?? platformOfSource(source);
    const tiers = opts.tiers ?? REFRESH_TIERS;
    const rows = this.all(
      "SELECT id, platform_id, published_at, last_observed_at, last_views, status FROM videos WHERE platform = ? AND status != 'deleted'",
      platform,
    );
    const due: RefreshCandidate[] = [];
    const oldRows: RefreshCandidate[] = [];
    for (const r of rows) {
      const status = asStatus(r.status);
      const publishedAt = reqNum(r.published_at);
      const lastObservedAt = num(r.last_observed_at);
      const elapsed = lastObservedAt === null ? Number.POSITIVE_INFINITY : now - lastObservedAt;
      const base = { videoId: String(r.id), platformId: String(r.platform_id), publishedAt, lastObservedAt, lastViews: num(r.last_views), status };
      if (status !== 'active') {
        if (elapsed >= UNAVAILABLE_RECHECK_MS * REFRESH_INTERVAL_SLACK) {
          due.push({ ...base, tier: 'unavailable', overdue: elapsed / UNAVAILABLE_RECHECK_MS });
        }
        continue;
      }
      const age = Math.max(0, now - publishedAt);
      const tier = tiers.find((t) => age < t.maxAgeMs) ?? tiers[tiers.length - 1];
      const overdue = tier.intervalMs > 0 ? elapsed / tier.intervalMs : Number.POSITIVE_INFINITY;
      if (tier.intervalMs > 0 && elapsed < tier.intervalMs * REFRESH_INTERVAL_SLACK) continue;
      const cand: RefreshCandidate = { ...base, tier: tier.name, overdue };
      if (tier.name === 'old') oldRows.push(cand);
      else due.push(cand);
    }

    // Old tier: only the top slice of the platform's old active videos by views (computed over all old videos).
    if (oldRows.length) {
      const oldStart = tierStart(tiers, 'old');
      const withViews = rows
        .filter((r) => asStatus(r.status) === 'active' && now - reqNum(r.published_at) >= oldStart)
        .map((r) => num(r.last_views))
        .filter((v): v is number => v !== null)
        .sort((a, b) => b - a);
      const slice = Math.max(opts.oldTopMin ?? OLD_TOP_MIN, Math.ceil(withViews.length * (opts.oldTopFraction ?? OLD_TOP_FRACTION)));
      const threshold = withViews.length === 0 ? Number.POSITIVE_INFINITY : withViews[Math.min(slice, withViews.length) - 1];
      for (const c of oldRows) if (c.lastViews !== null && c.lastViews >= threshold) due.push(c);
    }

    const order: Record<RefreshCandidate['tier'], number> = { fresh: 0, recent: 1, mature: 2, old: 3, unavailable: 4 };
    due.sort((a, b) => {
      if (a.tier !== b.tier) return order[a.tier] - order[b.tier];
      if (a.tier === 'fresh') return b.publishedAt - a.publishedAt || a.videoId.localeCompare(b.videoId);
      if (a.overdue !== b.overdue) return b.overdue - a.overdue;
      return (b.lastViews ?? -1) - (a.lastViews ?? -1) || a.videoId.localeCompare(b.videoId);
    });
    return due;
  }

  /* ---------------------------------------------------------------- export & stats */

  /**
   * Everything the export needs. Observations are streamed in (video_id, t) order and handed to `mapObs` one video
   * at a time, so memory holds only the (compacted) result, never every raw observation.
   */
  loadDatasetParts(opts: LoadDatasetPartsOptions = {}): DatasetParts {
    const obsByVideo = new Map<string, ObservationPoint[]>();
    let curId: string | null = null;
    let cur: ObservationPoint[] = [];
    const flush = () => {
      if (curId !== null) obsByVideo.set(curId, opts.mapObs ? opts.mapObs(cur, curId) : cur);
    };
    for (const r of this.st('SELECT video_id, t, views, likes, comments, shares, src FROM observations ORDER BY video_id, t, src').iterate() as Iterable<Row>) {
      const vid = String(r.video_id);
      if (vid !== curId) {
        flush();
        curId = vid;
        cur = [];
      }
      cur.push({ t: reqNum(r.t), views: num(r.views), likes: num(r.likes), comments: num(r.comments), shares: num(r.shares), src: String(r.src) });
    }
    flush();

    const windowsByVideo = new Map<string, SourceWindowMetric[]>();
    for (const r of this.st('SELECT video_id, metric, window_hours, value, observed_at, src FROM source_windows ORDER BY video_id, observed_at').iterate() as Iterable<Row>) {
      const vid = String(r.video_id);
      const w: SourceWindowMetric = { metric: String(r.metric) as MetricKey, windowHours: reqNum(r.window_hours), value: reqNum(r.value), observedAt: reqNum(r.observed_at), src: String(r.src) };
      const list = windowsByVideo.get(vid);
      if (list) list.push(w);
      else windowsByVideo.set(vid, [w]);
    }
    if (opts.mapSourceWindows) for (const [vid, list] of windowsByVideo) windowsByVideo.set(vid, opts.mapSourceWindows(list, vid));

    const classByVideo = new Map<string, StoredClassification>();
    for (const r of this.st('SELECT * FROM video_classification').iterate() as Iterable<Row>) classByVideo.set(String(r.video_id), rowToClassification(r));

    const videoSources = groupPairs(this.all('SELECT video_id AS k, source AS v FROM video_sources ORDER BY source'));
    const accountSources = groupPairs(this.all('SELECT account_id AS k, source AS v FROM account_sources ORDER BY source'));

    const videos: VideoForExport[] = [];
    for (const r of this.st('SELECT * FROM videos ORDER BY id').iterate() as Iterable<Row>) {
      const v = rowToVideo(r);
      videos.push({
        ...v,
        obs: obsByVideo.get(v.id) ?? [],
        sourceWindows: windowsByVideo.get(v.id) ?? [],
        classification: classByVideo.get(v.id) ?? null,
        sources: videoSources.get(v.id) ?? [],
      });
    }

    const followersByAccount = new Map<string, FollowerPoint[]>();
    for (const r of this.st('SELECT account_id, t, value, src FROM follower_obs ORDER BY account_id, t, src').iterate() as Iterable<Row>) {
      const id = String(r.account_id);
      const p: FollowerPoint = { t: reqNum(r.t), value: reqNum(r.value), src: String(r.src) };
      const list = followersByAccount.get(id);
      if (list) list.push(p);
      else followersByAccount.set(id, [p]);
    }
    const accounts: AccountForExport[] = this.all('SELECT * FROM accounts ORDER BY id').map((r) => {
      const a = rowToAccount(r);
      const f = followersByAccount.get(a.id) ?? [];
      return { ...a, followers: opts.mapFollowers ? opts.mapFollowers(f, a.id) : f, sources: accountSources.get(a.id) ?? [] };
    });

    return {
      videos,
      accounts,
      creators: this.listCreators(),
      runs: this.listRuns(opts.runLimit ?? 50),
      sourceStates: this.listSourceStates(),
    };
  }

  counts(): StoreCounts {
    const one = (sql: string) => reqNum(this.get(sql)?.n);
    const group = (sql: string) => {
      const out: Record<string, number> = {};
      for (const r of this.all(sql)) out[String(r.k)] = reqNum(r.n);
      return out;
    };
    return {
      videos: one('SELECT COUNT(*) AS n FROM videos'),
      accounts: one('SELECT COUNT(*) AS n FROM accounts'),
      observations: one('SELECT COUNT(*) AS n FROM observations'),
      sourceWindows: one('SELECT COUNT(*) AS n FROM source_windows'),
      followerObs: one('SELECT COUNT(*) AS n FROM follower_obs'),
      classified: one('SELECT COUNT(*) AS n FROM video_classification'),
      creators: one('SELECT COUNT(*) AS n FROM creators'),
      runs: one('SELECT COUNT(*) AS n FROM runs'),
      videosByPlatform: group('SELECT platform AS k, COUNT(*) AS n FROM videos GROUP BY platform'),
      videosByStatus: group('SELECT status AS k, COUNT(*) AS n FROM videos GROUP BY status'),
      accountsByPlatform: group('SELECT platform AS k, COUNT(*) AS n FROM accounts GROUP BY platform'),
      videosBySource: group('SELECT source AS k, COUNT(*) AS n FROM video_sources GROUP BY source'),
      accountsBySource: group('SELECT source AS k, COUNT(*) AS n FROM account_sources GROUP BY source'),
    };
  }
}

function groupPairs(rows: Row[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of rows) {
    const k = String(r.k);
    const list = out.get(k);
    if (list) list.push(String(r.v));
    else out.set(k, [String(r.v)]);
  }
  return out;
}

function tierStart(tiers: readonly RefreshTier[], name: RefreshTier['name']): number {
  const i = tiers.findIndex((t) => t.name === name);
  return i <= 0 ? 0 : tiers[i - 1].maxAgeMs;
}

/** Platform of an adapter id (or the id itself when it is a platform name). */
export function platformOfSource(source: string): Platform {
  if ((PLATFORMS as readonly string[]).includes(source)) return source as Platform;
  const a = adapterById(source);
  if (!a) throw new Error(`unknown source "${source}"`);
  return a.platform;
}

/** Open (and migrate) a store. Use ':memory:' for an in-memory database. */
export function openStore(path: string): Store {
  return new Store(path);
}
