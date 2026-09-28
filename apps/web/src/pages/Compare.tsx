/**
 * 크리에이터 비교 (/compare?keys=a,b,c,d; Tubular Creator Comparison): up to 4 creators/accounts side by side
 * for the same period — KPI table with per-metric leaders, overlaid daily view increase, per-platform
 * breakdown. Cross-platform numbers are not the same unit (SPEC principle 5): the page says so and offers
 * restricting the comparison to one platform.
 */
import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { MetricValue, Platform } from '@vti/core';
import { BarChart3, GitCompareArrows, Table2, TriangleAlert, X } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  CategoryChip,
  Chip,
  EmptyState,
  ErrorState,
  FilterBar,
  GrowthChart,
  IconButton,
  LoadingState,
  MetricCell,
  PageHeader,
  PlatformBadge,
  PlatformPicker,
  RangePicker,
  SectionBoundary,
  SourceNote,
  Tooltip,
} from '../components/index.ts';
import { useAnalysis, useDataset, useRangeParam, useUrlState } from '../data/hooks.ts';
import { fmtTime } from '../lib/display.ts';
import { formatInteger } from '../lib/format.ts';
import { CROSS_PLATFORM_CAVEAT, orderPlatforms, platformLabel } from '../lib/platform.ts';
import { tzShort } from '../lib/timezones.ts';
import { formatLocalRange, platformListCodec } from '../lib/urlState.ts';
import { cx } from '../lib/cx.ts';
import {
  compareColor,
  compareSeries,
  computeComparison,
  countLeaders,
  creatorHref,
  MAX_COMPARE,
  metricLeaders,
  normalizeCompareKeys,
  portfolioOptions,
  slotLabel,
  statusCounts,
} from '../features/creators/logic.ts';
import type { CompareData, CompareEntry, Leaders, PortfolioOption } from '../features/creators/logic.ts';
import { CreatorPicker, DataStateNote, FollowersCell, LinkStatusBadge, PlatformStrip } from '../features/creators/parts.tsx';

const COMPARE_PRESETS = ['rolling24h', 'rolling7d', 'rolling30d', 'today', 'yesterday', 'last7d', 'last30d', 'last90d', 'thisWeek', 'lastWeek', 'thisMonth', 'lastMonth'] as const;

export default function ComparePage() {
  const { now, tz } = useDataset();
  const { spec, range, rollingHours, setSpec } = useRangeParam('range', 'rolling30d');
  const [rawKeys, setKeys] = useUrlState<string[]>('keys', []);
  const [platforms, setPlatforms] = useUrlState<Platform[]>('platforms', [], { codec: platformListCodec });
  const keys = useMemo(() => normalizeCompareKeys(rawKeys), [rawKeys]);

  const options = useAnalysis('creators.options', { now }, (index, i) => portfolioOptions(index, i.now));
  const input = useMemo(() => ({ keys, range, rollingHours, tz, now, platforms }), [keys, range, rollingHours, tz, now, platforms]);
  const cmp = useAnalysis('creators.compare', input, (index, i) => computeComparison(index, i));

  const add = (k: string) => setKeys(normalizeCompareKeys([...keys, k]));
  const remove = (k: string) => setKeys(keys.filter((x) => x !== k));
  const names = useMemo(() => new Map((cmp.data?.entries ?? []).map((e) => [e.key, e.name])), [cmp.data]);
  const allPlatforms = useMemo(() => orderPlatforms((options.data ?? []).flatMap((o) => o.platforms)), [options.data]);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow="Creator Comparison"
        title="크리에이터 비교"
        description={`최대 ${MAX_COMPARE}명의 크리에이터·계정을 같은 기간·지표로 나란히 비교. 추적 중인 영상 기준이며 플랫폼 전체 집계가 아님.`}
        actions={
          <Link
            to="/creators"
            className="focus-ring inline-flex h-8 items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-[13px] font-medium text-fg hover:bg-surface-3"
          >
            크리에이터 목록
          </Link>
        }
      />

      <FilterBar label="비교 필터">
        <RangePicker value={spec} onChange={setSpec} presets={[...COMPARE_PRESETS]} />
        <CreatorPicker options={options.data ?? []} selected={keys} onAdd={add} max={MAX_COMPARE} />
        {keys.map((k, i) => (
          <Chip
            key={k}
            onRemove={() => remove(k)}
            removeLabel={`${names.get(k) ?? k} 비교에서 제외`}
            icon={<span className="inline-block size-2.5 rounded-full" style={{ background: compareColor(i) }} />}
          >
            {names.get(k) ?? k}
          </Chip>
        ))}
        {keys.length ? (
          <Button size="sm" variant="ghost" icon={<X className="size-3.5" aria-hidden />} onClick={() => setKeys([])}>
            모두 제외
          </Button>
        ) : null}
        <PlatformPicker options={allPlatforms} value={platforms} onChange={setPlatforms} label="비교 플랫폼" />
        <p className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-3">
          <span>
            {rollingHours
              ? `지표: 데이터 기준 시각까지 최근 ${rollingHours}시간 (롤링) · 일별 차트: ${formatLocalRange(range)} (${tzShort(tz)} 날짜)`
              : `기간 ${formatLocalRange(range)} (${tzShort(tz)} 날짜 기준, 양 끝 포함)`}
          </span>
          {cmp.data?.window.incomplete ? <Badge tone="warning">진행 중인 기간</Badge> : null}
          <span aria-hidden>·</span>
          <span>
            데이터 기준 {fmtTime(now, tz)} {tzShort(tz)}
          </span>
          {platforms.length ? (
            <>
              <span aria-hidden>·</span>
              <span>{platforms.map(platformLabel).join('·')} 계정·영상만 비교</span>
            </>
          ) : null}
        </p>
      </FilterBar>

      {keys.length === 0 ? (
        <Suggestions options={options.data} onPick={(ks) => setKeys(ks)} />
      ) : cmp.error ? (
        <Card>
          <ErrorState title="비교를 계산하지 못함" error={cmp.error} />
        </Card>
      ) : !cmp.data ? (
        <Card>
          <LoadingState rows={6} />
        </Card>
      ) : (
        <CompareBody data={cmp.data} stale={cmp.isStale} spec={spec} onRemove={remove} filtered={platforms.length > 0} onPlatform={(p) => setPlatforms([p])} />
      )}

      <SourceNote asOf={now} window={cmp.data?.window ?? null}>
        <p>
          최고 표시는 값이 있는 크리에이터끼리만 비교함. 다른 값이 하한(≥)이거나 계산 불가(—)면 순위가 바뀔 수 있어 &quot;잠정&quot;으로 표시함.
        </p>
      </SourceNote>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ suggestions */

function Suggestions({ options, onPick }: { options: PortfolioOption[] | undefined; onPick: (keys: string[]) => void }) {
  const creators = (options ?? []).filter((o) => o.kind === 'creator');
  const multi = creators.filter((o) => o.platforms.length > 1);
  return (
    <Card>
      <EmptyState
        icon={<GitCompareArrows className="size-8" />}
        title="비교할 크리에이터 선택"
        description={`위의 '크리에이터 추가'에서 검색하거나 크리에이터 목록에서 최대 ${MAX_COMPARE}명을 체크해 비교할 수 있음.`}
        action={
          multi.length >= 2 ? (
            <Button size="sm" variant="primary" onClick={() => onPick(multi.slice(0, MAX_COMPARE).map((o) => o.key))}>
              여러 플랫폼 크리에이터 {Math.min(MAX_COMPARE, multi.length)}명 비교
            </Button>
          ) : null
        }
      />
      {creators.length ? (
        <div className="border-t border-line pt-3">
          <p className="mb-2 text-xs font-medium text-fg-3">연결된 크리에이터</p>
          <ul className="flex flex-wrap gap-1.5">
            {creators.slice(0, 16).map((o) => (
              <li key={o.key}>
                <Chip onClick={() => onPick([o.key])} title={`${o.name} · 영상 ${o.videos}개`}>
                  {o.name}
                  <span className="ml-1 text-[11px] text-fg-3">{o.platforms.map(platformLabel).join('·')}</span>
                </Chip>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}

/* ------------------------------------------------------------------------------------------ body */

function CompareBody({
  data,
  stale,
  spec,
  onRemove,
  filtered,
  onPlatform,
}: {
  data: CompareData;
  stale: boolean;
  spec: string;
  onRemove: (key: string) => void;
  filtered: boolean;
  onPlatform: (p: Platform) => void;
}) {
  const found = data.entries.filter((e) => e.found);
  const missing = data.entries.filter((e) => !e.found);
  const mixed = data.platforms.length > 1;
  return (
    <>
      {missing.length ? (
        <Card>
          <p className="flex flex-wrap items-center gap-2 text-[13px] text-fg-2">
            <TriangleAlert className="size-4 text-warning" aria-hidden />
            찾을 수 없는 키 {missing.length}개:
            {missing.map((e) => (
              <Chip key={e.key} onRemove={() => onRemove(e.key)} removeLabel={`${e.key} 제외`}>
                <code className="font-mono">{e.key}</code>
              </Chip>
            ))}
          </p>
        </Card>
      ) : null}

      {mixed ? (
        <div className="flex items-start gap-2 rounded-xl border border-line bg-warning-soft px-4 py-3 text-[13px] text-fg-2">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          <div className="flex flex-col gap-1.5">
            <p>
              <strong className="font-semibold text-fg">여러 플랫폼 수치가 섞인 비교임.</strong> {CROSS_PLATFORM_CAVEAT} 아래 &apos;플랫폼별 비교&apos;가 같은 단위 비교임.
            </p>
            {!filtered ? (
              <p className="flex flex-wrap items-center gap-1">
                한 플랫폼만 비교:
                {data.platforms.map((p) => (
                  <Chip key={p} onClick={() => onPlatform(p)} className="text-xs leading-5">
                    {platformLabel(p)}
                  </Chip>
                ))}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      {found.length ? (
        <>
          <Card flush className={cx('transition-opacity', stale && 'opacity-60')}>
            <div className="p-4 pb-0 sm:p-5 sm:pb-0">
              <CardHeader
                icon={<Table2 className="size-4" />}
                title="핵심 지표 비교"
                description="같은 기간의 포트폴리오 지표. 지표마다 가장 높은 값에 '최고' 표시 (값 상태가 불완전하면 '잠정')."
              />
            </div>
            <SectionBoundary title="지표 비교표를 표시하지 못함" compact>
              <KpiTable entries={data.entries} missingFollowerPlatforms={data.missingFollowerPlatforms} spec={spec} onRemove={onRemove} />
            </SectionBoundary>
            <div className="px-4 pb-4 sm:px-5">
              <DataStateNote
                counts={statusCounts(found.flatMap((e) => (e.summary ? [e.summary.viewsInWindow, e.summary.engagementRate, e.summary.medianV7] : [])))}
                label="비교 지표"
              />
            </div>
          </Card>

          <Card>
            <SectionBoundary title="일별 비교 차트를 표시하지 못함" compact>
              <TimelineCompare entries={data.entries} mixed={mixed} />
            </SectionBoundary>
          </Card>

          <Card>
            <CardHeader
              icon={<BarChart3 className="size-4" />}
              title="플랫폼별 비교"
              description="같은 플랫폼 안에서만 비교 (같은 조회 단위). 플랫폼마다 가장 높은 기간 조회 증가에 '최고' 표시."
            />
            <SectionBoundary title="플랫폼별 비교를 표시하지 못함" compact>
              <PlatformBreakdown data={data} />
            </SectionBoundary>
          </Card>
        </>
      ) : (
        <Card>
          <EmptyState title="비교할 수 있는 크리에이터 없음" description="선택한 키를 모두 찾지 못했음. 다른 크리에이터를 추가해 볼 수 있음." />
        </Card>
      )}
    </>
  );
}

/* ------------------------------------------------------------------------------------------ KPI table */

function LeaderMark({ leaders, i }: { leaders: Leaders; i: number }) {
  if (!leaders.indices.includes(i)) return null;
  return leaders.firm ? (
    <Badge tone="positive" className="px-1.5 py-px text-[11px]">
      최고
    </Badge>
  ) : (
    <Tooltip content="다른 크리에이터 값이 하한(≥)이거나 계산 불가(—)라 실제 순위가 바뀔 수 있음.">
      <Badge tone="warning" className="px-1.5 py-px text-[11px]">
        최고(잠정)
      </Badge>
    </Tooltip>
  );
}

interface KpiRow {
  id: string;
  label: string;
  hint?: string;
  leaders?: Leaders;
  cell: (e: CompareEntry, i: number) => ReactNode;
}

function KpiTable({
  entries,
  missingFollowerPlatforms,
  spec,
  onRemove,
}: {
  entries: CompareEntry[];
  missingFollowerPlatforms: Platform[];
  spec: string;
  onRemove: (key: string) => void;
}) {
  const cols = entries.map((e, i) => ({ e, i })).filter(({ e }) => e.found && e.summary);
  const metric = (pick: (e: CompareEntry) => MetricValue | null | undefined) => metricLeaders(cols.map(({ e }) => pick(e) ?? null));
  const counts = (pick: (e: CompareEntry) => number) => countLeaders(cols.map(({ e }) => pick(e)));
  const rows: KpiRow[] = [
    {
      id: 'platforms',
      label: '플랫폼',
      cell: (e) => <PlatformStrip platforms={e.summary!.platforms} highlight={false} />,
    },
    {
      id: 'views',
      label: '기간 조회 증가',
      hint: '게시일과 관계없이 기간에 늘어난 조회 합계. 여러 플랫폼 합계는 단위가 다름.',
      leaders: metric((e) => e.summary!.viewsInWindow),
      cell: (e) => <MetricCell metric={e.summary!.viewsInWindow} label="기간 조회 증가" />,
    },
    {
      id: 'uploads',
      label: '기간 업로드',
      leaders: counts((e) => e.summary!.uploadsInWindow),
      cell: (e) => <span className="tabular">{formatInteger(e.summary!.uploadsInWindow)}</span>,
    },
    {
      id: 'engagement',
      label: '참여율 (중앙값)',
      hint: '영상별 (반응 수/조회)의 중앙값. 원천이 준 반응 항목만 반영.',
      leaders: metric((e) => e.summary!.engagementRate),
      cell: (e) => <MetricCell metric={e.summary!.engagementRate} kind="rate" label="참여율(중앙값)" />,
    },
    {
      id: 'v7',
      label: 'V7 중앙값',
      hint: '게시 후 7일 시점 조회수의 중앙값.',
      leaders: metric((e) => e.summary!.medianV7),
      cell: (e) => <MetricCell metric={e.summary!.medianV7} label="V7 중앙값" />,
    },
    {
      id: 'followers',
      label: '팔로워',
      hint: '계정별 최신 팔로워 수 합계. 원천 미제공 계정은 —, 일부만 제공하면 ≥.',
      leaders: metric((e) => e.followers),
      cell: (e) => <FollowersCell metric={e.followers} missingPlatforms={missingFollowerPlatforms} />,
    },
    {
      id: 'growth',
      label: '기간 팔로워 증가',
      leaders: metric((e) => e.summary!.followersGrowth),
      cell: (e) => <MetricCell metric={e.summary!.followersGrowth} label="기간 팔로워 증가" unit="명" />,
    },
    {
      id: 'videos',
      label: '추적 영상',
      hint: '수집 범위(우리 기록) 규모. 성과 지표가 아니라 최고 표시 없음.',
      cell: (e) => <span className="tabular">{formatInteger(e.summary!.videoCount)}</span>,
    },
    {
      id: 'sponsored',
      label: '협찬 영상',
      cell: (e) => <span className="tabular">{formatInteger(e.summary!.sponsoredCount)}</span>,
    },
    {
      id: 'peak',
      label: '주 게시 시간대',
      hint: '추적 영상이 가장 많이 게시된 요일·시간 (현재 시간대 기준).',
      cell: (e) => (e.peak ? <span>{slotLabel(e.peak)} ({formatInteger(e.peak.count)}개)</span> : <span className="text-fg-3">—</span>),
    },
    {
      id: 'cats',
      label: '주요 분야',
      cell: (e) =>
        e.summary!.topCategories.length ? (
          <span className="inline-flex flex-wrap justify-end gap-1">
            {e.summary!.topCategories.map((c) => (
              <CategoryChip key={c} id={c} size="xs" />
            ))}
          </span>
        ) : (
          <span className="text-fg-3">미분류</span>
        ),
    },
  ];

  return (
    <div className="scroll-thin relative mt-1 max-w-full overflow-x-auto">
      <table className="w-full border-separate border-spacing-0 text-sm" style={{ minWidth: 160 + cols.length * 150 }}>
        <caption className="sr-only">크리에이터 핵심 지표 비교</caption>
        <thead>
          <tr>
            <th scope="col" className="sticky left-0 z-10 border-b border-line bg-surface-2 px-3 py-2 text-left text-xs font-medium text-fg-3">
              지표
            </th>
            {cols.map(({ e, i }) => (
              <th key={e.key} scope="col" className="border-b border-line bg-surface-2 px-3 py-2 text-right align-top text-xs font-medium text-fg-3">
                <span className="flex items-start justify-end gap-1">
                  <span className="flex min-w-0 flex-col items-end gap-0.5">
                    <span className="flex items-center gap-1.5">
                      <span aria-hidden className="inline-block size-2.5 shrink-0 rounded-full" style={{ background: compareColor(i) }} />
                      <Link to={creatorHref(e.key, { range: spec })} className="focus-ring line-clamp-2 rounded-sm text-[13px] font-semibold text-fg hover:text-accent-text hover:underline">
                        {e.name}
                      </Link>
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="font-normal">{e.kind === 'creator' ? '크리에이터' : '계정'}</span>
                      <LinkStatusBadge status={e.linkStatus} />
                    </span>
                  </span>
                  <IconButton label={`${e.name} 비교에서 제외`} size="sm" onClick={() => onRemove(e.key)} className="-mt-1 -mr-2">
                    <X className="size-3.5" aria-hidden />
                  </IconButton>
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <th scope="row" className="sticky left-0 z-10 border-b border-line bg-surface px-3 py-2 text-left text-[13px] font-medium whitespace-nowrap text-fg-2">
                {r.label}
                {r.hint ? (
                  <Tooltip content={r.hint} className="ml-1 text-fg-3">
                    <span aria-hidden>ⓘ</span>
                    <span className="sr-only">{r.hint}</span>
                  </Tooltip>
                ) : null}
              </th>
              {cols.map(({ e }, ci) => {
                const lead = r.leaders?.indices.includes(ci);
                return (
                  <td key={e.key} className={cx('border-b border-line px-3 py-2 text-right align-middle', lead && 'bg-accent-soft')}>
                    <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
                      {r.leaders ? <LeaderMark leaders={r.leaders} i={ci} /> : null}
                      {r.cell(e, ci)}
                    </span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ timeline */

function TimelineCompare({ entries, mixed }: { entries: CompareEntry[]; mixed: boolean }) {
  const { tz } = useDataset();
  const series = useMemo(() => compareSeries(entries), [entries]);
  const states = useMemo(() => statusCounts(entries.flatMap((e) => e.daily.map((d) => d.metric)).filter((m) => m.note !== 'window_not_started')), [entries]);
  return (
    <>
      <CardHeader
        icon={<BarChart3 className="size-4" />}
        title="일별 조회 증가 비교"
        description={`${tzShort(tz)} 날짜별로 각 크리에이터 추적 영상의 조회가 늘어난 양 (선택한 비교 플랫폼 합계).`}
      />
      <div className="flex flex-col gap-2">
        <GrowthChart
          title="크리에이터별 일별 조회 증가"
          variant="line"
          height={260}
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
        <DataStateNote counts={states} label="일별 값" />
        <p className="text-xs text-fg-3">
          하한(≥) 날짜는 경계 관측이 없는 영상이 빠졌거나 진행 중인 오늘이라 실제보다 작을 수 있음. 추적 영상이 아직 없던 날은 —. Dailymotion의 원천 제공 기간값은 하루 단위로 나눌 수 없어 이 차트에 쓰지 않음.
          {mixed ? ' 여러 플랫폼이 합산된 선은 단위가 섞여 있음.' : ''}
        </p>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------------------------------ per platform */

function PlatformBreakdown({ data }: { data: CompareData }) {
  const color = new Map(data.entries.map((e, i) => [e.key, compareColor(i)]));
  if (!data.platforms.length) return <EmptyState compact title="비교할 플랫폼 데이터 없음" />;
  return (
    <div className="flex flex-col gap-4">
      {data.platforms.map((p) => {
        const rows = data.entries
          .filter((e) => e.found)
          .map((e) => ({ e, b: e.perPlatform.find((x) => x.platform === p) ?? null }))
          .filter((r) => r.b !== null);
        const views = metricLeaders(rows.map((r) => r.b!.summary.viewsInWindow));
        const eng = metricLeaders(rows.map((r) => r.b!.summary.engagementRate));
        return (
          <section key={p} aria-label={`${platformLabel(p)} 비교`}>
            <h3 className="mb-1.5 flex items-center gap-2 text-[13px] font-semibold text-fg">
              <PlatformBadge platform={p} />
              <span className="text-xs font-normal text-fg-3">
                {rows.length}명 · {data.entries.filter((e) => e.found).length - rows.length ? `${data.entries.filter((e) => e.found).length - rows.length}명은 이 플랫폼 계정 없음` : '모두 계정 있음'}
              </span>
            </h3>
            <div className="scroll-thin relative max-w-full overflow-x-auto rounded-lg border border-line">
              <table className="w-full border-separate border-spacing-0 text-sm" style={{ minWidth: 520 }}>
                <caption className="sr-only">{platformLabel(p)} 플랫폼별 비교</caption>
                <thead>
                  <tr className="text-xs text-fg-3">
                    <th scope="col" className="border-b border-line bg-surface-2 px-3 py-1.5 text-left font-medium">크리에이터</th>
                    <th scope="col" className="border-b border-line bg-surface-2 px-3 py-1.5 text-right font-medium">추적 영상</th>
                    <th scope="col" className="border-b border-line bg-surface-2 px-3 py-1.5 text-right font-medium">기간 업로드</th>
                    <th scope="col" className="border-b border-line bg-surface-2 px-3 py-1.5 text-right font-medium">기간 조회 증가</th>
                    <th scope="col" className="border-b border-line bg-surface-2 px-3 py-1.5 text-right font-medium">참여율</th>
                    <th scope="col" className="border-b border-line bg-surface-2 px-3 py-1.5 text-right font-medium">팔로워</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ e, b }, ri) => (
                    <tr key={e.key}>
                      <th scope="row" className="border-b border-line px-3 py-1.5 text-left font-medium text-fg">
                        <span className="flex items-center gap-1.5">
                          <span aria-hidden className="inline-block size-2 shrink-0 rounded-full" style={{ background: color.get(e.key) }} />
                          <span className="truncate">{e.name}</span>
                        </span>
                      </th>
                      <td className="border-b border-line px-3 py-1.5 text-right tabular">{formatInteger(b!.summary.videoCount)}</td>
                      <td className="border-b border-line px-3 py-1.5 text-right tabular">{formatInteger(b!.summary.uploadsInWindow)}</td>
                      <td className={cx('border-b border-line px-3 py-1.5 text-right', views.indices.includes(ri) && 'bg-accent-soft')}>
                        <span className="inline-flex items-center justify-end gap-1.5">
                          <LeaderMark leaders={views} i={ri} />
                          <MetricCell metric={b!.summary.viewsInWindow} label={`${platformLabel(p)} 기간 조회 증가`} />
                        </span>
                      </td>
                      <td className={cx('border-b border-line px-3 py-1.5 text-right', eng.indices.includes(ri) && 'bg-accent-soft')}>
                        <span className="inline-flex items-center justify-end gap-1.5">
                          <LeaderMark leaders={eng} i={ri} />
                          <MetricCell metric={b!.summary.engagementRate} kind="rate" label="참여율(중앙값)" />
                        </span>
                      </td>
                      <td className="border-b border-line px-3 py-1.5 text-right">
                        <FollowersCell metric={b!.followers} missingPlatforms={data.missingFollowerPlatforms.includes(p) ? [p] : []} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </div>
  );
}
