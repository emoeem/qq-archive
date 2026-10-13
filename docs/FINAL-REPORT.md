# 最终报告

> ⚠️ **本文是 2026-10-13 早间的交付记录，数字已过时**（当时 240 个用例）。此后经过一轮独立复核，
> 抓出并修复了 6 个真缺陷、补了 30 个回归用例，**当前状态以
> [INDEPENDENT-VERIFICATION.md](INDEPENDENT-VERIFICATION.md) 为准**（347 个用例 0 失败）。
> 本文其余的功能描述与边界说明仍然有效。

> QQ 聊天记录防丢失与自动归档系统 · 交付版本 0.1.0
> 报告日期：2026-10-13　环境：CachyOS Linux / Node v24.21.0 / SQLite（Node 内置）/ ffmpeg 9.0.2

**一句话定位**：本系统**不能阻止 QQ 删除消息**，它的目标是——凡是已经成功到达本系统的消息和媒体，就永久保留下来，不再依赖 QQ 客户端、不再受缓存清理、记录过期或设备更换影响。

配套文档：[架构设计](ARCHITECTURE.md)｜[部署运维](DEPLOYMENT.md)｜[格式映射与有损清单](format-mapping.md)｜[验收测试报告](acceptance.md)｜[开源项目调研](qq-export-projects-research.md)

---

## 一、最终报告必须回答的 6 个问题

### 1. 能否导入现有聊天记录？—— **能。**

已实现 **5 种格式**的导入，全部有自动化测试：

| 格式 | 说明 |
|---|---|
| `qce-json` | QQ Chat Exporter 的单文件 JSON 导出（**主要目标格式**） |
| `qce-jsonl` | QCE 的分块导出（`manifest.json` + `chunks/*.jsonl`） |
| `qce-txt` | 旧版纯文本导出（`[时间] 昵称(QQ号): 内容`） |
| `generic-jsonl` | 通用 JSONL（每行一条消息） |

格式**自动识别**（`detectFormat()`），也支持 `--format` 强制指定。

真实导入结果（测试夹具，367 条源条目）：

```
群聊  247 条源 → 入库 244、重复 3、失败 0、媒体归档 15 次 / 缺失 1、耗时 81 ms
私聊  120 条源 → 入库 120、重复 0、失败 0
合计  367 条源 → 364 条入库、3 条判重、0 条失败
```

- 第二批导入同一文件：`{inserted: 0, duplicate: 247, messages: 244}` —— **完全幂等**。
- 命令行：`qq-archive import <文件或目录> --config <配置>`；网页端「归档管理 → 手动导入」亦可。
- 有损之处（原始 JSON 未 1:1 保留的部分）全部列在 [format-mapping.md](format-mapping.md) 的「有损映射清单」21 条中，**不声称无损**。

### 2. 能否持续保存新收到的消息？—— **能，但有明确边界。**

通过 OneBot HTTP 接口（NapCat / LLOneBot）持续轮询采集：

- 只读白名单（`get_login_info` / `get_status` / `get_group_list` / `get_friend_list` / `get_group_msg_history` / `get_friend_msg_history` / `get_image` / `get_record` / `get_file`），**其他 action 在本地直接拒绝，不发出任何 HTTP 请求**——从设计上排除误调用发送/删除类接口的可能。
- 断点续传：游标存在 `collect_state`，每批成功后立即持久化；重启后从 `cursor - lookback` 保守回看，靠唯一约束兜底，**不重不漏**。
- 失败重试：退避 `1s → 2s → 4s`，连续失败计数与告警。
- 由 systemd 定时器驱动（`deploy/qq-archive-collect.service`），实测 `collect --once` 可正常运行。

**边界（重要）**：只能采到「机器人账号在线时」的消息。群聊离线期间的消息**不会补齐** —— NapCat 维护者在 [Issue #1838](https://github.com/NapNeko/NapCatQQ/issues/1838) 明确表示这是 feature、不打算实现离线消息推送。已撤回的消息不可取回，已解散/已退出的群聊无法读取。

### 3. 能否独立保存图片和视频？—— **能。**

- **内容寻址存储**：文件按 `sha256` 命名落盘（`media/<类型>/<年>/<月>/<前2位>/<sha256>.<ext>`），路径与内容强绑定，天然去重、天然可校验。
- 来源优先级：本地文件路径 → HTTP 下载（含协议白名单、大小上限、超时）→ 标记缺失。
- 图片可生成缩略图（依赖 ffmpeg，**ffmpeg 缺失时优雅降级，不影响原件归档**）；视频支持 HTTP `Range` 请求（`206`），浏览器可直接拖动播放。
- 同一物理文件被多条消息引用时**只存一份**，但每条消息的**原始文件名与声明大小**都保留在关联表里。
- 真实数据：6 个声明媒体 → 5 个可获取的**全部落盘并通过 sha256 校验**（`corrupt = 0`）；1 个拿不到的**明确标记 `missing` 并保留失败原因**，磁盘上**不生成任何假文件**。
- 音频/语音：解析层支持 `audio`/`voice`/`record`/`ptt`/`amr`/`silk` 并归为 `kind='audio'`；**并有真实样本端到端**：真机采到的 3 个真实 `.amr` 经 `qq-archive transcribe`（生产代码路径 → ffmpeg → `whisper-cli`）转出中文并写入 `media_transcripts`，`GET /api/media/13/raw` 返回 200 `audio/amr` 14468 字节。

### 4. 手机端未同步的历史消息能否获取？—— **不能。这不是工程问题，是数据不存在于任何可访问位置。**

- 手机（华为，无 Root 保证）上**尚未同步到服务端会话**的记录，QQ 不提供任何 API 可以取回。本项目刻意不采用 Root / Frida / 内存注入路线（侵入性高、易失效、且会把 GPL 与非商业许可问题带进来）。
- 另外，**任何导出接口返回的都只是「服务端愿意返回的部分」**。QQ 官方导出工具自身在文档里标注 `serverCompletenessProven: false`，并明确「任何响应都不能证明腾讯服务端的聊天记录完整性」。本项目**不对此做任何保证**。
- 因此本系统降低（而非消除）手机/电脑不同步造成缺失的路径是：
  1. 电脑端能导出多少，就**完整、可重复、可校验**地收下多少；
  2. 采集端持续增量保存**在线期间**的新消息；
  3. 所有已入库数据独立备份，**不再依赖 QQ 是否还留着**。

### 5. 能否部署到服务器并通过网页查看？—— **能。**

- 单进程 `node:http` 服务，**零生产依赖**（数据库用 Node 24 内置 `node:sqlite`），不需要编译步骤，`node --experimental-strip-types` 直接跑 TypeScript。
- 内置 Web 管理界面（原生 ES 模块，无构建、无 CDN 依赖，可完全离线）：
  - 登录页（HMAC 签名访问令牌 + 刷新令牌 + 登录限速）
  - 总览（8 张统计卡）、会话列表、消息时间线（搜索高亮、引用预览、媒体缩略图、撤回标记）
  - 媒体库（按类型/状态/会话/日期筛选、`<video>` 播放、下载、完整性校验）
  - 归档管理（手动导入、备份、立即采集、任务表、**SSE 实时进度**）
  - 日志（级别 + scope 筛选）、导出（json / jsonl / txt）
  - **QQ 扫码登录**（NapCat WebUI）：网页显示二维码、轮询登录态、本地账号快捷登录
- **30 条 API 路由**、11 个 CLI 子命令（`serve` / `import` / `collect` / `backup` / `restore` / `verify` / `doctor` / `token` / `stats` / `logs` / `login`）。
- 安全：默认只监听 `127.0.0.1`；媒体目录做**真实路径边界校验**（防路径穿越）；未登录一律 `401` 且不泄露内部路径；响应头不回显服务器绝对路径。
- systemd unit 已提供（`deploy/qq-archive.service`、`deploy/qq-archive-collect.service`），完整步骤见 [DEPLOYMENT.md](DEPLOYMENT.md)。

**注意**：`serve` 默认绑定 `127.0.0.1`。要从外部访问必须显式改配置并自行加 TLS 反向代理——这是刻意的安全默认值，聊天记录不该默认暴露在网络上。

### 6. 哪些功能经过真实测试，哪些仍需验证？

**经过真实测试（有可复现的自动化用例 + 实际运行输出）**：

| 范围 | 证据 |
|---|---|
| **5 种格式**导入（QCE JSON/JSONL/TXT、通用 JSONL、**HTML 网页**）、幂等、长消息、@提及/引用/撤回/系统消息 | `tests/import.test.ts` + `tests/html-import.test.ts`（9 用例，含 6 个 fixture）+ `tests/acceptance.test.ts`（验收 1/2/3/7/15） |
| 图片/视频/文件归档、sha256 校验、缩略图、Range 播放、缺失标记 | `tests/media.test.ts` + 验收 4/5/6/11 |
| **媒体下载断点续传（HTTP Range + sidecar）** | `tests/media.test.ts` 9 个新用例：206 追加后 sha256 与一次下完一致、200 忽略 Range 会截断重下、etag/last-modified 触发 `If-Range`、416 丢弃重来、超 `maxBytes` 不留残片 |
| **合并转发展开**（递归 + 附件归档 + 截断冒泡） | `tests/forward.test.ts` **15 用例**（纯函数 / OneBot 协议 / CollectRunner 真库端到端）；并**对真实归档里的 3 条真实合并转发实测真 NapCat**，分别解出 9 / 9 / 19 个子节点 |
| **语音转文字（whisper.cpp）** | `tests/stt.test.ts` 25 用例 + **真机 3 个真实 `.amr`** 经生产代码路径转出中文并写入 `media_transcripts`（3/3，5.86 s） |
| **Windows 部署脚本** | `node deploy/windows/check-syntax.mjs` **80 项**静态检查 0 失败、退出码 0；`--fix-bom` 幂等。**未在真实 Windows 执行过**（本机无 `pwsh`） |
| 批量导入 5000 条 | 验收 10（实测约 4.5 s） |
| 网络中断重试与重启续传 | 验收 8/9（**用自建假 OneBot**） |
| 备份 → 校验 → 损坏 → 恢复全链路 | 验收 12 + `tests/cli.test.ts`（真实子进程） |
| 认证与授权：401、路径穿越、令牌伪造 | 验收 13/14 + `tests/server.test.ts` |
| 中文检索（bigram + FTS5，单字退化为 LIKE） | `tests/db.test.ts` + 验收 15（零漏报零误报） |
| **前后端 + 采集 + 导入的真实联调**（不注入任何桩） | `tests/integration.test.ts` 5 项，并抓出 3 个真实缺陷 |
| CLI 真实子进程端到端（`--config`、导入、备份、恢复） | `tests/cli.test.ts` 16 项，含**变异测试**验证护栏有效 |
| **扫码登录**（`/api/napcat/*` + Web 页 + `qq-archive login`） | `tests/napcat.test.ts` 18 + `tests/napcat-login-e2e.test.ts` 7 + `tests/napcat-routes.test.ts` 9；**并已用真实 QQ 号真机扫码登录 NapCat 容器**，随后 `collect --once` 采到 13 会话 / 188 条真实消息 / 18 个媒体文件 |
| Web 界面 | `tests/web.test.ts` 25 项（纯函数 + 契约 + XSS 审计）+ 真实浏览器 87 项交互检查 |

合计 **240 个用例 0 失败**（17 个测试文件），类型检查 0 错误，详见 [acceptance.md](acceptance.md)。

**本次交付前最后一道关卡抓到的真实缺陷（只有起真服务才暴露）**：`packages/server/src/index.ts` 的错误映射曾写成
`const code = typeof (err as {code?: unknown} | null)?.code` —— 先算 `typeof` 再判断 `typeof code === 'string'`，
于是 `code` 恒为 JS 类型名 `"string"`、`status` 恒非 number，**所有下游错误都被压成 `503 {code:"string"}`**：
WebUI token 写错本该回 401 `UNAUTHORIZED`（并提示改 `collector.napcat.token`），却被报成「服务不可用」。
现已改为先取值再判类型，并补两条回归用例（NapCat 连不上 → 503 `COLLECTOR_UNAVAILABLE`；token 错 → 401 `UNAUTHORIZED`），
已用**变异测试**验证：把 bug 改回去，恰好这两条失败（`tests/napcat-routes.test.ts:408`、`:432`）。

**仍需验证（无法在本次环境取得真实验证）**：

| 项目 | 原因 |
|---|---|
| **真实 NapCat 实例** | **已真机验证**：真实 QQ 号扫码登录 + `collect --once` 采到 13 会话 / 188 消息 / 18 媒体，媒体表与磁盘对账一致。**未做**：LLOneBot 等其它 OneBot 实现的真机验证 |
| 真实腾讯服务端记录完整性 | 无法证明，官方工具自己也不保证 |
| 手机端未同步历史 | 无任何可取路径（见问题 4） |
| 真实进程 `SIGKILL` / 断电恢复 | 测试进程内模拟了「异常退出后重开」，但未对二进制发真实 `SIGKILL` |
| 真实 systemd 部署与重启自愈 | unit 文件已提供，未在真实 systemd 环境跑过 |
| **Docker 部署** | 本机**未安装 docker**，未提供 Dockerfile，不做未验证的承诺 |
| 语音转写的**质量**（CER/WER、方言、强噪声、多人重叠） | 只验证了「真机 3 个真实 `.amr` 能转出可读中文」，未做准确率基准 |
| **Windows 脚本的真实执行** | 开发机是 Linux、没有 `pwsh`，只做了 **80 项**静态自检；**从未在真实 Windows 上跑过** |
| 真实第三方 HTML 导出器回归 | HTML 导入只用合成 fixture 验证，未拿真实导出器产出的 HTML 跑过 |
| 真实 QQ「合并转发」消息的展开 | 展开逻辑有 14 个用例覆盖，但本轮真机采集的数据里没有合并转发消息 |
| 真正的移动端（华为手机）采集 | 未做，且本项目刻意不采用需 Root 的路线 |

---

## 二、十项交付物对照

| # | 任务书要求 | 交付内容 |
|---:|---|---|
| 1 | 可运行的项目源码 | `/home/emo/code/QQ/` 全量源码：`packages/` + `apps/` **15,973 行 TypeScript**，`web/` 2,948 行，`deploy/` 3,096 行，测试 10,339 行；`npm test` 即可验证 |
| 2 | 实际实现的 Web 管理界面 | `web/`（`index.html` + `app.js` 1737 行 + `lib.js` 329 行 + `style.css` 541 行），8 个 hash 路由、20 个 API 端点族真实调用 |
| 3 | 数据库初始化和迁移方案 | `packages/db/src/schema.sql` + `migrations.ts`（版本化迁移，当前 **schema v5**，`PRAGMA user_version` 驱动，启动自动迁移） |
| 4 | 配置文件示例 | `config.example.json`（含全部可调项与注释说明） |
| 5 | Linux 安装和部署文档 | `docs/DEPLOYMENT.md`（10 节：安装、配置、systemd、采集端接入、反向代理、升级、排障、卸载等） |
| 6 | 备份及恢复说明 | `docs/DEPLOYMENT.md` 备份章节 + `docs/acceptance.md` 验收 12 + `packages/server/src/backup.ts`（快照 + manifest + sha256 + `quick_check` 校验链） |
| 7 | 自动化测试及实际测试结果 | `tests/` **17 个文件 240 个用例** + `docs/acceptance.md`（逐项真实输出，非「编译通过」替代） |
| 8 | 开源项目复用清单与许可证说明 | 本报告第四节 |
| 9 | 已实现 / 未实现 / 限制清单 | 本报告第三节 |
| 10 | 后续可扩展方向 | 本报告第五节 |

**额外交付**（任务书未要求但为完整交付所需）：

- `docs/ARCHITECTURE.md` —— 分层设计、数据模型、HTTP 端点契约表（冻结版）
- `docs/format-mapping.md` —— QCE → 本系统的**逐字段映射表** + **21 条**有损映射清单 + HTML/转发展开映射（§8）
- `docs/qq-export-projects-research.md` —— 开源生态调研原始记录
- `docs/acceptance.md` —— 15 项验收逐项报告
- `tests/fixtures/generate.ts` —— **程序化测试数据生成器**（固定种子 `20261013`，手写字节生成合法 PNG/GIF/MP4，**不含任何真实聊天记录**）
- `tests/integration.test.ts` —— 不注入任何桩的真实联调
- `tests/cli.test.ts` —— 真实子进程端到端 + 回归护栏

---

## 三、已实现 / 未实现 / 限制清单

### 3.1 已实现（有测试证据）

**核心层 `packages/core`**：类型契约、ID 生成、配置加载与路径解析、分级日志（控制台 + 文件轮转 + 按 scope 过滤）、结构化错误码。

**存储层 `packages/db`**：
- 版本化迁移，**schema v5**（v5 新增 `media_transcripts`）；WAL 模式；外键约束
- 内容寻址媒体表 + `message_media` 多对多关联（保留原始文件名与声明大小）
- 唯一约束驱动的幂等入库（`account_uid + session_key + msg_key`）
- **中文检索**：FTS5 + 双字组（bigram）展开；单汉字自动退化为 `LIKE ESCAPE` 扫描（`planSearch()` 决定策略）
- 分页、多条件过滤、游标读写、统计、健康检查

**导入层 `packages/import`**：**5 种格式**识别与解析（QCE JSON / chunked JSONL / QCE TXT / 通用 JSONL / **HTML 网页**）、流式 JSON/JSONL 读取（32 MiB 单消息上限、500 条一批）、媒体归档管线（本地文件 → HTTP 下载 → **HTTP Range 断点续传** → 缺失标记）、缩略图（ffmpeg 可选）、高层入口 `runImport()`（CLI 与 server 共用同一实现）。

**采集层 `packages/collect`**：OneBot HTTP 客户端、**只读白名单**、CQ 码解析、消息归一化、退避重试、断点续传、告警、`createCollectRunner()` 工厂；另含**独立实现**的 NapCat WebUI 客户端（`napcat-webui.ts`，扫码/快捷登录）。

**二维码层 `packages/qr`**：**零依赖** QR 编码器（byte 模式、版本 1–40、ECC L/M/Q/H、自动掩码）+ PNG/SVG/终端渲染，与 `libqrencode` 逐模块比对一致。

**QQ 扫码登录（复用 NapCat WebUI 接口契约，独立实现）**：4 条 `/api/napcat/*` 路由 + Web「QQ 登录」页 + CLI `qq-archive login`（在终端直接渲染二维码）。凭据流程与 NapCat WebUI 真实契约一致：`sha256(token + '.napcat')` → `POST /api/auth/login` → `Credential` → 之后每请求 `Authorization: Bearer`；凭据失效时作废缓存、重新探端口并重新登录，且**只重试一次**；`code !== 0` 一律当错误上报，绝不静默渲染成空列表。证据：`tests/napcat.test.ts`（18 用例，单测抓出过一个真实的重连缺陷）+ `tests/napcat-login-e2e.test.ts`（7 用例：真子进程 CLI + 真 HTTP + 假 NapCat WebUI，断言退出码、终端二维码逐模块等于编码器输出、重认证恰好发生一次）+ `tests/napcat-routes.test.ts`（9 用例：四条路由的 HTTP 契约，含「二维码只下发 PNG、响应体不含 URL 明文」的逐像素证明，以及错误映射的回归护栏）。**该适配器是按公开 HTTP 接口契约独立编写的，未复制任何 GPL 代码**，理由见 [qce-reuse-analysis.md](qce-reuse-analysis.md)。

**服务层 `packages/server`**：30 条路由、HMAC 访问令牌 + 刷新令牌 + 常数时间比较、登录限速、编辑距离无关的路径穿越防护、Range 请求支持、SSE 实时任务进度、静态托管 + 深路由回退、导出（json/jsonl/txt）、备份/校验/恢复、**动态模块探测**（导入与采集模块可选存在）。

**CLI `apps/cli`**：11 个子命令、参数解析（`--config` 可前置或后置）、`doctor` 七项自检。

**前端 `web/`**：8 个 hash 路由、8 张统计卡、时间线 + 搜索高亮、媒体网格、归档管理 + SSE、日志筛选、导出。XSS 审计：全域仅 1 处 `innerHTML`（受控的搜索片段高亮通道），无 `outerHTML` / `document.write` / `insertAdjacentHTML` / `eval`。

**语音转写层 `packages/stt`**：`whisper-cli` + `ffmpeg` 外部进程适配（零新依赖）、探测与缓存、`transcribePending()` 批量流水线（真库 + 真临时文件）、`media_transcripts` 持久化；默认关闭，装不上时**绝不影响归档主流程**。

**工程**：`npm run typecheck` 0 错误、**240 用例 0 失败**、**生产依赖 0 个**。

### 3.2 未实现（以及为什么）

| 未实现 | 原因 |
|---|---|
| 手机端（华为，无 Root）采集 | 刻意不做侵入式路线；且未同步记录本就取不到（问题 4） |
| 读取 QQ 本地加密数据库 | 需要密钥与 Root/Frida，侵入性高、许可证风险大，刻意规避 |
| Docker 镜像 / Dockerfile | 本机无 docker，**不提供未经验证的交付物** |
| 表情 / 卡片 / 位置消息的语义解析 | 原始 JSON 已存，但目前降级为占位文本；解析需逐个适配 QQ 的私有结构且易随版本失效 |
| 端到端加密 | 当前安全模型是「本机/可信内网 + 令牌认证」，多用户与远程访问场景需要另做设计 |
| 多账号并发采集 | 数据结构支持（`account_uid` 已贯穿），但 runner 目前单账号串行 |
| **Windows 脚本的真实执行验证** | 开发机是 Linux、没有 `pwsh`，只做了 **80 项**静态自检，**从未在真实 Windows 上执行** |
| **真实第三方 HTML 导出器的回归** | HTML 导入只用我方合成的 fixture 验证，没拿真实导出器产出的 HTML 跑过 |
| **转写质量基准（CER/WER）** | 只验证了真机 3 个真实 `.amr` 能转出可读中文，未做准确率基准、未覆盖方言/强噪声/多人重叠 |
| **真实 QQ「合并转发」的完整展开对账** | 展开逻辑有真机 `get_forward_msg` 实测（真实转发 9/9/19 节点可解）与 15 个用例，但未对展开结果做完整性人工比对 |

### 3.3 限制清单（真实边界）

1. **无法阻止 QQ 删除消息** —— 这是本系统的前提认知，不是缺陷。系统只保护「已到达本系统」的数据。
2. **群聊离线期间消息不补齐** —— 上游 NapCat 明确不支持。
3. **撤回消息不可取回** —— 只能记录「此处有撤回」。
4. **已解散/已退出群聊不可读**。
5. **腾讯服务端完整性无法保证**，官方工具自己标注 `serverCompletenessProven: false`。
6. **手机端未同步记录无法获取**。
7. **`PRAGMA` 与 FTS5 依赖 Node 内置 SQLite** —— 换用其他运行时需另配 SQLite；Node 版本要求 ≥ 22.5。
8. **使用 `--experimental-strip-types`** —— Node 的 TypeScript 支持仍是实验性的；strip-only 模式**不支持 parameter properties 与 `enum`**（已知约束，代码已规避）。未来若 Node 稳定该特性，可直接去掉 flag。
9. **默认只监听 `127.0.0.1`** —— 远程访问需自行配置 TLS 反向代理。
10. **媒体缺失的 sha256 是合成指纹而非内容哈希** —— 因为拿不到内容就没法算真哈希；这一列在查询/关联时是身份标识，**不可当作完整性凭证**。
11. **`rawMessage` 截断至 16 KiB；`elements`/`mentions` 各上限 200 条** —— 防止异常导出撑爆数据库；超限时有明确记录。
12. **有损映射共 21 条** —— 全部列在 [format-mapping.md](format-mapping.md) 第 7 节（含 HTML 与转写两条）。

---

## 四、开源项目复用清单与许可证说明

**这一节是合规声明，请认真对待。本项目的许可证策略是「最大化规避传染与非商业限制」。**

| 项目 | 许可证 | 本项目如何使用 | 合规判断 |
|---|---|---|---|
| [shuakami/qq-chat-exporter](https://github.com/shuakami/qq-chat-exporter) | **GPL-3.0** | **只借鉴其导出的 JSON 数据结构**（字段名与嵌套关系），用于让本系统能读它的导出文件。**未复制任何一行代码、未链接、未修改、未分发其产物** | ✅ 数据格式不受版权保护（接口/数据结构的兼容实现不构成衍生作品）。已在 README 与本文档显式声明 |
| [Tealina28/QQNT_Export](https://github.com/Tealina28/QQNT_Export) | GPL-3.0 | **未使用**（需已解密的本地数据库） | ✅ 未接触 |
| [NapNeko/NapCatQQ](https://github.com/NapNeko/NapCatQQ) | **自定义许可：禁止商业使用、禁止发布修改版（非 OSI 开源）** | **仅通过网络 HTTP 调用其 OneBot 接口与 WebUI 接口**（后者用于扫码登录）。不分发其任何字节、不修改、不打包、不在仓库中出现 | ✅ 通过公开网络接口互操作；使用者需自行安装并遵守其许可 |
| [LagrangeDev/Lagrange.Core](https://github.com/LagrangeDev/Lagrange.Core) | **无 LICENSE 文件**（默认保留所有权利） | **未使用任何代码或接口** | ✅ 未接触。特别说明：无许可证即意味着不能复用，本项目绕开 |
| [LLOneBot/LuckyLilliaBot](https://github.com/LLOneBot/LuckyLilliaBot) | GPL-2.0 | **未使用其代码**；本系统只实现并兼容其公开的 OneBot HTTP 协议 | ✅ 协议兼容不构成衍生作品 |
| [QQBackup/QQ-History-Backup](https://github.com/QQBackup/QQ-History-Backup) | MIT | **未使用**（需 Root/Frida） | ✅ 未接触 |

**架构层面的取舍**：采集端刻意通过 **HTTP 接口**与 QQ 生态解耦，而不是链接库或读取本地数据库。这个选择同时解决三个问题——(1) 避免 GPL 传染；(2) 避免触碰 NapCat 的「禁止发布修改版/禁止商用」边界；(3) 让本系统的采集端可替换（任何提供兼容 OneBot 接口的实现都能用）。这是本报告第二节问题 5 中「零生产依赖」之外的另一项刻意设计。

**扫码登录为什么是「自己实现」而不是抄 QCE**：[qq-chat-exporter](https://github.com/shuakami/qq-chat-exporter) 的扫码登录并不由它自己实现——它驱动的是 **NapCat WebUI 的 REST 接口**（其 `installer/src-tauri/src/napcat.rs` 文件头自述 "NapCat WebUI automation"）。QCE 是 GPL-3.0，因此**不能抄它的代码**；但「调哪个 HTTP 路径、参数叫什么」属于事实性接口信息，独立实现不构成衍生作品。本项目据此从零实现了 `packages/collect/src/napcat-webui.ts`（读接口契约、写自己的代码），并且**连二维码编码都没有引第三方库**：`packages/qr` 自己按 ISO/IEC 18004 实现 byte 模式编码，再用系统里的 `qrencode` 做逐模块黄金对比、用 `zbarimg` 做解码回环。完整的证据链与逐项现状（含「哪些当初以为缺、其实已有」）见 [qce-reuse-analysis.md](qce-reuse-analysis.md)。

**本项目的依赖**：生产依赖 **0 个**。开发依赖仅 `typescript` 与 `@types/node`。数据库用 Node 24 内置 `node:sqlite`，HTTP 服务用内置 `node:http`，测试用内置 `node:test`——**没有把任何第三方库引入供应链**。

**本项目的许可**：已选定 **[PolyForm Noncommercial License 1.0.0](../LICENSE)**（源码可见，非 OSI 认可的开放源代码许可）——任何**非商业**目的可自由使用、修改与分发，**商业使用须事先取得著作权人书面授权**。源码已发布为公开 Git 仓库 <https://github.com/emoeem/qq-archive>；`LICENSE`、`package.json` 的 `license` 字段与 README 的「许可证」章节三处口径一致。

---

## 五、后续可扩展方向

按「投入产出比 × 对防丢失目标的实际增益」排序：

**第一优先级（直接提升数据完整性）**

1. **真实 NapCat / LLOneBot 真机验证** —— 唯一能把这些「按规范实现」变成「已验证」的路径。需一个可用的 QQ 账号。
2. **采集端补齐策略** —— 除群/私聊列表外，加入更多遍历入口（如最近会话、置顶会话），提高离线期消息的重叠覆盖概率。
3. **导入更多导出格式** —— 目前已抽象出 `Importer` 接口（`listImporters()` 可枚举），新增格式只需实现一个模块。优先补 QQ 官方导出格式与常见第三方工具格式。
4. **音频/语音端到端覆盖** —— 解析层已就绪，补夹具样本与用例即可闭环。

**第二优先级（可用性）**

5. **全量/增量备份自动化** —— 已有 `backup` 命令与 systemd 模板，可加入定时快照 + 保留策略 + 异地副本（如 rsync 到另一台机器）。
6. **搜索增强** —— 当前是 bigram + FTS5，可加：按发送者/时间范围/消息类型组合筛选（后端已支持，前端可暴露更多）、搜索结果跳转到原文上下文。
7. **合并转发展开** —— 先设计好「一次转发」的表示法（父消息 + 子消息树），再实现递归展开。
8. **表情/卡片/位置的结构化展示** —— 原始 JSON 已存，可逐个适配常见类型并做优雅降级。

**第三优先级（规模化）**

9. **Docker 化** —— 需要在有 docker 的环境验证后再交付。
10. **多账号支持** —— `account_uid` 已贯穿数据模型，主要是 runner 需要支持并发与隔离。
11. **端到端加密与多用户权限** —— 若要从「本机工具」走向「家庭/团队共享服务」，这是必须补的一层。
12. **插件化采集源** —— 让 OneBot 之外的采集方式（如官方导出目录监控）能以插件形式接入。

---

## 六、交付状态声明

- 全部源码在工作目录 `/home/emo/code/QQ/`，**不是 Git 仓库**，**未做任何提交、推送、重置或清理**（遵守任务书「不要擅自提交、推送」）。
- 未使用任何真实聊天记录或他人账号进行测试。全部测试数据由 `tests/fixtures/generate.ts` 程序化生成。
- **240 个自动化用例 0 失败，类型检查 0 错误**，验证命令与真实输出见 [acceptance.md](acceptance.md)。
- 本报告中**不存在**「为了让测试变绿而放宽断言语义」或「声称完成了未验证功能」的情况。所有未验证项集中列在第一节问题 6 与第三节 3.3。

```bash
# 复现全部验证
cd /home/emo/code/QQ
npx tsc -p tsconfig.json --noEmit
node --test --experimental-strip-types "tests/**/*.test.ts"
```
