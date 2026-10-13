/**
 * 共享错误类型。所有对外错误都带一个稳定的 `code`，便于 API 层映射 HTTP 状态码、
 * 也便于测试断言（不依赖错误文案）。
 */

export type AppErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'UNSUPPORTED_FORMAT'
  | 'MEDIA_MISSING'
  | 'MEDIA_CORRUPT'
  | 'STORAGE_FULL'
  | 'COLLECTOR_UNAVAILABLE'
  | 'INTERNAL';

const STATUS: Record<AppErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  UNSUPPORTED_FORMAT: 415,
  MEDIA_MISSING: 410,
  MEDIA_CORRUPT: 422,
  STORAGE_FULL: 507,
  COLLECTOR_UNAVAILABLE: 503,
  INTERNAL: 500,
};

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: AppErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
  }

  toJSON(): { error: string; code: AppErrorCode; details?: unknown } {
    return { error: this.message, code: this.code, ...(this.details === undefined ? {} : { details: this.details }) };
  }
}

export const badRequest = (m: string, d?: unknown) => new AppError('BAD_REQUEST', m, d);
export const unauthorized = (m = '未认证') => new AppError('UNAUTHORIZED', m);
export const forbidden = (m = '无权限') => new AppError('FORBIDDEN', m);
export const notFound = (m = '资源不存在') => new AppError('NOT_FOUND', m);
export const unsupportedFormat = (m: string) => new AppError('UNSUPPORTED_FORMAT', m);
export const mediaMissing = (m: string) => new AppError('MEDIA_MISSING', m);
export const mediaCorrupt = (m: string) => new AppError('MEDIA_CORRUPT', m);
export const collectorUnavailable = (m: string) => new AppError('COLLECTOR_UNAVAILABLE', m);
export const internal = (m: string, d?: unknown) => new AppError('INTERNAL', m, d);
