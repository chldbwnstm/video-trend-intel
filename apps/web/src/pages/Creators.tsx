/**
 * 크리에이터 (Tubular Creator Intelligence): portfolios that group a creator's accounts across platforms
 * (or single accounts), ranked for the selected period by view increase, followers, uploads, engagement,
 * median V7 or follower growth. Rows can be picked (max 4) for the side-by-side comparison page.
 */
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { resolveAnalysisWindow, summarizeCreators } from '@vti/core';
import type { CreatorSummary, Platform, UtcWindow } from '@vti/core';
import { GitCompareArrows, TriangleAlert, Users, X } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CategoryChip,
  CategoryPicker,
  Checkbox,
  Chip,
  DataTable,
  EmptyState,
  ErrorState,
  ExportCsvButton,
  FilterBar,
  LoadingState,
  MetricCell,
  PageHeader,
  Pager,
  PlatformPicker,
  RangePicker,
  SearchInput,
  SectionBoundary,
  Select,
  SourceNote,
  clampPage,
  toCsv,
} from '../components/index.ts';
import type { Column } from '../components/index.ts';
import { useAnalysis, useDataset, useRangeParam, useUrlState } from '../data/hooks.ts';
import { fmtTime } from '../lib/display.ts';
import { formatInteger } from '../lib/format.ts';
import { CROSS_PLATFORM_CAVEAT, orderPlatforms, platformLabel } from '../lib/platform.ts';
import { tzShort } from '../lib/timezones.ts';
import { formatLocalRange, intCodec, platformListCodec } from '../lib/urlState.ts';
import { cx } from '../lib/cx.ts';
import {
  CREATOR_SORT_LABELS,
  CREATOR_SORTS,
  compareHref,
  creatorHref,
  creatorSortCodec,
  effectiveCreatorSort,
  followersMetric,
  linkStatusOf,
  MAX_COMPARE,
  normalizeCompareKeys,
  platformsWithoutFollowers,
  statusCounts,
  toggleCompareKey,
  windowBeforeCollection,
} from '../features/creators/logic.ts';
import type { CreatorSort } from '../features/creators/logic.ts';
import { CreatorAvatar, DataStateNote, FollowersCell, LinkStatusBadge, PlatformStrip, portfolioAvatar, PreCollectionCallout } from '../features/creators/parts.tsx';
import { CREATORS_CSV_DATE_MODE, creatorCsvRows } from '../features/creators/csv.ts';
import { dataReadiness } from '../features/trends/readiness.ts';

const PAGE_SIZE = 50;

/** Column header sort keys -> creator sort. */
const COLUMN_SORT: Record<string, CreatorSort> = {
  followers: 'followers',
  uploads: 'uploads',
  views: 'views_period',
  engagement: 'engagement',
  v7: 'median_v7',
  growth: 'followers_growth',
};

export default function CreatorsPage() {
  const { dataset, now, tz } = useDataset();
  const { spec, range, rollingHours, setSpec } = useRangeParam('range', 'rolling7d', { resets: ['page'] });
  const [platforms, setPlatforms] = useUrlState<Platform[]>('platforms', [], { codec: platformListCodec, resets: ['page'] });
  const [cats, setCats] = useUrlState<string[]>('cats', [], { resets: ['page'] });
  const [q, setQ] = useUrlState('q', '', { resets: ['page'] });
  const [sort, setSort] = useUrlState<CreatorSort>('sort', 'views_period', { codec: creatorSortCodec, resets: ['page'] });
  const [multi, setMulti] = useUrlState('multi', false, { resets: ['page'] });
  const [pageParam, setPage] = useUrlState('page', 1, { codec: intCodec });
  const [rawKeys, setKeys] = useUrlState<string[]>('keys', []);
  const keys = useMemo(() => normalizeCompareKeys(rawKeys), [rawKeys]);

  const presentPlatforms = useMemo(() => orderPlatforms(dataset.accounts.map((a) => a.platform)), [dataset]);
  const accountCounts = useMemo(() => {
    const c: Partial<Record<Platform, number>> = {};
    for (const a of dataset.accounts) c[a.platform] = (c[a.platform] ?? 0) + 1;
    return c;
  }, [dataset]);

  const windowState = useMemo((): { window: UtcWindow | null; error: Error | null } => {
    try {
      return { window: resolveAnalysisWindow(range, tz, now, rollingHours), error: null };
    } catch (e) {
      return { window: null, error: e instanceof Error ? e : new Error(String(e)) };
    }
  }, [range, tz, now, rollingHours]);

  // A window that ends before the first observation cannot rank view / follower increases: sort by uploads.
  const readiness = useMemo(() => dataReadiness(dataset), [dataset]);
  const beforeCollection = windowState.window ? windowBeforeCollection(windowState.window, readiness.firstObservationAt, now) : false;
  const appliedSort = effectiveCreatorSort(sort, beforeCollection);

  const opts = useMemo(
    () => ({ range, rollingHours, tz, now, platforms, categories: cats, q, sort: appliedSort }),
    [range, rollingHours, tz, now, platforms, cats, q, appliedSort],
  );
  const result = useAnalysis('summarizeCreators', opts, (index, o) => summarizeCreators(index, o));
  const rows = useMemo(() => (result.data ? (multi ? result.data.filter((s) => s.platforms.length > 1) : result.data) : undefined), [result.data, multi]);

  const linkParams = { range: spec, platforms: platforms.length ? platforms : undefined };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow="Creator Intelligence"
        title="크리에이터"
        description="여러 플랫폼 계정을 하나로 묶은 크리에이터 포트폴리오(연결되지 않은 계정은 단독). 모든 수치는 이 서비스가 추적하는 영상 기준이며 플랫폼 전체 집계가 아님."
        actions={
          <>
            <ExportCsvButton
              filename="creators"
              getCsv={() =>
                toCsv(creatorCsvRows(rows ?? [], windowState.window ? { window: windowState.window, rollingHours, now, dateMode: CREATORS_CSV_DATE_MODE } : null))
              }
              disabled={!rows?.length}
            />
            <Link
              to={compareHref(keys, linkParams)}
              className="focus-ring inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-2.5 text-[13px] font-medium text-on-accent hover:bg-accent-hover"
            >
              <GitCompareArrows className="size-4" aria-hidden />
              비교{keys.length ? ` (${keys.length})` : ''}
            </Link>
          </>
        }
      />

      <FilterBar label="크리에이터 필터">
        <RangePicker value={spec} onChange={setSpec} />
        <CategoryPicker value={cats} onChange={setCats} />
        <SearchInput value={q} onChange={setQ} placeholder="이름·핸들·계정 ID" label="크리에이터 검색" className="w-full sm:w-56" />
        <Select<CreatorSort>
          label="정렬"
          hideLabel={false}
          value={appliedSort}
          onChange={setSort}
          options={CREATOR_SORTS.map((s) => ({ value: s, label: CREATOR_SORT_LABELS[s] }))}
        />
        <Checkbox checked={multi} onChange={setMulti} label="여러 플랫폼만" />
        <PlatformPicker options={presentPlatforms} value={platforms} onChange={setPlatforms} counts={accountCounts} label="플랫폼 (계정 수)" />
        <p className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-3">
          <span>
            {rollingHours
              ? `기간: 데이터 기준 시각까지 최근 ${rollingHours}시간 (롤링)`
              : `기간 ${formatLocalRange(range)} (${tzShort(tz)} 날짜 기준, 양 끝 포함)`}
          </span>
          {windowState.window?.incomplete ? <Badge tone="warning">진행 중인 기간</Badge> : null}
          <span aria-hidden>·</span>
          <span>조회 발생 기간 기준: 게시일과 관계없이 기간 안에 늘어난 조회를 합산</span>
          <span aria-hidden>·</span>
          <span>
            데이터 기준 {fmtTime(now, tz)} {tzShort(tz)}
          </span>
        </p>
      </FilterBar>

      {beforeCollection ? (
        <PreCollectionCallout
          readiness={readiness}
          rangeLabel={`${formatLocalRange(range)}, ${tzShort(tz)}`}
          onRecent={() => setSpec('rolling7d')}
        >
          {sort !== appliedSort
            ? `그래서 ${CREATOR_SORT_LABELS[sort]} 대신 기간 업로드(게시일 기준이라 알 수 있음) 순으로 정렬함.`
            : '기간 업로드·팔로워·V7 순위는 게시일·최신 관측 기준이라 그대로 볼 수 있음.'}
        </PreCollectionCallout>
      ) : null}

      {windowState.error ? (
        <Card>
          <ErrorState title="기간을 계산하지 못함" error={windowState.error} />
        </Card>
      ) : (
        <Card flush>
          <SectionBoundary title="크리에이터 목록을 계산하지 못함" resetKey={JSON.stringify(opts)}>
            {result.error ? (
              <ErrorState title="크리에이터 목록을 계산하지 못함" error={result.error} />
            ) : !rows ? (
              <LoadingState rows={8} className="p-4" />
            ) : (
              <CreatorTable
                rows={rows}
                stale={result.isStale}
                sort={appliedSort}
                onSort={setSort}
                page={pageParam}
                onPage={setPage}
                keys={keys}
                onKeys={setKeys}
                spec={spec}
                onPlatform={(p) => setPlatforms([p])}
                filtered={platforms.length > 0}
              />
            )}
          </SectionBoundary>
        </Card>
      )}

      {keys.length ? <CompareTray keys={keys} onKeys={setKeys} href={compareHref(keys, linkParams)} /> : null}

      <SourceNote asOf={now} window={windowState.window}>
        <p>
          팔로워는 원천이 제공하는 계정만 표시함(YouTube RSS·niconico·PeerTube 수집 경로는 미제공). V7 중앙값은 게시 후 7일 시점 관측이 있는 영상만 사용함.
          참여율은 영상별 (좋아요+댓글+공유 중 원천이 준 항목)/조회의 중앙값이라 플랫폼마다 반영 항목이 다름.
        </p>
      </SourceNote>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ table */

function CreatorTable({
  rows,
  stale,
  sort,
  onSort,
  page,
  onPage,
  keys,
  onKeys,
  spec,
  onPlatform,
  filtered,
}: {
  rows: CreatorSummary[];
  stale: boolean;
  sort: CreatorSort;
  onSort: (s: CreatorSort) => void;
  page: number;
  onPage: (p: number) => void;
  keys: string[];
  onKeys: (k: string[]) => void;
  spec: string;
  onPlatform: (p: Platform) => void;
  filtered: boolean;
}) {
  const { dataset, index, now } = useDataset();
  const current = clampPage(page, rows.length, PAGE_SIZE);
  const visible = rows.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  const followers = useMemo(() => new Map(visible.map((s) => [s.key, followersMetric(s.accounts, now)])), [visible, now]);
  const shownPlatforms = useMemo(() => orderPlatforms(rows.flatMap((s) => s.platforms)), [rows]);
  const missingFollowers = useMemo(() => platformsWithoutFollowers(dataset.accounts, shownPlatforms), [dataset, shownPlatforms]);
  const viewStates = useMemo(() => statusCounts(rows.map((s) => s.viewsInWindow)), [rows]);
  const v7Known = useMemo(() => rows.filter((s) => s.medianV7.status !== 'unavailable').length, [rows]);
  const withFollowers = useMemo(() => rows.filter((s) => s.followers !== null).length, [rows]);
  const multiCount = useMemo(() => rows.filter((s) => s.platforms.length > 1).length, [rows]);
  const full = keys.length >= MAX_COMPARE;
  const colSort = Object.entries(COLUMN_SORT).find(([, v]) => v === sort)?.[0] ?? 'views';

  const columns: Column<CreatorSummary>[] = [
    {
      id: 'pick',
      header: <span className="sr-only">비교 선택</span>,
      width: '2rem',
      cell: (s) => {
        const on = keys.includes(s.key);
        return (
          <input
            type="checkbox"
            checked={on}
            disabled={!on && full}
            onChange={() => onKeys(toggleCompareKey(keys, s.key))}
            aria-label={`${s.name} 비교에 ${on ? '포함됨' : '추가'}`}
            title={!on && full ? `최대 ${MAX_COMPARE}명까지 비교` : '비교에 추가'}
            className="focus-ring size-4 accent-[var(--accent)]"
          />
        );
      },
    },
    {
      id: 'rank',
      header: '#',
      width: '3.25rem',
      align: 'right',
      hideBelow: 'sm',
      cell: (_s, i) => <span className="whitespace-nowrap text-fg-3">{(current - 1) * PAGE_SIZE + i + 1}</span>,
    },
    {
      id: 'name',
      header: '크리에이터·계정',
      className: 'min-w-[8.5rem] sm:min-w-[14rem]',
      cell: (s) => {
        const av = portfolioAvatar(s.accounts);
        const multi = s.platforms.length > 1;
        return (
          <div className="flex min-w-0 items-center gap-2.5">
            <CreatorAvatar name={s.name} src={av.src} platform={av.platform} size="sm" className="hidden sm:inline-flex" />
            <div className="min-w-0">
              <Link
                to={creatorHref(s.key, { range: spec })}
                className={cx('focus-ring line-clamp-2 rounded-sm text-sm break-keep text-fg hover:text-accent-text hover:underline', multi ? 'font-semibold' : 'font-medium')}
              >
                {s.name}
              </Link>
              <div className="mt-0.5 flex flex-wrap items-center gap-1">
                <PlatformStrip platforms={s.platforms} />
                <LinkStatusBadge status={s.kind === 'creator' ? linkStatusOf(index, s.key) : null} />
              </div>
              <p className="mt-0.5 text-xs text-fg-3">
                추적 영상 {formatInteger(s.videoCount)}개{s.accounts.length > 1 ? ` · 계정 ${s.accounts.length}개` : ''}
              </p>
            </div>
          </div>
        );
      },
    },
    {
      id: 'views',
      header: '기간 조회 증가',
      align: 'right',
      width: '7.5rem',
      sortKey: 'views',
      hint: '포트폴리오 추적 영상의 기간 조회 증가 합계. ≥ 하한(경계 관측 없는 영상 포함), 원천 = 플랫폼 제공 기간값 포함, — 계산 불가. 여러 플랫폼 합계는 단위가 다름.',
      cell: (s) => <MetricCell metric={s.viewsInWindow} label="기간 조회 증가" />,
    },
    {
      id: 'uploads',
      header: '기간 업로드',
      align: 'right',
      width: '6rem',
      sortKey: 'uploads',
      hideBelow: 'sm',
      hint: '기간 안에 게시된 추적 영상 수 (우리 기록 기준 개수).',
      cell: (s) => <span className="text-sm">{formatInteger(s.uploadsInWindow)}</span>,
    },
    {
      id: 'followers',
      header: '팔로워',
      align: 'right',
      width: '7rem',
      sortKey: 'followers',
      hideBelow: 'md',
      hint: '계정별 최신 팔로워 수 합계. 원천이 주지 않으면 — (0이 아님), 일부 계정만 제공하면 ≥ 하한.',
      cell: (s) => <FollowersCell metric={followers.get(s.key)} missingPlatforms={missingFollowers} />,
    },
    {
      id: 'growth',
      header: '팔로워 증가',
      align: 'right',
      width: '7rem',
      sortKey: 'growth',
      hideBelow: 'lg',
      hint: '기간 동안의 팔로워 변화. 기간 시작 전 관측이 없으면 계산 불가.',
      cell: (s) => <MetricCell metric={s.followersGrowth} label="팔로워 증가" unit="명" />,
    },
    {
      id: 'engagement',
      header: '참여율',
      align: 'right',
      width: '6rem',
      sortKey: 'engagement',
      hideBelow: 'md',
      hint: '영상별 참여율의 중앙값. (좋아요+댓글+공유 중 원천이 준 항목)/조회.',
      cell: (s) => <MetricCell metric={s.engagementRate} kind="rate" label="참여율(중앙값)" />,
    },
    {
      id: 'v7',
      header: 'V7 중앙값',
      align: 'right',
      width: '7rem',
      sortKey: 'v7',
      hideBelow: 'lg',
      hint: '게시 후 7일 시점 조회수의 중앙값. 7일이 지난 영상의 관측이 쌓여야 계산됨.',
      cell: (s) => <MetricCell metric={s.medianV7} label="V7 중앙값" />,
    },
    {
      id: 'cats',
      header: '주요 분야',
      width: '10rem',
      hideBelow: 'lg',
      cell: (s) =>
        s.topCategories.length ? (
          <span className="flex flex-wrap gap-1">
            {s.topCategories.slice(0, 2).map((c) => (
              <CategoryChip key={c} id={c} size="xs" />
            ))}
          </span>
        ) : (
          <span className="text-xs text-fg-3">미분류</span>
        ),
    },
    {
      id: 'sponsored',
      header: '협찬',
      align: 'right',
      width: '4.5rem',
      hideBelow: 'md',
      hint: '광고 표기 또는 협찬 추정 신호가 있는 추적 영상 수.',
      cell: (s) => (s.sponsoredCount ? <Badge tone="info">{formatInteger(s.sponsoredCount)}</Badge> : <span className="text-xs text-fg-3">0</span>),
    },
  ];

  return (
    <div>
      <div className="flex flex-col gap-2 border-b border-line px-4 py-3 sm:px-5">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-fg-2">
          <Users className="size-4 text-fg-3" aria-hidden />
          <span>
            크리에이터·계정 <strong className="font-semibold text-fg">{formatInteger(rows.length)}</strong>개
          </span>
          <span className="text-fg-3">· 여러 플랫폼 포트폴리오 {formatInteger(multiCount)}개</span>
          <span className="text-fg-3">· 팔로워 제공 {formatInteger(withFollowers)}개</span>
          <span className="text-fg-3">· V7 계산 가능 {formatInteger(v7Known)}개</span>
        </p>
        <DataStateNote counts={viewStates} label="기간 조회 증가" />
        {shownPlatforms.length > 1 && !filtered ? (
          <div className="flex items-start gap-1.5 text-xs text-fg-3">
            <TriangleAlert className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
            <p>
              여러 플랫폼이 섞인 순위임. {CROSS_PLATFORM_CAVEAT}{' '}
              <span className="inline-flex flex-wrap gap-1 align-middle">
                {shownPlatforms.map((p) => (
                  <Chip key={p} onClick={() => onPlatform(p)} className="text-xs leading-5">
                    {platformLabel(p)}만
                  </Chip>
                ))}
              </span>
            </p>
          </div>
        ) : null}
      </div>
      <DataTable
        columns={columns}
        rows={visible}
        rowKey={(s) => s.key}
        caption={`크리에이터 목록 (${CREATOR_SORT_LABELS[sort]} 순)`}
        sort={{ key: colSort, dir: 'desc' }}
        onSortChange={(key) => onSort(COLUMN_SORT[key] ?? 'views_period')}
        stale={stale}
        minWidth="340px"
        empty={
          <EmptyState
            title="조건에 맞는 크리에이터 없음"
            description="검색어·분야·플랫폼 필터를 줄이거나 '여러 플랫폼만'을 해제해 볼 수 있음."
          />
        }
      />
      <div className="flex flex-col gap-2 px-4 py-3 sm:px-5">
        <Pager page={current} pageSize={PAGE_SIZE} total={rows.length} onChange={onPage} />
        <p className="text-xs text-fg-3">
          정렬: {CREATOR_SORT_LABELS[sort]} 내림차순. 계산 불가(—)·감소(⚠) 값은 순위에서 빠져 맨 뒤에 놓임. 하한(≥)은 그 값으로 정렬됨.
        </p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ compare tray */

function CompareTray({ keys, onKeys, href }: { keys: string[]; onKeys: (k: string[]) => void; href: string }) {
  const { index } = useDataset();
  const names = useMemo(() => {
    const m = new Map<string, string>();
    for (const k of keys) m.set(k, index.creatorsById.get(k)?.name ?? index.accountsById.get(k)?.name ?? k);
    return m;
  }, [keys, index]);
  return (
    <div className="sticky bottom-3 z-20">
      <div
        role="region"
        aria-label="비교할 크리에이터"
        className="flex flex-wrap items-center gap-2 rounded-xl border border-accent bg-surface p-3 shadow-pop"
      >
        <span className="text-[13px] font-medium text-fg">
          비교 {keys.length}/{MAX_COMPARE}
        </span>
        {keys.map((k) => (
          <Chip key={k} onRemove={() => onKeys(keys.filter((x) => x !== k))} removeLabel={`${names.get(k)} 비교에서 제외`}>
            {names.get(k)}
          </Chip>
        ))}
        <span className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="ghost" icon={<X className="size-3.5" aria-hidden />} onClick={() => onKeys([])}>
            선택 해제
          </Button>
          <Link
            to={href}
            className="focus-ring inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-2.5 text-[13px] font-medium text-on-accent hover:bg-accent-hover"
          >
            <GitCompareArrows className="size-4" aria-hidden />
            {keys.length < 2 ? '비교 화면 열기' : `${keys.length}명 비교하기`}
          </Link>
        </span>
      </div>
    </div>
  );
}
