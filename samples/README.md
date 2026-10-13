# 脱敏示例数据（samples/demo-export）

**这里没有任何真实聊天记录。** 全部内容由固定种子的伪随机数生成，可逐字节复现。

数据由本仓自带的生成器产出：

```bash
node --experimental-strip-types tests/fixtures/generate.ts samples/demo-export
```

生成器源码见 [`tests/fixtures/generate.ts`](../tests/fixtures/generate.ts)：消息正文、昵称、QQ 号、群号全部来自固定 seed 的 mulberry32 伪随机序列；媒体文件是**真实可解码**的 PNG/GIF/MP4（PNG 由代码手写字节生成，不依赖任何外部库）。

## 内容

| 路径 | 说明 |
| --- | --- |
| `group-export.json` | QCE 单文件 JSON 导出（群聊，覆盖图片/视频/文件/引用/长消息/撤回/系统消息） |
| `private-export.json` | QCE 单文件 JSON 导出（私聊） |
| `chunked/manifest.json` + `chunked/chunks/*.jsonl` | QCE 分块导出（清单 + JSONL 分块） |
| `legacy.txt` | TXT 导出（故意含一行无法解析的内容，用于容错路径） |
| `generic.jsonl` | 通用 JSONL（自定义格式接入示例） |
| `media/` | 6 个真实可解码的小体积媒体文件 |
| `expected.json` | 期望值，供一致性断言使用 |

规模：群聊 247 条（其中**故意重复 3 条**用于去重测试）+ 私聊 120 条 + 6 个媒体文件，总计约 330 KB。

## 用它跑一遍

```bash
cp config.example.json config.json && chmod 600 config.json
node --experimental-strip-types apps/cli/src/main.ts import samples/demo-export --account demo
node --experimental-strip-types apps/cli/src/main.ts stats
node --experimental-strip-types apps/cli/src/main.ts verify
```

导入时媒体会按内容寻址落盘并登记 `media` / `message_media` 两张表，`verify` 会逐个复核 sha256。

> `expected.json` 里记录的条数、媒体数与 sha256 可作为「导入是否原样落库」的对照基准。

## 为什么不用真实数据

真实聊天记录包含**第三方**（好友、群成员）的私人对话内容。即使把昵称与 QQ 号替换掉，自由文本仍可能通过上下文被重新识别，一旦推到公开仓库就无法收回。因此本仓的示例数据**完全合成**，与任何真实账号无关。
