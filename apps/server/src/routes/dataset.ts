/**
 * The compact dataset (the same `dataset.json` the web app loads), served from memory with gzip.
 * Used by GET /api/v1/dataset and GET /data/dataset.json. OWNER: server.
 */
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import type { Context } from 'hono';
import type { CompactDataset } from '@vti/core';

const gzipAsync = promisify(gzip);

/** What the host hands the app: the parsed compact dataset, its JSON text, or the raw file bytes. */
export type CompactSource = CompactDataset | string | Uint8Array;

export interface EncodedDataset {
  raw: Buffer;
  gzip: Buffer;
}

/**
 * Serialized + gzipped dataset, computed once per source object (single-slot cache: the host swaps the source
 * when a new export is loaded). gzip runs on the libuv thread pool, so it does not block requests.
 */
export class DatasetEncoder {
  private src: CompactSource | null = null;
  private pending: Promise<EncodedDataset> | null = null;

  encode(src: CompactSource): Promise<EncodedDataset> {
    if (src === this.src && this.pending) return this.pending;
    this.src = src;
    const raw = typeof src === 'string' ? Buffer.from(src, 'utf8') : src instanceof Uint8Array ? Buffer.from(src.buffer, src.byteOffset, src.byteLength) : Buffer.from(JSON.stringify(src), 'utf8');
    const p = gzipAsync(raw, { level: 6 }).then((gz) => ({ raw, gzip: gz }));
    // Do not keep a failed promise around.
    p.catch(() => {
      if (this.pending === p) {
        this.pending = null;
        this.src = null;
      }
    });
    this.pending = p;
    return p;
  }
}

/** True when Accept-Encoding allows gzip (explicitly or via `*`) with q > 0. */
export function acceptsGzip(c: Context): boolean {
  const ae = c.req.header('accept-encoding');
  if (!ae) return false;
  let gzipQ: number | null = null;
  let starQ: number | null = null;
  for (const part of ae.split(',')) {
    const [name, ...params] = part.trim().split(';');
    let q = 1;
    for (const prm of params) {
      const m = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(prm);
      if (m) q = Number(m[1]);
    }
    const n = name.trim().toLowerCase();
    if (n === 'gzip' || n === 'x-gzip') gzipQ = q;
    else if (n === '*') starQ = q;
  }
  const q = gzipQ ?? starQ ?? 0;
  return q > 0;
}

/** Response for the encoded dataset (HEAD: headers only). */
export function datasetResponse(c: Context, enc: EncodedDataset, headers: Record<string, string>): Response {
  const gz = acceptsGzip(c);
  const body = gz ? enc.gzip : enc.raw;
  const h: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.byteLength),
    Vary: 'Accept-Encoding',
    ...headers,
  };
  if (gz) h['Content-Encoding'] = 'gzip';
  if (c.req.method === 'HEAD') return new Response(null, { status: 200, headers: h });
  return new Response(new Uint8Array(body.buffer as ArrayBuffer, body.byteOffset, body.byteLength), { status: 200, headers: h });
}
