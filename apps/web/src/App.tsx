/**
 * Router (HashRouter: works on GitHub Pages subpaths and behind apps/server without rewrites).
 * Pages are lazy-loaded; each page module must `export default` its component.
 *
 * Startup is parallel, not a waterfall: main.tsx calls preloadPageFor(location.hash) so the current page's
 * chunk downloads while the dataset does, and the shell renders at once (DatasetProvider no longer blocks
 * the whole app). Pages that need data sit under <RequireDataset>; the 404 page does not wait for data.
 */
import { lazy } from 'react';
import type { ComponentType } from 'react';
import { HashRouter, Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { DatasetProvider, RequireDataset } from './data/DatasetProvider.tsx';
import { AppShell } from './components/shell/AppShell.tsx';
// Tiny and data-free: bundled with the shell so an unknown route never waits for a chunk or the dataset.
import NotFound from './pages/NotFound.tsx';
import { pageKeyForPath, pathFromHash } from './lib/routePreload.ts';
import type { PageKey } from './lib/routePreload.ts';

const PAGE_LOADERS: Record<PageKey, () => Promise<{ default: ComponentType }>> = {
  dashboard: () => import('./pages/Dashboard.tsx'),
  watchlist: () => import('./pages/Watchlist.tsx'),
  videos: () => import('./pages/Videos.tsx'),
  keywords: () => import('./pages/Keywords.tsx'),
  trends: () => import('./pages/Trends.tsx'),
  ratings: () => import('./pages/Ratings.tsx'),
  explore: () => import('./pages/Explore.tsx'),
  creators: () => import('./pages/Creators.tsx'),
  creatorDetail: () => import('./pages/CreatorDetail.tsx'),
  compare: () => import('./pages/Compare.tsx'),
  brands: () => import('./pages/Brands.tsx'),
  taxonomy: () => import('./pages/Taxonomy.tsx'),
  coverage: () => import('./pages/Coverage.tsx'),
  apiDocs: () => import('./pages/ApiDocs.tsx'),
  uiKit: () => import('./pages/UiKit.tsx'),
  notFound: () => Promise.resolve({ default: NotFound }),
};

/** Start downloading the page chunk for a `location.hash` (dynamic imports are deduplicated by the browser). */
export function preloadPageFor(hash: string): void {
  const key = pageKeyForPath(pathFromHash(hash));
  PAGE_LOADERS[key]().catch(() => {
    // The lazy route retries and shows the error through the route boundary.
  });
}

const Dashboard = lazy(PAGE_LOADERS.dashboard);
const Watchlist = lazy(PAGE_LOADERS.watchlist);
const Videos = lazy(PAGE_LOADERS.videos);
const Keywords = lazy(PAGE_LOADERS.keywords);
const Trends = lazy(PAGE_LOADERS.trends);
const Ratings = lazy(PAGE_LOADERS.ratings);
const Explore = lazy(PAGE_LOADERS.explore);
const Creators = lazy(PAGE_LOADERS.creators);
const CreatorDetail = lazy(PAGE_LOADERS.creatorDetail);
const Compare = lazy(PAGE_LOADERS.compare);
const Brands = lazy(PAGE_LOADERS.brands);
const Taxonomy = lazy(PAGE_LOADERS.taxonomy);
const Coverage = lazy(PAGE_LOADERS.coverage);
const ApiDocs = lazy(PAGE_LOADERS.apiDocs);
const UiKit = lazy(PAGE_LOADERS.uiKit);

/**
 * `/creators/<key with slashes>` (a niconico key such as `niconico:user/143537376` typed or shared without
 * encoding) -> the encoded single-segment route `/creators/niconico:user%2F143537376`.
 */
function CreatorKeyRedirect() {
  const splat = useParams()['*'] ?? '';
  const { search } = useLocation();
  if (!splat) return <Navigate to={`/creators${search}`} replace />;
  return <Navigate to={`/creators/${encodeURIComponent(splat)}${search}`} replace />;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route element={<RequireDataset />}>
          <Route index element={<Dashboard />} />
          <Route path="watchlist" element={<Watchlist />} />
          <Route path="videos" element={<Videos />} />
          <Route path="keywords" element={<Keywords />} />
          <Route path="trends" element={<Trends />} />
          <Route path="ratings" element={<Ratings />} />
          <Route path="explore" element={<Explore />} />
          <Route path="creators" element={<Creators />} />
          <Route path="creators/:key" element={<CreatorDetail />} />
          <Route path="compare" element={<Compare />} />
          <Route path="brands" element={<Brands />} />
          <Route path="taxonomy" element={<Taxonomy />} />
          <Route path="coverage" element={<Coverage />} />
          {/* ApiDocs reads the data "now" for its examples. */}
          <Route path="api-docs" element={<ApiDocs />} />
          {/* Design-system catalogue for developers (not in the nav). */}
          <Route path="ui-kit" element={<UiKit />} />
        </Route>
        <Route path="creators/*" element={<CreatorKeyRedirect />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}

export function App() {
  return (
    <HashRouter>
      <DatasetProvider>
        <AppRoutes />
      </DatasetProvider>
    </HashRouter>
  );
}
