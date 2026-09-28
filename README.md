# Video Trend Intel

기간·플랫폼·분야별로 인기 영상과 크리에이터를 찾는 멀티 플랫폼 영상 인텔리전스 서비스입니다.
Tubular Labs의 제품 구성(Video Intelligence, Trending, Video Ratings, Creator Intelligence, DealMaker,
ContentGraph, API)을 공개 데이터로 다시 만들고, 숫자마다 출처와 정확도를 함께 보여 줍니다.

- **라이브 사이트**: https://chldbwnstm.github.io/video-trend-intel/
- **정적 API**: https://chldbwnstm.github.io/video-trend-intel/api/v1/index.json
- 3시간마다 GitHub Actions가 새로 수집하고 다시 배포합니다.

[![CI](https://github.com/chldbwnstm/video-trend-intel/actions/workflows/ci.yml/badge.svg)](https://github.com/chldbwnstm/video-trend-intel/actions/workflows/ci.yml)
[![Collect & deploy](https://github.com/chldbwnstm/video-trend-intel/actions/workflows/collect-deploy.yml/badge.svg)](https://github.com/chldbwnstm/video-trend-intel/actions/workflows/collect-deploy.yml)

## 목차

1. [기능 지도 (Tubular 대응)](#기능-지도-tubular-대응)
2. [스크린샷](#스크린샷)
3. [데이터 원천과 수집 범위](#데이터-원천과-수집-범위)
4. [데이터 원칙](#데이터-원칙)
5. [아키텍처](#아키텍처)
6. [로컬 개발](#로컬-개발)
7. [Docker](#docker)
8. [API](#api)
9. [자동 업데이트 (GitHub Actions)](#자동-업데이트-github-actions)
10. [API 키 활성화](#api-키-활성화)
11. [처음 배포하기](#처음-배포하기)
12. [로컬 PC에서 주기 수집 (Windows)](#로컬-pc에서-주기-수집-windows)
13. [한계](#한계)
14. [로드맵](#로드맵)
15. [저장소 구조](#저장소-구조)

## 기능 지도 (Tubular 대응)

웹 앱은 HashRouter를 씁니다. 화면 주소는 `https://chldbwnstm.github.io/video-trend-intel/#/videos` 형태입니다.

| 화면 (경로) | Tubular 대응 제품 | 하는 일 |
|---|---|---|
| 대시보드 `#/` | Viewpoint 홈 | 기간 KPI, 기간 상위 영상, 뜨는 주제, 플랫폼 비중, 데이터 신선도 |
| 영상 탐색 `#/videos` | Video Intelligence | 검색·필터, 날짜 기준 3종, 지표 정렬, CSV 내보내기, 성장 차트와 원 관측값 |
| 트렌드 `#/trends` | Trending | 직전 같은 길이 기간 대비 상승·하락 주제, 분야, 크리에이터, 계정 |
| 비디오 레이팅 `#/ratings` | Video Ratings (V1/V2/V3/V7/V30) | 게시 후 같은 경과시간 기준 순위, 코호트 백분위 |
| 기회 탐색 `#/explore` | Viewpoint Explore | 주제별 수요(영상당 조회)와 공급(업로드 수) 비교 |
| 크리에이터 `#/creators`, `#/creators/:key` | Creator Intelligence | 여러 플랫폼 계정을 묶은 포트폴리오, 성장, 상위 영상, 게시 시간 히트맵 |
| 크리에이터 비교 `#/compare` | Creator Comparison | 최대 4명 비교 |
| 브랜드 협업 `#/brands` | DealMaker (간이판) | 협찬 표기 영상과 협찬 추정 영상, 브랜드 × 크리에이터 협업 |
| 분류 체계 `#/taxonomy` | ContentGraph | 계층형 분야·주제, 영상 수, 분류 근거 |
| 데이터 범위 `#/coverage` | (대응 없음, 신뢰 계층) | 원천, 발견 방식, 수집 범위, 신선도, 지표 정의, 실행 기록, 오류 |
| API `#/api-docs` | Tubular API | 서버 REST API와 정적 JSON 안내 |
| 만들지 않음 | Audience Ratings, Consumer Insights | 패널·동의 기반 데이터가 없어서 만들지 않았습니다. 데이터 범위 화면에 그 이유를 적어 두었습니다 |

## 스크린샷

> 준비 중입니다. `docs/screenshots/`에 대시보드, 영상 탐색, 데이터 범위 화면 캡처를 추가할 예정입니다.

| 대시보드 | 영상 탐색 | 데이터 범위 |
|---|---|---|
| _(예정)_ | _(예정)_ | _(예정)_ |

## 데이터 원천과 수집 범위

키 없이 쓸 수 있는 공식·공개 엔드포인트만 기본으로 호출합니다. 키가 필요한 원천은 해당 환경 변수(저장소 Secrets)가
있을 때만 켜집니다. HTML 페이지를 긁어서 지표를 얻지 않습니다.

| 어댑터 | 플랫폼 | 인증 | 발견 방식 | 지표 |
|---|---|---|---|---|
| `youtube-rss` | YouTube | 없음 | 시드 채널 391개(국내 350, 해외 41)의 RSS, **채널별 최신 업로드 15개** (업로드가 빨라 15개가 7일도 안 되는 채널은 긴 영상·Shorts 재생목록 피드에서 각 15개 더) | 조회, 좋아요 |
| `dailymotion` | Dailymotion | 없음 | 공식 API `/videos` (채널·국가·언어·정렬·검색 시드 70개, 국가 조건 없는 시드는 `localization=en_US` 고정) | 조회, 좋아요, 원천 제공 24시간·7일·30일 조회 |
| `peertube` | PeerTube | 없음 | SepiaSearch로 발견, 수치는 원 인스턴스 API에서만 읽음 | 조회, 좋아요, 댓글 |
| `niconico` | niconico | 없음 | Snapshot Search API v2 (하루 1회 갱신되는 스냅샷, 관측 시각은 스냅샷 시각) | 조회, 좋아요, 댓글 |
| `youtube-data-api` | YouTube | `YOUTUBE_API_KEY` | 키워드 시드 151개로 search.list (KR, ko) | 조회, 좋아요, 댓글, 구독자 |
| `tiktok-research` | TikTok | `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` | Research API 영상 검색 (연구 승인 필요) | 조회, 좋아요, 댓글, 공유 |
| `instagram-graph` | Instagram | `IG_ACCESS_TOKEN`, `IG_USER_ID` | business_discovery, 해시태그 검색 | 좋아요, 댓글 (제공 시 조회) |
| `x-api` | X | `X_BEARER_TOKEN` | v2 최근 검색 `has:videos` | 노출 수, 좋아요, 답글, 재게시 |
| `twitch` | Twitch | `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` | Helix 인기 게임별 클립·다시보기 | 조회 |

**첫 실수집 스냅샷 (2026-09-29).** 영상 14,178개(YouTube 5,865 · Dailymotion 5,324 · niconico 2,039 ·
PeerTube 950), 계정 2,208개, 크리에이터 15명(그중 14명은 플랫폼 간 연결 확인), 분류된 영상 98.5%,
협찬 표기 211개와 협찬 추정 186개. 최신 수치는 사이트의 데이터 범위 화면에서 확인하세요.

수집 범위에서 꼭 알아야 할 점:

- 이 데이터는 **플랫폼 전체가 아닙니다**. 시드 채널, 검색 질의, 공개 API가 돌려준 결과의 집합입니다.
  "플랫폼 1위"가 아니라 "수집된 영상 중 1위"로 읽어야 합니다.
- YouTube RSS는 채널당 최신 15개 업로드만 줍니다(빠른 채널은 긴 영상·Shorts 재생목록으로 각 15개 더). 모든 피드에서
  밀려난 영상은 더는 관측되지 않아 V7·V30을 계산할 수 없고, 실행마다 그런 영상 수를 데이터 범위 화면에 기록합니다.
  오래된 영상이나 시드에 없는 채널은 들어오지 않습니다. API 키를 넣으면 키워드 검색으로 범위가 넓어집니다.
- 불법 도박·성매매·대출 광고로 판별된 영상(주로 Dailymotion 인기 목록에 섞여 들어오는 홍보 영상)은 저장하지 않고,
  이미 저장된 것은 내보내기에서 뺍니다. 뺀 개수는 데이터 범위 화면의 메모에 남습니다.
- Dailymotion의 국가 조건 없는 시드는 요청 위치에 따라 결과가 달라집니다. 2026-09-28 수집을 GitHub Actions로
  옮긴 날 미국 영상 약 1,200개가 새 영상으로 한꺼번에 들어왔으니 그날 전후의 신규 업로드 추이는 주의해서 보세요.
  지금은 `localization=en_US`로 고정합니다(`DAILYMOTION_GLOBAL_LOCALIZATION`으로 변경).
- 조회수 이력은 처음 수집한 시점(2026-09-28)부터 쌓입니다. 이전 증가량은 알 수 없습니다.
- niconico는 하루 한 번 갱신되는 스냅샷이라 하루보다 짧은 기간의 증가량은 정확하지 않습니다.
- 협찬 추정은 제목·설명의 규칙 기반 추정입니다. 표기된 협찬(disclosed)과 구분해 보여 줍니다.

## 데이터 원칙

전체 규칙은 `SPEC.md`에 있습니다. 화면과 API가 공통으로 지키는 원칙은 다음과 같습니다.

1. **null은 0이 아닙니다.** 원천이 주지 않는 값은 비워 두고, 참여율은 있는 구성 요소만으로 계산해 무엇을 썼는지 밝힙니다.
2. **날짜 기준 3가지를 섞지 않습니다.** 화면은 지금 어떤 기준인지와 기준 시각(asOf)을 항상 표시합니다.

   | 기준 | 뜻 | 예 |
   |---|---|---|
   | 업로드 기간 (`upload`) | 기간 안에 게시된 영상, 값은 기준 시각의 누적값 | "이번 달 올라온 영상 중 인기" |
   | 조회 발생 기간 (`activity`) | 기간 안에 늘어난 조회, 게시일 무관 | "예전 영상까지 포함해 이번 주 많이 본 영상" |
   | 게시 후 경과 (`age`) | 게시 후 N일 시점 값 (V1·V2·V3·V7·V30) | "초반 반응이 가장 강한 영상" |

   기간 화면의 기본값은 **최근 24시간·7일(168시간)·30일(720시간)** 롤링 기간입니다. 데이터 기준 시각에서 정확히
   끝나기 때문에 경계 관측이 정확하고, Dailymotion이 직접 제공하는 기간 조회수도 그대로 쓸 수 있습니다.
3. **모든 숫자에 출처 상태가 붙습니다.** `MetricValue { value, status, asOf }`의 상태 표시는 다음과 같습니다.

   | 상태 | 표시 | 뜻 |
   |---|---|---|
   | `exact` | 숫자만 | 경계 양쪽 관측으로 계산한 정확한 값 |
   | `interpolated` | ≈ | 가까운 두 관측 사이를 보간한 값 |
   | `lower_bound` | ≥ | 관측이 기간 일부만 덮어 실제보다 작을 수 있는 하한 |
   | `source_reported` | 원천 | 플랫폼이 직접 제공한 기간 값 (Dailymotion 24시간·7일·30일) |
   | `unavailable` | — | 계산할 관측이 없음 |
   | `decrease_flagged` | ⚠ | 누적값이 줄어든 구간. 음수 인기로 순위에 넣지 않음 |

   첫 수집 직후에는 영상당 관측이 1개뿐이어서, 조회 발생 기준 값은 대략 정확 28%, 원천 보고 31%, 하한 4%,
   계산 불가 37%였습니다. 3시간마다 관측이 쌓이면서 정확한 값의 비율이 올라갑니다. 화면은 빈칸 대신 이 상태를
   표시하고 데이터 범위 화면으로 안내합니다.
4. **숨은 제한이 없습니다.** 내보내기 용량 예산, 요청 상한, 꺼진 원천처럼 잘라 낸 것은 `exportNotes`와
   데이터 범위 화면에 기록합니다.
5. **플랫폼마다 조회수 단위가 다릅니다.** X의 조회는 노출 수이고, YouTube Shorts는 2025년 3월에 집계 방식이
   바뀌었습니다. 기본 순위는 플랫폼 안에서 매기고, 여러 플랫폼을 섞으면 주의 문구와 플랫폼 내 백분위 정렬을 함께 보여 줍니다.
6. **국가, 언어, 시청자 지역은 서로 다릅니다.** 필터 이름도 "업로드 국가(원천 제공)"와 "영상 언어"로 구분합니다.
7. **시간은 UTC로 저장하고 IANA 시간대로 표시합니다.** 기본은 `Asia/Seoul`이고 `Australia/Sydney`도 고를 수 있습니다.
   기간은 `[시작, 끝)` 반열린 구간입니다.

## 아키텍처

```
 Sources (official / public APIs only)            packages/collector (Node, node:sqlite)
 ---------------------------------------          --------------------------------------
 YouTube RSS · Dailymotion · PeerTube · niconico --> adapters --> RawVideo
 + keyed: YouTube Data API · TikTok Research ·          |
   Instagram Graph · X · Twitch                          v
                                                     SQLite store  data/store.sqlite
                                                     videos · accounts · observations (append-only)
                                                         |  classify (@vti/core) + export
                                                         v
                                                     dataset.json  (compact, delta-encoded)
                          +------------------------------+------------------------------+
                          v                              v                              v
                 apps/web (Vite + React 19)     apps/server (Hono)             static API (api/v1/*.json)
                 analytics in the browser       /api/v1 REST + web build       precomputed for Pages
                 with @vti/core                 + collector every 3 h
                          |                                                             |
                          +---------------------> GitHub Pages <------------------------+
```

GitHub Actions의 3시간 주기 파이프라인 (`.github/workflows/collect-deploy.yml`):

```
 restore  Release "data-store" / store.sqlite.gz  -->  data/store.sqlite
 collect  npx tsx packages/collector/src/cli.ts collect      (secrets -> keyed adapters)
 save     guard: quick_check, size -20%, row counts, race; VACUUM INTO copy  -->  store.sqlite.gz (+ store.prev.sqlite.gz)
 export   data/export/dataset.json  -->  apps/web/public/data/dataset.json
 build    vite build -> apps/web/dist,  static API -> dist/api/v1,  .nojekyll, data/meta.json
 deploy   actions/deploy-pages  -->  https://chldbwnstm.github.io/video-trend-intel/
```

| 패키지 | 역할 |
|---|---|
| `packages/core` | 브라우저와 Node 공용 TypeScript: 도메인 타입, 데이터셋 코덱, 시간대, 시계열, 지표, 질의, 트렌드, 기회 탐색, 크리에이터, 분류 체계, 협찬 판별, CSV |
| `packages/collector` | 원천 어댑터, HTTP(원천별 속도 제한, 재시도), SQLite 저장소, 파이프라인, 단계별 재수집, 내보내기, CLI |
| `apps/web` | Vite + React 19 + Tailwind v4 + react-router(HashRouter) + recharts. `data/dataset.json`을 읽어 모든 분석을 브라우저에서 계산 |
| `apps/server` | Hono REST API, 웹 빌드 서빙, 새 내보내기 자동 반영, 주기 수집, 정적 API 생성기 |
| `deploy/` | GitHub Actions 저장소 스크립트, 첫 배포 스크립트, Windows 예약 작업 |

## 로컬 개발

Node.js 22.13 이상이 필요합니다(`node:sqlite`).

```bash
npm install
npm run collect             # 켜진 원천을 한 번 수집해 data/store.sqlite에 저장 (키 없이 약 5~6분)
npm run export              # data/export/dataset.json을 만들고 apps/web/public/data/dataset.json으로 복사
npm run dev                 # 웹 개발 서버 http://localhost:5173
```

| 명령 | 하는 일 |
|---|---|
| `npm run collect-and-export` | 수집 후 내보내기까지 한 번에 |
| `npm run stats` | 저장소 현황 (영상 수, 원천별 마지막 실행, 오류) |
| `npm run build` | 정적 웹 빌드 `apps/web/dist` |
| `npm start` | API + 웹 + 3시간 주기 수집 http://localhost:8787 (웹 화면은 `npm run build` 후) |
| `npm run site` | Pages와 같은 결과물: 웹 빌드 + 정적 API(`dist/api/v1`) + 마무리 |
| `npm run preview` | `apps/web/dist` 미리보기 (http://localhost:4173) |
| `npm run static-api` | 정적 API만 다시 생성 |
| `npm test` · `npm run typecheck` | 테스트 · 타입 검사 |

`dataset.json`이 없으면 웹 앱은 합성 샘플(`sample.json`)을 읽고 "샘플 데이터" 배너를 계속 띄웁니다. 두 데이터를
섞지 않습니다. 키가 필요한 원천을 켜려면 `.env.example`을 `.env`로 복사해 값을 채우세요. 수집기 CLI의 다른 명령
(`add-youtube-channel` 등)은 `npx tsx packages/collector/src/cli.ts --help`로 볼 수 있습니다.

## Docker

API, 웹, 주기 수집을 컨테이너 하나로 실행합니다.

```bash
cp .env.example .env          # 선택: API 키, COLLECT_INTERVAL_MIN 등
docker compose up -d --build
docker compose logs -f vti
```

- 주소: http://localhost:8787 (호스트 포트는 `VTI_PORT`로 변경)
- `./data`가 `/app/data`에 연결되어 저장소, 내보내기, 로그가 호스트에 남습니다.
- 서버는 `COLLECT_INTERVAL_MIN`(기본 180분)마다 수집하고, 새 `dataset.json`을 재시작 없이 반영합니다.
- API 키는 실행할 때만 주입되고 이미지에 들어가지 않습니다.

## API

### 서버 API (`npm start` 또는 Docker)

읽기 전용 REST API입니다. 웹 앱과 같은 데이터셋과 같은 계산(`@vti/core`)을 씁니다. 전체 명세는
`/api/v1/openapi.json`(OpenAPI 3.1)과 사이트의 API 화면(`#/api-docs`)에 있습니다.

| 엔드포인트 | 내용 |
|---|---|
| `GET /api/v1/health` | 서버·데이터셋·스케줄러 상태 |
| `GET /api/v1/meta` | 데이터셋 버전, 개수, 수집 범위 요약 |
| `GET /api/v1/videos` | 영상 검색·정렬 (`mode=upload\|activity\|age`, `range`, `platforms`, `cats`, `langs`, `sort`, `format=csv`) |
| `GET /api/v1/videos/{id}` | 영상 상세, 일별 증가, 원 관측값 |
| `GET /api/v1/trending` | 주제·분야·크리에이터·계정 트렌드 (`kind`) |
| `GET /api/v1/explore` | 주제별 수요와 공급 |
| `GET /api/v1/creators`, `/creators/{key}` | 크리에이터·계정 목록과 상세 |
| `GET /api/v1/taxonomy` | 분류 체계 트리와 영상 수 |
| `GET /api/v1/coverage` | 데이터 범위, 원천, 실행 기록, 정확도 분포 |
| `GET /api/v1/dataset` | 압축 데이터셋 원본 |

```bash
curl "http://localhost:8787/api/v1/videos?mode=activity&range=rolling7d&platforms=youtube&limit=20"
curl "http://localhost:8787/api/v1/videos?mode=age&age=7&sort=views_at_age&limit=50"
curl -o videos.csv "http://localhost:8787/api/v1/videos?mode=activity&range=rolling30d&format=csv&limit=2000"
```

모든 지표는 `value`, `status`, `asOf`를 함께 반환합니다. 알 수 없는 매개변수는 400으로 거부합니다.

### 정적 API (GitHub Pages)

서버 없이도 자주 쓰는 응답을 배포할 때 미리 계산해 둡니다. 데이터셋 기준 시각(`generatedAt`)으로 계산하며,
필터를 바꾸려면 서버 API나 웹 앱을 쓰세요.

| 경로 (`api/v1/` 아래) | 내용 |
|---|---|
| `index.json` | 파일 목록, 설명, 크기, 기준 시각 |
| `meta.json` · `coverage.json` · `taxonomy.json` · `openapi.json` | 서버의 같은 이름 엔드포인트와 같은 내용 |
| `videos/{activity\|upload}/top-{preset}-{platform\|all}.json` | 상위 영상 100개. preset은 `last7d`, `last30d`, `rolling7d`, `rolling30d` |
| `trending/{topic\|category\|creator\|account}-{last7d\|rolling7d}.json` | 트렌드 |
| `creators/top-{last30d\|rolling30d}.json` | 크리에이터·계정 상위 100개 |

```bash
curl https://chldbwnstm.github.io/video-trend-intel/api/v1/index.json
curl https://chldbwnstm.github.io/video-trend-intel/api/v1/videos/activity/top-rolling7d-youtube.json
curl --compressed -o dataset.json https://chldbwnstm.github.io/video-trend-intel/data/dataset.json
```

## 자동 업데이트 (GitHub Actions)

| 워크플로 | 언제 | 하는 일 |
|---|---|---|
| `ci.yml` | 모든 push, pull request | `npm ci` → 타입 검사 → 테스트 → 웹 빌드 (Node 22) |
| `collect-deploy.yml` | 3시간마다 매시 23분(UTC), 수동 실행, `main` push | 저장소 복원 → 수집 → 저장소 업로드 → 내보내기 → 빌드 → 정적 API → Pages 배포 |

- **원 관측 이력 보관.** 수집기 SQLite 저장소는 저장소(repository)의 릴리스 `data-store`에 `store.sqlite.gz`로
  올라가 있고, 직전 실행본은 `store.prev.sqlite.gz`로 남습니다. 공개 저장소라 누구나 받을 수 있으며, 공개 영상·채널
  메타데이터와 수치만 들어 있습니다(인증 정보와 비밀 값은 저장하지 않고 오류 메시지에서도 지웁니다).
- **손상 방지.** 업로드 전에 SQLite 무결성 검사를 하고, 복원본보다 20% 넘게 작아졌거나 영상·관측 행 수가 줄었으면
  업로드하지 않고 실패합니다. 실행 중에 다른 곳에서 자산이 바뀌었어도 덮어쓰지 않습니다. 현재 자산이 없거나
  깨졌으면 직전 실행본으로 복원합니다. 복원할 수 없는데 자산이 있으면 빈 저장소로 시작하지 않고 멈춥니다.
- **업로드 크기.** 업로드하는 것은 `VACUUM INTO`로 만든 압축 사본이라 지운 행이 남긴 빈 페이지는 올라가지 않습니다.
  원천 제공 기간 조회수(Dailymotion 24시간·7일·30일)는 영상·기간별 최신 값 하나만 보관합니다(예전에는 실행마다 3행씩
  쌓여 저장소의 절반을 차지했지만 읽는 곳이 없었음). 원 관측 행은 지우지 않습니다.
- **push 실행.** `main`에 코드가 push되면 저장된 데이터로 사이트만 다시 빌드합니다. 저장소가 아직 없거나 마지막 수집이
  150분(`STALE_COLLECT_MIN`) 넘게 지났을 때는 수집도 합니다. 실행은 한 번에 하나만 대기할 수 있어서, push 실행이
  대기 중이던 예약 수집을 밀어낸 경우에도 3시간 주기 수집이 빠지지 않게 하기 위해서입니다.
- **수집 시간 한도.** 원천(어댑터)마다 12분(`COLLECT_ADAPTER_TIMEOUT_MIN` 변수로 변경) 안에 끝나지 않으면 그 원천만
  실패로 기록하고 다음 원천으로 넘어갑니다. 수집 단계 전체 한도는 55분입니다. YouTube RSS는 연속 10회 네트워크
  오류·429·5xx가 나면(요청 제한 추정) 그때까지 받은 결과만 저장하고 멈춥니다.
- **토큰 권한.** 워크플로 기본 권한은 읽기 전용입니다. 빌드 작업만 `contents: write`(릴리스 자산)와
  `actions: write`(예약 유지)를 받고, `GH_TOKEN`은 `gh`를 부르는 세 단계(복원, 업로드, 예약 유지)에만 넘깁니다.
  `npm ci`·수집기·빌드 단계에는 토큰이 없고, checkout은 토큰을 `.git/config`에 남기지 않습니다. Pages 쓰기 권한
  (`pages: write`, `id-token: write`)은 배포 작업에만 있습니다. 러너는 `ubuntu-24.04`로 고정합니다.
- **수집 실패.** 켜진 원천이 모두 실패해도 실패 기록을 저장하고 사이트를 배포한 뒤, 워크플로를 실패로 표시합니다.
  수집 로그는 실행마다 `collector-logs-*` 아티팩트(14일 보관)로 남습니다.
- **수동 실행** (Actions → Collect & deploy → Run workflow):

  | 입력 | 기본 | 뜻 |
  |---|---|---|
  | `collect` | 켬 | 끄면 수집 없이 다시 빌드만 (마지막 수집이 150분 넘게 지났으면 수집함) |
  | `sources` | 비움 | 이번 실행에서 수집할 어댑터 id (쉼표 구분) |
  | `allow_shrink` | 끔 | 축소 가드 해제 (의도한 정리·마이그레이션 때만) |
  | `allow_empty` | 끔 | 저장소 자산이 모두 깨졌을 때 빈 저장소로 다시 시작 |

- 공개 저장소의 GitHub 호스팅 러너는 무료입니다. 한 번 실행에 약 10분, 하루 8번 실행됩니다.
- 저장소를 내려받아 로컬에서 이어 쓰려면:

  ```bash
  gh release download data-store -p store.sqlite.gz -R chldbwnstm/video-trend-intel
  gunzip -c store.sqlite.gz > data/store.sqlite
  ```

## API 키 활성화

키가 필요한 원천은 저장소 **Secrets**가 있을 때만 켜집니다. 없으면 해당 어댑터만 꺼지고 나머지는 그대로 돕니다.

1. GitHub 저장소 → Settings → Secrets and variables → Actions → **New repository secret**
2. 아래 이름으로 값을 넣습니다. 터미널에서는 `gh secret set YOUTUBE_API_KEY -R chldbwnstm/video-trend-intel`
   (값은 프롬프트로 입력), 또는 `.env`에 채운 뒤 `bash deploy/bootstrap.sh --secrets`로 한 번에 복사합니다.
3. 다음 정기 실행부터 반영됩니다. 바로 확인하려면 Collect & deploy를 수동 실행하세요. 켜졌는지는 사이트의
   데이터 범위 화면에서 확인할 수 있습니다.

| Secret | 켜지는 원천 | 참고 |
|---|---|---|
| `YOUTUBE_API_KEY` | YouTube Data API | 하루 10,000 unit. 기본 설정은 실행당 검색 8회(하루 6,400 unit) |
| `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` | TikTok Research API | 연구 목적 승인 계정만 |
| `IG_ACCESS_TOKEN`, `IG_USER_ID` | Instagram Graph API | 대상은 `IG_BUSINESS_USERNAMES`, `IG_HASHTAGS`로 지정 |
| `X_BEARER_TOKEN` | X API v2 | 읽은 게시물 수 기준 과금 가능 |
| `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` | Twitch Helix | `TWITCH_USER_TOKEN`(선택)이 있으면 팔로워 수 수집 |

조정값은 Secrets 대신 **Variables**(같은 화면의 Variables 탭)에 넣습니다: `IG_BUSINESS_USERNAMES`, `IG_HASHTAGS`,
`YOUTUBE_SEARCHES_PER_RUN`, `YOUTUBE_REGION_CODE`, `TIKTOK_REGION_CODES`, `X_QUERIES_PER_RUN`, `TWITCH_LANGUAGE` 등
(전체 목록과 설명은 `.env.example`). 수집 범위 전체를 줄일 때는 `COLLECT_SOURCES`, `COLLECT_MAX_REQUESTS`,
`EXPORT_BUDGET_MB` 변수를 씁니다. 원천별 시간 한도는 `COLLECT_ADAPTER_TIMEOUT_MIN`(기본 12분), Dailymotion의 국가 조건
없는 시드 기준 지역은 `DAILYMOTION_GLOBAL_LOCALIZATION`(기본 `en_US`)입니다.

## 처음 배포하기

프로젝트를 커밋한 뒤 한 번만 실행합니다. 이미 끝난 단계는 건너뛰므로 다시 실행해도 안전합니다.

```bash
gh auth login                      # 'workflow' 권한 포함 (gh auth refresh -h github.com -s workflow)
bash deploy/bootstrap.sh           # Windows PowerShell: deploy\bootstrap.ps1
```

스크립트가 하는 일:

1. 도구 확인 (git, gh 로그인, Node 22.13+, gzip), HEAD에 워크플로가 커밋되어 있는지 확인
2. 공개 저장소 `chldbwnstm/video-trend-intel`이 없으면 생성
3. `origin` 원격이 없으면 추가 (다른 곳을 가리키는 원격은 바꾸지 않음)
4. 로컬 수집본 `data/store.sqlite`를 검사·압축해 `data/store.sqlite.gz`를 만들고 릴리스 `data-store`에 업로드
   (원격에 이미 저장소가 있으면 유지, `--force-store`로만 교체)
5. `--secrets`를 주면 `.env`의 인증 정보를 저장소 Secrets·Variables로 복사 (값은 출력하지 않음)
6. GitHub Pages를 `build_type=workflow`로 켬 (이미 켜져 있으면 PUT으로 맞춤)
7. HEAD를 `main`으로 push (fast-forward만, 강제 push 없음), `main`을 기본 브랜치로 설정
8. `collect-deploy.yml` 실행을 시작하고 사이트 주소 출력

옵션: `--repo owner/name`, `--remote name`, `--no-store`, `--force-store`, `--secrets`, `--no-push`, `--no-run`.
첫 배포는 워크플로가 끝나면(보통 10분 안) 나타납니다.

## 로컬 PC에서 주기 수집 (Windows)

GitHub Actions 대신 내 PC에서 수집하고 싶을 때 쓰는 대안입니다. 로그인한 동안에만 실행되며 관리자 권한이 필요 없습니다.

```powershell
# 3시간마다 수집 + 내보내기 (매시 23분 시작). 로그: data\logs\task-YYYY-MM-DD.log
powershell -ExecutionPolicy Bypass -File deploy\windows\register-task.ps1

# API + 웹 서버도 로그온 때 자동 실행 (서버 자체 수집은 끄고 예약 작업만 수집), 지금 한 번 실행
powershell -ExecutionPolicy Bypass -File deploy\windows\register-task.ps1 -WithServer -RunNow

# 제거 (데이터는 남음)
powershell -ExecutionPolicy Bypass -File deploy\windows\unregister-task.ps1
```

`npm run task:register`, `npm run task:unregister`도 같습니다. 서버는 새 내보내기를 자동으로 반영하므로 재시작이
필요 없지만, `-RestartServer`를 주면 수집할 때마다 서버를 다시 띄웁니다. 같은 저장소에 두 곳이 동시에 쓰지 않도록,
예약 작업을 쓸 때는 서버의 `COLLECT_INTERVAL_MIN`을 0으로 둡니다(`-WithServer`는 자동으로 0).

## 한계

- **표본 범위.** 시드 채널과 검색 질의로 모은 영상입니다. 플랫폼 전체 순위가 아닙니다. YouTube는 키 없이 채널당
  최신 15개 업로드만 봅니다.
- **이력의 시작점.** 조회 이력은 첫 수집부터 쌓입니다. 그 전의 증가량과 초기 며칠의 게시 후 N일 값은 하한이거나
  계산할 수 없습니다. 화면은 이를 상태 표시로 보여 줍니다.
- **수집 시각.** GitHub Actions 예약 실행은 몇 분에서 수십 분 늦게 시작될 수 있습니다. 저장소 활동이 60일 동안
  없으면 GitHub가 예약 실행을 멈춥니다(워크플로가 매번 다시 켜 두지만, 멈추면 Actions 화면에서 Enable을 누르거나
  `deploy/bootstrap.sh`를 다시 실행하세요).
- **push 재빌드.** 코드 push로 다시 빌드할 때는 새로 수집하지 않으므로 기준 시각과 마지막 관측 사이가 벌어질 수
  있습니다. 다음 정기 실행에서 맞춰집니다.
- **정적 사이트의 무게.** 모든 분석을 브라우저에서 계산하므로 첫 로딩에 데이터셋(현재 약 18 MB, 전송 시 압축)을
  받습니다. 정적 API는 미리 계산한 조합만 제공하고, 임의 필터는 서버 API에서만 가능합니다.
- **만들지 않은 기능.** 시청자 인구통계, Audience Ratings, Consumer Insights는 패널·동의 데이터가 없어 제공하지 않습니다.
- **플랫폼 간 비교.** 플랫폼마다 조회 정의가 달라서 섞은 순위는 참고용입니다.
- **저장소 크기.** 원 관측은 지우지 않고 쌓입니다(하루 약 8 MB, 30일 모의 실행 기준 약 280 MB, gzip 약 47 MB). 릴리스 자산
  한도(2 GB)에 한참 못 미치지만 몇 달 뒤에는 오래된 원 관측을 솎아 내는 보존 정책이 필요합니다(SPEC의 "원 관측은
  지우지 않음" 원칙을 바꾸는 결정이라 아직 넣지 않음). 저장소에 "immutable releases"를 켜면 자산을 갱신할 수 없으니
  켜지 마세요.
- **내보내기 크기 예산.** `dataset.json`이 40 MB를 넘으면 영상을 뺍니다. 삭제·비공개 영상과 7일 넘게 관측되지 않은
  영상(마지막 관측이 오래된 순)부터, 다음은 게시 7일이 지난 영상, 마지막으로 최근 7일 영상 순입니다. 뒤의 두 단계는
  플랫폼마다 따로 매긴 일평균 조회수 백분위로 고르므로 조회수 단위가 작은 PeerTube·niconico나 막 올라온 영상이
  먼저 사라지지 않습니다. 뺀 영상 수는 플랫폼별로 데이터 범위 화면의 메모에 남습니다.

## 로드맵

- 시드 확장: 국내 채널·키워드 추가, YouTube Data API 키로 검색 기반 발견
- 수집 원천 확장: TikTok·Instagram·X·Twitch 인증 정보 연결 후 범위와 품질 점검
- 저장소 관측 압축과 보존 정책, 정기 무결성 점검
- 반복 수집 실패 시 이슈 자동 생성 같은 운영 알림
- 스크린샷과 사용 예시 추가
- 분류 규칙 개선과 분류 근거 검토 화면 보강

## 저장소 구조

```
apps/web/            웹 앱 (UI 규칙: apps/web/UI_GUIDE.md)
apps/server/         REST API, 정적 API 생성기(src/static-api.ts), 스케줄러
packages/core/       공용 분석 로직
packages/collector/  수집기, 시드(seeds/), CLI(src/cli.ts)
deploy/              bootstrap.sh·.ps1, ci/store-release.sh, lib/*.mjs, windows/*.ps1
.github/workflows/   ci.yml, collect-deploy.yml
SPEC.md              엔지니어링 명세 (데이터 원칙, 원천, 저장소, 내보내기 규칙)
.env.example         모든 환경 변수와 설명
```

제품 배경과 경쟁 서비스 분석은 저장소 안의 `docs/competitive-analysis/` 폴더(로컬 문서, 사이트에는 게시하지 않음)에
있습니다. 특히 `tubular.md`와 `comparison-and-product-direction.md`의 5~13절이 이 서비스 설계의 근거입니다.
