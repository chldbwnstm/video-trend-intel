# apps/web UI guide (for page engineers)

This is the contract for building pages in `apps/web`. The shell, design system, data layer and the
Dashboard already exist; you replace one placeholder file in `src/pages/` and build it from these parts.
Read `SPEC.md` (data principles) and `packages/core/src/types.ts` first.

```
src/
  main.tsx, App.tsx          HashRouter + lazy routes (do not edit; your page is lazy-loaded)
  routes.ts                  nav labels/descriptions (NAV_SECTIONS, navItemFor)
  data/
    DatasetProvider.tsx      loads ./data/dataset.json, falls back to ./data/sample.json (banner); RequireDataset gate
    hooks.ts                 useDataset, useAnalysis, useUrlState, useUrlParams, useRangeParam, useGlobalFilters, useTz
    loadDataset.ts           pure loader (tested)
  lib/
    format.ts                ko-KR numbers (만/억), percent, growth, duration, relative time
    metricStatus.ts          status markers/labels/explanations, note-code labels, metricDisplay()
    urlState.ts              codecs, URL_KEYS, hrefWith(), range specs
    display.ts               fmtTime(ms, tz, style), catLabel(id), taxonomyTree()
    platform.ts              platformLabel/Color, orderPlatforms, CROSS_PLATFORM_CAVEAT + CROSS_PLATFORM_ADVICE
    collection.ts            collection start / first observation / last run (collectionTimeline, collectionStartText)
    dashboard.ts             dashboard-only counts (example of pure, tested page logic)
  components/index.ts        design-system barrel (import everything from here)
  pages/*.tsx                one file per route, `export default`
```

## 1. Page contract

- Your file keeps its path and **default export** (`App.tsx` does `lazy(() => import('./pages/Videos.tsx'))`).
- The page renders inside `<AppShell>` (sidebar, top bar, sample banner, route error boundary, Suspense).
  Don't render your own sidebar/top bar or set `document.title` (the shell does both from `routes.ts`).
- Skeleton of a page:

```tsx
export default function VideosPage() {
  const { now, tz } = useDataset();
  const { spec, range, setSpec } = useRangeParam();            // shared `range` key
  const [mode, setMode] = useUrlState('mode', 'activity' as DateMode, { codec: dateModeCodec, resets: ['page'] });
  const query = useMemo((): VideoQuery => ({ dateMode: mode, range, tz, now, sort: 'views_period', limit: 50 }), [mode, range, tz, now]);
  const { data, error, isStale } = useAnalysis('queryVideos', query, (index, q) => queryVideos(index, q));
  return (
    <div className="flex flex-col gap-4">
      <PageHeader eyebrow="Video Intelligence" title="영상 탐색" description="…" actions={<ExportCsvButton result={data} filename="videos" />} />
      <FilterBar>
        <DateModePicker value={mode} onChange={setMode} />
        <RangePicker value={spec} onChange={setSpec} />
      </FilterBar>
      <Card flush>
        <SectionBoundary title="영상 목록을 계산하지 못함" resetKey={spec}>
          {error ? <ErrorState error={error} /> : !data ? <LoadingState rows={8} /> : <DataTable … stale={isStale} />}
        </SectionBoundary>
      </Card>
      <SourceNote asOf={now} window={data?.window} notes={data?.notes} />
    </div>
  );
}
```

- Every data section handles **loading / empty / error**. Wrap independent sections in `<SectionBoundary>`
  so one failing computation never blanks the page.
- One `FilterBar` row above everything it scopes. Don't put filters inside individual cards unless they only
  change that card's presentation (e.g. the dashboard's "기간 업로드 / 전체" toggle).

## 2. Data access

| Hook | Returns / use |
|---|---|
| `useDataset()` | `{ dataset, index, now, isSample, tz, setTz, source, reload }`. `now` = `dataset.generatedAt`: **pass it to every core call** (`now: now`) so results are deterministic and "as of" the data, not the wall clock. |
| `useAnalysis(name, input, compute)` | Runs `compute(index, input)` memoized + cached per dataset (LRU 64) + deferred with `useDeferredValue`. `input` must be JSON-serializable (it is the cache key). `name` must uniquely identify `compute` — use the core function name (`'queryVideos'`, `'computeTrending'`, `'summarizeCreators'`, …) so identical calls share the cache across pages. Returns `{ data, error, isStale }`; errors are captured, not thrown. |
| `useGlobalFilters()` | `{ tz, setTz, tzOptions, now, isSample }`. The time zone is global URL state: `tz` in the query string wins (shared links), the top-bar choice is also stored per viewer in localStorage, and the address bar carries `tz` whenever it differs from the default (or from the stored choice), so links reproduce the same local-date windows. Default `Asia/Seoul`; `Australia/Sydney`, `UTC` selectable. Don't build page links with `tz`: the provider adds it. |
| `useTz()` | Just the tz (works while the dataset loads and outside the provider, defaults to Asia/Seoul). |
| `useOptionalDataset()` | Like `useDataset()` but `null` outside the provider (for reusable components). |

`useDataset()` always has a loaded dataset: data routes sit under `<RequireDataset>` in `App.tsx`, which shows the
loading / error state inside the shell while the dataset downloads (the sidebar, top bar and the 404 page render
at once; `main.tsx` starts the current page's chunk download in parallel with the dataset). Shell components use
`useOptionalDataset()` / `useAppStatus()`.

**Collection start.** Never compute "first observation" / "수집 시작" yourself: use `collectionTimeline(dataset)` (or
`dataReadiness(dataset).timeline`) and word it with `collectionStartText(timeline, tz, label)`. It keeps the collection
start (first run) apart from snapshot-stamped observations (niconico uses the snapshot time) and gives
`collectedUntil` (the last run's finish) for freshness displays, so a round that finished after `now` never reads "N분 후".

## 3. URL state (shareable views)

All view state lives in the HashRouter query string: `#/videos?mode=activity&range=last7d&platforms=youtube,tiktok`.
Values equal to the default are omitted. Invalid values fall back to the default. How a change is recorded in
browser history depends on the key (`URL_HISTORY` / `HistoryMode` in `lib/urlState.ts`):

- `replace` (default): filters, sort, tabs, ranges. They don't flood Back.
- `push`: `page`. Back returns to the previous page of results.
- `selection`: drawers / detail panes (`brand`, `node`, and the video drawer via `{ history: 'selection' }`). Opening
  pushes an entry (Back closes it), switching to another value replaces it, and closing pops the entry again when this
  session opened it (no dead duplicate entry), otherwise replaces.

Pass `{ replace: true | false }` or `{ history }` to override.

| Hook | Use |
|---|---|
| `useUrlState(key, default, { codec?, replace?, history?, resets? })` | One key as state. Codec inferred from the default (string / number / boolean / `string[]`). Use `resets: ['page']` on filters so paging restarts. Several setters called in one event compose correctly. |
| `useUrlParams()` | `[params, update(patch)]` for batch updates: `update({ q: 'x', page: null })` (`null`/`''`/`[]` delete). |
| `useRangeParam(key='range', fallback='last7d')` | `{ spec, preset, range, setSpec }` — resolved to local dates in the current tz relative to data `now`. |
| `hrefWith(path, params)` | Build `<Link to>` targets with pre-filled state: `hrefWith('/videos', { mode: 'activity', topics: ['추석'] })`. |

Shared keys (`URL_KEYS` in `lib/urlState.ts`) — reuse them so links between pages carry filters over:

| key | meaning | codec |
|---|---|---|
| `mode` | `upload` \| `activity` \| `age` | `dateModeCodec` |
| `range` | preset (`today`, `yesterday`, `last7d`, `last30d`, `last90d`, `thisWeek`, `lastWeek`, `thisMonth`, `lastMonth`) or `YYYY-MM-DD..YYYY-MM-DD` (inclusive local dates) | `useRangeParam` |
| `age` | 1 \| 2 \| 3 \| 7 \| 30 | `ageCodec` |
| `platforms` | comma list | `platformListCodec` |
| `cats` | taxonomy ids, comma list | inferred (`string[]`) |
| `topics`, `langs`, `countries`, `formats` | comma lists | inferred / `enumListCodec` |
| `q` | search text | inferred |
| `sort`, `dir` | `SortKey`, `asc`/`desc` | `sortCodec`, `dirCodec` |
| `page` | 1-based page | `intCodec` |
| `v` | selected video id (detail drawer open) | inferred, `history: 'selection'` |
| `tz` | display time zone (global; written by the provider, never by pages) | `normalizeTz` |
| `sponsored` | `disclosed` \| `any` \| `none` | `enumCodec` |
| `kind` | trend entity kind | `enumCodec` |
| `keys` | compare page: creator/account keys (≤ 4) | inferred |

Links the Dashboard already emits (keep these working; `range` is always present, `platforms` when filtered):
`/videos?mode=activity&sort=views_period&range=…[&platforms][&topics][&cats]`, `/videos?mode=upload&sort=views_total&range=…`,
`/videos?mode=activity&sort=percentile&range=…` (cross-platform caveat), `/videos?platforms=youtube` (platform split),
`/trends?kind=topic&range=…`, `/ratings?age=7[&platforms]`, `/explore?range=…`, `/creators?range=…[&platforms]`,
`/brands?range=…`, `/coverage`, `/api-docs`.

## 4. Component catalogue (`import { … } from '../components/index.ts'`)

### Layout
| Component | Props (main) | Notes |
|---|---|---|
| `PageHeader` | `title, description?, eyebrow?, actions?` | `eyebrow` = Tubular equivalent (see `routes.ts`). Below `sm` the actions wrap onto their own row under the description. |
| `FilterBar` | `children, label?` | The one filter row. Wraps on mobile. |
| `Card`, `CardHeader` | `Card: as?, flush?` · `CardHeader: title, description?, icon?, actions?, level?` | `flush` removes padding (edge-to-edge tables). |
| `SectionGrid` | children with `lg:col-span-N` | 12-col grid ≥ 1024px, single column below. |
| `KpiTile`, `KpiGrid` | `label, value, sub?, delta?, icon?, chart?, hint?, to?` | Hero numbers use proportional figures (no tabular). |
| `ScrollX` | `label?` | Horizontal scroll *inside* a card. The page itself must never scroll sideways. |
| `StatRow` | `label, children` | `<dl>` rows in detail panels. |

### Controls
| Component | Props | Notes |
|---|---|---|
| `Button`, `IconButton` | `variant (primary/secondary/ghost/danger), size, icon, loading` · `IconButton: label` (required a11y name) | |
| `SegmentedControl<T>` | `options[{value,label,title?}], value, onChange, label, size?, block?` | radiogroup, arrow keys. |
| `Tabs<T>`, `TabPanel` | `tabs[{id,label,count?}], value, onChange, label, idBase` | Panels use `idBase` too. |
| `Select<T>` | `value, onChange, options, label, hideLabel?` | Native select (best on mobile). |
| `SearchInput` | `value, onChange, placeholder?, debounceMs?` | Debounced (250 ms), Enter commits immediately. |
| `Checkbox` | `checked, onChange, label, indeterminate?` | |
| `Chip`, `Badge` | `Chip: selected?, onClick?, onRemove?` · `Badge: tone` | Tones: neutral/accent/positive/negative/warning/info. |
| `Popover` | `label, buttonContent, children(close), align?, width?, active?` | Anchored filter panel (outside click / Esc closes). |
| `MultiSelect` | `label, options[{value,label,count?,keywords?}], value, onChange, icon?, searchable?` | Filter popover with search + checkboxes: 영상 언어 (`languageLabel`), 업로드 국가(원천 제공) (`countryLabel`), 형식 (`FORMAT_LABELS`), 주제. `[]` = all. |
| `Pager` | `page, pageSize, total, onChange, scrollTarget?` | "N개 중 a–b" + prev/next; use `clampPage` on the URL `page` value. After a page change it scrolls the table in its card (or `[data-pager-scope]`, or `scrollTarget`) back into view and focuses the table caption, so users land on the first row of the new page. |
| `Drawer`, `Modal` | `open, onClose, title, description?, footer?, width?` | Portal, focus trap, Esc, focus restore. Use `Drawer` for the video detail panel (`v` URL key). |
| `Tooltip`, `InfoTip` | `content, children, focusable?` · `InfoTip: children, label?` | Hover **and** keyboard focus; never the only way to get a value. |

### Domain
| Component | Props | Notes |
|---|---|---|
| `MetricCell` | `metric: MetricValue, kind?: 'count'\|'perHour'\|'rate'\|'growth'\|'multiplier'\|'percentile'\|'number', label?, source?, unit?, size?, extra?` | **Every metric number goes through this.** Marker: ≈ 보간, ≥ 하한, `원천` source, — 계산 불가 (value hidden, never 0), ⚠ 감소 (kept, excluded from ranking). Tooltip: status label + explanation, exact value, note (`noteLabel`), asOf in tz, source. `engagementRate.components` are listed automatically. |
| `NumberDelta` | `value?: ratio \| metric?: MetricValue, invert?, label?` | Arrow + sign + color; unavailable/decrease → —. |
| `PlatformBadge` | `platform, size?, iconOnly?` | Color dot + label; color = fixed slot per platform (brand-neutral). |
| `PlatformPicker` | `options, value, onChange, counts?` | `[]` = all platforms. |
| `CategoryChip` | `id, to?, onRemove?, confidence?` | Label from taxonomy, full path in title. |
| `CategoryPicker` | `value: string[], onChange, variant?: 'popover'\|'inline', counts?` | Searchable tree; selecting a node = node + descendants; children of a selected node show "상위 분야에 포함". |
| `DateModePicker` | `value, onChange, showDescription?, showExample?, modes?` | 업로드 기간 / 조회 발생 기간 / 게시 후 경과 + one-line explanation + A/B example. **Show it wherever a date mode applies.** |
| `RangePicker` | `value: RangeSpec, onChange, presets?, allowCustom?` | Presets with resolved dates + custom inclusive dates (tz-labelled). |
| `AgePicker` | `value: AgeDays, onChange` | 1/2/3/7/30일. |
| `VideoThumb` | `video, size: xs\|sm\|md\|lg, overlays?` | Lazy, `referrerPolicy=no-referrer`, platform fallback tile, duration/쇼츠/라이브 overlay. |
| `VideoTitleLink` | `video, lines?` | New tab, `rel="noopener noreferrer"`, only http(s) URLs linked, 삭제됨/비공개 badge. |
| `VideoCell` | `video, accountName?, publishedLabel?, thumb?` | Standard table cell (thumb + title + platform · account · date). |
| `DataTable<R>` | `columns: Column<R>[], rows, rowKey, caption, sort?, onSortChange?, maxHeight?, onRowClick?, selectedKey?, empty?, stale?, minWidth?, dense?` | Sticky header, `aria-sort`, sortable headers, `hideBelow: 'sm'\|'md'\|'lg'` per column, `hint` ⓘ per header, numeric columns `align: 'right'` (tabular figures). `onRowClick` is mouse sugar: keep a focusable control in the row. |
| `SparkLine` | `data: (number\|null)[], labels?, label, kind?, height?` | Tiny trend with tooltip + aria summary. |
| `GrowthChart` | `series: {id,label,color?,points:{x,value,status?}[]}[], variant?: 'line'\|'bar', title, kind?, height?, table?` | Time (`x` = epoch ms) or category (`x` = `YYYY-MM-DD`) axis, legend for ≥ 2 series, status markers in tooltip, "표로 보기" table twin. Use `line` for cumulative counters, `bar` for daily increments. |
| `BarList` | `items: {key,label,value,display?,sub?,color?,to?}[], label, showShare?, total?` | Ranked split with every value visible (its own table twin). |
| `ExportCsvButton` | `result?: QueryResult \| getCsv?: () => string, filename?` | Videos: core `queryResultToCsv` (status + asOf per value). Other tables: `toCsv(rows)` (BOM, RFC 4180, null → empty, formula-injection guard). |
| `SourceNote` | `asOf, window?, notes?, sources?, coverageLink?` | Provenance small print: data time, window (local dates, "진행 중인 기간"), `기준 …` (self-labelled items such as `분류기 rules-…`, `켜진 원천 4개`), core notes, link to 데이터 범위. **Put one under every result.** |
| `EmptyState`, `LoadingState`, `ErrorState`, `SectionBoundary` | see above | `LoadingState rows={n}` = skeleton rows. |
| `PagePlaceholder` | `path, planned` | Delete once your page is real. |

Helpers: `fmtTime(ms, tz, 'date'|'datetime'|'time')`, `catLabel(id)`, `languageLabel(code)`, `countryLabel(code)`,
`FORMAT_LABELS`, `taxonomyTree()`, `windowLabel(window, tz)`, `formatCompact/formatInteger/formatPercent/formatGrowth/formatRelative`,
`formatAgo` (past-only relative time for freshness), `platformLabel/platformColor/orderPlatforms`, `STATUS_META`,
`statusCountLabel(status)` (marker + label for status counts: never `원천 원천 제공값`), `noteLabel`, `metricDisplay`, `textMatchesSafe`.

**Live catalogue:** open `#/ui-kit` (not in the nav) to see every component with the loaded data, in both
themes (toggle in the top bar) and at phone width.

## 5. Showing provenance (non-negotiable)

1. **Null is not zero.** Never coerce `null` to 0 for display, sorting or sums. `MetricCell` shows `—` and
   the reason. In CSV, null is an empty cell.
2. **Date semantics.** Wherever a date filter exists, show `DateModePicker` (or at least the active mode's
   `DATE_MODE_DESCRIPTIONS` text) and a `SourceNote` with the window; badge incomplete windows ("진행 중인 기간").
3. **Every number has provenance**: `MetricCell` for metric values; plain counts of our own records
   (number of videos, accounts) may be plain text.
4. **Cross-platform units differ.** When a ranking mixes platforms, show `CROSS_PLATFORM_CAVEAT` followed by the
   advice the page can act on: `CROSS_PLATFORM_ADVICE.percentile` plus the in-platform percentile sort
   (`sort=percentile`) where it exists, else `CROSS_PLATFORM_ADVICE.filter` / platform chips. Never recommend a sort
   the page doesn't offer. Prefer per-platform views by default.
5. **Tracked-set counts.** Upload counts are of our tracked set, and discovery favours recent uploads (latest 15
   per channel, "visited today" sorts). Don't show growth of such counts against a window before the collection
   start (`computeKpis(..., { collectionStartAt })` returns `uploadsComparison: 'before_collection'`).
6. **Country ≠ language ≠ viewer geography.** Labels: "업로드 국가(원천 제공)", "영상 언어". Never "국가" alone.
7. **Coverage honesty.** Say "추적 중인 영상 범위 기준" rather than implying platform-wide rankings. Show
   `TrendItem.incompleteCount`, `QueryResult.notes`, excluded counts (age mode "not reached").
8. **Sample data.** The shell shows the banner; don't add your own sample-specific logic.
9. Classification: show `CategoryAssignment.evidence` / `version` where categories are explained
   (taxonomy page, video drawer).

## 6. Layout & responsive patterns

- Breakpoints: sidebar fixed ≥ 1024px (`lg`), drawer below. Everything must work at **375px** with no page-level
  horizontal scroll: wrap wide tables in `DataTable` (it scrolls inside its own container), hide secondary
  columns with `hideBelow`, set `minWidth` to what the visible columns need (e.g. `320px`).
- Page body: `flex flex-col gap-4`; sections in `SectionGrid` with `lg:col-span-8 / 4 / 6 / 12`.
- Cards: title (`CardHeader`) + one-line description saying what is measured and in which date mode.
- Charts: one filter row above; legends for ≥ 2 series; single-series bars use one color; platform color only
  for platform identity; no dual axes; always a table twin (`GrowthChart table`, `BarList`).
- Theme: use tokens only (`bg-surface`, `bg-surface-2/3`, `bg-canvas`, `border-line`, `text-fg`, `text-fg-2`,
  `text-fg-3`, `bg-accent`, `text-accent-text`, `bg-accent-soft`, `text-positive/negative/warning`,
  `bg-*-soft`). Chart colors: `var(--series-1..8)`, `var(--chart-grid|axis|text)`, `platformColor(p)`.
  Never hard-code hex colors — dark mode swaps the tokens.
- Focus: interactive elements get `focus-ring` (visible `:focus-visible` outline). Icon-only buttons need a label.

## 7. Copy tone (Korean UI)

- 존댓말 없이 간결한 UI 라벨: 명사형·"~함/~음" 종결. 예: "결과 없음", "다시 시도", "기간을 계산하지 못함",
  "진행 중인 기간: 값이 더 늘어날 수 있음", "원천이 이 지표를 제공하지 않음".
- Terms (use consistently): 업로드 기간 · 조회 발생 기간 · 게시 후 경과 · 기간 조회 증가 · 누적 조회 · 증가 속도(시간당) ·
  이전 기간 대비 · 참여율 · 평소 대비 · 백분위 · 추적 영상 · 계정 · 크리에이터 · 분야 · 주제 · 원천 · 데이터 기준 ·
  업로드 국가(원천 제공) · 영상 언어 · 광고 표기 · 협찬 추정.
- Numbers: `formatCompact` (1.2만, 3.4억) in cells; exact `12,345회` in tooltips; percentages with `%`; dates
  `YYYY-MM-DD`, times `HH:mm` + tz short name (KST / 시드니 / UTC).
- Don't claim what we can't know ("전체 순위", "한국 시청자") — see §5.

## 8. Performance

- All analytics run client-side on the main thread over ~2–10k videos. Always go through `useAnalysis`
  (memo + cache + deferred) and build its `input` with `useMemo` or from primitives.
- Keep `input` minimal and serializable: pass ids / ranges / flags, not objects from the index.
- Render at most ~100 table rows at a time (page with `limit`/`offset`, URL key `page`); `queryVideos` returns
  `total` for the pager.
- Show `isStale` as dimmed content (`DataTable stale`, `opacity-60`), not a skeleton flash.
- Recharts is heavy: it is only loaded in lazy page chunks; don't import it into shared shell code.
- Avoid per-row expensive work in render (e.g. `fmtTime` is fine, recomputing metrics is not).

## 9. Accessibility checklist

Keyboard reachable controls with visible focus; `aria-label` on icon buttons; tables have `caption`; sortable
headers are buttons with `aria-sort`; tooltips open on focus; charts have a table twin; color is never the only
signal (markers, arrows, text); `Drawer`/`Modal` trap focus and restore it; data text is rendered as text
(no `dangerouslySetInnerHTML`); external links `rel="noopener noreferrer"`.

## 10. Tests

`vitest` picks up `apps/web/src/**/*.test.ts` (node environment, no DOM). Put page logic in pure functions
(see `lib/dashboard.ts` + `dashboard.test.ts`) and test components with `renderToStaticMarkup` +
`createElement` (see `components/components.test.ts`). Core fixtures: `packages/core/test/fixtures.ts`.

## 11. Sample data

`npx tsx apps/web/scripts/make-sample-dataset.ts` regenerates `public/data/sample.json` deterministically
(seed 20260928, generatedAt 2026-09-28 12:00 KST, ~2,500 videos, 200 accounts, 5 platforms, 60 days).
It exercises: interpolated values (niconico daily snapshots, Sydney tz), lower bounds (late discovery,
daily-tier refresh 12h before export), gaps (PeerTube outages), source windows (Dailymotion), decreases,
hidden likes, deleted/private videos, re-trending 추석 videos (activity vs upload mode differ), falling
summer topics, niche high-demand topics (기회 탐색), multi-platform creators (one `suggested` link),
disclosed/likely sponsorships with fictional brands, disabled credentialed sources, collection runs with
errors. Real data: `npm run collect` then `npm run export` writes `public/data/dataset.json`, which always
wins over the sample.
