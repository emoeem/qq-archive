/**
 * `/api/napcat/*` 四条路由的 HTTP 契约测试。
 *
 * 为什么需要这一层：`tests/napcat.test.ts` 直接调 `NapCatWebUi`，`tests/napcat-login-e2e.test.ts`
 * 走 CLI 子进程——**两条路都不经过服务端路由**，于是「网页点扫码」这条路上真正的一段代码没人测。
 *
 * 本文件里最关键的一条断言是安全性的：**二维码 URL 是登录凭据，绝不能出现在 JSON 响应里**。
 * 这条断言无法靠「检查字段名」完成（那样只要字段改名就会误判为通过），因此这里把服务端下发的
 * PNG **逐像素解开**，与 `encodeQr(真实 URL)` 的模块矩阵逐模块比对——
 * 既证明「响应里没有 URL 明文」，又证明「图里编的确实是那个 URL」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import type { AppConfig } from '../packages/core/src/index.ts';
import { createLogger } from '../packages/core/src/index.ts';
import { openDatabase } from '../packages/db/src/index.ts';
import { createServer } from '../packages/server/src/index.ts';
import { encodeQr } from '../packages/qr/src/index.ts';
import {
  FAKE_NAPCAT_ACCOUNTS,
  FAKE_NAPCAT_QR_URL,
  FAKE_NAPCAT_TOKEN,
  startFakeNapCat,
  type FakeNapCat,
} from './fixtures/napcat.ts';

const PANEL_TOKEN = 'test-token-0123456789abcdef';
/** 与 packages/server/src/index.ts 里生成二维码时的参数保持一致。 */
const QR_SCALE = 6;
const QR_MARGIN = 4;

interface ApiResult {
  status: number;
  body: unknown;
  text: string;
}

interface Booted {
  base: string;
  api: (method: string, path: string, opts?: { auth?: boolean; body?: unknown }) => Promise<ApiResult>;
  close: () => Promise<void>;
}

function makeConfig(root: string, webuiPort?: number): AppConfig {
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const config: AppConfig = {
    server: {
      host: '127.0.0.1',
      port: 0,
      token: PANEL_TOKEN,
      sessionTtlSec: 3600,
      allowDownload: true,
      exportMaxMessages: 1000,
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
      syncMedia: true,
      maxMediaBytes: 512 * 1024 * 1024,
      discoverSessions: true,
      sessions: [],
    },
  };
  if (webuiPort !== undefined) {
    config.collector.napcat = {
      webuiUrl: `http://127.0.0.1:${webuiPort}`,
      token: FAKE_NAPCAT_TOKEN,
      // 夹具监听在随机端口上：只探 1 个端口，避免为此扫 20 个端口
      probeRange: 1,
    };
  }
  return config;
}

async function boot(root: string, webuiPort?: number): Promise<Booted> {
  const config = makeConfig(root, webuiPort);
  const db = openDatabase({ path: config.storage.dbPath });
  const logger = createLogger({ console: false });
  // 静态托管需要一个存在的 repoRoot（内含 web/）；本文件不测静态资源，但 ServerOptions 要求它
  const repoRoot = join(root, 'repo');
  mkdirSync(join(repoRoot, 'web'), { recursive: true });
  writeFileSync(join(repoRoot, 'package.json'), '{"name":"qq-archive-test"}');
  const created = createServer({
    config,
    db,
    logger: logger.child('napcat-routes'),
    repoRoot,
    version: '0.1.0-test',
    startedAt: Date.now(),
  });
  await new Promise<void>((done) => created.server.listen(0, '127.0.0.1', () => done()));
  const port = (created.server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  let token = '';
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: PANEL_TOKEN }),
  });
  const loginBody = (await login.json()) as { data?: { accessToken?: string } };
  token = loginBody.data?.accessToken ?? '';
  assert.ok(token !== '', '登录必须拿到 accessToken');

  return {
    base,
    async api(method, path, opts = {}) {
      const headers: Record<string, string> = {};
      if (opts.auth !== false) headers.Authorization = `Bearer ${token}`;
      let payload: string | undefined;
      if (opts.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(opts.body);
      }
      const res = await fetch(`${base}${path}`, { method, headers, ...(payload === undefined ? {} : { body: payload }) });
      const text = await res.text();
      let body: unknown = null;
      try {
        body = JSON.parse(text);
      } catch {
        /* 非 JSON 响应（本文件里不应出现） */
      }
      return { status: res.status, body, text };
    },
    async close() {
      await created.close();
      await logger.close();
      try {
        db.close();
      } catch {
        /* ignore */
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/* PNG 逐像素解码（位深 1、颜色类型 0、每行 1 字节滤波器）              */
/* ------------------------------------------------------------------ */

interface DecodedPng {
  width: number;
  height: number;
  /** 像素是否为深色（黑）。 */
  isDark: (px: number, py: number) => boolean;
}

function decodeGrayscale1BitPng(bytes: Uint8Array): DecodedPng {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < signature.length; i++) assert.equal(bytes[i], signature[i], 'PNG 签名不符');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat: Uint8Array[] = [];
  let sawIhdr = false;
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(bytes[offset + 4]!, bytes[offset + 5]!, bytes[offset + 6]!, bytes[offset + 7]!);
    const dataStart = offset + 8;
    const data = bytes.subarray(dataStart, dataStart + length);
    if (type === 'IHDR') {
      sawIhdr = true;
      width = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0);
      height = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(4);
      assert.equal(data[8], 1, '位深必须是 1');
      assert.equal(data[9], 0, '颜色类型必须是灰度');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset = dataStart + length + 4;
  }
  assert.ok(sawIhdr, '缺少 IHDR');
  const inflated = new Uint8Array(inflateSync(Buffer.concat(idat.map((d) => Buffer.from(d)))));
  const rowBytes = Math.ceil(width / 8);
  assert.equal(inflated.length, (rowBytes + 1) * height, '解压后的扫描行长度不符');
  return {
    width,
    height,
    isDark(px, py) {
      assert.ok(px >= 0 && px < width && py >= 0 && py < height, `像素越界 (${px},${py})`);
      const rowStart = py * (rowBytes + 1);
      assert.equal(inflated[rowStart], 0, '本渲染器只用滤波器 0');
      const bit = (inflated[rowStart + 1 + (px >>> 3)]! >>> (7 - (px & 7))) & 1;
      return bit === 0; // 1 = 白，0 = 黑
    },
  };
}

/* ------------------------------------------------------------------ */
/* 测试                                                                */
/* ------------------------------------------------------------------ */

test('/api/napcat/*：未认证一律 401，且响应体不含任何凭据', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qq-napcat-routes-'));
  const fake = await startFakeNapCat();
  const app = await boot(root, fake.port);
  try {
    for (const [method, path] of [
      ['GET', '/api/napcat/status'],
      ['POST', '/api/napcat/qrcode'],
      ['GET', '/api/napcat/accounts'],
      ['POST', '/api/napcat/quick-login'],
    ] as const) {
      const r = await app.api(method, path, { auth: false, body: method === 'POST' ? { uin: '10001' } : undefined });
      assert.equal(r.status, 401, `${method} ${path} 未认证应为 401`);
      assert.ok(!r.text.includes(FAKE_NAPCAT_TOKEN), '401 响应体不得泄露 token');
      assert.ok(!r.text.includes('cred-'), '401 响应体不得泄露凭据');
    }
  } finally {
    await app.close();
    await fake.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('/api/napcat/*：未配置时如实报告「未配置」，不伪造成接口故障', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qq-napcat-routes-'));
  const app = await boot(root); // 无 collector.napcat
  try {
    const status = await app.api('GET', '/api/napcat/status');
    assert.equal(status.status, 200, '未配置不是 HTTP 错误');
    const data = (status.body as { data: Record<string, unknown> }).data;
    assert.equal(data['configured'], false);
    assert.equal(data['connected'], false);
    assert.equal(data['isLogin'], false);
    assert.match(String(data['error']), /napcat/i, '必须给出可操作的引导信息');

    // 一旦要真的去取码，就必须明确失败（503），不能返回 null 让前端显示空白二维码
    const qr = await app.api('POST', '/api/napcat/qrcode');
    assert.equal(qr.status, 503);
    assert.equal((qr.body as { code: string }).code, 'NAPCAT_UNAVAILABLE');
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('/api/napcat/status：连上 NapCat 后报告 connected/baseUrl/isLogin，且不泄露任何凭据', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qq-napcat-routes-'));
  const fake = await startFakeNapCat();
  const app = await boot(root, fake.port);
  try {
    const r = await app.api('GET', '/api/napcat/status');
    assert.equal(r.status, 200);
    const data = (r.body as { data: Record<string, unknown> }).data;
    assert.equal(data['configured'], true);
    assert.equal(data['connected'], true);
    assert.equal(data['isLogin'], false);
    assert.equal(data['uin'], null);
    assert.equal(data['error'], null);
    assert.match(String(data['baseUrl']), new RegExp(`:${fake.port}$`), 'baseUrl 应指向实际连通的那个端口');
    assert.ok(!r.text.includes(FAKE_NAPCAT_TOKEN), '状态响应不得泄露 WebUI token');
    assert.ok(!r.text.includes('cred-'), '状态响应不得泄露 Credential');
  } finally {
    await app.close();
    await fake.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('/api/napcat/qrcode：只下发 PNG；URL 明文不出现在响应里，但图中编的正是该 URL', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qq-napcat-routes-'));
  const fake = await startFakeNapCat();
  const app = await boot(root, fake.port);
  try {
    const r = await app.api('POST', '/api/napcat/qrcode');
    assert.equal(r.status, 200);
    const data = (r.body as { data: Record<string, unknown> }).data;
    assert.equal(data['isLogin'], false);
    assert.equal(data['field'], 'qrcode');
    const png = data['png'];
    assert.equal(typeof png, 'string');
    assert.ok((png as string).startsWith('data:image/png;base64,'), '只以 PNG data URL 下发');

    // ① 安全性：URL 明文（及其任何片段）不得出现在响应体里
    assert.ok(!r.text.includes(FAKE_NAPCAT_QR_URL), '二维码 URL 是登录凭据，绝不能出现在 JSON 里');
    assert.ok(!r.text.includes('example.com'), '连主机名也不应出现');
    assert.ok(!r.text.includes(FAKE_NAPCAT_TOKEN));

    // ② 正确性：把 PNG 逐像素解开，与「服务端应编的那个 URL」逐模块比对
    const bytes = Buffer.from((png as string).slice('data:image/png;base64,'.length), 'base64');
    const img = decodeGrayscale1BitPng(new Uint8Array(bytes));
    const expected = encodeQr(FAKE_NAPCAT_QR_URL, { ecc: 'M' });
    assert.equal(img.width, (expected.size + QR_MARGIN * 2) * QR_SCALE, '像素尺寸应等于 (模块数+2×静区)×scale');
    assert.equal(img.height, img.width);
    let compared = 0;
    for (let my = -QR_MARGIN; my < expected.size + QR_MARGIN; my++) {
      for (let mx = -QR_MARGIN; mx < expected.size + QR_MARGIN; mx++) {
        const wantDark = mx >= 0 && my >= 0 && mx < expected.size && my < expected.size
          ? expected.modules[my * expected.size + mx] !== 0
          : false;
        // 取每个模块左上角那个像素（同一模块内 scale×scale 个像素应该一致）。
        // 像素坐标要整体加上静区偏移：(模块坐标 + margin) × scale
        const gotDark = img.isDark((mx + QR_MARGIN) * QR_SCALE, (my + QR_MARGIN) * QR_SCALE);
        assert.equal(gotDark, wantDark, `模块 (${mx},${my}) 明暗不符`);
        compared += 1;
      }
    }
    assert.equal(compared, (expected.size + QR_MARGIN * 2) ** 2, '应逐模块比对完整矩阵');
  } finally {
    await app.close();
    await fake.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('/api/napcat/qrcode：已登录时不下发二维码', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qq-napcat-routes-'));
  const fake = await startFakeNapCat({ alreadyLoggedIn: true });
  const app = await boot(root, fake.port);
  try {
    const r = await app.api('POST', '/api/napcat/qrcode');
    assert.equal(r.status, 200);
    const data = (r.body as { data: Record<string, unknown> }).data;
    assert.equal(data['isLogin'], true);
    assert.equal(data['uin'], '10001');
    assert.equal(data['png'], null, '已登录时不应再生成二维码');
    assert.equal(fake.trace.filter((t) => t.path === '/api/QQLogin/GetQQLoginQrcode').length, 0, '不该去请求二维码');
  } finally {
    await app.close();
    await fake.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('/api/napcat/accounts：原样上报可用/不可用账号，不把不可用账号丢掉', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qq-napcat-routes-'));
  const fake = await startFakeNapCat();
  const app = await boot(root, fake.port);
  try {
    const r = await app.api('GET', '/api/napcat/accounts');
    assert.equal(r.status, 200);
    const accounts = (r.body as { data: { accounts: Array<Record<string, unknown>> } }).data.accounts;
    assert.equal(accounts.length, 2);
    assert.deepEqual(
      accounts.map((a) => [a['uin'], a['isQuickLogin']]),
      FAKE_NAPCAT_ACCOUNTS.map((a) => [a.uin, a.isQuickLogin]),
    );
    assert.equal(accounts[0]?.['nickname'], '测试账号甲');
    assert.equal(accounts[1]?.['nickname'], '测试账号乙');
  } finally {
    await app.close();
    await fake.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('/api/napcat/quick-login：合法 uin 透传结果；非法/缺失 uin 是 400 而不是 503', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qq-napcat-routes-'));
  const fake = await startFakeNapCat();
  const app = await boot(root, fake.port);
  try {
    const ok = await app.api('POST', '/api/napcat/quick-login', { body: { uin: '10001' } });
    assert.equal(ok.status, 200);
    const okData = (ok.body as { data: Record<string, unknown> }).data;
    assert.equal(okData['ok'], true);
    assert.equal(okData['uin'], '10001');
    const setCalls = fake.trace.filter((t) => t.path === '/api/QQLogin/SetQuickLogin');
    assert.equal(setCalls.length, 1, '应真的调用 SetQuickLogin');
    assert.equal(setCalls[0]?.body['uin'], 10001, 'uin 必须是数字，NapCat 不接受字符串');

    // 参数问题必须在调 NapCat 之前就被拦住：这里是 400，不是 503
    for (const bad of [{}, { uin: '12' }, { uin: 'abc' }, { uin: '一零零零一' }]) {
      const r = await app.api('POST', '/api/napcat/quick-login', { body: bad });
      assert.equal(r.status, 400, `uin=${JSON.stringify(bad)} 应为 400`);
      assert.equal((r.body as { code: string }).code, 'BAD_REQUEST');
    }
    assert.equal(fake.trace.filter((t) => t.path === '/api/QQLogin/SetQuickLogin').length, 1, '非法参数不得触达 NapCat');
  } finally {
    await app.close();
    await fake.close();
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * 回归：错误映射必须把**真实**的 status/code 透出去。
 *
 * 曾经的实现写成 `const code = typeof obj?.code`，于是 code 恒为字符串 "string"、
 * status 恒非 number ⇒ 所有下游错误都被压成 `503 {code:"string"}`：
 * token 写错本该是 401 UNAUTHORIZED，却被报成「服务不可用」，前端引导文案全错。
 * 这两条用例分别覆盖「端口不可达（COLLECTOR_UNAVAILABLE）」与「token 错（UNAUTHORIZED）」。
 */
test('/api/napcat/qrcode：NapCat 连不上时是 503 COLLECTOR_UNAVAILABLE，不是 503 code:"string"', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qq-napcat-routes-'));
  // 选一个几乎不可能被占用的端口，并只探 1 个端口 ⇒ 必然连不上
  const app = await boot(root, 1);
  try {
    const r = await app.api('POST', '/api/napcat/qrcode');
    assert.equal(r.status, 503);
    const body = r.body as { code: string; error: string };
    assert.equal(body.code, 'COLLECTOR_UNAVAILABLE', '不得退化成类型名或泛化错误码');
    assert.notEqual(body.code, 'string', '错误码曾被写成 JS 类型名，这是回归点');
    assert.match(body.error, /NapCat WebUI 端口/, '必须给出可操作的处置信息');
    // status 路由即便连不上也应是 200（配置问题不是接口故障）
    const status = await app.api('GET', '/api/napcat/status');
    assert.equal(status.status, 200);
    const data = (status.body as { data: Record<string, unknown> }).data;
    assert.equal(data['configured'], true);
    assert.equal(data['connected'], false);
    assert.match(String(data['error']), /NapCat WebUI 端口/);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('/api/napcat/qrcode：WebUI token 写错时是 401 UNAUTHORIZED，且提示指向 collector.napcat.token', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qq-napcat-routes-'));
  // 服务端只认 'another-token'，而配置里填的是夹具默认 token ⇒ 认证失败
  const fake = await startFakeNapCat({ token: 'another-token' });
  const app = await boot(root, fake.port);
  try {
    const r = await app.api('POST', '/api/napcat/qrcode');
    assert.equal(r.status, 401, 'token 错是认证问题，不是 503');
    const body = r.body as { code: string; error: string };
    assert.equal(body.code, 'UNAUTHORIZED');
    assert.match(body.error, /collector\.napcat\.token/, '必须告诉用户去改哪个配置项');
    assert.ok(!r.text.includes('another-token'), '错误信息不得回显服务端 token');
    assert.ok(!r.text.includes('cred-'), '错误信息不得泄露凭据');

    const accounts = await app.api('GET', '/api/napcat/accounts');
    assert.equal(accounts.status, 401);
    assert.equal((accounts.body as { code: string }).code, 'UNAUTHORIZED');

    const quick = await app.api('POST', '/api/napcat/quick-login', { body: { uin: '10001' } });
    assert.equal(quick.status, 401);
  } finally {
    await app.close();
    await fake.close();
    rmSync(root, { recursive: true, force: true });
  }
});
