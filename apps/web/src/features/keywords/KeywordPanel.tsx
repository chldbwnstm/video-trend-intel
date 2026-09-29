/**
 * One keyword's detail: top videos (period views, -> /videos?v=), top creators (-> /creators/:key), platform /
 * category / language split, related topics (click = add as keyword), sponsorship share and brands
 * (-> /brands). Everything is "within the tracked set"; metric numbers go through MetricCell.
 */
import { Link } from 'react-router-dom';
import type { KeywordAnalysis, KeywordReport, VideoRow } from '@vti/core';
import { ArrowRight, Handshake, Hash, Languages, Layers, FolderTree, Plus, Search, Trophy, Users } from 'lucide-react';
import { BarList, Button, Card, CardHeader, Chip, DataTable, EmptyState, MetricCell, PlatformBadge, SectionGrid, Tooltip, VideoCell } from '../../components/index.ts';
import type { Column } from '../../components/index.ts';
import { useDataset } from '../../data/hooks.ts';
import { catLabel, fmtTime, languageLabel } from '../../lib/display.ts';
import { formatInteger } from '../../lib/format.ts';
import { platformColor, platformLabel } from '../../lib/platform.ts';
import { hrefWith } from '../../lib/urlState.ts';
import { creatorHref } from '../creators/logic.ts';
import { videoHref } from '../trends/logic.ts';
import { brandHref, categoryVideosHref, FIELD_LABELS, keywordKey, MAX_KEYWORDS, shareText, TERM_MODE_LABELS, topicVideosHref, videosSearchHref } from './model.ts';
import type { ScopeParams } from './model.ts';
import { KeywordDot } from './Comparison.tsx';
import { WatchButton } from '../watchlist/WatchButton.tsx';

export interface KeywordPanelProps {
  analysis: KeywordAnalysis;
  report: KeywordReport;
  index: number;
  scope: ScopeParams;
  selected: string[];
  onAddKeyword: (k: string) => void;
  stale?: boolean;
}

const linkCls = 'focus-ring inline-flex items-center gap-1 rounded-sm text-[13px] font-medium text-accent-text hover:underline';

export function KeywordPanel({ analysis, report: r, index, scope, selected, onAddKeyword, stale }: KeywordPanelProps) {
  const fieldText = (Object.keys(r.fieldHits) as (keyof typeof r.fieldHits)[])
    .filter((f) => r.fieldHits[f] > 0)
    .map((f) => `${FIELD_LABELS[f]} ${formatInteger(r.fieldHits[f])}`)
    .join(' · ');
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-lg font-semibold text-fg">
              <KeywordDot index={index} />
              <span className="min-w-0 [overflow-wrap:anywhere]">{r.keyword}</span>
            </h2>
            <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[13px] text-fg-3">
              <span>
                일치 영상 <b className="font-semibold text-fg">{formatInteger(r.videos)}</b>개 · 계정 {formatInteger(r.accounts)}개
              </span>
              <span>
                기간 업로드 <b className="font-semibold text-fg">{formatInteger(r.uploadsInWindow)}</b>개
              </span>
              {fieldText ? <span>찾은 위치: {fieldText}</span> : null}
            </p>
            <p className="mt-1 flex flex-wrap items-center gap-1 text-xs text-fg-3">
              <span>검색 단어</span>
              {r.terms.map((t) => (
                <span key={t.text} className="rounded bg-surface-3 px-1.5 py-px text-fg-2">
                  {t.text} <span className="text-fg-3">· {TERM_MODE_LABELS[t.mode]}</span>
                </span>
              ))}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <WatchButton kind="keyword" id={r.keyword} size="md" />
            <Link to={videosSearchHref(r.keyword, scope)} className="focus-ring inline-flex h-9 items-center gap-1.5 rounded-md border border-line bg-surface px-3 text-sm font-medium text-fg hover:bg-surface-3">
              <Search className="size-4" aria-hidden />
              영상 탐색에서 보기
            </Link>
          </div>
        </div>
        <p className="mt-2 text-xs text-fg-3">
          영상 탐색 검색은 제목·태그·주제·계정 이름을 부분 일치로 찾아(설명 제외, 영문도 부분 일치) 결과 수가 이 화면과 조금 다를 수 있음.
        </p>
      </Card>

      {!r.videos ? (
        <Card>
          <EmptyState
            compact
            title={`'${r.keyword}'와 일치하는 추적 영상 없음`}
            description="이 서비스가 수집한 영상 범위 안에서만 찾음. 필터·기간을 넓히거나 다른 표기(영문·띄어쓰기)를 시도해 볼 것. 수집 범위는 데이터 범위 페이지에서 확인."
            action={
              <Link to="/coverage" className={linkCls}>
                데이터 범위 <ArrowRight className="size-3.5" aria-hidden />
              </Link>
            }
          />
        </Card>
      ) : (
        <SectionGrid>
          <Card className="lg:col-span-8" flush>
            <div className="p-4 pb-0 sm:p-5 sm:pb-0">
              <CardHeader
                icon={<Trophy className="size-4" />}
                title="기간 조회 증가 상위 영상"
                description="조회 발생 기간 기준: 게시일과 관계없이 이 기간에 조회수가 많이 늘어난 일치 영상. 백분위는 같은 플랫폼의 일치 영상 안에서."
                actions={
                  <Link to={videosSearchHref(r.keyword, scope)} className={linkCls}>
                    전체 <ArrowRight className="size-3.5" aria-hidden />
                  </Link>
                }
              />
            </div>
            <TopVideos rows={r.topVideos} range={scope.range} stale={stale} />
          </Card>

          <Card className="lg:col-span-4">
            <CardHeader icon={<Users className="size-4" />} title="상위 크리에이터·계정" description="일치 영상이 많은 순. 연결된 여러 플랫폼 계정은 한 크리에이터로 묶음." />
            <Creators report={r} range={scope.range} />
          </Card>

          <Card className="lg:col-span-4">
            <CardHeader icon={<Layers className="size-4" />} title="플랫폼" description="일치 영상 수와 플랫폼별 기간 조회 증가 (플랫폼끼리 단위가 달라 합치지 않음)." />
            <Platforms report={r} />
          </Card>

          <Card className="lg:col-span-4">
            <CardHeader icon={<FolderTree className="size-4" />} title="분야" description="분류기가 붙인 상위 분야 (한 영상이 여러 분야일 수 있음)." />
            {r.categories.length ? (
              <BarList
                label={`'${r.keyword}' 분야 분포`}
                items={r.categories.slice(0, 8).map((c) => ({
                  key: c.id,
                  label: catLabel(c.id),
                  value: c.count,
                  display: `${formatInteger(c.count)}개`,
                  to: categoryVideosHref(r.keyword, c.id, scope),
                }))}
                total={r.videos}
                showShare
              />
            ) : null}
            {r.uncategorized ? <p className="mt-2 text-xs text-fg-3">분야 미분류 {formatInteger(r.uncategorized)}개</p> : null}
          </Card>

          <Card className="lg:col-span-4">
            <CardHeader icon={<Languages className="size-4" />} title="영상 언어" description="영상 언어(원천 제공 또는 감지). 시청자 언어·지역 아님." />
            <BarList
              label={`'${r.keyword}' 영상 언어 분포`}
              items={r.languages.slice(0, 8).map((l) => ({
                key: l.code ?? 'unknown',
                label: l.code ? languageLabel(l.code) : '언어 미상',
                value: l.count,
                display: `${formatInteger(l.count)}개`,
              }))}
              total={r.videos}
              showShare
            />
          </Card>

          <Card className="lg:col-span-6">
            <CardHeader
              icon={<Hash className="size-4" />}
              title="함께 나오는 주제"
              description="이 키워드 영상에서 평소(필터 범위 전체)보다 자주 붙는 주제. 누르면 비교 키워드로 추가."
            />
            <RelatedTopics report={r} scope={scope} selected={selected} onAdd={onAddKeyword} />
          </Card>

          <Card className="lg:col-span-6">
            <CardHeader icon={<Handshake className="size-4" />} title="광고·협찬" description="설명·제목의 광고 표기와 협찬 추정 신호 기준 (판정 근거는 브랜드 협업 페이지)." />
            <Sponsorship report={r} range={scope.range} />
          </Card>
        </SectionGrid>
      )}

      {r.notes.length ? (
        <ul className="flex list-disc flex-col gap-0.5 pl-4 text-xs text-fg-3">
          {r.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
      <p className="sr-only">분석 기간 기준 시각 {fmtTime(analysis.now, analysis.tz)}</p>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ parts */

function TopVideos({ rows, range, stale }: { rows: VideoRow[]; range: string; stale?: boolean }) {
  const { tz } = useDataset();
  const columns: Column<VideoRow>[] = [
    { id: 'rank', header: '#', width: '2.5rem', align: 'right', hideBelow: 'sm', cell: (_r, i) => <span className="text-fg-3">{i + 1}</span> },
    {
      id: 'video',
      header: '영상',
      cell: (row) => (
        <VideoCell video={row.video} accountName={row.account?.name} publishedLabel={fmtTime(row.video.publishedAt, tz, 'date')} publishedTitle={fmtTime(row.video.publishedAt, tz)}>
          <Link to={videoHref(row.video.id, range)} className="focus-ring mt-0.5 inline-block rounded-sm text-xs text-accent-text hover:underline sm:hidden">
            상세 보기
          </Link>
        </VideoCell>
      ),
    },
    {
      id: 'period',
      header: '기간 조회 증가',
      align: 'right',
      width: '7rem',
      cell: (row) => <MetricCell metric={row.metrics.viewsPeriod} label="기간 조회 증가" source={row.video.obs[row.video.obs.length - 1]?.src ?? null} />,
    },
    {
      id: 'total',
      header: '누적 조회',
      align: 'right',
      width: '6.5rem',
      hideBelow: 'md',
      cell: (row) => <MetricCell metric={row.metrics.viewsTotal} label="누적 조회" />,
    },
    {
      id: 'pct',
      header: '플랫폼 내 백분위',
      align: 'right',
      width: '6.5rem',
      hideBelow: 'lg',
      hint: '같은 플랫폼의 일치 영상 중 기간 조회 증가 백분위. 플랫폼끼리 조회 단위가 달라 순위 비교에 이 값을 함께 봄.',
      cell: (row) => <MetricCell metric={row.metrics.percentile} kind="percentile" label="플랫폼 내 백분위" />,
    },
    {
      id: 'detail',
      header: <span className="sr-only">상세</span>,
      align: 'right',
      width: '3.5rem',
      hideBelow: 'sm',
      cell: (row) => (
        <Link to={videoHref(row.video.id, range)} className="focus-ring rounded-sm text-[13px] whitespace-nowrap text-accent-text hover:underline" aria-label={`'${row.video.title}' 상세 보기`}>
          상세
        </Link>
      ),
    },
  ];
  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(row) => row.video.id}
      caption="키워드 일치 영상 중 기간 조회 증가 상위"
      minWidth="320px"
      stale={stale}
      empty={<EmptyState compact title="표시할 영상 없음" />}
    />
  );
}

function Creators({ report: r, range }: { report: KeywordReport; range: string }) {
  if (!r.topCreators.length) return <p className="text-sm text-fg-3">없음</p>;
  return (
    <ol className="flex flex-col divide-y divide-line">
      {r.topCreators.map((c) => (
        <li key={c.key} className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
          <div className="min-w-0">
            <Link to={creatorHref(c.key, { range })} className="focus-ring block truncate rounded-sm text-sm font-medium text-fg hover:text-accent-text hover:underline">
              {c.name}
            </Link>
            <div className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-fg-3">
              {c.platforms.map((p) => (
                <PlatformBadge key={p} platform={p} size="xs" iconOnly={c.platforms.length > 2} />
              ))}
              <span>
                영상 {formatInteger(c.videos)}개{c.uploadsInWindow ? ` · 기간 업로드 ${formatInteger(c.uploadsInWindow)}` : ''}
              </span>
            </div>
          </div>
          <div className="shrink-0 text-right">
            <MetricCell metric={c.viewsPeriod} label={`${c.name} 기간 조회 증가`} extra={c.viewsPeriod.crossPlatform ? '여러 플랫폼 합산: 단위가 다름' : undefined} />
            {c.viewsPeriod.crossPlatform ? <span className="block text-[11px] text-warning">여러 플랫폼</span> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

function Platforms({ report: r }: { report: KeywordReport }) {
  return (
    <div className="flex flex-col gap-3">
      <BarList
        label={`'${r.keyword}' 플랫폼별 일치 영상`}
        items={r.platforms.map((p) => ({
          key: p.platform,
          label: platformLabel(p.platform),
          value: p.videos,
          display: `${formatInteger(p.videos)}개`,
          color: platformColor(p.platform),
        }))}
        total={r.videos}
        showShare
      />
      <dl className="flex flex-col text-[13px]">
        {r.platforms.map((p) => (
          <div key={p.platform} className="flex items-center justify-between gap-2 border-t border-line py-1.5">
            <dt className="text-fg-3">{platformLabel(p.platform)} 기간 조회 증가</dt>
            <dd>
              <MetricCell metric={p.viewsPeriod} label={`${platformLabel(p.platform)} 기간 조회 증가`} extra={`업로드 ${formatInteger(p.uploadsInWindow)}개 · 계산 불가 ${formatInteger(p.viewsPeriod.unknown)}개(0으로 세지 않음)`} />
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function RelatedTopics({ report: r, scope, selected, onAdd }: { report: KeywordReport; scope: ScopeParams; selected: string[]; onAdd: (k: string) => void }) {
  if (!r.relatedTopics.length) {
    return <p className="text-sm text-fg-3">평소보다 자주 함께 나오는 주제 없음 (영상 3개·계정 2개 이상이 같이 쓴 주제만 표시).</p>;
  }
  const taken = new Set(selected.map(keywordKey));
  const full = selected.length >= MAX_KEYWORDS;
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-wrap gap-1.5" aria-label="함께 나오는 주제">
        {r.relatedTopics.map((t) => {
          const added = taken.has(keywordKey(t.topic));
          return (
            <li key={t.topic}>
              <Tooltip
                focusable={false}
                content={`일치 영상 ${formatInteger(t.support)}개(계정 ${formatInteger(t.accounts)}개)에 붙음 · 평소보다 ${t.lift.toFixed(1)}배 자주 · 필터 범위 전체 ${formatInteger(t.overall)}개`}
              >
                <Chip
                  selected={added}
                  onClick={added || full ? undefined : () => onAdd(t.topic)}
                  icon={added ? undefined : <Plus className="size-3" />}
                  title={added ? '이미 비교 중' : full ? `키워드는 최대 ${MAX_KEYWORDS}개` : `'${t.topic}'을(를) 비교 키워드로 추가`}
                >
                  {t.topic} <span className="text-fg-3">×{t.lift >= 10 ? t.lift.toFixed(0) : t.lift.toFixed(1)}</span>
                </Chip>
              </Tooltip>
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-fg-3">
        ×N = 평소 대비 배수(lift). 주제 필터로 보기:{' '}
        {r.relatedTopics.slice(0, 3).map((t, i) => (
          <span key={t.topic}>
            {i ? ', ' : ''}
            <Link to={topicVideosHref(t.topic, scope)} className="focus-ring rounded-sm text-accent-text hover:underline">
              {t.topic}
            </Link>
          </span>
        ))}
      </p>
    </div>
  );
}

function Sponsorship({ report: r, range }: { report: KeywordReport; range: string }) {
  const s = r.sponsored;
  const total = s.disclosed + s.likely;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <p className="text-2xl font-semibold text-fg">{shareText(s.share)}</p>
        <p className="text-[13px] text-fg-3">
          일치 영상 {formatInteger(r.videos)}개 중 광고 표기 {formatInteger(s.disclosed)} · 협찬 추정 {formatInteger(s.likely)}
        </p>
      </div>
      {s.brands.length ? (
        <BarList
          label={`'${r.keyword}' 협찬 브랜드`}
          items={s.brands.map((b) => ({ key: b.name, label: b.name, value: b.count, display: `${formatInteger(b.count)}개`, to: brandHref(b.name, range) }))}
        />
      ) : total ? (
        <p className="text-xs text-fg-3">브랜드를 식별하지 못한 협찬 영상만 있음.</p>
      ) : (
        <p className="text-xs text-fg-3">광고 표기·협찬 추정 신호가 있는 영상 없음.</p>
      )}
      <Link to={hrefWith('/brands', { range })} className={linkCls}>
        브랜드 협업 <ArrowRight className="size-3.5" aria-hidden />
      </Link>
    </div>
  );
}

/** Button to add a topic (used by the empty state too). */
export function AddKeywordButton({ keyword, onAdd, disabled }: { keyword: string; onAdd: (k: string) => void; disabled?: boolean }) {
  return (
    <Button size="sm" icon={<Plus className="size-4" aria-hidden />} onClick={() => onAdd(keyword)} disabled={disabled}>
      {keyword}
    </Button>
  );
}
