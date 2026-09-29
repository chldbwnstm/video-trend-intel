/**
 * 크리에이터 상세 (/creators/:key; Tubular Creator Intelligence profile). `key` is a creator id (linked
 * accounts across platforms) or a single account id. Sections: accounts across platforms, period KPIs,
 * per-platform breakdown, daily view increase per platform, followers, top videos, posting-time heatmap,
 * category mix, upload cadence and sponsored videos. Every number is "as known at the data now" and describes
 * our tracked videos of the portfolio only.
 */
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { creatorTimeline, postingHeatmap, queryVideos } from '@vti/core';
import type { Account, Platform, Portfolio, QueryResult, Video, VideoQuery, VideoRow } from '@vti/core';
import {
  ArrowLeft,
  ArrowRight,
  BarChart3,
  CalendarClock,
  Clock3,
  ExternalLink,
  Flame,
  FolderTree,
  GitCompareArrows,
  Handshake,
  LineChart,
  TriangleAlert,
  Users,
} from 'lucide-react';
import {
  Badge,
  BarList,
  Card,
  CardHeader,
  CategoryChip,
  DataTable,
  EmptyState,
  ErrorState,
  FilterBar,
  GrowthChart,
  KpiGrid,
  KpiTile,
  LoadingState,
  MetricCell,
  PageHeader,
  PlatformBadge,
  RangePicker,
  SectionBoundary,
  SectionGrid,
  SegmentedControl,
  SourceNote,
  StatRow,
  Tooltip,
  VideoCell,
  VideoTitleLink,
  safeHttpUrl,
} from '../components/index.ts';
import type { Column } from '../components/index.ts';
import { useAnalysis, useDataset, useRangeParam } from '../data/hooks.ts';
import { catLabel, countryLabel, fmtTime } from '../lib/display.ts';
import { formatInteger } from '../lib/format.ts';
import { CROSS_PLATFORM_CAVEAT, platformLabel } from '../lib/platform.ts';
import { tzShort } from '../lib/timezones.ts';
import { formatLocalRange, hrefWith } from '../lib/urlState.ts';
import { cx } from '../lib/cx.ts';
import {
  compareHref,
  computeCreatorDetail,
  findPortfolio,
  formatInterval,
  normalizeTimeline,
  platformTimelineSeries,
  statusCounts,
  timelineStatus,
  followersMetric,
  heatmapSlots,
  portfolioVideosHref,
  slotLabel,
  windowBeforeCollection,
} from '../features/creators/logic.ts';
import type { CreatorDetailData, HeatSlot, PlatformBreakdown } from '../features/creators/logic.ts';
import {
  CreatorAvatar,
  DataStateNote,
  FollowersCell,
  LinkStatusBadge,
  PlatformStrip,
  PostingHeatmap,
  portfolioAvatar,
  PreCollectionCallout,
} from '../features/creators/parts.tsx';
import type { HeatMode } from '../features/creators/parts.tsx';
import { dataReadiness } from '../features/trends/readiness.ts';
import { WatchButton } from '../features/watchlist/WatchButton.tsx';

const DETAIL_PRESETS = ['rolling24h', 'rolling7d', 'rolling30d', 'today', 'yesterday', 'last7d', 'last30d', 'last90d', 'thisWeek', 'lastWeek', 'thisMonth', 'lastMonth'] as const;

export default function CreatorDetailPage() {
  const { key: rawKey } = useParams();
  const key = rawKey ?? '';
  const { index, now } = useDataset();
  const portfolio = useMemo(() => {
    try {
      return findPortfolio(index, key, now);
    } catch {
      return null;
    }
  }, [index, key, now]);
  if (!portfolio) return <NotFound creatorKey={key} />;
  return <CreatorDetail creatorKey={key} />;
}

/* ------------------------------------------------------------------------------------------ not found */

function NotFound({ creatorKey }: { creatorKey: string }) {
  return (
    <div className="flex flex-col gap-4">
      <PageHeader eyebrow="Creator Intelligence" title="크리에이터를 찾을 수 없음" description="추적 중인 크리에이터·계정 목록에 이 키가 없음." />
      <Card>
        <EmptyState
          icon={<Users className="size-8" />}
          title="해당 크리에이터·계정 없음"
          description={
            <>
              요청한 키: <code className="rounded bg-surface-2 px-1 font-mono break-all">{creatorKey || '(없음)'}</code>
              <br />
              링크가 잘못됐거나, 이 계정이 아직 수집되지 않았거나, 크리에이터 연결이 바뀌었을 수 있음.
            </>
          }
          action={
            <span className="flex flex-wrap justify-center gap-2">
              <Link
                to="/creators"
                className="focus-ring inline-flex h-8 items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-[13px] font-medium text-fg hover:bg-surface-3"
              >
                <ArrowLeft className="size-4" aria-hidden />
                크리에이터 목록
              </Link>
              {creatorKey ? (
                <Link
                  to={hrefWith('/creators', { q: creatorKey.includes(':') ? creatorKey.slice(creatorKey.indexOf(':') + 1) : creatorKey })}
                  className="focus-ring inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-2.5 text-[13px] font-medium text-on-accent hover:bg-accent-hover"
                >
                  비슷한 이름 검색
                </Link>
              ) : null}
            </span>
          }
        />
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ page */

function CreatorDetail({ creatorKey }: { creatorKey: string }) {
  const { dataset, now, tz } = useDataset();
  const readiness = useMemo(() => dataReadiness(dataset), [dataset]);
  const { spec, range, rollingHours, setSpec } = useRangeParam('range', 'rolling30d');
  const input = useMemo(() => ({ key: creatorKey, range, rollingHours, tz, now }), [creatorKey, range, rollingHours, tz, now]);
  const detail = useAnalysis('creators.detail', input, (index, i) => computeCreatorDetail(index, i));
  const d = detail.data;

  if (detail.error) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader eyebrow="Creator Intelligence" title={creatorKey} />
        <Card>
          <ErrorState title="크리에이터 정보를 계산하지 못함" error={detail.error} />
        </Card>
      </div>
    );
  }
  if (!d) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader eyebrow="Creator Intelligence" title="크리에이터" />
        <LoadingState rows={6} />
      </div>
    );
  }

  const p = d.portfolio;
  const av = portfolioAvatar(p.accounts);
  const multi = d.summary.platforms.length > 1;
  const beforeCollection = windowBeforeCollection(d.window, readiness.firstObservationAt, now);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow={
          <Link to={hrefWith('/creators', { range: spec })} className="focus-ring inline-flex items-center gap-1 rounded-sm hover:text-accent-text hover:underline">
            <ArrowLeft className="size-3.5" aria-hidden />
            Creator Intelligence · 크리에이터 목록
          </Link>
        }
        title={
          <span className="flex min-w-0 items-center gap-3">
            <CreatorAvatar name={p.name} src={av.src} platform={av.platform} size="hero" />
            <span className="min-w-0 break-keep">{p.name}</span>
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-1.5">
            <span>{p.kind === 'creator' ? '크리에이터 포트폴리오' : '단일 계정'}</span>
            <PlatformStrip platforms={d.summary.platforms} size="sm" />
            <LinkStatusBadge status={d.linkStatus} />
            <span className="text-fg-3">
              · 계정 {formatInteger(p.accountIds.length)}개 · 추적 영상 {formatInteger(d.summary.videoCount)}개
            </span>
          </span>
        }
        actions={
          <>
            <WatchButton kind="creator" id={creatorKey} />
            <Link
              to={compareHref([creatorKey], { range: spec })}
              className="focus-ring inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-2.5 text-[13px] font-medium text-on-accent hover:bg-accent-hover"
            >
              <GitCompareArrows className="size-4" aria-hidden />
              <span>
                <span className="hidden sm:inline">다른 크리에이터와 </span>비교
              </span>
            </Link>
          </>
        }
      />

      <FilterBar label="크리에이터 상세 필터">
        <RangePicker value={spec} onChange={setSpec} presets={[...DETAIL_PRESETS]} />
        <p className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-3">
          <span>
            {rollingHours
              ? `지표: 데이터 기준 시각까지 최근 ${rollingHours}시간 (롤링) · 일별 차트: ${formatLocalRange(range)} (${tzShort(tz)} 날짜)`
              : `기간 ${formatLocalRange(range)} (${tzShort(tz)} 날짜 기준, 양 끝 포함)`}
          </span>
          {d.window.incomplete ? <Badge tone="warning">진행 중인 기간</Badge> : null}
          <span aria-hidden>·</span>
          <span>
            데이터 기준 {fmtTime(now, tz)} {tzShort(tz)}
          </span>
        </p>
      </FilterBar>

      {d.note ? (
        <p className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-[13px] text-fg-2">
          <span className="font-medium">연결 메모:</span> {d.note}
        </p>
      ) : null}

      {beforeCollection ? (
        <PreCollectionCallout
          readiness={readiness}
          rangeLabel={`${formatLocalRange(range)}, ${tzShort(tz)}`}
          onRecent={() => setSpec('rolling30d')}
          recentLabel="최근 30일(롤링)로 보기"
        >
          기간 업로드·게시 시간·분야 구성·업로드 주기는 게시일 기준이라 그대로 볼 수 있음. 상위 영상은 업로드 기간 기준으로 보여 줌.
        </PreCollectionCallout>
      ) : null}

      <SectionBoundary title="핵심 지표를 계산하지 못함" resetKey={spec}>
        <Kpis d={d} stale={detail.isStale} />
      </SectionBoundary>

      <SectionGrid>
        <Card className="lg:col-span-5">
          <CardHeader icon={<Users className="size-4" />} title="플랫폼별 계정" description="이 포트폴리오에 묶인 계정과 원본 링크." />
          <SectionBoundary title="계정 목록을 표시하지 못함" compact>
            <AccountList d={d} />
          </SectionBoundary>
        </Card>
        <Card className="lg:col-span-7">
          <SectionBoundary title="팔로워를 표시하지 못함" compact>
            <FollowersCard d={d} />
          </SectionBoundary>
        </Card>
      </SectionGrid>

      {multi ? (
        <Card flush>
          <div className="p-4 pb-0 sm:p-5 sm:pb-0">
            <CardHeader
              icon={<BarChart3 className="size-4" />}
              title="플랫폼별 성과"
              description="같은 기간·지표를 플랫폼마다 따로 계산함. 플랫폼 사이 조회 단위가 달라 이 표로 비교하는 편이 정확함."
            />
          </div>
          <SectionBoundary title="플랫폼별 성과를 계산하지 못함" compact resetKey={spec}>
            <PlatformTable rows={d.perPlatform} missing={d.missingFollowerPlatforms} stale={detail.isStale} />
          </SectionBoundary>
        </Card>
      ) : null}

      <Card>
        <SectionBoundary title="일별 조회 증가를 계산하지 못함" compact resetKey={spec}>
          <TimelineCard creatorKey={creatorKey} range={range} />
        </SectionBoundary>
      </Card>

      <Card flush>
        <SectionBoundary title="상위 영상을 계산하지 못함" resetKey={spec}>
          <TopVideos portfolio={p} spec={spec} range={range} rollingHours={rollingHours} multi={multi} beforeCollection={beforeCollection} />
        </SectionBoundary>
      </Card>

      <SectionGrid>
        <Card className="lg:col-span-8">
          <SectionBoundary title="게시 시간 히트맵을 계산하지 못함" compact>
            <HeatmapCard creatorKey={creatorKey} multi={multi} />
          </SectionBoundary>
        </Card>
        <Card className="lg:col-span-4">
          <CardHeader icon={<FolderTree className="size-4" />} title="분야 구성" description="추적 중인 전체 영상의 상위 분야 (영상 수)." />
          <SectionBoundary title="분야 구성을 계산하지 못함" compact>
            <CategoryMixCard d={d} spec={spec} />
          </SectionBoundary>
        </Card>
      </SectionGrid>

      <SectionGrid>
        <Card className="lg:col-span-6">
          <SectionBoundary title="업로드 주기를 계산하지 못함" compact>
            <CadenceCard d={d} />
          </SectionBoundary>
        </Card>
        <Card className="lg:col-span-6">
          <SectionBoundary title="협찬 영상을 표시하지 못함" compact>
            <SponsoredCard d={d} spec={spec} />
          </SectionBoundary>
        </Card>
      </SectionGrid>

      <SourceNote asOf={now} window={d.window}>
        <p>
          추적 중인 영상 기준: YouTube는 채널 RSS의 최근 15개 영상, Dailymotion·niconico·PeerTube는 검색·태그로 발견한 영상만 포함함. 계정의 전체 업로드와 다를 수 있음.
        </p>
      </SourceNote>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ KPIs */

function Kpis({ d, stale }: { d: CreatorDetailData; stale: boolean }) {
  const s = d.summary;
  const multi = s.platforms.length > 1;
  return (
    <div className={cx('flex flex-col gap-2 transition-opacity', stale && 'opacity-60')}>
      <KpiGrid>
        <KpiTile
          label="기간 조회 증가"
          icon={<Flame className="size-4" />}
          value={<MetricCell metric={s.viewsInWindow} label="기간 조회 증가" size="lg" align="left" />}
          sub={multi ? '여러 플랫폼 합계 · 단위가 달라 참고용' : '조회 발생 기간 기준'}
          hint="게시일과 관계없이 기간 안에 늘어난 조회의 합계. ≥ 하한: 경계 관측이 없는 영상 포함. 원천: Dailymotion 제공 기간값 포함."
        />
        <KpiTile
          label="기간 업로드"
          icon={<CalendarClock className="size-4" />}
          value={formatInteger(s.uploadsInWindow)}
          sub={`추적 영상 ${formatInteger(s.videoCount)}개 중`}
          hint="기간 안에 게시된 추적 영상 수."
        />
        <KpiTile
          label="참여율 (중앙값)"
          icon={<BarChart3 className="size-4" />}
          value={<MetricCell metric={s.engagementRate} kind="rate" label="참여율(중앙값)" size="lg" align="left" />}
          sub="영상별 (반응 수/조회)의 중앙값"
          hint="좋아요·댓글·공유 중 원천이 준 항목만 반영. YouTube RSS·Dailymotion은 좋아요만, niconico·PeerTube는 좋아요+댓글."
        />
        <KpiTile
          label="V7 중앙값"
          icon={<Clock3 className="size-4" />}
          value={<MetricCell metric={s.medianV7} label="V7 중앙값" size="lg" align="left" />}
          sub="게시 후 7일 시점 조회"
          hint="게시 후 7일이 지난 영상 중 그 시점 조회수를 읽을 수 있는 영상의 중앙값. 수집 초기에는 계산 불가가 많음."
        />
        <KpiTile
          label="팔로워"
          icon={<Users className="size-4" />}
          value={<FollowersCell metric={d.followers} missingPlatforms={d.missingFollowerPlatforms} size="lg" align="left" />}
          sub={
            <span className="inline-flex items-center gap-1">
              기간 증가 <MetricCell metric={s.followersGrowth} label="기간 팔로워 증가" unit="명" align="left" />
            </span>
          }
        />
        <KpiTile
          label="협찬 영상"
          icon={<Handshake className="size-4" />}
          value={formatInteger(s.sponsoredCount)}
          sub={d.brands.length ? `브랜드 ${formatInteger(d.brands.length)}개 감지` : '감지된 브랜드 없음'}
          hint="광고 표기 문구 또는 브랜드·프로모션 단서가 있는 추적 영상 수 (전체 기간)."
        />
      </KpiGrid>
      <DataStateNote counts={statusCounts([s.viewsInWindow, s.engagementRate, s.medianV7, s.followersGrowth])} label="핵심 지표" />
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ accounts */

function AccountList({ d }: { d: CreatorDetailData }) {
  const { now, tz } = useDataset();
  const p = d.portfolio;
  const orphanIds = p.accountIds.filter((id) => !p.accounts.some((a) => a.id === id));
  return (
    <ul className="flex flex-col divide-y divide-line">
      {p.accounts.map((a) => (
        <AccountRow key={a.id} a={a} videos={d.videosByAccount[a.id] ?? 0} missing={d.missingFollowerPlatforms} now={now} tz={tz} />
      ))}
      {orphanIds.map((id) => (
        <li key={id} className="py-2.5 text-[13px] text-fg-3">
          <code className="font-mono break-all">{id}</code> · 계정 정보 없음 (영상 {formatInteger(d.videosByAccount[id] ?? 0)}개에만 기록됨)
        </li>
      ))}
    </ul>
  );
}

function AccountRow({ a, videos, missing, now, tz }: { a: Account; videos: number; missing: Platform[]; now: number; tz: string }) {
  const href = safeHttpUrl(a.url);
  const f = followersMetric([a], now);
  return (
    <li className="flex items-start gap-3 py-2.5">
      <CreatorAvatar name={a.name} src={a.avatar} platform={a.platform} size="md" />
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 flex-wrap items-center gap-1.5">
          <PlatformBadge platform={a.platform} size="xs" />
          {href ? (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="focus-ring inline-flex min-w-0 items-center gap-1 rounded-sm text-sm font-medium text-fg hover:text-accent-text hover:underline"
            >
              <span className="truncate">{a.name}</span>
              <ExternalLink className="size-3 shrink-0 text-fg-3" aria-hidden />
              <span className="sr-only"> ({platformLabel(a.platform)} 원본 새 탭에서 열기)</span>
            </a>
          ) : (
            <span className="truncate text-sm font-medium text-fg">{a.name}</span>
          )}
        </p>
        <p className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-fg-3">
          {a.handle ? <span className="break-all">{a.handle}</span> : null}
          <span>추적 영상 {formatInteger(videos)}개</span>
          <span>추적 시작 {fmtTime(a.trackedSince, tz, 'date')}</span>
          {a.country ? <span>계정 국가(원천 제공) {countryLabel(a.country)}</span> : null}
          {a.seedCategory ? <span>시드 분야 {catLabel(a.seedCategory)}</span> : null}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <FollowersCell metric={f} missingPlatforms={missing.includes(a.platform) ? [a.platform] : []} />
        <p className="text-[11px] text-fg-3">팔로워</p>
      </div>
    </li>
  );
}

/* ------------------------------------------------------------------------------------------ followers */

function FollowersCard({ d }: { d: CreatorDetailData }) {
  const series = d.followerSeries;
  const trend = series.filter((s) => s.points.length >= 2);
  return (
    <>
      <CardHeader
        icon={<Users className="size-4" />}
        title="팔로워 추이"
        description="원천이 제공한 계정별 팔로워(구독자) 관측값. 계정마다 원천 기준이 다름."
        actions={<MetricCell metric={d.summary.followersGrowth} label="기간 팔로워 증가" unit="명" />}
      />
      {!series.length ? (
        <EmptyState
          compact
          title="팔로워 수 원천 미제공"
          description={`${d.missingFollowerPlatforms.map(platformLabel).join('·') || '이 포트폴리오의'} 수집 경로는 팔로워 수를 주지 않음. 0이 아니라 알 수 없음.`}
        />
      ) : trend.length ? (
        <GrowthChart
          title="계정별 팔로워 추이"
          xStyle="datetime"
          height={220}
          series={trend.map((s) => ({
            id: s.account.id,
            label: `${platformLabel(s.account.platform)} · ${s.account.name}`,
            points: s.points.map((pt) => ({ x: pt.t, value: pt.value, status: 'exact' as const })),
          }))}
        />
      ) : (
        <div className="flex flex-col gap-2">
          <ul className="flex flex-col divide-y divide-line">
            {series.map((s) => {
              const last = s.points[s.points.length - 1];
              return (
                <li key={s.account.id} className="flex items-center gap-2 py-2">
                  <PlatformBadge platform={s.account.platform} size="xs" />
                  <span className="min-w-0 flex-1 truncate text-[13px] text-fg">{s.account.name}</span>
                  <MetricCell metric={{ value: last.value, status: 'exact', asOf: last.t, note: null }} label="팔로워" unit="명" source={last.src} />
                </li>
              );
            })}
          </ul>
          <p className="text-xs text-fg-3">
            아직 계정마다 관측이 1회뿐이라 추이를 그릴 수 없음. 수집이 반복되면 그래프로 표시됨.
            {d.missingFollowerPlatforms.length ? ` (원천 미제공: ${d.missingFollowerPlatforms.map(platformLabel).join('·')})` : ''}
          </p>
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------------------------------------ per platform */

function PlatformTable({ rows, missing, stale }: { rows: PlatformBreakdown[]; missing: Platform[]; stale: boolean }) {
  const columns: Column<PlatformBreakdown>[] = [
    { id: 'platform', header: '플랫폼', cell: (r) => <PlatformBadge platform={r.platform} /> },
    { id: 'accounts', header: '계정', align: 'right', width: '4rem', hideBelow: 'md', cell: (r) => formatInteger(r.summary.accounts.length) },
    { id: 'videos', header: '추적 영상', align: 'right', width: '5.5rem', hideBelow: 'sm', cell: (r) => formatInteger(r.summary.videoCount) },
    { id: 'uploads', header: '기간 업로드', align: 'right', width: '6rem', hideBelow: 'sm', cell: (r) => formatInteger(r.summary.uploadsInWindow) },
    { id: 'views', header: '기간 조회 증가', align: 'right', width: '8rem', cell: (r) => <MetricCell metric={r.summary.viewsInWindow} label="기간 조회 증가" /> },
    { id: 'eng', header: '참여율', align: 'right', width: '6rem', hideBelow: 'md', cell: (r) => <MetricCell metric={r.summary.engagementRate} kind="rate" label="참여율(중앙값)" /> },
    { id: 'v7', header: 'V7 중앙값', align: 'right', width: '7rem', hideBelow: 'lg', cell: (r) => <MetricCell metric={r.summary.medianV7} label="V7 중앙값" /> },
    { id: 'followers', header: '팔로워', align: 'right', width: '7rem', cell: (r) => <FollowersCell metric={r.followers} missingPlatforms={missing.includes(r.platform) ? [r.platform] : []} /> },
  ];
  return <DataTable columns={columns} rows={rows} rowKey={(r) => r.platform} caption="플랫폼별 성과" stale={stale} minWidth="320px" className="mt-1" />;
}

/* ------------------------------------------------------------------------------------------ timeline */

function TimelineCard({ creatorKey, range }: { creatorKey: string; range: { start: string; end: string } }) {
  const { now, tz } = useDataset();
  const tl = useAnalysis('creatorTimeline', { key: creatorKey, range, tz, now }, (index, i) => creatorTimeline(index, i.key, { range: i.range, tz: i.tz, now: i.now }));
  const rows = useMemo(() => (tl.data ? normalizeTimeline(tl.data, now, tz) : undefined), [tl.data, now, tz]);
  const series = useMemo(() => (rows ? platformTimelineSeries(rows) : []), [rows]);
  const states = useMemo(() => (rows ? timelineStatus(rows) : null), [rows]);
  const hasDm = series.some((s) => s.id === 'dailymotion');
  return (
    <>
      <CardHeader
        icon={<BarChart3 className="size-4" />}
        title="일별 조회 증가 (플랫폼별)"
        description={`${tzShort(tz)} 날짜별로 추적 영상의 조회가 늘어난 양. 플랫폼마다 단위가 달라 막대를 합산하지 않음.`}
      />
      {tl.error ? (
        <ErrorState title="일별 조회 증가를 계산하지 못함" error={tl.error} compact />
      ) : !rows ? (
        <LoadingState rows={4} />
      ) : (
        <div className={cx('flex flex-col gap-2 transition-opacity', tl.isStale && 'opacity-60')}>
          <GrowthChart
            title="일별 조회 증가 (플랫폼별)"
            variant="bar"
            height={240}
            series={series}
            empty={
              <span className="px-4 text-center">
                이 기간에는 하루 단위로 계산할 수 있는 관측이 아직 없음 (날짜 경계 앞뒤 관측 필요).{' '}
                <Link to="/coverage" className="focus-ring rounded-sm text-accent-text hover:underline">
                  수집 범위 보기
                </Link>
              </span>
            }
          />
          {states ? <DataStateNote counts={states} label="일별 값" /> : null}
          <p className="text-xs text-fg-3">
            추적 영상이 아직 없던 날은 —(0이 아님). 오늘은 데이터 기준 시각까지의 값이라 ≥(하한)로 표시함.
          </p>
          {hasDm ? (
            <p className="text-xs text-fg-3">
              Dailymotion의 원천 제공 기간값(최근 24시간·7일·30일)은 하루 단위로 나눌 수 없어 이 차트에는 쓰지 않고, 위 기간 합계에만 반영함.
            </p>
          ) : null}
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------------------------------------ top videos */

type TopMode = 'activity' | 'upload';

const TOP_SORT: Record<TopMode, 'views_period' | 'views_total'> = { activity: 'views_period', upload: 'views_total' };

function TopVideos({
  portfolio,
  spec,
  range,
  rollingHours,
  multi,
  beforeCollection,
}: {
  portfolio: Portfolio;
  spec: string;
  range: { start: string; end: string };
  rollingHours: number | null;
  multi: boolean;
  /** The window ends before the first observation: period increases are unknown, so default to upload mode. */
  beforeCollection: boolean;
}) {
  const { now, tz } = useDataset();
  const [chosen, setMode] = useState<TopMode | null>(null);
  const mode: TopMode = chosen ?? (beforeCollection ? 'upload' : 'activity');
  const accountIds = portfolio.accountIds;
  // Same list in the video search (full list, filters, detail drawer with growth chart + raw observations).
  const listParams = { range: spec, mode, sort: TOP_SORT[mode] };
  const query = useMemo(
    (): VideoQuery => ({
      dateMode: mode,
      range,
      rollingHours: rollingHours ?? undefined,
      tz,
      now,
      accountIds,
      sort: TOP_SORT[mode],
      sortDir: 'desc',
      limit: 10,
    }),
    [mode, range, rollingHours, tz, now, accountIds],
  );
  const res = useAnalysis('queryVideos', query, (index, q) => queryVideos(index, q));
  return (
    <>
      <div className="p-4 pb-0 sm:p-5 sm:pb-0">
        <CardHeader
          icon={<Flame className="size-4" />}
          title="상위 영상"
          description={
            mode === 'activity'
              ? '조회 발생 기간 기준: 게시일과 관계없이 기간 동안 조회가 가장 많이 늘어난 영상.'
              : '업로드 기간 기준: 기간 안에 게시된 영상을 기준 시각 누적 조회로 비교.'
          }
          actions={
            <span className="flex flex-wrap items-center gap-2">
              <SegmentedControl<TopMode>
                size="sm"
                label="상위 영상 날짜 기준"
                value={mode}
                onChange={setMode}
                options={[
                  { value: 'activity', label: '조회 발생 기간' },
                  { value: 'upload', label: '업로드 기간' },
                ]}
              />
              <Link
                to={portfolioVideosHref(portfolio, listParams)}
                className="focus-ring inline-flex items-center gap-1 rounded-sm text-[13px] font-medium text-accent-text hover:underline"
              >
                영상 탐색에서 보기 <ArrowRight className="size-3.5" aria-hidden />
              </Link>
            </span>
          }
        />
      </div>
      <TopVideoTable state={res} mode={mode} multi={multi} detailHref={(id) => portfolioVideosHref(portfolio, { ...listParams, v: id })} />
    </>
  );
}

function TopVideoTable({
  state,
  mode,
  multi,
  detailHref,
}: {
  state: { data: QueryResult | undefined; error: Error | null; isStale: boolean };
  mode: TopMode;
  multi: boolean;
  /** In-app link to the video's detail drawer (growth chart + raw observations). */
  detailHref: (videoId: string) => string;
}) {
  const { tz, now } = useDataset();
  if (state.error) return <ErrorState title="상위 영상을 계산하지 못함" error={state.error} compact />;
  const r = state.data;
  if (!r) return <LoadingState rows={5} className="px-4" />;
  const mixed = new Set(r.rows.map((x) => x.video.platform)).size > 1;
  const columns: Column<VideoRow>[] = [
    { id: 'rank', header: '#', width: '3rem', align: 'right', cell: (_x, i) => <span className="whitespace-nowrap text-fg-3">{i + 1}</span> },
    {
      id: 'video',
      header: '영상',
      cell: (x) => (
        <VideoCell
          video={x.video}
          accountName={x.account?.name}
          publishedLabel={fmtTime(x.video.publishedAt, tz, 'date')}
          publishedTitle={`${fmtTime(x.video.publishedAt, tz)} ${tzShort(tz)}`}
        >
          <VideoDetailLink to={detailHref(x.video.id)} />
        </VideoCell>
      ),
    },
    mode === 'activity'
      ? {
          id: 'period',
          header: '기간 조회 증가',
          align: 'right',
          width: '8rem',
          cell: (x) => <MetricCell metric={x.metrics.viewsPeriod} label="기간 조회 증가" source={lastSrc(x)} />,
        }
      : {
          id: 'total',
          header: '누적 조회',
          align: 'right',
          width: '8rem',
          cell: (x) => <MetricCell metric={x.metrics.viewsTotal} label="누적 조회" source={lastSrc(x)} />,
        },
    {
      id: 'out',
      header: '평소 대비',
      align: 'right',
      width: '6.5rem',
      hideBelow: 'md',
      hint: '같은 나이(게시 후 N일)에서 같은 계정의 다른 영상 중앙값 대비 배수. 비교 영상이 3개 미만이면 계산 불가.',
      cell: (x) => <MetricCell metric={x.metrics.outperformance} kind="multiplier" label="평소 대비" />,
    },
    {
      id: 'eng',
      header: '참여율',
      align: 'right',
      width: '6rem',
      hideBelow: 'sm',
      cell: (x) => <MetricCell metric={x.metrics.engagementRate} kind="rate" label="참여율" />,
    },
  ];
  return (
    <div>
      <DataTable
        columns={columns}
        rows={r.rows}
        rowKey={(x) => x.video.id}
        caption="크리에이터 상위 영상"
        stale={state.isStale}
        minWidth="320px"
        className="mt-1"
        empty={
          <EmptyState
            compact
            title={mode === 'activity' ? '이 기간에 조회 증가를 계산할 수 있는 영상 없음' : '이 기간에 게시된 추적 영상 없음'}
            description="기간을 넓히거나 다른 날짜 기준을 선택해 볼 수 있음."
          />
        }
      />
      <div className="flex flex-col gap-1 px-4 py-3 text-xs text-fg-3 sm:px-5">
        {multi && mixed ? (
          <p className="flex items-start gap-1.5">
            <TriangleAlert className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
            <span>여러 플랫폼 영상이 섞인 순위임. {CROSS_PLATFORM_CAVEAT}</span>
          </p>
        ) : null}
        <p>
          추적 영상 {formatInteger(r.total)}개 중 상위 {r.rows.length}개 · 데이터 기준 {fmtTime(now, tz)} {tzShort(tz)}
        </p>
        {r.notes.length ? (
          <details>
            <summary className="focus-ring w-fit cursor-pointer rounded-sm hover:text-fg">계산 메모 {r.notes.length}건</summary>
            <ul className="mt-1 list-disc pl-5">
              {r.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </div>
  );
}

/** Opens the video search detail drawer (growth chart + raw observations); the title itself opens the platform. */
function VideoDetailLink({ to }: { to: string }) {
  return (
    <Link to={to} className="focus-ring mt-0.5 inline-flex w-fit items-center gap-1 rounded-sm text-xs text-accent-text hover:underline">
      <LineChart className="size-3" aria-hidden />
      성장 곡선·관측 기록
    </Link>
  );
}

function lastSrc(r: VideoRow): string | null {
  const o = r.video.obs;
  return o.length ? o[o.length - 1].src : null;
}

/* ------------------------------------------------------------------------------------------ heatmap */

function HeatmapCard({ creatorKey, multi }: { creatorKey: string; multi: boolean }) {
  const { now, tz } = useDataset();
  const [mode, setMode] = useState<HeatMode>('count');
  const hm = useAnalysis('postingHeatmap', { key: creatorKey, tz, now }, (index, i) => postingHeatmap(index, i.key, i.tz, i.now));
  const slots = useMemo((): HeatSlot[] => (hm.data ? heatmapSlots(hm.data) : []), [hm.data]);
  const total = slots.reduce((a, s) => a + s.count, 0);
  const v7Cells = slots.filter((s) => s.medianV7 !== null).length;
  const peak = slots[0] ?? null;
  return (
    <>
      <CardHeader
        icon={<CalendarClock className="size-4" />}
        title="게시 시간 히트맵"
        description={`추적 영상의 게시 요일 × 시간 (${tzShort(tz)}, 상단 시간대 설정 기준). 전체 추적 기간.`}
        actions={
          <SegmentedControl<HeatMode>
            size="sm"
            label="히트맵 값"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'count', label: '업로드 수' },
              { value: 'v7', label: 'V7 중앙값' },
            ]}
          />
        }
      />
      {hm.error ? (
        <ErrorState title="게시 시간 히트맵을 계산하지 못함" error={hm.error} compact />
      ) : !hm.data ? (
        <LoadingState rows={3} />
      ) : total === 0 ? (
        <EmptyState compact title="게시된 추적 영상 없음" />
      ) : (
        <div className={cx('flex flex-col gap-2 transition-opacity', hm.isStale && 'opacity-60')}>
          <p className="text-[13px] text-fg-2">
            업로드 {formatInteger(total)}개
            {peak ? (
              <>
                {' '}
                · 가장 많이 게시한 시간대 <strong className="font-semibold text-fg">{slotLabel(peak)}</strong> ({formatInteger(peak.count)}개)
              </>
            ) : null}
          </p>
          <PostingHeatmap data={hm.data} mode={mode} tz={tz} />
          {mode === 'v7' ? (
            <p className="text-xs text-fg-3">
              V7 중앙값은 게시 후 7일이 지나고 그 시점 조회를 읽을 수 있는 영상만 사용함. 현재 값이 있는 칸 {formatInteger(v7Cells)}개
              {v7Cells === 0 ? ' (관측이 쌓이면 채워짐)' : ''}.{multi ? ' 여러 플랫폼 영상이 섞여 단위가 다름.' : ''}
            </p>
          ) : null}
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------------------------------------ categories */

function CategoryMixCard({ d, spec }: { d: CreatorDetailData; spec: string }) {
  const mix = d.categoryMix;
  if (!mix.videos) return <EmptyState compact title="추적 영상 없음" />;
  const top = mix.rows.slice(0, 8);
  return (
    <div className="flex flex-col gap-2">
      {top.length ? (
        <BarList
          label="분야별 영상 수"
          total={mix.videos}
          showShare
          items={top.map((r) => ({
            key: r.id,
            label: catLabel(r.id),
            value: r.count,
            display: formatInteger(r.count),
            // This portfolio's videos in the category; activity mode keeps every publish date, like the counts here.
            to: portfolioVideosHref(d.portfolio, { cats: [r.id], range: spec, mode: 'activity', sort: 'views_period' }),
          }))}
        />
      ) : null}
      <p className="text-xs text-fg-3">
        영상 {formatInteger(mix.videos)}개 기준{mix.uncategorized ? ` · 미분류 ${formatInteger(mix.uncategorized)}개` : ''}. 여러 분야에 속한 영상은 각 분야에 모두 셈.{' '}
        <Link to="/taxonomy" className="focus-ring rounded-sm text-accent-text hover:underline">
          분류 기준
        </Link>
      </p>
      {d.summary.topCategories.length ? (
        <p className="flex flex-wrap items-center gap-1 text-xs text-fg-3">
          주요 분야
          {d.summary.topCategories.map((c) => (
            <CategoryChip key={c} id={c} size="xs" />
          ))}
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ cadence */

function CadenceCard({ d }: { d: CreatorDetailData }) {
  const { tz, now } = useDataset();
  const c = d.cadence;
  const series = useMemo(
    () => [
      {
        id: 'uploads',
        label: '주간 업로드',
        points: c.weeks.map((w) => ({ x: w.start, value: w.count, status: w.count === null ? ('unavailable' as const) : w.current ? ('lower_bound' as const) : ('exact' as const) })),
      },
    ],
    [c],
  );
  const rss = d.summary.platforms.includes('youtube');
  return (
    <>
      <CardHeader
        icon={<CalendarClock className="size-4" />}
        title="업로드 주기"
        description={`최근 12주 주간 업로드 수 (월요일 시작, ${tzShort(tz)}). 추적 영상 기준이라 실제 업로드보다 적을 수 있음.`}
      />
      {c.firstPublished === null ? (
        <EmptyState compact title="게시된 추적 영상 없음" />
      ) : (
        <div className="flex flex-col gap-3">
          <dl className="grid grid-cols-2 gap-x-4 sm:grid-cols-3">
            <StatRow label="최근 7일">{formatInteger(c.uploads7d)}개</StatRow>
            <StatRow label="최근 30일">{formatInteger(c.uploads30d)}개</StatRow>
            <StatRow label="최근 게시">
              <Tooltip content={`${fmtTime(c.lastPublished, tz)} ${tzShort(tz)}`}>{fmtTime(c.lastPublished, tz, 'date')}</Tooltip>
            </StatRow>
          </dl>
          <GrowthChart
            title="주간 업로드 수"
            variant="bar"
            height={160}
            series={series}
            empty="최근 12주에 게시된 추적 영상 없음"
          />
          <ul className="flex flex-col divide-y divide-line text-[13px]">
            {c.perPlatform.map((pc) => (
              <li key={pc.platform} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 py-1.5">
                <PlatformBadge platform={pc.platform} size="xs" />
                <span className="text-fg-2">영상 {formatInteger(pc.videos)}개</span>
                <span className="text-fg-3">
                  · 업로드 간격 중앙값 <span className="text-fg">{formatInterval(pc.medianIntervalHours)}</span>
                </span>
                <span className="text-fg-3">
                  · {fmtTime(pc.firstPublished, tz, 'date')} ~ {fmtTime(pc.lastPublished, tz, 'date')}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-fg-3">
            빈 주(—)는 가장 오래된 추적 영상 이전이라 알 수 없음(0이 아님). 이번 주는 진행 중(≥).
            {rss ? ' YouTube는 채널 RSS의 최근 15개 영상만 보이므로 오래된 업로드가 빠져 있음.' : ''} 데이터 기준 {fmtTime(now, tz, 'date')}.
          </p>
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------------------------------------ sponsored */

function SponsoredCard({ d, spec }: { d: CreatorDetailData; spec: string }) {
  const { tz } = useDataset();
  const list = d.sponsored;
  const shown = list.slice(0, 12);
  return (
    <>
      <CardHeader
        icon={<Handshake className="size-4" />}
        title="협찬 영상"
        description="광고 표기(명시적 유료 광고 문구) 또는 협찬 추정(브랜드·프로모션 단서) 영상. 전체 추적 기간."
        actions={
          <Link to="/brands" className="focus-ring rounded-sm text-[13px] font-medium text-accent-text hover:underline">
            브랜드 협업
          </Link>
        }
      />
      {!list.length ? (
        <EmptyState compact title="협찬 신호가 있는 영상 없음" description="제목·설명·태그에서 광고 표기나 브랜드 단서를 찾지 못함." />
      ) : (
        <div className="flex flex-col gap-3">
          {d.brands.length ? (
            <p className="flex flex-wrap items-center gap-1 text-xs text-fg-3">
              감지된 브랜드
              {d.brands.slice(0, 10).map((b) => (
                <Badge key={b.brand} tone="neutral">
                  {b.brand} {b.count > 1 ? `×${b.count}` : ''}
                </Badge>
              ))}
            </p>
          ) : null}
          <ul className="flex flex-col divide-y divide-line">
            {shown.map((v) => (
              <SponsoredRow
                key={v.id}
                v={v}
                tz={tz}
                detailHref={portfolioVideosHref(d.portfolio, { range: spec, mode: 'activity', sort: 'views_period', v: v.id })}
              />
            ))}
          </ul>
          {list.length > shown.length ? <p className="text-xs text-fg-3">외 {formatInteger(list.length - shown.length)}개</p> : null}
        </div>
      )}
    </>
  );
}

function SponsoredRow({ v, tz, detailHref }: { v: Video; tz: string; detailHref: string }) {
  const s = v.sponsorship!;
  const evidence = s.evidence.map((e) => `${e.field === 'title' ? '제목' : e.field === 'description' ? '설명' : e.field === 'tags' ? '태그' : e.field}: “${e.match}”`);
  return (
    <li className="flex flex-col gap-1 py-2">
      <VideoTitleLink video={v} lines={2} />
      <p className="flex flex-wrap items-center gap-1 text-xs text-fg-3">
        <Tooltip
          content={
            <span className="flex flex-col gap-0.5">
              <span>{s.level === 'disclosed' ? '명시적 광고·협찬 표기 문구가 있음.' : '브랜드·프로모션 단서만 있음 (표기 없음).'}</span>
              {evidence.slice(0, 4).map((e) => (
                <span key={e}>{e}</span>
              ))}
              <span>판정 버전 {s.version}</span>
            </span>
          }
        >
          <Badge tone={s.level === 'disclosed' ? 'accent' : 'warning'}>{s.level === 'disclosed' ? '광고 표기' : '협찬 추정'}</Badge>
        </Tooltip>
        <PlatformBadge platform={v.platform} size="xs" />
        <span className="tabular">게시 {fmtTime(v.publishedAt, tz, 'date')}</span>
        {s.brands.length ? <span>· 브랜드 {s.brands.join(', ')}</span> : null}
      </p>
      <VideoDetailLink to={detailHref} />
    </li>
  );
}
