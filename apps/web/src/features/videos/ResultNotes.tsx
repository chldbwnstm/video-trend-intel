/**
 * Explanations above the result table: the queryVideos notes as an info callout, a status breakdown of
 * the mode's primary metric, and a coverage callout when values cannot be computed yet (first days of
 * collection: one observation per video, boundaries not observed). Never shows partial data as "broken".
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { AgeDays, DateMode, MetricStatus } from '@vti/core';
import { Database, Info, TriangleAlert } from 'lucide-react';
import { Button } from '../../components/index.ts';
import { useTz } from '../../data/hooks.ts';
import { fmtTime } from '../../lib/display.ts';
import { formatInteger } from '../../lib/format.ts';
import { STATUS_META } from '../../lib/metricStatus.ts';
import { tzShort } from '../../lib/timezones.ts';
import { cx } from '../../lib/cx.ts';
import type { DataCoverage, StatusSummary } from './model.ts';

/** Unavailable share from which the callout is emphasized and offers the next steps. */
export const SEVERE_SHARE = 0.9;

/** `27%`; never rounds up to 100% (or down to 0%) while some values exist on either side. */
export function unavailableShare(s: StatusSummary): string {
  if (s.total === 0) return '0%';
  if (s.unavailable === s.total) return '100%';
  const pct = (s.unavailable / s.total) * 100;
  if (pct > 99) return '99% 이상';
  if (pct > 0 && pct < 1) return '1% 미만';
  return `${Math.round(pct)}%`;
}

const BREAKDOWN_ORDER: MetricStatus[] = ['exact', 'interpolated', 'source_reported', 'lower_bound', 'decrease_flagged', 'unavailable'];

/** `정확 3,918 · ≥ 하한값 557 · 원천 원천 제공값 …` parts, in a fixed order, only non-zero. */
export function breakdownParts(summary: StatusSummary): { status: MetricStatus; text: string }[] {
  return BREAKDOWN_ORDER.filter((s) => summary.counts[s]).map((s) => {
    const meta = STATUS_META[s];
    const marker = meta.marker && s !== 'source_reported' ? `${meta.marker} ` : '';
    return { status: s, text: `${marker}${meta.label} ${formatInteger(summary.counts[s] ?? 0)}` };
  });
}

export function StatusBreakdown({ label, summary, className }: { label: string; summary: StatusSummary; className?: string }) {
  const parts = breakdownParts(summary);
  if (!parts.length) return null;
  return (
    <p className={cx('flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-fg-3', className)}>
      <span className="font-medium text-fg-2">{label} 값 상태</span>
      {parts.map((p, i) => (
        <span key={p.status} className={cx('tabular', p.status === 'unavailable' && 'text-fg-3', p.status === 'decrease_flagged' && 'text-negative')}>
          {i > 0 ? <span aria-hidden className="mr-2">·</span> : null}
          {p.text}
        </span>
      ))}
    </p>
  );
}

/* ------------------------------------------------------------------------------------------ notes */

/** The core notes (date semantics, provenance counts, platform caveat) as one info callout. */
export function NotesCallout({ notes, action }: { notes: string[]; action?: ReactNode }) {
  const unique = [...new Set(notes.filter(Boolean))];
  if (!unique.length) return null;
  const head = unique.slice(0, 2);
  const rest = unique.slice(2);
  return (
    <div role="note" aria-label="결과 읽는 법" className="flex gap-2 rounded-lg border border-line bg-info-soft px-3 py-2 text-[13px] text-fg-2">
      <Info className="mt-0.5 size-4 shrink-0 text-info" aria-hidden />
      <div className="flex min-w-0 flex-col gap-1">
        <ul className="flex flex-col gap-1">
          {head.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
        {rest.length ? (
          <details>
            <summary className="focus-ring w-fit cursor-pointer rounded-sm text-xs text-accent-text hover:underline">계산 메모 {rest.length}건 더 보기</summary>
            <ul className="mt-1 flex flex-col gap-1">
              {rest.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </details>
        ) : null}
        {action ? <div className="flex flex-wrap items-center gap-2 pt-0.5">{action}</div> : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ coverage */

export interface CoverageCalloutProps {
  coverage: DataCoverage;
  mode: DateMode;
  age: AgeDays;
  /** Label of the primary metric, e.g. `기간 조회 증가`. */
  label: string;
  summary: StatusSummary;
  collectionStart: number | null;
  /** Rolling preset active (source-reported windows can apply). */
  rolling: boolean;
  onUseUpload?: () => void;
  onUseRolling?: () => void;
}

function coverageLink() {
  return (
    <Link to="/coverage" className="focus-ring inline-flex items-center gap-1 rounded-sm text-[13px] font-medium text-accent-text hover:underline">
      <Database className="size-3.5" aria-hidden />
      데이터 범위·수집 이력 확인
    </Link>
  );
}

/**
 * Explains why the ranked metric is missing for many videos, in plain terms, with the next step. Rendered
 * for `none` (nothing computable) and `partial` (>= 20% unavailable); nothing for `ok` / `empty`.
 */
export function CoverageCallout({ coverage, mode, age, label, summary, collectionStart, rolling, onUseUpload, onUseRolling }: CoverageCalloutProps) {
  const tz = useTz();
  if (coverage !== 'none' && coverage !== 'partial') return null;
  const since = collectionStart !== null ? `${fmtTime(collectionStart, tz)} ${tzShort(tz)}` : null;
  const sinceText = since ? `관측은 ${since}부터 쌓이기 시작했고 약 3시간마다 추가됨.` : '관측이 쌓이는 중임.';
  const lower = summary.counts.lower_bound ?? 0;
  // Nearly nothing computable (first days of collection): treat like `none` for emphasis and next steps.
  const severe = coverage === 'none' || summary.unavailable / Math.max(1, summary.total) >= SEVERE_SHARE;

  let title: string;
  let body: string;
  if (coverage === 'none') {
    if (mode === 'age') {
      title = `게시 후 ${age}일 시점 조회(V${age})를 계산할 수 있는 영상이 아직 없음`;
      body = `V${age}는 게시 후 ${age}일이 되는 시각 앞뒤로 우리 관측이 있어야 계산됨. ${sinceText} 수집이 이어지면 새로 올라온 영상부터 채워짐.`;
    } else if (mode === 'activity') {
      title = '이 기간의 조회 증가를 계산할 수 있는 영상이 아직 없음';
      body = `기간 시작·끝 시점의 관측이나 원천이 직접 집계한 기간값이 필요함. ${sinceText} 관측 시작 전에 시작하는 기간은 계산할 수 없음.${rolling ? '' : ' 최근 24시간·168시간·720시간 프리셋은 원천 제공 기간값(Dailymotion)을 쓸 수 있음.'}`;
    } else {
      title = '누적 조회를 읽을 수 있는 영상이 아직 없음';
      body = `원천이 조회수를 제공하지 않았거나 아직 관측되지 않았음. ${sinceText}`;
    }
  } else {
    title = `${label} 값을 아직 계산할 수 없는 영상 ${formatInteger(summary.unavailable)}개 (${unavailableShare(summary)})`;
    const why =
      mode === 'age'
        ? `게시 후 ${age}일 시점 앞뒤 관측이 없는 영상임.`
        : mode === 'activity'
          ? `관측이 기간 경계를 아직 덮지 못한 영상임.${rolling ? '' : ' 롤링 프리셋(최근 24시간·168시간·720시간)은 원천 제공 기간값으로 일부를 채울 수 있음.'}`
          : '조회수 관측이 없는 영상임.';
    body = `${why} 값은 0이 아니라 —(계산 불가)로 두고 순위에 넣지 않아 목록 끝에 표시함. ${sinceText} 수집 이력이 쌓이면 줄어듦.`;
  }

  return (
    <div
      role="note"
      aria-label="데이터 범위 안내"
      className={cx(
        'flex gap-2 rounded-lg border px-3 py-2 text-[13px]',
        severe ? 'border-warning bg-warning-soft text-fg' : 'border-line bg-surface-2 text-fg-2',
      )}
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
      <div className="flex min-w-0 flex-col gap-1">
        <p className="font-medium text-fg">{title}</p>
        <p>{body}</p>
        {lower > 0 ? (
          <p className="text-xs text-fg-3">
            ≥ 하한값 {formatInteger(lower)}개: 기간 중간부터 관측됐거나 마지막 관측이 기준 시각보다 앞선 영상. 실제 값은 표시값보다 크거나 같음.
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          {severe && mode === 'activity' && !rolling && onUseRolling ? (
            <Button size="sm" onClick={onUseRolling}>
              최근 168시간(7일)으로 보기
            </Button>
          ) : null}
          {severe && mode !== 'upload' && onUseUpload ? (
            <Button size="sm" onClick={onUseUpload}>
              업로드 기간 기준으로 보기
            </Button>
          ) : null}
          {coverageLink()}
        </div>
      </div>
    </div>
  );
}
