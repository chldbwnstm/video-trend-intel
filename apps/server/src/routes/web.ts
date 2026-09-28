/**
 * Static file serving for the web build (apps/web/dist: index.html + hashed assets; HashRouter, so no
 * server-side routes) and the data files under /data. OWNER: server.
 *
 * - Paths are resolved inside the root only (no `..`, no dotfiles, no backslashes / NUL).
 * - Files are cached in memory and revalidated with fs.stat (mtime + size) on every request.
 * - index.html gets a Content-Security-Policy whose script-src hashes the page's inline scripts.
 */
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import type { Context } from 'hono';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

export function mimeOf(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

/** Resolve a URL path inside `root`; null when it would escape the root or touches a dotfile. */
export function safeJoin(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const parts = decoded.split('/').filter((s) => s !== '');
  if (parts.some((s) => s === '..' || s === '.' || s.startsWith('.'))) return null;
  const base = resolve(root);
  const full = resolve(base, ...parts);
  if (full !== base && !full.startsWith(base + sep)) return null;
  return full;
}

interface CachedFile {
  mtimeMs: number;
  size: number;
  body: Buffer;
  etag: string;
  csp: string | null;
}

/** CSP for the SPA shell: same-origin scripts + the page's own inline scripts (hashed), Pretendard CDN. */
export function htmlCsp(html: string): string {
  const hashes: string[] = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m[1].trim()) hashes.push(`'sha256-${createHash('sha256').update(m[1], 'utf8').digest('base64')}'`);
  }
  return [
    "default-src 'self'",
    `script-src 'self'${hashes.length ? ` ${hashes.join(' ')}` : ''}`,
    "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
    "font-src 'self' data: https://cdn.jsdelivr.net",
    "img-src 'self' data: blob: https:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export class StaticFiles {
  private readonly cache = new Map<string, CachedFile>();
  private cacheBytes = 0;
  constructor(readonly maxCacheBytes = 64_000_000) {}

  private async load(full: string): Promise<CachedFile | null> {
    let st;
    try {
      st = await stat(full);
    } catch {
      return null;
    }
    if (!st.isFile()) return null;
    const hit = this.cache.get(full);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit;
    const body = await readFile(full);
    const etag = `W/"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
    const csp = extname(full).toLowerCase() === '.html' ? htmlCsp(body.toString('utf8')) : null;
    const entry: CachedFile = { mtimeMs: st.mtimeMs, size: st.size, body, etag, csp };
    if (hit) {
      this.cache.delete(full);
      this.cacheBytes -= hit.size;
    }
    if (body.byteLength <= 8_000_000 && this.cacheBytes + body.byteLength <= this.maxCacheBytes) {
      this.cache.set(full, entry);
      this.cacheBytes += body.byteLength;
    }
    return entry;
  }

  /**
   * Serve `urlPath` from `root`; null when the file does not exist (caller decides what to do).
   * `cacheControl` defaults by path: hashed /assets/* immutable, everything else revalidated.
   */
  async serve(c: Context, root: string | null | undefined, urlPath: string, cacheControl?: string): Promise<Response | null> {
    if (!root) return null;
    const full = safeJoin(root, urlPath);
    if (!full) return null;
    const f = await this.load(full);
    if (!f) return null;
    const cc = cacheControl ?? (urlPath.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
    const headers: Record<string, string> = { 'Content-Type': mimeOf(full), ETag: f.etag, 'Cache-Control': cc };
    if (f.csp) headers['Content-Security-Policy'] = f.csp;
    if (etagMatches(c.req.header('if-none-match'), f.etag)) return new Response(null, { status: 304, headers });
    headers['Content-Length'] = String(f.body.byteLength);
    if (c.req.method === 'HEAD') return new Response(null, { status: 200, headers });
    return new Response(new Uint8Array(f.body.buffer as ArrayBuffer, f.body.byteOffset, f.body.byteLength), { status: 200, headers });
  }
}

/** If-None-Match comparison (weak comparison, `*` matches). */
export function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  const strip = (t: string) => t.trim().replace(/^W\//, '');
  const target = strip(etag);
  return header.split(',').some((t) => t.trim() === '*' || strip(t) === target);
}

