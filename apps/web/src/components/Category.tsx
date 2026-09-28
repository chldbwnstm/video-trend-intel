/**
 * CategoryChip: a taxonomy id as a labeled chip (optionally a link / removable).
 * CategoryPicker: searchable taxonomy tree (from @vti/core TAXONOMY) with multi-select checkboxes.
 * Selecting a node means "this node and all its descendants" (VideoQuery.categories semantics).
 */
import { useId, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, FolderTree, X } from 'lucide-react';
import { cx } from '../lib/cx.ts';
import { catLabel, taxonomyTree } from '../lib/display.ts';
import type { TaxonomyTreeNode } from '../lib/display.ts';
import { textMatchesSafe } from '../lib/search.ts';
import { Popover } from './Overlay.tsx';

/* ------------------------------------------------------------------------------------------ chip */

export interface CategoryChipProps {
  id: string;
  /** Router path (e.g. hrefWith('/videos', { cats: id })) to make the chip a link. */
  to?: string;
  onRemove?: () => void;
  /** 0..1 classifier confidence, shown as a percent in the title. */
  confidence?: number;
  size?: 'xs' | 'sm';
  className?: string;
}

/** Full path label: `뷰티 › 스킨케어`. */
export function categoryPathLabel(id: string): string {
  const parts = id.split('/');
  const labels: string[] = [];
  for (let i = 1; i <= parts.length; i++) labels.push(catLabel(parts.slice(0, i).join('/')));
  return labels.join(' › ');
}

export function CategoryChip({ id, to, onRemove, confidence, size = 'sm', className }: CategoryChipProps) {
  const label = catLabel(id);
  const title = `${categoryPathLabel(id)}${confidence !== undefined ? ` · 신뢰도 ${Math.round(confidence * 100)}%` : ''}`;
  const cls = cx(
    'inline-flex max-w-full items-center gap-1 rounded-md border border-line bg-surface-2 text-fg-2',
    size === 'xs' ? 'px-1.5 py-px text-[11px]' : 'px-2 py-0.5 text-xs',
    className,
  );
  const body = <span className="truncate">{label}</span>;
  return (
    <span className={cls} title={title}>
      {to ? (
        <Link to={to} className="focus-ring min-w-0 rounded-sm hover:text-accent-text hover:underline">
          {body}
        </Link>
      ) : (
        body
      )}
      {onRemove ? (
        <button
          type="button"
          aria-label={`${label} 제거`}
          onClick={onRemove}
          className="focus-ring -mr-0.5 inline-flex size-4 items-center justify-center rounded-sm text-fg-3 hover:text-fg"
        >
          <X className="size-3" aria-hidden />
        </button>
      ) : null}
    </span>
  );
}

/* ------------------------------------------------------------------------------------------ picker */

function matchesNode(n: TaxonomyTreeNode, q: string): boolean {
  if (!q) return true;
  return (
    textMatchesSafe(n.label, q) ||
    textMatchesSafe(n.labelEn, q) ||
    textMatchesSafe(n.id, q) ||
    n.keywords.some((k) => textMatchesSafe(k, q))
  );
}

/** Nodes visible for a query: a node is kept if it or any descendant matches (ancestors of matches stay). */
export function filterTree(nodes: TaxonomyTreeNode[], q: string): TaxonomyTreeNode[] {
  if (!q) return nodes;
  const out: TaxonomyTreeNode[] = [];
  for (const n of nodes) {
    if (matchesNode(n, q)) {
      out.push(n);
      continue;
    }
    const kids = filterTree(n.children, q);
    if (kids.length) out.push({ ...n, children: kids });
  }
  return out;
}

function isCoveredByAncestor(id: string, selected: Set<string>): boolean {
  const parts = id.split('/');
  for (let i = 1; i < parts.length; i++) if (selected.has(parts.slice(0, i).join('/'))) return true;
  return false;
}

/** Toggle `id` in a selection, removing descendants when an ancestor gets selected. */
export function toggleCategory(value: string[], id: string): string[] {
  if (value.includes(id)) return value.filter((x) => x !== id);
  return [...value.filter((x) => !x.startsWith(`${id}/`)), id];
}

export interface CategoryPickerProps {
  value: string[];
  onChange: (ids: string[]) => void;
  /** `popover` (default): a filter button; `inline`: the tree rendered in place (e.g. a side panel). */
  variant?: 'popover' | 'inline';
  label?: string;
  /** Optional counts per taxonomy id (shown next to labels). */
  counts?: Record<string, number>;
  className?: string;
}

export function CategoryPicker({ value, onChange, variant = 'popover', label = '분야', counts, className }: CategoryPickerProps) {
  const summary =
    value.length === 0 ? '전체' : value.length === 1 ? catLabel(value[0]) : `${catLabel(value[0])} 외 ${value.length - 1}`;
  if (variant === 'inline') {
    return <CategoryTree value={value} onChange={onChange} counts={counts} label={label} className={className} />;
  }
  return (
    <Popover
      label={`${label} 선택`}
      active={value.length > 0}
      width={340}
      buttonContent={
        <>
          <FolderTree className="size-4 shrink-0 text-fg-3" aria-hidden />
          <span className="text-fg-3">{label}</span>
          <span className="truncate font-medium">{summary}</span>
        </>
      }
    >
      {() => <CategoryTree value={value} onChange={onChange} counts={counts} label={label} />}
    </Popover>
  );
}

function CategoryTree({
  value,
  onChange,
  counts,
  label,
  className,
}: {
  value: string[];
  onChange: (ids: string[]) => void;
  counts?: Record<string, number>;
  label: string;
  className?: string;
}) {
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(value.map((v) => v.split('/')[0])));
  const tree = taxonomyTree();
  const visible = useMemo(() => filterTree(tree, q.trim()), [tree, q]);
  const selected = useMemo(() => new Set(value), [value]);
  const searchId = useId();

  const toggleExpand = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const renderNode = (n: TaxonomyTreeNode, depth: number) => {
    const isOpen = q.trim() !== '' || expanded.has(n.id);
    const covered = isCoveredByAncestor(n.id, selected);
    const checked = selected.has(n.id) || covered;
    return (
      <li key={n.id}>
        <div className="flex items-center gap-1 rounded-md pr-2 hover:bg-surface-2" style={{ paddingLeft: depth * 16 + 4 }}>
          {n.children.length ? (
            <button
              type="button"
              aria-label={`${n.label} ${isOpen ? '접기' : '펼치기'}`}
              aria-expanded={isOpen}
              onClick={() => toggleExpand(n.id)}
              className="focus-ring inline-flex size-6 shrink-0 items-center justify-center rounded text-fg-3 hover:text-fg"
            >
              <ChevronRight className={cx('size-4 transition-transform', isOpen && 'rotate-90')} aria-hidden />
            </button>
          ) : (
            <span className="inline-block size-6 shrink-0" aria-hidden />
          )}
          <label className={cx('flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-1.5 text-sm', covered && 'cursor-default text-fg-3')}>
            <input
              type="checkbox"
              checked={checked}
              disabled={covered}
              onChange={() => onChange(toggleCategory(value, n.id))}
              className="focus-ring size-4 shrink-0 accent-[var(--accent)]"
            />
            <span className="min-w-0 truncate">{n.label}</span>
            {covered ? <span className="text-[11px] text-fg-3">상위 분야에 포함</span> : null}
          </label>
          {counts?.[n.id] !== undefined ? <span className="shrink-0 text-xs text-fg-3 tabular">{counts[n.id].toLocaleString('ko-KR')}</span> : null}
        </div>
        {n.children.length && isOpen ? <ul role="group">{n.children.map((c) => renderNode(c, depth + 1))}</ul> : null}
      </li>
    );
  };

  return (
    <div className={cx('flex flex-col', className)}>
      <div className="sticky top-0 z-10 border-b border-line bg-surface p-2">
        <label htmlFor={searchId} className="sr-only">
          {label} 검색
        </label>
        <input
          id={searchId}
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="분야 검색 (예: 뷰티, skincare)"
          className="focus-ring h-8 w-full rounded-md border border-line bg-surface px-2.5 text-sm text-fg placeholder:text-fg-3"
        />
        {value.length ? (
          <div className="mt-2 flex flex-wrap items-center gap-1">
            {value.map((id) => (
              <CategoryChip key={id} id={id} size="xs" onRemove={() => onChange(value.filter((x) => x !== id))} />
            ))}
            <button type="button" onClick={() => onChange([])} className="focus-ring ml-auto rounded-sm text-xs text-accent-text hover:underline">
              선택 해제
            </button>
          </div>
        ) : null}
      </div>
      {visible.length ? (
        <ul aria-label={`${label} 목록`} className="p-1">
          {visible.map((n) => renderNode(n, 0))}
        </ul>
      ) : (
        <p className="p-4 text-center text-sm text-fg-3">일치하는 분야 없음</p>
      )}
    </div>
  );
}
