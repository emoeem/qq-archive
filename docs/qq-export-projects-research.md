# QQ 聊天记录导出/归档项目调研

检索日期：**2026-10-13**（Asia/Shanghai）。除特别注明外，star / commit / release 数据均来自 GitHub REST API（`api.github.com`）与各仓库 raw 文件，抓取时间同上。
标注「未验证」表示未找到可核实的一手来源，请勿直接采信。

---

## 1. Tealina28/QQNT_Export

| 项 | 值 |
|---|---|
| 仓库 | https://github.com/Tealina28/QQNT_Export |
| 许可证 | **GPL-3.0**（`LICENSE` 文件核实，文件头为 GNU GPL v3；API `spdx_id=GPL-3.0`） |
| Stars / Forks | 76 / 6 |
| 语言 | Python |
| 最新 Release | **v3.3.0，2026-07-12**（另有 v3.2.0 2026-06-21、v3.1.0 2026-06-20） |
| 最近 commit | `main` 分支 API 返回最近一条为 **2025-08-23**（`Merge pull request #21`）；但仓库 `pushed_at=2026-07-17`，两者不一致，**未完全核实**（可能有其他分支/强推历史） |

**定位**：不是采集工具，而是**解析器**。README 开篇即写明「用于读取并导出**解密后的** QQNT 数据库中的聊天记录」，解密需另配 [qqnt_backup](https://github.com/xCipHanD/qqnt_backup)（Android）或 [qq-win-db-key](https://github.com/QQBackup/qq-win-db-key)。

**技术栈 / 运行环境**
- 依赖（`requirements.txt`）：`humanize`、`protobuf==6.31.1`、`SQLAlchemy`、`tqdm`、`jinja2`、`lxml`。
- 代码结构：`db/models.py`（SQLAlchemy 表模型）、`db/man.py`、`element.proto` + `element_pb2.py`（消息 Protobuf）、`exporter/{html,json,txt}/`、`template/template.html`。
- 提供 Windows 二进制；源码模式只需 Python 3，**运行时不需要 QQ 客户端、不需要注入/hook**（输入已经是解密后的 SQLite 目录）。

**采集机制**：读本地解密后的 NTQQ SQLite 数据库（明文）。配置 `example.toml`：

```toml
db_path = ".\\databases\\"     # 解密后的数据库目录
pic_path = ".\\chatpic\\"      # chatpic 目录
output_path = ""
c2c_filters = [123456,654321]  # 私聊过滤
group_filters = [654321,123456]
output_format = ["txt", "json"]
```

**导出格式**：`txt` / `json`（配置项），代码中另有 `html` 导出器。产物为每个私聊对象/群聊一个文件，落在 `output/` 目录。JSON 字段细节未逐字段核实（**部分未验证**）。

**媒体 / 增量**：有 `pic_path`（chatpic，QQ 客户端缓存的图片目录）用于关联图片；未见增量采集设计，属一次性导出。

**Linux 无头**：源码模式可跑（纯文件读取 + Python）；无原生 Linux 二进制，Windows 二进制为主。

**风险**：本身不碰 QQ 进程，账号风险低；但链路依赖的解密工具（qq-win-db-key 等，Frida 注入）有封号/损坏数据警告（见第 6 节）。

**可复用性**：GPL-3.0，可 `import` 其 `db` / `exporter` 模块作为库，但**传染性 copyleft**——调用方若分发衍生作品需同样以 GPL-3.0 开源。接口未稳定（本项目更像脚本集合，非发布库）。

---

## 2. shuakami/qq-chat-exporter（QCE）

| 项 | 值 |
|---|---|
| 仓库 | https://github.com/shuakami/qq-chat-exporter |
| 本地克隆 | `/home/emo/code/qq-chat-exporter`，`origin` 与上述仓库一致，`HEAD` = tag `v6.3.2`，commit `7d154b8`（2026-10-03 18:32:43 +0000） |
| 许可证 | **GPL-3.0**（`LICENSE` 文件头核实） |
| Stars / Forks | 5602 / 313 |
| 语言 | 仓库主语言标记为 **Rust**（实际为 Rust 服务端 + TypeScript/Next.js 前端混合） |
| 最新 Release | **v6.3.2，2026-10-03**（v6.3.1 2026-10-02、v6.3.0 2026-09-11） |
| 最近 commit | 本地 `7d154b8` 2026-10-03；远端 `pushed_at=2026-10-09`，说明远端还有本地克隆未拉取的提交 |

**v6.3.2 Release 资产**（大小/下载数）：`QQChatExporter-Installer-v6.3.2.exe`（52.5 MB，2115）、`NapCat-QCE-Windows-x64-v6.3.2.zip`（42.3 MB，944）、`NapCat-QCE-Linux-x64-v6.3.2.tar.gz`（43.0 MB，85）、`NapCat-QCE-macOS-arm64-v6.3.2.tar.gz`（41.9 MB，198）、`NapCat-Framework-QCE-v6.3.2.zip`（43.1 MB）、`napcat-plugin-qce.zip`。

**技术栈 / 架构**（来自 `docs/contributing.md`）
- `qq-chat-export-server/`：HTTP/WebSocket API 服务端，**Rust（Tokio / Axum）**，内含 NapCat RPC 客户端、持久化、定时任务调度。
- `qq-chat-export-core/`：Rust 导出/解析引擎（`json_exporter.rs`、`excel_exporter.rs`、`html_exporter.rs`、`modern_html_exporter.rs`、`text_exporter.rs`、`chunked_jsonl_writer.rs`…）。
- `qce-v4-tool/`：Next.js 前端（`package.json`、`playwright.config.ts`）。
- `docker/`：基于 NapCat 的 compose 部署（含 `napcat-stubs`）。

**采集机制**：**基于 NapCat**（README「感谢 NapCatQQ 团队提供的框架支持」）。三种运行形态：
- **完整模式**：自带无界面 QQ（Shell），需手机 QQ 扫码登录；
- **Framework 模式**：作为 LiteLoaderQQNT 插件 / `napiLoader.bat` 注入到桌面 QQ，共享已登录账号；
- **独立查看模式**：只读本机已有导出（`start-standalone.bat`）。
- Docker 形态无需本机装 QQ 客户端。**Linux 方案需官方 linuxqq + `g++` 现场编译 `qq_magic.so` 注入模块**（`docs/linux-deploy.md:19`、`:244`），即 Linux 下确实存在注入。

**导出格式**
- `HTML`（排版贴近手机 QQ，双击即读）、`JSON`、`TXT`（纯文本、无媒体）、`Excel`；可选「导出为 ZIP」。
- HTML 产物是 `.html` + `resources/` 文件夹，二者不可分离。
- JSON 顶层结构（`qq-chat-export-core/src/json_templates.rs:67`）：`metadata` / `chatInfo` / `statistics` / `messages[]`，可选 `avatars`、`resources`。
- 单条消息 `CleanMessage`（`types.rs:150-179`）字段：`id`、`seq`、`timestamp`（毫秒）、`time`（`YYYY-MM-DD HH:mm:ss`）、`sender`、`type`、`content`、`recalled`、`system`、`raw_message`（可选）。
- 另有 **chunked JSONL** 模式：`manifest.json` + `chunks/*.jsonl` + `avatars.json`（`JsonExportMode::ChunkedJsonl`）。

**媒体 / 增量**：图片、视频、表情、文件默认同步下载到本地。增量靠「定时导出」：`docs/guide.md:203` 建议把时间范围设为「昨天」，每天只抓过去 24 小时，再用「合并备份」拼成大文件。

**漫游导出（历史补全）**：实验性功能，**仅私聊**。单任务最多扫描 **1461 个本机日历日**；开启条件是完整模式 + bridge 可用，独立模式返回 `503 STANDALONE_MODE`。接口依赖 NapCat 原生方法 `MsgService.queryRoamCalendar` / `queryFirstRoamMsg` / `getMsgByClientSeqAndTime`（`docs/roaming-api.md`）。

**Linux 无头**：**支持**（Linux x64 Shell 包 + Docker），但登录互斥：`docs/linux-deploy.md:120` 明确「如果你在自己的普通电脑上登录了桌面版 QQ，一旦在服务器上启动了 QCE 完整模式，你的桌面 QQ 就会被强制顶下线；反之亦然」。

**风险**：工具本身声明「所有读取和解析都在你自己的电脑上完成……绝对不会把聊天记录上传到任何地方」（README）。账号风险继承自 NapCat 与 QQ 协议（见第 3 节）。Linux 下需 `LD_PRELOAD` 注入 QQ 进程。

**可复用性**：GPL-3.0（同样传染）。服务端对外暴露带 Token 认证的 HTTP API，可程序化调用；Rust core 是独立 crate，理论上可作库。但版本迭代快（v6.x 数月内多次），插件层被作者描述为「一层极薄的转发桥」，核心在 Rust 服务端内部——**接口稳定性一般**。

---

## 3. NapNeko/NapCatQQ

| 项 | 值 |
|---|---|
| 仓库 | https://github.com/NapNeko/NapCatQQ |
| 许可证 | **自定义「Limited Redistribution License for NapCat」**（`LICENSE` 原文核实；GitHub API `spdx_id=NOASSERTION`）。**非 OSI 开源**：① 禁止商业用途；② 允许再分发但须附完整许可证与来源；③ **修改后的代码不得公开发布**；④ 未明示的权利需向作者申请 |
| Stars / Forks | 10928 / 824 |
| 语言 | TypeScript（pnpm monorepo，`packages/napcat-*` 共 28 个子包） |
| 最新 Release | **v4.18.38，2026-10-12**（v4.18.37 / v4.18.36 均为 2026-10-10） |
| 最近 commit | **2026-10-12**（`fix(album): restore comments and support batch targets`）——维护极其活跃 |
| SECURITY.md | 仅支持 `> 4.0`；漏洞报告走 issue |

**技术栈 / 机制**（官方文档 https://doc.napneko.icu/guide/napcat）
- 「基于 TypeScript 构建的 Bot 框架，通过相应的启动器或者框架，**主动调用 QQ Node 模块提供给客户端的接口**」。
- 与 Hook 类框架的区别（官方原话）：「并非完全自己实现 QQ SendMsg 这种功能，而是主动调用客户端存在的功能」「NapCat 可以完全自身引导 QQ 程序的启动，而非借助客户端启动流程，所以 API 所有权几乎完全拥有，**不需要 Hook**」「并不依赖 Electron 与注入框架，调用来源 IPC 更下层封装的 Node 模块，**也许甚至脱离 QQ 主程序运行**」。
- 对外暴露 OneBot 11（HTTP / WebSocket），可被任意 OneBot 客户端驱动。

**运行环境**：需要官方 NTQQ / linuxqq 客户端（Shell 无头模式）；官方文档给出 **Shell 安装（适合服务器和日常部署）、Linux 手动安装、Framework 安装（复用已有 LiteLoaderQQNT 环境）**，即 **Linux / Docker 无头部署受支持**。

**历史消息 API（关键）**
- `get_group_msg_history` / `get_friend_msg_history`，参数（NapCat 文档 https://doc.napneko.icu/develop/api/doc）：私聊 `user_id`、`message_seq`（默认 `'0'`）、`count`（默认 **20**）、`reverseOrder`（默认 false）；群聊 `group_id` + 同组参数；另有 `get_recent_contact`。
- 源码实现（`packages/napcat-onebot/action/go-cqhttp/GetGroupMsgHistory.ts`、`GetFriendMsgHistory.ts`）：
  - 有 `message_seq` → `MsgApi.getMsgHistory(peer, startMsgId, count, reverse)`；
  - 无 `message_seq` → `MsgApi.getAioFirstViewLatestMsgs(peer, count)`。
- 再下一层（`packages/napcat-core/apis/msg.ts:204`）`getMsgHistory` 实际调用 NTQQ 原生 `getMsgsIncludeSelf(peer, msgId, count, isReverseOrder)`，即**走客户端本地的消息历史路径**，而非独立实现的服务端拉取。
- 官方「差异实现说明」（https://doc.napneko.icu/onebot/napcat）明确：**「NapCat 由于无数据库设计，采用了 LRU（最近最少使用）缓存机制来管理消息和文件资源……在大约 5000 条消息后会因 LRU 策略而过期并被清理。⚠️ 由于 NapCat 不存储历史数据，已撤回的消息无法被再次获取或恢复」**。

**账号风险**（官方「安全相关」页 https://doc.napneko.icu/other/security）
- 「**避免在同一 IP/设备上同时登录 Bot 账号与常用账号，以防常用账号受到异常影响**」
- 「频繁掉线问题可通过更换账号或设备来有效改善」
- 「**遇到社交风控时，解除限制后重新运行即可**，此类限制通常不会频繁触发」
- 「如无法更换账号或设备，可尝试在配置中将 `o3Hook` 设置为 0 以关闭包拦截」
- 安全提示：**v4.8.106 以下版本 WebUI 默认弱密码（密钥为 `napcat`）**；v4.8.106+ 改为启动时随机密码并私聊发送。

**可复用性**：**不可作为普通开源库使用**——自定义许可证禁止商用、禁止公开发布修改版。只能按 OneBot 协议在进程边界对接。

---

## 4. 其他相关项目

### 4.1 LagrangeDev/Lagrange.Core
| 项 | 值 |
|---|---|
| 仓库 | https://github.com/LagrangeDev/Lagrange.Core |
| 许可证 | **无 LICENSE 文件**（API 根目录 contents 已核实：无 `LICENSE`；GitHub license API 返回 404）。默认「保留所有权利」，**不是开源许可** |
| Stars / Forks | 2992 / 352 |
| 语言 | C# |
| 最新 Release | `nightly`，2025-08-02（发布通道基本停更） |
| 最近 commit | **2026-09-07**（`[Milky] Support suppressing self-generated message events`） |

**机制**：**纯 C# 的 NTQQ 协议实现**（README 描述 "An Implementation of NTQQ Protocol, with Pure C#, Derived from Konata.Core"），**不依赖 QQ 客户端**，因此可完全无头运行在 Linux 服务器。提供 OneBot（`Lagrange.OneBot`）与 Milky 协议层。
**风险**：第三方协议实现（非调用官方客户端），是社区公认封号风险更高的路线。
**可复用性**：无许可证 = 法律上不可复用/分发。

### 4.2 LLOneBot/LuckyLilliaBot（原 LLOneBot）
| 项 | 值 |
|---|---|
| 仓库 | https://github.com/LLOneBot/LuckyLilliaBot（原名 `LLOneBot/LLOneBot`，API 返回 301 重定向至 `/repositories/709730860`） |
| 许可证 | **GPL-2.0**（`LICENSE` 文件头为 GNU GPL v2；API `spdx_id=GPL-2.0`） |
| Stars | 3656 |
| 语言 | TypeScript |
| 最近 commit | 2026-10-12 |
| 说明 | 「支持 OneBot 11、Satori 和 Milky 协议」 |

**机制**：LiteLoaderQQNT 插件形态，注入桌面 QQ 客户端提供 OneBot 接口——**必须有 QQ 客户端 + 插件框架**，因此无头服务器支持弱于 NapCat。
**可复用性**：GPL-2.0。

### 4.3 QQBackup/QQ-History-Backup
| 项 | 值 |
|---|---|
| 仓库 | https://github.com/QQBackup/QQ-History-Backup |
| 许可证 | **MIT**（API `spdx_id=MIT`） |
| Stars / Forks | 394 / 26 |
| 语言 | Python |
| 最近 commit | **2024-04-13**（`readme: 更新替代项目链接`）——README 标题即标注 **【停更】** |

**机制**：把**非 QQNT 的 Android 端 QQ/TIM 数据库**转成 HTML，转换图片、语音等特殊消息；GUI（`GUI.py`）与 CLI（`QQ_History.py`）两种方式，输入为已解密的数据库目录（手机上通常在 `/data/data/com.tencent.mobileqq/`，需 root）。
**重要声明**（README 原文）：
- 「本项目理论仅能将可以通过正常方法查看的聊天记录**导出**，而不能进行包括但不限于已删除聊天记录恢复在内的操作。」
- 「本项目不对生成内容的完整性、准确性作任何担保，因此生成的一切内容**没有法律效力**，您不应当将其用于学习与交流外的任何用途。」
- 免责声明援引 [QQ 软件许可及服务协议](https://rule.tencent.com/rule/preview/46a15f24-e42c-4cb6-a308-2347139b1201)。
**可复用性**：MIT 最宽松，可自由复用；但项目停更、只面向旧版移动端。

### 4.4 QQBackup/qq-win-db-key 与 QQBackup/QQDecrypt（解密前置链路）
- **qq-win-db-key**（https://github.com/QQBackup/qq-win-db-key）：密钥提取、数据库导出/重加密脚本；目录含 `scripts/android`（Frida）、`scripts/ios`（Frida）、`scripts/linux`（NTQQ 密钥提取 + hook）、`scripts/macos/arm-nosip`、`scripts/windows/ntqq`、`scripts/windows/pcqq`。最近 commit 2026-07-19。
- README **明确警告**：「本仓库中的工具**可能**破坏聊天记录或导致封号」，建议先备份、优先在虚拟机操作、「尽可能选择不注入 QQ 进程、不修改 QQ 安装包的方式」。
- **QQDecrypt**（https://github.com/QQBackup/QQDecrypt）：231 stars，解密教程文档站，`pushed_at=2026-08-12`，`spdx_id=NOASSERTION`。

### 4.5 其他近期活跃的同类工具（检索所得，数据来自 GitHub search API）
| 项目 | Stars | 许可证 | 最近 push | 定位 |
|---|---|---|---|---|
| [labazhou2024/chatlog-keeper](https://github.com/labazhou2024/chatlog-keeper) | 81 | MIT | 2026-10-06 | 本地解密导出 QQ/微信聊天记录，local-only |
| [zywstudy123/qq-bak-chat-history-export](https://github.com/zywstudy123/qq-bak-chat-history-export) | 12 | MIT | 2026-08-26 | QQ/NTQQ `.bak` → TXT/JSON/CSV，面向 Agent 可读 |

（同关键词还命中 `jielosc/qqnt-export-macos`、`anpingjing/qqnt-chat-export`、`q957506633/qq-nt-export` 等一批 0–2 star 的新仓库，维护性与可信度未验证，不展开。）

---

## 5. 横向对比表

| 维度 | QQNT_Export | qq-chat-exporter (QCE) | NapCatQQ | Lagrange.Core | LLOneBot | QQ-History-Backup |
|---|---|---|---|---|---|---|
| 许可证（LICENSE 核实） | GPL-3.0 | GPL-3.0 | **自定义·禁商用·禁发布修改版** | **无 LICENSE** | GPL-2.0 | MIT |
| 最新 Release | v3.3.0 / 2026-07-12 | v6.3.2 / 2026-10-03 | v4.18.38 / 2026-10-12 | nightly / 2025-08-02 | — | 停更 |
| 最近 commit | 2025-08-23（main，`pushed_at` 2026-07-17 存疑） | 2026-10-03（远端 2026-10-09） | 2026-10-12 | 2026-09-07 | 2026-10-12 | 2024-04-13 |
| Stars | 76 | 5602 | 10928 | 2992 | 3656 | 394 |
| 语言 | Python | Rust + TS | TypeScript | C# | TypeScript | Python |
| 采集机制 | 读**已解密**本地 DB | 基于 NapCat（调用 QQ 客户端） | 调用 QQ 客户端 Node/IPC | 自实现 NTQQ 协议 | 注入 QQ 客户端插件 | 读**已解密**移动端 DB |
| 需 QQ 客户端 | 否 | 完整模式需（Docker/Shell 自带） | 是（Shell 无头） | **否** | 是 | 否 |
| 需注入/hook | 否（但上游解密需） | Linux 需编译注入模块；Framework 需插件 | 官方称不需要 Hook | 否 | 是（LiteLoaderQQNT） | 否（上游解密需 root/Frida） |
| 导出格式 | txt/json/html | HTML/JSON/JSONL/TXT/Excel + ZIP | 不直接导出（提供 API） | 不直接导出 | 不直接导出 | HTML |
| 媒体处理 | chatpic 关联图片 | 图片/视频/表情/文件全下载 | 提供资源 URL | 部分 | 部分 | 图片/语音 |
| 增量采集 | 未提供 | 定时导出 + 合并备份 | 不适用 | 不适用 | 不适用 | 未提供 |
| Linux 无头 | 源码可跑 | **支持**（Linux x64 包 + Docker） | **支持**（Shell/Linux/Docker） | **支持**（无需客户端） | 弱 | 可跑 |
| 账号风险 | 低（离线读库） | 继承 NapCat | 有社交风控/掉线，官方给规避建议 | 第三方协议，风险较高 | 插件注入 | 低（离线读库） |
| 可作库复用 | GPL-3.0 可（传染） | GPL-3.0 可（API/crate） | **否**（许可证禁止） | **否**（无许可证） | GPL-2.0 | MIT 可 |

---

## 6. 关键问题：QQ 服务端历史消息能否被完整获取？

**结论：不能。** 现有 OneBot/NapCat 接口只能拿到「当前账号与客户端可见/已同步」的记录，且群聊离线期间的消息**不会**被补齐（这是 NapCat 维护者明确的设计行为，不是 bug）；私聊只能靠受限的「漫游」接口部分补足，且官方文档明说无法证明服务端完整性。

### 6.1 群聊：`get_group_msg_history` 不返回离线期间消息（一手证据）
- [NapNeko/NapCatQQ Issue #1838](https://github.com/NapNeko/NapCatQQ/issues/1838)「**[BUG] get_group_msg_history 不会返回离线时的消息**」（NapCat 4.17.6 / QQNT 9.9.26-44498）：
  - 报告人复现：「bot 离线，群里聊了很多句后，调用 `get_group_msg_history` **只能获取最近的几条和离线之前的消息**」，期望「应该返回所有历史记录（就像人们在群里手动往上翻一样）」。
  - 维护者 **MliKiowa** 回复（2026-05-22）：「**是的是 feature，不打算实现非离线消息推送**，这会出现大量消息涌入问题」。
  - 同帖（assassingyk）：「之前每次掉线后都是**手动在电脑端登录拉取历史记录补全**」。
  - 即：离线消息**不会**自动同步回来；要补齐得靠客户端自身去「往上翻/登录拉取」。
- [Issue #1868](https://github.com/NapNeko/NapCatQQ/issues/1868)「读取已解散/已退出群聊的历史消息记录」：明确「因为 api 的限制，无法读取已解散/已退出的群聊的消息」，而官方客户端能正常查看——说明 API 可见范围**窄于**客户端 UI 可见范围。

### 6.2 NapCat 内部：无历史数据库 + LRU 上限
- 官方「差异实现说明」：NapCat **不存储历史数据**，消息 ID 走 LRU 缓存，「大约 **5000 条消息**后会因 LRU 策略而过期并被清理」，「已撤回的消息无法被再次获取或恢复」。
- 源码层面，`get_group_msg_history` / `get_friend_msg_history`（有 `message_seq` 时）最终落到 NTQQ 原生 `getMsgsIncludeSelf(peer, msgId, count, isReverseOrder)`；无 `message_seq` 时落到 `getAioFirstViewLatestMsgs(peer, count)`（即「打开会话时看到的最近一批」）。两者都是**客户端本地/会话视图**路径，默认 `count=20`。

### 6.3 私聊：走「漫游」，受限且有明确不确定性
- [LagrangeDev/Lagrange.Core Issue #212](https://github.com/LagrangeDev/Lagrange.Core/issues/212)（2024-03）：`get_friend_msg_history` 的 `count` 参数一度不起作用，根因是 `GetFriendMessageHistoryOperation.cs` 第 28 行写死 `GetRoamMessage(chain, 20)`；修复方式即改为传入 `history.Count`。→ **好友历史是服务端漫游（Roam）接口，历史上固定 20 条**。
- QCE 的漫游实现文档（`/home/emo/code/qq-chat-exporter/docs/roaming-api.md`）给出使用边界的一手描述：
  - 「**任何响应都不能证明腾讯服务端的聊天记录完整性**」，响应字段固定带 `"serverCompletenessProven": false`；
  - 「漫游日历只是提示信息：实际环境中可能出现日历没有标记、但日期锚点仍能查到的情况」「**不能因数组为空或某日未标记，就断言更早记录不存在**」；
  - 仅支持 `chatType: 1` 私聊，「**不支持群聊、频道或临时会话**」；
  - 「这三个端点不接收任意 RPC 方法名、**不提供无上限年份扫描**」；「始终将结果表述为『当前账号与客户端可见的记录』，而不是『完整腾讯云端记录』」。
- QCE 用户文档（`docs/guide.md:164`）：「**普通导出只读取当前客户端已经同步到本机的记录**」；漫游导出「单个任务最多扫描 **1461 个本机日历日**」；`docs/index.md:8`：「该功能只能反映当前账号和客户端可见的内容，**不能证明服务端记录完整**」。

### 6.4 手机端未同步到电脑端的消息
- **未找到**任何证据表明 NapCat/OneBot 的 `get_group_msg_history` / `get_friend_msg_history` 能直接拉取「手机端存在、但从未同步到该客户端」的消息。恰恰相反：#1838 显示离线消息需要客户端自行拉取，QCE 文档显示普通导出只覆盖「已同步到本机的记录」。
- 若要拿到手机端独有记录，目前可核实的两条路是：**在手机端解密数据库导出**（`QQBackup/QQ-History-Backup` + `qq-win-db-key/scripts/android`，需 root/Frida），或让该账号客户端主动同步/漫游后从本机导出。前者不属于 OneBot 能力范围。
- 「QQ 漫游默认保留 7 天 / 会员 30 天」这类具体期限：**未验证**——未找到腾讯官方一手页面明确给出数字，检索命中的多为第三方内容站（如 [百度百科「QQ聊天记录漫游」](https://baike.baidu.com/item/QQ%E8%81%8A%E5%A4%A9%E8%AE%B0%E5%BD%95%E6%BC%AB%E6%B8%B8/24512312)），**请勿采信具体天数**。

### 6.5 一句话回答
> **不能完整获取。** 群聊：`get_group_msg_history` 只覆盖客户端已有/可见的记录，离线期间消息被 NapCat 维护者确认为「不予推送」的设计行为；私聊：只能通过实验性漫游接口按日期锚点有界扫描，官方明确 `serverCompletenessProven: false`。手机端未同步的记录不在 OneBot 能力范围内，只能靠设备端解密导出补足。**任何声称「导出即完整腾讯云端记录」的说法都不成立。**

---

## 7. 未验证 / 待确认清单
1. `Tealina28/QQNT_Export` 的 `main` 最近 commit（2025-08-23）与 `pushed_at`（2026-07-17）、v3.3.0 发布（2026-07-12）三者不一致——**未完全核实**是否强推历史或有其他发布分支。（抓取时 GitHub API 匿名额度 60/h 已耗尽，未能进一步核对 tags。）
2. QCE 单文件 JSON 的完整字段样例（含 `content`、`sender` 子结构）未逐字段核实，仅从 `types.rs` / `json_templates.rs` 读到字段名。
3. QQ 漫游的服务端保留期限（天数）——无腾讯官方一手来源。
4. `Lagrange.Core` 无 LICENSE，但仓库 `README.md` 中未找到许可声明段落——**已核实无 LICENSE 文件**，法律默认保留所有权利。
5. 各项目在 Linux 上的实际端到端可用性（尤其 QCE Linux 的 `qq_magic.so` 注入）均为文档声明，未实测。
