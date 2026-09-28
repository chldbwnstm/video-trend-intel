/**
 * Cumulative views of one video from our observations. Observed points are dots; the lines between them
 * are interpolation and are drawn dashed, with a separate style for gaps we do not interpolate across,
 * for decreases (⚠) and for the synthetic publish anchor (0 views at publish). Its table twin is the raw
 * observation table in the drawer.
 */
import { useMemo } from 'react';
import { CartesianGrid, Line, LineChart, Tooltip as RTooltip, XAxis, YAxis } from 'recharts';
import type { Video } from '@vti/core';
import { useTz } from '../../data/hooks.ts';
import { fmtTime } from '../../lib/display.ts';
import { formatCompact, formatInteger } from '../../lib/format.ts';
import { tzShort } from '../../lib/timezones.ts';
import { buildViewsChart, SEGMENT_LABELS } from './model.ts';
import type { SegmentKind, ViewsChartModel, ViewsChartRow } from './model.ts';

const DAY_MS = 86_400_000;

const SEGMENT_STYLE: Record<SegmentKind, { stroke: string; dash: string; opacity: number }> = {
  interp: { stroke: 'var(--series-1)', dash: '6 4', opacity: 1 },
  anchor: { stroke: 'var(--series-1)', dash: '2 3', opacity: 0.8 },
  gap: { stroke: 'var(--chart-axis)', dash: '1 6', opacity: 1 },
  decrease: { stroke: 'var(--negative)', dash: '6 4', opacity: 1 },
};

export interface ViewsChartProps {
  video: Video;
  height?: number;
  /** Precomputed model (tests / callers that already built it). */
  model?: ViewsChartModel;
}

export function ViewsChart({ video, height = 220, model: given }: ViewsChartProps) {
  const tz = useTz();
  const model = useMemo(() => given ?? buildViewsChart(video), [given, video]);
  const { points, rows, kinds, anchor } = model;
  const drawable = points.length + (anchor ? 1 : 0) >= 2;

  if (!drawable) {
    return (
      <div className="rounded-lg border border-dashed border-line bg-surface-2 px-3 py-4 text-[13px] text-fg-3">
        {points.length === 0 ? (
          <p>조회수 관측이 아직 없음. 원천이 조회수를 제공하지 않았거나 아직 수집되지 않았음.</p>
        ) : (
          <p>
            관측 1회뿐이라 곡선을 그릴 수 없음 ({fmtTime(points[0].t, tz)} {tzShort(tz)} 관측 {formatInteger(points[0].v)}회). 수집은 약 3시간마다
            이뤄지므로 관측이 2회 이상 쌓이면 추이가 표시됨.
            {video.publishedAt < points[0].t ? ' 게시 후 48시간이 지나 처음 발견된 영상은 게시 시점부터 보간하지 않음.' : ''}
          </p>
        )}
      </div>
    );
  }

  const first = rows[0].x;
  const last = rows[rows.length - 1].x;
  const short = last - first < 3 * DAY_MS;
  const fmtTick = (v: number) => (short ? fmtTime(v, tz, 'datetime').slice(5) : fmtTime(v, tz, 'date').slice(5));
  const dotR = points.length > 60 ? 2.5 : 3.5;
  const summary = `누적 조회 추이: 관측 ${points.length}회, ${fmtTime(first, tz)}부터 ${fmtTime(last, tz)}까지 (${tzShort(tz)}). 값은 아래 원본 관측값 표에 있음.`;

  return (
    <figure className="min-w-0">
      <figcaption className="mb-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-fg-2">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="inline-block size-2 rounded-full" style={{ background: 'var(--series-1)' }} />
          관측값
        </span>
        {kinds.map((k) => (
          <span key={k} className="inline-flex items-center gap-1.5">
            <svg aria-hidden width="18" height="6" className="shrink-0">
              <line
                x1="0"
                y1="3"
                x2="18"
                y2="3"
                stroke={SEGMENT_STYLE[k].stroke}
                strokeWidth="2"
                strokeDasharray={SEGMENT_STYLE[k].dash}
                strokeOpacity={SEGMENT_STYLE[k].opacity}
              />
            </svg>
            {SEGMENT_LABELS[k]}
          </span>
        ))}
      </figcaption>
      <div role="img" aria-label={summary}>
        <LineChart responsive data={rows} style={{ width: '100%', height }} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
          <XAxis
            dataKey="x"
            type="number"
            scale="time"
            domain={['dataMin', 'dataMax']}
            tickFormatter={fmtTick}
            minTickGap={28}
            stroke="var(--chart-axis)"
            tick={{ fill: 'var(--chart-text)', fontSize: 11 }}
            tickLine={false}
          />
          <YAxis
            width={52}
            tickFormatter={(v: number) => formatCompact(v)}
            axisLine={false}
            stroke="var(--chart-axis)"
            tick={{ fill: 'var(--chart-text)', fontSize: 11 }}
            tickLine={false}
            domain={[0, 'auto']}
          />
          <RTooltip
            isAnimationActive={false}
            cursor={{ stroke: 'var(--chart-axis)', strokeWidth: 1 }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const row = payload[0].payload as ViewsChartRow;
              const value = row.isAnchor ? 0 : row.obs;
              const src = row.isAnchor ? null : points.find((p) => p.t === row.x)?.src;
              return (
                <div className="min-w-40 rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-pop">
                  <p className="mb-1 font-medium text-fg-2">
                    {fmtTime(row.x, tz)} {tzShort(tz)}
                  </p>
                  <p className="font-semibold text-fg tabular">{value === null ? '—' : `${formatInteger(value)}회`}</p>
                  <p className="text-fg-3">{row.isAnchor ? '게시 시점: 정의상 0' : `관측값${src ? ` · ${src}` : ''}`}</p>
                </div>
              );
            }}
          />
          {kinds.map((k) => (
            <Line
              key={k}
              type="linear"
              dataKey={k}
              name={SEGMENT_LABELS[k]}
              stroke={SEGMENT_STYLE[k].stroke}
              strokeOpacity={SEGMENT_STYLE[k].opacity}
              strokeWidth={2}
              strokeDasharray={SEGMENT_STYLE[k].dash}
              dot={false}
              activeDot={false}
              connectNulls={false}
              isAnimationActive={false}
            />
          ))}
          <Line
            type="linear"
            dataKey="obs"
            name="관측값"
            stroke="none"
            dot={{ r: dotR, fill: 'var(--series-1)', stroke: 'var(--surface)', strokeWidth: 1.5 }}
            activeDot={{ r: dotR + 1.5, fill: 'var(--series-1)', stroke: 'var(--surface)', strokeWidth: 2 }}
            connectNulls={false}
            isAnimationActive={false}
          />
        </LineChart>
      </div>
    </figure>
  );
}
