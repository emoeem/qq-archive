import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, Db } from '../packages/db/src/index.ts';
import type { NormalizedMessage, NormalizedSession } from '../packages/core/src/types.ts';
import { messageKeyOf, sessionKeyOf } from '../packages/core/src/index.ts';

/*
 * 预编译语句缓存（LRU）回归测试。
 *
 * 缺陷背景：insertMessages 的 5 条热路径语句原先直接走 `this.raw.prepare(...)`，
 * 绕过了 stmtCache，导致**每条消息重新 prepare 一次**（实测 3 次/消息）。
 * 这里通过包装 `DatabaseSync.prototype.prepare` 统计原始 prepare 调用次数，
 * 用「prepare 次数不随消息数线性增长」作为修复的硬证据。
 *
 * 第二条不变量：缓存必须是有界的。动态拼 SQL 的方法（如 updateJob 的可选 SET 子句）
 * 会命中 stmt() 并产生互不相同的键，若无 LRU 上限则缓存无界增长。
 */

const SESSION: NormalizedSession = {
  accountUid: 'u_test_prepare',
  chatType: 'group',
  peerUid: '888001',
  name: '缓存测试群',
};

type PrepareFn = (sql: string, ...rest: never[]) => ReturnType<DatabaseSync['prepare']>;

/**
 * 在 fn 执行期间统计底层 `DatabaseSync.prototype.prepare` 的调用次数。
 * 注意：`stmtCache` 内已有的语句不会再次 prepare，这正是被测行为。
 */
function withPrepareCounter<T>(fn: () => T): { result: T; prepares: number } {
  const original = DatabaseSync.prototype.prepare as unknown as PrepareFn;
  let prepares = 0;
  DatabaseSync.prototype.prepare = function patchedPrepare(
    this: DatabaseSync,
    sql: string,
    ...rest: never[]
  ) {
    prepares += 1;
    return original.call(this, sql, ...rest);
  } as unknown as PrepareFn;
  try {
    const result = fn();
    return { result, prepares };
  } finally {
    DatabaseSync.prototype.prepare = original as unknown as typeof DatabaseSync.prototype.prepare;
  }
}

function makeMessages(n: number, offset = 0): NormalizedMessage[] {
  const out: NormalizedMessage[] = [];
  for (let i = 0; i < n; i++) {
    const index = offset + i;
    const ts = 1_700_000_000_000 + index * 1000;
    const text = `zzqmarker 消息正文 ${index}`;
    out.push({
      msgKey: messageKeyOf({ msgId: `pm${index}`, ts, text }),
      msgId: `pm${index}`,
      ts,
      direction: 'in',
      msgType: 'text',
      senderUid: 'u_alice',
      senderName: 'Alice',
      text,
    });
  }
  return out;
}

/** 统计「一轮 insertMessages」消耗的原始 prepare 次数。 */
function measureBatch(n: number): number {
  const db = openDatabase({ path: ':memory:' });
  const session = db.ensureSession(SESSION);
  const key = sessionKeyOf(SESSION.chatType, SESSION.peerUid);
  const msgs = makeMessages(n);
  const { prepares } = withPrepareCounter(() =>
    db.insertMessages(session.id, SESSION.accountUid, key, msgs, { source: 'test' }),
  );
  db.close();
  return prepares;
}

test('db: insertMessages 的 prepare 次数不随消息数线性增长（热路径命中缓存）', () => {
  const prepares10 = measureBatch(10);
  const prepares50 = measureBatch(50);
  const delta = prepares50 - prepares10;

  // 修复前：n=10 → 32 次、n=50 → 152 次，delta=120（约 3 次/消息）。
  // 修复后：两者相等（同一条 SQL 只 prepare 一次），delta=0。
  assert.ok(
    delta <= 5,
    `prepare 次数应基本不随批量大小增长，实测 n=10 → ${prepares10}、n=50 → ${prepares50}（delta=${delta}）`,
  );
  // 绝对上界：一批 50 条消息的全部静态语句合计远小于 20 次
  assert.ok(prepares50 <= 20, `n=50 时 prepare 次数应 <= 20，实测 ${prepares50}`);
  assert.ok(prepares10 <= 20, `n=10 时 prepare 次数应 <= 20，实测 ${prepares10}`);
});

test('db: 缓存路径下插入、读回与全文检索结果仍然正确', () => {
  const db = openDatabase({ path: ':memory:' });
  const session = db.ensureSession(SESSION);
  const key = sessionKeyOf(SESSION.chatType, SESSION.peerUid);
  const msgs = makeMessages(50);

  const r1 = db.insertMessages(session.id, SESSION.accountUid, key, msgs, { source: 'test' });
  assert.equal(r1.inserted, 50);
  assert.equal(r1.duplicate, 0);
  assert.equal(r1.failed, 0);
  assert.equal(r1.errors.length, 0);
  assert.equal(r1.messageIds.length, 50);

  // 读回（命中缓存语句）
  const back = db.getMessage(r1.messageIds[0]!);
  assert.ok(back);
  assert.equal(back.msgKey, msgs[0]!.msgKey);
  assert.equal(back.text, msgs[0]!.text);
  assert.equal(back.senderName, 'Alice');

  // getMessageTexts 的动态 IN 列表（合法地不进静态缓存，但必须正确）
  const texts = db.getMessageTexts(r1.messageIds.slice(0, 3));
  assert.equal(texts.size, 3);
  assert.equal(texts.get(r1.messageIds[1]!)!.text, msgs[1]!.text);

  // 全文检索（FTS 路径）
  const fts = db.searchMessages({ keyword: 'zzqmarker', pageSize: 100 });
  assert.equal(fts.total, 50);
  assert.equal(fts.items.length, 50);

  // 会话列表读路径
  const listed = db.listMessages({ sessionId: session.id, limit: 100 });
  assert.equal(listed.items.length, 50);

  // 重复写入必须仍然被去重
  const r2 = db.insertMessages(session.id, SESSION.accountUid, key, msgs, { source: 'test' });
  assert.equal(r2.inserted, 0);
  assert.equal(r2.duplicate, 50);

  db.close();
});

test('db: 预编译语句缓存受 LRU 上限约束（动态 SQL 不会无限增长）', () => {
  const db = openDatabase({ path: ':memory:' });
  const cap = Db.STATEMENT_CACHE_MAX;
  assert.ok(Number.isInteger(cap) && cap >= 100 && cap <= 500, `上限应在 100–500，实测 ${cap}`);

  const jobId = db.createJob({ kind: 'import' });

  // updateJob 按 patch 的可选字段拼 SET 子句 → 每条 SQL 文本都不同，
  // 且都经过 stmt() 缓存。用不同的字段子集轰炸，模拟动态 SQL 导致的键爆炸。
  const patchFactories: Array<() => Record<string, unknown>> = [
    () => ({ status: 'running' }),
    () => ({ processed: 1 }),
    () => ({ inserted: 1 }),
    () => ({ duplicate: 0 }),
    () => ({ failed: 0 }),
    () => ({ mediaSaved: 0 }),
    () => ({ mediaMissing: 0 }),
    () => ({ progress: 0.5 }),
    () => ({ message: 'm' }),
    () => ({ error: null }),
    () => ({ startedAt: null }),
    () => ({ finishedAt: null }),
    () => ({ stats: { n: 1 } }),
    () => ({ totalItems: 2 }),
  ];

  // 枚举前 2^k 个非空字段子集，远超 cap，必然触发淘汰。
  const combos = 1 << 10; // 1023 个不同的 SET 子句
  const seen = new Set<string>();
  for (let mask = 1; mask < combos; mask++) {
    const patch: Record<string, unknown> = {};
    for (let i = 0; i < patchFactories.length; i++) {
      if ((mask >> i) & 1) Object.assign(patch, patchFactories[i]!());
    }
    seen.add(Object.keys(patch).sort().join(','));
    db.updateJob(jobId, patch);
    assert.ok(
      db.statementCacheSize <= cap,
      `第 ${mask} 次动态更新后缓存 ${db.statementCacheSize} 条，超过上限 ${cap}`,
    );
  }

  // 确认确实产生了远超上限的不同 SQL（否则这条测试没有测到东西）
  assert.ok(seen.size > cap, `应产生 > ${cap} 种不同 SET 组合，实测 ${seen.size}`);
  // 缓存被真正用满并稳定在上限
  assert.equal(db.statementCacheSize, cap);

  // 淘汰后语句仍然可用（缓存未损坏）
  db.updateJob(jobId, { status: 'done', progress: 1 });
  assert.equal(db.getJob(jobId)!.status, 'done');

  db.close();
});
