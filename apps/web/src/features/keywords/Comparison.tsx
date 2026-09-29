/**
 * Google-Trends-like comparison of the selected keywords: a table (matched videos, uploads in the window,
 * period views with provenance), per-platform share of voice (uploads + measurable views) and the daily
 * upload volume chart. Colors follow the keyword (chip color = row dot = chart series).
 */
import { Link } from 'react-router-dom';
import type { KeywordAnalysis, KeywordReport } from '@vti/core';
import { ArrowRight, TriangleAlert } from 'lucide-react';
import { Badge, DataTable, GrowthChart, InfoTip, MetricCell, PlatformBadge } from '../../components/index.ts';
import type { Column } from '../../components/index.ts';
import { cx } from '../../lib/cx.ts';
import { formatInteger } from '../../lib/format.ts';
import { CROSS_PLATFORM_ADVICE, CROSS_PLATFORM_CAVEAT, platformLabel } from '../../lib/platform.ts';
import { dailySeries, keywordColor, partialShare, shareText, statusParts, videosSearchHref } from './model.ts';
import type { ScopeParams } from './model.ts';

export function KeywordDot({ index, className }: { index: number; className?: string }) {
  return <span aria-hidden className={cx('inline-block size-2.5 shrink-0 rounded-full', className)} style={{ background: keywordColor(index) }} />;
}

/* ------------------------------------------------------------------------------------------ table */

interface Row {
  r: KeywordReport;
  i: number;
}

export function ComparisonTable({ analysis, scope, stale }: { analysis: KeywordAnalysis; scope: ScopeParams; stale?: boolean }) {
  const rows: Row[] = analysis.keywords.map((r, i) => ({ r, i }));
  const columns: Column<Row>[] = [
    {
      id: 'keyword',
      header: '키워드',
      cell: ({ r, i }) => (
        <div className="flex min-w-0 items-center gap-2">
          <KeywordDot index={i} />
          <span className="min-w-0 font-medium break-keep [overflow-wrap:break-word] text-fg">{r.keyword}</span>
        </div>
      ),
    },
    {
      id: 'videos',
      header: '일치 영상',
      align: 'right',
      hint: '필터 범위 안에서 기간 끝까지 게시된 추적 영상 중 키워드와 일치한 수. 플랫폼 전체 영상 수가 아님.',
      cell: ({ r }) => (
        <span className="tabular">
          {formatInteger(r.videos)}
          <span className="block text-[11px] whitespace-nowrap text-fg-3">
            <span className="hidden sm:inline">계정 {formatInteger(r.accounts)}</span>
            {/* phones: the uploads column is hidden, its value moves here */}
            <span className="sm:hidden">기간 업로드 {formatInteger(r.uploadsInWindow)}</span>
          </span>
        </span>
      ),
    },
    {
      id: 'uploads',
      header: '기간 업로드',
      align: 'right',
      hint: '선택 기간 안에 게시된 일치 영상 수 (추적 범위 기준).',
      hideBelow: 'sm',
      cell: ({ r }) => <span className="tabular">{formatInteger(r.uploadsInWindow)}</span>,
    },
    {
      id: 'views',
      header: '기간 조회 증가',
      align: 'right',
      hint: '조회 발생 기간 기준 합계. 계산 불가 영상은 0으로 세지 않고 빼며 그때 합계는 하한(≥). 여러 플랫폼이 섞이면 단위가 달라 ⚠ 표시.',
      cell: ({ r }) => (
        <div className="flex flex-col items-end gap-0.5">
          <span className="inline-flex items-center gap-1">
            {r.viewsPeriod.crossPlatform ? (
              <TriangleAlert className="size-3.5 text-warning" aria-label="여러 플랫폼 합산" />
            ) : null}
            <MetricCell
              metric={r.viewsPeriod}
              label={`'${r.keyword}' 기간 조회 증가 합계`}
              extra={`영상 ${formatInteger(r.viewsPeriod.videos)}개 중 계산 불가 ${formatInteger(r.viewsPeriod.unknown)}개(0으로 세지 않음)${r.viewsPeriod.crossPlatform ? ' · 여러 플랫폼 합산: 단위가 다름' : ''}`}
            />
          </span>
          {statusParts(r.statusCounts).length ? (
            <span className="flex flex-wrap justify-end gap-x-1.5 text-[11px] text-fg-3">
              {statusParts(r.statusCounts).map((p) => (
                <span key={p} className="whitespace-nowrap">
                  {p}
                </span>
              ))}
            </span>
          ) : null}
        </div>
      ),
    },
    {
      id: 'platforms',
      header: '플랫폼',
      hideBelow: 'md',
      cell: ({ r }) => (
        <div className="flex flex-wrap gap-1">
          {r.platforms.map((p) => (
            <PlatformBadge key={p.platform} platform={p.platform} size="xs" />
          ))}
          {!r.platforms.length ? <span className="text-xs text-fg-3">—</span> : null}
        </div>
      ),
    },
    {
      id: 'link',
      header: <span className="sr-only">영상 탐색</span>,
      align: 'right',
      hideBelow: 'sm',
      cell: ({ r }) => (
        <Link
          to={videosSearchHref(r.keyword, scope)}
          className="focus-ring inline-flex items-center gap-1 rounded-sm text-[13px] whitespace-nowrap text-accent-text hover:underline"
          aria-label={`'${r.keyword}' 영상 탐색에서 보기`}
        >
          영상 탐색 <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      ),
    },
  ];
  return <DataTable columns={columns} rows={rows} rowKey={({ r }) => r.keyword} caption="키워드 비교: 일치 영상, 기간 업로드, 기간 조회 증가" minWidth="320px" stale={stale} />;
}

/* ------------------------------------------------------------------------------------------ share of voice */

export function ShareOfVoice({ analysis }: { analysis: KeywordAnalysis }) {
  const blocks = analysis.shareOfVoice;
  if (!blocks.length) return <p className="text-sm text-fg-3">일치 영상이 있는 플랫폼이 없음.</p>;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {blocks.map((b) => {
        const known = b.items.every((it) => it.viewShare.status !== 'unavailable');
        return (
          <section key={b.platform} className="min-w-0 rounded-lg border border-line p-3" aria-label={`${platformLabel(b.platform)} 점유율`}>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <PlatformBadge platform={b.platform} />
              <span className="text-xs text-fg-3">기간 업로드 합계 {formatInteger(b.totalUploads)}개</span>
            </div>
            {b.totalUploads > 0 ? (
              <div className="mb-2 flex h-2.5 w-full overflow-hidden rounded-full bg-surface-3" aria-hidden>
                {b.items.map((it, i) =>
                  it.uploadShare ? <div key={it.keyword} style={{ width: `${it.uploadShare * 100}%`, background: keywordColor(i) }} /> : null,
                )}
              </div>
            ) : null}
            <table className="w-full text-[13px]">
              <caption className="sr-only">{platformLabel(b.platform)} 키워드 점유율</caption>
              <thead>
                <tr className="text-xs text-fg-3">
                  <th scope="col" className="py-1 text-left font-medium">키워드</th>
                  <th scope="col" className="py-1 text-right font-medium">업로드 점유</th>
                  <th scope="col" className="py-1 text-right font-medium">
                    조회 점유
                    <InfoTip label="조회 점유 설명">기간 조회 증가를 계산할 수 있는(정확·보간·원천) 영상만으로 계산. 하한·계산 불가 영상은 빼고, 일부만 반영했으면 ‘영상 n/m개 기준’으로 표시.</InfoTip>
                  </th>
                </tr>
              </thead>
              <tbody>
                {b.items.map((it, i) => (
                  <tr key={it.keyword} className="border-t border-line">
                    <th scope="row" className="py-1 text-left font-normal">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <KeywordDot index={i} />
                        <span className="truncate">{it.keyword}</span>
                      </span>
                    </th>
                    <td className="py-1 text-right tabular">
                      {shareText(it.uploadShare)}
                      <span className="ml-1 text-[11px] text-fg-3">({formatInteger(it.uploads)})</span>
                    </td>
                    <td className="py-1 text-right">
                      <MetricCell
                        metric={it.viewShare}
                        kind="rate"
                        label={`'${it.keyword}' 조회 점유`}
                        extra={`계산 가능 영상 ${formatInteger(it.measuredVideos)}개만 반영 · 제외(하한·계산 불가) ${formatInteger(it.excludedVideos)}개`}
                      />
                      {partialShare(it) ? (
                        <span className="block text-[11px] whitespace-nowrap text-fg-3 tabular">
                          영상 {formatInteger(it.measuredVideos)}/{formatInteger(it.videos)}개 기준
                        </span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {b.items.some(partialShare) ? (
              <p className="mt-1 text-[11px] text-fg-3">
                ‘영상 n/m개 기준’ = 일치 영상 m개 중 기간 조회 증가를 계산할 수 있는 n개만으로 낸 조회 점유. 하한(≥)·계산 불가 영상은 빠져 있어 실제 점유와 다를 수 있음.
              </p>
            ) : null}
            {!known ? <p className="mt-1 text-[11px] text-fg-3">— = 이 플랫폼에서 조회 증가를 계산할 수 있는 영상이 없어 비교 불가 (0이 아님)</p> : null}
          </section>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ daily chart */

export function DailyUploadsChart({ analysis }: { analysis: KeywordAnalysis }) {
  const partial = analysis.days.some((d) => d.partial);
  if (analysis.keywords.every((r) => r.uploadsInWindow === 0)) {
    return <p className="py-6 text-center text-sm text-fg-3">이 기간에 게시된 일치 영상 없음 (기간 조회 증가는 그 전에 게시된 영상 기준).</p>;
  }
  return (
    <>
      <GrowthChart
        series={dailySeries(analysis)}
        variant="bar"
        title="키워드별 일별 업로드 수"
        height={220}
        empty="이 기간에 게시된 일치 영상 없음"
      />
      {partial ? (
        <p className="mt-1 text-[11px] text-fg-3">
          <Badge tone="neutral" className="mr-1">≥</Badge>첫날·마지막 날은 기간에 일부 시간만 포함돼 그날 전체 업로드보다 적을 수 있음.
        </p>
      ) : null}
    </>
  );
}

/** The cross-platform caveat line shown above comparisons that mix platforms. */
export function CrossPlatformCaveat({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <p className="flex items-start gap-1.5 text-xs text-fg-3">
      <TriangleAlert className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
      <span>
        여러 플랫폼 영상을 합산한 값이 있음(⚠). {CROSS_PLATFORM_CAVEAT} {CROSS_PLATFORM_ADVICE.filter} 점유율은 플랫폼별로 따로 계산함.
      </span>
    </p>
  );
}
