/**
 * Page-level layout pieces: PageHeader, FilterBar, KpiTile, KpiGrid, FreshnessBadge, SectionGrid.
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cx } from '../lib/cx.ts';
import { formatAgo } from '../lib/format.ts';
import { Badge } from './primitives.tsx';
import type { Tone } from './primitives.tsx';
import { InfoTip } from './Tooltip.tsx';

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** Small label above the title (e.g. the Tubular-equivalent module). */
  eyebrow?: ReactNode;
  className?: string;
}

/**
 * Page title block. Actions sit beside the title from `sm` up; on phones the text block takes the full width
 * and the actions wrap onto their own row below the description (instead of squeezing it into a column).
 */
export function PageHeader({ title, description, actions, eyebrow, className }: PageHeaderProps) {
  return (
    <header className={cx('flex flex-wrap items-end justify-between gap-3', className)}>
      <div className="w-full min-w-0 sm:w-auto sm:flex-1">
        {eyebrow ? <p className="mb-0.5 text-xs font-medium text-fg-3">{eyebrow}</p> : null}
        <h1 className="text-xl font-bold tracking-tight text-fg sm:text-2xl">{title}</h1>
        {description ? <p className="mt-1 max-w-3xl text-[13px] text-fg-3 sm:text-sm">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/**
 * One filter row above everything it scopes (wraps on small screens). No outer margin: pages stack
 * sections with `flex flex-col gap-4`.
 */
export function FilterBar({ children, className, label = '필터' }: { children: ReactNode; className?: string; label?: string }) {
  return (
    <div role="group" aria-label={label} className={cx('flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface p-3 shadow-card', className)}>
      {children}
    </div>
  );
}

export interface KpiTileProps {
  label: string;
  /** Main value (use MetricCell size="lg" for metrics with provenance, or plain text for counts). */
  value: ReactNode;
  /** Secondary line (context, comparison). */
  sub?: ReactNode;
  delta?: ReactNode;
  icon?: ReactNode;
  /** A SparkLine or similar. */
  chart?: ReactNode;
  hint?: ReactNode;
  /** Router path: makes the label a link to the detailed page. */
  to?: string;
  className?: string;
}

export function KpiTile({ label, value, sub, delta, icon, chart, hint, to, className }: KpiTileProps) {
  return (
    <section className={cx('flex min-w-0 flex-col gap-1 rounded-xl border border-line bg-surface p-4 shadow-card', className)} aria-label={label}>
      <div className="flex items-center gap-1.5 text-[13px] text-fg-3">
        {icon ? <span aria-hidden className="inline-flex text-fg-3">{icon}</span> : null}
        {to ? (
          <Link to={to} className="focus-ring truncate rounded-sm hover:text-accent-text hover:underline">
            {label}
          </Link>
        ) : (
          <span className="truncate">{label}</span>
        )}
        {hint ? <InfoTip label={`${label} 설명`}>{hint}</InfoTip> : null}
      </div>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-2xl font-bold tracking-tight text-fg">{value}</span>
        {delta}
      </div>
      {sub ? <div className="text-xs text-fg-3">{sub}</div> : null}
      {chart ? <div className="mt-1">{chart}</div> : null}
    </section>
  );
}

export function KpiGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5', className)}>{children}</div>;
}

export type FreshnessLevel = 'fresh' | 'delayed' | 'stale' | 'sample';

/** Freshness of data generated at `generatedAt` seen at wall-clock `clock`. */
export function freshnessLevel(generatedAt: number, clock: number, isSample = false): FreshnessLevel {
  if (isSample) return 'sample';
  const h = (clock - generatedAt) / 3_600_000;
  if (h <= 6) return 'fresh';
  if (h <= 30) return 'delayed';
  return 'stale';
}

const FRESHNESS: Record<FreshnessLevel, { label: string; tone: Tone; hint: string }> = {
  fresh: { label: '최신', tone: 'positive', hint: '6시간 안에 생성된 데이터.' },
  delayed: { label: '지연', tone: 'warning', hint: '6~30시간 전에 생성된 데이터. 수집 일정이 밀렸을 수 있음.' },
  stale: { label: '오래됨', tone: 'negative', hint: '30시간 넘게 갱신되지 않음. 데이터 범위 페이지에서 수집 상태 확인 필요.' },
  sample: { label: '샘플', tone: 'warning', hint: '합성 샘플 데이터. 실제 플랫폼 수치가 아님.' },
};

export function FreshnessBadge({ generatedAt, clock, isSample, className }: { generatedAt: number; clock: number; isSample?: boolean; className?: string }) {
  const level = freshnessLevel(generatedAt, clock, isSample);
  const f = FRESHNESS[level];
  return (
    <Badge tone={f.tone} className={className} title={`${f.hint} 생성: ${formatAgo(generatedAt, clock)}`}>
      <span className="sr-only">데이터 신선도: </span>
      {f.label}
      {level !== 'sample' ? <span className="font-normal opacity-80">· {formatAgo(generatedAt, clock)}</span> : null}
    </Badge>
  );
}

/** Responsive 12-column grid for dashboard sections. */
export function SectionGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('grid grid-cols-1 gap-4 lg:grid-cols-12', className)}>{children}</div>;
}
