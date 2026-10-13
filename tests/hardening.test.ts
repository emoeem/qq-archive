/**
 * 回归测试：README「快速开始」自检中发现的、只有真的跑起来才看得见的缺陷。
 *
 * 这三个缺陷的共同点是**静态检查全绿**：
 *  - systemd `StartLimit*` 写在 `[Service]` 里，`systemd-analyze verify` 只给 warning；
 *  - `generate.ts --help` 把选项当成输出目录，创建出一个名为 `--help` 的目录；
 *  - 缩略图链路（见 tests/media.test.ts 的 archive() 用例）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 极简 INI 解析：只要「段 → 出现的键」就够断言 systemd 的段落归属。 */
function parseIni(text: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  let section = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      section = line.slice(1, -1);
      out[section] ??= [];
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const keys = (out[section] ??= []);
    keys.push(line.slice(0, eq).trim());
  }
  return out;
}

test('systemd unit：StartLimit* 必须写在 [Unit] 段（写进 [Service] 会被静默忽略）', () => {
  for (const name of ['qq-archive.service', 'qq-archive-collect.service']) {
    const ini = parseIni(readFileSync(join(REPO_ROOT, 'deploy', name), 'utf8'));
    const unit = ini['Unit'] ?? [];
    const service = ini['Service'] ?? [];
    for (const key of ['StartLimitIntervalSec', 'StartLimitBurst']) {
      assert.ok(unit.includes(key), `deploy/${name} 的 [Unit] 缺少 ${key}`);
      // 真正的回归点：这两个键曾经写在 [Service] 里，systemd 只记 warning，
      // 于是「崩溃 5 次就停下」的保护实际上完全不存在。
      assert.ok(!service.includes(key), `deploy/${name} 的 ${key} 不能出现在 [Service] 段`);
    }
  }
});

test('generate.ts --help：不得把选项当成输出目录（曾经创建 ./--help/）', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'qq-gen-args-'));
  const script = join(REPO_ROOT, 'tests', 'fixtures', 'generate.ts');
  const run = (...args: string[]): ReturnType<typeof spawnSync> =>
    spawnSync(process.execPath, ['--experimental-strip-types', script, ...args], {
      cwd,
      encoding: 'utf8',
    });
  try {
    const help = run('--help');
    assert.equal(help.status, 0, `--help 必须以 0 退出：${String(help.stderr)}`);
    assert.match(String(help.stdout), /用法/);
    assert.equal(existsSync(join(cwd, '--help')), false, '--help 不能创建名为 --help 的目录');

    const bogus = run('--bogus-dir');
    assert.equal(bogus.status, 2, '未知选项必须以 2 退出，而不是当成路径');
    assert.equal(existsSync(join(cwd, '--bogus-dir')), false, '未知选项不能创建目录');

    assert.deepEqual(readdirSync(cwd), [], '这两种调用都不该留下任何文件');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
