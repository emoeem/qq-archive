/**
 * web/lib.js —— 前端纯函数工具库。
 *
 * 约束（硬性）：
 *  - 纯函数：不得触碰任何浏览器全局对象，也不得发起网络请求；可在 node:test 里直接 import。
 *  - 所有格式化、标签、URL 拼接、转义、hash 解析都放这里，方便单测覆盖。
 *
 * 时间语义：与后端一致，一律使用**毫秒整数**时间戳；无效值（null/NaN/<=0）返回占位符 '—'。
 */

/** 占位符（空值统一展示）。 */
export const PLACEHOLDER = '—';

/**
 * 应用路由表（hash 第一段）。
 *
 * ⚠️ 这张表必须与 `app.js` 里的 `NAV`（侧边栏）和 `VIEWS`（视图注册）保持一致：
 * `parseHash()` 对**不在表里**的路由会静默回退到 `DEFAULT_ROUTE`，于是表现成
 * 「点了侧边栏、地址栏也变了，但页面内容不动」——非常难查。
 * 真实踩过：`qq` 漏在这张表里，导致整个「QQ 登录」页打不开。
 * `tests/web.test.ts` 里有一条用例专门核对这三个列表是否一致。
 */
export const ROUTES = ['overview', 'qq', 'chats', 'media', 'archive', 'logs', 'export', 'login'];

/** 未知/空 hash 的回退路由。 */
export const DEFAULT_ROUTE = 'overview';

/** 是否有限数字。 */
export function isFiniteNumber(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

/** 毫秒时间戳 → `YYYY-MM-DD HH:mm:ss`（本地时区）。无效返回 '—'。 */
export function formatTime(ts) {
  if (!isFiniteNumber(ts) || ts <= 0) return PLACEHOLDER;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return PLACEHOLDER;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 宽松时间格式化：接受毫秒数字、秒级数字、ISO / `YYYY-MM-DD HH:mm:ss` 字符串。
 * 用于 stats.lastCollectAt / backup.finishedAt 这类后端返回 ISO 字符串的字段。
 */
export function formatIso(value) {
  if (value === null || value === undefined || value === '') return PLACEHOLDER;
  if (isFiniteNumber(value)) return formatTime(value);
  const s = String(value).trim();
  if (s === '') return PLACEHOLDER;
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return formatTime(n < 1e12 ? n * 1000 : n);
  }
  const parsed = Date.parse(s);
  if (!Number.isFinite(parsed)) return PLACEHOLDER;
  return formatTime(parsed);
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前；超过 30 天回退绝对时间。 */
export function formatRelative(ts, now = Date.now()) {
  if (!isFiniteNumber(ts) || ts <= 0) return PLACEHOLDER;
  const diff = now - ts;
  if (!isFiniteNumber(diff) || diff < 0) return formatTime(ts);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return '刚刚';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} 天前`;
  return formatTime(ts);
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/** 字节数 → 人类可读（1024 进制，>1 单位保留 1 位小数）。 */
export function formatBytes(n) {
  if (!isFiniteNumber(n) || n < 0) return PLACEHOLDER;
  if (n < 1024) return `${Math.trunc(n)} B`;
  let i = 0;
  let v = n;
  while (v >= 1024 && i < BYTE_UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  let s = v.toFixed(1);
  // 四舍五入后进位到 1024.0 时，改用更大的单位（1048575 B → 1.0 MB，而不是 1024.0 KB）。
  if (s === '1024.0' && i < BYTE_UNITS.length - 1) {
    v /= 1024;
    i++;
    s = v.toFixed(1);
  }
  return `${s} ${BYTE_UNITS[i]}`;
}

/** 计数 → 千分位十进制字符串（1203551 → `1,203,551`）。非有限数字返回 '—'。 */
export function formatCount(n) {
  if (!isFiniteNumber(n)) return PLACEHOLDER;
  return Math.trunc(n).toLocaleString('en-US');
}

/** 秒数 → `m:ss` / `h:mm:ss`。 */
export function formatDuration(seconds) {
  if (!isFiniteNumber(seconds) || seconds < 0) return PLACEHOLDER;
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}

const CHAT_TYPE_LABELS = {
  group: '群聊',
  private: '私聊',
  temp: '临时会话',
  other: '其他',
};

/** 会话类型中文标签。 */
export function chatTypeLabel(t) {
  return CHAT_TYPE_LABELS[String(t ?? '').toLowerCase()] ?? '未知';
}

const MSG_TYPE_LABELS = {
  text: '文本',
  image: '图片',
  video: '视频',
  audio: '语音',
  file: '文件',
  face: '表情',
  reply: '回复',
  forward: '转发',
  json: '卡片',
  location: '位置',
  system: '系统',
  other: '其他',
};

/** 消息类型中文标签。 */
export function msgTypeLabel(t) {
  return MSG_TYPE_LABELS[String(t ?? '').toLowerCase()] ?? '其他';
}

const MEDIA_KIND_LABELS = {
  image: '图片',
  video: '视频',
  audio: '音频',
  file: '文件',
  other: '其他',
};

/** 媒体种类中文标签。 */
export function mediaKindLabel(k) {
  return MEDIA_KIND_LABELS[String(k ?? '').toLowerCase()] ?? '其他';
}

const MEDIA_KIND_ICONS = {
  image: '🖼️',
  video: '🎬',
  audio: '🎵',
  file: '📄',
  other: '📦',
};

/** 媒体种类图标（纯文本，避免 innerHTML）。 */
export function mediaKindIcon(k) {
  return MEDIA_KIND_ICONS[String(k ?? '').toLowerCase()] ?? MEDIA_KIND_ICONS.other;
}

const MEDIA_STATUS_LABELS = {
  present: '已保存',
  missing: '缺失',
  corrupt: '损坏',
  pending: '待处理',
};

/** 媒体保存状态中文标签。 */
export function mediaStatusLabel(s) {
  return MEDIA_STATUS_LABELS[String(s ?? '').toLowerCase()] ?? '未知';
}

const JOB_STATUS_LABELS = {
  pending: '待处理',
  running: '进行中',
  done: '成功',
  failed: '失败',
  cancelled: '已取消',
};

/** 任务状态中文标签。 */
export function jobStatusLabel(s) {
  return JOB_STATUS_LABELS[String(s ?? '').toLowerCase()] ?? '未知';
}

const LOG_LEVEL_LABELS = {
  debug: '调试',
  info: '信息',
  warn: '警告',
  error: '错误',
};

/** 日志级别中文标签。 */
export function logLevelLabel(l) {
  return LOG_LEVEL_LABELS[String(l ?? '').toLowerCase()] ?? '信息';
}

/**
 * 拼接查询串。跳过 null / undefined / ''（保留 0 与 false）；键值都做 URI 编码；
 * path 已含 `?` 时用 `&` 续接；无有效参数时原样返回 path。
 */
export function buildUrl(path, params) {
  const base = String(path ?? '');
  if (params === null || params === undefined) return base;
  const pairs = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'number' && !Number.isFinite(value)) continue;
    const s = String(value);
    if (s === '') continue;
    pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(s)}`);
  }
  if (pairs.length === 0) return base;
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}${pairs.join('&')}`;
}

/** HTML 转义（用于必须写进 HTML 字符串的场景；正常路径请优先用 textContent）。 */
export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 按**码点**截断（emoji / 代理对不会被切坏），超出追加省略号。
 * n <= 0 时有内容返回 '…'，空串返回 ''。
 */
export function truncate(s, n) {
  const chars = Array.from(String(s ?? ''));
  const limit = Number.isFinite(n) ? Math.trunc(n) : 0;
  if (limit <= 0) return chars.length === 0 ? '' : '…';
  if (chars.length <= limit) return chars.join('');
  return `${chars.slice(0, limit).join('')}…`;
}

const STATUS_CLASSES = {
  present: 'ok',
  done: 'ok',
  ok: 'ok',
  missing: 'bad',
  corrupt: 'bad',
  failed: 'bad',
  error: 'bad',
  pending: 'warn',
  warn: 'warn',
  running: 'run',
  cancel: 'muted',
  cancelled: 'muted',
  debug: 'muted',
  info: 'info',
  muted: 'muted',
};

/** 状态 → CSS 修饰类（bad/warn/ok/run/info/muted），未知回退 muted。 */
export function statusClass(status) {
  return STATUS_CLASSES[String(status ?? '').toLowerCase()] ?? 'muted';
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}

/**
 * 解析 hash 路由：`#/chats?sessionId=3&q=你好` → `{route:'chats', params:{...}, fallback:false}`。
 * 空 hash 或未知路由回退到 DEFAULT_ROUTE（fallback=true）。
 */
export function parseHash(hash) {
  const raw = String(hash ?? '').replace(/^#/, '');
  const qIndex = raw.indexOf('?');
  const pathPart = qIndex >= 0 ? raw.slice(0, qIndex) : raw;
  const queryPart = qIndex >= 0 ? raw.slice(qIndex + 1) : '';
  const seg = pathPart.replace(/^\/+/, '').replace(/\/+$/, '');
  const known = ROUTES.includes(seg);
  const route = seg === '' || !known ? DEFAULT_ROUTE : seg;
  const params = {};
  if (queryPart !== '') {
    for (const kv of queryPart.split('&')) {
      if (kv === '') continue;
      const eq = kv.indexOf('=');
      const key = eq < 0 ? kv : kv.slice(0, eq);
      const value = eq < 0 ? '' : kv.slice(eq + 1);
      params[safeDecode(key)] = safeDecode(value);
    }
  }
  return { route, params, fallback: seg === '' || !known };
}

/** 总页数（至少 1）。 */
export function pageCount(total, pageSize) {
  const t = isFiniteNumber(total) && total > 0 ? total : 0;
  const size = isFiniteNumber(pageSize) && pageSize > 0 ? Math.trunc(pageSize) : 50;
  return Math.max(1, Math.ceil(t / size));
}

/** 把页码夹在 [1, pageCount] 内。 */
export function clampPage(page, total, pageSize) {
  const p = isFiniteNumber(page) ? Math.trunc(page) : 1;
  return Math.min(Math.max(1, p), pageCount(total, pageSize));
}

/** 任务进度百分比 0–100（兼容 progress 为 0–1 或 0–100，以及 processed/totalItems）。 */
export function jobProgress(job) {
  if (job === null || job === undefined || typeof job !== 'object') return 0;
  const raw = job.progress;
  if (isFiniteNumber(raw) && raw > 0) {
    const pct = raw <= 1 ? raw * 100 : raw;
    return Math.min(100, Math.max(0, Math.round(pct)));
  }
  const total = job.totalItems;
  const done = job.processed;
  if (isFiniteNumber(total) && total > 0 && isFiniteNumber(done)) {
    return Math.min(100, Math.max(0, Math.round((done / total) * 100)));
  }
  if (job.status === 'done') return 100;
  return 0;
}

/* ==================================================================== *
 * 自动刷新控制器
 *
 * 抽成纯函数放进 lib.js 是为了**能单测**：这段逻辑踩过一个真实的坑 ——
 * `start()` 里如果先调 `stop()` 清理，而 `stop()` 顺手把注册好的回调也清空了，
 * 定时器就会一直空转（每轮都因为"没有回调"直接返回），表现成"自动刷新不起作用"，
 * 而且不报任何错、日志也看不出来。浏览器里只能靠"等 10 秒看有没有请求"才发现。
 * ==================================================================== */

/**
 * 建一个自动刷新控制器。
 *
 * @param {object} opts
 * @param {() => number} opts.getIntervalMs 取当前间隔（0 = 关闭）
 * @param {() => boolean} opts.isActive 当前是否应该刷新（例如"还在这个页面上"）
 * @param {() => boolean} [opts.isPaused] 是否临时跳过这一轮（例如标签页在后台）
 * @param {object} opts.timers 定时器实现（默认全局 setInterval/clearInterval，可注入假实现）
 * @returns {{ setHandlers: (h: object) => void, start: () => void, stop: () => void, isRunning: () => boolean }}
 */
export function createRefreshController(opts) {
  const timers = opts.timers ?? { setInterval, clearInterval };
  let timer = null;
  let handlers = null;

  /** 只清定时器；**不动 handlers** —— 这是 start() 复用的清理路径。 */
  const clearTimer = () => {
    if (timer !== null) {
      timers.clearInterval(timer);
      timer = null;
    }
  };

  return {
    /** 注册这一轮要刷新的回调（每次渲染页面时更新）。 */
    setHandlers(h) {
      handlers = h ?? null;
    },
    /** 启动（或按新间隔重启）。**不会**清掉已注册的 handlers。 */
    start() {
      clearTimer();
      const ms = opts.getIntervalMs();
      if (!(ms > 0)) return;
      timer = timers.setInterval(() => {
        if (opts.isPaused && opts.isPaused()) return;
        if (!opts.isActive()) {
          this.stop();
          return;
        }
        if (handlers === null) return;
        if (typeof handlers.onTick === 'function') handlers.onTick();
      }, ms);
    },
    /** 停止：清定时器并丢弃 handlers（离开页面时调用）。 */
    stop() {
      clearTimer();
      handlers = null;
    },
    isRunning() {
      return timer !== null;
    },
  };
}
