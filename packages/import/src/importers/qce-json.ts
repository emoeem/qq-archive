/**
 * qce-json 导入器：qq-chat-exporter 的「单文件 JSON」导出。
 *
 * 结构（顺序固定为 metadata → chatInfo → statistics → messages → [avatars] → [exportOptions]）：
 *   { "metadata": {...}, "chatInfo": {...}, "statistics": {...},
 *     "messages": [ {...}, ... ], "avatars": {"<uin>": "<base64>"}, "exportOptions": {...} }
 *
 * 关键点：
 *  - **流式**：顶层对象按成员逐个读取，`messages` 用 `arrayItems()` 一条一条 yield，
 *    绝不 `JSON.parse` 整个文件（10 万条消息的导出可能几百 MB）。
 *  - `avatars` 是 base64 头像表，可能极大，只跳过不解析、不累积内存。
 *  - 单条消息解析失败 → 计入 failed + errors，保留出错原因，绝不静默丢。
 */
import type { NormalizedSession } from '../../../core/src/index.ts';
import type { ImportContext, ImportStats, Importer, DetectedFormat } from '../importer.ts';
import { ImportRun, MAX_MESSAGE_BYTES, sessionFromHint } from '../importer.ts';
import { openJsonStream } from '../json-stream.ts';
import type { JsonStreamReader } from '../json-stream.ts';
import {
  applyChatInfo,
  asRecord,
  mapQceMessage,
  sessionFromChatInfo,
} from '../qce-map.ts';

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function preview(raw: string, max = 120): string {
  const one = raw.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, max)}…`;
}

export class QceJsonImporter implements Importer {
  readonly name = 'qce-json';
  readonly formats: DetectedFormat[] = ['qce-json'];

  async run(ctx: ImportContext): Promise<ImportStats> {
    const source = ctx.source ?? 'qce-json';
    const run = new ImportRun(ctx, this.name);
    const reader = openJsonStream(ctx.filePath);
    const sourceStats: Record<string, unknown> = {};
    let stop = false;
    try {
      await reader.expectObjectStart();
      for (;;) {
        if (await reader.atObjectEnd()) break;
        const key = await reader.readStringValue();
        await reader.expectChar(':');
        if (key === 'messages') {
          // chatInfo 理论上已经读到；万一顺序不同（或字段缺失）也要有会话对象可映射
          const session = run.sessionInfo ?? sessionFromHint(ctx.accountUid, source, ctx.sessionHint);
          run.setSession(session);
          await readMessages(reader, run, ctx, session, source);
          stop = run.limitReached;
        } else if (key === 'chatInfo') {
          const chat: unknown = await reader.readJson();
          const existing = run.sessionInfo;
          run.setSession(
            existing ? applyChatInfo(existing, chat) : sessionFromChatInfo(chat, ctx.accountUid, source),
          );
        } else if (key === 'metadata' || key === 'statistics') {
          sourceStats[key] = await reader.readJson();
        } else {
          // avatars / exportOptions / 未来新增字段：整块跳过，不占内存
          await reader.skipValue();
        }
        if (stop) break;
        if ((await reader.commaOrObjectEnd()) === 'end') break;
      }
    } finally {
      await reader.close();
    }
    if (Object.keys(sourceStats).length > 0) run.setSourceStats(sourceStats);
    return run.finish();
  }
}

/** 逐条消费 `messages` 数组。 */
async function readMessages(
  reader: JsonStreamReader,
  run: ImportRun,
  ctx: ImportContext,
  session: NormalizedSession,
  source: string,
): Promise<void> {
  for await (const item of reader.arrayItems(MAX_MESSAGE_BYTES)) {
    if (run.limitReached) return;
    run.checkAbort();
    if (!item.ok) {
      run.recordFailure(
        `消息对象超过 ${MAX_MESSAGE_BYTES} 字节上限，已跳过（约 ${item.bytes} 字节）`,
      );
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(item.raw);
    } catch (err) {
      run.recordFailure(`消息 JSON 解析失败：${errText(err)}｜${preview(item.raw)}`);
      continue;
    }
    if (asRecord(parsed) === null) {
      run.recordFailure(`消息不是 JSON 对象：${preview(item.raw)}`);
      continue;
    }
    try {
      await run.push(mapQceMessage(parsed, { accountUid: ctx.accountUid, source, session }));
    } catch (err) {
      run.recordFailure(`消息映射失败：${errText(err)}｜${preview(item.raw)}`);
    }
  }
}
