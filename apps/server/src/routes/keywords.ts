/**
 * GET /api/v1/keywords — keyword intelligence: compare 1-5 keywords within the tracked video set (matched
 * videos, uploads per local day, period views with honest status sums, platform split, share of voice, top
 * videos / creators, categories, languages, related topics, sponsorship). JSON, or CSV of the top videos.
 * Also builds the static files keywords/<i>.json + keywords/index.json (see static-api.ts). OWNER: keyword agent.
 */
import type { Hono } from 'hono';
import { KEYWORD_FIELDS, KEYWORD_MATCH_MODES, MAX_KEYWORDS, MAX_KEYWORD_CHARS, analyzeKeywords, categoryPathLabel, compileKeyword, keywordTopVideosCsv, normalizeKeywordList, presetRange, presetRollingHours } from '@vti/core';
import type { DatasetIndex, KeywordAnalysis, KeywordField, KeywordMatchMode, KeywordReport, KeywordViewsSum, MetricValue, Platform, RangePreset, VideoRow } from '@vti/core';
import { API_VERSION, cacheKeyOf, isoOf, platformLabel, requireIndex, respond, rowJson, windowJson, type RouteDeps } from './common.ts';
import {
  Params,
  ParamError,
  parseAsOf,
  parseCategories,
  parseEnum,
  parseEnumList,
  parseIntParam,
  parseLanguages,
  parsePlatforms,
  parseRangeParams,
  parseTz,
  rangeEcho,
  type ResolvedRangeParam,
} from '../params.ts';

export const DEFAULT_KEYWORD_TOP = 10;
export const MAX_KEYWORD_TOP = 50;
/** Static reports: rolling 7 days, top 20 videos per keyword (compact rows). */
export const STATIC_KEYWORD_PRESET: RangePreset = 'rolling7d';
export const STATIC_KEYWORD_TOP = 20;

export interface KeywordRequest {
  keywords: string[];
  match: KeywordMatchMode;
  fields: KeywordField[];
  tz: string;
  now: number;
  range: ResolvedRangeParam;
  platforms: Platform[];
  categories: string[];
  languages: string[];
  top: number;
  output: 'json' | 'csv';
}

/** Parse + validate a /keywords request. Keyword aliases: q, kw (the web app's URL key), keywords. */
export function parseKeywordRequest(p: Params, index: DatasetIndex): KeywordRequest {
  const output = parseEnum(p, ['format', 'output'], ['json', 'csv'] as const, 'json');
  const raw = p.list(['q', 'kw', 'keywords', 'keyword']);
  const keywords = normalizeKeywordList(raw);
  if (!keywords.length) {
    throw new ParamError('q', `분석할 키워드를 q에 1~${MAX_KEYWORDS}개(쉼표로 구분) 지정하세요. 예: q=먹방,브이로그`, `Give 1-${MAX_KEYWORDS} keywords in q (comma separated), e.g. q=mukbang,vlog.`);
  }
  if (keywords.length > MAX_KEYWORDS) {
    throw new ParamError('q', `키워드는 최대 ${MAX_KEYWORDS}개까지 비교할 수 있습니다(받은 개수: ${keywords.length}).`, `At most ${MAX_KEYWORDS} keywords can be compared (got ${keywords.length}).`);
  }
  const match = parseEnum(p, ['match'], KEYWORD_MATCH_MODES, 'all');
  for (const k of keywords) {
    if (k.length > MAX_KEYWORD_CHARS) {
      throw new ParamError('q', `키워드는 최대 ${MAX_KEYWORD_CHARS}자입니다.`, `A keyword may be at most ${MAX_KEYWORD_CHARS} characters.`);
    }
    try {
      compileKeyword(k, match);
    } catch {
      throw new ParamError('q', `검색할 글자가 없는 키워드입니다: '${k}'.`, `Keyword has no searchable text: '${k}'.`);
    }
  }
  const fields = parseEnumList(p, ['fields', 'field'], KEYWORD_FIELDS);
  const tz = parseTz(p);
  const now = parseAsOf(p, index);
  const range = parseRangeParams(p, tz, now)!;
  const platforms = parsePlatforms(p);
  const categories = parseCategories(p);
  const languages = parseLanguages(p);
  const top = parseIntParam(p, ['top', 'limit'], 0, MAX_KEYWORD_TOP, DEFAULT_KEYWORD_TOP);
  p.done();
  return { keywords, match, fields: fields.length ? fields : [...KEYWORD_FIELDS], tz, now, range, platforms, categories, languages, top, output };
}

export function runKeywordRequest(index: DatasetIndex, r: KeywordRequest): KeywordAnalysis {
  return analyzeKeywords(index, {
    keywords: r.keywords,
    match: r.match,
    fields: r.fields,
    range: r.range.range,
    rollingHours: r.range.rollingHours,
    tz: r.tz,
    now: r.now,
    ...(r.platforms.length ? { platforms: r.platforms } : {}),
    ...(r.categories.length ? { categories: r.categories } : {}),
    ...(r.languages.length ? { languages: r.languages } : {}),
    topVideos: r.top,
  });
}

/* ------------------------------------------------------------------------------------------ JSON shapes */

const m = (x: MetricValue) => ({ value: x.value, status: x.status, asOf: x.asOf, note: x.note });

function sumJson(s: KeywordViewsSum) {
  return { ...m(s), videos: s.videos, unknown: s.unknown, decreased: s.decreased, notProvided: s.notProvided, platforms: s.platforms, crossPlatform: s.crossPlatform };
}

/** Slim top-video row for static files: identity + the period metrics with value/status/asOf. */
export function keywordRowJson(r: VideoRow, rank: number) {
  const x = (v: MetricValue) => ({ value: v.value, status: v.status, asOf: v.asOf });
  return {
    rank,
    id: r.video.id,
    platform: r.video.platform,
    url: r.video.url,
    title: r.video.title,
    thumbnail: r.video.thumbnail,
    account: { id: r.video.accountId, name: r.account?.name ?? null },
    publishedAt: r.video.publishedAt,
    metrics: { viewsPeriod: x(r.metrics.viewsPeriod), viewsTotal: x(r.metrics.viewsTotal), percentile: x(r.metrics.percentile) },
  };
}

export function keywordReportJson(r: KeywordReport, now: number, compact = false) {
  return {
    keyword: r.keyword,
    normalized: r.normalized,
    terms: r.terms,
    dropped: r.dropped,
    videos: r.videos,
    uploadsInWindow: r.uploadsInWindow,
    accounts: r.accounts,
    daily: r.daily,
    viewsPeriod: sumJson(r.viewsPeriod),
    statusCounts: r.statusCounts,
    fieldHits: r.fieldHits,
    platforms: r.platforms.map((p) => ({
      platform: p.platform,
      label: platformLabel(p.platform),
      videos: p.videos,
      uploadsInWindow: p.uploadsInWindow,
      viewsPeriod: sumJson(p.viewsPeriod),
      statusCounts: p.statusCounts,
    })),
    topVideos: compact ? r.topVideos.map((row, i) => keywordRowJson(row, i + 1)) : r.topVideos.map((row) => rowJson(row, now)),
    topCreators: r.topCreators.map((c) => ({ ...c, viewsPeriod: sumJson(c.viewsPeriod) })),
    categories: r.categories.map((c) => ({ id: c.id, label: categoryPathLabel(c.id), count: c.count })),
    uncategorized: r.uncategorized,
    languages: r.languages,
    relatedTopics: r.relatedTopics.map((t) => ({ ...t, lift: Math.round(t.lift * 100) / 100 })),
    sponsored: r.sponsored,
    notes: r.notes,
  };
}

export function keywordAnalysisJson(a: KeywordAnalysis, rollingHours: number | null, compact = false) {
  return {
    now: a.now,
    window: windowJson(a.window, rollingHours),
    match: a.match,
    fields: a.fields,
    scopeVideos: a.scopeVideos,
    scopePlatforms: a.scopePlatforms,
    days: a.days,
    overlapVideos: a.overlapVideos,
    keywords: a.keywords.map((r) => keywordReportJson(r, a.now, compact)),
    shareOfVoice: a.shareOfVoice.map((s) => ({
      platform: s.platform,
      label: platformLabel(s.platform),
      totalUploads: s.totalUploads,
      items: s.items.map((i) => ({ ...i, viewShare: m(i.viewShare) })),
    })),
    notes: a.notes,
  };
}

export function keywordsPayload(index: DatasetIndex, r: KeywordRequest) {
  const a = runKeywordRequest(index, r);
  return {
    query: {
      q: r.keywords,
      match: r.match,
      fields: r.fields,
      range: rangeEcho(r.range),
      tz: r.tz,
      asOf: r.now,
      platforms: r.platforms,
      cats: r.categories,
      langs: r.languages,
      top: r.top,
      format: r.output,
    },
    ...keywordAnalysisJson(a, r.range.rollingHours),
  };
}

function csvFilename(r: KeywordRequest, now: number): string {
  const stamp = new Date(now).toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  const range = r.range.spec.replace(/[^A-Za-z0-9.-]+/g, '_').replace(/\.\./g, '_');
  return `vti-keywords-${range}-${stamp}.csv`;
}

export function registerKeywords(app: Hono, deps: RouteDeps): void {
  app.get('/keywords', (c) => {
    const index = requireIndex(deps);
    const key = cacheKeyOf(c);
    const hit = deps.cache.get(index, key);
    if (hit) return respond(c, hit);
    const req = parseKeywordRequest(Params.of(c.req.url), index);
    let res;
    if (req.output === 'csv') {
      const a = runKeywordRequest(index, req);
      res = {
        body: keywordTopVideosCsv(a, req.tz),
        contentType: 'text/csv; charset=utf-8',
        headers: { 'Content-Disposition': `attachment; filename="${csvFilename(req, a.now)}"`, 'X-Total-Count': String(a.keywords.reduce((n, k) => n + k.topVideos.length, 0)) },
      };
    } else {
      res = { body: JSON.stringify(keywordsPayload(index, req)), contentType: 'application/json; charset=utf-8' };
    }
    deps.cache.set(index, key, res);
    return respond(c, res);
  });
}

/* ------------------------------------------------------------------------------------------ static files */

/** A seed keyword to precompute (packages/collector/seeds/keywords.json entries, or plain strings). */
export interface StaticKeywordSeed {
  keyword: string;
  category?: string | null;
  language?: string | null;
}

/** Parse a seeds file's JSON (array of { keyword, category?, language? } or strings); invalid entries are dropped. */
export function parseKeywordSeeds(data: unknown): StaticKeywordSeed[] {
  if (!Array.isArray(data)) return [];
  const out: StaticKeywordSeed[] = [];
  for (const e of data) {
    const s: StaticKeywordSeed | null =
      typeof e === 'string'
        ? { keyword: e }
        : e && typeof e === 'object' && typeof (e as { keyword?: unknown }).keyword === 'string'
          ? {
              keyword: (e as { keyword: string }).keyword,
              category: typeof (e as { category?: unknown }).category === 'string' ? (e as { category: string }).category : null,
              language: typeof (e as { language?: unknown }).language === 'string' ? (e as { language: string }).language : null,
            }
          : null;
    if (!s || !s.keyword.trim() || s.keyword.length > MAX_KEYWORD_CHARS) continue;
    try {
      compileKeyword(s.keyword);
    } catch {
      continue;
    }
    out.push(s);
  }
  return out;
}

/**
 * Lazy builders for keywords/<i>.json (one seed keyword each, rolling 7 days, compact rows) and
 * keywords/index.json (every seed with its headline numbers). Reports are computed once and shared.
 */
export function staticKeywordFiles(index: DatasetIndex, seeds: readonly StaticKeywordSeed[], tz: string) {
  const now = index.dataset.generatedAt;
  const preset = STATIC_KEYWORD_PRESET;
  const range: ResolvedRangeParam = { spec: preset, preset, range: presetRange(preset, tz, now), rollingHours: presetRollingHours(preset), explicit: true };
  const header = { apiVersion: API_VERSION, generatedAt: now, generatedAtIso: isoOf(now), tz };
  const cache = new Map<number, KeywordAnalysis>();
  const analysis = (i: number): KeywordAnalysis => {
    let a = cache.get(i);
    if (!a) {
      a = analyzeKeywords(index, { keywords: [seeds[i].keyword], range: range.range, rollingHours: range.rollingHours, tz, now, topVideos: STATIC_KEYWORD_TOP, topCreators: 10, relatedTopics: 10 });
      cache.set(i, a);
    }
    return a;
  };
  const seedJson = (i: number) => ({ index: i, keyword: seeds[i].keyword, category: seeds[i].category ?? null, language: seeds[i].language ?? null });
  const file = (i: number) => {
    const a = analysis(i);
    const json = keywordAnalysisJson(a, range.rollingHours, true);
    const { keywords, shareOfVoice: _sov, ...rest } = json;
    return { ...header, seed: seedJson(i), query: { q: [seeds[i].keyword], match: 'all', range: rangeEcho(range), tz, top: STATIC_KEYWORD_TOP }, ...rest, report: keywords[0] };
  };
  const indexFile = () => ({
    ...header,
    description:
      '수집기 시드 키워드(packages/collector/seeds/keywords.json)별 키워드 분석 보고서(최근 168시간, 조회 발생 기간 기준). 추적 중인 영상 범위 안의 결과이며 플랫폼 전체 검색량이 아닙니다. 다른 키워드·기간은 서버 API /api/v1/keywords?q=... 또는 웹 앱의 키워드 분석을 사용하세요.',
    range: rangeEcho(range),
    keywords: seeds.map((_, i) => {
      const r = analysis(i).keywords[0];
      return {
        ...seedJson(i),
        path: `keywords/${i}.json`,
        videos: r.videos,
        uploadsInWindow: r.uploadsInWindow,
        viewsPeriod: { value: r.viewsPeriod.value, status: r.viewsPeriod.status, crossPlatform: r.viewsPeriod.crossPlatform },
        platforms: r.platforms.map((p) => p.platform),
      };
    }),
  });
  return { file, indexFile, count: seeds.length };
}
