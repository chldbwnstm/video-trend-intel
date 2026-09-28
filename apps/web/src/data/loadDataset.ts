/**
 * Dataset loading (pure async logic, no React): real export first, sample as an explicit fallback.
 *
 * Rules (SPEC "Web conventions"):
 * - Load `./data/dataset.json` (compact format). If it is MISSING (404, network error, or an HTML page
 *   served by an SPA fallback), load `./data/sample.json` and flag `isSample` so the UI shows a
 *   persistent "샘플 데이터" banner.
 * - If the real file EXISTS but is broken (invalid JSON / unsupported schema), do NOT silently switch to
 *   sample data: report an error and let the user opt into the sample explicitly.
 * - Never mix sample and real data.
 */
import { decodeDataset } from '@vti/core';
import type { CompactDataset, Dataset } from '@vti/core';

export const DATASET_URL = './data/dataset.json';
export const SAMPLE_URL = './data/sample.json';

export type FetchLike = (url: string, init?: { signal?: AbortSignal; cache?: RequestCache }) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface LoadedDataset {
  ok: true;
  dataset: Dataset;
  isSample: boolean;
  url: string;
  /** Size of the downloaded JSON text in bytes (UTF-16 length approximation when unknown). */
  bytes: number;
  /** Why the real dataset was not used (only when isSample). Korean. */
  fallbackReason: string | null;
}

export interface LoadFailure {
  ok: false;
  /** invalid: file exists but cannot be decoded; unavailable: no data file could be fetched. */
  kind: 'invalid' | 'unavailable';
  url: string;
  message: string;
  /** True when the sample may be offered as an explicit alternative. */
  canUseSample: boolean;
}

export type LoadOutcome = LoadedDataset | LoadFailure;

type FetchResult =
  | { state: 'ok'; text: string; bytes: number }
  | { state: 'missing'; reason: string }
  | { state: 'invalid'; reason: string };

async function fetchJsonText(fetchFn: FetchLike, url: string, signal?: AbortSignal): Promise<FetchResult> {
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchFn(url, { signal, cache: 'no-cache' });
  } catch (e) {
    if (signal?.aborted) throw e;
    return { state: 'missing', reason: `네트워크 오류: ${errorMessage(e)}` };
  }
  if (!res.ok) return { state: 'missing', reason: `HTTP ${res.status}` };
  const type = (res.headers.get('content-type') ?? '').toLowerCase();
  if (type.includes('text/html')) return { state: 'missing', reason: '파일 없음(HTML 응답)' };
  const text = await res.text();
  const head = text.trimStart().slice(0, 1);
  if (head === '<') return { state: 'missing', reason: '파일 없음(HTML 응답)' };
  if (head !== '{') return { state: 'invalid', reason: 'JSON 객체가 아님' };
  return { state: 'ok', text, bytes: byteLength(text) };
}

function byteLength(text: string): number {
  try {
    return new TextEncoder().encode(text).length;
  } catch {
    return text.length;
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Parse and decode a dataset JSON text. Accepts the compact export format (with `srcTable`) and, for
 * robustness, an already-expanded `Dataset` (videos with `obs`). Throws with a Korean message on problems.
 */
export function parseDatasetText(text: string): Dataset {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`JSON 파싱 실패: ${errorMessage(e)}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('데이터 형식 오류: 객체가 아님');
  const obj = raw as Record<string, unknown>;
  if (obj.schemaVersion !== 1) throw new Error(`지원하지 않는 schemaVersion: ${String(obj.schemaVersion)}`);
  if (typeof obj.generatedAt !== 'number' || !Number.isFinite(obj.generatedAt)) throw new Error('데이터 형식 오류: generatedAt 없음');
  if (!Array.isArray(obj.videos)) throw new Error('데이터 형식 오류: videos 배열 없음');
  if (!Array.isArray(obj.accounts)) throw new Error('데이터 형식 오류: accounts 배열 없음');
  const normalized = {
    ...obj,
    creators: Array.isArray(obj.creators) ? obj.creators : [],
    coverage: Array.isArray(obj.coverage) ? obj.coverage : [],
    runs: Array.isArray(obj.runs) ? obj.runs : [],
    exportNotes: Array.isArray(obj.exportNotes) ? obj.exportNotes : [],
    classifierVersion: typeof obj.classifierVersion === 'string' ? obj.classifierVersion : 'unknown',
  };
  if (Array.isArray(obj.srcTable)) {
    for (const v of obj.videos as unknown[]) {
      if (!v || typeof v !== 'object' || !Array.isArray((v as { o?: unknown }).o)) {
        throw new Error('데이터 형식 오류: 영상 관측값(o) 없음');
      }
    }
    try {
      return decodeDataset(normalized as unknown as CompactDataset);
    } catch (e) {
      throw new Error(`데이터 디코딩 실패: ${errorMessage(e)}`);
    }
  }
  // Expanded Dataset form.
  for (const v of obj.videos as unknown[]) {
    if (!v || typeof v !== 'object' || !Array.isArray((v as { obs?: unknown }).obs)) {
      throw new Error('데이터 형식 오류: srcTable 없음(압축 형식이 아님)');
    }
  }
  const ds = normalized as unknown as Dataset;
  return {
    ...ds,
    videos: ds.videos.map((v) => ({
      ...v,
      obs: [...v.obs].sort((a, b) => a.t - b.t),
      sourceWindows: Array.isArray(v.sourceWindows) ? v.sourceWindows : [],
    })),
  };
}

export interface LoadOptions {
  datasetUrl?: string;
  sampleUrl?: string;
  /** Skip the real dataset and load the sample (explicit user choice after a failure). */
  forceSample?: boolean;
  signal?: AbortSignal;
}

export async function loadDataset(fetchFn: FetchLike, opts: LoadOptions = {}): Promise<LoadOutcome> {
  const datasetUrl = opts.datasetUrl ?? DATASET_URL;
  const sampleUrl = opts.sampleUrl ?? SAMPLE_URL;
  let fallbackReason: string;

  if (!opts.forceSample) {
    const primary = await fetchJsonText(fetchFn, datasetUrl, opts.signal);
    if (primary.state === 'ok') {
      try {
        const dataset = parseDatasetText(primary.text);
        return { ok: true, dataset, isSample: false, url: datasetUrl, bytes: primary.bytes, fallbackReason: null };
      } catch (e) {
        return { ok: false, kind: 'invalid', url: datasetUrl, message: errorMessage(e), canUseSample: true };
      }
    }
    if (primary.state === 'invalid') {
      return { ok: false, kind: 'invalid', url: datasetUrl, message: primary.reason, canUseSample: true };
    }
    fallbackReason = `실데이터(${datasetUrl})를 찾지 못함: ${primary.reason}`;
  } else {
    fallbackReason = '사용자가 샘플 데이터를 선택함';
  }

  const sample = await fetchJsonText(fetchFn, sampleUrl, opts.signal);
  if (sample.state !== 'ok') {
    return {
      ok: false,
      kind: 'unavailable',
      url: sampleUrl,
      message: `데이터 파일을 불러올 수 없음. ${fallbackReason}; 샘플(${sampleUrl}): ${sample.reason}`,
      canUseSample: false,
    };
  }
  try {
    const dataset = parseDatasetText(sample.text);
    return { ok: true, dataset, isSample: true, url: sampleUrl, bytes: sample.bytes, fallbackReason };
  } catch (e) {
    return { ok: false, kind: 'invalid', url: sampleUrl, message: errorMessage(e), canUseSample: false };
  }
}
