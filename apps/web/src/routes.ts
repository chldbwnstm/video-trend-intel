/**
 * Navigation + route metadata (SPEC "Product surface"). The router itself is in App.tsx.
 */
import {
  Braces,
  Compass,
  Database,
  FolderTree,
  GitCompareArrows,
  Handshake,
  Hash,
  LayoutDashboard,
  Search,
  Star,
  TrendingUp,
  Trophy,
  Users,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export interface NavItem {
  path: string;
  label: string;
  icon: LucideIcon;
  /** One-line Korean description (used in placeholders and page headers). */
  description: string;
  /** Tubular equivalent (eyebrow text). */
  tubular: string;
  /** Match only the exact path (dashboard). */
  end?: boolean;
}

export interface NavSection {
  id: string;
  label: string;
  items: NavItem[];
}

export const NAV_SECTIONS: NavSection[] = [
  {
    id: 'overview',
    label: '개요',
    items: [
      {
        path: '/',
        label: '대시보드',
        icon: LayoutDashboard,
        description: '핵심 지표, 기간 상위 영상, 뜨는 주제, 플랫폼·분야 분포, 데이터 신선도',
        tubular: 'Viewpoint 홈',
        end: true,
      },
      {
        path: '/watchlist',
        label: '관심 목록',
        icon: Star,
        description: '고정한 크리에이터·영상·키워드의 기간 지표, 고정 이후 증가, 지난 방문 이후 새 업로드 (이 브라우저에만 저장)',
        tubular: 'Viewpoint (내 채널·경쟁 채널)',
      },
    ],
  },
  {
    id: 'discover',
    label: '탐색',
    items: [
      {
        path: '/videos',
        label: '영상 탐색',
        icon: Search,
        description: '세 가지 날짜 기준으로 영상 검색·필터·정렬, CSV 내보내기, 성장 곡선과 원본 관측값',
        tubular: 'Video Intelligence',
      },
      {
        path: '/keywords',
        label: '키워드 분석',
        icon: Hash,
        description: '키워드별 관련 영상의 기간 조회·업로드 추이, 플랫폼·크리에이터 분포',
        tubular: 'Keyword Intelligence',
      },
      {
        path: '/trends',
        label: '트렌드',
        icon: TrendingUp,
        description: '이전 기간 대비 상승·하락하는 주제, 분야, 크리에이터, 계정',
        tubular: 'Trending',
      },
      {
        path: '/ratings',
        label: '비디오 레이팅',
        icon: Trophy,
        description: '게시 후 1·2·3·7·30일 같은 나이 비교 순위와 백분위',
        tubular: 'Video Ratings (V1~V30)',
      },
      {
        path: '/explore',
        label: '기회 탐색',
        icon: Compass,
        description: '영상당 조회(수요)는 높고 업로드(공급)는 적은 주제',
        tubular: 'Viewpoint Explore',
      },
    ],
  },
  {
    id: 'creators',
    label: '크리에이터',
    items: [
      {
        path: '/creators',
        label: '크리에이터',
        icon: Users,
        description: '여러 플랫폼 계정을 묶은 포트폴리오, 성장, 상위 영상, 게시 시간 히트맵',
        tubular: 'Creator Intelligence',
      },
      {
        path: '/compare',
        label: '크리에이터 비교',
        icon: GitCompareArrows,
        description: '최대 4명의 크리에이터를 같은 기간·지표로 비교',
        tubular: 'Creator Comparison',
      },
      {
        path: '/brands',
        label: '브랜드 협업',
        icon: Handshake,
        description: '광고 표기·협찬 추정 영상과 브랜드 × 크리에이터 협업',
        tubular: 'DealMaker (lite)',
      },
    ],
  },
  {
    id: 'data',
    label: '데이터',
    items: [
      {
        path: '/taxonomy',
        label: '분류 체계',
        icon: FolderTree,
        description: '계층형 분야와 주제, 영상 수, 분류 근거',
        tubular: 'ContentGraph',
      },
      {
        path: '/coverage',
        label: '데이터 범위',
        icon: Database,
        description: '원천별 수집 방식·범위·신선도, 지표 정의, 수집 실행 기록과 오류',
        tubular: '신뢰 계층 (차별점)',
      },
      {
        path: '/api-docs',
        label: 'API',
        icon: Braces,
        description: 'apps/server가 제공하는 REST 엔드포인트',
        tubular: 'Tubular API',
      },
    ],
  },
];

export const NAV_ITEMS: NavItem[] = NAV_SECTIONS.flatMap((s) => s.items);

/** The nav item for a router pathname (longest prefix match; `/creators/abc` -> 크리에이터). */
export function navItemFor(pathname: string): NavItem | null {
  let best: NavItem | null = null;
  for (const item of NAV_ITEMS) {
    const match = item.end ? pathname === item.path : pathname === item.path || pathname.startsWith(`${item.path}/`);
    if (match && (!best || item.path.length > best.path.length)) best = item;
  }
  return best;
}

export function navItemByPath(path: string): NavItem {
  const item = NAV_ITEMS.find((i) => i.path === path);
  if (!item) throw new Error(`unknown nav path ${path}`);
  return item;
}

export const APP_NAME = '영상 트렌드 인텔리전스';
