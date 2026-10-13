# SnowLuma 调研：可借鉴机制与本项目落地的改进

调研对象：[SnowLuma/SnowLuma](https://github.com/SnowLuma/SnowLuma)（本地只读副本 `/tmp/SnowLuma`，分支 `dev`）。
调研目的：回答「这个项目有没有可以利用和优化的部分」——既找**能借鉴的机制**，也用它反照出**本项目的真实缺陷**。

结论先行：**它的代码一行都不能用**（见 §1），但它有两处工程机制直接照出了本项目的真缺陷，
其中两处已经在本仓库落地并带测试证据（见 §4）。另有 6 项建议按性价比排序（见 §5），
以及 6 个能力缺口（见 §6）。

---

## 1. 许可证边界：只能学思路，不能拿代码

**这一条是硬约束，必须先说。** `/tmp/SnowLuma/LICENSE` 原文（已逐字核对）：

```
SnowLuma Source-Available Non-Commercial License
SnowLuma 源码可见非商业许可

Version 1.0 · 2026-06-19
Copyright (C) 2026 SnowLumaDevs

This is NOT an open-source license as defined by the Open Source Initiative:
it restricts commercial use and the public release of modifications. The
source is published for transparency, study, and non-commercial self-hosting.
```

中文为准（许可原文声明「中英文如有冲突，以中文为准」），要点：

- **不是 OSI 开源许可证**。它明确限制商业用途、限制修改版的公开发布。
- 仓库另有一份 `EULA.md`，同样不是开源条款。

因此本项目对 SnowLuma 的处置是：

| 项 | 结论 |
| --- | --- |
| 复制/改写其源码 | **不做**。本仓库不含任何 SnowLuma 代码。 |
| 依赖它 | **不做**。 |
| 作为「另一个项目」建立在它之上 | **不做**，许可明文禁止。 |
| 阅读其源码、提取**机制与思路**，用本项目自己的代码重新实现 | **做**，本文其余部分仅限此范围。 |

后文凡引用其实现细节，都只作**事实描述**（文件/常量名），不提供可直接粘贴的代码。

---

## 2. SnowLuma 值得借鉴的机制

以下为对 `/tmp/SnowLuma` 的实读结论（由子代理完成，我复核了其中的许可证与本项目侧的事实）。

**SQLite 层**
- 自研 N-API 扩展对接原生 C SQLite（`packages/sqlite/src/native.ts`）：`DRIVER_VERSION='9.1.0'`、
  `NATIVE_INTERFACE_VERSION=1`、`REQUIRED_NAPI_VERSION=10`，**版本不匹配就拒绝加载**，不静默降级。
- 所有打开点共用一个 helper（`packages/onebot/src/sqlite-open.ts`），pragma 预设唯一：
  `busy_timeout` / `foreign_keys` / `journal_mode=WAL` / `synchronous=NORMAL`。
- **预编译语句按 SQL 文本缓存**（`Map<string, Statement>`），热路径里**没有**循环内 `prepare()`。
- 事务：单个 `tx(fn)` 包装，整批一次提交，配 `INSERT OR IGNORE` 做幂等重采。
- **迁移可真正续跑**：进度记在侧表，中断后从上次完成单元继续，而不是从头再来；
  索引用标记位（`PENDING_INDEX_NAME`）把「建索引」推迟到回填完成之后；迁移跑在 **worker 线程**上，主线程继续服务。
- 布局按 **QQ uin 一库一文件**（`<dir>/<uin>/message.db`），单账号库损坏不拖垮其余。

**风险控制**
- `single-flight-cache.ts`：并发相同的异步调用合并成一个 in-flight promise，防雪崩。
- `concurrency.ts`：有界并发 map，不对用户数据做无界 `Promise.all`。
- 每账号网络管理器（`network/*`、`quick-operation.ts`）：把该账号的出站 OneBot 调用串到一个队列并设最小间隔
  ——它防的不是本地过载，而是**触发 QQ 风控／封号**。

**敏感数据（两层，容易混）**
- `log-sanitize.ts` 剥终端控制序列（ESC/BEL/C1 CSI），是**防日志注入**，不是脱敏。
- 真正的脱敏在 `log-summary.ts`：**按 key 名结构化脱敏，发生在序列化之前**（整个值替换成 `<redacted>`），
  所以形状不匹配任何正则的密钥也会被抹掉。
- 访问令牌：生成后**只存哈希**、常数时间比较、从不进日志。
- 日志文件轮转（`log-file-transport.ts`）带一组可观测契约 `LogStorageStatus`
  `{directory,totalBytes,maxTotalBytes,retainDays,perUinEnabled,fileCount,activeFileCount,droppedLines,lastError}`
  ——轮转状态**在 UI 里可见**，而不是只能去磁盘上猜。

**WebUI 运维**：scrypt 口令（`SCRYPT_N=16384, r=8, p=1, keylen=64`）、TOTP 双因子、TLS、
备份/恢复、日志导出、按账号存储管理、SSE 状态流、同意/隐私门、更新检查。

**测试文化**：bench 与代码同目录；每个包一份 `tests/setup.ts` 在 import 前把数据目录重定向到临时路径，
Vitest 一文件一进程，避免 `chdir` 跨文件泄漏。

---

## 3. 本项目实地核查结论

用 SnowLuma 的机制当标尺，逐条核对本仓库代码，**发现两个真缺陷**（下面 §4 均已修复并有测试），
以及若干机制上的弱点（§5）。

| 主题 | SnowLuma | 本项目（修复前） |
| --- | --- | --- |
| 热路径预编译语句 | 全部走按 SQL 缓存 | `insertMessages` 里 5 条语句**每条消息重新 prepare** |
| 媒体字节获取 | 场景感知签名 + TTL 缓存 | `Collector.fetchMedia` 已实现但**生产路径从不调用** |
| 日志脱敏 | 按 key 名结构化、序列化前 | `redact()` 是**事后正则**，关键字表之外的值原样落库 |
| 轮转/备份状态 | 有可观测契约，UI 可见 | 只能看磁盘推断 |
| WAL 增长 | 未设 `wal_autocheckpoint`（其 RoadMap 仍挂账） | 同样未设 |
| 迁移续跑 | 侧表记进度 + worker 线程 | 单版本号顺序迁移 |
| 账号隔离 | 一 uin 一库 | 单库 |

---

## 4. 已落地的两项改进（带真实测试证据）

### 4.1 媒体直链过期后的字节回落

**缺陷**：`Collector.fetchMedia`（`packages/collect/src/onebot.ts:384`）早就实现了
「直链 GET 失败 → 回落 `/get_image` / `/get_record` / `/get_file` 取 base64」，
但**只有测试直调它**，采集生产路径从不使用。而真机采集到的图片/语音 URL 带 rkey 且有 TTL，
过期后直链必然失败 → 旧实现只失败一次就永久记 `missing`，「防丢失」在媒体这一半是假的。

**改动**：`packages/collect/src/runner.ts` 新增 `private async retryViaOneBot(ref, msg)`，
在 `handleMedia` 里**仅当归档结论是 `missing` / `corrupt` 时**才回落一次；
拿到字节后交给 `archiveMediaBytes` 回调（或 `archiver.archiveBytes`），
把结论翻成 `present`。没有字节入口时**不发起无谓下载**；任何异常**不冒泡**（媒体拿不到不影响消息入库）。
配套新增可选契约 `ArchiveMediaBytesFn`（`packages/collect/src/types.ts:125`）与
`MediaArchiverLike.archiveBytes?`（`types.ts:112`）；字节落盘实现见 `packages/import/src/media.ts:396`。

**测试证据**：`tests/collect.test.ts` 新增 5 例，本文件实测 **20 tests / 20 pass / 0 fail**：

- `16.` 直链失败后回落 OneBot 重取字节，`missing` 结论被推翻（断言走的是 `/get_image`，且 `mediaMissing` 归零）
- `17.` 未注入字节入口时不做无谓重取，媒体保持 `missing`（断言 `/get_image` 调用数为 0）
- `18.` 只注入 `archiver` 时走它的 `archiveBytes` 入口
- `19.` 归档成功时不触发重取（回落只在失败分支）
- `20.` 重取抛错不冒泡，媒体仍按 `missing` 落库、消息照常入库

### 4.2 预编译语句缓存被热路径绕过

**缺陷**：`packages/db/src/index.ts` 有按 SQL 文本缓存的 `stmtCache` 与 `private stmt(sql)`，
但 `insertMessages` 内部为了「存在性判断 / bigram / INSERT messages / FTS insert / message_fts 同步」
**直接调 `this.raw.prepare(...)`**，等于**每条消息重新编译 5 条语句**，`pageSize` 越大浪费越多。
读路径（`getMessageTexts` 等）同理。

**改动**：把这些**静态 SQL** 全部收敛到 `this.stmt(...)`；并给缓存加上限，
防止动态拼出的 `IN (?,?,…)` 把缓存撑爆：

- `packages/db/src/index.ts:260` `static readonly STATEMENT_CACHE_MAX = 256;`
- `:286-288` 超出上限时淘汰最久未用的一条（LRU）
- `:296` 暴露缓存大小供测试断言

残留的 4 处 `this.raw.prepare(...)` 均为**应当**保留的：

| 位置 | 原因 |
| --- | --- |
| `packages/db/src/index.ts:285` | 就在 `stmt()` 内部，是缓存未命中时的创建点 |
| `:332` | `SELECT 1` 健康探针，只在打开时跑一次 |
| `:768`、`:918` | `countSql` / `WHERE` 为运行时动态拼接，无法静态缓存 |

共转换 **6 处静态 SQL**（其中 4 处在插入循环内，是真正的热路径）：

| 符号 | SQL | 频度 |
| --- | --- | --- |
| `insertMessages` → `insertSql` | `INSERT OR IGNORE INTO messages` | 每条消息 |
| `insertMessages` → `findSql` | 按 `(account_uid, session_key, msg_key)` 查存在性 | 每条重复消息 |
| `insertMessages` → `ftsSql` | `INSERT INTO messages_fts` | 每条插入 |
| `insertMessages` → `bigramSql` | `INSERT INTO messages_fts_bigram` | 每条插入 |
| `getMessage(id)` | `SELECT * FROM messages WHERE id = ?` | 每请求 |
| `stats()` | 多子查询汇总 | 每次仪表盘轮询 |

**测试证据**：`tests/db-prepare-cache.test.ts` 3 例，本文件实测 **3 tests / 3 pass / 0 fail**。
用 spy 包住 `DatabaseSync.prototype.prepare` 计数：

| | n=1 | n=10 | n=50 |
| --- | --- | --- | --- |
| 修复前 | 5 | 32 | 152 |
| 修复后 | 5 | 5 | 5 |

即 `Δ(50−10)` 从 **120 次**降到 **0 次**（原先约每条消息 3 次白编译）。
另两例覆盖：缓存路径下插入/读回/`getMessageTexts` 的动态 `IN`/FTS 检索/去重结果全部正确；
以及 LRU 上限（枚举 1023 种动态 `SET` 组合，断言 `statementCacheSize` 始终 ≤ 256）。

---

## 5. 建议但**尚未**实施（按性价比排序）

1. **日志脱敏改为「按 key 名、序列化之前」**（`packages/core/src/logger.ts:36` 的 `redact()`）。
   现状是事后正则 + 关键字表（`token|password|secret|authorization|...`）。
   已核查：**当前没有任何调用点泄漏**（逐点看过 `logger.*` 与 `appendLog` 调用，
   传的都是 `msgKey` / `sessionKey` / 错误文本，无口令、无聊天正文）。
   但机制弱：将来某个 key 不在表里、或形状不匹配任何正则，就会原样落库。
   建议保留正则做深度防御，另加结构化 key 脱敏 + 一条「喂进 `{apiKey, sessionKey, cookie, authorization}` 后断言落库串不含其值」的测试。
2. **把轮转/备份状态做成可观测契约**，在 `/api/stats` 或新 `/api/storage` 暴露
   （字节数、上限、保留天数、文件数、丢弃行数、lastError）。
3. **设 `PRAGMA wal_autocheckpoint` 或周期性 `wal_checkpoint(TRUNCATE)`** 并让它可见
   ——SnowLuma 自己也没做，两边 WAL 都可能无限增长。
4. **把访问令牌移出 EventSource 查询串**（`packages/server/src/index.ts:963` 的 `?access=<token>`）：
   令牌进 URL 会经日志/Referer 泄漏，改用 cookie 或一次性 ticket。
5. **迁移可续跑 + 放 worker 线程**：加列/回填类迁移中断后不必从头来。
6. **按账号分库**：隔离单账号库损坏。属结构级改动，当前痛点不足以支撑，仅挂路线图。

---

## 6. 能力缺口（对照 NapCat，不影响现有架构的只读补强）

SnowLuma 的 `packages/mcp/src/generated/catalog.json` 收录 199 个 action，其中 81 个只读；
**67 个在 NapCat 里确实存在**，14 个是 SnowLuma 独有（**不可接线**：
`_get_friend_dress`、`fetch_face_entity`、`search_sys_faces`、`get_group_album_list`、`get_qzone_feeds` 等）。
按价值排序：

1. **`get_msg(message_id)` —— 最值得补的一个。**
   我们现在只留 `{msgId, preview}`（`packages/collect/src/onebot.ts:218-220`），
   库里只存 `reply_to_id` / `reply_to_msg_key`（`packages/db/src/index.ts:506-507`、
   `packages/db/src/schema.sql:81-82`）——**被引用消息的原文从未归档**。
2. `get_recent_contact` —— 能发现 `discoverSessions` 漏掉的陌生人/临时会话。
3. 群文件接口（`get_group_root_files` / `get_group_files_by_folder` / `get_group_file_url` / `get_private_file_url`）：
   现有 `get_file` 只覆盖图片与语音缓存。
4. 群成员接口（`get_group_member_list` / `get_group_member_info` / `get_stranger_info`）：
   可回填 `contacts`、`sessions.member_count`，也能解析合并转发里的作者。
5. `_get_group_notice` + `get_essence_msg_list`：群公告/精华完全在消息历史之外。
6. `fetch_ptt_text(message_id)`：服务端语音转文字，可作为本地 whisper 之外的第二条路。

**参数漂移（重要）**：catalog 把历史游标写成 `message_id`，但 NapCat 的 `Get*MsgHistory`
schema 收的是 `message_seq`（`go-cqhttp/Get*MsgHistory.ts:12`）。
本项目 `packages/collect/src/onebot.ts:258` 用的正是 `message_seq`，**是对的**；
若照 catalog 实现反而会坏。

**零新增 action 的收益**：NapCat 的历史接口本来就接受 `disable_get_url`（默认 false）与
`parse_mult_msg`（**默认 true**，可能已经把合并转发内联展开）。在 `syncMedia` 关闭时补
`disable_get_url:true`，可省掉一部分取 URL 的开销（改动点：`onebot.ts:255-258` 附近）。

---

## 7. 真实边界与未验证项

**已验证**：`npx tsc -p tsconfig.json --noEmit` → **0 错**；
`npm test` → **248 tests / 248 pass / 0 fail**（基线 240 + 本文 §4.1 的 5 例 + §4.2 的 3 例）。
单项复跑：`tests/collect.test.ts` 20/20、`tests/db-prepare-cache.test.ts` 3/3。

**未验证 / 不可验证**：

- §6 的能力缺口**全部未经真机验证**：能力判断来自 NapCat 的 `packages/napcat-onebot/action/router.ts`
  与各 action 源码、以及 `doc.napneko.icu` 的两页文档，**未在真实 NapCat 上逐个调用**。
- §5 的 6 条建议**均未实施**，只是评估结论。
- SnowLuma 侧的性能数字（RoadMap 里的前后 µs 与倍率）是**其自述**，未复测，只作方向参考。
- SnowLuma 的按账号分库、worker 线程迁移等结构级机制，本项目**未采用**。

**许可证再强调**：本仓库不包含 SnowLuma 的任何代码；本文档与其实现相关的描述仅为机制性事实，
不构成可复用的代码。
