/**
 * Which lazily-loaded page module a URL needs (App.tsx maps the keys to `import()` calls). main.tsx uses it
 * to start the page chunk download at startup, in parallel with the dataset download, instead of after it.
 * Pure: tested in routePreload.test.ts. Keep in sync with the routes in App.tsx.
 */

export type PageKey =
  | 'dashboard'
  | 'watchlist'
  | 'videos'
  | 'keywords'
  | 'trends'
  | 'ratings'
  | 'explore'
  | 'creators'
  | 'creatorDetail'
  | 'compare'
  | 'brands'
  | 'taxonomy'
  | 'coverage'
  | 'apiDocs'
  | 'uiKit'
  | 'notFound';

const EXACT: Record<string, PageKey> = {
  '/': 'dashboard',
  '/watchlist': 'watchlist',
  '/videos': 'videos',
  '/keywords': 'keywords',
  '/trends': 'trends',
  '/ratings': 'ratings',
  '/explore': 'explore',
  '/creators': 'creators',
  '/compare': 'compare',
  '/brands': 'brands',
  '/taxonomy': 'taxonomy',
  '/coverage': 'coverage',
  '/api-docs': 'apiDocs',
  '/ui-kit': 'uiKit',
};

/** Router pathname of a `location.hash` (`#/videos?x=1` -> `/videos`; empty -> `/`). */
export function pathFromHash(hash: string): string {
  const body = hash.startsWith('#') ? hash.slice(1) : hash;
  const q = body.indexOf('?');
  const path = (q >= 0 ? body.slice(0, q) : body) || '/';
  return path.startsWith('/') ? path : `/${path}`;
}

export function pageKeyForPath(pathname: string): PageKey {
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  const exact = EXACT[p];
  if (exact) return exact;
  if (p.startsWith('/creators/')) return 'creatorDetail';
  return 'notFound';
}
