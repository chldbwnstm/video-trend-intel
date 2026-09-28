/**
 * Callout explaining that the observation history is still short (early collection phase), with a link to
 * the coverage page. Used by the trends / ratings / explore pages so partial results read as "not collected
 * yet", not as a broken page.
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Hourglass } from 'lucide-react';
import { cx } from '../../lib/cx.ts';
import { fmtTime } from '../../lib/display.ts';
import { formatInteger, formatPercent } from '../../lib/format.ts';
import { tzShort } from '../../lib/timezones.ts';
import { useDataset } from '../../data/hooks.ts';
import type { DataReadiness } from './readiness.ts';

export interface ReadinessCalloutProps {
  readiness: DataReadiness;
  /** Page-specific explanation (what is missing and when it fills in). */
  children: ReactNode;
  title?: string;
  className?: string;
}

export function ReadinessCallout({ readiness, children, title = '관측 기록이 아직 짧음', className }: ReadinessCalloutProps) {
  const { tz } = useDataset();
  return (
    <aside
      aria-label={title}
      className={cx('flex items-start gap-3 rounded-xl border border-line bg-info-soft px-4 py-3 text-[13px] text-fg-2', className)}
    >
      <Hourglass className="mt-0.5 size-4 shrink-0 text-info" aria-hidden />
      <div className="flex min-w-0 flex-col gap-1">
        <p className="font-semibold text-fg">{title}</p>
        <p>
          첫 관측 {readiness.firstObservationAt !== null ? `${fmtTime(readiness.firstObservationAt, tz)} ${tzShort(tz)}` : '없음'} · 관측 2회 이상 영상{' '}
          {formatInteger(readiness.withHistory)}개 / {formatInteger(readiness.totalVideos)}개({formatPercent(readiness.historyShare)}). 수집은 3시간마다 이어지며
          기록이 쌓일수록 값이 채워짐.
        </p>
        <div>{children}</div>
        <Link to="/coverage" className="focus-ring w-fit rounded-sm text-accent-text hover:underline">
          데이터 범위·수집 방식 보기
        </Link>
      </div>
    </aside>
  );
}
