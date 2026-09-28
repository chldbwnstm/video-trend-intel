/**
 * Parts of the API page: copyable code blocks, endpoint cards with parameter / field tables, the static file
 * list and a live check of what the current site serves (server API and/or static JSON).
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Check, Copy, ExternalLink, RefreshCw } from 'lucide-react';
import { Badge, Button, Tooltip } from '../../components/index.ts';
import { fmtTime } from '../../lib/display.ts';
import { formatBytes, formatInteger } from '../../lib/format.ts';
import { tzShort } from '../../lib/timezones.ts';
import { cx } from '../../lib/cx.ts';
import { useTz } from '../../data/hooks.ts';
import { curlCommand, liveStaticUrl, SERVER_MARKER_HEADER, shouldProbeServer } from './apiSpec.ts';
import type { EndpointDoc, FieldDoc, ParamDoc, StaticFileDoc } from './apiSpec.ts';

/* ------------------------------------------------------------------------------------------ code */

export function CodeBlock({ code, label, className }: { code: string; label: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className={cx('group relative min-w-0 rounded-lg border border-line bg-surface-2', className)}>
      <pre className="scroll-thin overflow-x-auto p-3 pr-11 text-xs leading-5 text-fg" aria-label={label}>
        <code>{code}</code>
      </pre>
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? '복사됨' : `${label} 복사`}
        title={copied ? '복사됨' : '복사'}
        className="focus-ring absolute top-1.5 right-1.5 inline-flex size-7 items-center justify-center rounded-md border border-line bg-surface text-fg-3 hover:text-fg"
      >
        {copied ? <Check className="size-3.5 text-positive" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
      </button>
    </div>
  );
}

export function MethodBadge({ method }: { method: string }) {
  return <span className="rounded bg-positive-soft px-1.5 py-px font-mono text-[11px] font-semibold text-positive">{method}</span>;
}

/* ------------------------------------------------------------------------------------------ tables */

function SmallTable({ caption, head, rows }: { caption: string; head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="scroll-thin max-w-full overflow-x-auto rounded-lg border border-line">
      <table className="w-full min-w-[520px] border-collapse text-[13px]">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} scope="col" className="border-b border-line bg-surface-2 px-3 py-1.5 text-left text-xs font-medium whitespace-nowrap text-fg-3">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="align-top">
              {r.map((cell, j) => (
                <td key={j} className="border-b border-line px-3 py-1.5 text-fg-2 last:w-full">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ParamTable({ params, caption }: { params: ParamDoc[]; caption: string }) {
  if (!params.length) return <p className="text-xs text-fg-3">매개변수 없음</p>;
  return (
    <SmallTable
      caption={caption}
      head={['이름', '형식', '기본값', '설명']}
      rows={params.map((p) => [
        <span key="n" className="whitespace-nowrap">
          <code className="font-mono text-xs font-semibold text-fg">{p.name}</code>
          {p.aliases?.length ? <span className="block text-[11px] text-fg-3">별칭 {p.aliases.join(', ')}</span> : null}
        </span>,
        <span key="t" className="block max-w-[14rem] min-w-[7.5rem] text-xs break-words">
          {p.type}
        </span>,
        <span key="d" className="block max-w-[12rem] min-w-[4rem] text-xs break-words">
          {p.default ?? '—'}
        </span>,
        <span key="x" className="block min-w-[14rem]">
          {p.description}
        </span>,
      ])}
    />
  );
}

export function FieldTable({ fields, caption }: { fields: FieldDoc[]; caption: string }) {
  if (!fields.length) return null;
  return (
    <SmallTable
      caption={caption}
      head={['필드', '형식', '설명']}
      rows={fields.map((f) => [
        <code key="n" className="font-mono text-xs font-semibold whitespace-nowrap text-fg">
          {f.name}
        </code>,
        <span key="t" className="text-xs whitespace-nowrap">
          {f.type}
        </span>,
        <span key="d">{f.description}</span>,
      ])}
    />
  );
}

/* ------------------------------------------------------------------------------------------ endpoint */

export function EndpointCard({ ep }: { ep: EndpointDoc }) {
  return (
    <article id={`api-${ep.id}`} tabIndex={-1} className="scroll-mt-4 rounded-xl border border-line bg-surface p-4 shadow-card outline-none sm:p-5">
      <header className="mb-3 flex flex-col gap-1">
        <h3 className="flex flex-wrap items-center gap-2">
          <MethodBadge method={ep.method} />
          <code className="font-mono text-sm font-semibold break-all text-fg">{ep.path}</code>
        </h3>
        <p className="text-[13px] text-fg-2">{ep.summary}</p>
        {ep.description ? <p className="text-xs text-fg-3">{ep.description}</p> : null}
        {ep.staticPath ? (
          <p className="text-xs text-fg-3">
            정적 JSON: <code className="font-mono">api/v1/{ep.staticPath}</code>
          </p>
        ) : null}
      </header>
      <div className="flex flex-col gap-3">
        {ep.params.length ? (
          <section aria-label="매개변수">
            <h4 className="mb-1.5 text-xs font-semibold text-fg-3">매개변수</h4>
            <ParamTable params={ep.params} caption={`${ep.path} 매개변수`} />
          </section>
        ) : null}
        {ep.fields.length ? (
          <details className="text-[13px]">
            <summary className="focus-ring w-fit cursor-pointer rounded-sm text-xs font-semibold text-accent-text hover:underline">응답 필드</summary>
            <div className="mt-1.5">
              <FieldTable fields={ep.fields} caption={`${ep.path} 응답 필드`} />
            </div>
          </details>
        ) : null}
        <section aria-label="예시" className="flex flex-col gap-2">
          <h4 className="text-xs font-semibold text-fg-3">예시 (로컬 서버)</h4>
          {ep.examples.map((ex) => (
            <div key={ex.title} className="flex flex-col gap-1">
              <p className="text-xs text-fg-2">{ex.title}</p>
              <CodeBlock code={curlCommand(ex)} label={`${ex.title} curl 명령`} />
            </div>
          ))}
        </section>
      </div>
    </article>
  );
}

/* ------------------------------------------------------------------------------------------ static files */

export function StaticFileTable({ files }: { files: StaticFileDoc[] }) {
  return (
    <SmallTable
      caption="GitHub Pages 정적 JSON 파일"
      head={['경로 (api/v1/ 아래)', '내용', '예시']}
      rows={files.map((f) => [
        <code key="p" className="font-mono text-xs font-semibold break-all text-fg">
          {f.pattern}
        </code>,
        <span key="d">
          {f.description}
          {f.values ? <span className="mt-0.5 block text-xs text-fg-3">{f.values}</span> : null}
        </span>,
        <a
          key="e"
          href={liveStaticUrl(f.example)}
          target="_blank"
          rel="noopener noreferrer"
          className="focus-ring inline-flex items-center gap-1 rounded-sm font-mono text-xs break-all text-accent-text hover:underline"
        >
          {f.example}
          <ExternalLink className="size-3 shrink-0" aria-hidden />
        </a>,
      ])}
    />
  );
}

/* ------------------------------------------------------------------------------------------ live check */

type CheckState =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'missing'; detail: string }
  | { state: 'ok'; summary: ReactNode };

const SAFE_PATH_RE = /^[A-Za-z0-9_\-./]+\.json$/;

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

type FetchResult = { ok: true; data: unknown; fromServer: boolean } | { ok: false; fromServer: false; detail: string };

async function fetchJson(url: string, signal: AbortSignal): Promise<FetchResult> {
  try {
    const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
    if (!res.ok) return { ok: false, fromServer: false, detail: `HTTP ${res.status}` };
    const type = res.headers.get('content-type') ?? '';
    if (!/json/i.test(type)) return { ok: false, fromServer: false, detail: `JSON이 아님 (${type || '형식 미상'})` };
    return { ok: true, data: await res.json(), fromServer: res.headers.has(SERVER_MARKER_HEADER) };
  } catch (e) {
    return { ok: false, fromServer: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

/** Relative URLs resolve against the page (works under the GitHub Pages sub-path and behind apps/server). */
function siteUrl(path: string): string {
  if (typeof window === 'undefined') return path;
  return new URL(path, window.location.href.split('#')[0]).toString();
}

export function LiveCheck() {
  const tz = useTz();
  const [server, setServer] = useState<CheckState>({ state: 'idle' });
  const [statics, setStatics] = useState<CheckState>({ state: 'idle' });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof fetch === 'undefined') return;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    let live = true;
    setServer({ state: 'loading' });
    setStatics({ state: 'loading' });
    const checkStatic = (r: FetchResult) => {
      if (!r.ok || !isRecord(r.data) || !Array.isArray(r.data.files)) {
        setStatics({ state: 'missing', detail: r.ok ? '응답 형식이 다름' : r.detail });
        return;
      }
      const files = r.data.files.filter((f): f is { path: string; bytes?: unknown } => isRecord(f) && typeof f.path === 'string' && SAFE_PATH_RE.test(f.path));
      const gen = typeof r.data.generatedAt === 'number' ? r.data.generatedAt : null;
      const bytes = files.reduce((a, f) => a + (typeof f.bytes === 'number' ? f.bytes : 0), 0);
      setStatics({
        state: 'ok',
        summary: (
          <>
            파일 {formatInteger(files.length)}개 · {formatBytes(bytes)}
            {gen !== null ? ` · 데이터 기준 ${fmtTime(gen, tz)} ${tzShort(tz)}` : ''}
            {r.fromServer ? ' · 서버가 실시간 계산해 제공' : ''}
            <details className="mt-1">
              <summary className="focus-ring w-fit cursor-pointer rounded-sm text-accent-text hover:underline">파일 목록</summary>
              <ul className="mt-1 max-h-60 overflow-y-auto font-mono text-[11px]">
                {files.map((f) => (
                  <li key={f.path}>
                    <a href={siteUrl(`api/v1/${f.path}`)} target="_blank" rel="noopener noreferrer" className="focus-ring rounded-sm text-accent-text hover:underline">
                      {f.path}
                    </a>
                  </li>
                ))}
              </ul>
            </details>
          </>
        ),
      });
    };
    const checkServer = (r: FetchResult) => {
      if (!r.ok || !isRecord(r.data) || typeof r.data.status !== 'string') {
        setServer({ state: 'missing', detail: r.ok ? '응답 형식이 다름' : r.detail });
        return;
      }
      const ds = isRecord(r.data.dataset) ? r.data.dataset : null;
      const gen = ds && typeof ds.generatedAt === 'number' ? ds.generatedAt : null;
      setServer({
        state: 'ok',
        summary: (
          <>
            상태 <b>{String(r.data.status)}</b>
            {typeof r.data.apiVersion === 'string' ? ` · API ${r.data.apiVersion}` : ''}
            {gen !== null ? ` · 데이터 기준 ${fmtTime(gen, tz)} ${tzShort(tz)}` : ''}
            {ds && typeof ds.videos === 'number' ? ` · 영상 ${formatInteger(ds.videos)}개` : ''}
          </>
        ),
      });
    };
    void (async () => {
      // index.json first: both hosts serve it, and its headers tell apps/server apart from static hosting.
      const idx = await fetchJson(siteUrl('api/v1/index.json'), ctl.signal);
      if (!live) return;
      checkStatic(idx);
      if (!shouldProbeServer(idx)) {
        setServer({ state: 'missing', detail: '정적 호스팅 (index.json이 정적 파일로 응답해 /health 확인은 생략)' });
        return;
      }
      const health = await fetchJson(siteUrl('api/v1/health'), ctl.signal);
      if (!live) return;
      checkServer(health);
    })();
    return () => {
      live = false;
      clearTimeout(t);
      ctl.abort();
    };
  }, [nonce, tz]);

  const row = (title: string, path: string, s: CheckState, missingHint: string) => (
    <li className="flex flex-col gap-1 rounded-lg border border-line p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[13px] font-semibold text-fg">{title}</span>
        {s.state === 'ok' ? (
          <Badge tone="positive">사용 가능</Badge>
        ) : s.state === 'missing' ? (
          <Tooltip content={s.detail}>
            <Badge tone="neutral">이 사이트에 없음</Badge>
          </Tooltip>
        ) : (
          <Badge tone="neutral">{s.state === 'loading' ? '확인 중' : '확인 전'}</Badge>
        )}
      </div>
      <code className="font-mono text-[11px] break-all text-fg-3">{typeof window === 'undefined' ? path : siteUrl(path)}</code>
      <div className="text-xs text-fg-2">{s.state === 'ok' ? s.summary : s.state === 'missing' ? missingHint : null}</div>
    </li>
  );

  return (
    <div className="flex flex-col gap-2">
      <ul className="grid gap-2 md:grid-cols-2">
        {row('REST API (apps/server)', 'api/v1/health', server, '정적 호스팅(GitHub Pages)이나 개발 서버에서는 없음. npm start로 서버를 띄우면 사용 가능.')}
        {row('정적 JSON (GitHub Pages)', 'api/v1/index.json', statics, '이 배포에는 정적 API 파일이 없음. 배포 때 static-api 스크립트로 생성됨.')}
      </ul>
      <div>
        <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" aria-hidden />} onClick={() => setNonce((n) => n + 1)}>
          다시 확인
        </Button>
      </div>
    </div>
  );
}
