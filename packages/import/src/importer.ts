/**
 * 导入器公共骨架：运行上下文、统计、批次回调、媒体流水线。
 *
 * 所有导入器都必须：
 *  - 只通过 `ctx.onBatch` 把数据交出去（写库是调用方的事，导入器不碰 db）；
 *  - 单条消息解析失败 → 计入 `failed` + `errors`，绝不静默跳过；
 *  - 每 `batchSize` 条 flush 一次，配合 db 单事务，避免 10 万条一次性进内存；
 *  - 尊重 `ctx.signal`（取消）与 `ctx.limit`（只导前 N 条）。
 */
import type {
  ChatType,
  ImportBatch,
  NormalizedMessage,
  NormalizedSession,
  ResourceRef,
  ScopedLogger,
} from '../../core/src/index.ts';
import type { ArchiveCandidate, ArchiveOutcome } from './media.ts';
import { MediaArchiver } from './media.ts';
import { createLogger } from '../../core/src/index.ts';
import { defaultSession } from './qce-map.ts';

/** `detectFormat` 的返回值。 */
export type DetectedFormat =
  | 'qce-json'
  | 'qce-jsonl'
  | 'qce-txt'
  | 'generic-jsonl'
  | 'html'
  | 'unknown';

export const DETECTED_FORMATS: DetectedFormat[] = [
  'qce-json',
  'qce-jsonl',
  'qce-txt',
  'generic-jsonl',
  'html',
  'unknown',
];

/** 每批默认消息数（与 db 单事务的体量折中）。 */
export const DEFAULT_BATCH_SIZE = 500;
/** errors 数组上限：再多就只累计数量，避免内存被坏文件撑爆。 */
export const MAX_IMPORT_ERRORS = 200;
/** 单条消息对象允许的最大 JSON 字节数（防止畸形文件把内存吃光）。 */
export const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;

export interface ImportStats {
  format: string;
  /** 从文件里成功解析出的消息数（含被 from/to 过滤掉的）。 */
  totalItems: number;
  /** 实际交给 onBatch 的批次数。 */
  batches: number;
  inserted: number;
  duplicate: number;
  /** 解析失败 + onBatch 报告失败。 */
  failed: number;
  /** 因 from/to 时间过滤而未提交的消息数。 */
  skipped: number;
  mediaSaved: number;
  mediaMissing: number;
  /** 解析 + 入库 + 媒体归档的总耗时（毫秒）。 */
  durationMs: number;
  errors: string[];
  /** 错误总数可能大于 errors.length（见 MAX_IMPORT_ERRORS）。 */
  errorsTruncated: boolean;
}

export function createImportStats(format: string): ImportStats {
  return {
    format,
    totalItems: 0,
    batches: 0,
    inserted: 0,
    duplicate: 0,
    failed: 0,
    skipped: 0,
    mediaSaved: 0,
    mediaMissing: 0,
    durationMs: 0,
    errors: [],
    errorsTruncated: false,
  };
}

export function addImportError(stats: ImportStats, message: string): void {
  if (stats.errors.length < MAX_IMPORT_ERRORS) stats.errors.push(message);
  else stats.errorsTruncated = true;
}

/** `onBatch` 的返回（与 db.InsertResult 结构兼容，允许只实现一部分）。 */
export interface ImportBatchOutcome {
  inserted?: number;
  duplicate?: number;
  failed?: number;
  messageIds?: number[];
  errors?: string[];
}

function readNumber(rec: Record<string, unknown>, key: string): number | undefined {
  const v = rec[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** 宽松读取 onBatch 返回值：不认识就当作“没有统计”，不报错。 */
export function readBatchOutcome(raw: unknown): ImportBatchOutcome | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const out: ImportBatchOutcome = {};
  const inserted = readNumber(rec, 'inserted');
  if (inserted !== undefined) out.inserted = inserted;
  const duplicate = readNumber(rec, 'duplicate');
  if (duplicate !== undefined) out.duplicate = duplicate;
  const failed = readNumber(rec, 'failed');
  if (failed !== undefined) out.failed = failed;
  const ids = rec.messageIds;
  if (Array.isArray(ids)) out.messageIds = ids.filter((x): x is number => typeof x === 'number');
  const errors = rec.errors;
  if (Array.isArray(errors)) out.errors = errors.map((x) => String(x));
  return out;
}

/** 调用方可以提供媒体来源解析（例如按需下载、或从资源清单里查本地缓存路径）。 */
export interface ResolvedMediaSource {
  localPath?: string | null;
  url?: string | null;
  filename?: string | null;
}

export type MediaResolver = (
  ref: ResourceRef,
  message: NormalizedMessage,
  session: NormalizedSession,
) => Promise<ResolvedMediaSource | null> | ResolvedMediaSource | null;

export interface ImportProgress {
  processed: number;
  batches: number;
  inserted: number;
}

/** 会话信息提示（txt / generic-jsonl 这类文件里没有 chatInfo 时由调用方指定）。 */
export interface SessionHint {
  name?: string;
  chatType?: ChatType;
  peerUid?: string;
  peerUin?: string;
  selfUid?: string;
  selfUin?: string;
  selfName?: string;
  memberCount?: number;
}

export interface ImportContext {
  /** 待导入文件路径。 */
  filePath: string;
  /** 归属账号（归档是多账号的）。 */
  accountUid: string;
  /** 强制指定格式；省略或 'auto' 时用 detectFormat 探测。 */
  format?: DetectedFormat | 'auto';
  /** CLI 兼容别名：等同于 `format`（`import --format qce-json`）。 */
  forceFormat?: string;
  /** 数据来源标签，写入 session.source / message.source。 */
  source?: string;
  batchSize?: number;
  /** 只导入前 N 条（测试/试跑用）。 */
  limit?: number;
  /** 只导入 ts >= from 的消息。 */
  from?: number;
  /** 只导入 ts <= to 的消息。 */
  to?: number;
  signal?: AbortSignal;
  /** 媒体根目录：给了就启用媒体归档（内容寻址落盘 + 回填 sha256）。 */
  mediaDir?: string;
  /** 直接注入 MediaArchiver（优先级高于 mediaDir）。 */
  mediaArchiver?: MediaArchiver;
  /** CLI 兼容别名：等同于 `mediaArchiver`。 */
  archiver?: MediaArchiver;
  mediaResolver?: MediaResolver;
  logger?: ScopedLogger;
  /** 每批数据的出口（写库由调用方实现）。 */
  onBatch: (batch: ImportBatch) => Promise<ImportBatchOutcome | void> | ImportBatchOutcome | void;
  onProgress?: (progress: ImportProgress) => void;
  /** 每个资源归档完成后回调（present/missing 都会回调）。 */
  onMedia?: (
    outcome: ArchiveOutcome,
    ref: ResourceRef,
    message: NormalizedMessage,
  ) => Promise<void> | void;
  /** 会话信息补充（文件内缺失时使用）。 */
  sessionHint?: SessionHint;
}

export interface Importer {
  /** 唯一名字，例如 'qce-json'。 */
  readonly name: string;
  /** 能处理的格式。 */
  readonly formats: DetectedFormat[];
  run(ctx: ImportContext): Promise<ImportStats>;
}

/** 导入被取消（`ctx.signal` 触发）。携带已完成的统计，调用方可以据此落 job 记录。 */
export class ImportAbortedError extends Error {
  readonly stats: ImportStats;
  constructor(stats: ImportStats) {
    super('导入已取消');
    this.name = 'ImportAbortedError';
    this.stats = stats;
  }
}

/** 按 `sessionHint` 生成兜底会话。 */
export function sessionFromHint(
  accountUid: string,
  source: string,
  hint: SessionHint | undefined,
): NormalizedSession {
  const session = defaultSession(accountUid, source, hint?.name);
  if (!hint) return session;
  if (hint.chatType !== undefined) session.chatType = hint.chatType;
  if (hint.peerUid !== undefined) session.peerUid = hint.peerUid;
  if (hint.peerUin !== undefined) session.peerUin = hint.peerUin;
  if (hint.selfUid !== undefined) session.selfUid = hint.selfUid;
  if (hint.selfUin !== undefined) session.selfUin = hint.selfUin;
  if (hint.selfName !== undefined) session.selfName = hint.selfName;
  if (hint.memberCount !== undefined) session.memberCount = hint.memberCount;
  return session;
}

// -------------------------------------------------------------- 媒体流水线

class MediaPipeline {
  private readonly ctx: ImportContext;
  private readonly archiver: MediaArchiver;
  private readonly stats: ImportStats;
  private readonly logger: ScopedLogger | undefined;

  constructor(ctx: ImportContext, archiver: MediaArchiver, stats: ImportStats) {
    this.ctx = ctx;
    this.archiver = archiver;
    this.stats = stats;
    this.logger = ctx.logger;
  }

  /** 归档本条消息里的所有资源；present 时回填 `ref.sha256`（内容寻址的权威值）。 */
  async process(message: NormalizedMessage, session: NormalizedSession): Promise<void> {
    const refs = message.resources;
    if (!refs || refs.length === 0) return;
    for (const ref of refs) {
      let resolved: ResolvedMediaSource | null = null;
      if (this.ctx.mediaResolver) {
        try {
          resolved = await this.ctx.mediaResolver(ref, message, session);
        } catch (err) {
          this.logger?.warn('mediaResolver 失败，退回源数据字段', {
            msgKey: message.msgKey,
            error: err instanceof Error ? err.message : String(err),
          });
          resolved = null;
        }
      }
      const candidate: ArchiveCandidate = {
        kind: ref.kind,
        localPath: resolved?.localPath ?? ref.localPath ?? null,
        url: resolved?.url ?? ref.url ?? null,
        filename: resolved?.filename ?? ref.filename ?? null,
        declaredSize: ref.size ?? null,
        width: ref.width ?? null,
        height: ref.height ?? null,
        duration: ref.duration ?? null,
      };
      let outcome: ArchiveOutcome;
      try {
        outcome = await this.archiver.archive(candidate);
      } catch (err) {
        // archive 自身已把可预期错误转成 missing；这里只兜底不可预期异常，绝不中断整批导入
        const reason = err instanceof Error ? err.message : String(err);
        outcome = this.archiver.missingOutcome(
          {
            kind: ref.kind,
            filename: ref.filename,
            url: ref.url,
            localPath: ref.localPath,
            declaredSize: ref.size,
          },
          `归档异常：${reason}`,
        );
      }
      if (outcome.status === 'present') {
        this.stats.mediaSaved += 1;
        ref.sha256 = outcome.media.sha256;
      } else {
        this.stats.mediaMissing += 1;
      }
      if (this.ctx.onMedia) await this.ctx.onMedia(outcome, ref, message);
    }
  }
}

// ------------------------------------------------------------------ 运行器

/**
 * 一次导入运行的累加器：负责批次缓冲、统计、媒体、取消检查。
 * 导入器只管「解析 → run.push(msg)」，收尾调用 run.finish()。
 */
export class ImportRun {
  readonly stats: ImportStats;
  private readonly ctx: ImportContext;
  private readonly batchSize: number;
  private readonly pipeline: MediaPipeline | null;
  private buffer: NormalizedMessage[] = [];
  private session: NormalizedSession | null = null;
  private sourceStats: Record<string, unknown> | undefined;
  private sourceStatsSent = false;
  private emitted = false;
  private readonly startedAt = Date.now();

  constructor(ctx: ImportContext, format: string) {
    this.ctx = ctx;
    this.stats = createImportStats(format);
    this.batchSize = Math.max(1, ctx.batchSize ?? DEFAULT_BATCH_SIZE);
    const archiver =
      ctx.mediaArchiver ??
      ctx.archiver ??
      (ctx.mediaDir !== undefined
        ? new MediaArchiver({
            root: ctx.mediaDir,
            logger: (ctx.logger ?? silentLogger()).child('media'),
          })
        : undefined);
    this.pipeline = archiver ? new MediaPipeline(ctx, archiver, this.stats) : null;
  }

  get processed(): number {
    return this.stats.totalItems;
  }

  get batches(): number {
    return this.stats.batches;
  }

  get sessionInfo(): NormalizedSession | null {
    return this.session;
  }

  /** 已解析条数达到 limit。 */
  get limitReached(): boolean {
    const limit = this.ctx.limit;
    return limit !== undefined && limit > 0 && this.stats.totalItems >= limit;
  }

  setSession(session: NormalizedSession): void {
    this.session = session;
  }

  setSourceStats(stats: Record<string, unknown> | undefined): void {
    this.sourceStats = stats;
  }

  /** 时间过滤：返回 true 表示该消息应被跳过。 */
  private filtered(ts: number): boolean {
    if (this.ctx.from !== undefined && ts < this.ctx.from) return true;
    if (this.ctx.to !== undefined && ts > this.ctx.to) return true;
    return false;
  }

  recordFailure(reason: string): void {
    this.stats.failed += 1;
    addImportError(this.stats, reason);
  }

  checkAbort(): void {
    if (this.ctx.signal?.aborted) throw new ImportAbortedError(this.stats);
  }

  /** 接收一条已归一化的消息：过滤 → 媒体归档 → 计数 → 缓冲/flush。 */
  async push(message: NormalizedMessage): Promise<void> {
    this.stats.totalItems += 1;
    if (!Number.isFinite(message.ts) || message.ts <= 0) {
      this.recordFailure(`消息时间戳非法（ts=${message.ts}，msgKey=${message.msgKey}）`);
      return;
    }
    if (this.filtered(message.ts)) {
      this.stats.skipped += 1;
      return;
    }
    if (this.pipeline && this.session) await this.pipeline.process(message, this.session);
    this.buffer.push(message);
    if (this.buffer.length >= this.batchSize) await this.flush();
  }

  private currentSession(): NormalizedSession {
    return (
      this.session ??
      sessionFromHint(this.ctx.accountUid, this.ctx.source ?? 'import', this.ctx.sessionHint)
    );
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const messages = this.buffer;
    this.buffer = [];
    const batch: ImportBatch = { session: this.currentSession(), messages };
    if (this.sourceStats !== undefined && !this.sourceStatsSent) {
      batch.sourceStats = this.sourceStats;
      this.sourceStatsSent = true;
    }
    const raw = await this.ctx.onBatch(batch);
    const outcome = readBatchOutcome(raw);
    if (outcome) {
      this.stats.inserted += outcome.inserted ?? 0;
      this.stats.duplicate += outcome.duplicate ?? 0;
      if (outcome.failed !== undefined) this.stats.failed += outcome.failed;
      for (const err of outcome.errors ?? []) addImportError(this.stats, err);
    }
    this.stats.batches += 1;
    this.emitted = true;
    this.ctx.onProgress?.({
      processed: this.stats.totalItems,
      batches: this.stats.batches,
      inserted: this.stats.inserted,
    });
  }

  /**
   * 收尾：把残余缓冲 flush 掉；如果一条消息都没有但已经解析出会话信息，
   * 也发一个空批次，让调用方有机会建立会话记录。
   */
  async finish(): Promise<ImportStats> {
    if (this.buffer.length > 0) await this.flush();
    else if (!this.emitted && this.session !== null) await this.flushEmptySession();
    this.stats.durationMs = Date.now() - this.startedAt;
    return this.stats;
  }

  private async flushEmptySession(): Promise<void> {
    const batch: ImportBatch = { session: this.currentSession(), messages: [] };
    if (this.sourceStats !== undefined && !this.sourceStatsSent) {
      batch.sourceStats = this.sourceStats;
      this.sourceStatsSent = true;
    }
    const raw = await this.ctx.onBatch(batch);
    const outcome = readBatchOutcome(raw);
    if (outcome) {
      this.stats.inserted += outcome.inserted ?? 0;
      this.stats.duplicate += outcome.duplicate ?? 0;
    }
    this.stats.batches += 1;
    this.emitted = true;
  }
}

let fallbackLogger: ScopedLogger | null = null;

/** 调用方没给 logger 时的最小静默 logger（导入器不打印噪音）。 */
function silentLogger(): ScopedLogger {
  if (fallbackLogger) return fallbackLogger;
  fallbackLogger = createLogger({ console: false, level: 'error' }).child('import');
  return fallbackLogger;
}
