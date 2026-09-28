/**
 * Provenance small print: data as-of time, the resolved window (local dates, incomplete state),
 * sources, and the Korean notes returned by core analytics. Put one under every result.
 */
import type { ReactNode } from 'react';
import type { UtcWindow } from '@vti/core';
import { Link } from 'react-router-dom';
import { Clock } from 'lucide-react';
import { cx } from '../lib/cx.ts';
import { fmtTime } from '../lib/display.ts';
import { tzShort } from '../lib/timezones.ts';
import { useTz } from '../data/hooks.ts';

/** Inclusive local-date label for a half-open window: `2026-09-22 ~ 2026-09-28`. */
export function windowLabel(w: Pick<UtcWindow, 'startMs' | 'endMs'>, tz: string): string {
  const start = fmtTime(w.startMs, tz, 'date');
  const end = fmtTime(w.endMs - 1, tz, 'date');
  return start === end ? start : `${start} ~ ${end}`;
}

export interface SourceNoteProps {
  /** Data as-of instant (usually `now` from useDataset). */
  asOf: number;
  window?: UtcWindow | null;
  notes?: string[];
  /**
   * What the result is based on, each item self-labelled (`분류기 rules-2026.09.1`, `협찬 판정 sponsor-…`,
   * `켜진 원천 4개`). Rendered after `기준`; don't start items with `원천` twice.
   */
  sources?: string[];
  /** Extra small-print items. */
  children?: ReactNode;
  /** Show a link to the coverage page (default true). */
  coverageLink?: boolean;
  className?: string;
}

export function SourceNote({ asOf, window, notes, sources, children, coverageLink = true, className }: SourceNoteProps) {
  const tz = useTz();
  const uniqueNotes = notes ? [...new Set(notes.filter(Boolean))] : [];
  return (
    <div className={cx('flex flex-col gap-1 text-xs text-fg-3', className)}>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <Clock className="size-3.5 shrink-0" aria-hidden />
        <span>
          데이터 기준 {fmtTime(asOf, tz)} ({tzShort(tz)})
        </span>
        {window ? (
          <>
            <span aria-hidden>·</span>
            <span>기간 {windowLabel(window, tz)}</span>
            {window.incomplete ? (
              <span className="rounded bg-warning-soft px-1.5 py-px font-medium text-warning">진행 중인 기간: 값이 더 늘어날 수 있음</span>
            ) : null}
          </>
        ) : null}
        {sources && sources.length ? (
          <>
            <span aria-hidden>·</span>
            <span>기준 {sources.join(', ')}</span>
          </>
        ) : null}
        {coverageLink ? (
          <>
            <span aria-hidden>·</span>
            <Link to="/coverage" className="focus-ring rounded-sm text-accent-text hover:underline">
              수집 범위·지표 정의
            </Link>
          </>
        ) : null}
      </p>
      {uniqueNotes.length ? (
        <ul className="list-disc space-y-0.5 pl-5">
          {uniqueNotes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
      {children}
    </div>
  );
}
