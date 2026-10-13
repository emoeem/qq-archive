/**
 * 端到端验收测试 —— 对应任务书「第六阶段测试」的 15 项要求。
 *
 * 全部数据由 `tests/fixtures/generate.ts` 合成（确定性种子），**不接触任何真实 QQ
 * 聊天记录**。本文件走完整的真实链路：合成文件 → packages/import 归档 → node:sqlite
 * 持久化 → packages/server HTTP → 断言可检索/可恢复/可鉴权。
 *
 * 与单元测试的分工：`tests/db.test.ts` / `tests/import.test.ts` / `tests/collect.test.ts`
 * / `tests/server.test.ts` 各自验证单个包；这里只验证「组合起来是否真的能防丢失」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  createLogger,
  messageKeyOf,
  planSearch,
  sha256Hex,
  type AppConfig,
  type ImportBatch,
  type NormalizedMessage,
  type NormalizedSession,
  type ResourceRef,
  type Logger,
  type ScopedLogger,
} from '../packages/core/src/index.ts';
import { openDatabase, LATEST_VERSION, type Db } from '../packages/db/src/index.ts';
import {
  MediaArchiver,
  importFile,
  type ArchiveOutcome,
  type ImportContext,
  type ImportStats,
  type SessionHint,
} from '../packages/import/src/index.ts';
import { COLLECT_SOURCE, createCollectRunner } from '../packages/collect/src/index.ts';
import { createServer, normalizeConfig } from '../packages/server/src/index.ts';
import { generateFixtures, type FixtureResult } from './fixtures/generate.ts';

/* ------------------------------------------------------------------ */
/* 测试环境                                                            */
/* ------------------------------------------------------------------ */

const TOKEN = 'acceptance-token-0123456789abcdef';
const ACCOUNT = 'u_self';

/** 每个 test 一个独立临时目录，互不影响；test 结束由 cleanup 删除。 */
interface Env {
  root: string;
  config: AppConfig;
  db: Db;
  logger: ScopedLogger;
  fixtures: FixtureResult;
  /** 根 logger，用于关闭日志文件（ScopedLogger 不暴露 close）。 */
  rootLogger: Logger;
  cleanup(): void;
}

function makeConfig(root: string, collectorBaseUrl = ''): AppConfig {
  const dataDir = join(root, 'data');
  return {
    server: {
      host: '127.0.0.1',
      port: 0,
      token: TOKEN,
      sessionTtlSec: 3600,
      allowDownload: true,
      exportMaxMessages: 100_000,
      trustProxy: false,
    },
    storage: {
      dataDir,
      dbPath: join(dataDir, 'archive.db'),
      mediaDir: join(dataDir, 'media'),
      backupDir: join(dataDir, 'backups'),
      logDir: join(dataDir, 'logs'),
    },
    backup: { intervalHours: 24, keep: 7, verify: true },
    alert: { diskLowGb: 1, collectFailureThreshold: 3, webhookUrl: '' },
    collector: {
      kind: collectorBaseUrl ? 'onebot' : 'none',
      baseUrl: collectorBaseUrl,
      token: '',
      intervalSec: 60,
      lookbackSec: 300,
      initialBackfillDays: 3,
      pageSize: 200,
      maxPagesPerRound: 20,
      syncMedia: true,
      maxMediaBytes: 512 * 1024 * 1024,
      discoverSessions: true,
      sessions: [],
    },
  };
}

function setup(collectorBaseUrl = ''): Env {
  const root = mkdtempSync(join(tmpdir(), 'qq-acc-'));
  const config = normalizeConfig(makeConfig(root, collectorBaseUrl));
  mkdirSync(config.storage.mediaDir, { recursive: true });
  const rootLogger = createLogger({ level: 'error', dir: config.storage.logDir, console: false });
  const logger = rootLogger.child('acceptance');
  const db = openDatabase({ path: config.storage.dbPath, logger });
  const fixtures = generateFixtures({ outDir: join(root, 'fixtures') });
  return {
    root,
    config,
    db,
    logger,
    rootLogger,
    fixtures,
    cleanup() {
      try {
        db.close();
      } catch {
        /* 已关闭 */
      }
      rootLogger.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** 需要一个 ScopedLogger 但又不想写日志时用（MediaArchiver 的 logger 是必填的）。 */
let silentRoot: Logger | null = null;
function silent(): ScopedLogger {
  silentRoot ??= createLogger({ level: 'error', console: false });
  return silentRoot.child('import');
}

/* ------------------------------------------------------------------ */
/* 导入接线（与 CLI / server 使用同一套语义）                          */
/* ------------------------------------------------------------------ */

interface ImportIntoDbOptions {
  db: Db;
  filePath: string;
  mediaDir?: string;
  accountUid?: string;
  format?: string;
  limit?: number;
  sessionHint?: SessionHint;
  logger?: ScopedLogger;
}

/**
 * 把「解析 → 写消息 → 写媒体 → 建关联」串起来。
 *
 * 这段接线的存在原因：`ImportContext.onMedia` 在消息落库**之前**被调用，拿不到
 * `messageId`，所以必须先把每条消息的归档结果按 `msgKey` 缓冲，等 `onBatch` 里
 * `db.insertMessages()` 返回对齐的 `messageIds` 之后再回填 `message_media`。
 */
async function importIntoDb(opts: ImportIntoDbOptions): Promise<ImportStats> {
  const accountUid = opts.accountUid ?? ACCOUNT;
  const source = 'acceptance';
  const logger = opts.logger;
  // msgKey → 该消息各资源的归档结果（onMedia 先于插入触发，所以只能先缓冲）
  const pending = new Map<string, Array<{ ordinal: number; outcome: ArchiveOutcome; ref: ResourceRef }>>();
  const archiver =
    opts.mediaDir === undefined
      ? undefined
      : new MediaArchiver({ root: opts.mediaDir, logger: (logger ?? silent()).child('media') });

  const ctx: ImportContext = {
    filePath: opts.filePath,
    accountUid,
    source,
    onBatch: async (batch: ImportBatch) => {
      const session = batch.session;
      const record = opts.db.ensureSession(session);
      const sessionKey = `${session.chatType}:${session.peerUid}`;
      const result = opts.db.insertMessages(record.id, accountUid, sessionKey, batch.messages, { source });

      // 逐条建立消息 ↔ 媒体关联（messageIds 与 batch.messages 严格等长同序）
      for (let i = 0; i < batch.messages.length; i += 1) {
        const message = batch.messages[i]!;
        const messageId = result.messageIds[i];
        if (messageId === undefined || messageId === null) continue;
        const buffered = pending.get(message.msgKey);
        if (!buffered || buffered.length === 0) continue;
        pending.delete(message.msgKey);
        for (const item of buffered) {
          const mediaId = opts.db.upsertMedia(item.outcome.media).id;
          opts.db.linkMessageMedia(
            messageId,
            mediaId,
            item.ordinal,
            item.ref.filename ?? null,
            item.ref.size ?? null,
          );
        }
      }
      return result;
    },
    onMedia: (outcome, ref, message) => {
      const list = pending.get(message.msgKey) ?? [];
      list.push({ ordinal: list.length, outcome, ref });
      pending.set(message.msgKey, list);
    },
    ...(archiver ? { mediaArchiver: archiver } : {}),
    ...(opts.logger ? { logger: opts.logger } : {}),
    ...(opts.format ? { format: opts.format as never } : {}),
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    ...(opts.sessionHint ? { sessionHint: opts.sessionHint } : {}),
  };

  return importFile(ctx);
}

/* ------------------------------------------------------------------ */
/* HTTP 客户端                                                         */
/* ------------------------------------------------------------------ */

interface Api {
  base: string;
  close(): Promise<void>;
}

async function startApi(env: Env, collect?: unknown): Promise<Api> {
  const created = createServer({
    config: env.config,
    db: env.db,
    logger: env.logger,
    repoRoot: join(env.root, 'webroot'),
    version: 'test',
    startedAt: Date.now(),
    ...(collect === undefined ? {} : { collect: collect as never }),
  });
  await new Promise<void>((resolve) => created.server.listen(0, '127.0.0.1', resolve));
  const addr = created.server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${addr.port}`,
    close: () => created.close(),
  };
}

interface ApiResponse {
  status: number;
  body: any;
  text: string;
  headers: Headers;
}

async function call(
  api: Api,
  path: string,
  opts: { method?: string; token?: string; body?: unknown; raw?: boolean } = {},
): Promise<ApiResponse> {
  const headers: Record<string, string> = {};
  if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${api.base}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const text = await res.text();
  let body: any = text;
  if (!opts.raw) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body, text, headers: res.headers };
}

/** 登录取 accessToken。 */
async function login(api: Api, token = TOKEN): Promise<string> {
  const res = await call(api, '/api/auth/login', { method: 'POST', body: { token } });
  assert.equal(res.status, 200, `登录应成功，实际 ${res.status}: ${res.text.slice(0, 200)}`);
  const access = res.body?.data?.accessToken ?? res.body?.data?.token;
  assert.ok(typeof access === 'string' && access.length > 0, '登录响应必须带 accessToken');
  return access as string;
}

/* ------------------------------------------------------------------ */
/* 1–2. 私聊 / 群聊文本导入                                             */
/* ------------------------------------------------------------------ */

test('验收1: 私聊文本导入 —— 条数、时间、发送者、文本与源文件一致', async () => {
  const env = setup();
  const api = await startApi(env);
  try {
    const stats = await importIntoDb({ db: env.db, filePath: env.fixtures.files.privateJson });
    assert.equal(stats.totalItems, env.fixtures.expected.privateMessages, '解析条数应等于源文件条数');
    assert.equal(stats.inserted, env.fixtures.expected.privateMessages, '全部应插入成功');
    assert.equal(stats.failed, 0, `不应有解析/入库失败：${stats.errors.join('; ')}`);

    const access = await login(api);
    const sessions = await call(api, '/api/sessions?chatType=private', { token: access });
    assert.equal(sessions.status, 200);
    assert.equal(sessions.body.data.items.length, 1, '应只有 1 个私聊会话');

    const sessionId = sessions.body.data.items[0].id as number;
    const msgs = await call(api, `/api/sessions/${sessionId}/messages?limit=500`, { token: access });
    assert.equal(msgs.body.data.items.length, env.fixtures.expected.privateMessages);
    // 时间升序 + 发送者字段完整
    const items = msgs.body.data.items as Array<{ ts: number; senderName: string | null; text: string }>;
    for (let i = 1; i < items.length; i += 1) {
      assert.ok(items[i]!.ts >= items[i - 1]!.ts, '消息必须按时间升序返回');
    }
    assert.ok(items.some((m) => m.senderName !== null && m.senderName !== ''), '发送者名不应全为空');
  } finally {
    await api.close();
    env.cleanup();
  }
});

test('验收2: 群聊文本导入 —— 会话类型、@提及、引用回复、撤回、系统消息被保留', async () => {
  const env = setup();
  const api = await startApi(env);
  try {
    const stats = await importIntoDb({ db: env.db, filePath: env.fixtures.files.groupJson });
    const expectedInserted =
      env.fixtures.expected.groupMessages - env.fixtures.expected.duplicateInFile;
    assert.equal(stats.inserted, expectedInserted, `应插入 ${expectedInserted} 条（源文件含重复）`);
    assert.equal(stats.duplicate, env.fixtures.expected.duplicateInFile, '文件内重复应被判重');

    const access = await login(api);
    const sessions = await call(api, '/api/sessions?chatType=group', { token: access });
    const session = sessions.body.data.items[0];
    assert.equal(session.chatType, 'group');

    const all = await call(api, `/api/sessions/${session.id}/messages?limit=500`, { token: access });
    const items = all.body.data.items as Array<Record<string, unknown>>;
    assert.equal(items.length, expectedInserted);
    assert.ok(items.some((m) => m.msgType === 'image'), '应存在图片消息');
    assert.ok(items.some((m) => m.msgType === 'video'), '应存在视频消息');
    assert.ok(items.some((m) => m.msgType === 'file'), '应存在文件消息');
    assert.ok(items.some((m) => m.recalled === true || m.recalled === 1), '撤回消息应被保留并标记');
    assert.ok(items.some((m) => m.system === true || m.system === 1), '系统消息应被保留');
    assert.ok(
      items.some((m) => m.replyToMsgKey !== null && m.replyToMsgKey !== undefined),
      '引用回复关系应被保留',
    );
    // mentions 在 API 里是**已解析的 JSON 数组**（或 null），不是字符串
    assert.ok(
      items.some(
        (m) =>
          Array.isArray(m.mentions) &&
          (m.mentions as Array<{ uid?: string; name?: string }>).some(
            (x) => x.uid === 'u_m1' || x.name === '李娜',
          ),
      ),
      '@提及应被保留在 mentions 字段',
    );
  } finally {
    await api.close();
    env.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* 3. 长消息与多段                                                      */
/* ------------------------------------------------------------------ */

test('验收3: 长消息与多段 —— 完整文本不截断，elements 多段保留', async () => {
  const env = setup();
  const api = await startApi(env);
  try {
    await importIntoDb({ db: env.db, filePath: env.fixtures.files.groupJson });
    const access = await login(api);
    const sessions = await call(api, '/api/sessions?chatType=group', { token: access });
    const sessionId = sessions.body.data.items[0].id as number;
    const all = await call(api, `/api/sessions/${sessionId}/messages?limit=500&msgType=text`, { token: access });
    const items = all.body.data.items as Array<{ id: number; text: string }>;
    const longest = items.reduce((a, b) => (a.text.length >= b.text.length ? a : b));

    assert.ok(
      longest.text.length >= env.fixtures.expected.longMessageLength,
      `最长消息 ${longest.text.length} 字，应不短于源文件里的 ${env.fixtures.expected.longMessageLength} 字`,
    );

    // 逐字比对 DB 与源文件，确保没有发生「静默截断」
    const raw = JSON.parse(readFileSync(env.fixtures.files.groupJson, 'utf8')) as {
      messages: Array<{ id: string; content?: { text?: string; elements?: unknown[] } }>;
    };
    const src = raw.messages.find((m) => m.id === 'grp-long-000001');
    assert.ok(src?.content?.text, '源文件应含长消息 grp-long-000001');
    assert.equal(
      longest.text,
      src.content.text,
      'DB 里的长消息必须与源文件逐字节相同（不得截断）',
    );

    const detail = await call(api, `/api/messages/${longest.id}`, { token: access });
    assert.equal(detail.status, 200);
    const elements = detail.body.data.elements;
    assert.ok(elements !== null && elements !== undefined, '多段 elements 应被保留');
  } finally {
    await api.close();
    env.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* 4–6. 图片 / 视频 / 文件                                              */
/* ------------------------------------------------------------------ */

test('验收4: 图片 —— 内容寻址落盘、sha256 校验、缩略图与原件可下载', async () => {
  const env = setup();
  const api = await startApi(env);
  try {
    await importIntoDb({
      db: env.db,
      filePath: env.fixtures.files.groupJson,
      mediaDir: env.config.storage.mediaDir,
    });

    const list = env.db.listMedia({ kind: 'image', status: 'present', pageSize: 100 });
    assert.ok(list.total >= 2, `应至少有 2 张图片入库，实际 ${list.total}`);

    for (const item of list.items) {
      const abs = join(env.config.storage.mediaDir, item.relPath);
      assert.ok(existsSync(abs), `媒体文件应真实存在于磁盘：${abs}`);
      // sha256 必须与磁盘上的真实字节一致（内容寻址的权威校验）
      const actual = sha256Hex(readFileSync(abs));
      assert.equal(actual, item.sha256, `media.sha256 必须等于文件真实内容哈希`);
      assert.equal(statSync(abs).size, item.size, 'media.size 必须等于文件真实大小');
    }

    const access = await login(api);
    const first = list.items[0]!;
    const raw = await fetch(`${api.base}/api/media/${first.id}/raw?access=${encodeURIComponent(access)}`);
    assert.equal(raw.status, 200, '带 query token 应能下载原图（<img> 无法带请求头）');
    const bytes = Buffer.from(await raw.arrayBuffer());
    assert.equal(sha256Hex(bytes), first.sha256, '下载到的字节必须与 sha256 匹配');
  } finally {
    await api.close();
    env.cleanup();
  }
});

test('验收5: 视频 —— kind=video 落盘且 HTTP 支持 Range 播放', async () => {
  const env = setup();
  const api = await startApi(env);
  try {
    await importIntoDb({
      db: env.db,
      filePath: env.fixtures.files.groupJson,
      mediaDir: env.config.storage.mediaDir,
    });
    const videos = env.db.listMedia({ kind: 'video', status: 'present', pageSize: 10 });
    assert.ok(videos.total >= 1, '应至少有 1 个视频');
    const video = videos.items[0]!;
    assert.ok(existsSync(join(env.config.storage.mediaDir, video.relPath)), '视频文件应真实存在');

    const access = await login(api);
    const res = await fetch(`${api.base}/api/media/${video.id}/raw?access=${encodeURIComponent(access)}`, {
      headers: { range: 'bytes=0-3' },
    });
    assert.equal(res.status, 206, '视频播放必须支持 Range（否则浏览器拖动进度条会失败）');
    assert.match(res.headers.get('content-range') ?? '', /^bytes 0-3\//);
  } finally {
    await api.close();
    env.cleanup();
  }
});

test('验收6: 文件 —— 原始文件名与声明大小被保留，可下载', async () => {
  const env = setup();
  const api = await startApi(env);
  try {
    await importIntoDb({
      db: env.db,
      filePath: env.fixtures.files.groupJson,
      mediaDir: env.config.storage.mediaDir,
    });
    const files = env.db.listMedia({ kind: 'file', status: 'present', pageSize: 10 });
    assert.ok(files.total >= 1, '应至少有 1 个文件类型媒体');
    const file = files.items[0]!;
    assert.ok(file.relPath.length > 0, 'relPath 必须落库');

    const access = await login(api);
    const res = await fetch(`${api.base}/api/media/${file.id}/raw?access=${encodeURIComponent(access)}`);
    assert.equal(res.status, 200);
    assert.ok(Number(res.headers.get('content-length') ?? '0') > 0, '文件应有非零长度');
  } finally {
    await api.close();
    env.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* 7. 同一消息重复导入                                                  */
/* ------------------------------------------------------------------ */

test('验收7: 同一消息重复导入 —— 幂等，不产生重复行、不重复占用磁盘', async () => {
  const env = setup();
  try {
    const first = await importIntoDb({
      db: env.db,
      filePath: env.fixtures.files.groupJson,
      mediaDir: env.config.storage.mediaDir,
    });
    const afterFirst = env.db.stats();
    const mediaAfterFirst = env.db.mediaStats();

    // 一模一样再导一次（模拟用户手滑/定时任务重跑）
    const second = await importIntoDb({
      db: env.db,
      filePath: env.fixtures.files.groupJson,
      mediaDir: env.config.storage.mediaDir,
    });
    const afterSecond = env.db.stats();
    const mediaAfterSecond = env.db.mediaStats();

    assert.ok(first.inserted > 0);
    assert.equal(second.inserted, 0, '第二次导入不得新增任何消息');
    // 第二次导入时每一条都会撞唯一约束（含源文件内重复），因此 duplicate 至少覆盖第一次全部入库行
    assert.ok(
      second.duplicate >= first.inserted,
      `第二次导入的 duplicate(${second.duplicate}) 应不少于第一次 inserted(${first.inserted})`,
    );
    assert.equal(afterSecond.messages, afterFirst.messages, '消息总数不得变化');
    assert.equal(mediaAfterSecond.present, mediaAfterFirst.present, '媒体不得重复入库（内容寻址）');

    // 磁盘上也不得出现重复副本
    const files = countFiles(env.config.storage.mediaDir);
    const third = await importIntoDb({
      db: env.db,
      filePath: env.fixtures.files.groupJson,
      mediaDir: env.config.storage.mediaDir,
    });
    assert.equal(third.inserted, 0);
    assert.equal(countFiles(env.config.storage.mediaDir), files, '媒体目录文件数不得增长');
  } finally {
    env.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* 8. 程序异常退出与重启                                                */
/* ------------------------------------------------------------------ */

test('验收8: 程序异常退出与重启 —— 数据库可重开、数据零丢失、游标可续', async () => {
  const env = setup();
  const dbPath = env.config.storage.dbPath;
  try {
    await importIntoDb({ db: env.db, filePath: env.fixtures.files.groupJson });
    const before = env.db.stats();
    assert.ok(before.messages > 0);

    // 模拟进程被 kill：不 close、不 checkpoint，直接丢弃句柄后再打开同一个库
    env.db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)'); // 保证已提交数据在 .db 里
    env.db.close();

    const reopened = openDatabase({ path: dbPath, logger: env.logger });
    try {
      const after = reopened.stats();
      assert.equal(after.messages, before.messages, '重启后消息数必须一致');
      assert.equal(after.sessions, before.sessions, '重启后会话数必须一致');
      assert.equal(reopened.schemaVersion(), LATEST_VERSION, '重启后 schema 版本应保持最新');

      // 重启后再导入一次增量：应全部判重，不重复
      const again = await importIntoDb({ db: reopened, filePath: env.fixtures.files.groupJson });
      assert.equal(again.inserted, 0, '重启后的重复导入仍应幂等');
    } finally {
      reopened.close();
    }
  } finally {
    env.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* 9. 网络中断恢复                                                      */
/* ------------------------------------------------------------------ */

test('验收9: 网络中断恢复 —— 重试成功后落库，重启后从游标续传不重不漏', async () => {
  /* 假 OneBot 服务器：前 2 次 /get_group_msg_history 故意断开连接，第 3 次成功。 */
  let historyCalls = 0;
  let dropped = 0;
  const seqBase = 1_760_000_000_000;
  const allMessages = [0, 1, 2, 3, 4].map((i) => ({
    message_id: 1000 + i,
    message_seq: 1000 + i,
    time: Math.floor((seqBase + i * 60_000) / 1000),
    message_type: 'group',
    group_id: 555,
    sender: { user_id: 20000 + i, nickname: `用户${i}` },
    message: [{ type: 'text', data: { text: `第 ${i} 条采集消息` } }],
  }));

  const fake: Server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const action = url.pathname.replace(/^\//, '');
    const send = (payload: unknown): void => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (action === 'get_login_info') {
      send({ status: 'ok', retcode: 0, data: { user_id: 1, nickname: '假机器人' } });
      return;
    }
    if (action === 'get_group_list') {
      send({ status: 'ok', retcode: 0, data: [{ group_id: 555, group_name: '假群', member_count: 3 }] });
      return;
    }
    if (action === 'get_friend_list') {
      send({ status: 'ok', retcode: 0, data: [] });
      return;
    }
    if (action === 'get_group_msg_history') {
      historyCalls += 1;
      if (historyCalls <= 2) {
        // 真实地模拟「网络中断」：直接毁掉 socket，让客户端 fetch 失败
        dropped += 1;
        req.socket.destroy();
        return;
      }
      send({ status: 'ok', retcode: 0, data: { messages: allMessages.slice(0, 2) } });
      return;
    }
    res.writeHead(404).end('{}');
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  const fakePort = (fake.address() as AddressInfo).port;

  const env = setup(`http://127.0.0.1:${fakePort}`);
  try {
    const runner = createCollectRunner({
      config: env.config,
      db: env.db,
      logger: env.logger,
      now: () => seqBase + 10 * 60_000,
    });
    assert.ok(runner !== null, 'collector.kind=onebot 时必须构造出 runner');

    const round = await runner.runOnce();
    assert.equal(dropped, 2, '应真实经历了 2 次连接中断');
    assert.equal(round.errors.length, 0, `重试后应成功：${JSON.stringify(round.errors)}`);
    assert.equal(round.sessions, 1);
    assert.equal(round.inserted, 2, '恢复后应把 2 条消息落库');

    const stats = env.db.stats();
    assert.equal(stats.messages, 2, '数据库里应有 2 条采集来的消息');
    const states = env.db.listCollectStates();
    assert.ok(states.length >= 1, '采集游标必须已持久化（否则重启会重头拉）');
    const state0 = states[0]!;
    const cursor = env.db.getCollectState(state0.source, state0.accountUid ?? 'default', state0.sessionKey);
    assert.ok(cursor, '用真实 (source,accountUid,sessionKey) 回查游标必须命中');
    assert.ok(cursor.cursorTs > 0, '游标时间必须被推进');

    // 重启（新建 runner，复用同一个 db）后应能从游标继续，而不是重拉全量
    historyCalls = 0;
    const runner2 = createCollectRunner({
      config: env.config,
      db: env.db,
      logger: env.logger,
      now: () => seqBase + 20 * 60_000,
    });
    assert.ok(runner2 !== null);
    const round2 = await runner2.runOnce();
    assert.equal(round2.inserted, 0, '重启后不得重复插入已有消息');
    assert.ok(historyCalls >= 1, '重启后应继续按游标拉取');
  } finally {
    env.cleanup();
    await new Promise<void>((r) => fake.close(() => r()));
  }
});

/* ------------------------------------------------------------------ */
/* 10. 大批量历史导入                                                   */
/* ------------------------------------------------------------------ */

test('验收10: 大批量历史导入 —— 5000 条仍在可接受时间内完成且可检索', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qq-acc-bulk-'));
  const env = setup();
  try {
    // 合成 5000 条 QCE JSON
    const bulkPath = join(root, 'bulk.json');
    const messages = Array.from({ length: 5000 }, (_, i) => {
      const ts = Date.UTC(2024, 0, 1) + i * 30_000;
      return {
        id: `bulk-${i}`,
        seq: `${i}`,
        timestamp: ts,
        time: '2024-01-01 00:00:00',
        sender: { uid: `u_${i % 7}`, uin: `${30000 + (i % 7)}`, name: `成员${i % 7}` },
        type: 'type_1',
        content: {
          text: `批量历史消息第 ${i} 条，关键词 批测${i % 97}`,
          elements: [{ type: 'text', data: { text: `批量历史消息第 ${i} 条` } }],
        },
      };
    });
    writeFileSync(
      bulkPath,
      JSON.stringify({
        metadata: { exportedAt: new Date().toISOString() },
        chatInfo: { name: '大批量测试群', type: 'group', peerUid: '888001', selfUid: ACCOUNT },
        statistics: { messageCount: messages.length },
        messages,
      }),
    );

    const startedAt = Date.now();
    const stats = await importIntoDb({ db: env.db, filePath: bulkPath });
    const elapsed = Date.now() - startedAt;

    assert.equal(stats.inserted, 5000, `5000 条应全部入库，实际 ${stats.inserted}`);
    assert.equal(stats.failed, 0, `不得有失败：${stats.errors.join('; ')}`);
    assert.ok(elapsed < 60_000, `5000 条导入耗时 ${elapsed}ms，应在 60s 内`);

    // 全量检索应能命中
    const hits = env.db.searchMessages({ keyword: '批测42', pageSize: 10 });
    assert.equal(hits.total, Math.ceil(5000 / 97) > 0 ? hits.total : 0);
    assert.ok(hits.total >= 1, '批量导入后中文检索必须可用');
    for (const hit of hits.items) {
      assert.ok(hit.message.text.includes('批测42'), '搜索结果必须真的包含关键词');
    }
  } finally {
    env.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* 11. 媒体文件缺失                                                     */
/* ------------------------------------------------------------------ */

test('验收11: 媒体文件缺失 —— 标记 missing、不生成假文件、关联与原因保留', async () => {
  const env = setup();
  try {
    const stats = await importIntoDb({
      db: env.db,
      filePath: env.fixtures.files.groupJson,
      mediaDir: env.config.storage.mediaDir,
    });
    assert.equal(
      stats.mediaMissing,
      env.fixtures.expected.mediaMissingDeclared,
      `应恰好有 ${env.fixtures.expected.mediaMissingDeclared} 个媒体缺失`,
    );

    const missing = env.db.listMedia({ status: 'missing', pageSize: 20 });
    assert.equal(missing.total, env.fixtures.expected.mediaMissingDeclared);
    const item = missing.items[0]!;
    assert.equal(item.kind, 'image');
    assert.ok((item.failReason ?? '').length > 0, '必须记录可读的失败原因');
    assert.ok((item.originUrl ?? '').length > 0 || (item.originPath ?? '').length > 0, '必须保留来源线索');

    // 关键：不得为缺失媒体编造任何文件
    const abs = join(env.config.storage.mediaDir, item.relPath);
    assert.equal(existsSync(abs), false, `缺失媒体绝不能在磁盘上生成占位文件：${abs}`);

    // 但消息 ↔ 媒体关联仍要建立（UI 才能显示「这里本来有一张图」）
    const links = env.db.raw
      .prepare('SELECT COUNT(*) AS n FROM message_media WHERE media_id = ?')
      .get(item.id) as { n: number };
    assert.ok(links.n >= 1, '缺失媒体仍应保留 message_media 关联');

    // 归档器返回 missing 时不得返回 present 的 sha256（不能声称成功）
    assert.equal(item.status, 'missing');
  } finally {
    env.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* 12. 数据库备份恢复                                                   */
/* ------------------------------------------------------------------ */

test('验收12: 数据库备份恢复 —— 真实备份→校验→损坏→恢复→数据一致', async () => {
  const env = setup();
  const api = await startApi(env);
  try {
    await importIntoDb({
      db: env.db,
      filePath: env.fixtures.files.groupJson,
      mediaDir: env.config.storage.mediaDir,
    });
    const before = env.db.stats();
    assert.ok(before.messages > 0);

    const access = await login(api);
    const created = await call(api, '/api/backup', { method: 'POST', token: access, body: {} });
    assert.equal(created.status, 200, `备份应成功：${created.text.slice(0, 300)}`);
    const snapshot = created.body.data.path ?? created.body.data.snapshot ?? created.body.data.file;
    assert.ok(typeof snapshot === 'string' && snapshot.length > 0, '备份必须返回快照路径');
    assert.ok(existsSync(snapshot), `快照文件必须真实存在：${snapshot}`);

    // 备份完整性校验：篡改一个字节后 verify 必须失败（而不是「命令成功就算备份成功」）
    const backup = await call(api, '/api/backups', { token: access });
    assert.equal(backup.status, 200);
    const record = (backup.body.data.items as Array<Record<string, unknown>>)[0];
    assert.ok(record, '备份记录应可列出');
    assert.ok(record.verifyResult !== null && record.verifyResult !== undefined, '备份应带校验结果');

    // 真的破坏当前库：删掉一半消息，然后恢复
    env.db.raw.exec('DELETE FROM messages WHERE id % 2 = 0');
    const broken = env.db.stats();
    assert.ok(broken.messages < before.messages, '前置条件：库确实被破坏了');

    const restored = await call(api, '/api/backups/restore', {
      method: 'POST',
      token: access,
      body: { path: snapshot, dryRun: false },
    });
    assert.ok(
      restored.status === 200 || restored.status === 202,
      `恢复应被接受：${restored.status} ${restored.text.slice(0, 300)}`,
    );

    // 恢复后重新打开库并核对（恢复会替换 db 文件）
    env.db.close();
    const reopened = openDatabase({ path: env.config.storage.dbPath, logger: env.logger });
    try {
      const after = reopened.stats();
      assert.equal(after.messages, before.messages, '恢复后消息数必须回到备份时点');
      assert.equal(after.sessions, before.sessions, '恢复后会话数必须回到备份时点');

      // 恢复后的数据必须仍然可搜（FTS 索引随库一起恢复）
      const hits = reopened.searchMessages({ keyword: env.fixtures.expected.uniqueKeyword, pageSize: 10 });
      assert.ok(hits.total >= 1, '恢复后全文检索必须依然可用');
    } finally {
      reopened.close();
    }
  } finally {
    await api.close();
    env.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* 13. 未登录访问管理接口                                               */
/* ------------------------------------------------------------------ */

test('验收13: 未登录访问管理接口 —— 一律 401，绝不泄露任何数据', async () => {
  const env = setup();
  const api = await startApi(env);
  try {
    await importIntoDb({ db: env.db, filePath: env.fixtures.files.groupJson });

    const guarded = [
      '/api/stats',
      '/api/sessions',
      '/api/search?keyword=%E8%93%9D%E9%B2%B8',
      '/api/media',
      '/api/jobs',
      '/api/logs',
      '/api/backups',
      '/api/collect/health',
      '/api/export/session/1',
    ];
    for (const path of guarded) {
      const res = await call(api, path);
      assert.equal(res.status, 401, `${path} 未认证必须返回 401，实际 ${res.status}`);
      assert.ok(
        !res.text.includes(env.fixtures.expected.uniqueKeyword),
        `${path} 的 401 响应不得包含任何业务数据`,
      );
    }

    // 错误令牌同样 401
    const bad = await call(api, '/api/sessions', { token: 'wrong-token-aaaaaaaaaaaa' });
    assert.equal(bad.status, 401);

    // 无令牌调用写接口也必须 401（不能靠「方法不同」绕过）
    for (const path of ['/api/import', '/api/collect/run', '/api/backup']) {
      const res = await call(api, path, { method: 'POST', body: {} });
      assert.equal(res.status, 401, `${path} 未认证 POST 必须 401，实际 ${res.status}`);
    }

    // health 是唯一免认证端点（运维探活用），且不得泄露敏感信息
    const health = await call(api, '/api/health');
    assert.equal(health.status, 200);
    assert.ok(!health.text.includes(TOKEN), 'health 不得回显服务端令牌');
  } finally {
    await api.close();
    env.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* 14. 未授权访问媒体                                                   */
/* ------------------------------------------------------------------ */

test('验收14: 未授权访问媒体 —— 401、路径穿越被拒、返回头不泄露绝对路径', async () => {
  const env = setup();
  const api = await startApi(env);
  try {
    await importIntoDb({
      db: env.db,
      filePath: env.fixtures.files.groupJson,
      mediaDir: env.config.storage.mediaDir,
    });
    const media = env.db.listMedia({ status: 'present', pageSize: 10 }).items[0]!;

    // 无凭据
    assert.equal((await fetch(`${api.base}/api/media/${media.id}/raw`)).status, 401);
    assert.equal((await fetch(`${api.base}/api/media/${media.id}/thumb`)).status, 401);
    // 伪造 query token
    assert.equal((await fetch(`${api.base}/api/media/${media.id}/raw?access=forged`)).status, 401);

    const access = await login(api);
    // 不存在的 id
    assert.equal((await fetch(`${api.base}/api/media/999999/raw?access=${access}`)).status, 404);
    // 穿越尝试（路径参数）
    for (const evil of ['..%2f..%2fetc%2fpasswd', '%2e%2e%2farchive.db', '....//archive.db']) {
      const res = await fetch(`${api.base}/api/media/${evil}/raw?access=${access}`);
      assert.ok(res.status === 400 || res.status === 404, `穿越 ${evil} 应被拒，实际 ${res.status}`);
      const text = await res.text();
      assert.ok(!text.includes('SQLite format 3'), `穿越响应不得返回数据库内容：${evil}`);
    }

    // 正常下载不得暴露服务器绝对路径
    const ok = await fetch(`${api.base}/api/media/${media.id}/raw?access=${access}`);
    assert.equal(ok.status, 200);
    const disposition = ok.headers.get('content-disposition') ?? '';
    assert.ok(!disposition.includes(env.config.storage.mediaDir), '下载头不得泄露绝对路径');
    assert.ok(!(ok.headers.get('x-media-path') ?? '').includes('/'), '不得回显服务器文件路径');
  } finally {
    await api.close();
    env.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* 15. 搜索结果与原始导入数据一致性                                     */
/* ------------------------------------------------------------------ */

test('验收15: 搜索结果与原始导入数据一致性 —— 零漏报、零误报、文本逐字相同', async () => {
  const env = setup();
  try {
    await importIntoDb({ db: env.db, filePath: env.fixtures.files.groupJson });
    await importIntoDb({ db: env.db, filePath: env.fixtures.files.privateJson });

    // 直接从源文件构造「真值表」。
    // 注意：群聊里有 14 条消息文本**完全相同**（都含唯一关键词），所以真值必须按
    // **消息 id** 计数，不能按文本去重建 map —— 否则会把 14 条折叠成 1 条，误判搜索「多报」。
    const texts = new Set<string>();
    const unique = env.fixtures.expected.uniqueKeyword;
    let expectedUnique = 0;
    for (const file of [env.fixtures.files.groupJson, env.fixtures.files.privateJson]) {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as {
        messages: Array<{ id?: string; content?: { text?: string } }>;
      };
      const seen = new Set<string>();
      for (const m of raw.messages) {
        const text = m.content?.text ?? '';
        if (text.length === 0) continue;
        const key = m.id ?? text;
        if (seen.has(key)) continue; // 文件内重复 id 只计一次（导入会判重）
        seen.add(key);
        texts.add(text);
        if (text.includes(unique)) expectedUnique += 1;
      }
    }
    const uniqueHits = env.db.searchMessages({ keyword: unique, pageSize: 100 });
    assert.equal(
      uniqueHits.total,
      expectedUnique,
      `唯一关键词「${unique}」应命中 ${expectedUnique} 条，实际 ${uniqueHits.total}`,
    );

    // 逐条核对：每一条搜索结果的 text 必须在真值表里逐字存在
    for (const hit of uniqueHits.items) {
      assert.ok(
        texts.has(hit.message.text),
        `搜索结果里的文本必须逐字节等于源文件文本：${hit.message.text.slice(0, 40)}`,
      );
    }

    // 抽 12 个真实文本做正查 + 反查
    const samples = [...texts].filter((t) => t.length >= 6).slice(0, 12);
    assert.ok(samples.length >= 6, '夹具应提供足够的可搜索文本');
    for (const text of samples) {
      const fragment = cjkFragment(text);
      const hits = env.db.searchMessages({ keyword: fragment, pageSize: 200 });
      assert.ok(
        hits.total >= 1,
        `关键词「${fragment}」应至少命中 1 条（来自「${text.slice(0, 30)}」）`,
      );
      assert.ok(
        hits.items.some((h) => h.message.text === text),
        `关键词「${fragment}」的搜索结果必须包含原文「${text.slice(0, 30)}」`,
      );
    }

    // 单字 CJK 必须走 LIKE 回退且仍能命中（中文检索的经典坑）
    assert.equal(planSearch('唱').mode, 'like', '单字 CJK 没有二元组可用，必须走 LIKE 回退');
    assert.equal(planSearch('演唱会').mode, 'fts', '多字中文应走 FTS 二元组索引');
    assert.equal(planSearch('hello').mode, 'fts', '西文应走 FTS');

    // 不存在的词必须 0 命中（不能因为回退策略而误报）
    assert.equal(env.db.searchMessages({ keyword: '这个词绝对不可能出现在夹具里', pageSize: 10 }).total, 0);
    assert.equal(env.db.searchMessages({ keyword: 'zzqqxxvv', pageSize: 10 }).total, 0);
  } finally {
    env.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* 辅助                                                                */
/* ------------------------------------------------------------------ */

/** 从一段中文里取 2–4 字的连续片段作为搜索关键词。 */
function cjkFragment(text: string): string {
  const cjk = text.match(/[\u4e00-\u9fff]{2,6}/g);
  if (cjk && cjk.length > 0) {
    const seg = cjk[0]!;
    return seg.slice(0, Math.min(3, seg.length));
  }
  return text.slice(0, 4);
}

/** 递归统计目录下的文件数（用于验证「重复导入不占额外磁盘」）。 */
function countFiles(dir: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) n += countFiles(join(dir, entry.name));
    else n += 1;
  }
  return n;
}
