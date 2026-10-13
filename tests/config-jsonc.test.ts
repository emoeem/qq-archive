/**
 * 配置文件的「宽容解析」测试：`//` `/* *\/` 注释与尾逗号。
 *
 * 动机是文档与实现不一致：README / DEPLOYMENT 里的示例块都是带 `//` 注释的 `jsonc`
 * （手改配置时加注释也很自然），但加载器原先只认严格 JSON —— 用户照着文档复制粘贴
 * 必然报 `Expected property name or '}'`，而且完全想不到是"注释"的问题。
 *
 * 最危险的一点是**字符串里的 `//`**：`"http://127.0.0.1:3000"` 里就有，
 * 用正则一把梭把注释放掉会顺手把 URL 改坏 —— 那比不支持注释更糟。所以这里的
 * 第一条用例就是它，后面才是注释与尾逗号本身。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripJsonComments, stripTrailingCommas, parseConfigText } from '../packages/core/src/index.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI_ENTRY = join(REPO_ROOT, 'apps', 'cli', 'src', 'main.ts');

test('配置解析：注释与尾逗号容错，但绝不动字符串里的 `//`', async (t) => {
  const cases: Array<{ name: string; input: string; expect: unknown }> = [
    { name: 'URL 里的 // 必须原样保留（最危险的一条）', input: '{"a":"http://127.0.0.1:3000/x//y"}', expect: { a: 'http://127.0.0.1:3000/x//y' } },
    { name: '行注释', input: '{\n  // 注释\n  "a": 1 // 尾注释\n}', expect: { a: 1 } },
    { name: '块注释', input: '{/* 前 */ "a" /* 中 */: 1 /* 后 */}', expect: { a: 1 } },
    { name: '字符串里的 // 与 /* */', input: '{"a":"//not-a-comment","b":"/*also*/"}', expect: { a: '//not-a-comment', b: '/*also*/' } },
    { name: '转义引号不破坏边界判断', input: '{"a":"he said \\"// x\\" ok","b":2}', expect: { a: 'he said "// x" ok', b: 2 } },
    { name: '对象尾逗号', input: '{"a":1,}', expect: { a: 1 } },
    { name: '数组尾逗号', input: '{"a":[1,2,],}', expect: { a: [1, 2] } },
    { name: '字符串里的逗号与花括号不受影响', input: '{"a":"x,}"}', expect: { a: 'x,}' } },
    { name: '示例配置里的 $comment 键照旧可用', input: '{"$comment":"说明","a":1}', expect: { $comment: '说明', a: 1 } },
    { name: '注释里出现引号也不影响（注释优先于字符串判断）', input: '{"a":1} // 他说"你好"\n', expect: { a: 1 } },
  ];

  for (const c of cases) {
    await t.test(c.name, () => {
      assert.deepEqual(parseConfigText(c.input, 'test.json'), c.expect);
    });
  }

  await t.test('纯函数本身：去注释 / 去尾逗号各司其职', () => {
    assert.equal(stripJsonComments('{"a":1} // x').trim(), '{"a":1}');
    assert.equal(stripJsonComments('"http://x"'), '"http://x"', '字符串原样返回');
    assert.equal(stripTrailingCommas('{"a":[1,2,],}'), '{"a":[1,2]}');
    assert.equal(stripTrailingCommas('"a,}"'), '"a,}"');
  });

  await t.test('真坏的 JSON 仍然报错，且错误信息里带文件路径', () => {
    assert.throws(
      () => parseConfigText('{"a": }', '/etc/qq-archive/config.json'),
      (err: unknown) => err instanceof Error && err.message.includes('/etc/qq-archive/config.json'),
    );
  });
});

test('带注释的配置能真正被 CLI 用起来，且写入令牌时注释不被抹掉', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'qq-config-jsonc-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'data'), { recursive: true });

  const configPath = join(root, 'config.json');
  // 故意写成"带注释 + 尾逗号 + 空 token"，模拟用户照着文档手改出来的文件
  writeFileSync(
    configPath,
    `{
  // 这是用户自己写的注释，跑完命令后必须还在
  "server": {
    "host": "127.0.0.1",   /* 只监听本机 */
    "port": 28977,
    "token": "",           // 留空，等程序自动生成
  },
  "storage": { "dataDir": "./data" },
  "collector": {
    "kind": "none",        // 先不采集
    "baseUrl": "http://127.0.0.1:3000",   // URL 里的 // 不能被当注释吃掉
  },
}
`,
  );

  const r = spawnSync(process.execPath, ['--experimental-strip-types', CLI_ENTRY, 'doctor', '--config', configPath], {
    encoding: 'utf8',
    env: { ...process.env, QQ_ARCHIVE_CONFIG: '', QQ_ARCHIVE_DATA_DIR: '' },
    timeout: 120_000,
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  assert.equal(r.status, 0, `doctor 应成功（说明带注释的配置被正确解析）\n${out}`);
  assert.match(out, /管理令牌已设置/, '空令牌应被自动生成并写回');

  const after = readFileSync(configPath, 'utf8');
  assert.match(after, /这是用户自己写的注释/, '写回令牌不能把用户的注释抹掉');
  assert.match(after, /http:\/\/127\.0\.0\.1:3000/, 'URL 必须完好');
  const cfg = parseConfigText(after, configPath) as {
    server: { token: string; host: string; port: number };
    collector: { baseUrl: string };
  };
  assert.ok(cfg.server.token.length >= 16, `令牌应已写入，实际长度 ${cfg.server.token.length}`);
  assert.equal(cfg.collector.baseUrl, 'http://127.0.0.1:3000');
  assert.ok(
    cfg.server.host === '127.0.0.1' && cfg.server.port === 28977,
    '其余字段不能被写回过程改动',
  );
});
