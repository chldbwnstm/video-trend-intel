/**
 * Form-ish controls: Tabs, SegmentedControl, Select, SearchInput, Checkbox.
 * Keyboard: Tabs and SegmentedControl use roving tabindex with arrow keys / Home / End.
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { Search, X } from 'lucide-react';
import { cx } from '../lib/cx.ts';

function rovingKey<T>(e: KeyboardEvent, values: T[], current: T, onChange: (v: T) => void, focusAt: (i: number) => void): void {
  const i = values.indexOf(current);
  let next = -1;
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % values.length;
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + values.length) % values.length;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = values.length - 1;
  if (next >= 0) {
    e.preventDefault();
    onChange(values[next]);
    focusAt(next);
  }
}

/* ------------------------------------------------------------------------------------------ Tabs */

export interface TabItem<T extends string> {
  id: T;
  label: ReactNode;
  /** Optional count badge. */
  count?: number;
  disabled?: boolean;
}

export interface TabsProps<T extends string> {
  tabs: TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  /** Accessible name of the tab list. */
  label: string;
  /** Prefix for ids; panels must use `${idBase}-panel-${id}` (see TabPanel). */
  idBase: string;
  className?: string;
}

/** Underlined tabs (section switcher). Render the content with <TabPanel>. */
export function Tabs<T extends string>({ tabs, value, onChange, label, idBase, className }: TabsProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = tabs.filter((t) => !t.disabled).map((t) => t.id);
  return (
    <div role="tablist" aria-label={label} className={cx('scroll-thin flex max-w-full gap-1 overflow-x-auto overflow-y-hidden shadow-[inset_0_-1px_0_var(--line)]', className)}>
      {tabs.map((t) => {
        const selected = t.id === value;
        return (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[tabs.indexOf(t)] = el;
            }}
            type="button"
            role="tab"
            id={`${idBase}-tab-${t.id}`}
            aria-selected={selected}
            aria-controls={`${idBase}-panel-${t.id}`}
            tabIndex={selected ? 0 : -1}
            disabled={t.disabled}
            onClick={() => onChange(t.id)}
            onKeyDown={(e) =>
              rovingKey(e, enabled, value, onChange, (i) => refs.current[tabs.findIndex((x) => x.id === enabled[i])]?.focus())
            }
            className={cx(
              'focus-ring inline-flex shrink-0 items-center gap-1.5 border-b-2 focus-visible:-outline-offset-2! px-3 py-2 text-sm whitespace-nowrap transition-colors disabled:opacity-40',
              selected ? 'border-accent font-semibold text-fg' : 'border-transparent text-fg-3 hover:text-fg',
            )}
          >
            {t.label}
            {t.count !== undefined ? (
              <span className={cx('rounded-full px-1.5 text-xs tabular', selected ? 'bg-accent-soft text-accent-text' : 'bg-surface-3 text-fg-3')}>
                {t.count.toLocaleString('ko-KR')}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({ idBase, id, children, className }: { idBase: string; id: string; children: ReactNode; className?: string }) {
  return (
    <div role="tabpanel" id={`${idBase}-panel-${id}`} aria-labelledby={`${idBase}-tab-${id}`} tabIndex={0} className={cx('focus-ring', className)}>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ SegmentedControl */

export interface SegmentOption<T extends string | number> {
  value: T;
  label: ReactNode;
  /** Tooltip / title text. */
  title?: string;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string | number> {
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Accessible group name (Korean). */
  label: string;
  size?: 'sm' | 'md';
  className?: string;
  /** Stretch segments to fill the width. */
  block?: boolean;
  /** id of an element describing the group (e.g. the active option's explanation). */
  describedBy?: string;
}

/** Single-choice segmented buttons (radio group semantics). */
export function SegmentedControl<T extends string | number>({ options, value, onChange, label, size = 'md', className, block, describedBy }: SegmentedControlProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = options.filter((o) => !o.disabled).map((o) => o.value);
  const hasSelection = options.some((o) => o.value === value);
  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-describedby={describedBy}
      // Narrow screens: the group scrolls inside itself instead of widening the page.
      className={cx(
        'scroll-thin max-w-full overflow-x-auto overflow-y-hidden rounded-lg border border-line bg-surface-2 p-0.5',
        block ? 'flex w-full' : 'inline-flex w-fit',
        className,
      )}
    >
      {options.map((o, idx) => {
        const selected = o.value === value;
        return (
          <button
            key={String(o.value)}
            ref={(el) => {
              refs.current[idx] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected || (!hasSelection && idx === 0) ? 0 : -1}
            disabled={o.disabled}
            title={o.title}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => rovingKey(e, enabled, value, onChange, (i) => refs.current[options.findIndex((x) => x.value === enabled[i])]?.focus())}
            className={cx(
              'focus-ring inline-flex min-w-0 items-center justify-center rounded-md whitespace-nowrap transition-colors focus-visible:-outline-offset-2! disabled:opacity-40',
              size === 'sm' ? 'h-7 px-2.5 text-[13px]' : 'h-8 px-3 text-sm',
              block ? 'flex-1' : 'shrink-0',
              selected ? 'bg-surface font-semibold text-fg shadow-card ring-1 ring-line' : 'text-fg-3 hover:text-fg',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ Select */

export interface SelectOption<T extends string> {
  value: T;
  label: string;
}

export interface SelectProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: SelectOption<T>[];
  /** Visible or screen-reader label. */
  label: string;
  hideLabel?: boolean;
  className?: string;
  size?: 'sm' | 'md';
}

/** Native select styled with tokens (best mobile behavior). */
export function Select<T extends string>({ value, onChange, options, label, hideLabel = true, className, size = 'md' }: SelectProps<T>) {
  const id = useId();
  return (
    <span className={cx('inline-flex items-center gap-2', className)}>
      <label htmlFor={id} className={hideLabel ? 'sr-only' : 'text-[13px] text-fg-3'}>
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className={cx(
          'focus-ring max-w-full rounded-md border border-line bg-surface pr-7 pl-2.5 text-fg',
          size === 'sm' ? 'h-8 text-[13px]' : 'h-9 text-sm',
        )}
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

/* ------------------------------------------------------------------------------------------ SearchInput */

export interface SearchInputProps {
  value: string;
  /** Called after `debounceMs` of inactivity (and immediately on Enter / clear). */
  onChange: (value: string) => void;
  placeholder?: string;
  label?: string;
  debounceMs?: number;
  className?: string;
}

/** Debounced search box with a clear button. Keeps local text so typing stays responsive. */
export function SearchInput({ value, onChange, placeholder = '검색', label = '검색', debounceMs = 250, className }: SearchInputProps) {
  const [text, setText] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    setText(value);
  }, [value]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const commit = (v: string, immediate: boolean) => {
    if (timer.current) clearTimeout(timer.current);
    if (immediate) onChangeRef.current(v);
    else timer.current = setTimeout(() => onChangeRef.current(v), debounceMs);
  };

  return (
    <div className={cx('relative flex min-w-0 items-center', className)}>
      <Search className="pointer-events-none absolute left-2.5 size-4 text-fg-3" aria-hidden />
      <input
        type="search"
        value={text}
        aria-label={label}
        placeholder={placeholder}
        onChange={(e) => {
          setText(e.target.value);
          commit(e.target.value, false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit(text, true);
        }}
        className="focus-ring h-9 w-full min-w-0 rounded-md border border-line bg-surface pr-8 pl-8 text-sm text-fg placeholder:text-fg-3 [&::-webkit-search-cancel-button]:hidden"
      />
      {text ? (
        <button
          type="button"
          aria-label="검색어 지우기"
          onClick={() => {
            setText('');
            commit('', true);
          }}
          className="focus-ring absolute right-1.5 inline-flex size-6 items-center justify-center rounded text-fg-3 hover:bg-surface-3 hover:text-fg"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ Checkbox */

export function Checkbox({
  checked,
  onChange,
  label,
  indeterminate,
  className,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  indeterminate?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!indeterminate && !checked;
  }, [indeterminate, checked]);
  return (
    <label className={cx('inline-flex min-w-0 cursor-pointer items-center gap-2 text-sm text-fg', className)}>
      <input
        ref={ref}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="focus-ring size-4 shrink-0 accent-[var(--accent)]"
      />
      <span className="min-w-0">{label}</span>
    </label>
  );
}
