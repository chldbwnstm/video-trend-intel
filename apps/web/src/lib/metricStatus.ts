/**
 * Provenance vocabulary for MetricValue.status (SPEC data principle 3).
 * Every metric number in the UI is rendered with the marker and explanation defined here.
 */
import type { MetricStatus, MetricValue } from '@vti/core';
import {
  DASH,
  formatCompact,
  formatDecimal,
  formatGrowth,
  formatInteger,
  formatMultiplier,
  formatPercent,
  formatPercentile,
} from './format.ts';

export type StatusTone = 'neutral' | 'info' | 'warning' | 'muted' | 'danger';

export interface StatusMeta {
  /** Short visible marker placed before the value ('' for exact). */
  marker: string;
  /** Short Korean label, e.g. `보간값`. */
  label: string;
  /** One-sentence Korean explanation shown in the tooltip. */
  description: string;
  tone: StatusTone;
  /** Whether the value itself is displayed (unavailable hides it). */
  showsValue: boolean;
  /** Whether the value participates in rankings (core `rankValue` semantics). */
  ranked: boolean;
}

export const STATUS_META: Record<MetricStatus, StatusMeta> = {
  exact: {
    marker: '',
    label: '관측값',
    description: '경계 시각 근처의 실제 관측값으로 계산한 값.',
    tone: 'neutral',
    showsValue: true,
    ranked: true,
  },
  interpolated: {
    marker: '≈',
    label: '보간값',
    description: '앞뒤 관측값 사이를 시간 비례로 보간한 값. 실제 값과 조금 다를 수 있음.',
    tone: 'info',
    showsValue: true,
    ranked: true,
  },
  lower_bound: {
    marker: '≥',
    label: '하한값',
    description: '기간 경계의 관측이 없어 관측된 구간만 계산한 값. 실제 값은 이보다 크거나 같음.',
    tone: 'warning',
    showsValue: true,
    ranked: true,
  },
  source_reported: {
    marker: '원천',
    label: '원천 제공값',
    description: '플랫폼이 직접 집계해 제공한 기간 값. 우리 관측으로 계산한 값이 아님.',
    tone: 'info',
    showsValue: true,
    ranked: true,
  },
  unavailable: {
    marker: DASH,
    label: '계산 불가',
    description: '관측이 부족하거나 원천이 제공하지 않아 계산할 수 없음. 0이 아님.',
    tone: 'muted',
    showsValue: false,
    ranked: false,
  },
  decrease_flagged: {
    marker: '⚠',
    label: '감소 표시',
    description: '기간 중 누적값이 줄어듦(삭제·정정·원천 오류 가능). 순위 계산에서 제외.',
    tone: 'danger',
    showsValue: true,
    ranked: false,
  },
};

/**
 * Marker + label for status counts and legends (`≈ 보간값`, `≥ 하한값`, `원천 제공값`, `— 계산 불가`).
 * The marker is left out when the label already starts with it, so source-reported values never read
 * `원천 원천 제공값`. Use this instead of concatenating `marker` and `label` yourself.
 */
export function statusCountLabel(status: MetricStatus): string {
  const meta = STATUS_META[status] ?? STATUS_META.unavailable;
  if (!meta.marker || meta.label.startsWith(meta.marker)) return meta.label;
  return `${meta.marker} ${meta.label}`;
}

export const STATUS_ORDER: MetricStatus[] = [
  'exact',
  'interpolated',
  'lower_bound',
  'source_reported',
  'unavailable',
  'decrease_flagged',
];

/**
 * Human labels for MetricValue.note codes produced by @vti/core. Unknown codes are shown verbatim,
 * so new codes never disappear silently.
 */
export const NOTE_LABELS: Record<string, string> = {
  gap_too_wide: '관측 간격이 너무 넓어 보간할 수 없음',
  not_reached: '아직 해당 경과 시간에 도달하지 않음',
  counter_not_provided: '원천이 이 지표를 제공하지 않음',
  after_last_observation: '마지막 관측 이후 시점이라 값을 알 수 없음',
  before_first_observation: '첫 관측 이전 시점이라 값을 알 수 없음',
  no_observations: '관측 기록이 없음',
  published_after_window: '기간 이후에 게시됨',
  start_before_first_observation: '기간 시작이 첫 관측보다 앞섬',
  end_after_last_observation: '기간 끝이 마지막 관측보다 뒤임',
  window_incomplete: '기간이 아직 끝나지 않음',
  previous_zero: '이전 기간 값이 0이라 증가율을 정의할 수 없음',
  previous_unavailable: '이전 기간 값을 계산할 수 없음',
  insufficient_peers: '같은 계정의 비교 영상이 부족함',
  no_views: '조회수가 없어 비율을 계산할 수 없음',
  views_zero: '조회수가 0이라 비율을 계산할 수 없음',
  no_components: '반응 지표(좋아요·댓글·공유)를 하나도 제공받지 못함',
  source_window: '원천이 제공한 기간 집계값',
  decrease: '누적값이 감소함',
  not_computed: '이 화면에서는 계산하지 않음',
  too_short: '관측 구간이 너무 짧음',
  before_publish: '게시 이전 시점이라 0으로 정의됨',
  counter_decreased: '누적값이 줄어듦 (삭제·정정·원천 오류 가능). 순위에서 제외',
  empty_window: '기간 길이가 0',
  window_not_started: '기간이 데이터 기준 시각 이후에 시작함',
  not_published: '아직 게시되지 않음',
  zero_views: '조회수가 0이라 비율을 계산할 수 없음',
  insufficient_observations: '관측 횟수가 부족함',
  last_two_observations: '최근 24시간을 읽을 수 없어 마지막 두 관측으로 계산',
  previous_decreased: '이전 기간 누적값이 줄어들어 비교할 수 없음',
  no_window: '기간이 지정되지 않음',
  no_age_selected: '경과 일수가 지정되지 않음',
  not_enough_peers: '같은 계정의 비교 영상이 3개 미만',
  peer_median_zero: '비교 영상 중앙값이 0',
  computed_by_query: '검색 결과 안에서 계산됨',
  few_platform_peers: '같은 플랫폼 비교 영상이 5개 미만이라 백분위가 불안정함',
  sort_metric_unavailable: '정렬 지표 값이 없어 백분위를 계산하지 않음',
  no_tracked_videos: '추적 중인 영상이 없음',
  median_of_videos: '영상별 값의 중앙값',
  no_v7_values: '7일 경과 조회수를 읽을 수 있는 영상이 없음',
  partial: '일부 영상만 반영됨 (하한값)',
  partial_accounts: '일부 계정 값을 읽을 수 없음',
};

export function noteLabel(note: string | null | undefined): string | null {
  if (!note) return null;
  return NOTE_LABELS[note] ?? note;
}

/** How a metric value is formatted. */
export type MetricKind =
  /** Counter (views, likes...): compact 만/억 display, exact in tooltip. */
  | 'count'
  /** Counter per hour (velocity). */
  | 'perHour'
  /** 0..1 ratio shown as percent (engagement rate). */
  | 'rate'
  /** Growth ratio (current/previous - 1) shown as signed percent. */
  | 'growth'
  /** Multiplier (outperformance) shown as `2.3배`. */
  | 'multiplier'
  /** Percentile 0..100. */
  | 'percentile'
  /** Plain number with 1 decimal. */
  | 'number';

/** Compact display string for the value only (no marker). */
export function formatMetricValue(value: number | null, kind: MetricKind = 'count'): string {
  if (value === null || !Number.isFinite(value)) return DASH;
  switch (kind) {
    case 'count':
      return formatCompact(value);
    case 'perHour':
      return `${formatCompact(value)}/시간`;
    case 'rate':
      return formatPercent(value);
    case 'growth':
      return formatGrowth(value);
    case 'multiplier':
      return formatMultiplier(value);
    case 'percentile':
      return formatPercentile(value);
    case 'number':
      return formatDecimal(value, 1);
  }
}

/** Exact display string for tooltips: `12,345회`, `3.46%`, `+34%`. */
export function formatMetricExact(value: number | null, kind: MetricKind = 'count', unit = '회'): string {
  if (value === null || !Number.isFinite(value)) return DASH;
  switch (kind) {
    case 'count':
      return `${formatInteger(value)}${unit}`;
    case 'perHour':
      return `시간당 ${formatDecimal(value, 1)}${unit}`;
    case 'rate':
      return formatPercent(value, 2);
    case 'growth':
      return formatGrowth(value);
    case 'multiplier':
      return `${formatDecimal(value, 2)}배`;
    case 'percentile':
      return formatPercentile(value);
    case 'number':
      return formatDecimal(value, 2);
  }
}

export interface MetricDisplay {
  marker: string;
  text: string;
  meta: StatusMeta;
  /** Plain-language one-liner for screen readers: `기간 조회 증가 약 12,345회 (보간값)`. */
  spoken: string;
}

/** Everything a cell needs to render a MetricValue honestly. */
export function metricDisplay(
  m: Pick<MetricValue, 'value' | 'status'> | null | undefined,
  kind: MetricKind = 'count',
  label?: string,
): MetricDisplay {
  const status: MetricStatus = m?.status ?? 'unavailable';
  const meta = STATUS_META[status] ?? STATUS_META.unavailable;
  const value = m && meta.showsValue ? m.value : null;
  const text = meta.showsValue ? formatMetricValue(value, kind) : DASH;
  const exact = value === null ? meta.label : `${formatMetricExact(value, kind)} (${meta.label})`;
  const spoken = `${label ? `${label} ` : ''}${exact}`;
  return { marker: meta.showsValue ? meta.marker : '', text, meta, spoken };
}
