/**
 * NapCat WebUI 适配器：扫码登录 / 登录状态 / 快捷登录。
 *
 * ## 为什么需要这一层
 * 本程序自己**不实现** QQ 登录协议（那是另一个量级的工程，且违反 QQ 生态的使用边界）。
 * QQ 的登录态只能由 QQ 客户端一侧的实现取得；NapCat 提供了它自己的**本机 WebUI REST 接口**，
 * 我们可以据此拿到登录二维码、查询登录状态、触发已保存账号的快捷登录。
 *
 * ## 许可与独立性
 * 本文件是**按公开的 HTTP 接口契约独立重写**的实现，不含任何第三方代码：
 *  - 参考对象 qq-chat-exporter 是 **GPL-3.0**，NapCat 是自定义「禁商用 / 禁发布修改版」许可；
 *  - 因此**不复制代码、不链接**，只依据接口契约（请求路径、请求体字段、响应字段）独立实现；
 *  - HTTP 接口契约属于事实性接口信息，独立进程按契约重写不构成衍生作品。
 * 这一取舍与本项目「采集端通过 HTTP 接口与 QQ 生态解耦」的整体决策一致。
 *
 * ## 安全约定
 *  - WebUI token 与登录凭据（Credential）**永不写入日志**，也不进错误消息；
 *  - 二维码 URL 本身就是一份可用于登录的凭据，因此本模块只把它**返回给调用方**，
 *    由上层决定如何呈现（服务端以 PNG data URL 下发，绝不放进普通 JSON 字段）。
 */

import { createHash } from 'node:crypto';
import { connect as netConnect } from 'node:net';
import { AppError, collectorUnavailable, type ScopedLogger } from '../../core/src/index.ts';
import { asArray, asRecord, errText, num, str, type FetchLike } from './util.ts';

/** NapCat WebUI 默认地址（NapCat 默认从 6099 起监听，端口被占用时会自增）。 */
export const NAPCAT_DEFAULT_WEBUI_URL = 'http://127.0.0.1:6099';
/** 端口自增探测范围：6099..6119，与 NapCat 的自增上限一致。 */
export const NAPCAT_DEFAULT_PROBE_RANGE = 20;
/** 单次请求超时（毫秒）。 */
export const NAPCAT_DEFAULT_TIMEOUT_MS = 2000;
/** TCP 端口探测超时（毫秒）。 */
export const NAPCAT_DEFAULT_CONNECT_TIMEOUT_MS = 400;
/** WebUI 密码哈希的固定后缀（NapCat 侧的约定）。 */
export const NAPCAT_PASSWORD_SUFFIX = '.napcat';
/** 二维码 URL 在响应里可能出现的位置（不同 NapCat 版本字段名不一致）。 */
export const NAPCAT_QR_FIELDS = ['qrcode', 'qrcodeurl', 'qrcodeUrl', 'qrCodeUrl', 'url'] as const;

/**
 * WebUI 登录口令：`sha256(token + ".napcat")` 的**小写 hex**。
 *
 * 纯函数，便于单测直接对拍。
 */
export function napcatWebUiPasswordHash(token: string): string {
  return createHash('sha256').update(`${token}${NAPCAT_PASSWORD_SUFFIX}`, 'utf8').digest('hex');
}

/** 二维码（`url` 是登录凭据，调用方负责不外泄）。 */
export interface NapCatQrCode {
  url: string;
  /** 命中的响应字段名，便于诊断不同 NapCat 版本的差异。 */
  source: string;
}

/** 登录状态。 */
export interface NapCatLoginStatus {
  isLogin: boolean;
  uin?: string;
  qrcodeUrl?: string;
  raw?: Record<string, unknown>;
}

/** 快捷登录列表中的一项。 */
export interface NapCatQuickAccount {
  uin: string;
  nickname?: string;
  faceUrl?: string;
  isQuickLogin?: boolean;
}

/** 快捷登录结果：`ok=false` 不代表接口故障，而是 NapCat 明确拒绝（如该账号已在登录中）。 */
export type NapCatQuickLoginResult =
  | { ok: true; uin: string; message?: string }
  | { ok: false; uin: string; alreadyLoggedIn: boolean; message: string };

/** 端口探测实现；默认用 TCP connect，测试可注入假实现。 */
export type PortProbeFn = (host: string, port: number, timeoutMs: number) => Promise<boolean>;

export interface NapCatWebUiOptions {
  /** WebUI 基址，缺省 {@link NAPCAT_DEFAULT_WEBUI_URL}。 */
  webuiUrl?: string;
  /** NapCat 的 `config/webui.json` 里的 token。 */
  token: string;
  /** 端口自增探测范围，缺省 20。 */
  probeRange?: number;
  timeoutMs?: number;
  connectTimeoutMs?: number;
  fetchImpl?: FetchLike;
  probePort?: PortProbeFn;
  logger?: ScopedLogger;
}

interface WebUiResponse {
  status: number;
  json: Record<string, unknown> | null;
  text: string;
}

/** 默认端口探测：TCP connect 成功即认为端口开放。 */
const defaultProbePort: PortProbeFn = (host, port, timeoutMs) =>
  new Promise<boolean>((resolve) => {
    const socket = netConnect({ host, port });
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });

/** 把响应里可能是 boolean / 'true' / 1 的字段统一成 boolean。 */
function asBool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (v === 1 || v === 0) return v === 1;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === '1' || s === 'yes') return true;
    if (s === 'false' || s === '0' || s === 'no') return false;
  }
  return undefined;
}

/** 在响应对象里按已知字段名找二维码 URL。 */
function pickQrUrl(data: Record<string, unknown> | null): NapCatQrCode | null {
  if (!data) return null;
  for (const field of NAPCAT_QR_FIELDS) {
    const url = str(data[field]);
    if (url) return { url, source: field };
  }
  return null;
}

/** 解析快捷登录列表的一项（旧接口返回裸 uin 字符串，新接口返回对象）。 */
function parseQuickAccount(item: unknown): NapCatQuickAccount | null {
  if (typeof item === 'string' || typeof item === 'number') {
    const uin = String(item).trim();
    return uin ? { uin } : null;
  }
  const rec = asRecord(item);
  if (!rec) return null;
  const uin = str(rec['uin']) ?? str(rec['qq']) ?? str(rec['account']);
  if (!uin) return null;
  const nickname = str(rec['nickName']) ?? str(rec['nick']) ?? str(rec['nickname']);
  const faceUrl = str(rec['faceUrl']) ?? str(rec['avatarUrl']) ?? str(rec['avatar']);
  const isQuickLogin = asBool(rec['isQuickLogin']);
  return {
    uin,
    ...(nickname === undefined ? {} : { nickname }),
    ...(faceUrl === undefined ? {} : { faceUrl }),
    ...(isQuickLogin === undefined ? {} : { isQuickLogin }),
  };
}

/**
 * NapCat WebUI 客户端。
 *
 * 生命周期：`connect()` 会先探测端口再登录，成功后缓存基址与凭据；
 * 后续任一请求遇到鉴权失败或网络错误时会**自动重新探测并重新登录一次**（只重试一次，避免打转）。
 */
export class NapCatWebUi {
  private readonly webuiUrl: string;
  private readonly token: string;
  private readonly probeRange: number;
  private readonly timeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly probePort: PortProbeFn;
  private readonly logger: ScopedLogger | undefined;

  private baseUrlValue: string | undefined;
  private credentialValue: string | undefined;
  private lastGoodPort: number | undefined;

  constructor(opts: NapCatWebUiOptions) {
    this.webuiUrl = opts.webuiUrl && opts.webuiUrl !== '' ? opts.webuiUrl : NAPCAT_DEFAULT_WEBUI_URL;
    this.token = opts.token;
    this.probeRange = opts.probeRange ?? NAPCAT_DEFAULT_PROBE_RANGE;
    this.timeoutMs = opts.timeoutMs ?? NAPCAT_DEFAULT_TIMEOUT_MS;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? NAPCAT_DEFAULT_CONNECT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.probePort = opts.probePort ?? defaultProbePort;
    this.logger = opts.logger;
  }

  /** 已确认可用的 WebUI 基址（未连接时为 undefined）。 */
  get baseUrl(): string | undefined {
    return this.baseUrlValue;
  }

  /** 是否已持有凭据。 */
  get authenticated(): boolean {
    return this.credentialValue !== undefined && this.baseUrlValue !== undefined;
  }

  /** 丢弃缓存的基址与凭据；下次调用会重新探测并登录。 */
  reset(): void {
    this.baseUrlValue = undefined;
    this.credentialValue = undefined;
  }

  /**
   * 探测端口并登录，返回可用的基址。幂等：已连接时直接返回缓存值。
   *
   * 探测顺序：上次成功的端口优先，其次按 `webuiUrl` 的端口起自增。
   * 全部候选都失败时抛 `COLLECTOR_UNAVAILABLE`；端口可达但 token 不对时抛 `UNAUTHORIZED`
   * （区分这两种情况很重要：前者要用户启动 NapCat，后者要用户改配置）。
   */
  async connect(): Promise<string> {
    if (this.baseUrlValue !== undefined && this.credentialValue !== undefined) return this.baseUrlValue;
    const candidates = await this.candidateBaseUrls();
    if (candidates.length === 0) {
      throw collectorUnavailable(
        `未发现可用的 NapCat WebUI 端口（从 ${this.webuiUrl} 起探测 ${this.probeRange + 1} 个端口）。` +
          '请确认 NapCat 正在运行且已开启 WebUI。',
      );
    }
    let lastErr: unknown;
    for (const base of candidates) {
      try {
        const credential = await this.loginAt(base);
        this.baseUrlValue = base;
        this.credentialValue = credential;
        const port = Number(new URL(base).port);
        if (Number.isFinite(port)) this.lastGoodPort = port;
        // 只记录基址，绝不记录 token / credential
        this.logger?.info('NapCat WebUI 已连接', { baseUrl: base });
        return base;
      } catch (err) {
        lastErr = err;
      }
    }
    if (lastErr instanceof AppError) throw lastErr;
    throw collectorUnavailable(`NapCat WebUI 认证失败：${errText(lastErr)}`);
  }

  /** 取登录二维码（登录凭据，调用方不得明文外泄）。 */
  async getLoginQrcode(): Promise<NapCatQrCode> {
    const res = await this.request('/api/QQLogin/GetQQLoginQrcode', 'POST', {});
    const json = this.unwrap(res, '/api/QQLogin/GetQQLoginQrcode');
    const direct = pickQrUrl(asRecord(json['data']));
    if (direct) return direct;
    // 回退：部分 NapCat 版本只在登录状态接口里返回二维码 URL
    const status = await this.getLoginStatus();
    if (status.qrcodeUrl) return { url: status.qrcodeUrl, source: 'CheckLoginStatus' };
    throw collectorUnavailable('NapCat 未返回登录二维码：可能当前已登录，或该版本不支持扫码接口。');
  }

  /** 查询登录状态。 */
  async getLoginStatus(): Promise<NapCatLoginStatus> {
    const res = await this.request('/api/QQLogin/CheckLoginStatus', 'POST', {});
    const json = this.unwrap(res, '/api/QQLogin/CheckLoginStatus');
    const data = asRecord(json['data']) ?? {};
    const isLogin = asBool(data['isLogin']) ?? asBool(data['online']) ?? false;
    const uin = str(data['uin']) ?? str(data['qq']);
    const qr = pickQrUrl(data);
    return {
      isLogin,
      ...(uin === undefined ? {} : { uin }),
      ...(qr === null ? {} : { qrcodeUrl: qr.url }),
      raw: data,
    };
  }

  /**
   * 列出可快捷登录的账号。
   *
   * 新接口不可用（旧版 NapCat）时退回旧接口；但 `code !== 0` 属于真实错误，
   * **必须上报而不是返回空列表**——否则界面会显示成「没有可登录的账号」。
   */
  async listQuickLogin(): Promise<NapCatQuickAccount[]> {
    let json: Record<string, unknown>;
    try {
      json = this.unwrap(await this.request('/api/QQLogin/GetQuickLoginListNew', 'GET'), 'GetQuickLoginListNew');
    } catch (err) {
      const notFound = err instanceof AppError && /HTTP 40[45]/.test(err.message);
      if (!notFound) throw err;
      this.logger?.debug('新版快捷登录接口不可用，退回旧接口');
      json = this.unwrap(await this.request('/api/QQLogin/GetQuickLoginList', 'GET'), 'GetQuickLoginList');
    }
    const data = json['data'];
    if (data === null || data === undefined) {
      throw collectorUnavailable('NapCat 返回的快捷登录列表为 null（接口可用但数据异常）。');
    }
    return asArray(data)
      .map(parseQuickAccount)
      .filter((a): a is NapCatQuickAccount => a !== null);
  }

  /**
   * 触发指定账号的快捷登录。
   *
   * 注意：NapCat 在「该账号已在登录流程中」时会返回明确文案而不是成功，
   * 这不是故障，因此作为 `ok:false` 返回，由上层决定提示方式。
   */
  async quickLogin(uin: string): Promise<NapCatQuickLoginResult> {
    const body = { uin: /^\d+$/.test(uin) ? Number(uin) : uin };
    const res = await this.request('/api/QQLogin/SetQuickLogin', 'POST', body);
    if (this.isUnauthorized(res)) {
      throw new AppError('UNAUTHORIZED', 'NapCat WebUI 鉴权失败：token 或凭据无效');
    }
    const json = res.json;
    const message = str(json?.['message']) ?? str(json?.['msg']) ?? res.text.slice(0, 200);
    const code = num(json?.['code']);
    if (code === 0) return { ok: true, uin, ...(message === undefined ? {} : { message }) };
    const alreadyLoggedIn = message !== undefined && message.includes('已登录') && message.includes('无法重复登录');
    return {
      ok: false,
      uin,
      alreadyLoggedIn,
      message: message ?? `NapCat 返回 code=${String(code)}`,
    };
  }

  /* ---------------- 内部 ---------------- */

  private async candidateBaseUrls(): Promise<string[]> {
    const url = new URL(this.webuiUrl);
    const startPort = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
    const ports: number[] = [];
    // 上次成功的端口优先（NapCat 换端口后能最快命中），随后按配置端口自增；
    // 注意 lastGoodPort 与 startPort 相同也必须保留，否则重连时候选列表会空掉。
    if (this.lastGoodPort !== undefined) ports.push(this.lastGoodPort);
    for (let p = startPort; p <= startPort + this.probeRange; p++) {
      if (!ports.includes(p)) ports.push(p);
    }
    const openFlags = await Promise.all(ports.map((p) => this.probePort(url.hostname, p, this.connectTimeoutMs)));
    const ordered = ports.filter((_p, i) => openFlags[i] === true);
    return ordered.map((p) => `${url.protocol}//${url.hostname}:${p}`);
  }

  private async loginAt(baseUrl: string): Promise<string> {
    const hash = napcatWebUiPasswordHash(this.token);
    let res: Response;
    try {
      res = await this.fetchImpl(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hash }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw collectorUnavailable(`NapCat WebUI 登录请求失败（${baseUrl}）：${errText(err)}`);
    }
    const text = await res.text().catch(() => '');
    let json: Record<string, unknown> | null = null;
    try {
      json = asRecord(JSON.parse(text));
    } catch {
      json = null;
    }
    const data = asRecord(json?.['data']);
    const credential = str(data?.['Credential']) ?? str(data?.['credential']);
    if (credential === undefined) {
      const msg = str(json?.['message']) ?? text.slice(0, 200);
      throw new AppError(
        'UNAUTHORIZED',
        `NapCat WebUI 认证失败（${baseUrl}）：${msg || '未返回 Credential'}。` +
          '请核对配置里的 collector.napcat.token 是否与 NapCat 的 config/webui.json 一致。',
      );
    }
    return credential;
  }

  private async rawFetch(path: string, method: string, body?: unknown): Promise<WebUiResponse> {
    const base = this.baseUrlValue;
    if (base === undefined) throw collectorUnavailable('尚未探明 NapCat WebUI 地址');
    const headers: Record<string, string> = {};
    if (this.credentialValue !== undefined) headers['authorization'] = `Bearer ${this.credentialValue}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await this.fetchImpl(`${base}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text().catch(() => '');
    let json: Record<string, unknown> | null = null;
    try {
      json = asRecord(JSON.parse(text));
    } catch {
      json = null;
    }
    return { status: res.status, json, text };
  }

  private isUnauthorized(res: WebUiResponse): boolean {
    if (res.status === 401 || res.status === 403) return true;
    const msg = str(res.json?.['message']) ?? '';
    return /unauthoriz/i.test(msg);
  }

  /**
   * 发一个请求；鉴权失效或网络故障时**重新探测 + 重新登录一次**。
   *
   * 恰好重试一次是刻意的：NapCat 的 WebUI 在异常退出后会换端口，
   * 重试探端口能自愈；但无限重试会在服务不可用时把请求堆死。
   */
  private async request(path: string, method: string, body?: unknown): Promise<WebUiResponse> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.connect();
      try {
        const res = await this.rawFetch(path, method, body);
        if (this.isUnauthorized(res) && attempt === 0) {
          this.reset();
          continue;
        }
        return res;
      } catch (err) {
        this.reset(); // 网络层失败：端口很可能已经变了
        lastErr = err;
        if (attempt === 1) throw err;
      }
    }
    throw lastErr instanceof Error ? lastErr : collectorUnavailable(`NapCat WebUI 请求失败：${path}`);
  }

  /** 校验响应并取出 JSON 体；`code !== 0` 一律当错误上报。 */
  private unwrap(res: WebUiResponse, path: string): Record<string, unknown> {
    if (this.isUnauthorized(res)) {
      throw new AppError('UNAUTHORIZED', `NapCat WebUI 鉴权失败（${path}）：token 或凭据无效`);
    }
    if (res.status >= 400) {
      throw collectorUnavailable(`NapCat WebUI ${path} 返回 HTTP ${res.status}`);
    }
    const json = res.json;
    if (json === null) {
      throw collectorUnavailable(`NapCat WebUI ${path} 返回的不是 JSON：${res.text.slice(0, 120)}`);
    }
    const code = num(json['code']);
    if (code !== undefined && code !== 0) {
      const message = str(json['message']) ?? '';
      throw new AppError('COLLECTOR_UNAVAILABLE', `NapCat WebUI ${path} 返回 code=${code}：${message}`, {
        code,
        message,
      });
    }
    return json;
  }
}
