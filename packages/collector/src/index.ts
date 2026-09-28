/**
 * @vti/collector public API. OWNER: collector-pipeline.
 * (The CLI lives in cli.ts and is not re-exported here, so importing the package never runs a command.)
 */
export { ADAPTERS, adapterById } from './sources/index.ts';
export type * from './types.ts';

export {
  createHttpClient,
  HostRateLimiter,
  HttpError,
  NetworkError,
  redactUrl,
  parseRetryAfter,
  isRetryableStatus,
  DEFAULT_USER_AGENT,
  DEFAULT_HOST_RPS,
  DEFAULT_RPS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_RETRIES,
} from './http.ts';
export type { HttpClientOptions, VtiHttpClient, RequestInitLite } from './http.ts';

export { createLogger, defaultLogFile, silentLogger, memoryLogger } from './log.ts';
export type { Logger, LoggerOptions, LogLevel } from './log.ts';

export { loadSeeds, loadSeedsDetailed, creatorsFromSeeds, emptySeeds, DEFAULT_SEEDS_DIR, SEED_FILES } from './seeds.ts';
export type { SeedLoadResult, LoadSeedsOptions } from './seeds.ts';

export { openStore, Store, REFRESH_TIERS, OBS_DEDUPE_WINDOW_MS, SCHEMA_VERSION, videoIdOf, platformOfSource } from './store.ts';
export type {
  StoredVideo,
  StoredAccount,
  StoredCreator,
  StoredClassification,
  SourceState,
  RefreshCandidate,
  RefreshTier,
  StoreCounts,
  DatasetParts,
  VideoForExport,
  AccountForExport,
} from './store.ts';

export { classifyStoredVideos, classifyStoredVideo } from './classify.ts';
export type { ClassifyStoredOptions, ClassifyStoredResult } from './classify.ts';

export { selectRefreshIds, refreshCapFor, DEFAULT_REFRESH_CAPS } from './refresh.ts';
export type { RefreshSelection } from './refresh.ts';

export { runCollection, collectAndExport, persistResult, redactSecrets, DEFAULT_MAX_REQUESTS } from './pipeline.ts';
export type { RunCollectionOptions, RunCollectionResult, SourceRunSummary, CollectAndExportOptions, CollectAndExportResult } from './pipeline.ts';

export {
  buildDataset,
  buildDatasetDetailed,
  writeExport,
  compactSeries,
  suggestCreators,
  normalizeAccountName,
  latestSourceWindows,
  DEFAULT_BUDGET_BYTES,
  DEFAULT_COMPACTION,
  WEB_DATASET_PATH,
} from './export.ts';
export type { BuildDatasetOptions, BuildDatasetStats, CompactionPolicy, ExportMeta, WriteExportResult, WriteExportOptions } from './export.ts';
