# Windows 部署（任务计划程序）

本目录把 QQ 归档系统部署到 Windows。**只用 Windows 自带的任务计划程序
（ScheduledTasks 模块，Windows 8 / Server 2012 起随系统提供）**，不依赖
[NSSM](https://nssm.cc/)、不需要下载任何东西、不写注册表服务项。

Node 本体是跨平台的（只用内置模块），Windows 与 Linux 的差别**只在于进程守护方式**：
Linux 用 systemd，Windows 用计划任务。归档的数据库、媒体、备份格式完全一致。

---

## 0. 文件清单

| 文件 | 作用 |
| --- | --- |
| `install.ps1` | 幂等安装器：检查 Node、建目录、生成配置、注册两个计划任务 |
| `uninstall.ps1` | 移除计划任务；默认保留数据，`-PurgeData` 才删 |
| `status.ps1` | 只读状态：任务状态 / 上次运行结果 / 日志尾部 / 配置与目录 |
| `run-collect.ps1` | 计划任务调用：跑一轮 `collect --once`，带日志与轮转 |
| `run-serve.ps1` | 计划任务调用：常驻 `serve`（网页 + API），带日志与轮转 |
| `check-syntax.mjs` | 纯 Node 静态自检器（本机没有 pwsh 时唯一能跑的门禁） |
| `README.md` | 本文档 |

两个计划任务：

| 任务名（默认） | 触发 | 运行内容 |
| --- | --- | --- |
| `QQArchive-Collect` | 每 15 分钟（`-CollectIntervalMinutes` 可改） | `qq-archive collect --once` |
| `QQArchive-Serve` | 用户登录后 30 秒 | `qq-archive serve`（常驻） |

---

## 1. 前置条件

| 项目 | 要求 |
| --- | --- |
| Windows | Windows 10 / 11、Windows Server 2016+（需要 `ScheduledTasks` 模块与 PowerShell 5.1） |
| PowerShell | **Windows PowerShell 5.1**（系统自带）。脚本刻意没有用 PowerShell 7 专属语法 |
| Node.js | **≥ 22.5**（需要 `node:sqlite` 与 TypeScript 类型剥离）。推荐 24.x LTS |
| 磁盘 | 建议按媒体总量的 2 倍预留（备份需要空间） |
| 可选 | `ffmpeg`（视频缩略图）。缺失不影响归档 |

装 Node.js：到 <https://nodejs.org/> 下载 LTS 版 `.msi` 安装，**勾选**「Add to PATH」，
然后**重开一个 PowerShell 窗口**再验证：

```powershell
node --version      # 应输出 v22.5.0 或更高
```

> 为什么必须重开窗口：PATH 是进程启动时读取的，安装程序改了系统 PATH，
> 但已经打开的终端不会自动刷新。这是「明明装了 node 却提示找不到」的最常见原因。

---

## 2. 安装

### 2.1 最短路径（推荐：当前用户，不需要管理员）

把仓库放到任意位置（**路径可以含空格**，脚本会正确加引号），然后用**普通权限**的
PowerShell 执行：

```powershell
cd <仓库根目录>
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\deploy\windows\install.ps1
```

想先看会做什么、不真正改动系统：

```powershell
.\deploy\windows\run-collect.ps1 -DryRun
.\deploy\windows\run-serve.ps1 -DryRun
```

安装器依次做这些事（顺序固定，任一步失败就整体停下，不留半套安装）：

1. 从 `$PSScriptRoot` 向上两层推导仓库根目录，校验 `apps\cli\src\main.ts` 存在；
2. 解析 `node.exe` 的**完整路径**并校验版本 ≥ 22.5（低于就 `throw`，不会装完再失败）；
3. 创建 `data\`、`data\logs\`、`data\backups\`、`data\media\`；
4. `config.json` 不存在时从 `config.example.json` 复制一份（**已存在则保留不动**）；
5. 注册两个计划任务（同名旧任务先移除，所以重复执行是安全的）；
6. 立刻跑一轮采集做验收，并在结束时打印路径与下一步命令。

### 2.2 常用参数

```powershell
# 换配置文件位置
.\deploy\windows\install.ps1 -ConfigPath D:\qq-config\config.json

# 换任务名与采集间隔
.\deploy\windows\install.ps1 -TaskName MyArchive-Collect -ServeTaskName MyArchive-Serve -CollectIntervalMinutes 5

# 仓库不在推导出来的位置（例如脚本被复制到别处）
.\deploy\windows\install.ps1 -RepoRoot D:\code\QQ

# 以 SYSTEM 身份运行（需管理员）：注销后仍持续采集
.\deploy\windows\install.ps1 -RunAsSystem
```

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `-Action` | `Install` | `Install` / `Uninstall` / `Status` |
| `-ConfigPath` | `<仓库根>\config.json` | 配置文件路径 |
| `-RepoRoot` | `$PSScriptRoot\..\..` | 仓库根目录 |
| `-InstallPath` | 等于 `-RepoRoot` | 计划任务的「起始位置」 |
| `-TaskName` | `QQArchive-Collect` | 定时采集任务名 |
| `-ServeTaskName` | `QQArchive-Serve` | 网页服务任务名 |
| `-CollectIntervalMinutes` | `15` | 采集间隔（分钟，最小 1） |
| `-MinNodeMajor` | `22` | 最低 Node 主版本（同时要求 ≥ 22.5） |
| `-KeepCollectLogs` / `-KeepServeLogs` | `30` / `8` | 保留日志份数 |
| `-RunAsSystem` | 关 | 以 SYSTEM 注册任务（需管理员） |

### 2.3 管理员 vs 当前用户

| | 当前用户（默认） | `-RunAsSystem` |
| --- | --- | --- |
| 需要管理员权限 | **不需要** | 需要 |
| 注销后是否继续 | **停止**（登录时任务也消失） | 继续 |
| 能访问映射的网络驱动器 | 能（在同一个登录会话里） | **不能**（服务账户无法访问映射驱动器） |
| 适合谁 | 个人电脑，自己登录着用 | 想 7×24 采集的机器 |

---

## 3. 配置

配置文件默认在**仓库根目录的 `config.json`**（相对路径 `dataDir` / `logDir` 等
以**配置文件所在目录**为基准解析）。安装器只负责复制模板，**不会**改写你已经改过的文件。

关键字段：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `server.host` | `127.0.0.1` | **默认只允许本机访问**。改成 `0.0.0.0` 前请先读安全说明 |
| `server.port` | `8787` | 网页端口 |
| `server.token` | 空 | 留空即可：首次运行会自动生成随机令牌并写回 `config.json` |
| `storage.dataDir` | `./data` | 数据根目录 |
| `storage.backupDir` | `<dataDir>/backups` | 备份目录，建议放另一块磁盘 |
| `collector.kind` | `none` | 改成 `onebot` 才会真正采集 |
| `collector.baseUrl` | `http://127.0.0.1:3000` | OneBot（NapCat / LLOneBot）地址 |
| `collector.token` | 空 | OneBot 侧的 access token |

查看登录令牌（在仓库根目录执行，任选一种）：

```powershell
node bin\qq-archive.mjs token
node --experimental-strip-types apps\cli\src\main.ts token
```

> 如果安装后马上 `serve`，而 `config.json` 里的 `token` 是空的，CLI 会自动生成一个
> 并写回文件。用上面的命令读到的就是它。

### 3.1 让采集真正开始工作

1. 先在本机跑起一个提供 OneBot v11 HTTP 接口的实现（NapCat / LLOneBot）。
2. 改 `config.json`：`collector.kind` → `"onebot"`，填好 `baseUrl` 与 `token`。
3. 手动验证一轮：

   ```powershell
   .\deploy\windows\run-collect.ps1
   ```

   退出码 `0` = 成功，`2` = 采集未启用（`kind` 不是 `onebot`），
   `3` = 连不上采集端（OneBot 没跑，或 URL/token 不对）。

4. 之后计划任务每 15 分钟自动跑一轮。

### 3.2 采集端的真实边界（Windows 不改变这一点）

- **离线期间的消息不会补齐** —— QQ 服务端不提供，NapCat 维护者已明确说明这是设计行为。
- **已撤回的消息取不回**。
- **手机端没同步到电脑端的记录，任何 API 都拿不到**。

所以本系统的保证是「**一旦消息到达过采集端，就再也不会丢**」，
而不是「QQ 删了也能救回来」。采集端要尽量长期挂着，离线窗口越短越好。

---

## 4. 验证

### 4.1 静态自检（任何平台都能跑，本项目 CI 用这个）

本目录自带一个**零依赖**的检查器，逐文件校验 `{}` / `()` / `[]` 配对、引号与
here-string 闭合、必需参数是否声明、调用的 `qq-archive` 子命令与选项是否真实存在、
是否硬编码绝对路径、是否误用 PowerShell 7 专属语法：

```powershell
node deploy\windows\check-syntax.mjs
```

（在 Linux/macOS 上同样可以跑：`node deploy/windows/check-syntax.mjs`。）

> **UTF-8 BOM 是硬要求。** Windows PowerShell 5.1 对「没有 BOM 的 UTF-8」会按系统
> ANSI 代码页解码：脚本里的中文注释和中文字符串会变乱码，严重时连引号都被拆开而直接
> 语法报错。本目录的 5 个 `.ps1` 都已带 BOM，检查器里也有对应断言。如果编辑工具把 BOM
> 去掉了，跑这条幂等的修复命令补回来（已有 BOM 的文件一个字节都不动）：
>
> ```powershell
> node deploy\windows\check-syntax.mjs --fix-bom
> ```

### 4.2 Windows 上的手工验收清单

```powershell
# 1) 任务是否注册、上次运行结果是什么
.\deploy\windows\status.ps1

# 2) 立即跑一轮采集（前台，能直接看到完整输出）
.\deploy\windows\run-collect.ps1

# 3) 环境自检（配置 / 依赖 / 权限 / 磁盘 / ffmpeg）
node bin\qq-archive.mjs doctor

# 4) 打开网页，用 `token` 命令打印的令牌登录
start http://127.0.0.1:8787/

# 5) 手动验证网页任务是否能起来（前台 5 秒即可）
.\deploy\windows\run-serve.ps1
```

任务计划程序图形界面里也能看：`taskschd.msc` → 任务计划程序库 →
`QQArchive-Collect` / `QQArchive-Serve` → 「上次运行结果」。

---

## 5. 升级

```powershell
# 1) 先备份（升级前必备）
node bin\qq-archive.mjs backup --label "升级前-$(Get-Date -Format yyyyMMdd)"

# 2) 停掉网页任务（如果它正在跑）
Stop-ScheduledTask -TaskName QQArchive-Serve

# 3) 更新代码（git pull / 覆盖文件）

# 4) 重跑安装器：它会重建任务，但**保留** config.json 与全部数据
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\deploy\windows\install.ps1

# 5) 验证
.\deploy\windows\status.ps1
node bin\qq-archive.mjs doctor
```

数据库迁移是**自动**的：启动时对比 `schema_migrations`，只执行未应用的版本，
每个版本在事务里完成。迁移**只做向后兼容的新增**（加表 / 加索引 / 加可空列），
不会删除你的数据。

### 回滚

```powershell
Stop-ScheduledTask -TaskName QQArchive-Serve
# 切回上一版代码
node bin\qq-archive.mjs restore <升级前的备份目录>          # 先 dry-run
node bin\qq-archive.mjs restore <升级前的备份目录> --apply  # 确认无误再真恢复
```

---

## 6. 卸载

```powershell
# 默认：只移除两个计划任务，保留 config.json 与 data\（数据库 / 媒体 / 备份）
.\deploy\windows\uninstall.ps1

# 连数据一起删（会二次确认，输入 yes 才执行）
.\deploy\windows\uninstall.ps1 -PurgeData

# 无人值守（跳过确认）
.\deploy\windows\uninstall.ps1 -PurgeData -Force
```

`uninstall.ps1` **不会删除 `config.json`** —— 它含登录令牌，而且是用户自己改过的文件，
卸载器擅自删除风险太大。要删请自己确认后手动删。

如果任务名改过，卸载时也要带上同样的名字，否则会找不到：

```powershell
.\deploy\windows\uninstall.ps1 -TaskName MyArchive-Collect -ServeTaskName MyArchive-Serve
```

---

## 7. 坑点（都是 Windows 计划任务特有的，逐条踩过才写在这里）

### 7.1 计划任务的「起始位置」必须显式设置

计划任务默认的工作目录是 `C:\Windows\System32`。而本项目的 `config.json` 里
`dataDir: "./data"` 是**相对配置文件所在目录**解析的（配置路径本身如果是相对的，
才会按当前工作目录找）。听起来好像没事——但 **`--config` 传相对路径时就是按 CWD 找的**，
在 `System32` 下会找不到配置，然后按默认值启动、把 `data\` 建到 `System32` 里（通常还因
权限失败）。

所以：`install.ps1` 会把 `-WorkingDirectory` 显式设为仓库根目录，
且传给 CLI 的 `--config` 一律是**绝对路径**（`Resolve-AbsolutePath` 做的这件事）。
你自己手写计划任务时，也要保证这两点。

### 7.2 `-ExecutionPolicy Bypass` 不是可选项

Windows 默认执行策略是 `Restricted`（客户端）或 `RemoteSigned`（服务器）。
从别人机器/压缩包复制过来的 `.ps1` 带「来自 Internet」的标记，`RemoteSigned` 会直接拒绝。
表现是**任务一闪而过、退出码非 0、但没有任何输出**——非常难查。

所以计划任务的动作里必须带：

```
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "…\run-collect.ps1"
```

手动执行时也要带（README 里所有示例都带了）。

### 7.3 服务账户看不到「映射的网络驱动器」

映射驱动器（`net use Z: \\server\share`）是**每个登录会话**的，存在于
`HKEY_CURRENT_USER\Network`。以 `SYSTEM` 或其它服务账户运行的计划任务：
**看不到任何你在资源管理器里映射的盘符**。

正确做法是用 **UNC 路径**（`\\server\share\...`）而不是盘符，并且让任务账户对该共享
有显式权限（共享权限 + NTFS 权限两层都要给）。或者干脆用默认的「当前用户」任务，
和你的登录会话在同一环境里。

另外：本项目的 `backupDir` 建议放**另一块物理磁盘**（例如 `D:\qq-backup`），
如果非要放网络共享，请确保上面这条前提成立。

### 7.4 路径含空格要加引号

`C:\Program Files\...` 这类路径如果没有引号，`node` 会把 `C:\Program` 当成入口文件。
本目录的脚本对**每一个**进入命令行的路径都做了引号处理（`ConvertTo-ArgToken`），
包括结尾带反斜杠的特殊情况（`\"` 会被当成转义引号，所以要把连续反斜杠翻倍）。

你自己在计划任务里手填「程序或脚本」时也要注意：**参数框里**的路径必须加引号，
而「程序或脚本」框**不要**加引号。

### 7.5 后台作业在注销时会停止

- 默认（当前用户）的 `QQArchive-Serve` 任务绑定在**登录会话**上：注销后进程被结束。
- `QQArchive-Collect` 是一次性进程，即使绑定当前用户，也只在触发时必须有一个会话
  （配 `-RunAsSystem` 才能在没有登录时也跑）。
- 计划任务在「停止任务 / 注销 / 关机」时用的是 `TerminateProcess`，
  **不会**给进程发 SIGTERM —— 也就是说 `run-serve.ps1` 里那句「优雅关闭」实际上不成立。
  对本项目影响可控：数据是 SQLite + WAL，被杀掉一般不会损坏，
  未 checkpoint 的 WAL 会在下次启动时合并。但**不要**依赖它做严格的关闭前备份。

### 7.6 注销/关机前手动备份

因为没有优雅关闭，建议养成习惯（或另建一个「关机前」触发器的任务）：

```powershell
node bin\qq-archive.mjs backup --label "关机前"
```

### 7.7 任务「正在运行」不等于业务正常

判定标准是「**上次运行结果**」那一列，不是状态列。注意区分这几个常见值：

| 值 | 含义 |
| --- | --- |
| `0x0` | 成功 |
| `0x2` | 找不到文件（多数是 Node 不在任务账户的 PATH 里） |
| `0x41303` | 任务尚未运行 |
| `0x41301` | 正在运行 |
| `0x41306` | 被用户终止 |

`status.ps1` 会把这些翻译成人话。另外本项目特意把采集拆成 `collect --once`
每 15 分钟一轮（而不是常驻），就是为了让「进程悄悄死了但任务还显示正在运行」
这种情况不存在——每一轮的退出码都直接反映这一轮的成败。

### 7.8 Node 的 PATH 问题

计划任务不加载你的 PowerShell 配置文件，用的是**任务账户**的环境。如果你用
`nvm-windows` 之类动态切 PATH 的工具，任务启动时可能找不到 `node`。

`install.ps1` 的做法是：安装时解析出 `node.exe` 的**绝对路径**写进任务动作，
所以之后不再依赖 PATH。但升级 Node 之后路径可能变化（例如 nvm 切换版本），
需要重跑 `install.ps1`。

---

## 8. 已验证 / 未验证（诚实说明）

### 已在本环境实际验证

| 项目 | 证据 |
| --- | --- |
| `check-syntax.mjs` 自身可运行、能通过 | `node deploy/windows/check-syntax.mjs` 实跑，输出见仓库提交记录 / 下方命令 |
| 静态检查覆盖 `{}`/`()`/`[]` 配对、引号与 here-string 闭合 | 检查器按词法逐字符扫描（含注释、here-string、`''` 与 `` `" `` 转义） |
| 必需参数声明齐全 | 5 个 `.ps1` 的 `param()` 参数名逐一比对清单 |
| `qq-archive` 子命令与选项名真实存在 | 与 `apps/cli/src/main.ts` 的 `usage()` 逐字比对（`collect --once`、`serve --config` 等） |
| 脚本调用的其它 `.ps1` 都存在 | 交叉引用检查 |
| 没有硬编码绝对路径 | 只允许 `$PSScriptRoot` 推导 |

### **未验证**（必须在真实 Windows 上跑一遍才能确认）

以下内容**一行都没有在真实 PowerShell 上执行过**，因为开发环境是 Linux，
没有 `pwsh`（已用 `which pwsh powershell` 确认不存在）：

1. **`install.ps1` / `uninstall.ps1` / `status.ps1` / `run-*.ps1` 全部未执行**——
   连语法都没有经过 `powershell.exe -Command` 或 AST 解析器验证，只有上述静态检查。
2. **计划任务是否能成功注册**未验证：`New-ScheduledTaskTrigger -Once -RepetitionInterval`
   的接受度、`-RestartCount` 在当前 Windows 版本上是否存在、`Interactive` 主体
   对当前用户是否可用，都只是按文档写的，没有实机证据。
3. **`-RunAsSystem` 路径**未验证：管理员权限判定、SYSTEM 身份、UNC 路径访问都未实测。
4. **首轮采集验收**（安装器最后自动跑的那一次）未验证：退出码 0/2/3 的分支只在
   代码里存在，没有在 Windows 上看到过真实输出。
5. **日志轮转**未验证：`Get-ChildItem -Filter` 的匹配、`Sort-Object LastWriteTime`
   的稳定性、被占用文件删除失败的降级路径，都没有实机跑过。
6. **`Start-Process -RedirectStandardOutput` 的中文输出编码**未验证：
   Node 在 Windows 控制台的输出编码与重定向文件的编码可能不一致，
   中文日志可能出现乱码（**这是最可能出问题的一点**）。
7. **`config.json` 权限加固**未验证：脚本只做了「提示」，没有自动改 ACL。
8. **卸载的数据删除护栏**（只允许删 `<仓库根>\data`）未验证。

### 验证方式

在一台真实 Windows 上依次执行：

```powershell
node deploy\windows\check-syntax.mjs                          # 静态门禁
.\deploy\windows\install.ps1                                  # 安装
.\deploy\windows\status.ps1                                   # 看任务与日志
.\deploy\windows\run-collect.ps1                              # 手动一轮采集
node bin\qq-archive.mjs doctor                                # 环境自检
.\deploy\windows\install.ps1 -Action Status                   # 安装器的 status 分支
.\deploy\windows\uninstall.ps1                                # 卸载（保留数据）
.\deploy\windows\install.ps1 -Action Install -RunAsSystem     # 管理员：SYSTEM 路径
```

任何一步失败，请把**完整输出**（不是截图）贴回仓库 issue。

---

## 9. 安全提醒

1. 归档里是你的**全部聊天记录**。默认只听 `127.0.0.1`，**不要**直接暴露到公网。
2. 需要远程访问时推荐 SSH 隧道，或 Windows 自带的端口转发 + 反向代理 + HTTPS：

   ```powershell
   # 只在本机可用，然后自己想办法安全地访问本机
   ssh -N -L 8787:127.0.0.1:8787 user@windows-host
   ```

3. 要监听公网地址时**必须**：`server.token` ≥ 32 位随机、用反向代理加 HTTPS、
   并把 `server.trustProxy` 设为 `true`（否则登录限速按代理 IP 统计），
   同时用防火墙只放行你自己的 IP。
4. `config.json` 含令牌，**不要**提交到 git。建议在文件属性 → 安全里关闭继承，
   只保留你自己的账户。
5. 数据库、媒体、备份目录都含隐私内容，备份目录也要限制访问。
6. 日志已做脱敏（token / 密钥 / base64 会替换为 `<redacted>`），但仍不要公开。
