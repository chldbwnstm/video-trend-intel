/**
 * Source adapter: youtube-rss (keyless). OWNER: sources-keyless agent.
 *
 * Discovery: one public Atom feed per seed channel,
 *   GET https://www.youtube.com/feeds/videos.xml?channel_id=<UC...>
 * The feed lists only the 15 most recent uploads, with `media:statistics@views` and
 * `media:starRating@count` (likes). No comments, no duration, no tags.
 *
 * Refresh: RSS cannot look videos up by id, so `ctx.refreshIds` is ignored; a video is observed again only
 * while it is still in one of its channel's feeds (documented in `notes`; the pipeline counts the tracked videos
 * that were due but did not reappear).
 *
 * Fast channels: a 15-entry channel feed of a news or drama channel spans only hours (measured 2026-09-28: under
 * 24 h for 41 of 391 seed channels, under 7 days for 109), so most of their uploads could never be re-observed.
 * When the channel feed is full (15 entries) and spans less than FAST_CHANNEL_SPAN_MS, the channel's long-form
 * and Shorts uploads playlists are read as well (`playlist_id=UULF…` / `UUSH…`, same channel id without the
 * `UC` prefix; each also lists 15 entries with the same statistics). Entries are merged by video id; playlist
 * membership sets the format (UUSH = short, UULF = long). The channel feed is always read first, so live and
 * premiere entries (in neither playlist) are kept. These extra requests run after every channel feed, so a tight
 * budget never costs a channel its main feed.
 *
 * Breaker: after CONSECUTIVE_FAILURE_LIMIT consecutive network errors / 429 / 5xx (YouTube throttling the runner)
 * the adapter stops and returns what it has, so one throttled source cannot eat the whole collection step.
 */
import { XMLParser } from 'fast-xml-parser';
import type { VideoFormat } from '@vti/core';
import type { CollectContext, CollectResult, RawAccount, RawVideo, SourceAdapter, YoutubeChannelSeed } from '../types.ts';
import {
  RequestBudget,
  cleanDescription,
  declaredLanguageConflicts,
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

export function youtubePlaylistFeedUrl(playlistId: string): string {
  return `${FEED_BASE}?playlist_id=${encodeURIComponent(playlistId)}`;
}

/** Uploads playlists of a channel: `UULF…` long-form, `UUSH…` Shorts (null for a malformed channel id). */
export function uploadsPlaylists(channelId: string): { long: string; shorts: string } | null {
  if (!/^UC[A-Za-z0-9_-]{22}$/.test(channelId)) return null;
  const rest = channelId.slice(2);
  return { long: `UULF${rest}`, shorts: `UUSH${rest}` };
}

/** Entries per feed (YouTube's fixed limit). */
export const FEED_ENTRY_LIMIT = 15;
/** A full channel feed spanning less than this also gets its long-form and Shorts playlist feeds. */
export const FAST_CHANNEL_SPAN_MS = 7 * 86_400_000;
/** Consecutive network errors / 429 / 5xx after which the adapter stops requesting (partial result). */
export const CONSECUTIVE_FAILURE_LIMIT = 10;

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

/**
 * Language of a feed entry: detected from the title/description script (Hangul -> ko, Kana -> ja), else the seed
 * channel's language as a HINT. The hint is not a detection and not a source declaration, so its languageSource
 * is null (the Video contract has no "seed" provenance yet); it is dropped when it contradicts the text (a `ko`
 * channel posting an English-only title, e.g. Arirang News).
 */
export function entryLanguage(title: string, description: string | null, seedLanguage: string | null | undefined): { language: string | null; languageSource: 'detected' | null } {
  const detected = detectLanguage(title, description);
  if (detected) return { language: detected, languageSource: 'detected' };
  const hint = normalizeLanguage(seedLanguage);
  if (!hint || declaredLanguageConflicts(hint, title, description)) return { language: null, languageSource: null };
  return { language: hint, languageSource: null };
}

export function entryToRawVideo(
  entry: ParsedEntry,
  seed: YoutubeChannelSeed,
  account: RawAccount,
  now: number,
  format?: VideoFormat,
): RawVideo | null {
  const videoId = entry.videoId;
  const publishedAt = parseTime(entry.published);
  if (!videoId || publishedAt == null) return null;
  const url = entry.url ?? `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  const title = entry.title ?? '';
  const description = cleanDescription(entry.description);
  const { language, languageSource } = entryLanguage(title, entry.description, seed.language);
  return {
    platform: 'youtube',
    platformId: videoId,
    url,
    title,
    description,
    thumbnail: entry.thumbnail,
    publishedAt,
    durationSec: null,
    format: format ?? (/\/shorts\//.test(url) ? 'short' : 'long'),
    account,
    language,
    languageSource,
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

function isThrottleOrNetwork(status: number | null): boolean {
  return status === null || status === 429 || status >= 500;
}

async function collect(ctx: CollectContext): Promise<CollectResult> {
  const videos: RawVideo[] = [];
  const byId = new Map<string, RawVideo>();
  const accounts: RawAccount[] = [];
  const errors: string[] = [];
  const budget = new RequestBudget(ctx.http, ctx.maxRequests);
  let consecutiveFailures = 0;
  let broken = false;

  // De-duplicate seeds by channel id (first seed wins: it carries category/country/language).
  const seeds: YoutubeChannelSeed[] = [];
  const seedIds = new Set<string>();
  for (const s of ctx.seeds?.youtubeChannels ?? []) {
    const id = str(s?.channelId);
    if (!id || seedIds.has(id)) continue;
    seedIds.add(id);
    seeds.push({ ...s, channelId: id });
  }

  const fetchFeed = async (url: string): Promise<{ xml: string } | { status: number | null; error: unknown }> => {
    try {
      budget.take();
      const xml = await ctx.http.getText(url);
      consecutiveFailures = 0;
      return { xml };
    } catch (err) {
      const status = httpStatusOf(err);
      if (isThrottleOrNetwork(status)) consecutiveFailures++;
      else consecutiveFailures = 0;
      if (consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) broken = true;
      return { status, error: err };
    }
  };

  /* ---------------------------------------------------------------- pass 1: channel feeds */
  const fast: { seed: YoutubeChannelSeed; account: RawAccount }[] = [];
  let fetched = 0;
  for (let i = 0; i < seeds.length; i++) {
    const seed = seeds[i];
    if (broken || !budget.has()) {
      const skipped = seeds.length - i;
      const list = `${seeds
        .slice(i, i + 5)
        .map((s) => s.channelId)
        .join(', ')}${skipped > 5 ? ', …' : ''}`;
      errors.push(
        broken
          ? `연속 ${CONSECUTIVE_FAILURE_LIMIT}회 네트워크 오류·429·5xx(요청 제한 추정)로 수집 중단: 시드 채널 ${skipped}개 미수집 (${list})`
          : `요청 한도(maxRequests=${ctx.maxRequests}) 도달: 시드 채널 ${skipped}개 미수집 (${list})`,
      );
      break;
    }
    const res = await fetchFeed(youtubeFeedUrl(seed.channelId));
    if (!('xml' in res)) {
      if (res.status === 404) errors.push(`채널 ${seed.channelId} (${seed.name}) RSS 없음(HTTP 404): 채널 ID 확인 필요`);
      else errors.push(`채널 ${seed.channelId} RSS 요청 실패${res.status ? `(HTTP ${res.status})` : ''}: ${errorMessage(res.error)}`);
      continue;
    }
    const feed = parseYoutubeFeed(res.xml);
    if (!feed) {
      errors.push(`채널 ${seed.channelId} RSS 응답이 Atom 피드가 아님(동의 페이지/오류 페이지일 수 있음)`);
      continue;
    }
    fetched++;
    const account = accountFor(seed, feed);
    let added = 0;
    let bad = 0;
    let oldest = Number.POSITIVE_INFINITY;
    for (const entry of feed.entries) {
      const v = entryToRawVideo(entry, seed, account, ctx.now);
      if (!v) {
        bad++;
        continue;
      }
      oldest = Math.min(oldest, v.publishedAt);
      if (byId.has(v.platformId)) continue;
      byId.set(v.platformId, v);
      videos.push(v);
      added++;
    }
    if (bad) errors.push(`채널 ${seed.channelId}: 항목 ${bad}개 파싱 불가(영상 ID/게시일 없음)`);
    if (added === 0) accounts.push(account);
    if (feed.entries.length >= FEED_ENTRY_LIMIT && ctx.now - oldest < FAST_CHANNEL_SPAN_MS && uploadsPlaylists(seed.channelId)) {
      fast.push({ seed, account });
    }
  }

  /* ---------------------------------------------------------------- pass 2: uploads playlists of fast channels */
  let playlistFeeds = 0;
  let playlistAdded = 0;
  for (let i = 0; i < fast.length && !broken; i++) {
    const { seed, account } = fast[i];
    const lists = uploadsPlaylists(seed.channelId)!;
    for (const [playlistId, format] of [
      [lists.long, 'long'],
      [lists.shorts, 'short'],
    ] as const) {
      if (broken) break;
      if (!budget.has()) {
        errors.push(`요청 한도(maxRequests=${ctx.maxRequests}) 도달: 업로드가 빠른 채널 ${fast.length - i}개의 긴 영상·Shorts 재생목록 피드 미수집`);
        i = fast.length;
        break;
      }
      const res = await fetchFeed(youtubePlaylistFeedUrl(playlistId));
      if (!('xml' in res)) {
        // 404: the channel has no uploads of that kind (e.g. no Shorts) - not an error.
        if (res.status !== 404) errors.push(`채널 ${seed.channelId} 재생목록 ${playlistId.slice(0, 4)} 피드 요청 실패${res.status ? `(HTTP ${res.status})` : ''}: ${errorMessage(res.error)}`);
        continue;
      }
      const feed = parseYoutubeFeed(res.xml);
      if (!feed) continue;
      playlistFeeds++;
      for (const entry of feed.entries) {
        if (entry.channelId && entry.channelId !== seed.channelId) continue; // only the channel's own uploads
        const existing = entry.videoId ? byId.get(entry.videoId) : undefined;
        if (existing) {
          existing.format = format; // playlist membership beats the /shorts/ link heuristic
          continue;
        }
        const v = entryToRawVideo(entry, seed, account, ctx.now, format);
        if (!v) continue;
        byId.set(v.platformId, v);
        videos.push(v);
        playlistAdded++;
      }
    }
  }
  if (broken && fast.length && playlistFeeds < fast.length * 2) {
    errors.push(`연속 ${CONSECUTIVE_FAILURE_LIMIT}회 네트워크 오류·429·5xx(요청 제한 추정)로 재생목록 피드 수집 중단`);
  }

  ctx.log?.info?.(
    `[${ID}] channels ${fetched}/${seeds.length}, fast channels ${fast.length} (playlist feeds ${playlistFeeds}, +${playlistAdded} videos), videos ${videos.length}, requests ${budget.used}, errors ${errors.length}`,
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
    '시드 채널 목록(seeds/youtube-channels.json)의 공개 RSS 피드(https://www.youtube.com/feeds/videos.xml?channel_id=…)에서 채널별 최신 업로드 15개를 수집합니다. 업로드가 빨라 15개가 7일도 안 되는 채널은 긴 영상(UULF)·Shorts(UUSH) 재생목록 피드도 함께 읽어 각각 최신 15개를 더 관측합니다. 키워드 검색이나 시장 전체 발견은 하지 않습니다.',
  notes: [
    '채널별 최신 업로드 15개만 관측됩니다(업로드가 빠른 채널은 긴 영상·Shorts 재생목록에서 각각 15개 더). 모든 피드에서 밀려난 영상은 더 이상 관측되지 않으므로 이후 기간의 증가량·V7/V30은 계산할 수 없습니다(미관측). 실행마다 갱신 주기가 되었는데 피드에 다시 나타나지 않은 추적 영상 수를 기록합니다.',
    '조회수는 RSS의 media:statistics(공개 조회수), 좋아요는 media:starRating count(공개 좋아요 수) 값을 그대로 사용합니다.',
    '좋아요 수가 0으로 표시되면 비공개(숨김)와 실제 0을 구분할 수 없어 미제공(null)으로 처리합니다.',
    '댓글 수·공유 수·영상 길이·태그는 RSS에서 제공되지 않습니다(미제공, 0이 아님).',
    'YouTube Shorts는 2025년 3월부터 재생·반복 재생을 조회수로 집계하도록 정의가 바뀌었습니다. 이전 기간과 비교할 때 주의하세요.',
    '형식: Shorts 재생목록(UUSH)에 있으면 short, 긴 영상 재생목록(UULF)에 있으면 long이고, 재생목록을 읽지 않은 채널은 영상 링크가 /shorts/ 이면 short, 그 외 long입니다. 라이브 여부는 RSS로 구분할 수 없습니다.',
    '언어는 제목·설명의 문자(한글→ko, 가나→ja)로 판별한 값(검출)입니다. 판별되지 않으면 시드 채널의 언어를 참고값으로 쓰되 검출값으로 표시하지 않고(출처 미표기), 제목·설명이 라틴 문자뿐인데 시드 언어가 ko/ja이면 쓰지 않습니다(예: 영어 제목의 한국 채널 영상).',
    '국가는 시드 목록에 적힌 채널(제작자) 국가로, 원천(YouTube)이 제공한 값이 아니며 시청자 지역도 아닙니다.',
    '연속 10회 네트워크 오류·429·5xx가 나면(요청 제한 추정) 수집을 멈추고 그때까지 받은 결과만 저장합니다.',
  ],
  docsUrl: 'https://www.youtube.com/t/terms',
  version: 1,
  isEnabled: () => true,
  collect,
};
