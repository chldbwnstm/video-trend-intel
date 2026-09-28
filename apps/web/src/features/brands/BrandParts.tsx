/**
 * Presentational parts of the 브랜드 협업 page: level badge, evidence snippets, the three tables
 * (brands / sponsored videos / creators) and the brand detail body shown in the drawer.
 * Every metric goes through MetricCell; detected text is rendered as plain text (never HTML).
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { Evidence, Video, VideoRow } from '@vti/core';
import { ExternalLink, TriangleAlert } from 'lucide-react';
import {
  Badge,
  DataTable,
  EmptyState,
  MetricCell,
  PlatformBadge,
  safeHttpUrl,
  StatRow,
  Tooltip,
  VideoCell,
} from '../../components/index.ts';
import type { Column, SortDir } from '../../components/index.ts';
import { fmtTime } from '../../lib/display.ts';
import { formatInteger } from '../../lib/format.ts';
import { CROSS_PLATFORM_CAVEAT, platformLabel } from '../../lib/platform.ts';
import { tzShort } from '../../lib/timezones.ts';
import { cx } from '../../lib/cx.ts';
import { useTz } from '../../data/hooks.ts';
import {
  EVIDENCE_FIELD_LABELS,
  evidenceSnippet,
  LEVEL_DESCRIPTIONS,
  LEVEL_LABELS,
  uniqueEvidence,
} from './brandsModel.ts';
import type { BrandRow, BrandSort, CreatorBrandRow, EvidenceSnippet, PlatformSum } from './brandsModel.ts';

export const SUM_EXTRA =
  '정확·보간·원천 제공 값을 더한 합계. 관측이 부족한 영상이 섞이면 하한(≥), 누적값이 줄어든 영상은 제외.';

export function creatorHref(key: string): string {
  return `/creators/${encodeURIComponent(key)}`;
}

/* ------------------------------------------------------------------------------------------ badges */

export function LevelBadge({ level }: { level: 'disclosed' | 'likely' }) {
  return (
    <Tooltip content={LEVEL_DESCRIPTIONS[level]}>
      <Badge tone={level === 'disclosed' ? 'info' : 'warning'}>{LEVEL_LABELS[level]}</Badge>
    </Tooltip>
  );
}

export function CuratedBadge({ curated }: { curated: boolean }) {
  return curated ? null : (
    <Tooltip content="브랜드 목록에 없는 이름. 'sponsored by …', '… 협찬', '提供: …' 같은 문구에서 자동으로 잘라낸 값이라 오탐일 수 있음.">
      <Badge tone="neutral">자동 추출</Badge>
    </Tooltip>
  );
}

/* ------------------------------------------------------------------------------------------ evidence */

function SnippetText({ s }: { s: EvidenceSnippet }) {
  return (
    <span className="break-words">
      <span className="text-fg-3">{EVIDENCE_FIELD_LABELS[s.field] ?? s.field}:</span> {s.cutStart ? '…' : ''}
      {s.before}
      <mark className="rounded-sm bg-warning-soft px-0.5 font-medium text-fg">{s.match}</mark>
      {s.after}
      {s.cutEnd ? '…' : ''}
    </span>
  );
}

/**
 * Evidence for a video's sponsorship signal: text snippets (plain text, match highlighted) where the match is
 * found in the stored title / description / tags, then one line listing the cues that are not visible in the
 * stored (shortened) text.
 */
export function EvidenceList({ video, max = 3, className }: { video: Video; max?: number; className?: string }) {
  const s = video.sponsorship;
  if (!s) return null;
  const list = uniqueEvidence(s.evidence);
  const found: EvidenceSnippet[] = [];
  const missing: Evidence[] = [];
  for (const ev of list) {
    const snip = evidenceSnippet(video, ev);
    if (snip) found.push(snip);
    else missing.push(ev);
  }
  const shown = found.slice(0, max);
  return (
    <ul className={cx('flex flex-col gap-1 text-xs text-fg-2', className)}>
      {shown.map((snip, i) => (
        <li key={`${snip.field}-${snip.match}-${i}`} className="rounded-md bg-surface-2 px-2 py-1">
          <SnippetText s={snip} />
        </li>
      ))}
      {found.length > shown.length ? <li className="text-fg-3">외 근거 문장 {found.length - shown.length}건</li> : null}
      {missing.length ? (
        <li className="px-2 break-words">
          <span className="text-fg-3">근거:</span>{' '}
          {missing.map((ev, i) => (
            <span key={`${ev.field}-${ev.match}`}>
              {i > 0 ? ' · ' : ''}
              <span className="font-medium text-fg">{ev.match}</span>
              <span className="text-fg-3"> ({EVIDENCE_FIELD_LABELS[ev.field] ?? ev.field})</span>
            </span>
          ))}
          <span className="block text-[11px] text-fg-3">데이터셋에 실린 앞부분에서는 원문 문장을 찾지 못함. 원본에서 확인.</span>
        </li>
      ) : null}
    </ul>
  );
}

/** One-line evidence summary for table cells, all evidence in a tooltip. */
export function EvidenceSummary({ video }: { video: Video }) {
  const s = video.sponsorship;
  if (!s || !s.evidence.length) return <span className="text-fg-3">—</span>;
  const list = uniqueEvidence(s.evidence);
  const first = list[0];
  return (
    <Tooltip
      maxWidth={360}
      content={
        <div className="flex flex-col gap-1">
          <span className="font-semibold">판정 근거 ({s.version})</span>
          <EvidenceList video={video} max={6} />
        </div>
      }
    >
      <span className="line-clamp-2 text-xs text-fg-2">
        <span className="text-fg-3">{EVIDENCE_FIELD_LABELS[first.field] ?? first.field}:</span> {first.match}
        {list.length > 1 ? <span className="text-fg-3"> 외 {list.length - 1}</span> : null}
      </span>
    </Tooltip>
  );
}

/* ------------------------------------------------------------------------------------------ sums */

export function PlatformSums({ sums, label }: { sums: PlatformSum[]; label: string }) {
  if (!sums.length) return <span className="text-fg-3">—</span>;
  return (
    <ul className="flex flex-col gap-1">
      {sums.map((s) => (
        <li key={s.platform} className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-1.5 text-xs text-fg-3">
            <PlatformBadge platform={s.platform} size="xs" />
            <span>영상 {formatInteger(s.videos)}개</span>
          </span>
          <MetricCell metric={s.views} label={`${label} (${platformLabel(s.platform)})`} extra={SUM_EXTRA} />
        </li>
      ))}
    </ul>
  );
}

export function MixedPlatformNote({ className }: { className?: string }) {
  return (
    <p className={cx('flex items-start gap-1.5 text-xs text-fg-3', className)}>
      <TriangleAlert className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
      <span>여러 플랫폼 합계임. {CROSS_PLATFORM_CAVEAT}</span>
    </p>
  );
}

/* ------------------------------------------------------------------------------------------ tables */

function BrandButton({ name, onOpen, className }: { name: string; onOpen: (name: string) => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(name)}
      className={cx(
        'focus-ring max-w-[8rem] truncate rounded-sm text-left font-medium text-fg hover:text-accent-text hover:underline sm:max-w-[16rem]',
        className,
      )}
      title={`${name} 협업 상세 보기`}
    >
      {name}
    </button>
  );
}

export function BrandTable({
  rows,
  sort,
  dir,
  onSortChange,
  onOpen,
  selected,
  stale,
  periodLabel,
  empty,
}: {
  rows: BrandRow[];
  sort: BrandSort;
  dir: SortDir;
  onSortChange: (key: string, dir: SortDir) => void;
  onOpen: (name: string) => void;
  selected: string | null;
  stale?: boolean;
  periodLabel: string;
  empty?: ReactNode;
}) {
  const tz = useTz();
  const columns: Column<BrandRow>[] = [
    {
      id: 'rank',
      header: '#',
      width: '3rem',
      align: 'right',
      hideBelow: 'sm',
      cell: (_r, i) => <span className="text-fg-3">{i + 1}</span>,
    },
    {
      id: 'brand',
      header: '브랜드',
      cell: (r) => (
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <BrandButton name={r.name} onOpen={onOpen} />
            <CuratedBadge curated={r.curated} />
          </span>
          <span className="flex flex-wrap items-center gap-1">
            {r.platforms.map((p) => (
              <PlatformBadge key={p} platform={p} size="xs" iconOnly />
            ))}
            <span className="text-xs text-fg-3">
              {r.creators
                .slice(0, 2)
                .map((c) => c.name)
                .join(', ')}
              {r.creators.length > 2 ? ` 외 ${r.creators.length - 2}` : ''}
            </span>
          </span>
        </div>
      ),
    },
    {
      id: 'videos',
      header: '영상',
      align: 'right',
      width: '5.5rem',
      sortKey: 'videos',
      hint: '기간 조건에 맞는 협찬 신호 영상 수 (광고 표기 / 협찬 추정).',
      cell: (r) => (
        <span className="flex flex-col items-end">
          <span className="font-medium">{formatInteger(r.videos)}</span>
          <span className="hidden text-xs whitespace-nowrap text-fg-3 sm:block">
            표기 {r.disclosed} · 추정 {r.likely}
          </span>
        </span>
      ),
    },
    {
      id: 'creators',
      header: '크리에이터',
      align: 'right',
      width: '6.5rem',
      sortKey: 'creators',
      hideBelow: 'sm',
      cell: (r) => formatInteger(r.creators.length),
    },
    {
      id: 'views',
      header: '조회 합계',
      align: 'right',
      width: '7rem',
      sortKey: 'views',
      hint: `브랜드 영상의 ${periodLabel} 합계. ${SUM_EXTRA} 플랫폼마다 조회 단위가 다름.`,
      cell: (r) => (
        <span className="flex flex-col items-end">
          <MetricCell metric={r.views} label={`${r.name} ${periodLabel}`} extra={SUM_EXTRA} />
          {r.platforms.length > 1 ? <span className="text-[11px] text-warning">플랫폼 혼합</span> : null}
        </span>
      ),
    },
    {
      id: 'latest',
      header: '최근 게시',
      align: 'right',
      width: '7rem',
      sortKey: 'latest',
      hideBelow: 'md',
      cell: (r) => (
        <span className="text-xs text-fg-3 tabular" title={`${fmtTime(r.latestPublishedAt, tz)} ${tzShort(tz)}`}>
          {fmtTime(r.latestPublishedAt, tz, 'date')}
        </span>
      ),
    },
  ];
  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(r) => r.name}
      caption="브랜드별 협찬 영상 수와 기간 조회 합계"
      sort={{ key: sort, dir }}
      onSortChange={onSortChange}
      onRowClick={(r) => onOpen(r.name)}
      selectedKey={selected}
      stale={stale}
      minWidth="320px"
      maxHeight="70vh"
      empty={empty}
    />
  );
}

export function SponsoredVideoTable({
  rows,
  onOpenBrand,
  stale,
  periodLabel,
  empty,
}: {
  rows: VideoRow[];
  onOpenBrand: (name: string) => void;
  stale?: boolean;
  periodLabel: string;
  empty?: ReactNode;
}) {
  const tz = useTz();
  const columns: Column<VideoRow>[] = [
    {
      id: 'video',
      header: '영상',
      cell: (r) => (
        <VideoCell
          video={r.video}
          accountName={r.account?.name}
          publishedLabel={fmtTime(r.video.publishedAt, tz, 'date')}
          publishedTitle={`${fmtTime(r.video.publishedAt, tz)} ${tzShort(tz)}`}
        >
          <div className="mt-1 flex flex-wrap items-center gap-1 sm:hidden">
            {r.video.sponsorship ? <LevelBadge level={r.video.sponsorship.level} /> : null}
          </div>
        </VideoCell>
      ),
    },
    {
      id: 'level',
      header: '판정',
      width: '6rem',
      hideBelow: 'sm',
      cell: (r) => (r.video.sponsorship ? <LevelBadge level={r.video.sponsorship.level} /> : null),
    },
    {
      id: 'brands',
      header: '브랜드',
      width: '10rem',
      hideBelow: 'md',
      cell: (r) => {
        const brands = r.video.sponsorship?.brands ?? [];
        if (!brands.length) return <span className="text-xs text-fg-3">미확인</span>;
        return (
          <span className="flex flex-wrap gap-x-2 gap-y-0.5 text-[13px]">
            {brands.slice(0, 3).map((b) => (
              <BrandButton key={b} name={b} onOpen={onOpenBrand} />
            ))}
            {brands.length > 3 ? <span className="text-xs text-fg-3">외 {brands.length - 3}</span> : null}
          </span>
        );
      },
    },
    {
      id: 'evidence',
      header: '근거',
      width: '14rem',
      hideBelow: 'lg',
      cell: (r) => <EvidenceSummary video={r.video} />,
    },
    {
      id: 'period',
      header: periodLabel,
      align: 'right',
      width: '8rem',
      cell: (r) => <MetricCell metric={r.metrics.viewsPeriod} label={periodLabel} source={lastSrc(r)} />,
    },
    {
      id: 'total',
      header: '누적 조회',
      align: 'right',
      width: '7rem',
      hideBelow: 'md',
      cell: (r) => <MetricCell metric={r.metrics.viewsTotal} label="누적 조회" source={lastSrc(r)} />,
    },
  ];
  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(r) => r.video.id}
      caption="협찬 신호가 있는 영상"
      stale={stale}
      minWidth="340px"
      empty={empty}
    />
  );
}

export function CreatorBrandTable({
  rows,
  onOpenBrand,
  stale,
  periodLabel,
  empty,
}: {
  rows: CreatorBrandRow[];
  onOpenBrand: (name: string) => void;
  stale?: boolean;
  periodLabel: string;
  empty?: ReactNode;
}) {
  const columns: Column<CreatorBrandRow>[] = [
    {
      id: 'creator',
      header: '크리에이터·계정',
      cell: (r) => (
        <div className="flex min-w-0 flex-col gap-0.5">
          <Link
            to={creatorHref(r.key)}
            className="focus-ring max-w-[12rem] truncate rounded-sm font-medium text-fg hover:text-accent-text hover:underline sm:max-w-[20rem]"
          >
            {r.name}
          </Link>
          <span className="flex flex-wrap items-center gap-1">
            {r.platforms.map((p) => (
              <PlatformBadge key={p} platform={p} size="xs" />
            ))}
            {r.kind === 'creator' ? <Badge tone="accent">여러 플랫폼 크리에이터</Badge> : null}
          </span>
        </div>
      ),
    },
    {
      id: 'videos',
      header: '협찬 영상',
      align: 'right',
      width: '7rem',
      cell: (r) => (
        <span className="flex flex-col items-end">
          <span className="font-medium">{formatInteger(r.videos)}</span>
          <span className="text-xs text-fg-3">
            표기 {r.disclosed} · 추정 {r.likely}
          </span>
        </span>
      ),
    },
    {
      id: 'brands',
      header: '함께한 브랜드',
      width: '14rem',
      hideBelow: 'sm',
      cell: (r) =>
        r.brands.length ? (
          <span className="flex flex-wrap gap-x-2 gap-y-0.5 text-[13px]">
            {r.brands.slice(0, 4).map((b) => (
              <span key={b.key} className="inline-flex items-baseline gap-0.5">
                <BrandButton name={b.name} onOpen={onOpenBrand} />
                {b.count > 1 ? <span className="text-xs text-fg-3">×{b.count}</span> : null}
              </span>
            ))}
            {r.brands.length > 4 ? <span className="text-xs text-fg-3">외 {r.brands.length - 4}</span> : null}
            {r.unbranded ? <span className="text-xs text-fg-3">· 브랜드 미확인 {r.unbranded}</span> : null}
          </span>
        ) : (
          <span className="text-xs text-fg-3">브랜드 미확인 {r.unbranded}</span>
        ),
    },
    {
      id: 'views',
      header: periodLabel,
      align: 'right',
      width: '8rem',
      hideBelow: 'md',
      cell: (r) => <MetricCell metric={r.views} label={`${r.name} ${periodLabel}`} extra={SUM_EXTRA} />,
    },
  ];
  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(r) => r.key}
      caption="크리에이터별 협찬 영상과 브랜드"
      stale={stale}
      minWidth="340px"
      maxHeight="70vh"
      empty={empty}
    />
  );
}

function lastSrc(r: VideoRow): string | null {
  const o = r.video.obs;
  return o.length ? o[o.length - 1].src : null;
}

/* ------------------------------------------------------------------------------------------ detail */

export function BrandDetail({
  brand,
  rows,
  periodLabel,
  onClose,
}: {
  brand: BrandRow;
  rows: VideoRow[];
  periodLabel: string;
  onClose?: () => void;
}) {
  const tz = useTz();
  return (
    <div className="flex flex-col gap-5 p-4">
      <section aria-label="요약">
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          {brand.curated ? <Badge tone="positive">브랜드 목록</Badge> : <CuratedBadge curated={false} />}
          {brand.platforms.map((p) => (
            <PlatformBadge key={p} platform={p} size="xs" />
          ))}
        </div>
        <dl>
          <StatRow label="협찬 영상">
            {formatInteger(brand.videos)}개 <span className="text-xs text-fg-3">(광고 표기 {brand.disclosed} · 협찬 추정 {brand.likely})</span>
          </StatRow>
          <StatRow label="크리에이터·계정">{formatInteger(brand.creators.length)}</StatRow>
          <StatRow label="최근 게시">
            {fmtTime(brand.latestPublishedAt, tz)} {tzShort(tz)}
          </StatRow>
          <StatRow label={`${periodLabel} 합계`}>
            {brand.byPlatform.length > 1 ? (
              <PlatformSums sums={brand.byPlatform} label={periodLabel} />
            ) : (
              <MetricCell metric={brand.views} label={`${periodLabel} 합계`} extra={SUM_EXTRA} />
            )}
          </StatRow>
        </dl>
        {brand.byPlatform.length > 1 ? <MixedPlatformNote className="mt-2" /> : null}
      </section>

      <section aria-label="함께한 크리에이터">
        <h3 className="mb-2 text-sm font-semibold text-fg">함께한 크리에이터·계정</h3>
        <ul className="flex flex-wrap gap-1.5">
          {brand.creators.map((c) => (
            <li key={c.key}>
              <Link
                to={creatorHref(c.key)}
                onClick={onClose}
                className="focus-ring inline-flex items-center gap-1 rounded-full border border-line bg-surface px-2.5 py-0.5 text-[13px] text-fg-2 hover:border-line-strong hover:text-fg"
              >
                {c.name}
                <span className="text-xs text-fg-3">{c.count}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="영상과 판정 근거">
        <h3 className="mb-1 text-sm font-semibold text-fg">영상과 판정 근거</h3>
        <p className="mb-2 text-xs text-fg-3">
          근거는 영상의 공개 제목·설명·태그에서 찾은 문구임. 계약 정보가 아님. 데이터셋에는 설명 앞부분만 실려 일부 문장은 원본에서 확인해야 함.
        </p>
        {rows.length === 0 ? (
          <EmptyState compact title="표시할 영상 없음" />
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {rows.map((r) => (
              <li key={r.video.id} className="flex flex-col gap-2 py-3">
                <div className="flex items-start justify-between gap-3">
                  <VideoCell
                    video={r.video}
                    accountName={r.account?.name}
                    thumb="xs"
                    publishedLabel={fmtTime(r.video.publishedAt, tz, 'date')}
                    publishedTitle={`${fmtTime(r.video.publishedAt, tz)} ${tzShort(tz)}`}
                  />
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    {r.video.sponsorship ? <LevelBadge level={r.video.sponsorship.level} /> : null}
                    <MetricCell metric={r.metrics.viewsPeriod} label={periodLabel} source={lastSrc(r)} />
                  </div>
                </div>
                <EvidenceList video={r.video} max={4} />
                {safeHttpUrl(r.video.url) ? (
                  <a
                    href={safeHttpUrl(r.video.url)!}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="focus-ring inline-flex w-fit items-center gap-1 rounded-sm text-xs text-accent-text hover:underline"
                  >
                    원본에서 설명 확인 <ExternalLink className="size-3" aria-hidden />
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
