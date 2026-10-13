/**
 * 导出文件格式探测。
 *
 * 判定只看**文件头**（默认 64 KiB），因此对大文件是常数成本。判定依据（按优先级）：
 *
 *  1. 文件头整段能 `JSON.parse` → 单个 JSON 文档：含 `messages` 数组 → `qce-json`；
 *     单个 QCE 消息对象 → `qce-jsonl`；单个归一化消息对象 → `generic-jsonl`。
 *  2. 否则看**第 0 列**（行首无缩进）能否整行解析成 JSON 对象：
 *     QCE 形态 → `qce-jsonl`，归一化消息形态 → `generic-jsonl`。
 *     （QCE 的 pretty JSON 里消息行缩进 4 空格，靠「第 0 列」把它们排除掉。）
 *  3. 首字符是 `{` 但两轮都没命中，而头部能搜到 `"messages":[` + `"metadata"/"chatInfo"` → `qce-json`
 *     （覆盖「紧凑模式的大文件」：整个文件一行，文件头必然被截断、无法 parse）。
 *  4. 头部像聊天记录 HTML（结构 + 聊天证据，判据见 importers/html.ts）→ `html`。
 *  5. 不像上述时按 txt 行模式判断 → `qce-txt`。
 *  6. 其余 → `unknown`。
 */
import { open } from 'node:fs/promises';
import { AppError } from '../../core/src/index.ts';
import { asRecord } from './qce-map.ts';
import { looksLikeChatTxt } from './txt-parse.ts';
import { HTML_FORMAT, looksLikeChatHtml } from './importers/html.ts';
import type { DetectedFormat } from './importer.ts';

/** 默认读取的文件头大小。 */
export const DEFAULT_HEAD_BYTES = 64 * 1024;

export interface DetectOptions {
  /** 覆盖默认的文件头读取上限。 */
  headBytes?: number;
}

/** 读取文件头（最多 `maxBytes`）。文件小于该值时返回的就是完整内容。 */
export async function readFileHead(
  filePath: string,
  maxBytes: number = DEFAULT_HEAD_BYTES,
): Promise<string> {
  const size = Math.max(1, Math.floor(maxBytes));
  const handle = await open(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(size);
    const { bytesRead } = await handle.read(buf, 0, size, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** QCE 单文件导出：含 `messages` 数组。 */
export function isQceBag(value: unknown): boolean {
  const rec = asRecord(value);
  return rec !== null && Array.isArray(rec.messages);
}

/** 单个 QCE 消息对象（`sender` + `content`）。 */
export function isQceMessageLike(value: unknown): boolean {
  const rec = asRecord(value);
  if (rec === null) return false;
  const sender = asRecord(rec.sender);
  if (sender !== null && ('uid' in sender || 'uin' in sender || 'name' in sender)) return true;
  const content = asRecord(rec.content);
  if (content !== null && ('elements' in content || 'resources' in content || 'text' in content)) {
    return true;
  }
  return typeof rec.timestamp === 'number' && rec.type !== undefined;
}

/** 归一化消息对象（本项目 NormalizedMessage 风格）。 */
export function isNormalizedMessageLike(value: unknown): boolean {
  const rec = asRecord(value);
  if (rec === null) return false;
  if (typeof rec.msgKey === 'string') return true;
  if (typeof rec.direction === 'string' || typeof rec.msgType === 'string') return true;
  return typeof rec.ts === 'number' && typeof rec.text === 'string';
}

/** 逐行包装对象 `{ chatInfo?, message }` → 内层消息对象；不是包装则返回 null。 */
export function unwrapMessageWrapper(value: unknown): Record<string, unknown> | null {
  const rec = asRecord(value);
  if (rec === null) return null;
  if (rec.message === undefined || rec.messages !== undefined) return null;
  return asRecord(rec.message);
}

/** 单个 JSON 文档的分类。 */
function classifyJsonDocument(doc: unknown): DetectedFormat {
  if (Array.isArray(doc)) {
    const first = doc.find((x) => asRecord(x) !== null);
    if (first === undefined) return 'unknown';
    if (isQceMessageLike(first) || isQceBag(first)) return 'qce-json';
    if (isNormalizedMessageLike(first)) return 'generic-jsonl';
    return 'unknown';
  }
  const rec = asRecord(doc);
  if (rec === null) return 'unknown';
  if (Array.isArray(rec.messages)) return 'qce-json';
  // 单条 `{ chatInfo, message }` 包装：逐行格式（qce-jsonl / generic-jsonl）
  const inner = unwrapMessageWrapper(rec);
  if (inner !== null) {
    // 包装形态本身就是 qce-jsonl 分块导出的标志（内层字段不全时也认）
    if (isNormalizedMessageLike(inner)) return 'generic-jsonl';
    return 'qce-jsonl';
  }
  if (isQceMessageLike(rec)) return 'qce-jsonl';
  if (isNormalizedMessageLike(rec)) return 'generic-jsonl';
  return 'unknown';
}

interface JsonlScan {
  kind: DetectedFormat | null;
  completeLines: number;
  sawQceBag: boolean;
  sawQceMessage: boolean;
  sawGenericMessage: boolean;
  parseFailures: number;
}

/** 扫描「第 0 列即以 `{` 开始且整行是完整 JSON 对象」的行。 */
function classifyJsonlLines(text: string): JsonlScan {
  const scan: JsonlScan = {
    kind: null,
    completeLines: 0,
    sawQceBag: false,
    sawQceMessage: false,
    sawGenericMessage: false,
    parseFailures: 0,
  };
  let scanned = 0;
  for (const line of text.split('\n')) {
    if (scanned >= 200) break;
    if (line.length === 0 || line.trim().length === 0) continue;
    if (line[0] !== '{') continue;
    const candidate = line.replace(/\s+$/, '');
    if (!candidate.endsWith('}')) continue;
    scanned += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      scan.parseFailures += 1;
      continue;
    }
    scan.completeLines += 1;
    // 逐行包装 `{ chatInfo, message }`：拿内层消息判断，别把整行当成「头部行」
    const wrapper = unwrapMessageWrapper(parsed);
    const inner = wrapper ?? parsed;
    if (isQceBag(parsed)) scan.sawQceBag = true;
    else if (isQceMessageLike(inner)) scan.sawQceMessage = true;
    else if (isNormalizedMessageLike(inner)) scan.sawGenericMessage = true;
    else if (wrapper !== null) scan.sawQceMessage = true;
  }
  if (scan.sawQceBag || scan.sawQceMessage) scan.kind = 'qce-jsonl';
  else if (scan.sawGenericMessage) scan.kind = 'generic-jsonl';
  return scan;
}

/** 头部文本里出现 QCE 关键字段（用于紧凑模式大文件的兜底判定）。 */
function looksLikeQceDocumentText(text: string): boolean {
  const hasMessagesArray = /"messages"\s*:\s*\[/.test(text);
  const hasHeaderField = /"(metadata|chatInfo|statistics)"\s*:/.test(text);
  return hasMessagesArray && hasHeaderField;
}

/** 同步版本：只看已知的头部文本（便于测试与自定义读取策略）。 */
export function detectFormatFromText(head: string | Uint8Array): DetectedFormat {
  const text = stripBom(typeof head === 'string' ? head : Buffer.from(head).toString('utf8'));
  const trimmed = text.replace(/^\s+/, '');
  if (trimmed.length === 0) return 'unknown';

  const first = trimmed[0] ?? '';
  if (first === '{' || first === '[') {
    // 1) 整个头部就是一个完整 JSON 文档
    try {
      return classifyJsonDocument(JSON.parse(text));
    } catch {
      // 头部被截断 / 不是单个文档，继续按 JSONL 与 txt 判断
    }
    // 2) 第 0 列的完整 JSON 行
    const jsonl = classifyJsonlLines(text);
    if (jsonl.kind !== null && jsonl.completeLines > 0) return jsonl.kind;
    // 3) 紧凑模式大文件兜底
    if (first === '{' && looksLikeQceDocumentText(text)) return 'qce-json';
    // 注意：`[2025-12-01 09:05:36] 昵称(1234): 内容` 这类 txt 行也以 `[` 开头，
    // 所以这里**不能**直接返回 unknown，要继续走下面的 txt 判定。
  }

  // 4) HTML 聊天记录导出（保守：必须同时具备 HTML 结构与聊天证据，
  //    判据与解析器共用同一套线索词，见 importers/html.ts 的 looksLikeChatHtml）
  if (looksLikeChatHtml(text)) return HTML_FORMAT;

  // 5) txt
  if (looksLikeChatTxt(text.split('\n').slice(0, 50))) return 'qce-txt';

  // 6) 非 `{` 开头但也可能是 JSONL（例如前面有 BOM/空白的怪文件已在上一步处理）
  const jsonl = classifyJsonlLines(text);
  if (jsonl.kind !== null && jsonl.completeLines > 0) return jsonl.kind;
  return 'unknown';
}

/**
 * 探测文件格式。`head` 可以由调用方提供（已经读过文件头时避免二次 IO）。
 */
export async function detectFormat(
  filePath: string,
  head?: string | Uint8Array,
  options: DetectOptions = {},
): Promise<DetectedFormat> {
  let text: string;
  if (head !== undefined) {
    text = Buffer.from(head).toString('utf8');
  } else {
    try {
      text = await readFileHead(filePath, options.headBytes ?? DEFAULT_HEAD_BYTES);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code === 'ENOENT' || code === 'EISDIR' || code === 'EACCES' || code === 'EPERM') {
        throw new AppError('BAD_REQUEST', `无法读取待导入文件：${filePath}`, { cause: code });
      }
      throw err;
    }
  }
  return detectFormatFromText(text);
}
