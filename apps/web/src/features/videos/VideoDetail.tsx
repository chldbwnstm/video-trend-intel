/**
 * Video detail drawer (/videos?v=<id>): identity + provenance of every field, metrics under the page's
 * current date semantics, Video Ratings (V1..V30), cumulative views from our observations, daily
 * increments, likes/comments, the raw observation table, source-reported windows, classification
 * evidence, topics and sponsorship evidence. Each block has its own error boundary.
 */
import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ageValues, computeVideoMetrics, indexAsOf } from '@vti/core';
import type { AgeDays, DateMode, MetricValue, UtcWindow, Video } from '@vti/core';
import { ExternalLink, Filter, UserRound } from 'lucide-react';
import {
  Badge,
  CategoryChip,
  Drawer,
  EmptyState,
  GrowthChart,
  MetricCell,
  PlatformBadge,
  SectionBoundary,
  StatRow,
  VideoThumb,
  VideoTitleLink,
  safeHttpUrl,
} from '../../components/index.ts';
import type { GrowthSeries } from '../../components/index.ts';
import { useDataset } from '../../data/hooks.ts';
import { countryLabel, fmtTime, languageLabel } from '../../lib/display.ts';
import { formatDuration, formatInteger, formatRelative } from '../../lib/format.ts';
import { STATUS_META } from '../../lib/metricStatus.ts';
import { platformLabel } from '../../lib/platform.ts';
import { tzShort } from '../../lib/timezones.ts';
import { hrefWith } from '../../lib/urlState.ts';
import type { ParamPatch } from '../../lib/urlState.ts';
import {
  AGE_ROWS,
  ASSIGNED_BY_LABELS,
  creatorKeyOf,
  dailyViewIncrements,
  EVIDENCE_FIELD_LABELS,
  FORMAT_FILTER_LABELS,
  LANGUAGE_SOURCE_LABELS,
  METRIC_KEY_LABELS,
  metricSource,
  observedMetric,
  SPONSOR_LEVEL_LABELS,
  summarizeStatuses,
  VIDEO_STATUS_LABELS,
  windowHoursLabel,
} from './model.ts';
import { ViewsChart } from './ViewsChart.tsx';
import { WatchButton } from '../watchlist/WatchButton.tsx';

const DAY_MS = 86_400_000;
const MAX_OBS_ROWS = 200;

export interface DetailContext {
  mode: DateMode;
  /** Period window of the page (null in age mode). */
  window: UtcWindow | null;
  ageDays: AgeDays;
  /** e.g. `조회 발생 기간 · 최근 168시간(7일)`. */
  label: string;
  /** Date params carried into links from chips (mode, range, age). */
  linkParams: ParamPatch;
}

/* ------------------------------------------------------------------------------------------ drawer */

export interface VideoDetailDrawerProps {
  /** Selected video id ('' = closed). */
  videoId: string;
  onClose: () => void;
  context: DetailContext;
  onFilterAccount?: (accountId: string) => void;
}

export function VideoDetailDrawer({ videoId, onClose, context, onFilterAccount }: VideoDetailDrawerProps) {
  const { index } = useDataset();
  const video = videoId ? (index.videosById.get(videoId) ?? null) : null;
  const account = video ? (index.accountsById.get(video.accountId) ?? null) : null;
  return (
    <Drawer
      open={videoId !== ''}
      onClose={onClose}
      width="min(760px, 100vw)"
      title={video ? <span className="line-clamp-2">{video.title || '(제목 없음)'}</span> : '영상을 찾을 수 없음'}
      description={video ? `${platformLabel(video.platform)} · ${account?.name ?? video.accountId}` : videoId}
    >
      <SectionBoundary title="영상 상세를 표시하지 못함" resetKey={videoId}>
        {video ? <VideoDetailContent video={video} context={context} onFilterAccount={onFilterAccount} /> : <VideoNotFound id={videoId} />}
      </SectionBoundary>
    </Drawer>
  );
}

export function VideoNotFound({ id }: { id: string }) {
  return (
    <EmptyState
      title="영상을 찾을 수 없음"
      description={
        <>
          <span className="font-mono break-all">{id}</span>는 현재 데이터셋에 없음. 링크가 잘못됐거나, 내보내기 용량 제한으로 빠진 영상일 수
          있음.
        </>
      }
      action={
        <Link to="/coverage" className="focus-ring rounded-sm text-sm text-accent-text hover:underline">
          데이터 범위 확인
        </Link>
      }
    />
  );
}

/* ------------------------------------------------------------------------------------------ content */

function Section({ title, description, children, id }: { title: string; description?: ReactNode; children: ReactNode; id: string }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2 border-t border-line px-4 py-4 first:border-t-0">
      <div>
        <h3 id={id} className="text-sm font-semibold text-fg">
          {title}
        </h3>
        {description ? <p className="mt-0.5 text-xs text-fg-3">{description}</p> : null}
      </div>
      <SectionBoundary title={`이 영역을 표시하지 못함: ${title}`} compact>
        {children}
      </SectionBoundary>
    </section>
  );
}

export interface VideoDetailContentProps {
  video: Video;
  context: DetailContext;
  onFilterAccount?: (accountId: string) => void;
}

export function VideoDetailContent({ video, context, onFilterAccount }: VideoDetailContentProps) {
  const { index, now, tz } = useDataset();
  const account = index.accountsById.get(video.accountId) ?? null;
  const creatorKey = creatorKeyOf(index, video.accountId);
  const linked = index.creatorOfAccount.has(video.accountId);
  const tzs = tzShort(tz);
  const at = (ms: number | null | undefined) => (ms === null || ms === undefined ? '—' : `${fmtTime(ms, tz)} ${tzs}`);

  return (
    <div className="flex flex-col pb-4">
      {/* ------------------------------------------------ hero */}
      <div className="flex flex-col gap-3 p-4 sm:flex-row">
        <div className="w-full shrink-0 sm:w-56">
          <VideoThumb video={video} size="lg" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <VideoTitleLink video={video} lines={3} icon className="text-base" />
          <div className="flex flex-wrap items-center gap-1.5">
            <PlatformBadge platform={video.platform} />
            <Badge>{FORMAT_FILTER_LABELS[video.format]}</Badge>
            {video.status !== 'active' ? <Badge tone="negative">{VIDEO_STATUS_LABELS[video.status]}</Badge> : null}
            {video.sponsorship ? (
              <Badge tone={video.sponsorship.level === 'disclosed' ? 'warning' : 'neutral'}>{SPONSOR_LEVEL_LABELS[video.sponsorship.level]}</Badge>
            ) : null}
          </div>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-fg-2">
            <UserRound className="size-4 shrink-0 text-fg-3" aria-hidden />
            <Link to={`/creators/${encodeURIComponent(creatorKey)}`} className="focus-ring rounded-sm font-medium text-accent-text hover:underline">
              {account?.name ?? video.accountId}
            </Link>
            {linked ? <Badge tone="info">크리에이터 연결됨</Badge> : null}
            {onFilterAccount ? (
              <button
                type="button"
                onClick={() => onFilterAccount(video.accountId)}
                className="focus-ring inline-flex items-center gap-1 rounded-sm text-xs text-fg-3 hover:text-fg hover:underline"
              >
                <Filter className="size-3.5" aria-hidden />이 계정 영상만 보기
              </button>
            ) : null}
          </p>
          {safeHttpUrl(video.url) ? (
            <a
              href={safeHttpUrl(video.url)!}
              target="_blank"
              rel="noopener noreferrer"
              className="focus-ring inline-flex w-fit items-center gap-1 rounded-sm text-[13px] text-accent-text hover:underline"
            >
              {platformLabel(video.platform)}에서 원본 보기 <ExternalLink className="size-3.5" aria-hidden />
            </a>
          ) : null}
          <WatchButton kind="video" id={video.id} />
        </div>
      </div>

      <Section id="vd-info" title="기본 정보" description="원천이 제공한 값과 우리 수집 기록. 없는 값은 비워 둠.">
        <dl>
          <StatRow label="게시">
            {at(video.publishedAt)} <span className="text-fg-3">({formatRelative(video.publishedAt, now)})</span>
          </StatRow>
          <StatRow label="형식">{FORMAT_FILTER_LABELS[video.format]}</StatRow>
          <StatRow label="길이">{video.durationSec !== null ? formatDuration(video.durationSec) : <span className="text-fg-3">원천 미제공</span>}</StatRow>
          <StatRow label="영상 언어">
            {video.language ? (
              <>
                {languageLabel(video.language)} <span className="text-fg-3">({video.language}{video.languageSource ? ` · ${LANGUAGE_SOURCE_LABELS[video.languageSource]}` : ''})</span>
              </>
            ) : (
              <span className="text-fg-3">미상</span>
            )}
          </StatRow>
          <StatRow label="업로드 국가(원천 제공)">
            {video.country ? (
              <>
                {countryLabel(video.country)} <span className="text-fg-3">({video.country.toUpperCase()} · 시청 지역 아님)</span>
              </>
            ) : (
              <span className="text-fg-3">원천 미제공</span>
            )}
          </StatRow>
          <StatRow label="원천 분류">{video.sourceCategory ?? <span className="text-fg-3">없음</span>}</StatRow>
          <StatRow label="상태">{VIDEO_STATUS_LABELS[video.status]}</StatRow>
          <StatRow label="처음 발견">{at(video.firstSeenAt)}</StatRow>
          <StatRow label="마지막 관측">
            {at(video.lastObservedAt)} <span className="text-fg-3">({formatRelative(video.lastObservedAt, now)})</span>
          </StatRow>
          <StatRow label="발견 경로">
            {video.discoveredVia.length ? (
              <span className="flex flex-wrap justify-end gap-1">
                {video.discoveredVia.map((d) => (
                  <code key={d} className="rounded bg-surface-3 px-1.5 py-px text-[11px] break-all text-fg-2">
                    {d}
                  </code>
                ))}
              </span>
            ) : (
              <span className="text-fg-3">기록 없음</span>
            )}
          </StatRow>
          <StatRow label="영상 ID">
            <code className="text-xs break-all">{video.id}</code>
          </StatRow>
        </dl>
      </Section>

      <Section id="vd-metrics" title="현재 조건의 지표" description={`${context.label} 기준. 백분위는 결과 목록 안에서만 계산됨.`}>
        <CurrentMetrics video={video} context={context} />
      </Section>

      <Section
        id="vd-ratings"
        title="비디오 레이팅 (게시 후 경과 조회)"
        description="게시 후 1·2·3·7·30일 시점의 누적 조회. 그 시점 앞뒤 관측이 있어야 계산됨."
      >
        <AgeRatings video={video} />
      </Section>

      <Section
        id="vd-curve"
        title="누적 조회 추이"
        description="점은 실제 관측, 점선은 관측 사이를 잇는 보간(≈). 넓은 관측 공백은 보간하지 않음."
      >
        <ViewsChart video={video} />
      </Section>

      <Section id="vd-daily" title="일별 조회 증가" description={`${tzs} 날짜 기준 하루 증가량(최근 14일, 게시일 이후). 자정 앞뒤 관측이 있어야 정확함.`}>
        <DailyBars video={video} />
      </Section>

      <Section id="vd-reactions" title="좋아요·댓글 추이" description="원천이 제공한 누적 반응 수. 제공되지 않은 항목은 0이 아니라 없음으로 둠.">
        <ReactionSeries video={video} />
      </Section>

      <Section
        id="vd-obs"
        title="원본 관측값"
        description={`이 서비스가 아래 시각(${tzs})에 공개 원천에서 직접 읽은 값. 그 사이 값은 보간이며 플랫폼의 실시간 값과 다를 수 있음.`}
      >
        <ObservationTable video={video} />
      </Section>

      <Section id="vd-windows" title="원천 제공 기간 지표" description="플랫폼이 직접 집계해 준 기간 값. 관측 시각에 끝나는 기간에만 유효하며 우리 관측으로 계산한 값이 아님.">
        <SourceWindows video={video} />
      </Section>

      <Section
        id="vd-cats"
        title="분야와 분류 근거"
        description={
          <>
            규칙 기반 자동 분류. 일치한 단어와 필드를 근거로 표시함.{' '}
            <Link to="/taxonomy" className="focus-ring rounded-sm text-accent-text hover:underline">
              분류 체계 보기
            </Link>
          </>
        }
      >
        <Classification video={video} linkParams={context.linkParams} />
      </Section>

      <Section id="vd-topics" title="주제" description="해시태그·태그·제목에서 뽑은 주제 키. 누르면 같은 주제의 영상을 봄.">
        {video.topics.length ? (
          <ul className="flex flex-wrap gap-1.5" aria-label="주제 목록">
            {video.topics.map((t) => (
              <li key={t}>
                <Link
                  to={hrefWith('/videos', { ...context.linkParams, topics: [t] })}
                  className="focus-ring inline-flex max-w-full items-center rounded-md border border-line bg-surface-2 px-2 py-0.5 text-xs text-fg-2 hover:text-accent-text hover:underline"
                >
                  <span className="truncate">#{t}</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-fg-3">추출된 주제 없음.</p>
        )}
      </Section>

      <Section id="vd-sponsor" title="협찬 신호" description="공개 표기 문구·브랜드 단서를 찾는 규칙 기반 탐지. 광고 여부를 확정하지 않음.">
        <Sponsorship video={video} />
      </Section>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ blocks */

function CurrentMetrics({ video, context }: { video: Video; context: DetailContext }) {
  const { index, now } = useDataset();
  const m = useMemo(
    () =>
      computeVideoMetrics(video, {
        mode: context.mode,
        window: context.window,
        ageDays: context.mode === 'age' ? context.ageDays : null,
        now,
        index: indexAsOf(index, now),
      }),
    [video, context.mode, context.window, context.ageDays, now, index],
  );
  const src = (x: MetricValue) => metricSource(video, x);
  const primaryLabel = context.mode === 'upload' ? '게시 후 조회' : context.mode === 'activity' ? '기간 조회 증가' : `V${context.ageDays} 조회`;
  const likesLabel = context.mode === 'upload' ? '게시 후 좋아요' : context.mode === 'activity' ? '기간 좋아요 증가' : `V${context.ageDays} 좋아요`;
  const commentsLabel = context.mode === 'upload' ? '게시 후 댓글' : context.mode === 'activity' ? '기간 댓글 증가' : `V${context.ageDays} 댓글`;
  const items: { label: string; node: ReactNode; sub?: string }[] = [
    { label: primaryLabel, node: <MetricCell metric={context.mode === 'age' ? m.viewsAtAge : m.viewsPeriod} label={primaryLabel} source={src(m.viewsPeriod)} size="md" align="left" /> },
    { label: '누적 조회', node: <MetricCell metric={m.viewsTotal} label="누적 조회" source={src(m.viewsTotal)} size="md" align="left" /> },
    { label: '증가 속도', node: <MetricCell metric={m.velocity} kind="perHour" label="증가 속도" size="md" align="left" />, sub: '최근 약 24시간' },
    ...(context.mode === 'activity'
      ? [{ label: '이전 기간 대비', node: <MetricCell metric={m.growthVsPrev} kind="growth" label="이전 기간 대비" size="md" align="left" />, sub: '같은 길이 직전 기간' }]
      : []),
    { label: likesLabel, node: <MetricCell metric={m.likesPeriod} label={likesLabel} source={src(m.likesPeriod)} size="md" align="left" /> },
    { label: commentsLabel, node: <MetricCell metric={m.commentsPeriod} label={commentsLabel} source={src(m.commentsPeriod)} size="md" align="left" /> },
    { label: '참여율', node: <MetricCell metric={m.engagementRate} kind="rate" label="참여율" size="md" align="left" /> },
    {
      label: '평소 대비',
      node: (
        <MetricCell
          metric={m.outperformance}
          kind="multiplier"
          label="평소 대비"
          size="md"
          align="left"
          extra={m.outperformance.ageDays ? `V${m.outperformance.ageDays} 기준, 같은 계정 비교 영상 ${m.outperformance.peers}개의 중앙값 대비.` : undefined}
        />
      ),
      sub: m.outperformance.ageDays ? `V${m.outperformance.ageDays} · 비교 ${m.outperformance.peers}개` : '같은 계정 중앙값 대비',
    },
  ];
  return (
    <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {items.map((it) => (
        <div key={it.label} className="min-w-0 rounded-lg border border-line bg-surface-2 px-3 py-2">
          <dt className="truncate text-xs text-fg-3">{it.label}</dt>
          <dd className="mt-0.5">{it.node}</dd>
          {it.sub ? <dd className="truncate text-[11px] text-fg-3">{it.sub}</dd> : null}
        </div>
      ))}
    </dl>
  );
}

function AgeRatings({ video }: { video: Video }) {
  const { now, tz } = useDataset();
  const values = useMemo(() => ageValues(video, now), [video, now]);
  const src = metricSource(video, null);
  return (
    <div className="scroll-thin overflow-x-auto rounded-md border border-line">
      <table className="w-full min-w-[420px] text-[13px]">
        <caption className="sr-only">게시 후 경과일별 누적 조회 (V1~V30)</caption>
        <thead>
          <tr className="bg-surface-2 text-xs text-fg-3">
            <th scope="col" className="px-3 py-1.5 text-left font-medium">
              지표
            </th>
            <th scope="col" className="px-3 py-1.5 text-left font-medium">
              기준 시각 ({tzShort(tz)})
            </th>
            <th scope="col" className="px-3 py-1.5 text-right font-medium">
              조회
            </th>
            <th scope="col" className="px-3 py-1.5 text-left font-medium">
              상태
            </th>
          </tr>
        </thead>
        <tbody>
          {AGE_ROWS.map((d) => {
            const v = values[d];
            const target = video.publishedAt + d * DAY_MS;
            return (
              <tr key={d} className="border-t border-line">
                <th scope="row" className="px-3 py-1.5 text-left font-medium text-fg">
                  V{d} <span className="font-normal text-fg-3">게시 후 {d}일</span>
                </th>
                <td className="px-3 py-1.5 text-fg-2 tabular">
                  {fmtTime(target, tz)}
                  {target > now ? <span className="ml-1 text-fg-3">(도달 전)</span> : null}
                </td>
                <td className="px-3 py-1.5 text-right">
                  <MetricCell metric={v} label={`V${d} 조회`} source={src} />
                </td>
                <td className="px-3 py-1.5 text-xs text-fg-3">{STATUS_META[v.status].label}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function DailyBars({ video }: { video: Video }) {
  const { now, tz } = useDataset();
  const days = useMemo(() => dailyViewIncrements(video, tz, now), [video, tz, now]);
  const series = useMemo(
    (): GrowthSeries[] => [
      {
        id: 'views',
        label: '일별 조회 증가',
        points: days.map((d) => ({ x: d.date, value: STATUS_META[d.value.status].showsValue ? d.value.value : null, status: d.value.status })),
      },
    ],
    [days],
  );
  const summary = summarizeStatuses(days.map((d) => d.value));
  const parts = (['exact', 'interpolated', 'lower_bound', 'decrease_flagged', 'unavailable'] as const)
    .filter((s) => summary.counts[s])
    .map((s) => `${STATUS_META[s].label} ${summary.counts[s]}일`);
  return (
    <div className="flex flex-col gap-1.5">
      <GrowthChart
        series={series}
        variant="bar"
        title="일별 조회 증가"
        height={180}
        empty={
          <span className="px-4 text-center">
            하루 경계(자정) 앞뒤 관측이 아직 없어 일별 증가를 계산할 수 없음. 수집이 이어지면 채워짐.
          </span>
        }
      />
      {days.length ? <p className="text-xs text-fg-3">{days.length}일 중 {parts.join(' · ')}. 막대 값의 상태는 툴팁·표에서 확인.</p> : null}
    </div>
  );
}

function ReactionSeries({ video }: { video: Video }) {
  const obs = video.obs;
  const likes = obs.filter((o) => o.likes !== null);
  const comments = obs.filter((o) => o.comments !== null);
  const series: GrowthSeries[] = [];
  if (likes.length) series.push({ id: 'likes', label: '좋아요', color: 'var(--series-1)', points: likes.map((o) => ({ x: o.t, value: o.likes, status: 'exact' as const })) });
  if (comments.length)
    series.push({ id: 'comments', label: '댓글', color: 'var(--series-2)', points: comments.map((o) => ({ x: o.t, value: o.comments, status: 'exact' as const })) });
  const missing = [likes.length ? null : '좋아요', comments.length ? null : '댓글'].filter(Boolean).join('·');
  const enough = likes.length >= 2 || comments.length >= 2;
  return (
    <div className="flex flex-col gap-1.5">
      {!series.length ? (
        <p className="text-[13px] text-fg-3">원천이 좋아요·댓글 수를 제공하지 않음.</p>
      ) : enough ? (
        <GrowthChart series={series} title="좋아요·댓글 누적" height={180} xStyle="datetime" />
      ) : (
        <p className="text-[13px] text-fg-3">
          관측 1회뿐이라 추이를 그릴 수 없음 (최근 값은 아래 원본 관측값 표 참고). 관측이 2회 이상 쌓이면 표시됨.
        </p>
      )}
      {series.length && missing ? <p className="text-xs text-fg-3">{missing}: 원천 미제공 (0으로 계산하지 않음).</p> : null}
    </div>
  );
}

function ObservationTable({ video }: { video: Video }) {
  const { tz } = useDataset();
  const rows = useMemo(() => [...video.obs].sort((a, b) => b.t - a.t), [video]);
  if (!rows.length) return <p className="text-[13px] text-fg-3">관측 기록 없음.</p>;
  const shown = rows.slice(0, MAX_OBS_ROWS);
  const keys = ['views', 'likes', 'comments', 'shares'] as const;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="scroll-thin max-h-80 overflow-auto rounded-md border border-line">
        <table className="w-full min-w-[520px] text-[13px]">
          <caption className="sr-only">원본 관측값 (최근 순)</caption>
          <thead>
            <tr className="text-xs text-fg-3">
              <th scope="col" className="sticky top-0 bg-surface-2 px-3 py-1.5 text-left font-medium">
                관측 시각 ({tzShort(tz)})
              </th>
              {keys.map((k) => (
                <th key={k} scope="col" className="sticky top-0 bg-surface-2 px-3 py-1.5 text-right font-medium">
                  {METRIC_KEY_LABELS[k]}
                </th>
              ))}
              <th scope="col" className="sticky top-0 bg-surface-2 px-3 py-1.5 text-left font-medium">
                원천
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((o, i) => (
              <tr key={`${o.t}-${i}`} className="border-t border-line">
                <th scope="row" className="px-3 py-1.5 text-left font-normal whitespace-nowrap text-fg-2 tabular">
                  {fmtTime(o.t, tz)}
                </th>
                {keys.map((k) => (
                  <td key={k} className="px-3 py-1.5 text-right">
                    <MetricCell metric={observedMetric(o[k], o.t)} label={`관측 ${METRIC_KEY_LABELS[k]}`} source={o.src} />
                  </td>
                ))}
                <td className="px-3 py-1.5 text-xs text-fg-3">
                  <code>{o.src}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-fg-3">
        관측 {formatInteger(rows.length)}회{rows.length > MAX_OBS_ROWS ? ` 중 최근 ${MAX_OBS_ROWS}회 표시` : ''}. 내보내기에서 오래된 관측은 간격을 두고 압축됨(원자료는
        수집 저장소에 보존).
      </p>
    </div>
  );
}

function SourceWindows({ video }: { video: Video }) {
  const { tz } = useDataset();
  if (!video.sourceWindows.length) return <p className="text-[13px] text-fg-3">이 영상의 원천은 기간 집계값을 제공하지 않음.</p>;
  const rows = [...video.sourceWindows].sort((a, b) => b.observedAt - a.observedAt || a.windowHours - b.windowHours);
  return (
    <div className="scroll-thin overflow-x-auto rounded-md border border-line">
      <table className="w-full min-w-[460px] text-[13px]">
        <caption className="sr-only">원천 제공 기간 지표</caption>
        <thead>
          <tr className="bg-surface-2 text-xs text-fg-3">
            <th scope="col" className="px-3 py-1.5 text-left font-medium">
              지표
            </th>
            <th scope="col" className="px-3 py-1.5 text-left font-medium">
              기간
            </th>
            <th scope="col" className="px-3 py-1.5 text-right font-medium">
              값
            </th>
            <th scope="col" className="px-3 py-1.5 text-left font-medium">
              관측 시각 ({tzShort(tz)})
            </th>
            <th scope="col" className="px-3 py-1.5 text-left font-medium">
              원천
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((w, i) => (
            <tr key={`${w.metric}-${w.windowHours}-${w.observedAt}-${i}`} className="border-t border-line">
              <td className="px-3 py-1.5 whitespace-nowrap">{METRIC_KEY_LABELS[w.metric] ?? w.metric}</td>
              <td className="px-3 py-1.5 whitespace-nowrap">{windowHoursLabel(w.windowHours)}</td>
              <td className="px-3 py-1.5 text-right">
                <MetricCell
                  metric={{ value: w.value, status: 'source_reported', asOf: w.observedAt, note: 'source_window' }}
                  label={`${windowHoursLabel(w.windowHours)} ${METRIC_KEY_LABELS[w.metric] ?? w.metric}`}
                  source={w.src}
                />
              </td>
              <td className="px-3 py-1.5 whitespace-nowrap text-fg-2 tabular">{fmtTime(w.observedAt, tz)}</td>
              <td className="px-3 py-1.5 text-xs text-fg-3">
                <code>{w.src}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Classification({ video, linkParams }: { video: Video; linkParams: ParamPatch }) {
  if (!video.categories.length) {
    return <p className="text-[13px] text-fg-3">분류되지 않음: 키워드 규칙·원천 분류·계정 분야 어느 것도 일치하지 않았음.</p>;
  }
  const cats = [...video.categories].sort((a, b) => b.confidence - a.confidence);
  return (
    <ul className="flex flex-col gap-2">
      {cats.map((c) => (
        <li key={c.id} className="rounded-lg border border-line px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <CategoryChip id={c.id} to={hrefWith('/videos', { ...linkParams, cats: [c.id] })} confidence={c.confidence} />
            <span className="text-xs text-fg-2">신뢰도 {Math.round(c.confidence * 100)}%</span>
            <span className="text-xs text-fg-3">· {ASSIGNED_BY_LABELS[c.by] ?? c.by}</span>
            <span className="ml-auto text-[11px] text-fg-3">
              <code>{c.version}</code>
            </span>
          </div>
          {c.evidence.length ? (
            <ul className="mt-1.5 flex flex-wrap gap-1.5" aria-label="분류 근거">
              {c.evidence.map((e, i) => (
                <li key={`${e.field}-${e.match}-${i}`} className="rounded bg-surface-2 px-1.5 py-px text-xs text-fg-2">
                  <span className="text-fg-3">{EVIDENCE_FIELD_LABELS[e.field] ?? e.field}:</span> {e.match}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-xs text-fg-3">근거 기록 없음.</p>
          )}
        </li>
      ))}
    </ul>
  );
}

function Sponsorship({ video }: { video: Video }) {
  const s = video.sponsorship;
  if (!s) return <p className="text-[13px] text-fg-3">감지된 협찬 신호 없음 (제목·설명·태그의 광고 표기 문구와 브랜드 단서 기준).</p>;
  return (
    <div className="flex flex-col gap-1.5 text-[13px]">
      <p className="flex flex-wrap items-center gap-2">
        <Badge tone={s.level === 'disclosed' ? 'warning' : 'neutral'}>{SPONSOR_LEVEL_LABELS[s.level]}</Badge>
        <span className="text-fg-2">
          {s.level === 'disclosed' ? '유료 광고 포함 등 공개 표기 문구가 있음.' : '브랜드·프로모션 단서만 있음 (표기 없음).'}
        </span>
        <span className="ml-auto text-[11px] text-fg-3">
          <code>{s.version}</code>
        </span>
      </p>
      <p>
        <span className="text-fg-3">브랜드:</span>{' '}
        {s.brands.length ? s.brands.join(', ') : <span className="text-fg-3">특정되지 않음</span>}
        {s.brands.length ? (
          <>
            {' · '}
            <Link to={hrefWith('/brands', {})} className="focus-ring rounded-sm text-accent-text hover:underline">
              브랜드 협업 보기
            </Link>
          </>
        ) : null}
      </p>
      {s.evidence.length ? (
        <ul className="flex flex-wrap gap-1.5" aria-label="협찬 근거">
          {s.evidence.map((e, i) => (
            <li key={`${e.field}-${e.match}-${i}`} className="rounded bg-surface-2 px-1.5 py-px text-xs text-fg-2">
              <span className="text-fg-3">{EVIDENCE_FIELD_LABELS[e.field] ?? e.field}:</span> {e.match}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
