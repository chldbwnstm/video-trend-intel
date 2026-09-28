import { createContext } from 'react';
import type { Dataset, DatasetIndex } from '@vti/core';
import type { LoadFailure } from './loadDataset.ts';

export interface DatasetSourceInfo {
  url: string;
  bytes: number;
  /** Why the sample is shown instead of the real export (Korean), null for real data. */
  fallbackReason: string | null;
  /** Browser clock when loading finished (for "loaded N minutes ago"). */
  loadedAt: number;
}

export interface DatasetContextValue {
  dataset: Dataset;
  index: DatasetIndex;
  /** Data "now" = dataset.generatedAt. Pass it to every core analytics call for deterministic results. */
  now: number;
  /** True when the synthetic sample is shown (a persistent banner is rendered by the shell). */
  isSample: boolean;
  /** Display time zone (IANA), default Asia/Seoul. */
  tz: string;
  setTz: (tz: string) => void;
  source: DatasetSourceInfo;
  /** Re-fetch the data files. */
  reload: () => void;
}

/** The loaded dataset; null while it loads or failed (pages render only below <RequireDataset>). */
export const DatasetContext = createContext<DatasetContextValue | null>(null);

/**
 * App-level state that exists before the dataset is loaded, so the shell (sidebar, top bar, time-zone
 * select) and routes that need no data (404) render immediately instead of waiting for the download.
 */
export interface AppStatusValue {
  status: 'loading' | 'error' | 'ready';
  failure: LoadFailure | null;
  /** Display time zone (URL `tz` > stored preference > Asia/Seoul). */
  tz: string;
  setTz: (tz: string) => void;
  reload: () => void;
  /** Load the synthetic sample after a failure (explicit user choice, never silent). */
  loadSample: () => void;
}

export const AppStatusContext = createContext<AppStatusValue | null>(null);
