/**
 * Deterministic synthetic dataset for the web app's sample mode (apps/web/public/data/sample.json).
 *
 * Everything here is FAKE and clearly marked: account names start with "샘플", URLs point to example.com,
 * and exportNotes say so. The goal is realistic *shapes* so every UI state can be exercised:
 * - growth curves: front-loaded decay + slow tail, re-trending old videos, rare counter decreases,
 * - collector cadence: tiered refresh (every run < 3d, 12h < 14d, daily < 90d, weekly older) and the
 *   export compaction rules from SPEC, niconico daily snapshots (observation time = snapshot time),
 *   PeerTube instance outages (wide gaps), late discovery (lower bounds),
 * - null is not zero: hidden likes, sources that never provide comments/shares,
 * - Dailymotion source windows (views_last_day/week/month) for 'source_reported' values,
 * - seasonal topics (추석 rising, 여름휴가 falling), niche high-demand topics, multi-platform creators,
 *   disclosed / likely sponsorships, deleted / private videos, disabled credentialed sources.
 */
import { CLASSIFIER_VERSION, SPONSORSHIP_VERSION, TAXONOMY, TOP_LEVEL_CATEGORY_IDS } from '@vti/core';
import type {
  Account,
  CategoryAssignment,
  CollectionRun,
  Creator,
  Dataset,
  FollowerPoint,
  ObservationPoint,
  Platform,
  SourceCoverage,
  SourceWindowMetric,
  SponsorshipSignal,
  Video,
  VideoFormat,
} from '@vti/core';

type TopCategory = (typeof TOP_LEVEL_CATEGORY_IDS)[number];

export const HOUR = 3_600_000;
export const DAY = 86_400_000;
/** 2026-09-28 03:00 UTC = 12:00 KST. */
export const SAMPLE_GENERATED_AT = Date.UTC(2026, 8, 28, 3, 0, 0);
export const SAMPLE_SEED = 20260928;

/* ------------------------------------------------------------------------------------------ PRNG */

/** mulberry32: small, fast, deterministic. */
export function createRng(seed: number) {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng = {
    next,
    uniform: (lo: number, hi: number) => lo + (hi - lo) * next(),
    int: (lo: number, hi: number) => Math.floor(lo + (hi - lo + 1) * next()),
    chance: (p: number) => next() < p,
    pick: <T>(arr: readonly T[]): T => arr[Math.floor(next() * arr.length)],
    normal: () => {
      let u = 0;
      while (u === 0) u = next();
      const v = next();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
    logNormal: (median: number, sigma: number) => median * Math.exp(sigma * rng.normal()),
    weighted: <T>(items: readonly T[], weights: readonly number[]): T => {
      const total = weights.reduce((s, w) => s + Math.max(0, w), 0);
      let r = next() * total;
      for (let i = 0; i < items.length; i++) {
        r -= Math.max(0, weights[i]);
        if (r <= 0) return items[i];
      }
      return items[items.length - 1];
    },
    chars: (alphabet: string, n: number) => {
      let s = '';
      for (let i = 0; i < n; i++) s += alphabet[Math.floor(next() * alphabet.length)];
      return s;
    },
  };
  return rng;
}
type Rng = ReturnType<typeof createRng>;

/* ------------------------------------------------------------------------------------------ vocab */

const KO_TOPICS: Record<TopCategory, string[]> = {
  beauty: ['스킨케어', '쿠션팩트', '립틴트', '선크림', '민감성피부', '올리브영', '가을메이크업', '메이크업튜토리얼'],
  fashion: ['가을코디', '데일리룩', '하울', '출근룩', '빈티지', '가디건'],
  food: ['먹방', '자취요리', '추석음식', '송편', '편의점신상', '레시피', '카페투어'],
  gaming: ['롤', '발로란트', '신작게임', '메이플스토리', '마인크래프트', '게임리뷰', '스팀'],
  music: ['커버곡', 'kpop', '플레이리스트', '라이브', '댄스챌린지', '뮤직비디오'],
  entertainment: ['예능', '리액션', '아이돌', '챌린지', '토크쇼'],
  comedy: ['콩트', '몰래카메라', '패러디', '상황극'],
  film_animation: ['영화리뷰', '애니메이션', '결말포함', '드라마리뷰', '단편영화'],
  news_politics: ['뉴스', '경제뉴스', '정책', '국제뉴스', '날씨'],
  sports: ['야구', 'kbo', '축구', '하이라이트', '마라톤', '가을야구'],
  education: ['공부법', '영어회화', '수능', '자격증', '강의'],
  science_tech: ['아이폰17', '갤럭시', 'ai', '테크리뷰', '노트북추천', '언박싱'],
  travel: ['여행브이로그', '제주도', '일본여행', '캠핑', '가을여행', '단풍', '여름휴가', '워터파크'],
  lifestyle: ['브이로그', '자취', '살림', '미니멀라이프', '인테리어', '추석', '귀성길', '바캉스'],
  kids_family: ['육아', '키즈', '장난감', '동요'],
  pets_animals: ['강아지', '고양이', '반려동물', '유기견'],
  autos: ['자동차리뷰', '전기차', '시승기', '중고차'],
  business_finance: ['주식', '재테크', '부동산', '경제', '절약'],
  health_fitness: ['홈트', '다이어트', '러닝', '필라테스', '장마철운동'],
  howto_diy: ['diy', '꿀팁', '수리', '정리정돈', '만들기'],
};

const JA_TOPICS: Partial<Record<TopCategory, string[]>> = {
  gaming: ['ゲーム実況', 'マインクラフト', 'ゆっくり実況', '新作ゲーム'],
  music: ['歌ってみた', 'ボカロ', '演奏してみた'],
  entertainment: ['踊ってみた', 'vtuber', '雑談'],
  food: ['料理', 'お弁当', '月見'],
  film_animation: ['アニメ', 'mad', '映画レビュー'],
  science_tech: ['技術部', '自作pc', 'ai'],
  education: ['ゆっくり解説', '勉強'],
  pets_animals: ['猫', '犬'],
  travel: ['旅行', '紅葉'],
  lifestyle: ['日常', 'お月見'],
};

const EN_TOPICS: Partial<Record<TopCategory, string[]>> = {
  beauty: ['skincare', 'makeup'],
  gaming: ['gameplay', 'speedrun', 'indie games'],
  music: ['cover', 'live session'],
  science_tech: ['tech review', 'ai', 'linux'],
  travel: ['travel vlog', 'hiking'],
  food: ['cooking', 'recipe'],
  education: ['tutorial', 'lecture'],
  news_politics: ['news', 'world news'],
  film_animation: ['short film', 'animation'],
  howto_diy: ['diy', 'repair'],
  sports: ['highlights', 'football'],
  lifestyle: ['vlog', 'minimalism'],
};

const KO_TEMPLATES_BY_CAT: Partial<Record<TopCategory, string[]>> = {
  beauty: ['{t} 루틴 공개 | 민감성 피부도 OK', '요즘 난리난 {t} 솔직 리뷰', '{t} 비교해봄 (내돈내산)', '5분 완성 {t}', '{t} 추천템 TOP5'],
  food: ['{t} 이렇게 만들면 실패 없음', '{t} 먹방 | 오늘의 한 끼', '편하게 만드는 {t} 레시피', '{t} 맛집 다 가봄'],
  gaming: ['{t} 랭크 올리는 법', '{t} 첫 플레이 반응', '{t} 이번 패치 총정리', '{t} 하이라이트 모음'],
  music: ['{t} | 라이브 클립', '{t} 모음 1시간', '{t} 불러봤습니다', '{t} 연습 영상'],
  science_tech: ['{t} 한 달 사용 후기', '{t} 언박싱 & 첫인상', '{t} 살까 말까? 장단점 정리', '{t} 숨은 기능 10가지'],
  travel: ['{t} 2박 3일 코스 공유', '{t} 가볼 만한 곳', '{t} 경비 총정리', '{t} 브이로그'],
  sports: ['{t} 오늘 경기 하이라이트', '{t} 명장면 모음', '{t} 전망 분석'],
  news_politics: ['[{t}] 오늘의 주요 소식', '{t} 3분 요약', '{t} 쟁점 정리'],
  education: ['{t} 이렇게 하면 됩니다', '{t} 기초부터 정리', '{t} 한 번에 끝내기'],
  business_finance: ['{t} 초보가 꼭 알아야 할 것', '{t} 이번 주 흐름 정리', '{t} 실수 줄이는 법'],
  pets_animals: ['{t}와 함께한 하루', '{t} 행동 이유 알려드림', '{t} 입양 후기'],
  autos: ['{t} 1년 타본 후기', '{t} 장단점 솔직 정리', '{t} 연비·유지비 비교'],
  howto_diy: ['{t} 초보도 가능', '{t} 비용 아끼는 법', '{t} 따라 하기'],
};

const KO_GENERIC = ['{t} 솔직 후기', '{t} 브이로그', '요즘 {t} 근황', '{t} 총정리', '처음 해본 {t}', '{t} 이거 하나면 끝', '{t} 레전드 모음', '[{t}] 오늘의 기록'];
const JA_TEMPLATES = ['【{t}】やってみた', '{t}まとめ', '初めての{t}', '{t}実況プレイ part{n}', '{t}の日常'];
const EN_TEMPLATES = ['{t} review', 'my {t} routine', '{t} in 10 minutes', 'I tried {t} for a week', '{t} highlights'];

const RELATED: Partial<Record<TopCategory, TopCategory[]>> = {
  beauty: ['fashion', 'lifestyle'],
  fashion: ['beauty', 'lifestyle'],
  food: ['travel', 'lifestyle'],
  gaming: ['entertainment', 'science_tech'],
  music: ['entertainment'],
  entertainment: ['comedy', 'music'],
  comedy: ['entertainment'],
  travel: ['food', 'lifestyle'],
  lifestyle: ['food', 'howto_diy'],
  science_tech: ['education', 'gaming'],
  sports: ['health_fitness', 'entertainment'],
  health_fitness: ['sports', 'lifestyle'],
  business_finance: ['news_politics', 'education'],
  news_politics: ['business_finance'],
  pets_animals: ['lifestyle', 'kids_family'],
  kids_family: ['education', 'pets_animals'],
  autos: ['science_tech'],
  howto_diy: ['lifestyle'],
};

/** Fictional brands only. */
const BRANDS: { name: string; cats: TopCategory[] }[] = [
  { name: '루미엔 코스메틱', cats: ['beauty', 'fashion'] },
  { name: '하루담 식품', cats: ['food', 'lifestyle'] },
  { name: '노바게임즈', cats: ['gaming', 'entertainment'] },
  { name: '브릿지모바일', cats: ['science_tech'] },
  { name: '온결 패션', cats: ['fashion', 'beauty'] },
  { name: '펫밀리', cats: ['pets_animals'] },
  { name: '그린휠 모터스', cats: ['autos'] },
  { name: '스텝업 에듀', cats: ['education'] },
  { name: '라온 트래블', cats: ['travel'] },
  { name: '핏앤런', cats: ['health_fitness', 'sports'] },
];

const PERSON_KO = ['민지', '하늘', '준호', '서연', '도윤', '지우', '하린', '태오', '유나', '시우', '예린', '현우', '다온', '로아', '건우', '수아'];
const PERSON_JA = ['はると', 'ゆい', 'そうた', 'さくら', 'りく', 'ひな'];
const PERSON_EN = ['Alex', 'Sam', 'Jamie', 'Robin', 'Casey', 'Taylor'];
const CHANNEL_LABELS: Record<TopCategory, string[]> = {
  beauty: ['뷰티랩', '코덕일기', '피부연구소', '메이크업노트'],
  fashion: ['데일리룩', '옷장일기', '스타일북'],
  food: ['집밥연구소', '맛집탐방', '자취요리', '먹방일기'],
  gaming: ['게임방송', '겜튜브', '플레이로그'],
  music: ['뮤직룸', '커버하우스', '음악노트'],
  entertainment: ['예능공장', '리액션룸'],
  comedy: ['웃음공장', '콩트클럽'],
  film_animation: ['영화관', '애니노트'],
  news_politics: ['뉴스브리핑', '이슈정리'],
  sports: ['스포츠채널', '하이라이트'],
  education: ['공부채널', '클래스룸'],
  science_tech: ['테크리뷰', '기계덕후', 'IT노트'],
  travel: ['여행일기', '길위의기록'],
  lifestyle: ['일상기록', '자취생활'],
  kids_family: ['키즈랜드', '육아일기'],
  pets_animals: ['댕냥일기', '반려생활'],
  autos: ['카리뷰', '드라이브로그'],
  business_finance: ['머니노트', '재테크연구소'],
  health_fitness: ['홈트채널', '러닝일기'],
  howto_diy: ['꿀팁창고', 'DIY공방'],
};

const DM_CHANNEL: Partial<Record<TopCategory, string>> = {
  news_politics: 'news', music: 'music', sports: 'sport', comedy: 'fun', gaming: 'videogames', science_tech: 'tech',
  travel: 'travel', lifestyle: 'lifestyle', kids_family: 'kids', pets_animals: 'animals', autos: 'auto',
  film_animation: 'shortfilms', entertainment: 'tv', education: 'school', beauty: 'lifestyle', fashion: 'lifestyle',
  food: 'lifestyle', health_fitness: 'sport', business_finance: 'news', howto_diy: 'creation',
};
const PT_CATEGORY: Partial<Record<TopCategory, string>> = {
  music: 'Music', film_animation: 'Films', autos: 'Vehicles', sports: 'Sports', travel: 'Travels', gaming: 'Gaming',
  lifestyle: 'People', comedy: 'Comedy', entertainment: 'Entertainment', news_politics: 'News & Politics', howto_diy: 'How To',
  education: 'Education', science_tech: 'Science & Technology', pets_animals: 'Animals', kids_family: 'Kids', food: 'Food',
};
const NICO_GENRE: Partial<Record<TopCategory, string>> = {
  gaming: 'ゲーム', music: '音楽・サウンド', entertainment: 'エンターテイメント', food: '料理', travel: '旅行・アウトドア',
  sports: 'スポーツ', pets_animals: '動物', science_tech: '技術・工作', education: '解説・講座', film_animation: 'アニメ',
  lifestyle: 'その他', howto_diy: '技術・工作',
};
const YT_CATEGORY: Partial<Record<TopCategory, string>> = {
  beauty: 'Howto & Style', fashion: 'Howto & Style', food: 'People & Blogs', gaming: 'Gaming', music: 'Music',
  entertainment: 'Entertainment', comedy: 'Comedy', film_animation: 'Film & Animation', news_politics: 'News & Politics',
  sports: 'Sports', education: 'Education', science_tech: 'Science & Technology', travel: 'Travel & Events',
  lifestyle: 'People & Blogs', kids_family: 'Entertainment', pets_animals: 'Pets & Animals', autos: 'Autos & Vehicles',
  business_finance: 'Education', health_fitness: 'Sports', howto_diy: 'Howto & Style',
};

/* ------------------------------------------------------------------------------------------ topic dynamics */

function bump(daysAgo: number, center: number, width: number, peak: number): number {
  return 1 + (peak - 1) * Math.exp(-((daysAgo - center) ** 2) / (2 * width * width));
}

/** Relative popularity of a topic at `daysAgo` before generatedAt (1 = neutral). */
export function topicProfile(topic: string, daysAgo: number): number {
  switch (topic) {
    case '추석':
    case '추석음식':
    case '송편':
    case '귀성길':
    case '月見':
    case 'お月見':
      return bump(daysAgo, 3, 3.5, 7);
    case '가을코디':
    case '가을메이크업':
    case '가을여행':
    case '단풍':
    case '가디건':
    case '紅葉':
      return 0.4 + 2.2 / (1 + Math.exp((daysAgo - 12) / 4));
    case '가을야구':
      return 0.3 + 3 / (1 + Math.exp((daysAgo - 6) / 2));
    case '여름휴가':
    case '워터파크':
    case '바캉스':
    case '장마철운동':
      return 0.15 + 3.5 * Math.exp(-((daysAgo - 45) ** 2) / (2 * 12 * 12));
    case '아이폰17':
      return bump(daysAgo, 14, 6, 5);
    case '신작게임':
    case '新作ゲーム':
      return bump(daysAgo, 5, 4, 6);
    default:
      return 1;
  }
}

/** Seasonal topics whose OLD videos re-trend right now (activity mode finds them, upload mode does not). */
const RETREND_TOPICS = new Set(['추석', '추석음식', '송편', '귀성길', '가을야구', '月見', 'お月見']);

/** Seasonal topics past their season: their videos' long tail fades fast. */
const FADING_TOPICS = new Set(['여름휴가', '워터파크', '바캉스', '장마철운동']);

/** Topic-specific demand multiplier (views per video) for niche, under-supplied topics. */
const TOPIC_DEMAND: Record<string, number> = {
  수리: 3.2, 중고차: 2.4, 공부법: 2.2, 절약: 2.6, 유기견: 2.0, 필라테스: 1.8, 자격증: 2.1, '월간': 1,
  먹방: 0.7, 브이로그: 0.6, 챌린지: 0.8, 하울: 0.8,
};
/** Upload propensity (supply) multiplier; niche topics are rarely chosen. */
const TOPIC_SUPPLY: Record<string, number> = {
  수리: 0.25, 중고차: 0.35, 공부법: 0.4, 절약: 0.3, 유기견: 0.35, 자격증: 0.4,
  먹방: 2.2, 브이로그: 2.5, 챌린지: 1.8, 하울: 1.6, kpop: 1.8, 리액션: 1.6,
};

/* ------------------------------------------------------------------------------------------ platforms */

interface PlatformCfg {
  accounts: number;
  /** Relative upload activity (uploads per account over the sample period). */
  activity: [number, number];
  /** Median views per video at saturation (account scale median). */
  scaleMedian: number;
  tauHours: [number, number];
  /** Collector run interval for this source. */
  runEveryHours: number;
  discoveryDelayHours: [number, number];
  langs: { lang: string; country: string | null; weight: number }[];
  followers: boolean;
}

const PLATFORM_CFG: Record<'youtube' | 'tiktok' | 'dailymotion' | 'niconico' | 'peertube', PlatformCfg> = {
  youtube: {
    accounts: 70,
    activity: [4, 26],
    scaleMedian: 26_000,
    tauHours: [30, 90],
    runEveryHours: 3,
    discoveryDelayHours: [0.2, 5],
    langs: [
      { lang: 'ko', country: 'KR', weight: 0.86 },
      { lang: 'en', country: 'US', weight: 0.08 },
      { lang: 'ja', country: 'JP', weight: 0.06 },
    ],
    followers: true,
  },
  tiktok: {
    accounts: 40,
    activity: [10, 40],
    scaleMedian: 60_000,
    tauHours: [16, 40],
    runEveryHours: 6,
    discoveryDelayHours: [2, 30],
    langs: [
      { lang: 'ko', country: 'KR', weight: 0.9 },
      { lang: 'en', country: 'US', weight: 0.1 },
    ],
    followers: true,
  },
  dailymotion: {
    accounts: 30,
    activity: [5, 24],
    scaleMedian: 2_400,
    tauHours: [48, 130],
    runEveryHours: 3,
    discoveryDelayHours: [1, 14],
    langs: [
      { lang: 'ko', country: 'KR', weight: 0.55 },
      { lang: 'fr', country: 'FR', weight: 0.3 },
      { lang: 'en', country: 'US', weight: 0.15 },
    ],
    followers: true,
  },
  niconico: {
    accounts: 35,
    activity: [3, 16],
    scaleMedian: 6_500,
    tauHours: [40, 110],
    runEveryHours: 24,
    discoveryDelayHours: [0, 0],
    langs: [
      { lang: 'ja', country: null, weight: 0.85 },
      { lang: 'ko', country: null, weight: 0.15 },
    ],
    followers: false,
  },
  peertube: {
    accounts: 25,
    activity: [1, 10],
    scaleMedian: 260,
    tauHours: [60, 160],
    runEveryHours: 6,
    discoveryDelayHours: [6, 48],
    langs: [
      { lang: 'en', country: null, weight: 0.45 },
      { lang: 'fr', country: null, weight: 0.3 },
      { lang: 'ko', country: null, weight: 0.25 },
    ],
    followers: true,
  },
};

type SamplePlatform = keyof typeof PLATFORM_CFG;
const SAMPLE_PLATFORMS: SamplePlatform[] = ['youtube', 'dailymotion', 'niconico', 'peertube', 'tiktok'];

const SRC = {
  ytApi: 'youtube-data-api@1',
  ytRss: 'youtube-rss@1',
  tiktok: 'tiktok-research@1',
  dailymotion: 'dailymotion-api@1',
  niconico: 'niconico-snapshot@2',
  peertube: 'peertube-api@1',
} as const;

/* ------------------------------------------------------------------------------------------ options */

export interface SampleOptions {
  seed?: number;
  generatedAt?: number;
  /** Target number of videos (default 2500). */
  videos?: number;
  /** Days of observation history (default 60). */
  days?: number;
}

interface AccountSeed {
  account: Account;
  platform: SamplePlatform;
  category: TopCategory;
  lang: string;
  scale: number;
  activity: number;
  /** YouTube channels tracked only via RSS (views + likes, no comments/subscribers). */
  rssOnly: boolean;
  onboardedAt: number;
}

/* ------------------------------------------------------------------------------------------ helpers */

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const B64 = `${ALNUM}-_`;
const HEX = '0123456789abcdef';

function nativeId(rng: Rng, p: SamplePlatform): string {
  switch (p) {
    case 'youtube':
      return rng.chars(B64, 11);
    case 'tiktok':
      return `7${rng.chars('0123456789', 18)}`;
    case 'dailymotion':
      return `x${rng.chars('abcdefghijklmnopqrstuvwxyz0123456789', 6)}`;
    case 'niconico':
      return `sm${rng.int(40_000_000, 45_999_999)}`;
    case 'peertube':
      return `${rng.chars(HEX, 8)}-${rng.chars(HEX, 4)}-4${rng.chars(HEX, 3)}-${rng.chars('89ab', 1)}${rng.chars(HEX, 3)}-${rng.chars(HEX, 12)}`;
  }
}

function fill(template: string, topic: string, rng: Rng): string {
  return template.replace('{t}', topic).replace('{n}', String(rng.int(1, 30)));
}

function roundSig(n: number, digits: number): number {
  if (n <= 0) return 0;
  const p = 10 ** Math.max(0, Math.floor(Math.log10(n)) + 1 - digits);
  return Math.round(n / p) * p;
}

function langOf(rng: Rng, cfg: PlatformCfg) {
  return rng.weighted(cfg.langs, cfg.langs.map((l) => l.weight));
}

function topicsFor(cat: TopCategory, lang: string): string[] {
  if (lang === 'ja') return JA_TOPICS[cat] ?? JA_TOPICS.entertainment!;
  if (lang === 'en' || lang === 'fr') return EN_TOPICS[cat] ?? EN_TOPICS.lifestyle!;
  return KO_TOPICS[cat];
}

/** Children of a top-level taxonomy node, if the taxonomy is loaded. */
function childrenOf(top: string): { id: string; keywords: string[] }[] {
  return (Array.isArray(TAXONOMY) ? TAXONOMY : [])
    .filter((n) => n.parent === top)
    .map((n) => ({ id: n.id, keywords: (n.keywords ?? []).map((k) => k.toLowerCase()) }));
}

/**
 * Keyword vs topic match: exact, or containment when the shorter side is specific enough
 * (>= 2 non-ASCII chars, or >= 4 ASCII chars) so `ai` does not match `hair`.
 */
export function keywordMatches(keyword: string, topic: string): boolean {
  const kw = keyword.replace(/\s+/g, '');
  const tp = topic.replace(/\s+/g, '');
  if (!kw || !tp) return false;
  if (kw === tp) return true;
  const shorter = kw.length <= tp.length ? kw : tp;
  const longer = shorter === kw ? tp : kw;
  const ascii = /^[\x00-\x7f]+$/.test(shorter);
  if (shorter.length < (ascii ? 4 : 2)) return false;
  return longer.includes(shorter);
}

/* ------------------------------------------------------------------------------------------ growth model */

interface GrowthModel {
  publishedAt: number;
  vInf: number;
  tauH: number;
  /** Initial long-tail rate (views/day) that decays with `tailTauDays` (search / recommendation tail). */
  tailPerDay: number;
  tailTauDays: number;
  retrend: { t0: number; widthH: number; amount: number } | null;
  decrease: { at: number; factor: number } | null;
  likeRatio: number;
  commentRatio: number;
  shareRatio: number;
}

function viewsAt(m: GrowthModel, t: number): number {
  if (t <= m.publishedAt) return 0;
  const ageH = (t - m.publishedAt) / HOUR;
  const ageD = ageH / 24;
  let v = m.vInf * (1 - Math.exp(-ageH / m.tauH)) + m.tailPerDay * m.tailTauDays * (1 - Math.exp(-ageD / m.tailTauDays));
  if (m.retrend) {
    const x = (t - m.retrend.t0) / (m.retrend.widthH * HOUR);
    const start = 1 / (1 + Math.exp(-((m.publishedAt - m.retrend.t0) / (m.retrend.widthH * HOUR))));
    v += m.retrend.amount * Math.max(0, 1 / (1 + Math.exp(-x)) - start);
  }
  if (m.decrease && t >= m.decrease.at) v *= m.decrease.factor;
  return Math.max(0, Math.round(v));
}

/* ------------------------------------------------------------------------------------------ observation schedule */

function refreshIntervalHours(ageH: number): number {
  if (ageH < 72) return 0; // every run
  if (ageH < 14 * 24) return 12;
  if (ageH < 90 * 24) return 24;
  return 24 * 7;
}

/**
 * Observation instants for a video: collector runs on a UTC grid (every `runEveryHours`, aligned so that
 * 15:00 UTC = 00:00 KST is always a run), tiered by video age. niconico: one daily snapshot at ~20:00 UTC.
 */
function observationTimes(opts: {
  platform: SamplePlatform;
  publishedAt: number;
  firstSeen: number;
  endAt: number;
  runEveryHours: number;
  outage: { from: number; to: number } | null;
  rng: Rng;
}): number[] {
  const { platform, publishedAt, firstSeen, endAt, runEveryHours, outage, rng } = opts;
  const out: number[] = [];
  if (platform === 'niconico') {
    // Daily snapshot (observation time = snapshot last_modified ~ 05:00 JST = 20:00 UTC).
    let day = Math.floor((firstSeen - 20 * HOUR) / DAY) * DAY + 20 * HOUR;
    if (day < firstSeen) day += DAY;
    for (let t = day; t <= endAt; t += DAY) out.push(t + Math.round(rng.uniform(-8, 8)) * 60_000);
    return out.filter((t) => t >= firstSeen && t <= endAt);
  }
  const step = runEveryHours * HOUR;
  // Grid anchored at 15:00 UTC (KST midnight).
  const anchor = 15 * HOUR;
  let t = Math.ceil((firstSeen - anchor) / step) * step + anchor;
  let last = -Infinity;
  for (; t <= endAt; t += step) {
    if (outage && t >= outage.from && t < outage.to) continue;
    const ageH = (t - publishedAt) / HOUR;
    const every = refreshIntervalHours(ageH);
    if (every === 0 || out.length === 0) {
      out.push(t);
      last = t;
      continue;
    }
    const kstMidnight = ((t - anchor) % DAY + DAY) % DAY === 0;
    if (every === 12 && (t - last >= 12 * HOUR - 1 || kstMidnight)) {
      if (t - last >= 6 * HOUR) {
        out.push(t);
        last = t;
      }
    } else if (every === 24 && kstMidnight) {
      out.push(t);
      last = t;
    } else if (every === 24 * 7 && kstMidnight && t - last >= 7 * DAY - 1) {
      out.push(t);
      last = t;
    }
  }
  // The very last collector run always refreshes the newest state for young videos.
  return out;
}

/** SPEC export compaction: all points in the last 72h, <=1 per 6h for 3–14 days, <=1/day 14–90, <=1/week older; keep first/last and KST-midnight points. */
export function compactObservations(times: number[], now: number): number[] {
  if (times.length <= 2) return times;
  const kept: number[] = [];
  const seenBucket = new Set<string>();
  const anchor = 15 * HOUR;
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    const age = now - t;
    const isEdge = i === 0 || i === times.length - 1;
    const kstMidnight = Math.abs((((t - anchor) % DAY) + DAY) % DAY) < 20 * 60_000 || Math.abs((((t - anchor) % DAY) + DAY) % DAY - DAY) < 20 * 60_000;
    if (isEdge || age <= 72 * HOUR) {
      kept.push(t);
      continue;
    }
    let bucket: string;
    if (age <= 14 * DAY) bucket = `6h:${Math.floor(t / (6 * HOUR))}`;
    else if (age <= 90 * DAY) bucket = `d:${Math.floor((t - anchor) / DAY)}`;
    else bucket = `w:${Math.floor((t - anchor) / (7 * DAY))}`;
    if (kstMidnight && age <= 90 * DAY) {
      // KST day boundaries are always kept (daily windows stay exact).
      kept.push(t);
      seenBucket.add(bucket);
      continue;
    }
    if (seenBucket.has(bucket)) continue;
    seenBucket.add(bucket);
    kept.push(t);
  }
  return kept;
}

/* ------------------------------------------------------------------------------------------ main */

export function generateSampleDataset(opts: SampleOptions = {}): Dataset {
  const seed = opts.seed ?? SAMPLE_SEED;
  const generatedAt = opts.generatedAt ?? SAMPLE_GENERATED_AT;
  const targetVideos = opts.videos ?? 2500;
  const days = opts.days ?? 60;
  const trackStart = generatedAt - days * DAY;
  const rng = createRng(seed);

  /* ---------- accounts & creators ---------- */
  const seeds: AccountSeed[] = [];
  const usedNames = new Set<string>();
  let accSeq = 0;
  const makeAccount = (platform: SamplePlatform, category: TopCategory, forcedName?: string, lang?: { lang: string; country: string | null }): AccountSeed => {
    const cfg = PLATFORM_CFG[platform];
    const l = lang ?? langOf(rng, cfg);
    let name = forcedName;
    if (!name) {
      for (let tries = 0; tries < 20; tries++) {
        const label = rng.pick(CHANNEL_LABELS[category]);
        const candidate =
          l.lang === 'ja' ? `샘플 ${rng.pick(PERSON_JA)}${label}チャンネル` : l.lang === 'ko' ? `샘플 ${rng.pick(PERSON_KO)}의 ${label}` : `샘플 ${rng.pick(PERSON_EN)} ${label}`;
        if (!usedNames.has(`${platform}:${candidate}`)) {
          name = candidate;
          break;
        }
        name = `${candidate} ${accSeq}`;
      }
    }
    usedNames.add(`${platform}:${name}`);
    accSeq++;
    const platformId = platform === 'youtube' ? `UC${rng.chars(B64, 22)}` : platform === 'tiktok' ? `sample_${accSeq}` : platform === 'niconico' ? String(rng.int(1_000_000, 99_999_999)) : `sample${accSeq}`;
    const id = `${platform}:${platformId}`;
    const onboardedAt = trackStart + Math.floor(rng.uniform(0, 10)) * DAY;
    const scale = rng.logNormal(cfg.scaleMedian, 1.05);
    const account: Account = {
      id,
      platform,
      platformId,
      handle: platform === 'niconico' ? null : `@sample_${platform}_${accSeq}`,
      name: name!,
      url: `https://example.com/sample/${platform}/channel/${encodeURIComponent(platformId)}`,
      avatar: null,
      country: platform === 'niconico' || platform === 'peertube' ? null : l.country,
      followers: [],
      creatorId: null,
      seedCategory: category,
      trackedSince: onboardedAt,
      discoveredVia: [platform === 'youtube' ? 'seed-channel' : platform === 'niconico' ? 'niconico:snapshot:tag' : platform === 'peertube' ? 'sepiasearch:query' : platform === 'tiktok' ? 'tiktok-research:region:KR' : 'dailymotion:visited-week:kr'],
    };
    const s: AccountSeed = {
      account,
      platform,
      category,
      lang: l.lang,
      scale,
      activity: rng.uniform(cfg.activity[0], cfg.activity[1]),
      rssOnly: platform === 'youtube' && rng.chance(0.3),
      onboardedAt,
    };
    seeds.push(s);
    return s;
  };

  // Multi-platform creators (a share of the account budget).
  const creatorPlans: { name: string; category: TopCategory; platforms: SamplePlatform[]; linkStatus: Creator['linkStatus'] }[] = [
    { name: '샘플 요리하는 민지', category: 'food', platforms: ['youtube', 'tiktok'], linkStatus: 'verified' },
    { name: '샘플 테크 하린', category: 'science_tech', platforms: ['youtube', 'tiktok', 'dailymotion'], linkStatus: 'verified' },
    { name: '샘플 게임하는 태오', category: 'gaming', platforms: ['youtube', 'niconico'], linkStatus: 'verified' },
    { name: '샘플 여행가 서연', category: 'travel', platforms: ['youtube', 'peertube'], linkStatus: 'verified' },
    { name: '샘플 뷰티 유나', category: 'beauty', platforms: ['youtube', 'tiktok'], linkStatus: 'verified' },
    { name: '샘플 댕냥 로아', category: 'pets_animals', platforms: ['tiktok', 'dailymotion'], linkStatus: 'verified' },
    { name: '샘플 노래하는 시우', category: 'music', platforms: ['youtube', 'niconico', 'tiktok'], linkStatus: 'verified' },
    { name: '샘플 러닝 도윤', category: 'health_fitness', platforms: ['youtube', 'tiktok'], linkStatus: 'suggested' },
  ];
  const creators: Creator[] = [];
  const creatorAccountCount: Record<SamplePlatform, number> = { youtube: 0, tiktok: 0, dailymotion: 0, niconico: 0, peertube: 0 };
  creatorPlans.forEach((plan, i) => {
    const id = `creator:sample-${i + 1}`;
    const accountIds: string[] = [];
    for (const p of plan.platforms) {
      const lang = p === 'niconico' ? { lang: 'ja', country: null } : { lang: 'ko', country: p === 'peertube' ? null : 'KR' };
      const s = makeAccount(p, plan.category, `${plan.name}${p === 'youtube' ? '' : ` (${p === 'niconico' ? 'ニコニコ' : p})`}`, lang);
      s.account.creatorId = id;
      s.scale *= 1.6; // creators with portfolios tend to be larger
      accountIds.push(s.account.id);
      creatorAccountCount[p]++;
    }
    creators.push({
      id,
      name: plan.name,
      accountIds,
      linkStatus: plan.linkStatus,
      note: plan.linkStatus === 'suggested' ? '계정 이름이 비슷해 자동으로 제안된 연결 (확인 전)' : '샘플: 수동 확인한 연결로 가정',
    });
  });

  for (const p of SAMPLE_PLATFORMS) {
    const n = PLATFORM_CFG[p].accounts - creatorAccountCount[p];
    for (let i = 0; i < n; i++) {
      const cat = rng.weighted(TOP_LEVEL_CATEGORY_IDS, TOP_LEVEL_CATEGORY_IDS.map((c) => (['food', 'gaming', 'beauty', 'music', 'entertainment', 'lifestyle', 'science_tech'].includes(c) ? 2 : 1)));
      makeAccount(p, cat);
    }
  }
  // One small account that suddenly goes viral (the "작은 채널의 첫 급등" scenario).
  const smallViral = seeds.find((s) => s.platform === 'youtube' && !s.account.creatorId && s.category === 'howto_diy') ?? seeds.find((s) => s.platform === 'youtube' && !s.account.creatorId)!;
  smallViral.scale = Math.min(smallViral.scale, 1_500);

  /* ---------- allocate videos to accounts (largest remainder) ---------- */
  const totalActivity = seeds.reduce((a, s) => a + s.activity, 0);
  const quotas = seeds.map((s) => (s.activity / totalActivity) * targetVideos);
  const counts = quotas.map((q) => Math.floor(q));
  let remaining = targetVideos - counts.reduce((a, b) => a + b, 0);
  const order = quotas.map((q, i) => ({ i, r: q - Math.floor(q) })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; remaining > 0; k = (k + 1) % order.length, remaining--) counts[order[k].i]++;

  /* ---------- videos ---------- */
  const videos: Video[] = [];
  const usedIds = new Set<string>();
  let viralPlaced = false;

  seeds.forEach((s, si) => {
    const cfg = PLATFORM_CFG[s.platform];
    for (let k = 0; k < counts[si]; k++) {
      // Publish time: 82% during the tracked period, 18% older (tracked from onboarding).
      const older = rng.chance(0.18);
      let publishedAt = older
        ? generatedAt - Math.floor(rng.uniform(days + 1, days + 120) * DAY)
        : trackStart + Math.floor(rng.uniform(0, days * DAY - HOUR));
      // Uploads cluster in the local afternoon/evening (KST 11:00–23:00 = 02:00–14:00 UTC).
      const d0 = Math.floor(publishedAt / DAY) * DAY;
      publishedAt = d0 + Math.floor(rng.uniform(2, 14) * HOUR) + rng.int(0, 59) * 60_000;
      if (publishedAt > generatedAt - 30 * 60_000) publishedAt -= DAY;

      // Category: mostly the account's, sometimes a related one.
      const related = RELATED[s.category];
      const cat: TopCategory = related && rng.chance(0.12) ? rng.pick(related) : s.category;
      const daysAgo = (generatedAt - publishedAt) / DAY;
      const pool = topicsFor(cat, s.lang);
      const weights = pool.map((t) => topicProfile(t, daysAgo) * (TOPIC_SUPPLY[t] ?? 1));
      const t1 = rng.weighted(pool, weights);
      const topics = [t1];
      if (rng.chance(0.55)) {
        const t2 = rng.weighted(pool, weights);
        if (t2 !== t1) topics.push(t2);
      }

      // Title.
      let title: string;
      if (s.lang === 'ja') title = fill(rng.pick(JA_TEMPLATES), t1, rng);
      else if (s.lang === 'en' || s.lang === 'fr') title = fill(rng.pick(EN_TEMPLATES), t1, rng);
      else title = fill(rng.pick([...(KO_TEMPLATES_BY_CAT[cat] ?? []), ...KO_GENERIC]), t1, rng);

      // Format & duration.
      let format: VideoFormat = 'long';
      let durationSec: number | null;
      if (s.platform === 'tiktok') {
        format = 'short';
        durationSec = rng.int(9, 95);
      } else if (s.platform === 'youtube') {
        const r = rng.next();
        if (r < 0.3) {
          format = 'short';
          durationSec = rng.int(12, 179);
        } else if (r < 0.33) {
          format = 'live';
          durationSec = rng.int(3600, 4 * 3600);
        } else durationSec = rng.int(240, 2400);
        if (s.rssOnly) durationSec = null; // RSS does not provide duration
      } else if (s.platform === 'niconico') durationSec = rng.int(180, 1800);
      else if (s.platform === 'dailymotion') durationSec = rng.int(90, 1200);
      else durationSec = rng.int(300, 3600);
      if (format === 'short') title = rng.chance(0.4) ? `${title} #shorts` : title;

      // Sponsorship (fictional brands).
      let sponsorship: SponsorshipSignal | null = null;
      let description = s.lang === 'ko' ? `${title} 영상입니다. #${t1}${topics[1] ? ` #${topics[1]}` : ''}` : `${title} #${t1}`;
      const sponsorBias = ['beauty', 'fashion', 'food', 'science_tech', 'gaming'].includes(cat) ? 2 : 1;
      const sr = rng.next();
      if (s.lang === 'ko' && sr < 0.045 * sponsorBias) {
        const brand = rng.pick(BRANDS.filter((b) => b.cats.includes(cat)).length ? BRANDS.filter((b) => b.cats.includes(cat)) : BRANDS);
        title = rng.chance(0.5) ? `(광고) ${title}` : title;
        description = `유료 광고 포함 | 본 영상은 ${brand.name}로부터 제품을 제공받아 제작되었습니다. ${description}`;
        sponsorship = {
          level: 'disclosed',
          brands: [brand.name],
          evidence: [
            { field: title.startsWith('(광고)') ? 'title' : 'description', match: title.startsWith('(광고)') ? '(광고)' : '유료 광고 포함' },
            { field: 'description', match: brand.name },
          ],
          version: SPONSORSHIP_VERSION,
        };
      } else if (s.lang === 'ko' && sr < 0.045 * sponsorBias + 0.03) {
        const brand = rng.pick(BRANDS);
        description = `${description} ${brand.name} 할인코드 SAMPLE10 (고정 댓글 링크 참고)`;
        sponsorship = {
          level: 'likely',
          brands: [brand.name],
          evidence: [
            { field: 'description', match: '할인코드' },
            { field: 'description', match: brand.name },
          ],
          version: SPONSORSHIP_VERSION,
        };
      }

      // Categories with evidence.
      const sourceCategory =
        s.platform === 'dailymotion' ? (DM_CHANNEL[cat] ?? null) : s.platform === 'peertube' ? (PT_CATEGORY[cat] ?? null) : s.platform === 'niconico' ? (NICO_GENRE[cat] ?? null) : s.platform === 'youtube' && !s.rssOnly ? (YT_CATEGORY[cat] ?? null) : null;
      const categories: CategoryAssignment[] = [];
      const primaryEvidence: CategoryAssignment['evidence'] = [{ field: 'tags', match: t1 }];
      if (cat === s.category) primaryEvidence.push({ field: 'account', match: s.category });
      if (sourceCategory) primaryEvidence.push({ field: 'sourceCategory', match: `${s.platform}:${sourceCategory}` });
      categories.push({
        id: cat,
        confidence: Math.round(rng.uniform(0.62, 0.97) * 100) / 100,
        evidence: primaryEvidence,
        by: 'rule',
        version: CLASSIFIER_VERSION,
      });
      // Subcategory only when a taxonomy keyword really matches a topic (evidence-based, like the classifier).
      const subConfidence = Math.round(rng.uniform(0.5, 0.9) * 100) / 100;
      for (const child of childrenOf(cat)) {
        const hit = child.keywords.find((kw) => topics.some((tp) => keywordMatches(kw, tp.toLowerCase())));
        if (hit) {
          categories.push({ id: child.id, confidence: subConfidence, evidence: [{ field: 'tags', match: hit }], by: 'rule', version: CLASSIFIER_VERSION });
          break;
        }
      }
      if (related && cat === s.category && rng.chance(0.14)) {
        const second = rng.pick(related);
        categories.push({ id: second, confidence: Math.round(rng.uniform(0.35, 0.6) * 100) / 100, evidence: [{ field: 'title', match: t1 }], by: 'rule', version: CLASSIFIER_VERSION });
      }

      // Growth model.
      const profileAtPublish = topicProfile(t1, daysAgo);
      let vInf = s.scale * rng.logNormal(1, 0.95) * Math.sqrt(profileAtPublish) * (TOPIC_DEMAND[t1] ?? 1);
      if (format === 'short' && s.platform === 'youtube') vInf *= 1.8;
      if (format === 'live') vInf *= 0.6;
      if (s === smallViral && !viralPlaced && daysAgo < 6 && daysAgo > 1.5) {
        vInf = s.scale * 180; // first viral hit of a small channel
        viralPlaced = true;
      }
      const tauH = rng.uniform(cfg.tauHours[0], cfg.tauHours[1]);
      let retrend: GrowthModel['retrend'] = null;
      const seasonal = RETREND_TOPICS.has(t1) && daysAgo > 20;
      if (seasonal || (daysAgo > 20 && rng.chance(0.035))) {
        retrend = {
          t0: generatedAt - (seasonal ? rng.uniform(2, 6) : rng.uniform(2, 16)) * DAY,
          widthH: rng.uniform(10, 40),
          amount: vInf * (seasonal ? rng.uniform(1.2, 4) : rng.uniform(0.5, 2.5)),
        };
      }
      const decrease = rng.chance(0.007)
        ? { at: generatedAt - rng.uniform(0.5, 20) * DAY, factor: rng.uniform(0.82, 0.97) }
        : null;
      const model: GrowthModel = {
        publishedAt,
        vInf,
        tauH,
        tailPerDay: vInf * rng.uniform(0.0015, 0.01),
        // Seasonal topics whose season is over lose their tail quickly (they show up as "falling").
        tailTauDays: FADING_TOPICS.has(t1) ? rng.uniform(5, 10) : rng.uniform(20, 60),
        retrend,
        decrease: decrease && decrease.at > publishedAt + DAY ? decrease : null,
        likeRatio: s.platform === 'tiktok' ? rng.uniform(0.05, 0.12) : rng.uniform(0.015, 0.06),
        commentRatio: rng.uniform(0.0008, 0.005),
        shareRatio: rng.uniform(0.002, 0.02),
      };

      // Discovery & observation schedule.
      const lateDiscovery = rng.chance(0.08);
      const discoveredAt = Math.max(
        publishedAt + (lateDiscovery ? rng.uniform(3, 12) * DAY : rng.uniform(cfg.discoveryDelayHours[0], cfg.discoveryDelayHours[1]) * HOUR),
        s.onboardedAt,
      );
      if (discoveredAt >= generatedAt) continue;
      const statusRoll = rng.next();
      const status: Video['status'] = statusRoll < 0.01 ? 'deleted' : statusRoll < 0.015 ? 'private' : 'active';
      const endAt = status === 'active' ? generatedAt : Math.max(discoveredAt + DAY, generatedAt - rng.uniform(0.5, 25) * DAY);
      const outage = s.platform === 'peertube' && rng.chance(0.2) ? (() => {
        const from = generatedAt - rng.uniform(4, 30) * DAY;
        return { from, to: from + rng.uniform(2.5, 5) * DAY };
      })() : null;
      const rawTimes = observationTimes({ platform: s.platform, publishedAt, firstSeen: discoveredAt, endAt: Math.min(endAt, generatedAt), runEveryHours: cfg.runEveryHours, outage, rng });
      const times = compactObservations(rawTimes, generatedAt);
      if (times.length === 0) continue;
      // Dailymotion's discovery pass (sort=visited-week) re-fetches popular older videos on every run,
      // so some daily-tier videos also have a fresh observation (with source windows) at export time.
      if (s.platform === 'dailymotion' && status === 'active' && times[times.length - 1] < generatedAt - HOUR && rng.chance(0.35)) {
        times.push(generatedAt);
      }

      const hideLikes = (s.platform === 'youtube' && rng.chance(0.08)) || (s.platform === 'peertube' && rng.chance(0.05));
      const src = s.platform === 'youtube' ? (s.rssOnly ? SRC.ytRss : SRC.ytApi) : s.platform === 'tiktok' ? SRC.tiktok : s.platform === 'dailymotion' ? SRC.dailymotion : s.platform === 'niconico' ? SRC.niconico : SRC.peertube;
      const obs: ObservationPoint[] = times.map((t) => {
        const views = viewsAt(model, t);
        const likes = hideLikes ? null : Math.round(views * model.likeRatio);
        const comments = s.platform === 'youtube' ? (s.rssOnly ? null : Math.round(views * model.commentRatio)) : s.platform === 'tiktok' || s.platform === 'niconico' ? Math.round(views * model.commentRatio) : null;
        const shares = s.platform === 'tiktok' ? Math.round(views * model.shareRatio) : null;
        return { t, views, likes, comments, shares, src };
      });

      // Dailymotion source windows at the latest observation.
      const sourceWindows: SourceWindowMetric[] = [];
      const lastT = times[times.length - 1];
      if (s.platform === 'dailymotion' && generatedAt - lastT <= 3 * HOUR) {
        for (const [hours] of [[24], [168], [720]] as const) {
          sourceWindows.push({ metric: 'views', windowHours: hours, value: Math.max(0, viewsAt(model, lastT) - viewsAt(model, lastT - hours * HOUR)), observedAt: lastT, src: SRC.dailymotion });
        }
      }

      let pid = nativeId(rng, s.platform);
      while (usedIds.has(`${s.platform}:${pid}`)) pid = nativeId(rng, s.platform);
      const id = `${s.platform}:${pid}`;
      usedIds.add(id);
      const tags = [...new Set([...topics, ...(format === 'short' ? ['shorts'] : [])])];
      videos.push({
        id,
        platform: s.platform,
        platformId: pid,
        url: `https://example.com/sample/${s.platform}/video/${encodeURIComponent(pid)}`,
        title,
        description: description.slice(0, 300),
        thumbnail: null,
        publishedAt,
        durationSec,
        format,
        accountId: s.account.id,
        language: s.lang,
        languageSource: s.platform === 'dailymotion' || s.platform === 'peertube' ? 'source' : 'detected',
        country: s.account.country,
        sourceCategory,
        tags,
        categories,
        topics: tags.filter((t) => t !== 'shorts').map((t) => t.toLowerCase()),
        sponsorship,
        status,
        firstSeenAt: times[0],
        lastObservedAt: lastT,
        discoveredVia: lateDiscovery ? [...s.account.discoveredVia, 'search:late-discovery'] : s.account.discoveredVia,
        obs,
        sourceWindows,
      });
    }
  });
  videos.sort((a, b) => a.publishedAt - b.publishedAt || a.id.localeCompare(b.id));

  /* ---------- followers ---------- */
  for (const s of seeds) {
    const hasFollowers = PLATFORM_CFG[s.platform].followers && !(s.platform === 'youtube' && s.rssOnly);
    s.account.trackedSince = Math.min(s.onboardedAt, ...videos.filter((v) => v.accountId === s.account.id).map((v) => v.firstSeenAt));
    if (!hasFollowers) continue;
    const base = s.scale * rng.uniform(2, 14);
    const growth = rng.uniform(-0.0003, 0.004);
    const pts: FollowerPoint[] = [];
    const srcF = s.platform === 'youtube' ? SRC.ytApi : s.platform === 'tiktok' ? SRC.tiktok : s.platform === 'dailymotion' ? SRC.dailymotion : SRC.peertube;
    for (let t = Math.ceil((s.account.trackedSince - 15 * HOUR) / DAY) * DAY + 15 * HOUR; t <= generatedAt; t += DAY) {
      const d = (t - trackStart) / DAY;
      let v = base * (1 + growth * d) * (1 + 0.002 * Math.sin(d));
      if (s === smallViral && generatedAt - t < 5 * DAY) v *= 1 + (5 - (generatedAt - t) / DAY) * 0.6;
      v = Math.max(0, Math.round(v));
      // YouTube reports subscriber counts rounded to 3 significant digits.
      pts.push({ t, value: s.platform === 'youtube' ? roundSig(v, 3) : v, src: srcF });
    }
    s.account.followers = pts;
  }

  const accounts = seeds.map((s) => s.account);

  /* ---------- coverage ---------- */
  const countBy = (pred: (v: Video) => boolean) => videos.filter(pred).length;
  const accountsBy = (pred: (s: AccountSeed) => boolean) => seeds.filter(pred).length;
  const lastRun = (everyH: number, offsetMin = 0) => Math.floor((generatedAt - 15 * HOUR) / (everyH * HOUR)) * everyH * HOUR + 15 * HOUR + offsetMin * 60_000;
  const rssSeedIds = new Set(seeds.filter((s) => s.platform === 'youtube' && s.rssOnly).map((s) => s.account.id));
  const coverage: SourceCoverage[] = [
    {
      source: 'youtube-rss',
      platform: 'youtube',
      label: 'YouTube RSS 피드',
      enabled: true,
      requiresCredentials: false,
      discovery: '시드 채널 목록의 채널별 최근 업로드 15개(RSS 피드)',
      metrics: ['views', 'likes'],
      firstRunAt: trackStart,
      lastRunAt: lastRun(3),
      lastSuccessAt: lastRun(3),
      lastStatus: 'ok',
      lastError: null,
      videoCount: countBy((v) => rssSeedIds.has(v.accountId)),
      accountCount: rssSeedIds.size,
      notes: ['RSS는 채널당 최근 15개 영상만 제공: 목록에서 밀려난 영상은 다른 원천이 없으면 갱신이 멈춤.', '좋아요는 피드의 starRating count 기준이며 숨긴 채널은 값 없음(null).', '길이·댓글·구독자 수는 제공하지 않음.'],
      docsUrl: null,
    },
    {
      source: 'youtube-data-api',
      platform: 'youtube',
      label: 'YouTube Data API',
      enabled: true,
      requiresCredentials: true,
      discovery: '키워드 시드 검색(regionCode KR, relevanceLanguage ko) + 시드 채널, videos.list로 통계 갱신',
      metrics: ['views', 'likes', 'comments'],
      firstRunAt: trackStart,
      lastRunAt: lastRun(3),
      lastSuccessAt: lastRun(3),
      lastStatus: 'ok',
      lastError: null,
      videoCount: countBy((v) => v.platform === 'youtube' && !rssSeedIds.has(v.accountId)),
      accountCount: accountsBy((s) => s.platform === 'youtube' && !s.rssOnly),
      notes: ['2025년 3월부터 Shorts 조회수는 재생 시작·반복 재생을 포함하도록 집계 방식이 바뀜: 이전 기간과 직접 비교 주의.', '구독자 수는 원천에서 3자리 유효숫자로 반올림되어 제공됨.', '샘플 데이터에서는 API 키가 있다고 가정함.'],
      docsUrl: 'https://developers.google.com/youtube/v3/docs/videos',
    },
    {
      source: 'dailymotion',
      platform: 'dailymotion',
      label: 'Dailymotion API',
      enabled: true,
      requiresCredentials: false,
      discovery: '채널·국가·언어·정렬(visited-week) 시드로 /videos 검색, ids= 로 갱신',
      metrics: ['views', 'likes'],
      firstRunAt: trackStart,
      lastRunAt: lastRun(3),
      lastSuccessAt: lastRun(3),
      lastStatus: 'ok',
      lastError: null,
      videoCount: countBy((v) => v.platform === 'dailymotion'),
      accountCount: accountsBy((s) => s.platform === 'dailymotion'),
      notes: ['views_last_day/week/month 원천 기간값을 제공: 관측으로 계산할 수 없는 기간 증가에 “원천” 표시로 사용.'],
      docsUrl: 'https://developers.dailymotion.com/api/',
    },
    {
      source: 'niconico',
      platform: 'niconico',
      label: 'niconico 스냅샷 검색 API v2',
      enabled: true,
      requiresCredentials: false,
      discovery: '태그·키워드 시드로 스냅샷 검색(하루 1회 생성되는 스냅샷)',
      metrics: ['views', 'likes', 'comments'],
      firstRunAt: trackStart,
      lastRunAt: lastRun(3),
      lastSuccessAt: Math.floor((generatedAt - 20 * HOUR) / DAY) * DAY + 20 * HOUR,
      lastStatus: 'ok',
      lastError: null,
      videoCount: countBy((v) => v.platform === 'niconico'),
      accountCount: accountsBy((s) => s.platform === 'niconico'),
      notes: ['관측 시각은 수집 시각이 아니라 스냅샷 생성 시각(last_modified, 매일 05:00 JST 전후).', '업로드 국가는 제공하지 않음.'],
      docsUrl: 'https://site.nicovideo.jp/search-api-docs/snapshot',
    },
    {
      source: 'peertube',
      platform: 'peertube',
      label: 'PeerTube (SepiaSearch)',
      enabled: true,
      requiresCredentials: false,
      discovery: 'SepiaSearch 검색으로 발견, 원 인스턴스 /api/v1/videos/{uuid} 로 갱신',
      metrics: ['views', 'likes'],
      firstRunAt: trackStart,
      lastRunAt: lastRun(6),
      lastSuccessAt: lastRun(6),
      lastStatus: 'partial',
      lastError: '일부 인스턴스 응답 없음 (3/41 인스턴스, timeout 20s)',
      videoCount: countBy((v) => v.platform === 'peertube'),
      accountCount: accountsBy((s) => s.platform === 'peertube'),
      notes: ['인스턴스 장애 동안 관측 공백이 생김: 해당 기간 값은 하한 또는 계산 불가로 표시.', '조회수 집계 방식은 인스턴스 설정에 따라 다를 수 있음.'],
      docsUrl: 'https://docs.joinpeertube.org/api-rest-reference.html',
    },
    {
      source: 'tiktok-research',
      platform: 'tiktok',
      label: 'TikTok Research API',
      enabled: true,
      requiresCredentials: true,
      discovery: '연구용 API 영상 조회(지역 KR, 키워드·해시태그 시드)',
      metrics: ['views', 'likes', 'comments', 'shares'],
      firstRunAt: trackStart,
      lastRunAt: lastRun(6),
      lastSuccessAt: lastRun(6),
      lastStatus: 'ok',
      lastError: null,
      videoCount: countBy((v) => v.platform === 'tiktok'),
      accountCount: accountsBy((s) => s.platform === 'tiktok'),
      notes: ['승인이 필요한 API: 샘플 데이터에서는 승인·인증 정보가 있다고 가정함.', '지표 반영이 최대 48시간 늦을 수 있음.'],
      docsUrl: 'https://developers.tiktok.com/doc/research-api-specs-query-videos',
    },
    ...(
      [
        ['instagram-graph', 'instagram', 'Instagram Graph API', 'IG_ACCESS_TOKEN, IG_USER_ID', ['likes', 'comments']],
        ['x-api', 'x', 'X API v2', 'X_BEARER_TOKEN', ['views', 'likes', 'comments', 'shares']],
        ['twitch', 'twitch', 'Twitch Helix', 'TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET', ['views']],
      ] as const
    ).map(
      ([source, platform, label, env, metrics]): SourceCoverage => ({
        source,
        platform: platform as Platform,
        label,
        enabled: false,
        requiresCredentials: true,
        discovery: '인증 정보가 있을 때만 활성화',
        metrics: [...metrics],
        firstRunAt: null,
        lastRunAt: null,
        lastSuccessAt: null,
        lastStatus: 'disabled',
        lastError: null,
        videoCount: 0,
        accountCount: 0,
        notes: [`환경 변수 ${env} 가 없어 비활성.`],
        docsUrl: null,
      }),
    ),
  ];

  /* ---------- runs (last 48h) ---------- */
  const runs: CollectionRun[] = [];
  const runSources: { source: string; everyH: number; platform: SamplePlatform }[] = [
    { source: 'youtube-rss', everyH: 3, platform: 'youtube' },
    { source: 'youtube-data-api', everyH: 3, platform: 'youtube' },
    { source: 'dailymotion', everyH: 3, platform: 'dailymotion' },
    { source: 'niconico', everyH: 24, platform: 'niconico' },
    { source: 'peertube', everyH: 6, platform: 'peertube' },
    { source: 'tiktok-research', everyH: 6, platform: 'tiktok' },
  ];
  for (const rs of runSources) {
    const last = rs.source === 'niconico' ? lastRun(3) : lastRun(rs.everyH);
    for (let t = last; t > generatedAt - 48 * HOUR; t -= rs.everyH * HOUR) {
      const iso = new Date(t).toISOString().slice(0, 16).replace(/[-:T]/g, '');
      const isError = rs.source === 'dailymotion' && t === last - 5 * 3 * HOUR;
      const isPartial = rs.source === 'peertube' && (t === last || rng.chance(0.25));
      const seen = countBy((v) => v.platform === rs.platform && v.lastObservedAt >= t - rs.everyH * HOUR);
      runs.push({
        id: `run-${rs.source}-${iso}`,
        startedAt: t,
        finishedAt: t + rng.int(20, 240) * 1000,
        source: rs.source,
        status: isError ? 'error' : isPartial ? 'partial' : 'ok',
        videosSeen: isError ? 0 : seen,
        videosNew: isError ? 0 : rng.int(0, 12),
        observations: isError ? 0 : seen,
        requests: isError ? 3 : Math.max(1, Math.ceil(seen / 50)) + rng.int(0, 5),
        errors: isError ? ['HTTP 503 Service Unavailable (재시도 3회 후 실패)'] : isPartial ? ['일부 인스턴스 응답 없음 (timeout 20s)'] : [],
      });
    }
  }
  runs.sort((a, b) => b.startedAt - a.startedAt || a.source.localeCompare(b.source));

  return {
    schemaVersion: 1,
    generatedAt,
    classifierVersion: CLASSIFIER_VERSION,
    videos,
    accounts,
    creators,
    coverage,
    runs,
    exportNotes: [
      '샘플 데이터: apps/web/scripts/make-sample-dataset.ts가 고정 시드로 만든 합성 데이터이며 실제 플랫폼 수치가 아님. 계정 이름은 모두 “샘플”로 시작하고 링크는 example.com을 가리킴.',
      '관측값은 내보내기 압축 규칙(최근 72시간 전체, 3~14일 6시간당 1개, 14~90일 하루 1개, 그 이전 주 1개, 서울 자정 경계점 유지)을 적용함.',
    ],
  };
}
