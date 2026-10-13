/**
 * 增量 JSON 扫描器。
 *
 * 目标：从「几百 MB 的单文件 JSON」里把 `messages` 数组逐条取出，而**绝不** JSON.parse 整个文件。
 *
 * 它不是一个通用 JSON 解析器，而是一个「带按键路由的流式读取器」：
 *
 *   const r = openJsonStream(file);
 *   await r.expectObjectStart();
 *   for (;;) {
 *     if (await r.atObjectEnd()) break;
 *     const key = await r.readStringValue();
 *     await r.expectChar(':');
 *     if (key === 'messages') {
 *       for await (const item of r.arrayItems()) { ... }   // 逐条 yield 原始 JSON 文本
 *     } else {
 *       await r.skipValue();                                // 其余成员整体跳过
 *     }
 *     await r.expectCommaOrObjectEnd();
 *   }
 *
 * 只做三件事：跳过空白、读/跳过一个值、按数组逐条 yield 元素原始文本。
 * 元素超过 `maxValueBytes` 时返回 `{ ok: false, reason: 'too-large' }`（内容仍被完整跳过、
 * 内存不增长），调用方据此计入「失败条目」，不会静默丢数据。
 */
import { createReadStream } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

/** 单个值的读取结果：`ok:false` 表示超过上限（已跳过，未解析）。 */
export type JsonValueResult =
  | { ok: true; raw: string }
  | { ok: false; reason: 'too-large'; bytes: number };

export interface JsonStreamReaderOptions {
  /** 单个值（一条消息对象）的累积上限，默认 32 MiB。 */
  maxValueBytes?: number;
  /** 读文件时的 highWaterMark，默认 64 KiB。 */
  highWaterMark?: number;
}

/** JSON 语法 / 结构错误。带上「已读取多少字符」便于定位坏文件。 */
export class JsonSyntaxError extends Error {
  readonly charsRead: number;
  constructor(message: string, charsRead: number) {
    super(`${message}（已读取约 ${charsRead} 字符）`);
    this.name = 'JsonSyntaxError';
    this.charsRead = charsRead;
  }
}

const WHITESPACE = new Set([' ', '\t', '\n', '\r']);

export class JsonStreamReader {
  private readonly iter: AsyncIterator<Uint8Array | string>;
  private readonly decoder = new StringDecoder('utf8');
  private readonly maxValueBytes: number;
  private buf = '';
  private pos = 0;
  private eof = false;
  private sawFirstChunk = false;
  /** 近似进度（字符数），只用于报错信息。 */
  charsRead = 0;

  constructor(source: AsyncIterable<Uint8Array | string>, opts: JsonStreamReaderOptions = {}) {
    this.iter = source[Symbol.asyncIterator]();
    this.maxValueBytes = opts.maxValueBytes ?? 32 * 1024 * 1024;
  }

  // ---------------------------------------------------------------- 缓冲区

  private async fill(): Promise<void> {
    this.buf = '';
    this.pos = 0;
    while (this.pos >= this.buf.length && !this.eof) {
      const next = await this.iter.next();
      if (next.done === true) {
        this.eof = true;
        const tail = this.decoder.end();
        if (tail.length > 0) {
          this.buf += tail;
          this.charsRead += tail.length;
        }
        break;
      }
      const value = next.value;
      let text: string;
      if (typeof value === 'string') text = value;
      else text = this.decoder.write(value);
      if (!this.sawFirstChunk) {
        this.sawFirstChunk = true;
        // 只剥掉文件最开头的 BOM，字符串中间出现的 U+FEFF 保留
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      }
      if (text.length > 0) {
        this.buf += text;
        this.charsRead += text.length;
      }
    }
  }

  private async ensureAvailable(): Promise<boolean> {
    if (this.pos < this.buf.length) return true;
    if (this.eof) return false;
    await this.fill();
    return this.pos < this.buf.length;
  }

  /** 查看下一字符但不消费；文件结束返回 null。 */
  async peek(): Promise<string | null> {
    if (!(await this.ensureAvailable())) return null;
    return this.buf[this.pos] ?? null;
  }

  private async take(): Promise<string | null> {
    if (!(await this.ensureAvailable())) return null;
    const ch = this.buf[this.pos];
    if (ch === undefined) return null;
    this.pos += 1;
    return ch;
  }

  /** 跳过空白，返回下一个非空白字符（不消费）。 */
  async skipWhitespace(): Promise<string | null> {
    for (;;) {
      const ch = await this.peek();
      if (ch === null) return null;
      if (WHITESPACE.has(ch)) {
        this.pos += 1;
        continue;
      }
      return ch;
    }
  }

  /**
   * 提前终止读取并释放底层流（用于「只读文件头」的场景，例如格式探测、会话信息预扫）。
   * 调用后本 reader 不可再用。
   */
  async close(): Promise<void> {
    this.eof = true;
    this.buf = '';
    this.pos = 0;
    const it = this.iter as AsyncIterator<Uint8Array | string> & {
      return?: (value?: unknown) => Promise<IteratorResult<Uint8Array | string>>;
    };
    if (typeof it.return === 'function') {
      try {
        await it.return();
      } catch {
        // 流可能已经自然结束，关闭失败不影响调用方
      }
    }
  }

  // ------------------------------------------------------------ 单字符断言

  async expectChar(expected: string): Promise<void> {
    const ch = await this.skipWhitespace();
    if (ch === null) throw new JsonSyntaxError(`JSON 意外结束：期望 ${expected}`, this.charsRead);
    if (ch !== expected) {
      throw new JsonSyntaxError(
        `JSON 语法错误：期望 ${expected}，实际 ${JSON.stringify(ch)}`,
        this.charsRead,
      );
    }
    this.pos += 1;
  }

  async expectObjectStart(): Promise<void> {
    await this.expectChar('{');
  }

  /** 若当前位置是 `}` 则消费它并返回 true，否则返回 false（不动位置）。 */
  async atObjectEnd(): Promise<boolean> {
    const ch = await this.skipWhitespace();
    if (ch === '}') {
      this.pos += 1;
      return true;
    }
    return false;
  }

  /** 对象成员之间：消费 `,` 并返回 'more'，消费 `}` 并返回 'end'，其它抛错。 */
  async commaOrObjectEnd(): Promise<'more' | 'end'> {
    const ch = await this.skipWhitespace();
    if (ch === ',') {
      this.pos += 1;
      return 'more';
    }
    if (ch === '}') {
      this.pos += 1;
      return 'end';
    }
    throw new JsonSyntaxError(
      `JSON 对象语法错误：期望 , 或 }，实际 ${JSON.stringify(ch)}`,
      this.charsRead,
    );
  }

  // ------------------------------------------------------------------ 值

  private async skipStringBody(): Promise<void> {
    // 开引号已被消费
    for (;;) {
      const ch = await this.take();
      if (ch === null) throw new JsonSyntaxError('JSON 字符串未闭合', this.charsRead);
      if (ch === '\\') {
        const esc = await this.take();
        if (esc === null) throw new JsonSyntaxError('JSON 字符串未闭合', this.charsRead);
        continue;
      }
      if (ch === '"') return;
    }
  }

  private async skipComposite(): Promise<void> {
    let depth = 0;
    for (;;) {
      const ch = await this.take();
      if (ch === null) throw new JsonSyntaxError('JSON 容器未闭合', this.charsRead);
      if (ch === '"') {
        await this.skipStringBody();
        continue;
      }
      if (ch === '{' || ch === '[') depth += 1;
      else if (ch === '}' || ch === ']') {
        depth -= 1;
        if (depth === 0) return;
      }
    }
  }

  private async skipScalar(): Promise<void> {
    for (;;) {
      const ch = await this.peek();
      if (ch === null) return;
      if (ch === ',' || ch === '}' || ch === ']' || WHITESPACE.has(ch)) return;
      this.pos += 1;
    }
  }

  /** 跳过一个完整的 JSON 值（含嵌套容器与字符串）。 */
  async skipValue(): Promise<void> {
    const ch = await this.skipWhitespace();
    if (ch === null) throw new JsonSyntaxError('JSON 意外结束：期望一个值', this.charsRead);
    if (ch === '"') {
      this.pos += 1;
      await this.skipStringBody();
      return;
    }
    if (ch === '{' || ch === '[') {
      await this.skipComposite();
      return;
    }
    await this.skipScalar();
  }

  private async readStringRaw(limit: number): Promise<JsonValueResult> {
    // 当前 pos 指向开引号
    let bytes = 0;
    let raw = '';
    let tooLarge = false;
    const push = (text: string): void => {
      if (tooLarge) return;
      if (raw.length + text.length > limit) {
        tooLarge = true;
        raw = '';
        return;
      }
      raw += text;
    };
    push('"');
    bytes += 1;
    this.pos += 1;
    for (;;) {
      const ch = await this.take();
      if (ch === null) throw new JsonSyntaxError('JSON 字符串未闭合', this.charsRead);
      bytes += 1;
      push(ch);
      if (ch === '\\') {
        const esc = await this.take();
        if (esc === null) throw new JsonSyntaxError('JSON 字符串未闭合', this.charsRead);
        bytes += 1;
        push(esc);
        continue;
      }
      if (ch === '"') break;
    }
    if (tooLarge) return { ok: false, reason: 'too-large', bytes };
    return { ok: true, raw };
  }

  private async readCompositeRaw(limit: number): Promise<JsonValueResult> {
    let bytes = 0;
    let raw = '';
    let tooLarge = false;
    let depth = 0;
    const push = (text: string): void => {
      if (tooLarge) return;
      if (raw.length + text.length > limit) {
        tooLarge = true;
        raw = '';
        return;
      }
      raw += text;
    };
    for (;;) {
      const ch = await this.take();
      if (ch === null) throw new JsonSyntaxError('JSON 容器未闭合', this.charsRead);
      bytes += 1;
      push(ch);
      if (ch === '"') {
        for (;;) {
          const inner = await this.take();
          if (inner === null) throw new JsonSyntaxError('JSON 字符串未闭合', this.charsRead);
          bytes += 1;
          push(inner);
          if (inner === '\\') {
            const esc = await this.take();
            if (esc === null) throw new JsonSyntaxError('JSON 字符串未闭合', this.charsRead);
            bytes += 1;
            push(esc);
            continue;
          }
          if (inner === '"') break;
        }
        continue;
      }
      if (ch === '{' || ch === '[') depth += 1;
      else if (ch === '}' || ch === ']') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (tooLarge) return { ok: false, reason: 'too-large', bytes };
    return { ok: true, raw };
  }

  /**
   * 读取一个完整 JSON 值的原始文本（含引号/括号），不解析。
   * 超过 `limit` 时不再累积但仍完整跳过。
   */
  async readValueRaw(limit: number = this.maxValueBytes): Promise<JsonValueResult> {
    const ch = await this.skipWhitespace();
    if (ch === null) throw new JsonSyntaxError('JSON 意外结束：期望一个值', this.charsRead);
    if (ch === '"') return this.readStringRaw(limit);
    if (ch === '{' || ch === '[') return this.readCompositeRaw(limit);
    let bytes = 0;
    let raw = '';
    let tooLarge = false;
    for (;;) {
      const c = await this.peek();
      if (c === null) break;
      if (c === ',' || c === '}' || c === ']' || WHITESPACE.has(c)) break;
      this.pos += 1;
      bytes += 1;
      if (tooLarge) continue;
      if (raw.length + 1 > limit) {
        tooLarge = true;
        raw = '';
        continue;
      }
      raw += c;
    }
    if (tooLarge) return { ok: false, reason: 'too-large', bytes };
    return { ok: true, raw };
  }

  /** 解析一个值（小对象 / 字符串 / 数字），常用于 metadata、chatInfo。 */
  async readJson<T = unknown>(limit: number = this.maxValueBytes): Promise<T> {
    const res = await this.readValueRaw(limit);
    if (!res.ok) throw new JsonSyntaxError(`JSON 值超过 ${limit} 字节上限`, this.charsRead);
    try {
      return JSON.parse(res.raw) as T;
    } catch (err) {
      throw new JsonSyntaxError(
        `JSON 解析失败：${err instanceof Error ? err.message : String(err)}`,
        this.charsRead,
      );
    }
  }

  /** 读取对象键（必须是字符串）。 */
  async readStringValue(limit: number = this.maxValueBytes): Promise<string> {
    const ch = await this.skipWhitespace();
    if (ch !== '"') {
      throw new JsonSyntaxError(
        `JSON 对象语法错误：期望字符串键，实际 ${JSON.stringify(ch)}`,
        this.charsRead,
      );
    }
    const res = await this.readStringRaw(limit);
    if (!res.ok) throw new JsonSyntaxError('JSON 键超长', this.charsRead);
    const value: unknown = JSON.parse(res.raw);
    if (typeof value !== 'string') throw new JsonSyntaxError('JSON 键不是字符串', this.charsRead);
    return value;
  }

  /**
   * 逐条 yield 数组元素的原始 JSON 文本。
   * 必须在 `expectChar('[')` 之前调用方已读到 `[` 的位置（本方法自己消费 `[`）。
   */
  async *arrayItems(limit: number = this.maxValueBytes): AsyncGenerator<JsonValueResult> {
    await this.expectChar('[');
    const first = await this.skipWhitespace();
    if (first === ']') {
      this.pos += 1;
      return;
    }
    if (first === null) throw new JsonSyntaxError('JSON 数组未闭合', this.charsRead);
    for (;;) {
      yield await this.readValueRaw(limit);
      const ch = await this.skipWhitespace();
      if (ch === ',') {
        this.pos += 1;
        continue;
      }
      if (ch === ']') {
        this.pos += 1;
        return;
      }
      throw new JsonSyntaxError(
        `JSON 数组语法错误：期望 , 或 ]，实际 ${JSON.stringify(ch)}`,
        this.charsRead,
      );
    }
  }
}

/** 把文件路径包成字节流（供 {@link JsonStreamReader} 使用）。 */
export function fileByteStream(filePath: string, highWaterMark = 64 * 1024): AsyncIterable<Uint8Array> {
  return createReadStream(filePath, { highWaterMark });
}

export function openJsonStream(
  filePath: string,
  opts: JsonStreamReaderOptions = {},
): JsonStreamReader {
  return new JsonStreamReader(fileByteStream(filePath, opts.highWaterMark), opts);
}

/** 文件的按行异步迭代（JSONL / TXT 共用）。 */
export function fileLineStream(
  filePath: string,
  highWaterMark = 64 * 1024,
): AsyncGenerator<string> {
  return iterLines(fileByteStream(filePath, highWaterMark));
}

/** 供文本导读器复用：按行异步迭代（保留换行符语义由调用方决定）。 */
export async function* iterLines(
  source: AsyncIterable<Uint8Array | string>,
): AsyncGenerator<string> {
  const decoder = new StringDecoder('utf8');
  let rest = '';
  let first = true;
  for await (const chunk of source) {
    let text: string;
    if (typeof chunk === 'string') text = chunk;
    else text = decoder.write(chunk);
    if (first) {
      first = false;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    rest += text;
    let idx = rest.indexOf('\n');
    while (idx >= 0) {
      let line = rest.slice(0, idx);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      yield line;
      rest = rest.slice(idx + 1);
      idx = rest.indexOf('\n');
    }
  }
  if (rest.length > 0) {
    if (rest.endsWith('\r')) rest = rest.slice(0, -1);
    yield rest;
  }
  const tail = decoder.end();
  if (tail.length > 0) yield tail;
}
