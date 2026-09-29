/**
 * Watchlist (관심 목록, Tubular Viewpoint "my content / competitors") — pure model, tested in watchlist.test.ts.
 *
 * - What is stored: pinned creators (portfolio keys), videos (with the views observation seen when pinned) and
 *   keywords. Per viewer, in this browser's localStorage only (see store.ts); never sent anywhere.
 * - Versioned codec: the document carries `version: 1` under a versioned key (`vti.watchlist.v1`). Anything that
 *   does not parse is reported ('corrupt' / 'unsupported_version') instead of being silently replaced; invalid
 *   items are dropped one by one and counted; lists are capped (WATCH_LIMITS) and the cap is reported.
 * - Export / import: the same document wrapped in an envelope (`format: 'vti-watchlist'`) so a list can move
 *   between browsers as a JSON file. Import merges (existing pins win, so their pin-time baseline is kept).
 * - "Since your last visit": the page remembers the data time (`dataset.generatedAt`) of the viewer's previous
 *   visit. A visit after a pause of VISIT_SESSION_GAP_MS or more starts a new session and makes the previous
 *   visit the comparison baseline; reloads inside a session keep the baseline stable.
 */
import { MAX_KEYWORD_CHARS, normalizeText, PLATFORMS } from '@vti/core';
import type { Platform } from '@vti/core';

export const WATCHLIST_VERSION = 1;
/** localStorage keys (lib/storage.ts adds the `vti.` prefix). */
export const WATCHLIST_STORAGE_KEY = 'watchlist.v1';
export const WATCHLIST_VISIT_KEY = 'watchlist.visit.v1';
/** A stored document that could not be read is copied here once before the first overwrite. */
export const WATCHLIST_BACKUP_KEY = 'watchlist.v1.unreadable';
export const WATCHLIST_EXPORT_FORMAT = 'vti-watchlist';

export type WatchKind = 'creator' | 'video' | 'keyword';

/** Caps keep localStorage small; anything cut is reported (no silent caps). */
export const WATCH_LIMITS: Record<WatchKind, number> = { creator: 100, video: 300, keyword: 100 };
/** Same limit as the keyword page / core (MAX_KEYWORD_CHARS, UTF-16 units): any analyzed keyword can be pinned unchanged. */
export const KEYWORD_MAX_LENGTH = MAX_KEYWORD_CHARS;
const TEXT_MAX = 300;

export interface PinnedCreator {
  /** Portfolio key: creator id or account id (`/creators/:key`). */
  key: string;
  /** Name when pinned (shown when the key is no longer in the dataset). */
  name: string;
  platforms: Platform[];
  /** Wall-clock time of the pin (ms). */
  pinnedAt: number | null;
  /** Data time (dataset.generatedAt) when pinned. */
  dataNow: number | null;
}

/** The views observation that was the latest one known when a video was pinned. */
export interface ViewsBaseline {
  value: number;
  /** Observation time (UTC ms). */
  t: number;
  /** Source adapter of that observation. */
  src: string | null;
}

export interface PinnedVideo {
  id: string;
  title: string;
  platform: Platform | null;
  accountName: string | null;
  pinnedAt: number | null;
  dataNow: number | null;
  /** null when no views observation existed when pinned (counter not provided / not observed yet). */
  baseline: ViewsBaseline | null;
}

export interface PinnedKeyword {
  kw: string;
  pinnedAt: number | null;
  dataNow: number | null;
}

export interface Watchlist {
  version: 1;
  /** Newest pin first. */
  creators: PinnedCreator[];
  videos: PinnedVideo[];
  keywords: PinnedKeyword[];
  updatedAt: number | null;
}

export function emptyWatchlist(): Watchlist {
  return { version: 1, creators: [], videos: [], keywords: [], updatedAt: null };
}

export function watchlistSize(w: Watchlist): number {
  return w.creators.length + w.videos.length + w.keywords.length;
}

/* ------------------------------------------------------------------------------------------ codec */

export type DecodeStatus = 'empty' | 'ok' | 'corrupt' | 'unsupported_version' | 'wrong_format';

export interface DecodeResult {
  list: Watchlist;
  status: DecodeStatus;
  /** Items dropped because they were malformed or duplicated. */
  dropped: number;
  /** Items cut by WATCH_LIMITS. */
  truncated: number;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function finiteOrNull(x: unknown): number | null {
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}

function cleanText(x: unknown, max = TEXT_MAX): string | null {
  if (typeof x !== 'string') return null;
  const s = x.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

function isPlatformValue(x: unknown): x is Platform {
  return typeof x === 'string' && (PLATFORMS as readonly string[]).includes(x);
}

/**
 * Collapsed-whitespace keyword (≤ KEYWORD_MAX_LENGTH UTF-16 units, never cut inside a character), or null when
 * empty. Commas become spaces: the keyword page takes `kw` as a comma list (its input also splits on '，'), so a
 * pinned keyword must never contain one. Any keyword the keyword page analyzes comes out unchanged.
 */
export function cleanKeyword(raw: string): string | null {
  const s = raw.replace(/[\u0000-\u001f\u007f,，]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  let out = '';
  for (const ch of s) {
    if (out.length + ch.length > KEYWORD_MAX_LENGTH) break;
    out += ch;
  }
  return out.trim() || null;
}

/**
 * Identity of a keyword for de-duplication: the keyword page's rule (core normalizeKeywordList: NFKC, case, spacing,
 * a leading '#' dropped), so '#먹방' and '먹방' are one pin there and here.
 */
export function keywordKey(kw: string): string {
  return normalizeText(kw).replace(/^#+/, '') || kw.trim().toLowerCase();
}

/** Video ids are namespaced `${platform}:${nativeId}`. */
function isVideoId(x: unknown): x is string {
  return typeof x === 'string' && x.length <= 200 && /^[a-z]+:\S+$/.test(x);
}

function decodeCreator(x: unknown): PinnedCreator | null {
  if (!isRecord(x)) return null;
  const key = cleanText(x.key, 200);
  if (!key) return null;
  const platforms = Array.isArray(x.platforms) ? PLATFORMS.filter((p) => (x.platforms as unknown[]).includes(p)) : [];
  return { key, name: cleanText(x.name) ?? key, platforms, pinnedAt: finiteOrNull(x.pinnedAt), dataNow: finiteOrNull(x.dataNow) };
}

function decodeBaseline(x: unknown): ViewsBaseline | null {
  if (!isRecord(x)) return null;
  const value = finiteOrNull(x.value);
  const t = finiteOrNull(x.t);
  if (value === null || t === null || value < 0) return null;
  return { value, t, src: cleanText(x.src, 80) };
}

function decodeVideo(x: unknown): PinnedVideo | null {
  if (!isRecord(x) || !isVideoId(x.id)) return null;
  return {
    id: x.id,
    title: cleanText(x.title) ?? '',
    platform: isPlatformValue(x.platform) ? x.platform : null,
    accountName: cleanText(x.accountName, 200),
    pinnedAt: finiteOrNull(x.pinnedAt),
    dataNow: finiteOrNull(x.dataNow),
    baseline: decodeBaseline(x.baseline),
  };
}

function decodeKeyword(x: unknown): PinnedKeyword | null {
  if (!isRecord(x) || typeof x.kw !== 'string') return null;
  const kw = cleanKeyword(x.kw);
  if (!kw) return null;
  return { kw, pinnedAt: finiteOrNull(x.pinnedAt), dataNow: finiteOrNull(x.dataNow) };
}

function decodeList<T>(raw: unknown, decode: (x: unknown) => T | null, idOf: (t: T) => string, limit: number): { items: T[]; dropped: number; truncated: number } {
  if (!Array.isArray(raw)) return { items: [], dropped: raw === undefined ? 0 : 1, truncated: 0 };
  const items: T[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  let truncated = 0;
  for (const x of raw) {
    const item = decode(x);
    if (!item) {
      dropped++;
      continue;
    }
    const id = idOf(item);
    if (seen.has(id)) {
      dropped++;
      continue;
    }
    if (items.length >= limit) {
      truncated++;
      continue;
    }
    seen.add(id);
    items.push(item);
  }
  return { items, dropped, truncated };
}

/**
 * Decode an already-parsed value (the stored document or an imported file). Accepts the bare document and the
 * export envelope. `version` must be 1: a higher version comes from a newer app build and is never rewritten.
 */
export function decodeWatchlistValue(value: unknown): DecodeResult {
  const fail = (status: DecodeStatus): DecodeResult => ({ list: emptyWatchlist(), status, dropped: 0, truncated: 0 });
  if (value === null || value === undefined) return fail('empty');
  if (!isRecord(value)) return fail('corrupt');
  if (value.format !== undefined && value.format !== WATCHLIST_EXPORT_FORMAT) return fail('wrong_format');
  const version = value.version;
  if (typeof version === 'number' && Number.isInteger(version) && version > WATCHLIST_VERSION) return fail('unsupported_version');
  if (version !== WATCHLIST_VERSION) return fail('corrupt');
  const c = decodeList(value.creators, decodeCreator, (x) => x.key, WATCH_LIMITS.creator);
  const v = decodeList(value.videos, decodeVideo, (x) => x.id, WATCH_LIMITS.video);
  const k = decodeList(value.keywords, decodeKeyword, (x) => keywordKey(x.kw), WATCH_LIMITS.keyword);
  return {
    list: { version: 1, creators: c.items, videos: v.items, keywords: k.items, updatedAt: finiteOrNull(value.updatedAt) },
    status: 'ok',
    dropped: c.dropped + v.dropped + k.dropped,
    truncated: c.truncated + v.truncated + k.truncated,
  };
}

/** Decode the raw localStorage string (null = nothing stored). */
export function decodeWatchlist(raw: string | null | undefined): DecodeResult {
  if (raw === null || raw === undefined || raw.trim() === '') return { list: emptyWatchlist(), status: 'empty', dropped: 0, truncated: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { list: emptyWatchlist(), status: 'corrupt', dropped: 0, truncated: 0 };
  }
  return decodeWatchlistValue(parsed);
}

export function encodeWatchlist(list: Watchlist): string {
  const { creators, videos, keywords, updatedAt } = list;
  return JSON.stringify({ version: WATCHLIST_VERSION, creators, videos, keywords, updatedAt });
}

export const DECODE_STATUS_MESSAGES: Record<Exclude<DecodeStatus, 'ok' | 'empty'>, string> = {
  corrupt: '저장된 관심 목록을 읽지 못함 (형식이 손상됨).',
  unsupported_version: '더 새로운 버전의 앱에서 저장한 관심 목록이라 이 버전에서는 읽지 않음.',
  wrong_format: '관심 목록 파일이 아님.',
};

/* ------------------------------------------------------------------------------------------ export / import */

export interface WatchlistExport {
  format: typeof WATCHLIST_EXPORT_FORMAT;
  version: 1;
  exportedAt: number;
  creators: PinnedCreator[];
  videos: PinnedVideo[];
  keywords: PinnedKeyword[];
  updatedAt: number | null;
}

export function exportWatchlist(list: Watchlist, at: number): WatchlistExport {
  return { format: WATCHLIST_EXPORT_FORMAT, version: 1, exportedAt: at, creators: list.creators, videos: list.videos, keywords: list.keywords, updatedAt: list.updatedAt };
}

/** Parse an imported file's text (JSON). */
export function parseWatchlistFile(text: string): DecodeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    return { list: emptyWatchlist(), status: 'corrupt', dropped: 0, truncated: 0 };
  }
  if (parsed === null) return { list: emptyWatchlist(), status: 'corrupt', dropped: 0, truncated: 0 };
  return decodeWatchlistValue(parsed);
}

export interface MergeResult {
  list: Watchlist;
  added: Record<WatchKind, number>;
  /** Already pinned (the existing pin and its baseline are kept). */
  duplicates: number;
  /** Not added because the list was full. */
  overLimit: number;
}

function mergeKind<T>(base: T[], incoming: T[], idOf: (t: T) => string, limit: number): { items: T[]; added: number; duplicates: number; overLimit: number } {
  const ids = new Set(base.map(idOf));
  const items = [...base];
  let added = 0;
  let duplicates = 0;
  let overLimit = 0;
  for (const it of incoming) {
    const id = idOf(it);
    if (ids.has(id)) {
      duplicates++;
      continue;
    }
    if (items.length >= limit) {
      overLimit++;
      continue;
    }
    ids.add(id);
    items.push(it);
    added++;
  }
  return { items, added, duplicates, overLimit };
}

/** Union of two lists: existing pins win (their pin time and baseline are kept); imported ones are appended. */
export function mergeWatchlists(base: Watchlist, incoming: Watchlist, at: number | null = null): MergeResult {
  const c = mergeKind(base.creators, incoming.creators, (x) => x.key, WATCH_LIMITS.creator);
  const v = mergeKind(base.videos, incoming.videos, (x) => x.id, WATCH_LIMITS.video);
  const k = mergeKind(base.keywords, incoming.keywords, (x) => keywordKey(x.kw), WATCH_LIMITS.keyword);
  const changed = c.added + v.added + k.added > 0;
  return {
    list: changed ? { version: 1, creators: c.items, videos: v.items, keywords: k.items, updatedAt: at ?? base.updatedAt } : base,
    added: { creator: c.added, video: v.added, keyword: k.added },
    duplicates: c.duplicates + v.duplicates + k.duplicates,
    overLimit: c.overLimit + v.overLimit + k.overLimit,
  };
}

/** Korean one-line summary of an import. */
export function importSummary(r: Pick<MergeResult, 'added' | 'duplicates' | 'overLimit'>, dropped = 0, truncated = 0): string {
  const parts = [`크리에이터 ${r.added.creator}개 · 영상 ${r.added.video}개 · 키워드 ${r.added.keyword}개 추가`];
  if (r.duplicates) parts.push(`이미 있는 항목 ${r.duplicates}개는 기존 고정 기록 유지`);
  if (r.overLimit + truncated) parts.push(`개수 한도로 ${r.overLimit + truncated}개 제외`);
  if (dropped) parts.push(`읽을 수 없는 항목 ${dropped}개 제외`);
  return parts.join(' · ');
}

/* ------------------------------------------------------------------------------------------ list operations */

export function isPinned(list: Watchlist, kind: WatchKind, id: string): boolean {
  switch (kind) {
    case 'creator':
      return list.creators.some((x) => x.key === id);
    case 'video':
      return list.videos.some((x) => x.id === id);
    case 'keyword': {
      const k = keywordKey(id);
      return list.keywords.some((x) => keywordKey(x.kw) === k);
    }
    default:
      return false;
  }
}

export type AddOutcome = 'added' | 'exists' | 'limit' | 'invalid';

/** Add an item (newest first). Returns the same list object when nothing changed. */
export function addPin(
  list: Watchlist,
  item: { kind: 'creator'; value: PinnedCreator } | { kind: 'video'; value: PinnedVideo } | { kind: 'keyword'; value: PinnedKeyword },
  at: number | null = null,
): { list: Watchlist; outcome: AddOutcome } {
  switch (item.kind) {
    case 'creator': {
      const v = decodeCreator(item.value);
      if (!v) return { list, outcome: 'invalid' };
      if (isPinned(list, 'creator', v.key)) return { list, outcome: 'exists' };
      if (list.creators.length >= WATCH_LIMITS.creator) return { list, outcome: 'limit' };
      return { list: { ...list, creators: [v, ...list.creators], updatedAt: at ?? list.updatedAt }, outcome: 'added' };
    }
    case 'video': {
      const v = decodeVideo(item.value);
      if (!v) return { list, outcome: 'invalid' };
      if (isPinned(list, 'video', v.id)) return { list, outcome: 'exists' };
      if (list.videos.length >= WATCH_LIMITS.video) return { list, outcome: 'limit' };
      return { list: { ...list, videos: [v, ...list.videos], updatedAt: at ?? list.updatedAt }, outcome: 'added' };
    }
    case 'keyword': {
      const v = decodeKeyword(item.value);
      if (!v) return { list, outcome: 'invalid' };
      if (isPinned(list, 'keyword', v.kw)) return { list, outcome: 'exists' };
      if (list.keywords.length >= WATCH_LIMITS.keyword) return { list, outcome: 'limit' };
      return { list: { ...list, keywords: [v, ...list.keywords], updatedAt: at ?? list.updatedAt }, outcome: 'added' };
    }
    default:
      return { list, outcome: 'invalid' };
  }
}

/** Remove an item; the same list object when it was not pinned. */
export function removePin(list: Watchlist, kind: WatchKind, id: string, at: number | null = null): Watchlist {
  if (!isPinned(list, kind, id)) return list;
  const updatedAt = at ?? list.updatedAt;
  switch (kind) {
    case 'creator':
      return { ...list, creators: list.creators.filter((x) => x.key !== id), updatedAt };
    case 'video':
      return { ...list, videos: list.videos.filter((x) => x.id !== id), updatedAt };
    case 'keyword': {
      const k = keywordKey(id);
      return { ...list, keywords: list.keywords.filter((x) => keywordKey(x.kw) !== k), updatedAt };
    }
    default:
      return list;
  }
}

export const ADD_OUTCOME_MESSAGES: Record<Exclude<AddOutcome, 'added'>, string> = {
  exists: '이미 관심 목록에 있음',
  limit: '관심 목록 한도에 도달함. 다른 항목을 빼고 다시 시도',
  invalid: '추가할 수 없는 값',
};

/* ------------------------------------------------------------------------------------------ visits */

export interface VisitMark {
  /** Wall-clock time of the page view (ms). */
  at: number;
  /** Data time (dataset.generatedAt) shown during that view. */
  dataNow: number;
}

export interface VisitState {
  version: 1;
  /** Most recent view of the watchlist page. */
  last: VisitMark | null;
  /** Reference point of "since your last visit" (the last view of the previous session). */
  baseline: VisitMark | null;
}

/** A pause at least this long between two page views starts a new visit. */
export const VISIT_SESSION_GAP_MS = 30 * 60_000;

export function emptyVisit(): VisitState {
  return { version: 1, last: null, baseline: null };
}

function decodeMark(x: unknown): VisitMark | null {
  if (!isRecord(x)) return null;
  const at = finiteOrNull(x.at);
  const dataNow = finiteOrNull(x.dataNow);
  return at === null || dataNow === null ? null : { at, dataNow };
}

export function decodeVisit(raw: string | null | undefined): VisitState {
  if (!raw) return emptyVisit();
  try {
    const x: unknown = JSON.parse(raw);
    if (!isRecord(x) || x.version !== 1) return emptyVisit();
    return { version: 1, last: decodeMark(x.last), baseline: decodeMark(x.baseline) };
  } catch {
    return emptyVisit();
  }
}

export function encodeVisit(v: VisitState): string {
  return JSON.stringify(v);
}

/**
 * Record a page view. First view: no baseline yet. A view after a pause of `gapMs` or more: the previous view
 * becomes the baseline (a new visit). A view inside the same visit (reload, coming back from another page, a
 * clock that went backwards) keeps the baseline and only moves `last`.
 */
export function rollVisit(prev: VisitState, current: VisitMark, gapMs = VISIT_SESSION_GAP_MS): VisitState {
  if (!prev.last) return { version: 1, last: current, baseline: prev.baseline };
  if (current.at - prev.last.at >= gapMs) return { version: 1, last: current, baseline: prev.last };
  return { version: 1, last: { at: Math.max(current.at, prev.last.at), dataNow: Math.max(current.dataNow, prev.last.dataNow) }, baseline: prev.baseline };
}

/** "모두 확인함": the current view becomes the baseline (counts drop to 0 until newer data arrives). */
export function markSeen(current: VisitMark): VisitState {
  return { version: 1, last: current, baseline: current };
}

export type SinceKind = 'first_visit' | 'no_new_data' | 'since';

export interface SinceInfo {
  kind: SinceKind;
  /** Data-time reference: items published / observed after this are "new" (null on the first visit). */
  since: number | null;
  /** Wall-clock time of the baseline visit. */
  visitAt: number | null;
}

/**
 * The reference for "since your last visit" at data time `now`. Uses the data time of the baseline visit, not
 * its wall-clock time: what the viewer saw then was the data as of `baseline.dataNow`, so anything published
 * after it (and collected by `now`) is new to them. When the data has not moved on since, nothing can be new.
 */
export function sinceLastVisit(state: VisitState, now: number): SinceInfo {
  const b = state.baseline;
  if (!b) return { kind: 'first_visit', since: null, visitAt: null };
  if (b.dataNow >= now) return { kind: 'no_new_data', since: b.dataNow, visitAt: b.at };
  return { kind: 'since', since: b.dataNow, visitAt: b.at };
}
