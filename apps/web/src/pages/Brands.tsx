/**
 * 브랜드 협업 (DealMaker-lite): videos with paid-promotion disclosures ('광고 표기') or promo cues ('협찬 추정'),
 * a brand leaderboard (videos, creators, summed period views with provenance), a brand detail drawer (creators,
 * videos, evidence snippets) and a creator -> brands view.
 *
 * Detection is core `detectSponsorship` over public title / description / tags text. It is not contract data;
 * the page says so up front and shows the detector version.
 */
import { useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { SPONSORSHIP_VERSION } from '@vti/core';
import type { Platform, VideoRow } from '@vti/core';
import { ArrowRight, BadgeCheck, Eye, Handshake, Info, Megaphone, Tags, TriangleAlert, Users } from 'lucide-react';
import {
  Badge,
  Card,
  CategoryPicker,
  clampPage,
  DateModePicker,
  Drawer,
  EmptyState,
  ErrorState,
  ExportCsvButton,
  FilterBar,
  KpiGrid,
  KpiTile,
  LoadingState,
  MetricCell,
  PageHeader,
  Pager,
  PlatformPicker,
  RangePicker,
  SearchInput,
  SectionBoundary,
  SegmentedControl,
  SourceNote,
  TabPanel,
  Tabs,
  toCsv,
} from '../components/index.ts';
import type { SortDir } from '../components/index.ts';
import { useAnalysis, useDataset, useRangeParam, useUrlState } from '../data/hooks.ts';
import { fmtTime } from '../lib/display.ts';
import { formatInteger } from '../lib/format.ts';
import { orderPlatforms } from '../lib/platform.ts';
import { dirCodec, enumCodec, hrefWith, intCodec, platformListCodec } from '../lib/urlState.ts';
import { cx } from '../lib/cx.ts';
import {
  BRAND_DATE_MODES,
  BRAND_SORTS,
  brandCsvRows,
  buildBrandReport,
  LEVEL_DESCRIPTIONS,
  sortBrands,
  SPONSOR_LEVELS,
} from '../features/brands/brandsModel.ts';
import type { BrandDateMode, BrandReport, BrandSort, SponsorLevelFilter } from '../features/brands/brandsModel.ts';
import {
  BrandDetail,
  BrandTable,
  CreatorBrandTable,
  MixedPlatformNote,
  PlatformSums,
  SponsoredVideoTable,
  SUM_EXTRA,
} from '../features/brands/BrandParts.tsx';

type Tab = 'brands' | 'videos' | 'creators';
const TABS: Tab[] = ['brands', 'videos', 'creators'];
const PAGE_SIZE = 50;

const LEVEL_OPTIONS: { value: SponsorLevelFilter; label: string; title: string }[] = [
  { value: 'any', label: '전체', title: '광고 표기 + 협찬 추정' },
  { value: 'disclosed', label: '광고 표기', title: LEVEL_DESCRIPTIONS.disclosed },
  { value: 'likely', label: '협찬 추정', title: LEVEL_DESCRIPTIONS.likely },
];

const PERIOD_LABEL: Record<BrandDateMode, string> = {
  upload: '게시 후 조회',
  activity: '기간 조회 증가',
};

export default function BrandsPage() {
  const { dataset, now, tz } = useDataset();
  const { spec, range, rollingHours, setSpec } = useRangeParam('range', 'rolling30d', { resets: ['page'] });
  const [mode, setMode] = useUrlState<BrandDateMode>('mode', 'upload', { codec: enumCodec(BRAND_DATE_MODES), resets: ['page'] });
  const [level, setLevel] = useUrlState<SponsorLevelFilter>('sponsored', 'any', { codec: enumCodec(SPONSOR_LEVELS), resets: ['page'] });
  const [platforms, setPlatforms] = useUrlState<Platform[]>('platforms', [], { codec: platformListCodec, resets: ['page'] });
  const [cats, setCats] = useUrlState<string[]>('cats', [], { resets: ['page'] });
  const [q, setQ] = useUrlState<string>('q', '', { resets: ['page'] });
  const [tab, setTab] = useUrlState<Tab>('tab', 'brands', { codec: enumCodec(TABS) });
  const [brand, setBrand] = useUrlState<string>('brand', '');
  const [sort, setSort] = useUrlState<BrandSort>('sort', 'views', { codec: enumCodec(BRAND_SORTS) });
  const [dir, setDir] = useUrlState<SortDir>('dir', 'desc', { codec: dirCodec });
  const [page, setPage] = useUrlState<number>('page', 1, { codec: intCodec });

  const presentPlatforms = useMemo(() => orderPlatforms(dataset.videos.map((v) => v.platform)), [dataset]);
  const sponsoredCounts = useMemo(() => {
    const c: Partial<Record<Platform, number>> = {};
    for (const v of dataset.videos) if (v.sponsorship) c[v.platform] = (c[v.platform] ?? 0) + 1;
    return c;
  }, [dataset]);

  const input = useMemo(
    () => ({ mode, range, rollingHours, tz, now, platforms, categories: cats, level, q: q.trim() }),
    [mode, range, rollingHours, tz, now, platforms, cats, level, q],
  );
  const report = useAnalysis('brands.report', input, (index, i) => buildBrandReport(index, i));
  const periodLabel = PERIOD_LABEL[mode];

  const openBrand = useCallback((name: string) => setBrand(name), [setBrand]);
  const closeBrand = useCallback(() => setBrand(''), [setBrand]);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow="DealMaker (lite)"
        title="브랜드 협업"
        description="광고 표기·협찬 추정 영상을 브랜드와 크리에이터별로 묶어 봄. 공개 텍스트에서 찾은 신호이며 계약·집행 데이터가 아님. 추적 중인 영상 범위 기준."
        actions={
          <ExportCsvButton
            label="브랜드 CSV"
            filename="brands"
            disabled={!report.data || report.data.brands.length === 0}
            getCsv={() => (report.data ? toCsv(brandCsvRows(report.data, (ms) => fmtTime(ms, tz))) : toCsv([]))}
          />
        }
      />

      <DetectionCaveat versions={report.data?.versions ?? []} />

      <FilterBar label="브랜드 협업 필터">
        <RangePicker value={spec} onChange={setSpec} />
        <SegmentedControl<SponsorLevelFilter>
          label="협찬 신호 종류"
          value={level}
          onChange={setLevel}
          size="sm"
          options={LEVEL_OPTIONS}
        />
        <PlatformPicker options={presentPlatforms} value={platforms} onChange={setPlatforms} counts={sponsoredCounts} />
        <CategoryPicker value={cats} onChange={setCats} />
        <SearchInput value={q} onChange={setQ} placeholder="브랜드·제목·채널 검색" label="브랜드·제목·채널 검색" className="w-full sm:w-60" />
        <DateModePicker
          value={mode}
          onChange={(m) => setMode(m === 'activity' ? 'activity' : 'upload')}
          modes={[...BRAND_DATE_MODES]}
          showExample={false}
          className="w-full"
        />
      </FilterBar>

      <SectionBoundary title="브랜드 협업을 계산하지 못함" resetKey={JSON.stringify(input)}>
        {report.error ? (
          <Card>
            <ErrorState title="브랜드 협업을 계산하지 못함" error={report.error} />
          </Card>
        ) : !report.data ? (
          <Card>
            <LoadingState rows={6} />
          </Card>
        ) : (
          <BrandsBody
            report={report.data}
            stale={report.isStale}
            periodLabel={periodLabel}
            tab={tab}
            setTab={setTab}
            sort={sort}
            dir={dir}
            onSortChange={(k, d) => {
              setSort(k as BrandSort);
              setDir(d);
            }}
            page={page}
            setPage={setPage}
            openBrand={openBrand}
            selectedBrand={brand || null}
            spec={spec}
            onWiden={() => setSpec('last90d')}
          />
        )}
      </SectionBoundary>

      <Drawer
        open={!!brand}
        onClose={closeBrand}
        title={brand || '브랜드'}
        description={`브랜드 협업 상세 · ${periodLabel} 기준`}
        width="min(620px, 100vw)"
      >
        {brand ? <BrandDrawerBody name={brand} report={report.data} periodLabel={periodLabel} onClose={closeBrand} /> : null}
      </Drawer>

      <SourceNote
        asOf={now}
        window={report.data?.result.window}
        notes={report.data?.result.notes}
        sources={[`협찬 판정 ${report.data?.versions.join(', ') || SPONSORSHIP_VERSION}`]}
      />
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ caveat */

function DetectionCaveat({ versions }: { versions: string[] }) {
  const shown = versions.length ? versions.join(', ') : SPONSORSHIP_VERSION;
  return (
    <section aria-label="탐지 방식 안내" className="rounded-xl border border-l-4 border-line border-l-warning bg-surface p-4 shadow-card">
      <div className="flex items-start gap-3">
        <Info className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
        <div className="min-w-0 text-[13px] text-fg-2">
          <p>
            <span className="font-semibold text-fg">탐지 방식:</span> 영상의 공개 제목·설명(수집 시 앞 300자)·태그에서 광고 표기 문구와 브랜드
            이름을 찾는 규칙 기반 판정 <Badge tone="neutral">{shown}</Badge>. 계약·금액·캠페인 정보가 아니며, 표기 없는 협찬은 잡히지 않고
            문구만 있는 비협찬 영상이 섞일 수 있음.
          </p>
          <details className="mt-1">
            <summary className="focus-ring w-fit cursor-pointer rounded-sm text-accent-text hover:underline">판정 기준 보기</summary>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-fg-3">
              <li>
                <span className="font-medium text-fg-2">광고 표기</span>: {LEVEL_DESCRIPTIONS.disclosed}
              </li>
              <li>
                <span className="font-medium text-fg-2">협찬 추정</span>: {LEVEL_DESCRIPTIONS.likely}
              </li>
              <li>'협찬 아님', '#광고아님', '광고·협찬 문의', 'not sponsored' 같은 부정·문의 문구는 제외함.</li>
              <li>
                브랜드는 정리된 브랜드 목록과 'sponsored by …', '… 협찬', '提供: …' 같은 문구에서 찾음. 목록에 없는 이름은 '자동 추출'로
                표시하며 오탐일 수 있음. 제휴 쇼핑몰(쿠팡 파트너스·Amazon 등)은 협찬 브랜드로 세지 않음.
              </li>
              <li>플랫폼의 '유료 광고 포함' 라벨은 공개 API로 받지 못해 반영하지 않음. YouTube RSS 영상은 태그가 없어 제목·설명만 봄.</li>
              <li>공개 데이터셋에는 설명 앞부분만 실려, 판정 근거 문장이 이 화면에서 보이지 않으면 원본 영상에서 확인해야 함.</li>
            </ul>
          </details>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------------------------------ body */

interface BodyProps {
  report: BrandReport;
  stale: boolean;
  periodLabel: string;
  tab: Tab;
  setTab: (t: Tab) => void;
  sort: BrandSort;
  dir: SortDir;
  onSortChange: (key: string, dir: SortDir) => void;
  page: number;
  setPage: (p: number) => void;
  openBrand: (name: string) => void;
  selectedBrand: string | null;
  spec: string;
  onWiden: () => void;
}

function BrandsBody({ report, stale, periodLabel, tab, setTab, sort, dir, onSortChange, page, setPage, openBrand, selectedBrand, spec, onWiden }: BodyProps) {
  const t = report.totals;
  const brands = useMemo(() => sortBrands(report.brands, sort, dir), [report.brands, sort, dir]);
  const current = clampPage(page, report.rows.length, PAGE_SIZE);
  const pageRows = report.rows.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  const mixed = t.platforms.length > 1;

  const empty = (
    <EmptyState
      compact
      title="조건에 맞는 협찬 신호 영상 없음"
      description="협찬 신호는 전체 추적 영상 중 일부에서만 발견됨. 기간을 넓히거나 필터를 줄여 보면 됨."
      action={
        spec !== 'last90d' ? (
          <button type="button" onClick={onWiden} className="focus-ring rounded-sm text-[13px] font-medium text-accent-text hover:underline">
            최근 90일로 넓히기
          </button>
        ) : null
      }
    />
  );

  return (
    <>
      <KpiGrid className={cx('transition-opacity', stale && 'opacity-60')}>
        <KpiTile
          icon={<Megaphone className="size-4" />}
          label="협찬 신호 영상"
          value={formatInteger(t.videos)}
          sub={`광고 표기 ${formatInteger(t.disclosed)} · 협찬 추정 ${formatInteger(t.likely)}`}
          hint="기간·필터 조건에 맞는 영상 중 광고 표기나 판촉 신호가 있는 영상."
        />
        <KpiTile
          icon={<Tags className="size-4" />}
          label="브랜드"
          value={formatInteger(report.brands.length)}
          sub={`목록 브랜드 ${formatInteger(t.curatedBrands)} · 자동 추출 ${formatInteger(t.capturedBrands)}`}
        />
        <KpiTile
          icon={<Users className="size-4" />}
          label="크리에이터·계정"
          value={formatInteger(report.creators.length)}
          sub="협찬 신호 영상을 올린 포트폴리오"
        />
        <KpiTile
          icon={<TriangleAlert className="size-4" />}
          label="브랜드 미확인"
          value={formatInteger(t.unbranded)}
          sub={t.videos ? `협찬 신호 영상의 ${Math.round((t.unbranded / t.videos) * 100)}%` : '—'}
          hint="광고 표기는 있지만 브랜드 이름을 찾지 못한 영상. 브랜드 순위에는 없고 '협찬 영상' 탭에 있음."
        />
        <KpiTile
          icon={<Eye className="size-4" />}
          label={`${periodLabel} 합계`}
          value={<MetricCell metric={t.views} label={`${periodLabel} 합계`} extra={SUM_EXTRA} size="lg" align="left" />}
          sub={mixed ? '여러 플랫폼 합계 (단위 다름)' : t.platforms.length === 1 ? '한 플랫폼' : undefined}
          hint={`협찬 신호 영상 전체의 ${periodLabel} 합계. ${SUM_EXTRA}`}
        />
      </KpiGrid>

      {mixed ? (
        <Card>
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:items-start">
            <div>
              <h2 className="mb-2 text-[13px] font-semibold text-fg">플랫폼별 {periodLabel}</h2>
              <PlatformSums sums={t.byPlatform} label={periodLabel} />
            </div>
            <MixedPlatformNote />
          </div>
        </Card>
      ) : null}

      <Card flush>
        <div className="px-4 pt-3 sm:px-5">
          <Tabs<Tab>
            idBase="brands"
            label="브랜드 협업 보기"
            value={tab}
            onChange={setTab}
            tabs={[
              { id: 'brands', label: '브랜드', count: report.brands.length },
              { id: 'videos', label: '협찬 영상', count: report.rows.length },
              { id: 'creators', label: '크리에이터별', count: report.creators.length },
            ]}
          />
        </div>
        <TabPanel idBase="brands" id={tab}>
          {tab === 'brands' ? (
            <>
              <BrandTable
                rows={brands}
                sort={sort}
                dir={dir}
                onSortChange={onSortChange}
                onOpen={openBrand}
                selected={selectedBrand}
                stale={stale}
                periodLabel={periodLabel}
                empty={
                  t.videos > 0 ? (
                    <EmptyState
                      compact
                      icon={<BadgeCheck className="size-6" />}
                      title="브랜드 이름을 찾은 영상 없음"
                      description={`협찬 신호 영상 ${formatInteger(t.videos)}개 모두 브랜드 미확인. '협찬 영상' 탭에서 근거를 볼 수 있음.`}
                    />
                  ) : (
                    empty
                  )
                }
              />
              {t.unbranded > 0 && report.brands.length > 0 ? (
                <p className="px-4 py-3 text-xs text-fg-3 sm:px-5">
                  브랜드 이름을 찾지 못한 협찬 신호 영상 {formatInteger(t.unbranded)}개는 순위에 없음.{' '}
                  <button type="button" onClick={() => setTab('videos')} className="focus-ring rounded-sm text-accent-text hover:underline">
                    협찬 영상 탭에서 보기
                  </button>
                </p>
              ) : null}
            </>
          ) : tab === 'videos' ? (
            <>
              <SponsoredVideoTable rows={pageRows} onOpenBrand={openBrand} stale={stale} periodLabel={periodLabel} empty={empty} />
              <div className="flex flex-col gap-2 px-4 py-3 sm:px-5">
                {report.rows.length > PAGE_SIZE ? <Pager page={current} pageSize={PAGE_SIZE} total={report.rows.length} onChange={setPage} /> : null}
                <VideoLinks report={report} spec={spec} />
              </div>
            </>
          ) : (
            <CreatorBrandTable rows={report.creators} onOpenBrand={openBrand} stale={stale} periodLabel={periodLabel} empty={empty} />
          )}
        </TabPanel>
      </Card>
    </>
  );
}

function VideoLinks({ report, spec }: { report: BrandReport; spec: string }) {
  const q = report.query;
  const href = hrefWith('/videos', {
    range: spec,
    mode: q.dateMode,
    sort: 'views_period',
    sponsored: q.sponsored,
    platforms: q.platforms,
    cats: q.categories,
  });
  return (
    <p className="text-xs text-fg-3">
      정렬·다른 지표는{' '}
      <Link to={href} className="focus-ring inline-flex items-center gap-0.5 rounded-sm text-accent-text hover:underline">
        영상 탐색에서 보기 <ArrowRight className="size-3" aria-hidden />
      </Link>
      . 영상 탐색에는 협찬 추정만 따로 거르는 필터가 없어 전체 협찬 신호로 열림.
    </p>
  );
}

/* ------------------------------------------------------------------------------------------ drawer */

function BrandDrawerBody({ name, report, periodLabel, onClose }: { name: string; report: BrandReport | undefined; periodLabel: string; onClose: () => void }) {
  const row = report?.brands.find((b) => b.name === name) ?? null;
  const rows = useMemo(() => {
    if (!report || !row) return [] as VideoRow[];
    const byId = new Map(report.rows.map((r) => [r.video.id, r] as const));
    return row.videoIds.map((id) => byId.get(id)).filter((r): r is VideoRow => !!r);
  }, [report, row]);
  if (!report) return <LoadingState rows={4} className="p-4" />;
  if (!row) {
    return (
      <EmptyState
        className="px-4"
        icon={<Handshake className="size-8" />}
        title="현재 조건에서 이 브랜드의 협찬 신호 영상 없음"
        description="기간·플랫폼·분야·신호 종류 필터를 바꾸면 다시 나타날 수 있음."
      />
    );
  }
  return <BrandDetail brand={row} rows={rows} periodLabel={periodLabel} onClose={onClose} />;
}
