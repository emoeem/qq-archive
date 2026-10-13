import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, type Db } from '../packages/db/src/index.ts';
import type { NormalizedMessage, NormalizedSession } from '../packages/core/src/types.ts';
import { messageKeyOf, sessionKeyOf, buildSearchText } from '../packages/core/src/index.ts';

export function tmpDb(): Db {
  return openDatabase({ path: ':memory:' });
}

export const SESSION: NormalizedSession = {
  accountUid: 'u_test',
  chatType: 'group',
  peerUid: '999001',
  name: '测试群',
};

export function msg(partial: Partial<NormalizedMessage> & { ts: number; text: string }): NormalizedMessage {
  const base = {
    msgKey: messageKeyOf({ msgId: `m${partial.ts}`, ts: partial.ts, text: partial.text }),
    direction: 'in' as const,
    msgType: 'text' as const,
    senderUid: 'u_alice',
    senderName: 'Alice',
    ...partial,
  };
  return base;
}

test('db: 迁移后 schema 版本为最新', () => {
  const db = tmpDb();
  assert.ok(db.schemaVersion() >= 1);
  assert.deepEqual(db.health(), { ok: true, schemaVersion: db.schemaVersion() });
  db.close();
});

test('db: 同一会话重复写入不产生重复行', () => {
  const db = tmpDb();
  const s = db.ensureSession(SESSION);
  const key = sessionKeyOf(SESSION.chatType, SESSION.peerUid);
  const batch = [
    msg({ ts: 1_700_000_000_000, text: '你好世界' }),
    msg({ ts: 1_700_000_001_000, text: '第二条' }),
  ];
  const r1 = db.insertMessages(s.id, SESSION.accountUid, key, batch, { source: 'test' });
  assert.equal(r1.inserted, 2);
  assert.equal(r1.duplicate, 0);
  const r2 = db.insertMessages(s.id, SESSION.accountUid, key, batch, { source: 'test' });
  assert.equal(r2.inserted, 0);
  assert.equal(r2.duplicate, 2);
  const stats = db.stats();
  assert.equal(stats.messages, 2);
  assert.equal(stats.groups, 1);
  db.close();
});

test('db: 中文子串可被搜索到（CJK 二元切分）', () => {
  const db = tmpDb();
  const s = db.ensureSession(SESSION);
  const key = sessionKeyOf(SESSION.chatType, SESSION.peerUid);
  db.insertMessages(
    s.id,
    SESSION.accountUid,
    key,
    [
      msg({ ts: 1_700_000_000_000, text: '今天去看了演唱会' }),
      msg({ ts: 1_700_000_001_000, text: 'hello world archive' }),
    ],
    { source: 'test' },
  );
  const hit = db.searchMessages({ keyword: '演唱会' });
  assert.equal(hit.total, 1, '应命中「演唱会」');
  assert.match(hit.items[0]!.snippet, /<mark>演唱会<\/mark>/);
  const mid = db.searchMessages({ keyword: '看了演' });
  assert.equal(mid.total, 1, '应命中子串「看了演」');
  // 西文走整词：hello 命中，hello 的子串 ell 不命中（符合“词”的检索直觉）
  assert.equal(db.searchMessages({ keyword: 'hello' }).total, 1, '应命中整词 hello');
  assert.equal(db.searchMessages({ keyword: 'world archive' }).total, 1, '多词 AND 命中');
  assert.equal(db.searchMessages({ keyword: 'archive' }).total, 1, '应命中 ascii');
  assert.equal(db.searchMessages({ keyword: '唱' }).total, 1, '单字 CJK 走 LIKE 回退也应命中');
  const none = db.searchMessages({ keyword: '不存在的词' });
  assert.equal(none.total, 0);
  db.close();
});

test('db: 非法时间戳的消息被拒并计入 failed', () => {
  const db = tmpDb();
  const s = db.ensureSession(SESSION);
  const key = sessionKeyOf(SESSION.chatType, SESSION.peerUid);
  const r = db.insertMessages(
    s.id,
    SESSION.accountUid,
    key,
    [msg({ ts: 0, text: '时间戳非法' })],
    { source: 'test' },
  );
  assert.equal(r.failed, 1);
  assert.equal(r.inserted, 0);
  assert.equal(db.stats().messages, 0);
  db.close();
});

test('db: 会话统计在批量写入后重算', () => {
  const db = tmpDb();
  const s = db.ensureSession(SESSION);
  const key = sessionKeyOf(SESSION.chatType, SESSION.peerUid);
  db.insertMessages(
    s.id,
    SESSION.accountUid,
    key,
    [msg({ ts: 1_700_000_000_000, text: 'a' }), msg({ ts: 1_700_000_600_000, text: 'b' })],
    { source: 'test' },
  );
  const after = db.getSession(s.id)!;
  assert.equal(after.messageCount, 2);
  assert.equal(after.firstMessageAt, 1_700_000_000_000);
  assert.equal(after.lastMessageAt, 1_700_000_600_000);
  db.close();
});

test('db: 媒体按 sha256 去重并可回链到消息', () => {
  const db = tmpDb();
  const s = db.ensureSession(SESSION);
  const key = sessionKeyOf(SESSION.chatType, SESSION.peerUid);
  const m = msg({ ts: 1_700_000_000_000, text: '看图' });
  const r = db.insertMessages(s.id, SESSION.accountUid, key, [m], { source: 'test' });
  const sha = 'a'.repeat(64);
  const first = db.upsertMedia({ sha256: sha, kind: 'image', size: 1234, relPath: `image/2026/01/aa/${sha}.jpg` });
  assert.equal(first.created, true);
  const second = db.upsertMedia({ sha256: sha, kind: 'image', size: 1234, relPath: `image/2026/01/aa/${sha}.jpg` });
  assert.equal(second.created, false);
  assert.equal(second.id, first.id);
  db.linkMessageMedia(r.messageIds[0]!, first.id, 0, 'a.jpg', 1234);
  const message = db.getMessage(r.messageIds[0]!)!;
  assert.equal(message.media.length, 1);
  assert.equal(message.media[0]!.kind, 'image');
  assert.equal(message.media[0]!.url, `/api/media/${first.id}/raw`);
  assert.equal(db.mediaStats().total, 1);
  assert.equal(db.mediaStats().bytes, 1234);
  db.close();
});

test('db: buildSearchText 产生中文二元组', () => {
  const s = buildSearchText('你好世界');
  assert.ok(s.includes('你好'), s);
  assert.ok(s.includes('好世'), s);
  assert.ok(s.includes('世界'), s);
});
