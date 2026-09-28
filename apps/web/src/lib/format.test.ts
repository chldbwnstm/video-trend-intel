import { describe, expect, it } from 'vitest';
import {
  DASH,
  formatBytes,
  formatCompact,
  formatCount,
  formatDecimal,
  formatDuration,
  formatGrowth,
  formatInteger,
  formatMultiplier,
  formatPercent,
  formatPercentile,
  formatRelative,
  hoursBetween,
} from './format.ts';

describe('formatInteger / formatDecimal', () => {
  it('groups with ko-KR separators and rounds', () => {
    expect(formatInteger(12345)).toBe('12,345');
    expect(formatInteger(1234.6)).toBe('1,235');
    expect(formatInteger(0)).toBe('0');
    expect(formatInteger(-9876)).toBe('-9,876');
  });
  it('renders null / NaN / Infinity as a dash, never 0', () => {
    expect(formatInteger(null)).toBe(DASH);
    expect(formatInteger(undefined)).toBe(DASH);
    expect(formatInteger(Number.NaN)).toBe(DASH);
    expect(formatInteger(Number.POSITIVE_INFINITY)).toBe(DASH);
    expect(formatDecimal(null)).toBe(DASH);
  });
  it('formats decimals with the requested digits', () => {
    expect(formatDecimal(1234.56)).toBe('1,234.6');
    expect(formatDecimal(1234.56, 2)).toBe('1,234.56');
    expect(formatDecimal(1234.56, 0)).toBe('1,235');
    expect(formatDecimal(1.23456, 3)).toBe('1.235');
  });
});

describe('formatCompact (만/억/조)', () => {
  it('keeps values below 10,000 in full', () => {
    expect(formatCompact(0)).toBe('0');
    expect(formatCompact(7)).toBe('7');
    expect(formatCompact(9999)).toBe('9,999');
    expect(formatCompact(2.5)).toBe('2.5');
  });
  it('uses 만 with one decimal below 1,000만', () => {
    expect(formatCompact(10_000)).toBe('1만');
    expect(formatCompact(12_345)).toBe('1.2만');
    expect(formatCompact(1_234_567)).toBe('123.5만');
    expect(formatCompact(9_999_999)).toBe('1,000만');
  });
  it('drops decimals at >= 1,000 units', () => {
    expect(formatCompact(98_765_432)).toBe('9,877만');
  });
  it('carries into the next unit instead of showing 10,000만', () => {
    expect(formatCompact(99_995_000)).toBe('1억');
    expect(formatCompact(9_999.6)).toBe('1만');
  });
  it('uses 억 and 조', () => {
    expect(formatCompact(123_456_789)).toBe('1.2억');
    expect(formatCompact(1_000_000_000)).toBe('10억');
    expect(formatCompact(2_500_000_000_000)).toBe('2.5조');
  });
  it('keeps the sign for negative values (flagged decreases)', () => {
    expect(formatCompact(-12_345)).toBe('-1.2만');
    expect(formatCompact(-500)).toBe('-500');
  });
  it('dash for missing values', () => {
    expect(formatCompact(null)).toBe(DASH);
    expect(formatCompact(Number.NaN)).toBe(DASH);
  });
});

describe('percent / growth / multiplier / percentile', () => {
  it('formats ratios as percent', () => {
    expect(formatPercent(0.0345)).toBe('3.5%');
    expect(formatPercent(0.0012)).toBe('0.12%');
    expect(formatPercent(0)).toBe('0%');
    expect(formatPercent(1)).toBe('100%');
    expect(formatPercent(0.12345, 2)).toBe('12.35%');
    expect(formatPercent(null)).toBe(DASH);
  });
  it('formats growth with explicit sign', () => {
    expect(formatGrowth(0.34)).toBe('+34%');
    expect(formatGrowth(-0.125)).toBe('-13%');
    expect(formatGrowth(0.056)).toBe('+5.6%');
    expect(formatGrowth(-0.056)).toBe('-5.6%');
    expect(formatGrowth(9.99)).toBe('+999%');
    expect(formatGrowth(12.3)).toBe('13.3배');
    expect(formatGrowth(3957)).toBe('3,958배');
    expect(formatGrowth(0.0001)).toBe('0%');
    expect(formatGrowth(null)).toBe(DASH);
  });
  it('formats multipliers and percentiles', () => {
    expect(formatMultiplier(2.345)).toBe('2.3배');
    expect(formatMultiplier(12.6)).toBe('13배');
    expect(formatPercentile(87.4)).toBe('백분위 87');
    expect(formatPercentile(null)).toBe(DASH);
  });
});

describe('durations, relative time, bytes, counts', () => {
  it('formats durations', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(3723)).toBe('1:02:03');
    expect(formatDuration(null)).toBe(DASH);
    expect(formatDuration(-1)).toBe(DASH);
  });
  it('formats relative time in Korean', () => {
    const now = Date.UTC(2026, 8, 28, 12);
    expect(formatRelative(now - 10_000, now)).toBe('방금');
    expect(formatRelative(now - 5 * 60_000, now)).toBe('5분 전');
    expect(formatRelative(now - 3 * 3_600_000, now)).toBe('3시간 전');
    expect(formatRelative(now - 2 * 86_400_000, now)).toBe('2일 전');
    expect(formatRelative(now - 90 * 86_400_000, now)).toBe('3개월 전');
    expect(formatRelative(now + 2 * 3_600_000, now)).toBe('2시간 후');
    expect(formatRelative(null, now)).toBe(DASH);
  });
  it('hoursBetween rounds to one decimal', () => {
    expect(hoursBetween(0, 5_400_000)).toBe(1.5);
  });
  it('formats bytes and counts', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5.44 * 1024 * 1024)).toBe('5.4 MB');
    expect(formatBytes(null)).toBe(DASH);
    expect(formatCount(1234, '개')).toBe('1,234개');
    expect(formatCount(null, '개')).toBe(DASH);
  });
});
