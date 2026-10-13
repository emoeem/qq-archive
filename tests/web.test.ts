import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import * as lib from '../web/lib.js';
import {
  DEFAULT_ROUTE,
  ROUTES,
  buildUrl,
  chatTypeLabel,
  clampPage,
  escapeHtml,
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
} from '../web/lib.js';

const webFile = (name: string): string => readFileSync(new URL(`../web/${name}`, import.meta.url), 'utf8');

/* ------------------------------------------------------------------ *
 * 时间格式化边界
 * ------------------------------------------------------------------ */

test('lib: formatTime 补零与本地时区格式', () => {
  const ts = new Date(2024, 0, 2, 3, 4, 5).getTime();
  assert.equal(formatTime(ts), '2024-01-02 03:04:05');
  const noon = new Date(2026, 9, 13, 12, 0, 0).getTime();
  assert.equal(formatTime(noon), '2026-10-13 12:00:00');
  assert.equal(formatTime(new Date(2024, 11, 31, 23, 59, 59).getTime()), '2024-12-31 23:59:59');
});

test('lib: formatTime 无效输入一律返回占位符', () => {
  assert.equal(formatTime(0), '—');
  assert.equal(formatTime(-1), '—');
  assert.equal(formatTime(Number.NaN), '—');
  assert.equal(formatTime(Number.POSITIVE_INFINITY), '—');
  assert.equal(formatTime(null), '—');
  assert.equal(formatTime(undefined), '—');
});

test('lib: formatIso 接受 ISO 字符串 / 秒级数字 / 毫秒', () => {
  const ts = new Date(2025, 5, 6, 7, 8, 9).getTime();
  assert.equal(formatIso(ts), '2025-06-06 07:08:09');
  assert.equal(formatIso(new Date(ts).toISOString()), '2025-06-06 07:08:09');
  assert.equal(formatIso('2025-06-06 07:08:09'), '2025-06-06 07:08:09');
  assert.equal(formatIso(String(Math.floor(ts / 1000))), '2025-06-06 07:08:09');
  assert.equal(formatIso(''), '—');
  assert.equal(formatIso(null), '—');
  assert.equal(formatIso('不是时间'), '—');
});

test('lib: formatRelative 各档位与未来时间', () => {
  const now = new Date(2026, 9, 13, 12, 0, 0).getTime();
  assert.equal(formatRelative(now - 30_000, now), '刚刚');
  assert.equal(formatRelative(now - 59_000, now), '刚刚');
  assert.equal(formatRelative(now - 60_000, now), '1 分钟前');
  assert.equal(formatRelative(now - 5 * 60_000, now), '5 分钟前');
  assert.equal(formatRelative(now - 3 * 3_600_000, now), '3 小时前');
  assert.equal(formatRelative(now - 2 * 86_400_000, now), '2 天前');
  assert.equal(formatRelative(now - 40 * 86_400_000, now), formatTime(now - 40 * 86_400_000));
  assert.equal(formatRelative(now + 10_000, now), formatTime(now + 10_000));
  assert.equal(formatRelative(0, now), '—');
});

/* ------------------------------------------------------------------ *
 * 字节 / 时长
 * ------------------------------------------------------------------ */

test('lib: formatBytes 单位边界', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1), '1 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(1024 * 1024), '1.0 MB');
  assert.equal(formatBytes(1024 ** 3), '1.0 GB');
  assert.equal(formatBytes(1024 ** 4), '1.0 TB');
  // 尚差 1 字节到 1MB：四舍五入后进位，单位必须跟着升级
  assert.equal(formatBytes(1024 * 1024 - 1), '1.0 MB');
  assert.equal(formatBytes(1024 * 1024 + 512 * 1024), '1.5 MB');
});

test('lib: formatCount 千分位与非法输入', () => {
  assert.equal(formatCount(0), '0');
  assert.equal(formatCount(7), '7');
  assert.equal(formatCount(999), '999');
  assert.equal(formatCount(1000), '1,000');
  assert.equal(formatCount(6043), '6,043');
  assert.equal(formatCount(1203551), '1,203,551');
  assert.equal(formatCount(1234567.9), '1,234,567', '小数截断而不是四舍五入');
  assert.equal(formatCount(-1500), '-1,500');
  assert.equal(formatCount(Number.NaN), '—');
  assert.equal(formatCount(Number.POSITIVE_INFINITY), '—');
  assert.equal(formatCount(null), '—');
  assert.equal(formatCount(undefined), '—');
  assert.equal(formatCount('1234'), '—', '字符串不做数字格式化');
});

test('web: 统计卡片对计数使用千分位（真实 app.js 断言）', () => {
  const src = webFile('app.js');
  assert.match(src, /formatCount/, 'app.js 必须使用 formatCount');
  assert.match(src, /formatCount\(value\)/, 'statCard 必须对数值走 formatCount');
});

test('lib: formatBytes 非法输入', () => {
  assert.equal(formatBytes(-1), '—');
  assert.equal(formatBytes(Number.NaN), '—');
  assert.equal(formatBytes(null), '—');
  assert.equal(formatBytes(undefined), '—');
});

test('lib: formatDuration', () => {
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(9), '0:09');
  assert.equal(formatDuration(65), '1:05');
  assert.equal(formatDuration(600), '10:00');
  assert.equal(formatDuration(3661), '1:01:01');
  assert.equal(formatDuration(-3), '—');
  assert.equal(formatDuration(null), '—');
});

/* ------------------------------------------------------------------ *
 * 中文标签
 * ------------------------------------------------------------------ */

test('lib: 类型/状态中文标签与未知回退', () => {
  assert.equal(chatTypeLabel('group'), '群聊');
  assert.equal(chatTypeLabel('private'), '私聊');
  assert.equal(chatTypeLabel('temp'), '临时会话');
  assert.equal(chatTypeLabel('other'), '其他');
  assert.equal(chatTypeLabel('nonsense'), '未知');
  assert.equal(chatTypeLabel(null), '未知');

  assert.equal(msgTypeLabel('text'), '文本');
  assert.equal(msgTypeLabel('image'), '图片');
  assert.equal(msgTypeLabel('audio'), '语音');
  assert.equal(msgTypeLabel('forward'), '转发');
  assert.equal(msgTypeLabel('system'), '系统');
  assert.equal(msgTypeLabel('???'), '其他');

  assert.equal(mediaKindLabel('image'), '图片');
  assert.equal(mediaKindLabel('video'), '视频');
  assert.equal(mediaKindLabel('file'), '文件');
  assert.equal(mediaKindIcon('image'), '🖼️');
  assert.equal(mediaKindIcon('unknown'), '📦');

  assert.equal(mediaStatusLabel('present'), '已保存');
  assert.equal(mediaStatusLabel('missing'), '缺失');
  assert.equal(mediaStatusLabel('corrupt'), '损坏');
  assert.equal(mediaStatusLabel('pending'), '待处理');
  assert.equal(mediaStatusLabel('x'), '未知');

  assert.equal(jobStatusLabel('done'), '成功');
  assert.equal(jobStatusLabel('running'), '进行中');
  assert.equal(jobStatusLabel('failed'), '失败');
  assert.equal(jobStatusLabel('cancelled'), '已取消');

  assert.equal(logLevelLabel('warn'), '警告');
  assert.equal(logLevelLabel('error'), '错误');
  assert.equal(logLevelLabel('debug'), '调试');
});

/* ------------------------------------------------------------------ *
 * URL 构造
 * ------------------------------------------------------------------ */

test('lib: buildUrl 参数拼接与跳过规则', () => {
  assert.equal(buildUrl('/api/media'), '/api/media');
  assert.equal(buildUrl('/api/media', {}), '/api/media');
  assert.equal(buildUrl('/api/media', null), '/api/media');
  assert.equal(buildUrl('/api/media', undefined), '/api/media');
  assert.equal(buildUrl('/api/media', { page: 1 }), '/api/media?page=1');
  assert.equal(
    buildUrl('/api/media', { kind: 'image', status: 'present', page: 2 }),
    '/api/media?kind=image&status=present&page=2',
  );
  // null / undefined / 空串跳过；0 与 false 保留（是有效取值）
  assert.equal(
    buildUrl('/api/media', { a: null, b: undefined, c: '', d: 0, e: false }),
    '/api/media?d=0&e=false',
  );
  assert.equal(buildUrl('/api/media', { a: Number.NaN }), '/api/media');
  // 已含查询串时用 & 续接
  assert.equal(
    buildUrl('/api/sessions/1/messages?limit=50', { before: 1700000000000 }),
    '/api/sessions/1/messages?limit=50&before=1700000000000',
  );
});

test('lib: buildUrl 对中文与特殊字符做 URI 编码', () => {
  assert.equal(buildUrl('/api/sessions', { keyword: '你好 世界' }), '/api/sessions?keyword=%E4%BD%A0%E5%A5%BD%20%E4%B8%96%E7%95%8C');
  assert.equal(buildUrl('/api/search', { q: 'a&b=c' }), '/api/search?q=a%26b%3Dc');
  const media = buildUrl('/api/media/7/raw', { access: 'tok+/=' });
  assert.equal(media, '/api/media/7/raw?access=tok%2B%2F%3D');
});

/* ------------------------------------------------------------------ *
 * HTML 转义 / 截断 / 状态类
 * ------------------------------------------------------------------ */

test('lib: escapeHtml 转义全部危险字符且不二次转义', () => {
  assert.equal(
    escapeHtml('<img src=x onerror="alert(1)">'),
    '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;',
  );
  assert.equal(escapeHtml("' OR 1=1 --"), '&#39; OR 1=1 --');
  assert.equal(escapeHtml('a & b'), 'a &amp; b');
  assert.equal(escapeHtml('&lt;'), '&amp;lt;');
  assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(escapeHtml(''), '');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(42), '42');
});

test('lib: truncate 按码点截断且不切坏 emoji', () => {
  assert.equal(truncate('', 5), '');
  assert.equal(truncate('abc', 5), 'abc');
  assert.equal(truncate('abcdef', 3), 'abc…');
  assert.equal(truncate('你好世界', 2), '你好…');
  assert.equal(truncate('😀😀😀', 2), '😀😀…');
  assert.equal(truncate('😀😀', 2), '😀😀');
  assert.equal(truncate('abc', 0), '…');
  assert.equal(truncate('', 0), '');
  assert.equal(truncate(null, 3), '');
});

test('lib: statusClass 映射', () => {
  assert.equal(statusClass('present'), 'ok');
  assert.equal(statusClass('done'), 'ok');
  assert.equal(statusClass('missing'), 'bad');
  assert.equal(statusClass('corrupt'), 'bad');
  assert.equal(statusClass('failed'), 'bad');
  assert.equal(statusClass('error'), 'bad');
  assert.equal(statusClass('pending'), 'warn');
  assert.equal(statusClass('running'), 'run');
  assert.equal(statusClass('cancelled'), 'muted');
  assert.equal(statusClass('whatever'), 'muted');
  assert.equal(statusClass(null), 'muted');
});

/* ------------------------------------------------------------------ *
 * hash 路由解析与回退
 * ------------------------------------------------------------------ */

test('lib: parseHash 解析路由与查询参数', () => {
  assert.deepEqual(parseHash('#/chats'), { route: 'chats', params: {}, fallback: false });
  assert.deepEqual(parseHash('/media'), { route: 'media', params: {}, fallback: false });
  assert.deepEqual(parseHash('#/logs?level=error&page=2'), {
    route: 'logs',
    params: { level: 'error', page: '2' },
    fallback: false,
  });
  const parsed = parseHash('#/chats?sessionId=3&q=%E4%BD%A0%E5%A5%BD');
  assert.equal(parsed.route, 'chats');
  assert.equal(parsed.params.sessionId, '3');
  assert.equal(parsed.params.q, '你好');
  assert.equal(parsed.fallback, false);
  // `+` 按表单语义还原为空格；key 无 `=` 时值为空串
  assert.equal(parseHash('#/search?q=a+b').params.q, 'a b');
  assert.equal(parseHash('#/search?flag').params.flag, '');
});

test('lib: parseHash 回退（空 / 未知 / 畸形编码）', () => {
  for (const bad of ['', '#', '#/', '/', '#/unknown-route', '#%E4']) {
    const parsed = parseHash(bad);
    assert.equal(parsed.route, DEFAULT_ROUTE, `hash=${JSON.stringify(bad)} 应回退`);
    assert.equal(parsed.fallback, true, `hash=${JSON.stringify(bad)} fallback 应为 true`);
  }
  assert.equal(parseHash(null).route, DEFAULT_ROUTE);
  assert.equal(parseHash(undefined).route, DEFAULT_ROUTE);
  // 畸形百分号编码不得抛异常，键值原样保留
  assert.equal(parseHash('#/logs?scope=%E4%').params.scope, '%E4%');
  assert.ok(ROUTES.includes(DEFAULT_ROUTE));
});

/* ------------------------------------------------------------------ *
 * 分页 / 进度
 * ------------------------------------------------------------------ */

test('lib: pageCount 与 clampPage', () => {
  assert.equal(pageCount(0, 50), 1);
  assert.equal(pageCount(50, 50), 1);
  assert.equal(pageCount(51, 50), 2);
  assert.equal(pageCount(100, 50), 2);
  assert.equal(pageCount(101, 50), 3);
  assert.equal(pageCount(-5, 50), 1);
  assert.equal(pageCount(10, 0), 1);
  assert.equal(clampPage(0, 100, 50), 1);
  assert.equal(clampPage(2, 100, 50), 2);
  assert.equal(clampPage(99, 100, 50), 2);
  assert.equal(clampPage(Number.NaN, 100, 50), 1);
});

test('lib: jobProgress 兼容 0–1 / 0–100 / processed:total', () => {
  assert.equal(jobProgress(null), 0);
  assert.equal(jobProgress({}), 0);
  assert.equal(jobProgress({ progress: 42 }), 42);
  assert.equal(jobProgress({ progress: 0.5 }), 50);
  assert.equal(jobProgress({ progress: 1 }), 100, 'progress<=1 视为比例，1 = 100%');
  assert.equal(jobProgress({ progress: 100 }), 100);
  assert.equal(jobProgress({ totalItems: 10, processed: 3 }), 30);
  assert.equal(jobProgress({ totalItems: 10, processed: 10 }), 100);
  assert.equal(jobProgress({ status: 'done' }), 100);
  assert.equal(jobProgress({ status: 'running' }), 0);
  assert.equal(jobProgress({ progress: 999 }), 100);
  assert.equal(jobProgress({ progress: -5, status: 'pending' }), 0);
});

test('lib: isFiniteNumber 判定', () => {
  assert.equal(isFiniteNumber(0), true);
  assert.equal(isFiniteNumber(-1.5), true);
  assert.equal(isFiniteNumber(Number.NaN), false);
  assert.equal(isFiniteNumber(Number.POSITIVE_INFINITY), false);
  assert.equal(isFiniteNumber('1'), false);
  assert.equal(isFiniteNumber(null), false);
});

/* ------------------------------------------------------------------ *
 * 结构与安全断言（对真实文件内容断言，而不是样例字符串）
 * ------------------------------------------------------------------ */

test('lib: 契约要求的纯函数全部导出且为函数', () => {
  const required = [
    'formatTime', 'formatBytes', 'formatCount', 'chatTypeLabel', 'msgTypeLabel', 'mediaKindLabel',
    'mediaStatusLabel', 'buildUrl', 'escapeHtml', 'truncate', 'statusClass', 'parseHash',
  ];
  for (const name of required) {
    assert.equal(typeof (lib as Record<string, unknown>)[name], 'function', `缺少导出 ${name}`);
  }
});

test('lib: 纯函数库不得触碰 DOM / window / localStorage / fetch', () => {
  const src = webFile('lib.js');
  assert.doesNotMatch(src, /\bdocument\b/, 'lib.js 不得引用 document');
  assert.doesNotMatch(src, /\bwindow\b/, 'lib.js 不得引用 window');
  assert.doesNotMatch(src, /\blocalStorage\b/, 'lib.js 不得引用 localStorage');
  assert.doesNotMatch(src, /\bfetch\s*\(/, 'lib.js 不得直接发起 fetch');
  // 动态 import 会破坏“可被 node:test 直接导入”的约束
  assert.doesNotMatch(src, /\bimport\s*\(/, 'lib.js 不得使用动态 import');
});

test('web: app.js 不存在字符串拼接 innerHTML（XSS 回归护栏）', () => {
  const src = webFile('app.js');
  assert.doesNotMatch(src, /innerHTML\s*=\s*[^;\n]*\+/, '禁止用 `+` 拼接写入 innerHTML');
  assert.doesNotMatch(src, /\binsertAdjacentHTML\b/, '禁止 insertAdjacentHTML');
  assert.doesNotMatch(src, /\bdocument\.write\b/, '禁止 document.write');
  assert.doesNotMatch(src, /\.outerHTML\s*=/, '禁止写 outerHTML');
  // 必须真的使用 textContent 承载用户数据
  assert.match(src, /textContent/, 'app.js 必须使用 textContent');
  // 唯一允许的 innerHTML 通道是后端已转义的高亮片段
  assert.match(src, /snippet/, '搜索结果必须使用后端 snippet 字段');
});

test('web: index.html 引用本地资源且自包含（无 CDN）', () => {
  const html = webFile('index.html');
  assert.match(html, /<script[^>]+src="\.\/app\.js"/, '必须引用本地 ./app.js');
  assert.match(html, /href="\.\/style\.css"/, '必须引用本地 ./style.css');
  assert.doesNotMatch(html, /https?:\/\/(?!127\.0\.0\.1|localhost)/, '不得引用外部 CDN 资源');
  assert.match(html, /<html lang="zh-CN">/);
});

test('web: app.js 的 API 调用全部走真实 /api/* 路径', () => {
  const src = webFile('app.js');
  const paths = [...src.matchAll(/['"`](\/api\/[A-Za-z0-9_\-/${}.]*)['"`]/g)].map((m) => m[1] ?? '');
  assert.ok(paths.length >= 10, `应调用至少 10 个不同 API 路径，实际 ${paths.length}`);
  for (const p of paths) {
    assert.match(p, /^\/api\//, `非法路径 ${p}`);
  }
  // 任务书要求的关键端点必须被使用
  for (const required of [
    '/api/auth/login',
    '/api/stats',
    '/api/health',
    '/api/sessions',
    '/api/search',
    '/api/media',
    '/api/jobs',
    '/api/import',
    '/api/backup',
    '/api/collect/run',
    '/api/logs',
    '/api/export/session/',
  ]) {
    assert.ok(paths.some((p) => p.includes(required)), `app.js 未调用 ${required}`);
  }
});

/**
 * 路由三张表必须一致：`lib.js` 的 `ROUTES`（路由表）、`app.js` 的 `NAV`（侧边栏）、
 * `VIEWS`（视图注册）。
 *
 * 背景（真实缺陷）：`parseHash()` 遇到不在 `ROUTES` 里的路由会**静默回退到总览**，
 * 于是 `qq` 漏在路由表里时，点侧边栏「QQ 登录」的表现是：
 *   地址栏变成 `#/qq`、侧边栏高亮也动了，但**右侧内容仍然是总览**，控制台没有任何报错。
 * 这是最难查的一类问题，所以这里用一条"三表一致"的用例把它钉死。
 */
test('web: 路由表 / 侧边栏 / 视图注册 三张表必须一致（qq 漏登记曾导致整页打不开）', () => {
  const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');

  // 侧边栏：NAV 里的 { route: 'xxx', ... }
  const navBlock = /const NAV = \[([\s\S]*?)\];/.exec(app);
  assert.ok(navBlock, 'app.js 里应能找到 NAV 定义');
  const navInner = navBlock[1] ?? '';
  const navRoutes = [...navInner.matchAll(/route:\s*'([a-z]+)'/g)].map((m) => m[1] ?? '').filter((r) => r !== '');

  // 视图注册：VIEWS 对象里的键
  const viewsBlock = /const VIEWS = \{([\s\S]*?)\};/.exec(app);
  assert.ok(viewsBlock, 'app.js 里应能找到 VIEWS 定义');
  const viewRoutes = (viewsBlock[1] ?? '')
    .split(',')
    .map((line) => (line.split(':')[0] ?? '').trim())
    .filter((k) => /^[a-z]+$/.test(k));

  assert.ok(navRoutes.length >= 6, `NAV 解析异常，只拿到 ${navRoutes.length} 条`);
  assert.ok(viewRoutes.length >= 6, `VIEWS 解析异常，只拿到 ${viewRoutes.length} 条`);

  // 1) 侧边栏上的每一项都必须能被路由解析（否则点了没反应）
  for (const r of navRoutes) {
    assert.ok(
      lib.ROUTES.includes(r),
      `侧边栏有「${r}」但 ROUTES 里没有 → 点它会静默回退到 ${lib.DEFAULT_ROUTE}（页面像"没反应"）`,
    );
    assert.ok(lib.parseHash(`#/${r}`).route === r, `parseHash('#/${r}') 应解析为 ${r}`);
  }

  // 2) 视图注册的每一项也必须在路由表里（否则同样到不了）
  for (const r of viewRoutes) {
    assert.ok(lib.ROUTES.includes(r), `VIEWS 注册了「${r}」但 ROUTES 里没有，永远渲染不到`);
  }

  // 3) 反向：路由表里的每一项都要有视图（除 login 是登录页跳转），否则点进去是"未知页面"
  for (const r of lib.ROUTES) {
    if (r === 'login') continue;
    assert.ok(viewRoutes.includes(r), `ROUTES 有「${r}」但没有注册视图，进入会出现"未知页面"`);
  }

  // 4) 未知路由仍然按设计回退（不要因为上面几条把回退行为改坏）
  assert.equal(lib.parseHash('#/nope').route, lib.DEFAULT_ROUTE);
  assert.equal(lib.parseHash('#/nope').fallback, true);
});

/**
 * 自动刷新控制器（`createRefreshController`）。
 *
 * 真实踩过的坑：`start()` 内部先调 `stop()` 复用清理逻辑，而 `stop()` 顺手把注册好的
 * 回调一起清空了 —— 于是定时器一直在跑、每轮都因为"没有回调"直接返回，
 * 页面表现成"自动刷新完全不起作用"，不报错、日志也没有任何线索。
 * 所以第一条用例就是它：start() **不得**丢掉已注册的回调。
 */
test('web: 自动刷新控制器 —— start 不能丢掉已注册的回调（真实踩过的坑）', () => {
  // 假定时器：手动推进时间，避免测试等真实秒数
  const makeTimers = () => {
    let seq = 0;
    const pending = new Map();
    return {
      setInterval: (fn: () => void) => {
        seq += 1;
        pending.set(seq, fn);
        return seq;
      },
      clearInterval: (id: number) => {
        pending.delete(id);
      },
      tick: () => {
        for (const fn of [...pending.values()]) fn();
      },
      count: () => pending.size,
    };
  };

  const timers = makeTimers();
  const ctrl = lib.createRefreshController({
    getIntervalMs: () => 5000,
    isActive: () => true,
    timers,
  });

  let ticks = 0;
  ctrl.setHandlers({ onTick: () => { ticks += 1; } });

  // 关键顺序：先注册回调、再启动
  ctrl.setHandlers({ onTick: () => { ticks += 1; } });
  ctrl.start();

  assert.equal(ctrl.isRunning(), true, 'start 之后应在运行');
  assert.equal(timers.count(), 1, '应只注册一个定时器');

  timers.tick();
  assert.equal(ticks, 1, 'start() 之后第一轮就该真的刷新 —— 这里曾经恒为 0');
  timers.tick();
  assert.equal(ticks, 2);

  // 重复 start 不应该叠加定时器（换间隔时也是重启）
  ctrl.start();
  assert.equal(timers.count(), 1, '重复 start 不该留下多个定时器');
  timers.tick();
  assert.equal(ticks, 3);
});

test('web: 自动刷新控制器 —— 停用/后台/间隔为 0 的行为', () => {
  const makeTimers = () => {
    let seq = 0;
    const pending = new Map();
    return {
      setInterval: (fn: () => void) => { seq += 1; pending.set(seq, fn); return seq; },
      clearInterval: (id: number) => { pending.delete(id); },
      tick: () => { for (const fn of [...pending.values()]) fn(); },
      count: () => pending.size,
    };
  };

  // 间隔为 0 = 关闭：不应注册定时器
  {
    const timers = makeTimers();
    const ctrl = lib.createRefreshController({ getIntervalMs: () => 0, isActive: () => true, timers });
    ctrl.setHandlers({ onTick: () => { throw new Error('不该被调用'); } });
    ctrl.start();
    assert.equal(ctrl.isRunning(), false, '间隔为 0 时不应启动');
    assert.equal(timers.count(), 0);
  }

  // 离开页面（isActive=false）：本轮之后自行停止，避免后台空转
  {
    const timers = makeTimers();
    let active = true;
    const ctrl = lib.createRefreshController({ getIntervalMs: () => 1000, isActive: () => active, timers });
    let ticks = 0;
    ctrl.setHandlers({ onTick: () => { ticks += 1; } });
    ctrl.start();
    active = false;
    timers.tick();
    assert.equal(ticks, 0, '已离开页面就不该再刷新');
    assert.equal(ctrl.isRunning(), false, '离开页面后应自动停止');
    assert.equal(timers.count(), 0);
  }

  // 标签页在后台：跳过这一轮，但不停止定时器
  {
    const timers = makeTimers();
    let paused = true;
    const ctrl = lib.createRefreshController({ getIntervalMs: () => 1000, isActive: () => true, isPaused: () => paused, timers });
    let ticks = 0;
    ctrl.setHandlers({ onTick: () => { ticks += 1; } });
    ctrl.start();
    timers.tick();
    assert.equal(ticks, 0, '后台时跳过刷新');
    assert.equal(ctrl.isRunning(), true, '后台只是跳过，不应停止定时器');
    paused = false;
    timers.tick();
    assert.equal(ticks, 1, '回到前台后应恢复刷新');
  }

  // stop() 之后即使定时器被误触发也不该再刷新
  {
    const timers = makeTimers();
    const ctrl = lib.createRefreshController({ getIntervalMs: () => 1000, isActive: () => true, timers });
    let ticks = 0;
    ctrl.setHandlers({ onTick: () => { ticks += 1; } });
    ctrl.start();
    ctrl.stop();
    assert.equal(ctrl.isRunning(), false);
    timers.tick();
    assert.equal(ticks, 0, 'stop 之后不该再有回调');
  }
});

/**
 * app.js 用到 lib.js 的导出时**必须导入**。
 *
 * 真实踩过的坑：在 app.js 里写 `createRefreshController(...)` 却忘了加进 `import {…} from './lib.js'`，
 * ES 模块会在**求值时直接抛 ReferenceError**，整个前端脚本挂掉 —— 页面空白、点什么都没反应，
 * 而此前所有测试（纯函数单测 + 源码字符串断言）全绿，因为它们都不会真正"加载" app.js。
 * 这条用例用静态方式把这类漏导入钉死：凡是 app.js 里出现的 lib 导出名，都必须在导入列表里。
 */
test('web: app.js 不得使用未导入的 lib.js 导出（漏导入会让整个前端挂掉）', () => {
  const src = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');

  // 1) 导出名：直接扫 lib.js 的 export（含 export function / export const / export declare 无关）
  const libSrc = readFileSync(new URL('../web/lib.js', import.meta.url), 'utf8');
  const exported = new Set<string>();
  for (const m of libSrc.matchAll(/^export (?:async )?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    if (m[1]) exported.add(m[1]);
  }
  assert.ok(exported.size >= 20, `lib.js 导出解析异常，只拿到 ${exported.size} 个`);

  // 2) app.js 的导入列表
  const importBlock = /import\s*\{([\s\S]*?)\}\s*from\s*'\.\/lib\.js'/.exec(src);
  assert.ok(importBlock, 'app.js 应有一处从 ./lib.js 的具名导入');
  const imported = new Set(
    (importBlock[1] ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter((x) => x !== ''),
  );

  // 3) 逐个导出名：在 app.js 里被"使用"了就必须被导入
  const missing: string[] = [];
  for (const name of exported) {
    if (imported.has(name)) continue;
    // 出现位置：作为标识符被调用/引用（排除 import 块自身）
    const body = src.replace(importBlock[0], '');
    const used = new RegExp(`(^|[^\\w$.])${name}\\s*[(.,)\\[\\]}]`, 'm').test(body);
    if (used) missing.push(name);
  }
  assert.deepEqual(missing, [], `app.js 使用了未导入的 lib 导出：${missing.join(', ')}（ES 模块会在求值时抛 ReferenceError，整页挂掉）`);

  // 4) 反向：导入但完全没用到（噪音，但能发现改名后的残留）
  const unused = [...imported].filter((name) => {
    const body = src.replace(importBlock[0], '');
    return !new RegExp(`(^|[^\\w$.])${name}\\s*[(.,)\\[\\]}]`, 'm').test(body);
  });
  assert.deepEqual(unused, [], `app.js 导入了但没用到：${unused.join(', ')}`);
});
