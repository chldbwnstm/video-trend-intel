/**
 * 데이터 범위 (trust layer): what we collect, how, how fresh, what the numbers mean, what the current data can
 * compute honestly, collection runs and errors, export notes, what we do not offer (panel data) and how to
 * enable more sources.
 */
import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  Ban,
  CircleHelp,
  Clock,
  Database,
  FileText,
  Gauge,
  History,
  KeyRound,
  Layers,
  ListChecks,
  Plug,
  Ruler,
} from 'lucide-react';
import {
  Badge,
  Card,
  CardHeader,
  DATE_MODE_DESCRIPTIONS,
  DATE_MODE_LABELS,
  EmptyState,
  ErrorState,
  FreshnessBadge,
  KpiGrid,
  KpiTile,
  LoadingState,
  PageHeader,
  SectionBoundary,
  SourceNote,
} from '../components/index.ts';
import { useAnalysis, useDataset } from '../data/hooks.ts';
import { fmtTime } from '../lib/display.ts';
import { formatInteger, formatPercent, formatRelative } from '../lib/format.ts';
import { tzShort } from '../lib/timezones.ts';
import {
  computability,
  coverageSummary,
  formatHoursKo,
  observationDepth,
  runSummary,
  sortRuns,
  sourceRows,
} from '../features/data-coverage/coverageModel.ts';
import {
  CaveatList,
  ComputabilityView,
  DepthTable,
  EnableSources,
  METRIC_CAVEATS,
  RunsTable,
  SourceCard,
  SourceTable,
  StatusLegend,
} from '../features/data-coverage/CoverageParts.tsx';

const SECTIONS: { id: string; label: string }[] = [
  { id: 'cov-computable', label: '계산 가능 범위' },
  { id: 'cov-sources', label: '원천' },
  { id: 'cov-runs', label: '수집 기록' },
  { id: 'cov-definitions', label: '지표 정의' },
  { id: 'cov-not-offered', label: '제공하지 않는 기능' },
  { id: 'cov-enable', label: '원천 추가하기' },
];

function scrollToSection(id: string) {
  if (typeof document === 'undefined') return;
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  el.focus({ preventScroll: true });
}

export default function CoveragePage() {
  const { dataset, now, tz, isSample } = useDataset();
  const summary = useMemo(() => coverageSummary(dataset), [dataset]);
  const sources = useMemo(() => sourceRows(dataset.coverage ?? [], now), [dataset, now]);
  const runs = useMemo(() => sortRuns(dataset.runs ?? []), [dataset]);
  const runStats = useMemo(() => runSummary(dataset.runs ?? [], now), [dataset, now]);
  const depth = useMemo(() => observationDepth(dataset), [dataset]);
  const labels = useMemo(() => Object.fromEntries((dataset.coverage ?? []).map((c) => [c.source, c.label])), [dataset]);
  const comp = useAnalysis('coverage.computability', { tz, now }, (index, i) => computability(index, i));
  const clock = Date.now();

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow="신뢰 계층 (차별점)"
        title="데이터 범위"
        description="어떤 원천에서 무엇을 어떻게 모으는지, 얼마나 최신인지, 숫자가 무엇을 뜻하는지, 지금 데이터로 무엇을 정확히 계산할 수 있는지 공개함."
      />

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-2 text-sm text-fg-3">
              <Clock className="size-4" aria-hidden />
              데이터 기준 시각
              <FreshnessBadge generatedAt={dataset.generatedAt} clock={clock} isSample={isSample} />
            </p>
            <p className="mt-1 text-xl font-bold text-fg tabular">
              {fmtTime(dataset.generatedAt, tz)} <span className="text-base font-medium text-fg-3">{tzShort(tz)}</span>
            </p>
            <p className="mt-1 text-[13px] text-fg-3">
              지금 시각 기준 {formatRelative(dataset.generatedAt, clock)} 생성 · 모든 기간 계산의 '현재'는 이 시각임 · UTC로 저장하고 선택한 시간대로 표시함.
            </p>
          </div>
          <dl className="grid min-w-0 grid-cols-2 gap-x-6 gap-y-1 text-[13px] sm:grid-cols-3">
            <Fact label="첫 수집">{summary.firstRunAt !== null ? fmtTime(summary.firstRunAt, tz) : '—'}</Fact>
            <Fact label="수집 이력">{formatHoursKo(summary.historyHours)}</Fact>
            <Fact label="실행 간격(중앙값)">
              {runStats.medianIntervalHours !== null ? formatHoursKo(runStats.medianIntervalHours) : '실행 1회뿐'}
            </Fact>
            <Fact label="실행 기록">{formatInteger(runStats.total)}회</Fact>
            <Fact label="최근 24시간 실패">
              <span className={runStats.problems24h ? 'text-warning' : undefined}>{formatInteger(runStats.problems24h)}회</span>
            </Fact>
            <Fact label="분류기">{dataset.classifierVersion}</Fact>
          </dl>
        </div>
        {summary.historyHours !== null && summary.historyHours < 72 ? (
          <p className="mt-3 rounded-md bg-info-soft px-3 py-2 text-[13px] text-fg-2">
            수집을 시작한 지 {formatHoursKo(summary.historyHours)}밖에 되지 않아 영상 대부분이 아직 한두 번만 관측됨. 그래서 기간 증가량은 게시가 기간 안인 영상(정확),
            원천 제공 기간값(Dailymotion), 하한(≥) 외에는 '계산 불가(—)'가 많음. 수집이 쌓이면 자동으로 채워지며 빈 값은 0으로 바꾸지 않음.
          </p>
        ) : null}
      </Card>

      <KpiGrid>
        <KpiTile icon={<Plug className="size-4" />} label="켜진 원천" value={`${summary.enabled} / ${summary.sources}`} sub={`인증 필요 ${summary.credentialed} · 오류 ${summary.failing}`} />
        <KpiTile icon={<Database className="size-4" />} label="추적 영상" value={formatInteger(summary.videos)} sub={`플랫폼 ${summary.platforms.length}개`} to="/videos" />
        <KpiTile
          icon={<Layers className="size-4" />}
          label="추적 계정"
          value={formatInteger(summary.accounts)}
          sub={`크리에이터 ${summary.creators.verified + summary.creators.suggested}명 (확인 ${summary.creators.verified} · 자동 제안 ${summary.creators.suggested})`}
          to="/creators"
        />
        <KpiTile icon={<ListChecks className="size-4" />} label="분류된 영상" value={formatPercent(summary.categorizedShare)} sub="근거가 있는 경우만 분류" to="/taxonomy" />
        <KpiTile
          icon={<FileText className="size-4" />}
          label="협찬 신호 영상"
          value={formatInteger(summary.sponsored.disclosed + summary.sponsored.likely)}
          sub={`광고 표기 ${formatInteger(summary.sponsored.disclosed)} · 협찬 추정 ${formatInteger(summary.sponsored.likely)}`}
          to="/brands"
        />
      </KpiGrid>

      <nav aria-label="데이터 범위 목차" className="flex flex-wrap gap-1.5">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => scrollToSection(s.id)}
            className="focus-ring rounded-full border border-line bg-surface px-3 py-1 text-[13px] text-fg-2 hover:border-line-strong hover:text-fg"
          >
            {s.label}
          </button>
        ))}
      </nav>

      <Section id="cov-computable">
        <Card>
          <CardHeader
            icon={<Gauge className="size-4" />}
            title="지금 데이터로 계산할 수 있는 범위"
            description="롤링 기간별 '기간 조회 증가'(조회 발생 기간 기준) 값의 상태 분포. 계산 불가(—)는 0이 아니라 경계 관측이 아직 없다는 뜻."
          />
          <SectionBoundary title="계산 가능 범위를 구하지 못함" compact>
            {comp.error ? (
              <ErrorState compact title="계산 가능 범위를 구하지 못함" error={comp.error} />
            ) : !comp.data ? (
              <LoadingState rows={3} />
            ) : (
              <ComputabilityView rows={comp.data} />
            )}
          </SectionBoundary>
          <p className="mt-3 text-xs text-fg-3">
            정확 = 기간 경계 근처의 실제 관측(또는 기간 안 게시로 시작값 0), ≈ = 두 관측 사이 보간, 원천 = 플랫폼 제공 기간값, ≥ = 관측된 구간만 센 하한. 순위에는
            계산 불가·감소 값을 넣지 않음.
          </p>
        </Card>
        <Card flush className="mt-4">
          <div className="p-4 pb-2 sm:p-5 sm:pb-2">
            <CardHeader
              icon={<History className="size-4" />}
              title="관측 이력"
              description="영상마다 몇 번 관측했는지. 관측이 2회 이상 쌓여야 기간 경계 값을 직접 계산할 수 있음."
              className="mb-0"
            />
          </div>
          {depth.length ? <DepthTable rows={depth} /> : <EmptyState compact title="추적 중인 영상 없음" />}
        </Card>
      </Section>

      <Section id="cov-sources">
        <Card flush>
          <div className="p-4 pb-2 sm:p-5 sm:pb-2">
            <CardHeader
              icon={<Database className="size-4" />}
              title="원천별 수집 현황"
              description="상태는 데이터 기준 시각 대비 마지막 성공 수집 경과로 판단 (12시간 이내 정상, 48시간 넘으면 오래됨)."
              className="mb-0"
            />
          </div>
          {sources.length ? (
            <SourceTable rows={sources} now={now} />
          ) : (
            <EmptyState compact title="원천 정보 없음" description="데이터셋에 수집 범위(coverage) 기록이 없음." />
          )}
        </Card>
        {sources.some((r) => r.state !== 'disabled') ? (
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            {sources
              .filter((r) => r.state !== 'disabled')
              .map((r) => (
                <SourceCard key={r.source} row={r} now={now} />
              ))}
          </div>
        ) : null}
        {sources.some((r) => r.state === 'disabled') ? (
          <details className="mt-4 rounded-xl border border-line bg-surface p-4 shadow-card">
            <summary className="focus-ring w-fit cursor-pointer rounded-sm text-[13px] font-medium text-accent-text hover:underline">
              꺼진 원천 {sources.filter((r) => r.state === 'disabled').length}개 상세 (수집 방식·한도·주의 사항)
            </summary>
            <div className="mt-3 grid gap-4 md:grid-cols-2">
              {sources
                .filter((r) => r.state === 'disabled')
                .map((r) => (
                  <SourceCard key={r.source} row={r} now={now} />
                ))}
            </div>
          </details>
        ) : null}
      </Section>

      <Section id="cov-runs">
        <Card flush>
          <div className="p-4 pb-2 sm:p-5 sm:pb-2">
            <CardHeader
              icon={<Activity className="size-4" />}
              title="수집 실행 기록"
              description={`원천별 실행 ${formatInteger(runStats.total)}회 · 실패·일부 실패 ${formatInteger(runStats.problems)}회. 최신 순.`}
              className="mb-0"
            />
          </div>
          <RunsTable runs={runs} labels={labels} />
        </Card>
        <Card className="mt-4">
          <CardHeader icon={<FileText className="size-4" />} title="내보내기 메모" description="데이터셋을 만들 때 줄이거나 뺀 것 (조용히 자르지 않음)." />
          {dataset.exportNotes.length ? (
            <ul className="list-disc space-y-1 pl-5 text-[13px] text-fg-2">
              {dataset.exportNotes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-fg-3">메모 없음</p>
          )}
        </Card>
      </Section>

      <Section id="cov-definitions">
        <Card>
          <CardHeader icon={<Ruler className="size-4" />} title="숫자 표시 규칙" description="모든 지표 값에는 상태 표시가 붙음. 값에 마우스를 올리거나 초점을 두면 이유와 기준 시각이 나옴." />
          <StatusLegend now={now} />
        </Card>
        <Card className="mt-4">
          <CardHeader icon={<Clock className="size-4" />} title="세 가지 날짜 기준" description="한 화면에서 섞지 않으며 항상 어떤 기준인지 표시함." />
          <dl className="grid gap-3 md:grid-cols-3">
            {(['upload', 'activity', 'age'] as const).map((m) => (
              <div key={m} className="rounded-lg border border-line p-3">
                <dt className="text-[13px] font-semibold text-fg">{DATE_MODE_LABELS[m]}</dt>
                <dd className="mt-0.5 text-[13px] text-fg-2">{DATE_MODE_DESCRIPTIONS[m]}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-xs text-fg-3">
            롤링 기간(최근 24시간·168시간(7일)·720시간(30일))은 데이터 기준 시각에 정확히 끝나 Dailymotion 원천 기간값을 쓸 수 있음. 날짜 기간은 선택한 시간대의 하루
            단위(양 끝 포함)임.
          </p>
        </Card>
        <Card className="mt-4">
          <CardHeader icon={<CircleHelp className="size-4" />} title="지표 정의와 주의 사항" />
          <CaveatList items={METRIC_CAVEATS} />
        </Card>
      </Section>

      <Section id="cov-not-offered">
        <Card>
          <CardHeader icon={<Ban className="size-4" />} title="제공하지 않는 기능" description="공개 지표로는 알 수 없는 것을 추정해서 채우지 않음." />
          <ul className="grid gap-3 md:grid-cols-2">
            <NotOffered title="Audience Ratings (시청자 규모·시청 시간)">
              30초 시청, 시청 분, 월간 실제 시청자, GRP 같은 지표는 시청자 패널·측정 모델이 있어야 함. 공개 조회수는 재생 횟수이지 사람 수가 아니므로 이 값으로 바꿔 계산하지
              않음.
            </NotOffered>
            <NotOffered title="Consumer Insights (시청자 관심·구매 행동)">
              영상 시청과 웹 방문·검색·쇼핑을 잇는 분석은 동의 기반 소비자 패널과 데이터 제휴가 필요함. 우리는 개인 단위 데이터를 모으지 않으며, 협찬 영상과 판매의 인과도
              주장하지 않음.
            </NotOffered>
            <NotOffered title="시청자 인구통계·지역">
              나이·성별·시청 국가는 채널 소유자만 보는 비공개 분석 정보임. '업로드 국가(원천 제공)'는 업로더 설정이지 시청 지역이 아님.
            </NotOffered>
            <NotOffered title="시청 시간·완주율·수익">
              공개 API가 다른 채널의 시청 시간·유지율·수익을 제공하지 않음. 협찬 금액·계약 정보도 없음 (브랜드 협업은 공개 텍스트 신호만 씀).
            </NotOffered>
          </ul>
          <p className="mt-3 text-xs text-fg-3">
            필요하면 패널 데이터 공급자와의 계약이나 채널 소유자 인증(OAuth) 연동이 먼저 필요함. 그 전까지 이 화면들은 만들지 않음.
          </p>
        </Card>
      </Section>

      <Section id="cov-enable">
        <Card>
          <CardHeader icon={<KeyRound className="size-4" />} title="원천 추가하기" description="인증 정보가 있으면 해당 원천이 다음 수집부터 자동으로 켜짐." />
          <EnableSources rows={sources} />
          <p className="mt-3 text-xs text-fg-3">
            같은 데이터와 계산을 프로그램에서 쓰려면{' '}
            <Link to="/api-docs" className="focus-ring rounded-sm text-accent-text hover:underline">
              API 문서
            </Link>
            를 참고.
          </p>
        </Card>
      </Section>

      <SourceNote asOf={now} coverageLink={false} sources={[`원천 ${summary.enabled}개 켜짐`, `분류기 ${dataset.classifierVersion}`]} />
    </div>
  );
}

function Section({ id, children }: { id: string; children: ReactNode }) {
  return (
    <section id={id} tabIndex={-1} className="scroll-mt-4 outline-none">
      {children}
    </section>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-fg-3">{label}</dt>
      <dd className="truncate text-fg tabular">{children}</dd>
    </div>
  );
}

function NotOffered({ title, children }: { title: string; children: ReactNode }) {
  return (
    <li className="rounded-lg border border-line p-3">
      <p className="flex items-center gap-1.5 text-[13px] font-semibold text-fg">
        <Badge tone="neutral">미제공</Badge>
        {title}
      </p>
      <p className="mt-1 text-[13px] text-fg-2">{children}</p>
    </li>
  );
}
