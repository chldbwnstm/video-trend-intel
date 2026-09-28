/**
 * Shared domain contract for Video Trend Intel.
 *
 * Everything that crosses a module boundary (collector -> dataset export -> web/server)
 * is typed here. Changing a type here is a contract change: update SPEC.md too.
 *
 * Conventions
 * - All instants are epoch milliseconds, UTC (`number`). Never store local times.
 * - Local calendar dates (what a user picks in a date picker) are `YYYY-MM-DD` strings
 *   interpreted in an explicit IANA time zone (e.g. `Asia/Seoul`, `Australia/Sydney`).
 * - A metric that a source does not provide is `null`, never `0`.
 *   (문서 원칙: 비공개·미제공 필드를 0으로 처리하면 왜곡)
 * - Ids are namespaced by platform: `${platform}:${platformNativeId}`.
 */

export const PLATFORMS = [
  'youtube',
  'dailymotion',
  'peertube',
  'niconico',
  'tiktok',
  'instagram',
  'x',
  'twitch',
] as const;
export type Platform = (typeof PLATFORMS)[number];

export const PLATFORM_LABELS: Record<Platform, string> = {
  youtube: 'YouTube',
  dailymotion: 'Dailymotion',
  peertube: 'PeerTube',
  niconico: 'niconico',
  tiktok: 'TikTok',
  instagram: 'Instagram',
  x: 'X',
  twitch: 'Twitch',
};

/** Counter metrics we observe over time. */
export type MetricKey = 'views' | 'likes' | 'comments' | 'shares';
export const METRIC_KEYS: MetricKey[] = ['views', 'likes', 'comments', 'shares'];

export type VideoFormat = 'short' | 'long' | 'live' | 'unknown';

/** Lifecycle state of a video as last seen by a collector. */
export type VideoStatus = 'active' | 'deleted' | 'private' | 'unknown';

/**
 * One observation of a video's public counters at instant `t`.
 * `null` = the source did not provide that counter in this observation (NOT zero).
 */
export interface ObservationPoint {
  t: number;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  /** Source adapter id + metric-definition version, e.g. `youtube-rss@1`, `dailymotion-api@1`. */
  src: string;
}

/**
 * A windowed counter reported directly by a source (not derived from our observations),
 * e.g. Dailymotion `views_last_week`. Only valid for the window ending at `observedAt`.
 */
export interface SourceWindowMetric {
  metric: MetricKey;
  windowHours: number;
  value: number;
  observedAt: number;
  src: string;
}

/** Why a classifier assigned a label. Shown to users as the classification rationale. */
export interface Evidence {
  field: 'title' | 'tags' | 'description' | 'sourceCategory' | 'account' | 'manual';
  /** The keyword / tag / source category value that matched. */
  match: string;
}

export interface CategoryAssignment {
  /** Taxonomy node id, e.g. `beauty` or `beauty/skincare`. */
  id: string;
  /** 0..1 */
  confidence: number;
  evidence: Evidence[];
  by: 'rule' | 'source' | 'account' | 'manual';
  /** Classifier version that produced this assignment, e.g. `rules-2026.09.1`. */
  version: string;
}

export interface SponsorshipSignal {
  /** 'disclosed' = explicit paid-promotion disclosure text; 'likely' = brand/promo cues only. */
  level: 'disclosed' | 'likely';
  brands: string[];
  evidence: Evidence[];
  version: string;
}

export interface Video {
  /** `${platform}:${platformId}` */
  id: string;
  platform: Platform;
  platformId: string;
  url: string;
  title: string;
  /** Truncated (<= 300 chars) description, if the source provides one. */
  description: string | null;
  thumbnail: string | null;
  publishedAt: number;
  durationSec: number | null;
  format: VideoFormat;
  /** `${platform}:${platformAccountId}` */
  accountId: string;
  /** ISO 639-1 (`ko`, `en`, `ja`...) or null if unknown. */
  language: string | null;
  languageSource: 'source' | 'detected' | null;
  /** Country as reported by the source for the video/uploader (NOT viewer geography). */
  country: string | null;
  /** Platform-native category label, e.g. Dailymotion channel `news`, PeerTube `Music`. */
  sourceCategory: string | null;
  tags: string[];
  categories: CategoryAssignment[];
  /** Normalized topic keys (lowercase hashtags / tags / key phrases). */
  topics: string[];
  sponsorship: SponsorshipSignal | null;
  status: VideoStatus;
  firstSeenAt: number;
  lastObservedAt: number;
  /** How the collector found this video, e.g. `seed-channel`, `dailymotion:visited-week:kr`. */
  discoveredVia: string[];
  /** Observations sorted by `t` ascending. */
  obs: ObservationPoint[];
  sourceWindows: SourceWindowMetric[];
}

export interface FollowerPoint {
  t: number;
  value: number;
  src: string;
}

export interface Account {
  /** `${platform}:${platformId}` */
  id: string;
  platform: Platform;
  platformId: string;
  handle: string | null;
  name: string;
  url: string;
  avatar: string | null;
  country: string | null;
  /** Follower/subscriber observations over time (may be empty if not provided). */
  followers: FollowerPoint[];
  creatorId: string | null;
  /** Taxonomy id assigned when the account was seeded by category (evidence for classification). */
  seedCategory: string | null;
  trackedSince: number;
  discoveredVia: string[];
}

/** A person/brand owning accounts on multiple platforms (Tubular "creator portfolio"). */
export interface Creator {
  id: string;
  name: string;
  accountIds: string[];
  /** 'verified' = curated mapping; 'suggested' = automatic name match, not confirmed. */
  linkStatus: 'verified' | 'suggested';
  note: string | null;
}

export interface SourceCoverage {
  /** Adapter id, e.g. `youtube-rss`. */
  source: string;
  platform: Platform;
  label: string;
  enabled: boolean;
  requiresCredentials: boolean;
  /** Human-readable description of how videos are discovered (Korean). */
  discovery: string;
  /** Metrics this source provides. */
  metrics: MetricKey[];
  firstRunAt: number | null;
  lastRunAt: number | null;
  lastSuccessAt: number | null;
  lastStatus: 'ok' | 'partial' | 'error' | 'disabled' | 'never';
  lastError: string | null;
  videoCount: number;
  accountCount: number;
  /** Caveats / definitions shown on the coverage page (Korean). */
  notes: string[];
  /** Link to the source's terms / docs. */
  docsUrl: string | null;
}

export interface CollectionRun {
  id: string;
  startedAt: number;
  finishedAt: number | null;
  source: string;
  status: 'ok' | 'partial' | 'error';
  videosSeen: number;
  videosNew: number;
  observations: number;
  requests: number;
  errors: string[];
}

export interface Dataset {
  schemaVersion: 1;
  /** Time the export was produced == data "as of" time used as default `now`. */
  generatedAt: number;
  classifierVersion: string;
  videos: Video[];
  accounts: Account[];
  creators: Creator[];
  coverage: SourceCoverage[];
  runs: CollectionRun[];
  /** Export-side notes, e.g. what was pruned to fit the size budget (no silent caps). */
  exportNotes: string[];
}

/* ------------------------------------------------------------------------------------------
 * Analytics contract
 * ---------------------------------------------------------------------------------------- */

/**
 * How a metric value was obtained. Every number shown in the UI carries one of these.
 * - exact: an observation lies within the boundary tolerance of the requested instant (2h; for a window
 *          increment also at most 5% of the window length), or the value is known by definition (e.g. 0 views
 *          before publish).
 * - interpolated: linear interpolation between two bracketing observations whose gap is
 *          within the allowed max gap.
 * - lower_bound: true value is >= value (e.g. window starts before our first observation).
 * - source_reported: value taken from a SourceWindowMetric, not from our observations.
 * - unavailable: cannot be computed honestly (missing counter, gap too wide, not reached...).
 * - decrease_flagged: counter went down over the window (deletion / correction / source
 *          error). Value is kept for display but excluded from rankings.
 */
export type MetricStatus =
  | 'exact'
  | 'interpolated'
  | 'lower_bound'
  | 'source_reported'
  | 'unavailable'
  | 'decrease_flagged';

export interface MetricValue {
  value: number | null;
  status: MetricStatus;
  /** Instant the value refers to / was last observed. */
  asOf: number | null;
  /** Short machine-readable reason, e.g. `gap_too_wide`, `not_reached`, `counter_not_provided`. */
  note: string | null;
}

/**
 * Date semantics (docs/competitive-analysis/comparison-and-product-direction.md §5):
 * - upload:   videos whose publishedAt is inside the window; rank by their latest value, as of the data's now.
 * - activity: all videos; rank by counter increase that happened inside the window.
 * - age:      compare videos at the same age: value at publishedAt + ageDays.
 */
export type DateMode = 'upload' | 'activity' | 'age';

export const AGE_DAYS = [1, 2, 3, 7, 30] as const;
export type AgeDays = (typeof AGE_DAYS)[number];

/** Local calendar date range, both ends INCLUSIVE, interpreted in `tz`. */
export interface LocalDateRange {
  start: string; // YYYY-MM-DD
  end: string; // YYYY-MM-DD (inclusive)
}

/** Resolved half-open UTC window [startMs, endMs). */
export interface UtcWindow {
  startMs: number;
  endMs: number;
  tz: string;
  /** True when endMs is after the data's `now` (the period is not finished yet). */
  incomplete: boolean;
}

export type SortKey =
  | 'views_total'
  | 'views_period'
  | 'likes_period'
  | 'comments_period'
  | 'velocity'
  | 'growth_vs_prev'
  | 'engagement_rate'
  | 'outperformance'
  | 'views_at_age'
  | 'percentile'
  | 'published_at';

export interface VideoQuery {
  q?: string;
  platforms?: Platform[];
  /** Taxonomy ids; a video matches if it has the id or any descendant. */
  categories?: string[];
  topics?: string[];
  languages?: string[];
  countries?: string[];
  formats?: VideoFormat[];
  accountIds?: string[];
  creatorIds?: string[];
  sponsored?: 'disclosed' | 'any' | 'none';
  minViews?: number;
  dateMode: DateMode;
  /** Required for 'upload' and 'activity' (unless rollingHours is set). For 'age' it optionally restricts publishedAt. */
  range?: LocalDateRange;
  /**
   * Rolling window [now - rollingHours, now) used instead of `range` (upload/activity/age). 24/168/720 match the
   * source-reported windows (e.g. Dailymotion views_last_day/week/month) and end exactly at the data's now.
   */
  rollingHours?: number;
  /** Required for 'age'. */
  ageDays?: AgeDays;
  tz: string;
  sort: SortKey;
  sortDir?: 'desc' | 'asc';
  limit?: number;
  offset?: number;
  /** Data "now" (defaults to dataset.generatedAt). Injected for determinism. */
  now?: number;
}

export interface VideoMetrics {
  /**
   * Cumulative views: as of min(window end, now) in activity mode; the latest value, as of `now`, in upload and
   * age mode (design doc §5: uploads of a period ranked by their current views; may include views gained after
   * the window ended).
   */
  viewsTotal: MetricValue;
  /** Increase inside the window (activity mode) — or since publish, as of now, for upload mode. */
  viewsPeriod: MetricValue;
  likesPeriod: MetricValue;
  commentsPeriod: MetricValue;
  /** Views per hour over the most recent ~24h ending at min(window end, now). */
  velocity: MetricValue;
  /** Window increase / previous equal-length window increase - 1. */
  growthVsPrev: MetricValue;
  /** (likes + comments + shares available) / views at the same observation. */
  engagementRate: MetricValue & { components: MetricKey[] };
  /** Views at publishedAt + ageDays (age mode) — also computed for V1/V7/V30 in details. */
  viewsAtAge: MetricValue;
  /** Video's views-at-age / median views-at-age of the same account's other videos. */
  outperformance: MetricValue & { ageDays: AgeDays | null; peers: number };
  /** Percentile (0..100) of the sort metric within the same platform in the result set. */
  percentile: MetricValue;
}

export interface VideoRow {
  video: Video;
  account: Account | null;
  metrics: VideoMetrics;
}

export interface QueryResult {
  rows: VideoRow[];
  total: number;
  window: UtcWindow | null;
  now: number;
  /** Korean explanations of how to read this result (date semantics, coverage caveats). */
  notes: string[];
}

export type TrendEntityKind = 'topic' | 'category' | 'creator' | 'account';

export interface TrendItem {
  kind: TrendEntityKind;
  key: string;
  label: string;
  platform: Platform | null;
  /** Summed view increase in the current window (only 'exact'/'interpolated' contributions). */
  current: number;
  previous: number;
  /** current / previous - 1, null when previous is 0 / unknown. */
  growth: number | null;
  videoCount: number;
  /** Videos contributing with lower_bound / unavailable values (coverage honesty). */
  incompleteCount: number;
  topVideoIds: string[];
}

export interface TrendingResult {
  window: UtcWindow;
  previousWindow: UtcWindow;
  rising: TrendItem[];
  falling: TrendItem[];
  top: TrendItem[];
  notes: string[];
}

export interface OpportunityItem {
  topic: string;
  label: string;
  /** Other topics with exactly the same videos, merged into this one (e.g. one channel's paired tags). */
  aliases?: string[];
  /** Median views-per-video (demand) among videos uploaded in the window. */
  demand: number;
  /** Number of videos uploaded in the window in our tracked set (supply). */
  supply: number;
  demandPercentile: number;
  supplyPercentile: number;
  /** demandPercentile - supplyPercentile, higher = more views per video with fewer uploads. */
  score: number;
  sampleVideoIds: string[];
}

export interface CreatorSummary {
  /** Creator id if linked, otherwise the account id (single-account portfolio). */
  key: string;
  kind: 'creator' | 'account';
  name: string;
  accounts: Account[];
  platforms: Platform[];
  followers: number | null;
  followersGrowth: MetricValue;
  videoCount: number;
  uploadsInWindow: number;
  viewsInWindow: MetricValue;
  engagementRate: MetricValue;
  medianV7: MetricValue;
  topCategories: string[];
  sponsoredCount: number;
}

export interface TaxonomyNode {
  id: string; // `beauty` or `beauty/skincare`
  parent: string | null;
  label: { ko: string; en: string };
  /** Match keywords (lowercase). Korean, English and Japanese variants. */
  keywords: string[];
  /** Source-native categories mapping to this node, e.g. `dailymotion:news`, `peertube:Music`. */
  sourceCategories: string[];
}
