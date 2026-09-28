/**
 * Source adapter: dailymotion (keyless public Data API). OWNER: sources-keyless agent.
 *
 * Discovery: `GET https://api.dailymotion.com/videos` for each `ctx.seeds.dailymotion` query
 * (channel / country / language / sort / search), paginated with `limit` (max 100) + `page`.
 * Seeds without a country: the API localizes such results to the CALLER's location (verified 2026-09-28: the same
 * trending query returned only AU videos from Australia and US videos from a GitHub runner; `localization=fr_FR`
 * returned FR). Those seeds therefore always send an explicit `localization` (default en_US, env
 * DAILYMOTION_GLOBAL_LOCALIZATION) so the "global" set does not change with the machine that collects it.
 *
 * Refresh: `GET /videos?ids=<≤100 comma separated>&limit=100` (without `limit` the API returns only 10!).
 * The whole due list comes in priority order; ids discovery already returned are skipped and batches stop at the
 * request budget (the pipeline reports how many due ids were left for the next run).
 * Ids missing from a refresh batch are probed individually with `GET /video/<id>` right after their batch, while
 * the request budget allows: 404 "does not exist or has been deleted" -> `deleted`, 403 / `private: true` ->
 * `private`; ids that cannot be probed are reported as `unknown`.
 */
import type { MetricKey, VideoStatus } from '@vti/core';
import type { CollectContext, CollectResult, DailymotionQuerySeed, RawAccount, RawVideo, SourceAdapter } from '../types.ts';
import {
  RequestBudget,
  chunk,
  cleanDescription,
  errorJson,
  errorMessage,
  formatFromDuration,
  httpStatusOf,
  normalizeCountry,
  normalizeLanguage,
  parseTime,
  safeCount,
  str,
  uniqueStrings,
} from './util.ts';

const ID = 'dailymotion';
export const DAILYMOTION_API = 'https://api.dailymotion.com';
export const DAILYMOTION_PAGE_MAX = 100;
/** The API refuses `page * limit > 1000`. */
export const DAILYMOTION_RESULT_CAP = 1000;

export const DAILYMOTION_FIELDS = [
  'id',
  'title',
  'description',
  'created_time',
  'duration',
  'mode',
  'views_total',
  'views_last_day',
  'views_last_week',
  'views_last_month',
  'likes_total',
  'channel',
  'language',
  'country',
  'tags',
  'thumbnail_360_url',
  'url',
  'private',
  'status',
  'owner.id',
  'owner.screenname',
  'owner.username',
  'owner.url',
  'owner.avatar_80_url',
  'owner.followers_total',
  'owner.country',
] as const;

type DmVideo = Record<string, unknown>;

interface DmList {
  page?: number;
  limit?: number;
  total?: number;
  has_more?: boolean;
  list?: DmVideo[];
  error?: unknown;
}

/** Localization sent with seeds that have no country (see the file header). */
export const DAILYMOTION_DEFAULT_LOCALIZATION = 'en_US';
const LOCALIZATION_RE = /^[a-z]{2}_[A-Z]{2}$/;

/** Localization for country-less seeds: env DAILYMOTION_GLOBAL_LOCALIZATION (`ll_CC`) or the default. */
export function dailymotionGlobalLocalization(env?: Record<string, string | undefined>): string {
  const v = env?.DAILYMOTION_GLOBAL_LOCALIZATION?.trim();
  return v && LOCALIZATION_RE.test(v) ? v : DAILYMOTION_DEFAULT_LOCALIZATION;
}

/** Build the `/videos` search URL for one seed page. */
export function dailymotionSearchUrl(seed: DailymotionQuerySeed, page: number, limit: number, localization: string = DAILYMOTION_DEFAULT_LOCALIZATION): string {
  const p = new URLSearchParams();
  p.set('fields', DAILYMOTION_FIELDS.join(','));
  if (seed.channel) p.set('channel', seed.channel);
  if (seed.country) p.set('country', seed.country.toLowerCase());
  else p.set('localization', localization);
  if (seed.language) p.set('language', seed.language.toLowerCase());
  if (seed.search) p.set('search', seed.search);
  p.set('sort', seed.sort);
  p.set('limit', String(limit));
  p.set('page', String(page));
  return `${DAILYMOTION_API}/videos?${p.toString()}`;
}

/** Build the `/videos?ids=` refresh URL (≤ 100 ids). `limit` is mandatory: the API default is 10. */
export function dailymotionIdsUrl(ids: string[]): string {
  const p = new URLSearchParams();
  p.set('fields', DAILYMOTION_FIELDS.join(','));
  p.set('ids', ids.join(','));
  p.set('limit', String(Math.min(DAILYMOTION_PAGE_MAX, Math.max(1, ids.length))));
  return `${DAILYMOTION_API}/videos?${p.toString()}`;
}

export function dailymotionVideoUrl(id: string): string {
  const p = new URLSearchParams();
  p.set('fields', DAILYMOTION_FIELDS.join(','));
  return `${DAILYMOTION_API}/video/${encodeURIComponent(id)}?${p.toString()}`;
}

/** `dailymotion:<sort>:<country|loc-<localization>>[:search]` (country-less seeds name their fixed localization). */
export function dailymotionDiscoveredVia(seed: DailymotionQuerySeed, localization: string = DAILYMOTION_DEFAULT_LOCALIZATION): string {
  const scope = seed.country ? seed.country.toLowerCase() : `loc-${localization}`;
  return `dailymotion:${seed.sort}:${scope}${seed.search ? ':search' : ''}`;
}

/** Dailymotion error JSON (`{error:{code,message,type}}`) -> short message, or null if not an error payload. */
export function dailymotionErrorText(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const e = (body as { error?: unknown }).error;
  if (!e) return null;
  if (typeof e === 'string') return e;
  if (typeof e === 'object') {
    const o = e as Record<string, unknown>;
    const parts = [str(o.type), o.code != null ? String(o.code) : null].filter(Boolean).join(' ');
    const msg = str(o.message) ?? 'unknown error';
    return parts ? `${parts}: ${msg}` : msg;
  }
  return 'unknown error';
}

function describeError(err: unknown): { status: number | null; text: string } {
  const status = httpStatusOf(err);
  const apiText = dailymotionErrorText(errorJson(err));
  return { status, text: apiText ?? errorMessage(err) };
}

/**
 * Source-reported view windows (24h / 7d / 30d). A window is kept only when it is a valid count not larger
 * than the cumulative total; if the three windows are not monotone (day ≤ week ≤ month) all are dropped
 * because at least one of them is wrong and we cannot tell which.
 */
export function dailymotionWindows(v: DmVideo): { metric: MetricKey; windowHours: number; value: number }[] {
  const total = safeCount(v.views_total);
  const raw: [number, number | null][] = [
    [24, safeCount(v.views_last_day)],
    [168, safeCount(v.views_last_week)],
    [720, safeCount(v.views_last_month)],
  ];
  const kept = raw.filter((r): r is [number, number] => r[1] != null && (total == null || r[1] <= total));
  for (let i = 1; i < kept.length; i++) {
    if (kept[i][1] < kept[i - 1][1]) return [];
  }
  return kept.map(([windowHours, value]) => ({ metric: 'views' as const, windowHours, value }));
}

export function dailymotionFormat(v: DmVideo) {
  const duration = safeCount(v.duration);
  return formatFromDuration(duration, str(v.mode) === 'live');
}

/** Status of a Dailymotion video object when it is not publicly playable, else null (= active). */
export function dailymotionGoneStatus(v: DmVideo): VideoStatus | null {
  if (v.private === true) return 'private';
  const s = str(v.status);
  if (s === 'deleted' || s === 'rejected') return 'deleted';
  return null;
}

export function dailymotionToRawVideo(v: DmVideo, observedAt: number, discoveredVia: string): RawVideo | null {
  const id = str(v.id);
  const publishedAt = parseTime(v.created_time, 's');
  const ownerId = str(v['owner.id']);
  if (!id || publishedAt == null || !ownerId) return null;
  const username = str(v['owner.username']);
  const account: RawAccount = {
    platform: 'dailymotion',
    platformId: ownerId,
    handle: username,
    name: str(v['owner.screenname']) ?? username ?? ownerId,
    url: str(v['owner.url']) ?? `https://www.dailymotion.com/${username ?? ownerId}`,
    avatar: str(v['owner.avatar_80_url']),
    country: normalizeCountry(v['owner.country']),
    followers: safeCount(v['owner.followers_total']),
  };
  const language = normalizeLanguage(v.language);
  const channel = str(v.channel);
  const tags = Array.isArray(v.tags) ? uniqueStrings(v.tags) : [];
  const windows = dailymotionWindows(v);
  return {
    platform: 'dailymotion',
    platformId: id,
    url: str(v.url) ?? `https://www.dailymotion.com/video/${id}`,
    title: str(v.title) ?? '',
    description: cleanDescription(typeof v.description === 'string' ? v.description : null, { html: true }),
    thumbnail: str(v.thumbnail_360_url),
    publishedAt,
    durationSec: safeCount(v.duration),
    format: dailymotionFormat(v),
    account,
    language,
    languageSource: language ? 'source' : null,
    country: normalizeCountry(v.country),
    sourceCategory: channel ? `dailymotion:${channel}` : null,
    tags,
    counters: {
      views: safeCount(v.views_total),
      likes: safeCount(v.likes_total),
      comments: null,
      shares: null,
    },
    observedAt,
    sourceWindows: windows.length ? windows : undefined,
    status: 'active',
    discoveredVia,
  };
}

async function collect(ctx: CollectContext): Promise<CollectResult> {
  const videos: RawVideo[] = [];
  const errors: string[] = [];
  const gone: { platformId: string; status: VideoStatus }[] = [];
  const budget = new RequestBudget(ctx.http, ctx.maxRequests);
  const seen = new Set<string>();
  let invalid = 0;

  const push = (v: DmVideo, via: string): 'added' | 'dup' | 'invalid' => {
    const raw = dailymotionToRawVideo(v, ctx.now, via);
    if (!raw) {
      invalid++;
      return 'invalid';
    }
    if (seen.has(raw.platformId)) return 'dup';
    seen.add(raw.platformId);
    videos.push(raw);
    return 'added';
  };

  const getList = async (url: string): Promise<DmList> => {
    budget.take();
    const body = await ctx.http.getJson<DmList>(url);
    const apiErr = dailymotionErrorText(body);
    if (apiErr) throw Object.assign(new Error(apiErr), { json: body });
    if (!body || typeof body !== 'object' || !Array.isArray(body.list)) throw new Error('unexpected response (no list)');
    return body;
  };

  /* ---------------------------------------------------------------- discovery */
  const seeds = ctx.seeds?.dailymotion ?? [];
  const localization = dailymotionGlobalLocalization(ctx.env);
  let budgetStop = false;
  for (let si = 0; si < seeds.length; si++) {
    const seed = seeds[si];
    const label = dailymotionDiscoveredVia(seed, localization) + (seed.channel ? `(${seed.channel})` : '') + (seed.search ? `「${seed.search}」` : '');
    if (seed.sort === 'relevance' && !seed.search) {
      errors.push(`시드 ${label}: relevance 정렬은 search 가 필요함(요청 생략)`);
      continue;
    }
    const want = Math.min(DAILYMOTION_RESULT_CAP, Math.max(0, Math.floor(safeCount(seed.limit) ?? 0)));
    if (want === 0) continue;
    const pageSize = Math.min(DAILYMOTION_PAGE_MAX, want);
    const pages = Math.ceil(want / pageSize);
    const via = dailymotionDiscoveredVia(seed, localization);
    let got = 0;
    for (let page = 1; page <= pages && got < want; page++) {
      if (!budget.has()) {
        budgetStop = true;
        errors.push(`요청 한도(maxRequests=${ctx.maxRequests}) 도달: 시드 ${label} ${page}페이지 이후 및 남은 시드 ${seeds.length - si - 1}개 미수집`);
        break;
      }
      let body: DmList;
      try {
        body = await getList(dailymotionSearchUrl(seed, page, pageSize, localization));
      } catch (err) {
        const { status, text } = describeError(err);
        errors.push(`시드 ${label} ${page}페이지 실패${status ? `(HTTP ${status})` : ''}: ${text}`);
        break; // next seed
      }
      const list = body.list ?? [];
      for (const v of list) {
        if (got >= want) break;
        if (dailymotionGoneStatus(v)) continue;
        push(v, via);
        got++;
      }
      if (!body.has_more || list.length === 0) break;
    }
    if (budgetStop) break;
  }

  /* ---------------------------------------------------------------- refresh */
  // Probe ids the batch endpoint silently dropped (deleted, private or otherwise unavailable).
  let probeSkipped = 0;
  const probeMissing = async (missing: string[]): Promise<void> => {
    for (const id of missing) {
      if (!budget.has()) {
        probeSkipped++;
        gone.push({ platformId: id, status: 'unknown' });
        continue;
      }
      try {
        budget.take();
        const body = await ctx.http.getJson<DmVideo>(dailymotionVideoUrl(id));
        const apiErr = dailymotionErrorText(body);
        if (apiErr) throw Object.assign(new Error(apiErr), { json: body });
        const goneStatus = dailymotionGoneStatus(body);
        if (goneStatus) gone.push({ platformId: id, status: goneStatus });
        else if (push(body, 'dailymotion:refresh') === 'invalid') gone.push({ platformId: id, status: 'unknown' });
      } catch (err) {
        const { status, text } = describeError(err);
        const json = errorJson(err) as { error?: { type?: string; code?: number } } | null;
        const code = status ?? (typeof json?.error?.code === 'number' ? json.error.code : null);
        if (code === 404 || code === 410 || json?.error?.type === 'not_found') gone.push({ platformId: id, status: 'deleted' });
        else if (code === 403 || code === 401 || json?.error?.type === 'access_forbidden') gone.push({ platformId: id, status: 'private' });
        else {
          gone.push({ platformId: id, status: 'unknown' });
          errors.push(`영상 ${id} 상태 확인 실패${status ? `(HTTP ${status})` : ''}: ${text}`);
        }
      }
    }
  };

  const refreshIds = uniqueStrings(ctx.refreshIds ?? []).filter((id) => !seen.has(id));
  const batches = chunk(refreshIds, DAILYMOTION_PAGE_MAX);
  let deferred = 0;
  for (let bi = 0; bi < batches.length; bi++) {
    const ids = batches[bi];
    if (!budget.has()) {
      // Budget-bound refresh: the rest stays due and goes first next run (the pipeline notes how many).
      deferred = batches.slice(bi).reduce((n, b) => n + b.length, 0);
      break;
    }
    let body: DmList;
    try {
      body = await getList(dailymotionIdsUrl(ids));
    } catch (err) {
      const { status, text } = describeError(err);
      errors.push(`갱신 배치(${ids.length}개) 실패${status ? `(HTTP ${status})` : ''}: ${text}`);
      continue;
    }
    const returned = new Set<string>();
    for (const v of body.list ?? []) {
      const id = str(v.id);
      if (!id) continue;
      returned.add(id);
      const goneStatus = dailymotionGoneStatus(v);
      if (goneStatus) {
        gone.push({ platformId: id, status: goneStatus });
        continue;
      }
      push(v, 'dailymotion:refresh');
    }
    // Right after the batch, so later batches cannot starve the probes of this one.
    await probeMissing(ids.filter((id) => !returned.has(id)));
  }
  if (deferred) ctx.log?.info?.(`[${ID}] request budget reached: ${deferred} due id(s) left for the next run`);
  if (probeSkipped) {
    errors.push(`요청 한도 도달: 갱신 응답에서 빠진 영상 ${probeSkipped}개의 삭제/비공개 여부 미확인(unknown 처리)`);
  }
  if (invalid) errors.push(`필수 필드(id/created_time/owner.id)가 없는 항목 ${invalid}개 제외`);

  ctx.log?.info?.(
    `[${ID}] videos ${videos.length}, gone ${gone.length}, requests ${budget.used}/${ctx.maxRequests}, errors ${errors.length}`,
  );
  return { videos, accounts: [], errors, gone };
}

export const dailymotion: SourceAdapter = {
  id: ID,
  platform: 'dailymotion',
  label: 'Dailymotion',
  requiresCredentials: false,
  envKeys: [],
  metrics: ['views', 'likes'],
  discovery:
    'Dailymotion 공개 Data API(https://api.dailymotion.com/videos)에서 시드 조건(채널=분야, 업로드 국가, 언어, 정렬, 검색어)으로 영상을 찾고, 이미 추적 중인 영상은 ids= 로 다시 관측합니다.',
  notes: [
    '조회수(views_total)·좋아요(likes_total)는 API 공개값입니다. 댓글·공유 수는 제공되지 않습니다(미제공, 0이 아님).',
    '최근 24시간/7일/30일 조회수(views_last_day/week/month)는 Dailymotion이 직접 집계해 보고한 값(원천 보고값)이며 관측 시점에 끝나는 구간에만 유효합니다. 누적값보다 크거나 구간 간 순서가 맞지 않으면 버립니다.',
    '구간 조회수는 원천 집계 지연으로 0 또는 누적값과 같게 보고되는 경우가 관측되었습니다. 우리 관측치로 계산한 증가량과 다를 수 있습니다.',
    '국가(country)와 언어(language)는 업로더가 지정한 원천 값입니다. 시청자 지역이 아닙니다.',
    '국가 조건이 없는 시드(비교용)는 API가 요청 위치 기준으로 결과를 지역화합니다. 2026-09-28 수집을 GitHub Actions(미국 서버)로 옮기면서 이 시드의 결과가 호주 기준에서 미국 기준으로 바뀌었고, 그날 미국 영상 약 1,200개가 새 영상으로 한꺼번에 추가되었습니다(신규 업로드 추이 해석 시 주의). 이후로는 localization=en_US(환경 변수 DAILYMOTION_GLOBAL_LOCALIZATION로 변경 가능)로 고정해 수집 위치와 무관하게 같은 기준으로 가져오며, 발견 경로는 dailymotion:<정렬>:loc-en_US로 기록합니다.',
    '형식: mode=live 이면 라이브, 길이 60초 이하 short, 그 외 long.',
    '검색 결과는 조건당 최대 1,000개(API 제한)이며 시드별 limit 만큼만 가져옵니다.',
    'ids= 갱신 응답에서 빠진 영상은 개별 조회로 삭제(404)·비공개(403)를 확인하고, 요청 한도 때문에 확인하지 못하면 상태 미상(unknown)으로 기록합니다.',
  ],
  docsUrl: 'https://developers.dailymotion.com/reference/introduction',
  version: 1,
  isEnabled: () => true,
  collect,
};
