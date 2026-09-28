/**
 * Growth / change indicator: arrow + signed percent (+34%, -12%). Direction is encoded by the arrow and
 * sign, not by color alone. Accepts a plain ratio or a MetricValue (status-aware).
 */
import type { MetricValue } from '@vti/core';
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import { cx } from '../lib/cx.ts';
import { DASH, formatGrowth } from '../lib/format.ts';
import { STATUS_META } from '../lib/metricStatus.ts';

export interface NumberDeltaProps {
  /** Growth ratio: current / previous - 1 (0.34 = +34%). */
  value?: number | null;
  /** Alternative input carrying provenance; unavailable / decrease_flagged render as — with the status. */
  metric?: Pick<MetricValue, 'value' | 'status'> | null;
  /** Treat decreases as good (e.g. error rates). Default false. */
  invert?: boolean;
  size?: 'sm' | 'md';
  className?: string;
  /** Screen-reader prefix, e.g. `이전 기간 대비`. */
  label?: string;
}

export function NumberDelta({ value, metric, invert, size = 'sm', className, label = '이전 기간 대비' }: NumberDeltaProps) {
  let v: number | null = value ?? null;
  let statusNote: string | null = null;
  if (metric) {
    const meta = STATUS_META[metric.status];
    if (!meta.showsValue || metric.status === 'decrease_flagged') {
      v = null;
      statusNote = meta.label;
    } else {
      v = metric.value;
      if (metric.status !== 'exact') statusNote = meta.label;
    }
  }
  if (v === null || !Number.isFinite(v)) {
    return (
      <span className={cx('inline-flex items-center gap-0.5 text-fg-3', size === 'sm' ? 'text-xs' : 'text-sm', className)} title={statusNote ?? undefined}>
        <span aria-hidden>{DASH}</span>
        <span className="sr-only">{`${label} 변화율 없음${statusNote ? ` (${statusNote})` : ''}`}</span>
      </span>
    );
  }
  const text = formatGrowth(v);
  const flat = text === '0%';
  const up = v > 0 && !flat;
  const good = invert ? !up : up;
  const Icon = flat ? Minus : up ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={cx(
        'inline-flex items-center gap-0.5 font-medium whitespace-nowrap tabular',
        size === 'sm' ? 'text-xs' : 'text-sm',
        flat ? 'text-fg-3' : good ? 'text-positive' : 'text-negative',
        className,
      )}
      title={statusNote ?? undefined}
    >
      <Icon className={size === 'sm' ? 'size-3.5' : 'size-4'} aria-hidden />
      <span aria-hidden>{text}</span>
      <span className="sr-only">{`${label} ${up ? '증가' : flat ? '변화 없음' : '감소'} ${text}${statusNote ? ` (${statusNote})` : ''}`}</span>
    </span>
  );
}
