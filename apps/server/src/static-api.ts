/**
 * Static JSON API for hosting without a server (GitHub Pages). OWNER: server.
 *
 *   npx tsx apps/server/src/static-api.ts [--dataset <path>] [--out apps/web/dist/api/v1] [--tz Asia/Seoul] [--limit 100]
 *
 * Writes precomputed responses of the most common API calls next to the web build:
 *   index.json                                   list of every file (path, description, bytes)
 *   meta.json · coverage.json · taxonomy.json   same payloads as /api/v1/meta, /coverage, /taxonomy
 *   openapi.json                                 the live server's API description
 *   videos/<activity|upload>/top-<preset>-<platform|all>.json
 *                                                top videos (compact rows) for presets last7d, last30d,
 *                                                rolling7d, rolling30d; activity sorts by views_period,
 *                                                upload by views_total
 *   trending/<kind>-<preset>.json                kind = topic|category|creator|account, preset = last7d|rolling7d
 *   creators/top-<preset>.json                   preset = last30d|rolling30d
 * Output is deterministic: a pure function of the dataset (now = generatedAt) and the options; no wall-clock
 * times, stable key order, files listed in sorted order. Files listed in a previous index.json that are no
 * longer produced are removed (nothing else in the output dir is touched).
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_TZ, PLATFORMS, buildIndex, decodeDataset, presetRange, presetRollingHours, queryVideos } from '@vti/core';
import type { CompactDataset, DatasetIndex, DateMode, Platform, RangePreset, SortKey } from '@vti/core';
import { API_VERSION, compactRowJson, isoOf, platformLabel, windowJson } from './routes/common.ts';
import { buildMeta } from './routes/meta.ts';
import { buildCoverage } from './routes/coverage.ts';
import { buildTaxonomy } from './routes/taxonomy.ts';
import { trendingPayload } from './routes/trending.ts';
import { creatorsPayload } from './routes/creators.ts';
import { buildOpenApi } from './openapi.ts';
import { TREND_KINDS, isValidTimeZone, rangeEcho, type ResolvedRangeParam } from './params.ts';

export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

export const STATIC_VIDEO_PRESETS: RangePreset[] = ['last7d', 'last30d', 'rolling7d', 'rolling30d'];
export const STATIC_TREND_PRESETS: RangePreset[] = ['last7d', 'rolling7d'];
export const STATIC_CREATOR_PRESETS: RangePreset[] = ['last30d', 'rolling30d'];
const MODES: { mode: DateMode; sort: SortKey; label: string }[] = [
  { mode: 'activity', sort: 'views_period', label: '조회 발생 기간 기준(기간 내 조회 증가량)' },
  { mode: 'upload', sort: 'views_total', label: '업로드 기간 기준(기간 내 게시, 누적 조회수)' },
];

export interface StaticApiOptions {
  tz?: string;
  /** Rows per top-videos file (default 100). */
  limit?: number;
}

export interface StaticFile {
  path: string;
  description: string;
  data: unknown;
}

/** A static file whose content is computed on demand (the server serves these live; the CLI writes them). */
export interface StaticEntry {
  path: string;
  description: string;
  build: () => unknown;
}

function presetParam(preset: RangePreset, tz: string, now: number): ResolvedRangeParam {
  return { spec: preset, preset, range: presetRange(preset, tz, now), rollingHours: presetRollingHours(preset), explicit: true };
}

/** Every static file (sorted by path) with a lazy builder. Pure: builders depend only on (index, opts). */
export function staticApiEntries(index: DatasetIndex, opts: StaticApiOptions = {}): StaticEntry[] {
  const tz = opts.tz ?? DEFAULT_TZ;
  const limit = opts.limit ?? 100;
  const now = index.dataset.generatedAt;
  const entries: StaticEntry[] = [];
  const header = { apiVersion: API_VERSION, generatedAt: now, generatedAtIso: isoOf(now), tz };

  entries.push({ path: 'meta.json', description: '데이터셋 버전·개수·수집 범위 요약 (/api/v1/meta)', build: () => buildMeta(index) });
  entries.push({ path: 'coverage.json', description: '데이터 범위·수집 원천·실행 기록·정확도 분포 (/api/v1/coverage)', build: () => buildCoverage(index, tz) });
  entries.push({ path: 'taxonomy.json', description: '분류 체계 트리와 영상 수 (/api/v1/taxonomy)', build: () => buildTaxonomy(index) });
  entries.push({ path: 'openapi.json', description: '서버 REST API 설명 (OpenAPI 3.1; 정적 사이트에서는 아래 파일만 제공)', build: () => buildOpenApi() });

  const present = new Set(index.dataset.videos.map((v) => v.platform));
  const platforms: (Platform | 'all')[] = ['all', ...PLATFORMS.filter((p) => present.has(p))];
  for (const { mode, sort, label } of MODES) {
    for (const preset of STATIC_VIDEO_PRESETS) {
      for (const platform of platforms) {
        entries.push({
          path: `videos/${mode}/top-${preset}-${platform}.json`,
          description: `상위 영상 ${limit}개 — ${label}, ${preset}, ${platform === 'all' ? '전체 플랫폼' : platformLabel(platform)}`,
          build: () => {
            const range = presetParam(preset, tz, now);
            const res = queryVideos(index, {
              dateMode: mode,
              range: range.range,
              ...(range.rollingHours ? { rollingHours: range.rollingHours } : {}),
              tz,
              now,
              sort,
              sortDir: 'desc',
              limit,
              ...(platform !== 'all' ? { platforms: [platform] } : {}),
            });
            return {
              ...header,
              query: { mode, range: rangeEcho(range), tz, platform, sort, dir: 'desc', limit },
              window: windowJson(res.window, range.rollingHours),
              total: res.total,
              notes: res.notes,
              rows: res.rows.map((r, i) => compactRowJson(r, i + 1)),
            };
          },
        });
      }
    }
  }

  for (const kind of TREND_KINDS) {
    for (const preset of STATIC_TREND_PRESETS) {
      entries.push({
        path: `trending/${kind}-${preset}.json`,
        description: `트렌드(${kind}) — ${preset}, 직전 같은 길이 기간 대비`,
        build: () => ({
          ...header,
          ...trendingPayload(index, { kind, tz, now, range: presetParam(preset, tz, now), platforms: [], categories: [], languages: [], minVideos: null, minCurrent: null, limit: 20 }),
        }),
      });
    }
  }

  for (const preset of STATIC_CREATOR_PRESETS) {
    entries.push({
      path: `creators/top-${preset}.json`,
      description: `크리에이터·계정 상위 ${limit}개 — ${preset} 기간 조회 증가량 순`,
      build: () => ({
        ...header,
        ...creatorsPayload(index, { tz, now, range: presetParam(preset, tz, now), platforms: [], categories: [], q: undefined, sort: 'views_period', limit, offset: 0 }),
      }),
    });
  }

  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return entries;
}

/** Every static file (in sorted path order) for `index`, built. Pure. */
export function generateStaticApi(index: DatasetIndex, opts: StaticApiOptions = {}): StaticFile[] {
  return staticApiEntries(index, opts).map((e) => ({ path: e.path, description: e.description, data: e.build() }));
}

/** Serialize (compact JSON + trailing newline). */
export function serializeStatic(data: unknown): string {
  return `${JSON.stringify(data)}\n`;
}

/** index.json content: every file with its description and serialized size in bytes. */
export function staticIndex(index: DatasetIndex, files: { path: string; description: string; bytes: number }[], tz: string) {
  return {
    apiVersion: API_VERSION,
    generatedAt: index.dataset.generatedAt,
    generatedAtIso: isoOf(index.dataset.generatedAt),
    tz,
    description:
      '정적 API: 데이터셋 기준 시각(generatedAt)으로 미리 계산한 응답입니다. 필터·정렬을 바꾸려면 서버 API(/api/v1, openapi.json 참고) 또는 웹 앱을 사용하세요. 모든 지표는 value·status·asOf를 함께 제공합니다. 같은 경로를 서버(/api/v1/<path>)에서도 받을 수 있습니다.',
    files: files.map((f) => ({ path: f.path, description: f.description, bytes: f.bytes })),
  };
}

function insideDir(root: string, rel: string): string | null {
  if (rel.includes('\0') || rel.includes('\\') || rel.split('/').some((s) => s === '..' || s === '' || s === '.')) return null;
  const base = resolve(root);
  const full = resolve(base, ...rel.split('/'));
  return full.startsWith(base + sep) ? full : null;
}

export interface WriteStaticResult {
  outDir: string;
  written: string[];
  removed: string[];
  bytes: number;
}

/** Write the files + index.json into outDir, removing files of a previous run that are no longer produced. */
export function writeStaticApi(index: DatasetIndex, outDir: string, opts: StaticApiOptions = {}): WriteStaticResult {
  const tz = opts.tz ?? DEFAULT_TZ;
  const files = generateStaticApi(index, opts).map((f) => {
    const text = serializeStatic(f.data);
    return { path: f.path, description: f.description, text, bytes: Buffer.byteLength(text, 'utf8') };
  });
  const indexText = serializeStatic(staticIndex(index, files, tz));
  const wanted = new Set(['index.json', ...files.map((f) => f.path)]);
  const removed: string[] = [];
  const prevIndexPath = join(outDir, 'index.json');
  if (existsSync(prevIndexPath)) {
    try {
      const prev = JSON.parse(readFileSync(prevIndexPath, 'utf8')) as { files?: { path?: unknown }[] };
      for (const f of prev.files ?? []) {
        if (typeof f.path !== 'string' || wanted.has(f.path)) continue;
        const full = insideDir(outDir, f.path);
        if (full && existsSync(full)) {
          rmSync(full, { force: true });
          removed.push(f.path);
        }
      }
    } catch {
      // unreadable previous index: leave old files alone
    }
  }
  let bytes = 0;
  const written: string[] = [];
  for (const f of [...files, { path: 'index.json', text: indexText }]) {
    const full = insideDir(outDir, f.path);
    if (!full) throw new Error(`static-api: unsafe path ${f.path}`);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, f.text, 'utf8');
    bytes += Buffer.byteLength(f.text, 'utf8');
    written.push(f.path);
  }
  return { outDir, written, removed, bytes };
}

/* ------------------------------------------------------------------------------------------
 * CLI
 * ---------------------------------------------------------------------------------------- */

const USAGE = `usage: npx tsx apps/server/src/static-api.ts [--dataset <dataset.json>] [--out <dir>] [--tz <IANA zone>] [--limit <n>]
  --dataset   compact dataset (default: data/export/dataset.json, else apps/web/public/data/dataset.json)
  --out       output dir (default: apps/web/dist/api/v1)
  --tz        time zone for local dates (default: ${DEFAULT_TZ})
  --limit     rows per top-videos / creators file (default: 100)`;

export function parseCliArgs(argv: readonly string[], cwd: string = process.cwd()): { dataset: string; out: string; tz: string; limit: number } | { help: true } {
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { help: true };
    const m = /^--(dataset|out|tz|limit)(?:=(.*))?$/.exec(a);
    if (!m) throw new Error(`unknown argument: ${a}`);
    const v = m[2] ?? argv[++i];
    if (v === undefined || v === '') throw new Error(`--${m[1]} needs a value`);
    values[m[1]] = v;
  }
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(cwd, p));
  const defaultDataset = [join(REPO_ROOT, 'data', 'export', 'dataset.json'), join(REPO_ROOT, 'apps', 'web', 'public', 'data', 'dataset.json')].find((p) => existsSync(p));
  const dataset = values.dataset ? abs(values.dataset) : defaultDataset;
  if (!dataset) throw new Error('no dataset found; pass --dataset <path>');
  const tz = values.tz ?? DEFAULT_TZ;
  if (!isValidTimeZone(tz)) throw new Error(`unknown time zone: ${tz}`);
  const limit = values.limit !== undefined ? Number(values.limit) : 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('--limit must be an integer between 1 and 1000');
  return { dataset, out: values.out ? abs(values.out) : join(REPO_ROOT, 'apps', 'web', 'dist', 'api', 'v1'), tz, limit };
}

export function loadIndexFromFile(path: string): DatasetIndex {
  const compact = JSON.parse(readFileSync(path, 'utf8')) as CompactDataset;
  return buildIndex(decodeDataset(compact));
}

export function cliMain(argv: readonly string[]): number {
  let args;
  try {
    args = parseCliArgs(argv);
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n\n${USAGE}\n`);
    return 2;
  }
  if ('help' in args) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const t0 = Date.now();
  const index = loadIndexFromFile(args.dataset);
  const res = writeStaticApi(index, args.out, { tz: args.tz, limit: args.limit });
  process.stdout.write(
    `static API: ${res.written.length} file(s), ${(res.bytes / 1_000_000).toFixed(2)} MB -> ${res.outDir}` +
      (res.removed.length ? ` (removed ${res.removed.length} stale file(s))` : '') +
      ` in ${Date.now() - t0} ms\n`,
  );
  return 0;
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
  try {
    process.exitCode = cliMain(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`static-api failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exitCode = 1;
  }
}
