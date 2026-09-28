/**
 * GET /api/v1/taxonomy — the category tree (ContentGraph) with video counts. OWNER: server.
 */
import type { Hono } from 'hono';
import { PLATFORMS, TAXONOMY, ancestorsOf, taxonomyById } from '@vti/core';
import type { CategoryAssignment, DatasetIndex, Platform } from '@vti/core';
import { isoOf, sendJson, type RouteDeps } from './common.ts';
import { Params, parseBoolParam } from '../params.ts';

interface NodeCounts {
  /** Videos assigned exactly this id. */
  direct: number;
  /** Videos assigned this id or any descendant (each video once). */
  total: number;
  byPlatform: Partial<Record<Platform, number>>;
}

function countsFor(index: DatasetIndex) {
  const known = taxonomyById();
  const counts = new Map<string, NodeCounts>();
  const unknown = new Map<string, number>();
  const byAssigner: Record<CategoryAssignment['by'], number> = { rule: 0, source: 0, account: 0, manual: 0 };
  let categorized = 0;
  const get = (id: string) => {
    let c = counts.get(id);
    if (!c) {
      c = { direct: 0, total: 0, byPlatform: {} };
      counts.set(id, c);
    }
    return c;
  };
  for (const v of index.dataset.videos) {
    const cats = v.categories ?? [];
    if (!cats.length) continue;
    categorized++;
    const rolled = new Set<string>();
    for (const cat of cats) {
      byAssigner[cat.by] = (byAssigner[cat.by] ?? 0) + 1;
      if (!known.has(cat.id)) {
        unknown.set(cat.id, (unknown.get(cat.id) ?? 0) + 1);
        continue;
      }
      get(cat.id).direct++;
      for (const a of ancestorsOf(cat.id)) rolled.add(a);
    }
    for (const id of rolled) {
      const c = get(id);
      c.total++;
      c.byPlatform[v.platform] = (c.byPlatform[v.platform] ?? 0) + 1;
    }
  }
  return { counts, unknown, byAssigner, categorized };
}

const countsCache = new WeakMap<DatasetIndex, ReturnType<typeof countsFor>>();

function orderedByPlatform(bp: Partial<Record<Platform, number>>): Partial<Record<Platform, number>> {
  const out: Partial<Record<Platform, number>> = {};
  for (const p of PLATFORMS) if (bp[p] !== undefined) out[p] = bp[p];
  return out;
}

interface TreeNode {
  id: string;
  parent: string | null;
  label: { ko: string; en: string };
  keywords?: string[];
  sourceCategories: string[];
  counts: NodeCounts;
  children: TreeNode[];
}

/** Taxonomy payload (also written by static-api as taxonomy.json). */
export function buildTaxonomy(index: DatasetIndex, opts: { keywords?: boolean } = {}) {
  let c = countsCache.get(index);
  if (!c) {
    c = countsFor(index);
    countsCache.set(index, c);
  }
  const withKeywords = opts.keywords ?? true;
  const nodes = new Map<string, TreeNode>();
  for (const n of TAXONOMY) {
    const cnt = c.counts.get(n.id);
    nodes.set(n.id, {
      id: n.id,
      parent: n.parent,
      label: n.label,
      ...(withKeywords ? { keywords: n.keywords } : {}),
      sourceCategories: n.sourceCategories,
      counts: cnt ? { direct: cnt.direct, total: cnt.total, byPlatform: orderedByPlatform(cnt.byPlatform) } : { direct: 0, total: 0, byPlatform: {} },
      children: [],
    });
  }
  const roots: TreeNode[] = [];
  for (const n of TAXONOMY) {
    const node = nodes.get(n.id)!;
    const parent = n.parent ? nodes.get(n.parent) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const videos = index.dataset.videos.length;
  return {
    generatedAt: index.dataset.generatedAt,
    generatedAtIso: isoOf(index.dataset.generatedAt),
    classifierVersion: index.dataset.classifierVersion,
    totals: {
      videos,
      categorized: c.categorized,
      uncategorized: videos - c.categorized,
      categorizedShare: videos ? c.categorized / videos : null,
      assignmentsBy: c.byAssigner,
    },
    tree: roots,
    unknownCategoryIds: [...c.unknown.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([id, count]) => ({ id, count })),
    notes: [
      'counts.total은 해당 분야와 모든 하위 분야에 속한 영상 수(영상당 1회), counts.direct는 해당 ID가 직접 부여된 영상 수입니다.',
      '분류 근거(제목·태그·설명 키워드, 원천 카테고리, 계정 시드 분야)는 영상별 categories[].evidence에 있습니다.',
    ],
  };
}

export function registerTaxonomy(app: Hono, deps: RouteDeps): void {
  app.get('/taxonomy', (c) =>
    sendJson(c, deps, (index) => {
      const p = Params.of(c.req.url);
      const keywords = parseBoolParam(p, ['keywords'], true);
      p.done();
      return buildTaxonomy(index, { keywords });
    }),
  );
}
