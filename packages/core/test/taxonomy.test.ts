import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_CONFIDENCE,
  BROAD_SOURCE_CONFIDENCE,
  CLASSIFIER_VERSION,
  KEYWORD_TRAPS,
  MAX_SUB_PER_TOP,
  SOURCE_CONFIDENCE,
  STOP_TOPICS,
  TAXONOMY,
  TOP_LEVEL_CATEGORY_IDS,
  ancestorsOf,
  categoryLabel,
  categoryPathLabel,
  classifyVideo,
  descendantsOf,
  extractBracketTopics,
  extractTopics,
  findKeywords,
  taxonomyById,
  topLevelOf,
  type ClassifyInput,
} from '../src/taxonomy.ts';
import { normalizeText } from '../src/text.ts';

function input(partial: Partial<ClassifyInput>): ClassifyInput {
  return { title: '', description: null, tags: [], sourceCategory: null, accountSeedCategory: null, language: null, ...partial };
}

function classify(partial: Partial<ClassifyInput>) {
  return classifyVideo(input(partial));
}

function ids(partial: Partial<ClassifyInput>): string[] {
  return classify(partial).categories.map((c) => c.id);
}

function tops(partial: Partial<ClassifyInput>): string[] {
  return ids(partial).filter((id) => !id.includes('/'));
}

function get(partial: Partial<ClassifyInput>, id: string) {
  return classify(partial).categories.find((c) => c.id === id);
}

const HANGUL = /[\p{Script=Hangul}]/u;
const KANA_KANJI = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;
const LATIN = /^[\x20-\x7e]+$/;

/* ------------------------------------------------------------------------------------------ */

describe('taxonomy structure', () => {
  it('has the classifier version', () => {
    expect(CLASSIFIER_VERSION).toBe('rules-2026.09.1');
  });

  it('has exactly the 20 fixed top-level ids, in order', () => {
    const topNodes = TAXONOMY.filter((n) => n.parent === null).map((n) => n.id);
    expect(topNodes).toEqual([...TOP_LEVEL_CATEGORY_IDS]);
    expect(topNodes).toHaveLength(20);
  });

  it('gives every top-level 4-10 subcategories with `top/slug` ids', () => {
    for (const top of TOP_LEVEL_CATEGORY_IDS) {
      const subs = TAXONOMY.filter((n) => n.parent === top);
      expect(subs.length, top).toBeGreaterThanOrEqual(4);
      expect(subs.length, top).toBeLessThanOrEqual(10);
      for (const s of subs) expect(s.id).toMatch(new RegExp(`^${top}/[a-z0-9_]+$`));
    }
  });

  it('has unique ids, valid parents and Korean + English labels', () => {
    const seen = new Set<string>();
    for (const n of TAXONOMY) {
      expect(seen.has(n.id), n.id).toBe(false);
      seen.add(n.id);
      if (n.parent) expect(TOP_LEVEL_CATEGORY_IDS).toContain(n.parent);
      expect(n.label.ko.trim().length, n.id).toBeGreaterThan(0);
      expect(n.label.en.trim().length, n.id).toBeGreaterThan(0);
      expect(HANGUL.test(n.label.ko) || /^[A-Z0-9· -]+$/i.test(n.label.ko), `${n.id} ko label`).toBe(true);
    }
  });

  it('stores keywords normalized, de-duplicated and at least 2 characters long', () => {
    for (const n of TAXONOMY) {
      expect(new Set(n.keywords).size, n.id).toBe(n.keywords.length);
      for (const k of n.keywords) {
        expect(normalizeText(k), `${n.id}: ${k}`).toBe(k);
        expect(k.length, `${n.id}: ${k}`).toBeGreaterThanOrEqual(2);
        expect(k.includes('?'), `${n.id}: ${k}`).toBe(false);
      }
    }
  });

  it('has Korean, English and Japanese keywords in every family and every subcategory has keywords', () => {
    for (const top of TOP_LEVEL_CATEGORY_IDS) {
      const kws = TAXONOMY.filter((n) => n.id === top || n.parent === top).flatMap((n) => n.keywords);
      expect(kws.some((k) => HANGUL.test(k)), `${top} ko`).toBe(true);
      expect(kws.some((k) => LATIN.test(k)), `${top} en`).toBe(true);
      expect(kws.some((k) => KANA_KANJI.test(k)), `${top} ja`).toBe(true);
      expect(kws.length, top).toBeGreaterThanOrEqual(40);
    }
    for (const n of TAXONOMY) expect(n.keywords.length, n.id).toBeGreaterThanOrEqual(4);
  });

  it('includes the examples from the product brief', () => {
    const kw = (id: string) => taxonomyById().get(id)!.keywords;
    for (const k of ['스킨케어', '토너', '세럼', '선크림', 'skincare', 'serum', 'sunscreen', 'スキンケア']) expect(kw('beauty/skincare')).toContain(k);
    for (const k of ['아이돌', '컴백', '직캠', 'kpop', 'fancam']) expect(kw('music/kpop')).toContain(k);
    for (const k of ['뮤직비디오', 'mv']) expect(kw('music')).toContain(k);
    for (const k of ['예능', '런닝맨', '무한도전']) expect(kw('entertainment/variety')).toContain(k);
    for (const k of ['뉴스', '속보', '앵커']) expect(kw('news_politics')).toContain(k);
    for (const k of ['대통령', '국회']) expect(kw('news_politics/politics')).toContain(k);
    expect(kw('news_politics/election')).toContain('선거');
  });

  it('maps every live Dailymotion channel except webcam', () => {
    // https://api.dailymotion.com/channels?fields=id,name (fetched 2026-09-28)
    const channels = ['animals', 'auto', 'people', 'fun', 'creation', 'school', 'videogames', 'kids', 'lifestyle', 'shortfilms', 'music', 'news', 'sport', 'tech', 'travel', 'tv'];
    const mapped = new Set(TAXONOMY.flatMap((n) => n.sourceCategories));
    for (const c of channels) expect(mapped.has(`dailymotion:${c}`), c).toBe(true);
    expect(mapped.has('dailymotion:webcam')).toBe(false);
  });

  it('maps every PeerTube category', () => {
    const cats = ['Music', 'Films', 'Vehicles', 'Art', 'Sports', 'Travels', 'Gaming', 'People', 'Comedy', 'Entertainment', 'News & Politics', 'How To', 'Education', 'Activism', 'Science & Technology', 'Animals', 'Kids', 'Food'];
    const mapped = new Set(TAXONOMY.flatMap((n) => n.sourceCategories));
    for (const c of cats) expect(mapped.has(`peertube:${c}`), c).toBe(true);
  });

  it('maps every verified niconico genre except the catch-alls', () => {
    // Verified against snapshot.search.nicovideo.jp genre.keyword filters (2026-09-28)
    const genres = ['エンターテイメント', 'ラジオ', '音楽・サウンド', 'ダンス', '動物', '自然', '料理', '旅行・アウトドア', '乗り物', 'スポーツ', '社会・政治・時事', '技術・工作', '解説・講座', 'アニメ', 'ゲーム'];
    const mapped = new Set(TAXONOMY.flatMap((n) => n.sourceCategories));
    for (const g of genres) expect(mapped.has(`niconico:${g}`), g).toBe(true);
    expect(mapped.has('niconico:その他')).toBe(false);
  });

  it('maps each source category into a single family', () => {
    const families = new Map<string, Set<string>>();
    for (const n of TAXONOMY) {
      for (const sc of n.sourceCategories) {
        const set = families.get(sc) ?? new Set<string>();
        set.add(topLevelOf(n.id)!);
        families.set(sc, set);
      }
    }
    for (const [sc, fams] of families) expect(fams.size, sc).toBe(1);
  });

  it('only defines traps that actually contain their keyword', () => {
    for (const [k, traps] of Object.entries(KEYWORD_TRAPS)) {
      for (const t of traps) expect(normalizeText(t).includes(normalizeText(k)), `${k} / ${t}`).toBe(true);
    }
  });
});

describe('lookups', () => {
  it('taxonomyById is cached and complete', () => {
    const a = taxonomyById();
    expect(taxonomyById()).toBe(a);
    expect(a.size).toBe(TAXONOMY.length);
    expect(a.get('beauty/skincare')?.parent).toBe('beauty');
  });

  it('descendantsOf returns the id itself plus descendants', () => {
    const d = descendantsOf('beauty');
    expect(d[0]).toBe('beauty');
    expect(d).toContain('beauty/skincare');
    expect(d).toContain('beauty/makeup');
    expect(d.every((x) => x === 'beauty' || x.startsWith('beauty/'))).toBe(true);
    expect(descendantsOf('beauty/skincare')).toEqual(['beauty/skincare']);
    expect(descendantsOf('nope')).toEqual(['nope']);
  });

  it('ancestorsOf / topLevelOf', () => {
    expect(ancestorsOf('music/kpop')).toEqual(['music/kpop', 'music']);
    expect(ancestorsOf('music')).toEqual(['music']);
    expect(topLevelOf('music/kpop')).toBe('music');
    expect(topLevelOf('music')).toBe('music');
    expect(topLevelOf('unknown/x')).toBeNull();
  });

  it('categoryLabel returns Korean by default, English on request, id as fallback', () => {
    expect(categoryLabel('beauty')).toBe('뷰티');
    expect(categoryLabel('beauty', 'en')).toBe('Beauty');
    expect(categoryLabel('beauty/skincare')).toBe('스킨케어');
    expect(categoryLabel('music/kpop', 'en')).toBe('K-pop');
    expect(categoryLabel('does-not-exist')).toBe('does-not-exist');
    expect(categoryPathLabel('beauty/skincare')).toBe('뷰티 › 스킨케어');
    expect(categoryPathLabel('beauty/skincare', 'en', ' / ')).toBe('Beauty / Skincare');
  });
});

/* ------------------------------------------------------------------------------------------ */

describe('classifyVideo: realistic titles', () => {
  it('Korean news with a bracketed series name', () => {
    const r = classify({ title: '[지금이뉴스] 대통령, 국회 시정연설…여야 공방 격화' });
    const ids = r.categories.map((c) => c.id);
    expect(ids).toContain('news_politics');
    expect(ids).toContain('news_politics/politics');
    const top = r.categories.find((c) => c.id === 'news_politics')!;
    expect(top.by).toBe('rule');
    expect(top.version).toBe(CLASSIFIER_VERSION);
    expect(top.evidence).toContainEqual({ field: 'title', match: '대통령' });
    expect(top.evidence).toContainEqual({ field: 'title', match: '뉴스' });
    expect(r.topics).toContain('지금이뉴스');
  });

  it('K-beauty skincare routine with tags and description', () => {
    const r = classify({
      title: '민감성 피부 데일리 스킨케어 루틴 | 토너패드 추천 #스킨케어',
      description: '세럼과 선크림까지 순서대로 알려드려요',
      tags: ['skincare', '뷰티', 'kbeauty'],
    });
    expect(r.categories[0].id).toBe('beauty');
    expect(r.categories.map((c) => c.id)).toContain('beauty/skincare');
    const sk = r.categories.find((c) => c.id === 'beauty/skincare')!;
    expect(sk.confidence).toBeGreaterThan(0.9);
    expect(sk.evidence).toContainEqual({ field: 'title', match: '스킨케어' });
    expect(sk.evidence).toContainEqual({ field: 'tags', match: 'skincare' });
    expect(sk.evidence).toContainEqual({ field: 'description', match: '세럼' });
    // '토너' is inside the already matched '토너패드': not counted twice
    expect(sk.evidence.some((e) => e.match === '토너')).toBe(false);
    expect(sk.evidence).toContainEqual({ field: 'title', match: '토너패드' });
  });

  it('K-pop music video', () => {
    const r = classify({ title: "NewJeans (뉴진스) 'How Sweet' Official MV" });
    expect(r.categories.map((c) => c.id)).toEqual(expect.arrayContaining(['music', 'music/kpop']));
    expect(get({ title: "NewJeans (뉴진스) 'How Sweet' Official MV" }, 'music')!.confidence).toBeGreaterThan(0.9);
  });

  it('K-pop fancam and comeback stage', () => {
    expect(ids({ title: '[4K] 에스파 카리나 직캠 | 인기가요 컴백 무대' })).toEqual(expect.arrayContaining(['music', 'music/kpop']));
  });

  it('variety shows, including space-less spellings', () => {
    expect(ids({ title: '[런닝맨] 지석진 레전드 모음 ㅋㅋㅋ' })).toContain('entertainment/variety');
    expect(ids({ title: '나혼자산다 기안84 하이라이트' })).toContain('entertainment/variety');
    expect(ids({ title: '놀면뭐하니? 유재석 모음' })).toContain('entertainment/variety');
    expect(ids({ title: '1박2일 시즌4 레전드' })).toContain('entertainment/variety');
  });

  it('Japanese let\'s play with niconico genre', () => {
    const r = classify({ title: '【マイクラ実況】初心者が建築してみた Part1', sourceCategory: 'niconico:ゲーム', tags: ['ゲーム', 'Minecraft'] });
    const gaming = r.categories.find((c) => c.id === 'gaming')!;
    expect(r.categories[0].id).toBe('gaming');
    expect(gaming.evidence).toContainEqual({ field: 'sourceCategory', match: 'niconico:ゲーム' });
    expect(gaming.confidence).toBeGreaterThanOrEqual(0.95);
    expect(r.categories.map((c) => c.id)).toEqual(expect.arrayContaining(['gaming/sandbox', 'gaming/lets_play']));
  });

  it('Japanese vocaloid song', () => {
    const r = classify({ title: '【初音ミク】新曲オリジナル曲【MV】', sourceCategory: 'niconico:音楽・サウンド', tags: ['VOCALOID', 'ボカロ'] });
    expect(r.categories.map((c) => c.id)).toEqual(expect.arrayContaining(['music', 'music/vocaloid']));
    expect(r.categories.map((c) => c.id)).not.toContain('music/kpop');
    expect(r.topics).toEqual(expect.arrayContaining(['初音ミク', 'mv', 'vocaloid', 'ボカロ']));
  });

  it('food: mukbang and recipes', () => {
    expect(ids({ title: '편의점 신상 불닭 먹방 ASMR' })).toEqual(expect.arrayContaining(['food', 'food/mukbang', 'food/convenience']));
    expect(ids({ title: '백종원 김치찌개 황금레시피' })).toEqual(expect.arrayContaining(['food', 'food/cooking']));
    expect(ids({ title: 'Easy 15-minute dinner recipes for busy weeknights' })).toContain('food/cooking');
    expect(ids({ title: '簡単レシピ 作り置きおかず' })).toContain('food/cooking');
  });

  it('English sports and tech titles', () => {
    expect(ids({ title: 'Premier League Highlights: Tottenham vs Arsenal' })).toEqual(expect.arrayContaining(['sports', 'sports/soccer']));
    expect(ids({ title: 'iPhone 17 Pro review after one month' })).toEqual(expect.arrayContaining(['science_tech', 'science_tech/smartphone']));
    expect(ids({ title: 'I built a gaming PC for $800' })).toContain('science_tech/pc_hardware');
  });

  it('pets, travel, autos, finance, health, how-to', () => {
    expect(ids({ title: '아기 고양이 첫 목욕 브이로그' })).toContain('pets_animals/cats');
    expect(ids({ title: '오사카 여행 3박 4일 코스 총정리' })).toEqual(expect.arrayContaining(['travel', 'travel/overseas']));
    expect(ids({ title: '아이오닉 9 전기차 시승기' })).toEqual(expect.arrayContaining(['autos', 'autos/ev', 'autos/car_review']));
    expect(ids({ title: '미국주식 배당주 포트폴리오 공개' })).toEqual(expect.arrayContaining(['business_finance', 'business_finance/stocks']));
    expect(ids({ title: '10분 홈트 전신 운동 루틴' })).toEqual(expect.arrayContaining(['health_fitness', 'health_fitness/workout']));
    expect(ids({ title: '프로크리에이트 디지털 드로잉 기초' })).toEqual(expect.arrayContaining(['howto_diy', 'howto_diy/art']));
  });

  it('assigns multiple families when the video spans them (max 3)', () => {
    const r = classify({ title: '제주도 여행 브이로그 | 맛집 투어와 카페 추천', tags: ['여행', '맛집'] });
    const t = r.categories.filter((c) => !c.id.includes('/')).map((c) => c.id);
    expect(t).toEqual(expect.arrayContaining(['travel', 'food']));
    expect(t.length).toBeLessThanOrEqual(3);
  });

  it('returns empty results for empty or irrelevant input', () => {
    expect(classify({})).toEqual({ categories: [], topics: [] });
    expect(classify({ title: 'ㅋㅋㅋㅋ', description: '', tags: [] }).categories).toEqual([]);
  });
});

describe('classifyVideo: source and account signals', () => {
  it('maps Dailymotion channels with source confidence', () => {
    const c = get({ title: 'Journal de 20h', sourceCategory: 'dailymotion:news' }, 'news_politics')!;
    expect(c.by).toBe('source');
    expect(c.confidence).toBe(SOURCE_CONFIDENCE);
    expect(c.evidence).toEqual([{ field: 'sourceCategory', match: 'dailymotion:news' }]);
  });

  it('maps PeerTube categories case-insensitively', () => {
    expect(get({ sourceCategory: 'peertube:News & Politics' }, 'news_politics')?.by).toBe('source');
    expect(get({ sourceCategory: 'peertube:music' }, 'music')?.confidence).toBe(SOURCE_CONFIDENCE);
    expect(get({ sourceCategory: '  PeerTube:Science & Technology ' }, 'science_tech')?.by).toBe('source');
  });

  it('maps a source category pointing at a subcategory to the sub and its parent', () => {
    const r = classify({ sourceCategory: 'niconico:アニメ' });
    expect(r.categories.map((c) => c.id)).toEqual(['film_animation', 'film_animation/anime']);
    expect(r.categories.every((c) => c.by === 'source')).toBe(true);
  });

  it('gives broad catch-all source categories a lower confidence', () => {
    expect(get({ sourceCategory: 'youtube:24' }, 'entertainment')?.confidence).toBe(BROAD_SOURCE_CONFIDENCE);
    expect(get({ sourceCategory: 'youtube:category:24' }, 'entertainment')?.confidence).toBe(BROAD_SOURCE_CONFIDENCE);
    expect(get({ sourceCategory: 'youtube:10' }, 'music')?.confidence).toBe(SOURCE_CONFIDENCE);
    expect(get({ sourceCategory: 'peertube:People' }, 'lifestyle/vlog')?.confidence).toBe(BROAD_SOURCE_CONFIDENCE);
  });

  it('ignores unknown source categories and catch-all genres', () => {
    expect(classify({ sourceCategory: 'dailymotion:webcam' }).categories).toEqual([]);
    expect(classify({ sourceCategory: 'niconico:その他' }).categories).toEqual([]);
    expect(classify({ sourceCategory: 'mystery:thing' }).categories).toEqual([]);
  });

  it('treats YouTube channel seeds as account-level evidence', () => {
    const c = get({ title: '오늘의 일상', sourceCategory: 'youtube:seed:beauty' }, 'beauty')!;
    expect(c.by).toBe('account');
    expect(c.confidence).toBe(ACCOUNT_CONFIDENCE);
    expect(c.evidence).toEqual([{ field: 'sourceCategory', match: 'youtube:seed:beauty' }]);
  });

  it('accepts seeds that point at a subcategory', () => {
    const r = classify({ sourceCategory: 'youtube:seed:beauty/skincare' });
    expect(r.categories.map((c) => c.id)).toEqual(['beauty', 'beauty/skincare']);
  });

  it('uses the account seed category with account confidence', () => {
    const c = get({ title: 'vlog #12', accountSeedCategory: 'food' }, 'food')!;
    expect(c.by).toBe('account');
    expect(c.confidence).toBe(ACCOUNT_CONFIDENCE);
    expect(c.evidence).toEqual([{ field: 'account', match: 'food' }]);
    expect(get({ accountSeedCategory: ' Food ' }, 'food')?.by).toBe('account');
    expect(classify({ accountSeedCategory: 'not-a-category' }).categories).toEqual([]);
  });

  it('combines signals as a noisy-or and names the strongest contributor', () => {
    const rule = get({ title: '스킨케어 루틴' }, 'beauty')!.confidence;
    const both = get({ title: '스킨케어 루틴', accountSeedCategory: 'beauty' }, 'beauty')!;
    expect(both.confidence).toBeGreaterThan(rule);
    expect(both.confidence).toBeGreaterThan(ACCOUNT_CONFIDENCE);
    expect(both.confidence).toBeCloseTo(1 - (1 - rule) * (1 - ACCOUNT_CONFIDENCE), 1);
    expect(both.by).toBe('rule');
    expect(both.evidence).toEqual(expect.arrayContaining([{ field: 'account', match: 'beauty' }, { field: 'title', match: '스킨케어' }]));
  });

  it('caps confidence at 0.99', () => {
    const c = get(
      {
        title: '스킨케어 세럼 토너 선크림 skincare serum sunscreen スキンケア',
        tags: ['skincare', '스킨케어', 'serum'],
        sourceCategory: 'youtube:seed:beauty',
        accountSeedCategory: 'beauty',
      },
      'beauty',
    )!;
    expect(c.confidence).toBe(0.99);
  });
});

describe('classifyVideo: thresholds and limits', () => {
  it('a single description hit is not enough; two distinct ones are', () => {
    expect(ids({ title: '오늘의 영상', description: '선크림 이야기도 잠깐 나와요' })).toEqual([]);
    expect(ids({ title: '오늘의 영상', description: '선크림, 세럼 이야기도 잠깐 나와요' })).toContain('beauty/skincare');
  });

  it('a single tag or title hit is enough', () => {
    expect(ids({ title: 'untitled', tags: ['skincare'] })).toContain('beauty/skincare');
    expect(get({ title: 'untitled', tags: ['skincare'] }, 'beauty')!.confidence).toBeCloseTo(1 - Math.exp(-0.8), 2);
    expect(get({ title: '스킨케어' }, 'beauty')!.confidence).toBeCloseTo(1 - Math.exp(-1), 2);
  });

  it('drops evidence from signals that did not count', () => {
    const c = get({ title: '오늘의 영상', description: '선크림 이야기', accountSeedCategory: 'beauty' }, 'beauty')!;
    expect(c.by).toBe('account');
    expect(c.evidence).toEqual([{ field: 'account', match: 'beauty' }]);
  });

  it('keeps at most 3 top-level families and drops subcategories of the others', () => {
    const r = classify({
      title: '축구 먹방 게임 뉴스 여행 스킨케어 주식',
      tags: ['축구', '먹방', '게임', '뉴스'],
    });
    const topIds = r.categories.filter((c) => !c.id.includes('/')).map((c) => c.id);
    expect(topIds).toHaveLength(3);
    for (const c of r.categories) expect(topIds).toContain(c.id.split('/')[0]);
  });

  it('keeps at most 3 subcategories per family, each preceded by its parent', () => {
    const r = classify({ title: '축구 야구 농구 배구 골프 테니스 올림픽' });
    const subs = r.categories.filter((c) => c.id.startsWith('sports/'));
    expect(subs.length).toBeLessThanOrEqual(MAX_SUB_PER_TOP);
    const order = r.categories.map((c) => c.id);
    for (const s of subs) {
      expect(order.indexOf('sports')).toBeLessThan(order.indexOf(s.id));
      expect(get({ title: '축구 야구 농구 배구 골프 테니스 올림픽' }, 'sports')!.confidence).toBeGreaterThanOrEqual(s.confidence);
    }
  });

  it('is deterministic and sorted by confidence among families', () => {
    const a = classify({ title: '제주 여행 먹방 브이로그', accountSeedCategory: 'travel' });
    const b = classify({ title: '제주 여행 먹방 브이로그', accountSeedCategory: 'travel' });
    expect(a).toEqual(b);
    const t = a.categories.filter((c) => !c.id.includes('/'));
    for (let i = 1; i < t.length; i++) expect(t[i - 1].confidence).toBeGreaterThanOrEqual(t[i].confidence);
  });

  it('is fast (bigram index, linear in text length)', () => {
    const inp = input({
      title: '데일리 스킨케어 루틴 | 토너패드 추천 #스킨케어 #올리브영',
      description: '민감성 피부를 위한 세럼 추천 영상입니다. 제품 정보는 더보기란을 확인해주세요. morning routine with serum and sunscreen '.repeat(3),
      tags: ['skincare', '뷰티', 'korean skincare', 'k-beauty', 'routine'],
      sourceCategory: 'youtube:seed:beauty',
      accountSeedCategory: 'beauty',
    });
    const t0 = performance.now();
    for (let i = 0; i < 2000; i++) classifyVideo(inp);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

describe('classifyVideo: ASCII keywords match on word boundaries', () => {
  it("short keywords ('ai', 'mv', 'ev', 'cat', 'car', 'rap', 'gym', 'ted') do not match inside words", () => {
    expect(ids({ title: 'She said the rain in Thailand was great' })).not.toContain('science_tech/ai');
    expect(ids({ title: 'MVP of the season' })).not.toContain('music');
    expect(ids({ title: 'Every eve we eat' })).not.toContain('autos/ev');
    expect(ids({ title: 'Category tips' })).not.toContain('pets_animals/cats');
    expect(ids({ title: 'Card tricks and a scar' })).not.toContain('autos');
    expect(ids({ title: 'Trap door, rapid fire' })).not.toContain('music/hiphop');
    expect(ids({ title: 'Gymnastics world final' })).not.toContain('health_fitness/workout');
    expect(ids({ title: 'I started a garden' })).not.toContain('education/lecture');
  });

  it('short keywords match as whole words, also next to Hangul', () => {
    expect(ids({ title: 'AI가 그린 그림' })).toContain('science_tech/ai');
    expect(ids({ title: 'New MV out now' })).toContain('music');
    expect(ids({ title: 'EV 충전 꿀팁' })).toContain('autos/ev');
    expect(ids({ title: 'Funny cat compilation' })).toContain('pets_animals/cats');
    expect(ids({ title: 'F1 Monaco GP recap' })).toContain('autos/motorsport');
  });

  it('allows plurals and glued hashtags for long keywords', () => {
    expect(ids({ title: 'Best dogs of 2026' })).toContain('pets_animals/dogs');
    expect(ids({ title: 'My #skincareroutine' })).toContain('beauty/skincare');
    expect(ids({ title: '#minecraftbuilds tutorial' })).toContain('gaming/sandbox');
    // 4-char keyword must not glue: 'diet' in 'dietary' is fine to skip, 'game' in 'gameboy' not glued
    expect(ids({ title: 'gameboy' })).not.toContain('gaming');
  });

  it('respects English traps', () => {
    expect(ids({ title: 'Squid Game season 3 ending explained' })).not.toContain('gaming');
    expect(ids({ title: 'Olympic Games Paris highlights' })).not.toContain('gaming');
    expect(ids({ title: 'Olympic Games Paris highlights' })).toContain('sports/olympics');
    expect(ids({ title: 'Game of Thrones recap' })).not.toContain('gaming');
    expect(ids({ title: 'Doctor Who reaction' })).not.toContain('health_fitness/medical');
    expect(ids({ title: 'Best hot dog in NYC' })).not.toContain('pets_animals/dogs');
  });
});

describe('classifyVideo: Korean/Japanese false-positive traps', () => {
  const cases: [string, string][] = [
    ['LCK 토너먼트 결승전', 'beauty'],
    ['필요가 없는 물건 정리', 'health_fitness'],
    ['청소년 문제 심층 취재', 'lifestyle'],
    ['주식회사 설립 절차', 'business_finance'],
    ['썸네일 만드는 법', 'beauty'],
    ['문화재 복원 현장', 'news_politics'],
    ['출근길 러시아워 풍경', 'news_politics'],
    ['영화롭게 살아가는 법', 'film_animation'],
    ['시간여행 소설 추천', 'travel'],
    ['머신러닝 입문 강의', 'health_fitness'],
    ['의사결정 잘하는 방법', 'health_fitness'],
    ['그림자 연극 공연', 'howto_diy'],
    ['비가 세차게 내린 날', 'autos'],
    ['오징어 게임 시즌3 리뷰', 'gaming'],
    ['피의 게임 3 최종회', 'gaming'],
    ['아이돌봄 서비스 신청 방법', 'music'],
    ['유아인 근황', 'kids_family'],
    ['애니멀 플래닛 다큐', 'film_animation'],
    ['한우 마블링 등급', 'film_animation'],
    ['요리조리 피하는 법', 'food'],
    ['지하철 청소년 요금', 'lifestyle'],
    ['하울의 움직이는 성 OST', 'fashion'],
    ['염색체 이상 연구', 'beauty'],
    ['단발성 이벤트 안내', 'beauty'],
    ['シカゴ旅行', 'beauty'],
    ['名作リメイク版の感想', 'beauty'],
    ['ウイスキー飲み比べ', 'sports'],
    ['シリコンバレーの最新情報', 'sports'],
    ['ラジオ体操第一', 'entertainment'],
    ['ゲームコントローラーの修理', 'comedy'],
    ['정당한 요구였다', 'news_politics'],
    ['자취를 감춘 범인', 'lifestyle'],
    ['재테크 초보 가이드', 'science_tech'],
    ['식물성 단백질 추천', 'lifestyle'],
    ['동물의 숲 섬 꾸미기', 'pets_animals'],
    ['운동화 세탁하는 법', 'health_fitness'],
    ['영어 자막 있는 드라마', 'education'],
  ];
  for (const [title, notFamily] of cases) {
    it(`${title} -> not ${notFamily}`, () => {
      expect(tops({ title })).not.toContain(notFamily);
    });
  }

  it('still matches the real meaning next to a trap word', () => {
    expect(ids({ title: '토너먼트 끝나고 토너 추천' })).toContain('beauty/skincare');
    expect(ids({ title: '청소년도 쉽게 하는 대청소' })).toContain('lifestyle/cleaning');
    expect(ids({ title: '동물의 숲 하다가 동물원 다녀옴' })).toContain('pets_animals/wildlife');
    expect(ids({ title: '운동화 신고 운동 루틴' })).toContain('health_fitness/workout');
    expect(ids({ title: '아기 고양이 입양' })).not.toContain('kids_family/parenting');
  });

  it('Korean particles glued to keywords still match', () => {
    expect(ids({ title: '먹방을 찍어봤습니다' })).toContain('food/mukbang');
    expect(ids({ title: '스킨케어는 이렇게' })).toContain('beauty/skincare');
  });
});

/* ------------------------------------------------------------------------------------------ */

describe('topics', () => {
  it('extracts bracketed series names and strips generic ones', () => {
    expect(extractBracketTopics('[지금이뉴스] 속보 【MV】 [ENG SUB] [4K] [EP.12] 〖Live Clip〗')).toEqual(['지금이뉴스', 'mv', 'live clip']);
    expect(extractBracketTopics('［全角］ブラケット')).toEqual(['全角']);
    expect(extractBracketTopics('[1회] [2024.09.28] [제3화]')).toEqual([]);
    expect(extractBracketTopics('[MV/Teaser]')).toEqual(['mv', 'teaser']);
  });

  it('orders title brackets, title hashtags, tags, then description hashtags; max 10', () => {
    const t = extractTopics({
      title: '[슈퍼마켙] 오늘의 요리 #집밥 #shorts',
      description: '#레시피 #fyp #쇼츠',
      tags: ['Cooking', '#집밥', 'YouTube', ' 자취요리 '],
    });
    expect(t).toEqual(['슈퍼마켙', '집밥', 'cooking', '자취요리', '레시피']);
  });

  it('removes stop-topics in ko/en/ja', () => {
    for (const s of ['shorts', 'youtube', 'fyp', 'viral', 'video', '영상', '쇼츠', '동영상', 'おすすめ', '動画', 'trending']) {
      expect(STOP_TOPICS.has(s), s).toBe(true);
    }
    expect(extractTopics({ title: '#Shorts #FYP #viral #영상 #쇼츠 #youtubeshorts', description: null, tags: ['video', 'Viral'] })).toEqual([]);
  });

  it('caps topics at 10 and de-duplicates across sources', () => {
    const tags = Array.from({ length: 20 }, (_, i) => `tag${i}`);
    const t = extractTopics({ title: '#tag0 #tag1', description: null, tags });
    expect(t).toHaveLength(10);
    expect(new Set(t).size).toBe(10);
    expect(t[0]).toBe('tag0');
  });

  it('drops pure numbers and over-long tags', () => {
    expect(extractTopics({ title: '', description: null, tags: ['2024', '1', 'a'.repeat(41), 'ok tag'] })).toEqual(['ok tag']);
  });

  it('classifyVideo returns the same topics', () => {
    const inp = { title: '[지금이뉴스] #속보', description: '#정치', tags: ['국회'] };
    expect(classify(inp).topics).toEqual(extractTopics(inp));
  });
});

describe('findKeywords', () => {
  it('lists matched taxonomy keywords with their nodes', () => {
    const f = findKeywords('스킨케어 루틴과 런닝맨');
    expect(f).toContainEqual({ keyword: '스킨케어', nodeIds: ['beauty/skincare'] });
    expect(f.some((x) => x.keyword === '런닝맨')).toBe(true);
    expect(findKeywords('')).toEqual([]);
  });
});

describe('glued ASCII keywords', () => {
  it('only glue inside hashtags and tags, never in prose', () => {
    expect(ids({ title: 'Mechanical engineering explained' })).not.toContain('autos');
    expect(ids({ title: 'Protestant reformation history' })).not.toContain('news_politics');
    expect(ids({ title: 'untitled', tags: ['skincareroutine'] })).toContain('beauty/skincare');
    expect(ids({ title: 'skincareroutine' })).not.toContain('beauty/skincare');
  });
});
