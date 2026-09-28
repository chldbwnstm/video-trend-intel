import { describe, expect, it } from 'vitest';
import { SPONSORSHIP_VERSION, canonicalBrandName, detectSponsorship, knownBrands } from '../src/sponsorship.ts';

function detect(title: string, description: string | null = null, tags: string[] = []) {
  return detectSponsorship({ title, description, tags });
}

function level(title: string, description: string | null = null, tags: string[] = []) {
  return detect(title, description, tags)?.level ?? null;
}

describe('version and shape', () => {
  it('uses the sponsorship version', () => {
    expect(SPONSORSHIP_VERSION).toBe('sponsor-2026.09.1');
    const s = detect('[광고] 신제품 리뷰')!;
    expect(s.version).toBe(SPONSORSHIP_VERSION);
    expect(s.level).toBe('disclosed');
    expect(Array.isArray(s.brands)).toBe(true);
    expect(s.evidence.length).toBeGreaterThan(0);
  });

  it('returns null for ordinary videos', () => {
    expect(detect('오늘의 브이로그', '평범한 하루를 기록했어요.', ['vlog', '일상'])).toBeNull();
    expect(detect('My morning routine', 'Just a normal day.')).toBeNull();
    expect(detect('今日の晩ごはん', '簡単レシピです')).toBeNull();
    expect(detect('')).toBeNull();
  });
});

describe('Korean disclosures', () => {
  it.each([
    ['유료 광고 포함', '데일리 메이크업 (유료 광고 포함)', null],
    ['유료광고포함 (no spaces)', '데일리 메이크업 유료광고포함', null],
    ['유료광고', '[유료광고] 신상 립 리뷰', null],
    ['#광고', '신상 립 리뷰 #광고', null],
    ['광고 포함', '리뷰', '이 영상은 광고를 포함하고 있습니다.'],
    ['협찬', '리뷰', '본 영상은 제품을 협찬받아 제작되었습니다.'],
    ['#협찬', '리뷰 #협찬', null],
    ['제작 지원', '신작 소개', '제작 지원: 넥슨'],
    ['제작지원', '신작 소개', '제작지원 넥슨'],
    ['PPL bracket', '[PPL] 드라마 속 그 제품', null],
    ['PPL 포함', '브이로그', '이 영상은 PPL을 포함하고 있습니다'],
    ['브랜디드', '브랜디드 콘텐츠 | 여름 캠핑', null],
    ['원고료', '후기', '소정의 원고료를 지원받아 작성한 후기입니다'],
    ['제품 제공', '후기', '업체로부터 제품을 무상으로 제공받아 작성했습니다'],
    ['경제적 대가', '후기', '이 영상은 경제적 대가를 받고 제작되었습니다'],
  ])('%s', (_name, title, description) => {
    expect(level(title, description)).toBe('disclosed');
  });

  it('negations and non-disclosures are NOT disclosed', () => {
    expect(level('광고 없는 영상')).toBeNull();
    expect(level('솔직 후기', '협찬 아님 내돈내산')).toBeNull();
    expect(level('솔직 후기', '협찬아님')).toBeNull();
    expect(level('솔직 후기 #광고아님 #내돈내산')).toBeNull();
    expect(level('솔직 후기', '노협찬 무협찬 비협찬')).toBeNull();
    expect(level('솔직 후기', '협찬 X, 광고 X')).toBeNull();
    expect(level('솔직 후기', '협찬을 받지 않았습니다')).toBeNull();
    expect(level('솔직 후기', '제품을 제공받지 않았습니다')).toBeNull();
    expect(level('솔직 후기', '유료 광고 없음')).toBeNull();
    expect(level('솔직 후기', '협찬 받은 거 아님!')).toBeNull();
  });

  it('business inquiries and solicitations are NOT disclosures', () => {
    expect(level('오늘의 브이로그', '광고/협찬 문의: abc@gmail.com')).toBeNull();
    expect(level('오늘의 브이로그', '협찬 및 광고 문의는 이메일로 부탁드립니다')).toBeNull();
    expect(level('오늘의 브이로그', '협찬문의 abc@naver.com')).toBeNull();
    expect(level('오늘의 브이로그', '비즈니스·협찬 제안 환영합니다')).toBeNull();
    expect(level('오늘의 브이로그', '협찬 받습니다! DM 주세요')).toBeNull();
    expect(level('오늘의 브이로그', '협찬 : 문의 주세요')).toBeNull();
  });

  it('discussing sponsorship (news, controversies) is NOT a disclosure', () => {
    expect(level('유튜버 뒷광고 논란 총정리')).toBeNull();
    expect(level('PPL 논란 총정리', '드라마 PPL 모음')).toBeNull();
    expect(level('협찬 표기 의무화, 무엇이 달라지나')).toBeNull();
    expect(level('뉴스', '콘텐츠 제작 지원 사업 공모 시작')).toBeNull();
  });

  it('bare 광고 in a tag is a topic, not a disclosure; exact disclosure tags count', () => {
    expect(level('TV 광고 모음 2024', null, ['광고', 'CF'])).toBeNull();
    expect(level('화장품 리뷰', null, ['유료광고', 'beauty'])).toBe('disclosed');
    expect(detect('화장품 리뷰', null, ['유료 광고 포함'])!.evidence).toContainEqual({ field: 'tags', match: '유료광고포함' });
  });
});

describe('English disclosures', () => {
  it.each([
    ['#ad', 'New drop! #ad', null],
    ['#sponsored', 'Morning routine #sponsored', null],
    ['sponsored by', 'Morning routine', 'This video is sponsored by NordVPN.'],
    ['paid partnership', 'GRWM', 'Paid partnership with Sephora'],
    ['includes paid promotion', 'Review', 'Includes paid promotion'],
    ['in partnership with', 'Cooking', 'Made in partnership with HelloFresh'],
    ['for sponsoring', 'Vlog', 'Thanks to Squarespace for sponsoring this video!'],
    ["today's sponsor", 'Vlog', "Today's sponsor is Skillshare"],
    ['brought to you by', 'Vlog', 'This episode is brought to you by Audible'],
    ['[AD]', '[AD] My new favourite shoes', null],
    ['#gifted', 'Haul #gifted', null],
  ])('%s', (_name, title, description) => {
    expect(level(title, description)).toBe('disclosed');
  });

  it('negations are NOT disclosed', () => {
    expect(level('Tech review', 'This video is not sponsored. I bought it myself.')).toBeNull();
    expect(level('Tech review', 'Not sponsored by anyone')).toBeNull();
    expect(level('Tech review #notsponsored #notanad')).toBeNull();
    expect(level('Tech review', 'This is a non-sponsored video, not a paid partnership.')).toBeNull();
    expect(level('Tech review', 'For sponsorship inquiries: me@example.com')).toBeNull();
  });

  it('#pr is only a disclosure in Japanese/Korean context (not a personal record)', () => {
    expect(level('Leg day #pr #deadlift', 'New PR today!')).toBeNull();
    expect(level('#PR 資生堂の新作')).toBe('disclosed');
  });

  it('does not treat hashtags that merely start with ad as #ad', () => {
    expect(level('Unboxing #adidas #adventure')).toBeNull();
  });
});

describe('Japanese disclosures', () => {
  it.each([
    ['【PR】', '【PR】新作コスメレビュー', null],
    ['#PR', '新作レビュー #PR', null],
    ['PR動画', '新作レビュー', 'この動画はPR動画です'],
    ['プロモーションを含みます', 'レビュー', '有料プロモーションを含みます'],
    ['提供', 'レビュー', 'ユニクロ様より商品をご提供いただきました'],
    ['提供：', '提供：サントリー', null],
    ['タイアップ', 'サントリーとのタイアップ企画', null],
    ['企業案件', '企業案件です！新作ゲーム紹介', null],
  ])('%s', (_name, title, description) => {
    expect(level(title, description)).toBe('disclosed');
  });

  it('credits, requests and negations are NOT disclosed', () => {
    expect(level('映像提供：視聴者', '情報提供をお願いします')).toBeNull();
    expect(level('ニュース', '写真提供＝共同通信')).toBeNull();
    expect(level('案件ではありません！自腹レビュー')).toBeNull();
    expect(level('アニメ主題歌タイアップ曲 フル')).toBeNull();
    expect(level('プロモーションビデオ公開')).toBeNull();
  });
});

describe('likely (promo cues without disclosure)', () => {
  it.each([
    ['할인코드', '추천템', '할인코드 ROMAND10 입력하면 10% 할인!'],
    ['쿠폰 코드', '추천템', '쿠폰 코드: SUMMER'],
    ['공동구매', '공동구매 오픈!', null],
    ['#공구', '신상 소개 #공구', null],
    ['쿠팡 파트너스', '추천템', '이 포스팅은 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.'],
    ['link.coupang.com', '추천템', '제품 정보 https://link.coupang.com/a/bXyZ12'],
    ['coupa.ng', '추천템', 'https://coupa.ng/abc'],
    ['amzn.to', 'Desk setup', 'Gear: https://amzn.to/3xYz'],
    ['amazon tag', 'Desk setup', 'https://www.amazon.com/dp/B0000?tag=myshop-20'],
    ['smartstore', '추천템', 'https://smartstore.naver.com/mystore/products/123'],
    ['use code', 'Morning routine', 'Use code ANNA for 15% off'],
    ['discount code', 'Morning routine', 'Discount code: ANNA15'],
    ['affiliate links', 'Desk setup', 'Some of the links below are affiliate links.'],
    ['amazon associate', 'Desk setup', 'As an Amazon Associate I earn from qualifying purchases.'],
    ['クーポンコード', 'おすすめ', 'クーポンコード「ABC」で10%オフ'],
  ])('%s', (_name, title, description) => {
    const s = detect(title, description)!;
    expect(s).not.toBeNull();
    expect(s.level).toBe('likely');
    expect(s.evidence.length).toBeGreaterThan(0);
  });

  it('affiliate networks are not reported as sponsoring brands', () => {
    const s = detect('추천템', '쿠팡 파트너스 활동의 일환으로 수수료를 제공받습니다\nhttps://link.coupang.com/a/abc')!;
    expect(s.level).toBe('likely');
    expect(s.brands).toEqual([]);
    const a = detect('Desk setup', 'As an Amazon Associate I earn from qualifying purchases. https://amzn.to/x')!;
    expect(a.brands).toEqual([]);
    expect(detect('추천템', 'https://smartstore.naver.com/mystore/products/123')!.brands).toEqual([]);
    expect(detect('추천템', 'https://s.click.aliexpress.com/e/_abc')!.brands).toEqual([]);
  });

  it('a weak shopping cue needs a known brand nearby or in the title', () => {
    expect(level('신발 리뷰', '구매 링크는 아래에')).toBeNull();
    const s = detect('나이키 에어포스 리뷰', '구매 링크는 아래에')!;
    expect(s.level).toBe('likely');
    expect(s.brands).toEqual(['Nike']);
    expect(level('솔직 후기', '올리브영 구매처 정리')).toBe('likely');
  });

  it('an explicit "not sponsored" claim suppresses weak cues', () => {
    expect(level('나이키 에어포스 리뷰', '내돈내산! 구매 링크는 아래에')).toBeNull();
  });

  it('disclosure wins over promo cues', () => {
    const s = detect('데일리 메이크업 (유료광고 포함)', '롬앤 신상 틴트 써봤어요\n할인코드: ROM10')!;
    expect(s.level).toBe('disclosed');
    expect(s.brands).toEqual(['롬앤']);
    expect(s.evidence.map((e) => e.match)).toEqual(expect.arrayContaining(['유료 광고 포함', '할인코드', '롬앤']));
  });
});

describe('brand extraction', () => {
  it("captures 'sponsored by X' including brands outside the curated list", () => {
    expect(detect('Vlog', 'This video is sponsored by NordVPN. Use code X.')!.brands).toEqual(['NordVPN']);
    expect(detect('Vlog', 'Sponsored by Acme Rockets, check them out')!.brands).toEqual(['Acme Rockets']);
    expect(detect('Vlog', 'sponsored by our friends at Surfshark')!.brands).toEqual(['Surfshark']);
    expect(detect('Vlog', 'Thanks to Squarespace for sponsoring this video.')!.brands).toEqual(['Squarespace']);
  });

  it("captures 'in partnership with' and @mentions near a disclosure", () => {
    const s = detect('Cooking with friends', 'In partnership with @hellofresh_kr and @myfriend')!;
    expect(s.brands[0]).toBe('HelloFresh');
    expect(s.brands).toContain('@myfriend');
    expect(s.evidence).toContainEqual({ field: 'description', match: '@hellofresh_kr' });
  });

  it("captures Korean patterns: 'X로부터 협찬', 'X 제작지원', '협찬: X'", () => {
    expect(detect('[광고] 갤럭시 S25 울트라 한 달 사용기', '본 영상은 삼성전자로부터 제품을 협찬받아 제작되었습니다.')!.brands).toEqual(['삼성']);
    expect(detect('신작 소개', '제작 지원: 넥슨')!.brands).toEqual(['넥슨']);
    expect(detect('브이로그', '의상 협찬: 무신사\n장소 협찬 : 카페 어니언')!.brands).toEqual(['무신사', '카페 어니언']);
    expect(detect('리뷰', '에이비씨코스메틱으로부터 제품을 협찬받았습니다')!.brands).toEqual(['에이비씨코스메틱']);
  });

  it('does not turn product nouns or negated captures into brands', () => {
    const s = detect('노트북 리뷰', '노트북 협찬 받아 리뷰합니다')!;
    expect(s.level).toBe('disclosed');
    expect(s.brands).toEqual([]);
    expect(detect('브이로그', '협찬: 없음')).toBeNull();
    expect(detect('리뷰', '제품 협찬을 받았습니다')!.brands).toEqual([]);
  });

  it('captures Japanese giver patterns', () => {
    expect(detect('【PR】新作コスメレビュー', 'ユニクロ様より商品をご提供いただきました')!.brands).toEqual(['Uniqlo']);
    expect(detect('提供：サントリー')!.brands).toEqual(['Suntory']);
    expect(detect('新作紹介', 'ロート製薬様より商品をご提供いただきました')!.brands).toEqual(['ロート製薬']);
    expect(detect('新作紹介', '本日はロート製薬様より商品をご提供いただきました')!.brands).toEqual(['ロート製薬']);
  });

  it('matches curated brands only next to a cue (or in the title/tags when disclosed)', () => {
    // brand mentioned, no cue: nothing
    expect(detect('나이키 vs 아디다스 비교', '둘 다 제 돈으로 샀어요')).toBeNull();
    // disclosed: title brand counts
    expect(detect('[광고] 나이키 신상 러닝화 리뷰')!.brands).toEqual(['Nike']);
    // disclosed: tag brand counts
    expect(detect('신상 리뷰 #광고', null, ['nike', 'running'])!.brands).toEqual(['Nike']);
    // brand far away from a description cue (not in window) is ignored
    const far = detect('브이로그', `스타벅스 다녀왔어요.${' 오늘 날씨가 좋았다.'.repeat(10)}\n할인코드 ABC`)!;
    expect(far.level).toBe('likely');
    expect(far.brands).toEqual([]);
  });

  it('prefers the longest alias and canonicalizes names', () => {
    expect(detect('[광고] 쿠팡플레이 신작 소개')!.brands).toEqual(['쿠팡플레이']);
    expect(detect('#ad', 'Sponsored by Samsung Electronics')!.brands).toEqual(['삼성']);
    expect(canonicalBrandName('samsung')).toBe('삼성');
    expect(canonicalBrandName('OLIVE YOUNG')).toBe('올리브영');
    expect(canonicalBrandName('unknown brand')).toBeNull();
  });

  it('avoids brand false positives inside other words', () => {
    const s = detect('애플망고 빙수 먹방 #광고', '망고 협찬')!;
    expect(s.level).toBe('disclosed');
    expect(s.brands).not.toContain('Apple');
    expect(detect('#광고 토스트 맛집')!.brands).not.toContain('토스');
    expect(detect('#ad pineapple smoothie')!.brands).not.toContain('Apple');
  });

  it('has a curated list of about 150+ brands', () => {
    const b = knownBrands();
    expect(b.length).toBeGreaterThanOrEqual(150);
    for (const n of ['삼성', 'LG', '현대자동차', '기아', '쿠팡', '배달의민족', '올리브영', '무신사', '아모레퍼시픽', '설화수', '이니스프리', '농심', 'CJ', '오뚜기', '넥슨', '넷마블', '엔씨소프트', '스마일게이트', '크래프톤', 'Nike', 'Adidas', 'Apple', 'Google', 'Netflix', 'Coca-Cola', "McDonald's", 'Uniqlo']) {
      expect(b, n).toContain(n);
    }
  });

  it('caps brands at 10', () => {
    const desc = '#광고 ' + ['나이키', '아디다스', '뉴발란스', '유니클로', '샤넬', '디올', '구찌', '프라다', '롤렉스', '무신사', '크록스', '휠라'].join(' ');
    expect(detect('하울', desc)!.brands.length).toBe(10);
  });
});

describe('evidence', () => {
  it('records the field and matched cue', () => {
    const s = detect('[광고] 리뷰', '할인코드 ABC', ['유료광고'])!;
    expect(s.evidence).toContainEqual({ field: 'title', match: '[광고]' });
    expect(s.evidence).toContainEqual({ field: 'tags', match: '유료광고' });
    expect(s.evidence).toContainEqual({ field: 'description', match: '할인코드' });
  });

  it('handles full-width and zero-width characters', () => {
    const zw = String.fromCharCode(0x200b);
    expect(level('＃광고 신상 리뷰')).toBe('disclosed');
    expect(level(`유료${zw}광고 포함`)).toBe('disclosed');
    expect(level('ＳＰＯＮＳＯＲＥＤ ＢＹ Ｘｙｚ')).toBe('disclosed');
  });

  it('is fast enough for bulk classification', () => {
    const d = '본 영상은 삼성전자로부터 제품을 협찬받아 제작되었습니다. 할인코드 ABC\nhttps://link.coupang.com/a/x #광고 @samsungkorea\n'.repeat(3);
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) detect('[광고] 갤럭시 S25 울트라 리뷰', d, ['galaxy', 'samsung']);
    expect(performance.now() - t0).toBeLessThan(3000);
  });
});
