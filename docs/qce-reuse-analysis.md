# QCE 复用性分析报告

> **分析对象**：`/home/emo/code/qq-chat-exporter`（下称 QCE，shuakami/qq-chat-exporter，GPL-3.0）
> **本仓现状基线**：`/home/emo/code/QQ`（下称「本仓」）
> **方法**：QCE 与 NapCat 插件全部**只读**打开核实；本报告所有行号均为本轮实际打开文件确认。凡引用第三方侦察（`/tmp/qce_media_findings.md`）之处已显式标注。
> **核实日期**：2026-10-13
> **本文档是本仓唯一被创建/修改的文件。**

---

## 0. 结论速览

1. **QCE 本身没有可"移植"的独立价值**：它的采集能力全部寄生在 NapCat 上（一个注入 NapCat 进程的 Node 插件 + 一个 Rust bridge），不引 NapCat 就一行都跑不起来。"复用 QCE"这个说法必须拆开。
2. **真正值得复用/已经复用的是两件与 QCE 代码无关的东西**：
   - **A. NapCat WebUI 的 HTTP 契约**（登录/扫码/快速登录）——这是 NapCat 的接口事实，QCE 只是众多调用者之一；
   - **B. 基于 `msgSeq` 的群消息缺口检测与有界补拉算法**（`sequence_integrity.rs`）——这是 QCE 的**原创设计**，也是全仓库对「防丢失」最有价值的一份东西。因有原创性，**只能借鉴思路、不能抄代码**。
3. **许可边界是干净的，而且本仓早已自己写下了这条结论**：QCE 是 GPL-3.0，NapCat 是自定义「禁商用/禁发布修改版」许可。本仓 `packages/collect/src/napcat-webui.ts:1-30` 的文件头注释已逐字记录了「按公开 HTTP 接口契约独立重写、不复制不链接、接口契约属于事实性接口信息」这一判断。
4. **本报告最重要的发现（与最初预期相反）**：**NapCat 扫码登录的后端早已完整实现并有测试**——`packages/collect/src/napcat-webui.ts` + 服务端 4 条 `/api/napcat/*` 路由 + `tests/napcat.test.ts`（18 用例）+ `packages/qr/` 及其 `tests/qr.test.ts`（13 用例）。**当时缺的不是后端，而是用户能碰到的入口**（前端零接线、CLI 无子命令、示例配置无该块、文档未提）。
   > **后续更新（本报告完成后已全部补齐）**：`web/` 已加「QQ 登录」页、CLI 已加 `qq-archive login`（终端直接渲染二维码）、`config.example.json` 已有 `collector.napcat` 块、README/ARCHITECTURE/FINAL-REPORT/本报告均已记录；并补了 `tests/napcat-login-e2e.test.ts`（7 用例：真子进程 CLI + 真 HTTP + 假 NapCat WebUI）与 `tests/napcat-routes.test.ts`（9 用例：四条路由的 HTTP 契约，含「二维码只下发 PNG、响应体不含 URL 明文」的逐像素证明，以及错误映射回归）。全仓 **169 用例全绿、tsc 0 错误**。上表中受影响的行已就地标注为 ✅。
5. **本仓功能完备度上已部分超过 QCE**：二维码字段兼容 5 个（QCE 4 个）、凭据/二维码 URL 有"永不入日志"的硬约定与专门测试、`quick-login` 的 uin 有格式校验。逐项对照见 8.4。

---

## 1. QCE 是什么：许可与仓库构成

`LICENSE` 首行为 `GNU GENERAL PUBLIC LICENSE` / `Version 3, 29 June 2007`（`qq-chat-exporter/LICENSE:1-2`）→ **GPL-3.0**。

仓库由六个身份不同的部件组成（许可同源 GPL-3.0，但**运行形态与可复用性完全不同**）：

| 部件 | 目录 | 身份证据 | 形态 | 对本仓的意义 |
| --- | --- | --- | --- | --- |
| Rust 核心 | `qq-chat-export-core/` | `Cargo.toml:name = "qce-exporter"` | 纯 Rust 逻辑库 | ✗ 不可用（GPL 传染 + 跑不起来） |
| Rust 服务端 | `qq-chat-export-server/` | `Cargo.toml:name = "qce-server"` | HTTP/WebUI 服务 | ⚠ 仅作**思路来源**（第 4、6 节） |
| NapCat 插件 | `plugins/qq-chat-exporter/` | `package.json: "name": "qq-chat-exporter"`, `"version": "5.5.80"` | 注入 NapCat 的 Node `.mjs` | ✗ 不可用（必须跑在 NapCat 进程内） |
| Tauri 安装器 | `installer/` | `src-tauri/tauri.conf.json:` `"productName": "QQChatExporter"`, `"version": "6.0.0"`, `"identifier": "wiki.sdjz.qce.installer"` | Windows 安装器 | ★ **NapCat WebUI 契约的样例调用者**（第 3 节） |
| 查看器 | `qce-viewer/`、`qce-chunked-viewer/`、`qce-v4-tool/` | `qce-v4-tool/package.json: "name": "qq-chat-exporter-v4-ui"` | 前端 | ✗ 仅作 UI 参考 |

---

## 2. 事实：QCE 自己不实现 QQ 登录

安装器源码文件头自述（**原文引用**，`installer/src-tauri/src/napcat.rs:1-9`）：

> `//! ... NapCat's WebUI REST API ... so the first API call probes ports 6099-6120 to find the live instance.`

即：**「扫码登录」这个功能，QCE 一个字节的 QQ 协议都没写**。它是把 NapCat 自带的无头 QQ（Shell）拉起来，再把 NapCat WebUI 的 REST 接口当"遥控器"，让用户用手机 QQ 扫 NapCat 生成的二维码。

这直接决定了复用对象：**不是 QCE 的登录实现（不存在），而是 NapCat WebUI 的契约（QCE 只是调用者）**。

### 2.1 三个端口的分工（最容易混淆的地方）

| 端口 | 常量 / 默认值 | 归属 | 证据 |
| --- | --- | --- | --- |
| **6099** | `NAPCAT_WEBUI_PORT: u16 = 6099` | **NapCat WebUI**（登录/扫码在这里） | `installer/src-tauri/src/util.rs:6` |
| **40653** | `QCE_PORT: u16 = 40653` | QCE 自己的 HTTP 服务/WebUI | `installer/src-tauri/src/util.rs:8`；`plugins/qq-chat-exporter/runtime/rustBridge.mjs:12`（`API_PORT = Number(process.env.QCE_SERVER_PORT \|\| 40653)`） |
| **40654** | `DEFAULT_BRIDGE_PORT = 40654` | **插件 bridge**（Rust ↔ NapCat JS 的 RPC） | `plugins/qq-chat-exporter/runtime/rustBridge.mjs:11` |

---

## 3. 复用物 A：NapCat WebUI HTTP 契约

以下全部由 `installer/src-tauri/src/napcat.rs` 逐行核实。

### 3.1 认证流程

| 步骤 | 内容 | 证据 |
| --- | --- | --- |
| 1. 取 token | 读 NapCat 安装目录下 `config/webui.json` 的 `token` 字段 | `napcat.rs:148-155` |
| 2. 算密码哈希 | `sha256(token + ".napcat")` 的**小写 hex** | `napcat.rs:134-146`（`hasher.update(b".napcat")` 在 `:140`） |
| 3. 登录 | `POST /api/auth/login`，body `{"hash": "<hex>"}` | `napcat.rs:160` |
| 4. 取凭据 | 响应 `data.Credential`（代码兼容 `/data/credential`） | `napcat.rs:166` |
| 5. 后续鉴权 | 每个请求带头 `Authorization: Bearer <Credential>` | `napcat.rs:280-281` |
| 6. 失效重认证 | `unauthorized && !retried` 或连接类错误 → 作废凭据、重新认证**一次**，置 `retried = true` | `napcat.rs:305-311`、`:322` |

### 3.2 登录 / 扫码端点

| 用途 | 方法与路径 | 请求 | 响应取值（**按序回退**） | 证据 |
| --- | --- | --- | --- | --- |
| 扫码二维码 | `POST /api/QQLogin/GetQQLoginQrcode` | `{}` | `data.qrcode` → `qrcodeurl` → `qrcodeUrl` → `url` | `napcat.rs:553`、`:559` |
| 登录状态 | `POST /api/QQLogin/CheckLoginStatus` | `{}` | 登录态 `data.isLogin`（回退 `online`，`:433`、`:586`）；账号 `data.uin`（回退 `qq`、`account`）；二维码 `data.qrcodeurl` → `qrcodeUrl` → `qrcode` → `url`（`:570`） | `napcat.rs:427`、`:433`、`:570`、`:586` |
| 快速登录列表（新） | `GET /api/QQLogin/GetQuickLoginListNew` | — | `data` 为数组 | `napcat.rs:366` |
| 快速登录列表（旧） | `GET /api/QQLogin/GetQuickLoginList` | — | 元素**可能是裸 uin 字符串，也可能是对象** | `napcat.rs:368` |
| 执行快速登录 | `POST /api/QQLogin/SetQuickLogin` | `{"uin": ...}` | `code == 0` 视为成功 | `napcat.rs:450`、`:475` |

### 3.3 实现要点（比端点清单更重要）

- **端口会自增，必须探测**：`for port in NAPCAT_WEBUI_PORT..NAPCAT_WEBUI_PORT + 20`（`napcat.rs:226`），即 **6099–6118**，并缓存"上次成功的端口"以加速后续（`napcat.rs:216-241`）。
- **凭据/端口缓存可被作废**：`napcat.rs:124` 注释说明，丢掉缓存后下一次调用会**重新探测端口**。
- **快速登录列表新接口的回退条件不是"报错"**：`Ok(v)` 且 `v["data"]` 非 null 才用新接口，否则（含"成功但 `data` 为 null"）退回旧接口（`napcat.rs:366-368`）。
- **`SetQuickLogin` 有两个调用点**（`:450`、`:475`），服务于"自动选号"和"用户点选"两条路径。

### 3.4 `config/webui.json` 的真实字段（NapCat 侧配置，非 QCE 侧）

QCE 安装器**写**这个文件（`installer/src-tauri/src/install.rs:463-478`）：

```json
{ "host": "127.0.0.1", "port": 6099, "token": "<16位随机hex>",
  "loginRate": 10, "autoLoginAccount": "", "disableWebUI": false }
```

- token **优先复用已有安装的 token**（`install.rs:460-466`），理由是"NapCat 在启动时缓存 token，上一会话残留的运行实例会拒绝新生成的 token"（`install.rs:460-462` 注释）——**部署期踩过的真实坑**。
- token 由 `util::random_token(16)` 生成，其注释明写 `// Not cryptographically strong`，理由是"只守一个安装器自己拉起的 loopback WebUI"（`installer/src-tauri/src/util.rs` 内 `random_token`）。

---

## 4. 复用物 B：基于 `msgSeq` 的缺口检测与有界补拉

QCE 全仓库**原创性最高**、对「防丢失」价值最大的一份设计，源码 `qq-chat-export-server/src/fetcher/sequence_integrity.rs`。

### 4.1 配置默认值（`SequenceRepairConfig`）

| 字段 | 默认值 | 语义 | 证据 |
| --- | --- | --- | --- |
| `max_delta` | **5** | `msgSeq` 差值 > 5 才算"大缺口" | `sequence_integrity.rs:19` |
| `chunk_size` | **100** | 补拉分片大小 | `:20` |
| `round_budget` | **2000** | 单轮补拉预算 | `:21` |
| `total_budget` | **6000** | 全程补拉预算 | `:22` |
| `max_rounds` | **3** | 最多补拉轮数 | `:23` |

`SeqGap` = `{ lower, upper, missing_positions }`（`:29-32`）。

### 4.2 算法实际是**四层**，不是三段

| 层 | 行为 | 证据 |
| --- | --- | --- |
| L0 检测 | `detect_large_seq_gaps(messages, max_delta)`：`(delta > max_delta).then_some(SeqGap { .. })`，缺口内位置数为 `delta - 1` | `:44-63`，判据在 `:57` |
| L1 主拉 | `while rounds < config.max_rounds` 内按缺口调 `get_msgs_by_seq_range(peer, lower, anchor)` | `:83`、`:116` |
| L2 主拉回退 | **仅当 L1 返回空**时，改用 `get_msgs_by_seq_and_count(peer, anchor, count)` | `:124` |
| L3 复核 | 每轮**无条件**再跑 `reprobe_with_message_history(...)` → 内部 `get_msg_history(peer, anchor_id, count)` | `:141`、`:170`、`:186` |
| 二层兜底（另一文件） | 上述方法在 `client.rs` 层还有 `MsgService.*` → `MsgApi.*` 的回退（如 `get_msg_history` 退 `MsgApi.getMsgHistory`） | `qq-chat-export-server/src/napcat/client.rs:486` 上下文 |

> 即 **L2 是"空即回退"，L3 是"每轮都做"**，二者不属于同一条"都失败才用"的链。

### 4.3 中止规则（最值得借鉴的一条设计）

```rust
if current_missing >= previous_missing {
    return Err(FetchError::SequenceRepairNoProgress { .. });
}
```
`sequence_integrity.rs:154-155`

三个关键点：
1. 比较的是 **`missing_positions` 的计数**，不是"缺口个数"；
2. 判据是 **`>=`**（**没有严格下降**即中止），比"没有下降"更严格；
3. 发生在**一轮补拉完成后**，不是"立刻"。

### 4.4 预算耗尽 / 缺口未消解：**三个**变体

| 变体 | 触发点 | 错误串 |
| --- | --- | --- |
| `SequenceRepairNoProgress` | `sequence_integrity.rs:155` | `MESSAGE_SEQUENCE_REPAIR_NO_PROGRESS` |
| `SequenceRepairBudgetExhausted` | `:95`（预算用尽） | `MESSAGE_SEQUENCE_REPAIR_BUDGET_EXHAUSTED` |
| `SequenceGapsUnresolved` | `:164`（轮数耗尽仍有缺口） | `MESSAGE_SEQUENCE_GAPS_UNRESOLVED` |

（三者在 `qq-chat-export-server/src/fetcher/batch_fetcher.rs:199-227` 定义。）

**设计意图**：三种都是**显式失败**，绝不"补不到就算完整"。这与本仓 `docs/acceptance.md:282`、`docs/FINAL-REPORT.md` 3.3 节第 5 条「腾讯服务端完整性无法保证」的立场一致——**补拉失败必须是可上报状态，而不是静默吞掉**。

### 4.5 与本仓现状的关系

本仓 `packages/collect/src/runner.ts` 已有 **`cursorTs` / `cursorSeq` 断点续传**（`:310`、`:330-331`、`:441-447`），但它只是"记到哪儿了"，**没有任何缺口检测**：全仓 `packages/collect` 与 `packages/db` 内 **`msgSeq` / `gap` / `缺口` / `sequence` 零命中**。

⇒ 第 4 节是**唯一一项本仓真正缺失、且值得补强的能力**，且必须**重写**（原作 GPL-3.0 + 原创算法，见第 7 节）。

---

## 5. 复用物 C（可选，本仓**不需要**）：插件 bridge RPC 契约

QCE 的 Rust 服务端不直接和 QQ 说话，而是把请求发到插件起的 bridge（`napcat/client.rs:32` 注释 `endpoint 形如 http://127.0.0.1:40654`；`:39` 拼成 `{endpoint}/rpc`）。

| 项 | 值 | 证据 |
| --- | --- | --- |
| 监听 | `127.0.0.1:40654`（可用 `QCE_BRIDGE_PORT` 覆盖，非法值直接抛错） | `rustBridge.mjs:10-11`、`:14-21` |
| 启动方 | 插件 `ApiLauncher.startApiServer()` → `startRustApiServer(...)` | `ApiLauncher.mjs:4`、`:31`、`:37`；`rustBridge.mjs:453` |
| body 上限 | `64 * 1024 * 1024`（64 MiB） | `rustBridge.mjs:9`、`:317` |
| 特例方法 | `Core.selfInfo`（`:330`）、`MsgApi.getMsgsBySeqRange`（`:332`）、`PacketApi.getGroupFileUrl`（`:349`） | 同上 |
| 通用派发 | `String(method).split('.', 2)` → `core.apis?.[apiName]?.[functionName]` | `rustBridge.mjs:340-344`、`:359-363` |
| 采集类方法名 | `FileApi.downloadMedia`（`client.rs:309`）、`FileApi.getPttUrl`（`client.rs:331`，**无调用者的死代码**）、`MsgApi.getMsgsBySeqAndCount`（`client.rs:236-239`） | 同上 |

**本仓不需要它的理由**：bridge 的意义是让"想直连 QQ 的第三方程序"复用 NapCat 能力。本仓已选定 **OneBot v11 HTTP** 作为唯一采集边界（`docs/ARCHITECTURE.md:25-40`），而 OneBot 本身就是对**同一批 `MsgApi`/`FileApi` 能力**的官方暴露面。绕到 bridge 只会：① 引入一个必须跑在 NapCat 进程内的 Node 插件；② 使用**未文档化、随版本变化**的私有方法名；③ 触碰 NapCat「禁止发布修改版」的边界。

⇒ **只作为"字段语义对照表"参考，不实现。**

---

## 6. QCE 媒体链路的可借鉴点

> 素材来自前序只读侦察报告 `/tmp/qce_media_findings.md`（含 file:line 证据）；**本轮未逐行复核**，故仅列模式级结论，标注为「二手证据」。

| 可借鉴的模式 | 说明 | 许可判断 |
| --- | --- | --- |
| **本地优先于 RPC** | 先查本地缓存文件（大小匹配即返回，0 次 RPC），再试 NTQQ 本地磁盘，最后才走 RPC 下载 | 模式无版权，可用 |
| **失败显式落库** | `status=failed\|skipped`、`lastError`、`downloadAttempts` 每次重试都持久化；批次摘要给 `failed_samples ≤ 5` | 模式无版权，可用 |
| **退避与重试上限** | `max_retries=5`；超时类错误上限 `MAX_TIMEOUT_ATTEMPTS=2`；退避 `1000<<(n-1)` 封顶 10s → 1/2/4/8/10s | 常量数值本身非表达，可复用 |
| **可重试 / 不可重试分类** | 11 条可重试子串 / 10 条不可重试子串匹配 | 模式可用，具体串需自研 |
| **魔数真值校正后缀** | 下载后按 16 字节魔数判定真实格式（SILK_V3/AMR/WAVE/MP3/Ogg） | 模式可用 |
| **gif↔png 备用对** | 表情主 URL 失败时用扩展名互换的 `alternate_url` | 模式可用 |
| **单资源互斥槽** | 并发下载信号量默认 8；permit 在退避前释放 | 模式可用 |
| **QCE 没有：URL 改写** | 无 `rkey` 处理、无 `-100` 前缀、无 host 替换、无 `https→http` | ⇒ 本仓也无需自研 rkey 逻辑，交给 NapCat/OneBot |
| **QCE 没有：限速器** | 只有 albums/files 路由里 100/200/500 ms 的 `sleep`，**无 per-host / 全局 rate limiter** | 本仓应自行补上（QCE 在这方面是反例） |

⚠ **不要借鉴的一条**：QCE 的媒体完整性**只校验文件大小**（`verify_md5=false`），对图片/视频/文件**不做 content-type 或魔数校验**（魔数只用于修正扩展名，不用于拒绝）。本仓的媒体归档已有 sha256 路径，应保持"内容哈希为准"。

---

## 7. 许可边界（核心结论）

| 复用对象 | 归属与许可 | 我们的做法 | 合规判断 |
| --- | --- | --- | --- |
| QCE 源码（Rust/Node/前端） | **GPL-3.0** | **不复制任何一行、不链接、不修改、不分发其产物** | ✅ 未接触实体代码 |
| QCE 的导出 JSON 数据结构 | 数据格式 | 已实现 `qce-json` / `qce-jsonl` / `qce-txt` 导入器（`packages/import/src/importers/`） | ✅ 接口/数据结构的兼容实现不构成衍生作品 |
| **NapCat WebUI HTTP 契约**（第 3 节） | NapCat 的**接口事实** | **独立进程按契约重写客户端**（已完成，见 8.2） | ✅ 接口契约属于事实性接口信息 |
| **`sequence_integrity.rs` 的补拉算法** | QCE **原创设计**，GPL-3.0 | **只借鉴思路（缺口检测 + 有界补拉 + NoProgress 中止 + 显式失败），代码全部自研** | ⚠ **必须重写**。思路不受版权保护，但实现是 GPL 表达，抄写即传染 |
| NapCatQQ 本体 | 自定义许可：**禁商用、禁发布修改版**（非 OSI 开源） | 仅通过网络 HTTP 调用其接口；不分发、不修改、不打包 | ✅ `docs/FINAL-REPORT.md` 第四节已声明 |
| Lagrange.Core | **无 LICENSE 文件**（默认保留所有权利） | 未使用 | ✅ 未接触 |
| QQNT_Export / QQ-History-Backup | GPL-3.0 / MIT | 未使用（需已解密本地库 / Root+Frida） | ✅ 未接触 |

### 7.1 这份结论**本仓代码里已经写过一遍**

`packages/collect/src/napcat-webui.ts:1-30` 的文件头注释已逐字记录同一判断，**原文引用**：

> ## 许可与独立性
> 本文件是**按公开的 HTTP 接口契约独立重写**的实现，不含任何第三方代码：
> - 参考对象 qq-chat-exporter 是 **GPL-3.0**，NapCat 是自定义「禁商用 / 禁发布修改版」许可；
> - 因此**不复制代码、不链接**，只依据接口契约（请求路径、请求体字段、响应字段）独立实现；
> - HTTP 接口契约属于事实性接口信息，独立进程按契约重写不构成衍生作品。
> 这一取舍与本项目「采集端通过 HTTP 接口与 QQ 生态解耦」的整体决策一致。

**⇒ 本报告第 7 节不是新决策，而是对既有决策的核实与追认。** 后续实现者只需遵守三条硬规则：

1. 与 QCE 的关系是**"读它的 HTTP 请求长什么样"**，不是"读它的代码怎么写"。
2. 与 NapCat 的关系是**"作为网络客户端调用公开接口"**，不是"分发/修改/打包它"。
3. 任何从 QCE 借鉴的**算法**，落地时必须能回答："这段代码如果从未存在过 QCE，我会怎么写？"——答不上来就是抄。

---

## 8. 本仓独立实现的真实完成状态

> **本节是本报告的核心**：按任务要求逐项核实并标注状态，**未完成的一律写"未开始"**。

### 8.1 状态总表

| 能力 | 落点 | **实际状态** | 证据 |
| --- | --- | --- | --- |
| NapCat WebUI 客户端（认证/登录/扫码/快登） | `packages/collect/src/napcat-webui.ts` | ✅ **已完成**（445 行），18 个用例 | `packages/collect/src/napcat-webui.ts:1-445`；`tests/napcat.test.ts`（471 行，18 用例）；`packages/collect/src/index.ts:43` 导出 |
| 服务端 NapCat 路由 | `packages/server/src/index.ts:898-998` | ✅ **已完成** 4 条 | `GET /api/napcat/status`（`:901`）、`POST /api/napcat/qrcode`（`:943`）、`GET /api/napcat/accounts`（`:965`）、`POST /api/napcat/quick-login`（`:977`） |
| 二维码编码 + 渲染 | `packages/qr/` | ✅ **已完成、已接线、13 个用例** | `packages/qr/src/encode.ts`（538 行）/`render.ts`（221 行）/`index.ts`；`tests/qr.test.ts`（1181 行，13 用例）；被服务端引用见下 |
| 二维码在服务端的接线 | `packages/server/src/index.ts` | ✅ **已完成** | `:21-22` `import { encodeQr }` / `import { qrToPngDataUrl }`；`:957` `qrToPngDataUrl(encodeQr(qr.url, { ecc: 'M' }), { scale: 6, margin: 4 })` |
| 配置默认值 + 环境变量 + 校验 | `packages/core/src/config.ts` | ✅ **已完成** | `:86` `napcat?: NapCatWebUiConfig`；`:146` 默认 `{ webuiUrl: 'http://127.0.0.1:6099', token: '', probeRange: 20 }`；`:187-189` `QQ_ARCHIVE_NAPCAT_WEBUI_URL` / `QQ_ARCHIVE_NAPCAT_TOKEN`；`:296-300` webuiUrl 必须 http(s)、`probeRange` 0..100 |
| OneBot v11 只读采集 | `packages/collect/src/onebot.ts` | ✅ **已完成** | `:26-38` `READ_ONLY_ACTIONS` 十个只读接口（含 `get_group_msg_history`/`get_friend_msg_history`）；`:84-85` 非白名单直接抛错；`:41` `AUTH_RETCODES = {100,102,103,104,200}` 遇到即不重试 |
| 断点续传游标 | `packages/collect/src/runner.ts` | ✅ **已完成**（只记位置，不做缺口判定） | `:35`、`:48`、`:310`、`:330-331`、`:441-447` |
| QCE 导出格式导入 | `packages/import/` | ✅ **已完成** | `importers/index.ts:8-10` 注册 `QceJsonImporter`/`QceJsonlImporter`/`QceTxtImporter`；`:33-34` 导出 |
| 媒体归档（sha256 / 缺失标记） | `packages/import` + `packages/server/src/media.ts` | ✅ **已完成** | `media.ts:1-8` 路径边界硬规则（路径只能来自 DB 的 `rel_path`/`thumb_path`，`resolve()` 结果必须以 `mediaDir + sep` 开头，再做 realpath 校验） |
| **前端（Web）扫码登录入口** | `web/` | ✅ **已完成**（本报告调查后接线） | `web/app.js` 新增 `viewQqLogin()` 与 `NAV` 项「QQ 登录」：调 `/api/napcat/status` 决定展示引导还是二维码、`POST /api/napcat/qrcode` 用返回的 `png`（data URL）渲染、3 s 轮询登录态、`/api/napcat/accounts` + `/api/napcat/quick-login` 做快捷登录；`web/style.css` 加 `.qr-wrap`/`img.qr`/`.avatar`。**不在 JSON 里取明文二维码 URL** |
| **CLI 扫码 / 登录命令** | `apps/cli` | ✅ **已完成**（本报告调查后新增） | `apps/cli/src/main.ts` 新增 `cmdLogin()`：`--list` / `--uin <账号>` / `--no-wait` / `--timeout <秒>`；二维码用 `qrToTerminal(encodeQr(url, {ecc:'M'}), {margin:2})` 直接画在终端；退出码 2=配置或参数问题、3=连不上/token 不对。11 个子命令 |
| **`config.example.json` 的 napcat 配置块** | `config.example.json` | ✅ **已完成** | `collector.napcat = { webuiUrl, token, probeRange }`，注释明确「这里的 token 取自 NapCat 的 `config/webui.json`，与采集用的 OneBot access token 不是一回事」 |
| **文档记录（扫码登录功能）** | `README.md` / `docs/DEPLOYMENT.md` / `docs/ARCHITECTURE.md` / `docs/FINAL-REPORT.md` | ✅ **已完成** | README 新增「扫码登录 QQ」章节（配置、网页扫码、终端扫码、退出码、真实边界）；ARCHITECTURE 端点表补 4 条 `/api/napcat/*` 与「二维码只以 PNG 下发」的约定；FINAL-REPORT 路由数改为 30、3.1 增列扫码登录 |
| **`msgSeq` 缺口检测与补拉** | `packages/collect` | ❌ **未开始** | `packages/collect` 与 `packages/db` 内 `msgSeq`/`gap`/`缺口`/`sequence` **零命中** |

### 8.2 NapCat WebUI 客户端：实测细节

`packages/collect/src/napcat-webui.ts` 的公开常量与接口：

| 符号 | 值 / 签名 | 行 |
| --- | --- | --- |
| `NAPCAT_DEFAULT_WEBUI_URL` | `'http://127.0.0.1:6099'` | `:28` |
| `NAPCAT_DEFAULT_PROBE_RANGE` | `20` | `:30` |
| `NAPCAT_DEFAULT_TIMEOUT_MS` | `2000` | `:32` |
| `NAPCAT_DEFAULT_CONNECT_TIMEOUT_MS` | `400`（TCP 探测） | `:34` |
| `NAPCAT_PASSWORD_SUFFIX` | `'.napcat'` | `:36` |
| `NAPCAT_QR_FIELDS` | `['qrcode', 'qrcodeurl', 'qrcodeUrl', 'qrCodeUrl', 'url']` | `:38` |
| `napcatWebUiPasswordHash(token: string): string` | `sha256(token + ".napcat")` 小写 hex | `:45-47` |
| `class NapCatWebUi` | `connect()` / `getLoginQrcode()` `:241` / `getLoginStatus()` `:254` / `listQuickLogin()` `:272` / `quickLogin(uin)` `:301` / `reset()` | `:165` |
| `candidateBaseUrls()` | **上次成功的端口排首位**，再 `startPort..startPort + probeRange`，并显式保留 `lastGoodPort === startPort` 的情形 | `:326-334` |
| 认证 | `:340-373`（`Credential` 兼容小写 `credential`，`:357`） | — |

**安全约定（`:14-20` 原文）**：

> - WebUI token 与登录凭据（Credential）**永不写入日志**，也不进错误消息；
> - 二维码 URL 本身就是一份可用于登录的凭据，因此本模块只把它**返回给调用方**，由上层决定如何呈现（服务端以 PNG data URL 下发，绝不放进普通 JSON 字段）。

服务端对应实现（`packages/server/src/index.ts:943-963`）：

```ts
const qr = await client.getLoginQrcode();
// 二维码 URL 本身就是一份登录凭据：只以 PNG 下发，绝不放进 JSON 明文字段，
// 也不写进日志（logger 的脱敏规则同样覆盖 data: base64）。
const png = qrToPngDataUrl(encodeQr(qr.url, { ecc: 'M' }), { scale: 6, margin: 4 });
```

其它服务端细节：未配置 `collector.napcat.token` **不当作故障**，`status` 返回引导文案、写库等操作返回 503 `NAPCAT_UNAVAILABLE`（`:207-217`、`:934-940`）；`quick-login` 对 uin 做 `/^\d{4,12}$/` 校验（`:987`）；"该账号已在登录流程中"作为正常回执返回 200 + `ok:false`（`:993-995`）。

### 8.3 测试覆盖（**已存在，不是"计划中"**）

| 套件 | 规模 | 覆盖要点（用例名摘要） |
| --- | --- | --- |
| `tests/napcat.test.ts` | 471 行 / 18 用例 | 哈希与独立计算的 `sha256("<token>.napcat")` 一致（`:210`）；`connect()` 登录并缓存基址与凭据（`:223`）；默认端口 6099 + 自增探测（`:240`）；无可用端口 → `COLLECTOR_UNAVAILABLE`（`:257`）；token 错 → `UNAUTHORIZED` 且指向配置项（`:279`）；二维码字段名兼容（`:299`、`:308`）；**QR 接口不返回时回退 `CheckLoginStatus`**（`:317`）；`isLogin/uin`（`:326`）；快登列表兼容对象与裸 uin（`:345`）；**新接口 404 退回旧接口**（`:356`）；`code != 0` 必须上报而非渲染成空列表（`:365`）；`data === null` 明确报错（`:380`）；`quickLogin` 成功/已登录两态（`:387`、`:396`）；**凭据失效自动重认证一次**（`:411`）；`reset()` 后重新探测（`:425`）；**token、凭据、二维码 URL 都不写进日志**（`:440`） |
| `tests/qr.test.ts` | 1181 行 / 13 用例 | 容量表与 ISO/IEC 18004 表 7/9 交叉校验（`:554`）；RS 生成多项式（`:663`）；**码字多项式在 α^0..α^(2t−1) 上 syndrome 全零**（`:677`）；8 个掩码的格式信息 BCH 一致性（`:752`）；版本信息/校正图形（`:789`）；数据放置不变式（`:883`）；PNG 结构合法含 CRC（`:926`）；SVG 矩形与深色模块一一对应（`:986`）；终端渲染行列数（`:1039`）；**与 libqrencode 逐模块黄金对比**（`:1098`）；**zbarimg 回环解码等于原文**（`:1153`） |

`tests/qr.test.ts` 兑现了 `packages/qr/src/encode.ts:8-9` docstring 的承诺，并且做得更严：外部工具缺失时 `t.skip()` 而非让套件变红（`tests/qr.test.ts:11-12`、`:1100`、`:1155`）。

### 8.4 与 QCE 的逐项对照（本仓在后端上并不落后）

| 维度 | QCE（`installer/src-tauri/src/napcat.rs`） | 本仓（`packages/collect/src/napcat-webui.ts`） |
| --- | --- | --- |
| 密码哈希 | `sha256(token + ".napcat")` 小写 hex（`:134-146`） | **相同**（`:36`、`:45-47`） |
| 端口探测 | `6099..6099+20`（`:226`） | 起点取自配置 URL，跨度 `probeRange` 默认 20；**额外把上次成功端口排首位**（`:326-334`） |
| 二维码字段兼容 | 4 个（`:559`） | **5 个**，多一个 `qrCodeUrl`（`:38`） |
| 二维码回退 | 无 | **QR 接口不返回时回退 `CheckLoginStatus`**（`:247-251`） |
| 快登列表回退判据 | `Ok` 且 `data` 非 null 才用新接口（`:366-368`） | **仅 HTTP 404/405 才退旧接口**；`data === null` **明确报错**（`:277-295`） |
| 重认证 | 一次（`:305-322`） | 一次（有专门测试 `:411`） |
| token 来源 | 安装器代写 `webui.json` | **配置项 `collector.napcat.token`**（或 `QQ_ARCHIVE_NAPCAT_TOKEN`），需用户自行从 NapCat 的 `webui.json` 抄 |
| 凭据日志安全 | 未见明确约定 | **明文约定 + 专门测试**（`:17-18`、`tests/napcat.test.ts:440`） |
| 二维码呈现 | 交给前端 | 服务端编码为 PNG data URL，**明文 URL 不下发**（`server/index.ts:955-959`） |

### 8.5 已发现的一致性缺陷（真实、可修）

1. **路由数已过时** → ✅ **已修**：`docs/FINAL-REPORT.md` 与 `docs/acceptance.md` 的"25 条"已改为 **30 条**（`packages/server/src/index.ts` 的 `router.add(` 计数，含 4 条 `/api/napcat/*`）。
2. **功能未文档化** → ✅ **已修**：README 已有「扫码登录 QQ」章节，ARCHITECTURE 端点表已补 4 条路由，FINAL-REPORT 3.1「已实现」已列出扫码登录并附测试证据。
3. **示例配置缺块** → ✅ **已修**：`config.example.json` 已补 `collector.napcat` 块与解释注释。
4. **后端无消费者** → ✅ **已修**：`web/app.js` 的「QQ 登录」页真实调用全部 4 条路由，CLI `login` 也用同一客户端。
5. **本仓不是 git 仓库**：`git status` 报 `致命错误：不是 Git 仓库`，`/home/emo/code/QQ/.git` 不存在 ⇒ 以上"已完成"均以文件内容与测试文件为准，**无法用提交历史佐证**。
6. **Probe range 语义差一**：QCE 注释说 "6099-6120" 而代码是 6099–6118（注释与代码不符，`napcat.rs:8` vs `:226`）；本仓用 `probeRange` 显式参数化，**没有这个问题**。

---

## 9. 刻意没有复用什么

| 不复用 | 原因 | 证据 |
| --- | --- | --- |
| 任何 GPL 代码（QCE / QQNT_Export） | 传染性；本仓许可策略是「最大化规避传染与非商业限制」 | `docs/FINAL-REPORT.md` 第四节；`packages/collect/src/napcat-webui.ts:8-11` |
| Docker 镜像 / Dockerfile | 本机无 docker，**不提供未经验证的交付物** | `docs/FINAL-REPORT.md` 3.2 节；`deploy/` 下仅两个 systemd 单元 |
| Root / Frida 取手机端未同步历史 | **数据本身不在任何可访问位置**，不是工程问题 | `docs/acceptance.md:282`；3.2 节 |
| 读取 QQ 本地加密数据库 | 需密钥 + Root/Frida，侵入性高、许可风险大 | `docs/FINAL-REPORT.md` 3.2 节 |
| 自行实现 QQ 协议登录 | 封号风险最高；NapCat/OneBot 已提供只读 HTTP 边界 | `packages/collect/src/napcat-webui.ts:3-5`（"本程序自己**不实现** QQ 登录协议"）；`docs/ARCHITECTURE.md:25-40` |
| QCE 的插件 bridge（复用物 C） | 见第 5 节：私有未文档化方法名 + 触碰 NapCat 修改版禁令 | — |
| QCE 的"只校验大小"的完整性策略 | 本仓已有 sha256 内容哈希路径 | 第 6 节 ⚠ |

---

## 10. 结论

1. **"复用 QCE"这个命题需要修正**：QCE 没有独立的登录实现，也没有可独立运行的采集实现。**能复用的只有两样：NapCat 的 HTTP 契约（事实信息）与 QCE 原创的 `msgSeq` 补拉算法（只可借鉴思路）。**
2. **最值得投入的是 `sequence_integrity.rs` 那套设计**：`max_delta` 大缺口筛选 → `get_msgs_by_seq_range` 主拉 → 空则 `get_msgs_by_seq_and_count` → 每轮 `get_msg_history` 复核 → **`missing_positions` 未严格下降即中止** → 预算/轮数/缺口三类显式失败。它精确命中本仓"防丢失"的核心诉求，而本仓目前**完全没有**对应能力（只有 `cursorSeq` 记录位置）。
3. **许可边界是干净的，而且本仓早已自行记录**：`packages/collect/src/napcat-webui.ts:1-30` 已就"GPL 参考对象 + 自定义许可参考对象 → 按接口契约独立重写"给出结论。**第 7 节是对既有决策的追认，不是新决策。**
4. **⚠ 修正一个容易误判的现状**：NapCat 扫码登录**后端早已做完并且有测试**（客户端 + 4 条路由 + 18 个用例 + QR 模块 13 个用例）。当时真正缺的是**用户入口与文档**：前端零接线、CLI 无命令、示例配置无该块、四份文档未提。
5. **下一步因此不是"实现扫码登录"，而是"把已实现的扫码登录接线并文档化"**——工作量远小于预期。**这一步已完成**（见 8.1 的 ✅ 行与 11.1 的完成标注）。

---

## 11. 对本项目的影响

### 11.1 优先级最高（成本最低、收益最直接）—— ✅ 四项均已完成

1. **前端接线**：在 `web/app.js` 登录页加"+ 扫码登录"入口，调用已有 4 条路由——
   - `GET /api/napcat/status` 决定是否展示入口（`configured:false` 时展示引导文案而不是报错）；
   - `POST /api/napcat/qrcode` 取 `png`（data URL）直接渲染，**不要试图拿明文 URL**（服务端刻意只下发 PNG）；
   - 轮询 `status` 直到 `isLogin:true`；
   - `GET /api/napcat/accounts` + `POST /api/napcat/quick-login` 做快捷登录。
2. **补 `config.example.json` 的 `collector.napcat` 块**（`webuiUrl` / `token` / `probeRange`），并在注释里说清"这里的 token 是 NapCat WebUI token（见 NapCat 的 `config/webui.json`），不是 OneBot access token"——这是最容易搞混的一处。
3. **文档补齐**：README / DEPLOYMENT 增加"扫码登录"章节；`docs/FINAL-REPORT.md:161` 的"25 条路由"改为 30 条，并在 3.1「已实现」清单中加入 NapCat 扫码登录。
4. **CLI**：`qq-archive login` 已实现（`--list` / `--uin` / `--no-wait` / `--timeout`），复用同一客户端，二维码在终端直接渲染；并新增 `tests/napcat-login-e2e.test.ts`（7 用例）用真子进程 + 假 NapCat WebUI 守住退出码与凭据流程。

### 11.2 中期（第 4 节落地）

把 `sequence_integrity.rs` 的**语义**写进本仓采集设计：

- 四个常量（`max_delta=5` / `chunk_size=100` / `round_budget=2000` / `total_budget=6000` / `max_rounds=3`）是否照抄，需按本仓数据量重新论证；
- **"`missing_positions` 未严格下降即中止"这条语义应原样保留**；
- **三类失败必须显式上报**（对应本仓的错误码体系），与 `docs/acceptance.md:282`、`FINAL-REPORT` 3.3 节第 5 条的立场一致：**补拉失败绝不能静默降级为"归档完成"**。

### 11.3 已经在位、无需重复劳动的认知

- **QR 模块不要重写**：`packages/qr/` 已被服务端使用且有 1181 行独立验证测试（含 libqrencode 黄金对比与 zbarimg 回环），是仓内质量最高的模块之一。
- **不要为 NapCat 登录引入任何第三方库**：客户端是零依赖自研，与"生产依赖 0 个"的架构决策一致。
- **不要把 QCE 的 `napcat.rs` 搬过来**：本仓客户端在二维码字段兼容、快登回退判据、凭据日志安全上均**优于** QCE（8.4），移植只会倒退。

### 11.4 未核实 / 待验证清单

| 项 | 状态 |
| --- | --- |
| QCE 媒体链路细节（第 6 节） | **二手证据**（`/tmp/qce_media_findings.md`），本轮未逐行复核 |
| NapCat WebUI 端点的真实响应体 | 仅从 QCE 与本仓的解析代码反推，**未对照 NapCat 官方文档或真实响应验证**（`docs/FINAL-REPORT.md:106` 亦自述无真机） |
| 本仓各"已完成"项的实际测试通过情况 | 本轮**未运行** `pnpm typecheck` / 测试套件，仅依据测试文件存在与文档自述（`docs/FINAL-REPORT.md:161` 称 115 用例 0 失败） |
| `sequence_integrity.rs` 的 `chunk_size` 在补拉循环中的完整用法 | 已确认默认值（`:20`），**未追完其在循环中的实际使用点** |
| `web/` 是否计划以独立文件接入扫码 UI | 无任何迹象；`web/` 仅 `app.js` / `index.html` / `lib.js` / `lib.d.ts` / `style.css` |

---

## 附录 A：与任务描述不符的发现清单

> 任务要求「任何与我描述不符时以你实际核实的为准，并把这个不符写进返回结果」。

| # | 任务描述 | 实际核实结果 |
| --- | --- | --- |
| A1 | 端口探测注释写 "6099-6120" | 注释（`napcat.rs:8`）说 **6099-6120**，代码（`napcat.rs:226`）是 `NAPCAT_WEBUI_PORT..+20` = **6099–6118**。**注释与代码不一致** |
| A2 | `data.{qrcode\|qrcodeurl\|url}` | 还含**驼峰变体 `qrcodeUrl`**；且两端点回退顺序不同：`GetQQLoginQrcode` 为 `[qrcode, qrcodeurl, qrcodeUrl, url]`（`:559`），`CheckLoginStatus` 为 `[qrcodeurl, qrcodeUrl, qrcode, url]`（`:570`） |
| A3 | `data.uin` | 实际为 `str_field(data, &["uin","qq","account"])`，**还接受 `qq` / `account`** |
| A4 | `GetQuickLoginListNew` **失败**退回旧接口 | 回退条件是 `Ok(v)` 且 `v["data"]` **非 null**；"成功但 data 为 null"**也会**退旧接口（`:366-368`） |
| A5 | "三段式：`get_msgs_by_seq_range` → `get_msgs_by_seq_and_count` 回退 → `get_msg_history` 复核" | 结构是**四层**：L1 主拉 → L2 **仅当 L1 返回空**才回退 by_count（`:124`）→ L3 `get_msg_history` 复核**每轮无条件执行**（`:141`）→ 另有 `client.rs` 层 `MsgService.*`→`MsgApi.*` 兜底。**不是"都失败才用"的单一链** |
| A6 | "本轮缺口数没有下降就立刻判定 NoProgress" | 比较的是 **`missing_positions` 计数**（非缺口个数），判据是 **`>=`**（未严格下降即中止，比"没有下降"更严），且发生在**一轮补拉完成后**（`:154-155`） |
| A7 | "预算耗尽/缺口未消解**两类**错误" | 实际是**三个**变体：`SequenceRepairNoProgress` / `SequenceRepairBudgetExhausted` / `SequenceGapsUnresolved`（`batch_fetcher.rs:199-227`） |
| A8 | "QCE 服务端走 bridge `127.0.0.1:40654/rpc`" | 正确，但需注意 **40654 是 bridge（RPC）端口**，QCE 自己的 HTTP 服务是 **40653**；bridge 端口**可被 `QCE_BRIDGE_PORT` 覆盖**，非硬编码（`rustBridge.mjs:14-21`） |
| A9 | bridge 由 `ApiLauncher.mjs` 启动 | 正确，但真正实现在 `runtime/rustBridge.mjs:453` 的 `startRustApiServer`；`ApiLauncher.mjs:37` 只是调用方 |
| A10 | 任务列举 `packages/collect/src/napcat-webui.ts`、`/api/napcat/*`、`packages/qr/` 为待核实项 | **全部存在且已实现**（详见 8.1）。任务列举它们作为"请核实"的例子，核实结果与"未完成"相反——**这是本报告最重要的一条更正** |
| A11 | — | **额外发现**：本仓**不是 git 仓库**（无 `.git`），无法用提交历史佐证任何"已完成"状态 |
| A12 | — | **额外发现**：`FileApi.getPttUrl`（`client.rs:325-331`）是**无调用者的死代码**，QCE 的语音实际走通用 `downloadMedia` |

---

## 附录 B：本轮核实的关键行号清单

**QCE / NapCat 插件**

| 文件 | 行 | 内容 |
| --- | --- | --- |
| `qq-chat-exporter/LICENSE` | 1-2 | GPL-3.0 |
| `installer/src-tauri/src/napcat.rs` | 1-9 | 文件头自述：驱动 NapCat WebUI REST API |
| 同上 | 124 | 丢缓存后重新探测端口 |
| 同上 | 134-146 | `sha256(token + ".napcat")`（`.napcat` 在 `:140`） |
| 同上 | 148-155 | 从 `config/webui.json` 取 token |
| 同上 | 160 / 166 | `POST /api/auth/login` / 取 `/data/Credential` |
| 同上 | 226 | `NAPCAT_WEBUI_PORT..NAPCAT_WEBUI_PORT + 20` |
| 同上 | 280-281 | `Authorization: Bearer` |
| 同上 | 305-322 | unauthorized/连接错误 → 重认证一次 |
| 同上 | 366-368 | `GetQuickLoginListNew` → `GetQuickLoginList` 回退 |
| 同上 | 427 / 433 | `CheckLoginStatus` / `isLogin` |
| 同上 | 450 / 475 | `SetQuickLogin` 两个调用点 |
| 同上 | 553 / 559 / 570 / 586 | `GetQQLoginQrcode` / 两处 qrcode 字段顺序 / isLogin |
| `installer/src-tauri/src/util.rs` | 6 / 8 | `NAPCAT_WEBUI_PORT = 6099` / `QCE_PORT = 40653` |
| `installer/src-tauri/src/install.rs` | 460-466 | token 复用（NapCat 启动缓存） |
| 同上 | 463-478 | 写入 `webui.json` 六字段 |
| `qq-chat-export-server/src/fetcher/sequence_integrity.rs` | 8-13 / 19-23 | `SequenceRepairConfig` / 默认 5·100·2000·6000·3 |
| 同上 | 29-32 / 44-63 | `SeqGap` / `detect_large_seq_gaps`（判据 `:57`） |
| 同上 | 66 / 83 / 95 | `repair_group_message_sequence` / 轮循环 / `BudgetExhausted` |
| 同上 | 116 / 124 / 141 | `get_msgs_by_seq_range` / 空则 `by_seq_and_count` / `reprobe` |
| 同上 | 154-155 / 164 | `current_missing >= previous_missing` → `NoProgress` / `GapsUnresolved` |
| 同上 | 170 / 186 | `reprobe_with_message_history` / `get_msg_history` |
| `qq-chat-export-server/src/fetcher/batch_fetcher.rs` | 199-227 | 三个错误变体与错误串 |
| `qq-chat-export-server/src/napcat/client.rs` | 32 / 39 | bridge endpoint 注释 / `{endpoint}/rpc` |
| 同上 | 236-239 / 309 / 325-331 / 486 上下文 | `MsgApi.getMsgsBySeqAndCount` / `FileApi.downloadMedia` / `get_ptt_url`（死代码） / `MsgService`→`MsgApi` 兜底 |
| `plugins/qq-chat-exporter/runtime/rustBridge.mjs` | 9 / 10 / 11 / 12 | 64 MiB / `127.0.0.1` / `40654` / `API_PORT 40653` |
| 同上 | 14-21 / 301 / 317 | `resolveBridgePort`+`QCE_BRIDGE_PORT` / `createServer` / body 上限 |
| 同上 | 330 / 332 / 349 / 340-363 / 453 | 特例方法与通用派发 / `startRustApiServer` |
| `plugins/qq-chat-exporter/runtime/ApiLauncher.mjs` | 4 / 31 / 37 / 40 | 导入 / `startApiServer` / 调用 / 端口 40653 |
| `plugins/qq-chat-exporter/package.json` | — | `qq-chat-exporter` 5.5.80 |
| `qq-chat-export-core/Cargo.toml` | — | `qce-exporter` |
| `qq-chat-export-server/Cargo.toml` | — | `qce-server` |
| `installer/src-tauri/tauri.conf.json` | — | `QQChatExporter` 6.0.0 / `wiki.sdjz.qce.installer` |
| `qce-v4-tool/package.json` | — | `qq-chat-exporter-v4-ui` |

**本仓 `/home/emo/code/QQ`**

| 文件 | 行 | 内容 |
| --- | --- | --- |
| `packages/collect/src/napcat-webui.ts` | 1-30 | 文件头：许可独立性声明 + 安全约定 |
| 同上 | 28 / 30 / 32 / 34 / 36 / 38 | URL / probeRange 20 / 超时 2000 / 连接超时 400 / `.napcat` / `NAPCAT_QR_FIELDS`（5 个） |
| 同上 | 45-47 / 165 / 241 / 254 / 272 / 301 / 326-334 / 340-373 | 哈希 / class / 四个方法 / 候选基址 / 认证 |
| `packages/collect/src/index.ts` | 43 | 导出 `napcat-webui` |
| `packages/collect/src/onebot.ts` | 26-38 / 41 / 84-85 | 只读白名单 / `AUTH_RETCODES` / 非白名单抛错 |
| `packages/collect/src/runner.ts` | 35 / 48 / 310 / 330-331 / 441-447 | 游标与重试延迟（**无缺口检测**） |
| `packages/server/src/index.ts` | 21-22 / 957 | 引入并调用 `encodeQr` / `qrToPngDataUrl` |
| 同上 | 207-217 | 未配置 token → 引导文案（非故障） |
| 同上 | 901 / 943 / 965 / 977 | 4 条 `/api/napcat/*` 路由 |
| 同上 | 955-959 / 987 / 993-995 | QR 只下发 PNG / uin 校验 / 已登录回执 |
| `packages/core/src/config.ts` | 86 / 146 / 187-189 / 296-300 | `napcat?` 类型 / 默认值 / env / 校验 |
| `packages/qr/src/encode.ts` | 8-9 / 18 / 51 / 74 / 91 / 122 / 133 / 138 / 173 | 导出符号（docstring 承诺已被 `tests/qr.test.ts` 兑现） |
| `packages/qr/src/render.ts` | 63 / 119 / 128 / 181 | `qrToPng` / `qrToPngDataUrl` / `qrToSvg` / `qrToTerminal` |
| `tests/napcat.test.ts` | 210-440 | 18 个用例（详见 8.3） |
| `tests/qr.test.ts` | 554-1155 | 13 个用例，含 `:1098` qrencode 黄金对比、`:1153` zbarimg 回环 |
| `packages/import/src/importers/index.ts` | 8-10 / 33-34 | 三个 QCE 导入器注册与导出 |
| `packages/server/src/media.ts` | 1-8 | 媒体路径边界硬规则 |
| `web/app.js` | 366-368 / 386 / 405-411 | token 登录（**无 napcat/扫码引用**） |
| 同上 | 1441 / 1641 | SSE / 导出 |
| `apps/cli/src/main.ts` | 623-641 | 10 个子命令（无 login/qrcode） |
| `config.example.json` | `collector` | **无 `napcat` 键** |
| `docs/ARCHITECTURE.md` | 25-40 | 技术选型表（Node ≥22.5 / node:sqlite / OneBot v11 HTTP 不注入不 hook / 生产依赖 0） |
| `docs/FINAL-REPORT.md` | 161 | 自述"25 条路由"（**实际 30 条**） |
| 同上 | 144-215 / 第四节 | 3.1 已实现（**未列 NapCat 扫码**）/ 3.2 未实现 / 3.3 限制 / 许可声明 |
| `docs/acceptance.md` | 282 | 手机端未同步历史无法取回 |
| `docs/qq-export-projects-research.md` | 86 / 221-222 | Linux 无头登录互斥 / 离线消息不自动同步 |
| `tsconfig.json` | `include` | `packages/**/*.ts`、`apps/**/*.ts`、`tests/**/*.ts` |
