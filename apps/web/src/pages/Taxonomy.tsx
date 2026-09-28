/**
 * 분류 체계 (ContentGraph-lite): the TAXONOMY tree with per-node tracked videos, uploads and period views,
 * a node detail (top topics, sample videos with their classification evidence, keywords, source-category
 * mappings) and how the rule classifier works (version shown). Click-through to /videos with `cats`.
 */
import { useCallback, useMemo, useState } from 'react';
import { taxonomyById, TOP_LEVEL_CATEGORY_IDS } from '@vti/core';
import type { Platform } from '@vti/core';
import { FolderTree, Info, ListTree } from 'lucide-react';
import {
  Card,
  CardHeader,
  DateModePicker,
  ErrorState,
  FilterBar,
  KpiTile,
  LoadingState,
  PageHeader,
  PlatformPicker,
  RangePicker,
  SearchInput,
  SectionBoundary,
  SectionGrid,
  SourceNote,
} from '../components/index.ts';
import type { SortDir } from '../components/index.ts';
import { useAnalysis, useDataset, useRangeParam, useUrlState } from '../data/hooks.ts';
import { catLabel } from '../lib/display.ts';
import { formatInteger, formatPercent } from '../lib/format.ts';
import { orderPlatforms } from '../lib/platform.ts';
import { dirCodec, enumCodec, hrefWith, platformListCodec } from '../lib/urlState.ts';
import { cx } from '../lib/cx.ts';
import {
  computeNodeDetail,
  computeTaxonomyStats,
  flattenTree,
  searchNodes,
  TAXONOMY_DATE_MODES,
  TREE_SORTS,
} from '../features/taxonomy/taxonomyModel.ts';
import type { TaxonomyDateMode, TreeSort } from '../features/taxonomy/taxonomyModel.ts';
import { ClassificationOverview, HowClassificationWorks, NodeDetailPanel, TaxonomyTreeTable } from '../features/taxonomy/TaxonomyParts.tsx';

const PERIOD_LABEL: Record<TaxonomyDateMode, string> = {
  activity: '기간 조회 증가',
  upload: '게시 후 조회',
};

export default function TaxonomyPage() {
  const { dataset, now, tz } = useDataset();
  const { spec, range, rollingHours, setSpec } = useRangeParam('range', 'rolling7d');
  const [mode, setMode] = useUrlState<TaxonomyDateMode>('mode', 'activity', { codec: enumCodec(TAXONOMY_DATE_MODES) });
  const [platforms, setPlatforms] = useUrlState<Platform[]>('platforms', [], { codec: platformListCodec });
  const [node, setNode] = useUrlState<string>('node', '');
  const [q, setQ] = useUrlState<string>('q', '');
  const [sort, setSort] = useUrlState<TreeSort>('sort', 'videos', { codec: enumCodec(TREE_SORTS) });
  const [dir, setDir] = useUrlState<SortDir>('dir', 'desc', { codec: dirCodec });
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(node && node.includes('/') ? [node.split('/')[0]] : []));

  const presentPlatforms = useMemo(() => orderPlatforms(dataset.videos.map((v) => v.platform)), [dataset]);
  const platformCounts = useMemo(() => {
    const c: Partial<Record<Platform, number>> = {};
    for (const v of dataset.videos) c[v.platform] = (c[v.platform] ?? 0) + 1;
    return c;
  }, [dataset]);

  const statsInput = useMemo(() => ({ mode, range, rollingHours, tz, now, platforms }), [mode, range, rollingHours, tz, now, platforms]);
  const stats = useAnalysis('taxonomy.stats', statsInput, (index, i) => computeTaxonomyStats(index, i));
  const knownNode = node && taxonomyById().has(node) ? node : '';
  const detail = useAnalysis('taxonomy.node', { ...statsInput, id: knownNode }, (index, i) => (i.id ? computeNodeDetail(index, i) : null));
  const periodLabel = PERIOD_LABEL[mode];
  const filter = useMemo(() => searchNodes(q), [q]);

  const rows = useMemo(() => (stats.data ? flattenTree(stats.data, expanded, sort, dir, filter) : []), [stats.data, expanded, sort, dir, filter]);

  const select = useCallback(
    (id: string) => {
      setNode(id);
      const top = id.split('/')[0];
      if (top !== id) setExpanded((prev) => (prev.has(top) ? prev : new Set([...prev, top])));
      // Below the lg breakpoint the detail sits under the tree: bring it into view.
      if (typeof window !== 'undefined' && window.innerWidth < 1024) {
        requestAnimationFrame(() => document.getElementById('taxonomy-detail')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
      }
    },
    [setNode],
  );
  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const scope = platforms.length ? platforms : undefined;
  const videosHref = (id: string) =>
    hrefWith('/videos', { cats: [id], mode, sort: mode === 'upload' ? 'views_total' : 'views_period', range: spec, platforms: scope });
  const topicHref = (id: string) => (topic: string) =>
    hrefWith('/videos', { cats: [id], topics: [topic], mode, sort: mode === 'upload' ? 'views_total' : 'views_period', range: spec, platforms: scope });
  const trendsHref = (id: string) => hrefWith('/trends', { kind: 'topic', cats: [id], range: spec, platforms: scope });

  const s = stats.data;
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow="ContentGraph"
        title="분류 체계"
        description="넓은 분야와 하위 분야, 분야별 추적 영상 수와 기간 조회, 분류 근거. 제목·태그·설명·원천 분류·시드 채널로만 분류하며 영상 내용은 읽지 않음."
      />

      <FilterBar label="분류 체계 필터">
        <RangePicker value={spec} onChange={setSpec} />
        <PlatformPicker options={presentPlatforms} value={platforms} onChange={setPlatforms} counts={platformCounts} />
        <SearchInput value={q} onChange={setQ} placeholder="분야·키워드 검색" label="분야·키워드 검색" className="w-full sm:w-56" />
        <DateModePicker
          value={mode}
          onChange={(m) => setMode(m === 'upload' ? 'upload' : 'activity')}
          modes={['activity', 'upload']}
          showExample={false}
          className="w-full"
        />
      </FilterBar>

      {stats.error ? (
        <Card>
          <ErrorState title="분야별 통계를 계산하지 못함" error={stats.error} />
        </Card>
      ) : !s ? (
        <Card>
          <LoadingState rows={8} />
        </Card>
      ) : (
        <>
          <div className={cx('grid grid-cols-2 gap-3 transition-opacity sm:grid-cols-3', stats.isStale && 'opacity-60')}>
            <KpiTile icon={<ListTree className="size-4" />} label="분야" value={formatInteger(Object.keys(s.nodes).length)} sub={`최상위 ${TOP_LEVEL_CATEGORY_IDS.length}개 · 하위 ${Object.keys(s.nodes).length - TOP_LEVEL_CATEGORY_IDS.length}개`} />
            <KpiTile
              icon={<FolderTree className="size-4" />}
              label="분류된 영상"
              value={formatPercent(s.scopeVideos ? s.categorized / s.scopeVideos : null)}
              sub={`${formatInteger(s.categorized)} / ${formatInteger(s.scopeVideos)}개 · 미분류 ${formatInteger(s.uncategorized)}`}
            />
            <KpiTile
              className="col-span-2 sm:col-span-1"
              icon={<Info className="size-4" />}
              label="분류기 버전"
              value={<span className="text-lg">{(s.versions[0] ?? dataset.classifierVersion)}</span>}
              sub={s.versions.length > 1 ? `버전 ${s.versions.length}개 혼재` : '모든 배정이 같은 버전'}
            />
          </div>

          <SectionGrid>
            <Card flush className="lg:col-span-7">
              <div className="p-4 pb-2 sm:p-5 sm:pb-2">
                <CardHeader
                  icon={<ListTree className="size-4" />}
                  title="분야 트리"
                  description={`추적 영상 수와 ${periodLabel} 합계. 분야를 누르면 오른쪽에 상세가 나옴. 상위 분야 수치는 하위 분야 영상을 포함함.`}
                  className="mb-0"
                />
              </div>
              <SectionBoundary title="분야 트리를 표시하지 못함" resetKey={`${spec}-${mode}`}>
                <TaxonomyTreeTable
                  rows={rows}
                  selected={knownNode || null}
                  onSelect={select}
                  onToggle={toggle}
                  sort={sort}
                  dir={dir}
                  onSortChange={(k, d) => {
                    setSort(k as TreeSort);
                    setDir(d);
                  }}
                  periodLabel={periodLabel}
                  stale={stats.isStale}
                  searching={!!filter}
                />
              </SectionBoundary>
              <p className="px-4 py-3 text-xs text-fg-3 sm:px-5">
                ≥ 표시는 관측이 부족한 영상이 섞여 실제 합계가 더 클 수 있다는 뜻. 수집이 3시간마다 쌓이면서 점점 정확해짐.
              </p>
            </Card>

            <Card id="taxonomy-detail" className="scroll-mt-4 lg:col-span-5 lg:self-start">
              <SectionBoundary title="분야 상세를 표시하지 못함" resetKey={`${knownNode}-${spec}-${mode}`}>
                {knownNode ? (
                  <NodeDetailPanel
                    id={knownNode}
                    detail={detail.data && detail.data.id === knownNode ? detail.data : undefined}
                    detailError={detail.error}
                    stats={s}
                    periodLabel={periodLabel}
                    videosHref={videosHref(knownNode)}
                    topicHref={topicHref(knownNode)}
                    trendsHref={trendsHref(knownNode)}
                    onSelect={select}
                  />
                ) : (
                  <>
                    <CardHeader
                      icon={<Info className="size-4" />}
                      title="분류 개요"
                      description={node ? `알 수 없는 분야 '${node}'. 트리에서 분야를 선택함.` : '트리에서 분야를 고르면 주제·샘플 영상·분류 근거를 볼 수 있음.'}
                    />
                    <ClassificationOverview stats={s} datasetVersion={dataset.classifierVersion} />
                  </>
                )}
              </SectionBoundary>
            </Card>
          </SectionGrid>
        </>
      )}

      <Card>
        <CardHeader icon={<Info className="size-4" />} title="분류 방식" description="세 가지 근거를 합쳐 영상마다 여러 분야를 배정함. 모든 배정에 근거와 버전이 남음." />
        <HowClassificationWorks datasetVersion={dataset.classifierVersion} />
      </Card>

      <SourceNote
        asOf={now}
        window={s?.window}
        notes={s?.notes}
        sources={[`분류기 ${s?.versions.join(', ') || dataset.classifierVersion}`, ...(knownNode ? [`선택 분야 ${catLabel(knownNode)}`] : [])]}
      />
    </div>
  );
}
