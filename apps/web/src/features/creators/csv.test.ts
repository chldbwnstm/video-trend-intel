/**
 * Page-level CSV exports (creators): every row carries the period context (window, zone, finished / running /
 * rolling, date semantics, data as-of) and numbers keep at most 6 decimals.
 */
import { describe, expect, it } from 'vitest';
import { buildIndex, presetRange, resolveAnalysisWindow, summarizeCreators } from '@vti/core';
import type { CreatorSummary, MetricValue } from '@vti/core';
import { ts } from '../../../../../packages/core/test/fixtures.ts';
import { toCsv } from '../../components/ExportCsvButton.tsx';
import { generateSampleDataset } from '../../../scripts/sample-generator.ts';
import { CREATORS_CSV_DATE_MODE, creatorCsvRows, csvNumber, csvStatusLabel, periodCsvFields, periodCsvHeader } from './csv.ts';

const TZ = 'Asia/Seoul';

describe('period columns', () => {
  const now = ts('2026-09-28T15:26'); // 2026-09-29 00:26 KST

  it('writes inclusive local dates for a finished date range', () => {
    const range = presetRange('lastMonth', TZ, now);
    const w = resolveAnalysisWindow(range, TZ, now, null);
    expect(periodCsvFields({ window: w, rollingHours: null, now, dateMode: '조회 발생 기간' })).toEqual([
      '2026-08-01',
      '2026-08-31',
      TZ,
      '완료',
      '조회 발생 기간',
      '2026-09-29 00:26',
    ]);
  });

  it('marks a running date range and a rolling window', () => {
    const today = resolveAnalysisWindow(presetRange('today', TZ, now), TZ, now, null);
    expect(periodCsvFields({ window: today, rollingHours: null, now, dateMode: 'x' }).slice(0, 4)).toEqual(['2026-09-29', '2026-09-29', TZ, '진행 중 (부분 집계)']);
    const rolling = resolveAnalysisWindow(presetRange('rolling7d', TZ, now), TZ, now, 168);
    expect(periodCsvFields({ window: rolling, rollingHours: 168, now, dateMode: 'x' }).slice(0, 4)).toEqual([
      '2026-09-22 00:26',
      '2026-09-29 00:26',
      TZ,
      '롤링 168시간 (데이터 기준 시각까지)',
    ]);
  });

  it('names the as-of column with its zone', () => {
    expect(periodCsvHeader(TZ)).toEqual(['기간 시작', '기간 끝', '시간대', '기간 상태', '날짜 기준', `데이터 기준 시각(${TZ})`]);
  });

  it('rounds non-integers to 6 decimals and keeps missing values empty (not 0)', () => {
    expect(csvNumber(0.024052028480044764)).toBe(0.024052);
    expect(csvNumber(1234)).toBe(1234);
    expect(csvNumber(-12)).toBe(-12);
    expect(csvNumber(null)).toBeNull();
    expect(csvNumber(Number.NaN)).toBeNull();
    expect(csvStatusLabel({ status: 'lower_bound' })).toBe('하한(lower_bound)');
  });
});

describe('creator CSV rows', () => {
  const dataset = generateSampleDataset({ videos: 300 });
  const index = buildIndex(dataset);
  const now = dataset.generatedAt;
  const range = presetRange('rolling7d', TZ, now);
  const rows = summarizeCreators(index, { range, rollingHours: 168, tz: TZ, now });
  const window = resolveAnalysisWindow(range, TZ, now, 168);

  it('adds the period context to every row', () => {
    const out = creatorCsvRows(rows, { window, rollingHours: 168, now, dateMode: CREATORS_CSV_DATE_MODE });
    const header = out[0] as string[];
    for (const h of ['기간 시작', '기간 끝', '시간대', '기간 상태', '날짜 기준']) expect(header).toContain(h);
    expect(out).toHaveLength(rows.length + 1);
    const state = header.indexOf('기간 상태');
    const mode = header.indexOf('날짜 기준');
    for (const r of out.slice(1)) {
      expect(r).toHaveLength(header.length);
      expect(r[state]).toBe('롤링 168시간 (데이터 기준 시각까지)');
      expect(r[mode]).toBe(CREATORS_CSV_DATE_MODE);
    }
  });

  it('writes statuses with labels, rates as short fractions and unknown values as empty cells', () => {
    const m = (value: number | null, status: MetricValue['status']): MetricValue => ({ value, status, asOf: null, note: null });
    const s: CreatorSummary = {
      ...rows[0],
      viewsInWindow: m(null, 'unavailable'),
      engagementRate: m(0.024052028480044764, 'exact'),
    };
    const out = creatorCsvRows([s], { window, rollingHours: 168, now, dateMode: CREATORS_CSV_DATE_MODE });
    const header = out[0] as string[];
    const row = out[1];
    expect(row[header.indexOf('기간 조회 증가')]).toBeNull();
    expect(row[header.indexOf('기간 조회 증가 상태')]).toBe('계산 불가(unavailable)');
    expect(row[header.indexOf('참여율(비율)')]).toBe(0.024052);
    const text = toCsv(out);
    expect(text).toContain(',0.024052,');
    expect(text).not.toContain('0.024052028');
  });
});
