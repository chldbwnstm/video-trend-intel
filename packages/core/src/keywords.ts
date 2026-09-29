/**
 * Keyword intelligence ("키워드 분석"): which tracked videos talk about a keyword, how many were uploaded in a
 * period, how many views they gained, on which platforms, by whom, with which other topics, and how 1-5
 * keywords compare (share of voice within each platform). OWNER: keyword-intelligence agent.
 *
 * Matching (compileKeyword / keywordMatches)
 * - The keyword is normalized (NFKC, lowercase, collapsed whitespace; see text.ts) and split into terms on
 *   spaces; a leading '#' is dropped ('#먹방' = '먹방'). match 'all' (default): every term must occur;
 *   'any': one term is enough (single-character terms are ignored in 'any' mode when a longer term exists,
 *   '나 혼자 산다' would otherwise match every video containing '나').
 * - Korean / Japanese / mixed terms: normalized substring, spacing-insensitive ('선크림' matches '선 크림'),
 *   a term starting with a Latin letter/digit ('e스포츠', 'k뷰티') needs a left word boundary.
 * - ASCII terms of <= 4 characters ('ai', 'lck', 'kpop'): whole words (Latin word boundaries; a plural 's' and
 *   'es' after s/x/z/ch/sh/o allowed), so 'ai' never matches 'said'. Longer ASCII terms: word start only
 *   ('minecraft' matches '#minecraftbuilds', 'korea' matches 'korean').
 * - Fields: title, tags, topics, description (truncated to 300 chars by the collector); default all. A term
 *   never matches across two fields. The normalized search text of every video is built once and cached in a
 *   WeakMap keyed by the Video object (shared by every index / as-of snapshot that contains it).
 *
 * Analysis (analyzeKeywords)
 * - Window: `range` + `rollingHours` + `tz` (resolveAnalysisWindow), data `now` (dataset.generatedAt by
 *   default); the dataset is read as known at `now` (indexAsOf).
 * - Population per keyword: matching videos in scope (platforms / languages / categories filters) published
 *   before min(window end, now) — the videos that could gain views in the window (activity semantics).
 *   `uploadsInWindow` = those published inside the window; `daily` = their uploads per local day in `tz`.
 * - Views: each video's views increase inside the window with exactly the metric code of queryVideos
 *   (activity mode viewsPeriod = windowIncrement, incl. the source-reported fallback). Sums use sumIncrements:
 *   exact / interpolated / source_reported / lower_bound values are added, an unknown increase makes the sum a
 *   lower bound (never counted as 0), a counter the source does not provide is skipped, decreases are excluded.
 *   Per-video status counts are returned so the UI can say how many values were unknown.
 * - Totals over several platforms carry `crossPlatform: true` (view units differ); per-platform rows are the
 *   comparable numbers.
 * - Top videos are ranked like queryVideos' views_period sort (rankValue desc, then viewsTotal desc, id asc)
 *   and carry full computeVideoMetrics rows; their percentile is in-platform within the keyword's videos.
 * - Share of voice, per platform: uploads share (exact counts of our tracked set) and views share computed from
 *   measurable increases only (exact / interpolated / source_reported; lower bounds and unknowns are left out
 *   and counted), so a share is never a ratio of bounds. Videos matching several keywords count for each.
 * - Related topics: topics of the keyword's videos with lift = P(topic | keyword) / P(topic | scope) > 1,
 *   support >= minTopicSupport videos from >= 2 accounts; generic tags and a channel's own name are ignored.
 */
import type { Account, MetricStatus, MetricValue, Platform, UtcWindow, Video, VideoRow, LocalDateRange, QueryResult } from './types.ts';
import { PLATFORMS } from './types.ts';
import type { DatasetIndex } from './dataset.ts';
import { addDays, daysBetween, localDateOf, localDateStartUtc, resolveAnalysisWindow } from './time.ts';
import { computeVideoMetrics, cumulativeAsOf, metricsValueInstant, rankValue, windowIncrement } from './metrics.ts';
import type { MetricContext } from './metrics.ts';
import { unavailableMetric } from './series.ts';
import { isGenericTopic, isSelfTopic, topLevelOf } from './taxonomy.ts';
import { compactText, isAsciiKeyword, isLatinWordChar, normalizeText } from './text.ts';
import {
  PERCENTILE_MIN_PEERS,
  compareIds,
  compileVideoFilter,
  crossPlatformNote,
  indexAsOf,
  instantLabel,
  isSummableMetric,
  percentileRanks,
  resolveNow,
  sumIncrements,
  windowRangeLabel,
} from './query.ts';
import { CSV_BOM, CSV_EOL, csvField, queryResultToCsv } from './csv.ts';

/* ------------------------------------------------------------------------------------------
 * Constants & types
 * ---------------------------------------------------------------------------------------- */

export type KeywordField = 'title' | 'tags' | 'topics' | 'description';
/** Searchable fields in their fixed order (also the priority of `fieldHits`: the first field a term occurs in). */
export const KEYWORD_FIELDS: readonly KeywordField[] = ['title', 'tags', 'topics', 'description'];
export const KEYWORD_FIELD_LABELS_KO: Record<KeywordField, string> = { title: '제목', tags: '태그', topics: '주제', description: '설명' };

export type KeywordMatchMode = 'all' | 'any';
export const KEYWORD_MATCH_MODES: readonly KeywordMatchMode[] = ['all', 'any'];

/** At most this many keywords per comparison. */
export const MAX_KEYWORDS = 5;
/** Longest accepted keyword (characters, before normalization). */
export const MAX_KEYWORD_CHARS = 100;
/** ASCII terms up to this length match whole words only; longer ones match at a word start. */
export const ASCII_WORD_MAX_LEN = 4;
export const KEYWORD_DEFAULT_TOP_VIDEOS = 10;
export const KEYWORD_DEFAULT_TOP_CREATORS = 10;
export const KEYWORD_DEFAULT_RELATED_TOPICS = 12;
/** Minimum videos with a related topic (among the keyword's videos). */
export const KEYWORD_DEFAULT_MIN_TOPIC_SUPPORT = 3;
/** Minimum distinct accounts behind a related topic (a topic of one channel is that channel's label). */
export const KEYWORD_DEFAULT_MIN_TOPIC_ACCOUNTS = 2;
/** A related topic must occur at least this many times more often with the keyword than in the scope. */
export const KEYWORD_MIN_TOPIC_LIFT = 1.5;
/** Upper bound for the daily series (longer windows are cut to their last N local days, with a note). */
export const KEYWORD_MAX_DAYS = 800;

export interface KeywordOptions {
  /** 1-5 keywords (phrases). Duplicates (after normalization) are merged. */
  keywords: string[];
  /** 'all' (default): every term of a keyword phrase must occur; 'any': at least one term. */
  match?: KeywordMatchMode;
  /** Fields searched (default all). */
  fields?: KeywordField[];
  range: LocalDateRange;
  /** Rolling window [now - rollingHours, now) instead of the calendar range. */
  rollingHours?: number | null;
  tz: string;
  now?: number;
  platforms?: Platform[];
  languages?: string[];
  /** Taxonomy ids (descendants included). */
  categories?: string[];
  topVideos?: number;
  topCreators?: number;
  relatedTopics?: number;
  minTopicSupport?: number;
  minTopicAccounts?: number;
}

export interface KeywordTerm {
  /** Normalized term. */
  text: string;
  /** substring: Korean/Japanese/mixed; word: short ASCII, whole word; prefix: longer ASCII, word start. */
  mode: 'substring' | 'word' | 'prefix';
}

export interface CompiledKeyword {
  /** Keyword as given (trimmed). */
  keyword: string;
  /** normalizeText(keyword). */
  normalized: string;
  terms: KeywordTerm[];
  /** Terms ignored in 'any' mode (single characters next to longer terms). */
  dropped: string[];
}

export type KeywordStatusCounts = Record<MetricStatus, number>;

/** A summed views increase (sumIncrements semantics) over a set of videos. */
export type KeywordViewsSum = MetricValue & {
  /** Contributing videos. */
  videos: number;
  /** Videos whose increase is unknown (makes the sum a lower bound; never counted as 0). */
  unknown: number;
  /** Videos whose counter went down (excluded). */
  decreased: number;
  /** Videos whose source does not provide view counts (skipped). */
  notProvided: number;
  platforms: Platform[];
  /** True when several platforms were added up (view units differ between platforms). */
  crossPlatform: boolean;
};

export interface KeywordPlatformRow {
  platform: Platform;
  videos: number;
  uploadsInWindow: number;
  viewsPeriod: KeywordViewsSum;
  statusCounts: KeywordStatusCounts;
}

export interface KeywordCreatorRow {
  /** Creator id (linked accounts) or account id: the /creators/:key key. */
  key: string;
  kind: 'creator' | 'account';
  name: string;
  platforms: Platform[];
  accountIds: string[];
  videos: number;
  uploadsInWindow: number;
  viewsPeriod: KeywordViewsSum;
}

export interface KeywordTopicRow {
  topic: string;
  /** Keyword videos with the topic. */
  support: number;
  /** Scope videos with the topic. */
  overall: number;
  /** P(topic | keyword) / P(topic | scope). */
  lift: number;
  accounts: number;
}

export interface KeywordReport {
  keyword: string;
  normalized: string;
  terms: KeywordTerm[];
  dropped: string[];
  /** Matching videos in scope published before min(window end, now). */
  videos: number;
  uploadsInWindow: number;
  accounts: number;
  /** Uploads per local day, aligned with KeywordAnalysis.days. */
  daily: number[];
  viewsPeriod: KeywordViewsSum;
  statusCounts: KeywordStatusCounts;
  /** Videos by the first field (title > tags > topics > description) a term was found in. */
  fieldHits: Record<KeywordField, number>;
  platforms: KeywordPlatformRow[];
  topVideos: VideoRow[];
  topCreators: KeywordCreatorRow[];
  /** Top-level taxonomy families (a video counts once per family), by count desc. */
  categories: { id: string; count: number }[];
  uncategorized: number;
  /** Video language (not viewer language); null = unknown. */
  languages: { code: string | null; count: number }[];
  relatedTopics: KeywordTopicRow[];
  sponsored: {
    disclosed: number;
    likely: number;
    /** (disclosed + likely) / videos; null without videos. */
    share: number | null;
    brands: { name: string; count: number }[];
  };
  notes: string[];
}

export interface KeywordShareItem {
  keyword: string;
  videos: number;
  uploads: number;
  /** uploads / all compared keywords' uploads on the platform (null when nobody uploaded). */
  uploadShare: number | null;
  /** Sum of measurable increases (exact / interpolated / source_reported) of this keyword's videos. */
  measuredViews: number;
  measuredVideos: number;
  /** Videos left out of the views share (lower bound, unknown, decreased). */
  excludedVideos: number;
  /** measuredViews / sum over the compared keywords (measurable videos only). */
  viewShare: MetricValue;
}

export interface KeywordShareOfVoice {
  platform: Platform;
  totalUploads: number;
  items: KeywordShareItem[];
}

export interface KeywordAnalysis {
  window: UtcWindow;
  now: number;
  tz: string;
  match: KeywordMatchMode;
  fields: KeywordField[];
  /** Videos in scope (filters applied) published before min(window end, now). */
  scopeVideos: number;
  scopePlatforms: Platform[];
  /** Local days of the daily series; `partial` = the window covers only part of that day. */
  days: { date: string; partial: boolean }[];
  keywords: KeywordReport[];
  shareOfVoice: KeywordShareOfVoice[];
  /** Videos matching two or more of the keywords (counted for each of them). */
  overlapVideos: number;
  notes: string[];
}

/* ------------------------------------------------------------------------------------------
 * Keyword compilation & matching
 * ---------------------------------------------------------------------------------------- */

const HASH_PREFIX_RE = /^#+/;

/** Split a keyword phrase into normalized terms. Throws RangeError when nothing searchable is left. */
export function compileKeyword(keyword: string, match: KeywordMatchMode = 'all'): CompiledKeyword {
  const raw = String(keyword ?? '').trim();
  if (raw.length > MAX_KEYWORD_CHARS) throw new RangeError(`keyword too long (max ${MAX_KEYWORD_CHARS} characters): ${raw.slice(0, 20)}…`);
  const normalized = normalizeText(raw);
  const texts: string[] = [];
  for (const part of normalized.split(' ')) {
    const t = part.replace(HASH_PREFIX_RE, '');
    if (t && !texts.includes(t)) texts.push(t);
  }
  if (!texts.length) throw new RangeError(`keyword has no searchable text: '${raw}'`);
  let kept = texts;
  const dropped: string[] = [];
  if (match === 'any' && texts.some((t) => t.length >= 2)) {
    kept = [];
    for (const t of texts) (t.length < 2 ? dropped : kept).push(t);
  }
  const terms = kept.map((text): KeywordTerm => {
    if (!isAsciiKeyword(text)) return { text, mode: 'substring' };
    return { text, mode: text.length <= ASCII_WORD_MAX_LEN ? 'word' : 'prefix' };
  });
  return { keyword: raw, normalized, terms, dropped };
}

/** Normalize a keyword list: trim, drop empties, merge duplicates (same normalized text). Order kept. */
export function normalizeKeywordList(keywords: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const k of keywords) {
    const t = String(k ?? '').trim();
    const n = normalizeText(t).replace(HASH_PREFIX_RE, '');
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(t);
  }
  return out;
}

interface VideoText {
  /** title \n tags(\n) \n topics(\n) \n description, all normalized. */
  text: string;
  /** Start offset of each field in `text` (KEYWORD_FIELDS order). */
  starts: [number, number, number, number];
}

const textCache = new WeakMap<Video, VideoText>();

/** The normalized search text of a video (cached per Video object). */
function videoText(v: Video): VideoText {
  let t = textCache.get(v);
  if (t) return t;
  const title = normalizeText(v.title ?? '');
  const tags = (v.tags ?? []).map((x) => normalizeText(x)).join('\n');
  const topics = (v.topics ?? []).map((x) => normalizeText(x)).join('\n');
  const description = normalizeText(v.description ?? '');
  const s1 = title.length + 1;
  const s2 = s1 + tags.length + 1;
  const s3 = s2 + topics.length + 1;
  t = { text: `${title}\n${tags}\n${topics}\n${description}`, starts: [0, s1, s2, s3] };
  textCache.set(v, t);
  return t;
}

function fieldAt(t: VideoText, pos: number): number {
  const s = t.starts;
  return pos >= s[3] ? 3 : pos >= s[2] ? 2 : pos >= s[1] ? 1 : 0;
}

/** Right boundary of an ASCII whole-word match (plural 's', and 'es' only where English spells it). */
function asciiRightOk(text: string, end: number, term: string): boolean {
  const next = text[end];
  if (!isLatinWordChar(next)) return true;
  if (next === 's' && !isLatinWordChar(text[end + 1])) return true;
  return next === 'e' && text[end + 1] === 's' && !isLatinWordChar(text[end + 2]) && /(?:s|x|z|ch|sh|o)$/.test(term);
}

/**
 * First field (index) where `term` occurs in an allowed field (bit mask over KEYWORD_FIELDS), -1 if none.
 * Occurrences are visited in text order, so the earliest field wins.
 */
function findTerm(t: VideoText, term: KeywordTerm, mask: number): number {
  const text = t.text;
  const s = term.text;
  const leftBoundary = isLatinWordChar(s[0]);
  if (term.mode !== 'substring') {
    const rightBoundary = term.mode === 'word' && isLatinWordChar(s[s.length - 1]);
    for (let i = text.indexOf(s); i >= 0; i = text.indexOf(s, i + 1)) {
      if (leftBoundary && isLatinWordChar(text[i - 1])) continue;
      if (rightBoundary && !asciiRightOk(text, i + s.length, s)) continue;
      const f = fieldAt(t, i);
      if (mask & (1 << f)) return f;
    }
    return -1;
  }
  // Spacing-insensitive substring: spaces inside the text are skipped ('선 크림' contains '선크림'); newlines
  // (field separators) are not, so a match never spans two fields.
  const first = s.charCodeAt(0);
  const n = s.length;
  for (let i = text.indexOf(s[0]); i >= 0; i = text.indexOf(s[0], i + 1)) {
    if (leftBoundary && isLatinWordChar(text[i - 1])) continue;
    let j = i + 1;
    let k = 1;
    while (k < n && j < text.length) {
      const c = text.charCodeAt(j);
      if (c === 32) {
        j++;
        continue;
      }
      if (c !== s.charCodeAt(k)) break;
      j++;
      k++;
    }
    if (k === n && text.charCodeAt(i) === first) {
      const f = fieldAt(t, i);
      if (mask & (1 << f)) return f;
    }
  }
  return -1;
}

function fieldMaskOf(fields: readonly KeywordField[]): number {
  let m = 0;
  for (const f of fields) {
    const i = KEYWORD_FIELDS.indexOf(f);
    if (i >= 0) m |= 1 << i;
  }
  return m;
}

/** Best (first) matching field index for a compiled keyword, -1 when the video does not match. */
function matchIndex(t: VideoText, kw: CompiledKeyword, all: boolean, mask: number): number {
  let best = 4;
  for (const term of kw.terms) {
    const f = findTerm(t, term, mask);
    if (f < 0) {
      if (all) return -1;
      continue;
    }
    if (f < best) best = f;
  }
  return best < 4 ? best : -1;
}

/**
 * Whether `video` matches `keyword` (see the module doc for the rules). Returns the first field a term was
 * found in, or null. Convenience for tests / single checks; analyzeKeywords compiles once.
 */
export function keywordMatches(
  video: Video,
  keyword: string | CompiledKeyword,
  opts: { match?: KeywordMatchMode; fields?: readonly KeywordField[] } = {},
): KeywordField | null {
  const match = opts.match ?? 'all';
  const kw = typeof keyword === 'string' ? compileKeyword(keyword, match) : keyword;
  const f = matchIndex(videoText(video), kw, match === 'all', fieldMaskOf(opts.fields?.length ? opts.fields : KEYWORD_FIELDS));
  return f < 0 ? null : KEYWORD_FIELDS[f];
}

/* ------------------------------------------------------------------------------------------
 * Topics (for lift and suggestions)
 * ---------------------------------------------------------------------------------------- */

const topicCache = new WeakMap<Video, string[]>();
const accountKeyCache = new WeakMap<Account, string>();
const SELF_PUNCT_RE = /[\s_\-.·・'’]/g;

/** Same reduction as taxonomy's self-topic key: normalized, no '@', spaces or name punctuation. */
function selfKeyOf(s: string): string {
  return normalizeText(s).replace(/^@/, '').replace(SELF_PUNCT_RE, '');
}

/**
 * Every self-topic key of an account (its name, name parts, handle) is a substring of this string, so a topic
 * whose key is not contained in it cannot be the channel's own name: isSelfTopic is only called otherwise.
 */
function accountKey(a: Account): string {
  let k = accountKeyCache.get(a);
  if (k === undefined) {
    k = `${selfKeyOf(a.name ?? '')}\n${selfKeyOf(a.handle ?? '')}`;
    accountKeyCache.set(a, k);
  }
  return k;
}

/** A video's distinct, content-describing topics (no generic tags, not the channel's own name). Cached. */
function contentTopics(v: Video, account: Account | undefined): string[] {
  let t = topicCache.get(v);
  if (t) return t;
  t = [];
  const acc = account ? accountKey(account) : null;
  for (const raw of v.topics ?? []) {
    const topic = normalizeText(raw);
    if (!topic || t.includes(topic) || isGenericTopic(topic)) continue;
    if (acc !== null && acc.includes(selfKeyOf(topic)) && isSelfTopic(topic, account)) continue;
    t.push(topic);
  }
  topicCache.set(v, t);
  return t;
}

/* ------------------------------------------------------------------------------------------
 * Aggregation helpers
 * ---------------------------------------------------------------------------------------- */

function emptyStatusCounts(): KeywordStatusCounts {
  return { exact: 0, interpolated: 0, lower_bound: 0, source_reported: 0, unavailable: 0, decrease_flagged: 0 };
}

function orderedPlatforms(set: Iterable<Platform>): Platform[] {
  const s = new Set(set);
  return PLATFORMS.filter((p) => s.has(p));
}

/** sumIncrements + contributor counts; no contributors = unavailable 'no_tracked_videos' (never a 0 that reads as "no views"). */
function viewsSum(values: readonly MetricValue[], platforms: Iterable<Platform>): KeywordViewsSum {
  const ps = orderedPlatforms(platforms);
  let notProvided = 0;
  for (const m of values) if (m.status === 'unavailable' && m.note === 'counter_not_provided') notProvided++;
  if (!values.length) {
    return { ...unavailableMetric('no_tracked_videos'), videos: 0, unknown: 0, decreased: 0, notProvided: 0, platforms: ps, crossPlatform: false };
  }
  const s = sumIncrements(values);
  return {
    value: s.value,
    status: s.status,
    asOf: s.asOf,
    note: s.note,
    videos: values.length,
    unknown: s.unknown,
    decreased: s.decreased,
    notProvided,
    platforms: ps,
    crossPlatform: ps.length > 1,
  };
}

const MEASURED_RANK: Partial<Record<MetricStatus, number>> = { exact: 0, interpolated: 1, source_reported: 2 };
const MEASURED_BY_RANK: MetricStatus[] = ['exact', 'interpolated', 'source_reported'];

interface Measured {
  sum: number;
  videos: number;
  excluded: number;
  rank: number;
  asOf: number | null;
}

function measure(values: readonly MetricValue[]): Measured {
  const m: Measured = { sum: 0, videos: 0, excluded: 0, rank: -1, asOf: null };
  for (const v of values) {
    if (v.status === 'unavailable' && v.note === 'counter_not_provided') continue; // no such counter: not a gap
    if (!isSummableMetric(v)) {
      m.excluded++;
      continue;
    }
    m.sum += v.value as number;
    m.videos++;
    const r = MEASURED_RANK[v.status] ?? 0;
    if (r > m.rank) m.rank = r;
    if (v.asOf !== null && (m.asOf === null || v.asOf > m.asOf)) m.asOf = v.asOf;
  }
  return m;
}

function localDays(w: UtcWindow, end: number, tz: string): { date: string; partial: boolean }[] {
  if (end <= w.startMs) return [];
  let first = localDateOf(w.startMs, tz);
  const last = localDateOf(Math.max(w.startMs, end - 1), tz);
  let n = daysBetween(first, last) + 1;
  if (n > KEYWORD_MAX_DAYS) {
    first = addDays(last, -(KEYWORD_MAX_DAYS - 1));
    n = KEYWORD_MAX_DAYS;
  }
  const out: { date: string; partial: boolean }[] = [];
  let date = first;
  for (let i = 0; i < n; i++) {
    const next = addDays(date, 1);
    const dayStart = localDateStartUtc(date, tz);
    const dayEnd = localDateStartUtc(next, tz);
    out.push({ date, partial: w.startMs > dayStart || end < dayEnd });
    date = next;
  }
  return out;
}

function fmtInt(n: number): string {
  return n.toLocaleString('ko-KR');
}

/* ------------------------------------------------------------------------------------------
 * analyzeKeywords
 * ---------------------------------------------------------------------------------------- */

interface VideoMetricCache {
  inc: MetricValue;
  total: MetricValue;
}

/**
 * Keyword report for 1-5 keywords (see the module doc). Throws RangeError for 0 or more than 5 keywords,
 * a keyword without searchable text or longer than MAX_KEYWORD_CHARS, an unknown match mode / field, a
 * malformed range or an unknown time zone.
 */
export function analyzeKeywords(index: DatasetIndex, opts: KeywordOptions): KeywordAnalysis {
  const match: KeywordMatchMode = opts.match ?? 'all';
  if (!KEYWORD_MATCH_MODES.includes(match)) throw new RangeError(`Unknown keyword match mode: ${String(match)}`);
  const fields: KeywordField[] = opts.fields?.length ? KEYWORD_FIELDS.filter((f) => opts.fields!.includes(f)) : [...KEYWORD_FIELDS];
  for (const f of opts.fields ?? []) if (!KEYWORD_FIELDS.includes(f)) throw new RangeError(`Unknown keyword field: ${String(f)}`);
  const list = normalizeKeywordList(opts.keywords ?? []);
  if (!list.length) throw new RangeError('analyzeKeywords: at least one keyword is required');
  if (list.length > MAX_KEYWORDS) throw new RangeError(`analyzeKeywords: at most ${MAX_KEYWORDS} keywords, got ${list.length}`);
  const compiled = list.map((k) => compileKeyword(k, match));
  const all = match === 'all';
  const mask = fieldMaskOf(fields);

  const tz = opts.tz;
  const now = resolveNow(index, opts.now);
  const w = resolveAnalysisWindow(opts.range, tz, now, opts.rollingHours);
  const end = Math.min(w.endMs, now);
  const idx = indexAsOf(index, now);
  const inScope = compileVideoFilter(idx, { platforms: opts.platforms, languages: opts.languages, categories: opts.categories });
  const days = localDays(w, end, tz);
  const dayIndex = new Map(days.map((d, i) => [d.date, i] as const));

  const K = compiled.length;
  const members: Video[][] = compiled.map(() => []);
  const hitFields: number[][] = compiled.map(() => []);
  const topicTotals = new Map<string, number>();
  const scopePlatforms = new Set<Platform>();
  let scopeVideos = 0;
  let overlapVideos = 0;

  for (const v of idx.dataset.videos) {
    if (v.publishedAt > now || v.publishedAt >= end) continue;
    if (!inScope(v)) continue;
    scopeVideos++;
    scopePlatforms.add(v.platform);
    for (const t of contentTopics(v, idx.accountsById.get(v.accountId))) topicTotals.set(t, (topicTotals.get(t) ?? 0) + 1);
    const text = videoText(v);
    let hits = 0;
    for (let k = 0; k < K; k++) {
      const f = matchIndex(text, compiled[k], all, mask);
      if (f < 0) continue;
      members[k].push(v);
      hitFields[k].push(f);
      hits++;
    }
    if (hits > 1) overlapVideos++;
  }

  // Per-video views increase (activity viewsPeriod) + cumulative views for the tie-break, once per video.
  const valueInstant = metricsValueInstant('activity', w, now);
  const metricCache = new Map<Video, VideoMetricCache>();
  const metricOf = (v: Video): VideoMetricCache => {
    let m = metricCache.get(v);
    if (!m) {
      m = { inc: windowIncrement(v, 'views', w, now), total: cumulativeAsOf(v, 'views', valueInstant) };
      metricCache.set(v, m);
    }
    return m;
  };
  const ctx: MetricContext = { mode: 'activity', window: w, ageDays: null, now, index: idx };

  const topN = clampInt(opts.topVideos, 0, 200, KEYWORD_DEFAULT_TOP_VIDEOS);
  const topC = clampInt(opts.topCreators, 0, 200, KEYWORD_DEFAULT_TOP_CREATORS);
  const relN = clampInt(opts.relatedTopics, 0, 200, KEYWORD_DEFAULT_RELATED_TOPICS);
  const minSupport = clampInt(opts.minTopicSupport, 1, 1_000_000, KEYWORD_DEFAULT_MIN_TOPIC_SUPPORT);
  const minTopicAccounts = clampInt(opts.minTopicAccounts, 1, 1_000_000, KEYWORD_DEFAULT_MIN_TOPIC_ACCOUNTS);

  const reports: KeywordReport[] = compiled.map((kw, k) =>
    buildReport({
      kw,
      vids: members[k],
      fieldIdx: hitFields[k],
      idx,
      w,
      tz,
      dayIndex,
      daysCount: days.length,
      metricOf,
      ctx,
      topN,
      topC,
      relN,
      minSupport,
      minTopicAccounts,
      topicTotals,
      scopeVideos,
      compiledAll: compiled,
    }),
  );

  const shareOfVoice = buildShareOfVoice(reports, members, metricOf);

  return {
    window: w,
    now,
    tz,
    match,
    fields,
    scopeVideos,
    scopePlatforms: orderedPlatforms(scopePlatforms),
    days,
    keywords: reports,
    shareOfVoice,
    overlapVideos,
    notes: analysisNotes({ w, now, tz, match, fields, scopeVideos, scopePlatforms, overlapVideos, K, truncated: idx !== index, daysCut: days.length === KEYWORD_MAX_DAYS }),
  };
}

function clampInt(x: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof x !== 'number' || !Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(x)));
}

interface ReportInput {
  kw: CompiledKeyword;
  vids: Video[];
  fieldIdx: number[];
  idx: DatasetIndex;
  w: UtcWindow;
  tz: string;
  dayIndex: Map<string, number>;
  daysCount: number;
  metricOf: (v: Video) => VideoMetricCache;
  ctx: MetricContext;
  topN: number;
  topC: number;
  relN: number;
  minSupport: number;
  minTopicAccounts: number;
  topicTotals: Map<string, number>;
  scopeVideos: number;
  compiledAll: CompiledKeyword[];
}

function buildReport(x: ReportInput): KeywordReport {
  const { kw, vids, idx, w, tz } = x;
  const m = vids.length;
  const daily = new Array<number>(x.daysCount).fill(0);
  const statusCounts = emptyStatusCounts();
  const fieldHits: Record<KeywordField, number> = { title: 0, tags: 0, topics: 0, description: 0 };
  const accounts = new Set<string>();
  const incs: MetricValue[] = [];
  let uploadsInWindow = 0;

  interface PAcc {
    videos: number;
    uploads: number;
    incs: MetricValue[];
    counts: KeywordStatusCounts;
  }
  const byPlatform = new Map<Platform, PAcc>();
  interface CAcc {
    key: string;
    kind: 'creator' | 'account';
    platforms: Set<Platform>;
    accountIds: Set<string>;
    videos: number;
    uploads: number;
    incs: MetricValue[];
  }
  const byCreator = new Map<string, CAcc>();
  const cats = new Map<string, number>();
  let uncategorized = 0;
  const langs = new Map<string | null, number>();
  let disclosed = 0;
  let likely = 0;
  const brands = new Map<string, number>();
  const topicAcc = new Map<string, { support: number; accounts: Set<string> }>();

  for (let i = 0; i < m; i++) {
    const v = vids[i];
    const { inc } = x.metricOf(v);
    incs.push(inc);
    statusCounts[inc.status]++;
    fieldHits[KEYWORD_FIELDS[x.fieldIdx[i]]]++;
    accounts.add(v.accountId);
    const uploaded = v.publishedAt >= w.startMs;
    if (uploaded) {
      uploadsInWindow++;
      const di = x.dayIndex.get(localDateOf(v.publishedAt, tz));
      if (di !== undefined) daily[di]++;
    }

    let p = byPlatform.get(v.platform);
    if (!p) {
      p = { videos: 0, uploads: 0, incs: [], counts: emptyStatusCounts() };
      byPlatform.set(v.platform, p);
    }
    p.videos++;
    if (uploaded) p.uploads++;
    p.incs.push(inc);
    p.counts[inc.status]++;

    const cid = idx.creatorOfAccount.get(v.accountId);
    const key = cid ?? v.accountId;
    let c = byCreator.get(key);
    if (!c) {
      c = { key, kind: cid ? 'creator' : 'account', platforms: new Set(), accountIds: new Set(), videos: 0, uploads: 0, incs: [] };
      byCreator.set(key, c);
    }
    c.platforms.add(v.platform);
    c.accountIds.add(v.accountId);
    c.videos++;
    if (uploaded) c.uploads++;
    c.incs.push(inc);

    const families = new Set<string>();
    for (const a of v.categories ?? []) {
      const top = topLevelOf(a.id);
      if (top) families.add(top);
    }
    if (!families.size) uncategorized++;
    for (const f of families) cats.set(f, (cats.get(f) ?? 0) + 1);

    const lang = v.language ? v.language.toLowerCase() : null;
    langs.set(lang, (langs.get(lang) ?? 0) + 1);

    if (v.sponsorship) {
      if (v.sponsorship.level === 'disclosed') disclosed++;
      else likely++;
      for (const b of new Set(v.sponsorship.brands ?? [])) if (b) brands.set(b, (brands.get(b) ?? 0) + 1);
    }

    for (const t of contentTopics(v, idx.accountsById.get(v.accountId))) {
      let a = topicAcc.get(t);
      if (!a) {
        a = { support: 0, accounts: new Set() };
        topicAcc.set(t, a);
      }
      a.support++;
      a.accounts.add(v.accountId);
    }
  }

  const viewsPeriod = viewsSum(incs, byPlatform.keys());

  const platforms: KeywordPlatformRow[] = orderedPlatforms(byPlatform.keys()).map((platform) => {
    const p = byPlatform.get(platform)!;
    return { platform, videos: p.videos, uploadsInWindow: p.uploads, viewsPeriod: viewsSum(p.incs, [platform]), statusCounts: p.counts };
  });

  const creatorRows: KeywordCreatorRow[] = [...byCreator.values()].map((c) => {
    const name =
      (c.kind === 'creator' ? idx.creatorsById.get(c.key)?.name : undefined) ?? idx.accountsById.get([...c.accountIds][0])?.name ?? c.key;
    return {
      key: c.key,
      kind: c.kind,
      name: name || c.key,
      platforms: orderedPlatforms(c.platforms),
      accountIds: [...c.accountIds].sort(compareIds),
      videos: c.videos,
      uploadsInWindow: c.uploads,
      viewsPeriod: viewsSum(c.incs, c.platforms),
    };
  });
  creatorRows.sort((a, b) => {
    if (a.videos !== b.videos) return b.videos - a.videos;
    const ra = rankValue(a.viewsPeriod);
    const rb = rankValue(b.viewsPeriod);
    if (ra !== rb) {
      if (ra === null) return 1;
      if (rb === null) return -1;
      return rb - ra;
    }
    return compareIds(a.key, b.key);
  });

  // Related topics: lift over the scope's topic frequency.
  const own = new Set<string>([compactText(kw.keyword), ...kw.terms.map((t) => compactText(t.text))]);
  for (const other of x.compiledAll) own.add(compactText(other.keyword));
  const related: (KeywordTopicRow & { score: number })[] = [];
  if (m > 0 && x.scopeVideos > 0) {
    for (const [topic, a] of topicAcc) {
      if (a.support < x.minSupport || a.accounts.size < x.minTopicAccounts) continue;
      if (own.has(compactText(topic))) continue;
      const overall = Math.max(a.support, x.topicTotals.get(topic) ?? a.support);
      const lift = a.support / m / (overall / x.scopeVideos);
      if (!(lift >= KEYWORD_MIN_TOPIC_LIFT)) continue;
      // support x ln(lift): lift alone saturates at scope/keyword size for every topic that only occurs with
      // the keyword (a 3-video tag would outrank a 30-video one); weighting by support prefers frequent ones.
      related.push({ topic, support: a.support, overall, lift, accounts: a.accounts.size, score: a.support * Math.log(lift) });
    }
    related.sort((a, b) => b.score - a.score || b.lift - a.lift || compareIds(a.topic, b.topic));
  }

  const report: KeywordReport = {
    keyword: kw.keyword,
    normalized: kw.normalized,
    terms: kw.terms,
    dropped: kw.dropped,
    videos: m,
    uploadsInWindow,
    accounts: accounts.size,
    daily,
    viewsPeriod,
    statusCounts,
    fieldHits,
    platforms,
    topVideos: topVideoRows(vids, x),
    topCreators: creatorRows.slice(0, x.topC),
    categories: [...cats.entries()].map(([id, count]) => ({ id, count })).sort((a, b) => b.count - a.count || compareIds(a.id, b.id)),
    uncategorized,
    languages: [...langs.entries()]
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count || compareIds(a.code ?? '￿', b.code ?? '￿')),
    relatedTopics: related.slice(0, x.relN).map(({ score: _score, ...t }) => t),
    sponsored: {
      disclosed,
      likely,
      share: m > 0 ? (disclosed + likely) / m : null,
      brands: [...brands.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || compareIds(a.name, b.name)).slice(0, 10),
    },
    notes: [],
  };
  report.notes = reportNotes(report, x.scopeVideos, x.w);
  return report;
}

/** Top videos by activity views increase, ranked exactly like queryVideos(sort: views_period, dir: desc). */
function topVideoRows(vids: Video[], x: ReportInput): VideoRow[] {
  if (!x.topN || !vids.length) return [];
  const order = vids.map((_, i) => i);
  const primary = vids.map((v) => rankValue(x.metricOf(v).inc));
  const tie = vids.map((v) => rankValue(x.metricOf(v).total));
  order.sort((a, b) => {
    const pa = primary[a];
    const pb = primary[b];
    if (pa !== pb) {
      if (pa === null) return 1;
      if (pb === null) return -1;
      return pb - pa;
    }
    const ta = tie[a];
    const tb = tie[b];
    if (ta !== tb) {
      if (ta === null) return 1;
      if (tb === null) return -1;
      return tb - ta;
    }
    return compareIds(vids[a].id, vids[b].id);
  });
  const top = order.slice(0, x.topN);

  // In-platform percentile of the period increase among the keyword's videos (queryVideos' definition).
  const needed = new Set(top.map((i) => vids[i].platform));
  const pctOf = new Map<number, { pct: number; peers: number }>();
  for (const platform of needed) {
    const members = order.filter((i) => vids[i].platform === platform && primary[i] !== null);
    const ranks = percentileRanks(members.map((i) => primary[i] as number));
    members.forEach((i, k) => pctOf.set(i, { pct: ranks[k], peers: members.length }));
  }

  return top.map((i) => {
    const v = vids[i];
    const metrics = computeVideoMetrics(v, x.ctx);
    const p = pctOf.get(i);
    const base = metrics.viewsPeriod;
    if (p) {
      const status: MetricStatus =
        base.status === 'lower_bound' ? 'lower_bound' : base.status === 'exact' ? 'exact' : base.status === 'source_reported' ? 'source_reported' : 'interpolated';
      metrics.percentile = { value: p.pct, status, asOf: base.asOf, note: p.peers < PERCENTILE_MIN_PEERS ? 'few_platform_peers' : null };
    } else {
      metrics.percentile = unavailableMetric('sort_metric_unavailable');
    }
    return { video: v, account: x.idx.accountsById.get(v.accountId) ?? null, metrics };
  });
}

function buildShareOfVoice(reports: KeywordReport[], members: Video[][], metricOf: (v: Video) => VideoMetricCache): KeywordShareOfVoice[] {
  const platforms = orderedPlatforms(reports.flatMap((r) => r.platforms.map((p) => p.platform)));
  return platforms.map((platform) => {
    const measured = members.map((vids) => measure(vids.filter((v) => v.platform === platform).map((v) => metricOf(v).inc)));
    const rows = reports.map((r) => r.platforms.find((p) => p.platform === platform));
    const totalUploads = rows.reduce((a, p) => a + (p?.uploadsInWindow ?? 0), 0);
    const totalMeasured = measured.reduce((a, x) => a + x.sum, 0);
    const anyMeasured = measured.some((x) => x.videos > 0);
    let rank = -1;
    let asOf: number | null = null;
    for (const x of measured) {
      if (x.rank > rank) rank = x.rank;
      if (x.asOf !== null && (asOf === null || x.asOf > asOf)) asOf = x.asOf;
    }
    const items: KeywordShareItem[] = reports.map((r, k) => {
      const p = rows[k];
      const x = measured[k];
      const uploads = p?.uploadsInWindow ?? 0;
      // A keyword whose videos on this platform all lack a measurable increase has an unknown share (not 0%);
      // a keyword without tracked videos on the platform has exactly 0% of what we track there (a count, so
      // 'exact' whatever the other keywords' statuses; the note says why).
      const viewShare: MetricValue =
        totalMeasured <= 0
          ? unavailableMetric(anyMeasured ? 'zero_views' : 'insufficient_observations')
          : !p || p.videos === 0
            ? { value: 0, status: 'exact', asOf, note: 'no_tracked_videos' }
            : x.videos === 0
              ? unavailableMetric(x.excluded > 0 ? 'insufficient_observations' : 'counter_not_provided')
              : { value: x.sum / totalMeasured, status: MEASURED_BY_RANK[Math.max(0, rank)], asOf, note: null };
      return {
        keyword: r.keyword,
        videos: p?.videos ?? 0,
        uploads,
        uploadShare: totalUploads > 0 ? uploads / totalUploads : null,
        measuredViews: x.sum,
        measuredVideos: x.videos,
        excludedVideos: x.excluded,
        viewShare,
      };
    });
    return { platform, totalUploads, items };
  });
}

/* ------------------------------------------------------------------------------------------
 * Notes (Korean)
 * ---------------------------------------------------------------------------------------- */

function reportNotes(r: KeywordReport, scopeVideos: number, w: UtcWindow): string[] {
  const notes: string[] = [];
  if (r.dropped.length) {
    notes.push(`'아무 단어' 일치에서는 한 글자 단어(${r.dropped.map((d) => `'${d}'`).join(', ')})를 검색하지 않았습니다(거의 모든 영상에 들어 있어 의미가 없음).`);
  }
  if (!r.videos) {
    notes.push(
      `추적 중인 영상 ${fmtInt(scopeVideos)}개 중 '${r.keyword}'와 일치하는 영상이 없습니다. 이 서비스가 수집한 영상 범위 안의 결과일 뿐 플랫폼 전체에 없다는 뜻은 아닙니다.`,
    );
    return notes;
  }
  const c = r.statusCounts;
  const parts: string[] = [];
  const add = (n: number, label: string) => {
    if (n > 0) parts.push(`${label} ${fmtInt(n)}개`);
  };
  add(c.exact, '정확');
  add(c.interpolated, '보간(≈)');
  add(c.source_reported, '원천 보고');
  add(c.lower_bound, '하한(≥)');
  const s = r.viewsPeriod;
  const sentences = [`'${r.keyword}' 영상 ${fmtInt(r.videos)}개의 기간 조회 증가 합계에 ${parts.length ? `${parts.join('·')}의 값을 더했습니다` : '더할 수 있는 값이 없습니다'}.`];
  if (s.unknown > 0) sentences.push(`계산 불가 ${fmtInt(s.unknown)}개는 0으로 세지 않고 빼서 합계를 하한(≥, 실제는 더 클 수 있음)으로 표시합니다.`);
  else if (s.status === 'lower_bound') sentences.push('일부 영상 값이 하한이라 합계도 하한(≥)입니다.');
  if (s.notProvided > 0) sentences.push(`원천이 조회수를 제공하지 않는 영상 ${fmtInt(s.notProvided)}개는 제외했습니다.`);
  if (s.decreased > 0) sentences.push(`누적값이 줄어든 영상 ${fmtInt(s.decreased)}개(삭제·정정 가능)는 제외했습니다.`);
  notes.push(sentences.join(' '));
  if (s.crossPlatform) notes.push(`${crossPlatformNote(s.platforms, `'${r.keyword}' 합계`)} 플랫폼별 값을 함께 보세요.`);
  if (r.uploadsInWindow === 0) notes.push(`'${r.keyword}' 영상 중 ${windowRangeLabel(w)}에 게시된 추적 영상은 없습니다(조회 증가는 그 전에 게시된 영상 기준).`);
  return notes;
}

interface AnalysisNotesInput {
  w: UtcWindow;
  now: number;
  tz: string;
  match: KeywordMatchMode;
  fields: KeywordField[];
  scopeVideos: number;
  scopePlatforms: Set<Platform>;
  overlapVideos: number;
  K: number;
  truncated: boolean;
  daysCut: boolean;
}

function analysisNotes(x: AnalysisNotesInput): string[] {
  const notes: string[] = [];
  notes.push(
    `조회 발생 기간 기준: 게시일과 관계없이 ${windowRangeLabel(x.w)} 동안 늘어난 조회수를 키워드별로 합산합니다. ` +
      `업로드 수는 같은 기간에 게시된 추적 영상 수(${x.tz} 현지 날짜별)입니다.`,
  );
  const fieldText = x.fields.map((f) => KEYWORD_FIELD_LABELS_KO[f]).join('·');
  notes.push(
    `키워드 일치: ${fieldText}에서 대소문자·전각을 무시하고 찾습니다. 한글·일본어는 띄어쓰기와 관계없는 부분 일치, ` +
      `${ASCII_WORD_MAX_LEN}자 이하 영문은 단어 단위(복수형 s 허용), 그보다 긴 영문은 단어 시작 일치입니다. ` +
      (x.match === 'all' ? '여러 단어 키워드는 모든 단어가 있어야 일치합니다.' : '여러 단어 키워드는 한 단어만 있어도 일치합니다.') +
      ` 설명은 수집기가 저장한 앞부분(최대 300자)만 검색합니다.`,
  );
  notes.push(
    `추적 중인 영상 ${fmtInt(x.scopeVideos)}개(필터 적용, 기간 끝까지 게시된 영상) 안에서 찾은 결과입니다. 플랫폼 전체의 검색량·업로드 수가 아니며, ` +
      `발견 방식(채널별 최신 업로드, 인기·최신 정렬, 태그 검색)에 따라 최근 인기 영상이 더 많이 잡힙니다.`,
  );
  if (x.w.incomplete) {
    notes.push(`선택한 기간이 아직 끝나지 않았습니다(데이터 기준 ${instantLabel(x.now, x.tz)}). 부분 집계이므로 완료된 기간과 직접 비교하지 마세요.`);
  }
  if (x.truncated) notes.push(`기준 시각 ${instantLabel(x.now, x.tz)} 이후에 수집된 관측값·영상은 제외하고 계산했습니다.`);
  if (x.daysCut) notes.push(`일별 업로드는 마지막 ${fmtInt(KEYWORD_MAX_DAYS)}일만 표시합니다.`);
  if (x.K > 1) {
    notes.push(
      '점유율(share of voice)은 같은 플랫폼 안에서 비교한 키워드들의 합계 중 이 키워드의 비율입니다. 조회 점유율은 기간 조회 증가를 계산할 수 있는(정확·보간·원천) 영상만으로 계산하고, 하한·계산 불가 영상은 빼고 그 수를 함께 표시합니다.',
    );
    if (x.overlapVideos > 0) {
      notes.push(`영상 ${fmtInt(x.overlapVideos)}개는 두 개 이상의 키워드에 동시에 일치해 각 키워드에 모두 집계했습니다(점유율 분모에서도 중복).`);
    }
  }
  if (x.scopePlatforms.size > 1) notes.push(`${crossPlatformNote(x.scopePlatforms, '키워드 결과')} 점유율과 순위는 플랫폼별로 따로 보세요.`);
  return notes;
}

/* ------------------------------------------------------------------------------------------
 * Suggestions
 * ---------------------------------------------------------------------------------------- */

export interface KeywordSuggestion {
  keyword: string;
  /** 'discovery' = a search term / tag the collector used to find videos; 'topic' = a popular topic. */
  source: 'discovery' | 'topic';
  /** Tracked videos found with it (discovery) or carrying the topic. */
  videos: number;
  /** Distinct accounts (topics only; 0 for discovery). */
  accounts: number;
  /** Discovery source label, e.g. 'niconico 태그'. */
  via: string | null;
}

const DISCOVERY_PATTERNS: { re: RegExp; via: string }[] = [
  { re: /^niconico:(?:tag|keyword):(.+)$/, via: 'niconico 검색' },
  { re: /^youtube-data-api:search:[^:]*:(.+)$/, via: 'YouTube 검색' },
  { re: /^tiktok-research:keyword:(.+)$/, via: 'TikTok 검색' },
  { re: /^x-api:search:(.+)$/, via: 'X 검색' },
  { re: /^instagram-graph:hashtag:[^:]*:(.+)$/, via: 'Instagram 해시태그' },
];

/** The search keyword / tag inside a `discoveredVia` value (e.g. `niconico:tag:料理` -> 料理), or null. */
export function discoveryKeywordOf(via: string): { keyword: string; via: string } | null {
  for (const p of DISCOVERY_PATTERNS) {
    const m = p.re.exec(via);
    if (m && m[1].trim()) return { keyword: m[1].trim(), via: p.via };
  }
  return null;
}

const suggestionCache = new WeakMap<DatasetIndex, { discovery: KeywordSuggestion[]; topics: KeywordSuggestion[] }>();

/**
 * Keyword ideas from the dataset itself: the search terms / tags the collector discovered videos with
 * (discoveredVia) and popular content topics (>= 3 videos from >= 2 accounts, generic tags excluded), each by
 * video count desc. Topics equal to a discovery keyword are listed once (as discovery). Cached per index.
 */
export function keywordSuggestions(index: DatasetIndex, opts: { limit?: number } = {}): { discovery: KeywordSuggestion[]; topics: KeywordSuggestion[] } {
  const limit = clampInt(opts.limit, 1, 1000, 40);
  let hit = suggestionCache.get(index);
  if (!hit) {
    const disc = new Map<string, { keyword: string; via: string; videos: number }>();
    const topics = new Map<string, { videos: number; accounts: Set<string> }>();
    for (const v of index.dataset.videos) {
      const seen = new Set<string>();
      for (const d of v.discoveredVia ?? []) {
        const k = discoveryKeywordOf(d);
        if (!k) continue;
        const key = compactText(k.keyword);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const e = disc.get(key);
        if (e) e.videos++;
        else disc.set(key, { keyword: k.keyword, via: k.via, videos: 1 });
      }
      for (const t of contentTopics(v, index.accountsById.get(v.accountId))) {
        let e = topics.get(t);
        if (!e) {
          e = { videos: 0, accounts: new Set() };
          topics.set(t, e);
        }
        e.videos++;
        e.accounts.add(v.accountId);
      }
    }
    const discovery = [...disc.values()]
      .map((d): KeywordSuggestion => ({ keyword: d.keyword, source: 'discovery', videos: d.videos, accounts: 0, via: d.via }))
      .sort((a, b) => b.videos - a.videos || compareIds(a.keyword, b.keyword));
    const discKeys = new Set(disc.keys());
    const topicList = [...topics.entries()]
      .filter(([t, e]) => e.videos >= 3 && e.accounts.size >= 2 && !discKeys.has(compactText(t)))
      .map(([t, e]): KeywordSuggestion => ({ keyword: t, source: 'topic', videos: e.videos, accounts: e.accounts.size, via: null }))
      .sort((a, b) => b.videos - a.videos || b.accounts - a.accounts || compareIds(a.keyword, b.keyword));
    hit = { discovery, topics: topicList };
    suggestionCache.set(index, hit);
  }
  return { discovery: hit.discovery.slice(0, limit), topics: hit.topics.slice(0, limit) };
}

/* ------------------------------------------------------------------------------------------
 * CSV
 * ---------------------------------------------------------------------------------------- */

/**
 * Top videos of every keyword as one CSV: '키워드', '키워드 내 순위', then exactly the columns of
 * queryResultToCsv (every metric with status, asOf and note; window columns; activity date semantics).
 */
export function keywordTopVideosCsv(a: KeywordAnalysis, tz: string = a.tz): string {
  let header: string | null = null;
  const lines: string[] = [];
  for (const r of a.keywords) {
    r.topVideos.forEach((row, i) => {
      const result: QueryResult = { rows: [row], total: 1, window: a.window, now: a.now, notes: [] };
      const full = queryResultToCsv(result, tz, { dateMode: 'activity' }).slice(CSV_BOM.length);
      // The header line never contains CR/LF (fixed labels), so the first CSV_EOL ends it; the rest is one record.
      const cut = full.indexOf(CSV_EOL);
      header ??= `${csvField('키워드', true)},${csvField('키워드 내 순위', true)},${full.slice(0, cut)}`;
      lines.push(`${csvField(r.keyword, true)},${i + 1},${full.slice(cut + CSV_EOL.length, full.length - CSV_EOL.length)}`);
    });
  }
  if (header === null) {
    const empty = queryResultToCsv({ rows: [], total: 0, window: a.window, now: a.now, notes: [] }, tz, { dateMode: 'activity' }).slice(CSV_BOM.length);
    header = `${csvField('키워드', true)},${csvField('키워드 내 순위', true)},${empty.slice(0, empty.indexOf(CSV_EOL))}`;
  }
  return CSV_BOM + [header, ...lines].join(CSV_EOL) + CSV_EOL;
}
