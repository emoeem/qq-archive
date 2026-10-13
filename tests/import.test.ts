/**
 * packages/import 导入层回归测试。
 *
 * 数据全部来自 `tests/fixtures/generate.ts` 现场生成的**合成**聊天记录（绝不使用真实聊天数据），
 * 统一写进 `mkdtempSync()` 临时目录，`after()` 里递归清理。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLogger } from '../packages/core/src/index.ts';
import type { ImportBatch, NormalizedMessage } from '../packages/core/src/index.ts';
import type { ImportContext } from '../packages/import/src/index.ts';
import { openDatabase } from '../packages/db/src/index.ts';
import {
  DEFAULT_BATCH_SIZE,
  ImportAbortedError,
  detectFormat,
  detectFormatFromText,
  importFile,
  listImporters,
  runImport,
} from '../packages/import/src/index.ts';
import { generateFixtures, type FixtureResult } from './fixtures/generate.ts';

/* ------------------------------------------------------------ 测试脚手架 */

const tmpDirs: string[] = [];

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

let cachedFixtures: FixtureResult | null = null;

/** 夹具生成较慢（367 条消息 + 6 个媒体文件），整个文件只生成一次。 */
function fixtures(): FixtureResult {
  if (cachedFixtures === null) {
    cachedFixtures = generateFixtures({ outDir: join(tmp('qq-import-fixtures-'), 'fixtures') });
  }
  return cachedFixtures;
}

const logger = createLogger({ console: false, level: 'error' }).child('import-test');

function sha256File(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/** 收集一次导入产出的全部消息（并发/顺序断言用）。 */
async function collect(
  filePath: string,
  extra: Partial<ImportContext> = {},
): Promise<{ messages: NormalizedMessage[]; batches: ImportBatch[]; stats: Awaited<ReturnType<typeof importFile>> }> {
  const messages: NormalizedMessage[] = [];
  const batches: ImportBatch[] = [];
  const stats = await importFile({
    filePath,
    accountUid: 'u_self_test',
    source: 'test',
    logger,
    onBatch: (batch) => {
      batches.push(batch);
      messages.push(...batch.messages);
    },
    ...extra,
  });
  return { messages, batches, stats };
}

after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs.length = 0;
});

/* ------------------------------------------------------------ 注册表 / 探测 */

test('listImporters：注册 5 个导入器，覆盖全部已知格式', () => {
  const list = listImporters();
  assert.equal(list.length, 5);
  const formats = new Set(list.flatMap((item) => item.formats));
  for (const format of ['qce-json', 'qce-jsonl', 'qce-txt', 'generic-jsonl', 'html'] as const) {
    assert.ok(formats.has(format), `缺少 ${format} 导入器`);
  }
  for (const item of list) {
    assert.ok(item.name.length > 0);
    assert.ok(item.formats.length > 0);
  }
});

test('detectFormatFromText：纯文本输入也能判定（无需落盘）', () => {
  assert.equal(detectFormatFromText('{"metadata":{},"chatInfo":{},"messages":[]}'), 'qce-json');
  assert.equal(detectFormatFromText('{"messages":[{"id":"1"}]}'), 'qce-json');
  assert.equal(
    detectFormatFromText('{"chatInfo":{"name":"x"},"message":{"id":"1","timestamp":1}}'),
    'qce-jsonl',
  );
  assert.equal(
    detectFormatFromText('{"msgKey":"m1","ts":1764550800000,"direction":"in","text":"hi"}'),
    'generic-jsonl',
  );
  assert.equal(
    detectFormatFromText('{"id":"1","timestamp":1764550800000,"sender":{"uid":"u1"},"content":{"text":"hi"}}'),
    'qce-jsonl',
  );
  assert.equal(detectFormatFromText('[2025-12-01 09:05:36] 陈静(20004): 今天天气不错\n'), 'qce-txt');
  assert.equal(detectFormatFromText('这不是聊天记录，只是一段普通文本\n'), 'unknown');
  assert.equal(detectFormatFromText(''), 'unknown');
});

test('detectFormat：四个夹具文件 + 垃圾文件 + 不存在的文件', async () => {
  const fx = fixtures();
  assert.equal(await detectFormat(fx.files.groupJson), 'qce-json');
  assert.equal(await detectFormat(fx.files.privateJson), 'qce-json');
  assert.equal(await detectFormat(join(fx.files.chunkedDir, 'chunk-000.jsonl')), 'qce-jsonl');
  assert.equal(await detectFormat(fx.files.txt), 'qce-txt');
  assert.equal(await detectFormat(fx.files.genericJsonl), 'generic-jsonl');

  const junk = join(tmp('qq-import-junk-'), 'junk.dat');
  writeFileSync(junk, 'hello world\nthis is not a chat export\n', 'utf8');
  assert.equal(await detectFormat(junk), 'unknown');

  await assert.rejects(
    () => detectFormat(join(tmp('qq-import-none-'), 'missing.json')),
    (err: unknown) => (err as { code?: string }).code === 'BAD_REQUEST',
    '不存在的文件必须抛 AppError(BAD_REQUEST)',
  );
});

test('detectFormat：pretty 打印的 QCE(JSON) 不能被误判成 JSONL', async () => {
  const file = join(tmp('qq-import-pretty-'), 'pretty.json');
  writeFileSync(
    file,
    JSON.stringify(
      {
        metadata: { generator: 'qq-chat-exporter' },
        chatInfo: { name: '测试', type: 'group', peerUid: '700001' },
        messages: [
          { id: '1', timestamp: 1764550800000, sender: { uid: 'u1', name: 'A' }, content: { text: 'hi' } },
          { id: '2', timestamp: 1764550900000, sender: { uid: 'u2', name: 'B' }, content: { text: 'yo' } },
        ],
      },
      null,
      2,
    ),
    'utf8',
  );
  assert.equal(await detectFormat(file), 'qce-json');
});

test('importFile：未知格式 → UNSUPPORTED_FORMAT；显式 format 非法 → BAD_REQUEST', async () => {
  const junk = join(tmp('qq-import-unknown-'), 'junk.dat');
  writeFileSync(junk, 'nothing here\n', 'utf8');
  await assert.rejects(
    () => importFile({ filePath: junk, accountUid: 'u', onBatch: () => undefined }),
    (err: unknown) => (err as { code?: string }).code === 'UNSUPPORTED_FORMAT',
  );
  await assert.rejects(
    () =>
      importFile({
        filePath: junk,
        accountUid: 'u',
        format: 'no-such-format' as never,
        onBatch: () => undefined,
      }),
    (err: unknown) => (err as { code?: string }).code === 'BAD_REQUEST',
  );
});

/* ------------------------------------------------------------ qce-json */

test('qce-json：流式导入群聊夹具（条数/会话/元素/提及/引用/撤回/系统）', async () => {
  const fx = fixtures();
  const { messages, batches, stats } = await collect(fx.files.groupJson);

  assert.equal(stats.format, 'qce-json');
  assert.equal(stats.totalItems, fx.expected.groupMessages);
  assert.equal(stats.failed, 0, stats.errors.join(' | '));
  assert.equal(stats.batches, 1);
  assert.equal(messages.length, fx.expected.groupMessages);

  const session = batches[0]!.session;
  assert.equal(session.chatType, 'group');
  assert.equal(session.name, '测试技术交流群');
  assert.equal(session.peerUid, '700001');
  assert.equal(session.selfUid, 'u_self_0001');

  // 文本消息
  const first = messages.find((m) => m.msgId === 'grp-000000')!;
  assert.equal(first.msgKey, 'id:grp-000000');
  assert.equal(first.msgType, 'text');
  assert.equal(first.direction, 'in');
  assert.equal(first.senderName, '陈静');
  assert.equal(first.senderUin, '20004');
  assert.ok(first.ts >= fx.expected.firstTs);

  // @ 提及：elements 与 mentions 都要保留
  const at = messages.find((m) => m.text.includes('@李娜'))!;
  assert.ok(at.elements?.some((el) => el.type === 'at'));
  assert.deepEqual(at.mentions?.[0], { uid: 'u_m1', name: '李娜', type: 'user' });

  // 引用回复：必须解析出被引用消息的 id
  const reply = messages.find((m) => m.reply !== undefined)!;
  assert.ok(reply.reply!.msgKey?.startsWith('id:grp-'), `reply.msgKey=${reply.reply!.msgKey}`);
  assert.equal(reply.reply!.msgId, reply.reply!.msgKey!.slice(3));
  assert.ok((reply.reply!.senderName ?? '').length > 0);

  // 表情 / 撤回 / 系统
  const face = messages.find((m) => m.elements?.some((el) => el.type === 'face'))!;
  assert.equal(face.msgType, 'face');
  assert.ok(messages.some((m) => m.recalled === true));
  const system = messages.find((m) => m.system === true)!;
  assert.equal(system.msgType, 'system');

  // 媒体消息：resources 归一化（kind + localPath），且**只有一条** ref（回归：resources+elements 双计）
  const media = messages.find((m) => m.msgId === 'grp-media-000001')!;
  assert.equal(media.resources?.length, 1, `媒体 ref 数=${media.resources?.length}`);
  assert.equal(media.resources![0]!.kind, 'image');
  assert.equal(media.resources![0]!.filename, 'photo-blue.png');
  assert.equal(media.msgType, 'image');

  // 超长消息完整保留
  assert.ok(messages.some((m) => m.text.length === fx.expected.longMessageLength));

  // 来源统计透传（metadata + statistics）
  assert.ok(batches[0]!.sourceStats !== undefined);
});

test('qce-json：limit / from-to / batchSize 都生效', async () => {
  const fx = fixtures();

  const limited = await collect(fx.files.groupJson, { limit: 10 });
  assert.equal(limited.stats.totalItems, 10);
  assert.equal(limited.messages.length, 10);

  const batched = await collect(fx.files.groupJson, { batchSize: 100 });
  assert.equal(batched.stats.totalItems, fx.expected.groupMessages);
  assert.equal(batched.stats.batches, Math.ceil(fx.expected.groupMessages / 100));
  assert.ok(batched.batches.every((b) => b.messages.length <= 100));
  assert.ok(batched.batches.every((b) => b.session.peerUid === '700001'));

  const from = fx.expected.firstTs + 3_600_000;
  const to = fx.expected.firstTs + 7_200_000;
  const windowed = await collect(fx.files.groupJson, { from, to });
  assert.ok(windowed.messages.length > 0);
  assert.ok(windowed.messages.every((m) => m.ts >= from && m.ts <= to));

  assert.ok(DEFAULT_BATCH_SIZE >= 100);
});

test('qce-json：signal 中止 → ImportAbortedError 且带已完成统计', async () => {
  const fx = fixtures();
  const controller = new AbortController();
  const err = await importFile({
    filePath: fx.files.groupJson,
    accountUid: 'u_self_test',
    source: 'test',
    logger,
    batchSize: 100,
    signal: controller.signal,
    onBatch: () => {
      controller.abort();
    },
  }).then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof ImportAbortedError, `期望 ImportAbortedError，实际 ${String(err)}`);
  assert.ok((err as ImportAbortedError).stats.totalItems > 0);
});

/* ------------------------------------------------------------ qce-jsonl */

test('qce-jsonl：分块目录逐行导入（chatInfo 包装行 + manifest 兜底）', async () => {
  const fx = fixtures();
  const chunk0 = join(fx.files.chunkedDir, 'chunk-000.jsonl');
  const { messages, batches, stats } = await collect(chunk0);
  assert.equal(stats.format, 'qce-jsonl');
  assert.equal(stats.failed, 0, stats.errors.join(' | '));
  assert.ok(messages.length > 0);
  assert.equal(messages.length, stats.totalItems);
  assert.equal(batches[0]!.session.name, '测试技术交流群');

  // manifest.json 兜底：单独喂一个只有消息行的 chunk 目录
  const dir = tmp('qq-import-manifest-');
  const bare = join(dir, 'chunk-000.jsonl');
  const lines = messages
    .slice(0, 5)
    .map((m) => JSON.stringify({ id: m.msgId, timestamp: m.ts, sender: { uid: m.senderUid }, content: { text: m.text } }))
    .join('\n');
  writeFileSync(bare, `${lines}\n`, 'utf8');
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({ chatInfo: { name: 'manifest 群', type: 'group', peerUid: '888888' } }),
    'utf8',
  );
  const bareRun = await collect(bare);
  assert.equal(bareRun.stats.totalItems, 5);
  assert.equal(bareRun.messages.length, 5);
  assert.equal(bareRun.messages[0]!.msgKey, `id:${messages[0]!.msgId}`);
});

/* ------------------------------------------------------------ qce-txt */

test('qce-txt：单行式消息导入 + 无法解析的行进 errors 且保留原文', async () => {
  const fx = fixtures();
  const { messages, stats } = await collect(fx.files.txt);
  assert.equal(stats.format, 'qce-txt');
  assert.equal(stats.totalItems, 40, '夹具里 40 条消息行必须全部导入');
  assert.equal(messages.length, 40);
  assert.ok(stats.failed >= 1, '无法解析的行必须计入 failed');
  assert.ok(
    stats.errors.some((e) => e.includes('无法识别的垃圾内容')),
    `errors 必须保留原始文本：${stats.errors.join(' | ')}`,
  );
  assert.ok(messages.every((m) => m.ts > 0));
  const first = messages[0]!;
  assert.equal(first.senderName, '陈静');
  assert.equal(first.senderUin, '20004');
  assert.ok(first.text.startsWith('今天天气不错'));
  // 无 chatInfo 时用 sessionHint 补会话
  const hinted = await collect(fx.files.txt, {
    sessionHint: { name: '提示群', chatType: 'group', peerUid: '123456' },
  });
  assert.ok(hinted.messages.length === 40);
});

/* ------------------------------------------------------------ generic-jsonl */

test('generic-jsonl：逐行归一化消息 + 行内会话线索', async () => {
  const fx = fixtures();
  const { messages, batches, stats } = await collect(fx.files.genericJsonl);
  assert.equal(stats.format, 'generic-jsonl');
  assert.equal(stats.totalItems, 30);
  assert.equal(stats.failed, 0, stats.errors.join(' | '));
  assert.equal(messages.length, 30);
  const session = batches[0]!.session;
  assert.equal(session.chatType, 'private');
  assert.equal(session.peerUid, 'u_friend_0002');
  assert.equal(session.name, '小王');
  assert.equal(messages[0]!.msgKey, 'pvt-000000');
  assert.equal(messages[0]!.msgType, 'text');
  assert.equal(messages[0]!.direction, 'out');
  assert.ok(messages.some((m) => m.direction === 'in'));

  // 坏行必须计入 failed 而不是静默丢弃
  const bad = join(tmp('qq-import-badjsonl-'), 'bad.jsonl');
  writeFileSync(
    bad,
    `${JSON.stringify({ msgKey: 'ok-1', ts: 1764550800000, text: '好行', direction: 'in', type: 'text' })}\n{ this is not json\n`,
    'utf8',
  );
  const badRun = await collect(bad);
  assert.equal(badRun.messages.length, 1);
  assert.equal(badRun.stats.failed, 1);
  assert.ok(badRun.stats.errors[0]!.includes('this is not json'));
});

/* ------------------------------------------------------------ 幂等 / 媒体 */

test('重复导入幂等：第二次 inserted=0、消息行数不变', async () => {
  const fx = fixtures();
  const db = openDatabase({ path: ':memory:' });
  try {
    const first = await runImport({ filePath: fx.files.groupJson, db, accountUid: 'u_self_test', logger });
    assert.equal(first.inserted, fx.expected.groupMessages - fx.expected.duplicateInFile);
    assert.equal(first.duplicate, fx.expected.duplicateInFile);
    assert.equal(first.failed, 0);
    const afterFirst = db.stats().messages;
    assert.equal(afterFirst, first.inserted);

    const second = await runImport({ filePath: fx.files.groupJson, db, accountUid: 'u_self_test', logger });
    assert.equal(second.inserted, 0, '重复导入不得再插入');
    assert.equal(second.duplicate, fx.expected.groupMessages, '第二次导入每一条都会被判为重复');
    assert.equal(db.stats().messages, afterFirst, '消息行数必须保持不变');
  } finally {
    db.close();
  }
});

test('媒体归档：mediaMissing 精确为 1、present 文件真在盘上、缺文件绝不落占位', async () => {
  const fx = fixtures();
  const mediaDir = tmp('qq-import-media-');
  const db = openDatabase({ path: ':memory:' });
  try {
    const stats = await runImport({
      filePath: fx.files.groupJson,
      db,
      accountUid: 'u_self_test',
      logger,
      mediaDir,
      source: 'test',
    });

    // ① mediaMissing 必须精确等于夹具声明的缺失数（回归：resources+elements 双计曾导致虚高 4 倍）
    assert.equal(stats.mediaMissing, fx.expected.mediaMissingDeclared);
    const ms = db.mediaStats();
    assert.equal(ms.missing, fx.expected.mediaMissingDeclared);
    assert.equal(ms.present, 5, '6 个媒体文件里两份内容相同 → 去重后 5 行 present');
    assert.equal(ms.total, 6);

    interface MediaCheckRow {
      status: string;
      rel_path: string;
      fail_reason: string | null;
      ref_count: number;
    }
    const rows = db.raw
      .prepare('SELECT status, rel_path, fail_reason, ref_count FROM media')
      .all() as unknown as MediaCheckRow[];

    // ② present 的必须在磁盘上；③ missing 的必须不存在（不得生成占位文件）
    for (const row of rows) {
      const abs = join(mediaDir, row.rel_path);
      if (row.status === 'present') {
        assert.ok(existsSync(abs), `present 媒体必须真实落盘：${row.rel_path}`);
      } else {
        assert.equal(existsSync(abs), false, `missing 媒体不得有占位文件：${row.rel_path}`);
        assert.ok((row.fail_reason ?? '').length > 0, 'missing 必须带 fail_reason');
      }
    }
    assert.deepEqual(
      rows.filter((r) => r.status === 'missing' && (r.fail_reason ?? '').includes('无可用来源')),
      [],
      '不得为同一文件额外产出「无可用来源」的假缺失记录',
    );

    // 内容寻址：路径 = <kind>/<yyyy>/<mm>/<sha 前 2 位>/<sha>.<ext>，且与源文件字节一致
    const shaRed = sha256File(join(fx.files.mediaDir, 'photo-red.png'));
    const media = db.getMediaBySha(shaRed);
    assert.ok(media, 'photo-red.png 必须已入库');
    assert.match(media.relPath, /^image\/\d{4}\/\d{2}\/[0-9a-f]{2}\/[0-9a-f]{64}\.png$/);
    assert.equal(media.relPath.split('/')[3]!.slice(0, 2), shaRed.slice(0, 2));
    assert.deepEqual(
      readFileSync(join(mediaDir, media.relPath)),
      readFileSync(join(fx.files.mediaDir, 'photo-red.png')),
    );
    // 同内容不同文件名 → 同一行（内容寻址去重），并且被多条消息引用
    assert.equal(sha256File(join(fx.files.mediaDir, 'photo-red-copy.png')), shaRed);
    assert.ok(media.refCount >= 2, `同内容媒体应被引用多次（ref_count=${media.refCount}）`);

    // 每条媒体消息只产出 1 个媒体关联
    const links = db.raw
      .prepare(
        'SELECT mm.media_id AS id FROM message_media mm JOIN messages m ON m.id = mm.message_id WHERE m.msg_key = ?',
      )
      .all('id:grp-media-000001') as unknown as Array<{ id: number }>;
    assert.equal(links.length, 1, `grp-media-000001 应只关联 1 个媒体，实际 ${links.length}`);

    // 中转目录不残留 .part
    const incoming = join(mediaDir, '.incoming');
    if (existsSync(incoming)) {
      assert.deepEqual(readdirSync(incoming), [], '不得残留 .part 中转文件');
    }
  } finally {
    db.close();
  }
});

test('媒体归档：离线模式（不传 mediaDir）仍能导入消息，且不产生 media 行', async () => {
  const fx = fixtures();
  const db = openDatabase({ path: ':memory:' });
  try {
    const stats = await runImport({
      filePath: fx.files.privateJson,
      db,
      accountUid: 'u_self_test',
      logger,
      skipMedia: true,
    });
    assert.equal(stats.totalItems, fx.expected.privateMessages);
    assert.equal(stats.inserted, fx.expected.privateMessages);
    assert.equal(db.mediaStats().total, 0);
  } finally {
    db.close();
  }
});
