/**
 * Hand-written OpenAPI 3.1 description of the REST API (served at /api/v1/openapi.json and written by
 * static-api). Keep in sync with routes/*.ts and params.ts. OWNER: server.
 */
import { AGE_DAYS, PLATFORMS, RANGE_PRESETS } from '@vti/core';
import { API_VERSION } from './routes/common.ts';
import {
  CREATOR_SORTS,
  DATE_MODES,
  DEFAULT_CSV_LIMIT,
  DEFAULT_RANGE_PRESET,
  DEFAULT_VIDEO_LIMIT,
  MAX_AS_OF_DAYS,
  MAX_CSV_LIMIT,
  MAX_RANGE_DAYS,
  MAX_ROLLING_HOURS,
  MAX_VIDEO_LIMIT,
  SORT_KEYS,
  TREND_KINDS,
  VIDEO_FORMATS,
} from './params.ts';

type Json = Record<string, unknown>;

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const pref = (name: string) => ({ $ref: `#/components/parameters/${name}` });
const nullable = (schema: Json): Json => ({ oneOf: [schema, { type: 'null' }] });
const arrayOf = (items: Json): Json => ({ type: 'array', items });
const listParam = (name: string, description: string, items: Json = { type: 'string' }, aliases: string[] = []): Json => ({
  name,
  in: 'query',
  description: `${description} 쉼표로 구분하거나 키를 반복할 수 있습니다.${aliases.length ? ` 별칭: ${aliases.join(', ')}.` : ''}`,
  style: 'form',
  explode: false,
  schema: arrayOf(items),
});

const METRIC_STATUSES = ['exact', 'interpolated', 'lower_bound', 'source_reported', 'unavailable', 'decrease_flagged'];

function jsonResponse(schema: Json, description = 'OK'): Json {
  return {
    description,
    headers: {
      ETag: { $ref: '#/components/headers/ETag' },
      'Cache-Control': { $ref: '#/components/headers/CacheControl' },
      'X-Data-Generated-At': { $ref: '#/components/headers/DataGeneratedAt' },
      'X-RateLimit-Limit': { $ref: '#/components/headers/RateLimitLimit' },
      'X-RateLimit-Remaining': { $ref: '#/components/headers/RateLimitRemaining' },
    },
    content: { 'application/json': { schema } },
  };
}

const COMMON_ERRORS: Json = {
  '304': { $ref: '#/components/responses/NotModified' },
  '400': { $ref: '#/components/responses/BadRequest' },
  '429': { $ref: '#/components/responses/RateLimited' },
  '503': { $ref: '#/components/responses/Unavailable' },
};

const RANGE_PARAMS = [pref('range'), pref('start'), pref('end'), pref('hours'), pref('tz'), pref('asOf')];

export function buildOpenApi(): Json {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Video Trend Intel API',
      version: API_VERSION,
      summary: '기간·플랫폼·분야별 인기 영상과 크리에이터 인텔리전스 (읽기 전용 REST API)',
      description: [
        '웹 앱과 같은 데이터셋·같은 계산(@vti/core)을 사용하는 읽기 전용 API입니다.',
        '',
        '데이터 원칙',
        '- 원천이 제공하지 않는 값은 0이 아니라 null이며, 모든 지표는 `MetricValue { value, status, asOf, note }`로 출처 상태를 함께 제공합니다.',
        '- 날짜 기준 3가지: `upload`(기간 내 게시), `activity`(기간 내 증가량, 게시일 무관), `age`(게시 후 N일 시점 값). 섞지 않습니다.',
        '- 기본 기간은 `rolling7d`(데이터 기준 시각까지 최근 168시간)입니다. 롤링 기간은 기준 시각에서 정확히 끝나므로 경계 관측이 정확하고, Dailymotion의 원천 보고 기간 지표(24h/7d/30d)가 적용됩니다.',
        '- 플랫폼마다 조회수 정의가 다릅니다. 여러 플랫폼을 섞은 순위에는 `notes`에 주의 문구가 붙으며, `sort=percentile`(플랫폼 내 백분위)을 함께 보세요.',
        '- 매개변수 이름은 웹 앱 URL 키와 같습니다(`mode`, `range`, `age`, `platforms`, `cats`, `langs` 등). 알 수 없는 매개변수는 400으로 거부합니다(`_`로 시작하는 키는 무시).',
        '',
        '운영',
        '- CORS: 모든 출처에서 GET 가능. 조건부 요청: 응답의 약한 ETag(데이터셋 generatedAt 기반)로 `If-None-Match` → 304.',
        '- 속도 제한: IP당 분당 120회(토큰 버킷). 초과 시 429 + `Retry-After`.',
        '- 오류: `{ "error": { status, code, message(한국어), messageEn, param? } }`.',
        '- 정적 API(GitHub Pages의 `api/v1/*.json`)와 같은 경로를 서버도 실시간 계산으로 제공합니다: `/api/v1/index.json`이 파일 목록입니다.',
        '',
        'Read-only REST API over the same dataset and analytics (@vti/core) as the web app. Missing counters are null (never 0) and every metric carries its provenance status. Default window: rolling 168 h ending at the data\'s generatedAt.',
      ].join('\n'),
      license: { name: 'Data from public sources; see /api/v1/coverage for sources and terms' },
    },
    servers: [{ url: '/', description: '이 서버 (same origin)' }],
    tags: [
      { name: 'system', description: '상태·메타데이터' },
      { name: 'videos', description: '영상 탐색 (Video Intelligence)' },
      { name: 'trends', description: '트렌드·기회 탐색' },
      { name: 'creators', description: '크리에이터 포트폴리오' },
      { name: 'reference', description: '분류 체계·데이터 범위·원자료' },
    ],
    paths: {
      '/api/v1/health': {
        get: {
          tags: ['system'],
          operationId: 'getHealth',
          summary: '서버·데이터셋·수집 스케줄러 상태 (속도 제한 제외, 캐시 안 함)',
          responses: { '200': { description: 'OK', content: { 'application/json': { schema: ref('Health') } } } },
        },
      },
      '/api/v1/meta': {
        get: {
          tags: ['system'],
          operationId: 'getMeta',
          summary: '데이터셋 버전·개수·수집 범위 요약·분류기 버전',
          responses: { '200': jsonResponse(ref('Meta')), ...COMMON_ERRORS },
        },
      },
      '/api/v1/videos': {
        get: {
          tags: ['videos'],
          operationId: 'listVideos',
          summary: '영상 검색·필터·정렬 (JSON 또는 CSV)',
          description:
            '기본값: mode=activity, range=rolling7d, tz=Asia/Seoul, sort=views_period(age 모드는 views_at_age), dir=desc, limit=50(최대 500). ' +
            `format=csv이면 UTF-8(BOM) CSV를 첨부 파일로 반환합니다(기본 ${DEFAULT_CSV_LIMIT}행, 최대 ${MAX_CSV_LIMIT}행). 모든 지표 열에 상태·기준 시각이 함께 들어 있습니다.`,
          parameters: [
            pref('mode'),
            ...RANGE_PARAMS,
            pref('age'),
            pref('platforms'),
            pref('cats'),
            listParam('topics', '주제 키(정규화된 해시태그·태그).', { type: 'string' }, ['topic']),
            pref('langs'),
            listParam('countries', '업로드 국가(원천 제공, 시청자 지역 아님) ISO 코드.', { type: 'string' }, ['country']),
            listParam('formats', '영상 형식.', { type: 'string', enum: VIDEO_FORMATS }),
            listParam('accounts', '계정 ID (`platform:id`).', { type: 'string' }, ['accountIds', 'account']),
            listParam('creators', '크리에이터 ID.', { type: 'string' }, ['creatorIds', 'creator']),
            { name: 'sponsored', in: 'query', description: '협찬: disclosed(표기), any(표기+추정), none(신호 없음).', schema: { type: 'string', enum: ['disclosed', 'any', 'none'] } },
            { name: 'minViews', in: 'query', description: '누적 조회수 하한(표시 시점 값 기준, 하한값은 하한 자체가 넘어야 통과).', schema: { type: 'number', minimum: 0 } },
            pref('q'),
            { name: 'sort', in: 'query', description: '정렬 기준. 순위를 매길 수 없는 값(계산 불가·감소 감지)은 항상 끝에 둡니다.', schema: { type: 'string', enum: SORT_KEYS, default: 'views_period' } },
            pref('dir'),
            { name: 'limit', in: 'query', description: `페이지 크기 (JSON 최대 ${MAX_VIDEO_LIMIT}, CSV 최대 ${MAX_CSV_LIMIT}).`, schema: { type: 'integer', minimum: 1, maximum: MAX_CSV_LIMIT, default: DEFAULT_VIDEO_LIMIT } },
            pref('offset'),
            { name: 'page', in: 'query', description: '1부터 시작하는 페이지 번호 (offset 대신).', schema: { type: 'integer', minimum: 1 } },
            { name: 'format', in: 'query', description: '응답 형식.', schema: { type: 'string', enum: ['json', 'csv'], default: 'json' } },
          ],
          responses: {
            '200': {
              ...jsonResponse(ref('VideoList')),
              content: {
                'application/json': { schema: ref('VideoList') },
                'text/csv': { schema: { type: 'string', description: 'UTF-8 with BOM, CRLF, Korean headers; Content-Disposition: attachment' } },
              },
            },
            ...COMMON_ERRORS,
          },
        },
      },
      '/api/v1/videos/{id}': {
        get: {
          tags: ['videos'],
          operationId: 'getVideo',
          summary: '영상 상세: 지표, V1~V30 레이팅, 최근 N일 일별 증가량, 원 관측값',
          parameters: [
            { name: 'id', in: 'path', required: true, description: '영상 ID `platform:platformId` (예: youtube:dQw4w9WgXcQ).', schema: { type: 'string' } },
            pref('mode'),
            ...RANGE_PARAMS,
            pref('age'),
            { name: 'days', in: 'query', description: '일별 증가량 일수 (오늘까지, tz 기준).', schema: { type: 'integer', minimum: 1, maximum: 90, default: 30 } },
          ],
          responses: { '200': jsonResponse(ref('VideoDetail')), '404': { $ref: '#/components/responses/NotFound' }, ...COMMON_ERRORS },
        },
      },
      '/api/v1/trending': {
        get: {
          tags: ['trends'],
          operationId: 'getTrending',
          summary: '상승·하락·상위 주제/분야/크리에이터/계정 (직전 같은 길이 기간 대비)',
          parameters: [
            { name: 'kind', in: 'query', schema: { type: 'string', enum: TREND_KINDS, default: 'topic' } },
            ...RANGE_PARAMS,
            pref('platforms'),
            pref('cats'),
            pref('langs'),
            { name: 'minVideos', in: 'query', description: '항목별 최소 합산 영상 수 (기본 3).', schema: { type: 'integer', minimum: 1 } },
            { name: 'minCurrent', in: 'query', description: '상승/하락 목록의 최소 증가량 (기본: 하위 사분위).', schema: { type: 'number', minimum: 0 } },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
          ],
          responses: { '200': jsonResponse(ref('Trending')), ...COMMON_ERRORS },
        },
      },
      '/api/v1/explore': {
        get: {
          tags: ['trends'],
          operationId: 'getExplore',
          summary: '기회 탐색: 주제별 수요(영상당 조회 중앙값) 대 공급(게시 수), 한 플랫폼 안에서',
          parameters: [
            ...RANGE_PARAMS,
            { name: 'platform', in: 'query', description: '분석할 플랫폼 1개 (생략 시 기간 내 게시 영상이 가장 많은 플랫폼). 별칭: platforms.', schema: { type: 'string', enum: PLATFORMS } },
            pref('cats'),
            pref('langs'),
            { name: 'minSupply', in: 'query', description: '주제별 최소 영상 수 (기본 3).', schema: { type: 'integer', minimum: 1 } },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
          ],
          responses: { '200': jsonResponse(ref('Explore')), ...COMMON_ERRORS },
        },
      },
      '/api/v1/creators': {
        get: {
          tags: ['creators'],
          operationId: 'listCreators',
          summary: '크리에이터(연결된 여러 플랫폼 계정) 또는 계정 포트폴리오 요약',
          parameters: [
            ...RANGE_PARAMS,
            pref('platforms'),
            pref('cats'),
            pref('q'),
            { name: 'sort', in: 'query', schema: { type: 'string', enum: CREATOR_SORTS, default: 'views_period' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 500, default: 50 } },
            pref('offset'),
          ],
          responses: { '200': jsonResponse(ref('CreatorList')), ...COMMON_ERRORS },
        },
      },
      '/api/v1/creators/{key}': {
        get: {
          tags: ['creators'],
          operationId: 'getCreator',
          summary: '크리에이터/계정 상세: 요약, 일별·플랫폼별 증가량, 게시 시간 히트맵, 기간 상위 영상',
          parameters: [
            { name: 'key', in: 'path', required: true, description: '크리에이터 ID 또는 계정 ID(`platform:id`).', schema: { type: 'string' } },
            ...RANGE_PARAMS,
            { name: 'top', in: 'query', description: '상위 영상 수 (0이면 생략).', schema: { type: 'integer', minimum: 0, maximum: 50, default: 10 } },
          ],
          responses: { '200': jsonResponse(ref('CreatorDetail')), '404': { $ref: '#/components/responses/NotFound' }, ...COMMON_ERRORS },
        },
      },
      '/api/v1/taxonomy': {
        get: {
          tags: ['reference'],
          operationId: 'getTaxonomy',
          summary: '분류 체계 트리(분야·세부 분야)와 영상 수',
          parameters: [{ name: 'keywords', in: 'query', description: '분류 키워드 포함 여부.', schema: { type: 'boolean', default: true } }],
          responses: { '200': jsonResponse(ref('Taxonomy')), ...COMMON_ERRORS },
        },
      },
      '/api/v1/coverage': {
        get: {
          tags: ['reference'],
          operationId: 'getCoverage',
          summary: '데이터 범위: 수집 원천, 실행 기록, 내보내기 메모, 관측 밀도, 기본 기간의 정확도 분포, 제공하지 않는 기능',
          parameters: [pref('tz')],
          responses: { '200': jsonResponse(ref('Coverage')), ...COMMON_ERRORS },
        },
      },
      '/api/v1/dataset': {
        get: {
          tags: ['reference'],
          operationId: 'getDataset',
          summary: '웹 앱이 읽는 압축 데이터셋 JSON (format 2, gzip 지원). /data/dataset.json과 같은 내용',
          responses: {
            '200': { description: 'Compact dataset (see packages/core/src/dataset.ts)', content: { 'application/json': { schema: { type: 'object' } } } },
            '304': { $ref: '#/components/responses/NotModified' },
            '429': { $ref: '#/components/responses/RateLimited' },
            '503': { $ref: '#/components/responses/Unavailable' },
          },
        },
      },
      '/api/v1/index.json': {
        get: {
          tags: ['reference'],
          operationId: 'getStaticIndex',
          summary: '정적 API 파일 목록 (meta.json, videos/{mode}/top-{preset}-{platform}.json, trending/{kind}-{preset}.json, creators/top-{preset}.json …). 각 경로를 /api/v1/<path>로 요청하면 같은 내용을 실시간으로 계산해 반환',
          responses: {
            '200': jsonResponse({
              type: 'object',
              properties: {
                apiVersion: { type: 'string' },
                generatedAt: { type: 'integer' },
                tz: { type: 'string' },
                files: arrayOf({ type: 'object', properties: { path: { type: 'string' }, description: { type: 'string' }, bytes: { type: 'integer' } } }),
              },
            }),
            ...COMMON_ERRORS,
          },
        },
      },
      '/api/v1/openapi.json': {
        get: { tags: ['system'], operationId: 'getOpenApi', summary: '이 문서 (OpenAPI 3.1)', responses: { '200': { description: 'OpenAPI document', content: { 'application/json': { schema: { type: 'object' } } } } } },
      },
    },
    components: {
      parameters: {
        mode: { name: 'mode', in: 'query', description: '날짜 기준: upload(기간 내 게시), activity(기간 내 증가량), age(게시 후 N일 값). 별칭: dateMode.', schema: { type: 'string', enum: DATE_MODES, default: 'activity' } },
        range: {
          name: 'range',
          in: 'query',
          description: `기간 프리셋 또는 \`YYYY-MM-DD..YYYY-MM-DD\`(tz 기준 포함 범위, 최대 ${MAX_RANGE_DAYS}일). 롤링 프리셋(rolling24h/7d/30d)은 [기준 시각 - N시간, 기준 시각). 기본 ${DEFAULT_RANGE_PRESET} (age 모드는 기본 없음 = 게시일 제한 없음). 별칭: preset.`,
          schema: { type: 'string', examples: [...RANGE_PRESETS, '2026-09-01..2026-09-28'], default: DEFAULT_RANGE_PRESET },
        },
        start: { name: 'start', in: 'query', description: '기간 시작일(포함, YYYY-MM-DD). end와 함께 사용. 별칭: from.', schema: { type: 'string', format: 'date' } },
        end: { name: 'end', in: 'query', description: '기간 종료일(포함, YYYY-MM-DD). 별칭: to.', schema: { type: 'string', format: 'date' } },
        hours: { name: 'hours', in: 'query', description: `사용자 지정 롤링 기간(시간): [기준 시각 - hours, 기준 시각). range·start/end와 함께 쓸 수 없음. 별칭: rollingHours.`, schema: { type: 'number', minimum: 1, maximum: MAX_ROLLING_HOURS } },
        tz: { name: 'tz', in: 'query', description: 'IANA 시간대 (현지 날짜·표시 기준).', schema: { type: 'string', default: 'Asia/Seoul', examples: ['Asia/Seoul', 'Australia/Sydney'] } },
        asOf: {
          name: 'asOf',
          in: 'query',
          description: `기준 시각(ISO 또는 epoch ms). 이 시각 이후 수집된 관측은 제외하고 계산해 과거 보고서를 재현합니다. 데이터 generatedAt 이전 ${MAX_AS_OF_DAYS}일 이내. 기본: generatedAt.`,
          schema: { type: 'string' },
        },
        age: { name: 'age', in: 'query', description: 'age 모드의 경과일 (V1/V2/V3/V7/V30). age 모드 기본 7. 별칭: ageDays.', schema: { type: 'integer', enum: [...AGE_DAYS] } },
        platforms: listParam('platforms', '플랫폼.', { type: 'string', enum: PLATFORMS }, ['platform']),
        cats: listParam('cats', '분야 ID (하위 분야 포함). /api/v1/taxonomy 참고.', { type: 'string' }, ['categories', 'category']),
        langs: listParam('langs', '영상 언어 ISO 639-1 코드 (시청자 언어 아님).', { type: 'string' }, ['languages', 'language']),
        q: { name: 'q', in: 'query', description: '검색어 (제목·태그·주제·계정 이름, 대소문자·전각 무시, 한국어 띄어쓰기 허용). 최대 200자.', schema: { type: 'string', maxLength: 200 } },
        dir: { name: 'dir', in: 'query', description: '정렬 방향. 별칭: sortDir.', schema: { type: 'string', enum: ['desc', 'asc'], default: 'desc' } },
        offset: { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } },
      },
      headers: {
        ETag: { description: '약한 ETag (데이터셋 generatedAt + API 버전). If-None-Match로 보내면 304.', schema: { type: 'string' } },
        CacheControl: { description: 'public, max-age=60, stale-while-revalidate=300', schema: { type: 'string' } },
        DataGeneratedAt: { description: '데이터셋 생성 시각 (ISO).', schema: { type: 'string', format: 'date-time' } },
        RateLimitLimit: { description: 'IP당 분당 허용 요청 수.', schema: { type: 'integer' } },
        RateLimitRemaining: { description: '남은 요청 수.', schema: { type: 'integer' } },
      },
      responses: {
        NotModified: { description: 'If-None-Match가 현재 ETag와 같음 (본문 없음).' },
        BadRequest: { description: '매개변수 오류 (한국어·영어 메시지).', content: { 'application/json': { schema: ref('Error') } } },
        NotFound: { description: '대상 없음.', content: { 'application/json': { schema: ref('Error') } } },
        RateLimited: { description: '속도 제한 초과. Retry-After 헤더 참고.', content: { 'application/json': { schema: ref('Error') } } },
        Unavailable: { description: '데이터셋이 아직 로드되지 않음.', content: { 'application/json': { schema: ref('Error') } } },
      },
      schemas: {
        Error: {
          type: 'object',
          required: ['error'],
          properties: {
            error: {
              type: 'object',
              required: ['status', 'code', 'message', 'messageEn'],
              properties: {
                status: { type: 'integer' },
                code: { type: 'string', examples: ['invalid_parameter', 'unknown_parameter', 'not_found', 'rate_limited', 'dataset_unavailable', 'method_not_allowed'] },
                param: nullable({ type: 'string' }),
                message: { type: 'string', description: '한국어 메시지' },
                messageEn: { type: 'string', description: 'English message' },
              },
            },
          },
        },
        MetricStatus: {
          type: 'string',
          enum: METRIC_STATUSES,
          description: 'exact 정확 · interpolated 보간(≈) · lower_bound 하한(≥) · source_reported 원천 보고 · unavailable 계산 불가(—) · decrease_flagged 감소 감지(⚠, 순위 제외)',
        },
        MetricValue: {
          type: 'object',
          required: ['value', 'status', 'asOf', 'note'],
          properties: {
            value: nullable({ type: 'number' }),
            status: ref('MetricStatus'),
            asOf: nullable({ type: 'integer', description: 'epoch ms' }),
            note: nullable({ type: 'string', description: 'machine-readable reason, e.g. counter_not_provided, not_reached, source_window' }),
          },
        },
        Window: {
          type: 'object',
          description: '반열린 UTC 구간 [startMs, endMs).',
          properties: {
            startMs: { type: 'integer' },
            endMs: { type: 'integer' },
            start: { type: 'string', format: 'date-time' },
            end: { type: 'string', format: 'date-time' },
            tz: { type: 'string' },
            startLocal: { type: 'string' },
            endLocal: { type: 'string' },
            firstDate: { type: 'string', format: 'date' },
            lastDate: { type: 'string', format: 'date' },
            rollingHours: nullable({ type: 'number' }),
            incomplete: { type: 'boolean', description: '기간이 데이터 기준 시각 이후까지 이어짐 (부분 집계).' },
          },
        },
        RangeEcho: {
          type: 'object',
          properties: {
            spec: { type: 'string' },
            preset: nullable({ type: 'string' }),
            start: { type: 'string', format: 'date' },
            end: { type: 'string', format: 'date' },
            rollingHours: nullable({ type: 'number' }),
            default: { type: 'boolean', description: '요청에 기간이 없어 기본값을 사용함' },
          },
        },
        Category: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            label: { type: 'string' },
            confidence: { type: 'number' },
            by: { type: 'string', enum: ['rule', 'source', 'account', 'manual'] },
            version: { type: 'string' },
            evidence: arrayOf({ type: 'object', properties: { field: { type: 'string' }, match: { type: 'string' } } }),
          },
        },
        Video: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            platform: { type: 'string', enum: PLATFORMS },
            platformId: { type: 'string' },
            url: { type: 'string' },
            title: { type: 'string' },
            description: nullable({ type: 'string' }),
            thumbnail: nullable({ type: 'string' }),
            publishedAt: { type: 'integer' },
            durationSec: nullable({ type: 'number' }),
            format: { type: 'string', enum: VIDEO_FORMATS },
            accountId: { type: 'string' },
            language: nullable({ type: 'string' }),
            languageSource: nullable({ type: 'string' }),
            country: nullable({ type: 'string', description: '업로드 국가(원천 제공), 시청자 지역 아님' }),
            sourceCategory: nullable({ type: 'string' }),
            tags: arrayOf({ type: 'string' }),
            categories: arrayOf(ref('Category')),
            topics: arrayOf({ type: 'string' }),
            sponsorship: nullable({ type: 'object' }),
            status: { type: 'string', enum: ['active', 'deleted', 'private', 'unknown'] },
            firstSeenAt: { type: 'integer' },
            lastObservedAt: { type: 'integer' },
            discoveredVia: arrayOf({ type: 'string' }),
            observationCount: { type: 'integer' },
          },
        },
        Account: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            platform: { type: 'string', enum: PLATFORMS },
            platformId: { type: 'string' },
            handle: nullable({ type: 'string' }),
            name: { type: 'string' },
            url: { type: 'string' },
            avatar: nullable({ type: 'string' }),
            country: nullable({ type: 'string' }),
            creatorId: nullable({ type: 'string' }),
            seedCategory: nullable({ type: 'string' }),
            trackedSince: { type: 'integer' },
            followers: nullable({ type: 'object', properties: { value: { type: 'number' }, asOf: { type: 'integer' } } }),
            followerObservations: { type: 'integer' },
          },
        },
        VideoMetrics: {
          type: 'object',
          properties: {
            viewsTotal: ref('MetricValue'),
            viewsPeriod: ref('MetricValue'),
            likesPeriod: ref('MetricValue'),
            commentsPeriod: ref('MetricValue'),
            velocity: ref('MetricValue'),
            growthVsPrev: ref('MetricValue'),
            engagementRate: { allOf: [ref('MetricValue'), { type: 'object', properties: { components: arrayOf({ type: 'string' }) } }] },
            viewsAtAge: ref('MetricValue'),
            outperformance: { allOf: [ref('MetricValue'), { type: 'object', properties: { ageDays: nullable({ type: 'integer' }), peers: { type: 'integer' } } }] },
            percentile: ref('MetricValue'),
          },
        },
        VideoRow: { type: 'object', properties: { video: ref('Video'), account: nullable(ref('Account')), metrics: ref('VideoMetrics') } },
        CompactVideoRow: {
          type: 'object',
          properties: {
            rank: { type: 'integer' },
            id: { type: 'string' },
            platform: { type: 'string' },
            url: { type: 'string' },
            title: { type: 'string' },
            thumbnail: nullable({ type: 'string' }),
            account: { type: 'object', properties: { id: { type: 'string' }, name: nullable({ type: 'string' }) } },
            publishedAt: { type: 'integer' },
            metrics: { type: 'object', additionalProperties: { type: 'object', properties: { value: nullable({ type: 'number' }), status: ref('MetricStatus'), asOf: nullable({ type: 'integer' }) } } },
          },
        },
        VideoList: {
          type: 'object',
          properties: {
            query: { type: 'object', description: '서버가 실제로 사용한 정규화된 매개변수' },
            window: nullable(ref('Window')),
            now: { type: 'integer', description: '데이터 기준 시각 (epoch ms)' },
            total: { type: 'integer' },
            offset: { type: 'integer' },
            limit: nullable({ type: 'integer' }),
            count: { type: 'integer' },
            notes: arrayOf({ type: 'string', description: '결과 해석 안내 (한국어)' }),
            rows: arrayOf(ref('VideoRow')),
          },
        },
        VideoDetail: {
          type: 'object',
          properties: {
            query: { type: 'object' },
            now: { type: 'integer' },
            video: ref('Video'),
            account: nullable({ allOf: [ref('Account'), { type: 'object', properties: { followerSeries: arrayOf({ type: 'object' }) } }] }),
            creator: nullable({ type: 'object' }),
            window: ref('Window'),
            metrics: ref('VideoMetrics'),
            ratings: arrayOf({ type: 'object', properties: { ageDays: { type: 'integer' }, label: { type: 'string' }, views: ref('MetricValue'), likes: ref('MetricValue'), comments: ref('MetricValue') } }),
            daily: {
              type: 'object',
              properties: {
                tz: { type: 'string' },
                start: { type: 'string', format: 'date' },
                end: { type: 'string', format: 'date' },
                days: arrayOf({ type: 'object', properties: { date: { type: 'string', format: 'date' }, views: ref('MetricValue'), likes: ref('MetricValue'), comments: ref('MetricValue') } }),
              },
            },
            observations: arrayOf({
              type: 'object',
              properties: { t: { type: 'integer' }, views: nullable({ type: 'number' }), likes: nullable({ type: 'number' }), comments: nullable({ type: 'number' }), shares: nullable({ type: 'number' }), src: { type: 'string' } },
            }),
            sourceWindows: arrayOf({ type: 'object', properties: { metric: { type: 'string' }, windowHours: { type: 'number' }, value: { type: 'number' }, observedAt: { type: 'integer' }, src: { type: 'string' } } }),
            notes: arrayOf({ type: 'string' }),
          },
        },
        TrendItem: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: TREND_KINDS },
            key: { type: 'string' },
            label: { type: 'string' },
            platform: nullable({ type: 'string' }),
            current: { type: 'number' },
            previous: { type: 'number' },
            growth: nullable({ type: 'number' }),
            videoCount: { type: 'integer' },
            incompleteCount: { type: 'integer', description: '경계 관측 부족으로 합산하지 못한 영상 수' },
            topVideoIds: arrayOf({ type: 'string' }),
          },
        },
        Trending: {
          type: 'object',
          properties: {
            query: { type: 'object' },
            now: { type: 'integer' },
            window: ref('Window'),
            previousWindow: ref('Window'),
            rising: arrayOf(ref('TrendItem')),
            falling: arrayOf(ref('TrendItem')),
            top: arrayOf(ref('TrendItem')),
            notes: arrayOf({ type: 'string' }),
          },
        },
        Explore: {
          type: 'object',
          properties: {
            query: { type: 'object' },
            now: { type: 'integer' },
            platform: nullable({ type: 'string' }),
            platformLabel: nullable({ type: 'string' }),
            window: ref('Window'),
            items: arrayOf({
              type: 'object',
              properties: {
                topic: { type: 'string' },
                label: { type: 'string' },
                demand: { type: 'number' },
                supply: { type: 'integer' },
                demandPercentile: { type: 'number' },
                supplyPercentile: { type: 'number' },
                score: { type: 'number' },
                sampleVideoIds: arrayOf({ type: 'string' }),
              },
            }),
            notes: arrayOf({ type: 'string' }),
          },
        },
        CreatorSummary: {
          type: 'object',
          properties: {
            key: { type: 'string' },
            kind: { type: 'string', enum: ['creator', 'account'] },
            name: { type: 'string' },
            platforms: arrayOf({ type: 'string' }),
            accounts: arrayOf(ref('Account')),
            followers: nullable({ type: 'number' }),
            followersGrowth: ref('MetricValue'),
            videoCount: { type: 'integer' },
            uploadsInWindow: { type: 'integer' },
            viewsInWindow: ref('MetricValue'),
            engagementRate: ref('MetricValue'),
            medianV7: ref('MetricValue'),
            topCategories: arrayOf({ type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' } } }),
            sponsoredCount: { type: 'integer' },
          },
        },
        CreatorList: {
          type: 'object',
          properties: {
            query: { type: 'object' },
            now: { type: 'integer' },
            window: ref('Window'),
            total: { type: 'integer' },
            count: { type: 'integer' },
            rows: arrayOf(ref('CreatorSummary')),
            notes: arrayOf({ type: 'string' }),
          },
        },
        CreatorDetail: {
          type: 'object',
          properties: {
            query: { type: 'object' },
            now: { type: 'integer' },
            key: { type: 'string' },
            kind: { type: 'string', enum: ['creator', 'account'] },
            creator: nullable({ type: 'object' }),
            window: ref('Window'),
            summary: ref('CreatorSummary'),
            accounts: arrayOf(ref('Account')),
            timeline: {
              type: 'object',
              properties: {
                tz: { type: 'string' },
                start: { type: 'string', format: 'date' },
                end: { type: 'string', format: 'date' },
                days: arrayOf({ type: 'object', properties: { date: { type: 'string', format: 'date' }, byPlatform: { type: 'object', additionalProperties: ref('MetricValue') } } }),
              },
            },
            heatmap: {
              type: 'object',
              properties: {
                tz: { type: 'string' },
                weekdays: arrayOf({ type: 'string' }),
                counts: arrayOf(arrayOf({ type: 'integer' })),
                medianV7: arrayOf(arrayOf(nullable({ type: 'number' }))),
              },
            },
            topVideos: nullable({ type: 'object', properties: { total: { type: 'integer' }, rows: arrayOf(ref('CompactVideoRow')), notes: arrayOf({ type: 'string' }) } }),
            notes: arrayOf({ type: 'string' }),
          },
        },
        TaxonomyNode: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            parent: nullable({ type: 'string' }),
            label: { type: 'object', properties: { ko: { type: 'string' }, en: { type: 'string' } } },
            keywords: arrayOf({ type: 'string' }),
            sourceCategories: arrayOf({ type: 'string' }),
            counts: { type: 'object', properties: { direct: { type: 'integer' }, total: { type: 'integer' }, byPlatform: { type: 'object', additionalProperties: { type: 'integer' } } } },
            children: arrayOf(ref('TaxonomyNode')),
          },
        },
        Taxonomy: {
          type: 'object',
          properties: {
            generatedAt: { type: 'integer' },
            classifierVersion: { type: 'string' },
            totals: { type: 'object' },
            tree: arrayOf(ref('TaxonomyNode')),
            unknownCategoryIds: arrayOf({ type: 'object', properties: { id: { type: 'string' }, count: { type: 'integer' } } }),
            notes: arrayOf({ type: 'string' }),
          },
        },
        Coverage: {
          type: 'object',
          properties: {
            generatedAt: { type: 'integer' },
            classifierVersion: { type: 'string' },
            tz: { type: 'string' },
            sources: arrayOf({ type: 'object', description: 'SourceCoverage (packages/core/src/types.ts)' }),
            runs: arrayOf({ type: 'object', description: 'CollectionRun, newest first' }),
            exportNotes: arrayOf({ type: 'string' }),
            platforms: arrayOf({ type: 'object' }),
            observationDensity: { type: 'object' },
            windowQuality: arrayOf({
              type: 'object',
              description: '롤링 기본 기간별로 activity 모드 기간 조회 증가량을 어떤 상태로 계산할 수 있는지 (정확·원천 보고·하한·계산 불가 개수)',
              properties: { preset: { type: 'string' }, hours: { type: 'number' }, total: { type: 'integer' }, byStatus: { type: 'object' }, shares: { type: 'object' }, byPlatform: arrayOf({ type: 'object' }) },
            }),
            statusLabels: { type: 'object' },
            unsupported: arrayOf({ type: 'object', properties: { feature: { type: 'string' }, label: { type: 'string' }, reason: { type: 'string' } } }),
            notes: arrayOf({ type: 'string' }),
          },
        },
        Meta: {
          type: 'object',
          properties: {
            apiVersion: { type: 'string' },
            generatedAt: { type: 'integer' },
            generatedAtIso: { type: 'string', format: 'date-time' },
            classifierVersion: { type: 'string' },
            counts: { type: 'object' },
            platforms: arrayOf({ type: 'object' }),
            coverage: { type: 'object' },
            defaults: { type: 'object' },
          },
        },
        Health: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['ok', 'starting'] },
            apiVersion: { type: 'string' },
            time: { type: 'string', format: 'date-time' },
            uptimeSec: { type: 'integer' },
            dataset: nullable({ type: 'object' }),
            loader: {
              type: 'object',
              description:
                '데이터셋 로더 상태: file(파일 이름만), fromExport, loadedAt, generatedAt, bytes, loads, failures, lastError, lastErrorAt, watching. ' +
                '서버 경로·원본 오류 문구는 공개하지 않으며(lastError는 일반 안내 문구), 서버를 HEALTH_VERBOSE=1로 실행한 경우에만 path·exportDir·원본 lastError가 붙습니다.',
            },
            scheduler: {
              type: 'object',
              description:
                '수집 스케줄러 상태: enabled, intervalMin, running, nextRunAt, runs, failures, lastRun { startedAt, finishedAt, ok, message, error }. ' +
                'lastRun.error는 일반 안내 문구이며, 원본 오류와 details는 HEALTH_VERBOSE=1일 때만 포함됩니다.',
            },
          },
        },
      },
    },
  };
}
