import { describe, expect, it } from 'vitest';
import type { MetricStatus } from '@vti/core';
import { formatMetricExact, formatMetricValue, metricDisplay, noteLabel, STATUS_META, STATUS_ORDER } from './metricStatus.ts';

describe('STATUS_META', () => {
  it('covers every MetricStatus with the SPEC markers', () => {
    const all: MetricStatus[] = ['exact', 'interpolated', 'lower_bound', 'source_reported', 'unavailable', 'decrease_flagged'];
    expect([...STATUS_ORDER].sort()).toEqual([...all].sort());
    expect(STATUS_META.exact.marker).toBe('');
    expect(STATUS_META.interpolated.marker).toBe('≈');
    expect(STATUS_META.lower_bound.marker).toBe('≥');
    expect(STATUS_META.source_reported.marker).toBe('원천');
    expect(STATUS_META.unavailable.marker).toBe('—');
    expect(STATUS_META.decrease_flagged.marker).toBe('⚠');
  });
  it('has Korean labels and explanations for all statuses', () => {
    for (const s of STATUS_ORDER) {
      expect(STATUS_META[s].label).toMatch(/[가-힣]/);
      expect(STATUS_META[s].description.length).toBeGreaterThan(10);
    }
  });
  it('marks which statuses rank (core rankValue semantics)', () => {
    expect(STATUS_META.unavailable.ranked).toBe(false);
    expect(STATUS_META.decrease_flagged.ranked).toBe(false);
    expect(STATUS_META.lower_bound.ranked).toBe(true);
  });
});

describe('noteLabel', () => {
  it('translates known codes and keeps unknown codes visible', () => {
    expect(noteLabel('gap_too_wide')).toContain('관측 간격');
    expect(noteLabel('not_reached')).toContain('도달');
    expect(noteLabel('counter_not_provided')).toContain('제공하지 않음');
    expect(noteLabel('some_new_code')).toBe('some_new_code');
    expect(noteLabel(null)).toBeNull();
    expect(noteLabel('')).toBeNull();
  });
});

describe('formatMetricValue / formatMetricExact', () => {
  it('formats by kind', () => {
    expect(formatMetricValue(12_345, 'count')).toBe('1.2만');
    expect(formatMetricValue(1234.5, 'perHour')).toBe('1,235/시간');
    expect(formatMetricValue(0.0345, 'rate')).toBe('3.5%');
    expect(formatMetricValue(0.34, 'growth')).toBe('+34%');
    expect(formatMetricValue(2.345, 'multiplier')).toBe('2.3배');
    expect(formatMetricValue(87, 'percentile')).toBe('백분위 87');
    expect(formatMetricValue(1.25, 'number')).toBe('1.3');
    expect(formatMetricValue(null, 'count')).toBe('—');
  });
  it('exact tooltip strings', () => {
    expect(formatMetricExact(12_345)).toBe('12,345회');
    expect(formatMetricExact(12_345, 'count', '명')).toBe('12,345명');
    expect(formatMetricExact(12.34, 'perHour')).toBe('시간당 12.3회');
    expect(formatMetricExact(0.03456, 'rate')).toBe('3.46%');
    expect(formatMetricExact(2.345, 'multiplier')).toBe('2.35배');
  });
});

describe('metricDisplay', () => {
  it('shows exact values without a marker', () => {
    const d = metricDisplay({ value: 12_345, status: 'exact' }, 'count', '누적 조회');
    expect(d.marker).toBe('');
    expect(d.text).toBe('1.2만');
    expect(d.spoken).toBe('누적 조회 12,345회 (관측값)');
  });
  it('prefixes interpolated and lower bound values', () => {
    expect(metricDisplay({ value: 100, status: 'interpolated' }).marker).toBe('≈');
    const lb = metricDisplay({ value: 20_000, status: 'lower_bound' }, 'count', '기간 조회 증가');
    expect(lb.marker).toBe('≥');
    expect(lb.text).toBe('2만');
    expect(lb.spoken).toContain('하한값');
  });
  it('hides the value when unavailable (never shows 0)', () => {
    const d = metricDisplay({ value: 0, status: 'unavailable' }, 'count', '기간 조회 증가');
    expect(d.text).toBe('—');
    expect(d.marker).toBe('');
    expect(d.spoken).toBe('기간 조회 증가 계산 불가');
  });
  it('treats missing metrics as unavailable', () => {
    expect(metricDisplay(null).text).toBe('—');
    expect(metricDisplay(undefined).meta.label).toBe('계산 불가');
  });
  it('keeps decreased values visible with a warning marker', () => {
    const d = metricDisplay({ value: -1500, status: 'decrease_flagged' });
    expect(d.marker).toBe('⚠');
    expect(d.text).toBe('-1,500');
    expect(d.meta.ranked).toBe(false);
  });
  it('marks source-reported values', () => {
    const d = metricDisplay({ value: 5000, status: 'source_reported' });
    expect(d.marker).toBe('원천');
    expect(d.spoken).toContain('원천 제공값');
  });
  it('handles a null value with a value-bearing status defensively', () => {
    const d = metricDisplay({ value: null, status: 'exact' });
    expect(d.text).toBe('—');
  });
});
