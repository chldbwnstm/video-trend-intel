/**
 * Server-render tests for /creators, /creators/:key and /compare against the synthetic sample and a small
 * "early collection" fixture (one observation per video, followers from one platform only) that mirrors the
 * shape of the first real collection: pages must explain partial data instead of breaking.
 */
import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import type { ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { buildIndex } from '@vti/core';
import type { Dataset } from '@vti/core';
import { DatasetContext } from '../../data/context.ts';
import type { DatasetContextValue } from '../../data/context.ts';
import { generateSampleDataset } from '../../../scripts/sample-generator.ts';
import { makeAccount, makeDataset, makeObs, makeVideo, ts } from '../../../../../packages/core/test/fixtures.ts';
import CreatorsPage from '../../pages/Creators.tsx';
import CreatorDetailPage from '../../pages/CreatorDetail.tsx';
import ComparePage from '../../pages/Compare.tsx';

function ctx(dataset: Dataset, isSample: boolean): DatasetContextValue {
  return {
    dataset,
    index: buildIndex(dataset),
    now: dataset.generatedAt,
    isSample,
    tz: 'Asia/Seoul',
    setTz: () => undefined,
    source: { url: './data/sample.json', bytes: 0, fallbackReason: null, loadedAt: 0 },
    reload: () => undefined,
  };
}

function render(value: DatasetContextValue, url: string, path: string, Page: ComponentType): string {
  return renderToStaticMarkup(
    h(DatasetContext.Provider, { value }, h(MemoryRouter, { initialEntries: [url] }, h(Routes, null, h(Route, { path, element: h(Page) })))),
  );
}

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

const sample = generateSampleDataset({ videos: 400 });
const S = ctx(sample, true);
const creators = sample.creators;

/* Early-collection fixture: one observation per video at `now`, followers only on Dailymotion. */
const now = ts('2026-09-28T15:00');
const ytA = makeAccount({ id: 'youtube:UCa', name: '채널 에이', handle: '@a', creatorId: 'maker' });
const dmA = makeAccount({ id: 'dailymotion:xa', name: 'Channel A', creatorId: 'maker', followers: [{ t: now - 3600_000, value: 1234, src: 'dailymotion@1' }] });
const ytB = makeAccount({ id: 'youtube:UCb', name: '채널 비' });
const early = makeDataset({
  generatedAt: now,
  accounts: [ytA, dmA, ytB],
  creators: [{ id: 'maker', name: '메이커', accountIds: [ytA.id, dmA.id], linkStatus: 'verified', note: null }],
  videos: [
    makeVideo({ id: 'youtube:v1', accountId: ytA.id, title: '첫 영상 <b>', publishedAt: ts('2026-09-20T09:00'), obs: [makeObs(now - 600_000, 5000, 100, null, null, 'youtube-rss@1')] }),
    makeVideo({ id: 'youtube:v2', accountId: ytA.id, publishedAt: ts('2026-09-27T09:00'), obs: [makeObs(now - 600_000, 900, 10, null, null, 'youtube-rss@1')] }),
    makeVideo({
      id: 'dailymotion:v3',
      accountId: dmA.id,
      publishedAt: ts('2026-09-10T09:00'),
      obs: [makeObs(now - 600_000, 20000, 30, null, null, 'dailymotion@1')],
      sourceWindows: [{ metric: 'views', windowHours: 168, value: 700, observedAt: now - 600_000, src: 'dailymotion@1' }],
    }),
    makeVideo({ id: 'youtube:v4', accountId: ytB.id, publishedAt: ts('2026-09-26T09:00'), obs: [makeObs(now - 600_000, 300, 3, null, null, 'youtube-rss@1')] }),
  ],
});
const E = ctx(early, false);

describe('/creators', () => {
  it('lists portfolios with platform badges, link status and multi-platform highlight', () => {
    const html = render(S, '/creators', '/creators', CreatorsPage);
    const t = text(html);
    expect(t).toContain('크리에이터');
    expect(t).toContain('Creator Intelligence');
    expect(t).toContain('최근 168시간(7일)');
    expect(t).toContain(creators[0].name);
    expect(t).toContain('여러 플랫폼');
    expect(t).toContain('검증됨');
    expect(t).toContain('기간 조회 증가 값 상태');
    expect(html).toContain(`href="/creators/${creators[0].id}?range=rolling7d"`);
  });

  it('filters to multi-platform portfolios, keeps compare selection in the URL and caps it at 4', () => {
    const keys = creators.slice(0, 5).map((c) => c.id);
    const html = render(S, `/creators?multi=1&keys=${keys.join(',')}`, '/creators', CreatorsPage);
    const t = text(html);
    expect(t).toContain('비교 4/4');
    expect(t).toContain('4명 비교하기');
    expect(html).toContain(`href="/compare?keys=${keys.slice(0, 4).join(',')}&amp;range=rolling7d"`);
    // Unchecked rows are disabled once 4 are selected.
    expect(html).toMatch(/disabled=""[^>]*aria-label="[^"]+ 비교에 추가"/);
  });

  it('shows the cross-platform caveat unless one platform is selected', () => {
    expect(text(render(S, '/creators', '/creators', CreatorsPage))).toContain('여러 플랫폼이 섞인 순위임');
    expect(text(render(S, '/creators?platforms=youtube', '/creators', CreatorsPage))).not.toContain('여러 플랫폼이 섞인 순위임');
  });

  it('renders an empty state for a search without matches', () => {
    expect(text(render(S, '/creators?q=zzzz-no-such-creator', '/creators', CreatorsPage))).toContain('조건에 맞는 크리에이터 없음');
  });

  it('does not rank a window before the first observation by view increase', () => {
    // lastMonth (2026-08) ends before the fixture's first observation (2026-09-28): increases are unknown.
    const html = render(E, '/creators?range=lastMonth', '/creators', CreatorsPage);
    const t = text(html);
    expect(t).toContain('선택한 기간은 첫 관측 이전임');
    expect(t).toContain('2026-08-01 ~ 2026-08-31');
    expect(t).toContain('기간 업로드(게시일 기준이라 알 수 있음) 순으로 정렬함');
    expect(t).toContain('크리에이터 목록 (기간 업로드 순)');
    expect(t).toContain('최근 7일(롤링)로 보기');
    // A recent window keeps the view-increase ranking and shows no callout.
    const recent = text(render(E, '/creators?range=rolling7d', '/creators', CreatorsPage));
    expect(recent).not.toContain('선택한 기간은 첫 관측 이전임');
    expect(recent).toContain('크리에이터 목록 (기간 조회 증가 순)');
  });

  it('keeps an explicit follower sort before the first observation', () => {
    const t = text(render(E, '/creators?range=lastMonth&sort=followers', '/creators', CreatorsPage));
    expect(t).toContain('선택한 기간은 첫 관측 이전임');
    expect(t).toContain('크리에이터 목록 (팔로워 순)');
  });

  it('explains missing followers and partial values on early data', () => {
    const html = render(E, '/creators?sort=followers', '/creators', CreatorsPage);
    const t = text(html);
    expect(t).toContain('메이커');
    expect(t).toContain('채널 비');
    expect(t).toContain('검증됨');
    // followers: YouTube-only account has none -> dash, never 0
    expect(t).toContain('계산 불가');
    expect(t).toContain('팔로워 제공 1개');
  });
});

describe('/creators/:key', () => {
  it('renders the sections of a linked creator', () => {
    const c = creators[1];
    const html = render(S, `/creators/${c.id}`, '/creators/:key', CreatorDetailPage);
    const t = text(html);
    expect(t).toContain(c.name);
    for (const title of ['플랫폼별 계정', '팔로워 추이', '일별 조회 증가 (플랫폼별)', '상위 영상', '게시 시간 히트맵', '분야 구성', '업로드 주기', '협찬 영상', '플랫폼별 성과']) {
      expect(t, title).toContain(title);
    }
    expect(t).toContain('최근 720시간(30일)');
    expect(html).toContain(`href="/compare?keys=${c.id}&amp;range=rolling30d"`);
    expect(t).not.toContain('계산하지 못함');
  });

  it('renders a single account portfolio', () => {
    const solo = sample.accounts.find((a) => !a.creatorId)!;
    const t = text(render(S, `/creators/${solo.id}?range=rolling7d`, '/creators/:key', CreatorDetailPage));
    expect(t).toContain(solo.name);
    expect(t).toContain('단일 계정');
    expect(t).not.toContain('플랫폼별 성과');
    expect(t).not.toContain('계산하지 못함');
  });

  it('links categories, top videos and sponsored videos to this creator in the video search', () => {
    const c = creators[1];
    const html = render(S, `/creators/${c.id}?range=rolling7d`, '/creators/:key', CreatorDetailPage);
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
    const videos = hrefs.filter((h) => h.startsWith('/videos')).map((h) => new URL(h, 'http://x').searchParams);
    // 분야 구성: the creator's videos in that category, same period (not all creators).
    const cats = videos.filter((q) => q.get('cats'));
    expect(cats.length).toBeGreaterThan(0);
    for (const q of cats) {
      expect(q.get('creators')).toBe(c.id);
      expect(q.get('range')).toBe('rolling7d');
    }
    // 상위 영상: the full list and each video's detail drawer.
    expect(videos.some((q) => q.get('creators') === c.id && q.get('mode') === 'activity' && !q.get('v') && !q.get('cats'))).toBe(true);
    const drawers = videos.filter((q) => q.get('v'));
    expect(drawers.length).toBeGreaterThan(0);
    for (const q of drawers) expect(q.get('creators')).toBe(c.id);
    expect(text(html)).toContain('영상 탐색에서 보기');
    expect(text(html)).toContain('성장 곡선·관측 기록');
  });

  it('scopes a single account detail to its account id', () => {
    const solo = sample.accounts.find((a) => !a.creatorId && sample.videos.some((v) => v.accountId === a.id))!;
    const html = render(S, `/creators/${solo.id}`, '/creators/:key', CreatorDetailPage);
    const hrefs = [...html.matchAll(/href="(\/videos[^"]*)"/g)].map((m) => new URL(m[1].replace(/&amp;/g, '&'), 'http://x').searchParams);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const q of hrefs) {
      expect(q.get('accounts')).toBe(solo.id);
      expect(q.get('creators')).toBeNull();
    }
  });

  it('explains a window before the first observation and shows uploads in it', () => {
    const t = text(render(E, '/creators/maker?range=lastMonth', '/creators/:key', CreatorDetailPage));
    expect(t).toContain('선택한 기간은 첫 관측 이전임');
    expect(t).toContain('최근 30일(롤링)로 보기');
    // Top videos default to the upload-date view (period increases are unknown).
    expect(t).toContain('업로드 기간 기준: 기간 안에 게시된 영상');
    expect(t).not.toContain('계산하지 못함');
    expect(text(render(E, '/creators/maker?range=rolling7d', '/creators/:key', CreatorDetailPage))).not.toContain('선택한 기간은 첫 관측 이전임');
  });

  it('shows a not-found state with the requested key', () => {
    const t = text(render(S, '/creators/youtube:abc', '/creators/:key', CreatorDetailPage));
    expect(t).toContain('크리에이터를 찾을 수 없음');
    expect(t).toContain('youtube:abc');
  });

  it('explains single follower observations and early data instead of breaking', () => {
    const html = render(E, '/creators/maker', '/creators/:key', CreatorDetailPage);
    const t = text(html);
    expect(t).toContain('메이커');
    expect(t).toContain('검증됨');
    expect(t).toContain('관측이 1회뿐이라 추이를 그릴 수 없음');
    expect(t).toContain('YouTube는 채널 RSS의 최근 15개 영상만');
    expect(t).toContain('Dailymotion의 원천 제공 기간값');
    // Titles are rendered as text (escaped), never as HTML.
    expect(html).toContain('첫 영상 &lt;b&gt;');
    expect(t).not.toContain('계산하지 못함');
  });
});

describe('/compare', () => {
  it('offers suggestions when nothing is selected', () => {
    const t = text(render(S, '/compare', '/compare', ComparePage));
    expect(t).toContain('크리에이터 비교');
    expect(t).toContain('비교할 크리에이터 선택');
    expect(t).toContain(creators[0].name);
  });

  it('compares selected creators with leaders, overlaid timeline and per-platform breakdown', () => {
    const keys = creators.slice(0, 3).map((c) => c.id);
    const t = text(render(S, `/compare?keys=${keys.join(',')}`, '/compare', ComparePage));
    for (const c of creators.slice(0, 3)) expect(t).toContain(c.name);
    expect(t).toContain('핵심 지표 비교');
    expect(t).toContain('일별 조회 증가 비교');
    expect(t).toContain('플랫폼별 비교');
    expect(t).toMatch(/최고/);
    expect(t).toContain('여러 플랫폼 수치가 섞인 비교임');
    expect(t).not.toContain('계산하지 못함');
  });

  it('keeps unknown keys visible and removable', () => {
    const t = text(render(S, `/compare?keys=${creators[0].id},ghost:key`, '/compare', ComparePage));
    expect(t).toContain('찾을 수 없는 키 1개');
    expect(t).toContain('ghost:key');
  });

  it('restricting to one platform removes the cross-platform caveat', () => {
    const keys = creators.slice(0, 2).map((c) => c.id);
    const t = text(render(S, `/compare?keys=${keys.join(',')}&platforms=youtube`, '/compare', ComparePage));
    expect(t).not.toContain('여러 플랫폼 수치가 섞인 비교임');
    expect(t).toContain('YouTube 계정·영상만 비교');
  });

  it('numbers compare slots and keeps their colors apart from the platform colors', () => {
    const keys = creators.slice(0, 3).map((c) => c.id);
    const html = render(S, `/compare?keys=${keys.join(',')}`, '/compare', ComparePage);
    // Sample platforms use --series-1..4 (YouTube, Dailymotion, PeerTube, niconico); slots take other series.
    const slotColors = [...html.matchAll(/border-color:(var\(--series-\d\))/g)].map((m) => m[1]);
    expect(slotColors.length).toBeGreaterThanOrEqual(3);
    for (const c of slotColors) expect(['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)']).not.toContain(c);
  });

  it('does not crown leaders of unknown increases before the first observation', () => {
    const html = render(E, '/compare?keys=maker,youtube:UCb&range=lastMonth', '/compare', ComparePage);
    const t = text(html);
    expect(t).toContain('선택한 기간은 첫 관측 이전임');
    // Only the follower row (known now, independent of the window) can still have a leader badge.
    const badges = [...html.matchAll(/>최고(\(잠정\))?<\/span>/g)];
    expect(badges.length).toBeLessThanOrEqual(1);
    expect(t).not.toContain('계산하지 못함');
    // The same pair over a recent window does get a view-increase leader.
    expect([...render(E, '/compare?keys=maker,youtube:UCb&range=rolling30d', '/compare', ComparePage).matchAll(/>최고(\(잠정\))?<\/span>/g)].length).toBeGreaterThan(1);
  });

  it('marks provisional leaders on early data', () => {
    const t = text(render(E, '/compare?keys=maker,youtube:UCb', '/compare', ComparePage));
    expect(t).toContain('메이커');
    expect(t).toContain('채널 비');
    expect(t).toMatch(/최고/);
  });
});
