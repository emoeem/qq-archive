/**
 * 采集调度器：会话发现 → 增量回溯 → 写库 → 持久化游标 → 媒体归档回调 → 统计/告警。
 *
 * 设计要点（对应 docs/ARCHITECTURE.md 第 5 节）：
 *  - 游标只前进：每成功写一批就 `upsertCollectState`，崩溃后从游标续传。
 *  - 单会话失败绝不中断整轮；失败按 1s/2s/4s 退避重试，凭据类错误不重试。
 *  - 媒体**字节落盘**不是本包职责：由调用方注入 `archiver` / `archiveMedia` 回调；
 *    没注入时只保留元数据（消息原文里的 resources），绝不生成占位文件。
 *  - 但媒体**入库**（`media` 行 + `message_media` 关联）是本包职责：归档回调只回传产物，
 *    这里统一 `upsertMedia` / `linkMessageMedia`。否则字节躺在磁盘上而 `media` 表为空，
 *    Web 媒体页、`/api/media/:id`、`verify`、备份清单会一起失明。
 */
import {
  AppError,
  sessionKeyOf,
  type AlertConfig,
  type CollectorConfig,
  type FiltersConfig,
  type NormalizedMessage,
  type NormalizedSession,
  type ResourceRef,
  type ScopedLogger,
} from '../../core/src/index.ts';
import type { Db, InsertResult, MediaInput } from '../../db/src/index.ts';
import { matchMessageFilters } from './filter.ts';
import { DEFAULT_FORWARD_DEPTH, DEFAULT_FORWARD_MAX_NODES, expandForward } from './forward.ts';
import { OneBotCollector } from './onebot.ts';
import type {
  ArchiveCandidates,
  ArchiveMediaBytesFn,
  ArchiveMediaFn,
  ArchiveOutcome,
  CollectRound,
  CollectSession,
  Collector,
  MediaArchiverLike,
  SessionInfo,
} from './types.ts';
import { errText, type FetchLike } from './util.ts';

/** 采集器来源标识（collect_state.source）。 */
export const COLLECT_SOURCE = 'onebot';

/** 这些错误重试没有意义（凭据/参数问题），必须立刻上报。 */
const NON_RETRYABLE: ReadonlySet<string> = new Set([
  'UNAUTHORIZED',
  'FORBIDDEN',
  'BAD_REQUEST',
  'NOT_FOUND',
  'UNSUPPORTED_FORMAT',
  'MEDIA_MISSING',
]);

/** 重试退避：1s / 2s / 4s。 */
export const RETRY_DELAYS_MS: readonly number[] = [1000, 2000, 4000];

export interface CollectRunnerOptions {
  db: Db;
  collector: Collector;
  config: CollectorConfig;
  logger: ScopedLogger;
  /** 与本包 ArchiveOutcome 结构一致的归档实现（packages/import 提供）。 */
  archiver?: MediaArchiverLike;
  /** 更简单的回调：每个 ResourceRef 调一次。 */
  archiveMedia?: ArchiveMediaFn;
  /**
   * 直链失败、经 OneBot 媒体接口重取到字节后的归档回调。
   * 缺省时若 `archiver` 实现了 `archiveBytes` 就复用它；两者都没有则不做字节回落。
   */
  archiveMediaBytes?: ArchiveMediaBytesFn;
  /** 账号归属；缺省 `default`。 */
  accountUid?: string;
  /** 告警配置；也可通过 config.alert 传入。 */
  alert?: Partial<AlertConfig>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** webhook 推送用的 fetch；默认全局 fetch。 */
  fetchImpl?: FetchLike;
  /** 覆盖 collect_state.source。 */
  source?: string;
  /** 覆盖重试次数（默认 3 次，退避 1s/2s/4s）。 */
  maxRetries?: number;
  /**
   * 采集过滤规则（可选）。缺省 = 未启用，行为与没有这个功能时完全一致。
   * 默认只标记不丢弃；`drop: true` 才跳过存储。
   */
  filters?: FiltersConfig;
}

export interface CollectHealth {
  ok: boolean;
  lastOkAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
}

interface DiscoveryResult {
  sessions: CollectSession[];
  error: string | null;
}

export class CollectRunner {
  private readonly db: Db;
  private readonly collector: Collector;
  private readonly config: CollectorConfig;
  private readonly logger: ScopedLogger;
  private readonly archiver: MediaArchiverLike | null;
  private readonly archiveMedia: ArchiveMediaFn | null;
  private readonly archiveMediaBytes: ArchiveMediaBytesFn | null;
  private readonly accountUid: string;
  private readonly source: string;
  private readonly alertConf: Partial<AlertConfig> | null;
  private readonly nowImpl: () => number;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly fetchImpl: FetchLike;
  private readonly maxRetries: number;

  private consecutiveFailures = 0;
  private lastOkAt: string | null = null;
  private lastError: string | null = null;
  private inFlight: Promise<CollectRound> | null = null;
  private running = false;
  private loopDone: Promise<void> | null = null;
  private readonly filters: FiltersConfig;

  constructor(opts: CollectRunnerOptions) {
    this.db = opts.db;
    this.collector = opts.collector;
    this.config = opts.config;
    this.logger = opts.logger;
    this.filters = opts.filters ?? { enabled: false, excludeKeywords: [], excludeSenders: [], excludeTypes: [], drop: false };
    this.archiver = opts.archiver ?? null;
    this.archiveMedia = opts.archiveMedia ?? null;
    this.archiveMediaBytes = opts.archiveMediaBytes ?? null;
    this.accountUid = opts.accountUid ?? 'default';
    this.source = opts.source ?? COLLECT_SOURCE;
    const fromConfig = (opts.config as unknown as { alert?: Partial<AlertConfig> }).alert;
    this.alertConf = opts.alert ?? fromConfig ?? null;
    this.nowImpl = opts.now ?? (() => Date.now());
    this.sleepImpl = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.maxRetries = Math.max(0, Math.floor(opts.maxRetries ?? RETRY_DELAYS_MS.length));
  }

  /** 健康状态（供 /api/collect/health 消费）。 */
  health(): CollectHealth {
    return {
      ok: this.consecutiveFailures === 0,
      lastOkAt: this.lastOkAt,
      lastError: this.lastError,
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  private nowMs(): number {
    return this.nowImpl();
  }

  private iso(ms: number): string {
    return new Date(ms).toISOString();
  }

  /** 会话发现：静态清单 + 动态发现，按 sessionKey 去重。 */
  private async discoverSessions(): Promise<DiscoveryResult> {
    const out = new Map<string, CollectSession>();
    const add = (info: SessionInfo): void => {
      if (!info.peerUid) return;
      const key = sessionKeyOf(info.chatType, info.peerUid);
      if (out.has(key)) return;
      out.set(key, {
        chatType: info.chatType,
        peerUid: info.peerUid,
        peerUin: info.peerUin,
        name: info.name,
        accountUid: this.accountUid,
      });
    };

    for (const spec of this.config.sessions ?? []) {
      const info = OneBotCollector.parseSessionSpec(spec);
      if (info) add(info);
      else this.logger.warn('忽略无法解析的 collector.sessions 项', { spec });
    }

    let error: string | null = null;
    if (this.config.discoverSessions) {
      try {
        for (const info of await this.collector.listSessions()) add(info);
      } catch (err) {
        error = errText(err);
        this.logger.warn('会话发现失败，退化为静态清单', { error, staticCount: out.size });
      }
    }
    return { sessions: [...out.values()], error };
  }

  /** 带退避重试的增量拉取；凭据类错误立即上抛。 */
  private async fetchWithRetry(session: CollectSession, sinceTs: number): Promise<NormalizedMessage[]> {
    const opts = { pageSize: this.config.pageSize, maxPages: this.config.maxPagesPerRound };
    let attempt = 0;
    for (;;) {
      try {
        return await this.collector.fetchSince(session, sinceTs, opts);
      } catch (err) {
        if (err instanceof AppError && NON_RETRYABLE.has(err.code)) throw err;
        if (attempt >= this.maxRetries) throw err;
        const delay = RETRY_DELAYS_MS[attempt] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1] ?? 1000;
        attempt += 1;
        this.logger.warn('采集失败，退避后重试', {
          sessionKey: sessionKeyOf(session.chatType, session.peerUid),
          attempt,
          delayMs: delay,
          error: errText(err),
        });
        await this.sleepImpl(delay);
      }
    }
  }

  /**
   * 媒体处理：调归档器落盘，并把归档产物写进 `media` / `message_media`。
   *
   * 归档器只负责**字节落盘**；DB 写入统一在这里完成。归档回调若自己已经入库
   * （见 tests/acceptance.test.ts 的注入实现），这里重复写也是幂等的：
   * `upsertMedia` 按 sha256 去重、`linkMessageMedia` 按 (message_id, media_id, ordinal) UPSERT。
   */
  private async handleMedia(msg: NormalizedMessage, round: CollectRound, ctx: MediaLinkContext): Promise<void> {
    const refs = msg.resources ?? [];
    if (refs.length === 0) return;
    // 窗口重叠是常态：同一会话每轮都会带回最近几条消息，消息本身被唯一约束挡住，
    // 但媒体不会 —— 不加这道判断，同一张图/同一段视频会被**每轮重新下载一遍**。
    // 只跳过「已关联的 present 媒体数 ≥ 本条引用数」的消息；缺失或损坏的照旧重试，
    // 所以直链 rkey 过期后的补救路径不受影响。
    const knownMessageId = ctx.messageIdByMsgKey.get(msg.msgKey);
    if (typeof knownMessageId === 'number') {
      try {
        if (this.db.countPresentMediaForMessage(knownMessageId) >= refs.length) {
          this.logger.debug('媒体已齐备，跳过重复下载', { msgKey: msg.msgKey, refs: refs.length });
          return;
        }
      } catch (err) {
        // 读失败就按「未知」处理，照常下载：绝不因为一次查询出错而漏掉媒体
        this.logger.debug('媒体齐备性检查失败，继续下载', { msgKey: msg.msgKey, error: errText(err) });
      }
    }
    if (!this.archiveMedia && !this.archiver) {
      this.logger.debug('syncMedia 已开启但未注入 archiver，仅保留媒体元数据', {
        msgKey: msg.msgKey,
        refs: refs.length,
      });
      return;
    }
    for (let ordinal = 0; ordinal < refs.length; ordinal += 1) {
      const ref = refs[ordinal] as ResourceRef;
      try {
        let outcome: ArchiveOutcome | null | void;
        if (this.archiveMedia) outcome = await this.archiveMedia(ref, msg);
        else outcome = await (this.archiver as MediaArchiverLike).archive(toCandidates(ref));
        // 直链与本地缓存路径都失败时，用 OneBot 媒体接口重取一次字节。
        //
        // 采集到的图片/语音 URL 带 rkey 且会过期；只失败一次就永久 missing 的话，
        // 「防丢失」在媒体这一半是假的。`fetchMedia` 早就实现了这个回落，但生产路径
        // 从不调用它（只有测试直调），所以这里必须显式接上。
        if (outcome && (outcome.status === 'missing' || outcome.status === 'corrupt')) {
          const retried = await this.retryViaOneBot(ref, msg);
          if (retried) outcome = retried;
        }
        // present 与 missing 都入库：缺失态也要能被 Web 媒体页看到，否则「拿不到的图」无迹可查。
        const media = asMediaInput(outcome?.media);
        if (media) this.persistMedia(media, msg, ref, ordinal, ctx);
        if (outcome && (outcome.status === 'missing' || outcome.status === 'corrupt')) {
          round.mediaMissing += 1;
          this.logger.warn('媒体归档未成功', {
            msgKey: msg.msgKey,
            kind: ref.kind,
            status: outcome.status,
            reason: outcome.reason ?? null,
          });
        } else if (outcome && outcome.status === 'pending') {
          this.logger.warn('媒体归档返回 pending，计入未完成（不计 saved/missing）', {
            msgKey: msg.msgKey,
            kind: ref.kind,
          });
        } else {
          round.mediaSaved += 1;
        }
      } catch (err) {
        round.mediaMissing += 1;
        this.logger.warn('媒体归档回调抛错（不影响消息入库）', {
          msgKey: msg.msgKey,
          kind: ref.kind,
          error: errText(err),
        });
      }
    }
  }

  /**
   * 直链失败后的字节回落：用 OneBot 媒体接口重取一次。
   *
   * 采集到的图片/语音直链带 rkey 且有 TTL，过期后直链必然失败。若此时直接记
   * missing，「防丢失」在媒体这一半就是假的。`Collector.fetchMedia` 早已实现
   * `/get_image`、`/get_record`、`/get_file` 等**只读**重取，但生产路径从不调用
   * （只有测试直调），这里把它接到归档流程上。
   *
   * 返回 null 表示放弃回落（没拿到字节，或调用方没注入字节归档能力），此时调用方
   * 保留原来的 missing 结论。**任何异常都不冒泡**：媒体拿不到不该影响消息入库。
   */
  private async retryViaOneBot(
    ref: ResourceRef,
    msg: NormalizedMessage,
  ): Promise<ArchiveOutcome | null> {
    const sink = this.archiveMediaBytes;
    const archiver = this.archiver;
    const archiverBytes = archiver && typeof archiver.archiveBytes === 'function' ? archiver : null;
    // 两条字节入口都没有时不做无谓的下载。
    if (!sink && !archiverBytes) return null;
    try {
      const got = await this.collector.fetchMedia(ref);
      if (!got || !got.data || got.data.length === 0) return null;
      const candidates = toCandidates(ref);
      // 采集器重取时可能带回更准的文件名，补齐直链里缺的那份。
      if (!candidates.filename && got.filename) candidates.filename = got.filename;

      let outcome: ArchiveOutcome | null | void;
      if (sink) outcome = await sink(got.data, ref);
      else outcome = await (archiverBytes as MediaArchiverLike).archiveBytes!(got.data, candidates);
      if (!outcome) return null;
      this.logger.info('直链失败后经 OneBot 重取媒体字节', {
        msgKey: msg.msgKey,
        kind: ref.kind,
        bytes: got.data.length,
        status: outcome.status,
      });
      return outcome;
    } catch (err) {
      this.logger.warn('OneBot 媒体重取失败（保持 missing）', {
        msgKey: msg.msgKey,
        kind: ref.kind,
        error: errText(err),
      });
      return null;
    }
  }

  /**
   * 写 `media` 行 + `message_media` 关联。
   *
   * 缺失/损坏态也写（`status` 照实落库），这样 Web 媒体页与 `verify` 能看到
   * 「哪些媒体没拿到、为什么」，而不是静默消失。
   */
  private persistMedia(
    media: MediaInput,
    msg: NormalizedMessage,
    ref: ResourceRef,
    ordinal: number,
    ctx: MediaLinkContext,
  ): void {
    try {
      let mediaId = ctx.mediaIdBySha.get(media.sha256);
      if (mediaId === undefined) {
        mediaId = this.db.upsertMedia(media).id;
        ctx.mediaIdBySha.set(media.sha256, mediaId);
      }
      const messageId = ctx.messageIdByMsgKey.get(msg.msgKey);
      if (messageId === undefined) {
        this.logger.debug('媒体已归档但没有消息 id，未建立关联', { msgKey: msg.msgKey });
        return;
      }
      this.db.linkMessageMedia(messageId, mediaId, ordinal, ref.filename ?? null, ref.size ?? null);
    } catch (err) {
      // 字节已经落盘，入库失败不该回滚采集轮次；但必须留下可诊断的痕迹。
      this.logger.warn('媒体入库失败（字节已落盘，未建立关联）', {
        msgKey: msg.msgKey,
        sha256: media.sha256,
        error: errText(err),
      });
    }
  }

  /**
   * 记下一批消息的 msgKey → message id，供媒体关联使用。
   *
   * `insertMessages` 对重复消息也会返回既有 id（见 db 包 findSql 分支），
   * 因此只有「本批有插入失败」时 messageIds 才与 chunk 错位，此时逐个回查兜底。
   */
  private recordMessageIds(
    res: InsertResult,
    chunk: NormalizedMessage[],
    sessionKey: string,
    out: Map<string, number>,
  ): void {
    const aligned = res.failed === 0 && res.messageIds.length === chunk.length;
    for (let i = 0; i < chunk.length; i += 1) {
      const m = chunk[i];
      if (!m) continue;
      const id = aligned ? res.messageIds[i] : this.lookupMessageId(sessionKey, m.msgKey);
      if (typeof id === 'number') out.set(m.msgKey, id);
    }
  }

  /** 插入失败的批兜底：按 (account_uid, session_key, msg_key) 回查消息 id。 */
  private lookupMessageId(sessionKey: string, msgKey: string): number | null {
    try {
      const row = this.db.raw
        .prepare('SELECT id FROM messages WHERE account_uid = ? AND session_key = ? AND msg_key = ?')
        .get(this.accountUid, sessionKey, msgKey) as unknown as { id?: number } | undefined;
      return typeof row?.id === 'number' ? row.id : null;
    } catch (err) {
      this.logger.debug('回查消息 id 失败', { sessionKey, msgKey, error: errText(err) });
      return null;
    }
  }

  /** 连续失败达到阈值时的告警：写库日志 + POST webhook（失败不影响主流程）。 */
  private async raiseAlert(message: string, data: Record<string, unknown>): Promise<void> {
    try {
      this.db.appendLog({ level: 'error', scope: 'collect', message, data });
    } catch (err) {
      this.logger.warn('写告警日志失败', { error: errText(err) });
    }
    this.logger.error(message, data);
    const url = this.alertConf?.webhookUrl ?? '';
    if (!url) return;
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'collect_failure', at: this.iso(this.nowMs()), ...data }),
      });
      if (!res.ok) this.logger.warn('告警 webhook 返回非 2xx', { status: res.status });
    } catch (err) {
      this.logger.warn('告警 webhook 推送失败（不影响采集）', { error: errText(err) });
    }
  }

  /**
   * 展开本批消息里的合并转发：写 `extra.forward` + 平铺子消息资源。
   *
   * **必须在 `insertMessages` 之前调用** —— `extra` 是要落库的字段，展开晚了就白展开。
   *
   * 容错策略：单条转发拉取失败只记警告（`round.forwardFailed`），绝不影响该会话其余
   * 消息；父消息原本的 `[合并转发]` 占位文本仍在，最坏情况退化成修复前的行为。
   */
  private async expandForwards(msgs: NormalizedMessage[], round: CollectRound): Promise<void> {
    const fetchForward = this.collector.fetchForward?.bind(this.collector);
    if (!fetchForward) return;
    const maxDepth = Math.max(0, Math.floor(this.config.forwardDepth ?? DEFAULT_FORWARD_DEPTH));
    if (maxDepth === 0) return;
    const maxNodes = Math.max(1, Math.floor(this.config.forwardMaxNodes ?? DEFAULT_FORWARD_MAX_NODES));

    for (const msg of msgs) {
      if (!msg.forwardId) continue;
      const ownCount = msg.resources?.length ?? 0;
      try {
        const expanded = await expandForward({
          fetchForward,
          forwardId: msg.forwardId,
          ownResources: msg.resources,
          maxDepth,
          maxNodes,
        });
        // 空转发 / 不可读转发：不动 msg，避免写出一个有结构但没内容的空壳。
        if (expanded.forward.count === 0 && expanded.resources.length === ownCount) {
          this.logger.debug('合并转发没有可取内容（保留占位文本）', {
            msgKey: msg.msgKey,
            forwardId: msg.forwardId,
          });
          continue;
        }
        if (expanded.resources.length > ownCount) msg.resources = expanded.resources;
        msg.extra = { ...(msg.extra ?? {}), forward: expanded.forward };
        round.forwardMessages = (round.forwardMessages ?? 0) + expanded.forward.count;
        if (expanded.forward.truncated) {
          this.logger.warn('合并转发内容被限流截断（已保存截断标记）', {
            msgKey: msg.msgKey,
            forwardId: msg.forwardId,
            count: expanded.forward.count,
            maxDepth,
            maxNodes,
          });
        }
      } catch (err) {
        round.forwardFailed = (round.forwardFailed ?? 0) + 1;
        this.logger.warn('合并转发内容拉取失败（保留 [合并转发] 占位）', {
          msgKey: msg.msgKey,
          forwardId: msg.forwardId,
          error: errText(err),
        });
      }
    }
  }

  /** 跑一轮采集。并发调用共享同一轮结果。 */
  async runOnce(): Promise<CollectRound> {
    if (this.inFlight) return this.inFlight;
    const p = this.runRound();
    this.inFlight = p;
    try {
      return await p;
    } finally {
      if (this.inFlight === p) this.inFlight = null;
    }
  }

  private async runRound(): Promise<CollectRound> {
    const startedMs = this.nowMs();
    const round: CollectRound = {
      sessions: 0,
      fetched: 0,
      inserted: 0,
      duplicate: 0,
      failed: 0,
      mediaSaved: 0,
      mediaMissing: 0,
      errors: [],
    };
    let fatal: string | null = null;
    let failedSessions = 0;
    let okSessions = 0;

    let jobId = 0;
    try {
      jobId = this.db.createJob({ kind: 'collect', accountUid: this.accountUid, options: { source: this.source } });
      this.db.updateJob(jobId, { status: 'running', startedAt: this.iso(startedMs) });
    } catch (err) {
      this.logger.warn('创建采集任务失败（继续采集）', { error: errText(err) });
    }

    try {
      const { sessions, error } = await this.discoverSessions();
      if (error) {
        fatal = error;
        this.logger.warn('会话发现异常', { error });
      }
      for (const session of sessions) {
        const key = sessionKeyOf(session.chatType, session.peerUid);
        round.sessions += 1;
        const state = this.db.getCollectState(this.source, this.accountUid, key);
        const cursorTs = state?.cursorTs ?? 0;
        const nowMs = this.nowMs();
        const backfillStart = nowMs - this.config.initialBackfillDays * 86_400_000;
        const sinceTs = cursorTs > 0 ? Math.max(cursorTs - this.config.lookbackSec * 1000, backfillStart) : backfillStart;

        try {
          const msgs = await this.fetchWithRetry(session, sinceTs);
          round.fetched += msgs.length;

          // 合并转发必须先展开再入库：子消息正文落在 `messages.extra`，子消息媒体
          // 平铺进父消息 `resources`，与普通媒体走同一条归档 / message_media 通路。
          await this.expandForwards(msgs, round);

          // 过滤：默认只给消息打 `filtered` 标记（**照样入库**，防丢失优先），
          // 只有 `filters.drop = true` 时才真的把它们从这一批里剔除、跳过存储。
          // 放在转发展开之后：展开会往 text 补子消息摘要，关键词可能落在补进去的内容上。
          if (this.filters.enabled && msgs.length > 0) {
            const verdicts = matchMessageFilters(msgs, this.filters);
            if (verdicts.size > 0) {
              round.filtered = (round.filtered ?? 0) + verdicts.size;
              if (this.filters.drop) {
                let removed = 0;
                for (let i = msgs.length - 1; i >= 0; i -= 1) {
                  const m = msgs[i];
                  if (m && verdicts.has(m.msgKey)) {
                    msgs.splice(i, 1);
                    removed += 1;
                  }
                }
                round.dropped = (round.dropped ?? 0) + removed;
                this.logger.debug('按过滤规则跳过存储', { session: key, dropped: removed });
              } else {
                for (const m of msgs) {
                  const v = verdicts.get(m.msgKey);
                  if (v) {
                    m.filtered = true;
                    if (v.reason !== null) m.filterReason = v.reason;
                  }
                }
              }
            }
          }

          const normalizedSession: NormalizedSession = {
            accountUid: this.accountUid,
            chatType: session.chatType,
            peerUid: session.peerUid,
            peerUin: session.peerUin,
            name: session.name,
            source: this.source,
          };
          const record = this.db.ensureSession(normalizedSession);

          const chunks = chunkMessages(msgs, Math.max(1, Math.floor(this.config.pageSize) || 1));
          let cycleTs = cursorTs;
          let cycleSeq: string | null = state?.cursorSeq ?? null;
          // 媒体关联需要 msgKey → message id；在插入每一批时顺手记下来。
          const mediaCtx: MediaLinkContext = { messageIdByMsgKey: new Map(), mediaIdBySha: new Map() };
          if (chunks.length === 0) {
            this.markSessionOk(key, cycleTs, cycleSeq);
          }
          for (const chunk of chunks) {
            const res: InsertResult = this.db.insertMessages(record.id, this.accountUid, key, chunk, {
              source: this.source,
            });
            round.inserted += res.inserted;
            round.duplicate += res.duplicate;
            round.failed += res.failed;
            for (const e of res.errors) round.errors.push({ session: key, error: e });
            this.recordMessageIds(res, chunk, key, mediaCtx.messageIdByMsgKey);
            for (const m of chunk) {
              if (Number.isFinite(m.ts) && m.ts > cycleTs) cycleTs = Math.round(m.ts);
              const seqNum = m.seq === undefined ? null : Number(m.seq);
              if (seqNum !== null && Number.isFinite(seqNum)) {
                const prev = cycleSeq === null ? null : Number(cycleSeq);
                if (prev === null || !Number.isFinite(prev) || seqNum > prev) cycleSeq = String(seqNum);
              }
            }
            // 每批成功立刻持久化游标：崩溃后不重复拉取。
            this.markSessionOk(key, cycleTs, cycleSeq);
          }

          if (this.config.syncMedia) {
            for (const m of msgs) await this.handleMedia(m, round, mediaCtx);
          }
          okSessions += 1;
        } catch (err) {
          failedSessions += 1;
          round.failed += 1;
          const failures = (state?.consecutiveFailures ?? 0) + 1;
          const message = errText(err);
          round.errors.push({ session: key, error: message });
          this.logger.warn('会话采集失败（不影响其他会话）', { sessionKey: key, error: message, failures });
          try {
            this.db.upsertCollectState({
              source: this.source,
              accountUid: this.accountUid,
              sessionKey: key,
              cursorTs,
              cursorSeq: state?.cursorSeq ?? null,
              lastError: message,
              ok: false,
              failures,
            });
          } catch (e2) {
            this.logger.warn('写失败游标失败', { sessionKey: key, error: errText(e2) });
          }
        }
      }
    } catch (err) {
      fatal = errText(err);
      round.errors.push({ session: '*', error: fatal });
      this.logger.error('采集轮次异常终止', { error: fatal });
    }

    const roundFailed = fatal !== null || (round.sessions > 0 && failedSessions === round.sessions);
    if (roundFailed) {
      this.consecutiveFailures += 1;
      this.lastError = fatal ?? round.errors[0]?.error ?? '采集失败';
      const threshold = this.alertConf?.collectFailureThreshold ?? 0;
      if (threshold > 0 && this.consecutiveFailures >= threshold) {
        await this.raiseAlert('采集连续失败达到阈值', {
          consecutiveFailures: this.consecutiveFailures,
          threshold,
          lastError: this.lastError,
          sessions: round.sessions,
          errors: round.errors.slice(0, 5),
        });
      }
    } else if (okSessions > 0 || round.sessions === 0) {
      this.consecutiveFailures = 0;
      this.lastError = null;
      this.lastOkAt = this.iso(this.nowMs());
    }

    const finished = this.iso(this.nowMs());
    if (jobId > 0) {
      try {
        this.db.updateJob(jobId, {
          status: roundFailed ? 'failed' : 'done',
          inserted: round.inserted,
          duplicate: round.duplicate,
          failed: round.failed,
          mediaSaved: round.mediaSaved,
          mediaMissing: round.mediaMissing,
          progress: 100,
          message: `sessions=${round.sessions} fetched=${round.fetched}`,
          error: roundFailed ? this.lastError : null,
          finishedAt: finished,
        });
      } catch (err) {
        this.logger.warn('更新采集任务失败', { error: errText(err) });
      }
    }

    this.logger.info('采集轮次结束', {
      sessions: round.sessions,
      fetched: round.fetched,
      inserted: round.inserted,
      duplicate: round.duplicate,
      failed: round.failed,
      mediaSaved: round.mediaSaved,
      mediaMissing: round.mediaMissing,
      forwardMessages: round.forwardMessages ?? 0,
      forwardFailed: round.forwardFailed ?? 0,
      // 过滤计数：filtered 是"命中规则"的条数（默认这些消息**仍在库**），
      // dropped 是真正被跳过存储的条数（只有 filters.drop=true 才可能非 0）。
      filtered: round.filtered ?? 0,
      dropped: round.dropped ?? 0,
      ok: !roundFailed,
    });
    return round;
  }

  private markSessionOk(sessionKey: string, cursorTs: number, cursorSeq: string | null): void {
    this.db.upsertCollectState({
      source: this.source,
      accountUid: this.accountUid,
      sessionKey,
      cursorTs,
      cursorSeq,
      lastError: null,
      ok: true,
      failures: 0,
    });
  }

  /** 启动定时循环，返回幂等的 stop()。 */
  /** 定时采集是否正在运行（供服务端/网页面板显示"运行中/已停止"）。 */
  isRunning(): boolean {
    return this.running;
  }

  start(): () => Promise<void> {
    if (this.running) throw new Error('CollectRunner.start() 已在运行');
    this.running = true;
    const intervalMs = Math.max(1, Math.round(this.config.intervalSec * 1000));
    this.loopDone = (async () => {
      while (this.running) {
        try {
          await this.runOnce();
        } catch (err) {
          this.logger.error('定时采集轮次抛错', { error: errText(err) });
        }
        if (!this.running) break;
        await this.sleepImpl(intervalMs);
      }
    })();
    let stopped = false;
    return async () => {
      if (stopped) return;
      stopped = true;
      this.running = false;
      if (this.loopDone) await this.loopDone;
    };
  }
}

function chunkMessages(msgs: NormalizedMessage[], size: number): NormalizedMessage[][] {
  const out: NormalizedMessage[][] = [];
  for (let i = 0; i < msgs.length; i += size) out.push(msgs.slice(i, i + size));
  return out;
}

/** 媒体落盘与媒体入库之间传递的两个索引（每次会话一批，轮次内局部）。 */
interface MediaLinkContext {
  /** msgKey → messages.id（插入时记录）。 */
  messageIdByMsgKey: Map<string, number>;
  /** sha256 → media.id（同一内容只 upsert 一次）。 */
  mediaIdBySha: Map<string, number>;
}

/**
 * 窄化归档产物：只有 `MediaArchiver` 产出的结构化 `MediaInput` 才能入库。
 *
 * collect 包的 `ArchiveOutcome.media` 故意声明为 `unknown`（避免跨包类型依赖），
 * 因此这里做运行时校验；调用方注入的 `archiveMedia` 回调如果返回 void/null
 * （表示它自己入库），这里会安全地什么都不做。
 */
function asMediaInput(v: unknown): MediaInput | null {
  if (v === null || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  if (typeof r.sha256 !== 'string' || r.sha256 === '') return null;
  if (typeof r.relPath !== 'string' || r.relPath === '') return null;
  if (typeof r.kind !== 'string' || r.kind === '') return null;
  if (typeof r.size !== 'number') return null;
  return v as MediaInput;
}

function toCandidates(ref: ResourceRef): ArchiveCandidates {
  const c: ArchiveCandidates = { kind: ref.kind };
  if (ref.localPath) c.localPath = ref.localPath;
  if (ref.url) c.url = ref.url;
  if (ref.filename) c.filename = ref.filename;
  if (ref.size !== undefined) c.declaredSize = ref.size;
  return c;
}
