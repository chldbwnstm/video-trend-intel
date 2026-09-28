/**
 * Number / time formatting for the Korean UI. Pure functions (no React), safe in tests and workers.
 *
 * Conventions
 * - `null` / `undefined` / non-finite input renders as `—` (never as 0: 없는 값은 0이 아니다).
 * - Compact counts use Korean myriad units (만 = 10^4, 억 = 10^8, 조 = 10^12), not 천/K/M.
 * - Exact values (for tooltips) use ko-KR grouping: 12,345.
 */

export const DASH = '—';

const intFmt = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 0 });
const dec1Fmt = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 1 });
const dec2Fmt = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 });

function isNum(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

/** `12345` -> `12,345`. Rounds to an integer. */
export function formatInteger(n: number | null | undefined): string {
  if (!isNum(n)) return DASH;
  return intFmt.format(Math.round(n));
}

/** Up to `digits` fraction digits (default 1), ko-KR grouping: `1234.56` -> `1,234.6`. */
export function formatDecimal(n: number | null | undefined, digits = 1): string {
  if (!isNum(n)) return DASH;
  if (digits === 0) return intFmt.format(Math.round(n));
  if (digits === 1) return dec1Fmt.format(n);
  if (digits === 2) return dec2Fmt.format(n);
  return new Intl.NumberFormat('ko-KR', { maximumFractionDigits: digits }).format(n);
}

const UNITS: { value: number; label: string }[] = [
  { value: 1e12, label: '조' },
  { value: 1e8, label: '억' },
  { value: 1e4, label: '만' },
];

/**
 * Compact Korean count: `9,999` -> `9,999`, `12,345` -> `1.2만`, `1,234,567` -> `123.5만`,
 * `98,765,432` -> `9,877만`, `123,456,789` -> `1.2억`.
 * One fraction digit while the unit count is < 1,000 (so `123.5만`), none above (`1,234만`).
 * Values below 10,000 are shown in full (rounded to integers; fractions below 10 keep 1 digit).
 */
export function formatCompact(n: number | null | undefined): string {
  if (!isNum(n)) return DASH;
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  for (let i = 0; i < UNITS.length; i++) {
    const u = UNITS[i];
    if (abs >= u.value) {
      const scaled = abs / u.value;
      // Rounding can carry into the next unit (e.g. 99,995,000 -> 9,999.5만 -> "1억" is nicer than "10,000만").
      const digits = scaled < 1000 ? 1 : 0;
      const rounded = Number(scaled.toFixed(digits));
      if (i > 0 && rounded >= 10_000) {
        const up = UNITS[i - 1];
        return `${sign}${dec1Fmt.format(Number((abs / up.value).toFixed(1)))}${up.label}`;
      }
      return `${sign}${digits === 1 ? dec1Fmt.format(rounded) : intFmt.format(rounded)}${u.label}`;
    }
  }
  if (abs < 10 && abs % 1 !== 0) return `${sign}${dec1Fmt.format(abs)}`;
  // 9,999.6 would round to 10,000 -> show as 1만 for consistency.
  if (Math.round(abs) >= 10_000) return `${sign}1만`;
  return `${sign}${intFmt.format(Math.round(abs))}`;
}

/** Ratio -> percent: `0.0345` -> `3.5%`. Small values keep 2 digits (`0.0012` -> `0.12%`). */
export function formatPercent(ratio: number | null | undefined, digits?: number): string {
  if (!isNum(ratio)) return DASH;
  const pct = ratio * 100;
  const d = digits ?? (Math.abs(pct) < 1 && pct !== 0 ? 2 : 1);
  return `${formatDecimal(pct, d)}%`;
}

/**
 * Growth ratio (current / previous - 1) as a signed percent: `0.34` -> `+34%`, `-0.056` -> `-5.6%`
 * (one decimal below 10%, none above). From +1,000% on, the multiple of the previous value reads better:
 * `12.3` -> `13.3배`, `3957` -> `3,958배`. Zero renders `0%`.
 */
export function formatGrowth(ratio: number | null | undefined): string {
  if (!isNum(ratio)) return DASH;
  const pct = ratio * 100;
  if (Math.abs(pct) < 0.05) return '0%';
  if (ratio >= 10) {
    const times = ratio + 1;
    return `${formatDecimal(times, times >= 100 ? 0 : 1)}배`;
  }
  const digits = Math.abs(pct) >= 10 ? 0 : 1;
  const body = formatDecimal(Math.abs(pct), digits);
  return `${pct > 0 ? '+' : '-'}${body}%`;
}

/** Multiplier: `2.345` -> `2.3배`. */
export function formatMultiplier(x: number | null | undefined): string {
  if (!isNum(x)) return DASH;
  return `${formatDecimal(x, x >= 10 ? 0 : 1)}배`;
}

/** Duration in seconds -> `m:ss` or `h:mm:ss`. */
export function formatDuration(sec: number | null | undefined): string {
  if (!isNum(sec) || sec < 0) return DASH;
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (x: number) => String(x).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

/**
 * Relative time in Korean between `ms` and `now`: `방금`, `5분 전`, `3시간 전`, `2일 전`, `3시간 후`.
 */
export function formatRelative(ms: number | null | undefined, now: number): string {
  if (!isNum(ms)) return DASH;
  const diff = now - ms;
  const future = diff < 0;
  const abs = Math.abs(diff);
  const min = Math.floor(abs / 60_000);
  let body: string;
  if (min < 1) return '방금';
  if (min < 60) body = `${min}분`;
  else if (min < 60 * 24) body = `${Math.floor(min / 60)}시간`;
  else if (min < 60 * 24 * 60) body = `${Math.floor(min / (60 * 24))}일`;
  else body = `${Math.floor(min / (60 * 24 * 30))}개월`;
  return `${body} ${future ? '후' : '전'}`;
}

/**
 * Past-only relative time for freshness ("last success N분 전"): an instant after `now` (clock skew, a run
 * that finished after the data's now) reads `방금`, never `N분 후`.
 */
export function formatAgo(ms: number | null | undefined, now: number): string {
  if (!isNum(ms)) return DASH;
  return formatRelative(Math.min(ms, now), now);
}

/** Hours between two instants, 1 decimal: used by freshness badges. */
export function hoursBetween(a: number, b: number): number {
  return Math.round(((b - a) / 3_600_000) * 10) / 10;
}

/** Bytes -> `1.2 MB`. */
export function formatBytes(bytes: number | null | undefined): string {
  if (!isNum(bytes) || bytes < 0) return DASH;
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${formatDecimal(v, 1)} ${units[i]}`;
}

/** Percentile 0..100 -> `백분위 87`. */
export function formatPercentile(p: number | null | undefined): string {
  if (!isNum(p)) return DASH;
  return `백분위 ${Math.round(p)}`;
}

/** Korean particle-free count label: `formatCount(3, '개')` -> `3개`, with grouping. */
export function formatCount(n: number | null | undefined, unit = ''): string {
  if (!isNum(n)) return DASH;
  return `${formatInteger(n)}${unit}`;
}
