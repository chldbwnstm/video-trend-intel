/**
 * /#/ui-kit — living catalogue of the design system with real (sample or live) data. Not in the nav.
 * Page engineers: use it to see components in both themes and at phone width. See UI_GUIDE.md.
 */
import { useMemo, useState } from 'react';
import { addDays, dailyIncrements, localDateOf, PLATFORMS } from '@vti/core';
import type { AgeDays, DateMode, MetricStatus, MetricValue, Platform, Video } from '@vti/core';
import { Download, Languages, Star } from 'lucide-react';
import {
  AgePicker,
  Badge,
  BarList,
  Button,
  Card,
  CardHeader,
  CategoryChip,
  CategoryPicker,
  Checkbox,
  Chip,
  DataTable,
  DateModePicker,
  Drawer,
  EmptyState,
  ErrorState,
  ExportCsvButton,
  GrowthChart,
  IconButton,
  InfoTip,
  KpiGrid,
  KpiTile,
  LoadingState,
  MetricCell,
  Modal,
  MultiSelect,
  NumberDelta,
  PageHeader,
  Pager,
  PlatformBadge,
  PlatformPicker,
  RangePicker,
  SearchInput,
  SectionGrid,
  SegmentedControl,
  Select,
  SourceNote,
  SparkLine,
  StatRow,
  Tabs,
  TabPanel,
  toCsv,
  Tooltip,
  VideoCell,
} from '../components/index.ts';
import type { Column, MultiSelectOption } from '../components/index.ts';
import { useDataset, useRangeParam, useUrlState } from '../data/hooks.ts';
import { countryLabel, fmtTime, languageLabel } from '../lib/display.ts';
import { STATUS_ORDER } from '../lib/metricStatus.ts';
import { ageCodec, dateModeCodec, platformListCodec } from '../lib/urlState.ts';

const DEMO_STATUSES: { status: MetricStatus; value: number; note: string | null }[] = [
  { status: 'exact', value: 1_234_567, note: null },
  { status: 'interpolated', value: 45_210, note: null },
  { status: 'lower_bound', value: 98_000, note: 'start_before_first_observation' },
  { status: 'source_reported', value: 12_400, note: 'source_window' },
  { status: 'unavailable', value: 0, note: 'gap_too_wide' },
  { status: 'decrease_flagged', value: -3_150, note: 'decrease' },
];

/** Options with counts for a list of (nullable) codes; null codes are skipped. */
function countBy(codes: (string | null)[], label: (code: string) => string): MultiSelectOption[] {
  const m = new Map<string, number>();
  for (const c of codes) if (c) m.set(c, (m.get(c) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, label: label(value), count, keywords: [value] }));
}

export default function UiKitPage() {
  const { dataset, index, now, tz } = useDataset();
  const [mode, setMode] = useUrlState<DateMode>('mode', 'activity', { codec: dateModeCodec });
  const [age, setAge] = useUrlState<AgeDays>('age', 7, { codec: ageCodec });
  const [platforms, setPlatforms] = useUrlState<Platform[]>('platforms', [], { codec: platformListCodec });
  const [cats, setCats] = useUrlState<string[]>('cats', []);
  const { spec, setSpec, range } = useRangeParam();
  const [tab, setTab] = useState<'a' | 'b'>('a');
  const [seg, setSeg] = useState<'day' | 'week'>('day');
  const [q, setQ] = useState('');
  const [checked, setChecked] = useState(true);
  const [drawer, setDrawer] = useState(false);
  const [modal, setModal] = useState(false);
  const [sel, setSel] = useState<'a' | 'b' | 'c'>('a');
  const [langs, setLangs] = useUrlState<string[]>('langs', []);
  const [countries, setCountries] = useUrlState<string[]>('countries', []);
  const [page, setPage] = useUrlState('page', 1);
  const languageOptions = useMemo(() => countBy(dataset.videos.map((v) => v.language), languageLabel), [dataset]);
  const countryOptions = useMemo(() => countBy(dataset.videos.map((v) => v.country), countryLabel), [dataset]);

  // A video with a rich history for the charts.
  const video: Video | undefined = useMemo(() => {
    let best: Video | undefined;
    for (const v of dataset.videos) if (!best || v.obs.length > best.obs.length || (v.obs.length === best.obs.length && (v.obs.at(-1)?.views ?? 0) > (best.obs.at(-1)?.views ?? 0))) best = v;
    return best;
  }, [dataset]);
  const rows = useMemo(() => dataset.videos.slice(-6).reverse(), [dataset]);
  const daily = useMemo(() => {
    if (!video) return [];
    try {
      const end = localDateOf(now, tz);
      return dailyIncrements(video, 'views', addDays(end, -13), end, tz, now);
    } catch {
      return [];
    }
  }, [video, now, tz]);

  const columns: Column<Video>[] = [
    { id: 'video', header: '영상', cell: (v) => <VideoCell video={v} accountName={index.accountsById.get(v.accountId)?.name} publishedLabel={fmtTime(v.publishedAt, tz, 'date')} /> },
    {
      id: 'views',
      header: '누적 조회',
      align: 'right',
      width: '7rem',
      sortKey: 'views',
      hint: '마지막 관측값',
      cell: (v) => {
        const o = v.obs.at(-1);
        const m: MetricValue = { value: o?.views ?? null, status: o?.views === null || !o ? 'unavailable' : 'exact', asOf: o?.t ?? null, note: o?.views === null ? 'counter_not_provided' : null };
        return <MetricCell metric={m} label="누적 조회" source={o?.src} />;
      },
    },
    {
      id: 'likes',
      header: '좋아요',
      align: 'right',
      width: '6rem',
      hideBelow: 'sm',
      cell: (v) => {
        const o = v.obs.at(-1);
        const m: MetricValue = { value: o?.likes ?? null, status: o?.likes == null ? 'unavailable' : 'exact', asOf: o?.t ?? null, note: o?.likes == null ? 'counter_not_provided' : null };
        return <MetricCell metric={m} label="좋아요" unit="개" />;
      },
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader eyebrow="개발용" title="UI 카탈로그" description="디자인 시스템 컴포넌트를 실제 데이터로 확인하는 화면. 메뉴에는 없음." />

      <Card>
        <CardHeader title="지표 셀 (MetricCell)" description="모든 지표는 이 셀로 표시. 마우스를 올리거나 Tab으로 이동하면 설명이 보임." />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {DEMO_STATUSES.map((d) => (
            <div key={d.status} className="rounded-lg border border-line p-3">
              <p className="mb-1 text-xs text-fg-3">{d.status}</p>
              <MetricCell metric={{ value: d.value, status: d.status, asOf: now, note: d.note }} label="기간 조회 증가" source="youtube-data-api@1" size="md" align="left" />
            </div>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-4 text-sm">
          <MetricCell metric={{ value: 0.0412, status: 'exact', asOf: now, note: null, components: ['likes', 'comments'] } as MetricValue & { components: string[] }} kind="rate" label="참여율" />
          <MetricCell metric={{ value: 1520.4, status: 'interpolated', asOf: now, note: null }} kind="perHour" label="증가 속도" />
          <MetricCell metric={{ value: 2.34, status: 'exact', asOf: now, note: null }} kind="multiplier" label="평소 대비" />
          <MetricCell metric={{ value: 91, status: 'exact', asOf: now, note: null }} kind="percentile" label="백분위" />
          <NumberDelta value={0.34} />
          <NumberDelta value={-0.12} />
          <NumberDelta value={0} />
          <NumberDelta metric={{ value: null, status: 'unavailable' }} />
        </div>
        <p className="mt-2 text-xs text-fg-3">상태 순서: {STATUS_ORDER.join(' · ')}</p>
      </Card>

      <Card>
        <CardHeader title="필터 컨트롤" description="URL 상태(mode, range, age, platforms, cats)와 연결됨. 주소를 복사하면 같은 화면." />
        <div className="flex flex-col gap-4">
          <DateModePicker value={mode} onChange={setMode} />
          <div className="flex flex-wrap items-center gap-2">
            <RangePicker value={spec} onChange={setSpec} />
            <AgePicker value={age} onChange={setAge} />
            <CategoryPicker value={cats} onChange={setCats} />
          </div>
          <PlatformPicker options={[...PLATFORMS]} value={platforms} onChange={setPlatforms} />
          <div className="flex flex-wrap items-center gap-2">
            <MultiSelect label="영상 언어" options={languageOptions} value={langs} onChange={setLangs} icon={<Languages className="size-4" />} />
            <MultiSelect label="업로드 국가(원천 제공)" options={countryOptions} value={countries} onChange={setCountries} />
          </div>
          <Pager page={page} pageSize={50} total={dataset.videos.length} onChange={setPage} />
          <p className="text-xs text-fg-3">
            해석된 기간: {range.start} ~ {range.end} ({tz})
          </p>
        </div>
      </Card>

      <SectionGrid>
        <Card className="lg:col-span-8" flush>
          <div className="p-4 pb-0 sm:p-5 sm:pb-0">
            <CardHeader title="표 (DataTable + VideoCell)" actions={<ExportCsvButton getCsv={() => toCsv([['id', 'title'], ...rows.map((v) => [v.id, v.title])])} filename="ui-kit" />} />
          </div>
          <DataTable columns={columns} rows={rows} rowKey={(v) => v.id} caption="최근 게시 영상" sort={{ key: 'views', dir: 'desc' }} onSortChange={() => undefined} minWidth="320px" maxHeight="420px" />
        </Card>
        <Card className="lg:col-span-4">
          <CardHeader title="분포 (BarList)" />
          <BarList
            label="플랫폼별 영상"
            showShare
            items={PLATFORMS.filter((p) => dataset.videos.some((v) => v.platform === p)).map((p) => ({
              key: p,
              label: <PlatformBadge platform={p} />,
              value: dataset.videos.filter((v) => v.platform === p).length,
              color: `var(--platform-${p})`,
            }))}
          />
        </Card>
      </SectionGrid>

      {video ? (
        <SectionGrid>
          <Card className="lg:col-span-6">
            <CardHeader title="성장 곡선 (GrowthChart line)" description={video.title} />
            <GrowthChart
              title="누적 조회"
              series={[
                { id: 'views', label: '조회', points: video.obs.map((o) => ({ x: o.t, value: o.views })) },
                { id: 'likes', label: '좋아요', points: video.obs.map((o) => ({ x: o.t, value: o.likes })) },
              ]}
            />
          </Card>
          <Card className="lg:col-span-6">
            <CardHeader title="일별 증가 (GrowthChart bar)" description="core dailyIncrements, 최근 14일" />
            <GrowthChart title="일별 조회 증가" variant="bar" series={[{ id: 'd', label: '일별 조회 증가', points: daily.map((d) => ({ x: d.date, value: d.value.value, status: d.value.status })) }]} />
          </Card>
        </SectionGrid>
      ) : null}

      <KpiGrid>
        <KpiTile label="추적 영상" value={dataset.videos.length.toLocaleString('ko-KR')} sub="예시" hint="설명 툴팁" />
        <KpiTile label="스파크라인" value="42" chart={<SparkLine data={[3, 5, 4, 8, 7, 9, 12, null, 10]} label="예시 추이" />} />
        <KpiTile label="증감" value="1.2만" delta={<NumberDelta value={0.18} />} />
        <KpiTile label="상태" value={<Badge tone="positive">정상</Badge>} />
        <KpiTile label="링크" value="→" to="/coverage" />
      </KpiGrid>

      <SectionGrid>
        <Card className="lg:col-span-6">
          <CardHeader title="기본 컨트롤" />
          <div className="flex flex-col gap-3">
            <Tabs idBase="kit" label="예시 탭" value={tab} onChange={setTab} tabs={[{ id: 'a', label: '첫째', count: 12 }, { id: 'b', label: '둘째' }]} />
            <TabPanel idBase="kit" id={tab}>
              <p className="text-sm text-fg-2">{tab === 'a' ? '첫째 탭 내용' : '둘째 탭 내용'}</p>
            </TabPanel>
            <SegmentedControl label="단위" value={seg} onChange={setSeg} options={[{ value: 'day', label: '일' }, { value: 'week', label: '주' }]} />
            <div className="flex flex-wrap items-center gap-2">
              <Select label="정렬" value={sel} onChange={setSel} options={[{ value: 'a', label: '기간 조회 증가' }, { value: 'b', label: '누적 조회' }, { value: 'c', label: '증가 속도' }]} />
              <SearchInput value={q} onChange={setQ} placeholder="영상·계정 검색" className="w-56" />
              <Checkbox checked={checked} onChange={setChecked} label="협찬 포함" />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary">기본</Button>
              <Button>보조</Button>
              <Button variant="ghost">고스트</Button>
              <Button variant="danger">위험</Button>
              <Button loading>저장</Button>
              <IconButton label="즐겨찾기">
                <Star className="size-4" aria-hidden />
              </IconButton>
              <Button icon={<Download className="size-4" aria-hidden />} size="sm">
                작은 버튼
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Chip selected onClick={() => undefined}>
                선택됨
              </Chip>
              <Chip onClick={() => undefined}>토글</Chip>
              <Chip onRemove={() => undefined} removeLabel="추석 제거">
                #추석
              </Chip>
              <CategoryChip id="beauty/skincare" confidence={0.82} />
              {(['neutral', 'accent', 'positive', 'negative', 'warning', 'info'] as const).map((t) => (
                <Badge key={t} tone={t}>
                  {t}
                </Badge>
              ))}
            </div>
            <p className="flex items-center gap-2 text-sm">
              <Tooltip content="툴팁 내용: 키보드 포커스로도 열림">툴팁 대상</Tooltip>
              <InfoTip>정보 아이콘 설명</InfoTip>
            </p>
            <div className="flex gap-2">
              <Button onClick={() => setDrawer(true)}>서랍 열기</Button>
              <Button onClick={() => setModal(true)}>모달 열기</Button>
            </div>
          </div>
        </Card>
        <Card className="lg:col-span-6">
          <CardHeader title="상태 화면" />
          <EmptyState compact title="결과 없음" description="필터를 바꿔 보기" />
          <LoadingState rows={2} />
          <ErrorState compact title="계산하지 못함" error={new Error('예시 오류')} onRetry={() => undefined} />
        </Card>
      </SectionGrid>

      <SourceNote asOf={now} notes={['예시 메모: 여러 플랫폼이 섞인 순위는 참고용.']} sources={['youtube-data-api@1']} />

      <Drawer open={drawer} onClose={() => setDrawer(false)} title="영상 상세 (예시)" description="서랍 컴포넌트">
        <dl className="p-4">
          <StatRow label="플랫폼">{video ? <PlatformBadge platform={video.platform} /> : '—'}</StatRow>
          <StatRow label="게시">{video ? fmtTime(video.publishedAt, tz) : '—'}</StatRow>
          <StatRow label="관측 수">{video?.obs.length ?? 0}</StatRow>
        </dl>
      </Drawer>
      <Modal open={modal} onClose={() => setModal(false)} title="확인" footer={<Button variant="primary" onClick={() => setModal(false)}>확인</Button>}>
        <p className="text-sm text-fg-2">모달 내용</p>
      </Modal>
    </div>
  );
}
