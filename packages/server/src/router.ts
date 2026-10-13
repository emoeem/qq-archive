/**
 * 极简路由：精确段匹配 + `:param` 参数捕获。
 *
 * 语义：
 *  - method + path 都匹配 → 命中；
 *  - path 匹配但 method 不匹配 → 返回允许的方法列表（上层回 405 + Allow）；
 *  - 都不匹配 → null（上层回 404，或落到静态托管）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  method: string;
  pathname: string;
  params: Record<string, string>;
}

export type Handler = (ctx: RequestContext) => Promise<void> | void;

export interface RouteOptions {
  /** 不需要认证（/api/health、/api/auth/login 等）。 */
  public?: boolean;
  /** 允许 `?access=<token>` 作为认证凭据（媒体流 / SSE / 导出，浏览器无法设置请求头）。 */
  queryAuth?: boolean;
}

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
  public: boolean;
  queryAuth: boolean;
}

export interface MatchRoute {
  route: Route;
  params: Record<string, string>;
}

export interface MatchMethods {
  allow: string[];
}

function splitPath(pathname: string): string[] {
  return pathname.split('/').filter((s) => s.length > 0);
}

function safeDecode(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

export class Router {
  private routes: Route[] = [];

  add(method: string, path: string, handler: Handler, opts: RouteOptions = {}): void {
    this.routes.push({
      method: method.toUpperCase(),
      segments: splitPath(path),
      handler,
      public: opts.public === true,
      queryAuth: opts.queryAuth === true,
    });
  }

  /** path 命中时返回所有已注册方法（用于 405/OPTIONS 的 Allow 头）。 */
  methodsFor(pathname: string): string[] {
    const segs = splitPath(pathname);
    const out = new Set<string>();
    for (const r of this.routes) {
      if (sameShape(r.segments, segs)) out.add(r.method);
    }
    return [...out].sort();
  }

  match(method: string, pathname: string): MatchRoute | MatchMethods | null {
    const segs = splitPath(pathname);
    const want = method.toUpperCase();
    const allow = new Set<string>();
    for (const r of this.routes) {
      if (r.segments.length !== segs.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < r.segments.length; i++) {
        const pat = r.segments[i]!;
        const got = segs[i]!;
        if (pat.startsWith(':')) {
          if (got === '') {
            ok = false;
            break;
          }
          params[pat.slice(1)] = safeDecode(got);
        } else if (pat !== got) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      allow.add(r.method);
      if (r.method === want) return { route: r, params };
    }
    if (allow.size > 0) return { allow: [...allow].sort() };
    return null;
  }
}

function sameShape(pattern: string[], segs: string[]): boolean {
  if (pattern.length !== segs.length) return false;
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i]!;
    const s = segs[i]!;
    if (p.startsWith(':')) {
      if (s === '') return false;
    } else if (p !== s) {
      return false;
    }
  }
  return true;
}
