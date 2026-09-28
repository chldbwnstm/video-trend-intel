/**
 * GET /api/v1/coverage — the trust layer: sources, runs, export notes, observation density and how exactly
 * the default period windows can be measured right now. OWNER: server.
 */
import type { Hono } from 'hono';
import { DEFAULT_TZ, METRIC_STATUS_LABELS_KO, PLATFORMS, presetRange, queryVideos } from '@vti/core';
import type { DatasetIndex, MetricStatus, Platform } from '@vti/core';
import { isoOf, platformLabel, sendJson, type RouteDeps } from './common.ts';
import { Params, parseTz } from '../params.ts';

const STATUSES: MetricStatus[] = ['exact', 'interpolated', 'source_reported', 'lower_bound', 'unavailable', 'decrease_flagged'];

const WINDOW_PRESETS = [
  { preset: 'rolling24h', hours: 24, label: '최근 24시간' },
  { preset: 'rolling7d', hours: 168, label: '최근 168시간(7일)' },
  { preset: 'rolling30d', hours: 720, label: '최근 720시간(30일)' },
] as const;

function emptyCounts(): Record<MetricStatus, number> {
  return { exact: 0, interpolated: 0, source_reported: 0, lower_bound: 0, unavailable: 0, decrease_flagged: 0 };
}

/** Status mix of 'views increase in the window' (activity mode) for the rolling presets. */
function windowQuality(index: DatasetIndex, tz: string) {
  const now = index.dataset.generatedAt;
  return WINDOW_PRESETS.map((w) => {
    const res = queryVideos(index, {
      dateMode: 'activity',
      range: presetRange(w.preset, tz, now),
      rollingHours: w.hours,
      tz,
      sort: 'views_period',
      now,
    });
    const byStatus = emptyCounts();
    const byPlatform = new Map<Platform, Record<MetricStatus, number>>();
    for (const r of res.rows) {
      const s = r.metrics.viewsPeriod.status;
      byStatus[s]++;
      let pc = byPlatform.get(r.video.platform);
      if (!pc) {
        pc = emptyCounts();
        byPlatform.set(r.video.platform, pc);
      }
      pc[s]++;
    }
    const total = res.rows.length;
    return {
      preset: w.preset,
      hours: w.hours,
      label: w.label,
      total,
      byStatus,
      shares: Object.fromEntries(STATUSES.map((s) => [s, total ? byStatus[s] / total : null])),
      byPlatform: PLATFORMS.filter((p) => byPlatform.has(p)).map((p) => ({ platform: p, label: platformLabel(p), ...byPlatform.get(p)! })),
    };
  });
}

const qualityCache = new WeakMap<DatasetIndex, Map<string, ReturnType<typeof windowQuality>>>();

function cachedWindowQuality(index: DatasetIndex, tz: string) {
  let byTz = qualityCache.get(index);
  if (!byTz) {
    byTz = new Map();
    qualityCache.set(index, byTz);
  }
  let q = byTz.get(tz);
  if (!q) {
    q = windowQuality(index, tz);
    if (byTz.size > 8) byTz.clear();
    byTz.set(tz, q);
  }
  return q;
}

function densityBucket(n: number): string {
  if (n <= 1) return '1';
  if (n <= 3) return '2-3';
  if (n <= 9) return '4-9';
  if (n <= 29) return '10-29';
  return '30+';
}

/** Coverage payload (also written by static-api as coverage.json). */
export function buildCoverage(index: DatasetIndex, tz: string = DEFAULT_TZ) {
  const ds = index.dataset;
  const perPlatform = new Map<Platform, { videos: number; observations: number; multi: number; withSourceWindows: number; accounts: number }>();
  const density: Record<string, number> = { '1': 0, '2-3': 0, '4-9': 0, '10-29': 0, '30+': 0 };
  let oldestObs: number | null = null;
  for (const v of ds.videos) {
    let e = perPlatform.get(v.platform);
    if (!e) {
      e = { videos: 0, observations: 0, multi: 0, withSourceWindows: 0, accounts: 0 };
      perPlatform.set(v.platform, e);
    }
    e.videos++;
    e.observations += v.obs.length;
    if (v.obs.length > 1) e.multi++;
    if ((v.sourceWindows ?? []).length) e.withSourceWindows++;
    density[densityBucket(v.obs.length)]++;
    const first = v.obs[0]?.t;
    if (first !== undefined && (oldestObs === null || first < oldestObs)) oldestObs = first;
  }
  for (const a of ds.accounts) {
    const e = perPlatform.get(a.platform);
    if (e) e.accounts++;
  }
  const runs = [...ds.runs].sort((a, b) => b.startedAt - a.startedAt || (a.id < b.id ? -1 : 1));
  const historyHours = oldestObs === null ? 0 : Math.max(0, (ds.generatedAt - oldestObs) / 3_600_000);
  const notes = [
    '모든 수치는 공개 원천(공식 API·RSS·스냅샷)에서 수집한 관측값으로 계산하며, 원천이 제공하지 않는 값은 0이 아니라 “계산 불가(—)”로 표시합니다.',
    '조회 발생 기간(activity) 값은 기간 시작·종료 시점의 관측이 있어야 정확합니다. 관측 이력이 쌓이기 전에는 하한값(≥)이나 계산 불가가 많고, Dailymotion은 원천이 직접 집계한 24시간·7일·30일 조회수(원천 보고)를 사용합니다.',
    `현재 관측 이력은 약 ${Math.round(historyHours)}시간 분량입니다. 수집은 주기적으로(기본 3시간) 실행되어 이력이 매일 쌓입니다.`,
    '플랫폼마다 조회수 정의가 다릅니다(예: X는 노출 수, YouTube Shorts는 2025년 3월 집계 방식 변경). 여러 플랫폼을 섞은 합계·순위는 참고용입니다.',
  ];
  return {
    generatedAt: ds.generatedAt,
    generatedAtIso: isoOf(ds.generatedAt),
    classifierVersion: ds.classifierVersion,
    tz,
    sources: ds.coverage,
    runs,
    exportNotes: ds.exportNotes,
    platforms: PLATFORMS.filter((p) => perPlatform.has(p)).map((p) => {
      const e = perPlatform.get(p)!;
      return {
        platform: p,
        label: platformLabel(p),
        videos: e.videos,
        accounts: e.accounts,
        observations: e.observations,
        videosWithMultipleObservations: e.multi,
        videosWithSourceWindows: e.withSourceWindows,
      };
    }),
    observationDensity: { videos: ds.videos.length, perVideo: density, historyHours },
    windowQuality: cachedWindowQuality(index, tz),
    statusLabels: METRIC_STATUS_LABELS_KO,
    unsupported: [
      {
        feature: 'Audience Ratings',
        label: '시청자 구성(오디언스 레이팅)',
        reason: '시청자 패널·동의 기반 데이터가 필요해 공개 원천만으로는 만들 수 없습니다. 추정치를 만들어 보여 주지 않습니다.',
      },
      {
        feature: 'Consumer Insights',
        label: '소비자 인사이트',
        reason: '개인 단위 시청·구매 데이터(패널)가 필요해 제공하지 않습니다. 업로드 국가·영상 언어는 시청자 지역이 아닙니다.',
      },
    ],
    notes,
  };
}

export function registerCoverage(app: Hono, deps: RouteDeps): void {
  app.get('/coverage', (c) =>
    sendJson(c, deps, (index) => {
      const p = Params.of(c.req.url);
      const tz = parseTz(p);
      p.done();
      return buildCoverage(index, tz);
    }),
  );
}
