/**
 * packages/collect 的 NapCat WebUI 适配器测试（扫码登录 / 快捷登录）。
 *
 * 全程使用**本地假 NapCat WebUI 服务器**（node:http，端口 0），绝不访问真实 QQ 或真实 NapCat：
 *  - 校验登录口令哈希、Bearer 凭据、鉴权失效后自动重认证、端口自增探测；
 *  - 校验二维码字段回退、登录状态解析、快捷登录新旧接口与错误语义；
 *  - 校验 token / 凭据 / 二维码 URL **不会写进日志**。
 *
 * 假服务器刻意模仿 NapCat 的两条易错行为：
 *  1. 鉴权失败时返回 HTTP 200 + `{code:-1, message:'Unauthorized'}`（而不是 401）；
 *  2. 快取登录列表在旧版本走 `/api/QQLogin/GetQuickLoginList`，且可能返回裸 uin 字符串。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { AppError, createLogger } from '../packages/core/src/index.ts';
import {
  NapCatWebUi,
  napcatWebUiPasswordHash,
  NAPCAT_DEFAULT_WEBUI_URL,
} from '../packages/collect/src/index.ts';

const TOKEN = 'unit-test-token';
/** `sha256('unit-test-token' + '.napcat')` 的小写 hex，用独立实现固定住（防止哈希算法被改坏）。 */
const TOKEN_HASH = '46332ad7850e52d87bea1f77fb16405ec5b7c76faf739d1534dd46ab4e49cccd';
const QR_URL = 'https://q.qq.com/qrcode?token=SECRET-QR-PAYLOAD';

/* ------------------------------------------------------------------ */
/* 假 NapCat WebUI 服务器                                               */
/* ------------------------------------------------------------------ */

type QuickListMode = 'new' | 'legacy' | 'error' | 'null';

class FakeNapCat {
  readonly server: Server;
  port = 0;

  token = TOKEN;
  credential = 'cred-abc123';
  /** 登录成功后，第一次受保护请求返回 Unauthorized（模拟 NapCat 重启/凭据失效）。 */
  expireCredentialOnce = false;
  private expired = false;

  loginAttempts = 0;
  hashSeen: string[] = [];
  authHeaders: string[] = [];
  protectedCalls = 0;
  setQuickLoginBodies: unknown[] = [];

  /** GetQQLoginQrcode 里二维码字段名；'none' 表示该接口不返回二维码（走回退链）。 */
  qrcodeField: 'qrcodeurl' | 'qrcode' | 'none' = 'qrcodeurl';
  statusMode: 'qr' | 'loggedIn' = 'qr';
  statusQrcodeUrl = QR_URL;
  quickListMode: QuickListMode = 'new';
  setQuickLoginMode: 'ok' | 'already' = 'ok';

  constructor() {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
  }

  async listen(): Promise<number> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const addr = this.server.address();
    this.port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    return this.port;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const parse = (): Record<string, unknown> => {
      try {
        const v: unknown = JSON.parse(text);
        return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
      } catch {
        return {};
      }
    };

    if (path === '/api/auth/login') {
      this.loginAttempts++;
      const hash = String(parse()['hash'] ?? '');
      this.hashSeen.push(hash);
      if (hash !== napcatWebUiPasswordHash(this.token)) {
        // NapCat 用「200 + 业务错误码」表达密码错误
        json(200, { code: -1, message: '密码错误' });
        return;
      }
      json(200, { code: 0, data: { Credential: this.credential } });
      return;
    }

    const auth = req.headers['authorization'];
    this.authHeaders.push(typeof auth === 'string' ? auth : '');
    this.protectedCalls++;
    if (this.expireCredentialOnce && !this.expired) {
      this.expired = true;
      json(200, { code: -1, message: 'Unauthorized' });
      return;
    }
    if (auth !== `Bearer ${this.credential}`) {
      json(200, { code: -1, message: 'Unauthorized' });
      return;
    }

    if (path === '/api/QQLogin/GetQQLoginQrcode') {
      const data: Record<string, unknown> = this.qrcodeField === 'none' ? {} : { [this.qrcodeField]: QR_URL };
      json(200, { code: 0, data });
      return;
    }
    if (path === '/api/QQLogin/CheckLoginStatus') {
      if (this.statusMode === 'loggedIn') {
        json(200, { code: 0, data: { isLogin: true, uin: '10001' } });
      } else {
        json(200, { code: 0, data: { isLogin: false, qrcodeurl: this.statusQrcodeUrl } });
      }
      return;
    }
    if (path === '/api/QQLogin/GetQuickLoginListNew') {
      if (this.quickListMode === 'legacy') {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('Not Found');
        return;
      }
      if (this.quickListMode === 'error') {
        json(200, { code: -1, message: '内部错误' });
        return;
      }
      if (this.quickListMode === 'null') {
        json(200, { code: 0, data: null });
        return;
      }
      json(200, {
        code: 0,
        data: [
          { uin: '10001', nickName: '甲', faceUrl: 'http://127.0.0.1/a.png', isQuickLogin: true },
          '10002',
          { qq: 10003, nick: '丙' },
          { nothing: true },
        ],
      });
      return;
    }
    if (path === '/api/QQLogin/GetQuickLoginList') {
      json(200, { code: 0, data: ['20002'] });
      return;
    }
    if (path === '/api/QQLogin/SetQuickLogin') {
      this.setQuickLoginBodies.push(parse());
      if (this.setQuickLoginMode === 'already') {
        json(200, { code: -1, message: '当前账号(10001)已登录,无法重复登录' });
        return;
      }
      json(200, { code: 0, message: 'success' });
      return;
    }
    json(404, { code: -1, message: `unknown path ${path}` });
  }
}

function clientFor(fake: FakeNapCat, over: Partial<{ probeRange: number; probePort: () => Promise<boolean> }> = {}) {
  return new NapCatWebUi({
    webuiUrl: fake.baseUrl,
    token: TOKEN,
    probeRange: over.probeRange ?? 0,
    timeoutMs: 800,
    connectTimeoutMs: 200,
    ...(over.probePort ? { probePort: over.probePort } : {}),
  });
}

/** 起一个假服务器 + 客户端，测试结束自动清理。 */
async function withFake(
  t: { after: (fn: () => unknown) => void },
  run: (fake: FakeNapCat) => Promise<void>,
  over: Partial<{ probeRange: number }> = {},
): Promise<void> {
  const fake = new FakeNapCat();
  await fake.listen();
  t.after(() => fake.close());
  await run(fake);
  void over;
}

/* ------------------------------------------------------------------ */
/* 口令哈希与默认值                                                      */
/* ------------------------------------------------------------------ */

test('napcatWebUiPasswordHash 与独立计算的 sha256("<token>.napcat") 一致', () => {
  assert.equal(napcatWebUiPasswordHash(TOKEN), TOKEN_HASH);
  assert.match(TOKEN_HASH, /^[0-9a-f]{64}$/);
  // 大小写与后缀都不能被改坏
  assert.notEqual(napcatWebUiPasswordHash(TOKEN), napcatWebUiPasswordHash(TOKEN.toUpperCase()));
  assert.notEqual(napcatWebUiPasswordHash(TOKEN), napcatWebUiPasswordHash(`${TOKEN}.napcat`));
  assert.equal(NAPCAT_DEFAULT_WEBUI_URL, 'http://127.0.0.1:6099');
});

/* ------------------------------------------------------------------ */
/* 连接与探测                                                            */
/* ------------------------------------------------------------------ */

test('connect() 用正确的哈希登录并缓存基址与凭据', async (t) => {
  await withFake(t, async (fake) => {
    const client = clientFor(fake);
    assert.equal(client.authenticated, false);
    assert.equal(client.baseUrl, undefined);

    const base = await client.connect();
    assert.equal(base, fake.baseUrl);
    assert.equal(client.authenticated, true);
    assert.deepEqual(fake.hashSeen, [TOKEN_HASH], '登录请求必须带 sha256(token+".napcat") 的小写 hex');

    // 幂等：再次 connect 不应重复登录
    await client.connect();
    assert.equal(fake.loginAttempts, 1);
  });
});

test('默认端口配置是 6099；端口自增探测能找到真实端口', async (t) => {
  const fake = new FakeNapCat();
  await fake.listen();
  t.after(() => fake.close());

  // 故意把 webuiUrl 指向「假端口 − 1」，让客户端靠 +1 探测到真实端口
  const client = new NapCatWebUi({
    webuiUrl: `http://127.0.0.1:${fake.port - 1}`,
    token: TOKEN,
    probeRange: 2,
    timeoutMs: 800,
    connectTimeoutMs: 200,
  });
  const base = await client.connect();
  assert.equal(base, fake.baseUrl, `应探测到真实端口 ${fake.port}`);
});

test('没有可用端口时抛 COLLECTOR_UNAVAILABLE（提示要启动 NapCat）', async (t) => {
  const probePort = async (): Promise<boolean> => false;
  const client = new NapCatWebUi({
    webuiUrl: 'http://127.0.0.1:59999',
    token: TOKEN,
    probeRange: 1,
    timeoutMs: 300,
    connectTimeoutMs: 100,
    probePort,
  });
  await assert.rejects(
    () => client.connect(),
    (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, 'COLLECTOR_UNAVAILABLE');
      assert.match(err.message, /未发现可用的 NapCat WebUI 端口/);
      return true;
    },
  );
  void t;
});

test('token 不对时抛 UNAUTHORIZED 并指向配置项（不报成端口问题）', async (t) => {
  await withFake(t, async (fake) => {
    fake.token = 'the-real-token';
    const client = clientFor(fake);
    await assert.rejects(
      () => client.connect(),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'UNAUTHORIZED');
        assert.match(err.message, /collector\.napcat\.token/);
        return true;
      },
    );
  });
});

/* ------------------------------------------------------------------ */
/* 二维码与登录状态                                                      */
/* ------------------------------------------------------------------ */

test('getLoginQrcode 解析 qrcodeurl 字段', async (t) => {
  await withFake(t, async (fake) => {
    const client = clientFor(fake);
    const qr = await client.getLoginQrcode();
    assert.equal(qr.url, QR_URL);
    assert.equal(qr.source, 'qrcodeurl');
  });
});

test('getLoginQrcode 支持 qrcode 等其它字段名', async (t) => {
  await withFake(t, async (fake) => {
    fake.qrcodeField = 'qrcode';
    const qr = await clientFor(fake).getLoginQrcode();
    assert.equal(qr.url, QR_URL);
    assert.equal(qr.source, 'qrcode');
  });
});

test('GetQQLoginQrcode 不返回二维码时回退到 CheckLoginStatus', async (t) => {
  await withFake(t, async (fake) => {
    fake.qrcodeField = 'none';
    const qr = await clientFor(fake).getLoginQrcode();
    assert.equal(qr.url, QR_URL);
    assert.equal(qr.source, 'CheckLoginStatus');
  });
});

test('getLoginStatus 解析 isLogin/uin', async (t) => {
  await withFake(t, async (fake) => {
    const client = clientFor(fake);
    const before = await client.getLoginStatus();
    assert.equal(before.isLogin, false);
    assert.equal(before.uin, undefined);
    assert.equal(before.qrcodeUrl, QR_URL);

    fake.statusMode = 'loggedIn';
    const after = await client.getLoginStatus();
    assert.equal(after.isLogin, true);
    assert.equal(after.uin, '10001');
  });
});

/* ------------------------------------------------------------------ */
/* 快捷登录                                                              */
/* ------------------------------------------------------------------ */

test('listQuickLogin 兼容对象与裸 uin 字符串，跳过无法解析项', async (t) => {
  await withFake(t, async (fake) => {
    const accounts = await clientFor(fake).listQuickLogin();
    assert.deepEqual(accounts, [
      { uin: '10001', nickname: '甲', faceUrl: 'http://127.0.0.1/a.png', isQuickLogin: true },
      { uin: '10002' },
      { uin: '10003', nickname: '丙' },
    ]);
  });
});

test('GetQuickLoginListNew 返回 404 时退回旧接口', async (t) => {
  await withFake(t, async (fake) => {
    fake.quickListMode = 'legacy';
    const accounts = await clientFor(fake).listQuickLogin();
    assert.deepEqual(accounts, [{ uin: '20002' }]);
    assert.ok(fake.protectedCalls >= 2);
  });
});

test('code != 0 必须上报，而不是渲染成空列表', async (t) => {
  await withFake(t, async (fake) => {
    fake.quickListMode = 'error';
    await assert.rejects(
      () => clientFor(fake).listQuickLogin(),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'COLLECTOR_UNAVAILABLE');
        assert.match(err.message, /code=-1/);
        return true;
      },
    );
  });
});

test('data 为 null 时明确报错（接口可用但数据异常）', async (t) => {
  await withFake(t, async (fake) => {
    fake.quickListMode = 'null';
    await assert.rejects(() => clientFor(fake).listQuickLogin(), /快捷登录列表为 null/);
  });
});

test('quickLogin 成功时回 ok:true，并把 uin 作为数字上送', async (t) => {
  await withFake(t, async (fake) => {
    const result = await clientFor(fake).quickLogin('10001');
    assert.equal(result.ok, true);
    assert.equal(result.uin, '10001');
    assert.deepEqual(fake.setQuickLoginBodies, [{ uin: 10001 }]);
  });
});

test('quickLogin 遇到「已登录,无法重复登录」时回 ok:false 而不是抛错', async (t) => {
  await withFake(t, async (fake) => {
    fake.setQuickLoginMode = 'already';
    const result = await clientFor(fake).quickLogin('10001');
    assert.equal(result.ok, false);
    if (result.ok) throw new Error('unreachable');
    assert.equal(result.alreadyLoggedIn, true);
    assert.match(result.message, /无法重复登录/);
  });
});

/* ------------------------------------------------------------------ */
/* 鉴权失效自愈                                                          */
/* ------------------------------------------------------------------ */

test('凭据失效后自动重新登录并重试一次', async (t) => {
  await withFake(t, async (fake) => {
    const client = clientFor(fake);
    await client.connect();
    assert.equal(fake.loginAttempts, 1);

    // 下一次受保护请求返回 Unauthorized → 客户端应重新登录并重试
    fake.expireCredentialOnce = true;
    const status = await client.getLoginStatus();
    assert.equal(status.isLogin, false);
    assert.equal(fake.loginAttempts, 2, '应恰好重新登录一次');
  });
});

test('reset() 丢弃缓存后下次调用重新探测与登录', async (t) => {
  await withFake(t, async (fake) => {
    const client = clientFor(fake);
    await client.connect();
    client.reset();
    assert.equal(client.authenticated, false);
    await client.connect();
    assert.equal(fake.loginAttempts, 2);
  });
});

/* ------------------------------------------------------------------ */
/* 保密性                                                                */
/* ------------------------------------------------------------------ */

test('token、凭据、二维码 URL 都不写进日志（只记录非敏感字段）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-napcat-log-'));
  const fake = new FakeNapCat();
  await fake.listen();
  try {
    const root = createLogger({ level: 'debug', dir, file: 'napcat.log', console: false });
    const client = new NapCatWebUi({
      webuiUrl: fake.baseUrl,
      token: TOKEN,
      probeRange: 0,
      timeoutMs: 800,
      connectTimeoutMs: 200,
      logger: root.child('napcat'),
    });
    await client.connect();
    await client.getLoginQrcode();
    await client.listQuickLogin();
    await client.quickLogin('10001');
    await root.close();

    const logged = readFileSync(join(dir, 'napcat.log'), 'utf8');
    assert.ok(logged.length > 0, '应当确实写入了日志');
    assert.match(logged, /NapCat WebUI 已连接/);
    assert.equal(logged.includes(TOKEN), false, 'token 不得出现在日志里');
    assert.equal(logged.includes(TOKEN_HASH), false, '口令哈希不得出现在日志里');
    assert.equal(logged.includes('cred-abc123'), false, 'Credential 不得出现在日志里');
    assert.equal(logged.includes('SECRET-QR-PAYLOAD'), false, '二维码 URL 不得出现在日志里');
  } finally {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
