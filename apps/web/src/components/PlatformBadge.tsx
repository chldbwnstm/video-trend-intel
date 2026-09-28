/**
 * PlatformBadge: brand-neutral chip (fixed categorical color dot + text label) per platform.
 * PlatformPicker: multi-select of platforms as toggle chips (empty selection = all platforms).
 */
import type { Platform } from '@vti/core';
import { cx } from '../lib/cx.ts';
import { platformColor, platformLabel } from '../lib/platform.ts';

export interface PlatformBadgeProps {
  platform: Platform;
  /** Hide the text label (the label stays available to screen readers and as a title). */
  iconOnly?: boolean;
  size?: 'xs' | 'sm';
  className?: string;
}

export function PlatformBadge({ platform, iconOnly, size = 'sm', className }: PlatformBadgeProps) {
  const label = platformLabel(platform);
  return (
    <span
      className={cx(
        'inline-flex max-w-full shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface-2 font-medium whitespace-nowrap text-fg-2',
        size === 'xs' ? 'px-1.5 py-px text-[11px]' : 'px-2 py-0.5 text-xs',
        iconOnly && 'px-1',
        className,
      )}
      title={label}
    >
      <span aria-hidden className={cx('inline-block shrink-0 rounded-full', size === 'xs' ? 'size-1.5' : 'size-2')} style={{ background: platformColor(platform) }} />
      {iconOnly ? <span className="sr-only">{label}</span> : <span className="truncate">{label}</span>}
    </span>
  );
}

export interface PlatformPickerProps {
  /** Platforms offered (usually the ones present in the dataset, canonical order). */
  options: Platform[];
  /** Selected platforms; empty = all. */
  value: Platform[];
  onChange: (next: Platform[]) => void;
  label?: string;
  /** Show per-platform counts. */
  counts?: Partial<Record<Platform, number>>;
  className?: string;
}

export function PlatformPicker({ options, value, onChange, label = '플랫폼', counts, className }: PlatformPickerProps) {
  const all = value.length === 0;
  const toggle = (p: Platform) => {
    const next = value.includes(p) ? value.filter((x) => x !== p) : [...value, p];
    // Keep canonical order and collapse "everything selected" to "all".
    const ordered = options.filter((o) => next.includes(o));
    onChange(ordered.length === options.length ? [] : ordered);
  };
  return (
    <div role="group" aria-label={label} className={cx('flex flex-wrap items-center gap-1.5', className)}>
      <button
        type="button"
        aria-pressed={all}
        onClick={() => onChange([])}
        className={cx(
          'focus-ring inline-flex h-8 items-center rounded-full border px-3 text-[13px] transition-colors',
          all ? 'border-accent bg-accent-soft font-semibold text-accent-text' : 'border-line bg-surface text-fg-2 hover:text-fg',
        )}
      >
        전체
      </button>
      {options.map((p) => {
        const on = value.includes(p);
        return (
          <button
            key={p}
            type="button"
            aria-pressed={on}
            onClick={() => toggle(p)}
            className={cx(
              'focus-ring inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] transition-colors',
              on ? 'border-accent bg-accent-soft font-semibold text-accent-text' : 'border-line bg-surface text-fg-2 hover:text-fg',
            )}
          >
            <span aria-hidden className="inline-block size-2 rounded-full" style={{ background: platformColor(p) }} />
            {platformLabel(p)}
            {counts?.[p] !== undefined ? <span className="text-xs text-fg-3 tabular">{counts[p]!.toLocaleString('ko-KR')}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
