/**
 * HTTP 基础设施：安全响应头、统一 JSON 响应、请求体读取、查询参数解析、Range 解析。
 *
 * 约定（见 docs/ARCHITECTURE.md 第 6 节）：
 *  - 成功 `200 {"data": ...}`；错误 `4xx/5xx {"error": "...", "code": "..."}`。
 *  - 所有响应都带安全头（nosniff / DENY / no-referrer / CSP）。
 *  - 请求体上限固定，超限 413，JSON 非法 400。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname } from 'node:path';
import { AppError } from '../../core/src/errors.ts';
import type { ScopedLogger } from '../../core/src/logger.ts';

/** 请求体上限（1 MiB）。 */
export const MAX_BODY_BYTES = 1024 * 1024;
/** 超过该字节数直接断开连接（防止恶意超大请求把内存/带宽打满）。 */
export const BODY_DRAIN_LIMIT = 16 * 1024 * 1024;

/** 带自定义 HTTP 状态码的错误（AppError 的 code→status 映射不覆盖 405/413/416 等）。 */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

/**
 * 安全响应头。
 *
 * CSP 以 `default-src 'self'` 为基线（契约要求），并显式放开前端确实需要的同源能力：
 * 内联 style 属性、data:/blob: 图片与媒体、EventSource 的 connect-src。
 */
export function securityHeaders(): Record<string, string> {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; " +
      "style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; " +
      "object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  };
}

/** 把安全头写入响应（在 writeHead 之前调用，writeHead 的同名头会覆盖）。 */
export function applySecurityHeaders(res: ServerResponse): void {
  for (const [k, v] of Object.entries(securityHeaders())) res.setHeader(k, v);
}

/** 统一成功响应 `{"data": ...}`。 */
export function sendJson(res: ServerResponse, status: number, payload: unknown, extra: Record<string, string> = {}): void {
  const body = Buffer.from(JSON.stringify(payload ?? null), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
    ...extra,
  });
  if (res.req?.method === 'HEAD') res.end();
  else res.end(body);
}

/** 统一成功包装。 */
export function sendData(res: ServerResponse, data: unknown, status = 200, extra: Record<string, string> = {}): void {
  sendJson(res, status, { data }, extra);
}

/** 统一错误响应；返回最终状态码（便于日志）。 */
export function sendError(res: ServerResponse, err: unknown, logger?: ScopedLogger): number {
  let status = 500;
  let body: Record<string, unknown> = { error: '内部错误', code: 'INTERNAL' };
  if (err instanceof AppError) {
    status = err.status;
    body = err.toJSON();
  } else if (err instanceof HttpError) {
    status = err.status;
    body = { error: err.message, code: err.code };
  } else {
    logger?.fail('未处理的服务端异常', err);
  }
  if (res.headersSent) {
    res.destroy();
    return status;
  }
  const extra: Record<string, string> = {};
  if (status === 401) extra['WWW-Authenticate'] = 'Bearer realm="qqarchive"';
  sendJson(res, status, body, extra);
  return status;
}

/** 读取并解析 JSON 请求体；超限 413，非对象/非法 JSON 400。 */
export async function readJsonBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  // 超限后仍然把请求体读完（最多到 BODY_DRAIN_LIMIT），这样响应能正常发回给客户端而不是 RST。
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size <= limit) chunks.push(buf);
    else tooLarge = true;
    if (size > BODY_DRAIN_LIMIT) {
      req.destroy();
      throw new HttpError(413, 'PAYLOAD_TOO_LARGE', `请求体超过上限 ${limit} 字节`);
    }
  }
  if (tooLarge) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', `请求体超过上限 ${limit} 字节`);
  if (size === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'BAD_REQUEST', '请求体不是合法的 JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'BAD_REQUEST', '请求体必须是 JSON 对象');
  }
  return parsed as Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* 查询参数                                                            */
/* ------------------------------------------------------------------ */

export function rawQuery(url: URL, name: string): string | undefined {
  const v = url.searchParams.get(name);
  if (v === null) return undefined;
  const t = v.trim();
  return t === '' ? undefined : t;
}

export function strQuery(url: URL, name: string, maxLen = 200): string | undefined {
  const v = rawQuery(url, name);
  if (v === undefined) return undefined;
  if (v.length > maxLen) throw new HttpError(400, 'BAD_REQUEST', `参数 ${name} 过长`);
  return v;
}

export function intQuery(
  url: URL,
  name: string,
  opts: { min?: number; max?: number; def?: number } = {},
): number | undefined {
  const raw = rawQuery(url, name);
  if (raw === undefined) return opts.def;
  if (!/^-?\d+$/.test(raw)) throw new HttpError(400, 'BAD_REQUEST', `参数 ${name} 必须是整数`);
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) throw new HttpError(400, 'BAD_REQUEST', `参数 ${name} 超出范围`);
  if (opts.min !== undefined && n < opts.min) throw new HttpError(400, 'BAD_REQUEST', `参数 ${name} 不得小于 ${opts.min}`);
  if (opts.max !== undefined && n > opts.max) throw new HttpError(400, 'BAD_REQUEST', `参数 ${name} 不得大于 ${opts.max}`);
  return n;
}

export function enumQuery<T extends string>(url: URL, name: string, allowed: readonly T[]): T | undefined {
  const raw = rawQuery(url, name);
  if (raw === undefined) return undefined;
  if (!allowed.includes(raw as T)) {
    throw new HttpError(400, 'BAD_REQUEST', `参数 ${name} 非法（允许：${allowed.join('/')}）`);
  }
  return raw as T;
}

export function boolValue(v: unknown, def = false): boolean {
  if (v === undefined || v === null) return def;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return /^(1|true|yes|on)$/i.test(v);
  if (typeof v === 'number') return v !== 0;
  return def;
}

/** 路径参数（`:id`）解析为正整数。 */
export function intParam(params: Record<string, string>, name = 'id'): number {
  const raw = params[name];
  if (raw === undefined || raw === '') throw new HttpError(400, 'BAD_REQUEST', `缺少路径参数 ${name}`);
  if (!/^\d+$/.test(raw)) throw new HttpError(400, 'BAD_REQUEST', `路径参数 ${name} 必须是正整数`);
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) throw new HttpError(400, 'BAD_REQUEST', `路径参数 ${name} 超出范围`);
  return n;
}

/* ------------------------------------------------------------------ */
/* Range                                                               */
/* ------------------------------------------------------------------ */

export interface ByteRange {
  start: number;
  end: number;
}

/**
 * 解析单段 `Range` 头。
 *  - 返回 null：忽略 Range，按 200 完整响应（无 Range / 多段 Range）。
 *  - 返回 'unsatisfiable'：返回 416。
 */
export function parseRange(header: string | undefined, size: number): ByteRange | 'unsatisfiable' | null {
  if (!header) return null;
  const m = /^bytes=(.*)$/i.exec(header.trim());
  if (!m || m[1] === undefined) return null;
  const spec = m[1].trim();
  if (spec === '' || spec.includes(',')) return null; // 多段不支持：按完整响应处理
  const parts = spec.split('-');
  if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) return null;
  const [, endRaw] = parts;
  const startRaw = parts[0];
  if (size === 0) return 'unsatisfiable';
  if (startRaw === '') {
    // 后缀范围：bytes=-N
    const suffix = Number(endRaw);
    if (!Number.isInteger(suffix) || suffix <= 0) return 'unsatisfiable';
    const start = Math.max(0, size - suffix);
    return { start, end: size - 1 };
  }
  const start = Number(startRaw);
  if (!Number.isInteger(start) || start < 0 || start >= size) return 'unsatisfiable';
  const end = endRaw === '' ? size - 1 : Math.min(Number(endRaw), size - 1);
  if (!Number.isInteger(end) || end < start) return 'unsatisfiable';
  return { start, end };
}

/** 计算 Range 覆盖的字节数。 */
export function rangeLength(r: ByteRange): number {
  return r.end - r.start + 1;
}

/* ------------------------------------------------------------------ */
/* MIME                                                                */
/* ------------------------------------------------------------------ */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.amr': 'audio/amr',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

/** 按扩展名推断 MIME；未知返回 null。 */
export function mimeForPath(p: string): string | null {
  return MIME[extname(p).toLowerCase()] ?? null;
}

/** Content-Disposition 头；文件名做安全处理并同时给出 ASCII 与 UTF-8 形式。 */
export function contentDisposition(kind: 'inline' | 'attachment', filename: string): string {
  const name = filename.replace(/["\\\r\n]/g, '_').slice(0, 180) || 'file';
  const ascii = name.replace(/[^\x20-\x7e]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
