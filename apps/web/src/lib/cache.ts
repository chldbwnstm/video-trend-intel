/**
 * Result cache for analytics computed from a dataset index. Keyed by the index object (WeakMap, so a
 * reloaded dataset drops old entries) and a string key describing the inputs. Small LRU per index.
 */

const MAX_ENTRIES = 64;
const caches = new WeakMap<object, Map<string, unknown>>();

export function cached<T>(owner: object, key: string, compute: () => T): T {
  let map = caches.get(owner);
  if (!map) {
    map = new Map();
    caches.set(owner, map);
  }
  if (map.has(key)) {
    const hit = map.get(key) as T;
    // refresh LRU position
    map.delete(key);
    map.set(key, hit);
    return hit;
  }
  const value = compute();
  map.set(key, value);
  if (map.size > MAX_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  return value;
}

/** Deterministic JSON (sorted object keys, `undefined` dropped) for cache keys and URL-derived inputs. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = sortKeys(x);
    }
    return out;
  }
  return v;
}
