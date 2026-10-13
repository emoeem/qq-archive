/**
 * `@qqarchive/collect` —— OneBot v11 只读采集适配器 + 采集调度器。
 *
 * 对外契约（冻结，见 docs/ARCHITECTURE.md 第 5 节）：
 *  - `Collector` 接口、`OneBotCollector` 实现；
 *  - `CollectRunner`（runOnce / start / health）；
 *  - 结果类型 `CollectRound` / `CollectHealth` / `SessionInfo` 等；
 *  - 工厂 `createCollectRunner()`：server 的自动探测与 apps/cli 共用同一份构造逻辑。
 */
import { collectorUnavailable, filtersConfigOf, type AppConfig, type ScopedLogger } from '../../core/src/index.ts';
import type { Db } from '../../db/src/index.ts';
import { OneBotCollector } from './onebot.ts';
import { CollectRunner } from './runner.ts';
import type { ArchiveMediaFn, MediaArchiverLike } from './types.ts';
import type { FetchLike } from './util.ts';

export * from './types.ts';
export {
  DEFAULT_FORWARD_DEPTH,
  DEFAULT_FORWARD_MAX_NODES,
  expandForward,
  resourceDedupKey,
  type ExpandedForward,
  type ExpandForwardOptions,
  type StoredForward,
  type StoredForwardNode,
} from './forward.ts';
export { OneBotCollector, READ_ONLY_ACTIONS, type OneBotCollectorOptions } from './onebot.ts';
export {
  CollectRunner,
  COLLECT_SOURCE,
  RETRY_DELAYS_MS,
  type CollectRunnerOptions,
  type CollectHealth,
} from './runner.ts';
export { parseOneBotMessage, parseCqStringInto, cqParams, cqUnescape, type ParsedCqMessage } from './cq.ts';
export {
  matchMessageFilter,
  matchMessageFilters,
  describeFilters,
  type FilterableMessage,
  type FilterVerdict,
} from './filter.ts';
export { asArray, asRecord, errText, num, str, type FetchLike } from './util.ts';
export {
  NapCatWebUi,
  napcatWebUiPasswordHash,
  NAPCAT_DEFAULT_WEBUI_URL,
  NAPCAT_DEFAULT_PROBE_RANGE,
  NAPCAT_DEFAULT_TIMEOUT_MS,
  NAPCAT_DEFAULT_CONNECT_TIMEOUT_MS,
  NAPCAT_PASSWORD_SUFFIX,
  NAPCAT_QR_FIELDS,
  type NapCatWebUiOptions,
  type NapCatQrCode,
  type NapCatLoginStatus,
  type NapCatQuickAccount,
  type NapCatQuickLoginResult,
  type PortProbeFn,
} from './napcat-webui.ts';

/* ------------------------------------------------------------------ */
/* 工厂：让 server 的自动探测与 apps/cli 共用同一份构造逻辑             */
/* ------------------------------------------------------------------ */

/** `createCollectRunner()` 入参（server 探测时只传 config/db/logger 三件套）。 */
export interface CreateCollectRunnerOptions {
  /** 完整应用配置；采集参数取自 `config.collector`，告警参数取自 `config.alert`。 */
  config: AppConfig;
  db: Db;
  logger: ScopedLogger;
  /** 媒体归档实现（packages/import 的 MediaArchiver）；不注入则只记录媒体元数据。 */
  archiver?: MediaArchiverLike;
  /** 更简单的媒体回调；与 `archiver` 二选一（同时给时 `archiveMedia` 优先）。 */
  archiveMedia?: ArchiveMediaFn;
  /** 账号归属；缺省 `default`。 */
  accountUid?: string;
  now?: () => number;
  /** 覆盖 OneBot 请求用的 fetch（测试/代理用）。 */
  fetchImpl?: FetchLike;
}

/**
 * 按 `config.collector` 构造 `OneBotCollector` + `CollectRunner`。
 *
 * 语义（与 server 的动态探测约定一致）：
 *  - `collector.kind === 'none'`：采集未启用，**返回 null**（server 探测据 falsy 判定不可用）；
 *  - `collector.kind === 'onebot'`：必须配置 `baseUrl`，否则抛
 *    `AppError('COLLECTOR_UNAVAILABLE')`（明确上报，而不是静默退化）；
 *  - 返回对象一定具有 `runOnce()`，可直接作为 `ServerOptions.collect` 传入。
 */
export function createCollectRunner(opts: CreateCollectRunnerOptions): CollectRunner | null {
  const collectorConf = opts.config?.collector;
  if (!collectorConf || collectorConf.kind === 'none') return null;
  if (collectorConf.kind !== 'onebot') {
    throw collectorUnavailable(`不支持的采集器类型：${String((collectorConf as { kind?: unknown }).kind)}`);
  }
  if (!collectorConf.baseUrl) {
    throw collectorUnavailable('collector.kind=onebot 但 collector.baseUrl 为空，无法连接 OneBot 实现');
  }

  const collector = new OneBotCollector({
    baseUrl: collectorConf.baseUrl,
    token: collectorConf.token,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });

  return new CollectRunner({
    db: opts.db,
    collector,
    config: collectorConf,
    logger: opts.logger,
    filters: filtersConfigOf(opts.config),
    ...(opts.archiver ? { archiver: opts.archiver } : {}),
    ...(opts.archiveMedia ? { archiveMedia: opts.archiveMedia } : {}),
    ...(opts.accountUid ? { accountUid: opts.accountUid } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    alert: opts.config.alert,
  });
}
