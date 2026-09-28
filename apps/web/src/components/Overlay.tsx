/**
 * Drawer (side sheet), Modal (centered dialog) and Popover (anchored panel).
 * All are portal-rendered, close on Escape, restore focus to the opener, and trap Tab inside modal
 * surfaces (Drawer / Modal).
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, X } from 'lucide-react';
import { cx } from '../lib/cx.ts';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.hasAttribute('data-focus-skip'));
}

let scrollLocks = 0;
function lockScroll(): () => void {
  if (typeof document === 'undefined') return () => undefined;
  scrollLocks++;
  const prev = document.body.style.overflow;
  if (scrollLocks === 1) document.body.style.overflow = 'hidden';
  return () => {
    scrollLocks = Math.max(0, scrollLocks - 1);
    if (scrollLocks === 0) document.body.style.overflow = prev;
  };
}

/** Focus management shared by Drawer and Modal. */
function useModalFocus(open: boolean, panelRef: RefObject<HTMLElement | null>, onClose: () => void, initialFocusRef?: RefObject<HTMLElement | null>) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const unlock = lockScroll();
    const panel = panelRef.current;
    const first = initialFocusRef?.current ?? (panel ? focusables(panel)[0] : null) ?? panel;
    first?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key === 'Tab' && panelRef.current) {
        const items = focusables(panelRef.current);
        if (items.length === 0) {
          e.preventDefault();
          return;
        }
        const firstEl = items[0];
        const lastEl = items[items.length - 1];
        if (e.shiftKey && document.activeElement === firstEl) {
          e.preventDefault();
          lastEl.focus();
        } else if (!e.shiftKey && document.activeElement === lastEl) {
          e.preventDefault();
          firstEl.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      unlock();
      if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus({ preventScroll: true });
    };
  }, [open, panelRef, initialFocusRef]);
}

/* ------------------------------------------------------------------------------------------ Drawer */

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  side?: 'right' | 'left';
  /** CSS width (default min(640px, 100vw)). */
  width?: string;
  children: ReactNode;
  footer?: ReactNode;
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Hide the visible header (title still labels the dialog for screen readers); the close button floats top-right. */
  bare?: boolean;
  className?: string;
  /** Extra classes for the close button (e.g. colors on a dark panel). */
  closeClassName?: string;
}

export function Drawer({ open, onClose, title, description, side = 'right', width, children, footer, initialFocusRef, bare, className, closeClassName }: DrawerProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const descId = useId();
  useModalFocus(open, panelRef, onClose, initialFocusRef);
  if (!open || typeof document === 'undefined') return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex" style={{ justifyContent: side === 'right' ? 'flex-end' : 'flex-start' }}>
      <div className="absolute inset-0 bg-[var(--overlay)]" onClick={onClose} aria-hidden />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={cx(
          'relative flex h-full max-w-full flex-col border-line shadow-pop outline-none',
          // Default background unless the caller supplies its own (utility order would otherwise decide).
          !/(^|\s)bg-/.test(className ?? '') && 'bg-surface',
          side === 'right' ? 'border-l' : 'border-r',
          className,
        )}
        style={{ width: width ?? 'min(640px, 100vw)' }}
      >
        <div className={cx('flex items-start gap-3', bare ? 'absolute top-3 right-2 z-10' : 'border-b border-line px-4 py-3')}>
          <div className={cx('min-w-0 flex-1', bare && 'sr-only')}>
            <h2 id={titleId} className="text-base font-semibold text-fg">
              {title}
            </h2>
            {description ? (
              <p id={descId} className="mt-0.5 text-[13px] text-fg-3">
                {description}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="닫기"
            className={cx(
              'focus-ring inline-flex size-8 shrink-0 items-center justify-center rounded-md text-fg-2 hover:bg-surface-3',
              closeClassName,
            )}
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer ? <div className="border-t border-line px-4 py-3">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------------------------------ Modal */

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** CSS max width (default 560px). */
  maxWidth?: string;
  initialFocusRef?: RefObject<HTMLElement | null>;
}

export function Modal({ open, onClose, title, description, children, footer, maxWidth = '560px', initialFocusRef }: ModalProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const descId = useId();
  useModalFocus(open, panelRef, onClose, initialFocusRef);
  if (!open || typeof document === 'undefined') return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-6">
      <div className="absolute inset-0 bg-[var(--overlay)]" onClick={onClose} aria-hidden />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className="relative flex max-h-[90vh] w-full flex-col rounded-t-xl border border-line bg-surface shadow-pop outline-none sm:rounded-xl"
        style={{ maxWidth }}
      >
        <div className="flex items-start gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-base font-semibold text-fg">
              {title}
            </h2>
            {description ? (
              <p id={descId} className="mt-0.5 text-[13px] text-fg-3">
                {description}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="닫기"
            className="focus-ring inline-flex size-8 shrink-0 items-center justify-center rounded-md text-fg-2 hover:bg-surface-3"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>
        {footer ? <div className="flex justify-end gap-2 border-t border-line px-4 py-3">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------------------------------ Popover */

export interface PopoverProps {
  /** Accessible label of the panel (and of the trigger when `buttonContent` is not text). */
  label: string;
  /** Content of the trigger button. */
  buttonContent: ReactNode;
  buttonClassName?: string;
  /** Panel content; receives `close()`. */
  children: (close: () => void) => ReactNode;
  align?: 'start' | 'end';
  /** Panel width in px (default: max(trigger width, 280)). */
  width?: number;
  /** Show the chevron in the trigger. Default true. */
  chevron?: boolean;
  /** Highlight the trigger (e.g. when a filter is active). */
  active?: boolean;
  disabled?: boolean;
}

/** Anchored, non-modal panel (filters, pickers). Closes on outside click and Escape. */
export function Popover({ label, buttonContent, buttonClassName, children, align = 'start', width, chevron = true, active, disabled }: PopoverProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const panelId = useId();

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  }, []);

  const place = useCallback(() => {
    const t = triggerRef.current;
    if (!t) return;
    const r = t.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = Math.min(width ?? Math.max(r.width, 280), vw - 16);
    let left = align === 'end' ? r.right - w : r.left;
    left = Math.max(8, Math.min(left, vw - w - 8));
    const below = vh - r.bottom - 12;
    const above = r.top - 12;
    const panelH = panelRef.current?.offsetHeight ?? 320;
    if (below >= Math.min(panelH, 320) || below >= above) {
      setPos({ top: r.bottom + 4, left, width: w, maxHeight: Math.max(160, below) });
    } else {
      const maxHeight = Math.max(160, above);
      setPos({ top: Math.max(8, r.top - 4 - Math.min(panelH, maxHeight)), left, width: w, maxHeight });
    }
  }, [align, width]);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    place();
    const onMove = () => place();
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, place, close]);

  // Move focus into the panel when it opens.
  useEffect(() => {
    if (open && pos && panelRef.current && !panelRef.current.contains(document.activeElement)) {
      const first = focusables(panelRef.current)[0];
      first?.focus({ preventScroll: true });
    }
  }, [open, pos]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((o) => !o)}
        className={cx(
          'focus-ring inline-flex h-9 max-w-full items-center gap-1.5 rounded-md border px-3 text-sm whitespace-nowrap transition-colors disabled:opacity-50',
          active ? 'border-accent bg-accent-soft text-accent-text' : 'border-line bg-surface text-fg hover:bg-surface-3',
          buttonClassName,
        )}
      >
        <span className="flex min-w-0 items-center gap-1.5 truncate">{buttonContent}</span>
        {chevron ? <ChevronDown className={cx('size-4 shrink-0 transition-transform', open && 'rotate-180')} aria-hidden /> : null}
      </button>
      {open && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={panelRef}
              id={panelId}
              role="dialog"
              aria-label={label}
              style={{
                position: 'fixed',
                top: pos?.top ?? -9999,
                left: pos?.left ?? -9999,
                width: pos?.width,
                maxHeight: pos?.maxHeight,
                visibility: pos ? 'visible' : 'hidden',
              }}
              className="scroll-thin z-[60] overflow-y-auto rounded-lg border border-line bg-surface shadow-pop"
            >
              {children(close)}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
