#!/usr/bin/env node
/**
 * Finish the static site in apps/web/dist for GitHub Pages. OWNER: deploy.
 *
 *   node deploy/lib/finalize-site.mjs [--dist apps/web/dist] [--export data/export] [--require-dataset] [--no-sri]
 *
 * - writes `.nojekyll` (the artifact is served as-is; harmless for Actions deployments, required for branch ones)
 * - adds a Content-Security-Policy <meta> to index.html (GitHub Pages cannot send headers; the Node server sends its
 *   own CSP): scripts only from the site itself plus the hashes of the inline scripts in index.html, styles/fonts
 *   from the site and cdn.jsdelivr.net, images from https: (thumbnails come from hundreds of PeerTube instances),
 *   fetches only from the site, no plugins, no <base> or form hijacking. Skipped when index.html already has one.
 * - adds Subresource Integrity (+ crossorigin) to the version-pinned jsDelivr stylesheet, computed from the file
 *   fetched now (skipped with a warning when it cannot be fetched, or with --no-sri)
 * - copies `data/export/meta.json` next to the dataset (`data/meta.json`, same file the server serves)
 * - reports what will be published: dataset (real or sample fallback), static API files, total size
 * - appends the report to $GITHUB_STEP_SUMMARY when running in GitHub Actions
 * --require-dataset exits 1 when `data/dataset.json` is missing (the site would fall back to sample data).
 */
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

function args(argv) {
  const o = { dist: 'apps/web/dist', exportDir: 'data/export', requireDataset: false, sri: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dist') o.dist = argv[++i];
    else if (a === '--export') o.exportDir = argv[++i];
    else if (a === '--require-dataset') o.requireDataset = true;
    else if (a === '--no-sri') o.sri = false;
    else throw new Error(`unknown argument ${a}`);
    if (o.dist === undefined || o.exportDir === undefined) throw new Error(`${a} needs a value`);
  }
  return { dist: resolve(ROOT, o.dist), exportDir: resolve(ROOT, o.exportDir), requireDataset: o.requireDataset, sri: o.sri };
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

const sha256b64 = (data) => createHash('sha256').update(data).digest('base64');

/** CSP for the static site; `scriptHashes` are the 'sha256-…' sources of index.html's inline scripts. */
export function contentSecurityPolicy(scriptHashes) {
  return [
    "default-src 'self'",
    ["script-src 'self'", ...scriptHashes].join(' '),
    "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
    "font-src 'self' data: https://cdn.jsdelivr.net",
    "img-src 'self' data: blob: https:",
    "connect-src 'self'",
    "media-src 'self' https:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}

/** Hash sources of every inline <script> (no src) in `html`, exactly as the browser hashes them. */
export function inlineScriptHashes(html) {
  const out = [];
  for (const m of html.matchAll(/<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)) out.push(`'sha256-${sha256b64(m[1])}'`);
  return out;
}

/** Add the CSP <meta> right after <meta charset> (before anything it governs). Returns a report line. */
function addCsp(indexPath) {
  let html = readFileSync(indexPath, 'utf8');
  if (/http-equiv\s*=\s*["']content-security-policy["']/i.test(html)) return '- CSP: index.html already declares one (kept as is)';
  const hashes = inlineScriptHashes(html);
  const meta = `<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(hashes)}" />`;
  if (!/<meta\s+charset[^>]*>/i.test(html)) return '- WARNING: CSP not added (no <meta charset> in index.html to anchor it)';
  html = html.replace(/(<meta\s+charset[^>]*>)/i, `$1\n    ${meta}`);
  writeFileSync(indexPath, html);
  return `- CSP: added to index.html (${hashes.length} inline script hash(es))`;
}

/** Subresource Integrity for version-pinned jsDelivr stylesheets (content fetched now). */
async function addSri(indexPath) {
  let html = readFileSync(indexPath, 'utf8');
  const links = [...html.matchAll(/<link\b[^>]*\brel\s*=\s*["']stylesheet["'][^>]*>/gi)].map((m) => m[0]).filter((tag) => /href\s*=\s*["']https:\/\/cdn\.jsdelivr\.net\/[^"']*@[^"'/]+\//i.test(tag) && !/\bintegrity\s*=/.test(tag));
  const out = [];
  for (const tag of links) {
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(tag)[1];
    try {
      const res = await fetch(href, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = Buffer.from(await res.arrayBuffer());
      const withSri = tag.replace(/\s*\/?>$/, (end) => ` integrity="sha256-${sha256b64(body)}"${/\bcrossorigin\b/i.test(tag) ? '' : ' crossorigin="anonymous"'}${end.includes('/') ? ' />' : '>'}`);
      html = html.replace(tag, withSri);
      out.push(`- SRI: ${href}`);
    } catch (err) {
      out.push(`- WARNING: no SRI for ${href} (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  if (links.length) writeFileSync(indexPath, html);
  return out;
}

let opts;
try {
  opts = args(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`error: ${err.message}\nusage: node deploy/lib/finalize-site.mjs [--dist dir] [--export dir] [--require-dataset] [--no-sri]\n`);
  process.exit(2);
}
if (!existsSync(join(opts.dist, 'index.html'))) {
  process.stderr.write(`error: ${opts.dist}/index.html not found; run \`npm run build\` first\n`);
  process.exit(1);
}

writeFileSync(join(opts.dist, '.nojekyll'), '');
const lines = [];
const indexPath = join(opts.dist, 'index.html');
if (opts.sri) lines.push(...(await addSri(indexPath)));
// CSP last: the policy is computed from the final index.html.
lines.push(addCsp(indexPath));
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
