/**
 * 분류 체계 (ContentGraph-lite) page logic: per-node video counts and period views over the TAXONOMY tree,
 * plus a node detail (top topics, sample videos, classification evidence, source-category mappings).
 * Pure functions over the dataset index; tested in taxonomy.test.ts.
 *
 * Period views are core `queryVideos` metrics summed with core `sumIncrements` (lower bound when some
 * videos could not be measured, decreases excluded). Counts are plain counts of our own records.
 */
import { ancestorsOf, normalizeText, queryVideos, sumIncrements, TAXONOMY, taxonomyById } from '@vti/core';
import type {
  CategoryAssignment,
  DatasetIndex,
  DateMode,
  Evidence,
  LocalDateRange,
  MetricValue,
  Platform,
  QueryResult,
  UtcWindow,
  Video,
  VideoQuery,
  VideoRow,
} from '@vti/core';
import { cached, stableStringify } from '../../lib/cache.ts';
import { orderPlatforms } from '../../lib/platform.ts';

export type TaxonomyDateMode = Extract<DateMode, 'upload' | 'activity'>;
export const TAXONOMY_DATE_MODES: TaxonomyDateMode[] = ['activity', 'upload'];
export type AssignmentMethod = CategoryAssignment['by'];
export const METHODS: AssignmentMethod[] = ['source', 'account', 'rule', 'manual'];

export const METHOD_LABELS: Record<AssignmentMethod, string> = {
  source: '원천 분류 매핑',
  account: '계정·채널 시드',
  rule: '키워드 규칙',
  manual: '수동 지정',
};

export const EVIDENCE_FIELD_LABELS: Record<Evidence['field'], string> = {
  title: '제목',
  tags: '태그',
  description: '설명',
  sourceCategory: '원천 분류',
  account: '계정 시드',
  manual: '수동',
};

export interface TaxonomyStatsInput {
  mode: TaxonomyDateMode;
  range: LocalDateRange;
  rollingHours: number | null;
  tz: string;
  now: number;
  platforms?: Platform[];
}

export interface NodeStats {
  id: string;
  /** Tracked videos (known at `now`, platform filter applied) assigned to the node or a descendant. */
  videos: number;
  /** Of those, published inside the window. */
  uploads: number;
  /** Sum of `viewsPeriod` over the query rows in the node (sumIncrements semantics). */
  views: MetricValue;
  /** Rows whose increment was measured (exact / interpolated / source_reported). */
  measured: number;
  /** Rows whose increment is a lower bound or could not be computed (the sum is then a lower bound). */
  incomplete: number;
  platforms: Platform[];
}

export interface TaxonomyStats {
  window: UtcWindow | null;
  notes: string[];
  /** Tracked videos in scope. */
  scopeVideos: number;
  categorized: number;
  uncategorized: number;
  nodes: Record<string, NodeStats>;
  /** Number of category assignments by method (a video can have several). */
  assignmentsByMethod: Record<AssignmentMethod, number>;
  /** Videos whose assignments include each method at least once. */
  videosByMethod: Record<AssignmentMethod, number>;
  /** Distinct classifier versions found on the assignments. */
  versions: string[];
  /** Category ids present in the data but not in the current TAXONOMY. */
  unknownIds: string[];
}

/* ------------------------------------------------------------------------------------------ helpers */

function cachedQuery(index: DatasetIndex, q: VideoQuery): QueryResult {
  return cached(index, `queryVideos\u0000${stableStringify(q)}`, () => queryVideos(index, q));
}

export function taxonomyQuery(input: TaxonomyStatsInput): VideoQuery {
  return {
    dateMode: input.mode,
    range: input.range,
    rollingHours: input.rollingHours ?? undefined,
    tz: input.tz,
    now: input.now,
    platforms: input.platforms && input.platforms.length ? input.platforms : undefined,
    sort: 'views_period',
    sortDir: 'desc',
  };
}

const nodeSetCache = new WeakMap<Video, string[]>();

/** Every taxonomy id a video counts toward: its assigned ids and their ancestors (known ids only). */
export function nodeIdsOf(v: Video): string[] {
  const hit = nodeSetCache.get(v);
  if (hit) return hit;
  const known = taxonomyById();
  const out = new Set<string>();
  for (const c of v.categories ?? []) {
    if (!known.has(c.id)) continue;
    for (const a of ancestorsOf(c.id)) out.add(a);
  }
  const list = [...out];
  nodeSetCache.set(v, list);
  return list;
}

function isMeasured(m: MetricValue): boolean {
  return (m.status === 'exact' || m.status === 'interpolated' || m.status === 'source_reported') && typeof m.value === 'number';
}

function strip(m: MetricValue): MetricValue {
  return { value: m.value, status: m.status, asOf: m.asOf, note: m.note };
}

function scopeVideos(index: DatasetIndex, input: TaxonomyStatsInput): Video[] {
  const platforms = input.platforms && input.platforms.length ? new Set(input.platforms) : null;
  return index.dataset.videos.filter((v) => (!platforms || platforms.has(v.platform)) && v.publishedAt <= input.now && v.firstSeenAt <= input.now);
}

/* ------------------------------------------------------------------------------------------ stats */

export function computeTaxonomyStats(index: DatasetIndex, input: TaxonomyStatsInput): TaxonomyStats {
  const query = taxonomyQuery(input);
  const result = cachedQuery(index, query);
  const w = result.window;
  const upStart = w ? w.startMs : -Infinity;
  const upEnd = w ? Math.min(w.endMs, input.now + 1) : -Infinity;

  const known = taxonomyById();
  const acc = new Map<string, { videos: number; uploads: number; values: MetricValue[]; measured: number; incomplete: number; platforms: Set<Platform> }>();
  const get = (id: string) => {
    let a = acc.get(id);
    if (!a) {
      a = { videos: 0, uploads: 0, values: [], measured: 0, incomplete: 0, platforms: new Set() };
      acc.set(id, a);
    }
    return a;
  };

  const assignmentsByMethod: Record<AssignmentMethod, number> = { source: 0, account: 0, rule: 0, manual: 0 };
  const videosByMethod: Record<AssignmentMethod, number> = { source: 0, account: 0, rule: 0, manual: 0 };
  const versions = new Set<string>();
  const unknown = new Set<string>();

  const scope = scopeVideos(index, input);
  let categorized = 0;
  for (const v of scope) {
    const ids = nodeIdsOf(v);
    if (ids.length) categorized++;
    const seen = new Set<AssignmentMethod>();
    for (const c of v.categories ?? []) {
      if (!known.has(c.id)) unknown.add(c.id);
      if (c.by in assignmentsByMethod) {
        assignmentsByMethod[c.by]++;
        seen.add(c.by);
      }
      if (c.version) versions.add(c.version);
    }
    for (const m of seen) videosByMethod[m]++;
    const uploaded = v.publishedAt >= upStart && v.publishedAt < upEnd;
    for (const id of ids) {
      const a = get(id);
      a.videos++;
      if (uploaded) a.uploads++;
    }
  }

  for (const r of result.rows) {
    const ids = nodeIdsOf(r.video);
    if (!ids.length) continue;
    const m = r.metrics.viewsPeriod;
    const measured = isMeasured(m);
    const notProvided = m.status === 'unavailable' && m.note === 'counter_not_provided';
    for (const id of ids) {
      const a = get(id);
      a.values.push(m);
      a.platforms.add(r.video.platform);
      if (measured) a.measured++;
      else if (m.status !== 'decrease_flagged' && !notProvided) a.incomplete++;
    }
  }

  const nodes: Record<string, NodeStats> = {};
  for (const n of TAXONOMY) {
    const a = acc.get(n.id);
    nodes[n.id] = a
      ? {
          id: n.id,
          videos: a.videos,
          uploads: a.uploads,
          views: a.values.length ? strip(sumIncrements(a.values)) : { value: 0, status: 'exact', asOf: null, note: 'no_tracked_videos' },
          measured: a.measured,
          incomplete: a.incomplete,
          platforms: orderPlatforms(a.platforms),
        }
      : { id: n.id, videos: 0, uploads: 0, views: { value: 0, status: 'exact', asOf: null, note: 'no_tracked_videos' }, measured: 0, incomplete: 0, platforms: [] };
  }

  return {
    window: w,
    notes: result.notes,
    scopeVideos: scope.length,
    categorized,
    uncategorized: scope.length - categorized,
    nodes,
    assignmentsByMethod,
    videosByMethod,
    versions: [...versions].sort(),
    unknownIds: [...unknown].sort(),
  };
}

/* ------------------------------------------------------------------------------------------ tree rows */

export type TreeSort = 'videos' | 'uploads' | 'views' | 'taxonomy';
export const TREE_SORTS: TreeSort[] = ['videos', 'uploads', 'views', 'taxonomy'];

export interface TreeRow {
  id: string;
  depth: number;
  parent: string | null;
  childCount: number;
  expanded: boolean;
  stats: NodeStats;
}

function rankOf(m: MetricValue): number | null {
  if (m.status === 'unavailable' || m.status === 'decrease_flagged') return null;
  return typeof m.value === 'number' && Number.isFinite(m.value) ? m.value : null;
}

/**
 * Visible rows of the tree: top-level nodes sorted, children of expanded nodes under their parent.
 * With `filter` (e.g. from searchNodes) only those nodes are shown and every one of them is expanded.
 */
export function flattenTree(
  stats: TaxonomyStats,
  expanded: ReadonlySet<string>,
  sort: TreeSort,
  dir: 'asc' | 'desc' = 'desc',
  filter: ReadonlySet<string> | null = null,
): TreeRow[] {
  const children = new Map<string | null, string[]>();
  const order = new Map<string, number>();
  TAXONOMY.forEach((n, i) => {
    order.set(n.id, i);
    const list = children.get(n.parent);
    if (list) list.push(n.id);
    else children.set(n.parent, [n.id]);
  });
  const cmp = (a: string, b: string): number => {
    const sa = stats.nodes[a];
    const sb = stats.nodes[b];
    const tax = (order.get(a) ?? 0) - (order.get(b) ?? 0);
    if (sort === 'taxonomy') return dir === 'asc' ? -tax || 0 : tax;
    let d: number;
    if (sort === 'views') {
      const x = rankOf(sa.views);
      const y = rankOf(sb.views);
      if (x === null && y === null) d = 0;
      else if (x === null) return 1;
      else if (y === null) return -1;
      else d = y - x;
    } else {
      d = sort === 'uploads' ? sb.uploads - sa.uploads : sb.videos - sa.videos;
    }
    if (dir === 'asc') d = -d;
    return d || tax;
  };
  const out: TreeRow[] = [];
  const walk = (parent: string | null, depth: number) => {
    const ids = [...(children.get(parent) ?? [])].filter((id) => !filter || filter.has(id)).sort(cmp);
    for (const id of ids) {
      const kids = (children.get(id) ?? []).filter((k) => !filter || filter.has(k));
      const isOpen = filter ? kids.length > 0 : expanded.has(id);
      out.push({ id, depth, parent, childCount: kids.length, expanded: isOpen, stats: stats.nodes[id] });
      if (isOpen && kids.length) walk(id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/* ------------------------------------------------------------------------------------------ node detail */

export interface TopicStat {
  topic: string;
  videos: number;
  views: MetricValue;
}

export interface EvidenceStat {
  field: Evidence['field'];
  match: string;
  count: number;
}

export interface SampleVideo {
  row: VideoRow;
  /** The assignment that put the video in this node (the node itself or the most specific descendant). */
  assignment: CategoryAssignment | null;
}

export interface NodeDetail {
  id: string;
  known: boolean;
  /** Rows (query scope) in the node. */
  rows: number;
  topics: TopicStat[];
  samples: SampleVideo[];
  /** Assignments of exactly this id, by method. */
  methods: Record<AssignmentMethod, number>;
  /** Most frequent evidence behind assignments of exactly this id. */
  evidence: EvidenceStat[];
  /** The node's source-category mappings with the number of tracked videos carrying each. */
  sourceCategories: { key: string; videos: number }[];
  byPlatform: { platform: Platform; videos: number; views: MetricValue }[];
  /** Average confidence of the node's own assignments (0..1), null when none. */
  meanConfidence: number | null;
}

export interface NodeDetailInput extends TaxonomyStatsInput {
  id: string;
  topicLimit?: number;
  sampleLimit?: number;
  evidenceLimit?: number;
}

export function computeNodeDetail(index: DatasetIndex, input: NodeDetailInput): NodeDetail {
  const byId = taxonomyById();
  const node = byId.get(input.id) ?? null;
  const result = cachedQuery(index, taxonomyQuery(input));
  const inNode = (v: Video) => nodeIdsOf(v).includes(input.id);
  const rows = result.rows.filter((r) => inNode(r.video));

  // Topics (query scope)
  const topicAcc = new Map<string, MetricValue[]>();
  for (const r of rows) {
    for (const t of new Set(r.video.topics ?? [])) {
      const list = topicAcc.get(t);
      if (list) list.push(r.metrics.viewsPeriod);
      else topicAcc.set(t, [r.metrics.viewsPeriod]);
    }
  }
  const topics: TopicStat[] = [...topicAcc.entries()]
    .map(([topic, values]) => ({ topic, videos: values.length, views: strip(sumIncrements(values)) }))
    .sort((a, b) => b.videos - a.videos || (rankOf(b.views) ?? -1) - (rankOf(a.views) ?? -1) || (a.topic < b.topic ? -1 : a.topic > b.topic ? 1 : 0))
    .slice(0, input.topicLimit ?? 15);

  // Samples: rankable first (rows are already sorted by views_period desc, unrankable last).
  const descendants = new Set<string>([input.id, ...TAXONOMY.filter((n) => ancestorsOf(n.id).includes(input.id)).map((n) => n.id)]);
  const samples: SampleVideo[] = rows.slice(0, input.sampleLimit ?? 6).map((row) => {
    const cands = (row.video.categories ?? []).filter((c) => descendants.has(c.id));
    // Most specific (deepest) assignment first, then highest confidence.
    cands.sort((a, b) => ancestorsOf(b.id).length - ancestorsOf(a.id).length || b.confidence - a.confidence);
    return { row, assignment: cands[0] ?? null };
  });

  // Evidence behind this node's own assignments (tracked scope, not only the query rows).
  const methods: Record<AssignmentMethod, number> = { source: 0, account: 0, rule: 0, manual: 0 };
  const evAcc = new Map<string, EvidenceStat>();
  const srcCounts = new Map<string, number>();
  const mapped = new Map((node?.sourceCategories ?? []).map((s) => [normalizeText(s), s] as const));
  let confSum = 0;
  let confN = 0;
  for (const v of scopeVideos(index, input)) {
    if (v.sourceCategory) {
      const key = mapped.get(normalizeText(v.sourceCategory));
      if (key) srcCounts.set(key, (srcCounts.get(key) ?? 0) + 1);
    }
    for (const c of v.categories ?? []) {
      if (c.id !== input.id) continue;
      if (c.by in methods) methods[c.by]++;
      confSum += c.confidence;
      confN++;
      for (const e of c.evidence) {
        const k = `${e.field}\u0000${normalizeText(e.match)}`;
        const cur = evAcc.get(k);
        if (cur) cur.count++;
        else evAcc.set(k, { field: e.field, match: e.match, count: 1 });
      }
    }
  }
  const evidence = [...evAcc.values()]
    .sort((a, b) => b.count - a.count || (a.match < b.match ? -1 : a.match > b.match ? 1 : 0))
    .slice(0, input.evidenceLimit ?? 16);

  // Per-platform sums (views are not the same unit across platforms).
  const plat = new Map<Platform, MetricValue[]>();
  for (const r of rows) {
    const list = plat.get(r.video.platform);
    if (list) list.push(r.metrics.viewsPeriod);
    else plat.set(r.video.platform, [r.metrics.viewsPeriod]);
  }
  const byPlatform = orderPlatforms(plat.keys()).map((p) => ({ platform: p, videos: plat.get(p)!.length, views: strip(sumIncrements(plat.get(p)!)) }));

  return {
    id: input.id,
    known: !!node,
    rows: rows.length,
    topics,
    samples,
    methods,
    evidence,
    sourceCategories: (node?.sourceCategories ?? []).map((key) => ({ key, videos: srcCounts.get(key) ?? 0 })),
    byPlatform,
    meanConfidence: confN ? confSum / confN : null,
  };
}

/** Node ids whose label (ko/en), id or keywords match `q` (plus their ancestors, so the tree stays navigable). */
export function searchNodes(q: string): Set<string> | null {
  const needle = normalizeText(q);
  if (!needle) return null;
  const out = new Set<string>();
  for (const n of TAXONOMY) {
    const hay = normalizeText([n.id, n.label.ko, n.label.en, ...n.keywords].join('\n'));
    if (hay.includes(needle)) for (const a of ancestorsOf(n.id)) out.add(a);
  }
  return out;
}
