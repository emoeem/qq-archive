import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeQr } from '../packages/qr/src/index.ts';
import { FAKE_NAPCAT_QR_URL, FAKE_NAPCAT_TOKEN, startFakeNapCat } from './fixtures/napcat.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI_ENTRY = join(REPO_ROOT, 'apps', 'cli', 'src', 'main.ts');
const TOKEN = FAKE_NAPCAT_TOKEN;
const QR_URL = FAKE_NAPCAT_QR_URL;

interface CliRun {
  status: number | null;
  out: string;
}

/**
 * 用 `spawn` 而不是 `spawnSync`：假 NapCat 就跑在本测试进程里，
 * 而 `spawnSync` 会**阻塞父进程的事件循环** —— 子进程发出的登录请求将永远等不到响应，
 * 只能以 2s 超时收场（这正是第一版真踩到的坑）。必须让出事件循环。
 */
function runCli(args: string[]): Promise<CliRun> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', CLI_ENTRY, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, QQ_ARCHIVE_CONFIG: '', QQ_ARCHIVE_DATA_DIR: '' },
      timeout: 120_000,
    });
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (out += c.toString('utf8')));
    child.on('close', (status) => done({ status, out }));
  });
}

interface Harness {
  dir: string;
  configPath: string;
  /** 写一份指向假服务端（或缺省）的配置。 */
  writeConfig: (napcat: { webuiUrl: string; token: string; probeRange?: number } | null) => void;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'qq-napcat-login-'));
  const configPath = join(dir, 'config.json');
  const emptyConfig = {
    dataDir: join(dir, 'data'),
    mediaDir: join(dir, 'media'),
    dbFile: join(dir, 'data', 'archive.db'),
    logFile: join(dir, 'data', 'archive.log'),
    token: '',
  };
  const writeConfig: Harness['writeConfig'] = (napcat) => {
    const base = JSON.parse(JSON.stringify(emptyConfig)) as Record<string, unknown>;
    if (napcat !== null) {
      const collector: Record<string, unknown> = { kind: 'none' };
      if (napcat.token !== '') collector['napcat'] = napcat;
      base['collector'] = collector;
    }
    writeFileSync(configPath, JSON.stringify(base, null, 2), 'utf8');
  };
  return { dir, configPath, writeConfig, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * 把终端里的彩色二维码还原成模块矩阵。
 *
 * CLI 用 48;2;0;0;0 / 48;2;255;255;255 背景色 + 每模块两个空格渲染，
 * 颜色转义序列只在颜色**变化**处出现，所以「读两个空格 → 再看下一个转义」即可无损还原。
 * 这条路径本身也验证了终端渲染是**真二维码**（可被矩阵级比对/zbar 解码），而不是「看起来像」。
 */
function parseTerminalQr(text: string): number[][] {
  const esc = /\x1b\[48;2;(\d+);(\d+);(\d+)m/y;
  const rows: number[][] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.endsWith('\x1b[0m') ? rawLine.slice(0, -'\x1b[0m'.length) : rawLine;
    if (!line.includes('\x1b[48;2;')) continue;
    const row: number[] = [];
    let pos = 0;
    let dark: boolean | null = null;
    while (pos < line.length) {
      if (line[pos] === '\x1b') {
        esc.lastIndex = pos;
        const m = esc.exec(line);
        assert.ok(m !== null, `无法解析的转义序列: ${JSON.stringify(line.slice(pos, pos + 12))}`);
        dark = Number(m[1]) < 128;
        pos = esc.lastIndex;
        continue;
      }
      assert.equal(line.slice(pos, pos + 2), '  ', '每个模块必须恰好是两个空格');
      assert.ok(dark !== null, '模块出现在任何颜色之前');
      row.push(dark ? 1 : 0);
      pos += 2;
    }
    if (row.length > 0) rows.push(row);
  }
  return rows;
}

test('login 端到端：未配置 NapCat 时退出 2，并说清是哪个 token 没配', async () => {
  const h = makeHarness();
  try {
    h.writeConfig(null);
    const r = await runCli(['login', '--config', h.configPath]);
    assert.equal(r.status, 2, `应退出 2：\n${r.out}`);
    assert.match(r.out, /collector\.napcat/, '必须点名配置路径');
    assert.match(r.out, /OneBot/, '必须说明这与采集用的 OneBot token 是两回事');
  } finally {
    h.cleanup();
  }
});

test('login 端到端：token 写错时退出 3，不静默失败', async () => {
  const h = makeHarness();
  const fake = await startFakeNapCat({ token: 'another-token' });
  try {
    h.writeConfig({ webuiUrl: `http://127.0.0.1:${fake.port}`, token: TOKEN, probeRange: 0 });
    const r = await runCli(['login', '--config', h.configPath, '--no-wait']);
    assert.equal(r.status, 3, `应退出 3：\n${r.out}`);
    assert.match(r.out, /认证失败|token 校验失败/);
  } finally {
    await fake.close();
    h.cleanup();
  }
});

test('login 端到端：正常扫码，终端二维码逐模块等于编码器输出，且凭据失效后只重认证一次', async () => {
  const h = makeHarness();
  const fake = await startFakeNapCat({ unauthorizedOnce: true });
  try {
    h.writeConfig({ webuiUrl: `http://127.0.0.1:${fake.port}`, token: TOKEN, probeRange: 0 });
    const r = await runCli(['login', '--config', h.configPath, '--no-wait']);
    assert.equal(r.status, 0, `应退出 0：\n${r.out}`);
    assert.match(r.out, /已连接 NapCat WebUI/);
    assert.match(r.out, /扫一扫|扫描下面的二维码/);

    // 终端二维码必须是编码器对同一个 URL 的输出，逐模块一致。
    const expected = encodeQr(QR_URL, { ecc: 'M' });
    const matrix = parseTerminalQr(r.out);
    const quiet = 2; // CLI 用 margin=2
    assert.equal(matrix.length, expected.size + quiet * 2, '终端总行数应为模块数 + 上下静区');
    for (const row of matrix) assert.equal(row.length, expected.size + quiet * 2, '终端总列数应为模块数 + 左右静区');
    for (let y = 0; y < expected.size; y++) {
      for (let x = 0; x < expected.size; x++) {
        assert.equal(
          matrix[y + quiet]?.[x + quiet],
          expected.modules[y * expected.size + x],
          `模块 (${x},${y}) 与编码器输出不一致`,
        );
      }
    }

    // 重认证轨迹：旧凭据用一次即作废，新凭据被复用，登录接口恰好两次。
    const authed = fake.trace.filter((t) => t.auth.startsWith('Bearer '));
    assert.equal(fake.trace.filter((t) => t.path === '/api/auth/login').length, 2, '应恰好重新登录一次');
    assert.equal(authed.filter((t) => t.auth === 'Bearer cred-1').length, 1, '旧凭据只应用一次');
    assert.equal(authed.filter((t) => t.auth === 'Bearer cred-2').length, 2, '新凭据应用于重试与取码');
    assert.equal(authed.filter((t) => t.auth === 'Bearer cred-stale').length, 0, '作废凭据不得再被使用');
    assert.equal(fake.trace.filter((t) => t.path === '/api/QQLogin/GetQQLoginQrcode').length, 1);
    // 首条请求带的是 hash（客户端自己算的 sha256(token+'.napcat')），服务端认可 → 无「token 校验失败」。
    assert.equal(fake.trace.filter((t) => t.path === '/api/auth/login')[0]?.body['hash'],
      createHash('sha256').update(`${TOKEN}.napcat`, 'utf8').digest('hex'));
  } finally {
    await fake.close();
    h.cleanup();
  }
});

test('login 端到端：--list 只读账号列表，不触发登录动作', async () => {
  const h = makeHarness();
  const fake = await startFakeNapCat();
  try {
    h.writeConfig({ webuiUrl: `http://127.0.0.1:${fake.port}`, token: TOKEN, probeRange: 0 });
    const r = await runCli(['login', '--config', h.configPath, '--list']);
    assert.equal(r.status, 0, `应退出 0：\n${r.out}`);
    assert.match(r.out, /10001[\s\S]*测试账号甲/);
    assert.match(r.out, /10002[\s\S]*当前不可用/, 'isQuickLogin=false 的账号必须标注，不能混为一谈');
    assert.equal(fake.trace.filter((t) => t.path === '/api/QQLogin/SetQuickLogin').length, 0);
  } finally {
    await fake.close();
    h.cleanup();
  }
});

test('login 端到端：--uin 快捷登录并等到上线，不打印二维码', async () => {
  const h = makeHarness();
  const fake = await startFakeNapCat({ loginAfter: 1 });
  try {
    h.writeConfig({ webuiUrl: `http://127.0.0.1:${fake.port}`, token: TOKEN, probeRange: 0 });
    const r = await runCli(['login', '--config', h.configPath, '--uin', '10001', '--timeout', '20']);
    assert.equal(r.status, 0, `应退出 0：\n${r.out}`);
    assert.match(r.out, /已触发账号 10001 的快捷登录/);
    assert.match(r.out, /登录成功：10001/);
    assert.doesNotMatch(r.out, /\x1b\[48;2;/, '快捷登录路径不应渲染二维码');
    const setQuick = fake.trace.filter((t) => t.path === '/api/QQLogin/SetQuickLogin');
    assert.equal(setQuick.length, 1);
    assert.equal(setQuick[0]?.body['uin'], 10001, '全数字 uin 应以数字上送');
  } finally {
    await fake.close();
    h.cleanup();
  }
});

test('login 端到端：uin 非法时退出 2', async () => {
  const h = makeHarness();
  const fake = await startFakeNapCat();
  try {
    h.writeConfig({ webuiUrl: `http://127.0.0.1:${fake.port}`, token: TOKEN, probeRange: 0 });
    const r = await runCli(['login', '--config', h.configPath, '--uin', '12']);
    assert.equal(r.status, 2, `应退出 2：\n${r.out}`);
    assert.match(r.out, /uin 非法/);
  } finally {
    await fake.close();
    h.cleanup();
  }
});

test('login 端到端：已登录时直接报告，既不取码也不等待', async () => {
  const h = makeHarness();
  const fake = await startFakeNapCat({ alreadyLoggedIn: true });
  try {
    h.writeConfig({ webuiUrl: `http://127.0.0.1:${fake.port}`, token: TOKEN, probeRange: 0 });
    const r = await runCli(['login', '--config', h.configPath]);
    assert.equal(r.status, 0, `应退出 0：\n${r.out}`);
    assert.match(r.out, /QQ 已登录：10001/);
    assert.doesNotMatch(r.out, /\x1b\[48;2;/);
    assert.equal(fake.trace.filter((t) => t.path === '/api/QQLogin/GetQQLoginQrcode').length, 0);
  } finally {
    await fake.close();
    h.cleanup();
  }
});
