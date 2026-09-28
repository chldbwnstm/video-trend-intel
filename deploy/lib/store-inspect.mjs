#!/usr/bin/env node
/**
 * Inspect (and optionally checkpoint) the collector's SQLite store. OWNER: deploy.
 *
 *   node deploy/lib/store-inspect.mjs <store.sqlite> [--checkpoint] [--require-ok] [--env]
 *
 * --checkpoint  fold the WAL into the main file (PRAGMA wal_checkpoint(TRUNCATE)) before measuring, so the
 *               single .sqlite file is complete and safe to copy / gzip.
 * --require-ok  exit 1 when the file is missing, is not a SQLite database or fails PRAGMA quick_check.
 * --env         print KEY=VALUE lines (for shell scripts) instead of one JSON object.
 *
 * Reports: bytes, quick_check result, schema user_version and row counts of the append-only tables
 * (videos, observations, accounts, runs) plus the latest run time. Never creates a missing file.
 * Used by deploy/ci/store-release.sh (CI restore/save guard) and deploy/bootstrap.sh.
 */
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const USAGE = 'usage: node deploy/lib/store-inspect.mjs <store.sqlite> [--checkpoint] [--require-ok] [--env]';

function parse(argv) {
  const opts = { path: null, checkpoint: false, requireOk: false, env: false };
  for (const a of argv) {
    if (a === '--checkpoint') opts.checkpoint = true;
    else if (a === '--require-ok') opts.requireOk = true;
    else if (a === '--env') opts.env = true;
    else if (a === '-h' || a === '--help') return null;
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else if (opts.path === null) opts.path = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  if (opts.path === null) throw new Error('missing <store.sqlite>');
  return opts;
}

function count(db, table) {
  try {
    const row = db.prepare(`SELECT count(*) AS n FROM ${table}`).get();
    return Number(row.n);
  } catch {
    return null; // table missing (fresh store) or unreadable
  }
}

function inspect(path, checkpoint) {
  const report = {
    path,
    exists: existsSync(path),
    bytes: 0,
    ok: false,
    check: null,
    userVersion: null,
    videos: null,
    observations: null,
    accounts: null,
    runs: null,
    lastRunAt: null,
    error: null,
  };
  if (!report.exists) {
    report.error = 'file not found';
    return report;
  }
  let db;
  try {
    db = new DatabaseSync(path);
    db.exec('PRAGMA busy_timeout = 5000');
    const rows = db.prepare('PRAGMA quick_check').all();
    const msgs = rows.map((r) => String(Object.values(r)[0]));
    report.check = msgs.slice(0, 5).join('; ');
    report.ok = msgs.length === 1 && msgs[0] === 'ok';
    report.userVersion = Number(db.prepare('PRAGMA user_version').get().user_version);
    report.videos = count(db, 'videos');
    report.observations = count(db, 'observations');
    report.accounts = count(db, 'accounts');
    report.runs = count(db, 'runs');
    try {
      const r = db.prepare('SELECT max(started_at) AS t FROM runs').get();
      report.lastRunAt = r.t === null || r.t === undefined ? null : Number(r.t);
    } catch {
      report.lastRunAt = null;
    }
    if (checkpoint) {
      const mode = db.prepare('PRAGMA journal_mode').get();
      if (String(Object.values(mode)[0]).toLowerCase() === 'wal') db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    }
  } catch (err) {
    report.ok = false;
    report.error = err instanceof Error ? err.message : String(err);
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
  report.bytes = statSync(path).size;
  return report;
}

function toEnv(r) {
  const v = (x) => (x === null || x === undefined ? '' : String(x).replace(/[\r\n]+/g, ' '));
  return [
    `STORE_EXISTS=${r.exists ? 1 : 0}`,
    `STORE_OK=${r.ok ? 1 : 0}`,
    `STORE_BYTES=${r.bytes}`,
    `STORE_VIDEOS=${v(r.videos)}`,
    `STORE_OBSERVATIONS=${v(r.observations)}`,
    `STORE_ACCOUNTS=${v(r.accounts)}`,
    `STORE_RUNS=${v(r.runs)}`,
    `STORE_LAST_RUN_AT=${v(r.lastRunAt)}`,
    `STORE_USER_VERSION=${v(r.userVersion)}`,
    `STORE_CHECK=${v(r.check)}`,
    `STORE_ERROR=${v(r.error)}`,
  ].join('\n');
}

let opts;
try {
  opts = parse(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`error: ${err.message}\n${USAGE}\n`);
  process.exit(2);
}
if (opts === null) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}
const report = inspect(resolve(opts.path), opts.checkpoint);
process.stdout.write(`${opts.env ? toEnv(report) : JSON.stringify(report)}\n`);
process.exitCode = opts.requireOk && !report.ok ? 1 : 0;
