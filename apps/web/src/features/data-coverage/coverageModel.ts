/**
 * 데이터 범위 (coverage & trust) page logic: per-source rows with credentials, observation depth, what the
 * current data can compute honestly (activity-window status mix per rolling preset), collection runs.
 * Pure functions (tested in coverage.test.ts).
 */
import { presetRange, queryVideos } from '@vti/core';
import type {
  CollectionRun,
  Dataset,
  DatasetIndex,
  MetricKey,
  MetricStatus,
  Platform,
  QueryResult,
  RangePreset,
  SourceCoverage,
  VideoQuery,
} from '@vti/core';
import { cached, stableStringify } from '../../lib/cache.ts';
import { sourceFreshness } from '../../lib/dashboard.ts';
import type { FreshnessRow } from '../../lib/dashboard.ts';
import { orderPlatforms } from '../../lib/platform.ts';

export const HOUR_MS = 3_600_000;

/* ------------------------------------------------------------------------------------------ credentials */

export interface CredentialInfo {
  env: string[];
  /** Where to get the credentials (Korean). */
  howTo: string;
  /** Terms / cost caveats (Korean). */
  caveat: string | null;
  docsUrl: string;
}

/** Credentialed adapters (SPEC "Sources"). The env var names are what the collector reads. */
export const CREDENTIALS: Record<string, CredentialInfo> = {
  'youtube-data-api': {
    env: ['YOUTUBE_API_KEY'],
    howTo: 'Google Cloud 콘솔에서 프로젝트를 만들고 YouTube Data API v3를 사용 설정한 뒤 API 키 발급.',
    caveat: '하루 할당량(기본 10,000단위) 안에서 검색·통계 호출 수를 조절함.',
    docsUrl: 'https://developers.google.com/youtube/v3/getting-started',
  },
  'tiktok-research': {
    env: ['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET'],
    howTo: 'TikTok for Developers에서 Research API 접근을 신청해 승인받은 뒤 클라이언트 키·시크릿 발급.',
    caveat: '승인된 비영리 연구 목적만 허용됨. 상업적 이용은 약관상 불가.',
    docsUrl: 'https://developers.tiktok.com/products/research-api/',
  },
  'instagram-graph': {
    env: ['IG_ACCESS_TOKEN', 'IG_USER_ID'],
    howTo: 'Meta 개발자 앱에 Instagram 비즈니스·크리에이터 계정을 연결하고 장기 액세스 토큰과 IG 사용자 ID 준비.',
    caveat: '다른 계정은 비즈니스·크리에이터 계정만 business_discovery로 조회 가능. 해시태그는 7일에 30개 한도.',
    docsUrl: 'https://developers.facebook.com/docs/instagram-platform',
  },
  'x-api': {
    env: ['X_BEARER_TOKEN'],
    howTo: 'X 개발자 포털에서 프로젝트·앱을 만들고 Bearer 토큰 발급.',
    caveat: '읽은 게시물 수 기준 과금·한도가 있음. X 조회수는 노출 수(impressions)임.',
    docsUrl: 'https://docs.x.com/x-api/introduction',
  },
  twitch: {
    env: ['TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET'],
    howTo: 'Twitch 개발자 콘솔에서 애플리케이션을 등록하고 클라이언트 ID·시크릿 발급 (앱 액세스 토큰은 자동 발급).',
    caveat: '팔로워 수는 사용자 토큰(TWITCH_USER_TOKEN)이 있어야 수집됨.',
    docsUrl: 'https://dev.twitch.tv/docs/authentication/register-app/',
  },
};

const ENV_NOTE_RE = /환경\s*변수\s*[:：]\s*([A-Z0-9_,\s]+)/;

/** Env var names a source needs: the known map first, else parsed from its coverage notes. */
export function credentialEnvVars(c: Pick<SourceCoverage, 'source' | 'notes' | 'requiresCredentials'>): string[] {
  const known = CREDENTIALS[c.source];
  if (known) return known.env;
  if (!c.requiresCredentials) return [];
  for (const n of c.notes ?? []) {
    const m = ENV_NOTE_RE.exec(n);
    if (m) {
      const names = m[1]
        .split(/[,\s]+/)
        .map((x) => x.trim())
        .filter((x) => /^[A-Z][A-Z0-9_]+$/.test(x));
      if (names.length) return names;
    }
  }
  return [];
}

/* ------------------------------------------------------------------------------------------ sources */

export interface SourceRow extends FreshnessRow {
  coverage: SourceCoverage;
  env: string[];
  missingMetrics: MetricKey[];
}

const ALL_METRICS: MetricKey[] = ['views', 'likes', 'comments', 'shares'];

export function sourceRows(coverage: SourceCoverage[], now: number): SourceRow[] {
  const byId = new Map(coverage.map((c) => [c.source, c] as const));
  return sourceFreshness(coverage, now).map((f) => {
    const c = byId.get(f.source)!;
    return {
      ...f,
      coverage: c,
      env: credentialEnvVars(c),
      missingMetrics: ALL_METRICS.filter((m) => !(c.metrics ?? []).includes(m)),
    };
  });
}

export interface CoverageSummary {
  sources: number;
  enabled: number;
  disabled: number;
  credentialed: number;
  failing: number;
  videos: number;
  accounts: number;
  creators: { verified: number; suggested: number };
  platforms: Platform[];
  categorizedShare: number | null;
  sponsored: { disclosed: number; likely: number };
  firstRunAt: number | null;
  lastRunAt: number | null;
  /** Hours between the first recorded run and the data's now (history depth). */
  historyHours: number | null;
}

export function coverageSummary(dataset: Dataset): CoverageSummary {
  const cov = dataset.coverage ?? [];
  const firsts = cov.map((c) => c.firstRunAt).filter((x): x is number => typeof x === 'number');
  const runStarts = (dataset.runs ?? []).map((r) => r.startedAt);
  const allFirst = [...firsts, ...runStarts];
  const firstRunAt = allFirst.length ? Math.min(...allFirst) : null;
  const lasts = [...cov.map((c) => c.lastRunAt).filter((x): x is number => typeof x === 'number'), ...runStarts];
  let categorized = 0;
  let disclosed = 0;
  let likely = 0;
  for (const v of dataset.videos) {
    if (v.categories?.length) categorized++;
    if (v.sponsorship?.level === 'disclosed') disclosed++;
    else if (v.sponsorship?.level === 'likely') likely++;
  }
  return {
    sources: cov.length,
    enabled: cov.filter((c) => c.enabled).length,
    disabled: cov.filter((c) => !c.enabled).length,
    credentialed: cov.filter((c) => c.requiresCredentials).length,
    failing: cov.filter((c) => c.enabled && (c.lastStatus === 'error' || c.lastStatus === 'partial')).length,
    videos: dataset.videos.length,
    accounts: dataset.accounts.length,
    creators: {
      verified: dataset.creators.filter((c) => c.linkStatus === 'verified').length,
      suggested: dataset.creators.filter((c) => c.linkStatus === 'suggested').length,
    },
    platforms: orderPlatforms(dataset.videos.map((v) => v.platform)),
    categorizedShare: dataset.videos.length ? categorized / dataset.videos.length : null,
    sponsored: { disclosed, likely },
    firstRunAt,
    lastRunAt: lasts.length ? Math.max(...lasts) : null,
    historyHours: firstRunAt !== null ? Math.max(0, (dataset.generatedAt - firstRunAt) / HOUR_MS) : null,
  };
}

/* ------------------------------------------------------------------------------------------ observation depth */

export interface DepthRow {
  platform: Platform;
  videos: number;
  /** Videos by number of observations: 1, 2–3, 4–7, 8+. */
  buckets: [number, number, number, number];
  /** Median hours between a video's first and last observation. */
  medianSpanHours: number | null;
  /** Videos carrying source-reported window values (e.g. Dailymotion views_last_week). */
  withSourceWindows: number;
  /** Earliest observation of the platform. */
  firstObservedAt: number | null;
}

export const DEPTH_BUCKET_LABELS = ['1회', '2–3회', '4–7회', '8회 이상'] as const;

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

export function observationDepth(dataset: Dataset): DepthRow[] {
  const acc = new Map<Platform, { videos: number; buckets: [number, number, number, number]; spans: number[]; sw: number; first: number | null }>();
  for (const v of dataset.videos) {
    let a = acc.get(v.platform);
    if (!a) {
      a = { videos: 0, buckets: [0, 0, 0, 0], spans: [], sw: 0, first: null };
      acc.set(v.platform, a);
    }
    a.videos++;
    const n = v.obs.length;
    if (n <= 1) a.buckets[0]++;
    else if (n <= 3) a.buckets[1]++;
    else if (n <= 7) a.buckets[2]++;
    else a.buckets[3]++;
    if (n) {
      const first = v.obs[0].t;
      const last = v.obs[n - 1].t;
      a.spans.push(Math.max(0, (last - first) / HOUR_MS));
      if (a.first === null || first < a.first) a.first = first;
    }
    if (v.sourceWindows?.length) a.sw++;
  }
  return orderPlatforms(acc.keys()).map((p) => {
    const a = acc.get(p)!;
    const m = median(a.spans);
    return {
      platform: p,
      videos: a.videos,
      buckets: a.buckets,
      medianSpanHours: m === null ? null : Math.round(m * 10) / 10,
      withSourceWindows: a.sw,
      firstObservedAt: a.first,
    };
  });
}

/* ------------------------------------------------------------------------------------------ computability */

export const STATUS_ORDER_FOR_BARS: MetricStatus[] = ['exact', 'interpolated', 'source_reported', 'lower_bound', 'unavailable', 'decrease_flagged'];

export interface StatusMix {
  total: number;
  counts: Record<MetricStatus, number>;
}

export interface ComputabilityRow {
  preset: RangePreset;
  hours: number;
  all: StatusMix;
  byPlatform: ({ platform: Platform } & StatusMix)[];
}

function emptyMix(): StatusMix {
  return { total: 0, counts: { exact: 0, interpolated: 0, lower_bound: 0, source_reported: 0, unavailable: 0, decrease_flagged: 0 } };
}

function cachedQuery(index: DatasetIndex, q: VideoQuery): QueryResult {
  return cached(index, `queryVideos\u0000${stableStringify(q)}`, () => queryVideos(index, q));
}

export const COMPUTABILITY_PRESETS: { preset: RangePreset; hours: number }[] = [
  { preset: 'rolling24h', hours: 24 },
  { preset: 'rolling7d', hours: 168 },
  { preset: 'rolling30d', hours: 720 },
];

/**
 * Status mix of the activity-mode '기간 조회 증가' (views_period) for every tracked video, per rolling preset
 * and platform. Explains how much of the data can be ranked honestly right now.
 */
export function computability(index: DatasetIndex, input: { tz: string; now: number }): ComputabilityRow[] {
  return COMPUTABILITY_PRESETS.map(({ preset, hours }) => {
    const q: VideoQuery = {
      dateMode: 'activity',
      range: presetRange(preset, input.tz, input.now),
      rollingHours: hours,
      tz: input.tz,
      now: input.now,
      sort: 'views_period',
      sortDir: 'desc',
    };
    const result = cachedQuery(index, q);
    const all = emptyMix();
    const by = new Map<Platform, StatusMix>();
    for (const r of result.rows) {
      const s = r.metrics.viewsPeriod.status;
      all.total++;
      all.counts[s]++;
      let m = by.get(r.video.platform);
      if (!m) {
        m = emptyMix();
        by.set(r.video.platform, m);
      }
      m.total++;
      m.counts[s]++;
    }
    return { preset, hours, all, byPlatform: orderPlatforms(by.keys()).map((p) => ({ platform: p, ...by.get(p)! })) };
  });
}

/** Share (0..1) of values that can be ranked (exact / interpolated / source_reported / lower_bound). */
export function rankableShare(m: StatusMix): number | null {
  if (!m.total) return null;
  return (m.counts.exact + m.counts.interpolated + m.counts.source_reported + m.counts.lower_bound) / m.total;
}

/* ------------------------------------------------------------------------------------------ runs */

export interface RunSummary {
  total: number;
  problems: number;
  last24h: number;
  problems24h: number;
  /** Median hours between consecutive runs of the same source (null with < 2 runs per source). */
  medianIntervalHours: number | null;
  sources: string[];
}

export function sortRuns(runs: CollectionRun[]): CollectionRun[] {
  return [...runs].sort((a, b) => b.startedAt - a.startedAt || (a.source < b.source ? -1 : 1));
}

export function runSummary(runs: CollectionRun[], now: number): RunSummary {
  const bySource = new Map<string, number[]>();
  let problems = 0;
  let last24h = 0;
  let problems24h = 0;
  for (const r of runs) {
    if (r.status !== 'ok') problems++;
    if (r.startedAt > now - 24 * HOUR_MS && r.startedAt <= now) {
      last24h++;
      if (r.status !== 'ok') problems24h++;
    }
    const list = bySource.get(r.source);
    if (list) list.push(r.startedAt);
    else bySource.set(r.source, [r.startedAt]);
  }
  const gaps: number[] = [];
  for (const list of bySource.values()) {
    list.sort((a, b) => a - b);
    for (let i = 1; i < list.length; i++) gaps.push((list[i] - list[i - 1]) / HOUR_MS);
  }
  const m = median(gaps);
  return {
    total: runs.length,
    problems,
    last24h,
    problems24h,
    medianIntervalHours: m === null ? null : Math.round(m * 10) / 10,
    sources: [...bySource.keys()].sort(),
  };
}

export function runDurationSec(r: CollectionRun): number | null {
  return r.finishedAt !== null && r.finishedAt >= r.startedAt ? (r.finishedAt - r.startedAt) / 1000 : null;
}

/** Human duration: `42초`, `3분 5초`, `1시간 2분`. */
export function formatDurationKo(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec)) return '—';
  const s = Math.round(sec);
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}분${s % 60 ? ` ${s % 60}초` : ''}`;
  const h = Math.floor(m / 60);
  return `${h}시간${m % 60 ? ` ${m % 60}분` : ''}`;
}

/** Human span in hours: `18시간`, `3.5일`. */
export function formatHoursKo(h: number | null): string {
  if (h === null || !Number.isFinite(h)) return '—';
  if (h < 1) return `${Math.round(h * 60)}분`;
  if (h < 48) return `${Math.round(h * 10) / 10}시간`;
  return `${Math.round((h / 24) * 10) / 10}일`;
}
