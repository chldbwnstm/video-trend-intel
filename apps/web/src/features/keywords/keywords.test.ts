/**
 * 키워드 분석: pure page logic + server-render tests of the page (sample dataset and a tiny "early collection"
 * fixture with one observation per video) so partial data is explained instead of breaking the page.
 */
import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { analyzeKeywords, buildIndex, keywordSuggestions, presetRange } from '@vti/core';
import type { Dataset } from '@vti/core';
import { DatasetContext } from '../../data/context.ts';
import type { DatasetContextValue } from '../../data/context.ts';
import { generateSampleDataset } from '../../../scripts/sample-generator.ts';
import { makeAccount, makeDataset, makeObs, makeVideo, ts } from '../../../../../packages/core/test/fixtures.ts';
import KeywordsPage from '../../pages/Keywords.tsx';
import {
  brandHref,
  dailySeries,
  fieldsCodec,
  filterSuggestions,
  keywordColor,
  keywordCoverage,
  keywordListCodec,
  keywordsHref,
  matchCodec,
  mergeKeywords,
  partialShare,
  shareText,
  statusSummary,
  videosSearchHref,
} from './model.ts';

function ctx(dataset: Dataset, isSample = true): DatasetContextValue {
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

function render(value: DatasetContextValue, url: string): string {
  return renderToStaticMarkup(
    h(DatasetContext.Provider, { value }, h(MemoryRouter, { initialEntries: [url] }, h(Routes, null, h(Route, { path: '/keywords', element: h(KeywordsPage) })))),
  );
}

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const decode = (s: string) => s.replace(/&amp;/g, '&');

const sample = generateSampleDataset({ videos: 400 });
const S = ctx(sample);

describe('keyword page model', () => {
  it('URL codecs: comma list (normalized-unique, max 5), match, fields', () => {
    expect(keywordListCodec.parse('먹방, #먹방,브이로그,,a,b,c,d')).toEqual(['먹방', '브이로그', 'a', 'b', 'c']);
    expect(keywordListCodec.parse('# #,먹방')).toEqual(['먹방']); // nothing searchable in '# #'
    expect(keywordListCodec.serialize(['먹방', 'ai'])).toBe('먹방,ai');
    expect(keywordListCodec.serialize([])).toBeNull();
    expect(matchCodec.parse('any')).toBe('any');
    expect(matchCodec.parse('some')).toBeUndefined();
    expect(fieldsCodec.parse('title,tags')).toEqual(['title', 'tags']);
  });

  it('mergeKeywords splits on commas, de-duplicates and caps at 5', () => {
    expect(mergeKeywords(['먹방'], '브이로그, 먹방 ,ai')).toEqual({ next: ['먹방', '브이로그', 'ai'], overflow: 0, added: 2 });
    const full = mergeKeywords(['a', 'b', 'c', 'd'], ['e', 'f']);
    expect(full.next).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(full.overflow).toBe(1);
    expect(mergeKeywords(['먹방'], ['#먹방']).added).toBe(0);
    expect(mergeKeywords([], '###, # #').next).toEqual([]);
  });

  it('links carry the same period and filters', () => {
    const scope = { range: 'rolling30d', platforms: ['youtube' as const], langs: ['ko'], cats: [] };
    expect(decode(videosSearchHref('먹방', scope))).toBe('/videos?mode=activity&sort=views_period&q=%EB%A8%B9%EB%B0%A9&range=rolling30d&platforms=youtube&langs=ko');
    expect(brandHref('브랜드A', 'last7d')).toBe('/brands?brand=%EB%B8%8C%EB%9E%9C%EB%93%9CA&range=last7d');
    expect(keywordsHref(['a', 'b'], { range: 'rolling7d' })).toBe('/keywords?kw=a,b&range=rolling7d');
    expect(keywordColor(0)).toBe('var(--series-5)');
    expect(keywordColor(4)).toBe('var(--series-1)');
  });

  it('filters suggestions by typed text and hides selected ones; discovery terms first', () => {
    const s = {
      discovery: [{ keyword: '料理', source: 'discovery' as const, videos: 9, accounts: 0, via: 'niconico 검색' }],
      topics: [
        { keyword: '먹방', source: 'topic' as const, videos: 5, accounts: 3, via: null },
        { keyword: '먹방 asmr', source: 'topic' as const, videos: 4, accounts: 2, via: null },
      ],
    };
    expect(filterSuggestions(s, '', []).map((x) => x.keyword)).toEqual(['料理', '먹방', '먹방 asmr']);
    expect(filterSuggestions(s, '먹방', ['먹방']).map((x) => x.keyword)).toEqual(['먹방 asmr']);
    expect(filterSuggestions(s, '먹방as', []).map((x) => x.keyword)).toEqual(['먹방 asmr']);
    expect(filterSuggestions(undefined, '', [])).toEqual([]);
  });

  it('chart series mark partial days as lower bounds; small helpers', () => {
    const index = buildIndex(sample);
    const a = analyzeKeywords(index, { keywords: ['추석'], range: presetRange('rolling7d', 'Asia/Seoul', sample.generatedAt), rollingHours: 168, tz: 'Asia/Seoul', now: sample.generatedAt });
    const [s] = dailySeries(a);
    expect(s.label).toBe('추석');
    expect(s.points).toHaveLength(a.days.length);
    expect(s.points[0].status).toBe(a.days[0].partial ? 'lower_bound' : 'exact');
    expect(statusSummary({ exact: 1, interpolated: 0, lower_bound: 2, source_reported: 0, unavailable: 3, decrease_flagged: 0 })).toBe('≥ 하한값 2 · — 계산 불가 3');
    expect(shareText(0.3456)).toBe('35%');
    expect(shareText(0.034)).toBe('3.4%');
    expect(shareText(null)).toBe('—');
    // a views share built from only part of the videos is labelled 'n/m개 기준' on the page
    const m = (status: 'exact' | 'unavailable') => ({ value: status === 'exact' ? 0.4 : null, status, asOf: null, note: null });
    expect(partialShare({ excludedVideos: 3, viewShare: m('exact') })).toBe(true);
    expect(partialShare({ excludedVideos: 0, viewShare: m('exact') })).toBe(false);
    expect(partialShare({ excludedVideos: 3, viewShare: m('unavailable') })).toBe(false);
    const cov = keywordCoverage(sample);
    expect(cov.trackedVideos).toBe(sample.videos.length);
    expect(typeof cov.youtubeSearch).toBe('boolean');
  });
});

describe('KeywordsPage (server render)', () => {
  it('without keywords: explains the page, the coverage and offers suggestions', () => {
    const html = render(S, '/keywords');
    const t = text(html);
    expect(html).toContain('<h1');
    expect(t).toContain('키워드 분석');
    expect(t).toContain('Keyword Intelligence');
    expect(t).toContain('비교할 키워드를 입력하세요');
    expect(t).toContain('찾을 수 있는 범위');
    expect(t).toContain('packages/collector/seeds/keywords.json');
    expect(t).toContain('추천 키워드');
    expect(t).toContain('조회 발생 기간 기준');
    expect(t).toContain('최근 168시간');
    expect(html).toContain('href="/coverage"');
    const topic = keywordSuggestions(S.index).topics[0];
    if (topic) expect(t).toContain(topic.keyword);
  });

  it('with keywords: comparison, share of voice, daily chart card, per-keyword panel and deep links', () => {
    const topics = keywordSuggestions(S.index).topics.slice(0, 2).map((x) => x.keyword);
    expect(topics.length).toBe(2);
    const html = render(S, `/keywords?kw=${encodeURIComponent(topics.join(','))}&range=rolling30d`);
    const t = text(html);
    expect(t).toContain('키워드 비교');
    expect(t).toContain('플랫폼별 점유율');
    expect(t).toContain('일별 업로드 수');
    expect(t).toContain('기간 조회 증가 상위 영상');
    expect(t).toContain('상위 크리에이터');
    expect(t).toContain('함께 나오는 주제');
    expect(t).toContain('광고·협찬');
    expect(t).toContain('영상 탐색에서 보기');
    // the keyword can be pinned to the watchlist from its panel (관심 목록 says so)
    expect(t).toContain('관심 목록에 추가');
    expect(t).toContain('최근 720시간');
    for (const k of topics) expect(t).toContain(k);
    const a = analyzeKeywords(S.index, { keywords: topics, range: presetRange('rolling30d', 'Asia/Seoul', S.now), rollingHours: 720, tz: 'Asia/Seoul', now: S.now, topVideos: 10 });
    expect(t).toContain(`일치 영상 ${a.keywords[0].videos.toLocaleString('ko-KR')}`);
    expect(decode(html)).toContain(`href="${decode(videosSearchHref(topics[0], { range: 'rolling30d' }))}"`);
    // top videos link to the video drawer, creators to their page
    const top = a.keywords[0].topVideos[0];
    if (top) expect(decode(html)).toContain(new URLSearchParams({ v: top.video.id }).toString());
    const creator = a.keywords[0].topCreators[0];
    if (creator) expect(html).toContain(`/creators/${creator.key}`);
    // provenance small print with the core notes
    expect(t).toContain('데이터 기준');
    expect(t).toContain('키워드 일치:');
  });

  it('a keyword without tracked videos explains the coverage instead of showing zeros', () => {
    const html = render(S, '/keywords?kw=%EC%97%86%EB%8A%94%ED%82%A4%EC%9B%8C%EB%93%9C%EC%A0%95%EB%A7%90');
    const t = text(html);
    expect(t).toContain('일치하는 추적 영상 없음');
    expect(t).toContain('데이터 범위');
    expect(t).toContain('YouTube 검색 API');
    expect(t).not.toContain('플랫폼별 점유율'); // one keyword: no share of voice
  });

  it('early collection (one observation per video): unknown increases are shown as —, never 0', () => {
    const now = ts('2026-09-28T15:00');
    const acc = makeAccount({ id: 'youtube:UCa', name: '채널 에이' });
    const early = makeDataset({
      generatedAt: now,
      accounts: [acc],
      videos: [
        makeVideo({ id: 'youtube:e1', accountId: acc.id, title: '먹방 첫 영상', publishedAt: ts('2026-09-10T09:00'), obs: [makeObs(now - 600_000, 5000)] }),
        makeVideo({ id: 'youtube:e2', accountId: acc.id, title: '먹방 두번째', publishedAt: ts('2026-09-12T09:00'), obs: [makeObs(now - 600_000, 900)] }),
      ],
    });
    const html = render(ctx(early, false), '/keywords?kw=%EB%A8%B9%EB%B0%A9');
    const t = text(html);
    expect(t).toContain('먹방');
    expect(t).toContain('계산 불가');
    expect(t).toContain('0으로 세지 않고');
    expect(html).toContain('—');
  });
});
