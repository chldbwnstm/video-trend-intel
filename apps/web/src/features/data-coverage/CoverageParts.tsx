/**
 * Presentational parts of the 데이터 범위 page.
 */
import { useState } from 'react';
import type { ReactNode } from 'react';
import type { CollectionRun, MetricKey, MetricStatus } from '@vti/core';
import { ExternalLink, KeyRound, TriangleAlert } from 'lucide-react';
import {
  Badge,
  Checkbox,
  DataTable,
  EmptyState,
  MetricCell,
  Pager,
  PlatformBadge,
  safeHttpUrl,
  StatRow,
  Tooltip,
} from '../../components/index.ts';
import type { Column, Tone } from '../../components/index.ts';
import { fmtTime } from '../../lib/display.ts';
import { formatInteger, formatPercent, formatRelative } from '../../lib/format.ts';
import { STATUS_META } from '../../lib/metricStatus.ts';
import { platformLabel } from '../../lib/platform.ts';
import { RANGE_PRESET_LABELS } from '../../lib/urlState.ts';
import { tzShort } from '../../lib/timezones.ts';
import { cx } from '../../lib/cx.ts';
import { useTz } from '../../data/hooks.ts';
import type { FreshnessState } from '../../lib/dashboard.ts';
import {
  CREDENTIALS,
  DEPTH_BUCKET_LABELS,
  formatDurationKo,
  formatHoursKo,
  rankableShare,
  runDurationSec,
  STATUS_ORDER_FOR_BARS,
} from './coverageModel.ts';
import type { ComputabilityRow, DepthRow, SourceRow, StatusMix } from './coverageModel.ts';

export const METRIC_LABELS: Record<MetricKey, string> = { views: '조회', likes: '좋아요', comments: '댓글', shares: '공유' };

export const FRESHNESS_BADGE: Record<FreshnessState, { label: string; tone: Tone; hint: string }> = {
  ok: { label: '정상', tone: 'positive', hint: '마지막 성공 수집이 데이터 기준 시각 12시간 이내.' },
  partial: { label: '일부 실패', tone: 'warning', hint: '마지막 실행에서 일부 요청이 실패함.' },
  late: { label: '지연', tone: 'warning', hint: '마지막 성공 수집이 12~48시간 전.' },
  stale: { label: '오래됨', tone: 'negative', hint: '마지막 성공 수집이 48시간보다 오래됨.' },
  error: { label: '오류', tone: 'negative', hint: '마지막 실행이 실패함.' },
  disabled: { label: '비활성', tone: 'neutral', hint: '꺼져 있는 원천. 인증 정보가 필요하면 아래 "원천 추가하기" 참고.' },
  never: { label: '미실행', tone: 'neutral', hint: '아직 한 번도 실행되지 않음.' },
};

const STATUS_COLOR: Record<MetricStatus, string> = {
  exact: 'var(--positive)',
  interpolated: 'var(--info)',
  source_reported: 'var(--accent)',
  lower_bound: 'var(--warning)',
  unavailable: 'var(--line-strong)',
  decrease_flagged: 'var(--negative)',
};

/* ------------------------------------------------------------------------------------------ status mix */

/** Marker prefix in legends ('원천' is already part of its label). */
const LEGEND_MARKER: Record<MetricStatus, string> = {
  exact: '',
  interpolated: '≈ ',
  source_reported: '',
  lower_bound: '≥ ',
  unavailable: '— ',
  decrease_flagged: '⚠ ',
};

export function StatusMixBar({ mix, label, compact }: { mix: StatusMix; label: string; compact?: boolean }) {
  if (!mix.total) return <p className="text-xs text-fg-3">영상 없음</p>;
  const parts = STATUS_ORDER_FOR_BARS.filter((s) => mix.counts[s] > 0);
  const summary = parts.map((s) => `${STATUS_META[s].label} ${formatInteger(mix.counts[s])}개`).join(', ');
  return (
    <div className="flex flex-col gap-1.5">
      <div role="img" aria-label={`${label}: ${summary}`} className={cx('flex w-full overflow-hidden rounded-full bg-surface-3', compact ? 'h-2' : 'h-3')}>
        {parts.map((s) => (
          <span key={s} style={{ width: `${(mix.counts[s] / mix.total) * 100}%`, background: STATUS_COLOR[s] }} />
        ))}
      </div>
      {!compact ? (
        <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-fg-3">
          {parts.map((s) => (
            <li key={s} className="inline-flex items-center gap-1">
              <span aria-hidden className="inline-block size-2 rounded-full" style={{ background: STATUS_COLOR[s] }} />
              <span className="text-fg-2">
                {LEGEND_MARKER[s]}
                {STATUS_META[s].label}
              </span>
              <span className="tabular">
                {formatInteger(mix.counts[s])} ({formatPercent(mix.counts[s] / mix.total, 0)})
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function ComputabilityView({ rows }: { rows: ComputabilityRow[] }) {
  return (
    <div className="flex flex-col gap-5">
      {rows.map((r) => {
        const share = rankableShare(r.all);
        return (
          <section key={r.preset} aria-label={RANGE_PRESET_LABELS[r.preset]} className="flex flex-col gap-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-[13px] font-semibold text-fg">{RANGE_PRESET_LABELS[r.preset]}</h3>
              <span className="text-xs text-fg-3">
                순위에 쓸 수 있는 값 {formatPercent(share, 0)} · 영상 {formatInteger(r.all.total)}개
              </span>
            </div>
            <StatusMixBar mix={r.all} label={`${RANGE_PRESET_LABELS[r.preset]} 기간 조회 증가 상태`} />
            <details className="text-xs">
              <summary className="focus-ring w-fit cursor-pointer rounded-sm text-accent-text hover:underline">플랫폼별 보기</summary>
              <ul className="mt-2 flex flex-col gap-2">
                {r.byPlatform.map((p) => (
                  <li key={p.platform} className="grid grid-cols-[7.5rem_minmax(0,1fr)_auto] items-center gap-2">
                    <PlatformBadge platform={p.platform} size="xs" />
                    <StatusMixBar mix={p} label={`${platformLabel(p.platform)} ${RANGE_PRESET_LABELS[r.preset]}`} compact />
                    <Tooltip
                      content={
                        <ul>
                          {STATUS_ORDER_FOR_BARS.filter((s) => p.counts[s] > 0).map((s) => (
                            <li key={s}>
                              {STATUS_META[s].label}: {formatInteger(p.counts[s])}개
                            </li>
                          ))}
                        </ul>
                      }
                    >
                      <span className="text-fg-3 tabular">{formatPercent(rankableShare(p), 0)}</span>
                    </Tooltip>
                  </li>
                ))}
              </ul>
            </details>
          </section>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ depth */

export function DepthTable({ rows }: { rows: DepthRow[] }) {
  const tz = useTz();
  const columns: Column<DepthRow>[] = [
    { id: 'platform', header: '플랫폼', cell: (r) => <PlatformBadge platform={r.platform} size="xs" /> },
    { id: 'videos', header: '영상', align: 'right', cell: (r) => formatInteger(r.videos) },
    ...DEPTH_BUCKET_LABELS.map(
      (label, i): Column<DepthRow> => ({
        id: `b${i}`,
        header: `관측 ${label}`,
        align: 'right',
        hideBelow: i === 0 ? undefined : 'sm',
        cell: (r) => (
          <span className={cx(r.buckets[i] === 0 && 'text-fg-3')}>
            {formatInteger(r.buckets[i])}
            <span className="ml-1 text-xs text-fg-3">{formatPercent(r.videos ? r.buckets[i] / r.videos : null, 0)}</span>
          </span>
        ),
      }),
    ),
    {
      id: 'span',
      header: '관측 기간(중앙값)',
      align: 'right',
      hideBelow: 'md',
      hint: '영상별 첫 관측과 마지막 관측 사이 시간의 중앙값. 0이면 아직 한 번만 관측됨.',
      cell: (r) => formatHoursKo(r.medianSpanHours),
    },
    {
      id: 'sw',
      header: '원천 기간값',
      align: 'right',
      hideBelow: 'md',
      hint: '플랫폼이 직접 집계한 최근 24시간/7일/30일 조회값(원천 제공값)을 가진 영상 수.',
      cell: (r) => formatInteger(r.withSourceWindows),
    },
    {
      id: 'first',
      header: '첫 관측',
      align: 'right',
      hideBelow: 'lg',
      cell: (r) => <span className="text-xs text-fg-3 tabular">{fmtTime(r.firstObservedAt, tz)}</span>,
    },
  ];
  return <DataTable columns={columns} rows={rows} rowKey={(r) => r.platform} caption="플랫폼별 영상당 관측 횟수" minWidth="340px" dense />;
}

/* ------------------------------------------------------------------------------------------ sources */

export function SourceTable({ rows, now }: { rows: SourceRow[]; now: number }) {
  const tz = useTz();
  const columns: Column<SourceRow>[] = [
    {
      id: 'source',
      header: '원천',
      cell: (r) => (
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5">
            <PlatformBadge platform={r.platform} size="xs" iconOnly />
            <span className="truncate font-medium text-fg">{r.label}</span>
          </span>
          <code className="text-[11px] text-fg-3">{r.source}</code>
        </div>
      ),
    },
    {
      id: 'status',
      header: '상태',
      width: '6rem',
      cell: (r) => {
        const b = FRESHNESS_BADGE[r.state];
        return (
          <Tooltip content={b.hint}>
            <Badge tone={b.tone}>{b.label}</Badge>
          </Tooltip>
        );
      },
    },
    {
      id: 'auth',
      header: '인증',
      hideBelow: 'md',
      cell: (r) =>
        r.requiresCredentials ? (
          <span className="flex flex-wrap gap-1">
            {r.env.map((e) => (
              <code key={e} className="rounded bg-surface-2 px-1 text-[11px] text-fg-2">
                {e}
              </code>
            ))}
          </span>
        ) : (
          <span className="text-xs text-fg-3">필요 없음</span>
        ),
    },
    {
      id: 'metrics',
      header: '지표',
      hideBelow: 'lg',
      cell: (r) => <span className="text-xs text-fg-2">{(r.coverage.metrics ?? []).map((m) => METRIC_LABELS[m] ?? m).join('·') || '—'}</span>,
    },
    { id: 'videos', header: '영상', align: 'right', width: '5.5rem', cell: (r) => formatInteger(r.videoCount) },
    {
      id: 'accounts',
      header: '계정',
      align: 'right',
      width: '5rem',
      hideBelow: 'sm',
      cell: (r) => formatInteger(r.coverage.accountCount),
    },
    {
      id: 'success',
      header: '마지막 성공',
      align: 'right',
      width: '8.5rem',
      hideBelow: 'sm',
      cell: (r) =>
        r.lastSuccessAt !== null ? (
          <Tooltip content={`${fmtTime(r.lastSuccessAt, tz)} ${tzShort(tz)}`}>
            <span className="text-xs text-fg-2 tabular">{formatRelative(r.lastSuccessAt, now)}</span>
          </Tooltip>
        ) : (
          <span className="text-xs text-fg-3">없음</span>
        ),
    },
  ];
  return <DataTable columns={columns} rows={rows} rowKey={(r) => r.source} caption="원천별 수집 현황" minWidth="340px" />;
}

export function SourceCard({ row, now }: { row: SourceRow; now: number }) {
  const tz = useTz();
  const c = row.coverage;
  const b = FRESHNESS_BADGE[row.state];
  const docs = safeHttpUrl(c.docsUrl);
  return (
    <article className={cx('flex min-w-0 flex-col gap-3 rounded-xl border border-line bg-surface p-4 shadow-card', !c.enabled && 'bg-surface-2')}>
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-fg">
            <PlatformBadge platform={c.platform} size="xs" iconOnly />
            <span className="truncate">{c.label}</span>
          </h3>
          <code className="text-[11px] text-fg-3">{c.source}</code>
        </div>
        <Badge tone={b.tone} title={b.hint}>
          {b.label}
        </Badge>
      </header>
      <p className="text-[13px] text-fg-2">{c.discovery}</p>
      <dl>
        <StatRow label="인증">
          {c.requiresCredentials ? (
            <span className="inline-flex flex-wrap justify-end gap-1">
              <KeyRound className="size-3.5 text-fg-3" aria-hidden />
              {row.env.length ? (
                row.env.map((e) => (
                  <code key={e} className="rounded bg-surface-2 px-1 text-[11px]">
                    {e}
                  </code>
                ))
              ) : (
                <span className="text-xs">필요 (변수 이름 미상)</span>
              )}
            </span>
          ) : (
            '필요 없음 (공개 API·피드)'
          )}
        </StatRow>
        <StatRow label="제공 지표">
          <span className="inline-flex flex-wrap justify-end gap-1">
            {(['views', 'likes', 'comments', 'shares'] as MetricKey[]).map((m) =>
              (c.metrics ?? []).includes(m) ? (
                <Badge key={m} tone="positive">
                  {METRIC_LABELS[m]}
                </Badge>
              ) : (
                <Tooltip key={m} content="원천이 제공하지 않음. 0이 아니라 빈 값(—)으로 표시함.">
                  <Badge tone="neutral" className="line-through opacity-70">
                    {METRIC_LABELS[m]}
                  </Badge>
                </Tooltip>
              ),
            )}
          </span>
        </StatRow>
        <StatRow label="영상 · 계정">
          {formatInteger(c.videoCount)} · {formatInteger(c.accountCount)}
        </StatRow>
        <StatRow label="첫 실행">{c.firstRunAt !== null ? `${fmtTime(c.firstRunAt, tz)} ${tzShort(tz)}` : '없음'}</StatRow>
        <StatRow label="마지막 실행">{c.lastRunAt !== null ? `${fmtTime(c.lastRunAt, tz)} ${tzShort(tz)}` : '없음'}</StatRow>
        <StatRow label="마지막 성공">
          {c.lastSuccessAt !== null ? (
            <>
              {fmtTime(c.lastSuccessAt, tz)} {tzShort(tz)} <span className="text-xs text-fg-3">({formatRelative(c.lastSuccessAt, now)}, 데이터 기준)</span>
            </>
          ) : (
            '없음'
          )}
        </StatRow>
      </dl>
      {c.lastError ? (
        <p role="note" className="flex items-start gap-1.5 rounded-md bg-negative-soft px-2 py-1.5 text-xs text-negative">
          <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 break-words">마지막 오류: {c.lastError}</span>
        </p>
      ) : null}
      {c.notes?.length ? (
        <details className="text-xs text-fg-3">
          <summary className="focus-ring w-fit cursor-pointer rounded-sm text-accent-text hover:underline">정의·주의 사항 {c.notes.length}개</summary>
          <ul className="mt-1.5 list-disc space-y-1 pl-5 text-fg-2">
            {c.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {docs ? (
        <a
          href={docs}
          target="_blank"
          rel="noopener noreferrer"
          className="focus-ring inline-flex w-fit items-center gap-1 rounded-sm text-xs text-accent-text hover:underline"
        >
          원천 문서·약관 <ExternalLink className="size-3" aria-hidden />
        </a>
      ) : null}
    </article>
  );
}

/* ------------------------------------------------------------------------------------------ runs */

const RUN_TONE: Record<CollectionRun['status'], { label: string; tone: Tone }> = {
  ok: { label: '성공', tone: 'positive' },
  partial: { label: '일부 실패', tone: 'warning' },
  error: { label: '실패', tone: 'negative' },
};

export function RunsTable({ runs, labels }: { runs: CollectionRun[]; labels: Record<string, string> }) {
  const tz = useTz();
  const [problemsOnly, setProblemsOnly] = useState(false);
  const [page, setPage] = useState(1);
  const PAGE = 20;
  const list = problemsOnly ? runs.filter((r) => r.status !== 'ok') : runs;
  const pages = Math.max(1, Math.ceil(list.length / PAGE));
  const current = Math.min(Math.max(1, page), pages);
  const rows = list.slice((current - 1) * PAGE, current * PAGE);
  const columns: Column<CollectionRun>[] = [
    {
      id: 'start',
      header: '시작',
      width: '9.5rem',
      cell: (r) => (
        <span className="text-xs text-fg-2 tabular" title={r.id}>
          {fmtTime(r.startedAt, tz)} {tzShort(tz)}
        </span>
      ),
    },
    { id: 'source', header: '원천', cell: (r) => <span className="text-[13px]">{labels[r.source] ?? r.source}</span> },
    {
      id: 'status',
      header: '상태',
      width: '6rem',
      cell: (r) => <Badge tone={RUN_TONE[r.status]?.tone ?? 'neutral'}>{RUN_TONE[r.status]?.label ?? r.status}</Badge>,
    },
    { id: 'dur', header: '소요', align: 'right', hideBelow: 'md', cell: (r) => <span className="text-xs">{formatDurationKo(runDurationSec(r))}</span> },
    {
      id: 'seen',
      header: '발견/신규',
      align: 'right',
      hideBelow: 'sm',
      cell: (r) => (
        <span className="text-xs tabular">
          {formatInteger(r.videosSeen)} / {formatInteger(r.videosNew)}
        </span>
      ),
    },
    { id: 'obs', header: '관측', align: 'right', hideBelow: 'md', cell: (r) => <span className="text-xs tabular">{formatInteger(r.observations)}</span> },
    { id: 'req', header: '요청', align: 'right', hideBelow: 'lg', cell: (r) => <span className="text-xs tabular">{formatInteger(r.requests)}</span> },
    {
      id: 'errors',
      header: '오류',
      width: '12rem',
      cell: (r) =>
        r.errors.length ? (
          <details className="text-xs">
            <summary className="focus-ring cursor-pointer rounded-sm text-negative">{r.errors.length}건</summary>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 break-words text-fg-2">
              {r.errors.slice(0, 20).map((e, i) => (
                <li key={i}>{e}</li>
              ))}
              {r.errors.length > 20 ? <li className="text-fg-3">외 {r.errors.length - 20}건</li> : null}
            </ul>
          </details>
        ) : (
          <span className="text-xs text-fg-3">없음</span>
        ),
    },
  ];
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 sm:px-5">
        <Checkbox
          checked={problemsOnly}
          onChange={(v) => {
            setProblemsOnly(v);
            setPage(1);
          }}
          label="오류·일부 실패만"
        />
      </div>
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        caption="수집 실행 기록"
        minWidth="340px"
        dense
        empty={<EmptyState compact title={problemsOnly ? '오류가 난 실행 없음' : '실행 기록 없음'} />}
      />
      {list.length > PAGE ? <Pager className="px-4 pb-3 sm:px-5" page={current} pageSize={PAGE} total={list.length} onChange={setPage} /> : null}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ definitions */

const STATUS_EXAMPLES: Record<MetricStatus, { value: number | null; note: string | null }> = {
  exact: { value: 123456, note: null },
  interpolated: { value: 123456, note: null },
  lower_bound: { value: 123456, note: 'start_before_first_observation' },
  source_reported: { value: 123456, note: 'source_window' },
  unavailable: { value: null, note: 'gap_too_wide' },
  decrease_flagged: { value: -1200, note: 'counter_decreased' },
};

export function StatusLegend({ now }: { now: number }) {
  return (
    <ul className="grid gap-2 sm:grid-cols-2">
      {STATUS_ORDER_FOR_BARS.map((s) => (
        <li key={s} className="flex items-start gap-3 rounded-lg border border-line p-3">
          <span className="w-20 shrink-0 text-right">
            <MetricCell metric={{ value: STATUS_EXAMPLES[s].value, status: s, asOf: now, note: STATUS_EXAMPLES[s].note }} label="예시" />
          </span>
          <span className="min-w-0 text-[13px]">
            <span className="font-medium text-fg">{STATUS_META[s].label}</span> <code className="text-[11px] text-fg-3">{s}</code>
            <span className="block text-xs text-fg-3">{STATUS_META[s].description}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export interface Caveat {
  title: string;
  body: ReactNode;
}

export const METRIC_CAVEATS: Caveat[] = [
  {
    title: '없는 값은 0이 아님',
    body: '원천이 주지 않는 지표(예: YouTube RSS의 댓글 수, Dailymotion의 댓글·공유)는 빈 값(—)으로 두고 합계·참여율에서 빼며, 참여율에는 실제로 더한 항목을 표시함.',
  },
  {
    title: 'X 조회수 = 노출 수',
    body: 'X의 views는 게시물 노출 횟수(impression)로 같은 사람의 반복 열람과 작성자 본인 열람이 포함됨. 동영상 재생 수·고유 시청자 수가 아니라 다른 플랫폼 조회수와 합산하지 않음.',
  },
  {
    title: 'YouTube 조회 집계 변경',
    body: '2025-03-31부터 Shorts는 재생·반복 재생 시작 횟수로 집계됨(2026-08에는 다른 형식에도 추가 변경 안내). 변경 전후 기간을 비교할 때 주의.',
  },
  {
    title: 'niconico는 하루 1회 스냅샷',
    body: '스냅샷 검색 API 값은 하루 한 번(보통 일본 시간 새벽) 갱신되며 관측 시각은 스냅샷 시각임. 기간 증가량 해상도는 최대 하루라 짧은 기간 값은 보간(≈)·하한(≥)이 많음.',
  },
  {
    title: 'Dailymotion 기간값은 원천 제공',
    body: '최근 24시간/7일/30일 조회수는 Dailymotion이 직접 집계한 값(원천)이며 데이터 기준 시각에 끝나는 롤링 기간(최근 24시간·168시간·720시간)에서만 씀. 원천 집계 지연으로 0이나 누적값과 같게 보고되기도 함.',
  },
  {
    title: 'PeerTube는 인스턴스마다 집계',
    body: '조회·좋아요는 영상이 올라간 원 인스턴스가 집계한 값이며 인스턴스마다 방식이 다를 수 있음. 댓글 수는 최신 버전 인스턴스만 제공.',
  },
  {
    title: '플랫폼 간 단위가 다름',
    body: '여러 플랫폼이 섞인 순위·합계에는 경고를 붙이고, 플랫폼별로 보거나 플랫폼 내 백분위 정렬을 권함.',
  },
  {
    title: '국가 ≠ 언어 ≠ 시청 지역',
    body: "'업로드 국가(원천 제공)'는 채널·업로더가 지정한 국가, '영상 언어'는 원천 값이나 문자 추정임. 어느 쪽도 실제 시청자 지역이 아님.",
  },
  {
    title: '추적 범위 기준',
    body: '모든 순위와 합계는 이 서비스가 찾아서 추적 중인 영상(시드 채널·검색 조건) 기준이며 플랫폼 전체 순위가 아님.',
  },
];

export function CaveatList({ items }: { items: Caveat[] }) {
  return (
    <ul className="grid gap-3 md:grid-cols-2">
      {items.map((c) => (
        <li key={c.title} className="rounded-lg border border-line p-3">
          <p className="text-[13px] font-semibold text-fg">{c.title}</p>
          <p className="mt-0.5 text-[13px] text-fg-2">{c.body}</p>
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------------------------------ enable sources */

export function EnableSources({ rows }: { rows: SourceRow[] }) {
  const disabled = rows.filter((r) => r.state === 'disabled' && r.requiresCredentials);
  const envLines = disabled.flatMap((r) => r.env.map((e) => `${e}=`));
  return (
    <div className="flex flex-col gap-4 text-[13px] text-fg-2">
      {disabled.length ? (
        <ul className="grid gap-3 md:grid-cols-2">
          {disabled.map((r) => {
            const info = CREDENTIALS[r.source];
            const docs = safeHttpUrl(info?.docsUrl ?? r.coverage.docsUrl);
            return (
              <li key={r.source} className="flex flex-col gap-1.5 rounded-lg border border-line p-3">
                <p className="flex items-center gap-1.5 font-semibold text-fg">
                  <PlatformBadge platform={r.platform} size="xs" iconOnly />
                  {r.label}
                </p>
                <p className="flex flex-wrap gap-1">
                  {r.env.map((e) => (
                    <code key={e} className="rounded bg-surface-2 px-1.5 text-xs text-fg">
                      {e}
                    </code>
                  ))}
                </p>
                {info ? <p className="text-xs">{info.howTo}</p> : null}
                {info?.caveat ? <p className="text-xs text-warning">{info.caveat}</p> : null}
                {docs ? (
                  <a
                    href={docs}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="focus-ring inline-flex w-fit items-center gap-1 rounded-sm text-xs text-accent-text hover:underline"
                  >
                    발급 안내 <ExternalLink className="size-3" aria-hidden />
                  </a>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p>인증 정보가 필요한 원천이 모두 켜져 있음.</p>
      )}
      <ol className="list-decimal space-y-2 pl-5">
        <li>
          <span className="font-medium text-fg">로컬 실행</span>: 저장소 루트의 <code className="rounded bg-surface-2 px-1">.env</code> 파일에 필요한 키를 넣고{' '}
          <code className="rounded bg-surface-2 px-1">npm run collect</code> → <code className="rounded bg-surface-2 px-1">npm run export</code> 실행.
          키가 있는 원천만 자동으로 켜짐.
          {envLines.length ? (
            <pre className="mt-1.5 overflow-x-auto rounded-md bg-surface-2 p-2 text-xs text-fg">{envLines.join('\n')}</pre>
          ) : null}
        </li>
        <li>
          <span className="font-medium text-fg">GitHub Actions</span>: 저장소 Settings → Secrets and variables → Actions에 같은 이름으로 저장소 비밀값(secret)을
          등록하면 예약 수집 워크플로가 환경 변수로 넘겨 사용함. 비밀값은 데이터셋·화면에 노출되지 않음.
        </li>
        <li>
          <span className="font-medium text-fg">확인</span>: 다음 수집 뒤 이 페이지의 원천 상태가 '비활성'에서 '정상'으로 바뀌고 영상·계정 수가 늘어남. 오류가 나면
          수집 실행 기록에 남음.
        </li>
      </ol>
      <p className="text-xs text-fg-3">
        공개·무인증 원천(YouTube RSS, Dailymotion, PeerTube, niconico)은 키 없이 동작함. 인증 원천도 공식 API만 사용하며, 지표를 얻으려고 HTML 페이지를 긁지 않음.
      </p>
    </div>
  );
}
