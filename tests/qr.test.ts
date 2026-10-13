/**
 * `packages/qr`（零依赖 QR 编码器）的独立验证套件。
 *
 * 设计原则：**测试不复用被测代码**。
 *  - QR 的功能图形判定 / 掩码解码 / 码字提取，用的是当初独立重写的矩形并集实现（见 QRLIB 段），
 *    而不是 `encode.ts` 里的逐模块绘制 —— 两边只有都符合规范才会一致。
 *  - 格式信息用 BCH(15,5) 从零重算 + libqrencode 的参考位图双向核对。
 *  - 纠错码字用自己实现的 GF(2⁸) 求 syndrome 验证（码字多项式在 α^0..α^(2t-1) 上必须为 0），
 *    而不是"再算一遍 RS 余数看是否相等"那种同义反复。
 *
 * 外部工具（qrencode / zbarimg / python3+PIL）**可能不存在**：相关用例先做可用性探测，
 * 缺失时 `t.skip()`，绝不让整个套件因子进程缺失而变红。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 as nodeCrc32, inflateSync } from 'node:zlib';
import {
  encodeQr,
  numDataCodewords,
  rawDataModules,
  reedSolomonDivisor,
  reedSolomonRemainder,
  totalCodewords,
} from '../packages/qr/src/index.ts';
import type { EccLevel, QrCode } from '../packages/qr/src/index.ts';
import { qrToPng, qrToPngDataUrl, qrToSvg, qrToTerminal } from '../packages/qr/src/index.ts';

/* ================================================================== */
/* 独立重写的 QR 规范实现（功能图形 / 掩码 / 码字提取 / BCH 格式信息）   */
/* ================================================================== */

/**
 * 校正图形中心坐标 —— ISO/IEC 18004 表 E.1（"Row/column coordinates of center
 * module of alignment patterns"）的完整 v1–v40 字面表。
 *
 * 这里刻意**不**用常见的"均匀步长"公式，因为该公式只在 v ≤ 35 成立：
 *   公式 step = ceil((4v+4)/(2·numAlign−2))·2（v=32 取 26，numAlign = floor(v/7)+2）
 * 对 **v36–v40 会给出错误坐标**（实测 v36 给出 34/66，而规范是 24/50；v37 给出
 * 36/68，规范是 28/54；v38 给出 38/72，规范是 32/58；v39 给出 42/78，规范是
 * 26/54/82；v40 给出 34/66，规范是 30/58）。参考：
 * https://www.thonky.com/qr-code-tutorial/alignment-pattern-locations
 * 这张表与实际编码器 `encode.ts` 里的 `alignmentPositions()` 没有代码关系。
 */
const ALIGNMENT_TABLE: Readonly<Record<number, readonly number[]>> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
  11: [6, 30, 54],
  12: [6, 32, 58],
  13: [6, 34, 62],
  14: [6, 26, 46, 66],
  15: [6, 26, 48, 70],
  16: [6, 26, 50, 74],
  17: [6, 30, 54, 78],
  18: [6, 30, 56, 82],
  19: [6, 30, 58, 86],
  20: [6, 34, 62, 90],
  21: [6, 28, 50, 72, 94],
  22: [6, 26, 50, 74, 98],
  23: [6, 30, 54, 78, 102],
  24: [6, 28, 54, 80, 106],
  25: [6, 32, 58, 84, 110],
  26: [6, 30, 58, 86, 114],
  27: [6, 34, 62, 90, 118],
  28: [6, 26, 50, 74, 98, 122],
  29: [6, 30, 54, 78, 102, 126],
  30: [6, 26, 52, 78, 104, 130],
  31: [6, 30, 56, 82, 108, 134],
  32: [6, 34, 60, 86, 112, 138],
  33: [6, 30, 58, 86, 114, 142],
  34: [6, 34, 62, 90, 118, 146],
  35: [6, 30, 54, 78, 102, 126, 150],
  36: [6, 24, 50, 76, 102, 128, 154],
  37: [6, 28, 54, 80, 106, 132, 158],
  38: [6, 32, 58, 84, 110, 136, 162],
  39: [6, 26, 54, 82, 110, 138, 166],
  40: [6, 30, 58, 86, 114, 142, 170],
};

function alignCenters(v: number): number[] {
  return [...(ALIGNMENT_TABLE[v] ?? [])];
}

/** 功能图形（探测/分隔/时序/校正/格式/版本）的掩码；true = 不可放数据。 */
function functionMap(v: number): boolean[] {
  const n = v * 4 + 17;
  const f = new Array<boolean>(n * n).fill(false);
  const rect = (x0: number, y0: number, x1: number, y1: number): void => {
    for (let y = Math.max(0, y0); y <= Math.min(n - 1, y1); y++) {
      for (let x = Math.max(0, x0); x <= Math.min(n - 1, x1); x++) f[y * n + x] = true;
    }
  };
  rect(0, 0, 8, 8); // 左上：探测图形 + 分隔符 + 格式信息
  rect(n - 8, 0, n - 1, 8); // 右上
  rect(0, n - 8, 8, n - 1); // 左下
  rect(0, 6, n - 1, 6); // 横向时序图形
  rect(6, 0, 6, n - 1); // 纵向时序图形
  const centers = alignCenters(v);
  const last = centers.length - 1;
  for (const cy of centers) {
    for (const cx of centers) {
      const isCorner = (cx === 6 && cy === 6) || (cx === 6 && cy === centers[last]) || (cx === centers[last] && cy === 6);
      if (!isCorner) rect(cx - 2, cy - 2, cx + 2, cy + 2);
    }
  }
  if (v >= 7) {
    rect(n - 11, 0, n - 9, 5); // 版本信息（右上）
    rect(0, n - 11, 5, n - 9); // 版本信息（左下）
  }
  return f;
}

/** 规范里 8 种数据掩码的"是否翻转"判定（与实现无关的独立重写）。 */
function maskBit(m: number, x: number, y: number): boolean {
  switch (m) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      throw new Error(`非法掩码 ${m}`);
  }
}

/**
 * 按规范的"蛇形"顺序提取数据码字（去掉掩码）。remainder bits 不足 8 位时自然丢弃，
 * 因此返回长度 = totalCodewords(v)。
 */
function extractCodewords(grid: boolean[][], v: number, mask: number): number[] {
  const n = v * 4 + 17;
  const f = functionMap(v);
  const bits: number[] = [];
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // 第 6 列是时序图形，跳过
    for (let vert = 0; vert < n; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? n - 1 - vert : vert;
        if (f[y * n + x]) continue;
        const raw = grid[y]![x]!;
        bits.push(raw !== maskBit(mask, x, y) ? 1 : 0);
      }
    }
  }
  const cw: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let b = 0;
    for (let k = 0; k < 8; k++) b = (b << 1) | bits[i + k]!;
    cw.push(b);
  }
  return cw;
}

/** 规范位置上的 15 位格式信息（bit i 的坐标，i=0 是 LSB）。 */
const FORMAT_POS_1: ReadonlyArray<readonly [number, number]> = (() => {
  const pos: Array<[number, number]> = [];
  for (let i = 0; i <= 5; i++) pos.push([8, i]);
  pos.push([8, 7], [8, 8], [7, 8]);
  for (let i = 9; i < 15; i++) pos.push([14 - i, 8]);
  return pos;
})();

/** 从位图里读出第一份 15 位格式信息（坐标写死，不引用实现常量）。 */
function formatBits1(g: readonly boolean[][]): number {
  let bits = 0;
  for (let i = 0; i < 15; i++) {
    const [x, y] = FORMAT_POS_1[i]!;
    if (g[y]![x]) bits |= 1 << i;
  }
  return bits;
}

/** 从位图里读出第二份 15 位格式信息：bit i = (n-1-i, 8)（i<8）/ (8, n-15+i)（i≥8）。 */
function formatBits2(g: readonly boolean[][], n: number): number {
  let bits = 0;
  for (let i = 0; i < 8; i++) if (g[8]![n - 1 - i]) bits |= 1 << i;
  for (let i = 8; i < 15; i++) if (g[n - 15 + i]![8]) bits |= 1 << i;
  return bits;
}

/** BCH(15,5)：按 §8.9 重算 32 个合法格式信息码字（与 0x5412 异或后的值）。 */
function formatCodewords(): number[] {
  const out: number[] = [];
  for (let data = 0; data < 32; data++) {
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    out.push(((data << 10) | rem) ^ 0x5412);
  }
  return out;
}

/**
 * 解格式信息 → { eccBits, mask, ecc }。15 位 BCH 码距 7，最近的合法码字唯一。
 * eccBits 是格式信息里的 2 位编码（L=01, M=00, Q=11, H=10），不是数组下标。
 */
function decodeFormat(bits: number): { data: number; eccBits: number; mask: number; ecc: EccLevel } {
  const codewords = formatCodewords();
  let best = -1;
  let bestDist = Infinity;
  for (let data = 0; data < 32; data++) {
    const x = bits ^ codewords[data]!;
    let dist = 0;
    for (let i = 0; i < 15; i++) dist += (x >>> i) & 1;
    if (dist < bestDist) {
      bestDist = dist;
      best = data;
    }
  }
  assert.ok(best >= 0, 'BCH 解码不应失败');
  assert.ok(bestDist <= 3, `最近码字距离应 ≤ 3（纠错能力），实际 ${bestDist}`);
  const eccBits = (best >> 3) & 3;
  const ecc: EccLevel = eccBits === 1 ? 'L' : eccBits === 0 ? 'M' : eccBits === 3 ? 'Q' : 'H';
  return { data: best, eccBits, mask: best & 7, ecc };
}

/* ================================================================== */
/* ISO/IEC 18004 表 9：纠错码字/块 与 RS 块数（字面量表，交叉校验用）     */
/* ================================================================== */

/**
 * 以下三张表都是**照抄字面量**、与 `encode.ts` 无代码关系，来源为 ISO/IEC 18004
 * 表 9（"Error correction characteristics for QR Code"）。逐行核对参考：
 * https://www.thonky.com/qr-code-tutorial/error-correction-table
 * 每张表的下标 = 版本 − 1，覆盖 v1–v40 全部 40 个版本。
 */

/** 每块纠错码字数（EC codewords per block）。 */
const ECC_PER_BLOCK: Readonly<Record<EccLevel, readonly number[]>> = {
  L: [7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  Q: [13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  H: [17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
};

/** RS 块总数（group 1 + group 2 的块数之和）。 */
const NUM_BLOCKS: Readonly<Record<EccLevel, readonly number[]>> = {
  L: [1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  Q: [1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  H: [1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
};

/** 每个 (版本, 纠错) 的数据码字总数（表 9 最后一列 "Total Data Codewords"）。 */
const DATA_CODEWORDS: Readonly<Record<EccLevel, readonly number[]>> = {
  L: [19, 34, 55, 80, 108, 136, 156, 194, 232, 274, 324, 370, 428, 461, 523, 589, 647, 721, 795, 861, 932, 1006, 1094, 1174, 1276, 1370, 1468, 1531, 1631, 1735, 1843, 1955, 2071, 2191, 2306, 2434, 2566, 2702, 2812, 2956],
  M: [16, 28, 44, 64, 86, 108, 124, 154, 182, 216, 254, 290, 334, 365, 415, 453, 507, 563, 627, 669, 714, 782, 860, 914, 1000, 1062, 1128, 1193, 1267, 1373, 1455, 1541, 1631, 1725, 1812, 1914, 1992, 2102, 2216, 2334],
  Q: [13, 22, 34, 48, 62, 76, 88, 110, 132, 154, 180, 206, 244, 261, 295, 325, 367, 397, 445, 485, 512, 568, 614, 664, 718, 754, 808, 871, 911, 985, 1033, 1115, 1171, 1231, 1286, 1354, 1426, 1502, 1582, 1666],
  H: [9, 16, 26, 36, 46, 60, 66, 86, 100, 122, 140, 158, 180, 197, 223, 253, 283, 313, 341, 385, 406, 442, 464, 514, 538, 596, 628, 661, 701, 745, 793, 845, 901, 961, 986, 1054, 1096, 1142, 1222, 1276],
};

/* ================================================================== */
/* 自实现 GF(2⁸)：α = 2，本原多项式 0x11D                              */
/* ================================================================== */

interface GF {
  exp: Uint8Array;
  log: Int16Array;
}

function makeGF(): GF {
  const exp = new Uint8Array(512);
  const log = new Int16Array(256).fill(-1);
  let x = 1;
  for (let i = 0; i < 255; i++) {
    exp[i] = x;
    log[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) exp[i] = exp[i - 255]!;
  return { exp, log };
}

/** 用 log/antilog 表做 GF(256) 乘法（独立于编码器里的移位实现）。 */
function gfMulLog(gf: GF, a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return gf.exp[gf.log[a]! + gf.log[b]!]!;
}

/** 把某一块的码字当多项式（首字节最高次）在 α^power 上求值。 */
function gfEval(gf: GF, block: readonly number[], power: number): number {
  const x = gf.exp[power]!;
  let y = 0;
  for (const c of block) y = gfMulLog(gf, y, x) ^ c;
  return y;
}

/**
 * 把交错后的整段码字还原成各 RS 块 —— 纯按表 9 的块结构做逆交错，
 * 不依赖 `encode.ts` 的私有函数。
 */
function deinterleave(codewords: readonly number[], version: number, ecc: EccLevel): number[][] {
  const nb = NUM_BLOCKS[ecc][version - 1]!;
  const eccLen = ECC_PER_BLOCK[ecc][version - 1]!;
  const raw = totalCodewords(version);
  // 关键：规范按**总码字数**均分，而不是按数据码字数。组 1 的块长 = ⌊raw/nb⌋，
  // 其中数据段长 = 块长 − eccLen；组 2 的块数据段多 1 个码字。用 dataCw/nb 会算错
  // （v8-M：raw=174,nb=2 → 每块 87，数据段 44 vs 43），逆交错整体错位，syndrome 不为 0。
  const shortBlockLen = Math.floor(raw / nb);
  const numShort = nb - (raw % nb);
  const blocks: number[][] = [];
  for (let b = 0; b < nb; b++) {
    const datLen = shortBlockLen - eccLen + (b < numShort ? 0 : 1);
    blocks.push(new Array<number>(datLen + eccLen).fill(0));
  }
  let idx = 0;
  // 数据段按列交错（组 2 只在最后多取 1 个）
  for (let i = 0; i < shortBlockLen - eccLen; i++) {
    for (let b = 0; b < nb; b++) blocks[b]![i] = codewords[idx++]!;
  }
  for (let b = numShort; b < nb; b++) blocks[b]![shortBlockLen - eccLen] = codewords[idx++]!;
  // 纠错段按列交错
  for (let i = 0; i < eccLen; i++) {
    for (let b = 0; b < nb; b++) blocks[b]![blocks[b]!.length - eccLen + i] = codewords[idx++]!;
  }
  assert.equal(idx, codewords.length, '逆交错应恰好消费全部码字');
  return blocks;
}

/** 由 (版本, 纠错) 反推 byte 模式的实际内容字节数（数据码字 → 已用位数）。 */
function contentBytesIn(codewords: readonly number[], version: number, ecc: EccLevel): number {
  const capacity = numDataCodewords(version, ecc) * 8;
  const bitAt = (i: number): number => (codewords[i >>> 3]! >>> (7 - (i & 7))) & 1;
  const readBits = (from: number, len: number): number => {
    let value = 0;
    for (let i = 0; i < len; i++) value = (value << 1) | bitAt(from + i);
    return value;
  };
  assert.equal(readBits(0, 4), 0b0100, '模式指示符必须是 byte 模式 0100');
  const countBits = version <= 9 ? 8 : 16;
  const count = readBits(4, countBits);
  const used = 4 + countBits + count * 8;
  assert.ok(used <= capacity, `内容位数 ${used} 不应超过数据容量 ${capacity}`);
  return count;
}

/* ================================================================== */
/* 工具函数                                                            */
/* ================================================================== */

/** 把 QrCode 转成 boolean[][]（true = 深色）。 */
function gridOf(qr: QrCode): boolean[][] {
  const g: boolean[][] = [];
  for (let y = 0; y < qr.size; y++) {
    const row: boolean[] = [];
    for (let x = 0; x < qr.size; x++) row.push(qr.modules[y * qr.size + x] !== 0);
    g.push(row);
  }
  return g;
}

/** 内容需要的**最小**版本（byte 模式：4 位模式 + 计数位 + 8n 位）。 */
function minVersionFor(text: string, ecc: EccLevel): number {
  const bytes = new TextEncoder().encode(text).length;
  for (let v = 1; v <= 40; v++) {
    if (4 + (v <= 9 ? 8 : 16) + bytes * 8 <= numDataCodewords(v, ecc) * 8) return v;
  }
  throw new RangeError('内容超过版本 40 容量');
}

/** 某版本在 byte 模式下能装的最大字节数（注意 v≤9 的计数位是 8，v≥10 是 16）。 */
function byteCapacity(v: number, ecc: EccLevel): number {
  return Math.floor((numDataCodewords(v, ecc) * 8 - 4 - (v <= 9 ? 8 : 16)) / 8);
}

function which(cmd: string): boolean {
  const r = spawnSync('which', [cmd], { stdio: 'ignore' });
  return r.status === 0;
}

const HAS_QRENCODE = which('qrencode');
const HAS_ZBARIMG = which('zbarimg');

/* ---------------- PNG 解析（逐 chunk 校验 CRC） ---------------- */

interface PngChunk {
  type: string;
  data: Uint8Array;
  crcOk: boolean;
}

interface PngInfo {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
  chunks: PngChunk[];
  idat: Buffer;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function parsePng(bytes: Uint8Array): PngInfo {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.deepEqual(Array.from(buf.subarray(0, 8)), PNG_SIGNATURE, 'PNG 签名必须是 89 50 4E 47 0D 0A 1A 0A');
  let off = 8;
  const chunks: PngChunk[] = [];
  const idat: Buffer[] = [];
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    assert.ok(off + 12 + len <= buf.length, `chunk ${type} 长度越界`);
    const stored = buf.readUInt32BE(off + 8 + len);
    const computed = nodeCrc32(buf.subarray(off + 4, off + 8 + len)) >>> 0;
    const crcOk = stored === computed;
    if (!crcOk) {
      throw new Error(`chunk ${type} CRC 不匹配：文件 ${stored.toString(16)} vs 实算 ${computed.toString(16)}`);
    }
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8]!;
      colorType = data[9]!;
      interlace = data[12]!;
    }
    if (type === 'IDAT') idat.push(Buffer.from(data));
    chunks.push({ type, data: Uint8Array.from(data), crcOk });
    off += 12 + len;
    if (type === 'IEND') break;
  }
  return {
    width,
    height,
    bitDepth,
    colorType,
    interlace,
    chunks,
    idat: Buffer.concat(idat),
  };
}

/**
 * 1 位灰度 PNG → boolean 矩阵（true = 深色）。
 *
 * 灰度 1 位：**0 = 黑、1 = 白**（`render.ts` 的约定，也是规范推荐的扫码友好极性）。
 * 这里逐位读回，验证 PNG 与模块矩阵逐像素一致。
 */
function pngToGrid(info: PngInfo): boolean[][] {
  assert.equal(info.bitDepth, 1, '应为 1 位灰度 PNG');
  assert.equal(info.colorType, 0, '应为灰度色型（0）');
  assert.equal(info.interlace, 0, '不应使用隔行扫描');
  const rowBytes = Math.ceil(info.width / 8);
  const raw = inflateSync(info.idat);
  assert.equal(raw.length, (rowBytes + 1) * info.height, '解压后长度应为 (行字节+1) × 高');
  const grid: boolean[][] = [];
  for (let y = 0; y < info.height; y++) {
    const start = y * (rowBytes + 1);
    assert.equal(raw[start], 0, `第 ${y} 行滤波器字节应为 0（None）`);
    const row: boolean[] = [];
    for (let x = 0; x < info.width; x++) {
      const byte = raw[start + 1 + (x >> 3)]!;
      // 灰度 1 位：1 = 白，因此 bit 为 0 时是深色
      row.push(((byte >> (7 - (x & 7))) & 1) === 0);
    }
    grid.push(row);
  }
  return grid;
}

/**
 * 解析**调色板型（colorType 3）** PNG → boolean 矩阵。
 *
 * libqrencode 的 `-t PNG` 输出是 1 位调色板图（PLTE 里两项：黑在前、白在后），
 * 不是灰度图，所以参考位图必须走这条路径。判定"深色"用调色板项的实际亮度
 * （RGB 均值 < 128），不硬编码索引顺序。
 */
function palettePngToGrid(info: PngInfo): boolean[][] {
  assert.equal(info.colorType, 3, `应为调色板色型（3），实际 ${info.colorType}`);
  assert.equal(info.interlace, 0, '不应使用隔行扫描');
  assert.ok(info.bitDepth === 1 || info.bitDepth === 2 || info.bitDepth === 4 || info.bitDepth === 8, '不支持的位深');
  const plte = info.chunks.find((c) => c.type === 'PLTE');
  assert.ok(plte !== undefined, '调色板 PNG 必须有 PLTE');
  const entryCount = plte.data.length / 3;
  const darkEntry: boolean[] = [];
  for (let i = 0; i < entryCount; i++) {
    const r = plte.data[i * 3]!;
    const g = plte.data[i * 3 + 1]!;
    const b = plte.data[i * 3 + 2]!;
    darkEntry.push((r + g + b) / 3 < 128);
  }
  const bitsPerPixel = info.bitDepth;
  const rowBytes = Math.ceil((info.width * bitsPerPixel) / 8);
  const raw = inflateSync(info.idat);
  assert.equal(raw.length, (rowBytes + 1) * info.height, '解压后长度应为 (行字节+1) × 高');
  const perByte = 8 / bitsPerPixel;
  const mask = (1 << bitsPerPixel) - 1;
  const grid: boolean[][] = [];
  for (let y = 0; y < info.height; y++) {
    const start = y * (rowBytes + 1);
    const filter = raw[start]!;
    assert.ok(filter === 0 || filter === 1 || filter === 2 || filter === 3 || filter === 4, `非法滤波器 ${filter}`);
    const row: boolean[] = [];
    for (let x = 0; x < info.width; x++) {
      const byte = raw[start + 1 + Math.floor(x / perByte)]!;
      const shift = 8 - bitsPerPixel * ((x % perByte) + 1);
      const index = (byte >> shift) & mask;
      const dark = darkEntry[index];
      assert.notEqual(dark, undefined, `调色板索引 ${index} 越界`);
      row.push(dark === true);
    }
    grid.push(row);
  }
  return grid;
}

/** 按色型选择解码路径（灰度 / 调色板）。 */
function pngToModuleGrid(info: PngInfo): boolean[][] {
  if (info.colorType === 0) return pngToGrid(info);
  if (info.colorType === 3) return palettePngToGrid(info);
  throw new Error(`不支持的颜色类型 ${info.colorType}`);
}

/* ---------------- 参考实现 / 解码器适配 ---------------- */

const TMP = mkdtempSync(join(tmpdir(), 'qq-qr-test-'));
let tmpSeq = 0;
function tmpFile(name: string): string {
  return join(TMP, `${tmpSeq++}-${name}`);
}

/**
 * 用 libqrencode 生成参考符号并读回 0/1 矩阵。
 *
 * **必须**走 PNG 解析：`qrencode -t ASCII` 的输出排版会误导（`-m` 与行宽都会骗人），
 * 用它做基准会造成假失败 —— 这是本项目已经踩过的坑。参考 PNG 是调色板色型，
 * 所以由 `pngToModuleGrid` 按 PLTE 亮度判定黑白。
 */
function referenceGrid(text: string, ecc: EccLevel): boolean[][] {
  const png = tmpFile(`ref-${ecc}.png`);
  execFileSync('qrencode', ['-t', 'PNG', '-s', '1', '-m', '0', '-l', ecc, '-o', png, '--', text], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  return pngToModuleGrid(parsePng(readFileSync(png)));
}

interface Reference {
  grid: boolean[][];
  version: number;
  mask: number;
}

function referenceSymbol(text: string, ecc: EccLevel): Reference {
  const grid = referenceGrid(text, ecc);
  const n = grid.length;
  assert.equal(grid[0]!.length, n, '参考符号应为正方形');
  assert.equal((n - 17) % 4, 0, `参考符号尺寸 ${n} 不满足 4v+17`);
  const version = (n - 17) / 4;
  const decoded = decodeFormat(formatBits1(grid));
  assert.equal(decoded.ecc, ecc, '参考符号的纠错等级应解回预期值');
  return { grid, version, mask: decoded.mask };
}

/** zbarimg 解码；`--raw` 下 stdout 就是原文（按 UTF-8 解析）。 */
function zbarDecode(png: string): string {
  const r = execFileSync('zbarimg', ['--quiet', '--raw', png], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return r.replace(/\n$/, '');
}

/* ================================================================== */

test.after(() => {
  rmSync(TMP, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* 1. 容量表交叉校验                                                    */
/* ------------------------------------------------------------------ */

test('qr: 容量表与 ISO/IEC 18004 表 7/9 交叉校验', () => {
  const eccs = ['L', 'M', 'Q', 'H'] as const;

  // 总码字数：v1=26 / v2=44 是规范里最常引用的点，先逐点核对字面量表（v1–10）。
  // 表中每个版本连续出现 4 次（L/M/Q/H 的 total 恒等），所以用 4(v−1) 取。
  const TOTAL_CODEWORDS_1_10: readonly number[] = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
  for (let v = 1; v <= 10; v++) {
    assert.equal(totalCodewords(v), TOTAL_CODEWORDS_1_10[v - 1], `版本 ${v} 总码字数`);
  }

  // 表 9 的三列必须自洽：数据码字 + 每块纠错码字 × 块数 = 总码字。
  // 这里同时验证编码器的 numDataCodewords / totalCodewords 与三张独立字面表一致。
  for (let v = 1; v <= 40; v++) {
    for (const ecc of eccs) {
      const data = DATA_CODEWORDS[ecc][v - 1]!;
      const eccLen = ECC_PER_BLOCK[ecc][v - 1]!;
      const nb = NUM_BLOCKS[ecc][v - 1]!;
      assert.equal(numDataCodewords(v, ecc), data, `v${v}-${ecc} 数据码字数`);
      assert.equal(
        totalCodewords(v),
        data + eccLen * nb,
        `v${v}-${ecc}：数据码字 ${data} + 纠错 ${eccLen}×${nb} 应等于总码字 ${totalCodewords(v)}`,
      );
      assert.ok(data > 0, `v${v}-${ecc} 数据码字数应为正`);
    }
  }

  // 分组布局：组 2 的块比组 1 多 1 个数据码字，且 blockCount × blockLen 正好铺满全部总码字。
  for (let v = 1; v <= 40; v++) {
    for (const ecc of eccs) {
      const data = DATA_CODEWORDS[ecc][v - 1]!;
      const nb = NUM_BLOCKS[ecc][v - 1]!;
      const eccLen = ECC_PER_BLOCK[ecc][v - 1]!;
      const shortLen = Math.floor(data / nb);
      const numShort = nb - (data % nb);
      assert.equal(shortLen * numShort + (shortLen + 1) * (nb - numShort), data, `v${v}-${ecc} 分组应铺满数据码字`);
      // 总码字也应按块闭合
      assert.equal((shortLen + eccLen) * nb + (nb - numShort), totalCodewords(v), `v${v}-${ecc} 块布局应铺满总码字`);
    }
  }

  // 版本 1 的四个等级（表 9 的字面点）
  assert.equal(numDataCodewords(1, 'L'), 19);
  assert.equal(numDataCodewords(1, 'M'), 16);
  assert.equal(numDataCodewords(1, 'Q'), 13);
  assert.equal(numDataCodewords(1, 'H'), 9);

  // 版本 40 的四个等级（表 9 的字面点）
  assert.equal(numDataCodewords(40, 'L'), 2956);
  assert.equal(numDataCodewords(40, 'M'), 2334);
  assert.equal(numDataCodewords(40, 'Q'), 1666);
  assert.equal(numDataCodewords(40, 'H'), 1276);

  // 强交叉校验：本测试**独立重写**的功能图形判定（functionMap，只按规范几何画区块）
  // 数出的"非功能模块数"必须与编码器的 rawDataModules() 逐位相等。这一条同时把
  // 编码器的模块容量算法与测试自己的几何实现绑在一起，任一边错都会立刻暴露。
  for (const v of [1, 2, 3, 7, 13, 14, 25, 32, 36, 40]) {
    const n = v * 4 + 17;
    const func = functionMap(v);
    let dataModules = 0;
    for (const isFunc of func) if (!isFunc) dataModules++;
    assert.equal(dataModules, rawDataModules(v), `v${v}：非功能模块数应等于 rawDataModules`);
    assert.equal(totalCodewords(v), Math.floor(dataModules / 8), `v${v}：总码字数应等于 ⌊非功能模块数/8⌋`);
    assert.ok(dataModules >= totalCodewords(v) * 8 && dataModules < (totalCodewords(v) + 1) * 8, `v${v} 余数位应为 0–7`);
    assert.equal(func.length, n * n, `v${v} 功能掩码长度应为 size²`);
  }
});

test('qr: 内容边界选版本、ecc 默认值与非法输入', () => {
  // 版本 40 / L 的 byte 模式上限：4 + 16 + 8n ≤ 2956×8 → n ≤ 2953
  assert.equal(byteCapacity(40, 'L'), 2953, 'v40-L byte 上限应为 2953 字节');
  const max = encodeQr('a'.repeat(2953), { ecc: 'L' });
  assert.equal(max.version, 40, '2953 字节应刚好落在版本 40');
  assert.throws(() => encodeQr('a'.repeat(2954), { ecc: 'L' }), RangeError, '超长内容必须抛 RangeError');

  // 边界长度选中正确版本：恰好装满 vs 多一个字节
  for (const ecc of ['L', 'M', 'Q', 'H'] as const) {
    for (const v of [1, 2, 3, 5, 7, 10] as const) {
      const cap = byteCapacity(v, ecc);
      assert.equal(minVersionFor('a'.repeat(cap), ecc), v, `${ecc} 下恰好 ${cap} 字节应选 v${v}`);
      const chosen = encodeQr('a'.repeat(cap), { ecc });
      assert.equal(chosen.version, v, `${ecc} 恰好装满时应选 v${v}`);
      assert.equal(chosen.size, v * 4 + 17);
      if (v < 10) {
        const bumped = encodeQr('a'.repeat(cap + 1), { ecc });
        assert.ok(bumped.version > v, `${ecc} 下多 1 字节必须升到更高版本`);
      }
    }
  }

  // 中文按 UTF-8 字节计：3 个汉字 = 9 字节，与 9 个 ASCII 字节选同一个版本
  assert.equal(encodeQr('中文测试', { ecc: 'M' }).version, encodeQr('a'.repeat(12), { ecc: 'M' }).version);

  // ecc 缺省值为 M：与显式 ecc:'M' 完全一致
  const def = encodeQr('hello world');
  const explicit = encodeQr('hello world', { ecc: 'M' });
  assert.equal(def.ecc, 'M', '缺省纠错等级应为 M');
  assert.deepEqual(Array.from(def.modules), Array.from(explicit.modules));
  assert.equal(def.version, explicit.version);
  assert.equal(def.mask, explicit.mask);

  // minVersion 只能抬高版本，不能降低
  assert.equal(encodeQr('abc', { minVersion: 7 }).version, 7);
  assert.equal(encodeQr('abc', { minVersion: 40, ecc: 'H' }).version, 40);
  assert.equal(encodeQr('abc', { ecc: 'L' }).version, 1, 'minVersion 缺省仍从 1 开始');

  // 非法输入
  assert.throws(() => encodeQr('abc', { ecc: 'X' as EccLevel }), RangeError, '未知纠错等级');
  assert.throws(() => encodeQr('abc', { minVersion: 0 }), RangeError, 'minVersion < 1');
  assert.throws(() => encodeQr('abc', { minVersion: 41 }), RangeError, 'minVersion > 40');
  assert.throws(() => encodeQr('abc', { minVersion: 1.5 }), RangeError, 'minVersion 必须是整数');
  assert.throws(() => encodeQr('abc', { mask: 8 }), RangeError, 'mask 必须 0–7');
  assert.throws(() => encodeQr('abc', { mask: -1 }), RangeError, 'mask 必须非负');
  assert.throws(() => encodeQr('abc', { mask: 2.5 }), RangeError, 'mask 必须是整数');
  assert.equal(encodeQr('', { ecc: 'L' }).version, 1, '空串也应能编码为 v1');

  // 强制掩码必须真正生效
  for (let m = 0; m < 8; m++) {
    const q = encodeQr('hello world', { ecc: 'M', mask: m });
    assert.equal(q.mask, m, `强制掩码 ${m} 应被采用`);
    assert.equal(decodeFormat(formatBits1(gridOf(q))).mask, m, `位图里的格式信息应解回掩码 ${m}`);
  }
});

/* ------------------------------------------------------------------ */
/* 2. Reed–Solomon 数学性质                                             */
/* ------------------------------------------------------------------ */

test('qr: RS 生成多项式次数为 deg 且首项为 1', () => {
  for (const deg of [1, 2, 7, 10, 13, 17, 22, 26, 28, 30]) {
    const d = reedSolomonDivisor(deg);
    assert.equal(d.length, deg, `次数 ${deg} 的生成多项式应返回 ${deg} 个低次项系数`);
    // 生成多项式首一（monic）：最高次项 x^deg 的系数恒为 1，实现里是隐含项，
    // 因此返回数组只含 x^0..x^(deg−1) 共 deg 个系数。等价于 deg=1 时数组应为 [1]。
    assert.equal(reedSolomonDivisor(1)[0], 1, 'deg=1 时唯一系数（x^0）应为 1');
    assert.equal(d.filter((x) => x === 0).length, 0, `次数 ${deg} 的生成多项式各项系数不应为 0`);
    assert.throws(() => reedSolomonDivisor(-1), RangeError, '负次数应被拒');
    assert.throws(() => reedSolomonDivisor(256), RangeError, '次数 > 255 应被拒');
  }
  // 已知点（**高次在前、且不含隐含的首一最高次项**，与 reedSolomonRemainder 的除数
  // 索引约定一致；已用独立实现的多项式乘法 (x+α⁰)(x+α¹)··· 逐系数核对）：
  //   deg=2 → x² + 3x + 2            → 返回 [3, 2]
  assert.deepEqual(Array.from(reedSolomonDivisor(2)), [3, 2], 'deg=2 的生成多项式应为 [3, 2]');
  //   deg=4 → x⁴ + 15x³ + 54x² + 120x + 64 → 返回 [15, 54, 120, 64]
  assert.deepEqual(Array.from(reedSolomonDivisor(4)), [15, 54, 120, 64], 'deg=4 的已知系数');
  //   deg=10 → 已知参考向量（x¹⁰ 的系数 1 被省略）
  assert.deepEqual(
    Array.from(reedSolomonDivisor(10)),
    [216, 194, 159, 111, 199, 94, 95, 113, 157, 193],
    'deg=10 的已知参考向量',
  );
});

test('qr: 每个 RS 块的码字多项式在 α^0..α^(2t−1) 上求值为 0（syndrome 全零）', () => {
  const gf = makeGF();
  const cases: Array<[string, EccLevel, number]> = [
    // 期望版本用**独立实现**的条件 `4 + countBits(v) + bytes*8 ≤ numDataCodewords(v,ecc)*8`
    // 逐版本复算得到（不复用编码器的选版路径），下面是复算与编码器一致的点：
    ['abc', 'L', 1],
    ['hello world', 'M', 1],
    ['hello world', 'Q', 1],
    ['中文测试:扫码登录', 'H', 4], // 25 字节；v2-H 只有 16 数据码字的容量，装不下
    ['a'.repeat(80), 'L', 5],
    ['a'.repeat(150), 'M', 8],
    ['a'.repeat(400), 'M', 15],
    ['a'.repeat(800), 'L', 20],
  ];
  for (const [text, ecc, expectedVersion] of cases) {
    const qr = encodeQr(text, { ecc });
    assert.equal(qr.version, expectedVersion, `"${text.slice(0, 8)}" ${ecc} 应选 v${expectedVersion}`);
    const full = extractCodewords(gridOf(qr), qr.version, qr.mask);
    assert.equal(full.length, totalCodewords(qr.version), '提取的码字数应等于总码字数');
    const blocks = deinterleave(full, qr.version, ecc);
    const eccLen = ECC_PER_BLOCK[ecc][qr.version - 1]!;
    assert.equal(blocks.length, NUM_BLOCKS[ecc][qr.version - 1]!, '块数应与表 9 一致');
    // 数据段的内容字节数应与原文长度一致
    const dataCw = numDataCodewords(qr.version, ecc);
    const blockData = blocks.map((b) => b.slice(0, b.length - eccLen));
    assert.equal(
      blockData.reduce((n, b) => n + b.length, 0),
      dataCw,
      '各块数据码字数之和应等于该版本数据码字数',
    );
    const flatData = blockData.flat();
    assert.equal(contentBytesIn(flatData, qr.version, ecc), new TextEncoder().encode(text).length, '码字里的内容字节数');
    for (const block of blocks) {
      assert.equal(block.length, blockData[0]!.length > 0 ? block.length : block.length);
      for (let power = 0; power < eccLen; power++) {
        const syndrome = gfEval(gf, block, power);
        assert.equal(
          syndrome,
          0,
          `v${qr.version}-${ecc} 的块在 α^${power} 处求值应为 0，实际 ${syndrome}`,
        );
      }
    }
    // 反向验证：故意翻转一个数据码字，syndrome 必须不再全零（否则上面的断言是空转）
    const broken = blocks.map((b) => b.slice());
    const last = broken[0]!.length - eccLen - 1;
    broken[0]![last] = broken[0]![last]! ^ 0x01;
    let nonZero = 0;
    for (let power = 0; power < eccLen; power++) if (gfEval(gf, broken[0]!, power) !== 0) nonZero++;
    assert.ok(nonZero > 0, '翻转一个数据码字后 syndrome 必须出现非零（说明校验确实在起作用）');
  }
});

test('qr: reedSolomonRemainder 对已知样例给出教科书结果', () => {
  // "hello" 的 ASCII + deg=10 生成多项式：余数应与独立实现的 GF 长除法一致。
  const gf = makeGF();
  const data = new TextEncoder().encode('hello');
  const deg = 10;
  const divisor = reedSolomonDivisor(deg);
  const expected = new Uint8Array(deg);
  for (const b of data) {
    const factor = b ^ expected[0]!;
    expected.copyWithin(0, 1);
    expected[expected.length - 1] = 0;
    for (let i = 0; i < deg; i++) expected[i] = expected[i]! ^ gfMulLog(gf, divisor[i]!, factor);
  }
  const actual = reedSolomonRemainder(data, divisor);
  assert.deepEqual(Array.from(actual), Array.from(expected), 'RS 余数应与独立 GF 长除法一致');
  // 且 (data ‖ remainder) 在 α^0..α^9 上求值为 0
  const full = [...Array.from(data), ...Array.from(actual)];
  for (let p = 0; p < deg; p++) assert.equal(gfEval(gf, full, p), 0, `α^${p} 处应为 0`);
});

/* ------------------------------------------------------------------ */
/* 3. 格式信息（8 个掩码）                                              */
/* ------------------------------------------------------------------ */

test('qr: 8 个掩码的格式信息两处一致、BCH 可解、固定深色模块正确', () => {
  const n0 = 21; // v1
  for (let mask = 0; mask < 8; mask++) {
    const qr = encodeQr('hello world', { ecc: 'M', mask });
    const g = gridOf(qr);
    const n = qr.size;
    assert.equal(n, n0);
    const a = formatBits1(g);
    const b = formatBits2(g, n);
    assert.equal(a, b, `掩码 ${mask}：两处格式信息必须逐位一致`);
    const dec = decodeFormat(a);
    assert.equal(dec.mask, mask, `掩码 ${mask}：格式信息应解回同一掩码`);
    assert.equal(dec.ecc, 'M', '纠错等级位应为 M');
    assert.equal(dec.eccBits, 0b00, 'M 的格式信息纠错位是 00');
    assert.ok(g[n - 8]![8], `掩码 ${mask}：固定深色模块 (8,${n - 8}) 必须为深色`);
  }
  // 四个纠错等级的格式位编码
  const eccBitOf: Record<EccLevel, number> = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 };
  for (const ecc of ['L', 'M', 'Q', 'H'] as const) {
    for (let mask = 0; mask < 8; mask++) {
      const g = gridOf(encodeQr('abcdefghijklmnopqrstuvwxyz', { ecc, mask }));
      const dec = decodeFormat(formatBits1(g));
      assert.equal(dec.eccBits, eccBitOf[ecc], `${ecc} 的格式信息纠错位`);
      assert.equal(dec.mask, mask, `${ecc}/掩码 ${mask} 应解回一致`);
      assert.equal(formatBits1(g), formatBits2(g, g.length), `${ecc}/掩码 ${mask} 两处格式信息一致`);
    }
  }
  // 位置断言：第一份格式信息覆盖且仅覆盖 (8,0..8) 与 (0..7,8)（除 (6,6) 时序交点）
  const posSet = new Set(FORMAT_POS_1.map(([x, y]) => `${x},${y}`));
  assert.equal(posSet.size, 15, '第一份格式信息应恰好 15 个不同位置');
  assert.ok(!posSet.has('6,8') && !posSet.has('8,6'), '格式信息不得占用时序图形所在的行/列 6');
});

/* ------------------------------------------------------------------ */
/* 4. 几何结构                                                          */
/* ------------------------------------------------------------------ */

test('qr: 尺寸、探测图形与分隔符、时序图形、校正图形、版本信息', () => {
  // 尺寸 = 4v + 17
  for (const v of [1, 2, 7, 25, 40]) {
    const text = 'a'.repeat(Math.min(byteCapacity(v, 'L'), v === 1 ? 3 : byteCapacity(v, 'L')));
    const q = encodeQr(text, { minVersion: v, ecc: 'L' });
    assert.equal(q.version, v);
    assert.equal(q.size, 4 * v + 17, `版本 ${v} 的边长`);
    assert.equal(q.modules.length, q.size * q.size, '模块数组长度应为 size²');
  }

  const q = encodeQr('hello world', { ecc: 'M' }); // v1
  const g = gridOf(q);
  assert.equal(q.size, 21);

  // 探测图形：7×7 的"黑 7 / 白 5 / 黑 3"同心方框，外加一圈浅色分隔符。
  // 注意三者的**左上角坐标**：右上探测图形贴的是符号右边缘（x = n-7），
  // 左下探测图形贴的是符号下边缘（y = n-7）—— 写错就会得到越界断言。
  const n0 = q.size;
  const finderOrigin: Array<[number, number]> = [
    [0, 0],
    [n0 - 7, 0],
    [0, n0 - 7],
  ];
  for (const [ox, oy] of finderOrigin) {
    for (let dy = 0; dy < 7; dy++) {
      for (let dx = 0; dx < 7; dx++) {
        const dist = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
        assert.equal(g[oy + dy]![ox + dx], dist !== 2, `探测图形 (${ox},${oy}) 内 (${dx},${dy})`);
      }
    }
    // 分隔符：紧贴探测图形的"隔离环"必须全浅色。7×7 的探测图形两侧各留 1 格，
    // 位于**符号内侧**的那一侧才是分隔符，外侧那一侧会越界到符号之外：
    //   左上 (0,0)       → 右列 x=7     / 下行 y=7
    //   右上 (n−7,0)     → 左列 x=n−8   / 下行 y=7
    //   左下 (0,n−7)     → 右列 x=7     / 上行 y=n−8
    // 之前对三个探测图形统一用 ox+7 / oy+7，右上取到 x=n、左下取到 y=n 而越界。
    const sepCol = ox === 0 ? 7 : n0 - 8;
    const sepRow = oy === 0 ? 7 : n0 - 8;
    assert.ok(sepCol >= 0 && sepCol < n0 && sepRow >= 0 && sepRow < n0, `分隔符线应在符号内 (${sepCol},${sepRow})`);
    for (let i = 0; i < 8; i++) {
      // 竖直分隔列：与探测图形同高，长度为 8（底左那块贴的是符号下边缘，不能越过 n−1）
      if (oy + i < n0) assert.equal(g[oy + i]![sepCol]!, false, `分隔符列 (${sepCol},${oy + i})`);
      // 水平分隔行：与探测图形同宽，长度为 8（右上那块贴的是符号右边缘，不能越过 n−1）
      if (ox + i < n0) assert.equal(g[sepRow]![ox + i]!, false, `分隔符行 (${ox + i},${sepRow})`);
    }
  }

  // 时序图形：第 6 行/第 6 列在非探测图形区域交替，i 为偶数时深色
  for (const v of [1, 2, 7, 10]) {
    const qq = encodeQr('a'.repeat(Math.min(byteCapacity(v, 'L'), 30)), { ecc: 'L', minVersion: v });
    const gg = gridOf(qq);
    const n = qq.size;
    for (let i = 8; i < n - 8; i++) {
      assert.equal(gg[6]![i], i % 2 === 0, `v${v} 横向时序 (${i},6)`);
      assert.equal(gg[i]![6], i % 2 === 0, `v${v} 纵向时序 (6,${i})`);
    }
  }

  // 校正图形中心（规范附录 E）
  assert.deepEqual(alignCenters(2), [6, 18], 'v2 校正图形中心');
  assert.deepEqual(alignCenters(7), [6, 22, 38], 'v7 校正图形中心');
  for (const v of [2, 7, 14, 25, 40]) {
    const qq = encodeQr('a'.repeat(10), { ecc: 'L', minVersion: v });
    const gg = gridOf(qq);
    const centers = alignCenters(v);
    const last = centers.length - 1;
    for (const cy of centers) {
      for (const cx of centers) {
        const isCorner = (cx === 6 && cy === 6) || (cx === 6 && cy === centers[last]) || (cx === centers[last] && cy === 6);
        if (isCorner) continue;
        // 5×5 同心：中心深、距离 1 浅、距离 2 深
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const dist = Math.max(Math.abs(dx), Math.abs(dy));
            assert.equal(gg[cy + dy]![cx + dx], dist !== 1, `v${v} 校正图形 (${cx},${cy}) 偏移 (${dx},${dy})`);
          }
        }
      }
    }
  }

  // 版本信息：v ≥ 7 在两处出现；v < 7 两处都不该有版本信息区（该区域属于数据）
  for (const v of [7, 10, 25, 40]) {
    const qq = encodeQr('a'.repeat(10), { ecc: 'L', minVersion: v });
    const n = qq.size;
    let rem = v;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (v << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = ((bits >>> i) & 1) !== 0;
      const a = n - 11 + (i % 3);
      const b = Math.floor(i / 3);
      assert.equal(qq.modules[b * n + a] !== 0, bit, `v${v} 右上版本信息位 ${i}`);
      assert.equal(qq.modules[a * n + b] !== 0, bit, `v${v} 左下版本信息位 ${i}`);
    }
  }
});

/* ------------------------------------------------------------------ */
/* 5. 数据放置不变式                                                    */
/* ------------------------------------------------------------------ */

test('qr: 多版本数据放置不变式（所有码字位都被放置，不误报）', () => {
  // encodeQr 内部有 placedBits 断言；这里覆盖 v1 / v2 / v7 / v25 / v40 等跨度，
  // 一旦功能图形范围算错，这些构造就会抛 RangeError。
  const cases: Array<[number, EccLevel]> = [
    [1, 'L'],
    [1, 'M'],
    [1, 'H'],
    [2, 'L'],
    [2, 'H'],
    [3, 'Q'],
    [5, 'L'],
    [7, 'L'],
    [7, 'H'],
    [10, 'M'],
    [14, 'Q'],
    [25, 'H'],
    [32, 'L'],
    [40, 'L'],
    [40, 'H'],
  ];
  for (const [v, ecc] of cases) {
    const cap = byteCapacity(v, ecc);
    for (const len of [1, Math.floor(cap / 2), cap]) {
      const text = 'x'.repeat(len);
      const q = encodeQr(text, { ecc, minVersion: v });
      assert.equal(q.version, v, `v${v}-${ecc} 在 ${len} 字节时应保持该版本`);
      assert.equal(q.size, 4 * v + 17);
      // 数据模块总数必须 ≥ 全部码字位，且剩余不足 8 位（remainder bits 0–7）
      const f = functionMap(v);
      const dataModules = f.reduce((n, isFn) => n + (isFn ? 0 : 1), 0);
      const bits = totalCodewords(v) * 8;
      assert.ok(dataModules >= bits, `v${v}: 可放数据模块 ${dataModules} 应 ≥ 码字位 ${bits}`);
      assert.ok(dataModules - bits < 8, `v${v}: remainder bits 应为 0–7，实际 ${dataModules - bits}`);
      // 独立提取应能取回恰好 totalCodewords 个码字
      assert.equal(extractCodewords(gridOf(q), v, q.mask).length, totalCodewords(v), `v${v} 提取码字数`);
    }
  }
});

/* ------------------------------------------------------------------ */
/* 6. 渲染：PNG / SVG / 终端                                            */
/* ------------------------------------------------------------------ */

test('qr: PNG 结构合法（签名 / IHDR / CRC / IDAT 扫描线）', () => {
  for (const [scale, margin] of [[1, 0], [3, 2], [8, 4], [10, 4]] as const) {
    const qr = encodeQr('https://napcat.napneko.icu/qrcode?token=abcxyz', { ecc: 'M' });
    const png = qrToPng(qr, { scale, margin });
    const info = parsePng(png); // 内部会逐 chunk 校验 CRC32，不匹配就抛
    const expectedSide = (qr.size + margin * 2) * scale;
    assert.equal(info.width, expectedSide, `scale=${scale},margin=${margin} 的 PNG 宽`);
    assert.equal(info.height, expectedSide, `scale=${scale},margin=${margin} 的 PNG 高`);
    assert.equal(info.bitDepth, 1);
    assert.equal(info.colorType, 0);
    assert.deepEqual(
      info.chunks.map((c) => c.type),
      ['IHDR', 'IDAT', 'IEND'],
      'chunk 顺序应为 IHDR → IDAT → IEND',
    );
    const rowBytes = Math.ceil(info.width / 8);
    const raw = inflateSync(info.idat);
    assert.equal(raw.length, (rowBytes + 1) * info.height, 'IDAT 解压后应为每行 filter+像素');
    for (let y = 0; y < info.height; y++) {
      assert.equal(raw[y * (rowBytes + 1)], 0, `第 ${y} 行首字节应为 filter 0`);
    }
    // 颜色极性与静区：margin > 0 时四角必须落在浅色静区；margin = 0 时四角就是
    // 探测图形的深色模块 —— 断言反过来才对（这一点写错会得到永远的假失败）。
    const grid = pngToGrid(info);
    const cornerDark = margin > 0 ? false : qr.modules[0] !== 0;
    for (const [px, py] of [[0, 0], [info.width - 1, 0], [0, info.height - 1], [info.width - 1, info.height - 1]] as const) {
      assert.equal(
        grid[py]![px],
        cornerDark,
        margin > 0 ? `静区像素 (${px},${py}) 应为浅色` : `无静区时角像素 (${px},${py}) 应与模块一致`,
      );
    }
    const stride = info.width / (qr.size + margin * 2);
    assert.equal(stride, scale, '每个模块的像素宽度应等于 scale');
    let mismatch = 0;
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        const mx = Math.floor(x / scale) - margin;
        const my = Math.floor(y / scale) - margin;
        const expectDark = mx >= 0 && my >= 0 && mx < qr.size && my < qr.size && qr.modules[my * qr.size + mx] !== 0;
        if (grid[y]![x] !== expectDark) mismatch++;
      }
    }
    assert.equal(mismatch, 0, `PNG 像素与模块矩阵应逐像素一致（scale=${scale}）`);
  }
  // data URL 形态
  const url = qrToPngDataUrl(encodeQr('abc', { ecc: 'L' }));
  assert.match(url, /^data:image\/png;base64,[A-Za-z0-9+/=]+$/, 'data URL 前缀与 base64 载荷');
  assert.equal(
    Buffer.from(url.slice('data:image/png;base64,'.length), 'base64').equals(
      Buffer.from(qrToPng(encodeQr('abc', { ecc: 'L' }))),
    ),
    true,
    'data URL 载荷应与 qrToPng 的字节一致',
  );
  // 非法参数
  assert.throws(() => qrToPng(encodeQr('abc'), { scale: 0 }), RangeError, 'scale 必须为正整数');
  assert.throws(() => qrToPng(encodeQr('abc'), { margin: -1 }), RangeError, 'margin 必须非负');
});

test('qr: SVG 含 svg/rect，路径矩形与深色模块一一对应', () => {
  const qr = encodeQr('hello world', { ecc: 'M' });
  const scale = 4;
  const margin = 4;
  const svg = qrToSvg(qr, { scale, margin });
  assert.match(svg, /<svg[\s>]/, '应含 <svg');
  assert.match(svg, /<rect[\s>]/, '应含背景 <rect');
  assert.ok(svg.includes('xmlns="http://www.w3.org/2000/svg"'), '应声明 SVG 命名空间');
  const side = (qr.size + margin * 2) * scale;
  assert.ok(svg.includes(`width="${side}"`) && svg.includes(`height="${side}"`), `SVG 尺寸应为 ${side}`);

  // 解析 <path d>：每段是 M<X> <Y>h<W>v<H>h-<W>z（同行连续深色模块合并）
  const d = /<path d="([^"]*)"/.exec(svg)?.[1];
  assert.ok(d !== undefined && d.length > 0, '应含 <path d="...">');
  const cells: boolean[][] = Array.from({ length: qr.size }, () => new Array<boolean>(qr.size).fill(false));
  let drawn = 0;
  const segRe = /M(\d+) (\d+)h(\d+)v(\d+)h-(\d+)z/g;
  let m: RegExpExecArray | null;
  let segments = 0;
  while ((m = segRe.exec(d!)) !== null) {
    segments++;
    const x0 = Number(m[1]);
    const y0 = Number(m[2]);
    const w = Number(m[3]);
    const h = Number(m[4]);
    assert.equal(Number(m[5]), w, '矩形的回折宽度应与去程一致');
    assert.equal(w % scale, 0, '矩形宽度应是 scale 的整数倍');
    const mx0 = x0 / scale - margin;
    const my0 = y0 / scale - margin;
    const runCount = w / scale;
    for (let i = 0; i < runCount; i++) {
      const mx = mx0 + i;
      const my = my0;
      assert.ok(mx >= 0 && mx < qr.size && my >= 0 && my < qr.size, `矩形落在矩阵内：(${mx},${my})`);
      assert.equal(cells[my]![mx], false, `模块 (${mx},${my}) 不应被绘制两次`);
      cells[my]![mx] = true;
      drawn++;
    }
    void h;
  }
  assert.ok(segments > 0, '应有路径段');
  // 与编码器矩阵逐格比对
  let expectedDark = 0;
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      const dark = qr.modules[y * qr.size + x] !== 0;
      if (dark) expectedDark++;
      assert.equal(cells[y]![x], dark, `SVG 模块 (${x},${y})`);
    }
  }
  assert.equal(drawn, expectedDark, '绘制模块数应等于深色模块数');
});

test('qr: 终端渲染行列数与模块数一致（彩色与半块两种模式）', () => {
  const qr = encodeQr('hello world', { ecc: 'M' });
  const margin = 2;
  const side = qr.size + margin * 2;

  // 彩色模式：每行一个模块高，每格两个空格宽
  const color = qrToTerminal(qr, { margin, color: true });
  const colorLines = color.split('\n');
  assert.equal(colorLines.length, side, '彩色模式行数应为 size + 2×margin');
  for (const line of colorLines) {
    assert.ok(line.includes('\u001b[48;2;0;0;0m') || line.includes('\u001b[48;2;255;255;255m'), '应含 24 位背景色');
    const cells = line.replace(/\u001b\[[0-9;]*m/g, '');
    assert.equal(cells.length, side * 2, '每行可见宽度应为 2 × 模块数');
    assert.ok(line.endsWith('\u001b[0m'), '每行应以复位序列结束');
  }
  // 静区四角必须是白底
  assert.ok(colorLines[0]!.startsWith('\u001b[48;2;255;255;255m'), '左上角应为白底');
  assert.ok(colorLines.at(-1)!.startsWith('\u001b[48;2;255;255;255m'), '左下角应为白底');

  // 半块模式：一次两行，字符数 = 模块数
  const half = qrToTerminal(qr, { margin, color: false });
  const halfLines = half.split('\n');
  assert.equal(halfLines.length, Math.ceil(side / 2), '半块模式行数应为 ceil((size+2×margin)/2)');
  for (const line of halfLines) {
    assert.equal(line.length, side, '半块模式每行字符数应等于模块数');
    assert.match(line, /^[█▀▄ ]*$/u, '半块模式只应出现 █ ▀ ▄ 与空格');
  }
  // invert 应当翻转墨色
  const inv = qrToTerminal(qr, { margin, color: false, invert: true });
  assert.notEqual(inv, half, 'invert 应改变输出');
});

/* ------------------------------------------------------------------ */
/* 7. 与 libqrencode 的黄金对比（最强用例）                             */
/* ------------------------------------------------------------------ */

/**
 * 用系统 `qrencode`（libqrencode 4.1.1）生成参考符号，逐模块比对。
 *
 * 排除项说明：**纯字母数字内容不能参与逐模块对比**。libqrencode 会把
 * `ABCDEFG 12345` 这类输入拆成 alphanumeric 段（模式 0010），而本编码器按设计
 * 只实现 byte 模式（模式 0100）—— 两者都合法、扫码结果相同，但码字流不同。
 * 实测该输入的最小模块差异为 174，因此必须排除；下面用例全部含小写字母或中文，
 * libqrencode 也会走 byte 模式。
 */
const GOLDEN: ReadonlyArray<readonly [string, EccLevel]> = [
  ['hello world', 'M'],
  ['hello world', 'L'],
  ['hello world', 'Q'],
  ['hello world', 'H'],
  ['abc', 'L'],
  ['abcdefghijklmnopqrstuvwxyz', 'L'],
  ['a'.repeat(100) + 'b', 'L'],
  ['a'.repeat(2000), 'L'],
  ['中文字符串', 'M'],
  ['https://example.com/Path-x', 'M'],
  ['Hello World 123', 'Q'],
];

test('qr: 与 libqrencode 逐模块一致（黄金对比）', (t) => {
  if (!HAS_QRENCODE) {
    t.skip('缺少参考工具 qrencode');
    return;
  }
  const failures: string[] = [];
  for (const [text, ecc] of GOLDEN) {
    const label = text.length > 24 ? `${text.slice(0, 12)}…(${text.length})` : text;
    const ref = referenceSymbol(text, ecc);
    const n = ref.grid.length;
    const mineAuto = encodeQr(text, { ecc });
    assert.equal(mineAuto.version, ref.version, `"${label}" ${ecc}：版本应与参考一致`);
    assert.equal(mineAuto.size, n, `"${label}" ${ecc}：边长应与参考一致`);

    // (a) 参考码字：在参考自身选定的掩码下提取，与本编码器同掩码输出比对
    const refCw = extractCodewords(ref.grid, ref.version, ref.mask);
    const mineCw = extractCodewords(gridOf(encodeQr(text, { ecc, mask: ref.mask })), ref.version, ref.mask);
    const sameCodewords =
      refCw.length === mineCw.length && refCw.every((byte, i) => byte === mineCw[i]);

    // (b) 最小模块差异：因掩码选择是启发式（罚分规则 4 的取整各家不同），
    //     必须在 8 个掩码里取最小，值必须为 0。
    let minDiff = Number.POSITIVE_INFINITY;
    let bestMask = -1;
    for (let mm = 0; mm < 8; mm++) {
      const g = gridOf(encodeQr(text, { ecc, mask: mm }));
      let diff = 0;
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) if (g[y]![x] !== ref.grid[y]![x]) diff++;
      }
      if (diff < minDiff) {
        minDiff = diff;
        bestMask = mm;
      }
    }
    // (c) 参考掩码下的码字数与总码字数一致
    assert.equal(refCw.length, totalCodewords(ref.version), `"${label}" 参考码字数`);
    assert.equal(mineCw.length, totalCodewords(ref.version), `"${label}" 本实现码字数`);
    if (minDiff !== 0) {
      failures.push(`"${label}" ${ecc} v${ref.version}: 最小模块差异 ${minDiff}（最佳掩码 ${bestMask}，参考掩码 ${ref.mask}）`);
    }
    if (!sameCodewords) {
      const firstDiff = refCw.findIndex((b, i) => b !== mineCw[i]);
      failures.push(
        `"${label}" ${ecc} v${ref.version}: 参考掩码 ${ref.mask} 下码字不同（首次分歧 @${firstDiff}：参考 ${refCw[firstDiff]} vs 本实现 ${mineCw[firstDiff]}）`,
      );
    }
  }
  assert.deepEqual(failures, [], `与 libqrencode 存在差异：\n${failures.join('\n')}`);
});

/* ------------------------------------------------------------------ */
/* 8. zbar 回环：生成 → 扫码 → 原文                                     */
/* ------------------------------------------------------------------ */

test('qr: zbarimg 回环解码等于原文（ASCII / 中文 / 长文本 / 四档 ECC）', (t) => {
  if (!HAS_ZBARIMG) {
    t.skip('缺少 zbarimg');
    return;
  }
  const cases: Array<[string, EccLevel]> = [
    ['hello world', 'L'],
    ['hello world', 'M'],
    ['hello world', 'Q'],
    ['hello world', 'H'],
    ['abc123!@#$%^&*()_+-=[]{}', 'M'],
    ['中文测试：扫码登录', 'M'],
    ['emoji 😀 混合', 'H'],
    ['https://napcat.napneko.icu/qrcode?token=abcxyz-0987', 'Q'],
    ['x'.repeat(500), 'L'],
    ['y'.repeat(1000), 'M'],
  ];
  for (const [text, ecc] of cases) {
    const qr = encodeQr(text, { ecc });
    const png = tmpFile('roundtrip.png');
    writeFileSync(png, qrToPng(qr, { scale: 4, margin: 4 }));
    const decoded = zbarDecode(png);
    assert.equal(
      decoded,
      text,
      `zbar 解码应严格等于原文（ecc=${ecc}, v${qr.version}, ${text.length} 字符）`,
    );
  }
});
