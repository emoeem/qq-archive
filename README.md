# QQ 聊天记录防丢失与自动归档系统

一个**独立于 QQ 客户端**的聊天记录归档系统：把你能合法、稳定获取到的 QQ 消息与多媒体，
落到你自己的 SQLite 数据库与媒体目录里，用一个中文网页管理界面来搜索、浏览、导出。

> **一句话定位**：它不能阻止 QQ 删除消息，但能保证**凡是曾经到达过本系统的消息，以后都不会再丢**。

---

## 目录

- [它解决什么问题](#它解决什么问题)
- [核心能力（真实实现，非演示）](#核心能力真实实现非演示)
- [快速开始](#快速开始)
- [三种部署形态](#三种部署形态)
- [项目结构](#项目结构)
- [技术选型（及为什么）](#技术选型及为什么)
- [数据模型](#数据模型)
- [中文全文检索是怎么做的](#中文全文检索是怎么做的)
- [导入格式](#导入格式)
- [采集端与它的真实边界](#采集端与它的真实边界)
- [扫码登录 QQ](#扫码登录-qq)
- [备份与恢复](#备份与恢复)
- [安全模型](#安全模型)
- [测试](#测试)
- [开源项目复用清单与许可证说明](#开源项目复用清单与许可证说明)
- [已实现 / 有局限 / 未实现](#已实现--有局限--未实现)
- [后续扩展方向](#后续扩展方向)
- [常见问题](#常见问题)

---

## 它解决什么问题

QQ 聊天记录的丢失有几个不同来源，混在一起谈会得出错误的方案：

| 丢失来源 | 能否用本系统解决 | 怎么解决 |
| --- | --- | --- |
| 手机换机 / 重装 / 清理缓存，本地记录没了 | **能** | 提前把已获取的记录导入归档，独立于 QQ 存储 |
| 群消息超过 5000 条被 NapCat LRU 清理 | **能** | 长期挂采集端 + 断点续传，进了库就永久保留 |
| 已撤回的消息后来想看 | **能（前提：撤回前已采集）** | 采集时记录 `recalled` 标记与原文；撤回后无法再取回 |
| 媒体（图片/视频/语音/文件）链接失效 | **能** | 内容寻址落盘 + SHA-256，不依赖 QQ 缓存路径 |
| 客服端/服务端删除云端记录 | **不能** | 超出任何第三方工具能力；本系统保护的是「已成功获取」的数据 |
| 手机端有、但从未同步到采集端的记录 | **不能** | 见 [采集端与它的真实边界](#采集端与它的真实边界) |
| 已解散的群聊记录 | **不能** | OneBot 接口明确不支持；只能靠此前已采集的数据 |

---

## 核心能力（真实实现，非演示）

- **导入**：流式解析 QCE JSON / chunked JSONL / TXT 与自带通用 JSONL，支持 GB 级文件不占内存；
  幂等去重、逐条错误计数、不静默丢字段。
- **采集**：通过 OneBot v11 **只读** HTTP 接口增量拉取，断点续传、失败重试与退避、
  结构化日志、连续失败告警、进程重启自动恢复。
- **多媒体归档**：内容寻址（`<sha256>.<ext>`）落盘、SHA-256 校验、消息↔媒体多对多关联、
  缩略图、缺失/损坏显式标记（**绝不伪造文件**）。
- **中文网页管理**：登录认证、会话列表、时间线、关键词高亮搜索、媒体预览/播放/下载、
  归档统计与任务/日志/备份管理，全部连接真实 API 与数据库。默认只监听本机。
- **扫码登录 QQ**：网页里显示二维码、轮询登录态、一键快捷登录本机已有账号；
  终端里可用 `qq-archive login` 直接渲染二维码。走 NapCat WebUI 接口（与采集用的 OneBot 是两套接口），
  **二维码来自本仓库自研的零依赖编码器**，登录凭据只在本机内存中流转。
- **采集过滤**（`filters` 段，默认关闭）：按**关键词子串 / 发送者 / 消息类型**给消息打标记。
  默认**只标记不丢弃** —— 命中的消息照样入库、导出照样带上，只是默认不在时间线/搜索里显示，
  勾选「包含已过滤消息」即可看到。这是刻意的：防丢失工具里，过滤只该让人"少看点"，
  不该变成"少存点"。只有显式 `drop: true` 才真的跳过存储。规则改了用 `qq-archive refilter`
  对**已有消息**重算标记（只改标记、可逆、不做删除）。
- **备份**：`VACUUM INTO` 一致性快照 + 清单 + 媒体 + 恢复说明；自动备份、保留份数、
  完整性校验，以及**可实际执行的恢复演练**。
- **零生产依赖**：只用 Node 内置模块（`node:sqlite`、`node:http`、`node:crypto`），
  无编译步骤、无原生扩展、无打包器。

---

## 快速开始

> **第一次接触这个项目，建议先读 [docs/USER-GUIDE.md](docs/USER-GUIDE.md)** ——
> 一本整合好的完整手册：能做什么/做不到什么、每一步怎么用、常见问题、怎么把它交给别人用。
> 只想尽快跑起来看 [docs/QUICKSTART.md](docs/QUICKSTART.md)。下面是精简版。

要求：**Node.js ≥ 22.5**（推荐 24.x）。本项目直接用 Node 的类型剥离运行 TypeScript，**不需要构建**。

```bash
git clone <仓库地址> qq-archive && cd qq-archive
cp config.example.json config.json
chmod 600 config.json          # 里面会写入令牌
# config.json 支持 // 与 /* */ 注释和尾逗号；写回令牌时会保留你写的注释
# 令牌不用手填：首次运行会自动生成一个随机令牌并写回 config.json，
# 用下面这条命令随时查看（也可以自己填一个 ≥32 位随机串）：
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"

# 1) 自检环境（首次运行会生成令牌并写回配置）
node --experimental-strip-types apps/cli/src/main.ts doctor

# 2) 导入一份 QQ 导出文件（自动识别格式）
node --experimental-strip-types apps/cli/src/main.ts import ~/Downloads/群聊导出.json

# 3) 看统计
node --experimental-strip-types apps/cli/src/main.ts stats

# 4) 查看登录令牌，然后起服务，浏览器打开 http://127.0.0.1:8787
node --experimental-strip-types apps/cli/src/main.ts token
node --experimental-strip-types apps/cli/src/main.ts serve
```

> 嫌命令太长可以先装成全局命令（仓库自带 `bin/qq-archive.mjs` 包装脚本，会自己带上运行所需的 flag）：
> `pnpm link --global` 或 `npm link`，之后直接用 `qq-archive serve / import / token / doctor …`。
> 不想改全局环境就用别名：
> `alias qq-archive='node /绝对路径/QQ/bin/qq-archive.mjs'`。


启用自动采集（需要旁边跑一个 OneBot 实现，见[采集端](#采集端与它的真实边界)）：

```jsonc
// config.json
"collector": {
  "kind": "onebot",
  "baseUrl": "http://127.0.0.1:3000",
  "token": "OneBot 侧配置的 token",
  "intervalSec": 60,
  // 合并转发展开：0 = 关闭；触顶会置 truncated 并提示，不会静默少存
  "forwardDepth": 3,
  "forwardMaxNodes": 200
}
```

语音转文字（**默认关闭**，需要系统里有 `whisper-cli` 与一个多语言模型）：

```jsonc
"stt": {
  "enabled": true,
  "model": "/usr/share/whisper.cpp-model-large-v3-turbo/ggml-large-v3-turbo.bin",
  "language": "zh",
  "threads": 4
}
```

```bash
node --experimental-strip-types apps/cli/src/main.ts transcribe --limit 50   # 转写待办队列
```

```bash
node --experimental-strip-types apps/cli/src/main.ts collect --once   # 立刻跑一轮
node --experimental-strip-types apps/cli/src/main.ts collect          # 常驻定时采集
```

---

## 三种部署形态

详细步骤见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。

| 形态 | 适用 | 组成 |
| --- | --- | --- |
| **A. 单机全量** | 个人电脑 / 已登录 QQ 的机器 | 一个进程：归档 + 采集 |
| **B. 服务器 + 采集端分离** | 有 Linux 服务器 | 服务器只存归档跑网页；采集端在个人电脑，定期把备份推到服务器 |
| **C. 纯离线导入** | 不装采集端 | 只用 `import` 导入导出文件，网页查看 |

仓库 `deploy/` 提供两个 systemd unit：`qq-archive.service`（归档服务）与
`qq-archive-collect.service`（独立采集端）；`deploy/windows/` 提供 Windows 计划任务脚本
（一键安装/卸载/状态，不需要管理员、不依赖 NSSM）。

> ⚠️ 服务器与采集端之间**只能单向同步**。SQLite 文件不能双向同步或多写。

---

## 项目结构

```
QQ/
├── packages/core/      领域类型、配置、日志、稳定键生成、错误、中文分词
├── packages/db/        SQLite 存储层：迁移 / 仓储 / FTS / 统计 / 备份记录
├── packages/import/    导入器（QCE JSON/JSONL/TXT、通用 JSONL、HTML）+ 媒体归档（HTTP Range 续传）
├── packages/collect/   OneBot 采集适配器 + 断点续传调度 + 告警 + 合并转发展开 + NapCat WebUI 客户端（扫码登录）
├── packages/stt/       语音转文字（可选：whisper.cpp CLI 适配 + 批量流水线）
├── packages/qr/        零依赖 QR 编码器（ISO/IEC 18004 byte 模式）+ PNG/SVG/终端渲染
├── packages/server/    HTTP API + 认证 + 媒体服务 + 静态前端托管
├── apps/cli/           CLI：serve / import / collect / transcribe / login / backup / restore / verify / doctor / stats / logs / token
├── web/                中文管理界面（原生 ES 模块，无构建）
├── deploy/             systemd unit + Windows 计划任务脚本 + 安装说明
├── tests/              自动化测试与合成测试数据生成器
└── docs/               架构契约、部署手册、格式映射、调研报告、验收报告
```

架构接口（模块间的全部签名与 HTTP 端点）冻结在 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

---

## 技术选型（及为什么）

| 关注点 | 选择 | 为什么不是别的 |
| --- | --- | --- |
| 运行时 | Node.js ≥ 22.5 | 原生 `node:sqlite`（无需 better-sqlite3 的原生编译）、原生 TypeScript 剥离（无需 tsc/tsx/esbuild） |
| 数据库 | **SQLite（`node:sqlite`）** | 单文件、可 `VACUUM INTO` 原子备份、FTS5 全文检索；实测 3.53.4 支持 FTS5 + JSON1 + WAL |
| 中文检索 | FTS5 `unicode61` + **应用层 CJK 二元切分** | SQLite 老版本没有 `trigram` 分词器；二元切分不依赖版本，且能同时支持「演唱会」与「看了演」 |
| HTTP | `node:http` 手写路由 | 依赖为 0 意味着可审计、无供应链风险、无升级破坏 |
| 前端 | 原生 ES 模块 + 手写 CSS | 无构建步骤，改完刷新即生效；纯函数可直接被 `node:test` 测试 |
| 采集来源 | OneBot v11 HTTP（**只读**） | 不注入、不 hook、不改客户端；接口稳定且被多个实现支持 |
| 测试 | `node:test` + `node:assert/strict` | 内置，零依赖，`node --test` 直接跑 |

**生产依赖数量：0。** 唯一外部程序依赖是**可选**的 `ffmpeg`（视频抽帧），缺失时功能降级为占位图而不是报错。

---

## 数据模型

完整 DDL 见 [packages/db/src/schema.sql](packages/db/src/schema.sql)，迁移见
[packages/db/src/migrations.ts](packages/db/src/migrations.ts)。

| 表 | 作用 |
| --- | --- |
| `accounts` | 归档的账号（多账号隔离的顶层键） |
| `sessions` | 会话（私聊/群聊/临时），含消息数与首末时间 |
| `contacts` | 联系人/群成员昵称、备注 |
| `messages` | 消息主表，**`UNIQUE(account_uid, session_key, msg_key)`** 保证幂等 |
| `media` | 媒体元数据，**`sha256` 唯一**，内容寻址去重 |
| `message_media` | 消息↔媒体多对多（含序号、原文件名、声明大小） |
| `import_jobs` | 导入/采集/备份任务与进度、计数、错误 |
| `collect_state` | **每个会话的采集游标**（断点续传的核心） |
| `logs` | 结构化日志（供网页查看） |
| `backups` | 备份记录与校验结果 |
| `messages_fts` / `messages_fts_bigram` | 全文索引（原文分词 / CJK 二元）
| `settings` | 运行期设置 |

**关键设计**：

1. **`msg_key` 是幂等的核心**：源数据有真实消息 ID 时用 `id:<msgId>`；没有时用
   `sha256(ts|sender|text|seq|资源指纹)` 作内容哈希。所以同一份文件重复导入 0 新增，
   不同时间导出的重叠部分也能归并。
2. **重复导入不覆盖已有行**：导出文件可能是较早的快照，覆盖会丢数据。
3. **媒体内容寻址**：同内容只存一份，路径由 sha256 决定，天然不覆盖不同内容文件。
4. **迁移只做向后兼容新增**（加表/加索引/加可空列），每个版本在事务内执行。

---

## 中文全文检索是怎么做的

难点：`unicode61` 分词器按空格/标点切词，而中文没有空格 ——
「今天去看了演唱会」会被当成**一个 token**，搜「演唱会」永远 0 命中。

本项目的做法（`packages/core/src/ids.ts` 的 `buildSearchText`）：

1. 入库时把中文连续段切成**二元组**：`今天去看了演唱会` → `今天 天去 去看 看了 了演 演唱 唱会`；
2. 英文/数字/空格保持原样；
3. 查询时对关键词做同样的切分，用 `AND` 连接各 token；
4. **单个汉字**（如「唱」）没有对应的二元组，自动退化为字面 `LIKE` 匹配。

于是：`演唱会` 命中、`看了演` 命中、`唱` 命中（走 LIKE）、`hello` 整词命中而 `ell` 不命中。
命中位置由服务端生成 `<mark>` 片段，前端**先转义再插入标记**，不会 XSS。

---

## 导入格式

| 格式 | 识别方式 | 来源 |
| --- | --- | --- |
| `qce-json` | 顶层有 `chatInfo` + `messages` | [shuakami/qq-chat-exporter](https://github.com/shuakami/qq-chat-exporter) 的单文件 JSON 导出 |
| `qce-jsonl` | `manifest.json` + `chunks/*.jsonl` | 同一个工具的分块 JSONL 导出（大文件推荐） |
| `qce-txt` | 文本行模式 | 同一个工具的 TXT 导出（尽力解析，无法解析的行保留原文并计入错误） |
| `generic-jsonl` | 每行一个对象 | 自带规范，供其他工具/自行转换接入 |

字段映射细则见 [docs/format-mapping.md](docs/format-mapping.md)。

**导入不会静默丢字段**：无法识别的字段整条保存进 `messages.raw`，无法解析的行计入
`import_jobs.stats.errors` 并在网页日志里可见。

---

## 采集端与它的真实边界

采集端只调用 OneBot v11 的**只读**接口（`get_login_info` / `get_group_list` / `get_friend_list` /
`get_group_msg_history` / `get_friend_msg_history` / `get_image` / `get_record` / `get_file`），
不使用任何写消息接口、不注入客户端。

### 必须知道的限制（有一手证据，见 [调研报告](docs/qq-export-projects-research.md)）

- **QQ 服务端的历史记录无法被完整获取。**
  NapCat 维护者在 [Issue #1838](https://github.com/NapNeko/NapCatQQ/issues/1838) 明确回复：
  机器人离线期间的消息**不会**被补齐，这是**设计行为**（原话：「是的是 feature，不打算实现非离线消息推送」）。
- **NapCat 没有历史数据库**，消息走 LRU 缓存，约 **5000 条**后被清理；已撤回消息无法再取回。
- **私聊历史走「漫游」接口**，QCE 官方文档明确响应字段固定带 `serverCompletenessProven: false`，
  并写明「任何响应都不能证明腾讯服务端的聊天记录完整性」。
- **已解散/已退出的群**：接口明确无法读取。
- **手机端有、但从未同步到采集端的消息：没有任何 API 能拿到。** 要拿只能走设备端解密导出
  （需 root/Frida），本项目**不提供**这条路 —— 它既不合法稳定，也不符合「不注入、不改客户端」的定位。

### 因此本系统的正确用法

采集端**长期挂着**（systemd 自动重启 + 开机自启），把离线窗口压到最短。
系统保证的是：**进了库的消息，永久保留**。

---

## 扫码登录 QQ

「采集」需要采集端已经登录 QQ。如果你还没登录（例如刚装好 NapCat、或在服务器上重新部署），
可以直接在本系统里扫码登录，不用去开 NapCat 自带的 WebUI。

**前提**：NapCat 已安装并启动了 WebUI，且你知道它的 token（在 NapCat 的 `config/webui.json` 里）。
注意 **WebUI token 与采集用的 OneBot token 不是同一个**，两个接口也不在同一个端口。

配置（`config.json`）：

```jsonc
{
  "collector": {
    "kind": "onebot",                       // 采集消息用的接口
    "baseUrl": "http://127.0.0.1:3000",
    "token": "OneBot 的 token",
    "napcat": {                             // 扫码登录用的接口（可选）
      "webuiUrl": "http://127.0.0.1:6099",  // NapCat WebUI 地址
      "token": "NapCat WebUI 的 token",     // 取自 config/webui.json
      "probeRange": 20                      // NapCat 会在 6099 之后自增端口，向后探测的范围
    }
  }
}
```

**网页里扫码**：启动 `qq-archive serve`，浏览器打开后进入左侧「QQ 登录」页 ——
显示二维码（在本机渲染成 PNG，不依赖任何外部图片服务）、登录状态自动轮询、
以及本机已有账号的「快捷登录」列表。

**终端里扫码**：`qq-archive login` 直接把二维码画在终端里（用色块渲染，可被手机扫描）：

```bash
qq-archive login                      # 显示二维码并等待扫码
qq-archive login --list               # 只列本机可快捷登录的账号
qq-archive login --uin 10001          # 快捷登录指定账号并等待上线
qq-archive login --no-wait            # 只打印二维码，不等待
qq-archive login --timeout 300        # 等待上限（秒）
```

退出码：`0` 成功 / `2` 参数或配置问题（未配置 `collector.napcat.token`、`uin` 非法）/
`3` 连不上 NapCat WebUI 或 token 不对。**这是刻意的区分**：`3` 表示「去检查 NapCat 或改 token」，
`2` 表示「去改本系统的配置」。

### 它的真实边界（别把扫码登录想多了）

- 本系统**不实现 QQ 协议**，只是驱动 NapCat 已有的 WebUI 接口。扫码登录的本质是
  **让 NapCat 登录**，本系统全程拿不到也不需要 QQ 密码。
- **二维码 URL 本身就是一次性的登录凭据**，所以它只在内存中流转：网页端只下发 PNG
  （`data:` URL），终端只画色块，均不会把 URL 写进 JSON 响应、日志或文件。
- 登录凭据（`Credential`）同样是敏感值，日志脱敏规则已覆盖。
- 出现「当前账号已登录，无法重复登录」时，本系统如实回报，**不会**去杀 QQ 进程或做任何破坏性操作
  （那是 [QCE 的做法](docs/qce-reuse-analysis.md)，我们不复用也不建议）。
- 断网、NapCat 换端口、凭据失效都会自动恢复一次（重新探端口 + 重新登录），但**只重试一次**：
  服务真的挂了就该立刻报错，而不是无限重试把请求堆死。

---

## 备份与恢复

```bash
qq-archive backup                          # VACUUM INTO 快照 + sha256 清单 + 媒体副本
qq-archive restore <备份目录>               # 演练：只校验，不改数据（默认 dry-run）
qq-archive restore <备份目录> --apply       # 真正恢复（会先把当前库另存一份）
qq-archive verify                          # 校验当前媒体文件与数据库记录是否一致
```

备份产物（**扁平命名，同一个 backupDir 下**）：

```
<backupDir>/
├── archive-manual-<时间戳>.db            # VACUUM INTO 一致性快照（含 WAL 内容，不是文件拷贝）
├── archive-manual-<时间戳>.manifest.json  # 计数、全部文件的 sha256、schema 版本、时间
└── archive-manual-<时间戳>.media/         # 媒体文件（仅 includeMedia=true 时生成）
```

`<kind>` 由来源决定：`manual`（CLI / 网页手动）、`auto`（定时任务），或 CLI `--label` 指定的值。

**定时自动备份**由 `backup.intervalHours` 控制（默认 24 小时，`0` 关闭），
每轮会生成 `archive-auto-<时间戳>.db` 并**写入 `backups` 表**（所以网页「归档管理」
的最后备份时间与备份列表都能看到它）；超出 `backup.keep` 份后自动删除最旧的快照、
清单与媒体副本。手动备份走同一个入口，同样入库、同样参与保留份数裁剪。

**备份不读取、也不依赖 QQ 的任何本地数据目录。**

---

## 安全模型

- **默认只监听 `127.0.0.1`**。远程访问推荐 SSH 隧道：`ssh -N -L 8787:127.0.0.1:8787 user@server`。
- 监听非本机地址时，令牌不足 24 字符**直接拒绝启动**（`validateConfig`）。
- 登录用 `server.token` 换取短时会话令牌；**令牌哈希存库**，明文不落盘、不下发浏览器。
- 除 `/api/health` 与 `/api/auth/login` 外，所有接口都要求认证；未认证一律 401，
  **且不通过错误信息泄露资源是否存在**。
- 媒体与导出接口只从数据库读取 `rel_path` 并做 `path.resolve` 前缀校验，**不接受用户传路径**。
- 统一响应头：`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、
  `Referrer-Policy: no-referrer`、同源 CSP。
- 日志自动脱敏（`sk-` 密钥、Bearer、token/password/secret、base64 图片）。
- 密钥建议放 systemd `EnvironmentFile`（`chmod 600`），不写进仓库。

---

## 测试

```bash
node --test --experimental-strip-types "tests/**/*.test.ts"   # 全量
npm run typecheck                                             # tsc --noEmit
```

**当前实际结果：347 个用例全部通过（0 失败），类型检查 0 错误（26 个测试文件，实测约 28 s）。**

| 测试文件 | 用例 | 覆盖 |
| --- | ---: | --- |
| `tests/db.test.ts` | 7 | 迁移、FTS 中文检索、游标 |
| `tests/cli.test.ts` | 22 | 参数解析 + **真实子进程端到端**（`--config`/导入/备份/恢复/**令牌写回**/**网页托管**/`--version`/**`transcribe`**/包装脚本） |
| `tests/import.test.ts` | 14 | **5 种格式**导入（含 HTML）、格式自动识别、错误分类、导入器注册数 |
| `tests/html-import.test.ts` | 9 | **HTML 导入**：三种 fixture（QCE viewer / QCE DOM / 通用聊天页）+ 保守探测（不像聊天页必须判 `unknown`）+ 换行/方向/媒体/时间解析 |
| `tests/media.test.ts` | 23 | 内容寻址归档、SHA-256 校验、缩略图（含**归档时必产出 `thumbPath`** 的回归用例）、缺失/损坏标记、**Range 断点续传 9 例**（206 追加后 sha256 一致、200 截断重下、`If-Range`、416、超限清残片） |
| `tests/collect.test.ts` | 23 | OneBot 协议、只读白名单、退避重试、断点续传、**媒体入库护栏**、**零历史会话不当失败**（回归）、**媒体不重复下载**（齐备即跳过 / 缺失仍重试） |
| `tests/forward.test.ts` | 15 | **合并转发展开**：纯函数（嵌套/去重/截断冒泡/预算）、`get_forward_msg` 协议（含**真机 `node.sender` 嵌套形状回归**）、`CollectRunner` 真库端到端 |
| `tests/stt.test.ts` | 25 | **语音转文字**：文本归一化、英文模型识别、探测缓存、ffmpeg+whisper 命令组装、批量流水线、DB 契约与级联删除 |
| `tests/server.test.ts` | 24 | 路由、认证、导出、备份、SSE、**定时自动备份写入 backups 表**（回归）、**`/api/stt/*` 与 `/api/media/:id/transcript`** |
| `tests/web.test.ts` | 29 | 纯函数、XSS 护栏、API 路径契约 |
| `tests/qr.test.ts` | 13 | QR 编码器：容量表、RS 数学、格式信息、几何、放置不变式、PNG 结构、**与 `qrencode` 逐模块黄金对比**、`zbarimg` 解码回环 |
| `tests/napcat.test.ts` | 18 | NapCat WebUI 客户端：密码哈希、端口探测、认证、凭据失效重认证、快捷登录错误语义 |
| `tests/napcat-login-e2e.test.ts` | 7 | **真子进程 CLI + 真 HTTP + 假 NapCat WebUI**：退出码、终端二维码逐模块等于编码器输出、重认证恰好一次 |
| `tests/napcat-routes.test.ts` | 9 | `/api/napcat/*` 四条路由的 HTTP 契约：401/503/400 语义、**二维码只下发 PNG，响应体不含 URL 明文（逐像素解开 PNG 与编码器矩阵比对）**、**错误码必须透传真实 status/code**（回归） |
| `tests/acceptance.test.ts` | 15 | 任务书第六阶段的 15 项验收 |
| `tests/integration.test.ts` | 5 | **不注入任何桩**的真实联调 |
| `tests/hardening.test.ts` | 2 | 快速开始自检的回归护栏：systemd `StartLimit*` 必须在 `[Unit]`、`generate.ts --help` 不得创建 `--help/` 目录 |
| `tests/reply-preview.test.ts` | 15 | **引用内容解析**（回归）：`reply_to_id` / `reply_to_msg_key` 两种形态、同会话隔离、目标缺席、时间线与详情两条路由的契约、前端不得再把 QQ 原始 id 当本库 id |
| `tests/backup-reconcile.test.ts` | 8 | **备份对账**（回归）：快照登记行丢失后按 manifest 找回、幂等、坏 manifest 兜底、只认 `archive-*.db`、prune 与对账配合、**数据目录搬迁后改指而非重复登记** |
| `tests/log-sink.test.ts` | 6 | **运行日志回路**（回归）：真实子进程验证 warn/error 落库、info 不落库、`logs.dbKeepDays` 清理与 `0` 不清理、环境变量覆盖、配置校验 |
| `tests/db-prepare-cache.test.ts` | 3 | 预编译语句缓存 |
| `tests/purge.test.ts` | 8 | **撤回抹不掉已归档的内容**（后续轮次只增不改：上游不再返回、或返回同 ID 改过的内容，原文都必须保留）；**purge** 默认只演练、加 `--yes` 才删、FTS 索引一并清理、`--media` 只删不再被引用的文件 |
| `tests/collector.test.ts` | 11 | **采集端容器编排**：两个 token 分属不同文件的读取准确性、未登录容器安静降级、参数校验、无容器运行时的安装指引、空 `QQ_ARCHIVE_CONFIG` 不再 resolve 成当前目录（回归） |
| `tests/backup-media.test.ts` | 6 | **备份/恢复的媒体链路**（回归）：传快照 `.db` 也能找到同名 manifest、`--with-media` 真带媒体、删掉媒体后 `--restore-media` 完整还原且逐文件 sha256 一致、无媒体可恢复时必须告警而非静默通过 |
| `tests/config-jsonc.test.ts` | 14 | **配置文件容错**：`//` 与 `/* */` 注释、尾逗号；**字符串里的 `//` 绝不被当注释吃掉**（`http://` URL 回归）；坏 JSON 仍报错且带文件路径；带注释的配置能被 CLI 用起来且写回令牌时不抹注释 |
| `tests/filter.test.ts` | 16 | **采集过滤**：三类规则的匹配语义、**默认标记不丢数据**（库里仍有、导出仍带）、查询默认隐藏 / `includeFiltered` 取回、`drop=true` 才跳过存储、老配置不启用时行为不变、`refilter` 重算标记（幂等/可逆/可清空）|

测试数据**全部由 [tests/fixtures/generate.ts](tests/fixtures/generate.ts) 合成生成**
（确定性 PRNG + 手写字节生成的合法 PNG/GIF/MP4），不含任何真实聊天记录。

15 项验收测试的逐项结果（含未通过/受限项及原因）见 [docs/acceptance.md](docs/acceptance.md)，
最终交付报告见 [docs/FINAL-REPORT.md](docs/FINAL-REPORT.md)。

---

## 开源项目复用清单与许可证说明

本项目**没有复制任何第三方项目的代码**，所有代码为本项目自研。以下是调研过的项目及其
对本项目的影响，以及**必须遵守的许可证边界**：

| 项目 | 许可证（已核实 LICENSE 文件） | 本项目的使用方式 | 结论 |
| --- | --- | --- | --- |
| [shuakami/qq-chat-exporter](https://github.com/shuakami/qq-chat-exporter) | **GPL-3.0** | **只借鉴其导出格式**（读取它产出的 JSON/JSONL/TXT 文件），未复制代码 | 格式兼容属事实标准，不构成衍生作品 |
| [Tealina28/QQNT_Export](https://github.com/Tealina28/QQNT_Export) | GPL-3.0 | 未使用 | 需已解密本地 DB，与手机端场景不符 |
| [NapNeko/NapCatQQ](https://github.com/NapNeko/NapCatQQ) | **自定义许可：禁商用、禁发布修改版（非 OSI 开源）** | **仅通过 HTTP 调用其 OneBot 接口与 WebUI 接口**（后者用于扫码登录），不链接、不修改、不打包 | 用户自行部署；本项目不分发其任何字节 |
| [LagrangeDev/Lagrange.Core](https://github.com/LagrangeDev/Lagrange.Core) | **无 LICENSE 文件**（默认保留所有权利） | 未使用 | 无许可证 = 不可复用；且第三方协议封号风险更高 |
| [LLOneBot/LuckyLilliaBot](https://github.com/LLOneBot/LuckyLilliaBot) | GPL-2.0 | 未使用（但兼容其 OneBot 接口） | 可选采集端之一 |
| [QQBackup/QQ-History-Backup](https://github.com/QQBackup/QQ-History-Backup) | MIT | 未使用 | 需移动端 root/Frida 解密，不符合定位 |
| [SnowLuma/SnowLuma](https://github.com/SnowLuma/SnowLuma) | **SnowLuma Source-Available Non-Commercial License v1.0（2026-06-19，非 OSI 开源）**：限制商业用途与修改版的公开发布，并禁止在其之上另建项目 | **未使用任何代码**。仅阅读其源码提取**机制与思路**（预编译语句缓存、媒体 URL 失效处理等），由本项目自有代码独立实现 | 许可明文禁止在其上构建另一项目 → **只借鉴设计，绝不复制代码**（详见 [snowluma-analysis.md](docs/snowluma-analysis.md)） |

| [shuakami/qq-chat-exporter](https://github.com/shuakami/qq-chat-exporter)（**二次调研：扫码登录**） | GPL-3.0 | 它自己**不实现 QQ 登录**，而是驱动 NapCat WebUI 的 REST 接口。本项目只参考该**接口契约**（调哪个路径、参数叫什么），从零重写客户端；连二维码都用自研编码器生成 | 接口属于事实性信息，独立实现不构成衍生作品。**未复制任何代码**（详见 [qce-reuse-analysis.md](docs/qce-reuse-analysis.md)） |

**所以本项目的架构选择是刻意的**：**通过稳定的 HTTP 接口解耦，而不是链接/打包 GPL 或非开源代码。**
这样既避免了 GPL 传染与非商业许可的边界问题，也让用户能自由更换采集端实现。

> 本项目的 `LICENSE` 由你（仓库所有者）决定。若你打算闭源分发，当前架构是安全的；
> 但**不要**把 NapCatQQ、Lagrange.Core 等代码复制进来。

---

## 已实现 / 有局限 / 未实现

### 已实现并测试通过

导入（**5 种格式**：QCE JSON / QCE chunked JSONL / QCE TXT / 通用 JSONL / **聊天网页 HTML**；
幂等、流式）、采集（增量、断点续传、重试、告警、**合并转发展开**）、媒体归档（内容寻址、SHA-256、
关联、缺失标记、图片缩略图、**HTTP Range 断点续传**）、中文网页管理（认证、会话、时间线、搜索高亮、
媒体预览下载、任务/日志/备份）、**扫码登录 QQ**（网页二维码 + 轮询 + 快捷登录，CLI 终端二维码，
零依赖 QR 编码器）、**语音转文字**（可选、本地 whisper.cpp，中文实测可用）、
SQLite 存储与迁移、备份与**恢复演练**、CLI、systemd 与 **Windows 计划任务**部署脚本、
日志轮转与磁盘告警。

### 已实现但有局限

- **视频缩略图**：依赖系统 `ffmpeg`；缺失时显示占位图（不影响归档与播放）。
- **TXT 导出导入**：格式信息量低，只能尽力解析；无法解析的行保留原文并计数，不静默丢弃。
- **中文搜索**：单汉字走 `LIKE` 全表扫描，超大数据集下比 FTS 慢（二元组路径不受影响）。
- **合并转发展开**：转发树存进 `messages.extra.forward`，附件一并归档；默认展开 3 层 / 200 个节点，
  触顶会置 `truncated=true` 并在 CLI 明确提示（不会静默少存）。
- **HTML 导入**：手写扫描器，零 HTML 依赖；探测**保守**（不像聊天页就不认，需 `--format html`）。
  只用合成 fixture 验证过，**没拿真实第三方导出器的 HTML 验证过**。
- **语音转文字**：已实现但**默认关闭**（`stt.enabled`）。只支持本地 whisper.cpp CLI；
  转中文**必须用多语言模型**（`*.en.bin` 只会输出近乎空文本，探测阶段会警告）。
  转写文本是**机器产物、可能有错字**，不能当作消息原文的权威副本；
  真机验证只覆盖 3 个真实 `.amr`，没有 CER/WER 基准，也未覆盖方言与强噪声。
- **Windows 部署脚本**：`deploy/windows/` 已有一键安装/卸载/状态脚本，但**从未在真实 Windows 上执行过**
  （开发机是 Linux，没有 `pwsh`），只做了 **80 项**静态自检（5 个脚本各 14 项 + README 10 章节，0 失败）。
  静态检查**验不出** cmdlet 名是否正确、计划任务能否注册成功、`$PSScriptRoot` 运行时路径是否成立 —— 静态全绿 ≠ 能跑。
  详见 [`deploy/windows/README.md`](deploy/windows/README.md)。

### 受 QQ 或 OS 限制无法实现

- 获取手机端未同步到客户端的消息（需 root/Frida）。
- 恢复已撤回且采集前已过期的消息内容。
- 读取已解散/已退出群聊的历史消息。
- 阻止 QQ 客户端自身删除消息。

### 明确未做（有意不做的取舍）

- 不注入 QQ 客户端、不 hook、不修改官方客户端文件。
- 不实现自动解密手机/电脑端 QQ 数据库（法律与稳定性风险）。
- 不提供多用户/多租户（本系统是单人自托管）。

---

## 后续扩展方向

1. **更多导入源**：QQ 官方「消息记录迁移」导出、微信/macOS 聊天记录格式；真实第三方 HTML 导出器的回归样本。
2. **语义检索**：在 FTS 之上叠加本地 embedding（需引入模型，会打破零依赖，应做成可选插件）。
3. **采集端增强**：支持多个 OneBot 实例并行、按会话优先级调度。
4. **媒体处理**：转写质量基准（CER/WER）、视频转码为浏览器友好格式、重复图片感知哈希合并。
5. **检索体验**：会话内时间轴跳转、按发送者过滤、导出为可分享的只读 HTML。
6. **运维**：Prometheus 指标端点、备份到 S3/WebDAV、备份加密。
7. **多账号**：数据库已按 `account_uid` 隔离，只需在界面加账号切换。

---

## 常见问题

**问：能导入我现在的 QQ 聊天记录吗？**
能 —— 只要你已经有一个导出文件（JSON/JSONL/TXT/**HTML 网页**），或者旁边能跑 OneBot 采集端。
导入是幂等的，可以反复导。

**问：能持续保存新收到的消息吗？**
能。前提是采集端（OneBot 实现）持续运行。离线期间的消息**不会**被补齐（见上文限制）。

**问：图片和视频会独立保存吗？**
会。媒体被复制到归档目录，按内容哈希命名，记录 SHA-256；原文件不存在时明确标记为「缺失」，
**不会伪造**。

**问：手机端没同步到电脑的历史能拿到吗？**
不能。没有任何 API 能做到；需要设备端解密（root/Frida），本项目不提供。

**问：能部署到服务器上用网页看吗？**
能。见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。默认只监听本机，远程请用 SSH 隧道。

**问：会不会动我的 QQ 数据？**
不会。本系统只读 QQ 导出文件或只读 OneBot 接口，**从不写入、修改、删除** QQ 的任何数据。
