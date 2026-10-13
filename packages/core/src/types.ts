/**
 * 归档系统领域模型。
 *
 * 这些类型是 db / import / collect / server / web 之间的**唯一契约**，
 * 任何一方都不得私自扩展字段语义。改动这里等于改动公共接口。
 */

/** 聊天类型。 */
export type ChatType = 'private' | 'group' | 'temp' | 'other';

/** 消息方向。out = 本人发出，in = 对方发出，system = 系统提示。 */
export type Direction = 'in' | 'out' | 'system';

/** 归一化后的消息类型（用于筛选与图标展示）。 */
export type MessageType =
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'file'
  | 'face'
  | 'reply'
  | 'forward'
  | 'json'
  | 'location'
  | 'system'
  | 'other';

/** 媒体种类。 */
export type MediaKind = 'image' | 'video' | 'audio' | 'file' | 'other';

/** 媒体保存状态。present=已落盘且校验通过；missing=原始文件不存在；corrupt=校验失败；pending=待处理。 */
export type MediaStatus = 'present' | 'missing' | 'corrupt' | 'pending';

/** 消息中的一个结构化元素（弱类型透传，保持与源格式一致）。 */
export interface MessageElement {
  type: string;
  data: Record<string, unknown>;
}

/** 消息中提到的资源（图片/视频/语音/文件）。 */
export interface ResourceRef {
  kind: MediaKind;
  filename?: string;
  size?: number;
  url?: string;
  /** 源数据里的本地路径（可能是 QQ 缓存路径，随时失效）。 */
  localPath?: string;
  width?: number;
  height?: number;
  duration?: number;
  /** 已知的 sha256（部分导出会带）。 */
  sha256?: string;
}

/** 引用/回复关系。 */
export interface ReplyRef {
  /** 被引用消息在本归档内的 msg_key（尽力解析）。 */
  msgKey?: string;
  /** 源数据里的原始消息 id。 */
  msgId?: string;
  /** 被引用消息的预览文本。 */
  preview?: string;
  /** 被引用者。 */
  senderName?: string;
}

/** 归一化后的单条消息 —— 所有导入器都必须产出这个形状。 */
export interface NormalizedMessage {
  /** 稳定消息键。同一来源重复导入必须得到同一个值。 */
  msgKey: string;
  /** 源数据原始消息 id（尽力保留）。 */
  msgId?: string;
  /** 会话内序号（字符串，保留原始精度）。 */
  seq?: string;
  /** 毫秒时间戳。 */
  ts: number;
  senderUid?: string;
  senderUin?: string;
  senderName?: string;
  /** 是否本人发送。 */
  isSelf?: boolean;
  direction: Direction;
  msgType: MessageType;
  recalled?: boolean;
  system?: boolean;
  /** 纯文本正文（含 @、表情转写等可读形式）。 */
  text: string;
  elements?: MessageElement[];
  mentions?: Array<{ uid?: string; name?: string; type?: string }>;
  reply?: ReplyRef;
  forwardId?: string;
  resources?: ResourceRef[];
  /** 无法映射到标准字段但需要保留的原始数据。 */
  extra?: Record<string, unknown>;
  /** 原始记录（截断后保存，用于溯源；不得静默丢弃重要数据）。 */
  raw?: unknown;
  /**
   * 是否命中采集过滤规则。
   *
   * 注意语义：命中的消息**默认仍然入库**（防丢失优先），只是默认不在时间线/搜索里显示；
   * 只有 `filters.drop = true` 时才会被跳过存储（那种情况下消息根本不会走到这里）。
   */
  filtered?: boolean;
  /** 命中的过滤规则（人可读，写进 `messages.filter_reason`）。 */
  filterReason?: string;
}

/** 归一化后的会话。 */
export interface NormalizedSession {
  accountUid: string;
  chatType: ChatType;
  peerUid: string;
  peerUin?: string;
  name: string;
  remark?: string;
  memberCount?: number;
  selfUid?: string;
  selfUin?: string;
  selfName?: string;
  source?: string;
}

/** 导入器从文件里解析出来的一批内容。 */
export interface ImportBatch {
  session: NormalizedSession;
  messages: NormalizedMessage[];
  /** 源文件里的统计信息（如果有）。 */
  sourceStats?: Record<string, unknown>;
}

/** 会话（数据库读出）。 */
export interface SessionRecord {
  id: number;
  accountUid: string;
  chatType: ChatType;
  peerUid: string;
  peerUin: string | null;
  name: string | null;
  remark: string | null;
  memberCount: number | null;
  lastMessageAt: number | null;
  firstMessageAt: number | null;
  messageCount: number;
  source: string | null;
}

/** 消息（数据库读出，含展示所需的关联信息）。 */
export interface MessageRecord {
  id: number;
  accountUid: string;
  sessionId: number;
  sessionKey: string;
  msgKey: string;
  msgId: string | null;
  seq: string | null;
  ts: number;
  senderUid: string | null;
  senderUin: string | null;
  senderName: string | null;
  isSelf: boolean;
  direction: Direction;
  msgType: MessageType;
  recalled: boolean;
  system: boolean;
  text: string;
  elements: MessageElement[] | null;
  mentions: Array<{ uid?: string; name?: string; type?: string }> | null;
  replyToId: string | null;
  replyToMsgKey: string | null;
  forwardId: string | null;
  extra: Record<string, unknown> | null;
  source: string;
  media: MediaRef[];
  /** 命中采集过滤规则（默认不在时间线/搜索里显示，但**确实存在库里**，导出也会带上）。 */
  filtered: boolean;
  /** 命中的规则说明。 */
  filterReason: string | null;
}

/** 消息上挂载的媒体（面向展示）。 */
export interface MediaRef {
  mediaId: number;
  kind: MediaKind;
  status: MediaStatus;
  filename: string | null;
  mime: string | null;
  size: number;
  width: number | null;
  height: number | null;
  duration: number | null;
  /** 受保护的相对下载路径（前端需拼 API 前缀）。 */
  url: string;
  thumbUrl: string | null;
  failReason: string | null;
}

/** 归档总览统计。 */
export interface ArchiveStats {
  accounts: number;
  sessions: number;
  groups: number;
  privates: number;
  messages: number;
  messagesToday: number;
  /** 命中采集过滤规则的消息数（这些消息**仍在库里**，只是默认不显示）。 */
  messagesFiltered: number;
  mediaTotal: number;
  mediaPresent: number;
  mediaMissing: number;
  mediaBytes: number;
  lastMessageAt: number | null;
  lastCollectAt: string | null;
  lastBackupAt: string | null;
  lastBackupStatus: string | null;
  pendingJobs: number;
  failedJobs: number;
}

/** 分页结果。 */
export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** 搜索结果条目。 */
export interface SearchHit {
  message: MessageRecord;
  sessionName: string | null;
  sessionChatType: ChatType;
  /** 命中的高亮片段（已按安全规则转义，可直接插入 HTML）。 */
  snippet: string;
  score: number;
}

/** 健康检查结果。 */
export interface HealthReport {
  ok: boolean;
  version: string;
  uptimeSec: number;
  db: { ok: boolean; path: string; schemaVersion: number };
  media: { root: string; writable: boolean };
  collectors: Array<{ source: string; ok: boolean; lastOkAt: string | null; lastError: string | null }>;
  disk: { freeBytes: number; totalBytes: number; low: boolean };
}

/** 导入/采集/备份任务记录。 */
export interface JobRecord {
  id: number;
  kind: string;
  format: string | null;
  accountUid: string | null;
  sourcePath: string | null;
  status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
  totalItems: number;
  processed: number;
  inserted: number;
  duplicate: number;
  failed: number;
  mediaSaved: number;
  mediaMissing: number;
  progress: number;
  message: string | null;
  error: string | null;
  options: unknown;
  stats: unknown;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 采集断点状态。 */
export interface CollectStateRow {
  source: string;
  accountUid: string | null;
  sessionKey: string;
  cursorTs: number;
  cursorSeq: string | null;
  lastRunAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
}

/** 结构化日志记录。 */
export interface LogRecord {
  id: number;
  ts: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  scope: string;
  message: string;
  data: unknown;
}

/** 备份记录。 */
export interface BackupRecord {
  id: number;
  path: string;
  kind: string;
  status: 'running' | 'done' | 'failed';
  sizeBytes: number;
  messageCount: number;
  mediaCount: number;
  dbSha256: string | null;
  verifyResult: unknown;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

/** 媒体列表项（含所属会话与消息信息）。 */
export interface MediaListItem {
  id: number;
  kind: MediaKind;
  status: MediaStatus;
  size: number;
  mime: string | null;
  relPath: string;
  width: number | null;
  height: number | null;
  duration: number | null;
  failReason: string | null;
  sha256: string;
  createdAt: string;
  sessionName: string | null;
  messageId: number | null;
  ts: number | null;
  url: string;
  thumbUrl: string | null;
}
