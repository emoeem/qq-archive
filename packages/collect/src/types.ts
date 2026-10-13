/**
 * `@qqarchive/collect` 的公共契约类型。
 *
 * 严格对应 `docs/ARCHITECTURE.md` 第 5 节；这里的签名是 server / apps/cli 依赖的**冻结契约**，
 * 扩展只能以**可选字段**的形式追加，不得改变已有字段语义。
 */
import type { MediaKind, MediaStatus, MessageElement, NormalizedMessage, ResourceRef } from '../../core/src/index.ts';

/** 采集器只会产出群聊与私聊两种会话。 */
export type CollectChatType = 'group' | 'private';

/** 会话发现结果（采集器侧，不含账号归属）。 */
export interface SessionInfo {
  chatType: CollectChatType;
  peerUid: string;
  peerUin: string;
  name: string;
}

/** 调度器内部使用的会话（补上账号归属）。 */
export interface CollectSession extends SessionInfo {
  accountUid: string;
}

/** 探活结果。 */
export interface ProbeResult {
  ok: boolean;
  uin?: string;
  nickname?: string;
  error?: string;
}

/** 增量拉取参数。 */
export interface FetchOptions {
  pageSize: number;
  maxPages: number;
}

/**
 * 合并转发里的一条子消息（`get_forward_msg` 的产物）。
 *
 * 字段一律**尽力而为**：源数据没有就留空，绝不臆造。子消息自身若还是合并转发，
 * `forwardId` 会保留下来，由调度器决定是否递归展开（见 `forward.ts`）。
 */
export interface ForwardNode {
  /** 发送者 QQ 号。 */
  senderUin?: string;
  senderName?: string;
  /** 毫秒时间戳；源数据没有时为 0。 */
  ts: number;
  /** 可读正文（含 `[图片]` 之类的转写）。 */
  text: string;
  /** 归一化后的消息类型。 */
  msgType: string;
  /** 原始消息段（保留未知段）。 */
  elements?: MessageElement[];
  /** 子消息里的媒体资源。 */
  resources: ResourceRef[];
  /** 该子消息本身也是合并转发时的转发 id。 */
  forwardId?: string;
}

/**
 * 采集适配器。
 *
 * **硬性约束：只允许调用只读接口。** 任何实现都不得调用发送消息、撤回、踢人等写接口；
 * 本包的 `OneBotCollector` 把允许的 action 白名单写死在代码里。
 */
export interface Collector {
  readonly kind: string;
  /** 探活：/get_login_info + /get_status。 */
  probe(): Promise<ProbeResult>;
  /** 列出可见会话（群 + 好友）。 */
  listSessions(): Promise<SessionInfo[]>;
  /** 增量拉取一个会话自 since 起的消息，返回按时间升序的归一化消息。 */
  fetchSince(session: CollectSession, sinceTs: number, opts: FetchOptions): Promise<NormalizedMessage[]>;
  /** 下载媒体（OneBot /get_image、/get_record、/get_file 或直链）。 */
  fetchMedia(ref: ResourceRef): Promise<{ data: Uint8Array; filename?: string } | null>;
  /**
   * 拉取合并转发的子消息（只读）。**可选**：未实现的采集器可以省略，
   * 此时转发只保留 `forwardId` 与 `[合并转发]` 占位文本（即修复前的行为）。
   */
  fetchForward?(id: string): Promise<ForwardNode[]>;
}

/** 媒体归档结果（与 packages/import 的 ArchiveOutcome 结构一致，避免跨包类型依赖）。 */
export interface ArchiveOutcome {
  /** 与 core 的 MediaStatus 对齐（packages/import 的 ArchiveOutcome 直接用它）。 */
  status: MediaStatus;
  media?: unknown;
  reason?: string;
}

/** 归档候选来源。 */
export interface ArchiveCandidates {
  localPath?: string;
  url?: string;
  filename?: string;
  kind: MediaKind;
  declaredSize?: number;
}

/** `MediaArchiver` 的最小结构契约（packages/import 提供实现）。 */
export interface MediaArchiverLike {
  archive(candidates: ArchiveCandidates): Promise<ArchiveOutcome>;
  /**
   * 可选：归档**已经在内存里的字节**（直链过期后用 OneBot `/get_image` 等重取回来的内容）。
   * 缺省时 runner 不做字节回落，媒体仍按 `missing` 落库。
   */
  archiveBytes?(data: Uint8Array, candidates: ArchiveCandidates): Promise<ArchiveOutcome>;
}

/** 调用方注入的媒体归档回调：每个 ResourceRef 调一次。 */
export type ArchiveMediaFn = (
  ref: ResourceRef,
  msg: NormalizedMessage,
) => Promise<ArchiveOutcome | null | void>;

/**
 * 字节归档回调：直链失败后经 OneBot 媒体接口重取到字节时调用一次。
 *
 * 与 `ArchiveMediaFn` 分开是因为它多一个「字节从哪来」的维度；两者都注入时，
 * 字节日志优先走本回调，未注入则退回 `MediaArchiverLike.archiveBytes`。
 */
export type ArchiveMediaBytesFn = (
  data: Uint8Array,
  ref: ResourceRef,
) => Promise<ArchiveOutcome | null | void>;

/** 一轮采集的统计。 */
export interface CollectRound {
  sessions: number;
  fetched: number;
  inserted: number;
  duplicate: number;
  /** 失败计数 = 失败会话数 + 写入失败的消息数。 */
  failed: number;
  mediaSaved: number;
  mediaMissing: number;
  errors: Array<{ session: string; error: string }>;
  /**
   * 本次展开到的合并转发子消息条数。
   *
   * 可选：只在真的展开过时才赋值 —— 既有调用方/测试对 `CollectRound` 做深比较时
   * 不会因为多出一个 `0` 而失败。
   */
  forwardMessages?: number;
  /** 拉取失败的转发条数（失败只降级，不影响消息入库）。 */
  forwardFailed?: number;
  /**
   * 命中过滤规则的消息数。
   *
   * 默认只标记不丢弃 → 这些消息**照样入库**（`filtered=1`），计数只用于展示；
   * 只有 `filters.drop = true` 时它们才被跳过存储（此时 `dropped` 才是"真的没存"）。
   */
  filtered?: number;
  /** 因 `filters.drop = true` 而被**跳过存储**的消息数（真正没入库的那些）。 */
  dropped?: number;
}
