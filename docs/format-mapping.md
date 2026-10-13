# 导出格式 → 归档模型 映射说明

本文描述 `packages/import` 如何把外部导出文件转换为本系统的标准模型，以及**哪些信息在转换后丢失或降级**。所有映射实现都在：

- `packages/import/src/qce-map.ts`（QCE 字段映射、时间解析、元素/资源/提及/引用提取）
- `packages/import/src/normalized-map.ts`（`generic-jsonl` 的归一化消息映射）
- `packages/import/src/txt-parse.ts` + `packages/import/src/importers/qce-txt.ts`（纯文本导出）
- `packages/import/src/media-util.ts` + `packages/import/src/media.ts`（媒体内容寻址归档）

标准模型定义见 `packages/core/src/types.ts`（`NormalizedSession` / `NormalizedMessage` / `ResourceRef` / `ImportBatch`），落库结构见 `packages/db/src/schema.sql`。

> **诚实声明**：下表描述的是「导入器当前真实的行为」，不是理想行为。**映射是有损的**，逐条见 §7。参考实现是只读的 `qq-chat-exporter`（GPL-3.0，仅用于确认格式，未复制其代码）；上游的 TXT 导出器在该参考仓库中**不存在**，所以 §6 的 TXT 解析是**尽力而为**，不是「官方 TXT 格式」。

---

## 1. 总览

```
文件 → detectFormat() → importerForFormat() → Importer.run(ctx)
        │                       │                    │
        │                       │                    ├─ mapQceMessage()/mapNormalizedLike() → NormalizedMessage
        │                       │                    ├─ MediaArchiver.archive()             → MediaInput
        │                       │                    └─ ctx.onBatch(ImportBatch) ──► db.insertMessages() + db.upsertMedia() + db.linkMessageMedia()
        │                       │
        │                       └─ 'qce-json' | 'qce-jsonl' | 'qce-txt' | 'generic-jsonl'
        └─ 'unknown'（拒绝导入，抛 AppError('UNSUPPORTED_FORMAT')）

ImportStats { totalItems, inserted, duplicate, failed, mediaSaved, mediaMissing, errors, … }
```

批量大小默认 500 条（`DEFAULT_BATCH_SIZE`）；错误最多记 200 条（`MAX_IMPORT_ERRORS`），超出后 `stats.errorsTruncated = true`。

### 1.1 格式探测规则（`detect.ts`）

只看文件头（默认 64 KiB，常数成本），按优先级：

| 优先级 | 判据 | 结果 |
| --- | --- | --- |
| 1 | 文件头整段 `JSON.parse` 成功，且对象含 `messages` 数组 | `qce-json` |
| 1 | 同上，但根是单个 QCE 消息对象（`sender`/`content`/数字 `timestamp`+`type`） | `qce-jsonl` |
| 1 | 同上，根是归一化消息对象（`msgKey`，或 `direction`/`msgType`，或数字 `ts`+字符串 `text`） | `generic-jsonl` |
| 1 | 根是 `{ chatInfo?, message }` 包装（内层像归一化消息 → `generic-jsonl`，否则 `qce-jsonl`） | 见左 |
| 2 | 第 0 列整行是完整 JSON 对象（行首无缩进）：出现 QCE 形态 → `qce-jsonl`；只有归一化消息 → `generic-jsonl` | 见左 |
| 3 | 首字符 `{`、前两轮未命中，但头部能搜到 `"messages":[` + `"metadata"/"chatInfo"/"statistics"` | `qce-json`（紧凑大文件兜底） |
| 4 | 头部像聊天记录 **HTML**（`looksLikeChatHtml`：`<html` + class 线索词消息容器 / 内嵌 JSON 状态） | `html` |
| 5 | 前 50 行匹配聊天 TXT 行模式 | `qce-txt` |
| 6 | 其他 | `unknown` |

第 2 条要求「第 0 列」是关键：QCE 的 pretty JSON 会把 `messages` 数组里的每条消息缩进 4 空格，不加这一条就会被误判成 JSONL。

`detectFormat(filePath)` 对不存在/不可读的文件抛 `AppError('BAD_REQUEST')`，对识别为 `unknown` 的文件在 `importFile` 阶段抛 `AppError('UNSUPPORTED_FORMAT')`。

---

## 2. 会话映射

| 导出字段（QCE `ChatInfo`） | `NormalizedSession` | `sessions` 列 | 说明 |
| --- | --- | --- | --- |
| —（调用方 `accountUid`） | `accountUid` | `account_uid` | 账号标识，默认 `default` |
| `type`（`group`/`private`/`temp`） | `chatType`（`group`/`private`/`temp`/`other`） | `chat_type` | 不认识的值 → `other` |
| `peerUid` | `peerUid` | `peer_uid` | 缺失时回退 `peerUin`，再回退字符串 `unknown` |
| `peerUin` | `peerUin` | `peer_uin` | |
| `name` | `name` | `name` | 缺失时用文件名/`未知会话` |
| — | `remark` | `remark` | QCE 无对应字段，通常为空 |
| `participantCount` | `memberCount` | `member_count` | |
| `selfUid` / `selfUin` / `selfName` | 同名字段 | 同名字段 | 用于判断 `direction` |
| — | — | `session_key` | `sessionKeyOf(chatType, peerUid)` = `<chatType>:<peerUid>` |
| 导入来源 | `source` | `source` | `qce-json` / `qce-jsonl` / `qce-txt` / `generic-jsonl` |
| `avatar`（URL） | — | — | **未映射**（会话头像不归档） |
| `metadata` / `statistics` | — | — | 仅进 `ImportBatch.sourceStats`（内存/任务选项），**不入库** |

`qce-jsonl` 分块导出没有 `chatInfo` 时，回退顺序：同目录 `manifest.json`（≤ 4 MiB）→ 行内头部行（`session`/`chatInfo`）→ `sessionHint` → 失败即用 `unknown/未知会话`。

---

## 3. 消息逐字段映射（QCE `CleanMessage` → `NormalizedMessage` → `messages` 表）

| QCE 字段 | `NormalizedMessage` | `messages` 列 | 说明 |
| --- | --- | --- | --- |
| `id` | `msgId` | `msg_id` | 字符串原样 |
| `seq` | `seq` | `seq` | 字符串原样；**不**用于排序（顺序按文件出现顺序） |
| `timestamp`（ms）/ `time`（`YYYY-MM-DD HH:mm:ss`） | `ts`（ms） | `ts` | ≥ 10^12 当毫秒；否则当秒 ×1000；否则 `parseTimeString`。`ts <= 0`/非有限 → **计入 failed，不入库** |
| — | — | `time_text` | 由 `ts` 重新格式化为本地时间 `YYYY-MM-DD HH:mm:ss`（原 `time` 字符串见 §7） |
| `sender.uid` | `senderUid` | `sender_uid` | |
| `sender.uin` | `senderUin` | `sender_uin` | |
| `sender.groupCard` → `nickname` → `name` → `remark` → uid/uin | `senderName` | `sender_name` | 只取**第一个**存在的值，优先级如左 |
| `isSelf`（或与 `selfUid`/`selfUin` 比对） | `isSelf` | `is_self` | 无 `selfUid`/`selfUin` 且无 `isSelf` 时为 `false` |
| 由 `system`/`isSelf` 推导 | `direction`（`in`/`out`/`system`） | `direction` | 系统消息 → `system` |
| `type`（`type_1` 等）+ 元素/资源/文本 | `msgType` | `msg_type` | 见 §3.1 |
| `recalled` | `recalled` | `recalled` | `true` 时原文仍保留 |
| `system` | `system` | `system` | |
| `content.text`（回退 `message.text`） | `text` | `text` | 空则 `''`；**不**从元素合成占位文本（导出器写的 `[图片]` 等由导出器提供） |
| `content.elements[]` | `elements[]` | `elements`（JSON） | 原样 `{type, data}`，最多 200 条入库 |
| `content.mentions[]` | `mentions[]` | `mentions`（JSON） | 并与 `at` 元素合并去重，最多 200 条 |
| `content.resources[]` | `resources[]` | （经 `media` + `message_media`） | 见 §4 |
| `reply` 元素 | `reply {msgKey, msgId, preview, senderName}` | `reply_to_msg_key`, `reply_to_id` | 引用目标 id 优先 `referencedMessageId` > `replyMsgId` > `msgId`/`messageId` |
| `forward` 元素 / `content.forwardId` | `forwardId` | `forward_id` + `extra.forward` | **导入**路径只留 id（被转发的消息不在这个文件里）；**采集**路径会调 `/get_forward_msg` 展开成树，见 §8 |
| `rawMessage`（或 `raw`） | `raw` | `raw`（JSON） | 16 384 字符上限，超出变 `{truncated, chars, preview}` |
| `time`, `content.html`, `sender.title/remark/groupCard/nickname`, 未知元素 | `extra` | `extra`（JSON） | 键名：`time`/`html`/`senderTitle`/`senderRemark`/`senderGroupCard`/`senderNickname`/`rawElements`/`qceType` |
| `sender.avatarBase64` | — | — | **丢弃**（体积巨大，流式导入时连同顶层 `avatars` 一起跳过） |

`msgKey`（唯一键，决定幂等）由 `packages/core/src/ids.ts: messageKeyOf()` 生成：有 `msgId` → `id:<msgId>`；否则 `sha256Hex(ts \u0001 senderUid \u0001 senderUin \u0001 text \u0001 seq \u0001 资源指纹)` 前 40 位加前缀。**注意**：因此「同一条消息换了手机号/文本被编辑」会生成不同 `msgKey`，重复导入不会合并。

### 3.1 `msgType` 推断（`inferMessageType`）

1. `system === true` → `system`
2. 有非空 `text` → `text`……但元素类型优先：`image` > `video` > `audio` > `file` > `face`（`reply`/`forward`/`json`/`location` 等按元素类型字面量取用）
3. 都没有 → `other`

### 3.2 `MessageElement` / `MessageResource` 映射

| QCE | 本系统 | 说明 |
| --- | --- | --- |
| `elements[].type` | `MessageElement.type` | 原样小写化后比较；未知类型整体进 `extra.rawElements` |
| `elements[].data` | `MessageElement.data` | 弱类型原样 JSON |
| `type:'reply'` | `reply` + 仍在 `elements` 里 | `data.id`/`replyMsgId`/`msgId` … → `msgId`；`content`/`text` → `preview` |
| `type:'at'` | `mentions[]`（uid/name/type） | `data.uid`/`data.name`；`data.type` 默认 `user`，`all` 表示 @全体 |
| `type:'face'`/`'market_face'` | `elements` + `msgType` | 只留表情 id，**不**抓表情图片 |
| `type:'json'`/`'location'`/`'system'` | `elements` | 只留原始 JSON，**不**解析卡片语义 |
| `resources[].type` | `ResourceRef.kind` | `image`/`video`/`audio`/`file`，其他 → `file` |
| `resources[].filename/size/url/localPath/width/height/duration` | 同名 | `duration` 单位：QCE 用秒（保留原值） |
| `resources[]` 与 `elements[]` 重复描述同一文件 | **按身份合并为 1 条** | 身份 = `kind|filename小写`（无 filename 时用 `kind|size|url|localPath`）；`resources` 优先，`elements` 只补缺字段 |

---

## 4. 媒体映射与内容寻址

| `ResourceRef`（候选） | `MediaInput` | `media` 列 |
| --- | --- | --- |
| 内容 sha256 | `sha256` | `sha256`（唯一） |
| `kind` | `kind` | `kind` |
| 实际字节数 | `size` | `size` |
| — | `relPath` | `rel_path` |
| 扩展名/MIME | `ext` / `mime` | `ext` / `mime` |
| `width`/`height`/`duration` | 同名 | 同名 |
| `localPath` | `originPath` | `origin_path` |
| `url` | `originUrl` | `origin_url` |
| 归档结果 | `status` | `status` |
| 失败原因 | `failReason` | `fail_reason` |
| `ensureThumb()` 产物 | `thumbPath` | `thumb_path` |

**落盘路径**（`mediaRelPath`）：`<mediaDir>/<kind>/<yyyy>/<mm>/<sha256 前 2 位>/<sha256>.<ext>`，`yyyy/mm` 取**本地时间**。写入流程：先写 `.incoming/<uuid>.part`，哈希与大小校验通过后 `rename()` 原子落位；目标已存在则丢弃临时文件（去重）。同一 `sha256` 只存一份，`media.ref_count` 记录被多少条消息引用。

**候选优先级**：`localPath` → `url`。两者都没有、文件不存在、URL 404、协议不允许、超过 `maxBytes`、下载超时 → `status='missing'` + `fail_reason`，**绝不写占位文件**。

> **缺失媒体的 `sha256` 是合成指纹，不是内容哈希**：`sha256Hex('missing\u0000' + JSON.stringify({kind,filename,url,localPath,size}))`，`size=0`，`relPath` 是「它本应占用的路径」但磁盘上不存在。这样重复导入同一份缺文件导出仍是幂等的；但**不要**把这类行当作内容寻址依据，也不要按 `rel_path` 去读文件（会 ENOENT）。

---

## 5. `generic-jsonl` 映射

每行一个「归一化消息风格」的 JSON 对象（本系统自己的导出/迁移格式）：

| 输入键 | `NormalizedMessage` | 备注 |
| --- | --- | --- |
| `msgKey` / `msg_key` | `msgKey` | 缺失则用 `messageKeyOf()` 生成 |
| `msgId` / `msg_id` | `msgId` | |
| `ts`（ms）/ `timestamp` | `ts` | 必填（否则计入 failed） |
| `direction` | `direction` | 缺失时按 `isSelf`/默认 `in` |
| `type` / `msgType` / `msg_type` | `msgType` | |
| `text` | `text` | |
| `senderUid`/`senderUin`/`senderName`/`isSelf` | 同名 | |
| `elements`/`mentions`/`reply`/`forwardId`/`resources`/`extra` | 同名 | `resources` 走同一套归档 |
| 会话线索：`chatType`/`chat_type`、`peerUid`、`peerName`/`sessionName`、`selfUid`… | `NormalizedSession` | 逐行推断，行内线索变化即切换会话 |
| `session` / `chatInfo` 对象行、`metadata`/`statistics`/`avatars`/`exportOptions` | 只更新会话/统计，不产消息 | 含 `messages` 数组的行会被拒绝并提示改用 `qce-json`/`qce-jsonl` |
| 未知键 | `extra` | 不丢 |

---

## 6. `qce-txt` 映射（尽力而为）

支持两种形态：

1. **单行**：`[2025-12-01 09:05:36] 昵称(20004): 内容`；也接受 `2025/12/01`、`2025-12-01 09:05`、`09:05:36` 开头，以及 `昵称: 内容`（无 QQ 号）。
2. **QCE 块**：`[n]` / `昵称:` / `时间:` / `类型:` / `内容:`（可折行，续行缩进）/ `资源: N 个文件` + `  - image: a.jpg` / `提及:` / `回复:`；头部 `聊天名称:`/`聊天类型:`/`参与人数:` 只用于填会话，不产消息。

| 解析结果 | 去向 |
| --- | --- |
| 时间文本 | `parseTxtTime()` → `ts`（无法解析 → 该条计入 **failed**，原文进 `errors`，**不静默丢**） |
| `昵称(QQ号)` | `senderName` + `senderUin`；无 QQ 号时 `senderUin` 为空 |
| 内容标记（`【图片消息】`/`【视频消息】`/`【语音消息】`/`【文件消息】`/`【表情消息】`/`【系统消息】`/`【无文本内容】`） | `msgType`/`kind`/`system`；`text` 用剩余文本 |
| `资源:` 列表 | `resources[]`（只有文件名，无 url/localPath → 通常归档为 `missing`） |
| `提及:` / `回复:` | `mentions[]` / `reply.preview` |
| 无法识别的行 | 进 `errors`（保留原文预览），计入 `failed` |

TXT **没有 `msgId`/`seq`/元素结构**，所以 `msgKey` 走哈希路径，见 §7。

---

## 7. 有损映射清单（如实）

1. **头像全丢**：顶层 `avatars`（每个 QQ 号一段 base64）在流式解析时**整段跳过**；`sender.avatarBase64` 也不保留。这是刻意的——它们体积可达数百 MB。
2. **`metadata` / `statistics` 不入库**：只传给 `ImportBatch.sourceStats`，`db.insertMessages` 不落这些字段。要看导出统计只能在导入过程或导入任务选项里取。
3. **`time` 原始字符串不保留为原文**：解析成 `ts` 后落库，读出来是重新格式化的本地时间；原始文本（例如上游 `TimeFormat` 选项产生的「仅日期」「仅时间」「相对时间」）只在 `extra.time` 里保留一份。
4. **`ts` 精度丢失**：只有「仅日期」的导出会被补成当天 `00:00:00`；同一天的多条消息在这个维度上不可区分（`msgKey` 还有文本/发送者参与，通常仍可区分）。
5. **`rawMessage` 截断**：超过 16 384 字符（`MAX_RAW_CHARS`）时变成 `{truncated:true, chars, preview}`，原始尾部丢失。
6. **`elements` / `mentions` 上限 200 条**：`db.insertMessages` 里 `slice(0, 200)`，超出部分丢弃（`text` 另有 200 000 字符上限）。
7. **`html` 不参与检索**：只进 `extra.html`，全文检索用的是 `text` + `sender_name`。富文本里的格式（加粗/链接）不带语义。
8. **表情/JSON 卡片/位置/system 元素不解析**：只保留 `{type, data}` 原始 JSON；表情图片、卡片标题/链接、坐标都不结构化。
9. **导入路径不展开转发**：`forwardId` 只留 id。被转发的消息**不在导出文件里**，所以导入无从展开；
   **采集路径**（走 OneBot）会调 `/get_forward_msg` 递归展开，见 §8。
10. **引用（reply）只存 id + 预览**：目标消息若不在同一批/同一账号内，`reply_to_id` 指向的消息可能不存在，界面上只显示预览文本。
11. **`direction` 是推断值**：导出里没有明确方向时按 `selfUid`/`selfUin` 比对；两者缺失时一律 `in`，可能把本人消息标成收信。
12. **排序不可信**：入库顺序 = 文件出现顺序；`seq` 只保留不参与排序（TXT/JSONL 尤其如此）。
13. **文件内重复消息不覆盖**：`INSERT OR IGNORE` + `UNIQUE(account_uid, session_key, msg_key)`，同 `msgKey` 第二次出现只计 `duplicate`，**后出现的更全内容不会更新已有行**。
14. **`msgKey` 哈希路径的固有碰撞面**：TXT / 无 `id` 的消息用 `ts+sender+text+seq+资源` 哈希。同一秒、同一人、同样文本、同样资源的两条真实消息会被视为同一条（计 `duplicate`）。
15. **缺失媒体的 `sha256`/`size`/`rel_path` 是占位语义**（§4）：`media` 行存在、文件不存在、`sha256` 不是内容哈希；Web 界面据此显示「缺失」是正确的，但任何按哈希去重/按路径读取的下游逻辑必须排除 `status='missing'`。
16. **缩略图是重编码产物**：`ensureThumb()` 用 ffmpeg 生成 JPEG 缩略图（`thumbs/<kind>/<sha2>/<sha>.jpg`），原媒体不转码；ffmpeg 缺失时 `thumbPath` 保持为空，不是错误。
17. **`qce-txt` 是尽力而为**：上游参考仓库里没有 TXT 导出器，这里的行模式是经验规则；折行、缩进、语言差异都可能让正文/发送者解析出错——**解析失败的行会明确进 `errors` 并计 `failed`，不会静默丢弃**。
18. **`memberCount`/`remark` 等会话字段在分块 JSONL 里可能缺失**：`manifest.json` 不保证带所有字段，缺失即留空。
19. **导入是单向的**：本系统可以把 `messages` 表导出成 `generic-jsonl` 再导入，但**往返不保证字节级一致**（见第 3、4、5、6 条），只保证「同一份文件重复导入幂等」。
20. **转写文本是机器产物**：`media_transcripts.text` 由本地 whisper.cpp 生成，**可能有错字**；
   原始语音文件始终按内容寻址保留，转写既不替换也不删除它，也不参与「归档完整性」判定
   （`verify` 不把「没有转写」算作缺失）。
21. **HTML 导入的正文是从 DOM 反推的**：`<br>` 之外的原生换行、CSS 伪元素里的文字、
   用图片渲染的表情都拿不到；`<img>` 只能拿到 `src`，拿不到 `alt` 语义。见 §8.2。

---

## 8. 采集侧的补充映射：转发展开与 HTML 导出

### 8.1 合并转发展开（仅采集路径）

`collect` 拉到的消息若带 `forwardId`，会调 OneBot 只读接口 `/get_forward_msg`：

| 层级 | 落到哪里 |
| --- | --- |
| 转发树本身 | `messages.extra.forward` = `StoredForward{id, count, messages: StoredForwardNode[], truncated?}`，**不**额外生成 `messages` 行（保留「这是一次转发」的语义） |
| 每个子节点的文本/发送者/时间/类型 | `StoredForwardNode{ts, senderUin?, senderName?, msgType, text, elements?}` |
| 子节点里的图片/视频/文件 | 追加进父消息的 `resources`，并写 `message_media.ordinal` —— 与 `resourceRange` 同源，所以一条转发里的第 N 个附件对应第 N 个 ordinal |
| 子节点本身又是转发 | 递归展开，直到 `collector.forwardDepth`（默认 3）；触顶时保留该节点的 `forwardId` 且 `forwardTruncated=true` |
| 节点总数 | 受 `collector.forwardMaxNodes`（默认 200）约束，超预算即截断并置 `truncated=true` |

**截断标记会冒泡到顶层**：只要任意深层被截断，顶层 `extra.forward.truncated` 就是 `true`，
CLI 会打印「转发已截断；重跑可补齐」，不会静默少存。

拉取失败（接口 403/超时/NapCat 未实现）**不影响消息本身落库**：只丢弃展开结果，
保留 `[合并转发]` 占位文本，并计入本轮 `forwardFailed`。`collector.forwardDepth=0` 可整体关闭。

### 8.2 HTML 导出（`html` 格式）

`packages/import/src/importers/html.ts` 是一个**手写扫描器**（不引入任何 HTML 库、零新依赖）：

| HTML 来源 | 识别线索 | 映射 |
| --- | --- | --- |
| QCE viewer 类导出 | `data-*` 属性、内嵌 `<script type="application/json">`、`window.__INITIAL_STATE__` | 优先用内嵌 JSON（比 DOM 更准），DOM 作为兜底 |
| 一般聊天页 | class 线索词 `message` / `msg` / `chat-item` / `bubble` 等消息容器 | 逐容器抽发送者、时间、正文 |
| 正文里的富文本 | `<br>` → 换行；`<img src>` → image；`<audio>` / `<video src>` / 媒体 `<a href>` → audio/video/file | 进 `elements` + `resources`（走同一套归档） |
| 方向 | class 含 `self` / `me` / `mine` / `right` / `own` | `isSelf` / `direction` |

**已知限制（如实）**：探测是**保守**的 —— 一个不像聊天页的 `.html`（例如普通文章页面）
会返回 `unknown` 并报 `UNSUPPORTED_FORMAT`，需要 `--format html` 显式指定；
class 命名没有标准，非主流导出器可能需要调整线索词。上述行为**只用合成 fixture 验证过**，
**没有拿真实第三方导出器产出的 HTML 验证过**。
