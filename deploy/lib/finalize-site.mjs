#!/usr/bin/env node
/**
 * Finish the static site in apps/web/dist for GitHub Pages. OWNER: deploy.
 *
 *   node deploy/lib/finalize-site.mjs [--dist apps/web/dist] [--export data/export] [--require-dataset]
 *
 * - writes `.nojekyll` (the artifact is served as-is; harmless for Actions deployments, required for branch ones)
 * - copies `data/export/meta.json` next to the dataset (`data/meta.json`, same file the server serves)
 * - reports what will be published: dataset (real or sample fallback), static API files, total size
 * - appends the report to $GITHUB_STEP_SUMMARY when running in GitHub Actions
 * --require-dataset exits 1 when `data/dataset.json` is missing (the site would fall back to sample data).
 */
import { appendFileSync, copyFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

function args(argv) {
  const o = { dist: 'apps/web/dist', exportDir: 'data/export', requireDataset: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dist') o.dist = argv[++i];
    else if (a === '--export') o.exportDir = argv[++i];
    else if (a === '--require-dataset') o.requireDataset = true;
    else throw new Error(`unknown argument ${a}`);
    if (o.dist === undefined || o.exportDir === undefined) throw new Error(`${a} needs a value`);
  }
  return { dist: resolve(ROOT, o.dist), exportDir: resolve(ROOT, o.exportDir), requireDataset: o.requireDataset };
}

function walk(dir) {
  let files = 0;
  let bytes = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      const r = walk(p);
      files += r.files;
      bytes += r.bytes;
    } else if (e.isFile()) {
      files++;
      bytes += statSync(p).size;
    }
  }
  return { files, bytes };
}

const mb = (n) => `${(n / 1_000_000).toFixed(2)} MB`;

let opts;
try {
  opts = args(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`error: ${err.message}\nusage: node deploy/lib/finalize-site.mjs [--dist dir] [--export dir] [--require-dataset]\n`);
  process.exit(2);
}
if (!existsSync(join(opts.dist, 'index.html'))) {
  process.stderr.write(`error: ${opts.dist}/index.html not found; run \`npm run build\` first\n`);
  process.exit(1);
}

writeFileSync(join(opts.dist, '.nojekyll'), '');
const lines = [];
const datasetPath = join(opts.dist, 'data', 'dataset.json');
let exitCode = 0;
if (existsSync(datasetPath)) {
  const size = statSync(datasetPath).size;
  let generated = '?';
  let videos = '?';
  try {
    const ds = JSON.parse(readFileSync(datasetPath, 'utf8'));
    if (typeof ds.generatedAt === 'number') generated = new Date(ds.generatedAt).toISOString();
    if (Array.isArray(ds.videos)) videos = String(ds.videos.length);
    else if (ds.videos && typeof ds.videos === 'object' && Array.isArray(ds.videos.id)) videos = String(ds.videos.id.length);
  } catch (err) {
    lines.push(`- WARNING: data/dataset.json is not valid JSON (${err instanceof Error ? err.message : String(err)})`);
    exitCode = opts.requireDataset ? 1 : 0;
  }
  lines.push(`- Dataset: data/dataset.json ${mb(size)}, generatedAt ${generated}, videos ${videos}`);
} else {
  lines.push('- Dataset: MISSING (data/dataset.json) — the site will show the sample dataset with the "샘플 데이터" banner');
  if (opts.requireDataset) exitCode = 1;
}
const metaSrc = join(opts.exportDir, 'meta.json');
if (existsSync(metaSrc) && existsSync(datasetPath)) {
  copyFileSync(metaSrc, join(opts.dist, 'data', 'meta.json'));
  lines.push('- data/meta.json copied from the export');
}
const apiIndex = join(opts.dist, 'api', 'v1', 'index.json');
if (existsSync(apiIndex)) {
  try {
    const idx = JSON.parse(readFileSync(apiIndex, 'utf8'));
    lines.push(`- Static API: api/v1/ ${Array.isArray(idx.files) ? idx.files.length : '?'} file(s) + index.json`);
  } catch {
    lines.push('- Static API: api/v1/index.json unreadable');
  }
} else {
  lines.push('- Static API: not generated (api/v1/index.json missing)');
}
const total = walk(opts.dist);
lines.push(`- Site: ${total.files} file(s), ${mb(total.bytes)} in ${opts.dist}`);
if (total.bytes > 900_000_000) lines.push('- WARNING: the site is close to the 1 GB GitHub Pages limit');

process.stdout.write(`${lines.join('\n')}\n`);
if (process.env.GITHUB_STEP_SUMMARY) {
  try {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Site\n${lines.join('\n')}\n`);
  } catch {
    // summary is best effort
  }
}
process.exitCode = exitCode;
