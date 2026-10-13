/**
 * 测试数据集生成器（**合成数据，不含任何真实聊天记录**）。
 *
 * 生成的目录结构：
 *   <out>/
 *     group-export.json       QCE 单文件 JSON 导出（群聊，含图片/视频/文件/引用/长消息）
 *     private-export.json     QCE 单文件 JSON 导出（私聊）
 *     chunked/
 *       manifest.json         QCE 分块导出清单
 *       chunks/chunk-000.jsonl
 *       chunks/chunk-001.jsonl
 *     legacy.txt              TXT 导出（含一行无法解析的内容用于容错测试）
 *     generic.jsonl           通用 JSONL（自定义格式接入示例）
 *     media/                  真实的小文件媒体（PNG/JPG/MP4 占位/GIF/TXT）
 *     expected.json           期望值（供一致性断言使用）
 *
 * 设计原则：
 *  - 全部内容由固定 seed 的伪随机数生成，**可复现**（同一 seed 生成字节级相同的文件）。
 *  - 覆盖所有消息类型与边界：超长消息、多段落、单字消息、空文本+资源、撤回消息、系统消息、
 *    重复消息（用于去重测试）、跨月时间范围（用于日期筛选测试）。
 *  - 媒体文件是**真实可解码**的（PNG 由代码手写字节生成，不依赖任何外部库）。
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** 确定性伪随机数（mulberry32）。 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 生成一个合法的最小 PNG（纯色，指定尺寸）。 */
export function makePng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 3);
    raw[rowStart] = 0; // filter type 0
    for (let x = 0; x < width; x++) {
      const p = rowStart + 1 + x * 3;
      raw[p] = rgb[0];
      raw[p + 1] = rgb[1];
      raw[p + 2] = rgb[2];
    }
  }
  const idat = zlibStore(raw);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcInput = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** 无压缩的 zlib 存储块（stored deflate）。 */
function zlibStore(data: Buffer): Buffer {
  const out: number[] = [0x78, 0x01];
  let offset = 0;
  while (offset < data.length) {
    const len = Math.min(65535, data.length - offset);
    const last = offset + len >= data.length ? 1 : 0;
    out.push(last, len & 0xff, (len >> 8) & 0xff, ~len & 0xff, (~len >> 8) & 0xff);
    for (let i = 0; i < len; i++) out.push(data[offset + i]!);
    offset += len;
  }
  const adler = adler32(data);
  out.push((adler >>> 24) & 0xff, (adler >>> 16) & 0xff, (adler >>> 8) & 0xff, adler & 0xff);
  return Buffer.from(out);
}

let CRC_TABLE: Uint32Array | null = null;
function crc32(buf: Buffer): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(buf: Buffer): number {
  let a = 1;
  let b = 0;
  for (const byte of buf) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** 生成一个极小的合法 GIF（1x1）。 */
function makeGif(): Buffer {
  return Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
}

/** 生成一个可被识别为视频容器的极小 MP4（ftyp box；不解码，仅用于归档与类型判定）。 */
function makeMp4(): Buffer {
  const ftyp = Buffer.alloc(24);
  ftyp.writeUInt32BE(24, 0);
  ftyp.write('ftyp', 4, 'ascii');
  ftyp.write('isom', 8, 'ascii');
  ftyp.writeUInt32BE(512, 12);
  ftyp.write('isomiso2', 16, 'ascii');
  return ftyp;
}

export interface FixtureOptions {
  outDir: string;
  seed?: number;
  /** 群聊消息条数。 */
  groupCount?: number;
  /** 私聊消息条数。 */
  privateCount?: number;
  /** 起始时间（毫秒）。 */
  startTs?: number;
}

export interface FixtureResult {
  dir: string;
  files: { groupJson: string; privateJson: string; chunkedDir: string; txt: string; genericJsonl: string; mediaDir: string; expected: string };
  counts: { groupMessages: number; privateMessages: number; duplicateInFile: number; mediaFiles: number; totalMessages: number };
  expected: ExpectedData;
}

export interface ExpectedData {
  groupMessages: number;
  privateMessages: number;
  totalMessages: number;
  /** 群聊里故意重复出现（同 id）的消息条数，导入后应被判重。 */
  duplicateInFile: number;
  mediaFiles: number;
  mediaMissingDeclared: number;
  firstTs: number;
  lastTs: number;
  /** 用于搜索一致性断言的唯一关键词。 */
  uniqueKeyword: string;
  /** 含唯一关键词的消息所在会话。 */
  uniqueKeywordSession: 'group' | 'private';
  longMessageLength: number;
}

const NAMES = ['张伟', '李娜', '王芳', '刘洋', '陈静', '杨帆', '赵磊', '黄敏', '周涛', '吴迪'];
const CITIES = ['北京', '上海', '广州', '深圳', '杭州', '成都', '武汉', '西安'];

const SENTENCES = [
  '今天天气不错，出去走走',
  '这个方案我看过了，基本同意',
  '晚点再说，我现在在开会',
  '收到，谢谢',
  '明天几点集合？',
  '刚看到消息，抱歉',
  '文件已经发你邮箱了',
  '哈哈哈这个太有意思了',
  '我这边网络有点问题',
  '周末有空一起吃饭吗',
  '好的没问题',
  '稍等我确认一下',
];

/**
 * 生成完整的测试数据集。已存在时先清空（只删自己生成的目录）。
 */
export function generateFixtures(opts: FixtureOptions): FixtureResult {
  const outDir = opts.outDir;
  const seed = opts.seed ?? 20261013;
  const groupCount = opts.groupCount ?? 240;
  const privateCount = opts.privateCount ?? 120;
  const startTs = opts.startTs ?? Date.UTC(2025, 11, 1, 1, 0, 0);
  const rand = rng(seed);

  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  const mediaDir = join(outDir, 'media');
  const chunkedDir = join(outDir, 'chunked', 'chunks');
  mkdirSync(mediaDir, { recursive: true });
  mkdirSync(chunkedDir, { recursive: true });

  /* ---- 媒体文件 ---- */
  const pngRed = makePng(8, 8, [220, 40, 40]);
  const pngBlue = makePng(12, 6, [30, 90, 220]);
  const gif = makeGif();
  const mp4 = makeMp4();
  const docTxt = Buffer.from('这是一个测试用的文档内容。\n第二行。\n', 'utf8');
  writeFileSync(join(mediaDir, 'photo-red.png'), pngRed);
  writeFileSync(join(mediaDir, 'photo-blue.png'), pngBlue);
  writeFileSync(join(mediaDir, 'anim.gif'), gif);
  writeFileSync(join(mediaDir, 'clip.mp4'), mp4);
  writeFileSync(join(mediaDir, 'report.txt'), docTxt);
  // 重复内容不同文件名：用于验证内容寻址去重（sha256 相同只存一份）
  writeFileSync(join(mediaDir, 'photo-red-copy.png'), pngRed);
  const mediaFiles = 6;

  const GROUP_UID = '700001';
  const GROUP_NAME = '测试技术交流群';
  const SELF_UID = 'u_self_0001';
  const SELF_UIN = '10001';
  const PEER_UID = 'u_friend_0002';
  const PEER_UIN = '10002';

  const uniqueKeyword = '蓝鲸计划ZZQ';
  const longText = `这是一条超长消息用于测试大字段处理。${'内容段落。'.repeat(300)}结尾标记LONGTAIL`;

  interface OutMsg {
    id: string;
    seq: string;
    timestamp: number;
    time: string;
    sender: { uid: string; uin?: string; name: string; nickname?: string; groupCard?: string };
    type: string;
    content: {
      text: string;
      elements?: Array<{ type: string; data: Record<string, unknown> }>;
      resources?: Array<Record<string, unknown>>;
      mentions?: Array<{ uid: string; name?: string; type?: string }>;
    };
    recalled?: boolean;
    system?: boolean;
    rawMessage?: unknown;
  }

  const fmt = (ts: number): string => {
    const d = new Date(ts);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };

  const groupMessages: OutMsg[] = [];
  let ts = startTs;
  let mediaIdx = 0;
  const mediaCycle = ['photo-red.png', 'photo-blue.png', 'anim.gif', 'clip.mp4', 'report.txt'];

  for (let i = 0; i < groupCount; i++) {
    ts += Math.floor(rand() * 3600_000) + 60_000; // 每 1 分钟 ~ 1 小时一条
    const senderIdx = Math.floor(rand() * NAMES.length);
    const isSelf = rand() < 0.25;
    const sender = isSelf
      ? { uid: SELF_UID, uin: SELF_UIN, name: '我', nickname: '我', groupCard: '我' }
      : { uid: `u_m${senderIdx}`, uin: `2000${senderIdx}`, name: NAMES[senderIdx]!, nickname: NAMES[senderIdx]!, groupCard: NAMES[senderIdx]! };
    const id = `grp-${String(i).padStart(6, '0')}`;
    const base: OutMsg = {
      id,
      seq: String(1000 + i),
      timestamp: ts,
      time: fmt(ts),
      sender,
      type: 'type_1',
      content: { text: '' },
    };

    // 每 17 条插入一个特殊类型，保证类型覆盖
    const kind = i % 17;
    if (kind === 3) {
      const file = mediaCycle[mediaIdx++ % mediaCycle.length]!;
      const isImage = /\.(png|gif)$/.test(file);
      const isVideo = /\.mp4$/.test(file);
      base.content.text = isImage ? '[图片]' : isVideo ? '[视频]' : `[文件] ${file}`;
      base.content.elements = [
        { type: 'text', data: { text: base.content.text } },
        { type: isImage ? 'image' : isVideo ? 'video' : 'file', data: { filename: file } },
      ];
      base.content.resources = [
        {
          type: isImage ? 'image' : isVideo ? 'video' : 'file',
          filename: file,
          size: isImage ? (file === 'photo-red.png' ? pngRed.length : file === 'photo-blue.png' ? pngBlue.length : gif.length) : isVideo ? mp4.length : docTxt.length,
          localPath: join(mediaDir, file),
          url: `https://example.invalid/qq/${file}`,
          ...(isImage ? { width: 8, height: 8 } : {}),
          ...(isVideo ? { duration: 12.5 } : {}),
        },
      ];
    } else if (kind === 5) {
      // 引用回复
      const target = groupMessages[Math.max(0, groupMessages.length - 1 - Math.floor(rand() * 3))];
      base.content.text = `回复：${target?.content.text.slice(0, 20) ?? ''}`;
      base.content.elements = [
        { type: 'reply', data: { id: target?.id ?? '', senderName: target?.sender.name ?? '' } },
        { type: 'text', data: { text: base.content.text } },
      ];
    } else if (kind === 7) {
      // @ 提及
      base.content.text = `@李娜 看一下这个`;
      base.content.elements = [
        { type: 'at', data: { uid: 'u_m1', name: '李娜' } },
        { type: 'text', data: { text: ' 看一下这个' } },
      ];
      base.content.mentions = [{ uid: 'u_m1', name: '李娜', type: 'user' }];
    } else if (kind === 9) {
      // 撤回消息
      base.content.text = '这条消息已被撤回';
      base.recalled = true;
    } else if (kind === 11) {
      // 系统消息
      base.content.text = '管理员开启了全员禁言';
      base.system = true;
      base.type = 'type_8';
    } else if (kind === 13) {
      // 表情
      base.content.text = '[表情]';
      base.content.elements = [{ type: 'face', data: { id: '178' } }];
    } else if (kind === 15) {
      // 唯一关键词（检索一致性断言用）
      base.content.text = `会议纪要：${uniqueKeyword} 的相关内容记录`;
    } else {
      const city = CITIES[Math.floor(rand() * CITIES.length)]!;
      base.content.text = `${SENTENCES[Math.floor(rand() * SENTENCES.length)]!}（${city}）`;
    }
    groupMessages.push(base);
  }

  // 超长消息 + 多段落
  ts += 120_000;
  groupMessages.push({
    id: 'grp-long-000001',
    seq: '9001',
    timestamp: ts,
    time: fmt(ts),
    sender: { uid: 'u_m2', uin: '20002', name: NAMES[2]!, nickname: NAMES[2]! },
    type: 'type_1',
    content: { text: longText, elements: [{ type: 'text', data: { text: longText } }] },
  });
  // 空文本 + 资源（只有图片没有文字）
  ts += 90_000;
  groupMessages.push({
    id: 'grp-media-000001',
    seq: '9002',
    timestamp: ts,
    time: fmt(ts),
    sender: { uid: SELF_UID, uin: SELF_UIN, name: '我' },
    type: 'type_2',
    content: {
      text: '',
      elements: [{ type: 'image', data: { filename: 'photo-blue.png' } }],
      resources: [
        { type: 'image', filename: 'photo-blue.png', size: pngBlue.length, localPath: join(mediaDir, 'photo-blue.png'), width: 12, height: 6 },
      ],
    },
  });
  // 媒体文件缺失：源文件根本不存在（用于「缺失标记、不得伪造」测试）
  ts += 90_000;
  groupMessages.push({
    id: 'grp-media-missing-000001',
    seq: '9003',
    timestamp: ts,
    time: fmt(ts),
    sender: { uid: 'u_m3', uin: '20003', name: NAMES[3]! },
    type: 'type_2',
    content: {
      text: '[图片]',
      elements: [{ type: 'image', data: { filename: 'gone-forever.png' } }],
      resources: [
        {
          type: 'image',
          filename: 'gone-forever.png',
          size: 4096,
          localPath: join(mediaDir, 'gone-forever.png'), // 故意不存在
          url: 'https://example.invalid/qq/gone-forever.png',
        },
      ],
    },
  });
  // 单字消息
  ts += 30_000;
  groupMessages.push({
    id: 'grp-single-000001',
    seq: '9004',
    timestamp: ts,
    time: fmt(ts),
    sender: { uid: 'u_m4', uin: '20004', name: NAMES[4]! },
    type: 'type_1',
    content: { text: '嗯' },
  });

  // 故意重复的消息（同 id 同内容出现两次）→ 导入后必须只留 1 条
  const duplicateInFile = 3;
  for (let d = 0; d < duplicateInFile; d++) {
    const dup = { ...groupMessages[d * 7]!, content: { ...groupMessages[d * 7]!.content } };
    groupMessages.push(dup);
  }

  /* ---- 私聊 ---- */
  const privateMessages: OutMsg[] = [];
  let pts = startTs + 1800_000;
  for (let i = 0; i < privateCount; i++) {
    pts += Math.floor(rand() * 1800_000) + 30_000;
    const isSelf = rand() < 0.5;
    const sender = isSelf
      ? { uid: SELF_UID, uin: SELF_UIN, name: '我' }
      : { uid: PEER_UID, uin: PEER_UIN, name: '小王', nickname: '小王', remark: '同事小王' };
    const text =
      i === 5
        ? `私聊里也提到了${uniqueKeyword}这个词`
        : SENTENCES[Math.floor(rand() * SENTENCES.length)]!;
    privateMessages.push({
      id: `pvt-${String(i).padStart(6, '0')}`,
      seq: String(5000 + i),
      timestamp: pts,
      time: fmt(pts),
      sender,
      type: 'type_1',
      content: { text },
    });
  }

  const groupJson = join(outDir, 'group-export.json');
  const privateJson = join(outDir, 'private-export.json');
  const lastTs = Math.max(groupMessages[groupMessages.length - 1]!.timestamp, privateMessages[privateMessages.length - 1]!.timestamp);

  writeFileSync(
    groupJson,
    JSON.stringify(
      {
        metadata: {
          exportTime: fmt(Date.now()),
          version: '6.3.2',
          generator: 'qq-chat-exporter',
          format: 'JSON',
          totalMessages: groupMessages.length,
          note: '合成测试数据，非真实聊天记录',
        },
        chatInfo: {
          name: GROUP_NAME,
          type: 'group',
          avatar: '',
          participantCount: 128,
          selfUid: SELF_UID,
          selfUin: SELF_UIN,
          selfName: '我',
          peerUid: GROUP_UID,
        },
        statistics: { messageCount: groupMessages.length, senderCount: NAMES.length, firstTime: fmt(startTs), lastTime: fmt(lastTs) },
        messages: groupMessages,
      },
      null,
      2,
    ),
    'utf8',
  );

  writeFileSync(
    privateJson,
    JSON.stringify(
      {
        metadata: { exportTime: fmt(Date.now()), version: '6.3.2', generator: 'qq-chat-exporter', format: 'JSON' },
        chatInfo: {
          name: '小王',
          type: 'private',
          selfUid: SELF_UID,
          selfUin: SELF_UIN,
          selfName: '我',
          peerUid: PEER_UID,
          peerUin: PEER_UIN,
        },
        statistics: { messageCount: privateMessages.length },
        messages: privateMessages,
      },
      null,
      2,
    ),
    'utf8',
  );

  /* ---- 分块 JSONL ---- */
  const perChunk = Math.ceil(groupMessages.length / 2);
  const chunks: string[] = [];
  for (let c = 0; c < 2; c++) {
    const slice = groupMessages.slice(c * perChunk, (c + 1) * perChunk);
    if (slice.length === 0) continue;
    const name = `chunk-${String(c).padStart(3, '0')}.jsonl`;
    const content = slice.map((m) => JSON.stringify({ chatInfo: { name: GROUP_NAME, type: 'group', peerUid: GROUP_UID, selfUid: SELF_UID }, message: m })).join('\n');
    writeFileSync(join(chunkedDir, name), `${content}\n`, 'utf8');
    chunks.push(name);
  }
  writeFileSync(
    join(outDir, 'chunked', 'manifest.json'),
    JSON.stringify(
      {
        version: '6.3.2',
        chatInfo: { name: GROUP_NAME, type: 'group', peerUid: GROUP_UID, selfUid: SELF_UID, selfName: '我' },
        totalMessages: groupMessages.length,
        chunks,
        chunkFormat: 'jsonl',
      },
      null,
      2,
    ),
    'utf8',
  );

  /* ---- TXT ---- */
  const txtLines: string[] = [];
  txtLines.push('聊天记录导出（合成测试数据）');
  txtLines.push(`群聊：${GROUP_NAME}`);
  txtLines.push('='.repeat(40));
  txtLines.push('这一行是无法识别的垃圾内容，导入器必须容错而不是崩溃');
  for (let i = 0; i < 40; i++) {
    const m = groupMessages[i]!;
    txtLines.push(`[${m.time}] ${m.sender.name}(${m.sender.uin ?? ''}): ${m.content.text}`);
  }
  const txt = join(outDir, 'legacy.txt');
  writeFileSync(txt, `${txtLines.join('\n')}\n`, 'utf8');

  /* ---- 通用 JSONL ---- */
  const genericJsonl = join(outDir, 'generic.jsonl');
  const genericLines = privateMessages.slice(0, 30).map((m) =>
    JSON.stringify({
      chatType: 'private',
      peerUid: PEER_UID,
      peerName: '小王',
      msgKey: m.id,
      ts: m.timestamp,
      senderUid: m.sender.uid,
      senderName: m.sender.name,
      direction: m.sender.uid === SELF_UID ? 'out' : 'in',
      type: 'text',
      text: m.content.text,
    }),
  );
  writeFileSync(genericJsonl, `${genericLines.join('\n')}\n`, 'utf8');

  const expected: ExpectedData = {
    groupMessages: groupMessages.length,
    privateMessages: privateMessages.length,
    totalMessages: groupMessages.length + privateMessages.length,
    duplicateInFile,
    mediaFiles,
    mediaMissingDeclared: 1,
    firstTs: startTs,
    lastTs,
    uniqueKeyword,
    uniqueKeywordSession: 'group',
    longMessageLength: longText.length,
  };
  const expectedPath = join(outDir, 'expected.json');
  writeFileSync(expectedPath, JSON.stringify(expected, null, 2), 'utf8');

  return {
    dir: outDir,
    files: { groupJson, privateJson, chunkedDir, txt, genericJsonl, mediaDir, expected: expectedPath },
    counts: {
      groupMessages: groupMessages.length,
      privateMessages: privateMessages.length,
      duplicateInFile,
      mediaFiles,
      totalMessages: groupMessages.length + privateMessages.length,
    },
    expected,
  };
}

if (process.argv[1] && process.argv[1].endsWith('generate.ts')) {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(
      '用法：node --experimental-strip-types tests/fixtures/generate.ts [输出目录]\n' +
        '  输出目录默认 ./tests/.fixtures；内容为固定种子生成，不含任何真实聊天记录。\n' +
        '  退出码：0 成功；2 参数错误。\n',
    );
    process.exit(0);
  }
  // 以前这里直接取 argv[2]，于是 `generate.ts --help` 会在当前目录创建一个名叫
  // `--help` 的输出目录。未知选项必须显式报错，不能当成路径。
  const unknown = argv.find((a) => a.startsWith('-'));
  if (unknown !== undefined) {
    process.stderr.write(`未知参数：${unknown}（用 --help 查看用法）\n`);
    process.exit(2);
  }
  const out = argv[0] ?? './tests/.fixtures';
  const res = generateFixtures({ outDir: out });
  process.stdout.write(
    `测试数据已生成到 ${res.dir}\n` +
      `  群聊消息 ${res.counts.groupMessages}（其中故意重复 ${res.counts.duplicateInFile} 条）\n` +
      `  私聊消息 ${res.counts.privateMessages}\n` +
      `  媒体文件 ${res.counts.mediaFiles} 个\n` +
      `  期望值 ${res.files.expected}\n`,
  );
}
