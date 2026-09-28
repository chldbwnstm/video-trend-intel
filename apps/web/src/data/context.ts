import { createContext } from 'react';
import type { Dataset, DatasetIndex } from '@vti/core';

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

export const DatasetContext = createContext<DatasetContextValue | null>(null);
