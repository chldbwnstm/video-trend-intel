/**
 * Accessible tooltip: opens on hover AND keyboard focus, closes on Escape / blur / mouse leave,
 * is hoverable (pointer can move into it) and is rendered in a portal with fixed positioning so it is
 * never clipped by scrolling tables. Content must be supplementary: never gate information behind it.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Info } from 'lucide-react';
import { cx } from '../lib/cx.ts';

export interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  /** Preferred side; flips when there is no room. */
  placement?: 'top' | 'bottom';
  /** Make the trigger focusable (tabIndex=0) so keyboard users can open it. Default true. */
  focusable?: boolean;
  /** Classes for the trigger wrapper. */
  className?: string;
  /** Wrapper element (use 'div' for block content). */
  as?: 'span' | 'div';
  /** Hover delay in ms (focus opens immediately). */
  delay?: number;
  /** Max width of the bubble in px. */
  maxWidth?: number;
  /** Accessible role of the trigger when it is focusable (default: none, it only describes). */
  triggerLabel?: string;
}

interface Pos {
  top: number;
  left: number;
  side: 'top' | 'bottom';
}

const MARGIN = 8;

export function computeTooltipPosition(
  trigger: { top: number; bottom: number; left: number; width: number },
  bubble: { width: number; height: number },
  viewport: { width: number; height: number },
  placement: 'top' | 'bottom',
): Pos {
  const spaceAbove = trigger.top - MARGIN;
  const spaceBelow = viewport.height - trigger.bottom - MARGIN;
  let side: 'top' | 'bottom' = placement;
  if (placement === 'top' && spaceAbove < bubble.height + 6 && spaceBelow > spaceAbove) side = 'bottom';
  if (placement === 'bottom' && spaceBelow < bubble.height + 6 && spaceAbove > spaceBelow) side = 'top';
  const top = side === 'top' ? trigger.top - bubble.height - 6 : trigger.bottom + 6;
  let left = trigger.left + trigger.width / 2 - bubble.width / 2;
  left = Math.max(MARGIN, Math.min(left, viewport.width - bubble.width - MARGIN));
  return { top: Math.max(MARGIN, top), left, side };
}

export function Tooltip({
  content,
  children,
  placement = 'top',
  focusable = true,
  className,
  as: Tag = 'span',
  delay = 120,
  maxWidth = 320,
  triggerLabel,
}: TooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Pos | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const show = useCallback(
    (immediate = false) => {
      clear();
      if (immediate) setOpen(true);
      else timer.current = setTimeout(() => setOpen(true), delay);
    },
    [delay],
  );
  const hide = useCallback((immediate = false) => {
    clear();
    if (immediate) setOpen(false);
    else timer.current = setTimeout(() => setOpen(false), 100);
  }, []);

  useEffect(() => clear, []);

  const place = useCallback(() => {
    const t = triggerRef.current;
    const b = bubbleRef.current;
    if (!t || !b) return;
    const r = t.getBoundingClientRect();
    setPos(
      computeTooltipPosition(
        { top: r.top, bottom: r.bottom, left: r.left, width: r.width },
        { width: b.offsetWidth, height: b.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
        placement,
      ),
    );
  }, [placement]);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    place();
    const onMove = () => place();
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, place]);

  return (
    <>
      <Tag
        ref={triggerRef as never}
        className={cx(focusable && 'focus-ring cursor-help rounded-sm', className)}
        tabIndex={focusable ? 0 : undefined}
        role={triggerLabel ? 'button' : undefined}
        aria-describedby={open ? id : undefined}
        aria-label={triggerLabel}
        onClick={
          focusable
            ? () => {
                // Touch devices: a tap focuses and opens; it never toggles closed (hover/focus already opened it).
                clear();
                setOpen(true);
              }
            : undefined
        }
        onKeyDown={
          triggerLabel
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setOpen((o) => !o);
                }
              }
            : undefined
        }
        onMouseEnter={() => show()}
        onMouseLeave={() => hide()}
        onFocus={() => show(true)}
        onBlur={() => hide(true)}
      >
        {children}
      </Tag>
      {open && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={bubbleRef}
              id={id}
              role="tooltip"
              onMouseEnter={() => clear()}
              onMouseLeave={() => hide()}
              style={{
                position: 'fixed',
                top: pos?.top ?? -9999,
                left: pos?.left ?? -9999,
                maxWidth,
                visibility: pos ? 'visible' : 'hidden',
              }}
              className="z-[70] rounded-lg border border-line bg-surface px-3 py-2 text-left text-[13px] leading-relaxed font-normal text-fg shadow-pop"
            >
              {content}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

/** Small ⓘ button that shows an explanation tooltip. */
export function InfoTip({ children, label = '설명 보기', className }: { children: ReactNode; label?: string; className?: string }) {
  return (
    <Tooltip content={children} className={cx('inline-flex align-middle text-fg-3 hover:text-fg-2', className)} triggerLabel={label}>
      <Info className="size-3.5" aria-hidden />
    </Tooltip>
  );
}
