/**
 * Pure page logic for 기회 탐색 (/explore, Tubular Viewpoint Explore): per-platform upload counts in the
 * window (to pick / label the platform), the provenance of each topic's demand value (how many of its
 * videos' latest views are lower bounds), quadrants and page notes. Mirrors core computeOpportunities'
 * candidate rules (uploaded in [start, min(end, now)), category / language filters). No React; tested.
 */
import { PLATFORMS, compileVideoFilter, cumulativeAsOf, indexAsOf, resolveAnalysisWindow } from '@vti/core';
import type { DatasetIndex, LocalDateRange, MetricStatus, MetricValue, OpportunityItem, Platform, UtcWindow, Video } from '@vti/core';

export interface ExploreScope {
  range: LocalDateRange;
  rollingHours?: number | null;
  tz: string;
  now: number;
  categories?: string[];
  languages?: string[];
}

interface Candidates {
  window: UtcWindow;
  videos: Video[];
  now: number;
}

function candidates(index: DatasetIndex, s: ExploreScope): Candidates {
  const w = resolveAnalysisWindow(s.range, s.tz, s.now, s.rollingHours);
  const end = Math.min(w.endMs, s.now);
  const idx = indexAsOf(index, s.now);
  const matches = compileVideoFilter(idx, { categories: s.categories, languages: s.languages });
  const videos: Video[] = [];
  for (const v of idx.dataset.videos) {
    if (v.publishedAt < w.startMs || v.publishedAt >= w.endMs || v.publishedAt > end) continue;
    if (matches(v)) videos.push(v);
  }
  return { window: w, videos, now: s.now };
}

/* ------------------------------------------------------------------------------------------ summary */

export interface PlatformUploads {
  platform: Platform;
  /** Videos uploaded in the window (tracked set, after category / language filters). */
  uploads: number;
  /** ... of which have at least one topic. */
  withTopics: number;
}

export interface ExploreSummary {
  window: UtcWindow;
  /** Platforms with uploads in the window, canonical order. */
  platforms: PlatformUploads[];
  total: number;
}

/** Uploads in the window per platform (platform-agnostic; used for the platform selector). */
export function exploreSummary(index: DatasetIndex, s: ExploreScope): ExploreSummary {
  const c = candidates(index, s);
  const by = new Map<Platform, PlatformUploads>();
  for (const v of c.videos) {
    let e = by.get(v.platform);
    if (!e) {
      e = { platform: v.platform, uploads: 0, withTopics: 0 };
      by.set(v.platform, e);
    }
    e.uploads++;
    if ((v.topics ?? []).length) e.withTopics++;
  }
  return { window: c.window, platforms: PLATFORMS.filter((p) => by.has(p)).map((p) => by.get(p) as PlatformUploads), total: c.videos.length };
}

/** Same rule as core resolveExplorePlatform: most uploads, ties by canonical platform order. */
export function defaultExplorePlatform(summary: ExploreSummary): Platform | null {
  let best: PlatformUploads | null = null;
  for (const p of summary.platforms) if (!best || p.uploads > best.uploads) best = p;
  return best?.platform ?? null;
}

/* ------------------------------------------------------------------------------------------ demand provenance */

export interface TopicDemandInfo {
  /** Weakest status among the topic's latest-views values (a median of lower bounds is a lower bound). */
  status: MetricStatus;
  /** Latest instant the values refer to. */
  asOf: number | null;
  /** Videos whose latest views are a lower bound (observed before `now`, not readable at `now`). */
  lowerBound: number;
  /** Videos with a views value. */
  valued: number;
}

export interface DemandProvenance {
  byTopic: Record<string, TopicDemandInfo>;
  /** Uploads on the platform in the window. */
  uploads: number;
  /** ... without any topic (not part of any opportunity). */
  withoutTopics: number;
  /** ... whose source provides no views (count toward supply, not demand). */
  noViews: number;
  /** Videos whose latest views value is a lower bound. */
  lowerBoundVideos: number;
}

const STATUS_RANK: Partial<Record<MetricStatus, number>> = { exact: 0, interpolated: 1, source_reported: 2, lower_bound: 3 };

/** Provenance of each topic's demand value on one platform (same candidates as computeOpportunities). */
export function demandProvenance(index: DatasetIndex, s: ExploreScope & { platform: Platform }): DemandProvenance {
  const c = candidates(index, s);
  const byTopic: Record<string, TopicDemandInfo & { rank: number }> = {};
  let uploads = 0;
  let withoutTopics = 0;
  let noViews = 0;
  let lowerBoundVideos = 0;
  for (const v of c.videos) {
    if (v.platform !== s.platform) continue;
    uploads++;
    const topics = [...new Set(v.topics ?? [])];
    if (!topics.length) withoutTopics++;
    const m: MetricValue = cumulativeAsOf(v, 'views', c.now);
    const valued = m.status !== 'unavailable' && typeof m.value === 'number' && Number.isFinite(m.value);
    if (!valued) {
      noViews++;
      continue;
    }
    if (m.status === 'lower_bound') lowerBoundVideos++;
    const rank = STATUS_RANK[m.status] ?? 0;
    for (const t of topics) {
      let e = byTopic[t];
      if (!e) {
        e = { status: 'exact', rank: 0, asOf: null, lowerBound: 0, valued: 0 };
        byTopic[t] = e;
      }
      e.valued++;
      if (m.status === 'lower_bound') e.lowerBound++;
      if (rank > e.rank) {
        e.rank = rank;
        e.status = m.status;
      }
      if (m.asOf !== null && (e.asOf === null || m.asOf > e.asOf)) e.asOf = m.asOf;
    }
  }
  const out: Record<string, TopicDemandInfo> = {};
  for (const [t, e] of Object.entries(byTopic)) out[t] = { status: e.status, asOf: e.asOf, lowerBound: e.lowerBound, valued: e.valued };
  return { byTopic: out, uploads, withoutTopics, noViews, lowerBoundVideos };
}

/** The demand of an opportunity as a MetricValue (median of the topic's latest views). */
export function demandMetric(item: Pick<OpportunityItem, 'demand' | 'topic'>, prov: DemandProvenance | undefined, now: number): MetricValue {
  const info = prov?.byTopic[item.topic];
  return { value: item.demand, status: info?.status ?? 'exact', asOf: info?.asOf ?? now, note: info && info.lowerBound > 0 ? 'partial' : 'median_of_videos' };
}

/* ------------------------------------------------------------------------------------------ quadrants */

export type Quadrant = 'opportunity' | 'competitive' | 'niche' | 'saturated';

export const QUADRANT_LABELS: Record<Quadrant, string> = {
  opportunity: '기회: 수요↑ 공급↓',
  competitive: '경쟁: 수요↑ 공급↑',
  niche: '관심 적음: 수요↓ 공급↓',
  saturated: '포화: 수요↓ 공급↑',
};

export const QUADRANT_SHORT: Record<Quadrant, string> = {
  opportunity: '기회',
  competitive: '경쟁',
  niche: '관심 적음',
  saturated: '포화',
};

/** Quadrant by the 50th percentile on each axis (>= 50 counts as high). */
export function quadrantOf(item: Pick<OpportunityItem, 'demandPercentile' | 'supplyPercentile'>): Quadrant {
  const highDemand = item.demandPercentile >= 50;
  const highSupply = item.supplyPercentile >= 50;
  if (highDemand) return highSupply ? 'competitive' : 'opportunity';
  return highSupply ? 'saturated' : 'niche';
}

export function quadrantCounts(items: readonly OpportunityItem[]): Record<Quadrant, number> {
  const out: Record<Quadrant, number> = { opportunity: 0, competitive: 0, niche: 0, saturated: 0 };
  for (const it of items) out[quadrantOf(it)]++;
  return out;
}

/* ------------------------------------------------------------------------------------------ notes */

/** Korean notes explaining how the explore result was built (shown under the result). */
export function exploreNotes(x: {
  items: readonly OpportunityItem[];
  prov: DemandProvenance | undefined;
  platformLabel: string;
  windowLabel: string;
  minSupply: number;
}): string[] {
  const fmt = (n: number) => n.toLocaleString('ko-KR');
  const notes: string[] = [];
  notes.push(
    `업로드 기간 기준: ${x.windowLabel}에 게시된 ${x.platformLabel} 추적 영상만 봄. 공급 = 그중 주제별 영상 수, 수요 = 주제별 영상의 데이터 기준 시각 누적 조회 중앙값.`,
  );
  if (x.prov) {
    notes.push(
      `${x.platformLabel} 업로드 ${fmt(x.prov.uploads)}개 중 주제가 없는 영상 ${fmt(x.prov.withoutTopics)}개는 어느 주제에도 들어가지 않음` +
        (x.prov.noViews ? `, 조회수를 알 수 없는 영상 ${fmt(x.prov.noViews)}개는 공급에만 셈.` : '.'),
    );
    if (x.prov.lowerBoundVideos > 0) {
      notes.push(
        `마지막 관측이 데이터 기준 시각보다 앞서 누적 조회가 하한값(≥)인 영상 ${fmt(x.prov.lowerBoundVideos)}개가 있음. 이런 영상이 섞인 주제의 수요는 ≥로 표시함(실제 중앙값은 같거나 큼).`,
      );
    }
  }
  notes.push(`조회값이 있는 영상이 ${fmt(x.minSupply)}개 이상인 주제만 비교함. 백분위·점수는 표시된 주제 ${fmt(x.items.length)}개 안에서의 상대 위치임.`);
  const minSupplyTopics = x.items.filter((i) => i.supply === x.minSupply).length;
  if (x.items.length > 0 && minSupplyTopics / x.items.length > 0.3) {
    notes.push(`공급이 최소치(${fmt(x.minSupply)}개)인 주제가 ${fmt(minSupplyTopics)}개로 많아 공급 백분위가 같은 값에 몰림. 최소 영상 수를 올리면 더 안정적임.`);
  }
  notes.push('수요는 기간 안 게시 시점이 서로 다른 영상의 현재 누적값이라, 기간 초반에 올라온 영상이 많은 주제가 유리할 수 있음.');
  return notes;
}

/* ------------------------------------------------------------------------------------------ sample videos */

export interface SampleRow {
  video: Video;
  accountName: string | null;
  /** Latest views as of now (lower bound when the last observation is older than the tolerance). */
  views: MetricValue;
}

/** The sample videos of a topic with their latest views (the values its demand median was taken over). */
export function sampleRows(index: DatasetIndex, input: { ids: string[]; now: number }): SampleRow[] {
  const idx = indexAsOf(index, input.now);
  const out: SampleRow[] = [];
  for (const id of input.ids) {
    const v = idx.videosById.get(id);
    if (!v) continue;
    out.push({ video: v, accountName: idx.accountsById.get(v.accountId)?.name ?? null, views: cumulativeAsOf(v, 'views', input.now) });
  }
  return out;
}
