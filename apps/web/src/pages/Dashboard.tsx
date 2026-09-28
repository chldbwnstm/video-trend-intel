/**
 * 대시보드 (Tubular Viewpoint home): KPIs, top videos in the period (activity mode), rising topics,
 * platform and category split, per-source data freshness, and deep links into the detailed pages.
 * One filter row (period + platforms) scopes the sections; platform split and freshness are global.
 */
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { computeTrending, resolveAnalysisWindow } from '@vti/core';
import type { Platform, TrendingResult, UtcWindow, VideoQuery, VideoRow } from '@vti/core';
import {
  Activity,
  ArrowRight,
  Braces,
  CalendarPlus,
  Compass,
  Database,
  Eye,
  Flame,
  FolderTree,
  Handshake,
  Layers,
  Search,
  TrendingUp,
  Trophy,
  TriangleAlert,
  Users,
} from 'lucide-react';
import {
  Badge,
  BarList,
  Button,
  Card,
  CardHeader,
  DataTable,
  EmptyState,
  ErrorState,
  FilterBar,
  InfoTip,
  KpiGrid,
  KpiTile,
  LoadingState,
  MetricCell,
  NumberDelta,
  PageHeader,
  PlatformBadge,
  PlatformPicker,
  RangePicker,
  SectionBoundary,
  SectionGrid,
  SegmentedControl,
  SourceNote,
  SparkLine,
  Tooltip,
  VideoCell,
} from '../components/index.ts';
import type { Column, Tone } from '../components/index.ts';
import { useAnalysis, useDataset, useRangeParam, useUrlState } from '../data/hooks.ts';
import {
  categorySplit,
  computeKpis,
  dailyUploads,
  filterVideos,
  platformSplit,
  recentRunProblems,
  sourceFreshness,
  topRankedVideos,
  topVideosEmptyReason,
  UNCATEGORIZED,
  videosUploadedIn,
} from '../lib/dashboard.ts';
import type { FreshnessState, TopRanked } from '../lib/dashboard.ts';
import { collectionStartText, collectionTimeline, sourceShortLabel } from '../lib/collection.ts';
import { catLabel, fmtTime } from '../lib/display.ts';
import { formatAgo, formatCompact, formatCount, formatInteger } from '../lib/format.ts';
import { emptyReason, spanLabel } from '../features/trends/logic.ts';
import { dataReadiness } from '../features/trends/readiness.ts';
import type { DataReadiness } from '../features/trends/readiness.ts';
import { ReadinessCallout } from '../features/trends/ReadinessCallout.tsx';
import { CROSS_PLATFORM_CAVEAT, orderPlatforms, platformColor, platformLabel } from '../lib/platform.ts';
import { formatLocalRange, hrefWith, platformListCodec } from '../lib/urlState.ts';
import { tzShort } from '../lib/timezones.ts';
import { cx } from '../lib/cx.ts';

const DASHBOARD_PRESETS = ['rolling24h', 'rolling7d', 'rolling30d', 'today', 'yesterday', 'last7d', 'last30d', 'thisWeek', 'lastWeek', 'thisMonth', 'lastMonth'] as const;

export default function DashboardPage() {
  const { dataset, now, tz } = useDataset();
  const { spec, range, rollingHours, setSpec } = useRangeParam('range', 'rolling7d');
  const [platforms, setPlatforms] = useUrlState<Platform[]>('platforms', [], { codec: platformListCodec });
  const presentPlatforms = useMemo(() => orderPlatforms(dataset.videos.map((v) => v.platform)), [dataset]);
  const platformCounts = useMemo(() => {
    const c: Partial<Record<Platform, number>> = {};
    for (const v of dataset.videos) c[v.platform] = (c[v.platform] ?? 0) + 1;
    return c;
  }, [dataset]);

  const windowState = useMemo((): { window: UtcWindow | null; error: Error | null } => {
    try {
      return { window: resolveAnalysisWindow(range, tz, now, rollingHours), error: null };
    } catch (e) {
      return { window: null, error: e instanceof Error ? e : new Error(String(e)) };
    }
  }, [range, tz, now, rollingHours]);

  const scope = platforms.length ? platforms : undefined;
  // Always carry the range: other pages may use a different default period.
  const linkParams = { range: spec, platforms: scope };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow="Viewpoint 홈"
        title="대시보드"
        description="선택한 기간의 핵심 지표, 조회가 많이 늘어난 영상, 뜨는 주제. 모든 수치는 이 서비스가 추적하는 영상 범위 기준이며 플랫폼 전체 순위가 아님."
        actions={
          <>
            <Link
              to={hrefWith('/videos', { mode: 'activity', sort: 'views_period', ...linkParams })}
              className="focus-ring inline-flex h-9 items-center gap-1.5 rounded-md border border-line bg-surface px-3 text-sm font-medium text-fg hover:bg-surface-3"
            >
              <Search className="size-4" aria-hidden />
              영상 탐색
            </Link>
            <Link
              to={hrefWith('/trends', { kind: 'topic', ...linkParams })}
              className="focus-ring inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-on-accent hover:bg-accent-hover"
            >
              <TrendingUp className="size-4" aria-hidden />
              트렌드
            </Link>
          </>
        }
      />

      <FilterBar label="대시보드 필터">
        <RangePicker value={spec} onChange={setSpec} presets={[...DASHBOARD_PRESETS]} />
        <PlatformPicker options={presentPlatforms} value={platforms} onChange={setPlatforms} counts={platformCounts} />
        <p className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-3">
          <span>
            {rollingHours
              ? `기간 데이터 기준 시각까지 최근 ${rollingHours}시간 (롤링)`
              : `기간 ${formatLocalRange(range)} (${tzShort(tz)} 날짜 기준, 양 끝 포함)`}
          </span>
          {windowState.window?.incomplete ? <Badge tone="warning">진행 중인 기간</Badge> : null}
          <span aria-hidden>·</span>
          <span>
            데이터 기준 {fmtTime(now, tz)} {tzShort(tz)}
          </span>
        </p>
      </FilterBar>

      {windowState.error || !windowState.window ? (
        <Card>
          <ErrorState title="기간을 계산하지 못함" error={windowState.error} />
        </Card>
      ) : (
        <DashboardBody window={windowState.window} range={range} rollingHours={rollingHours} spec={spec} onSpec={setSpec} platforms={scope} linkParams={linkParams} />
      )}
    </div>
  );
}

interface BodyProps {
  window: UtcWindow;
  range: { start: string; end: string };
  rollingHours: number | null;
  spec: string;
  onSpec: (spec: string) => void;
  platforms: Platform[] | undefined;
  linkParams: { range?: string; platforms?: Platform[] };
}

function DashboardBody({ window, range, rollingHours, spec, onSpec, platforms, linkParams }: BodyProps) {
  const { dataset, now, tz } = useDataset();
  const readiness = useMemo(() => dataReadiness(dataset), [dataset]);

  const topQuery = useMemo(
    (): VideoQuery => ({ dateMode: 'activity', range, rollingHours: rollingHours ?? undefined, tz, sort: 'views_period', sortDir: 'desc', now, platforms }),
    [range, rollingHours, tz, now, platforms],
  );
  const top = useAnalysis('dash.topRankedVideos', topQuery, (index, q) => topRankedVideos(index, q, TOP_LIMIT));

  return (
    <>
      <SectionBoundary title="핵심 지표를 계산하지 못함" resetKey={`${window.startMs}-${platforms?.join()}`}>
        <KpiSection window={window} range={range} platforms={platforms} linkParams={linkParams} collectionStartAt={readiness.collectionStartAt} />
      </SectionBoundary>

      <SectionGrid>
        <Card className="lg:col-span-8" flush>
          <div className="p-4 pb-0 sm:p-5 sm:pb-0">
            <CardHeader
              icon={<Flame className="size-4" />}
              title="기간 상위 영상"
              description="조회 발생 기간 기준: 게시일과 관계없이 이 기간에 조회수가 가장 많이 늘어난 영상."
              actions={
                <Link
                  to={hrefWith('/videos', { mode: 'activity', sort: 'views_period', ...linkParams })}
                  className="focus-ring inline-flex items-center gap-1 rounded-sm text-[13px] font-medium text-accent-text hover:underline"
                >
                  전체 보기 <ArrowRight className="size-3.5" aria-hidden />
                </Link>
              }
            />
          </div>
          <SectionBoundary title="상위 영상을 계산하지 못함" resetKey={spec}>
            <TopVideos state={top} window={window} readiness={readiness} spec={spec} onSpec={onSpec} linkParams={linkParams} />
          </SectionBoundary>
        </Card>

        <Card className="lg:col-span-4">
          <CardHeader
            icon={<TrendingUp className="size-4" />}
            title="뜨는 주제"
            description="이전 같은 길이 기간보다 조회 증가량이 많이 늘어난 주제."
            actions={
              <Link
                to={hrefWith('/trends', { kind: 'topic', ...linkParams })}
                className="focus-ring inline-flex items-center gap-1 rounded-sm text-[13px] font-medium text-accent-text hover:underline"
              >
                트렌드 <ArrowRight className="size-3.5" aria-hidden />
              </Link>
            }
          />
          <SectionBoundary title="뜨는 주제를 계산하지 못함" resetKey={spec} compact>
            <RisingTopics range={range} rollingHours={rollingHours} platforms={platforms} linkParams={linkParams} readiness={readiness} />
          </SectionBoundary>
        </Card>

        <Card className="lg:col-span-4">
          <CardHeader icon={<Layers className="size-4" />} title="플랫폼 분포" description="추적 중인 영상 수 (플랫폼 필터와 무관한 전체 범위)." />
          <SectionBoundary title="플랫폼 분포를 계산하지 못함" compact>
            <PlatformSplit window={window} />
          </SectionBoundary>
        </Card>

        <Card className="lg:col-span-4">
          <SectionBoundary title="분야 분포를 계산하지 못함" compact resetKey={spec}>
            <CategorySplitCard window={window} platforms={platforms} linkParams={linkParams} />
          </SectionBoundary>
        </Card>

        <Card className="lg:col-span-4">
          <CardHeader
            icon={<Database className="size-4" />}
            title="데이터 신선도"
            description="원천별 마지막 성공 수집 (마지막 수집 실행 시각 기준)."
            actions={
              <Link to="/coverage" className="focus-ring inline-flex items-center gap-1 rounded-sm text-[13px] font-medium text-accent-text hover:underline">
                데이터 범위 <ArrowRight className="size-3.5" aria-hidden />
              </Link>
            }
          />
          <SectionBoundary title="신선도를 계산하지 못함" compact>
            <Freshness />
          </SectionBoundary>
        </Card>
      </SectionGrid>

      <Shortcuts linkParams={linkParams} />

      <SourceNote asOf={now} window={top.data?.window ?? window} notes={top.data?.notes} />
    </>
  );
}

/* ------------------------------------------------------------------------------------------ KPIs */

/** Same wording as the Explore supply callout: counts are of our tracked set, and discovery favours recent uploads. */
const UPLOADS_HINT =
  '기간 안에 게시된 추적 영상 수. 우리가 추적하는 영상 집합 안에서만 센 업로드 수이며 플랫폼 전체 업로드 수가 아님. 발견 방식(채널별 최신 업로드 15개, 오늘 많이 본 영상 정렬 등) 때문에 최근 업로드일수록 많이 잡히고 수집 시작 전 기간은 적게 잡힘. 그래서 이전 기간이 수집 시작 전이면 증감을 표시하지 않음. 진행 중인 기간은 이전 기간의 같은 경과 시간과 비교함.';

function KpiSection({
  window,
  range,
  platforms,
  linkParams,
  collectionStartAt,
}: {
  window: UtcWindow;
  range: { start: string; end: string };
  platforms: Platform[] | undefined;
  linkParams: BodyProps['linkParams'];
  collectionStartAt: number | null;
}) {
  const { now, tz } = useDataset();
  const kpis = useAnalysis('dash.kpis', { startMs: window.startMs, endMs: window.endMs, now, platforms, collectionStartAt }, (index, i) =>
    computeKpis(index.dataset, { now: i.now, window: { startMs: i.startMs, endMs: i.endMs }, platforms: i.platforms, collectionStartAt: i.collectionStartAt }),
  );
  const daily = useAnalysis('dash.dailyUploads', { range, tz, now, platforms }, (index, i) =>
    dailyUploads(filterVideos(index.dataset.videos, i.platforms), i.range, i.tz, i.now),
  );
  if (kpis.error) return <ErrorState title="핵심 지표를 계산하지 못함" error={kpis.error} compact />;
  const k = kpis.data;
  if (!k) return <LoadingState rows={1} />;
  const series = daily.data ?? [];
  return (
    <KpiGrid className={cx('transition-opacity', kpis.isStale && 'opacity-60')}>
      <KpiTile
        icon={<Eye className="size-4" />}
        label="추적 영상"
        value={formatInteger(k.trackedVideos)}
        sub={k.goneVideos ? `활성 ${formatInteger(k.activeVideos)} · 삭제·비공개 ${formatInteger(k.goneVideos)}` : '모두 활성 상태'}
        to={hrefWith('/videos', { platforms: linkParams.platforms })}
        hint="수집기가 발견해 관측 중인 영상 수. 플랫폼 전체 영상 수가 아님."
      />
      <KpiTile
        icon={<Users className="size-4" />}
        label="추적 계정"
        value={formatInteger(k.accounts)}
        sub={`여러 플랫폼 크리에이터 ${formatInteger(k.multiPlatformCreators)}명`}
        to="/creators"
      />
      <KpiTile
        icon={<Layers className="size-4" />}
        label="플랫폼"
        value={formatInteger(k.platforms.length)}
        sub={
          <span className="flex flex-wrap gap-1">
            {k.platforms.map((p) => (
              <PlatformBadge key={p} platform={p} size="xs" />
            ))}
          </span>
        }
        to="/coverage"
      />
      <KpiTile
        icon={<Activity className="size-4" />}
        label="최근 24시간 관측"
        value={formatInteger(k.observationsLast24h)}
        sub={`영상 ${formatInteger(k.videosObservedLast24h)}개 갱신 · 데이터 기준 시각까지`}
        hint="데이터 기준 시각 직전 24시간 동안 기록된 조회수 관측 횟수(내보내기 압축 후)."
      />
      <KpiTile
        icon={<CalendarPlus className="size-4" />}
        label="기간 업로드"
        value={formatInteger(k.uploadsInWindow)}
        delta={k.uploadsComparison === 'ok' && k.uploadsGrowth !== null ? <NumberDelta value={k.uploadsGrowth} label="이전 같은 경과 시간 대비" /> : null}
        sub={
          k.uploadsComparison === 'before_collection'
            ? `이전 기간은 수집 시작(${fmtTime(collectionStartAt, tz, 'date')}) 전이라 비교하지 않음`
            : k.uploadsPrevious !== null
              ? `이전 기간 같은 경과 시간 ${formatInteger(k.uploadsPrevious)}개`
              : undefined
        }
        to={hrefWith('/videos', { mode: 'upload', sort: 'views_total', ...linkParams })}
        hint={UPLOADS_HINT}
        chart={
          series.length > 1 ? (
            <SparkLine data={series.map((d) => d.count)} labels={series.map((d) => d.date)} label="일별 업로드 수" height={32} />
          ) : null
        }
      />
    </KpiGrid>
  );
}

/* ------------------------------------------------------------------------------------------ top videos */

const TOP_LIMIT = 10;

interface TopVideosProps {
  state: { data: TopRanked | undefined; error: Error | null; isStale: boolean };
  window: UtcWindow;
  readiness: DataReadiness;
  spec: string;
  onSpec: (spec: string) => void;
  linkParams: BodyProps['linkParams'];
}

function TopVideos({ state, window, readiness, spec, onSpec, linkParams }: TopVideosProps) {
  const { dataset, now, tz } = useDataset();
  if (state.error) return <ErrorState title="상위 영상을 계산하지 못함" error={state.error} compact />;
  const result = state.data;
  if (!result) return <LoadingState rows={5} className="px-4" />;
  // Only videos whose period increase has a value are ranked; the rest would be ordered by id (a "top 10"
  // of the lowest ids with every metric "—").
  const rows = result.rows;
  const mixed = new Set(rows.map((r) => r.video.platform)).size > 1;
  const reason = topVideosEmptyReason(window, readiness.firstObservationAt, now);
  const start = collectionStartText(readiness.timeline, tz, (s) => sourceShortLabel(dataset.coverage, s));
  const emptyDescription =
    result.total === 0
      ? '이 기간·플랫폼에 해당하는 추적 영상이 없음. 기간이나 플랫폼을 바꿔 볼 것.'
      : reason === 'before_collection'
        ? `선택한 기간은 관측이 시작되기 전에 끝나 조회 증가를 계산할 수 없음. ${start}. 게시일 기준으로 보거나 최근 기간을 고를 것.`
        : reason === 'short_history'
          ? `기간 시작 시점의 관측이 아직 없어 조회 증가를 계산할 수 있는 영상이 없음. ${start}. 최근 24시간을 보거나 게시일 기준으로 볼 것.`
          : '이 기간에 조회 증가를 계산할 수 있는 영상이 없음. 기간이나 플랫폼을 바꿔 보거나 수집 범위를 확인해야 함.';

  const columns: Column<VideoRow>[] = [
    {
      id: 'rank',
      header: '#',
      width: '3rem',
      align: 'right',
      cell: (_r, i) => <span className="whitespace-nowrap text-fg-3">{i + 1}</span>,
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
      id: 'period',
      header: '기간 조회 증가',
      align: 'right',
      width: '8rem',
      hint: '이 기간에 늘어난 조회수. ≈ 보간, ≥ 하한, 원천 = 플랫폼 제공 기간값, ⚠ 감소(순위 제외).',
      cell: (r) => <MetricCell metric={r.metrics.viewsPeriod} label="기간 조회 증가" source={lastSrc(r)} />,
    },
    {
      id: 'total',
      header: '누적 조회',
      align: 'right',
      width: '7rem',
      hideBelow: 'sm',
      cell: (r) => <MetricCell metric={r.metrics.viewsTotal} label="누적 조회" source={lastSrc(r)} />,
    },
    {
      id: 'velocity',
      header: '증가 속도',
      align: 'right',
      width: '8rem',
      hideBelow: 'md',
      hint: '최근 약 24시간 동안의 시간당 조회 증가.',
      cell: (r) => <MetricCell metric={r.metrics.velocity} kind="perHour" label="증가 속도" />,
    },
  ];

  return (
    <div>
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.video.id}
        caption={`기간 조회 증가 상위 ${rows.length}개 영상`}
        stale={state.isStale}
        minWidth="320px"
        className="mt-1"
        empty={
          <EmptyState
            compact
            title={result.total === 0 ? '이 기간에 해당하는 영상 없음' : '조회 증가를 계산할 수 있는 영상 없음'}
            description={emptyDescription}
            action={
              result.total > 0 ? (
                <span className="flex flex-wrap items-center justify-center gap-2">
                  {spec !== 'rolling24h' && reason !== 'none' ? (
                    <Button size="sm" onClick={() => onSpec('rolling24h')}>
                      최근 24시간으로 보기
                    </Button>
                  ) : null}
                  <Link
                    to={hrefWith('/videos', { mode: 'upload', sort: 'views_total', ...linkParams })}
                    className="focus-ring inline-flex h-8 items-center rounded-md border border-line bg-surface px-3 text-[13px] font-medium text-fg hover:bg-surface-3"
                  >
                    업로드 기간 기준으로 보기
                  </Link>
                </span>
              ) : null
            }
          />
        }
      />
      <div className="flex flex-col gap-1 px-4 py-3 text-xs text-fg-3 sm:px-5">
        {mixed ? (
          <p className="flex items-start gap-1.5">
            <TriangleAlert className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
            <span>
              여러 플랫폼이 섞인 순위임. {CROSS_PLATFORM_CAVEAT}{' '}
              <Link
                to={hrefWith('/videos', { mode: 'activity', sort: 'percentile', ...linkParams })}
                className="focus-ring rounded-sm text-accent-text hover:underline"
              >
                플랫폼 내 백분위로 보기
              </Link>
            </span>
          </p>
        ) : null}
        {rows.length ? (
          <p>
            기간 조회 증가를 계산할 수 있는 영상 {formatCount(result.rankable, '개')}(대상 영상 {formatCount(result.total, '개')}) 중 상위 {rows.length}개.
            {result.rankable < result.total ? ' 값을 계산할 수 없는 영상(—)은 순위에서 뺌.' : ''}
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

/* ------------------------------------------------------------------------------------------ rising topics */

function RisingTopics({
  range,
  rollingHours,
  platforms,
  linkParams,
  readiness,
}: {
  range: { start: string; end: string };
  rollingHours: number | null;
  platforms: Platform[] | undefined;
  linkParams: BodyProps['linkParams'];
  readiness: DataReadiness;
}) {
  const { now, tz } = useDataset();
  const trending = useAnalysis('computeTrending', { kind: 'topic' as const, range, rollingHours, tz, now, platforms, limit: 8 }, (index, opts) =>
    computeTrending(index, opts),
  );
  if (trending.error) return <ErrorState title="뜨는 주제를 계산하지 못함" error={trending.error} compact />;
  const t: TrendingResult | undefined = trending.data;
  if (!t) return <LoadingState rows={4} />;
  const rising = t.rising.slice(0, 8);
  // Same readiness logic as the trends page: an empty rising list usually means the previous window predates
  // our first observation, not that nothing is rising.
  const reason = emptyReason(t, readiness);
  const fallback = rising.length === 0 && reason !== 'none' ? t.top.slice(0, 8) : [];
  const items = rising.length ? rising : fallback;
  const growthKnown = rising.length > 0;
  if (items.length === 0) {
    if (reason !== 'none') {
      return (
        <ReadinessCallout readiness={readiness} compact title="직전 기간 관측 부족">
          <p>
            {reason === 'window_before_collection'
              ? '선택한 기간이 첫 관측보다 앞서 기간 조회 증가를 계산할 수 없음.'
              : `직전 동일 기간(${spanLabel(t.previousWindow.startMs, t.previousWindow.endMs, tz)})이 첫 관측보다 앞서 증가율을 비교할 수 있는 주제가 없음.`}{' '}
            상승 여부를 판단할 수 없는 것이며, 오르는 주제가 없다는 뜻이 아님.
          </p>
        </ReadinessCallout>
      );
    }
    return <EmptyState compact title="상승한 주제 없음" description="이전 기간보다 조회 증가가 늘어난 주제가 없거나, 주제별 영상이 3개 미만임." />;
  }
  return (
    <div className={cx('flex flex-col gap-2 transition-opacity', trending.isStale && 'opacity-60')}>
      {!growthKnown ? (
        <ReadinessCallout readiness={readiness} compact title="직전 기간 관측 부족: 증가율 비교 불가">
          <p>
            직전 동일 기간({spanLabel(t.previousWindow.startMs, t.previousWindow.endMs, tz)})이 첫 관측보다 앞서 상승 여부를 판단할 수 없음. 대신 이번 기간 조회
            증가 합계 상위 주제를 보여줌.
          </p>
        </ReadinessCallout>
      ) : null}
      <ol className="flex flex-col divide-y divide-line" aria-label={growthKnown ? '상승 주제' : '이번 기간 조회 증가 상위 주제'}>
        {items.map((it, i) => (
          <li key={it.key} className="flex items-center gap-3 py-2">
            <span className="w-5 shrink-0 text-right text-xs text-fg-3 tabular">{i + 1}</span>
            <div className="min-w-0 flex-1">
              <Link
                to={hrefWith('/videos', { mode: 'activity', sort: 'views_period', topics: [it.key], ...linkParams })}
                className="focus-ring block truncate rounded-sm text-sm font-medium text-fg hover:text-accent-text hover:underline"
              >
                #{it.label}
              </Link>
              <p className="text-xs text-fg-3">
                영상 {formatInteger(it.videoCount)}개
                {growthKnown ? (
                  <Tooltip
                    content={
                      <span>
                        이전 같은 길이 기간의 조회 증가 합계. 기준값이 작으면 증가율이 크게 과장될 수 있음.
                      </span>
                    }
                    className="ml-1"
                  >
                    · 이전 {formatCompact(it.previous)}
                  </Tooltip>
                ) : null}
                {it.incompleteCount ? (
                  <Tooltip content="경계 관측이 부족해 합계에서 빠진(하한·계산 불가) 영상 수. 실제 증가량은 더 클 수 있음." className="ml-1">
                    · 불완전 {formatInteger(it.incompleteCount)}
                  </Tooltip>
                ) : null}
              </p>
            </div>
            <div className="flex shrink-0 flex-col items-end">
              <MetricCell
                metric={{
                  value: it.current,
                  // A sum of exact/interpolated increments; videos with incomplete boundaries are left out,
                  // so the true total is at least this value.
                  status: it.incompleteCount > 0 ? 'lower_bound' : 'interpolated',
                  asOf: Math.min(t.window.endMs, now),
                  note: null,
                }}
                label="기간 조회 증가 합계"
                extra={`정확·보간 관측값만 합산${it.incompleteCount ? `, 경계 관측이 부족한 영상 ${it.incompleteCount}개 제외` : ''}.`}
              />
              {growthKnown ? <NumberDelta value={it.growth} /> : null}
            </div>
          </li>
        ))}
      </ol>
      {t.notes.length ? (
        <p className="mt-2 flex items-start gap-1 text-xs text-fg-3">
          <InfoTip label="트렌드 계산 메모">
            <ul className="list-disc pl-4">
              {t.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </InfoTip>
          <span>계산 메모 {t.notes.length}건</span>
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ splits */

function PlatformSplit({ window }: { window: UtcWindow }) {
  const { now } = useDataset();
  const split = useAnalysis('dash.platformSplit', { startMs: window.startMs, endMs: window.endMs, now }, (index, i) =>
    platformSplit(index.dataset, { startMs: i.startMs, endMs: i.endMs }, i.now),
  );
  if (split.error) return <ErrorState error={split.error} compact />;
  const rows = split.data ?? [];
  if (!rows.length) return <EmptyState compact title="추적 중인 영상 없음" />;
  const total = rows.reduce((a, r) => a + r.tracked, 0);
  return (
    <BarList
      label="플랫폼별 추적 영상 수"
      showShare
      total={total}
      items={rows.map((r) => ({
        key: r.platform,
        label: platformLabel(r.platform),
        value: r.tracked,
        display: formatInteger(r.tracked),
        sub: `기간 업로드 ${formatInteger(r.uploadsInWindow)} · 계정 ${formatInteger(r.accounts)}`,
        color: platformColor(r.platform),
        to: hrefWith('/videos', { platforms: [r.platform] }),
      }))}
    />
  );
}

function CategorySplitCard({ window, platforms, linkParams }: { window: UtcWindow; platforms: Platform[] | undefined; linkParams: BodyProps['linkParams'] }) {
  const { now } = useDataset();
  const [basis, setBasis] = useState<'uploads' | 'tracked'>('uploads');
  const split = useAnalysis('dash.categorySplit', { startMs: window.startMs, endMs: window.endMs, now, platforms, basis }, (index, i) => {
    const vids = filterVideos(index.dataset.videos, i.platforms);
    return categorySplit(i.basis === 'uploads' ? videosUploadedIn(vids, { startMs: i.startMs, endMs: i.endMs }, i.now) : vids);
  });
  const data = split.data;
  const top = data ? data.rows.slice(0, 8) : [];
  const rest = data ? data.rows.slice(8).reduce((a, r) => a + r.count, 0) : 0;
  return (
    <>
      <CardHeader
        icon={<FolderTree className="size-4" />}
        title="분야 분포"
        description={basis === 'uploads' ? '기간에 게시된 영상의 상위 분야.' : '추적 중인 전체 영상의 상위 분야.'}
        actions={
          <SegmentedControl<'uploads' | 'tracked'>
            size="sm"
            label="분야 분포 기준"
            value={basis}
            onChange={setBasis}
            options={[
              { value: 'uploads', label: '기간 업로드' },
              { value: 'tracked', label: '전체' },
            ]}
          />
        }
      />
      {split.error ? (
        <ErrorState error={split.error} compact />
      ) : !data ? (
        <LoadingState rows={4} />
      ) : data.videos === 0 ? (
        <EmptyState compact title="해당 영상 없음" description="이 기간에 게시된 추적 영상이 없음. '전체' 기준으로 볼 수 있음." />
      ) : (
        <div className={cx('transition-opacity', split.isStale && 'opacity-60')}>
          <BarList
            label="분야별 영상 수"
            items={[
              ...top.map((r) => ({
                key: r.id,
                label: r.id === UNCATEGORIZED ? '미분류' : catLabel(r.id),
                value: r.count,
                display: formatInteger(r.count),
                to:
                  r.id === UNCATEGORIZED
                    ? undefined
                    : hrefWith('/videos', {
                        cats: [r.id],
                        mode: basis === 'uploads' ? 'upload' : 'activity',
                        sort: basis === 'uploads' ? 'views_total' : 'views_period',
                        ...linkParams,
                      }),
              })),
              ...(rest > 0 ? [{ key: '__rest__', label: '그 밖의 분야', value: rest, display: formatInteger(rest) }] : []),
            ]}
          />
          <p className="mt-3 text-xs text-fg-3">
            영상 {formatInteger(data.videos)}개 기준.
            {data.multiLabel ? ` 여러 분야에 속한 영상 ${formatInteger(data.multiLabel)}개는 각 분야에 모두 셈.` : ''}
          </p>
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------------------------------------ freshness */

const FRESHNESS_BADGE: Record<FreshnessState, { label: string; tone: Tone }> = {
  ok: { label: '정상', tone: 'positive' },
  partial: { label: '일부 실패', tone: 'warning' },
  late: { label: '지연', tone: 'warning' },
  stale: { label: '오래됨', tone: 'negative' },
  error: { label: '오류', tone: 'negative' },
  disabled: { label: '비활성', tone: 'neutral' },
  never: { label: '미실행', tone: 'neutral' },
};

function Freshness() {
  const { dataset, tz } = useDataset();
  // Measured against the last collector activity, not the newest observation: a round that added no new
  // points (e.g. niconico's daily snapshot) finishes after generatedAt and must not read "1분 후".
  const ref = useMemo(() => collectionTimeline(dataset).collectedUntil, [dataset]);
  const rows = useMemo(() => sourceFreshness(dataset.coverage, ref), [dataset, ref]);
  const runs = useMemo(() => recentRunProblems(dataset.runs, ref), [dataset, ref]);
  if (!rows.length) {
    return <EmptyState compact title="원천 정보 없음" description="데이터셋에 수집 범위(coverage) 기록이 없음." />;
  }
  return (
    <div>
      <ul className="flex flex-col divide-y divide-line">
        {rows.map((r) => {
          const b = FRESHNESS_BADGE[r.state];
          return (
            <li key={r.source} className={cx('flex items-center gap-2 py-2', r.state === 'disabled' && 'opacity-70')}>
              <div className="min-w-0 flex-1">
                <p className="flex min-w-0 items-center gap-1.5">
                  <PlatformBadge platform={r.platform} size="xs" iconOnly />
                  <span className="truncate text-[13px] font-medium text-fg">{r.label}</span>
                </p>
                <p className="truncate text-xs text-fg-3">
                  {r.state === 'disabled'
                    ? r.requiresCredentials
                      ? '인증 정보가 없어 꺼져 있음'
                      : '꺼져 있음'
                    : r.lastSuccessAt !== null
                      ? `마지막 성공 ${formatAgo(r.lastSuccessAt, ref)} · 영상 ${formatInteger(r.videoCount)}개`
                      : '성공한 수집 없음'}
                </p>
              </div>
              <Tooltip
                content={
                  <div className="flex flex-col gap-0.5">
                    <span>원천: {r.source}</span>
                    <span>마지막 실행: {fmtTime(r.lastRunAt, tz)} {tzShort(tz)}</span>
                    <span>마지막 성공: {fmtTime(r.lastSuccessAt, tz)} {tzShort(tz)}</span>
                    {r.lastError ? <span className="text-negative">오류: {r.lastError}</span> : null}
                  </div>
                }
              >
                <Badge tone={b.tone}>{b.label}</Badge>
              </Tooltip>
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-xs text-fg-3">
        마지막 수집 실행 {fmtTime(ref, tz)} {tzShort(tz)} · 그 전 24시간 수집 실행 {formatInteger(runs.total)}회
        {runs.problems ? <span className="text-warning"> · 오류·일부 실패 {formatInteger(runs.problems)}회</span> : ' · 모두 정상'}
        {dataset.exportNotes.length ? (
          <>
            {' · '}
            <Link to="/coverage" className="focus-ring rounded-sm text-accent-text hover:underline">
              내보내기 메모 {dataset.exportNotes.length}건
            </Link>
          </>
        ) : null}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ shortcuts */

function Shortcuts({ linkParams }: { linkParams: BodyProps['linkParams'] }) {
  const links: { to: string; icon: ReactNode; title: string; body: string }[] = [
    {
      to: hrefWith('/videos', { mode: 'upload', sort: 'views_total', ...linkParams }),
      icon: <Search className="size-4" />,
      title: '이 기간 신작 순위',
      body: '업로드 기간 기준: 기간에 게시된 영상만 누적 조회로 비교',
    },
    {
      to: hrefWith('/ratings', { age: 7, platforms: linkParams.platforms }),
      icon: <Trophy className="size-4" />,
      title: '게시 후 7일 성과 (V7)',
      body: '같은 나이로 맞춰 초반 반응이 강한 영상 비교',
    },
    {
      to: hrefWith('/explore', { range: linkParams.range }),
      icon: <Compass className="size-4" />,
      title: '기회 탐색',
      body: '영상당 조회는 높고 업로드는 적은 주제',
    },
    {
      to: hrefWith('/creators', { range: linkParams.range, platforms: linkParams.platforms }),
      icon: <Users className="size-4" />,
      title: '크리에이터 성과',
      body: '여러 플랫폼 계정을 묶은 포트폴리오 비교',
    },
    {
      to: hrefWith('/brands', { range: linkParams.range }),
      icon: <Handshake className="size-4" />,
      title: '브랜드 협업',
      body: '광고 표기·협찬 추정 영상과 브랜드별 협업',
    },
    {
      to: '/api-docs',
      icon: <Braces className="size-4" />,
      title: 'API',
      body: '같은 데이터와 계산을 REST로 사용',
    },
  ];
  return (
    <nav aria-label="자세히 보기">
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {links.map((l) => (
          <li key={l.title}>
            <Link
              to={l.to}
              className="focus-ring group flex h-full items-start gap-3 rounded-xl border border-line bg-surface p-4 shadow-card transition-colors hover:border-line-strong hover:bg-surface-2"
            >
              <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-text" aria-hidden>
                {l.icon}
              </span>
              <span className="min-w-0">
                <span className="flex items-center gap-1 text-sm font-semibold text-fg">
                  {l.title}
                  <ArrowRight className="size-3.5 text-fg-3 transition-transform group-hover:translate-x-0.5" aria-hidden />
                </span>
                <span className="mt-0.5 block text-xs text-fg-3">{l.body}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
