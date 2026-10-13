/**
 * 采集端编排命令（`qq-archive collector`）的测试。
 *
 * 这里只测**不需要容器运行时**的部分：token 读取、参数校验、命令注册与帮助文本。
 * 真正起容器的那条路径需要 podman/docker，不能放进单元测试（会改环境）；
 * 它由 `deploy/` 文档里的手工步骤 + 一次实机演练覆盖（见 docs/INDEPENDENT-VERIFICATION.md）。
 *
 * 背景：采集端（NapCat）不是本项目的一部分 —— 它容器里跑的是官方 QQ 客户端本体 + 虚拟显示器 +
 * 注入加载器（1.5 GB 镜像）。本项目只通过 loopback 的 OneBot HTTP 接口与它互操作，
 * 但"装它、配它、把两个 token 对上"这些手工活可以自动化，就是这个命令干的。
 * 最容易出错的一步是**两个 token 分属不同文件**，所以这里的重点是 token 读取的准确性。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readNapcatTokens } from '../apps/cli/src/main.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI_ENTRY = join(REPO_ROOT, 'apps', 'cli', 'src', 'main.ts');

function runCli(args: string[], env: Record<string, string> = {}): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', CLI_ENTRY, ...args], {
    encoding: 'utf8',
    env: { ...process.env, QQ_ARCHIVE_CONFIG: '', QQ_ARCHIVE_DATA_DIR: '', ...env },
    timeout: 120_000,
  });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

test('collector：从 NapCat 挂载目录读取两个 token（它们在不同文件里）', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'qq-collector-tokens-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cfgDir = join(root, 'config');
  mkdirSync(cfgDir, { recursive: true });

  await t.test('OneBot token 来自 onebot11_<QQ号>.json 的 httpServers，WebUI token 来自 webui.json', async () => {
    writeFileSync(
      join(cfgDir, 'onebot11_10001.json'),
      JSON.stringify({
        network: {
          httpServers: [
            { name: 'disabled-one', enable: false, token: 'SHOULD-NOT-BE-USED' },
            { name: 'qq-archive', enable: true, port: 3000, token: 'ONEBOT-TOKEN-40-CHARS-abcdefghijklmnop' },
          ],
        },
      }),
    );
    writeFileSync(join(cfgDir, 'webui.json'), JSON.stringify({ token: 'WEBUI-TOKEN-32-CHARS-abcdefghijkl' }));

    const got = await readNapcatTokens(root);
    assert.equal(got.onebotToken, 'ONEBOT-TOKEN-40-CHARS-abcdefghijklmnop', '应取启用中的那个 httpServer');
    assert.equal(got.onebotTokenFrom, 'onebot11_10001.json');
    assert.equal(got.webuiToken, 'WEBUI-TOKEN-32-CHARS-abcdefghijkl');
  });

  await t.test('没有登录过的全新容器：读不到 token 但不报错', async () => {
    const empty = join(root, 'empty');
    mkdirSync(join(empty, 'config'), { recursive: true });
    const got = await readNapcatTokens(empty);
    assert.equal(got.onebotToken, null);
    assert.equal(got.webuiToken, null);
  });

  await t.test('配置损坏/字段缺失时安静降级，绝不抛错', async () => {
    const broken = join(root, 'broken');
    mkdirSync(join(broken, 'config'), { recursive: true });
    writeFileSync(join(broken, 'config', 'onebot11_1.json'), '{ 这不是 JSON');
    writeFileSync(join(broken, 'config', 'webui.json'), JSON.stringify({ token: 123 }));
    const got = await readNapcatTokens(broken);
    assert.equal(got.onebotToken, null);
    assert.equal(got.webuiToken, null, '非字符串 token 不应被当成可用值');
  });
});

test('collector：命令已注册、帮助可读、参数校验到位', async (t) => {
  await t.test('命令在白名单里（否则会退化成打印整篇用法）', () => {
    const r = runCli(['collector', 'status']);
    assert.doesNotMatch(r.out, /未知命令/, `collector 未被注册：\n${r.out}`);
    assert.doesNotMatch(r.out, /用法: qq-archive <命令>/, '不应打印整篇用法');
  });

  await t.test('帮助里有这一节与关键选项', () => {
    const r = runCli(['help']);
    assert.match(r.out, /collector <setup\|status>/, '帮助应包含 collector 命令');
    assert.match(r.out, /--write-config/, '帮助应说明自动写配置的开关');
    assert.match(r.out, /--onebot-port/, '帮助应说明端口选项');
  });

  await t.test('非法参数被明确拒绝（不静默使用默认值）', () => {
    const bad = runCli(['collector', 'setup', '--onebot-port', 'not-a-number']);
    assert.equal(bad.status, 2, `端口非法应退出码 2，实际 ${bad.status}\n${bad.out}`);
    assert.match(bad.out, /--onebot-port 非法/);

    const same = runCli(['collector', 'setup', '--onebot-port', '3000', '--webui-port', '3000']);
    assert.equal(same.status, 2);
    assert.match(same.out, /不能相同/);

    const badAction = runCli(['collector', 'rm-rf']);
    assert.equal(badAction.status, 2);
    assert.match(badAction.out, /setup\|status/);
  });

  await t.test('没有容器运行时给出可执行的安装指引，而不是崩掉', () => {
    // 用一个把 PATH 掏空的子进程模拟"没装 podman/docker"
    const r = spawnSync(process.execPath, ['--experimental-strip-types', CLI_ENTRY, 'collector', 'status'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: '/nonexistent', QQ_ARCHIVE_CONFIG: '', QQ_ARCHIVE_DATA_DIR: '' },
      timeout: 60_000,
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    assert.equal(r.status, 2, `应明确失败，实际 ${r.status}\n${out}`);
    assert.match(out, /podman|docker/, '应提到 podman/docker');
    assert.match(out, /pacman|apt|podman\.io/, '应给出安装办法');
    assert.doesNotMatch(out, /ReferenceError|TypeError/, '不应是未捕获异常');
  });
});

test('配置路径：空字符串环境变量按"未设置"处理，不能拿它去 resolve 出当前目录', () => {
  // 真实缺陷：`QQ_ARCHIVE_CONFIG= qq-archive stats`（shell 里清空环境变量的常见写法）
  // 曾经会 resolve('') → 当前目录 → readFileSync(目录) → EISDIR，
  // 报错信息与真实原因（"配置用哪个文件"）完全无关，非常难查。
  const workdir = mkdtempSync(join(tmpdir(), 'qq-empty-cfg-'));
  try {
    writeFileSync(join(workdir, 'config.json'), JSON.stringify({ server: { token: 'x'.repeat(24), port: 18899 } }));
    const r = spawnSync(process.execPath, ['--experimental-strip-types', CLI_ENTRY, 'token'], {
      cwd: workdir,
      encoding: 'utf8',
      env: { ...process.env, QQ_ARCHIVE_CONFIG: '', QQ_ARCHIVE_DATA_DIR: '' },
      timeout: 60_000,
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    assert.equal(r.status, 0, `空 QQ_ARCHIVE_CONFIG 应回落到 ./config.json，实际 ${r.status}\n${out}`);
    assert.doesNotMatch(out, /EISDIR/, '不应出现 EISDIR');
    assert.match(out, /x{24}/, '应打印出 cwd 下 config.json 里的令牌');
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test('collector：文档与实现一致（帮助文本里的默认值与代码常量一致）', () => {
  const src = readFileSync(CLI_ENTRY, 'utf8');
  const m = /const COLLECTOR_DEFAULTS = \{([\s\S]*?)\};/.exec(src);
  assert.ok(m, '应能找到 COLLECTOR_DEFAULTS');
  const block = m[1] ?? '';
  assert.match(block, /name: 'napcat-qq'/, '默认容器名');
  assert.match(block, /onebotPort: 3000/, '默认 OneBot 端口');
  assert.match(block, /webuiPort: 6099/, '默认 WebUI 端口');

  // 帮助文本里承诺的默认值与代码一致（避免文档与实现漂移）
  const help = runCli(['help']).out;
  assert.match(help, /默认 napcat-qq/);
  assert.match(help, /默认 3000/);
  assert.match(help, /默认 6099/);
});
