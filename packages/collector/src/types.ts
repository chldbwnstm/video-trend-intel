/**
 * Collector-side contract: what every source adapter returns. The pipeline (store.ts / pipeline.ts)
 * turns RawVideo/RawAccount into stored rows + observations, classifies them with @vti/core, and
 * exports a Dataset.
 */
import type { MetricKey, Platform, VideoFormat, VideoStatus } from '@vti/core';

export interface RawAccount {
  platform: Platform;
  platformId: string;
  handle: string | null;
  name: string;
  url: string;
  avatar: string | null;
  country: string | null;
  /** Subscriber/follower count if the source provides it at this observation, else null. */
  followers: number | null;
  /** Taxonomy id if this account came from a category seed list. */
  seedCategory?: string | null;
}

export interface RawCounters {
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
}

export interface RawVideo {
  platform: Platform;
  platformId: string;
  url: string;
  title: string;
  description: string | null;
  thumbnail: string | null;
  publishedAt: number;
  durationSec: number | null;
  format: VideoFormat;
  account: RawAccount;
  language: string | null;
  languageSource: 'source' | 'detected' | null;
  country: string | null;
  /** Namespaced: `dailymotion:news`, `peertube:Music`, `youtube:seed:beauty`, `niconico:ゲーム`. */
  sourceCategory: string | null;
  tags: string[];
  counters: RawCounters;
  /**
   * Instant the counters refer to. Usually the fetch time, but e.g. niconico snapshot data refers to the
   * snapshot's last_modified time — use THAT, never the fetch time, when the source is a periodic snapshot.
   */
  observedAt: number;
  sourceWindows?: { metric: MetricKey; windowHours: number; value: number }[];
  status?: VideoStatus;
  /** Why this video was found, e.g. `seed-channel:UCxxxx`, `dailymotion:visited-week:kr`. */
  discoveredVia: string;
}

export interface CollectLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface HttpClient {
  /** fetch with per-host rate limiting, retries (429/5xx with backoff), timeout and a descriptive User-Agent. */
  getJson<T = unknown>(url: string, init?: { headers?: Record<string, string>; method?: 'GET' | 'POST'; body?: string }): Promise<T>;
  getText(url: string, init?: { headers?: Record<string, string>; method?: 'GET' | 'POST'; body?: string }): Promise<string>;
  /** Number of HTTP requests made through this client so far. */
  readonly requestCount: number;
}

export interface CollectContext {
  now: number;
  http: HttpClient;
  log: CollectLogger;
  env: Record<string, string | undefined>;
  /** Parsed seed files (packages/collector/seeds/*.json). */
  seeds: Seeds;
  /** Known video platformIds for this source that should be re-observed this run (tiered refresh). */
  refreshIds: string[];
  /** Soft cap on HTTP requests for this source in this run. */
  maxRequests: number;
}

export interface CollectResult {
  videos: RawVideo[];
  /** Accounts observed without videos (e.g. follower counts from channel lookups). */
  accounts: RawAccount[];
  errors: string[];
  /** Platform ids from refreshIds confirmed deleted/private by the source. */
  gone?: { platformId: string; status: VideoStatus }[];
}

export interface SourceAdapter {
  id: string; // e.g. 'youtube-rss'
  platform: Platform;
  label: string;
  requiresCredentials: boolean;
  /** Environment variables required when requiresCredentials. */
  envKeys: string[];
  metrics: MetricKey[];
  /** Korean description of the discovery method (shown on the coverage page). */
  discovery: string;
  /** Korean caveats / metric definitions. */
  notes: string[];
  docsUrl: string | null;
  /** Metric-definition version stamped on observations: `${id}@${version}`. */
  version: number;
  isEnabled(env: Record<string, string | undefined>): boolean;
  collect(ctx: CollectContext): Promise<CollectResult>;
}

/* ---------------------------------------------------------------- seeds */

export interface YoutubeChannelSeed {
  channelId: string; // UC...
  handle: string | null; // @handle
  name: string;
  category: string; // taxonomy id (top-level or sub)
  country: string | null; // 'KR', 'US', ...
  language: string | null; // 'ko', 'en', ...
  creatorId?: string | null; // links to creators.json
}

export interface KeywordSeed {
  keyword: string;
  category: string;
  language: string;
}

export interface DailymotionQuerySeed {
  /** Dailymotion channel (category) slug, e.g. 'news', 'music', 'videogames' — or null for all. */
  channel: string | null;
  country: string | null; // 'kr'
  language: string | null; // 'ko'
  sort: 'visited-today' | 'visited-week' | 'visited-month' | 'trending' | 'recent' | 'relevance';
  search: string | null;
  limit: number;
}

export interface NiconicoQuerySeed {
  q: string;
  targets: 'tagsExact' | 'title,description,tags';
  category: string; // taxonomy id
  sort: '-viewCounter' | '-startTime' | '-likeCounter' | '-commentCounter';
  /** Only videos started within the last N days (null = no filter). */
  sinceDays: number | null;
  limit: number;
}

export interface PeertubeQuerySeed {
  search: string | null;
  languageOneOf: string[] | null;
  sort: '-publishedAt' | '-views' | '-likes' | '-match';
  limit: number;
  /** Only videos published within the last N days (SepiaSearch startDate). */
  sinceDays?: number | null;
}

export interface CreatorSeed {
  id: string;
  name: string;
  /** Account ids `${platform}:${platformId}` curated as the same creator. */
  accountIds: string[];
  note: string | null;
}

export interface Seeds {
  youtubeChannels: YoutubeChannelSeed[];
  keywords: KeywordSeed[];
  dailymotion: DailymotionQuerySeed[];
  niconico: NiconicoQuerySeed[];
  peertube: PeertubeQuerySeed[];
  creators: CreatorSeed[];
}
