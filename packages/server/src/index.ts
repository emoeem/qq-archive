/**
 * QQ 归档服务：`createServer(opts)` —— node:http 自研路由，生产依赖为 0。
 *
 * 契约见 docs/ARCHITECTURE.md 第 6 节：成功 `{data}`、失败 `{error, code}`，
 * 除 `/api/health` 与 `/api/auth/login`（以及用 refreshToken 换取的 `/api/auth/refresh`）外全部要求认证。
 */
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { accessSync, constants, createReadStream, existsSync, statSync, statfsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { badRequest, notFound, unauthorized } from '../../core/src/errors.ts';
import { sttConfigOf } from '../../core/src/config.ts';
import type { AppConfig } from '../../core/src/config.ts';
import type { ScopedLogger } from '../../core/src/logger.ts';
import type {
  ArchiveStats,
  HealthReport,
  MediaListItem,
  Page,
} from '../../core/src/index.ts';
import type { Db, ReplyLookup } from '../../db/src/index.ts';
import { replyLookupKey } from '../../db/src/index.ts';
import {
  WhisperCliTranscriber,
  transcribePending,
  type ExecFn as SttExecFn,
  type SttAvailability,
} from '../../stt/src/index.ts';
import { encodeQr } from '../../qr/src/index.ts';
import { qrToPngDataUrl } from '../../qr/src/index.ts';
import type {
  NapCatLoginStatus,
  NapCatQrCode,
  NapCatQuickAccount,
  NapCatQuickLoginResult,
} from '../../collect/src/index.ts';
import {
  HttpError,
  applySecurityHeaders,
  boolValue,
  contentDisposition,
  enumQuery,
  intParam,
  intQuery,
  mimeForPath,
  parseRange,
  rangeLength,
  rawQuery,
  readJsonBody,
  sendData,
  sendError,
  strQuery,
} from './http.ts';
import { Router, type RequestContext } from './router.ts';
import { serveStatic } from './static.ts';
import { streamSessionExport, type ExportFormat } from './export.ts';
import { createBackup, pruneBackups, reconcileBackups, restoreBackup } from './backup.ts';
import {
  assertRealPathWithin,
  displayNameOf,
  fileSize,
  isRegularFile,
  mimeForMedia,
  resolveSafePath,
  sha256File,
} from './media.ts';
import {
  LoginThrottle,
  constantTimeEqual,
  deriveSigningKey,
  isRevoked,
  issueSession,
  revokeJti,
  takeRefreshToken,
  verifyAccessToken,
  type AccessPayload,
} from './auth.ts';

/** 采集器接口（packages/collect 由队友实现，这里只依赖最小鸭子类型）。 */
/**
 * 采集实现的最小契约。
 *
 * 只要求 `runOnce`（单轮采集）；`start`/`isRunning` 是**可选**的"定时循环"能力 ——
 * 真实的 `CollectRunner` 有，测试里的桩通常只实现 runOnce。
 * 服务端据此决定界面上要不要给"开始/停止采集"按钮（`/api/collect/health` 的 `controllable`）。
 */
export interface CollectRunner {
  runOnce(opts?: Record<string, unknown>): Promise<unknown>;
  health?(): unknown | Promise<unknown>;
  /** 启动定时循环，返回停止函数。 */
  start?(): () => Promise<void>;
  /** 定时循环是否在运行。 */
  isRunning?(): boolean;
}

export interface ServerOptions {
  config: AppConfig;
  db: Db;
  logger: ScopedLogger;
  collect?: CollectRunner;
  repoRoot: string;
  version: string;
  startedAt: number;
  /** 语音转写注入点：测试用它塞入假 exec / 现成转写器，生产留空即走真实 whisper-cli。 */
  stt?: SttServerOptions;
}

/** STT 测试注入：两者都留空时由服务自己构造 `WhisperCliTranscriber`。 */
export interface SttServerOptions {
  exec?: SttExecFn;
  transcriber?: WhisperCliTranscriber;
}

export interface CreatedServer {
  server: Server;
  /** 定时自动备份的状态（`backup.intervalHours > 0` 时为 enabled）。 */
  autoBackup: { enabled: boolean; intervalHours: number; keep: number };
  /** 立即跑一轮与定时器同入口的备份（同样入库 + 保留份数裁剪）。 */
  runAutoBackupNow(): Promise<{ path: string; pruned: string[] }>;
  close(): Promise<void>;
}

/** 采集循环句柄：`null` 表示当前没有在跑（或用的是不支持控制的桩实现）。 */
interface ServerState {
  /** 由本服务启动的定时采集循环的停止函数。 */
  collectStop?: (() => Promise<void>) | null;
  config: AppConfig;
  db: Db;
  logger: ScopedLogger;
  collect?: CollectRunner;
  repoRoot: string;
  version: string;
  startedAt: number;
  signingKey: Buffer;
  revoked: Map<string, number>;
  throttle: LoginThrottle;
  running: Set<number>;
  /** 懒构造的 NapCat WebUI 客户端（扫码登录用）；构造后复用连接与凭据。 */
  napcat?: NapCatClient;
  /** 懒构造的语音转写器；probe 结果缓存在实例里，避免每个请求都起进程。 */
  sttTranscriber?: WhisperCliTranscriber;
}

/** 本服务用到的 NapCat WebUI 客户端能力（结构化类型，避免与 collect 包硬耦合）。 */
interface NapCatClient {
  readonly baseUrl: string | undefined;
  connect(): Promise<string>;
  getLoginQrcode(): Promise<NapCatQrCode>;
  getLoginStatus(): Promise<NapCatLoginStatus>;
  listQuickLogin(): Promise<NapCatQuickAccount[]>;
  quickLogin(uin: string): Promise<NapCatQuickLoginResult>;
  reset(): void;
}

const CHAT_TYPES = ['private', 'group', 'temp', 'other'] as const;
const MSG_TYPES = [
  'text',
  'image',
  'video',
  'audio',
  'file',
  'face',
  'reply',
  'forward',
  'json',
  'location',
  'system',
  'other',
] as const;
const DIRECTIONS = ['in', 'out', 'system'] as const;
const MEDIA_KINDS = ['image', 'video', 'audio', 'file', 'other'] as const;
const MEDIA_STATUS = ['present', 'missing', 'corrupt', 'pending'] as const;
const JOB_STATUS = ['pending', 'running', 'done', 'failed', 'cancelled'] as const;
const JOB_KINDS = ['import', 'collect', 'backup'] as const;
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
const EXPORT_FORMATS = ['json', 'jsonl', 'txt'] as const;

/**
 * 批量转写的进程内互斥标志（模块级，跨 createServer 实例共享）。
 *
 * 同一个进程里同时跑两轮 `transcribePending` 会让两轮各自读到同一批「未转写」行，
 * 产生重复的 whisper 调用；这里用 409 直接把第二个请求挡回去。
 */
let sttBatchRunning = false;

function isTerminalJob(status: string): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled';
}

/** 动态导入其它包：specifier 故意用变量，避免 tsc 在模块尚未落地时报 TS2307。 */
async function dynamicImport(spec: string): Promise<Record<string, unknown> | { __error: string }> {
  try {
    const mod = (await import(spec)) as Record<string, unknown>;
    return mod;
  } catch (err) {
    return { __error: (err as Error).message };
  }
}

type LooseFn = (opts: Record<string, unknown>) => Promise<unknown> | unknown;

async function probeModule(
  spec: string,
  candidates: string[],
  label: string,
): Promise<{ fn: LooseFn; name: string } | { error: string }> {
  const mod = await dynamicImport(spec);
  if ('__error' in mod) return { error: `${label} 模块不可用：${mod.__error}` };
  for (const name of candidates) {
    const v = mod[name];
    if (typeof v === 'function') return { fn: v as LooseFn, name };
  }
  const keys = Object.keys(mod).join(', ');
  return { error: `${label} 模块未导出可调用的入口（已导出：${keys === '' ? '无' : keys}）` };
}

function loadImportModule(): Promise<{ fn: LooseFn; name: string } | { error: string }> {
  return probeModule(
    '../../import/src/index.ts',
    ['runImport', 'runImportJob', 'importArchive', 'importFile', 'importFromFile'],
    'packages/import',
  );
}

async function loadCollectRunner(state: ServerState): Promise<CollectRunner | { error: string }> {
  if (state.collect) return state.collect;
  const mod = await dynamicImport('../../collect/src/index.ts');
  if ('__error' in mod) return { error: `packages/collect 模块不可用：${mod.__error}` };
  for (const name of ['runCollect', 'runCollectOnce', 'runOnce', 'collect']) {
    const v = mod[name];
    if (typeof v === 'function') return { runOnce: v as CollectRunner['runOnce'] };
  }
  for (const name of ['createCollector', 'createCollectRunner', 'default']) {
    const v = mod[name];
    if (typeof v === 'function') {
      try {
        const made = (v as LooseFn)({ config: state.config, db: state.db, logger: state.logger });
        if (made && typeof (made as CollectRunner).runOnce === 'function') return made as CollectRunner;
      } catch {
        /* 继续尝试下一个候选 */
      }
    }
  }
  const keys = Object.keys(mod).join(', ');
  return { error: `packages/collect 模块未导出可用入口（已导出：${keys === '' ? '无' : keys}）` };
}

/** 采集实现是否支持"启停控制"（真实 CollectRunner 支持；测试里的桩只实现 runOnce）。 */
interface LoopCapableRunner extends CollectRunner {
  start: () => () => Promise<void>;
  isRunning: () => boolean;
}

function hasLoopControl(runner: CollectRunner | { error: string }): runner is LoopCapableRunner {
  return (
    !('error' in runner)
    && typeof runner.start === 'function'
    && typeof runner.isRunning === 'function'
  );
}

/**
 * 启动定时采集循环。**幂等**：已在运行时不重复启动（否则 runner.start() 会抛）。
 * 返回结构化结果而不是抛错，方便接口如实告诉界面"为什么没启动"。
 */
async function startCollectLoop(state: ServerState): Promise<{ started: boolean; running: boolean; reason: string | null }> {
  const runner = await loadCollectRunner(state);
  if ('error' in runner) return { started: false, running: false, reason: runner.error };
  if (!hasLoopControl(runner)) {
    return { started: false, running: false, reason: '当前采集实现不支持启停控制（只实现了单轮采集）' };
  }
  if (runner.isRunning()) {
    return { started: false, running: true, reason: '已在运行' };
  }
  state.collectStop = runner.start();
  return { started: true, running: true, reason: null };
}

/** 停止定时采集循环。幂等：没在跑时返回 `stopped: false` 而不是报错。 */
async function stopCollectLoop(state: ServerState): Promise<{ stopped: boolean; running: boolean; reason: string | null }> {
  const runner = await loadCollectRunner(state);
  const stop = state.collectStop ?? null;
  if (stop === null) {
    const running = hasLoopControl(runner) ? runner.isRunning() : false;
    return { stopped: false, running, reason: running ? '运行中但不是由本进程启动的，无法停止' : '当前未在运行' };
  }
  await stop();
  state.collectStop = null;
  return { stopped: true, running: false, reason: null };
}

/**
 * 懒构造 NapCat WebUI 客户端。
 *
 * 未配置 `collector.napcat.token` 时**不当作故障**：扫码登录是可选项，
 * 返回 `{error}` 由调用方如实展示引导文案（不影响消息归档）。
 */
async function loadNapCatClient(state: ServerState): Promise<NapCatClient | { error: string }> {
  if (state.napcat) return state.napcat;
  const conf = state.config.collector.napcat;
  if (!conf || conf.token === '') {
    return {
      error:
        '未配置 collector.napcat.token：扫码登录需要 NapCat WebUI 的 token（见 NapCat 的 config/webui.json）。' +
        '消息归档不受影响。',
    };
  }
  const mod = await dynamicImport('../../collect/src/index.ts');
  if ('__error' in mod) return { error: `packages/collect 模块不可用：${mod.__error}` };
  const ctor = mod['NapCatWebUi'];
  if (typeof ctor !== 'function') return { error: 'packages/collect 未导出 NapCatWebUi' };
  const client = new (ctor as new (o: Record<string, unknown>) => NapCatClient)({
    webuiUrl: conf.webuiUrl,
    token: conf.token,
    probeRange: conf.probeRange,
    logger: state.logger.child('napcat'),
  });
  state.napcat = client;
  return client;
}

/** 把下层错误（AppError 带 code/status）转成 HTTP 错误；缺省按 503 处理。 */
function toHttpError(err: unknown, fallbackCode = 'NAPCAT_UNAVAILABLE'): HttpError {
  if (err instanceof HttpError) return err;
  // 注意：这里必须先取出值、再判断值的类型。写成 `const code = typeof obj?.code` 会把
  // 「值的类型名」（'string' / 'undefined'）当成错误码，于是所有错误都退化成 503 + code:"string"。
  const source = err as { code?: unknown; status?: unknown } | null;
  const rawCode = source?.code;
  const rawStatus = source?.status;
  return new HttpError(
    typeof rawStatus === 'number' ? rawStatus : 503,
    typeof rawCode === 'string' ? rawCode : fallbackCode,
    err instanceof Error ? err.message : String(err),
  );
}

function numericStats(result: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (result === null || typeof result !== 'object') return out;
  const src = result as Record<string, unknown>;
  const keys = [
    'totalItems',
    'processed',
    'inserted',
    'duplicate',
    'failed',
    'mediaSaved',
    'mediaMissing',
    'sessions',
    'messages',
  ];
  const nested = typeof src.stats === 'object' && src.stats !== null ? (src.stats as Record<string, unknown>) : src;
  for (const k of keys) {
    const v = nested[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/** 只挑 JobRecord 上真实存在的计数字段，避免把任意 stats 键写进 DB。 */
function jobCounters(stats: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of ['totalItems', 'processed', 'inserted', 'duplicate', 'failed', 'mediaSaved', 'mediaMissing']) {
    const v = stats[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    const first = Array.isArray(xff) ? xff[0] : xff;
    if (typeof first === 'string' && first.trim() !== '') return first.split(',')[0]!.trim();
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/**
 * 补齐 storage 里的空路径（契约：空串表示由 dataDir 派生），返回新对象，不修改调用方配置。
 * loadConfig() 通常已经解析过，这里是给直接传原始配置的调用方兜底。
 */
export function normalizeConfig(cfg: AppConfig): AppConfig {
  const dataDir = resolve(cfg.storage.dataDir.trim() === '' ? './data' : cfg.storage.dataDir);
  const pick = (value: string, fallback: string): string => (value.trim() === '' ? join(dataDir, fallback) : resolve(value));
  return {
    ...cfg,
    storage: {
      dataDir,
      dbPath: pick(cfg.storage.dbPath, 'archive.db'),
      mediaDir: pick(cfg.storage.mediaDir, 'media'),
      backupDir: pick(cfg.storage.backupDir, 'backups'),
      logDir: pick(cfg.storage.logDir, 'logs'),
    },
  };
}

/** 组装 createServer。 */
export function createServer(opts: ServerOptions): CreatedServer {
  const config = normalizeConfig(opts.config);
  const state: ServerState = {
    config,
    db: opts.db,
    logger: opts.logger,
    ...(opts.collect === undefined ? {} : { collect: opts.collect }),
    repoRoot: opts.repoRoot,
    version: opts.version,
    startedAt: opts.startedAt,
    signingKey: deriveSigningKey(config.server.token),
    revoked: new Map<string, number>(),
    throttle: new LoginThrottle(),
    running: new Set<number>(),
  };
  const log = state.logger.child('server');
  const router = new Router();

  // 起服务即开始定时采集（与之前一致），但现在**可以停/可以再开**：
  // 之前循环由 CLI 启动、服务端拿不到句柄，界面上既看不到状态也停不掉。
  void startCollectLoop(state).then((r) => {
    if (r.running) log.info('定时采集已自动启动', { intervalSec: state.config.collector.intervalSec, reason: r.reason });
  });

  /* ------------------------------------------------------------------ */
  /* 认证                                                                */
  /* ------------------------------------------------------------------ */

  function currentAuth(ctx: RequestContext, allowQuery: boolean): AccessPayload | null {
    let token: string | null = null;
    const authz = ctx.req.headers.authorization;
    if (typeof authz === 'string' && /^bearer\s+/i.test(authz)) {
      token = authz.replace(/^bearer\s+/i, '').trim();
    }
    if ((token === null || token === '') && allowQuery) {
      token = rawQuery(ctx.url, 'access') ?? null;
    }
    if (token === null || token === '') return null;
    const payload = verifyAccessToken(state.signingKey, token);
    if (!payload) return null;
    if (isRevoked(state.revoked, payload.jti)) return null;
    return payload;
  }

  function requireAuth(ctx: RequestContext, allowQuery: boolean): AccessPayload {
    const payload = currentAuth(ctx, allowQuery);
    if (!payload) throw unauthorized('未认证或登录已过期');
    return payload;
  }

  /* ------------------------------------------------------------------ */
  /* 语音转文字（STT）：懒构造 + 缓存探测                                 */
  /* ------------------------------------------------------------------ */

  const sttConfig = sttConfigOf(config);

  /**
   * 构造/取回本服务的转写器。失败时返回 `{ error }` 而不是抛：
   * STT 是可选能力，缺依赖不能让整个服务起不来。
   */
  async function sttEngine(): Promise<WhisperCliTranscriber | { error: string }> {
    if (state.sttTranscriber) return state.sttTranscriber;
    if (opts.stt?.transcriber) {
      state.sttTranscriber = opts.stt.transcriber;
      return opts.stt.transcriber;
    }
    try {
      const made = new WhisperCliTranscriber(sttConfig, {
        logger: state.logger.child('stt'),
        ...(opts.stt?.exec === undefined ? {} : { exec: opts.stt.exec }),
      });
      state.sttTranscriber = made;
      return made;
    } catch (err) {
      return { error: `语音转写引擎初始化失败：${(err as Error).message}` };
    }
  }

  /** 未启用/不可用时的占位可用性：把「为什么没有转写」如实告诉前端，且不构造引擎。 */
  function sttUnavailable(reason: string): SttAvailability {
    return {
      available: false,
      reason,
      engine: sttConfig.engine,
      binary: sttConfig.binary,
      ffmpeg: sttConfig.ffmpeg,
      model: sttConfig.model,
      warnings: [],
    };
  }

  /**
   * 可用性探测。probe 结果缓存于转写器实例内（`probe()` 第二次起直接返回缓存），
   * 所以 GET 路由不会每个请求都起进程；`POST /api/stt/probe` 用 force=true 刷新。
   */
  async function sttProbe(force: boolean): Promise<SttAvailability> {
    if (!sttConfig.enabled) return sttUnavailable('语音转写未启用：请在配置中设置 stt.enabled = true。');
    const engine = await sttEngine();
    if ('error' in engine) return sttUnavailable(engine.error);
    try {
      return await engine.probe(force);
    } catch (err) {
      return sttUnavailable(`语音转写探测失败：${(err as Error).message}`);
    }
  }

  /** 拿到可用的转写器，否则抛出 503（带 reason）。 */
  async function requireSttEngine(): Promise<WhisperCliTranscriber> {
    const availability = await sttProbe(false);
    if (!availability.available) throw new HttpError(503, 'STT_UNAVAILABLE', `语音转写不可用：${availability.reason}`);
    const engine = await sttEngine();
    if ('error' in engine) throw new HttpError(503, 'STT_UNAVAILABLE', engine.error);
    return engine;
  }

  /* ------------------------------------------------------------------ */
  /* 健康检查（公开）                                                     */
  /* ------------------------------------------------------------------ */

  router.add(
    'GET',
    '/api/health',
    (ctx) => {
      const health = state.db.health();
      const mediaDir = resolve(state.config.storage.mediaDir);
      let writable = false;
      try {
        accessSync(mediaDir, constants.W_OK);
        writable = true;
      } catch {
        try {
          writable = !existsSync(mediaDir) && existsSync(resolve(mediaDir, '..'));
        } catch {
          writable = false;
        }
      }
      let freeBytes = 0;
      let totalBytes = 0;
      try {
        const fsStat = statfsSync(mediaDir);
        freeBytes = Number(fsStat.bavail) * Number(fsStat.bsize);
        totalBytes = Number(fsStat.blocks) * Number(fsStat.bsize);
      } catch {
        /* 拿不到磁盘信息不影响健康检查结果 */
      }
      // 一个采集源在 `collect_state` 里是**每会话一行**，直接摊平会让网页上出现十几行
      // 一模一样的「onebot 正常」。按 source 聚合：ok 取与、lastOkAt 取最新、错误取第一条。
      const bySource = new Map<string, { source: string; ok: boolean; lastOkAt: string | null; lastError: string | null }>();
      for (const s of state.db.listCollectStates()) {
        const cur = bySource.get(s.source);
        const ok = s.consecutiveFailures === 0;
        if (!cur) {
          bySource.set(s.source, { source: s.source, ok, lastOkAt: s.lastOkAt, lastError: s.lastError });
          continue;
        }
        cur.ok = cur.ok && ok;
        if (s.lastOkAt !== null && s.lastOkAt !== '' && (cur.lastOkAt === null || s.lastOkAt > cur.lastOkAt)) {
          cur.lastOkAt = s.lastOkAt;
        }
        if (cur.lastError === null && s.lastError !== null && s.lastError !== '') cur.lastError = s.lastError;
      }
      const collectors = [...bySource.values()];
      const report: HealthReport = {
        ok: health.ok,
        version: state.version,
        uptimeSec: Math.max(0, Math.round((Date.now() - state.startedAt) / 1000)),
        db: { ok: health.ok, path: state.config.storage.dbPath, schemaVersion: health.schemaVersion },
        media: { root: mediaDir, writable },
        collectors,
        disk: { freeBytes, totalBytes, low: freeBytes > 0 && freeBytes < state.config.alert.diskLowGb * 1e9 },
      };
      applySecurityHeaders(ctx.res);
      sendData(ctx.res, report);
    },
    { public: true },
  );

  router.add(
    'POST',
    '/api/auth/login',
    async (ctx) => {
      const cfgToken = state.config.server.token;
      if (typeof cfgToken !== 'string' || cfgToken.length < 16) {
        throw new HttpError(500, 'INTERNAL', '服务端未配置有效的访问令牌（server.token）');
      }
      const ip = clientIp(ctx.req, state.config.server.trustProxy);
      if (!state.throttle.allowed(ip)) {
        throw new HttpError(429, 'RATE_LIMITED', '登录尝试过于频繁，请稍后再试');
      }
      const body = await readJsonBody(ctx.req);
      const token = body.token;
      if (typeof token !== 'string' || token === '') {
        state.throttle.fail(ip);
        throw unauthorized('令牌错误');
      }
      if (!constantTimeEqual(token, cfgToken)) {
        state.throttle.fail(ip);
        log.warn('登录失败', { ip });
        throw unauthorized('令牌错误');
      }
      state.throttle.succeed(ip);
      const session = issueSession(state.config, state.signingKey, state.db);
      log.info('登录成功', { ip, expiresAt: new Date(session.payload.exp).toISOString() });
      sendData(ctx.res, {
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        tokenType: 'Bearer',
        expiresIn: session.accessTtlSec,
        expiresAt: new Date(session.payload.exp).toISOString(),
      });
    },
    { public: true },
  );

  router.add(
    'POST',
    '/api/auth/refresh',
    async (ctx) => {
      const body = await readJsonBody(ctx.req);
      const rt = body.refreshToken;
      if (typeof rt !== 'string' || rt === '') throw unauthorized('缺少 refreshToken');
      if (!takeRefreshToken(state.db, rt)) throw unauthorized('refreshToken 无效或已使用');
      const session = issueSession(state.config, state.signingKey, state.db);
      sendData(ctx.res, {
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        tokenType: 'Bearer',
        expiresIn: session.accessTtlSec,
        expiresAt: new Date(session.payload.exp).toISOString(),
      });
    },
    { public: true },
  );

  router.add('GET', '/api/auth/session', (ctx) => {
    const payload = requireAuth(ctx, false);
    sendData(ctx.res, {
      authenticated: true,
      sub: payload.sub,
      jti: payload.jti,
      issuedAt: new Date(payload.iat).toISOString(),
      expiresAt: new Date(payload.exp).toISOString(),
    });
  });

  router.add('POST', '/api/auth/logout', (ctx) => {
    const payload = requireAuth(ctx, false);
    revokeJti(state.revoked, payload.jti, payload.exp);
    sendData(ctx.res, { ok: true, revokedAt: new Date().toISOString() });
  });

  /* ------------------------------------------------------------------ */
  /* 统计 / 会话 / 消息 / 搜索                                            */
  /* ------------------------------------------------------------------ */

  router.add('GET', '/api/stats', (ctx) => {
    requireAuth(ctx, false);
    const stats: ArchiveStats = state.db.stats();
    sendData(ctx.res, stats);
  });

  router.add('GET', '/api/sessions', (ctx) => {
    requireAuth(ctx, false);
    const url = ctx.url;
    const page = intQuery(url, 'page', { min: 1, def: 1 });
    const pageSize = intQuery(url, 'pageSize', { min: 1, max: 200, def: 20 });
    const chatType = enumQuery(url, 'chatType', CHAT_TYPES);
    const keyword = strQuery(url, 'keyword');
    const sort = enumQuery(url, 'sort', ['recent', 'messages', 'name'] as const);
    const accountUid = strQuery(url, 'accountUid');
    const result = state.db.listSessions({
      ...(accountUid === undefined ? {} : { accountUid }),
      ...(chatType === undefined ? {} : { chatType }),
      ...(keyword === undefined ? {} : { keyword }),
      page,
      pageSize,
      ...(sort === undefined ? {} : { sort }),
    });
    sendData(ctx.res, result);
  });

  router.add('GET', '/api/sessions/:id', (ctx) => {
    requireAuth(ctx, false);
    const id = intParam(ctx.params);
    const session = state.db.getSession(id);
    if (!session) throw notFound('会话不存在');
    const mediaCount = countScalar(state.db, 'SELECT COUNT(*) FROM message_media mm JOIN messages m ON m.id = mm.message_id WHERE m.session_id = ?', id);
    sendData(ctx.res, { ...session, mediaCount });
  });

  router.add('GET', '/api/sessions/:id/messages', (ctx) => {
    requireAuth(ctx, false);
    const id = intParam(ctx.params);
    const session = state.db.getSession(id);
    if (!session) throw notFound('会话不存在');
    const url = ctx.url;
    const limit = intQuery(url, 'limit', { min: 1, max: 500, def: 50 });
    // 默认只看"未命中过滤规则"的消息；`includeFiltered=1` 时连过滤掉的一起返回
    // （它们一直都在库里，这个参数只是决定要不要显示）。
    const includeFiltered = boolValue(rawQuery(url, 'includeFiltered'), false);
    const before = intQuery(url, 'before', { min: 0 });
    const after = intQuery(url, 'after', { min: 0 });
    const from = intQuery(url, 'from', { min: 0 });
    const to = intQuery(url, 'to', { min: 0 });
    const keyword = strQuery(url, 'keyword');
    const msgType = enumQuery(url, 'msgType', MSG_TYPES);
    const direction = enumQuery(url, 'direction', DIRECTIONS);
    const order = enumQuery(url, 'order', ['asc', 'desc'] as const);
    const result = state.db.listMessages({
      sessionId: id,
      ...(before === undefined ? {} : { before }),
      ...(after === undefined ? {} : { after }),
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
      ...(keyword === undefined ? {} : { keyword }),
      ...(msgType === undefined ? {} : { msgType }),
      ...(direction === undefined ? {} : { direction }),
      ...(order === undefined ? {} : { order }),
      limit,
      includeRecalled: true,
      includeFiltered,
    });
    const items = result.items.map((m) => {
      const mediaIds = m.media.map((x) => x.mediaId).filter((n) => Number.isInteger(n));
      return mediaUrls(m, mediaIds.length > 0 ? state.db.getTranscripts(mediaIds) : undefined);
    });
    sendData(ctx.res, { items: attachReplies(state.db, items), hasMore: result.hasMore });
  });

  router.add('GET', '/api/messages/:id', (ctx) => {
    requireAuth(ctx, false);
    const id = intParam(ctx.params);
    const message = state.db.getMessage(id);
    if (!message) throw notFound('消息不存在');
    const mediaIds = message.media.map((x) => x.mediaId).filter((n) => Number.isInteger(n));
    const withMedia = mediaUrls(message, mediaIds.length > 0 ? state.db.getTranscripts(mediaIds) : undefined);
    const [decorated] = attachReplies(state.db, [withMedia]);
    // `reply` 保留为对象（既有接口契约），`replyPreview` / `replyToMessageId` 是时间线共用的扁平字段。
    const reply =
      decorated && decorated.replyToMessageId !== null
        ? { id: decorated.replyToMessageId, text: decorated.replyPreview ?? '', senderName: decorated.replyToSenderName, ts: decorated.replyToTs }
        : null;
    sendData(ctx.res, { ...decorated, reply });
  });

  router.add('GET', '/api/search', (ctx) => {
    requireAuth(ctx, false);
    const url = ctx.url;
    const q = strQuery(url, 'q', 200) ?? strQuery(url, 'keyword', 200);
    if (q === undefined) throw badRequest('缺少查询参数 q');
    const page = intQuery(url, 'page', { min: 1, def: 1 });
    const pageSize = intQuery(url, 'pageSize', { min: 1, max: 100, def: 20 });
    const sessionId = intQuery(url, 'sessionId', { min: 1 });
    const chatType = enumQuery(url, 'chatType', CHAT_TYPES);
    const msgType = enumQuery(url, 'msgType', MSG_TYPES);
    const from = intQuery(url, 'from', { min: 0 });
    const to = intQuery(url, 'to', { min: 0 });
    const accountUid = strQuery(url, 'accountUid');
    const result = state.db.searchMessages({
      keyword: q,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(chatType === undefined ? {} : { chatType }),
      ...(msgType === undefined ? {} : { msgType }),
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
      ...(accountUid === undefined ? {} : { accountUid }),
      page,
      pageSize,
      includeFiltered: boolValue(rawQuery(url, 'includeFiltered'), false),
    });
    sendData(ctx.res, result);
  });

  /* ------------------------------------------------------------------ */
  /* 媒体                                                                */
  /* ------------------------------------------------------------------ */

  router.add('GET', '/api/media', (ctx) => {
    requireAuth(ctx, false);
    const url = ctx.url;
    const page = intQuery(url, 'page', { min: 1, def: 1 });
    const pageSize = intQuery(url, 'pageSize', { min: 1, max: 200, def: 20 });
    const kind = enumQuery(url, 'kind', MEDIA_KINDS);
    const status = enumQuery(url, 'status', MEDIA_STATUS);
    const sessionId = intQuery(url, 'sessionId', { min: 1 });
    const from = intQuery(url, 'from', { min: 0 });
    const to = intQuery(url, 'to', { min: 0 });
    const keyword = strQuery(url, 'keyword');
    const result = state.db.listMedia({
      ...(kind === undefined ? {} : { kind }),
      ...(status === undefined ? {} : { status }),
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
      ...(keyword === undefined ? {} : { keyword }),
      page,
      pageSize,
    });
    const items: MediaListItem[] = result.items.map((m) => ({
      id: m.id,
      kind: m.kind,
      status: m.status,
      size: m.size,
      mime: m.mime,
      relPath: m.relPath,
      width: m.width,
      height: m.height,
      duration: m.duration,
      failReason: m.failReason,
      sha256: m.sha256,
      createdAt: m.createdAt,
      sessionName: m.sessionName,
      messageId: m.messageId,
      ts: m.ts,
      transcript: m.transcript,
      url: `/api/media/${m.id}/raw`,
      thumbUrl: m.thumbPath ? `/api/media/${m.id}/thumb` : null,
    }));
    const page2: Page<MediaListItem> = { items, total: result.total, page: result.page, pageSize: result.pageSize };
    sendData(ctx.res, page2);
  });

  router.add(
    'GET',
    '/api/media/:id/raw',
    (ctx) => {
      requireAuth(ctx, true);
      const id = intParam(ctx.params);
      const row = state.db.getMedia(id);
      if (!row) throw notFound('媒体不存在');
      if (row.status === 'missing') throw new HttpError(410, 'MEDIA_MISSING', '媒体文件缺失');
      const abs = resolveSafePath(state.config.storage.mediaDir, row.relPath);
      assertRealPathWithin(state.config.storage.mediaDir, abs);
      if (!isRegularFile(abs)) throw notFound('媒体文件不在磁盘上');
      const size = fileSize(abs);
      const range = parseRange(ctx.req.headers.range, size);
      const type = mimeForMedia(row.mime, row.relPath);
      const inline = !(state.config.server.allowDownload && boolValue(rawQuery(ctx.url, 'download'), false));
      const disposition = contentDisposition(inline ? 'inline' : 'attachment', displayNameOf(row.relPath, row.id));
      const baseHeaders: Record<string, string> = {
        'Content-Type': type,
        'Accept-Ranges': 'bytes',
        'Content-Disposition': disposition,
        'Cache-Control': 'private, max-age=60',
      };
      applySecurityHeaders(ctx.res);
      if (range === 'unsatisfiable') {
        ctx.res.writeHead(416, {
          ...baseHeaders,
          'Content-Range': `bytes */${size}`,
          'Content-Type': 'application/json; charset=utf-8',
        });
        ctx.res.end(JSON.stringify({ error: 'Range 不可满足', code: 'RANGE_NOT_SATISFIABLE' }));
        return;
      }
      if (range) {
        const len = rangeLength(range);
        ctx.res.writeHead(206, { ...baseHeaders, 'Content-Range': `bytes ${range.start}-${range.end}/${size}`, 'Content-Length': String(len) });
        if (ctx.method === 'HEAD') ctx.res.end();
        else createReadStream(abs, { start: range.start, end: range.end }).pipe(ctx.res);
        return;
      }
      ctx.res.writeHead(200, { ...baseHeaders, 'Content-Length': String(size) });
      if (ctx.method === 'HEAD') ctx.res.end();
      else createReadStream(abs).pipe(ctx.res);
    },
    { queryAuth: true },
  );

  router.add(
    'GET',
    '/api/media/:id/thumb',
    (ctx) => {
      requireAuth(ctx, true);
      const id = intParam(ctx.params);
      const row = state.db.getMedia(id);
      if (!row || !row.thumbPath) throw notFound('缩略图不存在');
      const abs = resolveSafePath(state.config.storage.mediaDir, row.thumbPath, '缩略图');
      assertRealPathWithin(state.config.storage.mediaDir, abs, '缩略图');
      if (!isRegularFile(abs)) throw notFound('缩略图文件不在磁盘上');
      const size = fileSize(abs);
      applySecurityHeaders(ctx.res);
      ctx.res.writeHead(200, {
        'Content-Type': mimeForPath(abs) ?? 'image/jpeg',
        'Content-Length': String(size),
        'Cache-Control': 'private, max-age=300',
      });
      if (ctx.method === 'HEAD') ctx.res.end();
      else createReadStream(abs).pipe(ctx.res);
    },
    { queryAuth: true },
  );

  router.add('POST', '/api/media/:id/verify', async (ctx) => {
    requireAuth(ctx, false);
    const id = intParam(ctx.params);
    const row = state.db.getMedia(id);
    if (!row) throw notFound('媒体不存在');
    let abs: string;
    try {
      abs = resolveSafePath(state.config.storage.mediaDir, row.relPath);
      assertRealPathWithin(state.config.storage.mediaDir, abs);
    } catch (err) {
      state.db.markMediaStatus(id, 'corrupt', (err as Error).message);
      sendData(ctx.res, { id, status: 'corrupt', ok: false, reason: (err as Error).message });
      return;
    }
    if (!isRegularFile(abs)) {
      state.db.markMediaStatus(id, 'missing', '文件不在磁盘上');
      sendData(ctx.res, { id, status: 'missing', ok: false, reason: '文件不在磁盘上' });
      return;
    }
    const sha256 = await sha256File(abs);
    const matches = typeof row.sha256 === 'string' && row.sha256.length > 0 ? sha256 === row.sha256 : null;
    const status = matches === false ? 'corrupt' : 'present';
    state.db.markMediaStatus(id, status, matches === false ? 'sha256 与记录不一致' : undefined);
    sendData(ctx.res, {
      id,
      status,
      ok: matches !== false,
      sha256,
      sha256Matches: matches,
      size: fileSize(abs),
      relPath: row.relPath,
      verifiedAt: new Date().toISOString(),
    });
  });

  /* ------------------------------------------------------------------ */
  /* 语音转文字（STT）                                                    */
  /* ------------------------------------------------------------------ */

  router.add('GET', '/api/media/:id/transcript', async (ctx) => {
    requireAuth(ctx, false);
    const id = intParam(ctx.params);
    const row = state.db.getMedia(id);
    if (!row) throw notFound('媒体不存在');
    const available = await sttProbe(false);
    sendData(ctx.res, { transcript: state.db.getTranscript(id), available });
  });

  router.add('POST', '/api/media/:id/transcribe', async (ctx) => {
    requireAuth(ctx, false);
    const id = intParam(ctx.params);
    const row = state.db.getMedia(id);
    if (!row) throw notFound('媒体不存在');
    if (row.kind !== 'audio') throw badRequest('该媒体不是语音（kind !== audio），无法转写');
    if (row.status !== 'present') throw notFound(`媒体文件状态为 ${row.status}，无法转写`);
    let abs: string;
    try {
      abs = resolveSafePath(state.config.storage.mediaDir, row.relPath);
      assertRealPathWithin(state.config.storage.mediaDir, abs);
    } catch (err) {
      throw badRequest(`媒体路径不安全：${(err as Error).message}`);
    }
    if (!isRegularFile(abs)) throw notFound('媒体文件不在磁盘上，无法转写');
    const engine = await requireSttEngine();
    const result = await engine.transcribe({ path: abs, language: sttConfig.language, durationSec: row.duration ?? null });
    state.db.upsertTranscript({
      mediaId: id,
      text: result.text,
      language: result.language,
      engine: result.engine,
      model: result.model,
      segments: result.segments,
      elapsedMs: result.elapsedMs,
    });
    sendData(ctx.res, { ...result, transcript: state.db.getTranscript(id) });
  });

  router.add('POST', '/api/stt/transcribe', async (ctx) => {
    requireAuth(ctx, false);
    if (sttBatchRunning) throw new HttpError(409, 'STT_BUSY', '已有批量转写任务在运行，请稍后重试');
    const body = await readJsonBody(ctx.req);
    const limit = typeof body.limit === 'number' && Number.isFinite(body.limit) ? Math.floor(body.limit) : undefined;
    const language = typeof body.language === 'string' && body.language.trim() !== '' ? body.language : undefined;
    const engine = await requireSttEngine();
    sttBatchRunning = true;
    try {
      const stats = await transcribePending(engine, state.db, {
        mediaDir: state.config.storage.mediaDir,
        ...(limit === undefined ? {} : { limit }),
        ...(language === undefined ? {} : { language }),
        logger: state.logger.child('stt'),
      });
      sendData(ctx.res, stats);
    } finally {
      sttBatchRunning = false;
    }
  });

  router.add('POST', '/api/stt/probe', async (ctx) => {
    requireAuth(ctx, false);
    sendData(ctx.res, await sttProbe(true));
  });

  router.add('GET', '/api/stt/status', async (ctx) => {
    requireAuth(ctx, false);
    const available = await sttProbe(false);
    const pending = state.db.listUntranscribedAudio(1000).length;
    sendData(ctx.res, {
      enabled: sttConfig.enabled,
      available: available.available,
      reason: available.reason,
      engine: available.engine,
      binary: available.binary,
      ffmpeg: available.ffmpeg,
      model: available.model,
      warnings: available.warnings,
      stats: state.db.transcriptStats(),
      pending,
      running: sttBatchRunning,
    });
  });

  /* ------------------------------------------------------------------ */
  /* 任务（含 SSE）                                                       */
  /* ------------------------------------------------------------------ */

  router.add('GET', '/api/jobs', (ctx) => {
    requireAuth(ctx, false);
    const url = ctx.url;
    const page = intQuery(url, 'page', { min: 1, def: 1 });
    const pageSize = intQuery(url, 'pageSize', { min: 1, max: 200, def: 20 });
    const status = enumQuery(url, 'status', JOB_STATUS);
    const kind = enumQuery(url, 'kind', JOB_KINDS);
    const result = state.db.listJobs({
      ...(status === undefined ? {} : { status }),
      ...(kind === undefined ? {} : { kind }),
      page,
      limit: pageSize,
    });
    sendData(ctx.res, result);
  });

  router.add('GET', '/api/jobs/:id', (ctx) => {
    requireAuth(ctx, false);
    const id = intParam(ctx.params);
    const job = state.db.getJob(id);
    if (!job) throw notFound('任务不存在');
    sendData(ctx.res, job);
  });

  router.add(
    'GET',
    '/api/jobs/:id/events',
    (ctx) => {
      // EventSource 不能带请求头，因此这里允许 ?access=<token>。
      requireAuth(ctx, true);
      const id = intParam(ctx.params);
      const first = state.db.getJob(id);
      if (!first) throw notFound('任务不存在');
      const res = ctx.res;
      applySecurityHeaders(res);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const send = (event: string, payload: unknown): void => {
        if (res.writableEnded) return;
        res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
      };
      send('job', first);
      if (isTerminalJob(first.status)) {
        send('done', first);
        res.end();
        return;
      }
      let timer: ReturnType<typeof setInterval> | null = null;
      let closed = false;
      const finish = (): void => {
        if (closed) return;
        closed = true;
        if (timer) clearInterval(timer);
        if (!res.writableEnded) res.end();
      };
      timer = setInterval(() => {
        if (closed) return;
        const job = state.db.getJob(id);
        if (!job) {
          send('error', { error: '任务不存在' });
          finish();
          return;
        }
        send('progress', job);
        if (isTerminalJob(job.status)) {
          send('done', job);
          finish();
        }
      }, 1000);
      ctx.req.on('close', finish);
      ctx.req.on('error', finish);
    },
    { queryAuth: true },
  );

  /* ------------------------------------------------------------------ */
  /* 导入 / 采集                                                          */
  /* ------------------------------------------------------------------ */

  router.add('POST', '/api/import', async (ctx) => {
    requireAuth(ctx, false);
    const body = await readJsonBody(ctx.req);
    const sourcePath = body.path;
    if (typeof sourcePath !== 'string' || sourcePath.trim() === '') throw badRequest('缺少参数 path');
    if (!isAbsolute(sourcePath)) throw badRequest('path 必须是绝对路径');
    let st;
    try {
      st = statSync(sourcePath);
    } catch {
      throw notFound(`导入文件不存在：${sourcePath}`);
    }
    if (!st.isFile()) throw badRequest('path 必须指向一个普通文件（不支持目录）');
    const format = typeof body.format === 'string' && body.format !== '' ? body.format.slice(0, 32) : undefined;
    const accountUid = typeof body.accountUid === 'string' && body.accountUid !== '' ? body.accountUid : undefined;

    // 模块不可用时立即失败，不创建半成品任务。
    const probe = await loadImportModule();
    if ('error' in probe) throw new HttpError(503, 'IMPORT_UNAVAILABLE', probe.error);

    const jobId = state.db.createJob({
      kind: 'import',
      ...(format === undefined ? {} : { format }),
      ...(accountUid === undefined ? {} : { accountUid }),
      sourcePath,
    });
    runImportJob(state, jobId, { path: sourcePath, format, accountUid, importFn: probe.fn, importName: probe.name });
    sendData(ctx.res, { jobId, status: 'pending', path: sourcePath, format: format ?? null, accountUid: accountUid ?? null });
  });

  router.add('POST', '/api/collect/run', async (ctx) => {
    requireAuth(ctx, false);
    await readJsonBody(ctx.req).catch(() => ({}));
    const runner = await loadCollectRunner(state);
    if ('error' in runner) throw new HttpError(503, 'COLLECTOR_UNAVAILABLE', runner.error);
    const jobId = state.db.createJob({ kind: 'collect' });
    runCollectJob(state, jobId, runner);
    sendData(ctx.res, { jobId, status: 'pending', kind: state.config.collector.kind });
  });

  router.add('POST', '/api/collect/start', async (ctx) => {
    requireAuth(ctx, false);
    await readJsonBody(ctx.req).catch(() => ({}));
    const res = await startCollectLoop(state);
    if (res.reason !== null && !res.running) throw new HttpError(503, 'COLLECTOR_UNAVAILABLE', res.reason);
    log.info('采集循环已启动', { started: res.started, reason: res.reason });
    sendData(ctx.res, { ...res, intervalSec: state.config.collector.intervalSec });
  });

  router.add('POST', '/api/collect/stop', async (ctx) => {
    requireAuth(ctx, false);
    await readJsonBody(ctx.req).catch(() => ({}));
    const res = await stopCollectLoop(state);
    log.info('采集循环已停止', { stopped: res.stopped, reason: res.reason });
    sendData(ctx.res, res);
  });

  router.add('GET', '/api/collect/health', async (ctx) => {
    requireAuth(ctx, false);
    const kind = state.config.collector.kind;
    const states = state.db.listCollectStates();
    const runner = await loadCollectRunner(state);
    let moduleHealth: unknown = null;
    let moduleError: string | null = null;
    if ('error' in runner) {
      moduleError = runner.error;
    } else if (typeof runner.health === 'function') {
      try {
        moduleHealth = await runner.health();
      } catch (err) {
        moduleError = (err as Error).message;
      }
    }
    sendData(ctx.res, {
      kind,
      enabled: kind !== 'none',
      ok: moduleError === null && states.every((s) => s.consecutiveFailures === 0),
      baseUrl: state.config.collector.baseUrl,
      intervalSec: state.config.collector.intervalSec,
      // 定时循环是否在跑 + 能否被这个界面控制（桩实现只支持单轮采集时 controllable=false）。
      // 界面靠这两个字段决定显示"运行中/已停止"以及是否给出开始/停止按钮。
      running: hasLoopControl(runner) ? runner.isRunning() : null,
      controllable: hasLoopControl(runner),
      states,
      moduleHealth,
      moduleError,
      checkedAt: new Date().toISOString(),
    });
  });

  /* ------------------------------------------------------------------ */
  /* NapCat 扫码登录                                                      */
  /* ------------------------------------------------------------------ */

  router.add('GET', '/api/napcat/status', async (ctx) => {
    requireAuth(ctx, false);
    const conf = state.config.collector.napcat;
    const configured = Boolean(conf && conf.token !== '');
    const webuiUrl = conf?.webuiUrl ?? '';
    const client = await loadNapCatClient(state);
    if ('error' in client) {
      // 未配置/模块缺失不是 HTTP 错误：如实返回，前端据此展示引导文案
      sendData(ctx.res, {
        configured,
        webuiUrl,
        connected: false,
        isLogin: false,
        uin: null,
        error: client.error,
      });
      return;
    }
    try {
      const baseUrl = await client.connect();
      const status = await client.getLoginStatus();
      sendData(ctx.res, {
        configured,
        webuiUrl,
        connected: true,
        baseUrl,
        isLogin: status.isLogin,
        uin: status.uin ?? null,
        error: null,
      });
    } catch (err) {
      sendData(ctx.res, {
        configured,
        webuiUrl,
        connected: false,
        isLogin: false,
        uin: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  router.add('POST', '/api/napcat/qrcode', async (ctx) => {
    requireAuth(ctx, false);
    await readJsonBody(ctx.req).catch(() => ({}));
    const client = await loadNapCatClient(state);
    if ('error' in client) throw new HttpError(503, 'NAPCAT_UNAVAILABLE', client.error);
    try {
      const status = await client.getLoginStatus();
      if (status.isLogin) {
        sendData(ctx.res, { isLogin: true, uin: status.uin ?? null, png: null });
        return;
      }
      const qr = await client.getLoginQrcode();
      // 二维码 URL 本身就是一份登录凭据：只以 PNG 下发，绝不放进 JSON 明文字段，
      // 也不写进日志（logger 的脱敏规则同样覆盖 data: base64）。
      const png = qrToPngDataUrl(encodeQr(qr.url, { ecc: 'M' }), { scale: 6, margin: 4 });
      log.info('已生成登录二维码', { field: qr.source, bytes: png.length });
      sendData(ctx.res, { isLogin: false, uin: null, png, field: qr.source });
    } catch (err) {
      throw toHttpError(err);
    }
  });

  router.add('GET', '/api/napcat/accounts', async (ctx) => {
    requireAuth(ctx, false);
    const client = await loadNapCatClient(state);
    if ('error' in client) throw new HttpError(503, 'NAPCAT_UNAVAILABLE', client.error);
    try {
      const accounts = await client.listQuickLogin();
      sendData(ctx.res, { accounts });
    } catch (err) {
      throw toHttpError(err);
    }
  });

  router.add('POST', '/api/napcat/quick-login', async (ctx) => {
    requireAuth(ctx, false);
    const body = await readJsonBody(ctx.req);
    const uin = body.uin;
    if (typeof uin !== 'string' && typeof uin !== 'number') throw badRequest('缺少参数 uin');
    const value = String(uin).trim();
    if (!/^\d{4,12}$/.test(value)) throw badRequest(`uin 非法: ${value}`);
    const client = await loadNapCatClient(state);
    if ('error' in client) throw new HttpError(503, 'NAPCAT_UNAVAILABLE', client.error);
    try {
      const result = await client.quickLogin(value);
      // 「该账号已在登录流程中」是 NapCat 的正常回执，不是接口故障，因此仍回 200 + data.ok=false
      if (result.ok) log.info('已触发快捷登录', { uin: value });
      sendData(ctx.res, result);
    } catch (err) {
      throw toHttpError(err);
    }
  });

  /* ------------------------------------------------------------------ */
  /* 备份 / 恢复                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * 备份的唯一执行入口：API 路由与定时任务共用。
   *
   * 之所以必须收敛到一个函数：备份「生成快照文件」与「在 backups 表里留一行」是两件事，
   * CLI 或定时任务只要绕过入库，网页「归档管理」的最后备份时间与备份列表就会看不到这份备份
   * （曾经就是这个 bug：磁盘上有快照、backups 表 0 行、`lastBackupAt` 恒为 null）。
   */
  async function runBackupJob(opts: {
    kind: string;
    includeMedia: boolean;
    verify: boolean;
  }): Promise<{ result: Awaited<ReturnType<typeof createBackup>>; rowId: number; pruned: string[] }> {
    const result = await createBackup({
      db: state.db,
      config: state.config,
      logger: log,
      version: state.version,
      kind: opts.kind,
      includeMedia: opts.includeMedia,
      verify: opts.verify,
    });
    const rowId = state.db.createBackup({ path: result.snapshotPath, kind: opts.kind });
    const verifyText = result.verify ? (result.verify.ok ? 'ok' : result.verify.problems.join('; ')) : 'skipped';
    state.db.finishBackup(rowId, {
      status: result.ok ? 'done' : 'failed',
      sizeBytes: result.sizeBytes,
      messageCount: result.counts.messages,
      mediaCount: result.counts.media,
      dbSha256: result.sha256,
      verifyResult: verifyText,
      ...(result.ok ? {} : { error: `备份校验失败：${result.problems.join('；')}` }),
    });
    if (!result.ok) throw new HttpError(500, 'INTERNAL', `备份校验失败：${result.problems.join('；')}`);
    // 保留份数裁剪：`backup.keep` 之前只被校验、从未被消费。
    const pruned = pruneBackups({
      db: state.db,
      backupDir: state.config.storage.backupDir,
      keep: state.config.backup.keep,
      logger: log,
      protect: [result.snapshotPath],
    });
    return { result, rowId, pruned: pruned.removed };
  }

  router.add('POST', '/api/backup', async (ctx) => {
    requireAuth(ctx, false);
    const raw = await readJsonBody(ctx.req).catch((): Record<string, unknown> => ({}));
    const verify = boolValue(raw.verify, state.config.backup.verify);
    const includeMedia = boolValue(raw.includeMedia, false);
    const kind = strQuery(ctx.url, 'kind') ?? 'manual';
    const jobId = state.db.createJob({ kind: 'backup' });
    state.db.updateJob(jobId, { status: 'running', startedAt: new Date().toISOString() });
    try {
      const { result, rowId, pruned } = await runBackupJob({ kind, includeMedia, verify });
      state.db.updateJob(jobId, { status: 'done', finishedAt: new Date().toISOString(), progress: 1, message: result.snapshotPath });
      sendData(ctx.res, {
        jobId,
        backupId: rowId,
        path: result.snapshotPath,
        manifestPath: result.manifestPath,
        sha256: result.sha256,
        sizeBytes: result.sizeBytes,
        counts: result.counts,
        mediaIncluded: result.mediaIncluded,
        mediaFiles: result.mediaFiles,
        pruned,
        verify: result.verify ? { ok: result.verify.ok, quickCheck: result.verify.quickCheck } : null,
      });
    } catch (err) {
      state.db.updateJob(jobId, { status: 'failed', finishedAt: new Date().toISOString(), error: (err as Error).message });
      throw err;
    }
  });

  router.add('GET', '/api/backups', (ctx) => {
    requireAuth(ctx, false);
    const limit = intQuery(ctx.url, 'limit', { min: 1, max: 200, def: 20 });
    // 恢复演练会用快照替换当前库，那次快照自己的登记行随之消失；列给用户看之前先与磁盘对账，
    // 否则「最后一次备份」会显示成不存在，而文件其实就在备份目录里。
    try {
      reconcileBackups({ db: state.db, backupDir: state.config.storage.backupDir, logger: log });
    } catch (err) {
      log.warn('备份对账失败（继续用库里的记录）', { error: (err as Error).message });
    }
    const items = state.db.listBackups(limit).map((b) => ({
      ...b,
      exists: existsSync(b.path),
      sizeOnDisk: existsSync(b.path) ? fileSize(b.path) : 0,
      manifestPath: manifestPathOf(b.path),
      manifestExists: existsSync(manifestPathOf(b.path)),
    }));
    sendData(ctx.res, { items, total: items.length });
  });

  router.add('POST', '/api/backups/restore', async (ctx) => {
    requireAuth(ctx, false);
    const body = await readJsonBody(ctx.req);
    const backupPath = body.path;
    if (typeof backupPath !== 'string' || backupPath.trim() === '') throw badRequest('缺少参数 path');
    const dryRun = boolValue(body.dryRun, true);
    const restoreMedia = boolValue(body.restoreMedia, false);
    const result = await restoreBackup({
      db: state.db,
      config: state.config,
      logger: log,
      backupPath,
      dryRun,
      restoreMedia,
    });
    if (result.applied && result.reopened) {
      state.db = result.reopened;
      log.warn('已切换到恢复后的数据库连接', { snapshotPath: result.snapshotPath });
    }
    const { reopened, ...rest } = result;
    sendData(ctx.res, { ...rest, reopened: reopened !== null });
  });

  /* ------------------------------------------------------------------ */
  /* 日志 / 导出                                                          */
  /* ------------------------------------------------------------------ */

  router.add('GET', '/api/logs', (ctx) => {
    requireAuth(ctx, false);
    const url = ctx.url;
    const page = intQuery(url, 'page', { min: 1, def: 1 });
    const pageSize = intQuery(url, 'pageSize', { min: 1, max: 500, def: 100 });
    const level = enumQuery(url, 'level', LOG_LEVELS);
    const scope = strQuery(url, 'scope');
    const since = strQuery(url, 'since', 40);
    const result = state.db.listLogs({
      ...(level === undefined ? {} : { level }),
      ...(scope === undefined ? {} : { scope }),
      ...(since === undefined ? {} : { since }),
      page,
      limit: pageSize,
    });
    sendData(ctx.res, result);
  });

  router.add(
    'GET',
    '/api/export/session/:id',
    async (ctx) => {
      requireAuth(ctx, true);
      const id = intParam(ctx.params);
      const session = state.db.getSession(id);
      if (!session) throw notFound('会话不存在');
      const format = (enumQuery(ctx.url, 'format', EXPORT_FORMATS) ?? 'json') as ExportFormat;
      const from = intQuery(ctx.url, 'from', { min: 0 });
      const to = intQuery(ctx.url, 'to', { min: 0 });
      applySecurityHeaders(ctx.res);
      const stats = await streamSessionExport(ctx.res, {
        db: state.db,
        session,
        format,
        ...(from === undefined ? {} : { from }),
        ...(to === undefined ? {} : { to }),
        cap: state.config.server.exportMaxMessages,
      });
      log.info('会话导出完成', { sessionId: id, format, exported: stats.exported, truncated: stats.truncated });
    },
    { queryAuth: true },
  );

  /* ------------------------------------------------------------------ */
  /* HTTP 入口                                                            */
  /* ------------------------------------------------------------------ */

  const sockets = new Set<Socket>();
  const server = createHttpServer((req, res) => {
    void handleRequest(state, router, log, req, res).catch((err) => {
      log.fail('请求处理失败', err, { method: req.method, url: req.url });
      sendError(res, err, log);
    });
  });

  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('clientError', (err: Error & { code?: string }, socket: Socket) => {
    log.debug('clientError', { code: err.code ?? null });
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });
  server.keepAliveTimeout = 30_000;
  server.headersTimeout = 35_000;

  /* ------------------------------------------------------------------ */
  /* 定时自动备份                                                        */
  /* ------------------------------------------------------------------ */
  // 此前 `backup.intervalHours` / `backup.keep` 只有类型、默认值与文档，没有任何消费者：
  // 配置里写着「默认 24 小时自动备份」，实际从来没有跑过。这里补上真正的定时器。
  let backupTimer: ReturnType<typeof setInterval> | null = null;
  let autoBackupRunning = false;
  if (config.backup.intervalHours > 0) {
    const periodMs = Math.round(config.backup.intervalHours * 3_600_000);
    backupTimer = setInterval(() => {
      if (autoBackupRunning) {
        log.warn('上一轮自动备份尚未结束，跳过本轮');
        return;
      }
      autoBackupRunning = true;
      void (async () => {
        try {
          const { result, pruned } = await runBackupJob({ kind: 'auto', includeMedia: false, verify: config.backup.verify });
          log.info('自动备份完成', { snapshotPath: result.snapshotPath, messages: result.counts.messages, pruned: pruned.length });
        } catch (err) {
          log.fail('自动备份失败', err);
        } finally {
          autoBackupRunning = false;
        }
      })();
    }, periodMs);
    backupTimer.unref?.();
  }

  return {
    server,
    /** 定时自动备份是否已启用（供测试与运维确认配置真的生效）。 */
    autoBackup: { enabled: backupTimer !== null, intervalHours: config.backup.intervalHours, keep: config.backup.keep },
    /** 手动触发一轮自动备份（测试与运维用；与定时器同一入口，因此同样入库+裁剪）。 */
    runAutoBackupNow(): Promise<{ path: string; pruned: string[] }> {
      return runBackupJob({ kind: 'auto', includeMedia: false, verify: config.backup.verify }).then(({ result, pruned }) => ({
        path: result.snapshotPath,
        pruned,
      }));
    },
    close(): Promise<void> {
      if (backupTimer !== null) {
        clearInterval(backupTimer);
        backupTimer = null;
      }
      // 先停采集循环：否则关闭时可能正好有一轮采集在写库
      const stopCollect = state.collectStop;
      state.collectStop = null;
      return (async () => {
        if (stopCollect) {
          try {
            await stopCollect();
          } catch (err) {
            log.warn('停止采集循环失败（继续关闭）', { error: (err as Error).message });
          }
        }
      })().then(() => new Promise<void>((resolvePromise) => {
        for (const s of sockets) s.destroy();
        sockets.clear();
        server.close(() => resolvePromise());
        // 兜底：若仍有 keep-alive 连接未退出，强制关闭。
        setTimeout(() => {
          server.closeAllConnections?.();
          resolvePromise();
        }, 500).unref?.();
      }));
    },
  };
}

/* -------------------------------------------------------------------- */
/* 请求处理                                                              */
/* -------------------------------------------------------------------- */

async function handleRequest(
  state: ServerState,
  router: Router,
  log: ScopedLogger,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const started = Date.now();
  const rawUrl = req.url ?? '/';
  let url: URL;
  try {
    url = new URL(rawUrl, `http://${req.headers.host ?? '127.0.0.1'}`);
  } catch {
    throw new HttpError(400, 'BAD_REQUEST', 'URL 非法');
  }
  const method = (req.method ?? 'GET').toUpperCase();
  const pathname = url.pathname;

  applySecurityHeaders(res);
  res.on('finish', () => {
    const ms = Date.now() - started;
    if (ms >= 1000) log.warn('慢请求', { method, path: pathname, status: res.statusCode, ms });
  });

  let match = router.match(method, pathname);
  // HEAD 当作 GET 处理（sendJson / 静态托管 / 媒体流内部都会跳过响应体）。
  if (match === null && method === 'HEAD') match = router.match('GET', pathname);
  if (match === null) {
    if (pathname.startsWith('/api/')) {
      throw notFound(`未知接口 ${method} ${pathname}`);
    }
    serveStatic({ req, res, url, method, pathname, params: {} }, { webRoot: resolve(state.repoRoot, 'web') });
    return;
  }
  if ('allow' in match) {
    const allow = [...match.allow];
    if (method === 'OPTIONS') allow.push('OPTIONS');
    res.writeHead(405, {
      Allow: allow.join(', '),
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({ error: `方法不允许：${method} ${pathname}`, code: 'METHOD_NOT_ALLOWED' }));
    return;
  }

  const ctx: RequestContext = { req, res, url, method, pathname, params: match.params };
  const route = match.route;
  if (!route.public) {
    const payload = currentAuthFor(state, ctx, route.queryAuth);
    if (!payload) throw unauthorized('未认证或登录已过期');
  }
  await route.handler(ctx);
}

function currentAuthFor(state: ServerState, ctx: RequestContext, allowQuery: boolean): AccessPayload | null {
  let token: string | null = null;
  const authz = ctx.req.headers.authorization;
  if (typeof authz === 'string' && /^bearer\s+/i.test(authz)) token = authz.replace(/^bearer\s+/i, '').trim();
  if ((token === null || token === '') && allowQuery) token = rawQuery(ctx.url, 'access') ?? null;
  if (token === null || token === '') return null;
  const payload = verifyAccessToken(state.signingKey, token);
  if (!payload) return null;
  if (isRevoked(state.revoked, payload.jti)) return null;
  return payload;
}

/* -------------------------------------------------------------------- */
/* 辅助                                                                  */
/* -------------------------------------------------------------------- */

/**
 * 给消息补上引用（回复）目标信息：`replyPreview` 是引用内容的文本预览，
 * `replyToMessageId` 是目标消息在本库中的 id（前端据此拉详情）。
 *
 * 引用目标可能只带 QQ 的原始 id（`replyToId`）、也可能带归一化的 `replyToMsgKey`，
 * 解析顺序与作用域由 `Db.getReplyPreviews()` 负责；这里只做批次拼装，一条 SQL 搞定整页。
 */
function attachReplies<
  T extends { sessionId: number; msgKey: string; replyToId?: string | null; replyToMsgKey?: string | null },
>(db: Db, items: T[]): Array<T & {
  replyPreview: string | null;
  replyToMessageId: number | null;
  replyToSenderName: string | null;
  replyToTs: number | null;
}> {
  const refs: ReplyLookup[] = [];
  for (const m of items) {
    const msgId = m.replyToId ?? null;
    const msgKey = m.replyToMsgKey ?? null;
    if ((msgId === null || msgId === '') && (msgKey === null || msgKey === '')) continue;
    refs.push({ sessionId: m.sessionId, msgKey, msgId });
  }
  const previews = db.getReplyPreviews(refs);
  return items.map((m) => {
    const preview = previews.get(replyLookupKey({ sessionId: m.sessionId, msgKey: m.replyToMsgKey ?? null, msgId: m.replyToId ?? null }));
    return {
      ...m,
      replyPreview: preview ? preview.text : null,
      replyToMessageId: preview ? preview.id : null,
      replyToSenderName: preview ? preview.senderName : null,
      replyToTs: preview ? preview.ts : null,
    };
  });
}

function mediaUrls<T extends { media: Array<{ mediaId: number; url?: string | null; thumbUrl?: string | null }> }>(
  record: T,
  transcripts?: Map<number, { text: string }>,
): T {
  return {
    ...record,
    media: record.media.map((m) => ({
      ...m,
      url: m.url && m.url !== '' ? m.url : `/api/media/${m.mediaId}/raw`,
      thumbUrl: m.thumbUrl && m.thumbUrl !== '' ? m.thumbUrl : null,
      ...(transcripts?.has(m.mediaId) ? { transcript: transcripts.get(m.mediaId)!.text } : {}),
    })),
  };
}

/** 快照 `<name>.db` 对应的 manifest 路径。 */
function manifestPathOf(snapshotPath: string): string {
  return snapshotPath.replace(/\.db$/, '') + '.manifest.json';
}

function countScalar(db: Db, sql: string, param: number): number {
  try {
    const row = db.raw.prepare(sql).get(param) as Record<string, unknown> | undefined;
    if (!row) return 0;
    const v = Object.values(row)[0];
    return typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : 0;
  } catch {
    return 0;
  }
}

/** 后台执行导入任务（不阻塞 HTTP 响应）。 */
function runImportJob(
  state: ServerState,
  jobId: number,
  spec: { path: string; format?: string | undefined; accountUid?: string | undefined; importFn: LooseFn; importName: string },
): void {
  const log = state.logger.child('import');
  state.db.updateJob(jobId, { status: 'running', startedAt: new Date().toISOString() });
  void (async () => {
    try {
      // packages/import 的 `runImport()` 契约是 `filePath`（不是 `path`），且必须显式传
      // `mediaDir` 才会创建内容寻址归档器 —— 少传它会导致消息入库但**媒体全部不落盘**。
      // 这两个字段此前对不上，使 Web 界面的「手动导入」100% 失败（实测报
      // `The "path" argument must be of type string or an instance of Buffer or URL. Received undefined`）。
      const result = await spec.importFn({
        db: state.db,
        config: state.config,
        logger: log,
        jobId,
        filePath: spec.path,
        path: spec.path,
        mediaDir: state.config.storage.mediaDir,
        batchId: jobId,
        ...(spec.format === undefined ? {} : { format: spec.format }),
        ...(spec.accountUid === undefined ? {} : { accountUid: spec.accountUid }),
        repoRoot: state.repoRoot,
      });
      const stats = numericStats(result);
      const progress = typeof (result as { progress?: unknown } | null)?.progress === 'number' ? (result as { progress: number }).progress : 1;
      state.db.updateJob(jobId, {
        status: 'done',
        finishedAt: new Date().toISOString(),
        progress,
        ...('totalItems' in stats ? { totalItems: stats.totalItems } : {}),
        ...('processed' in stats ? { processed: stats.processed } : {}),
        ...('inserted' in stats ? { inserted: stats.inserted } : {}),
        ...('duplicate' in stats ? { duplicate: stats.duplicate } : {}),
        ...('failed' in stats ? { failed: stats.failed } : {}),
        ...('mediaSaved' in stats ? { mediaSaved: stats.mediaSaved } : {}),
        ...('mediaMissing' in stats ? { mediaMissing: stats.mediaMissing } : {}),
        stats: result,
      });
      log.info('导入任务完成', { jobId, entry: spec.importName, stats });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      state.db.updateJob(jobId, { status: 'failed', finishedAt: new Date().toISOString(), error: message });
      log.fail('导入任务失败', err, { jobId });
    } finally {
      state.running.delete(jobId);
    }
  })();
  state.running.add(jobId);
}

/** 后台执行一次采集。 */
function runCollectJob(state: ServerState, jobId: number, runner: CollectRunner): void {
  const log = state.logger.child('collect');
  state.db.updateJob(jobId, { status: 'running', startedAt: new Date().toISOString() });
  void (async () => {
    try {
      const result = await runner.runOnce({
        db: state.db,
        config: state.config,
        logger: log,
        jobId,
      });
      const stats = numericStats(result);
      state.db.updateJob(jobId, {
        status: 'done',
        finishedAt: new Date().toISOString(),
        progress: 1,
        stats: result,
        ...jobCounters(stats),
      });
      log.info('采集完成', { jobId, stats });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      state.db.updateJob(jobId, { status: 'failed', finishedAt: new Date().toISOString(), error: message });
      log.fail('采集失败', err, { jobId });
    } finally {
      state.running.delete(jobId);
    }
  })();
  state.running.add(jobId);
}
