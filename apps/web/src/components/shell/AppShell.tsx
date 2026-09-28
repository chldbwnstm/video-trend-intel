import { Suspense, useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { APP_NAME, navItemFor } from '../../routes.ts';
import { Drawer } from '../Overlay.tsx';
import { LoadingState, SectionBoundary } from '../states.tsx';
import { SampleBanner } from './SampleBanner.tsx';
import { Sidebar } from './Sidebar.tsx';
import { TopBar } from './TopBar.tsx';

/**
 * App layout: fixed sidebar >= 1024px, drawer navigation below; sample banner; sticky top bar;
 * route content inside an error boundary (reset on navigation) and Suspense (lazy pages).
 */
export function AppShell() {
  const location = useLocation();
  const [navOpen, setNavOpen] = useState(false);
  const item = navItemFor(location.pathname);
  const title = item?.label ?? (location.pathname === '/ui-kit' ? 'UI 카탈로그' : '페이지 없음');

  // Close the drawer on navigation and when the viewport grows to desktop.
  useEffect(() => setNavOpen(false), [location.pathname]);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(min-width: 1024px)');
    const onChange = () => {
      if (mq.matches) setNavOpen(false);
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // Page title + scroll to top on route change (not on query-string changes).
  useEffect(() => {
    document.title = item && item.path !== '/' ? `${item.label} · ${APP_NAME}` : APP_NAME;
    window.scrollTo({ top: 0 });
  }, [location.pathname, item]);

  return (
    <div className="min-h-dvh bg-canvas lg:pl-64">
      <a
        href="#main"
        onClick={(e) => {
          // HashRouter owns the hash: move focus instead of navigating.
          e.preventDefault();
          document.getElementById('main')?.focus();
        }}
        className="focus-ring sr-only z-[80] rounded-md bg-accent px-3 py-2 text-on-accent focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        본문으로 건너뛰기
      </a>
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-64 border-r border-sidebar-line lg:block" aria-label="사이드바">
        <Sidebar />
      </aside>
      <Drawer open={navOpen} onClose={() => setNavOpen(false)} title="메뉴" side="left" width="min(288px, 88vw)" bare className="bg-sidebar" closeClassName="text-sidebar-fg hover:bg-sidebar-2 hover:text-sidebar-fg-strong">
        <Sidebar onNavigate={() => setNavOpen(false)} />
      </Drawer>
      <div className="flex min-h-dvh min-w-0 flex-col">
        <SampleBanner />
        <TopBar title={title} onMenu={() => setNavOpen(true)} />
        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-[1600px] min-w-0 flex-1 px-4 py-5 outline-none sm:px-6 lg:py-6">
          <SectionBoundary title="페이지를 표시하지 못함" resetKey={location.pathname}>
            <Suspense fallback={<LoadingState label="화면 불러오는 중" />}>
              <Outlet />
            </Suspense>
          </SectionBoundary>
        </main>
      </div>
    </div>
  );
}
