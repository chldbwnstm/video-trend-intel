/**
 * CSV export of query results (UTF-8 with BOM for Excel Korean compatibility). OWNER: core-analytics agent.
 * Columns include every metric value AND its status, plus asOf, so exported numbers keep their provenance.
 */
import type { AgeDays, DateMode, MetricStatus, MetricValue, QueryResult, VideoMetrics, VideoRow } from './types.ts';
import { PLATFORM_LABELS } from './types.ts';
import { HOUR, formatInTz, isLocalDateWindow, localDateOf } from './time.ts';
import { categoryPathLabel } from './taxonomy.ts';

/** Byte-order mark so Excel opens the UTF-8 file with Korean intact. */
export const CSV_BOM = String.fromCharCode(0xfeff);
/** RFC 4180 record separator. */
export const CSV_EOL = '\r\n';

/** Status labels written to the CSV (Korean, with the machine value so the file stays parseable). */
export const CSV_STATUS_LABELS: Record<MetricStatus, string> = {
  exact: '정확(exact)',
  interpolated: '보간(interpolated)',
  lower_bound: '하한(lower_bound)',
  source_reported: '원천 보고(source_reported)',
  unavailable: '계산 불가(unavailable)',
  decrease_flagged: '감소 감지(decrease_flagged)',
};

/** Metrics exported, in column order, with their Korean header label. */
export const CSV_METRICS: readonly { key: keyof VideoMetrics; label: string }[] = [
  { key: 'viewsTotal', label: '누적 조회수' },
  { key: 'viewsPeriod', label: '기간 조회수' },
  { key: 'likesPeriod', label: '기간 좋아요' },
  { key: 'commentsPeriod', label: '기간 댓글' },
  { key: 'velocity', label: '증가 속도(시간당 조회)' },
  { key: 'growthVsPrev', label: '직전 기간 대비 성장률' },
  { key: 'engagementRate', label: '참여율' },
  { key: 'viewsAtAge', label: '경과시간 조회수' },
  { key: 'outperformance', label: '계정 평소 대비 성과' },
  { key: 'percentile', label: '플랫폼 내 백분위' },
];

/**
 * One RFC 4180 field: quoted when it contains a comma, double quote, CR or LF (quotes doubled).
 * `text` fields that start with a spreadsheet formula trigger (= + - @ tab CR) get a leading apostrophe so a
 * title like `=HYPERLINK(...)` is shown as text instead of being executed (CSV injection guard).
 */
export function csvField(value: string | number | null | undefined, text = false): string {
  if (value === null || value === undefined) return '';
  let s = typeof value === 'number' ? formatCsvNumber(value) : String(value);
  if (text && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Numbers without locale formatting; non-integers keep at most 6 decimals (no float noise), NaN/Infinity -> ''. */
export function formatCsvNumber(n: number): string {
  if (!Number.isFinite(n)) return '';
  if (Number.isInteger(n)) return String(n);
  return String(Number(n.toFixed(6)));
}

/** Join fields into one CSV record (no line terminator). */
export function csvRow(fields: readonly string[]): string {
  return fields.join(',');
}

function header(tz: string): string[] {
  const h = [
    '플랫폼',
    '영상 ID',
    'URL',
    '제목',
    '계정',
    '계정 ID',
    `게시 시각(${tz})`,
    '형식',
    '언어',
    '업로드 국가(원천 제공)',
    '상태',
    '분야',
    '주제',
    '협찬',
    '협찬 브랜드',
  ];
  for (const m of CSV_METRICS) {
    h.push(m.label, `${m.label} 상태`, `${m.label} 기준 시각(${tz})`, `${m.label} 메모`);
    if (m.key === 'engagementRate') h.push('참여율 합산 항목');
    if (m.key === 'outperformance') h.push('성과 비교 경과일', '성과 비교 영상 수');
  }
  h.push('날짜 기준', '기간 시작', '기간 끝', '기간 시간대', '기간 상태', `데이터 기준 시각(${tz})`);
  return h.map((x) => csvField(x, true));
}

const VIDEO_STATUS_KO: Record<string, string> = { active: '공개', deleted: '삭제됨', private: '비공개', unknown: '알 수 없음' };
/** Same labels as the UI's format filter and detail drawer (apps/web lib/display.ts FORMAT_LABELS). */
export const CSV_FORMAT_LABELS: Record<string, string> = { short: '쇼츠·숏폼', long: '일반 영상', live: '라이브', unknown: '형식 미상' };

function metricFields(m: MetricValue | undefined, tz: string): string[] {
  if (!m) return ['', '', '', ''];
  return [
    csvField(m.value),
    csvField(CSV_STATUS_LABELS[m.status] ?? m.status, true),
    csvField(m.asOf !== null && Number.isFinite(m.asOf) ? formatInTz(m.asOf, tz, 'datetime') : ''),
    csvField(m.note ?? '', true),
  ];
}

function rowFields(r: VideoRow, result: QueryResult, tz: string, modeLabel: string, windowFields: string[]): string[] {
  const v = r.video;
  const f: string[] = [
    csvField(PLATFORM_LABELS[v.platform] ?? v.platform, true),
    csvField(v.id, true),
    csvField(v.url, true),
    csvField(v.title, true),
    csvField(r.account?.name ?? '', true),
    csvField(v.accountId, true),
    csvField(Number.isFinite(v.publishedAt) ? formatInTz(v.publishedAt, tz, 'datetime') : ''),
    csvField(CSV_FORMAT_LABELS[v.format] ?? v.format, true),
    csvField(v.language ?? '', true),
    csvField(v.country ?? '', true),
    csvField(VIDEO_STATUS_KO[v.status] ?? v.status, true),
    csvField((v.categories ?? []).map((c) => categoryPathLabel(c.id)).join('; '), true),
    csvField((v.topics ?? []).join('; '), true),
    csvField(v.sponsorship ? (v.sponsorship.level === 'disclosed' ? '공개 표기' : '추정') : '', true),
    csvField(v.sponsorship ? v.sponsorship.brands.join('; ') : '', true),
  ];
  for (const m of CSV_METRICS) {
    const value = r.metrics[m.key] as MetricValue | undefined;
    f.push(...metricFields(value, tz));
    if (m.key === 'engagementRate') f.push(csvField(r.metrics.engagementRate?.components?.join('+') ?? '', true));
    if (m.key === 'outperformance') {
      f.push(csvField(r.metrics.outperformance?.ageDays ?? null), csvField(r.metrics.outperformance?.peers ?? null));
    }
  }
  f.push(csvField(modeLabel, true), ...windowFields, csvField(formatInTz(result.now, tz, 'datetime')));
  return f;
}

/**
 * Serialize a QueryResult as CSV: UTF-8 BOM, CRLF records, RFC 4180 quoting, Korean headers.
 * Columns: platform, video id, url, title, account (name + id), published (in `tz`), format, language, country,
 * video status, categories (path labels), topics, sponsorship (+ brands); then for every metric its value,
 * status, asOf (in `tz`) and note (+ engagement components, outperformance age/peers); then the window info
 * (date semantics, start, end, zone, state) and the data as-of time.
 * Numbers are raw (no thousands separators; rates as fractions, e.g. 0.05 = 5%); missing values are empty,
 * never 0. Only `result.rows` (the current page) is written; pass a query without `limit` to export everything.
 * Window columns, in the window's own zone (`window.tz`, also exported):
 * - a local date range: 기간 시작 / 기간 끝 = its inclusive local dates, 기간 상태 = '완료(날짜 양 끝 포함)' or
 *   '진행 중(부분 집계, 날짜 양 끝 포함)';
 * - a rolling window (ends not at local midnight): the half-open local date-times [start, end), 기간 상태 =
 *   '롤링 N시간(시작 포함·끝 미포함)', so a 168-hour window is never read as 8 calendar days.
 * Formats use the UI's labels (CSV_FORMAT_LABELS).
 * `options.dateMode` / `options.ageDays` label the date semantics; when omitted the label is read from the
 * result's first note (queryVideos always starts with the date-semantics note).
 */
export function queryResultToCsv(result: QueryResult, tz: string, options: { dateMode?: DateMode; ageDays?: AgeDays | null } = {}): string {
  const w = result.window;
  let windowFields = ['', '', '', ''];
  if (w && isLocalDateWindow(w)) {
    windowFields = [
      csvField(localDateOf(w.startMs, w.tz)),
      csvField(localDateOf(Math.max(w.startMs, w.endMs - 1), w.tz)),
      csvField(w.tz, true),
      csvField(w.incomplete ? '진행 중(부분 집계, 날짜 양 끝 포함)' : '완료(날짜 양 끝 포함)', true),
    ];
  } else if (w) {
    const hours = Math.round(((w.endMs - w.startMs) / HOUR) * 100) / 100;
    windowFields = [
      csvField(formatInTz(w.startMs, w.tz, 'datetime')),
      csvField(formatInTz(w.endMs, w.tz, 'datetime')),
      csvField(w.tz, true),
      csvField(`롤링 ${hours}시간(시작 포함·끝 미포함)${w.incomplete ? ', 진행 중(부분 집계)' : ''}`, true),
    ];
  }
  const modeLabel = dateModeLabel(result, options.dateMode, options.ageDays ?? null);
  const lines = [csvRow(header(tz))];
  for (const r of result.rows) lines.push(csvRow(rowFields(r, result, tz, modeLabel, windowFields)));
  return CSV_BOM + lines.join(CSV_EOL) + CSV_EOL;
}

const MODE_LABELS: Record<DateMode, string> = { upload: '업로드 기간', activity: '조회 발생 기간', age: '게시 후 경과시간' };

function dateModeLabel(result: QueryResult, mode: DateMode | undefined, ageDays: AgeDays | null): string {
  if (mode && MODE_LABELS[mode]) return mode === 'age' && ageDays ? `${MODE_LABELS.age}(V${ageDays})` : MODE_LABELS[mode];
  const first = result.notes[0] ?? '';
  for (const m of ['upload', 'activity', 'age'] as const) {
    if (!first.startsWith(MODE_LABELS[m])) continue;
    const age = m === 'age' ? /\(V(\d+)\)/.exec(first) : null;
    return age ? `${MODE_LABELS.age}(V${age[1]})` : MODE_LABELS[m];
  }
  return '';
}
