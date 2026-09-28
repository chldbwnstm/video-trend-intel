/**
 * DealMaker-lite: paid-promotion disclosure + brand detection. OWNER: core-taxonomy agent.
 *
 * Levels
 * - 'disclosed': explicit paid-promotion disclosure text (ko: 유료 광고 포함 / #광고 / 협찬 / 제작 지원 / PPL /
 *   브랜디드, en: #ad / sponsored by / paid partnership / in partnership with, ja: #PR / 提供 / タイアップ / 案件).
 * - 'likely': promo cues without a disclosure — discount/promo codes, group buys, affiliate programs and
 *   affiliate links (link.coupang.com, amzn.to, smartstore.naver.com ...), or a weak shopping cue ('구매 링크')
 *   next to a known brand.
 *
 * Negated or solicitation phrases never count: '협찬 아님', '#광고아님', '광고/협찬 문의', 'not sponsored',
 * '案件ではありません'. Brand names only count next to a cue (or anywhere in the title/tags when the video is
 * disclosed), except names captured by explicit patterns ('sponsored by X', 'X 협찬', '제작 지원: X').
 */
import type { Evidence, SponsorshipSignal } from './types.ts';
import { INVISIBLE_RE, normalizeText } from './text.ts';

export const SPONSORSHIP_VERSION = 'sponsor-2026.09.1';

type Field = 'title' | 'description' | 'tags';
type CueKind = 'disclosure' | 'promo' | 'weak';

interface CueRule {
  kind: CueKind;
  /** Canonical evidence label; `null` = use the matched text. */
  label: string | null;
  re: RegExp;
  /** Skip the negation check (e.g. URLs). */
  noNegation?: boolean;
}

interface Cue {
  kind: CueKind;
  field: Field;
  index: number;
  end: number;
  label: string;
}

const MAX_BRANDS = 10;
const MAX_EVIDENCE = 16;
/** Characters around a cue in which brand names count. */
const BRAND_WINDOW = 80;

/* ------------------------------------------------------------------------------------------
 * Cue rules (applied to NFKC text, case-insensitive)
 * ---------------------------------------------------------------------------------------- */

const r = (src: string) => new RegExp(src, 'giu');

/** '映像提供', '情報を提供', '写真の提供' are credits/requests, not sponsorship. */
const JA_NOT_SPONSOR_LB = '(?<!(?:映像|画像|写真|情報|データ|素材|楽曲|音源|動画|番組|資料)(?:を|の)?)';

const CUE_RULES: CueRule[] = [
  // ---- Korean disclosures
  { kind: 'disclosure', label: '유료 광고 포함', re: r('유료\\s*광고\\s*(?:를|가)?\\s*포함') },
  { kind: 'disclosure', label: '유료 광고', re: r('유료\\s*광고(?!\\s*(?:를|가)?\\s*포함)') },
  { kind: 'disclosure', label: '광고 포함', re: r('(?<!유료\\s?)(?<!뒷)광고\\s*(?:를|가|가\\s*일부)?\\s*포함') },
  { kind: 'disclosure', label: '광고입니다', re: r('(?<!뒷)광고\\s*(?:영상)?\\s*입니다') },
  { kind: 'disclosure', label: '협찬', re: r('(?<!뒷)협찬') },
  { kind: 'disclosure', label: '제작 지원', re: r('제작\\s*지원') },
  { kind: 'disclosure', label: 'PPL', re: r('(?:[#\\[(【<]\\s*ppl(?![a-z])|(?<![a-z])ppl\\s*(?:을|를|이|가)?\\s*(?:포함|광고|이\\s*포함)|포함된\\s*ppl(?![a-z]))') },
  { kind: 'disclosure', label: '브랜디드 콘텐츠', re: r('브랜디드\\s*(?:콘텐츠|컨텐츠|광고|영상|필름|웹툰)|branded\\s+content') },
  { kind: 'disclosure', label: '원고료', re: r('(?:소정의\\s*)?원고료') },
  { kind: 'disclosure', label: '제품 제공', re: r('(?:제품|상품|서비스|물품|제품만)\\s*(?:을|를)?\\s*(?:무상\\s*(?:으로)?\\s*)?(?:제공|지원)\\s*받') },
  { kind: 'disclosure', label: '무상 제공', re: r('무상\\s*(?:으로)?\\s*(?:제공|지원)') },
  { kind: 'disclosure', label: '지원받아 제작', re: r('(?:제공|지원|후원)\\s*(?:을|를)?\\s*받아\\s*(?:제작|촬영|작성)') },
  { kind: 'disclosure', label: '경제적 대가', re: r('경제적\\s*(?:대가|이해\\s*관계)') },
  { kind: 'disclosure', label: '후원사', re: r('후원사') },
  // ---- English disclosures
  { kind: 'disclosure', label: 'sponsored by', re: r('\\bsponsored\\s+by\\b') },
  { kind: 'disclosure', label: 'sponsored', re: r('\\bthis\\s+(?:video|episode|content|stream|post)\\s+(?:is|was)\\s+(?:proudly\\s+)?sponsored\\b') },
  { kind: 'disclosure', label: 'sponsor', re: r("\\b(?:for\\s+sponsoring|sponsor\\s+of\\s+(?:this|today'?s)\\s+(?:video|episode)|today'?s\\s+sponsor)\\b") },
  { kind: 'disclosure', label: 'paid partnership', re: r('\\bpaid\\s+(?:partnership|sponsorship|collaboration)\\b') },
  { kind: 'disclosure', label: 'includes paid promotion', re: r('\\b(?:includes?\\s+)?paid\\s+promotion\\b') },
  { kind: 'disclosure', label: 'in partnership with', re: r('\\bin\\s+partnership\\s+with\\b') },
  { kind: 'disclosure', label: 'brought to you by', re: r('\\bbrought\\s+to\\s+you\\s+by\\b') },
  { kind: 'disclosure', label: 'sponsored content', re: r('\\b(?:sponsored|branded)\\s+(?:video|content|post|segment)\\b') },
  { kind: 'disclosure', label: 'advertisement', re: r('\\bcontains?\\s+(?:paid\\s+)?(?:advertising|advertisement)\\b') },
  // ---- bracketed markers: [광고] (AD) 【PR】 [협찬] <제작지원>
  {
    kind: 'disclosure',
    label: null,
    re: r('[\\[(【<〈「]\\s*(?:유료\\s*광고|광고|협찬|제작\\s*지원|ppl|ad|ads|sponsored|advertisement|pr|広告|提供|タイアップ|プロモーション)\\s*[\\])】>〉」]'),
  },
  // ---- Japanese disclosures
  { kind: 'disclosure', label: 'PR', re: r('(?:※\\s*pr(?![a-z])|(?<![a-z])pr(?:動画|案件|を含み|含む|です))') },
  { kind: 'disclosure', label: 'プロモーション', re: r('(?:有料)?プロモーションを含み') },
  {
    kind: 'disclosure',
    label: '提供',
    re: r(
      '(?:商品|製品|サービス|アイテム)(?:を|の)?(?:ご)?提供(?!元)|の提供で(?:お送り|お届け)|' +
        `${JA_NOT_SPONSOR_LB}(?:ご)?提供(?:\\s*[:：]|いただ|頂|を受け|して(?:いただ|頂|もら))`,
    ),
  },
  { kind: 'disclosure', label: 'タイアップ', re: r('タイアップ(?!曲|ソング|楽曲)') },
  { kind: 'disclosure', label: '案件', re: r('(?:企業|pr|ご)案件|案件\\s*(?:動画|です|をいただ|いただ|頂)') },
  { kind: 'disclosure', label: 'スポンサード', re: r('スポンサード') },
  { kind: 'disclosure', label: '広告を含みます', re: r('広告\\s*(?:を含み|です|案件)') },

  // ---- promo cues (likely)
  { kind: 'promo', label: '할인코드', re: r('할인\\s*코드|쿠폰\\s*코드|할인\\s*쿠폰|쿠폰\\s*링크|프로모션\\s*코드|프로모\\s*코드|추천인\\s*코드') },
  { kind: 'promo', label: '공동구매', re: r('공동\\s*구매|공구\\s*(?:오픈|진행|링크|가|마감|일정|시작|중)') },
  { kind: 'promo', label: '쿠팡 파트너스', re: r('쿠팡\\s*파트너스') },
  { kind: 'promo', label: '제휴 수수료', re: r('수수료\\s*(?:를|을)?\\s*(?:제공\\s*)?받|일정액의\\s*수수료|파트너스\\s*활동|제휴\\s*(?:링크|마케팅)|어필리에이트') },
  { kind: 'promo', label: '최저가 링크', re: r('(?:최저가|특가)\\s*링크') },
  { kind: 'promo', label: 'use code', re: r('\\buse\\s+(?:my\\s+|our\\s+|the\\s+)?code\\b') },
  { kind: 'promo', label: 'promo code', re: r('\\b(?:promo|discount|coupon|referral|creator)\\s+code\\b') },
  { kind: 'promo', label: 'affiliate link', re: r('\\baffiliate\\s+(?:links?|program|commission)\\b') },
  { kind: 'promo', label: 'amazon associate', re: r('\\bamazon\\s+associates?\\b|\\bqualifying\\s+purchases\\b') },
  { kind: 'promo', label: 'commission', re: r('\\b(?:earn|receive|get|make)\\s+(?:a\\s+)?(?:small\\s+)?commission\\b') },
  { kind: 'promo', label: 'クーポンコード', re: r('クーポンコード|割引コード|プロモコード|紹介コード|アフィリエイト|アソシエイト') },
  {
    kind: 'promo',
    label: null,
    noNegation: true,
    re: r(
      '(?:link\\.coupang\\.com|coupa\\.ng|amzn\\.to|amzn\\.asia|smartstore\\.naver\\.com|brand\\.naver\\.com|s\\.click\\.aliexpress\\.com|' +
        'a\\.aliexpress\\.com|hb\\.afl\\.rakuten\\.co\\.jp|a\\.r10\\.to|af\\.moshimo\\.com|px\\.a8\\.net|ck\\.jp\\.ap\\.valuecommerce\\.com|' +
        'shope\\.ee|temu\\.to|amazon\\.(?:com|co\\.jp|co\\.uk|de|fr|ca|in)/\\S*[?&]tag=)',
    ),
  },

  // ---- weak shopping cues: only count next to a known brand
  { kind: 'weak', label: '구매 링크', re: r('(?:구매|구입|제품|상품)\\s*링크|구매처') },
  { kind: 'weak', label: 'shop link', re: r('\\bshop\\s+(?:now|here|the\\s+look|my\\s+\\w+)\\b|\\blinks?\\s+to\\s+buy\\b|\\bget\\s+yours\\b') },
  { kind: 'weak', label: '購入リンク', re: r('購入はこちら|商品リンク|購入リンク') },
];

/** Hashtags (compact, lowercase) that are explicit disclosures. */
const DISCLOSURE_HASHTAGS = new Set([
  '광고', '유료광고', '유료광고포함', '광고포함', '협찬', '제작지원', 'ppl', '브랜디드', '브랜디드콘텐츠', '광고협찬',
  'ad', 'ads', 'sponsored', 'sponsor', 'spon', 'paidpartnership', 'paidpromotion', 'gifted', 'advertisement', 'brandedcontent',
  'pr', 'pr案件', '企業案件', '案件', '提供', 'タイアップ', 'プロモーション', '広告',
]);
/** Hashtags that are promo cues. */
const PROMO_HASHTAGS = new Set(['공구', '공동구매', '할인코드', '쿠폰', 'affiliate', 'promocode', 'discountcode', 'クーポン']);
/** Explicit "not sponsored" claims (hashtags or phrases): suppress weak brand-only cues. */
const NEGATIVE_CLAIM_RE = r(
  '#?(?:광고\\s*아님|협찬\\s*아님|내돈내산|내\\s*돈\\s*주고\\s*산|노\\s*협찬|무\\s*협찬|비\\s*협찬|not\\s*sponsored|notsponsored|not\\s+an\\s+ad|notanad|no\\s+sponsors?|自腹|案件ではありません|案件じゃ(?:ない|ありません))',
);
/** Tags (normalized, spaces removed) that are explicit disclosures. */
const DISCLOSURE_TAGS = new Set([
  '유료광고', '유료광고포함', '광고포함', '협찬', '제작지원', 'ppl', '브랜디드콘텐츠', 'sponsored', 'paidpartnership', 'includespaidpromotion',
  'paidpromotion', 'pr案件', '企業案件', 'タイアップ', 'プロモーション',
]);

/* ------------------------------------------------------------------------------------------
 * Negation
 * ---------------------------------------------------------------------------------------- */

/** Text right after a disclosure keyword that turns it into a negation, a solicitation or a meta discussion. */
const NEG_AFTER = new RegExp(
  '^\\s*[:：]?\\s*(?:(?:및|과|와|/|·|ㆍ|,|&|\\+)\\s*(?:광고|협찬|제휴|비즈니스|마케팅|pr|ppl|제작\\s*지원)\\s*)*' +
    '(?:은|는|이|가|을|를|도|로)?\\s*' +
    '(?:(?:받은|받는)\\s*(?:거|게|것)\\s*(?:은|는|이|가)?\\s*(?:아님|아니|없)|(?:전혀|절대|일절)\\s*(?:안|없|아니|아님|받지)|' +
    '받지\\s*않|받지않|안\\s*받|하지\\s*않|지\\s*않|지않|' +
    '아님|아닙|아니|없|x(?![a-z])|❌|✖|×|🙅|문의|제안|요청|환영|연락|구함|구합|원해|원합|받습니다|받아요|대환영|메일|이메일|' +
    'e-?mail|dm(?![a-z])|논란|의혹|숨기|숨긴|표기\\s*(?:의무|규정|법)|표시\\s*(?:의무|규정|법)|규정|가이드|이란|란\\s*무엇|' +
    '사업|공모|신청|모집|' +
    'inquir|enquir|opportunit|contact|request|wanted|welcome|is\\s+not|isn\'?t|was\\s+not|wasn\'?t|no\\s*one|nobody|none|anyone|' +
    'では(?:あり|ない|な)|じゃ(?:ない|あり)|ではございません|なし|無し|募集)',
  'iu',
);
/** Text right before a disclosure keyword that negates it: 노협찬, 무협찬, 비협찬, not sponsored, non-sponsored. */
const NEG_BEFORE = new RegExp("(?:(?:^|[^가-힣])(?:노|무|비|안|非)\\s*|\\b(?:not|non|no|never|un)\\s*-?\\s*(?:a\\s+|an\\s+|being\\s+)?|n't\\s+(?:a\\s+|an\\s+|being\\s+)?)$", 'iu');

function negatedBefore(text: string, index: number): boolean {
  return NEG_BEFORE.test(text.slice(Math.max(0, index - 12), index));
}

function isNegated(text: string, index: number, end: number): boolean {
  if (negatedBefore(text, index)) return true;
  return NEG_AFTER.test(text.slice(end, end + 40));
}

/**
 * Affiliate-program phrases and shop/affiliate links: the network or marketplace (Coupang, Amazon, Naver
 * smartstore, AliExpress ...) is not the sponsoring brand.
 */
const AFFILIATE_MASK_RE = r(
  '쿠팡\\s*파트너스|amazon\\s*associates?|amazon\\s*アソシエイト|アマゾン\\s*アソシエイト|楽天\\s*アフィリエイト|' +
    '(?:https?://)?(?:[a-z0-9-]+\\.)*(?:coupang\\.com|coupa\\.ng|amzn\\.to|amzn\\.asia|a\\.r10\\.to|rakuten\\.co\\.jp|amazon\\.[a-z.]{2,6}|' +
    'naver\\.com|aliexpress\\.com|temu\\.to|shope\\.ee|moshimo\\.com|a8\\.net|valuecommerce\\.com)\\S*',
);

function maskAffiliate(s: string): string {
  AFFILIATE_MASK_RE.lastIndex = 0;
  return s.replace(AFFILIATE_MASK_RE, (m) => ' '.repeat(m.length));
}

/* ------------------------------------------------------------------------------------------
 * Brands (curated)
 * ---------------------------------------------------------------------------------------- */

/** Canonical brand name followed by aliases (matched case-insensitively; ASCII on word boundaries). */
const BRAND_LIST: string[][] = [
  // Korean conglomerates, platforms, retail
  ['삼성', '삼성전자', 'samsung', 'samsung electronics', 'サムスン', '갤럭시', 'galaxy s', 'galaxy z', 'galaxy buds', 'galaxy watch'],
  ['LG', 'lg', 'lg전자', '엘지', 'lg electronics'],
  ['현대자동차', '현대자동차', '현대차', 'hyundai'],
  ['기아', '기아자동차', '기아차', 'kia'],
  ['제네시스', '제네시스', 'genesis motor'],
  ['SK텔레콤', 'sk텔레콤', 'skt', 'sk telecom'],
  ['KT', 'kt'],
  ['LG유플러스', 'lg유플러스', 'lg u+'],
  ['쿠팡', '쿠팡', 'coupang'],
  ['쿠팡플레이', '쿠팡플레이', 'coupang play'],
  ['배달의민족', '배달의민족', '배민', 'baemin'],
  ['요기요', '요기요', 'yogiyo'],
  ['올리브영', '올리브영', 'olive young', 'oliveyoung'],
  ['무신사', '무신사', 'musinsa'],
  ['29CM', '29cm'],
  ['지그재그', '지그재그', 'zigzag'],
  ['에이블리', '에이블리', 'ably'],
  ['마켓컬리', '마켓컬리', 'kurly', 'market kurly'],
  ['11번가', '11번가', '11st'],
  ['G마켓', 'g마켓', 'gmarket'],
  ['이마트', '이마트', 'emart'],
  ['홈플러스', '홈플러스', 'homeplus'],
  ['다이소', '다이소', 'daiso', 'ダイソー'],
  ['당근마켓', '당근마켓', 'karrot'],
  ['네이버', '네이버', 'naver'],
  ['카카오', '카카오', 'kakao'],
  ['카카오뱅크', '카카오뱅크', 'kakaobank', 'kakao bank'],
  ['토스', '토스', 'toss'],
  ['KB국민은행', 'kb국민은행', 'kb국민카드', 'kb국민'],
  ['신한', '신한카드', '신한은행', 'shinhan'],
  ['하나은행', '하나은행', 'hana bank'],
  ['우리은행', '우리은행', 'woori bank'],
  ['삼성카드', '삼성카드', 'samsung card'],
  ['현대카드', '현대카드', 'hyundai card'],
  ['야놀자', '야놀자', 'yanolja'],
  ['마이리얼트립', '마이리얼트립', 'myrealtrip'],
  ['대한항공', '대한항공', 'korean air'],
  ['아시아나항공', '아시아나항공', '아시아나', 'asiana'],
  ['제주항공', '제주항공', 'jeju air'],
  // Korean beauty
  ['아모레퍼시픽', '아모레퍼시픽', 'amorepacific'],
  ['설화수', '설화수', 'sulwhasoo'],
  ['이니스프리', '이니스프리', 'innisfree'],
  ['라네즈', '라네즈', 'laneige'],
  ['헤라', '헤라', 'hera beauty'],
  ['에뛰드', '에뛰드', '에뛰드하우스', 'etude house', 'etude'],
  ['미샤', '미샤', 'missha'],
  ['닥터자르트', '닥터자르트', 'dr.jart', 'dr. jart'],
  ['코스알엑스', '코스알엑스', 'cosrx'],
  ['토리든', '토리든', 'torriden'],
  ['롬앤', '롬앤', 'rom&nd', 'romand'],
  ['클리오', '클리오', 'clio cosmetics'],
  ['3CE', '3ce'],
  ['메디힐', '메디힐', 'mediheal'],
  ['아누아', '아누아', 'anua'],
  ['라운드랩', '라운드랩', 'round lab'],
  ['마녀공장', '마녀공장', 'manyo'],
  ['에스트라', '에스트라', 'aestura'],
  ['달바', '달바', "d'alba"],
  ['조선미녀', '조선미녀', 'beauty of joseon'],
  ['스킨1004', '스킨1004', 'skin1004'],
  ['넘버즈인', '넘버즈인', 'numbuzin'],
  ['더페이스샵', '더페이스샵', 'the face shop'],
  ['네이처리퍼블릭', '네이처리퍼블릭', 'nature republic'],
  ['바닐라코', '바닐라코', 'banila co'],
  ['페리페라', '페리페라', 'peripera'],
  ['닥터지', '닥터지', 'dr.g'],
  ['LG생활건강', 'lg생활건강'],
  // Korean food & beverage
  ['농심', '농심', 'nongshim', '신라면', '짜파게티'],
  ['오뚜기', '오뚜기', 'ottogi', '진라면'],
  ['삼양식품', '삼양식품', '삼양라면', 'samyang', '불닭볶음면', 'buldak'],
  ['CJ제일제당', 'cj제일제당', 'cj cheiljedang'],
  ['비비고', '비비고', 'bibigo'],
  ['CJ', 'cj', 'cj enm', '씨제이'],
  ['롯데', '롯데', 'lotte'],
  ['해태', '해태제과', '해태'],
  ['풀무원', '풀무원', 'pulmuone'],
  ['매일유업', '매일유업'],
  ['하림', '하림'],
  ['교촌치킨', '교촌치킨', '교촌', 'kyochon'],
  ['bhc', 'bhc', 'bhc치킨'],
  ['굽네치킨', '굽네치킨', '굽네'],
  ['맘스터치', '맘스터치', "mom's touch"],
  ['롯데리아', '롯데리아', 'lotteria'],
  ['메가커피', '메가커피', '메가mgc커피', 'mega coffee'],
  ['컴포즈커피', '컴포즈커피', 'compose coffee'],
  ['빽다방', '빽다방'],
  ['이디야', '이디야', 'ediya'],
  ['투썸플레이스', '투썸플레이스', '투썸', 'a twosome place'],
  ['파리바게뜨', '파리바게뜨', 'paris baguette'],
  ['뚜레쥬르', '뚜레쥬르', 'tous les jours'],
  ['배스킨라빈스', '배스킨라빈스', 'baskin robbins', 'baskin-robbins'],
  // Korean games
  ['넥슨', '넥슨', 'nexon'],
  ['넷마블', '넷마블', 'netmarble'],
  ['엔씨소프트', '엔씨소프트', 'ncsoft', 'nc soft'],
  ['스마일게이트', '스마일게이트', 'smilegate'],
  ['크래프톤', '크래프톤', 'krafton'],
  ['펄어비스', '펄어비스', 'pearl abyss'],
  ['카카오게임즈', '카카오게임즈', 'kakao games'],
  ['컴투스', '컴투스', 'com2us'],
  ['위메이드', '위메이드', 'wemade'],
  ['시프트업', '시프트업', 'shift up'],
  ['데브시스터즈', '데브시스터즈', 'devsisters'],
  ['호요버스', '호요버스', 'hoyoverse', 'mihoyo'],
  ['라이엇 게임즈', '라이엇 게임즈', '라이엇', 'riot games'],
  ['블리자드', '블리자드', 'blizzard entertainment', 'blizzard'],
  ['Supercell', 'supercell', '슈퍼셀'],
  ['Epic Games', 'epic games', '에픽게임즈'],
  ['Ubisoft', 'ubisoft', '유비소프트'],
  // Global tech & entertainment
  ['Apple', 'apple', '애플', 'アップル', '아이폰', '에어팟', '맥북', '아이패드', '애플워치', 'iphone', 'airpods', 'macbook', 'ipad', 'apple watch'],
  ['Google', 'google', '구글', 'グーグル'],
  ['Microsoft', 'microsoft', '마이크로소프트', 'マイクロソフト'],
  ['Amazon', 'amazon', '아마존', 'アマゾン'],
  ['Netflix', 'netflix', '넷플릭스', 'ネットフリックス'],
  ['Disney+', 'disney+', 'disney plus', '디즈니플러스', '디즈니+'],
  ['TVING', 'tving', '티빙'],
  ['Spotify', 'spotify', '스포티파이'],
  ['Nintendo', 'nintendo', '닌텐도', '任天堂'],
  ['Sony', 'sony', '소니', 'ソニー', 'playstation', '플레이스테이션', '플스'],
  ['Xbox', 'xbox', '엑스박스'],
  ['Tesla', 'tesla', '테슬라', 'テスラ'],
  ['BMW', 'bmw'],
  ['Mercedes-Benz', 'mercedes-benz', 'mercedes', '벤츠', '메르세데스'],
  ['Toyota', 'toyota', '도요타', 'トヨタ'],
  ['Honda', 'honda', '혼다', 'ホンダ'],
  ['Volvo', 'volvo', '볼보'],
  ['Porsche', 'porsche', '포르쉐'],
  ['Audi', 'audi', '아우디'],
  ['Volkswagen', 'volkswagen', '폭스바겐'],
  ['Dyson', 'dyson', '다이슨'],
  ['Philips', 'philips', '필립스'],
  ['Coway', 'coway', '코웨이'],
  ['Logitech', 'logitech', '로지텍'],
  ['Razer', 'razer'],
  ['ASUS', 'asus', '에이수스'],
  ['MSI', 'msi'],
  ['Lenovo', 'lenovo', '레노버'],
  ['Dell', 'dell'],
  ['Intel', 'intel', '인텔'],
  ['AMD', 'amd'],
  ['NVIDIA', 'nvidia', '엔비디아'],
  ['Xiaomi', 'xiaomi', '샤오미'],
  ['GoPro', 'gopro', '고프로'],
  ['DJI', 'dji'],
  ['Nikon', 'nikon', '니콘', 'ニコン'],
  ['Fujifilm', 'fujifilm', '후지필름', '富士フイルム'],
  ['Yamaha', 'yamaha', '야마하', 'ヤマハ'],
  // Global fashion & beauty
  ['Nike', 'nike', '나이키', 'ナイキ'],
  ['Adidas', 'adidas', '아디다스', 'アディダス'],
  ['New Balance', 'new balance', '뉴발란스'],
  ['Uniqlo', 'uniqlo', '유니클로', 'ユニクロ'],
  ['Zara', 'zara'],
  ['H&M', 'h&m'],
  ['Crocs', 'crocs', '크록스'],
  ['The North Face', 'the north face', 'north face', '노스페이스'],
  ["Arc'teryx", "arc'teryx", 'arcteryx', '아크테릭스'],
  ['Lululemon', 'lululemon', '룰루레몬'],
  ['Under Armour', 'under armour', '언더아머'],
  ['FILA', 'fila', '휠라'],
  ['SPAO', 'spao', '스파오'],
  ['MUJI', 'muji', '무인양품', '無印良品'],
  ['IKEA', 'ikea', '이케아', 'イケア'],
  ['Chanel', 'chanel', '샤넬', 'シャネル'],
  ['Dior', 'dior', '디올'],
  ['Gucci', 'gucci', '구찌'],
  ['Louis Vuitton', 'louis vuitton', '루이비통', 'ルイヴィトン'],
  ['Hermès', 'hermès', 'hermes', '에르메스'],
  ['Prada', 'prada', '프라다'],
  ['Rolex', 'rolex', '롤렉스'],
  ['Sephora', 'sephora', '세포라'],
  ["L'Oréal", "l'oréal", "l'oreal", 'loreal', '로레알'],
  ['Estée Lauder', 'estée lauder', 'estee lauder', '에스티로더'],
  ['Lancôme', 'lancôme', 'lancome', '랑콤'],
  ['Clinique', 'clinique', '크리니크'],
  ["Kiehl's", "kiehl's", 'kiehls', '키엘'],
  ['Shiseido', 'shiseido', '시세이도', '資生堂'],
  ['SK-II', 'sk-ii', 'sk2'],
  ['CeraVe', 'cerave', '세라비'],
  ['La Roche-Posay', 'la roche-posay', 'la roche posay', '라로슈포제'],
  ['The Ordinary', 'the ordinary'],
  // Global food & beverage
  ['Coca-Cola', 'coca-cola', 'coca cola', 'coke zero', '코카콜라', 'コカ・コーラ'],
  ['Pepsi', 'pepsi', '펩시'],
  ["McDonald's", "mcdonald's", 'mcdonalds', '맥도날드', 'マクドナルド'],
  ['Starbucks', 'starbucks', '스타벅스', 'スターバックス', 'スタバ'],
  ['KFC', 'kfc'],
  ['Burger King', 'burger king', '버거킹'],
  ["Domino's", "domino's", 'dominos', '도미노피자'],
  ['Red Bull', 'red bull', '레드불'],
  ['Nestlé', 'nestlé', 'nestle', '네슬레'],
  ['Suntory', 'suntory', 'サントリー'],
  ['Calbee', 'calbee', 'カルビー'],
  ['7-Eleven', '7-eleven', '세븐일레븐', 'セブンイレブン', 'セブン-イレブン'],
  ['GS25', 'gs25'],
  ['FamilyMart', 'familymart', 'ファミリーマート', 'ファミマ'],
  ['Lawson', 'lawson', 'ローソン'],
  // Global commerce / apps / typical YouTube sponsors
  ['AliExpress', 'aliexpress', '알리익스프레스'],
  ['Temu', 'temu', '테무'],
  ['SHEIN', 'shein', '쉬인'],
  ['Qoo10', 'qoo10', '큐텐'],
  ['Rakuten', 'rakuten', '楽天'],
  ['Mercari', 'mercari', 'メルカリ'],
  ['Airbnb', 'airbnb', '에어비앤비'],
  ['Agoda', 'agoda', '아고다'],
  ['Trip.com', 'trip.com', '트립닷컴'],
  ['Booking.com', 'booking.com', '부킹닷컴'],
  ['Klook', 'klook', '클룩'],
  ['Uber Eats', 'uber eats', 'ubereats'],
  ['DoorDash', 'doordash'],
  ['Duolingo', 'duolingo', '듀오링고'],
  ['NordVPN', 'nordvpn', 'nord vpn', '노드vpn'],
  ['Surfshark', 'surfshark'],
  ['ExpressVPN', 'expressvpn'],
  ['RAID: Shadow Legends', 'raid shadow legends', 'raid: shadow legends'],
  ['Squarespace', 'squarespace'],
  ['Skillshare', 'skillshare'],
  ['Audible', 'audible'],
  ['HelloFresh', 'hellofresh'],
  ['Manscaped', 'manscaped'],
  ['BetterHelp', 'betterhelp'],
  ['Grammarly', 'grammarly'],
  ['Shopify', 'shopify'],
  ['Wix', 'wix'],
  ['LEGO', 'lego', '레고', 'レゴ'],
  ['Square Enix', 'square enix', 'スクウェア・エニックス'],
  ['Capcom', 'capcom', '캡콤', 'カプコン'],
  ['Bandai Namco', 'bandai namco', '반다이남코', 'バンダイナムコ'],
  ['SEGA', 'sega', '세가'],
];

/** Substrings in which a (non-ASCII) brand alias occurrence does not count. */
const BRAND_TRAPS: Record<string, string[]> = {
  애플: ['애플망고', '애플파이', '애플민트', '파인애플', '애플수박', '애플사이다'],
  アップル: ['パイナップル', 'アップルパイ'],
  삼성: ['삼성동', '삼성역'],
  토스: ['토스트', '토스트기', '토스카'],
  카카오: ['카카오닙스', '카카오 닙스'],
  헤라: ['헤라클레스'],
  아마존: ['아마존 열대', '아마존강', '아마존 밀림'],
  지그재그: ['지그재그로'],
  레고: ['레고랜드'],
  롯데: ['롯데월드', '롯데 자이언츠', '롯데자이언츠'],
  소니: ['소니아'],
};
/** ASCII aliases that are too generic on their own and only count after 'sponsored by' style captures. */
const CAPTURE_ONLY_ALIASES = new Set(['toss', 'ably', 'etude', 'audible', 'apple', 'amazon', 'google', 'blizzard', 'wix', 'zigzag', 'hera beauty', '아마존', '구글']);

interface BrandAlias {
  alias: string;
  name: string;
  ascii: boolean;
  re: RegExp | null;
  traps: string[];
}

let brandIndex: { aliases: BrandAlias[]; byCompact: Map<string, string> } | null = null;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compactKey(s: string): string {
  return normalizeText(s).replace(/[\s\-_.·・:]/g, '');
}

function isAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) return false;
  return true;
}

function brands() {
  if (brandIndex) return brandIndex;
  const aliases: BrandAlias[] = [];
  const byCompact = new Map<string, string>();
  for (const [name, ...rest] of BRAND_LIST) {
    for (const raw of [name, ...rest]) {
      const alias = normalizeText(raw);
      if (!alias) continue;
      const key = compactKey(alias);
      if (key.length >= 2 && !byCompact.has(key)) byCompact.set(key, name);
      if (aliases.some((a) => a.alias === alias)) continue;
      const ascii = isAscii(alias);
      aliases.push({
        alias,
        name,
        ascii,
        // Latin boundaries only: Korean particles may be glued to a Latin brand ('nike에서', 'lg의').
        re: ascii ? new RegExp(`(?<![a-z0-9])${escapeRe(alias)}(?![a-z0-9])`, 'giu') : null,
        traps: (BRAND_TRAPS[alias] ?? []).map(normalizeText),
      });
    }
  }
  aliases.sort((a, b) => b.alias.length - a.alias.length);
  brandIndex = { aliases, byCompact };
  return brandIndex;
}

/** Curated brands mentioned in `text` (longest alias wins; overlapping shorter aliases are masked). */
function findCuratedBrands(text: string, allowGeneric: boolean): { name: string; match: string }[] {
  const { aliases } = brands();
  let t = normalizeText(text);
  const out: { name: string; match: string }[] = [];
  for (const a of aliases) {
    if (!allowGeneric && CAPTURE_ONLY_ALIASES.has(a.alias)) continue;
    if (!t.includes(a.alias)) continue;
    let found = false;
    if (a.ascii) {
      a.re!.lastIndex = 0;
      found = a.re!.test(t);
    } else {
      let masked = t;
      for (const trap of a.traps) masked = masked.split(trap).join(' '.repeat(trap.length));
      found = masked.includes(a.alias);
    }
    if (!found) continue;
    if (!out.some((o) => o.name === a.name)) out.push({ name: a.name, match: a.alias });
    t = t.split(a.alias).join(' '.repeat(a.alias.length)); // mask so '쿠팡' does not re-match inside '쿠팡플레이'
  }
  return out;
}

/** Map a captured brand string to a curated canonical name when possible. */
function canonicalBrand(raw: string): string | null {
  const key = compactKey(raw);
  if (key.length < 2) return null;
  return brands().byCompact.get(key) ?? null;
}

/* ------------------------------------------------------------------------------------------
 * Explicit brand captures
 * ---------------------------------------------------------------------------------------- */

const EN_STOP = new Set([
  'for', 'and', 'to', 'with', 'in', 'on', 'at', 'this', 'that', 'today', 'check', 'use', 'get', 'go', 'click', 'visit', 'who', 'which',
  'here', 'now', 'link', 'below', 'code', 'download', 'sign', 'try', 'thanks', 'thank', 'via', 'as', 'from', 'so', 'is', 'are', 'was',
  'you', 'your', 'our', 'my', 'we', 'i', 'x', '-', '–', '—', '|', 'by', 'if', 'but', 'or', 'because', 'where', 'when', 'all', 'their',
]);
const GENERIC_CAPTURES = new Set([
  '유료', '광고', '제품', '영상', '본', '이', '해당', '업체', '브랜드', '일부', '무상', '소정의', '콘텐츠', '컨텐츠', '채널', '기업', '회사',
  '이번', '오늘', '무료', '공식', '직접', '제작', '촬영', '장소', '의상', '소품', '차량', '숙소', '식사', '제공', '노', '무', '비', '광고주',
  '협찬사', '스폰서', '제작진', '방송', '프로그램', '본사', '당사', '저희', '우리', '모든', '전액', '상품', '서비스', '물품', '일부분', '뒷',
  'the', 'a', 'an', 'our', 'my', 'this', 'sponsor', 'sponsors', 'everyone', 'anyone', 'nobody', 'no one', 'viewers', 'patreon', 'patrons',
  'you', 'me', 'us', 'them', 'itself', 'none', 'nothing', 'company', 'companies', 'brand', 'brands',
  '企業', '商品', '製品', '動画', '今回', '本動画', '当チャンネル', 'スポンサー', 'サービス', 'アイテム', 'グッズ', 'チャンネル', 'メーカー',
  'ブランド', 'クライアント', '없음', '없습니다', '미정', 'n/a', 'na', 'tbd', 'x',
]);
const KO_PARTICLE_RE = /(?:으로부터|로부터|에게서|에서|께서|측에서|측|님의|님|으로|의|이|가|은|는|와|과|을|를|로|도)$/u;

function cleanEnglishCapture(raw: string): string | null {
  const tokens = raw.trim().split(/\s+/);
  const kept: string[] = [];
  for (const tok of tokens) {
    const bare = tok.replace(/[.,!?;:'"’)]+$/u, '');
    if (!bare) break;
    if (EN_STOP.has(bare.toLowerCase()) && !(kept.length === 0 && bare.toLowerCase() === 'the')) break;
    kept.push(bare);
    if (kept.length >= 4 || /[.,!?;:]$/.test(tok)) break;
  }
  if (kept.length === 1 && kept[0].toLowerCase() === 'the') return null;
  return kept.join(' ') || null;
}

function acceptCapture(raw: string | null): string | null {
  if (!raw) return null;
  const mention = /^@([a-z0-9._]{2,30})$/iu.exec(raw.trim());
  if (mention) {
    const handle = mention[1].replace(/[._]+$/, '');
    return canonicalBrand(handle) ?? mentionBrand(handle) ?? `@${handle}`;
  }
  let s = raw.trim().replace(/^[@#"'“‘(\[]+|["'”’)\].,!?:;]+$/gu, '').trim();
  if (!s) return null;
  const canon = canonicalBrand(s);
  if (canon) return canon;
  // Korean particle stripping ('삼성전자로부터' -> '삼성전자')
  if (/[가-힣]$/u.test(s)) {
    const stripped = s.replace(KO_PARTICLE_RE, '');
    if (stripped !== s && stripped.length >= 2) {
      const c2 = canonicalBrand(stripped);
      if (c2) return c2;
      s = stripped;
    }
    if (/(?:받아|받은|받고|하여|해서|합니다|했습니다|입니다|드립니다)$/u.test(s)) return null;
  }
  if (s.length < 2 || s.length > 40) return null;
  if (/^[\d\s.,%-]+$/.test(s)) return null;
  if (GENERIC_CAPTURES.has(s.toLowerCase()) || GENERIC_CAPTURES.has(s)) return null;
  return s;
}

const EN_CAPTURE_RE = r(
  "\\b(?:sponsored\\s+by|in\\s+partnership\\s+with|paid\\s+partnership\\s+with|partnered\\s+with|partnering\\s+with|brought\\s+to\\s+you\\s+by|today'?s\\s+sponsor(?:\\s+is)?\\s*[:,]?)\\s+" +
    '(?:(?:my|our|the)\\s+(?:good\\s+)?(?:friends|folks|partners|pals|people|team)\\s+(?:at|from|over\\s+at)\\s+)?' +
    "(@?[\\p{L}\\p{N}][^\\n,!?;:()|\\[\\]]{0,50})",
);
const EN_THANKS_RE = r("\\bthanks\\s+to\\s+(@?[\\p{L}\\p{N}][^\\n,.!?;:()|]{0,40}?)\\s+for\\s+sponsoring");
const KO_BEFORE_RE = r(
  "(?<![\\p{L}\\p{N}&.\\-_'’])([\\p{L}\\p{N}&.\\-_'’]{2,30})\\s*(?:제품\\s*(?:을|를)?\\s*|유료\\s*광고\\s*|광고\\s*)?(?:협찬|제작\\s*지원|후원을)",
);
const COLON_RE = r(
  `(?:협찬사?|제작\\s*지원(?:사)?|장소\\s*협찬|의상\\s*협찬|광고주|후원사|sponsor(?:ed)?(?:\\s+by)?|${JA_NOT_SPONSOR_LB}提供|スポンサー|タイアップ)\\s*[:：]\\s*([^\\n,/|·•]{2,40})`,
);
const JA_BEFORE_RE = r(
  '([\\p{L}\\p{N}ー・&.\\-]{2,24}?)(?:様|さん|社)?' +
    '(?:(?:より|から)(?:商品|製品)?(?:を|の)?(?:ご)?提供|とのタイアップ|との(?:pr|企業)?案件|の(?:pr|企業)案件)',
);
const MENTION_RE = r('(?<![\\p{L}\\p{N}_.])@([a-z0-9._]{2,30})');

/**
 * Japanese has no spaces, so a capture before 'より提供' may include the start of the sentence
 * ('今回はユニクロ'). Keep the trailing run without Hiragana ('ユニクロ', 'ロート製薬') and drop a leading
 * time word ('本日', '今回').
 */
function trailingJapaneseBrand(s: string): string {
  const m = /[\p{Script=Katakana}\p{Script=Han}ーA-Za-z0-9&.\-・]+$/u.exec(s);
  if (!m) return '';
  const t = m[0].replace(/^(?:本日|今日|今回|今年|先日|以前|前回|毎回|昨日)/u, '');
  return t.length >= 2 ? t : '';
}

/* ------------------------------------------------------------------------------------------
 * Detector
 * ---------------------------------------------------------------------------------------- */

/** Hangul / Kana / Han present: '#PR' is a Japanese/Korean disclosure convention ('#pr' = personal record in English). */
const CJK_RE = /[\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;

function clip(s: string, max = 60): string {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** NFKC, invisible chars removed, whitespace collapsed but line breaks kept (proximity is per line). */
function prep(s: string | null | undefined): string {
  if (!s) return '';
  return s.normalize('NFKC').replace(INVISIBLE_RE, '').replace(/\r\n?/g, '\n').replace(/[^\S\n]+/g, ' ');
}

const HASHTAG_SCAN_RE = /(^|[^\p{L}\p{N}_&/])[#＃]([\p{L}\p{N}_]+)/gu;

function scanCues(field: Field, text: string, out: Cue[]): void {
  if (!text) return;
  for (const rule of CUE_RULES) {
    rule.re.lastIndex = 0;
    for (const m of text.matchAll(rule.re)) {
      const index = m.index ?? 0;
      const end = index + m[0].length;
      if (!rule.noNegation && isNegated(text, index, end)) continue;
      // A '#광고아님' style hashtag is handled as a hashtag, never as the '광고' phrase inside it.
      out.push({ kind: rule.kind, field, index, end, label: rule.label ?? m[0].trim().toLowerCase().replace(/\s+/g, ' ') });
    }
  }
  HASHTAG_SCAN_RE.lastIndex = 0;
  for (const m of text.matchAll(HASHTAG_SCAN_RE)) {
    const tag = m[2].toLowerCase();
    const index = (m.index ?? 0) + m[1].length;
    const end = index + 1 + m[2].length;
    if (tag === 'pr' && !CJK_RE.test(text)) continue;
    if (DISCLOSURE_HASHTAGS.has(tag)) out.push({ kind: 'disclosure', field, index, end, label: `#${tag}` });
    else if (PROMO_HASHTAGS.has(tag)) out.push({ kind: 'promo', field, index, end, label: `#${tag}` });
  }
}

export function detectSponsorship(input: { title: string; description: string | null; tags: string[] }): SponsorshipSignal | null {
  const title = prep(input.title);
  const description = prep(input.description);
  const tagList = (input.tags ?? []).map((t) => prep(t).trim()).filter(Boolean);
  const tagsText = tagList.join('\n');
  const texts: Record<Field, string> = { title, description, tags: tagsText };

  const cues: Cue[] = [];
  scanCues('title', title, cues);
  scanCues('description', description, cues);
  // Tags: only exact disclosure/promo tags (a tag '광고' alone may be a topic, e.g. a TV-commercial compilation).
  let offset = 0;
  for (const tag of tagList) {
    const key = normalizeText(tag).replace(/^#/, '').replace(/\s+/g, '');
    if (DISCLOSURE_TAGS.has(key)) cues.push({ kind: 'disclosure', field: 'tags', index: offset, end: offset + tag.length, label: key });
    else if (PROMO_HASHTAGS.has(key)) cues.push({ kind: 'promo', field: 'tags', index: offset, end: offset + tag.length, label: key });
    offset += tag.length + 1;
  }

  const disclosures = cues.filter((c) => c.kind === 'disclosure');
  const promos = cues.filter((c) => c.kind === 'promo');
  const negativeClaim = [title, description, tagsText].some((t) => {
    NEGATIVE_CLAIM_RE.lastIndex = 0;
    return NEGATIVE_CLAIM_RE.test(t);
  });
  const weak = negativeClaim ? [] : cues.filter((c) => c.kind === 'weak');
  if (!disclosures.length && !promos.length && !weak.length) return null;

  const brandNames: string[] = [];
  const brandEvidence: Evidence[] = [];
  const addBrand = (name: string, field: Field, match: string) => {
    if (brandNames.length >= MAX_BRANDS) return;
    if (!brandNames.some((b) => b.toLowerCase() === name.toLowerCase())) brandNames.push(name);
    if (!brandEvidence.some((e) => e.field === field && e.match === match)) brandEvidence.push({ field, match });
  };

  // 1. Explicit captures (any field). Captures are tied to disclosure phrases, so they are trusted as-is.
  for (const field of ['title', 'description'] as Field[]) {
    const text = texts[field];
    if (!text || !disclosures.some((d) => d.field === field)) continue;
    for (const re of [EN_CAPTURE_RE, EN_THANKS_RE]) {
      re.lastIndex = 0;
      for (const m of text.matchAll(re)) {
        if (negatedBefore(text, m.index ?? 0)) continue; // 'not sponsored by anyone'
        const name = acceptCapture(cleanEnglishCapture(m[1]));
        if (name) addBrand(name, field, clip(m[0]));
      }
    }
    KO_BEFORE_RE.lastIndex = 0;
    for (const m of text.matchAll(KO_BEFORE_RE)) {
      const kwEnd = (m.index ?? 0) + m[0].length;
      if (isNegated(text, kwEnd - 2, kwEnd)) continue;
      const name = acceptCapture(m[1]);
      if (!name) continue;
      // Unknown Korean tokens right before '협찬' are often product nouns ('노트북 협찬', '의상 협찬'): accept a
      // non-curated name only when it is marked as the giver ('X로부터', 'X에서', 'X의') or has Latin letters.
      const curated = knownBrands().includes(name);
      if (!curated && !/(?:으로부터|로부터|에서|께서|측|의)$/u.test(m[1]) && !/[a-z]/iu.test(name)) continue;
      addBrand(name, field, clip(m[0]));
    }
    COLON_RE.lastIndex = 0;
    for (const m of text.matchAll(COLON_RE)) {
      const idx = m.index ?? 0;
      if (isNegated(text, idx, idx + m[0].search(/[:：]/u))) continue; // '협찬: 없음', '협찬 : X 문의'
      for (const part of m[1].split(/\s*(?:,|、|&|\+|\s및\s|\s(?:and|x)\s)\s*/u).slice(0, 3)) {
        const name = acceptCapture(isAscii(part) ? cleanEnglishCapture(part) : part.split(/\s+/).slice(0, 2).join(' '));
        if (name) addBrand(name, field, clip(m[0]));
      }
    }
    JA_BEFORE_RE.lastIndex = 0;
    for (const m of text.matchAll(JA_BEFORE_RE)) {
      if (isNegated(text, m.index ?? 0, (m.index ?? 0) + m[0].length)) continue;
      const curated = findCuratedBrands(m[1], true);
      if (curated.length) {
        for (const b of curated) addBrand(b.name, field, clip(m[0]));
        continue;
      }
      const name = acceptCapture(trailingJapaneseBrand(m[1]));
      if (name) addBrand(name, field, clip(m[0]));
    }
  }

  // 2. Curated brands near cues (and anywhere in title/tags when disclosed)
  const contextCues = [...disclosures, ...promos, ...weak];
  const weakWithBrand: Cue[] = [];
  for (const cue of contextCues) {
    const text = texts[cue.field];
    const lineStart = text.lastIndexOf('\n', cue.index - 1) + 1;
    const start = Math.max(0, cue.index - BRAND_WINDOW);
    const end = Math.min(text.length, cue.end + BRAND_WINDOW);
    const window = maskAffiliate(text.slice(start, end));
    const found = findCuratedBrands(window, false);
    for (const b of found) addBrand(b.name, cue.field, b.match);
    if (cue.kind === 'weak') {
      // A shopping link for a brand named in the title ('나이키 신발 리뷰' + '구매 링크') is also a promo cue.
      const inTitle = found.length || cue.field === 'title' ? [] : findCuratedBrands(title, false);
      for (const b of inTitle) addBrand(b.name, 'title', b.match);
      if (found.length || inTitle.length) weakWithBrand.push(cue);
    }
    // @mentions on the same line, close to a disclosure
    if (cue.kind === 'disclosure') {
      const lineEnd = text.indexOf('\n', cue.end);
      const seg = text.slice(Math.max(lineStart, cue.index - 60), Math.min(lineEnd < 0 ? text.length : lineEnd, cue.end + 60));
      MENTION_RE.lastIndex = 0;
      for (const m of seg.matchAll(MENTION_RE)) {
        const handle = m[1].replace(/[._]+$/, '');
        if (handle.length < 2) continue;
        const canon = canonicalBrand(handle) ?? mentionBrand(handle);
        addBrand(canon ?? `@${handle}`, cue.field, `@${handle}`);
      }
    }
  }
  if (disclosures.length) {
    for (const b of findCuratedBrands(title, false)) addBrand(b.name, 'title', b.match);
    for (const tag of tagList) for (const b of findCuratedBrands(tag, false)) addBrand(b.name, 'tags', b.match);
  }

  let level: SponsorshipSignal['level'] | null = null;
  if (disclosures.length) level = 'disclosed';
  else if (promos.length || weakWithBrand.length) level = 'likely';
  if (!level) return null;

  const evidence: Evidence[] = [];
  const pushEv = (ev: Evidence) => {
    if (evidence.length < MAX_EVIDENCE && !evidence.some((e) => e.field === ev.field && e.match === ev.match)) evidence.push(ev);
  };
  const cueEvidence = level === 'disclosed' ? [...disclosures, ...promos] : [...promos, ...weakWithBrand];
  for (const c of cueEvidence) pushEv({ field: c.field, match: c.label });
  for (const e of brandEvidence) pushEv(e);

  return { level, brands: brandNames, evidence, version: SPONSORSHIP_VERSION };
}

/** A handle like 'oliveyoung_official' or 'nike.korea' -> curated brand, when a distinctive alias is inside it. */
function mentionBrand(handle: string): string | null {
  const h = handle.toLowerCase().replace(/[._]/g, '');
  for (const a of brands().aliases) {
    if (!a.ascii) continue;
    const key = a.alias.replace(/[\s\-_.'&:+]/g, '');
    if (key.length >= 4 && h.includes(key)) return a.name;
  }
  return null;
}

/** Curated brand names (canonical), e.g. for filters/autocomplete in the brands page. */
export function knownBrands(): string[] {
  return BRAND_LIST.map((b) => b[0]);
}

/** Canonical curated brand for a free-form name ('samsung' -> '삼성'), or null. */
export function canonicalBrandName(name: string): string | null {
  return canonicalBrand(name);
}
