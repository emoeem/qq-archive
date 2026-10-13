/**
 * 高层导入入口 `runImport()`：把「解析 → 写消息 → 写媒体 → 建关联」整条接线收在 import 包里，
 * 让 apps/cli 与 packages/server 共用同一份实现（两边自己拼这套逻辑非常容易漏掉 message_media）。
 *
 * 为什么需要它：`ImportContext.onMedia` 在消息落库**之前**触发，此时没有 messageId，
 * 所以媒体只能先按 `msgKey` 缓冲，等 `onBatch` 里 `db.insertMessages()` 返回
 * `messageIds` 之后再 `db.upsertMedia()` + `db.linkMessageMedia()` 回填关联。
 *
 * 顺序保证：`ImportRun.push()` 先归档媒体再缓冲消息，同一个 batch 的 `messages` 顺序
 * 与 `onMedia` 的触发顺序一致，因此每批的 `messageIds[i]` 就是 `messages[i]` 的 id
 * （前提是这批没有插入失败；一旦有失败就退回按 (account_uid, session_key, msg_key) 查 id）。
 */
import { AppError, createLogger, sessionKeyOf } from '../../core/src/index.ts';
import type { ScopedLogger } from '../../core/src/index.ts';
import type { Db, MediaInput } from '../../db/src/index.ts';
import { detectFormat } from './detect.ts';
import { DETECTED_FORMATS } from './importer.ts';
import type {
  DetectedFormat,
  ImportContext,
  ImportProgress,
  ImportStats,
  Importer,
  SessionHint,
} from './importer.ts';
import { importerForFormat } from './importers/index.ts';
import { DEFAULT_MAX_MEDIA_BYTES, MediaArchiver } from './media.ts';
import type { ArchiveOutcome } from './media.ts';

/** 一条消息的资源归档结果（等 messageId 到手后再落库）。 */
interface PendingMedia {
  media: MediaInput;
  filename: string | null;
  size: number | null;
  ordinal: number;
}

/** 解析出实际要用的格式：显式指定优先，否则探测。 */
export async function resolveImportFormat(ctx: ImportContext): Promise<DetectedFormat> {
  const explicit = ctx.format ?? (ctx.forceFormat as DetectedFormat | undefined);
  if (explicit !== undefined && explicit !== 'auto') {
    if (!DETECTED_FORMATS.includes(explicit)) {
      throw new AppError(
        'BAD_REQUEST',
        `未知导入格式：${explicit}（可用：${DETECTED_FORMATS.join(', ')}）`,
      );
    }
    return explicit;
  }
  return detectFormat(ctx.filePath);
}

/**
 * 低层入口：探测（或使用 `ctx.format` / `ctx.forceFormat`）后分派给对应导入器。
 * 只负责「解析 → onBatch / onMedia 回调」，**不碰数据库**。
 * 格式无法识别时抛 `AppError('UNSUPPORTED_FORMAT')`，不会静默返回空统计。
 */
export async function importFile(ctx: ImportContext): Promise<ImportStats> {
  const format = await resolveImportFormat(ctx);
  if (format === 'unknown') {
    throw new AppError('UNSUPPORTED_FORMAT', `无法识别的导出格式：${ctx.filePath}`, {
      filePath: ctx.filePath,
    });
  }
  const importer: Importer | null = importerForFormat(format);
  if (importer === null) {
    throw new AppError('UNSUPPORTED_FORMAT', `没有导入器能处理格式 ${format}`, { format });
  }
  return importer.run(ctx);
}

/** `runImport()` 的参数：CLI 与 server 都直接把它透传进来。 */
export interface RunImportOptions {
  filePath: string;
  db: Db;
  /** 归属账号，默认 `'default'`。 */
  accountUid?: string;
  /** 指定格式；省略则自动探测。 */
  format?: DetectedFormat;
  /** CLI 兼容别名（`--format qce-json`）。 */
  forceFormat?: string;
  logger?: ScopedLogger;
  /** 媒体根目录：提供就自动建 MediaArchiver（内容寻址落盘）。 */
  mediaDir?: string;
  /** 直接注入归档器（优先于 mediaDir）。 */
  archiver?: MediaArchiver;
  /** 单个媒体文件的大小上限，默认 512 MiB。 */
  maxMediaBytes?: number;
  /** 只导入 ts >= from（毫秒）。 */
  from?: number;
  /** 只导入 ts <= to（毫秒）。 */
  to?: number;
  /** 只导入前 N 条。 */
  limit?: number;
  batchSize?: number;
  signal?: AbortSignal;
  onProgress?: (progress: ImportProgress) => void;
  /** txt / generic-jsonl 这类文件里没有 chatInfo 时用。 */
  sessionHint?: SessionHint;
  /** 数据来源标签，默认 `'import'`。 */
  source?: string;
  /** 写入 messages.batch_id 的批次 id（调用方可用 db.createJob 建）。 */
  batchId?: number;
  /** 只解析 + 写消息，不归档媒体（离线修复/测试用）。 */
  skipMedia?: boolean;
}

let fallbackLogger: ScopedLogger | null = null;

/** 调用方没给 logger 时的静默 logger（导入不该往控制台喷日志）。 */
function silentLogger(): ScopedLogger {
  fallbackLogger ??= createLogger({ console: false, level: 'error' }).child('import');
  return fallbackLogger;
}

/** 按 (account_uid, session_key, msg_key) 查消息 id（插入失败的批兜底用）。 */
function lookupMessageId(
  db: Db,
  accountUid: string,
  sessionKey: string,
  msgKey: string,
): number | null {
  const row = db.raw
    .prepare('SELECT id FROM messages WHERE account_uid = ? AND session_key = ? AND msg_key = ?')
    .get(accountUid, sessionKey, msgKey) as unknown as { id?: number } | undefined;
  const id = row?.id;
  return typeof id === 'number' ? id : null;
}

/**
 * 把一批消息的媒体写进 media 表并建立 message_media 关联。
 * 返回本次真正建立的关联条数。
 */
function linkBatchMedia(
  db: Db,
  accountUid: string,
  sessionKey: string,
  messages: ReadonlyArray<{ msgKey: string }>,
  messageIds: number[],
  pending: Map<string, PendingMedia[]>,
  mediaCache: Map<string, number>,
  logger: ScopedLogger,
): number {
  // messageIds 与 messages 等长同序 ⟺ 这批一条都没插入失败（见 db.insertMessages 实现）
  const aligned = messageIds.length === messages.length;
  let linked = 0;
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (message === undefined) continue;
    const list = pending.get(message.msgKey);
    if (list === undefined || list.length === 0) continue;
    pending.delete(message.msgKey);
    const messageId = aligned
      ? messageIds[i]
      : lookupMessageId(db, accountUid, sessionKey, message.msgKey);
    if (messageId === undefined || messageId === null) {
      logger.warn('媒体已归档但找不到消息 id，跳过关联', { msgKey: message.msgKey });
      continue;
    }
    for (const item of list) {
      const cacheKey = `${item.media.status ?? 'pending'}\u0000${item.media.sha256}`;
      let mediaId = mediaCache.get(cacheKey);
      if (mediaId === undefined) {
        mediaId = db.upsertMedia(item.media).id;
        mediaCache.set(cacheKey, mediaId);
      }
      db.linkMessageMedia(
        messageId,
        mediaId,
        item.ordinal,
        item.filename ?? undefined,
        item.size ?? undefined,
      );
      linked += 1;
    }
  }
  return linked;
}

/**
 * 导入一个文件并写库（解析 + 消息 + 媒体 + 关联）。
 *
 * 返回的 `ImportStats` 已经包含 inserted/duplicate/failed/mediaSaved/mediaMissing，
 * 可直接给 server 的 `numericStats()` 或 CLI 输出用。
 */
export async function runImport(opts: RunImportOptions): Promise<ImportStats> {
  const accountUid = opts.accountUid ?? 'default';
  const source = opts.source ?? 'import';
  const logger = opts.logger ?? silentLogger();
  const archiver = opts.skipMedia
    ? undefined
    : (opts.archiver ??
      (opts.mediaDir !== undefined
        ? new MediaArchiver({
            root: opts.mediaDir,
            maxBytes: opts.maxMediaBytes ?? DEFAULT_MAX_MEDIA_BYTES,
            logger: (opts.logger ?? silentLogger()).child('media'),
          })
        : undefined));

  const pending = new Map<string, PendingMedia[]>();
  const mediaCache = new Map<string, number>();

  const stats = await importFile({
    filePath: opts.filePath,
    accountUid,
    format: opts.format,
    forceFormat: opts.forceFormat,
    source,
    batchSize: opts.batchSize,
    limit: opts.limit,
    from: opts.from,
    to: opts.to,
    signal: opts.signal,
    // skipMedia 时连 mediaDir 一起屏蔽，否则 ImportRun 会自己再建一个归档器
    mediaDir: archiver === undefined ? undefined : opts.mediaDir,
    mediaArchiver: archiver,
    logger: opts.logger,
    sessionHint: opts.sessionHint,
    onProgress: opts.onProgress,
    onMedia: (outcome: ArchiveOutcome, ref, message) => {
      // 只缓冲，绝不在这里落库：此时还没有 messageId
      const list = pending.get(message.msgKey) ?? [];
      list.push({
        media: outcome.media,
        filename: ref.filename ?? null,
        size: ref.size ?? null,
        ordinal: list.length,
      });
      pending.set(message.msgKey, list);
    },
    onBatch: (batch) => {
      const record = opts.db.ensureSession(batch.session);
      if (batch.messages.length === 0) {
        return { inserted: 0, duplicate: 0, failed: 0, messageIds: [] };
      }
      const sessionKey = sessionKeyOf(record.chatType, record.peerUid);
      const result = opts.db.insertMessages(record.id, record.accountUid, sessionKey, batch.messages, {
        batchId: opts.batchId,
        source,
      });
      if (pending.size > 0) {
        linkBatchMedia(
          opts.db,
          accountUid,
          sessionKey,
          batch.messages,
          result.messageIds,
          pending,
          mediaCache,
          logger,
        );
      }
      return result;
    },
  });

  return stats;
}
