/**
 * Demand vs supply scatter: x = supply percentile, y = demand percentile, bubble area = supply (uploads in
 * our tracked set). Quadrants split at the 50th percentile; the upper-left one (수요↑ 공급↓) is the
 * opportunity area. Quadrant names sit outside the plot (above / below it) so bubbles never hide them. One series color, the selected topic in a second color with a direct label and a ring.
 * The ranked table on the page is the table twin.
 */
import { useMemo } from 'react';
import type { OpportunityItem } from '@vti/core';
import { CartesianGrid, LabelList, ReferenceArea, ReferenceLine, Scatter, ScatterChart, Tooltip as RTooltip, XAxis, YAxis, ZAxis } from 'recharts';
import { formatCompact, formatDecimal, formatInteger } from '../../lib/format.ts';
import { QUADRANT_LABELS, quadrantOf } from './logic.ts';

export interface OpportunityScatterProps {
  items: OpportunityItem[];
  selected: string | null;
  onSelect: (topic: string) => void;
  height?: number;
  platformLabel: string;
}

interface Point {
  x: number;
  y: number;
  z: number;
  topic: string;
  item: OpportunityItem;
  name?: string;
}

const axis = {
  stroke: 'var(--chart-axis)',
  tick: { fill: 'var(--chart-text)', fontSize: 11 },
  tickLine: false,
} as const;

/** Plot margins; the quadrant label rows outside the plot use the same left/right insets. */
const MARGIN = { top: 24, right: 16, bottom: 18, left: 0 } as const;
const Y_AXIS_WIDTH = 44;

/**
 * Quadrant names in a row above (upper quadrants) or below (lower quadrants) the plot, one per half, aligned
 * with the plot area. Drawn outside the chart so dense bubbles never cover them.
 */
function QuadrantRow({ left, right, strongLeft = false, below = false }: { left: string; right: string; strongLeft?: boolean; below?: boolean }) {
  return (
    <div className="grid grid-cols-2 gap-2 text-[11px] font-medium text-fg-3" style={{ paddingLeft: MARGIN.left + Y_AXIS_WIDTH, paddingRight: MARGIN.right }}>
      <span className={strongLeft ? 'font-semibold text-accent-text' : undefined}>
        <span aria-hidden>{below ? '↙' : '↖'} </span>
        {left}
      </span>
      <span className="text-right">
        {right}
        <span aria-hidden> {below ? '↘' : '↗'}</span>
      </span>
    </div>
  );
}

export function OpportunityScatter({ items, selected, onSelect, height = 340, platformLabel }: OpportunityScatterProps) {
  const points = useMemo<Point[]>(
    () => items.map((it) => ({ x: it.supplyPercentile, y: it.demandPercentile, z: it.supply, topic: it.topic, item: it })),
    [items],
  );
  const sel = selected ? points.filter((p) => p.topic === selected).map((p) => ({ ...p, name: `#${p.item.label}` })) : [];
  const maxSupply = Math.max(1, ...items.map((i) => i.supply));
  const click = (entry: unknown) => {
    const p = (entry as { payload?: Point } | undefined)?.payload;
    if (p?.topic) onSelect(p.topic);
  };

  return (
    <figure className="min-w-0">
      <figcaption className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-2">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="inline-block size-2.5 rounded-full opacity-60" style={{ background: 'var(--series-1)' }} />
          주제 {formatInteger(items.length)}개 (원 크기 = 업로드 수)
        </span>
        {sel.length ? (
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="inline-block size-2.5 rounded-full" style={{ background: 'var(--series-2)' }} />
            선택: {sel[0].name}
          </span>
        ) : null}
      </figcaption>
      <QuadrantRow left={QUADRANT_LABELS.opportunity} right={QUADRANT_LABELS.competitive} strongLeft />
      <div role="img" aria-label={`${platformLabel} 주제별 수요 백분위(세로)와 공급 백분위(가로) 산점도. 왼쪽 위 ${QUADRANT_LABELS.opportunity}, 오른쪽 위 ${QUADRANT_LABELS.competitive}, 왼쪽 아래 ${QUADRANT_LABELS.niche}, 오른쪽 아래 ${QUADRANT_LABELS.saturated}. 값은 아래 표로 볼 수 있음.`}>
        <ScatterChart responsive style={{ width: '100%', height }} margin={MARGIN}>
          <CartesianGrid stroke="var(--chart-grid)" />
          <ReferenceArea x1={0} x2={50} y1={50} y2={100} fill="var(--accent-soft)" fillOpacity={0.7} stroke="none" />
          <ReferenceLine x={50} stroke="var(--chart-axis)" strokeDasharray="4 4" />
          <ReferenceLine y={50} stroke="var(--chart-axis)" strokeDasharray="4 4" />
          <XAxis
            type="number"
            dataKey="x"
            domain={[0, 100]}
            ticks={[0, 25, 50, 75, 100]}
            {...axis}
            label={{ value: '공급 백분위 (업로드 수) →', position: 'insideBottom', offset: -12, fill: 'var(--chart-text)', fontSize: 11 }}
          />
          <YAxis
            type="number"
            dataKey="y"
            domain={[0, 100]}
            ticks={[0, 25, 50, 75, 100]}
            width={Y_AXIS_WIDTH}
            {...axis}
            label={{ value: '수요 백분위 →', angle: -90, position: 'insideLeft', offset: 12, fill: 'var(--chart-text)', fontSize: 11 }}
          />
          <ZAxis type="number" dataKey="z" domain={[0, maxSupply]} range={[24, 360]} />
          <RTooltip
            isAnimationActive={false}
            cursor={{ stroke: 'var(--chart-axis)', strokeDasharray: '3 3' }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const p = payload[0].payload as Point;
              const it = p.item;
              return (
                <div className="max-w-64 rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-pop">
                  <p className="mb-1 truncate font-semibold text-fg">#{it.label}</p>
                  <p className="text-fg-3">{QUADRANT_LABELS[quadrantOf(it)]}</p>
                  <p className="mt-1 text-fg-2">
                    수요(누적 조회 중앙값) <span className="font-semibold text-fg tabular">{formatCompact(it.demand)}</span> · 백분위 {formatDecimal(it.demandPercentile, 0)}
                  </p>
                  <p className="text-fg-2">
                    공급(업로드) <span className="font-semibold text-fg tabular">{formatInteger(it.supply)}개</span> · 백분위 {formatDecimal(it.supplyPercentile, 0)}
                  </p>
                  <p className="text-fg-2">
                    기회 점수 <span className="font-semibold text-fg tabular">{formatDecimal(it.score, 0)}</span>
                  </p>
                  <p className="mt-1 text-fg-3">점을 누르면 선택됨</p>
                </div>
              );
            }}
          />
          <Scatter
            name="주제"
            data={points}
            fill="var(--series-1)"
            fillOpacity={0.45}
            stroke="var(--surface)"
            strokeWidth={1}
            isAnimationActive={false}
            onClick={click}
            className="cursor-pointer"
          />
          {sel.length ? (
            <Scatter name="선택한 주제" data={sel} fill="var(--series-2)" stroke="var(--surface)" strokeWidth={2} isAnimationActive={false}>
              <LabelList dataKey="name" position="top" offset={10} fill="var(--fg)" fontSize={12} fontWeight={600} stroke="var(--surface)" strokeWidth={3} paintOrder="stroke" />
            </Scatter>
          ) : null}
        </ScatterChart>
      </div>
      <QuadrantRow left={QUADRANT_LABELS.niche} right={QUADRANT_LABELS.saturated} below />
    </figure>
  );
}
