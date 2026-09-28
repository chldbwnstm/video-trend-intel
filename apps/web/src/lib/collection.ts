/**
 * When our collection started and how far it reaches, computed once per dataset and shared by every page
 * (dashboard KPIs and freshness, trends / ratings readiness, the video search coverage callout), so the
 * same dataset never reports two different "first observation" times.
 *
 * Two instants are kept apart on purpose:
 * - `collectionStartAt`: when our collector first ran (first run / first-seen time). Uploads before it were
 *   only discovered by backfill (latest 15 per channel, "visited today" sorts...), so they are under-sampled.
 * - `firstObservationAt`: the earliest observation timestamp. It can be earlier than the collection start:
 *   niconico observations carry the snapshot time of the Snapshot Search API, not the fetch time.
 * Pure (no React): tested in collection.test.ts.
 */
import type { CollectionRun, Dataset, SourceCoverage, Video } from '@vti/core';
import { fmtTime } from './display.ts';
import { tzShort } from './timezones.ts';

export interface CollectionTimeline {
  /** Earliest of the first run starts and the videos' first-seen times; null for an empty dataset. */
  collectionStartAt: number | null;
  /** Earliest observation timestamp (may precede collectionStartAt for snapshot sources). */
  firstObservationAt: number | null;
  /** Source adapter id (e.g. `niconico`) of that earliest observation. */
  firstObservationSource: string | null;
  lastObservationAt: number | null;
  /**
   * Latest instant the collector is known to have been active: max of the data now (generatedAt), run
   * starts / finishes and coverage run times. A re-observation round that added no new points finishes
   * after generatedAt; freshness and run counts are measured against this so they never read "in the future".
   */
  collectedUntil: number;
}

type TimelineInput = Pick<Dataset, 'generatedAt'> & { videos: readonly Video[]; runs?: readonly CollectionRun[]; coverage?: readonly SourceCoverage[] };

const cache = new WeakMap<object, CollectionTimeline>();

/** Adapter id of an observation `src` (`niconico@1` -> `niconico`). */
export function adapterOf(src: string): string {
  const at = src.indexOf('@');
  return at >= 0 ? src.slice(0, at) : src;
}

function finite(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

export function collectionTimeline(dataset: TimelineInput): CollectionTimeline {
  const hit = cache.get(dataset);
  if (hit) return hit;
  let start = Infinity;
  let first = Infinity;
  let firstSrc: string | null = null;
  let last = -Infinity;
  let until = finite(dataset.generatedAt) ? dataset.generatedAt : -Infinity;
  for (const r of dataset.runs ?? []) {
    if (finite(r.startedAt)) {
      start = Math.min(start, r.startedAt);
      until = Math.max(until, r.startedAt);
    }
    if (finite(r.finishedAt)) until = Math.max(until, r.finishedAt);
  }
  for (const c of dataset.coverage ?? []) {
    if (finite(c.firstRunAt)) start = Math.min(start, c.firstRunAt);
    if (finite(c.lastRunAt)) until = Math.max(until, c.lastRunAt);
    if (finite(c.lastSuccessAt)) until = Math.max(until, c.lastSuccessAt);
  }
  for (const v of dataset.videos) {
    if (finite(v.firstSeenAt)) start = Math.min(start, v.firstSeenAt);
    for (const o of v.obs) {
      if (o.t < first) {
        first = o.t;
        firstSrc = o.src;
      }
      if (o.t > last) last = o.t;
    }
  }
  const t: CollectionTimeline = {
    collectionStartAt: Number.isFinite(start) ? start : Number.isFinite(first) ? first : null,
    firstObservationAt: Number.isFinite(first) ? first : null,
    firstObservationSource: firstSrc === null ? null : adapterOf(firstSrc),
    lastObservationAt: Number.isFinite(last) ? last : null,
    collectedUntil: Number.isFinite(until) ? until : dataset.generatedAt,
  };
  cache.set(dataset, t);
  return t;
}

/** Observations earlier than the collection start by more than this are called out (snapshot sources). */
export const SNAPSHOT_LEAD_MS = 60_000;

/** True when some observations are stamped before our collection started (snapshot-time sources). */
export function hasSnapshotLead(t: Pick<CollectionTimeline, 'collectionStartAt' | 'firstObservationAt'>): boolean {
  return t.collectionStartAt !== null && t.firstObservationAt !== null && t.firstObservationAt < t.collectionStartAt - SNAPSHOT_LEAD_MS;
}

/**
 * `수집 시작 2026-09-29 00:13 KST` plus, when snapshot observations predate it,
 * ` (niconico 관측은 원천 스냅샷 시각 기준이라 2026-09-28 07:08부터 있음)`. Every page uses this wording.
 */
export function collectionStartText(t: CollectionTimeline, tz: string, sourceLabel: (source: string) => string = (s) => s): string {
  if (t.collectionStartAt === null) return '수집 기록 없음';
  const base = `수집 시작 ${fmtTime(t.collectionStartAt, tz)} ${tzShort(tz)}`;
  if (!hasSnapshotLead(t)) return base;
  const who = t.firstObservationSource ? `${sourceLabel(t.firstObservationSource)} ` : '';
  return `${base} (${who}관측은 원천 스냅샷 시각 기준이라 ${fmtTime(t.firstObservationAt, tz)}부터 있음)`;
}

/** Short adapter label from the coverage list (`niconico (스냅샷 검색 API)` -> `niconico`). */
export function sourceShortLabel(coverage: readonly SourceCoverage[] | undefined, source: string): string {
  const c = coverage?.find((x) => x.source === source);
  if (!c) return source;
  const paren = c.label.indexOf(' (');
  return paren > 0 ? c.label.slice(0, paren) : c.label;
}
