# Video Trend Intel — engineering spec (contract for all contributors)

A Tubular-like, multi-platform video & creator intelligence service, built from the design in
`docs/competitive-analysis/comparison-and-product-direction.md` (§5–§13) and the Tubular feature map in
`docs/competitive-analysis/tubular.md`. UI language: **Korean**. Code/comments: English.

## Product surface (Tubular equivalents)

| Our page (route) | Tubular equivalent | What it does |
|---|---|---|
| 대시보드 `/` | Viewpoint home | KPIs, top videos in period, rising topics, platform split, data freshness |
| 영상 탐색 `/videos` | Video Intelligence | search/filter videos; 3 date semantics; sort by metrics; CSV export; detail drawer w/ growth chart + raw observations |
| 트렌드 `/trends` | Trending | rising/falling topics, categories, creators, accounts vs previous window |
| 비디오 레이팅 `/ratings` | Video Ratings (V1/V2/V3/V7/V30) | same-age comparison leaderboards + cohort percentiles |
| 기회 탐색 `/explore` | Viewpoint Explore | demand (views/video) vs supply (uploads) per topic |
| 크리에이터 `/creators`, `/creators/:key`, `/compare` | Creator Intelligence / Comparison | portfolios across platforms, growth, top videos, posting heatmap, compare up to 4 |
| 브랜드 협업 `/brands` | DealMaker (lite) | disclosed/likely sponsored videos, brand × creator collaborations |
| 분류 체계 `/taxonomy` | ContentGraph | hierarchical categories + topics, counts, classification evidence |
| 데이터 범위 `/coverage` | (trust layer, our differentiator) | sources, discovery method, coverage, freshness, metric definitions, runs, errors |
| API `/api-docs` | Tubular API | REST endpoints served by `apps/server` |

Not built (needs panel/consent data we don't have): Audience Ratings, Consumer Insights. The UI states this
explicitly on the coverage page instead of faking numbers.

## Architecture

```
packages/core       pure TS (browser + node). Domain types, dataset codec, time zones, series math,
                    metrics, query engine, trending, explore, creators, taxonomy/classifier, sponsorship, CSV.
packages/collector  node only. Source adapters, HTTP client, SQLite store (node:sqlite), pipeline, tiered
                    refresh, dataset export, CLI.
apps/web            Vite + React 19 + Tailwind v4 + react-router (HashRouter) + recharts + lucide-react.
                    Loads `data/dataset.json` (compact, see core/dataset.ts), runs all analytics client-side
                    with @vti/core. Works as a static site (GitHub Pages) and behind apps/server.
apps/server         Hono on node. REST API over the same dataset using @vti/core, serves the web build and
                    `/data/dataset.json`, runs the collector on a schedule.
deploy/             GitHub Pages publish script, GitHub Actions workflow template, Windows scheduled task.
```

Data flow: adapters → `RawVideo` → store (videos, accounts, observations) → classify (core) → export
`Dataset` (compact JSON) → web/server → `@vti/core` analytics.

## Non-negotiable data principles (from the design doc)

1. **Null is not zero.** A counter a source does not provide is `null`. Engagement uses only available
   components and lists them.
2. **Three date semantics, never mixed** (§5): `upload` (published in window, value as of asOf),
   `activity` (increase inside window, any publish date), `age` (value at publish + N days). The UI always
   says which one is active and shows the asOf / window-complete state.
3. **Every number has provenance**: `MetricValue.status` ∈ exact | interpolated | lower_bound |
   source_reported | unavailable | decrease_flagged, plus `asOf`. The UI renders a status marker
   (≈ interpolated, ≥ lower bound, "원천" source-reported, — unavailable, ⚠ decrease).
4. **No silent caps**: anything pruned/limited (export budget, request caps, disabled sources) is recorded in
   `exportNotes` / coverage and shown on the coverage page.
5. **Cross-platform view units differ** (X views ≠ video plays; YouTube Shorts counting changed 2025-03).
   Default ranking within a platform; when several platforms are mixed show a caveat and offer the
   in-platform percentile sort.
6. **Country ≠ language ≠ viewer geography** (§7). Filters are labeled "업로드 국가(원천 제공)" and "영상 언어".
7. **Store UTC, display in an IANA zone** (default `Asia/Seoul`; `Australia/Sydney` selectable). Windows
   are half-open `[start, end)`; UI date ranges are inclusive local dates.
8. Negative increments are flagged, never ranked as negative popularity.
9. Only official/public, keyless endpoints are used without credentials. Credentialed adapters activate only
   when their env vars are present. Never scrape HTML pages for metrics.

## Sources

| Adapter id | Platform | Credentials | Discovery | Metrics |
|---|---|---|---|---|
| youtube-rss | YouTube | none | seed channel list (`seeds/youtube-channels.json`), latest 15 uploads per channel via `https://www.youtube.com/feeds/videos.xml?channel_id=` | views, likes (starRating count) |
| dailymotion | Dailymotion | none | `https://api.dailymotion.com/videos` with channel/country/language/sort/search seeds; refresh by `ids=` | views, likes, + source windows views_last_day/week/month |
| peertube | PeerTube | none | SepiaSearch `https://sepiasearch.org/api/v1/search/videos`; refresh via origin instance `/api/v1/videos/{uuid}` | views, likes, comments? |
| niconico | niconico | none | Snapshot Search API v2 (`snapshot.search.nicovideo.jp`), data is a daily snapshot: observation time = snapshot `last_modified` (`/api/v2/snapshot/version`), NOT fetch time | views, likes, comments |
| youtube-data-api | YouTube | `YOUTUBE_API_KEY` | search.list by keyword seeds (regionCode KR, relevanceLanguage ko, publishedAfter), videos.list stats, channels.list subscribers | views, likes, comments |
| tiktok-research | TikTok | `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` | Research API video query (approval required) | views, likes, comments, shares |
| instagram-graph | Instagram | `IG_ACCESS_TOKEN`, `IG_USER_ID` | business_discovery for seed business accounts, hashtag search | likes, comments (views where provided) |
| x-api | X | `X_BEARER_TOKEN` | v2 recent search `has:videos` | views(impressions), likes, replies, reposts |
| twitch | Twitch | `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` | Helix top clips/videos per game | views |

HTTP etiquette: descriptive User-Agent `VideoTrendIntel/0.1 (+https://github.com/chldbwnstm/video-trend-intel)`,
per-host rate limits (YouTube RSS ≤ 2 req/s, Dailymotion ≤ 4 req/s, SepiaSearch ≤ 1 req/s, niconico ≤ 1 req/s
with `_context=VideoTrendIntel`), retries with backoff on 429/5xx, 20s timeout.

## Store (collector, node:sqlite at `data/store.sqlite`)

Tables (owner: collector-pipeline): `videos`, `accounts`, `observations` (video_id, t, views, likes,
comments, shares, src — raw, append-only; one row per observation), `source_windows`, `follower_obs`,
`video_classification` (current + version), `creators`, `creator_accounts`, `runs`, `run_errors`,
`source_state` (first/last run, status), plus `video_sources` / `account_sources` (per-source coverage counts).
Schema version 2 (`PRAGMA user_version`; v2 keeps only the latest source window per (video, metric, window) and
repairs entity-encoded text once). Migrations are idempotent and run on open; a store newer than the code is refused.
Raw observations are append-only and never thinned in the store (compaction happens only at export).

Tiered refresh (refreshIds per source): age < 3 days → every run; 3–14 days → every ~12h;
14–90 days → daily; older → weekly (and only if in the top slice of views). Deletion/private → status updated,
never deleted from the store. Sources that can look videos up by id (dailymotion, peertube origin instances, niconico)
receive the whole due list; the pipeline records how many due videos were actually re-observed. YouTube RSS cannot
look up by id: channels whose 15-entry feed spans < 7 days are also read through their UULF (long-form) and UUSH
(Shorts) playlist feeds; videos that leave every feed stop being observed (their later windows become lower bounds /
unavailable, never zero).

## Export (`dataset.json`)

`encodeDataset()` in core (format 2: delta-encoded observation columns, category tuples; instants floored to whole
seconds so nothing lands after `generatedAt`). `generatedAt` = min(export clock, newest observation), so rebuilds
without a fresh collection never push windows past the data. Observation compaction for export only (raw stays in
SQLite): all points for the last 72h, ≤ 1 per 6h for 3–14 days, one per local day (Asia/Seoul) for 14–90 days, one per
week older; first and last points always kept; both neighbours of each local midnight kept only for points < 14 days
old (so daily windows stay exact where they matter). Size budget: ≤ 40 MB raw JSON (~8 MB gzip on the wire); when
exceeded, prune stale/deleted videos first, then videos older than 7 days, then the last 7 days, ranking within each
platform by views-per-day percentile (never raw cross-platform views); every step is written to `exportNotes`.

## Web conventions

- Korean UI copy; numbers formatted `ko-KR` with compact units (만/억) and exact value in tooltip.
- Every metric cell uses the shared `MetricCell` component (status marker + tooltip with status explanation,
  asOf, source).
- Global state in the URL (query string) so views are shareable; HashRouter for GitHub Pages.
- Data provider loads `./data/dataset.json`; if missing, loads `./data/sample.json` and shows a persistent
  "샘플 데이터" banner. Never mix sample and real data.
- Light/dark theme via CSS variables; responsive down to 375px.

## Ownership (parallel build)

Each agent edits ONLY its files. Shared contracts (`packages/core/src/types.ts`, `dataset.ts`,
`packages/collector/src/types.ts`, `packages/collector/src/sources/index.ts`) change only by the integrator.
If a contract change is truly needed, note it in your final report instead of editing.
Do not run `npm install` (all deps are pre-installed); if a dependency is missing, report it.

## Commands

- `npm test` — vitest (all workspaces) · `npm run typecheck`
- `npm run collect` — run enabled adapters once, write to `data/store.sqlite`
- `npm run export` — write `data/export/dataset.json` (+ copy to `apps/web/public/data/`)
- `npm run dev` — web dev server · `npm run build` — static build to `apps/web/dist`
- `npm start` — API server + scheduler + web on http://localhost:8787
