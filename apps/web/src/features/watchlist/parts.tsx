/**
 * Sections of the watchlist page (관심 목록): pinned creators (cards), pinned videos (table), pinned keywords
 * (list + add form), the "since your last visit" banner, storage notices and the export / import / clear actions.
 * Every metric goes through MetricCell; plain counts of our own records are plain text.
 */
import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { Platform } from '@vti/core';
import {
  ArrowRight,
  BellDot,
  CheckCheck,
  Download,
  GitCompareArrows,
  Hash,
  Info,
  LineChart,
  Plus,
  Search,
  Trash2,
  TriangleAlert,
  Upload,
  Users,
} from 'lucide-react';
import {
  Badge,
  Button,
  CardHeader,
  DataTable,
  EmptyState,
  ErrorState,
  LoadingState,
  MetricCell,
  Modal,
  PlatformBadge,
  SparkLine,
  Tooltip,
  VideoCell,
  downloadText,
} from '../../components/index.ts';
import type { Column } from '../../components/index.ts';
import { cx } from '../../lib/cx.ts';
import { fmtTime } from '../../lib/display.ts';
import { formatInteger } from '../../lib/format.ts';
import { CROSS_PLATFORM_CAVEAT, platformLabel } from '../../lib/platform.ts';
import { tzShort } from '../../lib/timezones.ts';
import { hrefWith } from '../../lib/urlState.ts';
import { compareHref, creatorHref, MAX_COMPARE, portfolioVideosHref } from '../creators/logic.ts';
import { CreatorAvatar, PlatformStrip, portfolioAvatar } from '../creators/parts.tsx';
import {
  ADD_OUTCOME_MESSAGES,
  addPin,
  DECODE_STATUS_MESSAGES,
  emptyWatchlist,
  exportWatchlist,
  importSummary,
  KEYWORD_MAX_LENGTH,
  markSeen,
  mergeWatchlists,
  parseWatchlistFile,
  rollVisit,
  sinceLastVisit,
  VISIT_SESSION_GAP_MS,
  watchlistSize,
} from './model.ts';
import type { PinnedCreator, PinnedVideo, SinceInfo, VisitState, Watchlist } from './model.ts';
import { keywordPinFor, SPARK_MIN_POINTS, sparkSeries } from './analysis.ts';
import type {
  SinceVisitStats,
  SparkSeries,
  VideoLite,
  WatchCreatorRow,
  WatchCreatorsResult,
  WatchKeywordRow,
  WatchKeywordsResult,
  WatchVideoRow,
  WatchVideosResult,
} from './analysis.ts';
import { getWatchlist, readVisit, updateWatchlist, writeVisit } from './store.ts';
import type { WatchlistSnapshot } from './store.ts';
import { WatchButton } from './WatchButton.tsx';

const LINK = 'focus-ring rounded-sm text-accent-text hover:underline';

interface AnalysisView<T> {
  data: T | undefined;
  error: Error | null;
  isStale: boolean;
}

/* ------------------------------------------------------------------------------------------ visits */

export interface VisitView {
  state: VisitState;
  since: SinceInfo;
  /** False while viewing the sample dataset (visits are not recorded against sample data). */
  recording: boolean;
  markAllSeen: () => void;
}

/**
 * Record this page view (see model.ts rollVisit) and expose the "since your last visit" reference. The rolled
 * state is computed once per mount and written after render; visits are not recorded on the sample dataset.
 */
export function useVisit(now: number, isSample: boolean): VisitView {
  const [state, setState] = useState<VisitState>(() => {
    const prev = readVisit();
    return isSample ? prev : rollVisit(prev, { at: Date.now(), dataNow: now });
  });
  useEffect(() => {
    if (!isSample) writeVisit(state);
  }, [state, isSample]);
  return {
    state,
    since: sinceLastVisit(state, now),
    recording: !isSample,
    markAllSeen: () => setState(markSeen({ at: Date.now(), dataNow: now })),
  };
}

export function VisitBanner({
  visit,
  now,
  tz,
  newUploads,
  newKeywordVideos,
}: {
  visit: VisitView;
  now: number;
  tz: string;
  /** New uploads over the pinned creators (null while computing / nothing pinned). */
  newUploads: number | null;
  newKeywordVideos: number | null;
}) {
  const tzs = tzShort(tz);
  const s = visit.since;
  const gapMin = Math.round(VISIT_SESSION_GAP_MS / 60_000);
  let body: ReactNode;
  if (!visit.recording) {
    body = <span>샘플 데이터를 보는 중이라 방문 기록을 남기지 않음. 실제 데이터에서 다시 열면 지난 방문 이후 변화를 보여 줌.</span>;
  } else if (s.kind === 'first_visit') {
    body = (
      <span>
        이 브라우저에서 처음 연 관심 목록이라 비교할 지난 방문이 없음. 이번 방문을 기록했고, {gapMin}분 이상 지난 뒤 다시 열면 그사이 새 업로드와 조회
        증가를 보여 줌.
      </span>
    );
  } else if (s.kind === 'no_new_data') {
    body = (
      <span>
        지난 방문({fmtTime(s.visitAt, tz)} {tzs}) 이후 데이터가 아직 갱신되지 않음 · 데이터 기준 {fmtTime(now, tz)} {tzs}. 수집은 약 3시간마다 돌아감.
      </span>
    );
  } else {
    const parts: string[] = [];
    if (newUploads !== null) parts.push(`크리에이터 새 업로드 ${formatInteger(newUploads)}개`);
    if (newKeywordVideos !== null) parts.push(`키워드 새 영상 ${formatInteger(newKeywordVideos)}개`);
    body = (
      <span>
        <span className="font-semibold text-fg">지난 방문 이후</span> ({fmtTime(s.visitAt, tz)} {tzs} 방문 · 데이터 {fmtTime(s.since, tz)} → {fmtTime(now, tz)}{' '}
        {tzs}){parts.length ? `: ${parts.join(' · ')}` : ''}. 아래 각 항목의 “지난 방문 이후” 값이 이 구간 기준임.
      </span>
    );
  }
  return (
    <section aria-label="지난 방문 이후 변화" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-[13px] text-fg-2">
      <BellDot className="size-4 shrink-0 text-accent-text" aria-hidden />
      <p className="min-w-[15rem] flex-1">{body}</p>
      {visit.recording && s.kind === 'since' ? (
        <Button size="sm" variant="secondary" icon={<CheckCheck className="size-4" aria-hidden />} onClick={visit.markAllSeen} title="지금 데이터를 새 기준으로 삼음 (지난 방문 이후 값이 0부터 다시 쌓임)">
          모두 확인함
        </Button>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------------------------------ storage notices */

export function StorageNotices({ snap }: { snap: WatchlistSnapshot }) {
  const items: { tone: 'warning' | 'info'; text: string }[] = [];
  if (!snap.persistent) {
    items.push({
      tone: 'warning',
      text: '이 브라우저에서 저장소(localStorage)를 쓸 수 없어 관심 목록이 이 탭에서만 유지됨. 닫기 전에 JSON으로 내보내 두면 나중에 가져올 수 있음.',
    });
  }
  if (snap.status === 'corrupt' || snap.status === 'unsupported_version' || snap.status === 'wrong_format') {
    items.push({
      tone: 'warning',
      text: `${DECODE_STATUS_MESSAGES[snap.status]} 빈 목록으로 시작하며, 새로 고정하면 읽지 못한 기존 값은 별도 백업 키(vti.watchlist.v1.unreadable)에 보관됨.`,
    });
  }
  if (snap.dropped || snap.truncated) {
    const parts: string[] = [];
    if (snap.dropped) parts.push(`읽을 수 없거나 중복된 항목 ${formatInteger(snap.dropped)}개`);
    if (snap.truncated) parts.push(`개수 한도를 넘은 항목 ${formatInteger(snap.truncated)}개`);
    items.push({ tone: 'info', text: `저장된 목록에서 ${parts.join(', ')}를 제외하고 불러옴.` });
  }
  if (!items.length) return null;
  return (
    <div className="flex flex-col gap-2">
      {items.map((it) => (
        <p
          key={it.text}
          className={cx(
            'flex items-start gap-2 rounded-lg border px-3 py-2 text-[13px]',
            it.tone === 'warning' ? 'border-warning bg-warning-soft text-fg' : 'border-line bg-surface-2 text-fg-2',
          )}
        >
          {it.tone === 'warning' ? <TriangleAlert className="mt-px size-4 shrink-0 text-warning" aria-hidden /> : <Info className="mt-px size-4 shrink-0 text-fg-3" aria-hidden />}
          <span>{it.text}</span>
        </p>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ export / import / clear */

/** Import files above this size are refused (a full list is well under 200 KB). */
const IMPORT_MAX_BYTES = 2_000_000;

function fileStamp(at: number, tz: string): string {
  return fmtTime(at, tz, 'datetime').replace(/[^0-9]+/g, '').slice(0, 12);
}

export function ListActions({ list, tz, onMessage }: { list: Watchlist; tz: string; onMessage: (m: { tone: 'positive' | 'negative'; text: string } | null) => void }) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const size = watchlistSize(list);

  const onExport = () => {
    const at = Date.now();
    downloadText(JSON.stringify(exportWatchlist(list, at), null, 2), `vti-watchlist_${fileStamp(at, tz)}.json`, 'application/json;charset=utf-8');
    onMessage({ tone: 'positive', text: `관심 목록 ${formatInteger(size)}개 항목을 JSON 파일로 내보냄. 다른 브라우저의 관심 목록 페이지에서 가져오기로 옮길 수 있음.` });
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > IMPORT_MAX_BYTES) {
      onMessage({ tone: 'negative', text: `가져오지 못함: 파일이 너무 큼 (${formatInteger(Math.round(file.size / 1024))}KB). 관심 목록 파일은 보통 수십 KB 이하임.` });
      return;
    }
    let text: string;
    try {
      text = await file.text();
    } catch {
      onMessage({ tone: 'negative', text: '파일을 읽지 못함.' });
      return;
    }
    const parsed = parseWatchlistFile(text);
    if (parsed.status !== 'ok') {
      onMessage({ tone: 'negative', text: `가져오지 못함: ${parsed.status === 'empty' ? '빈 파일.' : DECODE_STATUS_MESSAGES[parsed.status]}` });
      return;
    }
    const merged = mergeWatchlists(getWatchlist().list, parsed.list, Date.now());
    updateWatchlist(() => merged.list);
    onMessage({ tone: 'positive', text: `가져오기 완료: ${importSummary(merged, parsed.dropped, parsed.truncated)}.` });
  };

  return (
    <>
      <Button size="sm" icon={<Download className="size-4" aria-hidden />} onClick={onExport} disabled={!size} title="관심 목록을 JSON 파일로 저장 (다른 브라우저로 옮기기)">
        내보내기
      </Button>
      <Button size="sm" icon={<Upload className="size-4" aria-hidden />} onClick={() => fileRef.current?.click()} title="내보낸 JSON 파일에서 가져와 지금 목록에 합침">
        가져오기
      </Button>
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          const f = e.currentTarget.files?.[0];
          e.currentTarget.value = '';
          void onFile(f);
        }}
      />
      <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" aria-hidden />} onClick={() => setConfirmClear(true)} disabled={!size}>
        비우기
      </Button>
      <Modal
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        title="관심 목록 비우기"
        description="고정한 크리에이터·영상·키워드를 모두 뺌. 되돌릴 수 없음."
        footer={
          <div className="flex flex-wrap justify-end gap-2">
            <Button size="sm" onClick={() => setConfirmClear(false)}>
              취소
            </Button>
            <Button
              size="sm"
              variant="danger"
              icon={<Trash2 className="size-4" aria-hidden />}
              onClick={() => {
                updateWatchlist(() => ({ ...emptyWatchlist(), updatedAt: Date.now() }));
                setConfirmClear(false);
                onMessage({ tone: 'positive', text: '관심 목록을 비움.' });
              }}
            >
              모두 빼기
            </Button>
          </div>
        }
      >
        <p className="text-sm text-fg-2">
          크리에이터 {formatInteger(list.creators.length)}명 · 영상 {formatInteger(list.videos.length)}개 · 키워드 {formatInteger(list.keywords.length)}개. 영상의 고정 시점
          조회 기록도 함께 지워짐. 필요하면 먼저 내보내기로 JSON 파일을 받아 둘 것.
        </p>
      </Modal>
    </>
  );
}

/* ------------------------------------------------------------------------------------------ empty state */

export function HowToPin({ onAddKeyword }: { onAddKeyword: ReactNode }) {
  return (
    <div className="flex flex-col gap-4">
      <EmptyState
        icon={<BellDot className="size-8" />}
        title="관심 목록이 비어 있음"
        description={
          <span className="flex flex-col gap-1">
            <span>내 채널과 경쟁 채널, 지켜볼 영상과 키워드를 고정해 두면 여기서 변화를 한 번에 확인함.</span>
            <span>목록은 이 브라우저에만 저장됨 (계정·서버 없음). 다른 기기로 옮기려면 내보내기·가져오기(JSON)를 사용.</span>
          </span>
        }
      />
      <ol className="grid gap-3 text-[13px] text-fg-2 sm:grid-cols-3">
        <HowStep n={1} title="영상" to="/videos" linkLabel="영상 탐색 열기">
          영상 탐색에서 영상을 눌러 상세 창을 연 뒤 <strong className="font-semibold text-fg">관심 목록에 추가</strong>. 그때의 조회 관측값을 기록해 이후 증가를 보여 줌.
        </HowStep>
        <HowStep n={2} title="크리에이터" to="/creators" linkLabel="크리에이터 목록 열기">
          크리에이터 상세 페이지 상단의 <strong className="font-semibold text-fg">관심 목록에 추가</strong>. 기간 지표·일별 추이·새 업로드를 추적함.
        </HowStep>
        <HowStep n={3} title="키워드" to="/keywords" linkLabel="키워드 분석 열기">
          키워드 분석 페이지의 <strong className="font-semibold text-fg">관심 목록에 추가</strong> 또는 아래 입력란. 지난 방문 이후 새로 올라온 관련 영상 수를 보여 줌.
        </HowStep>
      </ol>
      {onAddKeyword}
    </div>
  );
}

function HowStep({ n, title, to, linkLabel, children }: { n: number; title: string; to: string; linkLabel: string; children: ReactNode }) {
  return (
    <li className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface-2 p-3">
      <p className="flex items-center gap-2 text-sm font-semibold text-fg">
        <span className="inline-flex size-5 items-center justify-center rounded-full bg-accent-soft text-[11px] text-accent-text" aria-hidden>
          {n}
        </span>
        {title}
      </p>
      <p>{children}</p>
      <Link to={to} className={cx(LINK, 'inline-flex w-fit items-center gap-1 text-[13px] font-medium')}>
        {linkLabel} <ArrowRight className="size-3.5" aria-hidden />
      </Link>
    </li>
  );
}

/* ------------------------------------------------------------------------------------------ keyword form */

export function KeywordAddForm({ now, compact = false }: { now: number; compact?: boolean }) {
  const [text, setText] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const at = Date.now();
    const value = keywordPinFor(text, now, at);
    if (!value) {
      setMessage('키워드를 입력');
      return;
    }
    const r = addPin(getWatchlist().list, { kind: 'keyword', value }, at);
    if (r.outcome === 'added') {
      updateWatchlist(() => r.list);
      setText('');
      setMessage(null);
    } else setMessage(ADD_OUTCOME_MESSAGES[r.outcome]);
  };
  return (
    <form onSubmit={submit} className={cx('flex flex-wrap items-center gap-2', !compact && 'rounded-lg border border-line bg-surface-2 p-3')} aria-label="키워드 고정">
      {!compact ? <span className="w-full text-[13px] font-medium text-fg">키워드 바로 고정</span> : null}
      <label className="relative flex min-w-0 flex-1 items-center">
        <span className="sr-only">고정할 키워드</span>
        <Hash className="pointer-events-none absolute left-2.5 size-4 text-fg-3" aria-hidden />
        <input
          type="text"
          value={text}
          maxLength={KEYWORD_MAX_LENGTH}
          onChange={(e) => {
            setText(e.target.value);
            if (message) setMessage(null);
          }}
          placeholder="예: 추석, 먹방, 야구"
          className="focus-ring h-9 w-full min-w-0 rounded-md border border-line bg-surface pr-3 pl-8 text-sm text-fg placeholder:text-fg-3"
        />
      </label>
      <Button type="submit" size="md" icon={<Plus className="size-4" aria-hidden />}>
        고정
      </Button>
      {message ? (
        <span role="status" className="w-full text-xs text-warning">
          {message}
        </span>
      ) : null}
    </form>
  );
}

/* ------------------------------------------------------------------------------------------ since-visit line */

function SinceLine({
  stats,
  since,
  tz,
  videosHref,
  label = '새 업로드',
}: {
  stats: SinceVisitStats | null;
  since: SinceInfo;
  tz: string;
  videosHref?: string;
  label?: string;
}) {
  if (since.kind === 'first_visit' || !stats) return <p className="text-xs text-fg-3">지난 방문 이후 변화: 다음 방문부터 표시</p>;
  if (since.kind === 'no_new_data') return <p className="text-xs text-fg-3">지난 방문 이후 데이터 갱신 없음</p>;
  return (
    <div className="flex flex-col gap-1 rounded-md bg-surface-2 px-2.5 py-2 text-xs text-fg-2">
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium text-fg">지난 방문 이후</span>
        <span>
          {label}{' '}
          <strong className={cx('font-semibold', stats.newUploads > 0 ? 'text-accent-text' : 'text-fg')}>{formatInteger(stats.newUploads)}개</strong>
        </span>
        <span className="inline-flex items-center gap-1">
          조회 증가 <MetricCell metric={stats.views} label="지난 방문 이후 조회 증가" align="left" extra="지난 방문 때의 데이터 기준 시각부터 지금 데이터 기준 시각까지. 여러 플랫폼이면 단위가 달라 참고용." />
        </span>
        {stats.lateFound ? (
          <Tooltip content="지난 방문 전에 게시됐지만 그 뒤에 처음 수집된 영상 (수집을 막 시작했거나 수집기가 늦게 발견함). 새 업로드 수에는 넣지 않음.">
            <span className="text-fg-3">이전 게시·새로 수집 {formatInteger(stats.lateFound)}개</span>
          </Tooltip>
        ) : null}
      </p>
      {stats.recent.length ? (
        <ul className="flex flex-col gap-0.5">
          {stats.recent.map((v) => (
            <RecentVideo key={v.id} v={v} tz={tz} />
          ))}
        </ul>
      ) : null}
      {videosHref && stats.newUploads > stats.recent.length ? (
        <Link to={videosHref} className={cx(LINK, 'w-fit')}>
          새 업로드 모두 보기 ({formatInteger(stats.newUploads)}개)
        </Link>
      ) : null}
    </div>
  );
}

function RecentVideo({ v, tz }: { v: VideoLite; tz: string }) {
  return (
    <li className="flex min-w-0 items-center gap-1.5">
      <span className="shrink-0 text-fg-3 tabular">{fmtTime(v.publishedAt, tz, 'datetime').slice(5)}</span>
      <Link to={hrefWith('/videos', { v: v.id })} className={cx(LINK, 'min-w-0 truncate')} title={v.title}>
        {v.title || '(제목 없음)'}
      </Link>
    </li>
  );
}

/* ------------------------------------------------------------------------------------------ creators */

export function CreatorsSection({
  pins,
  state,
  since,
  spec,
  tz,
}: {
  pins: PinnedCreator[];
  state: AnalysisView<WatchCreatorsResult>;
  since: SinceInfo;
  spec: string;
  tz: string;
}) {
  const keys = pins.map((p) => p.key);
  const compareKeys = keys.slice(0, MAX_COMPARE);
  const r = state.data;
  return (
    <>
      <CardHeader
        icon={<Users className="size-4" />}
        title={`크리에이터 ${formatInteger(pins.length)}`}
        description="고정한 크리에이터·계정의 기간 지표 (조회 발생 기간 기준), 일별 조회 증가, 지난 방문 이후 새 업로드. 추적 영상 기준."
        actions={
          keys.length ? (
            <Link
              to={compareHref(compareKeys, { range: spec })}
              className="focus-ring inline-flex h-8 items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-[13px] font-medium text-fg hover:bg-surface-3"
              title={keys.length > MAX_COMPARE ? `최근 고정한 ${MAX_COMPARE}명만 비교함 (최대 ${MAX_COMPARE}명)` : '고정한 크리에이터를 같은 기간·지표로 비교'}
            >
              <GitCompareArrows className="size-4" aria-hidden />
              <span>
                <span className="hidden sm:inline">고정한 크리에이터 </span>비교{keys.length > 1 ? ` (${compareKeys.length}명)` : ''}
              </span>
            </Link>
          ) : null
        }
      />
      {!pins.length ? (
        <EmptyState compact icon={<Users className="size-6" />} title="고정한 크리에이터 없음" description="크리에이터 상세 페이지 상단의 ‘관심 목록에 추가’로 고정." />
      ) : state.error ? (
        <ErrorState title="크리에이터 지표를 계산하지 못함" error={state.error} compact />
      ) : !r ? (
        <LoadingState rows={4} />
      ) : (
        <div className={cx('flex flex-col gap-3 transition-opacity', state.isStale && 'opacity-60')}>
          <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {r.rows.map((row) => (
              <CreatorCard
                key={row.key}
                row={row}
                pin={pins.find((p) => p.key === row.key) ?? null}
                since={since}
                spec={spec}
                tz={tz}
                today={r.today}
                sparkLabel={`${r.sparkRange.start} ~ ${r.sparkRange.end}`}
              />
            ))}
          </ul>
          {keys.length > MAX_COMPARE ? <p className="text-xs text-fg-3">비교 버튼은 최근 고정한 {MAX_COMPARE}명을 엶 (비교는 최대 {MAX_COMPARE}명).</p> : null}
          {r.platforms.length > 1 ? (
            <p className="flex items-start gap-1.5 text-xs text-fg-3">
              <TriangleAlert className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
              <span>
                여러 플랫폼({r.platforms.map(platformLabel).join('·')})이 섞여 있음. {CROSS_PLATFORM_CAVEAT} 여러 플랫폼 크리에이터의 조회 합계는 참고용이며, 크리에이터 비교의
                플랫폼 필터로 같은 단위끼리 볼 수 있음.
              </span>
            </p>
          ) : null}
        </div>
      )}
    </>
  );
}

function CreatorCard({
  row,
  pin,
  since,
  spec,
  tz,
  today,
  sparkLabel,
}: {
  row: WatchCreatorRow;
  pin: PinnedCreator | null;
  since: SinceInfo;
  spec: string;
  tz: string;
  today: string | null;
  sparkLabel: string;
}) {
  if (!row.found || !row.summary) {
    return (
      <li className="flex min-w-0 flex-col gap-2 rounded-lg border border-line bg-surface p-3">
        <div className="flex items-start gap-3">
          <CreatorAvatar name={pin?.name ?? row.key} platform={pin?.platforms[0] ?? null} size="md" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-fg">{pin?.name ?? row.key}</p>
            <p className="text-xs break-all text-fg-3">{row.key}</p>
          </div>
          <WatchButton kind="creator" id={row.key} iconOnly />
        </div>
        <p className="flex items-start gap-1.5 text-xs text-fg-2">
          <TriangleAlert className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
          현재 데이터셋에 이 크리에이터·계정이 없음 (내보내기 용량 제한, 연결 변경, 또는 다른 데이터셋에서 고정함).
        </p>
      </li>
    );
  }
  const s = row.summary;
  const av = portfolioAvatar(row.accounts);
  const spark = sparkSeries(row.daily, today);
  const multi = row.platforms.length > 1;
  const newHref = portfolioVideosHref({ key: row.key, kind: row.kind ?? 'account', accountIds: row.accountIds }, { mode: 'upload', sort: 'published_at', range: spec });
  return (
    <li className="flex min-w-0 flex-col gap-3 rounded-lg border border-line bg-surface p-3">
      <div className="flex items-start gap-3">
        <CreatorAvatar name={row.name} src={av.src} platform={av.platform} size="md" />
        <div className="min-w-0 flex-1">
          <Link to={creatorHref(row.key, { range: spec })} className={cx(LINK, 'block truncate text-sm font-semibold')}>
            {row.name}
          </Link>
          <p className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-fg-3">
            <PlatformStrip platforms={row.platforms} />
            <span>추적 영상 {formatInteger(s.videoCount)}개</span>
          </p>
        </div>
        <WatchButton kind="creator" id={row.key} iconOnly />
      </div>
      <dl className="grid grid-cols-3 gap-2">
        <Stat label="기간 조회 증가">
          <MetricCell metric={s.viewsInWindow} label="기간 조회 증가" size="md" align="left" extra={multi ? '여러 플랫폼 합계 · 단위가 달라 참고용' : undefined} />
        </Stat>
        <Stat label="기간 업로드">
          <span className="text-[15px] font-semibold text-fg tabular">{formatInteger(s.uploadsInWindow)}개</span>
        </Stat>
        <Stat label="참여율(중앙값)">
          <MetricCell metric={s.engagementRate} kind="rate" label="참여율(중앙값)" size="md" align="left" />
        </Stat>
      </dl>
      <DailyTrend spark={spark} name={row.name} sparkLabel={sparkLabel} tz={tz} multi={multi} />
      <SinceLine stats={row.since} since={since} tz={tz} videosHref={newHref} />
      <p className="text-[11px] text-fg-3">
        {pin?.pinnedAt ? `고정 ${fmtTime(pin.pinnedAt, tz, 'date')}` : '고정 시각 미상'}
        {row.lastUpload !== null ? ` · 최근 게시 ${fmtTime(row.lastUpload, tz, 'date')}` : ''}
      </p>
    </li>
  );
}

/** Daily view increase: a sparkline once enough finished days are measurable, else the latest days as numbers. */
function DailyTrend({ spark, name, sparkLabel, tz, multi }: { spark: SparkSeries; name: string; sparkLabel: string; tz: string; multi: boolean }) {
  const caption = `일별 조회 증가 · ${sparkLabel} (${tzShort(tz)}) · 완료된 날 중 계산 가능 ${spark.measured}/${spark.values.length}일${multi ? ' · 플랫폼 합계' : ''}`;
  if (spark.measured >= SPARK_MIN_POINTS) {
    return (
      <div className="flex flex-col gap-1">
        <SparkLine data={spark.values} labels={spark.labels} label={`${name} 일별 조회 증가`} height={40} />
        <p className="text-[11px] text-fg-3">{caption} · 오늘(진행 중)은 선에서 제외</p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1 rounded-md border border-dashed border-line px-2.5 py-2">
      {spark.recent.length ? (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-2">
          {spark.recent.map((d) => (
            <span key={d.date} className="inline-flex items-center gap-1">
              <span className="text-fg-3 tabular">
                {d.date.slice(5)}
                {d.partial ? '(진행 중)' : ''}
              </span>
              <MetricCell metric={d.metric} label={`${d.date} 조회 증가`} align="left" />
            </span>
          ))}
        </p>
      ) : null}
      <p className="text-[11px] text-fg-3">
        {caption}. 완료된 날이 {SPARK_MIN_POINTS}일 이상 계산되면 추이 선으로 표시함.
      </p>
    </div>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-md bg-surface-2 px-2 py-1.5">
      <dt className="truncate text-[11px] text-fg-3">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ videos */

interface VideoTableRow {
  pin: PinnedVideo;
  row: WatchVideoRow;
}

export function VideosSection({ pins, state, since, tz }: { pins: PinnedVideo[]; state: AnalysisView<WatchVideosResult>; since: SinceInfo; tz: string }) {
  const r = state.data;
  const tzs = tzShort(tz);
  const rows: VideoTableRow[] = r ? r.rows.map((row) => ({ row, pin: pins.find((p) => p.id === row.id)! })).filter((x) => x.pin) : [];
  const columns: Column<VideoTableRow>[] = [
    {
      id: 'video',
      header: '영상',
      cell: ({ row, pin }) =>
        row.video ? (
          <VideoCell
            video={row.video}
            accountName={row.accountName}
            publishedLabel={fmtTime(row.video.publishedAt, tz, 'date')}
            publishedTitle={`${fmtTime(row.video.publishedAt, tz)} ${tzs}`}
          >
            <Link to={hrefWith('/videos', { v: row.id })} className={cx(LINK, 'mt-0.5 inline-flex w-fit items-center gap-1 text-xs')}>
              <LineChart className="size-3" aria-hidden />
              성장 곡선·관측 기록
            </Link>
          </VideoCell>
        ) : (
          <div className="flex min-w-0 flex-col gap-1">
            <span className="line-clamp-2 text-sm text-fg">{pin.title || row.id}</span>
            <span className="flex flex-wrap items-center gap-1 text-xs text-fg-3">
              {pin.platform ? <PlatformBadge platform={pin.platform} size="xs" /> : null}
              {pin.accountName ? <span>{pin.accountName}</span> : null}
              <Badge tone="warning">현재 데이터셋에 없음</Badge>
            </span>
          </div>
        ),
    },
    {
      id: 'atPin',
      header: '고정 시 조회',
      align: 'right',
      width: '7rem',
      hideBelow: 'sm',
      hint: '고정할 때 알려진 마지막 조회 관측값 (관측 시각 기준). 관측이 없었으면 고정 시점의 계열 값.',
      cell: ({ row, pin }) => (
        <MetricCell metric={row.atPin} label="고정 시 조회" source={pin.baseline?.src ?? null} extra={pin.pinnedAt ? `고정 ${fmtTime(pin.pinnedAt, tz)} ${tzs}` : undefined} />
      ),
    },
    {
      id: 'current',
      header: '누적 조회',
      align: 'right',
      width: '7rem',
      hideBelow: 'sm',
      cell: ({ row }) => <MetricCell metric={row.current} label="누적 조회" />,
    },
    {
      id: 'growth',
      header: '고정 이후 증가',
      align: 'right',
      width: '7.5rem',
      hint: '고정 때 기록한 관측값부터 지금까지 늘어난 조회. 그 뒤 관측이 없으면 —, 마지막 관측이 오래됐으면 ≥(하한).',
      cell: ({ row }) => (
        <MetricCell
          metric={row.growth}
          label="고정 이후 조회 증가"
          extra={row.video && row.growth.status === 'unavailable' && row.growth.note === 'after_last_observation' ? '고정한 뒤 새 관측이 아직 없음. 다음 수집 뒤 계산됨.' : undefined}
        />
      ),
    },
    {
      id: 'since',
      header: '지난 방문 이후',
      align: 'right',
      width: '7rem',
      hideBelow: 'md',
      cell: ({ row }) =>
        row.sinceVisit ? (
          <MetricCell metric={row.sinceVisit} label="지난 방문 이후 조회 증가" />
        ) : (
          <Tooltip content="지난 방문 기록이 생기면 표시">
            <span className="text-xs text-fg-3">첫 방문</span>
          </Tooltip>
        ),
    },
    {
      id: 'unpin',
      header: <span className="sr-only">관심 목록에서 빼기</span>,
      align: 'right',
      width: '3rem',
      cell: ({ row }) => <WatchButton kind="video" id={row.id} iconOnly />,
    },
  ];
  return (
    <>
      <div className="p-4 pb-0 sm:p-5 sm:pb-0">
        <CardHeader
          icon={<LineChart className="size-4" />}
          title={`영상 ${formatInteger(pins.length)}`}
          description="고정할 때의 조회 관측값과 지금을 비교함. 모든 값은 우리 관측 기준(데이터 기준 시각까지)."
        />
      </div>
      {!pins.length ? (
        <EmptyState compact icon={<LineChart className="size-6" />} title="고정한 영상 없음" description="영상 탐색에서 영상을 눌러 상세 창의 ‘관심 목록에 추가’로 고정." />
      ) : state.error ? (
        <ErrorState title="영상 지표를 계산하지 못함" error={state.error} compact />
      ) : !r ? (
        <LoadingState rows={4} className="px-4" />
      ) : (
        <>
          <DataTable columns={columns} rows={rows} rowKey={(x) => x.row.id} caption="고정한 영상" stale={state.isStale} minWidth="320px" className="mt-1" />
          <div className="flex flex-col gap-1 px-4 py-3 text-xs text-fg-3 sm:px-5">
            {r.platforms.length > 1 ? (
              <p className="flex items-start gap-1.5">
                <TriangleAlert className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
                <span>여러 플랫폼 영상이 섞여 있음. {CROSS_PLATFORM_CAVEAT}</span>
              </p>
            ) : null}
            {since.kind === 'first_visit' ? null : <p>“지난 방문 이후”는 지난 방문 때의 데이터 기준 시각부터 지금까지의 증가.</p>}
          </div>
        </>
      )}
    </>
  );
}

/* ------------------------------------------------------------------------------------------ keywords */

export function KeywordsSection({
  count,
  state,
  since,
  spec,
  tz,
  now,
}: {
  count: number;
  state: AnalysisView<WatchKeywordsResult>;
  since: SinceInfo;
  spec: string;
  tz: string;
  now: number;
}) {
  const r = state.data;
  const mixed = r ? r.rows.some((k) => k.platforms.length > 1) : false;
  return (
    <>
      <CardHeader
        icon={<Hash className="size-4" />}
        title={`키워드 ${formatInteger(count)}`}
        description="키워드 분석과 같은 기준(제목·태그·주제·설명에 모든 단어 포함, 짧은 영문은 단어 단위)으로 찾은 추적 영상. 기간 조회 증가는 조회 발생 기간 기준."
      />
      <div className="flex flex-col gap-3">
        <KeywordAddForm now={now} compact />
        {!count ? (
          <EmptyState compact icon={<Hash className="size-6" />} title="고정한 키워드 없음" description="위 입력란 또는 키워드 분석 페이지의 ‘관심 목록에 추가’로 고정." />
        ) : state.error ? (
          <ErrorState title="키워드 지표를 계산하지 못함" error={state.error} compact />
        ) : !r ? (
          <LoadingState rows={3} />
        ) : (
          <ul className={cx('flex flex-col divide-y divide-line transition-opacity', state.isStale && 'opacity-60')}>
            {r.rows.map((row) => (
              <KeywordRow key={row.kw} row={row} since={since} spec={spec} tz={tz} />
            ))}
          </ul>
        )}
        {mixed ? (
          <p className="flex items-start gap-1.5 text-xs text-fg-3">
            <TriangleAlert className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
            <span>여러 플랫폼 영상이 섞인 키워드의 조회 합계는 참고용. {CROSS_PLATFORM_CAVEAT}</span>
          </p>
        ) : null}
      </div>
    </>
  );
}

function KeywordRow({ row, since, spec, tz }: { row: WatchKeywordRow; since: SinceInfo; spec: string; tz: string }) {
  const videosHref = hrefWith('/videos', { q: row.kw, mode: 'upload', sort: 'published_at', range: spec });
  return (
    <li className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-1.5">
            <Hash className="size-4 text-fg-3" aria-hidden />
            <span className="text-sm font-semibold break-all text-fg">{row.kw}</span>
            {row.since && since.kind === 'since' && row.since.newUploads > 0 ? <Badge tone="accent">새 영상 {formatInteger(row.since.newUploads)}</Badge> : null}
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-3">
            <span>추적 영상 {formatInteger(row.total)}개</span>
            <span>· 기간 업로드 {formatInteger(row.uploadsInWindow)}개</span>
            {row.lastUpload !== null ? <span>· 최근 게시 {fmtTime(row.lastUpload, tz, 'date')}</span> : null}
            {row.platforms.slice(0, 3).map((p) => (
              <PlatformCount key={p.platform} platform={p.platform} count={p.count} />
            ))}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <div className="text-right">
            <MetricCell metric={row.viewsInWindow} label="기간 조회 증가" size="md" extra={row.platforms.length > 1 ? '여러 플랫폼 합계 · 단위가 달라 참고용' : undefined} />
            <p className="text-[11px] text-fg-3">기간 조회 증가</p>
          </div>
          <WatchButton kind="keyword" id={row.kw} iconOnly />
        </div>
      </div>
      {row.total === 0 ? <p className="text-xs text-fg-3">아직 이 키워드와 맞는 추적 영상이 없음 (0개). 새로 수집되면 여기에 나타남.</p> : null}
      <SinceLine stats={row.since} since={since} tz={tz} label="새 영상" />
      <p className="flex flex-wrap gap-x-3 gap-y-1 text-[13px]">
        <Link to={hrefWith('/keywords', { kw: row.kw, range: spec })} className={cx(LINK, 'inline-flex items-center gap-1 font-medium')}>
          키워드 분석 <ArrowRight className="size-3.5" aria-hidden />
        </Link>
        <Link
          to={videosHref}
          className={cx(LINK, 'inline-flex items-center gap-1')}
          title="영상 탐색 검색(제목·태그·주제·계정 이름 기준, 최근 게시순)으로 엶. 검색 기준이 달라 개수가 조금 다를 수 있음."
        >
          <Search className="size-3.5" aria-hidden />
          영상 탐색에서 검색
        </Link>
      </p>
    </li>
  );
}

function PlatformCount({ platform, count }: { platform: Platform; count: number }) {
  return (
    <span className="inline-flex items-center gap-1">
      <PlatformBadge platform={platform} size="xs" />
      <span className="tabular">{formatInteger(count)}</span>
    </span>
  );
}

/* ------------------------------------------------------------------------------------------ misc */

/** Sum of new uploads over rows (null while computing or when there is no reference yet). */
export function totalNew(rows: readonly { since: SinceVisitStats | null }[] | undefined): number | null {
  if (!rows || !rows.length) return null;
  let n = 0;
  for (const r of rows) {
    if (!r.since) return null;
    n += r.since.newUploads;
  }
  return n;
}

