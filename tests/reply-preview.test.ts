/**
 * 引用（回复）关系解析与展示的回归测试。
 *
 * 这一组用例锁定的是一个**真实缺陷**：OneBot 采集到的引用消息只有 `reply_to_id`
 * （QQ 的原始消息 id），没有 `reply_to_msg_key`，而原先的实现
 *   1) 在 `/api/messages/:id` 里用 `typeof replyToId === 'number'` 判断，恒为假；
 *   2) 时间线从不返回任何引用预览，前端 `replyPreviewOf()` 永远拿不到 `replyPreview`；
 *   3) 前端点击引用时用 QQ 原始 id 去请求本库 id，必然 404。
 * 结果是归档里 27 条引用消息（目标 27/27 都在库中）**一条都显示不出被引用的内容**。
 *
 * 覆盖三层：`Db.getReplyPreviews()` 的匹配语义、两条 HTTP 路由的返回契约、
 * 以及前端不再把 QQ 原始 id 当本库 id 用。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { AppConfig, NormalizedMessage, NormalizedSession } from '../packages/core/src/index.ts';
import { createLogger, messageKeyOf, sessionKeyOf } from '../packages/core/src/index.ts';
import { openDatabase, replyLookupKey } from '../packages/db/src/index.ts';
import { createServer } from '../packages/server/src/index.ts';

const TOKEN = 'reply-test-token-0123456789';
const BASE_TS = 1_700_000_000_000;

const GROUP: NormalizedSession = { accountUid: 'u_self', chatType: 'group', peerUid: '900001', name: '引用测试群' };
const OTHER_GROUP: NormalizedSession = { accountUid: 'u_self', chatType: 'group', peerUid: '900002', name: '另一个群' };

function makeConfig(root: string): AppConfig {
  const dataDir = join(root, 'data');
  return {
    server: {
      host: '127.0.0.1',
      port: 0,
      token: TOKEN,
      sessionTtlSec: 3600,
      allowDownload: true,
      exportMaxMessages: 10000,
      trustProxy: false,
    },
    storage: {
      dataDir,
      dbPath: join(dataDir, 'archive.db'),
      mediaDir: join(dataDir, 'media'),
      backupDir: join(dataDir, 'backups'),
      logDir: join(dataDir, 'logs'),
    },
    backup: { intervalHours: 0, keep: 7, verify: true },
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
      maxMediaBytes: 512 * 1024 * 1024,
      discoverSessions: false,
      sessions: [],
    },
    stt: {
      enabled: false,
      engine: 'whisper-cli',
      binary: 'whisper-cli',
      ffmpeg: 'ffmpeg',
      model: join(dataDir, 'model.bin'),
      language: 'zh',
      vadModel: '',
      threads: 1,
      timeoutMs: 10_000,
      maxDurationSec: 600,
    },
  };
}

/** 一条消息的构造器：`replyTo` 走 `reply_to_id`，`replyKey` 走 `reply_to_msg_key`。 */
function msg(
  text: string,
  i: number,
  over: Partial<NormalizedMessage> & { replyTo?: string; replyKey?: string } = {},
): NormalizedMessage {
  const { replyTo, replyKey, ...rest } = over;
  const msgId = `m${i}`;
  return {
    msgKey: messageKeyOf({ msgId, ts: BASE_TS + i * 60_000, text }),
    msgId,
    ts: BASE_TS + i * 60_000,
    direction: 'in',
    msgType: 'text',
    senderName: `用户${i}`,
    text,
    ...(replyTo === undefined && replyKey === undefined
      ? {}
      : { reply: { ...(replyTo === undefined ? {} : { msgId: replyTo }), ...(replyKey === undefined ? {} : { msgKey: replyKey }) } }),
    ...rest,
  };
}

/* ------------------------------------------------------------------ */
/* 1. Db.getReplyPreviews                                              */
/* ------------------------------------------------------------------ */

test('getReplyPreviews：msg_id 与 msg_key 两种引用都要能解析（并按会话隔离）', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'qqarchive-reply-db-'));
  const config = makeConfig(root);
  const db = openDatabase({ path: config.storage.dbPath });
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  const g = db.ensureSession(GROUP);
  const gKey = sessionKeyOf(GROUP.chatType, GROUP.peerUid);
  const o = db.ensureSession(OTHER_GROUP);
  const oKey = sessionKeyOf(OTHER_GROUP.chatType, OTHER_GROUP.peerUid);

  // 目标消息（被引用的那几条）
  db.insertMessages(g.id, GROUP.accountUid, gKey, [msg('被引用的第一条', 0), msg('被引用的第二条', 1)], { source: 'test' });
  // 另一个会话里放一条走同一个 msg_id 的消息：用来验证不会跨会话误配
  db.insertMessages(o.id, OTHER_GROUP.accountUid, oKey, [msg('另一个群的同号消息', 0)], { source: 'test' });
  db.insertMessages(
    g.id,
    GROUP.accountUid,
    gKey,
    [
      msg('用 msg_id 引用', 2, { replyTo: 'm0' }),
      msg('用 msg_key 引用', 3, { replyKey: messageKeyOf({ msgId: 'm1', ts: BASE_TS + 60_000, text: '被引用的第二条' }) }),
      msg('引用一条库里没有的消息', 4, { replyTo: 'not-in-archive' }),
      msg('引用一个不存在的 msg_key', 5, { replyKey: 'no-such-key' }),
    ],
    { source: 'test' },
  );

  const all = db.listMessages({ sessionId: g.id, limit: 100, order: 'asc' }).items;
  const byText = (s: string) => all.find((m) => m.text === s)!;

  const refs = all
    .filter((m) => m.replyToId !== null || m.replyToMsgKey !== null)
    .map((m) => ({ sessionId: m.sessionId, msgKey: m.replyToMsgKey, msgId: m.replyToId }));
  assert.equal(refs.length, 4, '应有 4 条引用消息');

  const previews = db.getReplyPreviews(refs);
  const at = (text: string) => {
    const m = byText(text);
    return previews.get(replyLookupKey({ sessionId: m.sessionId, msgKey: m.replyToMsgKey, msgId: m.replyToId }));
  };

  await t.test('仅带 reply_to_id（OneBot 采集的真实形态）也能解析出引用内容', () => {
    const p = at('用 msg_id 引用');
    assert.ok(p, '必须解析成功 —— 这正是原实现漏掉的场景');
    assert.equal(p.text, '被引用的第一条');
    assert.equal(p.senderName, '用户0');
  });

  await t.test('带 reply_to_msg_key 时按 msg_key 解析', () => {
    const p = at('用 msg_key 引用');
    assert.ok(p);
    assert.equal(p.text, '被引用的第二条');
  });

  await t.test('目标不在归档内时返回空，且不抛错', () => {
    assert.equal(at('引用一条库里没有的消息'), undefined);
    assert.equal(at('引用一个不存在的 msg_key'), undefined);
  });

  await t.test('不会跨会话误配（同 msg_id 在别的会话里也不许命中）', () => {
    const oItems = db.listMessages({ sessionId: o.id, limit: 10 }).items;
    const target = oItems.find((m) => m.text === '另一个群的同号消息')!;
    assert.equal(target.msgId, 'm0', '前置条件：两个会话里都有 msgId=m0 的消息');
    const map = db.getReplyPreviews([{ sessionId: o.id, msgKey: null, msgId: 'not-in-archive' }]);
    assert.equal(map.size, 0, '跨会话的 m0 不能被当成本会话的引用目标');
    // 反过来：本会话查 m0 必须命中自己会话里的那条
    const own = db.getReplyPreviews([{ sessionId: g.id, msgKey: null, msgId: 'm0' }]);
    assert.equal(own.size, 1);
    assert.equal([...own.values()][0]!.text, '被引用的第一条');
  });

  await t.test('空输入、无任何 id 的引用都不查询、不报错', () => {
    assert.equal(db.getReplyPreviews([]).size, 0);
    assert.equal(db.getReplyPreviews([{ sessionId: g.id, msgKey: null, msgId: null }]).size, 0);
    assert.equal(db.getReplyPreviews([{ sessionId: g.id }]).size, 0);
  });

  await t.test('同一批 refs 里重复项只保留一份结果', () => {
    const ref = { sessionId: g.id, msgKey: null, msgId: 'm0' };
    const map = db.getReplyPreviews([ref, { ...ref }]);
    assert.equal(map.size, 1);
  });

  await t.test('已撤回的引用目标仍可解析（是否展示由前端决定）', () => {
    db.insertMessages(g.id, GROUP.accountUid, gKey, [msg('被引用后撤回', 6, { recalled: true })], { source: 'test' });
    const map = db.getReplyPreviews([{ sessionId: g.id, msgKey: null, msgId: 'm6' }]);
    const p = [...map.values()][0]!;
    assert.equal(p.text, '被引用后撤回');
    assert.equal(p.recalled, true);
  });
});

/* ------------------------------------------------------------------ */
/* 2. HTTP 契约                                                        */
/* ------------------------------------------------------------------ */

test('引用关系：时间线与详情两条路由都返回可用的引用信息', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'qqarchive-reply-http-'));
  const config = makeConfig(root);
  const repoRoot = join(root, 'repo');
  const webRoot = join(repoRoot, 'web');
  mkdirSync(webRoot, { recursive: true });
  mkdirSync(config.storage.mediaDir, { recursive: true });
  mkdirSync(config.storage.backupDir, { recursive: true });
  writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>t</title>');
  writeFileSync(join(webRoot, 'app.js'), '');

  const db = openDatabase({ path: config.storage.dbPath });
  const session = db.ensureSession(GROUP);
  const key = sessionKeyOf(GROUP.chatType, GROUP.peerUid);
  db.insertMessages(
    session.id,
    GROUP.accountUid,
    key,
    [
      msg('原话：明天九点开会', 0),
      msg('收到（引用原话）', 1, { replyTo: 'm0' }),
      msg('引用一条不在库里的', 2, { replyTo: 'ghost-message' }),
    ],
    { source: 'test' },
  );
  const all = db.listMessages({ sessionId: session.id, limit: 100, order: 'asc' }).items;
  const replyMsg = all.find((m) => m.text === '收到（引用原话）')!;
  const orphanReply = all.find((m) => m.text === '引用一条不在库里的')!;

  const logger = createLogger({ console: false });
  const created = createServer({
    config,
    db,
    logger: logger.child('test'),
    repoRoot,
    version: '0.0.0-test',
    startedAt: Date.now(),
  });
  await new Promise<void>((done) => created.server.listen(0, '127.0.0.1', () => done()));
  const base = `http://127.0.0.1:${(created.server.address() as AddressInfo).port}`;
  t.after(async () => {
    await created.close();
    await logger.close();
    try {
      db.close();
    } catch {
      /* 已关闭 */
    }
    rmSync(root, { recursive: true, force: true });
  });

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: TOKEN }),
  });
  const token = (await login.json() as { data: { accessToken: string } }).data.accessToken;
  const H = { Authorization: `Bearer ${token}` };
  const get = async (p: string) => {
    const r = await fetch(`${base}${p}`, { headers: H });
    return { status: r.status, body: await r.json() as any };
  };

  await t.test('时间线：引用消息带 replyPreview 与 replyToMessageId', async () => {
    const r = await get(`/api/sessions/${session.id}/messages?limit=100&order=asc`);
    assert.equal(r.status, 200);
    const item = r.body.data.items.find((m: any) => m.id === replyMsg.id);
    assert.ok(item, '时间线里应能找到这条引用消息');
    assert.equal(item.replyPreview, '原话：明天九点开会');
    assert.equal(item.replyToMessageId, all.find((m) => m.text === '原话：明天九点开会')!.id);
    assert.equal(item.replyToSenderName, '用户0');
  });

  await t.test('时间线：引用目标不在归档内时字段为 null，不影响其余字段', async () => {
    const r = await get(`/api/sessions/${session.id}/messages?limit=100&order=asc`);
    const item = r.body.data.items.find((m: any) => m.id === orphanReply.id);
    assert.equal(item.replyPreview, null);
    assert.equal(item.replyToMessageId, null);
    assert.equal(item.text, '引用一条不在库里的', '正文必须照常返回');
  });

  await t.test('详情：原实现恒为 null（typeof replyToId === "number" 永远不成立）', async () => {
    const r = await get(`/api/messages/${replyMsg.id}`);
    assert.equal(r.status, 200);
    assert.equal(typeof r.body.data.replyToId, 'string', '前置条件：replyToId 是 QQ 原始 id 字符串');
    assert.equal(r.body.data.replyPreview, '原话：明天九点开会');
    assert.ok(r.body.data.reply, 'reply 对象保留给既有契约');
    assert.equal(r.body.data.reply.text, '原话：明天九点开会');
    assert.equal(typeof r.body.data.reply.id, 'number');
  });

  await t.test('详情：回复目标缺席时 reply 为 null 且不报 5xx', async () => {
    const r = await get(`/api/messages/${orphanReply.id}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.data.reply, null);
  });

  await t.test('前端点击引用可直达：用 replyToMessageId 取详情是 200', async () => {
    const detail = await get(`/api/messages/${replyMsg.id}`);
    const targetId = detail.body.data.replyToMessageId;
    const r = await get(`/api/messages/${targetId}`);
    assert.equal(r.status, 200, '这就是原先会 404 的路径（前端错用了 QQ 原始 id）');
    assert.equal(r.body.data.text, '原话：明天九点开会');
    // 而用 QQ 原始 id 去请求本库 id ——必须失败（非数字 id 被拒），说明两者确实不可混用
    const wrong = await get(`/api/messages/${detail.body.data.replyToId}`);
    assert.equal(wrong.status, 400, '非数字的消息 id 应被拒绝，而不是被当成内部 id');
  });
});

/* ------------------------------------------------------------------ */
/* 3. 前端护栏                                                          */
/* ------------------------------------------------------------------ */

test('前端：引用预览只认 replyPreview / replyToMessageId，不再拿 QQ 原始 id 当本库 id', () => {
  const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  assert.ok(app.includes('m.replyToMessageId'), 'app.js 必须使用 replyToMessageId 取详情');
  assert.ok(
    !/api\(`\/api\/messages\/\$\{m\.replyToId\}`\)/.test(app),
    'app.js 不得再用 m.replyToId 直接拼 /api/messages/ —— 那是 QQ 原始消息 id',
  );
  assert.ok(app.includes('replyPreviewOf'), '引用预览读取函数应保留');
});
