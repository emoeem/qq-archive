/**
 * 会话导出（流式）：json / jsonl / txt。
 *
 * 大会话不能整体进内存，逐批（每批 500 条）从 DB 取并写入响应流；
 * 超过 `config.server.exportMaxMessages` 时停止并标记 `truncated`。
 */
import type { ServerResponse } from 'node:http';
import { formatTime, type MessageRecord, type SessionRecord } from '../../core/src/index.ts';
import type { Db } from '../../db/src/index.ts';
import { contentDisposition } from './http.ts';

export type ExportFormat = 'json' | 'jsonl' | 'txt';

export interface SessionExportOptions {
  db: Db;
  session: SessionRecord;
  format: ExportFormat;
  from?: number;
  to?: number;
  cap: number;
}

async function writeTo(res: ServerResponse, chunk: string): Promise<void> {
  if (res.writableEnded || res.destroyed) throw new Error('客户端已断开连接');
  if (res.write(chunk)) return;
  await new Promise<void>((resolvePromise) => {
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      resolvePromise();
    };
    res.once('drain', done);
    res.once('close', done);
  });
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function lineFor(m: MessageRecord, format: ExportFormat): string {
  if (format === 'jsonl') return `${JSON.stringify(m)}\n`;
  const who = m.isSelf ? '我' : (m.senderName ?? m.senderUid ?? '未知');
  const recalled = m.recalled ? '（已撤回）' : '';
  return `[${formatTime(m.ts)}] ${who}: ${recalled}${m.text}\n`;
}

/** 把会话消息流式写入响应；返回实际导出条数。 */
export async function streamSessionExport(
  res: ServerResponse,
  opts: SessionExportOptions,
): Promise<{ exported: number; truncated: boolean }> {
  const { db, session, format, cap } = opts;
  const ext = format === 'json' ? 'json' : format === 'jsonl' ? 'jsonl' : 'txt';
  const mime =
    format === 'json'
      ? 'application/json; charset=utf-8'
      : format === 'jsonl'
        ? 'application/x-ndjson; charset=utf-8'
        : 'text/plain; charset=utf-8';
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Disposition': contentDisposition('attachment', `session-${session.id}-${stamp()}.${ext}`),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });

  let exported = 0;
  let truncated = false;
  if (format === 'json') {
    await writeTo(res, '{"session":');
    await writeTo(res, JSON.stringify(session));
    await writeTo(res, ',"exportedAt":');
    await writeTo(res, JSON.stringify(new Date().toISOString()));
    await writeTo(res, ',"messages":[');
  }

  const pageSize = 500;
  let cursorTs = opts.from ?? 0;
  let lastId = 0;
  let first = true;
  outer: for (;;) {
    const batch = db.listMessages({
      sessionId: session.id,
      from: cursorTs,
      to: opts.to,
      order: 'asc',
      limit: pageSize,
      includeRecalled: true,
      // 导出**必须**带上被过滤的消息：过滤只是"默认少看点"，导出是"把数据拿走"，
      // 少导出一条就是真的丢数据 —— 那与本系统的目标直接冲突。
      includeFiltered: true,
    });
    for (const m of batch.items) {
      if (m.ts < cursorTs) continue;
      if (m.ts === cursorTs && m.id <= lastId) continue;
      if (exported >= cap) {
        truncated = true;
        break outer;
      }
      if (format === 'json') {
        await writeTo(res, first ? '\n' : ',\n');
        await writeTo(res, JSON.stringify(m));
      } else {
        await writeTo(res, lineFor(m, format));
      }
      first = false;
      exported++;
    }
    if (!batch.hasMore) break;
    const last = batch.items[batch.items.length - 1];
    if (!last) break;
    if (last.ts === cursorTs && last.id === lastId) break; // 防死循环
    cursorTs = last.ts;
    lastId = last.id;
  }

  if (format === 'json') {
    await writeTo(res, `\n],"count":${exported},"truncated":${truncated ? 'true' : 'false'}}\n`);
  }
  if (!res.writableEnded) res.end();
  return { exported, truncated };
}
