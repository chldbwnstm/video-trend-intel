import { describe, expect, it } from 'vitest';
import { presetRange } from '@vti/core';
import {
  ageCodec,
  applyParamPatch,
  boolCodec,
  dateModeCodec,
  enumCodec,
  enumListCodec,
  formatLocalRange,
  formatRangeSpec,
  hrefWith,
  inferCodec,
  intCodec,
  isIsoDate,
  isRangePreset,
  listCodec,
  nextSearchFor,
  numberCodec,
  parseRangeSpec,
  platformListCodec,
  readParam,
  resolveRangeSpec,
  searchFromHash,
  serializeParam,
  sortCodec,
  splitList,
  stringCodec,
  toSearchString,
  valuesEqual,
  historyModeFor,
  historyStep,
  SELECTION_STATE,
  shareableHref,
  tzParamFor,
} from './urlState.ts';

describe('codecs', () => {
  it('string codec omits empty strings', () => {
    expect(stringCodec.parse('abc')).toBe('abc');
    expect(stringCodec.serialize('')).toBeNull();
  });
  it('number / int codecs reject garbage', () => {
    expect(numberCodec.parse('1.5')).toBe(1.5);
    expect(numberCodec.parse('abc')).toBeUndefined();
    expect(numberCodec.parse('')).toBeUndefined();
    expect(intCodec.parse('42')).toBe(42);
    expect(intCodec.parse('4.2')).toBeUndefined();
    expect(intCodec.parse('1e3')).toBeUndefined();
    expect(intCodec.serialize(3.9)).toBe('3');
  });
  it('bool codec', () => {
    expect(boolCodec.parse('1')).toBe(true);
    expect(boolCodec.parse('false')).toBe(false);
    expect(boolCodec.parse('yes')).toBeUndefined();
    expect(boolCodec.serialize(true)).toBe('1');
  });
  it('list codec trims, drops empties and de-duplicates', () => {
    expect(splitList(' a, b,,a ,c ')).toEqual(['a', 'b', 'c']);
    expect(listCodec.parse('x,y')).toEqual(['x', 'y']);
    expect(listCodec.serialize([])).toBeNull();
    expect(listCodec.serialize(['추석', '송편'])).toBe('추석,송편');
  });
  it('enum codecs accept only allowed values', () => {
    const c = enumCodec(['a', 'b'] as const);
    expect(c.parse('a')).toBe('a');
    expect(c.parse('z')).toBeUndefined();
    expect(dateModeCodec.parse('activity')).toBe('activity');
    expect(dateModeCodec.parse('views')).toBeUndefined();
    expect(sortCodec.parse('views_period')).toBe('views_period');
    expect(sortCodec.parse('drop table')).toBeUndefined();
    expect(enumListCodec(['x', 'y'] as const).parse('x,q,y')).toEqual(['x', 'y']);
    expect(platformListCodec.parse('youtube,myspace,tiktok')).toEqual(['youtube', 'tiktok']);
  });
  it('age codec accepts only AGE_DAYS', () => {
    expect(ageCodec.parse('7')).toBe(7);
    expect(ageCodec.parse('5')).toBeUndefined();
    expect(ageCodec.parse('30')).toBe(30);
  });
  it('inferCodec picks by default type', () => {
    expect(inferCodec(1).parse('2')).toBe(2);
    expect(inferCodec(false).parse('1')).toBe(true);
    expect(inferCodec<string[]>([]).parse('a,b')).toEqual(['a', 'b']);
    expect(inferCodec('x').parse('y')).toBe('y');
  });
});

describe('readParam / serializeParam', () => {
  it('falls back to the default for missing or invalid values', () => {
    const p = new URLSearchParams('mode=bogus&page=3');
    expect(readParam(p, 'mode', 'activity', dateModeCodec)).toBe('activity');
    expect(readParam(p, 'page', 1)).toBe(3);
    expect(readParam(p, 'missing', 'x')).toBe('x');
  });
  it('omits values equal to the default', () => {
    expect(serializeParam('activity', 'activity', dateModeCodec)).toBeNull();
    expect(serializeParam('upload', 'activity', dateModeCodec)).toBe('upload');
    expect(serializeParam<string[]>([], [])).toBeNull();
    expect(serializeParam(['a'], [])).toBe('a');
  });
  it('valuesEqual compares arrays by content', () => {
    expect(valuesEqual(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(valuesEqual(['a'], ['b'])).toBe(false);
    expect(valuesEqual(1, 1)).toBe(true);
    expect(valuesEqual(Number.NaN, Number.NaN)).toBe(true);
  });
});

describe('applyParamPatch / hrefWith', () => {
  it('sets, replaces and deletes keys while keeping order', () => {
    expect(applyParamPatch('?a=1&b=2', { b: '3', c: 'x' })).toBe('?a=1&b=3&c=x');
    expect(applyParamPatch('?a=1&b=2', { a: null })).toBe('?b=2');
    expect(applyParamPatch('a=1', { a: undefined })).toBe('');
    expect(applyParamPatch('', { list: ['x', 'y'], empty: [], flag: true, off: false, n: 0, s: '' })).toBe('?list=x,y&flag=1&off=0&n=0');
    expect(applyParamPatch('', { n: Number.NaN })).toBe('');
  });
  it('keeps commas readable and round-trips through URLSearchParams', () => {
    const search = applyParamPatch('', { platforms: ['youtube', 'tiktok'], q: 'a,b & c' });
    expect(search).toBe('?platforms=youtube,tiktok&q=a,b+%26+c');
    const back = new URLSearchParams(search);
    expect(back.get('platforms')).toBe('youtube,tiktok');
    expect(back.get('q')).toBe('a,b & c');
    expect(toSearchString(new URLSearchParams())).toBe('');
  });
  it('builds router hrefs with encoded Korean values', () => {
    const href = hrefWith('/videos', { mode: 'activity', topics: ['추석'] });
    expect(href.startsWith('/videos?mode=activity&topics=')).toBe(true);
    expect(new URLSearchParams(href.split('?')[1]).get('topics')).toBe('추석');
    expect(hrefWith('/coverage')).toBe('/coverage');
    expect(hrefWith('/x', { a: undefined })).toBe('/x');
  });
});

describe('range specs', () => {
  it('validates ISO dates strictly', () => {
    expect(isIsoDate('2026-09-28')).toBe(true);
    expect(isIsoDate('2026-02-29')).toBe(false);
    expect(isIsoDate('2028-02-29')).toBe(true);
    expect(isIsoDate('2026-13-01')).toBe(false);
    expect(isIsoDate('2026-9-1')).toBe(false);
    expect(isIsoDate('')).toBe(false);
  });
  it('parses presets and custom ranges', () => {
    expect(isRangePreset('last7d')).toBe(true);
    expect(isRangePreset('last8d')).toBe(false);
    expect(parseRangeSpec('last30d')).toEqual({ kind: 'preset', preset: 'last30d' });
    expect(parseRangeSpec('2026-09-01..2026-09-28')).toEqual({ kind: 'custom', range: { start: '2026-09-01', end: '2026-09-28' } });
    expect(parseRangeSpec('2026-09-28..2026-09-01')).toBeNull();
    expect(parseRangeSpec('2026-09-01..2026-09-31')).toBeNull();
    expect(parseRangeSpec('2026-09-01')).toBeNull();
    expect(parseRangeSpec('a..b..c')).toBeNull();
    expect(parseRangeSpec(null)).toBeNull();
  });
  it('formats specs and ranges', () => {
    expect(formatRangeSpec('last7d')).toBe('last7d');
    expect(formatRangeSpec({ start: '2026-09-01', end: '2026-09-02' })).toBe('2026-09-01..2026-09-02');
    expect(formatLocalRange({ start: '2026-09-01', end: '2026-09-02' })).toBe('2026-09-01 ~ 2026-09-02');
    expect(formatLocalRange({ start: '2026-09-01', end: '2026-09-01' })).toBe('2026-09-01');
  });
  it('resolves custom ranges without touching the clock', () => {
    const r = resolveRangeSpec('2026-09-01..2026-09-07', 'Asia/Seoul', 0);
    expect(r).toEqual({ spec: '2026-09-01..2026-09-07', preset: null, range: { start: '2026-09-01', end: '2026-09-07' }, rollingHours: null });
  });
  it('resolves rolling presets to rollingHours', () => {
    const now = Date.UTC(2026, 8, 28, 3);
    expect(resolveRangeSpec('rolling24h', 'Asia/Seoul', now).rollingHours).toBe(24);
    expect(resolveRangeSpec('rolling7d', 'Asia/Seoul', now).rollingHours).toBe(168);
    expect(resolveRangeSpec('last7d', 'Asia/Seoul', now).rollingHours).toBeNull();
  });
  it('resolves presets through core presetRange and falls back on invalid specs', () => {
    const now = Date.UTC(2026, 8, 28, 3);
    const r = resolveRangeSpec('last7d', 'Asia/Seoul', now);
    expect(r.preset).toBe('last7d');
    expect(r.range).toEqual(presetRange('last7d', 'Asia/Seoul', now));
    const bad = resolveRangeSpec('garbage', 'Asia/Seoul', now, 'last30d');
    expect(bad.preset).toBe('last30d');
    expect(bad.spec).toBe('last30d');
  });
});

describe('nextSearchFor (useUrlState setter core)', () => {
  it('sets a value and keeps other keys', () => {
    expect(nextSearchFor('?range=last30d', 'mode', 'upload', 'activity', dateModeCodec)).toBe('?range=last30d&mode=upload');
  });
  it('removes the key when set back to the default', () => {
    expect(nextSearchFor('?mode=upload&q=x', 'mode', 'activity', 'activity', dateModeCodec)).toBe('?q=x');
    expect(nextSearchFor('?mode=upload', 'mode', 'activity', 'activity', dateModeCodec)).toBe('');
  });
  it('clears reset keys (page) but never the key being set', () => {
    expect(nextSearchFor('?page=4&q=a', 'q', 'b', '', stringCodec, ['page', 'q'])).toBe('?q=b');
  });
  it('writes lists with readable commas and removes empty lists', () => {
    expect(nextSearchFor('', 'platforms', ['youtube', 'tiktok'], [] as string[], platformListCodec as never)).toBe('?platforms=youtube,tiktok');
    expect(nextSearchFor('?platforms=youtube', 'platforms', [] as string[], [] as string[])).toBe('');
  });
  it('infers the codec from the default', () => {
    expect(nextSearchFor('', 'page', 3, 1)).toBe('?page=3');
    expect(nextSearchFor('', 'flag', true, false)).toBe('?flag=1');
  });
});

describe('searchFromHash', () => {
  it('splits HashRouter locations', () => {
    expect(searchFromHash('#/videos?mode=activity')).toEqual({ pathname: '/videos', search: '?mode=activity' });
    expect(searchFromHash('#/')).toEqual({ pathname: '/', search: '' });
    expect(searchFromHash('#/x?')).toEqual({ pathname: '/x', search: '' });
    expect(searchFromHash('')).toEqual({ pathname: '/', search: '' });
    expect(searchFromHash('#section')).toBeNull();
  });
});

describe('history modes (Back behaviour)', () => {
  it('pushes pages, treats drawers as selections and replaces filters by default', () => {
    expect(historyModeFor('page')).toBe('push');
    expect(historyModeFor('brand')).toBe('selection');
    expect(historyModeFor('node')).toBe('selection');
    expect(historyModeFor('q')).toBe('replace');
    expect(historyModeFor('platforms')).toBe('replace');
  });
  it('honours explicit options; replace:false keeps a selection key a selection', () => {
    expect(historyModeFor('q', { replace: false })).toBe('push');
    expect(historyModeFor('page', { replace: true })).toBe('replace');
    expect(historyModeFor('brand', { replace: false })).toBe('selection');
    expect(historyModeFor('v', { history: 'selection' })).toBe('selection');
    expect(historyModeFor('v')).toBe('replace');
  });

  it('open pushes a marked entry, switching replaces it, close goes back (no dead entry)', () => {
    const open = historyStep('selection', 'v', false, true, null, true);
    expect(open).toEqual({ kind: 'push', state: { [SELECTION_STATE]: 'v' } });
    const marked = (open as { state: unknown }).state;
    expect(historyStep('selection', 'v', true, true, marked, true)).toEqual({ kind: 'replace', state: { [SELECTION_STATE]: 'v' } });
    expect(historyStep('selection', 'v', true, false, marked, true)).toEqual({ kind: 'back' });
  });
  it('closes by replacing when the entry was not opened in this session (shared link, other page, other change)', () => {
    expect(historyStep('selection', 'v', true, false, null, true)).toEqual({ kind: 'replace', state: null });
    expect(historyStep('selection', 'v', true, false, { [SELECTION_STATE]: 'brand' }, true)).toEqual({ kind: 'replace', state: null });
    expect(historyStep('selection', 'v', true, false, { [SELECTION_STATE]: 'v' }, false)).toEqual({ kind: 'replace', state: null });
  });
  it('push / replace modes never go back', () => {
    expect(historyStep('push', 'page', true, false, { [SELECTION_STATE]: 'page' }, true)).toEqual({ kind: 'push', state: null });
    expect(historyStep('replace', 'q', true, false, { [SELECTION_STATE]: 'q' }, true)).toEqual({ kind: 'replace', state: null });
  });
});

describe('time zone in the URL', () => {
  it('omits tz only when it is both the default and the stored preference', () => {
    expect(tzParamFor('Asia/Seoul', 'Asia/Seoul', 'Asia/Seoul')).toBeNull();
    expect(tzParamFor('Australia/Sydney', 'Australia/Sydney', 'Asia/Seoul')).toBe('Australia/Sydney');
    // A shared link opened by a viewer who stores Sydney: keep the explicit default so a reload stays in Seoul.
    expect(tzParamFor('Asia/Seoul', 'Australia/Sydney', 'Asia/Seoul')).toBe('Asia/Seoul');
  });
  it('shareableHref always names the zone and keeps the rest of the view', () => {
    expect(shareableHref('http://x/#/videos?platforms=youtube&range=last7d', 'Australia/Sydney')).toBe(
      'http://x/#/videos?platforms=youtube&range=last7d&tz=Australia%2FSydney',
    );
    expect(shareableHref('http://x/#/videos?tz=UTC&range=yesterday', 'Asia/Seoul')).toBe('http://x/#/videos?tz=Asia%2FSeoul&range=yesterday');
    expect(shareableHref('http://x/#/', 'Asia/Seoul')).toBe('http://x/#/?tz=Asia%2FSeoul');
    expect(shareableHref('http://x/', 'Asia/Seoul')).toBe('http://x/');
  });
});
