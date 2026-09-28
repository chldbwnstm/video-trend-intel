#!/usr/bin/env node
/**
 * Copy collector credentials / tuning from a local .env to the GitHub repository. OWNER: deploy.
 *
 *   node deploy/lib/set-secrets.mjs --repo owner/name [--env .env] [--dry-run]
 *
 * Credentials become repository SECRETS, non-secret tuning values become repository VARIABLES
 * (both read by .github/workflows/collect-deploy.yml). Values are piped to `gh secret set` /
 * `gh variable set` on stdin: they never appear on a command line or in this script's output (only key names
 * are printed). Keys that are missing or blank in .env are left untouched on GitHub.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

export const SECRET_KEYS = [
  'YOUTUBE_API_KEY',
  'TIKTOK_CLIENT_KEY',
  'TIKTOK_CLIENT_SECRET',
  'IG_ACCESS_TOKEN',
  'IG_USER_ID',
  'X_BEARER_TOKEN',
  'TWITCH_CLIENT_ID',
  'TWITCH_CLIENT_SECRET',
  'TWITCH_USER_TOKEN',
];

export const VARIABLE_KEYS = [
  'IG_BUSINESS_USERNAMES',
  'IG_HASHTAGS',
  'IG_MEDIA_PAGES',
  'IG_GRAPH_API_VERSION',
  'YOUTUBE_SEARCHES_PER_RUN',
  'YOUTUBE_REGION_CODE',
  'TIKTOK_REGION_CODES',
  'TIKTOK_LOOKBACK_DAYS',
  'TIKTOK_QUERIES_PER_RUN',
  'TIKTOK_PAGES_PER_QUERY',
  'X_QUERIES_PER_RUN',
  'X_PAGES_PER_QUERY',
  'X_MAX_RESULTS',
  'X_SORT_ORDER',
  'X_FIELDS_PARAM',
  'TWITCH_LANGUAGE',
  'TWITCH_TOP_GAMES',
  'TWITCH_CLIP_PAGES',
  'TWITCH_CLIP_DAYS',
  'TWITCH_MAX_FOLLOWER_LOOKUPS',
];

function args(argv) {
  const o = { repo: null, env: '.env', dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') o.repo = argv[++i];
    else if (a === '--env') o.env = argv[++i];
    else if (a === '--dry-run') o.dryRun = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!o.repo || !/^[\w.-]+\/[\w.-]+$/.test(o.repo)) throw new Error('--repo owner/name is required');
  if (!o.env) throw new Error('--env needs a path');
  return o;
}

let opts;
try {
  opts = args(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`error: ${err.message}\nusage: node deploy/lib/set-secrets.mjs --repo owner/name [--env .env] [--dry-run]\n`);
  process.exit(2);
}

const envPath = resolve(opts.env);
if (!existsSync(envPath)) {
  process.stdout.write(`${opts.env} not found: no secrets to copy (credentialed sources stay disabled until you add repository secrets)\n`);
  process.exit(0);
}
const parsed = parseEnv(readFileSync(envPath, 'utf8').replace(/^﻿/, ''));

let failures = 0;
let count = 0;
for (const [kind, keys] of [
  ['secret', SECRET_KEYS],
  ['variable', VARIABLE_KEYS],
]) {
  for (const key of keys) {
    const value = (parsed[key] ?? '').trim();
    if (!value) continue;
    count++;
    if (opts.dryRun) {
      process.stdout.write(`would set ${kind} ${key}\n`);
      continue;
    }
    const res = spawnSync('gh', [kind, 'set', key, '--repo', opts.repo], {
      input: value,
      stdio: ['pipe', 'ignore', 'pipe'],
      encoding: 'utf8',
    });
    if (res.status === 0) process.stdout.write(`set ${kind} ${key}\n`);
    else {
      failures++;
      // gh's error text never contains the value (it was sent on stdin), but keep only the first line anyway.
      const first = String(res.stderr ?? res.error?.message ?? '').split(/\r?\n/)[0];
      process.stderr.write(`failed to set ${kind} ${key}: ${first}\n`);
    }
  }
}
if (count === 0) process.stdout.write(`${opts.env} has no collector credentials or tuning keys set\n`);
process.exitCode = failures ? 1 : 0;
