/**
 * Distribution of views-at-age (V{age}) within one platform's cohort on log-scale 1-2-5 bins, with the
 * selected video's bin highlighted (accent + a text label, not color alone) and a table twin.
 */
import { useMemo } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, Tooltip as RTooltip, XAxis, YAxis } from 'recharts';
import { formatInteger } from '../../lib/format.ts';
import { binIndexOf, logBins } from './logic.ts';

export interface VHistogramProps {
  /** Ranked V values of the cohort (any order). */
  values: number[];
  /** Selected video's V value (highlighted bin). */
  selected?: number | null;
  ageDays: number;
  platformLabel: string;
  height?: number;
}

export function VHistogram({ values, selected, ageDays, platformLabel, height = 220 }: VHistogramProps) {
  const bins = useMemo(() => logBins(values), [values]);
  const sel = binIndexOf(bins, selected);
  const rows = bins.map((b, i) => ({ i, label: b.label, count: b.count, selected: i === sel }));
  const title = `${platformLabel} V${ageDays} 분포 (로그 구간)`;
  if (!bins.length) return <p className="py-8 text-center text-sm text-fg-3">분포를 그릴 값 없음</p>;
  const hasSel = sel >= 0;
  return (
    <figure className="min-w-0">
      <figcaption className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-2">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="inline-block size-2.5 rounded-sm" style={{ background: hasSel ? 'var(--line-strong)' : 'var(--series-1)' }} />
          코호트 영상 수
        </span>
        {hasSel ? (
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="inline-block size-2.5 rounded-sm" style={{ background: 'var(--accent)' }} />
            선택 영상 구간 ({bins[sel].label}회)
          </span>
        ) : null}
      </figcaption>
      <div role="img" aria-label={`${title} 차트 (값은 아래 표로 볼 수 있음)`}>
        <BarChart responsive data={rows} style={{ width: '100%', height }} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="12%">
          <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
          <XAxis
            dataKey="label"
            stroke="var(--chart-axis)"
            tick={{ fill: 'var(--chart-text)', fontSize: 11 }}
            tickLine={false}
            minTickGap={12}
            tickFormatter={(v: string) => v.split('~')[0]}
          />
          <YAxis
            width={40}
            allowDecimals={false}
            axisLine={false}
            stroke="var(--chart-axis)"
            tick={{ fill: 'var(--chart-text)', fontSize: 11 }}
            tickLine={false}
          />
          <RTooltip
            isAnimationActive={false}
            cursor={{ fill: 'var(--surface-3)', opacity: 0.6 }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const r = payload[0].payload as (typeof rows)[number];
              return (
                <div className="rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-pop">
                  <p className="font-medium text-fg-2">V{ageDays} {r.label}회</p>
                  <p className="text-fg">
                    영상 <span className="font-semibold tabular">{formatInteger(r.count)}</span>개{r.selected ? ' · 선택 영상 포함' : ''}
                  </p>
                </div>
              );
            }}
          />
          <Bar dataKey="count" name="영상 수" radius={[4, 4, 0, 0]} isAnimationActive={false}>
            {rows.map((r) => (
              <Cell key={r.i} fill={hasSel ? (r.selected ? 'var(--accent)' : 'var(--line-strong)') : 'var(--series-1)'} />
            ))}
          </Bar>
        </BarChart>
      </div>
      <details className="mt-2 text-xs">
        <summary className="focus-ring w-fit cursor-pointer rounded-sm text-fg-3 hover:text-fg">표로 보기</summary>
        <div className="scroll-thin mt-2 max-h-64 overflow-auto rounded-md border border-line">
          <table className="w-full text-xs">
            <caption className="sr-only">{title}</caption>
            <thead>
              <tr>
                <th scope="col" className="sticky top-0 bg-surface-2 px-2 py-1 text-left font-medium text-fg-3">
                  V{ageDays} 구간(회)
                </th>
                <th scope="col" className="sticky top-0 bg-surface-2 px-2 py-1 text-right font-medium text-fg-3">
                  영상 수
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.i} className="border-t border-line">
                  <th scope="row" className="px-2 py-1 text-left font-normal text-fg-2 tabular">
                    {r.label}
                    {r.selected ? <span className="ml-1 font-medium text-accent-text">← 선택 영상</span> : null}
                  </th>
                  <td className="px-2 py-1 text-right text-fg tabular">{formatInteger(r.count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
