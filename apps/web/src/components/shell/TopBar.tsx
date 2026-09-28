import { useEffect, useState } from 'react';
import { Menu, Monitor, Moon, Sun } from 'lucide-react';
import { useDataset } from '../../data/hooks.ts';
import { fmtTime } from '../../lib/display.ts';
import { THEME_LABELS, useTheme } from '../../lib/theme.ts';
import type { ThemePreference } from '../../lib/theme.ts';
import { TZ_OPTIONS, tzShort } from '../../lib/timezones.ts';
import { IconButton } from '../primitives.tsx';
import { FreshnessBadge } from '../layoutParts.tsx';

const NEXT_THEME: Record<ThemePreference, ThemePreference> = { system: 'light', light: 'dark', dark: 'system' };

/** Wall clock that ticks every minute (freshness badge). */
function useClock(intervalMs = 60_000): number {
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setClock(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return clock;
}

export function TopBar({ title, onMenu }: { title: string; onMenu: () => void }) {
  const { now, tz, setTz, isSample } = useDataset();
  const { preference, setPreference } = useTheme();
  const clock = useClock();
  const ThemeIcon = preference === 'dark' ? Moon : preference === 'light' ? Sun : Monitor;
  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b border-line bg-surface/95 px-3 backdrop-blur sm:px-5">
      <IconButton label="메뉴 열기" onClick={onMenu} className="lg:hidden">
        <Menu className="size-5" aria-hidden />
      </IconButton>
      <p className="min-w-0 flex-1 truncate text-sm font-semibold text-fg lg:hidden">{title}</p>
      <div className="hidden min-w-0 flex-1 lg:block" />
      <p className="hidden items-center gap-1 text-[13px] text-fg-3 md:flex">
        <span>데이터 기준</span>
        <time dateTime={new Date(now).toISOString()} className="font-medium text-fg-2 tabular">
          {fmtTime(now, tz)}
        </time>
        <span>{tzShort(tz)}</span>
      </p>
      <FreshnessBadge generatedAt={now} clock={clock} isSample={isSample} />
      <label className="sr-only" htmlFor="tz-select">
        표시 시간대
      </label>
      <select
        id="tz-select"
        value={tz}
        onChange={(e) => setTz(e.target.value)}
        title="날짜 범위와 시각을 계산·표시할 시간대"
        className="focus-ring h-8 max-w-[7.5rem] rounded-md border border-line bg-surface px-2 text-[13px] text-fg sm:max-w-none"
      >
        {TZ_OPTIONS.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      <IconButton
        label={`테마: ${THEME_LABELS[preference]} (누르면 ${THEME_LABELS[NEXT_THEME[preference]]})`}
        onClick={() => setPreference(NEXT_THEME[preference])}
      >
        <ThemeIcon className="size-4.5" aria-hidden />
      </IconButton>
    </header>
  );
}
