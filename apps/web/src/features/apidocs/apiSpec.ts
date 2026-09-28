/**
 * Content of the API page: the REST API served by apps/server (src/app.ts, src/params.ts, src/routes/*) and the
 * static JSON files published with the GitHub Pages site (apps/server/src/static-api.ts). Kept as data so it
 * can be tested for consistency (every endpoint has examples, params are unique, URLs are well-formed).
 */

export const LIVE_SITE = 'https://chldbwnstm.github.io/video-trend-intel/';
export const LIVE_STATIC_API = `${LIVE_SITE}api/v1/`;
export const LOCAL_SERVER = 'http://localhost:8787';
export const API_PREFIX = '/api/v1';

export interface ParamDoc {
  name: string;
  /** Other accepted names. */
  aliases?: string[];
  type: string;
  default?: string;
  description: string;
}

export interface FieldDoc {
  name: string;
  type: string;
  description: string;
}

export interface ExampleDoc {
  title: string;
  /** Full URL (the curl command is built from it). */
  url: string;
  /** Extra curl flags, e.g. `-o videos.csv`. */
  flags?: string;
  /** Pipe suffix, e.g. `| jq '.rows[0]'`. */
  pipe?: string;
}

export interface EndpointDoc {
  id: string;
  method: 'GET';
  path: string;
  summary: string;
  description?: string;
  params: ParamDoc[];
  fields: FieldDoc[];
  examples: ExampleDoc[];
  /** Static JSON equivalent on GitHub Pages, if any. */
  staticPath?: string;
}

/* ------------------------------------------------------------------------------------------ common params */

export const TZ_PARAM: ParamDoc = {
  name: 'tz',
  aliases: ['timeZone'],
  type: 'IANA 시간대',
  default: 'Asia/Seoul',
  description: '날짜 기간을 해석하고 현지 시각을 표시할 시간대. 예: Asia/Seoul, Australia/Sydney, UTC.',
};

export const AS_OF_PARAM: ParamDoc = {
  name: 'asOf',
  type: 'ISO 날짜·시각 | epoch ms',
  default: '데이터 기준 시각(generatedAt)',
  description: "계산의 '현재'. 과거 시점(최대 400일 전)으로 돌려 그때 알던 관측만으로 다시 계산함. 미래 시각은 거부.",
};

export const RANGE_PARAMS: ParamDoc[] = [
  {
    name: 'range',
    aliases: ['preset'],
    type: '프리셋 | YYYY-MM-DD..YYYY-MM-DD',
    default: 'rolling7d',
    description:
      '기간. 롤링 프리셋 rolling24h·rolling7d·rolling30d(데이터 기준 시각까지 24·168·720시간), 날짜 프리셋 today·yesterday·last7d·last30d·last90d·thisWeek·lastWeek·thisMonth·lastMonth, 또는 현지 날짜 범위(양 끝 포함, 최대 731일).',
  },
  { name: 'start, end', aliases: ['from, to'], type: 'YYYY-MM-DD', description: 'range 대신 현지 날짜 시작·끝(양 끝 포함). 둘 다 필요.' },
  { name: 'hours', aliases: ['rollingHours'], type: '숫자(1~17544)', description: 'range 대신 [기준 시각 - hours, 기준 시각) 롤링 기간. range·start/end·hours 중 하나만 씀.' },
];

/* ------------------------------------------------------------------------------------------ shared fields */

export const METRIC_VALUE_FIELDS: FieldDoc[] = [
  { name: 'value', type: 'number | null', description: '값. status가 unavailable이면 null(0이 아님).' },
  { name: 'status', type: 'MetricStatus', description: 'exact · interpolated · lower_bound · source_reported · unavailable · decrease_flagged (아래 표).' },
  { name: 'asOf', type: 'epoch ms | null', description: '값이 가리키는(마지막으로 관측된) 시각.' },
  { name: 'note', type: 'string | null', description: '기계용 사유 코드. 예: gap_too_wide, not_reached, counter_not_provided, source_window.' },
];

export const WINDOW_FIELDS: FieldDoc[] = [
  { name: 'startMs, endMs', type: 'epoch ms', description: '반열린 구간 [start, end), UTC.' },
  { name: 'start, end', type: 'ISO 문자열', description: '같은 구간의 ISO 표기.' },
  { name: 'tz, startLocal, endLocal', type: 'string', description: '해석한 시간대와 현지 시각.' },
  { name: 'firstDate, lastDate', type: 'YYYY-MM-DD', description: '구간이 포함하는 현지 날짜(양 끝 포함).' },
  { name: 'rollingHours', type: 'number | null', description: '롤링 기간이면 시간 수.' },
  { name: 'incomplete', type: 'boolean', description: '기간 끝이 데이터 기준 시각보다 뒤(진행 중인 기간, 값이 더 늘 수 있음).' },
];

export const VIDEO_METRIC_FIELDS: FieldDoc[] = [
  { name: 'viewsTotal', type: 'MetricValue', description: '누적 조회 (기간 끝과 기준 시각 중 이른 시점).' },
  { name: 'viewsPeriod', type: 'MetricValue', description: '조회 발생 기간: 기간 안 조회 증가 / 업로드 기간: 게시 후 조회.' },
  { name: 'likesPeriod, commentsPeriod', type: 'MetricValue', description: '같은 방식의 좋아요·댓글 증가.' },
  { name: 'velocity', type: 'MetricValue', description: '최근 약 24시간 시간당 조회 증가.' },
  { name: 'growthVsPrev', type: 'MetricValue', description: '직전 같은 길이 기간 대비 증가율 (비율, 0.34 = +34%).' },
  { name: 'engagementRate', type: 'MetricValue + components', description: '(좋아요+댓글+공유 중 제공된 것) / 조회. components에 실제로 더한 항목.' },
  { name: 'viewsAtAge', type: 'MetricValue', description: '게시 후 age일 시점 조회 (age 모드).' },
  { name: 'outperformance', type: 'MetricValue + ageDays, peers', description: '같은 계정 다른 영상의 같은 나이 조회 중앙값 대비 배수.' },
  { name: 'percentile', type: 'MetricValue', description: '결과 안 같은 플랫폼 영상 사이의 백분위(0~100).' },
];

/* ------------------------------------------------------------------------------------------ endpoints */

const L = LOCAL_SERVER + API_PREFIX;

export const ENDPOINTS: EndpointDoc[] = [
  {
    id: 'health',
    method: 'GET',
    path: '/api/v1/health',
    summary: '서버·데이터셋·수집 스케줄러 상태',
    description: '속도 제한과 캐시에서 제외됨. 데이터셋을 아직 못 읽었으면 status가 starting.',
    params: [],
    fields: [
      { name: 'status', type: "'ok' | 'starting'", description: '데이터셋이 로드되면 ok.' },
      { name: 'apiVersion', type: 'string', description: '응답 형식 버전 (ETag에도 포함).' },
      { name: 'dataset', type: 'object | null', description: 'generatedAt, generatedAtIso, ageMinutes, videos, accounts.' },
      { name: 'uptimeSec, time, cache', type: '-', description: '서버 가동 시간, 현재 시각, 응답 캐시 통계. 스케줄러 상태가 함께 올 수 있음.' },
    ],
    examples: [{ title: '상태 확인', url: `${L}/health` }],
  },
  {
    id: 'meta',
    method: 'GET',
    path: '/api/v1/meta',
    summary: '데이터셋 버전·개수·수집 범위 요약',
    params: [],
    fields: [
      { name: 'generatedAt, generatedAtIso', type: 'epoch ms, ISO', description: '데이터 기준 시각. 모든 계산의 기본 now.' },
      { name: 'classifierVersion', type: 'string', description: '분류기 버전 (예: rules-2026.09.1).' },
      { name: 'counts', type: 'object', description: 'videos, accounts, creators, observations, runs, sources, exportNotes.' },
      { name: 'platforms[]', type: 'object', description: '플랫폼별 영상·계정 수.' },
      { name: 'coverage', type: 'object', description: '원천 목록·상태, 분류 비율, 협찬 신호 수, 관측 1회뿐인 영상 수, 내보내기 메모.' },
      { name: 'defaults', type: 'object', description: '기본 tz·mode·range·sort·limit와 쓸 수 있는 range 프리셋.' },
    ],
    examples: [{ title: '요약', url: `${L}/meta` }],
    staticPath: 'meta.json',
  },
  {
    id: 'videos',
    method: 'GET',
    path: '/api/v1/videos',
    summary: '영상 검색·필터·정렬 (JSON 또는 CSV)',
    description: '매개변수 이름은 웹 앱 주소의 쿼리 키와 같아서 화면의 조건을 그대로 옮겨 쓸 수 있음. 알 수 없는 매개변수는 400 (오타 방지).',
    params: [
      { name: 'mode', aliases: ['dateMode'], type: 'upload | activity | age', default: 'activity', description: '날짜 기준. upload = 기간 안에 게시, activity = 기간 동안 늘어난 조회, age = 게시 후 N일 시점.' },
      ...RANGE_PARAMS,
      { name: 'age', aliases: ['ageDays'], type: '1 | 2 | 3 | 7 | 30', default: 'age 모드 7', description: '게시 후 경과 일수 (V1~V30).' },
      { name: 'sort', type: 'SortKey', default: 'views_period (age: views_at_age)', description: 'views_total · views_period · likes_period · comments_period · velocity · growth_vs_prev · engagement_rate · outperformance · views_at_age · percentile · published_at' },
      { name: 'dir', aliases: ['sortDir'], type: 'desc | asc', default: 'desc', description: '정렬 방향. 계산 불가 값은 항상 뒤.' },
      { name: 'limit', type: '정수', default: '50 (CSV 500)', description: '최대 500 (CSV 5000).' },
      { name: 'offset | page', type: '정수', default: '0', description: '페이지 이동. 둘 중 하나만.' },
      { name: 'q', aliases: ['query'], type: '문자열', description: '제목·태그·주제·계정 이름 검색 (모든 단어 포함, 최대 200자).' },
      { name: 'platforms', aliases: ['platform'], type: '쉼표 목록', description: 'youtube, dailymotion, peertube, niconico, tiktok, instagram, x, twitch' },
      { name: 'cats', aliases: ['categories', 'category'], type: '쉼표 목록', description: '분야 ID (하위 분야 포함). /api/v1/taxonomy에서 확인.' },
      { name: 'topics', aliases: ['topic'], type: '쉼표 목록', description: '주제 키 (소문자 해시태그·태그).' },
      { name: 'langs', aliases: ['languages', 'language'], type: '쉼표 목록', description: '영상 언어 (ISO 639-1: ko, en, ja).' },
      { name: 'countries', aliases: ['country'], type: '쉼표 목록', description: '업로드 국가(원천 제공, KR·US·JP). 시청 지역이 아님.' },
      { name: 'formats', type: '쉼표 목록', description: 'short · long · live · unknown' },
      { name: 'accounts, creators', aliases: ['accountIds, creatorIds'], type: '쉼표 목록', description: '계정 ID(youtube:UC…) 또는 크리에이터 ID로 제한.' },
      { name: 'sponsored', type: 'disclosed | any | none', description: '광고 표기만 / 협찬 신호 전체 / 협찬 신호 없음.' },
      { name: 'minViews', type: '숫자', description: '누적 조회 하한 (알 수 없는 값은 제외).' },
      TZ_PARAM,
      AS_OF_PARAM,
      { name: 'format', aliases: ['output'], type: 'json | csv', default: 'json', description: 'csv는 UTF-8 BOM, 값마다 상태·기준 시각 열, 빈 값은 빈 칸. X-Total-Count 헤더.' },
    ],
    fields: [
      { name: 'query', type: 'object', description: '서버가 실제로 쓴 정규화된 조건 (기본값 포함).' },
      { name: 'window', type: 'Window | null', description: '해석된 기간 (아래 Window 필드).' },
      { name: 'now', type: 'epoch ms', description: '계산 기준 시각.' },
      { name: 'total, offset, limit, count', type: '정수', description: '필터 후 전체 개수와 이번 페이지.' },
      { name: 'notes[]', type: 'string', description: '날짜 기준·불완전 값 개수·플랫폼 단위 경고 같은 한국어 해설.' },
      { name: 'rows[].video', type: 'Video', description: '영상 메타데이터 (관측 배열 대신 observationCount). categories[].evidence에 분류 근거, sponsorship에 협찬 판정.' },
      { name: 'rows[].account', type: 'Account | null', description: '계정 (followers: 최신 팔로워 수와 기준 시각).' },
      { name: 'rows[].metrics', type: 'VideoMetrics', description: '모든 지표가 MetricValue (아래 표).' },
    ],
    examples: [
      { title: '최근 7일(168시간) 조회 증가 상위 YouTube 영상', url: `${L}/videos?mode=activity&range=rolling7d&platforms=youtube&limit=20`, pipe: "| jq '.rows[] | {title: .video.title, views: .metrics.viewsPeriod}'" },
      { title: '지난 30일 게시된 뷰티 영상, 누적 조회 순', url: `${L}/videos?mode=upload&range=last30d&cats=beauty&sort=views_total` },
      { title: '게시 후 7일 조회(V7) 순위', url: `${L}/videos?mode=age&age=7&sort=views_at_age&limit=50` },
      { title: 'CSV로 저장', url: `${L}/videos?mode=activity&range=rolling30d&format=csv&limit=2000`, flags: '-o videos.csv' },
    ],
    staticPath: 'videos/{activity|upload}/top-{preset}-{platform|all}.json',
  },
  {
    id: 'video',
    method: 'GET',
    path: '/api/v1/videos/{id}',
    summary: '영상 상세: 지표, V1~V30, 일별 증가량, 원 관측값',
    description: 'id는 플랫폼:원천ID 형식 (예: youtube:dQw4w9WgXcQ). 특수 문자가 있으면 URL 인코딩.',
    params: [
      { name: 'days', type: '정수 1~90', default: '30', description: '일별 증가량을 돌려줄 최근 날짜 수 (tz 기준).' },
      { name: 'mode', type: 'upload | activity | age', default: 'activity', description: 'metrics 계산 날짜 기준.' },
      ...RANGE_PARAMS.slice(0, 1),
      { name: 'age', type: '1 | 2 | 3 | 7 | 30', description: 'age 모드의 경과 일수.' },
      TZ_PARAM,
      AS_OF_PARAM,
    ],
    fields: [
      { name: 'video, account, creator', type: 'object', description: '영상, 계정(followerSeries 포함), 연결된 크리에이터.' },
      { name: 'metrics', type: 'VideoMetrics', description: '목록과 같은 지표 (percentile은 목록에서만 계산).' },
      { name: 'ratings[]', type: 'object', description: 'V1·V2·V3·V7·V30: 게시 후 N일 시점 조회·좋아요·댓글 (MetricValue).' },
      { name: 'daily.days[]', type: 'object', description: '현지 날짜별 조회·좋아요·댓글 증가 (경계 관측이 없으면 ≥ 또는 —).' },
      { name: 'observations[], sourceWindows[]', type: 'array', description: '원 관측값(t, views, likes, comments, shares, src)과 원천 제공 기간값.' },
    ],
    examples: [{ title: '영상 상세 (최근 14일 일별)', url: `${L}/videos/youtube:VIDEO_ID?days=14` }],
  },
  {
    id: 'trending',
    method: 'GET',
    path: '/api/v1/trending',
    summary: '상승·하락·상위 주제/분야/크리에이터/계정',
    description: '직전 같은 길이 기간과 비교. 두 기간 모두 측정된 영상만 더하고(같은 조건 비교), 관측이 부족한 영상 수는 incompleteCount로 알려 줌.',
    params: [
      { name: 'kind', type: 'topic | category | creator | account', default: 'topic', description: '묶는 단위.' },
      ...RANGE_PARAMS,
      { name: 'platforms, cats, langs', type: '쉼표 목록', description: '범위 제한.' },
      { name: 'minVideos', type: '정수', default: '3', description: '항목에 필요한 최소 영상 수.' },
      { name: 'minCurrent', type: '숫자', description: '상승·하락 목록의 최소 규모 (작은 기준값의 과장 방지).' },
      { name: 'limit', type: '정수 1~100', default: '20', description: '목록별 개수.' },
      TZ_PARAM,
      AS_OF_PARAM,
    ],
    fields: [
      { name: 'window, previousWindow', type: 'Window', description: '비교한 두 기간 (진행 중이면 같은 경과 시간끼리).' },
      { name: 'rising[], falling[], top[]', type: 'TrendItem', description: 'key, label, platform, current, previous, growth(비율|null), videoCount, incompleteCount, topVideoIds.' },
      { name: 'notes[]', type: 'string', description: '계산 해설.' },
    ],
    examples: [
      { title: '뜨는 주제 (최근 7일)', url: `${L}/trending?kind=topic&range=rolling7d` },
      { title: 'YouTube 분야 트렌드', url: `${L}/trending?kind=category&range=last7d&platforms=youtube` },
    ],
    staticPath: 'trending/{kind}-{preset}.json',
  },
  {
    id: 'explore',
    method: 'GET',
    path: '/api/v1/explore',
    summary: '기회 탐색: 주제별 수요 대 공급 (한 플랫폼)',
    description: '플랫폼마다 조회 단위가 달라 한 번에 한 플랫폼만 분석. 지정하지 않으면 기간 내 게시 영상이 가장 많은 플랫폼.',
    params: [
      { name: 'platform', aliases: ['platforms'], type: '플랫폼 1개', description: '분석할 플랫폼.' },
      ...RANGE_PARAMS,
      { name: 'cats, langs', type: '쉼표 목록', description: '범위 제한.' },
      { name: 'minSupply', type: '정수', default: '3', description: '주제에 필요한 최소 게시 영상 수.' },
      { name: 'limit', type: '정수 1~200', default: '50', description: '개수.' },
      TZ_PARAM,
      AS_OF_PARAM,
    ],
    fields: [
      { name: 'platform', type: 'Platform | null', description: '분석한 플랫폼.' },
      { name: 'items[]', type: 'OpportunityItem', description: 'topic, label, demand(영상당 조회 중앙값), supply(게시 수), demandPercentile, supplyPercentile, score, sampleVideoIds.' },
    ],
    examples: [{ title: 'YouTube 최근 30일 기회 주제', url: `${L}/explore?platform=youtube&range=rolling30d&limit=20` }],
  },
  {
    id: 'creators',
    method: 'GET',
    path: '/api/v1/creators',
    summary: '크리에이터·계정 포트폴리오 요약',
    params: [
      ...RANGE_PARAMS,
      { name: 'platforms, cats', type: '쉼표 목록', description: '범위 제한.' },
      { name: 'q', type: '문자열', description: '이름·핸들 검색.' },
      { name: 'sort', type: 'views_period | followers | uploads | engagement | median_v7 | followers_growth', default: 'views_period', description: '정렬.' },
      { name: 'limit, offset', type: '정수', default: '50, 0', description: '최대 500.' },
      TZ_PARAM,
      AS_OF_PARAM,
    ],
    fields: [
      { name: 'rows[].key, kind, name', type: 'string', description: '크리에이터 ID(여러 플랫폼 연결) 또는 계정 ID.' },
      { name: 'rows[].viewsInWindow', type: 'MetricValue', description: '기간 조회 증가 합계 (일부 영상 관측이 없으면 ≥). 여러 플랫폼 합은 참고용.' },
      { name: 'rows[].followers, followersGrowth', type: 'number | null, MetricValue', description: '최신 팔로워 수와 기간 증가.' },
      { name: 'rows[].engagementRate, medianV7', type: 'MetricValue', description: '참여율, 게시 후 7일 조회 중앙값.' },
      { name: 'rows[].uploadsInWindow, videoCount, sponsoredCount, topCategories', type: '-', description: '업로드 수, 추적 영상 수, 협찬 신호 영상 수, 상위 분야.' },
    ],
    examples: [{ title: '최근 30일 조회 증가 상위 10', url: `${L}/creators?range=rolling30d&sort=views_period&limit=10` }],
    staticPath: 'creators/top-{last30d|rolling30d}.json',
  },
  {
    id: 'creator',
    method: 'GET',
    path: '/api/v1/creators/{key}',
    summary: '크리에이터·계정 상세: 요약, 일별 증가, 게시 시간 히트맵, 상위 영상',
    params: [...RANGE_PARAMS, { name: 'top', type: '정수 0~50', default: '10', description: '기간 상위 영상 개수.' }, TZ_PARAM, AS_OF_PARAM],
    fields: [
      { name: 'summary', type: 'CreatorSummary', description: '목록과 같은 요약.' },
      { name: 'accounts[]', type: 'Account', description: '플랫폼별 계정과 팔로워 관측.' },
      { name: 'timeline.days[]', type: 'object', description: '현지 날짜별·플랫폼별 조회 증가 (MetricValue).' },
      { name: 'heatmap', type: 'object', description: '게시 요일(월=0)·시각별 업로드 수와 V7 중앙값.' },
      { name: 'topVideos', type: 'object | null', description: '기간 조회 증가 상위 영상 (간단 행).' },
    ],
    examples: [{ title: '계정 상세', url: `${L}/creators/youtube:CHANNEL_ID?range=rolling30d` }],
  },
  {
    id: 'taxonomy',
    method: 'GET',
    path: '/api/v1/taxonomy',
    summary: '분류 체계 트리와 영상 수',
    params: [{ name: 'keywords', type: '1 | 0', default: '1', description: '0이면 키워드 목록을 빼서 응답을 줄임.' }],
    fields: [
      { name: 'classifierVersion', type: 'string', description: '분류기 버전.' },
      { name: 'totals', type: 'object', description: 'videos, categorized, uncategorized, categorizedShare, assignmentsBy(rule·source·account·manual).' },
      { name: 'tree[]', type: 'TreeNode', description: 'id, parent, label{ko,en}, keywords, sourceCategories, counts{direct,total,byPlatform}, children.' },
      { name: 'unknownCategoryIds[]', type: 'object', description: '현재 분류 체계에 없는 ID와 영상 수.' },
    ],
    examples: [{ title: '키워드 없이 트리만', url: `${L}/taxonomy?keywords=0` }],
    staticPath: 'taxonomy.json',
  },
  {
    id: 'coverage',
    method: 'GET',
    path: '/api/v1/coverage',
    summary: '데이터 범위: 원천, 실행 기록, 관측 밀도, 기간값 정확도 분포',
    params: [TZ_PARAM],
    fields: [
      { name: 'sources[]', type: 'SourceCoverage', description: '원천별 수집 방식·제공 지표·상태·마지막 오류·영상 수·주의 사항·문서.' },
      { name: 'runs[]', type: 'CollectionRun', description: '수집 실행 기록 (최신 순, 오류 포함).' },
      { name: 'exportNotes[]', type: 'string', description: '내보내기 때 줄이거나 뺀 것.' },
      { name: 'observationDensity', type: 'object', description: '영상당 관측 횟수 분포와 관측 이력 시간.' },
      { name: 'windowQuality[]', type: 'object', description: '최근 24시간·168시간·720시간 기간 조회 증가 값의 상태 분포 (전체·플랫폼별).' },
      { name: 'unsupported[]', type: 'object', description: '제공하지 않는 기능과 이유 (Audience Ratings, Consumer Insights).' },
    ],
    examples: [{ title: '데이터 범위', url: `${L}/coverage` }],
    staticPath: 'coverage.json',
  },
  {
    id: 'dataset',
    method: 'GET',
    path: '/api/v1/dataset',
    summary: '웹 앱이 읽는 압축 데이터셋 전체 (format 2)',
    description: '관측값은 열 단위 차분 압축. @vti/core의 decodeDataset()으로 풀 수 있음. gzip 지원. /data/dataset.json과 같은 내용.',
    params: [],
    fields: [
      { name: 'schemaVersion, format, generatedAt, classifierVersion', type: '-', description: '버전 정보.' },
      { name: 'videos[], accounts[], creators[], coverage[], runs[], exportNotes[]', type: 'array', description: '전체 데이터.' },
    ],
    examples: [{ title: '압축해서 받기', url: `${L}/dataset`, flags: '--compressed -o dataset.json' }],
  },
  {
    id: 'openapi',
    method: 'GET',
    path: '/api/v1/openapi.json',
    summary: 'OpenAPI 3.1 문서',
    params: [],
    fields: [],
    examples: [{ title: '스키마 받기', url: `${L}/openapi.json`, flags: '-o openapi.json' }],
    staticPath: 'openapi.json',
  },
];

/* ------------------------------------------------------------------------------------------ static files */

export interface StaticFileDoc {
  pattern: string;
  description: string;
  values?: string;
  example: string;
}

export const STATIC_FILES: StaticFileDoc[] = [
  { pattern: 'index.json', description: '정적 API 파일 목록 (경로·설명·크기)과 기준 시각', example: 'index.json' },
  { pattern: 'meta.json', description: '/api/v1/meta와 같은 요약', example: 'meta.json' },
  { pattern: 'coverage.json', description: '/api/v1/coverage와 같은 데이터 범위 (tz=Asia/Seoul)', example: 'coverage.json' },
  { pattern: 'taxonomy.json', description: '/api/v1/taxonomy와 같은 분류 체계 트리', example: 'taxonomy.json' },
  { pattern: 'openapi.json', description: '서버 API 설명 (정적 사이트에서는 이 목록의 파일만 제공)', example: 'openapi.json' },
  {
    pattern: 'videos/{mode}/top-{preset}-{platform}.json',
    description: '상위 영상 100개 (간단 행: rank, id, url, title, account, publishedAt, 주요 지표). activity는 기간 조회 증가 순, upload는 누적 조회 순.',
    values: 'mode = activity | upload · preset = last7d | last30d | rolling7d | rolling30d · platform = all | 데이터에 있는 플랫폼',
    example: 'videos/activity/top-rolling7d-all.json',
  },
  {
    pattern: 'trending/{kind}-{preset}.json',
    description: '트렌드 (상승·하락·상위 20개)',
    values: 'kind = topic | category | creator | account · preset = last7d | rolling7d',
    example: 'trending/topic-rolling7d.json',
  },
  {
    pattern: 'creators/top-{preset}.json',
    description: '크리에이터·계정 상위 100개 (기간 조회 증가 순)',
    values: 'preset = last30d | rolling30d',
    example: 'creators/top-rolling30d.json',
  },
];

/* ------------------------------------------------------------------------------------------ errors */

export const ERROR_CODES: { status: number; code: string; meaning: string }[] = [
  { status: 400, code: 'invalid_parameter', meaning: '값이 잘못됨 (param에 매개변수 이름).' },
  { status: 400, code: 'unknown_parameter', meaning: '알 수 없는 매개변수 (오타 방지). _로 시작하는 키는 무시.' },
  { status: 404, code: 'not_found', meaning: '영상·크리에이터·경로 없음.' },
  { status: 405, code: 'method_not_allowed', meaning: 'GET·HEAD만 허용 (읽기 전용).' },
  { status: 429, code: 'rate_limited', meaning: 'IP당 분당 120회 초과. Retry-After 헤더만큼 기다림.' },
  { status: 503, code: 'dataset_unavailable', meaning: '데이터셋을 아직 못 읽음 (첫 수집 전). /health 확인.' },
  { status: 500, code: 'internal_error', meaning: '서버 오류.' },
];

/* ------------------------------------------------------------------------------------------ helpers */

/** Shell-quoted curl command for an example. */
export function curlCommand(ex: ExampleDoc): string {
  const url = ex.url.includes("'") ? `"${ex.url}"` : `'${ex.url}'`;
  return ['curl -s', ex.flags, url, ex.pipe].filter(Boolean).join(' ');
}

/** Absolute URL of a static API file on the live site. */
/**
 * Response header only apps/server sets on dataset-derived API responses (incl. its live `index.json`); static
 * hosting (GitHub Pages) never sends it.
 */
export const SERVER_MARKER_HEADER = 'x-data-generated-at';

/** Outcome of probing `api/v1/index.json` on the current site. */
export interface StaticProbe {
  /** A JSON response came back. */
  ok: boolean;
  /** It carried SERVER_MARKER_HEADER (served live by apps/server). */
  fromServer: boolean;
}

/**
 * The live check probes `api/v1/index.json` first (both hosts serve it). The REST health endpoint is probed only
 * when that answer came from apps/server or there was no static index at all: on static hosting `/health` does
 * not exist, and probing it would log a 404 in the browser console on every visit.
 */
export function shouldProbeServer(probe: StaticProbe): boolean {
  return !probe.ok || probe.fromServer;
}

export function liveStaticUrl(path: string): string {
  return `${LIVE_STATIC_API}${path}`;
}

export const JS_EXAMPLE = `// 브라우저·Node 18+ (정적 JSON, 인증 없음)
const res = await fetch('${LIVE_STATIC_API}videos/activity/top-rolling7d-all.json');
const data = await res.json();
for (const row of data.rows.slice(0, 5)) {
  const v = row.metrics.viewsPeriod; // { value, status, asOf }
  const shown = v.status === 'unavailable' ? '—' : (v.status === 'lower_bound' ? '≥ ' : '') + v.value;
  console.log(row.rank, row.platform, row.title, shown);
}`;

export const CONDITIONAL_EXAMPLE = `# 같은 데이터셋이면 304 (본문 없음): ETag를 저장해 두고 다시 보냄
curl -s -i '${LOCAL_SERVER}${API_PREFIX}/meta' | grep -i etag
curl -s -i -H 'If-None-Match: W/"vti-api-1.0.0-…"' '${LOCAL_SERVER}${API_PREFIX}/meta'`;

export const ERROR_EXAMPLE = `{
  "error": {
    "status": 400,
    "code": "invalid_parameter",
    "param": "mode",
    "message": "mode 값 'weekly'은(는) 지원하지 않습니다. 가능한 값: upload, activity, age.",
    "messageEn": "Invalid mode 'weekly'. Allowed: upload, activity, age."
  }
}`;

export const METRIC_EXAMPLE = `"viewsPeriod": { "value": 48210, "status": "lower_bound", "asOf": 1790609176000, "note": "start_before_first_observation" }
"likesPeriod": { "value": null, "status": "unavailable", "asOf": null, "note": "counter_not_provided" }`;
