# 部署与运维手册

本文档覆盖两种目标环境（Debian/Ubuntu 与 Arch Linux），以及三种部署形态：

| 形态 | 适用场景 | 说明 |
| --- | --- | --- |
| **A. 单机全量** | 个人电脑 / 已登录 QQ 的机器 | 归档服务器 + 采集端在同一台机器 |
| **B. 服务器 + 采集端分离** | 有 Linux 服务器 | 服务器只存归档、跑网页；采集端在个人电脑 |
| **C. 纯离线导入** | 完全不装采集端 | 只用 `import` 导入导出文件，网页查看 |

> **重要前提**：本系统的采集端**不依赖任何第三方 QQ 协议实现的内置代码**，只通过 HTTP 调用
> OneBot v11 的**只读**接口。OneBot 实现的安装与登录属于你自己负责的部分，见第 6 节。

---

## 1. 系统要求

| 项目 | 要求 |
| --- | --- |
| 操作系统 | Debian 11+ / Ubuntu 20.04+ / Arch Linux / 其他现代 Linux；macOS 与 Windows 也可运行（Windows 有一键脚本，见 §9.1） |
| 架构 | x86_64 / arm64 均可（无原生编译依赖） |
| Node.js | **≥ 22.5**（需要 `node:sqlite` 与 TypeScript 类型剥离）。推荐 24.x LTS |
| 磁盘 | 归档本身按消息量与媒体量估算；建议至少留出媒体总量的 2 倍（备份需要空间） |
| 内存 | 服务常驻约 80–150 MB；导入大文件时按文件大小预留 |
| 可选 | `ffmpeg`（视频缩略图/转码）。**缺失不影响归档**，只是视频没有缩略图 |

### 安装 Node.js

Debian / Ubuntu：

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v   # 应显示 v24.x
```

Arch Linux：

```bash
sudo pacman -S nodejs npm
node -v
```

可选 ffmpeg：

```bash
sudo apt-get install -y ffmpeg      # Debian/Ubuntu
sudo pacman -S ffmpeg               # Arch
```

---

## 2. 安装归档服务

```bash
# 1) 取代码（放在 /opt，属于 root，普通用户不可改）
sudo git clone <你的仓库地址> /opt/qq-archive
cd /opt/qq-archive

# 2) 安装开发依赖（仅 TypeScript 类型检查用；生产运行不需要 node_modules）
sudo npm install --omit=optional
# 若你的环境无法访问 npm，可跳过：运行时不依赖 node_modules

# 3) 建系统用户与目录
sudo useradd --system --home /var/lib/qq-archive --shell /usr/sbin/nologin qqarchive
sudo mkdir -p /var/lib/qq-archive /var/backups/qq-archive /etc/qq-archive
sudo chown -R qqarchive:qqarchive /var/lib/qq-archive /var/backups/qq-archive
sudo chmod 750 /var/lib/qq-archive /var/backups/qq-archive /etc/qq-archive

# 4) 生成配置
sudo cp config.example.json /etc/qq-archive/config.json
sudo sed -i "s|\"dataDir\": \"./data\"|\"dataDir\": \"/var/lib/qq-archive\"|" /etc/qq-archive/config.json
sudo sed -i "s|\"backupDir\": \"\"|\"backupDir\": \"/var/backups/qq-archive\"|" /etc/qq-archive/config.json

# 5) 生成管理令牌（务必替换占位值）
TOKEN=$(openssl rand -base64 32)
sudo sed -i "s|\"token\": \".*\"|\"token\": \"$TOKEN\"|" /etc/qq-archive/config.json
sudo chmod 600 /etc/qq-archive/config.json
sudo chown qqarchive:qqarchive /etc/qq-archive/config.json

# 6) 自检（会用 /etc/qq-archive/config.json）
sudo -u qqarchive QQ_ARCHIVE_CONFIG=/etc/qq-archive/config.json \
  node --experimental-strip-types /opt/qq-archive/apps/cli/src/main.ts doctor
```

### 创建命令软链（可选，方便调用）

```bash
sudo tee /usr/local/bin/qq-archive >/dev/null <<'EOF'
#!/bin/sh
# 归档 CLI 包装脚本：以 qqarchive 身份运行，使用固定配置
exec sudo -u qqarchive QQ_ARCHIVE_CONFIG=/etc/qq-archive/config.json \
  /usr/bin/node --experimental-strip-types /opt/qq-archive/apps/cli/src/main.ts "$@"
EOF
sudo chmod +x /usr/local/bin/qq-archive
qq-archive stats
```

---

## 3. systemd 服务

仓库 `deploy/` 下已提供两个 unit：

| 文件 | 作用 |
| --- | --- |
| `deploy/qq-archive.service` | 归档服务器（数据库 + API + 网页 + 可选内建采集） |
| `deploy/qq-archive-collect.service` | 独立采集端（服务器与采集端分离时使用） |

### 3.1 只部署归档服务器（形态 A / C）

```bash
sudo cp deploy/qq-archive.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now qq-archive
systemctl status qq-archive
```

启用内建采集（形态 A）：编辑 `/etc/qq-archive/config.json` 把 `collector.kind` 改为 `"onebot"`，
并填好 `collector.baseUrl`，然后 `sudo systemctl restart qq-archive`。

### 3.2 服务器 + 采集端分离（形态 B）

- **服务器**：只装 `qq-archive.service`，`collector.kind` 保持 `"none"`。
- **采集端机器**（已登录 QQ 的那台）：装代码 + 配置，只启用采集服务：

```bash
sudo cp deploy/qq-archive-collect.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now qq-archive-collect
journalctl -u qq-archive-collect -f
```

采集端写入的数据库在**采集端本机**。周期性把归档同步到服务器有三种做法：

```bash
# 做法 1（推荐）：采集端跑服务，服务器从采集端拉取备份
#   采集端：qq-archive backup
#   服务器：rsync 拉回备份目录后再 restore
rsync -av --delete qqarchive@collector-host:/var/backups/qq-archive/ /var/backups/qq-archive/

# 做法 2：把媒体目录单向同步（只增不改）
rsync -av --ignore-existing qqarchive@collector-host:/var/lib/qq-archive/media/ /var/lib/qq-archive/media/

# 做法 3：直接在采集端也跑网页，服务器仅作冷备份
```

> ⚠️ **不要**用双向同步工具同时写两边数据库。SQLite 文件不能并发多写。

### 3.3 常用运维命令

```bash
systemctl start|stop|restart|status qq-archive
journalctl -u qq-archive -f              # 实时日志
journalctl -u qq-archive --since today   # 今日日志
qq-archive doctor                        # 环境自检
qq-archive stats                         # 归档统计
```

---

## 4. 配置说明

配置文件路径优先级：`--config` 参数 > 环境变量 `QQ_ARCHIVE_CONFIG` > `./config.json`。

### 4.1 关键字段

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `server.host` | `127.0.0.1` | **默认只允许本机访问**。改为 `0.0.0.0` 前请先读第 5 节 |
| `server.port` | `8787` | 监听端口 |
| `server.token` | 自动生成 | 网页登录令牌。**至少 32 位随机**；非本机监听的校验会拒绝过短令牌 |
| `server.allowDownload` | `true` | 关闭后媒体接口只允许预览不允许下载 |
| `storage.dataDir` | `./data` | 数据根目录（相对路径以配置文件所在目录为基准） |
| `storage.backupDir` | `<dataDir>/backups` | 备份目录，建议放**另一块磁盘** |
| `backup.intervalHours` | `24` | 自动备份间隔，`0` 关闭 |
| `backup.keep` | `7` | 保留份数 |
| `logs.dbKeepDays` | `30` | 数据库日志（网页「日志」页）保留天数，`0` = 不清理。启动时清一次 |
| `filters.enabled` | `false` | 采集过滤总开关。**默认只标记不丢弃**：命中的消息照样入库、导出照带，只是默认不显示 |
| `filters.excludeKeywords` | `[]` | 命中的关键词（子串、大小写不敏感） |
| `filters.excludeSenders` | `[]` | 命中的发送者（QQ 号 / uid / 昵称，精确相等） |
| `filters.excludeTypes` | `[]` | 命中的消息类型（如 `system`、`json`） |
| `filters.drop` | `false` | `true` = 命中的消息**跳过存储**（真的不入库）。改动前请确认这就是你要的 |
| `alert.diskLowGb` | `2` | 磁盘剩余告警阈值 |
| `collector.kind` | `none` | `onebot` 启用采集 |
| `collector.baseUrl` | `http://127.0.0.1:3000` | OneBot HTTP 地址 |
| `collector.token` | 空 | OneBot 侧配置的 access token |
| `collector.syncMedia` | `true` | 是否下载媒体文件到本地归档 |

### 4.2 环境变量覆盖（适合放 systemd `EnvironmentFile`）

所有覆盖都以 `QQ_ARCHIVE_` 开头，**优先于配置文件**：

```bash
QQ_ARCHIVE_CONFIG=/etc/qq-archive/config.json
QQ_ARCHIVE_HOST=127.0.0.1
QQ_ARCHIVE_PORT=8787
QQ_ARCHIVE_TOKEN=...            # 避免令牌落在配置文件里
QQ_ARCHIVE_DATA_DIR=/var/lib/qq-archive
QQ_ARCHIVE_DB_PATH=/var/lib/qq-archive/archive.db
QQ_ARCHIVE_MEDIA_DIR=/var/lib/qq-archive/media
QQ_ARCHIVE_BACKUP_DIR=/var/backups/qq-archive
QQ_ARCHIVE_COLLECTOR_KIND=onebot
QQ_ARCHIVE_COLLECTOR_URL=http://127.0.0.1:3000
QQ_ARCHIVE_COLLECTOR_TOKEN=...
QQ_ARCHIVE_COLLECTOR_INTERVAL=60
QQ_ARCHIVE_LOG_LEVEL=info
QQ_ARCHIVE_DISK_LOW_GB=5
QQ_ARCHIVE_ALERT_WEBHOOK=https://example.com/hook
QQ_ARCHIVE_TRUST_PROXY=0
```

密钥放 `EnvironmentFile` 时：

```bash
sudo install -m 600 -o qqarchive -g qqarchive /dev/null /etc/qq-archive/secrets.env
sudo tee /etc/qq-archive/secrets.env >/dev/null <<'EOF'
QQ_ARCHIVE_TOKEN=把强随机令牌写这里
QQ_ARCHIVE_COLLECTOR_TOKEN=OneBot的token
EOF
```

然后在 unit 里取消注释 `EnvironmentFile=-/etc/qq-archive/secrets.env`。

---

## 5. 安全说明（务必阅读）

1. **默认只听 127.0.0.1**。归档里有你的全部聊天记录，**不要直接暴露到公网**。
2. 需要远程访问时，推荐**只在 SSH 隧道里访问**（最安全，不需要改配置）：

   ```bash
   # 在你自己的电脑上执行
   ssh -N -L 8787:127.0.0.1:8787 user@server
   # 然后浏览器打开 http://127.0.0.1:8787/
   ```

3. 若确实要监听公网地址，**必须**同时做到：
   - `server.token` ≥ 32 位随机字符（用 `openssl rand -base64 32`）；
   - 用反向代理（Nginx/Caddy）加 **HTTPS**，并把 `server.trustProxy` 设为 `true`（否则登录限速按代理 IP 统计）；
   - 用防火墙或代理只放行你自己的 IP；
   - 定期看 `/api/logs` 里的 `auth` 作用域日志。
4. 令牌与 OneBot token **不要写进源码、不要提交到 git**。`config.json` 权限 `600`。
5. 数据库、媒体文件含隐私内容，备份目录同样要 `chmod 700`。
6. 日志已做脱敏（token/密钥/base64 会被替换为 `<redacted>`），但仍不要公开 `journalctl` 输出。
7. 媒体接口只从数据库读取文件相对路径，并对结果做前缀校验，**不接受任何用户提供的文件路径**。

---

## 6. 采集端（OneBot 实现）运行环境限制

采集端**本身不包含**任何 QQ 协议实现。它需要你在旁边部署一个提供 OneBot v11 HTTP 接口的实现，
常见选择：

| 实现 | 许可证 | 需要 QQ 客户端 | Linux 无头 | 备注 |
| --- | --- | --- | --- | --- |
| NapCatQQ | 自定义许可（**禁商用/禁发布修改版**，非 OSI 开源） | 是 | 支持 | 本项目实际对接验证的目标 |
| LLOneBot (LuckyLilliaBot) | GPL-2.0 | 是（LiteLoaderQQNT 插件） | 较弱 | 支持 OneBot11 |
| Lagrange.Core | **无 LICENSE 文件**（默认保留所有权利） | 否（纯协议实现） | 支持 | 封号风险更高，不建议主账号 |

**必须知道的技术限制**（有据可查，详见 `docs/qq-export-projects-research.md`）：

- **QQ 服务端的历史记录无法被完整获取**。OneBot 的历史消息接口读的是**客户端本地/会话视图**，
  NapCat 维护者在 [Issue #1838](https://github.com/NapNeko/NapCatQQ/issues/1838) 明确表示：
  机器人离线期间的消息**不会**被补齐，且这是**设计行为**（避免大量消息涌入）。
- NapCat **没有数据库**，消息缓存是 LRU，约 **5000 条**后被清理；已撤回消息无法再取回。
- **手机端未同步到电脑端的消息，没有任何 API 能拿到**。要拿只能走设备端解密导出
  （需 root/Frida），风险与门槛都高，本项目**不提供**这条路。
- 上游导出工具 QCE 的文档原文：「**任何响应都不能证明腾讯服务端的聊天记录完整性**」。

结论：**本系统的价值在于「一旦消息到达过采集端，就再也不会丢」**，而不是「把 QQ 服务端的历史都捞回来」。
所以采集端应当**长期挂着**（systemd 自动重启 + 开机自启），离线期间的消息窗口越短越好。

### 6.1 扫码登录（无头服务器上怎么让 NapCat 登录）

采集端需要**先登录 QQ** 才能拉消息。在无图形界面的服务器上，你有两种方式让 NapCat 登录，
两种都走 **NapCat WebUI 的 REST 接口**（与采集用的 OneBot 接口是两套东西、两个端口）：

1. **本系统网页里扫**：`qq-archive serve` → 浏览器进「QQ 登录」页 → 手机 QQ 扫码。
2. **终端里扫**：`qq-archive login` 把二维码用色块直接画在终端里，手机对着终端屏幕扫。

配置（`config.json` 的 `collector.napcat`）：

```jsonc
"collector": {
  "kind": "onebot",
  "baseUrl": "http://127.0.0.1:3000",
  "token": "OneBot 的 access token",
  "napcat": {
    "webuiUrl": "http://127.0.0.1:6099",  // NapCat WebUI 地址（会在 6099 之后自增端口）
    "token": "NapCat WebUI 的 token",     // 取自 NapCat 的 config/webui.json，**不是**上面那个 OneBot token
    "probeRange": 20
  }
}
```

常见退出码与处置：`3` = 连不上 WebUI 或 token 不对（检查 NapCat 是否在跑、`config/webui.json` 里的 token）；
`2` = 本系统配置/参数问题（`collector.napcat.token` 未填、`--uin` 非法）。

安全提醒：**二维码 URL 本身就是一次性的登录凭据**。本系统只在内存中流转它——网页端只下发
PNG（`data:` URL），终端只画色块；不会写进 JSON 响应、日志或文件。反过来说，**不要**把
NapCat WebUI 的端口暴露到公网（它自带 token 鉴权，但仍是本机管理面）。

### 采集端安全建议

- 用一个**专门的小号**或至少在 NapCat 官方建议的隔离环境里跑，不要与你的常用账号共用设备/IP。
- 只使用本项目的**只读**接口（`get_*`），不要把 OneBot 的 HTTP 端口暴露到公网。
- 采集端配置里只填 `baseUrl` 与 `token`，**不要**填 QQ 密码。

---

## 7. 备份

### 7.1 手动备份

```bash
qq-archive backup                  # 含完整性校验
qq-archive backup --no-verify      # 大库赶时间时跳过校验
qq-archive backup --label 升级前
```

备份产物结构：

```
/var/backups/qq-archive/2026-10-13T09-30-00-000Z/
├── archive.db          # SQLite 一致性快照（VACUUM INTO，不是文件拷贝）
├── manifest.json       # 消息/媒体计数、每个文件的 sha256、schema 版本、时间
├── media/              # 媒体文件（按原目录结构）
└── RESTORE.md          # 恢复步骤速查
```

### 7.2 自动备份

在配置里设 `backup.intervalHours`（默认 24）。服务运行期间会自动执行，
超过 `backup.keep` 份后删除最旧的。

### 7.3 恢复

**永远先 dry-run**：

```bash
# 1) 演练：只校验清单、sha256、计数，不修改任何数据
qq-archive restore /var/backups/qq-archive/2026-10-13T09-30-00-000Z

# 2) 确认无误后真正恢复（会先把当前库另存为 archive.db.bak-<时间戳>）
sudo systemctl stop qq-archive
qq-archive restore /var/backups/qq-archive/2026-10-13T09-30-00-000Z --apply
sudo systemctl start qq-archive
qq-archive stats     # 核对计数
```

恢复媒体（如果换了机器）：

```bash
rsync -av /var/backups/qq-archive/2026-.../media/ /var/lib/qq-archive/media/
```

### 7.4 备份完整性检查

```bash
# 校验数据库与媒体清单
qq-archive restore <备份目录>            # dry-run 会做 sqlite quick_check + 逐文件 sha256

# 校验当前正在使用的媒体文件是否与数据库记录一致
qq-archive verify

# 改了 filters 规则之后，对**已有消息**重算过滤标记（只改标记，不删消息）
qq-archive refilter
```

### 7.4 采集过滤怎么用

`filters` 段默认关闭，关闭时行为与没有这个功能完全一样。开启后按三类规则给消息**打标记**：

```json
"filters": {
  "enabled": true,
  "excludeKeywords": ["广告", "加群"],
  "excludeSenders": ["123456789"],
  "excludeTypes": ["system"],
  "drop": false
}
```

- **默认 `drop: false` = 只标记不丢弃**：命中的消息照样入库、`qq-archive refilter` 与导出都照带，
  只是网页时间线和搜索默认不显示；勾选「包含已过滤消息」即可看到，消息上会显示命中的规则。
- `drop: true` 才会让**之后采集到的**命中消息跳过存储（已入库的不会被删除）。
- 用 `qq-archive refilter` 在改规则后重算已有消息的标记；它是**幂等且可逆**的
  （把 `enabled` 关掉再跑一次即清空标记）。命令只改两列标记，**从不删除任何消息**。

> 提醒：这是防丢失系统。除非你确定"这些消息连存档都不要"，否则保持 `drop: false`。

---

## 8. 升级

```bash
cd /opt/qq-archive
qq-archive backup --label "升级前-$(date +%F)"     # 先备份
sudo systemctl stop qq-archive
sudo git pull
sudo npm install --omit=optional                  # 仅在需要类型检查时
sudo systemctl start qq-archive
qq-archive doctor                                  # 数据库迁移会自动执行
journalctl -u qq-archive -n 50
```

数据库迁移是**自动**的：启动时对比 `schema_migrations`，只执行未应用的版本，每个版本在事务里完成。
迁移**只做向后兼容的新增**（加表/加索引/加可空列），不会删除你的数据。

### 回滚

```bash
sudo systemctl stop qq-archive
sudo git checkout <上一个正常版本>
qq-archive restore <升级前的备份> --apply     # 若新版本已改动 schema
sudo systemctl start qq-archive
```

---

## 9. Windows 与 macOS

系统本身跨平台（只用 Node 内置模块）。区别只是**进程守护方式**。

### 9.1 Windows：仓库自带脚本（推荐）

`deploy/windows/` 下有一整套 PowerShell 脚本，**不依赖 NSSM**，默认以**当前用户**身份注册计划任务（不需要管理员）：

| 文件 | 作用 |
| --- | --- |
| `install.ps1` | 幂等安装器：检查 Node、建目录、生成配置、注册两个计划任务 |
| `uninstall.ps1` | 移除计划任务；默认保留数据，`-PurgeData` 才删 |
| `status.ps1` | 只读状态：任务状态 / 上次运行结果 / 日志尾部 / 配置与目录 |
| `run-collect.ps1` | 计划任务调用：跑一轮 `collect --once`，带日志与轮转 |
| `run-serve.ps1` | 计划任务调用：常驻 `serve`（网页 + API），带日志与轮转 |
| `check-syntax.mjs` | 纯 Node 静态自检器（本机没有 pwsh 时唯一能跑的门禁） |

```powershell
# 普通权限即可
powershell -ExecutionPolicy Bypass -File .\deploy\windows\install.ps1
.\deploy\windows\status.ps1                 # 看任务状态与上次运行结果
.\deploy\windows\uninstall.ps1 -PurgeData   # 连数据一起删
```

默认注册两个任务：`QQArchive-Collect`（每 15 分钟跑一次 `collect --once`）与
`QQArchive-Serve`（登录后 30 秒启动常驻 `serve`）。参数详见
[`deploy/windows/README.md`](../deploy/windows/README.md)。

> **诚实声明（重要）**：本项目的开发与测试环境是 Linux，**没有 `pwsh`/`powershell`**，
> 因此这些脚本**从未在真实 Windows 上执行过**。已做的是 `node deploy/windows/check-syntax.mjs`
> 静态自检 —— 它检查 `param(` 声明、参数被引用、`$PSScriptRoot` 推导、`ExecutionPolicy`
> 用法、日志轮转、只读 `status` 等 **80 项**，全部通过。**静态检查不等于能在真实 PowerShell 上跑通**，
> 首次部署请按 `deploy/windows/README.md` §4.2 的手工验收清单逐条确认。

手工方式（不想用脚本时）：用「任务计划程序」创建开机启动任务，程序填 `node`，参数填
`--experimental-strip-types <路径>\apps\cli\src\main.ts serve`，起始位置填项目根目录，
并设置「失败后重启」。

### 9.2 macOS

写一个 `launchd` plist（`~/Library/LaunchAgents/com.qqarchive.plist`），
`ProgramArguments` 同上，`KeepAlive=true`，`RunAtLoad=true`。

两种系统都建议把 `server.host` 保持 `127.0.0.1`。

---

## 10. 故障排查

| 症状 | 排查 |
| --- | --- |
| 服务起不来 | `qq-archive doctor`；`journalctl -u qq-archive -n 100`。配置错误会直接在启动时打印原因并退出（退出码 2） |
| 网页打不开 | 确认监听地址：默认只有本机可访问。远程请用 SSH 隧道 |
| 忘记令牌 | `qq-archive token` |
| 采集一直失败 | `qq-archive doctor` 看「采集端可用」一项；确认 OneBot HTTP 服务在 `collector.baseUrl` 可达；401 说明 `collector.token` 不对 |
| 导入报格式未知 | 用 `--format qce-json|qce-jsonl|qce-txt|generic-jsonl|html` 强制指定；确认文件不是加密/二进制格式。**导出为网页（HTML）的聊天记录也支持**，但探测是保守的：不像聊天页就不认，请用 `--format html` 显式指定 |
| 媒体显示「缺失」 | 源文件在导出时就已经不存在（QQ 缓存被清理）。系统**不会伪造**文件，只会标记。可在源机器上重新导出后再次 `import`（幂等，不会重复计数） |
| 磁盘告警 | 清理旧备份（`backup.keep`）、`qq-archive verify` 后清理损坏媒体，或迁移到更大磁盘 |
| 中文搜不到 | 确认搜的是 ≥2 个汉字（单字走字面匹配）；关键字命中在 `/api/search` 有 `<mark>` 片段 |
