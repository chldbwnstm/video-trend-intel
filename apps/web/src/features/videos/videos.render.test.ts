/**
 * Server-render tests of the 영상 탐색 page and the video detail content (the Drawer itself is a portal and
 * renders nothing on the server, so the drawer body is rendered directly).
 */
import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import type { ComponentType, ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { buildIndex, presetRange } from '@vti/core';
import type { Dataset, Video } from '@vti/core';
import { DatasetContext } from '../../data/context.ts';
import type { DatasetContextValue } from '../../data/context.ts';
import { generateSampleDataset } from '../../../scripts/sample-generator.ts';
import VideosPage from '../../pages/Videos.tsx';
import { EMPTY_FILTERS, searchVideos, summarizeStatuses } from './model.ts';
import { CoverageCallout, NotesCallout, unavailableShare } from './ResultNotes.tsx';
import { VideoDetailContent, VideoNotFound } from './VideoDetail.tsx';
import type { DetailContext } from './VideoDetail.tsx';

function ctxFor(dataset: Dataset): DatasetContextValue {
  return {
    dataset,
    index: buildIndex(dataset),
    now: dataset.generatedAt,
    isSample: true,
    tz: 'Asia/Seoul',
    setTz: () => undefined,
    source: { url: './data/sample.json', bytes: 0, fallbackReason: null, loadedAt: 0 },
    reload: () => undefined,
  };
}

const dataset = generateSampleDataset({ videos: 400 });
const value = ctxFor(dataset);

function renderEl(el: ReactElement, url = '/videos', ctx = value): string {
  return renderToStaticMarkup(h(DatasetContext.Provider, { value: ctx }, h(MemoryRouter, { initialEntries: [url] }, el)));
}

function renderPage(url: string, ctx = value, Page: ComponentType = VideosPage): string {
  return renderEl(h(Routes, null, h(Route, { path: '/videos', element: h(Page) })), url, ctx);
}

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const baseInput = {
  ...EMPTY_FILTERS,
  mode: 'activity' as const,
  range: presetRange('rolling7d', 'Asia/Seoul', value.now),
  rollingHours: 168,
  age: 7 as const,
  tz: 'Asia/Seoul',
  now: value.now,
  sort: 'views_period' as const,
  dir: 'desc' as const,
  page: 1,
  pageSize: 50,
};

describe('VideosPage', () => {
  const html = renderPage('/videos');
  const t = text(html);

  it('renders the header, date semantics, every filter and the export/copy actions', () => {
    expect(html).toContain('<h1');
    expect(t).toContain('영상 탐색');
    for (const label of ['업로드 기간', '조회 발생 기간', '게시 후 경과', '업로드 국가(원천 제공)', '영상 언어', '형식', '주제', '분야', '광고·협찬', '최소 누적 조회']) {
      expect(t).toContain(label);
    }
    expect(t).toContain('최근 168시간(7일)');
    expect(t).toContain('CSV 내보내기');
    expect(t).toContain('링크 복사');
  });

  it('shows the first page of the activity-mode query (rolling 7 days by default) with count and notes', () => {
    const expected = searchVideos(value.index, baseInput);
    expect(t).toContain(`검색 결과 ${expected.result.total.toLocaleString('ko-KR')}개`);
    for (const row of expected.result.rows.slice(0, 5)) expect(html).toContain(esc(row.video.title || '(제목 없음)'));
    expect(t).toContain('조회 발생 기간 기준');
    expect(t).toContain('기간 조회 증가');
    expect(t).toContain('값 상태');
    expect(html).toContain('aria-sort="descending"');
  });

  it('switches columns and default sort with the date mode', () => {
    const age = text(renderPage('/videos?mode=age&age=7'));
    expect(age).toContain('V7 조회');
    expect(age).toContain('게시 후 7일 시점 조회로 비교');
    const upload = text(renderPage('/videos?mode=upload'));
    expect(upload).toContain('업로드 기간 기준 · 누적 조회 높은 순');
  });

  it('falls back to the mode default for an inapplicable sort from a shared link', () => {
    expect(text(renderPage('/videos?mode=upload&sort=views_at_age'))).toContain('누적 조회 높은 순');
  });

  it('pages with ranks continuing from the offset', () => {
    const total = searchVideos(value.index, baseInput).result.total;
    if (total <= 50) return;
    const page2 = renderPage('/videos?page=2');
    expect(text(page2)).toContain('51');
    expect(text(page2)).toContain(`${total.toLocaleString('ko-KR')}개 중 51–`);
  });

  it('offers the in-platform percentile sort when platforms are mixed', () => {
    expect(t).toContain('플랫폼 내 백분위로 정렬');
    expect(text(renderPage('/videos?platforms=youtube'))).not.toContain('플랫폼 내 백분위로 정렬');
  });

  it('explains an empty result and links to coverage', () => {
    const empty = renderPage('/videos?q=zz-no-such-video-zz');
    expect(text(empty)).toContain('조건에 맞는 영상 없음');
    expect(text(empty)).toContain('필터 초기화');
    expect(empty).toContain('href="/coverage"');
  });

  it('shows the account filter chip and keeps filters in the URL-driven UI', () => {
    const acc = dataset.accounts[0];
    const html2 = renderPage(`/videos?accounts=${encodeURIComponent(acc.id)}&sponsored=disclosed&minViews=1000`);
    expect(text(html2)).toContain(acc.name);
    expect(text(html2)).toContain('필터 초기화 (3)');
  });

  it('filters by creator from a creator-page link', () => {
    const creator = dataset.creators[0];
    if (!creator) return;
    const html4 = renderPage(`/videos?creators=${encodeURIComponent(creator.id)}`);
    const expected = searchVideos(value.index, { ...baseInput, creators: [creator.id] });
    expect(text(html4)).toContain(creator.name);
    expect(text(html4)).toContain(`검색 결과 ${expected.result.total.toLocaleString('ko-KR')}개`);
    for (const row of expected.result.rows) expect(value.index.creatorOfAccount.get(row.video.accountId)).toBe(creator.id);
  });

  it('renders on a dataset without any video', () => {
    const emptyDs = { ...dataset, videos: [] };
    const html3 = renderPage('/videos', ctxFor(emptyDs));
    expect(text(html3)).toContain('추적 중인 영상이 아직 없음');
  });
});

describe('VideoDetailContent', () => {
  const ctx: DetailContext = {
    mode: 'activity',
    window: { startMs: value.now - 168 * 3_600_000, endMs: value.now, tz: 'Asia/Seoul', incomplete: false },
    ageDays: 7,
    label: '조회 발생 기간 · 최근 168시간(7일)',
    linkParams: { mode: 'activity', range: 'rolling7d' },
  };
  const rich = [...dataset.videos].sort((a, b) => b.obs.length - a.obs.length)[0];

  it('shows identity, provenance, ratings, observations and classification evidence', () => {
    const html = renderEl(h(VideoDetailContent, { video: rich, context: ctx }));
    const t = text(html);
    for (const s of ['기본 정보', '현재 조건의 지표', '비디오 레이팅', 'V1', 'V30', '누적 조회 추이', '일별 조회 증가', '좋아요·댓글 추이', '원본 관측값', '원천 제공 기간 지표', '분야와 분류 근거', '주제', '협찬 신호', '업로드 국가(원천 제공)', '영상 언어']) {
      expect(t).toContain(s);
    }
    expect(t).toContain('공개 원천에서 직접 읽은 값');
    expect(t).toContain(rich.obs[0].src);
    expect(html).toContain(`href="/creators/${encodeURIComponent(value.index.creatorOfAccount.get(rich.accountId) ?? rich.accountId)}"`);
    if (rich.categories[0]) expect(html).toContain('분류 근거');
  });

  it('explains a single observation instead of drawing an empty chart', () => {
    const lone: Video = { ...rich, id: `${rich.id}-lone`, obs: [rich.obs[rich.obs.length - 1]], publishedAt: rich.obs[rich.obs.length - 1].t - 10 * 86_400_000, sourceWindows: [] };
    const t = text(renderEl(h(VideoDetailContent, { video: lone, context: ctx })));
    expect(t).toContain('관측 1회뿐이라 곡선을 그릴 수 없음');
    expect(t).toContain('기간 집계값을 제공하지 않음');
  });

  it('shows a not-found state with the id', () => {
    expect(text(renderEl(h(VideoNotFound, { id: 'youtube:missing' })))).toContain('youtube:missing');
  });
});

describe('callouts', () => {
  const st = (s: string, n: number) => Array.from({ length: n }, () => ({ status: s as 'exact' }));

  it('explains why V7 cannot be computed yet and offers next steps', () => {
    const t = text(
      renderEl(
        h(CoverageCallout, {
          coverage: 'none',
          mode: 'age',
          age: 7,
          label: 'V7',
          summary: summarizeStatuses(st('unavailable', 10)),
          collectionStart: value.now - 86_400_000,
          rolling: false,
          onUseUpload: () => undefined,
        }),
      ),
    );
    expect(t).toContain('게시 후 7일 시점 조회(V7)를 계산할 수 있는 영상이 아직 없음');
    expect(t).toContain('업로드 기간 기준으로 보기');
    expect(t).toContain('데이터 범위·수집 이력 확인');
  });

  it('summarizes partial coverage with counts', () => {
    const t = text(
      renderEl(
        h(CoverageCallout, {
          coverage: 'partial',
          mode: 'activity',
          age: 7,
          label: '기간 조회 증가',
          summary: summarizeStatuses([...st('exact', 6), ...st('lower_bound', 1), ...st('unavailable', 3)]),
          collectionStart: null,
          rolling: false,
        }),
      ),
    );
    expect(t).toContain('기간 조회 증가 값을 아직 계산할 수 없는 영상 3개 (30%)');
    expect(t).not.toContain('최근 168시간(7일)으로 보기');
    expect(t).toContain('≥ 하한값 1개');
  });

  it('emphasizes a near-total gap with next steps and never rounds it to 100%', () => {
    const summary = summarizeStatuses([...st('exact', 1), ...st('unavailable', 999)]);
    expect(unavailableShare(summary)).toBe('99% 이상');
    const t = text(
      renderEl(
        h(CoverageCallout, { coverage: 'partial', mode: 'activity', age: 7, label: '기간 조회 증가', summary, collectionStart: null, rolling: false, onUseRolling: () => undefined, onUseUpload: () => undefined }),
      ),
    );
    expect(t).toContain('(99% 이상)');
    expect(t).toContain('최근 168시간(7일)으로 보기');
    expect(t).toContain('업로드 기간 기준으로 보기');
  });

  it('renders nothing when coverage is fine', () => {
    expect(renderEl(h(CoverageCallout, { coverage: 'ok', mode: 'activity', age: 7, label: 'x', summary: summarizeStatuses(st('exact', 3)), collectionStart: null, rolling: true }))).toBe('');
  });

  it('shows the first notes and folds the rest', () => {
    const t = text(renderEl(h(NotesCallout, { notes: ['a', 'b', 'c', 'c'] })));
    expect(t).toContain('계산 메모 1건 더 보기');
  });
});
