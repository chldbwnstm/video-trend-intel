/**
 * Trending (Tubular "Trending"): rising / falling topics, categories, creators, accounts. OWNER: core-analytics agent.
 */
import type { LocalDateRange, MetricValue, Platform, TrendEntityKind, TrendingResult, TrendItem, UtcWindow, Video } from './types.ts';
import type { DatasetIndex } from './dataset.ts';
import { HOUR, localDateOf, previousWindow, resolveAnalysisWindow } from './time.ts';
import { increment } from './series.ts';
import { windowIncrement } from './metrics.ts';
import { ancestorsOf, categoryPathLabel } from './taxonomy.ts';
import { categoryFilterSet, compareIds, compileVideoFilter, crossPlatformNote, indexAsOf, instantLabel, isSummableMetric, resolveNow } from './query.ts';

export interface TrendingOptions {
  kind: TrendEntityKind;
  range: LocalDateRange;
  /** Rolling window [now - rollingHours, now) instead of the calendar range (see rollingWindow). */
  rollingHours?: number | null;
  tz: string;
  now?: number;
  platforms?: Platform[];
  categories?: string[];
  languages?: string[];
  /** Minimum contributing videos for an entity to be listed. Default 3. */
  minVideos?: number;
  limit?: number;
  /**
   * Volume threshold for the rising / falling lists (guards against "10 -> 50 views = +400%"): rising needs
   * current >= minCurrent, falling needs previous >= minCurrent. Default: the lower quartile of the listed
   * entities' positive current (rising) / previous (falling) sums, at least 1.
   */
  minCurrent?: number;
}

/** Default number of items per list. */
export const TRENDING_DEFAULT_LIMIT = 20;
/** Default minimum contributing videos per entity. */
export const TRENDING_DEFAULT_MIN_VIDEOS = 3;
/** Number of top video ids kept per entity. */
export const TRENDING_TOP_VIDEOS = 5;

interface Agg {
  key: string;
  current: number;
  previous: number;
  videoCount: number;
  incompleteCount: number;
  platforms: Set<Platform>;
  top: { id: string; value: number }[];
}

/** Lower quartile (nearest rank) of positive values, at least 1. */
function lowerQuartileThreshold(values: number[]): number {
  const pos = values.filter((x) => x > 0).sort((a, b) => a - b);
  if (!pos.length) return 1;
  return Math.max(1, pos[Math.max(0, Math.ceil(0.25 * pos.length) - 1)]);
}

function entityKeys(kind: TrendEntityKind, v: Video, index: DatasetIndex): string[] {
  switch (kind) {
    case 'topic':
      return [...new Set(v.topics ?? [])];
    case 'category': {
      const s = new Set<string>();
      for (const c of v.categories ?? []) for (const a of ancestorsOf(c.id)) s.add(a);
      return [...s];
    }
    case 'creator':
      return [index.creatorOfAccount.get(v.accountId) ?? v.accountId];
    case 'account':
      return [v.accountId];
    default: {
      const never: never = kind;
      throw new RangeError(`Unknown trend entity kind: ${String(never)}`);
    }
  }
}

function entityLabel(kind: TrendEntityKind, key: string, index: DatasetIndex): string {
  if (kind === 'category') return categoryPathLabel(key);
  if (kind === 'creator') {
    const c = index.creatorsById.get(key);
    if (c) return c.name;
    return index.accountsById.get(key)?.name ?? key;
  }
  if (kind === 'account') return index.accountsById.get(key)?.name ?? key;
  return key;
}

/**
 * Aggregate view increments per entity for the window and the previous equal-length window.
 * Only exact/interpolated/source_reported increments are summed; lower_bound/unavailable are counted in incompleteCount.
 * When the platforms in scope are more than one, add a note that cross-platform view units differ.
 *
 * Details
 * - Entities: topic = each of video.topics; category = every assigned taxonomy id plus its ancestors (so a
 *   top-level family aggregates its subcategories; with a category filter only ids inside the filtered subtrees
 *   are listed); creator = the linked creator of the video's account, else the account; account = video.accountId.
 * - Scope: videos matching platforms / categories (incl. descendants) / languages, published before the end of
 *   the current window (clipped to `now`). The dataset is read as known at `now` (indexAsOf).
 * - Like-for-like: a video is summed only when BOTH its current and previous increments are known
 *   (exact / interpolated / source_reported; a video published after the previous window counts 0 there), so
 *   growth never compares a fully observed period with a partially observed one. Videos with a lower_bound /
 *   unavailable increment in either window are counted in incompleteCount; decreasing counters
 *   (deletion / correction) are excluded and reported in the notes, never ranked as negative popularity.
 * - A still-running window is compared with the same elapsed span of the previous window
 *   (`previousWindow` in the result is that compared span).
 * - videoCount = summed (like-for-like) videos; entities need videoCount >= minVideos (default 3).
 * - growth = current / previous - 1, null when previous is 0.
 * - rising: growth > 0 and current >= minCurrent, by growth desc; falling: growth < 0 and previous >= minCurrent,
 *   by growth asc; top: current > 0 by current desc. Ties: key asc. Each list is cut to `limit` (default 20).
 * - platform = the single platform of an entity's summed videos, null when they span several.
 */
export function computeTrending(index: DatasetIndex, opts: TrendingOptions): TrendingResult {
  const { kind, tz } = opts;
  if (!['topic', 'category', 'creator', 'account'].includes(kind)) throw new RangeError(`Unknown trend entity kind: ${String(kind)}`);
  const now = resolveNow(index, opts.now);
  const w = resolveAnalysisWindow(opts.range, tz, now, opts.rollingHours);
  const curEnd = Math.min(w.endMs, now);
  const prevFull = previousWindow(w, now);
  const prevEnd = w.endMs > now ? Math.max(prevFull.startMs, Math.min(prevFull.startMs + (curEnd - w.startMs), prevFull.endMs)) : prevFull.endMs;
  const prevW: UtcWindow = { startMs: prevFull.startMs, endMs: prevEnd, tz: w.tz, incomplete: prevFull.incomplete };
  const minVideos = Number.isFinite(opts.minVideos) ? Math.max(1, Math.floor(opts.minVideos as number)) : TRENDING_DEFAULT_MIN_VIDEOS;
  const limit = Number.isFinite(opts.limit) ? Math.max(0, Math.floor(opts.limit as number)) : TRENDING_DEFAULT_LIMIT;

  const notes: string[] = [];
  const windowLabel = (x: UtcWindow) => {
    const s = localDateOf(x.startMs, tz);
    const e = localDateOf(Math.max(x.startMs, x.endMs - 1), tz);
    return s === e ? s : `${s}~${e}`;
  };

  if (curEnd <= w.startMs) {
    notes.push(`선택한 기간(${windowLabel(w)}, ${tz})이 데이터 기준 시각 ${instantLabel(now, tz)} 이후라 아직 집계할 조회 증가가 없습니다.`);
    return { window: w, previousWindow: prevW, rising: [], falling: [], top: [], notes };
  }

  const idx = indexAsOf(index, now);
  const matches = compileVideoFilter(idx, { platforms: opts.platforms, categories: opts.categories, languages: opts.languages });
  // With a category filter, category entities stay inside the filtered subtree (an ancestor such as 'beauty'
  // aggregated over 'beauty/skincare' videos only would be misleading).
  const categoryScope = kind === 'category' ? categoryFilterSet(opts.categories) : null;
  const aggs = new Map<string, Agg>();
  const scopePlatforms = new Set<Platform>();
  let inScope = 0;
  let comparable = 0;
  let incomplete = 0;
  let notProvided = 0;
  let decreased = 0;
  let sourceReported = 0;

  for (const v of idx.dataset.videos) {
    if (v.publishedAt >= curEnd) continue;
    if (!matches(v)) continue;
    let keys = entityKeys(kind, v, idx);
    if (categoryScope) keys = keys.filter((k) => categoryScope.has(k));
    if (!keys.length) continue;
    inScope++;
    scopePlatforms.add(v.platform);
    const cur: MetricValue = windowIncrement(v, 'views', w, now);
    const prev: MetricValue = increment(v, 'views', prevW.startMs, prevW.endMs, now);
    let state: 'ok' | 'incomplete' | 'decreased';
    if (cur.status === 'decrease_flagged' || prev.status === 'decrease_flagged') state = 'decreased';
    else if (isSummableMetric(cur) && isSummableMetric(prev)) state = 'ok';
    else state = 'incomplete';

    if (state === 'decreased') {
      decreased++;
      continue;
    }
    if (state === 'incomplete') {
      incomplete++;
      if (cur.note === 'counter_not_provided' || prev.note === 'counter_not_provided') notProvided++;
    } else {
      comparable++;
      if (cur.status === 'source_reported') sourceReported++;
    }
    for (const key of keys) {
      let a = aggs.get(key);
      if (!a) {
        a = { key, current: 0, previous: 0, videoCount: 0, incompleteCount: 0, platforms: new Set(), top: [] };
        aggs.set(key, a);
      }
      if (state === 'incomplete') {
        a.incompleteCount++;
        continue;
      }
      a.current += cur.value as number;
      a.previous += prev.value as number;
      a.videoCount++;
      a.platforms.add(v.platform);
      a.top.push({ id: v.id, value: cur.value as number });
    }
  }

  const items: TrendItem[] = [];
  for (const a of aggs.values()) {
    if (a.videoCount < minVideos) continue;
    a.top.sort((x, y) => y.value - x.value || compareIds(x.id, y.id));
    let platform: Platform | null = a.platforms.size === 1 ? [...a.platforms][0] : null;
    if (kind === 'account') platform = idx.accountsById.get(a.key)?.platform ?? platform;
    items.push({
      kind,
      key: a.key,
      label: entityLabel(kind, a.key, idx),
      platform,
      current: a.current,
      previous: a.previous,
      growth: a.previous > 0 ? a.current / a.previous - 1 : null,
      videoCount: a.videoCount,
      incompleteCount: a.incompleteCount,
      topVideoIds: a.top.slice(0, TRENDING_TOP_VIDEOS).map((t) => t.id),
    });
  }

  const explicitMin = Number.isFinite(opts.minCurrent) ? Math.max(0, opts.minCurrent as number) : null;
  const risingMin = explicitMin ?? lowerQuartileThreshold(items.map((i) => i.current));
  const fallingMin = explicitMin ?? lowerQuartileThreshold(items.map((i) => i.previous));
  const byKey = (x: TrendItem, y: TrendItem) => compareIds(x.key, y.key);
  const rising = items
    .filter((i) => i.growth !== null && i.growth > 0 && i.current >= risingMin)
    .sort((x, y) => (y.growth as number) - (x.growth as number) || y.current - x.current || byKey(x, y))
    .slice(0, limit);
  const falling = items
    .filter((i) => i.growth !== null && i.growth < 0 && i.previous >= fallingMin)
    .sort((x, y) => (x.growth as number) - (y.growth as number) || y.previous - x.previous || byKey(x, y))
    .slice(0, limit);
  const top = items
    .filter((i) => i.current > 0)
    .sort((x, y) => y.current - x.current || byKey(x, y))
    .slice(0, limit);

  // Notes (Korean).
  const fmt = (n: number) => n.toLocaleString('ko-KR');
  notes.push(
    `조회 발생 기간 기준: 게시일과 관계없이 ${windowLabel(w)}(${tz}) 동안 늘어난 조회수를 직전 같은 길이 기간(${windowLabel(prevW)})과 비교합니다.`,
  );
  if (w.incomplete) {
    const hours = Math.round((curEnd - w.startMs) / HOUR);
    notes.push(
      `기간이 아직 끝나지 않아(데이터 기준 ${instantLabel(now, tz)}) 직전 기간도 같은 경과 시간(약 ${fmt(hours)}시간)까지만 잘라 비교합니다.`,
    );
  }
  notes.push(
    `현재·직전 기간 증가량을 모두 계산할 수 있는 영상만 합산합니다(같은 영상 집합 비교). 대상 영상 ${fmt(inScope)}개 중 ${fmt(comparable)}개를 합산했습니다.`,
  );
  if (incomplete > 0) {
    notes.push(
      `경계 관측이 부족해 증가량이 하한값이거나 계산할 수 없는 영상 ${fmt(incomplete)}개는 합산하지 않고 항목별 '불완전' 수로 표시합니다` +
        (notProvided > 0 ? `(그중 ${fmt(notProvided)}개는 원천이 조회수를 제공하지 않음).` : '.'),
    );
  }
  if (decreased > 0) {
    notes.push(`조회수가 줄어든 영상 ${fmt(decreased)}개(삭제·정정·수집 오류 가능)는 음수 인기로 순위에 반영하지 않고 제외했습니다.`);
  }
  if (sourceReported > 0) {
    notes.push(`현재 기간 증가량 중 ${fmt(sourceReported)}개는 원천이 직접 집계한 기간 지표(원천 보고값)입니다.`);
  }
  notes.push(
    `목록에는 합산 영상이 ${fmt(minVideos)}개 이상인 항목만 표시합니다. 상승 목록은 이번 기간 증가량 ${fmt(Math.ceil(risingMin))} 이상, ` +
      `하락 목록은 직전 기간 증가량 ${fmt(Math.ceil(fallingMin))} 이상인 항목만 성장률로 정렬합니다(작은 기준값에서 성장률이 과장되는 것 방지).`,
  );
  const fresh = items.filter((i) => i.growth === null && i.current > 0).length;
  if (fresh > 0) {
    notes.push(`직전 기간 증가량이 0이라 성장률을 정의할 수 없는 새 항목 ${fmt(fresh)}개는 상승 목록 대신 '상위' 목록에서 확인하세요.`);
  }
  if (kind === 'creator') {
    notes.push('크리에이터에 연결된 계정은 여러 플랫폼을 합산하고, 연결되지 않은 계정은 계정 단위로 표시합니다.');
  }
  if (kind === 'category') {
    notes.push('분야는 상위 분야와 세부 분야를 모두 집계하며, 세부 분야 영상은 상위 분야 합계에도 포함됩니다.');
  }
  if (scopePlatforms.size > 1) {
    notes.push(`${crossPlatformNote(scopePlatforms, '집계 대상')} 합계는 참고용이며, 플랫폼을 하나로 좁히면 더 정확히 비교할 수 있습니다.`);
  }
  if (idx !== index) {
    notes.push(`기준 시각 ${instantLabel(now, tz)} 이후에 수집된 관측값·영상은 제외하고 계산했습니다.`);
  }

  return { window: w, previousWindow: prevW, rising, falling, top, notes };
}
