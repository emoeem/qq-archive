# 架构契约（冻结版 v1）

> 本文件是并行开发的**唯一接口依据**。任何模块之间的调用都必须遵守这里的签名与语义；
> 需要变更时先改本文件 + `packages/core/src/types.ts`，再改实现。

## 0. 目录布局

```
QQ/
├── packages/core/        @qqarchive/core   领域类型、配置、日志、键生成、错误
├── packages/db/          @qqarchive/db     SQLite 存储层（迁移/仓储/FTS/备份恢复）
├── packages/import/      @qqarchive/import 导入器（QCE JSON/JSONL、TXT、通用）+ 媒体归档
├── packages/collect/     @qqarchive/collect 采集适配器（OneBot/NapCat）+ 调度与告警
├── packages/server/      @qqarchive/server  HTTP API + 静态前端托管 + 认证
├── apps/cli/             CLI 入口（serve / import / collect / backup / restore / doctor）
├── web/                  前端静态资源（原生 JS，无构建步骤）
├── deploy/               systemd unit、示例配置、安装脚本
├── tests/                node:test 测试与测试数据生成器
└── docs/                 文档
```

运行方式：**Node 24 直接运行 TypeScript**（`--experimental-strip-types`），无编译产物、无打包步骤。
模块内部相对导入必须带 `.ts` 后缀（NodeNext + type stripping 要求）。

## 1. 技术选型与理由（已定，不再讨论）

| 关注点 | 选择 | 理由 |
| --- | --- | --- |
| 运行时 | Node.js ≥ 22.5（本机 24.21） | 原生 `node:sqlite`、原生 TS 剥离 |
| 数据库 | **内置 `node:sqlite`**（SQLite 3.53，WAL + FTS5 + JSON1） | 零原生编译依赖，Linux/Windows/ARM 都能装；已实测 FTS5/JSON1/WAL 可用 |
| 中文全文检索 | FTS5 `unicode61` + 应用层 CJK **二元切分**（`buildSearchText`） | 不依赖 trigram（老版本 SQLite 没有），中文子串可搜 |
| HTTP | `node:http` 自研极简路由 + `node:crypto` | 无第三方框架依赖，安全面小，便于审计 |
| 前端 | 原生 ES 模块 + 手写 CSS | 无构建步骤，node:test 可直接测前端纯函数 |
| 采集 | OneBot v11 HTTP（NapCat / LLOneBot 等实现） | 只读接口、可断点续传、不注入不 hook |
| 测试 | `node:test` + `node:assert/strict` | 内置，零依赖 |

**依赖策略：生产依赖为 0。** 所有功能用 Node 内置模块实现。这是可审计、可长期运行的最优解；
唯一外部程序依赖是**可选**的 `ffmpeg`（视频缩略图 / 转码），缺失时功能降级而不是报错。

## 2. `@qqarchive/core` 公共 API

```ts
// 类型（packages/core/src/types.ts）：见文件，全部为契约
// 工具（packages/core/src/ids.ts）
sha256Hex(input: string | Uint8Array): string
sessionKeyOf(chatType: string, peerUid: string): string            // "<chatType>:<peerUid>"
messageKeyOf(input: {msgId?, ts, senderUid?, senderUin?, text?, resources?, seq?}): string
safeFilename(name: string, fallbackExt?: string): string
formatTime(ts: number): string
parseTimeString(s: string | null | undefined): number | null
buildSearchText(text: string): string                              // CJK 二元切分
bigrams(seg: string): string
escapeFtsQuery(query: string): string
escapeHtml(s: string): string

// 配置（packages/core/src/config.ts）
loadConfig(configPath?: string): LoadedConfig
validateConfig(cfg: AppConfig): string[]
DEFAULT_CONFIG: AppConfig

// 日志（packages/core/src/logger.ts）
createLogger(opts?: LoggerOptions): Logger
new Logger(opts).child(scope): ScopedLogger   // debug/info/warn/error/fail

// 错误（packages/core/src/errors.ts）
class AppError extends Error { code: AppErrorCode; status: number; details?: unknown }
badRequest / unauthorized / forbidden / notFound / unsupportedFormat /
mediaMissing / mediaCorrupt / collectorUnavailable / internal
```

## 3. `@qqarchive/db` 公共 API（仓储层）

```ts
openDatabase(opts: { path: string; logger?: ScopedLogger }): Db
class Db {
  readonly raw: DatabaseSync;              // 逃生舱，仅供本包内部与迁移使用
  readonly path: string;
  close(): void;
  schemaVersion(): number;
  health(): { ok: boolean; schemaVersion: number };

  // 账号 / 会话 / 联系人
  ensureAccount(a: {uid: string; uin?: string; displayName?: string}): void;
  ensureSession(s: NormalizedSession): SessionRecord;        // 不存在则建，存在则补充 name/uin
  listSessions(q: {accountUid?: string; chatType?: ChatType; keyword?: string; page?: number; pageSize?: number; sort?: 'recent'|'messages'|'name'}): Page<SessionRecord>;
  getSession(id: number): SessionRecord | null;
  getSessionByKey(accountUid: string, sessionKey: string): SessionRecord | null;
  touchSessionStats(sessionId: number): void;

  // 消息写入（幂等）
  insertMessages(sessionId: number, accountUid: string, sessionKey: string,
                 msgs: NormalizedMessage[], opts: { batchId?: number; source: string }): InsertResult;
  // InsertResult = { inserted: number; duplicate: number; failed: number; messageIds: number[]; errors: string[] }

  // 查询
  listMessages(q: {sessionId: number; from?: number; to?: number; senderUid?: string; msgType?: MessageType;
                   keyword?: string; direction?: Direction; before?: number; after?: number;
                   limit?: number; order?: 'asc'|'desc'; includeRecalled?: boolean}): { items: MessageRecord[]; hasMore: boolean };
  getMessage(id: number): MessageRecord | null;
  searchMessages(q: {keyword: string; accountUid?: string; sessionId?: number; chatType?: ChatType;
                     from?: number; to?: number; msgType?: MessageType; senderUid?: string;
                     page?: number; pageSize?: number}): Page<SearchHit>;

  // 媒体
  upsertMedia(input: MediaInput): { id: number; created: boolean };
  linkMessageMedia(messageId: number, mediaId: number, ordinal: number, filename?: string | null, declaredSize?: number | null): void;
  getMedia(id: number): MediaRow | null;
  getMediaBySha(sha256: string): MediaRow | null;
  // keyword 同时匹配文件名与**转写文本**；transcribed 过滤「是否已有转写」
  listMedia(q: {kind?: MediaKind; status?: MediaStatus; sessionId?: number; from?: number; to?: number; keyword?: string;
                transcribed?: boolean; page?: number; pageSize?: number}): Page<MediaRow & {sessionName: string | null;
                messageId: number | null; transcript: string | null}>;
  markMediaStatus(id: number, status: MediaStatus, failReason?: string | null): void;
  mediaStats(): {total: number; present: number; missing: number; corrupt: number; bytes: number};

  // 语音转写（media_transcripts，与 media 一对一，随 media 级联删除）
  upsertTranscript(input: {mediaId: number; text: string; language?: string | null; engine: string;
                           model?: string | null; segments?: number | null; elapsedMs?: number | null}): void;
  getTranscript(mediaId: number): TranscriptRow | null;
  getTranscripts(mediaIds: number[]): Map<number, TranscriptRow>;
  listUntranscribedAudio(limit: number): Array<{id: number; relPath: string; sha256: string; duration: number | null}>;
  deleteTranscript(mediaId: number): number;
  transcriptStats(): {total: number; chars: number; engines: Array<{engine: string; count: number}>};
  /** 删除 ref_count=0 且文件存在的孤儿媒体，返回删除数 */
  gcOrphanMedia(mediaDir: string, dryRun: boolean): { deleted: number; bytes: number };

  // 任务 / 采集状态 / 备份
  createJob(j: {kind: 'import'|'collect'|'backup'; format?: string; accountUid?: string; sourcePath?: string; options?: unknown}): number;
  updateJob(id: number, patch: Partial<JobRecord>): void;
  getJob(id: number): JobRecord | null;
  listJobs(q?: {status?: string; kind?: string; limit?: number; page?: number}): Page<JobRecord>;
  getCollectState(source: string, accountUid: string, sessionKey: string): CollectStateRow | null;
  upsertCollectState(row: {source: string; accountUid: string; sessionKey: string; cursorTs?: number; cursorSeq?: string | null;
                          lastError?: string | null; ok?: boolean}): void;
  listCollectStates(): CollectStateRow[];
  createBackup(row: {path: string; kind: string}): number;
  finishBackup(id: number, patch: Partial<BackupRecord>): void;
  listBackups(limit?: number): BackupRecord[];

  // 日志 / 统计 / 设置
  appendLog(e: {level: LogLevel; scope: string; message: string; data?: unknown}): void;
  listLogs(q?: {level?: LogLevel; scope?: string; limit?: number; page?: number; since?: string}): Page<LogRecord>;
  pruneLogs(keepDays: number): number;
  stats(): ArchiveStats;
  getSetting(key: string): string | null;
  setSetting(key: string, value: string): void;
  allSettings(): Record<string, string>;
}
```

**关键 DB 语义（写入方必须遵守）**

1. `insertMessages` 幂等：以 `(account_uid, session_key, msg_key)` 唯一约束判重；重复走 `duplicate++`，
   且**不覆盖**已有行（避免导出文件里的旧快照覆盖更完整的归档）。
2. FTS 在**同一事务内**同步写入：`messages_fts` 与 `messages_fts_bigram` 的 rowid 都等于 `messages.id`。
3. `session.message_count / first_message_at / last_message_at` 在批量插入后重算一次（`touchSessionStats`）。
4. 任何写操作都在事务里；失败整体回滚，部分失败记入 `InsertResult.errors`。
5. 时间一律毫秒整数；`ts<=0` 视为无效，拒绝插入（计入 failed 并写日志）。

## 4. `@qqarchive/import` 公共 API

```ts
// 格式探测
detectFormat(filePath: string, head?: string): 'qce-json' | 'qce-jsonl' | 'qce-txt' | 'generic-jsonl' | 'unknown';
interface Importer {
  readonly name: string;
  readonly formats: string[];
  /** 流式解析，逐批回调；返回统计。 */
  run(ctx: ImportContext): Promise<ImportStats>;
}
interface ImportContext {
  filePath: string;
  accountUid: string;                    // 默认 'default'
  onBatch(batch: ImportBatch): Promise<void>;   // 由调用方写库
  logger: ScopedLogger;
  signal?: AbortSignal;
  limit?: number;                        // 仅导入前 N 条（测试用）
  mediaDir?: string;                     // 提供时同步归档媒体
  mediaResolver?: MediaResolver;         // 自定义媒体来源
}
interface ImportStats {
  format: string; totalItems: number; batches: number; inserted: number; duplicate: number;
  failed: number; mediaSaved: number; mediaMissing: number; durationMs: number; errors: string[];
}
// 入口
importFile(ctx: ImportContext): Promise<ImportStats>          // 自动探测格式
listImporters(): Array<{name: string; formats: string[]}>
```

支持格式与来源：

| 格式 | 来源 | 说明 |
| --- | --- | --- |
| `qce-json` | qq-chat-exporter JSON 导出（`metadata`/`chatInfo`/`statistics`/`messages`） | 主目标格式，字段见 `docs/format-mapping.md` |
| `qce-jsonl` | QCE chunked JSONL（每行一条消息，或包一层） | 大文件流式，逐行解析 |
| `qce-txt` | QCE TXT 导出 | 尽力解析；无法解析的行计入 `errors` 并保留原文 |
| `generic-jsonl` | 自带规范：每行 `NormalizedMessage` 风格对象 | 供用户自行转换/其他工具接入 |
| `html` | 聊天记录**导出为网页**（QCE viewer / 一般聊天页 HTML） | 手写扫描器，**零 HTML 依赖**；兼容 `data-*`、内嵌 JSON 与通用消息容器。探测保守：不像聊天页就不认，需 `--format html` 显式指定 |

媒体归档（`packages/import/src/media.ts`）：

```ts
class MediaArchiver {
  constructor(opts: {root: string; maxBytes: number; logger: ScopedLogger; ffmpegPath?: string});
  /** 从候选来源归档一个媒体；返回 MediaInput（或失败标记）。 */
  archive(candidates: {localPath?: string; url?: string; filename?: string; kind: MediaKind; declaredSize?: number}): Promise<ArchiveOutcome>;
  /** 校验已存在的文件（sha256 比对），返回 present/corrupt/missing。 */
  verify(relPath: string, expectedSha256: string): 'present'|'corrupt'|'missing';
  ensureThumb(media: ThumbSource): Promise<string | null>; // 图片缩略图 / 视频抽帧
}
// ThumbSource  = {status; kind; sha256; relPath}（MediaRow 与尚未入库的 MediaInput 都满足）
// commit() 落盘后**立即**调用 ensureThumb()，把 thumbRel 一起放进 MediaInput.thumbPath；
// 于是 import（runImport）与 collect（MediaArchiverLike.archive）两条链路都会生成缩略图，
// 无需任何调用方额外接线。ffmpeg 缺失或抽帧失败只是没有 thumbPath，不影响归档结果。
// ArchiveOutcome = {status:'present'|'missing'|'corrupt'; media?: MediaInput; reason?: string}
```

**媒体规则（硬性）**

- 落盘路径：`<mediaDir>/<kind>/<yyyy>/<mm>/<sha256前2位>/<sha256>.<ext>`，内容寻址、天然去重、不覆盖。
- 先写 `*.part` 再 `rename`，保证不会出现半个文件被当成完整文件。
- **断点续传（HTTP Range）**：临时路径按 `(url, dest)` 确定性派生，旁边写 `<file>.part.meta.json` 记录
  `{url, finalUrl, etag, lastModified, totalBytes, written}`。重跑时若残片与 sidecar 都在且 url 一致，
  就发 `Range: bytes=<written>-`；有强校验器（etag 优先于 last-modified）时带 `If-Range`。
  `206` 追加并要求 `Content-Range.start === offset`；`200` 说明服务端忽略了 Range → 截断重下；
  `416` → 丢掉残片重下。`maxBytes` 按**总大小**（不是本次增量）判断。
  成功的 sha256 对**完整重组后的文件**计算，落盘成功后先删 sidecar 再原子 `rename`。
- 必须计算并保存 sha256；`size` 与校验值一起入库。
- 原始文件不存在 / URL 404 → `status='missing'` + 明确 `fail_reason`，**绝不生成占位文件**。
- 同 sha256 只存一份，`media.ref_count` 增加。

## 5. `@qqarchive/collect` 公共 API

```ts
interface Collector {
  readonly kind: string;
  /** 探活：/get_login_info + /get_status */
  probe(): Promise<{ok: boolean; uin?: string; nickname?: string; error?: string}>;
  /** 列出可见会话（群 + 好友）。 */
  listSessions(): Promise<Array<{chatType: 'group'|'private'; peerUid: string; peerUin: string; name: string}>>;
  /** 增量拉取一个会话自 since 起的消息，返回按时间升序的归一化消息。 */
  fetchSince(session: CollectSession, sinceTs: number, opts: {pageSize: number; maxPages: number}): Promise<NormalizedMessage[]>;
  /** 下载媒体（OneBot /get_image、/get_record、/get_file 或直链）。 */
  fetchMedia(ref: ResourceRef): Promise<{data: Uint8Array; filename?: string} | null>;
  /** 可选：展开一条合并转发（OneBot /get_forward_msg）。不实现则转发只留 [合并转发] 占位。 */
  fetchForward?(id: string): Promise<ForwardNode[]>;
}
// ForwardNode = {senderUin?; senderName?; ts; text; msgType; elements?; resources: ResourceRef[]; forwardId?}
class OneBotCollector implements Collector { constructor(opts: {baseUrl: string; token?: string; fetchImpl?: typeof fetch}) }

class CollectRunner {
  constructor(opts: {db: Db; collector: Collector; archiver?: MediaArchiver; config: CollectorConfig;
                     logger: ScopedLogger; now?: () => number});
  /** 跑一轮采集（可并发多会话，但每会话串行）。返回本轮统计。 */
  runOnce(): Promise<CollectRound>;
  /** 启动定时循环；返回 stop()。 */
  start(): () => Promise<void>;
  /** 健康状态（供 /api/health 使用）。 */
  health(): {ok: boolean; lastOkAt: string | null; lastError: string | null; consecutiveFailures: number};
}
// CollectRound = {sessions: number; fetched: number; inserted: number; duplicate: number; failed: number;
//                 mediaSaved: number; mediaMissing: number; errors: Array<{session: string; error: string}>;
//                 forwardMessages?: number; forwardFailed?: number}   // 只在真有值时出现
```

**采集规则**

- 断点续传：游标 = `collect_state.cursor_ts`，每成功写入一批后**立即**持久化（`upsertCollectState`）。
- 每轮先把 `since = max(cursorTs - lookbackSec*1000, now - initialBackfillDays*86400_000)`。
- 失败重试：指数退避（1s/2s/4s，最多 3 次），仍失败则记 `collect_state.last_error` 与 `consecutive_failures`，
  超过 `alert.collectFailureThreshold` 触发告警。
- **合并转发展开**：每条带 `forwardId` 的消息调 `collector.fetchForward`，递归展开（默认
  `collector.forwardDepth=3` 层、`collector.forwardMaxNodes=200` 个节点）成一个
  `StoredForward` 树存进 `messages.extra.forward`，转发内的图片/视频/文件会被一起归档并
  按 `resources` 下标写 `message_media.ordinal`。触顶或超预算时保留节点自身的 `forwardId`
  并置 `forwardTruncated=true`（**截断标记会冒泡到顶层**，避免静默少存）。
  拉取失败**不影响消息本身落库**，只丢弃展开结果、保留 `[合并转发]` 占位并记 `forwardFailed`。
  `forwardDepth=0` 可关闭展开。
- 采集不得因为单个会话失败而中断整轮。
- OneBot HTTP 只使用**只读**接口，不使用任何写消息接口。

## 6. `@qqarchive/server` 公共 API 与 HTTP 契约

```ts
createServer(opts: {config: AppConfig; db: Db; logger: ScopedLogger; collect?: CollectRunner;
                    repoRoot: string; version: string; startedAt: number}): {server: http.Server; close(): Promise<void>}
```

**统一响应**：成功 `200 {"data": ...}`；错误 `4xx/5xx {"error": "...", "code": "..."}`。
所有 `/api/*` 除 `/api/health`、`/api/auth/login` 外都要求认证。

| 方法 | 路径 | 说明 | 认证 |
| --- | --- | --- | --- |
| GET | `/api/health` | 健康检查（含 db/media/collector/disk） | 否 |
| POST | `/api/auth/login` | body `{token}` → `{accessToken, expiresAt}` | 否 |
| POST | `/api/auth/logout` | 注销当前会话 | 是 |
| GET | `/api/auth/session` | 当前会话信息 | 是 |
| GET | `/api/stats` | `ArchiveStats` | 是 |
| GET | `/api/sessions?chatType=&keyword=&page=&pageSize=&sort=` | `Page<SessionRecord>`（附每条 lastMessageText） | 是 |
| GET | `/api/sessions/:id` | `SessionRecord` | 是 |
| GET | `/api/sessions/:id/messages?before=&after=&limit=&keyword=&msgType=&direction=` | `{items: MessageRecord[]; hasMore}` | 是 |
| GET | `/api/messages/:id` | `MessageRecord`（含 reply 预览与媒体） | 是 |
| GET | `/api/search?q=&sessionId=&chatType=&msgType=&from=&to=&page=&pageSize=` | `Page<SearchHit>` | 是 |
| GET | `/api/media?kind=&status=&sessionId=&from=&to=&page=&pageSize=` | `Page<MediaListItem>` | 是 |
| GET | `/api/media/:id/raw` | 原始文件流（支持 Range；`Content-Disposition` 依 `allowDownload`） | 是 |
| GET | `/api/media/:id/thumb` | 缩略图（不存在则 404，前端回退原图） | 是 |
| POST | `/api/media/:id/verify` | 重新校验 sha256 | 是 |
| GET | `/api/jobs?kind=&status=&page=` | `Page<JobRecord>` | 是 |
| GET | `/api/jobs/:id` | `JobRecord` | 是 |
| POST | `/api/import` | body `{path, format?, accountUid?}` → 创建并异步执行导入任务 | 是 |
| GET | `/api/jobs/:id/events` | SSE 进度流（`text/event-stream`） | 是 |
| POST | `/api/collect/run` | 立即跑一轮采集 | 是 |
| GET | `/api/collect/health` | 采集健康状态 | 是 |
| POST | `/api/backup` | body `{verify?}` → 同步执行备份，返回备份记录 | 是 |
| GET | `/api/backups` | 备份列表 | 是 |
| POST | `/api/backups/restore` | body `{path, dryRun?}` → 恢复演练（默认 dryRun） | 是 |
| GET | `/api/logs?level=&scope=&page=` | `Page<LogRecord>` | 是 |
| GET | `/api/export/session/:id?format=json|jsonl|txt&from=&to=` | 导出归档数据（流式） | 是 |
| GET | `/api/napcat/status` | body `{}` → `{configured, webuiUrl, connected, baseUrl?, isLogin, uin, error?}`（**不含 token/凭据**） | 是 |
| POST | `/api/napcat/qrcode` | 取登录二维码 → `{isLogin, uin, png}`，`png` 是 `data:image/png;base64,...`，**二维码 URL 本身绝不出现在响应里** | 是 |
| GET | `/api/napcat/accounts` | 本机可快捷登录账号 `{accounts: NapCatQuickAccount[]}` | 是 |
| POST | `/api/napcat/quick-login` | body `{uin}` → `{ok, uin, message?, alreadyLoggedIn?}`；「该账号已登录」也是 200，由 `ok`/`alreadyLoggedIn` 表达 | 是 |

**NapCat 登录接口的额外约定**：二维码是登录凭据，因此**只以 PNG 下发**（`data:` URL），
不进 JSON 明文、不写日志、不走 `queryAuth`（浏览器无法给 `<img>` 加请求头，若把二维码放 URL 里会泄漏凭据）；
`/api/napcat/*` 未配置 `collector.napcat.token` 时返回 `503 NAPCAT_UNAVAILABLE` 并说明要改哪个配置项。

**认证语义**

- `POST /api/auth/login` 用配置里的 `server.token`（常量时间比较）换取一个 **随机 refresh token**；
  DB 只保存其 sha256（`settings` 表或内存会话表），浏览器拿 `accessToken`（短时 JWT 风格：`base64url(payload).sig`，
  用 `server.token` 派生的 HMAC 密钥签名）。
- 媒体与导出接口必须校验会话；未认证一律 401，**不泄露文件是否存在**。

**安全硬性要求**

- 默认只听 `127.0.0.1`；非本机监听时若 token 强度不足直接拒绝启动（`validateConfig`）。
- 媒体路径必须经过 `path.resolve` 前缀校验，禁止 `..` 穿越；只允许从 DB 取 `rel_path`，不接受用户传路径。
- 导入接口只接受**服务端可读的绝对路径**，且路径必须存在且是普通文件；不使用用户输入拼 shell。
- 响应头带 `X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`、CSP（前端同源）。

## 7. 前端契约（`web/`）

- 纯静态：`web/index.html`、`web/app.js`、`web/style.css`，由 server 从 `repoRoot/web` 托管。
- 所有数据来自上表 API，**不允许任何硬编码假数据**；未登录时显示登录页。
- 页面：登录 / 总览 / 聊天记录（会话列表 + 时间线 + 搜索）/ 媒体管理 / 归档管理 / 日志。
- 纯函数（时间格式化、类型标签、URL 构造）放在 `web/lib.js`，用 `node:test` 直接测。

## 8. 测试契约（`tests/`）

- 全部使用 `node:test`；`node --test --experimental-strip-types "tests/**/*.test.ts"`。
- 测试数据由 `tests/fixtures/generate.ts` 生成到临时目录，**不使用真实聊天记录**。
- 覆盖 `docs/acceptance.md` 里的 15 项；每项都要有可复现命令与断言。

## 9. `@qqarchive/stt` 公共 API（可选后处理：语音转文字）

独立的一层，**不参与归档正确性**：转写失败不影响消息与媒体已经安全落盘。默认关闭。

```ts
const WHISPER_ENGINE = 'whisper-cli';
const WHISPER_SAMPLE_RATE = 16_000;

interface SttLikeConfig {
  enabled?: boolean; engine?: string; binary?: string; ffmpeg?: string;
  model?: string; language?: string; vadModel?: string;
  threads?: number; timeoutMs?: number; maxDurationSec?: number;
}

class WhisperCliTranscriber {
  readonly engine: string;
  constructor(cfg: SttLikeConfig, deps?: {exec?: ExecFn; tmpDir?: string; fileExists?: (p: string) => boolean;
                                            readText?: (p: string) => string});
  /** 探活：二进制 / ffmpeg / 模型文件是否都在；结果缓存，force 可强制重探。 */
  probe(force?: boolean): Promise<SttAvailability>;
  /** 单条转写：ffmpeg 转 16k 单声道 wav → whisper-cli → normalizeTranscript。 */
  transcribe(req: {path: string; language?: string; signal?: AbortSignal}): Promise<TranscriptResult>;
}
transcriberFromConfig(cfg: AppConfig): WhisperCliTranscriber | null

normalizeTranscript(raw: string): {text: string; segments: number}   // 去时间戳、丢 [BLANK_AUDIO]/[ Silence ] 等占位
isEnglishOnlyModel(path: string): boolean                            // *.en.bin → 转中文几乎空输出，探测阶段就警告

const DEFAULT_TRANSCRIBE_LIMIT = 50;
const MAX_TRANSCRIBE_LIMIT = 1000;
async function transcribePending(transcriber, db: TranscriptSink, opts: TranscribeBatchOptions): Promise<TranscribeBatchStats>
// TranscribeBatchStats = {candidates; transcribed; empty; failed; skipped; elapsedMs; errors: Array<{mediaId; relPath; error}>}
```

**硬性约束**

- 引擎只有 whisper.cpp 官方 CLI（`whisper-cli`），**不引入任何 npm 依赖**，不自己实现推理。
- 转中文**必须用多语言模型**（`ggml-large-v3-turbo.bin` 等）。`*.en.bin` 是英文专用模型，
  用它转中文会得到近乎空的输出 —— `probe()` 会给出警告，但不阻止（用户可能就是要转英文）。
- 只能读 `mediaDir` 内的文件：`relPath` 经 `path.resolve` 前缀校验，`..` 穿越一律跳过并告警，
  绝不把任意路径送进 `ffmpeg`/`whisper-cli`。
- 静音/纯噪声转出空文本**也要落一行** `media_transcripts`，否则每轮重跑都会重新烧一遍 GPU。
- 一条失败不中断整批（`continueOnError`，默认 true），失败条目留在待办队列等下次重试。
- 语音文件不离开本机：全部是本地进程调用，不调用任何在线 API。

**真实边界（必须如实告知）**

- 转写质量取决于模型与音质；本项目的真机验证只覆盖 3 个真实 `.amr`（见最终报告），
  没有做 CER/WER 基准，也没有覆盖方言、强噪声、多人重叠说话。
- `media_transcripts.text` 是**机器转写**，可能有错字，不能当作原始消息内容的权威副本；
  原始语音文件本身始终保留（内容寻址，不会被转写替换或删除）。
