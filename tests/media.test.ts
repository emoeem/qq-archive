/**
 * `MediaArchiver` 单元测试：内容寻址、原子落盘、去重、缺失标记、校验、缩略图。
 *
 * 所有媒体都是现场构造的极小合成文件（PNG/GIF/二进制），写进 `mkdtempSync()` 临时目录。
 * 网络下载用注入的 `fetchImpl` 假实现，绝不真的发请求。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLogger } from '../packages/core/src/index.ts';
import type { MediaRow } from '../packages/db/src/index.ts';
import {
  MediaArchiver,
  type FetchLike,
  type HttpResponseLike,
} from '../packages/import/src/index.ts';
import { makePng as makeRealPng } from './fixtures/generate.ts';

const tmpDirs: string[] = [];

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs.length = 0;
});

const logger = createLogger({ console: false, level: 'error' }).child('media-test');

interface ArchiverOverrides {
  maxBytes?: number;
  fetchImpl?: FetchLike;
  ffmpegPath?: string;
  resume?: boolean;
  now?: () => Date;
}

function archiverWith(root: string, opts: ArchiverOverrides = {}): MediaArchiver {
  return new MediaArchiver({ root, logger, ...opts });
}

/** 写一个内容固定的合成「类 PNG」字节串（只用于内容寻址/校验，不要求可解码）。 */
function makeBytes(dir: string, name: string, size = 512, fill = 0x7f): string {
  const buffer = Buffer.alloc(size, fill);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  const file = join(dir, name);
  writeFileSync(file, buffer);
  return file;
}

function sha256Of(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/** 构造一个只服务固定字节的假 fetch；`contentLength: null` 表示不返回该响应头。 */
function fakeFetch(
  bytes: Buffer,
  init: { status?: number; contentLength?: number | null } = {},
): FetchLike {
  const status = init.status ?? 200;
  const contentLength = init.contentLength === undefined ? bytes.length : init.contentLength;
  return async (): Promise<HttpResponseLike> => {
    let sent = false;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (name: string) =>
          contentLength !== null && name.toLowerCase() === 'content-length'
            ? String(contentLength)
            : null,
      },
      body: {
        getReader: () => ({
          read: async () => {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: new Uint8Array(bytes) };
          },
          cancel: async () => undefined,
        }),
      },
    };
  };
}

/**
 * 可断点续传的假 fetch：
 *  - 识别 `Range: bytes=N-`，默认回 `206` + `Content-Range`（`ignoreRange` 时回 200 整包）；
 *  - `failAfter` 让「第一次」请求写出 N 字节后抛错，用来制造中断残片；
 *  - `rejectRange` 让带 Range 的请求回 416；
 *  - `calls` 记录每次请求的 headers，供断言 Range / If-Range。
 */
function rangeAwareFetch(
  bytes: Buffer,
  opts: {
    ignoreRange?: boolean;
    rejectRange?: boolean;
    failAfter?: number;
    etag?: string;
    lastModified?: string;
  } = {},
): { fetchImpl: FetchLike; calls: Array<Record<string, string> | undefined> } {
  const calls: Array<Record<string, string> | undefined> = [];
  let callCount = 0;
  const fetchImpl: FetchLike = async (_url, init) => {
    calls.push(init.headers);
    callCount += 1;
    const rangeHeader = init.headers?.['range'];
    const m = rangeHeader ? /^bytes=(\d+)-$/.exec(rangeHeader) : null;
    if (m && opts.rejectRange) {
      return {
        ok: false,
        status: 416,
        headers: {
          get: (name: string) =>
            name.toLowerCase() === 'content-range' ? `bytes */${bytes.length}` : null,
        },
        body: null,
      };
    }
    const requestedStart = m ? Number(m[1]) : 0;
    const partial = m !== null && !opts.ignoreRange;
    const start = partial ? requestedStart : 0;
    const slice = bytes.subarray(start);
    const headers: Record<string, string> = { 'content-length': String(slice.length) };
    if (partial) headers['content-range'] = `bytes ${start}-${bytes.length - 1}/${bytes.length}`;
    if (opts.etag !== undefined) headers['etag'] = opts.etag;
    if (opts.lastModified !== undefined) headers['last-modified'] = opts.lastModified;
    const failThisCall = opts.failAfter !== undefined && callCount === 1;
    return {
      ok: true,
      status: partial ? 206 : 200,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      body: {
        getReader: () => {
          let stage = 0;
          return {
            read: async () => {
              if (failThisCall) {
                if (stage === 0) {
                  stage = 1;
                  return { done: false, value: new Uint8Array(bytes.subarray(0, opts.failAfter!)) };
                }
                throw new Error('模拟连接中断');
              }
              if (stage === 0) {
                stage = 1;
                return { done: false, value: new Uint8Array(slice) };
              }
              return { done: true, value: undefined };
            },
            cancel: async () => undefined,
          };
        },
      },
    };
  };
  return { fetchImpl, calls };
}

/* --------------------------------------------------------------- 本地文件 */

test('archive(localPath)：内容寻址落盘 + sha256/size 正确 + 中转目录清空', async () => {
  const root = tmp('qq-media-root-');
  const srcDir = tmp('qq-media-src-');
  const src = makeBytes(srcDir, 'photo.png', 777, 0x11);
  const bytes = readFileSync(src);
  const a = archiverWith(root);

  const outcome = await a.archive({ kind: 'image', localPath: src, filename: 'photo.png' });
  assert.equal(outcome.status, 'present');
  const sha = sha256Of(bytes);
  assert.equal(outcome.media.sha256, sha);
  assert.equal(outcome.media.size, bytes.length);
  assert.equal(outcome.media.kind, 'image');
  assert.equal(outcome.media.ext, 'png');
  assert.equal(outcome.media.status, 'present');
  assert.equal(outcome.media.originPath, src);
  assert.match(outcome.media.relPath, /^image\/\d{4}\/\d{2}\/[0-9a-f]{2}\/[0-9a-f]{64}\.png$/);
  // 路径里的 sha 前缀必须来自内容
  assert.equal(outcome.media.relPath.split('/')[3], sha.slice(0, 2));
  assert.equal(outcome.media.relPath.split('/')[4], `${sha}.png`);

  const stored = join(root, outcome.media.relPath);
  assert.ok(existsSync(stored), '归档文件必须存在');
  assert.deepEqual(readFileSync(stored), bytes, '归档内容必须与源字节一致');

  const incoming = join(root, '.incoming');
  if (existsSync(incoming)) assert.deepEqual(readdirSync(incoming), [], '不得残留 .part');
});

test('archive：同内容不同文件名 → 同一路径去重，只落一份文件', async () => {
  const root = tmp('qq-media-dedupe-');
  const srcDir = tmp('qq-media-src-');
  const a1 = makeBytes(srcDir, 'one.png', 256, 0x42);
  const a2 = makeBytes(srcDir, 'two-copy.png', 256, 0x42);
  assert.deepEqual(readFileSync(a1), readFileSync(a2), '夹具前提：两份内容完全相同');

  const a = archiverWith(root);
  const first = await a.archive({ kind: 'image', localPath: a1, filename: 'one.png' });
  const second = await a.archive({ kind: 'image', localPath: a2, filename: 'two-copy.png' });
  assert.equal(first.status, 'present');
  assert.equal(second.status, 'present');
  assert.equal(first.media.sha256, second.media.sha256);
  assert.equal(first.media.relPath, second.media.relPath);
  // 归档目录里该 sha 只有一份文件
  const dir = join(root, 'image', first.media.relPath.split('/').slice(1, 4).join('/'));
  const files = readdirSync(dir);
  assert.deepEqual(files, [`${first.media.sha256}.png`]);
});

test('archive：localPath 不存在且没有 url → missing、不落占位文件、原因可读', async () => {
  const root = tmp('qq-media-missing-');
  const a = archiverWith(root);
  const outcome = await a.archive({
    kind: 'image',
    localPath: join(root, 'nope', 'gone.png'),
    filename: 'gone.png',
  });
  assert.equal(outcome.status, 'missing');
  assert.equal(outcome.media.status, 'missing');
  assert.ok((outcome.reason ?? '').length > 0);
  assert.ok((outcome.media.failReason ?? '').length > 0);
  assert.equal(existsSync(join(root, outcome.media.relPath)), false, '不得生成占位文件');
  assert.equal(outcome.media.size, 0);

  // 相同输入的 missing 描述符必须稳定（重复导入幂等的前提）
  const again = await a.archive({
    kind: 'image',
    localPath: join(root, 'nope', 'gone.png'),
    filename: 'gone.png',
  });
  assert.equal(again.media.sha256, outcome.media.sha256);
  assert.equal(again.media.relPath, outcome.media.relPath);
});

test('archive：完全没有任何来源 → missing 且原因说明无可用来源', async () => {
  const root = tmp('qq-media-nosource-');
  const a = archiverWith(root);
  const outcome = await a.archive({ kind: 'file', filename: 'x.bin' });
  assert.equal(outcome.status, 'missing');
  assert.equal(existsSync(join(root, outcome.media.relPath)), false);
  assert.match(outcome.reason ?? '', /无可用来源|不可读/);
});

/* --------------------------------------------------------------- 网络下载 */

test('archive(url)：下载成功 → present，字节与远端一致', async () => {
  const root = tmp('qq-media-url-');
  const bytes = Buffer.from('合成下载内容-synthetic-download', 'utf8');
  const a = archiverWith(root, { fetchImpl: fakeFetch(bytes) });
  const outcome = await a.archive({
    kind: 'file',
    url: 'https://example.invalid/qq/down.txt',
    filename: 'down.txt',
  });
  assert.equal(outcome.status, 'present');
  assert.equal(outcome.media.sha256, sha256Of(bytes));
  assert.equal(outcome.media.size, bytes.length);
  assert.deepEqual(readFileSync(join(root, outcome.media.relPath)), bytes);
});

test('archive(url)：404 → missing 且不落文件', async () => {
  const root = tmp('qq-media-404-');
  const a = archiverWith(root, { fetchImpl: fakeFetch(Buffer.from('x'), { status: 404 }) });
  const outcome = await a.archive({ kind: 'image', url: 'https://example.invalid/qq/404.png', filename: '404.png' });
  assert.equal(outcome.status, 'missing');
  assert.match(outcome.reason ?? '', /404/);
  assert.equal(existsSync(join(root, outcome.media.relPath)), false);
});

test('archive(url)：协议不允许 / URL 非法 → missing', async () => {
  const root = tmp('qq-media-proto-');
  const a = archiverWith(root, { fetchImpl: fakeFetch(Buffer.from('x')) });
  const ftp = await a.archive({ kind: 'file', url: 'ftp://example.invalid/a.bin', filename: 'a.bin' });
  assert.equal(ftp.status, 'missing');
  assert.match(ftp.reason ?? '', /协议不允许/);
  const broken = await a.archive({ kind: 'file', url: 'not a url', filename: 'b.bin' });
  assert.equal(broken.status, 'missing');
});

/* --------------------------------------------------------------- 上限 / 校验 */

test('maxBytes：本地文件超限 → missing，且源文件不被破坏', async () => {
  const root = tmp('qq-media-max-');
  const srcDir = tmp('qq-media-src-');
  const src = makeBytes(srcDir, 'big.png', 4096, 0x22);
  const before = readFileSync(src);
  const a = archiverWith(root, { maxBytes: 1024 });
  const outcome = await a.archive({ kind: 'image', localPath: src, filename: 'big.png' });
  assert.equal(outcome.status, 'missing');
  assert.match(outcome.reason ?? '', /超过上限|上限/);
  assert.equal(existsSync(join(root, outcome.media.relPath)), false);
  assert.deepEqual(readFileSync(src), before, '源文件不得被改动');
  const incoming = join(root, '.incoming');
  if (existsSync(incoming)) assert.deepEqual(readdirSync(incoming), [], '超限必须清掉 .part');
});

test('maxBytes：下载超限 → missing，且不留 .part（流式与 Content-Length 两条路径）', async () => {
  const root = tmp('qq-media-max-url-');
  // ① 流式计数超限（没有 Content-Length 可依赖）
  const streaming = archiverWith(root, {
    maxBytes: 8,
    fetchImpl: fakeFetch(Buffer.alloc(64, 3), { contentLength: null }),
  });
  const first = await streaming.archive({ kind: 'file', url: 'https://example.invalid/qq/big.bin', filename: 'big.bin' });
  assert.equal(first.status, 'missing');
  assert.match(first.reason ?? '', /超过上限/);
  assert.equal(existsSync(join(root, first.media.relPath)), false);

  // ② 靠 Content-Length 提前拒绝（连 body 都不读）
  const declared = archiverWith(root, { maxBytes: 8, fetchImpl: fakeFetch(Buffer.alloc(64, 3)) });
  const second = await declared.archive({ kind: 'file', url: 'https://example.invalid/qq/big2.bin', filename: 'big2.bin' });
  assert.equal(second.status, 'missing');
  assert.match(second.reason ?? '', /Content-Length/);

  const incoming = join(root, '.incoming');
  if (existsSync(incoming)) assert.deepEqual(readdirSync(incoming), []);
});

test('verify()：present / corrupt / missing / 路径越界', async () => {
  const root = tmp('qq-media-verify-');
  const srcDir = tmp('qq-media-src-');
  const src = makeBytes(srcDir, 'v.png', 300, 0x33);
  const a = archiverWith(root);
  const outcome = await a.archive({ kind: 'image', localPath: src, filename: 'v.png' });
  const sha = outcome.media.sha256;

  assert.equal(a.verify(outcome.media.relPath, sha), 'present');
  assert.equal(a.verify(outcome.media.relPath, sha.toUpperCase()), 'present');
  assert.equal(a.verify(outcome.media.relPath, 'f'.repeat(64)), 'corrupt');
  assert.equal(a.verify('image/2020/01/ab/deadbeef.png', sha), 'missing');
  assert.equal(a.verify('../../etc/passwd', sha), 'missing', '路径越界必须判 missing');

  // 篡改后必须变 corrupt
  writeFileSync(join(root, outcome.media.relPath), Buffer.from('tampered'));
  assert.equal(a.verify(outcome.media.relPath, sha), 'corrupt');
});

/* --------------------------------------------------------------- 缩略图 */

test('ensureThumb：图/视频可生成；不支持的类型与非 present 状态返回 null', async () => {
  const root = tmp('qq-media-thumb-');
  const srcDir = tmp('qq-media-src-');
  // 缩略图走真实 ffmpeg 解码，必须是合法 PNG（fixtures 里的手写 PNG 编码器）
  const src = join(srcDir, 't.png');
  writeFileSync(src, makeRealPng(16, 16, [90, 120, 200]));
  const a = archiverWith(root);
  const outcome = await a.archive({ kind: 'image', localPath: src, filename: 't.png' });
  const media = {
    id: 1,
    sha256: outcome.media.sha256,
    kind: outcome.media.kind,
    size: outcome.media.size,
    mime: outcome.media.mime ?? null,
    ext: outcome.media.ext ?? null,
    relPath: outcome.media.relPath,
    width: null,
    height: null,
    duration: null,
    status: outcome.media.status ?? 'present',
    originUrl: null,
    originPath: null,
    failReason: null,
    refCount: 0,
    createdAt: new Date(0).toISOString(),
    verifiedAt: null,
    thumbPath: null,
  } satisfies MediaRow;

  const hasFfmpeg = await a.hasFfmpeg();
  const thumb = await a.ensureThumb(media);
  if (hasFfmpeg) {
    assert.ok(thumb !== null, '本机有 ffmpeg 时必须能生成缩略图');
    assert.match(thumb!, /^thumbs\/image\/[0-9a-f]{2}\/[0-9a-f]{64}\.jpg$/);
    assert.ok(existsSync(join(root, thumb!)), '缩略图文件必须存在');
  } else {
    assert.equal(thumb, null, '没有 ffmpeg 时必须返回 null 而不是抛错');
  }

  // 不支持的类型
  assert.equal(await a.ensureThumb({ ...media, kind: 'file' }), null);
  // 非 present 状态
  assert.equal(await a.ensureThumb({ ...media, status: 'missing' }), null);
});

test('ensureThumb：ffmpeg 不存在时返回 null（可选依赖，绝不抛错）', async () => {
  const root = tmp('qq-media-noffmpeg-');
  const srcDir = tmp('qq-media-src-');
  const src = makeBytes(srcDir, 'n.png', 128, 0x66);
  const a = archiverWith(root, { ffmpegPath: join(root, 'no-such-ffmpeg-binary') });
  const outcome = await a.archive({ kind: 'image', localPath: src, filename: 'n.png' });
  const media = {
    id: 1,
    sha256: outcome.media.sha256,
    kind: outcome.media.kind,
    size: outcome.media.size,
    mime: null,
    ext: 'png',
    relPath: outcome.media.relPath,
    width: null,
    height: null,
    duration: null,
    status: 'present',
    originUrl: null,
    originPath: null,
    failReason: null,
    refCount: 0,
    createdAt: new Date(0).toISOString(),
    verifiedAt: null,
    thumbPath: null,
  } satisfies MediaRow;
  assert.equal(await a.ensureThumb(media), null);
  // 允许留下空的 thumbs 目录，但绝不允许留下缩略图文件
  assert.equal(existsSync(join(root, 'thumbs', 'image', media.sha256.slice(0, 2), `${media.sha256}.jpg`)), false, '失败不得留下缩略图文件');
});

test('archiveAll：批量归档返回与候选一一对应', async () => {
  const root = tmp('qq-media-all-');
  const srcDir = tmp('qq-media-src-');
  const p1 = makeBytes(srcDir, 'a.png', 128, 0x77);
  const p2 = makeBytes(srcDir, 'b.png', 128, 0x88);
  const a = archiverWith(root);
  const outcomes = await a.archiveAll([
    { kind: 'image', localPath: p1, filename: 'a.png' },
    { kind: 'image', localPath: p2, filename: 'b.png' },
    { kind: 'image', localPath: join(root, 'x', 'gone.png'), filename: 'gone.png' },
  ]);
  assert.equal(outcomes.length, 3);
  assert.deepEqual(
    outcomes.map((o) => o.status),
    ['present', 'present', 'missing'],
  );
  assert.notEqual(outcomes[0]!.media.sha256, outcomes[1]!.media.sha256);
});

/* ------------------------------------- 缩略图链路（回归：曾经是死代码） */

test('archive()：present 的图片/视频必须就地产出 thumbPath', async () => {
  const root = tmp('qq-media-thumb-wire-');
  const srcDir = tmp('qq-media-src-');
  // 用「假 ffmpeg」脚本代替真实二进制：任何机器上都能跑，于是这条用例不会因为
  // CI 没装 ffmpeg 而被跳过 —— 回归点（archive() 从不生成缩略图）必须无条件被钉住。
  // 注意要处理 `-version`：ensureThumb 探测可用性时它会是最后一个参数。
  const fake = join(root, 'fake-ffmpeg.sh');
  writeFileSync(
    fake,
    '#!/bin/sh\n' +
      'for last; do :; done\n' +
      'case "$last" in\n' +
      '  -version) echo "fake-ffmpeg 1.0"; exit 0 ;;\n' +
      'esac\n' +
      'printf "\\377\\330\\377\\340fake-jpeg" > "$last"\n',
    'utf8',
  );
  chmodSync(fake, 0o755);

  const a = archiverWith(root, { ffmpegPath: fake });
  // 显式断言探测为真：否则「假 ffmpeg 根本没被执行」会让后面的断言失去意义
  assert.equal(await a.hasFfmpeg(), true, '假 ffmpeg 必须被探测为可用');

  const src = join(srcDir, 'w.png');
  writeFileSync(src, makeRealPng(16, 16, [10, 20, 30]));
  const outcome = await a.archive({ kind: 'image', localPath: src, filename: 'w.png' });
  assert.equal(outcome.status, 'present');
  const thumb = outcome.media.thumbPath ?? null;
  assert.ok(
    thumb !== null,
    'archive() 必须产出 thumbPath，否则 db.upsertMedia 永远写不进 media.thumb_path',
  );
  assert.match(thumb!, /^thumbs\/image\/[0-9a-f]{2}\/[0-9a-f]{64}\.jpg$/);
  assert.ok(existsSync(join(root, thumb!)), '缩略图文件必须真的落盘');

  // 视频同样抽帧
  const vid = join(srcDir, 'w.mp4');
  writeFileSync(vid, Buffer.alloc(2048, 0x07));
  const vOutcome = await a.archive({ kind: 'video', localPath: vid, filename: 'w.mp4' });
  assert.equal(vOutcome.status, 'present');
  assert.ok((vOutcome.media.thumbPath ?? null) !== null, '视频必须产出 thumbPath');

  // 不支持缩略图的类型不得凭空产出
  const fileOutcome = await a.archive({ kind: 'file', localPath: vid, filename: 'w.bin' });
  assert.equal(fileOutcome.status, 'present');
  assert.equal(fileOutcome.media.thumbPath ?? null, null, 'file 类型不该有 thumbPath');
});

/* --------------------------------------------------------- HTTP 断点续传 */

const resumeUrls = {
  basic: 'https://example.invalid/qq/resume.bin',
  ignore: 'https://example.invalid/qq/ignore-range.bin',
  ifRange: 'https://example.invalid/qq/if-range.bin',
  max: 'https://example.invalid/qq/resume-max.bin',
  fresh: 'https://example.invalid/qq/fresh.bin',
  sidecar: 'https://example.invalid/qq/sidecar.bin',
  reject: 'https://example.invalid/qq/reject.bin',
} as const;

/** `.incoming` 下的文件列表（目录不存在按空处理）。 */
function incomingFiles(root: string): string[] {
  const incoming = join(root, '.incoming');
  return existsSync(incoming) ? readdirSync(incoming) : [];
}

test('续传：写到 N 字节后中断 → 重试发 Range → sha256 与完整载荷一致', async () => {
  const root = tmp('qq-media-resume-');
  const payload = Buffer.from('断点续传-'.repeat(200) + 'END', 'utf8');
  const failAfter = 300;

  // 第一次：写出 300 字节后连接中断 → missing，残片与 sidecar 保留
  const first = rangeAwareFetch(payload, { failAfter });
  const interrupted = await archiverWith(root, { fetchImpl: first.fetchImpl }).archive({
    kind: 'file',
    url: resumeUrls.basic,
    filename: 'resume.bin',
  });
  assert.equal(interrupted.status, 'missing');
  assert.match(interrupted.reason ?? '', /下载失败|模拟连接中断/);
  const files = incomingFiles(root);
  assert.equal(files.filter((f) => f.endsWith('.part')).length, 1, '中断后必须保留 .part');
  assert.equal(files.filter((f) => f.endsWith('.part.meta.json')).length, 1, '中断后必须保留 sidecar');

  // 第二次：应带 Range: bytes=300-，服务端 206 返回剩余部分
  const second = rangeAwareFetch(payload, { etag: '"v1"' });
  const outcome = await archiverWith(root, { fetchImpl: second.fetchImpl }).archive({
    kind: 'file',
    url: resumeUrls.basic,
    filename: 'resume.bin',
  });
  assert.equal(outcome.status, 'present');
  assert.equal(second.calls.length, 1, '续传应当只发一次请求');
  assert.equal(second.calls[0]?.['range'], `bytes=${failAfter}-`, '重试必须从断点续传');
  assert.equal(outcome.media.sha256, sha256Of(payload), 'sha256 必须覆盖完整重组文件');
  assert.equal(outcome.media.size, payload.length);
  assert.deepEqual(readFileSync(join(root, outcome.media.relPath)), payload);
  assert.deepEqual(incomingFiles(root), [], '成功后不得残留 .part 或 sidecar');
});

test('续传：服务端返回 200 忽略 Range → 截断重头下载，文件仍正确', async () => {
  const root = tmp('qq-media-ignore-range-');
  const payload = Buffer.from('IGNORE-RANGE-'.repeat(120), 'utf8');
  const failAfter = 200;

  // 先制造残片
  const seed = rangeAwareFetch(payload, { failAfter });
  await archiverWith(root, { fetchImpl: seed.fetchImpl }).archive({
    kind: 'file',
    url: resumeUrls.ignore,
    filename: 'ignore.bin',
  });
  assert.ok(incomingFiles(root).some((f) => f.endsWith('.part')), '前提：必须有残片才能验证「忽略 Range」');

  // 第二次：即便带了 Range，服务端也回 200 + 完整 body
  const ignoring = rangeAwareFetch(payload, { ignoreRange: true });
  const outcome = await archiverWith(root, { fetchImpl: ignoring.fetchImpl }).archive({
    kind: 'file',
    url: resumeUrls.ignore,
    filename: 'ignore.bin',
  });
  assert.equal(outcome.status, 'present');
  assert.equal(ignoring.calls[0]?.['range'], `bytes=${failAfter}-`, '续传时确实发了 Range');
  assert.equal(outcome.media.sha256, sha256Of(payload), '200 回包必须整体重写而不是拼接');
  assert.equal(outcome.media.size, payload.length);
  assert.deepEqual(readFileSync(join(root, outcome.media.relPath)), payload);
  assert.deepEqual(incomingFiles(root), []);
});

test('续传：已知 etag 时发出 If-Range，防止远端已变还拼残片', async () => {
  const root = tmp('qq-media-if-range-');
  const payload = Buffer.from('IF-RANGE-'.repeat(150), 'utf8');
  const failAfter = 150;
  const etag = '"etag-v1"';

  const seed = rangeAwareFetch(payload, { failAfter, etag });
  await archiverWith(root, { fetchImpl: seed.fetchImpl }).archive({
    kind: 'file',
    url: resumeUrls.ifRange,
    filename: 'if-range.bin',
  });

  const second = rangeAwareFetch(payload, { etag });
  const outcome = await archiverWith(root, { fetchImpl: second.fetchImpl }).archive({
    kind: 'file',
    url: resumeUrls.ifRange,
    filename: 'if-range.bin',
  });
  assert.equal(outcome.status, 'present');
  assert.equal(second.calls[0]?.['range'], `bytes=${failAfter}-`);
  assert.equal(second.calls[0]?.['if-range'], etag, '有强校验器时必须带 If-Range');
});

test('续传：无 etag 时退回 last-modified 作为 If-Range', async () => {
  const root = tmp('qq-media-if-range-lm-');
  const payload = Buffer.from('LAST-MODIFIED-'.repeat(80), 'utf8');
  const failAfter = 120;
  const lastModified = 'Wed, 21 Oct 2015 07:28:00 GMT';

  const seed = rangeAwareFetch(payload, { failAfter, lastModified });
  await archiverWith(root, { fetchImpl: seed.fetchImpl }).archive({
    kind: 'file',
    url: resumeUrls.sidecar,
    filename: 'sidecar.bin',
  });

  const second = rangeAwareFetch(payload, { lastModified });
  await archiverWith(root, { fetchImpl: second.fetchImpl }).archive({
    kind: 'file',
    url: resumeUrls.sidecar,
    filename: 'sidecar.bin',
  });
  assert.equal(second.calls[0]?.['if-range'], lastModified);
});

test('续传状态 sidecar：记录 url / 最终 url / etag / last-modified / 总大小 / 已写入字节数', async () => {
  const root = tmp('qq-media-sidecar-state-');
  const payload = Buffer.from('SIDECAR-'.repeat(100), 'utf8');
  const failAfter = 128;
  const etag = '"e1"';
  const lastModified = 'Wed, 21 Oct 2015 07:28:00 GMT';

  const f = rangeAwareFetch(payload, { failAfter, etag, lastModified });
  await archiverWith(root, { fetchImpl: f.fetchImpl }).archive({
    kind: 'file',
    url: resumeUrls.sidecar,
    filename: 'sidecar.bin',
  });

  const metaName = incomingFiles(root).find((n) => n.endsWith('.part.meta.json'));
  assert.ok(metaName, 'sidecar 必须存在');
  const state = JSON.parse(readFileSync(join(root, '.incoming', metaName!), 'utf8')) as Record<
    string,
    unknown
  >;
  assert.equal(state.url, resumeUrls.sidecar);
  assert.equal(state.finalUrl, resumeUrls.sidecar, '假 fetch 无最终 url 时应回退为请求 url');
  assert.equal(state.etag, etag);
  assert.equal(state.lastModified, lastModified);
  assert.equal(state.totalBytes, payload.length);
  assert.equal(state.written, failAfter, '已写入字节数必须记成磁盘实际值');
});

test('续传：远端总大小超 maxBytes → 拒绝且不留残片与 sidecar', async () => {
  const root = tmp('qq-media-resume-max-');
  const payload = Buffer.alloc(4096, 0x5a);
  const failAfter = 512;

  const seed = rangeAwareFetch(payload, { failAfter });
  await archiverWith(root, { fetchImpl: seed.fetchImpl }).archive({
    kind: 'file',
    url: resumeUrls.max,
    filename: 'big.bin',
  });
  assert.equal(incomingFiles(root).filter((f) => f.endsWith('.part')).length, 1, '前提：先有残片');

  // 第二次 maxBytes 小于总大小：Content-Range 的 total=4096 直接拒绝
  const second = rangeAwareFetch(payload);
  const outcome = await archiverWith(root, { fetchImpl: second.fetchImpl, maxBytes: 1024 }).archive({
    kind: 'file',
    url: resumeUrls.max,
    filename: 'big.bin',
  });
  assert.equal(outcome.status, 'missing');
  assert.match(outcome.reason ?? '', /超过上限/);
  assert.deepEqual(incomingFiles(root), [], '超限必须同时清掉 .part 与 sidecar');
});

test('续传：服务端 416 → 丢弃残片重头下载成功', async () => {
  const root = tmp('qq-media-416-');
  const payload = Buffer.from('RANGE-NOT-SATISFIABLE-'.repeat(60), 'utf8');

  // 制造与远端等长的「残片」：服务端随后对 Range 回 416
  const seed = rangeAwareFetch(payload, { failAfter: payload.length + 100 });
  await archiverWith(root, { fetchImpl: seed.fetchImpl }).archive({
    kind: 'file',
    url: resumeUrls.reject,
    filename: 'reject.bin',
  });
  assert.ok(incomingFiles(root).some((f) => f.endsWith('.part')));

  const second = rangeAwareFetch(payload, { rejectRange: true });
  const outcome = await archiverWith(root, { fetchImpl: second.fetchImpl }).archive({
    kind: 'file',
    url: resumeUrls.reject,
    filename: 'reject.bin',
  });
  assert.equal(outcome.status, 'present');
  assert.equal(second.calls.length, 2, '416 后必须无 Range 重试一次');
  assert.equal(second.calls[0]?.['range'], `bytes=${payload.length}-`);
  assert.equal(second.calls[1]?.['range'], undefined, '重试不得再带 Range');
  assert.equal(outcome.media.sha256, sha256Of(payload));
  assert.deepEqual(readFileSync(join(root, outcome.media.relPath)), payload);
  assert.deepEqual(incomingFiles(root), []);
});

test('续传：无 sidecar 的全新下载不发 Range，且不残留（与从前一致）', async () => {
  const root = tmp('qq-media-fresh-');
  const payload = Buffer.from('fresh-no-range', 'utf8');
  const f = rangeAwareFetch(payload);
  const outcome = await archiverWith(root, { fetchImpl: f.fetchImpl }).archive({
    kind: 'file',
    url: resumeUrls.fresh,
    filename: 'fresh.bin',
  });
  assert.equal(outcome.status, 'present');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]?.['range'], undefined, '全新下载不得发 Range');
  assert.equal(outcome.media.sha256, sha256Of(payload));
  assert.deepEqual(incomingFiles(root), []);
});

test('续传：resume=false 时中断即清理残片，不留下可续传状态', async () => {
  const root = tmp('qq-media-resume-off-');
  const payload = Buffer.from('NO-RESUME-'.repeat(90), 'utf8');
  const f = rangeAwareFetch(payload, { failAfter: 100 });
  const outcome = await archiverWith(root, { fetchImpl: f.fetchImpl, resume: false }).archive({
    kind: 'file',
    url: resumeUrls.fresh,
    filename: 'off.bin',
  });
  assert.equal(outcome.status, 'missing');
  assert.deepEqual(incomingFiles(root), [], '关闭续传后中断必须清理干净');
});
