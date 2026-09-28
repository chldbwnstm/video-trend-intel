/**
 * Platform presentation: labels come from @vti/core; colors are brand-neutral categorical slots bound to
 * the platform (color follows the entity, never its rank). Always pair the color with the text label.
 */
import type { Platform } from '@vti/core';
import { PLATFORM_LABELS, PLATFORMS } from '@vti/core';

/** CSS color (a theme variable) for a platform. */
export function platformColor(p: Platform): string {
  return `var(--platform-${p})`;
}

export function platformLabel(p: Platform | string): string {
  return (PLATFORM_LABELS as Record<string, string>)[p] ?? p;
}

/** Short 1–2 letter mark used in thumbnails fallbacks. */
export const PLATFORM_MARK: Record<Platform, string> = {
  youtube: 'YT',
  dailymotion: 'DM',
  peertube: 'PT',
  niconico: 'NC',
  tiktok: 'TT',
  instagram: 'IG',
  x: 'X',
  twitch: 'TW',
};

export function isPlatform(s: string): s is Platform {
  return (PLATFORMS as readonly string[]).includes(s);
}

/** Platforms in canonical order, filtered to the ones present in `present` (keeps color/legend order stable). */
export function orderPlatforms(present: Iterable<Platform>): Platform[] {
  const set = new Set(present);
  return PLATFORMS.filter((p) => set.has(p));
}

/**
 * View-unit caveat shown whenever several platforms are mixed in one ranking (SPEC principle 5). It states
 * the problem only: append the advice that the page can actually act on (CROSS_PLATFORM_ADVICE), never a
 * percentile sort the page does not offer.
 */
export const CROSS_PLATFORM_CAVEAT =
  '플랫폼마다 조회수 집계 단위가 달라(예: X 조회 ≠ 영상 재생, YouTube Shorts 집계 변경 2025-03) 서로 다른 플랫폼 수치를 같은 단위로 비교하기 어려움.';

/** Page-specific next step after CROSS_PLATFORM_CAVEAT. */
export const CROSS_PLATFORM_ADVICE = {
  /** Pages with an in-platform percentile sort (영상 탐색, 대시보드 상위 영상, 비디오 레이팅). */
  percentile: '플랫폼별로 보거나 플랫폼 내 백분위로 정렬 권장.',
  /** Pages with a platform filter / chips only (크리에이터, 비교, 브랜드, 트렌드...). */
  filter: '플랫폼 필터로 한 플랫폼만 고르면 같은 단위끼리 비교됨.',
} as const;
