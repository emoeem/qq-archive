/**
 * 配置系统。
 *
 * 规则：
 *  - 配置文件为 JSON（默认 `config.json`，可用 `QQ_ARCHIVE_CONFIG` 指定路径）。
 *  - 环境变量可覆盖任意一项（`QQ_ARCHIVE_<SECTION>_<KEY>`），便于 systemd 注密。
 *  - 密钥（auth.token、collector.token）**不得**写死在源码里；配置文件权限建议 600。
 *  - 默认仅监听 127.0.0.1，远程访问必须显式改 host 并设置强 token。
 */
import { readFileSync, writeFileSync, renameSync, statSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface ServerConfig {
  host: string;
  port: number;
  /** 访问令牌；为空表示未设置（首次启动会自动生成并写回配置文件）。 */
  token: string;
  /** 会话有效期（秒）。 */
  sessionTtlSec: number;
  /** 是否允许下载原始媒体（关闭后仅允许预览）。 */
  allowDownload: boolean;
  /** 单次导出上限（消息条数）。 */
  exportMaxMessages: number;
  /** 是否信任反向代理的 X-Forwarded-For。 */
  trustProxy: boolean;
}

export interface StorageConfig {
  /** 数据目录（数据库、媒体、日志都放这里）。 */
  dataDir: string;
  /** SQLite 文件路径；空则使用 `<dataDir>/archive.db`。 */
  dbPath: string;
  /** 媒体根目录；空则使用 `<dataDir>/media`。 */
  mediaDir: string;
  /** 备份目录；空则使用 `<dataDir>/backups`。 */
  backupDir: string;
  /** 日志目录；空则使用 `<dataDir>/logs`。 */
  logDir: string;
}

export interface BackupConfig {
  /** 自动备份间隔（小时）；0 = 关闭。 */
  intervalHours: number;
  /** 保留最近 N 份备份。 */
  keep: number;
  /** 备份前做完整性检查（quick_check + 逐文件 sha256）。 */
  verify: boolean;
}

export interface AlertConfig {
  /** 磁盘剩余空间低于该值（GB）时告警。 */
  diskLowGb: number;
  /** 采集连续失败达到该次数时告警。 */
  collectFailureThreshold: number;
  /** webhook 告警地址（可选）。 */
  webhookUrl: string;
}

export interface CollectorConfig {
  /** onebot = NapCat/LLOneBot 等实现的 OneBot v11 HTTP 接口。 */
  kind: 'onebot' | 'none';
  /** OneBot HTTP 基础地址，例如 http://127.0.0.1:3000 */
  baseUrl: string;
  /** 访问令牌（若 OneBot 侧配置了 token）。 */
  token: string;
  /** 轮询间隔（秒）。 */
  intervalSec: number;
  /** 每轮每个会话回溯的时间窗（秒），用于补齐间隔期消息。 */
  lookbackSec: number;
  /** 首次运行回溯天数。 */
  initialBackfillDays: number;
  /** 每次请求最多拉取条数。 */
  pageSize: number;
  /** 单会话单轮最大拉取页数（防止无限翻页）。 */
  maxPagesPerRound: number;
  /** 是否采集并归档媒体。 */
  syncMedia: boolean;
  /** 单个媒体最大字节数；超过则只记录元数据。 */
  maxMediaBytes: number;
  /** 是否随消息一起拉取会话列表（关闭时使用静态会话清单）。 */
  discoverSessions: boolean;
  /**
   * 合并转发展开的最大嵌套深度（0 = 不展开，只留 `[合并转发]` 占位）。
   *
   * 转发段只带一个 id，内容需要用 `get_forward_msg` 单独拉。展开后的子消息正文写进
   * `messages.extra.forward`，子消息里的媒体平铺进父消息资源一起归档。
   */
  forwardDepth?: number;
  /** 单条转发最多展开多少个子消息节点（防止超大转发撑爆内存与数据库）。 */
  forwardMaxNodes?: number;
  /** 静态会话清单（discoverSessions=false 时使用），形如 `group:123456` / `private:10001`。 */
  sessions: string[];
  /** NapCat WebUI 接入（扫码登录 / 快捷登录）；缺省视为未配置。 */
  napcat?: NapCatWebUiConfig;
}

/**
 * NapCat **WebUI** 接入参数（扫码登录）。
 *
 * 注意：这与采集用的 OneBot 接口是**两套不同的接口**：
 *  - OneBot（`collector.baseUrl`，默认 127.0.0.1:3000）用于只读拉取消息；
 *  - WebUI（本配置，默认 127.0.0.1:6099）用于扫码登录、查询登录态、快捷登录。
 * token 取自 NapCat 的 `config/webui.json`；留空表示不启用扫码登录界面（不影响消息归档）。
 */
export interface NapCatWebUiConfig {
  /** WebUI 基址；NapCat 端口被占用时会自增，客户端按 probeRange 自动探测。 */
  webuiUrl: string;
  /** WebUI token（NapCat `config/webui.json` 中的 token），绝不写入日志。 */
  token: string;
  /** 端口自增探测范围（默认 20，即 6099..6119）。 */
  probeRange: number;
}

/**
 * 语音转文字（STT）配置。
 *
 * 默认 **关闭**：STT 需要本机安装 whisper.cpp（`whisper-cli`）与一个 ggml 模型，
 * 这两样都不是纯 JS 依赖，装不上时不许让归档主流程失败。开启方式：
 *   - `stt.enabled = true`，并给出 `stt.model` 指向本地 ggml 模型路径；
 *   - 然后跑 `qq-archive transcribe`。
 *
 * `language` 用 ISO-639-1（`zh` / `en`…）或 `auto`。**不要**指向 `*.en.bin` 这类
 * 英文专用模型去转中文——whisper.cpp 的英文专用模型在中文语音上会给出近乎空的输出。
 */
export interface SttConfig {
  /** 是否允许 `transcribe` 子命令真正执行（false 时命令直接拒绝并说明原因）。 */
  enabled: boolean;
  /** 引擎标识；目前只实现 `whisper-cli`。 */
  engine: 'whisper-cli';
  /** whisper.cpp 可执行文件名或绝对路径（默认 `whisper-cli`）。 */
  binary: string;
  /** ffmpeg 可执行文件名或绝对路径，用于把 amr/silk 等转成 16kHz 单声道 wav。 */
  ffmpeg: string;
  /** ggml 模型文件绝对路径（必需；留空视为未配置）。 */
  model: string;
  /** 目标语言，`auto` 表示交给 whisper 自动判定。 */
  language: string;
  /** 可选 Silero VAD 模型路径；配置后启用 `--vad`。 */
  vadModel: string;
  /** whisper-cli 线程数。 */
  threads: number;
  /** 单条语音的最长处理时间（毫秒）。 */
  timeoutMs: number;
  /** 超过该时长的音频跳过不转写（秒），避免一条长录音拖死整批。 */
  maxDurationSec: number;
}

export interface AppConfig {
  server: ServerConfig;
  storage: StorageConfig;
  backup: BackupConfig;
  alert: AlertConfig;
  collector: CollectorConfig;
  /**
   * 语音转文字配置。
   *
   * 与 `collector.forwardDepth` 同理，做成**可选**以兼容旧配置文件与手工构造的
   * `AppConfig` 字面量；读取请统一走 `sttConfigOf(cfg)`（缺失时回落到默认值）。
   */
  stt?: SttConfig;
  /**
   * 日志保留策略（可选，读取走 `logsConfigOf(cfg)`）。
   *
   * 只管**数据库里的 logs 表**（只记 warn/error，量很小，供网页「日志」页展示）；
   * 文件日志的体积轮转由 logger 自己处理，与此无关。
   */
  logs?: LogsConfig;
  /** 采集过滤规则（可选，读取走 `filtersConfigOf(cfg)`；默认全关，行为与不加该功能一致）。 */
  filters?: Partial<FiltersConfig>;
}

export interface LogsConfig {
  /** 数据库日志保留天数；0 = 不清理。 */
  dbKeepDays: number;
}

export const DEFAULT_LOGS_CONFIG: LogsConfig = {
  dbKeepDays: 30,
};

/** 取日志保留配置；`AppConfig` 里没有 `logs` 段时回落到默认值。 */
export function logsConfigOf(cfg: AppConfig): LogsConfig {
  return { ...DEFAULT_LOGS_CONFIG, ...(cfg.logs ?? {}) };
}

/**
 * 采集过滤规则（可选，读取走 `filtersConfigOf(cfg)`）。
 *
 * **默认只标记、不丢弃**（`drop: false`）：命中规则的消息照样入库，只是被打上
 * `filtered` 标记、默认不在时间线/搜索里显示，随时可以"包含已过滤"或导出取回。
 * 这是刻意的 —— 本系统的目标是**防丢失**，过滤只用来"少看点"，不该变成"少存点"。
 * 真的要跳过存储（比如某些群只想留个空壳），把 `drop` 设成 true，那时命中规则的消息
 * 连库都不进，只计入采集统计。
 */
export interface FiltersConfig {
  /** 整体开关；false 时下面的规则一律不生效。 */
  enabled: boolean;
  /** 命中任一关键词即视为过滤（子串匹配，大小写不敏感）。 */
  excludeKeywords: string[];
  /** 命中任一发送者即视为过滤（可用 QQ 号、uid 或昵称）。 */
  excludeSenders: string[];
  /** 命中任一消息类型即视为过滤，例如 ["system","json"]。 */
  excludeTypes: string[];
  /** 命中规则的消息是否**连库都不进**。默认 false（只标记，保留数据）。 */
  drop: boolean;
}

export const DEFAULT_FILTERS_CONFIG: FiltersConfig = {
  enabled: false,
  excludeKeywords: [],
  excludeSenders: [],
  excludeTypes: [],
  drop: false,
};

/** 取采集过滤配置；缺段时回落默认值（默认全关，行为与加这个功能之前完全一致）。 */
export function filtersConfigOf(cfg: AppConfig): FiltersConfig {
  const raw = cfg.filters ?? {};
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : [];
  return {
    enabled: raw.enabled ?? DEFAULT_FILTERS_CONFIG.enabled,
    excludeKeywords: arr(raw.excludeKeywords),
    excludeSenders: arr(raw.excludeSenders),
    excludeTypes: arr(raw.excludeTypes),
    drop: raw.drop ?? DEFAULT_FILTERS_CONFIG.drop,
  };
}

/**
 * STT 默认值。
 *
 * 单独抽成具名常量（而不是内联在 `DEFAULT_CONFIG` 里）是为了让 `sttConfigOf()`
 * 能拿到**非可选**的完整默认值：`DEFAULT_CONFIG.stt` 的类型是 `SttConfig | undefined`，
 * 直接展开会得到一堆可选属性，赋值回 `SttConfig` 会类型报错。
 */
export const DEFAULT_STT_CONFIG: SttConfig = {
  enabled: false,
  engine: 'whisper-cli',
  binary: 'whisper-cli',
  ffmpeg: 'ffmpeg',
  model: '',
  language: 'zh',
  vadModel: '',
  threads: 4,
  timeoutMs: 600_000,
  maxDurationSec: 600,
};

/** 取 STT 配置；`AppConfig` 里没有 `stt` 段（旧配置/测试字面量）时回落到默认值。 */
export function sttConfigOf(cfg: AppConfig): SttConfig {
  return { ...DEFAULT_STT_CONFIG, ...(cfg.stt ?? {}) };
}

export const DEFAULT_CONFIG: AppConfig = {
  server: {
    host: '127.0.0.1',
    port: 8787,
    token: '',
    sessionTtlSec: 7 * 24 * 3600,
    allowDownload: true,
    exportMaxMessages: 200000,
    trustProxy: false,
  },
  storage: {
    dataDir: './data',
    dbPath: '',
    mediaDir: '',
    backupDir: '',
    logDir: '',
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
    forwardDepth: 3,
    forwardMaxNodes: 200,
    napcat: { webuiUrl: 'http://127.0.0.1:6099', token: '', probeRange: 20 },
  },
  stt: DEFAULT_STT_CONFIG,
  logs: DEFAULT_LOGS_CONFIG,
  filters: DEFAULT_FILTERS_CONFIG,
};

function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === null || patch === undefined) return base;
  if (typeof patch !== 'object' || Array.isArray(patch)) return patch as T;
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return patch as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    out[k] = k in out ? deepMerge((base as Record<string, unknown>)[k], v) : v;
  }
  return out as T;
}

function envOverlay(cfg: AppConfig): AppConfig {
  const env = process.env;
  const num = (v: string | undefined, d: number) => (v === undefined || v === '' ? d : Number(v));
  const bool = (v: string | undefined, d: boolean) =>
    v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v);
  const patch: Record<string, Record<string, unknown>> = {};
  const server: Record<string, unknown> = {};
  if (env.QQ_ARCHIVE_HOST) server.host = env.QQ_ARCHIVE_HOST;
  if (env.QQ_ARCHIVE_PORT) server.port = num(env.QQ_ARCHIVE_PORT, cfg.server.port);
  if (env.QQ_ARCHIVE_TOKEN) server.token = env.QQ_ARCHIVE_TOKEN;
  if (env.QQ_ARCHIVE_TRUST_PROXY) server.trustProxy = bool(env.QQ_ARCHIVE_TRUST_PROXY, cfg.server.trustProxy);
  if (Object.keys(server).length) patch.server = server;

  const storage: Record<string, unknown> = {};
  if (env.QQ_ARCHIVE_DATA_DIR) storage.dataDir = env.QQ_ARCHIVE_DATA_DIR;
  if (env.QQ_ARCHIVE_DB_PATH) storage.dbPath = env.QQ_ARCHIVE_DB_PATH;
  if (env.QQ_ARCHIVE_MEDIA_DIR) storage.mediaDir = env.QQ_ARCHIVE_MEDIA_DIR;
  if (env.QQ_ARCHIVE_BACKUP_DIR) storage.backupDir = env.QQ_ARCHIVE_BACKUP_DIR;
  if (Object.keys(storage).length) patch.storage = storage;

  const collector: Record<string, unknown> = {};
  if (env.QQ_ARCHIVE_COLLECTOR_KIND) collector.kind = env.QQ_ARCHIVE_COLLECTOR_KIND;
  if (env.QQ_ARCHIVE_COLLECTOR_URL) collector.baseUrl = env.QQ_ARCHIVE_COLLECTOR_URL;
  if (env.QQ_ARCHIVE_COLLECTOR_TOKEN) collector.token = env.QQ_ARCHIVE_COLLECTOR_TOKEN;
  if (env.QQ_ARCHIVE_COLLECTOR_INTERVAL) collector.intervalSec = num(env.QQ_ARCHIVE_COLLECTOR_INTERVAL, cfg.collector.intervalSec);
  const napcat: Record<string, unknown> = {};
  if (env.QQ_ARCHIVE_NAPCAT_WEBUI_URL) napcat.webuiUrl = env.QQ_ARCHIVE_NAPCAT_WEBUI_URL;
  if (env.QQ_ARCHIVE_NAPCAT_TOKEN) napcat.token = env.QQ_ARCHIVE_NAPCAT_TOKEN;
  if (Object.keys(napcat).length) collector.napcat = napcat;
  if (Object.keys(collector).length) patch.collector = collector;

  const sttDefaults = sttConfigOf(cfg);
  const stt: Record<string, unknown> = {};
  if (env.QQ_ARCHIVE_STT_ENABLED) stt.enabled = bool(env.QQ_ARCHIVE_STT_ENABLED, sttDefaults.enabled);
  if (env.QQ_ARCHIVE_STT_BINARY) stt.binary = env.QQ_ARCHIVE_STT_BINARY;
  if (env.QQ_ARCHIVE_STT_FFMPEG) stt.ffmpeg = env.QQ_ARCHIVE_STT_FFMPEG;
  if (env.QQ_ARCHIVE_STT_MODEL) stt.model = env.QQ_ARCHIVE_STT_MODEL;
  if (env.QQ_ARCHIVE_STT_LANGUAGE) stt.language = env.QQ_ARCHIVE_STT_LANGUAGE;
  if (env.QQ_ARCHIVE_STT_VAD_MODEL) stt.vadModel = env.QQ_ARCHIVE_STT_VAD_MODEL;
  if (env.QQ_ARCHIVE_STT_THREADS) stt.threads = num(env.QQ_ARCHIVE_STT_THREADS, sttDefaults.threads);
  if (env.QQ_ARCHIVE_STT_TIMEOUT_MS) stt.timeoutMs = num(env.QQ_ARCHIVE_STT_TIMEOUT_MS, sttDefaults.timeoutMs);
  if (Object.keys(stt).length) patch.stt = stt;

  const alert: Record<string, unknown> = {};
  if (env.QQ_ARCHIVE_DISK_LOW_GB) alert.diskLowGb = num(env.QQ_ARCHIVE_DISK_LOW_GB, cfg.alert.diskLowGb);
  if (env.QQ_ARCHIVE_ALERT_WEBHOOK) alert.webhookUrl = env.QQ_ARCHIVE_ALERT_WEBHOOK;
  if (Object.keys(alert).length) patch.alert = alert;

  const logDefaults = logsConfigOf(cfg);
  const logs: Record<string, unknown> = {};
  if (env.QQ_ARCHIVE_LOG_KEEP_DAYS) logs.dbKeepDays = num(env.QQ_ARCHIVE_LOG_KEEP_DAYS, logDefaults.dbKeepDays);
  if (Object.keys(logs).length) patch.logs = logs;
  return deepMerge(cfg, patch);
}

export interface LoadedConfig {
  config: AppConfig;
  path: string;
  /** 是否因为配置文件不存在而使用了默认值。 */
  defaultsUsed: boolean;
  /**
   * 令牌是否为**临时**的：本次运行随机生成且**未能写回**配置文件。
   *
   * 为 true 时，每一次启动都会得到不同的令牌，`qq-archive token` 打印的值与正在运行
   * 的进程不一致 —— 调用方（doctor / serve / token）**必须**把这个状态显式告警出来，
   * 不能当成「令牌已配置」。写回成功时为 false。
   */
  tokenGenerated: boolean;
}

/**
 * 去掉 JSON 里的 `//` 与 `/* *\/` 注释，让 `config.json` 能像文档示例那样带注释。
 *
 * 必须是**字符串感知**的：`"http://127.0.0.1:3000"` 里的 `//` 是值的一部分，
 * 用正则一把梭会把它删掉、把配置改坏 —— 那比"不支持注释"更糟（用户不会想到是注释处理干的）。
 * 同时处理 `\"` 转义，保证字符串边界判断正确。
 */
export function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i] as string;
    const next = text[i + 1];
    if (inLine) {
      if (c === '\n') {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === '*' && next === '/') {
        inBlock = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === '/' && next === '/') {
      inLine = true;
      i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      inBlock = true;
      i += 1;
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * 去掉对象/数组末尾多余的逗号（`{"a":1,}`）。
 *
 * 手写配置最常见的两个小错就是「多打一个逗号」和「加注释」，两个都容错，
 * 用户就不必为了改一行配置去翻 JSON 规范。同样字符串感知。
 */
export function stripTrailingCommas(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i] as string;
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === ',') {
      // 向后跳过空白，看看是不是紧跟着 } 或 ]
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j] as string)) j += 1;
      const after = text[j];
      if (after === '}' || after === ']') continue; // 丢掉这个逗号
    }
    out += c;
  }
  return out;
}

/** 按「JSONC + 容忍尾逗号」解析配置文本；失败时把文件路径带进错误信息，便于定位。 */
export function parseConfigText(text: string, path: string): unknown {
  try {
    return JSON.parse(stripTrailingCommas(stripJsonComments(text)));
  } catch (err) {
    throw new Error(`配置文件不是合法 JSON：${path}\n  ${(err as Error).message}`);
  }
}

/** 加载配置：默认值 ← 配置文件 ← 环境变量。 */
export function loadConfig(configPath?: string): LoadedConfig {
  // 空字符串一律按"没设置"处理：`QQ_ARCHIVE_CONFIG= qq-archive stats` 是常见的 shell 写法
  // （比如用它清掉父进程传下来的值），而 `??` 只认 null/undefined —— 直接拿 '' 去 resolve
  // 会得到当前目录，接着 readFileSync 目录抛 EISDIR，报错信息与真实原因毫无关系。
  // 本项目其它环境变量（envOverlay 里那些）也遵循"空=未设置"的约定，这里保持一致。
  const fromEnv = (process.env.QQ_ARCHIVE_CONFIG ?? '').trim();
  const explicit = typeof configPath === 'string' && configPath.trim() !== '' ? configPath : undefined;
  const path = resolve(explicit ?? (fromEnv !== '' ? fromEnv : './config.json'));
  let fileCfg: unknown = {};
  let defaultsUsed = false;
  if (existsSync(path)) {
    if (statSync(path).isDirectory()) {
      throw new Error(`配置路径指向一个目录（应该是文件）：${path}`);
    }
    fileCfg = parseConfigText(readFileSync(path, 'utf8'), path);
  } else {
    defaultsUsed = true;
  }
  let merged = envOverlay(deepMerge(structuredClone(DEFAULT_CONFIG), fileCfg));
  let tokenGenerated = false;
  if (!merged.server.token) {
    merged.server.token = randomBytes(24).toString('base64url');
    tokenGenerated = true;
    // 写回配置文件。否则每次启动都会换一个随机令牌：`qq-archive token` 打印的值
    // 与正在运行的进程不一致，用户永远无法登录，且没有任何办法查回运行中的令牌。
    if (!defaultsUsed) tokenGenerated = !persistToken(path, merged.server.token);
  }
  merged = resolvePaths(merged, path);
  return { config: merged, path, defaultsUsed, tokenGenerated };
}

/**
 * 把自动生成的令牌原子写回配置文件（保留原文件权限，例如 600）。
 * 返回是否写入成功；失败时调用方必须继续用临时令牌并告警，而不是静默使用。
 *
 * 写入方式是**文本定点替换**而不是「解析成对象再整体序列化」：后者会把用户手写的
 * `//` 注释、字段顺序、缩进全部抹掉 —— 用户只是想让程序把令牌填上，不该因此丢掉自己的注释。
 * 只有在找不到空 token 字段时才退回整体序列化。
 */
function persistToken(path: string, token: string): boolean {
  try {
    const text = readFileSync(path, 'utf8');
    const mode = statSync(path).mode & 0o777;
    const tmp = `${path}.tmp-${process.pid}`;

    // 令牌此刻一定是空的（否则不会走到这里），所以替换 `"token": ""` 是安全的定点操作。
    const svcPattern = /("token"\s*:\s*)(""|'')(\s*[,}])/;
    let next: string | null = null;
    if (svcPattern.test(text)) {
      next = text.replace(svcPattern, (_m, head: string, _empty: string, tail: string) => `${head}${JSON.stringify(token)}${tail}`);
    }
    if (next === null) {
      // 没找到空 token（可能是没写 server.token 字段）：退回整体序列化，至少让令牌能落盘。
      const raw = parseConfigText(text, path) as Record<string, unknown>;
      const server = (raw.server && typeof raw.server === 'object' ? raw.server : {}) as Record<string, unknown>;
      server.token = token;
      raw.server = server;
      next = `${JSON.stringify(raw, null, 2)}\n`;
    }

    writeFileSync(tmp, next, { encoding: 'utf8', mode });
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

/** 把相对路径解析为相对配置文件所在目录的绝对路径。 */
export function resolvePaths(cfg: AppConfig, configPath: string): AppConfig {
  const base = resolve(configPath, '..');
  const abs = (p: string) => (p ? resolve(base, p) : p);
  const s = cfg.storage;
  s.dataDir = abs(s.dataDir) || resolve(base, 'data');
  if (!s.dbPath) s.dbPath = resolve(s.dataDir, 'archive.db');
  else s.dbPath = abs(s.dbPath);
  if (!s.mediaDir) s.mediaDir = resolve(s.dataDir, 'media');
  else s.mediaDir = abs(s.mediaDir);
  if (!s.backupDir) s.backupDir = resolve(s.dataDir, 'backups');
  else s.backupDir = abs(s.backupDir);
  if (!s.logDir) s.logDir = resolve(s.dataDir, 'logs');
  else s.logDir = abs(s.logDir);
  return cfg;
}

/** 配置校验：返回人类可读的问题列表（空数组=通过）。 */
export function validateConfig(cfg: AppConfig): string[] {
  const problems: string[] = [];
  if (!Number.isInteger(cfg.server.port) || cfg.server.port < 1 || cfg.server.port > 65535) {
    problems.push(`server.port 非法: ${cfg.server.port}`);
  }
  if (cfg.server.token.length < 16) problems.push('server.token 太短（至少 16 字符），请重新生成');
  // 把示例配置里的占位说明（「请替换为至少 32 位随机字符串…」）直接留在 token 里，
  // 长度必然合格、doctor 的旧检查会放行，但它是一个**公开可猜**的令牌。
  if (/[^\x21-\x7e]/.test(cfg.server.token)) {
    problems.push('server.token 含空格或非 ASCII 字符（疑似示例占位文本未替换），请换成随机字符串');
  }
  const remoteHost = cfg.server.host !== '127.0.0.1' && cfg.server.host !== 'localhost' && cfg.server.host !== '::1';
  if (remoteHost && cfg.server.token.length < 24) {
    problems.push('监听非本机地址时 server.token 至少 24 字符');
  }
  if (cfg.collector.kind === 'onebot' && !/^https?:\/\//.test(cfg.collector.baseUrl)) {
    problems.push(`collector.baseUrl 非法: ${cfg.collector.baseUrl}`);
  }
  if (cfg.collector.intervalSec < 5) problems.push('collector.intervalSec 不得小于 5 秒');
  // 扫码登录是可选项：只有填了 token 才校验地址，避免默认配置直接报错。
  const napcat = cfg.collector.napcat;
  if (napcat && napcat.token !== '' && !/^https?:\/\//.test(napcat.webuiUrl)) {
    problems.push(`collector.napcat.webuiUrl 非法: ${napcat.webuiUrl}`);
  }
  if (napcat && (!Number.isInteger(napcat.probeRange) || napcat.probeRange < 0 || napcat.probeRange > 100)) {
    problems.push(`collector.napcat.probeRange 非法: ${String(napcat.probeRange)}（应为 0..100）`);
  }
  if (cfg.backup.keep < 1) problems.push('backup.keep 至少为 1');
  const logs = logsConfigOf(cfg);
  if (!Number.isInteger(logs.dbKeepDays) || logs.dbKeepDays < 0) {
    problems.push(`logs.dbKeepDays 非法: ${String(logs.dbKeepDays)}（应为 >= 0 的整数，0 表示不清理）`);
  }
  const filters = filtersConfigOf(cfg);
  if (filters.enabled && filters.excludeKeywords.length === 0 && filters.excludeSenders.length === 0 && filters.excludeTypes.length === 0) {
    problems.push('filters.enabled 为 true 但一条规则都没配（三个列表都是空的），这不会过滤任何东西');
  }
  if (cfg.alert.diskLowGb < 0) problems.push('alert.diskLowGb 不得为负');
  return problems;
}
