/**
 * packages/collect 集成测试。
 *
 * 全程使用**本地假 OneBot v11 服务器**（node:http，端口 0），绝不访问真实 QQ：
 *  - 校验鉴权头、只读 action、分页游标、错误注入（500 / 断连 / 401）；
 *  - 校验采集调度器的增量、去重、重试、会话隔离、断点续传、媒体回调。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AppError,
  DEFAULT_CONFIG,
  createLogger,
  sessionKeyOf,
  type AlertConfig,
  type AppConfig,
  type CollectorConfig,
  type FiltersConfig,
  type ResourceRef,
} from '../packages/core/src/index.ts';
import { openDatabase, type Db } from '../packages/db/src/index.ts';
import { MediaArchiver } from '../packages/import/src/index.ts';
import * as collectIndex from '../packages/collect/src/index.ts';
import {
  CollectRunner,
  OneBotCollector,
  RETRY_DELAYS_MS,
  createCollectRunner,
  type ArchiveMediaBytesFn,
  type ArchiveMediaFn,
  type CollectSession,
  type Collector,
  type MediaArchiverLike,
} from '../packages/collect/src/index.ts';

/* ------------------------------------------------------------------ */
/* 假 OneBot 服务器                                                     */
/* ------------------------------------------------------------------ */

interface RawMsg {
  message_id: string;
  message_seq: number;
  time: number; // 秒
  sender: { user_id: number; nickname: string; card?: string };
  message: unknown;
  raw_message?: string;
}

interface FakeOptions {
  token?: string;
  groups?: Array<{ group_id: number; group_name: string }>;
  friends?: Array<{ user_id: number; nickname: string }>;
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(text);
}

class FakeOneBot {
  readonly token: string;
  readonly groups: Array<{ group_id: number; group_name: string }>;
  readonly friends: Array<{ user_id: number; nickname: string }>;
  readonly groupMsgs = new Map<number, RawMsg[]>();
  readonly privateMsgs = new Map<number, RawMsg[]>();
  readonly calls: string[] = [];
  readonly dropped: string[] = [];
  readonly mediaBytes = Buffer.from('FAKEBYTES');

  /** 强制所有请求 401。 */
  unauthorized = false;
  /** 任意请求的前 N 次返回 500。 */
  failAny = 0;
  /** 任意请求的前 N 次直接断连（模拟网络错误）。 */
  dropAny = 0;
  /** get_group_msg_history 永久 500 的次数（Infinity = 永久失败）。 */
  failGroupHistory = 0;
  /** 无视 message_seq 游标，每次都返回全量（用于"同一批喂两次"）。 */
  ignoreCursor = false;
  /**
   * 模拟 NapCat 对「该会话没有任何消息」的应答：
   * `status:"failed"` + `message:"消息<N>不存在"`（未带游标时 N 就是字面量 "undefined"）。
   * 真实账号上一堆零历史联系人都会走这条分支，它必须被当成空页而不是采集失败。
   */
  emptyHistory = false;

  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  url = '';

  constructor(opts: FakeOptions = {}) {
    this.token = opts.token ?? 'test-token';
    this.groups = opts.groups ?? [{ group_id: 123, group_name: '测试群' }];
    this.friends = opts.friends ?? [{ user_id: 2001, nickname: '好友甲' }];
  }

  count(action: string): number {
    return this.calls.filter((a) => a === action).length;
  }

  async listen(): Promise<void> {
    this.server = createServer((req, res) => this.handle(req, res));
    this.server.on('connection', (socket: Socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    const addr = this.server.address();
    if (!addr || typeof addr === 'string') throw new Error('无法绑定测试端口');
    this.url = `http://127.0.0.1:${addr.port}`;
  }

  async close(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (!s) return;
    // 双保险：绝不让 keep-alive / 半开连接把 teardown 挂住。
    s.closeAllConnections();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  /** 只读的二进制直链，供 fetchMedia(url) 使用。 */
  private handle(req: IncomingMessage, res: ServerResponse): void {
    if (req.method === 'GET') {
      if (req.url === '/img.bin') {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(this.mediaBytes);
        return;
      }
      sendJson(res, 404, { status: 'failed', retcode: 1404, message: 'not found' });
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('error', () => {});
    req.on('end', () => {
      const action = String(req.url ?? '/').replace(/^\//, '');
      this.calls.push(action);
      if (this.dropAny > 0) {
        this.dropAny -= 1;
        this.dropped.push(action);
        // 必须 destroy socket（req.destroy() 会让客户端 fetch 永久挂起）。
        req.socket.destroy();
        return;
      }
      let params: Record<string, unknown> = {};
      try {
        params = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
      } catch {
        params = {};
      }

      const auth = req.headers.authorization;
      if (this.unauthorized || auth !== `Bearer ${this.token}`) {
        sendJson(res, 401, { status: 'failed', retcode: 1, message: 'token 校验失败' });
        return;
      }
      if (this.failAny > 0) {
        this.failAny -= 1;
        sendJson(res, 500, { status: 'failed', retcode: -1, message: '注入的内部错误' });
        return;
      }
      this.dispatch(action, params, res);
    });
  }

  private dispatch(action: string, params: Record<string, unknown>, res: ServerResponse): void {
    switch (action) {
      case 'get_login_info':
        sendJson(res, 200, { status: 'ok', retcode: 0, data: { user_id: 10001, nickname: '归档机器人' } });
        return;
      case 'get_status':
        sendJson(res, 200, { status: 'ok', retcode: 0, data: { online: true, good: true } });
        return;
      case 'get_group_list':
        sendJson(res, 200, { status: 'ok', retcode: 0, data: this.groups });
        return;
      case 'get_friend_list':
        sendJson(res, 200, { status: 'ok', retcode: 0, data: this.friends });
        return;
      case 'get_group_msg_history': {
        if (this.emptyHistory) {
          sendJson(res, 200, { status: 'failed', retcode: 200, message: '消息undefined不存在' });
          return;
        }
        if (this.failGroupHistory > 0) {
          if (Number.isFinite(this.failGroupHistory)) this.failGroupHistory -= 1;
          sendJson(res, 500, { status: 'failed', retcode: -1, message: '群历史注入失败' });
          return;
        }
        const gid = Number(params.group_id);
        const messages = this.page(this.groupMsgs.get(gid) ?? [], params);
        sendJson(res, 200, { status: 'ok', retcode: 0, data: { messages } });
        return;
      }
      case 'get_friend_msg_history': {
        if (this.emptyHistory) {
          sendJson(res, 200, { status: 'failed', retcode: 200, message: '消息undefined不存在' });
          return;
        }
        const uid = Number(params.user_id);
        const messages = this.page(this.privateMsgs.get(uid) ?? [], params);
        sendJson(res, 200, { status: 'ok', retcode: 0, data: { messages } });
        return;
      }
      case 'get_image':
      case 'get_record':
      case 'get_file':
        sendJson(res, 200, {
          status: 'ok',
          retcode: 0,
          data: { file: 'x.jpg', base64: this.mediaBytes.toString('base64') },
        });
        return;
      default:
        sendJson(res, 200, { status: 'failed', retcode: 1404, message: `未知 action ${action}` });
    }
  }

  /** OneBot 历史页：新→旧，最多 count 条；有游标时只返回 seq ≤ 游标。 */
  private page(list: RawMsg[], params: Record<string, unknown>): RawMsg[] {
    const count = Math.max(1, Number(params.count) || 20);
    let sel = [...list].sort((a, b) => a.message_seq - b.message_seq);
    if (!this.ignoreCursor && params.message_seq !== undefined) {
      const cursor = Number(params.message_seq);
      sel = sel.filter((m) => m.message_seq <= cursor);
    }
    return sel.slice(-count).reverse();
  }
}

/* ------------------------------------------------------------------ */
/* 测试夹具                                                             */
/* ------------------------------------------------------------------ */

const logger = createLogger({ level: 'error', console: false }).child('collect-test');
const HOUR = 3600_000;

interface Fixture {
  fake: FakeOneBot;
  db: Db;
  collector: OneBotCollector;
  sleeps: number[];
  config: CollectorConfig;
  runner: CollectRunner;
}

function baseConfig(fake: FakeOneBot, overrides: Partial<CollectorConfig> = {}): CollectorConfig {
  return {
    kind: 'onebot',
    baseUrl: fake.url,
    token: fake.token,
    intervalSec: 60,
    lookbackSec: 60,
    initialBackfillDays: 3,
    pageSize: 50,
    maxPagesPerRound: 10,
    syncMedia: true,
    maxMediaBytes: 512 * 1024 * 1024,
    discoverSessions: true,
    sessions: [],
    ...overrides,
  };
}

/** 用一份干净的 DEFAULT_CONFIG 包上测试用的 collector 配置（工厂吃的是 AppConfig）。 */
function appConfig(collector: CollectorConfig): AppConfig {
  return { ...structuredClone(DEFAULT_CONFIG), collector };
}

interface FixtureOptions {
  config?: Partial<CollectorConfig>;
  archiveMedia?: ArchiveMediaFn;
  archiveMediaBytes?: ArchiveMediaBytesFn;
  archiver?: MediaArchiverLike;
  alert?: Partial<AlertConfig>;
  webhookSink?: (body: unknown) => void;
  collectorOverride?: Collector;
  accountUid?: string;
  /** 采集过滤规则（默认不传 = 未启用）。 */
  filters?: FiltersConfig;
}

async function makeFixture(fakeOpts: FakeOptions, opts: FixtureOptions = {}): Promise<Fixture> {
  const fake = new FakeOneBot(fakeOpts);
  await fake.listen();
  const db = openDatabase({ path: ':memory:' });
  const config = baseConfig(fake, opts.config ?? {});
  const collector = new OneBotCollector({ baseUrl: fake.url, token: config.token });
  const sleeps: number[] = [];
  const runnerOpts: ConstructorParameters<typeof CollectRunner>[0] = {
    db,
    collector: opts.collectorOverride ?? collector,
    config,
    logger,
    now: () => Date.now(),
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    maxRetries: RETRY_DELAYS_MS.length,
    ...(opts.accountUid === undefined ? {} : { accountUid: opts.accountUid }),
    ...(opts.archiveMedia === undefined ? {} : { archiveMedia: opts.archiveMedia }),
    ...(opts.archiveMediaBytes === undefined ? {} : { archiveMediaBytes: opts.archiveMediaBytes }),
    ...(opts.archiver === undefined ? {} : { archiver: opts.archiver }),
    ...(opts.alert === undefined ? {} : { alert: opts.alert }),
    ...(opts.filters === undefined ? {} : { filters: opts.filters }),
  };
  if (opts.webhookSink) {
    const sink = opts.webhookSink;
    runnerOpts.fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith(fake.url)) return globalThis.fetch(String(url), init);
      sink(JSON.parse(String(init?.body ?? '{}')));
      return new Response('ok', { status: 200 });
    }) as typeof fetch;
  }
  const runner = new CollectRunner(runnerOpts);
  return { fake, db, collector, sleeps, config, runner };
}

async function teardown(f: Fixture): Promise<void> {
  f.db.close();
  await f.fake.close();
}

function gmsg(id: string, seq: number, timeSec: number, text: string, sender = 3001): RawMsg {
  return {
    message_id: id,
    message_seq: seq,
    time: timeSec,
    sender: { user_id: sender, nickname: `用户${sender}` },
    message: text,
    raw_message: text,
  };
}

function countMessages(db: Db, sessionKey?: string): number {
  const stmt = sessionKey
    ? db.raw.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_key = ?')
    : db.raw.prepare('SELECT COUNT(*) AS n FROM messages');
  const row = (sessionKey ? stmt.get(sessionKey) : stmt.get()) as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

/* ------------------------------------------------------------------ */
/* 测试                                                                 */
/* ------------------------------------------------------------------ */

test('1. 正常增量拉取：第一轮全量，第二轮只落新增（边界重复由 msgKey 去重）', async () => {
  const f = await makeFixture({});
  try {
    const now = Date.now();
    const base = now - 2 * 86_400_000; // 落在 initialBackfillDays=3 的窗口内
    const t0 = Math.floor(base / 1000);
    const msgs = [gmsg('m1', 1, t0, '第一条'), gmsg('m2', 2, t0 + 600, '第二条'), gmsg('m3', 3, t0 + 1200, '第三条')];
    f.fake.groupMsgs.set(123, msgs);

    const r1 = await f.runner.runOnce();
    assert.equal(r1.sessions, 2, '应发现 1 群 + 1 好友');
    assert.equal(r1.fetched, 3);
    assert.equal(r1.inserted, 3);
    assert.equal(r1.duplicate, 0);
    assert.equal(r1.failed, 0);
    assert.deepEqual(r1.errors, []);
    assert.equal(countMessages(f.db), 3);
    assert.equal(
      f.fake.count('get_group_msg_history') + f.fake.count('get_friend_msg_history'),
      2,
      '群 1 页 + 好友 1 页（每页不足 pageSize 即终止回溯）',
    );

    const groupKey = sessionKeyOf('group', 'g:123');
    const cursor1 = f.db.getCollectState('onebot', 'default', groupKey);
    assert.equal(cursor1?.cursorTs, (t0 + 1200) * 1000);
    assert.equal(cursor1?.consecutiveFailures, 0);
    assert.ok(cursor1?.lastOkAt, 'lastOkAt 应被写入');

    // 只增加一条真正的新消息
    f.fake.groupMsgs.set(123, [...msgs, gmsg('m4', 4, t0 + 3000, '第四条')]);
    const r2 = await f.runner.runOnce();
    assert.equal(r2.sessions, 2);
    assert.equal(r2.inserted, 1, '第二轮只落新增');
    assert.equal(r2.duplicate, 1, '游标边界（lookback 内）重取 1 条，靠 msgKey 幂等去重');
    assert.equal(r2.fetched, 2);
    assert.equal(countMessages(f.db), 4);
    assert.equal(f.db.getCollectState('onebot', 'default', groupKey)?.cursorTs, (t0 + 3000) * 1000);
  } finally {
    await teardown(f);
  }
});

test('2. 重复消息去重：同一批喂两次 → inserted=0 / duplicate=N', async () => {
  const f = await makeFixture({}, { config: { discoverSessions: false, sessions: ['group:123'], lookbackSec: 86_400 } });
  try {
    const t0 = Math.floor((Date.now() - 3600_000) / 1000);
    f.fake.ignoreCursor = true; // 服务端无视游标，每轮都返回同一批
    f.fake.groupMsgs.set(123, [gmsg('d1', 1, t0, 'A'), gmsg('d2', 2, t0 + 10, 'B'), gmsg('d3', 3, t0 + 20, 'C')]);

    const r1 = await f.runner.runOnce();
    assert.equal(r1.inserted, 3);
    assert.equal(r1.duplicate, 0);

    const r2 = await f.runner.runOnce();
    assert.equal(r2.inserted, 0, '同一批再喂不应新增');
    assert.equal(r2.duplicate, 3);
    assert.equal(r2.fetched, 3);
    assert.equal(countMessages(f.db), 3);
  } finally {
    await teardown(f);
  }
});

test('3. 网络失败：1s/2s 退避后第 3 次成功', async () => {
  const f = await makeFixture({}, { config: { discoverSessions: false, sessions: ['group:123'] } });
  try {
    const t0 = Math.floor((Date.now() - 3600_000) / 1000);
    f.fake.groupMsgs.set(123, [gmsg('n1', 1, t0, 'A'), gmsg('n2', 2, t0 + 10, 'B'), gmsg('n3', 3, t0 + 20, 'C')]);
    f.fake.dropAny = 2; // 前两次直接断连

    const r = await f.runner.runOnce();
    assert.equal(r.inserted, 3);
    assert.equal(r.failed, 0);
    assert.deepEqual(f.sleeps, [1000, 2000], '退避序列必须是 1s/2s');
    assert.equal(f.fake.count('get_group_msg_history'), 3, '1 次断连 + 1 次断连 + 1 次成功');
    assert.deepEqual(f.fake.dropped, ['get_group_msg_history', 'get_group_msg_history']);
    assert.equal(f.runner.health().consecutiveFailures, 0);
  } finally {
    await teardown(f);
  }
});

test('4. 401 令牌错误被明确上报，且不重试', async () => {
  const f = await makeFixture({}, { config: { discoverSessions: false, sessions: ['group:123'] } });
  try {
    f.fake.unauthorized = true;
    const r = await f.runner.runOnce();
    assert.equal(r.failed, 1, '失败的会话应计入 failed');
    assert.equal(r.inserted, 0);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0]?.error ?? '', /HTTP 401|鉴权失败/);
    assert.equal(f.fake.count('get_group_msg_history'), 1, '401 是凭据错误，只请求一次');
    assert.deepEqual(f.sleeps, [], '不得对 401 做退避重试');
    const health = f.runner.health();
    assert.equal(health.ok, false);
    assert.equal(health.consecutiveFailures, 1);
    const state = f.db.getCollectState('onebot', 'default', sessionKeyOf('group', 'g:123'));
    assert.match(state?.lastError ?? '', /401|鉴权失败/);
    assert.equal(state?.consecutiveFailures, 1);
  } finally {
    await teardown(f);
  }
});

test('5. 单会话失败不影响其他会话，且重试上限为 3 次（1s/2s/4s）', async () => {
  const f = await makeFixture(
    {},
    { config: { discoverSessions: false, sessions: ['group:123', 'private:2001'] } },
  );
  try {
    const t0 = Math.floor((Date.now() - 3600_000) / 1000);
    f.fake.groupMsgs.set(123, [gmsg('bad1', 1, t0, '拉不到的群消息')]);
    f.fake.privateMsgs.set(2001, [gmsg('p1', 1, t0, '私聊 A'), gmsg('p2', 2, t0 + 10, '私聊 B')]);
    f.fake.failGroupHistory = Number.POSITIVE_INFINITY; // 群会话永久 500

    const r = await f.runner.runOnce();
    assert.equal(r.sessions, 2);
    assert.equal(r.inserted, 2, '私聊消息照常入库');
    assert.equal(r.failed, 1, '只有群会话失败');
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0]?.session, sessionKeyOf('group', 'g:123'));
    assert.equal(f.fake.count('get_group_msg_history'), 4, '1 次初始 + 3 次重试');
    assert.equal(f.fake.count('get_friend_msg_history'), 1);
    assert.deepEqual(f.sleeps, [1000, 2000, 4000]);
    assert.equal(countMessages(f.db), 2);
  } finally {
    await teardown(f);
  }
});

test('6. 重启后从游标续传：新 runner 复用同一 db，只拉到新消息', async () => {
  const f = await makeFixture({});
  try {
    const t0 = Math.floor((Date.now() - 2 * 86_400_000) / 1000);
    const msgs = [gmsg('r1', 1, t0, '旧 A'), gmsg('r2', 2, t0 + 600, '旧 B')];
    f.fake.groupMsgs.set(123, msgs);
    const first = await f.runner.runOnce();
    assert.equal(first.inserted, 2);
    assert.equal(countMessages(f.db), 2);

    // 模拟进程重启：新 collector + 新 runner，同一个 db 文件（这里用同一实例代表持久化）
    f.fake.groupMsgs.set(123, [...msgs, gmsg('r3', 3, t0 + 3600, '重启后的新消息')]);
    const collector2 = new OneBotCollector({ baseUrl: f.fake.url, token: f.fake.token });
    const runner2 = new CollectRunner({
      db: f.db,
      collector: collector2,
      config: f.config,
      logger,
      sleep: async () => {},
    });
    const second = await runner2.runOnce();
    assert.equal(second.inserted, 1, '只拉到重启后的新消息');
    assert.equal(second.duplicate, 1, '游标边界重取 1 条，靠 msgKey 幂等去重');
    assert.equal(second.fetched, 2);
    assert.equal(countMessages(f.db), 3);
    assert.equal(
      f.db.getCollectState('onebot', 'default', sessionKeyOf('group', 'g:123'))?.cursorTs,
      (t0 + 3600) * 1000,
    );
  } finally {
    await teardown(f);
  }
});

test('7. 媒体下载：注入的 archiver 回调按 ResourceRef 逐个调用', async () => {
  const calls: Array<{ ref: ResourceRef; msgKey: string }> = [];
  const f = await makeFixture(
    {},
    {
      config: { discoverSessions: false, sessions: ['group:123'] },
      archiveMedia: async (ref, msg) => {
        calls.push({ ref, msgKey: msg.msgKey });
        return { status: 'present' };
      },
    },
  );
  try {
    const t0 = Math.floor((Date.now() - 3600_000) / 1000);
    f.fake.groupMsgs.set(123, [
      gmsg('md1', 1, t0, '[CQ:image,file=pic.jpg,url=http://example.invalid/pic.jpg]看这个'),
      gmsg('md2', 2, t0 + 10, '[CQ:record,file=voice.amr]'),
      gmsg('md3', 3, t0 + 20, '[CQ:file,file=doc.pdf]'),
    ]);

    const r = await f.runner.runOnce();
    assert.equal(r.inserted, 3);
    assert.equal(r.mediaSaved, 3);
    assert.equal(r.mediaMissing, 0);
    assert.equal(calls.length, 3, '3 条消息各 1 个媒体引用');
    assert.equal(calls[0]?.ref.kind, 'image');
    assert.equal(calls[0]?.ref.filename, 'pic.jpg');
    assert.equal(calls[0]?.ref.url, 'http://example.invalid/pic.jpg');
    assert.equal(calls[1]?.ref.kind, 'audio');
    assert.equal(calls[2]?.ref.kind, 'file');
    assert.match(calls[0]?.msgKey ?? '', /^id:md1$/);

    // fetchMedia 的两条路径：直链 GET 与 OneBot /get_image(base64)
    const viaUrl = await f.collector.fetchMedia({ kind: 'image', url: `${f.fake.url}/img.bin`, filename: 'a.jpg' });
    assert.equal(Buffer.from(viaUrl?.data ?? []).toString('utf8'), 'FAKEBYTES');
    assert.equal(viaUrl?.filename, 'a.jpg');
    const viaApi = await f.collector.fetchMedia({ kind: 'image', filename: 'b.jpg' });
    assert.equal(Buffer.from(viaApi?.data ?? []).toString('utf8'), 'FAKEBYTES');
    assert.equal(f.fake.count('get_image'), 1);
  } finally {
    await teardown(f);
  }
});

/**
 * 采集窗口每轮都会重叠：消息被唯一约束挡住，但媒体不会 —— 没有这道闸门，
 * 同一张图会被**每轮重新下载一遍**（长期挂机时是白白的带宽与上游压力）。
 * 这里锁住三条：
 *  1. 媒体齐备时不再调用归档器；
 *  2. 齐备性判定只看 present —— 缺失的媒体下一轮必须仍然重试（rkey 过期后的补救路径）；
 *  3. 归档器若没返回可入库的 media（只回 status，不落库），关联为空，下一轮照旧重试。
 */
test('7b. 媒体不重复下载：齐备则跳过，缺失仍重试', async () => {
  const calls: string[] = [];
  const f = await makeFixture(
    {},
    {
      config: { discoverSessions: false, sessions: ['group:123'] },
      archiveMedia: async (ref, msg) => {
        calls.push(`${msg.msgKey}:${ref.filename ?? ''}`);
        // 返回**可入库**的 media，才会真的建立 message_media 关联
        return {
          status: 'present' as const,
          media: {
            sha256: 'c'.repeat(64),
            kind: ref.kind,
            size: 11,
            relPath: `image/2026/01/c/${'c'.repeat(64)}.jpg`,
            mime: 'image/jpeg',
            status: 'present' as const,
          },
        };
      },
    },
  );
  try {
    const t0 = Math.floor((Date.now() - 3600_000) / 1000);
    f.fake.groupMsgs.set(123, [gmsg('skip1', 1, t0, '[CQ:image,file=pic.jpg,url=http://example.invalid/p.jpg]看图')]);

    const first = await f.runner.runOnce();
    assert.equal(first.inserted, 1);
    assert.equal(first.mediaSaved, 1);
    assert.equal(calls.length, 1, '首轮必须下载');

    // 第二轮：同一条消息又出现在窗口里（重复），媒体已 present → 不应再下载
    const second = await f.runner.runOnce();
    assert.equal(second.duplicate, 1, '前置条件：消息确实是重复的');
    assert.equal(calls.length, 1, '媒体齐备时不得再次调用归档器');
    assert.equal(second.mediaSaved, 0);

    // 安全性质：媒体转为 missing（文件没了/校验失败）后必须重新尝试
    f.db.raw.prepare("UPDATE media SET status = 'missing' WHERE id = (SELECT media_id FROM message_media LIMIT 1)").run();
    const third = await f.runner.runOnce();
    assert.equal(calls.length, 2, 'present 之外的媒体必须继续重试，不能被跳过逻辑吃掉');

    // 归档器只回状态、不落库时关联为空 → 每轮都要重试（不能因为「查不到关联」就永久跳过）
    const calls2Before = calls.length;
    const g = await makeFixture(
      {},
      {
        config: { discoverSessions: false, sessions: ['group:456'] },
        archiveMedia: async (ref, msg) => {
          calls.push(`${msg.msgKey}:${ref.filename ?? ''}`);
          return { status: 'present' as const };
        },
      },
    );
    try {
      const t1 = Math.floor((Date.now() - 3600_000) / 1000);
      g.fake.groupMsgs.set(456, [gmsg('nostore', 1, t1, '[CQ:image,file=a.jpg,url=http://example.invalid/a.jpg]')]);
      await g.runner.runOnce();
      await g.runner.runOnce();
      const own = calls.filter((c) => c.startsWith('id:nostore')).length;
      assert.equal(own, 2, '没有建立关联的媒体必须每轮重试，而不是被当成「已齐备」');
    } finally {
      await teardown(g);
    }
    assert.ok(calls.length > calls2Before);
    assert.equal(third.mediaMissing, 0, '重试成功记 saved，不记 missing');
  } finally {
    await teardown(f);
  }
});

/**
 * 采集过滤在**真实采集轮次**里的接线：默认只标记（数据必须还在库），
 * `drop=true` 才跳过存储。这条只验证 runner 的接线，规则本身由 tests/filter.test.ts 覆盖。
 */
test('7c. 过滤接线：默认标记不丢数据；drop=true 才真的跳过存储', async () => {
  const markFilters: FiltersConfig = {
    enabled: true,
    excludeKeywords: ['买茶'],
    excludeSenders: [],
    excludeTypes: [],
    drop: false,
  };
  const f = await makeFixture({}, { config: { discoverSessions: false, sessions: ['group:123'] }, filters: markFilters });
  try {
    const t0 = Math.floor((Date.now() - 3600_000) / 1000);
    f.fake.groupMsgs.set(123, [
      gmsg('flt1', 1, t0, '正常消息'),
      gmsg('flt2', 2, t0 + 10, '这是买茶叶的广告'),
    ]);

    const r = await f.runner.runOnce();
    assert.equal(r.inserted, 2, '默认模式下被过滤的消息也要入库');
    assert.equal(r.filtered, 1, '应统计到 1 条命中');
    assert.equal(r.dropped ?? 0, 0, '没开 drop 就不该有"跳过存储"的计数');
    assert.equal(countMessages(f.db), 2, '库里必须是 2 条 —— 数据不能因为"过滤"而消失');

    // 标记确实写进了库，且默认查询看不到它
    const sid = f.db.raw.prepare('SELECT id FROM sessions LIMIT 1').get() as { id: number };
    const visible = f.db.listMessages({ sessionId: sid.id, limit: 50 });
    assert.equal(visible.items.length, 1, '默认时间线看不到被过滤的那条');
    assert.equal(visible.items[0]?.text, '正常消息');
    const all = f.db.listMessages({ sessionId: sid.id, limit: 50, includeFiltered: true });
    assert.equal(all.items.length, 2);
    const filtered = all.items.find((m) => m.filtered);
    assert.equal(filtered?.text, '这是买茶叶的广告');
    assert.match(filtered?.filterReason ?? '', /买茶/);

    // 第二轮：同样的消息再来一遍，不会再重复计数入库
    const r2 = await f.runner.runOnce();
    assert.equal(r2.duplicate, 2);
    assert.equal(countMessages(f.db), 2);
  } finally {
    await teardown(f);
  }

  const dropFilters: FiltersConfig = { ...markFilters, drop: true };
  const g = await makeFixture({}, { config: { discoverSessions: false, sessions: ['group:123'] }, filters: dropFilters });
  try {
    const t0 = Math.floor((Date.now() - 3600_000) / 1000);
    g.fake.groupMsgs.set(123, [
      gmsg('drp1', 1, t0, '正常消息'),
      gmsg('drp2', 2, t0 + 10, '这是买茶叶的广告'),
    ]);

    const r = await g.runner.runOnce();
    assert.equal(r.inserted, 1, 'drop=true 时只入库未被过滤的那条');
    assert.equal(r.dropped, 1, '跳过的条数必须如实计数');
    assert.equal(r.filtered, 1);
    assert.equal(countMessages(g.db), 1, '被跳过的消息确实不在库里（这是用户显式选择的行为）');
    const row = g.db.raw.prepare('SELECT text FROM messages').get() as { text: string };
    assert.equal(row.text, '正常消息');
  } finally {
    await teardown(g);
  }
});

test('8. CQ 码解析：text / at / reply / face / 资源引用 / 升序 / msgKey', async () => {
  const f = await makeFixture({}, { config: { discoverSessions: false, sessions: ['group:123'] } });
  try {
    const t0 = Math.floor((Date.now() - 3600_000) / 1000);
    const cq = '[CQ:reply,id=m0,text=原消息][CQ:at,qq=10001,name=归档机器人] 你好 [CQ:image,file=pic.jpg,url=http://h/p.jpg] [CQ:face,id=14]';
    f.fake.groupMsgs.set(123, [gmsg('c2', 2, t0 + 10, '普通文本'), gmsg('c1', 1, t0, cq)]);

    const probe = await f.collector.probe();
    assert.deepEqual(probe, { ok: true, uin: '10001', nickname: '归档机器人' });

    const session: CollectSession = { chatType: 'group', peerUid: 'g:123', peerUin: '123', name: '测试群', accountUid: 'default' };
    const msgs = await f.collector.fetchSince(session, 0, { pageSize: 10, maxPages: 3 });
    assert.deepEqual(msgs.map((m) => m.msgId), ['c1', 'c2'], '必须按时间升序返回');
    const m = msgs[0];
    assert.ok(m);
    assert.equal(m.msgKey, 'id:c1', 'message_id 作为 msgId 时 msgKey 形如 id:<message_id>');
    assert.equal(m.direction, 'in');
    assert.equal(m.msgType, 'reply');
    assert.equal(m.seq, '1');
    assert.match(m.text, /@归档机器人/);
    assert.match(m.text, /\[图片\]/);
    assert.match(m.text, /\[表情:14\]/);
    assert.match(m.text, /你好/);
    assert.equal(m.reply?.msgId, 'm0');
    assert.equal(m.reply?.preview, '原消息');
    assert.equal(m.mentions?.[0]?.uid, '10001');
    assert.equal(m.mentions?.[0]?.name, '归档机器人');
    assert.equal(m.resources?.[0]?.kind, 'image');
    assert.equal(m.resources?.[0]?.filename, 'pic.jpg');
    assert.equal(m.resources?.[0]?.url, 'http://h/p.jpg');
    assert.equal(m.elements?.filter((e) => e.type === 'face').length, 1, '未知/表情段不得丢弃');
    assert.equal(m.elements?.filter((e) => e.type === 'image').length, 1);
    assert.equal(msgs[1]?.msgType, 'text');
  } finally {
    await teardown(f);
  }
});

test('9. 只读边界：非白名单 action 在本地被拒绝，不会发出任何 HTTP 请求', async () => {
  const f = await makeFixture({});
  try {
    const before = f.fake.calls.length;
    await assert.rejects(
      () => f.collector.call('send_msg', { user_id: 1, message: '不该发出去' }),
      /拒绝调用非只读接口/,
    );
    await assert.rejects(() => f.collector.call('delete_msg', { message_id: 1 }), /拒绝调用非只读接口/);
    assert.equal(f.fake.calls.length, before, '本地拒绝：一个请求都不该发');
    assert.equal(f.fake.count('send_msg'), 0);
    // 白名单内的接口正常
    const list = await f.collector.listSessions();
    assert.deepEqual(
      list.map((s) => `${s.chatType}:${s.peerUin}`).sort(),
      ['group:123', 'private:2001'],
    );
  } finally {
    await teardown(f);
  }
});

test('10. 连续失败达到阈值：写日志并 POST 告警，webhook 失败不影响采集', async () => {
  const webhooks: unknown[] = [];
  const f = await makeFixture(
    {},
    {
      config: { discoverSessions: false, sessions: ['group:123'], intervalSec: 60 },
      alert: { collectFailureThreshold: 2, webhookUrl: 'http://127.0.0.1:1/webhook', diskLowGb: 1 },
      webhookSink: (body) => webhooks.push(body),
    },
  );
  try {
    f.fake.failGroupHistory = Number.POSITIVE_INFINITY;

    const r1 = await f.runner.runOnce();
    assert.equal(r1.failed, 1);
    assert.equal(f.runner.health().consecutiveFailures, 1);
    assert.equal(webhooks.length, 0, '未达阈值不告警');

    const r2 = await f.runner.runOnce();
    assert.equal(r2.failed, 1);
    assert.equal(f.runner.health().consecutiveFailures, 2);
    assert.equal(webhooks.length, 1, '达到阈值（2）告警一次');
    assert.equal((webhooks[0] as { consecutiveFailures: number }).consecutiveFailures, 2);

    const logs = f.db.listLogs({ scope: 'collect', level: 'error' });
    assert.ok(logs.items.length >= 1, '告警必须同时写库日志');
  } finally {
    await teardown(f);
  }
});

test('11. start() 定时循环返回 stop()，health() 反映轮次结果', async () => {
  const f = await makeFixture({}, { config: { discoverSessions: false, sessions: ['group:123'], intervalSec: 0.05 } });
  try {
    const t0 = Math.floor((Date.now() - 3600_000) / 1000);
    f.fake.groupMsgs.set(123, [gmsg('s1', 1, t0, '定时采集')]);
    const stop = f.runner.start();
    assert.throws(() => f.runner.start(), /已在运行/, '重复 start 必须被拒绝');
    await new Promise((r) => setTimeout(r, 120));
    await stop();
    assert.ok(f.fake.count('get_group_msg_history') >= 1);
    assert.equal(countMessages(f.db), 1, '重复轮次不得重复入库');
    const h = f.runner.health();
    assert.equal(h.ok, true);
    assert.equal(h.consecutiveFailures, 0);
    assert.ok(h.lastOkAt);
  } finally {
    await teardown(f);
  }
});

/**
 * 停止采集 → 期间来新消息 → 再开始：**中间的消息不能丢**。
 *
 * 语义（也是给用户的承诺）：停止只停"定时轮询"，不影响已归档数据；
 * 重新开始时按 `collect_state` 里的游标（往前多看 `lookbackSec` 作重叠保护）继续拉，
 * 因此停机期间到达、且上游历史里还在的消息会被一并补上。
 * 唯一的上游限制是 NapCat 历史缓存的容量（LRU，群聊约几千条）——超出缓存的老消息补不回来，
 * 这一点与本测试无关，测试用的是"上游历史里仍在"的前提。
 */
test('20. 停止采集期间的漏采：重新开始后必须补齐，一条不丢、也不重复', async () => {
  const f = await makeFixture({}, { config: { discoverSessions: false, sessions: ['group:123'], intervalSec: 0.05, lookbackSec: 300 } });
  try {
    const t0 = Math.floor((Date.now() - 3600_000) / 1000);
    f.fake.groupMsgs.set(123, [
      gmsg('a1', 1, t0, '停机前 A'),
      gmsg('a2', 2, t0 + 10, '停机前 B'),
    ]);

    // 1) 先正常采集一轮，游标落在 a2
    const stop = f.runner.start();
    await new Promise((r) => setTimeout(r, 160));
    await stop();
    assert.equal(f.runner.isRunning(), false, 'stop() 之后应显示为未运行');
    assert.equal(countMessages(f.db), 2);

    // 2) 停机期间上游来了 3 条新消息（包括一条【图片】媒体消息）
    const mediaCalls: string[] = [];
    f.fake.groupMsgs.set(123, [
      gmsg('a1', 1, t0, '停机前 A'),
      gmsg('a2', 2, t0 + 10, '停机前 B'),
      gmsg('b1', 3, t0 + 60, '停机期间 C'),
      gmsg('b2', 4, t0 + 120, '[CQ:image,file=pic.jpg,url=http://example.invalid/p.jpg]停机期间 D'),
      gmsg('b3', 5, t0 + 180, '停机期间 E'),
    ]);
    assert.equal(countMessages(f.db), 2, '停机期间库里不该变（确认真的没在采）');

    // 3) 重新开始 → 应把停机期间的 3 条补齐
    const stop2 = f.runner.start();
    await new Promise((r) => setTimeout(r, 200));
    await stop2();

    assert.equal(countMessages(f.db), 5, '停机期间的 3 条必须被补上（共 5 条）');
    const texts = f.db.raw.prepare('SELECT text FROM messages ORDER BY ts').all() as Array<{ text: string }>;
    // 媒体消息的正文会被解析器渲染成可读占位符（[图片]），这里统一归一化后再比较
    const norm = (t: string): string => t.replace(/\[CQ:[^\]]*\]/g, '[MEDIA]').replace(/\[图片\]/g, '[MEDIA]');
    assert.deepEqual(
      texts.map((t) => norm(t.text)),
      ['停机前 A', '停机前 B', '停机期间 C', '[MEDIA]停机期间 D', '停机期间 E'],
      '补采的内容与顺序都要对',
    );

    // 4) 再跑一轮：不能重复入库（唯一约束 + 游标重叠保护一起生效）
    const r3 = await f.runner.runOnce();
    assert.equal(r3.inserted, 0, '重复轮次不得重复入库');
    assert.equal(countMessages(f.db), 5);

    // 5) 停 → 开 是可重复的：多次切换后依然只增不重
    for (let i = 0; i < 2; i += 1) {
      const st = f.runner.start();
      await new Promise((r) => setTimeout(r, 80));
      await st();
    }
    assert.equal(countMessages(f.db), 5, '反复启停不该产生重复或丢失');
    assert.equal(f.runner.isRunning(), false);
    assert.equal(mediaCalls.length, 0);
  } finally {
    await teardown(f);
  }
});

test('12. createCollectRunner 工厂：none → null；onebot → 可 runOnce；缺 baseUrl → COLLECTOR_UNAVAILABLE', async () => {
  const fake = new FakeOneBot({});
  await fake.listen();
  const db = openDatabase({ path: ':memory:' });
  try {
    // collector.kind = none：明确返回 null（server 探测据此判定"采集不可用"）
    const disabled = appConfig(baseConfig(fake, { kind: 'none' }));
    assert.equal(createCollectRunner({ config: disabled, db, logger }), null);

    // kind = onebot 但 baseUrl 为空：抛出明确错误码，绝不静默退化
    assert.throws(
      () => createCollectRunner({ config: appConfig(baseConfig(fake, { baseUrl: '' })), db, logger }),
      (err: unknown) => err instanceof AppError && err.code === 'COLLECTOR_UNAVAILABLE',
    );

    // 正常构造：采集参数确实取自 config.collector（静态清单 + pageSize 等）
    const cfg = appConfig(baseConfig(fake, { discoverSessions: false, sessions: ['group:123'], pageSize: 7 }));
    const runner = createCollectRunner({ config: cfg, db, logger });
    assert.ok(runner instanceof CollectRunner, '工厂必须返回 CollectRunner 实例');

    const t0 = Math.floor((Date.now() - 3600_000) / 1000);
    fake.groupMsgs.set(123, [gmsg('f1', 1, t0, '工厂拉到的消息'), gmsg('f2', 2, t0 + 10, '第二条')]);
    const round = await runner.runOnce();
    assert.equal(round.sessions, 1, 'discoverSessions=false 时只采静态清单里的会话');
    assert.equal(round.inserted, 2);
    assert.equal(round.failed, 0);
    assert.equal(fake.count('get_group_msg_history'), 1);
    assert.equal(
      db.getCollectState('onebot', 'default', sessionKeyOf('group', 'g:123'))?.cursorTs,
      (t0 + 10) * 1000,
      '工厂构造的 runner 也必须持久化游标',
    );
  } finally {
    db.close();
    await fake.close();
  }
});

test('13. 工厂满足 server 自动探测契约：入口返回带 runOnce() 的对象，并透传 archiver', async () => {
  const fake = new FakeOneBot({});
  await fake.listen();
  const db = openDatabase({ path: ':memory:' });
  const archived: Array<{ kind: string; url?: string }> = [];
  const archiver: MediaArchiverLike = {
    archive: async (candidates) => {
      archived.push({ kind: candidates.kind, url: candidates.url });
      return { status: 'present' };
    },
  };
  try {
    // 复刻 packages/server/src/index.ts:loadCollectRunner() 的候选顺序与接受条件
    const mod = collectIndex as unknown as Record<string, unknown>;
    const name = ['createCollector', 'createCollectRunner', 'default'].find((n) => typeof mod[n] === 'function');
    assert.equal(name, 'createCollectRunner', `server 探测应命中工厂（实际命中：${String(name)}）`);

    const make = mod['createCollectRunner'] as (o: Record<string, unknown>) => unknown;
    const made = make({
      config: appConfig(baseConfig(fake, { discoverSessions: false, sessions: ['group:123'] })),
      db,
      logger,
      archiver,
    });
    assert.ok(
      made !== null && typeof made === 'object' && typeof (made as CollectRunner).runOnce === 'function',
      'server 只接受带 runOnce() 的返回对象',
    );

    const t0 = Math.floor((Date.now() - 3600_000) / 1000);
    fake.groupMsgs.set(123, [gmsg('fa1', 1, t0, '[CQ:image,file=p.jpg,url=http://example.invalid/p.jpg]看图')]);
    const round = await (made as CollectRunner).runOnce();
    assert.equal(round.inserted, 1);
    assert.equal(round.mediaSaved, 1, '注入的 archiver 必须被真实调用');
    assert.equal(archived.length, 1);
    assert.equal(archived[0]?.kind, 'image');
    assert.equal(archived[0]?.url, 'http://example.invalid/p.jpg');
  } finally {
    db.close();
    await fake.close();
  }
});

test('14. 媒体入库护栏：只注入 archiver（复刻 CLI 接线）也必须写 media / message_media', async () => {
  // 回归：CollectRunner 曾经只把字节落盘、从不写 media 表。
  // 真实账号上的表现是「磁盘 46MB 图片 + 缩略图，media 表 0 行」，于是
  // Web 媒体页空白、/api/media/:id/raw|thumb 全部 404、verify 报 0 个媒体、
  // 备份清单写「媒体 0 个」——「防丢失」对媒体这一半直接失效。
  //
  // 关键：这里**不允许**注入 archiveMedia。那是 tests/acceptance.test.ts 的做法，
  // 它自己顺手把 upsertMedia/linkMessageMedia 干了，于是把生产代码的缺口遮住。
  // 本用例复刻 apps/cli/src/main.ts 的真实接线：只给 archiver。
  const mediaRoot = mkdtempSync(join(tmpdir(), 'qq-collect-media-'));
  const archiver = new MediaArchiver({ root: mediaRoot, logger });
  const f = await makeFixture({}, { config: { discoverSessions: false, sessions: ['group:123'] }, archiver });
  try {
    const t0 = Math.floor((Date.now() - 3600_000) / 1000);
    f.fake.groupMsgs.set(123, [gmsg('mi1', 1, t0, `[CQ:image,file=pic.jpg,url=${f.fake.url}/img.bin]看图`)]);

    const r = await f.runner.runOnce();
    assert.equal(r.inserted, 1);
    assert.equal(r.mediaSaved, 1, '字节必须真的落盘');
    assert.equal(r.mediaMissing, 0);

    const mediaCount = Number((f.db.raw.prepare('SELECT COUNT(*) AS n FROM media').get() as { n: number }).n);
    assert.equal(mediaCount, 1, '归档成功后必须写 media 行，否则媒体在后端不存在');
    const row = f.db.raw.prepare('SELECT kind, size, status, rel_path FROM media').get() as {
      kind: string;
      size: number;
      status: string;
      rel_path: string;
    };
    assert.equal(row.kind, 'image');
    assert.equal(row.status, 'present');
    assert.equal(row.size, f.fake.mediaBytes.length, 'size 必须是真实字节数');
    assert.ok(row.rel_path.length > 0, 'rel_path 必须能定位到磁盘文件');

    const links = Number((f.db.raw.prepare('SELECT COUNT(*) AS n FROM message_media').get() as { n: number }).n);
    assert.equal(links, 1, '必须建立 message_media 关联，否则消息详情里看不到附件');
  } finally {
    await teardown(f);
    rmSync(mediaRoot, { recursive: true, force: true });
  }
});

test('15. 零历史会话护栏：上游「消息N不存在」是空页，不是采集失败', async () => {
  // 回归：真实账号上有一批零历史联系人，NapCat 回
  //   {"status":"failed","retcode":200,"message":"消息undefined不存在"}
  // 旧实现把它当会话失败，刷出 7 条失败告警并让 failed=7，
  // 真正的故障会被这些噪声淹没。
  const f = await makeFixture({}, { config: { discoverSessions: false, sessions: ['group:123', 'private:2001'] } });
  try {
    f.fake.emptyHistory = true;

    const r = await f.runner.runOnce();
    assert.equal(r.sessions, 2);
    assert.equal(r.fetched, 0);
    assert.equal(r.inserted, 0);
    assert.equal(r.failed, 0, '零历史绝不能计入失败');
    assert.deepEqual(r.errors, []);

    for (const key of [sessionKeyOf('group', 'g:123'), sessionKeyOf('private', 'u:2001')]) {
      const st = f.db.getCollectState('onebot', 'default', key);
      assert.ok(st, `${key} 必须留下游标记录`);
      assert.equal(st.lastError, null, `${key} 不应记录错误`);
      assert.equal(st.consecutiveFailures, 0, `${key} 不应累计失败`);
    }
  } finally {
    await teardown(f);
  }
});

/* ------------------------------------------------------------------ */
/* 媒体字节回落（直链 rkey 过期 → OneBot 重取）                          */
/* ------------------------------------------------------------------ */

test('16. 直链失败后回落 OneBot 重取字节，missing 结论被推翻', async () => {
  // 真机背景：采集到的图片 URL 带 rkey 且有 TTL，过期后直链必失败。
  // 旧实现只失败一次就永久记 missing；这里验证「归档 missing → 回落 fetchMedia
  // → 拿到字节 → 交字节入口 → 结论翻成 present」这条链路真的接通。
  const byteCalls: Array<{ bytes: number; kind: string; filename: string | undefined }> = [];
  const f = await makeFixture(
    {},
    {
      config: { discoverSessions: false, sessions: ['group:123'] },
      archiveMedia: async () => ({ status: 'missing', reason: '直链 403（rkey 已过期）' }),
      archiveMediaBytes: async (data, ref) => {
        byteCalls.push({ bytes: data.length, kind: ref.kind, filename: ref.filename });
        return { status: 'present' };
      },
    },
  );
  try {
    const t0 = Math.floor((Date.now() - 3600_000) / 1000);
    f.fake.groupMsgs.set(123, [
      // 直链指向一个必然连不上的本地端口，逼出「直链失败」这一支。
      gmsg('rt1', 1, t0, '[CQ:image,file=pic.jpg,url=http://127.0.0.1:9/dead.jpg]看图'),
    ]);

    const r = await f.runner.runOnce();
    assert.equal(r.inserted, 1);
    assert.equal(byteCalls.length, 1, '直链失败后应恰好回落一次');
    assert.equal(byteCalls[0]?.kind, 'image');
    assert.equal(byteCalls[0]?.bytes, Buffer.from('FAKEBYTES').length, '回落的字节来自 OneBot 接口');
    assert.equal(byteCalls[0]?.filename, 'pic.jpg');
    assert.equal(f.fake.count('get_image'), 1, '走的是 /get_image 重取，而不是已死的直链');
    assert.equal(r.mediaSaved, 1, 'missing 被推翻，计入已保存');
    assert.equal(r.mediaMissing, 0, '不能再计入缺失');
  } finally {
    await teardown(f);
  }
});

test('17. 未注入字节入口时不做无谓重取，媒体保持 missing', async () => {
  const f = await makeFixture(
    {},
    {
      config: { discoverSessions: false, sessions: ['group:123'] },
      archiveMedia: async () => ({ status: 'missing', reason: '直链 403' }),
      // 刻意不注入 archiveMediaBytes，也不给带 archiveBytes 的 archiver。
    },
  );
  try {
    const t0 = Math.floor((Date.now() - 3600_000) / 1000);
    f.fake.groupMsgs.set(123, [gmsg('nr1', 1, t0, '[CQ:image,file=pic.jpg]')]);

    const r = await f.runner.runOnce();
    assert.equal(r.inserted, 1);
    assert.equal(f.fake.count('get_image'), 0, '没有字节入口就不该向 OneBot 要字节');
    assert.equal(r.mediaMissing, 1);
    assert.equal(r.mediaSaved, 0);
  } finally {
    await teardown(f);
  }
});

test('18. 只注入 archiver 时走它的 archiveBytes 入口', async () => {
  const byteCalls: number[] = [];
  const archiver: MediaArchiverLike = {
    archive: async () => ({ status: 'missing', reason: '直链 403' }),
    archiveBytes: async (data) => {
      byteCalls.push(data.length);
      return { status: 'present' };
    },
  };
  const f = await makeFixture(
    {},
    { config: { discoverSessions: false, sessions: ['group:123'] }, archiver },
  );
  try {
    const t0 = Math.floor((Date.now() - 3600_000) / 1000);
    f.fake.groupMsgs.set(123, [gmsg('ab1', 1, t0, '[CQ:image,file=pic.jpg]')]);

    const r = await f.runner.runOnce();
    assert.deepEqual(byteCalls, [Buffer.from('FAKEBYTES').length]);
    assert.equal(r.mediaSaved, 1);
    assert.equal(r.mediaMissing, 0);
  } finally {
    await teardown(f);
  }
});

test('19. 归档成功时不触发 OneBot 重取（回落只在失败分支）', async () => {
  let bytesCalled = 0;
  const f = await makeFixture(
    {},
    {
      config: { discoverSessions: false, sessions: ['group:123'] },
      archiveMedia: async () => ({ status: 'present' }),
      archiveMediaBytes: async () => {
        bytesCalled += 1;
        return { status: 'present' };
      },
    },
  );
  try {
    const t0 = Math.floor((Date.now() - 3600_000) / 1000);
    f.fake.groupMsgs.set(123, [gmsg('ok1', 1, t0, '[CQ:image,file=pic.jpg]')]);

    const r = await f.runner.runOnce();
    assert.equal(r.mediaSaved, 1);
    assert.equal(bytesCalled, 0, 'archive 成功时不该再回落');
    assert.equal(f.fake.count('get_image'), 0);
  } finally {
    await teardown(f);
  }
});

test('20. 重取抛错不冒泡，媒体仍按 missing 落库、消息照常入库', async () => {
  const f = await makeFixture(
    {},
    {
      config: { discoverSessions: false, sessions: ['group:123'] },
      archiveMedia: async () => ({ status: 'missing', reason: '直链 403' }),
      archiveMediaBytes: async () => {
        throw new Error('归档器炸了');
      },
    },
  );
  try {
    const t0 = Math.floor((Date.now() - 3600_000) / 1000);
    f.fake.groupMsgs.set(123, [gmsg('boom1', 1, t0, '[CQ:image,file=pic.jpg]')]);

    const r = await f.runner.runOnce();
    assert.equal(r.inserted, 1, '字节回转失败不能影响消息入库');
    assert.equal(r.mediaMissing, 1);
    assert.equal(r.mediaSaved, 0);
    assert.equal(countMessages(f.db), 1);
  } finally {
    await teardown(f);
  }
});
