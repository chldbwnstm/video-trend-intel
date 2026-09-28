import { describe, expect, it } from 'vitest';
import {
  compactText,
  extractHashtags,
  isAsciiKeyword,
  isLatinWordChar,
  normalizeText,
  textMatches,
  textMatchesAll,
} from '../src/text.ts';

const ZWSP = String.fromCharCode(0x200b);
const BOM = String.fromCharCode(0xfeff);
const SHY = String.fromCharCode(0xad);

describe('normalizeText', () => {
  it('applies NFKC (full-width Latin/digits, half-width katakana) and lowercases', () => {
    expect(normalizeText('ＡＢＣ１２３')).toBe('abc123');
    expect(normalizeText('ｶﾀｶﾅ')).toBe('カタカナ');
    expect(normalizeText('K-POP ＭＶ')).toBe('k-pop mv');
    expect(normalizeText('Ⅻ')).toBe('xii');
  });

  it('collapses all whitespace (incl. ideographic space, tabs, newlines) and trims', () => {
    expect(normalizeText('  뷰티\t\t루틴\n\n추천　영상  ')).toBe('뷰티 루틴 추천 영상');
  });

  it('removes zero-width characters that break substring matching', () => {
    expect(normalizeText(`스킨${ZWSP}케어${BOM}`)).toBe('스킨케어');
    expect(normalizeText(`make${SHY}up`)).toBe('makeup');
  });

  it('keeps Hangul, Kana and Kanji intact', () => {
    expect(normalizeText('初音ミク 歌ってみた 한국어')).toBe('初音ミク 歌ってみた 한국어');
  });

  it('returns an empty string for empty input', () => {
    expect(normalizeText('')).toBe('');
    expect(normalizeText('   ')).toBe('');
  });
});

describe('extractHashtags', () => {
  it('extracts Korean, Latin and Japanese hashtags, normalized and de-duplicated in order', () => {
    expect(extractHashtags('#스킨케어 #Skincare #스킨케어 #SKINCARE')).toEqual(['스킨케어', 'skincare']);
    expect(extractHashtags('新曲 #歌ってみた #初音ミク #ボカロ')).toEqual(['歌ってみた', '初音ミク', 'ボカロ']);
  });

  it('handles full-width hash signs and full-width letters', () => {
    expect(extractHashtags('＃タグ ＃ＡＢＣ')).toEqual(['タグ', 'abc']);
  });

  it('stops at punctuation and whitespace', () => {
    expect(extractHashtags('#뷰티,#메이크업! (#ootd) #데일리룩.')).toEqual(['뷰티', '메이크업', 'ootd', '데일리룩']);
  });

  it('supports digits, underscores, mixed scripts and the Japanese long vowel mark', () => {
    expect(extractHashtags('#BTS방탄 #k_pop_ #2024년 #ラーメン #ootd_2')).toEqual(['bts방탄', 'k_pop', '2024년', 'ラーメン', 'ootd_2']);
  });

  it('ignores URL fragments, glued words and HTML entities', () => {
    expect(extractHashtags('https://example.com/page#section')).toEqual([]);
    expect(extractHashtags('abc#tag')).toEqual([]);
    expect(extractHashtags('it&#39;s')).toEqual([]);
  });

  it('ignores pure numbers (rankings, years) and empty tags', () => {
    expect(extractHashtags('#1 #2024 # #_ #ー')).toEqual([]);
  });

  it('accepts a doubled hash', () => {
    expect(extractHashtags('##tag')).toEqual(['tag']);
  });

  it('returns [] fast when there is no hash sign', () => {
    expect(extractHashtags('no tags here')).toEqual([]);
    expect(extractHashtags('')).toEqual([]);
  });
});

describe('textMatches', () => {
  it('is case- and width-insensitive', () => {
    expect(textMatches('NewJeans Official MV', 'newjeans')).toBe(true);
    expect(textMatches('ＮＥＷＪＥＡＮＳ', 'NewJeans')).toBe(true);
    expect(textMatches('ｶﾌｪ巡り', 'カフェ')).toBe(true);
  });

  it('matches Korean/Japanese substrings', () => {
    expect(textMatches('데일리 스킨케어 루틴', '스킨케어')).toBe(true);
    expect(textMatches('初音ミク 新曲', '初音')).toBe(true);
    expect(textMatches('데일리 메이크업', '스킨케어')).toBe(false);
  });

  it('normalizes whitespace in both sides', () => {
    expect(textMatches('나   혼자\n산다', '나 혼자 산다')).toBe(true);
  });

  it('treats an empty needle as a match and an empty haystack as no match', () => {
    expect(textMatches('anything', '')).toBe(true);
    expect(textMatches('', 'x')).toBe(false);
  });
});

describe('textMatchesAll', () => {
  it('requires every term (AND)', () => {
    expect(textMatchesAll('데일리 뷰티 모닝 루틴', '뷰티 루틴')).toBe(true);
    expect(textMatchesAll('데일리 뷰티 모닝 루틴', '뷰티 먹방')).toBe(false);
    expect(textMatchesAll('x', '  ')).toBe(true);
  });
});

describe('helpers', () => {
  it('compactText removes spaces after normalization', () => {
    expect(compactText(' 유료 광고  포함 ')).toBe('유료광고포함');
  });

  it('isLatinWordChar recognizes Latin letters and digits only', () => {
    expect(isLatinWordChar('a')).toBe(true);
    expect(isLatinWordChar('Z')).toBe(true);
    expect(isLatinWordChar('7')).toBe(true);
    expect(isLatinWordChar('é')).toBe(true);
    expect(isLatinWordChar('한')).toBe(false);
    expect(isLatinWordChar('ミ')).toBe(false);
    expect(isLatinWordChar(' ')).toBe(false);
    expect(isLatinWordChar('-')).toBe(false);
    expect(isLatinWordChar(undefined)).toBe(false);
  });

  it('isAsciiKeyword', () => {
    expect(isAsciiKeyword('how to')).toBe(true);
    expect(isAsciiKeyword('k뷰티')).toBe(false);
  });
});
