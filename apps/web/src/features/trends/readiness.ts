/**
 * Data readiness: how much observation history the loaded dataset has. The trends / ratings / explore pages
 * use it to explain partial results honestly ("수집 시작 이후 기록이 쌓이면 채워짐") instead of showing
 * blank or broken-looking lists. Pure (no React); shared by the three feature folders.
 */
import type { Dataset, Video } from '@vti/core';

export interface DataReadiness {
  /** Earliest observation instant in the dataset (null when there are no observations). */
  firstObservationAt: number | null;
  /** Latest observation instant. */
  lastObservationAt: number | null;
  totalVideos: number;
  /** Videos with at least two observations (a growth history of their own). */
  withHistory: number;
  /** Largest number of observations of a single video. */
  maxObservations: number;
  /** Share (0..1) of videos with >= 2 observations. */
  historyShare: number;
}

const cache = new WeakMap<Dataset, DataReadiness>();

export function dataReadiness(dataset: Dataset): DataReadiness {
  const hit = cache.get(dataset);
  if (hit) return hit;
  let first = Infinity;
  let last = -Infinity;
  let withHistory = 0;
  let maxObservations = 0;
  for (const v of dataset.videos) {
    const obs = v.obs ?? [];
    if (obs.length >= 2) withHistory++;
    if (obs.length > maxObservations) maxObservations = obs.length;
    for (const p of obs) {
      if (p.t < first) first = p.t;
      if (p.t > last) last = p.t;
    }
  }
  const total = dataset.videos.length;
  const r: DataReadiness = {
    firstObservationAt: Number.isFinite(first) ? first : null,
    lastObservationAt: Number.isFinite(last) ? last : null,
    totalVideos: total,
    withHistory,
    maxObservations,
    historyShare: total > 0 ? withHistory / total : 0,
  };
  cache.set(dataset, r);
  return r;
}

/** True when most videos still have a single observation (early collection phase). */
export function isEarlyHistory(r: DataReadiness): boolean {
  return r.totalVideos > 0 && r.historyShare < 0.5;
}

/** Language filter options (ISO codes present in the videos, most frequent first). */
export function languageCounts(videos: readonly Video[]): { code: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const v of videos) {
    if (!v.language) continue;
    const code = v.language.toLowerCase();
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}
