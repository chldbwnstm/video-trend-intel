/**
 * localStorage wrapped in try/catch: storage can be blocked (private mode, sandboxed iframes, quota),
 * and the app must work without it. Only per-viewer conveniences (theme, time zone) are stored here.
 */

const PREFIX = 'vti.';

function storage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readStored(key: string): string | null {
  try {
    return storage()?.getItem(PREFIX + key) ?? null;
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string | null): void {
  try {
    const s = storage();
    if (!s) return;
    if (value === null) s.removeItem(PREFIX + key);
    else s.setItem(PREFIX + key, value);
  } catch {
    // ignore: storage unavailable or full
  }
}

export const STORAGE_KEYS = {
  theme: 'theme',
  tz: 'tz',
  sidebarCollapsed: 'sidebarCollapsed',
} as const;
