/**
 * generic-jsonl 导入器：每行一个「归一化消息风格」的 JSON 对象。
 *
 * 支持的额外行形态（可选）：
 *   - `{"session": {...}}` / `{"chatInfo": {...}}` 头部行：补充会话信息（不产出消息）；
 *   - `{"metadata": ..., "statistics": ...}` 头部行：作为 sourceStats 透传。
 *
 * 每行的解析错误都计入 `failed` + `errors` 并附带原文片段，绝不静默丢弃。
 */
import type { NormalizedSession } from '../../../core/src/index.ts';
import {
  asRecord,
  asString,
  mapChatType,
  sessionFromChatInfo,
} from '../qce-map.ts';
import type { ImportContext, ImportStats, Importer, DetectedFormat, SessionHint } from '../importer.ts';
import { ImportRun, sessionFromHint } from '../importer.ts';
import { fileLineStream } from '../json-stream.ts';
import { looksNormalizedLike, mapNormalizedLike } from '../normalized-map.ts';

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function preview(raw: string, max = 120): string {
  const one = raw.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, max)}…`;
}

/** 头部行（`session` / `chatInfo`）→ NormalizedSession。 */
export function sessionFromHeaderLine(
  rec: Record<string, unknown>,
  accountUid: string,
  source: string,
): NormalizedSession {
  const nested = asRecord(rec.session);
  if (nested === null) {
    const chat = asRecord(rec.chatInfo);
    if (chat !== null) return sessionFromChatInfo(chat, accountUid, source);
    return sessionFromHint(accountUid, source, undefined);
  }
  const hint: SessionHint = {};
  const name = asString(nested.name);
  if (name !== undefined) hint.name = name;
  const chatType = mapChatType(nested.chatType ?? nested.type);
  if (chatType !== 'other') hint.chatType = chatType;
  const peerUid = asString(nested.peerUid);
  if (peerUid !== undefined) hint.peerUid = peerUid;
  const peerUin = asString(nested.peerUin);
  if (peerUin !== undefined) hint.peerUin = peerUin;
  const selfUid = asString(nested.selfUid);
  if (selfUid !== undefined) hint.selfUid = selfUid;
  const selfUin = asString(nested.selfUin);
  if (selfUin !== undefined) hint.selfUin = selfUin;
  const selfName = asString(nested.selfName);
  if (selfName !== undefined) hint.selfName = selfName;
  const memberCount = asString(nested.memberCount) ?? asString(nested.participantCount);
  if (memberCount !== undefined) {
    const n = Number(memberCount);
    if (Number.isFinite(n)) hint.memberCount = n;
  }
  return sessionFromHint(accountUid, source, hint);
}

/** 这一行是否是「只带会话/统计信息的头部行」。 */
export function isHeaderLine(rec: Record<string, unknown>): boolean {
  if (looksNormalizedLike(rec)) return false;
  return (
    asRecord(rec.session) !== null ||
    asRecord(rec.chatInfo) !== null ||
    'metadata' in rec ||
    'statistics' in rec ||
    'avatars' in rec ||
    'exportOptions' in rec
  );
}

/**
 * 行内自带的会话线索。
 *
 * generic-jsonl 的常见形态是每行都重复 `chatType` / `peerUid` / `peerName`
 * （见 tests/.fixtures/generic.jsonl），这里把它们还原成 NormalizedSession；
 * 一个线索都没有时返回 null（保持调用方给的 sessionHint / 默认会话）。
 */
export function sessionHintFromLine(rec: Record<string, unknown>): SessionHint | null {
  const hint: SessionHint = {};
  let any = false;

  const chatType = mapChatType(rec.chatType ?? rec.chat_type);
  if (chatType !== 'other') {
    hint.chatType = chatType;
    any = true;
  }
  const peerUid = asString(rec.peerUid) ?? asString(rec.peer_uid);
  if (peerUid !== undefined) {
    hint.peerUid = peerUid;
    any = true;
  }
  const peerUin = asString(rec.peerUin) ?? asString(rec.peer_uin);
  if (peerUin !== undefined) {
    hint.peerUin = peerUin;
    any = true;
  }
  const name = asString(rec.peerName) ?? asString(rec.peer_name) ?? asString(rec.sessionName);
  if (name !== undefined) {
    hint.name = name;
    any = true;
  }
  const selfUid = asString(rec.selfUid) ?? asString(rec.self_uid);
  if (selfUid !== undefined) hint.selfUid = selfUid;
  const selfUin = asString(rec.selfUin) ?? asString(rec.self_uin);
  if (selfUin !== undefined) hint.selfUin = selfUin;
  const selfName = asString(rec.selfName) ?? asString(rec.self_name);
  if (selfName !== undefined) hint.selfName = selfName;
  const memberCount = asString(rec.memberCount) ?? asString(rec.member_count);
  if (memberCount !== undefined) {
    const n = Number(memberCount);
    if (Number.isFinite(n)) hint.memberCount = n;
  }
  return any ? hint : null;
}

export class GenericJsonlImporter implements Importer {
  readonly name = 'generic-jsonl';
  readonly formats: DetectedFormat[] = ['generic-jsonl'];

  async run(ctx: ImportContext): Promise<ImportStats> {
    const source = ctx.source ?? 'generic-jsonl';
    const run = new ImportRun(ctx, this.name);
    run.setSession(sessionFromHint(ctx.accountUid, source, ctx.sessionHint));
    const sourceStats: Record<string, unknown> = {};
    let lastLineHint = '';

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
      if (Array.isArray(rec.messages)) {
        run.recordFailure(
          `这一行含 messages 数组（应使用 qce-json 或 qce-jsonl 导入器）：${preview(text)}`,
        );
        continue;
      }
      if (isHeaderLine(rec)) {
        for (const key of ['metadata', 'statistics'] as const) {
          if (rec[key] !== undefined) sourceStats[key] = rec[key];
        }
        if (rec.chatInfo !== undefined || rec.session !== undefined) {
          run.setSession(sessionFromHeaderLine(rec, ctx.accountUid, source));
        }
        continue;
      }
      const lineHint = sessionHintFromLine(rec);
      if (lineHint !== null) {
        const signature = JSON.stringify(lineHint);
        if (signature !== lastLineHint) {
          lastLineHint = signature;
          run.setSession(sessionFromHint(ctx.accountUid, source, lineHint));
        }
      }
      const session = run.sessionInfo ?? sessionFromHint(ctx.accountUid, source, ctx.sessionHint);
      try {
        await run.push(
          mapNormalizedLike(parsed, { accountUid: ctx.accountUid, source, session }, { sourceTag: source }),
        );
      } catch (err) {
        run.recordFailure(`消息映射失败：${errText(err)}｜${preview(text)}`);
      }
    }

    if (Object.keys(sourceStats).length > 0) run.setSourceStats(sourceStats);
    return run.finish();
  }
}
