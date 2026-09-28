/**
 * Dataset wire format (collector export -> web / server) and in-memory index.
 *
 * The exported file is `dataset.json` in the compact form below (`format: 2`):
 * - Observations are stored per video as columns `[t, views, likes, comments, shares, src]`:
 *   `t` holds the first instant in seconds then deltas in seconds; each counter column holds the first
 *   provided value then deltas from the previous provided value (`null` = not provided, never 0); a counter
 *   column that is entirely null is stored as `null`; `src` holds one srcTable index per point, or a single
 *   index when every point shares it.
 * - Categories are tuples `[id, confidence*1000, by, evidence[], version?]` where evidence entries are
 *   `<fieldCode>|<match>` and `version` is omitted when it equals the dataset's classifierVersion.
 * Format 1 (observation tuples `[tSeconds, views, likes, comments, shares, srcIndex]`, full category
 * objects) is still decoded.
 */
import type {
  Account,
  CategoryAssignment,
  CollectionRun,
  Creator,
  Dataset,
  Evidence,
  ObservationPoint,
  SourceCoverage,
  SourceWindowMetric,
  Video,
} from './types.ts';

/** Format-1 observation tuple. */
export type CompactObs = [number, number | null, number | null, number | null, number | null, number];
/** Format-2 observation columns. */
export type CompactObsColumns = [
  number[],
  (number | null)[] | null,
  (number | null)[] | null,
  (number | null)[] | null,
  (number | null)[] | null,
  number[],
];
export type CompactWindow = [string /* metric */, number /* windowHours */, number /* value */, number /* observedAt sec */, number /* srcIndex */];
/** [id, confidence * 1000 (int), by code, evidence `<field code>|<match>`, version (omitted = dataset classifierVersion)] */
export type CompactCategory = [string, number, number, string[]] | [string, number, number, string[], string];

export type CompactVideo = Omit<Video, 'obs' | 'sourceWindows' | 'categories'> & {
  o: CompactObs[] | CompactObsColumns;
  w?: CompactWindow[];
  /** Format 2 categories. */
  cat?: CompactCategory[];
  /** Format 1 categories. */
  categories?: CategoryAssignment[];
};

export interface CompactDataset {
  schemaVersion: 1;
  /** Wire format; absent = 1. */
  format?: 1 | 2;
  generatedAt: number;
  classifierVersion: string;
  srcTable: string[];
  videos: CompactVideo[];
  accounts: Account[];
  creators: Creator[];
  coverage: SourceCoverage[];
  runs: CollectionRun[];
  exportNotes: string[];
}

const BY_CODES: CategoryAssignment['by'][] = ['rule', 'source', 'account', 'manual'];
const FIELD_CODES: Record<Evidence['field'], string> = {
  title: 't',
  tags: 'g',
  description: 'd',
  sourceCategory: 's',
  account: 'a',
  manual: 'm',
};
const FIELD_BY_CODE: Record<string, Evidence['field']> = Object.fromEntries(
  Object.entries(FIELD_CODES).map(([k, v]) => [v, k as Evidence['field']]),
);

const COUNTERS = ['views', 'likes', 'comments', 'shares'] as const;

function encodeCounterColumn(obs: ObservationPoint[], key: (typeof COUNTERS)[number]): (number | null)[] | null {
  let last: number | null = null;
  let any = false;
  const out = obs.map((p) => {
    const x = p[key];
    if (x === null || x === undefined || !Number.isFinite(x)) return null;
    any = true;
    const enc = last === null ? x : x - last;
    last = x;
    return enc;
  });
  return any ? out : null;
}

function decodeCounterColumn(col: (number | null)[] | null | undefined, n: number): (number | null)[] {
  if (!col) return new Array<number | null>(n).fill(null);
  let last: number | null = null;
  return col.map((x) => {
    if (x === null || x === undefined) return null;
    const v: number = last === null ? x : last + x;
    last = v;
    return v;
  });
}

function encodeCategory(c: CategoryAssignment, classifierVersion: string): CompactCategory {
  const evidence = c.evidence.map((e) => `${FIELD_CODES[e.field] ?? 'm'}|${e.match}`);
  const by = Math.max(0, BY_CODES.indexOf(c.by));
  const conf = Math.round(c.confidence * 1000);
  return c.version === classifierVersion ? [c.id, conf, by, evidence] : [c.id, conf, by, evidence, c.version];
}

function decodeCategory(t: CompactCategory, classifierVersion: string): CategoryAssignment {
  return {
    id: t[0],
    confidence: t[1] / 1000,
    by: BY_CODES[t[2]] ?? 'rule',
    evidence: t[3].map((s) => {
      const bar = s.indexOf('|');
      return { field: FIELD_BY_CODE[s.slice(0, bar)] ?? 'manual', match: s.slice(bar + 1) };
    }),
    version: t[4] ?? classifierVersion,
  };
}

export function encodeDataset(ds: Dataset): CompactDataset {
  const srcTable: string[] = [];
  const srcIdx = new Map<string, number>();
  const idx = (s: string) => {
    let i = srcIdx.get(s);
    if (i === undefined) {
      i = srcTable.length;
      srcTable.push(s);
      srcIdx.set(s, i);
    }
    return i;
  };
  const videos: CompactVideo[] = ds.videos.map((v) => {
    const { obs: rawObs, sourceWindows, categories, ...rest } = v;
    const obs = [...rawObs].sort((a, b) => a.t - b.t);
    let prevT = 0;
    const t = obs.map((p, i) => {
      const s = Math.round(p.t / 1000);
      const enc = i === 0 ? s : s - prevT;
      prevT = s;
      return enc;
    });
    const srcs = obs.map((p) => idx(p.src));
    const src = srcs.length > 0 && srcs.every((x) => x === srcs[0]) ? [srcs[0]] : srcs;
    const cv: CompactVideo = {
      ...rest,
      o: [t, ...COUNTERS.map((k) => encodeCounterColumn(obs, k)), src] as CompactObsColumns,
      cat: categories.map((c) => encodeCategory(c, ds.classifierVersion)),
    };
    if (sourceWindows.length) {
      cv.w = sourceWindows.map((w) => [w.metric, w.windowHours, w.value, Math.round(w.observedAt / 1000), idx(w.src)]);
    }
    return cv;
  });
  return {
    schemaVersion: 1,
    format: 2,
    generatedAt: ds.generatedAt,
    classifierVersion: ds.classifierVersion,
    srcTable,
    videos,
    accounts: ds.accounts,
    creators: ds.creators,
    coverage: ds.coverage,
    runs: ds.runs,
    exportNotes: ds.exportNotes,
  };
}

function decodeObservations(c: CompactDataset, o: CompactVideo['o']): ObservationPoint[] {
  const src = (i: number | undefined) => (i === undefined ? 'unknown' : (c.srcTable[i] ?? 'unknown'));
  if ((c.format ?? 1) === 1) {
    return (o as CompactObs[]).map((t) => ({
      t: t[0] * 1000,
      views: t[1],
      likes: t[2],
      comments: t[3],
      shares: t[4],
      src: src(t[5]),
    }));
  }
  const [tc, vc, lc, cc, sc, kc] = o as CompactObsColumns;
  const n = tc.length;
  let acc = 0;
  const times = tc.map((d, i) => (acc = i === 0 ? d : acc + d) * 1000);
  const views = decodeCounterColumn(vc, n);
  const likes = decodeCounterColumn(lc, n);
  const comments = decodeCounterColumn(cc, n);
  const shares = decodeCounterColumn(sc, n);
  const out: ObservationPoint[] = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = {
      t: times[i],
      views: views[i],
      likes: likes[i],
      comments: comments[i],
      shares: shares[i],
      src: src(kc.length === 1 ? kc[0] : kc[i]),
    };
  }
  return out;
}

export function decodeDataset(c: CompactDataset): Dataset {
  if (c.schemaVersion !== 1) throw new Error(`Unsupported dataset schemaVersion ${String(c.schemaVersion)}`);
  const format = c.format ?? 1;
  if (format !== 1 && format !== 2) throw new Error(`Unsupported dataset format ${String(format)}`);
  const videos: Video[] = c.videos.map((cv) => {
    const { o, w, cat, categories, ...rest } = cv;
    const obs = decodeObservations(c, o);
    obs.sort((a, b) => a.t - b.t);
    const sourceWindows: SourceWindowMetric[] = (w ?? []).map((x) => ({
      metric: x[0] as SourceWindowMetric['metric'],
      windowHours: x[1],
      value: x[2],
      observedAt: x[3] * 1000,
      src: c.srcTable[x[4]] ?? 'unknown',
    }));
    const cats = cat ? cat.map((t) => decodeCategory(t, c.classifierVersion)) : (categories ?? []);
    return { ...rest, categories: cats, obs, sourceWindows };
  });
  return {
    schemaVersion: 1,
    generatedAt: c.generatedAt,
    classifierVersion: c.classifierVersion,
    videos,
    accounts: c.accounts,
    creators: c.creators,
    coverage: c.coverage,
    runs: c.runs,
    exportNotes: c.exportNotes ?? [],
  };
}

export interface DatasetIndex {
  dataset: Dataset;
  videosById: Map<string, Video>;
  accountsById: Map<string, Account>;
  creatorsById: Map<string, Creator>;
  videosByAccount: Map<string, Video[]>;
  /** accountId -> creatorId */
  creatorOfAccount: Map<string, string>;
}

export function buildIndex(dataset: Dataset): DatasetIndex {
  const videosById = new Map<string, Video>();
  const videosByAccount = new Map<string, Video[]>();
  for (const v of dataset.videos) {
    videosById.set(v.id, v);
    const list = videosByAccount.get(v.accountId);
    if (list) list.push(v);
    else videosByAccount.set(v.accountId, [v]);
  }
  const accountsById = new Map(dataset.accounts.map((a) => [a.id, a] as const));
  const creatorsById = new Map(dataset.creators.map((c) => [c.id, c] as const));
  const creatorOfAccount = new Map<string, string>();
  for (const c of dataset.creators) for (const a of c.accountIds) creatorOfAccount.set(a, c.id);
  for (const a of dataset.accounts) if (a.creatorId && !creatorOfAccount.has(a.id)) creatorOfAccount.set(a.id, a.creatorId);
  return { dataset, videosById, accountsById, creatorsById, videosByAccount, creatorOfAccount };
}
