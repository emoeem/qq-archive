/**
 * 备份/恢复里"媒体"这条链路的回归测试。
 *
 * 锁定两个真实缺陷（都是"命令报成功、实际没做事"这一类）：
 *
 *  1. `restore <快照.db>` 时不再去找同名 `.manifest.json` → 没有清单就既不能校验 sha256、
 *     也不知道媒体目录叫什么，于是 `--restore-media` **静默什么都不做**。
 *     实测现象：删掉 52 个媒体文件后执行 `restore --apply --restore-media`，
 *     输出"恢复已执行：通过"，媒体目录仍然是空的。
 *  2. 请求了恢复媒体却没有媒体可恢复时**不打任何提示**（上面的静默就是这么来的）。
 *
 * 另外补一条正向用例：`backup --with-media` 打的包里确实带媒体，且恢复后
 * 每个文件的 sha256 与数据库记录一致（不是"文件回来了但内容不对"）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_CONFIG, sha256Hex } from '../packages/core/src/index.ts';
import { openDatabase } from '../packages/db/src/index.ts';
import { resolveBackupReference, createBackup, restoreBackup } from '../packages/server/src/backup.ts';
import { createLogger } from '../packages/core/src/index.ts';

const CLI_ENTRY = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'apps', 'cli', 'src', 'main.ts');

test('备份引用解析：传快照 .db 也要能找到同名 manifest（否则 --restore-media 会静默失效）', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'qq-bref-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const snap = join(root, 'archive-manual-20260101-000000.db');
  const man = join(root, 'archive-manual-20260101-000000.manifest.json');
  writeFileSync(snap, 'x');
  writeFileSync(man, JSON.stringify({ format: 'qqarchive-backup/1', snapshot: 'archive-manual-20260101-000000.db' }));

  assert.deepEqual(resolveBackupReference(snap), { snapshotPath: snap, manifestPath: man }, '传 .db 时应顺带找到同名 manifest');
  assert.deepEqual(resolveBackupReference(man), { snapshotPath: snap, manifestPath: man }, '传 manifest 时正常解析');
  assert.deepEqual(resolveBackupReference(root), { snapshotPath: snap, manifestPath: man }, '传目录时取最新快照 + 同名 manifest');

  // 没有同名 manifest 时退回 null（不报错），但调用方必须据此告警
  const lonely = join(root, 'archive-auto-20260102-000000.db');
  writeFileSync(lonely, 'x');
  assert.deepEqual(resolveBackupReference(lonely), { snapshotPath: lonely, manifestPath: null });
});

test('恢复媒体：请求了却无媒体可恢复时必须给出警告，不能静默通过', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'qq-bmedia-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  mkdirSync(join(dataDir, 'media'), { recursive: true });
  mkdirSync(join(dataDir, 'backups'), { recursive: true });

  const config = {
    ...structuredClone(DEFAULT_CONFIG),
    storage: {
      dataDir,
      dbPath: join(dataDir, 'archive.db'),
      mediaDir: join(dataDir, 'media'),
      backupDir: join(dataDir, 'backups'),
      logDir: join(dataDir, 'logs'),
    },
    collector: { ...DEFAULT_CONFIG.collector, kind: 'none' as const },
  };
  const logger = createLogger({ level: 'error', console: false }).child('media-test');

  // 造一份**不含媒体**的备份（默认行为）
  const db = openDatabase({ path: config.storage.dbPath });
  const session = db.ensureSession({ accountUid: 'default', chatType: 'group', peerUid: 'g:1', name: '媒体测试群' });
  db.insertMessages(session.id, 'default', 'group:g:1', [{
    msgKey: 'id:m1', msgId: 'm1', ts: 1_700_000_000_000, direction: 'in', msgType: 'text', text: '你好',
  }], { source: 'test' });
  const backup = await createBackup({ db, config, logger, kind: 'manual' });
  db.close();

  const res = await restoreBackup({
    db: openDatabase({ path: config.storage.dbPath }),
    config,
    logger,
    backupPath: backup.snapshotPath,
    dryRun: false,
    restoreMedia: true,
  });
  try {
    assert.equal(res.mediaRestored, 0);
    assert.ok(
      res.warnings.some((w) => w.includes('媒体') && w.includes('未恢复')),
      `必须警告"请求了媒体恢复但没有媒体可恢复"，实际 warnings=${JSON.stringify(res.warnings)}`,
    );
  } finally {
    res.reopened?.close();
  }
});

test('媒体往返：backup --with-media → 删掉媒体 → restore --restore-media 完整还原（sha256 逐个核对）', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'qq-mrt-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  mkdirSync(join(dataDir, 'media'), { recursive: true });
  mkdirSync(join(dataDir, 'backups'), { recursive: true });

  const config = {
    ...structuredClone(DEFAULT_CONFIG),
    server: { ...DEFAULT_CONFIG.server, token: 'media-roundtrip-token-012345678' },
    storage: {
      dataDir,
      dbPath: join(dataDir, 'archive.db'),
      mediaDir: join(dataDir, 'media'),
      backupDir: join(dataDir, 'backups'),
      logDir: join(dataDir, 'logs'),
    },
    collector: { ...DEFAULT_CONFIG.collector, kind: 'none' as const },
  };
  writeFileSync(join(root, 'config.json'), JSON.stringify(config, null, 2));
  const configPath = join(root, 'config.json');

  // 准备：真实媒体文件（内容寻址布局）+ 数据库记录
  const db = openDatabase({ path: config.storage.dbPath });
  const session = db.ensureSession({ accountUid: 'default', chatType: 'private', peerUid: 'u:1', name: '媒体往返' });
  const files: Array<{ rel: string; sha: string; bytes: Buffer }> = [];
  for (let i = 0; i < 3; i += 1) {
    const bytes = Buffer.from(`MEDIA-BYTES-${i}-` + 'x'.repeat(i * 10));
    const sha = sha256Hex(bytes);
    const rel = `image/2026/01/${sha.slice(0, 2)}/${sha}.bin`;
    mkdirSync(dirname(join(config.storage.mediaDir, rel)), { recursive: true });
    writeFileSync(join(config.storage.mediaDir, rel), bytes);
    files.push({ rel, sha, bytes });
  }
  for (let i = 0; i < files.length; i += 1) {
    const f = files[i]!;
    const m = db.upsertMedia({ sha256: f.sha, kind: 'image', size: f.bytes.length, relPath: f.rel, status: 'present' });
    const msg = db.insertMessages(session.id, 'default', 'private:u:1', [{
      msgKey: `id:media${i}`, msgId: `media${i}`, ts: 1_700_000_000_000 + i, direction: 'in', msgType: 'image', text: '[图片]',
    }], { source: 'test' });
    assert.equal(msg.inserted, 1);
    db.linkMessageMedia(msg.messageIds[0]!, m.id, 0, `pic${i}.jpg`, f.bytes.length);
  }
  db.close();

  const run = (args: string[]): { status: number | null; out: string } => {
    const r = spawnSync(process.execPath, ['--experimental-strip-types', CLI_ENTRY, ...args], {
      encoding: 'utf8',
      env: { ...process.env, QQ_ARCHIVE_CONFIG: '', QQ_ARCHIVE_DATA_DIR: '' },
      timeout: 180_000,
    });
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const mediaCount = (): number => {
    const walk = (d: string): number => {
      if (!existsSync(d)) return 0;
      let n = 0;
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) n += walk(join(d, e.name));
        else n += 1;
      }
      return n;
    };
    return walk(config.storage.mediaDir);
  };

  await t.test('backup --with-media 打出的包真的带媒体（manifest 声明 + 目录存在）', () => {
    const r = run(['backup', '--with-media', '--label', '媒体往返', '--config', configPath]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /媒体.*3/, '输出里应带媒体统计');

    const snaps = readdirSync(config.storage.backupDir).filter((f) => f.startsWith('archive-媒体往返-') && f.endsWith('.db'));
    assert.equal(snaps.length, 1, `应有 1 份快照，实际 ${snaps.join(',')}`);
    const snap = join(config.storage.backupDir, snaps[0]!);
    const manifest = JSON.parse(readFileSync(`${snap.slice(0, -3)}.manifest.json`, 'utf8')) as {
      media: { included: boolean; dir: string | null; files: number };
    };
    assert.equal(manifest.media.included, true);
    assert.equal(manifest.media.files, 3);
    assert.ok(manifest.media.dir !== null && existsSync(join(config.storage.backupDir, manifest.media.dir)), '媒体目录应真实存在');
    assert.equal(mediaCount(), 3);
  });

  await t.test('删掉媒体后恢复：文件必须回来，且 sha256 与库记录一致', () => {
    rmSync(config.storage.mediaDir, { recursive: true, force: true });
    assert.equal(mediaCount(), 0, '前置条件：媒体已全部删除');

    const snaps = readdirSync(config.storage.backupDir).filter((f) => f.endsWith('.db'));
    const snap = join(config.storage.backupDir, snaps[0]!);
    const r = run(['restore', snap, '--apply', '--restore-media', '--config', configPath]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /恢复已执行/);
    assert.equal(mediaCount(), 3, `媒体应被完整还原，实际 ${mediaCount()} 个`);

    // 不只是"文件回来了"，内容也要对：逐个重算 sha256 与数据库记录比对
    const d = new DatabaseSync(config.storage.dbPath);
    try {
      const rows = d.prepare('SELECT rel_path, sha256 FROM media WHERE status = ?').all('present') as Array<{ rel_path: string; sha256: string }>;
      assert.equal(rows.length, 3);
      for (const row of rows) {
        const p = join(config.storage.mediaDir, row.rel_path);
        assert.ok(existsSync(p), `缺文件：${row.rel_path}`);
        const hash = createHash('sha256').update(readFileSync(p)).digest('hex');
        assert.equal(hash, row.sha256, `内容不一致：${row.rel_path}`);
        assert.equal(statSync(p).size, readFileSync(p).length);
      }
    } finally {
      d.close();
    }
  });

  await t.test('恢复媒体但不含媒体的备份（普通 backup）必须给出警告', () => {
    // 用一份没有媒体的备份再试一次
    const plain = run(['backup', '--label', '无媒体', '--config', configPath]);
    assert.equal(plain.status, 0, plain.out);
    const snaps = readdirSync(config.storage.backupDir).filter((f) => f.startsWith('archive-无媒体-') && f.endsWith('.db'));
    const snap = join(config.storage.backupDir, snaps[0]!);
    rmSync(config.storage.mediaDir, { recursive: true, force: true });
    const r = run(['restore', snap, '--apply', '--restore-media', '--config', configPath]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /媒体未恢复|没有媒体/, `应明确说明媒体没恢复：\n${r.out}`);
  });
});
