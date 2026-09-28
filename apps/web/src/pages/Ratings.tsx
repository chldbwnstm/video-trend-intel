/**
 * 비디오 레이팅 (Tubular Video Ratings V1/V2/V3/V7/V30): same-age comparison. Every video is compared by its
 * views at publish + N days, inside one platform by default (the platform with the most values). Shows the
 * cohort (reached / not reached / value status), a log-scale distribution with the selected video's
 * position, the leaderboard (queryVideos age mode, views_at_age, in-platform percentile) and why same-age
 * comparison removes the old-video advantage.
 */
import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ageValues, DAY, queryVideos, rankValue } from '@vti/core';
import type { AgeDays, MetricStatus, MetricValue, Platform, Video, VideoQuery, VideoRow } from '@vti/core';
import { ArrowRight, ChartColumn, CircleQuestionMark, Crosshair, ListOrdered, TriangleAlert } from 'lucide-react';
import {
  AgePicker,
  Button,
  Card,
  CardHeader,
  CategoryPicker,
  Checkbox,
  DataTable,
  EmptyState,
  ErrorState,
  FilterBar,
  KpiGrid,
  KpiTile,
  LoadingState,
  MetricCell,
  PageHeader,
  Pager,
  RangePicker,
  SectionBoundary,
  SectionGrid,
  SegmentedControl,
  Select,
  SourceNote,
  VideoCell,
  clampPage,
} from '../components/index.ts';
import type { Column } from '../components/index.ts';
import { useAnalysis, useDataset, useUrlState } from '../data/hooks.ts';
import { fmtTime } from '../lib/display.ts';
import { formatCompact, formatInteger, formatPercent } from '../lib/format.ts';
import { CROSS_PLATFORM_CAVEAT, orderPlatforms, platformLabel } from '../lib/platform.ts';
import { ageCodec, enumCodec, hrefWith, intCodec, parseRangeSpec, platformListCodec, resolveRangeSpec } from '../lib/urlState.ts';
import { tzShort } from '../lib/timezones.ts';
import { ageGapHours, defaultRatingsPlatform, ratingsCohort } from '../features/ratings/logic.ts';
import type { CohortEntry, PlatformCohort, RatingsCohort } from '../features/ratings/logic.ts';
import { VHistogram } from '../features/ratings/VHistogram.tsx';
import { dataReadiness } from '../features/trends/readiness.ts';
import { ReadinessCallout } from '../features/trends/ReadinessCallout.tsx';

type RatingSort = 'views_at_age' | 'percentile';
const sortCodec = enumCodec<RatingSort>(['views_at_age', 'percentile']);
const PAGE_SIZE = 50;

export default function RatingsPage() {
  const { dataset, now, tz } = useDataset();
  const [age, setAge] = useUrlState<AgeDays>('age', 7, { codec: ageCodec, resets: ['page'] });
  const [platforms, setPlatforms] = useUrlState<Platform[]>('platforms', [], { codec: platformListCodec, resets: ['page'] });
  const [cats, setCats] = useUrlState<string[]>('cats', [], { resets: ['page'] });
  const [uploaded, setUploaded] = useUrlState<string>('uploaded', '', { resets: ['page'] });
  const [sort, setSort] = useUrlState<RatingSort>('sort', 'views_at_age', { codec: sortCodec, resets: ['page'] });
  const [page, setPage] = useUrlState<number>('page', 1, { codec: intCodec });
  const [selected, setSelected] = useUrlState<string>('v', '');
  const [showUnranked, setShowUnranked] = useUrlState<boolean>('unranked', false, { resets: ['page'] });

  const presentPlatforms = useMemo(() => orderPlatforms(dataset.videos.map((v) => v.platform)), [dataset]);
  const readiness = useMemo(() => dataReadiness(dataset), [dataset]);
  const upload = useMemo(() => (parseRangeSpec(uploaded) ? resolveRangeSpec(uploaded, tz, now) : null), [uploaded, tz, now]);

  const cohortInput = useMemo(
    () => ({
      ageDays: age,
      tz,
      now,
      categories: cats.length ? cats : undefined,
      range: upload?.range,
      rollingHours: upload?.rollingHours ?? null,
    }),
    [age, tz, now, cats, upload],
  );
  const cohort = useAnalysis('ratings.cohort', cohortInput, (index, i) => ratingsCohort(index, i));

  const auto = cohort.data ? defaultRatingsPlatform(cohort.data.platforms) : null;
  const active: Platform[] = platforms.length ? platforms : auto ? [auto] : [];
  const mixed = active.length !== 1;
  const allSelected = platforms.length > 1 && presentPlatforms.every((p) => platforms.includes(p));

  const platformOptions = useMemo(() => {
    const byP = new Map((cohort.data?.platforms ?? []).map((c) => [c.platform, c] as const));
    const opts: { value: string; label: string }[] = presentPlatforms.map((p) => {
      const c = byP.get(p);
      return { value: p, label: `${platformLabel(p)} · 값 ${formatInteger(c?.ranked ?? 0)} / 도달 ${formatInteger(c?.reached ?? 0)}` };
    });
    if (presentPlatforms.length > 1) opts.push({ value: 'all', label: '전체 플랫폼 (조회 단위 혼합)' });
    if (platforms.length > 1 && !allSelected) opts.push({ value: 'custom', label: `선택한 ${platforms.length}개 플랫폼 (혼합)` });
    return opts;
  }, [cohort.data, presentPlatforms, platforms, allSelected]);
  const platformValue = platforms.length > 1 ? (allSelected ? 'all' : 'custom') : (active[0] ?? '');

  const onPlatform = (v: string) => {
    if (v === 'custom') return;
    setPlatforms(v === 'all' ? presentPlatforms : [v as Platform]);
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow="Video Ratings (V1~V30)"
        title="비디오 레이팅"
        description="게시 후 같은 시간(1·2·3·7·30일)이 지난 시점의 조회수(V1~V30)로 영상을 비교함. 오래된 영상이 누적 조회에서 유리한 편향 없이 초반 반응이 강한 영상을 찾음. 추적 중인 영상 범위 기준."
      />

      <FilterBar label="비디오 레이팅 필터">
        <AgePicker value={age} onChange={setAge} />
        <Select label="플랫폼" hideLabel={false} value={platformValue} onChange={onPlatform} options={platformOptions} />
        <CategoryPicker value={cats} onChange={setCats} />
        <SegmentedControl<'all' | 'range'>
          size="sm"
          label="게시일 범위"
          value={upload ? 'range' : 'all'}
          onChange={(v) => setUploaded(v === 'all' ? '' : 'last90d')}
          options={[
            { value: 'all', label: '게시일 전체' },
            { value: 'range', label: '게시일 지정' },
          ]}
        />
        {upload ? <RangePicker label="게시일" value={upload.spec} onChange={setUploaded} /> : null}
        <p className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-3">
          <span>
            <span className="font-medium text-fg-2">게시 후 경과 기준:</span> V{age} = 게시 시각 + {age}일 시점의 누적 조회수. 이 시점이 지난 영상만 비교.
          </span>
          {!platforms.length && auto ? <span>· 플랫폼 자동 선택: V{age} 값이 가장 많은 {platformLabel(auto)}</span> : null}
          <span>
            · 데이터 기준 {fmtTime(now, tz)} {tzShort(tz)}
          </span>
        </p>
      </FilterBar>

      <SectionBoundary title="코호트를 계산하지 못함" resetKey={`${age}|${cats.join()}|${uploaded}`}>
        {cohort.error ? (
          <Card>
            <ErrorState title="코호트를 계산하지 못함" error={cohort.error} />
          </Card>
        ) : !cohort.data ? (
          <Card>
            <LoadingState rows={4} />
          </Card>
        ) : (
          <RatingsBody
            cohort={cohort.data}
            stale={cohort.isStale}
            age={age}
            active={active}
            mixed={mixed}
            sort={sort}
            setSort={setSort}
            page={page}
            setPage={setPage}
            selected={selected}
            setSelected={setSelected}
            showUnranked={showUnranked}
            setShowUnranked={setShowUnranked}
            cats={cats}
            upload={upload}
            readiness={readiness}
          />
        )}
      </SectionBoundary>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ body */

interface BodyProps {
  cohort: RatingsCohort;
  stale: boolean;
  age: AgeDays;
  active: Platform[];
  mixed: boolean;
  sort: RatingSort;
  setSort: (s: RatingSort) => void;
  page: number;
  setPage: (p: number) => void;
  selected: string;
  setSelected: (id: string) => void;
  showUnranked: boolean;
  setShowUnranked: (b: boolean) => void;
  cats: string[];
  upload: ReturnType<typeof resolveRangeSpec> | null;
  readiness: ReturnType<typeof dataReadiness>;
}

function sumCohorts(list: PlatformCohort[]): Omit<PlatformCohort, 'platform' | 'values' | 'median' | 'p25' | 'p75'> {
  const out = { reached: 0, notReached: 0, ranked: 0, unavailable: 0, statusCounts: {} as Partial<Record<MetricStatus, number>> };
  for (const c of list) {
    out.reached += c.reached;
    out.notReached += c.notReached;
    out.ranked += c.ranked;
    out.unavailable += c.unavailable;
    for (const [s, n] of Object.entries(c.statusCounts)) out.statusCounts[s as MetricStatus] = (out.statusCounts[s as MetricStatus] ?? 0) + (n ?? 0);
  }
  return out;
}

/** Status of a value derived from several values (median): the weakest input status. */
function derivedStatus(counts: Partial<Record<MetricStatus, number>>): MetricStatus {
  if (counts.lower_bound) return 'lower_bound';
  if (counts.source_reported) return 'source_reported';
  if (counts.interpolated) return 'interpolated';
  return 'exact';
}

function RatingsBody(props: BodyProps) {
  const { cohort, age, active, mixed, sort, setSort, page, setPage, selected, setSelected, showUnranked, setShowUnranked, cats, upload, readiness, stale } = props;
  const { now, tz, index } = useDataset();
  const activeSet = new Set(active);
  const cohorts = cohort.platforms.filter((c) => activeSet.has(c.platform));
  const totals = sumCohorts(cohorts);
  const entry = selected ? cohort.entries.get(selected) : undefined;
  const selectedVideo = selected ? index.videosById.get(selected) : undefined;

  // Histogram platform: the only active one, or (mixed) the selected video's platform / the one with most values.
  const histCohort =
    (!mixed ? cohorts[0] : entry && activeSet.has(entry.platform) ? cohorts.find((c) => c.platform === entry.platform) : [...cohorts].sort((a, b) => b.ranked - a.ranked)[0]) ?? null;

  const rankedTotal = totals.ranked;
  const lowShare = totals.reached > 0 && totals.ranked / totals.reached < 0.5;

  const boardInput = useMemo((): VideoQuery => {
    const total = showUnranked ? totals.reached : rankedTotal;
    const p = clampPage(page, total, PAGE_SIZE);
    return {
      dateMode: 'age',
      ageDays: age,
      tz,
      now,
      sort,
      sortDir: 'desc',
      platforms: active.length ? active : undefined,
      categories: cats.length ? cats : undefined,
      range: upload?.range,
      rollingHours: upload?.rollingHours ?? undefined,
      limit: PAGE_SIZE,
      offset: (p - 1) * PAGE_SIZE,
    };
  }, [age, tz, now, sort, active, cats, upload, page, showUnranked, totals.reached, rankedTotal]);
  const board = useAnalysis('queryVideos', boardInput, (idx, q) => queryVideos(idx, q));

  return (
    <div className="flex flex-col gap-4">
      {lowShare ? (
        <ReadinessCallout readiness={readiness} title={`V${age} 값을 계산할 수 있는 영상이 아직 적음`}>
          <p>
            V{age}는 게시 후 {age}일 시점 ±2시간 안에 관측이 있거나, 그 시점을 사이에 둔 두 관측의 간격이 {ageGapHours(age)}시간 이내일 때만 계산함(게시 시점은 0회로 봄).
            첫 관측보다 먼저 이 시점을 지난 영상은 값을 알 수 없어 '계산 불가'로 두고 순위에서 뺌(0으로 세지 않음). 수집이 이어지면 새로 올라오는 영상부터 채워짐.
          </p>
        </ReadinessCallout>
      ) : null}

      <KpiGrid className={stale ? 'opacity-60' : undefined}>
        <KpiTile
          label="비교 대상"
          value={formatInteger(totals.reached)}
          sub={`게시 후 ${age}일이 지난 영상${mixed ? ' (여러 플랫폼)' : ''}`}
          hint="선택한 플랫폼·분야·게시일 조건에서 이미 V 시점에 도달한 추적 영상 수."
        />
        <KpiTile
          label={`V${age} 값 있음`}
          value={formatInteger(totals.ranked)}
          sub={statusBreakdown(totals.statusCounts)}
          hint="관측값·보간값·하한값으로 V를 읽을 수 있어 순위에 들어간 영상."
        />
        <KpiTile
          label="계산 불가"
          value={formatInteger(totals.unavailable)}
          sub={totals.reached ? `도달 영상의 ${formatPercent(totals.unavailable / totals.reached)} · 0이 아님` : '0이 아님'}
          hint="V 시점 전후 관측이 없어 값을 알 수 없는 영상. 순위에서 빼고 0으로 세지 않음."
        />
        <KpiTile
          label="아직 도달 안 함"
          value={formatInteger(totals.notReached)}
          sub={`게시 후 ${age}일이 안 지나 제외`}
          hint="데이터 기준 시각에 아직 게시 후 N일이 지나지 않은 영상. 시간이 지나면 코호트에 들어옴."
        />
        <KpiTile
          label={`중앙값 V${age}`}
          value={
            !mixed && histCohort && histCohort.median !== null ? (
              <MetricCell
                metric={{ value: histCohort.median, status: derivedStatus(histCohort.statusCounts), asOf: now, note: 'median_of_videos' }}
                label={`중앙값 V${age}`}
                size="lg"
                align="left"
              />
            ) : (
              '—'
            )
          }
          sub={
            mixed
              ? '여러 플랫폼은 단위가 달라 중앙값을 합치지 않음'
              : histCohort && histCohort.p25 !== null && histCohort.p75 !== null
                ? `하위 25% ${formatCompact(histCohort.p25)} · 상위 25% ${formatCompact(histCohort.p75)}`
                : '값 있는 영상 없음'
          }
        />
      </KpiGrid>

      <SectionGrid>
        <Card className="lg:col-span-8">
          <CardHeader
            icon={<ChartColumn className="size-4" />}
            title={`V${age} 분포`}
            description={
              histCohort
                ? `${platformLabel(histCohort.platform)} 코호트에서 V${age} 값이 있는 영상 ${formatInteger(histCohort.ranked)}개의 분포(로그 구간). 플랫폼 안에서만 비교함.`
                : '값이 있는 코호트 없음'
            }
          />
          {histCohort && histCohort.values.length ? (
            <>
              <VHistogram
                values={histCohort.values}
                selected={entry && entry.platform === histCohort.platform ? entry.value : null}
                ageDays={age}
                platformLabel={platformLabel(histCohort.platform)}
              />
              {histCohort.values.length < 30 ? (
                <p className="mt-2 text-xs text-warning">값이 있는 영상이 {histCohort.values.length}개뿐이라 분포와 백분위가 불안정함.</p>
              ) : null}
            </>
          ) : (
            <EmptyState
              compact
              title={`V${age} 값이 있는 영상 없음`}
              description={
                totals.reached === 0
                  ? `게시 후 ${age}일이 지난 영상이 없음. 경과일을 줄이거나 게시일 범위를 넓혀 볼 것.`
                  : `도달한 영상 ${formatInteger(totals.reached)}개 모두 V${age} 시점 관측이 없어 계산 불가. 경과일을 바꾸거나 수집 기록이 쌓인 뒤 확인.`
              }
            />
          )}
        </Card>

        <Card className="lg:col-span-4">
          <CardHeader icon={<Crosshair className="size-4" />} title="선택 영상" description="순위표에서 영상을 고르면 코호트 안 위치와 V1~V30을 보여줌." />
          <SelectedVideo age={age} selectedId={selected} entry={entry} cohortSize={histCohort?.platform === entry?.platform ? (histCohort?.ranked ?? 0) : (cohorts.find((c) => c.platform === entry?.platform)?.ranked ?? 0)} onClear={() => setSelected('')} video={selectedVideo} />
        </Card>
      </SectionGrid>

      <Card flush>
        <div className="p-4 pb-2 sm:p-5 sm:pb-2">
          <CardHeader
            icon={<ListOrdered className="size-4" />}
            title={`V${age} 순위`}
            description={`게시 후 ${age}일 시점 조회수 순. 백분위는 같은 플랫폼 코호트 안에서 계산함.`}
          />
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
            <SegmentedControl<RatingSort>
              size="sm"
              label="정렬"
              value={sort}
              onChange={setSort}
              options={[
                { value: 'views_at_age', label: `V${age} 조회수` },
                { value: 'percentile', label: '플랫폼 내 백분위' },
              ]}
            />
            <Checkbox checked={showUnranked} onChange={setShowUnranked} label="계산 불가 영상도 보기" />
          </div>
          {mixed ? (
            <p className="mt-2 flex items-start gap-1.5 text-xs text-fg-3">
              <TriangleAlert className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
              <span>
                여러 플랫폼이 섞인 순위임. {CROSS_PLATFORM_CAVEAT}{' '}
                {sort !== 'percentile' ? (
                  <Button size="sm" variant="ghost" onClick={() => setSort('percentile')} className="h-6 px-1.5 text-accent-text">
                    플랫폼 내 백분위로 정렬
                  </Button>
                ) : null}
              </span>
            </p>
          ) : null}
        </div>
        <SectionBoundary title="순위를 계산하지 못함" resetKey={JSON.stringify(boardInput)}>
          <Leaderboard
            state={board}
            age={age}
            selected={selected}
            onSelect={setSelected}
            showUnranked={showUnranked}
            total={showUnranked ? totals.reached : rankedTotal}
            page={page}
            setPage={setPage}
            unavailable={totals.unavailable}
          />
        </SectionBoundary>
      </Card>

      <WhySameAge age={age} />

      <SourceNote asOf={now} window={upload ? (board.data?.window ?? null) : null} notes={board.data?.notes}>
        <p>
          V{age} 값: 관측 시각이 게시 후 {age}일 ±2시간이면 관측값, 앞뒤 관측 사이면 보간값(≈, 간격 {ageGapHours(age)}시간 이내만). 다른 값(누적 조회)은 데이터 기준 시각
          값.
        </p>
      </SourceNote>
    </div>
  );
}

function statusBreakdown(c: Partial<Record<MetricStatus, number>>): string {
  const parts: string[] = [];
  if (c.exact) parts.push(`관측 ${formatInteger(c.exact)}`);
  if (c.interpolated) parts.push(`보간 ${formatInteger(c.interpolated)}`);
  if (c.lower_bound) parts.push(`하한 ${formatInteger(c.lower_bound)}`);
  if (c.source_reported) parts.push(`원천 ${formatInteger(c.source_reported)}`);
  return parts.length ? parts.join(' · ') : '값 있는 영상 없음';
}

/* ------------------------------------------------------------------------------------------ leaderboard */

function Leaderboard({
  state,
  age,
  selected,
  onSelect,
  showUnranked,
  total,
  page,
  setPage,
  unavailable,
}: {
  state: { data: ReturnType<typeof queryVideos> | undefined; error: Error | null; isStale: boolean };
  age: AgeDays;
  selected: string;
  onSelect: (id: string) => void;
  showUnranked: boolean;
  total: number;
  page: number;
  setPage: (p: number) => void;
  unavailable: number;
}) {
  const { now, tz } = useDataset();
  if (state.error) return <ErrorState title="순위를 계산하지 못함" error={state.error} compact />;
  const result = state.data;
  if (!result) return <LoadingState rows={6} className="px-4" />;
  const current = clampPage(page, total, PAGE_SIZE);
  const offset = (current - 1) * PAGE_SIZE;
  const rows = showUnranked ? result.rows : result.rows.filter((r) => rankValue(r.metrics.viewsAtAge) !== null);

  const columns: Column<VideoRow>[] = [
    {
      id: 'rank',
      header: '#',
      width: '3.5rem',
      align: 'right',
      cell: (r, i) => {
        const on = r.video.id === selected;
        return (
          <button
            type="button"
            aria-pressed={on}
            aria-label={`${offset + i + 1}위 영상을 분포에서 보기`}
            onClick={(e) => {
              e.stopPropagation();
              onSelect(on ? '' : r.video.id);
            }}
            className={`focus-ring inline-flex h-7 min-w-7 items-center justify-center rounded-md px-1.5 text-xs tabular ${on ? 'bg-accent text-on-accent' : 'text-fg-3 hover:bg-surface-3'}`}
          >
            {offset + i + 1}
          </button>
        );
      },
    },
    {
      id: 'video',
      header: '영상',
      cell: (r) => (
        <VideoCell
          video={r.video}
          accountName={r.account?.name}
          publishedLabel={fmtTime(r.video.publishedAt, tz, 'date')}
          publishedTitle={`${fmtTime(r.video.publishedAt, tz)} ${tzShort(tz)}`}
        />
      ),
    },
    {
      id: 'vaa',
      header: `V${age}`,
      align: 'right',
      width: '7rem',
      hint: `게시 후 ${age}일 시점 누적 조회수. ≈ 보간, — 계산 불가(0 아님).`,
      cell: (r) => <MetricCell metric={r.metrics.viewsAtAge} label={`V${age} 조회수`} source={lastSrc(r)} />,
    },
    {
      id: 'pct',
      header: '백분위',
      align: 'right',
      width: '6.5rem',
      hideBelow: 'sm',
      hint: '같은 플랫폼 코호트 안에서의 위치(0~100, 높을수록 상위).',
      cell: (r) => <MetricCell metric={r.metrics.percentile} kind="percentile" label="플랫폼 내 백분위" />,
    },
    {
      id: 'total',
      header: '현재 누적',
      align: 'right',
      width: '7rem',
      hideBelow: 'md',
      hint: '데이터 기준 시각의 누적 조회수(오래된 영상일수록 큼 — 순위에는 쓰지 않음).',
      cell: (r) => <MetricCell metric={r.metrics.viewsTotal} label="현재 누적 조회" source={lastSrc(r)} />,
    },
    {
      id: 'age',
      header: '게시 후',
      align: 'right',
      width: '5rem',
      hideBelow: 'lg',
      cell: (r) => <span className="text-xs text-fg-3 tabular">{formatInteger(Math.floor((now - r.video.publishedAt) / DAY))}일</span>,
    },
  ];

  return (
    <div>
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.video.id}
        caption={`V${age} 조회수 순위`}
        stale={state.isStale}
        minWidth="300px"
        selectedKey={selected || null}
        onRowClick={(r) => onSelect(r.video.id === selected ? '' : r.video.id)}
        empty={
          <EmptyState
            compact
            title={`V${age} 값이 있는 영상 없음`}
            description={unavailable > 0 ? `계산 불가 영상 ${formatInteger(unavailable)}개는 '계산 불가 영상도 보기'로 확인할 수 있음.` : '조건을 넓혀 볼 것.'}
          />
        }
      />
      <div className="flex flex-col gap-2 px-4 py-3 sm:px-5">
        <Pager page={current} pageSize={PAGE_SIZE} total={total} onChange={setPage} />
        {!showUnranked && unavailable > 0 ? (
          <p className="text-xs text-fg-3">
            계산 불가 영상 {formatInteger(unavailable)}개는 순위에서 뺐음(0으로 세지 않음). '계산 불가 영상도 보기'를 켜면 목록 끝에 표시됨.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function lastSrc(r: VideoRow): string | null {
  const o = r.video.obs;
  return o.length ? o[o.length - 1].src : null;
}

/* ------------------------------------------------------------------------------------------ selected video */

function SelectedVideo({
  age,
  selectedId,
  entry,
  cohortSize,
  video,
  onClear,
}: {
  age: AgeDays;
  selectedId: string;
  entry: CohortEntry | undefined;
  cohortSize: number;
  video: Video | undefined;
  onClear: () => void;
}) {
  const { now, tz, index } = useDataset();
  const ages = useMemo(() => (video ? ageValues(video, now) : null), [video, now]);
  if (!selectedId) {
    return <EmptyState compact icon={<Crosshair className="size-6" />} title="선택한 영상 없음" description="순위표의 순위 번호(또는 행)를 누르면 이 영상의 위치가 분포에 표시됨." />;
  }
  if (!video) {
    return (
      <EmptyState
        compact
        title="영상을 찾을 수 없음"
        description={`'${selectedId}' 영상이 현재 데이터에 없음.`}
        action={
          <Button size="sm" onClick={onClear}>
            선택 해제
          </Button>
        }
      />
    );
  }
  const account = index.accountsById.get(video.accountId);
  const pctMetric: MetricValue = entry
    ? { value: entry.percentile, status: entry.status === 'lower_bound' ? 'lower_bound' : entry.status, asOf: null, note: cohortSize < 5 ? 'few_platform_peers' : null }
    : { value: null, status: 'unavailable', asOf: null, note: 'sort_metric_unavailable' };
  return (
    <div className="flex flex-col gap-3">
      <VideoCell video={video} accountName={account?.name} publishedLabel={fmtTime(video.publishedAt, tz, 'date')} thumb="xs" />
      <div className="flex flex-wrap items-center gap-2 text-xs text-fg-3">
        {entry ? (
          <span>
            {platformLabel(entry.platform)} 코호트 {formatInteger(cohortSize)}개 중 <span className="font-semibold text-fg tabular">{formatInteger(entry.rank)}위</span>
          </span>
        ) : (
          <span>V{age} 값이 없어 코호트 순위 밖</span>
        )}
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[13px]">
        <dt className="text-fg-3">플랫폼 내 백분위</dt>
        <dd className="text-right">
          <MetricCell metric={pctMetric} kind="percentile" label="플랫폼 내 백분위" />
        </dd>
        {ages
          ? ([1, 2, 3, 7, 30] as AgeDays[]).map((d) => (
              <FragmentRow key={d} label={`V${d}${d === age ? ' (선택)' : ''}`} strong={d === age}>
                <MetricCell metric={ages[d]} label={`V${d} 조회수`} />
              </FragmentRow>
            ))
          : null}
      </dl>
      <Link
        to={hrefWith('/videos', { v: video.id })}
        className="focus-ring inline-flex w-fit items-center gap-1 rounded-sm text-[13px] font-medium text-accent-text hover:underline"
      >
        영상 탐색에서 성장 곡선 보기 <ArrowRight className="size-3.5" aria-hidden />
      </Link>
    </div>
  );
}

function FragmentRow({ label, strong, children }: { label: string; strong?: boolean; children: ReactNode }) {
  return (
    <>
      <dt className={strong ? 'font-medium text-fg' : 'text-fg-3'}>{label}</dt>
      <dd className="text-right">{children}</dd>
    </>
  );
}

/* ------------------------------------------------------------------------------------------ explanation */

function WhySameAge({ age }: { age: AgeDays }) {
  return (
    <Card>
      <CardHeader icon={<CircleQuestionMark className="size-4" />} title="왜 같은 나이로 비교하나" level={2} />
      <div className="flex flex-col gap-2 text-[13px] text-fg-2">
        <p>
          누적 조회수는 오래 공개된 영상일수록 커짐. 1년 된 영상과 어제 올라온 영상을 누적값으로 줄 세우면 오래된 영상이 늘 앞섬. V{age}는 모든 영상을 &lsquo;게시 후{' '}
          {age}일&rsquo;이라는 같은 나이에서 재기 때문에 공개 기간의 차이가 사라지고, 초반 반응의 세기만 비교됨.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full max-w-xl min-w-[20rem] text-xs">
            <caption className="mb-1 text-left text-fg-3">설명용 가상 예시</caption>
            <thead>
              <tr className="text-fg-3">
                <th scope="col" className="py-1 text-left font-medium">영상</th>
                <th scope="col" className="py-1 text-left font-medium">게시</th>
                <th scope="col" className="py-1 text-right font-medium">현재 누적</th>
                <th scope="col" className="py-1 text-right font-medium">V7</th>
              </tr>
            </thead>
            <tbody className="tabular">
              <tr className="border-t border-line">
                <th scope="row" className="py-1 text-left font-normal">A</th>
                <td>1년 전</td>
                <td className="text-right">500만</td>
                <td className="text-right">30만</td>
              </tr>
              <tr className="border-t border-line">
                <th scope="row" className="py-1 text-left font-normal">B</th>
                <td>8일 전</td>
                <td className="text-right">80만</td>
                <td className="text-right">75만</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>누적으로는 A가 1위지만 V7로는 B가 1위: B가 초반 반응이 더 강한 영상임. 플랫폼마다 조회 단위가 달라 기본은 한 플랫폼 안에서 비교하고, 섞을 때는 플랫폼 내 백분위를 씀.</p>
      </div>
    </Card>
  );
}
