import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptySeeds } from '@vti/collector';
import type { SourceAdapter } from '@vti/collector';
import { Scheduler, createCollectJob, type JobSummary } from '../src/scheduler.ts';
import { configFromEnv, DatasetLoader, firstRunTime } from '../src/main.ts';
import { fixtureCompactJson, NOW } from './fixtures.ts';

function memLog() {
  const lines: string[] = [];
  return { lines, info: (m: string) => lines.push(`I ${m}`), warn: (m: string) => lines.push(`W ${m}`), error: (m: string) => lines.push(`E ${m}`) };
}

describe('Scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs at firstRunAt, then every interval, never two runs at once', async () => {
    const log = memLog();
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    const resolvers: (() => void)[] = [];
    const job = () =>
      new Promise<JobSummary>((resolve) => {
        calls++;
        active++;
        maxActive = Math.max(maxActive, active);
        resolvers.push(() => {
          active--;
          resolve({ ok: true, message: 'done' });
        });
      });
    const s = new Scheduler({ intervalMs: 60_000, job, log, firstRunAt: 10_000, minDelayMs: 1_000 });
    s.start();
    expect(s.status()).toMatchObject({ enabled: true, running: false, nextRunAt: 10_000, runs: 0 });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(calls).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(1);
    expect(s.running).toBe(true);
    // A manual trigger while running returns the running run instead of starting another.
    const same = s.runNow();
    expect(calls).toBe(1);
    // Run takes longer than the interval: no second run meanwhile.
    await vi.advanceTimersByTimeAsync(200_000);
    expect(calls).toBe(1);
    resolvers.shift()!();
    const rec = await same;
    expect(rec.ok).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.status()).toMatchObject({ running: false, runs: 1, failures: 0 });
    // Overdue (started at 10 s, interval 60 s, finished at 210 s): next run after minDelay.
    expect(s.status().nextRunAt).toBe(211_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(2);
    resolvers.shift()!();
    await vi.advanceTimersByTimeAsync(0);
    // On time: next run one interval after the previous start.
    expect(s.status().nextRunAt).toBe(211_000 + 60_000);
    expect(maxActive).toBe(1);
    await s.stop();
    expect(s.status()).toMatchObject({ enabled: false, nextRunAt: null });
    await vi.advanceTimersByTimeAsync(1_000_000);
    expect(calls).toBe(2);
  });

  it('a throwing or failing job is recorded and never escapes; scheduling continues', async () => {
    const log = memLog();
    let n = 0;
    const job = async (): Promise<JobSummary> => {
      n++;
      if (n === 1) throw new Error('network down');
      return { ok: false, message: 'all sources failed' };
    };
    const s = new Scheduler({ intervalMs: 5_000, job, log, firstRunAt: 1_000, minDelayMs: 0 });
    s.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.status().lastRun).toMatchObject({ ok: false, error: 'network down' });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(n).toBe(2);
    expect(s.status()).toMatchObject({ runs: 2, failures: 2 });
    expect(s.status().lastRun).toMatchObject({ ok: false, message: 'all sources failed' });
    expect(log.lines.some((l) => l.startsWith('E scheduler: collection failed') && l.includes('network down'))).toBe(true);
    await s.stop();
  });

  it('rejects a non-positive interval', () => {
    expect(() => new Scheduler({ intervalMs: 0, job: async () => ({ ok: true, message: '' }), log: memLog() })).toThrow(RangeError);
  });
});

describe('createCollectJob (collector + export)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vti-job-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function fakeAdapter(id: string, collect: SourceAdapter['collect']): SourceAdapter {
    return {
      id,
      platform: 'dailymotion',
      label: `Fake ${id}`,
      requiresCredentials: false,
      envKeys: [],
      metrics: ['views', 'likes'],
      discovery: '테스트용 가짜 원천',
      notes: [],
      docsUrl: null,
      version: 1,
      isEnabled: () => true,
      collect,
    };
  }

  it('collects, exports, calls onExported and the loader picks the export up', async () => {
    const t = Date.now();
    const adapter = fakeAdapter('fake-dm', async () => ({
      videos: [
        {
          platform: 'dailymotion',
          platformId: 'x1',
          url: 'https://example.org/x1',
          title: '축구 하이라이트',
          description: null,
          thumbnail: null,
          publishedAt: t - 86_400_000,
          durationSec: 60,
          format: 'long',
          account: { platform: 'dailymotion', platformId: 'acc1', handle: null, name: 'DM 채널', url: 'https://example.org/acc1', avatar: null, country: 'KR', followers: null },
          language: 'ko',
          languageSource: 'source',
          country: 'KR',
          sourceCategory: 'sport',
          tags: [],
          counters: { views: 1000, likes: 10, comments: null, shares: null },
          observedAt: t,
          discoveredVia: 'dailymotion:test',
          sourceWindows: [{ metric: 'views', windowHours: 24, value: 900 }],
        },
      ],
      accounts: [],
      errors: [],
    }));
    const exportDir = join(dir, 'export');
    const exported: string[] = [];
    const job = createCollectJob({ dbPath: join(dir, 'store.sqlite'), exportDir, logDir: null, console: false, env: {}, adapters: [adapter], seeds: emptySeeds(), onExported: (r) => void exported.push(r.datasetPath) });
    const res = await job();
    expect(res.ok).toBe(true);
    expect(res.message).toContain('1/1 source(s) ok');
    expect(exported).toEqual([join(exportDir, 'dataset.json')]);
    const loader = new DatasetLoader(exportDir, [], memLog());
    await loader.checkForUpdate();
    expect(loader.index?.dataset.videos.map((v) => v.id)).toEqual(['dailymotion:x1']);
    expect(loader.index?.dataset.videos[0].sourceWindows[0]).toMatchObject({ windowHours: 24, value: 900 });

    // A failing source: the run is reported as failed, but an export is still written (coverage shows it).
    const broken = fakeAdapter('fake-dm', async () => {
      throw new Error('HTTP 503');
    });
    const job2 = createCollectJob({ dbPath: join(dir, 'store.sqlite'), exportDir, logDir: null, console: false, env: {}, adapters: [broken], seeds: emptySeeds() });
    const res2 = await job2();
    expect(res2.ok).toBe(false);
    expect(res2.message).toContain('all sources failed');
    expect((res2.details as any).export.videos).toBe(1);
    loader.close();
  });
});

describe('firstRunTime / config', () => {
  const cfg = { intervalMin: 180, startDelaySec: 60, collectOnStart: false };
  const now = 1_000_000_000;

  it('waits one interval after the loaded export, but not less than the start delay', () => {
    expect(firstRunTime(cfg, now - 60 * 60_000, true, now)).toBe(now - 60 * 60_000 + 180 * 60_000);
    expect(firstRunTime(cfg, now - 10 * 3_600_000, true, now)).toBe(now + 60_000); // overdue
    expect(firstRunTime(cfg, null, false, now)).toBe(now + 60_000); // no data
    expect(firstRunTime(cfg, now, false, now)).toBe(now + 60_000); // fallback (not an export) -> collect soon
    expect(firstRunTime({ ...cfg, collectOnStart: true }, now, true, now)).toBe(now + 60_000);
  });

  it('reads the environment with defaults', () => {
    const c = configFromEnv({});
    expect(c).toMatchObject({ port: 8787, host: '0.0.0.0', intervalMin: 180, rateLimitPerMin: 120, trustProxy: false, copyToWeb: null });
    expect(c.exportDir.replace(/\\/g, '/')).toMatch(/\/data\/export$/);
    const d = configFromEnv({ PORT: '9000', COLLECT_INTERVAL_MIN: '0', DATA_DIR: 'x/y', TRUST_PROXY: '1', RATE_LIMIT_PER_MIN: '0' });
    expect(d).toMatchObject({ port: 9000, intervalMin: 0, trustProxy: true, rateLimitPerMin: 0 });
    expect(d.dbPath.replace(/\\/g, '/')).toMatch(/\/x\/y\/store\.sqlite$/);
    expect(() => configFromEnv({ PORT: 'abc' })).toThrow(/PORT/);
  });
});

describe('DatasetLoader (hot swap)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vti-loader-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('loads the export, falls back when missing, swaps on change and keeps the old index on a broken file', async () => {
    const log = memLog();
    const fallback = join(dir, 'fallback.json');
    writeFileSync(fallback, fixtureCompactJson(NOW - 3_600_000));
    const exportDir = join(dir, 'export');
    const loader = new DatasetLoader(exportDir, [fallback], log);
    expect(await loader.loadInitial()).toBe(true);
    expect(loader.status()).toMatchObject({ fromExport: false, generatedAt: NOW - 3_600_000, loads: 1 });
    expect(loader.index?.dataset.videos).toHaveLength(5);

    // An export appears -> swapped in.
    const { mkdirSync } = await import('node:fs');
    mkdirSync(exportDir, { recursive: true });
    writeFileSync(join(exportDir, 'dataset.json'), fixtureCompactJson(NOW));
    await loader.checkForUpdate();
    expect(loader.status()).toMatchObject({ fromExport: true, generatedAt: NOW, loads: 2 });
    const good = loader.index;

    // Unchanged file -> no reload.
    await loader.checkForUpdate();
    expect(loader.status().loads).toBe(2);

    // Broken file -> previous index kept, error recorded, not retried until it changes.
    writeFileSync(join(exportDir, 'dataset.json'), '{"schemaVersion": 99, "videos": []}');
    utimesSync(join(exportDir, 'dataset.json'), new Date(), new Date(Date.now() + 5_000));
    await loader.checkForUpdate();
    expect(loader.index).toBe(good);
    expect(loader.status().failures).toBe(1);
    expect(loader.status().lastError).toMatch(/schemaVersion/);
    await loader.checkForUpdate();
    expect(loader.status().failures).toBe(1);

    // Fixed file -> swapped again.
    writeFileSync(join(exportDir, 'dataset.json'), fixtureCompactJson(NOW + 3_600_000));
    utimesSync(join(exportDir, 'dataset.json'), new Date(), new Date(Date.now() + 10_000));
    await loader.checkForUpdate();
    expect(loader.status()).toMatchObject({ generatedAt: NOW + 3_600_000, loads: 3, lastError: null });
    loader.close();
  });

  it('reports no dataset when nothing exists', async () => {
    const log = memLog();
    const loader = new DatasetLoader(join(dir, 'export'), [join(dir, 'missing.json')], log);
    expect(await loader.loadInitial()).toBe(false);
    expect(loader.index).toBeNull();
    expect(log.lines.some((l) => l.startsWith('W no dataset found'))).toBe(true);
  });
});
