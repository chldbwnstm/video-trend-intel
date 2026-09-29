/**
 * 키워드 분석 (Keyword Intelligence): compare 1-5 keywords within the tracked video set — matched videos,
 * uploads per local day, period views (조회 발생 기간 기준, honest status sums), share of voice per platform —
 * then drill into one keyword: top videos, creators, platform / category / language split, related topics
 * and sponsorship. URL state: kw (comma list), range, platforms, langs, cats, match, fields, tab.
 * Heavy work runs in core analyzeKeywords through useAnalysis (deferred + cached).
 */
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { analyzeKeywords, keywordSuggestions, keywordTopVideosCsv } from '@vti/core';
import type { KeywordAnalysis, KeywordField, KeywordMatchMode, KeywordSuggestion, Platform } from '@vti/core';
import { ArrowRight, ChartColumn, Database, Hash, Languages, ChartPie, Plus, Scale, Search, TextSearch } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  CategoryPicker,
  EmptyState,
  ErrorState,
  ExportCsvButton,
  FilterBar,
  LoadingState,
  MultiSelect,
  PageHeader,
  PlatformPicker,
  RangePicker,
  SectionBoundary,
  SegmentedControl,
  SourceNote,
  TabPanel,
  Tabs,
} from '../components/index.ts';
import { useAnalysis, useDataset, useRangeParam, useUrlState } from '../data/hooks.ts';
import { fmtTime, languageLabel } from '../lib/display.ts';
import { formatInteger } from '../lib/format.ts';
import { orderPlatforms } from '../lib/platform.ts';
import { tzShort } from '../lib/timezones.ts';
import { formatLocalRange, intCodec, platformListCodec } from '../lib/urlState.ts';
import { languageCounts } from '../features/trends/readiness.ts';
import { ComparisonTable, CrossPlatformCaveat, DailyUploadsChart, ShareOfVoice } from '../features/keywords/Comparison.tsx';
import { KeywordInput, suggestionTitle } from '../features/keywords/KeywordInput.tsx';
import { KeywordPanel } from '../features/keywords/KeywordPanel.tsx';
import {
  FIELD_LABELS,
  fieldsCodec,
  keywordCoverage,
  keywordListCodec,
  MATCH_HINTS,
  MATCH_LABELS,
  matchCodec,
  MAX_KEYWORDS,
  mergeKeywords,
} from '../features/keywords/model.ts';
import type { KeywordCoverage, ScopeParams } from '../features/keywords/model.ts';

const FIELD_OPTIONS = (Object.keys(FIELD_LABELS) as KeywordField[]).map((f) => ({ value: f, label: FIELD_LABELS[f] }));

export default function KeywordsPage() {
  const { dataset, now, tz } = useDataset();
  const { spec, range, rollingHours, setSpec } = useRangeParam('range', 'rolling7d');
  const [keywords, setKeywords] = useUrlState<string[]>('kw', [], { codec: keywordListCodec, resets: ['tab'] });
  const [platforms, setPlatforms] = useUrlState<Platform[]>('platforms', [], { codec: platformListCodec });
  const [cats, setCats] = useUrlState<string[]>('cats', []);
  const [langs, setLangs] = useUrlState<string[]>('langs', []);
  const [match, setMatch] = useUrlState<KeywordMatchMode>('match', 'all', { codec: matchCodec });
  const [fields, setFields] = useUrlState<KeywordField[]>('fields', [], { codec: fieldsCodec });
  const [tab, setTab] = useUrlState<number>('tab', 0, { codec: intCodec });

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
  const coverage = useMemo(() => keywordCoverage(dataset), [dataset]);
  const suggestions = useAnalysis('keywordSuggestions', { limit: 1000 }, (index, i) => keywordSuggestions(index, i));

  const input = useMemo(
    () =>
      keywords.length
        ? {
            keywords,
            match,
            fields: fields.length ? fields : undefined,
            range,
            rollingHours,
            tz,
            now,
            platforms: platforms.length ? platforms : undefined,
            languages: langs.length ? langs : undefined,
            categories: cats.length ? cats : undefined,
            topVideos: 10,
          }
        : null,
    [keywords, match, fields, range, rollingHours, tz, now, platforms, langs, cats],
  );
  const analysis = useAnalysis('analyzeKeywords', input, (index, i) => (i ? analyzeKeywords(index, i) : null));
  const scope: ScopeParams = { range: spec, platforms, langs, cats };
  const addKeyword = (k: string) => setKeywords((cur) => mergeKeywords(cur, [k]).next);
  const data = analysis.data ?? null;
  const activeTab = data ? Math.min(Math.max(0, tab), data.keywords.length - 1) : 0;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow="Keyword Intelligence"
        title="키워드 분석"
        description="키워드와 일치하는 추적 영상의 기간 업로드·조회 증가를 비교하고, 어떤 플랫폼·크리에이터·주제에서 소비되는지 봄. 이 서비스가 수집한 영상 범위 안의 결과이며 플랫폼 전체 검색량이 아님."
        actions={
          data && data.keywords.some((r) => r.topVideos.length) ? (
            <ExportCsvButton getCsv={() => keywordTopVideosCsv(data, tz)} filename={`keywords-${keywords.join('_').slice(0, 40)}`} />
          ) : null
        }
      />

      <FilterBar label="키워드 분석 필터">
        <KeywordInput value={keywords} onChange={setKeywords} suggestions={suggestions.data} />
        <div className="flex w-full flex-wrap items-center gap-2">
          <RangePicker value={spec} onChange={setSpec} />
          <PlatformPicker options={presentPlatforms} value={platforms} onChange={setPlatforms} counts={platformCounts} />
          <CategoryPicker value={cats} onChange={setCats} />
          {languageOptions.length > 1 ? (
            <MultiSelect label="영상 언어" options={languageOptions} value={langs} onChange={setLangs} icon={<Languages className="size-4" />} searchable />
          ) : null}
          <MultiSelect label="검색 위치" options={FIELD_OPTIONS} value={fields} onChange={(v) => setFields(v as KeywordField[])} icon={<TextSearch className="size-4" />} allLabel="전체 필드" searchable={false} />
          <SegmentedControl<KeywordMatchMode>
            label="여러 단어 키워드 일치 방식"
            size="sm"
            value={match}
            onChange={setMatch}
            options={(['all', 'any'] as const).map((m) => ({ value: m, label: MATCH_LABELS[m], title: MATCH_HINTS[m] }))}
          />
        </div>
        <p className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-3">
          <span className="font-medium text-fg-2">조회 발생 기간 기준</span>
          <span>
            {rollingHours ? `데이터 기준 시각까지 최근 ${rollingHours}시간 (롤링)` : `기간 ${formatLocalRange(range)} (${tzShort(tz)} 날짜 기준, 양 끝 포함)`}
          </span>
          {data?.window.incomplete ? <Badge tone="warning">진행 중인 기간</Badge> : null}
          <span aria-hidden>·</span>
          <span>업로드 수는 기간 내 게시</span>
          <span aria-hidden>·</span>
          <span>
            데이터 기준 {fmtTime(now, tz)} {tzShort(tz)}
          </span>
        </p>
      </FilterBar>

      {!keywords.length ? (
        <StartState suggestions={suggestions.data} coverage={coverage} onPick={(list) => setKeywords(mergeKeywords([], list).next)} />
      ) : (
        <SectionBoundary title="키워드 분석을 계산하지 못함" resetKey={`${keywords.join('|')}|${spec}|${platforms.join()}|${cats.join()}|${langs.join()}|${match}|${fields.join()}`}>
          {analysis.error ? (
            <Card>
              <ErrorState title="키워드 분석을 계산하지 못함" error={analysis.error} />
            </Card>
          ) : !data ? (
            <Card>
              <LoadingState rows={6} />
            </Card>
          ) : (
            <Results
              data={data}
              stale={analysis.isStale}
              scope={scope}
              keywords={keywords}
              coverage={coverage}
              activeTab={activeTab}
              onTab={setTab}
              onAddKeyword={addKeyword}
            />
          )}
        </SectionBoundary>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ results */

interface ResultsProps {
  data: KeywordAnalysis;
  stale: boolean;
  scope: ScopeParams;
  keywords: string[];
  coverage: KeywordCoverage;
  activeTab: number;
  onTab: (i: number) => void;
  onAddKeyword: (k: string) => void;
}

function Results({ data, stale, scope, keywords, coverage, activeTab, onTab, onAddKeyword }: ResultsProps) {
  const { now } = useDataset();
  const mixed = data.keywords.some((r) => r.viewsPeriod.crossPlatform);
  const noneMatched = data.keywords.every((r) => r.videos === 0);
  const report = data.keywords[activeTab];
  return (
    <div className={stale ? 'flex flex-col gap-4 opacity-80 transition-opacity' : 'flex flex-col gap-4'}>
      {noneMatched ? <CoverageCallout coverage={coverage} scopeVideos={data.scopeVideos} /> : null}

      <Card flush>
        <div className="p-4 pb-0 sm:p-5 sm:pb-0">
          <CardHeader
            icon={<Scale className="size-4" />}
            title="키워드 비교"
            description={`추적 영상 ${formatInteger(data.scopeVideos)}개(필터 적용) 중 일치한 영상. 기간 조회 증가는 게시일과 관계없이 이 기간에 늘어난 조회수 합계.`}
          />
        </div>
        <ComparisonTable analysis={data} scope={scope} stale={stale} />
        {mixed ? (
          <div className="px-4 pt-2 pb-4 sm:px-5">
            <CrossPlatformCaveat show />
          </div>
        ) : null}
      </Card>

      {data.keywords.length > 1 ? (
        <Card>
          <CardHeader
            icon={<ChartPie className="size-4" />}
            title="플랫폼별 점유율 (share of voice)"
            description="같은 플랫폼 안에서 비교한 키워드들의 업로드·조회 증가 중 각 키워드의 비율. 두 키워드에 모두 일치한 영상은 양쪽에 셈."
          />
          <ShareOfVoice analysis={data} />
        </Card>
      ) : null}

      <Card>
        <CardHeader
          icon={<ChartColumn className="size-4" />}
          title="일별 업로드 수"
          description={`기간 안에 게시된 일치 영상 수 (${data.tz} 현지 날짜별, 추적 범위 기준). 최근 업로드일수록 많이 발견되는 수집 특성이 반영됨.`}
        />
        <DailyUploadsChart analysis={data} />
      </Card>

      <Tabs<string>
        idBase="keyword-tab"
        label="키워드별 상세"
        value={String(activeTab)}
        onChange={(id) => onTab(Number(id))}
        tabs={data.keywords.map((r, i) => ({ id: String(i), label: r.keyword, count: r.videos }))}
      />
      <TabPanel idBase="keyword-tab" id={String(activeTab)}>
        {report ? (
          <KeywordPanel analysis={data} report={report} index={activeTab} scope={scope} selected={keywords} onAddKeyword={onAddKeyword} stale={stale} />
        ) : null}
      </TabPanel>

      <SourceNote asOf={now} window={data.window} notes={data.notes} sources={[`일치 규칙 ${data.match === 'all' ? '모든 단어' : '아무 단어'}`, `검색 위치 ${data.fields.map((f) => FIELD_LABELS[f]).join('·')}`]} />
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ empty / coverage */

function CoverageText({ coverage }: { coverage: KeywordCoverage }) {
  return (
    <ul className="flex list-disc flex-col gap-1 pl-4 text-[13px] text-fg-2">
      <li>
        추적 중인 영상 {formatInteger(coverage.trackedVideos)}개(시드 채널 최신 업로드, 인기·최신 정렬, 태그 검색으로 수집) 안에서만 찾음. 플랫폼 전체 검색 결과가 아님.
      </li>
      <li>
        수집기의 키워드 검색 시드(<code className="rounded bg-surface-3 px-1 text-xs">packages/collector/seeds/keywords.json</code>)는 YouTube 검색 API로 영상을 찾는 데 쓰이며, API 키가 있을 때만 켜짐:{' '}
        {coverage.youtubeSearch ? <Badge tone="positive">켜짐</Badge> : <Badge tone="warning">현재 꺼짐</Badge>}
      </li>
      {coverage.keywordSources.length ? (
        <li>
          키워드·태그로 찾을 수 있는 원천:{' '}
          {coverage.keywordSources.map((s, i) => (
            <span key={s.source}>
              {i ? ', ' : ''}
              {s.label}
              <span className="text-fg-3">({s.enabled ? '켜짐' : '꺼짐'})</span>
            </span>
          ))}
        </li>
      ) : null}
    </ul>
  );
}

function CoverageCallout({ coverage, scopeVideos }: { coverage: KeywordCoverage; scopeVideos: number }) {
  return (
    <Card>
      <CardHeader
        icon={<Database className="size-4" />}
        title="일치하는 추적 영상 없음"
        description={`필터 범위의 추적 영상 ${formatInteger(scopeVideos)}개 중 어느 키워드와도 일치하지 않음. 다른 표기(영문·일본어·띄어쓰기)나 더 넓은 기간·필터를 시도해 볼 것.`}
        actions={
          <Link to="/coverage" className="focus-ring inline-flex items-center gap-1 rounded-sm text-[13px] font-medium text-accent-text hover:underline">
            데이터 범위 <ArrowRight className="size-3.5" aria-hidden />
          </Link>
        }
      />
      <CoverageText coverage={coverage} />
    </Card>
  );
}

function StartState({
  suggestions,
  coverage,
  onPick,
}: {
  suggestions: { discovery: KeywordSuggestion[]; topics: KeywordSuggestion[] } | undefined;
  coverage: KeywordCoverage;
  onPick: (list: string[]) => void;
}) {
  const topics = suggestions?.topics ?? [];
  const discovery = suggestions?.discovery ?? [];
  const example = topics.slice(0, 3).map((t) => t.keyword);
  return (
    <div className="grid gap-4 lg:grid-cols-12">
      <Card className="lg:col-span-7">
        <EmptyState
          icon={<Search className="size-6" />}
          title="비교할 키워드를 입력하세요"
          description={`키워드를 최대 ${MAX_KEYWORDS}개까지 넣으면 추적 영상에서 일치하는 영상의 기간 업로드·조회 증가, 플랫폼별 점유율, 상위 영상·크리에이터, 함께 나오는 주제를 보여줌.`}
          action={
            example.length ? (
              <Button variant="primary" icon={<Plus className="size-4" aria-hidden />} onClick={() => onPick(example)}>
                예시로 비교: {example.join(' · ')}
              </Button>
            ) : null
          }
        />
      </Card>
      <Card className="lg:col-span-5">
        <CardHeader icon={<Database className="size-4" />} title="찾을 수 있는 범위" description="결과가 비거나 적을 때 먼저 확인할 것." />
        <CoverageText coverage={coverage} />
        <Link to="/coverage" className="focus-ring mt-3 inline-flex items-center gap-1 rounded-sm text-[13px] font-medium text-accent-text hover:underline">
          데이터 범위 자세히 <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      </Card>
      <Card className="lg:col-span-12">
        <CardHeader icon={<Hash className="size-4" />} title="추천 키워드" description="수집기가 영상을 찾은 검색어·태그와, 여러 계정이 쓴 인기 주제 (추적 영상 수)." />
        {!suggestions ? (
          <LoadingState rows={2} />
        ) : (
          <div className="flex flex-col gap-3">
            {discovery.length ? <SuggestionList title="수집 검색어·태그" items={discovery.slice(0, 16)} onPick={onPick} /> : null}
            {topics.length ? <SuggestionList title="인기 주제" items={topics.slice(0, 24)} onPick={onPick} /> : null}
            {!discovery.length && !topics.length ? <p className="text-sm text-fg-3">추천할 키워드가 없음.</p> : null}
          </div>
        )}
      </Card>
    </div>
  );
}

function SuggestionList({ title, items, onPick }: { title: string; items: KeywordSuggestion[]; onPick: (list: string[]) => void }) {
  return (
    <section aria-label={title}>
      <h3 className="mb-1.5 text-xs font-medium text-fg-3">{title}</h3>
      <ul className="flex flex-wrap gap-1.5">
        {items.map((s) => (
          <li key={s.keyword}>
            <button
              type="button"
              onClick={() => onPick([s.keyword])}
              title={suggestionTitle(s)}
              className="focus-ring inline-flex max-w-[16rem] items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 text-[13px] leading-7 text-fg-2 hover:border-accent hover:text-fg"
            >
              <span className="truncate">{s.keyword}</span>
              <span className="text-[11px] text-fg-3 tabular">{formatInteger(s.videos)}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

