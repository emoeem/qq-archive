/**
 * 合并转发展开测试（packages/collect/src/forward.ts + OneBotCollector.fetchForward）。
 *
 * 覆盖三层：
 *  1. 纯函数 `expandForward`：递归、资源平铺与去重、resourceRange 下标、限流与截断标记；
 *  2. `OneBotCollector.fetchForward`：只读白名单、参数兼容、两种响应包装、秒/毫秒时间；
 *  3. `CollectRunner` 端到端：`extra.forward` 真的落进 `messages.extra`，且转发里的
 *     媒体被平铺归档、`message_media.ordinal` 与 `resourceRange` 对得上。
 *
 * 全程不访问真实 QQ / 真实 NapCat。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createLogger,
  type CollectorConfig,
  type NormalizedMessage,
} from '../packages/core/src/index.ts';
import { openDatabase, type Db } from '../packages/db/src/index.ts';
import {
  CollectRunner,
  OneBotCollector,
  READ_ONLY_ACTIONS,
  expandForward,
  resourceDedupKey,
  type ArchiveOutcome,
  type CollectSession,
  type Collector,
  type ForwardNode,
  type ProbeResult,
  type SessionInfo,
} from '../packages/collect/src/index.ts';

const logger = createLogger({ level: 'error', console: false }).child('forward-test');

const MS = 1_700_000_000_000;

function node(over: Partial<ForwardNode> = {}): ForwardNode {
  return { ts: MS, text: '', msgType: 'text', resources: [], ...over };
}

/* ------------------------------------------------------------------ */
/* 1. 纯函数 expandForward                                             */
/* ------------------------------------------------------------------ */

test('expandForward：两层转发展开，资源平铺且 resourceRange 与下标严格对齐', async () => {
  const tree: Record<string, ForwardNode[]> = {
    f1: [
      node({
        senderUin: '1001',
        senderName: '甲',
        text: '外层一',
        resources: [{ kind: 'image', url: 'http://x/a.png', filename: 'a.png' }],
      }),
      node({ senderUin: '1002', senderName: '乙', text: '外层二', forwardId: 'f2' }),
    ],
    f2: [
      node({
        senderUin: '1003',
        senderName: '丙',
        text: '内层一',
        resources: [{ kind: 'image', url: 'http://x/b.png', filename: 'b.png' }],
      }),
    ],
  };

  const res = await expandForward({
    fetchForward: async (id) => tree[id] ?? [],
    forwardId: 'f1',
    ownResources: [{ kind: 'image', url: 'http://x/own.png', filename: 'own.png' }],
  });

  assert.equal(res.forward.id, 'f1');
  assert.equal(res.forward.count, 3, 'count 必须含所有嵌套层的子消息');
  assert.deepEqual(
    res.resources.map((r) => r.url),
    ['http://x/own.png', 'http://x/a.png', 'http://x/b.png'],
    '自有资源在前，转发内资源按深度优先顺序平铺',
  );
  assert.deepEqual(res.forward.messages[0]?.resourceRange, [1, 2], '外层一的资源占 resources[1..2)');
  assert.equal(res.forward.messages[1]?.resourceRange, undefined, '外层二自身无资源，不得凭空造区间');
  assert.deepEqual(res.forward.messages[1]?.forward?.messages[0]?.resourceRange, [2, 3], '内层一的资源占 resources[2..3)');
  assert.equal(res.forward.messages[1]?.forward?.messages[0]?.text, '内层一');
  assert.equal(res.forward.truncated, undefined, '未触限流时不得出现 truncated 标记');
});

test('expandForward：同一张图在转发里重复出现只平铺一次（去重键生效）', async () => {
  const dup = { kind: 'image' as const, url: 'http://x/same.png', filename: 'same.png' };
  const res = await expandForward({
    fetchForward: async () => [node({ text: '一', resources: [dup] }), node({ text: '二', resources: [{ ...dup }] })],
    forwardId: 'f',
  });
  assert.equal(res.resources.length, 1, '同一 url 只应归档一次');
  assert.deepEqual(res.forward.messages[0]?.resourceRange, [0, 1]);
  assert.equal(res.forward.messages[1]?.resourceRange, undefined, '第二条是重复引用，不应再占一个 ordinal');
  assert.equal(resourceDedupKey(dup), resourceDedupKey({ ...dup }), '去重键必须对结构相同的资源稳定');
});

test('expandForward：超过 maxDepth 时保留 forwardId 并标记截断，绝不静默丢内容', async () => {
  const tree: Record<string, ForwardNode[]> = {
    d1: [node({ text: '第一层', forwardId: 'd2' })],
    d2: [node({ text: '第二层', forwardId: 'd3' })],
    d3: [node({ text: '第三层' })],
  };
  const res = await expandForward({ fetchForward: async (id) => tree[id] ?? [], forwardId: 'd1', maxDepth: 2 });
  assert.equal(res.forward.count, 2, '只展开两层');
  const deep = res.forward.messages[0]?.forward?.messages[0];
  assert.equal(deep?.forwardId, 'd3', '触顶的转发必须留下 id 以便追溯');
  assert.equal(deep?.forwardTruncated, true);
  assert.equal(deep?.forward, undefined, '触顶后不得继续递归');
  assert.equal(res.forward.truncated, true);
});

test('expandForward：maxNodes 预算封顶，超出的节点被截断而不是无限扩张', async () => {
  const many = Array.from({ length: 10 }, (_, i) => node({ text: `第${i}条` }));
  const res = await expandForward({ fetchForward: async () => many, forwardId: 'f', maxNodes: 3 });
  assert.equal(res.forward.messages.length, 3);
  assert.equal(res.forward.count, 3);
  assert.equal(res.forward.truncated, true);
});

test('expandForward：空转发（不可读 / 无子消息）返回 count=0 且不动原有资源', async () => {
  const own = [{ kind: 'image' as const, url: 'http://x/own.png' }];
  const res = await expandForward({ fetchForward: async () => [], forwardId: 'f', ownResources: own });
  assert.equal(res.forward.count, 0);
  assert.deepEqual(res.forward.messages, []);
  assert.equal(res.resources.length, 1, '不得因为转发为空就丢掉父消息自身的资源');
});

/* ------------------------------------------------------------------ */
/* 2. OneBotCollector.fetchForward                                     */
/* ------------------------------------------------------------------ */

interface Call {
  action: string;
  params: Record<string, unknown>;
}

/** 最小假 OneBot HTTP：只实现 get_forward_msg，记录入参。 */
function fakeOneBot(respond: (params: Record<string, unknown>) => unknown): {
  collector: OneBotCollector;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const action = String(url).split('/').pop() ?? '';
    const params = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({ action, params });
    return new Response(JSON.stringify(respond(params)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof globalThis.fetch;
  return { collector: new OneBotCollector({ baseUrl: 'http://127.0.0.1:1', fetchImpl }), calls };
}

test('get_forward_msg 在只读白名单里（否则真机拉转发会被自己的安全边界拒绝）', () => {
  assert.ok(READ_ONLY_ACTIONS.includes('get_forward_msg'), 'READ_ONLY_ACTIONS 必须包含 get_forward_msg');
});

test('fetchForward：同时带 id 与 message_id，解 {data:{messages:[]}} 包装，秒级时间转毫秒', async () => {
  const { collector, calls } = fakeOneBot(() => ({
    status: 'ok',
    retcode: 0,
    data: {
      messages: [
        {
          type: 'node',
          data: {
            user_id: 10001,
            nickname: '甲',
            time: 1_700_000_000,
            content: [
              { type: 'text', data: { text: '你好' } },
              { type: 'image', data: { file: 'a.png', url: 'http://x/a.png' } },
            ],
          },
        },
      ],
    },
  }));

  const nodes = await collector.fetchForward('fwd-1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.action, 'get_forward_msg');
  assert.equal(calls[0]?.params.id, 'fwd-1');
  assert.equal(calls[0]?.params.message_id, 'fwd-1', 'NapCat 用 message_id，必须一起带上');
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0]?.senderUin, '10001');
  assert.equal(nodes[0]?.senderName, '甲');
  assert.equal(nodes[0]?.ts, 1_700_000_000_000, '秒级 time 必须转成毫秒');
  assert.equal(nodes[0]?.text, '你好[图片]');
  assert.equal(nodes[0]?.msgType, 'image');
  assert.equal(nodes[0]?.resources.length, 1);
  assert.equal(nodes[0]?.resources[0]?.url, 'http://x/a.png');
});

test('fetchForward：兼容扁平节点 / data 直接是数组 / 毫秒时间戳 / 嵌套转发 id', async () => {
  const { collector } = fakeOneBot(() => ({
    status: 'ok',
    retcode: 0,
    data: [
      {
        user_id: 20002,
        nickname: '乙',
        timestamp: 1_700_000_000_123, // 已经是毫秒
        message: '[CQ:forward,id=inner-9]稍后再看',
      },
    ],
  }));

  const nodes = await collector.fetchForward('fwd-2');
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0]?.ts, 1_700_000_000_123, '毫秒时间戳不得被再乘 1000');
  assert.equal(nodes[0]?.forwardId, 'inner-9', '嵌套转发必须保留 id 交给上层决定递归');
  assert.equal(nodes[0]?.text, '[合并转发]稍后再看');
});

test('fetchForward：真机 NapCat 的 node.sender 嵌套发送者必须解析出昵称（回归）', async () => {
  // 真机实测的原始形状（2026-10-13，真实 QQ 号 1000000001 拉真实合并转发）：
  // 发送者不在 node 顶层，而是嵌在 node.sender = {user_id, nickname, card} 里。
  // 旧实现只读 node.nickname/name/card，导致真实转发的 senderName 恒为 undefined。
  const { collector } = fakeOneBot(() => ({
    status: 'ok',
    retcode: 0,
    data: {
      messages: [
        {
          self_id: 1000000001,
          user_id: 1000000002,
          time: 1740489039,
          message_id: 55001467,
          message_seq: 55001467,
          real_id: 55001467,
          message_type: 'group',
          sender: { user_id: 1000000002, nickname: '示例用户', card: '' },
          raw_message: 'magnet:?xt=urn:btih:5262E1',
          font: 14,
          sub_type: 'normal',
          message: [{ type: 'text', data: { text: 'magnet:?xt=urn:btih:5262E1' } }],
          message_format: 'array',
          post_type: 'message',
          group_id: 284840486,
          group_name: '',
        },
        {
          user_id: 20002,
          time: 1740489100,
          sender: { user_id: 20002, nickname: '群名片外的昵称', card: '群名片' },
          message: [{ type: 'text', data: { text: '第二条' } }],
        },
      ],
    },
  }));

  const nodes = await collector.fetchForward('fwd-3');
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0]?.senderUin, '1000000002', '顶层 user_id 仍要优先用作 uin');
  assert.equal(nodes[0]?.senderName, '示例用户', 'nickname 在 node.sender 里，必须读到');
  assert.equal(nodes[0]?.ts, 1740489039 * 1000);
  assert.equal(nodes[1]?.senderName, '群名片', '有群名片时用 group card，与消息主路径一致');
});

test('fetchForward：空 id 直接返回空数组，不发请求', async () => {
  const { collector, calls } = fakeOneBot(() => ({ status: 'ok', retcode: 0, data: { messages: [] } }));
  assert.deepEqual(await collector.fetchForward('   '), []);
  assert.equal(calls.length, 0);
});

/* ------------------------------------------------------------------ */
/* 3. CollectRunner 端到端                                             */
/* ------------------------------------------------------------------ */

class StubCollector implements Collector {
  readonly kind = 'onebot';
  readonly forwardCalls: string[] = [];
  private readonly msgs: NormalizedMessage[];
  private readonly tree: Record<string, ForwardNode[]>;
  private readonly failForward: boolean;

  constructor(msgs: NormalizedMessage[], tree: Record<string, ForwardNode[]>, failForward = false) {
    this.msgs = msgs;
    this.tree = tree;
    this.failForward = failForward;
  }

  async probe(): Promise<ProbeResult> {
    return { ok: true, uin: '1' };
  }

  async listSessions(): Promise<SessionInfo[]> {
    return [{ chatType: 'group', peerUid: 'g:123', peerUin: '123', name: '测试群' }];
  }

  async fetchSince(): Promise<NormalizedMessage[]> {
    return this.msgs;
  }

  async fetchMedia(): Promise<null> {
    return null;
  }

  async fetchForward(id: string): Promise<ForwardNode[]> {
    this.forwardCalls.push(id);
    if (this.failForward) throw new Error('get_forward_msg 被拒绝：消息不存在');
    return this.tree[id] ?? [];
  }
}

function collectConfig(over: Partial<CollectorConfig> = {}): CollectorConfig {
  return {
    kind: 'onebot',
    baseUrl: 'http://127.0.0.1:1',
    token: '',
    intervalSec: 60,
    lookbackSec: 300,
    initialBackfillDays: 3,
    pageSize: 200,
    maxPagesPerRound: 10,
    syncMedia: true,
    maxMediaBytes: 512 * 1024 * 1024,
    discoverSessions: false,
    sessions: ['group:123'],
    forwardDepth: 3,
    forwardMaxNodes: 200,
    ...over,
  };
}

function parentMsg(over: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    msgKey: 'mk-forward-1',
    msgId: 'm1',
    ts: MS,
    senderUin: '9999',
    senderName: '我',
    direction: 'in',
    msgType: 'forward',
    text: '[合并转发]',
    forwardId: 'fwd-1',
    resources: [],
    ...over,
  };
}

/** 归档回调：返回一个结构完整的 MediaInput，让 persistMedia 真的写 media 行。 */
function archiveFn(seen: string[]) {
  return async (ref: { kind: string; url?: string; filename?: string }): Promise<ArchiveOutcome> => {
    const url = ref.url ?? ref.filename ?? '';
    seen.push(url);
    return {
      status: 'present',
      media: {
        sha256: url.padEnd(64, '0').slice(0, 64),
        kind: ref.kind as 'image',
        size: 3,
        relPath: `image/${url.slice(-4)}/${url}`,
        ext: 'png',
        mime: 'image/png',
        status: 'present',
        originUrl: ref.url ?? null,
        originPath: null,
      },
    };
  };
}

test('CollectRunner：extra.forward 真的写进 messages.extra，且转发内媒体按 ordinal 关联', async () => {
  const stub = new StubCollector(
    [parentMsg()],
    {
      'fwd-1': [
        node({
          senderUin: '1001',
          senderName: '甲',
          text: '外层带图',
          resources: [{ kind: 'image', url: 'http://x/a.png', filename: 'a.png' }],
        }),
        node({ senderUin: '1002', senderName: '乙', text: '纯文本' }),
        node({ senderUin: '1003', senderName: '丙', text: '再带图', resources: [{ kind: 'image', url: 'http://x/b.png', filename: 'b.png' }] }),
      ],
    },
  );
  const db: Db = openDatabase({ path: ':memory:' });
  const seen: string[] = [];
  try {
    const runner = new CollectRunner({
      db,
      collector: stub,
      config: collectConfig(),
      logger,
      archiveMedia: archiveFn(seen),
    });
    const round = await runner.runOnce();

    assert.equal(round.sessions, 1);
    assert.equal(round.inserted, 1);
    assert.equal(round.forwardMessages, 3, '统计必须如实反映展开到的子消息条数');
    assert.equal(round.forwardFailed, undefined, '没有失败就不该出现该字段');
    assert.deepEqual(stub.forwardCalls, ['fwd-1']);

    const row = db.raw.prepare('SELECT id, msg_type, forward_id, extra FROM messages').get() as {
      id: number;
      msg_type: string;
      forward_id: string;
      extra: string;
    };
    assert.equal(row.msg_type, 'forward');
    assert.equal(row.forward_id, 'fwd-1');

    const extra = JSON.parse(row.extra) as { forward: { id: string; count: number; messages: Array<Record<string, unknown>> } };
    assert.equal(extra.forward.id, 'fwd-1');
    assert.equal(extra.forward.count, 3);
    assert.equal(extra.forward.messages.length, 3);
    assert.equal(extra.forward.messages[0]?.['senderName'], '甲');
    assert.equal(extra.forward.messages[0]?.['text'], '外层带图');
    assert.equal(extra.forward.messages[1]?.['text'], '纯文本');
    assert.deepEqual(extra.forward.messages[0]?.['resourceRange'], [0, 1]);
    assert.equal(extra.forward.messages[1]?.['resourceRange'], undefined, '无资源的子消息不得占 ordinal');
    assert.deepEqual(extra.forward.messages[2]?.['resourceRange'], [1, 2]);

    // 归档回调确实收到了转发里的两张图（而不是只有父消息自身的资源）。
    assert.deepEqual(seen, ['http://x/a.png', 'http://x/b.png']);

    const links = (db.raw
      .prepare('SELECT ordinal, filename FROM message_media WHERE message_id = ? ORDER BY ordinal')
      .all(row.id) as Array<{ ordinal: number; filename: string }>).map((l) => ({ ordinal: l.ordinal, filename: l.filename }));
    assert.deepEqual(
      links,
      [
        { ordinal: 0, filename: 'a.png' },
        { ordinal: 1, filename: 'b.png' },
      ],
      'message_media.ordinal 必须与 extra.forward[*].resourceRange 的下标一致',
    );
    const mediaCount = db.raw.prepare('SELECT COUNT(*) AS n FROM media').get() as { n: number };
    assert.equal(mediaCount.n, 2, '转发里的媒体必须真的进 media 表');
  } finally {
    db.close();
  }
});

test('CollectRunner：forwardDepth=0 时完全不展开（保留修复前行为，且不发请求）', async () => {
  const stub = new StubCollector([parentMsg()], { 'fwd-1': [node({ text: '不该被拉到' })] });
  const db: Db = openDatabase({ path: ':memory:' });
  try {
    const runner = new CollectRunner({
      db,
      collector: stub,
      config: collectConfig({ forwardDepth: 0 }),
      logger,
      archiveMedia: archiveFn([]),
    });
    const round = await runner.runOnce();
    assert.equal(round.inserted, 1);
    assert.equal(round.forwardMessages, undefined);
    assert.equal(stub.forwardCalls.length, 0, 'forwardDepth=0 时不得发出 get_forward_msg');
    const row = db.raw.prepare('SELECT extra FROM messages').get() as { extra: string | null };
    assert.equal(row.extra, null, '未展开时不得写入 extra.forward');
  } finally {
    db.close();
  }
});

test('CollectRunner：转发拉取失败只降级告警 —— 消息照样入库、占位文本保留', async () => {
  const stub = new StubCollector([parentMsg({ text: '看看这个[CQ:forward,id=fwd-1]' })], {}, true);
  const db: Db = openDatabase({ path: ':memory:' });
  try {
    const runner = new CollectRunner({
      db,
      collector: stub,
      config: collectConfig(),
      logger,
      archiveMedia: archiveFn([]),
    });
    const round = await runner.runOnce();
    assert.equal(round.inserted, 1, '转发拉取失败绝不能连累消息本身');
    assert.equal(round.failed, 0);
    assert.equal(round.forwardFailed, 1);
    const row = db.raw.prepare('SELECT text, extra FROM messages').get() as { text: string; extra: string | null };
    assert.equal(row.text, '看看这个[CQ:forward,id=fwd-1]', '拉取失败时保留原始文本（含 CQ 占位），不得清空');
    assert.equal(row.extra, null, '失败时不得写出半截的 extra.forward');
  } finally {
    db.close();
  }
});

test('CollectRound 的可选字段不被无转发的轮次污染（既有断言兼容）', async () => {
  const stub = new StubCollector([parentMsg({ forwardId: undefined, msgType: 'text', text: '普通消息' })], {});
  const db: Db = openDatabase({ path: ':memory:' });
  try {
    const runner = new CollectRunner({ db, collector: stub, config: collectConfig(), logger });
    const round = await runner.runOnce();
    assert.equal('forwardMessages' in round, false);
    assert.equal('forwardFailed' in round, false);
  } finally {
    db.close();
  }
});

/* ------------------------------------------------------------------ */
/* 4. 与 media 目录无关的清理                                          */
/* ------------------------------------------------------------------ */

test('临时目录工具可用（占位：确保 forward 测试不泄漏文件）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-forward-'));
  rmSync(dir, { recursive: true, force: true });
  assert.ok(true);
});
