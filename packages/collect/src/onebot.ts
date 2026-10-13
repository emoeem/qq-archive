/**
 * OneBot v11 只读采集器。
 *
 * **安全边界（硬性）**：只允许调用下面 `READ_ONLY_ACTIONS` 白名单里的接口。
 * 任何写接口（send_msg / delete_msg / set_group_kick …）都不在白名单内，调用会被本地直接拒绝，
 * 根本不会发出 HTTP 请求 —— 这是"绝不误操作真实 QQ"的最后一道闸。
 */
import { basename } from 'node:path';
import {
  AppError,
  messageKeyOf,
  type MessageType,
  type NormalizedMessage,
  type ResourceRef,
} from '../../core/src/index.ts';

/** 本地错误构造器：core 的工厂函数不收 details，这里直接建 AppError 以便带上诊断信息。 */
const collErr = (m: string, d?: unknown) => new AppError('COLLECTOR_UNAVAILABLE', m, d);
const authErr = (m: string, d?: unknown) => new AppError('UNAUTHORIZED', m, d);
const forbErr = (m: string, d?: unknown) => new AppError('FORBIDDEN', m, d);
import { parseOneBotMessage } from './cq.ts';
import type { CollectSession, Collector, FetchOptions, ForwardNode, ProbeResult, SessionInfo } from './types.ts';
import { asArray, asRecord, errText, num, str, type FetchLike } from './util.ts';

/** 允许调用的只读 action 白名单。 */
export const READ_ONLY_ACTIONS: readonly string[] = [
  'get_login_info',
  'get_status',
  'get_version_info',
  'get_group_list',
  'get_friend_list',
  'get_group_msg_history',
  'get_friend_msg_history',
  'get_forward_msg',
  'get_image',
  'get_record',
  'get_file',
];

/** OneBot 里属于"凭据/权限"问题的 retcode，遇到就直接上报、不重试。 */
const AUTH_RETCODES = new Set([100, 102, 103, 104, 200]);

/**
 * 上游「这条消息不存在」应答的识别。
 *
 * NapCat 在会话没有任何消息、或翻页游标走到历史尽头时，history 接口返回
 * `status:"failed"` + `message:"消息<N>不存在"`（未带 `message_seq` 时 N 的字面量是 `undefined`）。
 * 只用于 `get_group_msg_history` / `get_friend_msg_history`，语义是「空页」而非故障。
 */
const EMPTY_HISTORY_RE = /消息\S*不存在/;

function isEmptyHistoryError(err: unknown): boolean {
  return err instanceof Error && EMPTY_HISTORY_RE.test(err.message);
}

export interface OneBotCollectorOptions {
  baseUrl: string;
  token?: string;
  fetchImpl?: FetchLike;
  /** 媒体下载的超时（毫秒）。 */
  mediaTimeoutMs?: number;
}

interface RawHistoryPage {
  messages: NormalizedMessage[];
  /** 本页最老一条的 message_seq（用于向前翻页）。 */
  oldestSeq: number | null;
  /** 本页最新一条的 message_seq。 */
  newestSeq: number | null;
}

export class OneBotCollector implements Collector {
  readonly kind = 'onebot';

  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly mediaTimeoutMs: number;
  private selfUin = '';

  constructor(opts: OneBotCollectorOptions) {
    this.baseUrl = String(opts.baseUrl ?? '').replace(/\/+$/, '');
    this.token = String(opts.token ?? '');
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.mediaTimeoutMs = opts.mediaTimeoutMs ?? 30_000;
    if (!this.baseUrl) throw collErr('OneBot baseUrl 为空', { baseUrl: opts.baseUrl });
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (this.token) h.authorization = `Bearer ${this.token}`;
    if (extra) Object.assign(h, extra);
    return h;
  }

  /** 调用一个只读 action；非白名单直接抛错（不发请求）。 */
  async call<T = unknown>(action: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!READ_ONLY_ACTIONS.includes(action)) {
      throw collErr(`拒绝调用非只读接口：${action}`, { action, allowed: READ_ONLY_ACTIONS });
    }
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/${action}`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(params),
      });
    } catch (err) {
      throw collErr(`OneBot ${action} 网络错误：${errText(err)}`, { action, cause: errText(err) });
    }
    if (res.status === 401) throw authErr(`OneBot ${action} 鉴权失败（HTTP 401）`, { action });
    if (res.status === 403) throw forbErr(`OneBot ${action} 被拒绝（HTTP 403）`, { action });
    if (!res.ok) throw collErr(`OneBot ${action} HTTP ${res.status}`, { action, status: res.status });

    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      throw collErr(`OneBot ${action} 返回非 JSON：${errText(err)}`, { action });
    }
    const rec = asRecord(body);
    if (!rec) throw collErr(`OneBot ${action} 响应结构非法`, { action });
    const retcode = num(rec.retcode);
    if (retcode !== undefined && retcode !== 0) {
      const msg = str(rec.message) ?? str(rec.msg) ?? `retcode=${retcode}`;
      if (AUTH_RETCODES.has(retcode)) throw authErr(`OneBot ${action} 被拒绝：${msg}`, { action, retcode });
      throw collErr(`OneBot ${action} 失败：${msg}`, { action, retcode });
    }
    return (rec.data ?? null) as T;
  }

  async probe(): Promise<ProbeResult> {
    try {
      const login = asRecord(await this.call('get_login_info')) ?? {};
      const status = asRecord(await this.call('get_status')) ?? {};
      const uin = str(login.user_id) ?? '';
      this.selfUin = uin;
      const online = status.online === undefined ? true : status.online === true;
      const good = status.good === undefined ? true : status.good === true;
      if (!online || !good) {
        return { ok: false, error: `登录态异常：online=${String(status.online)} good=${String(status.good)}` };
      }
      const out: ProbeResult = { ok: true };
      if (uin) out.uin = uin;
      const nickname = str(login.nickname);
      if (nickname) out.nickname = nickname;
      return out;
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
  }

  async listSessions(): Promise<SessionInfo[]> {
    const out: SessionInfo[] = [];
    const groups = asArray(await this.call('get_group_list'));
    for (const g of groups) {
      const rec = asRecord(g);
      if (!rec) continue;
      const id = str(rec.group_id);
      if (!id) continue;
      out.push({
        chatType: 'group',
        peerUid: `g:${id}`,
        peerUin: id,
        name: str(rec.group_name) ?? str(rec.group_remark) ?? `群 ${id}`,
      });
    }
    const friends = asArray(await this.call('get_friend_list'));
    for (const f of friends) {
      const rec = asRecord(f);
      if (!rec) continue;
      const id = str(rec.user_id);
      if (!id) continue;
      out.push({
        chatType: 'private',
        peerUid: `u:${id}`,
        peerUin: id,
        name: str(rec.remark) ?? str(rec.nickname) ?? `好友 ${id}`,
      });
    }
    return out;
  }

  /** 解析静态会话清单（`group:123456` / `private:10001`）。 */
  static parseSessionSpec(spec: string): SessionInfo | null {
    const raw = String(spec ?? '').trim();
    if (!raw) return null;
    const m = /^(group|private|friend|g|u|p)\s*[:：]\s*(.+)$/i.exec(raw);
    if (!m) return null;
    const kindRaw = (m[1] ?? '').toLowerCase();
    const id = (m[2] ?? '').trim();
    if (!id) return null;
    const chatType = kindRaw === 'group' || kindRaw === 'g' ? 'group' : 'private';
    if (chatType === 'group') {
      return { chatType, peerUid: `g:${id}`, peerUin: id, name: `群 ${id}` };
    }
    return { chatType, peerUid: `u:${id}`, peerUin: id, name: `好友 ${id}` };
  }

  /** 归一化一条 OneBot 消息；非法（缺 message_id / time）返回 null。 */
  private normalize(raw: unknown, session: CollectSession): NormalizedMessage | null {
    const rec = asRecord(raw);
    if (!rec) return null;
    const msgId = str(rec.message_id) ?? str(rec.real_id);
    const seconds = num(rec.time);
    if (!msgId || seconds === undefined || seconds <= 0) return null;
    const ts = Math.round(seconds * 1000);
    const parsed = parseOneBotMessage(rec.message ?? rec.raw_message);
    const sender = asRecord(rec.sender) ?? {};
    const senderUin = str(sender.user_id) ?? str(rec.user_id) ?? '';
    const senderName = str(sender.card) ?? str(sender.nickname) ?? senderUin;
    const isSelf = this.selfUin !== '' && senderUin === this.selfUin;
    const seq = num(rec.message_seq) ?? num(rec.real_seq);
    const senderUid = session.chatType === 'group' && senderUin ? `g:${session.peerUin}:${senderUin}` : senderUin || undefined;

    const msgType = pickMsgType(parsed);
    const seqText = seq === undefined ? undefined : String(seq);
    const reply = parsed.reply ? (parsed.reply.preview !== undefined
      ? { msgId: parsed.reply.msgId, preview: parsed.reply.preview }
      : { msgId: parsed.reply.msgId }) : undefined;

    const msgKey = messageKeyOf({
      msgId,
      ts,
      senderUid,
      senderUin: senderUin || undefined,
      text: parsed.text,
      resources: parsed.resources,
      seq: seqText,
    });

    const msg: NormalizedMessage = {
      msgKey,
      msgId,
      ts,
      direction: isSelf ? 'out' : 'in',
      msgType,
      text: parsed.text,
      isSelf,
      raw: rec,
    };
    if (seqText !== undefined) msg.seq = seqText;
    if (senderUid) msg.senderUid = senderUid;
    if (senderUin) msg.senderUin = senderUin;
    if (senderName) msg.senderName = senderName;
    if (parsed.elements.length) msg.elements = parsed.elements;
    if (parsed.mentions.length) msg.mentions = parsed.mentions;
    if (reply) msg.reply = reply;
    if (parsed.forwardId) msg.forwardId = parsed.forwardId;
    if (parsed.resources.length) msg.resources = parsed.resources;
    return msg;
  }

  private async historyPage(session: CollectSession, seq: number | undefined, count: number): Promise<RawHistoryPage> {
    const params: Record<string, unknown> = { count };
    if (session.chatType === 'group') params.group_id = Number(session.peerUin);
    else params.user_id = Number(session.peerUin);
    if (seq !== undefined) params.message_seq = seq;
    const action = session.chatType === 'group' ? 'get_group_msg_history' : 'get_friend_msg_history';
    let data: unknown;
    try {
      data = await this.call(action, params);
    } catch (err) {
      // NapCat 对「该会话没有任何消息」以及「游标已走到历史尽头」的应答是
      // `status:"failed", message:"消息<N>不存在"`（未带游标时 N 的字面量就是 "undefined"）。
      // 语义是「这里没有更多历史」，不是采集失败 —— 否则真实账号上一堆零历史联系人
      // 会刷出一片失败告警，把真正的故障淹没。
      if (isEmptyHistoryError(err)) return { messages: [], oldestSeq: null, newestSeq: null };
      throw err;
    }
    const list = Array.isArray(data) ? data : asArray(asRecord(data)?.messages);
    let oldestSeq: number | null = null;
    let newestSeq: number | null = null;
    const out: NormalizedMessage[] = [];
    for (const item of list) {
      const rec = asRecord(item);
      const s = rec ? num(rec.message_seq) ?? num(rec.real_seq) : undefined;
      if (s !== undefined) {
        if (oldestSeq === null || s < oldestSeq) oldestSeq = s;
        if (newestSeq === null || s > newestSeq) newestSeq = s;
      }
      const m = this.normalize(item, session);
      if (m) out.push(m);
    }
    return { messages: out, oldestSeq, newestSeq };
  }

  async fetchSince(session: CollectSession, sinceTs: number, opts: FetchOptions): Promise<NormalizedMessage[]> {
    const pageSize = Math.max(1, Math.floor(opts.pageSize) || 1);
    const maxPages = Math.max(1, Math.floor(opts.maxPages) || 1);
    const seen = new Map<string, NormalizedMessage>();
    let cursor: number | undefined;
    let pages = 0;
    let lastOldest: number | null = null;
    let covered = false;

    while (pages < maxPages) {
      const page = await this.historyPage(session, cursor, pageSize);
      pages += 1;
      if (page.messages.length === 0) {
        covered = true;
        break;
      }
      for (const m of page.messages) if (!seen.has(m.msgKey)) seen.set(m.msgKey, m);
      let minTs = Number.POSITIVE_INFINITY;
      for (const m of page.messages) if (m.ts < minTs) minTs = m.ts;
      if (minTs <= sinceTs) {
        covered = true;
        break;
      }
      // 服务端忽略 message_seq 游标时会返回同页 → 必须止损，否则死循环。
      if (page.oldestSeq === null || (lastOldest !== null && page.oldestSeq === lastOldest)) {
        covered = page.messages.length < pageSize;
        break;
      }
      lastOldest = page.oldestSeq;
      cursor = page.oldestSeq;
      if (page.messages.length < pageSize) {
        covered = true;
        break;
      }
    }

    const all = [...seen.values()].filter((m) => m.ts >= sinceTs);
    all.sort((a, b) => (a.ts - b.ts) || (Number(a.seq ?? 0) - Number(b.seq ?? 0)));
    void covered;
    return all;
  }

  /**
   * 拉取合并转发的子消息（只读 `get_forward_msg`）。
   *
   * 参数名在实现之间不统一：NapCat 用 `message_id`，部分实现（含部分 LLOneBot 版本）
   * 用 `id`。两个都带上，多余参数会被忽略 —— 比按实现分叉代码更省事、更难出错。
   *
   * 返回的每条子消息都已经过 `parseOneBotMessage`，因此文本、媒体资源、未知消息段
   * 与嵌套转发的 `forwardId` 都被保留下来。**不在这里递归**：递归与限流是调度器的
   * 职责（见 `forward.ts`）。
   */
  async fetchForward(id: string): Promise<ForwardNode[]> {
    const key = String(id ?? '').trim();
    if (!key) return [];
    const data = await this.call('get_forward_msg', { id: key, message_id: key });
    // 兼容两种包装：`data: {messages:[…]}` 与直接 `data: […]`。
    const list = Array.isArray(data) ? data : asArray(asRecord(data)?.messages ?? asRecord(data)?.message);
    const out: ForwardNode[] = [];
    for (const item of list) {
      const rec = asRecord(item);
      if (!rec) continue;
      // NapCat：`{type:'node', data:{…}}`；也有实现直接给扁平的节点对象。
      const node = asRecord(rec.data) ?? rec;
      const parsed = parseOneBotMessage(node.content ?? node.message);
      const seconds = num(node.time) ?? num(node.timestamp);
      // 有的实现给秒，有的给毫秒；> 1e11 视为已经是毫秒。
      const ts = seconds === undefined || seconds <= 0
        ? 0
        : Math.round(seconds > 1e11 ? seconds : seconds * 1000);
      const n: ForwardNode = {
        ts,
        text: parsed.text,
        msgType: pickMsgType(parsed),
        resources: parsed.resources,
      };
      // 发送者字段有两种落法：扁平（LLOneBot 风格 node.nickname）
      // 或嵌套在 node.sender 里（NapCat 真机实测：{user_id,nickname,card}）。
      const sender = asRecord(node.sender);
      const uin = str(node.user_id) ?? str(node.uin) ?? str(sender?.user_id);
      const name =
        str(sender?.card) ??
        str(sender?.nickname) ??
        str(node.nickname) ??
        str(node.name) ??
        str(node.card);
      if (uin) n.senderUin = uin;
      if (name) n.senderName = name;
      if (parsed.elements.length) n.elements = parsed.elements;
      if (parsed.forwardId) n.forwardId = parsed.forwardId;
      out.push(n);
    }
    return out;
  }

  /** 从直链或 OneBot 媒体接口拿字节；拿不到返回 null（不生成占位文件）。 */
  async fetchMedia(ref: ResourceRef): Promise<{ data: Uint8Array; filename?: string } | null> {
    const filename = ref.filename ?? (ref.localPath ? basename(ref.localPath) : undefined);
    if (ref.url) {
      try {
        const res = await this.fetchImpl(ref.url, { method: 'GET' });
        if (res.ok) {
          const buf = new Uint8Array(await res.arrayBuffer());
          const out: { data: Uint8Array; filename?: string } = { data: buf };
          if (filename) out.filename = filename;
          return out;
        }
      } catch {
        /* 直链失败则回落到 OneBot 接口 */
      }
    }
    const file = ref.localPath ?? ref.filename;
    if (!file) return null;
    const action = ref.kind === 'image' ? 'get_image' : ref.kind === 'audio' ? 'get_record' : ref.kind === 'file' ? 'get_file' : null;
    if (!action) return null;
    const params: Record<string, unknown> = { file };
    if (ref.kind === 'audio') params.out_format = 'mp3';
    try {
      const data = await this.call(action, params);
      const rec = asRecord(data);
      const b64 = str(rec?.base64) ?? str(rec?.data) ?? str(rec?.file);
      if (!b64) return null;
      const clean = b64.includes(',') && b64.startsWith('base64://') ? b64.slice('base64://'.length) : b64.replace(/^data:[^,]*,/, '');
      const bytes = Buffer.from(clean, 'base64');
      if (bytes.length === 0) return null;
      const out: { data: Uint8Array; filename?: string } = { data: new Uint8Array(bytes) };
      const name = str(rec?.file) ?? str(rec?.filename) ?? filename;
      if (name) out.filename = basename(name);
      return out;
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err) {
        const code = String((err as { code: unknown }).code);
        if (code === 'UNAUTHORIZED' || code === 'FORBIDDEN') throw err;
      }
      return null;
    }
  }
}

function pickMsgType(parsed: ReturnType<typeof parseOneBotMessage>): MessageType {
  if (parsed.forwardId) return 'forward';
  if (parsed.hasJson) return 'json';
  if (parsed.hasLocation) return 'location';
  if (parsed.reply) return 'reply';
  const kinds = new Set(parsed.resources.map((r) => r.kind));
  if (kinds.has('image')) return 'image';
  if (kinds.has('video')) return 'video';
  if (kinds.has('audio')) return 'audio';
  if (kinds.has('file')) return 'file';
  if (parsed.faceIds.length && !parsed.text.trim()) return 'face';
  if (!parsed.text.trim() && parsed.elements.length) return 'other';
  return 'text';
}
