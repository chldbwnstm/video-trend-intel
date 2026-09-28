/**
 * MultiSelect: filter popover with search + checkboxes (languages, upload countries, formats, topics...).
 * Pager: page navigation for long result lists (URL key `page`, 1-based).
 */
import { useId, useMemo, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cx } from '../lib/cx.ts';
import { textMatchesSafe } from '../lib/search.ts';
import { Popover } from './Overlay.tsx';

export interface MultiSelectOption {
  value: string;
  label: string;
  /** Optional count shown on the right. */
  count?: number;
  /** Extra search terms (e.g. the ISO code for a language label). */
  keywords?: string[];
}

export interface MultiSelectProps {
  /** Filter name, e.g. `영상 언어`, `업로드 국가(원천 제공)`. */
  label: string;
  options: MultiSelectOption[];
  /** Selected values; empty = no filter (all). */
  value: string[];
  onChange: (next: string[]) => void;
  icon?: ReactNode;
  /** Show the search box (default: when more than 8 options). */
  searchable?: boolean;
  /** Text when nothing is selected (default `전체`). */
  allLabel?: string;
  width?: number;
}

/** Summary text for a selection: `전체`, `한국어`, `한국어 외 2`. */
export function selectionSummary(value: string[], options: MultiSelectOption[], allLabel = '전체'): string {
  if (value.length === 0) return allLabel;
  const first = options.find((o) => o.value === value[0])?.label ?? value[0];
  return value.length === 1 ? first : `${first} 외 ${value.length - 1}`;
}

export function MultiSelect({ label, options, value, onChange, icon, searchable, allLabel = '전체', width = 280 }: MultiSelectProps) {
  return (
    <Popover
      label={`${label} 선택`}
      active={value.length > 0}
      width={width}
      buttonContent={
        <>
          {icon ? <span className="shrink-0 text-fg-3" aria-hidden>{icon}</span> : null}
          <span className="text-fg-3">{label}</span>
          <span className="truncate font-medium">{selectionSummary(value, options, allLabel)}</span>
        </>
      }
    >
      {() => <MultiSelectPanel label={label} options={options} value={value} onChange={onChange} searchable={searchable ?? options.length > 8} />}
    </Popover>
  );
}

function MultiSelectPanel({
  label,
  options,
  value,
  onChange,
  searchable,
}: {
  label: string;
  options: MultiSelectOption[];
  value: string[];
  onChange: (next: string[]) => void;
  searchable: boolean;
}) {
  const [q, setQ] = useState('');
  const searchId = useId();
  const visible = useMemo(
    () => (q.trim() ? options.filter((o) => textMatchesSafe(o.label, q.trim()) || textMatchesSafe(o.value, q.trim()) || (o.keywords ?? []).some((k) => textMatchesSafe(k, q.trim()))) : options),
    [options, q],
  );
  const toggle = (v: string) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  return (
    <div className="flex flex-col">
      {searchable ? (
        <div className="sticky top-0 z-10 border-b border-line bg-surface p-2">
          <label htmlFor={searchId} className="sr-only">
            {label} 검색
          </label>
          <input
            id={searchId}
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={`${label} 검색`}
            className="focus-ring h-8 w-full rounded-md border border-line bg-surface px-2.5 text-sm text-fg placeholder:text-fg-3"
          />
        </div>
      ) : null}
      {visible.length ? (
        <ul aria-label={`${label} 목록`} className="p-1">
          {visible.map((o) => (
            <li key={o.value}>
              <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-surface-2">
                <input type="checkbox" checked={value.includes(o.value)} onChange={() => toggle(o.value)} className="focus-ring size-4 shrink-0 accent-[var(--accent)]" />
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {o.count !== undefined ? <span className="shrink-0 text-xs text-fg-3 tabular">{o.count.toLocaleString('ko-KR')}</span> : null}
              </label>
            </li>
          ))}
        </ul>
      ) : (
        <p className="p-4 text-center text-sm text-fg-3">일치하는 항목 없음</p>
      )}
      {value.length ? (
        <div className="flex justify-end border-t border-line p-2">
          <button type="button" onClick={() => onChange([])} className="focus-ring rounded-sm text-xs text-accent-text hover:underline">
            선택 해제 ({value.length})
          </button>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ Pager */

export interface PagerProps {
  /** 1-based current page. */
  page: number;
  pageSize: number;
  total: number;
  onChange: (page: number) => void;
  className?: string;
  /**
   * What to bring into view after a page change. Default: the table in the Pager's card (or the element
   * marked `data-pager-scope`), so the user lands on the first row of the new page instead of the bottom
   * of it. `false` disables scrolling.
   */
  scrollTarget?: RefObject<HTMLElement | null> | false;
}

/**
 * The element to show after a page change: an explicit target, else the table (or the scope itself) inside
 * the closest `[data-pager-scope]` / card around the pager.
 */
export function pagerScrollTarget(from: Element | null): HTMLElement | null {
  const scope = from?.closest<HTMLElement>('[data-pager-scope], [data-card]') ?? null;
  if (!scope) return null;
  return scope.querySelector<HTMLElement>('table') ?? scope;
}

/**
 * After a page change: scroll the results into view when their start is above the viewport (the pager sits
 * at the bottom of a long list) and move focus to the table caption, so keyboard and screen-reader users
 * start reading the new page from its first row. The caption is announced (it names the page).
 */
export function revealResults(target: HTMLElement | null): void {
  if (!target || typeof window === 'undefined') return;
  const top = target.getBoundingClientRect().top;
  // scroll-margin-top (index.css) keeps the start below the sticky top bar.
  if (top < 0) target.scrollIntoView({ block: 'start' });
  const caption = target.tagName === 'TABLE' ? target.querySelector<HTMLElement>('caption') : null;
  const focusEl = caption ?? target;
  if (!focusEl.hasAttribute('tabindex')) focusEl.setAttribute('tabindex', '-1');
  focusEl.focus({ preventScroll: true });
}

/** Page count for a total (at least 1). */
export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(Math.max(0, total) / Math.max(1, pageSize)));
}

/** Clamp a requested page into [1, pageCount]. */
export function clampPage(page: number, total: number, pageSize: number): number {
  if (!Number.isFinite(page)) return 1;
  return Math.min(pageCount(total, pageSize), Math.max(1, Math.trunc(page)));
}

export function Pager({ page, pageSize, total, onChange, className, scrollTarget }: PagerProps) {
  const navRef = useRef<HTMLElement>(null);
  const pages = pageCount(total, pageSize);
  const current = clampPage(page, total, pageSize);
  const from = total === 0 ? 0 : (current - 1) * pageSize + 1;
  const to = Math.min(total, current * pageSize);
  const btn = 'focus-ring inline-flex size-8 items-center justify-center rounded-md border border-line bg-surface text-fg-2 hover:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-40';
  const go = (p: number) => {
    onChange(p);
    if (scrollTarget === false) return;
    revealResults(scrollTarget ? scrollTarget.current : pagerScrollTarget(navRef.current));
  };
  return (
    <nav ref={navRef} aria-label="페이지 이동" className={cx('flex flex-wrap items-center justify-between gap-2 text-[13px] text-fg-3', className)}>
      <span className="tabular">
        {total.toLocaleString('ko-KR')}개 중 {from.toLocaleString('ko-KR')}–{to.toLocaleString('ko-KR')}
      </span>
      <span className="flex items-center gap-1.5">
        <button type="button" className={btn} onClick={() => go(current - 1)} disabled={current <= 1} aria-label="이전 페이지">
          <ChevronLeft className="size-4" aria-hidden />
        </button>
        <span className="min-w-16 text-center tabular" aria-live="polite">
          {current} / {pages}
        </span>
        <button type="button" className={btn} onClick={() => go(current + 1)} disabled={current >= pages} aria-label="다음 페이지">
          <ChevronRight className="size-4" aria-hidden />
        </button>
      </span>
    </nav>
  );
}
