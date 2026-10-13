/**
 * 运行日志回路的回归测试：**写库**与**清理**。
 *
 * 锁定两个「实现了但没接线」的真实缺口（与之前的引用预览、备份对账同一类）：
 *
 *  - G1：`Logger` 的 `dbSink` 早就写好、`logs` 表与 `/api/logs`、网页日志页也都在，
 *    但**没有任何调用点把 sink 传进去** → `SELECT COUNT(*) FROM logs` 恒为 0，
 *    网页「运行日志与错误」永远是空的（终端里滚过去的失败再也查不到）。
 *  - G2：`Db.pruneLogs()` 定义了却**零调用** → 数据库日志没有保留策略。
 *
 * 这里用真实子进程跑 CLI（不是直接调函数），因为缺口恰恰出在「接线」上：
 * 只测 `Logger` 本身的单测在修复前也会全绿。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { logsConfigOf, DEFAULT_LOGS_CONFIG, validateConfig, DEFAULT_CONFIG } from '../packages/core/src/index.ts';
import type { AppConfig } from '../packages/core/src/index.ts';

const CLI_ENTRY = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'apps', 'cli', 'src', 'main.ts');

function writeConfig(dir: string, patch: (c: AppConfig) => void): string {
  const cfg: AppConfig = JSON.parse(JSON.stringify({
    ...DEFAULT_CONFIG,
    server: { ...DEFAULT_CONFIG.server, token: 'test-token-0123456789abcdef' },
    storage: { ...DEFAULT_CONFIG.storage, dataDir: join(dir, 'data') },
    collector: { ...DEFAULT_CONFIG.collector, kind: 'onebot', baseUrl: 'http://127.0.0.1:59997', token: 'x'.repeat(32) },
  }));
  patch(cfg);
  const p = join(dir, 'config.json');
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(p, JSON.stringify(cfg, null, 2));
  return p;
}

function runCli(args: string[], env: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', CLI_ENTRY, ...args], {
    encoding: 'utf8',
    env: { ...process.env, QQ_ARCHIVE_CONFIG: '', QQ_ARCHIVE_DATA_DIR: '', ...env },
    timeout: 120_000,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function logsOf(dbPath: string): Array<{ level: string; scope: string; message: string }> {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare('SELECT level, scope, message FROM logs ORDER BY id').all() as Array<{ level: string; scope: string; message: string }>;
  } finally {
    db.close();
  }
}

test('日志落库：真实 CLI 采集失败会把 error 写进 logs 表（修复前恒为 0 行）', () => {
  const root = mkdtempSync(join(tmpdir(), 'qq-logsink-'));
  try {
    const configPath = writeConfig(root, (c) => {
      c.collector.baseUrl = 'http://127.0.0.1:59997'; // 没有服务在听 → probe 必失败
    });
    const dbPath = join(root, 'data', 'archive.db');

    const r = runCli(['collect', '--once', '--config', configPath]);
    assert.equal(r.status, 3, `采集端不可用应以退出码 3 结束，实际 ${r.status}\n${r.stderr}`);
    assert.ok(r.stderr.includes('采集端不可用'), '终端仍应给出提示');

    const rows = logsOf(dbPath);
    assert.ok(rows.length >= 1, 'logs 表必须有记录 —— 这正是修复前为 0 的地方');
    const err = rows.find((x) => x.level === 'error');
    assert.ok(err, `应有一条 error 级日志，实际：${JSON.stringify(rows)}`);
    assert.equal(err.scope, 'collect');
    assert.match(err.message, /采集端不可用/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('日志落库：info 级不落库，避免日志表被噪声淹没', () => {
  const root = mkdtempSync(join(tmpdir(), 'qq-logsink-info-'));
  try {
    const configPath = writeConfig(root, (c) => {
      c.collector.kind = 'none'; // 不触发采集
    });
    const dbPath = join(root, 'data', 'archive.db');
    const r = runCli(['doctor', '--config', configPath]);
    assert.equal(r.status, 0, `doctor 应成功\n${r.stderr}`);
    assert.ok(r.stdout.length > 0, 'doctor 应打印检查结果（这些是 info 级）');
    assert.equal(logsOf(dbPath).length, 0, 'info 级不应进 logs 表');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('日志清理：启动时按 logs.dbKeepDays 删掉过期行，保留期内的行不受影响', () => {
  const root = mkdtempSync(join(tmpdir(), 'qq-logprune-'));
  try {
    const configPath = writeConfig(root, (c) => {
      c.collector.kind = 'none';
      c.logs = { dbKeepDays: 30 };
    });
    const dbPath = join(root, 'data', 'archive.db');
    // 先跑一次让库建起来（迁移 + 建表）
    assert.equal(runCli(['doctor', '--config', configPath]).status, 0);

    const db = new DatabaseSync(dbPath);
    const ins = db.prepare('INSERT INTO logs(ts,level,scope,message,data) VALUES(?,?,?,?,?)');
    const day = 86_400_000;
    ins.run(new Date(Date.now() - 40 * day).toISOString(), 'warn', 'old', '四十天前', null);
    ins.run(new Date(Date.now() - 3 * day).toISOString(), 'warn', 'recent', '三天前', null);
    db.close();

    assert.equal(runCli(['doctor', '--config', configPath]).status, 0);
    const kept = logsOf(dbPath).map((x) => x.scope);
    assert.deepEqual(kept, ['recent'], `过期的 old 应被清理，实际保留：${JSON.stringify(kept)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('日志清理：dbKeepDays=0 表示不清理（不会误删历史）', () => {
  const root = mkdtempSync(join(tmpdir(), 'qq-logprune-off-'));
  try {
    const configPath = writeConfig(root, (c) => {
      c.collector.kind = 'none';
      c.logs = { dbKeepDays: 0 };
    });
    const dbPath = join(root, 'data', 'archive.db');
    assert.equal(runCli(['doctor', '--config', configPath]).status, 0);
    const db = new DatabaseSync(dbPath);
    db.prepare('INSERT INTO logs(ts,level,scope,message,data) VALUES(?,?,?,?,?)').run(
      new Date(Date.now() - 400 * 86_400_000).toISOString(), 'warn', 'ancient', '很久以前', null,
    );
    db.close();

    assert.equal(runCli(['doctor', '--config', configPath]).status, 0);
    assert.deepEqual(logsOf(dbPath).map((x) => x.scope), ['ancient'], 'keepDays=0 时不得删除任何行');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('日志清理：环境变量 QQ_ARCHIVE_LOG_KEEP_DAYS 可覆盖保留天数', () => {
  const root = mkdtempSync(join(tmpdir(), 'qq-logprune-env-'));
  try {
    const configPath = writeConfig(root, (c) => {
      c.collector.kind = 'none';
      c.logs = { dbKeepDays: 30 };
    });
    const dbPath = join(root, 'data', 'archive.db');
    assert.equal(runCli(['doctor', '--config', configPath]).status, 0);
    const db = new DatabaseSync(dbPath);
    db.prepare('INSERT INTO logs(ts,level,scope,message,data) VALUES(?,?,?,?,?)').run(
      new Date(Date.now() - 10 * 86_400_000).toISOString(), 'warn', 'ten-days', '十天前', null,
    );
    db.close();

    // 配 30 天时它不该被删；把保留期压到 5 天后必须被删
    assert.equal(runCli(['doctor', '--config', configPath]).status, 0);
    assert.deepEqual(logsOf(dbPath).map((x) => x.scope), ['ten-days'], '30 天保留期内不应被删');
    assert.equal(runCli(['doctor', '--config', configPath], { QQ_ARCHIVE_LOG_KEEP_DAYS: '5' }).status, 0);
    assert.deepEqual(logsOf(dbPath).map((x) => x.scope), [], '保留期改为 5 天后应被删掉');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('logs 配置：默认 30 天、缺段时回落默认、非法值被 validateConfig 拦下', () => {
  assert.equal(DEFAULT_LOGS_CONFIG.dbKeepDays, 30);
  assert.equal(logsConfigOf(DEFAULT_CONFIG).dbKeepDays, 30, 'DEFAULT_CONFIG 应带上默认保留期');
  assert.equal(logsConfigOf({ ...DEFAULT_CONFIG, logs: undefined }).dbKeepDays, 30, '缺 logs 段时回落默认');
  assert.equal(logsConfigOf({ ...DEFAULT_CONFIG, logs: { dbKeepDays: 7 } }).dbKeepDays, 7, '显式值应生效');

  const bad = { ...DEFAULT_CONFIG, logs: { dbKeepDays: -1 } };
  assert.ok(
    validateConfig(bad).some((p) => p.includes('logs.dbKeepDays')),
    '负数保留天数应被校验拦下',
  );
});
