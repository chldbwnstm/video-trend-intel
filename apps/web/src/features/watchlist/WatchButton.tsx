/**
 * Pin / unpin toggle for the watchlist (관심 목록), shared by the video drawer, the creator page and the keyword
 * page: `<WatchButton kind="video" id={video.id} />`, `<WatchButton kind="creator" id={key} />`,
 * `<WatchButton kind="keyword" id={kw} />`. A video pin stores the latest views observation known at the data
 * time so the watchlist can show the growth since the pin. The list lives in this browser only.
 */
import { useState } from 'react';
import { Star } from 'lucide-react';
import { cx } from '../../lib/cx.ts';
import { useOptionalDataset } from '../../data/hooks.ts';
import { ADD_OUTCOME_MESSAGES, addPin, isPinned, removePin } from './model.ts';
import type { PinnedCreator, PinnedKeyword, PinnedVideo, WatchKind } from './model.ts';
import { creatorPinFor, keywordPinFor, videoPinFor } from './analysis.ts';
import { getWatchlist, updateWatchlist, useWatchlist } from './store.ts';

export interface WatchButtonProps {
  kind: WatchKind;
  /** Video id, creator/account key, or keyword text. */
  id: string;
  /** Icon only (still labelled for screen readers). */
  iconOnly?: boolean;
  size?: 'sm' | 'md';
  className?: string;
}

/** Object form with the right particle: 이 영상을 / 이 크리에이터를 / 이 키워드를. */
const OBJECT_LABELS: Record<WatchKind, string> = { creator: '이 크리에이터를', video: '이 영상을', keyword: '이 키워드를' };
const SUBJECT_LABELS: Record<WatchKind, string> = { creator: '이 크리에이터', video: '이 영상', keyword: '이 키워드' };

type PinItem = { kind: 'creator'; value: PinnedCreator } | { kind: 'video'; value: PinnedVideo } | { kind: 'keyword'; value: PinnedKeyword };

export function WatchButton({ kind, id, iconOnly = false, size = 'sm', className }: WatchButtonProps) {
  const ds = useOptionalDataset();
  const { list } = useWatchlist();
  const [notice, setNotice] = useState<string | null>(null);
  const pinned = id ? isPinned(list, kind, id) : false;

  const buildItem = (at: number): PinItem | null => {
    if (kind === 'keyword') {
      const value = keywordPinFor(id, ds?.now ?? null, at);
      return value ? { kind, value } : null;
    }
    if (!ds) return null;
    return kind === 'video' ? { kind, value: videoPinFor(ds.index, id, ds.now, at) } : { kind, value: creatorPinFor(ds.index, id, ds.now, at) };
  };

  const toggle = () => {
    if (!id) return;
    const at = Date.now();
    if (pinned) {
      updateWatchlist((l) => removePin(l, kind, id, at));
      setNotice(null);
      return;
    }
    const item = buildItem(at);
    if (!item) {
      setNotice(ADD_OUTCOME_MESSAGES.invalid);
      return;
    }
    const r = addPin(getWatchlist().list, item, at);
    if (r.outcome === 'added') updateWatchlist(() => r.list);
    setNotice(r.outcome === 'added' || r.outcome === 'exists' ? null : ADD_OUTCOME_MESSAGES[r.outcome]);
  };

  const label = pinned ? `관심 목록에서 ${SUBJECT_LABELS[kind]} 빼기` : `${OBJECT_LABELS[kind]} 관심 목록에 추가`;
  return (
    <span className={cx('inline-flex min-w-0 flex-wrap items-center gap-1.5', className)}>
      <button
        type="button"
        onClick={toggle}
        aria-pressed={pinned}
        aria-label={iconOnly ? label : undefined}
        title={pinned ? '관심 목록에 있음 · 누르면 뺌 (이 브라우저에만 저장)' : '관심 목록에 추가 (이 브라우저에만 저장)'}
        disabled={!id}
        className={cx(
          'focus-ring inline-flex shrink-0 items-center justify-center rounded-md border font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50',
          size === 'sm' ? 'h-8 gap-1.5 text-[13px]' : 'h-9 gap-2 text-sm',
          iconOnly ? (size === 'sm' ? 'w-8' : 'w-9') : size === 'sm' ? 'px-2.5' : 'px-3.5',
          pinned ? 'border-accent bg-accent-soft text-accent-text hover:brightness-95' : 'border-line bg-surface text-fg hover:bg-surface-3',
        )}
      >
        <Star className="size-4" aria-hidden fill={pinned ? 'currentColor' : 'none'} />
        {iconOnly ? null : <span>{pinned ? '관심 목록에 있음' : '관심 목록에 추가'}</span>}
      </button>
      {notice ? (
        <span role="status" className="text-xs text-warning">
          {notice}
        </span>
      ) : null}
    </span>
  );
}
