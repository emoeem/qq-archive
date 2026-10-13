/**
 * packages/server 的 HTTP 契约测试。
 *
 * 覆盖：认证（401/登录/会话）、health、读接口（sessions/messages/search/stats/export）、
 * 媒体（Range、404、路径穿越）、静态托管（SPA 回退 + 不泄露仓库文件）、
 * 请求体上限、405/404，以及**真实的备份 → 恢复演练**（临时目录）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { AppConfig, NormalizedMessage, NormalizedSession } from '../packages/core/src/index.ts';
import { createLogger, messageKeyOf, sessionKeyOf, sha256Hex } from '../packages/core/src/index.ts';
import { openDatabase } from '../packages/db/src/index.ts';
import { createServer } from '../packages/server/src/index.ts';

const TOKEN = 'test-token-0123456789abcdef';
const SECRET_IN_REPO = 'REPO_SECRET_SHOULD_NOT_LEAK';
const SECRET_OUTSIDE_MEDIA = 'TRAVERSAL_SECRET_MUST_NOT_LEAK';
const INDEX_MARKER = 'QQARCHIVE_TEST_INDEX';

const SESSION: NormalizedSession = {
  accountUid: 'u_self',
  chatType: 'group',
  peerUid: '999001',
  name: '测试群',
};

function makeConfig(root: string): AppConfig {
  const dataDir = join(root, 'data');
  return {
    server: {
      host: '127.0.0.1',
      port: 0,
      token: TOKEN,
      sessionTtlSec: 3600,
      allowDownload: true,
      exportMaxMessages: 1000,
      trustProxy: false,
    },
    storage: {
      dataDir,
      dbPath: join(dataDir, 'archive.db'),
      mediaDir: join(dataDir, 'media'),
      backupDir: join(dataDir, 'backups'),
      logDir: join(dataDir, 'logs'),
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
    },
    stt: {
      enabled: true,
      engine: 'whisper-cli',
      binary: 'whisper-cli',
      ffmpeg: 'ffmpeg',
      model: join(dataDir, 'ggml-test-model.bin'),
      language: 'zh',
      vadModel: '',
      threads: 2,
      timeoutMs: 30_000,
      maxDurationSec: 600,
    },
  };
}

function normalizeMessages(session: NormalizedSession, texts: string[]): NormalizedMessage[] {
  const base = 1_700_000_000_000;
  return texts.map((text, i) => ({
    msgKey: messageKeyOf({ msgId: `m${i}`, ts: base + i * 60_000, text }),
    msgId: `m${i}`,
    ts: base + i * 60_000,
    direction: 'in' as const,
    msgType: 'text' as const,
    senderUid: i % 2 === 0 ? 'u_alice' : 'u_self',
    senderName: i % 2 === 0 ? 'Alice' : '我',
    isSelf: i % 2 !== 0,
    text,
  }));
}

interface ApiResult {
  status: number;
  headers: Headers;
  body: any;
  text: string;
}

test('server: HTTP 契约', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'qqarchive-server-'));
  const config = makeConfig(root);
  const repoRoot = join(root, 'repo');
  const webRoot = join(repoRoot, 'web');
  mkdirSync(webRoot, { recursive: true });
  mkdirSync(config.storage.mediaDir, { recursive: true });
  mkdirSync(config.storage.backupDir, { recursive: true });
  writeFileSync(join(webRoot, 'index.html'), `<!doctype html><title>${INDEX_MARKER}</title><script src="./app.js"></script>`);
  writeFileSync(join(webRoot, 'app.js'), 'window.__QQARCHIVE_TEST__ = 1;');
  writeFileSync(join(repoRoot, 'package.json'), `{"name":"secret","secret":"${SECRET_IN_REPO}"}`);

  const db = openDatabase({ path: config.storage.dbPath });
  const session = db.ensureSession(SESSION);
  const key = sessionKeyOf(SESSION.chatType, SESSION.peerUid);
  db.insertMessages(session.id, SESSION.accountUid, key, normalizeMessages(SESSION, ['你好世界', '第二条消息', '搜索目标：你好']), {
    source: 'test',
  });
  const seededIds = db.listMessages({ sessionId: session.id, limit: 100 }).items.map((m) => m.id);
  const firstMessageId = seededIds[0]!;

  // 真实媒体文件 + 缩略图
  const picBytes = Buffer.from('PNG-FAKE-DATA-0123456789');
  writeFileSync(join(config.storage.mediaDir, 'pic.png'), picBytes);
  writeFileSync(join(config.storage.mediaDir, 'thumb-pic.jpg'), 'THUMB-BYTES');
  const picMedia = db.upsertMedia({
    sha256: sha256Hex(picBytes),
    kind: 'image',
    size: picBytes.length,
    relPath: 'pic.png',
    mime: 'image/png',
    status: 'present',
  });
  db.setMediaThumb(picMedia.id, 'thumb-pic.jpg');
  db.linkMessageMedia(firstMessageId, picMedia.id, 0, 'pic.png', picBytes.length);

  // 越界 rel_path —— **真实存在**的文件，位于 mediaDir 之外（data/ 下）：
  // 这是决定性的穿越用例（若指向不存在的文件，404 会让测试变得没有意义）
  const outsideBytes = Buffer.from(SECRET_OUTSIDE_MEDIA);
  writeFileSync(join(config.storage.dataDir, 'secret-outside-media.txt'), outsideBytes);
  const escaped = db.upsertMedia({
    sha256: sha256Hex(outsideBytes),
    kind: 'file',
    size: outsideBytes.length,
    relPath: '../secret-outside-media.txt',
    mime: 'text/plain',
    status: 'present',
  });
  db.linkMessageMedia(firstMessageId, escaped.id, 1, 'secret-outside-media.txt');

  // 另一条指向绝对路径外（/etc/passwd）
  const escapedAbs = db.upsertMedia({
    sha256: 'f'.repeat(64),
    kind: 'file',
    size: 32,
    relPath: '../../../etc/passwd',
    status: 'present',
  });
  db.linkMessageMedia(firstMessageId, escapedAbs.id, 2, 'passwd');

  // 状态为 missing 的媒体
  const missing = db.upsertMedia({
    sha256: 'a'.repeat(64),
    kind: 'video',
    size: 1024,
    relPath: 'gone.mp4',
    status: 'missing',
    failReason: '文件不存在',
  });

  // 语音媒体（STT）：模型文件真实存在（probe 只查存在性），音频文件真实落盘。
  writeFileSync(join(config.storage.dataDir, 'ggml-test-model.bin'), 'FAKE-GGML-MODEL');
  const audioABytes = Buffer.from('AUDIO-A-BYTES');
  writeFileSync(join(config.storage.mediaDir, 'voice-a.amr'), audioABytes);
  const audioA = db.upsertMedia({
    sha256: sha256Hex(audioABytes),
    kind: 'audio',
    size: audioABytes.length,
    relPath: 'voice-a.amr',
    mime: 'audio/amr',
    status: 'present',
    duration: 3,
  });
  db.linkMessageMedia(firstMessageId, audioA.id, 3, 'voice-a.amr');
  const audioBBytes = Buffer.from('AUDIO-B-BYTES');
  writeFileSync(join(config.storage.mediaDir, 'voice-b.amr'), audioBBytes);
  const audioB = db.upsertMedia({
    sha256: sha256Hex(audioBBytes),
    kind: 'audio',
    size: audioBBytes.length,
    relPath: 'voice-b.amr',
    mime: 'audio/amr',
    status: 'present',
    duration: 4,
  });
  db.linkMessageMedia(firstMessageId, audioB.id, 4, 'voice-b.amr');

  // 假 exec：绝不真的 spawn whisper/ffmpeg。probe 用 `--help`，转写调用返回固定文本。
  const sttCalls: Array<{ cmd: string; args: string[] }> = [];
  const fakeSttExec = async (cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
    sttCalls.push({ cmd, args });
    if (cmd === 'whisper-cli' && !args.includes('--help')) return { code: 0, stdout: '服务器端转写文本\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };

  const logger = createLogger({ console: false });
  const colLogs: number[] = [];
  const created = createServer({
    config,
    db,
    logger: logger.child('test'),
    collect: {
      async runOnce() {
        colLogs.push(1);
        return { inserted: 1, processed: 1 };
      },
    },
    repoRoot,
    version: '0.1.0-test',
    startedAt: Date.now() - 5000,
    stt: { exec: fakeSttExec },
  });
  await new Promise<void>((done) => created.server.listen(0, '127.0.0.1', () => done()));
  const port = (created.server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  let token = '';

  async function api(method: string, path: string, opts: { auth?: boolean; body?: unknown; headers?: Record<string, string> } = {}): Promise<ApiResult> {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.auth !== false) headers.Authorization = `Bearer ${token}`;
    let payload: string | undefined;
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(opts.body);
    }
    const res = await fetch(`${base}${path}`, { method, headers, ...(payload === undefined ? {} : { body: payload }) });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return { status: res.status, headers: res.headers, body, text };
  }

  t.after(async () => {
    await created.close();
    await logger.close();
    try {
      db.close();
    } catch {
      /* 恢复演练会关掉旧句柄 */
    }
    rmSync(root, { recursive: true, force: true });
  });

  /* ---------------------------- 认证 ---------------------------- */

  await t.test('未认证访问 /api/sessions 返回 401，且响应体不含会话数据', async () => {
    const r = await api('GET', '/api/sessions', { auth: false });
    assert.equal(r.status, 401);
    assert.equal(r.body.code, 'UNAUTHORIZED');
    assert.ok(!r.text.includes(SESSION.name), '401 响应体不得泄露会话名');
    assert.ok(!r.text.includes('你好世界'), '401 响应体不得泄露消息内容');
  });

  await t.test('伪造 Bearer 令牌同样 401', async () => {
    const r = await api('GET', '/api/stats', { headers: { Authorization: 'Bearer not-a-real-token' } });
    assert.equal(r.status, 401);
  });

  await t.test('错误 token 登录 401；正确 token 拿到 accessToken', async () => {
    const bad = await api('POST', '/api/auth/login', { auth: false, body: { token: 'wrong-token-0123456789' } });
    assert.equal(bad.status, 401);
    const good = await api('POST', '/api/auth/login', { auth: false, body: { token: TOKEN } });
    assert.equal(good.status, 200);
    assert.equal(typeof good.body.data.accessToken, 'string');
    assert.ok(good.body.data.accessToken.split('.').length === 2, 'accessToken 应为 payload.sig');
    assert.ok(typeof good.body.data.expiresAt === 'string');
    token = good.body.data.accessToken;
    const me = await api('GET', '/api/auth/session');
    assert.equal(me.status, 200);
    assert.equal(me.body.data.sub, 'admin');
  });

  await t.test('无认证的 /api/health 返回完整报告', async () => {
    const r = await api('GET', '/api/health', { auth: false });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.ok, true);
    assert.equal(r.body.data.version, '0.1.0-test');
    assert.equal(r.body.data.db.ok, true);
    assert.ok(r.body.data.media.root.endsWith('media'));
    assert.equal(r.body.data.media.writable, true);
    assert.ok(Array.isArray(r.body.data.collectors));
    assert.ok(r.body.data.uptimeSec >= 4);
  });

  await t.test('安全响应头齐全', async () => {
    const r = await api('GET', '/api/health', { auth: false });
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
    assert.match(r.headers.get('content-security-policy') ?? '', /default-src 'self'/);
  });

  /* ---------------------------- 路由 ---------------------------- */

  await t.test('未知 API 路径 404；方法不匹配 405 + Allow', async () => {
    const nf = await api('GET', '/api/definitely-not-here');
    assert.equal(nf.status, 404);
    assert.equal(nf.body.code, 'NOT_FOUND');
    const wrong = await api('POST', '/api/health', { auth: false });
    assert.equal(wrong.status, 405);
    assert.match(wrong.headers.get('allow') ?? '', /GET/);
  });

  await t.test('非法 JSON 400；请求体超限 413', async () => {
    const badJson = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"token": ',
    });
    assert.equal(badJson.status, 400);
    const big = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: TOKEN, pad: 'x'.repeat(1_200_000) }),
    });
    assert.equal(big.status, 413);
    assert.equal(((await big.json()) as { code?: string }).code, 'PAYLOAD_TOO_LARGE');
  });

  /* ---------------------------- 读接口 ---------------------------- */

  await t.test('认证后 sessions / 会话详情 / messages / search / stats 正常', async () => {
    const list = await api('GET', '/api/sessions');
    assert.equal(list.status, 200);
    assert.equal(list.body.data.total, 1);
    assert.equal(list.body.data.items[0].name, SESSION.name);
    assert.equal(typeof list.body.data.items[0].lastMessageText, 'string');

    const detail = await api('GET', `/api/sessions/${session.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.data.messageCount, 3);
    assert.equal(detail.body.data.mediaCount, 5);

    const msgs = await api('GET', `/api/sessions/${session.id}/messages?limit=2`);
    assert.equal(msgs.status, 200);
    assert.equal(msgs.body.data.items.length, 2);
    assert.equal(msgs.body.data.hasMore, true);
    // 媒体挂在最早那条消息上；窗口内按 id 找回来验证 url/thumbUrl 拼装
    const wide = await api('GET', `/api/sessions/${session.id}/messages?limit=3`);
    const withMedia = wide.body.data.items.find((m: { id: number }) => m.id === firstMessageId);
    assert.ok(withMedia, '返回的窗口内应含带媒体的消息');
    assert.ok(Array.isArray(withMedia.media));
    assert.equal(withMedia.media[0].url, `/api/media/${picMedia.id}/raw`);
    assert.equal(withMedia.media[0].thumbUrl, `/api/media/${picMedia.id}/thumb`);
    assert.equal(withMedia.media[0].mediaId, picMedia.id);
    const asc = await api('GET', `/api/sessions/${session.id}/messages?limit=2&order=asc`);
    assert.equal(asc.body.data.items[0].id, firstMessageId, 'order=asc 应从最早开始');
    assert.equal(asc.body.data.items[0].media[0].url, `/api/media/${picMedia.id}/raw`);

    const one = await api('GET', `/api/messages/${firstMessageId}`);
    assert.equal(one.status, 200);
    assert.equal(one.body.data.text, '你好世界');

    const search = await api('GET', '/api/search?q=' + encodeURIComponent('你好'));
    assert.equal(search.status, 200);
    assert.ok(search.body.data.total >= 2, `搜索命中数应 >= 2，实际 ${search.body.data.total}`);
    const noQuery = await api('GET', '/api/search');
    assert.equal(noQuery.status, 400);

    const stats = await api('GET', '/api/stats');
    assert.equal(stats.status, 200);
    assert.equal(stats.body.data.messages, 3);
    assert.equal(stats.body.data.sessions, 1);
    assert.equal(stats.body.data.groups, 1);

    const logs = await api('GET', '/api/logs?pageSize=5');
    assert.equal(logs.status, 200);
    assert.ok(Array.isArray(logs.body.data.items));
  });

  await t.test('export 支持 query 令牌 + jsonl 流式', async () => {
    const r = await fetch(`${base}/api/export/session/${session.id}?format=jsonl&access=${encodeURIComponent(token)}`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') ?? '', /jsonl|x-ndjson|json/);
    assert.match(r.headers.get('content-disposition') ?? '', /attachment/);
    const lines = (await r.text()).trim().split('\n');
    assert.equal(lines.length, 3);
    for (const line of lines) assert.equal(JSON.parse(line).sessionId, session.id);

    const json = await api('GET', `/api/export/session/${session.id}?format=json`);
    assert.equal(json.status, 200);
    assert.equal(json.body.count, 3);

    const missing = await api('GET', '/api/export/session/999999?format=json');
    assert.equal(missing.status, 404);
  });

  /* ---------------------------- 媒体 ---------------------------- */

  await t.test('媒体列表 / raw / Range / thumb / verify', async () => {
    const list = await api('GET', '/api/media');
    assert.equal(list.status, 200);
    assert.ok(list.body.data.total >= 3);

    const raw = await api('GET', `/api/media/${picMedia.id}/raw`);
    assert.equal(raw.status, 200);
    assert.equal(raw.headers.get('accept-ranges'), 'bytes');
    assert.equal(raw.headers.get('content-type'), 'image/png');
    assert.match(raw.headers.get('content-disposition') ?? '', /^inline/);
    assert.equal(raw.text, picBytes.toString());

    // <img>/<video> 无法带请求头，媒体流必须支持 ?access= 令牌
    const viaQuery = await fetch(`${base}/api/media/${picMedia.id}/raw?access=${encodeURIComponent(token)}`);
    assert.equal(viaQuery.status, 200);
    assert.equal(await viaQuery.text(), picBytes.toString());
    const badQuery = await fetch(`${base}/api/media/${picMedia.id}/raw?access=nope`);
    assert.equal(badQuery.status, 401);

    const ranged = await api('GET', `/api/media/${picMedia.id}/raw`, { headers: { Range: 'bytes=0-3' } });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get('content-range'), `bytes 0-3/${picBytes.length}`);
    assert.equal(ranged.text, picBytes.subarray(0, 4).toString());

    const bad = await api('GET', `/api/media/${picMedia.id}/raw`, { headers: { Range: 'bytes=99999-' } });
    assert.equal(bad.status, 416);
    assert.equal(bad.headers.get('content-range'), `bytes */${picBytes.length}`);

    const thumb = await api('GET', `/api/media/${picMedia.id}/thumb`);
    assert.equal(thumb.status, 200);
    assert.equal(thumb.text, 'THUMB-BYTES');

    const thumb404 = await api('GET', `/api/media/${missing.id}/thumb`);
    assert.equal(thumb404.status, 404);

    const verify = await api('POST', `/api/media/${picMedia.id}/verify`);
    assert.equal(verify.status, 200);
    assert.equal(verify.body.data.status, 'present');
    assert.equal(verify.body.data.ok, true);
    assert.equal(verify.body.data.sha256Matches, true);
    assert.equal(verify.body.data.sha256, sha256Hex(picBytes));

    const notFoundId = await api('GET', '/api/media/999999/raw');
    assert.equal(notFoundId.status, 404);

    const gone = await api('GET', `/api/media/${missing.id}/raw`);
    assert.equal(gone.status, 410);
    assert.equal(gone.body.code, 'MEDIA_MISSING');

    // 决定性穿越用例：文件确实存在，但不在 mediaDir 内 → 必须拒绝且不返回内容
    const escapedRaw = await api('GET', `/api/media/${escaped.id}/raw`);
    assert.equal(escapedRaw.status, 400, `越界 rel_path 应 400，实际 ${escapedRaw.status}: ${escapedRaw.text.slice(0, 200)}`);
    assert.ok(!escapedRaw.text.includes(SECRET_OUTSIDE_MEDIA), '越界路径不得返回 mediaDir 之外的文件内容');

    const escapedAbsRaw = await api('GET', `/api/media/${escapedAbs.id}/raw`);
    assert.ok(escapedAbsRaw.status === 400 || escapedAbsRaw.status === 404, `越界 rel_path 应 400/404，实际 ${escapedAbsRaw.status}`);
    assert.ok(!escapedAbsRaw.text.includes('root:'), '越界路径不得返回 /etc/passwd 内容');
    assert.ok(!escapedAbsRaw.text.includes(SECRET_IN_REPO));

    const escapedThumb = await api('GET', `/api/media/${escaped.id}/thumb`);
    assert.ok(escapedThumb.status === 400 || escapedThumb.status === 404);
  });

  /* ------------------------------ STT ------------------------------ */

  await t.test('STT：probe 缓存 / transcript 前后 / 单条转写 / 批量幂等 / 搜索命中', async () => {
    const probeCount = () => sttCalls.filter((c) => c.cmd === 'whisper-cli' && c.args.includes('--help')).length;

    // 转写前：transcript 为 null，但引擎可用（假 exec 下 probe 通过）
    const before = await api('GET', `/api/media/${audioA.id}/transcript`);
    assert.equal(before.status, 200);
    assert.equal(before.body.data.transcript, null);
    assert.equal(before.body.data.available.available, true, JSON.stringify(before.body.data.available));

    const status0 = await api('GET', '/api/stt/status');
    assert.equal(status0.status, 200);
    assert.equal(status0.body.data.enabled, true);
    assert.equal(status0.body.data.available, true);
    assert.equal(status0.body.data.pending, 2);
    assert.equal(status0.body.data.stats.total, 0);

    // 非语音 → 400；不存在 → 404
    const badKind = await api('POST', `/api/media/${picMedia.id}/transcribe`);
    assert.equal(badKind.status, 400, badKind.text.slice(0, 200));
    const gone = await api('POST', '/api/media/999999/transcribe');
    assert.equal(gone.status, 404);

    // 单条转写：返回 result（顶层展开）+ 落库行
    const one = await api('POST', `/api/media/${audioA.id}/transcribe`);
    assert.equal(one.status, 200, one.text.slice(0, 300));
    assert.equal(typeof one.body.data.text, 'string');
    assert.equal(one.body.data.engine, 'whisper-cli');
    assert.equal(one.body.data.transcript.mediaId, audioA.id);
    assert.equal(one.body.data.transcript.text, '服务器端转写文本');
    assert.equal(one.body.data.transcript.engine, 'whisper-cli');
    assert.equal(db.getTranscript(audioA.id)?.text, '服务器端转写文本');

    const after = await api('GET', `/api/media/${audioA.id}/transcript`);
    assert.equal(after.body.data.transcript.text, '服务器端转写文本');

    // 批量：还剩 audioB 未转写
    const batch = await api('POST', '/api/stt/transcribe', { body: { limit: 10 } });
    assert.equal(batch.status, 200, batch.text.slice(0, 300));
    assert.equal(batch.body.data.transcribed, 1);
    assert.equal(batch.body.data.failed, 0);
    assert.equal(batch.body.data.candidates, 1);
    assert.equal(db.transcriptStats().total, 2);

    // 幂等：再跑一次没有候选、不新增行
    const again = await api('POST', '/api/stt/transcribe', { body: { limit: 10 } });
    assert.equal(again.status, 200, again.text.slice(0, 200));
    assert.equal(again.body.data.candidates, 0);
    assert.equal(again.body.data.transcribed, 0);
    assert.equal(db.transcriptStats().total, 2, '重复批量不得复制 media_transcripts 行');

    // 媒体列表带 transcript；keyword 命中语音内容
    const list = await api('GET', '/api/media?kind=audio');
    assert.equal(list.body.data.total, 2);
    const card = list.body.data.items.find((m: { id: number }) => m.id === audioA.id);
    assert.ok(card, '应能找到 audioA');
    assert.equal(card.transcript, '服务器端转写文本');

    const bySpeech = await api('GET', '/api/media?keyword=' + encodeURIComponent('服务器端'));
    assert.equal(bySpeech.body.data.total, 2, '按语音内容搜索应命中两条音频');
    const miss = await api('GET', '/api/media?keyword=' + encodeURIComponent('绝对不存在的语音串'));
    assert.equal(miss.body.data.total, 0);

    // probe 必须缓存：整段流程只探测一次；显式 POST /api/stt/probe 才刷新
    assert.equal(probeCount(), 1, 'probe 必须缓存，不能每个请求 spawn 一次');
    const refresh = await api('POST', '/api/stt/probe');
    assert.equal(refresh.status, 200);
    assert.equal(probeCount(), 2, 'POST /api/stt/probe 应强制重新探测');
  });

  /* ---------------------------- 静态托管 ---------------------------- */

  await t.test('静态托管：SPA 回退，且不泄露 web/ 之外的文件', async () => {
    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    assert.match(await index.text(), new RegExp(INDEX_MARKER));

    const spa = await fetch(`${base}/some/deep/route`);
    assert.equal(spa.status, 200);
    assert.match(await spa.text(), new RegExp(INDEX_MARKER));

    const js = await fetch(`${base}/app.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type') ?? '', /javascript/);

    const dir = await fetch(`${base}/package.json`);
    assert.equal(dir.status, 404);
    assert.ok(!(await dir.text()).includes(SECRET_IN_REPO));

    for (const path of ['/%2e%2e/package.json', '/%2e%2e%2fpackage.json', '/web/../package.json', '/..%2f..%2fpackage.json']) {
      const res = await fetch(`${base}${path}`);
      const body = await res.text();
      assert.ok(res.status === 400 || res.status === 404, `${path} 应 400/404，实际 ${res.status}`);
      assert.ok(!body.includes(SECRET_IN_REPO), `${path} 泄露了仓库文件`);
    }
  });

  /* ---------------------------- 任务 ---------------------------- */

  await t.test('jobs / SSE / collect / import', async () => {
    const empty = await api('GET', '/api/jobs');
    assert.equal(empty.status, 200);

    const collect = await api('POST', '/api/collect/run');
    assert.equal(collect.status, 200);
    assert.equal(typeof collect.body.data.jobId, 'number');
    const job = await api('GET', `/api/jobs/${collect.body.data.jobId}`);
    assert.equal(job.status, 200);
    assert.equal(job.body.data.kind, 'collect');

    const health = await api('GET', '/api/collect/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.data.enabled, false);

    // SSE：先拿到首帧，再等终帧
    const sseJob = db.createJob({ kind: 'collect' });
    const ac = new AbortController();
    const sse = await fetch(`${base}/api/jobs/${sseJob}/events`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: ac.signal,
    });
    assert.equal(sse.status, 200);
    assert.match(sse.headers.get('content-type') ?? '', /text\/event-stream/);
    const reader = sse.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = decoder.decode((await reader.read()).value);
    assert.match(buffer, /event: (job|progress)/);
    db.updateJob(sseJob, { status: 'done', finishedAt: new Date().toISOString(), progress: 1 });
    const deadline = Date.now() + 6000;
    while (!buffer.includes('event: done') && Date.now() < deadline) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value);
    }
    ac.abort();
    assert.match(buffer, /event: done/, `SSE 未推送 done 帧：${buffer}`);

    const rel = await api('POST', '/api/import', { body: { path: 'relative/path.json' } });
    assert.equal(rel.status, 400);
    const nope = await api('POST', '/api/import', { body: { path: join(root, 'nope.json') } });
    assert.equal(nope.status, 404);

    const srcPath = join(root, 'sample.json');
    writeFileSync(srcPath, '{"messages":[]}');
    const imp = await api('POST', '/api/import', { body: { path: srcPath, format: 'json' } });
    // packages/import 由队友并行实现：模块不可用时必须是明确的 503，不允许 500
    assert.ok(imp.status === 200 || imp.status === 503, `import 实际 ${imp.status}: ${imp.text}`);
    if (imp.status === 503) {
      assert.equal(imp.body.code, 'IMPORT_UNAVAILABLE');
    } else {
      assert.equal(typeof imp.body.data.jobId, 'number');
      // 后台异步执行：必须在合理时间内进入终态（导入器解析结果由 packages/import 决定）
      const jobId = imp.body.data.jobId as number;
      const deadline = Date.now() + 10_000;
      let job = await api('GET', `/api/jobs/${jobId}`);
      while (!['done', 'failed', 'cancelled'].includes(job.body.data.status as string) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
        job = await api('GET', `/api/jobs/${jobId}`);
      }
      assert.ok(
        ['done', 'failed', 'cancelled'].includes(job.body.data.status as string),
        `导入任务应进入终态，实际 ${job.body.data.status}`,
      );
      assert.ok(typeof job.body.data.startedAt === 'string' && typeof job.body.data.finishedAt === 'string', '终态任务应有起止时间');
      const after = await api('GET', '/api/jobs?kind=import');
      assert.ok(after.body.data.total >= 1);
    }
  });

  /* ---------------------------- 备份 → 恢复 ---------------------------- */

  await t.test('备份 → 恢复（dryRun + 真实应用）演练', async () => {
    const before = (await api('GET', '/api/stats')).body.data.messages as number;

    const backup = await api('POST', '/api/backup', { body: { verify: true } });
    assert.equal(backup.status, 200, backup.text);
    const snapshotPath = backup.body.data.path as string;
    assert.ok(snapshotPath.startsWith(config.storage.backupDir));
    assert.ok(existsSync(snapshotPath), '快照文件应存在');
    assert.ok(existsSync(`${snapshotPath.replace(/\.db$/, '')}.manifest.json`), 'manifest 应存在');
    assert.equal(backup.body.data.counts.messages, before);
    assert.match(backup.body.data.sha256 as string, /^[0-9a-f]{64}$/);

    const backups = await api('GET', '/api/backups');
    assert.equal(backups.status, 200);
    assert.equal(backups.body.data.items[0].dbSha256, backup.body.data.sha256);
    assert.equal(backups.body.data.items[0].manifestExists, true);

    // 备份之后继续写：用于验证恢复真的把数据回退
    const extraTs = 1_700_000_000_000 + 99 * 60_000;
    db.insertMessages(
      session.id,
      SESSION.accountUid,
      key,
      [
        {
          msgKey: 'id:m-extra',
          msgId: 'm-extra',
          ts: extraTs,
          direction: 'in' as const,
          msgType: 'text' as const,
          senderName: 'Alice',
          text: '备份之后的新消息',
        },
      ],
      { source: 'test' },
    );
    assert.equal((await api('GET', '/api/stats')).body.data.messages, before + 1);

    const dry = await api('POST', '/api/backups/restore', { body: { path: snapshotPath, dryRun: true } });
    assert.equal(dry.status, 200, dry.text);
    assert.equal(dry.body.data.ok, true);
    assert.equal(dry.body.data.dryRun, true);
    assert.equal(dry.body.data.manifestMessageCount, before);
    assert.equal(dry.body.data.applied, null);
    assert.equal((await api('GET', '/api/stats')).body.data.messages, before + 1, 'dryRun 不得改动在线数据');

    const applied = await api('POST', '/api/backups/restore', { body: { path: snapshotPath, dryRun: false } });
    assert.equal(applied.status, 200, applied.text);
    assert.equal(applied.body.data.ok, true);
    assert.equal(applied.body.data.applied.to, config.storage.dbPath);
    assert.ok(existsSync(applied.body.data.applied.backupOfOld), '应保留 .bak');
    assert.equal(applied.body.data.reopened, true, '换库后应重开数据库句柄');

    const after = await api('GET', '/api/stats');
    assert.equal(after.body.data.messages, before, '恢复后应回到备份时的条数');
    const sessions = await api('GET', '/api/sessions');
    assert.equal(sessions.body.data.items[0].name, SESSION.name, '换库后服务仍可正常读');
  });

  /* ---------------------------- 定时自动备份 ---------------------------- */

  await t.test('自动备份：配置真的被消费，且备份写进 backups 表（网页可见）', async () => {
    // 回归护栏：`backup.intervalHours` / `backup.keep` 曾经只有类型、默认值与文档，
    // 没有任何消费者 —— 配置里写着「默认 24 小时自动备份」，实际从来没跑过。
    assert.equal(created.autoBackup.enabled, true, 'intervalHours=24 时定时器应启用');
    assert.equal(created.autoBackup.intervalHours, config.backup.intervalHours);
    assert.equal(created.autoBackup.keep, config.backup.keep);

    const before = (await api('GET', '/api/backups')).body.data.items.length;

    // 与定时器同一入口，因此同样「生成快照 + 入库 + 裁剪」。
    const run = await created.runAutoBackupNow();
    assert.ok(existsSync(run.path), `自动备份应产出快照：${run.path}`);

    const listed = await api('GET', '/api/backups');
    assert.equal(listed.status, 200);
    assert.equal(listed.body.data.items.length, before + 1, '自动备份必须在 /api/backups 里可见');
    assert.equal(listed.body.data.items[0].kind, 'auto');
    assert.equal(listed.body.data.items[0].path, run.path);

    // 网页「归档管理」读的就是 /api/stats 的 lastBackupAt
    const stats = await api('GET', '/api/stats');
    assert.ok(typeof stats.body.data.lastBackupAt === 'string' && stats.body.data.lastBackupAt !== '', 'lastBackupAt 不应再恒为 null');
  });
});

test('server: STT 未配置时相关路由返回 503/available=false 且服务不崩溃', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'qqarchive-stt-off-'));
  const config = makeConfig(root);
  delete config.stt; // 完全未配置 STT
  mkdirSync(config.storage.mediaDir, { recursive: true });
  const logger = createLogger({ console: false });
  const db = openDatabase({ path: config.storage.dbPath });
  const offBytes = Buffer.from('OFF-AUDIO-BYTES');
  writeFileSync(join(config.storage.mediaDir, 'off.amr'), offBytes);
  const audio = db.upsertMedia({
    sha256: sha256Hex(offBytes),
    kind: 'audio',
    size: offBytes.length,
    relPath: 'off.amr',
    mime: 'audio/amr',
    status: 'present',
  });

  const created = createServer({
    config,
    db,
    logger: logger.child('test'),
    repoRoot: join(root, 'repo'),
    version: '0.1.0-test',
    startedAt: Date.now(),
  });
  await new Promise<void>((done) => created.server.listen(0, '127.0.0.1', () => done()));
  const port = (created.server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  t.after(async () => {
    await created.close();
    await logger.close();
    try {
      db.close();
    } catch {
      /* 可能已由恢复演练关闭 */
    }
    rmSync(root, { recursive: true, force: true });
  });

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: TOKEN }),
  });
  assert.equal(login.status, 200);
  const token = ((await login.json()) as { data: { accessToken: string } }).data.accessToken;
  const authed = (path: string, method = 'GET'): Promise<Response> =>
    fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}` } });

  const status = await authed('/api/stt/status');
  assert.equal(status.status, 200);
  const sbody = (await status.json()) as { data: { enabled: boolean; available: boolean; reason: string; pending: number; warnings: string[] } };
  assert.equal(sbody.data.enabled, false);
  assert.equal(sbody.data.available, false);
  assert.ok(sbody.data.reason.length > 0, '未配置时必须给出原因');
  assert.equal(sbody.data.pending, 1);

  const transcript = await authed(`/api/media/${audio.id}/transcript`);
  assert.equal(transcript.status, 200);
  const tbody = (await transcript.json()) as { data: { transcript: unknown; available: { available: boolean; reason: string } } };
  assert.equal(tbody.data.transcript, null);
  assert.equal(tbody.data.available.available, false);
  assert.ok(tbody.data.available.reason.length > 0);

  const single = await authed(`/api/media/${audio.id}/transcribe`, 'POST');
  assert.equal(single.status, 503);
  assert.equal(((await single.json()) as { code: string }).code, 'STT_UNAVAILABLE');

  const batch = await authed('/api/stt/transcribe', 'POST');
  assert.equal(batch.status, 503);
  assert.equal(((await batch.json()) as { code: string }).code, 'STT_UNAVAILABLE');

  // 决定性：这些错误路径不得把服务器带崩
  const health = await authed('/api/health');
  assert.equal(health.status, 200);
});

/**
 * 采集启停接口：`/api/collect/health` 的 `running/controllable`、
 * `/api/collect/start`、`/api/collect/stop`。
 *
 * 背景：界面上曾经只有"立即采集"（跑一轮），既看不出定时采集在不在跑、也没法停它 ——
 * 因为循环由 CLI 启动、服务端只拿到 `runOnce`。现在服务端持有循环句柄并暴露这三个接口。
 * 这里同时覆盖"不支持启停控制的桩实现"（只有 runOnce）必须如实回 `controllable:false`
 * 并给出可读原因，而不是假装能控制。
 */
test('server: 采集启停契约（真实循环可控 / 桩实现如实回不可控）', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'qqarch-collectctl-'));
  const config = makeConfig(root);
  mkdirSync(config.storage.mediaDir, { recursive: true });
  mkdirSync(config.storage.backupDir, { recursive: true });
  const db = openDatabase({ path: config.storage.dbPath });
  const logger = createLogger({ console: false });

  let runs = 0;
  let running = false;
  // 一个"可启停"的假 runner：实现 start/isRunning，够服务端做控制
  const loopRunner = {
    async runOnce() {
      runs += 1;
      return { inserted: 0 };
    },
    isRunning: () => running,
    start: () => {
      running = true;
      return async () => {
        running = false;
      };
    },
  };
  const created = createServer({ config, db, logger: logger.child('ctl'), collect: loopRunner, repoRoot: root, version: '0.0.0-ctl', startedAt: Date.now() });
  await new Promise<void>((r) => created.server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(created.server.address() as AddressInfo).port}`;
  t.after(async () => {
    await created.close();
    await logger.close();
    try {
      db.close();
    } catch {
      /* 已关 */
    }
    rmSync(root, { recursive: true, force: true });
  });

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: TOKEN }),
  });
  const token = (await login.json() as { data: { accessToken: string } }).data.accessToken;
  const call = async (method: string, path: string) => {
    const r = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}` } });
    return { status: r.status, body: await r.json() as any };
  };

  await t.test('health 报出 running/controllable', async () => {
    const r = await call('GET', '/api/collect/health');
    assert.equal(r.status, 200);
    assert.equal(r.body.data.controllable, true, '真实 runner 应可控制');
    assert.equal(r.body.data.running, true, '起服务后应已自动启动');
  });

  await t.test('stop 真的停：running 变 false，且重复 stop 不报错（幂等）', async () => {
    const stop = await call('POST', '/api/collect/stop');
    assert.equal(stop.status, 200);
    assert.equal(stop.body.data.stopped, true);
    assert.equal(running, false, '底层 runner 应真的被停掉');
    assert.equal((await call('GET', '/api/collect/health')).body.data.running, false);

    const again = await call('POST', '/api/collect/stop');
    assert.equal(again.status, 200, '重复停止不该报错');
    assert.equal(again.body.data.stopped, false, '第二次应如实回报"没停什么"');
  });

  await t.test('start 真的起，且重复 start 幂等（不叠加循环）', async () => {
    const start = await call('POST', '/api/collect/start');
    assert.equal(start.status, 200);
    assert.equal(start.body.data.running, true);
    assert.equal(running, true);

    const again = await call('POST', '/api/collect/start');
    assert.equal(again.status, 200);
    assert.equal(again.body.data.started, false, '第二次应回报"已经在跑"');
    assert.equal(again.body.data.running, true);
  });

  await t.test('未认证访问这三个接口一律 401', async () => {
    for (const [method, path] of [['GET', '/api/collect/health'], ['POST', '/api/collect/start'], ['POST', '/api/collect/stop']] as const) {
      const r = await fetch(`${base}${path}`, { method });
      assert.equal(r.status, 401, `${method} ${path} 应要求认证`);
    }
  });

  await t.test('close() 会停掉采集循环（否则关闭时可能还有一轮在写库）', async () => {
    assert.equal(running, true, '前置条件：当前在运行');
    await created.close();
    assert.equal(running, false, '关闭服务应停掉循环');
  });
});

test('server: 采集实现不支持启停时，如实报 controllable=false 并拒绝 start', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'qqarch-collectctl2-'));
  const config = makeConfig(root);
  mkdirSync(config.storage.mediaDir, { recursive: true });
  mkdirSync(config.storage.backupDir, { recursive: true });
  const db = openDatabase({ path: config.storage.dbPath });
  const logger = createLogger({ console: false });
  // 只实现 runOnce 的桩（很多既有调用方就是这样）
  const stub = { async runOnce() { return { inserted: 0 }; } };
  const created = createServer({ config, db, logger: logger.child('ctl2'), collect: stub, repoRoot: root, version: '0.0.0-ctl2', startedAt: Date.now() });
  await new Promise<void>((r) => created.server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(created.server.address() as AddressInfo).port}`;
  t.after(async () => {
    await created.close();
    await logger.close();
    try {
      db.close();
    } catch {
      /* 已关 */
    }
    rmSync(root, { recursive: true, force: true });
  });

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: TOKEN }),
  });
  const token = (await login.json() as { data: { accessToken: string } }).data.accessToken;
  const auth = { Authorization: `Bearer ${token}` };

  const health = await (await fetch(`${base}/api/collect/health`, { headers: auth })).json() as any;
  assert.equal(health.data.controllable, false, '桩实现应如实报不可控');
  assert.equal(health.data.running, null, '不可控时 running 未知，用 null 而不是编一个 false');

  const start = await fetch(`${base}/api/collect/start`, { method: 'POST', headers: auth });
  assert.equal(start.status, 503, '不可控时应明确拒绝，而不是假装启动成功');
  const body = await start.json() as any;
  assert.match(String(body.error), /不支持启停控制/);
});
