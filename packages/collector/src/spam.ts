/**
 * Promotional spam gate (illegal gambling / sex-trade / loan-shark ads). OWNER: collector-pipeline.
 *
 * Dailymotion's `visited-*:kr` lists carry a steady stream of uploads whose only purpose is to advertise
 * gambling sites ("카지노 … AST766.com 가입코드 7410"), escort services ("출장마사지 … 카톡 sxx77") or loans. They are
 * not content, so the pipeline never stores them and the export hides the ones already stored (principle 4: both
 * record what was excluded).
 *
 * Scoring (all matching on normalized text, see `normalizeForSpam`):
 * - promo keywords: strong ones (바카라, 파워볼, 총판, 가입코드, 출장마사지, 콜걸, 오피걸, 작업대출, …) score 2, words that
 *   also occur in news / everyday text (카지노, 토토, 베팅, 먹튀, 경마, …) score 1;
 * - ad markers: an address in the title/tags (`ssp778.com`, `opdaiso.com`), a spaced or obfuscated address
 *   (`opopgirl01 com`, `hot-700.콤`), a messenger id or phone number in the title, Hangul-jamo obfuscation
 *   (`ㅋㅏ지노`, `ㅂㅐ팅`) and an account name that itself advertises (`카지노,바카라,…pb-1414.com`) score 2;
 *   a digit-bearing address in the description scores 2, a messenger id / phone / sign-up code there scores 1.
 * A video is spam when it has a promo keyword (or an advertising account name), ad markers worth ≥ 2 and a total
 * ≥ 3. So news such as `"가만두면 삼천리에 카지노"...` (keyword, no marker), a travel vlog about a casino with a
 * contact number in the description (1 + 1), and a channel named after its plain domain (`BeardedTek.com`, no
 * keyword) are kept.
 */

export interface SpamCheckInput {
  title: string | null | undefined;
  description?: string | null;
  tags?: readonly string[] | null;
}

export interface SpamCheckAccount {
  name?: string | null;
  handle?: string | null;
}

/** [pattern, weight]: 2 = only used by ads, 1 = also used in news / everyday text. */
const PROMO_KEYWORDS: readonly [RegExp, number][] = [
  [/바카라/, 2],
  [/파워볼/, 2],
  [/총판/, 2],
  [/가입\s*코드/, 2],
  [/첫\s*충|매\s*충/, 2],
  [/사설\s*토토|토토\s*사이트|카지노\s*사이트|바카라\s*사이트|배팅\s*사이트|베팅\s*사이트/, 2],
  [/안전\s*놀이터|메이저\s*사이트|먹튀\s*(검증|사이트|보증)/, 2],
  [/출장\s*(샵|마사지|안마|만남|업소)/, 2],
  [/콜걸/, 2],
  [/오피\s*(걸|방|사이트)|휴게텔|키스방|안마방|립카페|풀싸롱/, 2],
  [/작업\s*대출|소액\s*대출|무직자\s*대출|당일\s*대출/, 2],
  [/카지노/, 1],
  [/토토(?!로)/, 1],
  [/[배베]팅/, 1],
  [/먹튀/, 1],
  [/경마/, 1],
  [/사다리\s*(게임|분석|픽)/, 1],
  [/슬롯\s*머신|홀덤/, 1],
  [/오피(?!셜|스|니언|너|\s*(걸|방|사이트))/, 1],
  [/건마/, 1],
  [/고페이|고소득\s*알바/, 1],
];

/** Well-known domains that legitimately appear in text (never an ad marker by themselves). */
const COMMON_DOMAINS =
  /^(youtube|youtu|instagram|facebook|twitter|x|tiktok|naver|daum|hanmail|kakao|gmail|google|apple|spotify|twitch|dailymotion|nicovideo|discord|linktr|patreon|github|bit|wikipedia|namu)\./;

const TLD = '(?:com|net|org|kr|xyz|top|vip|club|site|bet|콤|컴|닷컴)';
/** `name.tld` after dot/space normalization; `[\p{L}\p{N}-]` also covers Hangul names (`썬뱃.com`). */
const DOMAIN_RE = new RegExp(`([\\p{L}\\p{N}][\\p{L}\\p{N}-]{1,40})\\.${TLD}(?![\\p{L}\\p{N}])`, 'gu');
/** `opopgirl01 com`: a token with a digit followed by a spaced TLD. */
const SPACED_TLD_RE = /(?:^|[^\p{L}\p{N}])[a-z]*\d[a-z0-9-]*\s+(?:com|net)(?![\p{L}\p{N}])/u;
/** Messenger ids: `카톡 PG53`, `카톡:JD82`, `캬톡 GAA56`, `텔레 abc12`, jamo-obfuscated `ㅋ ㅏ톡sxx77`. */
const MESSENGER_RE = /(카카오톡|카톡|캬톡|ㅋ\s*ㅏ\s*톡|텔레그램|텔레|라인)\s*(?:id|아이디)?\s*[:：]?\s*[a-z]+[a-z0-9_]*\d[a-z0-9_]*/u;
/** Korean mobile numbers, also with letters that look like digits (`Ö1Ô-3O48-6264` -> `010-3048-6264`). */
const PHONE_RE = /(?<!\d)01[016789]\s*[-.\s]?\s*\d{3,4}\s*[-.\s]?\s*\d{4}(?!\d)/;
/** Sign-up / referral codes with a value (`가입코드 7410`, `추천인 1212`, `추천코드 bis77`). */
const CODE_RE = /(가입\s*코드|추천인(\s*코드)?|추천\s*코드)\s*[:：]?\s*[a-z0-9]{3,}/u;
/** Hangul-jamo obfuscation: a consonant jamo directly followed by a vowel jamo (`ㅋㅏ`, `ㅂㅐ`, `ㅌ ㅗ`). */
const JAMO_PAIR_RE = /[ㄱ-ㅎ]\s?[ㅏ-ㅣ]/gu;
/** Account names made of promo codes seen on gambling ads. */
const AD_CODE_RE = /pb-\d{3,}|vegas\d{3}|asta\d{3}|ast\d{3,}/;

/** Spaces around a dot that precedes a TLD (`sgm58 . 컴`, `girl01 . com`). */
const DOT_BEFORE_TLD_RE = new RegExp(`\\s*\\.\\s*(?=${TLD}(?![\\p{L}\\p{N}]))`, 'gu');
const COMBINING_MARKS_RE = /[̀-ͯ]/g;

/** NFKC + lowercase + diacritics stripped, ideographic/fullwidth dots unified, spaces around `. com` removed. */
export function normalizeForSpam(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .normalize('NFKC')
    .normalize('NFD')
    .replace(COMBINING_MARKS_RE, '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[。｡．]/g, '.')
    .replace(DOT_BEFORE_TLD_RE, '.');
}

/** Digits in disguise (`o1o-3o48` -> `010-3048`) for the phone-number check only. */
function digitsLookalike(s: string): string {
  return s.replace(/o/g, '0').replace(/[l|]/g, '1');
}

function keywordHits(text: string): { words: string[]; score: number } {
  const words: string[] = [];
  let score = 0;
  for (const [re, weight] of PROMO_KEYWORDS) {
    const m = re.exec(text);
    if (!m) continue;
    words.push(m[0].replace(/\s+/g, ''));
    score += weight;
  }
  return { words, score };
}

/** Uncommon domains in `text`; `onlySuspicious` keeps only digit-bearing or obfuscated-TLD ones. */
function domainsIn(text: string, onlySuspicious: boolean): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(DOMAIN_RE)) {
    const whole = m[0];
    if (COMMON_DOMAINS.test(whole)) continue;
    if (onlySuspicious && !/\d/.test(m[1]) && !/\.(콤|컴|닷컴)$/.test(whole)) continue;
    out.push(whole);
  }
  return out;
}

interface Marker {
  label: string;
  score: number;
}

function jamoObfuscated(text: string): boolean {
  return (text.match(JAMO_PAIR_RE) ?? []).length >= 2;
}

function titleMarkers(text: string): Marker[] {
  const out: Marker[] = [];
  const domains = domainsIn(text, false);
  if (domains.length) out.push({ label: `주소 ${domains[0]}`, score: 2 });
  if (SPACED_TLD_RE.test(text)) out.push({ label: '띄어 쓴 주소', score: 2 });
  const messenger = MESSENGER_RE.exec(text);
  if (messenger) out.push({ label: `메신저 ${messenger[0].replace(/\s+/g, '')}`, score: 2 });
  if (PHONE_RE.test(digitsLookalike(text))) out.push({ label: '전화번호', score: 2 });
  if (CODE_RE.test(text)) out.push({ label: '가입·추천 코드', score: 1 });
  if (jamoObfuscated(text)) out.push({ label: '자모 분리 표기', score: 2 });
  return out;
}

function descriptionMarkers(text: string): Marker[] {
  const out: Marker[] = [];
  const domains = domainsIn(text, true);
  if (domains.length) out.push({ label: `주소 ${domains[0]}`, score: 2 });
  if (SPACED_TLD_RE.test(text)) out.push({ label: '띄어 쓴 주소', score: 2 });
  if (MESSENGER_RE.test(text)) out.push({ label: '메신저 ID', score: 1 });
  if (PHONE_RE.test(digitsLookalike(text))) out.push({ label: '전화번호', score: 1 });
  if (CODE_RE.test(text)) out.push({ label: '가입·추천 코드', score: 1 });
  if (jamoObfuscated(text)) out.push({ label: '자모 분리 표기', score: 2 });
  return out;
}

/**
 * Why a video looks like promotional spam, or null when it does not (see the file header for the rule).
 * The reason is a short Korean phrase for run notes, e.g. `키워드 바카라·토토 + 주소 ast766.com`.
 */
export function promoSpamReason(video: SpamCheckInput, account?: SpamCheckAccount | null): string | null {
  const head = normalizeForSpam([video.title ?? '', ...(video.tags ?? [])].join(' \n '));
  const desc = normalizeForSpam(video.description);
  const accountText = normalizeForSpam([account?.name, account?.handle].filter(Boolean).join(' '));

  const kwHead = keywordHits(head);
  const kwDesc = keywordHits(desc);
  const words = [...new Set([...kwHead.words, ...kwDesc.words])];
  const kwScore = Math.max(kwHead.score, kwDesc.score);
  const accountKw = keywordHits(accountText);
  const accountAdvertises = accountKw.score > 0 && (domainsIn(accountText, false).length > 0 || AD_CODE_RE.test(accountText));
  if (kwScore === 0 && !accountAdvertises) return null;

  const markers: Marker[] = [...titleMarkers(head), ...descriptionMarkers(desc)];
  if (accountAdvertises) markers.push({ label: '광고성 계정명', score: 3 });
  const markerScore = markers.reduce((n, m) => n + m.score, 0);
  if (markerScore < 2 || kwScore + markerScore < 3) return null;
  const kw = words.length ? `키워드 ${words.slice(0, 3).join('·')}` : `계정명 ${accountKw.words.slice(0, 2).join('·')}`;
  return `${kw} + ${[...new Set(markers.map((m) => m.label))].slice(0, 2).join(', ')}`;
}

export function isPromoSpam(video: SpamCheckInput, account?: SpamCheckAccount | null): boolean {
  return promoSpamReason(video, account) !== null;
}
