/**
 * Light / dark / system theme. A tiny external store (no provider needed): `useTheme()` anywhere.
 * The inline script in index.html applies the saved preference before first paint; keep them in sync.
 */
import { useSyncExternalStore } from 'react';
import { readStored, STORAGE_KEYS, writeStored } from './storage.ts';

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_LABELS: Record<ThemePreference, string> = {
  system: '시스템 설정',
  light: '라이트',
  dark: '다크',
};

function readPreference(): ThemePreference {
  const v = readStored(STORAGE_KEYS.theme);
  return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
}

function systemDark(): boolean {
  try {
    return typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

export function resolveTheme(pref: ThemePreference, prefersDark: boolean): ResolvedTheme {
  if (pref === 'system') return prefersDark ? 'dark' : 'light';
  return pref;
}

interface ThemeState {
  preference: ThemePreference;
  resolved: ResolvedTheme;
}

let state: ThemeState = { preference: 'system', resolved: 'light' };
let initialized = false;
const listeners = new Set<() => void>();

function apply(): void {
  if (typeof document !== 'undefined') document.documentElement.setAttribute('data-theme', state.resolved);
}

function recompute(pref: ThemePreference): void {
  const next: ThemeState = { preference: pref, resolved: resolveTheme(pref, systemDark()) };
  if (next.preference !== state.preference || next.resolved !== state.resolved) {
    state = next;
    apply();
    listeners.forEach((l) => l());
  }
}

function init(): void {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;
  const pref = readPreference();
  state = { preference: pref, resolved: resolveTheme(pref, systemDark()) };
  apply();
  try {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      if (state.preference === 'system') recompute('system');
    };
    mq.addEventListener('change', onChange);
  } catch {
    // matchMedia unavailable
  }
}

export function setThemePreference(pref: ThemePreference): void {
  init();
  writeStored(STORAGE_KEYS.theme, pref);
  recompute(pref);
}

function subscribe(listener: () => void): () => void {
  init();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): ThemeState {
  init();
  return state;
}

const SERVER_STATE: ThemeState = { preference: 'system', resolved: 'light' };

export function useTheme(): ThemeState & { setPreference: (pref: ThemePreference) => void } {
  const s = useSyncExternalStore(subscribe, getSnapshot, () => SERVER_STATE);
  return { ...s, setPreference: setThemePreference };
}
