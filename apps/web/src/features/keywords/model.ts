/**
 * 키워드 분석 page logic (pure, tested in keywords.test.ts): URL codecs, keyword list editing, links into the
 * other pages, suggestion filtering, chart series and the coverage facts the empty states explain.
 */
import { KEYWORD_FIELDS, KEYWORD_MATCH_MODES, MAX_KEYWORD_CHARS, MAX_KEYWORDS, compileKeyword, normalizeKeywordList, normalizeText } from '@vti/core';
import type { Dataset, KeywordAnalysis, KeywordField, KeywordMatchMode, KeywordShareItem, KeywordStatusCounts, KeywordSuggestion, MetricStatus, Platform } from '@vti/core';
import type { GrowthSeries } from '../../components/index.ts';
import { statusCountLabel } from '../../lib/metricStatus.ts';
import { formatInteger } from '../../lib/format.ts';
import { enumCodec, enumListCodec, hrefWith } from '../../lib/urlState.ts';
import type { UrlCodec } from '../../lib/urlState.ts';

export { MAX_KEYWORDS };

/** Whether core can search for `k` (has searchable text, not too long). */
export function isSearchableKeyword(k: string): boolean {
  if (k.length > MAX_KEYWORD_CHARS) return false;
  try {
    compileKeyword(k);
    return true;
  } catch {
    return false;
  }
}

/** `kw`: comma list, normalized-unique, at most MAX_KEYWORDS (extra or unsearchable entries in a hand-edited URL are dropped). */
export const keywordListCodec: UrlCodec<string[]> = {
  parse: (raw) => normalizeKeywordList(raw.split(',')).filter(isSearchableKeyword).slice(0, MAX_KEYWORDS),
  serialize: (v) => (v.length ? v.join(',') : null),
};
export const matchCodec = enumCodec<KeywordMatchMode>(KEYWORD_MATCH_MODES);
export const fieldsCodec = enumListCodec<KeywordField>(KEYWORD_FIELDS);

export const MATCH_LABELS: Record<KeywordMatchMode, string> = { all: '모든 단어', any: '아무 단어' };
export const MATCH_HINTS: Record<KeywordMatchMode, string> = {
  all: '여러 단어 키워드는 모든 단어가 들어 있어야 일치',
  any: '여러 단어 키워드는 한 단어만 있어도 일치(한 글자 단어는 무시)',
};
export const FIELD_LABELS: Record<KeywordField, string> = { title: '제목', tags: '태그', topics: '주제', description: '설명' };
export const TERM_MODE_LABELS = { substring: '부분 일치', word: '단어 단위', prefix: '단어 시작' } as const;

/**
 * Chart / chip color of the keyword at position `i` (color follows the keyword, not its rank). Keywords start at
 * the 5th categorical slot: slots 1-4 are the platform colors of YouTube / Dailymotion / PeerTube / niconico (the
 * platforms collected without credentials), so a keyword is not mistaken for a platform next to platform badges.
 */
export function keywordColor(i: number): string {
  return `var(--series-${((i + 4) % 8) + 1})`;
}

/**
 * Add keywords (split on commas / newlines) to the list: trimmed, de-duplicated by normalized text, at most
 * MAX_KEYWORDS. `overflow` = how many could not be added because the list is full.
 */
export function mergeKeywords(current: readonly string[], input: string | readonly string[], max = MAX_KEYWORDS): { next: string[]; overflow: number; added: number } {
  const parts = (typeof input === 'string' ? input.split(/[,，\n]/) : [...input]).map((s) => s.trim()).filter((s) => s && isSearchableKeyword(s));
  const merged = normalizeKeywordList([...current, ...parts]);
  const next = merged.slice(0, max);
  return { next, overflow: Math.max(0, merged.length - max), added: next.length - normalizeKeywordList(current).slice(0, max).length };
}

/** Normalized comparison key (same rule as the core list normalization). */
export function keywordKey(k: string): string {
  return normalizeText(k).replace(/^#+/, '');
}

export interface ScopeParams {
  range: string;
  platforms?: Platform[];
  langs?: string[];
  cats?: string[];
}

function scope(p: ScopeParams) {
  return {
    range: p.range,
    platforms: p.platforms?.length ? p.platforms : undefined,
    langs: p.langs?.length ? p.langs : undefined,
    cats: p.cats?.length ? p.cats : undefined,
  };
}

/** 영상 탐색 search for the keyword, same period and filters, ranked by period views (activity). */
export function videosSearchHref(keyword: string, p: ScopeParams): string {
  return hrefWith('/videos', { mode: 'activity', sort: 'views_period', q: keyword, ...scope(p) });
}

/** 영상 탐색 with a topic filter (related topics). */
export function topicVideosHref(topic: string, p: ScopeParams): string {
  return hrefWith('/videos', { mode: 'activity', sort: 'views_period', topics: [topic], ...scope(p) });
}

/** 영상 탐색: the keyword within one category family. */
export function categoryVideosHref(keyword: string, cat: string, p: ScopeParams): string {
  return hrefWith('/videos', { mode: 'activity', sort: 'views_period', q: keyword, ...scope(p), cats: [cat] });
}

/** 브랜드 협업 page with the brand selected, same period. */
export function brandHref(name: string, range: string): string {
  return hrefWith('/brands', { brand: name, range });
}

/** Keyword page link (used by suggestions, related topics and other pages). */
export function keywordsHref(keywords: readonly string[], p: Partial<ScopeParams> = {}): string {
  return hrefWith('/keywords', { kw: [...keywords], ...scope({ ...p, range: p.range ?? '' }) });
}

/** Suggestions not yet selected, filtered by the typed text (normalized substring), discovery terms first. */
export function filterSuggestions(
  s: { discovery: KeywordSuggestion[]; topics: KeywordSuggestion[] } | undefined,
  text: string,
  selected: readonly string[],
  limit = 12,
): KeywordSuggestion[] {
  if (!s) return [];
  const taken = new Set(selected.map(keywordKey));
  const q = keywordKey(text);
  const out: KeywordSuggestion[] = [];
  const seen = new Set<string>();
  for (const x of [...s.discovery, ...s.topics]) {
    const k = keywordKey(x.keyword);
    if (!k || taken.has(k) || seen.has(k)) continue;
    if (q && !k.includes(q) && !k.replace(/ /g, '').includes(q.replace(/ /g, ''))) continue;
    seen.add(k);
    out.push(x);
    if (out.length >= limit) break;
  }
  return out;
}

/** Daily upload series per keyword for GrowthChart (bar). Partial days are marked '≥' (only part of the day is in the window). */
export function dailySeries(a: KeywordAnalysis): GrowthSeries[] {
  return a.keywords.map((r, i) => ({
    id: `k${i}`,
    label: r.keyword,
    color: keywordColor(i),
    points: a.days.map((d, j) => ({ x: d.date, value: r.daily[j] ?? 0, status: (d.partial ? 'lower_bound' : 'exact') as MetricStatus })),
  }));
}

/** ["≥ 하한값 43", "— 계산 불가 22"] — the statuses of per-video values that are not plain measurements. */
export function statusParts(c: KeywordStatusCounts): string[] {
  const parts: string[] = [];
  for (const s of ['lower_bound', 'unavailable', 'decrease_flagged'] as MetricStatus[]) {
    if (c[s] > 0) parts.push(`${statusCountLabel(s)} ${formatInteger(c[s])}`);
  }
  return parts;
}

export function statusSummary(c: KeywordStatusCounts): string {
  return statusParts(c).join(' · ');
}

export interface KeywordCoverage {
  /** Sources that can discover videos by keyword / tag, with their state in this dataset. */
  keywordSources: { source: string; label: string; enabled: boolean }[];
  /** YouTube keyword search (seeds/keywords.json) state: needs YOUTUBE_API_KEY. */
  youtubeSearch: boolean;
  trackedVideos: number;
}

const KEYWORD_SOURCES: Record<string, string> = {
  'youtube-data-api': 'YouTube 검색(Data API)',
  niconico: 'niconico 태그 검색',
  dailymotion: 'Dailymotion 검색·정렬',
  peertube: 'PeerTube 검색(SepiaSearch)',
  'tiktok-research': 'TikTok 키워드 검색',
  'x-api': 'X 검색',
  'instagram-graph': 'Instagram 해시태그',
};

/** What the collector can find by keyword in this dataset (explains empty / partial results). */
export function keywordCoverage(dataset: Pick<Dataset, 'coverage' | 'videos'>): KeywordCoverage {
  const keywordSources = dataset.coverage
    .filter((c) => KEYWORD_SOURCES[c.source])
    .map((c) => ({ source: c.source, label: KEYWORD_SOURCES[c.source], enabled: c.enabled }));
  return {
    keywordSources,
    youtubeSearch: dataset.coverage.some((c) => c.source === 'youtube-data-api' && c.enabled),
    trackedVideos: dataset.videos.length,
  };
}

/** One-line share text: "34.5%" or "—". */
export function shareText(x: number | null): string {
  if (x === null || !Number.isFinite(x)) return '—';
  const p = x * 100;
  return `${p >= 10 || p === 0 ? p.toFixed(0) : p.toFixed(1)}%`;
}

/**
 * The views share was computed from only part of the keyword's videos on the platform (the others are lower bounds
 * or unknown and left out); the page then shows 'n/m개 기준' next to it instead of hiding that in a tooltip.
 */
export function partialShare(it: Pick<KeywordShareItem, 'excludedVideos' | 'viewShare'>): boolean {
  return it.excludedVideos > 0 && it.viewShare.status !== 'unavailable';
}
