/**
 * Loads the dataset once for the whole app and provides { dataset, index, now, isSample, tz, setTz }.
 * Children render only after a dataset is loaded, so `useDataset()` never returns an empty state.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { buildIndex } from '@vti/core';
import type { Dataset, DatasetIndex } from '@vti/core';
import { Database, FlaskConical } from 'lucide-react';
import { DatasetContext } from './context.ts';
import type { DatasetContextValue, DatasetSourceInfo } from './context.ts';
import { DATASET_URL, loadDataset, SAMPLE_URL } from './loadDataset.ts';
import type { FetchLike, LoadFailure } from './loadDataset.ts';
import { readStored, STORAGE_KEYS, writeStored } from '../lib/storage.ts';
import { normalizeTz } from '../lib/timezones.ts';
import { ErrorState, LoadingState } from '../components/states.tsx';
import { Button } from '../components/primitives.tsx';

interface Loaded {
  dataset: Dataset;
  index: DatasetIndex;
  isSample: boolean;
  source: DatasetSourceInfo;
}

type State = { status: 'loading' } | { status: 'error'; failure: LoadFailure } | { status: 'ready'; loaded: Loaded };

export interface DatasetProviderProps {
  children: ReactNode;
  datasetUrl?: string;
  sampleUrl?: string;
  /** Injected fetch (tests). */
  fetchFn?: FetchLike;
}

const browserFetch: FetchLike = (url, init) => fetch(url, init);

export function DatasetProvider({ children, datasetUrl = DATASET_URL, sampleUrl = SAMPLE_URL, fetchFn = browserFetch }: DatasetProviderProps) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [forceSample, setForceSample] = useState(false);
  const [tz, setTzState] = useState<string>(() => normalizeTz(readStored(STORAGE_KEYS.tz)));

  useEffect(() => {
    const ctrl = new AbortController();
    setState({ status: 'loading' });
    loadDataset(fetchFn, { datasetUrl, sampleUrl, forceSample, signal: ctrl.signal })
      .then((outcome) => {
        if (ctrl.signal.aborted) return;
        if (!outcome.ok) {
          setState({ status: 'error', failure: outcome });
          return;
        }
        try {
          const index = buildIndex(outcome.dataset);
          setState({
            status: 'ready',
            loaded: {
              dataset: outcome.dataset,
              index,
              isSample: outcome.isSample,
              source: { url: outcome.url, bytes: outcome.bytes, fallbackReason: outcome.fallbackReason, loadedAt: Date.now() },
            },
          });
        } catch (e) {
          setState({
            status: 'error',
            failure: { ok: false, kind: 'invalid', url: outcome.url, message: e instanceof Error ? e.message : String(e), canUseSample: !outcome.isSample },
          });
        }
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return;
        setState({
          status: 'error',
          failure: { ok: false, kind: 'unavailable', url: datasetUrl, message: e instanceof Error ? e.message : String(e), canUseSample: true },
        });
      });
    return () => ctrl.abort();
  }, [fetchFn, datasetUrl, sampleUrl, forceSample, attempt]);

  const setTz = useCallback((next: string) => {
    const normalized = normalizeTz(next);
    setTzState(normalized);
    writeStored(STORAGE_KEYS.tz, normalized);
  }, []);

  const reload = useCallback(() => setAttempt((a) => a + 1), []);

  const value = useMemo((): DatasetContextValue | null => {
    if (state.status !== 'ready') return null;
    const { dataset, index, isSample, source } = state.loaded;
    return { dataset, index, now: dataset.generatedAt, isSample, tz, setTz, source, reload };
  }, [state, tz, setTz, reload]);

  if (state.status === 'loading') {
    return (
      <FullScreen>
        <Database className="size-8 text-fg-3" aria-hidden />
        <p className="text-base font-semibold text-fg">영상 트렌드 인텔리전스</p>
        <LoadingState label="데이터 불러오는 중" />
      </FullScreen>
    );
  }

  if (state.status === 'error') {
    const f = state.failure;
    return (
      <FullScreen>
        <ErrorState
          title={f.kind === 'invalid' ? '데이터 파일을 읽을 수 없음' : '데이터 파일을 불러오지 못함'}
          description={
            f.kind === 'invalid'
              ? `${f.url} 파일이 손상됐거나 지원하지 않는 형식임. 실데이터를 샘플로 몰래 바꾸지 않음.`
              : `${f.url} 경로를 확인하거나 수집기에서 npm run export 를 실행해야 함.`
          }
          error={f.message}
          onRetry={reload}
          action={
            f.canUseSample ? (
              <Button
                size="sm"
                icon={<FlaskConical className="size-3.5" aria-hidden />}
                onClick={() => {
                  setForceSample(true);
                  reload();
                }}
              >
                샘플 데이터로 보기
              </Button>
            ) : null
          }
        />
      </FullScreen>
    );
  }

  return <DatasetContext.Provider value={value}>{children}</DatasetContext.Provider>;
}

function FullScreen({ children }: { children: ReactNode }) {
  return <main className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-canvas px-4 text-center">{children}</main>;
}
