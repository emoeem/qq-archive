/**
 * 真实联调测试（Lead 所有）
 *
 * 与 tests/acceptance.test.ts 的区别：
 *   - acceptance 用**本地接线**（测试自己写 onBatch/onMedia 回填）走导入路径；
 *   - 本文件**不注入**任何 importFn / collect runner，强制走 packages/server 里的
 *     `loadImportModule()` / `loadCollectRunner()` 动态探测，也就是**生产环境的真实路径**。
 *
 * 这条路径此前从未被端到端验证过 —— server-dev 只验证到「任务能进入终态（done/failed）」，
 * 而 failed 也是终态。本文件补上「真的导入成功、媒体真的落盘、前端真的能拿到它」。
 *
 * 同时验证 web-dev 提出的风险②：`?access=<token>` 查询认证必须真的生效
 * （媒体缩略图/原图、导出、SSE 都无法携带 Authorization 头）。
 */

import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createLogger, type AppConfig, type ScopedLogger } from '../packages/core/src/index.ts';
import { openDatabase, type Db } from '../packages/db/src/index.ts';
import { createServer, normalizeConfig } from '../packages/server/src/index.ts';
import { generateFixtures, type FixtureResult } from './fixtures/generate.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 真实仓库根：静态前端与动态探测都依赖真实目录结构。 */
const REPO_ROOT = join(HERE, '..');

const TOKEN = 'integration-token-0123456789abcdef';

/* ------------------------------------------------------------------ */
/* 环境                                                                */
/* ------------------------------------------------------------------ */

interface Env {
  root: string;
  config: AppConfig;
  db: Db;
  logger: ScopedLogger;
  rootLogger: ReturnType<typeof createLogger>;
  fixtures: FixtureResult;
  cleanup(): void;
}

interface Api {
  base: string;
  port: number;
  close(): Promise<void>;
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
  const root = mkdtempSync(join(tmpdir(), 'qq-int-'));
  const config = normalizeConfig(makeConfig(root, collectorBaseUrl));
  for (const dir of [config.storage.mediaDir, config.storage.backupDir, config.storage.logDir]) {
    mkdirSync(dir, { recursive: true });
  }
  const rootLogger = createLogger({ level: 'error', console: false });
  const db = openDatabase({ path: config.storage.dbPath, logger: rootLogger.child('db') });
  const fixtures = generateFixtures({ outDir: join(root, 'fixtures') });
  return {
    root,
    config,
    db,
    logger: rootLogger.child('integration'),
    rootLogger,
    fixtures,
    cleanup(): void {
      try {
        db.close();
      } catch {
        /* 备份恢复会替换/关闭句柄 */
      }
      try {
        rootLogger.close();
      } catch {
        /* 可忽略 */
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** 用真实仓库根启动服务：静态前端与动态探测都走生产路径。 */
async function startApi(env: Env): Promise<Api> {
  const created = createServer({
    config: env.config,
    db: env.db,
    logger: env.logger,
    repoRoot: REPO_ROOT,
    version: 'integration',
    startedAt: Date.now(),
  });
  await new Promise<void>((resolve) => created.server.listen(0, '127.0.0.1', resolve));
  const addr = created.server.address();
  assert.ok(addr !== null && typeof addr === 'object', '服务器必须已绑定端口');
  return {
    base: `http://127.0.0.1:${addr.port}`,
    port: addr.port,
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
  opts: { method?: string; token?: string; body?: unknown } = {},
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
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body, text, headers: res.headers };
}

async function login(api: Api): Promise<string> {
  const res = await call(api, '/api/auth/login', { method: 'POST', body: { token: TOKEN } });
  assert.equal(res.status, 200, `登录应成功：${res.status} ${res.text.slice(0, 200)}`);
  const access = res.body?.data?.accessToken ?? res.body?.data?.token;
  assert.ok(typeof access === 'string' && access.length > 0, '登录响应必须带 accessToken');
  return access as string;
}

/** 轮询任务到终态，返回终态记录。 */
async function waitJob(api: Api, access: string, jobId: number, timeoutMs = 60_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let last: any = null;
  while (Date.now() < deadline) {
    const res = await call(api, `/api/jobs/${jobId}`, { token: access });
    assert.equal(res.status, 200, `查询任务应成功：${res.status} ${res.text.slice(0, 200)}`);
    last = res.body?.data;
    const status = last?.status;
    if (status === 'done' || status === 'failed' || status === 'cancelled') return last;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.fail(`任务 ${jobId} 在 ${timeoutMs}ms 内没有进入终态，最后状态：${JSON.stringify(last)}`);
}

/* ------------------------------------------------------------------ */
/* 1. 真实导入链路：POST /api/import → 走 loadImportModule() 动态探测   */
/* ------------------------------------------------------------------ */

test('联调1: POST /api/import 走真实动态探测 —— 消息与媒体都真的落库', async () => {
  const env = setup();
  const api = await startApi(env);
  try {
    const access = await login(api);
    const res = await call(api, '/api/import', {
      method: 'POST',
      token: access,
      body: { path: env.fixtures.files.groupJson, accountUid: 'u_self', format: 'qce-json' },
    });
    assert.equal(res.status, 200, `导入请求应被接受：${res.status} ${res.text.slice(0, 300)}`);
    const jobId = res.body?.data?.jobId;
    assert.ok(typeof jobId === 'number', '导入应创建一个任务');

    const job = await waitJob(api, access, jobId);
    assert.equal(
      job.status,
      'done',
      `导入任务必须真的成功（failed 也是终态，但那就说明 server 与 import 的调用契约没对齐）：${JSON.stringify(job).slice(0, 500)}`,
    );
    const expected =
      env.fixtures.expected.groupMessages - env.fixtures.expected.duplicateInFile;
    assert.equal(job.inserted, expected, `任务应记录 inserted=${expected}，实际 ${job.inserted}`);
    assert.equal(job.failed, 0, `不得有失败记录：${JSON.stringify(job.stats?.errors ?? []).slice(0, 300)}`);

    // 库里的真实行数
    assert.equal(env.db.stats().messages, expected, '数据库里消息数应与任务一致');
    const sessions = await call(api, '/api/sessions?chatType=group', { token: access });
    assert.equal(sessions.status, 200);
    assert.equal(sessions.body.data.items.length, 1, '应有 1 个群聊会话');

    // 媒体：必须真的归档（server 若不把 mediaDir 传下去，这里会是 0 present / 全部 missing）
    const mediaStats = env.db.mediaStats();
    assert.equal(
      mediaStats.present,
      5,
      `应归档 5 个媒体（6 个文件里 2 个内容相同去重）。实际 present=${mediaStats.present} missing=${mediaStats.missing}`,
    );
    assert.equal(mediaStats.missing, env.fixtures.expected.mediaMissingDeclared);
    for (const item of env.db.listMedia({ status: 'present', pageSize: 50 }).items) {
      const abs = join(env.config.storage.mediaDir, item.relPath);
      assert.ok(existsSync(abs), `present 媒体必须真实存在：${abs}`);
      assert.equal(statSync(abs).size, item.size, 'size 必须与磁盘一致');
    }
  } finally {
    await api.close();
    env.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* 2. ?access= 查询认证：媒体原件/缩略图/导出/SSE 都要能用               */
/* ------------------------------------------------------------------ */

test('联调2: ?access= 查询认证 —— 前端在无法带请求头时仍能取到媒体与导出', async () => {
  const env = setup();
  const api = await startApi(env);
  try {
    const access = await login(api);

    // 先经真实导入链路灌数据
    const imp = await call(api, '/api/import', {
      method: 'POST',
      token: access,
      body: { path: env.fixtures.files.groupJson, accountUid: 'u_self' },
    });
    const job = await waitJob(api, access, imp.body.data.jobId);
    assert.equal(job.status, 'done', `导入必须成功：${JSON.stringify(job).slice(0, 300)}`);

    const media = env.db.listMedia({ status: 'present', kind: 'image', pageSize: 5 }).items[0];
    assert.ok(media, '应有可用的图片媒体');
    const q = `access=${encodeURIComponent(access)}`;

    // 无凭据 / 伪造凭据必须 401（查询令牌不是免死金牌）
    assert.equal((await fetch(`${api.base}/api/media/${media.id}/raw`)).status, 401);
    assert.equal((await fetch(`${api.base}/api/media/${media.id}/raw?access=bogus`)).status, 401);

    // 正确查询令牌：原图 200 + 缩略图 200
    const raw = await fetch(`${api.base}/api/media/${media.id}/raw?${q}`);
    assert.equal(raw.status, 200, '缩略图与原件必须支持 ?access= 查询认证');
    assert.ok(Number(raw.headers.get('content-length') ?? '0') > 0);
    const thumb = await fetch(`${api.base}/api/media/${media.id}/thumb?${q}`);
    assert.ok(
      thumb.status === 200 || thumb.status === 404,
      `缩略图应 200（或未生成时 404），实际 ${thumb.status}`,
    );

    // 导出：<a download> 无法带请求头，必须靠 ?access=
    const sessionId = (await call(api, '/api/sessions?chatType=group', { token: access })).body.data
      .items[0].id;
    for (const format of ['json', 'jsonl', 'txt']) {
      const exp = await fetch(
        `${api.base}/api/export/session/${sessionId}?format=${format}&${q}`,
      );
      assert.equal(exp.status, 200, `导出 ${format} 必须支持 ?access=`); 
      const text = await exp.text();
      assert.ok(text.length > 0, `导出 ${format} 不得为空`);
      if (format === 'jsonl') {
        const lines = text.trim().split('\n');
        assert.ok(lines.length >= 1, 'jsonl 导出应逐行');
        for (const line of lines) JSON.parse(line);
      }
      if (format === 'json') JSON.parse(text);
    }
    assert.equal(
      (await fetch(`${api.base}/api/export/session/${sessionId}?format=json`)).status,
      401,
      '没有凭据的导出必须 401',
    );
  } finally {
    await api.close();
    env.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* 3. SSE 任务进度（EventSource 也无法带请求头）                         */
/* ------------------------------------------------------------------ */

test('联调3: GET /api/jobs/:id/events —— SSE 真实推送并在终态收尾', async () => {
  const env = setup();
  const api = await startApi(env);
  try {
    const access = await login(api);
    const imp = await call(api, '/api/import', {
      method: 'POST',
      token: access,
      body: { path: env.fixtures.files.privateJson, accountUid: 'u_self' },
    });
    const jobId = imp.body.data.jobId as number;

    const res = await fetch(`${api.base}/api/jobs/${jobId}/events?access=${encodeURIComponent(access)}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    assert.ok(res.body !== null, 'SSE 响应应有流');

    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const deadline = Date.now() + 30_000;
    let terminal = false;
    while (Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((r) =>
          setTimeout(() => r({ done: true, value: undefined }), 5_000),
        ),
      ]);
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      if (/"status"\s*:\s*"(done|failed|cancelled)"/.test(buf)) {
        terminal = true;
        break;
      }
    }
    await reader.cancel().catch(() => undefined);
    assert.ok(terminal, `SSE 必须至少推送一次终态事件，实际收到：${buf.slice(0, 400)}`);
    assert.match(buf, /"status"\s*:\s*"done"/, `真实导入应完成：${buf.slice(0, 400)}`);
  } finally {
    await api.close();
    env.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* 4. 真实采集链路：POST /api/collect/run → loadCollectRunner() 探测     */
/* ------------------------------------------------------------------ */

test('联调4: POST /api/collect/run 走真实 createCollectRunner 探测 —— OneBot 消息真的落库', async () => {
  // 假 OneBot：只实现 runner 需要的只读接口
  const calls: string[] = [];
  const fake: Server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    calls.push(url.pathname.replace(/^\//, ''));
    const action = url.pathname.replace(/^\/?/, '') || url.searchParams.get('action') || '';
    const json = (body: unknown): void => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (action === 'get_login_info') return json({ status: 'ok', retcode: 0, data: { user_id: 10001, nickname: '我' } });
    if (action === 'get_group_list') {
      return json({ status: 'ok', retcode: 0, data: [{ group_id: 555, group_name: '联调群' }] });
    }
    if (action === 'get_friend_list') return json({ status: 'ok', retcode: 0, data: [] });
    if (action === 'get_group_msg_history') {
      // 必须是**当前时间附近**的消息：runner 的窗口是
      // `since = max(cursor − lookbackSec, now − initialBackfillDays)`，
      // 用固定历史时间戳会被窗口过滤掉，导致「采集成功但 0 条入库」的假绿。
      const ts = Math.floor(Date.now() / 1000) - 60;
      return json({
        status: 'ok',
        retcode: 0,
        data: {
          messages: [
            { message_id: 900001, time: ts, message_type: 'group', group_id: 555, user_id: 20001, sender: { user_id: 20001, nickname: '张三' }, raw_message: '联调第一条', message: [{ type: 'text', data: { text: '联调第一条' } }] },
            { message_id: 900002, time: ts + 1, message_type: 'group', group_id: 555, user_id: 20002, sender: { user_id: 20002, nickname: '李四' }, raw_message: '联调第二条', message: [{ type: 'text', data: { text: '联调第二条' } }] },
          ],
        },
      });
    }
    return json({ status: 'ok', retcode: 0, data: null });
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  const fakePort = (fake.address() as { port: number }).port;

  const env = setup(`http://127.0.0.1:${fakePort}`);
  const api = await startApi(env);
  try {
    const access = await login(api);

    // 采集健康检查必须先认出真实模块（不是 stub）
    const health = await call(api, '/api/collect/health', { token: access });
    assert.equal(health.status, 200, `采集健康检查应成功：${health.text.slice(0, 300)}`);

    const res = await call(api, '/api/collect/run', { method: 'POST', token: access, body: {} });
    assert.equal(res.status, 200, `采集请求应被接受：${res.status} ${res.text.slice(0, 300)}`);
    const job = await waitJob(api, access, res.body.data.jobId);
    assert.equal(job.status, 'done', `采集任务必须成功：${JSON.stringify(job).slice(0, 400)}`);

    assert.equal(env.db.stats().messages, 2, '两条 OneBot 消息必须真的落库');
    const hits = env.db.searchMessages({ keyword: '联调', pageSize: 10 });
    assert.equal(hits.total, 2, '采集来的消息必须可被中文检索命中');
    assert.ok(calls.includes('get_group_msg_history'), `必须真的调用过历史接口，实际：${calls.join(',')}`);

    // 游标必须持久化（重启后才能续传而不是重拉）
    const states = env.db.listCollectStates();
    assert.ok(states.length >= 1, '采集游标必须已持久化');
  } finally {
    await api.close();
    env.cleanup();
    await new Promise<void>((r) => fake.close(() => r()));
  }
});

/* ------------------------------------------------------------------ */
/* 5. 静态前端真的由 server 提供                                        */
/* ------------------------------------------------------------------ */

test('联调5: 静态前端由 server 真实托管 —— index.html/app.js/style.css 都可取', async () => {
  const env = setup();
  const api = await startApi(env);
  try {
    for (const [path, expectType] of [
      ['/', 'text/html'],
      ['/index.html', 'text/html'],
      ['/app.js', 'javascript'],
      ['/lib.js', 'javascript'],
      ['/style.css', 'text/css'],
    ] as const) {
      const res = await fetch(`${api.base}${path}`);
      assert.equal(res.status, 200, `${path} 应 200，实际 ${res.status}`);
      assert.match(
        res.headers.get('content-type') ?? '',
        new RegExp(expectType),
        `${path} 的 Content-Type 应为 ${expectType}`,
      );
      assert.ok((await res.text()).length > 0, `${path} 不得为空`);
    }
    // 深路由必须回退 index.html（hash 路由刷新不能 404）
    const deep = await fetch(`${api.base}/chats`);
    assert.equal(deep.status, 200);
    assert.match(deep.headers.get('content-type') ?? '', /text\/html/);

    // 仓库文件不得被静态服务泄露
    for (const bad of ['/package.json', '/tsconfig.json', '/../package.json', '/web/../package.json']) {
      const res = await fetch(`${api.base}${bad}`);
      assert.ok(res.status === 404 || res.status === 403, `${bad} 不得可读，实际 ${res.status}`);
    }
  } finally {
    await api.close();
    env.cleanup();
  }
});
