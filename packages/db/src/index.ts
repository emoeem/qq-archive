/**
 * SQLite 存储层（`@qqarchive/db`）。
 *
 * 设计约束：
 *  - 只依赖 Node 内置 `node:sqlite`，无第三方依赖、无原生编译。
 *  - 所有写操作在事务内；单条消息失败不影响整批，错误逐条收集。
 *  - FTS（unicode61 + 应用层 CJK 二元切分）与主表在同一事务写入，保证检索与归档一致。
 *  - 会话统计（条数/首末时间）在批量写入后重算，避免增量维护出错。
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, statSync, unlinkSync, readdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import {
  buildSearchText,
  planSearch,
  escapeHtml,
  formatTime,
  sessionKeyOf,
  type ChatType,
  type CollectStateRow,
  type Direction,
  type JobRecord,
  type LogLevel,
  type LogRecord,
  type MediaKind,
  type MediaStatus,
  type MessageRecord,
  type MessageType,
  type NormalizedMessage,
  type NormalizedSession,
  type Page,
  type SearchHit,
  type SessionRecord,
  type ArchiveStats,
  type BackupRecord,
  type ScopedLogger,
  type MessageElement,
} from '../../core/src/index.ts';
import { migrate, currentVersion, LATEST_VERSION } from './migrations.ts';

export interface MediaInput {
  sha256: string;
  kind: MediaKind;
  size: number;
  relPath: string;
  mime?: string | null;
  ext?: string | null;
  width?: number | null;
  height?: number | null;
  duration?: number | null;
  status?: MediaStatus;
  originUrl?: string | null;
  originPath?: string | null;
  failReason?: string | null;
  thumbPath?: string | null;
}

export interface MediaRow {
  id: number;
  sha256: string;
  kind: MediaKind;
  size: number;
  mime: string | null;
  ext: string | null;
  relPath: string;
  width: number | null;
  height: number | null;
  duration: number | null;
  status: MediaStatus;
  originUrl: string | null;
  originPath: string | null;
  failReason: string | null;
  refCount: number;
  createdAt: string;
  verifiedAt: string | null;
  thumbPath: string | null;
}

/**
 * 一条语音转文字结果。一个 media 最多一条（media_id 即主键）。
 * 空白转写（纯静音/无语音）也落库，text 为空串 —— 这样重跑转录不会
 * 反复调用 whisper 去得出同一个「什么都没有」的结论。
 */
export interface TranscriptRow {
  mediaId: number;
  text: string;
  language: string | null;
  engine: string;
  model: string | null;
  segments: number;
  elapsedMs: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface TranscriptInput {
  mediaId: number;
  text: string;
  language?: string | null;
  engine: string;
  model?: string | null;
  segments?: number;
  elapsedMs?: number | null;
}

export interface InsertResult {
  inserted: number;
  duplicate: number;
  failed: number;
  messageIds: number[];
  errors: string[];
}

export interface DbOptions {
  path: string;
  logger?: ScopedLogger;
  /** 只读打开（备份校验/诊断用）。 */
  readOnly?: boolean;
}

/* ------------------------------------------------------------------ */
/* 行 → 领域对象                                                        */
/* ------------------------------------------------------------------ */

interface RawSession {
  id: number;
  account_uid: string;
  chat_type: string;
  peer_uid: string;
  peer_uin: string | null;
  name: string | null;
  remark: string | null;
  member_count: number | null;
  last_message_at: number | null;
  first_message_at: number | null;
  message_count: number;
  source: string | null;
}

function toSession(r: RawSession): SessionRecord {
  return {
    id: r.id,
    accountUid: r.account_uid,
    chatType: r.chat_type as ChatType,
    peerUid: r.peer_uid,
    peerUin: r.peer_uin,
    name: r.name,
    remark: r.remark,
    memberCount: r.member_count,
    lastMessageAt: r.last_message_at,
    firstMessageAt: r.first_message_at,
    messageCount: r.message_count,
    source: r.source,
  };
}

interface RawMedia {
  id: number;
  sha256: string;
  kind: string;
  size: number;
  mime: string | null;
  ext: string | null;
  rel_path: string;
  width: number | null;
  height: number | null;
  duration: number | null;
  status: string;
  origin_url: string | null;
  origin_path: string | null;
  fail_reason: string | null;
  ref_count: number;
  created_at: string;
  verified_at: string | null;
  thumb_path: string | null;
}

function toMedia(r: RawMedia): MediaRow {
  return {
    id: r.id,
    sha256: r.sha256,
    kind: r.kind as MediaKind,
    size: r.size,
    mime: r.mime,
    ext: r.ext,
    relPath: r.rel_path,
    width: r.width,
    height: r.height,
    duration: r.duration,
    status: r.status as MediaStatus,
    originUrl: r.origin_url,
    originPath: r.origin_path,
    failReason: r.fail_reason,
    refCount: r.ref_count,
    createdAt: r.created_at,
    verifiedAt: r.verified_at,
    thumbPath: r.thumb_path,
  };
}

interface RawTranscript {
  media_id: number;
  text: string;
  language: string | null;
  engine: string;
  model: string | null;
  segments: number;
  elapsed_ms: number | null;
  created_at: string;
  updated_at: string;
}

function toTranscript(r: RawTranscript): TranscriptRow {
  return {
    mediaId: r.media_id,
    text: r.text,
    language: r.language,
    engine: r.engine,
    model: r.model,
    segments: r.segments,
    elapsedMs: r.elapsed_ms,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function jsonOrNull(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}

function parseJson<T>(v: unknown, fallback: T): T {
  if (typeof v !== 'string' || !v) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

/* ------------------------------------------------------------------ */
/* 引用（回复）关系                                                     */
/* ------------------------------------------------------------------ */

/** 一条待解析的引用关系：目标消息可能在 msg_key 上，也可能只有原始 msg_id。 */
export interface ReplyLookup {
  sessionId: number;
  msgKey?: string | null;
  msgId?: string | null;
}

/** 引用目标消息的预览（用于时间线上的「↩ 引用内容」）。 */
export interface ReplyPreview {
  /** 目标消息在本库中的 id —— 前端据此再取详情。 */
  id: number;
  sessionId: number;
  text: string;
  senderName: string | null;
  ts: number;
  msgType: MessageType;
  recalled: boolean;
}

/** `getReplyPreviews()` 的结果键：会话 + 两种 id 的组合，保证一次查询后可精确取回。 */
export function replyLookupKey(ref: ReplyLookup): string {
  return `${ref.sessionId}\u0000${ref.msgKey ?? ''}\u0000${ref.msgId ?? ''}`;
}

/* ------------------------------------------------------------------ */
/* Db                                                                  */
/* ------------------------------------------------------------------ */

export class Db {
  readonly raw: DatabaseSync;
  readonly path: string;
  private logger?: ScopedLogger;
  private closed = false;
  /**
   * 预编译语句缓存（LRU）。键为 SQL 文本；`Map` 的迭代顺序即访问顺序，
   * 命中时先删后插以移到队尾，超限时淘汰队首（最久未使用）。
   */
  private stmtCache = new Map<string, ReturnType<DatabaseSync['prepare']>>();
  /** 预编译语句缓存上限，防止动态拼出的 SQL（如 `IN (?,?,…)`）无限增长。 */
  static readonly STATEMENT_CACHE_MAX = 256;

  constructor(opts: DbOptions) {
    this.path = opts.path;
    this.logger = opts.logger;
    if (opts.path !== ':memory:') mkdirSync(dirname(opts.path), { recursive: true });
    this.raw = new DatabaseSync(opts.path, { readOnly: opts.readOnly ?? false });
    if (!opts.readOnly) {
      this.raw.exec('PRAGMA journal_mode = WAL');
      this.raw.exec('PRAGMA synchronous = NORMAL');
      this.raw.exec('PRAGMA foreign_keys = ON');
      this.raw.exec('PRAGMA busy_timeout = 5000');
      migrate(this.raw, (m) => this.logger?.info(m));
    }
  }

  /** 复用预编译语句（性能关键路径）。LRU：命中移到队尾，超限淘汰队首。 */
  private stmt(sql: string) {
    const cached = this.stmtCache.get(sql);
    if (cached) {
      // 重新插入以标记为最近使用（Map 保持插入顺序）
      this.stmtCache.delete(sql);
      this.stmtCache.set(sql, cached);
      return cached;
    }
    const s = this.raw.prepare(sql);
    if (this.stmtCache.size >= Db.STATEMENT_CACHE_MAX) {
      const oldest = this.stmtCache.keys().next().value;
      if (oldest !== undefined) this.stmtCache.delete(oldest);
    }
    this.stmtCache.set(sql, s);
    return s;
  }

  /** 当前缓存的预编译语句条数（供测试与诊断使用）。 */
  get statementCacheSize(): number {
    return this.stmtCache.size;
  }

  private tx<T>(fn: () => T): T {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (err) {
      try {
        this.raw.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stmtCache.clear();
    try {
      this.raw.close();
    } catch {
      /* ignore */
    }
  }

  schemaVersion(): number {
    return currentVersion(this.raw);
  }

  health(): { ok: boolean; schemaVersion: number } {
    try {
      this.raw.prepare('SELECT 1').get();
      return { ok: true, schemaVersion: this.schemaVersion() };
    } catch {
      return { ok: false, schemaVersion: 0 };
    }
  }

  /* ---------------- 账号 / 会话 ---------------- */

  ensureAccount(a: { uid: string; uin?: string | null; displayName?: string | null }): void {
    if (!a.uid) throw new Error('ensureAccount: uid 必填');
    const now = new Date().toISOString();
    this.stmt(
      `INSERT INTO accounts(uid, uin, display_name, created_at, updated_at) VALUES(?,?,?,?,?)
       ON CONFLICT(uid) DO UPDATE SET
         uin = COALESCE(excluded.uin, accounts.uin),
         display_name = COALESCE(excluded.display_name, accounts.display_name),
         updated_at = excluded.updated_at`,
    ).run(a.uid, a.uin ?? null, a.displayName ?? null, now, now);
  }

  ensureSession(s: NormalizedSession): SessionRecord {
    const key = sessionKeyOf(s.chatType, s.peerUid);
    this.ensureAccount({ uid: s.accountUid, uin: s.selfUin ?? null, displayName: s.selfName ?? null });
    const now = new Date().toISOString();
    const existing = this.getSessionByKey(s.accountUid, key);
    if (existing) {
      this.stmt(
        `UPDATE sessions SET
           name = COALESCE(?, name),
           remark = COALESCE(?, remark),
           peer_uin = COALESCE(?, peer_uin),
           member_count = COALESCE(?, member_count),
           source = COALESCE(?, source),
           updated_at = ?
         WHERE id = ?`,
      ).run(
        s.name || null,
        s.remark ?? null,
        s.peerUin ?? null,
        s.memberCount ?? null,
        s.source ?? null,
        now,
        existing.id,
      );
      return this.getSession(existing.id)!;
    }
    this.stmt(
      `INSERT INTO sessions(account_uid, chat_type, peer_uid, peer_uin, name, remark, member_count,
                           message_count, source, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?,0,?,?,?)`,
    ).run(
      s.accountUid,
      s.chatType,
      s.peerUid,
      s.peerUin ?? null,
      s.name || null,
      s.remark ?? null,
      s.memberCount ?? null,
      s.source ?? null,
      now,
      now,
    );
    const created = this.getSessionByKey(s.accountUid, key);
    if (!created) throw new Error(`ensureSession: 创建后仍找不到会话 ${s.accountUid}/${key}`);
    return created;
  }

  getSession(id: number): SessionRecord | null {
    const r = this.stmt('SELECT * FROM sessions WHERE id = ?').get(id) as RawSession | undefined;
    return r ? toSession(r) : null;
  }

  getSessionByKey(accountUid: string, sessionKey: string): SessionRecord | null {
    const r = this.stmt(
      `SELECT s.* FROM sessions s
       WHERE s.account_uid = ?
         AND (s.chat_type || ':' || s.peer_uid) = ?`,
    ).get(accountUid, sessionKey) as RawSession | undefined;
    return r ? toSession(r) : null;
  }

  listSessions(q: {
    accountUid?: string;
    chatType?: ChatType;
    keyword?: string;
    page?: number;
    pageSize?: number;
    sort?: 'recent' | 'messages' | 'name';
  }): Page<SessionRecord> & { items: Array<SessionRecord & { lastMessageText: string | null }> } {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (q.accountUid) {
      where.push('s.account_uid = ?');
      args.push(q.accountUid);
    }
    if (q.chatType) {
      where.push('s.chat_type = ?');
      args.push(q.chatType);
    }
    if (q.keyword) {
      where.push('(s.name LIKE ? OR s.remark LIKE ? OR s.peer_uid = ? OR s.peer_uin = ?)');
      const like = `%${q.keyword}%`;
      args.push(like, like, q.keyword, q.keyword);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (this.stmt(`SELECT COUNT(*) AS c FROM sessions s ${whereSql}`).get(...args) as { c: number }).c;
    const page = Math.max(1, q.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, q.pageSize ?? 50));
    const order =
      q.sort === 'messages'
        ? 's.message_count DESC, s.last_message_at DESC'
        : q.sort === 'name'
          ? 'COALESCE(s.name, s.peer_uid) COLLATE NOCASE ASC'
          : 's.last_message_at DESC NULLS LAST, s.id DESC';
    const rows = this.stmt(
      `SELECT s.*,
              (SELECT m.text FROM messages m WHERE m.session_id = s.id ORDER BY m.ts DESC LIMIT 1) AS last_text
       FROM sessions s ${whereSql}
       ORDER BY ${order} LIMIT ? OFFSET ?`,
    ).all(...args, pageSize, (page - 1) * pageSize) as unknown as Array<RawSession & { last_text: string | null }>;
    return {
      items: rows.map((r) => ({ ...toSession(r), lastMessageText: r.last_text })),
      total,
      page,
      pageSize,
    };
  }

  /** 重算会话的条数与首末时间（批量写入后调用）。 */
  touchSessionStats(sessionId: number): void {
    this.stmt(
      `UPDATE sessions SET
         message_count = (SELECT COUNT(*) FROM messages WHERE session_id = ?),
         first_message_at = (SELECT MIN(ts) FROM messages WHERE session_id = ?),
         last_message_at = (SELECT MAX(ts) FROM messages WHERE session_id = ?),
         updated_at = ?
       WHERE id = ?`,
    ).run(sessionId, sessionId, sessionId, new Date().toISOString(), sessionId);
  }

  /* ---------------- 消息写入 ---------------- */

  insertMessages(
    sessionId: number,
    accountUid: string,
    sessionKey: string,
    msgs: NormalizedMessage[],
    opts: { batchId?: number; source: string },
  ): InsertResult {
    const result: InsertResult = { inserted: 0, duplicate: 0, failed: 0, messageIds: [], errors: [] };
    if (msgs.length === 0) return result;
    const now = new Date().toISOString();
    const insertSql = `INSERT OR IGNORE INTO messages(
        account_uid, session_id, session_key, msg_key, msg_id, seq, ts, time_text,
        sender_uid, sender_uin, sender_name, is_self, direction, msg_type, recalled, system,
        text, elements, mentions, reply_to_msg_key, reply_to_id, forward_id, extra, raw,
        source, batch_id, filtered, filter_reason, created_at, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
    const ftsSql = 'INSERT INTO messages_fts(rowid, text, sender_name) VALUES(?,?,?)';
    const bigramSql = 'INSERT INTO messages_fts_bigram(rowid, text) VALUES(?,?)';
    const findSql = 'SELECT id FROM messages WHERE account_uid=? AND session_key=? AND msg_key=?';

    this.tx(() => {
      for (const m of msgs) {
        try {
          if (!m.msgKey) throw new Error('缺少 msgKey');
          if (!Number.isFinite(m.ts) || m.ts <= 0) throw new Error(`非法时间戳 ts=${m.ts}（消息 ${m.msgKey}）`);
          const text = (m.text ?? '').slice(0, 200_000);
          const elements = m.elements && m.elements.length ? jsonOrNull(m.elements.slice(0, 200)) : null;
          const mentions = m.mentions && m.mentions.length ? jsonOrNull(m.mentions.slice(0, 200)) : null;
          const info = this.stmt(insertSql)
            .run(
              accountUid,
              sessionId,
              sessionKey,
              m.msgKey,
              m.msgId ?? null,
              m.seq ?? null,
              Math.round(m.ts),
              formatTime(m.ts),
              m.senderUid ?? null,
              m.senderUin ?? null,
              m.senderName ?? null,
              m.isSelf ? 1 : 0,
              m.direction,
              m.msgType,
              m.recalled ? 1 : 0,
              m.system ? 1 : 0,
              text,
              elements,
              mentions,
              m.reply?.msgKey ?? null,
              m.reply?.msgId ?? null,
              m.forwardId ?? null,
              m.extra ? jsonOrNull(m.extra) : null,
              m.raw === undefined ? null : jsonOrNull(truncateRaw(m.raw)),
              opts.source,
              opts.batchId ?? null,
              m.filtered ? 1 : 0,
              m.filterReason ?? null,
              now,
              now,
            );
          const changes = Number(info.changes ?? 0);
          if (changes === 0) {
            result.duplicate++;
            const found = this.stmt(findSql).get(accountUid, sessionKey, m.msgKey) as { id: number } | undefined;
            if (found) result.messageIds.push(found.id);
            continue;
          }
          const rowid = Number(info.lastInsertRowid ?? 0);
          this.stmt(ftsSql).run(rowid, buildSearchText(text), buildSearchText(m.senderName ?? ''));
          this.stmt(bigramSql).run(rowid, buildSearchText(text));
          result.inserted++;
          result.messageIds.push(rowid);
          if (m.senderUid) this.upsertContact(m.senderUid, m.senderUin, m.senderName, now);
        } catch (err) {
          result.failed++;
          const msg = err instanceof Error ? err.message : String(err);
          if (result.errors.length < 50) result.errors.push(`${m.msgKey}: ${msg}`);
          this.logger?.warn(`插入消息失败 ${m.msgKey}: ${msg}`);
        }
      }
      this.touchSessionStats(sessionId);
    });
    return result;
  }

  private upsertContact(uid: string, uin?: string | null, name?: string | null, now?: string): void {
    const t = now ?? new Date().toISOString();
    this.stmt(
      `INSERT INTO contacts(uid, uin, nickname, first_seen_at, last_seen_at) VALUES(?,?,?,?,?)
       ON CONFLICT(uid) DO UPDATE SET
         uin = COALESCE(excluded.uin, contacts.uin),
         nickname = COALESCE(excluded.nickname, contacts.nickname),
         last_seen_at = excluded.last_seen_at`,
    ).run(uid, uin ?? null, name ?? null, t, t);
  }

  /* ---------------- 消息查询 ---------------- */

  private mediaFor(messageId: number): MessageRecord['media'] {
    const rows = this.stmt(
      `SELECT mm.filename, m.* FROM message_media mm JOIN media m ON m.id = mm.media_id
       WHERE mm.message_id = ? ORDER BY mm.ordinal ASC`,
    ).all(messageId) as unknown as Array<RawMedia & { filename: string | null }>;
    return rows.map((r) => ({
      mediaId: r.id,
      kind: r.kind as MediaKind,
      status: r.status as MediaStatus,
      filename: r.filename ?? r.rel_path.split('/').pop() ?? null,
      mime: r.mime,
      size: r.size,
      width: r.width,
      height: r.height,
      duration: r.duration,
      url: `/api/media/${r.id}/raw`,
      thumbUrl: r.thumb_path ? `/api/media/${r.id}/thumb` : null,
      failReason: r.fail_reason,
    }));
  }

  private toMessage(r: Record<string, unknown>): MessageRecord {
    const id = r.id as number;
    return {
      id,
      accountUid: r.account_uid as string,
      sessionId: r.session_id as number,
      sessionKey: r.session_key as string,
      msgKey: r.msg_key as string,
      msgId: (r.msg_id as string) ?? null,
      seq: (r.seq as string) ?? null,
      ts: r.ts as number,
      senderUid: (r.sender_uid as string) ?? null,
      senderUin: (r.sender_uin as string) ?? null,
      senderName: (r.sender_name as string) ?? null,
      isSelf: Boolean(r.is_self),
      direction: r.direction as Direction,
      msgType: r.msg_type as MessageType,
      recalled: Boolean(r.recalled),
      system: Boolean(r.system),
      text: (r.text as string) ?? '',
      elements: parseJson<MessageElement[] | null>(r.elements, null),
      mentions: parseJson<MessageRecord['mentions']>(r.mentions, null),
      replyToId: (r.reply_to_id as string) ?? null,
      replyToMsgKey: (r.reply_to_msg_key as string) ?? null,
      forwardId: (r.forward_id as string) ?? null,
      extra: parseJson<Record<string, unknown> | null>(r.extra, null),
      source: (r.source as string) ?? 'import',
      filtered: Boolean(r.filtered),
      filterReason: (r.filter_reason as string) ?? null,
      media: this.mediaFor(id),
    };
  }

  listMessages(q: {
    sessionId: number;
    from?: number;
    to?: number;
    senderUid?: string;
    msgType?: MessageType;
    keyword?: string;
    direction?: Direction;
    before?: number;
    after?: number;
    limit?: number;
    order?: 'asc' | 'desc';
    includeRecalled?: boolean;
    /** 是否把命中过滤规则的消息也算进来（默认 false，只看"未过滤"的）。 */
    includeFiltered?: boolean;
  }): { items: MessageRecord[]; hasMore: boolean } {
    const where: string[] = ['m.session_id = ?'];
    const args: Array<string | number> = [q.sessionId];
    if (q.from !== undefined) {
      where.push('m.ts >= ?');
      args.push(q.from);
    }
    if (q.to !== undefined) {
      where.push('m.ts <= ?');
      args.push(q.to);
    }
    if (q.senderUid) {
      where.push('m.sender_uid = ?');
      args.push(q.senderUid);
    }
    if (q.msgType) {
      where.push('m.msg_type = ?');
      args.push(q.msgType);
    }
    if (q.direction) {
      where.push('m.direction = ?');
      args.push(q.direction);
    }
    if (q.before !== undefined) {
      where.push('m.ts < ?');
      args.push(q.before);
    }
    if (q.after !== undefined) {
      where.push('m.ts > ?');
      args.push(q.after);
    }
    if (!q.includeRecalled) where.push('m.recalled = 0');
    if (q.includeFiltered !== true) where.push('m.filtered = 0');
    if (q.keyword) {
      // 会话内关键字检索走 LIKE（会话内数据量可控），保留字面匹配语义
      where.push('m.text LIKE ?');
      args.push(`%${q.keyword}%`);
    }
    const limit = Math.min(500, Math.max(1, q.limit ?? 100));
    const order = q.order === 'asc' ? 'ASC' : 'DESC';
    const rows = this.raw
      .prepare(`SELECT m.* FROM messages m WHERE ${where.join(' AND ')} ORDER BY m.ts ${order}, m.id ${order} LIMIT ?`)
      .all(...args, limit + 1) as Array<Record<string, unknown>>;
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map((r) => this.toMessage(r));
    if (order === 'DESC') items.reverse();
    return { items, hasMore };
  }

  getMessage(id: number): MessageRecord | null {
    const r = this.stmt('SELECT * FROM messages WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? this.toMessage(r) : null;
  }

  /** 取一批消息 id 的正文（用于引用预览）。 */
  getMessageTexts(ids: number[]): Map<number, { text: string; senderName: string | null; ts: number }> {
    const out = new Map<number, { text: string; senderName: string | null; ts: number }>();
    if (ids.length === 0) return out;
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.raw
      .prepare(`SELECT id, text, sender_name, ts FROM messages WHERE id IN (${placeholders})`)
      .all(...ids) as Array<{ id: number; text: string; sender_name: string | null; ts: number }>;
    for (const r of rows) out.set(r.id, { text: r.text, senderName: r.sender_name, ts: r.ts });
    return out;
  }

  /**
   * 解析一批引用目标的预览。
   *
   * 源数据里引用关系有两种存法：`reply_to_msg_key`（本系统归一化后的 msg_key）与
   * `reply_to_id`（来自 QQ 的原始消息 id —— OneBot 采集的数据只有这一个）。因此
   * **优先按 msg_key 匹配，取不到再回退到 msg_id**，两者都限定在同一会话内，避免
   * 不同会话里 id 相同而误配。结果键由 `replyLookupKey()` 生成，调用方按同样方式取。
   */
  getReplyPreviews(refs: ReplyLookup[]): Map<string, ReplyPreview> {
    const out = new Map<string, ReplyPreview>();
    if (refs.length === 0) return out;
    const nonEmpty = (v: string | null | undefined): v is string => typeof v === 'string' && v !== '';
    const sessions = [...new Set(refs.map((r) => r.sessionId))];
    const keys = [...new Set(refs.map((r) => r.msgKey).filter(nonEmpty))];
    const ids = [...new Set(refs.map((r) => r.msgId).filter(nonEmpty))];
    if (keys.length === 0 && ids.length === 0) return out;

    const q = (n: number) => Array.from({ length: n }, () => '?').join(',');
    const conds: string[] = [];
    const args: Array<string | number> = [];
    if (keys.length > 0) {
      conds.push(`(session_id IN (${q(sessions.length)}) AND msg_key IN (${q(keys.length)}))`);
      args.push(...sessions, ...keys);
    }
    if (ids.length > 0) {
      conds.push(`(session_id IN (${q(sessions.length)}) AND msg_id IN (${q(ids.length)}))`);
      args.push(...sessions, ...ids);
    }
    const rows = this.raw
      .prepare(
        `SELECT id, session_id, msg_key, msg_id, text, sender_name, ts, msg_type, recalled
           FROM messages WHERE ${conds.join(' OR ')}`,
      )
      .all(...args) as Array<Record<string, unknown>>;

    const byKey = new Map<string, ReplyPreview>();
    const byId = new Map<string, ReplyPreview>();
    for (const r of rows) {
      const preview: ReplyPreview = {
        id: r.id as number,
        sessionId: r.session_id as number,
        text: (r.text as string) ?? '',
        senderName: (r.sender_name as string) ?? null,
        ts: r.ts as number,
        msgType: r.msg_type as MessageType,
        recalled: Boolean(r.recalled),
      };
      byKey.set(`${r.session_id as number}\u0000${r.msg_key as string}`, preview);
      if (typeof r.msg_id === 'string' && r.msg_id !== '') {
        byId.set(`${r.session_id as number}\u0000${r.msg_id}`, preview);
      }
    }
    for (const ref of refs) {
      const key = replyLookupKey(ref);
      if (out.has(key)) continue;
      const byMsgKey = nonEmpty(ref.msgKey) ? byKey.get(`${ref.sessionId}\u0000${ref.msgKey}`) : undefined;
      const byMsgId = nonEmpty(ref.msgId) ? byId.get(`${ref.sessionId}\u0000${ref.msgId}`) : undefined;
      const hit = byMsgKey ?? byMsgId;
      if (hit) out.set(key, hit);
    }
    return out;
  }

  /* ---------------- 全文检索 ---------------- */

  searchMessages(q: {
    keyword: string;
    accountUid?: string;
    sessionId?: number;
    chatType?: ChatType;
    from?: number;
    to?: number;
    msgType?: MessageType;
    senderUid?: string;
    page?: number;
    pageSize?: number;
    /** 是否把命中过滤规则的消息也搜出来（默认 false）。 */
    includeFiltered?: boolean;
  }): Page<SearchHit> {
    const keyword = (q.keyword ?? '').trim();
    const page = Math.max(1, q.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, q.pageSize ?? 20));
    if (!keyword) return { items: [], total: 0, page, pageSize };

    const where: string[] = [];
    const args: Array<string | number> = [];
    if (q.includeFiltered !== true) where.push('m.filtered = 0');
    if (q.accountUid) {
      where.push('m.account_uid = ?');
      args.push(q.accountUid);
    }
    if (q.sessionId !== undefined) {
      where.push('m.session_id = ?');
      args.push(q.sessionId);
    }
    if (q.chatType) {
      where.push('s.chat_type = ?');
      args.push(q.chatType);
    }
    if (q.from !== undefined) {
      where.push('m.ts >= ?');
      args.push(q.from);
    }
    if (q.to !== undefined) {
      where.push('m.ts <= ?');
      args.push(q.to);
    }
    if (q.msgType) {
      where.push('m.msg_type = ?');
      args.push(q.msgType);
    }
    if (q.senderUid) {
      where.push('m.sender_uid = ?');
      args.push(q.senderUid);
    }

    // 检索计划：多字 CJK / 西文走 FTS5 二元索引；单字 CJK 退化为字面 LIKE（bigram 索引命中不到）
    const plan = planSearch(keyword);
    const useFts = plan.mode === 'fts';
    const joinFts = useFts ? 'JOIN messages_fts_bigram f ON f.rowid = m.id' : '';
    let matchSql = '';
    if (plan.mode === 'fts') {
      matchSql = 'f.text MATCH ?';
      args.unshift(plan.query); // MATCH 出现在 WHERE 首部，参数须排在最前
    } else {
      where.push("m.text LIKE ? ESCAPE '\\'");
      args.push(`%${keyword.replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
    }
    const whereSql = [matchSql, ...where].filter(Boolean).join(' AND ');
    const baseArgs = args;

    const countSql = `SELECT COUNT(*) AS c FROM messages m JOIN sessions s ON s.id = m.session_id ${joinFts} WHERE ${whereSql}`;
    const total = (this.raw.prepare(countSql).get(...baseArgs) as { c: number }).c;

    const rows = this.raw
      .prepare(
        `SELECT m.*, s.name AS session_name, s.chat_type AS session_chat_type
         FROM messages m JOIN sessions s ON s.id = m.session_id ${joinFts}
         WHERE ${whereSql}
         ORDER BY m.ts DESC LIMIT ? OFFSET ?`,
      )
      .all(...baseArgs, pageSize, (page - 1) * pageSize) as Array<Record<string, unknown>>;

    const items: SearchHit[] = rows.map((r) => {
      const message = this.toMessage(r);
      return {
        message,
        sessionName: (r.session_name as string) ?? null,
        sessionChatType: ((r.session_chat_type as string) ?? 'other') as ChatType,
        snippet: highlight(message.text, keyword),
        score: 0,
      };
    });
    return { items, total, page, pageSize };
  }

  /* ---------------- 媒体 ---------------- */

  upsertMedia(input: MediaInput): { id: number; created: boolean } {
    const existing = this.stmt('SELECT id FROM media WHERE sha256 = ?').get(input.sha256) as { id: number } | undefined;
    const now = new Date().toISOString();
    if (existing) {
      this.stmt(
        `UPDATE media SET
           status = ?, fail_reason = COALESCE(?, fail_reason), verified_at = ?,
           thumb_path = COALESCE(?, thumb_path),
           origin_url = COALESCE(origin_url, ?), origin_path = COALESCE(origin_path, ?)
         WHERE id = ?`,
      ).run(input.status ?? 'present', input.failReason ?? null, now, input.thumbPath ?? null, input.originUrl ?? null, input.originPath ?? null, existing.id);
      return { id: existing.id, created: false };
    }
    const info = this.stmt(
      `INSERT INTO media(sha256, kind, size, mime, ext, rel_path, width, height, duration, status,
                         origin_url, origin_path, fail_reason, ref_count, created_at, verified_at, thumb_path)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?)`,
    ).run(
      input.sha256,
      input.kind,
      input.size,
      input.mime ?? null,
      input.ext ?? null,
      input.relPath,
      input.width ?? null,
      input.height ?? null,
      input.duration ?? null,
      input.status ?? 'present',
      input.originUrl ?? null,
      input.originPath ?? null,
      input.failReason ?? null,
      now,
      now,
      input.thumbPath ?? null,
    );
    return { id: Number(info.lastInsertRowid), created: true };
  }

  linkMessageMedia(
    messageId: number,
    mediaId: number,
    ordinal: number,
    filename?: string | null,
    declaredSize?: number | null,
  ): void {
    this.stmt(
      `INSERT INTO message_media(message_id, media_id, ordinal, filename, declared_size)
       VALUES(?,?,?,?,?)
       ON CONFLICT(message_id, media_id, ordinal) DO UPDATE SET
         filename = COALESCE(excluded.filename, message_media.filename),
         declared_size = COALESCE(excluded.declared_size, message_media.declared_size)`,
    ).run(messageId, mediaId, ordinal, filename ?? null, declaredSize ?? null);
    this.stmt(
      `UPDATE media SET ref_count = (SELECT COUNT(DISTINCT message_id) FROM message_media WHERE media_id = ?) WHERE id = ?`,
    ).run(mediaId, mediaId);
  }

  /**
   * 这条消息已经关联了几个**状态为 present** 的媒体。
   *
   * 采集每轮都会拉取重叠的时间窗口，重复消息本身会被唯一约束挡掉，但媒体不是：
   * 调用方据此判断「媒体已齐备」从而跳过重复下载。只数 present，
   * 因此缺失/损坏的媒体仍会在下一轮被重试（rkey 过期后正是靠这个恢复）。
   */
  countPresentMediaForMessage(messageId: number): number {
    const r = this.stmt(
      `SELECT COUNT(DISTINCT mm.media_id) AS c
         FROM message_media mm JOIN media m ON m.id = mm.media_id
        WHERE mm.message_id = ? AND m.status = 'present'`,
    ).get(messageId) as { c: number } | undefined;
    return Number(r?.c ?? 0);
  }

  /**
   * 按游标分页取消息的**过滤所需字段**（`refilter` 命令用）。
   *
   * 只取判断过滤要用的列，不装载正文以外的重字段（elements/raw/媒体关联），
   * 否则几十万条消息会把内存吃光。
   */
  listMessagesForFilter(opts: { afterId: number; limit: number }): Array<{
    id: number;
    text: string;
    senderUin: string | null;
    senderUid: string | null;
    senderName: string | null;
    msgType: string;
    filtered: boolean;
    filterReason: string | null;
  }> {
    const rows = this.raw
      .prepare(
        `SELECT id, text, sender_uin, sender_uid, sender_name, msg_type, filtered, filter_reason
           FROM messages WHERE id > ? ORDER BY id ASC LIMIT ?`,
      )
      .all(opts.afterId, opts.limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as number,
      text: (r.text as string) ?? '',
      senderUin: (r.sender_uin as string) ?? null,
      senderUid: (r.sender_uid as string) ?? null,
      senderName: (r.sender_name as string) ?? null,
      msgType: (r.msg_type as string) ?? 'text',
      filtered: Boolean(r.filtered),
      filterReason: (r.filter_reason as string) ?? null,
    }));
  }

  /**
   * 批量改写过滤标记。**只动 `filtered` / `filter_reason` 两列**，不碰正文与关联，
   * 也不删除任何行 —— 过滤规则改了以后重算标记必须是可逆的、无损的。
   */
  setMessageFilterFlags(updates: Array<{ id: number; filtered: boolean; reason: string | null }>): number {
    if (updates.length === 0) return 0;
    const stmt = this.stmt('UPDATE messages SET filtered = ?, filter_reason = ? WHERE id = ?');
    let changed = 0;
    this.tx(() => {
      for (const u of updates) {
        const info = stmt.run(u.filtered ? 1 : 0, u.filtered ? u.reason : null, u.id);
        changed += Number(info.changes ?? 0);
      }
    });
    return changed;
  }

  getMedia(id: number): MediaRow | null {
    const r = this.stmt('SELECT * FROM media WHERE id = ?').get(id) as RawMedia | undefined;
    return r ? toMedia(r) : null;
  }

  getMediaBySha(sha256: string): MediaRow | null {
    const r = this.stmt('SELECT * FROM media WHERE sha256 = ?').get(sha256) as RawMedia | undefined;
    return r ? toMedia(r) : null;
  }

  listMedia(q: {
    kind?: MediaKind;
    status?: MediaStatus;
    sessionId?: number;
    from?: number;
    to?: number;
    keyword?: string;
    /** true = 只看已转写的；false = 只看未转写的；undefined = 不限。 */
    transcribed?: boolean;
    page?: number;
    pageSize?: number;
  }): Page<
    MediaRow & {
      sessionName: string | null;
      messageId: number | null;
      ts: number | null;
      /** 语音转写文本；未转写为 null，转写为静音时是空串。 */
      transcript: string | null;
    }
  > {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (q.kind) {
      where.push('m.kind = ?');
      args.push(q.kind);
    }
    if (q.status) {
      where.push('m.status = ?');
      args.push(q.status);
    }
    if (q.keyword) {
      where.push('(m.rel_path LIKE ? OR m.origin_url LIKE ? OR mt.text LIKE ?)');
      args.push(`%${q.keyword}%`, `%${q.keyword}%`, `%${q.keyword}%`);
    }
    if (q.transcribed === true) {
      where.push('mt.media_id IS NOT NULL');
    } else if (q.transcribed === false) {
      where.push('mt.media_id IS NULL');
    }
    if (q.sessionId !== undefined) {
      where.push('s.id = ?');
      args.push(q.sessionId);
    }
    if (q.from !== undefined) {
      where.push('msg.ts >= ?');
      args.push(q.from);
    }
    if (q.to !== undefined) {
      where.push('msg.ts <= ?');
      args.push(q.to);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const from = `FROM media m
      LEFT JOIN message_media mm ON mm.media_id = m.id
      LEFT JOIN messages msg ON msg.id = mm.message_id
      LEFT JOIN sessions s ON s.id = msg.session_id
      LEFT JOIN media_transcripts mt ON mt.media_id = m.id`;
    const total = (this.raw.prepare(`SELECT COUNT(DISTINCT m.id) AS c ${from} ${whereSql}`).get(...args) as { c: number }).c;
    const page = Math.max(1, q.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, q.pageSize ?? 40));
    const rows = this.raw
      .prepare(
        `SELECT m.*, MIN(s.name) AS session_name, MIN(msg.id) AS message_id, MAX(msg.ts) AS msg_ts,
                MIN(mt.text) AS transcript_text
         ${from} ${whereSql}
         GROUP BY m.id
         ORDER BY MAX(msg.ts) DESC NULLS LAST, m.id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...args, pageSize, (page - 1) * pageSize) as unknown as Array<RawMedia & { session_name: string | null; message_id: number | null; msg_ts: number | null; transcript_text: string | null }>;
    return {
      items: rows.map((r) => ({
        ...toMedia(r),
        sessionName: r.session_name,
        messageId: r.message_id,
        ts: r.msg_ts,
        transcript: r.transcript_text ?? null,
      })),
      total,
      page,
      pageSize,
    };
  }

  markMediaStatus(id: number, status: MediaStatus, failReason?: string | null): void {
    this.stmt('UPDATE media SET status = ?, fail_reason = ?, verified_at = ? WHERE id = ?').run(
      status,
      failReason ?? null,
      new Date().toISOString(),
      id,
    );
  }

  setMediaThumb(id: number, thumbPath: string): void {
    this.stmt('UPDATE media SET thumb_path = ? WHERE id = ?').run(thumbPath, id);
  }

  mediaStats(): { total: number; present: number; missing: number; corrupt: number; bytes: number } {
    const r = this.stmt(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status='present' THEN 1 ELSE 0 END) AS present,
              SUM(CASE WHEN status='missing' THEN 1 ELSE 0 END) AS missing,
              SUM(CASE WHEN status='corrupt' THEN 1 ELSE 0 END) AS corrupt,
              COALESCE(SUM(CASE WHEN status='present' THEN size ELSE 0 END),0) AS bytes
       FROM media`,
    ).get() as { total: number; present: number | null; missing: number | null; corrupt: number | null; bytes: number };
    return {
      total: r.total ?? 0,
      present: r.present ?? 0,
      missing: r.missing ?? 0,
      corrupt: r.corrupt ?? 0,
      bytes: r.bytes ?? 0,
    };
  }

  /* ---------------- 语音转文字（media_transcripts） ---------------- */

  /** 写入/覆盖一条转写结果（同一 media 幂等，重复调用只更新）。 */
  upsertTranscript(input: TranscriptInput): void {
    const now = new Date().toISOString();
    this.stmt(
      `INSERT INTO media_transcripts
         (media_id, text, language, engine, model, segments, elapsed_ms, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(media_id) DO UPDATE SET
         text = excluded.text,
         language = excluded.language,
         engine = excluded.engine,
         model = excluded.model,
         segments = excluded.segments,
         elapsed_ms = excluded.elapsed_ms,
         updated_at = excluded.updated_at`,
    ).run(
      input.mediaId,
      input.text,
      input.language ?? null,
      input.engine,
      input.model ?? null,
      input.segments ?? 0,
      input.elapsedMs ?? null,
      now,
      now,
    );
  }

  getTranscript(mediaId: number): TranscriptRow | null {
    const r = this.stmt('SELECT * FROM media_transcripts WHERE media_id = ?').get(mediaId) as
      | RawTranscript
      | undefined;
    return r ? toTranscript(r) : null;
  }

  /** 批量取转写（媒体列表页避免 N+1）。 */
  getTranscripts(mediaIds: number[]): Map<number, TranscriptRow> {
    const out = new Map<number, TranscriptRow>();
    if (mediaIds.length === 0) return out;
    for (let i = 0; i < mediaIds.length; i += 400) {
      const chunk = mediaIds.slice(i, i + 400);
      const holes = chunk.map(() => '?').join(',');
      const rows = this.stmt(`SELECT * FROM media_transcripts WHERE media_id IN (${holes})`).all(
        ...chunk,
      ) as unknown as RawTranscript[];
      for (const r of rows) out.set(r.media_id, toTranscript(r));
    }
    return out;
  }

  /**
   * 待转写的音频：kind='audio'、文件仍在（present）、且还没有转写记录。
   * 用 NOT EXISTS 而非 NOT IN，避免 media_transcripts 出现 NULL 时的陷阱。
   */
  listUntranscribedAudio(limit = 50): MediaRow[] {
    const rows = this.stmt(
      `SELECT m.* FROM media m
        WHERE m.kind = 'audio' AND m.status = 'present'
          AND NOT EXISTS (SELECT 1 FROM media_transcripts t WHERE t.media_id = m.id)
        ORDER BY m.id
        LIMIT ?`,
    ).all(Math.max(1, limit)) as unknown as RawMedia[];
    return rows.map(toMedia);
  }

  deleteTranscript(mediaId: number): number {
    return Number(this.stmt('DELETE FROM media_transcripts WHERE media_id = ?').run(mediaId).changes);
  }

  transcriptStats(): { total: number; chars: number; engines: Array<{ engine: string; count: number }> } {
    const r = this.stmt(
      `SELECT COUNT(*) AS total, COALESCE(SUM(LENGTH(text)), 0) AS chars FROM media_transcripts`,
    ).get() as { total: number; chars: number | null };
    const engines = this.stmt(
      `SELECT engine, COUNT(*) AS count FROM media_transcripts GROUP BY engine ORDER BY count DESC`,
    ).all() as unknown as Array<{ engine: string; count: number }>;
    return { total: r.total ?? 0, chars: r.chars ?? 0, engines };
  }

  /** 删除没有任何消息引用的媒体记录（可选同时删文件）。 */
  gcOrphanMedia(mediaDir: string, dryRun: boolean): { deleted: number; bytes: number; ids: number[] } {
    const rows = this.stmt(
      `SELECT m.id, m.rel_path, m.size FROM media m
       LEFT JOIN message_media mm ON mm.media_id = m.id
       WHERE mm.media_id IS NULL`,
    ).all() as Array<{ id: number; rel_path: string; size: number }>;
    let bytes = 0;
    const ids: number[] = [];
    for (const r of rows) {
      bytes += r.size;
      ids.push(r.id);
      if (!dryRun) {
        const abs = resolve(mediaDir, r.rel_path);
        if (abs.startsWith(resolve(mediaDir)) && existsSync(abs)) {
          try {
            unlinkSync(abs);
          } catch {
            /* 文件删不掉不影响 DB 清理 */
          }
        }
        this.stmt('DELETE FROM media WHERE id = ?').run(r.id);
      }
    }
    return { deleted: rows.length, bytes, ids };
  }

  /* ---------------- 任务 ---------------- */

  createJob(j: {
    kind: 'import' | 'collect' | 'backup';
    format?: string;
    accountUid?: string;
    sourcePath?: string;
    options?: unknown;
  }): number {
    const now = new Date().toISOString();
    const info = this.stmt(
      `INSERT INTO import_jobs(kind, format, account_uid, source_path, status, options, created_at, updated_at)
       VALUES(?,?,?,?,'pending',?,?,?)`,
    ).run(j.kind, j.format ?? null, j.accountUid ?? null, j.sourcePath ?? null, jsonOrNull(j.options), now, now);
    return Number(info.lastInsertRowid);
  }

  updateJob(id: number, patch: Partial<JobRecord> & { progress?: number; stats?: unknown }): void {
    const map: Record<string, string> = {
      status: 'status',
      totalItems: 'total_items',
      processed: 'processed',
      inserted: 'inserted',
      duplicate: 'duplicate',
      failed: 'failed',
      mediaSaved: 'media_saved',
      mediaMissing: 'media_missing',
      progress: 'progress',
      message: 'message',
      error: 'error',
      startedAt: 'started_at',
      finishedAt: 'finished_at',
      stats: 'stats',
    };
    const sets: string[] = [];
    const args: Array<string | number | null> = [];
    for (const [k, col] of Object.entries(map)) {
      if (k in patch) {
        sets.push(`${col} = ?`);
        const v = (patch as Record<string, unknown>)[k];
        args.push(k === 'stats' ? jsonOrNull(v) : (v as string | number | null));
      }
    }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    args.push(new Date().toISOString());
    args.push(id);
    this.stmt(`UPDATE import_jobs SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  }

  getJob(id: number): JobRecord | null {
    const r = this.stmt('SELECT * FROM import_jobs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? toJob(r) : null;
  }

  listJobs(q: { status?: string; kind?: string; limit?: number; page?: number } = {}): Page<JobRecord> {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (q.status) {
      where.push('status = ?');
      args.push(q.status);
    }
    if (q.kind) {
      where.push('kind = ?');
      args.push(q.kind);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const page = Math.max(1, q.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, q.limit ?? 20));
    const total = (this.stmt(`SELECT COUNT(*) AS c FROM import_jobs ${whereSql}`).get(...args) as { c: number }).c;
    const rows = this.stmt(
      `SELECT * FROM import_jobs ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`,
    ).all(...args, pageSize, (page - 1) * pageSize) as Array<Record<string, unknown>>;
    return { items: rows.map(toJob), total, page, pageSize };
  }

  /* ---------------- 采集状态 ---------------- */

  getCollectState(source: string, accountUid: string, sessionKey: string): CollectStateRow | null {
    const r = this.stmt(
      'SELECT * FROM collect_state WHERE source = ? AND account_uid = ? AND session_key = ?',
    ).get(source, accountUid, sessionKey) as Record<string, unknown> | undefined;
    return r ? toCollectState(r) : null;
  }

  upsertCollectState(row: {
    source: string;
    accountUid: string;
    sessionKey: string;
    cursorTs?: number;
    cursorSeq?: string | null;
    lastError?: string | null;
    ok?: boolean;
    failures?: number;
  }): void {
    const now = new Date().toISOString();
    this.stmt(
      `INSERT INTO collect_state(source, account_uid, session_key, cursor_ts, cursor_seq,
                                 last_run_at, last_ok_at, last_error, consecutive_failures, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(source, account_uid, session_key) DO UPDATE SET
         cursor_ts = MAX(collect_state.cursor_ts, excluded.cursor_ts),
         cursor_seq = COALESCE(excluded.cursor_seq, collect_state.cursor_seq),
         last_run_at = excluded.last_run_at,
         last_ok_at = COALESCE(excluded.last_ok_at, collect_state.last_ok_at),
         last_error = excluded.last_error,
         consecutive_failures = excluded.consecutive_failures,
         updated_at = excluded.updated_at`,
    ).run(
      row.source,
      row.accountUid,
      row.sessionKey,
      row.cursorTs ?? 0,
      row.cursorSeq ?? null,
      now,
      row.ok ? now : null,
      row.lastError ?? null,
      row.failures ?? (row.ok ? 0 : 1),
      now,
      now,
    );
  }

  listCollectStates(): CollectStateRow[] {
    const rows = this.stmt('SELECT * FROM collect_state ORDER BY last_run_at DESC').all() as Array<Record<string, unknown>>;
    return rows.map(toCollectState);
  }

  /* ---------------- 备份 ---------------- */

  createBackup(row: { path: string; kind: string }): number {
    const now = new Date().toISOString();
    const info = this.stmt(
      `INSERT INTO backups(path, kind, status, created_at, started_at) VALUES(?,?,'running',?,?)`,
    ).run(row.path, row.kind, now, now);
    return Number(info.lastInsertRowid);
  }

  /**
   * 直接补登记一条**已完成**的备份行（用于把备份目录里已存在、但表里没有的快照对账回来）。
   *
   * 与 `createBackup()` 的区别是它允许指定 `created_at` —— 对账时要写快照的真实时间，
   * 而不是「发现它的时间」。已存在同一 `path` 时不重复插入。
   */
  registerExistingBackup(row: {
    path: string;
    kind: string;
    createdAt: string;
    sizeBytes?: number;
    messageCount?: number;
    mediaCount?: number;
    dbSha256?: string | null;
    verifyResult?: unknown;
  }): number | null {
    const existing = this.stmt('SELECT id FROM backups WHERE path = ?').get(row.path) as { id: number } | undefined;
    if (existing) return null;
    const info = this.stmt(
      `INSERT INTO backups(path, kind, status, size_bytes, message_count, media_count, db_sha256, verify_result, started_at, finished_at, created_at)
       VALUES(?,?,'done',?,?,?,?,?,?,?,?)`,
    ).run(
      row.path,
      row.kind,
      row.sizeBytes ?? 0,
      row.messageCount ?? 0,
      row.mediaCount ?? 0,
      row.dbSha256 ?? null,
      jsonOrNull(row.verifyResult),
      row.createdAt,
      row.createdAt,
      row.createdAt,
    );
    return Number(info.lastInsertRowid);
  }

  finishBackup(id: number, patch: Partial<BackupRecord> & { verifyResult?: unknown }): void {
    const sets: string[] = [];
    const args: Array<string | number | null> = [];
    const push = (col: string, v: unknown) => {
      sets.push(`${col} = ?`);
      args.push((v ?? null) as string | number | null);
    };
    if (patch.status !== undefined) push('status', patch.status);
    if (patch.sizeBytes !== undefined) push('size_bytes', patch.sizeBytes);
    if (patch.messageCount !== undefined) push('message_count', patch.messageCount);
    if (patch.mediaCount !== undefined) push('media_count', patch.mediaCount);
    if (patch.dbSha256 !== undefined) push('db_sha256', patch.dbSha256);
    if (patch.verifyResult !== undefined) push('verify_result', jsonOrNull(patch.verifyResult));
    if (patch.error !== undefined) push('error', patch.error);
    sets.push('finished_at = ?');
    args.push(new Date().toISOString());
    args.push(id);
    this.stmt(`UPDATE backups SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  }

  listBackups(limit = 20): BackupRecord[] {
    const rows = this.stmt('SELECT * FROM backups ORDER BY id DESC LIMIT ?').all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as number,
      path: r.path as string,
      kind: r.kind as string,
      status: r.status as BackupRecord['status'],
      sizeBytes: (r.size_bytes as number) ?? 0,
      messageCount: (r.message_count as number) ?? 0,
      mediaCount: (r.media_count as number) ?? 0,
      dbSha256: (r.db_sha256 as string) ?? null,
      verifyResult: parseJson(r.verify_result, null),
      error: (r.error as string) ?? null,
      startedAt: (r.started_at as string) ?? null,
      finishedAt: (r.finished_at as string) ?? null,
      createdAt: r.created_at as string,
    }));
  }


  /* ---------------- 清除（purge）：删除会话 / 全部数据 ---------------- */

  /**
   * 删除一个会话及其消息。
   *
   * 注意三件事（只有全对才算"删干净"）：
   *  1. `messages` 有 `ON DELETE CASCADE`（从 sessions），`message_media` 也跟着消息级联 ——
   *     但 **FTS 虚拟表不会自动清理**，必须手动按 rowid 删，否则索引里会留下永久垃圾；
   *  2. `media` 行**不**级联删除（同一张图可能被别的消息引用），所以只重算 `ref_count`；
   *  3. 真正删媒体文件是另一件事，由 `deleteOrphanMediaFiles()` 负责。
   */
  deleteSession(sessionId: number): { messages: number; mediaUnlinked: number } {
    const before = this.stmt('SELECT COUNT(*) AS c FROM messages WHERE session_id = ?').get(sessionId) as { c: number };
    const mediaIds = (
      this.stmt('SELECT DISTINCT media_id AS id FROM message_media WHERE message_id IN (SELECT id FROM messages WHERE session_id = ?)').all(
        sessionId,
      ) as Array<{ id: number }>
    ).map((r) => r.id);
    this.tx(() => {
      this.stmt('DELETE FROM messages_fts WHERE rowid IN (SELECT id FROM messages WHERE session_id = ?)').run(sessionId);
      this.stmt('DELETE FROM messages_fts_bigram WHERE rowid IN (SELECT id FROM messages WHERE session_id = ?)').run(sessionId);
      this.stmt('DELETE FROM messages WHERE session_id = ?').run(sessionId);
      this.stmt('DELETE FROM sessions WHERE id = ?').run(sessionId);
    });
    // `collect_state` 刻意保留：它按 sessionKey 记采集游标，与会话行不是一对一。
    // 删掉会话后再采集同一会话时，游标还在，可以接着增量采（而不是从头回填）。
    this.recountMediaRefs(mediaIds);
    return { messages: before.c, mediaUnlinked: mediaIds.length };
  }

  /** 删除**所有**归档数据（消息、会话、媒体索引、联系人、任务、采集游标、日志）。不可撤销。 */
  wipeAll(): { messages: number; sessions: number; media: number } {
    const counts = this.stmt(
      `SELECT (SELECT COUNT(*) FROM messages) AS messages,
              (SELECT COUNT(*) FROM sessions) AS sessions,
              (SELECT COUNT(*) FROM media) AS media`,
    ).get() as { messages: number; sessions: number; media: number };
    this.tx(() => {
      this.stmt('DELETE FROM messages_fts').run();
      this.stmt('DELETE FROM messages_fts_bigram').run();
      this.stmt('DELETE FROM messages').run();
      this.stmt('DELETE FROM sessions').run();
      this.stmt('DELETE FROM message_media').run();
      this.stmt('DELETE FROM media').run();
      this.stmt('DELETE FROM contacts').run();
      this.stmt('DELETE FROM collect_state').run();
      this.stmt('DELETE FROM import_jobs').run();
      this.stmt('DELETE FROM logs').run();
    });
    return counts;
  }

  /** 重算一批媒体的 `ref_count`（删消息/删关联后调用）。 */
  recountMediaRefs(mediaIds: number[]): void {
    if (mediaIds.length === 0) return;
    const stmt = this.stmt(
      'UPDATE media SET ref_count = (SELECT COUNT(DISTINCT message_id) FROM message_media WHERE media_id = media.id) WHERE id = ?',
    );
    this.tx(() => {
      for (const id of mediaIds) stmt.run(id);
    });
  }

  /**
   * 删除**没有任何消息引用**的媒体：先删文件，再删库里的行。
   * 与 `gcOrphanMedia()` 的区别是它会**同时删库行**（gc 只对账文件），
   * 因此删之前会再确认一次关联数为 0 —— 绝不因为一次误判删掉还在用的图。
   */
  deleteOrphanMediaFiles(mediaDir: string, dryRun: boolean): { deleted: number; bytes: number; ids: number[] } {
    const rows = this.stmt(
      `SELECT m.id, m.rel_path, m.size, m.thumb_path FROM media m
        WHERE NOT EXISTS (SELECT 1 FROM message_media mm WHERE mm.media_id = m.id)`,
    ).all() as Array<{ id: number; rel_path: string; size: number; thumb_path: string | null }>;
    let bytes = 0;
    const ids: number[] = [];
    const removed: number[] = [];
    for (const r of rows) {
      const stillReferenced = this.stmt('SELECT 1 FROM message_media WHERE media_id = ? LIMIT 1').get(r.id);
      if (stillReferenced) continue;
      bytes += r.size;
      ids.push(r.id);
      removed.push(r.id);
      if (dryRun) continue;
      for (const rel of [r.rel_path, r.thumb_path]) {
        if (rel === null || rel === '') continue;
        const abs = resolve(mediaDir, rel);
        // 只删媒体根目录内的文件（与 /api/media 的边界校验同一原则）
        if (!abs.startsWith(resolve(mediaDir))) continue;
        try {
          if (existsSync(abs)) unlinkSync(abs);
        } catch {
          /* 文件删不掉不阻塞：先留着，下次再删 */
        }
      }
    }
    if (!dryRun && removed.length > 0) {
      const del = this.stmt('DELETE FROM media WHERE id = ?');
      this.tx(() => {
        for (const id of removed) del.run(id);
      });
    }
    return { deleted: ids.length, bytes, ids };
  }

  /** 删掉一条备份记录（保留份数裁剪用；文件删除由调用方负责）。 */
  deleteBackup(id: number): void {
    this.stmt('DELETE FROM backups WHERE id = ?').run(id);
  }

  /** 把一条备份记录的路径改指到新位置（数据目录被搬到别处时用）。 */
  repointBackup(id: number, path: string): void {
    this.stmt('UPDATE backups SET path = ? WHERE id = ?').run(path, id);
  }

  /* ---------------- 日志 / 设置 / 统计 ---------------- */

  appendLog(e: { level: LogLevel; scope: string; message: string; data?: unknown }): void {
    this.stmt('INSERT INTO logs(ts, level, scope, message, data) VALUES(?,?,?,?,?)').run(
      new Date().toISOString(),
      e.level,
      e.scope,
      e.message.slice(0, 4000),
      e.data === undefined ? null : jsonOrNull(e.data),
    );
  }

  listLogs(q: { level?: LogLevel; scope?: string; limit?: number; page?: number; since?: string } = {}): Page<LogRecord> {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (q.level) {
      where.push('level = ?');
      args.push(q.level);
    }
    if (q.scope) {
      where.push('scope = ?');
      args.push(q.scope);
    }
    if (q.since) {
      where.push('ts >= ?');
      args.push(q.since);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const page = Math.max(1, q.page ?? 1);
    const pageSize = Math.min(500, Math.max(1, q.limit ?? 100));
    const total = (this.stmt(`SELECT COUNT(*) AS c FROM logs ${whereSql}`).get(...args) as { c: number }).c;
    const rows = this.stmt(`SELECT * FROM logs ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`).all(
      ...args,
      pageSize,
      (page - 1) * pageSize,
    ) as Array<Record<string, unknown>>;
    return {
      items: rows.map((r) => ({
        id: r.id as number,
        ts: r.ts as string,
        level: r.level as LogLevel,
        scope: r.scope as string,
        message: r.message as string,
        data: parseJson(r.data, null),
      })),
      total,
      page,
      pageSize,
    };
  }

  pruneLogs(keepDays: number): number {
    const cutoff = new Date(Date.now() - keepDays * 86_400_000).toISOString();
    const info = this.stmt('DELETE FROM logs WHERE ts < ?').run(cutoff);
    return Number(info.changes ?? 0);
  }

  getSetting(key: string): string | null {
    const r = this.stmt('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return r?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.stmt(
      `INSERT INTO settings(key, value, updated_at) VALUES(?,?,?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(key, value, new Date().toISOString());
  }

  allSettings(): Record<string, string> {
    const rows = this.stmt('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>;
    const out: Record<string, string> = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
  }

  stats(): ArchiveStats {
    const s = this.stmt(
      `SELECT
        (SELECT COUNT(*) FROM accounts) AS accounts,
        (SELECT COUNT(*) FROM sessions) AS sessions,
        (SELECT COUNT(*) FROM sessions WHERE chat_type='group') AS groups,
        (SELECT COUNT(*) FROM sessions WHERE chat_type='private') AS privates,
        (SELECT COUNT(*) FROM messages) AS messages,
        (SELECT COUNT(*) FROM messages WHERE ts >= ?) AS messages_today,
        (SELECT COUNT(*) FROM messages WHERE filtered = 1) AS messages_filtered,
        (SELECT MAX(ts) FROM messages) AS last_message_at,
        (SELECT MAX(last_ok_at) FROM collect_state) AS last_collect_at,
        (SELECT COUNT(*) FROM import_jobs WHERE status IN ('pending','running')) AS pending_jobs,
        (SELECT COUNT(*) FROM import_jobs WHERE status='failed') AS failed_jobs`,
    ).get(startOfToday()) as Record<string, number | null>;
    const m = this.mediaStats();
    const lastBackup = this.listBackups(1)[0];
    return {
      accounts: s.accounts ?? 0,
      sessions: s.sessions ?? 0,
      groups: s.groups ?? 0,
      privates: s.privates ?? 0,
      messages: s.messages ?? 0,
      messagesToday: s.messages_today ?? 0,
      messagesFiltered: s.messages_filtered ?? 0,
      mediaTotal: m.total,
      mediaPresent: m.present,
      mediaMissing: m.missing,
      mediaBytes: m.bytes,
      lastMessageAt: s.last_message_at ?? null,
      lastCollectAt: (s.last_collect_at as unknown as string) ?? null,
      lastBackupAt: lastBackup?.createdAt ?? null,
      lastBackupStatus: lastBackup?.status ?? null,
      pendingJobs: s.pending_jobs ?? 0,
      failedJobs: s.failed_jobs ?? 0,
    };
  }

  /** 数据库文件大小（字节）。 */
  fileSize(): number {
    if (this.path === ':memory:') return 0;
    try {
      return statSync(this.path).size;
    } catch {
      return 0;
    }
  }

  /** 媒体目录占用统计（实际磁盘，不依赖 DB）。 */
  static measureDir(dir: string): { files: number; bytes: number } {
    let files = 0;
    let bytes = 0;
    const walk = (d: string) => {
      let entries: string[];
      try {
        entries = readdirSync(d);
      } catch {
        return;
      }
      for (const name of entries) {
        const p = join(d, name);
        try {
          const st = statSync(p);
          if (st.isDirectory()) walk(p);
          else {
            files++;
            bytes += st.size;
          }
        } catch {
          /* 忽略不可读项 */
        }
      }
    };
    walk(dir);
    return { files, bytes };
  }
}

/* ------------------------------------------------------------------ */
/* 辅助                                                                */
/* ------------------------------------------------------------------ */

function toJob(r: Record<string, unknown>): JobRecord {
  return {
    id: r.id as number,
    kind: r.kind as string,
    format: (r.format as string) ?? null,
    accountUid: (r.account_uid as string) ?? null,
    sourcePath: (r.source_path as string) ?? null,
    status: r.status as JobRecord['status'],
    totalItems: (r.total_items as number) ?? 0,
    processed: (r.processed as number) ?? 0,
    inserted: (r.inserted as number) ?? 0,
    duplicate: (r.duplicate as number) ?? 0,
    failed: (r.failed as number) ?? 0,
    mediaSaved: (r.media_saved as number) ?? 0,
    mediaMissing: (r.media_missing as number) ?? 0,
    progress: (r.progress as number) ?? 0,
    message: (r.message as string) ?? null,
    error: (r.error as string) ?? null,
    options: parseJson(r.options, null),
    stats: parseJson(r.stats, null),
    startedAt: (r.started_at as string) ?? null,
    finishedAt: (r.finished_at as string) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

function toCollectState(r: Record<string, unknown>): CollectStateRow {
  return {
    source: r.source as string,
    accountUid: (r.account_uid as string) ?? null,
    sessionKey: (r.session_key as string) ?? '',
    cursorTs: (r.cursor_ts as number) ?? 0,
    cursorSeq: (r.cursor_seq as string) ?? null,
    lastRunAt: (r.last_run_at as string) ?? null,
    lastOkAt: (r.last_ok_at as string) ?? null,
    lastError: (r.last_error as string) ?? null,
    consecutiveFailures: (r.consecutive_failures as number) ?? 0,
  };
}

/** 原始记录可能极大（含 base64 头像），截断到 8KB 保存。 */
function truncateRaw(raw: unknown): unknown {
  const s = (() => {
    try {
      return JSON.stringify(raw);
    } catch {
      return null;
    }
  })();
  if (s === null) return { note: 'unserializable' };
  if (s.length <= 8192) return raw;
  return { note: 'truncated', preview: s.slice(0, 8000), originalLength: s.length };
}

/** 生成命中片段：把关键字前后各 60 字取出来并做 HTML 转义 + 高亮。 */
function highlight(text: string, keyword: string): string {
  const flat = (text ?? '').replace(/\s+/g, ' ');
  const idx = flat.toLowerCase().indexOf(keyword.toLowerCase());
  const start = Math.max(0, idx < 0 ? 0 : idx - 60);
  const end = Math.min(flat.length, (idx < 0 ? 0 : idx) + keyword.length + 60);
  const raw = `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
  const escaped = escapeHtml(raw);
  if (idx < 0) return escaped;
  const needle = escapeHtml(keyword);
  return escaped.replace(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (m) => `<mark>${m}</mark>`);
}

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 打开数据库（自动建目录 + 迁移）。 */
export function openDatabase(opts: DbOptions): Db {
  return new Db(opts);
}

export { LATEST_VERSION, migrate, currentVersion };
