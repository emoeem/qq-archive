/**
 * qce-jsonl 导入器：qq-chat-exporter 的「分块 JSONL」导出（以及任何逐行 JSON 的 QCE 变体）。
 *
 * 一个分块导出的目录结构：
 *   <导出目录>/manifest.json          ← 含 metadata / chatInfo / statistics / chunked
 *   <导出目录>/chunks/cNNNNNN.jsonl   ← **每行一个 QCE 消息对象**（无外层包装）
 *   <导出目录>/avatars.json           ← 可选
 *
 * 所以本导入器要同时支持两种行形态：
 *   1. 每行一条 QCE 消息对象（分块导出的真实形态）；
 *   2. 整行是一个含 `messages` 数组的包装对象。
 * 会话信息优先取行内的 `chatInfo`，其次取**同目录/上级目录的 manifest.json**，
 * 最后才用 `ctx.sessionHint`。
 */
import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { NormalizedSession } from '../../../core/src/index.ts';
import {
  applyChatInfo,
  asRecord,
  mapQceMessage,
  sessionFromChatInfo,
} from '../qce-map.ts';
import type { ImportContext, ImportStats, Importer, DetectedFormat } from '../importer.ts';
import { ImportRun, sessionFromHint } from '../importer.ts';
import { fileLineStream } from '../json-stream.ts';
import { looksNormalizedLike, mapNormalizedLike } from '../normalized-map.ts';
import { errText, isHeaderLine, preview, sessionFromHeaderLine } from './generic-jsonl.ts';

/** manifest.json 的最大读取体积（正常只有几 KB）。 */
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

/** 分块导出的 manifest.json 候选路径（同目录、上级目录）。 */
export function manifestCandidates(filePath: string): string[] {
  const dir = dirname(filePath);
  return [join(dir, 'manifest.json'), join(dirname(dir), 'manifest.json')];
}

/** 从 sibling manifest.json 里取 chatInfo（找不到就返回 null，不报错）。 */
export async function sessionFromManifest(
  filePath: string,
  accountUid: string,
  source: string,
): Promise<NormalizedSession | null> {
  for (const candidate of manifestCandidates(filePath)) {
    try {
      const st = await stat(candidate);
      if (!st.isFile() || st.size === 0 || st.size > MAX_MANIFEST_BYTES) continue;
    } catch {
      continue;
    }
    try {
      const doc: unknown = JSON.parse(await readFile(candidate, 'utf8'));
      const rec = asRecord(doc);
      if (!rec) continue;
      if (rec.chatInfo !== undefined) return sessionFromChatInfo(rec.chatInfo, accountUid, source);
      if (rec.session !== undefined) return sessionFromHeaderLine(rec, accountUid, source);
    } catch {
      // manifest 坏了不应该中断导入：退回行内/提示信息
      continue;
    }
  }
  return null;
}

export class QceJsonlImporter implements Importer {
  readonly name = 'qce-jsonl';
  readonly formats: DetectedFormat[] = ['qce-jsonl'];

  async run(ctx: ImportContext): Promise<ImportStats> {
    const source = ctx.source ?? 'qce-jsonl';
    const run = new ImportRun(ctx, this.name);
    const manifestSession = await sessionFromManifest(ctx.filePath, ctx.accountUid, source);
    run.setSession(manifestSession ?? sessionFromHint(ctx.accountUid, source, ctx.sessionHint));
    const sourceStats: Record<string, unknown> = {};

    for await (const line of fileLineStream(ctx.filePath)) {
      if (run.limitReached) break;
      run.checkAbort();
      const text = line.trim();
      if (text.length === 0) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        run.recordFailure(`JSON 行解析失败：${errText(err)}｜${preview(text)}`);
        continue;
      }
      const rec = asRecord(parsed);
      if (rec === null) {
        run.recordFailure(`行不是 JSON 对象：${preview(text)}`);
        continue;
      }

      // 形态 2：包装对象（含 messages 数组），可带 chatInfo
      if (Array.isArray(rec.messages)) {
        this.applyWrapper(rec, run, ctx, source, sourceStats);
        for (const item of rec.messages) {
          if (run.limitReached) break;
          await this.pushOne(item, run, ctx, source);
        }
        continue;
      }

      // 形态 3：`{ chatInfo, message }` —— 逐行包一条消息（分块导出/其它工具的常见变体）
      if (rec.message !== undefined && rec.messages === undefined) {
        this.applyWrapper(rec, run, ctx, source, sourceStats);
        await this.pushOne(rec.message, run, ctx, source);
        continue;
      }

      // 头部行：只更新会话/统计，不产出消息
      if (isHeaderLine(rec)) {
        this.applyWrapper(rec, run, ctx, source, sourceStats);
        continue;
      }

      await this.pushOne(parsed, run, ctx, source);
    }

    if (Object.keys(sourceStats).length > 0) run.setSourceStats(sourceStats);
    return run.finish();
  }

  /**
   * 行内包装对象：把行里的 `chatInfo` / `session` / `metadata` / `statistics`
   * 合并进运行状态（不产出消息）。三种行形态共用。
   */
  private applyWrapper(
    rec: Record<string, unknown>,
    run: ImportRun,
    ctx: ImportContext,
    source: string,
    sourceStats: Record<string, unknown>,
  ): void {
    for (const key of ['metadata', 'statistics'] as const) {
      if (rec[key] !== undefined) sourceStats[key] = rec[key];
    }
    if (rec.chatInfo !== undefined) {
      run.setSession(
        applyChatInfo(
          run.sessionInfo ?? sessionFromHint(ctx.accountUid, source, ctx.sessionHint),
          rec.chatInfo,
        ),
      );
    } else if (rec.session !== undefined) {
      run.setSession(sessionFromHeaderLine(rec, ctx.accountUid, source));
    }
  }

  /** 一行内容 → 一条消息（QCE 形态或归一化形态）。 */
  private async pushOne(
    item: unknown,
    run: ImportRun,
    ctx: ImportContext,
    source: string,
  ): Promise<void> {
    const rec = asRecord(item);
    if (rec === null) {
      run.recordFailure(`消息不是 JSON 对象：${preview(JSON.stringify(item) ?? String(item))}`);
      return;
    }
    const session = run.sessionInfo ?? sessionFromHint(ctx.accountUid, source, ctx.sessionHint);
    try {
      if (looksNormalizedLike(rec)) {
        await run.push(
          mapNormalizedLike(rec, { accountUid: ctx.accountUid, source, session }, { sourceTag: source }),
        );
        return;
      }
      await run.push(mapQceMessage(rec, { accountUid: ctx.accountUid, source, session }));
    } catch (err) {
      run.recordFailure(`消息映射失败：${errText(err)}｜${preview(JSON.stringify(rec) ?? '')}`);
    }
  }
}
