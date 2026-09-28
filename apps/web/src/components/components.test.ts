/**
 * Server-rendered markup tests for the design-system components (node environment, no DOM needed).
 */
import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { MetricStatus, Video } from '@vti/core';
import { MetricCell } from './MetricCell.tsx';
import { NumberDelta } from './NumberDelta.tsx';
import { PlatformBadge, PlatformPicker } from './PlatformBadge.tsx';
import { VideoThumb, VideoTitleLink, safeHttpUrl } from './Video.tsx';
import { EmptyState, ErrorState, LoadingState } from './states.tsx';
import { DataTable } from './DataTable.tsx';
import { SegmentedControl, Tabs } from './controls.tsx';
import { csvFilename, toCsv } from './ExportCsvButton.tsx';
import { CategoryChip, categoryPathLabel, filterTree, toggleCategory } from './Category.tsx';
import { freshnessLevel, KpiTile } from './layoutParts.tsx';
import { windowLabel } from './SourceNote.tsx';
import { computeTooltipPosition } from './Tooltip.tsx';
import { mergeSeries, BarList } from './charts.tsx';
import { DateModePicker, AgePicker, rangeSpecLabel, DATE_MODE_EXAMPLE } from './DatePickers.tsx';
import { navItemFor, NAV_ITEMS, NAV_SECTIONS } from '../routes.ts';
import { clampPage, MultiSelect, Pager, pageCount, selectionSummary } from './MultiSelect.tsx';
import { countryLabel, FORMAT_LABELS, languageLabel } from '../lib/display.ts';

const render = (el: ReactElement) => renderToStaticMarkup(el);
const inRouter = (el: ReactElement) => render(h(MemoryRouter, null, el));
const text = (html: string) => html.replace(/<[^>]+>/g, '');

describe('MetricCell', () => {
  const cases: [MetricStatus, string][] = [
    ['interpolated', '≈'],
    ['lower_bound', '≥'],
    ['source_reported', '원천'],
    ['decrease_flagged', '⚠'],
  ];
  it.each(cases)('renders the %s marker', (status, marker) => {
    const html = render(h(MetricCell, { metric: { value: 12345, status, asOf: 0, note: null }, label: '기간 조회 증가' }));
    expect(html).toContain(marker);
    expect(html).toContain('1.2만');
  });
  it('shows exact values without a marker and with screen-reader text', () => {
    const html = render(h(MetricCell, { metric: { value: 12345, status: 'exact', asOf: 0, note: null }, label: '누적 조회' }));
    expect(html).not.toContain('≈');
    expect(html).toContain('sr-only');
    expect(text(html)).toContain('누적 조회 12,345회 (관측값)');
    expect(html).toContain('tabindex="0"');
  });
  it('never shows a number for unavailable values', () => {
    const html = render(h(MetricCell, { metric: { value: 0, status: 'unavailable', asOf: null, note: 'gap_too_wide' }, label: '기간 조회 증가' }));
    expect(text(html)).toContain('—');
    expect(text(html)).not.toMatch(/\b0\b/);
    expect(text(html)).toContain('계산 불가');
  });
  it('treats a missing metric as unavailable', () => {
    expect(text(render(h(MetricCell, { metric: null })))).toContain('—');
  });
  it('formats rates and per-hour kinds', () => {
    expect(text(render(h(MetricCell, { metric: { value: 0.0345, status: 'exact' }, kind: 'rate' })))).toContain('3.5%');
    expect(text(render(h(MetricCell, { metric: { value: 1500, status: 'interpolated' }, kind: 'perHour' })))).toContain('1,500/시간');
  });
});

describe('NumberDelta', () => {
  it('encodes direction with sign, arrow and screen-reader text', () => {
    const up = render(h(NumberDelta, { value: 0.34 }));
    expect(text(up)).toContain('+34%');
    expect(up).toContain('text-positive');
    expect(text(up)).toContain('증가');
    const down = render(h(NumberDelta, { value: -0.5 }));
    expect(text(down)).toContain('-50%');
    expect(down).toContain('text-negative');
    const inverted = render(h(NumberDelta, { value: -0.5, invert: true }));
    expect(inverted).toContain('text-positive');
  });
  it('renders a dash for null, unavailable and decreased metrics', () => {
    expect(text(render(h(NumberDelta, { value: null })))).toContain('—');
    expect(text(render(h(NumberDelta, { metric: { value: 0.2, status: 'unavailable' } })))).toContain('계산 불가');
    expect(text(render(h(NumberDelta, { metric: { value: -0.2, status: 'decrease_flagged' } })))).toContain('—');
    expect(text(render(h(NumberDelta, { metric: { value: 0.2, status: 'lower_bound' } })))).toContain('+20%');
  });
  it('shows flat values neutrally', () => {
    const flat = render(h(NumberDelta, { value: 0 }));
    expect(text(flat)).toContain('0%');
    expect(flat).toContain('text-fg-3');
  });
});

describe('PlatformBadge / PlatformPicker', () => {
  it('always carries the text label', () => {
    expect(text(render(h(PlatformBadge, { platform: 'youtube' })))).toContain('YouTube');
    const iconOnly = render(h(PlatformBadge, { platform: 'niconico', iconOnly: true }));
    expect(iconOnly).toContain('sr-only');
    expect(text(iconOnly)).toContain('niconico');
    expect(iconOnly).toContain('var(--platform-niconico)');
  });
  it('marks the selection with aria-pressed and treats [] as all', () => {
    const html = render(h(PlatformPicker, { options: ['youtube', 'tiktok'], value: [], onChange: () => undefined, counts: { youtube: 1200 } }));
    expect(html).toMatch(/aria-pressed="true"[^>]*>전체/);
    expect(text(html)).toContain('1,200');
  });
});

const video: Pick<Video, 'url' | 'title' | 'status' | 'thumbnail' | 'platform' | 'durationSec' | 'format'> = {
  url: 'https://example.com/v/1',
  title: '<script>alert(1)</script> 추석 음식',
  status: 'active',
  thumbnail: 'https://i.example.com/t.jpg',
  platform: 'youtube',
  durationSec: 125,
  format: 'short',
};

describe('VideoTitleLink / VideoThumb', () => {
  it('opens the source in a new tab without opener or referrer', () => {
    const html = render(h(VideoTitleLink, { video }));
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('href="https://example.com/v/1"');
  });
  it('renders data text as text (escaped)', () => {
    const html = render(h(VideoTitleLink, { video }));
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
  it('does not link non-http URLs', () => {
    const html = render(h(VideoTitleLink, { video: { ...video, url: 'javascript:alert(1)' } }));
    expect(html).not.toContain('href=');
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpUrl('ftp://x')).toBeNull();
    expect(safeHttpUrl('not a url')).toBeNull();
    expect(safeHttpUrl('http://a.b/c')).toBe('http://a.b/c');
  });
  it('shows deleted / private state', () => {
    expect(text(render(h(VideoTitleLink, { video: { ...video, status: 'deleted' } })))).toContain('삭제됨');
    expect(text(render(h(VideoTitleLink, { video: { ...video, status: 'private' } })))).toContain('비공개');
  });
  it('lazy-loads thumbnails without a referrer and overlays duration/format', () => {
    const html = render(h(VideoThumb, { video, size: 'md' }));
    expect(html).toContain('loading="lazy"');
    expect(html).toMatch(/referrer[pP]olicy="no-referrer"/);
    expect(html).toContain('alt=""');
    expect(text(html)).toContain('2:05');
    expect(text(html)).toContain('쇼츠');
  });
  it('falls back to a platform tile without a usable thumbnail', () => {
    const html = render(h(VideoThumb, { video: { ...video, thumbnail: 'data:image/png;base64,xx' } }));
    expect(html).not.toContain('<img');
    expect(text(html)).toContain('YT');
  });
});

describe('states', () => {
  it('renders empty / error / loading states', () => {
    expect(text(render(h(EmptyState, { title: '결과 없음', description: '필터를 바꿔 보기' })))).toContain('결과 없음');
    const err = render(h(ErrorState, { title: '실패', error: new Error('boom') }));
    expect(err).toContain('role="alert"');
    expect(text(err)).toContain('boom');
    expect(render(h(LoadingState, { rows: 3 }))).toContain('role="status"');
  });
});

describe('DataTable', () => {
  const rows = [
    { id: 'a', n: 1 },
    { id: 'b', n: 2 },
  ];
  it('renders a sticky header, caption and aria-sort on the active column', () => {
    const html = render(
      h(DataTable<{ id: string; n: number }>, {
        columns: [
          { id: 'id', header: 'ID', cell: (r) => r.id },
          { id: 'n', header: '값', cell: (r) => String(r.n), sortKey: 'n', align: 'right' },
          { id: 'm', header: '기타', cell: () => '-', sortKey: 'm' },
        ],
        rows,
        rowKey: (r) => r.id,
        caption: '테스트 표',
        sort: { key: 'n', dir: 'desc' },
        onSortChange: () => undefined,
      }),
    );
    expect(html).toContain('<caption class="sr-only">테스트 표</caption>');
    expect(html).toContain('sticky top-0');
    expect(html).toContain('aria-sort="descending"');
    expect(html).toContain('aria-sort="none"');
    expect(html.match(/<tr/g)?.length).toBe(3);
  });
  it('shows the empty state', () => {
    const html = render(h(DataTable<{ id: string }>, { columns: [{ id: 'id', header: 'ID', cell: (r) => r.id }], rows: [], rowKey: (r) => r.id, caption: 'x' }));
    expect(text(html)).toContain('결과 없음');
  });
});

describe('controls', () => {
  it('SegmentedControl is a radio group with one tabbable option', () => {
    const html = render(
      h(SegmentedControl<string>, {
        label: '보기',
        value: 'b',
        onChange: () => undefined,
        options: [
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
        ],
      }),
    );
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-label="보기"');
    expect(html.match(/aria-checked="true"/g)?.length).toBe(1);
    expect(html.match(/tabindex="0"/g)?.length).toBe(1);
  });
  it('Tabs link tabs and panels', () => {
    const html = render(h(Tabs<string>, { tabs: [{ id: 'x', label: 'X', count: 1200 }, { id: 'y', label: 'Y' }], value: 'x', onChange: () => undefined, label: '탭', idBase: 't' }));
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-controls="t-panel-x"');
    expect(html).toContain('aria-selected="true"');
    expect(text(html)).toContain('1,200');
  });
  it('DateModePicker explains the active mode and includes the A/B example', () => {
    const html = render(h(DateModePicker, { value: 'activity', onChange: () => undefined }));
    expect(text(html)).toContain('조회 발생 기간');
    expect(text(html)).toContain('게시일과 관계없이');
    expect(text(html)).toContain(DATE_MODE_EXAMPLE);
    expect(text(html)).toContain('업로드 기간');
    expect(text(html)).toContain('게시 후 경과');
  });
  it('AgePicker offers 1/2/3/7/30일', () => {
    const t = text(render(h(AgePicker, { value: 7, onChange: () => undefined })));
    for (const d of ['1일', '2일', '3일', '7일', '30일']) expect(t).toContain(d);
  });
  it('rangeSpecLabel', () => {
    expect(rangeSpecLabel('last7d')).toBe('최근 7일');
    expect(rangeSpecLabel('2026-09-01..2026-09-07')).toBe('2026-09-01 ~ 2026-09-07');
    expect(rangeSpecLabel('junk')).toBe('junk');
  });
});

describe('CSV helpers', () => {
  it('escapes, keeps nulls empty, adds BOM and guards formulas', () => {
    const csv = toCsv([
      ['제목', '조회', '비고'],
      ['a, "b"', 1200, null],
      ['=HYPERLINK("x")', -5, '+1'],
    ]);
    expect(csv.startsWith('﻿')).toBe(true);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0]).toBe('제목,조회,비고');
    expect(lines[1]).toBe('"a, ""b""",1200,');
    expect(lines[2]).toBe(`"'=HYPERLINK(""x"")",-5,'+1`);
  });
  it('builds safe file names in the display tz', () => {
    expect(csvFilename('videos', Date.UTC(2026, 8, 28, 3, 5), 'Asia/Seoul')).toBe('videos_2026-09-28_1205.csv');
    expect(csvFilename('a/b c', Date.UTC(2026, 8, 28, 3, 5), 'UTC')).toBe('a_b_c_2026-09-28_0305.csv');
  });
});

describe('categories', () => {
  it('toggleCategory removes descendants when an ancestor is selected', () => {
    expect(toggleCategory(['beauty/skincare', 'food'], 'beauty')).toEqual(['food', 'beauty']);
    expect(toggleCategory(['beauty', 'food'], 'beauty')).toEqual(['food']);
    expect(toggleCategory([], 'gaming')).toEqual(['gaming']);
  });
  it('filterTree keeps ancestors of matches', () => {
    const tree = [
      { id: 'beauty', label: '뷰티', labelEn: 'Beauty', keywords: [], children: [{ id: 'beauty/skincare', label: '스킨케어', labelEn: 'Skincare', keywords: ['선크림'], children: [] }] },
      { id: 'food', label: '음식', labelEn: 'Food', keywords: [], children: [] },
    ];
    expect(filterTree(tree, '선크림').map((n) => n.id)).toEqual(['beauty']);
    expect(filterTree(tree, '선크림')[0].children.map((n) => n.id)).toEqual(['beauty/skincare']);
    expect(filterTree(tree, 'food').map((n) => n.id)).toEqual(['food']);
    expect(filterTree(tree, '')).toBe(tree);
    expect(filterTree(tree, 'zzz')).toEqual([]);
  });
  it('CategoryChip renders a label (falls back to the id) and a remove button', () => {
    const html = inRouter(h(CategoryChip, { id: 'beauty', onRemove: () => undefined, to: '/videos?cats=beauty' }));
    expect(html).toContain('href="/videos?cats=beauty"');
    expect(html).toContain('제거');
    expect(categoryPathLabel('beauty/skincare')).toContain('›');
  });
});

describe('layout helpers', () => {
  it('freshnessLevel thresholds', () => {
    const now = 100 * 3_600_000;
    expect(freshnessLevel(now - 2 * 3_600_000, now)).toBe('fresh');
    expect(freshnessLevel(now - 20 * 3_600_000, now)).toBe('delayed');
    expect(freshnessLevel(now - 40 * 3_600_000, now)).toBe('stale');
    expect(freshnessLevel(now, now, true)).toBe('sample');
  });
  it('KpiTile renders label, value and link', () => {
    const html = inRouter(h(KpiTile, { label: '추적 영상', value: '2,475', to: '/videos', sub: '활성' }));
    expect(text(html)).toContain('추적 영상');
    expect(text(html)).toContain('2,475');
    expect(html).toContain('href="/videos"');
  });
  it('windowLabel shows inclusive local dates of a half-open window', () => {
    // [2026-09-21T15:00Z, 2026-09-28T15:00Z) = 2026-09-22..2026-09-28 in Seoul
    expect(windowLabel({ startMs: Date.UTC(2026, 8, 21, 15), endMs: Date.UTC(2026, 8, 28, 15) }, 'Asia/Seoul')).toBe('2026-09-22 ~ 2026-09-28');
    expect(windowLabel({ startMs: Date.UTC(2026, 8, 27, 15), endMs: Date.UTC(2026, 8, 28, 15) }, 'Asia/Seoul')).toBe('2026-09-28');
  });
  it('computeTooltipPosition flips below when there is no room above and clamps horizontally', () => {
    const vp = { width: 375, height: 800 };
    const above = computeTooltipPosition({ top: 400, bottom: 420, left: 100, width: 40 }, { width: 200, height: 80 }, vp, 'top');
    expect(above.side).toBe('top');
    expect(above.top).toBe(400 - 80 - 6);
    const flipped = computeTooltipPosition({ top: 20, bottom: 40, left: 100, width: 40 }, { width: 200, height: 80 }, vp, 'top');
    expect(flipped.side).toBe('bottom');
    expect(flipped.top).toBe(46);
    const clamped = computeTooltipPosition({ top: 400, bottom: 420, left: 360, width: 10 }, { width: 200, height: 80 }, vp, 'top');
    expect(clamped.left).toBe(375 - 200 - 8);
    const left = computeTooltipPosition({ top: 400, bottom: 420, left: 0, width: 10 }, { width: 200, height: 80 }, vp, 'top');
    expect(left.left).toBe(8);
  });
});

describe('charts', () => {
  it('mergeSeries unions x values, sorts and keeps statuses', () => {
    const rows = mergeSeries([
      { id: 'a', label: 'A', points: [{ x: 2, value: 20 }, { x: 1, value: 10, status: 'interpolated' }] },
      { id: 'b', label: 'B', points: [{ x: 3, value: null }] },
    ]);
    expect(rows.map((r) => r.x)).toEqual([1, 2, 3]);
    expect(rows[0]).toEqual({ x: 1, a: 10, a__status: 'interpolated' });
    expect(rows[2]).toEqual({ x: 3, b: null });
    const dates = mergeSeries([{ id: 'a', label: 'A', points: [{ x: '2026-09-02', value: 1 }, { x: '2026-09-01', value: 2 }] }]);
    expect(dates.map((r) => r.x)).toEqual(['2026-09-01', '2026-09-02']);
  });
  it('BarList shows every value as text with shares', () => {
    const html = inRouter(
      h(BarList, {
        label: '분포',
        showShare: true,
        items: [
          { key: 'a', label: '뷰티', value: 30, to: '/videos?cats=beauty' },
          { key: 'b', label: '음식', value: 10 },
        ],
      }),
    );
    expect(text(html)).toContain('뷰티');
    expect(text(html)).toContain('75.0%');
    expect(text(html)).toContain('25.0%');
    expect(html).toContain('width:100%');
    expect(html).toContain('width:33.33');
  });
});

describe('MultiSelect / Pager', () => {
  const options = [
    { value: 'ko', label: '한국어', count: 1958 },
    { value: 'ja', label: '일본어' },
  ];
  it('summarizes selections', () => {
    expect(selectionSummary([], options)).toBe('전체');
    expect(selectionSummary(['ko'], options)).toBe('한국어');
    expect(selectionSummary(['ja', 'ko'], options)).toBe('일본어 외 1');
    expect(selectionSummary(['xx'], options)).toBe('xx');
  });
  it('renders a trigger with the label and summary', () => {
    const html = render(h(MultiSelect, { label: '영상 언어', options, value: ['ko'], onChange: () => undefined }));
    expect(text(html)).toContain('영상 언어');
    expect(text(html)).toContain('한국어');
    expect(html).toContain('aria-expanded="false"');
  });
  it('pages are clamped and counted', () => {
    expect(pageCount(0, 50)).toBe(1);
    expect(pageCount(101, 50)).toBe(3);
    expect(clampPage(9, 101, 50)).toBe(3);
    expect(clampPage(0, 101, 50)).toBe(1);
    expect(clampPage(Number.NaN, 101, 50)).toBe(1);
    const html = render(h(Pager, { page: 2, pageSize: 50, total: 101, onChange: () => undefined }));
    expect(text(html)).toContain('101개 중 51–100');
    expect(text(html)).toContain('2 / 3');
    const last = render(h(Pager, { page: 3, pageSize: 50, total: 101, onChange: () => undefined }));
    expect(last).toMatch(/disabled=""[^>]*aria-label="다음 페이지"/);
  });
  it('language / country / format labels', () => {
    expect(languageLabel('ko')).toBe('한국어');
    expect(languageLabel(null)).toBe('언어 미상');
    expect(countryLabel('KR')).toBe('대한민국');
    expect(countryLabel(null)).toBe('국가 미제공');
    expect(FORMAT_LABELS.short).toBe('쇼츠·숏폼');
  });
});

describe('routes', () => {
  it('has every SPEC route with a Korean label', () => {
    const paths = NAV_ITEMS.map((i) => i.path);
    expect(paths).toEqual(['/', '/videos', '/trends', '/ratings', '/explore', '/creators', '/compare', '/brands', '/taxonomy', '/coverage', '/api-docs']);
    expect(NAV_SECTIONS.flatMap((s) => s.items)).toHaveLength(11);
    expect(NAV_ITEMS.map((i) => i.label)).toEqual(['대시보드', '영상 탐색', '트렌드', '비디오 레이팅', '기회 탐색', '크리에이터', '크리에이터 비교', '브랜드 협업', '분류 체계', '데이터 범위', 'API']);
  });
  it('navItemFor matches nested paths and the exact dashboard', () => {
    expect(navItemFor('/')?.label).toBe('대시보드');
    expect(navItemFor('/creators/youtube:abc')?.label).toBe('크리에이터');
    expect(navItemFor('/compare')?.label).toBe('크리에이터 비교');
    expect(navItemFor('/nope')).toBeNull();
  });
});
