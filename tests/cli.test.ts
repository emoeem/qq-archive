import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { cmdTranscribe, parseArgs, type Ctx } from '../apps/cli/src/main.ts';
import {
  loadConfig,
  validateConfig,
  createLogger,
  DEFAULT_CONFIG,
  DEFAULT_STT_CONFIG,
  sha256Hex,
  type AppConfig,
} from '../packages/core/src/index.ts';
import { openDatabase, LATEST_VERSION, type Db } from '../packages/db/src/index.ts';
import type { ExecFn } from '../packages/stt/src/index.ts';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, statSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateFixtures } from './fixtures/generate.ts';

test('cli: parseArgs 解析命令、位置参数与不同形式的选项', () => {
  const r1 = parseArgs(['import', '/tmp/a.json', '/tmp/b.jsonl', '--account', 'u1', '--limit=100']);
  assert.equal(r1.command, 'import');
  assert.deepEqual(r1.args, ['/tmp/a.json', '/tmp/b.jsonl']);
  assert.equal(r1.flags.account, 'u1');
  assert.equal(r1.flags.limit, '100');

  const r2 = parseArgs(['serve', '--port', '9000', '--host=0.0.0.0']);
  assert.equal(r2.command, 'serve');
  assert.equal(r2.flags.port, '9000');
  assert.equal(r2.flags.host, '0.0.0.0');

  const r3 = parseArgs(['collect', '--once']);
  assert.equal(r3.flags.once, true);

  const r4 = parseArgs(['backup', '--no-verify']);
  assert.equal(r4.flags['no-verify'], true);

  // 短选项
  const r5 = parseArgs(['logs', '-limit', '5']);
  assert.equal(r5.flags.limit, '5');
});

test('cli: 无参数时默认显示帮助', () => {
  assert.equal(parseArgs([]).command, '--help');
});

/**
 * 背景（真实发生过的缺陷）：`parseArgs()` 在「没有命令」时无条件把 command 兜底成 `'--help'`，
 * 而 `main()` 先判断帮助、后判断版本，于是 `qq-archive --version` 打印的是**整篇用法**而不是版本号 ——
 * 任何 `--version` 探测脚本都会拿到一坨帮助文本。
 */
test('cli: --version / -V 打印版本号，而不是退化成用法', () => {
  assert.equal(parseArgs(['--version']).command, '', '--version 不应被兜底成 --help');
  assert.equal(parseArgs(['-V']).command, '');
  assert.equal(parseArgs([]).command, '--help', '无参数仍应显示帮助');
  assert.equal(parseArgs(['--help']).command, 'help');

  const v1 = runCli(['--version'], REPO_ROOT);
  assert.equal(v1.status, 0);
  assert.match(v1.stdout.trim(), /^qq-archive \d+\.\d+\.\d+$/, `应只打印版本号：\n${v1.stdout}`);
  assert.doesNotMatch(v1.stdout, /用法/, `不应打印用法：\n${v1.stdout}`);

  const v2 = runCli(['-V'], REPO_ROOT);
  assert.equal(v2.status, 0);
  assert.match(v2.stdout.trim(), /^qq-archive \d+\.\d+\.\d+$/, `-V 应只打印版本号：\n${v2.stdout}`);
});

test('cli: bin/qq-archive.mjs 包装脚本能直接跑（用户不必手打长路径与 flag）', async () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { bin: Record<string, string> };
  assert.equal(pkg.bin['qq-archive'], 'bin/qq-archive.mjs', 'package.json 必须声明 bin，否则 link 之后没有 qq-archive 命令');

  const r = spawnSync(process.execPath, [join(REPO_ROOT, 'bin', 'qq-archive.mjs'), '--version'], { encoding: 'utf8' });
  assert.equal(r.status, 0, `包装脚本应正常退出：\n${r.stdout}\n${r.stderr}`);
  assert.match((r.stdout ?? '').trim(), /^qq-archive \d+\.\d+\.\d+$/, `应透传版本输出：\n${r.stdout}`);
});

test('config: 环境变量覆盖优先于配置文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-archive-cfg-'));
  try {
    const cfgPath = join(dir, 'config.json');
    writeFileSync(
      cfgPath,
      JSON.stringify({ server: { host: '127.0.0.1', port: 1111, token: 'x'.repeat(40) }, storage: { dataDir: './d' } }),
    );
    const prevPort = process.env.QQ_ARCHIVE_PORT;
    const prevHost = process.env.QQ_ARCHIVE_HOST;
    process.env.QQ_ARCHIVE_PORT = '2222';
    process.env.QQ_ARCHIVE_HOST = '0.0.0.0';
    try {
      const { config } = loadConfig(cfgPath);
      assert.equal(config.server.port, 2222, '环境变量应覆盖配置文件');
      assert.equal(config.server.host, '0.0.0.0');
      assert.equal(config.server.sessionTtlSec, DEFAULT_CONFIG.server.sessionTtlSec, '未指定字段应取默认值');
      assert.ok(config.storage.dataDir.startsWith('/'), 'dataDir 应被解析为绝对路径');
    } finally {
      if (prevPort === undefined) delete process.env.QQ_ARCHIVE_PORT;
      else process.env.QQ_ARCHIVE_PORT = prevPort;
      if (prevHost === undefined) delete process.env.QQ_ARCHIVE_HOST;
      else process.env.QQ_ARCHIVE_HOST = prevHost;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config: 不存在的配置文件会生成随机令牌且标记 defaultsUsed', () => {
  const prevCfg = process.env.QQ_ARCHIVE_CONFIG;
  const prevTok = process.env.QQ_ARCHIVE_TOKEN;
  delete process.env.QQ_ARCHIVE_TOKEN;
  try {
    const { config, defaultsUsed, tokenGenerated } = loadConfig('/nonexistent/path/config.json');
    assert.equal(defaultsUsed, true);
    assert.equal(tokenGenerated, true);
    assert.ok(config.server.token.length >= 32, '自动生成的令牌应足够长');
  } finally {
    if (prevCfg === undefined) delete process.env.QQ_ARCHIVE_CONFIG;
    else process.env.QQ_ARCHIVE_CONFIG = prevCfg;
    if (prevTok !== undefined) process.env.QQ_ARCHIVE_TOKEN = prevTok;
  }
});

test('config: 校验能抓出端口、令牌强度、采集地址问题', () => {
  const bad: AppConfig = structuredClone(DEFAULT_CONFIG);
  bad.server.port = 70000;
  bad.server.token = 'short';
  bad.collector.kind = 'onebot';
  bad.collector.baseUrl = 'not-a-url';
  const problems = validateConfig(bad);
  assert.ok(problems.some((p) => p.includes('port')), `应报端口问题: ${problems.join('|')}`);
  assert.ok(problems.some((p) => p.includes('token')), `应报令牌问题: ${problems.join('|')}`);
  assert.ok(problems.some((p) => p.includes('baseUrl')), `应报采集地址问题: ${problems.join('|')}`);

  const good: AppConfig = structuredClone(DEFAULT_CONFIG);
  good.server.token = 'a'.repeat(40);
  assert.deepEqual(validateConfig(good), []);
});

test('config: 非本机监听时要求更强令牌', () => {
  const cfg: AppConfig = structuredClone(DEFAULT_CONFIG);
  cfg.server.host = '0.0.0.0';
  cfg.server.token = 'a'.repeat(20); // 20 字符：本机够用，公网不够
  const problems = validateConfig(cfg);
  assert.ok(
    problems.some((p) => p.includes('非本机')),
    `监听 0.0.0.0 且令牌仅 20 字符应被拒绝: ${problems.join('|')}`,
  );
  cfg.server.token = 'a'.repeat(32);
  assert.deepEqual(validateConfig(cfg), []);
});

test('cli: --config 放在命令之前或之后都能解析出同一个配置文件', () => {
  const after = parseArgs(['import', '/tmp/a.json', '--config', '/etc/qq.json']);
  assert.equal(after.command, 'import');
  assert.deepEqual(after.args, ['/tmp/a.json']);
  assert.equal(after.flags.config, '/etc/qq.json');

  const before = parseArgs(['--config', '/etc/qq.json', 'import', '/tmp/a.json']);
  assert.equal(before.command, 'import', '命令应是第一个非选项 token，而不是 --config');
  assert.deepEqual(before.args, ['/tmp/a.json']);
  assert.equal(before.flags.config, '/etc/qq.json');

  const eq = parseArgs(['--config=/etc/qq.json', 'stats']);
  assert.equal(eq.command, 'stats');
  assert.equal(eq.flags.config, '/etc/qq.json');
});

/* ------------------------------------------------------------------ */
/* 真实子进程端到端：防止「--config 被静默忽略」回归                    */
/* ------------------------------------------------------------------ */

/**
 * 这组用例用**真实子进程**跑 CLI，是本文件里唯一能抓住「参数没传到 loadConfig()」的地方。
 *
 * 背景（真实发生过的缺陷）：`main()` 解析出了 `flags.config`，但 `buildCtx()` 调的是
 * `loadConfig()`（无参），于是 `--config` 被静默忽略、回退到 `./config.json`，
 * 结果把 archive.db 和媒体文件写进了**进程当前目录**而不是配置指定的目录。
 * 纯函数的 `parseArgs` 单测永远发现不了它——必须真的跑一次子进程并检查落盘位置。
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI_ENTRY = join(REPO_ROOT, 'apps', 'cli', 'src', 'main.ts');

interface CliRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string): CliRun {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', CLI_ENTRY, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, QQ_ARCHIVE_CONFIG: '', QQ_ARCHIVE_DATA_DIR: '' },
    timeout: 120_000,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

test('cli 端到端：--config 指定的目录真的被使用，媒体表与 message_media 真有数据', () => {
  const root = mkdtempSync(join(tmpdir(), 'qq-cli-e2e-'));
  try {
    // 相对路径刻意写成相对**配置文件所在目录**，顺便验证 resolvePaths 的基准目录。
    const cfgPath = join(root, 'config.json');
    writeFileSync(
      cfgPath,
      JSON.stringify({
        server: { host: '127.0.0.1', port: 8788, token: 'cli-e2e-token-0123456789abcdefgh' },
        storage: { dataDir: './data', dbPath: './data/archive.db', mediaDir: './data/media' },
      }),
    );
    const fixtures = generateFixtures({ outDir: join(root, 'fx') });

    // ---- 1) import：必须把数据写进 <root>/data，而不是进程 cwd ----
    const imported = runCli(['import', fixtures.files.groupJson, '--config', cfgPath], root);
    assert.equal(imported.status, 0, `import 应以 0 退出：\n${imported.stdout}\n${imported.stderr}`);

    const dbPath = join(root, 'data', 'archive.db');
    assert.ok(existsSync(dbPath), `--config 未被忽略时应生成 ${dbPath}`);

    const logger = createLogger({ level: 'error', console: false });
    const db = openDatabase({ path: dbPath, logger: logger.child('verify') });
    try {
      assert.equal(db.stats().messages, 244, '消息数应为 groupMessages − duplicateInFile');

      // ---- 媒体真的落库了（此前 CLI 只归档到磁盘、media 表恒为 0 行）----
      const media = db.mediaStats();
      assert.equal(media.present, 5, '5 个不同 sha256 的媒体应为 present');
      assert.equal(media.missing, fixtures.expected.mediaMissingDeclared, '只有 gone-forever.png 应标记缺失');
      assert.equal(media.total, 6, '去重后 media 表应恰好 6 行（5 present + 1 missing）');

      const links = db.raw.prepare('SELECT COUNT(*) AS n FROM message_media').get() as unknown as { n: number };
      assert.ok(links.n > 0, 'message_media 必须有真实关联，否则 Web 媒体页永远空白');
      const missingLinks = db.raw
        .prepare(
          "SELECT COUNT(*) AS n FROM message_media mm JOIN media m ON m.id = mm.media_id WHERE m.status <> 'present'",
        )
        .get() as unknown as { n: number };
      assert.equal(missingLinks.n, 1, '只有 1 条关联指向真正缺失的媒体');

      // present 的文件必须在磁盘上真实存在；missing 的必须不在。
      const rows = db.raw
        .prepare("SELECT rel_path, status FROM media")
        .all() as unknown as Array<{ rel_path: string; status: string }>;
      assert.equal(rows.length, 6);
      for (const row of rows) {
        const onDisk = existsSync(join(root, 'data', 'media', row.rel_path));
        if (row.status === 'present') {
          assert.ok(onDisk, `present 的媒体必须真实存在：${row.rel_path}`);
        } else {
          assert.equal(onDisk, false, `missing 的媒体不得有文件：${row.rel_path}`);
        }
      }
    } finally {
      db.close();
    }

    // ---- 2) stats 通过 CLI 也能看到媒体（走的是同一个库）----
    const stats = runCli(['stats', '--config', cfgPath], root);
    assert.equal(stats.status, 0);
    assert.match(stats.stdout, /244/, `stats 应显示 244 条消息：\n${stats.stdout}`);
    assert.match(stats.stdout, /5 已保存/, `stats 应显示 5 个已保存媒体：\n${stats.stdout}`);

    // ---- 3) --config 放在命令之前同样生效 ----
    const statsBefore = runCli(['--config', cfgPath, 'stats'], root);
    assert.equal(statsBefore.status, 0);
    assert.match(statsBefore.stdout, /244/, `--config 前置时应仍然读同一个库：\n${statsBefore.stdout}`);

    // ---- 4) 二次导入幂等：0 新增，全部计为重复 ----
    const again = runCli(['import', fixtures.files.groupJson, '--config', cfgPath], root);
    assert.equal(again.status, 0);
    assert.match(again.stdout, /新增 0/, `二次导入不应新增消息：\n${again.stdout}`);

    const check = openDatabase({ path: dbPath, logger: logger.child('verify2') });
    try {
      assert.equal(check.stats().messages, 244, '幂等：消息总数不得变化');
      assert.equal(check.mediaStats().total, 6, '幂等：media 表不得重复插入');
    } finally {
      check.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cli 端到端：backup → verify → restore(dry-run) → restore(--apply) 全链路可用', () => {
  const root = mkdtempSync(join(tmpdir(), 'qq-cli-restore-'));
  try {
    const cfgPath = join(root, 'config.json');
    writeFileSync(
      cfgPath,
      JSON.stringify({
        server: { host: '127.0.0.1', port: 8789, token: 'cli-e2e-token-0123456789abcdefgh' },
        storage: {
          dataDir: './data',
          dbPath: './data/archive.db',
          mediaDir: './data/media',
          backupDir: './data/backups',
          logDir: './data/logs',
        },
      }),
    );
    const fixtures = generateFixtures({ outDir: join(root, 'fx') });
    assert.equal(runCli(['import', fixtures.files.groupJson, '--config', cfgPath], root).status, 0);

    const backup = runCli(['backup', '--config', cfgPath], root);
    assert.equal(backup.status, 0, `backup 应成功：\n${backup.stdout}\n${backup.stderr}`);
    const snapshot = backup.stdout.match(/\/[^\s]+\.db/)?.[0];
    assert.ok(snapshot !== undefined && existsSync(snapshot), `应产出快照文件：\n${backup.stdout}`);

    // 回归护栏：CLI 备份必须往 backups 表里写一行。
    // 曾经的 bug：CLI 只生成快照文件、不写表 → 磁盘上有 .db，网页「归档管理」的
    // 最后备份时间与备份列表却全空（/api/stats 的 lastBackupAt 恒为 null）。
    {
      const logger = createLogger({ level: 'error', console: false });
      const db = openDatabase({ path: join(root, 'data', 'archive.db'), logger: logger.child('cli-backup-row') });
      try {
        const rows = db.listBackups(10);
        assert.equal(rows.length, 1, `CLI backup 应写 1 条 backups 记录，实际 ${rows.length} 条`);
        assert.equal(rows[0]!.status, 'done');
        assert.equal(rows[0]!.path, snapshot);
        assert.match(String(rows[0]!.dbSha256), /^[0-9a-f]{64}$/, '备份记录应带 sha256');
      } finally {
        db.close();
      }
    }

    const verify = runCli(['verify', '--config', cfgPath], root);
    assert.equal(verify.status, 0, `verify 应成功：\n${verify.stdout}`);
    assert.match(verify.stdout, /损坏 0/, `不应有损坏媒体：\n${verify.stdout}`);

    const dry = runCli(['restore', snapshot, '--config', cfgPath], root);
    assert.equal(dry.status, 0, `dry-run 应成功：\n${dry.stdout}`);
    assert.match(dry.stdout, /244/, `dry-run 应报清单消息 244：\n${dry.stdout}`);

    const applied = runCli(['restore', snapshot, '--config', cfgPath, '--apply'], root);
    assert.equal(applied.status, 0, `真实恢复应成功：\n${applied.stdout}\n${applied.stderr}`);

    const logger = createLogger({ level: 'error', console: false });
    const db = openDatabase({ path: join(root, 'data', 'archive.db'), logger: logger.child('after-restore') });
    try {
      assert.equal(db.stats().messages, 244, '恢复后消息数应保持 244');
      assert.equal(db.schemaVersion(), LATEST_VERSION, '恢复后 schema 应迁移到最新版本');
    } finally {
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* 网页托管：防止「repoRoot 少了一层 → GET / 恒 404」                   */
/* ------------------------------------------------------------------ */

async function freePort(): Promise<number> {
  return await new Promise<number>((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      s.close(() => res(port));
    });
  });
}

async function waitForUrl(url: string, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

/**
 * 背景（真实发生过的缺陷）：`cmdServe()` 把 `repoRoot` 算成了 `resolve(import.meta.dirname, '../..')`，
 * 而 `main.ts` 在 `<repo>/apps/cli/src/`，往回两层是 `<repo>/apps` —— 静态目录于是被解析成
 * `<repo>/apps/web`（不存在），**GET / 永远是 404**。
 *
 * 之前的 server 测试全部自己构造 `repoRoot`（`join(root,'repo')` + 手写 `web/index.html`），
 * 所以这个「只有真实 CLI 路径才会错」的缺陷在 100 多个用例里全绿通过。
 * 这条用例刻意从**临时 cwd** 起真实子进程、访问真实的 `/`。
 */
test('cli 端到端：serve 真的托管出网页界面（GET / 必须是 HTML，而不是 404）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qq-cli-serve-'));
  let child: ReturnType<typeof spawn> | null = null;
  try {
    const port = await freePort();
    const cfgPath = join(root, 'config.json');
    writeFileSync(
      cfgPath,
      JSON.stringify({
        server: { host: '127.0.0.1', port, token: 'serve-e2e-token-0123456789abcdef' },
        storage: { dataDir: './data' },
      }),
    );

    let out = '';
    child = spawn(process.execPath, ['--experimental-strip-types', CLI_ENTRY, 'serve', '--config', cfgPath, '--port', String(port)], {
      cwd: root,
      env: { ...process.env, QQ_ARCHIVE_CONFIG: '', QQ_ARCHIVE_DATA_DIR: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (out += d.toString()));

    assert.ok(await waitForUrl(`http://127.0.0.1:${port}/api/health`), `serve 未在超时内启动：\n${out}`);

    const page = await fetch(`http://127.0.0.1:${port}/`);
    const body = await page.text();
    assert.equal(
      page.status,
      200,
      `GET / 应返回网页（web/ 必须被托管）；返回 ${page.status}：\n${body}\n--- serve 输出 ---\n${out}`,
    );
    assert.match(page.headers.get('content-type') ?? '', /text\/html/, `Content-Type 应为 HTML：${page.headers.get('content-type')}`);
    assert.match(body, /<html/i, `响应体应是网页 HTML：\n${body.slice(0, 200)}`);
  } finally {
    child?.kill('SIGTERM');
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * 停机必须有界。
 *
 * 真实观察到过一次：正在运行的实例收到 SIGTERM 后 20 秒仍未退出（只能 kill -9 收场）。
 * 隔离环境里我没能复现出那次挂起（idle 连接、在途媒体流、半截请求体、活跃采集轮次
 * 四种情形实测都在 1 秒内退出），所以这条用例不假装能复现根因，而是守住**结果**：
 * 无论进程里挂了多少连接，收到 SIGTERM 后都必须在宽限期（此处设为 2 秒）之后很快退出。
 * 谁将来把停机路径改成会无限等待的写法，这条就会红。
 */
test('cli 端到端：收到 SIGTERM 后必须在宽限期内退出（不能无限等连接）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qq-cli-shutdown-'));
  let child: ReturnType<typeof spawn> | null = null;
  try {
    const port = await freePort();
    const cfgPath = join(root, 'config.json');
    writeFileSync(
      cfgPath,
      JSON.stringify({
        server: { host: '127.0.0.1', port, token: 'shutdown-e2e-token-0123456789' },
        storage: { dataDir: './data' },
      }),
    );

    let out = '';
    child = spawn(process.execPath, ['--experimental-strip-types', CLI_ENTRY, 'serve', '--config', cfgPath, '--port', String(port)], {
      cwd: root,
      env: { ...process.env, QQ_ARCHIVE_CONFIG: '', QQ_ARCHIVE_DATA_DIR: '', QQ_ARCHIVE_SHUTDOWN_GRACE_MS: '2000' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (out += d.toString()));

    assert.ok(await waitForUrl(`http://127.0.0.1:${port}/api/health`), `serve 未在超时内启动：\n${out}`);

    // 故意挂一个"永远收不到完整请求体"的请求：声明大 Content-Length 但只发一半
    const http = await import('node:net');
    const held = http.createConnection({ host: '127.0.0.1', port });
    // 必须挂 error 处理：停机时服务端会强制断开连接，这条 socket 收到 ECONNRESET 是**预期行为**
    // （正是"强制断开"生效的证据）。没有这个 handler 时它会被当成未捕获异常，把测试判成失败。
    const resetSeen: string[] = [];
    held.on('error', (err: NodeJS.ErrnoException) => {
      resetSeen.push(err.code ?? err.message);
    });
    await new Promise<void>((r) => held.once('connect', () => r()));
    held.write('POST /api/import HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 100000\r\n\r\n{"partial":');

    const pid = child.pid;
    assert.ok(typeof pid === 'number' && pid > 0, '子进程应有 pid');
    const started = Date.now();
    child.kill('SIGTERM');

    const exited = await new Promise<boolean>((resolveP) => {
      // 预算给足：这条守的是"有界"（宽限期 2 秒后就该走），不是"多快"。
      // 整套用例并行跑时机器可能很忙，预算太小会把"慢"误判成"挂住"。
      const timer = setTimeout(() => resolveP(false), 20_000);
      child?.once('exit', () => {
        clearTimeout(timer);
        resolveP(true);
      });
    });
    held.destroy();

    assert.ok(
      exited,
      `SIGTERM 后 20 秒仍未退出（宽限期 2 秒 + 强制断开应远快于此）：\n${out}`,
    );
    assert.ok(Date.now() - started < 20_000, '应在宽限期后不久退出');
  } finally {
    child?.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * 背景（真实发生过的缺陷）：`loadConfig()` 在缺少 `server.token` 时会生成随机令牌，
 * 并把 `tokenGenerated` 标为 true，但**没有任何调用方消费这个标记**，也从不写回配置。
 *
 * 后果是纯功能测试看不见的三连：
 *   1. `qq-archive token` 打印的是**本次进程**的临时令牌；
 *   2. `serve` 在另一个进程里跑，它的临时令牌与上面那个不同 → 网页登录必然「令牌错误」；
 *   3. `doctor` 只检查长度，临时令牌长度必然合格 → 报「✓ 管理令牌已设置」，
 *      把一个登录不上的错误状态显示成绿灯。
 *
 * 修好后：能写回就写回（此后所有进程看到同一个令牌），写不回去就必须显式告警。
 */
test('config: 缺少 server.token 时自动写回配置，令牌跨进程可复现', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-archive-token-'));
  try {
    const cfgPath = join(dir, 'config.json');
    writeFileSync(cfgPath, JSON.stringify({ server: { host: '127.0.0.1', port: 8787, token: '' } }), { mode: 0o600 });
    chmodSync(cfgPath, 0o600);

    const first = loadConfig(cfgPath);
    assert.equal(first.tokenGenerated, false, '写回成功时不应再标记为「临时令牌」');
    assert.ok(first.config.server.token.length >= 32, '自动生成的令牌应足够长');

    const second = loadConfig(cfgPath);
    assert.equal(second.config.server.token, first.config.server.token, '两次加载必须得到同一个令牌');
    assert.equal(second.tokenGenerated, false);

    const onDisk = JSON.parse(readFileSync(cfgPath, 'utf8')) as { server: { token: string } };
    assert.equal(onDisk.server.token, first.config.server.token, '令牌必须真的落到配置文件里');
    assert.equal(statSync(cfgPath).mode & 0o777, 0o600, '写回不得放宽文件权限');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config: 写回失败时保持 tokenGenerated=true（调用方必须告警，不能静默）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-archive-token-ro-'));
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  try {
    if (uid === 0) return; // root 无视权限位，这条断言在 root 下无意义
    const cfgPath = join(dir, 'config.json');
    writeFileSync(cfgPath, JSON.stringify({ server: { host: '127.0.0.1', token: '' } }));
    chmodSync(dir, 0o500); // 目录只读：原子写回的临时文件建不出来

    const loaded = loadConfig(cfgPath);
    assert.equal(loaded.tokenGenerated, true, '写不回时必须如实标记为临时令牌');
    assert.ok(loaded.config.server.token.length >= 32, '写不回去也要给出可用令牌，不能空着');
  } finally {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config: 示例配置的占位令牌会被校验拦下，且示例文件本身的 token 必须为空', () => {
  // 把示例里的说明文字当令牌用：长度合格（旧检查会放行），但它是**公开可猜**的。
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server.token = '请替换为至少 32 位随机字符串，例如 openssl rand -base64 32 的输出';
  const problems = validateConfig(cfg);
  assert.ok(problems.some((p) => p.includes('token')), `占位令牌应被拦下: ${problems.join('|')}`);

  // 更保险的是：示例文件里根本不留占位文本，用户「复制即用」也不会得到一个公开令牌。
  const example = JSON.parse(readFileSync(join(REPO_ROOT, 'config.example.json'), 'utf8')) as { server: { token: string } };
  assert.equal(example.server.token, '', 'config.example.json 的 server.token 必须留空，由首次运行生成并写回');
});

test('cli 端到端：两次 token 输出一致，且 doctor 不再把临时令牌报成绿灯', () => {
  const root = mkdtempSync(join(tmpdir(), 'qq-cli-token-e2e-'));
  try {
    const cfgPath = join(root, 'config.json');
    // 刻意不给 server.token —— 这正是用户从 config.example.json 复制后最容易留下的状态。
    writeFileSync(cfgPath, JSON.stringify({ server: { host: '127.0.0.1', port: 8789 }, storage: { dataDir: './data' } }));

    const t1 = runCli(['token', '--config', cfgPath], root);
    assert.equal(t1.status, 0, `第一次 token 应成功并写回配置：\n${t1.stdout}\n${t1.stderr}`);
    const t2 = runCli(['token', '--config', cfgPath], root);
    assert.equal(t2.status, 0, `第二次 token 应成功：\n${t2.stdout}\n${t2.stderr}`);
    // stdout 里混有日志行，令牌是最后一行。
    const token1 = t1.stdout.trim().split('\n').at(-1)?.trim() ?? '';
    const token2 = t2.stdout.trim().split('\n').at(-1)?.trim() ?? '';
    assert.equal(
      token2,
      token1,
      '两次运行必须打印同一个令牌；不同就说明 serve 与 token 的令牌对不上，网页永远登录不上',
    );
    assert.ok(token1.length >= 32, `令牌应有足够长度：${t1.stdout}`);

    const doctor = runCli(['doctor', '--config', cfgPath], root);
    assert.equal(doctor.status, 0, `令牌已写回后 doctor 应无问题：\n${doctor.stdout}`);
    assert.match(doctor.stdout, /管理令牌已设置/, `doctor 应确认令牌已配置：\n${doctor.stdout}`);
    assert.doesNotMatch(doctor.stdout, /临时令牌/, `不应再报临时令牌：\n${doctor.stdout}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* 语音转文字（STT）：CLI transcribe                                    */
/* ------------------------------------------------------------------ */

interface TranscribeEnv {
  root: string;
  ctx: Ctx;
  db: Db;
  logger: ReturnType<typeof createLogger>;
  mediaDir: string;
}

/** 临时库 + 临时媒体目录 + 一个真实存在的 ggml 模型文件（probe 只查存在性）。 */
function makeTranscribeEnv(): TranscribeEnv {
  const root = mkdtempSync(join(tmpdir(), 'qq-cli-stt-'));
  const mediaDir = join(root, 'media');
  mkdirSync(mediaDir, { recursive: true });
  const config: AppConfig = structuredClone(DEFAULT_CONFIG);
  config.server.token = 'stt-test-token-0123456789abcdefgh';
  config.storage = {
    dataDir: root,
    dbPath: join(root, 'archive.db'),
    mediaDir,
    backupDir: join(root, 'backups'),
    logDir: join(root, 'logs'),
  };
  const model = join(root, 'ggml-model.bin');
  writeFileSync(model, 'FAKE-GGML-MODEL');
  config.stt = { ...DEFAULT_STT_CONFIG, enabled: true, model };
  const logger = createLogger({ level: 'error', console: false });
  const db = openDatabase({ path: config.storage.dbPath, logger: logger.child('stt-test') });
  const ctx: Ctx = { config, configPath: join(root, 'config.json'), db, logger, stop: [], tokenTemporary: false };
  return { root, ctx, db, logger, mediaDir };
}

function addAudio(db: Db, mediaDir: string, name: string, bytes: Buffer, duration = 5): number {
  writeFileSync(join(mediaDir, name), bytes);
  return db.upsertMedia({
    sha256: sha256Hex(bytes),
    kind: 'audio',
    size: bytes.length,
    relPath: name,
    mime: 'audio/amr',
    status: 'present',
    duration,
  }).id;
}

/** 假 exec：probe 用的 `--help` 与转码调用返回空；真正的 whisper 调用返回给定文本。 */
function fakeSttExec(text: string): { exec: ExecFn; calls: Array<{ cmd: string; args: string[] }> } {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const exec: ExecFn = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'whisper-cli' && !args.includes('--help')) return { code: 0, stdout: `${text}\n`, stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  return { exec, calls };
}

test('cli: transcribe 批量 --json 用假 exec 转写并真的写入 media_transcripts', async () => {
  const env = makeTranscribeEnv();
  try {
    const audioId = addAudio(env.db, env.mediaDir, 'a.amr', Buffer.from('AUDIO-BYTES-1'));
    const { exec, calls } = fakeSttExec('第一段语音');
    const out: string[] = [];
    const errOut: string[] = [];
    const code = await cmdTranscribe(env.ctx, { json: true }, { exec, out: (s) => out.push(s), err: (s) => errOut.push(s) });
    assert.equal(code, 0, `应成功：${errOut.join('')}`);

    const stats = JSON.parse(out.join('')) as { transcribed: number; failed: number; candidates: number };
    assert.equal(stats.transcribed, 1, `应转写 1 条：${out.join('')}`);
    assert.equal(stats.failed, 0);
    assert.equal(stats.candidates, 1);

    const row = env.db.getTranscript(audioId);
    assert.ok(row, 'media_transcripts 必须真的有一行');
    assert.equal(row.text, '第一段语音');
    assert.equal(row.engine, 'whisper-cli');
    assert.equal(row.mediaId, audioId);

    // 假 exec 确实被调用过（ffmpeg 转码 + whisper 转写），没有真的 spawn whisper/ffmpeg。
    assert.ok(calls.some((c) => c.cmd === 'ffmpeg'), '应调用 ffmpeg');
    assert.ok(calls.some((c) => c.cmd === 'whisper-cli' && !c.args.includes('--help')), '应调用 whisper-cli 转写');
  } finally {
    env.db.close();
    await env.logger.close();
    rmSync(env.root, { recursive: true, force: true });
  }
});

test('cli: transcribe --media 只转指定一条；非语音/不存在报错', async () => {
  const env = makeTranscribeEnv();
  try {
    const a = addAudio(env.db, env.mediaDir, 'a.amr', Buffer.from('AUDIO-A'));
    const b = addAudio(env.db, env.mediaDir, 'b.amr', Buffer.from('AUDIO-B'));

    const single = fakeSttExec('指定媒体');
    const out: string[] = [];
    const code = await cmdTranscribe(env.ctx, { media: String(b), json: true }, { exec: single.exec, out: (s) => out.push(s), err: () => {} });
    assert.equal(code, 0);
    const one = JSON.parse(out.join('')) as { mediaId: number };
    assert.equal(one.mediaId, b);
    assert.equal(env.db.getTranscript(b)?.text, '指定媒体');
    assert.equal(env.db.getTranscript(a), null, '--media 不应连带转写其它音频');
    assert.equal(env.db.listUntranscribedAudio(10).length, 1);

    const pic = env.db.upsertMedia({ sha256: sha256Hex(Buffer.from('PIC')), kind: 'image', size: 3, relPath: 'p.png', status: 'present' });
    const errOut: string[] = [];
    const bad = await cmdTranscribe(env.ctx, { media: String(pic.id) }, { exec: single.exec, out: () => {}, err: (s) => errOut.push(s) });
    assert.notEqual(bad, 0, '非语音媒体应非零退出');
    assert.match(errOut.join(''), /不是语音/);

    const missing = await cmdTranscribe(env.ctx, { media: '999999' }, { exec: single.exec, out: () => {}, err: (s) => errOut.push(s) });
    assert.notEqual(missing, 0, '不存在的媒体应非零退出');
    assert.match(errOut.join(''), /媒体不存在/);

    // rel_path 越界（../）：必须拒绝，绝不读媒体根以外的文件
    const outsideBytes = Buffer.from('OUTSIDE-AUDIO-BYTES');
    writeFileSync(join(env.root, 'outside.amr'), outsideBytes);
    const escapedAudio = env.db.upsertMedia({
      sha256: sha256Hex(outsideBytes),
      kind: 'audio',
      size: outsideBytes.length,
      relPath: '../outside.amr',
      mime: 'audio/amr',
      status: 'present',
    });
    const escErr: string[] = [];
    const escCode = await cmdTranscribe(env.ctx, { media: String(escapedAudio.id) }, { exec: single.exec, out: () => {}, err: (s) => escErr.push(s) });
    assert.notEqual(escCode, 0, 'rel_path 越界应非零退出');
    assert.match(escErr.join(''), /越界/);
  } finally {
    env.db.close();
    await env.logger.close();
    rmSync(env.root, { recursive: true, force: true });
  }
});

test('cli: transcribe --limit 截断批量候选，返回真实统计', async () => {
  const env = makeTranscribeEnv();
  try {
    addAudio(env.db, env.mediaDir, 'a.amr', Buffer.from('AUDIO-A'));
    addAudio(env.db, env.mediaDir, 'b.amr', Buffer.from('AUDIO-B'));
    const { exec } = fakeSttExec('批量一条');
    const out: string[] = [];
    const code = await cmdTranscribe(env.ctx, { limit: '1', json: true }, { exec, out: (s) => out.push(s), err: () => {} });
    assert.equal(code, 0);
    const stats = JSON.parse(out.join('')) as { transcribed: number; candidates: number };
    assert.equal(stats.candidates, 1, '--limit 1 后候选应为 1');
    assert.equal(stats.transcribed, 1);
    assert.equal(env.db.listUntranscribedAudio(10).length, 1, '另一条应仍未转写');
  } finally {
    env.db.close();
    await env.logger.close();
    rmSync(env.root, { recursive: true, force: true });
  }
});

test('cli 端到端：transcribe 未启用时非零退出并给出开启方法', () => {
  const root = mkdtempSync(join(tmpdir(), 'qq-cli-stt-off-'));
  try {
    const cfgPath = join(root, 'config.json');
    writeFileSync(
      cfgPath,
      JSON.stringify({ server: { host: '127.0.0.1', port: 8791, token: 'stt-off-token-0123456789abcdefgh' }, storage: { dataDir: './data' } }),
    );
    const r = runCli(['transcribe', '--config', cfgPath], root);
    assert.notEqual(r.status, 0, '未启用时必须是明确失败，而不是静默 0 条');
    assert.match(r.stderr, /未启用/);
    assert.match(r.stderr, /QQ_ARCHIVE_STT_ENABLED/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cli 端到端：transcribe 在模型缺失时原样打印原因并非零退出', () => {
  const root = mkdtempSync(join(tmpdir(), 'qq-cli-stt-nomodel-'));
  try {
    const cfgPath = join(root, 'config.json');
    writeFileSync(
      cfgPath,
      JSON.stringify({
        server: { host: '127.0.0.1', port: 8792, token: 'stt-nomodel-token-0123456789abcdef' },
        storage: { dataDir: './data' },
        stt: { enabled: true, binary: 'whisper-cli', ffmpeg: 'ffmpeg', model: join(root, 'nope-model.bin'), language: 'zh' },
      }),
    );
    const r = runCli(['transcribe', '--config', cfgPath], root);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /模型文件不存在/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
