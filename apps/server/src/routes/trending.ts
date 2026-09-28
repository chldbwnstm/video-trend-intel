/**
 * GET /api/v1/trending — rising / falling / top topics, categories, creators or accounts vs. the previous
 * equal-length window. OWNER: server.
 */
import type { Hono } from 'hono';
import { computeTrending } from '@vti/core';
import type { DatasetIndex, Platform, TrendEntityKind } from '@vti/core';
import { sendJson, windowJson, type RouteDeps } from './common.ts';
import {
  Params,
  TREND_KINDS,
  parseAsOf,
  parseCategories,
  parseEnum,
  parseIntParam,
  parseLanguages,
  parseNumberParam,
  parsePlatforms,
  parseRangeParams,
  parseTz,
  rangeEcho,
  type ResolvedRangeParam,
} from '../params.ts';

export interface TrendingRequest {
  kind: TrendEntityKind;
  tz: string;
  now: number;
  range: ResolvedRangeParam;
  platforms: Platform[];
  categories: string[];
  languages: string[];
  minVideos: number | null;
  minCurrent: number | null;
  limit: number;
}

export function parseTrending(p: Params, index: DatasetIndex): TrendingRequest {
  const kind = parseEnum(p, ['kind'], TREND_KINDS, 'topic');
  const tz = parseTz(p);
  const now = parseAsOf(p, index);
  const range = parseRangeParams(p, tz, now)!;
  const platforms = parsePlatforms(p);
  const categories = parseCategories(p);
  const languages = parseLanguages(p);
  const minVideos = parseIntParam(p, ['minVideos'], 1, 10_000, null);
  const minCurrent = parseNumberParam(p, ['minCurrent'], 0, 1e15);
  const limit = parseIntParam(p, ['limit'], 1, 100, 20);
  p.done();
  return { kind, tz, now, range, platforms, categories, languages, minVideos, minCurrent, limit };
}

export function trendingPayload(index: DatasetIndex, r: TrendingRequest) {
  const res = computeTrending(index, {
    kind: r.kind,
    range: r.range.range,
    rollingHours: r.range.rollingHours,
    tz: r.tz,
    now: r.now,
    ...(r.platforms.length ? { platforms: r.platforms } : {}),
    ...(r.categories.length ? { categories: r.categories } : {}),
    ...(r.languages.length ? { languages: r.languages } : {}),
    ...(r.minVideos !== null ? { minVideos: r.minVideos } : {}),
    ...(r.minCurrent !== null ? { minCurrent: r.minCurrent } : {}),
    limit: r.limit,
  });
  return {
    query: {
      kind: r.kind,
      range: rangeEcho(r.range),
      tz: r.tz,
      asOf: r.now,
      platforms: r.platforms,
      cats: r.categories,
      langs: r.languages,
      minVideos: r.minVideos,
      minCurrent: r.minCurrent,
      limit: r.limit,
    },
    now: r.now,
    window: windowJson(res.window, r.range.rollingHours),
    previousWindow: windowJson(res.previousWindow, r.range.rollingHours),
    rising: res.rising,
    falling: res.falling,
    top: res.top,
    notes: res.notes,
  };
}

export function registerTrending(app: Hono, deps: RouteDeps): void {
  app.get('/trending', (c) => sendJson(c, deps, (index) => trendingPayload(index, parseTrending(Params.of(c.req.url), index))));
}
