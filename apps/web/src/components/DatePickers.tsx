/**
 * Date semantics & range controls (SPEC data principle 2: three date semantics, never mixed).
 * - DateModePicker: 업로드 기간 / 조회 발생 기간 / 게시 후 경과 with a one-line explanation + A/B example.
 * - RangePicker: presets (via core presetRange) + custom inclusive local dates, stored as a RangeSpec.
 * - AgePicker: 1/2/3/7/30일 for age mode (Video Ratings V1..V30).
 */
import { useId, useState } from 'react';
import { AGE_DAYS, localDateOf, presetRange } from '@vti/core';
import type { AgeDays, DateMode, RangePreset } from '@vti/core';
import { CalendarDays, Check } from 'lucide-react';
import { cx } from '../lib/cx.ts';
import {
  formatLocalRange,
  isIsoDate,
  parseRangeSpec,
  RANGE_PRESET_LABELS,
} from '../lib/urlState.ts';
import { tzShort } from '../lib/timezones.ts';
import { useOptionalDataset } from '../data/hooks.ts';
import { SegmentedControl } from './controls.tsx';
import { Popover } from './Overlay.tsx';
import { Button } from './primitives.tsx';

/* ------------------------------------------------------------------------------------------ DateModePicker */

export const DATE_MODE_LABELS: Record<DateMode, string> = {
  upload: '업로드 기간',
  activity: '조회 발생 기간',
  age: '게시 후 경과',
};

export const DATE_MODE_DESCRIPTIONS: Record<DateMode, string> = {
  upload: '기간 안에 게시된 영상만 대상. 기준 시각까지의 누적 조회로 비교함.',
  activity: '게시일과 관계없이 기간 동안 늘어난 조회수로 비교함. 예전 영상의 재유행도 잡힘.',
  age: '게시 후 같은 시간(1·2·3·7·30일)이 지난 시점의 조회수로 비교함. 최신·오래된 영상의 누적 편향을 줄임.',
};

export const DATE_MODE_EXAMPLE =
  '예: 9월 기준 영상 A(8월 업로드, 9월에 +500만)와 B(9월 업로드, +200만). 업로드 기간 순위에서는 B가 1위(A는 8월 업로드라 제외), 조회 발생 기간 순위에서는 A가 1위.';

export interface DateModePickerProps {
  value: DateMode;
  onChange: (mode: DateMode) => void;
  /** Show the one-line explanation under the control (default true). */
  showDescription?: boolean;
  /** Show the collapsible A/B example (default true). */
  showExample?: boolean;
  modes?: DateMode[];
  className?: string;
}

export function DateModePicker({ value, onChange, showDescription = true, showExample = true, modes = ['upload', 'activity', 'age'], className }: DateModePickerProps) {
  const descId = useId();
  return (
    <div className={cx('flex min-w-0 flex-col gap-1.5', className)}>
      <SegmentedControl<DateMode>
        label="날짜 기준"
        value={value}
        onChange={onChange}
        describedBy={showDescription ? descId : undefined}
        className="self-start"
        options={modes.map((m) => ({ value: m, label: DATE_MODE_LABELS[m], title: DATE_MODE_DESCRIPTIONS[m] }))}
      />
      {showDescription ? (
        <p id={descId} className="text-[13px] text-fg-3">
          <span className="font-medium text-fg-2">{DATE_MODE_LABELS[value]}:</span> {DATE_MODE_DESCRIPTIONS[value]}
        </p>
      ) : null}
      {showExample ? (
        <details className="text-[13px] text-fg-3">
          <summary className="focus-ring w-fit cursor-pointer rounded-sm text-accent-text hover:underline">날짜 기준 예시 보기</summary>
          <p className="mt-1 rounded-md bg-surface-2 px-3 py-2">{DATE_MODE_EXAMPLE}</p>
        </details>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ RangePicker */

export const DEFAULT_RANGE_PRESETS: RangePreset[] = ['rolling24h', 'rolling7d', 'rolling30d', 'today', 'yesterday', 'last7d', 'last30d', 'last90d', 'thisWeek', 'lastWeek', 'thisMonth', 'lastMonth'];

export interface RangePickerProps {
  /** RangeSpec: preset id or `YYYY-MM-DD..YYYY-MM-DD`. */
  value: string;
  onChange: (spec: string) => void;
  presets?: RangePreset[];
  /** Allow custom dates (default true). */
  allowCustom?: boolean;
  /** Defaults to the dataset context. */
  tz?: string;
  now?: number;
  label?: string;
  className?: string;
}

function safePreset(p: RangePreset, tz: string, now: number): string | null {
  try {
    return formatLocalRange(presetRange(p, tz, now));
  } catch {
    return null;
  }
}

function safeToday(tz: string, now: number): string | null {
  try {
    return localDateOf(now, tz);
  } catch {
    return null;
  }
}

/** Human label for a RangeSpec: `최근 7일` or `2026-09-01 ~ 2026-09-28`. */
export function rangeSpecLabel(spec: string): string {
  const parsed = parseRangeSpec(spec);
  if (!parsed) return spec;
  return parsed.kind === 'preset' ? RANGE_PRESET_LABELS[parsed.preset] : formatLocalRange(parsed.range);
}

export function RangePicker({ value, onChange, presets = DEFAULT_RANGE_PRESETS, allowCustom = true, tz, now, label = '기간', className }: RangePickerProps) {
  const ctx = useOptionalDataset();
  const zone = tz ?? ctx?.tz ?? 'Asia/Seoul';
  const at = now ?? ctx?.now ?? Date.now();
  const parsed = parseRangeSpec(value);
  const current = parsed?.kind === 'preset' ? safePreset(parsed.preset, zone, at) : null;

  return (
    <div className={cx('inline-flex min-w-0', className)}>
      <Popover
        label={`${label} 선택`}
        width={320}
        buttonContent={
          <>
            <CalendarDays className="size-4 shrink-0 text-fg-3" aria-hidden />
            <span className="font-medium">{rangeSpecLabel(value)}</span>
            {current ? <span className="hidden text-xs text-fg-3 sm:inline">{current}</span> : null}
          </>
        }
      >
        {(close) => (
          <RangePanel
            value={value}
            presets={presets}
            allowCustom={allowCustom}
            tz={zone}
            now={at}
            onPick={(spec) => {
              onChange(spec);
              close();
            }}
          />
        )}
      </Popover>
    </div>
  );
}

function RangePanel({
  value,
  presets,
  allowCustom,
  tz,
  now,
  onPick,
}: {
  value: string;
  presets: RangePreset[];
  allowCustom: boolean;
  tz: string;
  now: number;
  onPick: (spec: string) => void;
}) {
  const parsed = parseRangeSpec(value);
  const today = safeToday(tz, now);
  const initial = parsed?.kind === 'custom' ? parsed.range : parsed?.kind === 'preset' ? rangeOrNull(parsed.preset, tz, now) : null;
  const [start, setStart] = useState(initial?.start ?? today ?? '');
  const [end, setEnd] = useState(initial?.end ?? today ?? '');
  const startId = useId();
  const endId = useId();
  const valid = isIsoDate(start) && isIsoDate(end) && start <= end;
  const error = !isIsoDate(start) || !isIsoDate(end) ? '날짜를 YYYY-MM-DD 형식으로 입력' : start > end ? '시작일이 종료일보다 늦음' : null;

  return (
    <div className="flex flex-col">
      <ul aria-label="기간 프리셋" className="p-1">
        {presets.map((p) => {
          const selected = parsed?.kind === 'preset' && parsed.preset === p;
          const dates = safePreset(p, tz, now);
          return (
            <li key={p}>
              <button
                type="button"
                onClick={() => onPick(p)}
                aria-pressed={selected}
                className={cx(
                  'focus-ring flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-surface-2',
                  selected && 'font-semibold',
                )}
              >
                <Check className={cx('size-4 shrink-0', selected ? 'text-accent' : 'invisible')} aria-hidden />
                <span className="flex-1">{RANGE_PRESET_LABELS[p]}</span>
                {dates ? <span className="text-xs text-fg-3 tabular">{dates}</span> : null}
              </button>
            </li>
          );
        })}
      </ul>
      {allowCustom ? (
        <form
          className="flex flex-col gap-2 border-t border-line p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) onPick(`${start}..${end}`);
          }}
        >
          <p className="text-xs font-medium text-fg-2">직접 지정 (양 끝 포함, {tzShort(tz)} 기준 날짜)</p>
          <div className="flex items-center gap-2">
            <label htmlFor={startId} className="sr-only">
              시작일
            </label>
            <input
              id={startId}
              type="date"
              value={start}
              max={today ?? undefined}
              onChange={(e) => setStart(e.target.value)}
              className="focus-ring h-8 min-w-0 flex-1 rounded-md border border-line bg-surface px-2 text-sm text-fg"
            />
            <span className="text-fg-3" aria-hidden>
              ~
            </span>
            <label htmlFor={endId} className="sr-only">
              종료일
            </label>
            <input
              id={endId}
              type="date"
              value={end}
              max={today ?? undefined}
              onChange={(e) => setEnd(e.target.value)}
              className="focus-ring h-8 min-w-0 flex-1 rounded-md border border-line bg-surface px-2 text-sm text-fg"
            />
          </div>
          {error ? (
            <p className="text-xs text-negative" role="alert">
              {error}
            </p>
          ) : null}
          <Button type="submit" size="sm" variant="primary" disabled={!valid}>
            적용
          </Button>
        </form>
      ) : null}
    </div>
  );
}

function rangeOrNull(p: RangePreset, tz: string, now: number) {
  try {
    return presetRange(p, tz, now);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------------------------------ AgePicker */

export const AGE_LABELS: Record<AgeDays, string> = { 1: '1일', 2: '2일', 3: '3일', 7: '7일', 30: '30일' };

export interface AgePickerProps {
  value: AgeDays;
  onChange: (age: AgeDays) => void;
  options?: readonly AgeDays[];
  className?: string;
}

export function AgePicker({ value, onChange, options = AGE_DAYS, className }: AgePickerProps) {
  return (
    <SegmentedControl<AgeDays>
      label="게시 후 경과일"
      value={value}
      onChange={onChange}
      className={className}
      options={options.map((d) => ({ value: d, label: AGE_LABELS[d], title: `게시 후 ${d}일 시점 조회수 (V${d})` }))}
    />
  );
}
