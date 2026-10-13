/**
 * 备份「对账」回归测试。
 *
 * 锁定的是一个真实发生过的状态：`data/backups/` 里躺着两份带 manifest 的快照，
 * 而 `backups` 表里**一行都没有** —— 网页因此显示「尚无备份记录」，保留策略也永远不会
 * 裁剪它们（`pruneBackups` 只遍历表里的行）。根因是快照由 `VACUUM INTO` 生成、
 * 登记行却在快照**之后**才写入当前库，所以快照自己不可能包含自己那一行；
 * 一旦用这份快照做过恢复（恢复 = 快照替换当前库），那次备份的记录就消失了。
 *
 * 覆盖：真实 `createBackup` 产出的 manifest 能被读回、幂等、坏 manifest 兜底、
 * 只认 `archive-*.db`、以及 prune 与对账的配合（孤儿不会再无限堆积）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import type { AppConfig, NormalizedMessage, NormalizedSession } from '../packages/core/src/index.ts';
import { createLogger, messageKeyOf, sessionKeyOf } from '../packages/core/src/index.ts';
import { openDatabase } from '../packages/db/src/index.ts';
import { createBackup, pruneBackups, reconcileBackups } from '../packages/server/src/backup.ts';

const SESSION: NormalizedSession = { accountUid: 'u_self', chatType: 'private', peerUid: '800001', name: '对账测试' };

function makeConfig(root: string): AppConfig {
  const dataDir = join(root, 'data');
  return {
    server: {
      host: '127.0.0.1',
      port: 0,
      token: 'x'.repeat(24),
      sessionTtlSec: 3600,
      allowDownload: true,
      exportMaxMessages: 1000,
      trustProxy: false,
    },
    storage: {
      dataDir,
      dbPath: join(dataDir, 'archive.db'),
      mediaDir: join(dataDir, 'media'),
      backupDir: join(dataDir, 'backups'),
      logDir: join(dataDir, 'logs'),
    },
    backup: { intervalHours: 0, keep: 2, verify: false },
    alert: { diskLowGb: 2, collectFailureThreshold: 3, webhookUrl: '' },
    collector: {
      kind: 'none',
      baseUrl: 'http://127.0.0.1:3000',
      token: '',
      intervalSec: 60,
      lookbackSec: 300,
      initialBackfillDays: 3,
      pageSize: 200,
      maxPagesPerRound: 20,
      syncMedia: false,
      maxMediaBytes: 1024,
      discoverSessions: false,
      sessions: [],
    },
    stt: {
      enabled: false,
      engine: 'whisper-cli',
      binary: 'whisper-cli',
      ffmpeg: 'ffmpeg',
      model: join(dataDir, 'm.bin'),
      language: 'zh',
      vadModel: '',
      threads: 1,
      timeoutMs: 1000,
      maxDurationSec: 60,
    },
  };
}

function seed(db: ReturnType<typeof openDatabase>): void {
  const s = db.ensureSession(SESSION);
  const key = sessionKeyOf(SESSION.chatType, SESSION.peerUid);
  const msgs: NormalizedMessage[] = ['一', '二', '三'].map((text, i) => ({
    msgKey: messageKeyOf({ msgId: `m${i}`, ts: 1_700_000_000_000 + i, text }),
    msgId: `m${i}`,
    ts: 1_700_000_000_000 + i,
    direction: 'in',
    msgType: 'text',
    text,
  }));
  db.insertMessages(s.id, SESSION.accountUid, key, msgs, { source: 'test' });
}

test('对账：真实快照丢了登记行也能按 manifest 找回来（幂等、可被裁剪）', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'qqarchive-reconcile-'));
  const config = makeConfig(root);
  mkdirSync(config.storage.mediaDir, { recursive: true });
  mkdirSync(config.storage.backupDir, { recursive: true });
  const logger = createLogger({ level: 'error', console: false }).child('reconcile-test');
  const db = openDatabase({ path: config.storage.dbPath });
  seed(db);
  t.after(() => {
    try {
      db.close();
    } catch {
      /* 已关闭 */
    }
    rmSync(root, { recursive: true, force: true });
  });

  const real = await createBackup({ db, config, logger, kind: 'manual' });
  const snapshotName = basename(real.snapshotPath);
  assert.ok(existsSync(real.snapshotPath), '前置条件：快照文件真的存在');
  assert.ok(existsSync(real.manifestPath), '前置条件：manifest 真的存在');

  // 复现故障状态：清掉当日那一行（恢复演练的真实后果）
  db.raw.prepare('DELETE FROM backups').run();
  assert.equal(db.listBackups(10).length, 0);

  await t.test('对账把快照登记回来，元数据取自 manifest 而不是当前时间', () => {
    const before = Date.now();
    const res = reconcileBackups({ db, backupDir: config.storage.backupDir, logger });
    assert.equal(res.added, 1);
    const rows = db.listBackups(10);
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.equal(row.kind, 'manual');
    assert.equal(row.status, 'done');
    assert.equal(basename(row.path), snapshotName);
    assert.equal(row.sizeBytes, real.sizeBytes, '体积应等于 manifest 里记录的快照体积');
    assert.equal(row.messageCount, real.counts.messages);
    assert.equal(row.dbSha256, real.sha256);
    // createdAt 用快照的真实时间（manifest.createdAt），不能是「发现它的时间」
    assert.ok(
      Date.parse(row.createdAt) <= before,
      `createdAt 应是快照生成时间，实际 ${row.createdAt}`,
    );
  });

  await t.test('再次对账是幂等的，不会重复登记', () => {
    assert.equal(reconcileBackups({ db, backupDir: config.storage.backupDir, logger }).added, 0);
    assert.equal(db.listBackups(10).length, 1);
  });

  await t.test('只认 archive-*.db：其它文件不会被当成快照', () => {
    writeFileSync(join(config.storage.backupDir, 'note.txt'), 'x');
    writeFileSync(join(config.storage.backupDir, 'other.db'), 'x');
    writeFileSync(join(config.storage.backupDir, 'archive-但扩展名不对.sqlite'), 'x');
    assert.equal(reconcileBackups({ db, backupDir: config.storage.backupDir, logger }).added, 0);
    assert.equal(db.listBackups(10).length, 1);
  });

  await t.test('manifest 损坏时按文件名 + mtime 兜底登记（宁可信息少，不可漏账）', () => {
    const orphan = join(config.storage.backupDir, 'archive-auto-20260101-000000.db');
    writeFileSync(orphan, 'NOT-A-REAL-SQLITE-BUT-EXISTS');
    const stamp = new Date('2026-01-01T00:00:00.000Z');
    utimesSync(orphan, stamp, stamp);
    const res = reconcileBackups({ db, backupDir: config.storage.backupDir, logger });
    assert.equal(res.added, 1);
    const row = db.listBackups(10).find((r) => basename(r.path) === basename(orphan))!;
    assert.equal(row.kind, 'auto', 'kind 从文件名兜底');
    assert.equal(row.status, 'done');
    assert.ok(row.sizeBytes > 0, '体积从文件实测');
  });

  await t.test('prune 先把孤儿对账回来再裁剪，保留份数才真的生效', () => {
    // 现在目录里有 3 份（真实快照 + auto 孤儿 + 上面写的假 archive 文件）
    const before = db.listBackups(50).length;
    assert.ok(before >= 2, `前置条件：表里至少 2 行，实际 ${before}`);
    const res = pruneBackups({ db, backupDir: config.storage.backupDir, keep: 1, logger });
    assert.ok(res.removed.length >= 1, '超出保留份数的旧快照应被删除');
    assert.equal(db.listBackups(50).length, 1);
    // 被裁掉的快照连文件一起消失，且删的都在备份目录内
    for (const p of res.removed) assert.ok(p.startsWith(config.storage.backupDir));
    const left = readdirSync(config.storage.backupDir).filter((n) => n.startsWith('archive-') && n.endsWith('.db'));
    assert.equal(left.length, 1, '磁盘上只应剩下保留的那一份');
  });

  await t.test('prune 后再次对账不应把已删除的快照"复活"', () => {
    const added = reconcileBackups({ db, backupDir: config.storage.backupDir, logger }).added;
    assert.equal(added, 0);
  });
});

test('对账：数据目录整体搬迁后不产生重复记录，而是把老行改指到新位置', () => {
  const root = mkdtempSync(join(tmpdir(), 'qqarchive-moved-'));
  try {
    const oldDir = join(root, 'old', 'data');
    const newDir = join(root, 'new', 'data');
    mkdirSync(join(oldDir, 'backups'), { recursive: true });
    mkdirSync(join(newDir, 'backups'), { recursive: true });
    const logger = createLogger({ level: 'error', console: false }).child('moved-test');
    const db = openDatabase({ path: join(newDir, 'archive.db') });
    try {
      // 造一份「老目录」的快照，登记时的路径指向老目录，再把 data 整体搬到新目录
      const snapshotName = 'archive-manual-20260101-120000.db';
      writeFileSync(join(oldDir, 'backups', snapshotName), 'SNAPSHOT-BYTES');
      writeFileSync(
        join(oldDir, 'backups', snapshotName.replace(/\.db$/, '.manifest.json')),
        JSON.stringify({ format: 'qqarchive-backup/1', kind: 'manual', createdAt: '2026-01-01T12:00:00.000Z', sha256: 'a'.repeat(64), sizeBytes: 14, count: { messages: 42, media: 3 } }),
      );
      const oldRowId = db.registerExistingBackup({
        path: join(oldDir, 'backups', snapshotName),
        kind: 'manual',
        createdAt: '2026-01-01T12:00:00.000Z',
      })!;
      assert.ok(oldRowId > 0);

      // 搬迁：文件挪到新目录（行里的老路径已失效）
      const movedBytes = readFileSync(join(oldDir, 'backups', snapshotName));
      writeFileSync(join(newDir, 'backups', snapshotName), movedBytes);
      writeFileSync(
        join(newDir, 'backups', snapshotName.replace(/\.db$/, '.manifest.json')),
        readFileSync(join(oldDir, 'backups', snapshotName.replace(/\.db$/, '.manifest.json'))),
      );
      rmSync(join(oldDir, 'backups'), { recursive: true, force: true });

      const res = reconcileBackups({ db, backupDir: join(newDir, 'backups'), logger });
      assert.equal(res.added, 0, '同一个快照不能因为路径变了就被再登记一行');
      assert.equal(res.repointed, 1, '老行应被改指到新位置');

      const rows = db.listBackups(10);
      assert.equal(rows.length, 1, `表里应只有一行，实际 ${rows.length}`);
      assert.equal(rows[0]!.path, join(newDir, 'backups', snapshotName));
      assert.ok(existsSync(rows[0]!.path), '改指后的路径必须真实存在');

      // 改指之后保留策略才算得对：keep=1 时这份不会被当「最旧的」误删
      const pruned = pruneBackups({ db, backupDir: join(newDir, 'backups'), keep: 1, logger });
      assert.deepEqual(pruned.removed, [], '唯一一份备份不应被裁剪');
      assert.equal(db.listBackups(10).length, 1);
    } finally {
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
