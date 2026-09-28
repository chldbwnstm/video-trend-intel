/**
 * Source adapter: peertube (keyless). OWNER: sources-keyless agent.
 *
 * Discovery: SepiaSearch (the PeerTube federation search index run by Framasoft)
 *   GET https://sepiasearch.org/api/v1/search/videos?start=&count=&sort=&nsfw=false[&search=][&languageOneOf[]=ko]
 * Verified 2026-09-28: an EMPTY `search=` parameter is rejected with 400 ("Should have a valid search"), so the
 * parameter is omitted when a seed has no search text; `languageOneOf[]` (also accepted without brackets) filters
 * by the uploader-declared language; `count` up to 100 per page.
 *
 * Refresh: each tracked video is re-read from its ORIGIN instance, GET https://<host>/api/v1/videos/<uuid>
 * (404 -> deleted, 401/403 -> private).
 *
 * Id scheme (stable): `platformId = "<uuid>@<host>"`, where host is the origin instance of the video (taken
 * from the canonical watch URL). The uuid is globally unique, the host is needed to refresh, and '@' (unlike
 * '/') keeps `peertube:<uuid>@<host>` safe to use in URL paths. Accounts use the fediverse form `<name>@<host>`.
 */
import type { VideoStatus } from '@vti/core';
import type { CollectContext, CollectResult, PeertubeQuerySeed, RawAccount, RawVideo, SourceAdapter } from '../types.ts';
import {
  RequestBudget,
  cleanDescription,
  detectLanguage,
  errorMessage,
  formatFromDuration,
  httpStatusOf,
  normalizeLanguage,
  parseTime,
  safeCount,
  str,
  uniqueStrings,
} from './util.ts';

const ID = 'peertube';
export const SEPIA_SEARCH = 'https://sepiasearch.org/api/v1/search/videos';
export const PEERTUBE_PAGE_MAX = 100;

type PtVideo = Record<string, unknown>;
type PtObj = Record<string, unknown>;

interface SepiaPage {
  total?: number;
  data?: PtVideo[];
  errors?: unknown;
  error?: unknown;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOST_RE = /^[a-z0-9.-]+(:\d{1,5})?$/i;

/** `<uuid>@<host>` */
export function peertubePlatformId(uuid: string, host: string): string {
  return `${uuid.toLowerCase()}@${host.toLowerCase()}`;
}

/** Inverse of `peertubePlatformId`; null when the id is not in the `<uuid>@<host>` form. */
export function parsePeertubePlatformId(id: string): { uuid: string; host: string } | null {
  const at = id.lastIndexOf('@');
  if (at <= 0) return null;
  const uuid = id.slice(0, at);
  const host = id.slice(at + 1);
  if (!UUID_RE.test(uuid) || !HOST_RE.test(host)) return null;
  return { uuid: uuid.toLowerCase(), host: host.toLowerCase() };
}

export function sepiaSearchUrl(seed: PeertubeQuerySeed, start: number, count: number, now?: number): string {
  const p = new URLSearchParams();
  p.set('start', String(start));
  p.set('count', String(count));
  p.set('sort', seed.sort);
  p.set('nsfw', 'false');
  const search = str(seed.search);
  if (search) p.set('search', search);
  for (const lang of seed.languageOneOf ?? []) {
    const l = str(lang);
    if (l) p.append('languageOneOf[]', l);
  }
  // Without a start date, '-views' returns years-old videos; sinceDays bounds publication time.
  if (now !== undefined && typeof seed.sinceDays === 'number' && seed.sinceDays > 0) {
    p.set('startDate', new Date(now - seed.sinceDays * 86_400_000).toISOString());
  }
  return `${SEPIA_SEARCH}?${p.toString()}`;
}

export function peertubeVideoApiUrl(host: string, uuid: string): string {
  return `https://${host}/api/v1/videos/${encodeURIComponent(uuid)}`;
}

/** `peertube:sepia:<sort>:<langs|all>[:search]` */
export function peertubeDiscoveredVia(seed: PeertubeQuerySeed): string {
  const langs = uniqueStrings(seed.languageOneOf ?? []).join('+') || 'all';
  return `peertube:sepia:${seed.sort}:${langs}${str(seed.search) ? ':search' : ''}`;
}

function o(v: unknown): PtObj | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as PtObj) : null;
}

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host.toLowerCase() || null;
  } catch {
    return null;
  }
}

function absolutize(pathOrUrl: string | null, host: string): string | null {
  if (!pathOrUrl) return null;
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  if (pathOrUrl.startsWith('/')) return `https://${host}${pathOrUrl}`;
  return null;
}

/** Pick an avatar close to 120px from PeerTube's `avatars[]` (or legacy `avatar`). */
function pickAvatar(account: PtObj, host: string): string | null {
  const list = Array.isArray(account.avatars) ? (account.avatars as unknown[]).map(o).filter((a): a is PtObj => !!a) : [];
  const legacy = o(account.avatar);
  if (legacy) list.push(legacy);
  let best: PtObj | null = null;
  for (const a of list) {
    const w = safeCount(a.width) ?? 0;
    if (!best || Math.abs(w - 120) < Math.abs((safeCount(best.width) ?? 0) - 120)) best = a;
  }
  if (!best) return null;
  return absolutize(str(best.fileUrl) ?? str(best.url) ?? str(best.path), host);
}

/** Origin host of a video: canonical watch URL first, then channel/account host. */
export function peertubeOriginHost(v: PtVideo): string | null {
  return hostOf(str(v.url)) ?? str(o(v.channel)?.host)?.toLowerCase() ?? str(o(v.account)?.host)?.toLowerCase() ?? null;
}

/** PeerTube privacy ids: 1 public, 2 unlisted, 3 private, 4 internal, 5 password protected. */
export function peertubeGoneStatus(v: PtVideo): VideoStatus | null {
  const privacy = safeCount(o(v.privacy)?.id);
  if (privacy === 3 || privacy === 4 || privacy === 5) return 'private';
  return null;
}

export function peertubeAccount(v: PtVideo, fallbackHost: string): RawAccount | null {
  const acc = o(v.account);
  if (!acc) return null;
  const name = str(acc.name);
  const host = str(acc.host)?.toLowerCase() ?? hostOf(str(acc.url)) ?? fallbackHost;
  if (!name || !host) return null;
  return {
    platform: 'peertube',
    platformId: `${name}@${host}`,
    handle: `@${name}@${host}`,
    name: str(acc.displayName) ?? name,
    url: str(acc.url) ?? `https://${host}/accounts/${encodeURIComponent(name)}`,
    avatar: pickAvatar(acc, host),
    country: null,
    followers: safeCount(acc.followersCount),
  };
}

export function peertubeToRawVideo(v: PtVideo, observedAt: number, discoveredVia: string): RawVideo | null {
  const uuid = str(v.uuid);
  const host = peertubeOriginHost(v);
  const publishedAt = parseTime(v.publishedAt) ?? parseTime(v.createdAt);
  if (!uuid || !UUID_RE.test(uuid) || !host || publishedAt == null) return null;
  const account = peertubeAccount(v, host);
  if (!account) return null;
  const title = str(v.name) ?? '';
  const rawDescription = typeof v.description === 'string' ? v.description : typeof v.truncatedDescription === 'string' ? v.truncatedDescription : null;
  const tags = Array.isArray(v.tags) ? uniqueStrings(v.tags) : [];
  const sourceLanguage = normalizeLanguage(o(v.language)?.id);
  const detected = sourceLanguage ? null : detectLanguage(title, rawDescription, tags.join(' '));
  const language = sourceLanguage ?? detected;
  const category = o(v.category);
  const categoryLabel = category && category.id != null ? str(category.label) : null;
  const duration = safeCount(v.duration);
  return {
    platform: 'peertube',
    platformId: peertubePlatformId(uuid, host),
    url: str(v.url) ?? `https://${host}/videos/watch/${uuid}`,
    title,
    description: cleanDescription(rawDescription),
    thumbnail: absolutize(str(v.thumbnailUrl) ?? str(v.thumbnailPath), host),
    publishedAt,
    durationSec: duration,
    format: formatFromDuration(duration, v.isLive === true),
    account,
    language,
    languageSource: sourceLanguage ? 'source' : detected ? 'detected' : null,
    country: null,
    sourceCategory: categoryLabel ? `peertube:${categoryLabel}` : null,
    tags,
    counters: {
      views: safeCount(v.views),
      likes: safeCount(v.likes),
      // Only newer PeerTube versions expose a comment count; absent -> null (not 0).
      comments: 'comments' in v ? safeCount(v.comments) : null,
      shares: null,
    },
    observedAt,
    status: 'active',
    discoveredVia,
  };
}

function sepiaErrorText(body: unknown): string | null {
  const b = o(body);
  if (!b) return null;
  const errs = b.errors ?? b.error;
  if (!errs) return null;
  if (typeof errs === 'string') return errs;
  const eo = o(errs);
  if (eo) {
    const msgs = Object.entries(eo).map(([k, v]) => `${k}: ${str(o(v)?.msg) ?? JSON.stringify(v)}`);
    return msgs.join('; ');
  }
  return JSON.stringify(errs);
}

async function collect(ctx: CollectContext): Promise<CollectResult> {
  const videos: RawVideo[] = [];
  const errors: string[] = [];
  const gone: { platformId: string; status: VideoStatus }[] = [];
  const budget = new RequestBudget(ctx.http, ctx.maxRequests);
  const seen = new Set<string>();
  let invalid = 0;

  const push = (v: PtVideo, via: string): 'added' | 'dup' | 'invalid' => {
    const raw = peertubeToRawVideo(v, ctx.now, via);
    if (!raw) {
      invalid++;
      return 'invalid';
    }
    if (seen.has(raw.platformId)) return 'dup';
    seen.add(raw.platformId);
    videos.push(raw);
    return 'added';
  };

  /* ---------------------------------------------------------------- discovery */
  const seeds = ctx.seeds?.peertube ?? [];
  let budgetStop = false;
  for (let si = 0; si < seeds.length && !budgetStop; si++) {
    const seed = seeds[si];
    const via = peertubeDiscoveredVia(seed);
    const label = via + (str(seed.search) ? `「${seed.search}」` : '');
    const want = Math.max(0, Math.floor(safeCount(seed.limit) ?? 0));
    const pageSize = Math.min(PEERTUBE_PAGE_MAX, want);
    let got = 0;
    for (let start = 0; got < want; start += pageSize) {
      if (!budget.has()) {
        budgetStop = true;
        errors.push(`요청 한도(maxRequests=${ctx.maxRequests}) 도달: 시드 ${label} (start=${start}) 이후 및 남은 시드 ${seeds.length - si - 1}개 미수집`);
        break;
      }
      const count = Math.min(pageSize, want - got);
      let body: SepiaPage;
      try {
        budget.take();
        body = await ctx.http.getJson<SepiaPage>(sepiaSearchUrl(seed, start, count, ctx.now));
        const apiErr = sepiaErrorText(body);
        if (apiErr) throw new Error(apiErr);
        if (!body || !Array.isArray(body.data)) throw new Error('unexpected response (no data)');
      } catch (err) {
        const status = httpStatusOf(err);
        errors.push(`SepiaSearch 시드 ${label} 실패${status ? `(HTTP ${status})` : ''}: ${errorMessage(err)}`);
        break;
      }
      const data = body.data ?? [];
      for (const v of data) {
        if (got >= want) break;
        got++;
        if (peertubeGoneStatus(v)) continue;
        push(v, via);
      }
      const total = safeCount(body.total);
      if (data.length < count || (total != null && start + data.length >= total)) break;
    }
  }

  /* ---------------------------------------------------------------- refresh (origin instance) */
  const refreshIds = uniqueStrings(ctx.refreshIds ?? []).filter((id) => !seen.has(id));
  let malformed = 0;
  for (let i = 0; i < refreshIds.length; i++) {
    const platformId = refreshIds[i];
    const parsed = parsePeertubePlatformId(platformId);
    if (!parsed) {
      malformed++;
      continue;
    }
    if (!budget.has()) {
      errors.push(`요청 한도(maxRequests=${ctx.maxRequests}) 도달: 갱신 대상 ${refreshIds.length - i}개 미갱신`);
      break;
    }
    try {
      budget.take();
      const v = await ctx.http.getJson<PtVideo>(peertubeVideoApiUrl(parsed.host, parsed.uuid));
      if (!o(v) || !str(v.uuid)) throw new Error('unexpected response (no uuid)');
      const goneStatus = peertubeGoneStatus(v);
      if (goneStatus) {
        gone.push({ platformId, status: goneStatus });
        continue;
      }
      const raw = peertubeToRawVideo(v, ctx.now, 'peertube:refresh');
      if (!raw) {
        invalid++;
        continue;
      }
      // Keep the requested id even if the instance reports a different canonical host (id stability).
      raw.platformId = platformId;
      if (!seen.has(platformId)) {
        seen.add(platformId);
        videos.push(raw);
      }
    } catch (err) {
      const status = httpStatusOf(err);
      if (status === 404 || status === 410) gone.push({ platformId, status: 'deleted' });
      else if (status === 401 || status === 403) gone.push({ platformId, status: 'private' });
      else errors.push(`갱신 ${platformId} 실패${status ? `(HTTP ${status})` : ''}: ${errorMessage(err)}`);
    }
  }
  if (malformed) errors.push(`갱신 ID ${malformed}개가 '<uuid>@<host>' 형식이 아니어서 건너뜀`);
  if (invalid) errors.push(`필수 필드(uuid/host/publishedAt/account)가 없는 항목 ${invalid}개 제외`);

  ctx.log?.info?.(
    `[${ID}] videos ${videos.length}, gone ${gone.length}, requests ${budget.used}/${ctx.maxRequests}, errors ${errors.length}`,
  );
  return { videos, accounts: [], errors, gone };
}

export const peertube: SourceAdapter = {
  id: ID,
  platform: 'peertube',
  label: 'PeerTube (SepiaSearch)',
  requiresCredentials: false,
  envKeys: [],
  metrics: ['views', 'likes', 'comments'],
  discovery:
    'PeerTube 연합 검색 색인 SepiaSearch(https://sepiasearch.org/api/v1/search/videos)에서 시드 조건(검색어, 영상 언어, 정렬)으로 공개 영상을 찾고, 추적 중인 영상은 원 인스턴스 API(/api/v1/videos/{uuid})로 다시 관측합니다.',
  notes: [
    'SepiaSearch에 색인된 인스턴스의 공개 영상만 대상입니다. 색인되지 않은 인스턴스와 NSFW 표시 영상은 제외됩니다.',
    '조회수·좋아요는 영상이 올라간 원 인스턴스가 집계한 값입니다. 인스턴스마다 조회 집계 방식이 다를 수 있습니다.',
    '댓글 수는 최신 PeerTube 버전의 인스턴스만 제공합니다. 제공하지 않는 인스턴스의 영상은 미제공(null)이며 0이 아닙니다. 공유 수는 제공되지 않습니다.',
    '언어는 업로더가 지정한 값(원천)입니다. 실제 내용과 다른 경우가 자주 관측됩니다. 언어가 비어 있으면 제목·설명 문자로 추정합니다(검출).',
    '국가 정보는 제공되지 않습니다. 분야는 PeerTube 카테고리(예: peertube:Music)입니다.',
    '형식: 라이브면 live, 길이 60초 이하 short, 그 외 long (PeerTube에는 별도의 쇼츠 형식이 없음).',
    '영상 ID는 "<uuid>@<원 인스턴스 호스트>" 형식입니다. 원 인스턴스가 404를 반환하면 삭제, 401/403이면 비공개로 기록합니다.',
  ],
  docsUrl: 'https://docs.joinpeertube.org/api-rest-reference.html',
  version: 1,
  isEnabled: () => true,
  collect,
};
