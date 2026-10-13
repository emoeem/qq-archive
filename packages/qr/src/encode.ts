/**
 * 纯 TypeScript QR Code 编码器 —— **零依赖**（只用语言本身，连 node: 内置模块都不用）。
 *
 * 为什么自己写：本项目的硬约束是「生产依赖 0 个」，而登录 QQ 需要把 NapCat 返回的
 * 登录二维码渲染成图片 / 终端字符画。第三方 QR 库会打破这条约束，因此按
 * ISO/IEC 18004 自己实现 byte 模式编码（版本 1–40，纠错等级 L/M/Q/H）。
 *
 * 正确性不是靠"看起来像"：`tests/qr.test.ts` 会用系统里的 `qrencode` 做逐模块比对，
 * 并用 `zbarimg` 做"扫回来是不是原文"的解码回归。
 *
 * 实现范围与取舍：
 *  - 只做 **byte 模式**（0100）。登录二维码内容是 URL，数字/字母数字模式的压缩收益无意义。
 *  - 不做 ECI：UTF-8 字节直接写入，与 `qrencode` 的默认行为一致（中文内容也能编码）。
 *  - 字符计数指示符按版本选 8/16 位，版本 ≥ 7 写版本信息，掩码用规范的四条罚分规则自动选。
 */

/** 纠错等级。数值索引与下方两张表的下标一一对应。 */
export type EccLevel = 'L' | 'M' | 'Q' | 'H';

/** 纠错等级在格式信息里的 2 位编码（不是数组下标）。 */
const ECC_FORMAT_BITS: Record<EccLevel, number> = { L: 1, M: 0, Q: 3, H: 2 };

const ECC_INDEX: Record<EccLevel, number> = { L: 0, M: 1, Q: 2, H: 3 };

/**
 * 每个 RS 块的纠错码字数。行 = 纠错等级（L/M/Q/H），列 = 版本 1..40。
 * 这是 ISO/IEC 18004 的表 9；不是推导出来的常量，只能查表。
 */
const ECC_CODEWORDS_PER_BLOCK: readonly (readonly number[])[] = [
  // 版本       1   2   3   4   5   6   7   8   9  10  11  12  13  14  15  16  17  18  19  20  21  22  23  24  25  26  27  28  29  30  31  32  33  34  35  36  37  38  39  40
  [7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // L
  [10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28], // M
  [13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // Q
  [17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // H
];

/** RS 块个数（表 9 的另一半）。行 = 纠错等级。 */
const NUM_ECC_BLOCKS: readonly (readonly number[])[] = [
  [1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25], // L
  [1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49], // M
  [1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68], // Q
  [1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81], // H
];

/** 罚分权重（规范表 11）。 */
const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

export interface QrCode {
  /** 符号版本 1–40。 */
  version: number;
  /** 边长（模块数）= 17 + 4 × version。 */
  size: number;
  /** 纠错等级。 */
  ecc: EccLevel;
  /** 选中的掩码编号 0–7。 */
  mask: number;
  /** 位图，长度 size²，按行优先；非 0 表示深色模块。 */
  modules: Uint8Array;
}

/** 取整数 x 的第 i 位（i=0 是最低位）。 */
function getBit(x: number, i: number): boolean {
  return ((x >>> i) & 1) !== 0;
}

/* ------------------------------------------------------------------ */
/* GF(256) 上的 Reed–Solomon                                           */
/* ------------------------------------------------------------------ */

/** RS 生成多项式系数（升幂，最高次项固定为 1，故未存入）。 */
export function reedSolomonDivisor(degree: number): Uint8Array {
  if (degree < 0 || degree > 255) throw new RangeError(`RS 生成多项式次数非法：${degree}`);
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  // 逐次乘 (x - α^i)
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      const cur = result[j]!;
      result[j] = gfMul(cur, root);
      if (j + 1 < degree) result[j] = result[j]! ^ result[j + 1]!;
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

export function reedSolomonRemainder(data: Uint8Array, divisor: Uint8Array): Uint8Array {
  const result = new Uint8Array(divisor.length);
  for (const b of data) {
    const factor = b ^ result[0]!;
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let i = 0; i < result.length; i++) {
      result[i] = result[i]! ^ gfMul(divisor[i]!, factor);
    }
  }
  return result;
}

/** GF(2⁸) 乘法，本原多项式 0x11D（x⁸+x⁴+x³+x²+1）。 */
function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

/* ------------------------------------------------------------------ */
/* 容量与版本选择                                                       */
/* ------------------------------------------------------------------ */

/**
 * 该版本可用于数据+纠错的总模块位数（扣除功能图形与格式/版本信息）。
 * 这是规范里的固定公式，不是查表值。
 */
export function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

/** 该版本 + 纠错等级下的总码字数（数据 + 纠错）。 */
export function totalCodewords(version: number): number {
  return Math.floor(rawDataModules(version) / 8);
}

/** 该版本 + 纠错等级下的**数据**码字数。 */
export function numDataCodewords(version: number, ecc: EccLevel): number {
  const i = ECC_INDEX[ecc];
  return (
    totalCodewords(version) -
    ECC_CODEWORDS_PER_BLOCK[i]![version - 1]! * NUM_ECC_BLOCKS[i]![version - 1]!
  );
}

/** byte 模式的字符计数指示符位宽：版本 1–9 为 8 位，10–40 为 16 位。 */
function charCountBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

export interface EncodeOptions {
  /** 纠错等级，默认 `M`（屏幕上扫码的常用档）。 */
  ecc?: EccLevel;
  /** 最小版本（强制"至少这么大"），用于多个二维码尺寸对齐，默认 1。 */
  minVersion?: number;
  /**
   * 强制指定掩码 0–7，跳过罚分搜索。
   *
   * 掩码选择是**实现自定义**的：规范只要求挑"罚分最低"的那个，而不同实现对
   * 罚分规则 4 的取整处理不同（libqrencode 与 ISO 字面描述就有差异），所以两个
   * 都正确的实现可能选到不同掩码。留出这个开关是为了：
   *  1. 测试时能和参考实现（qrencode）逐模块对齐，从而验证 ECC/布线/格式信息；
   *  2. 需要输出**可复现**二维码时（缓存、快照测试）不受启发式影响。
   */
  mask?: number;
}

/**
 * 把一段文本编码成 QR 符号。
 *
 * @throws RangeError 文本过长（大于版本 40 的容量）时抛出。
 */
export function encodeQr(text: string, opts: EncodeOptions = {}): QrCode {
  const ecc = opts.ecc ?? 'M';
  const minVersion = opts.minVersion ?? 1;
  if (!(ecc in ECC_FORMAT_BITS)) throw new RangeError(`未知纠错等级：${String(ecc)}`);
  if (!Number.isInteger(minVersion) || minVersion < 1 || minVersion > 40) {
    throw new RangeError(`minVersion 超出范围：${String(opts.minVersion)}`);
  }
  const bytes = new TextEncoder().encode(text);

  // 选版本：找到最小的、能装下 `4 + 计数位 + 8n` 位的版本。
  let version = 0;
  for (let v = minVersion; v <= 40; v++) {
    const capacityBits = numDataCodewords(v, ecc) * 8;
    if (4 + charCountBits(v) + bytes.length * 8 <= capacityBits) {
      version = v;
      break;
    }
  }
  if (version === 0) {
    throw new RangeError(
      `内容过长，无法编码：${bytes.length} 字节（版本 40 / ${ecc} 上限 ${Math.floor(
        (numDataCodewords(40, ecc) * 8 - 4 - 16) / 8,
      )} 字节）`,
    );
  }

  const data = buildDataCodewords(bytes, version, ecc);
  const allCodewords = addEccAndInterleave(data, version, ecc);
  return buildSymbol(allCodewords, version, ecc, opts.mask);
}

/** 位流组装：模式指示符 + 计数 + 数据 + 终止符 + 位填充 + 0xEC/0x11 填充字节。 */
function buildDataCodewords(bytes: Uint8Array, version: number, ecc: EccLevel): Uint8Array {
  const capacityBits = numDataCodewords(version, ecc) * 8;
  const bits: number[] = [];
  const push = (value: number, len: number): void => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };

  push(0b0100, 4); // byte 模式
  push(bytes.length, charCountBits(version));
  for (const b of bytes) push(b, 8);

  // 终止符最多 4 个 0 位
  const terminator = Math.min(4, capacityBits - bits.length);
  push(0, terminator);
  // 补齐到字节边界
  push(0, (8 - (bits.length % 8)) % 8);
  // 交替填充字节
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) {
    push(pad, 8);
  }

  const out = new Uint8Array(bits.length / 8);
  for (let i = 0; i < bits.length; i++) {
    if (bits[i] !== 0) out[i >>> 3] = out[i >>> 3]! | (1 << (7 - (i & 7)));
  }
  return out;
}

/** 分块 → 每块算 RS 纠错 → 按规范交错排列。 */
function addEccAndInterleave(data: Uint8Array, version: number, ecc: EccLevel): Uint8Array {
  const i = ECC_INDEX[ecc];
  const numBlocks = NUM_ECC_BLOCKS[i]![version - 1]!;
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[i]![version - 1]!;
  const rawCodewords = totalCodewords(version);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);
  if (data.length !== numDataCodewords(version, ecc)) {
    throw new RangeError('数据码字数与版本容量不符（内部错误）');
  }

  const divisor = reedSolomonDivisor(blockEccLen);
  const blocks: number[][] = [];
  for (let b = 0, k = 0; b < numBlocks; b++) {
    const datLen = shortBlockLen - blockEccLen + (b < numShortBlocks ? 0 : 1);
    const dat = Array.from(data.subarray(k, k + datLen));
    k += datLen;
    const rs = Array.from(reedSolomonRemainder(Uint8Array.from(dat), divisor));
    // 短块用一个 0 占位，交错时再跳过，保证所有块等长便于按列读取。
    blocks.push(b < numShortBlocks ? [...dat, 0, ...rs] : [...dat, ...rs]);
  }

  const result = new Uint8Array(rawCodewords);
  let idx = 0;
  const blockLen = blocks[0]!.length;
  for (let pos = 0; pos < blockLen; pos++) {
    for (let b = 0; b < numBlocks; b++) {
      // 跳过短块里那个占位 0（它位于数据段末尾、纠错段之前）。
      if (pos === shortBlockLen - blockEccLen && b < numShortBlocks) continue;
      result[idx++] = blocks[b]![pos]!;
    }
  }
  if (idx !== rawCodewords) throw new RangeError('交错码字数不符（内部错误）');
  return result;
}

/* ------------------------------------------------------------------ */
/* 符号构造：功能图形 → 数据放置 → 掩码                               */
/* ------------------------------------------------------------------ */

function buildSymbol(
  codewords: Uint8Array,
  version: number,
  ecc: EccLevel,
  forcedMask?: number,
): QrCode {
  const size = version * 4 + 17;
  const modules = new Uint8Array(size * size);
  const isFunction = new Uint8Array(size * size);

  const setFunction = (x: number, y: number, dark: boolean): void => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    modules[y * size + x] = dark ? 1 : 0;
    isFunction[y * size + x] = 1;
  };

  const drawFinder = (cx: number, cy: number): void => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        setFunction(cx + dx, cy + dy, dist !== 2 && dist !== 4);
      }
    }
  };

  const drawAlignment = (cx: number, cy: number): void => {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        setFunction(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  };

  const drawFormatBits = (mask: number): void => {
    const data = (ECC_FORMAT_BITS[ecc] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;

    for (let i = 0; i <= 5; i++) setFunction(8, i, getBit(bits, i));
    setFunction(8, 7, getBit(bits, 6));
    setFunction(8, 8, getBit(bits, 7));
    setFunction(7, 8, getBit(bits, 8));
    for (let i = 9; i < 15; i++) setFunction(14 - i, 8, getBit(bits, i));

    for (let i = 0; i < 8; i++) setFunction(size - 1 - i, 8, getBit(bits, i));
    for (let i = 8; i < 15; i++) setFunction(8, size - 15 + i, getBit(bits, i));
    setFunction(8, size - 8, true); // 固定深色模块
  };

  const drawVersionInfo = (): void => {
    if (version < 7) return;
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = getBit(bits, i);
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunction(a, b, bit);
      setFunction(b, a, bit);
    }
  };

  /** 对齐图形中心坐标（规范附录 E 的公式）。 */
  const alignmentPositions = (): number[] => {
    if (version === 1) return [];
    const numAlign = Math.floor(version / 7) + 2;
    const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
    const result: number[] = [6];
    for (let pos = version * 4 + 10; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
    return result;
  };

  // 1) 时序图形
  for (let i = 0; i < size; i++) {
    setFunction(6, i, i % 2 === 0);
    setFunction(i, 6, i % 2 === 0);
  }
  // 2) 三个探测图形
  drawFinder(3, 3);
  drawFinder(size - 4, 3);
  drawFinder(3, size - 4);
  // 3) 校正图形（与探测图形重叠的位置跳过）
  const alignPos = alignmentPositions();
  for (let i = 0; i < alignPos.length; i++) {
    for (let j = 0; j < alignPos.length; j++) {
      const corner =
        (i === 0 && j === 0) ||
        (i === 0 && j === alignPos.length - 1) ||
        (i === alignPos.length - 1 && j === 0);
      if (!corner) drawAlignment(alignPos[i]!, alignPos[j]!);
    }
  }
  // 4) 格式信息（占位掩码 0）与版本信息
  drawFormatBits(0);
  drawVersionInfo();

  // 5) 数据放置：从右下角开始、每两列一组、向上/向下交替的"蛇形"
  let placedBits = 0;
  {
    let bitIndex = 0;
    const totalBits = codewords.length * 8;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5; // 跳过被时序图形占据的第 6 列
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          const idx = y * size + x;
          if (isFunction[idx] === 0 && bitIndex < totalBits) {
            modules[idx] = getBit(codewords[bitIndex >>> 3]!, 7 - (bitIndex & 7)) ? 1 : 0;
            bitIndex++;
          }
          // 剩余位（remainder bits）保持浅色，不置位
        }
      }
    }
    placedBits = bitIndex;
  }
  // 不变式：所有码字位都必须被放置。否则说明功能图形被多标了，
  // 会静默丢弃末尾的数据/纠错位 —— 这种错误肉眼看不出来，但符号已经损坏。
  if (placedBits !== codewords.length * 8) {
    throw new RangeError(
      `数据位未全部放置：${placedBits}/${codewords.length * 8}（内部错误：功能图形范围计算有误）`,
    );
  }

  // 6) 掩码：试 8 种，取罚分最低的
  const applyMask = (mask: number): void => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const idx = y * size + x;
        if (isFunction[idx] !== 0) continue;
        let invert: boolean;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          case 7: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: throw new RangeError(`掩码编号非法：${mask}`);
        }
        if (invert) modules[idx] = modules[idx]! ^ 1;
      }
    }
  };

  const at = (x: number, y: number): number => modules[y * size + x]!;
  const penalty = (): number => {
    let result = 0;
    const history = (): number[] => [0, 0, 0, 0, 0, 0, 0];
    const addHistory = (len: number, hist: number[]): void => {
      if (hist[0] === 0) len += size; // 给起始段补上浅色边界
      hist.pop();
      hist.unshift(len);
    };
    const countPatterns = (hist: number[]): number => {
      const n = hist[1]!;
      const core =
        n > 0 && hist[2] === n && hist[3] === n * 3 && hist[4] === n && hist[5] === n;
      return (
        (core && hist[0]! >= n * 4 && hist[6]! >= n ? 1 : 0) +
        (core && hist[6]! >= n * 4 && hist[0]! >= n ? 1 : 0)
      );
    };
    const finish = (color: boolean, len: number, hist: number[]): number => {
      let run = len;
      if (color) {
        addHistory(run, hist);
        run = 0;
      }
      run += size;
      addHistory(run, hist);
      return countPatterns(hist);
    };

    // 规则 1 + 规则 3：行
    for (let y = 0; y < size; y++) {
      let color = false;
      let run = 0;
      const hist = history();
      for (let x = 0; x < size; x++) {
        const dark = at(x, y) !== 0;
        if (dark === color) {
          run++;
          if (run === 5) result += PENALTY_N1;
          else if (run > 5) result++;
        } else {
          addHistory(run, hist);
          if (!color) result += countPatterns(hist) * PENALTY_N3;
          color = dark;
          run = 1;
        }
      }
      result += finish(color, run, hist) * PENALTY_N3;
    }
    // 规则 1 + 规则 3：列
    for (let x = 0; x < size; x++) {
      let color = false;
      let run = 0;
      const hist = history();
      for (let y = 0; y < size; y++) {
        const dark = at(x, y) !== 0;
        if (dark === color) {
          run++;
          if (run === 5) result += PENALTY_N1;
          else if (run > 5) result++;
        } else {
          addHistory(run, hist);
          if (!color) result += countPatterns(hist) * PENALTY_N3;
          color = dark;
          run = 1;
        }
      }
      result += finish(color, run, hist) * PENALTY_N3;
    }
    // 规则 2：2×2 同色块
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = at(x, y);
        if (c === at(x + 1, y) && c === at(x, y + 1) && c === at(x + 1, y + 1)) {
          result += PENALTY_N2;
        }
      }
    }
    // 规则 4：深色比例偏离 50%
    let dark = 0;
    for (let i = 0; i < modules.length; i++) dark += modules[i]!;
    const total = size * size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += k * PENALTY_N4;
    return result;
  };

  if (forcedMask !== undefined) {
    if (!Number.isInteger(forcedMask) || forcedMask < 0 || forcedMask > 7) {
      throw new RangeError(`mask 必须是 0–7 的整数：${String(forcedMask)}`);
    }
    applyMask(forcedMask);
    drawFormatBits(forcedMask);
    return { version, size, ecc, mask: forcedMask, modules };
  }

  let bestMask = 0;
  let bestPenalty = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(mask);
    drawFormatBits(mask);
    const score = penalty();
    if (score < bestPenalty) {
      bestPenalty = score;
      bestMask = mask;
    }
    applyMask(mask); // 掩码是自逆的：再异或一次即还原
  }
  applyMask(bestMask);
  drawFormatBits(bestMask);

  return { version, size, ecc, mask: bestMask, modules };
}
