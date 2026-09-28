import { describe, expect, it } from 'vitest';
import { CSV_BOM, CSV_METRICS, csvField, formatCsvNumber, queryResultToCsv } from '../src/csv.ts';
import { queryVideos } from '../src/query.ts';
import { resolveWindow } from '../src/time.ts';
import type { QueryResult } from '../src/types.ts';
import { HOUR_MS, makeAccount, makeIndex, makeObs, makeVideo, obsOf, ts } from './fixtures.ts';

const SEOUL = 'Asia/Seoul';
const SEP = { start: '2026-09-01', end: '2026-09-30' };

/** Strict RFC 4180 parser: CRLF record separators; quoted fields may contain , " CR LF. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let i = 0;
  let quoted = false;
  let fieldStarted = false;
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        const next = text[i];
        if (next !== undefined && next !== ',' && next !== '\r') throw new Error(`garbage after closing quote at ${i}`);
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      if (fieldStarted) throw new Error(`bare quote inside unquoted field at ${i}`);
      quoted = true;
      fieldStarted = true;
      i++;
      continue;
    }
    if (c === ',') {
      row.push(field);
      field = '';
      fieldStarted = false;
      i++;
      continue;
    }
    if (c === '\r') {
      if (text[i + 1] !== '\n') throw new Error(`bare CR at ${i}`);
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      fieldStarted = false;
      i += 2;
      continue;
    }
    if (c === '\n') throw new Error(`bare LF outside quotes at ${i}`);
    field += c;
    fieldStarted = true;
    i++;
  }
  if (quoted) throw new Error('unterminated quote');
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

describe('csvField / formatCsvNumber (RFC 4180)', () => {
  it('quotes only when needed and doubles quotes', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField('한국어 제목')).toBe('한국어 제목');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('line1\nline2')).toBe('"line1\nline2"');
    expect(csvField('cr\rlf')).toBe('"cr\rlf"');
    expect(csvField(null)).toBe('');
    expect(csvField(undefined)).toBe('');
    expect(csvField('')).toBe('');
  });

  it('guards text cells against spreadsheet formula injection, but not numbers', () => {
    expect(csvField('=HYPERLINK("http://x")', true)).toBe('"\'=HYPERLINK(""http://x"")"');
    expect(csvField('+1', true)).toBe("'+1");
    expect(csvField('-dash', true)).toBe("'-dash");
    expect(csvField('@home', true)).toBe("'@home");
    expect(csvField('=1+1')).toBe('=1+1'); // non-text columns are left alone
    expect(csvField(-0.25)).toBe('-0.25');
  });

  it('numbers: raw, no locale separators, no float noise, non-finite -> empty', () => {
    expect(formatCsvNumber(1234567)).toBe('1234567');
    expect(formatCsvNumber(0.1 + 0.2)).toBe('0.3');
    expect(formatCsvNumber(1 / 3)).toBe('0.333333');
    expect(formatCsvNumber(-2.5)).toBe('-2.5');
    expect(formatCsvNumber(0)).toBe('0');
    expect(formatCsvNumber(Number.NaN)).toBe('');
    expect(formatCsvNumber(Infinity)).toBe('');
    expect(csvField(1e21)).toBe('1e+21');
  });
});

describe('queryResultToCsv', () => {
  const now = ts('2026-10-02T00:00Z');
  const sep = resolveWindow(SEP, SEOUL, now);
  const tricky = makeVideo({
    id: 'youtube:tricky',
    title: '뷰티 루틴, "최애" 제품\n2부',
    accountId: 'youtube:ch',
    publishedAt: ts('2026-09-10T01:30Z'),
    categories: [{ id: 'beauty/skincare', confidence: 0.9, evidence: [], by: 'rule', version: 't' }],
    topics: ['스킨케어', 'glass skin'],
    sponsorship: { level: 'disclosed', brands: ['브랜드A', 'Brand, Inc.'], evidence: [], version: 't' },
    language: 'ko',
    country: 'KR',
    format: 'short',
    obs: [obsOf('2026-09-10T02:30Z', { views: 10, likes: 1 }), obsOf(sep.endMs, { views: 2_000, likes: 150, comments: 12 })],
  });
  const noCounters = makeVideo({
    id: 'x:plain',
    title: '=cmd|calc',
    accountId: 'x:acc',
    publishedAt: ts('2026-09-12'),
    obs: [makeObs('2026-09-12T02:00Z', 5), makeObs(sep.endMs, 700)],
  });
  const index = makeIndex({
    videos: [tricky, noCounters],
    accounts: [makeAccount({ id: 'youtube:ch', name: '채널, "공식"' }), makeAccount({ id: 'x:acc', name: 'X 계정' })],
    generatedAt: now,
  });
  const result = queryVideos(index, { dateMode: 'upload', range: SEP, tz: SEOUL, sort: 'views_total', now });
  const csv = queryResultToCsv(result, SEOUL);
  const rows = parseCsv(csv.slice(1));
  const header = rows[0];
  const col = (name: string) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`missing column ${name}`);
    return i;
  };
  const row = (id: string) => rows.find((r) => r[col('영상 ID')] === id)!;

  it('starts with a UTF-8 BOM and uses CRLF records', () => {
    expect(csv.startsWith(CSV_BOM)).toBe(true);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(rows).toHaveLength(1 + result.rows.length);
    for (const r of rows) expect(r).toHaveLength(header.length);
  });

  it('round-trips Korean, commas, quotes and newlines', () => {
    const r = row('youtube:tricky');
    expect(r[col('제목')]).toBe('뷰티 루틴, "최애" 제품\n2부');
    expect(r[col('계정')]).toBe('채널, "공식"');
    expect(r[col('계정 ID')]).toBe('youtube:ch');
    expect(r[col('플랫폼')]).toBe('YouTube');
    expect(r[col('URL')]).toBe(tricky.url);
    expect(r[col('게시 시각(Asia/Seoul)')]).toBe('2026-09-10 10:30');
    expect(r[col('분야')]).toBe('뷰티 › 스킨케어');
    expect(r[col('주제')]).toBe('스킨케어; glass skin');
    expect(r[col('협찬')]).toBe('공개 표기');
    expect(r[col('협찬 브랜드')]).toBe('브랜드A; Brand, Inc.');
    expect(r[col('언어')]).toBe('ko');
    expect(r[col('업로드 국가(원천 제공)')]).toBe('KR');
    expect(r[col('형식')]).toBe('숏폼');
    expect(r[col('상태')]).toBe('공개');
    // the formula-looking title is neutralized
    expect(row('x:plain')[col('제목')]).toBe("'=cmd|calc");
  });

  it('exports every metric with value, status, asOf and note (missing is empty, never 0)', () => {
    for (const m of CSV_METRICS) {
      col(m.label);
      col(`${m.label} 상태`);
      col(`${m.label} 기준 시각(Asia/Seoul)`);
      col(`${m.label} 메모`);
    }
    const r = row('youtube:tricky');
    expect(r[col('누적 조회수')]).toBe('2000');
    expect(r[col('누적 조회수 상태')]).toBe('정확(exact)');
    expect(r[col('누적 조회수 기준 시각(Asia/Seoul)')]).toBe('2026-10-01 00:00');
    expect(r[col('기간 댓글')]).toBe('12');
    expect(r[col('참여율')]).toBe(String(Number(((150 + 12) / 2000).toFixed(6))));
    expect(r[col('참여율 합산 항목')]).toBe('likes+comments');
    const x = row('x:plain');
    expect(x[col('기간 좋아요')]).toBe('');
    expect(x[col('기간 좋아요 상태')]).toBe('계산 불가(unavailable)');
    expect(x[col('기간 좋아요 메모')]).toBe('counter_not_provided');
    expect(x[col('참여율')]).toBe('');
    expect(x[col('참여율 합산 항목')]).toBe('');
    expect(x[col('플랫폼 내 백분위')]).toBe('50');
    expect(x[col('성과 비교 영상 수')]).toBe('0');
  });

  it('exports the window information and data as-of time', () => {
    const r = row('youtube:tricky');
    expect(r[col('날짜 기준')]).toBe('업로드 기간');
    expect(r[col('기간 시작')]).toBe('2026-09-01');
    expect(r[col('기간 종료(포함)')]).toBe('2026-09-30');
    expect(r[col('기간 시간대')]).toBe('Asia/Seoul');
    expect(r[col('기간 완료 여부')]).toBe('완료');
    expect(r[col('데이터 기준 시각(Asia/Seoul)')]).toBe('2026-10-02 09:00');
  });

  it('shows a running window, other display zones and age-mode labels', () => {
    const running = queryVideos(index, { dateMode: 'activity', range: SEP, tz: SEOUL, sort: 'views_period', now: ts('2026-09-28') });
    const rr = parseCsv(queryResultToCsv(running, 'Australia/Sydney').slice(1));
    const h = rr[0];
    expect(h).toContain('게시 시각(Australia/Sydney)');
    const r1 = rr[1];
    expect(r1[h.indexOf('기간 완료 여부')]).toBe('진행 중(부분 집계)');
    expect(r1[h.indexOf('날짜 기준')]).toBe('조회 발생 기간');
    // the window keeps its own zone
    expect(r1[h.indexOf('기간 시작')]).toBe('2026-09-01');
    expect(r1[h.indexOf('기간 시간대')]).toBe('Asia/Seoul');
    const age = queryVideos(index, { dateMode: 'age', ageDays: 7, tz: SEOUL, sort: 'views_at_age', now });
    const ra = parseCsv(queryResultToCsv(age, SEOUL).slice(1));
    expect(ra[1][ra[0].indexOf('날짜 기준')]).toBe('게시 후 경과시간(V7)');
    expect(ra[1][ra[0].indexOf('기간 시작')]).toBe('');
    expect(parseCsv(queryResultToCsv(age, SEOUL, { dateMode: 'age', ageDays: 30 }).slice(1))[1][ra[0].indexOf('날짜 기준')]).toBe('게시 후 경과시간(V30)');
  });

  it('an empty result is just the header', () => {
    const empty: QueryResult = { rows: [], total: 0, window: null, now, notes: [] };
    const text = queryResultToCsv(empty, SEOUL);
    expect(parseCsv(text.slice(1))).toHaveLength(1);
    expect(text.split('\r\n').filter(Boolean)).toHaveLength(1);
  });

  it('keeps full precision for large counts and uses the row account fallback', () => {
    const big = makeVideo({ id: 'youtube:big', accountId: 'youtube:none', publishedAt: ts('2026-09-15'), obs: [makeObs('2026-09-15T01:00Z', 1), makeObs(sep.endMs - HOUR_MS, 3_456_789_012)] });
    const idx = makeIndex({ videos: [big], accounts: [], generatedAt: now });
    const r = queryVideos(idx, { dateMode: 'upload', range: SEP, tz: SEOUL, sort: 'views_total', now });
    const parsed = parseCsv(queryResultToCsv(r, SEOUL).slice(1));
    expect(parsed[1][parsed[0].indexOf('누적 조회수')]).toBe('3456789012');
    expect(parsed[1][parsed[0].indexOf('계정')]).toBe('');
    expect(parsed[1][parsed[0].indexOf('계정 ID')]).toBe('youtube:none');
  });
});
