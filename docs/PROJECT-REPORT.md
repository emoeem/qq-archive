# QQ 聊天记录防丢失与自动归档系统 — 项目报告

> 📌 **修订说明**：初稿写于独立复核之前（当时 263 个用例）。复核又抓出 6 个真缺陷并修复
> （引用内容端到端显示、备份对账与保留策略、数据目录搬迁、日志落库与保留、媒体重复下载、
> 3 处前后端字段不一致），用例由 263 增至 **347**。**§0 速览、§7 测试表格与全文用例数均已按
> 当前实测刷新为 347 / 0 失败**，复核过程见 [INDEPENDENT-VERIFICATION.md](INDEPENDENT-VERIFICATION.md)。
> 本文的架构、实现细节与边界分析仍然有效。

> 位置：`/home/emo/code/QQ`
> 报告日期：2026-10-13
> 口径说明：本文所有数字都是**本机实测**，不是文档抄写。与 README 中过时的计数冲突时，以本文为准；
> 与更细的验收条目冲突时，以 [acceptance.md](acceptance.md) 为准。

---

## 0. 一页速览

| 项 | 值 |
| --- | --- |
| 一句话 | 独立于 QQ 客户端的**个人聊天记录归档系统**：把已有导出文件导进来，把在线消息持续采下来，把图片/语音/视频/文件**内容寻址**落盘，用中文网页检索浏览，可备份可恢复可部署。 |
| 运行时 | Node.js ≥ 22.5（实测 24.x），直接用类型剥离跑 TS，**无构建步骤** |
| 生产依赖 | **0 个**（只用 `node:sqlite` / `node:http` / `node:crypto` 等内置模块）；唯一外部程序依赖是**可选**的 `ffmpeg` |
| 代码规模 | 47 个源文件（`.ts`，不含测试），16391 行 |
| 结构 | 7 个包 `core/db/import/collect/stt/qr/server` + 1 个 CLI + 1 个无构建前端 `web/` |
| 数据库 | SQLite（`node:sqlite`），15 张表，5 个迁移版本 |
| 测试门禁 | `npm test` → **347 tests / 347 pass / 0 fail / 0 skipped**（26 个测试文件，实测约 66 s）<br>`npm run typecheck` → **0 错误** |
| 真机数据 | 13 会话 / **282 消息** / **25 个媒体**（全部 `present`）/ 28 条消息↔媒体关联 / 51 联系人 / 2 份备份 |
| 真机采集 | 最新轮次 `sessions=13 fetched=27 duplicate=27 failed=0 mediaSaved=2 ok=true` |
| 对接方式 | OneBot v11 **只读** HTTP（不注入、不 hook、不改客户端） |

---

## 1. 目标与真实边界

### 1.1 它解决什么

QQ 记录的"丢失"有好几个不同来源，混在一起谈会得出错误方案。本系统对每个来源的立场：

| 丢失来源 | 能否解决 | 怎么解决 |
| --- | --- | --- |
| 换机 / 重装 / 清缓存导致本地记录消失 | **能** | 提前把已获取的记录导入归档，独立于 QQ 的存储目录 |
| 群消息超过约 5000 条被 NapCat LRU 清理 | **能** | 长期挂采集端 + 断点续传；进了库的永久保留 |
| 已撤回的消息 | **能（前提：撤回前已采到）** | 采集时落 `recalled` 标记与原文；撤回后无法再取回 |
| 媒体（图片/视频/语音/文件）链接失效 | **能** | 内容寻址落盘 + SHA-256 校验，不依赖 QQ 的缓存路径 |
| 腾讯服务端删除云端记录 | **不能** | 超出任何第三方工具能力 |
| 手机端有、但从未同步到采集端的消息 | **不能** | 没有任何 API；需设备端解密导出（root/Frida），本项目**有意不提供** |
| 已解散 / 已退出的群 | **不能** | OneBot 接口明确不支持 |

### 1.2 为什么这些边界是真的（不是"懒得做"）

- NapCat 维护者在 [Issue #1838](https://github.com/NapNeko/NapCatQQ/issues/1838) 明确回复：机器人离线期间的消息**不会补齐**，且这是**设计行为**。
- NapCat 没有历史数据库，消息走 LRU 缓存。
- 私聊历史走"漫游"接口，QCE 官方文档标注 `serverCompletenessProven: false`，并写明任何响应都不能证明服务端记录完整性。
- 因此本系统的正确用法是：**采集端长期挂着**（systemd 自动重启 + 开机自启），把离线窗口压到最短。
  系统保证的是「**进了库的消息，永久保留**」，而不是「阻止 QQ 删消息」。

---

## 2. 总体架构

### 2.1 分层

```
                    ┌──────────────────────────────────────────┐
   数据来源 ────────►│  packages/import   （5 种格式，流式解析） │
   (导出文件)        └───────────────────┬──────────────────────┘
                                        │
                    ┌───────────────────▼──────────────────────┐
   QQ 客户端 ──► NapCat ──► OneBot v11 HTTP（只读）
                    │  packages/collect （发现会话 / 拉增量 /    │
                    │                    断点续传 / 转发展开 /   │
                    │                    媒体归档 / 重试告警）    │
                    └───────────────────┬──────────────────────┘
                                        │  NormalizedMessage
                    ┌───────────────────▼──────────────────────┐
                    │  packages/db  SQLite：迁移 / 仓储 /      │
                    │               FTS5 / 统计 / 日志 / 备份记录│
                    └───────────────────┬──────────────────────┘
            ┌───────────────────────────┼───────────────────────────┐
            │                           │                           │
   ┌────────▼────────┐        ┌─────────▼─────────┐       ┌─────────▼────────┐
   │ packages/server │        │  packages/stt     │       │  packages/qr     │
   │ HTTP API+认证+   │        │  whisper.cpp 适配 │       │  零依赖 QR 编码器 │
   │ 媒体服务+SSE     │        │  （可选后处理）    │       │  → PNG/SVG/终端   │
   └────────┬────────┘        └───────────────────┘       └─────────┬────────┘
            │                                                       │
   ┌────────▼────────┐                                    扫码登录（NapCat WebUI）
   │  web/ 中文界面   │
   │  原生 ES 模块    │
   └─────────────────┘
```

### 2.2 模块职责

| 包 | 职责 | 关键文件 |
| --- | --- | --- |
| `packages/core` | 领域类型、配置加载与校验、结构化日志（含脱敏与文件轮转）、稳定键生成（`msg_key`/`session_key`）、CJK 二元切分、错误类型 | `config.ts` `logger.ts` `ids.ts` `types.ts` `errors.ts` |
| `packages/db` | SQLite 存储层：schema/迁移、仓储方法、FTS 检索、统计、采集游标、日志、备份记录；**预编译语句 LRU 缓存** | `schema.sql` `migrations.ts` `index.ts` |
| `packages/import` | 5 个导入器 + 格式自动识别 + 流式 JSON 解析 + **媒体归档器**（内容寻址、Range 续传、缩略图） | `importers/*` `detect.ts` `media.ts` `run.ts` |
| `packages/collect` | OneBot v11 客户端、采集调度（`CollectRunner`）、合并转发展开、告警、NapCat WebUI 客户端（扫码登录） | `onebot.ts` `runner.ts` `forward.ts` `napcat-webui.ts` `cq.ts` |
| `packages/stt` | 可选语音转文字：探测 `whisper-cli`/`ffmpeg`/模型 → ffmpeg 转码 → whisper 转写 → 落库（幂等） | `whisper.ts` `pipeline.ts` |
| `packages/qr` | 从零实现的 QR 编码器（ISO/IEC 18004 byte 模式：RS 纠错、掩码、格式信息）+ PNG/SVG/终端渲染 | `encode.ts` `render.ts` |
| `packages/server` | `node:http` 手写路由；认证（HMAC access token）；媒体服务（raw/thumb）；导出；备份/恢复；SSE 事件流；静态托管 | `index.ts` `auth.ts` `router.ts` `backup.ts` `media.ts` `export.ts` `static.ts` |
| `apps/cli` | 12 个命令：`serve import collect transcribe login backup restore verify doctor stats logs token` | `main.ts`（965 行） |
| `web/` | 中文管理界面，原生 ES 模块 + 手写 CSS，无构建、无 CDN | `index.html` `app.js` `lib.js` `style.css` |

关键接口（模块间全部签名与 HTTP 端点）冻结在 [ARCHITECTURE.md](ARCHITECTURE.md)。

### 2.3 一次采集轮次的数据流（`CollectRunner.runRound`）

`packages/collect/src/runner.ts:481-653`：

1. 建 `import_jobs` 行（`kind='collect'`），失败只告警不中断采集。
2. `discoverSessions()` 拿会话列表（可配置为固定清单或自动发现）。
3. **逐会话**（一个会话失败不影响其他会话）：
   - 读 `collect_state` 游标 → `sinceTs = max(cursorTs - lookbackSec, now - initialBackfillDays)`；
   - `fetchWithRetry()` 拉增量消息（带退避重试）；
   - `expandForwards()` **先展开合并转发**再入库：子消息正文落 `messages.extra.forward`，子消息媒体平铺进父消息 `resources`，与普通媒体走同一条归档通路（`runner.ts:420-467`）；
   - `ensureSession()`；
   - 按 `pageSize` 分块 `insertMessages()`，**每块成功立刻持久化游标**（崩溃后不重复拉取）；
   - `handleMedia()` 串行下载媒体：`MediaArchiver.archive()` 落盘 → `persistMedia()` 写 `media` / `message_media`；
   - 失败则写 `lastError` + `consecutiveFailures`。
4. 轮次结束：整轮失败（fatal 或**全部**会话失败）才累加连续失败；达到 `alert.collectFailureThreshold` 时写日志 + POST webhook。判定为成功的轮次会清零连续失败计数。
5. 写结构化日志 `采集轮次结束 {sessions, fetched, inserted, duplicate, failed, mediaSaved, mediaMissing, forwardMessages, forwardFailed, ok}`。

---

## 3. 技术选型与理由

| 关注点 | 选择 | 为什么不是别的 |
| --- | --- | --- |
| 运行时 | Node ≥ 22.5 | 原生 `node:sqlite`（免 better-sqlite3 原生编译）+ 原生 TS 类型剥离（免 tsc/tsx/esbuild） |
| 数据库 | SQLite | 单文件、`VACUUM INTO` 原子快照、FTS5；实测 3.53.4 支持 FTS5 + JSON1 + WAL |
| 中文检索 | FTS5 `unicode61` + **应用层 CJK 二元切分** | 老版本 SQLite 无 `trigram` 分词器；二元切分不依赖版本且能同时命中「演唱会」与「看了演」 |
| HTTP | `node:http` 手写路由 | 0 依赖 = 可审计、无供应链风险、无升级破坏 |
| 前端 | 原生 ES 模块 + 手写 CSS | 无构建，改完刷新即生效；纯函数可被 `node:test` 直接测 |
| 采集来源 | OneBot v11 HTTP（只读） | 不注入、不 hook、不改客户端；接口稳定且被多个实现支持 |
| 测试 | `node:test` + `node:assert/strict` | 内置，零依赖 |

---

## 4. 数据模型

完整 DDL：`packages/db/src/schema.sql`；迁移：`packages/db/src/migrations.ts`（当前 5 个版本）。

| 表 | 作用 |
| --- | --- |
| `accounts` | 归档的账号（多账号隔离的顶层键） |
| `sessions` | 会话（`private`/`group`/`temp`/`other`），含消息数、首末时间 |
| `contacts` | 联系人/群成员昵称、备注 |
| `messages` | 消息主表 |
| `media` | 媒体内容对象 |
| `message_media` | 消息↔媒体多对多（序号、原文件名、声明大小） |
| `import_jobs` | 导入/采集/备份任务与进度、计数、错误 |
| `collect_state` | **每会话采集游标**（断点续传核心） |
| `logs` | 结构化日志（供网页查看 — 见 §9 缺陷 G1） |
| `backups` | 备份记录与校验结果 |
| `messages_fts` / `messages_fts_bigram` | 全文索引（原文分词 / CJK 二元） |
| `settings` | 运行期设置（含 refresh token 的 sha256） |
| `media_transcripts` | 语音转写结果（`media_id` 主键 ⇒ 天然幂等） |
| `schema_migrations` | 迁移版本台账 |

四个关键设计：

1. **`msg_key` 是幂等的核心**。源数据有真实消息 ID 时用 `id:<msgId>`；没有时用 `sha256(ts|sender|text|seq|资源指纹)` 内容哈希。同一文件重复导入新增 0 条，不同时间导出的重叠部分自动归并（唯一约束 `UNIQUE(account_uid, session_key, msg_key)`，`schema.sql:90`）。
2. **重复导入不覆盖已有行**。导出文件可能是较早的快照，覆盖会丢数据。
3. **媒体内容寻址**。`media.sha256` 唯一（`schema.sql:102`）；路径由 sha256 决定 ⇒ 同内容只存一份，不同内容天然不覆盖。
4. **迁移只做向后兼容新增**（加表/加索引/加可空列），每版本在事务内执行；删列/改语义必须新开版本并写数据迁移（`migrations.ts:7`）。

---

## 5. 各子系统的实现

### 5.1 导入（5 种格式，流式）

| 格式 | 识别方式 | 来源 |
| --- | --- | --- |
| `qce-json` | 顶层有 `chatInfo` + `messages` | qq-chat-exporter 单文件 JSON |
| `qce-jsonl` | `manifest.json` + `chunks/*.jsonl` | 同一工具的分块导出（大文件推荐） |
| `qce-txt` | 文本行模式 | 同一工具的 TXT 导出（尽力解析） |
| `generic-jsonl` | 每行一个对象 | 自带规范，供其他工具接入 |
| `html` | DOM 结构保守探测 | QCE viewer / QCE DOM / 通用聊天页 |

- 流式解析（`json-stream.ts`）→ GB 级文件不占内存。
- **不静默丢字段**：无法识别的字段整条存进 `messages.raw`；无法解析的行计入 `import_jobs.stats.errors` 并在网页日志可见。
- 格式探测是**保守**的：不像聊天页必须判 `unknown`，绝不硬猜（`tests/html-import.test.ts` 有专门护栏）。
- 字段映射细则：[format-mapping.md](format-mapping.md)。

### 5.2 采集（OneBot v11 只读）

**只读白名单**（`packages/collect/src/onebot.ts:25-38` 的 `READ_ONLY_ACTIONS`）：`get_login_info` / `get_status` / `get_version_info` /
`get_group_list` / `get_friend_list` / `get_group_msg_history` / `get_friend_msg_history` / `get_forward_msg` /
`get_image` / `get_record` / `get_file`。**不使用任何写消息接口、不注入客户端。**

- **增量**：`sinceTs` 由 `collect_state.cursorTs` 减去 `lookbackSec` 回看窗口决定；首次回填由 `initialBackfillDays` 控制。
- **断点续传**：每插入一块就落游标；`cursor_ts` + `cursor_seq` 双游标，位点持久化早于轮次结束。
- **退避重试**：`fetchWithRetry` 按尝试次数退避；单个会话异常被捕获，不影响其他会话。
- **零历史会话不误判**：NapCat 对"会话无消息"和"游标到历史尽头"都返回 `{"status":"failed","retcode":200,"message":"消息<N>不存在"}`，旧代码把它当会话失败（真机上产生 7 条假告警）。现在这被识别为"没有更多历史"。
- **合并转发展开**（`forward.ts`）：真实调 `get_forward_msg`，递归展开嵌套转发（默认 3 层 / 200 节点），子消息正文入 `extra.forward`，子消息附件平铺入父消息 `resources` 一并归档；去重与预算触顶会置 `truncated` 标记，**不静默少存**。单条转发拉取失败只记 `forwardFailed`，不影响该会话其余消息。
- **媒体回落重取**（`runner.ts` → `retryViaOneBot`）：媒体直链带 rkey 且有 TTL，过期后直链必失败。归档结论为 `missing`/`corrupt` 时**回落一次** OneBot 取字节接口（`get_image`/`get_record`/`get_file`），拿到字节交给 `ArchiveMediaBytesFn`（`types.ts:125`）走同一条内容寻址通路；没有字节入口就不发无谓请求，异常不冒泡。
- **告警**：连续失败达阈值 → 写日志 + POST `alert.webhookUrl`（`runner.ts:390-408`），webhook 失败不影响采集。

### 5.3 媒体归档

目录布局（`packages/import/src/media.ts:6-9`）：

```
<root>/<kind>/<yyyy>/<mm>/<sha256前2位>/<sha256>.<ext>   正式内容（内容寻址）
<root>/.incoming/<sha256(url+目标身份)>.part              下载/拷贝中转
<root>/.incoming/<file>.part.meta.json                     断点续传状态 sidecar
<root>/thumbs/<kind>/<sha2>/<sha256>.jpg                   缩略图
```

- **原子落地**：先写 `.part` 再 `rename`（同目录同文件系统，rename 原子），杜绝半截文件被当成正常内容。
- **SHA-256 强校验**：签名覆盖**完整重组后**的文件（`media.ts:196`），不是只覆盖续传那一段。
- **HTTP Range 断点续传**（`media.ts:454-539`，默认开启）：`.part` 路径按 (url, 目标身份) 确定性生成 ⇒ 同一候选重试能找到同一残片；续传起点以 `.part` 的**实际磁盘大小**为准；用 `Range` + `If-Range`（ETag）请求；`206` 追加、`200` 表示服务端不支持续传则截断重下、`416`/不可信 `Content-Range` 则丢弃残片重头下载；最多两轮。超 `maxMediaBytes`（默认 512 MB）清掉残片并显式失败。
- **状态显式标记**：`present`/`missing`/`corrupt`/`pending`，**绝不伪造文件**（缺 ffmpeg 时视频缩略图降级为占位图，不影响归档与播放）。
- **关联**：归档字节 → 写 `media`（按 sha256 去重）→ 写 `message_media`（`runner.ts` 的 `persistMedia`）。

### 5.4 中文全文检索

难点：`unicode61` 按空格/标点切词，而中文没有空格 ——「今天去看了演唱会」会被当成**一个 token**，搜「演唱会」永远 0 命中。

做法（`packages/core/src/ids.ts` 的 `buildSearchText`，`ids.ts:113`）：

1. 入库时把中文连续段切成**二元组**：`今天去看了演唱会` → `今天 天去 去看 看了 了演 演唱 唱会`；
2. 英文/数字/空格保持原样（整词）；
3. 查询侧做同样切分，用 `AND` 连接各 token（`escapeFtsQuery`，`ids.ts:190`）；
4. **单个汉字**（如「唱」）没有对应二元组，自动退化为字面 `LIKE` 匹配（`hasSingleCjkRun`，`ids.ts:169`）。

结果：`演唱会` 命中、`看了演` 命中、`唱` 命中（走 LIKE）、`hello` 整词命中而 `ell` 不命中。
命中位置由服务端生成 `<mark>` 片段，前端**先转义再插入标记**，不会 XSS（`web/` 有 XSS 回归护栏测试）。

### 5.5 扫码登录 QQ

- 走 **NapCat WebUI HTTP 接口**（与采集用的 OneBot 是两套接口、两个 token）：`sha256(token + ".napcat")` 作 `password_hash` 换 `Credential`，之后每请求带 `Authorization: Bearer <Credential>`；端口自增探测 6099..6120。
- **二维码由本仓库自研编码器生成**（`packages/qr`，零依赖、ISO/IEC 18004 byte 模式），终端可渲染，网页下发 PNG。
- **扫码是两段式**：扫到 ≠ 登录。状态会停在 `qrcode_scanned` + `isLogin:false`，必须在手机上点「确认登录」。
- **凭据只在本机内存中流转**；`Credential` 失效会自动重认证（`tests/napcat.test.ts` / `napcat-login-e2e.test.ts` 覆盖"恰好一次"）。

### 5.6 Web 管理界面

原生 ES 模块 + 手写 CSS，无构建、无 CDN，全部连接**真实 API 与数据库**（`tests/web.test.ts` 断言 API 调用全部走真实 `/api/*` 路径、`index.html` 自包含）。

页面覆盖：登录认证、会话列表、消息时间线（关键词高亮）、媒体预览/播放/下载、转写结果、归档统计、任务进度、日志、备份管理、QQ 登录。多账号隔离由 `account_uid` 顶层键保证。

服务端 REST 面覆盖：认证（login/refresh/session/logout）、统计、会话、会话消息、单条消息、搜索、媒体（列表/raw/thumb/verify/transcript/transcribe）、STT（transcribe/probe/status）、任务、导入、采集（run/health）、NapCat（status/qrcode/accounts/quick-login）、备份（创建/列表/恢复）、日志、会话导出、SSE 事件流。

### 5.7 认证与安全

`packages/server/src/auth.ts`：

- **常量时间比较**校验 `server.token`：先各自 sha256 再 `timingSafeEqual`，长度不同也不抛异常（`auth.ts:26`）。
- `accessToken = base64url(payload) + "." + base64url(hmac-sha256(payload))`，签名密钥由 `server.token` 派生（`auth.ts:33-34`）；**直接把 `server.token` 当 Bearer 打接口会 401**（认证是两段式）。
- refreshToken 随机生成，**DB 只保存其 sha256**（`auth.ts:116`），支持撤销（jti 黑名单）。
- **登录限流**（`LoginThrottle`）。
- **日志脱敏**（`packages/core/src/logger.ts:36` 的 `redact`、`:44` 的 `redactValue`）：正则替换 `sk-…`、`Bearer xxx`、`token|password|…` 的值、`data:image/*;base64,` 长串；`redactValue()` 递归处理对象且对命中 key 名直接 `<redacted>`。
- 默认**只监听 `127.0.0.1`**；`server.allowDownload`、`exportMaxMessages`、`trustProxy` 可控。
- Token 首次运行**自动生成并写回 config.json**（权限建议 `chmod 600`）。

### 5.8 备份 / 恢复 / 校验

`packages/server/src/backup.ts`：

- `VACUUM INTO` 生成**一致性快照**（先 WAL checkpoint，失败则继续用 VACUUM INTO）；参数化失败回退字面量 SQL（含转义）。
- 快照写 **manifest**（含计数、sha256）+ 媒体清单 + 恢复说明。
- `verifySnapshot()` 校验 sha256 并比对计数。
- **自动备份**：`packages/server/src/index.ts:1380-1407` 起真定时器，读 `backup.intervalHours`（默认 24，0 关闭），
  与 API 路由共用唯一入口 `runBackupJob()`（`server/index.ts:1198`，快照与入库收敛在一处），跑完后按 `backup.keep`（默认 7）裁剪。
- `pruneBackups()`（`backup.ts:353+`）额外清理**孤儿快照**：快照由 `VACUUM INTO` 生成，而登记行是**在快照之后**写进当前库的，所以崩溃会留下表里没有的快照文件，只按表裁剪会让它们无限堆积。
- `qq-archive backup` CLI 会写 `backups` 表（否则 `/api/stats` 的 `lastBackupAt` 恒为 null）。
- 恢复**演练可执行**（`restore` + dry-run）。

### 5.9 语音转文字（可选）

`packages/stt`：不绑定任何 npm 依赖，直接调 `whisper.cpp` 官方 CLI。

流程：`probe()` 探测 `whisper-cli` / `ffmpeg` / ggml 模型是否真存在 → ffmpeg 把任意可解音频（QQ 语音是 `amr`，部分版本 `silk`）转 16 kHz wav → `whisper-cli` 拿纯文本 → 落 `media_transcripts`。

- **默认关闭**（`stt.enabled=false`），没装 whisper 的用户不付任何代价。
- **幂等**：`media_transcripts` 用 `media_id` 作主键；**空白转写（静音）也落一行**，避免每次重跑。
- 中文实测可用（`tests/stt.test.ts` 25 例，含英文模型识别、探测缓存、命令组装、批量流水线与级联删除）。

### 5.10 部署

| 形态 | 适用 | 组成 |
| --- | --- | --- |
| A. 单机全量 | 个人电脑 / 已登录 QQ 的机器 | 一个进程：归档 + 采集 |
| B. 服务器 + 采集端分离 | 有 Linux 服务器 | 服务器只存归档跑网页；采集端在个人电脑，定期把备份推到服务器 |
| C. 纯离线导入 | 不装采集端 | 只用 `import` 导入导出文件，网页查看 |

- Linux：`deploy/qq-archive.service`（归档服务）+ `deploy/qq-archive-collect.service`（独立采集端）；`StartLimitIntervalSec`/`StartLimitBurst` 正确位于 `[Unit]` 段（`deploy/*.service:8-9`）。
- Windows：`deploy/windows/` 提供计划任务安装/卸载/状态脚本，**不需要管理员、不依赖 NSSM**。
- ⚠️ 服务器与采集端之间**只能单向同步**：SQLite 不能双向同步或多写。
- 细节见 [DEPLOYMENT.md](DEPLOYMENT.md)。

### 5.11 CLI

12 个命令：`serve`（HTTP 服务）、`import`（导入）、`collect`（`--once` 或常驻）、`transcribe`、`login`（终端二维码/快捷登录）、`backup`、`restore`、`verify`、`doctor`（环境自检）、`stats`、`logs`、`token`。
包装脚本 `bin/qq-archive.mjs` 自带运行 flag，可 `npm link` 成全局命令。

### 5.12 存储层性能：预编译语句缓存

`packages/db/src/index.ts` 有 `stmtCache` + `stmt()`，但**热路径曾绕过它直接 `raw.prepare()`** —— 每插一条消息重新 prepare 5 条语句。

现在 6 处静态 SQL 已收敛到 `stmt()`，并加**有界 LRU**（`Db.STATEMENT_CACHE_MAX = 256`，`packages/db/src/index.ts:288`，淘汰在 `:314`）防止动态 `IN(...)` 撑爆缓存。实测（`tests/db-prepare-cache.test.ts` 计数 `prepare` 调用）：

| 批量插入 | 修复前 prepare 次数 | 修复后 |
| --- | ---: | ---: |
| n = 10 | 32 | **5** |
| n = 50 | **152** | **5** |

保留 `raw.prepare` 的 4 处是**应该保留**的：`stmt()` 自身、`health()` 的 `SELECT 1` 冷路径探针、以及两处运行时拼 `WHERE` 的动态 SQL。

---

## 6. 真机端到端验证

环境：NapCat 跑在 podman 容器，真实 QQ 号已登录，配置 `config.json` 指向本机 OneBot HTTP 通道。

### 6.1 采集链路

最新轮次日志（`data/logs/archive.log`）：

```
2026-10-13T05:28:23.853Z  sessions=13 fetched=27 inserted=0 duplicate=27 failed=0 mediaSaved=2 mediaMissing=0 ok=true
2026-10-13T05:29:36.727Z  sessions=13 fetched=27 inserted=0 duplicate=27 failed=0 mediaSaved=2 mediaMissing=0 ok=true
```

`duplicate=27` 表示幂等生效（同一批消息重复拉取 0 新增）；`failed=0` 表示"零历史会话误判"已修复。

### 6.2 归档库实测内容

直接查 SQLite（只读）：

```
counts: sessions=13 messages=282 media=25 message_media=28 contacts=51 backups=2

messages by session: 会话A(私聊)=83  会话B(群)=51  会话C(群)=50  会话D(私聊)=37  会话E(群)=31  会话F(群)=30
media by kind:       image=19 (5.65 MB)  video=2 (19.08 MB)  file=1 (30.25 MB)  audio=3 (31 KB)
media by status:     present=25            ← 无 missing / corrupt
migrations:          1..5 全部已应用
```

磁盘：`archive.db` 1.1 MB、`data/media` 53 MB、`data/backups` 1.9 MB。

### 6.3 备份 / 恢复 / 导出 / 检索

- 备份：0.76 MB 一致性快照 + manifest，dry-run 恢复通过。
- 导出：`json` / `txt` 正常。
- 检索：FTS 中文检索正常（含单汉字 LIKE 退化路径）。
- 扫码登录：自研编码器渲染的二维码与 NapCat 下发的 `qrcodeurl` 用 `zbarimg` 反解后**逐字节一致**。

### 6.4 运行现状（含一次真实故障）

采集容器曾被主机 podman 用户服务重启（`podman.service` 于 13:26:24 CST 重启）带崩：容器被 SIGKILL、无 stop 事件，导致采集停摆。重启容器后：

- 登录态**存活**（`get_login_info` → 真实账号仍在线），无需重新扫码；
- 采集轮次**自动恢复**，13:28 起恢复 `ok=true`、`failed=0`。

这验证了采集端的容错设计（单轮失败不清游标、容器恢复后接着跑），但也说明一个运维事实：**NapCat 容器被强杀有丢登录态的风险**，改动 OneBot 配置应优先写盘 + 由用户自行重启，避免 restart 已登录的容器。

---

## 7. 测试与门禁

```bash
npm run typecheck   # tsc -p tsconfig.json --noEmit
npm test            # node --test --experimental-strip-types "tests/**/*.test.ts"
```

**实测结果：347 tests / 347 pass / 0 fail / 0 skipped / 0 todo，duration ≈ 66 s；typecheck 0 错误。**

| 测试文件 | 用例 | 覆盖 |
| --- | ---: | --- |
| `tests/acceptance.test.ts` | 15 | 任务书第六阶段的 15 项验收 |
| `tests/backup-media.test.ts` | 6 | **带媒体备份往返**：`backup --with-media` 真带媒体、删媒体后 `restore --restore-media` 逐个 sha256 还原；请求恢复却无媒体可恢复时**必须告警**而非静默通过 |
| `tests/backup-reconcile.test.ts` | 8 | **备份对账**：快照丢了登记行也能按 manifest 找回（幂等、可被裁剪、数据目录搬迁不重复登记）；manifest 损坏时按文件名 + mtime 兜底——"宁可信息少，不可漏账" |
| `tests/cli.test.ts` | 22 | 参数解析 + **真实子进程端到端**（`--config`/导入/备份/恢复/令牌写回/网页托管/`--version`/`transcribe`/包装脚本） |
| `tests/collector.test.ts` | 11 | `collector` 子命令：命令注册/帮助/参数校验；**从 NapCat 挂载目录读两个 token**（OneBot 取自 `onebot11_<QQ号>.json` 的 `httpServers`，WebUI 取自 `webui.json`）；全新容器读不到也不报错 |
| `tests/collect.test.ts` | 23 | OneBot 协议、只读白名单、退避重试、断点续传、**媒体入库护栏**、**零历史会话不当失败**（回归） |
| `tests/config-jsonc.test.ts` | 14 | **JSONC 容错**：去注释/去尾逗号各司其职，字符串里的 `//` 绝不动；真坏的 JSON 仍报错且带文件路径；写令牌时注释不被抹掉 |
| `tests/db-prepare-cache.test.ts` | 3 | **预编译语句缓存**：prepare 次数不随批量线性增长 |
| `tests/db.test.ts` | 7 | 迁移、FTS 中文检索、游标 |
| `tests/filter.test.ts` | 16 | **消息过滤**：关键词/发送者/类型三条规则；命中照样入库只打 `filtered` 标记；默认隐藏、`includeFiltered=1` 可全取；不启用时与加功能前行为完全一致（老配置升级回归）；`refilter` 真实子进程重算且**绝不删消息** |
| `tests/forward.test.ts` | 15 | **合并转发展开**：纯函数（嵌套/去重/截断冒泡/预算）、`get_forward_msg` 协议（含**真机 `node.sender` 嵌套形状回归**）、`CollectRunner` 真库端到端 |
| `tests/hardening.test.ts` | 2 | 快速开始自检回归：systemd `StartLimit*` 必须在 `[Unit]`、`generate.ts --help` 不得创建 `--help/` 目录 |
| `tests/html-import.test.ts` | 9 | **HTML 导入**：三种 fixture + 保守探测 + 换行/方向/媒体/时间解析 |
| `tests/import.test.ts` | 14 | **5 种格式**导入、格式自动识别、错误分类、导入器注册数 |
| `tests/integration.test.ts` | 5 | **不注入任何桩**的真实联调 |
| `tests/log-sink.test.ts` | 6 | **日志落库**：error 级真进 `logs` 表（修复前恒为 0 行）、info 不落库以免淹没；启动时按 `dbKeepDays` 裁剪、`0` 表示不裁剪、环境变量可覆盖保留天数 |
| `tests/media.test.ts` | 23 | 内容寻址、SHA-256、缩略图（含**归档时必产出 `thumbPath`** 回归）、缺失/损坏标记、**Range 续传 9 例**（206 追加后 sha256 一致、200 截断重下、`If-Range`、416、超限清残片） |
| `tests/napcat.test.ts` | 18 | NapCat WebUI 客户端：密码哈希、端口探测、认证、凭据失效重认证、快捷登录错误语义 |
| `tests/napcat-login-e2e.test.ts` | 7 | **真子进程 CLI + 真 HTTP + 假 NapCat WebUI**：退出码、终端二维码逐模块等于编码器输出、重认证恰好一次 |
| `tests/napcat-routes.test.ts` | 9 | `/api/napcat/*` 四条路由的 HTTP 契约：401/503/400 语义、**二维码只下发 PNG、响应体不含 URL 明文**（逐像素解开 PNG 与编码器矩阵比对） |
| `tests/purge.test.ts` | 8 | **删除与撤回语义**：默认只演练、`--yes` 才真删、删会话要连 FTS 虚拟表一起清（它不会级联）；`--media` 只删不再被引用的文件；`--all` 不动备份 |
| `tests/qr.test.ts` | 13 | QR 编码器：容量表、RS 数学、格式信息、几何、放置不变式、PNG 结构、**与 `qrencode` 逐模块黄金对比**、`zbarimg` 解码回环 |
| `tests/reply-preview.test.ts` | 15 | **引用解析**：`getReplyPreviews` 支持 `reply_to_id`（OneBot 真实形态）与 `reply_to_msg_key` 两种引用、按会话隔离不跨会话误配、目标不在库内返回空不抛错、已撤回目标仍可解析；时间线与详情两条路由都返回 `replyPreview`/`replyToMessageId`（含"详情原实现恒为 null"的回归）；前端只认本库 id 而非 QQ 原始 id |
| `tests/server.test.ts` | 24 | 路由、认证、导出、备份、SSE、**定时自动备份写 `backups` 表**（回归）、`/api/stt/*` 与 `/api/media/:id/transcript` |
| `tests/stt.test.ts` | 25 | **语音转文字**：文本归一化、英文模型识别、探测缓存、ffmpeg+whisper 命令组装、批量流水线、DB 契约与级联删除 |
| `tests/web.test.ts` | 29 | 纯函数、**XSS 护栏**（无字符串拼接 `innerHTML`）、API 路径契约、无 CDN 自包含、路由表/侧边栏/视图注册三张表一致、自动刷新控制器 |

> 逐文件用例数由 `node --test` 单独运行每个文件汇总而来，**合计 347**，与整仓一次跑批的 347 完全一致。

**测试数据全部由 `tests/fixtures/generate.ts` 合成生成**（确定性 PRNG + 手写字节生成的合法 PNG/GIF/MP4），不含任何真实聊天记录。

### 已修复的历史缺陷（都有回归护栏）

| ID | 缺陷 | 修复位置 |
| --- | --- | --- |
| BUG#1 | `handleMedia()` 只把字节落盘，**从不写 `media`/`message_media` 表** → 真机 media 表 0 行、网页媒体页空白、`/api/media/:id/raw` 404、备份清单媒体数 0。测试之所以没抓到，是因为 `tests/acceptance.test.ts` 自己注入回调把活干了 | `packages/collect/src/runner.ts` `persistMedia()`（:327） |
| BUG#2 | 把 NapCat 的"消息`undefined`不存在"当会话失败 → 真机 7 条假告警 | `packages/collect/src/onebot.ts` 历史分页判定 |
| D1 | systemd `StartLimitIntervalSec`/`StartLimitBurst` 放在 `[Service]` 段（无效） | `deploy/qq-archive.service:8-9`、`deploy/qq-archive-collect.service:8-9` |
| D2 | `ensureThumb` 定义了但归档时不调用 → 缩略图缺失 | `packages/import/src/media.ts:743`（定义在 `:841`） |
| D3 | fixture 生成器把 `--help` 当目录名创建 | `tests/fixtures/generate.ts:580` |
| — | 自动备份根本不存在（`backup.intervalHours`/`keep` 零消费者） | `packages/server/src/index.ts:1380-1407` + `runBackupJob()`（:1198）+ `packages/server/src/backup.ts` `pruneBackups()`（:353+） |
| — | CLI `backup` 不写 `backups` 表 → `lastBackupAt` 恒为 null | `apps/cli/src/main.ts` `cmdBackup` |
| — | 媒体热路径绕过预编译语句缓存 | `packages/db/src/index.ts` LRU + 6 处改走 `stmt()` |

---

## 8. 交付物

| 交付物 | 位置 |
| --- | --- |
| 可运行系统 | `packages/*` + `apps/cli` + `web/` |
| 安装/部署手册 | [DEPLOYMENT.md](DEPLOYMENT.md)（Linux + Windows + 三种形态） |
| 架构契约（冻结的模块签名与 HTTP 端点） | [ARCHITECTURE.md](ARCHITECTURE.md) |
| 格式映射细则 | [format-mapping.md](format-mapping.md) |
| 15 项验收逐条结果 | [acceptance.md](acceptance.md) |
| 最终交付报告 | [FINAL-REPORT.md](FINAL-REPORT.md) |
| 开源项目调研 | [qq-export-projects-research.md](qq-export-projects-research.md)、[qce-reuse-analysis.md](qce-reuse-analysis.md)、[snowluma-analysis.md](snowluma-analysis.md) |
| systemd / Windows 部署脚本 | `deploy/` |
| 配置模板（含逐字段注释） | `config.example.json` |
| 合成测试数据生成器 | `tests/fixtures/generate.ts` |

---

## 9. 已知缺口与未实现（诚实清单）

### 9.1 本轮复核新发现的未接线功能（与 BUG#1 同类）

| ID | 事实 | 证据 |
| --- | --- | --- |
| **G1** | `logs` 表、`/api/logs` 路由与网页日志页都在，但**日志从未写入数据库**：`Logger` 支持 `dbSink`，全仓**没有任何调用点传它**。真机实测 `SELECT COUNT(*) FROM logs` = **0** | `packages/core/src/logger.ts:16,30,146`；`apps/cli/src/main.ts:157` 构造时只传 `level`/`dir` |
| **G2** | `Database.pruneLogs(keepDays)` 定义但**无任何调用点** → 数据库日志保留策略是死代码 | `packages/db/src/index.ts:1444` |

影响：网页的日志视图（`GET /api/logs` → `db.listLogs()` → `logs` 表）**恒为空**；这不影响文件日志 `data/logs/archive.log`（它正常写入并按大小轮转，`packages/core/src/logger.ts:109`）。
这两项都是"实现存在、生产路径未接线"，与 BUG#1 是同一类问题；修法是构造 logger 时传 `dbSink: (e) => db.appendLog(e)` 并在启动时调用一次 `pruneLogs`。

### 9.2 已实现但有局限

- **视频缩略图**依赖系统 `ffmpeg`，缺失时降级为占位图（不影响归档与播放）。
- **TXT 导入**格式信息量低，只能尽力解析；无法解析的行保留原文并计数。
- **中文单字搜索**走 `LIKE` 全表扫描，超大数据集下比 FTS 慢（二元组路径不受影响）。
- **合并转发展开**默认 3 层 / 200 节点，触顶置 `truncated` 而非静默截断。
- **媒体直链过期**：已有 OneBot 回落重取，但**没有** rkey 主动刷新（不做预判过期，只在失败后补救）。
- **性能证据口径**：`prepare` 次数是硬计数，但**没有 wall-clock 吞吐量测量**；DB 测试用内存库。

### 9.3 有意不做

- 设备端解密导出（root/Frida）——不合法不稳定，也不符合"不注入、不改客户端"的定位。
- 从腾讯服务端删除记录中恢复、读取已解散群、获取手机端未同步历史——见 §1.2。

---

## 10. 第三方代码与许可证边界

**本项目没有复制任何第三方项目的代码，所有代码为自研。** 架构选择是刻意的：**通过稳定的 HTTP 接口解耦，而不是链接/打包 GPL 或非开源代码。**

| 项目 | 许可证（已核实 LICENSE） | 使用方式 |
| --- | --- | --- |
| shuakami/qq-chat-exporter | GPL-3.0 | **只借鉴导出格式**（读取其产物），未复制代码；扫码登录只参考其**接口契约**，客户端从零重写 |
| Tealina28/QQNT_Export | GPL-3.0 | 未使用（需已解密本地 DB，与手机端场景不符） |
| NapNeko/NapCatQQ | 自定义：禁商用、禁发布修改版（**非 OSI 开源**） | **仅通过 HTTP 调用**其 OneBot 与 WebUI 接口，不链接、不修改、不打包、不分发其字节 |
| LagrangeDev/Lagrange.Core | **无 LICENSE**（默认保留所有权利） | 未使用（无许可证 = 不可复用） |
| LLOneBot/LuckyLilliaBot | GPL-2.0 | 未使用（但兼容其 OneBot 接口） |
| QQBackup/QQ-History-Backup | MIT | 未使用（需 root/Frida） |
| SnowLuma/SnowLuma | **Source-Available 非商业许可 v1.0**（限制商业使用与修改版公开发布，且禁止在其之上另建项目） | **未使用任何代码**；仅阅读源码提取机制与思路（预编译语句缓存、媒体 URL 失效处理），由本项目独立实现 |

**本项目的许可**：**[PolyForm Noncommercial License 1.0.0](../LICENSE)**（源码可见，非 OSI 认可的开放源代码许可）——任何**非商业**目的可自由使用、修改与分发；**商业使用须事先取得著作权人书面授权**。公开仓库：<https://github.com/emoeem/qq-archive>。

---

## 11. 复现步骤

```bash
cd /home/emo/code/QQ
npm run typecheck                 # 期望 0 错误
npm test                          # 期望 347 pass / 0 fail

cp config.example.json config.json && chmod 600 config.json
node --experimental-strip-types apps/cli/src/main.ts doctor      # 环境自检（首次会生成令牌）
node --experimental-strip-types apps/cli/src/main.ts import <导出文件>
node --experimental-strip-types apps/cli/src/main.ts stats
node --experimental-strip-types apps/cli/src/main.ts collect --once   # 需要旁边有 OneBot 实现
node --experimental-strip-types apps/cli/src/main.ts token
node --experimental-strip-types apps/cli/src/main.ts serve            # 浏览器打开 http://127.0.0.1:8787
```

---

## 12. 结论

系统**是真实实现并经过真机验证的**，不是静态页面或演示桩：

- 采集、导入、媒体归档、中文检索、网页管理、扫码登录、备份恢复、部署脚本**全部连真实数据通路**；
- 347 个自动化用例 + 0 类型错误，且测试数据全部合成、不含真实聊天记录；
- 真机跑出了 13 会话 / 282 消息 / 25 媒体（全部 `present`）/ 28 条关联，采集轮次持续 `ok=true`；
- 历史上一批"文档宣称已实现、代码里没接线"的缺陷（BUG#1、自动备份、CLI 备份入库、缩略图、systemd 段位）已修复并有回归护栏；
- 仍存在 §9.1 的两处**未接线**（日志入库、DB 日志裁剪）和 §9.2 的若干局限，本文如实标注，不宣称已完成；
- §1.2 的边界是 QQ/OneBot 侧的硬限制，本系统不宣称能突破。
