/**
 * Topic filter with autocomplete over the dataset's topics (tens of thousands of keys): only the best
 * matches are rendered, typing is deferred so the input stays responsive.
 */
import { useDeferredValue, useId, useMemo, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Hash, X } from 'lucide-react';
import { Popover } from '../../components/index.ts';
import { cx } from '../../lib/cx.ts';
import { matchTopics } from './model.ts';
import type { TopicEntry } from './model.ts';

const MAX_SUGGESTIONS = 50;

export interface TopicPickerProps {
  topics: readonly TopicEntry[];
  value: string[];
  onChange: (next: string[]) => void;
}

export function topicSummary(value: string[]): string {
  if (!value.length) return '전체';
  return value.length === 1 ? `#${value[0]}` : `#${value[0]} 외 ${value.length - 1}`;
}

export function TopicPicker({ topics, value, onChange }: TopicPickerProps) {
  return (
    <Popover
      label="주제 선택"
      active={value.length > 0}
      width={320}
      buttonContent={
        <>
          <Hash className="size-4 shrink-0 text-fg-3" aria-hidden />
          <span className="text-fg-3">주제</span>
          <span className="max-w-40 truncate font-medium">{topicSummary(value)}</span>
        </>
      }
    >
      {() => <TopicPanel topics={topics} value={value} onChange={onChange} />}
    </Popover>
  );
}

function TopicPanel({ topics, value, onChange }: TopicPickerProps) {
  const [text, setText] = useState('');
  const deferred = useDeferredValue(text);
  const inputId = useId();
  const listId = useId();
  const counts = useMemo(() => new Map(topics.map((t) => [t.topic, t.count])), [topics]);
  const suggestions = useMemo(() => matchTopics(topics, deferred, value, MAX_SUGGESTIONS), [topics, deferred, value]);
  const add = (t: string) => {
    if (!value.includes(t)) onChange([...value, t]);
    setText('');
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && suggestions.length) {
      e.preventDefault();
      add(suggestions[0].topic);
    }
  };
  return (
    <div className="flex flex-col">
      <div className="sticky top-0 z-10 flex flex-col gap-2 border-b border-line bg-surface p-2">
        <label htmlFor={inputId} className="sr-only">
          주제 검색
        </label>
        <input
          id={inputId}
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          placeholder="주제 검색 (예: 뉴스, ゲーム)"
          aria-controls={listId}
          autoComplete="off"
          className="focus-ring h-8 w-full rounded-md border border-line bg-surface px-2.5 text-sm text-fg placeholder:text-fg-3"
        />
        {value.length ? (
          <div className="flex flex-wrap items-center gap-1">
            {value.map((t) => (
              <span key={t} className="inline-flex max-w-full items-center gap-1 rounded-md border border-accent bg-accent-soft px-1.5 py-px text-xs text-accent-text">
                <span className="truncate">#{t}</span>
                {counts.has(t) ? null : <span className="text-fg-3">(데이터에 없음)</span>}
                <button
                  type="button"
                  aria-label={`${t} 제거`}
                  onClick={() => onChange(value.filter((x) => x !== t))}
                  className="focus-ring inline-flex size-4 items-center justify-center rounded-sm hover:text-fg"
                >
                  <X className="size-3" aria-hidden />
                </button>
              </span>
            ))}
            <button type="button" onClick={() => onChange([])} className="focus-ring ml-auto rounded-sm text-xs text-accent-text hover:underline">
              선택 해제
            </button>
          </div>
        ) : null}
      </div>
      {suggestions.length ? (
        <ul id={listId} aria-label="주제 후보" className={cx('p-1', deferred !== text && 'opacity-60')}>
          {suggestions.map((t) => (
            <li key={t.topic}>
              <button
                type="button"
                onClick={() => add(t.topic)}
                className="focus-ring flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface-2"
              >
                <Hash className="size-3.5 shrink-0 text-fg-3" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{t.topic}</span>
                <span className="shrink-0 text-xs text-fg-3 tabular">{t.count.toLocaleString('ko-KR')}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="p-4 text-center text-sm text-fg-3">{topics.length ? '일치하는 주제 없음' : '데이터에 주제가 없음'}</p>
      )}
      <p className="border-t border-line px-3 py-2 text-[11px] text-fg-3">
        주제 {topics.length.toLocaleString('ko-KR')}개 중 {deferred.trim() ? '일치하는 상위' : '영상 수 상위'} {suggestions.length}개 표시. 여러 개 고르면 하나라도
        포함한 영상.
      </p>
    </div>
  );
}
