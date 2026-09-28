/**
 * Source adapter: peertube (keyless). OWNER: sources-keyless agent.
 *
 * Discovery: SepiaSearch (the PeerTube federation search index run by Framasoft)
 *   GET https://sepiasearch.org/api/v1/search/videos?start=&count=&sort=&nsfw=false[&search=][&languageOneOf[]=ko]
 * Verified 2026-09-28: an EMPTY `search=` parameter is rejected with 400 ("Should have a valid search"), so the
 * parameter is omitted when a seed has no search text; `languageOneOf[]` (also accepted without brackets) filters
 * by the uploader-declared language; `count` up to 100 per page.
 *
 * Counters come ONLY from the video's ORIGIN instance, GET https://<host>/api/v1/videos/<uuid> (404 -> deleted,
 * 401/403 -> private). SepiaSearch is used for discovery and metadata: its counters lag the origin by hours to days
 * (2026-09-28: 650 vs 662 views, item updatedAt ~40 h old), so stamping them with the fetch time would pass stale
 * values off as exact. Origin requests go in priority order — the tiered refresh list (freshest first, including
 * ids discovery returned again), then newly discovered videos (newest first) — until the request budget or
 * PEERTUBE_ORIGIN_TIME_BUDGET_MS runs out. A discovered video whose origin was not read this run is returned
 * with metadata only (all counters null: the pipeline records the sighting, not an observation); being never
 * observed it is due first in the next run.
 *
 * Untrusted input: every instance in the federation can publish arbitrary JSON. Hosts must be public DNS names
 * (no IP literal, port, `localhost`, `.local` / `.internal`…, and — checked before any request — no name that
 * resolves to a loopback / private / link-local address); `url` is accepted only as https on the video's own
 * host, other URLs only as http(s). An instance that fails at the network level (or with 5xx) twice is skipped
 * for the rest of the run.
 *
 * Id scheme (stable): `platformId = "<uuid>@<host>"`, where host is the origin instance of the video (the
 * channel's host, which is also the host of the canonical watch URL). The uuid is globally unique, the host is
 * needed to refresh, and '@' (unlike '/') keeps `peertube:<uuid>@<host>` safe to use in URL paths. Accounts use
 * the fediverse form `<name>@<host>`.
 */
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import type { VideoStatus } from '@vti/core';
import type { CollectContext, CollectResult, PeertubeQuerySeed, RawAccount, RawVideo, SourceAdapter } from '../types.ts';
import {
  RequestBudget,
  cleanDescription,
  declaredLanguageConflicts,
  decodeEntities,
  detectLanguage,
  errorMessage,
  formatFromDuration,
  httpStatusOf,
  normalizeLanguage,
  parseTime,
  safeCount,
  safeHttpUrl,
  str,
  uniqueStrings,
} from './util.ts';

const ID = 'peertube';
export const SEPIA_SEARCH = 'https://sepiasearch.org/api/v1/search/videos';
export const PEERTUBE_PAGE_MAX = 100;
/** Origin requests stop after this long, so a run with many slow instances still returns what it collected. */
export const PEERTUBE_ORIGIN_TIME_BUDGET_MS = 5 * 60_000;
/** Failures (network error or 5xx, after the client's retries) after which an instance is skipped for the run. */
export const PEERTUBE_HOST_FAILURE_LIMIT = 2;

type PtVideo = Record<string, unknown>;
type PtObj = Record<string, unknown>;

interface SepiaPage {
  total?: number;
  data?: PtVideo[];
  errors?: unknown;
  error?: unknown;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Public DNS name: at least two labels, letters-only (or punycode) TLD. No port, no IP literal. */
const HOST_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/i;
/** Names that never denote a public PeerTube instance. */
const NON_PUBLIC_HOST_RE = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|home\.arpa)$/i;

/** True when `host` is a public DNS host name we may send requests to (syntax only; `collect` also checks the resolved addresses). */
export function isPublicHostName(host: string): boolean {
  return HOST_RE.test(host) && !NON_PUBLIC_HOST_RE.test(host) && isIP(host) === 0;
}

/** Address ranges an instance host must never resolve to (loopback, private, link-local, CGNAT, multicast…). */
const BLOCKED_ADDRESSES = (() => {
  const b = new BlockList();
  for (const [net, prefix] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ] as const) {
    b.addSubnet(net, prefix, 'ipv4');
  }
  for (const [net, prefix] of [
    ['::', 128],
    ['::1', 128],
    ['fc00::', 7],
    ['fe80::', 10],
    ['ff00::', 8],
  ] as const) {
    b.addSubnet(net, prefix, 'ipv6');
  }
  return b;
})();

/** True for loopback / private / link-local / CGNAT / multicast / unspecified addresses (and non-IP input). */
export function isNonPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) is judged by its IPv4 address. (A ::ffff:0:0/96 rule in the BlockList
  // would also match every plain IPv4 address: BlockList compares IPv4 rules and mapped addresses as one.)
  const mapped = /^::ffff:(d{1,3}(?:.d{1,3}){3})$/i.exec(address);
  if (mapped) return isNonPublicAddress(mapped[1]);
  return BLOCKED_ADDRESSES.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/** Resolves a host name to its addresses. Replaceable for tests (`setPeertubeHostResolver`). */
export type HostResolver = (host: string) => Promise<string[]>;

const dnsResolver: HostResolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((r) => r.address);
let hostResolver: HostResolver = dnsResolver;

/** Test hook: replace the DNS resolver used by the private-address guard (null restores DNS). */
export function setPeertubeHostResolver(resolver: HostResolver | null): void {
  hostResolver = resolver ?? dnsResolver;
}

/** `<uuid>@<host>` */
export function peertubePlatformId(uuid: string, host: string): string {
  return `${uuid.toLowerCase()}@${host.toLowerCase()}`;
}

/** Inverse of `peertubePlatformId`; null when the id is not `<uuid>@<public host name>`. */
export function parsePeertubePlatformId(id: string): { uuid: string; host: string } | null {
  const at = id.lastIndexOf('@');
  if (at <= 0) return null;
  const uuid = id.slice(0, at);
  const host = id.slice(at + 1);
  if (!UUID_RE.test(uuid) || !isPublicHostName(host)) return null;
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

/** Host of an https URL when it is a public host name, else null. */
function httpsHostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.port) return null;
    const host = u.hostname.toLowerCase();
    return isPublicHostName(host) ? host : null;
  } catch {
    return null;
  }
}

function validHost(v: unknown): string | null {
  const h = str(v)?.toLowerCase() ?? null;
  return h && isPublicHostName(h) ? h : null;
}

function absolutize(pathOrUrl: string | null, host: string): string | null {
  if (!pathOrUrl) return null;
  if (/^https?:\/\//i.test(pathOrUrl)) return safeHttpUrl(pathOrUrl);
  if (pathOrUrl.startsWith('/') && !pathOrUrl.startsWith('//')) return `https://${host}${pathOrUrl}`;
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

/**
 * Origin host of a video: the channel's host (the instance that owns the video), then the account's host, then
 * the host of an https watch URL. Only public host names are accepted.
 */
export function peertubeOriginHost(v: PtVideo): string | null {
  return validHost(o(v.channel)?.host) ?? validHost(o(v.account)?.host) ?? httpsHostOf(str(v.url));
}

/** Canonical watch URL: the item's own `url` only when it is https on the origin host. */
export function peertubeWatchUrl(v: PtVideo, host: string, uuid: string): string {
  const url = str(v.url);
  return url && httpsHostOf(url) === host ? url : `https://${host}/videos/watch/${uuid.toLowerCase()}`;
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
  const host = validHost(acc.host) ?? httpsHostOf(str(acc.url)) ?? fallbackHost;
  if (!name || !host || /[\s/@?#]/.test(name)) return null;
  const accUrl = str(acc.url);
  return {
    platform: 'peertube',
    platformId: `${name}@${host}`,
    handle: `@${name}@${host}`,
    name: str(decodeEntities(str(acc.displayName) ?? '')) ?? name,
    url: accUrl && httpsHostOf(accUrl) === host ? accUrl : `https://${host}/accounts/${encodeURIComponent(name)}`,
    avatar: pickAvatar(acc, host),
    country: null,
    followers: safeCount(acc.followersCount),
  };
}

/** Language: the uploader's declaration unless it contradicts the text's script (then detection, else null). */
function peertubeLanguage(declared: string | null, title: string, description: string | null, tags: string[]): { language: string | null; source: 'source' | 'detected' | null; conflict: boolean } {
  const conflict = declared !== null && declaredLanguageConflicts(declared, title, description, tags.join(' '));
  if (declared && !conflict) return { language: declared, source: 'source', conflict: false };
  const detected = detectLanguage(title, description, tags.join(' '));
  return { language: detected, source: detected ? 'detected' : null, conflict };
}

/**
 * Map an origin-API (or SepiaSearch) video object. `withCounters: false` (SepiaSearch items) returns metadata only:
 * all counters null, because the index's copies are stale.
 */
export function peertubeToRawVideo(v: PtVideo, observedAt: number, discoveredVia: string, opts: { withCounters?: boolean } = {}): RawVideo | null {
  const uuid = str(v.uuid);
  const host = peertubeOriginHost(v);
  const publishedAt = parseTime(v.publishedAt) ?? parseTime(v.createdAt);
  if (!uuid || !UUID_RE.test(uuid) || !host || publishedAt == null) return null;
  const account = peertubeAccount(v, host);
  if (!account) return null;
  const title = str(decodeEntities(str(v.name) ?? '')) ?? '';
  const rawDescription = typeof v.description === 'string' ? v.description : typeof v.truncatedDescription === 'string' ? v.truncatedDescription : null;
  const description = rawDescription === null ? null : decodeEntities(rawDescription);
  const tags = Array.isArray(v.tags) ? uniqueStrings(v.tags.map((t) => (typeof t === 'string' ? decodeEntities(t) : t))) : [];
  const lang = peertubeLanguage(normalizeLanguage(o(v.language)?.id), title, description, tags);
  const category = o(v.category);
  const categoryLabel = category && category.id != null ? str(category.label) : null;
  const duration = safeCount(v.duration);
  const withCounters = opts.withCounters ?? true;
  return {
    platform: 'peertube',
    platformId: peertubePlatformId(uuid, host),
    url: peertubeWatchUrl(v, host, uuid),
    title,
    description: cleanDescription(description),
    thumbnail: absolutize(str(v.thumbnailUrl) ?? str(v.thumbnailPath), host),
    publishedAt,
    durationSec: duration,
    format: formatFromDuration(duration, v.isLive === true),
    account,
    language: lang.language,
    languageSource: lang.source,
    country: null,
    sourceCategory: categoryLabel ? `peertube:${categoryLabel}` : null,
    tags,
    counters: withCounters
      ? {
          views: safeCount(v.views),
          likes: safeCount(v.likes),
          // Only newer PeerTube versions expose a comment count; absent -> null (not 0).
          comments: 'comments' in v ? safeCount(v.comments) : null,
          shares: null,
        }
      : { views: null, likes: null, comments: null, shares: null },
    observedAt,
    status: 'active',
    discoveredVia,
  };
}

/** True when the uploader-declared language of a SepiaSearch/origin item contradicts its text (for run logs). */
export function peertubeLanguageConflict(v: PtVideo): boolean {
  const declared = normalizeLanguage(o(v.language)?.id);
  const title = str(v.name) ?? '';
  const description = typeof v.description === 'string' ? v.description : typeof v.truncatedDescription === 'string' ? v.truncatedDescription : null;
  const tags = Array.isArray(v.tags) ? uniqueStrings(v.tags) : [];
  return declared !== null && declaredLanguageConflicts(declared, title, description, tags.join(' '));
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

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), ms)))]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function collect(ctx: CollectContext): Promise<CollectResult> {
  const errors: string[] = [];
  const gone: { platformId: string; status: VideoStatus }[] = [];
  const budget = new RequestBudget(ctx.http, ctx.maxRequests);
  let invalid = 0;
  let languageConflicts = 0;

  /* ---------------------------------------------------------------- discovery (metadata only) */
  // platformId -> metadata-only RawVideo, in discovery order
  const discovered = new Map<string, RawVideo>();
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
        const raw = peertubeToRawVideo(v, ctx.now, via, { withCounters: false });
        if (!raw) {
          invalid++;
          continue;
        }
        if (discovered.has(raw.platformId)) continue;
        if (peertubeLanguageConflict(v)) languageConflicts++;
        discovered.set(raw.platformId, raw);
      }
      const total = safeCount(body.total);
      if (data.length < count || (total != null && start + data.length >= total)) break;
    }
  }

  /* ---------------------------------------------------------------- counters from the origin instances */
  // Priority: the tiered refresh list (already ordered, freshest first), then newly discovered videos, newest first.
  const refreshIds = uniqueStrings(ctx.refreshIds ?? []);
  const inRefresh = new Set(refreshIds);
  const newlyDiscovered = [...discovered.values()]
    .filter((v) => !inRefresh.has(v.platformId))
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .map((v) => v.platformId);
  const queue = [...refreshIds, ...newlyDiscovered];

  const observed = new Map<string, RawVideo>();
  const hostFailures = new Map<string, number>();
  const hostChecks = new Map<string, Promise<string | null>>();
  let malformed = 0;
  let blocked = 0;
  let hostSkipped = 0;
  let deferred = 0;
  let timeStop = false;
  const originStart = Date.now();

  /** null when the host may be contacted, else the reason it may not. */
  const hostProblem = (host: string): Promise<string | null> => {
    let p = hostChecks.get(host);
    if (!p) {
      p = (async () => {
        if (!isPublicHostName(host)) return 'not a public host name';
        let addresses: string[] | null = null;
        try {
          addresses = await withTimeout(hostResolver(host), 5_000);
        } catch {
          addresses = null; // resolution failed: the request would fail the same way, so let it report that
        }
        const bad = (addresses ?? []).find(isNonPublicAddress);
        return bad ? `resolves to non-public address ${bad}` : null;
      })();
      hostChecks.set(host, p);
    }
    return p;
  };

  for (let i = 0; i < queue.length; i++) {
    const platformId = queue[i];
    const parsed = parsePeertubePlatformId(platformId);
    if (!parsed) {
      malformed++;
      continue;
    }
    if (!budget.has()) {
      deferred = queue.length - i;
      break;
    }
    if (Date.now() - originStart > PEERTUBE_ORIGIN_TIME_BUDGET_MS) {
      deferred = queue.length - i;
      timeStop = true;
      break;
    }
    if ((hostFailures.get(parsed.host) ?? 0) >= PEERTUBE_HOST_FAILURE_LIMIT) {
      hostSkipped++;
      continue;
    }
    const problem = await hostProblem(parsed.host);
    if (problem) {
      blocked++;
      ctx.log?.warn?.(`[${ID}] skipping ${platformId}: host ${problem}`);
      continue;
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
      const via = discovered.get(platformId)?.discoveredVia ?? 'peertube:refresh';
      const raw = peertubeToRawVideo(v, ctx.now, via);
      if (!raw) {
        invalid++;
        continue;
      }
      // Keep the requested id even if the instance reports a different canonical host (id stability).
      raw.platformId = platformId;
      observed.set(platformId, raw);
    } catch (err) {
      const status = httpStatusOf(err);
      if (status === 404 || status === 410) gone.push({ platformId, status: 'deleted' });
      else if (status === 401 || status === 403) gone.push({ platformId, status: 'private' });
      else {
        if (status === null || status >= 500) hostFailures.set(parsed.host, (hostFailures.get(parsed.host) ?? 0) + 1);
        errors.push(`원 인스턴스 조회 ${platformId} 실패${status ? `(HTTP ${status})` : ''}: ${errorMessage(err)}`);
      }
    }
  }

  // Result: origin observations, plus metadata-only rows for discovered videos whose origin was not read.
  const videos: RawVideo[] = [...observed.values()];
  let metadataOnly = 0;
  for (const [id, raw] of discovered) {
    if (observed.has(id)) continue;
    videos.push(raw);
    metadataOnly++;
  }

  if (malformed) errors.push(`갱신 ID ${malformed}개가 '<uuid>@<공개 호스트>' 형식이 아니어서 건너뜀`);
  if (invalid) errors.push(`필수 필드(uuid/공개 호스트/publishedAt/account)가 없거나 잘못된 항목 ${invalid}개 제외`);
  if (blocked) errors.push(`내부·사설 주소로 연결되는 인스턴스의 영상 ${blocked}개는 요청하지 않음`);
  const skippedHosts = [...hostFailures].filter(([, n]) => n >= PEERTUBE_HOST_FAILURE_LIMIT).map(([h]) => h);
  if (hostSkipped) {
    errors.push(`응답하지 않는 인스턴스 ${skippedHosts.length}곳(${skippedHosts.slice(0, 5).join(', ')}${skippedHosts.length > 5 ? ', …' : ''})의 영상 ${hostSkipped}개는 이번 실행에서 건너뜀`);
  }
  if (timeStop) errors.push(`원 인스턴스 조회 시간 한도(${Math.round(PEERTUBE_ORIGIN_TIME_BUDGET_MS / 60_000)}분) 도달: ${deferred}개는 다음 실행으로 미룸`);
  ctx.log?.info?.(
    `[${ID}] discovered ${discovered.size}, origin observations ${observed.size}, metadata only ${metadataOnly}, deferred ${timeStop ? 0 : deferred}, ` +
      `gone ${gone.length}, declared-language conflicts ${languageConflicts}, requests ${budget.used}/${ctx.maxRequests}, errors ${errors.length}`,
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
    'PeerTube 연합 검색 색인 SepiaSearch(https://sepiasearch.org/api/v1/search/videos)에서 시드 조건(검색어, 영상 언어, 정렬)으로 공개 영상을 찾고, 조회수·좋아요·댓글은 영상이 올라간 원 인스턴스 API(/api/v1/videos/{uuid})에서 직접 읽습니다.',
  notes: [
    'SepiaSearch에 색인된 인스턴스의 공개 영상만 대상입니다. 색인되지 않은 인스턴스와 NSFW 표시 영상은 제외됩니다.',
    '조회수·좋아요·댓글은 원 인스턴스 API에서 읽은 값만 저장합니다. SepiaSearch 색인의 값은 원 인스턴스보다 수 시간~수일 늦어(2026-09-28 확인: 650 대 662) 관측값으로 쓰지 않습니다.',
    '원 인스턴스 조회는 실행당 요청 한도 안에서 갱신 우선순위(최근 게시 영상 먼저) 순서로 합니다. 이번 실행에서 원 인스턴스를 읽지 못한 새 영상은 영상 정보만 저장하고 다음 실행에서 먼저 조회합니다.',
    '인스턴스마다 조회 집계 방식이 다를 수 있습니다. 댓글 수는 최신 PeerTube 버전의 인스턴스만 제공하며, 제공하지 않으면 미제공(null)이고 0이 아닙니다. 공유 수는 제공되지 않습니다.',
    '언어는 업로더가 지정한 값(원천)입니다. 지정 언어가 ko/ja인데 제목·설명에 한글(ja는 가나·한자)이 전혀 없고 라틴 문자만 있으면 잘못된 지정으로 보고 언어를 비웁니다(문자로 판별되면 검출값). 언어가 비어 있으면 제목·설명 문자로 추정합니다(검출).',
    '국가 정보는 제공되지 않습니다. 분야는 PeerTube 카테고리(예: peertube:Music)입니다.',
    '형식: 라이브면 live, 길이 60초 이하 short, 그 외 long (PeerTube에는 별도의 쇼츠 형식이 없음).',
    '영상 ID는 "<uuid>@<원 인스턴스 호스트>" 형식입니다. 원 인스턴스가 404를 반환하면 삭제, 401/403이면 비공개로 기록합니다. IP 주소·내부 주소로 연결되는 호스트는 요청하지 않고, 두 번 연속 응답하지 않는 인스턴스는 그 실행에서 건너뜁니다.',
  ],
  docsUrl: 'https://docs.joinpeertube.org/api-rest-reference.html',
  version: 1,
  isEnabled: () => true,
  collect,
};
