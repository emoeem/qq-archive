/**
 * 静态前端托管：只从 `<repoRoot>/web` 提供服务。
 *
 * - 未知的**无扩展名**路径回退到 `web/index.html`（SPA）；
 * - 带扩展名但找不到的文件返回 404（避免把 favicon 之类请求变成 HTML）；
 * - 所有路径都做 resolve + 前缀校验，越界一律 400，绝不触碰 web/ 之外的仓库文件。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { HttpError, applySecurityHeaders, mimeForPath, sendJson } from './http.ts';
import { withinRoot } from './media.ts';
import type { RequestContext } from './router.ts';

export interface StaticOptions {
  webRoot: string;
}

export function serveStatic(ctx: RequestContext, opts: StaticOptions): void {
  const { res } = ctx;
  applySecurityHeaders(res);
  let decoded: string;
  try {
    decoded = decodeURIComponent(ctx.pathname);
  } catch {
    throw new HttpError(400, 'BAD_REQUEST', '路径编码非法');
  }
  if (decoded.includes('\0')) throw new HttpError(400, 'BAD_REQUEST', '路径含非法字符');
  const webRoot = resolve(opts.webRoot);
  const rel = decoded.replace(/^\/+/, '');
  const target = resolve(webRoot, rel === '' ? 'index.html' : rel);
  if (!withinRoot(webRoot, target)) throw new HttpError(400, 'BAD_REQUEST', '路径越界');

  const indexFile = resolve(webRoot, 'index.html');
  let file: string | null = null;
  if (isFile(target)) file = target;
  else if (!/\.[A-Za-z0-9]{1,8}$/.test(rel) && isFile(indexFile)) file = indexFile;

  if (!file) {
    sendJson(res, 404, { error: '静态资源不存在（web/ 未部署？）', code: 'NOT_FOUND' });
    return;
  }
  const body = readFileSync(file);
  const st = statSync(file);
  const cache = file === indexFile ? 'no-cache' : 'public, max-age=300';
  res.writeHead(200, {
    'Content-Type': mimeForPath(file) ?? 'application/octet-stream',
    'Content-Length': String(body.length),
    'Cache-Control': cache,
    'Last-Modified': st.mtime.toUTCString(),
  });
  if (ctx.method === 'HEAD') res.end();
  else res.end(body);
}

function isFile(p: string): boolean {
  if (!existsSync(p)) return false;
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
