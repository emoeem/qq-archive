import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';

/**
 * 假 NapCat WebUI —— 端到端测试夹具（进程内 HTTP 服务）。
 *
 * 接口面来自 NapCat WebUI 的真实契约：
 *   POST /api/auth/login {hash}            → {code:0, data:{Credential}}
 *   POST /api/QQLogin/GetQQLoginQrcode     → {code:0, data:{qrcode}}
 *   POST /api/QQLogin/CheckLoginStatus     → {code:0, data:{isLogin, uin}}
 *   GET  /api/QQLogin/GetQuickLoginListNew → {code:0, data:[{uin,nickName,isQuickLogin}]}
 *   POST /api/QQLogin/SetQuickLogin {uin}  → {code:0}
 * 未知路径返回 404 —— 用来确认调用方不会把「接口不存在」静默当成「没有可登录账号」。
 *
 * 注意：本服务跑在测试进程内，因此**调用方不能用 `spawnSync` 起子进程**：
 * 那会阻塞本进程的事件循环，让子进程的请求永远等不到响应（实测会以 2 s 超时收场）。
 *
 * 本文件位于 `tests/fixtures/`，不匹配 `*.test.ts`，不会被当作测试执行。
 */

export interface TraceEntry {
  method: string;
  path: string;
  auth: string;
  body: Record<string, unknown>;
}

export interface FakeNapCatOptions {
  /** 第 n 次 CheckLoginStatus 之后视为已登录（0 = 永不）。 */
  loginAfter?: number;
  /** 一开始就处于已登录态。 */
  alreadyLoggedIn?: boolean;
  /** 让第一条已鉴权请求回一次 unauthorized 并使当前凭据失效。 */
  unauthorizedOnce?: boolean;
  /** 服务端认可的 token（用于模拟配置里 token 写错）。 */
  token?: string;
  /** 二维码 URL；默认取 https://example.com/qr/abc?k=1。 */
  qrUrl?: string;
}

export interface FakeNapCat {
  port: number;
  trace: TraceEntry[];
  close: () => Promise<void>;
}

export const FAKE_NAPCAT_TOKEN = 'test-token-abc';
export const FAKE_NAPCAT_QR_URL = 'https://example.com/qr/abc?k=1';
/** 快捷登录列表里两个账号：10001 可用，10002 不可用。 */
export const FAKE_NAPCAT_ACCOUNTS = [
  { uin: '10001', nickName: '测试账号甲', isQuickLogin: true },
  { uin: '10002', nickName: '测试账号乙', isQuickLogin: false },
] as const;

export function startFakeNapCat(opts: FakeNapCatOptions = {}): Promise<FakeNapCat> {
  const token = opts.token ?? FAKE_NAPCAT_TOKEN;
  const qrUrl = opts.qrUrl ?? FAKE_NAPCAT_QR_URL;
  const expectedHash = createHash('sha256').update(`${token}.napcat`, 'utf8').digest('hex');
  const trace: TraceEntry[] = [];
  let credential = 'cred-0';
  let loginCount = 0;
  let statusCalls = 0;
  let loggedIn = opts.alreadyLoggedIn === true;
  let didUnauthorizedOnce = false;

  const send = (res: ServerResponse, obj: unknown, code = 200): void => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  };
  const readBody = (req: IncomingMessage): Promise<Record<string, unknown>> =>
    new Promise((done) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        try {
          const parsed: unknown = raw ? JSON.parse(raw) : {};
          done(typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {});
        } catch {
          done({ __bad: raw });
        }
      });
    });

  const server: Server = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      const body = req.method === 'POST' ? await readBody(req) : {};
      const auth = req.headers.authorization ?? '-';
      trace.push({ method: req.method ?? '', path, auth, body });

      if (path === '/api/auth/login' && req.method === 'POST') {
        if (body['hash'] !== expectedHash) {
          send(res, { code: -1, message: 'token 校验失败' });
          return;
        }
        loginCount += 1;
        // 确定性凭据：这样才能精确断言「作废旧凭据 → 重登 → 用新凭据重试」
        credential = `cred-${loginCount}`;
        send(res, { code: 0, data: { Credential: credential } });
        return;
      }

      if (auth !== `Bearer ${credential}`) {
        // NapCat 凭据失效时的真实回话形态：HTTP 200 + message=unauthorized
        send(res, { code: -1, message: 'unauthorized' });
        return;
      }

      if (opts.unauthorizedOnce === true && !didUnauthorizedOnce) {
        didUnauthorizedOnce = true;
        credential = 'cred-stale';
        send(res, { code: -1, message: 'unauthorized' });
        return;
      }

      if (path === '/api/QQLogin/GetQQLoginQrcode' && req.method === 'POST') {
        send(res, { code: 0, data: { qrcode: qrUrl } });
        return;
      }
      if (path === '/api/QQLogin/CheckLoginStatus' && req.method === 'POST') {
        statusCalls += 1;
        if ((opts.loginAfter ?? 0) > 0 && statusCalls > (opts.loginAfter ?? 0)) loggedIn = true;
        send(res, { code: 0, data: { isLogin: loggedIn, uin: loggedIn ? '10001' : '' } });
        return;
      }
      if (path === '/api/QQLogin/GetQuickLoginListNew') {
        send(res, { code: 0, data: FAKE_NAPCAT_ACCOUNTS });
        return;
      }
      if (path === '/api/QQLogin/SetQuickLogin' && req.method === 'POST') {
        send(res, { code: 0, message: 'ok' });
        return;
      }
      send(res, { code: -1, message: `未知接口 ${path}` }, 404);
    })();
  });

  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      done({
        port,
        trace,
        close: () =>
          new Promise<void>((closed) => {
            server.close(() => closed());
          }),
      });
    });
  });
}
