/**
 * Time-zone aware calendar helpers (no external deps; uses Intl).
 * OWNER: core-metrics agent. Signatures are contract — implement, do not rename.
 *
 * Implementation notes
 * - The only Intl call is `formatToParts` to learn a zone's UTC offset at an instant. Offsets are
 *   cached per (zone, UTC day): a UTC day whose first and last second share the same offset is
 *   assumed to have no transition inside it (true for every real zone: transitions are months apart).
 *   Days that contain a transition are marked and resolved per call. Everything else is integer
 *   arithmetic, so hot paths (localDateOf over ~20k videos) stay cheap.
 * - Local midnights are resolved like Temporal's "earlier" disambiguation: the first instant whose
 *   local calendar date is `date`. When local midnight does not exist (a DST gap at 00:00, e.g.
 *   America/Santiago), the day starts at the transition instant.
 */
import type { LocalDateRange, UtcWindow } from './types.ts';

export const DEFAULT_TZ = 'Asia/Seoul';
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

/* ------------------------------------------------------------------------------------------
 * Civil-date arithmetic (proleptic Gregorian, days since 1970-01-01). H. Hinnant's algorithms.
 * ---------------------------------------------------------------------------------------- */

function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m > 2 ? m - 3 : m + 9) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(days: number): [number, number, number] {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  return [y, m, d];
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function pad4(n: number): string {
  if (n >= 1000) return String(n);
  if (n >= 0) return String(n).padStart(4, '0');
  return `-${String(-n).padStart(4, '0')}`;
}

function formatDays(days: number): string {
  const [y, m, d] = civilFromDays(days);
  return `${pad4(y)}-${pad2(m)}-${pad2(d)}`;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parse `YYYY-MM-DD` into days since epoch. Throws RangeError on malformed or impossible dates. */
function parseDateDays(date: string): number {
  const m = DATE_RE.exec(date);
  if (!m) throw new RangeError(`Invalid local date (expected YYYY-MM-DD): ${String(date)}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) throw new RangeError(`Invalid local date: ${date}`);
  const days = daysFromCivil(y, mo, d);
  const [cy, cm, cd] = civilFromDays(days);
  if (cy !== y || cm !== mo || cd !== d) throw new RangeError(`Invalid local date: ${date}`);
  return days;
}

/** True when `date` is a valid `YYYY-MM-DD` calendar date. */
export function isValidLocalDate(date: string): boolean {
  try {
    parseDateDays(date);
    return true;
  } catch {
    return false;
  }
}

/** Number of calendar days from `a` to `b` (`b - a`), both `YYYY-MM-DD`. */
export function daysBetween(a: string, b: string): number {
  return parseDateDays(b) - parseDateDays(a);
}

/* ------------------------------------------------------------------------------------------
 * Zone offsets
 * ---------------------------------------------------------------------------------------- */

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    dtfCache.set(tz, f);
  }
  return f;
}

/** Offset (local - UTC, ms) of `tz` at instant `ms`, straight from Intl (no cache). */
function rawOffset(ms: number, tz: string): number {
  const sec = Math.floor(ms / 1000) * 1000;
  const parts = formatter(tz).formatToParts(sec);
  let y = 1970;
  let mo = 1;
  let d = 1;
  let h = 0;
  let mi = 0;
  let s = 0;
  let bc = false;
  for (const p of parts) {
    switch (p.type) {
      case 'year':
        y = Number(p.value);
        break;
      case 'month':
        mo = Number(p.value);
        break;
      case 'day':
        d = Number(p.value);
        break;
      case 'hour':
        h = Number(p.value) % 24; // some engines emit "24" at midnight
        break;
      case 'minute':
        mi = Number(p.value);
        break;
      case 'second':
        s = Number(p.value);
        break;
      case 'era':
        bc = /^b/i.test(p.value);
        break;
      default:
        break;
    }
  }
  if (bc) y = 1 - y;
  const localAsUtc = daysFromCivil(y, mo, d) * DAY + h * HOUR + mi * 60_000 + s * 1000;
  return localAsUtc - sec;
}

const MIXED = Number.NaN;
const offsetCache = new Map<string, Map<number, number>>();
const OFFSET_CACHE_MAX = 200_000;

/** UTC offset (ms, local - UTC) of `tz` at instant `ms`. */
export function tzOffsetMs(ms: number, tz: string): number {
  let m = offsetCache.get(tz);
  if (!m) {
    formatter(tz); // validate the zone eagerly (throws RangeError on unknown zones)
    m = new Map();
    offsetCache.set(tz, m);
  }
  const bucket = Math.floor(ms / DAY);
  let o = m.get(bucket);
  if (o === undefined) {
    const a = rawOffset(bucket * DAY, tz);
    const b = rawOffset(bucket * DAY + DAY - 1000, tz);
    o = a === b ? a : MIXED;
    if (m.size >= OFFSET_CACHE_MAX) m.clear();
    m.set(bucket, o);
  }
  return Number.isNaN(o) ? rawOffset(ms, tz) : o;
}

/* ------------------------------------------------------------------------------------------
 * Public API
 * ---------------------------------------------------------------------------------------- */

const startCache = new Map<string, number>();
const START_CACHE_MAX = 100_000;

/** UTC instant of local midnight at the start of `date` (YYYY-MM-DD) in `tz`. Must be DST-correct (e.g. Australia/Sydney). */
export function localDateStartUtc(date: string, tz: string): number {
  const key = `${tz}|${date}`;
  const hit = startCache.get(key);
  if (hit !== undefined) return hit;

  const days = parseDateDays(date);
  const wall = days * DAY; // local midnight expressed as if it were UTC
  const oBefore = tzOffsetMs(wall - DAY, tz);
  const oAfter = tzOffsetMs(wall + DAY, tz);
  const c1 = wall - oBefore;
  const c2 = wall - oAfter;
  const ok1 = tzOffsetMs(c1, tz) === oBefore;
  const ok2 = tzOffsetMs(c2, tz) === oAfter;
  let result: number;
  if (ok1 && ok2) result = Math.min(c1, c2); // normal day, or repeated midnight -> earlier
  else if (ok1) result = c1;
  else if (ok2) result = c2;
  else {
    // Local midnight falls in a DST gap: the day starts at the first instant whose local date is `date`.
    let lo = Math.min(c1, c2);
    let hi = Math.max(c1, c2);
    if (localDateOf(lo, tz) >= date || localDateOf(hi, tz) < date) {
      result = c1;
    } else {
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (localDateOf(mid, tz) >= date) hi = mid;
        else lo = mid;
      }
      result = hi;
    }
  }
  if (startCache.size >= START_CACHE_MAX) startCache.clear();
  startCache.set(key, result);
  return result;
}

/** Local calendar date (YYYY-MM-DD) of instant `ms` in `tz`. */
export function localDateOf(ms: number, tz: string): string {
  const local = ms + tzOffsetMs(ms, tz);
  return formatDays(Math.floor(local / DAY));
}

/**
 * Resolve an inclusive local date range to a half-open UTC window [start 00:00, (end+1) 00:00). `incomplete` = endMs > now.
 * An inverted range (end < start) is normalized by swapping the ends. Malformed dates throw RangeError.
 */
export function resolveWindow(range: LocalDateRange, tz: string, now: number): UtcWindow {
  let { start, end } = range;
  if (parseDateDays(end) < parseDateDays(start)) [start, end] = [end, start];
  const startMs = localDateStartUtc(start, tz);
  const endMs = localDateStartUtc(addDays(end, 1), tz);
  return { startMs, endMs, tz, incomplete: endMs > now };
}

/** A calendar range or, when rollingHours is set, the rolling window [now - rollingHours, now). */
export function resolveAnalysisWindow(range: LocalDateRange, tz: string, now: number, rollingHours?: number | null): UtcWindow {
  return rollingHours ? rollingWindow(rollingHours, now, tz) : resolveWindow(range, tz, now);
}

/** Rolling window [now - hours, now): ends exactly at the data's now, so it is never incomplete. */
export function rollingWindow(hours: number, now: number, tz: string): UtcWindow {
  if (!(Number.isFinite(hours) && hours > 0)) throw new RangeError(`rollingWindow: hours must be > 0, got ${String(hours)}`);
  return { startMs: now - hours * HOUR, endMs: now, tz, incomplete: false };
}

/**
 * True when both ends of `w` are local midnights in `w.tz`, i.e. `w` is a local date range (anything produced
 * by resolveWindow). Rolling windows ([now - N h, now)) normally are not. False for unknown zones.
 */
export function isLocalDateWindow(w: UtcWindow): boolean {
  try {
    return (
      localDateStartUtc(localDateOf(w.startMs, w.tz), w.tz) === w.startMs &&
      localDateStartUtc(localDateOf(w.endMs, w.tz), w.tz) === w.endMs
    );
  } catch {
    return false;
  }
}

/**
 * The window of equal length immediately preceding `w`.
 * When `w` is aligned to local midnights in `w.tz` (anything produced by resolveWindow), "equal length"
 * means the same number of local calendar days, so DST transitions do not shift the previous window
 * off midnight. Otherwise the same duration in ms is used.
 */
export function previousWindow(w: UtcWindow, now: number): UtcWindow {
  const len = w.endMs - w.startMs;
  try {
    const sd = localDateOf(w.startMs, w.tz);
    const ed = localDateOf(w.endMs, w.tz);
    if (localDateStartUtc(sd, w.tz) === w.startMs && localDateStartUtc(ed, w.tz) === w.endMs) {
      const n = daysBetween(sd, ed);
      if (n > 0) {
        const startMs = localDateStartUtc(addDays(sd, -n), w.tz);
        return { startMs, endMs: w.startMs, tz: w.tz, incomplete: w.startMs > now };
      }
    }
  } catch {
    // fall through to the fixed-duration window
  }
  return { startMs: w.startMs - len, endMs: w.startMs, tz: w.tz, incomplete: w.startMs > now };
}

export type RangePreset =
  | 'today'
  | 'yesterday'
  | 'last7d'
  | 'last30d'
  | 'last90d'
  | 'thisWeek'
  | 'lastWeek'
  | 'thisMonth'
  | 'lastMonth'
  | 'rolling24h'
  | 'rolling7d'
  | 'rolling30d';

/** Rolling presets resolve to [now - hours, now) instead of whole local days (see rollingWindow). */
export const ROLLING_PRESET_HOURS: Readonly<Partial<Record<RangePreset, number>>> = { rolling24h: 24, rolling7d: 168, rolling30d: 720 };

/** Hours of a rolling preset, or null for calendar presets. */
export function presetRollingHours(preset: RangePreset | null | undefined): number | null {
  return preset ? (ROLLING_PRESET_HOURS[preset] ?? null) : null;
}

export const RANGE_PRESETS: RangePreset[] = [
  'today',
  'yesterday',
  'last7d',
  'last30d',
  'last90d',
  'thisWeek',
  'lastWeek',
  'thisMonth',
  'lastMonth',
  'rolling24h',
  'rolling7d',
  'rolling30d',
];

/**
 * Local date range for a preset relative to `now` in `tz`. last7d = the 7 local days ending today (inclusive). Weeks start Monday.
 * "this" presets (thisWeek, thisMonth) run from the period's first day through today (inclusive), so they
 * resolve to an `incomplete` window; "last" presets are the full previous calendar week / month.
 */
export function presetRange(preset: RangePreset, tz: string, now: number): LocalDateRange {
  const todayDays = Math.floor((now + tzOffsetMs(now, tz)) / DAY);
  const today = formatDays(todayDays);
  const weekday = (((todayDays + 3) % 7) + 7) % 7; // 1970-01-01 was a Thursday (0=Mon)
  const [y, m] = civilFromDays(todayDays);
  switch (preset) {
    case 'today':
      return { start: today, end: today };
    case 'yesterday': {
      const d = formatDays(todayDays - 1);
      return { start: d, end: d };
    }
    case 'last7d':
      return { start: formatDays(todayDays - 6), end: today };
    case 'last30d':
      return { start: formatDays(todayDays - 29), end: today };
    case 'last90d':
      return { start: formatDays(todayDays - 89), end: today };
    case 'thisWeek':
      return { start: formatDays(todayDays - weekday), end: today };
    case 'lastWeek': {
      const monday = todayDays - weekday - 7;
      return { start: formatDays(monday), end: formatDays(monday + 6) };
    }
    case 'thisMonth':
      return { start: formatDays(daysFromCivil(y, m, 1)), end: today };
    case 'lastMonth': {
      const firstThis = daysFromCivil(y, m, 1);
      const [py, pm] = civilFromDays(firstThis - 1);
      return { start: formatDays(daysFromCivil(py, pm, 1)), end: formatDays(firstThis - 1) };
    }
    case 'rolling24h':
    case 'rolling7d':
    case 'rolling30d': {
      // Local dates touched by [now - hours, now] (display only; analytics use rollingWindow).
      const hours = ROLLING_PRESET_HOURS[preset] as number;
      return { start: localDateOf(now - hours * HOUR, tz), end: today };
    }
    default: {
      const never: never = preset;
      throw new RangeError(`Unknown range preset: ${String(never)}`);
    }
  }
}

/** Format an instant for display in `tz`: 'date' -> `2026-09-28`, 'datetime' -> `2026-09-28 14:05`, 'time' -> `14:05`. */
export function formatInTz(ms: number, tz: string, style: 'date' | 'datetime' | 'time' = 'datetime'): string {
  const local = ms + tzOffsetMs(ms, tz);
  const days = Math.floor(local / DAY);
  const rem = local - days * DAY;
  const hh = Math.floor(rem / HOUR);
  const mm = Math.floor((rem - hh * HOUR) / 60_000);
  const time = `${pad2(hh)}:${pad2(mm)}`;
  if (style === 'time') return time;
  const date = formatDays(days);
  return style === 'date' ? date : `${date} ${time}`;
}

/** Day of week (0=Mon..6=Sun) and hour (0..23) of `ms` in `tz` — used for posting-time heatmaps. */
export function weekdayHourInTz(ms: number, tz: string): { weekday: number; hour: number } {
  const local = ms + tzOffsetMs(ms, tz);
  const days = Math.floor(local / DAY);
  const weekday = (((days + 3) % 7) + 7) % 7;
  const hour = Math.floor((local - days * DAY) / HOUR);
  return { weekday, hour };
}

/** Add `days` calendar days to a YYYY-MM-DD string. */
export function addDays(date: string, days: number): string {
  if (!Number.isInteger(days)) throw new RangeError(`addDays: days must be an integer, got ${days}`);
  return formatDays(parseDateDays(date) + days);
}
