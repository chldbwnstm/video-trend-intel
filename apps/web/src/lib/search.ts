/**
 * Client-side text matching for pickers and small lists. Uses @vti/core textMatches (the same matching
 * the query engine uses); falls back to NFKC + lowercase substring matching if core throws.
 */
import { textMatches } from '@vti/core';

export function normalizeForSearch(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function textMatchesSafe(haystack: string, needle: string): boolean {
  if (!needle) return true;
  try {
    return textMatches(haystack, needle);
  } catch {
    return normalizeForSearch(haystack).includes(normalizeForSearch(needle));
  }
}
