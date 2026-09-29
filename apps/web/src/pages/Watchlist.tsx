/**
 * 관심 목록 (/watchlist; Tubular Viewpoint "my content / competitors"): creators, videos and keywords the viewer
 * pinned (buttons in the video drawer, on the creator page, on the keyword page, or the keyword form here), with
 * period metrics for a selectable window, daily view increase, growth since each video was pinned, and what
 * changed since the viewer's last visit. The list and the visit record live in this browser's localStorage only
 * (features/watchlist/store.ts); JSON export / import moves them between browsers.
 */
import { useMemo, useState } from 'react';
import { Badge, Card, FilterBar, PageHeader, RangePicker, SectionBoundary, SourceNote } from '../components/index.ts';
import { useAnalysis, useDataset, useRangeParam } from '../data/hooks.ts';
import { fmtTime } from '../lib/display.ts';
import { cx } from '../lib/cx.ts';
import { tzShort } from '../lib/timezones.ts';
import { formatLocalRange } from '../lib/urlState.ts';
import { computeWatchCreators, computeWatchKeywords, computeWatchVideos } from '../features/watchlist/analysis.ts';
import type { WatchCreatorsInput, WatchKeywordsInput, WatchVideosInput } from '../features/watchlist/analysis.ts';
import { watchlistSize } from '../features/watchlist/model.ts';
import { useWatchlist } from '../features/watchlist/store.ts';
import {
  CreatorsSection,
  HowToPin,
  KeywordAddForm,
  KeywordsSection,
  ListActions,
  StorageNotices,
  totalNew,
  useVisit,
  VideosSection,
  VisitBanner,
} from '../features/watchlist/parts.tsx';

const WATCH_PRESETS = ['rolling24h', 'rolling7d', 'rolling30d', 'today', 'yesterday', 'last7d', 'last30d', 'last90d', 'thisWeek', 'lastWeek', 'thisMonth', 'lastMonth'] as const;

export default function WatchlistPage() {
  const { now, tz, isSample } = useDataset();
  const snap = useWatchlist();
  const { list } = snap;
  const { spec, range, rollingHours, setSpec } = useRangeParam('range', 'rolling7d');
  const visit = useVisit(now, isSample);
  const since = visit.since.kind === 'first_visit' ? null : visit.since.since;
  const [message, setMessage] = useState<{ tone: 'positive' | 'negative'; text: string } | null>(null);
  const size = watchlistSize(list);

  const creatorKeys = useMemo(() => list.creators.map((c) => c.key), [list.creators]);
  const creatorInput = useMemo((): WatchCreatorsInput => ({ keys: creatorKeys, range, rollingHours, tz, now, since }), [creatorKeys, range, rollingHours, tz, now, since]);
  const creators = useAnalysis('watchlist.creators', creatorInput, (index, i) => computeWatchCreators(index, i));

  const videoInput = useMemo((): WatchVideosInput => ({ pins: list.videos.map((v) => ({ id: v.id, baseline: v.baseline, dataNow: v.dataNow })), now, since }), [list.videos, now, since]);
  const videos = useAnalysis('watchlist.videos', videoInput, (index, i) => computeWatchVideos(index, i));

  const keywordList = useMemo(() => list.keywords.map((k) => k.kw), [list.keywords]);
  const keywordInput = useMemo((): WatchKeywordsInput => ({ keywords: keywordList, range, rollingHours, tz, now, since }), [keywordList, range, rollingHours, tz, now, since]);
  const keywords = useAnalysis('watchlist.keywords', keywordInput, (index, i) => computeWatchKeywords(index, i));

  const tzs = tzShort(tz);
  const win = creators.data?.window ?? keywords.data?.window ?? null;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow="Viewpoint · 내 채널·경쟁 채널"
        title="관심 목록"
        description="고정한 크리에이터·영상·키워드의 변화를 한곳에서 확인. 목록과 방문 기록은 이 브라우저에만 저장됨."
        actions={<ListActions list={list} tz={tz} onMessage={setMessage} />}
      />

      {message ? (
        <p
          role="status"
          className={cx(
            'rounded-lg border px-3 py-2 text-[13px]',
            message.tone === 'positive' ? 'border-line bg-positive-soft text-fg' : 'border-negative bg-negative-soft text-fg',
          )}
        >
          {message.text}
        </p>
      ) : null}

      <StorageNotices snap={snap} />

      {size === 0 ? (
        <Card>
          <HowToPin onAddKeyword={<KeywordAddForm now={now} />} />
        </Card>
      ) : (
        <>
          <VisitBanner
            visit={visit}
            now={now}
            tz={tz}
            newUploads={list.creators.length ? totalNew(creators.data?.rows) : null}
            newKeywordVideos={list.keywords.length ? totalNew(keywords.data?.rows) : null}
          />

          <FilterBar label="관심 목록 기간">
            <RangePicker value={spec} onChange={setSpec} presets={[...WATCH_PRESETS]} />
            <p className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-3">
              <span>
                {rollingHours
                  ? `기간 지표: 데이터 기준 시각까지 최근 ${rollingHours}시간 (롤링, 조회 발생 기간 기준)`
                  : `기간 ${formatLocalRange(range)} (${tzs} 날짜 기준, 양 끝 포함, 조회 발생 기간 기준)`}
              </span>
              {win?.incomplete ? <Badge tone="warning">진행 중인 기간</Badge> : null}
              {/* phones: the line wraps here, a separator would start the next line */}
              <span aria-hidden className="max-sm:hidden">
                ·
              </span>
              <span>
                데이터 기준 {fmtTime(now, tz)} {tzs}
              </span>
            </p>
          </FilterBar>

          <Card>
            <SectionBoundary title="고정한 크리에이터를 표시하지 못함" resetKey={spec}>
              <CreatorsSection pins={list.creators} state={creators} since={visit.since} spec={spec} tz={tz} />
            </SectionBoundary>
          </Card>

          <Card flush>
            <SectionBoundary title="고정한 영상을 표시하지 못함">
              <VideosSection pins={list.videos} state={videos} since={visit.since} tz={tz} />
            </SectionBoundary>
          </Card>

          <Card>
            <SectionBoundary title="고정한 키워드를 표시하지 못함" resetKey={spec}>
              <KeywordsSection count={list.keywords.length} state={keywords} since={visit.since} spec={spec} tz={tz} now={now} />
            </SectionBoundary>
          </Card>
        </>
      )}

      <SourceNote asOf={now} window={size ? win : null}>
        <p>
          추적 중인 영상 기준: YouTube는 채널 RSS의 최근 영상, Dailymotion·niconico·PeerTube는 검색·태그로 발견한 영상만 포함함. 관심 목록은 이 브라우저의
          localStorage에만 있고 서버로 보내지 않음. “지난 방문 이후”는 지난 방문 때 보던 데이터 기준 시각부터 지금 데이터 기준 시각까지임.
        </p>
      </SourceNote>
    </div>
  );
}
