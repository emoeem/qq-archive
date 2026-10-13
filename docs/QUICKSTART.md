# 怎么把它跑起来用（照着做即可）

> 本文的每一条命令都在本机实际跑过，输出就是下面贴的那些。
> 最小的那一步只需要 **Node.js ≥ 22.5**，不需要 `npm install`（本项目生产依赖为 0）。

它由**两个独立的部分**组成，先分清这一点，后面就不会乱：

| 部分 | 是什么 | 跑在哪 | 必须吗 |
| --- | --- | --- | --- |
| **归档服务器** | 数据库 + 网页 + API + 媒体存储（本项目） | 你的电脑或 Linux 服务器 | **必须** |
| **采集端** | 通过 OneBot 接口读到 QQ 消息的东西（NapCat） | 需要一台能跑 QQ 客户端的机器 | 只有"持续采新消息"才需要 |

> 只想把**已有的导出文件**存起来 + 网页看？**只做 Part A 就够了**。

---

## Part A：把归档服务器跑起来（约 3 分钟）

### A1. 前置检查

```bash
node --version        # 需要 >= 22.5（实测 24.21 可用）
```

### A2. 拿到源码并配置

源码目录里**唯一需要动的文件**是 `config.json`：

```bash
cd /path/to/QQ
cp config.example.json config.json
chmod 600 config.json          # 里面会写入登录令牌
```

> `config.json` **可以带注释和尾逗号**（`//`、`/* */` 都行），手改起来方便；
> 程序首次把自动生成的令牌写回时会**保留你写的注释**。

代码只有 **2.3 MB**，`node_modules` 不需要存在（实测：拷源码时排除 `node_modules` 后照样跑通全流程）。

### A3. 自检（第一次运行会自动生成令牌、建库、跑迁移）

```bash
node --experimental-strip-types apps/cli/src/main.ts doctor
```

实测输出：

```
✓ 数据目录存在: /tmp/fresh-install/data
✓ 数据库可读写，schema v6（最新 v6）
✓ 管理令牌已设置（32 字符）
✓ 默认仅本机可访问（127.0.0.1）
✓ ffmpeg 可用（视频缩略图/转码已启用）
✓ 磁盘剩余空间 15.2 GB
✓ 采集未启用（collector.kind = none）；仍可用 import 导入导出文件
```

> 令牌**不用你自己编**：`doctor` 发现是空的时候会生成一个 32 位随机串并写回 `config.json`。
> 想自己指定也行，填一个 ≥32 位的随机字符串即可。

### A4. 导入已有聊天记录（可选但推荐）

支持导入 QQ Chat Exporter 的 `json` / 分块 `jsonl` / 旧版 `txt`，以及通用 `jsonl` 和 HTML 页面；
格式**自动识别**，不用指定。

```bash
node --experimental-strip-types apps/cli/src/main.ts import ~/Downloads/群聊导出.json
```

实测（合成样本，247 条源数据）：

```
▶ 导入 group-export.json
  格式 qce-json｜解析 247｜新增 244｜重复 3｜失败 0
  媒体 归档 15 次｜缺失 1｜耗时 1482ms
汇总：文件 1｜新增 244｜重复 3｜失败 0｜文件级失败 0
```

重复导入同一个文件是**幂等**的（第二次新增 0 条），所以放心重复跑。

### A5. 起服务，打开网页

```bash
node --experimental-strip-types apps/cli/src/main.ts token    # 查看登录令牌
node --experimental-strip-types apps/cli/src/main.ts serve    # 默认只监听 127.0.0.1:8787
```

浏览器打开 `http://127.0.0.1:8787`，粘贴上一步的令牌登录。

实测：

```
健康检查：200        网页首页：200
未登录访问 /api/sessions：401    登录后：200
```

### A6. 嫌命令长？装成全局命令

```bash
npm link        # 或 pnpm link --global
qq-archive serve
qq-archive import ~/Downloads/群聊导出.json
qq-archive stats
```

不想动全局环境就写个别名：

```bash
alias qq-archive='node /绝对路径/QQ/bin/qq-archive.mjs'
```

### A7. 常用命令一览

```bash
qq-archive serve                 # 起网页 + API（默认 127.0.0.1:8787）
qq-archive import <文件或目录>    # 导入导出文件（目录会递归扫描）
qq-archive collect --once        # 立刻采集一轮（需先配好 Part B）
qq-archive collect               # 常驻定时采集
qq-archive stats                 # 归档统计
qq-archive logs --limit 50       # 最近日志
qq-archive backup                # 立即备份（含完整性校验）
qq-archive restore <备份目录>     # 恢复演练（默认 dry-run，只校验不动数据）
qq-archive restore <备份目录> --apply   # 真正恢复（会先把当前库另存为 .bak）
qq-archive verify                # 重新校验所有媒体文件的 sha256
qq-archive refilter              # 按当前 filters 规则重算已有消息的过滤标记
qq-archive login                 # QQ 扫码登录（二维码直接画在终端）
qq-archive transcribe            # 转写待处理语音（需 stt.enabled=true）
qq-archive doctor                # 环境自检
```

---

## Part B：接上采集端（要"持续采新消息"才需要）

采集端不是本项目的一部分，需要你自己装一个 OneBot 实现。**NapCat 是目前最常用、也是本机在用的那个。**

### B1. 先把 NapCat 跑起来（一条命令）

```bash
qq-archive collector setup --write-config
```

自动检测 podman/docker、拉取 NapCat 官方镜像、按正确端口与挂载起容器，并**把两个 token
自动写进 config.json**（写前备份）。`qq-archive collector status` 看现状。
下面是等价的手工方式，想自己控制容器时用。

<details>
<summary>手工 podman run（等价）</summary>

### 手工方式

本机实际在用的这套参数（`podman` 换成 `docker` 一样可以）。注意：**注释要单独成行**，
不能写在 `\` 续行后面（那样 bash 会把注释当成参数）。

```bash
mkdir -p ~/napcat/data/config ~/napcat/data/qq ~/napcat/data/plugins

# 3000 = OneBot HTTP（本项目连的就是它）；6099 = NapCat WebUI（扫码登录用）
# 端口只绑 127.0.0.1：OneBot 的 HTTP 端口等于你 QQ 账号的读写权限，别暴露到公网
podman run -d --name napcat-qq --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  -p 127.0.0.1:6099:6099 \
  -v ~/napcat/data/config:/app/napcat/config \
  -v ~/napcat/data/qq:/app/.config/QQ \
  -v ~/napcat/data/plugins:/app/napcat/plugins \
  docker.io/mlikiowa/napcat-docker:latest
```

</details>

### B2. 让它登录 QQ

两种方式，实测都可用：

```bash
# 方式一：本项目网页里的「QQ 登录」页，或终端里直接渲染二维码
qq-archive login

# 方式二：打开 NapCat 自己的 WebUI http://127.0.0.1:6099 扫码
```

已登录过的账号以后可以**快捷登录**（不用再扫码）：网页「QQ 登录」页会列出本机保存的账号，一键上线。

### B3. 打开 OneBot 的 HTTP 服务，并拿到 token

NapCat 的配置在容器里映射出来的这个文件（文件名带你的 QQ 号）：

```
~/napcat/data/config/onebot11_<你的QQ号>.json
```

关键字段（本机实际值）：

```jsonc
"network": {
  "httpServers": [
    {
      "name": "qq-archive",
      "host": "0.0.0.0",
      "port": 3000,
      "enable": true,                 // 必须是 true
      "messagePostFormat": "array",   // 本项目按 array 解析
      "token": "……40 位随机串……"      // 下面 config.json 里要填的就是它
    }
  ]
}
```

改完这个文件后重启容器：`podman restart napcat-qq`。

### B4. 把两边的配置对上

在本项目的 `config.json` 里填：

```jsonc
"collector": {
  "kind": "onebot",                    // none = 不采集，只做离线导入
  "baseUrl": "http://127.0.0.1:3000",  // 对应 httpServers.port
  "token": "……与上面那个 40 位串完全一致……",
  "intervalSec": 60,                   // 每 60 秒一轮

  "napcat": {                          // 只有「网页扫码登录」用得到这一段
    "webuiUrl": "http://127.0.0.1:6099",
    "token": "……NapCat WebUI 的密码，见下……"
  }
}
```

⚠️ **两个 token 不是同一个东西**，这是最容易踩的坑：

| 字段 | 从哪来 | 用途 |
| --- | --- | --- |
| `collector.token` | `onebot11_<QQ号>.json` 里 `httpServers[].token` | 读消息 |
| `collector.napcat.token` | NapCat WebUI 的密码（首次打开 WebUI 时设置的那个；可改） | 扫码登录 |

### B5. 验证采集

```bash
qq-archive collect --once
```

实测输出：

```
已连接采集端：示例账号 (1000000001)
一轮采集完成：会话 13｜拉取 27｜新增 0｜重复 27｜失败 0
媒体：保存 0｜缺失 0
```

`重复 27` 是**去重生效**的意思（拉回 27 条，全都在库里了，一条没重复存）。
第一次跑会做一次初始回填（默认回看 3 天，`collector.initialBackfillDays` 可调）。

### B6. 让它一直跑（systemd）

仓库里已备好 unit 文件，照着改路径即可：

```bash
sudo cp deploy/qq-archive.service /etc/systemd/system/
sudo cp deploy/qq-archive-collect.service /etc/systemd/system/     # 采集单独一个 unit
sudo systemctl daemon-reload
sudo systemctl enable --now qq-archive          # 归档服务器（重启自愈）
sudo systemctl enable --now qq-archive-collect  # 采集端
systemctl status qq-archive
```

细节（用户、路径、环境变量、升级步骤）见 [DEPLOYMENT.md](DEPLOYMENT.md)。

---

## Part C：日常怎么用

| 我想…… | 怎么做 |
| --- | --- |
| 看某个人/某个群的聊天 | 网页「聊天记录」→ 左侧选会话 → 时间线（支持引用预览、图片缩略图） |
| 按关键词找消息 | 网页顶部搜索框（中文子串可用，命中会高亮） |
| 看/下载图片视频 | 网页「媒体管理」→ 筛选类型/会话/日期 → 预览、播放、下载 |
| 把某个会话导出带走 | 时间线右上角「导出」（json / jsonl / txt） |
| 少看点不想看的 | 配 `filters`（默认只标记不丢弃）→ `qq-archive refilter` |
| 备份 | `qq-archive backup`（自动备份默认每 24h 一次） |
| 换机器 / 迁移 | 把 `data/` 整个拷走；`data/` 里含数据库（`archive.db`）、媒体（`media/`）、备份（`backups/`） |
| 升级到新版本 | 先 `qq-archive backup --label 升级前` → 换源码 → 重启；迁移会在启动时自动执行 |

---

## Part D：常见问题

**Q：`serve` 起来后浏览器打不开？**
默认只监听 `127.0.0.1`（只有本机能访问）。要从别的机器访问必须显式改 `server.host`
并配 TLS 反向代理——聊天记录不该默认暴露在网络上。

**Q：网页提示令牌错误？**
用 `qq-archive token` 打印当前令牌（它读的是 `config.json`）。如果 `serve` 与 `token`
不是同一份配置（`--config` 指向不同文件），令牌自然对不上。

**Q：采集报「采集端不可用」？**
说明连不上 OneBot。依次查：容器在跑吗（`podman ps`）→ 端口对吗（`curl -H "Authorization: Bearer <token>" http://127.0.0.1:3000/get_login_info`）→
两边 token 一致吗 → QQ 掉线了吗（NapCat 重启后需要重新登录）。这些失败现在都会进
「归档管理 → 运行日志」，「为什么某一轮没采到」查得到。

**Q：手机上的老消息能补回来吗？**
**不能。** 手机端尚未同步到服务端的记录，QQ 不提供任何可取回的接口（详见
[INDEPENDENT-VERIFICATION.md](INDEPENDENT-VERIFICATION.md) 第 1 节）。本系统保护的是
**已经到达它**的数据：持续挂着采集端，把"离线窗口"压到最短。

**Q：会不会影响我的 QQ 账号？**
采集只调用 OneBot 的**只读**接口（白名单 11 个，代码里硬编码），发送/删除类接口在本地直接拒绝、
连请求都不会发出。风险与 NapCat 本身相同（属于第三方协议实现），建议用小号或隔离环境。
