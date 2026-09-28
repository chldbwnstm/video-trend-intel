/**
 * ContentGraph-lite: hierarchical taxonomy + rule classifier (ko/en/ja keywords). OWNER: core-taxonomy agent.
 *
 * Classification only uses what we actually have for a video (title, tags, truncated description, the
 * source's own category, the seed list the account came from). Every assignment carries its evidence so the
 * UI can show *why* a video is in a category (design doc §8: "분류 근거는 실제 확보한 정보여야 한다").
 *
 * Matching rules
 * - All text is normalized with `normalizeText` (NFKC + lowercase + collapsed whitespace).
 * - ASCII keywords ('kpop', 'ai', 'how to') match on Latin word boundaries (an optional plural `s` is allowed,
 *   and `es` only after s / x / z / ch / sh / o, so 'car' does not match 'cares'; inside hashtags and tags,
 *   keywords of 7+ chars may also be glued to a following word, e.g. '#skincareroutine', but never in prose:
 *   'mechanic' does not match 'mechanical').
 * - Korean/Japanese (non-ASCII) keywords match as substrings, except where a known false-positive trap word
 *   (KEYWORD_TRAPS, e.g. '토너' inside '토너먼트') covers the occurrence. A keyword containing spaces also
 *   matches with the spaces removed ('나 혼자 산다' ~ '나혼자산다').
 *
 * Scoring (per taxonomy node, subcategory hits also count for the parent)
 * - source category mapping: 0.9 (0.7 for broad catch-all source categories), by 'source'. Uploader-chosen
 *   categories that proved unreliable (Dailymotion 'tv' / 'fun' / 'people' / 'lifestyle' / 'auto' / 'tech': news
 *   outlets file items under 'auto' or 'tv') count only 0.6 unless a keyword of the same top-level family
 *   corroborates them.
 * - account / YouTube channel seed category: 0.7, by 'account' (a single ambiguous title keyword, 0.63,
 *   cannot outrank what the channel is known to be about).
 * - keyword hits: title 1.0, tags 0.8, description 0.4 per distinct keyword (best field wins);
 *   rule confidence = 1 - e^(-sum), only counted when the sum >= 0.8 (one title/tag hit or two description hits)
 * - signals combine as a noisy-or, capped at 0.99. At most 3 top-level families and 3 subcategories per family.
 * - A secondary family backed only by a weak rule (keyword sum < 1.2: one title or tag word, about 50% precise
 *   on real data) is dropped when another family has a source or account signal.
 */
import type { CategoryAssignment, Evidence, TaxonomyNode } from './types.ts';
import { extractHashtags, isAsciiKeyword, isLatinWordChar, normalizeText } from './text.ts';

export const CLASSIFIER_VERSION = 'rules-2026.09.2';

/** Top-level ids are FIXED (seed files reference them). Subcategory ids are `${top}/${slug}`. */
export const TOP_LEVEL_CATEGORY_IDS = [
  'beauty',
  'fashion',
  'food',
  'gaming',
  'music',
  'entertainment',
  'comedy',
  'film_animation',
  'news_politics',
  'sports',
  'education',
  'science_tech',
  'travel',
  'lifestyle',
  'kids_family',
  'pets_animals',
  'autos',
  'business_finance',
  'health_fitness',
  'howto_diy',
] as const;
export type TopLevelCategoryId = (typeof TOP_LEVEL_CATEGORY_IDS)[number];

/* ------------------------------------------------------------------------------------------
 * Taxonomy data
 * ---------------------------------------------------------------------------------------- */

/** Split a '|'-separated keyword list, normalize and de-duplicate. */
function kw(list: string): string[] {
  const out: string[] = [];
  for (const raw of list.split('|')) {
    const k = normalizeText(raw);
    if (k && !out.includes(k)) out.push(k);
  }
  return out;
}

function top(id: TopLevelCategoryId, ko: string, en: string, keywords: string, sourceCategories: string[] = []): TaxonomyNode {
  return { id, parent: null, label: { ko, en }, keywords: kw(keywords), sourceCategories };
}

function sub(parent: TopLevelCategoryId, slug: string, ko: string, en: string, keywords: string, sourceCategories: string[] = []): TaxonomyNode {
  return { id: `${parent}/${slug}`, parent, label: { ko, en }, keywords: kw(keywords), sourceCategories };
}

/** YouTube Data API `snippet.categoryId` values, accepted as `youtube:<n>` and `youtube:category:<n>`. */
function yt(...ids: number[]): string[] {
  return ids.flatMap((n) => [`youtube:${n}`, `youtube:category:${n}`]);
}

export const TAXONOMY: TaxonomyNode[] = [
  /* ------------------------------------------------------------------ beauty */
  top('beauty', '뷰티', 'Beauty',
    '뷰티|화장품|코스메틱|k뷰티|k-뷰티|뷰티 유튜버|올리브영|beauty|kbeauty|k-beauty|k beauty|cosmetics|beauty tips|美容|コスメ|化粧品|デパコス|プチプラコスメ|韓国コスメ'),
  sub('beauty', 'skincare', '스킨케어', 'Skincare',
    '스킨케어|피부관리|피부 관리|피부 타입|피부결|민감성 피부|건성 피부|지성 피부|토너|토너패드|세럼|앰플|에센스|선크림|선케어|자외선 차단제|수분크림|보습|클렌징|클렌저|클렌징폼|각질|모공|여드름|피지 관리|레티놀|나이아신아마이드|비타민c 세럼|시카|기초화장품|기초 루틴|마스크팩|피부과|' +
      'skincare|skin care|skincare routine|serum|sunscreen|sunblock|spf|toner|moisturizer|retinol|niacinamide|acne|pores|cleanser|sheet mask|' +
      'スキンケア|美容液|化粧水|日焼け止め|保湿|毛穴|ニキビ|肌荒れ|乳液|美肌'),
  sub('beauty', 'makeup', '메이크업', 'Makeup',
    '메이크업|화장법|데일리 메이크업|메이크업 튜토리얼|풀메이크업|파운데이션|쿠션팩트|컨실러|아이섀도|아이섀도우|섀도우 팔레트|아이라이너|마스카라|립스틱|립밤|틴트|블러셔|하이라이터|컨투어링|속눈썹|눈화장|겟레디윗미|퍼스널컬러|퍼스널 컬러|' +
      'makeup|make up|make-up|makeup tutorial|concealer|eyeshadow|eyeliner|mascara|lipstick|lip tint|blush|highlighter|contour|contouring|grwm|get ready with me|personal color|' +
      'メイク|メイクアップ|化粧|アイシャドウ|ファンデーション|マスカラ|口紅|リップメイク|リップティント|パーソナルカラー'),
  sub('beauty', 'hair', '헤어', 'Hair',
    '헤어스타일|헤어 스타일|헤어컷|헤어 스타일링|헤어 드라이|머리 자르기|머리 스타일|단발|숏컷|레이어드컷|매직펌|볼륨펌|다운펌|히피펌|염색|셀프 염색|탈색|앞머리|미용실|헤어샵|고데기|드라이기|두피|샴푸|트리트먼트|' +
      'hairstyle|hairstyles|haircut|hair color|hair dye|hair care|hair tutorial|shampoo|curling iron|' +
      'ヘアアレンジ|ヘアスタイル|髪型|ヘアカット|美容院|美容室|縮毛矯正|ヘアカラー'),
  sub('beauty', 'nail', '네일', 'Nails',
    '네일|네일아트|젤네일|셀프네일|손톱|페디큐어|매니큐어|nail art|nails|nail polish|manicure|pedicure|gel nails|ネイル|ネイルアート|ジェルネイル|セルフネイル'),
  sub('beauty', 'product_review', '화장품 리뷰', 'Beauty Product Reviews',
    '화장품 리뷰|화장품 추천|올리브영 추천|올영 추천|올영 세일|올영세일|올리브영 세일|신상 화장품|화장품 하울|뷰티 하울|파우치 공개|화장대 정리|' +
      'makeup haul|beauty haul|drugstore makeup|sephora haul|beauty review|' +
      'コスメレビュー|新作コスメ|コスメ紹介|コスメ購入品'),
  sub('beauty', 'mens_grooming', '남성 그루밍', "Men's Grooming",
    '남자 화장품|남자 스킨케어|남자 메이크업|남자 그루밍|맨즈 그루밍|남성 그루밍|면도|면도기|쉐이빙|제모|레이저 제모|' +
      "men's grooming|mens grooming|men's skincare|mens skincare|shaving|shaver|" +
      'メンズコスメ|メンズメイク|メンズスキンケア|髭剃り|脱毛'),
  sub('beauty', 'fragrance', '향수', 'Fragrance',
    '퍼퓸|니치향수|니치 향수|향수 추천|향수 리뷰|향수 하울|딥디크|조말론|바이레도|perfume|perfumes|fragrance|fragrances|香水|フレグランス'),

  /* ------------------------------------------------------------------ fashion */
  top('fashion', '패션', 'Fashion',
    '패션|패션 하울|옷 추천|옷장|fashion|fashion haul|outfit|outfits|ファッション|コーデ|洋服'),
  sub('fashion', 'styling', '코디·스타일링', 'Styling & OOTD',
    '코디|데일리룩|오오티디|룩북|하객룩|출근룩|데이트룩|여름 코디|겨울 코디|코디 추천|옷 코디|스타일링|옷 잘 입는 법|옷잘입는법|착장|' +
      'ootd|lookbook|outfit ideas|outfit of the day|styling tips|what i wear|how to style|' +
      'コーデ|コーディネート|着回し|今日のコーデ|プチプラコーデ'),
  sub('fashion', 'luxury', '명품', 'Luxury',
    '명품백|명품 가방|명품 하울|명품 쇼핑|명품 브랜드|명품 언박싱|명품 시계|샤넬|에르메스|루이비통|구찌|프라다|디올|롤렉스|' +
      'luxury haul|luxury bag|luxury brand|designer bag|chanel|hermes|louis vuitton|gucci|prada|dior|rolex|' +
      'ハイブランド|ブランドバッグ|シャネル|エルメス|ルイヴィトン'),
  sub('fashion', 'sneakers', '신발·스니커즈', 'Shoes & Sneakers',
    '스니커즈|운동화|신발|에어조던|나이키 덩크|뉴발란스|아디다스 삼바|sneakers|sneaker|air jordan|yeezy|shoes|sneakerhead|スニーカー|シューズ'),
  sub('fashion', 'streetwear', '스트릿 패션', 'Streetwear',
    '스트릿 패션|스트릿웨어|스트리트 패션|무신사|슈프림|스투시|구제 쇼핑|빈티지 쇼핑|streetwear|street fashion|street style|supreme|stussy|thrift|thrifting|ストリートファッション|古着|古着屋'),
  sub('fashion', 'accessories', '액세서리·주얼리', 'Accessories & Jewelry',
    '액세서리|악세사리|악세서리|주얼리|목걸이|귀걸이|반지|팔찌|가방 추천|왓츠인마이백|' +
      "accessories|jewelry|jewellery|necklace|earrings|bracelet|handbag|what's in my bag|whats in my bag|" +
      'アクセサリー|ジュエリー|ピアス|ネックレス|指輪|バッグの中身'),
  sub('fashion', 'haul', '쇼핑 하울', 'Shopping Hauls',
    '하울|쇼핑하울|쇼핑 하울|옷 하울|지그재그|에이블리|쇼핑몰 추천|옷 쇼핑|haul|try on haul|try-on haul|clothing haul|shein|zara haul|購入品|購入品紹介|爆買い'),
  sub('fashion', 'menswear', '남성 패션', "Men's Fashion",
    "남자 패션|남자 코디|남친룩|남자 옷|남자 옷 추천|men's fashion|mens fashion|menswear|men's outfit|メンズファッション|メンズコーデ"),

  /* ------------------------------------------------------------------ food */
  top('food', '푸드', 'Food',
    '음식|푸드|먹방|요리|레시피|맛집|food|foodie|cooking|recipe|グルメ|料理|食べ物|飯テロ',
    ['dailymotion:food', 'peertube:Food', 'niconico:料理']),
  sub('food', 'mukbang', '먹방', 'Mukbang',
    '먹방|먹방 asmr|대식가|푸드파이터|푸파|mukbang|eating show|eating asmr|大食い|爆食|モッパン|デカ盛り'),
  sub('food', 'cooking', '요리·레시피', 'Cooking & Recipes',
    '요리|레시피|요리법|집밥|반찬|밑반찬|자취요리|자취 요리|밀프렙|에어프라이어|백종원|황금레시피|' +
      'cooking|recipe|recipes|how to cook|home cooking|meal prep|air fryer|' +
      '料理|レシピ|自炊|簡単レシピ|おうちごはん|作り置き|弁当',
    ['niconico:料理']),
  sub('food', 'restaurants', '맛집·외식', 'Restaurants & Food Tours',
    '맛집|맛집 추천|맛집 탐방|맛집투어|오마카세|노포|웨이팅 맛집|길거리 음식|시장 먹거리|포장마차|미슐랭|' +
      'restaurant|restaurants|food review|food tour|street food|michelin|' +
      '食べ歩き|名店|ラーメン|寿司|屋台|グルメレポート'),
  sub('food', 'baking_dessert', '베이킹·디저트', 'Baking & Desserts',
    '베이킹|디저트|케이크|쿠키 만들기|빵집|베이커리|마카롱|제과|제빵|홈베이킹|휘낭시에|baking|dessert|desserts|cake|bakery|pastry|macaron|' +
      'お菓子作り|スイーツ|ケーキ|パン作り|手作りお菓子'),
  sub('food', 'cafe_drinks', '카페·음료', 'Cafes & Drinks',
    '카페 투어|카페투어|카페 추천|신상 카페|커피|라떼|바리스타|홈카페|음료 만들기|스타벅스|coffee|latte|barista|cafe|café|coffee shop|' +
      'カフェ|コーヒー|スタバ|スターバックス|カフェ巡り'),
  sub('food', 'convenience', '편의점·간편식', 'Convenience Food',
    '편의점|편의점 신상|컵라면|라면 끓이기|라면 먹방|신라면|짜파게티|불닭|불닭볶음면|밀키트|간편식|냉동식품|convenience store|instant noodles|ramen|' +
      'コンビニ|カップ麺|コンビニ飯|冷凍食品'),
  sub('food', 'alcohol', '술·주류', 'Drinks & Alcohol',
    '술방|술 먹방|혼술|와인|위스키|맥주|소주|막걸리|칵테일|하이볼|전통주|wine|whisky|whiskey|beer|cocktail|cocktails|' +
      'お酒|ビール|ワイン|日本酒|ウイスキー|晩酌|ハイボール'),

  /* ------------------------------------------------------------------ gaming */
  top('gaming', '게임', 'Gaming',
    '게임|게이머|게이밍|게임방송|겜방|gaming|gamer|game|video game|video games|videogame|ゲーム|ゲーム実況|ゲーマー',
    ['dailymotion:videogames', 'peertube:Gaming', 'niconico:ゲーム', ...yt(20)]),
  sub('gaming', 'lets_play', '게임 플레이·실황', "Let's Play",
    '게임 실황|게임 플레이|플레이 영상|게임 공략|공략법|보스 공략|스피드런|' +
      "let's play|lets play|gameplay|walkthrough|playthrough|speedrun|longplay|" +
      '実況|実況プレイ|ゲーム実況|攻略|rta|縛りプレイ|プレイ動画'),
  sub('gaming', 'esports', 'e스포츠', 'Esports',
    'e스포츠|이스포츠|lck|lpl|롤드컵|월즈|페이커|프로게이머|젠지|kt 롤스터|esports|e-sports|pro gamer|faker|lol worlds|valorant champions|' +
      'eスポーツ|プロゲーマー'),
  sub('gaming', 'mobile', '모바일 게임', 'Mobile Games',
    '모바일 게임|모바일게임|폰게임|가챠|리세마라|mobile game|mobile games|mobile gaming|gacha|' +
      'ソシャゲ|スマホゲーム|ガチャ|リセマラ|ブルアカ|ウマ娘'),
  sub('gaming', 'console_pc', '콘솔·PC 게임', 'Console & PC Games',
    '닌텐도|닌텐도 스위치|스위치 게임|플스|플스5|플레이스테이션|엑스박스|스팀 게임|스팀덱|pc게임|pc 게임|' +
      'nintendo|nintendo switch|playstation|ps5|ps4|xbox|steam game|steam deck|pc gaming|' +
      '任天堂|ニンテンドースイッチ|スイッチ2|プレステ|プレイステーション'),
  sub('gaming', 'rpg', 'RPG', 'RPG & MMORPG',
    '메이플스토리|리니지|로스트아크|던파|던전앤파이터|원신|붕괴 스타레일|디아블로|엘든링|젤다|포켓몬 게임|파이널 판타지|mmorpg|' +
      'rpg|final fantasy|elden ring|genshin|genshin impact|honkai|diablo|zelda|pokemon|' +
      'ポケモン|ドラクエ|ドラゴンクエスト|ファイナルファンタジー|原神|モンハン|モンスターハンター'),
  sub('gaming', 'shooter', 'FPS·배틀로얄', 'Shooters & Battle Royale',
    '배틀그라운드|배그|발로란트|오버워치|서든어택|카운터스트라이크|포트나이트|에이펙스|' +
      'fps|battlegrounds|pubg|valorant|overwatch|fortnite|apex legends|call of duty|counter-strike|cs2|' +
      'バロラント|フォートナイト|エーペックス|スプラトゥーン'),
  sub('gaming', 'sandbox', '마인크래프트·샌드박스', 'Minecraft & Sandbox',
    '마인크래프트|로블록스|테라리아|동물의 숲|모동숲|minecraft|roblox|terraria|animal crossing|マイクラ|マインクラフト|ロブロックス|あつ森|どうぶつの森'),
  sub('gaming', 'moba', '리그 오브 레전드·MOBA', 'League of Legends & MOBA',
    '리그 오브 레전드|리그오브레전드|롤토체스|칼바람|전략적 팀 전투|롤 챔피언|롤 패치|league of legends|teamfight tactics|dota 2|dota|' +
      'リーグ・オブ・レジェンド|リーグオブレジェンド'),
  sub('gaming', 'game_review', '게임 리뷰·소식', 'Game Reviews & News',
    '게임 리뷰|신작 게임|게임 추천|게임 뉴스|게임 소식|game review|game reviews|new games|upcoming games|game trailer|' +
      'ゲームレビュー|新作ゲーム|ゲーム紹介'),

  /* ------------------------------------------------------------------ music */
  top('music', '음악', 'Music',
    '음악|노래|뮤직|뮤직비디오|뮤비|mv|m/v|music video|플레이리스트|신곡|음원|노래 가사|가사 해석|music|song|songs|playlist|lyrics|new song|bgm|音楽|楽曲|ミュージック|作業用bgm|新曲|歌詞',
    ['dailymotion:music', 'peertube:Music', 'niconico:音楽・サウンド', ...yt(10)]),
  sub('music', 'kpop', 'K-POP', 'K-pop',
    '케이팝|k팝|아이돌|컴백|직캠|팬캠|음방|음악방송|엠카운트다운|엠카|인기가요|뮤직뱅크|쇼챔피언|음악중심|걸그룹|보이그룹|' +
      '방탄소년단|아이유|블랙핑크|뉴진스|세븐틴|에스파|아이브|르세라핌|스트레이키즈|트와이스|엔시티|' +
      'kpop|k-pop|k pop|kpop idol|k-pop idol|fancam|girl group|boy group|blackpink|newjeans|aespa|le sserafim|stray kids|nct|' +
      'k-pop|韓国アイドル|kポップ'),
  sub('music', 'jpop', 'J-POP·애니송', 'J-pop & Anisong',
    'jpop|j-pop|제이팝|일본 노래|애니송|애니 ost|시티팝|anisong|city pop|アニソン|邦楽|シティポップ|j-rock'),
  sub('music', 'hiphop', '힙합·랩', 'Hip-hop & Rap',
    '힙합|래퍼|랩 가사|쇼미더머니|언더그라운드 힙합|디스곡|hiphop|hip hop|hip-hop|rapper|rap|diss track|ヒップホップ|ラッパー'),
  sub('music', 'cover', '커버', 'Covers',
    '노래 커버|커버곡|커버 영상|불러보았다|불러봤다|cover song|song cover|piano cover|guitar cover|vocal cover|acoustic cover|歌ってみた|弾いてみた|カバー曲|歌い手'),
  sub('music', 'live', '라이브·공연', 'Live & Concerts',
    '라이브 무대|콘서트|공연 실황|페스티벌|버스킹|킬링보이스|라이브 클립|live performance|concert|live session|unplugged|busking|tiny desk|' +
      'ライブ映像|コンサート|フェス|ライブ映像公開'),
  sub('music', 'dance', '댄스', 'Dance',
    '댄스|안무|댄스커버|댄스 커버|댄스 챌린지|춤선|안무 영상|안무 연습|dance|choreography|dance cover|dance challenge|dance practice|' +
      '踊ってみた|ダンス|振り付け|振付',
    ['niconico:ダンス']),
  sub('music', 'vocaloid', '보컬로이드', 'Vocaloid',
    '보컬로이드|보카로|하츠네 미쿠|vocaloid|hatsune miku|miku|utau|ボカロ|ボーカロイド|初音ミク|鏡音リン|重音テト|音mad'),
  sub('music', 'instrumental', '연주·클래식', 'Instrumental & Classical',
    '피아노|기타 연주|기타 커버|통기타|일렉기타|기타리스트|바이올린|첼로|드럼 연주|드럼 커버|클래식 음악|클래식 연주|오케스트라|연주 영상|연주회|합주|' +
      'piano|guitar|violin|cello|drums|drum cover|classical music|orchestra|' +
      'ピアノ|ギター|バイオリン|ヴァイオリン|演奏|オーケストラ|クラシック音楽'),
  sub('music', 'trot', '트로트', 'Trot',
    '트로트|트롯|미스트롯|미스터트롯|현역가왕|임영웅|송가인|장윤정|trot|演歌|enka'),

  /* ------------------------------------------------------------------ entertainment */
  top('entertainment', '엔터테인먼트', 'Entertainment',
    '예능|연예|연예인|방송 클립|tv show|reality show|バラエティ|芸能|テレビ番組',
    ['dailymotion:fun', 'dailymotion:tv', 'peertube:Entertainment', 'niconico:エンターテイメント', ...yt(24)]),
  sub('entertainment', 'variety', '예능', 'Variety Shows',
    '예능|런닝맨|무한도전|놀면 뭐하니|나 혼자 산다|나혼산|1박 2일|유퀴즈|유 퀴즈 온 더 블럭|아는 형님|신서유기|지구오락실|전지적 참견 시점|전참시|구해줘 홈즈|' +
      '복면가왕|불후의 명곡|라디오스타|미운 우리 새끼|미우새|동상이몽|슈퍼맨이 돌아왔다|슈돌|골 때리는 그녀들|골때녀|환승연애|솔로지옥|나는solo|나는 solo|나솔|하트시그널|' +
      '피의 게임|피지컬: 100|피지컬100|더 지니어스|강철부대|핑계고|워크맨|문명특급|짠한형|유재석|강호동|신동엽|' +
      'variety show|kvariety|korean variety|バラエティ番組|水曜日のダウンタウン|月曜から夜ふかし'),
  sub('entertainment', 'drama', '드라마', 'TV Drama',
    '드라마|k드라마|드라마 리뷰|넷플릭스 드라마|주말드라마|일일드라마|웹드라마|미국 드라마|kdrama|k-drama|k drama|drama|tv series|' +
      'ドラマ|韓国ドラマ|韓ドラ|朝ドラ|大河ドラマ'),
  sub('entertainment', 'celebrity', '연예·셀럽', 'Celebrity',
    '연예인|연예계|셀럽|여배우|남배우|배우 인터뷰|배우 근황|열애설|열애|결혼 발표|시상식|레드카펫|청룡영화상|백상예술대상|' +
      'celebrity|celebrities|celeb|red carpet|gossip|award show|' +
      '芸能人|芸能ニュース|俳優|女優|熱愛',
    ['dailymotion:people']),
  sub('entertainment', 'reaction', '리액션', 'Reactions',
    '리액션|반응 영상|리액션 영상|reaction video|reaction|reacts to|reacting to|first time hearing|リアクション動画|海外の反応'),
  sub('entertainment', 'talk_podcast', '토크·팟캐스트·라디오', 'Talk, Podcasts & Radio',
    '토크쇼|팟캐스트|라디오|보이는 라디오|podcast|podcasts|talk show|radio|ポッドキャスト|ラジオ|トーク番組|対談|雑談',
    ['niconico:ラジオ']),
  sub('entertainment', 'audition', '오디션·서바이벌', 'Auditions & Survival Shows',
    '오디션|오디션 프로그램|서바이벌 프로그램|프로듀스101|스트릿 우먼 파이터|스우파|싱어게인|슈퍼스타k|k팝스타|보이즈 플래닛|걸스플래닛|' +
      'audition|auditions|survival show|american idol|got talent|x factor|produce 101|オーディション|日プ'),
  sub('entertainment', 'streamer', '인터넷 방송·스트리머', 'Streamers & VTubers',
    '인방|인터넷 방송|스트리머|치지직|아프리카tv|아프리카 tv|숲티비|트위치|버튜버|방송 하이라이트|' +
      'twitch|streamer|streamers|vtuber|vtubers|virtual youtuber|' +
      '生配信|配信者|配信切り抜き|切り抜き|にじさんじ|ホロライブ|hololive|nijisanji'),

  /* ------------------------------------------------------------------ comedy */
  top('comedy', '코미디', 'Comedy',
    '코미디|개그|개그맨|개그우먼|웃긴|유머|코믹|comedy|funny|humor|humour|comedic|お笑い|コント|漫才|爆笑|ギャグ',
    ['peertube:Comedy', ...yt(23)]),
  sub('comedy', 'sketch', '콩트·스케치', 'Sketch Comedy',
    '콩트|스케치 코미디|숏박스|피식대학|코미디빅리그|개그콘서트|개콘|꼰대희|sketch comedy|skit|skits|コント|ショートコント'),
  sub('comedy', 'standup', '스탠드업', 'Stand-up',
    '스탠드업|스탠드업 코미디|standup|stand-up|stand up comedy|comedian|comedians|漫才|m-1グランプリ|芸人|お笑い芸人'),
  sub('comedy', 'prank', '몰래카메라·장난', 'Pranks',
    '몰래카메라|몰카 장난|장난 영상|prank|pranks|pranked|hidden camera|ドッキリ|いたずら動画'),
  sub('comedy', 'parody', '패러디·성대모사', 'Parody & Impressions',
    '패러디|성대모사|모창|parody|spoof|celebrity impressions|パロディ|モノマネ|ものまね'),
  sub('comedy', 'memes', '밈·웃긴 영상', 'Memes & Funny Clips',
    '인터넷 밈|밈 모음|웃긴 영상|웃긴영상|웃긴 짤|웃음 참기|meme|memes|funny videos|funny moments|try not to laugh|fail compilation|fails compilation|ミーム|おもしろ動画|面白動画'),

  /* ------------------------------------------------------------------ film & animation */
  top('film_animation', '영화·애니메이션', 'Film & Animation',
    '영화|무비|movie|movies|film|films|cinema|映画|アニメ',
    ['dailymotion:shortfilms', 'peertube:Films', ...yt(1)]),
  sub('film_animation', 'movies', '영화', 'Movies',
    '영화 추천|개봉 영화|개봉작|극장 개봉|박스오피스|넷플릭스 영화|천만 영화|마블|box office|netflix movie|hollywood|marvel|blockbuster|洋画|邦画|マーベル'),
  sub('film_animation', 'movie_review', '영화 리뷰·해석', 'Movie Reviews & Recaps',
    '영화 리뷰|영화리뷰|결말 포함|결말포함|영화 해석|영화 요약|영화 소개|줄거리|movie review|film review|movie recap|ending explained|movie explained|映画レビュー|映画紹介|映画解説|ネタバレ'),
  sub('film_animation', 'trailers', '예고편', 'Trailers',
    '예고편|메인 예고편|공식 예고편|영화 티저|trailer|official trailer|teaser trailer|予告|予告編|特報'),
  sub('film_animation', 'anime', '애니메이션', 'Anime & Animation',
    '애니메이션|애니|애니 추천|신작 애니|극장판|지브리|나루토|귀멸의 칼날|주술회전|진격의 거인|anime|animation|animated|ghibli|studio ghibli|pixar|' +
      'アニメ|アニメーション|ジブリ|声優|劇場版|新作アニメ',
    ['niconico:アニメ']),
  sub('film_animation', 'webtoon_comics', '웹툰·만화', 'Webtoons & Comics',
    '웹툰|만화|웹소설|manhwa|manga|webtoon|webtoons|comic|comics|漫画|マンガ|コミック|ウェブトゥーン'),
  sub('film_animation', 'short_film', '단편·독립영화', 'Short & Indie Films',
    '단편영화|단편 영화|독립영화|short film|indie film|student film|自主制作映画|短編映画'),
  sub('film_animation', 'horror', '공포·미스터리', 'Horror & Mystery',
    '공포|호러|괴담|무서운 이야기|심령|미스터리|horror|creepypasta|scary stories|haunted|心霊|怖い話|ホラー|都市伝説'),

  /* ------------------------------------------------------------------ news & politics */
  top('news_politics', '뉴스·정치', 'News & Politics',
    '뉴스|속보|시사|앵커|기자회견|news|breaking news|news report|ニュース|速報|報道',
    ['dailymotion:news', 'peertube:News & Politics', 'niconico:社会・政治・時事', ...yt(25)]),
  sub('news_politics', 'breaking', '속보·사건사고', 'Breaking & Incidents',
    '속보|사건사고|사건 사고|사고 현장|교통사고|화재|경찰|검찰|체포|구속|breaking news|accident|police|arrested|速報|事件|事故|逮捕|火災'),
  sub('news_politics', 'politics', '정치', 'Politics',
    '정치|국회|국회의원|대통령|대통령실|정부|여당|야당|국민의힘|더불어민주당|민주당|국무총리|탄핵|청문회|국정감사|정당|' +
      'politics|political|president|congress|parliament|senate|government|prime minister|impeachment|white house|' +
      '政治|国会|首相|総理|内閣|政権|与党|野党|自民党'),
  sub('news_politics', 'election', '선거', 'Elections',
    '선거|대선|총선|지방선거|투표|출구조사|개표|election|elections|voting|ballot|polls|選挙|投票|開票'),
  sub('news_politics', 'international', '국제', 'World News',
    '국제 뉴스|해외 뉴스|외신|전쟁|우크라이나|러시아|이스라엘|가자지구|중동|북한|김정은|트럼프|바이든|미중 갈등|' +
      'world news|international news|ukraine|russia|israel|gaza|north korea|trump|biden|' +
      '国際ニュース|海外ニュース|ウクライナ|ロシア|北朝鮮|戦争'),
  sub('news_politics', 'society', '사회 이슈', 'Society',
    '사회 이슈|사회문제|사회 문제|저출산|고령화|의대 증원|파업|집회|시위|인권|social issues|human rights|protest|protests|社会問題|人権'),
  sub('news_politics', 'activism', '시민운동·환경', 'Activism & Environment',
    '환경운동|기후위기|기후 위기|기후변화|기후 변화|탄소중립|동물권|시민단체|climate change|climate crisis|activism|activist|環境問題|気候変動',
    ['peertube:Activism', ...yt(29)]),
  sub('news_politics', 'weather_disaster', '날씨·재난', 'Weather & Disasters',
    '날씨 예보|오늘 날씨|내일 날씨|날씨 전망|일기예보|태풍|폭우|폭염|한파|지진|홍수|산불|재난|폭설|미세먼지|' +
      'weather forecast|weather update|typhoon|hurricane|earthquake|flood|flooding|wildfire|天気予報|台風|地震|大雨|豪雨|災害'),

  /* ------------------------------------------------------------------ sports */
  top('sports', '스포츠', 'Sports',
    '스포츠|스포츠 하이라이트|경기 하이라이트|sports|sport|match highlights|スポーツ|試合',
    ['dailymotion:sport', 'peertube:Sports', 'niconico:スポーツ', ...yt(17)]),
  sub('sports', 'soccer', '축구', 'Soccer',
    '축구|손흥민|이강인|김민재|프리미어리그|챔피언스리그|챔스|k리그|월드컵|토트넘|맨유|맨시티|리버풀|레알 마드리드|' +
      'football|soccer|premier league|epl|champions league|world cup|la liga|messi|ronaldo|son heung-min|' +
      'サッカー|jリーグ|w杯|ワールドカップ|久保建英|三笘'),
  sub('sports', 'baseball', '야구', 'Baseball',
    '야구|kbo|프로야구|류현진|이정후|김하성|오타니|한국시리즈|홈런|mlb|baseball|home run|homerun|world series|ohtani|野球|プロ野球|大谷翔平|甲子園|ホームラン|npb'),
  sub('sports', 'basketball', '농구', 'Basketball',
    '농구|nba|kbl|르브론|basketball|lebron|stephen curry|バスケ|バスケットボール|bリーグ'),
  sub('sports', 'volleyball', '배구', 'Volleyball',
    '배구|v리그|김연경|volleyball|バレーボール|バレー'),
  sub('sports', 'golf', '골프', 'Golf',
    '골프|골프 레슨|골프 스윙|pga|lpga|klpga|golf|ゴルフ'),
  sub('sports', 'martial_arts', '격투기', 'Combat Sports',
    '격투기|ufc|mma|복싱|권투|주짓수|태권도|씨름|boxing|jiu jitsu|jiu-jitsu|bjj|kickboxing|wrestling|wwe|格闘技|ボクシング|柔道|空手|rizin'),
  sub('sports', 'racket', '라켓 스포츠', 'Racket Sports',
    '테니스|배드민턴|탁구|tennis|badminton|table tennis|ping pong|テニス|卓球|バドミントン'),
  sub('sports', 'olympics', '올림픽·국가대표', 'Olympics & National Teams',
    '올림픽|국가대표|아시안게임|패럴림픽|olympics|olympic|paralympics|asian games|オリンピック|五輪|パリ五輪|日本代表'),
  sub('sports', 'winter', '동계 스포츠', 'Winter Sports',
    '피겨스케이팅|피겨 스케이팅|김연아|스키장|스키 타기|스노보드|쇼트트랙|스피드스케이팅|figure skating|skiing|snowboarding|short track|' +
      'フィギュアスケート|スキー|スノーボード|羽生結弦'),

  /* ------------------------------------------------------------------ education */
  top('education', '교육', 'Education',
    '교육|공부|강의|education|educational|教育|勉強|講座|解説動画',
    ['dailymotion:school', 'peertube:Education', 'niconico:解説・講座', ...yt(27)]),
  sub('education', 'language', '외국어', 'Languages',
    '영어 공부|영어회화|영어 회화|영어 표현|영어 단어|일본어 공부|일본어|중국어|한국어 배우기|외국어|토익|토플|오픽|' +
      'learn english|english lesson|english grammar|english speaking|learn korean|learn japanese|japanese lesson|vocabulary|toeic|toefl|ielts|' +
      '英語学習|英会話|韓国語講座|韓国語勉強|中国語|英単語'),
  sub('education', 'study', '공부·입시', 'Study & Exams',
    '공부법|공부 브이로그|스터디윗미|시험 공부|수능|입시|내신|대학 입시|수학 문제|수학 공부|고3|study with me|study tips|studying|exam|exams|homework|math|' +
      '受験|勉強法|共通テスト|東大|数学|勉強vlog'),
  sub('education', 'history', '역사', 'History',
    '역사|한국사|세계사|조선시대|삼국시대|임진왜란|세계대전|history|historical|world war|歴史|日本史|世界史|戦国時代'),
  sub('education', 'lecture', '강의·강연', 'Lectures & Talks',
    '강의|강연|인강|세바시|ted|ted talk|tedx|lecture|lectures|masterclass|講義|講演|授業'),
  sub('education', 'career', '취업·자격증', 'Careers & Certificates',
    '취업|취준|자격증|공무원 시험|면접 팁|면접 질문|자소서|이력서|career|job interview|job hunting|就活|資格|転職'),
  sub('education', 'explainer', '지식·교양', 'Explainers & Documentaries',
    '지식|교양|상식|알쓸신잡|지식채널|다큐|다큐멘터리|documentary|explainer|explained|ドキュメンタリー|雑学|豆知識|解説動画|ゆっくり解説'),
  sub('education', 'books', '책·독서', 'Books & Reading',
    '독서|책 추천|북튜버|서평|베스트셀러|book review|book recommendations|booktube|reading vlog|読書|本紹介|書評'),

  /* ------------------------------------------------------------------ science & tech */
  top('science_tech', '과학·기술', 'Science & Technology',
    '과학기술|테크|it 리뷰|it기기|tech|technology|テクノロジー|ガジェット|科学技術',
    ['dailymotion:tech', 'peertube:Science & Technology', ...yt(28)]),
  sub('science_tech', 'gadgets', 'IT 기기·리뷰', 'Gadgets & Reviews',
    '전자기기|가전|가전제품|이어폰|헤드폰|무선이어폰|스마트워치|태블릿|아이패드|갤럭시 탭|카메라 리뷰|로봇청소기|전자제품|' +
      'gadget|gadgets|tech review|earbuds|headphones|smartwatch|ipad|airpods|' +
      'ガジェット|イヤホン|家電|ワイヤレスイヤホン'),
  sub('science_tech', 'smartphone', '스마트폰', 'Smartphones',
    '스마트폰|아이폰|갤럭시|폴더블폰|폴더블|갤럭시 s|갤럭시 z|smartphone|smartphones|iphone|galaxy s|galaxy z|google pixel|android|ios|' +
      'スマホ|アイフォン|スマートフォン'),
  sub('science_tech', 'pc_hardware', '컴퓨터·하드웨어', 'PCs & Hardware',
    '컴퓨터|노트북|그래픽카드|조립pc|조립 pc|맥북|기계식 키보드|키보드|모니터 추천|cpu|gpu|' +
      'gaming pc|pc build|laptop|macbook|graphics card|mechanical keyboard|keyboard|nvidia|rtx|amd|intel|' +
      'パソコン|自作pc|グラボ|キーボード'),
  sub('science_tech', 'ai', 'AI·인공지능', 'AI',
    'ai|인공지능|챗gpt|챗지피티|생성형 ai|딥러닝|머신러닝|chatgpt|gpt|openai|llm|claude ai|midjourney|stable diffusion|machine learning|deep learning|' +
      'artificial intelligence|生成ai|人工知能|ai画像'),
  sub('science_tech', 'science', '과학', 'Science',
    '과학|물리학|화학|생물학|과학 실험|science|physics|chemistry|biology|experiment|科学|物理学|化学|生物学|実験'),
  sub('science_tech', 'space', '우주', 'Space',
    '우주|천문학|스페이스x|로켓 발사|블랙홀|nasa|spacex|outer space|astronomy|rocket launch|black hole|宇宙|天文|ロケット打ち上げ|ブラックホール'),
  sub('science_tech', 'coding', '코딩·개발', 'Programming',
    '코딩|프로그래밍|개발자|파이썬|자바스크립트|웹개발|coding|programming|developer|python|javascript|typescript|software engineer|web development|' +
      'プログラミング|itエンジニア'),
  sub('science_tech', 'maker', '메이커·전자공작', 'Maker & Electronics',
    '전자공작|아두이노|라즈베리파이|3d프린터|3d 프린터|3d 프린팅|arduino|raspberry pi|3d printing|3d printer|diy electronics|電子工作|技術部|3dプリンター',
    ['niconico:技術・工作']),

  /* ------------------------------------------------------------------ travel */
  top('travel', '여행', 'Travel',
    '여행|여행 브이로그|여행기|트래블|travel|trip|vacation|travel vlog|旅行|観光|旅vlog',
    ['dailymotion:travel', 'peertube:Travels', 'niconico:旅行・アウトドア', ...yt(19)]),
  sub('travel', 'domestic', '국내 여행', 'Korea Travel',
    '국내여행|국내 여행|제주도|제주 여행|부산 여행|강릉 여행|경주 여행|여수 여행|서울 여행|당일치기|국내 여행지|korea travel|travel korea|seoul travel|jeju|' +
      '韓国旅行|ソウル旅行|国内旅行|日帰り旅行'),
  sub('travel', 'overseas', '해외 여행', 'International Travel',
    '해외여행|해외 여행|일본 여행|도쿄 여행|오사카 여행|유럽 여행|미국 여행|동남아 여행|베트남 여행|다낭|태국 여행|방콕 여행|발리 여행|세계일주|' +
      'backpacking|world trip|japan travel|tokyo travel|europe trip|海外旅行|世界一周|バックパッカー'),
  sub('travel', 'camping_outdoor', '캠핑·아웃도어', 'Camping & Outdoors',
    '캠핑|차박|글램핑|백패킹|등산|낚시|트레킹|camping|hiking|fishing|trekking|outdoor|outdoors|キャンプ|登山|釣り|ソロキャンプ|アウトドア'),
  sub('travel', 'accommodation', '호텔·숙소', 'Hotels & Stays',
    '호텔|리조트|숙소|펜션|에어비앤비|호캉스|hotel|resort|airbnb|hotel review|ホテル|旅館|温泉宿'),
  sub('travel', 'nature', '자연·풍경', 'Nature & Scenery',
    '자연 풍경|대자연|풍경 영상|드론 영상|nature|landscape|scenery|drone footage|絶景|大自然|自然風景|風景',
    ['niconico:自然']),
  sub('travel', 'aviation', '항공·공항', 'Aviation',
    '비행기|항공사|기내식|공항|퍼스트클래스|비즈니스석|대한항공|아시아나|airplane|flight|airport|airline|first class|business class|飛行機|空港|航空|機内食'),

  /* ------------------------------------------------------------------ lifestyle */
  top('lifestyle', '라이프스타일', 'Lifestyle',
    '라이프스타일|일상|브이로그|lifestyle|daily life|vlog|ライフスタイル|日常|暮らし',
    ['dailymotion:lifestyle']),
  sub('lifestyle', 'vlog', '브이로그·일상', 'Vlogs',
    '브이로그|일상 브이로그|직장인 브이로그|대학생 브이로그|갓생|모닝루틴|나이트루틴|하루 루틴|vlog|day in my life|daily vlog|morning routine|night routine|' +
      '日常vlog|モーニングルーティン|ナイトルーティン|一日の流れ',
    ['peertube:People', ...yt(22)]),
  sub('lifestyle', 'interior', '인테리어·집꾸미기', 'Home & Interior',
    '인테리어|집꾸미기|방꾸미기|랜선집들이|집들이|룸투어|오늘의집|셀프 인테리어|가구 추천|가구 배치|interior|interior design|room tour|home tour|home decor|apartment tour|' +
      'ルームツアー|インテリア|部屋作り'),
  sub('lifestyle', 'cleaning', '청소·정리', 'Cleaning & Organizing',
    '청소|정리정돈|정리 정돈|수납|살림|살림 브이로그|미니멀라이프|미니멀리즘|대청소|cleaning|clean with me|organizing|declutter|decluttering|minimalism|minimalist|' +
      '掃除|片付け|収納|断捨離|ミニマリスト'),
  sub('lifestyle', 'relationships', '연애·결혼', 'Dating & Relationships',
    '연애|커플|결혼|신혼|이별|짝사랑|소개팅|웨딩|국제커플|국제 커플|dating|relationship|relationships|couple vlog|couples|wedding|boyfriend|girlfriend|' +
      '恋愛|カップル|結婚|国際カップル|婚活'),
  sub('lifestyle', 'asmr', 'ASMR', 'ASMR',
    'asmr|팅글|백색소음|빗소리|수면 영상|tingles|sleep sounds|relaxing sounds|white noise|睡眠用|音フェチ|咀嚼音'),
  sub('lifestyle', 'living_alone', '자취·1인 가구', 'Living Alone',
    '자취|자취생|1인가구|1인 가구|혼자 사는|혼밥|원룸|living alone|一人暮らし|ひとり暮らし'),
  sub('lifestyle', 'plants_garden', '식물·가드닝', 'Plants & Gardening',
    '식물|반려식물|가드닝|텃밭|정원 가꾸기|정원 만들기|다육이|화분|plants|houseplants|gardening|garden|ガーデニング|家庭菜園|観葉植物|植物'),

  /* ------------------------------------------------------------------ kids & family */
  top('kids_family', '키즈·가족', 'Kids & Family',
    '키즈|어린이|유아|육아|kids|children|family|for kids|キッズ|子供|子育て|家族',
    ['dailymotion:kids', 'peertube:Kids']),
  sub('kids_family', 'parenting', '육아', 'Parenting',
    '육아|육아 브이로그|아기|신생아|이유식|어린이집|워킹맘|육아맘|parenting|newborn|toddler|baby food|baby vlog|mom life|育児|赤ちゃん|子育て|離乳食|ワンオペ育児'),
  sub('kids_family', 'kids_content', '키즈 콘텐츠', "Kids' Content",
    '동요|뽀로로|핑크퐁|아기상어|꼬마버스 타요|타요 버스|키즈 채널|어린이 애니|키즈 콘텐츠|nursery rhymes|nursery rhyme|baby shark|cocomelon|kids songs|pororo|pinkfong|' +
      '童謡|アンパンマン|しまじろう|キッズ向け'),
  sub('kids_family', 'toys', '장난감', 'Toys',
    '장난감|레고|토이 리뷰|피규어|toys|toy review|lego|playmobil|おもちゃ|レゴ|トミカ|プラレール'),
  sub('kids_family', 'pregnancy', '임신·출산', 'Pregnancy & Birth',
    '임신|출산|태교|임산부|산후조리원|조리원|pregnancy|pregnant|giving birth|gender reveal|妊娠|出産|妊婦'),
  sub('kids_family', 'family_vlog', '가족 일상', 'Family Vlogs',
    '가족 브이로그|가족 일상|가족 여행|family vlog|family trip|家族vlog|家族旅行'),
  sub('kids_family', 'kids_edu', '유아 교육', 'Early Learning',
    '유아 교육|어린이 교육|한글 떼기|유아 영어|kids learning|learning for kids|educational videos for kids|知育|幼児教育'),

  /* ------------------------------------------------------------------ pets & animals */
  top('pets_animals', '반려동물·동물', 'Pets & Animals',
    '동물|반려동물|애완동물|pets|pet|animals|animal|ペット|動物',
    ['dailymotion:animals', 'peertube:Animals', 'niconico:動物', ...yt(15)]),
  sub('pets_animals', 'dogs', '강아지', 'Dogs',
    '강아지|반려견|댕댕이|멍멍이|견종|푸들|말티즈|시바견|골든리트리버|웰시코기|진돗개|포메라니안|비숑|' +
      'dog|dogs|puppy|puppies|doggo|corgi|golden retriever|shiba inu|poodle|子犬|柴犬|ワンちゃん|愛犬|わんこ|トイプードル'),
  sub('pets_animals', 'cats', '고양이', 'Cats',
    '고양이|냥이|길고양이|아기 고양이|새끼 고양이|코숏|고양이 집사|냥집사|cat|cats|kitten|kittens|kitty|子猫|保護猫|猫動画|ねこ|ネコ|にゃんこ|愛猫|猫カフェ'),
  sub('pets_animals', 'wildlife', '야생동물', 'Wildlife',
    '야생동물|동물의 왕국|사파리|동물원|아쿠아리움|해양생물|wildlife|safari|zoo|aquarium|national geographic|野生動物|動物園|水族館'),
  sub('pets_animals', 'exotic', '특수동물', 'Exotic Pets',
    '파충류|도마뱀|거북이|햄스터|앵무새|열대어|물고기|고슴도치|reptile|reptiles|gecko|hamster|parrot|snake|fish tank|tropical fish|爬虫類|ハムスター|インコ|熱帯魚|メダカ|フクロウ'),
  sub('pets_animals', 'rescue', '유기동물·구조', 'Animal Rescue',
    '유기견|유기묘|유기동물|동물 구조|유기견 입양|임시보호|animal rescue|rescue dog|rescue cat|stray cat|stray dog|shelter dog|保護犬|里親'),
  sub('pets_animals', 'pet_care', '반려동물 케어', 'Pet Care & Training',
    '반려동물 건강|강아지 훈련|강아지 교육|반려견 훈련|펫푸드|강아지 사료|고양이 사료|사료 추천|동물병원|수의사|강형욱|' +
      'dog training|pet care|pet food|veterinarian|犬のしつけ|動物病院|獣医'),

  /* ------------------------------------------------------------------ autos */
  top('autos', '자동차', 'Autos & Vehicles',
    '자동차|차량|카리뷰|cars|car|automotive|自動車|クルマ',
    ['dailymotion:auto', 'peertube:Vehicles', 'niconico:乗り物', ...yt(2)]),
  sub('autos', 'car_review', '자동차 리뷰', 'Car Reviews',
    '신차|시승기|시승|차 리뷰|자동차 리뷰|중고차|현대차|기아차|제네시스|그랜저|쏘나타|아반떼|벤츠|포르쉐|페라리|람보르기니|' +
      'car review|test drive|new car|used car|bmw|mercedes|porsche|ferrari|lamborghini|hyundai|kia|toyota|試乗|新車|中古車|トヨタ'),
  sub('autos', 'ev', '전기차', 'Electric Vehicles',
    '전기차|테슬라|아이오닉|ev6|ev9|전기차 충전|자율주행|electric vehicle|electric vehicles|electric car|tesla|ev|byd|電気自動車|テスラ'),
  sub('autos', 'motorcycles', '오토바이', 'Motorcycles',
    '오토바이|바이크|모터사이클|할리데이비슨|스쿠터|motorcycle|motorcycles|motorbike|harley|harley-davidson|scooter|バイク|オートバイ|ツーリング'),
  sub('autos', 'car_care', '세차·정비·블랙박스', 'Car Care & Dashcams',
    '세차|디테일링|자동차 정비|정비소|엔진오일|타이어|블랙박스 영상|한문철|car wash|car detailing|oil change|tires|dashcam|mechanic|洗車|整備|ドラレコ'),
  sub('autos', 'motorsport', '모터스포츠', 'Motorsport',
    '모터스포츠|f1|포뮬러1|포뮬러 원|드리프트|레이싱카|nascar|formula 1|formula one|motogp|le mans|wrc|drifting|モータースポーツ|ドリフト|スーパーgt'),
  sub('autos', 'trains', '철도·대중교통', 'Trains & Transit',
    '철도|기차|지하철|ktx|열차|시내버스|고속버스|trains|railway|subway|bullet train|train ride|train journey|shinkansen|鉄道|電車|新幹線'),

  /* ------------------------------------------------------------------ business & finance */
  top('business_finance', '경제·금융', 'Business & Finance',
    '경제|재테크|금융|비즈니스|투자|finance|business|investing|investment|economy|経済|お金|投資|ビジネス'),
  sub('business_finance', 'stocks', '주식', 'Stocks',
    '주식|주식 투자|주가|코스피|코스닥|나스닥|s&p500|s&p 500|배당주|미국주식|etf|stocks|stock market|nasdaq|dow jones|dividend|day trading|' +
      '株式投資|日経平均|米国株|新nisa|nisa'),
  sub('business_finance', 'crypto', '가상자산', 'Crypto',
    '비트코인|이더리움|가상화폐|암호화폐|코인 투자|코인시장|알트코인|업비트|bitcoin|ethereum|crypto|cryptocurrency|btc|nft|blockchain|ビットコイン|仮想通貨|暗号資産'),
  sub('business_finance', 'real_estate', '부동산', 'Real Estate',
    '부동산|아파트 매매|아파트 청약|아파트 시세|아파트값|청약|전세사기|전세 대출|전세금|월세|집값|분양|재건축|real estate|housing market|mortgage|不動産|マンション購入|住宅ローン'),
  sub('business_finance', 'economy', '경제 동향', 'Economy',
    '경제 뉴스|금리|기준금리|환율|물가|인플레이션|경기 침체|불황|연준|한국은행|economy|economic|inflation|interest rates|recession|federal reserve|' +
      '金利|円安|インフレ|景気'),
  sub('business_finance', 'startup_business', '창업·비즈니스', 'Startups & Business',
    '창업|스타트업|자영업|자영업자|마케팅|브랜딩|사업 아이템|startup|startups|entrepreneur|small business|marketing|branding|起業|マーケティング'),
  sub('business_finance', 'personal_finance', '재테크·절약', 'Personal Finance',
    '재테크|절약|저축|적금|월급 관리|부업|파이어족|짠테크|가계부|돈 모으기|personal finance|budgeting|saving money|side hustle|passive income|make money|' +
      '節約|貯金|副業|家計簿|ポイ活'),

  /* ------------------------------------------------------------------ health & fitness */
  top('health_fitness', '건강·피트니스', 'Health & Fitness',
    '건강|헬스|운동|health|fitness|workout|健康|筋トレ|フィットネス'),
  sub('health_fitness', 'workout', '운동·홈트', 'Workouts',
    '홈트|홈트레이닝|헬스장|근력운동|근력 운동|웨이트 트레이닝|스쿼트|벤치프레스|데드리프트|복근 운동|운동 루틴|오운완|크로스핏|바디프로필|' +
      'workout|home workout|gym|exercise|bodybuilding|squat|squats|deadlift|bench press|crossfit|abs workout|筋トレ|ワークアウト|宅トレ|腹筋'),
  sub('health_fitness', 'diet', '다이어트', 'Diet & Weight Loss',
    '다이어트|식단|체중 감량|살빼기|간헐적 단식|저탄고지|키토 식단|diet|weight loss|lose weight|intermittent fasting|keto|calorie|calories|ダイエット|痩せる|減量|糖質制限'),
  sub('health_fitness', 'yoga_pilates', '요가·필라테스', 'Yoga & Pilates',
    '요가|필라테스|스트레칭|폼롤러|yoga|pilates|stretching|ヨガ|ピラティス|ストレッチ'),
  sub('health_fitness', 'running', '러닝·마라톤', 'Running',
    '러닝|달리기|마라톤|조깅|러닝크루|running tips|running shoes|trail running|marathon|jogging|half marathon|ランニング|マラソン|ジョギング'),
  sub('health_fitness', 'medical', '의학·건강 정보', 'Medical & Health Info',
    '의학|의사|병원|질병|건강 정보|건강정보|증상|치료|약사|한의사|당뇨|고혈압|치매|건강검진|' +
      'doctor|medical|health tips|symptoms|disease|pharmacist|医師|病院|医療|症状|病気'),
  sub('health_fitness', 'mental_health', '정신 건강', 'Mental Health',
    '정신건강|정신 건강|멘탈 관리|우울증|불안장애|공황장애|심리 상담|명상|자존감|mental health|anxiety|depression|meditation|therapy|mindfulness|' +
      'メンタルヘルス|瞑想|うつ病'),
  sub('health_fitness', 'nutrition', '영양·보충제', 'Nutrition & Supplements',
    '영양제|비타민|단백질|프로틴|보충제|유산균|건강식품|supplements|vitamins|protein|protein shake|nutrition|サプリ|プロテイン|栄養'),

  /* ------------------------------------------------------------------ how-to & DIY */
  top('howto_diy', '하우투·DIY', 'How-to & DIY',
    'diy|만들기|꿀팁|하는 법|하는법|how to|how-to|tutorial|tutorials|やり方|作り方|ハウツー|使い方',
    // 'dailymotion:creation' is not mapped: on real data it holds toy ads, TV clips and spam, rarely how-to.
    ['peertube:How To', ...yt(26)]),
  sub('howto_diy', 'crafts', '공예·핸드메이드', 'Crafts & Handmade',
    '공예|뜨개질|코바늘|프랑스자수|자수 도안|재봉틀|바느질|레진아트|키링 만들기|diy 소품|handmade|crafts|knitting|crochet|embroidery|sewing|origami|' +
      '手芸|編み物|刺繍|ハンドメイド|折り紙|レジン'),
  sub('howto_diy', 'art', '그림·아트', 'Art & Drawing',
    '그림|드로잉|일러스트|수채화|유화|캘리그라피|디지털 드로잉|프로크리에이트|drawing|painting|illustration|watercolor|sketchbook|procreate|calligraphy|digital art|fan art|' +
      'イラスト|お絵描き|絵の描き方|水彩|油絵',
    ['peertube:Art']),
  sub('howto_diy', 'home_repair', '집수리·공구', 'Home Repair & Tools',
    '집수리|셀프 수리|셀프 시공|목공|전동공구|공구 리뷰|페인트칠|타일 시공|home repair|woodworking|power tools|renovation|plumbing|diy project|木工|リフォーム|工具|diy'),
  sub('howto_diy', 'tips', '생활 꿀팁', 'Tips & Life Hacks',
    '꿀팁|생활꿀팁|생활 꿀팁|사용법|하는 법|하는법|꿀팁 모음|초보 가이드|life hacks|life hack|how to|how-to|tips and tricks|beginner guide|step by step|使い方|裏技|ライフハック|やり方'),
  sub('howto_diy', 'editing', '사진·영상 편집', 'Photo & Video Editing',
    '영상 편집|사진 편집|프리미어 프로|파이널컷|캡컷|포토샵|라이트룸|사진 찍는 법|카메라 설정|video editing|photo editing|premiere pro|final cut|capcut|photoshop|lightroom|photography|filmmaking|' +
      '動画編集|写真編集|カメラ設定'),
  sub('howto_diy', 'design', '디자인', 'Design',
    '그래픽 디자인|로고 디자인|ui 디자인|디자인 툴|피그마|graphic design|logo design|ui design|figma|canva|デザイン'),
  // (end of taxonomy data)
];

/**
 * Known false-positive traps for substring keywords: when an occurrence of the key keyword lies inside one of
 * the listed words, it does not count ('토너' in '토너먼트', '요리' in '요리조리', 'ライブ' in 'ドライブ').
 */
export const KEYWORD_TRAPS: Record<string, string[]> = {
  // beauty / fashion
  토너: ['토너먼트'],
  시카: ['시카고'],
  보습: ['보습학원'],
  メイク: ['リメイク'],
  단발: ['단발성'],
  염색: ['염색체'],
  네일: ['썸네일'],
  ネイル: ['サムネイル'],
  반지: ['반지의 제왕'],
  指輪: ['指輪物語'],
  하울: ['하울의 움직이는 성', '하울의'],
  haul: ['long haul', 'long-haul'],
  supreme: ['supreme court', 'supreme leader'],
  코디: ['에코디'],
  beauty: ['beauty and the beast'],
  비타민: ['비타민c 세럼', '비타민 세럼'],
  // food
  요리: ['요리조리'],
  // gaming
  게임: ['오징어 게임', '오징어게임', '게임 체인저', '게임체인저', '머니게임', '게임이론', '게임 이론', '피의 게임'],
  game: [
    'squid game', 'game changer', 'game of thrones', 'olympic games', 'asian games', 'commonwealth games', 'hunger games',
    'game day', 'ball game', 'mind game', 'blame game', 'waiting game', 'name of the game', 'game show',
    // sports match reports ('NFL Game Highlights', '403-yard game')
    'game highlights', 'game recap', 'preseason game', 'playoff game', 'yard game', 'td game', 'player of the game',
    'game-winning', 'game winning', 'game winner', 'home game', 'away game', 'bowl game', 'comm games',
  ],
  ゲーム: ['イカゲーム'],
  実況: ['実況中継', '実況アナ'],
  젠지: ['젠지 세대', '젠지세대'],
  // music / entertainment
  아이돌: ['아이돌봄'],
  ラッパー: ['ラッパー関数', 'ラッパークラス'],
  드라마: ['드라마틱'],
  reaction: ['chemical reaction', 'allergic reaction', 'chain reaction'],
  ラジオ: ['ラジオ体操'],
  コント: ['コントロール', 'コントローラ'],
  // film
  영화: ['영화롭'],
  film: ['film camera', 'film photography'],
  마블: ['마블링'],
  trailer: ['travel trailer', 'camper trailer', 'trailer park'],
  予告: ['殺害予告', '犯行予告'],
  애니: ['애니멀', '애니콜', '애니팡', '애니웨이', '애니원', '애니타임', '애니모'],
  // news
  시사: ['시사회', '시사점'],
  news: ['good news', 'bad news'],
  뉴스: ['톱스타뉴스'],
  전쟁: ['연애전쟁', '연애 전쟁', '여자전쟁', '남자전쟁', '부부전쟁', '고부전쟁', '가격전쟁', '가격 전쟁', '와의 전쟁', '과의 전쟁', '관리와 전쟁'],
  화재: ['문화재'],
  투표: ['인기투표', '인기 투표', '팬투표', '팬 투표'],
  投票: ['人気投票'],
  러시아: ['러시아워'],
  트럼프: ['트럼프 카드'],
  trump: ['trump card'],
  정당: ['정당하', '정당한', '정당성', '정당방위', '정당화'],
  // sports
  スキー: ['ウイスキー', 'ウィスキー'],
  バレー: ['シリコンバレー'],
  boxing: ['boxing day'],
  // education / tech
  상식: ['상식적', '비상식', '몰상식'],
  역사: ['역사적', '역사상'],
  테크: ['재테크', '테크닉'],
  가전: ['추가전', '참가전'],
  우주: ['우주소녀'],
  python: ['ball python'],
  // travel / lifestyle
  여행: ['시간여행', '시간 여행'],
  낚시: ['낚시성'],
  釣り: ['釣りタイトル', '釣り記事'],
  호텔: ['호텔 델루나', '호텔델루나'],
  hotel: ['hotel california'],
  resort: ['last resort'],
  interior: ['car interior', 'interior exterior', 'interior and exterior', 'interior & exterior'],
  청소: ['청소년'],
  자취: ['자취를 감', '발자취'],
  식물: ['식물성', '식물인간'],
  植物: ['植物性'],
  // kids / pets
  유아: ['유아인', '유아독존'],
  아기: ['아기 고양이', '아기고양이', '아기 강아지', '아기강아지'],
  동요: ['동요하', '동요 없', '동요없', '동요한', '동요된', '동요되'],
  출산: ['출산율', '저출산'],
  동물: ['동물의 숲'],
  animal: ['animal crossing'],
  pet: ['pet bottle', 'pet peeve'],
  ペット: ['ペットボトル'],
  dog: ['hot dog', 'top dog'],
  わんこ: ['わんこそば'],
  ねこ: ['ねこぜ'],
  インコ: ['インコース'],
  // autos / finance
  신차: ['신차원'],
  세차: ['세차게', '세차고'],
  주식: ['주식회사'],
  분양: ['강아지 분양', '고양이 분양', '강아지분양', '고양이분양'],
  business: ['business class'],
  economy: ['economy class'],
  교육: ['강아지 교육', '반려견 교육', '견 교육', '고양이 교육'],
  radio: ['lofi radio', 'lo-fi radio', 'hip hop radio', 'jazz radio', 'music radio', 'radio edit'],
  // health / how-to
  운동: [
    '운동화', '운동장', '운동회', '사회운동', '학생운동', '선거운동', '시민운동', '환경운동', '독립운동', '민주화운동', '노동운동', '운동권',
  ],
  요가: ['필요가', '중요가'],
  러닝: ['머신러닝', '딥러닝', 'e러닝', '이러닝'],
  의사: ['의사결정', '의사 결정', '의사소통', '의사표현', '의사 표현', '의사표시', '의사 표시', '의사진행'],
  병원: ['동물병원', '고양이 병원', '강아지 병원', '반려동물 병원'],
  명상: ['치명상'],
  病院: ['動物病院'],
  doctor: ['doctor who', 'doctor strange'],
  marathon: ['movie marathon', 'netflix marathon'],
  그림: ['그림자', '그림 같은', '그림같은'],
  유화: ['유화적', '유화 정책', '유화책'],
};

/**
 * Source categories that are catch-all defaults on their platform (e.g. YouTube "People & Blogs",
 * "Entertainment"): mapped with lower confidence than specific ones.
 */
export const BROAD_SOURCE_CATEGORIES: string[] = [
  ...yt(22, 24),
  'peertube:People',
  'peertube:Entertainment',
  'dailymotion:fun',
  'dailymotion:tv',
  'dailymotion:lifestyle',
  'dailymotion:creation',
  'niconico:エンターテイメント',
];

/* ------------------------------------------------------------------------------------------
 * Lookups
 * ---------------------------------------------------------------------------------------- */

let byIdCache: Map<string, TaxonomyNode> | null = null;
let childrenCache: Map<string, string[]> | null = null;

export function taxonomyById(): Map<string, TaxonomyNode> {
  if (!byIdCache) {
    byIdCache = new Map(TAXONOMY.map((n) => [n.id, n]));
  }
  return byIdCache;
}

function childrenIndex(): Map<string, string[]> {
  if (!childrenCache) {
    const m = new Map<string, string[]>();
    for (const n of TAXONOMY) {
      if (!n.parent) continue;
      const list = m.get(n.parent);
      if (list) list.push(n.id);
      else m.set(n.parent, [n.id]);
    }
    childrenCache = m;
  }
  return childrenCache;
}

/** The id itself plus all descendants. Unknown ids return just `[id]`. */
export function descendantsOf(id: string): string[] {
  const out = [id];
  const children = childrenIndex();
  for (let i = 0; i < out.length; i++) {
    const kids = children.get(out[i]);
    if (kids) for (const k of kids) if (!out.includes(k)) out.push(k);
  }
  return out;
}

/** The id and its ancestors, nearest first (`beauty/skincare` -> ['beauty/skincare', 'beauty']). */
export function ancestorsOf(id: string): string[] {
  const byId = taxonomyById();
  const out: string[] = [];
  let cur: string | null = id;
  while (cur && !out.includes(cur)) {
    out.push(cur);
    cur = byId.get(cur)?.parent ?? null;
  }
  return out;
}

/** Top-level family of a taxonomy id (`beauty/skincare` -> `beauty`), or null if unknown. */
export function topLevelOf(id: string): string | null {
  const byId = taxonomyById();
  if (!byId.has(id)) return null;
  const chain = ancestorsOf(id);
  return chain[chain.length - 1];
}

/** Display label for a taxonomy id (Korean by default), falling back to the id. */
export function categoryLabel(id: string, lang: 'ko' | 'en' = 'ko'): string {
  const node = taxonomyById().get(id);
  return node ? node.label[lang] : id;
}

/** "뷰티 › 스킨케어" style path label. */
export function categoryPathLabel(id: string, lang: 'ko' | 'en' = 'ko', sep = ' › '): string {
  if (!taxonomyById().has(id)) return id;
  return ancestorsOf(id)
    .reverse()
    .map((x) => categoryLabel(x, lang))
    .join(sep);
}

/* ------------------------------------------------------------------------------------------
 * Compiled matcher
 * ---------------------------------------------------------------------------------------- */

export const SOURCE_CONFIDENCE = 0.9;
export const BROAD_SOURCE_CONFIDENCE = 0.7;
/**
 * Account / channel seed evidence. Above a single title keyword hit (1 - e^-1 = 0.63): one ambiguous word
 * ('game' in an NFL recap, '명상' in '치명상') must not outrank what the channel is known to be about.
 */
export const ACCOUNT_CONFIDENCE = 0.7;
/**
 * Uploader-chosen source categories that proved unreliable are counted at this confidence (below a single
 * title keyword) unless a keyword of the same top-level family corroborates them. On Dailymotion 41% of top-1
 * labels came only from the channel field and about 22% of those were wrong, concentrated in the generic
 * channels and in channels news outlets misuse (MBN News items under 'auto', ABC News Australia under 'tv',
 * Ukraine reports under 'tech', swimming lessons under 'people').
 */
export const UNCORROBORATED_SOURCE_CONFIDENCE = 0.6;
/**
 * Source categories that need corroboration (see UNCORROBORATED_SOURCE_CONFIDENCE). Dailymotion's specific
 * channels (news, music, videogames, kids, sport, ...) stay trusted: on real data, overriding them with a single
 * title word was wrong about half the time ('골프 의혹' in a news report is not sports).
 */
export const UNCORROBORATED_SOURCE_CATEGORIES: readonly string[] = [
  'dailymotion:tv',
  'dailymotion:fun',
  'dailymotion:people',
  'dailymotion:lifestyle',
  'dailymotion:auto',
  'dailymotion:tech',
];
/**
 * Keyword sum below which a rule-only family counts as weak (one title word 1.0, or one tag word 0.8, or two
 * description words): such a family is not kept as a secondary label next to a family with source / account
 * evidence (single ambiguous hits were about 52% precise on real data).
 */
export const WEAK_RULE_SUM = 1.2;
export const FIELD_WEIGHTS = { title: 1.0, tags: 0.8, description: 0.4 } as const;
/** Minimum summed keyword weight for a rule assignment (one title or tag hit, or two description hits). */
export const MIN_RULE_SCORE = 0.8;
export const MAX_TOP_LEVEL = 3;
export const MAX_SUB_PER_TOP = 3;
export const MAX_TOPICS = 10;
const CONFIDENCE_CAP = 0.99;
/** ASCII keywords at least this long may be glued to a following word ('skincare' in 'skincareroutine'). */
const ASCII_PREFIX_GLUE_MIN = 7;

interface KeywordEntry {
  /** Text to find (normalized; the space-less variant of a spaced keyword is a separate entry). */
  find: string;
  /** Keyword as listed in the taxonomy (used as evidence). */
  label: string;
  nodeIds: string[];
  /** Trap words containing `find`, with every offset of `find` inside the trap. */
  traps: { word: string; offsets: number[] }[] | null;
}

interface Compiled {
  /** Non-ASCII keywords indexed by their first two UTF-16 code units. */
  cjk: Map<number, KeywordEntry[]>;
  /** ASCII keywords indexed by their first two code units (single-char keywords by one). */
  ascii: Map<number, KeywordEntry[]>;
  /** normalized source category -> node ids + confidence */
  sources: Map<string, { ids: string[]; confidence: number }>;
  /** normalized source categories that need keyword corroboration */
  uncorroborated: Set<string>;
}

let compiled: Compiled | null = null;

function pairKey(s: string, i: number): number {
  return (s.charCodeAt(i) << 16) | (i + 1 < s.length ? s.charCodeAt(i + 1) : 0);
}

function offsetsOf(hay: string, needle: string): number[] {
  const out: number[] = [];
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) out.push(i);
  return out;
}

function compile(): Compiled {
  if (compiled) return compiled;
  const traps = new Map<string, string[]>();
  for (const [k, words] of Object.entries(KEYWORD_TRAPS)) traps.set(normalizeText(k), words.map(normalizeText));

  const entries = new Map<string, KeywordEntry>();
  const add = (find: string, label: string, nodeId: string) => {
    let e = entries.get(find);
    if (!e) {
      const trapWords = [...(traps.get(label) ?? []), ...(label !== find ? (traps.get(find) ?? []) : [])];
      const t = trapWords
        .map((word) => ({ word, offsets: offsetsOf(word, find) }))
        .filter((x) => x.offsets.length > 0);
      e = { find, label, nodeIds: [], traps: t.length ? t : null };
      entries.set(find, e);
    }
    if (!e.nodeIds.includes(nodeId)) e.nodeIds.push(nodeId);
  };
  for (const node of TAXONOMY) {
    for (const k of node.keywords) {
      add(k, k, node.id);
      if (!isAsciiKeyword(k) && k.includes(' ')) add(k.replace(/ /g, ''), k, node.id);
    }
  }

  const cjk = new Map<number, KeywordEntry[]>();
  const ascii = new Map<number, KeywordEntry[]>();
  for (const e of entries.values()) {
    if (e.find.length < 2) continue; // single characters are too ambiguous (and the index is bigram-based)
    const target = isAsciiKeyword(e.find) ? ascii : cjk;
    const key = pairKey(e.find, 0);
    const list = target.get(key);
    if (list) list.push(e);
    else target.set(key, [e]);
  }
  // Longest first so evidence prefers the most specific keyword at a position.
  for (const list of [...cjk.values(), ...ascii.values()]) list.sort((a, b) => b.find.length - a.find.length);

  const broad = new Set(BROAD_SOURCE_CATEGORIES.map(normalizeText));
  const sources = new Map<string, { ids: string[]; confidence: number }>();
  for (const node of TAXONOMY) {
    for (const sc of node.sourceCategories) {
      const key = normalizeText(sc);
      const cur = sources.get(key) ?? { ids: [], confidence: broad.has(key) ? BROAD_SOURCE_CONFIDENCE : SOURCE_CONFIDENCE };
      if (!cur.ids.includes(node.id)) cur.ids.push(node.id);
      sources.set(key, cur);
    }
  }
  compiled = { cjk, ascii, sources, uncorroborated: new Set(UNCORROBORATED_SOURCE_CATEGORIES.map(normalizeText)) };
  return compiled;
}

function isTrapped(text: string, pos: number, e: KeywordEntry): boolean {
  if (!e.traps) return false;
  for (const t of e.traps) {
    for (const o of t.offsets) {
      const start = pos - o;
      if (start >= 0 && text.startsWith(t.word, start)) return true;
    }
  }
  return false;
}

function asciiRightBoundaryOk(text: string, end: number, kwLen: number, glue: boolean): boolean {
  const next = text[end];
  if (!isLatinWordChar(next)) return true;
  // plural / 3rd-person suffix: 's' always, 'es' only where English spells it (boxes, matches, dishes, heroes),
  // so 'car' does not match 'cares' and 'game' does not match 'gamees'
  if (next === 's' && !isLatinWordChar(text[end + 1])) return true;
  if (next === 'e' && text[end + 1] === 's' && !isLatinWordChar(text[end + 2]) && /(?:s|x|z|ch|sh|o)$/.test(text.slice(end - kwLen, end))) {
    return true;
  }
  // glued compound ('#skincareroutine'): only in hashtags / tags, never in prose ('mechanical', 'protestant')
  return glue && kwLen >= ASCII_PREFIX_GLUE_MIN;
}

/**
 * Find all keyword entries occurring in an already-normalized text. Calls `onHit` once per distinct entry
 * label. Linear in the text length (bigram index), independent of the taxonomy size.
 */
function scanText(text: string, onHit: (e: KeywordEntry) => void, gluedTokens = false): void {
  if (!text) return;
  const c = compile();
  const seen = new Set<string>();
  // End of the furthest accepted match: a keyword lying entirely inside an already matched longer keyword
  // ('토너' inside '토너패드', 'makeup' inside 'makeup tutorial') is not counted again.
  let coverEnd = -1;
  const n = text.length;
  for (let i = 0; i < n - 1; i++) {
    const key = pairKey(text, i);
    const wordStart = !isLatinWordChar(text[i - 1]);
    // Non-ASCII (Korean/Japanese/mixed) keywords: substring match. A mixed keyword starting with a Latin
    // letter/digit ('k뷰티', '1박 2일') still needs a left word boundary.
    const cjkList = c.cjk.get(key);
    if (cjkList) {
      for (const e of cjkList) {
        if (seen.has(e.label) || i + e.find.length <= coverEnd || !text.startsWith(e.find, i)) continue;
        if (!wordStart && isLatinWordChar(e.find[0])) continue;
        if (isTrapped(text, i, e)) continue;
        seen.add(e.label);
        coverEnd = Math.max(coverEnd, i + e.find.length);
        onHit(e);
      }
    }
    // ASCII keywords: only at a Latin word start, with a right word boundary.
    if (!wordStart) continue;
    const asciiList = c.ascii.get(key);
    if (!asciiList) continue;
    for (const e of asciiList) {
      if (seen.has(e.label) || i + e.find.length <= coverEnd || !text.startsWith(e.find, i)) continue;
      const glue = gluedTokens || text[i - 1] === '#';
      if (isLatinWordChar(e.find[0]) && !asciiRightBoundaryOk(text, i + e.find.length, e.find.length, glue)) continue;
      if (isTrapped(text, i, e)) continue;
      seen.add(e.label);
      coverEnd = Math.max(coverEnd, i + e.find.length);
      onHit(e);
    }
  }
}

/** Keywords (as listed) of the taxonomy found in `text`, with the nodes they point to. Useful for debugging/UI. */
export function findKeywords(text: string): { keyword: string; nodeIds: string[] }[] {
  const out: { keyword: string; nodeIds: string[] }[] = [];
  scanText(normalizeText(text), (e) => out.push({ keyword: e.label, nodeIds: [...e.nodeIds] }));
  return out;
}

/* ------------------------------------------------------------------------------------------
 * Topics
 * ---------------------------------------------------------------------------------------- */

/** Generic tags that say nothing about the content; never emitted as topics. */
export const STOP_TOPICS: ReadonlySet<string> = new Set(
  kw(
    'shorts|short|youtube|youtuber|youtubeshorts|ytshorts|shortsvideo|shortvideo|shortsfeed|shortsviral|shortsyoutube|' +
      'fyp|fy|fypシ|foryou|foryoupage|for you|xyzbca|viral|viralvideo|viralshorts|trending|trend|trendingshorts|explore|explorepage|' +
      'video|videos|clip|clips|tiktok|reels|reel|instagram|insta|instagood|facebook|subscribe|like|likes|follow|comment|share|' +
      'new|new video|official|eng|sub|engsub|eng sub|eng subs|kor|kor sub|jpn|cc|4k|8k|hd|fhd|uhd|full|full ver|full version|' +
      'live|ep|episode|part|shorts feed|' +
      '영상|쇼츠|숏츠|숏폼|유튜브|유튜버|유튜브쇼츠|구독|구독과좋아요|좋아요|댓글|추천|알고리즘|인기|인기급상승|인기동영상|급상승|떡상|' +
      '틱톡|릴스|동영상|자막|한글자막|영어자막|풀버전|최신|신규|공식|' +
      '動画|おすすめ|オススメ|ショート|ショート動画|ユーチューブ|バズれ|バズりたい|拡散希望|字幕|切り抜き動画|' +
      // broadcaster boilerplate put on every upload (real data: '뉴스' 1,078 videos, 'ytn' 1,027, 'mbn-i' 120)
      '뉴스|news|ytn|mbn|mbn-i|매일방송|프로그램|전국|top영상|ニュース',
  ),
);

/** True for generic tags that say nothing about the content (STOP_TOPICS), also for already extracted topics. */
export function isGenericTopic(topic: string): boolean {
  const t = normalizeText(topic);
  return STOP_TOPICS.has(t) || STOP_TOPICS.has(t.replace(/ /g, ''));
}

/** Comparison key for self-topic checks: normalized, without '@', spaces and name punctuation. */
function selfKey(s: string): string {
  return normalizeText(s).replace(/^@/, '').replace(/[\s_\-.·・'’]/g, '');
}

/** The account's name, its '|' / '/' separated parts and its handle as self-topic keys (see isSelfTopic). */
function selfKeys(account: { name?: string | null; handle?: string | null }): string[] {
  const out: string[] = [];
  const add = (x: string | null | undefined) => {
    const k = x ? selfKey(x) : '';
    if (k.length >= 2 && !out.includes(k)) out.push(k);
  };
  add(account.name);
  for (const part of (account.name ?? '').split(/\s[|/]\s|[|｜]/)) add(part);
  add(account.handle);
  return out;
}

/**
 * True when `topic` is the uploading channel's own name or handle used as a tag ('#노트펫' on 노트펫's videos,
 * 'wolfen heiger' on Wolfen Heiger's): it labels the channel, not the content, and would turn every channel
 * into its own "trend". Compared without spaces / punctuation ('ogn plus' = 'OGN PLUS').
 */
export function isSelfTopic(topic: string, account: { name?: string | null; handle?: string | null } | null | undefined): boolean {
  if (!account) return false;
  const t = selfKey(topic);
  if (t.length < 2) return false;
  return selfKeys(account).includes(t);
}

const BRACKET_RE = /[\[【〔〖]([^\[\]【】〔〕〖〗]{1,40})[\]】〕〗]/g;
const EPISODE_RE = /^(?:ep|e|#|제|第|vol|part|pt)?\.?\s*\d+\s*(?:회|화|부|편|話|회차|ep|탄)?$/;
const DATE_OR_NUMBER_RE = /^[\d\s.\-/:~_,]+$/;
const TOPIC_TRIM_RE = /^[\s#'"`.,:;!?~\-_|/·•]+|[\s'"`.,:;!?~\-_|/·•]+$/g;

function cleanTopic(raw: string): string | null {
  const t = normalizeText(raw).replace(TOPIC_TRIM_RE, '');
  if (t.length < 2 || t.length > 40) return null;
  if (DATE_OR_NUMBER_RE.test(t) || EPISODE_RE.test(t)) return null;
  if (STOP_TOPICS.has(t) || STOP_TOPICS.has(t.replace(/ /g, ''))) return null;
  return t;
}

/** Series / label names in brackets: '[지금이뉴스]', '【MV】', '[ENG SUB]' (stop-listed). */
export function extractBracketTopics(title: string): string[] {
  const out: string[] = [];
  const text = normalizeText(title); // NFKC maps '［］' to '[]'
  BRACKET_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BRACKET_RE.exec(text)) !== null) {
    for (const part of m[1].split(/[|/,·•]| x /)) {
      const t = cleanTopic(part);
      if (t && !out.includes(t)) out.push(t);
    }
  }
  return out;
}

/**
 * Normalized topic keys for a video: bracketed series names and hashtags in the title, then tags, then
 * description hashtags. Generic stop-topics are removed, and so is the uploading channel's own name / handle
 * when given (isSelfTopic); at most `MAX_TOPICS` (10).
 */
export function extractTopics(
  input: { title: string; description: string | null; tags: string[]; accountName?: string | null; accountHandle?: string | null },
  max = MAX_TOPICS,
): string[] {
  const out: string[] = [];
  const self = input.accountName || input.accountHandle ? { name: input.accountName ?? null, handle: input.accountHandle ?? null } : null;
  const push = (raw: string) => {
    if (out.length >= max) return;
    const t = cleanTopic(raw);
    if (t && !out.includes(t) && !isSelfTopic(t, self)) out.push(t);
  };
  for (const t of extractBracketTopics(input.title)) push(t);
  for (const t of extractHashtags(input.title)) push(t);
  for (const t of input.tags) push(t);
  if (input.description) for (const t of extractHashtags(input.description)) push(t);
  return out;
}

/* ------------------------------------------------------------------------------------------
 * Classifier
 * ---------------------------------------------------------------------------------------- */

export interface ClassifyInput {
  title: string;
  description: string | null;
  tags: string[];
  /** Namespaced source category, e.g. 'dailymotion:news', 'peertube:Music', 'niconico:ゲーム'. */
  sourceCategory: string | null;
  accountSeedCategory: string | null;
  language: string | null;
  /** Uploading account's display name / handle (optional): its own name used as a tag is not a topic. */
  accountName?: string | null;
  accountHandle?: string | null;
}

interface NodeAcc {
  source: number;
  /** The source signal comes from an uploader-chosen category that needs keyword corroboration. */
  sourceNeedsCorroboration: boolean;
  account: number;
  /** keyword label -> best field weight */
  rule: Map<string, number>;
  evidence: Evidence[];
}

function accFor(map: Map<string, NodeAcc>, id: string): NodeAcc {
  let a = map.get(id);
  if (!a) {
    a = { source: 0, sourceNeedsCorroboration: false, account: 0, rule: new Map(), evidence: [] };
    map.set(id, a);
  }
  return a;
}

function pushEvidence(a: NodeAcc, ev: Evidence): void {
  if (!a.evidence.some((e) => e.field === ev.field && e.match === ev.match)) a.evidence.push(ev);
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** Resolve a seed value ('beauty', 'Beauty/Skincare ') to a known taxonomy id, or null. */
function resolveTaxonomyId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const id = normalizeText(raw).replace(/\s*\/\s*/g, '/');
  return taxonomyById().has(id) ? id : null;
}

type FieldName = 'title' | 'tags' | 'description';

/** Multi-label classification with evidence; also returns normalized topics (hashtags/tags/key phrases). */
export function classifyVideo(input: ClassifyInput): { categories: CategoryAssignment[]; topics: string[] } {
  const accs = new Map<string, NodeAcc>();
  const byId = taxonomyById();
  const c = compile();

  // 1. Source-native category
  const rawSource = input.sourceCategory?.trim() || null;
  if (rawSource) {
    const key = normalizeText(rawSource);
    const seedPrefix = 'youtube:seed:';
    if (key.startsWith(seedPrefix)) {
      // Channel-level seed: says what the channel is about, not what this video is about.
      const id = resolveTaxonomyId(key.slice(seedPrefix.length));
      if (id) {
        for (const a of ancestorsOf(id)) {
          const acc = accFor(accs, a);
          acc.account = Math.max(acc.account, ACCOUNT_CONFIDENCE);
          pushEvidence(acc, { field: 'sourceCategory', match: rawSource });
        }
      }
    } else {
      const mapped = c.sources.get(key);
      if (mapped) {
        const needsCorroboration = c.uncorroborated.has(key);
        for (const id of mapped.ids) {
          for (const a of ancestorsOf(id)) {
            const acc = accFor(accs, a);
            acc.source = Math.max(acc.source, mapped.confidence);
            acc.sourceNeedsCorroboration = needsCorroboration;
            pushEvidence(acc, { field: 'sourceCategory', match: rawSource });
          }
        }
      }
    }
  }

  // 2. Account seed category
  const seedId = resolveTaxonomyId(input.accountSeedCategory);
  if (seedId) {
    for (const a of ancestorsOf(seedId)) {
      const acc = accFor(accs, a);
      acc.account = Math.max(acc.account, ACCOUNT_CONFIDENCE);
      pushEvidence(acc, { field: 'account', match: input.accountSeedCategory!.trim() });
    }
  }

  // 3. Keyword rules
  const fields: [FieldName, string][] = [
    ['title', normalizeText(input.title ?? '')],
    ['tags', (input.tags ?? []).map(normalizeText).filter(Boolean).join(' | ')],
    ['description', normalizeText(input.description ?? '')],
  ];
  for (const [field, text] of fields) {
    const w = FIELD_WEIGHTS[field];
    scanText(text, (e) => {
      for (const nodeId of e.nodeIds) {
        for (const a of ancestorsOf(nodeId)) {
          const acc = accFor(accs, a);
          const prev = acc.rule.get(e.label) ?? 0;
          if (w > prev) acc.rule.set(e.label, w);
          pushEvidence(acc, { field, match: e.label });
        }
      }
    }, field === 'tags');
  }

  // 4. Score
  interface Scored {
    id: string;
    confidence: number;
    by: CategoryAssignment['by'];
    evidence: Evidence[];
    /** Only a rule signal, and a weak one (keyword sum < WEAK_RULE_SUM). */
    weakRuleOnly: boolean;
    /** Has a source or account signal. */
    anchored: boolean;
  }
  const scored = new Map<string, Scored>();
  for (const [id, a] of accs) {
    if (!byId.has(id)) continue;
    let ruleSum = 0;
    for (const v of a.rule.values()) ruleSum += v;
    const rule = ruleSum >= MIN_RULE_SCORE - 1e-9 ? 1 - Math.exp(-ruleSum) : 0;
    // An uploader-chosen source category counts fully only when a keyword of the same family (any field, any
    // weight) agrees with it; the family's top-level node collects every keyword hit of its subcategories.
    let source = a.source;
    if (source > 0 && a.sourceNeedsCorroboration) {
      const family = accs.get(topLevelOf(id) ?? id);
      if (!family || family.rule.size === 0) source = Math.min(source, UNCORROBORATED_SOURCE_CONFIDENCE);
    }
    const parts: [CategoryAssignment['by'], number][] = [
      ['source', source],
      ['rule', rule],
      ['account', a.account],
    ];
    const active = parts.filter(([, v]) => v > 0);
    if (!active.length) continue;
    const combined = Math.min(CONFIDENCE_CAP, 1 - active.reduce((p, [, v]) => p * (1 - v), 1));
    // strongest single contributor; ties resolved in source > rule > account order
    let by = active[0][0];
    let best = active[0][1];
    for (const [k, v] of active) if (v > best + 1e-9) [by, best] = [k, v];
    // Drop evidence from signals that did not count (e.g. a lone description hit below the rule threshold).
    const evidence = a.evidence.filter((e) =>
      e.field === 'sourceCategory' || e.field === 'account' || e.field === 'manual' ? true : rule > 0,
    );
    const anchored = source > 0 || a.account > 0;
    scored.set(id, { id, confidence: round2(combined), by, evidence, weakRuleOnly: !anchored && ruleSum < WEAK_RULE_SUM, anchored });
  }

  // 5. Select families (max 3) and subcategories (max 3 each). A secondary family resting on one ambiguous
  // keyword is dropped when another family is backed by the source or the account.
  const rank = (a: Scored, b: Scored) =>
    b.confidence - a.confidence || b.evidence.length - a.evidence.length || TAXONOMY.indexOf(byId.get(a.id)!) - TAXONOMY.indexOf(byId.get(b.id)!);
  const families = [...scored.values()].filter((s) => byId.get(s.id)!.parent === null).sort(rank);
  const anyAnchored = families.some((f) => f.anchored);
  const tops = families.filter((f, i) => i === 0 || !(f.weakRuleOnly && anyAnchored)).slice(0, MAX_TOP_LEVEL);
  const categories: CategoryAssignment[] = [];
  for (const t of tops) {
    categories.push({ id: t.id, confidence: t.confidence, evidence: t.evidence, by: t.by, version: CLASSIFIER_VERSION });
    const subs = [...scored.values()]
      .filter((s) => s.id !== t.id && topLevelOf(s.id) === t.id)
      .sort(rank)
      .slice(0, MAX_SUB_PER_TOP);
    for (const s of subs) categories.push({ id: s.id, confidence: s.confidence, evidence: s.evidence, by: s.by, version: CLASSIFIER_VERSION });
  }

  return { categories, topics: extractTopics(input) };
}
