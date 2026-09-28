/**
 * Empty / loading / error states and the SectionBoundary error boundary.
 * Every data section should handle all three states; wrap independent sections in <SectionBoundary>
 * so one failing computation never blanks the whole page.
 */
import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { CircleAlert, Inbox, RefreshCw } from 'lucide-react';
import { cx } from '../lib/cx.ts';
import { Button, Skeleton } from './primitives.tsx';

export interface EmptyStateProps {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
  compact?: boolean;
}

export function EmptyState({ title, description, icon, action, className, compact }: EmptyStateProps) {
  return (
    <div className={cx('flex flex-col items-center justify-center text-center', compact ? 'gap-1.5 py-6' : 'gap-2 py-12', className)}>
      <span className="text-fg-3" aria-hidden>
        {icon ?? <Inbox className={compact ? 'size-6' : 'size-8'} />}
      </span>
      <p className="text-sm font-medium text-fg">{title}</p>
      {description ? <p className="max-w-md text-[13px] text-fg-3">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export interface LoadingStateProps {
  label?: string;
  /** Skeleton rows to show (0 = spinner only). */
  rows?: number;
  className?: string;
}

export function LoadingState({ label = '불러오는 중', rows = 0, className }: LoadingStateProps) {
  return (
    <div role="status" aria-live="polite" className={cx('flex flex-col gap-2', rows ? 'py-2' : 'items-center py-10', className)}>
      {rows ? (
        <>
          <span className="sr-only">{label}</span>
          {Array.from({ length: rows }, (_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </>
      ) : (
        <span className="inline-flex items-center gap-2 text-sm text-fg-3">
          <RefreshCw className="size-4 animate-spin" aria-hidden />
          {label}
        </span>
      )}
    </div>
  );
}

export interface ErrorStateProps {
  title?: ReactNode;
  error?: unknown;
  description?: ReactNode;
  onRetry?: () => void;
  action?: ReactNode;
  className?: string;
  compact?: boolean;
}

export function errorText(error: unknown): string {
  if (!error) return '';
  if (error instanceof Error) return error.message;
  return String(error);
}

export function ErrorState({ title = '문제가 생겼음', error, description, onRetry, action, className, compact }: ErrorStateProps) {
  const msg = errorText(error);
  return (
    <div role="alert" className={cx('flex flex-col items-center justify-center gap-2 text-center', compact ? 'py-6' : 'py-12', className)}>
      <CircleAlert className={cx('text-negative', compact ? 'size-6' : 'size-8')} aria-hidden />
      <p className="text-sm font-medium text-fg">{title}</p>
      {description ? <p className="max-w-md text-[13px] text-fg-3">{description}</p> : null}
      {msg ? (
        <p className="max-w-md rounded-md bg-surface-2 px-2 py-1 font-mono text-xs break-all text-fg-3">{msg}</p>
      ) : null}
      <div className="mt-2 flex flex-wrap justify-center gap-2">
        {onRetry ? (
          <Button size="sm" icon={<RefreshCw className="size-3.5" aria-hidden />} onClick={onRetry}>
            다시 시도
          </Button>
        ) : null}
        {action}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ boundary */

export interface SectionBoundaryProps {
  children: ReactNode;
  /** Title shown in the error state (Korean), e.g. `상위 영상을 계산하지 못함`. */
  title?: string;
  /** Change this value to reset the boundary (e.g. the route path or the query key). */
  resetKey?: unknown;
  /** Custom fallback. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
  compact?: boolean;
}

interface BoundaryState {
  error: Error | null;
  resetKey: unknown;
}

/** Error boundary for one page section. Shows an ErrorState with retry instead of crashing the page. */
export class SectionBoundary extends Component<SectionBoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null, resetKey: undefined };

  static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  static getDerivedStateFromProps(props: SectionBoundaryProps, state: BoundaryState): Partial<BoundaryState> | null {
    if (props.resetKey !== state.resetKey) return { resetKey: props.resetKey, error: null };
    return null;
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep the stack in the console for developers; the UI shows a short message.
    console.error('[SectionBoundary]', this.props.title ?? '', error, info.componentStack);
  }

  reset = () => this.setState({ error: null });

  render(): ReactNode {
    const { error } = this.state;
    if (error) {
      if (this.props.fallback) return this.props.fallback(error, this.reset);
      return <ErrorState title={this.props.title ?? '이 영역을 표시하지 못함'} error={error} onRetry={this.reset} compact={this.props.compact} />;
    }
    return this.props.children;
  }
}
