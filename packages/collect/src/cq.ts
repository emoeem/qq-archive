/**
 * OneBot v11 消息解析：CQ 码字符串 → 结构化字段。
 *
 * OneBot 的 `message` 有两种形态：
 *   1. CQ 码字符串：`你好 [CQ:image,file=a.jpg] [CQ:at,qq=123]`
 *   2. 消息段数组：`[{type:'text',data:{text:'你好'}},{type:'image',data:{file:'a.jpg'}}]`
 * 两种都要支持，且**不得静默丢弃**未知段：未知段一律进入 `elements` 并在 text 里留占位符。
 */
import { basename } from 'node:path';
import type { MediaKind, MessageElement, ResourceRef } from '../../core/src/index.ts';
import { asRecord, num, str } from './util.ts';

/** 解析出的引用关系。 */
export interface ParsedReply {
  msgId: string;
  preview?: string;
}

/** 一条消息的解析结果。 */
export interface ParsedCqMessage {
  /** 可读正文（含 @、[图片]、[表情] 等转写）。 */
  text: string;
  resources: ResourceRef[];
  mentions: Array<{ uid?: string; name?: string; type?: string }>;
  reply: ParsedReply | null;
  forwardId: string | null;
  faceIds: string[];
  elements: MessageElement[];
  hasJson: boolean;
  hasLocation: boolean;
}

/** CQ 码转义还原（顺序重要：`&amp;` 必须最后还原）。 */
export function cqUnescape(raw: string): string {
  return String(raw)
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&#44;/g, ',')
    .replace(/&amp;/g, '&');
}

/** 解析 CQ 码参数串（形如 `,file=a.jpg,url=http://x`）。 */
export function cqParams(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([^,=]+)=([^,]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const key = m[1];
    const value = m[2];
    if (key !== undefined && value !== undefined) out[key.trim()] = cqUnescape(value);
  }
  return out;
}

function resourceFrom(kind: MediaKind, data: Record<string, unknown>): ResourceRef {
  const file = str(data.file) ?? str(data.name);
  const url = str(data.url);
  const size = num(data.file_size) ?? num(data.size);
  const width = num(data.width);
  const height = num(data.height);
  const duration = num(data.duration);
  const ref: ResourceRef = { kind };
  if (file) {
    const looksLikePath = /^file:\/\//i.test(file) || file.startsWith('/') || /^[A-Za-z]:[\\/]/.test(file);
    if (looksLikePath) ref.localPath = file.replace(/^file:\/\//i, '');
    const name = basename(file.replace(/^file:\/\//i, ''));
    if (name) ref.filename = name;
  }
  if (url) ref.url = url;
  if (size !== undefined) ref.size = size;
  if (width !== undefined) ref.width = width;
  if (height !== undefined) ref.height = height;
  if (duration !== undefined) ref.duration = duration;
  return ref;
}

function applySegment(out: ParsedCqMessage, type: string, data: Record<string, unknown>): void {
  switch (type) {
    case 'text':
      out.text += cqUnescape(str(data.text) ?? '');
      break;
    case 'image': {
      out.resources.push(resourceFrom('image', data));
      out.text += '[图片]';
      break;
    }
    case 'record': {
      out.resources.push(resourceFrom('audio', data));
      out.text += '[语音]';
      break;
    }
    case 'video': {
      out.resources.push(resourceFrom('video', data));
      out.text += '[视频]';
      break;
    }
    case 'file': {
      out.resources.push(resourceFrom('file', data));
      out.text += `[文件:${str(data.file) ?? str(data.name) ?? ''}]`;
      break;
    }
    case 'at': {
      const mention: { uid?: string; name?: string; type?: string } = { type: 'at' };
      const uid = str(data.qq);
      const name = str(data.name);
      if (uid !== undefined) mention.uid = uid;
      if (name !== undefined) mention.name = name;
      out.mentions.push(mention);
      out.text += `@${name ?? uid ?? ''} `;
      break;
    }
    case 'reply': {
      const id = str(data.id);
      if (id) {
        const reply: ParsedReply = { msgId: id };
        const preview = str(data.text);
        if (preview !== undefined) reply.preview = preview;
        out.reply = reply;
      }
      break;
    }
    case 'face': {
      const id = str(data.id) ?? '';
      out.faceIds.push(id);
      out.text += `[表情:${id}]`;
      break;
    }
    case 'mface': {
      out.text += '[表情]';
      break;
    }
    case 'forward': {
      const id = str(data.id);
      if (id) out.forwardId = id;
      out.text += '[合并转发]';
      break;
    }
    case 'json':
    case 'xml': {
      out.hasJson = true;
      out.text += '[卡片]';
      break;
    }
    case 'location': {
      out.hasLocation = true;
      out.text += `[位置:${str(data.title) ?? str(data.name) ?? ''}]`;
      break;
    }
    case 'poke':
      out.text += '[戳一戳]';
      break;
    case 'shake':
      out.text += '[窗口抖动]';
      break;
    default:
      if (type) out.text += `[${type}]`;
      break;
  }
  if (type) out.elements.push({ type, data });
}

function emptyParsed(): ParsedCqMessage {
  return {
    text: '',
    resources: [],
    mentions: [],
    reply: null,
    forwardId: null,
    faceIds: [],
    elements: [],
    hasJson: false,
    hasLocation: false,
  };
}

/** 解析 CQ 码字符串（结果累加到 out）。 */
export function parseCqStringInto(out: ParsedCqMessage, raw: string): void {
  const re = /\[CQ:([a-zA-Z0-9_.-]+)((?:,[^\]]*)?)\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    if (m.index > last) out.text += cqUnescape(raw.slice(last, m.index));
    applySegment(out, m[1] ?? '', cqParams(m[2] ?? ''));
    last = m.index + m[0].length;
  }
  if (last < raw.length) out.text += cqUnescape(raw.slice(last));
}

/** 解析 OneBot 的 `message` 字段（字符串或消息段数组）。 */
export function parseOneBotMessage(message: unknown): ParsedCqMessage {
  const out = emptyParsed();
  if (typeof message === 'string') {
    parseCqStringInto(out, message);
    return out;
  }
  if (Array.isArray(message)) {
    for (const seg of message) {
      const rec = asRecord(seg);
      if (!rec) continue;
      const data = asRecord(rec.data) ?? {};
      applySegment(out, str(rec.type) ?? '', data);
    }
    return out;
  }
  const single = asRecord(message);
  if (single) {
    const type = str(single.type);
    if (type) applySegment(out, type, asRecord(single.data) ?? {});
  }
  return out;
}
