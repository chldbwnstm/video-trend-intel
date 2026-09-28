/**
 * Display helpers over @vti/core that must never take the page down: time formatting in the selected
 * zone and taxonomy labels. They delegate to core and only fall back to a plain Intl rendering / the raw
 * id if core throws (e.g. an unknown id), so a label problem degrades to a less pretty label, not a crash.
 */
import { categoryLabel, formatInTz, TAXONOMY, TOP_LEVEL_CATEGORY_IDS } from '@vti/core';
import type { TaxonomyNode } from '@vti/core';

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function intlParts(ms: number, tz: string): Record<string, string> {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const out: Record<string, string> = {};
  for (const p of parts) out[p.type] = p.value;
  return out;
}

function fallbackFormat(ms: number, tz: string, style: 'date' | 'datetime' | 'time'): string {
  const p = intlParts(ms, tz);
  const date = `${p.year}-${p.month}-${p.day}`;
  const time = `${pad(Number(p.hour) % 24)}:${p.minute}`;
  return style === 'date' ? date : style === 'time' ? time : `${date} ${time}`;
}

/** `2026-09-28 14:05` in `tz`. `—` for null. */
export function fmtTime(ms: number | null | undefined, tz: string, style: 'date' | 'datetime' | 'time' = 'datetime'): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  try {
    return formatInTz(ms, tz, style);
  } catch {
    try {
      return fallbackFormat(ms, tz, style);
    } catch {
      return new Date(ms).toISOString();
    }
  }
}

/** Korean label of a taxonomy id; falls back to the id. */
export function catLabel(id: string): string {
  try {
    return categoryLabel(id, 'ko') || id;
  } catch {
    return id;
  }
}

let langNames: Intl.DisplayNames | null | undefined;
let regionNames: Intl.DisplayNames | null | undefined;

/** Korean name of an ISO 639-1 language code (`ko` -> `한국어`); null -> `언어 미상`. */
export function languageLabel(code: string | null | undefined): string {
  if (!code) return '언어 미상';
  try {
    langNames ??= new Intl.DisplayNames(['ko'], { type: 'language' });
    return langNames.of(code) ?? code;
  } catch {
    return code;
  }
}

/** Korean name of a source-reported country code (`KR` -> `대한민국`); null -> `국가 미제공`. */
export function countryLabel(code: string | null | undefined): string {
  if (!code) return '국가 미제공';
  try {
    regionNames ??= new Intl.DisplayNames(['ko'], { type: 'region' });
    return regionNames.of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

export const FORMAT_LABELS: Record<'short' | 'long' | 'live' | 'unknown', string> = {
  short: '쇼츠·숏폼',
  long: '일반 영상',
  live: '라이브',
  unknown: '형식 미상',
};

/** Top-level id of a taxonomy id (`beauty/skincare` -> `beauty`). */
export function topCategoryOf(id: string): string {
  const i = id.indexOf('/');
  return i >= 0 ? id.slice(0, i) : id;
}

export interface TaxonomyTreeNode {
  id: string;
  label: string;
  labelEn: string;
  keywords: string[];
  children: TaxonomyTreeNode[];
}

let treeCache: TaxonomyTreeNode[] | null = null;
let treeCacheSize = -1;

/**
 * The taxonomy as a tree for pickers. Uses TAXONOMY from core; when it is empty (not loaded yet) the
 * fixed top-level ids are used so pickers still work.
 */
export function taxonomyTree(): TaxonomyTreeNode[] {
  const nodes: TaxonomyNode[] = Array.isArray(TAXONOMY) ? TAXONOMY : [];
  if (treeCache && treeCacheSize === nodes.length) return treeCache;
  let roots: TaxonomyTreeNode[];
  if (nodes.length === 0) {
    roots = TOP_LEVEL_CATEGORY_IDS.map((id) => ({ id, label: catLabel(id), labelEn: id, keywords: [], children: [] }));
  } else {
    const byId = new Map<string, TaxonomyTreeNode>();
    for (const n of nodes) {
      byId.set(n.id, { id: n.id, label: n.label?.ko || n.id, labelEn: n.label?.en || n.id, keywords: n.keywords ?? [], children: [] });
    }
    roots = [];
    for (const n of nodes) {
      const tn = byId.get(n.id)!;
      const parent = n.parent ? byId.get(n.parent) : undefined;
      if (parent) parent.children.push(tn);
      else roots.push(tn);
    }
    // Keep the canonical top-level order.
    const order = new Map<string, number>(TOP_LEVEL_CATEGORY_IDS.map((id, i) => [id, i]));
    roots.sort((a, b) => (order.get(a.id) ?? 999) - (order.get(b.id) ?? 999));
  }
  treeCache = roots;
  treeCacheSize = nodes.length;
  return roots;
}
