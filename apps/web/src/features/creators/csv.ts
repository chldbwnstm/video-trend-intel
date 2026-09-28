/**
 * Page-level CSV exports that are not video query results (creator list here; the brand leaderboard reuses
 * the period helpers). Every row carries the period context: which window the numbers cover, in which time
 * zone, whether the window is finished or rolling, which date semantics apply and the data as-of time. This
 * mirrors the window columns core `queryResultToCsv` writes for video exports so an exported number never
 * loses its period (SPEC principles 2, 3 and 7). Pure; tested in csv.test.ts.
 */
import { CSV_STATUS_LABELS, formatCsvNumber, formatInTz, localDateOf } from '@vti/core';
import type { CreatorSummary, DateMode, MetricValue, UtcWindow } from '@vti/core';
import { catLabel } from '../../lib/display.ts';
import { followersMetric } from './logic.ts';

export const DATE_MODE_CSV_LABELS: Record<DateMode, string> = {
  upload: '업로드 기간',
  activity: '조회 발생 기간',
  age: '게시 후 경과시간',
};

export interface PeriodCsvContext {
  /** The analysis window (half-open [startMs, endMs), `tz` = zone of its local dates). */
  window: UtcWindow;
  /** Rolling hours when the window is a rolling one ending at the data now (null = local date range). */
  rollingHours: number | null;
  /** Data "now" (as-of time of every value). */
  now: number;
  /** Date semantics label written on every row (e.g. `조회 발생 기간`). */
  dateMode: string;
}

/** Header cells of the period columns (the as-of column names its zone, like the video export). */
export function periodCsvHeader(tz: string): string[] {
  return ['기간 시작', '기간 끝', '시간대', '기간 상태', '날짜 기준', `데이터 기준 시각(${tz})`];
}

/**
 * Period cells for one export. Local date ranges: inclusive local start / end dates (the UI's "양 끝 포함");
 * rolling windows: local start / end date-times (they do not align to midnight).
 */
export function periodCsvFields(ctx: PeriodCsvContext): string[] {
  const { window: w, rollingHours, now, dateMode } = ctx;
  const tz = w.tz;
  const rolling = rollingHours !== null && rollingHours > 0;
  const start = rolling ? formatInTz(w.startMs, tz, 'datetime') : localDateOf(w.startMs, tz);
  const end = rolling ? formatInTz(w.endMs, tz, 'datetime') : localDateOf(Math.max(w.startMs, w.endMs - 1), tz);
  const state = rolling ? `롤링 ${rollingHours}시간 (데이터 기준 시각까지)` : w.incomplete ? '진행 중 (부분 집계)' : '완료';
  return [start, end, tz, state, dateMode, formatInTz(now, tz, 'datetime')];
}

/** CSV number: finite values with at most 6 decimals (no float noise), null for missing / non-finite. */
export function csvNumber(n: number | null | undefined): number | null {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  return Number(formatCsvNumber(n));
}

/** Korean status label with the machine value (same labels as the video export). */
export function csvStatusLabel(m: Pick<MetricValue, 'status'>): string {
  return CSV_STATUS_LABELS[m.status] ?? m.status;
}

/* ------------------------------------------------------------------------------------------ creators */

/** Date semantics of the exported columns: view / follower increases by activity, uploads by publish date. */
export const CREATORS_CSV_DATE_MODE = `${DATE_MODE_CSV_LABELS.activity} (기간 조회 증가·팔로워 증가) · ${DATE_MODE_CSV_LABELS.upload} (기간 업로드)`;

/**
 * Creator list as CSV rows (for `toCsv`): every metric with its status, plus the period context on every row
 * (window start / end, zone, finished / running / rolling, date semantics, data as-of) so an exported file
 * cannot lose its period. Rates are fractions (0.05 = 5%), at most 6 decimals; unknown values are empty, not 0.
 */
export function creatorCsvRows(rows: readonly CreatorSummary[], period: PeriodCsvContext | null): (string | number | null)[][] {
  const now = period?.now ?? Date.now();
  const tz = period?.window.tz ?? 'UTC';
  const header = [
    'key',
    '이름',
    '유형',
    '플랫폼',
    '추적 영상',
    '기간 업로드',
    '기간 조회 증가',
    '기간 조회 증가 상태',
    '팔로워',
    '팔로워 상태',
    '팔로워 증가',
    '팔로워 증가 상태',
    '참여율(비율)',
    '참여율 상태',
    'V7 중앙값',
    'V7 상태',
    '주요 분야',
    '협찬 영상',
    ...(period ? periodCsvHeader(tz) : []),
  ];
  const periodFields = period ? periodCsvFields(period) : [];
  const out: (string | number | null)[][] = [header];
  for (const s of rows) {
    const f = followersMetric(s.accounts, now);
    out.push([
      s.key,
      s.name,
      s.kind === 'creator' ? '크리에이터' : '계정',
      s.platforms.join('|'),
      s.videoCount,
      s.uploadsInWindow,
      csvNumber(s.viewsInWindow.value),
      csvStatusLabel(s.viewsInWindow),
      csvNumber(f.value),
      csvStatusLabel(f),
      csvNumber(s.followersGrowth.value),
      csvStatusLabel(s.followersGrowth),
      csvNumber(s.engagementRate.value),
      csvStatusLabel(s.engagementRate),
      csvNumber(s.medianV7.value),
      csvStatusLabel(s.medianV7),
      s.topCategories.map(catLabel).join('|'),
      s.sponsoredCount,
      ...periodFields,
    ]);
  }
  return out;
}
