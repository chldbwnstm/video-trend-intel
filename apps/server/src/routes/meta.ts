/**
 * GET /api/v1/meta — dataset version, counts and a coverage summary. OWNER: server.
 */
import type { Hono } from 'hono';
import { DEFAULT_TZ, PLATFORMS, RANGE_PRESETS } from '@vti/core';
import type { DatasetIndex, Platform } from '@vti/core';
import { API_VERSION, isoOf, platformLabel, sendJson, type RouteDeps } from './common.ts';
import { DEFAULT_DATE_MODE, DEFAULT_RANGE_PRESET, DEFAULT_SORT, DEFAULT_VIDEO_LIMIT, MAX_VIDEO_LIMIT, Params } from '../params.ts';

const metaCache = new WeakMap<DatasetIndex, ReturnType<typeof computeMeta>>();

function computeMeta(index: DatasetIndex) {
  const ds = index.dataset;
  const videosByPlatform = new Map<Platform, number>();
  const accountsByPlatform = new Map<Platform, number>();
  let observations = 0;
  let singleObservation = 0;
  let categorized = 0;
  let disclosed = 0;
  let likely = 0;
  for (const v of ds.videos) {
    videosByPlatform.set(v.platform, (videosByPlatform.get(v.platform) ?? 0) + 1);
    observations += v.obs.length;
    if (v.obs.length <= 1) singleObservation++;
    if ((v.categories ?? []).length) categorized++;
    if (v.sponsorship?.level === 'disclosed') disclosed++;
    else if (v.sponsorship?.level === 'likely') likely++;
  }
  for (const a of ds.accounts) accountsByPlatform.set(a.platform, (accountsByPlatform.get(a.platform) ?? 0) + 1);
  const n = ds.videos.length;
  const verified = ds.creators.filter((c) => c.linkStatus === 'verified').length;
  const sources = ds.coverage.map((s) => ({
    source: s.source,
    platform: s.platform,
    label: s.label,
    enabled: s.enabled,
    requiresCredentials: s.requiresCredentials,
    lastStatus: s.lastStatus,
    lastRunAt: s.lastRunAt,
    lastSuccessAt: s.lastSuccessAt,
    videoCount: s.videoCount,
    accountCount: s.accountCount,
    metrics: s.metrics,
  }));
  return {
    apiVersion: API_VERSION,
    generatedAt: ds.generatedAt,
    generatedAtIso: isoOf(ds.generatedAt),
    classifierVersion: ds.classifierVersion,
    counts: {
      videos: n,
      accounts: ds.accounts.length,
      creators: ds.creators.length,
      observations,
      runs: ds.runs.length,
      sources: ds.coverage.length,
      exportNotes: ds.exportNotes.length,
    },
    platforms: PLATFORMS.filter((p) => videosByPlatform.has(p) || accountsByPlatform.has(p)).map((p) => ({
      platform: p,
      label: platformLabel(p),
      videos: videosByPlatform.get(p) ?? 0,
      accounts: accountsByPlatform.get(p) ?? 0,
    })),
    coverage: {
      enabledSources: sources.filter((s) => s.enabled).length,
      disabledSources: sources.filter((s) => !s.enabled).length,
      sources,
      categorized,
      categorizedShare: n ? categorized / n : null,
      sponsorship: { disclosed, likely },
      creators: { total: ds.creators.length, verified, suggested: ds.creators.length - verified },
      videosWithSingleObservation: singleObservation,
      observationsPerVideo: n ? observations / n : null,
      exportNotes: ds.exportNotes,
    },
    defaults: {
      tz: DEFAULT_TZ,
      mode: DEFAULT_DATE_MODE,
      range: DEFAULT_RANGE_PRESET,
      sort: DEFAULT_SORT,
      limit: DEFAULT_VIDEO_LIMIT,
      maxLimit: MAX_VIDEO_LIMIT,
      rangePresets: RANGE_PRESETS,
    },
  };
}

/** Meta payload (also written by static-api as meta.json). */
export function buildMeta(index: DatasetIndex) {
  let m = metaCache.get(index);
  if (!m) {
    m = computeMeta(index);
    metaCache.set(index, m);
  }
  return m;
}

export function registerMeta(app: Hono, deps: RouteDeps): void {
  app.get('/meta', (c) =>
    sendJson(c, deps, (index) => {
      Params.of(c.req.url).done();
      return buildMeta(index);
    }),
  );
}
