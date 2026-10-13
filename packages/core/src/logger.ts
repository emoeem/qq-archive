/**
 * 结构化日志 + 轮转。
 *
 *  - 控制台输出人类可读行；文件输出 JSONL（每行一个对象），便于长期归档与检索。
 *  - 单文件超过 maxBytes 自动轮转，保留 keep 个历史文件（`.1`、`.2`…）。
 *  - `dbSink` 可选：把 warn/error 及以上同时写入数据库 logs 表，供归档管理页展示。
 *  - 所有日志都会做**敏感信息脱敏**（token / password / sk- 密钥 / 二维码 base64）。
 */

import { existsSync, mkdirSync, renameSync, statSync, createWriteStream, type WriteStream } from 'node:fs';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type DbLogSink = (entry: {
  level: LogLevel;
  scope: string;
  message: string;
  data?: unknown;
}) => void;

export interface LoggerOptions {
  level?: LogLevel;
  /** 日志目录；为空则只输出到控制台。 */
  dir?: string;
  file?: string;
  maxBytes?: number;
  keep?: number;
  dbSink?: DbLogSink;
  /** 是否输出到控制台（测试时可关闭）。 */
  console?: boolean;
}

/** 脱敏：把常见密钥形态替换为 `<redacted>`。 */
export function redact(value: string): string {
  return value
    .replace(/(sk-[A-Za-z0-9_-]{8,})/g, '<redacted-key>')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1<redacted>')
    .replace(/("?(?:token|password|passwd|secret|authorization|access_token|refresh_token)"?\s*[:=]\s*"?)([^",\s}]{6,})/gi, '$1<redacted>')
    .replace(/(data:image\/[a-z]+;base64,)[A-Za-z0-9+/=]{40,}/gi, '$1<redacted-base64>');
}

function redactValue(v: unknown, depth = 0): unknown {
  if (depth > 4) return '<deep>';
  if (typeof v === 'string') return redact(v);
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => redactValue(x, depth + 1));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = /token|password|secret|authorization/i.test(k) ? '<redacted>' : redactValue(val, depth + 1);
    }
    return out;
  }
  return v;
}

export class Logger {
  private level: LogLevel;
  private dir?: string;
  private file: string;
  private maxBytes: number;
  private keep: number;
  private dbSink?: DbLogSink;
  private toConsole: boolean;
  private bytesWritten = 0;
  private fh?: WriteStream;

  constructor(opts: LoggerOptions = {}) {
    this.level = opts.level ?? 'info';
    this.dir = opts.dir;
    this.file = opts.file ?? 'archive.log';
    this.maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;
    this.keep = opts.keep ?? 5;
    this.dbSink = opts.dbSink;
    this.toConsole = opts.console ?? true;
  }

  child(scope: string): ScopedLogger {
    return new ScopedLogger(this, scope);
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  /** 打开文件句柄（可选）。失败不致命，退回控制台。 */
  open(): void {
    if (!this.dir) return;
    try {
      mkdirSync(this.dir, { recursive: true });
      const p = `${this.dir}/${this.file}`;
      this.bytesWritten = existsSync(p) ? statSync(p).size : 0;
      this.fh = createWriteStream(p, { flags: 'a' });
    } catch {
      this.fh = undefined;
    }
  }

  close(): Promise<void> {
    return new Promise((res) => {
      if (!this.fh) return res();
      const fh = this.fh;
      this.fh = undefined;
      fh.end(() => res());
    });
  }

  private rotateIfNeeded(nextBytes: number): void {
    if (!this.dir || nextBytes <= this.maxBytes) return;
    try {
      const p = `${this.dir}/${this.file}`;
      this.fh?.end();
      this.fh = undefined;
      for (let i = this.keep - 1; i >= 1; i--) {
        const from = `${p}.${i}`;
        const to = `${p}.${i + 1}`;
        if (existsSync(from)) renameSync(from, to);
      }
      if (existsSync(p)) renameSync(p, `${p}.1`);
      this.bytesWritten = 0;
      this.fh = createWriteStream(p, { flags: 'a' });
    } catch {
      /* 轮转失败不阻塞业务 */
    }
  }

  log(level: LogLevel, scope: string, message: string, data?: unknown): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const ts = new Date().toISOString();
    const safeMessage = redact(message);
    const safeData = data === undefined ? undefined : redactValue(data);
    if (this.toConsole) {
      const line = `${ts.slice(11, 23)} ${level.toUpperCase().padEnd(5)} [${scope}] ${safeMessage}${
        safeData === undefined ? '' : ` ${safeJson(safeData)}`
      }`;
      if (level === 'error') process.stderr.write(`${line}\n`);
      else process.stdout.write(`${line}\n`);
    }
    if (this.fh) {
      const json = `${safeJson({ ts, level, scope, message: safeMessage, ...(safeData === undefined ? {} : { data: safeData }) })}\n`;
      this.rotateIfNeeded(this.bytesWritten + Buffer.byteLength(json));
      this.fh.write(json);
      this.bytesWritten += Buffer.byteLength(json);
    }
    if (this.dbSink && (level === 'warn' || level === 'error')) {
      try {
        this.dbSink({ level, scope, message: safeMessage, data: safeData });
      } catch {
        /* sink 失败不能影响主流程 */
      }
    }
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return '"[unserializable]"';
  }
}

export class ScopedLogger {
  private root: Logger;
  private scope: string;

  constructor(root: Logger, scope: string) {
    this.root = root;
    this.scope = scope;
  }
  /** 派生子作用域（`log.child('media')`），便于调用方在被依赖模块里继续细分。 */
  child(scope: string): ScopedLogger {
    return new ScopedLogger(this.root, `${this.scope}.${scope}`);
  }
  debug(msg: string, data?: unknown): void {
    this.root.log('debug', this.scope, msg, data);
  }
  info(msg: string, data?: unknown): void {
    this.root.log('info', this.scope, msg, data);
  }
  warn(msg: string, data?: unknown): void {
    this.root.log('warn', this.scope, msg, data);
  }
  error(msg: string, data?: unknown): void {
    this.root.log('error', this.scope, msg, data);
  }
  /** 记录一次失败并附带错误对象。 */
  fail(msg: string, err: unknown, data?: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    this.root.log('error', this.scope, `${msg}: ${message}`, { ...(data as object), stack });
  }
}

/** 创建一个默认 logger（控制台 + 可选文件）。 */
export function createLogger(opts: LoggerOptions = {}): Logger {
  const l = new Logger(opts);
  l.open();
  return l;
}
