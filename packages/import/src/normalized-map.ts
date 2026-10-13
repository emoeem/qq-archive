/**
 * 「归一化消息风格」对象的映射（generic-jsonl 每行一条，以及 qce-jsonl 里混入的条目）。
 *
 * 与 `mapQceMessage` 的差别：这里字段名已经是归档侧的名字（`msgKey` / `ts` / `direction` / `msgType`），
 * 所以只做校验 + 补算 + 兜底，不做 QCE 的字段重命名。
 *
 * 对未知字段的处理与 QCE 一致：塞进 `extra`，绝不静默丢弃。
 */
import type {
  Direction,
  MessageElement,
  NormalizedMessage,
  ReplyRef,
  ResourceRef,
} from '../../core/src/index.ts';
import { messageKeyOf } from '../../core/src/index.ts';
import {
  asBool,
  asRecord,
  asString,
  elementsFromContent,
  extractForwardId,
  extractReply,
  inferMessageType,
  mentionsFromContent,
  mentionsFromElements,
  resourcesFromContent,
  resolveTs,
  truncateRaw,
} from './qce-map.ts';
import type { MapMessageContext } from './qce-map.ts';

/** 已被域模型覆盖的键；其余进 `extra`。 */
const KNOWN_KEYS = new Set([
  'msgKey',
  'msgId',
  'msg_id',
  'id',
  'seq',
  'ts',
  'timestamp',
  'time',
  'tsMs',
  'senderUid',
  'sender_uid',
  'senderUin',
  'sender_uin',
  'senderName',
  'sender_name',
  'isSelf',
  'is_self',
  'direction',
  'msgType',
  'msg_type',
  'type',
  'recalled',
  'system',
  'text',
  'elements',
  'mentions',
  'reply',
  'forwardId',
  'forward_id',
  'resources',
  'extra',
  'raw',
]);

function parseDirection(value: unknown): Direction | undefined {
  const s = asString(value);
  if (s === 'in' || s === 'out' || s === 'system') return s;
  return undefined;
}

function replyFromRecord(rec: Record<string, unknown>): ReplyRef | undefined {
  const reply: ReplyRef = {};
  const msgKey = asString(rec.msgKey) ?? asString(rec.msg_key);
  const msgId = asString(rec.msgId) ?? asString(rec.msg_id);
  const preview = asString(rec.preview);
  const senderName = asString(rec.senderName) ?? asString(rec.sender_name);
  if (msgKey !== undefined) reply.msgKey = msgKey;
  if (msgId !== undefined && msgId !== '0') {
    reply.msgId = msgId;
    if (reply.msgKey === undefined) reply.msgKey = messageKeyOf({ msgId, ts: 0 });
  }
  if (preview !== undefined) reply.preview = preview.slice(0, 500);
  if (senderName !== undefined) reply.senderName = senderName;
  return Object.keys(reply).length > 0 ? reply : undefined;
}

export interface NormalizedMapOptions {
  /** 写入 `extra.source` 的来源标签（可选）。 */
  sourceTag?: string;
}

/**
 * 归一化消息风格对象 → `NormalizedMessage`。
 * 不是对象时抛 `TypeError`，由导入器计入 failed/errors。
 */
export function mapNormalizedLike(
  raw: unknown,
  ctx: MapMessageContext,
  options: NormalizedMapOptions = {},
): NormalizedMessage {
  const rec = asRecord(raw);
  if (!rec) throw new TypeError('消息不是 JSON 对象');

  const elements: MessageElement[] = elementsFromContent(rec);
  const mentions = mentionsFromContent(rec);
  for (const m of mentionsFromElements(elements)) {
    if (!mentions.some((x) => x.uid === m.uid && x.name === m.name)) mentions.push(m);
  }
  const resources: ResourceRef[] = resourcesFromContent(rec, elements);

  const text = asString(rec.text) ?? '';
  const msgId = asString(rec.msgId) ?? asString(rec.msg_id) ?? asString(rec.id);
  const seq = asString(rec.seq);
  const ts = resolveTs(rec.ts ?? rec.tsMs ?? rec.timestamp, rec.time);
  const senderUid = asString(rec.senderUid) ?? asString(rec.sender_uid);
  const senderUin = asString(rec.senderUin) ?? asString(rec.sender_uin);
  const senderName =
    asString(rec.senderName) ?? asString(rec.sender_name) ?? senderUid ?? senderUin;

  const system = asBool(rec.system) === true;
  const recalled = asBool(rec.recalled) === true;

  let isSelf = asBool(rec.isSelf) ?? asBool(rec.is_self);
  if (isSelf === undefined && senderUid !== undefined && ctx.session.selfUid !== undefined) {
    isSelf = senderUid === ctx.session.selfUid;
  } else if (isSelf === undefined && senderUin !== undefined && ctx.session.selfUin !== undefined) {
    isSelf = senderUin === ctx.session.selfUin;
  } else if (isSelf === undefined && (senderUid !== undefined || senderUin !== undefined)) {
    isSelf = false;
  }

  let direction: Direction = system ? 'system' : isSelf === true ? 'out' : 'in';
  const explicitDirection = parseDirection(rec.direction);
  if (!system && explicitDirection !== undefined) direction = explicitDirection;

  const msgType = inferMessageType({
    explicit: asString(rec.msgType) ?? asString(rec.msg_type) ?? asString(rec.type),
    elements,
    resources,
    text,
    system,
  });

  const explicitKey = asString(rec.msgKey) ?? asString(rec.msg_key);
  const message: NormalizedMessage = {
    msgKey:
      explicitKey ??
      messageKeyOf({ msgId, ts, senderUid, senderUin, text, resources, seq }),
    ts,
    direction,
    msgType,
    text,
  };
  if (msgId !== undefined) message.msgId = msgId;
  if (seq !== undefined) message.seq = seq;
  if (senderUid !== undefined) message.senderUid = senderUid;
  if (senderUin !== undefined) message.senderUin = senderUin;
  if (senderName !== undefined) message.senderName = senderName;
  if (isSelf !== undefined) message.isSelf = isSelf;
  if (recalled) message.recalled = true;
  if (system) message.system = true;
  if (elements.length > 0) message.elements = elements;
  if (mentions.length > 0) message.mentions = mentions;

  const replyRecord = asRecord(rec.reply);
  const reply = replyRecord ? replyFromRecord(replyRecord) : extractReply(elements);
  if (reply !== undefined) message.reply = reply;

  const forwardId = asString(rec.forwardId) ?? asString(rec.forward_id) ?? extractForwardId(elements, rec);
  if (forwardId !== undefined) message.forwardId = forwardId;
  if (resources.length > 0) message.resources = resources;

  const extra: Record<string, unknown> = {};
  const rawExtra = asRecord(rec.extra);
  if (rawExtra) {
    for (const [k, v] of Object.entries(rawExtra)) extra[k] = v;
  }
  for (const [k, v] of Object.entries(rec)) {
    if (KNOWN_KEYS.has(k)) continue;
    if (k in extra) continue;
    extra[k] = v;
  }
  if (options.sourceTag !== undefined && !('source' in extra)) extra.source = options.sourceTag;
  if (Object.keys(extra).length > 0) message.extra = extra;

  const rawValue = truncateRaw(rec.raw);
  if (rawValue !== undefined) message.raw = rawValue;
  return message;
}

/** 这一行/这个对象是否「像归一化消息」（供 jsonl 分派与格式探测共用判断）。 */
export function looksNormalizedLike(value: unknown): boolean {
  const rec = asRecord(value);
  if (rec === null) return false;
  if (typeof rec.msgKey === 'string' || typeof rec.msg_key === 'string') return true;
  if (typeof rec.direction === 'string' || typeof rec.msgType === 'string') return true;
  return typeof rec.ts === 'number' && typeof rec.text === 'string';
}
