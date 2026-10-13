/**
 * html 导入器：把「聊天记录导出的 HTML 页面」还原成归一化消息。
 *
 * 真实世界的聊天记录 HTML 至少有两类形态，本导入器都覆盖：
 *
 *  A. QCE viewer 页面（qq-chat-exporter 的 HTML 导出）
 *     - 消息节点带 `data-*` 属性（`data-message-id` / `data-timestamp` / `data-sender-uin` …）；
 *     - 或者把整包数据内嵌成 JSON 载荷：
 *         `<script id="qce" type="application/json">{…}</script>`
 *         `<script>window.__INITIAL_STATE__ = {…}</script>`
 *       内嵌 JSON 的保真度更高（有完整的 sender / content / elements），因此 **优先使用**：
 *       只要从 JSON 里成功还原出至少一条消息，就不再扫描 DOM，避免同一批消息被导入两遍。
 *
 *  B. 通用聊天 HTML
 *     - 靠 class/id 线索（`message` / `msg` / `chat-item` / `bubble` …）识别消息容器；
 *     - 从容器属性或内部元素里取发送者、时间戳、正文；
 *     - `<img src>` → image；`<audio>/<video>/<source src>` 与指向已知媒体扩展名的
 *       `<a href>` → audio / video / file；`<br>` → 换行；
 *     - class/id 里的 `self|me|mine|right|own` 线索 → direction='out'。
 *
 * 与其它导入器一致的约定：
 *  - 解析不出来的字段绝不伪造：没有可解析时间戳的消息计入 failed + errors，不入批；
 *  - 单条消息解析失败不影响整批，继续往下跑；
 *  - 只通过 `run.push()` 交付数据，不直接碰数据库。
 *
 * 已知取舍（诚实边界）：
 *  - HTML 不是行结构，无法像 JSON/JSONL 那样逐条流式解析：本导入器会把整个文件读进内存
 *    （上限 `MAX_HTML_BYTES`，超过直接报错，避免 OOM）。聊天记录 HTML 导出通常在几 MB 量级。
 *  - 手写扫描器不做完整 HTML 规范化：属性值里含未转义 `>`、模板字符串、`<table>` 隐式闭合
 *    等病态写法会退化，遇到就按「宁可漏也不乱认」处理。
 */
import { readFile, stat } from 'node:fs/promises';

import type {
  Direction,
  MediaKind,
  NormalizedMessage,
  NormalizedSession,
  ResourceRef,
} from '../../../core/src/index.ts';
import { messageKeyOf } from '../../../core/src/index.ts';
import type {
  DetectedFormat,
  ImportContext,
  ImportStats,
  Importer,
} from '../importer.ts';
import { ImportRun, sessionFromHint } from '../importer.ts';
import { extFromUrl, filenameFromUrl, mimeForExt } from '../media-util.ts';
import {
  asRecord,
  inferMessageType,
  mapChatType,
  mapQceMessage,
  resolveTs,
  sessionFromChatInfo,
} from '../qce-map.ts';
import { mapNormalizedLike } from '../normalized-map.ts';
import { parseTxtTime } from '../txt-parse.ts';
import { errText, preview } from './generic-jsonl.ts';

/**
 * HTML 的格式名。
 *
 * 说明：格式联合 `DetectedFormat` 定义在 `../importer.ts`，本次改动范围**不允许**修改该文件，
 * 所以这里用一次窄作用域断言把 `'html'` 交给类型系统（运行时就是普通字符串 `'html'`）。
 * 正式做法是在 `DetectedFormat` 与 `DETECTED_FORMATS` 中各加一个 `'html'` 成员，
 * 之后即可删掉这里的 `as`（`detect.ts` 的返回值同理）。
 */
export const HTML_FORMAT = 'html' as DetectedFormat;

/** 单个 HTML 文件允许读入内存的上限，超过直接报错而不是把进程拖死。 */
const MAX_HTML_BYTES = 256 * 1024 * 1024;

/** 从文档里最多扫描多少个开始标签做容器统计（防止在超长页面里空转）。 */
const MAX_TAG_SCAN = 5000;

/** 内嵌 JSON 遍历时最多访问多少个节点。 */
const MAX_JSON_NODES = 5000;

// ---------------------------------------------------------------------------
// 格式探测用的线索词（detect.ts 直接复用，必须保守）
// ---------------------------------------------------------------------------

/** 消息容器线索：必须作为独立词出现，避免 `messages` 出现在无关词里被误认。 */
const MESSAGE_CUE = /(^|[\s_-])(?:messages?|msgs?|bubble|chat-?items?|chat-?records?|message-?items?|msg-?items?|talk-?items?)([\s_-]|$)/i;

/** 排除模板类容器（列表外壳、输入框等），它们虽然含线索词但不是单条消息。 */
const WRAPPER_CUE = /(^|[\s_-])(?:container|wrapper|list|items|input|editor|composer|toolbar|header|footer|nav|panel|area|form|actions?|box)([\s_-]|$)/i;

/** 发送者元素线索。刻意不含裸 `name`，避免把文件名之类的东西当昵称。 */
const SENDER_CUE = /(^|[\s_-])(?:sender|sender-?name|nickname|nick-?name|nick|username|user-?name|author|speaker)([\s_-]|$)/i;

/** 时间元素线索。 */
const TIME_CUE = /(^|[\s_-])(?:time|date|datetime|timestamp|dateline|msg-?time)([\s_-]|$)/i;

/** 需要在正文里剥掉的元信息元素（发送者/时间/头像/操作条），避免污染正文。 */
const META_CUE = /(^|[\s_-])(?:sender|sender-?name|nickname|nick-?name|nick|username|user-?name|author|speaker|avatar|time|date|datetime|timestamp|dateline|meta|toolbar|actions?|reactions?|status)([\s_-]|$)/i;

/** 表示「自己发出」的 class/id 线索词。 */
const SELF_TOKENS = new Set(['self', 'me', 'mine', 'right', 'own', 'sent', 'out', 'from-me']);

/** 表示「系统提示」的 class/id 线索词。 */
const SYSTEM_TOKENS = new Set(['system', 'notice', 'tip', 'tips', 'recall', 'recalled', 'revoked', 'withdrawn']);

/** 结束标签可以省略的元素（HTML 规范允许隐式闭合）。 */
const OPTIONAL_END_TAGS = new Set(['li', 'p', 'tr', 'td', 'th', 'dd', 'dt', 'option', 'thead', 'tbody', 'tfoot']);

/** 常见命名实体。数值实体走通用解码。 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ldquo: '\u201c',
  rdquo: '\u201d',
  lsquo: '\u2018',
  rsquo: '\u2019',
  hellip: '\u2026',
  mdash: '\u2014',
  ndash: '\u2013',
  middot: '\u00b7',
  copy: '\u00a9',
  reg: '\u00ae',
  times: '\u00d7',
  laquo: '\u00ab',
  raquo: '\u00bb',
};

/**
 * `class`/`id` 组合值是否像一个**单条消息**容器。
 * 供本导入器与 detect.ts 共用，保证「探测」和「解析」用的是同一套判断。
 */
export function isMessageContainerClass(value: string): boolean {
  if (!value) return false;
  if (!MESSAGE_CUE.test(value)) return false;
  if (WRAPPER_CUE.test(value)) return false;
  return true;
}

/**
 * 头部文本是否「像聊天记录 HTML」。探测**必须保守**：只有同时拿到
 * 「HTML 结构 / 成对容器」与「聊天证据」才返回 true，绝不能把 JSON、TXT 误判成 HTML。
 *
 * 判据（任一满足聊天证据，且结构成立）：
 *  1. 内嵌 JSON 载荷里出现 `"messages":`（并要求有 HTML 文档标记）；
 *  2. QCE 专属标记（`data-message-id` / `data-sender-uin` / exporter 字样）+ HTML 形态；
 *  3. 至少 2 个消息容器 **且** 头部存在时间信号（日期 / `datetime=` / `data-timestamp`）——
 *     这条用于无 `<html>` 标记的片段式聊天页，同时把「收件箱式的 message-item 列表」挡在外面。
 */
export function looksLikeChatHtml(head: string): boolean {
  const text = stripBom(head);
  if (!text.includes('<')) return false;

  const hasHtmlTag = /<!doctype\s+html|<html[\s>]|<body[\s>]|<head[\s>]/i.test(text);
  const hasTimeSignal = /data-(?:timestamp|time|datetime|ts)\s*=|datetime\s*=|\b(?:19|20)\d{2}[-/]\d{1,2}[-/]\d{1,2}/i.test(text);

  const jsonScript = /<script\b[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script\s*>/i.exec(text);
  const jsonHasBag = jsonScript !== null && /"messages"\s*:/.test(jsonScript[1] ?? '');
  const stateAssignment = /window\.[A-Za-z0-9_$]*__\s*=|(?:var|let|const)\s+[A-Za-z0-9_$]*(?:chat|message|data)[A-Za-z0-9_$]*\s*=\s*[[{]/i.test(text);
  const stateHasBag = stateAssignment && /"messages"\s*:/.test(text);

  const qceMarker = /qq-chat-exporter|chat-exporter|data-message-id|data-messageid|data-msg-id|data-sender-uin/i.test(text);
  const containers = countMessageContainers(text);

  // 1) 内嵌 JSON 载荷：必须同时是 HTML 文档，或有 QCE/容器证据
  if (jsonHasBag || stateHasBag) return hasHtmlTag || qceMarker || containers >= 1;
  // 2) QCE 专属标记：有 HTML 形态或至少一个容器即可
  if (qceMarker && (hasHtmlTag || containers >= 1)) return true;
  // 3) 通用容器 + 时间信号（片段式聊天页也走这条）
  if (containers >= 2 && hasTimeSignal) return true;
  return false;
}

// ---------------------------------------------------------------------------
// 导入器
// ---------------------------------------------------------------------------

/** HTML 聊天记录导入器（接口与 qce-json / qce-txt 完全一致）。 */
export class HtmlImporter implements Importer {
  readonly name = 'html';
  readonly formats: DetectedFormat[] = [HTML_FORMAT];

  async run(ctx: ImportContext): Promise<ImportStats> {
    const source = ctx.source ?? 'html';
    const run = new ImportRun(ctx, this.name);

    const raw = await readHtmlSource(ctx.filePath);

    // 内嵌 JSON 载荷（保真度最高），以及剥掉 script/style/注释后的 DOM 文本
    const payloads = extractJsonPayloads(raw);
    const domHtml = stripNonMessageBlocks(raw);

    // 会话信息：内嵌 chatInfo 优先，其次 data-chat-* / meta / <title>
    const session = sessionFromHtml(domHtml, payloads, ctx.accountUid, source, ctx.sessionHint);
    run.setSession(session);

    let fromJson = 0;
    for (const payload of payloads) {
      if (run.limitReached) break;
      fromJson += await emitJsonMessages(payload, run, ctx.accountUid, source, session);
    }

    // JSON 已经覆盖这批消息，就不再扫 DOM（避免同一批消息进两遍）
    if (fromJson > 0) return run.finish();

    for (const blockHtml of extractMessageBlocks(domHtml)) {
      if (run.limitReached) break;
      run.checkAbort();
      await emitBlock(blockHtml, run, session);
    }

    const stats = await run.finish();
    if (stats.totalItems === 0 && stats.failed === 0) {
      run.recordFailure('未从 HTML 中解析出任何消息（页面结构可能不受支持）');
    }
    return stats;
  }
}

// ---------------------------------------------------------------------------
// 文件读取与总体切分
// ---------------------------------------------------------------------------

/** 读入整个 HTML 文件（带上限保护，避免超大文件把进程拖死）。 */
async function readHtmlSource(filePath: string): Promise<string> {
  const info = await stat(filePath);
  if (info.size > MAX_HTML_BYTES) {
    throw new Error(
      `HTML 文件过大（${info.size} 字节，上限 ${MAX_HTML_BYTES} 字节）：当前实现需要整文件读入内存，请先拆分导出`,
    );
  }
  return readFile(filePath, 'utf8');
}

/** 去掉 BOM。 */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** 剥掉注释、`<script>`、`<style>`，只留下可能承载消息节点的 DOM 文本。 */
function stripNonMessageBlocks(html: string): string {
  let out = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ');
  // 未闭合的 <script>/<style>：从第一个开始整段丢弃，否则里面的 JS/CSS 会被当成 DOM
  out = out.replace(/<script\b[\s\S]*$/i, ' ');
  out = out.replace(/<style\b[\s\S]*$/i, ' ');
  return out;
}

// ---------------------------------------------------------------------------
// 内嵌 JSON 载荷
// ---------------------------------------------------------------------------

/** 抽取页面里所有内嵌 JSON：`type="application/json"` 脚本 + JS 里的对象字面量赋值。 */
function extractJsonPayloads(html: string): unknown[] {
  const out: unknown[] = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const attrs = parseAttrs(m[1] ?? '');
    const body = (m[2] ?? '').trim();
    if (body.length === 0) continue;
    const type = (attrs.get('type') ?? '').toLowerCase();
    if (type.includes('json')) {
      const parsed = tryParseJson(body);
      if (parsed !== undefined) out.push(parsed);
      continue;
    }
    // JS 脚本：找 `window.__X__ = {…}` / `var chatData = {…}` 这类字面量赋值
    for (const value of extractJsLiterals(body)) out.push(value);
  }
  return out;
}

/** 严格 JSON 解析；失败返回 undefined（不抛）。 */
function tryParseJson(text: string): unknown {
  const trimmed = text.trim().replace(/;\s*$/, '');
  if (trimmed.length === 0) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

/** 从 JS 源码里提取可被 JSON.parse 的对象/数组字面量赋值。 */
function extractJsLiterals(js: string): unknown[] {
  const out: unknown[] = [];
  const re = /(?:window\.|globalThis\.|var\s+|let\s+|const\s+)?[A-Za-z_$][\w$.[\]]*\s*=\s*(?=[[{])/g;
  let m: RegExpExecArray | null;
  let scanned = 0;
  while ((m = re.exec(js)) !== null && scanned < 20) {
    scanned++;
    const literal = sliceBalanced(js, re.lastIndex);
    if (literal === null) continue;
    const parsed = tryParseJson(literal);
    if (parsed !== undefined) out.push(parsed);
  }
  return out;
}

/** 从 `start` 处的 `{`/`[` 开始做括号配对（跳过字符串与转义），返回完整字面量。 */
function sliceBalanced(text: string, start: number): string | null {
  const open = text[start];
  if (open !== '{' && open !== '[') return null;
  const stack: string[] = [];
  let quote: string | null = null;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quote !== null) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{' || ch === '[') {
      stack.push(ch);
      continue;
    }
    if (ch === '}' || ch === ']') {
      stack.pop();
      if (stack.length === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** 在内嵌 JSON 里广度优先找出「消息数组」（第一个元素像消息的数组）。 */
function findMessageArray(root: unknown): unknown[] | null {
  const queue: unknown[] = [root];
  let visited = 0;
  while (queue.length > 0 && visited < MAX_JSON_NODES) {
    visited++;
    const cur = queue.shift();
    if (Array.isArray(cur)) {
      if (cur.some(isMessageLike)) return cur;
      for (const item of cur) if (isTraversable(item)) queue.push(item);
      continue;
    }
    const rec = asRecord(cur);
    if (rec === null) continue;
    for (const [key, value] of Object.entries(rec)) {
      if (key === 'avatars' || key === 'exportOptions') continue;
      if (isTraversable(value)) queue.push(value);
    }
  }
  return null;
}

/** 在内嵌 JSON 里找出会话信息对象（`chatInfo` 或形似 `chat` 的对象）。 */
function findChatInfo(root: unknown): Record<string, unknown> | null {
  const queue: unknown[] = [root];
  let visited = 0;
  while (queue.length > 0 && visited < MAX_JSON_NODES) {
    visited++;
    const cur = queue.shift();
    if (Array.isArray(cur)) {
      for (const item of cur) if (isTraversable(item)) queue.push(item);
      continue;
    }
    const rec = asRecord(cur);
    if (rec === null) continue;
    const chatInfo = asRecord(rec['chatInfo']);
    if (chatInfo !== null) return chatInfo;
    const chat = asRecord(rec['chat']);
    if (chat !== null && (typeof chat['name'] === 'string' || typeof chat['type'] === 'string')) return chat;
    for (const [key, value] of Object.entries(rec)) {
      if (key === 'avatars' || key === 'exportOptions') continue;
      if (isTraversable(value)) queue.push(value);
    }
  }
  return null;
}

/** 值是否值得继续遍历（对象/数组，跳过字符串等标量，避免走进 base64 大字符串）。 */
function isTraversable(value: unknown): boolean {
  return typeof value === 'object' && value !== null;
}

/** 一个对象是否「像一条消息」。 */
function isMessageLike(value: unknown): boolean {
  const rec = asRecord(value);
  if (rec === null) return false;
  if (asRecord(rec['sender']) !== null || asRecord(rec['content']) !== null) return true;
  if (typeof rec['msgKey'] === 'string' || typeof rec['msg_key'] === 'string') return true;
  if (typeof rec['direction'] === 'string' || typeof rec['msgType'] === 'string') return true;
  if (typeof rec['ts'] === 'number' && typeof rec['text'] === 'string') return true;
  return false;
}

/** 把内嵌 JSON 里的消息批量映射并入批，返回成功映射的条数。 */
async function emitJsonMessages(
  payload: unknown,
  run: ImportRun,
  accountUid: string,
  source: string,
  session: NormalizedSession,
): Promise<number> {
  const items = findMessageArray(payload);
  if (items === null) return 0;
  let count = 0;
  for (const item of items) {
    if (run.limitReached) break;
    run.checkAbort();
    let message: NormalizedMessage;
    try {
      message = mapPayloadMessage(item, accountUid, source, session);
    } catch (err) {
      run.recordFailure(`内嵌 JSON 消息映射失败：${errText(err)}`);
      continue;
    }
    if (message.ts <= 0) {
      run.recordFailure(`内嵌 JSON 消息缺少可解析时间戳（正文=${preview(message.text)}）`);
      continue;
    }
    await run.push(message);
    count++;
  }
  return count;
}

/** 单条内嵌 JSON 消息：QCE 形态走 mapQceMessage，归一化形态走 mapNormalizedLike。 */
function mapPayloadMessage(
  item: unknown,
  accountUid: string,
  source: string,
  session: NormalizedSession,
): NormalizedMessage {
  const rec = asRecord(item);
  if (rec === null) throw new TypeError('内嵌 JSON 的消息不是对象');
  const mapCtx = { accountUid, source, session };
  if (asRecord(rec['sender']) !== null || asRecord(rec['content']) !== null) {
    return mapQceMessage(rec, mapCtx);
  }
  return mapNormalizedLike(rec, mapCtx, { sourceTag: source });
}

// ---------------------------------------------------------------------------
// DOM 扫描
// ---------------------------------------------------------------------------

/**
 * 顺序扫描 DOM，抽出所有「单条消息」容器的 HTML 片段。
 * 命中容器后整块跳过（`re.lastIndex = end`），因此嵌套的 `bubble`/`content`
 * 不会被当成独立消息重复抽出。
 */
function extractMessageBlocks(html: string): string[] {
  const out: string[] = [];
  const re = /<([a-zA-Z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  let m: RegExpExecArray | null;
  let scanned = 0;
  while ((m = re.exec(html)) !== null && scanned < MAX_TAG_SCAN) {
    scanned++;
    const tagName = (m[1] ?? '').toLowerCase();
    if (m[0].endsWith('/>')) continue;
    const attrs = parseAttrs(m[2] ?? '');
    const classId = `${attrs.get('class') ?? ''} ${attrs.get('id') ?? ''}`.trim();
    if (!isMessageContainerClass(classId)) continue;
    const end = findBlockEnd(html, tagName, re.lastIndex);
    if (end === null) continue;
    out.push(html.slice(m.index, end));
    re.lastIndex = end;
  }
  return out;
}

/** 统计文档里出现了多少个消息容器开始标签（探测用，命中 5 个就提前收手）。 */
function countMessageContainers(text: string): number {
  let count = 0;
  const re = /<([a-zA-Z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  let m: RegExpExecArray | null;
  let scanned = 0;
  while ((m = re.exec(text)) !== null && scanned < MAX_TAG_SCAN) {
    scanned++;
    const attrs = parseAttrs(m[2] ?? '');
    const classId = `${attrs.get('class') ?? ''} ${attrs.get('id') ?? ''}`.trim();
    if (!classId) continue;
    if (isMessageContainerClass(classId)) count++;
    if (count >= 5) break;
  }
  return count;
}

/**
 * 找出与 `tagName` 开始标签配对的结束标签位置，返回结束标签之后的下标。
 * 找不到返回 null。
 */
function findBlockEnd(html: string, tagName: string, from: number): number | null {
  const openRe = new RegExp(`<${tagName}(?=[\\s/>])`, 'gi');
  const closeRe = new RegExp(`</${tagName}(?=[\\s>])`, 'gi');
  let depth = 1;
  let pos = from;
  while (pos < html.length) {
    openRe.lastIndex = pos;
    closeRe.lastIndex = pos;
    const open = openRe.exec(html);
    const close = closeRe.exec(html);
    if (close === null) return null;
    if (open !== null && open.index < close.index) {
      // 可省略结束标签的元素：遇到同名的下一个兄弟，视为隐式闭合
      if (OPTIONAL_END_TAGS.has(tagName) && depth === 1) return open.index;
      const gt = tagEnd(html, open.index);
      if (gt < 0) return null;
      if (!html.slice(open.index, gt).trimEnd().endsWith('/>')) depth++;
      pos = gt;
      continue;
    }
    depth--;
    const end = tagEnd(html, close.index);
    if (end < 0) return null;
    if (depth === 0) return end;
    pos = end;
  }
  return null;
}

/** 从 `from` 处的 `<` 开始找到当前标签的 `>`（尊重引号内的 `>`），返回其后下标。 */
function tagEnd(html: string, from: number): number {
  let quote: string | null = null;
  for (let i = from; i < html.length; i++) {
    const ch = html[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '>') return i + 1;
  }
  return -1;
}

/** 取片段里的第一个开始标签。 */
function firstStartTag(html: string): { tag: string; attrs: Map<string, string> } | null {
  const m = /<([a-zA-Z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/.exec(html);
  if (m === null) return null;
  return { tag: (m[1] ?? '').toLowerCase(), attrs: parseAttrs(m[2] ?? '') };
}

/** 找到片段里第一个 class/id 命中 `cue` 的元素，返回其完整 HTML（含结束标签）。 */
function findElementByClass(html: string, cue: RegExp): string | null {
  const re = /<([a-zA-Z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const tagName = (m[1] ?? '').toLowerCase();
    if (m[0].endsWith('/>')) continue;
    const attrs = parseAttrs(m[2] ?? '');
    const classId = `${attrs.get('class') ?? ''} ${attrs.get('id') ?? ''}`.trim();
    if (!classId || !cue.test(classId)) continue;
    const end = findBlockEnd(html, tagName, re.lastIndex);
    if (end === null) return null;
    return html.slice(m.index, end);
  }
  return null;
}

/** 删掉片段里 class/id 命中 `cue` 的元素（连同内容），避免元信息混进正文。 */
function removeElementsByClass(html: string, cue: RegExp): string {
  const re = /<([a-zA-Z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const tagName = (m[1] ?? '').toLowerCase();
    if (m[0].endsWith('/>')) continue;
    const attrs = parseAttrs(m[2] ?? '');
    const classId = `${attrs.get('class') ?? ''} ${attrs.get('id') ?? ''}`.trim();
    if (!classId || !cue.test(classId)) continue;
    const end = findBlockEnd(html, tagName, re.lastIndex);
    if (end === null) continue;
    out += html.slice(last, m.index);
    last = end;
    re.lastIndex = end;
  }
  out += html.slice(last);
  return out;
}

// ---------------------------------------------------------------------------
// 单条消息解析
// ---------------------------------------------------------------------------

/** 解析一个消息容器片段，映射成归一化消息并入批。 */
async function emitBlock(blockHtml: string, run: ImportRun, session: NormalizedSession): Promise<void> {
  const container = firstStartTag(blockHtml);
  const attrs = container?.attrs ?? new Map<string, string>();
  const classId = `${attrs.get('class') ?? ''} ${attrs.get('id') ?? ''}`.trim();
  const tokens = tokenize(classId);

  const system = tokens.some((t) => SYSTEM_TOKENS.has(t)) || attrBool(attrs, 'data-system');
  const { name: senderName, uin: senderUin } = extractSender(attrs, blockHtml);

  let direction: Direction = system ? 'system' : 'in';
  if (!system) {
    const dirAttr = (firstAttr(attrs, ['data-direction', 'data-msg-direction']) ?? '').toLowerCase();
    if (dirAttr === 'out' || dirAttr === 'in') {
      direction = dirAttr;
    } else if (tokens.some((t) => SELF_TOKENS.has(t))) {
      direction = 'out';
    } else if (senderUin !== undefined && session.selfUin !== undefined && senderUin === session.selfUin) {
      direction = 'out';
    } else if (senderName !== undefined && session.selfName !== undefined && senderName === session.selfName) {
      direction = 'out';
    }
  }

  const { ts, timeText } = extractTs(attrs, blockHtml);
  const resources = extractResources(blockHtml);
  const text = htmlToText(removeElementsByClass(blockHtml, META_CUE));

  if (ts <= 0) {
    run.recordFailure(
      `HTML 消息缺少可解析的时间戳（发送者=${senderName ?? '未知'}，正文=${preview(text)}）`,
    );
    return;
  }

  const msgId = firstAttr(attrs, ['data-message-id', 'data-msg-id', 'data-mid', 'data-messageid', 'data-uuid', 'data-id']);
  const seq = firstAttr(attrs, ['data-seq', 'data-index', 'data-order', 'data-idx']);
  const explicitType = firstAttr(attrs, ['data-type', 'data-msg-type', 'data-message-type']);
  const msgType = inferMessageType({ explicit: explicitType, elements: [], resources, text, system });

  const message: NormalizedMessage = {
    msgKey: messageKeyOf({ msgId, ts, senderUin, text, resources, seq }),
    ts,
    direction,
    msgType,
    text,
  };
  if (senderName !== undefined) message.senderName = senderName;
  if (senderUin !== undefined) message.senderUin = senderUin;
  if (msgId !== undefined) message.msgId = msgId;
  if (seq !== undefined) message.seq = seq;
  if (resources.length > 0) message.resources = resources;
  if (system) {
    message.system = true;
    message.recalled = tokens.includes('recalled') || tokens.includes('revoked') || tokens.includes('withdrawn');
  }

  const extra: Record<string, unknown> = {};
  if (classId) extra['htmlClass'] = classId;
  if (timeText !== undefined) extra['time'] = timeText;
  const dataAttrs: Record<string, unknown> = {};
  for (const [key, value] of attrs) {
    if (key.startsWith('data-')) dataAttrs[key] = value;
  }
  if (Object.keys(dataAttrs).length > 0) extra['htmlAttrs'] = dataAttrs;
  if (Object.keys(extra).length > 0) message.extra = extra;

  await run.push(message);
}

/** 从容器属性或内部元素里取发送者昵称与 QQ 号。 */
function extractSender(attrs: Map<string, string>, html: string): { name?: string; uin?: string } {
  let uin = firstAttr(attrs, ['data-sender-uin', 'data-uin', 'data-qq', 'data-user-id', 'data-uid', 'data-sender-id']);
  let name = firstAttr(attrs, [
    'data-sender-name',
    'data-nickname',
    'data-nick',
    'data-username',
    'data-user-name',
    'data-sender',
    'data-author',
    'data-name',
  ]);

  const parsed = splitNameAndUin(name);
  if (parsed.name !== undefined) name = parsed.name;
  if (uin === undefined && parsed.uin !== undefined) uin = parsed.uin;

  if (name === undefined || uin === undefined) {
    const element = findElementByClass(html, SENDER_CUE);
    if (element !== null) {
      const raw = htmlToText(element);
      const fromElement = splitNameAndUin(raw);
      if (name === undefined && fromElement.name !== undefined) name = fromElement.name;
      if (uin === undefined && fromElement.uin !== undefined) uin = fromElement.uin;
    }
  }
  return { name, uin };
}

/** 把 `小明(10001)` / `小明 <10001>` 这类写法拆成昵称 + QQ 号。 */
function splitNameAndUin(raw: string | undefined): { name?: string; uin?: string } {
  if (raw === undefined) return {};
  const text = raw.trim();
  if (text.length === 0) return {};
  const m = /^(.*?)\s*[（(<]\s*(\d{4,12})\s*[）)>]?\s*$/.exec(text);
  if (m !== null) {
    const name = (m[1] ?? '').trim();
    return name.length > 0 ? { name, uin: m[2] } : { uin: m[2] };
  }
  return { name: text };
}

/** 从容器属性、`<time>` 元素、时间线索元素或正文里找时间戳。 */
function extractTs(attrs: Map<string, string>, html: string): { ts: number; timeText?: string } {
  const keys = ['data-timestamp', 'data-ts', 'data-time', 'data-datetime', 'data-date', 'timestamp', 'ts', 'time', 'datetime'];
  for (const key of keys) {
    const value = attrs.get(key);
    if (value === undefined || value.trim().length === 0) continue;
    const ts = resolveTs(value, value);
    if (ts > 0) return { ts, timeText: value };
  }

  const timeEl = /<time\b((?:"[^"]*"|'[^']*'|[^>"'])*)>([\s\S]*?)<\/time\s*>/i.exec(html);
  if (timeEl !== null) {
    const ta = parseAttrs(timeEl[1] ?? '');
    const datetime = ta.get('datetime');
    const body = htmlToText(timeEl[2] ?? '');
    const ts = datetime !== undefined && datetime.trim().length > 0 ? resolveTs(datetime, datetime) : resolveTs(undefined, body);
    if (ts > 0) return datetime !== undefined && datetime.trim().length > 0 ? { ts, timeText: datetime } : { ts, timeText: body };
  }

  const element = findElementByClass(html, TIME_CUE);
  if (element !== null) {
    const body = htmlToText(element);
    const ts = resolveTs(undefined, body) || (parseTxtTime(body) ?? 0);
    if (ts > 0) return { ts, timeText: body };
  }

  // 最后手段：整块文本里带「日期 + 时分」的写法（要求有时分，降低误命中）
  const scanned = /(\d{4}[-/]\d{1,2}[-/]\d{1,2}[ T]\d{1,2}:\d{2}(?::\d{2})?)/.exec(htmlToText(html));
  if (scanned !== null) {
    const ts = parseTxtTime(scanned[1] ?? '');
    if (ts !== null && ts > 0) return { ts, timeText: scanned[1] };
  }
  return { ts: 0 };
}

/** 抽出片段里的媒体/文件引用：img / audio / video / source / a[href]。 */
function extractResources(html: string): ResourceRef[] {
  const out: ResourceRef[] = [];
  const seen = new Set<string>();
  const push = (kind: MediaKind, url: string | undefined, filename: string | undefined): void => {
    const key = `${kind}|${url ?? ''}|${filename ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    const ref: ResourceRef = { kind };
    if (url !== undefined) ref.url = url;
    if (filename !== undefined) ref.filename = filename;
    out.push(ref);
  };

  for (const m of html.matchAll(/<img\b((?:"[^"]*"|'[^']*'|[^>"'])*)>/gi)) {
    const a = parseAttrs(m[1] ?? '');
    const url = cleanUrl(pickMediaUrl(a));
    const alt = a.get('alt');
    const fromAlt = alt !== undefined && /\.[A-Za-z0-9]{1,8}$/.test(alt.trim()) ? alt.trim() : undefined;
    push('image', url, fromAlt ?? filenameFromUrl(url ?? '') ?? undefined);
  }

  for (const m of html.matchAll(/<source\b((?:"[^"]*"|'[^']*'|[^>"'])*)>/gi)) {
    const a = parseAttrs(m[1] ?? '');
    const url = cleanUrl(a.get('src') ?? firstSrcset(a.get('srcset')));
    push(kindFromUrl(url), url, filenameFromUrl(url ?? '') ?? undefined);
  }

  for (const m of html.matchAll(/<(audio|video)\b((?:"[^"]*"|'[^']*'|[^>"'])*)>/gi)) {
    const kind: MediaKind = (m[1] ?? '').toLowerCase() === 'audio' ? 'audio' : 'video';
    const a = parseAttrs(m[2] ?? '');
    const url = cleanUrl(pickMediaUrl(a));
    push(kind, url, filenameFromUrl(url ?? '') ?? undefined);
  }

  for (const m of html.matchAll(/<a\b((?:"[^"]*"|'[^']*'|[^>"'])*)>/gi)) {
    const a = parseAttrs(m[1] ?? '');
    const href = cleanUrl(a.get('href'));
    if (href === undefined) continue;
    const mime = mimeForExt(extFromUrl(href));
    if (mime === null) continue; // 没有已知媒体扩展名 → 当普通链接，不当资源
    const kind: MediaKind = mime.startsWith('image/')
      ? 'image'
      : mime.startsWith('video/')
        ? 'video'
        : mime.startsWith('audio/')
          ? 'audio'
          : 'file';
    push(kind, href, filenameFromUrl(href) ?? undefined);
  }

  return out;
}

/** img/audio/video 的候选 URL：优先 src，其次常见懒加载属性，最后 srcset 第一项。 */
function pickMediaUrl(attrs: Map<string, string>): string | undefined {
  const keys = ['src', 'data-src', 'data-original', 'data-lazy-src', 'data-actualsrc', 'data-echo'];
  for (const key of keys) {
    const value = attrs.get(key);
    if (value !== undefined && value.trim().length > 0) return value;
  }
  return firstSrcset(attrs.get('srcset'));
}

/** 取 srcset 里第一个候选 URL。 */
function firstSrcset(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const first = value.split(',')[0]?.trim();
  if (first === undefined || first.length === 0) return undefined;
  return first.split(/\s+/)[0];
}

/** 过滤掉不可用/内联的 URL（data:/blob:/javascript:）。 */
function cleanUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  const trimmed = url.trim();
  if (trimmed.length === 0) return undefined;
  if (/^(?:data|blob|javascript):/i.test(trimmed)) return undefined;
  return trimmed;
}

/** 按扩展名猜媒体类型（未知当 file）。 */
function kindFromUrl(url: string | undefined): MediaKind {
  if (url === undefined) return 'file';
  const mime = mimeForExt(extFromUrl(url));
  if (mime === null) return 'file';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}

// ---------------------------------------------------------------------------
// 文本与属性工具
// ---------------------------------------------------------------------------

/** HTML 片段 → 纯文本：`<br>` 换行、块级结束标签换行、去标签、解实体、收敛空白。 */
function htmlToText(html: string): string {
  // 源码里的换行与缩进在 HTML 里是纯排版空白。必须先压成空格：
  // 否则它们会和 `</p>`/`<br>` 产生的结构换行叠加成假空行
  // （如 `<p>x</p>\n  <audio …></audio>\n  doc.pdf` 会渲染出 `x\n\ndoc.pdf`）。
  // 已知取舍：`<pre>` 这类空白敏感的块会丢掉内部换行。
  let s = html.replace(/[\r\n\t]+/g, ' ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(?:p|div|li|h[1-6]|section|article|tr|blockquote|pre)\s*>/gi, '\n');
  s = s.replace(/<[^>]*>/g, '');
  s = decodeEntities(s);
  s = s.replace(/[ \t\u00a0\u200b]+/g, ' ');
  s = s.replace(/ *\n */g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/** 解码常见 HTML 实体（命名 + 十进制 + 十六进制）。 */
function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      return match;
    }
    const named = NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()];
    return named ?? match;
  });
}

/** 解析开始标签的属性串（属性名小写；值已解实体）。 */
function parseAttrs(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const key = (m[1] ?? '').toLowerCase();
    if (out.has(key)) continue;
    out.set(key, decodeEntities(m[2] ?? m[3] ?? m[4] ?? ''));
  }
  return out;
}

/** 取第一个非空属性值。 */
function firstAttr(attrs: Map<string, string>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = attrs.get(key);
    if (value !== undefined && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

/** 属性是否为真值（存在且不为 "false"/"0"）。 */
function attrBool(attrs: Map<string, string>, key: string): boolean {
  const value = attrs.get(key);
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v !== 'false' && v !== '0' && v !== 'no';
}

/** 把 class/id 组合值切成小写词元（按空白、`-`、`_` 切分）。 */
function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter((t) => t.length > 0);
}

// ---------------------------------------------------------------------------
// 会话信息
// ---------------------------------------------------------------------------

/** 从内嵌 chatInfo、`data-chat-*`、`<meta>`、`<title>` 里拼出会话信息。 */
function sessionFromHtml(
  domHtml: string,
  payloads: unknown[],
  accountUid: string,
  source: string,
  hint: ImportContext['sessionHint'],
): NormalizedSession {
  for (const payload of payloads) {
    const chatInfo = findChatInfo(payload);
    if (chatInfo !== null) return sessionFromChatInfo(chatInfo, accountUid, source);
  }

  const session = sessionFromHint(accountUid, source, hint);

  const name =
    firstDocAttr(domHtml, ['data-chat-name', 'data-chat-title', 'data-conversation-name', 'data-session-name']) ??
    metaContent(domHtml, ['chat-name', 'chatname', 'og:title', 'title']) ??
    titleText(domHtml);
  const cleanName = cleanSessionName(name);
  if (cleanName !== undefined) session.name = cleanName;

  const chatType = mapChatType(
    firstDocAttr(domHtml, ['data-chat-type', 'data-chattype']) ??
      metaContent(domHtml, ['chat-type', 'chattype', 'og:type']),
  );
  if (chatType !== 'other') session.chatType = chatType;

  const peerUin =
    firstDocAttr(domHtml, ['data-peer-uin', 'data-peer-qq', 'data-group-id', 'data-groupid']) ??
    metaContent(domHtml, ['peer-uin', 'peer-qq', 'group-id']);
  if (peerUin !== undefined && /^\d{4,12}$/.test(peerUin)) {
    session.peerUin = peerUin;
    if (session.peerUid.length === 0) session.peerUid = peerUin;
  }

  const memberCount = firstDocAttr(domHtml, ['data-member-count', 'data-participant-count']);
  if (memberCount !== undefined) {
    const n = Number.parseInt(memberCount, 10);
    if (Number.isFinite(n) && n > 0) session.memberCount = n;
  }

  return session;
}

/** 在文档里找第一个出现的指定属性值（用于 `data-chat-*` 这类元数据）。 */
function firstDocAttr(html: string, keys: string[]): string | undefined {
  for (const key of keys) {
    const re = new RegExp(`${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`, 'i');
    const m = re.exec(html);
    if (m === null) continue;
    const value = decodeEntities(m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (value.length > 0) return value;
  }
  return undefined;
}

/** 取 `<meta name=... content=...>` 的值（name/property 都认）。 */
function metaContent(html: string, names: string[]): string | undefined {
  for (const name of names) {
    const re = new RegExp(
      `<meta\\b[^>]*(?:name|property)\\s*=\\s*["']${escapeRegExp(name)}["'][^>]*>`,
      'i',
    );
    const tag = re.exec(html);
    if (tag === null) continue;
    const attrs = parseAttrs(tag[0].slice(5, -1));
    const content = attrs.get('content');
    if (content !== undefined && content.trim().length > 0) return content.trim();
  }
  return undefined;
}

/** 取 `<title>` 文本。 */
function titleText(html: string): string | undefined {
  const m = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  if (m === null) return undefined;
  const text = htmlToText(m[1] ?? '');
  return text.length > 0 ? text : undefined;
}

/** 清掉标题里的「· 聊天记录」这类后缀。 */
function cleanSessionName(name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  let text = name.trim();
  if (text.length === 0) return undefined;
  text = text.replace(/\s*[·|\-–—]\s*(?:聊天记录|聊天紀錄|chat\s*(?:history|log|export))\s*$/i, '');
  text = text.replace(/\s*(?:聊天记录|聊天紀錄)\s*$/i, '');
  text = text.trim();
  if (text.length === 0) return undefined;
  return text.length > 200 ? text.slice(0, 200) : text;
}

/** 转义正则里的字面量。 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
