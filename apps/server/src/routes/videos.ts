/**
 * GET /api/v1/videos (+ format=csv) and GET /api/v1/videos/:id. OWNER: server.
 */
import type { Hono } from 'hono';
import {
  AGE_DAYS,
  addDays,
  computeVideoMetrics,
  dailyIncrements,
  indexAsOf,
  localDateOf,
  queryResultToCsv,
  queryVideos,
  resolveAnalysisWindow,
  valueAtAge,
} from '@vti/core';
import type { AgeDays, DatasetIndex, MetricKey, VideoQuery } from '@vti/core';
import { accountJson, cacheKeyOf, HttpError, metricJson, metricsJson, requireIndex, respond, rowJson, sendJson, videoJson, windowJson, type RouteDeps } from './common.ts';
import { DATE_MODES, DEFAULT_DATE_MODE, Params, ParamError, parseAsOf, parseEnum, parseIntParam, parseRangeParams, parseTz, parseVideoQuery, rangeEcho } from '../params.ts';

/** Run a parsed video query and shape the JSON response. */
export function videosPayload(index: DatasetIndex, query: VideoQuery, echo: Record<string, unknown>, rollingHours: number | null) {
  const result = queryVideos(index, query);
  return {
    query: echo,
    window: windowJson(result.window, rollingHours),
    now: result.now,
    total: result.total,
    offset: query.offset ?? 0,
    limit: query.limit ?? null,
    count: result.rows.length,
    notes: result.notes,
    rows: result.rows.map((r) => rowJson(r, result.now)),
  };
}

function csvFilename(query: VideoQuery, spec: string | null, now: number): string {
  const stamp = new Date(now).toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  const range = (spec ?? 'all').replace(/[^A-Za-z0-9.-]+/g, '_').replace(/\.\./g, '_');
  const age = query.dateMode === 'age' && query.ageDays ? `-v${query.ageDays}` : '';
  return `vti-videos-${query.dateMode}${age}-${range}-${stamp}.csv`;
}

const DAILY_METRICS: MetricKey[] = ['views', 'likes', 'comments'];

/** Detail payload for one video. */
export function videoDetailPayload(index: DatasetIndex, id: string, p: Params) {
  const tz = parseTz(p);
  const now = parseAsOf(p, index);
  const days = parseIntParam(p, ['days'], 1, 90, 30);
  const mode = parseEnum(p, ['mode', 'dateMode'], DATE_MODES, DEFAULT_DATE_MODE);
  const range = parseRangeParams(p, tz, now);
  const ageRaw = parseIntParam(p, ['age', 'ageDays'], 1, 30, null);
  if (ageRaw !== null && !(AGE_DAYS as readonly number[]).includes(ageRaw)) {
    throw new ParamError('age', `age는 ${AGE_DAYS.join(', ')} 중 하나여야 합니다.`, `age must be one of ${AGE_DAYS.join(', ')}.`);
  }
  const ageDays = (ageRaw ?? (mode === 'age' ? 7 : null)) as AgeDays | null;
  p.done();

  const idx = indexAsOf(index, now);
  const video = idx.videosById.get(id);
  if (!video) {
    throw new HttpError(404, 'not_found', `영상을 찾을 수 없습니다: ${id}`, `Video not found: ${id}`, { id });
  }
  const account = idx.accountsById.get(video.accountId) ?? null;
  const creatorId = idx.creatorOfAccount.get(video.accountId) ?? null;
  const creator = creatorId ? (idx.creatorsById.get(creatorId) ?? null) : null;
  const window = resolveAnalysisWindow(range!.range, tz, now, range!.rollingHours);
  const metrics = computeVideoMetrics(video, { mode, window, ageDays, now, index: idx });

  const ratings = AGE_DAYS.map((k) => ({
    ageDays: k,
    label: `V${k}`,
    views: metricJson(valueAtAge(video, 'views', k, now)),
    likes: metricJson(valueAtAge(video, 'likes', k, now)),
    comments: metricJson(valueAtAge(video, 'comments', k, now)),
  }));

  const endDate = localDateOf(now, tz);
  const startDate = addDays(endDate, -(days - 1));
  const perMetric = DAILY_METRICS.map((m) => dailyIncrements(video, m, startDate, endDate, tz, now));
  const daily = perMetric[0].map((d, i) => ({
    date: d.date,
    views: metricJson(d.value),
    likes: metricJson(perMetric[1][i].value),
    comments: metricJson(perMetric[2][i].value),
  }));

  return {
    query: { tz, days, mode, range: rangeEcho(range!), age: ageDays, asOf: now },
    now,
    video: videoJson(video),
    account: account ? { ...accountJson(account, now), followerSeries: account.followers } : null,
    creator: creator ? { id: creator.id, name: creator.name, linkStatus: creator.linkStatus, note: creator.note, accountIds: creator.accountIds } : null,
    window: windowJson(window, range!.rollingHours),
    metrics: metricsJson(metrics),
    ratings,
    daily: { tz, start: startDate, end: endDate, days: daily },
    observations: video.obs,
    sourceWindows: video.sourceWindows,
    notes: [
      'ratings는 게시 후 N일 시점 값(V1·V2·V3·V7·V30)입니다. 아직 N일이 지나지 않았으면 not_reached, 그 시점 전후 관측이 없으면 계산 불가입니다.',
      'daily는 현지 날짜(tz)별 증가량입니다. 하루 경계 관측이 없으면 하한값(≥)이나 계산 불가로 표시하며 0으로 채우지 않습니다.',
      'metrics.percentile은 목록 조회(/api/v1/videos)에서만 계산됩니다.',
    ],
  };
}

export function registerVideos(app: Hono, deps: RouteDeps): void {
  app.get('/videos', (c) => {
    const index = requireIndex(deps);
    const key = cacheKeyOf(c);
    const hit = deps.cache.get(index, key);
    if (hit) return respond(c, hit);
    const parsed = parseVideoQuery(Params.of(c.req.url), index);
    const rolling = parsed.range?.rollingHours ?? null;
    if (parsed.output === 'csv') {
      const result = queryVideos(index, parsed.query);
      const csv = queryResultToCsv(result, parsed.query.tz, { dateMode: parsed.query.dateMode, ageDays: parsed.query.ageDays ?? null });
      const filename = csvFilename(parsed.query, parsed.range?.spec ?? null, result.now);
      const r = {
        body: csv,
        contentType: 'text/csv; charset=utf-8',
        headers: {
          'Content-Disposition': `attachment; filename="${filename}"`,
          'X-Total-Count': String(result.total),
        },
      };
      deps.cache.set(index, key, r);
      return respond(c, r);
    }
    const r = { body: JSON.stringify(videosPayload(index, parsed.query, parsed.echo, rolling)), contentType: 'application/json; charset=utf-8' };
    deps.cache.set(index, key, r);
    return respond(c, r);
  });

  app.get('/videos/:id{.+}', (c) => sendJson(c, deps, (index) => videoDetailPayload(index, c.req.param('id'), Params.of(c.req.url))));
}
