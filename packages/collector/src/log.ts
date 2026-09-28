/**
 * Minimal logger for the collector: console (info -> stdout, warn/error -> stderr) plus an optional append-only
 * log file (normally `data/logs/collector-YYYY-MM-DD.log`). OWNER: collector-pipeline.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CollectLogger } from './types.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger extends CollectLogger {
  debug(msg: string): void;
  /** Logger that prefixes every message with `[prefix]`, sharing sinks with this one. */
  child(prefix: string): Logger;
  /** Path of the log file, or null. */
  readonly file: string | null;
}

export interface LoggerOptions {
  /** Append log lines to this file (directories are created). */
  file?: string | null;
  /** Minimum level (default 'info'). */
  level?: LogLevel;
  /** Write to the console (default true). */
  console?: boolean;
  stdout?: { write(s: string): unknown };
  stderr?: { write(s: string): unknown };
  clock?: () => number;
}

interface Sink {
  write(level: LogLevel, line: string): void;
}

function makeLogger(sink: Sink, minLevel: LogLevel, prefix: string, file: string | null): Logger {
  const emit = (level: LogLevel, msg: string) => {
    if (LEVELS[level] < LEVELS[minLevel]) return;
    sink.write(level, prefix ? `[${prefix}] ${msg}` : msg);
  };
  return {
    debug: (m) => emit('debug', m),
    info: (m) => emit('info', m),
    warn: (m) => emit('warn', m),
    error: (m) => emit('error', m),
    child: (p) => makeLogger(sink, minLevel, prefix ? `${prefix}:${p}` : p, file),
    file,
  };
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const clock = opts.clock ?? Date.now;
  const useConsole = opts.console ?? true;
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  let file = opts.file ?? null;
  let fileReady = false;

  const sink: Sink = {
    write(level, msg) {
      const line = `${new Date(clock()).toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}\n`;
      if (useConsole) (level === 'warn' || level === 'error' ? stderr : stdout).write(line);
      if (file) {
        try {
          if (!fileReady) {
            mkdirSync(dirname(file), { recursive: true });
            fileReady = true;
          }
          appendFileSync(file, line, 'utf8');
        } catch (err) {
          const failed = file;
          file = null; // disable file logging instead of failing the run
          stderr.write(`log: cannot write ${failed}: ${err instanceof Error ? err.message : String(err)}; file logging disabled\n`);
        }
      }
    },
  };
  return makeLogger(sink, opts.level ?? 'info', '', file);
}

/** `<dataDir>/logs/collector-YYYY-MM-DD.log` (UTC date). */
export function defaultLogFile(dataDir: string, now: number = Date.now()): string {
  return join(dataDir, 'logs', `collector-${new Date(now).toISOString().slice(0, 10)}.log`);
}

/** Logger that drops everything. */
export const silentLogger: Logger = makeLogger({ write() {} }, 'error', '', null);

/** Logger that keeps lines in memory (tests, programmatic callers). */
export function memoryLogger(level: LogLevel = 'debug'): Logger & { lines: { level: LogLevel; msg: string }[] } {
  const lines: { level: LogLevel; msg: string }[] = [];
  const logger = makeLogger({ write: (lv, msg) => lines.push({ level: lv, msg }) }, level, '', null);
  return Object.assign(logger, { lines });
}
