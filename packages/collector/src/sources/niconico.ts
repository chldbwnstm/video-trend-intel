/**
 * Source adapter: niconico (keyless Snapshot Search API v2). OWNER: sources-keyless agent.
 *
 * The Snapshot Search API serves a DAILY SNAPSHOT of niconico's video index, not live counters. Every
 * observation is therefore stamped with the snapshot time from
 *   GET https://snapshot.search.nicovideo.jp/api/v2/snapshot/version  -> {"last_modified": "...+09:00"}
 * and never with the fetch time. If the version cannot be read, nothing is collected (we cannot date the data).
 * The version is read again at the end of the run; if the snapshot was swapped mid-run the results are
 * discarded (they may mix two snapshots) and the next run collects them again.
 *
 * Discovery: GET /api/v2/snapshot/video/contents/search with q / targets / fields / _sort / _offset / _limit
 * (≤ 100) / filters[startTime][gte] / _context=VideoTrendIntel.
 * Refresh (verified 2026-09-28): `q=` (empty) + `targets=title` + `filters[contentId][0..99]=<id>` returns the
 * listed videos (100 ids per request). The whole due list comes in priority order (ids discovery returned are
 * skipped); batches stop at the request budget and the rest stays due for the next run. Ids absent from the snapshot are reported as gone with status `unknown`
 * (deleted, made private or otherwise withdrawn; the snapshot does not say which).
 *
 * Accounts: only the numeric userId / channelId are available without unofficial APIs, so accounts are
 * `user/<userId>` ("niconico 사용자 <id>") or `channel/<channelId>` ("niconico 채널 <id>").
 */
import type { VideoStatus } from '@vti/core';
import type { CollectContext, CollectResult, NiconicoQuerySeed, RawAccount, RawVideo, SourceAdapter } from '../types.ts';
import {
  RequestBudget,
  USER_AGENT,
  chunk,
  cleanDescription,
  decodeEntities,
  detectLanguage,
  errorJson,
  errorMessage,
  formatFromDuration,
  httpStatusOf,
  parseTime,
  safeCount,
  str,
  uniqueStrings,
} from './util.ts';

const ID = 'niconico';
export const NICONICO_BASE = 'https://snapshot.search.nicovideo.jp/api/v2/snapshot';
export const NICONICO_VERSION_URL = `${NICONICO_BASE}/version`;
export const NICONICO_SEARCH_URL = `${NICONICO_BASE}/video/contents/search`;
export const NICONICO_CONTEXT = 'VideoTrendIntel';
export const NICONICO_PAGE_MAX = 100;
/** The API rejects `_offset` above 100,000. */
export const NICONICO_OFFSET_MAX = 100_000;
export const NICONICO_FIELDS = [
  'contentId',
  'title',
  'description',
  'viewCounter',
  'likeCounter',
  'commentCounter',
  'startTime',
  'tags',
  'genre',
  'userId',
  'channelId',
  'thumbnailUrl',
  'lengthSeconds',
] as const;

const HEADERS = { 'User-Agent': USER_AGENT };
const DAY_MS = 86_400_000;

type NnVideo = Record<string, unknown>;
interface NnResponse {
  meta?: { status?: number; totalCount?: number; errorCode?: string; errorMessage?: string };
  data?: NnVideo[];
}

export function niconicoSearchUrl(seed: NiconicoQuerySeed, offset: number, limit: number, now: number): string {
  const p = new URLSearchParams();
  p.set('q', seed.q);
  p.set('targets', seed.targets);
  p.set('fields', NICONICO_FIELDS.join(','));
  p.set('_sort', seed.sort);
  p.set('_offset', String(offset));
  p.set('_limit', String(limit));
  p.set('_context', NICONICO_CONTEXT);
  const since = safeCount(seed.sinceDays);
  if (seed.sinceDays != null && since != null) {
    p.set('filters[startTime][gte]', new Date(now - since * DAY_MS).toISOString());
  }
  return `${NICONICO_SEARCH_URL}?${p.toString()}`;
}

/** Refresh URL: empty query + contentId filters (≤ 100 ids). */
export function niconicoRefreshUrl(ids: string[]): string {
  const p = new URLSearchParams();
  p.set('q', '');
  p.set('targets', 'title');
  p.set('fields', NICONICO_FIELDS.join(','));
  p.set('_sort', '-viewCounter');
  p.set('_offset', '0');
  p.set('_limit', String(Math.min(NICONICO_PAGE_MAX, Math.max(1, ids.length))));
  p.set('_context', NICONICO_CONTEXT);
  ids.forEach((id, i) => p.set(`filters[contentId][${i}]`, id));
  return `${NICONICO_SEARCH_URL}?${p.toString()}`;
}

/** `niconico:tag:<q>` for tagsExact seeds, `niconico:keyword:<q>` for keyword seeds. */
export function niconicoDiscoveredVia(seed: NiconicoQuerySeed): string {
  return `niconico:${seed.targets === 'tagsExact' ? 'tag' : 'keyword'}:${seed.q}`;
}

export function niconicoAccount(v: NnVideo): RawAccount | null {
  const channelId = str(v.channelId);
  const userId = str(v.userId);
  if (channelId) {
    const num = channelId.replace(/^ch/i, '');
    return {
      platform: 'niconico',
      platformId: `channel/${num}`,
      handle: null,
      name: `niconico 채널 ${num}`,
      url: `https://ch.nicovideo.jp/ch${num}`,
      avatar: null,
      country: null,
      followers: null,
    };
  }
  if (userId) {
    return {
      platform: 'niconico',
      platformId: `user/${userId}`,
      handle: null,
      name: `niconico 사용자 ${userId}`,
      url: `https://www.nicovideo.jp/user/${userId}`,
      avatar: null,
      country: null,
      followers: null,
    };
  }
  return null;
}

/**
 * Tags come as one space-separated string (or occasionally an array). Like titles they are HTML-escaped by the API
 * (`zebra coffee &amp; croissant`), so entities are decoded once.
 */
export function niconicoTags(v: unknown): string[] {
  if (Array.isArray(v)) return uniqueStrings(v.map((t) => (typeof t === 'string' ? decodeEntities(t) : t)));
  if (typeof v === 'string') return uniqueStrings(v.split(/[ 　]+/).map(decodeEntities));
  return [];
}

/** Title with the API's HTML escaping (`&quot;`, `&amp;`) decoded once. */
export function niconicoTitle(v: unknown): string {
  const t = str(v);
  return t ? (str(decodeEntities(t)) ?? '') : '';
}

export function niconicoToRawVideo(v: NnVideo, observedAt: number, discoveredVia: string): RawVideo | null {
  const contentId = str(v.contentId);
  const publishedAt = parseTime(v.startTime);
  const account = niconicoAccount(v);
  if (!contentId || publishedAt == null || !account) return null;
  const title = niconicoTitle(v.title);
  const rawDescription = typeof v.description === 'string' ? v.description : null;
  const description = cleanDescription(rawDescription, { html: true });
  const tags = niconicoTags(v.tags);
  const language = detectLanguage(title, description, tags.join(' '));
  const genre = str(v.genre);
  const duration = safeCount(v.lengthSeconds);
  return {
    platform: 'niconico',
    platformId: contentId,
    url: `https://www.nicovideo.jp/watch/${contentId}`,
    title,
    description,
    thumbnail: str(v.thumbnailUrl),
    publishedAt,
    durationSec: duration,
    format: formatFromDuration(duration),
    account,
    language,
    languageSource: language ? 'detected' : null,
    country: null,
    sourceCategory: genre ? `niconico:${genre}` : null,
    tags,
    counters: {
      views: safeCount(v.viewCounter),
      likes: safeCount(v.likeCounter),
      comments: safeCount(v.commentCounter),
      shares: null,
    },
    observedAt,
    status: 'active',
    discoveredVia,
  };
}

function metaError(body: NnResponse | null | undefined): string | null {
  const meta = body?.meta;
  if (!meta) return 'unexpected response (no meta)';
  if (meta.status !== 200) return `${meta.errorCode ?? 'ERROR'} ${meta.status ?? ''}: ${meta.errorMessage ?? ''}`.trim();
  if (!Array.isArray(body?.data)) return 'unexpected response (no data)';
  return null;
}

function describeError(err: unknown): string {
  const status = httpStatusOf(err);
  const json = errorJson(err) as NnResponse | null;
  const apiText = json?.meta ? metaError(json) : null;
  return `${status ? `(HTTP ${status}) ` : ''}${apiText ?? errorMessage(err)}`;
}

/** Parse `/snapshot/version` -> epoch ms of `last_modified`, or null. */
export function parseSnapshotVersion(body: unknown): number | null {
  if (!body || typeof body !== 'object') return null;
  return parseTime((body as { last_modified?: unknown }).last_modified);
}

async function collect(ctx: CollectContext): Promise<CollectResult> {
  const errors: string[] = [];
  const budget = new RequestBudget(ctx.http, ctx.maxRequests);
  const empty = (): CollectResult => ({ videos: [], accounts: [], errors });

  /* ---------------------------------------------------------------- snapshot time */
  if (!budget.has()) {
    errors.push(`요청 한도(maxRequests=${ctx.maxRequests})가 0이라 수집하지 않음`);
    return empty();
  }
  let snapshotAt: number | null = null;
  try {
    budget.take();
    snapshotAt = parseSnapshotVersion(await ctx.http.getJson(NICONICO_VERSION_URL, { headers: HEADERS }));
    if (snapshotAt == null) throw new Error('last_modified 없음');
  } catch (err) {
    errors.push(`스냅샷 시각(/snapshot/version) 확인 실패 — 관측 시각을 알 수 없어 수집하지 않음: ${describeError(err)}`);
    return empty();
  }

  const videos: RawVideo[] = [];
  const gone: { platformId: string; status: VideoStatus }[] = [];
  const seen = new Set<string>();
  let invalid = 0;
  // One request is reserved for the end-of-run version check whenever the budget allows it.
  const reserve = budget.remaining >= 2 ? 1 : 0;
  const canRequest = () => budget.remaining > reserve;

  const push = (v: NnVideo, via: string): boolean => {
    const raw = niconicoToRawVideo(v, snapshotAt!, via);
    if (!raw) {
      invalid++;
      return false;
    }
    if (seen.has(raw.platformId)) return true;
    seen.add(raw.platformId);
    videos.push(raw);
    return true;
  };

  const search = async (url: string): Promise<NnResponse> => {
    budget.take();
    const body = await ctx.http.getJson<NnResponse>(url, { headers: HEADERS });
    const e = metaError(body);
    if (e) throw Object.assign(new Error(e), { json: body });
    return body;
  };

  /* ---------------------------------------------------------------- discovery */
  const seeds = ctx.seeds?.niconico ?? [];
  let budgetStop = false;
  for (let si = 0; si < seeds.length && !budgetStop; si++) {
    const seed = seeds[si];
    const via = niconicoDiscoveredVia(seed);
    if (!str(seed.q)) {
      errors.push(`시드 ${via}: 검색어(q)가 비어 있어 생략`);
      continue;
    }
    const want = Math.max(0, Math.floor(safeCount(seed.limit) ?? 0));
    const pageSize = Math.min(NICONICO_PAGE_MAX, want);
    let got = 0;
    for (let offset = 0; got < want && offset <= NICONICO_OFFSET_MAX; offset += pageSize) {
      if (!canRequest()) {
        budgetStop = true;
        errors.push(`요청 한도(maxRequests=${ctx.maxRequests}) 도달: 시드 ${via} (offset=${offset}) 이후 및 남은 시드 ${seeds.length - si - 1}개 미수집`);
        break;
      }
      const limit = Math.min(pageSize, want - got);
      let body: NnResponse;
      try {
        body = await search(niconicoSearchUrl(seed, offset, limit, ctx.now));
      } catch (err) {
        errors.push(`시드 ${via} 실패: ${describeError(err)}`);
        break;
      }
      const data = body.data ?? [];
      for (const v of data) {
        if (got >= want) break;
        got++;
        push(v, via);
      }
      const total = safeCount(body.meta?.totalCount);
      if (data.length < limit || (total != null && offset + data.length >= total)) break;
    }
  }

  /* ---------------------------------------------------------------- refresh */
  const refreshIds = uniqueStrings(ctx.refreshIds ?? []).filter((id) => !seen.has(id));
  const batches = chunk(refreshIds, NICONICO_PAGE_MAX);
  for (let bi = 0; bi < batches.length; bi++) {
    const ids = batches[bi];
    if (!canRequest()) {
      // Budget-bound refresh: the rest stays due and goes first next run (the pipeline notes how many).
      const left = batches.slice(bi).reduce((n, b) => n + b.length, 0);
      ctx.log?.info?.(`[${ID}] request budget reached: ${left} due id(s) left for the next run`);
      break;
    }
    let body: NnResponse;
    try {
      body = await search(niconicoRefreshUrl(ids));
    } catch (err) {
      errors.push(`갱신 배치(${ids.length}개) 실패: ${describeError(err)}`);
      continue;
    }
    const returned = new Set<string>();
    for (const v of body.data ?? []) {
      const id = str(v.contentId);
      if (!id) continue;
      returned.add(id); // present in the snapshot, even if a malformed row is dropped below
      push(v, 'niconico:refresh');
    }
    for (const id of ids) if (!returned.has(id)) gone.push({ platformId: id, status: 'unknown' });
  }

  /* ---------------------------------------------------------------- snapshot consistency */
  if (budget.has()) {
    try {
      budget.take();
      const after = parseSnapshotVersion(await ctx.http.getJson(NICONICO_VERSION_URL, { headers: HEADERS }));
      if (after != null && after !== snapshotAt) {
        errors.push(
          `수집 중 스냅샷이 갱신됨(${new Date(snapshotAt).toISOString()} → ${new Date(after).toISOString()}): 두 스냅샷이 섞였을 수 있어 결과 ${videos.length}개를 폐기, 다음 실행에서 다시 수집`,
        );
        return { videos: [], accounts: [], errors };
      }
    } catch (err) {
      ctx.log?.warn?.(`[${ID}] end-of-run snapshot version check failed: ${errorMessage(err)}`);
    }
  } else {
    ctx.log?.warn?.(`[${ID}] no request budget left for the end-of-run snapshot version check`);
  }

  if (invalid) errors.push(`필수 필드(contentId/startTime/userId·channelId)가 없는 항목 ${invalid}개 제외`);
  ctx.log?.info?.(
    `[${ID}] snapshot ${new Date(snapshotAt).toISOString()}, videos ${videos.length}, gone ${gone.length}, requests ${budget.used}/${ctx.maxRequests}, errors ${errors.length}`,
  );
  return { videos, accounts: [], errors, gone };
}

export const niconico: SourceAdapter = {
  id: ID,
  platform: 'niconico',
  label: 'niconico (스냅샷 검색 API)',
  requiresCredentials: false,
  envKeys: [],
  metrics: ['views', 'likes', 'comments'],
  discovery:
    'niconico 공식 스냅샷 검색 API v2(snapshot.search.nicovideo.jp)에서 시드 검색어·태그(정렬, 최근 N일 게시 조건)로 영상을 찾고, 추적 중인 영상은 contentId 필터로 다시 관측합니다.',
  notes: [
    '스냅샷 검색 API는 하루 1회(보통 일본 시간 새벽) 갱신되는 스냅샷입니다. 관측 시각은 수집 시각이 아니라 스냅샷 시각(/snapshot/version의 last_modified)입니다.',
    '같은 스냅샷을 여러 번 수집해도 새 정보가 없으므로 niconico 영상의 기간 증가량 해상도는 최대 하루입니다.',
    '조회수(viewCounter)·좋아요(likeCounter)·댓글(commentCounter)은 스냅샷 시점의 공개값입니다. 공유 수는 제공되지 않습니다.',
    '투고자 이름·팔로워 수는 비공식 API 없이는 얻을 수 없어 계정을 "niconico 사용자 <ID>" / "niconico 채널 <ID>"로 표시합니다.',
    '언어는 제목·설명·태그의 문자(가나→ja, 한글→ko)로 추정한 값(검출)입니다. 국가 정보는 제공되지 않습니다. 분야는 niconico 장르(예: niconico:ゲーム)입니다.',
    '형식: 길이 60초 이하 short, 그 외 long.',
    '스냅샷에서 사라진 추적 영상은 삭제·비공개 여부를 구분할 수 없어 상태 미상(unknown)으로 기록합니다.',
    '제목·태그는 API가 HTML 이스케이프(&quot; &amp;)해서 돌려주므로 한 번 복원해 저장합니다.',
    '이미 수집한 최신 스냅샷보다 새 스냅샷이 나오기 전에는 같은 영상을 다시 요청하지 않습니다(같은 스냅샷을 다시 받아도 새 정보가 없음).',
  ],
  docsUrl: 'https://site.nicovideo.jp/search-api-docs/snapshot',
  version: 1,
  isEnabled: () => true,
  collect,
};
