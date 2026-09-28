/**
 * Basic building blocks: Button, IconButton, Card, Badge, Chip, Spinner, Skeleton, Kbd-less helpers.
 * Styling uses theme tokens (bg-surface, text-fg-2, border-line...) so dark mode works automatically.
 */
import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
import { Loader2, X } from 'lucide-react';
import { cx } from '../lib/cx.ts';

/* ------------------------------------------------------------------------------------------ Button */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  loading?: boolean;
}

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-on-accent hover:bg-accent-hover border-transparent',
  secondary: 'bg-surface text-fg border-line hover:bg-surface-3',
  ghost: 'bg-transparent text-fg-2 border-transparent hover:bg-surface-3 hover:text-fg',
  danger: 'bg-negative-soft text-negative border-transparent hover:brightness-95',
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-2.5 text-[13px] gap-1.5',
  md: 'h-9 px-3.5 text-sm gap-2',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, loading, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        'focus-ring inline-flex shrink-0 items-center justify-center rounded-md border font-medium whitespace-nowrap transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-50',
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required accessible name (Korean). */
  label: string;
  size?: 'sm' | 'md';
  variant?: 'ghost' | 'secondary';
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, size = 'md', variant = 'ghost', className, children, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={cx(
        'focus-ring inline-flex shrink-0 items-center justify-center rounded-md border transition-colors disabled:opacity-50',
        size === 'sm' ? 'size-8' : 'size-9',
        variant === 'ghost'
          ? 'border-transparent text-fg-2 hover:bg-surface-3 hover:text-fg'
          : 'border-line bg-surface text-fg-2 hover:bg-surface-3 hover:text-fg',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
});

/* ------------------------------------------------------------------------------------------ Card */

export interface CardProps extends HTMLAttributes<HTMLElement> {
  as?: 'section' | 'div' | 'article';
  /** Remove inner padding (e.g. for edge-to-edge tables). */
  flush?: boolean;
}

export function Card({ as: Tag = 'section', flush, className, children, ...rest }: CardProps) {
  return (
    <Tag className={cx('min-w-0 rounded-xl border border-line bg-surface shadow-card', !flush && 'p-4 sm:p-5', className)} {...rest}>
      {children}
    </Tag>
  );
}

export interface CardHeaderProps {
  title: ReactNode;
  /** One-line explanation under the title. */
  description?: ReactNode;
  /** Right-aligned actions (links, toggles). */
  actions?: ReactNode;
  icon?: ReactNode;
  className?: string;
  /** Heading level for document outline (default 2). */
  level?: 2 | 3;
  id?: string;
}

export function CardHeader({ title, description, actions, icon, className, level = 2, id }: CardHeaderProps) {
  const H = level === 2 ? 'h2' : 'h3';
  return (
    <div className={cx('mb-3 flex flex-wrap items-start justify-between gap-x-3 gap-y-2', className)}>
      <div className="min-w-0 flex-1">
        <H id={id} className="flex items-center gap-2 text-[15px] font-semibold text-fg">
          {icon ? <span className="text-fg-3" aria-hidden>{icon}</span> : null}
          <span className="min-w-0">{title}</span>
        </H>
        {description ? <p className="mt-0.5 text-[13px] text-fg-3">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ Badge / Chip */

export type Tone = 'neutral' | 'accent' | 'positive' | 'negative' | 'warning' | 'info';

const TONES: Record<Tone, string> = {
  neutral: 'bg-surface-3 text-fg-2',
  accent: 'bg-accent-soft text-accent-text',
  positive: 'bg-positive-soft text-positive',
  negative: 'bg-negative-soft text-negative',
  warning: 'bg-warning-soft text-warning',
  info: 'bg-info-soft text-info',
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  icon?: ReactNode;
}

/** Small non-interactive status label. Pair color with text (never color alone). */
export function Badge({ tone = 'neutral', icon, className, children, ...rest }: BadgeProps) {
  return (
    <span
      className={cx('inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap', TONES[tone], className)}
      {...rest}
    >
      {icon ? <span aria-hidden className="inline-flex">{icon}</span> : null}
      {children}
    </span>
  );
}

export interface ChipProps {
  children: ReactNode;
  /** Toggle chips: pressed state (renders aria-pressed). */
  selected?: boolean;
  onClick?: () => void;
  /** Removable chips: shows an × button with this accessible label. */
  onRemove?: () => void;
  removeLabel?: string;
  icon?: ReactNode;
  className?: string;
  title?: string;
}

/** Filter chip. Clickable (toggle) when `onClick` is set, removable when `onRemove` is set. */
export function Chip({ children, selected, onClick, onRemove, removeLabel, icon, className, title }: ChipProps) {
  const base = cx(
    'inline-flex max-w-full items-center gap-1 rounded-full border text-[13px] leading-6 transition-colors',
    selected ? 'border-accent bg-accent-soft text-accent-text' : 'border-line bg-surface text-fg-2',
    className,
  );
  const inner = (
    <>
      {icon ? <span aria-hidden className="inline-flex shrink-0">{icon}</span> : null}
      <span className="truncate">{children}</span>
    </>
  );
  return (
    <span className={cx(base, !onClick && 'px-2.5', onRemove && 'pr-1')} title={title}>
      {onClick ? (
        <button
          type="button"
          onClick={onClick}
          aria-pressed={selected ?? undefined}
          className="focus-ring inline-flex min-w-0 items-center gap-1 rounded-full px-2.5 hover:text-fg"
        >
          {inner}
        </button>
      ) : (
        inner
      )}
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={removeLabel ?? '제거'}
          className="focus-ring ml-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full text-fg-3 hover:bg-surface-3 hover:text-fg"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      ) : null}
    </span>
  );
}

/* ------------------------------------------------------------------------------------------ Spinner / Skeleton */

export function Spinner({ label = '불러오는 중', className }: { label?: string; className?: string }) {
  return (
    <span role="status" className={cx('inline-flex items-center gap-2 text-fg-3', className)}>
      <Loader2 className="size-4 animate-spin" aria-hidden />
      <span className="text-sm">{label}</span>
    </span>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden className={cx('block animate-pulse rounded-md bg-surface-3', className)} />;
}

/* ------------------------------------------------------------------------------------------ misc */

/** Horizontal scroll container for wide content inside cards (the page itself never scrolls sideways). */
export function ScrollX({ children, className, label }: { children: ReactNode; className?: string; label?: string }) {
  return (
    <div
      className={cx('scroll-thin max-w-full overflow-x-auto', className)}
      role={label ? 'region' : undefined}
      aria-label={label}
      tabIndex={label ? 0 : undefined}
    >
      {children}
    </div>
  );
}

/** Definition list row used in detail panels: label on the left, value on the right. */
export function StatRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line py-1.5 last:border-b-0">
      <dt className="text-[13px] text-fg-3">{label}</dt>
      <dd className="min-w-0 text-right text-sm text-fg">{children}</dd>
    </div>
  );
}
