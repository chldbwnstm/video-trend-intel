/**
 * App shell before / after the dataset loads (server render, no DOM): the shell and the 404 route render
 * without data, data pages wait under <RequireDataset>, the display time zone comes from the URL first,
 * and the pager brings the results back into view after a page change.
 */
import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { AppRoutes } from '../../App.tsx';
import { AppStatusContext } from '../../data/context.ts';
import type { AppStatusValue } from '../../data/context.ts';
import { DatasetProvider, RequireDataset } from '../../data/DatasetProvider.tsx';
import { useTz } from '../../data/hooks.ts';
import { pagerScrollTarget, revealResults } from '../MultiSelect.tsx';
import { documentTitle, shellTitle } from './AppShell.tsx';
import { TopBar } from './TopBar.tsx';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

function status(over: Partial<AppStatusValue> = {}): AppStatusValue {
  return { status: 'loading', failure: null, tz: 'Asia/Seoul', setTz: () => undefined, reload: () => undefined, loadSample: () => undefined, ...over };
}

function renderAt(url: string, el: ReactElement, app: AppStatusValue | null = status()): string {
  const tree = h(MemoryRouter, { initialEntries: [url] }, el);
  return renderToStaticMarkup(app ? h(AppStatusContext.Provider, { value: app }, tree) : tree);
}

const mainOf = (html: string) => text(html.slice(html.indexOf('<main'), html.indexOf('</main>')));

describe('shell while the dataset loads', () => {
  it('renders the sidebar, the top bar and a loading state for data pages', () => {
    const html = renderAt('/videos', h(AppRoutes));
    const t = text(html);
    expect(t).toContain('영상 탐색'); // nav + top-bar title
    expect(t).toContain('표시 시간대');
    expect(mainOf(html)).toContain('데이터 불러오는 중');
  });
  it('does not gate the 404 route on the dataset', () => {
    const html = renderAt('/does-not-exist', h(AppRoutes));
    expect(text(html)).toContain('페이지 없음');
    expect(mainOf(html)).not.toContain('데이터 불러오는 중');
    // Bundled with the shell: no chunk to wait for either.
    expect(mainOf(html)).toContain('페이지를 찾을 수 없음');
  });
  it('shows the load failure with retry and the explicit sample option inside the shell', () => {
    const failure = { ok: false as const, kind: 'unavailable' as const, url: './data/dataset.json', message: 'HTTP 404', canUseSample: true };
    const t = text(renderAt('/', h(RequireDataset, null, h('p', null, 'page')), status({ status: 'error', failure })));
    expect(t).toContain('데이터 파일을 불러오지 못함');
    expect(t).toContain('다시 시도');
    expect(t).toContain('샘플 데이터로 보기');
    expect(t).not.toContain('page');
  });
});

describe('titles', () => {
  it('names unknown routes in the top bar and the browser tab', () => {
    expect(shellTitle('/nope')).toBe('페이지 없음');
    expect(documentTitle('/nope')).toBe('페이지 없음 · 영상 트렌드 인텔리전스');
    expect(documentTitle('/videos')).toBe('영상 탐색 · 영상 트렌드 인텔리전스');
    expect(documentTitle('/')).toBe('영상 트렌드 인텔리전스');
  });
});

describe('time zone from the URL', () => {
  function Probe() {
    return h('span', { id: 'tz' }, useTz());
  }
  it('a tz in a shared link wins over the stored preference', () => {
    const html = renderToStaticMarkup(h(MemoryRouter, { initialEntries: ['/videos?tz=Australia/Sydney'] }, h(DatasetProvider, null, h(Probe))));
    expect(html).toContain('<span id="tz">Australia/Sydney</span>');
  });
  it('ignores zones that are not offered', () => {
    const html = renderToStaticMarkup(h(MemoryRouter, { initialEntries: ['/videos?tz=Mars/Base'] }, h(DatasetProvider, null, h(Probe))));
    expect(html).toContain('<span id="tz">Asia/Seoul</span>');
  });
});

describe('TopBar', () => {
  it('uses short time-zone names on narrow screens (server render = narrow)', () => {
    const t = text(renderAt('/', h(TopBar, { title: 'x', onMenu: () => undefined })));
    expect(t).toContain('서울');
    expect(t).toContain('시드니');
    expect(t).not.toContain('Asia/Seoul');
  });
});

describe('pager scroll helpers', () => {
  // Minimal element doubles: enough of the DOM API the helpers use.
  interface FakeEl {
    tagName: string;
    top: number;
    scrolled: number;
    focused: number;
    children: FakeEl[];
    parent: FakeEl | null;
    data: Set<string>;
    getBoundingClientRect(): { top: number };
    scrollIntoView(): void;
    focus(): void;
    hasAttribute(n: string): boolean;
    setAttribute(n: string, v: string): void;
    getAttribute(n: string): string | null;
    querySelector(sel: string): FakeEl | null;
    closest(sel: string): FakeEl | null;
  }
  function el(tag: string, top = 0): FakeEl {
    const attrs = new Map<string, string>();
    const node: FakeEl = {
      tagName: tag.toUpperCase(),
      top,
      scrolled: 0,
      focused: 0,
      children: [],
      parent: null,
      data: new Set<string>(),
      getBoundingClientRect: () => ({ top: node.top }),
      scrollIntoView: () => {
        node.scrolled++;
      },
      focus: () => {
        node.focused++;
      },
      hasAttribute: (n: string) => attrs.has(n),
      setAttribute: (n: string, v: string) => attrs.set(n, v),
      getAttribute: (n: string) => attrs.get(n) ?? null,
      querySelector: (sel: string): FakeEl | null => {
        for (const c of node.children) {
          if (c.tagName === sel.toUpperCase()) return c;
          const deep = c.querySelector(sel);
          if (deep) return deep;
        }
        return null;
      },
      closest: (sel: string): FakeEl | null => {
        const wanted = sel.includes('data-card') ? 'card' : sel;
        let cur: FakeEl | null = node;
        while (cur) {
          if (cur.data.has(wanted) || cur.data.has('pager-scope')) return cur;
          cur = cur.parent;
        }
        return null;
      },
    };
    return node;
  }
  function tree(tableTop: number) {
    const card = el('section');
    card.data.add('card');
    const table = el('table', tableTop);
    const caption = el('caption');
    const nav = el('nav');
    table.children.push(caption);
    card.children.push(table, nav);
    table.parent = card;
    caption.parent = table;
    nav.parent = card;
    return { card, table, caption, nav };
  }
  it('targets the table in the pager card', () => {
    const { table, nav } = tree(-4000);
    expect(pagerScrollTarget(nav as unknown as Element)).toBe(table);
    expect(pagerScrollTarget(null)).toBeNull();
  });
  it('scrolls back up to the table and focuses its caption when the table start is above the viewport', () => {
    const { table, caption } = tree(-4000);
    const g = globalThis as { window?: unknown };
    const had = 'window' in g;
    g.window = g.window ?? {};
    try {
      revealResults(table as unknown as HTMLElement);
    } finally {
      if (!had) delete g.window;
    }
    expect(table.scrolled).toBe(1);
    expect(caption.focused).toBe(1);
    expect(caption.getAttribute('tabindex')).toBe('-1');
  });
  it('does not jump when the table start is already visible', () => {
    const { table, caption } = tree(120);
    const g = globalThis as { window?: unknown };
    const had = 'window' in g;
    g.window = g.window ?? {};
    try {
      revealResults(table as unknown as HTMLElement);
    } finally {
      if (!had) delete g.window;
    }
    expect(table.scrolled).toBe(0);
    expect(caption.focused).toBe(1);
  });
});
