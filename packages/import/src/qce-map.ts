/**
 * QCE（qq-chat-exporter）导出结构 → 归档领域模型 的映射。
 *
 * 只做「结构转换 + 字段重命名 + 类型收敛」，不做任何网络/磁盘 IO，方便单测。
 * 详细的字段映射表见 docs/format-mapping.md（那份文档与这里必须同步修改）。
 *
 * 设计原则：
 *  1. 宁可把不认识的字段塞进 `extra` / `raw`，也不静默丢弃；
 *  2. 无法映射为已知语义时收敛到 `MessageType='other'`，而不是猜；
 *  3. 时间戳统一成毫秒（QCE 是毫秒；但若出现 10 位秒级数字会按秒处理）。
 */
import type {
  ChatType,
  Direction,
  MediaKind,
  MessageElement,
  MessageType,
  NormalizedMessage,
  NormalizedSession,
  ReplyRef,
  ResourceRef,
} from '../../core/src/index.ts';
import { messageKeyOf, parseTimeString } from '../../core/src/index.ts';
import { extOfName, extFromUrl, kindFromType } from './media-util.ts';

/** 单条消息 rawMessage 的最大保留字符数；超出只留结构说明。 */
export const MAX_RAW_CHARS = 16_384;

// ---------------------------------------------------------------- 安全取值

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string | undefined {
  if (typeof value === 'string') return value.length > 0 ? value : undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'bigint') return value.toString();
  return undefined;
}

export function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

export function asBool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  return undefined;
}

/** 从若干候选键里取第一个字符串值。 */
function pickString(rec: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = asString(rec[key]);
    if (v !== undefined) return v;
  }
  return undefined;
}

function pickNumber(rec: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const v = asNumber(rec[key]);
    if (v !== undefined) return v;
  }
  return undefined;
}

// ------------------------------------------------------------------ 时间

/**
 * QCE 的时间统一成毫秒：
 *  - `timestamp` 数值：>= 1e12 视为毫秒，否则视为秒（×1000）；
 *  - 退化到 `time` 字符串（`YYYY-MM-DD HH:mm:ss`）。
 * 都拿不到返回 0，调用方据此记为失败条目（绝不伪造时间）。
 */
export function resolveTs(timestamp: unknown, time: unknown): number {
  const numeric = asNumber(timestamp);
  if (numeric !== undefined && numeric > 0) {
    return numeric < 1e12 ? Math.round(numeric * 1000) : Math.round(numeric);
  }
  if (typeof time === 'string') {
    const parsed = parseTimeString(time);
    if (parsed !== null && parsed > 0) return parsed;
  }
  const fallback = asNumber(time);
  if (fallback !== undefined && fallback > 0) {
    return fallback < 1e12 ? Math.round(fallback * 1000) : Math.round(fallback);
  }
  return 0;
}

// ------------------------------------------------------------------ 会话

export function mapChatType(raw: unknown): ChatType {
  const s = (asString(raw) ?? '').toLowerCase();
  if (s === 'group' || s === 'groupchat' || s === 'troop') return 'group';
  if (s === 'private' || s === 'friend' || s === 'c2c') return 'private';
  if (s === 'temp' || s === 'temporary' || s === 'temp_session') return 'temp';
  return 'other';
}

/** chatInfo 缺失时的兜底会话。 */
export function defaultSession(
  accountUid: string,
  source: string,
  name?: string,
): NormalizedSession {
  return {
    accountUid,
    chatType: 'other',
    peerUid: 'unknown',
    name: name && name.length > 0 ? name : '未知会话',
    source,
  };
}

/** QCE `chatInfo` → NormalizedSession。 */
export function sessionFromChatInfo(
  chat: unknown,
  accountUid: string,
  source: string,
): NormalizedSession {
  const c = asRecord(chat);
  if (!c) return defaultSession(accountUid, source);
  const chatType = mapChatType(c.type);
  const peerUid =
    pickString(c, ['peerUid', 'peer_uid']) ??
    pickString(c, ['peerUin', 'peer_uin']) ??
    (chatType === 'private' ? pickString(c, ['selfUid', 'self_uid']) : undefined) ??
    'unknown';
  const session: NormalizedSession = {
    accountUid,
    chatType,
    peerUid,
    name: pickString(c, ['name', 'chatName', 'title']) ?? '未知会话',
    source,
  };
  const peerUin = pickString(c, ['peerUin', 'peer_uin']);
  if (peerUin !== undefined) session.peerUin = peerUin;
  const memberCount = pickNumber(c, ['participantCount', 'memberCount', 'member_count']);
  if (memberCount !== undefined) session.memberCount = memberCount;
  const selfUid = pickString(c, ['selfUid', 'self_uid']);
  if (selfUid !== undefined) session.selfUid = selfUid;
  const selfUin = pickString(c, ['selfUin', 'self_uin']);
  if (selfUin !== undefined) session.selfUin = selfUin;
  const selfName = pickString(c, ['selfName', 'self_name']);
  if (selfName !== undefined) session.selfName = selfName;
  return session;
}

/**
 * 用新的 chatInfo 补充/覆盖会话信息。
 * 用于 JSONL 这种「会话信息出现在某些行」的场景：只覆盖有值的字段，不把已有的好字段清空。
 */
export function applyChatInfo(
  session: NormalizedSession,
  chat: unknown,
): NormalizedSession {
  const patch = sessionFromChatInfo(chat, session.accountUid, session.source ?? '');
  const merged: NormalizedSession = { ...session };
  if (patch.chatType !== 'other' || session.chatType === 'other') merged.chatType = patch.chatType;
  if (patch.peerUid !== 'unknown') merged.peerUid = patch.peerUid;
  if (patch.name !== '未知会话') merged.name = patch.name;
  if (patch.peerUin !== undefined) merged.peerUin = patch.peerUin;
  if (patch.memberCount !== undefined) merged.memberCount = patch.memberCount;
  if (patch.selfUid !== undefined) merged.selfUid = patch.selfUid;
  if (patch.selfUin !== undefined) merged.selfUin = patch.selfUin;
  if (patch.selfName !== undefined) merged.selfName = patch.selfName;
  return merged;
}

// ------------------------------------------------------------------ 元素

function normalizeElement(raw: unknown): MessageElement | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const type = asString(rec.type) ?? asString(rec.elementType) ?? 'unknown';
  let data = asRecord(rec.data);
  if (!data) {
    // 少数导出把 data 直接摊平在同一层
    const flat: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rec)) {
      if (k === 'type' || k === 'elementType') continue;
      flat[k] = v;
    }
    data = flat;
  }
  return { type, data };
}

export function elementsFromContent(content: Record<string, unknown>): MessageElement[] {
  const out: MessageElement[] = [];
  for (const raw of asArray(content.elements)) {
    const el = normalizeElement(raw);
    if (el) out.push(el);
  }
  return out;
}

const ELEMENT_TYPE_ALIASES: Record<string, string> = {
  at: 'at',
  mention: 'at',
  reply: 'reply',
  quote: 'reply',
  reference: 'reply',
  reply_to: 'reply',
  image: 'image',
  pic: 'image',
  picture: 'image',
  photo: 'image',
  sticker: 'image',
  video: 'video',
  short_video: 'video',
  audio: 'audio',
  voice: 'audio',
  record: 'audio',
  ptt: 'audio',
  file: 'file',
  face: 'face',
  market_face: 'face',
  marketface: 'face',
  forward: 'forward',
  multi_msg: 'forward',
  json: 'json',
  ark: 'json',
  xml: 'json',
  location: 'location',
  share_location: 'location',
  system: 'system',
};

function elementKindKey(el: MessageElement): string {
  const lower = el.type.toLowerCase();
  return ELEMENT_TYPE_ALIASES[lower] ?? lower;
}

export function mentionsFromContent(
  content: Record<string, unknown>,
): Array<{ uid?: string; name?: string; type?: string }> {
  const out: Array<{ uid?: string; name?: string; type?: string }> = [];
  for (const raw of asArray(content.mentions)) {
    const rec = asRecord(raw);
    if (!rec) continue;
    const mention: { uid?: string; name?: string; type?: string } = {};
    const uid = pickString(rec, ['uid', 'uin', 'id']);
    const name = pickString(rec, ['name', 'nickname', 'display']);
    const type = pickString(rec, ['type']);
    if (uid !== undefined) mention.uid = uid;
    if (name !== undefined) mention.name = name;
    if (type !== undefined) mention.type = type;
    if (Object.keys(mention).length > 0) out.push(mention);
  }
  // elements 里的 at 元素也要并入 mentions（QCE 的 mentions 字段有时为空）
  return out;
}

export function mentionsFromElements(elements: MessageElement[]): Array<{
  uid?: string;
  name?: string;
  type?: string;
}> {
  const out: Array<{ uid?: string; name?: string; type?: string }> = [];
  for (const el of elements) {
    if (elementKindKey(el) !== 'at') continue;
    const uid = pickString(el.data, ['uid', 'uin', 'target', 'id']);
    const name = pickString(el.data, ['name', 'nickname', 'display', 'text']);
    const mention: { uid?: string; name?: string; type?: string } = {};
    if (uid !== undefined) mention.uid = uid;
    if (name !== undefined) mention.name = name;
    if (Object.keys(mention).length > 0) out.push(mention);
  }
  return out;
}

// ------------------------------------------------------------------ 资源

function resourceFromRecord(rec: Record<string, unknown>): ResourceRef | null {
  const kind = kindFromType(rec.type ?? rec.kind);
  const ref: ResourceRef = { kind };
  const filename = pickString(rec, ['filename', 'fileName', 'name']);
  if (filename !== undefined) ref.filename = filename;
  const size = pickNumber(rec, ['size', 'fileSize', 'file_size']);
  if (size !== undefined) ref.size = size;
  const url = pickString(rec, ['url', 'downloadUrl', 'link']);
  if (url !== undefined) ref.url = url;
  const localPath = pickString(rec, ['localPath', 'local_path', 'path', 'filePath', 'file']);
  if (localPath !== undefined) ref.localPath = localPath;
  const width = pickNumber(rec, ['width']);
  if (width !== undefined) ref.width = width;
  const height = pickNumber(rec, ['height']);
  if (height !== undefined) ref.height = height;
  const duration = pickNumber(rec, ['duration', 'time']);
  if (duration !== undefined) ref.duration = duration;
  const sha = pickString(rec, ['sha256', 'sha']);
  if (sha !== undefined) ref.sha256 = sha.toLowerCase();
  if (
    ref.filename === undefined &&
    ref.url === undefined &&
    ref.localPath === undefined &&
    ref.size === undefined
  ) {
    return null; // 完全空对象，没有归档意义
  }
  return ref;
}

/**
 * content.resources + 媒体类 elements 汇总成 ResourceRef[]。
 *
 * 去重按「身份」而不是完整指纹：有 filename 时，同一 kind + filename（忽略大小写与首尾
 * 空白）就是同一个媒体 —— 同一个文件在 `content.resources` 与 `content.elements` 里各出现
 * 一次是 QCE 导出的常态，而 elements 那一份通常没有 url/localPath。只有没有 filename 时
 * 才回退到完整指纹，避免把两条真正不同的无来源记录错误合并。
 *
 * `content.resources` 优先（字段最全），`elements` 只用于**补全**已有条目的空字段：
 * 绝不新增重复条目、绝不用空值覆盖非空值。只在 elements 里出现过的媒体仍然产出 ——
 * 那种情况下确实没有 url/localPath，归档判为 missing 才是正确结论。
 */
export function resourcesFromContent(
  content: Record<string, unknown>,
  elements: MessageElement[],
): ResourceRef[] {
  const index = new Map<string, ResourceRef>();
  const out: ResourceRef[] = [];

  const identity = (ref: ResourceRef): string =>
    ref.filename !== undefined && ref.filename.trim().length > 0
      ? `${ref.kind}|${ref.filename.trim().toLowerCase()}`
      : `${ref.kind}|${ref.size ?? ''}|${ref.url ?? ''}|${ref.localPath ?? ''}`;

  const merge = (ref: ResourceRef | null): void => {
    if (!ref) return;
    const key = identity(ref);
    const existing = index.get(key);
    if (!existing) {
      index.set(key, ref);
      out.push(ref);
      return;
    }
    fillResourceMissing(existing, ref);
  };

  for (const raw of asArray(content.resources)) {
    merge(resourceFromRecord(asRecord(raw) ?? {}));
  }
  for (const el of elements) {
    const key = elementKindKey(el);
    if (key !== 'image' && key !== 'video' && key !== 'audio' && key !== 'file') continue;
    merge(resourceFromRecord({ type: key, ...el.data }));
  }
  return out;
}

/** 只用 source 的非空字段补 target 的空字段：空值绝不覆盖非空值。 */
function fillResourceMissing(target: ResourceRef, source: ResourceRef): void {
  if (target.filename === undefined && source.filename !== undefined) target.filename = source.filename;
  if (target.size === undefined && source.size !== undefined) target.size = source.size;
  if (target.url === undefined && source.url !== undefined) target.url = source.url;
  if (target.localPath === undefined && source.localPath !== undefined) target.localPath = source.localPath;
  if (target.width === undefined && source.width !== undefined) target.width = source.width;
  if (target.height === undefined && source.height !== undefined) target.height = source.height;
  if (target.duration === undefined && source.duration !== undefined) target.duration = source.duration;
  if (target.sha256 === undefined && source.sha256 !== undefined) target.sha256 = source.sha256;
}

// ------------------------------------------------------- reply / forward

export function extractReply(elements: MessageElement[]): ReplyRef | undefined {
  const el = elements.find((e) => elementKindKey(e) === 'reply');
  if (!el) return undefined;
  const d = el.data;
  const target = pickString(d, [
    'referencedMessageId',
    'referenced_message_id',
    'replyMsgId',
    'reply_msg_id',
    'msgId',
    'messageId',
    'id',
  ]);
  const preview = pickString(d, ['content', 'text', 'summary']);
  const senderName = pickString(d, ['senderName', 'sender_name', 'name', 'sender']);
  const reply: ReplyRef = {};
  if (target !== undefined && target !== '0') {
    reply.msgId = target;
    reply.msgKey = messageKeyOf({ msgId: target, ts: 0 });
  }
  if (preview !== undefined) reply.preview = preview.slice(0, 500);
  if (senderName !== undefined) reply.senderName = senderName;
  return Object.keys(reply).length > 0 ? reply : undefined;
}

export function extractForwardId(
  elements: MessageElement[],
  content: Record<string, unknown>,
): string | undefined {
  const direct = pickString(content, ['forwardId', 'forward_id', 'resId']);
  if (direct !== undefined) return direct;
  const el = elements.find((e) => elementKindKey(e) === 'forward');
  if (!el) return undefined;
  return pickString(el.data, ['id', 'resId', 'res_id', 'forwardId', 'forward_id', 'fileId', 'uuid']);
}

// -------------------------------------------------------------- 消息类型

const MESSAGE_TYPE_ALIASES: Record<string, MessageType> = {
  text: 'text',
  plain: 'text',
  image: 'image',
  pic: 'image',
  picture: 'image',
  photo: 'image',
  video: 'video',
  audio: 'audio',
  voice: 'audio',
  record: 'audio',
  file: 'file',
  document: 'file',
  face: 'face',
  sticker: 'face',
  market_face: 'face',
  reply: 'reply',
  quote: 'reply',
  forward: 'forward',
  multi_msg: 'forward',
  json: 'json',
  ark: 'json',
  xml: 'json',
  location: 'location',
  share_location: 'location',
  system: 'system',
  other: 'other',
};

export function inferMessageType(input: {
  explicit?: string;
  elements: MessageElement[];
  resources: ResourceRef[];
  text: string;
  system: boolean;
}): MessageType {
  if (input.system) return 'system';
  if (input.explicit !== undefined) {
    const mapped = MESSAGE_TYPE_ALIASES[input.explicit.trim().toLowerCase()];
    if (mapped !== undefined && mapped !== 'other') return mapped;
  }
  const keys = input.elements.map(elementKindKey);
  if (keys.includes('reply')) return 'reply';
  if (keys.includes('forward')) return 'forward';
  if (keys.includes('location')) return 'location';
  if (keys.includes('json')) return 'json';
  const resource = input.resources[0];
  if (resource) {
    if (resource.kind === 'image') return 'image';
    if (resource.kind === 'video') return 'video';
    if (resource.kind === 'audio') return 'audio';
    return 'file';
  }
  if (keys.includes('image')) return 'image';
  if (keys.includes('video')) return 'video';
  if (keys.includes('audio')) return 'audio';
  if (keys.includes('file')) return 'file';
  if (keys.includes('face')) return 'face';
  if (input.text.trim().length > 0) return 'text';
  return 'other';
}

// ------------------------------------------------------------- raw / extra

export function truncateRaw(raw: unknown): unknown {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'string') {
    if (raw.length <= MAX_RAW_CHARS) return raw;
    return { truncated: true, chars: raw.length, preview: raw.slice(0, MAX_RAW_CHARS) };
  }
  try {
    const json = JSON.stringify(raw);
    if (json === undefined) return undefined;
    if (json.length <= MAX_RAW_CHARS) return raw;
    return { truncated: true, chars: json.length, preview: json.slice(0, MAX_RAW_CHARS) };
  } catch {
    return { truncated: true, unserializable: true };
  }
}

/** 把源格式里「不映射到标准字段」的信息收进 extra（值只在存在时写入）。 */
export function collectExtra(input: {
  message: Record<string, unknown>;
  content: Record<string, unknown>;
  sender: Record<string, unknown>;
  /** 已被 MessageElement / mentions 覆盖的元素类型，不再重复进 extra。 */
  mappedElementTypes: Set<string>;
}): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  const time = pickString(input.message, ['time']);
  if (time !== undefined) extra.time = time;
  const html = pickString(input.content, ['html']);
  if (html !== undefined) extra.html = html;
  const rawType = asString(input.message.type);
  if (rawType !== undefined) extra.qceType = rawType;
  const title = pickString(input.sender, ['title']);
  if (title !== undefined) extra.senderTitle = title;
  const remark = pickString(input.sender, ['remark']);
  if (remark !== undefined) extra.senderRemark = remark;
  const groupCard = pickString(input.sender, ['groupCard', 'group_card']);
  if (groupCard !== undefined) extra.senderGroupCard = groupCard;
  const nickname = pickString(input.sender, ['nickname']);
  if (nickname !== undefined) extra.senderNickname = nickname;
  // 不认识的元素类型原样保留，避免新版本导出格式丢数据
  const unknownElements = asArray(input.content.elements)
    .map((raw) => asRecord(raw))
    .filter((rec): rec is Record<string, unknown> => rec !== null)
    .filter((rec) => {
      const type = (asString(rec.type) ?? '').toLowerCase();
      return type.length > 0 && !input.mappedElementTypes.has(type);
    });
  if (unknownElements.length > 0) extra.rawElements = unknownElements;
  return extra;
}

// ---------------------------------------------------------------- 消息主体

export interface MapMessageContext {
  accountUid: string;
  source: string;
  session: NormalizedSession;
}

/**
 * QCE 消息对象 → NormalizedMessage。
 * 输入不是对象时抛 TypeError，由导入器计入 failed/errors（不静默丢）。
 */
export function mapQceMessage(raw: unknown, ctx: MapMessageContext): NormalizedMessage {
  const message = asRecord(raw);
  if (!message) throw new TypeError('消息不是 JSON 对象');
  const sender = asRecord(message.sender) ?? {};
  const content = asRecord(message.content) ?? {};

  const elements = elementsFromContent(content);
  const mentions = mentionsFromContent(content);
  for (const m of mentionsFromElements(elements)) {
    if (!mentions.some((x) => x.uid === m.uid && x.name === m.name)) mentions.push(m);
  }
  const resources = resourcesFromContent(content, elements);

  const text = asString(content.text) ?? asString(message.text) ?? '';
  const msgId = asString(message.id);
  const seq = asString(message.seq);
  const ts = resolveTs(message.timestamp, message.time);
  const senderUid = pickString(sender, ['uid']);
  const senderUin = pickString(sender, ['uin']);
  const senderName =
    pickString(sender, ['groupCard', 'group_card']) ??
    pickString(sender, ['nickname', 'name', 'remark']) ??
    senderUid ??
    senderUin;

  const system = asBool(message.system) === true;
  const recalled = asBool(message.recalled) === true;

  let isSelf: boolean | undefined;
  const explicitSelf = asBool(message.isSelf);
  if (explicitSelf !== undefined) {
    isSelf = explicitSelf;
  } else if (senderUid !== undefined && ctx.session.selfUid !== undefined) {
    isSelf = senderUid === ctx.session.selfUid;
  } else if (senderUin !== undefined && ctx.session.selfUin !== undefined) {
    isSelf = senderUin === ctx.session.selfUin;
  } else if (senderUid !== undefined || senderUin !== undefined) {
    isSelf = false;
  }

  let direction: Direction;
  if (system) direction = 'system';
  else if (isSelf === true) direction = 'out';
  else direction = 'in';

  const msgType = inferMessageType({
    explicit: asString(message.type),
    elements,
    resources,
    text,
    system,
  });

  const mappedElementTypes = new Set<string>();
  for (const el of elements) {
    mappedElementTypes.add(el.type.toLowerCase());
    mappedElementTypes.add(elementKindKey(el));
  }

  const message2: NormalizedMessage = {
    msgKey: messageKeyOf({
      msgId,
      ts,
      senderUid,
      senderUin,
      text,
      resources,
      seq,
    }),
    ts,
    direction,
    msgType,
    text,
  };
  if (msgId !== undefined) message2.msgId = msgId;
  if (seq !== undefined) message2.seq = seq;
  if (senderUid !== undefined) message2.senderUid = senderUid;
  if (senderUin !== undefined) message2.senderUin = senderUin;
  if (senderName !== undefined) message2.senderName = senderName;
  if (isSelf !== undefined) message2.isSelf = isSelf;
  if (recalled) message2.recalled = true;
  if (system) message2.system = true;
  if (elements.length > 0) message2.elements = elements;
  if (mentions.length > 0) message2.mentions = mentions;
  const reply = extractReply(elements);
  if (reply !== undefined) message2.reply = reply;
  const forwardId = extractForwardId(elements, content);
  if (forwardId !== undefined) message2.forwardId = forwardId;
  if (resources.length > 0) message2.resources = resources;
  const extra = collectExtra({ message, content, sender, mappedElementTypes });
  if (Object.keys(extra).length > 0) message2.extra = extra;
  const rawValue = message.rawMessage ?? message.raw;
  const rawOut = truncateRaw(rawValue);
  if (rawOut !== undefined) message2.raw = rawOut;
  return message2;
}

/** 资源的扩展名推断（供媒体归档选择落盘扩展名）。 */
export function resourceExt(ref: ResourceRef): string | null {
  return extOfName(ref.filename) ?? extFromUrl(ref.url);
}

/** 把一批资源 kind 汇总成「本条消息涉及哪些媒体种类」（诊断/展示用）。 */
export function resourceKinds(refs: ResourceRef[]): MediaKind[] {
  return [...new Set(refs.map((r) => r.kind))];
}
