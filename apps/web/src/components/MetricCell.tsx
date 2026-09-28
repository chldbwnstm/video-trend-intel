/**
 * MetricCell: the ONLY way to show a metric number (SPEC data principle 3).
 * Renders the compact value with its provenance marker (≈ 보간, ≥ 하한, 원천, — 계산 불가, ⚠ 감소) and a
 * tooltip explaining the status in Korean with the exact value, as-of time and the machine note.
 */
import type { MetricValue } from '@vti/core';
import { cx } from '../lib/cx.ts';
import { fmtTime } from '../lib/display.ts';
import { formatMetricExact, metricDisplay, noteLabel } from '../lib/metricStatus.ts';
import type { MetricKind, StatusTone } from '../lib/metricStatus.ts';
import { tzShort } from '../lib/timezones.ts';
import { useTz } from '../data/hooks.ts';
import { Tooltip } from './Tooltip.tsx';

export interface MetricCellProps {
  metric: Pick<MetricValue, 'value' | 'status'> & Partial<Pick<MetricValue, 'asOf' | 'note'>> & { components?: string[] } | null | undefined;
  /** Formatting kind (default 'count' = 만/억 compact). */
  kind?: MetricKind;
  /** Metric name for the tooltip and screen readers, e.g. `기간 조회 증가`. */
  label?: string;
  /** Source adapter/definition, e.g. `youtube-data-api@1`, shown in the tooltip. */
  source?: string | null;
  /** Unit for exact counts in the tooltip (default `회`). */
  unit?: string;
  align?: 'left' | 'right';
  size?: 'sm' | 'md' | 'lg';
  /** Extra tooltip line (Korean). */
  extra?: string;
  className?: string;
  /** Keyboard-focusable tooltip trigger (default true). */
  focusable?: boolean;
}

const TONE_CLASS: Record<StatusTone, string> = {
  neutral: 'text-fg',
  info: 'text-fg',
  warning: 'text-fg',
  muted: 'text-fg-3',
  danger: 'text-negative',
};

const MARKER_CLASS: Record<StatusTone, string> = {
  neutral: '',
  info: 'text-info',
  warning: 'text-warning',
  muted: 'text-fg-3',
  danger: 'text-negative',
};

const COMPONENT_LABELS: Record<string, string> = { likes: '좋아요', comments: '댓글', shares: '공유', views: '조회' };

export function MetricCell({
  metric,
  kind = 'count',
  label,
  source,
  unit = '회',
  align = 'right',
  size = 'sm',
  extra,
  className,
  focusable = true,
}: MetricCellProps) {
  const tz = useTz();
  const d = metricDisplay(metric, kind, label);
  const status = metric?.status ?? 'unavailable';
  const note = noteLabel(metric?.note);
  const asOf = metric?.asOf ?? null;
  const exact = d.meta.showsValue && metric?.value !== null && metric?.value !== undefined ? formatMetricExact(metric.value, kind, unit) : null;
  const components = metric?.components;

  const content = (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        {label ? <span className="font-semibold">{label}</span> : null}
        <span className={cx('rounded px-1.5 py-px text-xs', status === 'exact' ? 'bg-surface-3 text-fg-2' : 'bg-accent-soft text-accent-text')}>
          {d.meta.marker && status !== 'unavailable' ? `${d.meta.marker} ` : ''}
          {d.meta.label}
        </span>
      </div>
      {exact ? <div className="text-sm font-semibold tabular">{exact}</div> : null}
      <p className="text-fg-2">{d.meta.description}</p>
      {note ? <p className="text-fg-3">사유: {note}</p> : null}
      {components && components.length ? (
        <p className="text-fg-3">반영 항목: {components.map((c) => COMPONENT_LABELS[c] ?? c).join('·')}</p>
      ) : null}
      {asOf !== null ? (
        <p className="text-fg-3">
          기준 시각: {fmtTime(asOf, tz)} ({tzShort(tz)})
        </p>
      ) : null}
      {source ? <p className="text-fg-3">원천: {source}</p> : null}
      {extra ? <p className="text-fg-3">{extra}</p> : null}
    </div>
  );

  return (
    <Tooltip
      content={content}
      focusable={focusable}
      className={cx(
        'inline-flex items-baseline gap-1 whitespace-nowrap tabular',
        align === 'right' ? 'justify-end' : 'justify-start',
        size === 'lg' ? 'text-2xl font-semibold' : size === 'md' ? 'text-base font-semibold' : 'text-sm',
        TONE_CLASS[d.meta.tone],
        className,
      )}
    >
      {d.marker ? (
        <span
          aria-hidden
          className={cx(
            'metric-marker shrink-0',
            status === 'source_reported' ? 'rounded border border-current px-1 text-[10px] leading-4 font-medium' : 'text-[0.9em]',
            MARKER_CLASS[d.meta.tone],
          )}
        >
          {d.marker}
        </span>
      ) : null}
      <span aria-hidden>{d.text}</span>
      <span className="sr-only">{d.spoken}</span>
    </Tooltip>
  );
}
