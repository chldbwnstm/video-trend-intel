import { useEffect, useState } from 'react';
import { Menu, Monitor, Moon, Sun } from 'lucide-react';
import { useAppStatus, useOptionalDataset, useTz } from '../../data/hooks.ts';
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

/** True while the viewport is at least `px` wide (false on the server / without matchMedia). */
export function useMinWidth(px: number): boolean {
  const query = `(min-width: ${px}px)`;
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/**
 * Sticky top bar: menu button (below lg), data as-of time + freshness (once the dataset is loaded), the
 * display time-zone select (works while loading) and the theme toggle.
 */
export function TopBar({ title, onMenu }: { title: string; onMenu: () => void }) {
  const ds = useOptionalDataset();
  const app = useAppStatus();
  const tz = useTz();
  const setTz = ds?.setTz ?? app?.setTz;
  const { preference, setPreference } = useTheme();
  const clock = useClock();
  // A native select is as wide as its longest option: short names on phones (서울 / 시드니 / UTC).
  const wide = useMinWidth(640);
  const ThemeIcon = preference === 'dark' ? Moon : preference === 'light' ? Sun : Monitor;
  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b border-line bg-surface/95 px-3 backdrop-blur sm:px-5">
      <IconButton label="메뉴 열기" onClick={onMenu} className="lg:hidden">
        <Menu className="size-5" aria-hidden />
      </IconButton>
      <p className="min-w-0 flex-1 truncate text-sm font-semibold text-fg lg:hidden">{title}</p>
      <div className="hidden min-w-0 flex-1 lg:block" />
      {ds ? (
        <>
          <p className="hidden items-center gap-1 text-[13px] text-fg-3 md:flex">
            <span>데이터 기준</span>
            <time dateTime={new Date(ds.now).toISOString()} className="font-medium text-fg-2 tabular">
              {fmtTime(ds.now, tz)}
            </time>
            <span>{tzShort(tz)}</span>
          </p>
          <FreshnessBadge generatedAt={ds.now} clock={clock} isSample={ds.isSample} />
        </>
      ) : null}
      <label className="sr-only" htmlFor="tz-select">
        표시 시간대
      </label>
      <select
        id="tz-select"
        value={tz}
        onChange={(e) => setTz?.(e.target.value)}
        disabled={!setTz}
        title="날짜 범위와 시각을 계산·표시할 시간대 (링크에도 담김)"
        className="focus-ring h-8 shrink-0 rounded-md border border-line bg-surface px-2 text-[13px] text-fg"
      >
        {TZ_OPTIONS.map((o) => (
          <option key={o.id} value={o.id}>
            {wide ? o.label : o.compact}
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
