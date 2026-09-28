/**
 * API (/api-docs): the read-only REST API served by apps/server (/api/v1/*) and the static JSON API published
 * with the GitHub Pages site (./api/v1/*.json), with curl examples, parameters, response fields and the
 * MetricValue status semantics. Same dataset and the same @vti/core calculations as the web app.
 */
import { Link } from 'react-router-dom';
import { Braces, FileJson, Gauge, Globe, ListTree, Ruler, Server, ShieldAlert } from 'lucide-react';
import { Card, CardHeader, PageHeader, SourceNote } from '../components/index.ts';
import { useDataset } from '../data/hooks.ts';
import { STATUS_META, STATUS_ORDER } from '../lib/metricStatus.ts';
import {
  API_PREFIX,
  CONDITIONAL_EXAMPLE,
  ENDPOINTS,
  ERROR_CODES,
  ERROR_EXAMPLE,
  JS_EXAMPLE,
  LIVE_SITE,
  LIVE_STATIC_API,
  LOCAL_SERVER,
  METRIC_EXAMPLE,
  METRIC_VALUE_FIELDS,
  RANGE_PARAMS,
  STATIC_FILES,
  AS_OF_PARAM,
  TZ_PARAM,
  VIDEO_METRIC_FIELDS,
  WINDOW_FIELDS,
} from '../features/apidocs/apiSpec.ts';
import { CodeBlock, EndpointCard, FieldTable, LiveCheck, MethodBadge, ParamTable, StaticFileTable } from '../features/apidocs/ApiDocsParts.tsx';

function scrollToId(id: string) {
  if (typeof document === 'undefined') return;
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  el.focus({ preventScroll: true });
}

export default function ApiDocsPage() {
  const { now } = useDataset();
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow="Tubular API"
        title="API"
        description="웹 앱과 같은 데이터셋, 같은 계산(@vti/core)을 프로그램에서 씀. 읽기 전용이며 인증이 필요 없음. 모든 지표는 값과 함께 상태(status)·기준 시각(asOf)을 돌려줌."
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader
            icon={<Globe className="size-4" />}
            title="정적 JSON API (GitHub Pages)"
            description="데이터셋 기준 시각으로 미리 계산한 자주 쓰는 응답. 서버 없이 바로 받음. 필터·정렬은 고정."
          />
          <p className="mb-2 text-xs text-fg-3">기본 주소</p>
          <CodeBlock code={LIVE_STATIC_API} label="정적 API 기본 주소" />
          <p className="mt-3 mb-2 text-xs text-fg-3">예시</p>
          <CodeBlock
            code={`curl -s '${LIVE_STATIC_API}index.json'\ncurl -s '${LIVE_STATIC_API}videos/activity/top-rolling7d-all.json' | jq '.rows[0]'\ncurl -s --compressed -o dataset.json '${LIVE_SITE}data/dataset.json'`}
            label="정적 API curl 예시"
          />
        </Card>
        <Card>
          <CardHeader
            icon={<Server className="size-4" />}
            title="REST API (apps/server)"
            description="모든 조건(기간·날짜 기준·플랫폼·분야·정렬·CSV)을 자유롭게 지정. 직접 실행하는 서버에서 제공."
          />
          <p className="mb-2 text-xs text-fg-3">기본 주소 (npm start, 포트는 PORT 환경 변수)</p>
          <CodeBlock code={`${LOCAL_SERVER}${API_PREFIX}`} label="REST API 기본 주소" />
          <p className="mt-3 mb-2 text-xs text-fg-3">예시</p>
          <CodeBlock
            code={`curl -s '${LOCAL_SERVER}${API_PREFIX}/health'\ncurl -s '${LOCAL_SERVER}${API_PREFIX}/videos?mode=activity&range=rolling7d&limit=10'\ncurl -s '${LOCAL_SERVER}${API_PREFIX}/openapi.json' -o openapi.json`}
            label="REST API curl 예시"
          />
        </Card>
      </div>

      <Card>
        <CardHeader icon={<Gauge className="size-4" />} title="이 사이트에서 쓸 수 있는 API" description="지금 보고 있는 주소에서 서버 API와 정적 JSON이 응답하는지 확인함." />
        <LiveCheck />
      </Card>

      <Card>
        <CardHeader icon={<Ruler className="size-4" />} title="지표 값 형식 (MetricValue)" description="숫자 하나하나가 어떻게 얻어졌는지 함께 옴. 없는 값은 0이 아니라 null + unavailable." />
        <div className="flex flex-col gap-3">
          <FieldTable fields={METRIC_VALUE_FIELDS} caption="MetricValue 필드" />
          <CodeBlock code={METRIC_EXAMPLE} label="MetricValue 예시" />
          <div className="scroll-thin max-w-full overflow-x-auto rounded-lg border border-line">
            <table className="w-full min-w-[520px] border-collapse text-[13px]">
              <caption className="sr-only">status 값의 의미</caption>
              <thead>
                <tr>
                  {['status', '화면 표시', '의미', '순위'].map((h) => (
                    <th key={h} scope="col" className="border-b border-line bg-surface-2 px-3 py-1.5 text-left text-xs font-medium text-fg-3">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {STATUS_ORDER.map((s) => (
                  <tr key={s} className="align-top">
                    <td className="border-b border-line px-3 py-1.5">
                      <code className="font-mono text-xs font-semibold text-fg">{s}</code>
                    </td>
                    <td className="border-b border-line px-3 py-1.5 whitespace-nowrap text-fg-2">
                      {s === 'unavailable' ? '— ' : s === 'source_reported' ? '' : STATUS_META[s].marker ? `${STATUS_META[s].marker} ` : '(표시 없음) '}
                      {STATUS_META[s].label}
                    </td>
                    <td className="border-b border-line px-3 py-1.5 text-fg-2">{STATUS_META[s].description}</td>
                    <td className="border-b border-line px-3 py-1.5 whitespace-nowrap text-fg-2">{STATUS_META[s].ranked ? '포함' : '제외'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-fg-3">
            합계(브랜드·분야·크리에이터)는 정확·보간·원천 값을 더하고, 관측이 부족한 영상이 섞이면 lower_bound, 감소한 영상은 빼서 계산함. 여러 플랫폼의 조회수는 단위가 달라
            합계는 참고용 (
            <Link to="/coverage" className="focus-ring rounded-sm text-accent-text hover:underline">
              데이터 범위
            </Link>
            의 지표 정의 참고).
          </p>
          <details className="text-[13px]">
            <summary className="focus-ring w-fit cursor-pointer rounded-sm text-xs font-semibold text-accent-text hover:underline">영상 지표(metrics)와 기간(window) 필드</summary>
            <div className="mt-2 flex flex-col gap-3">
              <FieldTable fields={VIDEO_METRIC_FIELDS} caption="영상 지표 필드" />
              <FieldTable fields={WINDOW_FIELDS} caption="기간 필드" />
            </div>
          </details>
        </div>
      </Card>

      <Card>
        <CardHeader icon={<ShieldAlert className="size-4" />} title="공통 규칙" description="기간·시간대·기준 시각, 캐시, 속도 제한, 오류 형식." />
        <div className="flex flex-col gap-3 text-[13px] text-fg-2">
          <ParamTable params={[...RANGE_PARAMS, TZ_PARAM, AS_OF_PARAM]} caption="공통 매개변수" />
          <ul className="list-disc space-y-1 pl-5">
            <li>
              기본 기간은 <code className="font-mono text-xs">rolling7d</code>(데이터 기준 시각까지 168시간). 롤링 기간은 경계가 정확히 관측 시각에 맞고 Dailymotion 원천 기간값을 쓸 수
              있어 권장함.
            </li>
            <li>날짜 기간은 tz 기준 현지 날짜(양 끝 포함)이며 내부적으로 [시작, 끝) UTC 구간으로 바꿈. 끝이 기준 시각보다 뒤면 window.incomplete = true.</li>
            <li>
              읽기 전용(GET·HEAD), CORS 허용(모든 출처), IP당 분당 120회(X-RateLimit-* 헤더, /health 제외). 응답에는 ETag·X-Data-Generated-At이 붙고 60초 공개 캐시,
              데이터셋이 같으면 If-None-Match로 304.
            </li>
            <li>알 수 없는 매개변수는 400 (오타 방지). 매개변수 이름은 웹 앱 주소 쿼리 키와 같음. 캐시 무효화용 키는 _로 시작.</li>
          </ul>
          <CodeBlock code={CONDITIONAL_EXAMPLE} label="조건부 요청 예시" />
          <div className="grid gap-3 lg:grid-cols-2">
            <div className="scroll-thin max-w-full overflow-x-auto rounded-lg border border-line">
              <table className="w-full min-w-[360px] border-collapse text-[13px]">
                <caption className="sr-only">오류 코드</caption>
                <thead>
                  <tr>
                    {['HTTP', 'code', '뜻'].map((h) => (
                      <th key={h} scope="col" className="border-b border-line bg-surface-2 px-3 py-1.5 text-left text-xs font-medium text-fg-3">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {ERROR_CODES.map((e) => (
                    <tr key={e.code} className="align-top">
                      <td className="border-b border-line px-3 py-1.5 tabular">{e.status}</td>
                      <td className="border-b border-line px-3 py-1.5">
                        <code className="font-mono text-xs">{e.code}</code>
                      </td>
                      <td className="border-b border-line px-3 py-1.5">{e.meaning}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <CodeBlock code={ERROR_EXAMPLE} label="오류 응답 예시" />
          </div>
        </div>
      </Card>

      <section aria-labelledby="api-endpoints-title" className="flex flex-col gap-3">
        <div className="flex flex-col gap-2">
          <h2 id="api-endpoints-title" className="flex items-center gap-2 text-[15px] font-semibold text-fg">
            <Braces className="size-4 text-fg-3" aria-hidden />
            REST 엔드포인트
          </h2>
          <nav aria-label="엔드포인트 목록" className="flex flex-wrap gap-1.5">
            {ENDPOINTS.map((ep) => (
              <button
                key={ep.id}
                type="button"
                onClick={() => scrollToId(`api-${ep.id}`)}
                className="focus-ring inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-0.5 text-xs text-fg-2 hover:border-line-strong hover:text-fg"
              >
                <MethodBadge method={ep.method} />
                <span className="font-mono">{ep.path.replace(API_PREFIX, '')}</span>
              </button>
            ))}
          </nav>
        </div>
        {ENDPOINTS.map((ep) => (
          <EndpointCard key={ep.id} ep={ep} />
        ))}
      </section>

      <Card>
        <CardHeader
          icon={<FileJson className="size-4" />}
          title="정적 JSON 파일 (GitHub Pages)"
          description={`${LIVE_STATIC_API} 아래. 배포할 때 apps/server/src/static-api.ts가 데이터셋 기준 시각(now = generatedAt)으로 생성함. 행 형식은 서버 응답과 같고 지표는 value·status·asOf를 가짐.`}
        />
        <StaticFileTable files={STATIC_FILES} />
        <p className="mt-3 mb-2 text-xs text-fg-3">JavaScript 예시</p>
        <CodeBlock code={JS_EXAMPLE} label="JavaScript 예시" />
      </Card>

      <Card>
        <CardHeader icon={<ListTree className="size-4" />} title="더 보기" />
        <ul className="list-disc space-y-1 pl-5 text-[13px] text-fg-2">
          <li>
            전체 스키마: <code className="font-mono text-xs">{API_PREFIX}/openapi.json</code> (OpenAPI 3.1). 정적 사이트에도 같은 파일이 있음.
          </li>
          <li>
            원천·수집 방식·지표 정의·계산 가능 범위는{' '}
            <Link to="/coverage" className="focus-ring rounded-sm text-accent-text hover:underline">
              데이터 범위
            </Link>
            , 분야 ID는{' '}
            <Link to="/taxonomy" className="focus-ring rounded-sm text-accent-text hover:underline">
              분류 체계
            </Link>
            에서 확인.
          </li>
          <li>플랫폼 원문 제목·썸네일·링크는 각 플랫폼 약관을 따름. 통계는 공개 값이며 플랫폼 전체가 아닌 추적 중인 영상 기준.</li>
        </ul>
      </Card>

      <SourceNote asOf={now} />
    </div>
  );
}
