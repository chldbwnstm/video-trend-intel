/**
 * Creator Intelligence building blocks shared by /creators, /creators/:key and /compare:
 * avatar, link-status badge, platform strip, followers cell, data-state note, posting heatmap, creator picker.
 */
import { useId, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { Platform } from '@vti/core';
import { Check, Plus, TriangleAlert, UserRound } from 'lucide-react';
import { Badge, MetricCell, PlatformBadge, Popover, Tooltip, safeHttpUrl } from '../../components/index.ts';
import { cx } from '../../lib/cx.ts';
import { formatCompact, formatInteger } from '../../lib/format.ts';
import { STATUS_META } from '../../lib/metricStatus.ts';
import { platformColor } from '../../lib/platform.ts';
import { tzShort } from '../../lib/timezones.ts';
import {
  followersExtra,
  heatLevel,
  heatmapSlots,
  LINK_STATUS_HINTS,
  LINK_STATUS_LABELS,
  matrixMax,
  partialShare,
  searchPortfolioOptions,
  slotLabel,
  WEEKDAY_LABELS,
} from './logic.ts';
import type { FollowersMetric, LinkStatus, PortfolioOption, StatusCounts } from './logic.ts';

/* ------------------------------------------------------------------------------------------ avatar */

const AVATAR_SIZES = { sm: 'size-8 text-xs', md: 'size-10 text-sm', lg: 'size-14 text-lg', hero: 'size-10 text-sm sm:size-14 sm:text-lg' } as const;

export function CreatorAvatar({
  name,
  src,
  platform,
  size = 'md',
  className,
}: {
  name: string;
  src?: string | null;
  platform?: Platform | null;
  size?: keyof typeof AVATAR_SIZES;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const url = safeHttpUrl(src);
  const initial = [...(name ?? '').trim()][0]?.toUpperCase() ?? '';
  return (
    <span
      aria-hidden
      className={cx('relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold text-fg-2', AVATAR_SIZES[size], className)}
      style={{ background: platform ? `color-mix(in srgb, ${platformColor(platform)} 18%, var(--surface-3))` : 'var(--surface-3)' }}
    >
      {url && !failed ? (
        <img src={url} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} className="size-full object-cover" />
      ) : initial ? (
        initial
      ) : (
        <UserRound className="size-1/2" />
      )}
    </span>
  );
}

/** First avatar URL among accounts (with its platform), for portfolio headers and rows. */
export function portfolioAvatar(accounts: readonly { avatar: string | null; platform: Platform }[]): { src: string | null; platform: Platform | null } {
  const a = accounts.find((x) => safeHttpUrl(x.avatar));
  return { src: a?.avatar ?? null, platform: a?.platform ?? accounts[0]?.platform ?? null };
}

/* ------------------------------------------------------------------------------------------ badges */

export function LinkStatusBadge({ status }: { status: LinkStatus }) {
  if (!status) return null;
  return (
    <Tooltip content={LINK_STATUS_HINTS[status]}>
      <Badge tone={status === 'verified' ? 'positive' : 'warning'} icon={status === 'suggested' ? <TriangleAlert className="size-3" /> : <Check className="size-3" />}>
        {LINK_STATUS_LABELS[status]}
      </Badge>
    </Tooltip>
  );
}

/** Platform badges of a portfolio; multi-platform portfolios get an extra highlight badge. */
export function PlatformStrip({ platforms, highlight = true, size = 'xs' }: { platforms: readonly Platform[]; highlight?: boolean; size?: 'xs' | 'sm' }) {
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-1">
      {platforms.map((p) => (
        <PlatformBadge key={p} platform={p} size={size} />
      ))}
      {highlight && platforms.length > 1 ? (
        <Badge tone="accent" className="px-1.5 py-px text-[11px]">
          여러 플랫폼 {platforms.length}
        </Badge>
      ) : null}
    </span>
  );
}

/* ------------------------------------------------------------------------------------------ followers */

export function FollowersCell({
  metric,
  missingPlatforms,
  size,
  align,
}: {
  metric: FollowersMetric | null | undefined;
  missingPlatforms: readonly Platform[];
  size?: 'sm' | 'md' | 'lg';
  align?: 'left' | 'right';
}) {
  return (
    <MetricCell
      metric={metric}
      label="팔로워"
      unit="명"
      size={size}
      align={align}
      extra={metric ? followersExtra(metric, missingPlatforms) : '원천 미제공.'}
    />
  );
}

/* ------------------------------------------------------------------------------------------ data state */

const STATUS_SHOWN = ['exact', 'interpolated', 'source_reported', 'lower_bound', 'unavailable', 'decrease_flagged'] as const;

/**
 * One-line provenance summary for a column of values: how many are measured / source-reported / lower bounds /
 * unavailable, plus a plain explanation when many are partial (early collection).
 */
export function DataStateNote({ counts, label, children, className }: { counts: StatusCounts; label: string; children?: ReactNode; className?: string }) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (!total) return null;
  const partial = partialShare(counts);
  return (
    <div className={cx('flex flex-col gap-1 text-xs text-fg-3', className)}>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="font-medium text-fg-2">{label} 값 상태</span>
        {STATUS_SHOWN.filter((s) => counts[s] > 0).map((s) => (
          <Tooltip key={s} content={STATUS_META[s].description}>
            <span className="tabular">
              {STATUS_META[s].marker ? `${STATUS_META[s].marker} ` : ''}
              {STATUS_META[s].label} {formatInteger(counts[s])}
            </span>
          </Tooltip>
        ))}
      </p>
      {partial >= 0.3 ? (
        <p>
          관측 이력이 아직 짧아 기간 경계의 관측이 없는 값은 하한(≥) 또는 계산 불가(—)로 표시함. 수집이 3시간마다 반복되며 채워짐.{' '}
          <Link to="/coverage" className="focus-ring rounded-sm text-accent-text hover:underline">
            수집 범위 보기
          </Link>
        </p>
      ) : null}
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ heatmap */

const LEVEL_MIX = [0, 28, 52, 76, 100];

function cellBackground(level: number): string {
  if (level <= 0) return 'var(--surface-2)';
  return `color-mix(in srgb, var(--series-1) ${LEVEL_MIX[level]}%, var(--surface-2))`;
}

export type HeatMode = 'count' | 'v7';

/**
 * Weekday x hour posting heatmap (publish times in `tz`). Sequential single hue; every cell carries its value
 * as text for screen readers and a hover title; a "표로 보기" list gives the non-empty slots as text.
 */
export function PostingHeatmap({ data, mode, tz }: { data: { counts: number[][]; medianV7: (number | null)[][] }; mode: HeatMode; tz: string }) {
  const matrix = mode === 'count' ? data.counts : data.medianV7;
  const max = matrixMax(matrix);
  const slots = useMemo(() => heatmapSlots(data), [data]);
  const captionId = useId();
  const hours = Array.from({ length: 24 }, (_, h) => h);
  const valueText = (d: number, h: number) => {
    const c = data.counts[d]?.[h] ?? 0;
    const v7 = data.medianV7[d]?.[h] ?? null;
    return `${WEEKDAY_LABELS[d]}요일 ${h}시: 업로드 ${c}개${c ? `, V7 중앙값 ${v7 === null ? '없음' : `${formatInteger(v7)}회`}` : ''}`;
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="scroll-thin relative max-w-full overflow-x-auto" role="region" aria-labelledby={captionId} tabIndex={0}>
        <table className="w-full border-separate border-spacing-[2px]" style={{ minWidth: 540 }}>
          <caption id={captionId} className="sr-only">
            요일 × 시간({tzShort(tz)}) 게시 {mode === 'count' ? '업로드 수' : 'V7 중앙값'}
          </caption>
          <thead>
            <tr>
              <th scope="col" className="w-7">
                <span className="sr-only">요일</span>
              </th>
              {hours.map((h) => (
                <th key={h} scope="col" className="px-0 text-center text-[10px] font-normal text-fg-3 tabular">
                  <span aria-hidden>{h % 3 === 0 ? h : ''}</span>
                  <span className="sr-only">{h}시</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {WEEKDAY_LABELS.map((label, d) => (
              <tr key={label}>
                <th scope="row" className="pr-1 text-left text-xs font-normal text-fg-3">
                  {label}
                </th>
                {hours.map((h) => {
                  const v = matrix[d]?.[h] ?? null;
                  const level = heatLevel(v, max);
                  return (
                    <td
                      key={h}
                      title={valueText(d, h)}
                      className={cx('h-6 min-w-4 rounded-[3px] p-0 hover:outline hover:outline-2 hover:outline-fg-3', level === 0 && 'border border-line')}
                      style={{ background: cellBackground(level) }}
                    >
                      <span className="sr-only">{v === null ? '없음' : mode === 'count' ? `${formatInteger(v)}개` : `${formatInteger(v)}회`}</span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-3">
        <span className="inline-flex items-center gap-1" aria-hidden>
          적음
          {[1, 2, 3, 4].map((l) => (
            <span key={l} className="inline-block size-3 rounded-[3px]" style={{ background: cellBackground(l) }} />
          ))}
          많음
        </span>
        <span className="inline-flex items-center gap-1">
          <span aria-hidden className="inline-block size-3 rounded-[3px] border border-line" style={{ background: cellBackground(0) }} />
          {mode === 'count' ? '업로드 없음' : '값 없음(업로드 없음 또는 7일 미경과)'}
        </span>
        <span>
          최대 {mode === 'count' ? `${formatInteger(max)}개` : `${formatCompact(max)}회`} · 시간은 {tzShort(tz)} 기준
        </span>
      </div>
      {slots.length ? (
        <details className="text-xs">
          <summary className="focus-ring w-fit cursor-pointer rounded-sm text-fg-3 hover:text-fg">표로 보기</summary>
          <div className="scroll-thin relative mt-2 max-h-56 overflow-auto rounded-md border border-line">
            <table className="w-full text-xs">
              <caption className="sr-only">업로드가 있는 요일·시간대</caption>
              <thead>
                <tr>
                  <th scope="col" className="sticky top-0 bg-surface-2 px-2 py-1 text-left font-medium text-fg-3">
                    요일·시간
                  </th>
                  <th scope="col" className="sticky top-0 bg-surface-2 px-2 py-1 text-right font-medium text-fg-3">
                    업로드
                  </th>
                  <th scope="col" className="sticky top-0 bg-surface-2 px-2 py-1 text-right font-medium text-fg-3">
                    V7 중앙값
                  </th>
                </tr>
              </thead>
              <tbody>
                {slots.map((s) => (
                  <tr key={`${s.weekday}-${s.hour}`} className="border-t border-line">
                    <th scope="row" className="px-2 py-1 text-left font-normal text-fg-2">
                      {slotLabel(s)}
                    </th>
                    <td className="px-2 py-1 text-right text-fg tabular">{formatInteger(s.count)}</td>
                    <td className="px-2 py-1 text-right text-fg tabular">{s.medianV7 === null ? '—' : `${formatInteger(s.medianV7)}회`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ picker */

export function CreatorPicker({
  options,
  selected,
  onAdd,
  max,
  label = '크리에이터 추가',
}: {
  options: readonly PortfolioOption[];
  selected: readonly string[];
  onAdd: (key: string) => void;
  max: number;
  label?: string;
}) {
  const full = selected.length >= max;
  return (
    <Popover
      label={label}
      width={380}
      disabled={full}
      buttonContent={
        <>
          <Plus className="size-4 shrink-0 text-fg-3" aria-hidden />
          <span className="font-medium">{full ? `최대 ${max}명 선택됨` : label}</span>
        </>
      }
    >
      {(close) => (
        <PickerPanel
          options={options}
          selected={selected}
          onPick={(k) => {
            onAdd(k);
            if (selected.length + 1 >= max) close();
          }}
        />
      )}
    </Popover>
  );
}

function PickerPanel({ options, selected, onPick }: { options: readonly PortfolioOption[]; selected: readonly string[]; onPick: (key: string) => void }) {
  const [q, setQ] = useState('');
  const inputId = useId();
  const matches = useMemo(() => searchPortfolioOptions(options, q, 40), [options, q]);
  return (
    <div className="flex flex-col">
      <div className="sticky top-0 z-10 border-b border-line bg-surface p-2">
        <label htmlFor={inputId} className="sr-only">
          크리에이터·계정 검색
        </label>
        <input
          id={inputId}
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="이름, 핸들, 계정 ID 검색"
          className="focus-ring h-8 w-full rounded-md border border-line bg-surface px-2.5 text-sm text-fg placeholder:text-fg-3"
        />
        <p className="mt-1 text-[11px] text-fg-3">{q ? `일치 ${formatInteger(matches.length)}개${matches.length >= 40 ? ' 이상 (상위 40개 표시)' : ''}` : '여러 플랫폼 크리에이터 먼저 표시'}</p>
      </div>
      {matches.length ? (
        <ul aria-label="검색 결과" className="p-1">
          {matches.map((o) => {
            const on = selected.includes(o.key);
            return (
              <li key={o.key}>
                <button
                  type="button"
                  disabled={on}
                  onClick={() => onPick(o.key)}
                  className="focus-ring flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-surface-2 disabled:cursor-default disabled:opacity-60"
                >
                  {on ? <Check className="size-4 shrink-0 text-accent" aria-hidden /> : <Plus className="size-4 shrink-0 text-fg-3" aria-hidden />}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-fg">{o.name}</span>
                    <span className="flex flex-wrap items-center gap-1 text-[11px] text-fg-3">
                      {o.platforms.map((p) => (
                        <PlatformBadge key={p} platform={p} size="xs" iconOnly />
                      ))}
                      <span>영상 {formatInteger(o.videos)}개</span>
                      {o.linkStatus ? <span>· {LINK_STATUS_LABELS[o.linkStatus]}</span> : null}
                      {on ? <span>· 선택됨</span> : null}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="p-4 text-center text-sm text-fg-3">일치하는 크리에이터·계정 없음</p>
      )}
    </div>
  );
}
