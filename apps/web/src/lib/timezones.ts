/** Display time zones (SPEC principle 7: store UTC, display in an IANA zone). */
export interface TzOption {
  id: string;
  label: string;
  /** Suffix after times (`12:00 KST`). */
  short: string;
  /** Option text on narrow screens (the top-bar select). */
  compact: string;
}

export const TZ_OPTIONS: TzOption[] = [
  { id: 'Asia/Seoul', label: '서울 (Asia/Seoul)', short: 'KST', compact: '서울' },
  { id: 'Australia/Sydney', label: '시드니 (Australia/Sydney)', short: '시드니', compact: '시드니' },
  { id: 'UTC', label: '협정 세계시 (UTC)', short: 'UTC', compact: 'UTC' },
];

export const DEFAULT_DISPLAY_TZ = 'Asia/Seoul';

/** True when `tz` is a valid IANA zone accepted by Intl. */
export function isValidTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Only the offered zones are accepted from storage/URL; anything else falls back to the default. */
export function normalizeTz(tz: string | null | undefined): string {
  if (tz && TZ_OPTIONS.some((o) => o.id === tz) && isValidTimeZone(tz)) return tz;
  return DEFAULT_DISPLAY_TZ;
}

export function tzShort(tz: string): string {
  return TZ_OPTIONS.find((o) => o.id === tz)?.short ?? tz;
}
