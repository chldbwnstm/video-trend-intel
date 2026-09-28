/**
 * Chart wrappers over recharts, styled with theme tokens (dataviz rules: thin 2px lines, hairline grid,
 * recessive axes, legend for >= 2 series, a hover tooltip, and a table twin so values never live only in
 * a tooltip). Plus BarList: an HTML bar list for ranked categorical splits (label + bar + value).
 */
import { useId, useMemo } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, Tooltip as RTooltip, XAxis, YAxis } from 'recharts';
import type { MetricStatus } from '@vti/core';
import { cx } from '../lib/cx.ts';
import { fmtTime } from '../lib/display.ts';
import { formatCompact } from '../lib/format.ts';
import { formatMetricExact, formatMetricValue, STATUS_META } from '../lib/metricStatus.ts';
import type { MetricKind } from '../lib/metricStatus.ts';
import { useTz } from '../data/hooks.ts';

/* ------------------------------------------------------------------------------------------ SparkLine */

export interface SparkLineProps {
  data: (number | null)[];
  /** Optional x labels (same length as data) for the tooltip, e.g. dates. */
  labels?: string[];
  height?: number;
  color?: string;
  /** Fill under the line. */
  area?: boolean;
  /** Accessible description, e.g. `최근 30일 일별 업로드 수`. */
  label: string;
  kind?: MetricKind;
  className?: string;
}

export function SparkLine({ data, labels, height = 36, color = 'var(--series-1)', area = true, label, kind = 'count', className }: SparkLineProps) {
  const gradId = useId().replace(/:/g, '');
  const rows = useMemo(() => data.map((v, i) => ({ i, v, label: labels?.[i] ?? String(i + 1) })), [data, labels]);
  const nums = data.filter((v): v is number => v !== null && Number.isFinite(v));
  const summary = nums.length
    ? `${label}: 최소 ${formatMetricValue(Math.min(...nums), kind)}, 최대 ${formatMetricValue(Math.max(...nums), kind)}, 마지막 ${formatMetricValue(nums[nums.length - 1], kind)}`
    : `${label}: 데이터 없음`;
  if (!nums.length) {
    return <div className={cx('text-xs text-fg-3', className)} style={{ height }} role="img" aria-label={summary} />;
  }
  const tooltip = (
    <RTooltip
      cursor={{ stroke: 'var(--chart-axis)', strokeWidth: 1 }}
      isAnimationActive={false}
      content={({ active, payload }) => {
        if (!active || !payload?.length) return null;
        const row = payload[0].payload as { v: number | null; label: string };
        return (
          <div className="rounded-md border border-line bg-surface px-2 py-1 text-xs shadow-pop">
            <span className="text-fg-3">{row.label}</span> <span className="font-semibold text-fg tabular">{formatMetricValue(row.v, kind)}</span>
          </div>
        );
      }}
    />
  );
  return (
    <div className={cx('w-full', className)} role="img" aria-label={summary}>
      {area ? (
        <AreaChart responsive data={rows} style={{ width: '100%', height }} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.25} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <YAxis hide domain={['dataMin', 'dataMax']} />
          {tooltip}
          <Area type="monotone" dataKey="v" stroke={color} strokeWidth={2} fill={`url(#${gradId})`} connectNulls isAnimationActive={false} dot={false} />
        </AreaChart>
      ) : (
        <LineChart responsive data={rows} style={{ width: '100%', height }} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
          <YAxis hide domain={['dataMin', 'dataMax']} />
          {tooltip}
          <Line type="monotone" dataKey="v" stroke={color} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
        </LineChart>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ GrowthChart */

export interface GrowthPoint {
  /** Epoch ms (time axis) or a category label such as a local date `2026-09-28`. */
  x: number | string;
  value: number | null;
  status?: MetricStatus;
}

export interface GrowthSeries {
  id: string;
  label: string;
  /** CSS color; defaults to the categorical slot by series index (`var(--series-N)`). */
  color?: string;
  points: GrowthPoint[];
}

export interface GrowthChartProps {
  series: GrowthSeries[];
  /** `line` for cumulative counters, `bar` for per-day increments. */
  variant?: 'line' | 'bar';
  height?: number;
  kind?: MetricKind;
  /** Title used for the accessible label and the table caption. */
  title: string;
  /** Show the "표로 보기" table twin (default true). */
  table?: boolean;
  /** Time-axis tick style (numeric x only). */
  xStyle?: 'date' | 'datetime';
  className?: string;
  /** Rendered when every point is null. */
  empty?: ReactNode;
}

type Row = { x: number | string } & Record<string, number | string | null>;

export function mergeSeries(series: GrowthSeries[]): Row[] {
  const byX = new Map<number | string, Row>();
  for (const s of series) {
    for (const p of s.points) {
      let row = byX.get(p.x);
      if (!row) {
        row = { x: p.x };
        byX.set(p.x, row);
      }
      row[s.id] = p.value;
      if (p.status) row[`${s.id}__status`] = p.status;
    }
  }
  const rows = [...byX.values()];
  rows.sort((a, b) => (typeof a.x === 'number' && typeof b.x === 'number' ? a.x - b.x : String(a.x).localeCompare(String(b.x))));
  return rows;
}

function seriesColor(s: GrowthSeries, i: number): string {
  return s.color ?? `var(--series-${(i % 8) + 1})`;
}

export function GrowthChart({ series, variant = 'line', height = 240, kind = 'count', title, table = true, xStyle = 'date', className, empty }: GrowthChartProps) {
  const tz = useTz();
  const rows = useMemo(() => mergeSeries(series), [series]);
  const numericX = rows.length > 0 && typeof rows[0].x === 'number';
  const hasData = series.some((s) => s.points.some((p) => p.value !== null && Number.isFinite(p.value)));
  const fmtX = (x: number | string, style: 'date' | 'datetime' = xStyle) =>
    typeof x === 'number' ? (style === 'date' ? fmtTime(x, tz, 'date').slice(5) : fmtTime(x, tz, 'datetime').slice(5)) : String(x).length === 10 ? String(x).slice(5) : String(x);
  const fmtXFull = (x: number | string) => (typeof x === 'number' ? fmtTime(x, tz, 'datetime') : String(x));

  if (!hasData) {
    return <div className={cx('flex items-center justify-center text-sm text-fg-3', className)} style={{ height }}>{empty ?? '표시할 관측값 없음'}</div>;
  }

  const axisProps = {
    stroke: 'var(--chart-axis)',
    tick: { fill: 'var(--chart-text)', fontSize: 11 },
    tickLine: false,
  } as const;

  const tooltip = (
    <RTooltip
      isAnimationActive={false}
      cursor={variant === 'bar' ? { fill: 'var(--surface-3)', opacity: 0.6 } : { stroke: 'var(--chart-axis)', strokeWidth: 1 }}
      content={({ active, payload, label }) => {
        if (!active || !payload?.length) return null;
        const row = payload[0].payload as Row;
        return (
          <div className="min-w-40 rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-pop">
            <p className="mb-1 font-medium text-fg-2">{fmtXFull((label as number | string | undefined) ?? row.x)}</p>
            {series.map((s, i) => {
              const v = row[s.id] as number | null | undefined;
              const st = row[`${s.id}__status`] as MetricStatus | undefined;
              const meta = st ? STATUS_META[st] : null;
              return (
                <p key={s.id} className="flex items-center gap-2">
                  <span aria-hidden className="inline-block size-2 rounded-full" style={{ background: seriesColor(s, i) }} />
                  <span className="text-fg-3">{s.label}</span>
                  <span className="ml-auto font-semibold text-fg tabular">
                    {meta?.marker && meta.showsValue ? `${meta.marker} ` : ''}
                    {v === undefined || v === null || (meta && !meta.showsValue) ? '—' : formatMetricExact(v, kind)}
                  </span>
                </p>
              );
            })}
          </div>
        );
      }}
    />
  );

  const common = { responsive: true, data: rows, style: { width: '100%', height }, margin: { top: 8, right: 8, bottom: 0, left: 0 } };
  const xAxis = numericX ? (
    <XAxis dataKey="x" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={(v: number) => fmtX(v)} minTickGap={28} {...axisProps} />
  ) : (
    <XAxis dataKey="x" tickFormatter={(v: string) => fmtX(v)} minTickGap={16} {...axisProps} />
  );
  const yAxis = <YAxis width={52} tickFormatter={(v: number) => (kind === 'count' ? formatCompact(v) : formatMetricValue(v, kind))} axisLine={false} {...axisProps} />;
  const grid = <CartesianGrid stroke="var(--chart-grid)" vertical={false} />;

  return (
    <figure className={cx('min-w-0', className)}>
      {series.length > 1 ? (
        <figcaption className="mb-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-fg-2">
          {series.map((s, i) => (
            <span key={s.id} className="inline-flex items-center gap-1.5">
              <span aria-hidden className="inline-block h-0.5 w-3 rounded-full" style={{ background: seriesColor(s, i) }} />
              {s.label}
            </span>
          ))}
        </figcaption>
      ) : (
        <figcaption className="sr-only">{title}</figcaption>
      )}
      <div role="img" aria-label={`${title} 차트 (값은 아래 표로 볼 수 있음)`}>
        {variant === 'bar' ? (
          <BarChart {...common} barGap={2} barCategoryGap="20%">
            {grid}
            {xAxis}
            {yAxis}
            {tooltip}
            {series.map((s, i) => (
              <Bar key={s.id} dataKey={s.id} name={s.label} fill={seriesColor(s, i)} radius={[4, 4, 0, 0]} maxBarSize={28} isAnimationActive={false} />
            ))}
          </BarChart>
        ) : (
          <LineChart {...common}>
            {grid}
            {xAxis}
            {yAxis}
            {tooltip}
            {series.map((s, i) => (
              <Line
                key={s.id}
                type="linear"
                dataKey={s.id}
                name={s.label}
                stroke={seriesColor(s, i)}
                strokeWidth={2}
                dot={rows.length <= 40 ? { r: 2.5, strokeWidth: 0, fill: seriesColor(s, i) } : false}
                activeDot={{ r: 4, stroke: 'var(--surface)', strokeWidth: 2 }}
                connectNulls
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        )}
      </div>
      {table ? (
        <details className="mt-2 text-xs">
          <summary className="focus-ring w-fit cursor-pointer rounded-sm text-fg-3 hover:text-fg">표로 보기</summary>
          <div className="scroll-thin mt-2 max-h-64 overflow-auto rounded-md border border-line">
            <table className="w-full text-xs">
              <caption className="sr-only">{title}</caption>
              <thead>
                <tr>
                  <th scope="col" className="sticky top-0 bg-surface-2 px-2 py-1 text-left font-medium text-fg-3">
                    {numericX ? '시각' : '날짜'}
                  </th>
                  {series.map((s) => (
                    <th key={s.id} scope="col" className="sticky top-0 bg-surface-2 px-2 py-1 text-right font-medium text-fg-3">
                      {s.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={String(r.x)} className="border-t border-line">
                    <th scope="row" className="px-2 py-1 text-left font-normal text-fg-2 tabular">
                      {fmtXFull(r.x)}
                    </th>
                    {series.map((s) => {
                      const v = r[s.id] as number | null | undefined;
                      const st = r[`${s.id}__status`] as MetricStatus | undefined;
                      const meta = st ? STATUS_META[st] : null;
                      return (
                        <td key={s.id} className="px-2 py-1 text-right text-fg tabular">
                          {meta?.marker && meta.showsValue ? `${meta.marker} ` : ''}
                          {v === undefined || v === null || (meta && !meta.showsValue) ? '—' : formatMetricExact(v, kind)}
                          {meta && meta.marker ? <span className="sr-only"> ({meta.label})</span> : null}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}
    </figure>
  );
}

/* ------------------------------------------------------------------------------------------ BarList */

export interface BarListItem {
  key: string;
  label: ReactNode;
  value: number;
  /** Display text (defaults to formatCompact(value)). */
  display?: string;
  /** Secondary text under/after the label. */
  sub?: ReactNode;
  /** Bar color (default series-1). Use one color for one series; platform color only for platform identity. */
  color?: string;
  /** Router path: the label becomes a link. */
  to?: string;
  /** Plain-text label for screen readers when `label` is not a string. */
  srLabel?: string;
}

export interface BarListProps {
  items: BarListItem[];
  /** Scale max (default: max value). */
  max?: number;
  /** Accessible list label. */
  label: string;
  /** Show percent of total after the value. */
  showShare?: boolean;
  total?: number;
  className?: string;
}

/** Ranked horizontal bars rendered in HTML: every value is visible text (its own table twin). */
export function BarList({ items, max, label, showShare, total, className }: BarListProps) {
  const top = max ?? Math.max(0, ...items.map((i) => i.value));
  const sum = total ?? items.reduce((a, b) => a + b.value, 0);
  return (
    <ul aria-label={label} className={cx('flex flex-col gap-2', className)}>
      {items.map((it) => {
        const pct = top > 0 ? Math.max(0, Math.min(100, (it.value / top) * 100)) : 0;
        const share = showShare && sum > 0 ? `${((it.value / sum) * 100).toFixed(1)}%` : null;
        return (
          <li key={it.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1">
            <div className="min-w-0 truncate text-[13px] text-fg">
              {it.to ? (
                <Link to={it.to} className="focus-ring rounded-sm hover:text-accent-text hover:underline">
                  {it.label}
                </Link>
              ) : (
                it.label
              )}
              {it.sub ? <span className="ml-1.5 text-xs text-fg-3">{it.sub}</span> : null}
            </div>
            <div className="text-right text-[13px] font-medium text-fg tabular">
              {it.display ?? formatCompact(it.value)}
              {share ? <span className="ml-1.5 text-xs font-normal text-fg-3">{share}</span> : null}
            </div>
            <div className="col-span-2 h-1.5 overflow-hidden rounded-full bg-surface-3" aria-hidden>
              <div className="h-full rounded-full" style={{ width: `${pct}%`, background: it.color ?? 'var(--series-1)' }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
