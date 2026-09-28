import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Hammer } from 'lucide-react';
import { navItemByPath } from '../routes.ts';
import { Card } from './primitives.tsx';
import { PageHeader } from './layoutParts.tsx';

/**
 * Temporary page body for screens another engineer is building. Replace the whole page file; keep the
 * default export (App.tsx lazy-loads `default`).
 */
export function PagePlaceholder({ path, planned, children }: { path: string; planned: string[]; children?: ReactNode }) {
  const item = navItemByPath(path);
  return (
    <div className="flex flex-col gap-4">
      <PageHeader eyebrow={item.tubular} title={item.label} description={item.description} />
      <Card className="max-w-3xl">
        <div className="flex items-start gap-3">
          <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-text" aria-hidden>
            <Hammer className="size-4.5" />
          </span>
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-fg">이 화면은 만드는 중</h2>
            <p className="mt-1 text-sm text-fg-2">곧 다음 기능이 들어감:</p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-fg-2">
              {planned.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
            {children}
            <p className="mt-4 text-[13px] text-fg-3">
              지금은{' '}
              <Link to="/" className="focus-ring rounded-sm text-accent-text hover:underline">
                대시보드
              </Link>
              에서 핵심 지표를 볼 수 있음.
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
}
