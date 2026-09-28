/**
 * Explore (Tubular Viewpoint "Explore"): topics with high views-per-video but low supply. OWNER: core-analytics agent.
 */
import type { LocalDateRange, OpportunityItem, Platform, Video } from './types.ts';
import { PLATFORMS } from './types.ts';
import type { DatasetIndex } from './dataset.ts';
import { resolveAnalysisWindow } from './time.ts';
import { cumulativeAsOf } from './metrics.ts';
import { compareIds, compileVideoFilter, indexAsOf, medianOf, percentileRanks, resolveNow } from './query.ts';

export interface ExploreOptions {
  range: LocalDateRange;
  /** Rolling window [now - rollingHours, now) instead of the calendar range. */
  rollingHours?: number | null;
  tz: string;
  now?: number;
  platform?: Platform;
  categories?: string[];
  languages?: string[];
  /** Min videos per topic. Default 3. */
  minSupply?: number;
  limit?: number;
}

/** Default number of opportunities returned. */
export const EXPLORE_DEFAULT_LIMIT = 50;
/** Default minimum videos per topic. */
export const EXPLORE_DEFAULT_MIN_SUPPLY = 3;
/** Sample videos kept per topic. */
export const EXPLORE_SAMPLE_VIDEOS = 5;

interface Candidates {
  now: number;
  index: DatasetIndex;
  startMs: number;
  endMs: number;
  videos: Video[];
}

/** Videos uploaded in the window (clipped to now) that match the category / language filters, any platform. */
function candidates(index: DatasetIndex, opts: ExploreOptions): Candidates {
  const now = resolveNow(index, opts.now);
  const w = resolveAnalysisWindow(opts.range, opts.tz, now, opts.rollingHours);
  const endMs = Math.min(w.endMs, now);
  const idx = indexAsOf(index, now);
  const matches = compileVideoFilter(idx, { categories: opts.categories, languages: opts.languages });
  const videos: Video[] = [];
  for (const v of idx.dataset.videos) {
    if (v.publishedAt < w.startMs || v.publishedAt >= w.endMs || v.publishedAt > endMs) continue;
    if (matches(v)) videos.push(v);
  }
  return { now, index: idx, startMs: w.startMs, endMs, videos };
}

function pickPlatform(videos: Video[]): Platform | null {
  const counts = new Map<Platform, number>();
  for (const v of videos) counts.set(v.platform, (counts.get(v.platform) ?? 0) + 1);
  let best: Platform | null = null;
  let bestN = 0;
  for (const p of PLATFORMS) {
    const n = counts.get(p) ?? 0;
    if (n > bestN) {
      best = p;
      bestN = n;
    }
  }
  return best;
}

/**
 * The platform computeOpportunities analyses for `opts`: opts.platform, else the platform with the most
 * videos uploaded in the window after the category / language filters (ties: PLATFORMS order); null when
 * there are none. Lets the UI say which platform an unspecified Explore view is about.
 */
export function resolveExplorePlatform(index: DatasetIndex, opts: ExploreOptions): Platform | null {
  if (opts.platform) return opts.platform;
  return pickPlatform(candidates(index, opts).videos);
}

/**
 * Demand = median views (latest, as of now) of videos uploaded in the window per topic; supply = count of those videos
 * in OUR tracked set. Computed within a single platform (opts.platform, or the platform with most videos if omitted).
 *
 * Details
 * - "Latest views" = cumulativeAsOf(views, now): the value at `now`, or the latest earlier observation (a lower
 *   bound). Videos whose source does not provide views count toward supply but not demand.
 * - A topic is listed when it has at least `minSupply` (default 3) videos with a views value.
 * - demandPercentile / supplyPercentile: mid-rank percentiles (0..100) among the listed topics;
 *   score = demandPercentile - supplyPercentile (high = many views per video, few uploads).
 * - Sorted by score desc, then demand desc, supply asc, topic asc; cut to `limit` (default 50).
 * - sampleVideoIds: up to 5 of the topic's videos with the most views.
 * - The dataset is read as known at `now` (indexAsOf); a still-running window only counts uploads up to `now`.
 */
export function computeOpportunities(index: DatasetIndex, opts: ExploreOptions): OpportunityItem[] {
  const c = candidates(index, opts);
  const platform = opts.platform ?? pickPlatform(c.videos);
  if (!platform) return [];
  const minSupply = Number.isFinite(opts.minSupply) ? Math.max(1, Math.floor(opts.minSupply as number)) : EXPLORE_DEFAULT_MIN_SUPPLY;
  const limit = Number.isFinite(opts.limit) ? Math.max(0, Math.floor(opts.limit as number)) : EXPLORE_DEFAULT_LIMIT;

  const byTopic = new Map<string, { supply: number; views: { id: string; value: number }[] }>();
  for (const v of c.videos) {
    if (v.platform !== platform) continue;
    const topics = [...new Set(v.topics ?? [])];
    if (!topics.length) continue;
    const m = cumulativeAsOf(v, 'views', c.now);
    const value = m.status !== 'unavailable' && typeof m.value === 'number' && Number.isFinite(m.value) ? m.value : null;
    for (const t of topics) {
      let e = byTopic.get(t);
      if (!e) {
        e = { supply: 0, views: [] };
        byTopic.set(t, e);
      }
      e.supply++;
      if (value !== null) e.views.push({ id: v.id, value });
    }
  }

  const eligible: { topic: string; demand: number; supply: number; sample: string[] }[] = [];
  for (const [topic, e] of byTopic) {
    if (e.views.length < minSupply) continue;
    e.views.sort((a, b) => b.value - a.value || compareIds(a.id, b.id));
    eligible.push({
      topic,
      demand: medianOf(e.views.map((x) => x.value)) as number,
      supply: e.supply,
      sample: e.views.slice(0, EXPLORE_SAMPLE_VIDEOS).map((x) => x.id),
    });
  }
  const demandPct = percentileRanks(eligible.map((x) => x.demand));
  const supplyPct = percentileRanks(eligible.map((x) => x.supply));
  const items: OpportunityItem[] = eligible.map((x, i) => ({
    topic: x.topic,
    label: x.topic,
    demand: x.demand,
    supply: x.supply,
    demandPercentile: demandPct[i],
    supplyPercentile: supplyPct[i],
    score: demandPct[i] - supplyPct[i],
    sampleVideoIds: x.sample,
  }));
  items.sort((a, b) => b.score - a.score || b.demand - a.demand || a.supply - b.supply || compareIds(a.topic, b.topic));
  return items.slice(0, limit);
}
