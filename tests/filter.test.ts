/**
 * 采集过滤测试。
 *
 * 这个功能**最危险的失败方向是"少存了数据"** —— 本系统的目标是防丢失，过滤只该让人
 * "少看点"，不该变成"少存点"。所以这里的用例重点不在"规则能不能命中"，
 * 而在**命中之后数据还在不在**：
 *   1. 默认（drop=false）命中即入库，只带 `filtered` 标记 → 库里查得到、导出带得走；
 *   2. 查询默认隐藏、`includeFiltered` 时能拿回来；
 *   3. 只有显式 `drop=true` 才真的跳过存储，且计数如实反映；
 *   4. 规则本身（关键词子串 / 发送者三种标识 / 消息类型）与大小写、空值边界。
 *
 * 外加一条"不启用时行为与加功能之前完全一致"的回归 —— 老配置升级上来不能改变任何行为。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import type { AddressInfo } from 'node:net';
import {
  createLogger,
  DEFAULT_CONFIG,
  filtersConfigOf,
  validateConfig,
  type AppConfig,
  type FiltersConfig,
  type NormalizedMessage,
  type NormalizedSession,
} from '../packages/core/src/index.ts';
import { messageKeyOf, sessionKeyOf } from '../packages/core/src/index.ts';
import { openDatabase, type Db } from '../packages/db/src/index.ts';
import { matchMessageFilter, matchMessageFilters, describeFilters } from '../packages/collect/src/filter.ts';
import { createServer } from '../packages/server/src/index.ts';

const BASE_TS = 1_700_000_000_000;
const CLI_ENTRY = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'apps', 'cli', 'src', 'main.ts');

function filters(over: Partial<FiltersConfig> = {}): FiltersConfig {
  return { ...filtersConfigOf(DEFAULT_CONFIG), enabled: true, ...over };
}

function msg(text: string, i: number, over: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    msgKey: messageKeyOf({ msgId: `m${i}`, ts: BASE_TS + i * 1000, text }),
    msgId: `m${i}`,
    ts: BASE_TS + i * 1000,
    direction: 'in',
    msgType: 'text',
    senderUin: '10001',
    senderUid: 'u:10001',
    senderName: '张三',
    text,
    ...over,
  };
}

/* ------------------------------------------------------------------ */
/* 1. 纯函数匹配                                                        */
/* ------------------------------------------------------------------ */

test('过滤匹配：关键词 / 发送者 / 类型三条规则，以及"不启用就什么都不做"', () => {
  const base = { msgType: 'text', text: '这是一条普通消息', senderUin: '10001', senderUid: 'u:10001', senderName: '张三' };

  // 未启用：无论文本多像，一律不命中
  assert.equal(matchMessageFilter({ ...base, text: '广告：加群 12345' }, filters({ enabled: false, excludeKeywords: ['广告'] })).filtered, false);

  // 关键词：子串命中，大小写不敏感
  const kw = filters({ excludeKeywords: ['广告'] });
  assert.equal(matchMessageFilter({ ...base, text: '前面有广告后面有字' }, kw).filtered, true, '子串命中即可');
  assert.match(matchMessageFilter({ ...base, text: '广告' }, kw).reason ?? '', /广告/, '理由里要写清命中了哪条');
  assert.equal(matchMessageFilter({ ...base, text: '这是推荐内容' }, kw).filtered, false);
  const kwEn = filters({ excludeKeywords: ['Spam'] });
  assert.equal(matchMessageFilter({ ...base, text: 'this is SPAM here' }, kwEn).filtered, true, '英文大小写不敏感');
  assert.equal(matchMessageFilter({ ...base, text: '' }, kw).filtered, false, '空文本不该命中');

  // 发送者：QQ 号 / uid / 昵称 任一相等都算命中
  const byUin = filters({ excludeSenders: ['10001'] });
  const byUid = filters({ excludeSenders: ['u:10001'] });
  const byName = filters({ excludeSenders: ['张三'] });
  assert.equal(matchMessageFilter(base, byUin).filtered, true);
  assert.equal(matchMessageFilter(base, byUid).filtered, true);
  assert.equal(matchMessageFilter(base, byName).filtered, true);
  assert.equal(matchMessageFilter(base, filters({ excludeSenders: ['10002'] })).filtered, false);
  assert.equal(matchMessageFilter(base, filters({ excludeSenders: ['张'] })).filtered, false, '发送者是精确相等，不是子串');

  // 类型：精确相等
  assert.equal(matchMessageFilter({ ...base, msgType: 'system' }, filters({ excludeTypes: ['system'] })).filtered, true);
  assert.equal(matchMessageFilter({ ...base, msgType: 'system' }, filters({ excludeTypes: ['json'] })).filtered, false);

  // 批量：只回命中项
  const batch = matchMessageFilters(
    [
      { ...base, msgKey: 'a', text: '买茶叶找我' },
      { ...base, msgKey: 'b', text: '晚上吃啥' },
    ],
    filters({ excludeKeywords: ['买茶'] }),
  );
  assert.equal(batch.size, 1);
  assert.ok(batch.has('a'));

  // 未启用时批量结果为空（调用方无需另行判断）
  assert.equal(matchMessageFilters([{ ...base, msgKey: 'a', text: '买茶叶' }], filters({ enabled: false, excludeKeywords: ['买茶'] })).size, 0);

  // 摘要描述可读（doctor / 启动日志用）
  assert.match(describeFilters(filters({ excludeKeywords: ['a'], excludeSenders: ['b'] })), /关键词 ×1、发送者 ×1/);
  assert.match(describeFilters(filters({ enabled: false })), /未启用/);
  assert.match(describeFilters(filters({ excludeTypes: ['system'], drop: true })), /跳过存储/);
});

/* ------------------------------------------------------------------ */
/* 2. 入库语义：默认只标记，数据必须还在                                 */
/* ------------------------------------------------------------------ */

function seed(db: Db, extra: NormalizedMessage[]): NormalizedSession {
  const session: NormalizedSession = { accountUid: 'default', chatType: 'group', peerUid: 'g:1', name: '过滤测试群' };
  const rec = db.ensureSession(session);
  const key = sessionKeyOf(session.chatType, session.peerUid);
  db.insertMessages(rec.id, session.accountUid, key, [msg('正常消息一', 1), msg('正常消息二', 2), ...extra], { source: 'test' });
  return session;
}

test('入库语义：默认（drop=false）命中的消息照样入库，只是带 filtered 标记', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'qq-filter-keep-'));
  const db = openDatabase({ path: join(root, 'a.db') });
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  const session = seed(db, [
    msg('这是买茶叶广告', 3, { filtered: true, filterReason: '关键词命中「买茶」' }),
    msg('普通聊天', 4),
  ]);
  const all = db.listMessages({ sessionId: db.getSessionByKey('default', sessionKeyOf('group', 'g:1'))!.id, limit: 100, includeFiltered: true });
  assert.equal(all.items.length, 4, '四条消息一条都不能少 —— 这是本功能最重要的性质');

  const filtered = all.items.filter((m) => m.filtered);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]!.text, '这是买茶叶广告', '被过滤的消息正文必须原样保留');
  assert.match(filtered[0]!.filterReason ?? '', /买茶/);

  const stats = db.stats();
  assert.equal(stats.messages, 4, '统计总数包含被过滤的消息（它们确实在库里）');
  assert.equal(stats.messagesFiltered, 1);
});

test('查询语义：默认隐藏被过滤的消息，includeFiltered 时能完整拿回来', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'qq-filter-query-'));
  const db = openDatabase({ path: join(root, 'a.db') });
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  const session = seed(db, [msg('被过滤的广告', 3, { filtered: true, filterReason: '关键词' })]);
  const sid = db.getSessionByKey('default', sessionKeyOf('group', 'g:1'))!.id;

  const visible = db.listMessages({ sessionId: sid, limit: 100 });
  assert.equal(visible.items.length, 2, '默认只看到未过滤的两条');
  assert.ok(visible.items.every((m) => !m.filtered));

  const withFiltered = db.listMessages({ sessionId: sid, limit: 100, includeFiltered: true });
  assert.equal(withFiltered.items.length, 3);
  assert.equal(withFiltered.items.filter((m) => m.filtered).length, 1);

  // 搜索同样：默认搜不到，includeFiltered 才搜得到
  const hidden = db.searchMessages({ keyword: '广告', pageSize: 50 });
  assert.equal(hidden.total, 0, '默认不该把被过滤的消息搜出来');
  const shown = db.searchMessages({ keyword: '广告', pageSize: 50, includeFiltered: true });
  assert.equal(shown.total, 1);
  assert.equal(shown.items[0]!.message.filtered, true);
});

test('不启用过滤时：行为与加这个功能之前完全一致（老配置升级回归）', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'qq-filter-off-'));
  const db = openDatabase({ path: join(root, 'a.db') });
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  seed(db, [msg('第三条', 3), msg('第四条', 4)]);
  const sid = db.getSessionByKey('default', sessionKeyOf('group', 'g:1'))!.id;
  assert.equal(db.listMessages({ sessionId: sid, limit: 100 }).items.length, 4, '没有任何消息被隐藏');
  assert.equal(db.stats().messagesFiltered, 0);
  assert.equal(filtersConfigOf(DEFAULT_CONFIG).enabled, false, '默认必须是关的');
  assert.equal(filtersConfigOf({ ...DEFAULT_CONFIG, filters: undefined }).enabled, false, '缺配置段时也是关的');
});

test('配置校验：开了过滤却一条规则都没配，必须被指出来', () => {
  const bad: AppConfig = { ...DEFAULT_CONFIG, filters: { enabled: true } };
  assert.ok(
    validateConfig(bad).some((p) => p.includes('filters.enabled')),
    '空规则列表开着过滤是配置错误（什么都不会过滤，但用户以为会）',
  );
  const good: AppConfig = { ...DEFAULT_CONFIG, filters: { enabled: true, excludeKeywords: ['广告'] } };
  assert.ok(!validateConfig(good).some((p) => p.includes('filters.enabled')));
  // 未启用时不校验规则内容
  assert.ok(!validateConfig({ ...DEFAULT_CONFIG, filters: { enabled: false } }).some((p) => p.includes('filters.enabled')));
});

/* ------------------------------------------------------------------ */
/* 4. refilter：改了规则之后重算已有消息的标记                            */
/* ------------------------------------------------------------------ */

test('refilter：真实子进程重算已有消息的标记（幂等、可逆、可清空，且绝不删消息）', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'qq-refilter-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'data'), { recursive: true });

  const configPath = join(root, 'config.json');
  const writeConfig = (f: Partial<FiltersConfig>): void => {
    writeFileSync(
      configPath,
      JSON.stringify({
        ...DEFAULT_CONFIG,
        server: { ...DEFAULT_CONFIG.server, token: 'refilter-token-0123456789' },
        storage: { ...DEFAULT_CONFIG.storage, dataDir: join(root, 'data') },
        collector: { ...DEFAULT_CONFIG.collector, kind: 'none' },
        filters: { enabled: true, excludeKeywords: [], excludeSenders: [], excludeTypes: [], drop: false, ...f },
      }),
    );
  };
  const run = (args: string[]) => {
    const r = spawnSync(process.execPath, ['--experimental-strip-types', CLI_ENTRY, ...args], {
      encoding: 'utf8',
      env: { ...process.env, QQ_ARCHIVE_CONFIG: '', QQ_ARCHIVE_DATA_DIR: '' },
      timeout: 120_000,
    });
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };

  // 造数据：先不带规则导入，确保消息是在"没有过滤"的情况下进库的
  writeConfig({ enabled: false });
  const dbPath = join(root, 'data', 'archive.db');
  const db = openDatabase({ path: dbPath });
  const session: NormalizedSession = { accountUid: 'default', chatType: 'group', peerUid: 'g:9', name: '重算测试群' };
  const rec = db.ensureSession(session);
  const key = sessionKeyOf(session.chatType, session.peerUid);
  db.insertMessages(rec.id, 'default', key, [
    msg('普通消息', 1),
    msg('这是买茶叶的广告', 2),
    msg('另一条普通消息', 3),
  ], { source: 'test' });
  db.close();

  const readFlags = (): { total: number; filtered: string[] } => {
    const d = new DatabaseSync(dbPath);
    try {
      const total = (d.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }).c;
      const rows = d.prepare('SELECT text FROM messages WHERE filtered = 1').all() as Array<{ text: string }>;
      return { total, filtered: rows.map((r) => r.text) };
    } finally {
      d.close();
    }
  };

  assert.deepEqual(readFlags(), { total: 3, filtered: [] }, '前置条件：库里 3 条，都没有标记');

  await t.test('命令被真正识别（不在命令白名单里就会退化成打印用法）', () => {
    writeConfig({ excludeKeywords: ['买茶'] });
    const r = run(['refilter', '--config', configPath]);
    assert.equal(r.status, 0, `refilter 应成功执行，实际退出码 ${r.status}\n${r.out}`);
    assert.doesNotMatch(r.out, /用法: qq-archive/, '不应该打印整篇用法 —— 那是"未知命令"的表现');
    assert.match(r.out, /扫描完成/);
  });

  await t.test('把已有消息按新规则标上，且一条都没删', () => {
    const st = readFlags();
    assert.equal(st.total, 3, '消息数量不能变（过滤只改标记）');
    assert.deepEqual(st.filtered, ['这是买茶叶的广告']);
  });

  await t.test('再跑一次是幂等的（0 改动）', () => {
    const r = run(['refilter', '--config', configPath]);
    assert.equal(r.status, 0);
    assert.match(r.out, /新标记 0 条｜取消标记 0 条/);
    assert.deepEqual(readFlags().filtered, ['这是买茶叶的广告']);
  });

  await t.test('换规则：旧标记取消、新命中的标上（可逆）', () => {
    writeConfig({ excludeKeywords: ['普通消息'] });
    const r = run(['refilter', '--config', configPath]);
    assert.equal(r.status, 0);
    assert.match(r.out, /新标记 2 条｜取消标记 1 条/);
    assert.deepEqual(readFlags().filtered.sort(), ['另一条普通消息', '普通消息'].sort());
  });

  await t.test('关掉过滤再重算 = 清空所有标记（消息仍在）', () => {
    writeConfig({ enabled: false });
    const r = run(['refilter', '--config', configPath]);
    assert.equal(r.status, 0);
    assert.match(r.out, /清空所有/, '应明确告知会清空标记');
    const st = readFlags();
    assert.equal(st.total, 3, '清空标记不能连消息一起删');
    assert.deepEqual(st.filtered, []);
  });
});


test('HTTP：时间线与搜索默认隐藏过滤消息，includeFiltered=1 时返回；导出**始终**带上', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'qq-filter-http-'));
  const config: AppConfig = {
    ...DEFAULT_CONFIG,
    server: { ...DEFAULT_CONFIG.server, port: 0, token: 'filter-test-token-0123456789', allowDownload: true },
    storage: {
      dataDir: join(root, 'data'),
      dbPath: join(root, 'data', 'archive.db'),
      mediaDir: join(root, 'data', 'media'),
      backupDir: join(root, 'data', 'backups'),
      logDir: join(root, 'data', 'logs'),
    },
    collector: { ...DEFAULT_CONFIG.collector, kind: 'none' },
  };
  const db = openDatabase({ path: config.storage.dbPath });
  const logger = createLogger({ console: false });
  const created = createServer({ config, db, logger: logger.child('test'), repoRoot: root, version: '0.0.0-filter', startedAt: Date.now() });
  await new Promise<void>((r) => created.server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(created.server.address() as AddressInfo).port}`;
  t.after(async () => {
    await created.close();
    await logger.close();
    try {
      db.close();
    } catch {
      /* 已关 */
    }
    rmSync(root, { recursive: true, force: true });
  });

  const session = seed(db, [msg('买的茶叶到了', 3, { filtered: true, filterReason: '关键词命中「买茶」' })]);
  const sid = db.getSessionByKey('default', sessionKeyOf('group', 'g:1'))!.id;
  assert.ok(session);

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: config.server.token }),
  });
  const token = (await login.json() as { data: { accessToken: string } }).data.accessToken;
  const get = async (p: string) => (await fetch(`${base}${p}`, { headers: { Authorization: `Bearer ${token}` } })).json() as Promise<any>;

  await t.test('时间线默认隐藏、includeFiltered=1 显示，且带 filtered/filterReason', async () => {
    const hid = await get(`/api/sessions/${sid}/messages?limit=100`);
    assert.equal(hid.data.items.length, 2);
    assert.ok(!hid.data.items.some((m: any) => m.filtered));

    const shown = await get(`/api/sessions/${sid}/messages?limit=100&includeFiltered=1`);
    assert.equal(shown.data.items.length, 3);
    const f = shown.data.items.find((m: any) => m.filtered);
    assert.ok(f, 'includeFiltered=1 时必须能拿到被过滤的消息');
    assert.equal(f.text, '买的茶叶到了');
    assert.match(f.filterReason, /买茶/);
  });

  await t.test('搜索默认隐藏、includeFiltered=1 显示', async () => {
    const hid = await get('/api/search?q=%E8%8C%B6%E5%8F%B6');
    assert.equal(hid.data.total, 0);
    const shown = await get('/api/search?q=%E8%8C%B6%E5%8F%B6&includeFiltered=1');
    assert.equal(shown.data.total, 1);
  });

  await t.test('导出**必须**带上被过滤的消息（少导出=真丢数据）', async () => {
    const res = await fetch(`${base}/api/export/session/${sid}?format=jsonl`, { headers: { Authorization: `Bearer ${token}` } });
    const text = await res.text();
    const lines = text.trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 3, `导出应包含全部 3 条（含被过滤那条），实际 ${lines.length} 条`);
    assert.ok(text.includes('买的茶叶到了'), '被过滤消息的正文必须在导出里');
  });

  await t.test('/api/stats 暴露已过滤计数', async () => {
    const stats = await get('/api/stats');
    assert.equal(stats.data.messages, 3);
    assert.equal(stats.data.messagesFiltered, 1);
  });
});
