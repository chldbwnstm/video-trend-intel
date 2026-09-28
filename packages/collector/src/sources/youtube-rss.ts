/**
 * Source adapter: youtube-rss (keyless). OWNER: sources-keyless agent.
 *
 * Discovery: one public Atom feed per seed channel,
 *   GET https://www.youtube.com/feeds/videos.xml?channel_id=<UC...>
 * The feed lists only the 15 most recent uploads, with `media:statistics@views` and
 * `media:starRating@count` (likes). No comments, no duration, no tags.
 *
 * Refresh: RSS cannot look videos up by id, so `ctx.refreshIds` is ignored; a video is observed again only
 * while it is still among its channel's 15 latest uploads (documented in `notes`).
 */
import { XMLParser } from 'fast-xml-parser';
import type { CollectContext, CollectResult, RawAccount, RawVideo, SourceAdapter, YoutubeChannelSeed } from '../types.ts';
import {
  RequestBudget,
  cleanDescription,
  decodeEntities,
  detectLanguage,
  errorMessage,
  httpStatusOf,
  normalizeCountry,
  normalizeLanguage,
  parseTime,
  safeCount,
  str,
} from './util.ts';

const ID = 'youtube-rss';
const FEED_BASE = 'https://www.youtube.com/feeds/videos.xml';

export function youtubeFeedUrl(channelId: string): string {
  return `${FEED_BASE}?channel_id=${encodeURIComponent(channelId)}`;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // Keep every value a string (video ids like "12345678901" or titles like "2026" must not become numbers).
  parseTagValue: false,
  parseAttributeValue: false,
  // Entities are decoded by us in a single pass (the parser does not decode numeric references).
  processEntities: false,
  trimValues: true,
  isArray: (name) => name === 'entry' || name === 'link',
});

type Node = Record<string, unknown>;

function obj(v: unknown): Node | null {
  if (Array.isArray(v)) return obj(v[0]);
  return v && typeof v === 'object' ? (v as Node) : null;
}

/** Text content of a parsed node (string, or `#text` of a node with attributes), entity-decoded. */
function text(v: unknown): string | null {
  if (Array.isArray(v)) return text(v[0]);
  if (typeof v === 'string') return str(decodeEntities(v));
  const o = obj(v);
  if (o && typeof o['#text'] === 'string') return str(decodeEntities(o['#text']));
  return null;
}

function attr(v: unknown, name: string): string | null {
  const o = obj(v);
  if (!o) return null;
  const a = o[`@_${name}`];
  return typeof a === 'string' ? str(decodeEntities(a)) : null;
}

function alternateHref(links: unknown): string | null {
  const list = Array.isArray(links) ? links : links ? [links] : [];
  let fallback: string | null = null;
  for (const l of list) {
    const href = attr(l, 'href');
    if (!href) continue;
    const rel = attr(l, 'rel');
    if (rel === 'alternate') return href;
    fallback ??= href;
  }
  return fallback;
}

export interface ParsedFeed {
  channelTitle: string | null;
  authorName: string | null;
  entries: ParsedEntry[];
}

export interface ParsedEntry {
  videoId: string | null;
  channelId: string | null;
  title: string | null;
  url: string | null;
  published: string | null;
  description: string | null;
  thumbnail: string | null;
  views: string | null;
  likesCount: string | null;
}

/**
 * Parse a YouTube channel Atom feed. Returns null when the document is not an Atom feed (e.g. an HTML consent
 * or error page served with 200).
 */
export function parseYoutubeFeed(xml: string): ParsedFeed | null {
  let doc: Node;
  try {
    doc = parser.parse(xml) as Node;
  } catch {
    return null;
  }
  const feed = obj(doc?.feed);
  if (!feed) return null;
  const entries = Array.isArray(feed.entry) ? feed.entry : feed.entry ? [feed.entry] : [];
  return {
    channelTitle: text(feed.title),
    authorName: text(obj(feed.author)?.name),
    entries: entries.map((raw): ParsedEntry => {
      const e = obj(raw) ?? {};
      const group = obj(e['media:group']) ?? {};
      const community = obj(group['media:community']) ?? {};
      const idText = text(e.id);
      return {
        videoId: text(e['yt:videoId']) ?? (idText?.startsWith('yt:video:') ? idText.slice('yt:video:'.length) : null),
        channelId: text(e['yt:channelId']),
        title: text(e.title) ?? text(group['media:title']),
        url: alternateHref(e.link),
        published: text(e.published),
        description: text(group['media:description']),
        thumbnail: attr(group['media:thumbnail'], 'url'),
        views: attr(community['media:statistics'], 'views'),
        likesCount: attr(community['media:starRating'], 'count'),
      };
    }),
  };
}

/**
 * Likes from `media:starRating@count`. The feed reports `count="0" average="0.00"` both for videos whose like
 * count is hidden and for videos with no likes yet; the two cannot be told apart, so 0 is treated as
 * "not provided" (null), never as a real zero.
 */
export function likesFromStarRating(count: string | null): number | null {
  const n = safeCount(count);
  return n != null && n > 0 ? n : null;
}

export function entryToRawVideo(
  entry: ParsedEntry,
  seed: YoutubeChannelSeed,
  account: RawAccount,
  now: number,
): RawVideo | null {
  const videoId = entry.videoId;
  const publishedAt = parseTime(entry.published);
  if (!videoId || publishedAt == null) return null;
  const url = entry.url ?? `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  const title = entry.title ?? '';
  const description = cleanDescription(entry.description);
  const detected = detectLanguage(title, entry.description);
  const language = detected ?? normalizeLanguage(seed.language);
  return {
    platform: 'youtube',
    platformId: videoId,
    url,
    title,
    description,
    thumbnail: entry.thumbnail,
    publishedAt,
    durationSec: null,
    format: /\/shorts\//.test(url) ? 'short' : 'long',
    account,
    language,
    languageSource: language ? 'detected' : null,
    country: normalizeCountry(seed.country),
    sourceCategory: seed.category ? `youtube:seed:${seed.category}` : null,
    tags: [],
    counters: {
      views: safeCount(entry.views),
      likes: likesFromStarRating(entry.likesCount),
      comments: null,
      shares: null,
    },
    observedAt: now,
    status: 'active',
    discoveredVia: `seed-channel:${seed.channelId}`,
  };
}

function accountFor(seed: YoutubeChannelSeed, feed: ParsedFeed | null): RawAccount {
  return {
    platform: 'youtube',
    platformId: seed.channelId,
    handle: str(seed.handle),
    name: feed?.authorName ?? feed?.channelTitle ?? str(seed.name) ?? seed.channelId,
    url: `https://www.youtube.com/channel/${seed.channelId}`,
    avatar: null,
    country: normalizeCountry(seed.country),
    followers: null,
    seedCategory: seed.category ?? null,
  };
}

async function collect(ctx: CollectContext): Promise<CollectResult> {
  const videos: RawVideo[] = [];
  const accounts: RawAccount[] = [];
  const errors: string[] = [];
  const budget = new RequestBudget(ctx.http, ctx.maxRequests);
  const seen = new Set<string>();

  // De-duplicate seeds by channel id (first seed wins: it carries category/country/language).
  const seeds: YoutubeChannelSeed[] = [];
  const seedIds = new Set<string>();
  for (const s of ctx.seeds?.youtubeChannels ?? []) {
    const id = str(s?.channelId);
    if (!id || seedIds.has(id)) continue;
    seedIds.add(id);
    seeds.push({ ...s, channelId: id });
  }

  let fetched = 0;
  for (let i = 0; i < seeds.length; i++) {
    const seed = seeds[i];
    if (!budget.has()) {
      const skipped = seeds.length - i;
      errors.push(
        `요청 한도(maxRequests=${ctx.maxRequests}) 도달: 시드 채널 ${skipped}개 미수집 (${seeds
          .slice(i, i + 5)
          .map((s) => s.channelId)
          .join(', ')}${skipped > 5 ? ', …' : ''})`,
      );
      break;
    }
    const url = youtubeFeedUrl(seed.channelId);
    let xml: string;
    try {
      budget.take();
      xml = await ctx.http.getText(url);
    } catch (err) {
      const status = httpStatusOf(err);
      if (status === 404) errors.push(`채널 ${seed.channelId} (${seed.name}) RSS 없음(HTTP 404): 채널 ID 확인 필요`);
      else errors.push(`채널 ${seed.channelId} RSS 요청 실패${status ? `(HTTP ${status})` : ''}: ${errorMessage(err)}`);
      continue;
    }
    const feed = parseYoutubeFeed(xml);
    if (!feed) {
      errors.push(`채널 ${seed.channelId} RSS 응답이 Atom 피드가 아님(동의 페이지/오류 페이지일 수 있음)`);
      continue;
    }
    fetched++;
    const account = accountFor(seed, feed);
    let added = 0;
    let bad = 0;
    for (const entry of feed.entries) {
      const v = entryToRawVideo(entry, seed, account, ctx.now);
      if (!v) {
        bad++;
        continue;
      }
      if (seen.has(v.platformId)) continue;
      seen.add(v.platformId);
      videos.push(v);
      added++;
    }
    if (bad) errors.push(`채널 ${seed.channelId}: 항목 ${bad}개 파싱 불가(영상 ID/게시일 없음)`);
    if (added === 0) accounts.push(account);
  }

  ctx.log?.info?.(
    `[${ID}] channels ${fetched}/${seeds.length}, videos ${videos.length}, requests ${budget.used}, errors ${errors.length}`,
  );
  return { videos, accounts, errors };
}

export const youtubeRss: SourceAdapter = {
  id: ID,
  platform: 'youtube',
  label: 'YouTube (채널 RSS)',
  requiresCredentials: false,
  envKeys: [],
  metrics: ['views', 'likes'],
  discovery:
    '시드 채널 목록(seeds/youtube-channels.json)의 공개 RSS 피드(https://www.youtube.com/feeds/videos.xml?channel_id=…)에서 채널별 최신 업로드 15개를 수집합니다. 키워드 검색이나 시장 전체 발견은 하지 않습니다.',
  notes: [
    '채널별 최신 업로드 15개만 관측됩니다. 16번째 이후로 밀려난 영상은 더 이상 관측되지 않으므로 이후 기간의 증가량은 계산할 수 없습니다(미관측).',
    '조회수는 RSS의 media:statistics(공개 조회수), 좋아요는 media:starRating count(공개 좋아요 수) 값을 그대로 사용합니다.',
    '좋아요 수가 0으로 표시되면 비공개(숨김)와 실제 0을 구분할 수 없어 미제공(null)으로 처리합니다.',
    '댓글 수·공유 수·영상 길이·태그는 RSS에서 제공되지 않습니다(미제공, 0이 아님).',
    'YouTube Shorts는 2025년 3월부터 재생·반복 재생을 조회수로 집계하도록 정의가 바뀌었습니다. 이전 기간과 비교할 때 주의하세요.',
    '형식: 영상 링크가 /shorts/ 이면 Shorts(short), 그 외는 long으로 분류합니다. 라이브 여부는 RSS로 구분할 수 없습니다.',
    '언어는 제목·설명의 문자(한글→ko, 가나→ja)로 추정하고, 판별되지 않으면 시드 채널의 언어를 사용합니다(검출값). 국가는 시드에 적힌 채널(제작자) 국가이며 시청자 지역이 아닙니다.',
  ],
  docsUrl: 'https://www.youtube.com/t/terms',
  version: 1,
  isEnabled: () => true,
  collect,
};
