/**
 * 트렌드 (Tubular Trending): rising / falling / top topics, categories, creators and accounts by view increase
 * in the selected window vs the previous window of equal length (조회 발생 기간 기준, core computeTrending).
 * Lists show both sums, growth, contributing / incomplete video counts, a like-for-like daily sparkline and the
 * top videos of each item (-> /videos?v=id). Partial history is explained, never shown as broken UI.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { computeTrending } from '@vti/core';
import type { Platform, TrendEntityKind, TrendingResult } from '@vti/core';
import { ArrowRightLeft, Languages, TrendingDown, TrendingUp, Trophy, TriangleAlert } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  CategoryPicker,
  EmptyState,
  ErrorState,
  FilterBar,
  LoadingState,
  MultiSelect,
  PageHeader,
  PlatformPicker,
  RangePicker,
  SectionBoundary,
  SectionGrid,
  SourceNote,
  TabPanel,
  Tabs,
} from '../components/index.ts';
import { useAnalysis, useDataset, useRangeParam, useUrlState } from '../data/hooks.ts';
import { languageLabel } from '../lib/display.ts';
import { CROSS_PLATFORM_CAVEAT, orderPlatforms } from '../lib/platform.ts';
import { enumCodec, platformListCodec } from '../lib/urlState.ts';
import { tzShort } from '../lib/timezones.ts';
import { emptyReason, entityDailySeries, listedKeys, spanLabel, TREND_KIND_DESCRIPTIONS, TREND_KIND_LABELS, TREND_KINDS } from '../features/trends/logic.ts';
import type { EmptyReason, TrendLinkParams, TrendListId } from '../features/trends/logic.ts';
import { dataReadiness, isEarlyHistory, languageCounts } from '../features/trends/readiness.ts';
import type { DataReadiness } from '../features/trends/readiness.ts';
import { ReadinessCallout } from '../features/trends/ReadinessCallout.tsx';
import { TrendList } from '../features/trends/TrendList.tsx';

const kindCodec = enumCodec<TrendEntityKind>(TREND_KINDS);
const LIST_LIMIT = 20;

export default function TrendsPage() {
  const { dataset, now, tz } = useDataset();
  const { spec, range, rollingHours, setSpec } = useRangeParam('range', 'rolling7d');
  const [kind, setKind] = useUrlState<TrendEntityKind>('kind', 'topic', { codec: kindCodec });
  const [platforms, setPlatforms] = useUrlState<Platform[]>('platforms', [], { codec: platformListCodec });
  const [cats, setCats] = useUrlState<string[]>('cats', []);
  const [langs, setLangs] = useUrlState<string[]>('langs', []);

  const presentPlatforms = useMemo(() => orderPlatforms(dataset.videos.map((v) => v.platform)), [dataset]);
  const platformCounts = useMemo(() => {
    const c: Partial<Record<Platform, number>> = {};
    for (const v of dataset.videos) c[v.platform] = (c[v.platform] ?? 0) + 1;
    return c;
  }, [dataset]);
  const languageOptions = useMemo(
    () => languageCounts(dataset.videos).map((l) => ({ value: l.code, label: languageLabel(l.code), count: l.count, keywords: [l.code] })),
    [dataset],
  );
  const readiness = useMemo(() => dataReadiness(dataset), [dataset]);

  const input = useMemo(
    () => ({
      kind,
      range,
      rollingHours,
      tz,
      now,
      platforms: platforms.length ? platforms : undefined,
      categories: cats.length ? cats : undefined,
      languages: langs.length ? langs : undefined,
      limit: LIST_LIMIT,
    }),
    [kind, range, rollingHours, tz, now, platforms, cats, langs],
  );
  const trending = useAnalysis('computeTrending', input, (index, opts) => computeTrending(index, opts));
  const linkParams: TrendLinkParams = {
    range: spec,
    platforms: platforms.length ? platforms : undefined,
    cats: cats.length ? cats : undefined,
    langs: langs.length ? langs : undefined,
  };
  const mixedScope = platforms.length !== 1 && presentPlatforms.length > 1;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow="Trending"
        title="트렌드"
        description="조회 발생 기간 기준으로 선택한 기간과 직전 동일 기간의 조회 증가를 비교해 오르는·내리는 주제, 분야, 크리에이터, 계정을 보여줌. 추적 중인 영상 범위 기준이며 플랫폼 전체 순위가 아님."
      />

      <FilterBar label="트렌드 필터">
        <RangePicker value={spec} onChange={setSpec} />
        <PlatformPicker options={presentPlatforms} value={platforms} onChange={setPlatforms} counts={platformCounts} />
        <CategoryPicker value={cats} onChange={setCats} />
        {languageOptions.length > 1 ? (
          <MultiSelect label="영상 언어" options={languageOptions} value={langs} onChange={setLangs} icon={<Languages className="size-4" />} searchable />
        ) : null}
        <ComparisonLine result={trending.data} rollingHours={rollingHours} />
      </FilterBar>

      <Tabs<TrendEntityKind>
        idBase="trend-kind"
        label="트렌드 단위"
        value={kind}
        onChange={setKind}
        tabs={TREND_KINDS.map((k) => ({ id: k, label: TREND_KIND_LABELS[k] }))}
      />

      <TabPanel idBase="trend-kind" id={kind} className="flex flex-col gap-4">
        <p className="text-[13px] text-fg-3">{TREND_KIND_DESCRIPTIONS[kind]}</p>
        <SectionBoundary title="트렌드를 계산하지 못함" resetKey={`${kind}|${spec}|${platforms.join()}|${cats.join()}|${langs.join()}`}>
          {trending.error ? (
            <Card>
              <ErrorState title="트렌드를 계산하지 못함" error={trending.error} />
            </Card>
          ) : !trending.data ? (
            <Card>
              <LoadingState rows={6} />
            </Card>
          ) : (
            <TrendBody
              result={trending.data}
              stale={trending.isStale}
              kind={kind}
              spec={spec}
              linkParams={linkParams}
              readiness={readiness}
              mixedScope={mixedScope}
              onSpec={setSpec}
              filters={input}
            />
          )}
        </SectionBoundary>
      </TabPanel>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ comparison line */

function ComparisonLine({ result, rollingHours }: { result: TrendingResult | undefined; rollingHours: number | null }) {
  const { now, tz } = useDataset();
  if (!result) return <p className="w-full text-xs text-fg-3">비교 기간 계산 중</p>;
  const w = result.window;
  const pw = result.previousWindow;
  return (
    <p className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-3">
      <ArrowRightLeft className="size-3.5 shrink-0" aria-hidden />
      <span>
        <span className="font-medium text-fg-2">이번 기간</span> {spanLabel(w.startMs, Math.min(w.endMs, now), tz)}
      </span>
      <span aria-hidden>vs</span>
      <span>
        <span className="font-medium text-fg-2">직전 동일 기간</span> {spanLabel(pw.startMs, pw.endMs, tz)}
      </span>
      <span>
        ({tzShort(tz)}
        {rollingHours ? `, 데이터 기준 시각까지 롤링 ${rollingHours}시간` : ', 날짜 기준'})
      </span>
      {w.incomplete ? (
        <Badge tone="warning" title="기간이 끝나지 않아 직전 기간도 같은 경과 시간까지만 잘라 비교함">
          진행 중인 기간 · 같은 경과 시간끼리 비교
        </Badge>
      ) : null}
    </p>
  );
}

/* ------------------------------------------------------------------------------------------ body */

interface BodyProps {
  result: TrendingResult;
  stale: boolean;
  kind: TrendEntityKind;
  spec: string;
  linkParams: TrendLinkParams;
  readiness: DataReadiness;
  mixedScope: boolean;
  onSpec: (spec: string) => void;
  filters: { platforms?: Platform[]; categories?: string[]; languages?: string[]; tz: string; now: number };
}

function TrendBody({ result, stale, kind, spec, linkParams, readiness, mixedScope, onSpec, filters }: BodyProps) {
  const { now, tz } = useDataset();
  const [openKey, setOpenKey] = useState<string | null>(null);
  const keys = useMemo(() => listedKeys(result), [result]);
  const dailyInput = useMemo(
    () => ({
      kind,
      keys,
      startMs: result.window.startMs,
      endMs: result.window.endMs,
      tz: filters.tz,
      now: filters.now,
      platforms: filters.platforms,
      categories: filters.categories,
      languages: filters.languages,
    }),
    [kind, keys, result, filters],
  );
  const daily = useAnalysis('trends.entityDailySeries', dailyInput, (index, i) => entityDailySeries(index, i));
  const reason = emptyReason(result, readiness);
  const toggle = (k: string) => setOpenKey((cur) => (cur === k ? null : k));
  const showCallout = isEarlyHistory(readiness) || reason !== 'none';

  const listProps = { result, kind, daily: daily.data, openKey, onToggle: toggle, linkParams, stale };
  const firstObs = readiness.firstObservationAt;

  return (
    <div className="flex flex-col gap-4">
      {showCallout ? (
        <ReadinessCallout readiness={readiness}>
          {reason === 'no_history' || reason === 'window_before_collection' ? (
            <p>
              직전 동일 기간({spanLabel(result.previousWindow.startMs, result.previousWindow.endMs, tz)})이 첫 관측보다 앞서 직전 증가량을 계산할 수 있는 영상이 적음. 지금은
              그 뒤에 게시된 영상(게시 시점 0회에서 관측값까지 보간)과 원천이 기간 조회수를 직접 주는 영상(Dailymotion)만 비교됨. 상승·하락 목록이 비어 있으면 '상위'
              목록을 보거나 더 짧은 기간을 고를 것.
            </p>
          ) : (
            <p>영상마다 관측이 적어 기간 경계 값이 하한이거나 계산 불가인 경우가 많음. 그런 영상은 합계에서 빼고 항목별 '불완전' 수로 표시함.</p>
          )}
        </ReadinessCallout>
      ) : null}

      {mixedScope ? (
        <p className="flex items-start gap-1.5 text-xs text-fg-3">
          <TriangleAlert className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
          <span>
            여러 플랫폼 영상을 합산한 결과임. {CROSS_PLATFORM_CAVEAT} 플랫폼 필터로 하나를 고르면 같은 단위끼리 비교됨.
          </span>
        </p>
      ) : null}

      <SectionGrid>
        <Card className="lg:col-span-6" flush>
          <div className="p-4 pb-2 sm:p-5 sm:pb-2">
            <CardHeader
              icon={<TrendingUp className="size-4" />}
              title={`상승 ${TREND_KIND_LABELS[kind]}`}
              description="직전 동일 기간 대비 조회 증가율이 큰 순. 작은 기준값의 과장을 막기 위해 증가량 하한을 둠."
            />
          </div>
          <TrendList
            list="rising"
            items={result.rising}
            {...listProps}
            empty={<ListEmpty which="rising" reason={reason} spec={spec} onSpec={onSpec} firstObs={firstObs} />}
          />
        </Card>
        <Card className="lg:col-span-6" flush>
          <div className="p-4 pb-2 sm:p-5 sm:pb-2">
            <CardHeader
              icon={<TrendingDown className="size-4" />}
              title={`하락 ${TREND_KIND_LABELS[kind]}`}
              description="직전 동일 기간보다 조회 증가가 줄어든 순. 조회수 감소(삭제·정정)는 음수 인기로 세지 않음."
            />
          </div>
          <TrendList
            list="falling"
            items={result.falling}
            {...listProps}
            empty={<ListEmpty which="falling" reason={reason} spec={spec} onSpec={onSpec} firstObs={firstObs} />}
          />
        </Card>
        <Card className="lg:col-span-12" flush>
          <div className="p-4 pb-2 sm:p-5 sm:pb-2">
            <CardHeader
              icon={<Trophy className="size-4" />}
              title={`상위 ${TREND_KIND_LABELS[kind]}`}
              description="이번 기간 조회 증가 합계가 큰 순. 직전 기간 값이 0인 새 항목도 포함."
            />
          </div>
          <TrendList
            list="top"
            items={result.top}
            {...listProps}
            empty={<ListEmpty which="top" reason={reason} spec={spec} onSpec={onSpec} firstObs={firstObs} />}
          />
        </Card>
      </SectionGrid>

      <SourceNote asOf={now} window={result.window} notes={result.notes}>
        <p>
          비교 방식: 같은 영상 집합으로 이번 기간과 직전 동일 기간(같은 길이, 바로 앞 기간)의 조회 증가를 각각 합산해 증가율 = 이번 / 직전 − 1로 계산함. 합계 옆 ≥ 표시는
          경계 관측이 부족해 빠진 영상이 있어 실제 합계가 더 클 수 있다는 뜻.{' '}
          <Link to="/coverage" className="focus-ring rounded-sm text-accent-text hover:underline">
            지표 정의
          </Link>
        </p>
      </SourceNote>
    </div>
  );
}

function ListEmpty({
  which,
  reason,
  spec,
  onSpec,
  firstObs,
}: {
  which: TrendListId;
  reason: EmptyReason;
  spec: string;
  onSpec: (s: string) => void;
  firstObs: number | null;
}) {
  const noHistory = reason === 'no_history' || reason === 'window_before_collection';
  const suggest = noHistory && spec !== 'rolling24h' ? (
    <Button size="sm" onClick={() => onSpec('rolling24h')}>
      최근 24시간으로 보기
    </Button>
  ) : null;
  if (which === 'top') {
    return (
      <EmptyState
        compact
        title="조회 증가를 계산할 수 있는 항목 없음"
        description={
          reason === 'window_before_collection'
            ? '선택한 기간이 첫 관측보다 앞서 기간 조회 증가를 계산할 수 없음.'
            : '항목당 합산 영상이 3개 이상이어야 표시됨. 필터를 넓히거나 기간을 바꿔 볼 것.'
        }
        action={suggest}
      />
    );
  }
  return (
    <EmptyState
      compact
      title={which === 'rising' ? '상승 항목 없음' : '하락 항목 없음'}
      description={
        noHistory
          ? `직전 동일 기간의 관측이 아직 부족해 증가율을 비교할 수 있는 항목이 없음${firstObs !== null ? ' (첫 관측 이후 기록이 쌓이면 채워짐)' : ''}. 이번 기간 합계는 '상위' 목록에서 볼 수 있음.`
          : which === 'rising'
            ? '직전 기간보다 조회 증가가 늘어난 항목이 없거나, 합산 영상 3개·최소 증가량 조건을 넘는 항목이 없음.'
            : '직전 기간보다 조회 증가가 줄어든 항목이 없거나, 합산 영상 3개·최소 증가량 조건을 넘는 항목이 없음.'
      }
      action={suggest}
    />
  );
}
