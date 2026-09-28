/**
 * Collector CLI (run with tsx). OWNER: collector-pipeline.
 *
 *   collect [--sources a,b] [--max-requests N] [--db data/store.sqlite] [--seeds dir] [--no-classify]
 *   export  [--out data/export] [--copy-to-web] [--db ...] [--budget-mb 40] [--tz Asia/Seoul]
 *   run     [collect options] [--out ...] [--no-copy-to-web]      collect, then export (+ copy to the web app)
 *   stats   [--db ...] [--json]
 *   add-youtube-channel <UC-id|@handle|channel URL> --category <taxonomy id> [--country KR] [--language ko]
 *           [--name "..."] [--creator <creatorId>] [--force]
 *
 * Global: --log-file <path> | --no-log-file, --help.
 * Relative paths are resolved against the repository root (so `npm run collect -w @vti/collector` and a run from
 * the repo root use the same files). `.env` in the repo root is loaded when present (existing env wins).
 * Exit codes: 0 ok (including partial success), 1 total failure, 2 usage error.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { taxonomyById } from '@vti/core';
import { ADAPTERS } from './sources/index.ts';
import { parseYoutubeFeed, youtubeFeedUrl } from './sources/youtube-rss.ts';
import type { HttpClient, YoutubeChannelSeed } from './types.ts';
import { createHttpClient } from './http.ts';
import { createLogger, defaultLogFile, type Logger } from './log.ts';
import { classifyStoredVideos } from './classify.ts';
import { creatorsFromSeeds, DEFAULT_SEEDS_DIR, loadSeedsDetailed, SEED_FILES, YOUTUBE_CHANNEL_ID_RE } from './seeds.ts';
import { openStore, type Store } from './store.ts';
import { runCollection, type RunCollectionResult } from './pipeline.ts';
import { buildDatasetDetailed, DEFAULT_BUDGET_BYTES, writeExport, writeFileAtomic } from './export.ts';

export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const DATA_DIR = join(REPO_ROOT, 'data');
/** Defaults, relative to the repository root (or CliDeps.root). */
export const DEFAULT_DB_PATH = 'data/store.sqlite';
export const DEFAULT_EXPORT_DIR = 'data/export';

/* ------------------------------------------------------------------------------------------
 * Argument parsing
 * ---------------------------------------------------------------------------------------- */

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

export type CommandName = 'collect' | 'export' | 'run' | 'stats' | 'add-youtube-channel' | 'help';

interface CommandSpec {
  values: string[];
  booleans: string[];
  positionals: number;
}

const GLOBAL_VALUES = ['log-file'];
const GLOBAL_BOOLEANS = ['help', 'no-log-file'];

const COMMANDS: Record<CommandName, CommandSpec> = {
  collect: { values: ['sources', 'max-requests', 'db', 'seeds'], booleans: ['no-classify'], positionals: 0 },
  export: { values: ['out', 'db', 'budget-mb', 'tz', 'seeds'], booleans: ['copy-to-web'], positionals: 0 },
  run: { values: ['sources', 'max-requests', 'db', 'seeds', 'out', 'budget-mb', 'tz'], booleans: ['no-copy-to-web', 'no-classify'], positionals: 0 },
  stats: { values: ['db'], booleans: ['json'], positionals: 0 },
  'add-youtube-channel': { values: ['category', 'country', 'language', 'name', 'creator', 'seeds'], booleans: ['force'], positionals: 1 },
  help: { values: [], booleans: [], positionals: 0 },
};

export interface ParsedArgs {
  command: CommandName;
  positionals: string[];
  values: Record<string, string>;
  flags: Set<string>;
}

/** Tokenize argv for a command: `--name value`, `--name=value`, boolean `--flag`, positionals. Throws CliUsageError. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const args = [...argv];
  const first = args[0];
  if (first === undefined || first === '--help' || first === '-h' || first === 'help') {
    return { command: 'help', positionals: [], values: {}, flags: new Set(['help']) };
  }
  if (!(first in COMMANDS)) throw new CliUsageError(`unknown command "${first}" (commands: ${Object.keys(COMMANDS).filter((c) => c !== 'help').join(', ')})`);
  const command = first as CommandName;
  const spec = COMMANDS[command];
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  const positionals: string[] = [];
  const valueNames = new Set([...spec.values, ...GLOBAL_VALUES]);
  const boolNames = new Set([...spec.booleans, ...GLOBAL_BOOLEANS]);

  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '-h') {
      flags.add('help');
      continue;
    }
    if (a === '--') {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq >= 0 ? a.slice(2, eq) : a.slice(2);
      if (valueNames.has(name)) {
        let v: string | undefined;
        if (eq >= 0) v = a.slice(eq + 1);
        else {
          v = args[i + 1];
          if (v === undefined || (v.startsWith('--') && v.length > 2)) throw new CliUsageError(`--${name} needs a value`);
          i++;
        }
        if (v === '') throw new CliUsageError(`--${name} needs a value`);
        values[name] = v;
      } else if (boolNames.has(name)) {
        if (eq >= 0) {
          const v = a.slice(eq + 1).toLowerCase();
          if (v === 'true' || v === '1' || v === 'yes') flags.add(name);
          else if (!(v === 'false' || v === '0' || v === 'no')) throw new CliUsageError(`--${name} is a flag (true/false)`);
        } else flags.add(name);
      } else {
        throw new CliUsageError(`unknown option --${name} for "${command}"`);
      }
      continue;
    }
    positionals.push(a);
  }
  if (!flags.has('help') && positionals.length > spec.positionals) {
    throw new CliUsageError(`unexpected argument "${positionals[spec.positionals]}" for "${command}"`);
  }
  if (!flags.has('help') && positionals.length < spec.positionals) {
    throw new CliUsageError(`"${command}" needs ${spec.positionals} argument(s)`);
  }
  return { command, positionals, values, flags };
}

export function resolvePath(p: string, root: string = REPO_ROOT): string {
  return isAbsolute(p) ? p : resolve(root, p);
}

function intValue(values: Record<string, string>, name: string, min: number): number | undefined {
  const v = values[name];
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v) || Number(v) < min) throw new CliUsageError(`--${name} must be an integer >= ${min}`);
  return Number(v);
}

function numberValue(values: Record<string, string>, name: string): number | undefined {
  const v = values[name];
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new CliUsageError(`--${name} must be a positive number`);
  return n;
}

export interface CollectOptions {
  db: string;
  sources: string[] | undefined;
  maxRequests: number | undefined;
  seedsDir: string;
  classify: boolean;
}

export interface ExportOptions {
  db: string;
  out: string;
  copyToWeb: boolean;
  budgetBytes: number;
  tz: string;
  seedsDir: string;
}

export function collectOptionsFrom(p: ParsedArgs, root: string = REPO_ROOT): CollectOptions {
  let sources: string[] | undefined;
  if (p.values.sources !== undefined) {
    sources = [...new Set(p.values.sources.split(',').map((s) => s.trim()).filter(Boolean))];
    if (!sources.length) throw new CliUsageError('--sources needs at least one source id');
    const unknown = sources.filter((s) => !ADAPTERS.some((a) => a.id === s));
    if (unknown.length) throw new CliUsageError(`unknown source(s): ${unknown.join(', ')} (known: ${ADAPTERS.map((a) => a.id).join(', ')})`);
  }
  return {
    db: resolvePath(p.values.db ?? DEFAULT_DB_PATH, root),
    sources,
    maxRequests: intValue(p.values, 'max-requests', 0),
    seedsDir: p.values.seeds ? resolvePath(p.values.seeds, root) : DEFAULT_SEEDS_DIR,
    classify: !p.flags.has('no-classify'),
  };
}

export function exportOptionsFrom(p: ParsedArgs, root: string = REPO_ROOT): ExportOptions {
  const mb = numberValue(p.values, 'budget-mb');
  const tz = p.values.tz ?? 'Asia/Seoul';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new CliUsageError(`--tz: unknown time zone "${tz}"`);
  }
  return {
    db: resolvePath(p.values.db ?? DEFAULT_DB_PATH, root),
    out: resolvePath(p.values.out ?? DEFAULT_EXPORT_DIR, root),
    copyToWeb: p.command === 'run' ? !p.flags.has('no-copy-to-web') : p.flags.has('copy-to-web'),
    budgetBytes: mb !== undefined ? Math.round(mb * 1_000_000) : DEFAULT_BUDGET_BYTES,
    tz,
    seedsDir: p.values.seeds ? resolvePath(p.values.seeds, root) : DEFAULT_SEEDS_DIR,
  };
}

/* ------------------------------------------------------------------------------------------
 * .env
 * ---------------------------------------------------------------------------------------- */

/** Minimal .env parser: KEY=VALUE, `export KEY=VALUE`, '#' comments, single/double quotes (\n, \t, \" escapes in double quotes). */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    let value = m[2];
    if (value.startsWith('"')) {
      // Double quotes may span lines; backslash escapes \n \r \t \" \\ are decoded.
      const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' };
      let body = value.slice(1);
      let out = '';
      let closed = false;
      for (;;) {
        for (let k = 0; k < body.length; k++) {
          const ch = body[k];
          if (ch === '\\' && k + 1 < body.length) {
            const next = body[++k];
            out += escapes[next] ?? `\\${next}`;
          } else if (ch === '"') {
            closed = true;
            break;
          } else out += ch;
        }
        if (closed || i + 1 >= lines.length) break;
        out += '\n';
        body = lines[++i];
      }
      value = out;
    } else if (value.startsWith("'")) {
      const end = value.indexOf("'", 1);
      value = end >= 0 ? value.slice(1, end) : value.slice(1);
    } else {
      const hash = value.search(/\s#/);
      if (hash >= 0) value = value.slice(0, hash);
      value = value.trim();
    }
    out[key] = value;
  }
  return out;
}

/** Load `.env` into `env` without overriding existing values. Returns the keys that were set. */
export function loadDotEnv(path: string = join(REPO_ROOT, '.env'), env: Record<string, string | undefined> = process.env): string[] {
  if (!existsSync(path)) return [];
  const parsed = parseDotEnv(readFileSync(path, 'utf8'));
  const set: string[] = [];
  for (const [k, v] of Object.entries(parsed)) {
    if (env[k] === undefined) {
      env[k] = v;
      set.push(k);
    }
  }
  return set;
}

/* ------------------------------------------------------------------------------------------
 * add-youtube-channel
 * ---------------------------------------------------------------------------------------- */

export interface AddYoutubeChannelInput {
  ref: string;
  category: string;
  country?: string | null;
  language?: string | null;
  name?: string | null;
  creatorId?: string | null;
  force?: boolean;
}

export interface AddYoutubeChannelResult {
  seed: YoutubeChannelSeed;
  file: string;
  entries: number;
  newestUploadAgeDays: number | null;
}

/** Parse a channel reference: `UC…` id, `@handle`, bare handle, or a youtube.com /channel/ or /@ URL. */
export function parseChannelRef(ref: string): { channelId: string | null; handle: string | null } {
  const r = ref.trim();
  if (YOUTUBE_CHANNEL_ID_RE.test(r)) return { channelId: r, handle: null };
  let path = r;
  if (/^https?:\/\//i.test(r)) {
    let u: URL;
    try {
      u = new URL(r);
    } catch {
      throw new CliUsageError(`invalid channel URL: ${r}`);
    }
    if (!/(^|\.)youtube\.com$/i.test(u.hostname)) throw new CliUsageError(`not a youtube.com URL: ${r}`);
    path = decodeURIComponent(u.pathname).replace(/^\/+/, '').split('/').slice(0, 2).join('/');
    const ch = /^channel\/(UC[A-Za-z0-9_-]{22})$/.exec(path);
    if (ch) return { channelId: ch[1], handle: null };
    path = path.split('/')[0];
  }
  const handle = path.replace(/^@/, '').trim();
  if (!handle || /[\s/?#]/.test(handle)) throw new CliUsageError(`cannot parse channel reference "${ref}" (use a UC… id or @handle)`);
  return { channelId: null, handle: `@${handle}` };
}

/** Channel id from a channel page: canonical link, then og:url / identifier meta, then externalId in page data. */
export function extractChannelId(html: string): string | null {
  const patterns = [
    /<link[^>]+rel=["']canonical["'][^>]+href=["']https?:\/\/(?:www\.|m\.)?youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})["']/i,
    /<link[^>]+href=["']https?:\/\/(?:www\.|m\.)?youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})["'][^>]+rel=["']canonical["']/i,
    /<meta[^>]+property=["']og:url["'][^>]+content=["']https?:\/\/(?:www\.)?youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})["']/i,
    /<meta[^>]+itemprop=["'](?:identifier|channelId)["'][^>]+content=["'](UC[A-Za-z0-9_-]{22})["']/i,
    /"externalId"\s*:\s*"(UC[A-Za-z0-9_-]{22})"/,
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (m) return m[1];
  }
  return null;
}

function readSeedArray(file: string): Record<string, unknown>[] {
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`${file} is not a JSON array`);
  return parsed as Record<string, unknown>[];
}

export async function addYoutubeChannel(
  input: AddYoutubeChannelInput,
  deps: { http: HttpClient; seedsDir?: string; now?: number; log?: Pick<Logger, 'info' | 'warn'> },
): Promise<AddYoutubeChannelResult> {
  const now = deps.now ?? Date.now();
  const category = input.category?.trim();
  if (!category) throw new CliUsageError('--category is required (a taxonomy id such as beauty or music/kpop)');
  if (!taxonomyById().has(category)) throw new CliUsageError(`--category "${category}" is not a taxonomy id (see packages/core/src/taxonomy.ts)`);
  const country = input.country?.trim() ? input.country.trim().toUpperCase() : null;
  if (country !== null && !/^[A-Z]{2}$/.test(country)) throw new CliUsageError('--country must be an ISO 3166 alpha-2 code, e.g. KR');
  const language = input.language?.trim() ? input.language.trim().toLowerCase() : null;
  if (language !== null && !/^[a-z]{2}$/.test(language)) throw new CliUsageError('--language must be an ISO 639-1 code, e.g. ko');

  const file = join(deps.seedsDir ?? DEFAULT_SEEDS_DIR, SEED_FILES.youtubeChannels);
  const existing = readSeedArray(file);
  let { channelId, handle } = parseChannelRef(input.ref);

  const dupHandle = (h: string | null) => !!h && existing.some((e) => typeof e.handle === 'string' && e.handle.toLowerCase() === h.toLowerCase());
  if (handle && dupHandle(handle)) throw new Error(`${handle} is already in ${SEED_FILES.youtubeChannels}`);

  if (!channelId && handle) {
    const url = `https://www.youtube.com/${encodeURIComponent(handle).replace(/^%40/, '@')}`;
    let html: string;
    try {
      html = await deps.http.getText(url, { headers: { 'Accept-Language': 'en-US,en;q=0.8' } });
    } catch (err) {
      throw new Error(`cannot open ${url}: ${err instanceof Error ? err.message : String(err)}. Pass the UC… channel id instead.`);
    }
    channelId = extractChannelId(html);
    if (!channelId) throw new Error(`no canonical /channel/UC… link found on ${url} (consent or error page?). Pass the UC… channel id instead.`);
    deps.log?.info(`${handle} -> ${channelId}`);
  }
  if (!channelId) throw new CliUsageError('could not determine the channel id');
  if (existing.some((e) => e.channelId === channelId)) throw new Error(`${channelId} is already in ${SEED_FILES.youtubeChannels}`);

  const feedUrl = youtubeFeedUrl(channelId);
  let xml: string;
  try {
    xml = await deps.http.getText(feedUrl);
  } catch (err) {
    throw new Error(`RSS feed check failed for ${channelId}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const feed = parseYoutubeFeed(xml);
  if (!feed) throw new Error(`RSS feed for ${channelId} is not an Atom feed`);
  const published = feed.entries.map((e) => (e.published ? Date.parse(e.published) : NaN)).filter((t) => Number.isFinite(t));
  const newest = published.length ? Math.max(...published) : null;
  const ageDays = newest === null ? null : (now - newest) / 86_400_000;
  if (!input.force) {
    if (newest === null) throw new Error(`RSS feed for ${channelId} has no uploads; use --force to add it anyway`);
    if (ageDays !== null && ageDays > 90) throw new Error(`latest upload is ${Math.round(ageDays)} days old (inactive channel); use --force to add it anyway`);
  }

  const name = input.name?.trim() || feed.authorName || feed.channelTitle || handle || channelId;
  const seed: YoutubeChannelSeed = { channelId, handle, name, category, country, language };
  if (input.creatorId?.trim()) seed.creatorId = input.creatorId.trim();
  const next = [...existing, seed as unknown as Record<string, unknown>];
  writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
  return { seed, file, entries: feed.entries.length, newestUploadAgeDays: ageDays === null ? null : Math.round(ageDays * 10) / 10 };
}

/* ------------------------------------------------------------------------------------------
 * Commands
 * ---------------------------------------------------------------------------------------- */

export const USAGE = `Video Trend Intel collector

Usage:
  collect [--sources a,b] [--max-requests N] [--db data/store.sqlite] [--seeds dir] [--no-classify]
  export  [--out data/export] [--copy-to-web] [--db data/store.sqlite] [--budget-mb 40] [--tz Asia/Seoul]
  run     [collect options] [--out data/export] [--no-copy-to-web]
  stats   [--db data/store.sqlite] [--json]
  add-youtube-channel <UC-id|@handle|URL> --category <id> [--country KR] [--language ko] [--name "..."] [--creator id] [--force]

Global options: --log-file <path>, --no-log-file, --help
Sources: ${ADAPTERS.map((a) => a.id).join(', ')}
Relative paths are resolved against the repository root.`;

export interface CliDeps {
  env?: Record<string, string | undefined>;
  stdout?: { write(s: string): unknown };
  stderr?: { write(s: string): unknown };
  now?: () => number;
  /** HTTP client for add-youtube-channel (tests inject a fake). */
  http?: HttpClient;
  /** Repository root for relative paths (default REPO_ROOT). */
  root?: string;
  /** Load `<root>/.env` (default true). */
  loadEnv?: boolean;
}

function formatSummary(res: RunCollectionResult): string {
  const rows = res.summaries.map((s) => {
    const cols = [
      s.source.padEnd(18),
      s.status.padEnd(8),
      `videos ${String(s.videosSeen).padStart(6)} (new ${s.videosNew})`,
      `obs ${s.observations}`,
      `gone ${s.gone}`,
      `req ${s.requests}`,
      `refresh ${s.refresh.requested}/${s.refresh.due}`,
      `errors ${s.errors.length}`,
    ];
    const first = s.errors[0] ? `\n    ! ${s.errors[0].slice(0, 300)}` : '';
    return cols.join('  ') + first;
  });
  const cls = res.classification ? `\nclassified ${res.classification.classified} video(s)` : '';
  return `${rows.join('\n')}${cls}\n${res.succeeded}/${res.attempted} enabled source(s) succeeded in ${Math.round((res.finishedAt - res.startedAt) / 1000)}s\n`;
}

async function doCollect(p: ParsedArgs, deps: Required<Pick<CliDeps, 'env' | 'now'>> & CliDeps, log: Logger, out: (s: string) => void): Promise<{ code: number; store?: Store }> {
  const o = collectOptionsFrom(p, deps.root);
  const store = openStore(o.db);
  try {
    log.info(`collect: db ${o.db}${o.sources ? `, sources ${o.sources.join(',')}` : ''}${o.maxRequests !== undefined ? `, max-requests ${o.maxRequests}` : ''}`);
    const res = await runCollection({
      db: store,
      sources: o.sources,
      env: deps.env,
      now: deps.now,
      maxRequestsPerSource: o.maxRequests,
      log,
      seedsDir: o.seedsDir,
      classify: o.classify,
      httpOptions: { log },
    });
    out(formatSummary(res));
    if (res.totalFailure) log.error(res.attempted === 0 ? 'collect: no enabled source ran' : 'collect: every enabled source failed');
    return { code: res.totalFailure ? 1 : 0 };
  } finally {
    store.close();
  }
}

function doExport(p: ParsedArgs, deps: Required<Pick<CliDeps, 'env' | 'now'>> & CliDeps, log: Logger, out: (s: string) => void): number {
  const o = exportOptionsFrom(p, deps.root);
  const store = openStore(o.db);
  try {
    const now = deps.now();
    const seeds = loadSeedsDetailed(o.seedsDir, { log });
    const creatorsOk = !seeds.missing.includes(SEED_FILES.creators) && !seeds.warnings.some((w) => w.startsWith(`seeds/${SEED_FILES.creators}:`));
    if (creatorsOk) store.upsertCreators(creatorsFromSeeds(seeds.seeds), now, { replace: true, linkStatus: 'verified' });
    classifyStoredVideos(store, { now, log });
    const { dataset, stats } = buildDatasetDetailed(store, { now, tz: o.tz, budgetBytes: o.budgetBytes, env: deps.env, log });
    let copyTo: string | null = null;
    if (o.copyToWeb) {
      if (dataset.videos.length === 0) log.warn(`export: dataset has no videos; not copying to the web app (the web app keeps its current data / sample)`);
      else copyTo = resolvePath('apps/web/public/data/dataset.json', deps.root);
    }
    const res = writeExport(dataset, o.out, { copyTo });
    out(
      `exported ${res.meta.counts.videos} video(s), ${res.meta.counts.accounts} account(s), ${res.meta.counts.creators} creator(s), ` +
        `${res.meta.counts.observations} observation(s) (raw ${stats.rawObservations}) -> ${res.datasetPath} (${(res.bytes / 1_000_000).toFixed(2)} MB)` +
        `${stats.prunedVideos ? `; pruned ${stats.prunedVideos} video(s) for the size budget` : ''}${res.copiedTo ? `\ncopied to ${res.copiedTo}` : ''}\n`,
    );
    return 0;
  } finally {
    store.close();
  }
}

function doStats(p: ParsedArgs, deps: CliDeps, out: (s: string) => void): number {
  const db = resolvePath(p.values.db ?? DEFAULT_DB_PATH, deps.root);
  if (!existsSync(db)) {
    out(`no store at ${db}\n`);
    return 1;
  }
  const store = openStore(db);
  try {
    const counts = store.counts();
    const states = store.listSourceStates();
    const runs = store.listRuns(10);
    if (p.flags.has('json')) {
      out(`${JSON.stringify({ db, schemaVersion: store.schemaVersion, counts, sources: states, recentRuns: runs }, null, 2)}\n`);
      return 0;
    }
    const iso = (t: number | null) => (t === null ? '-' : new Date(t).toISOString().replace('.000Z', 'Z'));
    const lines = [
      `store ${db} (schema v${store.schemaVersion})`,
      `videos ${counts.videos}  accounts ${counts.accounts}  observations ${counts.observations}  source windows ${counts.sourceWindows}  follower obs ${counts.followerObs}`,
      `classified ${counts.classified}  creators ${counts.creators}  runs ${counts.runs}`,
      `videos by platform: ${Object.entries(counts.videosByPlatform).map(([k, v]) => `${k} ${v}`).join(', ') || '-'}`,
      `videos by status: ${Object.entries(counts.videosByStatus).map(([k, v]) => `${k} ${v}`).join(', ') || '-'}`,
      '',
      'sources:',
      ...states.map((s) => `  ${s.source.padEnd(18)} ${s.lastStatus.padEnd(8)} last run ${iso(s.lastRunAt)}  last success ${iso(s.lastSuccessAt)}  videos ${counts.videosBySource[s.source] ?? 0}${s.lastError ? `\n    ! ${s.lastError.slice(0, 200)}` : ''}`),
      '',
      'recent runs:',
      ...runs.map((r) => `  ${iso(r.startedAt)} ${r.source.padEnd(18)} ${r.status.padEnd(8)} videos ${r.videosSeen} (new ${r.videosNew}) obs ${r.observations} req ${r.requests} errors ${r.errors.length}`),
    ];
    out(`${lines.join('\n')}\n`);
    return 0;
  } finally {
    store.close();
  }
}

/** Run the CLI; resolves to the process exit code. */
export async function main(argv: readonly string[], deps: CliDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const out = (s: string) => stdout.write(s);
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n\n${USAGE}\n`);
    return 2;
  }
  if (parsed.command === 'help' || parsed.flags.has('help')) {
    out(`${USAGE}\n`);
    return 0;
  }

  const root = deps.root ?? REPO_ROOT;
  const env = deps.env ?? (process.env as Record<string, string | undefined>);
  if (deps.loadEnv ?? true) loadDotEnv(join(root, '.env'), env);
  const now = deps.now ?? Date.now;
  const logFile = parsed.flags.has('no-log-file') ? null : parsed.values['log-file'] ? resolvePath(parsed.values['log-file'], root) : defaultLogFile(join(root, 'data'), now());
  const log = createLogger({ file: logFile, stdout, stderr, clock: now });
  const full = { ...deps, env, now, root };

  try {
    switch (parsed.command) {
      case 'collect':
        return (await doCollect(parsed, full, log, out)).code;
      case 'export':
        return doExport(parsed, full, log, out);
      case 'run': {
        const c = await doCollect(parsed, full, log, out);
        let e = 1;
        try {
          e = doExport(parsed, full, log, out);
        } catch (err) {
          log.error(`export failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        return c.code !== 0 || e !== 0 ? 1 : 0;
      }
      case 'stats':
        return doStats(parsed, full, out);
      case 'add-youtube-channel': {
        const http = deps.http ?? createHttpClient({ log });
        const res = await addYoutubeChannel(
          {
            ref: parsed.positionals[0],
            category: parsed.values.category ?? '',
            country: parsed.values.country ?? null,
            language: parsed.values.language ?? null,
            name: parsed.values.name ?? null,
            creatorId: parsed.values.creator ?? null,
            force: parsed.flags.has('force'),
          },
          { http, seedsDir: parsed.values.seeds ? resolvePath(parsed.values.seeds, root) : DEFAULT_SEEDS_DIR, now: now(), log },
        );
        out(
          `added ${res.seed.channelId} ${res.seed.handle ?? ''} "${res.seed.name}" (${res.seed.category}) to ${res.file}` +
            ` — feed has ${res.entries} entries, newest upload ${res.newestUploadAgeDays ?? '?'} day(s) ago\n`,
        );
        return 0;
      }
      default:
        out(`${USAGE}\n`);
        return 2;
    }
  } catch (err) {
    if (err instanceof CliUsageError) {
      stderr.write(`error: ${err.message}\n`);
      return 2;
    }
    log.error(`${parsed.command} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    return 1;
  }
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
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
      // Let stdout flush; do not hang on keep-alive sockets.
      setTimeout(() => process.exit(code), 500).unref();
    },
    (err) => {
      process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      process.exit(1);
    },
  );
}
