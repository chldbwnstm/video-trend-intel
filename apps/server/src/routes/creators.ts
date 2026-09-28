/**
 * GET /api/v1/creators (portfolio summaries) and GET /api/v1/creators/:key (summary, timeline, heatmap, top
 * videos). OWNER: server.
 */
import type { Hono } from 'hono';
import {
  categoryPathLabel,
  creatorPortfolios,
  creatorTimeline,
  indexAsOf,
  postingHeatmap,
  queryVideos,
  resolveAnalysisWindow,
  summarizeCreators,
  summarizePortfolio,
} from '@vti/core';
import type { CreatorSummary, DatasetIndex } from '@vti/core';
import { accountJson, compactRowJson, HttpError, metricJson, sendJson, windowJson, type RouteDeps } from './common.ts';
import {
  CREATOR_SORTS,
  Params,
  parseAsOf,
  parseCategories,
  parseEnum,
  parseIntParam,
  parsePlatforms,
  parseQ,
  parseRangeParams,
  parseTz,
  rangeEcho,
  type CreatorSort,
  type ResolvedRangeParam,
} from '../params.ts';

export function creatorSummaryJson(s: CreatorSummary, now: number) {
  return {
    key: s.key,
    kind: s.kind,
    name: s.name,
    platforms: s.platforms,
    accounts: s.accounts.map((a) => accountJson(a, now)),
    followers: s.followers,
    followersGrowth: metricJson(s.followersGrowth),
    videoCount: s.videoCount,
    uploadsInWindow: s.uploadsInWindow,
    viewsInWindow: metricJson(s.viewsInWindow),
    engagementRate: metricJson(s.engagementRate),
    medianV7: metricJson(s.medianV7),
    topCategories: s.topCategories.map((id) => ({ id, label: categoryPathLabel(id) })),
    sponsoredCount: s.sponsoredCount,
  };
}

export interface CreatorsRequest {
  tz: string;
  now: number;
  range: ResolvedRangeParam;
  platforms: ReturnType<typeof parsePlatforms>;
  categories: string[];
  q: string | undefined;
  sort: CreatorSort;
  limit: number;
  offset: number;
}

export function parseCreators(p: Params, index: DatasetIndex): CreatorsRequest {
  const tz = parseTz(p);
  const now = parseAsOf(p, index);
  const range = parseRangeParams(p, tz, now)!;
  const platforms = parsePlatforms(p);
  const categories = parseCategories(p);
  const q = parseQ(p);
  const sort = parseEnum(p, ['sort'], CREATOR_SORTS, 'views_period');
  const limit = parseIntParam(p, ['limit'], 1, 500, 50);
  const offset = parseIntParam(p, ['offset'], 0, 1_000_000, 0);
  p.done();
  return { tz, now, range, platforms, categories, q, sort, limit, offset };
}

export function creatorsPayload(index: DatasetIndex, r: CreatorsRequest) {
  const all = summarizeCreators(index, {
    range: r.range.range,
    rollingHours: r.range.rollingHours,
    tz: r.tz,
    now: r.now,
    sort: r.sort,
    ...(r.platforms.length ? { platforms: r.platforms } : {}),
    ...(r.categories.length ? { categories: r.categories } : {}),
    ...(r.q ? { q: r.q } : {}),
  });
  const page = all.slice(r.offset, r.offset + r.limit);
  const window = resolveAnalysisWindow(r.range.range, r.tz, r.now, r.range.rollingHours);
  return {
    query: { range: rangeEcho(r.range), tz: r.tz, asOf: r.now, platforms: r.platforms, cats: r.categories, q: r.q ?? null, sort: r.sort, limit: r.limit, offset: r.offset },
    now: r.now,
    window: windowJson(window, r.range.rollingHours),
    total: all.length,
    count: page.length,
    rows: page.map((s) => creatorSummaryJson(s, r.now)),
    notes: [
      '포트폴리오 = 검증·제안된 크리에이터 연결로 묶인 여러 플랫폼 계정, 연결이 없으면 계정 1개입니다. 모든 수치는 이 서비스가 추적한 영상 기준입니다.',
      'viewsInWindow는 영상별 기간 조회 증가량의 합으로, 일부 영상의 경계 관측이 없으면 하한값(≥)입니다. 여러 플랫폼 합계는 조회수 단위가 달라 참고용입니다.',
    ],
  };
}

export function registerCreators(app: Hono, deps: RouteDeps): void {
  app.get('/creators', (c) => sendJson(c, deps, (index) => creatorsPayload(index, parseCreators(Params.of(c.req.url), index))));

  app.get('/creators/:key{.+}', (c) =>
    sendJson(c, deps, (index) => {
      const key = c.req.param('key');
      const p = Params.of(c.req.url);
      const tz = parseTz(p);
      const now = parseAsOf(p, index);
      const range = parseRangeParams(p, tz, now)!;
      const topLimit = parseIntParam(p, ['top'], 0, 50, 10);
      p.done();
      const idx = indexAsOf(index, now);
      const portfolio = creatorPortfolios(idx).get(key);
      if (!portfolio) {
        throw new HttpError(404, 'not_found', `크리에이터·계정을 찾을 수 없습니다: ${key}`, `Creator or account not found: ${key}`, { key });
      }
      const window = resolveAnalysisWindow(range.range, tz, now, range.rollingHours);
      const summary = summarizePortfolio(idx, portfolio, window, now);
      const creator = idx.creatorsById.get(key) ?? null;
      const timeline = creatorTimeline(index, key, { range: range.range, tz, now });
      const heatmap = postingHeatmap(index, key, tz, now);
      const top =
        topLimit > 0
          ? queryVideos(index, {
              dateMode: 'activity',
              range: range.range,
              ...(range.rollingHours ? { rollingHours: range.rollingHours } : {}),
              tz,
              now,
              sort: 'views_period',
              accountIds: portfolio.accountIds,
              limit: topLimit,
            })
          : null;
      return {
        query: { range: rangeEcho(range), tz, asOf: now, top: topLimit },
        now,
        key,
        kind: portfolio.kind,
        creator: creator ? { id: creator.id, name: creator.name, linkStatus: creator.linkStatus, note: creator.note, accountIds: creator.accountIds } : null,
        window: windowJson(window, range.rollingHours),
        summary: creatorSummaryJson(summary, now),
        accounts: portfolio.accounts.map((a) => ({ ...accountJson(a, now), followerSeries: a.followers })),
        timeline: {
          tz,
          start: range.range.start,
          end: range.range.end,
          days: timeline.map((d) => ({
            date: d.date,
            byPlatform: Object.fromEntries(Object.entries(d.byPlatform).map(([pf, m]) => [pf, m ? metricJson(m) : null])),
          })),
        },
        heatmap: { tz, weekdays: ['월', '화', '수', '목', '금', '토', '일'], counts: heatmap.counts, medianV7: heatmap.medianV7 },
        topVideos: top ? { total: top.total, rows: top.rows.map((r, i) => compactRowJson(r, i + 1)), notes: top.notes } : null,
        notes: [
          'timeline은 현지 날짜(tz)별·플랫폼별 조회 증가량 합계입니다. 경계 관측이 부족한 날은 하한값(≥)이나 계산 불가로 표시합니다.',
          'heatmap은 게시 요일(월=0)·시각별 업로드 수와 V7(게시 후 7일 조회수) 중앙값입니다.',
        ],
      };
    }),
  );
}
