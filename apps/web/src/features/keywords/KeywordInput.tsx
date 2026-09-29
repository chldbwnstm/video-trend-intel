/**
 * Keyword chips input (up to MAX_KEYWORDS) with suggestions: the search terms / tags the collector found videos
 * with (discoveredVia) and popular topics of the dataset. Enter or comma adds, Backspace on an empty input
 * removes the last chip. Suggestions filter as you type.
 */
import { useId, useState } from 'react';
import type { KeywordSuggestion } from '@vti/core';
import { Hash, Plus, Search } from 'lucide-react';
import { Button, Chip } from '../../components/index.ts';
import { cx } from '../../lib/cx.ts';
import { formatInteger } from '../../lib/format.ts';
import { filterSuggestions, keywordColor, MAX_KEYWORDS, mergeKeywords } from './model.ts';

export interface KeywordInputProps {
  value: string[];
  onChange: (next: string[]) => void;
  suggestions: { discovery: KeywordSuggestion[]; topics: KeywordSuggestion[] } | undefined;
}

export function suggestionTitle(s: KeywordSuggestion): string {
  return s.source === 'discovery'
    ? `수집기가 영상을 찾은 검색어·태그 (${s.via ?? '검색'}) · 추적 영상 ${formatInteger(s.videos)}개`
    : `인기 주제 · 추적 영상 ${formatInteger(s.videos)}개 · 계정 ${formatInteger(s.accounts)}개`;
}

export function KeywordInput({ value, onChange, suggestions }: KeywordInputProps) {
  const [text, setText] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const inputId = useId();
  const hintId = useId();
  const full = value.length >= MAX_KEYWORDS;

  const add = (input: string | string[]) => {
    const { next, overflow, added } = mergeKeywords(value, input);
    if (added > 0) onChange(next);
    setMessage(overflow > 0 ? `키워드는 최대 ${MAX_KEYWORDS}개까지 비교할 수 있음` : added === 0 && String(input).trim() ? '이미 추가된 키워드' : null);
    setText('');
  };
  const remove = (k: string) => {
    onChange(value.filter((x) => x !== k));
    setMessage(null);
  };
  // With no keyword yet the page shows the full suggestion lists below; here only while typing then.
  const shown = !value.length && !text.trim() ? [] : filterSuggestions(suggestions, text, value, 12);

  return (
    <div className="flex w-full min-w-0 flex-col gap-2">
      <label htmlFor={inputId} className="text-[13px] font-medium text-fg-2">
        비교할 키워드 <span className="font-normal text-fg-3">(최대 {MAX_KEYWORDS}개)</span>
      </label>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 rounded-md border border-line bg-surface px-2 py-1.5 focus-within:border-accent">
        {value.map((k, i) => (
          <Chip
            key={k}
            onRemove={() => remove(k)}
            removeLabel={`'${k}' 키워드 빼기`}
            icon={<span className="inline-block size-2 rounded-full" style={{ background: keywordColor(i) }} />}
            className="max-w-[14rem]"
          >
            {k}
          </Chip>
        ))}
        <input
          id={inputId}
          type="text"
          value={text}
          disabled={full}
          aria-describedby={hintId}
          placeholder={full ? `최대 ${MAX_KEYWORDS}개` : value.length ? '키워드 추가' : '예: 먹방, 브이로그, ai'}
          onChange={(e) => {
            const v = e.target.value;
            if (/[,，]/.test(v)) add(v);
            else setText(v);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (text.trim()) add(text);
            } else if (e.key === 'Backspace' && !text && value.length) {
              remove(value[value.length - 1]);
            }
          }}
          maxLength={100}
          className="h-7 min-w-[8rem] flex-1 bg-transparent px-1 text-sm text-fg outline-none placeholder:text-fg-3 disabled:cursor-not-allowed"
        />
        <Button size="sm" variant="ghost" icon={<Plus className="size-4" aria-hidden />} onClick={() => add(text)} disabled={full || !text.trim()}>
          추가
        </Button>
      </div>
      <p id={hintId} className={cx('text-xs', message ? 'text-warning' : 'text-fg-3')} aria-live="polite">
        {message ?? 'Enter나 쉼표로 추가. 한글·일본어는 부분 일치, 짧은 영문(4자 이하)은 단어 단위로 찾음.'}
      </p>
      {shown.length && !full ? (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5" aria-label="추천 키워드">
          <span className="text-xs text-fg-3">{text.trim() ? '일치하는 추천' : '추천'}</span>
          {shown.map((s, i) => (
            <Chip
              key={`${s.source}:${s.keyword}`}
              onClick={() => add([s.keyword])}
              title={suggestionTitle(s)}
              icon={s.source === 'discovery' ? <Search className="size-3" /> : <Hash className="size-3" />}
              className={cx('max-w-[12rem]', i >= 6 && 'max-sm:hidden')}
            >
              {s.keyword}
            </Chip>
          ))}
          <span className="text-[11px] text-fg-3">
            <Search className="mr-0.5 inline size-3 align-[-2px]" aria-hidden />
            수집 검색어·태그 · <Hash className="mx-0.5 inline size-3 align-[-2px]" aria-hidden />
            인기 주제
          </span>
        </div>
      ) : null}
    </div>
  );
}
