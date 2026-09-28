/**
 * CSV export. For video query results it uses core `queryResultToCsv` (every metric with its status and
 * asOf, UTF-8 BOM for Excel). Other tables can pass `getCsv` built with `toCsv()`.
 */
import { useState } from 'react';
import { queryResultToCsv } from '@vti/core';
import type { QueryResult } from '@vti/core';
import { Download } from 'lucide-react';
import { fmtTime } from '../lib/display.ts';
import { useTz } from '../data/hooks.ts';
import { Button } from './primitives.tsx';

const BOM = '﻿';

/** Build CSV text (RFC 4180 quoting, CRLF, UTF-8 BOM). `null` cells are empty (not 0). */
export function toCsv(rows: (string | number | boolean | null | undefined)[][]): string {
  const esc = (v: string | number | boolean | null | undefined): string => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : String(v);
    // Neutralize spreadsheet formula injection from untrusted text (=, +, -, @ at the start).
    const guarded = typeof v === 'string' && /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
  };
  return BOM + rows.map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n';
}

/** Trigger a browser download of `text`. */
export function downloadText(text: string, filename: string, mime = 'text/csv;charset=utf-8'): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** `videos_2026-09-28_1405.csv` (timestamp in the display tz). */
export function csvFilename(base: string, at: number, tz: string): string {
  const stamp = fmtTime(at, tz, 'datetime').replace(' ', '_').replace(':', '');
  const safeBase = base.replace(/[\\/:*?"<>|\s]+/g, '_') || 'export';
  return `${safeBase}_${stamp}.csv`;
}

export interface ExportCsvButtonProps {
  /** A video query result (uses core queryResultToCsv). */
  result?: QueryResult | null;
  /** Alternative CSV producer for non-video tables. */
  getCsv?: () => string;
  /** File name base without extension (default `export`). */
  filename?: string;
  label?: string;
  size?: 'sm' | 'md';
  disabled?: boolean;
}

export function ExportCsvButton({ result, getCsv, filename = 'export', label = 'CSV 내보내기', size = 'sm', disabled }: ExportCsvButtonProps) {
  const tz = useTz();
  const [error, setError] = useState<string | null>(null);
  const nothing = !getCsv && (!result || result.rows.length === 0);
  return (
    <span className="inline-flex flex-col items-end">
      <Button
        size={size}
        icon={<Download className="size-3.5" aria-hidden />}
        disabled={disabled || nothing}
        title={nothing ? '내보낼 결과 없음' : '현재 결과를 CSV로 저장 (지표 상태·기준 시각 포함)'}
        onClick={() => {
          try {
            let text = getCsv ? getCsv() : queryResultToCsv(result!, tz);
            if (!text.startsWith(BOM)) text = BOM + text;
            downloadText(text, csvFilename(filename, result?.now ?? Date.now(), tz));
            setError(null);
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          }
        }}
      >
        {label}
      </Button>
      {error ? (
        <span role="alert" className="mt-1 text-xs text-negative">
          내보내기 실패: {error}
        </span>
      ) : null}
    </span>
  );
}
