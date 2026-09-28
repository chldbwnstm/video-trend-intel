/**
 * 기회 탐색 (Tubular Viewpoint Explore): topics with high demand (median latest views of videos uploaded in the
 * window) and low supply (uploads in OUR tracked set), per platform (core computeOpportunities). Scatter of
 * supply vs demand percentiles with quadrants, a ranked table (the chart's table twin) and the selected
 * topic's sample videos. States clearly that supply only counts the tracked set.
 */
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { computeOpportunities } from '@vti/core';
import type { OpportunityItem, Platform, UtcWindow } from '@vti/core';
import { ArrowRight, ChartScatter, Compass, Database, Languages, ListOrdered, Target } from 'lucide-react';
import {
  Badge,
  Card,
  CardHeader,
  CategoryPicker,
  DataTable,
  EmptyState,
  ErrorState,
  FilterBar,
  LoadingState,
  MetricCell,
  MultiSelect,
  PageHeader,
  Pager,
  PlatformBadge,
  RangePicker,
  SectionBoundary,
  SectionGrid,
  SegmentedControl,
  Select,
  SourceNote,
  VideoThumb,
  clampPage,
} from '../components/index.ts';
import type { Column, Tone } from '../components/index.ts';
import { useAnalysis, useDataset, useRangeParam, useUrlState } from '../data/hooks.ts';
import { fmtTime, languageLabel } from '../lib/display.ts';
import { formatInteger } from '../lib/format.ts';
import { orderPlatforms, platformLabel } from '../lib/platform.ts';
import { hrefWith, intCodec, intEnumCodec, platformListCodec } from '../lib/urlState.ts';
import { tzShort } from '../lib/timezones.ts';
import {
  defaultExplorePlatform,
  demandMetric,
  demandProvenance,
  exploreNotes,
  exploreSummary,
  QUADRANT_LABELS,
  QUADRANT_SHORT,
  quadrantCounts,
  quadrantOf,
  sampleRows,
} from '../features/explore/logic.ts';
import type { DemandProvenance, Quadrant } from '../features/explore/logic.ts';
import { OpportunityScatter } from '../features/explore/OpportunityScatter.tsx';
import { languageCounts } from '../features/trends/readiness.ts';
import { spanLabel } from '../features/trends/logic.ts';

const MIN_SUPPLY_OPTIONS = [3, 5, 10, 20] as const;
type MinSupply = (typeof MIN_SUPPLY_OPTIONS)[number];
const minCodec = intEnumCodec<MinSupply>(MIN_SUPPLY_OPTIONS);
const PAGE_SIZE = 50;
/** computeOpportunities limit: effectively all eligible topics (the scatter must not show only the top). */
const ALL_TOPICS = 5000;

const QUADRANT_TONE: Record<Quadrant, Tone> = { opportunity: 'accent', competitive: 'neutral', niche: 'neutral', saturated: 'neutral' };

export default function ExplorePage() {
  const { dataset, now, tz } = useDataset();
  const { spec, range, rollingHours, setSpec } = useRangeParam('range', 'rolling30d', { resets: ['page', 'topic'] });
  const [platforms, setPlatforms] = useUrlState<Platform[]>('platforms', [], { codec: platformListCodec, resets: ['page', 'topic'] });
  const [cats, setCats] = useUrlState<string[]>('cats', [], { resets: ['page', 'topic'] });
  const [langs, setLangs] = useUrlState<string[]>('langs', [], { resets: ['page', 'topic'] });
  const [minSupply, setMinSupply] = useUrlState<MinSupply>('min', 3, { codec: minCodec, resets: ['page', 'topic'] });
  const [page, setPage] = useUrlState<number>('page', 1, { codec: intCodec });
  const [topic, setTopic] = useUrlState<string>('topic', '');

  const presentPlatforms = useMemo(() => orderPlatforms(dataset.videos.map((v) => v.platform)), [dataset]);
  const languageOptions = useMemo(
    () => languageCounts(dataset.videos).map((l) => ({ value: l.code, label: languageLabel(l.code), count: l.count, keywords: [l.code] })),
    [dataset],
  );

  const scope = useMemo(
    () => ({ range, rollingHours, tz, now, categories: cats.length ? cats : undefined, languages: langs.length ? langs : undefined }),
    [range, rollingHours, tz, now, cats, langs],
  );
  const summary = useAnalysis('explore.summary', scope, (index, s) => exploreSummary(index, s));
  const auto = summary.data ? defaultExplorePlatform(summary.data) : null;
  const platform: Platform | null = platforms[0] ?? auto ?? presentPlatforms[0] ?? null;
  const uploadsBy = new Map((summary.data?.platforms ?? []).map((p) => [p.platform, p.uploads] as const));

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow="Viewpoint Explore"
        title="기회 탐색"
        description="기간에 올라온 영상 기준으로 영상당 조회(수요)는 높은데 업로드(공급)는 적은 주제를 찾음. 플랫폼마다 조회 단위가 달라 한 플랫폼씩 계산함."
      />

      <FilterBar label="기회 탐색 필터">
        {presentPlatforms.length ? (
          <SegmentedControl<Platform>
            label="플랫폼 (하나 선택)"
            value={platform ?? presentPlatforms[0]}
            onChange={(p) => setPlatforms([p])}
            options={presentPlatforms.map((p) => ({
              value: p,
              label: (
                <span className="inline-flex items-center gap-1.5">
                  {platformLabel(p)}
                  <span className="text-xs text-fg-3 tabular">{formatInteger(uploadsBy.get(p) ?? 0)}</span>
                </span>
              ),
              title: `${platformLabel(p)}: 기간 업로드 ${formatInteger(uploadsBy.get(p) ?? 0)}개`,
            }))}
          />
        ) : null}
        <RangePicker value={spec} onChange={setSpec} />
        <CategoryPicker value={cats} onChange={setCats} />
        {languageOptions.length > 1 ? (
          <MultiSelect label="영상 언어" options={languageOptions} value={langs} onChange={setLangs} icon={<Languages className="size-4" />} searchable />
        ) : null}
        <Select<string>
          label="최소 영상 수"
          hideLabel={false}
          size="sm"
          value={String(minSupply)}
          onChange={(v) => setMinSupply(Number(v) as MinSupply)}
          options={MIN_SUPPLY_OPTIONS.map((n) => ({ value: String(n), label: `${n}개 이상` }))}
        />
        <p className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-3">
          <span>
            <span className="font-medium text-fg-2">업로드 기간 기준:</span>{' '}
            {summary.data ? spanLabel(summary.data.window.startMs, Math.min(summary.data.window.endMs, now), tz) : '계산 중'} 게시 영상
          </span>
          {!platforms.length && auto ? <span>· 플랫폼 자동 선택: 기간 업로드가 가장 많은 {platformLabel(auto)}</span> : null}
          {platforms.length > 1 ? <span className="text-warning">· 한 플랫폼씩 계산함: 첫 번째 선택({platformLabel(platforms[0])})만 사용</span> : null}
          <span>
            · 데이터 기준 {fmtTime(now, tz)} {tzShort(tz)}
          </span>
        </p>
      </FilterBar>

      <TrackedSetNote platform={platform} />

      {summary.error ? (
        <Card>
          <ErrorState title="기간 업로드를 계산하지 못함" error={summary.error} />
        </Card>
      ) : !platform ? (
        <Card>
          <EmptyState title="추적 중인 영상 없음" description="데이터셋에 영상이 없어 기회 탐색을 할 수 없음." />
        </Card>
      ) : (
        <SectionBoundary title="기회 탐색을 계산하지 못함" resetKey={`${platform}|${spec}|${cats.join()}|${langs.join()}|${minSupply}`}>
          <ExploreBody
            platform={platform}
            scope={scope}
            minSupply={minSupply}
            spec={spec}
            page={page}
            setPage={setPage}
            topic={topic}
            setTopic={setTopic}
            windowLabel={summary.data ? spanLabel(summary.data.window.startMs, Math.min(summary.data.window.endMs, now), tz) : ''}
            window={summary.data?.window ?? null}
          />
        </SectionBoundary>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ tracked set note */

function TrackedSetNote({ platform }: { platform: Platform | null }) {
  const { dataset } = useDataset();
  const sources = platform ? dataset.coverage.filter((c) => c.platform === platform && c.enabled) : [];
  return (
    <aside aria-label="공급을 센 영상 집합" className="flex items-start gap-3 rounded-xl border border-line bg-surface px-4 py-3 text-[13px] text-fg-2 shadow-card">
      <Database className="mt-0.5 size-4 shrink-0 text-fg-3" aria-hidden />
      <div className="flex min-w-0 flex-col gap-1">
        <p>
          <span className="font-semibold text-fg">공급은 우리가 추적하는 영상 집합 안에서만 센 업로드 수임.</span> 플랫폼 전체 업로드 수가 아니며, 수집 방식(시드 채널·검색 시드)에
          따라 달라짐. 공급이 적게 보이는 주제는 실제로 경쟁이 적을 수도, 우리가 덜 수집했을 수도 있음.
        </p>
        {sources.length ? (
          <ul className="text-xs text-fg-3">
            {sources.map((s) => (
              <li key={s.source}>
                {platform ? platformLabel(platform) : ''} 수집: {s.discovery}
              </li>
            ))}
          </ul>
        ) : null}
        <Link to="/coverage" className="focus-ring w-fit rounded-sm text-accent-text hover:underline">
          데이터 범위·수집 방식 보기
        </Link>
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------------------------------ body */

interface BodyProps {
  platform: Platform;
  scope: { range: { start: string; end: string }; rollingHours: number | null; tz: string; now: number; categories?: string[]; languages?: string[] };
  minSupply: MinSupply;
  spec: string;
  page: number;
  setPage: (p: number) => void;
  topic: string;
  setTopic: (t: string) => void;
  windowLabel: string;
  window: UtcWindow | null;
}

function ExploreBody({ platform, scope, minSupply, spec, page, setPage, topic, setTopic, windowLabel, window }: BodyProps) {
  const { now } = useDataset();
  const oppInput = useMemo(() => ({ ...scope, platform, minSupply, limit: ALL_TOPICS }), [scope, platform, minSupply]);
  const opps = useAnalysis('computeOpportunities', oppInput, (index, o) => computeOpportunities(index, o));
  const provInput = useMemo(() => ({ ...scope, platform }), [scope, platform]);
  const prov = useAnalysis('explore.demandProvenance', provInput, (index, i) => demandProvenance(index, i));

  if (opps.error) {
    return (
      <Card>
        <ErrorState title="기회 탐색을 계산하지 못함" error={opps.error} />
      </Card>
    );
  }
  const items = opps.data;
  if (!items) {
    return (
      <Card>
        <LoadingState rows={6} />
      </Card>
    );
  }
  const notes = exploreNotes({ items, prov: prov.data, platformLabel: platformLabel(platform), windowLabel, minSupply });
  const selectedItem = items.find((i) => i.topic === topic) ?? items[0] ?? null;
  const counts = quadrantCounts(items);

  if (!items.length) {
    return (
      <>
        <Card>
          <EmptyState
            icon={<Compass className="size-8" />}
            title="비교할 주제가 없음"
            description={
              prov.data && prov.data.uploads === 0
                ? `이 기간에 게시된 ${platformLabel(platform)} 추적 영상이 없음. 기간을 늘리거나 다른 플랫폼을 고를 것.`
                : `조회값이 있는 영상이 ${minSupply}개 이상인 주제가 없음. 최소 영상 수를 낮추거나 기간을 늘려 볼 것.`
            }
          />
        </Card>
        <SourceNote asOf={now} window={window} notes={notes} />
      </>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <SectionGrid>
        <Card className="lg:col-span-8">
          <CardHeader
            icon={<ChartScatter className="size-4" />}
            title="수요·공급 지도"
            description={`${platformLabel(platform)} 주제별 수요 백분위(세로)와 공급 백분위(가로). 왼쪽 위가 영상당 조회는 높고 업로드는 적은 기회 영역.`}
          />
          <div className={opps.isStale ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
            <OpportunityScatter items={items} selected={selectedItem?.topic ?? null} onSelect={setTopic} platformLabel={platformLabel(platform)} />
          </div>
          <ul className="mt-3 flex flex-wrap gap-2 text-xs" aria-label="사분면별 주제 수">
            {(Object.keys(QUADRANT_LABELS) as Quadrant[]).map((q) => (
              <li key={q}>
                <Badge tone={QUADRANT_TONE[q]}>
                  {QUADRANT_LABELS[q]} {formatInteger(counts[q])}
                </Badge>
              </li>
            ))}
          </ul>
        </Card>
        <Card className="lg:col-span-4">
          <CardHeader icon={<Target className="size-4" />} title="선택 주제" description="지도나 표에서 주제를 고르면 대표 영상을 보여줌." />
          {selectedItem ? <SelectedTopic item={selectedItem} platform={platform} prov={prov.data} spec={spec} /> : null}
        </Card>
      </SectionGrid>

      <Card flush>
        <div className="p-4 pb-2 sm:p-5 sm:pb-2">
          <CardHeader
            icon={<ListOrdered className="size-4" />}
            title="기회 점수 순위"
            description="기회 점수 = 수요 백분위 − 공급 백분위. 점수가 같으면 수요가 큰 순. 지도의 표 버전."
          />
        </div>
        <OpportunityTable
          items={items}
          prov={prov.data}
          selected={selectedItem?.topic ?? null}
          onSelect={setTopic}
          page={page}
          setPage={setPage}
          stale={opps.isStale}
        />
      </Card>

      <SourceNote asOf={now} window={window} notes={notes} />
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ table */

function OpportunityTable({
  items,
  prov,
  selected,
  onSelect,
  page,
  setPage,
  stale,
}: {
  items: OpportunityItem[];
  prov: DemandProvenance | undefined;
  selected: string | null;
  onSelect: (t: string) => void;
  page: number;
  setPage: (p: number) => void;
  stale: boolean;
}) {
  const { now, index } = useDataset();
  const current = clampPage(page, items.length, PAGE_SIZE);
  const offset = (current - 1) * PAGE_SIZE;
  const rows = items.slice(offset, offset + PAGE_SIZE);
  const columns: Column<OpportunityItem>[] = [
    {
      id: 'rank',
      header: '#',
      width: '3rem',
      align: 'right',
      cell: (_r, i) => <span className="text-xs whitespace-nowrap text-fg-3 tabular">{offset + i + 1}</span>,
    },
    {
      id: 'topic',
      header: '주제',
      cell: (r) => {
        const on = r.topic === selected;
        const q = quadrantOf(r);
        return (
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <button
              type="button"
              aria-pressed={on}
              onClick={(e) => {
                e.stopPropagation();
                onSelect(r.topic);
              }}
              className={`focus-ring max-w-[14rem] truncate rounded-sm text-left text-sm font-medium hover:underline ${on ? 'text-accent-text' : 'text-fg'}`}
              title={`#${r.label} 선택`}
            >
              #{r.label}
            </button>
            <Badge tone={QUADRANT_TONE[q]} className="text-[11px]">
              {QUADRANT_SHORT[q]}
            </Badge>
          </div>
        );
      },
    },
    {
      id: 'demand',
      header: '수요',
      align: 'right',
      width: '7rem',
      hint: '주제 영상의 데이터 기준 시각 누적 조회 중앙값(영상당 조회). ≥ = 하한값 영상 포함.',
      cell: (r) => <MetricCell metric={demandMetric(r, prov, now)} label="수요(누적 조회 중앙값)" />,
    },
    {
      id: 'supply',
      header: '공급',
      align: 'right',
      width: '5rem',
      hint: '기간에 올라온 추적 영상 중 이 주제 영상 수(플랫폼 전체가 아님).',
      cell: (r) => <span className="tabular">{formatInteger(r.supply)}개</span>,
    },
    {
      id: 'dp',
      header: '수요 백분위',
      align: 'right',
      width: '6.5rem',
      hideBelow: 'md',
      cell: (r) => <MetricCell metric={{ ...demandMetric(r, prov, now), value: r.demandPercentile, note: null }} kind="number" label="수요 백분위" />,
    },
    {
      id: 'sp',
      header: '공급 백분위',
      align: 'right',
      width: '6.5rem',
      hideBelow: 'md',
      cell: (r) => <MetricCell metric={{ value: r.supplyPercentile, status: 'exact', asOf: now, note: null }} kind="number" label="공급 백분위" />,
    },
    {
      id: 'score',
      header: '기회 점수',
      align: 'right',
      width: '6rem',
      hideBelow: 'sm',
      hint: '수요 백분위 − 공급 백분위(−100~100). 높을수록 영상당 조회는 많고 업로드는 적음.',
      cell: (r) => (
        <MetricCell
          metric={{ ...demandMetric(r, prov, now), value: r.score, note: null }}
          kind="number"
          label="기회 점수"
          extra="표시된 주제 안에서의 상대 위치로 계산한 점수."
        />
      ),
    },
    {
      id: 'sample',
      header: '대표 영상',
      hideBelow: 'lg',
      cell: (r) => {
        const v = r.sampleVideoIds[0] ? index.videosById.get(r.sampleVideoIds[0]) : undefined;
        return v ? (
          <Link to={hrefWith('/videos', { v: v.id })} className="focus-ring line-clamp-1 max-w-[18rem] rounded-sm text-xs text-fg-2 hover:text-accent-text hover:underline" title={v.title}>
            {v.title || '(제목 없음)'}
          </Link>
        ) : (
          <span className="text-xs text-fg-3">—</span>
        );
      },
    },
  ];
  return (
    <div>
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.topic}
        caption="주제별 기회 점수 순위"
        stale={stale}
        minWidth="300px"
        selectedKey={selected}
        onRowClick={(r) => onSelect(r.topic)}
      />
      <div className="px-4 py-3 sm:px-5">
        <Pager page={current} pageSize={PAGE_SIZE} total={items.length} onChange={setPage} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ selected topic */

function SelectedTopic({ item, platform, prov, spec }: { item: OpportunityItem; platform: Platform; prov: DemandProvenance | undefined; spec: string }) {
  const { now, tz } = useDataset();
  const samples = useAnalysis('explore.sampleRows', { ids: item.sampleVideoIds, now }, (index, i) => sampleRows(index, i));
  const q = quadrantOf(item);
  const info = prov?.byTopic[item.topic];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 truncate text-base font-semibold text-fg" title={item.label}>
          #{item.label}
        </p>
        <Badge tone={QUADRANT_TONE[q]}>{QUADRANT_LABELS[q]}</Badge>
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[13px]">
        <dt className="text-fg-3">수요(누적 조회 중앙값)</dt>
        <dd className="text-right">
          <MetricCell metric={demandMetric(item, prov, now)} label="수요" />
        </dd>
        <dt className="text-fg-3">공급(추적 업로드)</dt>
        <dd className="text-right tabular">{formatInteger(item.supply)}개</dd>
        <dt className="text-fg-3">수요 백분위</dt>
        <dd className="text-right">
          <MetricCell metric={{ ...demandMetric(item, prov, now), value: item.demandPercentile, note: null }} kind="number" label="수요 백분위" />
        </dd>
        <dt className="text-fg-3">공급 백분위</dt>
        <dd className="text-right">
          <MetricCell metric={{ value: item.supplyPercentile, status: 'exact', asOf: now, note: null }} kind="number" label="공급 백분위" />
        </dd>
        <dt className="text-fg-3">기회 점수</dt>
        <dd className="text-right font-semibold">
          <MetricCell
            metric={{ ...demandMetric(item, prov, now), value: item.score, note: null }}
            kind="number"
            label="기회 점수"
            extra="수요 백분위 − 공급 백분위. 표시된 주제 안에서의 상대 위치."
          />
        </dd>
      </dl>
      {info ? (
        <p className="text-xs text-fg-3">
          조회값 있는 영상 {formatInteger(info.valued)}개{info.lowerBound ? ` 중 ${formatInteger(info.lowerBound)}개는 하한값(마지막 관측 기준)` : ''}.
        </p>
      ) : null}
      <div>
        <p className="mb-1 text-xs font-medium text-fg-2">조회가 많은 대표 영상</p>
        {samples.error ? (
          <ErrorState compact title="대표 영상을 불러오지 못함" error={samples.error} />
        ) : !samples.data ? (
          <LoadingState rows={2} />
        ) : (
          <ul className="flex flex-col gap-2">
            {samples.data.map((s) => (
              <li key={s.video.id} className="flex min-w-0 items-center gap-2">
                <VideoThumb video={s.video} size="xs" />
                <div className="min-w-0 flex-1">
                  <Link
                    to={hrefWith('/videos', { v: s.video.id })}
                    className="focus-ring line-clamp-1 rounded-sm text-[13px] font-medium text-fg hover:text-accent-text hover:underline"
                    title={s.video.title}
                  >
                    {s.video.title || '(제목 없음)'}
                  </Link>
                  <p className="flex min-w-0 items-center gap-1.5 text-[11px] text-fg-3">
                    <PlatformBadge platform={s.video.platform} size="xs" iconOnly />
                    <span className="truncate">{s.accountName ?? s.video.accountId}</span>
                    <span aria-hidden>·</span>
                    <span className="shrink-0 tabular">게시 {fmtTime(s.video.publishedAt, tz, 'date')}</span>
                  </p>
                </div>
                <MetricCell metric={s.views} label="누적 조회" />
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <Link
          to={hrefWith('/videos', { mode: 'upload', sort: 'views_total', range: spec, platforms: [platform], topics: [item.topic] })}
          className="focus-ring inline-flex w-fit items-center gap-1 rounded-sm text-[13px] font-medium text-accent-text hover:underline"
        >
          이 주제 영상 모두 보기 <ArrowRight className="size-3.5" aria-hidden />
        </Link>
        <Link
          to={hrefWith('/trends', { kind: 'topic', range: spec, platforms: [platform] })}
          className="focus-ring inline-flex w-fit items-center gap-1 rounded-sm text-[13px] font-medium text-accent-text hover:underline"
        >
          주제 트렌드 보기 <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      </div>
    </div>
  );
}
