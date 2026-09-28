import { NavLink } from 'react-router-dom';
import { Activity } from 'lucide-react';
import { cx } from '../../lib/cx.ts';
import { APP_NAME, NAV_SECTIONS } from '../../routes.ts';
import { useOptionalDataset, useTz } from '../../data/hooks.ts';
import { fmtTime } from '../../lib/display.ts';
import { tzShort } from '../../lib/timezones.ts';

/** Left navigation (fixed on desktop, inside a Drawer below 1024px). */
export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const ds = useOptionalDataset();
  const tz = useTz();
  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-fg">
      <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-sidebar-line px-4">
        <span className="inline-flex size-8 items-center justify-center rounded-lg bg-sidebar-active text-sidebar-fg-strong" aria-hidden>
          <Activity className="size-4.5" />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[15px] leading-tight font-bold text-sidebar-fg-strong">{APP_NAME}</span>
          <span className="block text-[11px] leading-tight text-sidebar-fg opacity-80">멀티 플랫폼 영상·크리에이터 분석</span>
        </span>
      </div>
      <nav aria-label="주 메뉴" className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 py-3">
        {NAV_SECTIONS.map((section) => (
          <div key={section.id} className="mb-3">
            <p className="px-2.5 pb-1 text-[11px] font-semibold tracking-wider text-sidebar-fg uppercase opacity-60">{section.label}</p>
            <ul className="flex flex-col gap-0.5">
              {section.items.map((item) => {
                const Icon = item.icon;
                return (
                  <li key={item.path}>
                    <NavLink
                      to={item.path}
                      end={item.end}
                      onClick={onNavigate}
                      className={({ isActive }) =>
                        cx(
                          'focus-ring flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors',
                          isActive
                            ? 'bg-sidebar-active font-semibold text-sidebar-fg-strong'
                            : 'text-sidebar-fg hover:bg-sidebar-2 hover:text-sidebar-fg-strong',
                        )
                      }
                    >
                      <Icon className="size-4 shrink-0" aria-hidden />
                      <span className="truncate">{item.label}</span>
                    </NavLink>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
      <div className="shrink-0 border-t border-sidebar-line px-4 py-3 text-[11px] leading-relaxed text-sidebar-fg opacity-80">
        {ds ? (
          <>
            <p>
              데이터 기준 {fmtTime(ds.now, tz)} {tzShort(tz)}
            </p>
            <p>
              영상 {ds.dataset.videos.length.toLocaleString('ko-KR')} · 계정 {ds.dataset.accounts.length.toLocaleString('ko-KR')} · 분류 {ds.dataset.classifierVersion}
            </p>
            {ds.isSample ? <p className="font-semibold text-[var(--sample-line)]">샘플 데이터 사용 중</p> : null}
          </>
        ) : (
          <p>데이터 불러오는 중</p>
        )}
      </div>
    </div>
  );
}
