/**
 * VideoThumb: lazy thumbnail (no referrer) with a platform-colored fallback.
 * VideoTitleLink: title that opens the source page in a new tab (rel noopener noreferrer).
 * Only http(s) URLs are ever used as href/src; anything else renders as plain text / fallback.
 */
import { useState } from 'react';
import type { ReactNode } from 'react';
import type { Video } from '@vti/core';
import { ExternalLink, Film } from 'lucide-react';
import { cx } from '../lib/cx.ts';
import { formatDuration } from '../lib/format.ts';
import { PLATFORM_MARK, platformColor } from '../lib/platform.ts';
import { PlatformBadge } from './PlatformBadge.tsx';

/** Returns the URL if it is an absolute http(s) URL, else null. */
export function safeHttpUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

const THUMB_SIZES = {
  xs: 'w-16',
  sm: 'w-24',
  md: 'w-40',
  lg: 'w-full',
} as const;

export interface VideoThumbProps {
  video: Pick<Video, 'thumbnail' | 'platform' | 'durationSec' | 'format'>;
  size?: keyof typeof THUMB_SIZES;
  className?: string;
  /** Show duration / format overlays (default true for md/lg). */
  overlays?: boolean;
}

export function VideoThumb({ video, size = 'sm', className, overlays }: VideoThumbProps) {
  const [failed, setFailed] = useState(false);
  const src = safeHttpUrl(video.thumbnail);
  const showOverlays = overlays ?? (size === 'md' || size === 'lg');
  const duration = video.durationSec !== null ? formatDuration(video.durationSec) : null;
  const formatLabel = video.format === 'short' ? '쇼츠' : video.format === 'live' ? '라이브' : null;
  return (
    <span className={cx('relative block aspect-video shrink-0 overflow-hidden rounded-md bg-surface-3', THUMB_SIZES[size], className)}>
      {src && !failed ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
          className="size-full object-cover"
        />
      ) : (
        <span
          aria-hidden
          className="flex size-full items-center justify-center gap-1 text-fg-3"
          style={{ background: `color-mix(in srgb, ${platformColor(video.platform)} 16%, var(--surface-3))` }}
        >
          <Film className={size === 'xs' ? 'size-3.5' : 'size-4'} />
          {size !== 'xs' ? <span className="text-[10px] font-semibold tracking-wide">{PLATFORM_MARK[video.platform]}</span> : null}
        </span>
      )}
      {showOverlays && duration && duration !== '—' ? (
        <span className="absolute right-1 bottom-1 rounded bg-black/75 px-1 text-[10px] leading-4 font-medium text-white tabular">{duration}</span>
      ) : null}
      {showOverlays && formatLabel ? (
        <span className="absolute top-1 left-1 rounded bg-black/75 px-1 text-[10px] leading-4 font-medium text-white">{formatLabel}</span>
      ) : null}
    </span>
  );
}

export interface VideoCellProps {
  video: Video;
  /** Account display name (falls back to the account id). */
  accountName?: string | null;
  /** Local date/time string for the publish time, e.g. fmtTime(v.publishedAt, tz, 'date'). */
  publishedLabel?: string;
  /** Full publish time for the title attribute. */
  publishedTitle?: string;
  thumb?: 'none' | 'xs' | 'sm' | 'md';
  /** Hide the thumbnail below the `sm` breakpoint (default true). */
  hideThumbOnMobile?: boolean;
  /** Extra content under the meta line (chips, badges). */
  children?: ReactNode;
}

/** Standard "video" table cell: thumbnail + title link + platform · account · publish date. */
export function VideoCell({ video, accountName, publishedLabel, publishedTitle, thumb = 'sm', hideThumbOnMobile = true, children }: VideoCellProps) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      {thumb !== 'none' ? <VideoThumb video={video} size={thumb} className={hideThumbOnMobile ? 'hidden sm:block' : undefined} /> : null}
      <div className="min-w-0">
        <VideoTitleLink video={video} />
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-fg-3">
          <PlatformBadge platform={video.platform} size="xs" />
          <span className="max-w-[12rem] truncate">{accountName ?? video.accountId}</span>
          {publishedLabel ? (
            <>
              <span aria-hidden>·</span>
              <span className="tabular" title={publishedTitle}>
                게시 {publishedLabel}
              </span>
            </>
          ) : null}
        </div>
        {children}
      </div>
    </div>
  );
}

export interface VideoTitleLinkProps {
  video: Pick<Video, 'url' | 'title' | 'status'>;
  /** Max lines before truncation (default 2). */
  lines?: 1 | 2 | 3;
  className?: string;
  /** Show a ↗ icon after the title (default false: it can wrap onto its own line in clamped titles). */
  icon?: boolean;
}

const STATUS_BADGE: Partial<Record<Video['status'], string>> = {
  deleted: '삭제됨',
  private: '비공개',
};

export function VideoTitleLink({ video, lines = 2, className, icon = false }: VideoTitleLinkProps) {
  const href = safeHttpUrl(video.url);
  const title = video.title || '(제목 없음)';
  const clamp = lines === 1 ? 'line-clamp-1' : lines === 3 ? 'line-clamp-3' : 'line-clamp-2';
  const badge = STATUS_BADGE[video.status];
  const badgeEl = badge ? (
    <span className="mr-1 inline-block rounded bg-negative-soft px-1 align-middle text-[11px] font-medium text-negative">{badge}</span>
  ) : null;
  if (!href) {
    return (
      <span className={cx('min-w-0 text-sm font-medium text-fg', clamp, className)} title={title}>
        {badgeEl}
        {title}
      </span>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
      className={cx('focus-ring group/link min-w-0 rounded-sm text-sm font-medium text-fg hover:text-accent-text hover:underline', clamp, className)}
    >
      {badgeEl}
      {title}
      {icon ? <ExternalLink className="ml-1 inline size-3 align-baseline text-fg-3" aria-hidden /> : null}
      <span className="sr-only"> (원본 새 탭에서 열기)</span>
    </a>
  );
}
