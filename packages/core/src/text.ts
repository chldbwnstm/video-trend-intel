/**
 * Text normalization helpers shared by classifier, search and topics. OWNER: core-taxonomy agent.
 *
 * Everything here is pure, allocation-light and safe to call in hot loops (browser + node).
 */

/** Zero-width / invisible formatting characters that break substring matching (ZWSP, ZWNJ, ZWJ, BOM, WJ, soft hyphen). */
export const INVISIBLE_RE = new RegExp(`[${String.fromCharCode(0xad, 0x200b)}-${String.fromCharCode(0x200d, 0x2060, 0xfeff)}]`, 'g');
const WHITESPACE_RE = /\s+/g;

/** NFKC, lowercase, collapse whitespace, trim. */
export function normalizeText(s: string): string {
  if (!s) return '';
  return s.normalize('NFKC').replace(INVISIBLE_RE, '').toLowerCase().replace(WHITESPACE_RE, ' ').trim();
}

/**
 * Characters allowed inside a hashtag body: Hangul (incl. compatibility jamo), Latin, Hiragana, Katakana,
 * Han (Kanji), digits, underscore, and the Japanese prolonged sound mark / iteration marks (Script=Common).
 */
const HASHTAG_BODY = '[\\p{Script=Hangul}\\p{Script=Latin}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Han}\\p{Nd}_\\u30FC\\u30FB\\u3005]+';
/**
 * A hashtag must start the string or follow a character that cannot be part of a word/URL/entity,
 * so `https://x.com/page#section`, `abc#tag` and `&#39;` are not hashtags (`##tag` still yields `tag`).
 */
const HASHTAG_RE = new RegExp(`(^|[^\\p{L}\\p{N}_&/])#(${HASHTAG_BODY})`, 'gu');
const DIGITS_ONLY_RE = /^[\d_]+$/;

/** Extract hashtags (#태그, #tag, #タグ) normalized, without '#', de-duplicated (first occurrence order). */
export function extractHashtags(s: string): string[] {
  if (!s || (s.indexOf('#') < 0 && s.indexOf('＃') < 0)) return [];
  const text = normalizeText(s); // NFKC maps the full-width '＃' to '#'
  const out: string[] = [];
  const seen = new Set<string>();
  HASHTAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HASHTAG_RE.exec(text)) !== null) {
    // Trim trailing/leading underscores and the prolonged mark used as decoration ('#tag__', '#ー').
    const tag = m[2].replace(/^[_ー・]+|[_・]+$/g, '');
    if (!tag || DIGITS_ONLY_RE.test(tag)) continue; // '#1', '#2024' are rankings/years, not topics
    if (!seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
    }
  }
  return out;
}

/** Case/width-insensitive substring match suitable for Korean/Japanese/English search. Empty needle matches. */
export function textMatches(haystack: string, needle: string): boolean {
  const n = normalizeText(needle);
  if (!n) return true;
  if (!haystack) return false;
  return normalizeText(haystack).includes(n);
}

/**
 * True when every whitespace-separated term of `query` occurs in `haystack` (normalized, AND semantics).
 * Convenience for search boxes: '뷰티 루틴' matches '데일리 뷰티 모닝 루틴'.
 */
export function textMatchesAll(haystack: string, query: string): boolean {
  const q = normalizeText(query);
  if (!q) return true;
  const h = normalizeText(haystack);
  if (!h) return false;
  for (const term of q.split(' ')) if (!h.includes(term)) return false;
  return true;
}

/** Remove all whitespace after normalization (Korean spacing is inconsistent: '유료 광고' vs '유료광고'). */
export function compactText(s: string): string {
  return normalizeText(s).replace(/ /g, '');
}

/** True for characters that make up a Latin/number "word" (used for word-boundary checks). */
export function isLatinWordChar(ch: string | undefined): boolean {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  if ((c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a)) return true;
  if (c < 0xc0) return false;
  return /[\p{Script=Latin}\p{Nd}]/u.test(ch);
}

/** True when the keyword consists only of ASCII characters (matched on word boundaries by the classifiers). */
export function isAsciiKeyword(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) return false;
  return true;
}
