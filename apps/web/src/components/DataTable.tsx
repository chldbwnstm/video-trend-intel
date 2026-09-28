/**
 * Data table with sticky header, optional sortable columns (aria-sort), horizontal scroll inside its own
 * container (the page never scrolls sideways), responsive column hiding and a "stale" dimmed state while a
 * deferred recomputation is pending.
 */
import type { ReactNode } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { cx } from '../lib/cx.ts';
import { InfoTip } from './Tooltip.tsx';

export type SortDir = 'asc' | 'desc';

export interface Column<R> {
  id: string;
  header: ReactNode;
  cell: (row: R, index: number) => ReactNode;
  align?: 'left' | 'right' | 'center';
  /** CSS width, e.g. `7rem`. */
  width?: string;
  /** Makes the header a sort button for this key. */
  sortKey?: string;
  /** Default direction when this column is first selected (default desc). */
  sortFirstDir?: SortDir;
  /** Explanation shown in an ⓘ tooltip next to the header. */
  hint?: ReactNode;
  /** Hide the column below a breakpoint. */
  hideBelow?: 'sm' | 'md' | 'lg';
  className?: string;
  headerClassName?: string;
}

export interface DataTableProps<R> {
  columns: Column<R>[];
  rows: R[];
  rowKey: (row: R, index: number) => string;
  /** Screen-reader caption describing the table. */
  caption: string;
  sort?: { key: string; dir: SortDir } | null;
  onSortChange?: (key: string, dir: SortDir) => void;
  /** Max height of the scroll area; the header sticks while scrolling (e.g. `70vh`). */
  maxHeight?: string;
  /** Mouse convenience only: a focusable element in the row must offer the same action. */
  onRowClick?: (row: R) => void;
  selectedKey?: string | null;
  empty?: ReactNode;
  dense?: boolean;
  /** Dim the rows (previous result shown while a new one is computed). */
  stale?: boolean;
  className?: string;
  /** Minimum table width before horizontal scrolling kicks in (default 640px). */
  minWidth?: string;
}

const HIDE: Record<NonNullable<Column<unknown>['hideBelow']>, string> = {
  sm: 'hidden sm:table-cell',
  md: 'hidden md:table-cell',
  lg: 'hidden lg:table-cell',
};

const ALIGN = { left: 'text-left', right: 'text-right', center: 'text-center' } as const;

export function DataTable<R>({
  columns,
  rows,
  rowKey,
  caption,
  sort,
  onSortChange,
  maxHeight,
  onRowClick,
  selectedKey,
  empty,
  dense,
  stale,
  className,
  minWidth = '640px',
}: DataTableProps<R>) {
  const pad = dense ? 'px-3 py-1.5' : 'px-3 py-2.5';
  return (
    <div
      className={cx('scroll-thin relative max-w-full overflow-auto', className)}
      style={maxHeight ? { maxHeight } : undefined}
      aria-busy={stale || undefined}
    >
      <table className="w-full border-separate border-spacing-0 text-sm" style={{ minWidth }}>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => {
              const active = sort && c.sortKey && sort.key === c.sortKey;
              const ariaSort = active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : c.sortKey ? 'none' : undefined;
              const align = c.align ?? 'left';
              return (
                <th
                  key={c.id}
                  scope="col"
                  aria-sort={ariaSort}
                  style={c.width ? { width: c.width } : undefined}
                  className={cx(
                    'sticky top-0 z-10 border-b border-line bg-surface-2 text-xs font-medium whitespace-nowrap text-fg-3',
                    pad,
                    ALIGN[align],
                    c.hideBelow && HIDE[c.hideBelow],
                    c.headerClassName,
                  )}
                >
                  <span className={cx('inline-flex items-center gap-1', align === 'right' && 'flex-row-reverse')}>
                    {c.sortKey && onSortChange ? (
                      <button
                        type="button"
                        onClick={() => {
                          const dir: SortDir = active ? (sort!.dir === 'desc' ? 'asc' : 'desc') : (c.sortFirstDir ?? 'desc');
                          onSortChange(c.sortKey!, dir);
                        }}
                        className={cx(
                          'focus-ring inline-flex items-center gap-1 rounded-sm hover:text-fg',
                          active && 'text-fg',
                          align === 'right' && 'flex-row-reverse',
                        )}
                      >
                        <span>{c.header}</span>
                        {active ? (
                          sort!.dir === 'desc' ? (
                            <ArrowDown className="size-3.5" aria-hidden />
                          ) : (
                            <ArrowUp className="size-3.5" aria-hidden />
                          )
                        ) : (
                          <ArrowUpDown className="size-3.5 opacity-40" aria-hidden />
                        )}
                      </button>
                    ) : (
                      <span>{c.header}</span>
                    )}
                    {c.hint ? <InfoTip label={`${typeof c.header === 'string' ? c.header : ''} 설명`}>{c.hint}</InfoTip> : null}
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className={cx('transition-opacity', stale && 'opacity-60')}>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-3 py-2">
                {empty ?? <p className="py-8 text-center text-sm text-fg-3">결과 없음</p>}
              </td>
            </tr>
          ) : (
            rows.map((row, i) => {
              const key = rowKey(row, i);
              const selected = selectedKey !== undefined && selectedKey === key;
              return (
                <tr
                  key={key}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  data-selected={selected || undefined}
                  className={cx(
                    'group',
                    onRowClick && 'cursor-pointer',
                    selected ? 'bg-accent-soft' : 'hover:bg-surface-2',
                  )}
                >
                  {columns.map((c) => (
                    <td
                      key={c.id}
                      className={cx(
                        'border-b border-line align-middle text-fg',
                        pad,
                        ALIGN[c.align ?? 'left'],
                        c.align === 'right' && 'tabular',
                        c.hideBelow && HIDE[c.hideBelow],
                        c.className,
                      )}
                    >
                      {c.cell(row, i)}
                    </td>
                  ))}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
