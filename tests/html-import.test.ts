/**
 * HTML 聊天记录导入回归测试。
 *
 * 夹具全部是**合成内容**（`tests/fixtures/html/`），不含任何真实聊天数据。
 * 覆盖：QCE viewer 内嵌 JSON、QCE viewer DOM、通用聊天 HTML、媒体引用、
 * 保守探测（非聊天 HTML 被拒绝）、缺时间戳会计入 failed、JSON 与 DOM 双份来源不重复导入。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ImportBatch, NormalizedMessage } from '../packages/core/src/index.ts';
import { createLogger } from '../packages/core/src/index.ts';
import type { ImportContext } from '../packages/import/src/index.ts';
import { detectFormat, detectFormatFromText, importFile } from '../packages/import/src/index.ts';
import {
  HTML_FORMAT,
  HtmlImporter,
  importerForFormat,
  listImporters,
} from '../packages/import/src/importers/index.ts';
import { looksLikeChatHtml } from '../packages/import/src/importers/html.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'html');
const logger = createLogger({ console: false, level: 'error' }).child('html-import-test');

function fixturePath(name: string): string {
  return join(FIXTURES, name);
}

function readFixture(name: string): string {
  return readFileSync(fixturePath(name), 'utf8');
}

interface Collected {
  messages: NormalizedMessage[];
  batches: ImportBatch[];
  stats: Awaited<ReturnType<typeof importFile>>;
}

async function collect(filePath: string, extra: Partial<ImportContext> = {}): Promise<Collected> {
  const messages: NormalizedMessage[] = [];
  const batches: ImportBatch[] = [];
  const stats = await importFile({
    filePath,
    accountUid: 'u_test_self',
    source: 'html',
    logger,
    onBatch: (batch) => {
      batches.push(batch);
      messages.push(...batch.messages);
    },
    ...extra,
  });
  return { messages, batches, stats };
}

// ---------------------------------------------------------------------------
// (c) 探测
// ---------------------------------------------------------------------------

test('探测：QCE 内嵌 JSON、QCE DOM、通用聊天页都判为 html', async () => {
  for (const name of ['qce-viewer.html', 'qce-dom.html', 'generic-chat.html', 'qce-both.html']) {
    assert.equal(detectFormatFromText(readFixture(name)), HTML_FORMAT, `${name} 应判为 html`);
    assert.equal(await detectFormat(fixturePath(name)), HTML_FORMAT, `${name} 应判为 html（走文件 IO）`);
  }

  // 线索词与容器判断按预期工作
  assert.equal(looksLikeChatHtml(readFixture('generic-chat.html')), true);
  assert.equal(looksLikeChatHtml(readFixture('not-chat.html')), false);

  // 导入器已注册，且能按格式取回
  assert.ok(
    listImporters().some((importer) => importer.name === 'html' && importer.formats.includes(HTML_FORMAT)),
    '注册表里应有 html 导入器',
  );
  assert.ok(importerForFormat(HTML_FORMAT) instanceof HtmlImporter);
});

// ---------------------------------------------------------------------------
// (d) 非聊天 HTML 被拒绝
// ---------------------------------------------------------------------------

test('探测：普通网页不被判为 html，导入时明确拒绝', async () => {
  const html = readFixture('not-chat.html');
  assert.equal(detectFormatFromText(html), 'unknown');
  assert.equal(await detectFormat(fixturePath('not-chat.html')), 'unknown');
  assert.equal(looksLikeChatHtml(html), false);

  await assert.rejects(
    () => collect(fixturePath('not-chat.html')),
    (err: unknown) => {
      assert.equal((err as { code?: string }).code, 'UNSUPPORTED_FORMAT');
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// (a) QCE 风格 HTML
// ---------------------------------------------------------------------------

test('QCE viewer HTML：内嵌 JSON 载荷端到端导入', async () => {
  const { messages, batches, stats } = await collect(fixturePath('qce-viewer.html'));

  assert.equal(stats.totalItems, 2);
  assert.equal(stats.failed, 0);
  assert.deepEqual(stats.errors, []);

  assert.equal(messages.length, 2);
  const [first, second] = messages;
  assert.ok(first && second);

  assert.equal(first.msgKey, 'id:1001');
  assert.equal(first.ts, 1700000000000);
  assert.equal(first.senderName, '张三');
  assert.equal(first.senderUin, '11111');
  assert.equal(first.text, '第一条消息');
  assert.equal(first.direction, 'in');

  assert.equal(second.msgKey, 'id:1002');
  assert.equal(second.ts, 1700000060000);
  assert.equal(second.senderName, '李四');
  assert.equal(second.senderUin, '22222');
  assert.equal(second.text, '你好，世界');
  assert.equal(second.msgType, 'image');
  assert.deepEqual(second.resources, [{ kind: 'image', url: 'resources/pic.jpg', filename: 'pic.jpg' }]);

  // 会话信息来自内嵌 chatInfo
  const session = batches[0]?.session;
  assert.ok(session);
  assert.equal(session.name, '测试群');
  assert.equal(session.chatType, 'group');
  assert.equal(session.peerUin, '123456');
  assert.equal(session.memberCount, 42);
});

test('QCE viewer HTML：data-* 属性（DOM）端到端导入', async () => {
  const { messages, batches, stats } = await collect(fixturePath('qce-dom.html'));

  assert.equal(stats.totalItems, 3);
  assert.equal(stats.failed, 0);
  assert.equal(messages.length, 3);

  const [incoming, outgoing, system] = messages;
  assert.ok(incoming && outgoing && system);

  assert.equal(incoming.msgKey, 'id:2001');
  assert.equal(incoming.ts, 1700000000000);
  assert.equal(incoming.senderName, '张三');
  assert.equal(incoming.senderUin, '11111');
  assert.equal(incoming.direction, 'in');
  assert.equal(incoming.text, '晚上好');
  assert.equal(incoming.msgType, 'text');

  assert.equal(outgoing.msgKey, 'id:2002');
  assert.equal(outgoing.direction, 'out'); // class 里的 `self` 线索
  assert.equal(outgoing.text, '晚上好\n今晚一起吃饭吗？'); // <br> → 换行，元信息元素不混进正文

  assert.equal(system.direction, 'system');
  assert.equal(system.system, true);
  assert.equal(system.msgType, 'system');
  assert.equal(system.text, '张三撤回了一条消息');

  const session = batches[0]?.session;
  assert.ok(session);
  assert.equal(session.name, '测试群');
  assert.equal(session.chatType, 'group');
  assert.equal(session.peerUin, '123456');
  assert.equal(session.memberCount, 42);
});

test('内嵌 JSON 与 DOM 同时存在时，只按 JSON 导入一次（不重复）', async () => {
  const { messages, stats } = await collect(fixturePath('qce-both.html'));
  assert.equal(stats.totalItems, 2);
  assert.equal(messages.length, 2);
  assert.deepEqual(
    messages.map((m) => m.text),
    ['JSON 里的第一条', 'JSON 里的第二条'],
  );
});

// ---------------------------------------------------------------------------
// (b) 通用聊天 HTML
// ---------------------------------------------------------------------------

test('通用聊天 HTML：发送者 / 时间 / 正文 / 方向 / 换行', async () => {
  const { messages, batches, stats } = await collect(fixturePath('generic-chat.html'));

  assert.equal(stats.totalItems, 2);
  assert.equal(stats.failed, 0);
  assert.equal(messages.length, 2);

  const [first, second] = messages;
  assert.ok(first && second);

  assert.equal(first.senderName, '小明');
  assert.equal(first.senderUin, '10001'); // 从 `小明(10001)` 里拆出来
  assert.equal(first.ts, new Date(2024, 0, 2, 3, 4, 5).getTime());
  assert.equal(first.direction, 'in');
  assert.equal(first.text, '大家好啊\n好久不见');
  assert.equal(first.msgType, 'image');

  assert.equal(second.senderName, '我');
  assert.equal(second.senderUin, '10002');
  assert.equal(second.ts, new Date(2024, 0, 2, 3, 5, 0).getTime());
  assert.equal(second.direction, 'out'); // class 里的 `right own` 线索
  assert.equal(second.text, '我发个语音\ndoc.pdf');

  const session = batches[0]?.session;
  assert.ok(session);
  assert.equal(session.name, '老同学群');
  assert.equal(session.chatType, 'group');
});

// ---------------------------------------------------------------------------
// (e) 媒体引用
// ---------------------------------------------------------------------------

test('媒体引用：img→image、audio/video→audio/video、a[href]→file', async () => {
  const { messages } = await collect(fixturePath('generic-chat.html'));
  const [first, second] = messages;
  assert.ok(first && second);

  assert.deepEqual(first.resources, [{ kind: 'image', url: 'resources/hello.jpg', filename: 'hello.jpg' }]);

  const resources = second.resources ?? [];
  assert.deepEqual(
    resources.map((r) => r.kind).sort(),
    ['audio', 'file', 'video'],
  );
  assert.deepEqual(
    resources.map((r) => r.url).sort(),
    ['resources/clip.mp4', 'resources/doc.pdf', 'resources/voice.amr'],
  );
  assert.deepEqual(
    resources.map((r) => r.filename).sort(),
    ['clip.mp4', 'doc.pdf', 'voice.amr'],
  );
});

// ---------------------------------------------------------------------------
// 缺时间戳：绝不伪造
// ---------------------------------------------------------------------------

test('缺少时间戳的消息计入 failed，不伪造时间戳', async () => {
  const { messages, stats } = await collect(fixturePath('missing-time.html'));

  assert.equal(stats.totalItems, 1);
  assert.equal(stats.failed, 1);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.senderName, '甲');
  assert.ok(stats.errors.some((line) => line.includes('缺少可解析的时间戳')), stats.errors.join(' | '));
});

// ---------------------------------------------------------------------------
// 自定义会话提示（sessionHint）与 limit 的接线
// ---------------------------------------------------------------------------

test('sessionHint 与 limit 生效', async () => {
  const { messages, batches, stats } = await collect(fixturePath('generic-chat.html'), {
    limit: 1,
    sessionHint: { name: '提示里的群名', selfUin: '10002' },
  });

  assert.equal(messages.length, 1);
  assert.equal(stats.totalItems, 1);

  // 与 qce-txt / generic-jsonl 一致的优先级：文件里探测到的信息压过 ctx.sessionHint，
  // hint 只用来补齐文件里没有的字段。
  const session = batches[0]?.session;
  assert.ok(session);
  assert.equal(session.name, '老同学群');
  assert.equal(session.selfUin, '10002');
});
