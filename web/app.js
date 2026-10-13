/**
 * web/app.js —— QQ 聊天记录归档 管理界面。
 *
 * 设计约束：
 *  - 原生 ES 模块，无框架、无构建步骤、无外部 CDN。
 *  - 所有数据来自真实 `/api/*`（见 docs/ARCHITECTURE.md 第 6 节），页面里没有任何硬编码样例数据。
 *  - XSS：用户数据一律经 textContent（h() 的文本子节点）进入 DOM；
 *    唯一允许的 innerHTML 通道是后端已转义的高亮片段 `SearchHit.snippet`。
 */

import {
  DEFAULT_ROUTE,
  buildUrl,
  chatTypeLabel,
  clampPage,
  createRefreshController,
  formatBytes,
  formatCount,
  formatDuration,
  formatIso,
  formatRelative,
  formatTime,
  isFiniteNumber,
  jobProgress,
  jobStatusLabel,
  logLevelLabel,
  mediaKindIcon,
  mediaKindLabel,
  mediaStatusLabel,
  msgTypeLabel,
  pageCount,
  parseHash,
  statusClass,
  truncate,
} from './lib.js';

/* ==================================================================== *
 * 常量与全局状态
 * ==================================================================== */

const TOKEN_KEY = 'qqarchive.access';
const EXPIRES_KEY = 'qqarchive.expires';
const POLL_KEY = 'qqarchive.pollMs';
/** 未显式设置时的默认自动刷新间隔（5 秒）。 */
const DEFAULT_POLL_MS = 5000;
const PAGE_SIZE_SESSIONS = 30;
const PAGE_SIZE_MESSAGES = 60;
const PAGE_SIZE_MEDIA = 48;
const PAGE_SIZE_JOBS = 20;
const PAGE_SIZE_LOGS = 50;

const NAV = [
  { route: 'overview', label: '总览', icon: '📊' },
  { route: 'qq', label: 'QQ 登录', icon: '🔑' },
  { route: 'chats', label: '聊天记录', icon: '💬' },
  { route: 'media', label: '媒体管理', icon: '🖼️' },
  { route: 'archive', label: '归档管理', icon: '🗄️' },
  { route: 'logs', label: '日志', icon: '📜' },
  { route: 'export', label: '导出', icon: '⬇️' },
];

const ROUTE_TITLES = {
  overview: '总览',
  qq: 'QQ 登录',
  chats: '聊天记录',
  media: '媒体管理',
  archive: '归档管理',
  logs: '日志',
  export: '导出',
  login: '登录',
};

const state = {
  token: readToken(),
  route: DEFAULT_ROUTE,
  params: {},
  health: null,
  shellReady: false,
};

let pollTimer = null;
let activeStream = null;

function readToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}
function saveToken(token, expiresAt) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
    if (expiresAt !== undefined && expiresAt !== null) localStorage.setItem(EXPIRES_KEY, String(expiresAt));
  } catch { /* 隐私模式下 localStorage 不可用：仅内存保存 */ }
}
function clearToken() {
  state.token = '';
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(EXPIRES_KEY);
  } catch { /* ignore */ }
}
/** 自动刷新间隔（毫秒）。未设置时**默认 5 秒**：聊天记录页要能自己出现新消息，
 *  否则用户每次都得手动刷新（这是真实反馈过的痛点）。想彻底关掉在界面里选「关闭」即可。 */
function readPollMs() {
  try {
    const raw = localStorage.getItem(POLL_KEY);
    if (raw === null) return DEFAULT_POLL_MS;
    const v = Number(raw);
    return Number.isFinite(v) && v > 0 ? v : 0;
  } catch {
    return DEFAULT_POLL_MS;
  }
}
function savePollMs(ms) {
  try {
    localStorage.setItem(POLL_KEY, String(ms));
  } catch { /* ignore */ }
}

/* ==================================================================== *
 * DOM 构造工具（全部走 textContent / setAttribute，天然防 XSS）
 * ==================================================================== */

function appendChildren(el, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) appendChildren(el, child);
    else if (child instanceof Node) el.appendChild(child);
    else el.appendChild(document.createTextNode(String(child)));
  }
}

/** 创建元素。props: class / text / html(仅受信 HTML) / on / style / dataset / 其它属性。 */
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') el.className = String(value);
      else if (key === 'text') el.textContent = String(value);
      else if (key === 'html') el.innerHTML = String(value); // 仅用于受信的 snippet
      else if (key === 'on') {
        for (const [evt, fn] of Object.entries(value)) el.addEventListener(evt, fn);
      } else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
      else if (key === 'dataset' && typeof value === 'object') Object.assign(el.dataset, value);
      else if (key in el) el[key] = value;
      else el.setAttribute(key, String(value));
    }
  }
  appendChildren(el, children);
  return el;
}

function selectEl(options, current, onChange, attrs) {
  const sel = h('select', { ...(attrs || {}), on: onChange ? { change: onChange } : undefined });
  for (const opt of options) sel.appendChild(h('option', { value: opt.value, text: opt.label }));
  sel.value = current === null || current === undefined ? '' : String(current);
  if (sel.value === '' && sel.options.length > 0 && current !== '') sel.selectedIndex = 0;
  return sel;
}

function loading(text) {
  return h('div', { class: 'loading' }, h('div', { class: 'spinner' }), h('span', { text: text || '加载中…' }));
}

function emptyBox(text) {
  return h('div', { class: 'empty', text: text || '暂无数据' });
}

function badge(text, tone) {
  return h('span', { class: `badge ${tone || 'muted'}`, text });
}

function errorBox(err, retry) {
  const message = err && err.message ? err.message : String(err);
  const code = err && err.code ? ` · code=${err.code}` : '';
  const status = err && err.status ? `HTTP ${err.status}` : '请求失败';
  return h(
    'div',
    { class: 'error-box' },
    h('div', { class: 'error-title', text: `${status}${code}` }),
    h('div', { class: 'error-detail', text: message }),
    retry ? h('div', { class: 'error-actions' }, h('button', { class: 'sm', text: '重试', on: { click: () => void retry() } })) : null,
  );
}

function statCard(label, value, sub, tone) {
  // 消息数 / 媒体数这类计数统一加千分位，便于阅读 6 位以上的归档规模。
  const shown = typeof value === 'number' && Number.isFinite(value) ? formatCount(value) : value;
  return h(
    'div',
    { class: `stat${tone ? ` tone-${tone}` : ''}` },
    h('div', { class: 'label', text: label }),
    h('div', { class: `value${String(shown).length > 14 ? ' sm' : ''}`, text: shown }),
    sub ? h('div', { class: 'sub', text: sub }) : null,
  );
}

function kvList(pairs) {
  const dl = h('dl', { class: 'kv' });
  for (const [k, v] of pairs) {
    dl.appendChild(h('dt', { text: k }));
    dl.appendChild(v instanceof Node ? h('dd', {}, v) : h('dd', { text: v === null || v === undefined || v === '' ? '—' : String(v) }));
  }
  return dl;
}

function pager(total, page, pageSize, onGo) {
  const pages = pageCount(total, pageSize);
  const cur = clampPage(page, total, pageSize);
  const wrap = h('div', { class: 'pager' });
  wrap.appendChild(h('span', { text: `共 ${total ?? 0} 条 · 第 ${cur}/${pages} 页` }));
  wrap.appendChild(h('span', { class: 'spacer' }));
  const prev = h('button', { class: 'sm', text: '上一页', disabled: cur <= 1, on: { click: () => onGo(cur - 1) } });
  const next = h('button', { class: 'sm', text: '下一页', disabled: cur >= pages, on: { click: () => onGo(cur + 1) } });
  wrap.appendChild(prev);
  wrap.appendChild(next);
  return wrap;
}

function progressBar(job) {
  const pct = jobProgress(job);
  const cls = job && job.status === 'done' ? 'progress done' : job && job.status === 'failed' ? 'progress failed' : 'progress';
  return h('div', { class: cls, title: `${pct}%` }, h('i', { style: { width: `${pct}%` } }));
}

function toast(message, tone) {
  const node = h('div', {
    class: `notice ${tone || ''}`,
    text: message,
    style: {
      position: 'fixed',
      right: '16px',
      bottom: '16px',
      zIndex: '200',
      maxWidth: '360px',
      background: '#1b2029',
      boxShadow: '0 8px 28px rgba(0,0,0,.5)',
    },
  });
  document.body.appendChild(node);
  setTimeout(() => node.remove(), 4200);
}

/* ==================================================================== *
 * API 客户端
 * ==================================================================== */

class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function api(path, opts = {}) {
  const { method = 'GET', body, params, redirectOn401 = true } = opts;
  const url = buildUrl(path, params);
  const headers = {};
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, { method, headers, body: payload, cache: 'no-store' });
  } catch (err) {
    throw new ApiError(`网络请求失败：${err && err.message ? err.message : String(err)}`, 0);
  }
  if (res.status === 401 && redirectOn401) {
    clearToken();
    renderLogin('登录已失效，请重新登录。');
    throw new ApiError('登录已失效，请重新登录', 401, 'unauthorized');
  }
  const text = await res.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (!res.ok) {
    const msg = (json && (json.error || json.message)) || text.slice(0, 300) || `HTTP ${res.status}`;
    throw new ApiError(msg, res.status, json && json.code);
  }
  if (json && typeof json === 'object' && Object.prototype.hasOwnProperty.call(json, 'data')) return json.data;
  return json;
}

function accessUrl(path, params) {
  return buildUrl(path, { ...(params || {}), access: state.token });
}

function mediaRawUrl(md) {
  return accessUrl(md && md.url ? md.url : `/api/media/${md.id}/raw`);
}
function mediaThumbUrl(md) {
  const base = md && md.thumbUrl ? md.thumbUrl : `/api/media/${md && md.id}/thumb`;
  return accessUrl(base);
}

/* ==================================================================== *
 * 路由
 * ==================================================================== */

function hashFor(route, params) {
  const qs = buildUrl('', params || {});
  return `#/${route}${qs}`;
}

function setHash(route, params, replace) {
  const next = hashFor(route, params);
  if (location.hash === next) {
    void render();
    return;
  }
  if (replace) {
    history.replaceState(null, '', next);
    void render();
  } else {
    location.hash = next;
  }
}

function pget(key, fallback = '') {
  const v = state.params[key];
  return v === undefined || v === null || v === '' ? fallback : v;
}

/** 合并当前路由参数；值为 null/''/undefined 的键会被移除。 */
function updateParams(patch, route) {
  const merged = { ...state.params };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined || v === '') delete merged[k];
    else merged[k] = String(v);
  }
  setHash(route || state.route, merged);
}

function stopPolling() {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function stopStream() {
  if (activeStream) {
    try {
      activeStream.close();
    } catch { /* ignore */ }
    activeStream = null;
  }
}

/* ==================================================================== *
 * 登录
 * ==================================================================== */

function renderLogin(message) {
  stopPolling();
  stopStream();
  state.shellReady = false;
  const app = document.getElementById('app');
  const input = h('input', {
    type: 'password',
    name: 'token',
    autocomplete: 'current-password',
    placeholder: '请输入服务器 token',
    required: true,
  });
  const errSlot = h('div');
  const submit = h('button', { class: 'primary block', type: 'submit', text: '登录' });
  const form = h('form', { class: 'stack' }, h('label', { class: 'field' }, h('span', { text: '访问令牌' }), input), submit, errSlot);

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    errSlot.replaceChildren();
    const token = input.value.trim();
    if (!token) {
      errSlot.replaceChildren(errorBox(new ApiError('请输入 token', 0)));
      return;
    }
    submit.disabled = true;
    submit.textContent = '登录中…';
    try {
      const data = await api('/api/auth/login', { method: 'POST', body: { token }, redirectOn401: false });
      const accessToken = data && (data.accessToken || data.token);
      if (!accessToken) throw new ApiError('服务器未返回 accessToken', 0);
      state.token = accessToken;
      saveToken(accessToken, data.expiresAt);
      await refreshHealth();
      setHash(DEFAULT_ROUTE, {}, true);
    } catch (err) {
      errSlot.replaceChildren(errorBox(err));
    } finally {
      submit.disabled = false;
      submit.textContent = '登录';
    }
  });

  app.className = '';
  app.replaceChildren(
    h(
      'div',
      { class: 'login-page' },
      h(
        'div',
        { class: 'login-card' },
        h('div', { class: 'logo', text: '🗂️' }),
        h('h1', { text: 'QQ 聊天记录归档' }),
        h('p', { class: 'sub', text: '本机归档管理后台，请使用配置中的 server.token 登录。' }),
        message ? h('div', { class: 'notice bad', text: message }) : null,
        form,
        h('p', { class: 'hint', text: '令牌仅保存在本机 localStorage（qqarchive.access），不会发送到第三方。' }),
      ),
    ),
  );
  input.focus();
}

async function logout() {
  stopPolling();
  stopStream();
  try {
    await api('/api/auth/logout', { method: 'POST', redirectOn401: false });
  } catch { /* 注销失败也要清本地态 */ }
  clearToken();
  renderLogin('已退出登录。');
}

/* ==================================================================== *
 * 应用骨架
 * ==================================================================== */

function mountShell() {
  const app = document.getElementById('app');
  const dot = h('span', { class: `dot${state.health && state.health.ok === false ? ' bad' : ''}` });
  const topbar = h(
    'header',
    { class: 'topbar' },
    h('div', { class: 'brand' }, dot, h('span', { text: 'QQ 归档' })),
    h('div', { class: 'page-title', text: ROUTE_TITLES[state.route] || state.route }),
    h('div', { class: 'spacer' }),
    state.health
      ? h('div', { class: 'meta', text: `v${state.health.version || '?'} · 运行 ${Math.round((state.health.uptimeSec || 0) / 60)} 分钟` })
      : null,
    h('button', { class: 'ghost sm', text: '刷新', on: { click: () => void renderRoute(true) } }),
    h('button', { class: 'sm', text: '退出', on: { click: () => void logout() } }),
  );

  const sidebar = h('nav', { class: 'sidebar' });
  for (const item of NAV) {
    sidebar.appendChild(
      h(
        'a',
        {
          class: `nav-item${state.route === item.route ? ' active' : ''}`,
          href: hashFor(item.route, {}),
          on: {
            click: (ev) => {
              ev.preventDefault();
              setHash(item.route, {});
            },
          },
        },
        h('span', { class: 'ico', text: item.icon }),
        h('span', { text: item.label }),
      ),
    );
  }
  sidebar.appendChild(h('div', { class: 'nav-foot', text: '本地部署 · 无外部依赖' }));

  app.className = '';
  app.replaceChildren(h('div', { class: 'shell' }, topbar, sidebar, h('main', { id: 'view' })));
  state.shellReady = true;
}

async function refreshHealth() {
  try {
    state.health = await api('/api/health', { redirectOn401: false });
  } catch {
    state.health = null;
  }
}

function viewSlot() {
  const view = document.getElementById('view');
  if (!view) throw new Error('界面未初始化');
  return view;
}

async function renderRoute(force) {
  stopPolling();
  stopStream();
  stopChatAutoRefresh();
  const view = viewSlot();
  view.replaceChildren(loading());
  const renderer = VIEWS[state.route];
  if (!renderer) {
    view.replaceChildren(errorBox(new ApiError(`未知页面：${state.route}`, 0)));
    return;
  }
  try {
    const node = await renderer();
    view.replaceChildren(node);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    view.replaceChildren(h('div', {}, errorBox(err, () => renderRoute(true))));
  }
  if (force) toast('已刷新');
}

/* ==================================================================== *
 * 页面：总览
 * ==================================================================== */

async function viewOverview() {
  const [stats, health, collect, backups] = await Promise.all([
    api('/api/stats'),
    api('/api/health').catch((err) => ({ __error: err.message })),
    api('/api/collect/health').catch((err) => ({ __error: err.message })),
    api('/api/backups').catch(() => []),
  ]);
  state.health = health && !health.__error ? health : null;

  // `/api/backups` 返回 `{items,total}`（不是数组）；早先这里直接当数组用，
  // 于是无论有没有备份，「最后一次备份」永远显示「尚无备份记录」。
  const backupItems = Array.isArray(backups) ? backups : backups && Array.isArray(backups.items) ? backups.items : [];
  const backup = backupItems.length > 0 ? backupItems[0] : null;
  const cards = h('div', { class: 'stat-grid' });
  cards.appendChild(statCard('账号', stats.accounts ?? 0));
  cards.appendChild(statCard('会话', stats.sessions ?? 0, `群聊 ${stats.groups ?? 0} · 私聊 ${stats.privates ?? 0}`));
  cards.appendChild(statCard('消息总数', stats.messages ?? 0, `今日 ${stats.messagesToday ?? 0} 条${stats.messagesFiltered > 0 ? ` · 已过滤 ${stats.messagesFiltered}` : ''}`));
  cards.appendChild(statCard('媒体总数', stats.mediaTotal ?? 0, `已保存 ${stats.mediaPresent ?? 0} · 缺失 ${stats.mediaMissing ?? 0}`));
  cards.appendChild(statCard('占用空间', formatBytes(stats.mediaBytes), '已归档媒体字节数'));
  cards.appendChild(statCard('最近消息', formatIso(stats.lastMessageAt), '最新入库消息时间'));
  cards.appendChild(statCard('待处理任务', stats.pendingJobs ?? 0, 'pending / running', stats.pendingJobs > 0 ? 'warn' : undefined));
  cards.appendChild(statCard('失败任务', stats.failedJobs ?? 0, '需要处理', stats.failedJobs > 0 ? 'bad' : undefined));

  // `/api/collect/health` 的 lastOkAt / lastError / consecutiveFailures 挂在**每条会话状态**
  // 上（states[]），不在顶层；早先直接读顶层，于是这三行永远是「—」。
  const collectStates = collect && !collect.__error && Array.isArray(collect.states) ? collect.states : [];
  const collectLastOkAt = collectStates.reduce((acc, s) => (s && typeof s.lastOkAt === 'string' && s.lastOkAt > acc ? s.lastOkAt : acc), '');
  const collectFailures = collectStates.reduce(
    (acc, s) => (s && isFiniteNumber(s.consecutiveFailures) && s.consecutiveFailures > acc ? s.consecutiveFailures : acc),
    0,
  );
  const collectError = (collectStates.find((s) => s && s.lastError) || {}).lastError || null;

  const collectPairs = [
    ['最近采集时间', formatIso(stats.lastCollectAt)],
    [
      '采集器状态',
      collect && !collect.__error
        ? badge(collect.ok ? '正常' : '异常', collect.ok ? 'ok' : 'bad')
        : badge('不可用', 'bad'),
    ],
    ['采集器最近成功', formatIso(collectLastOkAt !== '' ? collectLastOkAt : (collect && collect.lastOkAt))],
    ['连续失败次数', collectStates.length > 0 ? String(collectFailures) : isFiniteNumber(collect && collect.consecutiveFailures) ? String(collect.consecutiveFailures) : '—'],
    ['采集器错误', collectError ? h('span', { class: 'bad-text', text: collectError }) : '—'],
  ];
  if (collect && collect.__error) collectPairs.push(['采集健康接口', h('span', { class: 'bad-text', text: collect.__error })]);

  const backupPairs = backup
    ? [
        ['备份状态', badge(`${jobStatusLabel(backup.status)}`, statusClass(backup.status))],
        ['备份时间', formatIso(backup.finishedAt || backup.createdAt)],
        ['路径', h('span', { class: 'mono', text: backup.path || '—' })],
        ['大小', formatBytes(backup.sizeBytes)],
        ['消息 / 媒体', `${backup.messageCount ?? 0} 条 / ${backup.mediaCount ?? 0} 个`],
        ['校验值', h('span', { class: 'mono', text: truncate(backup.dbSha256 || '—', 24) })],
        ['错误', backup.error ? h('span', { class: 'bad-text', text: backup.error }) : '—'],
      ]
    : [['最后一次备份', '尚无备份记录']];

  const healthPairs = health && !health.__error
    ? [
        ['总体状态', badge(health.ok ? '健康' : '异常', health.ok ? 'ok' : 'bad')],
        ['版本 / 运行时长', `${health.version || '?'} · ${health.uptimeSec ?? 0} 秒`],
        ['数据库', `${health.db && health.db.ok ? '正常' : '异常'} · schema v${health.db ? health.db.schemaVersion : '?'}`],
        ['数据库路径', h('span', { class: 'mono', text: (health.db && health.db.path) || '—' })],
        ['媒体目录', h('span', { class: 'mono', text: (health.media && health.media.root) || '—' })],
        ['媒体目录可写', health.media && health.media.writable ? badge('可写', 'ok') : badge('不可写', 'bad')],
        ['磁盘剩余', `${formatBytes(health.disk && health.disk.freeBytes)} / ${formatBytes(health.disk && health.disk.totalBytes)}`],
        ['磁盘告警', health.disk && health.disk.low ? badge('空间不足', 'bad') : badge('充足', 'ok')],
      ]
    : [['健康接口', health && health.__error ? h('span', { class: 'bad-text', text: health.__error }) : '—']];

  const collectors =
    health && !health.__error && Array.isArray(health.collectors) && health.collectors.length > 0
      ? h(
          'div',
          { class: 'table-wrap', style: { marginTop: '10px' } },
          h(
            'table',
            { class: 'data' },
            h('thead', {}, h('tr', {}, h('th', { text: '采集源' }), h('th', { text: '状态' }), h('th', { text: '最近成功' }), h('th', { text: '错误' }))),
            h(
              'tbody',
              {},
              health.collectors.map((c) =>
                h(
                  'tr',
                  {},
                  h('td', { text: c.source }),
                  h('td', {}, badge(c.ok ? '正常' : '异常', c.ok ? 'ok' : 'bad')),
                  h('td', { text: formatIso(c.lastOkAt) }),
                  h('td', { class: 'bad-text', text: c.lastError || '—' }),
                ),
              ),
            ),
          ),
        )
      : emptyBox('没有采集源状态信息');

  const actions = h(
    'div',
    { class: 'row' },
    h('a', { class: 'btn sm', href: hashFor('archive', {}), text: '前往归档管理' }),
    h('a', { class: 'btn sm', href: hashFor('logs', {}), text: '查看日志' }),
  );

  return h(
    'div',
    {},
    h('div', { class: 'page-head' }, h('h1', { text: '总览' }), h('span', { class: 'desc', text: '归档规模、健康状态与最近一次采集/备份' })),
    cards,
    collectControlCard(),
    h('div', { class: 'card' }, h('h3', { text: '快捷入口' }), actions),
    h(
      'div',
      { class: 'cols-2' },
      h('div', { class: 'card' }, h('h3', { text: '采集与备份' }), kvList(collectPairs), h('hr', { class: 'sep' }), kvList(backupPairs)),
      h('div', { class: 'card' }, h('h3', { text: '系统健康' }), kvList(healthPairs), collectors),
    ),
  );
}

/**
 * 采集控制面板：状态徽标 + 运行状态 + 「开始采集 / 停止采集 / 立即采集一轮」。
 *
 * 之所以要做这块：之前界面上只有"立即采集"（跑一轮），既看不出定时采集到底在不在跑，
 * 也没有地方停它 —— 服务端那时也没把循环句柄暴露出来（循环由 CLI 启动，服务端只有 runOnce）。
 * 现在 `/api/collect/health` 会返回 `running` 与 `controllable`，按钮据此启用/禁用。
 */
function collectControlCard(opts = {}) {
  const slot = h('div', { class: 'stack' });
  const card = h('div', { class: 'card' }, h('h3', { text: '采集控制' }), slot);

  async function paint() {
    slot.replaceChildren(loading());
    let health;
    try {
      health = await api('/api/collect/health');
    } catch (err) {
      slot.replaceChildren(errorBox(err, () => void paint()));
      return;
    }
    const controllable = health.controllable === true;
    const running = health.running;
    const kindLabel = health.enabled ? `OneBot（${health.baseUrl || '未填地址'}）` : '未启用（只做离线导入）';

    const rows = [
      h(
        'div',
        { class: 'row' },
        h('span', { class: 'faint small', text: '定时采集' }),
        running === true
          ? badge(`运行中 · 每 ${health.intervalSec ?? '?'} 秒一轮`, 'ok')
          : running === false
            ? badge('已停止', 'warn')
            : badge('状态未知（当前实现不支持启停控制）', 'muted'),
      ),
      h('div', { class: 'row' }, h('span', { class: 'faint small', text: '采集源' }), h('span', { text: kindLabel })),
      h(
        'div',
        { class: 'row' },
        h('span', { class: 'faint small', text: '最近一轮' }),
        h('span', { text: health.checkedAt ? formatIso(health.checkedAt) : '—' }),
        health.ok === false ? badge('有失败', 'bad') : null,
      ),
    ];

    const btns = [];
    const startBtn = h('button', { class: 'primary sm', text: '开始采集', disabled: !controllable || running === true });
    startBtn.addEventListener('click', async () => {
      startBtn.disabled = true;
      startBtn.textContent = '启动中…';
      try {
        const res = await api('/api/collect/start', { method: 'POST', body: {} });
        toast(res.reason ? `未启动：${res.reason}` : `已开始采集（每 ${res.intervalSec} 秒一轮）`, res.running ? 'ok' : 'bad');
      } catch (err) {
        toast(`启动失败：${err.message}`, 'bad');
      } finally {
        await paint();
      }
    });
    const stopBtn = h('button', { class: 'danger sm', text: '停止采集', disabled: !controllable || running !== true });
    stopBtn.addEventListener('click', async () => {
      stopBtn.disabled = true;
      stopBtn.textContent = '停止中…';
      try {
        const res = await api('/api/collect/stop', { method: 'POST', body: {} });
        toast(res.stopped ? '已停止定时采集（已归档的内容不受影响）' : `未停止：${res.reason}`, res.stopped ? 'ok' : 'bad');
      } catch (err) {
        toast(`停止失败：${err.message}`, 'bad');
      } finally {
        await paint();
      }
    });
    btns.push(
      startBtn,
      stopBtn,
      h('button', { class: 'sm', text: '立即采集一轮', disabled: !health.enabled, on: { click: (ev) => void runCollect(ev.currentTarget) } }),
    );
    if (opts.withBackup !== false) btns.push(h('button', { class: 'sm', text: '手动备份', on: { click: (ev) => void runBackup(ev.currentTarget) } }));

    slot.replaceChildren(
      ...rows,
      h('div', { class: 'faint small', text: '提示：停止采集只停止"定时轮询"，不会删除任何已归档数据；再点开始会从上次游标继续，中间的新消息会一并补上。' }),
      h('div', { class: 'row' }, ...btns),
    );
  }

  void paint();
  return card;
}

async function runCollect(btn) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '采集中…';
  try {
    const result = await api('/api/collect/run', { method: 'POST', body: {} });
    toast(summarizeCollect(result), 'ok');
  } catch (err) {
    toast(`采集失败：${err.message}`, 'bad');
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

function summarizeCollect(result) {
  if (!result || typeof result !== 'object') return '采集完成';
  const parts = [];
  for (const key of ['sessions', 'fetched', 'inserted', 'duplicate', 'failed', 'mediaSaved', 'mediaMissing']) {
    if (isFiniteNumber(result[key])) parts.push(`${key}=${result[key]}`);
  }
  return parts.length ? `采集完成：${parts.join(' · ')}` : '采集完成';
}

async function runBackup(btn) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '备份中…';
  try {
    const rec = await api('/api/backup', { method: 'POST', body: { verify: true } });
    toast(`备份完成：${rec && rec.path ? rec.path : '已生成记录'}（${formatBytes(rec && rec.sizeBytes)}）`, 'ok');
  } catch (err) {
    toast(`备份失败：${err.message}`, 'bad');
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

/* ==================================================================== *
 * 页面：聊天记录
 * ==================================================================== */

/**
 * 填充会话列表。抽成独立函数是为了让**自动刷新**能就地重建列表
 * （消息数、最后一条预览、时间都会变），而不必整页重渲染。
 */
function fillSessionList(list, items, sessionId) {
  list.replaceChildren();
  if (items.length === 0) {
    list.appendChild(emptyBox('没有符合条件的会话'));
    return;
  }
  for (const s of items) {
    const active = s.id === sessionId;
    const lastText = s.lastMessageText || '（无消息）';
    list.appendChild(
      h(
        'div',
        {
          class: `session-item${active ? ' active' : ''}`,
          on: { click: () => updateParams({ sessionId: s.id, q: null, page: null }, 'chats') },
        },
        h(
          'div',
          { class: 'row1' },
          h('span', { class: 'session-name', text: s.name || s.remark || s.peerUid || `会话 #${s.id}` }),
          h('span', { class: 'time', text: formatIso(s.lastMessageAt) }),
        ),
        h('div', { class: 'session-preview', text: truncate(lastText, 60) }),
        h(
          'div',
          { class: 'row3' },
          badge(chatTypeLabel(s.chatType), s.chatType === 'group' ? 'run' : 'muted'),
          badge(`${s.messageCount ?? 0} 条`, 'muted'),
          s.memberCount ? badge(`${s.memberCount} 人`, 'muted') : null,
        ),
      ),
    );
  }
}

/* ---- 聊天记录页的自动刷新（只追加新消息，不整页重渲染） ---- */

/**
 * 控制器逻辑在 `lib.js`（`createRefreshController`）里，带单测 ——
 * 这段曾经有过一个"start() 先调 stop()，把刚注册的回调一起清掉"的坑，
 * 结果定时器一直空转、什么也不刷新，还不报错。
 */
/** 当前这一轮注册的刷新回调（onTick 通过它取用，避免控制器把 handlers 暴露出去）。 */
let chatRefreshHandlersRef = null;

const chatRefresh = createRefreshController({
  getIntervalMs: () => readPollMs(),
  isActive: () => state.route === 'chats',
  isPaused: () => typeof document !== 'undefined' && document.hidden === true,
  timers: {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (id) => clearInterval(id),
  },
});

/** 停掉聊天页的自动刷新（离开页面或用户关掉时调用）。 */
function stopChatAutoRefresh() {
  chatRefresh.stop();
}

/** 启动聊天页自动刷新（按当前设置）。 */
function startChatAutoRefresh() {
  chatRefresh.start();
}

async function viewChats() {
  const toolbar = buildChatsToolbar();
  const q = pget('q');
  if (q) return h('div', {}, pageHead('聊天记录', `全文搜索「${q}」`), toolbar, await renderSearchResults(q));

  const chatType = pget('chatType');
  const keyword = pget('keyword');
  const sort = pget('sort', 'recent');
  const page = Number(pget('page', '1')) || 1;
  const sessionId = Number(pget('sessionId', '0')) || 0;

  const pageData = await api('/api/sessions', {
    params: { chatType, keyword, sort, page, pageSize: PAGE_SIZE_SESSIONS },
  });
  const items = Array.isArray(pageData.items) ? pageData.items : [];

  const list = h('div', { class: 'session-list' });
  fillSessionList(list, items, sessionId);

  const left = h(
    'div',
    {},
    list,
    pager(pageData.total ?? items.length, page, PAGE_SIZE_SESSIONS, (p) => updateParams({ page: p }, 'chats')),
  );

  const right = sessionId > 0 ? await renderTimeline(sessionId) : h('div', { class: 'timeline' }, h('div', { class: 'timeline-body' }, emptyBox('请从列表中选择一个会话')));

  // 自动刷新：列表就地重建；时间线只追加新消息（见 startChatAutoRefresh 的注释）
  const handlersForThisView = {
    refreshList: async () => {
      const fresh = await api('/api/sessions', {
        params: { chatType, keyword, sort, page, pageSize: PAGE_SIZE_SESSIONS },
      });
      const freshItems = Array.isArray(fresh.items) ? fresh.items : [];
      fillSessionList(list, freshItems, sessionId);
    },
    ...(sessionId > 0 && typeof right.__refreshNew === 'function' ? { refreshTimeline: right.__refreshNew } : {}),
    onTick: () => {
      void handlersForThisView.refreshList().catch(() => {});
      if (handlersForThisView.refreshTimeline) void handlersForThisView.refreshTimeline().catch(() => {});
    },
  };
  chatRefreshHandlersRef = handlersForThisView;
  chatRefresh.setHandlers(handlersForThisView);
  startChatAutoRefresh();

  return h(
    'div',
    {},
    pageHead('聊天记录', '会话列表 · 消息时间线 · 全文搜索'),
    toolbar,
    h('div', { class: 'chat-layout' }, left, right),
  );
}

function pageHead(title, desc) {
  return h('div', { class: 'page-head' }, h('h1', { text: title }), desc ? h('span', { class: 'desc', text: desc }) : null);
}

function buildChatsToolbar() {
  const keywordInput = h('input', { type: 'search', name: 'keyword', placeholder: '会话名 / 备注 / QQ 号', value: pget('keyword'), class: 'grow' });
  const typeSel = selectEl(
    [
      { value: '', label: '全部类型' },
      { value: 'group', label: '群聊' },
      { value: 'private', label: '私聊' },
      { value: 'temp', label: '临时会话' },
      { value: 'other', label: '其他' },
    ],
    pget('chatType'),
    (ev) => updateParams({ chatType: ev.target.value, page: null }, 'chats'),
  );
  const sortSel = selectEl(
    [
      { value: 'recent', label: '按最近消息' },
      { value: 'messages', label: '按消息数' },
      { value: 'name', label: '按名称' },
    ],
    pget('sort', 'recent'),
    (ev) => updateParams({ sort: ev.target.value, page: null }, 'chats'),
  );
  const filterForm = h(
    'form',
    { class: 'inline' },
    keywordInput,
    h('button', { class: 'sm', type: 'submit', text: '筛选' }),
  );
  filterForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    updateParams({ keyword: keywordInput.value.trim(), page: null }, 'chats');
  });

  const searchInput = h('input', { type: 'search', name: 'q', placeholder: '全文搜索消息内容（支持中文子串）', value: pget('q') });
  const searchForm = h('div', { class: 'inline grow' }, searchInput, h('button', { class: 'primary sm', type: 'button', text: '搜索', on: { click: () => updateParams({ q: searchInput.value.trim(), spage: null }, 'chats') } }));
  searchInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      updateParams({ q: searchInput.value.trim(), spage: null }, 'chats');
    }
  });

  return h(
    'div',
    { class: 'toolbar' },
    filterForm,
    typeSel,
    sortSel,
    h('div', { class: 'grow' }, searchForm),
    buildPollControl(),
    pget('q') ? h('button', { class: 'danger sm', text: '退出搜索', on: { click: () => updateParams({ q: null, spage: null }, 'chats') } }) : null,
  );
}

async function renderSearchResults(q) {
  const page = Number(pget('spage', '1')) || 1;
  const msgType = pget('msgType');
  const data = await api('/api/search', {
    params: {
      q,
      page,
      pageSize: 20,
      msgType,
      ...(pget('showFiltered') === '1' ? { includeFiltered: 1 } : {}),
    },
  });
  const hits = Array.isArray(data.items) ? data.items : [];
  const card = h('div', { class: 'card' }, h('h3', { text: `搜索结果（${data.total ?? hits.length} 条）` }));
  if (hits.length === 0) {
    card.appendChild(emptyBox('没有命中任何消息'));
    return card;
  }
  const box = h('div', {});
  for (const hit of hits) {
    const m = hit.message || {};
    box.appendChild(
      h(
        'div',
        {
          class: 'search-hit',
          on: {
            click: () => updateParams({ sessionId: m.sessionId, q: null, spage: null, keyword: null }, 'chats'),
          },
        },
        h(
          'div',
          { class: 'hit-head' },
          h('span', { class: 'hit-session', text: hit.sessionName || `会话 #${m.sessionId}` }),
          badge(chatTypeLabel(hit.sessionChatType), hit.sessionChatType === 'group' ? 'run' : 'muted'),
          h('span', { class: 'faint small', text: formatTime(m.ts) }),
          h('span', { class: 'faint small', text: m.senderName || m.senderUin || '未知发送者' }),
          badge(msgTypeLabel(m.msgType), 'muted'),
          isFiniteNumber(hit.score) ? h('span', { class: 'faint small', text: `score ${hit.score}` }) : null,
        ),
        // 唯一允许的 innerHTML：后端已转义并带 <mark> 的高亮片段
        h('div', { class: 'snippet', html: hit.snippet || '' }),
      ),
    );
  }
  card.appendChild(box);
  card.appendChild(pager(data.total ?? 0, page, 20, (p) => updateParams({ spage: p }, 'chats')));
  return card;
}

async function renderTimeline(sessionId) {
  // 过滤掉的消息默认不显示（但它们**确实在库里**）；`showFiltered=1` 时才一起拉回来。
  const includeFiltered = pget('showFiltered') === '1';
  const [session, data] = await Promise.all([
    api(`/api/sessions/${sessionId}`),
    api(`/api/sessions/${sessionId}/messages`, {
      params: { limit: PAGE_SIZE_MESSAGES, ...(includeFiltered ? { includeFiltered: 1 } : {}) },
    }),
  ]);
  const items = Array.isArray(data.items) ? [...data.items].sort((a, b) => a.ts - b.ts) : [];
  const filteredShown = items.filter((m) => m.filtered).length;
  let oldest = items.length > 0 ? items[0].ts : 0;
  /** 已显示的最新一条的时间戳 —— 自动刷新据此只取"更新的"那些。 */
  let latestTs = items.length > 0 ? items[items.length - 1].ts : 0;
  /** 徽标上显示的消息总数（随自动刷新累加，避免每次重取会话详情）。 */
  let shownCount = session.messageCount ?? items.length;
  let hasMore = Boolean(data.hasMore);

  const msgs = h('div', {});
  const olderWrap = h('div', { class: 'row', style: { justifyContent: 'center', marginBottom: '10px' } });
  const olderBtn = h('button', {
    class: 'sm',
    text: '加载更早的消息',
    on: {
      click: async () => {
        olderBtn.disabled = true;
        olderBtn.textContent = '加载中…';
        try {
          const older = await api(`/api/sessions/${sessionId}/messages`, {
            params: { limit: PAGE_SIZE_MESSAGES, before: oldest },
          });
          const more = Array.isArray(older.items) ? [...older.items].sort((a, b) => a.ts - b.ts) : [];
          const frag = document.createDocumentFragment();
          for (const m of more) frag.appendChild(renderMessage(m));
          msgs.insertBefore(frag, msgs.firstChild);
          if (more.length > 0) oldest = more[0].ts;
          hasMore = Boolean(older.hasMore);
          olderWrap.style.display = more.length > 0 && hasMore ? '' : 'none';
        } catch (err) {
          toast(`加载失败：${err.message}`, 'bad');
        } finally {
          olderBtn.disabled = false;
          olderBtn.textContent = '加载更早的消息';
        }
      },
    },
  });
  olderWrap.appendChild(olderBtn);
  olderWrap.style.display = hasMore ? '' : 'none';

  for (const m of items) msgs.appendChild(renderMessage(m));

  const body = h('div', { class: 'timeline-body' }, olderWrap, items.length === 0 ? emptyBox('该会话暂无消息') : null, msgs);
  const head = h(
    'div',
    { class: 'timeline-head' },
    h('span', { class: 'title', text: session.name || session.remark || session.peerUid || `会话 #${sessionId}` }),
    badge(chatTypeLabel(session.chatType), session.chatType === 'group' ? 'run' : 'muted'),
    // 单独给一个 class：自动刷新要精确更新"条数"这个徽标，
    // 用 head.querySelector('.badge') 会命中前面的"群聊"徽标（真实踩过，把群聊字样改成了数字）
    (() => {
      const b = badge(`${session.messageCount ?? 0} 条消息`, 'muted');
      b.classList.add('count-badge');
      return b;
    })(),
    includeFiltered ? badge(`含已过滤${filteredShown > 0 ? ` ${filteredShown}` : ''}`, 'warn') : null,
    h('label', {
      class: 'faint small',
      style: { display: 'inline-flex', alignItems: 'center', gap: '4px', cursor: 'pointer' },
      title: '被过滤的消息一直都在库里（导出也会带上），这里只是决定要不要显示',
    },
      h('input', {
        type: 'checkbox',
        checked: includeFiltered,
        on: {
          change: (ev) => updateParams({ showFiltered: ev.target.checked ? '1' : null }, 'chats'),
        },
      }),
      '包含已过滤消息',
    ),
    h('span', { class: 'spacer', style: { flex: '1' } }),
    h('span', { class: 'faint small', text: `${formatIso(session.firstMessageAt)} ~ ${formatIso(session.lastMessageAt)}` }),
    h('a', { class: 'btn sm', href: hashFor('export', { sessionId: String(sessionId) }), text: '导出' }),
  );
  requestAnimationFrame(() => {
    body.scrollTop = body.scrollHeight;
  });

  const node = h('div', { class: 'timeline' }, head, body);
  /**
   * 供自动刷新调用：只拉"比已显示的最新一条更新"的消息并追加。
   *  - 用 `after=<最新 ts>` 而不是整段重取，避免把用户正在看的历史顶掉；
   *  - 只有当用户本来就在底部时才自动滚到底，否则只更新计数、不动滚动位置；
   *  - 命中过滤规则的消息按当前勾选状态决定要不要一起显示。
   */
  node.__refreshNew = async () => {
    const newest = latestTs;
    const params = { limit: PAGE_SIZE_MESSAGES, order: 'asc', ...(newest > 0 ? { after: newest } : {}) };
    if (includeFiltered) params.includeFiltered = 1;
    const fresh = await api(`/api/sessions/${sessionId}/messages`, { params });
    const freshItems = (Array.isArray(fresh.items) ? fresh.items : []).filter((m) => m.ts > newest || latestTs === 0);
    if (freshItems.length === 0) return 0;
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
    for (const m of freshItems) {
      msgs.appendChild(renderMessage(m));
      if (m.ts > latestTs) latestTs = m.ts;
    }
    if (latestTs > oldest && oldest === 0) oldest = latestTs;
    shownCount += freshItems.length;
    const countBadge = head.querySelector('.count-badge');
    if (countBadge) countBadge.textContent = `${shownCount} 条消息`;
    if (atBottom) requestAnimationFrame(() => { body.scrollTop = body.scrollHeight; });
    return freshItems.length;
  };
  return node;
}

function replyPreviewOf(m) {
  const candidates = [m.replyPreview, m.replyToPreview, m.extra && m.extra.reply && m.extra.reply.preview];
  for (const c of candidates) if (typeof c === 'string' && c.trim() !== '') return c;
  return '';
}

function renderMessage(m) {
  const isSystem = m.system === true || m.direction === 'system';
  const classes = ['msg'];
  if (isSystem) classes.push('system');
  else if (m.direction === 'out') classes.push('out');
  if (m.recalled) classes.push('recalled');

  const sender = m.direction === 'out' ? (m.senderName || '我') : m.senderName || m.senderUin || m.senderUid || '未知';
  const meta = h(
    'div',
    { class: 'meta' },
    h('span', { class: 'sender', text: sender }),
    h('span', { text: formatTime(m.ts) }),
    h('span', { text: formatRelative(m.ts) }),
    badge(msgTypeLabel(m.msgType), 'muted'),
    m.direction === 'out' ? badge('发出', 'run') : null,
    m.recalled ? badge('已撤回', 'warn') : null,
    m.filtered ? badge(`已过滤${m.filterReason ? `：${m.filterReason}` : ''}`, 'warn') : null,
    m.system ? badge('系统', 'muted') : null,
  );

  const bubble = h('div', { class: 'bubble' });
  const replyText = replyPreviewOf(m);
  const replyWho = m.replyToSenderName ? `${m.replyToSenderName}：` : '';
  if (replyText) {
    bubble.appendChild(h('div', { class: 'reply-preview', text: `↩ ${replyWho}${truncate(replyText, 90)}` }));
  } else if (m.replyToMessageId || m.replyToId || m.replyToMsgKey) {
    // `replyToId` 是 QQ 的原始消息 id，不能当本库 id 用；加载详情要走 `replyToMessageId`。
    const internalId = m.replyToMessageId || null;
    const label = internalId ? '（点击加载）' : '（原文不在归档内）';
    const rp = h('div', { class: 'reply-preview', text: `↩ 回复消息${label}`, style: internalId ? { cursor: 'pointer' } : null });
    if (internalId) {
      rp.addEventListener('click', async () => {
        rp.textContent = '↩ 加载中…';
        try {
          const ref = await api(`/api/messages/${internalId}`);
          rp.textContent = `↩ ${ref.senderName || '对方'}：${truncate(ref.text || '（无文本）', 90)}`;
        } catch (err) {
          rp.textContent = `↩ 引用消息加载失败：${err.message}`;
        }
      });
    }
    bubble.appendChild(rp);
  }

  if (m.text) bubble.appendChild(h('span', { text: m.text }));
  else if (!m.media || m.media.length === 0) bubble.appendChild(h('span', { class: 'faint', text: '（无文本内容）' }));

  if (Array.isArray(m.media) && m.media.length > 0) {
    const box = h('div', { class: 'msg-media' });
    for (const md of m.media) box.appendChild(renderMediaRef(md));
    bubble.appendChild(box);
  }

  const avatarText = isSystem ? 'SYS' : String(sender).slice(0, 1).toUpperCase();
  return h(
    'div',
    { class: classes.join(' ') },
    isSystem ? null : h('div', { class: 'avatar', text: avatarText }),
    h('div', { class: 'bubble-wrap' }, meta, bubble),
  );
}

function renderMediaRef(md) {
  if (!md || md.status !== 'present') {
    return h(
      'div',
      { class: 'media-missing' },
      `${mediaKindLabel(md && md.kind)}｜${mediaStatusLabel(md && md.status)}：${(md && md.failReason) || '文件不可用'}`,
    );
  }
  if (md.kind === 'image') {
    const img = h('img', { class: 'media-thumb', src: mediaThumbUrl(md), alt: md.filename || '图片', loading: 'lazy' });
    img.addEventListener('error', () => {
      if (img.dataset.retried) {
        img.replaceWith(h('div', { class: 'media-missing' }, `图片加载失败：${md.failReason || '未知原因'}`));
        return;
      }
      img.dataset.retried = '1';
      img.src = mediaRawUrl(md);
    });
    img.addEventListener('click', () => openMediaModal(md));
    return img;
  }
  if (md.kind === 'video') {
    const v = h('video', { class: 'media-inline', controls: true, preload: 'metadata', src: mediaRawUrl(md) });
    return v;
  }
  if (md.kind === 'audio') {
    const audio = h('audio', { class: 'media-inline', controls: true, preload: 'metadata', src: mediaRawUrl(md) });
    if (md.transcript === undefined || md.transcript === null) return audio;
    return h(
      'div',
      { class: 'media-audio-wrap' },
      audio,
      md.transcript === ''
        ? h('div', { class: 'sub faint', text: '（无语音内容）' })
        : h('div', { class: 'sub transcript-text', text: md.transcript }),
    );
  }
  return h(
    'a',
    { class: 'btn sm', href: mediaRawUrl(md), download: md.filename || '', target: '_blank', rel: 'noopener' },
    `⬇ ${md.filename || '下载文件'}`,
  );
}

/* ==================================================================== *
 * 媒体预览模态
 * ==================================================================== */

function closeModal() {
  const root = document.getElementById('modal-root');
  root.replaceChildren();
}

function openModal(titleText, bodyNode) {
  const root = document.getElementById('modal-root');
  const backdrop = h(
    'div',
    {
      class: 'modal-backdrop',
      on: {
        click: (ev) => {
          if (ev.target === backdrop) closeModal();
        },
      },
    },
    h(
      'div',
      { class: 'modal' },
      h(
        'div',
        { class: 'modal-head' },
        h('span', { class: 'title', text: titleText }),
        h('button', { class: 'ghost sm', text: '关闭', on: { click: closeModal } }),
      ),
      h('div', { class: 'modal-body' }, bodyNode),
    ),
  );
  root.replaceChildren(backdrop);
  document.addEventListener(
    'keydown',
    (ev) => {
      if (ev.key === 'Escape') closeModal();
    },
    { once: true },
  );
}

function openMediaModal(md) {
  const body = h('div', { class: 'stack' });
  if (md.status !== 'present') {
    body.appendChild(h('div', { class: 'media-missing' }, `${mediaStatusLabel(md.status)}：${md.failReason || '文件不可用'}`));
  } else if (md.kind === 'image') {
    body.appendChild(h('img', { class: 'preview', src: mediaRawUrl(md), alt: md.filename || '图片' }));
  } else if (md.kind === 'video') {
    body.appendChild(h('video', { class: 'preview', controls: true, autoplay: true, src: mediaRawUrl(md) }));
  } else if (md.kind === 'audio') {
    body.appendChild(h('audio', { controls: true, autoplay: true, src: mediaRawUrl(md) }));
  }
  body.appendChild(
    kvList([
      ['类型', mediaKindLabel(md.kind)],
      ['状态', mediaStatusLabel(md.status)],
      ['文件名', md.filename || '—'],
      ['大小', formatBytes(md.size)],
      ['尺寸', md.width && md.height ? `${md.width}×${md.height}` : '—'],
      ['时长', isFiniteNumber(md.duration) ? formatDuration(md.duration) : '—'],
      ['MIME', md.mime || '—'],
      ['失败原因', md.failReason || '—'],
    ]),
  );
  body.appendChild(
    h(
      'div',
      { class: 'row' },
      h('a', { class: 'btn sm', href: mediaRawUrl(md), download: md.filename || '', target: '_blank', rel: 'noopener', text: '下载原文件' }),
      md.id ? h('button', { class: 'sm', text: '重新校验 sha256', on: { click: (ev) => void verifyMedia(md.id, ev.currentTarget) } }) : null,
    ),
  );
  openModal(`${mediaKindLabel(md.kind)} · ${md.filename || `#${md.id}`}`, body);
}

async function verifyMedia(id, btn) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '校验中…';
  try {
    const result = await api(`/api/media/${id}/verify`, { method: 'POST', body: {} });
    const status = result && (result.status || result.verify);
    toast(`媒体 #${id} 校验完成：${status ? mediaStatusLabel(status) : JSON.stringify(result)}`, status === 'present' || status === undefined ? 'ok' : 'bad');
  } catch (err) {
    toast(`校验失败：${err.message}`, 'bad');
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

/* ==================================================================== *
 * 页面：媒体管理
 * ==================================================================== */

async function fetchSessionOptions() {
  try {
    const data = await api('/api/sessions', { params: { page: 1, pageSize: 200, sort: 'recent' } });
    return Array.isArray(data.items) ? data.items : [];
  } catch {
    return [];
  }
}

async function viewMedia() {
  const kind = pget('kind');
  const status = pget('status');
  const sessionId = pget('sessionId');
  const from = pget('from');
  const to = pget('to');
  const keyword = pget('keyword');
  const page = Number(pget('page', '1')) || 1;

  const [sessions, data] = await Promise.all([
    fetchSessionOptions(),
    api('/api/media', {
      params: {
        kind,
        status,
        sessionId,
        keyword,
        from: from ? Date.parse(`${from}T00:00:00`) : undefined,
        to: to ? Date.parse(`${to}T23:59:59`) : undefined,
        page,
        pageSize: PAGE_SIZE_MEDIA,
      },
    }),
  ]);
  const items = Array.isArray(data.items) ? data.items : [];

  const sessionOpts = [{ value: '', label: '全部会话' }];
  for (const s of sessions) sessionOpts.push({ value: String(s.id), label: `${s.name || s.remark || s.peerUid}（#${s.id}）` });

  const toolbar = h(
    'div',
    { class: 'toolbar' },
    selectEl(
      [
        { value: '', label: '全部类型' },
        { value: 'image', label: '图片' },
        { value: 'video', label: '视频' },
        { value: 'audio', label: '音频' },
        { value: 'file', label: '文件' },
        { value: 'other', label: '其他' },
      ],
      kind,
      (ev) => updateParams({ kind: ev.target.value, page: null }, 'media'),
    ),
    selectEl(
      [
        { value: '', label: '全部状态' },
        { value: 'present', label: '已保存' },
        { value: 'missing', label: '缺失' },
        { value: 'corrupt', label: '损坏' },
        { value: 'pending', label: '待处理' },
      ],
      status,
      (ev) => updateParams({ status: ev.target.value, page: null }, 'media'),
    ),
    selectEl(sessionOpts, sessionId, (ev) => updateParams({ sessionId: ev.target.value, page: null }, 'media')),
    h('label', { class: 'field' }, h('span', { text: '起始日期' }), h('input', { type: 'date', value: from, on: { change: (ev) => updateParams({ from: ev.target.value, page: null }, 'media') } })),
    h('label', { class: 'field' }, h('span', { text: '结束日期' }), h('input', { type: 'date', value: to, on: { change: (ev) => updateParams({ to: ev.target.value, page: null }, 'media') } })),
    h(
      'label',
      { class: 'field' },
      h('span', { text: '搜索文件名或语音内容' }),
      h('input', {
        type: 'search',
        value: keyword,
        placeholder: '文件名 / 语音内容',
        on: { change: (ev) => updateParams({ keyword: ev.target.value.trim(), page: null }, 'media') },
      }),
    ),
    kind || status || sessionId || from || to || keyword
      ? h('button', { class: 'ghost sm', text: '清除筛选', on: { click: () => updateParams({ kind: null, status: null, sessionId: null, from: null, to: null, keyword: null, page: null }, 'media') } })
      : null,
  );

  const batchBtn = h('button', { class: 'ghost sm', text: '转写未处理的语音' });
  batchBtn.addEventListener('click', () => void runBatchTranscribe(batchBtn));
  const batchRow = h(
    'div',
    { class: 'toolbar' },
    batchBtn,
    h('span', { class: 'faint', text: '对未转写的语音批量调用 whisper.cpp（需服务端 stt.enabled=true）' }),
  );

  const grid = h('div', { class: 'media-grid' });
  if (items.length === 0) grid.appendChild(emptyBox('没有符合条件的媒体'));
  for (const md of items) grid.appendChild(renderMediaCard(md));

  return h(
    'div',
    {},
    pageHead('媒体管理', '缩略图网格 · 按类型/状态/会话/日期筛选 · 可按语音内容搜索'),
    toolbar,
    batchRow,
    grid,
    pager(data.total ?? items.length, page, PAGE_SIZE_MEDIA, (p) => updateParams({ page: p }, 'media')),
  );
}

function renderMediaCard(md) {
  const thumbBox = h('div', { class: 'thumb-box' });
  const isImage = md.kind === 'image';
  const canThumb = md.status === 'present' && (isImage || md.kind === 'video');

  if (canThumb) {
    const img = h('img', { src: mediaThumbUrl(md), alt: md.relPath || `媒体 #${md.id}`, loading: 'lazy' });
    img.addEventListener('error', () => {
      if (img.dataset.retried) {
        thumbBox.replaceChildren(h('span', { class: 'big-icon', text: mediaKindIcon(md.kind) }));
        return;
      }
      img.dataset.retried = '1';
      img.src = mediaRawUrl(md);
    });
    thumbBox.appendChild(img);
  } else {
    thumbBox.appendChild(h('span', { class: 'big-icon', text: mediaKindIcon(md.kind) }));
  }

  if (isFiniteNumber(md.duration)) thumbBox.appendChild(h('span', { class: 'dur', text: formatDuration(md.duration) }));
  if (md.status !== 'present') {
    thumbBox.appendChild(h('span', { class: 'flag' }, badge(mediaStatusLabel(md.status), statusClass(md.status))));
  }
  thumbBox.addEventListener('click', () => {
    if (md.status === 'present' && (isImage || md.kind === 'video' || md.kind === 'audio')) openMediaModal(md);
    else openMediaModal(md);
  });

  const transcriptBox = h('div', { class: 'transcript' });
  fillTranscript(transcriptBox, md);

  const actions = h('div', { class: 'actions' });
  if (md.status === 'present') {
    if (isImage || md.kind === 'video') actions.appendChild(h('button', { class: 'sm', text: '预览', on: { click: () => openMediaModal(md) } }));
    actions.appendChild(h('a', { class: 'btn sm', href: mediaRawUrl(md), download: '', target: '_blank', rel: 'noopener', text: '下载' }));
    if (md.kind === 'audio') {
      const btn = h('button', { class: 'sm', text: md.transcript === null || md.transcript === undefined ? '转写' : '重新转写' });
      btn.addEventListener('click', () => void transcribeMedia(md, btn, transcriptBox));
      actions.appendChild(btn);
    }
  }
  actions.appendChild(h('button', { class: 'sm', text: '校验', on: { click: () => void verifyMedia(md.id, actions.lastChild) } }));

  const info = h(
    'div',
    { class: 'info' },
    h('div', { class: 'name', text: md.relPath ? md.relPath.split('/').pop() : `#${md.id}` }),
    h('div', { class: 'sub', text: `${mediaKindLabel(md.kind)} · ${formatBytes(md.size)} · ${md.mime || '未知类型'}` }),
    h('div', { class: 'sub', text: `会话：${md.sessionName || '—'}${md.messageId ? ` · 消息 #${md.messageId}` : ''}` }),
    h('div', { class: 'sub', text: `时间：${md.ts ? formatIso(md.ts) : formatIso(md.createdAt)}` }),
    md.kind === 'audio' ? transcriptBox : null,
    md.failReason ? h('div', { class: 'sub bad-text', text: `原因：${md.failReason}` }) : null,
    md.thumbUrl === null && md.kind === 'video' ? h('div', { class: 'sub faint', text: '无缩略图，显示类型图标' }) : null,
  );

  return h(
    'div',
    { class: `media-card${md.status !== 'present' ? ` is-${md.status}` : ''}` },
    thumbBox,
    info,
    actions,
  );
}

/** 按 md.transcript 填充语音转写槽：null=未转写，''=无语音内容，非空=正文。 */
function fillTranscript(box, md) {
  box.replaceChildren();
  if (md.transcript === null || md.transcript === undefined) {
    box.appendChild(h('span', { class: 'flag' }, badge('未转写', 'muted')));
  } else if (md.transcript === '') {
    box.appendChild(h('span', { class: 'flag' }, badge('无语音内容', 'muted')));
  } else {
    box.appendChild(h('div', { class: 'sub transcript-text', text: md.transcript }));
  }
}

/** 单条转写：POST 后把结果就地写回卡片，不重载整页。 */
async function transcribeMedia(md, btn, box) {
  if (btn.disabled) return;
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = '转写中…';
  try {
    const result = await api(`/api/media/${md.id}/transcribe`, { method: 'POST' });
    const stored = result && result.transcript ? result.transcript : null;
    md.transcript = stored ? stored.text : typeof result.text === 'string' ? result.text : '';
    fillTranscript(box, md);
    btn.disabled = false;
    btn.textContent = '重新转写';
    toast(`媒体 #${md.id} 转写完成：${md.transcript ? `${md.transcript.length} 字` : '无语音内容'}`);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = original;
    toast(`转写失败：${err.message}`, 'bad');
  }
}

/** 批量转写：完成后重载当前页，让所有卡片的转写状态刷新。 */
async function runBatchTranscribe(btn) {
  if (btn.disabled) return;
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = '转写中…';
  try {
    const stats = await api('/api/stt/transcribe', { method: 'POST', body: { limit: 20 } });
    toast(`批量转写：成功 ${stats.transcribed}｜无内容 ${stats.empty}｜跳过 ${stats.skipped}｜失败 ${stats.failed}`);
    await renderRoute();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = original;
    toast(`批量转写失败：${err.message}`, 'bad');
  }
}

/* ==================================================================== *
 * 页面：归档管理
 * ==================================================================== */

async function viewArchive() {
  const kind = pget('kind');
  const status = pget('status');
  const page = Number(pget('page', '1')) || 1;

  const [collect, stats, jobs] = await Promise.all([
    api('/api/collect/health').catch((err) => ({ __error: err.message })),
    api('/api/stats'),
    api('/api/jobs', { params: { kind, status, page, pageSize: PAGE_SIZE_JOBS } }),
  ]);
  const items = Array.isArray(jobs.items) ? jobs.items : [];

  const statusCards = h(
    'div',
    { class: 'stat-grid' },
    statCard('采集器', collect && !collect.__error ? (collect.ok ? '正常' : '异常') : '不可用', collect && collect.lastOkAt ? `最近成功 ${formatIso(collect.lastOkAt)}` : '', collect && collect.ok ? 'ok' : 'bad'),
    statCard('连续失败', collect && isFiniteNumber(collect.consecutiveFailures) ? collect.consecutiveFailures : '—', '采集失败次数', collect && collect.consecutiveFailures > 0 ? 'warn' : undefined),
    statCard('待处理任务', stats.pendingJobs ?? 0, 'pending / running', stats.pendingJobs > 0 ? 'warn' : undefined),
    statCard('失败任务', stats.failedJobs ?? 0, '需要处理', stats.failedJobs > 0 ? 'bad' : undefined),
    statCard('消息总数', stats.messages ?? 0, `媒体 ${stats.mediaTotal ?? 0} 个`),
    statCard('媒体占用', formatBytes(stats.mediaBytes)),
  );

  const noticeSlot = h('div');
  const streamSlot = h('div');
  const collectCard = collectControlCard();
  // 采集的"开始/停止/立即一轮"统一用采集控制面板（总览页同款），
  // 归档管理页保留备份与导入这类只在管理页做的事。
  const actionRow = h(
    'div',
    { class: 'row' },
    h('button', { class: 'sm', text: '手动备份（含校验）', on: { click: (ev) => runBackup(ev.currentTarget) } }),
    h('button', { class: 'sm', text: '刷新本页', on: { click: () => void renderRoute(true) } }),
  );

  // —— 手动导入表单 ——
  const pathInput = h('input', { type: 'text', placeholder: '服务器上的绝对路径，例如 /srv/qq/export/group_123.json', class: 'grow' });
  const formatSel = selectEl(
    [
      { value: '', label: '自动探测' },
      { value: 'qce-json', label: 'qce-json' },
      { value: 'qce-jsonl', label: 'qce-jsonl' },
      { value: 'qce-txt', label: 'qce-txt' },
      { value: 'generic-jsonl', label: 'generic-jsonl' },
    ],
    '',
  );
  const accountInput = h('input', { type: 'text', placeholder: '账号 uid（可空，默认 default）' });
  const importBtn = h('button', { class: 'primary sm', type: 'submit', text: '开始导入' });
  const importForm = h(
    'form',
    { class: 'toolbar' },
    h('div', { class: 'grow' }, pathInput),
    formatSel,
    accountInput,
    importBtn,
  );
  importForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    noticeSlot.replaceChildren();
    const path = pathInput.value.trim();
    if (!path) {
      noticeSlot.replaceChildren(h('div', { class: 'notice bad', text: '请填写服务器上的绝对路径' }));
      return;
    }
    importBtn.disabled = true;
    importBtn.textContent = '提交中…';
    try {
      const body = { path };
      if (formatSel.value) body.format = formatSel.value;
      if (accountInput.value.trim()) body.accountUid = accountInput.value.trim();
      const result = await api('/api/import', { method: 'POST', body });
      const jobId = result && (result.id || result.jobId || (result.job && result.job.id));
      noticeSlot.replaceChildren(
        h('div', { class: 'notice ok', text: `导入任务已创建${jobId ? `：#${jobId}` : ''}，正在后台执行。` }),
      );
      if (jobId) openJobStream(Number(jobId), streamSlot);
      setTimeout(() => void renderRoute(true), 1500);
    } catch (err) {
      noticeSlot.replaceChildren(errorBox(err));
    } finally {
      importBtn.disabled = false;
      importBtn.textContent = '开始导入';
    }
  });

  // —— 任务列表 ——
  const jobRows = h('tbody', {});
  if (items.length === 0) {
    jobRows.appendChild(h('tr', {}, h('td', { colspan: '8', text: '暂无任务' })));
  }
  for (const job of items) {
    jobRows.appendChild(
      h(
        'tr',
        {},
        h('td', { class: 'mono', text: `#${job.id}` }),
        h('td', { text: job.kind }),
        h('td', {}, badge(jobStatusLabel(job.status), statusClass(job.status))),
        h('td', {}, progressBar(job), h('span', { class: 'faint small', text: ` ${jobProgress(job)}%` })),
        h('td', { class: 'num', text: `${job.inserted ?? 0} / ${job.duplicate ?? 0} / ${job.failed ?? 0}` }),
        h('td', { class: 'num', text: `${job.mediaSaved ?? 0} / ${job.mediaMissing ?? 0}` }),
        h('td', { class: 'small faint', text: formatIso(job.createdAt) }),
        h(
          'td',
          {},
          h('button', { class: 'sm', text: '进度', on: { click: () => openJobStream(job.id, streamSlot) } }),
          job.error ? h('div', { class: 'bad-text small', text: truncate(job.error, 60) }) : null,
          job.message ? h('div', { class: 'faint small', text: truncate(job.message, 60) }) : null,
        ),
      ),
    );
  }
  const table = h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      { class: 'data' },
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          h('th', { text: 'ID' }),
          h('th', { text: '类型' }),
          h('th', { text: '状态' }),
          h('th', { text: '进度' }),
          h('th', { text: '写入/重复/失败' }),
          h('th', { text: '媒体 保存/缺失' }),
          h('th', { text: '创建时间' }),
          h('th', { text: '操作' }),
        ),
      ),
      jobRows,
    ),
  );

  const jobToolbar = h(
    'div',
    { class: 'toolbar' },
    selectEl(
      [
        { value: '', label: '全部任务类型' },
        { value: 'import', label: 'import' },
        { value: 'collect', label: 'collect' },
        { value: 'backup', label: 'backup' },
      ],
      kind,
      (ev) => updateParams({ kind: ev.target.value, page: null }, 'archive'),
    ),
    selectEl(
      [
        { value: '', label: '全部状态' },
        { value: 'pending', label: '待处理' },
        { value: 'running', label: '进行中' },
        { value: 'done', label: '成功' },
        { value: 'failed', label: '失败' },
        { value: 'cancelled', label: '已取消' },
      ],
      status,
      (ev) => updateParams({ status: ev.target.value, page: null }, 'archive'),
    ),
    h('span', { class: 'spacer', style: { flex: '1' } }),
    buildPollControl(),
  );

  const collectPairs = [
    ['采集器状态', collect && !collect.__error ? badge(collect.ok ? '正常' : '异常', collect.ok ? 'ok' : 'bad') : badge('接口不可用', 'bad')],
    ['最近成功', formatIso(collect && collect.lastOkAt)],
    ['连续失败次数', collect && isFiniteNumber(collect.consecutiveFailures) ? String(collect.consecutiveFailures) : '—'],
    ['最近错误', collect && collect.lastError ? h('span', { class: 'bad-text', text: collect.lastError }) : '—'],
  ];

  return h(
    'div',
    {},
    pageHead('归档管理', '采集控制 · 任务进度 · 手动导入 / 备份'),
    collectCard,
    statusCards,
    h('div', { class: 'cols-2' }, h('div', { class: 'card' }, h('h3', { text: '最近采集状态' }), kvList(collectPairs)), h('div', { class: 'card' }, h('h3', { text: '操作' }), actionRow, noticeSlot)),
    h('div', { class: 'card' }, h('h3', { text: '手动导入' }), h('p', { class: 'card-sub', text: '仅接受服务器可读的绝对路径；导入在后台异步执行，可通过下方“进度”查看实时事件流。' }), importForm),
    h('div', { class: 'card' }, h('h3', { text: '任务列表' }), jobToolbar, table, pager(jobs.total ?? items.length, page, PAGE_SIZE_JOBS, (p) => updateParams({ page: p }, 'archive'))),
    streamSlot,
  );
}

function buildPollControl() {
  const current = readPollMs();
  return h(
    'label',
    { class: 'field' },
    h('span', { text: '自动轮询' }),
    selectEl(
      [
        { value: '0', label: '关闭' },
        { value: '2000', label: '每 2 秒' },
        { value: '5000', label: '每 5 秒（默认）' },
        { value: '30000', label: '每 30 秒' },
      ],
      String(current || 0),
      (ev) => {
        const ms = Number(ev.target.value) || 0;
        savePollMs(ms);
        stopPolling();
        // 聊天记录页有增量刷新（只追加新消息），与归档页的整页轮询分开管理
        if (typeof stopChatAutoRefresh === 'function') stopChatAutoRefresh();
        if (state.route === 'chats' && typeof startChatAutoRefresh === 'function') startChatAutoRefresh();
        else if (ms > 0) pollTimer = setInterval(() => void renderRoute(), ms);
        toast(ms > 0 ? `已开启自动刷新（每 ${ms / 1000} 秒）` : '已关闭自动刷新');
      },
    ),
  );
}

/** SSE 实时进度：/api/jobs/:id/events?access=<token>；失败自动退回轮询。 */
function openJobStream(jobId, slot) {
  stopStream();
  const panel = h('div', { class: 'card' }, h('h3', { text: `任务 #${jobId} 实时进度` }));
  const stateLine = h('div', { class: 'faint small', text: '正在连接事件流…' });
  const bar = h('div', { class: 'progress' }, h('i', { style: { width: '0%' } }));
  const detail = h('pre', { class: 'pre', text: '等待事件…' });
  panel.appendChild(h('div', { class: 'stack' }, stateLine, bar, detail));
  slot.replaceChildren(panel);

  const apply = (raw) => {
    let data = raw;
    try {
      data = JSON.parse(raw);
    } catch { /* 保留原始文本 */ }
    if (data && typeof data === 'object' && data.data && typeof data.data === 'object') data = data.data;
    if (!data || typeof data !== 'object') {
      detail.textContent = String(raw);
      return;
    }
    const pct = jobProgress(data);
    bar.firstChild.style.width = `${pct}%`;
    if (data.status === 'done') bar.className = 'progress done';
    if (data.status === 'failed') bar.className = 'progress failed';
    stateLine.textContent = `状态：${jobStatusLabel(data.status)} · 进度 ${pct}%`;
    detail.textContent = JSON.stringify(data, null, 2);
    if (data.status === 'done' || data.status === 'failed' || data.status === 'cancelled') {
      setTimeout(() => void renderRoute(), 800);
    }
  };

  const url = accessUrl(`/api/jobs/${jobId}/events`);
  let es;
  try {
    es = new EventSource(url);
  } catch (err) {
    stateLine.textContent = `无法建立事件流：${err && err.message ? err.message : err}`;
    return;
  }
  activeStream = es;
  es.onopen = () => {
    stateLine.textContent = '事件流已连接，等待进度…';
  };
  es.onmessage = (ev) => apply(ev.data);
  for (const name of ['progress', 'update', 'job', 'status', 'done', 'error']) {
    es.addEventListener(name, (ev) => apply(ev.data));
  }
  es.onerror = () => {
    stateLine.textContent = '事件流中断，已回退到 2 秒轮询。';
    try {
      es.close();
    } catch { /* ignore */ }
    if (activeStream === es) activeStream = null;
    stopPolling();
    pollTimer = setInterval(async () => {
      try {
        const job = await api(`/api/jobs/${jobId}`);
        apply(job);
      } catch { /* 轮询失败静默重试 */ }
    }, 2000);
  };
}

/* ==================================================================== *
 * 页面：日志
 * ==================================================================== */

async function viewLogs() {
  const level = pget('level');
  const scope = pget('scope');
  const page = Number(pget('page', '1')) || 1;

  const data = await api('/api/logs', { params: { level, scope, page, pageSize: PAGE_SIZE_LOGS } });
  const items = Array.isArray(data.items) ? data.items : [];

  const scopeInput = h('input', { type: 'search', value: scope, placeholder: 'scope，例如 db / server / collect' });
  const scopeForm = h('form', { class: 'inline' }, scopeInput, h('button', { class: 'sm', type: 'submit', text: '筛选' }));
  scopeForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    updateParams({ scope: scopeInput.value.trim(), page: null }, 'logs');
  });

  const toolbar = h(
    'div',
    { class: 'toolbar' },
    selectEl(
      [
        { value: '', label: '全部级别' },
        { value: 'debug', label: '调试' },
        { value: 'info', label: '信息' },
        { value: 'warn', label: '警告' },
        { value: 'error', label: '错误' },
      ],
      level,
      (ev) => updateParams({ level: ev.target.value, page: null }, 'logs'),
    ),
    scopeForm,
    level || scope ? h('button', { class: 'ghost sm', text: '清除筛选', on: { click: () => updateParams({ level: null, scope: null, page: null }, 'logs') } }) : null,
  );

  const rows = h('tbody', {});
  if (items.length === 0) rows.appendChild(h('tr', {}, h('td', { colspan: '4', text: '暂无日志' })));
  for (const log of items) {
    const dataText = log.data === null || log.data === undefined ? '—' : typeof log.data === 'string' ? log.data : JSON.stringify(log.data, null, 2);
    rows.appendChild(
      h(
        'tr',
        {},
        h('td', { class: 'mono nowrap', text: formatIso(log.ts) }),
        h('td', {}, badge(logLevelLabel(log.level), statusClass(log.level))),
        h('td', { class: 'mono', text: log.scope }),
        h('td', {}, h('div', { text: log.message }), log.data !== null && log.data !== undefined ? h('pre', { class: 'pre', style: { marginTop: '6px' }, text: dataText }) : null),
      ),
    );
  }

  return h(
    'div',
    {},
    pageHead('日志', '按级别与 scope 过滤，展示结构化 data'),
    toolbar,
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'data' },
        h('thead', {}, h('tr', {}, h('th', { text: '时间' }), h('th', { text: '级别' }), h('th', { text: 'scope' }), h('th', { text: '内容 / data' }))),
        rows,
      ),
    ),
    pager(data.total ?? items.length, page, PAGE_SIZE_LOGS, (p) => updateParams({ page: p }, 'logs')),
  );
}

/* ==================================================================== *
 * 页面：导出
 * ==================================================================== */

async function viewExport() {
  const sessions = await fetchSessionOptions();
  const sessionId = pget('sessionId') || (sessions[0] ? String(sessions[0].id) : '');
  const format = pget('format', 'json');
  const from = pget('from');
  const to = pget('to');

  if (sessions.length === 0) {
    return h('div', {}, pageHead('导出', '会话数据导出'), emptyBox('还没有任何会话，先导入或采集数据'));
  }

  const sessionSel = selectEl(
    sessions.map((s) => ({ value: String(s.id), label: `${s.name || s.remark || s.peerUid}（#${s.id} · ${chatTypeLabel(s.chatType)}）` })),
    sessionId,
    (ev) => updateParams({ sessionId: ev.target.value }, 'export'),
  );
  const formatSel = selectEl(
    [
      { value: 'json', label: 'json（完整字段）' },
      { value: 'jsonl', label: 'jsonl（每行一条）' },
      { value: 'txt', label: 'txt（可读文本）' },
    ],
    format,
    (ev) => updateParams({ format: ev.target.value }, 'export'),
  );
  const fromInput = h('input', { type: 'datetime-local', value: from, on: { change: (ev) => updateParams({ from: ev.target.value }, 'export') } });
  const toInput = h('input', { type: 'datetime-local', value: to, on: { change: (ev) => updateParams({ to: ev.target.value }, 'export') } });

  const chosen = sessions.find((s) => String(s.id) === String(sessionId));
  const downloadUrl = accessUrl(`/api/export/session/${sessionId}`, {
    format,
    from: from ? from.replace('T', ' ') : undefined,
    to: to ? to.replace('T', ' ') : undefined,
  });
  const fileName = `${(chosen && (chosen.name || chosen.peerUid)) || `session-${sessionId}`}.${format}`;

  const link = h('a', {
    class: 'btn primary',
    href: downloadUrl,
    download: fileName,
    target: '_blank',
    rel: 'noopener',
    text: '下载导出文件',
  });

  return h(
    'div',
    {},
    pageHead('导出', '按会话与时间范围导出归档数据（json / jsonl / txt）'),
    h(
      'div',
      { class: 'card' },
      h(
        'div',
        { class: 'toolbar' },
        h('label', { class: 'field grow' }, h('span', { text: '会话' }), sessionSel),
        h('label', { class: 'field' }, h('span', { text: '格式' }), formatSel),
        h('label', { class: 'field' }, h('span', { text: '起始时间' }), fromInput),
        h('label', { class: 'field' }, h('span', { text: '结束时间' }), toInput),
        h('div', { class: 'inline' }, link),
      ),
      h('p', { class: 'card-sub', text: '导出走流式响应；链接携带 access token 查询参数，因此可直接在新标签页下载。' }),
      kvList([
        ['会话', chosen ? `${chosen.name || chosen.remark || chosen.peerUid}（#${chosen.id}）` : sessionId],
        ['类型', chosen ? chatTypeLabel(chosen.chatType) : '—'],
        ['消息数', chosen ? String(chosen.messageCount ?? 0) : '—'],
        ['时间范围', `${from || '不限'} ~ ${to || '不限'}`],
        ['下载地址', h('span', { class: 'mono', text: buildUrl(`/api/export/session/${sessionId}`, { format, from: from || undefined, to: to || undefined }) })],
      ]),
    ),
    h(
      'div',
      { class: 'card' },
      h('h3', { text: '会话一览' }),
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'data' },
          h('thead', {}, h('tr', {}, h('th', { text: 'ID' }), h('th', { text: '名称' }), h('th', { text: '类型' }), h('th', { text: '消息数' }), h('th', { text: '最近消息' }), h('th', { text: '导出' }))),
          h(
            'tbody',
            {},
            sessions.map((s) =>
              h(
                'tr',
                {},
                h('td', { class: 'mono', text: `#${s.id}` }),
                h('td', { text: s.name || s.remark || s.peerUid }),
                h('td', { text: chatTypeLabel(s.chatType) }),
                h('td', { class: 'num', text: String(s.messageCount ?? 0) }),
                h('td', { class: 'small faint', text: formatIso(s.lastMessageAt) }),
                h(
                  'td',
                  {},
                  h('a', { class: 'btn sm', href: accessUrl(`/api/export/session/${s.id}`, { format }), download: '', target: '_blank', rel: 'noopener', text: format }),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

/* ==================================================================== *
 * 页面注册与启动
 * ==================================================================== */

/* ==================================================================== *
 * QQ 登录：NapCat WebUI 扫码登录 / 快捷登录
 *
 * 二维码明文 URL 本身是一份登录凭据，服务端刻意只下发渲染好的 PNG
 * data URL —— 前端因此拿不到那个凭据，也无从把它写进 localStorage 或日志。
 * 本视图只做展示与触发；真正的登录动作全部发生在 NapCat 侧。
 * ==================================================================== */

/** 不上远端头像：避免浏览本页时向 QQ 图床暴露「有人正在看这个归档后台」。 */
function accountAvatar(name, uin) {
  const text = (name || uin || '?').trim().slice(0, 1).toUpperCase();
  return h('div', { class: 'avatar', text, title: name || uin || '' });
}

async function viewQqLogin() {
  const statusSlot = h('div', { class: 'stat-grid' });
  const hintSlot = h('div');
  const qrSlot = h('div', { class: 'card' }, h('h3', { text: '扫码登录' }), loading());
  const accountsSlot = h('div', { class: 'card' }, h('h3', { text: '快捷登录' }), loading());
  const wrap = h('div', {}, statusSlot, hintSlot, qrSlot, accountsSlot);

  let timer = null;
  let configuredNow = false;
  let lastQrAt = 0;

  const stopTimer = () => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  function paintStatus(status) {
    configuredNow = Boolean(status.configured);
    statusSlot.replaceChildren(
      statCard('NapCat 连接', status.connected ? '已连接' : '未连接', status.baseUrl || status.webuiUrl || '—', status.connected ? 'ok' : 'bad'),
      statCard('QQ 登录状态', status.isLogin ? '已登录' : '未登录', status.uin ? `账号 ${status.uin}` : '等待扫码', status.isLogin ? 'ok' : 'warn'),
      statCard('配置', configuredNow ? '已填写 token' : '未配置', configuredNow ? '' : 'collector.napcat.token', configuredNow ? undefined : 'bad'),
    );
    hintSlot.replaceChildren();
    if (!configuredNow) {
      hintSlot.appendChild(
        h(
          'div',
          { class: 'notice' },
          h('div', { text: '尚未配置 NapCat WebUI，本页无法获取二维码。' }),
          h('div', { class: 'faint small', text: '在 config.json 的 collector.napcat 里填 webuiUrl 与 token；token 取自 NapCat 的 config/webui.json。' }),
          h('div', { class: 'faint small', text: '注意：这是 NapCat WebUI 的 token，与 OneBot 的 access token 不是同一个。未配置不影响归档、导入、检索等其余功能。' }),
        ),
      );
      return;
    }
    if (status.error) {
      hintSlot.appendChild(
        h(
          'div',
          { class: 'notice bad' },
          h('div', { text: `NapCat 不可达：${status.error}` }),
          h('div', { class: 'faint small', text: '请确认 NapCat 正在运行、WebUI 已开启，且 webuiUrl 指向它监听的地址与端口。' }),
        ),
      );
    }
  }

  async function loadQr() {
    try {
      const data = await api('/api/napcat/qrcode', { method: 'POST', body: {} });
      if (data.isLogin) {
        stopTimer();
        qrSlot.replaceChildren(
          h('h3', { text: '扫码登录' }),
          h('div', { class: 'notice ok', text: `QQ 已登录${data.uin ? `（账号 ${data.uin}）` : ''}，无需扫码。` }),
          h('div', { class: 'faint small', text: '若要让归档自动采集新消息：在 NapCat 中开启 OneBot HTTP 服务，再把 config.json 的 collector.kind 设为 onebot，baseUrl 指向该服务。' }),
        );
        return;
      }
      if (!data.png) {
        qrSlot.replaceChildren(h('h3', { text: '扫码登录' }), h('div', { class: 'notice bad', text: '服务端未返回二维码图片。' }));
        return;
      }
      lastQrAt = Date.now();
      const btn = h('button', { class: 'sm', text: '重新生成二维码' });
      btn.addEventListener('click', () => {
        btn.disabled = true;
        void loadQr().finally(() => {
          btn.disabled = false;
        });
      });
      qrSlot.replaceChildren(
        h('h3', { text: '扫码登录' }),
        h('div', { class: 'qr-wrap' }, h('img', { class: 'qr', src: data.png, alt: 'QQ 登录二维码' })),
        h('div', { class: 'faint small', text: '打开手机 QQ → 右上角「+」→ 扫一扫，扫描上方二维码并在手机上确认。' }),
        h('div', { class: 'faint small', text: `二维码约 2 分钟失效，本页每 3 秒自动检查登录状态（生成于 ${new Date().toLocaleTimeString('zh-CN')}）。` }),
        h('div', { class: 'row', style: { marginTop: '10px' } }, btn),
      );
    } catch (err) {
      qrSlot.replaceChildren(h('h3', { text: '扫码登录' }), errorBox(err, () => loadQr()));
    }
  }

  async function loadAccounts() {
    try {
      const data = await api('/api/napcat/accounts');
      const accounts = Array.isArray(data.accounts) ? data.accounts : [];
      const body = h('tbody', {});
      if (accounts.length === 0) {
        body.appendChild(h('tr', {}, h('td', { colspan: '4', text: '没有可快捷登录的账号。首次使用请先用手机扫码登录一次，QQ 才会记住这个账号。' })));
      }
      for (const acc of accounts) {
        const uin = String(acc.uin ?? '');
        const btn = h('button', { class: 'primary sm', text: '快速登录', disabled: acc.isQuickLogin === false });
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          btn.textContent = '触发中…';
          try {
            const result = await api('/api/napcat/quick-login', { method: 'POST', body: { uin } });
            if (result.ok) toast(`已触发账号 ${uin} 的快速登录`);
            else if (result.alreadyLoggedIn) toast(`账号 ${uin} 已在登录流程中${result.message ? `：${result.message}` : ''}`, 'bad');
            else toast(result.message || `账号 ${uin} 登录失败`, 'bad');
            await refresh(true);
          } catch (err) {
            toast(err && err.message ? err.message : String(err), 'bad');
          } finally {
            btn.textContent = '快速登录';
            btn.disabled = acc.isQuickLogin === false;
          }
        });
        body.appendChild(
          h(
            'tr',
            {},
            h('td', {}, accountAvatar(acc.nickname, uin)),
            h('td', { text: acc.nickname || '（无昵称）' }),
            h('td', { class: 'mono', text: uin }),
            h('td', {}, btn),
          ),
        );
      }
      accountsSlot.replaceChildren(
        h('h3', { text: '快捷登录' }),
        h('div', { class: 'card-sub', text: '用 QQ 本地已保存的登录态直接上线，无需再次扫码。' }),
        h(
          'div',
          { class: 'table-wrap' },
          h(
            'table',
            { class: 'data' },
            h('thead', {}, h('tr', {}, h('th', { text: '头像' }), h('th', { text: '昵称' }), h('th', { text: '账号' }), h('th', { text: '操作' }))),
            body,
          ),
        ),
      );
    } catch (err) {
      accountsSlot.replaceChildren(h('h3', { text: '快捷登录' }), errorBox(err, () => loadAccounts()));
    }
  }

  /** 刷新状态；`withAccounts` 为真时同时重载快捷登录列表。 */
  async function refresh(withAccounts) {
    const status = await api('/api/napcat/status');
    paintStatus(status);
    if (!configuredNow) return;
    if (withAccounts) await loadAccounts();
    // 二维码到期（约 2 分钟）后重新取一张；已登录时 loadQr 会切到「已登录」文案并停表。
    if (status.isLogin || Date.now() - lastQrAt > 90_000) await loadQr();
  }

  try {
    await refresh(true);
  } catch (err) {
    wrap.replaceChildren(errorBox(err, () => renderRoute(true)));
    return wrap;
  }

  if (configuredNow) {
    timer = setInterval(() => {
      if (state.route !== 'qq') {
        // 已离开本页：停表，避免后台继续打 NapCat。
        stopTimer();
        return;
      }
      void refresh(false).catch(() => {});
    }, 3000);
  }

  return wrap;
}

const VIEWS = {
  overview: viewOverview,
  qq: viewQqLogin,
  chats: viewChats,
  media: viewMedia,
  archive: viewArchive,
  logs: viewLogs,
  export: viewExport,
};

async function render() {
  stopPolling();
  stopStream();
  const parsed = parseHash(location.hash);
  state.route = parsed.route;
  state.params = parsed.params;

  if (!state.token) {
    renderLogin();
    return;
  }
  if (parsed.route === 'login') {
    setHash(DEFAULT_ROUTE, {}, true);
    return;
  }
  mountShell();
  await renderRoute();
  const poll = readPollMs();
  if (poll > 0 && state.route === 'archive') pollTimer = setInterval(() => void renderRoute(), poll);
}

async function boot() {
  window.addEventListener('hashchange', () => void render());
  if (state.token) {
    try {
      await api('/api/auth/session', { redirectOn401: false });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) clearToken();
    }
    await refreshHealth();
  }
  if (location.hash === '') {
    history.replaceState(null, '', hashFor(DEFAULT_ROUTE, {}));
  }
  await render();
}

void boot();
