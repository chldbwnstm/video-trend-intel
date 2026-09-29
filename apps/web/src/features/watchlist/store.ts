/**
 * Watchlist persistence: one in-memory snapshot shared by every pin button and the watchlist page
 * (useSyncExternalStore), backed by localStorage under versioned keys. Every storage access is wrapped in
 * try/catch: storage can be blocked (private mode, sandboxed frames) or full, and the app keeps working with an
 * in-memory list for the page session (`persistent: false`, shown on the page). Other tabs are followed through
 * the `storage` event. Tests swap the backend with setWatchlistStorage(memoryStorage()).
 */
import { useSyncExternalStore } from 'react';
import {
  decodeVisit,
  decodeWatchlist,
  emptyVisit,
  encodeVisit,
  encodeWatchlist,
  WATCHLIST_BACKUP_KEY,
  WATCHLIST_STORAGE_KEY,
  WATCHLIST_VISIT_KEY,
} from './model.ts';
import type { DecodeStatus, VisitState, Watchlist } from './model.ts';

/** Same prefix as lib/storage.ts. */
const PREFIX = 'vti.';

export interface WatchStorage {
  read(key: string): string | null;
  /** false when the value could not be stored. */
  write(key: string, value: string | null): boolean;
  /** Whether values survive a reload. */
  persistent(): boolean;
}

function localStore(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export const browserStorage: WatchStorage = {
  read(key) {
    try {
      return localStore()?.getItem(PREFIX + key) ?? null;
    } catch {
      return null;
    }
  },
  write(key, value) {
    try {
      const s = localStore();
      if (!s) return false;
      if (value === null) s.removeItem(PREFIX + key);
      else s.setItem(PREFIX + key, value);
      return true;
    } catch {
      return false;
    }
  },
  persistent() {
    try {
      const s = localStore();
      if (!s) return false;
      const probe = `${PREFIX}watchlist.probe`;
      s.setItem(probe, '1');
      s.removeItem(probe);
      return true;
    } catch {
      return false;
    }
  },
};

/** In-memory backend (tests; `fail` simulates a blocked / full storage). */
export function memoryStorage(initial: Record<string, string> = {}, fail = false): WatchStorage & { dump(): Record<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    read: (key) => data.get(key) ?? null,
    write: (key, value) => {
      if (fail) return false;
      if (value === null) data.delete(key);
      else data.set(key, value);
      return true;
    },
    persistent: () => !fail,
    dump: () => Object.fromEntries(data),
  };
}

/* ------------------------------------------------------------------------------------------ store */

export interface WatchlistSnapshot {
  list: Watchlist;
  /** How the stored document was read at load ('ok' after any successful change). */
  status: DecodeStatus;
  /** Malformed / duplicated items dropped when reading. */
  dropped: number;
  /** Items cut by the list limits when reading. */
  truncated: number;
  /** false: storage unavailable or the last write failed; the list only lasts for this page session. */
  persistent: boolean;
}

let backend: WatchStorage = browserStorage;
let snapshot: WatchlistSnapshot | null = null;
const listeners = new Set<() => void>();
let detachStorageEvent: (() => void) | null = null;

function load(): WatchlistSnapshot {
  const raw = backend.read(WATCHLIST_STORAGE_KEY);
  const r = decodeWatchlist(raw);
  return { list: r.list, status: r.status, dropped: r.dropped, truncated: r.truncated, persistent: backend.persistent() };
}

function emit(): void {
  for (const l of [...listeners]) l();
}

export function getWatchlist(): WatchlistSnapshot {
  if (!snapshot) snapshot = load();
  return snapshot;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!detachStorageEvent && typeof window !== 'undefined' && backend === browserStorage) {
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === PREFIX + WATCHLIST_STORAGE_KEY) {
        snapshot = load();
        emit();
      }
    };
    window.addEventListener('storage', onStorage);
    detachStorageEvent = () => window.removeEventListener('storage', onStorage);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size && detachStorageEvent) {
      detachStorageEvent();
      detachStorageEvent = null;
    }
  };
}

/**
 * Apply a change and persist it. A stored document that could not be read ('corrupt' / 'unsupported_version')
 * is copied to WATCHLIST_BACKUP_KEY once before it is overwritten, so nothing is lost silently.
 */
export function updateWatchlist(change: (list: Watchlist) => Watchlist): Watchlist {
  const cur = getWatchlist();
  const next = change(cur.list);
  if (next === cur.list) return cur.list;
  if (cur.status === 'corrupt' || cur.status === 'unsupported_version') {
    const raw = backend.read(WATCHLIST_STORAGE_KEY);
    if (raw !== null && backend.read(WATCHLIST_BACKUP_KEY) === null) backend.write(WATCHLIST_BACKUP_KEY, raw);
  }
  const ok = backend.write(WATCHLIST_STORAGE_KEY, encodeWatchlist(next));
  snapshot = { list: next, status: 'ok', dropped: 0, truncated: 0, persistent: ok };
  emit();
  return next;
}

/** Re-read from storage (after the backend changed, or on demand). */
export function reloadWatchlist(): WatchlistSnapshot {
  snapshot = load();
  emit();
  return snapshot;
}

/** Swap the storage backend (tests). Returns the previous one. */
export function setWatchlistStorage(next: WatchStorage): WatchStorage {
  const prev = backend;
  if (detachStorageEvent) {
    detachStorageEvent();
    detachStorageEvent = null;
  }
  backend = next;
  snapshot = null;
  return prev;
}

/** The shared watchlist snapshot (re-renders on every change, also from other tabs). */
export function useWatchlist(): WatchlistSnapshot {
  return useSyncExternalStore(subscribe, getWatchlist, getWatchlist);
}

/* ------------------------------------------------------------------------------------------ visits */

export function readVisit(): VisitState {
  try {
    return decodeVisit(backend.read(WATCHLIST_VISIT_KEY));
  } catch {
    return emptyVisit();
  }
}

export function writeVisit(v: VisitState): boolean {
  return backend.write(WATCHLIST_VISIT_KEY, encodeVisit(v));
}
