/**
 * Tiered refresh: which known videos each source should re-observe this run. OWNER: collector-pipeline.
 *
 * The store computes due candidates in priority order (SPEC tiers, see `Store.getRefreshCandidates`); this module
 * applies per-source caps so a run stays within its request budget. Adapters consume `refreshIds` in order and
 * stop at `maxRequests`, so the most important videos (youngest first) are refreshed first.
 * Anything cut by a cap is reported (never a silent cap).
 */
import type { SourceAdapter } from './types.ts';
import type { RefreshCandidate, RefreshTier, Store } from './store.ts';

/**
 * Max refresh ids handed to a source per run. 0 = the source cannot refresh by id (youtube-rss only reads channel
 * feeds; instagram-graph has no lookup by media id without per-media tokens).
 */
export const DEFAULT_REFRESH_CAPS: Readonly<Record<string, number>> = {
  'youtube-rss': 0,
  dailymotion: 5000,
  peertube: 150,
  niconico: 5000,
  'youtube-data-api': 2500,
  'tiktok-research': 1000,
  'instagram-graph': 0,
  'x-api': 1000,
  twitch: 1000,
};
/** Cap for sources not listed above. */
export const DEFAULT_REFRESH_CAP = 500;

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
  ids: string[];
  /** Due candidates before capping. */
  due: number;
  /** Due candidates per tier (before capping). */
  byTier: Partial<Record<RefreshTier['name'], number>>;
  /** Cap that was applied (Infinity when none). */
  cap: number;
  /** Candidates left out because of the cap. */
  skipped: number;
  /** Korean note for coverage/run logs when something was cut; null otherwise. */
  note: string | null;
}

export interface SelectRefreshOptions {
  now: number;
  maxRequests?: number;
  /** Per-source overrides of DEFAULT_REFRESH_CAPS. */
  caps?: Record<string, number>;
}

/** Cap for `source` given its per-run request budget. */
export function refreshCapFor(source: string, maxRequests: number | undefined, caps: Record<string, number> = {}): number {
  const base = caps[source] ?? DEFAULT_REFRESH_CAPS[source] ?? DEFAULT_REFRESH_CAP;
  if (base <= 0) return 0;
  if (maxRequests === undefined || !Number.isFinite(maxRequests)) return base;
  const perReq = IDS_PER_REQUEST[source] ?? 1;
  return Math.max(0, Math.min(base, Math.floor(maxRequests) * perReq));
}

export function selectRefreshIds(store: Store, adapter: Pick<SourceAdapter, 'id' | 'platform'>, opts: SelectRefreshOptions): RefreshSelection {
  const cap = refreshCapFor(adapter.id, opts.maxRequests, opts.caps);
  if (cap === 0) return { source: adapter.id, ids: [], due: 0, byTier: {}, cap: 0, skipped: 0, note: null };
  const candidates: RefreshCandidate[] = store.getRefreshCandidates(adapter.id, opts.now, { platform: adapter.platform });
  const byTier: RefreshSelection['byTier'] = {};
  for (const c of candidates) byTier[c.tier] = (byTier[c.tier] ?? 0) + 1;
  const ids = candidates.slice(0, cap).map((c) => c.platformId);
  const skipped = candidates.length - ids.length;
  const note =
    skipped > 0
      ? `갱신 대상 ${candidates.length}개 중 우선순위 상위 ${ids.length}개만 요청함(실행당 상한 ${cap}개). 나머지 ${skipped}개는 다음 실행으로 미뤄짐.`
      : null;
  return { source: adapter.id, ids, due: candidates.length, byTier, cap, skipped, note };
}
