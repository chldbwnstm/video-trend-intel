/**
 * Tiered refresh: which known videos each source should re-observe this run. OWNER: collector-pipeline.
 *
 * The store computes due candidates in priority order (SPEC tiers, see `Store.getRefreshCandidates`); this module
 * decides how many of them an adapter is handed. Adapters consume `refreshIds` in order, skip ids their own
 * discovery already returned in the same run and stop at `maxRequests`, so the most important videos (youngest
 * first) are refreshed first. The pipeline reports afterwards how many due videos were actually re-observed (never
 * a silent cap).
 *
 * - Budget-bound sources (BUDGET_BOUND_REFRESH: the keyless dailymotion / peertube / niconico adapters) get the
 *   WHOLE due list. A count cap applied here, before discovery, would be spent on ids the adapter then skips as
 *   already seen: SepiaSearch's `-publishedAt` seeds return the same fresh videos every run, so a 150-id PeerTube
 *   cap made 0 origin requests per run while 1,225 older videos were never re-observed. Their request budget is
 *   the real limit.
 * - Metered sources (keyed APIs) keep a count cap (quota / cost), bounded by their request budget.
 * - Sources that cannot refresh by id (cap 0: youtube-rss, instagram-graph) still get their due list computed, for
 *   accounting only (how many tracked videos dropped out of the feeds), restricted to videos that source found.
 * - Snapshot sources (niconico: a daily snapshot) do not re-request videos already observed at the newest snapshot
 *   in the store until a newer snapshot can exist; fetching the same snapshot again adds nothing.
 */
import type { SourceAdapter } from './types.ts';
import type { RefreshCandidate, RefreshTier, Store } from './store.ts';

const DAY = 86_400_000;

/**
 * Max refresh ids handed to a metered source per run. 0 = the source cannot refresh by id (youtube-rss only reads
 * channel feeds; instagram-graph has no lookup by media id without per-media tokens).
 */
export const DEFAULT_REFRESH_CAPS: Readonly<Record<string, number>> = {
  'youtube-rss': 0,
  'youtube-data-api': 2500,
  'tiktok-research': 1000,
  'instagram-graph': 0,
  'x-api': 1000,
  twitch: 1000,
};
/** Cap for sources not listed above (and not budget-bound). */
export const DEFAULT_REFRESH_CAP = 500;

/** Sources whose adapters skip ids already returned by their discovery and stop at their request budget. */
export const BUDGET_BOUND_REFRESH: ReadonlySet<string> = new Set(['dailymotion', 'peertube', 'niconico']);

/** Sources whose observations are periodic snapshots, with the snapshot interval. */
export const SNAPSHOT_REFRESH_INTERVAL_MS: Readonly<Record<string, number>> = { niconico: DAY };

/** How many ids one refresh request of the source covers (used to keep the list within maxRequests). */
export const IDS_PER_REQUEST: Readonly<Record<string, number>> = {
  dailymotion: 100,
  peertube: 1,
  niconico: 100,
  'youtube-data-api': 50,
  'tiktok-research': 100,
  'x-api': 100,
  twitch: 100,
};

export interface RefreshSelection {
  source: string;
  /** Ids handed to the adapter, in priority order. */
  ids: string[];
  /** Every due candidate's platform id, in priority order (also for sources that cannot refresh by id). */
  dueIds: string[];
  /** Due candidates before capping. */
  due: number;
  /** Due candidates per tier (before capping). */
  byTier: Partial<Record<RefreshTier['name'], number>>;
  /** Cap that was applied (Infinity when none; 0 = the source cannot refresh by id). */
  cap: number;
  /** Candidates left out because of the cap (not handed to the adapter). */
  skipped: number;
  /** True when the source cannot refresh by id: `dueIds` are only for reporting. */
  accountingOnly: boolean;
  /** Korean note for coverage/run logs when something was cut before the run; null otherwise. */
  note: string | null;
}

export interface SelectRefreshOptions {
  now: number;
  maxRequests?: number;
  /** Per-source overrides of DEFAULT_REFRESH_CAPS (an explicit cap also applies to budget-bound sources). */
  caps?: Record<string, number>;
}

/** Cap for `source` given its per-run request budget (Infinity for budget-bound sources without an override). */
export function refreshCapFor(source: string, maxRequests: number | undefined, caps: Record<string, number> = {}): number {
  const explicit = caps[source];
  if (explicit === undefined && BUDGET_BOUND_REFRESH.has(source)) return Number.POSITIVE_INFINITY;
  const base = explicit ?? DEFAULT_REFRESH_CAPS[source] ?? DEFAULT_REFRESH_CAP;
  if (base <= 0) return 0;
  if (maxRequests === undefined || !Number.isFinite(maxRequests)) return base;
  const perReq = IDS_PER_REQUEST[source] ?? 1;
  return Math.max(0, Math.min(base, Math.floor(maxRequests) * perReq));
}

export function selectRefreshIds(store: Store, adapter: Pick<SourceAdapter, 'id' | 'platform'>, opts: SelectRefreshOptions): RefreshSelection {
  const cap = refreshCapFor(adapter.id, opts.maxRequests, opts.caps);
  const accountingOnly = cap === 0;
  const candidates: RefreshCandidate[] = store.getRefreshCandidates(adapter.id, opts.now, {
    platform: adapter.platform,
    snapshotIntervalMs: SNAPSHOT_REFRESH_INTERVAL_MS[adapter.id],
    // A source that cannot refresh by id only reports on the videos it found itself.
    onlySource: accountingOnly ? adapter.id : undefined,
  });
  const byTier: RefreshSelection['byTier'] = {};
  for (const c of candidates) byTier[c.tier] = (byTier[c.tier] ?? 0) + 1;
  const dueIds = candidates.map((c) => c.platformId);
  if (accountingOnly) {
    return { source: adapter.id, ids: [], dueIds, due: candidates.length, byTier, cap: 0, skipped: 0, accountingOnly: true, note: null };
  }
  const ids = Number.isFinite(cap) ? dueIds.slice(0, cap) : dueIds;
  const skipped = candidates.length - ids.length;
  const note =
    skipped > 0
      ? `갱신 대상 ${candidates.length}개 중 우선순위 상위 ${ids.length}개만 수집기에 넘김(실행당 상한 ${cap}개). 나머지 ${skipped}개는 다음 실행으로 미뤄짐.`
      : null;
  return { source: adapter.id, ids, dueIds, due: candidates.length, byTier, cap, skipped, accountingOnly: false, note };
}

/**
 * How many due videos a run re-observed: due ids that came back as videos (from refresh OR discovery) or were
 * reported gone.
 */
export function countObservedDue(dueIds: readonly string[], returned: ReadonlySet<string>): number {
  let n = 0;
  for (const id of dueIds) if (returned.has(id)) n++;
  return n;
}

/** Korean run note on refresh coverage (null when every due video was re-observed or nothing was due). */
export function refreshCoverageNote(sel: Pick<RefreshSelection, 'due' | 'ids' | 'cap' | 'accountingOnly'>, observed: number): string | null {
  if (sel.due === 0 || observed >= sel.due) return null;
  const left = sel.due - observed;
  if (sel.accountingOnly) {
    return `갱신 주기가 된 추적 영상 ${sel.due}개 중 ${observed}개만 이번 실행에서 다시 관측됨. 나머지 ${left}개는 이 원천이 ID로 다시 조회할 수 없어 관측하지 못함(예: 채널 RSS 피드에서 밀려난 영상).`;
  }
  const capped = Number.isFinite(sel.cap) && sel.ids.length < sel.due ? `, 실행당 상한 ${sel.cap}개로 ${sel.ids.length}개만 넘김` : '';
  return `갱신 대상 ${sel.due}개 중 ${observed}개를 이번 실행에서 다시 관측함(탐색에서 다시 나온 영상 포함${capped}). 나머지 ${left}개는 요청 한도·상한 때문에 다음 실행으로 미뤄졌거나 원천 응답에 없었음.`;
}
