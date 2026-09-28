/**
 * Router (HashRouter: works on GitHub Pages subpaths and behind apps/server without rewrites).
 * Pages are lazy-loaded; each page module must `export default` its component.
 */
import { lazy } from 'react';
import { HashRouter, Route, Routes } from 'react-router-dom';
import { DatasetProvider } from './data/DatasetProvider.tsx';
import { AppShell } from './components/shell/AppShell.tsx';

const Dashboard = lazy(() => import('./pages/Dashboard.tsx'));
const Videos = lazy(() => import('./pages/Videos.tsx'));
const Trends = lazy(() => import('./pages/Trends.tsx'));
const Ratings = lazy(() => import('./pages/Ratings.tsx'));
const Explore = lazy(() => import('./pages/Explore.tsx'));
const Creators = lazy(() => import('./pages/Creators.tsx'));
const CreatorDetail = lazy(() => import('./pages/CreatorDetail.tsx'));
const Compare = lazy(() => import('./pages/Compare.tsx'));
const Brands = lazy(() => import('./pages/Brands.tsx'));
const Taxonomy = lazy(() => import('./pages/Taxonomy.tsx'));
const Coverage = lazy(() => import('./pages/Coverage.tsx'));
const ApiDocs = lazy(() => import('./pages/ApiDocs.tsx'));
const NotFound = lazy(() => import('./pages/NotFound.tsx'));
const UiKit = lazy(() => import('./pages/UiKit.tsx'));

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Dashboard />} />
        <Route path="videos" element={<Videos />} />
        <Route path="trends" element={<Trends />} />
        <Route path="ratings" element={<Ratings />} />
        <Route path="explore" element={<Explore />} />
        <Route path="creators" element={<Creators />} />
        <Route path="creators/:key" element={<CreatorDetail />} />
        <Route path="compare" element={<Compare />} />
        <Route path="brands" element={<Brands />} />
        <Route path="taxonomy" element={<Taxonomy />} />
        <Route path="coverage" element={<Coverage />} />
        <Route path="api-docs" element={<ApiDocs />} />
        {/* Design-system catalogue for developers (not in the nav). */}
        <Route path="ui-kit" element={<UiKit />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}

export function App() {
  return (
    <DatasetProvider>
      <HashRouter>
        <AppRoutes />
      </HashRouter>
    </DatasetProvider>
  );
}
