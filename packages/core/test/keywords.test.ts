import { describe, expect, it } from 'vitest';
import {
  analyzeKeywords,
  compileKeyword,
  discoveryKeywordOf,
  keywordMatches,
  keywordSuggestions,
  keywordTopVideosCsv,
  normalizeKeywordList,
} from '../src/keywords.ts';
import type { KeywordOptions } from '../src/keywords.ts';
import { queryVideos } from '../src/query.ts';
import { buildIndex } from '../src/dataset.ts';
import { presetRange } from '../src/time.ts';
import type { Platform, Video } from '../src/types.ts';
import { HOUR_MS, makeAccount, makeDataset, makeIndex, makeObs, makeSourceWindow, makeVideo, obsOf, ts } from './fixtures.ts';

const H = HOUR_MS;
const SEOUL = 'Asia/Seoul';
const NOW = ts('2026-09-28T12:00:00Z');
const START = NOW - 168 * H;
const RANGE = presetRange('rolling7d', SEOUL, NOW);

const opts = (keywords: string[], o: Partial<KeywordOptions> = {}): KeywordOptions => ({ keywords, range: RANGE, rollingHours: 168, tz: SEOUL, now: NOW, ...o });

let seq = 0;
type IncKind = number | 'lower' | 'unknown' | 'not_provided' | 'decrease';
/** A video published before the window whose views increase inside it is `inc` (exact) or of the given kind. */
function vid(title: string, inc: IncKind, extra: Partial<Video> = {}): Video {
  const platform: Platform = extra.platform ?? 'youtube';
  const n = ++seq;
  let obs;
  if (typeof inc === 'number') obs = [makeObs(START, 1000), makeObs(NOW, 1000 + inc)];
  else if (inc === 'lower') obs = [makeObs(START + 24 * H, 1000), makeObs(NOW, 1500)]; // start boundary unobserved -> >= 500
  else if (inc === 'unknown') obs = [makeObs(NOW, 1000)]; // one observation: increase unknown
  else if (inc === 'decrease') obs = [makeObs(START, 1000), makeObs(NOW, 900)];
  else obs = [obsOf(START, { likes: 1 }), obsOf(NOW, { likes: 5 })]; // views not provided by the source
  return makeVideo({
    id: `${platform}:k${n}`,
    accountId: `${platform}:ch${n % 3}`,
    publishedAt: ts('2026-09-01'),
    title,
    obs,
    ...extra,
  });
}

describe('keyword matching', () => {
  it('Korean: normalized, spacing-insensitive substring in title / tags / topics / description', () => {
    expect(keywordMatches(makeVideo({ title: '대식가 먹방 ASMR' }), '먹방')).toBe('title');
    expect(keywordMatches(makeVideo({ title: '오늘 저녁', tags: ['#먹방'] }), '#먹방')).toBe('tags');
    expect(keywordMatches(makeVideo({ title: '오늘 저녁', topics: ['먹방asmr'] }), '먹방')).toBe('topics');
    expect(keywordMatches(makeVideo({ title: '오늘 저녁', description: '구독 부탁 #먹방' }), '먹방')).toBe('description');
    // spacing: '선크림' matches '선 크림', and a spaced keyword matches unspaced text ('all' terms)
    expect(keywordMatches(makeVideo({ title: '여름 선 크림 추천' }), '선크림')).toBe('title');
    expect(keywordMatches(makeVideo({ title: '나혼자산다 레전드' }), '나 혼자 산다')).toBe('title');
    // width / case: full-width and upper case are normalized (NFKC + lowercase)
    expect(keywordMatches(makeVideo({ title: 'ＫＰＯＰ 커버' }), 'kpop')).toBe('title');
    expect(keywordMatches(makeVideo({ title: '다른 영상' }), '먹방')).toBeNull();
    // a term never spans two fields (title end + first tag)
    expect(keywordMatches(makeVideo({ title: '오늘 먹', tags: ['방송'] }), '먹방')).toBeNull();
    // Japanese substring
    expect(keywordMatches(makeVideo({ title: '【ゆっくり解説】宇宙の話' }), 'ゆっくり解説')).toBe('title');
  });

  it('short ASCII terms match whole words only; longer ones match at a word start', () => {
    const ai = (title: string) => keywordMatches(makeVideo({ title }), 'ai');
    expect(ai('AI 활용법 총정리')).toBe('title');
    expect(ai('The AI era')).toBe('title');
    expect(ai('생성AI로 만든 영상')).toBe('title'); // Hangul around it is not a Latin word char
    expect(ai('new AIs everywhere')).toBe('title'); // plural
    expect(ai('He said hello')).toBeNull();
    expect(ai('Thailand trip')).toBeNull();
    expect(ai('maintain your car')).toBeNull();
    expect(keywordMatches(makeVideo({ title: 'LCK 하이라이트' }), 'lck')).toBe('title');
    expect(keywordMatches(makeVideo({ title: 'box fans' }), 'box')).toBe('title');
    expect(keywordMatches(makeVideo({ title: 'boxes and more' }), 'box')).toBe('title'); // 'es' after x
    expect(keywordMatches(makeVideo({ title: 'cares a lot' }), 'car')).toBeNull(); // no 'es' after r
    // prefix mode (>= 5 chars): glued hashtags and derived words, but still a left word boundary
    expect(keywordMatches(makeVideo({ title: 'epic #minecraftbuilds' }), 'minecraft')).toBe('title');
    expect(keywordMatches(makeVideo({ title: 'korean food' }), 'korea')).toBe('title');
    expect(keywordMatches(makeVideo({ title: 'superminecraft' }), 'minecraft')).toBeNull();
    // mixed term starting with a Latin letter needs a left boundary
    expect(keywordMatches(makeVideo({ title: 'LCK e스포츠 소식' }), 'e스포츠')).toBe('title');
    expect(keywordMatches(makeVideo({ title: 'the스포츠' }), 'e스포츠')).toBeNull();
    expect(compileKeyword('AI 활용').terms).toEqual([
      { text: 'ai', mode: 'word' },
      { text: '활용', mode: 'substring' },
    ]);
    expect(compileKeyword('Minecraft').terms).toEqual([{ text: 'minecraft', mode: 'prefix' }]);
  });

  it("match 'all' needs every term, 'any' one; single characters are ignored in 'any' next to longer terms", () => {
    const v = makeVideo({ title: '여름 선크림 리뷰' });
    expect(keywordMatches(v, '선크림 추천')).toBeNull();
    expect(keywordMatches(v, '선크림 추천', { match: 'any' })).toBe('title');
    const k = compileKeyword('나 혼자 산다', 'any');
    expect(k.terms.map((t) => t.text)).toEqual(['혼자', '산다']);
    expect(k.dropped).toEqual(['나']);
    expect(keywordMatches(makeVideo({ title: '나는 오늘' }), k, { match: 'any' })).toBeNull();
  });

  it('fields restrict where terms are searched; the first field (title > tags > topics > description) is reported', () => {
    const v = makeVideo({ title: '저녁 브이로그', tags: ['일상'], description: '오늘은 먹방' });
    expect(keywordMatches(v, '먹방')).toBe('description');
    expect(keywordMatches(v, '먹방', { fields: ['title', 'tags'] })).toBeNull();
    const both = makeVideo({ title: '먹방 브이로그', tags: ['먹방'] });
    expect(keywordMatches(both, '먹방', { fields: ['tags'] })).toBe('tags');
    expect(keywordMatches(both, '먹방')).toBe('title');
  });

  it('keyword lists are trimmed, de-duplicated by normalized text and validated', () => {
    expect(normalizeKeywordList([' 먹방 ', '#먹방', 'ＡＩ', 'ai', '', '  '])).toEqual(['먹방', 'ＡＩ']);
    expect(() => compileKeyword('###')).toThrow(RangeError);
    expect(() => compileKeyword('x'.repeat(101))).toThrow(RangeError);
    const index = makeIndex({ videos: [vid('a', 1)], generatedAt: NOW });
    expect(() => analyzeKeywords(index, opts([]))).toThrow(/at least one keyword/);
    expect(() => analyzeKeywords(index, opts(['a', 'b', 'c', 'd', 'e', 'f']))).toThrow(/at most 5/);
    expect(() => analyzeKeywords(index, opts(['a'], { match: 'some' as never }))).toThrow(/match mode/);
    expect(() => analyzeKeywords(index, opts(['a'], { fields: ['body' as never] }))).toThrow(/field/);
  });
});

describe('analyzeKeywords: honest view sums', () => {
  it('adds exact values; a lower-bound value makes the sum a lower bound; unknown values are counted, never 0', () => {
    const videos = [vid('먹방 1', 1000), vid('먹방 2', 'lower'), vid('먹방 3', 'unknown'), vid('다른 영상', 99_999)];
    const a = analyzeKeywords(makeIndex({ videos, generatedAt: NOW }), opts(['먹방']));
    const r = a.keywords[0];
    expect(r.videos).toBe(3);
    // 1000 (exact) + 500 (lower bound); the unknown one is not added as 0 and forces a lower bound anyway
    expect(r.viewsPeriod).toMatchObject({ value: 1500, status: 'lower_bound', unknown: 1, videos: 3, crossPlatform: false });
    expect(r.statusCounts).toMatchObject({ exact: 1, lower_bound: 1, unavailable: 1 });
    expect(r.notes.join(' ')).toContain('계산 불가 1개는 0으로 세지 않고');
  });

  it('lower_bound alone (no unknowns) still yields a lower-bound sum', () => {
    const a = analyzeKeywords(makeIndex({ videos: [vid('먹방 a', 200), vid('먹방 b', 'lower')], generatedAt: NOW }), opts(['먹방']));
    expect(a.keywords[0].viewsPeriod).toMatchObject({ value: 700, status: 'lower_bound', unknown: 0 });
  });

  it('only unknown increases -> unavailable (null), not 0; no match -> unavailable no_tracked_videos', () => {
    const a = analyzeKeywords(makeIndex({ videos: [vid('먹방 x', 'unknown'), vid('먹방 y', 'unknown'), vid('게임', 10)], generatedAt: NOW }), opts(['먹방', '없는말']));
    expect(a.keywords[0].viewsPeriod.value).toBeNull();
    expect(a.keywords[0].viewsPeriod.status).toBe('unavailable');
    expect(a.keywords[1].videos).toBe(0);
    expect(a.keywords[1].viewsPeriod).toMatchObject({ value: null, status: 'unavailable', note: 'no_tracked_videos' });
    expect(a.keywords[1].notes[0]).toContain('일치하는 영상이 없습니다');
  });

  it('a counter the source does not provide is skipped (not a gap); decreases are excluded', () => {
    const a = analyzeKeywords(makeIndex({ videos: [vid('먹방 1', 300), vid('먹방 2', 'not_provided'), vid('먹방 3', 'decrease')], generatedAt: NOW }), opts(['먹방']));
    const r = a.keywords[0];
    expect(r.viewsPeriod).toMatchObject({ value: 300, status: 'exact', notProvided: 1, decreased: 1, unknown: 0 });
    expect(r.statusCounts.decrease_flagged).toBe(1);
    expect(r.notes.join(' ')).toContain('원천이 조회수를 제공하지 않는 영상 1개');
  });

  it('uses the source-reported window value like queryVideos (Dailymotion views_last_week)', () => {
    const dm = vid('먹방 dm', 'unknown', {
      platform: 'dailymotion',
      id: 'dailymotion:dm1',
      accountId: 'dailymotion:a',
      sourceWindows: [makeSourceWindow('views', 168, 4200, NOW)],
      obs: [makeObs(NOW, 90_000)],
    });
    const a = analyzeKeywords(makeIndex({ videos: [dm], generatedAt: NOW }), opts(['먹방']));
    expect(a.keywords[0].viewsPeriod).toMatchObject({ value: 4200, status: 'source_reported' });
  });
});

describe('analyzeKeywords: breakdowns', () => {
  const yt = [
    vid('먹방 브이로그', 1000, { accountId: 'youtube:a', topics: ['맛집', '브이로그'], language: 'ko', categories: [{ id: 'food/mukbang', confidence: 0.9, evidence: [], by: 'rule', version: 't' }] }),
    vid('먹방 챌린지', 3000, { accountId: 'youtube:b', topics: ['맛집'], language: 'ko', sponsorship: { level: 'disclosed', brands: ['브랜드A'], evidence: [], version: 't' } }),
    vid('먹방 여행', 2000, { accountId: 'youtube:c', topics: ['맛집', '여행'], language: 'en' }),
    vid('게임 방송', 5000, { accountId: 'youtube:d', topics: ['게임', '여행'] }),
    vid('게임 공략', 100, { accountId: 'youtube:e', topics: ['게임'] }),
    vid('브이로그', 10, { accountId: 'youtube:f', topics: ['브이로그'] }),
  ];
  const dm = [
    vid('먹방 dm', 'unknown', {
      platform: 'dailymotion',
      id: 'dailymotion:x1',
      accountId: 'dailymotion:m',
      sourceWindows: [makeSourceWindow('views', 168, 700_000, NOW)],
      obs: [makeObs(NOW, 900_000)],
      sponsorship: { level: 'likely', brands: ['브랜드A', '브랜드B'], evidence: [], version: 't' },
    }),
    vid('게임 dm', 'unknown', { platform: 'dailymotion', id: 'dailymotion:x2', accountId: 'dailymotion:m', obs: [makeObs(NOW, 10)] }),
  ];
  // a new upload inside the window: 2026-09-27T16:00Z = 2026-09-28 01:00 KST
  const fresh = makeVideo({ id: 'youtube:new', accountId: 'youtube:a', title: '먹방 신작', publishedAt: ts('2026-09-27T16:00Z'), obs: [makeObs(NOW, 800)] });
  const accounts = [
    makeAccount({ id: 'youtube:a', name: '채널 A', creatorId: 'cr' }),
    makeAccount({ id: 'dailymotion:m', name: 'Channel A DM', creatorId: 'cr' }),
    ...['b', 'c', 'd', 'e', 'f'].map((x) => makeAccount({ id: `youtube:${x}`, name: `채널 ${x}` })),
  ];
  const index = buildIndex(
    makeDataset({ videos: [...yt, ...dm, fresh], accounts, creators: [{ id: 'cr', name: '크리에이터', accountIds: ['youtube:a', 'dailymotion:m'], linkStatus: 'verified', note: null }], generatedAt: NOW }),
  );
  const a = analyzeKeywords(index, opts(['먹방', '게임'], { minTopicSupport: 2 }));
  const [mk, gm] = a.keywords;

  it('counts matched videos, uploads in window and local-day uploads in tz', () => {
    expect(mk.videos).toBe(5);
    expect(mk.uploadsInWindow).toBe(1);
    expect(a.days.map((d) => d.date)).toEqual(['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28']);
    expect(a.days[0].partial).toBe(true); // window starts at 21:00 KST
    expect(a.days[7].partial).toBe(true); // ends at 21:00 KST
    expect(mk.daily[7]).toBe(1);
    expect(mk.daily.reduce((x, y) => x + y, 0)).toBe(mk.uploadsInWindow);
    expect(a.scopeVideos).toBe(9);
  });

  it('splits by platform and flags cross-platform totals', () => {
    expect(mk.platforms.map((p) => [p.platform, p.videos, p.viewsPeriod.value, p.viewsPeriod.status])).toEqual([
      ['youtube', 4, 6800, 'exact'],
      ['dailymotion', 1, 700_000, 'source_reported'],
    ]);
    expect(mk.viewsPeriod).toMatchObject({ value: 706_800, crossPlatform: true, platforms: ['youtube', 'dailymotion'] });
    expect(mk.notes.join(' ')).toContain('여러 플랫폼(YouTube·Dailymotion)');
    expect(a.notes.join(' ')).toContain('점유율과 순위는 플랫폼별로');
  });

  it('share of voice per platform: uploads share and a views share over measurable videos only', () => {
    const ytShare = a.shareOfVoice.find((s) => s.platform === 'youtube')!;
    const [m, g] = ytShare.items;
    expect(m).toMatchObject({ keyword: '먹방', measuredViews: 6800, measuredVideos: 4, excludedVideos: 0 });
    expect(g).toMatchObject({ keyword: '게임', measuredViews: 5100 });
    expect(m.viewShare.value).toBeCloseTo(6800 / 11_900, 10);
    expect(m.viewShare.status).toBe('exact');
    expect(m.uploadShare).toBe(1); // only '먹방' uploaded in the window
    expect(g.uploadShare).toBe(0);
    const dmShare = a.shareOfVoice.find((s) => s.platform === 'dailymotion')!;
    // '게임' on Dailymotion has only an unknown increase: its share is unknown, not 0%
    expect(dmShare.items[1].viewShare).toMatchObject({ value: null, status: 'unavailable' });
    expect(dmShare.items[1].excludedVideos).toBe(1);
    expect(dmShare.items[0].viewShare).toMatchObject({ value: 1, status: 'source_reported' });
  });

  it('share of voice: a keyword with no tracked video on a platform is an exact 0% (not the others\' status)', () => {
    const b = analyzeKeywords(index, opts(['먹방', '없는키워드']));
    for (const s of b.shareOfVoice) {
      expect(s.items[1]).toMatchObject({ videos: 0, measuredVideos: 0, excludedVideos: 0 });
      expect(s.items[1].viewShare).toMatchObject({ value: 0, status: 'exact', note: 'no_tracked_videos' });
    }
    // the matched keyword keeps its measured status (Dailymotion: source-reported windows)
    expect(b.shareOfVoice.find((s) => s.platform === 'dailymotion')!.items[0].viewShare).toMatchObject({ value: 1, status: 'source_reported' });
  });

  it('top videos rank like queryVideos(activity, views_period) and carry full metrics', () => {
    const q = queryVideos(index, { dateMode: 'activity', range: RANGE, rollingHours: 168, tz: SEOUL, now: NOW, sort: 'views_period' });
    const matched = new Set(mk.topVideos.map((r) => r.video.id));
    const expected = q.rows.filter((r) => matched.has(r.video.id)).map((r) => r.video.id);
    expect(mk.topVideos.map((r) => r.video.id)).toEqual(expected);
    expect(mk.topVideos[0].video.id).toBe('dailymotion:x1');
    for (const row of mk.topVideos) {
      const ref = q.rows.find((r) => r.video.id === row.video.id)!;
      expect(row.metrics.viewsPeriod).toEqual(ref.metrics.viewsPeriod);
      expect(row.metrics.viewsTotal).toEqual(ref.metrics.viewsTotal);
    }
    // in-platform percentile among the keyword's videos
    const ytTop = mk.topVideos.find((r) => r.video.platform === 'youtube')!;
    expect(ytTop.metrics.percentile.value).toBeGreaterThan(50);
    expect(ytTop.metrics.percentile.note).toBe('few_platform_peers');
  });

  it('groups creators across linked accounts, and lists categories, languages and sponsorship', () => {
    const cr = mk.topCreators.find((c) => c.key === 'cr')!;
    expect(cr).toMatchObject({ kind: 'creator', name: '크리에이터', videos: 3, platforms: ['youtube', 'dailymotion'] });
    expect(cr.viewsPeriod.crossPlatform).toBe(true);
    expect(mk.topCreators[0].key).toBe('cr'); // most matching videos first
    expect(mk.categories).toEqual([{ id: 'food', count: 1 }]);
    expect(mk.uncategorized).toBe(4);
    expect(mk.languages[0]).toEqual({ code: 'ko', count: 2 });
    expect(mk.languages.find((l) => l.code === null)?.count).toBe(2);
    expect(mk.sponsored).toMatchObject({ disclosed: 1, likely: 1, share: 2 / 5 });
    expect(mk.sponsored.brands[0]).toEqual({ name: '브랜드A', count: 2 });
    expect(mk.fieldHits.title).toBe(5);
    expect(gm.videos).toBe(3);
  });

  it('related topics: lift over the scope frequency, min support and >= 2 accounts', () => {
    // '맛집' is on 3 of 5 '먹방' videos (3 accounts) and on 3 of 9 scope videos: lift = (3/5)/(3/9) = 1.8
    const t = mk.relatedTopics.find((x) => x.topic === '맛집')!;
    expect(t).toMatchObject({ support: 3, overall: 3, accounts: 3 });
    expect(t.lift).toBeCloseTo(1.8, 10);
    // '여행': 1 of 5 keyword videos (below support 2)
    expect(mk.relatedTopics.some((x) => x.topic === '여행')).toBe(false);
    // the keyword itself is never its own related topic
    expect(gm.relatedTopics.some((x) => x.topic === '게임')).toBe(false);
  });

  it('overlap and notes: date semantics, matching rules, coverage', () => {
    expect(a.overlapVideos).toBe(0);
    const text = a.notes.join(' ');
    expect(text).toContain('조회 발생 기간 기준');
    expect(text).toContain('4자 이하 영문은 단어 단위');
    expect(text).toContain('추적 중인 영상 9개');
    expect(text).toContain('점유율(share of voice)');
  });

  it('filters (platforms, languages, categories) restrict the scope', () => {
    const onlyYt = analyzeKeywords(index, opts(['먹방'], { platforms: ['youtube'] }));
    expect(onlyYt.keywords[0].videos).toBe(4);
    expect(onlyYt.keywords[0].viewsPeriod.crossPlatform).toBe(false);
    expect(analyzeKeywords(index, opts(['먹방'], { languages: ['en'] })).keywords[0].videos).toBe(1);
    expect(analyzeKeywords(index, opts(['먹방'], { categories: ['food'] })).keywords[0].videos).toBe(1);
  });

  it('CSV of top videos: keyword + rank columns in front of the query CSV columns', () => {
    const csv = keywordTopVideosCsv(a);
    const lines = csv.slice(1).split('\r\n').filter(Boolean);
    expect(lines[0].startsWith('키워드,키워드 내 순위,플랫폼,영상 ID')).toBe(true);
    expect(lines.length).toBe(1 + mk.topVideos.length + gm.topVideos.length);
    expect(lines[1].startsWith('먹방,1,Dailymotion,dailymotion:x1')).toBe(true);
    expect(lines[1]).toContain('원천 보고(source_reported)');
  });
});

describe('analyzeKeywords: windows and as-of', () => {
  it('a calendar range counts only uploads inside it and marks no partial days when finished', () => {
    const v1 = makeVideo({ id: 'youtube:w1', title: '먹방', publishedAt: ts('2026-09-20T03:00Z'), obs: [makeObs(NOW, 10)] });
    const v2 = makeVideo({ id: 'youtube:w2', title: '먹방', publishedAt: ts('2026-09-25T03:00Z'), obs: [makeObs(NOW, 10)] });
    const a = analyzeKeywords(makeIndex({ videos: [v1, v2], generatedAt: NOW }), { keywords: ['먹방'], range: { start: '2026-09-19', end: '2026-09-21' }, tz: SEOUL, now: NOW });
    expect(a.days.map((d) => d.date)).toEqual(['2026-09-19', '2026-09-20', '2026-09-21']);
    expect(a.days.every((d) => !d.partial)).toBe(true);
    // v2 was published after the window: not part of the population
    expect(a.keywords[0].videos).toBe(1);
    expect(a.keywords[0].daily).toEqual([0, 1, 0]);
  });

  it('now before the latest data: later observations and videos are ignored (as-of)', () => {
    const later = NOW - 48 * H;
    const v = makeVideo({ id: 'youtube:asof', title: '먹방', publishedAt: ts('2026-09-01'), obs: [makeObs(later - 168 * H, 100), makeObs(later, 400), makeObs(NOW, 9000)] });
    const fresh = makeVideo({ id: 'youtube:after', title: '먹방', publishedAt: NOW - 3 * H, obs: [makeObs(NOW, 10)] });
    const a = analyzeKeywords(makeIndex({ videos: [v, fresh], generatedAt: NOW }), opts(['먹방'], { now: later, range: presetRange('rolling7d', SEOUL, later) }));
    expect(a.keywords[0].videos).toBe(1);
    expect(a.keywords[0].viewsPeriod).toMatchObject({ value: 300, status: 'exact' });
    expect(a.notes.join(' ')).toContain('이후에 수집된 관측값');
  });
});

describe('suggestions', () => {
  it('parses discovery keywords from discoveredVia', () => {
    expect(discoveryKeywordOf('niconico:tag:料理')).toEqual({ keyword: '料理', via: 'niconico 검색' });
    expect(discoveryKeywordOf('youtube-data-api:search:date:메이크업')).toEqual({ keyword: '메이크업', via: 'YouTube 검색' });
    expect(discoveryKeywordOf('x-api:search:k-pop')).toEqual({ keyword: 'k-pop', via: 'X 검색' });
    expect(discoveryKeywordOf('seed-channel:UCabc')).toBeNull();
    expect(discoveryKeywordOf('dailymotion:visited-today:kr')).toBeNull();
  });

  it('lists discovery keywords and popular multi-account topics', () => {
    const videos = [
      makeVideo({ id: 'niconico:1', accountId: 'niconico:a', discoveredVia: ['niconico:tag:料理'], topics: ['料理', '猫'] }),
      makeVideo({ id: 'niconico:2', accountId: 'niconico:b', discoveredVia: ['niconico:tag:料理'], topics: ['猫'] }),
      makeVideo({ id: 'niconico:3', accountId: 'niconico:c', topics: ['猫', 'shorts'] }),
      makeVideo({ id: 'niconico:4', accountId: 'niconico:c', topics: ['one channel'] }),
    ];
    const s = keywordSuggestions(makeIndex({ videos, generatedAt: NOW }));
    expect(s.discovery).toEqual([{ keyword: '料理', source: 'discovery', videos: 2, accounts: 0, via: 'niconico 검색' }]);
    expect(s.topics.map((t) => t.keyword)).toEqual(['猫']); // 'shorts' is generic, 'one channel' has 1 video
  });
});

describe('performance', () => {
  it('5 keywords over 20k videos stay under 150 ms once the search text is cached', () => {
    const words = ['먹방', '브이로그', 'ai', 'minecraft', '여행', '뉴스', '게임', 'kpop', '리뷰', '추천', 'vlog', 'ゲーム'];
    const videos: Video[] = [];
    for (let i = 0; i < 20_000; i++) {
      const a = words[i % words.length];
      const b = words[(i * 7) % words.length];
      videos.push(
        makeVideo({
          id: `youtube:p${i}`,
          accountId: `youtube:c${i % 500}`,
          publishedAt: NOW - ((i % 400) + 1) * 3 * H,
          title: `${a} 영상 제목 ${i} 오늘의 ${b} 모음`,
          tags: [a, `tag${i % 50}`],
          topics: [b, `topic${i % 200}`],
          description: `설명 ${b} 입니다. 구독과 좋아요 #${a} ${'자세한 내용 '.repeat(10)}`,
          obs: [makeObs(START, 100 + i), makeObs(NOW - 2 * H, 500 + i)],
        }),
      );
    }
    const index = makeIndex({ videos, generatedAt: NOW });
    const o = opts(['먹방', 'ai', '여행 추천', 'minecraft', 'ゲーム']);
    analyzeKeywords(index, o); // builds the per-video search text + topic caches
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      const r = analyzeKeywords(index, o);
      best = Math.min(best, performance.now() - t0);
      expect(r.keywords[0].videos).toBeGreaterThan(1000);
    }
    expect(best).toBeLessThan(150);
  });
});
