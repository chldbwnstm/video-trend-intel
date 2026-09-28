/**
 * Presentational parts of the 분류 체계 page: the taxonomy tree table, the node detail panel, the
 * classification overview and the "how classification works" explainer (numbers imported from core so the
 * text stays in sync with the classifier).
 */
import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  ACCOUNT_CONFIDENCE,
  BROAD_SOURCE_CONFIDENCE,
  CLASSIFIER_VERSION,
  FIELD_WEIGHTS,
  MAX_SUB_PER_TOP,
  MAX_TOP_LEVEL,
  MAX_TOPICS,
  MIN_RULE_SCORE,
  SOURCE_CONFIDENCE,
  taxonomyById,
} from '@vti/core';
import type { TaxonomyNode } from '@vti/core';
import { ArrowRight, ChevronDown, ChevronRight, FolderTree, TriangleAlert } from 'lucide-react';
import {
  Badge,
  BarList,
  DataTable,
  EmptyState,
  ErrorState,
  MetricCell,
  PlatformBadge,
  StatRow,
  Tooltip,
  VideoCell,
} from '../../components/index.ts';
import type { Column, SortDir } from '../../components/index.ts';
import { categoryPathLabel } from '../../components/index.ts';
import { catLabel, fmtTime } from '../../lib/display.ts';
import { formatInteger, formatPercent } from '../../lib/format.ts';
import { CROSS_PLATFORM_CAVEAT, platformLabel } from '../../lib/platform.ts';
import { tzShort } from '../../lib/timezones.ts';
import { cx } from '../../lib/cx.ts';
import { useTz } from '../../data/hooks.ts';
import { EVIDENCE_FIELD_LABELS, METHOD_LABELS, METHODS } from './taxonomyModel.ts';
import type { NodeDetail, TaxonomyStats, TreeRow, TreeSort } from './taxonomyModel.ts';

export const SUM_EXTRA = '정확·보간·원천 제공 값을 더한 합계. 관측이 부족한 영상이 섞이면 하한(≥), 누적값이 줄어든 영상은 제외.';

/* ------------------------------------------------------------------------------------------ tree */

export function TaxonomyTreeTable({
  rows,
  selected,
  onSelect,
  onToggle,
  sort,
  dir,
  onSortChange,
  periodLabel,
  stale,
  searching,
}: {
  rows: TreeRow[];
  selected: string | null;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  sort: TreeSort;
  dir: SortDir;
  onSortChange: (key: string, dir: SortDir) => void;
  periodLabel: string;
  stale?: boolean;
  searching?: boolean;
}) {
  const columns: Column<TreeRow>[] = [
    {
      id: 'node',
      header: '분야',
      sortKey: 'taxonomy',
      sortFirstDir: 'desc',
      cell: (r) => (
        <div className="flex min-w-0 items-center gap-1" style={{ paddingLeft: `${r.depth * 1.25}rem` }}>
          {r.childCount > 0 && !searching ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggle(r.id);
              }}
              aria-expanded={r.expanded}
              aria-label={`${catLabel(r.id)} 하위 분야 ${r.expanded ? '접기' : '펼치기'}`}
              className="focus-ring inline-flex size-6 shrink-0 items-center justify-center rounded text-fg-3 hover:bg-surface-3 hover:text-fg"
            >
              {r.expanded ? <ChevronDown className="size-4" aria-hidden /> : <ChevronRight className="size-4" aria-hidden />}
            </button>
          ) : (
            <span className="inline-block size-6 shrink-0" aria-hidden />
          )}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onSelect(r.id);
            }}
            aria-pressed={selected === r.id}
            className={cx(
              'focus-ring max-w-[8.5rem] min-w-0 truncate rounded-sm text-left hover:text-accent-text hover:underline sm:max-w-none',
              r.depth === 0 ? 'font-semibold text-fg' : 'text-fg-2',
            )}
            title={categoryPathLabel(r.id)}
          >
            {catLabel(r.id)}
          </button>
          {r.childCount > 0 ? <span className="hidden shrink-0 text-xs text-fg-3 sm:inline">하위 {r.childCount}</span> : null}
        </div>
      ),
    },
    {
      id: 'videos',
      header: '영상',
      align: 'right',
      width: '5.5rem',
      sortKey: 'videos',
      hint: '이 분야 또는 하위 분야로 분류된 추적 영상 수. 한 영상이 여러 분야에 속할 수 있음.',
      cell: (r) => <span className={cx(r.stats.videos === 0 && 'text-fg-3')}>{formatInteger(r.stats.videos)}</span>,
    },
    {
      id: 'uploads',
      header: '기간 업로드',
      align: 'right',
      width: '6.5rem',
      sortKey: 'uploads',
      hideBelow: 'sm',
      hint: '그중 선택한 기간에 게시된 영상 수.',
      cell: (r) => <span className={cx(r.stats.uploads === 0 && 'text-fg-3')}>{formatInteger(r.stats.uploads)}</span>,
    },
    {
      id: 'views',
      header: periodLabel === '기간 조회 증가' ? '조회 증가' : periodLabel,
      align: 'right',
      width: '7.5rem',
      sortKey: 'views',
      hint: `분야 영상의 ${periodLabel} 합계. ${SUM_EXTRA} 여러 플랫폼이 섞이면 단위가 다름.`,
      cell: (r) => (
        <span className="flex flex-col items-end">
          <MetricCell
            metric={r.stats.views}
            label={`${catLabel(r.id)} ${periodLabel}`}
            extra={`${SUM_EXTRA} 측정 ${formatInteger(r.stats.measured)}개 · 관측 부족 ${formatInteger(r.stats.incomplete)}개.`}
          />
          {r.stats.platforms.length > 1 ? <span className="text-[11px] text-fg-3">{r.stats.platforms.length}개 플랫폼</span> : null}
        </span>
      ),
    },
    {
      id: 'incomplete',
      header: '관측 부족',
      align: 'right',
      width: '6rem',
      hideBelow: 'md',
      hint: '기간 경계 관측이 없어 증가량을 계산하지 못했거나 하한만 알 수 있는 영상 수. 이런 영상이 있으면 합계는 하한(≥).',
      cell: (r) => <span className="text-fg-3">{formatInteger(r.stats.incomplete)}</span>,
    },
  ];
  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(r) => r.id}
      caption="분류 체계 트리: 분야별 추적 영상 수와 기간 조회"
      sort={{ key: sort, dir }}
      onSortChange={onSortChange}
      onRowClick={(r) => onSelect(r.id)}
      selectedKey={selected}
      stale={stale}
      dense
      minWidth="320px"
      maxHeight="75vh"
      empty={<EmptyState compact title="일치하는 분야 없음" description="분야 이름·영문 이름·키워드로 검색함." />}
    />
  );
}

/* ------------------------------------------------------------------------------------------ overview */

export function ClassificationOverview({ stats, datasetVersion }: { stats: TaxonomyStats; datasetVersion: string }) {
  const share = stats.scopeVideos ? stats.categorized / stats.scopeVideos : null;
  const versions = stats.versions.length ? stats.versions : [datasetVersion];
  return (
    <div className="flex flex-col gap-4">
      <dl>
        <StatRow label="추적 영상">{formatInteger(stats.scopeVideos)}</StatRow>
        <StatRow label="분류된 영상">
          {formatInteger(stats.categorized)} <span className="text-xs text-fg-3">({formatPercent(share)})</span>
        </StatRow>
        <StatRow label="미분류">
          {formatInteger(stats.uncategorized)}
          <span className="ml-1 text-xs text-fg-3">근거가 부족하면 억지로 분류하지 않음</span>
        </StatRow>
        <StatRow label="분류기 버전">
          <span className="flex flex-wrap justify-end gap-1">
            {versions.map((v) => (
              <Badge key={v} tone="neutral">
                {v}
              </Badge>
            ))}
          </span>
        </StatRow>
      </dl>
      {versions.some((v) => v !== CLASSIFIER_VERSION) ? (
        <p className="flex items-start gap-1.5 text-xs text-fg-3">
          <TriangleAlert className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
          <span>
            화면의 분류 체계 정의는 {CLASSIFIER_VERSION} 기준임. 데이터는 다른 버전으로 분류되어 키워드·근거가 조금 다를 수 있음.
          </span>
        </p>
      ) : null}
      {stats.unknownIds.length ? (
        <p className="text-xs text-fg-3">현재 분류 체계에 없는 분야 id {stats.unknownIds.length}개는 트리에서 빠짐: {stats.unknownIds.slice(0, 5).join(', ')}</p>
      ) : null}
      <div>
        <h3 className="mb-2 text-[13px] font-semibold text-fg">분류 근거 종류 (영상 기준)</h3>
        <BarList
          label="분류 근거 종류별 영상 수"
          items={METHODS.filter((m) => stats.videosByMethod[m] > 0 || m !== 'manual').map((m) => ({
            key: m,
            label: METHOD_LABELS[m],
            value: stats.videosByMethod[m],
            display: formatInteger(stats.videosByMethod[m]),
            sub: `배정 ${formatInteger(stats.assignmentsByMethod[m])}건`,
          }))}
        />
        <p className="mt-2 text-xs text-fg-3">한 영상이 여러 근거로 여러 분야에 배정될 수 있어 합이 영상 수보다 큼.</p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ detail */

function KeywordList({ node }: { node: TaxonomyNode }) {
  const [all, setAll] = useState(false);
  const LIMIT = 40;
  const shown = all ? node.keywords : node.keywords.slice(0, LIMIT);
  if (!node.keywords.length) return <p className="text-xs text-fg-3">키워드 없음 (원천 분류·계정 시드로만 배정)</p>;
  return (
    <div>
      <ul className="flex flex-wrap gap-1" aria-label={`${node.label.ko} 키워드`}>
        {shown.map((k) => (
          <li key={k} className="rounded-md border border-line bg-surface-2 px-1.5 py-px text-xs text-fg-2">
            {k}
          </li>
        ))}
      </ul>
      {node.keywords.length > LIMIT ? (
        <button type="button" onClick={() => setAll((x) => !x)} className="focus-ring mt-1.5 rounded-sm text-xs text-accent-text hover:underline">
          {all ? '접기' : `키워드 ${node.keywords.length}개 모두 보기`}
        </button>
      ) : null}
    </div>
  );
}

function Section({ title, children, description }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2" aria-label={title}>
      <div>
        <h3 className="text-[13px] font-semibold text-fg">{title}</h3>
        {description ? <p className="text-xs text-fg-3">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

export function NodeDetailPanel({
  id,
  detail,
  stats,
  periodLabel,
  videosHref,
  topicHref,
  trendsHref,
  onSelect,
  detailError,
}: {
  id: string;
  detail: NodeDetail | undefined;
  detailError?: Error | null;
  stats: TaxonomyStats;
  periodLabel: string;
  videosHref: string;
  topicHref: (topic: string) => string;
  trendsHref: string;
  onSelect: (id: string) => void;
}) {
  const tz = useTz();
  const node = taxonomyById().get(id);
  if (!node) {
    return <EmptyState compact icon={<FolderTree className="size-6" />} title="알 수 없는 분야" description={`분류 체계에 '${id}' 분야가 없음.`} />;
  }
  const s = stats.nodes[id];
  const children = [...taxonomyById().values()].filter((n) => n.parent === id);
  const mixed = (detail?.byPlatform.length ?? 0) > 1;
  const totalMethods = detail ? METHODS.reduce((a, m) => a + detail.methods[m], 0) : 0;

  return (
    <div className="flex flex-col gap-5">
      {detailError ? <ErrorState compact title="분야 상세를 계산하지 못함" error={detailError} /> : null}
      <div>
        <p className="text-xs text-fg-3">{node.parent ? categoryPathLabel(node.parent) : '최상위 분야'}</p>
        <h2 className="text-lg font-bold text-fg">{node.label.ko}</h2>
        <p className="text-xs text-fg-3">
          {node.label.en} · <code className="rounded bg-surface-2 px-1">{node.id}</code>
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Link
            to={videosHref}
            className="focus-ring inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-[13px] font-medium text-on-accent hover:bg-accent-hover"
          >
            영상 탐색에서 보기 <ArrowRight className="size-3.5" aria-hidden />
          </Link>
          <Link
            to={trendsHref}
            className="focus-ring inline-flex h-8 items-center gap-1.5 rounded-md border border-line bg-surface px-3 text-[13px] font-medium text-fg hover:bg-surface-3"
          >
            이 분야 트렌드
          </Link>
        </div>
      </div>

      <dl>
        <StatRow label="추적 영상">{formatInteger(s?.videos ?? 0)}</StatRow>
        <StatRow label="기간 업로드">{formatInteger(s?.uploads ?? 0)}</StatRow>
        <StatRow label={periodLabel}>
          {s ? (
            <MetricCell
              metric={s.views}
              label={`${node.label.ko} ${periodLabel}`}
              extra={`${SUM_EXTRA} 측정 ${formatInteger(s.measured)}개 · 관측 부족 ${formatInteger(s.incomplete)}개.`}
            />
          ) : (
            '—'
          )}
        </StatRow>
        {detail?.meanConfidence !== null && detail?.meanConfidence !== undefined ? (
          <StatRow label="평균 분류 신뢰도">{formatPercent(detail.meanConfidence, 0)}</StatRow>
        ) : null}
      </dl>

      {detail && detail.byPlatform.length ? (
        <Section title={`플랫폼별 ${periodLabel}`} description="플랫폼마다 조회 단위가 달라 따로 봄.">
          <ul className="flex flex-col gap-1">
            {detail.byPlatform.map((p) => (
              <li key={p.platform} className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-1.5 text-xs text-fg-3">
                  <PlatformBadge platform={p.platform} size="xs" />
                  영상 {formatInteger(p.videos)}개
                </span>
                <MetricCell metric={p.views} label={`${platformLabel(p.platform)} ${periodLabel}`} extra={SUM_EXTRA} />
              </li>
            ))}
          </ul>
          {mixed ? <p className="text-xs text-fg-3">{CROSS_PLATFORM_CAVEAT}</p> : null}
        </Section>
      ) : null}

      {children.length ? (
        <Section title="하위 분야">
          <ul className="flex flex-wrap gap-1.5">
            {children.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => onSelect(c.id)}
                  className="focus-ring inline-flex items-center gap-1 rounded-full border border-line bg-surface px-2.5 py-0.5 text-[13px] text-fg-2 hover:border-line-strong hover:text-fg"
                >
                  {c.label.ko}
                  <span className="text-xs text-fg-3">{formatInteger(stats.nodes[c.id]?.videos ?? 0)}</span>
                </button>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section
        title="상위 주제"
        description={`이 분야 영상에 붙은 주제(해시태그·태그·[시리즈명]). 영상 수 순, ${periodLabel} 합계 함께 표시.`}
      >
        {!detail ? (
          <p className="text-xs text-fg-3">계산 중</p>
        ) : detail.topics.length === 0 ? (
          <p className="text-xs text-fg-3">주제가 붙은 영상 없음 (YouTube RSS 영상은 태그가 없어 제목의 해시태그·[시리즈명]만 주제가 됨).</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {detail.topics.map((t) => (
              <li key={t.topic} className="flex items-center justify-between gap-3 py-1.5">
                <Link to={topicHref(t.topic)} className="focus-ring min-w-0 truncate rounded-sm text-[13px] text-fg hover:text-accent-text hover:underline">
                  #{t.topic}
                </Link>
                <span className="flex shrink-0 items-center gap-3">
                  <span className="text-xs text-fg-3 tabular">영상 {formatInteger(t.videos)}</span>
                  <MetricCell metric={t.views} label={`#${t.topic} ${periodLabel}`} extra={SUM_EXTRA} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="샘플 영상과 분류 근거" description={`${periodLabel} 상위 영상. 이 분야로 분류된 이유를 함께 표시.`}>
        {!detail ? (
          <p className="text-xs text-fg-3">계산 중</p>
        ) : detail.samples.length === 0 ? (
          <p className="text-xs text-fg-3">선택한 기간·플랫폼 조건에 해당하는 영상 없음.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {detail.samples.map(({ row, assignment }) => (
              <li key={row.video.id} className="flex flex-col gap-1.5 py-2.5">
                <div className="flex items-start justify-between gap-3">
                  <VideoCell
                    video={row.video}
                    accountName={row.account?.name}
                    thumb="xs"
                    publishedLabel={fmtTime(row.video.publishedAt, tz, 'date')}
                    publishedTitle={`${fmtTime(row.video.publishedAt, tz)} ${tzShort(tz)}`}
                  />
                  <MetricCell metric={row.metrics.viewsPeriod} label={periodLabel} />
                </div>
                {assignment ? (
                  <p className="flex flex-wrap items-center gap-1 text-xs text-fg-3">
                    <Badge tone="neutral">{METHOD_LABELS[assignment.by] ?? assignment.by}</Badge>
                    {assignment.id !== id ? <span>{catLabel(assignment.id)}</span> : null}
                    <span>신뢰도 {formatPercent(assignment.confidence, 0)}</span>
                    <span aria-hidden>·</span>
                    <span className="min-w-0 break-words">
                      {assignment.evidence
                        .slice(0, 4)
                        .map((e) => `${EVIDENCE_FIELD_LABELS[e.field] ?? e.field} '${e.match}'`)
                        .join(', ')}
                      {assignment.evidence.length > 4 ? ` 외 ${assignment.evidence.length - 4}` : ''}
                    </span>
                    <Tooltip content={`분류기 버전 ${assignment.version}`}>
                      <span className="text-fg-3">({assignment.version})</span>
                    </Tooltip>
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="분류 근거 통계" description="이 분야 자체에 배정된 건의 근거 종류와 자주 쓰인 근거.">
        {!detail ? (
          <p className="text-xs text-fg-3">계산 중</p>
        ) : totalMethods === 0 ? (
          <p className="text-xs text-fg-3">이 분야에 직접 배정된 영상 없음.</p>
        ) : (
          <>
            <ul className="flex flex-wrap gap-1.5">
              {METHODS.filter((m) => detail.methods[m] > 0).map((m) => (
                <li key={m}>
                  <Badge tone="neutral">
                    {METHOD_LABELS[m]} {formatInteger(detail.methods[m])}
                  </Badge>
                </li>
              ))}
            </ul>
            <ul className="flex flex-col divide-y divide-line">
              {detail.evidence.map((e) => (
                <li key={`${e.field}-${e.match}`} className="flex items-center justify-between gap-3 py-1 text-[13px]">
                  <span className="min-w-0 truncate">
                    <span className="text-xs text-fg-3">{EVIDENCE_FIELD_LABELS[e.field] ?? e.field}</span> <span className="text-fg">{e.match}</span>
                  </span>
                  <span className="shrink-0 text-xs text-fg-3 tabular">{formatInteger(e.count)}건</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </Section>

      <Section title="키워드" description="제목·태그·설명에서 찾는 키워드 (한국어·영어·일본어, 소문자 정규화).">
        <KeywordList node={node} />
      </Section>

      <Section title="원천 분류 매핑" description="플랫폼 자체 분류가 이 값이면 이 분야로 배정함.">
        {node.sourceCategories.length === 0 ? (
          <p className="text-xs text-fg-3">매핑 없음</p>
        ) : (
          <ul className="flex flex-wrap gap-1">
            {(detail?.sourceCategories ?? node.sourceCategories.map((key) => ({ key, videos: 0 }))).map((sc) => (
              <li key={sc.key} className="rounded-md border border-line bg-surface-2 px-1.5 py-px text-xs text-fg-2">
                {sc.key}
                {detail ? <span className="ml-1 text-fg-3">{formatInteger(sc.videos)}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ explainer */

export function HowClassificationWorks({ datasetVersion }: { datasetVersion: string }) {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  return (
    <div className="grid gap-4 text-[13px] text-fg-2 md:grid-cols-3">
      <div className="flex flex-col gap-1.5">
        <h3 className="font-semibold text-fg">1. 원천 분류 매핑</h3>
        <p>
          플랫폼이 준 분류(Dailymotion 채널, PeerTube 카테고리, niconico 장르, YouTube 카테고리)를 분야에 연결함. 신뢰도 {pct(SOURCE_CONFIDENCE)}, '엔터테인먼트'처럼
          넓은 분류는 {pct(BROAD_SOURCE_CONFIDENCE)}.
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <h3 className="font-semibold text-fg">2. 계정·채널 시드</h3>
        <p>
          분야별로 골라 둔 시드 채널에서 온 영상은 그 분야 근거를 받음. 채널 주제이지 개별 영상 주제는 아니라 신뢰도 {pct(ACCOUNT_CONFIDENCE)}로 낮게 둠.
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <h3 className="font-semibold text-fg">3. 키워드 규칙</h3>
        <p>
          제목 {FIELD_WEIGHTS.title}·태그 {FIELD_WEIGHTS.tags}·설명 {FIELD_WEIGHTS.description} 가중치로 키워드 일치를 더해, 합이 {MIN_RULE_SCORE} 이상일 때만 배정함
          (제목·태그 1회 또는 설명 2회). 오탐 단어(예: '토너먼트' 속 '토너')는 제외.
        </p>
      </div>
      <div className="flex flex-col gap-1.5 md:col-span-3">
        <p className="text-fg-3">
          여러 근거는 합쳐서 신뢰도를 올림(최대 99%). 영상당 최상위 분야 최대 {MAX_TOP_LEVEL}개, 분야마다 하위 분야 최대 {MAX_SUB_PER_TOP}개, 주제 최대 {MAX_TOPICS}개. 영상
          내용(음성·화면)은 읽지 않으며 확보한 텍스트와 원천 정보만 씀. 분류기 버전 {CLASSIFIER_VERSION}
          {datasetVersion !== CLASSIFIER_VERSION ? ` (데이터: ${datasetVersion})` : ''}.
        </p>
      </div>
    </div>
  );
}
