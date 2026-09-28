/**
 * Result table of 영상 탐색: video cell (thumbnail, title link, platform, account, publish time in tz,
 * category chips, sponsorship badge) + the metric columns relevant to the date mode, all via MetricCell.
 * Sortable headers write the shared `sort` / `dir` URL keys. Clicking a row (or its 상세 button) opens
 * the detail drawer.
 */
import type { MouseEvent, ReactNode } from 'react';
import type { AgeDays, DateMode, SortKey, VideoRow } from '@vti/core';
import { PanelRightOpen } from 'lucide-react';
import { Badge, CategoryChip, DataTable, IconButton, MetricCell, VideoCell } from '../../components/index.ts';
import type { Column } from '../../components/index.ts';
import { useTz } from '../../data/hooks.ts';
import { fmtTime } from '../../lib/display.ts';
import type { MetricKind } from '../../lib/metricStatus.ts';
import { tzShort } from '../../lib/timezones.ts';
import { hrefWith } from '../../lib/urlState.ts';
import type { ParamPatch } from '../../lib/urlState.ts';
import { metricSource, primaryMetricLabel, SPONSOR_LEVEL_LABELS, sortLabel, sortMetric } from './model.ts';

export interface ResultsTableProps {
  rows: VideoRow[];
  mode: DateMode;
  age: AgeDays;
  sort: SortKey;
  dir: 'asc' | 'desc';
  onSortChange: (key: SortKey, dir: 'asc' | 'desc') => void;
  onOpen: (videoId: string) => void;
  selectedId: string;
  /** Rank offset of the first row (page offset). */
  offset: number;
  dense: boolean;
  stale: boolean;
  empty: ReactNode;
  /** Date params carried into category chip links. */
  linkParams: ParamPatch;
  caption: string;
}

interface MetricColumnSpec {
  key: Exclude<SortKey, 'published_at' | 'percentile'> | 'percentile';
  header: string;
  kind: MetricKind;
  hint: string;
  hideBelow?: 'sm' | 'md' | 'lg';
  width: string;
}

/** Stops a row click when the click happened on a link or button inside the cell. */
function guardInteractive(e: MouseEvent) {
  if ((e.target as HTMLElement | null)?.closest?.('a,button,input,select,label')) e.stopPropagation();
}

/** Metric columns shown for a date mode (the sort metric is added when it is not among them). */
export function metricColumnsFor(mode: DateMode, age: AgeDays, sort: SortKey): MetricColumnSpec[] {
  const total: MetricColumnSpec = { key: 'views_total', header: '누적 조회', kind: 'count', width: '7rem', hint: '기간 끝(또는 데이터 기준 시각) 시점의 누적 조회. ≥는 마지막 관측값(실제는 더 큼).' };
  const velocity: MetricColumnSpec = { key: 'velocity', header: '증가 속도', kind: 'perHour', width: '7.5rem', hideBelow: 'md', hint: '최근 약 24시간 동안의 시간당 조회 증가.' };
  const growth: MetricColumnSpec = { key: 'growth_vs_prev', header: '이전 기간 대비', kind: 'growth', width: '7rem', hideBelow: 'lg', hint: '기간 증가량 / 같은 길이 직전 기간 증가량 − 1. 직전 값이 없거나 0이면 계산 안 함.' };
  const engagement: MetricColumnSpec = { key: 'engagement_rate', header: '참여율', kind: 'rate', width: '6rem', hideBelow: 'lg', hint: '(원천이 제공한 좋아요·댓글·공유) / 조회. 제공되지 않은 항목은 빼고 계산.' };
  const outperf: MetricColumnSpec = { key: 'outperformance', header: '평소 대비', kind: 'multiplier', width: '6rem', hideBelow: 'lg', hint: '같은 나이에서 같은 계정 다른 영상(3개 이상) 중앙값 대비 배수.' };
  const pct: MetricColumnSpec = { key: 'percentile', header: '백분위', kind: 'percentile', width: '6.5rem', hideBelow: 'md', hint: '같은 플랫폼 결과 안에서 정렬 값의 위치(0~100). 플랫폼 간 조회 단위 차이를 피하는 비교.' };
  let cols: MetricColumnSpec[];
  if (mode === 'activity') {
    cols = [
      { key: 'views_period', header: '기간 조회 증가', kind: 'count', width: '8rem', hint: '기간 동안 늘어난 조회. ≈ 보간, ≥ 하한, 원천 = 플랫폼 제공 기간값, ⚠ 감소(순위 제외), — 계산 불가.' },
      { ...total, hideBelow: 'sm' },
      velocity,
      growth,
      engagement,
      pct,
    ];
  } else if (mode === 'upload') {
    cols = [total, velocity, engagement, outperf, pct];
  } else {
    cols = [
      { key: 'views_at_age', header: `V${age} 조회`, kind: 'count', width: '7rem', hint: `게시 후 ${age}일 시점의 누적 조회. 그 시점 앞뒤 관측이 있어야 계산됨.` },
      { ...total, hideBelow: 'sm' },
      { ...outperf, hideBelow: 'md' },
      engagement,
      pct,
    ];
  }
  const duplicate = mode === 'age' && sort === 'views_period';
  if (sort !== 'published_at' && sort !== 'percentile' && !duplicate && !cols.some((c) => c.key === sort)) {
    const kind: MetricKind = sort === 'velocity' ? 'perHour' : sort === 'engagement_rate' ? 'rate' : sort === 'growth_vs_prev' ? 'growth' : sort === 'outperformance' ? 'multiplier' : 'count';
    cols.splice(1, 0, { key: sort, header: sortLabel(sort, mode, age), kind, width: '7.5rem', hideBelow: 'sm', hint: '현재 정렬 기준 값.' });
  }
  return cols;
}

export function ResultsTable({ rows, mode, age, sort, dir, onSortChange, onOpen, selectedId, offset, dense, stale, empty, linkParams, caption }: ResultsTableProps) {
  const tz = useTz();
  const tzs = tzShort(tz);
  const specs = metricColumnsFor(mode, age, sort);

  const columns: Column<VideoRow>[] = [
    {
      id: 'rank',
      header: '#',
      width: '3rem',
      align: 'right',
      hideBelow: 'sm',
      cell: (_r, i) => <span className="text-fg-3">{offset + i + 1}</span>,
    },
    {
      id: 'video',
      header: '영상',
      className: 'min-w-[11rem] sm:min-w-[16rem]',
      cell: (r) => {
        const v = r.video;
        const cats = [...v.categories].sort((a, b) => b.confidence - a.confidence).slice(0, dense ? 1 : 2);
        return (
          <div onClick={guardInteractive}>
            <VideoCell
              video={v}
              accountName={r.account?.name}
              thumb={dense ? 'xs' : 'sm'}
              publishedLabel={`${fmtTime(v.publishedAt, tz, 'datetime')} ${tzs}`}
              publishedTitle={`게시 ${fmtTime(v.publishedAt, tz)} (${tz})`}
            >
              {/* Below `sm` the 상세 column is hidden: this button is the row's focusable detail control. */}
              <button
                type="button"
                onClick={() => onOpen(v.id)}
                className="focus-ring mt-1 inline-flex items-center gap-1 rounded-sm text-xs font-medium text-accent-text hover:underline sm:hidden"
              >
                <PanelRightOpen className="size-3.5" aria-hidden />
                상세 보기
              </button>
              {cats.length || v.sponsorship ? (
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  {cats.map((c) => (
                    <CategoryChip key={c.id} id={c.id} size="xs" confidence={c.confidence} to={hrefWith('/videos', { ...linkParams, cats: [c.id] })} />
                  ))}
                  {v.sponsorship ? (
                    <Badge tone={v.sponsorship.level === 'disclosed' ? 'warning' : 'neutral'} className="px-1.5 py-px text-[11px]">
                      {SPONSOR_LEVEL_LABELS[v.sponsorship.level]}
                    </Badge>
                  ) : null}
                </div>
              ) : null}
            </VideoCell>
          </div>
        );
      },
    },
    ...specs.map(
      (c): Column<VideoRow> => ({
        id: c.key,
        header: c.header,
        align: 'right',
        width: c.width,
        hideBelow: c.hideBelow,
        sortKey: c.key,
        hint: c.hint,
        cell: (r) => {
          const m = c.key === 'percentile' ? r.metrics.percentile : sortMetric(c.key, r.metrics, mode);
          return (
            <MetricCell
              metric={m}
              kind={c.kind}
              label={c.header}
              source={metricSource(r.video, m)}
              extra={
                c.key === 'outperformance' && r.metrics.outperformance.ageDays
                  ? `V${r.metrics.outperformance.ageDays} 기준, 비교 영상 ${r.metrics.outperformance.peers}개.`
                  : c.key === 'percentile'
                    ? `${sort === 'percentile' ? primaryMetricLabel(mode, age) : sortLabel(sort, mode, age)} 기준, 같은 플랫폼 결과 안에서의 위치.`
                    : undefined
              }
            />
          );
        },
      }),
    ),
    {
      id: 'open',
      header: <span className="sr-only">상세</span>,
      width: '3rem',
      align: 'center',
      hideBelow: 'sm',
      cell: (r) => (
        <IconButton
          label={`${r.video.title || r.video.id} 상세 보기`}
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            onOpen(r.video.id);
          }}
        >
          <PanelRightOpen className="size-4" aria-hidden />
        </IconButton>
      ),
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(r) => r.video.id}
      caption={caption}
      sort={{ key: sort, dir }}
      onSortChange={(key, d) => onSortChange(key as SortKey, d)}
      onRowClick={(r) => onOpen(r.video.id)}
      selectedKey={selectedId || null}
      dense={dense}
      stale={stale}
      empty={empty}
      minWidth="340px"
    />
  );
}
