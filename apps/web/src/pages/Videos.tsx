/**
 * 영상 탐색 (Tubular Video Intelligence): search / filter every tracked video under one of the three date
 * semantics, sort by any metric, export the whole filtered result as CSV, share the view as a link, and
 * open a detail drawer (?v=<id>) with the growth curve and raw observations.
 *
 * All state lives in the URL (shared keys from lib/urlState.ts + page keys `minViews`, `accounts`, `creators`).
 * The heavy work (queryVideos over ~15k videos) runs through useAnalysis (deferred + cached); paging and
 * CSV reuse one cached full result (features/videos/model.ts).
 */
import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { queryResultToCsv, resolveAnalysisWindow } from '@vti/core';
import type { AgeDays, DateMode, Platform, SortKey, UtcWindow, VideoFormat } from '@vti/core';
import { FilterX, Globe, Languages, Film, Megaphone, Eye, Rows3, Rows4, SearchX, TriangleAlert, UserRound, X } from 'lucide-react';
import {
  AgePicker,
  Badge,
  Button,
  Card,
  CategoryPicker,
  DATE_MODE_LABELS,
  DateModePicker,
  EmptyState,
  ErrorState,
  ExportCsvButton,
  FilterBar,
  LoadingState,
  MultiSelect,
  PageHeader,
  Pager,
  PlatformPicker,
  RangePicker,
  SearchInput,
  SectionBoundary,
  SegmentedControl,
  SourceNote,
  Tooltip,
  rangeSpecLabel,
} from '../components/index.ts';
import { useAnalysis, useDataset, useRangeParam, useUrlParams, useUrlState } from '../data/hooks.ts';
import { formatInteger } from '../lib/format.ts';
import { CROSS_PLATFORM_CAVEAT } from '../lib/platform.ts';
import { readStored, writeStored } from '../lib/storage.ts';
import { tzShort } from '../lib/timezones.ts';
import {
  ageCodec,
  dateModeCodec,
  dirCodec,
  enumListCodec,
  formatLocalRange,
  intCodec,
  platformListCodec,
  sortCodec,
} from '../lib/urlState.ts';
import type { ParamPatch, UrlCodec } from '../lib/urlState.ts';
import { CopyLinkButton, FilterSelect, SortControls } from '../features/videos/controls.tsx';
import {
  activeFilterCount,
  CLEAR_FILTERS_PATCH,
  dataCoverage,
  defaultSortFor,
  effectiveSort,
  FORMAT_VALUES,
  fullVideoQuery,
  isSortApplicable,
  MIN_VIEWS_PRESETS,
  PAGE_SIZE,
  primaryMetricLabel,
  searchVideos,
  SPONSORED_LABELS,
  SPONSORED_VALUES,
  sortLabel,
  toVideoQuery,
  videoFacets,
} from '../features/videos/model.ts';
import type { SponsoredFilter, VideoSearchInput, VideoSearchResult } from '../features/videos/model.ts';
import { CoverageCallout, NotesCallout, StatusBreakdown } from '../features/videos/ResultNotes.tsx';
import { ResultsTable } from '../features/videos/ResultsTable.tsx';
import { TopicPicker } from '../features/videos/TopicPicker.tsx';
import { VideoDetailDrawer } from '../features/videos/VideoDetail.tsx';
import type { DetailContext } from '../features/videos/VideoDetail.tsx';

const sponsoredCodec: UrlCodec<SponsoredFilter> = {
  parse: (raw) => ((SPONSORED_VALUES as readonly string[]).includes(raw) ? (raw as SponsoredFilter) : undefined),
  serialize: (v) => v || null,
};
const formatListCodec = enumListCodec<VideoFormat>(FORMAT_VALUES);
const minViewsCodec: UrlCodec<number> = {
  parse: (raw) => {
    const n = intCodec.parse(raw);
    return n !== undefined && n >= 0 ? n : undefined;
  },
  serialize: (v) => (v > 0 ? String(Math.trunc(v)) : null),
};
const DENSE_KEY = 'videos.dense';
const PAGE_RESET = { resets: ['page'] };

export default function VideosPage() {
  const { dataset, index, now, tz } = useDataset();
  const [, update] = useUrlParams();

  /* ---------------------------------------------------------------- URL state */
  const { spec, range, rollingHours, setSpec } = useRangeParam('range', 'rolling7d', PAGE_RESET);
  const [mode, setMode] = useUrlState<DateMode>('mode', 'activity', { codec: dateModeCodec, ...PAGE_RESET });
  const [age, setAge] = useUrlState<AgeDays>('age', 7, { codec: ageCodec, ...PAGE_RESET });
  const [sortRaw, setSortRaw] = useUrlState<SortKey>('sort', defaultSortFor(mode), { codec: sortCodec, ...PAGE_RESET });
  const [dir, setDir] = useUrlState<'asc' | 'desc'>('dir', 'desc', { codec: dirCodec, ...PAGE_RESET });
  const [page, setPage] = useUrlState<number>('page', 1, { codec: intCodec });
  const [q, setQ] = useUrlState<string>('q', '', PAGE_RESET);
  const [platforms, setPlatforms] = useUrlState<Platform[]>('platforms', [], { codec: platformListCodec, ...PAGE_RESET });
  const [cats, setCats] = useUrlState<string[]>('cats', [], PAGE_RESET);
  const [topics, setTopics] = useUrlState<string[]>('topics', [], PAGE_RESET);
  const [langs, setLangs] = useUrlState<string[]>('langs', [], PAGE_RESET);
  const [countries, setCountries] = useUrlState<string[]>('countries', [], PAGE_RESET);
  const [formats, setFormats] = useUrlState<VideoFormat[]>('formats', [], { codec: formatListCodec, ...PAGE_RESET });
  const [sponsored, setSponsored] = useUrlState<SponsoredFilter>('sponsored', '', { codec: sponsoredCodec, ...PAGE_RESET });
  const [minViews, setMinViews] = useUrlState<number>('minViews', 0, { codec: minViewsCodec, ...PAGE_RESET });
  const [accounts, setAccounts] = useUrlState<string[]>('accounts', [], PAGE_RESET);
  const [creators, setCreators] = useUrlState<string[]>('creators', [], PAGE_RESET);
  const [videoId] = useUrlState<string>('v', '');
  const sort = effectiveSort(sortRaw, mode);

  const [dense, setDenseState] = useState(() => readStored(DENSE_KEY) === '1');
  const setDense = (d: boolean) => {
    setDenseState(d);
    writeStored(DENSE_KEY, d ? '1' : null);
  };

  const facets = useMemo(() => videoFacets(dataset.videos), [dataset]);
  const filters = { q, platforms, cats, topics, langs, countries, formats, sponsored, minViews, accounts, creators };
  const filterCount = activeFilterCount(filters);

  /* ---------------------------------------------------------------- query */
  const input = useMemo(
    (): VideoSearchInput => ({
      mode,
      range,
      rollingHours,
      age,
      tz,
      now,
      sort,
      dir,
      page,
      pageSize: PAGE_SIZE,
      q,
      platforms,
      cats,
      topics,
      langs,
      countries,
      formats,
      sponsored,
      minViews,
      accounts,
      creators,
    }),
    [mode, range, rollingHours, age, tz, now, sort, dir, page, q, platforms, cats, topics, langs, countries, formats, sponsored, minViews, accounts, creators],
  );
  const search = useAnalysis('videos.search', input, (idx, i) => searchVideos(idx, i));

  const periodWindow = useMemo((): UtcWindow | null => {
    if (mode === 'age') return null;
    try {
      return resolveAnalysisWindow(range, tz, now, rollingHours);
    } catch {
      return null;
    }
  }, [mode, range, tz, now, rollingHours]);

  /* ---------------------------------------------------------------- actions */
  const onModeChange = (next: DateMode) => {
    setMode(next);
    // Keep an explicit sort only when it still means something in the new mode.
    if (sortRaw === defaultSortFor(mode) || !isSortApplicable(sortRaw, next)) update({ sort: null, page: null });
  };
  const onSortChange = (key: SortKey, d?: 'asc' | 'desc') => {
    setSortRaw(key);
    if (d) setDir(d);
  };
  const openVideo = useCallback((id: string) => update({ v: id }, { replace: false }), [update]);
  const closeVideo = useCallback(() => update({ v: null }), [update]);
  const filterAccount = (accountId: string) => update({ accounts: [accountId], v: null, page: null });
  const clearFilters = () => update({ ...CLEAR_FILTERS_PATCH });
  const getCsv = () => queryResultToCsv(fullVideoQuery(index, toVideoQuery(input)), tz, { dateMode: mode, ageDays: mode === 'age' ? age : null });

  const periodText =
    mode === 'age'
      ? `게시 후 ${age}일 시점 조회로 비교 · 게시일 제한 없음`
      : rollingHours
        ? `${rangeSpecLabel(spec)}: 데이터 기준 시각까지 최근 ${rollingHours}시간 (롤링)`
        : `${rangeSpecLabel(spec)}: ${formatLocalRange(range)} (${tzShort(tz)} 날짜, 양 끝 포함)`;
  const linkParams: ParamPatch = { mode, range: spec, age: mode === 'age' ? age : undefined };
  const detailContext: DetailContext = {
    mode,
    window: periodWindow,
    ageDays: age,
    label: `${DATE_MODE_LABELS[mode]} · ${mode === 'age' ? `게시 후 ${age}일` : rangeSpecLabel(spec)}`,
    linkParams,
  };
  const accountNames = accounts.map((id) => index.accountsById.get(id)?.name ?? id);
  const creatorNames = creators.map((id) => index.creatorsById.get(id)?.name ?? id);
  const pageActions = (
    <>
      <CopyLinkButton />
      <ExportCsvButton
        result={search.data?.result}
        getCsv={getCsv}
        filename="videos"
        label={search.data ? `CSV 내보내기 (${formatInteger(search.data.result.total)}개)` : 'CSV 내보내기'}
        disabled={!search.data || search.data.result.total === 0}
      />
    </>
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow="Video Intelligence"
        title="영상 탐색"
        description="추적 중인 영상을 검색·필터하고 세 가지 날짜 기준 중 하나로 비교함. 모든 순위는 이 서비스가 수집한 영상 범위 기준이며 플랫폼 전체 순위가 아님."
        // The shared header keeps actions beside the title; below `sm` they move to their own row instead.
        actions={<div className="hidden items-center gap-2 sm:flex">{pageActions}</div>}
      />
      <div className="-mt-2 flex flex-wrap items-center gap-2 sm:hidden">{pageActions}</div>

      <FilterBar label="영상 탐색 필터">
        <div className="flex w-full flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <DateModePicker value={mode} onChange={onModeChange} />
          <div className="flex flex-col gap-1 lg:items-end">
            {mode === 'age' ? <AgePicker value={age} onChange={setAge} /> : <RangePicker value={spec} onChange={setSpec} />}
            <p className="flex flex-wrap items-center gap-1.5 text-xs text-fg-3 lg:justify-end">
              <span>{periodText}</span>
              {periodWindow?.incomplete ? <Badge tone="warning">진행 중인 기간</Badge> : null}
            </p>
          </div>
        </div>
        <div className="h-px w-full bg-line" aria-hidden />
        <SearchInput
          value={q}
          onChange={setQ}
          label="영상 검색"
          placeholder="제목·태그·주제·계정 검색"
          className="w-full sm:w-72"
        />
        <PlatformPicker options={facets.platforms} value={platforms} onChange={setPlatforms} counts={facets.platformCounts} />
        <div className="flex w-full flex-wrap items-center gap-2">
          <CategoryPicker value={cats} onChange={setCats} counts={facets.categoryCounts} />
          <TopicPicker topics={facets.topics} value={topics} onChange={setTopics} />
          <MultiSelect label="영상 언어" icon={<Languages className="size-4" />} options={facets.languages} value={langs} onChange={setLangs} />
          <MultiSelect label="업로드 국가(원천 제공)" icon={<Globe className="size-4" />} options={facets.countries} value={countries} onChange={setCountries} />
          <MultiSelect
            label="형식"
            icon={<Film className="size-4" />}
            options={facets.formats}
            value={formats}
            onChange={(v) => setFormats(v as VideoFormat[])}
            searchable={false}
          />
          <FilterSelect<SponsoredFilter>
            label="광고·협찬"
            icon={<Megaphone className="size-4" />}
            value={sponsored}
            active={sponsored !== ''}
            onChange={setSponsored}
            options={(['', 'disclosed', 'any', 'none'] as SponsoredFilter[]).map((v) => ({ value: v, label: SPONSORED_LABELS[v] }))}
          />
          <FilterSelect<string>
            label="최소 누적 조회"
            icon={<Eye className="size-4" />}
            value={String(minViews)}
            active={minViews > 0}
            onChange={(v) => setMinViews(Number(v) || 0)}
            options={[...new Set([...MIN_VIEWS_PRESETS, minViews])]
              .sort((a, b) => a - b)
              .map((n) => ({ value: String(n), label: n === 0 ? '제한 없음' : `${formatInteger(n)}회 이상` }))}
          />
          {accounts.length ? (
            <span className="inline-flex h-9 max-w-full items-center gap-1.5 rounded-md border border-accent bg-accent-soft pr-1 pl-3 text-sm text-accent-text">
              <UserRound className="size-4 shrink-0" aria-hidden />
              <span className="text-fg-3">계정</span>
              <span className="truncate font-medium">{accountNames.length === 1 ? accountNames[0] : `${accountNames[0]} 외 ${accountNames.length - 1}`}</span>
              <button
                type="button"
                aria-label="계정 필터 해제"
                onClick={() => setAccounts([])}
                className="focus-ring inline-flex size-6 items-center justify-center rounded hover:bg-surface-3"
              >
                <X className="size-3.5" aria-hidden />
              </button>
            </span>
          ) : null}
          {creators.length ? (
            <span className="inline-flex h-9 max-w-full items-center gap-1.5 rounded-md border border-accent bg-accent-soft pr-1 pl-3 text-sm text-accent-text">
              <UserRound className="size-4 shrink-0" aria-hidden />
              <span className="text-fg-3">크리에이터</span>
              <span className="truncate font-medium">{creatorNames.length === 1 ? creatorNames[0] : `${creatorNames[0]} 외 ${creatorNames.length - 1}`}</span>
              <button
                type="button"
                aria-label="크리에이터 필터 해제"
                onClick={() => setCreators([])}
                className="focus-ring inline-flex size-6 items-center justify-center rounded hover:bg-surface-3"
              >
                <X className="size-3.5" aria-hidden />
              </button>
            </span>
          ) : null}
          {filterCount ? (
            <Button variant="ghost" size="sm" icon={<FilterX className="size-3.5" aria-hidden />} onClick={clearFilters}>
              필터 초기화 ({filterCount})
            </Button>
          ) : null}
        </div>
      </FilterBar>

      <Card flush>
        <SectionBoundary title="영상 목록을 계산하지 못함" resetKey={`${mode}-${spec}-${sort}`}>
          {search.error ? (
            <ErrorState title="영상 목록을 계산하지 못함" error={search.error} />
          ) : !search.data ? (
            <LoadingState rows={8} className="p-4" />
          ) : (
            <Results
              data={search.data}
              stale={search.isStale}
              mode={mode}
              age={age}
              sort={sort}
              dir={dir}
              dense={dense}
              onDense={setDense}
              onSort={onSortChange}
              onDir={setDir}
              onPage={setPage}
              onOpen={openVideo}
              selectedId={videoId}
              linkParams={linkParams}
              filterCount={filterCount}
              onClearFilters={clearFilters}
              collectionStart={facets.collectionStart}
              rolling={rollingHours !== null}
              onUseUpload={() => onModeChange('upload')}
              onUseRolling={() => setSpec('rolling7d')}
              datasetEmpty={dataset.videos.length === 0}
            />
          )}
        </SectionBoundary>
      </Card>

      <SourceNote asOf={now} window={search.data?.result.window ?? periodWindow}>
        <p>
          관측이 2회 이상인 영상 {formatInteger(facets.multiObserved)}개 / 전체 {formatInteger(dataset.videos.length)}개. 수집은 약 3시간마다 이뤄지며, 관측 이력이
          쌓일수록 기간 증가·경과일 값이 채워짐.
        </p>
      </SourceNote>

      <VideoDetailDrawer videoId={videoId} onClose={closeVideo} context={detailContext} onFilterAccount={filterAccount} />
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ results */

interface ResultsProps {
  data: VideoSearchResult;
  stale: boolean;
  mode: DateMode;
  age: AgeDays;
  sort: SortKey;
  dir: 'asc' | 'desc';
  dense: boolean;
  onDense: (d: boolean) => void;
  onSort: (key: SortKey, dir?: 'asc' | 'desc') => void;
  onDir: (d: 'asc' | 'desc') => void;
  onPage: (p: number) => void;
  onOpen: (id: string) => void;
  selectedId: string;
  linkParams: ParamPatch;
  filterCount: number;
  onClearFilters: () => void;
  collectionStart: number | null;
  rolling: boolean;
  onUseUpload: () => void;
  onUseRolling: () => void;
  datasetEmpty: boolean;
}

function Results(p: ResultsProps) {
  const { data, mode, age, sort } = p;
  const { result } = data;
  const mixed = data.platforms.length > 1;
  const primaryLabel = primaryMetricLabel(mode, age);
  const coverage = dataCoverage(data.primary);

  const empty = p.datasetEmpty ? (
    <EmptyState
      title="추적 중인 영상이 아직 없음"
      description="수집기가 아직 영상을 내보내지 않았음. 수집 원천과 실행 기록은 데이터 범위에서 확인."
      action={
        <Link to="/coverage" className="focus-ring rounded-sm text-sm text-accent-text hover:underline">
          데이터 범위 확인
        </Link>
      }
    />
  ) : (
    <EmptyState
      icon={<SearchX className="size-8" />}
      title="조건에 맞는 영상 없음"
      description={
        mode === 'upload'
          ? '이 기간에 게시된 추적 영상 중 조건에 맞는 것이 없음. 기간을 넓히거나 필터를 줄이거나, 조회 발생 기간 기준으로 볼 수 있음.'
          : '필터를 줄이거나 검색어를 바꿔 볼 수 있음. 추적 범위 밖의 영상은 나오지 않음.'
      }
      action={
        <span className="flex flex-wrap items-center justify-center gap-3">
          {p.filterCount ? (
            <Button size="sm" icon={<FilterX className="size-3.5" aria-hidden />} onClick={p.onClearFilters}>
              필터 초기화
            </Button>
          ) : null}
          <Link to="/coverage" className="focus-ring rounded-sm text-sm text-accent-text hover:underline">
            수집 범위 확인
          </Link>
        </span>
      }
    />
  );

  return (
    <div className="flex flex-col">
      <div className="flex flex-col gap-3 p-4 pb-3 sm:p-5 sm:pb-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="flex flex-wrap items-center gap-2 text-[15px] font-semibold text-fg">
              검색 결과 <span className="tabular">{formatInteger(result.total)}개</span>
              {result.window?.incomplete ? (
                <Tooltip content="선택한 기간이 아직 끝나지 않아 값이 더 늘어날 수 있음. 완료된 기간과 직접 비교하지 않음.">
                  <Badge tone="warning">진행 중인 기간</Badge>
                </Tooltip>
              ) : null}
              {p.stale ? <span className="text-xs font-normal text-fg-3">계산 중…</span> : null}
            </h2>
            <p className="mt-0.5 text-[13px] text-fg-3">
              {DATE_MODE_LABELS[mode]} 기준 · {sortLabel(sort, mode, age)} {p.dir === 'desc' ? '높은 순' : '낮은 순'}
              {sort === 'percentile' ? ` (${primaryLabel} 기준)` : ''}
            </p>
          </div>
          <div className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto">
            <SortControls className="flex-1 sm:flex-none" mode={mode} age={age} sort={sort} dir={p.dir} onSort={(k) => p.onSort(k)} onDir={p.onDir} />
            <SegmentedControl<'normal' | 'dense'>
              label="표 밀도"
              size="sm"
              value={p.dense ? 'dense' : 'normal'}
              onChange={(v) => p.onDense(v === 'dense')}
              options={[
                {
                  value: 'normal',
                  label: (
                    <>
                      <Rows3 className="size-4" aria-hidden />
                      <span className="sr-only">기본 간격</span>
                    </>
                  ),
                  title: '기본 간격',
                },
                {
                  value: 'dense',
                  label: (
                    <>
                      <Rows4 className="size-4" aria-hidden />
                      <span className="sr-only">조밀하게</span>
                    </>
                  ),
                  title: '조밀하게',
                },
              ]}
            />
          </div>
        </div>

        {result.total > 0 ? <StatusBreakdown label={primaryLabel} summary={data.primary} /> : null}
        <CoverageCallout
          coverage={coverage}
          mode={mode}
          age={age}
          label={primaryLabel}
          summary={data.primary}
          collectionStart={p.collectionStart}
          rolling={p.rolling}
          onUseUpload={p.onUseUpload}
          onUseRolling={p.onUseRolling}
        />
        {result.total > 0 ? (
          <NotesCallout
            notes={result.notes}
            action={
              mixed && sort !== 'percentile' ? (
                <>
                  <span className="flex items-start gap-1 text-xs text-fg-3">
                    <TriangleAlert className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
                    {CROSS_PLATFORM_CAVEAT}
                  </span>
                  <Button size="sm" onClick={() => p.onSort('percentile')}>
                    플랫폼 내 백분위로 정렬
                  </Button>
                </>
              ) : null
            }
          />
        ) : null}
      </div>

      <ResultsTable
        rows={result.rows}
        mode={mode}
        age={age}
        sort={sort}
        dir={p.dir}
        onSortChange={(k, d) => p.onSort(k, d)}
        onOpen={p.onOpen}
        selectedId={p.selectedId}
        offset={data.offset}
        dense={p.dense}
        stale={p.stale}
        empty={empty}
        linkParams={p.linkParams}
        caption={`영상 탐색 결과 ${formatInteger(result.total)}개 중 ${data.page}쪽, ${sortLabel(sort, mode, age)} 순`}
      />

      {result.total > 0 ? (
        <div className="px-4 py-3 sm:px-5">
          <Pager page={data.page} pageSize={data.pageSize} total={result.total} onChange={p.onPage} />
        </div>
      ) : null}
    </div>
  );
}
