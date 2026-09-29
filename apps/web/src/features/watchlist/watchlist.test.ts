/**
 * Watchlist: storage codec (missing / corrupt / versioned / malformed items / limits), export-import merge,
 * list operations, the store (persistence, blocked storage, backup of unreadable data), "since your last visit"
 * logic, pin growth statuses, and server-render smoke tests of the page and the pin button.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import type { ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { analyzeKeywords, buildIndex } from '@vti/core';
import type { Dataset, MetricValue } from '@vti/core';
import { DatasetContext } from '../../data/context.ts';
import type { DatasetContextValue } from '../../data/context.ts';
import { generateSampleDataset } from '../../../scripts/sample-generator.ts';
import { makeAccount, makeDataset, makeIndex, makeObs, makeVideo, ts } from '../../../../../packages/core/test/fixtures.ts';
import WatchlistPage from '../../pages/Watchlist.tsx';
import {
  addPin,
  cleanKeyword,
  decodeVisit,
  decodeWatchlist,
  emptyVisit,
  emptyWatchlist,
  encodeVisit,
  encodeWatchlist,
  exportWatchlist,
  importSummary,
  isPinned,
  markSeen,
  mergeWatchlists,
  parseWatchlistFile,
  removePin,
  rollVisit,
  sinceLastVisit,
  VISIT_SESSION_GAP_MS,
  WATCH_LIMITS,
  WATCHLIST_BACKUP_KEY,
  WATCHLIST_STORAGE_KEY,
  WATCHLIST_VISIT_KEY,
} from './model.ts';
import type { PinnedVideo, Watchlist } from './model.ts';
import {
  computeWatchCreators,
  computeWatchKeywords,
  computeWatchVideos,
  creatorPinFor,
  pinGrowth,
  sinceVisitStats,
  SPARK_MIN_POINTS,
  sparkRange,
  sparkSeries,
  videoPinFor,
  viewsBaseline,
} from './analysis.ts';
import { getWatchlist, memoryStorage, readVisit, reloadWatchlist, setWatchlistStorage, updateWatchlist } from './store.ts';
import type { WatchStorage } from './store.ts';
import { WatchButton } from './WatchButton.tsx';

const HOUR = 3_600_000;
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

function list(partial: Partial<Watchlist> = {}): Watchlist {
  return { ...emptyWatchlist(), ...partial };
}

function videoPin(id: string, extra: Partial<PinnedVideo> = {}): PinnedVideo {
  return { id, title: id, platform: 'youtube', accountName: null, pinnedAt: 1, dataNow: 1, baseline: null, ...extra };
}

/* ------------------------------------------------------------------------------------------ codec */

describe('watchlist storage codec', () => {
  it('treats missing / empty storage as an empty list', () => {
    for (const raw of [null, undefined, '', '   ']) {
      const r = decodeWatchlist(raw);
      expect(r.status).toBe('empty');
      expect(r.list).toEqual(emptyWatchlist());
    }
  });

  it('reports corrupt data instead of throwing', () => {
    for (const raw of ['{not json', '[]', '"x"', '42', 'null', '{"creators":[]}', '{"version":"1"}', '{"version":0}']) {
      const r = decodeWatchlist(raw);
      expect(r.status, raw).toBe(raw === 'null' ? 'empty' : 'corrupt');
      expect(r.list.creators).toEqual([]);
    }
  });

  it('refuses a document written by a newer version (never rewrites it silently)', () => {
    const r = decodeWatchlist(JSON.stringify({ version: 2, creators: [{ key: 'a' }] }));
    expect(r.status).toBe('unsupported_version');
    expect(r.list.creators).toEqual([]);
  });

  it('round-trips a valid document', () => {
    const l = list({
      creators: [{ key: 'channel-a', name: '채널A', platforms: ['youtube', 'dailymotion'], pinnedAt: 10, dataNow: 5 }],
      videos: [videoPin('youtube:abc', { baseline: { value: 120, t: 4, src: 'youtube-rss@1' } })],
      keywords: [{ kw: '추석', pinnedAt: 11, dataNow: 5 }],
      updatedAt: 11,
    });
    const r = decodeWatchlist(encodeWatchlist(l));
    expect(r.status).toBe('ok');
    expect(r.list).toEqual(l);
    expect(r.dropped).toBe(0);
  });

  it('drops malformed and duplicated items one by one and counts them', () => {
    const raw = JSON.stringify({
      version: 1,
      creators: [{ key: 'a', name: 'A', platforms: ['youtube', 'myspace'] }, { key: '' }, 'x', { key: 'a' }],
      videos: [{ id: 'youtube:1', baseline: { value: -5, t: 1 } }, { id: 'no-namespace' }, { id: 'youtube:1' }],
      keywords: [{ kw: '  먹방   브이로그 ' }, { kw: '먹방 브이로그' }, { kw: '   ' }, { kw: 3 }],
    });
    const r = decodeWatchlist(raw);
    expect(r.status).toBe('ok');
    expect(r.list.creators).toEqual([{ key: 'a', name: 'A', platforms: ['youtube'], pinnedAt: null, dataNow: null }]);
    expect(r.list.videos.map((v) => v.id)).toEqual(['youtube:1']);
    expect(r.list.videos[0].baseline).toBeNull(); // negative views are not a baseline
    expect(r.list.keywords.map((k) => k.kw)).toEqual(['먹방 브이로그']);
    expect(r.dropped).toBe(3 + 2 + 3);
  });

  it('caps each list and reports what was cut', () => {
    const keywords = Array.from({ length: WATCH_LIMITS.keyword + 5 }, (_, i) => ({ kw: `k${i}` }));
    const r = decodeWatchlist(JSON.stringify({ version: 1, keywords }));
    expect(r.list.keywords).toHaveLength(WATCH_LIMITS.keyword);
    expect(r.truncated).toBe(5);
  });
});

describe('export / import', () => {
  const base = list({ videos: [videoPin('youtube:a', { baseline: { value: 10, t: 1, src: null } })], keywords: [{ kw: '추석', pinnedAt: 1, dataNow: 1 }] });

  it('exports an envelope that imports back', () => {
    const file = JSON.stringify(exportWatchlist(base, 99));
    const r = parseWatchlistFile(`\uFEFF${file}`);
    expect(r.status).toBe('ok');
    expect(r.list.videos).toEqual(base.videos);
    expect(r.list.keywords).toEqual(base.keywords);
  });

  it('rejects other JSON files and broken files', () => {
    expect(parseWatchlistFile(JSON.stringify({ format: 'something-else', version: 1 })).status).toBe('wrong_format');
    expect(parseWatchlistFile('{').status).toBe('corrupt');
    expect(parseWatchlistFile('null').status).toBe('corrupt');
  });

  it('merges: existing pins keep their baseline, new ones are added, duplicates counted', () => {
    const incoming = list({
      videos: [videoPin('youtube:a', { baseline: { value: 999, t: 5, src: null } }), videoPin('youtube:b')],
      keywords: [{ kw: '추 석', pinnedAt: 2, dataNow: 2 }, { kw: '추석', pinnedAt: 2, dataNow: 2 }],
      creators: [{ key: 'c', name: 'C', platforms: [], pinnedAt: 2, dataNow: 2 }],
    });
    const m = mergeWatchlists(base, incoming, 50);
    expect(m.added).toEqual({ creator: 1, video: 1, keyword: 1 });
    expect(m.duplicates).toBe(2);
    expect(m.list.videos.find((v) => v.id === 'youtube:a')?.baseline?.value).toBe(10);
    expect(m.list.updatedAt).toBe(50);
    expect(importSummary(m)).toContain('크리에이터 1개 · 영상 1개 · 키워드 1개 추가');
    // Nothing new -> the same object (no write needed).
    expect(mergeWatchlists(base, base).list).toBe(base);
  });
});

describe('list operations', () => {
  it('adds newest first, refuses duplicates, removes; keywords compare case/space-insensitively', () => {
    let l = emptyWatchlist();
    l = addPin(l, { kind: 'keyword', value: { kw: 'BTS', pinnedAt: 1, dataNow: 1 } }).list;
    const again = addPin(l, { kind: 'keyword', value: { kw: 'bts', pinnedAt: 2, dataNow: 2 } });
    expect(again.outcome).toBe('exists');
    expect(again.list).toBe(l);
    l = addPin(l, { kind: 'keyword', value: { kw: '먹방', pinnedAt: 2, dataNow: 2 } }).list;
    expect(l.keywords.map((k) => k.kw)).toEqual(['먹방', 'BTS']);
    expect(isPinned(l, 'keyword', ' bts ')).toBe(true);
    // The keyword page reads `kw` as a comma list: pinned keywords never carry commas.
    expect(cleanKeyword(' 먹방,  브이로그，ASMR ')).toBe('먹방 브이로그 ASMR');
    // Same identity / length rules as the keyword page: '#먹방' is '먹방', and a 100-character keyword the page can
    // analyze is pinned unchanged (the pin button on that page must see it as pinned).
    expect(isPinned(l, 'keyword', '#먹방')).toBe(true);
    const long = '가'.repeat(99) + 'a';
    expect(cleanKeyword(long)).toBe(long);
    const pinnedLong = addPin(l, { kind: 'keyword', value: { kw: long, pinnedAt: 3, dataNow: 3 } }).list;
    expect(isPinned(pinnedLong, 'keyword', long)).toBe(true);
    expect(cleanKeyword('😀'.repeat(60))).toBe('😀'.repeat(50)); // never cut inside a surrogate pair
    l = removePin(l, 'keyword', 'Bts');
    expect(l.keywords.map((k) => k.kw)).toEqual(['먹방']);
    expect(removePin(l, 'video', 'youtube:none')).toBe(l);
    expect(addPin(l, { kind: 'video', value: videoPin('bad id') }).outcome).toBe('invalid');
  });

  it('stops at the limit', () => {
    const full = list({ creators: Array.from({ length: WATCH_LIMITS.creator }, (_, i) => ({ key: `c${i}`, name: `c${i}`, platforms: [], pinnedAt: 1, dataNow: 1 })) });
    expect(addPin(full, { kind: 'creator', value: { key: 'new', name: 'n', platforms: [], pinnedAt: 1, dataNow: 1 } }).outcome).toBe('limit');
  });
});

/* ------------------------------------------------------------------------------------------ store */

describe('watchlist store', () => {
  let prev: WatchStorage;
  beforeEach(() => {
    prev = setWatchlistStorage(memoryStorage());
  });
  afterEach(() => {
    setWatchlistStorage(prev);
  });

  it('persists changes under the versioned key', () => {
    const mem = memoryStorage();
    setWatchlistStorage(mem);
    updateWatchlist((l) => addPin(l, { kind: 'keyword', value: { kw: '야구', pinnedAt: 1, dataNow: 1 } }).list);
    expect(JSON.parse(mem.dump()[WATCHLIST_STORAGE_KEY]).version).toBe(1);
    expect(reloadWatchlist().list.keywords.map((k) => k.kw)).toEqual(['야구']);
  });

  it('backs up unreadable data before the first overwrite', () => {
    const mem = memoryStorage({ [WATCHLIST_STORAGE_KEY]: '{broken' });
    setWatchlistStorage(mem);
    expect(getWatchlist().status).toBe('corrupt');
    updateWatchlist((l) => addPin(l, { kind: 'keyword', value: { kw: 'a', pinnedAt: 1, dataNow: 1 } }).list);
    expect(mem.dump()[WATCHLIST_BACKUP_KEY]).toBe('{broken');
    expect(getWatchlist().status).toBe('ok');
  });

  it('keeps working in memory when storage is blocked', () => {
    setWatchlistStorage(memoryStorage({}, true));
    expect(getWatchlist().persistent).toBe(false);
    updateWatchlist((l) => addPin(l, { kind: 'keyword', value: { kw: 'a', pinnedAt: 1, dataNow: 1 } }).list);
    expect(getWatchlist().list.keywords).toHaveLength(1);
    expect(getWatchlist().persistent).toBe(false);
  });

  it('reads a missing / corrupt visit record as no visit', () => {
    setWatchlistStorage(memoryStorage({ [WATCHLIST_VISIT_KEY]: 'nope' }));
    expect(readVisit()).toEqual(emptyVisit());
  });
});

/* ------------------------------------------------------------------------------------------ visits */

describe('since your last visit', () => {
  const GAP = VISIT_SESSION_GAP_MS;

  it('first visit has no reference', () => {
    const s = rollVisit(emptyVisit(), { at: 1_000, dataNow: 500 });
    expect(s.baseline).toBeNull();
    expect(s.last).toEqual({ at: 1_000, dataNow: 500 });
    expect(sinceLastVisit(s, 500).kind).toBe('first_visit');
  });

  it('a later session compares against the previous view, by data time', () => {
    const first = rollVisit(emptyVisit(), { at: 0, dataNow: 100 });
    const second = rollVisit(first, { at: GAP + 1, dataNow: 400 });
    expect(second.baseline).toEqual({ at: 0, dataNow: 100 });
    expect(sinceLastVisit(second, 400)).toEqual({ kind: 'since', since: 100, visitAt: 0 });
  });

  it('reloads inside a session keep the baseline stable', () => {
    const a = rollVisit(rollVisit(emptyVisit(), { at: 0, dataNow: 100 }), { at: GAP, dataNow: 400 });
    const b = rollVisit(a, { at: GAP + 60_000, dataNow: 700 });
    expect(b.baseline).toEqual(a.baseline);
    expect(b.last).toEqual({ at: GAP + 60_000, dataNow: 700 });
    // A clock that went backwards does not start a new visit either.
    expect(rollVisit(b, { at: 5, dataNow: 700 }).baseline).toEqual(a.baseline);
  });

  it('no new data since the last visit is not "0 new"', () => {
    const s = rollVisit(rollVisit(emptyVisit(), { at: 0, dataNow: 400 }), { at: GAP, dataNow: 400 });
    expect(sinceLastVisit(s, 400).kind).toBe('no_new_data');
  });

  it('mark all seen makes the current view the reference', () => {
    const s = markSeen({ at: 9, dataNow: 400 });
    expect(sinceLastVisit(s, 400).kind).toBe('no_new_data');
    expect(decodeVisit(encodeVisit(s))).toEqual(s);
    expect(decodeVisit('{"version":1,"last":{"at":"x"}}')).toEqual(emptyVisit());
  });
});

/* ------------------------------------------------------------------------------------------ analytics */

describe('watchlist analytics', () => {
  const now = ts('2026-09-28T12:00');
  const since = ts('2026-09-28T06:00');
  const acc = makeAccount({ id: 'youtube:UCw', name: '관심 채널' });
  const old = makeVideo({
    id: 'youtube:old',
    accountId: acc.id,
    title: '추석 특집 먹방',
    publishedAt: ts('2026-09-20T00:00'),
    obs: [makeObs(ts('2026-09-28T00:00'), 1000), makeObs(ts('2026-09-28T06:00'), 1500), makeObs(ts('2026-09-28T11:30'), 2100)],
  });
  const fresh = makeVideo({
    id: 'youtube:fresh',
    accountId: acc.id,
    title: '추석 브이로그',
    publishedAt: ts('2026-09-28T08:00'),
    obs: [makeObs(ts('2026-09-28T11:30'), 300)],
  });
  const late = makeVideo({
    id: 'youtube:late',
    accountId: acc.id,
    title: '늦게 발견',
    publishedAt: ts('2026-09-27T00:00'),
    firstSeenAt: ts('2026-09-28T09:00'),
    obs: [makeObs(ts('2026-09-28T09:00'), 50)],
  });
  const ds: Dataset = makeDataset({ generatedAt: now, accounts: [acc], videos: [old, fresh, late] });
  const index = buildIndex(ds);

  it('counts new uploads, late discoveries and the view increase since the reference', () => {
    const s = sinceVisitStats([old, fresh, late], since, now);
    expect(s.newUploads).toBe(1);
    expect(s.lateFound).toBe(1);
    expect(s.recent.map((v) => v.id)).toEqual(['youtube:fresh']);
    // old: 2100 - 1500 = 600 (exact), fresh: 300 (published after since), late: unknown start -> lower bound overall.
    expect(s.views.value).toBeGreaterThanOrEqual(900);
    expect(s.views.status).toBe('lower_bound');
  });

  it('pin growth: stored baseline vs the latest observation, with honest statuses', () => {
    const base = viewsBaseline(old, ts('2026-09-28T06:00'));
    expect(base).toEqual({ value: 1500, t: ts('2026-09-28T06:00'), src: 'test@1' });
    // Last observation 10 min before the data time: exact (within min(2h, 5% of the span since the pin)).
    expect(pinGrowth(old, { baseline: base, dataNow: ts('2026-09-28T06:00') }, ts('2026-09-28T11:40'))).toMatchObject({ value: 600, status: 'exact' });
    // 30 min before a 6h span's end is beyond that tolerance: views after it are unknown, so a lower bound.
    expect(pinGrowth(old, { baseline: base, dataNow: ts('2026-09-28T06:00') }, now)).toMatchObject({ value: 600, status: 'lower_bound' });
    // No observation after the pin: unknown, not 0.
    expect(pinGrowth(old, { baseline: { value: 2100, t: ts('2026-09-28T11:30'), src: null }, dataNow: now }, now)).toMatchObject({ value: null, status: 'unavailable' });
    // Counter went down: flagged, never ranked as negative popularity.
    expect(pinGrowth(old, { baseline: { value: 5000, t: ts('2026-09-28T00:00') - HOUR, src: null }, dataNow: 0 }, now).status).toBe('decrease_flagged');
    // Last observation older than the tolerance: a lower bound.
    expect(pinGrowth(old, { baseline: { value: 1000, t: ts('2026-09-28T00:00'), src: null }, dataNow: 0 }, now + 5 * HOUR)).toMatchObject({ value: 1100, status: 'lower_bound' });
    // Video gone from the dataset.
    expect(pinGrowth(null, { baseline: base, dataNow: 0 }, now).status).toBe('unavailable');
    // No baseline: core increment over [pin data time, now).
    expect(pinGrowth(old, { baseline: null, dataNow: ts('2026-09-28T06:00') }, now)).toMatchObject({ value: 600, status: 'lower_bound' });
    expect(pinGrowth(old, { baseline: null, dataNow: ts('2026-09-28T06:00') }, ts('2026-09-28T11:40'))).toMatchObject({ value: 600, status: 'exact' });
  });

  it('builds pins with the latest known observation', () => {
    const pin = videoPinFor(index, 'youtube:old', now, 123);
    expect(pin).toMatchObject({ id: 'youtube:old', title: '추석 특집 먹방', platform: 'youtube', accountName: '관심 채널', pinnedAt: 123, dataNow: now });
    expect(pin.baseline?.value).toBe(2100);
    expect(videoPinFor(index, 'youtube:gone', now, 1)).toMatchObject({ baseline: null, platform: 'youtube' });
    expect(creatorPinFor(index, acc.id, now, 1)).toMatchObject({ key: acc.id, name: '관심 채널', platforms: ['youtube'] });
  });

  it('computes pinned video rows (missing videos stay visible)', () => {
    const r = computeWatchVideos(index, {
      pins: [{ id: 'youtube:old', baseline: { value: 1500, t: since, src: null }, dataNow: since }, { id: 'youtube:gone', baseline: null, dataNow: since }],
      now,
      since,
    });
    expect(r.rows[0]).toMatchObject({ id: 'youtube:old', accountName: '관심 채널' });
    expect(r.rows[0].growth.value).toBe(600);
    expect(r.rows[0].current).toMatchObject({ value: 2100, status: 'exact' }); // 30 min off, within the 2h snap
    expect(r.rows[1].video).toBeNull();
    expect(r.rows[1].growth.status).toBe('unavailable');
  });

  it('computes creator cards and keyword rows', () => {
    const c = computeWatchCreators(index, { keys: [acc.id, 'nobody'], range: { start: '2026-09-22', end: '2026-09-28' }, rollingHours: 168, tz: 'Asia/Seoul', now, since });
    expect(c.rows[0]).toMatchObject({ found: true, name: '관심 채널' });
    expect(c.rows[0].summary?.uploadsInWindow).toBe(2);
    expect(c.rows[0].since?.newUploads).toBe(1);
    expect(c.rows[0].daily.length).toBe(7);
    expect(c.rows[1]).toMatchObject({ found: false, summary: null });

    const k = computeWatchKeywords(index, { keywords: ['추석', '없는말'], range: { start: '2026-09-22', end: '2026-09-28' }, rollingHours: 168, tz: 'Asia/Seoul', now, since });
    // '추석' matches two videos; only the fresh one was published inside the last 168 hours.
    expect(k.rows[0]).toMatchObject({ kw: '추석', total: 2, uploadsInWindow: 1 });
    expect(k.rows[0].since?.newUploads).toBe(1);
    expect(k.rows[1]).toMatchObject({ total: 0, uploadsInWindow: 0 });
    expect(k.rows[1].viewsInWindow.status).not.toBe('lower_bound');
    // No matching video: the view sums are unknown ('—'), never an exact 0 (same as the keyword page).
    expect(k.rows[1].viewsInWindow).toMatchObject({ value: null, status: 'unavailable', note: 'no_tracked_videos' });
    expect(k.rows[1].since?.views).toMatchObject({ value: null, status: 'unavailable', note: 'no_tracked_videos' });
    const none = analyzeKeywords(index, { keywords: ['없는말'], range: { start: '2026-09-22', end: '2026-09-28' }, rollingHours: 168, tz: 'Asia/Seoul', now });
    expect(none.keywords[0].viewsPeriod).toMatchObject({ value: k.rows[1].viewsInWindow.value, status: k.rows[1].viewsInWindow.status });
    // Same counts as the keyword page (core analyzeKeywords with its defaults), which the row links to.
    const page = analyzeKeywords(index, { keywords: ['추석'], range: { start: '2026-09-22', end: '2026-09-28' }, rollingHours: 168, tz: 'Asia/Seoul', now });
    expect(page.keywords[0]).toMatchObject({ videos: k.rows[0].total, uploadsInWindow: k.rows[0].uploadsInWindow });
  });

  it('sparkline: the unfinished day and unknown days are gaps, never 0; few points fall back to numbers', () => {
    const m = (value: number | null, status: MetricValue['status'], note: string | null = null): MetricValue => ({ value, status, asOf: null, note });
    const s = sparkSeries([
      { date: '2026-09-26', metric: m(null, 'unavailable', 'before_first_observation') },
      { date: '2026-09-27', metric: m(120, 'lower_bound', 'partial') },
      { date: '2026-09-28', metric: m(5, 'decrease_flagged', 'counter_decreased') },
      { date: '2026-09-29', metric: m(40, 'lower_bound', null) },
    ], '2026-09-29');
    expect(s.values).toEqual([null, 120, null]);
    expect(s.labels).toEqual(['2026-09-26', '2026-09-27', '2026-09-28']);
    expect(s.measured).toBe(1);
    expect(s.measured).toBeLessThan(SPARK_MIN_POINTS);
    expect(s.recent.map((d) => [d.date, d.partial])).toEqual([
      ['2026-09-27', false],
      ['2026-09-29', true],
    ]);
  });

  it('widens short sparkline ranges to a week', () => {
    expect(sparkRange({ start: '2026-09-28', end: '2026-09-28' })).toEqual({ start: '2026-09-22', end: '2026-09-28' });
    expect(sparkRange({ start: '2026-09-01', end: '2026-09-28' })).toEqual({ start: '2026-09-01', end: '2026-09-28' });
  });

  it('first visit: no since stats', () => {
    const c = computeWatchCreators(makeIndex({ generatedAt: now, videos: [old] }), { keys: ['youtube:UCw'], range: { start: '2026-09-28', end: '2026-09-28' }, rollingHours: 24, tz: 'UTC', now, since: null });
    expect(c.rows[0].since).toBeNull();
  });
});

/* ------------------------------------------------------------------------------------------ server render */

describe('watchlist page (server render)', () => {
  const sample = generateSampleDataset({ videos: 400 });
  const value: DatasetContextValue = {
    dataset: sample,
    index: buildIndex(sample),
    now: sample.generatedAt,
    // Real-data mode so visits are recorded / compared (the page never records visits on sample data).
    isSample: false,
    tz: 'Asia/Seoul',
    setTz: () => undefined,
    source: { url: './data/dataset.json', bytes: 0, fallbackReason: null, loadedAt: 0 },
    reload: () => undefined,
  };
  const render = (Page: ComponentType, url = '/watchlist') =>
    renderToStaticMarkup(h(DatasetContext.Provider, { value }, h(MemoryRouter, { initialEntries: [url] }, h(Routes, null, h(Route, { path: '/watchlist', element: h(Page) })))));

  let prev: WatchStorage;
  beforeEach(() => {
    prev = setWatchlistStorage(memoryStorage());
  });
  afterEach(() => {
    setWatchlistStorage(prev);
  });

  it('explains how to pin when the list is empty', () => {
    const t = text(render(WatchlistPage));
    expect(t).toContain('관심 목록');
    expect(t).toContain('관심 목록이 비어 있음');
    expect(t).toContain('이 브라우저에만 저장');
    expect(t).toContain('관심 목록에 추가');
    expect(t).toContain('키워드 바로 고정');
  });

  it('renders pinned creators, videos and keywords with links', () => {
    const creator = sample.creators[0];
    const video = sample.videos.find((v) => v.obs.length > 1)!;
    const now = sample.generatedAt;
    const stored = list({
      creators: [creatorPinFor(value.index, creator.id, now, 1)],
      videos: [videoPinFor(value.index, video.id, now - 24 * HOUR, 1)],
      keywords: [{ kw: '추석', pinnedAt: 1, dataNow: now }],
    });
    setWatchlistStorage(
      memoryStorage({
        [WATCHLIST_STORAGE_KEY]: encodeWatchlist(stored),
        // A previous visit long ago (a new session now): "since your last visit" is shown.
        [WATCHLIST_VISIT_KEY]: encodeVisit({ version: 1, last: { at: 0, dataNow: now - 24 * HOUR }, baseline: null }),
      }),
    );
    const html = render(WatchlistPage);
    const t = text(html);
    expect(t).toContain(creator.name);
    expect(t).toContain('고정한 크리에이터 비교');
    expect(html).toContain(`href="/compare?keys=${creator.id}`);
    expect(html).toContain('href="/keywords?kw=');
    expect(t).toContain('고정 이후 증가');
    expect(t).toContain('지난 방문 이후');
    expect(t).toContain('모두 확인함');
    expect(t).not.toContain('관심 목록이 비어 있음');
    const escaped = video.title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    expect(html).toContain(escaped);
  });

  it('warns when the stored list could not be read', () => {
    setWatchlistStorage(memoryStorage({ [WATCHLIST_STORAGE_KEY]: '{bad' }));
    expect(text(render(WatchlistPage))).toContain('저장된 관심 목록을 읽지 못함');
  });

  it('the pin button reflects the stored state (aria-pressed)', () => {
    const renderButton = () =>
      renderToStaticMarkup(h(DatasetContext.Provider, { value }, h(MemoryRouter, null, h(WatchButton, { kind: 'keyword', id: '추석' }))));
    expect(renderButton()).toContain('aria-pressed="false"');
    updateWatchlist((l) => addPin(l, { kind: 'keyword', value: { kw: '추석', pinnedAt: 1, dataNow: 1 } }).list);
    const html = renderButton();
    expect(html).toContain('aria-pressed="true"');
    expect(text(html)).toContain('관심 목록에 있음');
  });
});
