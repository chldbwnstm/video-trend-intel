/**
 * One trend list (상승 / 하락 / 상위): rows with the current vs previous window sums, growth, contributing /
 * incomplete video counts, a like-for-like daily sparkline and an expandable panel with the top videos.
 */
import { useId } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { TrendEntityKind, TrendingResult, TrendItem } from '@vti/core';
import { ArrowRight, ChevronDown } from 'lucide-react';
import {
  Badge,
  EmptyState,
  ErrorState,
  GrowthChart,
  LoadingState,
  MetricCell,
  NumberDelta,
  PlatformBadge,
  SparkLine,
  Tooltip,
  VideoThumb,
} from '../../components/index.ts';
import { useAnalysis, useDataset } from '../../data/hooks.ts';
import { cx } from '../../lib/cx.ts';
import { fmtTime } from '../../lib/display.ts';
import { formatCompact, formatInteger } from '../../lib/format.ts';
import { tzShort } from '../../lib/timezones.ts';
import { isNewItem, itemHref, smallBase, spanLabel, topVideoRows, trendSum, videoHref } from './logic.ts';
import type { EntityDaily, EntityDailyResult, TrendLinkParams, TrendListId } from './logic.ts';

export interface TrendListProps {
  list: TrendListId;
  items: TrendItem[];
  result: TrendingResult;
  kind: TrendEntityKind;
  daily: EntityDailyResult | undefined;
  openKey: string | null;
  onToggle: (key: string) => void;
  linkParams: TrendLinkParams;
  empty: ReactNode;
  stale?: boolean;
}

export function TrendList({ list, items, result, kind, daily, openKey, onToggle, linkParams, empty, stale }: TrendListProps) {
  if (!items.length) return <div className="px-4 pb-4 sm:px-5">{empty}</div>;
  return (
    <ol className={cx('flex flex-col divide-y divide-line transition-opacity', stale && 'opacity-60')} aria-label={`${LIST_LABEL[list]} 목록`}>
      {items.map((it, i) => (
        <TrendRow
          key={it.key}
          rank={i + 1}
          item={it}
          list={list}
          result={result}
          kind={kind}
          daily={daily?.byKey[it.key]}
          dailySkipped={daily?.skipped ?? null}
          open={openKey === `${list}:${it.key}`}
          onToggle={() => onToggle(`${list}:${it.key}`)}
          linkParams={linkParams}
        />
      ))}
    </ol>
  );
}

const LIST_LABEL: Record<TrendListId, string> = { rising: '상승', falling: '하락', top: '상위' };

function itemLabel(kind: TrendEntityKind, it: TrendItem): string {
  return kind === 'topic' ? `#${it.label}` : it.label;
}

interface RowProps {
  rank: number;
  item: TrendItem;
  list: TrendListId;
  result: TrendingResult;
  kind: TrendEntityKind;
  daily: EntityDaily | undefined;
  dailySkipped: EntityDailyResult['skipped'];
  open: boolean;
  onToggle: () => void;
  linkParams: TrendLinkParams;
}

function TrendRow({ rank, item, list, result, kind, daily, dailySkipped, open, onToggle, linkParams }: RowProps) {
  const { now } = useDataset();
  const panelId = useId();
  const asOf = Math.min(result.window.endMs, now);
  const fresh = isNewItem(item);
  return (
    <li className="px-4 py-2.5 sm:px-5">
      <div className="grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 sm:grid-cols-[1.5rem_minmax(0,1fr)_6.5rem_auto]">
        <span className="pt-0.5 text-right text-xs text-fg-3 tabular">{rank}</span>
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <Link
              to={itemHref(kind, item.key, linkParams)}
              className="focus-ring min-w-0 truncate rounded-sm text-sm font-medium text-fg hover:text-accent-text hover:underline"
              title={item.label}
            >
              {itemLabel(kind, item)}
            </Link>
            {item.platform ? (
              <PlatformBadge platform={item.platform} size="xs" />
            ) : (
              <Tooltip content="여러 플랫폼 영상의 합계. 플랫폼마다 조회수 단위가 달라 참고용임.">
                <Badge tone="warning" className="text-[11px]">
                  여러 플랫폼
                </Badge>
              </Tooltip>
            )}
          </div>
          <p className="mt-0.5 flex flex-wrap gap-x-1.5 text-xs text-fg-3">
            <span>영상 {formatInteger(item.videoCount)}개</span>
            {item.incompleteCount > 0 ? (
              <Tooltip content="경계 관측이 부족해 합계에서 뺀 영상 수(하한·계산 불가). 실제 증가량은 더 클 수 있음.">
                <span className="text-warning">· 불완전 {formatInteger(item.incompleteCount)}</span>
              </Tooltip>
            ) : null}
            <span className="inline-flex items-center gap-1">
              · 직전
              <MetricCell
                metric={trendSum(item.previous, item, result.previousWindow.endMs)}
                label="직전 동일 기간 조회 증가 합계"
                extra={`직전 동일 기간 ${spanLabel(result.previousWindow.startMs, result.previousWindow.endMs, result.window.tz)}. 이번 기간과 같은 영상 집합만 합산.`}
                className="text-xs"
                align="left"
              />
            </span>
          </p>
        </div>
        <div className="hidden self-center sm:block">
          <RowSpark daily={daily} skipped={dailySkipped} label={`${itemLabel(kind, item)} 일별 조회 증가`} />
        </div>
        <div className="flex flex-col items-end gap-0.5">
          <MetricCell
            metric={trendSum(item.current, item, asOf)}
            label="이번 기간 조회 증가 합계"
            extra={`정확·보간·원천 값만 합산${item.incompleteCount ? `, 경계 관측이 부족한 영상 ${item.incompleteCount}개 제외` : ''}.`}
          />
          <span className="flex items-center gap-1">
            {fresh ? (
              <Tooltip content="직전 동일 기간 증가 합계가 0이라 증가율을 정의할 수 없음(새로 뜬 항목이거나 직전 기간 관측이 없음).">
                <Badge tone="info" className="text-[11px]">
                  신규
                </Badge>
              </Tooltip>
            ) : (
              <>
                {smallBase(item) ? (
                  <Tooltip
                    content={`직전 동일 기간 합계가 ${formatInteger(item.previous)}회로 매우 작아 증가율이 크게 과장될 수 있음${item.incompleteCount ? '. 경계 관측이 부족한 영상이 빠져 있어 두 합계 모두 실제보다 작을 수 있음' : ''}.`}
                  >
                    <Badge tone="warning" className="text-[11px]">
                      기준 작음
                    </Badge>
                  </Tooltip>
                ) : null}
                <NumberDelta value={item.growth} label="직전 동일 기간 대비" />
              </>
            )}
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={open}
              aria-controls={panelId}
              aria-label={`${itemLabel(kind, item)} 상위 영상 ${open ? '접기' : '펼치기'}`}
              className="focus-ring inline-flex size-6 items-center justify-center rounded-md text-fg-3 hover:bg-surface-3 hover:text-fg"
            >
              <ChevronDown className={cx('size-4 transition-transform', open && 'rotate-180')} aria-hidden />
            </button>
          </span>
        </div>
      </div>
      {open ? (
        <div id={panelId} className="mt-2 ml-0 rounded-lg border border-line bg-surface-2 p-3 sm:ml-9">
          <ItemDetail item={item} list={list} result={result} kind={kind} daily={daily} dailySkipped={dailySkipped} linkParams={linkParams} />
        </div>
      ) : (
        <div id={panelId} hidden />
      )}
    </li>
  );
}

function RowSpark({ daily, skipped, label }: { daily: EntityDaily | undefined; skipped: EntityDailyResult['skipped']; label: string }) {
  if (skipped === 'too_long' || skipped === 'too_short' || skipped === 'not_started') return null;
  if (!daily) return <span className="block h-7" aria-hidden />;
  if (!daily.values) {
    return (
      <Tooltip content="모든 날짜의 조회 증가를 계산할 수 있는 영상이 아직 없음(관측이 쌓이면 표시).">
        <span className="block text-right text-[11px] text-fg-3">일별 관측 부족</span>
      </Tooltip>
    );
  }
  const interpolated = daily.statuses.includes('interpolated');
  const source = daily.statuses.includes('source_reported');
  const note = `모든 날짜 값이 있는 영상 ${daily.fullMembers}개 합계${interpolated ? ', 보간값 포함' : ''}${source ? ', 원천 제공값 포함' : ''}`;
  return (
    <span className="flex items-center gap-1">
      {interpolated || source ? (
        <Tooltip content={`${note}. 보간값은 앞뒤 관측(게시 시점 0회 포함) 사이를 시간 비례로 채운 값이라 실제 일별 흐름과 다를 수 있음.`}>
          <span className="text-[11px] text-info">{interpolated ? '≈' : '원천'}</span>
        </Tooltip>
      ) : null}
      <SparkLine data={daily.values} labels={daily.dates} label={`${label} (${note})`} height={28} className="min-w-0 flex-1" />
    </span>
  );
}

function ItemDetail({
  item,
  result,
  kind,
  daily,
  dailySkipped,
  linkParams,
}: {
  item: TrendItem;
  list: TrendListId;
  result: TrendingResult;
  kind: TrendEntityKind;
  daily: EntityDaily | undefined;
  dailySkipped: EntityDailyResult['skipped'];
  linkParams: TrendLinkParams;
}) {
  const { now, tz } = useDataset();
  const w = result.window;
  const pw = result.previousWindow;
  const input = {
    ids: item.topVideoIds,
    startMs: w.startMs,
    endMs: w.endMs,
    prevStartMs: pw.startMs,
    prevEndMs: pw.endMs,
    tz: w.tz,
    now,
  };
  const top = useAnalysis('trends.topVideoRows', input, (index, i) => topVideoRows(index, i));
  const toCreator = kind === 'creator' || kind === 'account';
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <dt className="text-fg-3">이번 기간</dt>
          <dd className="text-fg-2 tabular">{spanLabel(w.startMs, Math.min(w.endMs, now), tz)}</dd>
        </div>
        <div>
          <dt className="text-fg-3">직전 동일 기간</dt>
          <dd className="text-fg-2 tabular">{spanLabel(pw.startMs, pw.endMs, tz)}</dd>
        </div>
      </dl>

      <DailyChart daily={daily} skipped={dailySkipped} title={`${itemLabel(kind, item)} 일별 조회 증가`} />

      <div>
        <p className="mb-1 text-xs font-medium text-fg-2">이번 기간 조회 증가 상위 영상</p>
        {top.error ? (
          <ErrorState compact title="상위 영상을 불러오지 못함" error={top.error} />
        ) : !top.data ? (
          <LoadingState rows={2} />
        ) : top.data.length === 0 ? (
          <p className="text-xs text-fg-3">합산된 영상 없음</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {top.data.map((r) => (
              <li key={r.video.id} className="flex min-w-0 items-center gap-2">
                <VideoThumb video={r.video} size="xs" className="hidden sm:block" />
                <div className="min-w-0 flex-1">
                  <Link
                    to={videoHref(r.video.id, linkParams.range)}
                    className="focus-ring line-clamp-1 rounded-sm text-[13px] font-medium text-fg hover:text-accent-text hover:underline"
                    title={r.video.title}
                  >
                    {r.video.title || '(제목 없음)'}
                  </Link>
                  <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-[11px] text-fg-3">
                    <PlatformBadge platform={r.video.platform} size="xs" />
                    <span className="max-w-[10rem] truncate">{r.account?.name ?? r.video.accountId}</span>
                    <span aria-hidden>·</span>
                    <span className="tabular" title={`${fmtTime(r.video.publishedAt, tz)} ${tzShort(tz)}`}>
                      게시 {fmtTime(r.video.publishedAt, tz, 'date')}
                    </span>
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end">
                  <MetricCell metric={r.current} label="이번 기간 조회 증가" />
                  <span className="inline-flex items-center gap-1 text-[11px] text-fg-3">
                    직전 <MetricCell metric={r.previous} label="직전 동일 기간 조회 증가" className="text-[11px]" />
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Link
        to={itemHref(kind, item.key, linkParams)}
        className="focus-ring inline-flex w-fit items-center gap-1 rounded-sm text-[13px] font-medium text-accent-text hover:underline"
      >
        {toCreator ? '크리에이터 상세 보기' : '영상 탐색에서 모두 보기'} <ArrowRight className="size-3.5" aria-hidden />
      </Link>
    </div>
  );
}

function DailyChart({ daily, skipped, title }: { daily: EntityDaily | undefined; skipped: EntityDailyResult['skipped']; title: string }) {
  if (skipped === 'too_long') return <p className="text-xs text-fg-3">기간이 45일을 넘어 일별 추이는 생략함.</p>;
  if (skipped === 'too_short') return <p className="text-xs text-fg-3">기간이 짧아(3일 미만) 일별 추이는 생략함.</p>;
  if (skipped === 'not_started' || !daily) return null;
  if (!daily.values) {
    return (
      <p className="text-xs text-fg-3">
        일별 추이: 모든 날짜의 조회 증가를 계산할 수 있는 영상이 아직 없음(해당 항목 영상 {formatInteger(daily.totalMembers)}개). 수집 기록이 쌓이면 표시됨.
      </p>
    );
  }
  const values = daily.values;
  return (
    <div>
      <GrowthChart
        title={title}
        variant="bar"
        height={140}
        series={[
          {
            id: 'daily',
            label: '일별 조회 증가',
            points: daily.dates.map((d, i) => ({ x: d, value: values[i], status: daily.statuses[i] })),
          },
        ]}
      />
      <p className="mt-1 text-[11px] text-fg-3">
        모든 날짜의 증가량을 계산할 수 있는 영상 {formatInteger(daily.fullMembers)}개 / {formatInteger(daily.totalMembers)}개의 합계(같은 영상 집합, 현지 날짜 기준). 첫날은 기간 시작 전 시간도 포함할 수 있음.
        {daily.statuses.includes('interpolated') ? ' ≈ 표시 날짜는 앞뒤 관측(게시 시점 0회 포함) 사이를 보간한 값이 섞여 있음.' : ''}
        {daily.fullMembers < daily.totalMembers ? ` 나머지 ${formatInteger(daily.totalMembers - daily.fullMembers)}개는 일부 날짜 관측이 부족해 제외.` : ''}
      </p>
      <p className="sr-only">최대 일별 증가 {formatCompact(Math.max(...values))}</p>
    </div>
  );
}
