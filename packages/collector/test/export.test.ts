import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeDataset, encodeDataset, localDateStartUtc, localDateOf, addDays, valueAt, type CompactDataset, type ObservationPoint, type Video } from '@vti/core';
import { buildDataset, buildDatasetDetailed, compactSeries, latestSourceWindows, normalizeAccountName, suggestCreators, writeExport } from '../src/export.ts';
import { classifyStoredVideos } from '../src/classify.ts';
import { openStore, type Store } from '../src/store.ts';
import type { RawAccount, RawVideo } from '../src/types.ts';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const NOW = Date.parse('2026-09-28T12:00:00Z');
const TZ = 'Asia/Seoul';

const dirs: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function mem(): Store {
  const s = openStore(':memory:');
  stores.push(s);
  return s;
}
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'vti-export-'));
  dirs.push(d);
  return d;
}

function pt(t: number, views: number | null, src = 'a@1'): ObservationPoint {
  return { t, views, likes: views === null ? null : Math.floor(views / 10), comments: null, shares: null, src };
}

function asVideo(obs: ObservationPoint[], publishedAt: number): Video {
  return {
    id: 'youtube:x', platform: 'youtube', platformId: 'x', url: '', title: '', description: null, thumbnail: null, publishedAt, durationSec: null,
    format: 'long', accountId: 'youtube:a', language: null, languageSource: null, country: null, sourceCategory: null, tags: [], categories: [],
    topics: [], sponsorship: null, status: 'active', firstSeenAt: publishedAt, lastObservedAt: obs[obs.length - 1].t, discoveredVia: [], obs, sourceWindows: [],
  };
}

describe('compactSeries', () => {
  // Hourly observations (at :17 past) for 120 days before NOW, monotonically increasing views.
  const first = NOW - 120 * DAY + 17 * 60_000;
  const raw: ObservationPoint[] = [];
  for (let t = first, i = 0; t <= NOW; t += HOUR, i++) raw.push(pt(t, 1000 + i * 37));
  const compact = compactSeries(raw, NOW, TZ);
  const kept = new Set(compact.map((p) => p.t));

  it('keeps first and last point and thins older data', () => {
    expect(compact[0]).toEqual(raw[0]);
    expect(compact[compact.length - 1]).toEqual(raw[raw.length - 1]);
    expect(compact.length).toBeLessThan(raw.length / 4);
    for (let i = 1; i < compact.length; i++) expect(compact[i].t).toBeGreaterThan(compact[i - 1].t);
  });

  it('keeps every point of the last 72 hours', () => {
    for (const p of raw) if (NOW - p.t < 72 * HOUR) expect(kept.has(p.t)).toBe(true);
  });

  it('keeps both neighbours of every Asia/Seoul local-day boundary of the last 14 days, and the last point of each older day', () => {
    let day = localDateOf(first, TZ);
    const lastDay = localDateOf(NOW, TZ);
    let recent = 0;
    let older = 0;
    while (day < lastDay) {
      day = addDays(day, 1);
      const b = localDateStartUtc(day, TZ);
      const before = [...raw].reverse().find((p) => p.t < b)!;
      const after = raw.find((p) => p.t >= b)!;
      if (NOW - after.t < 14 * DAY) {
        expect(kept.has(before.t)).toBe(true);
        expect(kept.has(after.t)).toBe(true);
        recent++;
      } else if (NOW - before.t < 90 * DAY) {
        expect(kept.has(before.t)).toBe(true); // last point before midnight = the day's point
        older++;
      }
    }
    expect(recent).toBeGreaterThanOrEqual(13);
    expect(older).toBeGreaterThan(70);
  });

  it('values at every local midnight of the last 14 days are identical to the raw series (daily windows stay exact)', () => {
    const rawVideo = asVideo(raw, first - HOUR);
    const compactVideo = asVideo(compact, first - HOUR);
    let day = localDateOf(first, TZ);
    let checked = 0;
    for (let i = 0; i < 119; i++) {
      day = addDays(day, 1);
      const b = localDateStartUtc(day, TZ);
      if (NOW - b >= 14 * DAY - HOUR) continue;
      expect(valueAt(compactVideo, 'views', b)).toEqual(valueAt(rawVideo, 'views', b));
      expect(valueAt(compactVideo, 'likes', b)).toEqual(valueAt(rawVideo, 'likes', b));
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(13);
  });

  it('keeps the stated density at every age (8 points per day for 120 days)', () => {
    const pts: ObservationPoint[] = [];
    for (let t = NOW - 120 * DAY; t <= NOW; t += 3 * HOUR) pts.push(pt(t, Math.round((t - (NOW - 120 * DAY)) / HOUR)));
    const c = compactSeries(pts, NOW, TZ);
    const density = (fromDays: number, toDays: number) => {
      const inBand = c.filter((p) => NOW - p.t >= fromDays * DAY && NOW - p.t < toDays * DAY);
      return inBand.length / (toDays - fromDays);
    };
    expect(density(0, 3)).toBeCloseTo(8, 0); // everything
    expect(density(3, 14)).toBeLessThanOrEqual(5.1); // one per 6 h bucket + the first point after midnight
    expect(density(14, 90)).toBeLessThanOrEqual(1.05); // one per local day
    expect(density(14, 90)).toBeGreaterThanOrEqual(0.95);
    expect(density(90, 120)).toBeLessThanOrEqual(1 / 7 + 0.1); // one per local week (+ the first point)
  });

  it('respects the per-age density limits', () => {
    const localDay = (t: number) => localDateOf(t, TZ);
    // 3-14 days: at most one per 6h bucket plus the two day-boundary neighbours per day.
    const mid = compact.filter((p) => NOW - p.t >= 72 * HOUR && NOW - p.t < 14 * DAY);
    const midDays = new Set(mid.map((p) => localDay(p.t)));
    expect(mid.length).toBeLessThanOrEqual(midDays.size * (4 + 1));
    // 14-90 days: first + last point of each local day at most.
    const daily = compact.filter((p) => NOW - p.t >= 14 * DAY && NOW - p.t < 90 * DAY);
    const perDay = new Map<string, number>();
    for (const p of daily) perDay.set(localDay(p.t), (perDay.get(localDay(p.t)) ?? 0) + 1);
    for (const n of perDay.values()) expect(n).toBeLessThanOrEqual(2);
  });

  it('beyond 90 days keeps one point per local week (no day-boundary neighbours)', () => {
    // three observations per local day (every 8h) between 200 and 91 days ago
    const pts: ObservationPoint[] = [];
    for (let t = NOW - 200 * DAY; t <= NOW - 91 * DAY; t += 8 * HOUR) pts.push(pt(t, Math.round((t - (NOW - 200 * DAY)) / HOUR)));
    const c = compactSeries(pts, NOW, TZ);
    expect(c[0]).toEqual(pts[0]);
    expect(c[c.length - 1]).toEqual(pts[pts.length - 1]);
    const days = new Set(pts.map((p) => localDateOf(p.t, TZ))).size;
    expect(c.length).toBeLessThan(pts.length);
    expect(c.length).toBeLessThanOrEqual(Math.ceil(days / 7) + 3);
    // the middle observation of a day survives only as its week's last point
    const perDay = new Map<string, number>();
    for (const p of c) perDay.set(localDateOf(p.t, TZ), (perDay.get(localDateOf(p.t, TZ)) ?? 0) + 1);
    expect([...perDay.values()].filter((n) => n === 3).length).toBeLessThanOrEqual(Math.ceil(days / 7) + 1);
  });

  it('compacts each src separately and merges in time order', () => {
    const pts: ObservationPoint[] = [];
    for (let t = NOW - 30 * DAY; t <= NOW - 20 * DAY; t += HOUR) {
      pts.push(pt(t, 1, 'rss@1'));
      pts.push(pt(t + 60_000, 2, 'api@1'));
    }
    const c = compactSeries(pts, NOW, TZ);
    for (const src of ['rss@1', 'api@1']) {
      const own = pts.filter((p) => p.src === src);
      const keptOwn = c.filter((p) => p.src === src);
      expect(keptOwn[0]).toEqual(own[0]);
      expect(keptOwn[keptOwn.length - 1]).toEqual(own[own.length - 1]);
    }
    for (let i = 1; i < c.length; i++) expect(c[i].t).toBeGreaterThanOrEqual(c[i - 1].t);
  });

  it('handles tiny and unsorted input, and DST zones', () => {
    expect(compactSeries([], NOW)).toEqual([]);
    const two = [pt(NOW, 2), pt(NOW - 100 * DAY, 1)];
    expect(compactSeries(two, NOW)).toEqual([two[1], two[0]]);
    // Australia/Sydney DST start 2026-10-04: boundaries still preserved
    const syd: ObservationPoint[] = [];
    const s0 = Date.parse('2026-10-01T00:00:00Z');
    for (let t = s0; t < s0 + 7 * DAY; t += HOUR) syd.push(pt(t, (t - s0) / HOUR));
    const later = s0 + 10 * DAY; // boundary neighbours are kept for the last 14 days
    const c = compactSeries(syd, later, 'Australia/Sydney');
    const keptT = new Set(c.map((p) => p.t));
    const b = localDateStartUtc('2026-10-05', 'Australia/Sydney');
    expect(keptT.has(syd.filter((p) => p.t < b).pop()!.t)).toBe(true);
    expect(keptT.has(syd.find((p) => p.t >= b)!.t)).toBe(true);
  });

  it('latestSourceWindows keeps the newest per (metric, window)', () => {
    const w = latestSourceWindows([
      { metric: 'views', windowHours: 24, value: 1, observedAt: 10, src: 's' },
      { metric: 'views', windowHours: 24, value: 2, observedAt: 20, src: 's' },
      { metric: 'views', windowHours: 168, value: 3, observedAt: 10, src: 's' },
    ]);
    expect(w.map((x) => x.value).sort()).toEqual([2, 3]);
  });
});

/* ------------------------------------------------------------------------------------------ */

function acc(platform: RawAccount['platform'], platformId: string, name: string, extra: Partial<RawAccount> = {}): RawAccount {
  return { platform, platformId, handle: null, name, url: `https://example.org/${platformId}`, avatar: null, country: 'KR', followers: null, ...extra };
}

function vid(platform: RawVideo['platform'], platformId: string, account: RawAccount, extra: Partial<RawVideo> = {}): RawVideo {
  return {
    platform, platformId, url: `https://example.org/v/${platformId}`, title: `영상 ${platformId} 먹방 레시피`, description: '#광고 협찬 제품', thumbnail: null,
    publishedAt: NOW - 5 * DAY, durationSec: 300, format: 'long', account, language: 'ko', languageSource: 'source', country: 'KR',
    sourceCategory: null, tags: ['요리'], counters: { views: 100, likes: 10, comments: null, shares: null }, observedAt: NOW, discoveredVia: 'test', ...extra,
  };
}

function populate(s: Store) {
  const ytA = acc('youtube', 'UCaaaaaaaaaaaaaaaaaaaaaa', 'Same Name', { followers: 5000 });
  const dmA = acc('dailymotion', 'dmsame', 'same name!');
  const ytV = acc('youtube', 'UCverifiedverifiedverifi', '공식 채널 A');
  const dmV = acc('dailymotion', 'dmverified', '공식 채널 A (DM)');
  const dup1 = acc('dailymotion', 'dup1', 'Twin');
  const dup2 = acc('dailymotion', 'dup2', 'Twin');
  const ytTwin = acc('youtube', 'UCtwintwintwintwintwintw', 'twin');
  const news1 = acc('youtube', 'UCnewsnewsnewsnewsnewsne', 'News');
  const news2 = acc('dailymotion', 'news', 'NEWS');
  const all = [ytA, dmA, ytV, dmV, dup1, dup2, ytTwin, news1, news2];
  for (const a of all) s.upsertAccount(a, NOW, 'seed', a.platform === 'youtube' ? 'youtube-rss' : 'dailymotion');
  s.addFollowerObservation('youtube:UCaaaaaaaaaaaaaaaaaaaaaa', { t: NOW - DAY, value: 4900, src: 'youtube-data-api@1' });
  s.addFollowerObservation('youtube:UCaaaaaaaaaaaaaaaaaaaaaa', { t: NOW, value: 5000, src: 'youtube-data-api@1' });

  const videos: [RawVideo, string][] = [
    [vid('youtube', 'yt1', ytA), 'youtube-rss'],
    [vid('youtube', 'yt2', ytV, { title: '브이로그 여행 일상' }), 'youtube-rss'],
    [vid('dailymotion', 'dm1', dmA, { sourceCategory: 'dailymotion:news' }), 'dailymotion'],
    [vid('dailymotion', 'dm2', dmV, { sourceCategory: 'dailymotion:sport', sourceWindows: [{ metric: 'views', windowHours: 24, value: 30 }] }), 'dailymotion'],
  ];
  for (const [v, src] of videos) {
    const { id } = s.upsertVideo(v, NOW, src);
    const srcTag = `${src}@1`;
    s.addObservation(id, { t: NOW - 2 * DAY, views: 10, likes: 1, comments: null, shares: null, src: srcTag });
    s.addObservation(id, { t: NOW - DAY, views: 50, likes: 4, comments: null, shares: null, src: srcTag });
    s.addObservation(id, { t: NOW, views: 100, likes: null, comments: 3, shares: null, src: srcTag });
    if (v.sourceWindows) s.addSourceWindows(id, v.sourceWindows.map((w) => ({ ...w, observedAt: NOW, src: srcTag })));
  }
  s.upsertCreators(
    [
      { id: 'verified-a', name: '공식 A', accountIds: ['youtube:UCverifiedverifiedverifi', 'dailymotion:dmverified', 'dailymotion:not-collected'], note: '검증' },
      { id: 'ghost', name: 'Ghost', accountIds: ['youtube:UCghostghostghostghostgho'], note: null },
    ],
    NOW,
    { replace: true },
  );
  s.recordRun({ id: 'run-1', source: 'dailymotion', startedAt: NOW - HOUR });
  s.finishRun('run-1', { finishedAt: NOW - HOUR + 5000, status: 'partial', videosSeen: 2, videosNew: 2, observations: 2, requests: 3, errors: ['one error'] });
  s.updateSourceState('dailymotion', { runAt: NOW - HOUR, status: 'partial', success: true, error: 'one error', notes: ['갱신 대상 일부 생략'], now: NOW });
  s.updateSourceState('youtube-rss', { runAt: NOW - HOUR, status: 'ok', success: true, now: NOW });
  s.updateSourceState('x-api', { runAt: null, status: 'disabled', notes: ['인증 정보가 없어 비활성화됨 (필요한 환경 변수: X_BEARER_TOKEN)'], now: NOW });
}

describe('buildDataset', () => {
  it('assembles videos, accounts, creators, coverage, runs and notes; encode/decode round-trips', () => {
    const s = mem();
    populate(s);
    classifyStoredVideos(s, { now: NOW });
    const ds = buildDataset(s, { now: NOW, env: {} });

    expect(ds.schemaVersion).toBe(1);
    expect(ds.generatedAt).toBe(NOW);
    expect(ds.videos.map((v) => v.id).sort()).toEqual(['dailymotion:dm1', 'dailymotion:dm2', 'youtube:yt1', 'youtube:yt2']);
    const yt1 = ds.videos.find((v) => v.id === 'youtube:yt1')!;
    expect(yt1.obs.map((o) => o.views)).toEqual([10, 50, 100]);
    expect(yt1.obs[2].likes).toBeNull(); // null stays null
    expect(yt1.categories.length).toBeGreaterThan(0);
    expect(yt1.categories.some((c) => c.id.startsWith('food'))).toBe(true);
    expect(yt1.sponsorship?.level).toBe('disclosed');
    expect(yt1.lastObservedAt).toBe(NOW);
    expect(ds.videos.find((v) => v.id === 'dailymotion:dm2')!.sourceWindows).toEqual([{ metric: 'views', windowHours: 24, value: 30, observedAt: NOW, src: 'dailymotion@1' }]);

    // creators: verified filtered to collected accounts, ghost dropped, suggested by exact normalized name
    const verified = ds.creators.find((c) => c.id === 'verified-a')!;
    expect(verified.accountIds).toEqual(['youtube:UCverifiedverifiedverifi', 'dailymotion:dmverified']);
    expect(verified.linkStatus).toBe('verified');
    expect(ds.creators.find((c) => c.id === 'ghost')).toBeUndefined();
    const suggested = ds.creators.filter((c) => c.linkStatus === 'suggested');
    expect(suggested).toHaveLength(1);
    expect(suggested[0].accountIds).toEqual(['youtube:UCaaaaaaaaaaaaaaaaaaaaaa', 'dailymotion:dmsame']);
    expect(ds.accounts.find((a) => a.id === 'dailymotion:dmsame')!.creatorId).toBe(suggested[0].id);
    expect(ds.accounts.find((a) => a.id === 'dailymotion:dmverified')!.creatorId).toBe('verified-a');
    expect(ds.accounts.find((a) => a.id === 'dailymotion:dup1')!.creatorId).toBeNull(); // ambiguous name
    expect(ds.accounts.find((a) => a.id === 'youtube:UCnewsnewsnewsnewsnewsne')!.creatorId).toBeNull(); // generic name
    expect(ds.accounts.find((a) => a.id === 'youtube:UCaaaaaaaaaaaaaaaaaaaaaa')!.followers.map((f) => f.value)).toEqual([4900, 5000]);

    // coverage: one entry per registered adapter
    const cov = new Map(ds.coverage.map((c) => [c.source, c]));
    expect(cov.size).toBe(9);
    expect(cov.get('dailymotion')).toMatchObject({ enabled: true, lastStatus: 'partial', lastError: 'one error', videoCount: 2, lastRunAt: NOW - HOUR });
    expect(cov.get('dailymotion')!.notes).toContain('갱신 대상 일부 생략');
    expect(cov.get('youtube-rss')).toMatchObject({ enabled: true, lastStatus: 'ok', videoCount: 2 });
    expect(cov.get('x-api')).toMatchObject({ enabled: false, lastStatus: 'disabled', videoCount: 0 });
    expect(cov.get('twitch')).toMatchObject({ enabled: false, lastStatus: 'disabled', firstRunAt: null }); // never ran, no credentials
    expect(cov.get('peertube')).toMatchObject({ enabled: true, lastStatus: 'never' });

    expect(ds.runs).toHaveLength(1);
    expect(ds.runs[0]).toMatchObject({ id: 'run-1', status: 'partial', errors: ['one error'] });
    expect(ds.exportNotes.some((n) => n.includes('자정 경계'))).toBe(true);
    expect(ds.exportNotes.some((n) => n.startsWith('분류 상태'))).toBe(false); // everything classified
    expect(ds.exportNotes.some((n) => n.startsWith('비활성 수집 원천') && n.includes('x-api') && n.includes('tiktok-research'))).toBe(true);
    expect(ds.exportNotes.some((n) => n.includes('연결된 계정이 아직 수집되지 않아 제외') && n.includes('ghost'))).toBe(true);

    const back = decodeDataset(JSON.parse(JSON.stringify(encodeDataset(ds))) as CompactDataset);
    expect(back).toEqual(ds);
  });

  it('under budget pressure keeps every platform\'s newest uploads and prunes each platform by the same share', () => {
    const s = mem();
    // YouTube: huge view counts; PeerTube / niconico: tiny ones. New uploads have the fewest views everywhere.
    const plans: { platform: RawVideo['platform']; old: number; fresh: number; oldViews: number; freshViews: number }[] = [
      { platform: 'youtube', old: 40, fresh: 10, oldViews: 500_000, freshViews: 5_000 },
      { platform: 'niconico', old: 40, fresh: 10, oldViews: 800, freshViews: 4 },
      { platform: 'peertube', old: 40, fresh: 10, oldViews: 60, freshViews: 1 },
    ];
    for (const plan of plans) {
      const a = acc(plan.platform, `owner-${plan.platform}`, `Owner ${plan.platform}`);
      s.upsertAccount(a, NOW);
      for (let i = 0; i < plan.old + plan.fresh; i++) {
        const fresh = i >= plan.old;
        const publishedAt = fresh ? NOW - (i - plan.old + 1) * 5 * HOUR : NOW - (10 + i) * DAY;
        const { id } = s.upsertVideo(vid(plan.platform, `${plan.platform}-${i}`, a, { publishedAt, title: `영상 ${i}`, description: null }), NOW, plan.platform);
        const base = fresh ? plan.freshViews * (1 + (i - plan.old) / 10) : plan.oldViews * (1 + i); // older index = more views per day
        for (let h = 0; h < 48; h += 3) s.addObservation(id, { t: NOW - h * HOUR, views: Math.round(base + (48 - h)), likes: null, comments: null, shares: null, src: `${plan.platform}@1` });
      }
    }
    const full = buildDatasetDetailed(s, { now: NOW, env: {} });
    const { dataset, stats } = buildDatasetDetailed(s, { now: NOW, env: {}, budgetBytes: Math.round(full.stats.bytes * 0.7) });
    expect(stats.prunedVideos).toBeGreaterThan(0);
    const kept = new Set(dataset.videos.map((v) => v.id));
    for (const plan of plans) {
      // every upload of the last 72 h survives on every platform
      for (let i = plan.old; i < plan.old + plan.fresh; i++) expect(kept.has(`${plan.platform}:${plan.platform}-${i}`)).toBe(true);
    }
    // pruning is spread evenly: no platform loses (almost) everything while another keeps (almost) all
    const prunedBy = (pf: string) => stats.prunedVideoIds.filter((id) => id.startsWith(`${pf}:`)).length;
    const counts = plans.map((pl) => prunedBy(pl.platform));
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
    // within a platform the lowest views per day go first
    expect(kept.has('peertube:peertube-0')).toBe(false);
    expect(kept.has('peertube:peertube-39')).toBe(true);
    const note = dataset.exportNotes.find((n) => n.includes('크기 예산'))!;
    for (const pl of plans) expect(note).toContain(`${pl.platform} ${prunedBy(pl.platform)}/50`);
    expect(note).toContain('최근 7일 안에 게시된 영상 0개');
  });

  it('leaves stored promotional spam and its accounts out of the export, and never exports javascript: URLs', () => {
    const s = mem();
    const clean = acc('dailymotion', 'news1', 'YTN news');
    const spammer = acc('dailymotion', 'ast', 'www.ast8899.com');
    for (const a of [clean, spammer]) s.upsertAccount(a, NOW);
    s.upsertVideo(vid('dailymotion', 'ok', clean, { title: '"가만두면 삼천리에 카지노"...김용범 경질 총공세 / YTN', url: 'javascript:alert(document.domain)//' }), NOW, 'dailymotion');
    s.upsertVideo(vid('dailymotion', 'ad', spammer, { title: '양방 토토 【 공식인증 | AST766.com | 가입코드 7410 】 ✅안전보장메이저', description: '가입*총판문의 GAA56' }), NOW, 'dailymotion');
    const ds = buildDataset(s, { now: NOW, env: {} });
    expect(ds.videos.map((v) => v.id)).toEqual(['dailymotion:ok']);
    expect(ds.accounts.map((a) => a.id)).toEqual(['dailymotion:news1']);
    expect(ds.videos[0].url).toBe('');
    expect(ds.exportNotes.some((n) => n.startsWith('홍보성 스팸') && n.includes('영상 1개') && n.includes('계정 1개'))).toBe(true);
    expect(ds.exportNotes.some((n) => n.includes('http(s)가 아닌 URL'))).toBe(true);
  });

  it('prunes lowest-view stale videos first to fit the byte budget and documents it', () => {
    const s = mem();
    const a = acc('dailymotion', 'owner', 'Owner');
    s.upsertAccount(a, NOW);
    for (let i = 0; i < 40; i++) {
      const stale = i < 20;
      const { id } = s.upsertVideo(vid('dailymotion', `v${String(i).padStart(2, '0')}`, a, { publishedAt: NOW - 30 * DAY }), NOW, 'dailymotion');
      const lastT = stale ? NOW - 10 * DAY : NOW;
      // stale videos have HIGH views, fresh ones low: stale must still go first
      for (let h = 0; h < 72; h++) {
        const t = lastT - h * HOUR;
        s.addObservation(id, { t, views: (stale ? 1_000_000 : 10) + i * 100 + (72 - h), likes: null, comments: null, shares: null, src: 'dailymotion@1' });
      }
    }
    const full = buildDatasetDetailed(s, { now: NOW, env: {} });
    expect(full.stats.prunedVideos).toBe(0);
    const budget = Math.round(full.stats.bytes * 0.6);
    const { dataset, stats } = buildDatasetDetailed(s, { now: NOW, env: {}, budgetBytes: budget });
    expect(stats.prunedVideos).toBeGreaterThan(0);
    expect(stats.bytes).toBeLessThanOrEqual(budget);
    expect(Buffer.byteLength(JSON.stringify(encodeDataset(dataset)))).toBe(stats.bytes);
    const kept = new Set(dataset.videos.map((v) => v.id));
    // all fresh videos kept while stale ones remain to prune
    const staleIds = Array.from({ length: 20 }, (_, i) => `dailymotion:v${String(i).padStart(2, '0')}`);
    const prunedStale = staleIds.filter((id) => !kept.has(id));
    expect(prunedStale.length).toBe(Math.min(20, stats.prunedVideos));
    // lowest-view stale first: pruned stale ids are the lowest indices
    expect(prunedStale).toEqual(staleIds.slice(0, prunedStale.length));
    expect(dataset.exportNotes.some((n) => n.startsWith('분류 상태: 분류되지 않은 영상 40개'))).toBe(true); // not classified here
    const note = dataset.exportNotes.find((n) => n.includes('크기 예산'))!;
    expect(note).toContain(`영상 ${stats.prunedVideos}개`);
    expect(note).toContain('dailymotion');
    expect(dataset.coverage.find((c) => c.source === 'dailymotion')!.videoCount).toBe(dataset.videos.length);
  });

  it('suggestCreators / normalizeAccountName rules', () => {
    expect(normalizeAccountName('  Same Name! ')).toBe('samename');
    expect(normalizeAccountName('ＹＴＮ 뉴스')).toBe('ytn뉴스');
    const out = suggestCreators(
      [
        { id: 'youtube:a', platform: 'youtube', name: 'ab' }, // too short latin
        { id: 'dailymotion:a', platform: 'dailymotion', name: 'AB' },
        { id: 'youtube:b', platform: 'youtube', name: '백종원' },
        { id: 'niconico:b', platform: 'niconico', name: '백 종원' },
        { id: 'youtube:s', platform: 'youtube', name: '쯔양' }, // exact but short: too little evidence without a handle
        { id: 'niconico:s', platform: 'niconico', name: '쯔 양' },
        { id: 'youtube:c', platform: 'youtube', name: 'Solo' },
        { id: 'youtube:d', platform: 'youtube', name: 'Excluded' },
        { id: 'peertube:d', platform: 'peertube', name: 'excluded' },
      ],
      new Set(['youtube:d']),
    );
    expect(out).toHaveLength(1);
    expect(out[0].accountIds).toEqual(['youtube:b', 'niconico:b']);
    expect(out[0].linkStatus).toBe('suggested');
    expect(out[0].note).toContain('자동 제안');
  });

  it('suggestCreators needs more than an exact short or repetitive name, and live accounts', () => {
    const recent = NOW - 10 * DAY;
    const old = NOW - 3000 * DAY;
    const sugg = (accounts: Parameters<typeof suggestCreators>[0]) => suggestCreators(accounts, new Set(), { now: NOW });
    // the real false merge: KR cat channel "haha ha" vs a dormant 2017 Dailymotion account "hahaha" with 0 followers
    expect(
      sugg([
        { id: 'youtube:UCOp66Vup07X0YziXaaxqs2A', platform: 'youtube', name: 'haha ha', handle: '@hahahaYouTube', lastUploadAt: recent, followers: null },
        { id: 'dailymotion:x1lf8d9', platform: 'dailymotion', name: 'hahaha', handle: 'hot37431', lastUploadAt: old, followers: 0 },
      ]),
    ).toEqual([]);
    // distinctive name, but one account is dormant
    expect(
      sugg([
        { id: 'youtube:a', platform: 'youtube', name: 'Paik Jong Won', handle: null, lastUploadAt: recent, followers: null },
        { id: 'dailymotion:a', platform: 'dailymotion', name: 'paikjongwon', handle: 'pjw1', lastUploadAt: old, followers: 3 },
      ]),
    ).toEqual([]);
    // ... alive through its followers
    expect(
      sugg([
        { id: 'youtube:a', platform: 'youtube', name: 'Paik Jong Won', handle: null, lastUploadAt: recent, followers: null },
        { id: 'dailymotion:a', platform: 'dailymotion', name: 'paikjongwon', handle: 'pjw1', lastUploadAt: old, followers: 5000 },
      ]),
    ).toHaveLength(1);
    // a matching handle is enough even for a short name
    const byHandle = sugg([
      { id: 'youtube:t', platform: 'youtube', name: '쯔양', handle: '@tzuyang6145', lastUploadAt: old, followers: null },
      { id: 'dailymotion:t', platform: 'dailymotion', name: '쯔 양', handle: 'TZUYANG6145', lastUploadAt: old, followers: null },
    ]);
    expect(byHandle).toHaveLength(1);
    expect(byHandle[0].note).toContain('핸들도 같음');
  });
});

describe('writeExport', () => {
  it('writes dataset.json + meta.json (and an optional copy) that decode back to the dataset', () => {
    const s = mem();
    populate(s);
    const ds = buildDataset(s, { now: NOW, env: {} });
    const dir = tempDir();
    const copy = join(dir, 'web', 'data', 'dataset.json');
    const res = writeExport(ds, join(dir, 'export'), { copyTo: copy });
    expect(existsSync(res.datasetPath)).toBe(true);
    expect(statSync(res.datasetPath).size).toBe(res.bytes);
    expect(readFileSync(copy, 'utf8')).toBe(readFileSync(res.datasetPath, 'utf8'));
    const meta = JSON.parse(readFileSync(res.metaPath, 'utf8'));
    expect(meta).toMatchObject({ generatedAt: NOW, bytes: res.bytes, counts: { videos: 4, runs: 1, sources: 9 } });
    const back = decodeDataset(JSON.parse(readFileSync(res.datasetPath, 'utf8')) as CompactDataset);
    expect(back).toEqual(ds);
    // overwrite in place works (atomic rename over an existing file)
    const res2 = writeExport(ds, join(dir, 'export'));
    expect(res2.copiedTo).toBeNull();
    expect(readFileSync(res2.datasetPath, 'utf8')).toBe(readFileSync(copy, 'utf8'));
  });
});
