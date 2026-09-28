/**
 * Loads the dataset once for the whole app and provides:
 * - AppStatusContext { status, failure, tz, setTz, reload, loadSample } right away, so the shell (sidebar,
 *   top bar) and routes that need no data (404) render while the ~20 MB dataset downloads;
 * - DatasetContext { dataset, index, now, isSample, tz, setTz, source, reload } once it is loaded.
 * Data pages sit below <RequireDataset>, which shows the loading / error state inside the shell until then,
 * so `useDataset()` in a page never sees an empty state.
 *
 * Must be rendered inside the router: the display time zone is global URL state (`tz`, see useUrlTz).
 */
import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Outlet } from 'react-router-dom';
import { buildIndex } from '@vti/core';
import type { Dataset, DatasetIndex } from '@vti/core';
import { Database, FlaskConical } from 'lucide-react';
import { AppStatusContext, DatasetContext } from './context.ts';
import type { AppStatusValue, DatasetContextValue, DatasetSourceInfo } from './context.ts';
import { useUrlTz } from './hooks.ts';
import { DATASET_URL, loadDataset, SAMPLE_URL } from './loadDataset.ts';
import type { FetchLike, LoadFailure } from './loadDataset.ts';
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
  const [tz, setTz] = useUrlTz();

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

  const reload = useCallback(() => setAttempt((a) => a + 1), []);
  const loadSample = useCallback(() => {
    setForceSample(true);
    setAttempt((a) => a + 1);
  }, []);

  const status = useMemo(
    (): AppStatusValue => ({ status: state.status, failure: state.status === 'error' ? state.failure : null, tz, setTz, reload, loadSample }),
    [state, tz, setTz, reload, loadSample],
  );

  const value = useMemo((): DatasetContextValue | null => {
    if (state.status !== 'ready') return null;
    const { dataset, index, isSample, source } = state.loaded;
    return { dataset, index, now: dataset.generatedAt, isSample, tz, setTz, source, reload };
  }, [state, tz, setTz, reload]);

  return (
    <AppStatusContext.Provider value={status}>
      <DatasetContext.Provider value={value}>{children}</DatasetContext.Provider>
    </AppStatusContext.Provider>
  );
}

/**
 * Layout route for pages that need the dataset: renders `children` (default: the child route's <Outlet />)
 * once loaded, else the loading / error state in the page area (the shell stays interactive).
 */
export function RequireDataset({ children }: { children?: ReactNode }) {
  const ds = useContext(DatasetContext);
  const app = useContext(AppStatusContext);
  if (ds) return <>{children ?? <Outlet />}</>;
  if (!app || app.status !== 'error' || !app.failure) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
        <Database className="size-8 text-fg-3" aria-hidden />
        <LoadingState label="데이터 불러오는 중" className="py-0" />
      </div>
    );
  }
  return <DatasetFailure failure={app.failure} onRetry={app.reload} onSample={app.loadSample} />;
}

export function DatasetFailure({ failure: f, onRetry, onSample }: { failure: LoadFailure; onRetry: () => void; onSample: () => void }) {
  return (
    <ErrorState
      title={f.kind === 'invalid' ? '데이터 파일을 읽을 수 없음' : '데이터 파일을 불러오지 못함'}
      description={
        f.kind === 'invalid'
          ? `${f.url} 파일이 손상됐거나 지원하지 않는 형식임. 실데이터를 샘플로 몰래 바꾸지 않음.`
          : `${f.url} 경로를 확인하거나 수집기에서 npm run export 를 실행해야 함.`
      }
      error={f.message}
      onRetry={onRetry}
      action={
        f.canUseSample ? (
          <Button size="sm" icon={<FlaskConical className="size-3.5" aria-hidden />} onClick={onSample}>
            샘플 데이터로 보기
          </Button>
        ) : null
      }
    />
  );
}
