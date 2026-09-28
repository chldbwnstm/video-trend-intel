/**
 * Shared test fixtures for @vti/core (and other packages' tests).
 * OWNER: core-metrics agent. Keep this small and stable: other engineers' tests import it.
 *
 * Usage:
 *   const v = makeVideo({ id: 'youtube:a', publishedAt: ts('2026-08-10'), obs: [
 *     makeObs('2026-09-01', 1_000_000), makeObs('2026-10-01', 6_000_000),
 *   ] });
 *   const index = makeIndex({ videos: [v], accounts: [makeAccount({ id: v.accountId })] });
 */
import { buildIndex } from '../src/dataset.ts';
import type { DatasetIndex } from '../src/dataset.ts';
import type { Account, Dataset, ObservationPoint, SourceWindowMetric, Video } from '../src/types.ts';

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/**
 * Epoch ms for an ISO-ish string. A bare date (`2026-09-01`) or a datetime without offset
 * (`2026-09-01T12:00`) is interpreted as UTC. Numbers pass through unchanged.
 */
export function ts(x: string | number): number {
  if (typeof x === 'number') return x;
  let s = x;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += 'T00:00:00Z';
  else if (!/(Z|[+-]\d{2}:?\d{2})$/.test(s)) s += 'Z';
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) throw new Error(`fixtures.ts: bad timestamp ${x}`);
  return ms;
}

/**
 * One observation. `t` is epoch ms or an ISO string (UTC if no offset).
 * Omitted counters default to `null` (= not provided by the source, NOT zero).
 */
export function makeObs(
  t: string | number,
  views: number | null,
  likes: number | null = null,
  comments: number | null = null,
  shares: number | null = null,
  src = 'test@1',
): ObservationPoint {
  return { t: ts(t), views, likes, comments, shares, src };
}

/** Object form of makeObs: `obsOf('2026-09-01', { views: 10, likes: 1 })`. */
export function obsOf(
  t: string | number,
  counters: Partial<Pick<ObservationPoint, 'views' | 'likes' | 'comments' | 'shares' | 'src'>> = {},
): ObservationPoint {
  return makeObs(t, counters.views ?? null, counters.likes ?? null, counters.comments ?? null, counters.shares ?? null, counters.src ?? 'test@1');
}

/** A SourceWindowMetric (e.g. Dailymotion views_last_week = windowHours 168). */
export function makeSourceWindow(
  metric: SourceWindowMetric['metric'],
  windowHours: number,
  value: number,
  observedAt: string | number,
  src = 'test-window@1',
): SourceWindowMetric {
  return { metric, windowHours, value, observedAt: ts(observedAt), src };
}

let videoSeq = 0;
let accountSeq = 0;

/**
 * A complete Video with sensible defaults. Observations are copied and sorted by `t` ascending.
 * Defaults: platform youtube, account `youtube:acc1`, published 2026-09-01T00:00Z, status active, no obs.
 * If `id` is omitted a unique `youtube:vN` id is generated; `platformId` is derived from `id`.
 */
export function makeVideo(partial: Partial<Video> = {}): Video {
  const platform = partial.platform ?? (partial.id ? (partial.id.split(':')[0] as Video['platform']) : 'youtube');
  const id = partial.id ?? `${platform}:${partial.platformId ?? `v${++videoSeq}`}`;
  const platformId = partial.platformId ?? id.slice(id.indexOf(':') + 1);
  const publishedAt = partial.publishedAt ?? ts('2026-09-01');
  const obs = [...(partial.obs ?? [])].sort((a, b) => a.t - b.t);
  const lastT = obs.length ? obs[obs.length - 1].t : publishedAt;
  return {
    url: `https://example.com/${platform}/${platformId}`,
    title: `Video ${platformId}`,
    description: null,
    thumbnail: null,
    durationSec: null,
    format: 'unknown',
    accountId: `${platform}:acc1`,
    language: null,
    languageSource: null,
    country: null,
    sourceCategory: null,
    tags: [],
    categories: [],
    topics: [],
    sponsorship: null,
    status: 'active',
    firstSeenAt: obs.length ? obs[0].t : publishedAt,
    lastObservedAt: lastT,
    discoveredVia: ['test'],
    sourceWindows: [],
    ...partial,
    // derived / normalized fields win over the spread
    id,
    platform,
    platformId,
    publishedAt,
    obs,
  };
}

/** A complete Account with defaults (platform youtube, id `youtube:accN` unless given). */
export function makeAccount(partial: Partial<Account> = {}): Account {
  const platform = partial.platform ?? (partial.id ? (partial.id.split(':')[0] as Account['platform']) : 'youtube');
  const id = partial.id ?? `${platform}:${partial.platformId ?? `acc${++accountSeq}`}`;
  const platformId = partial.platformId ?? id.slice(id.indexOf(':') + 1);
  return {
    handle: null,
    name: `Account ${platformId}`,
    url: `https://example.com/${platform}/account/${platformId}`,
    avatar: null,
    country: null,
    followers: [],
    creatorId: null,
    seedCategory: null,
    trackedSince: ts('2026-01-01'),
    discoveredVia: ['test'],
    ...partial,
    id,
    platform,
    platformId,
  };
}

/**
 * A complete Dataset. If `accounts` is omitted, one account is synthesized for every distinct
 * `video.accountId` so indexes resolve. `generatedAt` defaults to 2026-09-28T00:00Z.
 */
export function makeDataset(partial: Partial<Dataset> = {}): Dataset {
  const videos = partial.videos ?? [];
  let accounts = partial.accounts;
  if (!accounts) {
    const ids = [...new Set(videos.map((v) => v.accountId))];
    accounts = ids.map((id) => makeAccount({ id }));
  }
  return {
    schemaVersion: 1,
    generatedAt: partial.generatedAt ?? ts('2026-09-28'),
    classifierVersion: partial.classifierVersion ?? 'test',
    videos,
    accounts,
    creators: partial.creators ?? [],
    coverage: partial.coverage ?? [],
    runs: partial.runs ?? [],
    exportNotes: partial.exportNotes ?? [],
  };
}

/** buildIndex(makeDataset(partial)). */
export function makeIndex(partial: Partial<Dataset> = {}): DatasetIndex {
  return buildIndex(makeDataset(partial));
}
