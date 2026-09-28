/**
 * Page-local controls for 영상 탐색: sort menu (every SortKey, mode-specific labels, inapplicable keys
 * disabled with the reason), sort direction, labelled native selects for single-choice filters, and the
 * "링크 복사" button.
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { AgeDays, DateMode, SortKey } from '@vti/core';
import { ArrowDownWideNarrow, ArrowUpNarrowWide, Check, Link2 } from 'lucide-react';
import { Button } from '../../components/index.ts';
import { cx } from '../../lib/cx.ts';
import { SORT_MENU, sortLabel, sortUnavailableReason } from './model.ts';

const SELECT_CLASS =
  'focus-ring h-9 max-w-full min-w-0 rounded-md border bg-surface pr-7 pl-2.5 text-sm text-fg';

/* ------------------------------------------------------------------------------------------ sort */

export interface SortControlsProps {
  mode: DateMode;
  age: AgeDays;
  sort: SortKey;
  dir: 'asc' | 'desc';
  onSort: (key: SortKey) => void;
  onDir: (dir: 'asc' | 'desc') => void;
  className?: string;
}

export function SortControls({ mode, age, sort, dir, onSort, onDir, className }: SortControlsProps) {
  const id = useId();
  const next = dir === 'desc' ? 'asc' : 'desc';
  return (
    <div className={cx('flex min-w-0 max-w-full items-center gap-1.5', className)}>
      <label htmlFor={id} className="shrink-0 text-[13px] text-fg-3">
        정렬
      </label>
      {/* Option texts stay short: a native select is as wide as its longest option. */}
      <select
        id={id}
        value={sort}
        onChange={(e) => onSort(e.target.value as SortKey)}
        className={cx(SELECT_CLASS, 'w-full border-line sm:w-auto sm:max-w-[16rem]')}
      >
        {SORT_MENU.map((k) => {
          const reason = sortUnavailableReason(k, mode);
          return (
            <option key={k} value={k} disabled={reason !== null} title={reason ?? undefined}>
              {sortLabel(k, mode, age)}
              {reason ? ' (사용 불가)' : ''}
            </option>
          );
        })}
      </select>
      <button
        type="button"
        onClick={() => onDir(next)}
        aria-label={dir === 'desc' ? '내림차순 (눌러서 오름차순)' : '오름차순 (눌러서 내림차순)'}
        title={dir === 'desc' ? '큰 값부터 (내림차순)' : '작은 값부터 (오름차순)'}
        className="focus-ring inline-flex h-9 shrink-0 items-center gap-1 rounded-md border border-line bg-surface px-2 text-[13px] text-fg-2 hover:bg-surface-3"
      >
        {dir === 'desc' ? <ArrowDownWideNarrow className="size-4" aria-hidden /> : <ArrowUpNarrowWide className="size-4" aria-hidden />}
        <span className="hidden sm:inline">{dir === 'desc' ? '내림차순' : '오름차순'}</span>
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ select filter */

export interface FilterSelectProps<T extends string> {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  /** Highlight as an active filter. */
  active?: boolean;
  icon?: ReactNode;
}

/** Native select with a visible label prefix, styled like the popover filter buttons. */
export function FilterSelect<T extends string>({ label, value, options, onChange, active, icon }: FilterSelectProps<T>) {
  const id = useId();
  return (
    <span
      className={cx(
        'inline-flex h-9 max-w-full items-center gap-1.5 rounded-md border pl-3 text-sm',
        active ? 'border-accent bg-accent-soft text-accent-text' : 'border-line bg-surface text-fg',
      )}
    >
      {icon ? (
        <span className="shrink-0 text-fg-3" aria-hidden>
          {icon}
        </span>
      ) : null}
      <label htmlFor={id} className="shrink-0 text-fg-3">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="focus-ring h-full min-w-0 cursor-pointer rounded-r-md bg-transparent pr-2 font-medium text-inherit outline-none"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </span>
  );
}

/* ------------------------------------------------------------------------------------------ copy link */

/** Copy text to the clipboard; falls back to a hidden textarea + execCommand. Resolves false on failure. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    if (typeof document === 'undefined') return false;
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Copies the current URL (filters, sort, page and open video are all in it). */
export function CopyLinkButton({ size = 'sm' }: { size?: 'sm' | 'md' }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return (
    <span className="inline-flex flex-col items-end">
      <Button
        size={size}
        icon={state === 'copied' ? <Check className="size-3.5" aria-hidden /> : <Link2 className="size-3.5" aria-hidden />}
        title="현재 필터·정렬·기간이 담긴 링크를 복사"
        onClick={async () => {
          const ok = await copyText(window.location.href);
          setState(ok ? 'copied' : 'failed');
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setState('idle'), 2500);
        }}
      >
        {state === 'copied' ? '복사됨' : '링크 복사'}
      </Button>
      <span aria-live="polite" className={state === 'failed' ? 'mt-1 text-xs text-negative' : 'sr-only'}>
        {state === 'copied' ? '현재 보기 링크를 복사함' : state === 'failed' ? '복사하지 못함: 주소창의 링크를 사용' : ''}
      </span>
    </span>
  );
}
