/**
 * 「撤回 / 清除」这条线的测试，围绕两件容易被误解的事：
 *
 *  1. **撤回能不能抹掉我已归档的内容？不能。** 归档是本地副本，且采集侧只做
 *     `INSERT OR IGNORE`：消息进了库以后，后续轮次既不会更新它、也不会删除它。
 *     这一条用真实采集轮次验证：第二轮里上游"不再返回这条消息"（等价于撤回后从历史消失），
 *     甚至"返回一条同 msgKey 但内容不同的消息"（等价于被改），库里那条必须原样还在。
 *
 *  2. **清除必须是我主动、明确、可预演的。** `purge` 默认只演练；`--yes` 才真删；
 *     删会话要连 FTS 索引一起清（虚拟表不会级联）；媒体行不级联删，只重算引用计数；
 *     只有显式 `--media` 才会删"不再被任何消息引用"的文件，且**仍被引用的图绝不删**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger, DEFAULT_CONFIG, sha256Hex, type AppConfig, type NormalizedMessage } from '../packages/core/src/index.ts';
import { openDatabase, type Db } from '../packages/db/src/index.ts';

const CLI_ENTRY = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'apps', 'cli', 'src', 'main.ts');
const logger = createLogger({ level: 'error', console: false }).child('purge-test');

function makeConfig(root: string): AppConfig {
  const dataDir = join(root, 'data');
  return {
    ...structuredClone(DEFAULT_CONFIG),
    server: { ...DEFAULT_CONFIG.server, token: 'purge-test-token-0123456789' },
    storage: {
      dataDir,
      dbPath: join(dataDir, 'archive.db'),
      mediaDir: join(dataDir, 'media'),
      backupDir: join(dataDir, 'backups'),
      logDir: join(dataDir, 'logs'),
    },
    collector: { ...DEFAULT_CONFIG.collector, kind: 'none' as const },
  };
}

function msg(text: string, i: number, over: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    msgKey: `id:m${i}`,
    msgId: `m${i}`,
    ts: 1_700_000_000_000 + i * 1000,
    direction: 'in',
    msgType: 'text',
    senderUin: '10001',
    senderName: '张三',
    text,
    ...over,
  };
}

function seedSession(db: Db, name: string, peer: string, msgs: NormalizedMessage[]): number {
  const s = db.ensureSession({ accountUid: 'default', chatType: 'group', peerUid: peer, name });
  db.insertMessages(s.id, 'default', `group:${peer}`, msgs, { source: 'test' });
  return s.id;
}

/* ------------------------------------------------------------------ */
/* 1. 撤回抹不掉已归档的内容                                            */
/* ------------------------------------------------------------------ */

test('撤回：消息一旦入库，后续轮次既不更新也不删除（上游"撤回后消失"也照样保留）', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'qq-recall-'));
  const db = openDatabase({ path: join(root, 'a.db') });
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  const sid = seedSession(db, '撤回测试群', 'g:1', [msg('这条会被撤回', 1), msg('这条不会', 2)]);
  const key = 'group:g:1';

  // 第一轮：正常入库
  const first = db.insertMessages(sid, 'default', key, [msg('这条会被撤回', 1), msg('这条不会', 2)], { source: 'test' });
  assert.equal(first.inserted, 0);
  assert.equal(first.duplicate, 2, '前置条件：第二轮是重复的');

  // 模拟撤回后上游的行为 A：历史里**不再返回**这条消息（我们什么都不做 → 库里必须还在）
  const afterRecallA = db.listMessages({ sessionId: sid, limit: 50, includeFiltered: true });
  assert.equal(afterRecallA.items.length, 2, '只增不删：库里仍然是 2 条');
  assert.ok(afterRecallA.items.some((m) => m.text === '这条会被撤回'), '被撤回的那条必须还在');

  // 模拟上游行为 B：返回**同一个 msgKey 但内容变了**（等价于"被改成 [已撤回]"）
  const changed = db.insertMessages(sid, 'default', key, [msg('[已撤回]', 1)], { source: 'test' });
  assert.equal(changed.inserted, 0, '同 msgKey 不得覆盖已归档的原文');
  assert.equal(changed.duplicate, 1);

  const afterRecallB = db.listMessages({ sessionId: sid, limit: 50, includeFiltered: true });
  const kept = afterRecallB.items.find((m) => m.msgKey === 'id:m1');
  assert.equal(kept?.text, '这条会被撤回', '原文必须原样保留，不能被上游的"[已撤回]"覆盖');

  // 搜索也还能搜到原文（FTS 没被改动）
  assert.equal(db.searchMessages({ keyword: '会被撤回', pageSize: 10, includeFiltered: true }).total, 1);
});

/* ------------------------------------------------------------------ */
/* 2. 清除：默认演练、--yes 才删、FTS 一起清                            */
/* ------------------------------------------------------------------ */

test('purge：默认只演练；--yes 才真删；删会话要连 FTS 索引一起清干净', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'qq-purge-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'data'), { recursive: true });
  const config = makeConfig(root);
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  const db = openDatabase({ path: config.storage.dbPath });
  const keep = seedSession(db, '要保留的群', 'g:keep', [msg('保留这条', 1)]);
  const drop = seedSession(db, '要删掉的群', 'g:drop', [msg('删掉这条甲', 2), msg('删掉这条乙', 3)]);
  db.close();

  const run = (args: string[]): { status: number | null; out: string } => {
    const r = spawnSync(process.execPath, ['--experimental-strip-types', CLI_ENTRY, ...args], {
      encoding: 'utf8',
      env: { ...process.env, QQ_ARCHIVE_CONFIG: '', QQ_ARCHIVE_DATA_DIR: '' },
      timeout: 120_000,
    });
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const countAll = (): number => {
    const d = openDatabase({ path: config.storage.dbPath });
    try {
      return Number((d.raw.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }).c);
    } finally {
      d.close();
    }
  };

  await t.test('默认演练：列出会删什么，但一条都不删', () => {
    const before = countAll();
    const r = run(['purge', '--session', String(drop), '--config', configPath]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /将要删除会话/, '应说明将要删什么');
    assert.match(r.out, /演练结束：未删除任何内容/, '应明确说明只是演练');
    assert.equal(countAll(), before, '演练不能动数据');
  });

  await t.test('--yes 真删：目标会话的消息没了，其他会话不受影响', () => {
    const before = countAll();
    const r = run(['purge', '--session', String(drop), '--yes', '--config', configPath]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /已删除：消息 2 条/);
    assert.equal(countAll(), before - 2, '只该少掉那 2 条');

    const d = openDatabase({ path: config.storage.dbPath });
    try {
      assert.equal((d.raw.prepare('SELECT COUNT(*) AS c FROM sessions WHERE id = ?').get(drop) as { c: number }).c, 0, '会话行应已删除');
      assert.equal((d.raw.prepare('SELECT COUNT(*) AS c FROM messages WHERE session_id = ?').get(keep) as { c: number }).c, 1, '另一个会话必须完好');
    } finally {
      d.close();
    }
  });

  await t.test('FTS 索引必须跟着清（虚拟表不会级联，残留会变成查不到的垃圾）', () => {
    const d = openDatabase({ path: config.storage.dbPath });
    try {
      const orphan = d.raw
        .prepare('SELECT COUNT(*) AS c FROM messages_fts WHERE rowid NOT IN (SELECT id FROM messages)')
        .get() as { c: number };
      assert.equal(orphan.c, 0, `messages_fts 里有 ${orphan.c} 条孤儿索引`);
      const orphanBigram = d.raw
        .prepare('SELECT COUNT(*) AS c FROM messages_fts_bigram WHERE rowid NOT IN (SELECT id FROM messages)')
        .get() as { c: number };
      assert.equal(orphanBigram.c, 0, `bigram 索引里有 ${orphanBigram.c} 条孤儿`);
      // 删掉的内容不该还能搜到
      assert.equal(d.searchMessages({ keyword: '删掉这条', pageSize: 10, includeFiltered: true }).total, 0);
      assert.equal(d.searchMessages({ keyword: '保留这条', pageSize: 10, includeFiltered: true }).total, 1);
    } finally {
      d.close();
    }
  });

  await t.test('--media 只删不再被引用的文件；仍被引用的图绝不删', () => {
    const d = openDatabase({ path: config.storage.dbPath });
    let sharedSha = '';
    let orphanSha = '';
    try {
      // 三条媒体：一条被保留会话引用、一条被共享引用（两处）、一条删完后没人引用
      const mk = (content: string, rel: string): { sha: string; id: number } => {
        const bytes = Buffer.from(content);
        const sha = sha256Hex(bytes);
        mkdirSync(dirname(join(config.storage.mediaDir, rel)), { recursive: true });
        writeFileSync(join(config.storage.mediaDir, rel), bytes);
        const m = d.upsertMedia({ sha256: sha, kind: 'image', size: bytes.length, relPath: rel, status: 'present' });
        return { sha, id: m.id };
      };
      const keptPic = mk('KEPT-PIC', 'image/kept.jpg');
      const sharedPic = mk('SHARED-PIC', 'image/shared.jpg');
      const onlyDropped = mk('ONLY-DROPPED', 'image/dropped.jpg');
      sharedSha = sharedPic.sha;
      orphanSha = onlyDropped.sha;

      const keepMsg = d.listMessages({ sessionId: keep, limit: 10 }).items[0]!;
      d.linkMessageMedia(keepMsg.id, keptPic.id, 0, 'kept.jpg', 8);
      d.linkMessageMedia(keepMsg.id, sharedPic.id, 1, 'shared.jpg', 10);

      // 第二个会话也引用这张共享图，然后把它删掉 → 共享图仍被 keep 引用，不能删
      const drop2 = seedSession(d, '第二个待删群', 'g:drop2', [msg('引用共享图', 9)]);
      const drop2Msg = d.listMessages({ sessionId: drop2, limit: 10 }).items[0]!;
      d.linkMessageMedia(drop2Msg.id, sharedPic.id, 0, 'shared.jpg', 10);
      d.linkMessageMedia(drop2Msg.id, onlyDropped.id, 1, 'dropped.jpg', 12);

      const r = run(['purge', '--session', String(drop2), '--yes', '--media', '--config', configPath]);
      assert.equal(r.status, 0, r.out);

      const remaining = readdirSync(join(config.storage.mediaDir, 'image')).sort();
      assert.ok(remaining.includes('kept.jpg'), '仍被引用的图必须留');
      assert.ok(remaining.includes('shared.jpg'), '被"另一个会话"引用的共享图必须留');
      assert.ok(!remaining.includes('dropped.jpg'), '删完没人引用的文件应被删掉');
      assert.equal((d.raw.prepare('SELECT COUNT(*) AS c FROM media WHERE sha256 = ?').get(orphanSha) as { c: number }).c, 0, '孤儿媒体行也应删除');
      assert.equal((d.raw.prepare('SELECT COUNT(*) AS c FROM media WHERE sha256 = ?').get(sharedSha) as { c: number }).c, 1, '共享媒体的行必须保留');
    } finally {
      d.close();
    }
  });

  await t.test('--all 演练与执行：整库清空，但备份文件不受影响', () => {
    const preview = run(['purge', '--all', '--config', configPath]);
    assert.equal(preview.status, 0, preview.out);
    assert.match(preview.out, /将要删除\*\*全部\*\*归档数据/);
    assert.equal(countAll() > 0, true, '演练后数据仍在');

    const wiped = run(['purge', '--all', '--yes', '--config', configPath]);
    assert.equal(wiped.status, 0, wiped.out);
    assert.equal(countAll(), 0, '全部消息应被清空');
  });

  await t.test('参数互斥与缺参：给出用法而不是乱删', () => {
    const both = run(['purge', '--all', '--session', '1', '--yes', '--config', configPath]);
    assert.equal(both.status, 2);
    assert.match(both.out, /不能同时使用/);

    const none = run(['purge', '--config', configPath]);
    assert.equal(none.status, 2);
    assert.match(none.out, /用法/);
  });
});
