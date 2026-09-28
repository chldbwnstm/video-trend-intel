/**
 * GET /api/v1/explore — topic opportunities: demand (median views per video) vs. supply (uploads) within one
 * platform. OWNER: server.
 */
import type { Hono } from 'hono';
import { PLATFORMS, computeOpportunities, resolveAnalysisWindow, resolveExplorePlatform } from '@vti/core';
import type { ExploreOptions } from '@vti/core';
import { platformLabel, sendJson, windowJson, type RouteDeps } from './common.ts';
import { Params, ParamError, parseAsOf, parseCategories, parseEnumList, parseIntParam, parseLanguages, parseRangeParams, parseTz, rangeEcho } from '../params.ts';

export function registerExplore(app: Hono, deps: RouteDeps): void {
  app.get('/explore', (c) =>
    sendJson(c, deps, (index) => {
      const p = Params.of(c.req.url);
      const tz = parseTz(p);
      const now = parseAsOf(p, index);
      const range = parseRangeParams(p, tz, now)!;
      const platforms = parseEnumList(p, ['platform', 'platforms'], PLATFORMS);
      if (platforms.length > 1) {
        throw new ParamError('platform', 'explore는 한 번에 한 플랫폼만 분석합니다(플랫폼마다 조회수 단위가 다름).', 'explore analyses one platform at a time (view units differ between platforms).');
      }
      const categories = parseCategories(p);
      const languages = parseLanguages(p);
      const minSupply = parseIntParam(p, ['minSupply'], 1, 10_000, null);
      const limit = parseIntParam(p, ['limit'], 1, 200, 50);
      p.done();
      const opts: ExploreOptions = {
        range: range.range,
        rollingHours: range.rollingHours,
        tz,
        now,
        ...(platforms.length ? { platform: platforms[0] } : {}),
        ...(categories.length ? { categories } : {}),
        ...(languages.length ? { languages } : {}),
        ...(minSupply !== null ? { minSupply } : {}),
        limit,
      };
      const platform = resolveExplorePlatform(index, opts);
      const items = computeOpportunities(index, opts);
      const window = resolveAnalysisWindow(range.range, tz, now, range.rollingHours);
      const notes = [
        '수요 = 기간 안에 게시된 주제별 영상의 최신 조회수 중앙값, 공급 = 우리가 추적한 같은 주제의 게시 영상 수입니다. 점수 = 수요 백분위 - 공급 백분위(높을수록 영상당 조회가 많고 경쟁 영상이 적음).',
        '공급은 전체 플랫폼이 아니라 이 서비스가 추적하는 영상 집합 기준입니다. 최신 조회수는 관측 시점 값이며 하한값일 수 있습니다.',
      ];
      if (!platforms.length) {
        notes.push(
          platform
            ? `플랫폼을 지정하지 않아 기간 내 게시 영상이 가장 많은 ${platformLabel(platform)}을(를) 분석했습니다. 플랫폼마다 조회수 단위가 달라 한 번에 한 플랫폼만 비교합니다.`
            : '기간 안에 게시된 영상이 없어 분석할 플랫폼이 없습니다.',
        );
      }
      return {
        query: { range: rangeEcho(range), tz, asOf: now, platform: platforms[0] ?? null, cats: categories, langs: languages, minSupply, limit },
        now,
        platform,
        platformLabel: platform ? platformLabel(platform) : null,
        window: windowJson(window, range.rollingHours),
        items,
        notes,
      };
    }),
  );
}
