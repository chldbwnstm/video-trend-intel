/**
 * 브랜드 협업 (DealMaker-lite) page logic: sponsored videos in a period, grouped by brand and by creator.
 * Pure functions over the dataset index (tested in brands.test.ts); the page renders what these return.
 *
 * Honesty rules applied here
 * - Sponsorship comes from `video.sponsorship` (core `detectSponsorship`: public title / description / tags
 *   text only). It is a signal, not contract data.
 * - Period views are core `queryVideos` metrics (`viewsPeriod`), summed with core `sumIncrements`, so a sum
 *   with unmeasured contributors is a lower bound and decreases are excluded (never negative popularity).
 * - Videos whose brand could not be identified are counted separately (`unbranded`), never dropped silently.
 */
import { canonicalBrandName, normalizeText, queryVideos, sumIncrements } from '@vti/core';
import type {
  DatasetIndex,
  DateMode,
  Evidence,
  LocalDateRange,
  MetricValue,
  Platform,
  QueryResult,
  Video,
  VideoQuery,
  VideoRow,
} from '@vti/core';
import { cached, stableStringify } from '../../lib/cache.ts';
import { orderPlatforms } from '../../lib/platform.ts';
import { csvNumber, csvStatusLabel, DATE_MODE_CSV_LABELS, periodCsvFields, periodCsvHeader } from '../creators/csv.ts';

export type SponsorLevelFilter = 'any' | 'disclosed' | 'likely';
export const SPONSOR_LEVELS: SponsorLevelFilter[] = ['any', 'disclosed', 'likely'];
export type BrandDateMode = Extract<DateMode, 'upload' | 'activity'>;
export const BRAND_DATE_MODES: BrandDateMode[] = ['upload', 'activity'];

/** What the summed view metric means in each date mode (UI labels and CSV headers use the same words). */
export const BRAND_PERIOD_LABELS: Record<BrandDateMode, string> = {
  upload: '게시 후 조회',
  activity: '기간 조회 증가',
};

export const LEVEL_LABELS: Record<'disclosed' | 'likely', string> = {
  disclosed: '광고 표기',
  likely: '협찬 추정',
};

export const LEVEL_DESCRIPTIONS: Record<'disclosed' | 'likely', string> = {
  disclosed: "제목·설명·태그에 '유료 광고 포함', '#광고', '협찬', 'sponsored by', '#PR' 같은 명시적 표기가 있음.",
  likely: '명시적 표기는 없지만 할인 코드, 공동구매, 제휴(어필리에이트) 링크 같은 판촉 신호가 있음.',
};

export const EVIDENCE_FIELD_LABELS: Record<Evidence['field'], string> = {
  title: '제목',
  description: '설명',
  tags: '태그',
  sourceCategory: '원천 분류',
  account: '계정 시드',
  manual: '수동 지정',
};

export interface BrandReportInput {
  mode: BrandDateMode;
  range: LocalDateRange;
  rollingHours: number | null;
  tz: string;
  now: number;
  platforms?: Platform[];
  categories?: string[];
  level: SponsorLevelFilter;
  /** Free text: matches brand names, titles, account names/handles (all terms must match). */
  q?: string;
}

export interface NamedCount {
  key: string;
  name: string;
  count: number;
}

export interface PlatformSum {
  platform: Platform;
  videos: number;
  views: MetricValue;
}

export interface BrandRow {
  /** Brand name as detected (canonical curated name when the alias list knows it). */
  name: string;
  /** True when the name is in the curated brand list (vs captured from a 'sponsored by X' style phrase). */
  curated: boolean;
  videos: number;
  disclosed: number;
  likely: number;
  /** Creator/account portfolios that published the brand's videos. */
  creators: NamedCount[];
  platforms: Platform[];
  /** Sum of the period views of the brand's videos (sumIncrements semantics). */
  views: MetricValue;
  /** Per-platform sums (views are not the same unit across platforms). */
  byPlatform: PlatformSum[];
  latestPublishedAt: number;
  /** Video ids, in the order of the report rows (period views desc). */
  videoIds: string[];
}

export interface CreatorBrandRow {
  /** Creator id when the account is linked to a creator, otherwise the account id. */
  key: string;
  kind: 'creator' | 'account';
  name: string;
  platforms: Platform[];
  videos: number;
  disclosed: number;
  likely: number;
  /** Videos without an identified brand. */
  unbranded: number;
  brands: NamedCount[];
  views: MetricValue;
  videoIds: string[];
}

export interface BrandReport {
  query: VideoQuery;
  result: QueryResult;
  /** Sponsored rows after the level and text filters (period views desc, like queryVideos). */
  rows: VideoRow[];
  brands: BrandRow[];
  creators: CreatorBrandRow[];
  totals: {
    videos: number;
    disclosed: number;
    likely: number;
    unbranded: number;
    curatedBrands: number;
    capturedBrands: number;
    platforms: Platform[];
    views: MetricValue;
    byPlatform: PlatformSum[];
  };
  /** Distinct `SponsorshipSignal.version` values present in the rows. */
  versions: string[];
}

/* ------------------------------------------------------------------------------------------ helpers */

/** Core queryVideos through the shared analytics cache (same key as useAnalysis('queryVideos', q)). */
export function cachedQuery(index: DatasetIndex, q: VideoQuery): QueryResult {
  return cached(index, `queryVideos\u0000${stableStringify(q)}`, () => queryVideos(index, q));
}

/** Portfolio key of a video's account: linked creator id, else the account id. */
export function portfolioKeyOf(index: DatasetIndex, accountId: string): { key: string; kind: 'creator' | 'account'; name: string } {
  const creatorId = index.creatorOfAccount.get(accountId);
  if (creatorId) {
    const c = index.creatorsById.get(creatorId);
    return { key: creatorId, kind: 'creator', name: c?.name ?? creatorId };
  }
  const a = index.accountsById.get(accountId);
  return { key: accountId, kind: 'account', name: a?.name ?? a?.handle ?? accountId };
}

/** Whether a detected brand name is part of the curated brand list. */
export function isCuratedBrand(name: string): boolean {
  try {
    return canonicalBrandName(name) === name;
  } catch {
    return false;
  }
}

function textTerms(q: string | undefined): string[] {
  const n = normalizeText(q ?? '');
  return n ? n.split(' ').filter(Boolean) : [];
}

function rowMatches(index: DatasetIndex, row: VideoRow, terms: string[]): boolean {
  if (!terms.length) return true;
  const v = row.video;
  const a = row.account ?? index.accountsById.get(v.accountId);
  const hay = normalizeText([v.title, ...(v.sponsorship?.brands ?? []), a?.name ?? '', a?.handle ?? ''].join('\n'));
  const compact = hay.replace(/\s+/g, '');
  return terms.every((t) => hay.includes(t) || compact.includes(t));
}

function bump(map: Map<string, NamedCount>, key: string, name: string): void {
  const cur = map.get(key);
  if (cur) cur.count++;
  else map.set(key, { key, name, count: 1 });
}

function sortedCounts(map: Map<string, NamedCount>): NamedCount[] {
  return [...map.values()].sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Per-platform sums of `viewsPeriod` for a set of rows. */
export function platformSums(rows: VideoRow[]): PlatformSum[] {
  const by = new Map<Platform, MetricValue[]>();
  for (const r of rows) {
    const list = by.get(r.video.platform);
    if (list) list.push(r.metrics.viewsPeriod);
    else by.set(r.video.platform, [r.metrics.viewsPeriod]);
  }
  return orderPlatforms(by.keys()).map((p) => {
    const values = by.get(p)!;
    return { platform: p, videos: values.length, views: stripSum(sumIncrements(values)) };
  });
}

function stripSum(m: MetricValue & { decreased?: number; unknown?: number }): MetricValue {
  return { value: m.value, status: m.status, asOf: m.asOf, note: m.note };
}

/** Numeric sort value of a summed metric (null = unrankable, sorts last). */
export function sumRankValue(m: MetricValue): number | null {
  if (m.status === 'unavailable' || m.status === 'decrease_flagged') return null;
  return typeof m.value === 'number' && Number.isFinite(m.value) ? m.value : null;
}

/* ------------------------------------------------------------------------------------------ report */

export function brandQuery(input: BrandReportInput): VideoQuery {
  return {
    dateMode: input.mode,
    range: input.range,
    rollingHours: input.rollingHours ?? undefined,
    tz: input.tz,
    now: input.now,
    platforms: input.platforms && input.platforms.length ? input.platforms : undefined,
    categories: input.categories && input.categories.length ? input.categories : undefined,
    sponsored: input.level === 'disclosed' ? 'disclosed' : 'any',
    sort: 'views_period',
    sortDir: 'desc',
  };
}

export function buildBrandReport(index: DatasetIndex, input: BrandReportInput): BrandReport {
  const query = brandQuery(input);
  const result = cachedQuery(index, query);
  const terms = textTerms(input.q);
  const rows = result.rows.filter(
    (r) => r.video.sponsorship && (input.level !== 'likely' || r.video.sponsorship.level === 'likely') && rowMatches(index, r, terms),
  );

  interface BrandAcc {
    rows: VideoRow[];
    disclosed: number;
    likely: number;
    creators: Map<string, NamedCount>;
    latest: number;
  }
  interface CreatorAcc {
    key: string;
    kind: 'creator' | 'account';
    name: string;
    rows: VideoRow[];
    disclosed: number;
    likely: number;
    unbranded: number;
    brands: Map<string, NamedCount>;
  }
  const brands = new Map<string, BrandAcc>();
  const creators = new Map<string, CreatorAcc>();
  const versions = new Set<string>();
  let disclosed = 0;
  let likely = 0;
  let unbranded = 0;

  for (const r of rows) {
    const s = r.video.sponsorship!;
    versions.add(s.version);
    if (s.level === 'disclosed') disclosed++;
    else likely++;
    const owner = portfolioKeyOf(index, r.video.accountId);
    let c = creators.get(owner.key);
    if (!c) {
      c = { ...owner, rows: [], disclosed: 0, likely: 0, unbranded: 0, brands: new Map() };
      creators.set(owner.key, c);
    }
    c.rows.push(r);
    if (s.level === 'disclosed') c.disclosed++;
    else c.likely++;
    const names = [...new Set(s.brands.filter((b) => typeof b === 'string' && b.trim()))];
    if (!names.length) {
      unbranded++;
      c.unbranded++;
    }
    for (const name of names) {
      bump(c.brands, name, name);
      let b = brands.get(name);
      if (!b) {
        b = { rows: [], disclosed: 0, likely: 0, creators: new Map(), latest: -Infinity };
        brands.set(name, b);
      }
      b.rows.push(r);
      if (s.level === 'disclosed') b.disclosed++;
      else b.likely++;
      bump(b.creators, owner.key, owner.name);
      if (r.video.publishedAt > b.latest) b.latest = r.video.publishedAt;
    }
  }

  const brandRows: BrandRow[] = [...brands.entries()].map(([name, b]) => ({
    name,
    curated: isCuratedBrand(name),
    videos: b.rows.length,
    disclosed: b.disclosed,
    likely: b.likely,
    creators: sortedCounts(b.creators),
    platforms: orderPlatforms(b.rows.map((r) => r.video.platform)),
    views: stripSum(sumIncrements(b.rows.map((r) => r.metrics.viewsPeriod))),
    byPlatform: platformSums(b.rows),
    latestPublishedAt: b.latest,
    videoIds: b.rows.map((r) => r.video.id),
  }));
  brandRows.sort(compareBrands('views'));

  const creatorRows: CreatorBrandRow[] = [...creators.values()].map((c) => ({
    key: c.key,
    kind: c.kind,
    name: c.name,
    platforms: orderPlatforms(c.rows.map((r) => r.video.platform)),
    videos: c.rows.length,
    disclosed: c.disclosed,
    likely: c.likely,
    unbranded: c.unbranded,
    brands: sortedCounts(c.brands),
    views: stripSum(sumIncrements(c.rows.map((r) => r.metrics.viewsPeriod))),
    videoIds: c.rows.map((r) => r.video.id),
  }));
  creatorRows.sort(
    (a, b) =>
      b.videos - a.videos ||
      (sumRankValue(b.views) ?? -1) - (sumRankValue(a.views) ?? -1) ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );

  const curatedBrands = brandRows.filter((b) => b.curated).length;
  return {
    query,
    result,
    rows,
    brands: brandRows,
    creators: creatorRows,
    totals: {
      videos: rows.length,
      disclosed,
      likely,
      unbranded,
      curatedBrands,
      capturedBrands: brandRows.length - curatedBrands,
      platforms: orderPlatforms(rows.map((r) => r.video.platform)),
      views: stripSum(sumIncrements(rows.map((r) => r.metrics.viewsPeriod))),
      byPlatform: platformSums(rows),
    },
    versions: [...versions].sort(),
  };
}

export type BrandSort = 'views' | 'videos' | 'creators' | 'latest';
export const BRAND_SORTS: BrandSort[] = ['views', 'videos', 'creators', 'latest'];

/** Comparator for the brand leaderboard; unrankable sums go last, ties by video count then name. */
export function compareBrands(sort: BrandSort): (a: BrandRow, b: BrandRow) => number {
  const byName = (a: BrandRow, b: BrandRow) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const byViews = (a: BrandRow, b: BrandRow) => {
    const x = sumRankValue(a.views);
    const y = sumRankValue(b.views);
    if (x === y) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return y - x;
  };
  switch (sort) {
    case 'videos':
      return (a, b) => b.videos - a.videos || byViews(a, b) || byName(a, b);
    case 'creators':
      return (a, b) => b.creators.length - a.creators.length || b.videos - a.videos || byName(a, b);
    case 'latest':
      return (a, b) => b.latestPublishedAt - a.latestPublishedAt || b.videos - a.videos || byName(a, b);
    case 'views':
    default:
      return (a, b) => byViews(a, b) || b.videos - a.videos || byName(a, b);
  }
}

export function sortBrands(rows: BrandRow[], sort: BrandSort, dir: 'asc' | 'desc' = 'desc'): BrandRow[] {
  const cmp = compareBrands(sort);
  const out = [...rows].sort(cmp);
  if (dir === 'asc') {
    // Flip the primary order but keep unrankable sums last.
    const ranked = out.filter((r) => sort !== 'views' || sumRankValue(r.views) !== null).reverse();
    const rest = out.filter((r) => sort === 'views' && sumRankValue(r.views) === null);
    return [...ranked, ...rest];
  }
  return out;
}

/* ------------------------------------------------------------------------------------------ evidence */

export interface EvidenceSnippet {
  field: Evidence['field'];
  before: string;
  match: string;
  after: string;
  /** True when text was cut before / after the snippet. */
  cutStart: boolean;
  cutEnd: boolean;
}

function fieldText(video: Pick<Video, 'title' | 'description' | 'tags'>, field: Evidence['field']): string {
  if (field === 'title') return video.title ?? '';
  if (field === 'description') return video.description ?? '';
  if (field === 'tags') return (video.tags ?? []).join(', ');
  return '';
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The text around an evidence match in the video's own title / description / tags, for display as plain
 * text (the page highlights `match` with a <mark> element; nothing is rendered as HTML).
 * The detector normalizes text (NFKC, collapsed spaces, lowercase); this finds the same span in the
 * NFKC text, tolerating different spacing ('광고 포함' ~ '광고포함'). Null when not found.
 */
export function evidenceSnippet(video: Pick<Video, 'title' | 'description' | 'tags'>, ev: Evidence, radius = 48): EvidenceSnippet | null {
  const raw = fieldText(video, ev.field);
  if (!raw || !ev.match) return null;
  const text = raw.normalize('NFKC').replace(/\s+/g, ' ');
  const needle = ev.match.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!needle) return null;
  let start = -1;
  let end = -1;
  const lower = text.toLowerCase();
  if (lower.length === text.length) {
    const i = lower.indexOf(needle.toLowerCase());
    if (i >= 0) {
      start = i;
      end = i + needle.length;
    }
  }
  if (start < 0) {
    const pattern = needle
      .replace(/\s+/g, '')
      .split('')
      .map(escapeRe)
      .join('\\s*');
    try {
      const m = new RegExp(pattern, 'iu').exec(text);
      if (m) {
        start = m.index;
        end = m.index + m[0].length;
      }
    } catch {
      return null;
    }
  }
  if (start < 0) return null;
  const from = Math.max(0, start - radius);
  const to = Math.min(text.length, end + radius);
  return {
    field: ev.field,
    before: text.slice(from, start),
    match: text.slice(start, end),
    after: text.slice(end, to),
    cutStart: from > 0,
    cutEnd: to < text.length,
  };
}

/** Evidence entries worth showing: de-duplicated by field + normalized match, cue labels first. */
export function uniqueEvidence(evidence: Evidence[]): Evidence[] {
  const seen = new Set<string>();
  const out: Evidence[] = [];
  for (const e of evidence) {
    const k = `${e.field}|${normalizeText(e.match)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

/* ------------------------------------------------------------------------------------------ csv rows */

/**
 * Brand leaderboard as CSV rows (for `toCsv`). The value column is named after the date mode (게시 후 조회 합계 /
 * 기간 조회 증가 합계, as in the UI) and every row carries the period context (window start / end, zone,
 * finished / running / rolling, date semantics, data as-of). `fmt` formats instants in the display zone.
 */
export function brandCsvRows(report: BrandReport, fmt: (ms: number) => string): (string | number | null)[][] {
  const mode: BrandDateMode = report.query.dateMode === 'activity' ? 'activity' : 'upload';
  const sumLabel = `${BRAND_PERIOD_LABELS[mode]} 합계`;
  const w = report.result.window;
  const tz = w?.tz ?? report.query.tz ?? 'UTC';
  const period = w
    ? periodCsvFields({ window: w, rollingHours: report.query.rollingHours ?? null, now: report.result.now, dateMode: DATE_MODE_CSV_LABELS[mode] })
    : [];
  const header = [
    '브랜드',
    '브랜드 목록 여부',
    '영상 수',
    '광고 표기',
    '협찬 추정',
    '크리에이터 수',
    '크리에이터',
    '플랫폼',
    sumLabel,
    `${sumLabel} 상태`,
    `${sumLabel} 기준 시각(${tz})`,
    `최근 게시(${tz})`,
    ...(w ? periodCsvHeader(tz) : []),
  ];
  const rows = report.brands.map((b) => [
    b.name,
    b.curated ? '목록 브랜드' : '자동 추출',
    b.videos,
    b.disclosed,
    b.likely,
    b.creators.length,
    b.creators.map((c) => c.name).join(' | '),
    b.platforms.join(' | '),
    b.views.status === 'unavailable' ? null : csvNumber(b.views.value),
    csvStatusLabel(b.views),
    b.views.asOf !== null ? fmt(b.views.asOf) : null,
    Number.isFinite(b.latestPublishedAt) ? fmt(b.latestPublishedAt) : null,
    ...period,
  ]);
  return [header, ...rows];
}
