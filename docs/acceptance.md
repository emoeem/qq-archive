# 验收测试报告

> 涵盖任务书「八、第六阶段：测试与验收」要求的 15 项测试，逐项给出状态、可复现的测试用例位置与**真实运行输出**。
>
> 本文件中的每一个数字都来自实际执行，不用编译通过替代功能测试，不虚构结果。
>
> 测试日期：2026-10-13　环境：CachyOS Linux / Node v24.21.0 / SQLite（Node 内置 `node:sqlite`）/ ffmpeg 9.0.2

---

## 0. 如何复现

```bash
cd /home/emo/code/QQ

# 类型检查（无编译步骤；Node 直接执行 .ts）
npx tsc -p tsconfig.json --noEmit          # 期望：无任何输出

# 全量自动化测试
node --test --experimental-strip-types "tests/**/*.test.ts"

# 只跑本报告的 15 项验收 + 5 项真实联调
node --test --experimental-strip-types tests/acceptance.test.ts tests/integration.test.ts

# 真实子进程跑一遍 CLI（配置、导入、备份、恢复全链路）
node --test --experimental-strip-types tests/cli.test.ts
```

测试数据全部由 `tests/fixtures/generate.ts` **程序化生成**（固定随机种子 `20261013`），不包含任何真实聊天记录。

---

## 1. 测试总量

| 测试文件 | 用例数 | 结果 | 覆盖对象 |
|---|---:|---|---|
| `tests/db.test.ts` | 7 | 全绿 | 数据模型、迁移、FTS 检索、游标 |
| `tests/cli.test.ts` | 21 | 全绿 | 参数解析、配置加载、**真实子进程端到端**（含 `--config` 回归护栏、`--version`、**`transcribe` 子命令**） |
| `tests/import.test.ts` | 14 | 全绿 | **5 种格式**导入（含 HTML）、格式自动识别、错误分类、导入器注册数 |
| `tests/html-import.test.ts` | 9 | 全绿 | **HTML 导入**：QCE viewer / QCE DOM / 通用聊天页三种 fixture + 保守探测（不像聊天页必须判 `unknown`）+ 换行/方向/媒体/时间解析 |
| `tests/media.test.ts` | 23 | 全绿 | 内容寻址归档、SHA-256、缩略图（含**归档时必产出 `thumbPath`** 的回归用例）、缺失/损坏标记、**HTTP Range 断点续传 9 例**（206 追加后 sha256 一致 / 200 截断重下 / `If-Range` / 416 / 超限清残片） |
| `tests/collect.test.ts` | 15 | 全绿 | OneBot 协议、只读白名单、退避重试、断点续传、**媒体入库护栏**、**零历史会话不当失败** |
| `tests/server.test.ts` | 17 | 全绿 | 30+ 条路由、认证、导出、备份、SSE、**定时自动备份写入 backups 表**、**`/api/stt/*` 与 `/api/media/:id/transcript`** |
| `tests/web.test.ts` | 25 | 全绿 | 纯函数库、XSS 护栏、API 路径契约 |
| `tests/qr.test.ts` | 13 | 全绿 | 零依赖 QR 编码器：容量表、RS 数学、格式信息、几何、放置不变式、PNG 结构、**与 `qrencode` 逐模块黄金对比**、`zbarimg` 回环 |
| `tests/napcat.test.ts` | 18 | 全绿 | NapCat WebUI 客户端：密码哈希、端口探测、认证、凭据失效重认证、快捷登录错误语义 |
| `tests/napcat-login-e2e.test.ts` | 7 | 全绿 | **真子进程 CLI + 真 HTTP + 假 NapCat WebUI**：退出码、终端二维码逐模块等于编码器输出、重认证恰好一次 |
| `tests/napcat-routes.test.ts` | 9 | 全绿 | `/api/napcat/*` 四条路由的 HTTP 契约：401/503/400 语义、**二维码只下发 PNG 且响应体不含 URL 明文（用逐像素解开 PNG 与编码器矩阵比对来证明）**、**错误映射必须透传真实 status/code（回归：曾退化成 `503 {code:"string"}`）** |
| `tests/acceptance.test.ts` | 15 | 全绿 | **本报告第 2 节的 15 项** |
| `tests/integration.test.ts` | 5 | 全绿 | **不注入任何桩**的真实联调（见第 4 节） |
| `tests/hardening.test.ts` | 2 | 全绿 | 快速开始自检的回归护栏：systemd `StartLimit*` 必须在 `[Unit]` 段；`generate.ts --help` 不得把选项当输出目录 |
| `tests/forward.test.ts` | 15 | 全绿 | **合并转发展开**：纯函数（嵌套/去重/截断冒泡/预算）、`get_forward_msg` 协议（含**真机 `node.sender` 嵌套形状回归**）、`CollectRunner` 真库端到端 |
| `tests/stt.test.ts` | 25 | 全绿 | **语音转文字**：文本归一化、英文模型识别、探测缓存、ffmpeg+whisper 命令组装、批量流水线（真库、真临时文件）、DB 契约与级联删除 |
| **合计** | **240** | **240 pass / 0 fail** | 耗时约 28.9 s |

```
ℹ tests 240
ℹ pass 240
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 28905.595011
```

上表 17 个文件**逐个单独跑**的用例数之和恰为 240，与全量跑批一致。

---

## 2. 15 项验收测试逐项结果

状态取值严格使用任务书给定的五档：**已实现且测试通过** / **已实现但存在限制** / **部分实现** / **尚未实现** / **受 QQ 或操作系统限制，无法验证**。

| # | 任务书要求 | 状态 |
|---:|---|---|
| 1 | 私聊文本 | ✅ 已实现且测试通过 |
| 2 | 群聊文本 | ✅ 已实现且测试通过 |
| 3 | 长消息和多段消息 | ✅ 已实现且测试通过 |
| 4 | 图片 | ✅ 已实现且测试通过 |
| 5 | 视频 | ✅ 已实现且测试通过 |
| 6 | 文件 | ✅ 已实现且测试通过 |
| 7 | 同一消息重复导入 | ✅ 已实现且测试通过 |
| 8 | 程序异常退出和重启 | ⚠️ 已实现但存在限制（见 2.8） |
| 9 | 网络中断后恢复 | ⚠️ 已实现但存在限制（见 2.9） |
| 10 | 大批量历史记录导入 | ✅ 已实现且测试通过 |
| 11 | 媒体文件缺失 | ✅ 已实现且测试通过 |
| 12 | 数据库备份和恢复 | ✅ 已实现且测试通过 |
| 13 | 未登录访问管理接口 | ✅ 已实现且测试通过 |
| 14 | 未授权访问媒体文件 | ✅ 已实现且测试通过 |
| 15 | 搜索结果与原始导入数据的一致性 | ✅ 已实现且测试通过 |

**13 项完全通过；2 项（8、9）功能已实现且自动化测试通过，但测试使用的是自建假 OneBot 服务端，未在真实 NapCat/LLOneBot 上验证**，故降档为「已实现但存在限制」，理由见对应小节。

### 2.1 私聊文本 ✅

- 用例：`tests/acceptance.test.ts` → `验收1: 私聊文本导入 —— 条数、时间、发送者、文本与源文件一致`
- 导入 `private-export.json`（120 条），逐条比对源文件：条数、`timestamp`（毫秒）、发送者 `uid`/`name`、消息文本逐字相同。
- 实测：`{"totalItems":120,"inserted":120,"duplicate":0,"failed":0}`。
- 同时校验会话被正确识别为 `private`（`db.stats().privates === 1`）。

### 2.2 群聊文本 ✅

- 用例：`验收2: 群聊文本导入 —— 会话类型、@提及、引用回复、撤回、系统消息被保留`
- 保留内容：`chatType='group'`、群号、群名片、`@提及`（解析为 JSON 数组存 `messages.mentions`）、引用回复关系、`recalled` 撤回标记、`system` 系统消息。
- 实测：`247` 条源条目 → `244` 入库、`3` 条文件内重复被唯一约束挡掉、`0` 失败。

### 2.3 长消息和多段消息 ✅

- 用例：`验收3: 长消息与多段 —— 完整文本不截断，elements 多段保留`
- 夹具中的长消息为 **1530** 字符（`expected.longMessageLength`）；断言入库文本长度与源完全一致，**不截断**。
- 多段 `elements`（text + image + at 混合）按顺序折叠为完整 `text`，原始 `rawMessage` 原样保存在 `messages.raw_json` 列，可随时回溯。

### 2.4 图片 ✅

- 用例：`验收4: 图片 —— 内容寻址落盘、sha256 校验、缩略图与原件可下载`
- 内容寻址：文件按 `sha256` 命名落盘（`image/<年>/<月>/<前2位>/<sha256>.png`），路径与内容强绑定。
- 断言的 HTTP 行为：缩略图端点 `200`、原图端点 `200`、字节内容与磁盘文件逐字节一致。
- 实测：`mediaStats {total: 6, present: 5, missing: 1, corrupt: 0, bytes: 677}`。

### 2.5 视频 ✅

- 用例：`验收5: 视频 —— kind=video 落盘且 HTTP 支持 Range 播放`
- `clip.mp4` 以 `kind='video'` 落盘；HTTP 层支持 `Range` 请求（返回 `206` + `Content-Range`），这是浏览器 `<video>` 拖动播放的必要条件。
- 缩略图依赖 ffmpeg；本机 ffmpeg 9.0.2 可用（`doctor` 报「✓ ffmpeg 可用」）。**ffmpeg 缺失时降级为无缩略图，不影响原视频归档与播放**——这条路径由 `tests/media.test.ts` 用确定性注入 `ffmpegPath: '/nonexistent/ffmpeg'` 覆盖。

### 2.6 文件 ✅

- 用例：`验收6: 文件 —— 原始文件名与声明大小被保留，可下载`
- `message_media` 关联表保留**原始文件名**与**源文件声明大小**（`filename` / `declared_size`），与去重后的物理存储解耦——因为同一个物理文件可能以不同文件名出现在不同消息里。
- 实测：`report.txt` 以 `kind='file'` 落盘，文件名与大小均可从关联表还原。

### 2.7 同一消息重复导入 ✅

- 用例：`验收7: 同一消息重复导入 —— 幂等，不产生重复行、不重复占用磁盘`
- 幂等靠**唯一约束**保证，而不是先查后写（避免竞态）：`messages(account_uid, session_key, msg_key)` 唯一。
- 实测同一文件导入两次：

```
first  {"totalItems":247,"inserted":244,"duplicate":3,"failed":0}
second {"inserted":0,"duplicate":247,"messages":244}
```

  第二次 `inserted=0`、消息总数不变、媒体文件不重复占用磁盘（内容寻址天然去重：夹具中 `photo-red.png` 与 `photo-red-copy.png` 内容相同，只占 1 行 `media`、1 个物理文件）。

### 2.8 程序异常退出和重启 ⚠️ 已实现但存在限制

- 用例：`验收8: 程序异常退出与重启 —— 数据库可重开、数据零丢失、游标可续`
- 已验证：进程被强杀后重开数据库，**已落库数据零丢失**（WAL 模式 + 每批事务提交），`schemaVersion()` 正常，采集游标可读可续。
- **限制**：本项在测试进程内模拟「异常退出」（关闭连接后重新 `openDatabase`），**没有真的对操作系统进程发 `SIGKILL` 再重启二进制**。真实的断电/被 OOM killer 杀掉场景未验证。数据库层用的是 SQLite WAL + 事务，这是成熟机制，但「未验证」就是未验证。
- 真实子进程重启路径由 `tests/cli.test.ts` 的端到端用例部分覆盖（每次调用都是全新进程），但它跑的是正常退出。

### 2.9 网络中断后恢复 ⚠️ 已实现但存在限制

- 用例：`验收9: 网络中断恢复 —— 重试成功后落库，重启后从游标续传不重不漏`（耗时 6.06 s）
- 场景：自建假 OneBot 服务端，**前 2 次请求直接 `req.socket.destroy()` 掐断 TCP**，第 3 次正常返回。断言：重试退避为 `1s → 2s → 4s`（`RETRY_DELAYS_MS = [1000,2000,4000]`），最终成功落库；重启后从 `collect_state.cursor` 续传，**不重复、不遗漏**。
- **限制**：服务端是自建的假 OneBot，不是真实 NapCat/LLOneBot。真实的认证失效（`401`）、风控、限流、代理断连未验证。协议层（`packages/collect`）已按真实 HTTP 语义实现对 `401/403/非2xx/非JSON/auth retcode` 的分类，但**没有真实服务端确认过**。

### 2.10 大批量历史记录导入 ✅

- 用例：`验收10: 大批量历史导入 —— 5000 条仍在可接受时间内完成且可检索`
- 实测：`5000` 条全部入库、`failed=0`、耗时 **< 60 s**（实测约 4.5 s，含 HTTP 往返），导入后中文检索立即可用且结果真的包含关键词。
- 分批处理：默认 `batchSize=500`（`DEFAULT_BATCH_SIZE`），单文件 32 MiB 上限（`MAX_MESSAGE_BYTES`），流式解析不把整个文件读进内存。

### 2.11 媒体文件缺失 ✅

- 用例：`验收11: 媒体文件缺失 —— 标记 missing、不生成假文件、关联与原因保留`
- 夹具中 `gone-forever.png` 的本地路径不存在、URL 指向 `https://example.invalid/...`（必然下载失败）。
- 断言的行为（这是任务书 §四.3「如果原始媒体已不存在，不得生成虚假的恢复文件或声称恢复成功」的直接落地）：
  - `media.status = 'missing'`，`fail_reason` 保留具体原因（截断 500 字）；
  - **磁盘上不存在该文件**（`missing-but-on-disk = 0`）；
  - 消息与它的关联仍建立（用户能看到「这里原本有一张图，但拿不到了」，而不是静默消失）。
- 实测：`mediaMissing = 1`，`{total: 6, present: 5, missing: 1, corrupt: 0}`。

> 这一项曾经抓出一个**真实缺陷**：导入器对同一媒体同时从 `content.resources` 和 `content.elements` 各产出一次引用，且去重指纹里含 `url`/`localPath`，导致归档成功的图片**多出一行假的 missing 记录**——Web 界面会给已保存成功的图片打红标「缺失」。已修复为「按 `kind|filename` 身份去重 + 只补空字段」，并有独立回归断言。

### 2.12 数据库备份和恢复 ✅

- 用例：`验收12: 数据库备份恢复 —— 真实备份→校验→损坏→恢复→数据一致`
- 流程（**不是只测备份命令是否执行成功**，而是真的走完恢复）：
  1. `backup` 生成快照 + `manifest`（含 sha256 与行数清单）；
  2. `verifySnapshot` 校验文件头、与清单的 sha256、`PRAGMA quick_check`；
  3. **主动损坏当前数据库**；
  4. `restore`（`dryRun:false`）→ 先把当前库另存为 `<db>.bak-<时间戳>`，再复制快照回来，返回**新连接**；
  5. 核对消息数、媒体数、`schemaVersion` 与损坏前一致。
- 校验链任一步不过 → 直接拒绝恢复（400），不会用坏快照覆盖好数据。
- 备份**不依赖 QQ 本地数据目录**：只依赖配置里的 `storage.backupDir`。
- 真实子进程版本（含 `dry-run` 与 `--apply` 两条路径）见 `tests/cli.test.ts`。

### 2.13 未登录访问管理接口 ✅

- 用例：`验收13: 未登录访问管理接口 —— 一律 401，绝不泄露任何数据`
- 无凭据、错误令牌、过期令牌、伪造签名 → 全部 `401`，响应体**不含任何聊天数据、也不含堆栈或内部路径**。
- 令牌是 HMAC 签名的自包含访问令牌（`packages/server/src/auth.ts`），比较用常量时间函数（`constantTimeEqual`）避免时序侧信道。
- 登录接口有**进程内限速**防爆破。

### 2.14 未授权访问媒体文件 ✅

- 用例：`验收14: 未授权访问媒体 —— 401、路径穿越被拒、返回头不泄露绝对路径`
- 覆盖三类攻击面：
  1. 无凭据访问 `/api/media/:id/raw` → `401`；
  2. **路径穿越**（`../../config.json`、URL 编码变体、绝对路径）→ 拒绝；
  3. 响应头（`Content-Disposition` 等）**不回显服务器绝对路径**。
- 媒体根目录做了**边界校验**（解析后的真实路径必须仍在 `mediaDir` 之内），而不是字符串前缀比较。

### 2.15 搜索结果与原始导入数据的一致性 ✅

- 用例：`验收15: 搜索结果与原始导入数据一致性 —— 零漏报、零误报、文本逐字相同`
- 做法：**独立地从源 JSON 里按消息 id 去重**统计出应命中的集合，再与检索结果逐条比对，断言 `total` 相等、且每条命中文本真的包含关键词。
- 实测唯一关键词 `蓝鲸计划ZZQ`：源文件中 **群聊 14 条 + 私聊 1 条 = 15 条**；检索返回 `{"total":15,"returned":15}` —— 零漏报、零误报。
- 中文检索原理：查询与索引都不做中文分词，而是**双字组（bigram）** 展开——`蓝鲸计划ZZQ` → `鲸计 AND 计划 AND ZZQ`（另加首尾处理），SQLite FTS5 + `MATCH` 走索引；**单个汉字**无法组成 bigram，自动退化为 `LIKE` 扫描（`planSearch()` 决定走 `fts` 还是 `like`）。
- 附带验证：`messages.text` 与源文本逐字相同（含 emoji、全角标点）。

> 这一项曾经因为**测试自身的写法**误报：最初的真值表按**文本**建 map，而群聊里 14 条命中消息的文本完全相同，被折叠成 1 条，导致期望 2 而实际 15。实际检索结果是对的，错的是测试的去重维度——已改为按消息 id 去重。

---

## 3. 采集能力实测统计

任务书要求「对于实际采集能力，使用测试数据统计消息数量、重复数量、漏采情况以及媒体文件保存率」。

数据来源：`tests/fixtures/generate.ts`（种子 `20261013`，程序化生成，无真实聊天记录）。

### 3.1 消息数量与重复

| 指标 | 群聊 | 私聊 | 合计 |
|---|---:|---:|---:|
| 源文件条目数 | 247 | 120 | 367 |
| 实际入库 | 244 | 120 | **364** |
| 判为重复 | 3 | 0 | **3** |
| 失败 | 0 | 0 | **0** |
| 导入耗时 | 81 ms | — | — |

- **重复率**：3 / 367 = **0.82%**，全部来自源文件内部的重复条目（夹具刻意构造），被唯一约束挡掉，未产生重复行。
- **失败率**：0 / 367 = **0%**。
- **二次导入幂等**：`{inserted: 0, duplicate: 247, messages: 244}` —— 消息总数不变。
- 落库结果：`{messages: 364, sessions: 2, groups: 1, privates: 1}`。

### 3.2 漏采情况

| 场景 | 结果 |
|---|---|
| 单次完整导入（无中断） | 漏采 **0** 条（367 源条目 = 364 入库 + 3 重复） |
| 网络中断后重试（假 OneBot，前 2 次 TCP 掐断） | 重试后全部落库，**0 漏 0 重** |
| 重启后从游标续传 | **0 漏 0 重**（游标按 `cursorTs` 回看窗口保守重叠，靠唯一约束兜底）|
| **真实 NapCat / 真实腾讯服务端** | **未验证**（见第 5 节） |

### 3.3 媒体文件保存率

| 指标 | 数值 |
|---|---:|
| 夹具声明的媒体文件 | 6 |
| 其中可获取（本地存在或可下载） | 5 |
| 其中声明存在但实际拿不到 | 1（`gone-forever.png`）|
| 去重后 `media` 表行数 | 6（5 present + 1 missing）|
| 磁盘上真实文件数 | 5 |
| present 行中真实存在于磁盘的比例 | **5 / 5 = 100%** |
| missing 行中不存在文件的比例 | **1 / 1 = 100%**（绝不生成假文件）|
| 媒体归档成功**字节校验** | `corrupt = 0` |
| 媒体占用 | 677 字节 |

- **可获取媒体的保存率 = 100%**（5 个可获取的全部落盘并校验通过）。
- 若按「声明总数」算，保存率 5/6 = **83.3%**，缺的那 1 个被**明确标记为 missing 并保留原因**，而不是静默丢弃或伪造文件。
- **去重效果**：夹具中 `photo-red.png` 与 `photo-red-copy.png` 内容完全相同 → 只占 1 行 `media`、1 个物理文件，但两条消息的关联都保留。
- **归档操作次数 vs 物理文件数**：`mediaSaved = 15`（15 次归档操作，约 15 条媒体消息），去重后磁盘上只有 5 个不同 sha256 文件。这两个数字含义不同，不要混淆。

---

## 4. 真实联调（不注入任何桩）

`tests/integration.test.ts` 的 5 个用例**故意不注入任何 `importFn` / collect runner**，强制走 server 的动态探测路径，验证「模块真的能被发现并跑通」：

| 用例 | 验证内容 | 耗时 |
|---|---|---:|
| 联调1 | `POST /api/import` 走真实 `loadImportModule()` 探测 —— 消息**与媒体**都真的落库 | 500 ms |
| 联调2 | `?access=` 查询令牌认证 —— 前端在 `fetch` 无法带自定义头的场景（媒体缩略图/原图、导出下载、SSE）仍能取到数据 | 687 ms |
| 联调3 | `GET /api/jobs/:id/events` —— SSE 真实推送并在终态收尾 | 1017 ms |
| 联调4 | `POST /api/collect/run` 走真实 `createCollectRunner` 探测 + 假 OneBot —— 消息真的落库 | 229 ms |
| 联调5 | 静态前端由 server 真实托管（`index.html`/`app.js`/`style.css` 都可取，深路由回退正确，`/package.json` 不泄露） | 17 ms |

**这 5 项联调抓出了 3 个纯单元测试完全发现不了的真实缺陷**：

1. **`POST /api/import` 100% 失败** —— server 传 `path` 而 `runImport` 要 `filePath`，且没传 `mediaDir`。真实报错 `The "path" argument must be of type string or an instance of Buffer or URL. Received undefined`。**Web 界面的「手动导入」按钮此前根本不可用**。（已修）
2. **server 的 `/api/import` 即使修好路径也不落媒体** —— 因为没传 `mediaDir`，消息入库但媒体全部不落盘。（已修）
3. **CLI `--config` 被静默忽略** —— `main()` 解析出 `flags.config` 却从未传给 `loadConfig()`，于是回退到 `./config.json`，把数据库和媒体文件写进了**进程当前目录**。这会让用户以为在用自己指定的配置，实际写错目录——对一个「防丢失」系统是致命的。已修，并加了**真实子进程回归护栏**（`tests/cli.test.ts`），且用**变异测试**确认：把 bug 改回去，两条端到端用例立刻失败。

同类缺陷还在 CLI 侧抓到一个：**`cmdImport` 自己接线，从不写 `media`/`message_media`** —— 媒体文件归档到了磁盘，但 `media` 表恒为 0 行、Web 媒体页永远空白。已统一改走 `runImport()`，与 server 共用同一实现。

---

## 5. 受 QQ 或操作系统限制，无法验证

以下不是「没做」，是**在现有条件下无法取得真实验证**，如实列出：

| 限制项 | 具体技术原因 |
|---|---|
| **手机端未同步的历史消息** | QQ 不提供任何 API 可以取回「在手机上、但尚未同步到任何已登录客户端/服务端会话」的记录。这**不是**本项目能绕过的工程问题，而是数据不存在于任何可访问位置。 |
| **腾讯服务端聊天记录的完整性** | 任何导出接口返回的都是「服务端愿意返回的部分」。QQ 官方导出工具自身在文档里标注 `serverCompletenessProven: false`，并明确「任何响应都不能证明腾讯服务端的聊天记录完整性」。本项目**不对此做任何保证**。 |
| **群聊离线期间的消息** | NapCat 维护者在 [Issue #1838](https://github.com/NapNeko/NapCatQQ/issues/1838) 明确回复：「这是 feature，不打算实现非离线消息推送」。即机器人不在线期间群里的消息**不会被补齐**。 |
| **撤回的消息** | 撤回事件到达时原内容已不在服务端，**不可取回**。本项目只能记录「这里有一条被撤回的消息」。 |
| **已解散 / 已退出的群聊** | NapCat [Issue #1868](https://github.com/NapNeko/NapCatQQ/issues/1868)：无法读取。 |
| **真实的 NapCat / LLOneBot 实例** | **已做真机验证**（2026-10-13，用户真实 QQ 号扫码登录 NapCat 容器）：`collect --once` 拿到 13 个会话 / 188 条真实消息 / 18 个媒体文件，媒体表与磁盘都对上了（见 §3）。**未做**的是 LLOneBot 等其它 OneBot 实现的真机验证 —— 协议层按同一套只读 HTTP 语义实现。 |
| **真实的 Linux 桌面 QQ 客户端数据目录读取** | 需要已解密的本地数据库与 root/Frida 级别介入，本次未做；这也是刻意选择的路线（只用 HTTP 接口，避免 GPL 传染与本地库侵入）。 |
| **真实的 systemd 部署与重启自愈** | `deploy/` 下提供了 unit 文件，但**未在真实 systemd 环境验证过**重启自愈。 |
| **Docker 部署** | 本机**未安装 docker**，容器化方案未验证（交付物里也未包含 Dockerfile，不做未验证的承诺）。 |
| **真实的语音/音频样本** | **已有真实样本**：真机采集到 3 个真实 `.amr` 语音文件，`stt` 流水线通过生产代码路径（`transcribePending` → ffmpeg → `whisper-cli` large-v3-turbo）转写出中文，结果写入 `media_transcripts`（3/3 成功，总耗时 5.86 s）。**未做**：转写质量基准（CER/WER）、方言/强噪声/多人重叠场景。 |
| **合并转发展开** | **已实现**（`packages/collect/src/forward.ts`，`tests/forward.test.ts` **15 用例**）：采集时调 `/get_forward_msg` 递归展开成树存进 `messages.extra.forward`，转发内附件一并归档；默认 3 层 / 200 节点，触顶置 `truncated` 并提示。**已做真机验证**：对真实归档里的 3 条真实合并转发调用真 NapCat，分别解出 **9 / 9 / 19** 个子节点（含嵌套子转发与视频附件），并据此抓出并修掉了 `node.sender` 嵌套发送者的解析缺陷。**未做**：把一次「新到的真机合并转发」端到端落库后再人工比对完整性。 |

---

## 6. 已知缺陷与修复记录

以下是开发与验收过程中**真实发现并修复**的缺陷，保留在此以便追溯：

| # | 缺陷 | 影响 | 状态 |
|---|---|---|---|
| 1 | 中文检索 tokenizer 末段不回填 bigram | 搜「演唱会」0 命中（末段整段成一个 token） | 已修 |
| 2 | `bigrams()` 额外输出整段 | 多关键词 AND 查询失配 | 已修 |
| 3 | `resourcesFromContent` 媒体重复计算 | 归档成功的图片被打红标「缺失」，`mediaMissing` 虚高 | 已修 + 回归断言 |
| 4 | server `/api/import` 契约不匹配（`path` vs `filePath`） | 手动导入 100% 失败 | 已修 |
| 5 | server `/api/import` 未传 `mediaDir` | 消息入库但媒体不落盘 | 已修 |
| 6 | CLI `--config` 被忽略 | 静默写错目录（严重） | 已修 + 变异验证的子进程护栏 |
| 7 | CLI `cmdImport` 不写 `media`/`message_media` | 媒体表恒为空，Web 媒体页全空 | 已修（统一走 `runImport`） |
| 8 | `detectFormatFromText` 把 `[` 开头的 txt 误判 | `.txt` 导出永远识别失败 | 已修 |
| 9 | `detectFormat()` 对不存在文件抛裸 `ENOENT` | 违反契约（应为 `BAD_REQUEST`） | 已修 |
| 10 | 采集测试假服务端 `req.destroy()` 不返回 | 测试挂起 30 s（`Promise resolution is still pending but the event loop has already resolved`） | 已修（`req.socket.destroy()` + `closeAllConnections()`） |

---

## 7. 结论

- 任务书第六阶段列出的 **15 项测试全部有真实可复现的自动化用例**，其中 **13 项完全通过**，**2 项（异常退出、网络中断）功能已实现且测试通过，但因使用自建假 OneBot 而非真实客户端，保守降档为「已实现但存在限制」**。
- 全量 **115 个测试用例 0 失败**，类型检查 0 错误。
- 采集能力实测：367 条源条目 → 364 条入库、3 条重复被正确拦截、**0 条漏采、0 条失败**；可获取的媒体文件**保存率 100%**，拿不到的 1 个被**明确标记为 missing**，绝不伪造。
- **不存在任何为了让测试变绿而放宽断言语义、或声称完成了未验证功能的情况**；所有限制项集中在第 5 节，均可追溯到具体技术原因。

---

## 8. 交付后修复（按用户实际操作路径复测时发现）

交付后按「用户会怎么用」实走一遍（复制示例配置 → `doctor` → 起 `serve` → 浏览器登录），
又抓到 **3 个只有真实 CLI 路径才会暴露的缺陷**，均已修复并补上**能抓住它们的端到端用例**
（修复前用变异测试确认用例会失败，修复后全绿）。用例总数 **115 → 122**。

| # | 缺陷 | 真实后果 | 修复 | 新增护栏 |
| --- | --- | --- | --- | --- |
| 11 | `cmdServe()` 的 `repoRoot = resolve(import.meta.dirname, '../..')` 少一层：`main.ts` 在 `<repo>/apps/cli/src/`，所以静态目录被解析成不存在的 `<repo>/apps/web` | **`GET /` 恒 404**，网页界面根本打不开；而 `serve` 启动日志一切正常。原有 server 测试全部自己构造 `repoRoot`（`join(root,'repo')` + 手写 `web/index.html`），所以 115 个用例全绿也发现不了 | 改为 `'../../..'`；启动时若 `web/index.html` 不存在则**打印实际查找路径**的警告，不再静默 404 | `tests/cli.test.ts`：从临时 cwd 起真实子进程，断言 `GET /` 返回 200 + `text/html` |
| 12 | `loadConfig()` 在缺少 `server.token` 时生成随机令牌并置 `tokenGenerated=true`，但**没有任何调用方消费该标记**，也从不写回配置文件 | ① `qq-archive token` 打印的是**本进程**临时令牌，与 `serve` 进程的令牌不同 → **网页登录必然「令牌错误」**；② 每次启动换一个令牌，**无任何办法查回运行中的令牌**；③ `doctor` 只查长度，临时令牌长度必然合格，把登录不上的状态报成「✓ 管理令牌已设置」 | `persistToken()` 原子写回配置文件（保留原权限 600）；写不回时如实保留 `tokenGenerated=true`，由 `doctor`（改为报问题）、`token`（非零退出 + 明确说明）、`serve`（直接打印临时令牌并提示写入配置）三处显式告警 | `tests/cli.test.ts`：写回后两次 `token` 输出必须一致、`doctor` 不得再报「临时令牌」；写回失败时必须保持 `tokenGenerated=true` |

附带收紧：`validateConfig()` 现在拒绝**含空格/非 ASCII 的 `server.token`**（把示例里的占位说明
直接当令牌用，长度合格但**公开可猜**），且 `config.example.json` 的 `server.token` 改为留空 ——
「复制示例即用」不会再留下一个人人皆知的令牌。

| # | 缺陷 | 真实后果 | 修复 | 新增护栏 |
| --- | --- | --- | --- | --- |
| 13 | `parseArgs()` 在「没有命令」时无条件把 `command` 兜底成 `'--help'`，而 `main()` 先判帮助后判版本 | **`qq-archive --version` / `-V` 打印整篇用法而不是版本号**（任何版本探测脚本拿到的都是一坨帮助文本） | 兜底时排除 `--version`/`-V`；`main()` 把版本判断提到帮助之前 | `tests/cli.test.ts`：断言 `--version`/`-V` 输出匹配 `/^qq-archive \d+\.\d+\.\d+$/` 且不含「用法」 |

顺带改善（非缺陷）：新增 `bin/qq-archive.mjs` 包装脚本并在 `package.json` 声明 `bin`，
`pnpm link --global` 后可直接用 `qq-archive serve` 等命令，不必每次手打
`node --experimental-strip-types apps/cli/src/main.ts`；包装脚本显式带上运行所需 flag，
因此 Node 22.5（未默认开启类型剥离）同样可用，并透传 `SIGINT`/`SIGTERM` 以保证优雅关闭。

修复后复测：`npx tsc --noEmit` 0 错误；`node --test "tests/**/*.test.ts"` **122 pass / 0 fail**；
真实流程 `doctor` → `token` → `serve` → `POST /api/auth/login` 返回 **200**，`GET /` 返回
**200 `text/html`**（`<title>QQ 聊天记录归档</title>`），中文关键词检索命中 18 条并带 `<mark>` 高亮。

---

## 9. 快速开始自检（照 README「快速开始」逐步实走一遍）

把仓库复制到一个干净目录（不带 `node_modules`），严格按 README 的步骤走一遍：
`doctor` → `import` → `stats` → `serve` → 网页登录 → 检索 → 媒体（原图/Range/缩略图/缺失）
→ 导出（json/txt）→ 备份 → 恢复演练 → `verify` → `logs`，再补一次 systemd unit 校验。
功能链路全部可用且结果与文档一致，但抓到 **3 个静态检查与单元测试都发现不了的缺陷**：

| # | 缺陷 | 真实后果 | 修复 | 新增护栏 |
| --- | --- | --- | --- | --- |
| 14 | `deploy/qq-archive.service` 的 `StartLimitIntervalSec` / `StartLimitBurst` 写在 `[Service]` 段；`deploy/qq-archive-collect.service` 则完全没有这两个键 | `systemd-analyze verify` 只给 warning、不报错，于是「崩溃 5 次就停止」的保护**实际不存在**；采集端是 `Restart=always`，配置错误会每 10 秒无限重启 | 两个键移入 `[Unit]` 段，采集端补齐 | `tests/hardening.test.ts`：解析 INI，断言两个键只出现在 `[Unit]`；并实跑 `systemd-analyze verify`（现在 0 warning） |
| 15 | 缩略图链路是**死代码**：`MediaArchiver.ensureThumb()`（`packages/import/src/media.ts`）与 `db.setMediaThumb()`（`packages/db/src/index.ts`）在 `packages/`、`apps/` 里**零调用** | `media.thumb_path` 恒为 NULL → `GET /api/media/:id/thumb` 恒 404，而网页对每个 present 的图片/视频都会先请求它再回退原图：README 里写的「缩略图」等于没有 | 在唯一汇合点 `commit()` 里生成缩略图，并把 `thumbRel` 写进 `MediaInput.thumbPath`（`db.upsertMedia` 早已支持该字段）→ import 与 collect 两条链路同时生效；`ensureThumb` 形参收窄为 `ThumbSource`，ffmpeg 可用性探测结果缓存一次 | `tests/media.test.ts`：用**假 ffmpeg 脚本**（不依赖本机是否装 ffmpeg）断言 `archive()` 必产出 `thumbPath` 且文件真的落盘，`file` 类型不得凭空产出 |
| 16 | `tests/fixtures/generate.ts` 直接取 `process.argv[2]` 当输出目录 | `generate.ts --help` 会在当前目录创建出一个名为 `--help` 的目录（本次实测 328 KB、含整套 fixtures） | 显式处理 `--help`/`-h`（退出 0）；未知 `-` 选项报错退出 2；只有位置参数才是输出目录（并删除已产生的 `--help/`） | `tests/hardening.test.ts`：在临时 cwd 里跑 `--help` 与 `--bogus-dir`，断言退出码与「不留任何文件」 |
| 17 | `packages/collect/src/forward.ts` 的 `walkForward()` 丢弃了子层返回的 `truncated`，只有顶层自己置位 | 深层被 `maxDepth` 截断时，顶层 `res.forward.truncated` 是 `undefined`，而 runner 只看顶层决定是否告警 → **静默少存**（用户以为转发已完整归档） | `const child = await walkForward(...); item.forward = child; if (child.truncated) truncated = true;`（`forward.ts:159-167`） | `tests/forward.test.ts`：三层嵌套 + `maxDepth=2` 时断言顶层 `truncated === true` |
| 18 | `packages/import/src/media.ts` 续传在中断时用 `out.destroy()` 丢弃写缓冲 | `.part` 变成 **0 字节** → `readResumeState()` 因 `size>0` 不成立而拒绝复用 → **续传完全不触发**（症状：`Range`/`If-Range` 断言为 undefined、416 只发 1 次请求） | 改为优雅 `out.end()` 并等 `'close'` 事件确保落盘（`media.ts:593-604`） | `tests/media.test.ts` 9 个续传用例（含 206 追加后 sha256 与一次下完一致） |
| 19 | `OneBotCollector.fetchForward()` 只读 `node.nickname/name/card`，而真机 NapCat 把发送者放在 `node.sender = {user_id,nickname,card}` 里 | 真实合并转发里**每一条子消息的发送者昵称恒为 `undefined`**，界面上只能显示 uin | 增加 `asRecord(node.sender)` 回退，顺序与消息主路径一致（`card` → `nickname`）（`onebot.ts:364-372`） | `tests/forward.test.ts`：用**真机抓到的原始 JSON 形状**做回归断言 |
| 20 | `deploy/windows/check-syntax.mjs` 的 `scanPowerShell()` 逐字符 push 且从不 push 换行，括号又不进 `paramsText` | `/(^\|\s)param\s*\(/` 永远匹配不到（`#>` 与 `param(` 被拼成 `#>param(`）→ **5 个脚本全部误报「未找到 param( 声明」**，检查器本身失效 | 每行扫描结束补 `codeChars.push('\n')`；判据放宽为 `/(^|[^\w$])param\b/`（排除 `$param` 变量名）；`paramsText` 仍用空串连接 | 检查器自检：5 个脚本 × 14 项 + README 10 章节 = **80 项 0 失败** |
| 21 | `deploy/windows/` 的 5 个 `.ps1` **全部没有 UTF-8 BOM** | Windows PowerShell 5.1 把无 BOM 的 UTF-8 按系统 ANSI 代码页解码 → 中文注释/字符串乱码，严重时引号被拆开直接**语法报错** | 5 个文件全部补 BOM（`EF BB BF`），并在检查器里加 BOM 断言 + 幂等的 `--fix-bom` | `check-syntax.mjs` 的 BOM 检查项；实跑 `--fix-bom` 两次，第二次报「新增 0 个」 |
| 22 | `packages/stt/src/whisper.ts` 的 `NON_SPEECH` 正则要求占位符紧跟括号，不允许多余空白 | whisper.cpp 实际输出的 `[ Silence ]`（带空格）**匹配不上** → 静音被当成正文写入 `media_transcripts`，`segments` 也不归零 | 正则改为 `/^[[(]\s*(?:...)\s*[)\]]$/i`（`whisper.ts:156`） | `tests/stt.test.ts`：断言 `[ Silence ]` / `(music)` / `[BLANK_AUDIO]` 全部归一成空文本 |
| 23 | `packages/import/src/importer.ts` 的 `DetectedFormat` 联合体与 `DETECTED_FORMATS` 没有加 `'html'`，而 `html.ts` 用 `'html' as DetectedFormat` 断言绕过 | `listImporters()` 报出 html，但 **`--format html` 与自动识别的 HTML 都被 `resolveImportFormat()` 拒绝**（`BAD_REQUEST 未知导入格式：html`），对外不自洽 | 联合体与白名单各加一行 `'html'`；`tests/import.test.ts` 的导入器数断言 4 → 5 | `tests/import.test.ts` + `tests/html-import.test.ts`（9 用例） |

修复后复测（**当时**的快照）：`npx tsc --noEmit` **0 错误**；`node --test "tests/**/*.test.ts"` **175 pass / 0 fail**（169 → 175）；
> 注：这是该次修复时的历史数字。**当前**全量为 **240 pass / 0 fail**，见第 1 节。
干净副本里 `import tests/.fixtures/group-export.json`（244 条入库 / 15 次媒体归档）后实测：
3 个 `present` 图片**全部**写入 `media.thumb_path` 且缩略图文件已落盘；`GET /api/media/:id/thumb`
对它们返回 **200 `image/jpeg`**，字节与磁盘缩略图**逐字节一致**；`file` 类型、`missing` 记录和
无法解码的合成 mp4 保持 `NULL` 并返回 404（网页按既有逻辑回退原图）；未认证仍是 401。

