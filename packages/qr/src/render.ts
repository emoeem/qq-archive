/**
 * QR 符号渲染器：PNG / SVG / 终端字符画。零依赖。
 *
 * PNG 只依赖 node:zlib（内置）。输出 **1 位灰度 PNG**（彩度 0、位深 1），
 * 这是扫码识别的理想输入，也避免了调色板与抗锯齿带来的灰度抖动：
 * 深色模块 = 0（黑）、浅色模块 = 1（白），无任何缩放插值。
 */
import { deflateSync } from 'node:zlib';
import type { QrCode } from './encode.ts';

export interface RenderOptions {
  /** 每个模块放大成多少像素（PNG/SVG），默认 8。 */
  scale?: number;
  /** 静区宽度（单位：模块），QR 规范要求 ≥ 4，默认 4。 */
  margin?: number;
}

const DEFAULT_SCALE = 8;
const DEFAULT_MARGIN = 4;

/** 判断 (x, y) 模组是否深色，越界（静区）视为浅色。 */
function isDark(qr: QrCode, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= qr.size || y >= qr.size) return false;
  return qr.modules[y * qr.size + x] !== 0;
}

/* ------------------------------------------------------------------ */
/* PNG                                                                 */
/* ------------------------------------------------------------------ */

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crcInput = out.subarray(4, 8 + data.length);
  view.setUint32(8 + data.length, crc32(crcInput));
  return out;
}

/**
 * 渲染为 PNG 字节（1 位灰度）。
 *
 * @param qr `encodeQr` 的结果
 */
export function qrToPng(qr: QrCode, opts: RenderOptions = {}): Uint8Array {
  const scale = opts.scale ?? DEFAULT_SCALE;
  const margin = opts.margin ?? DEFAULT_MARGIN;
  if (!Number.isInteger(scale) || scale < 1) throw new RangeError(`scale 必须是正整数：${scale}`);
  if (!Number.isInteger(margin) || margin < 0) throw new RangeError(`margin 必须是非负整数：${margin}`);

  const modulesPerSide = qr.size + margin * 2;
  const pixelsPerSide = modulesPerSide * scale;
  const rowBytes = Math.ceil(pixelsPerSide / 8);
  // 每行：1 字节滤波器（0 = None）+ 打包后的位
  const raw = new Uint8Array((rowBytes + 1) * pixelsPerSide);
  for (let py = 0; py < pixelsPerSide; py++) {
    const my = Math.floor(py / scale) - margin;
    const rowStart = py * (rowBytes + 1);
    raw[rowStart] = 0;
    for (let mx = 0; mx < modulesPerSide; mx++) {
      const dark = isDark(qr, mx - margin, my);
      // 灰度位深 1：0 = 黑，1 = 白
      if (dark) continue; // 默认 0，深色模块无需写
      const basePx = mx * scale;
      for (let s = 0; s < scale; s++) {
        const px = basePx + s;
        raw[rowStart + 1 + (px >>> 3)] = raw[rowStart + 1 + (px >>> 3)]! | (0x80 >>> (px & 7));
      }
    }
  }

  const ihdr = new Uint8Array(13);
  const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, pixelsPerSide);
  iv.setUint32(4, pixelsPerSide);
  ihdr[8] = 1; // 位深
  ihdr[9] = 0; // 颜色类型：灰度
  ihdr[10] = 0; // 压缩方法
  ihdr[11] = 0; // 滤波方法
  ihdr[12] = 0; // 隔行扫描：关

  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw, { level: 9 }))),
    chunk('IEND', new Uint8Array(0)),
  ];
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** 渲染为 `data:image/png;base64,...`，可直接塞进 <img src>。 */
export function qrToPngDataUrl(qr: QrCode, opts: RenderOptions = {}): string {
  return `data:image/png;base64,${Buffer.from(qrToPng(qr, opts)).toString('base64')}`;
}

/* ------------------------------------------------------------------ */
/* SVG                                                                 */
/* ------------------------------------------------------------------ */

/** 渲染为 SVG 字符串（矢量，可无限放大）。 */
export function qrToSvg(qr: QrCode, opts: RenderOptions = {}): string {
  const scale = opts.scale ?? DEFAULT_SCALE;
  const margin = opts.margin ?? DEFAULT_MARGIN;
  const side = (qr.size + margin * 2) * scale;
  const parts: string[] = [];
  for (let y = 0; y < qr.size; y++) {
    let x = 0;
    while (x < qr.size) {
      if (!isDark(qr, x, y)) {
        x++;
        continue;
      }
      // 合并同行连续深色模块，减少 path 体积
      let run = 1;
      while (x + run < qr.size && isDark(qr, x + run, y)) run++;
      parts.push(
        `M${(x + margin) * scale} ${(y + margin) * scale}h${run * scale}v${scale}h-${run * scale}z`,
      );
      x += run;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${side}" height="${side}" ` +
    `viewBox="0 0 ${side} ${side}" shape-rendering="crispEdges">` +
    `<rect width="${side}" height="${side}" fill="#ffffff"/>` +
    `<path d="${parts.join('')}" fill="#000000"/>` +
    `</svg>`
  );
}

/* ------------------------------------------------------------------ */
/* 终端                                                                */
/* ------------------------------------------------------------------ */

export interface TerminalOptions {
  /** 静区宽度（模块），默认 2（终端里 4 会太宽）。 */
  margin?: number;
  /**
   * 用 24 位 ANSI 背景色渲染（默认 true）—— 无论终端主题是深是浅，
   * 都是「白底黑码」的正确极性，可被手机直接扫。
   * 置为 false 则用半块字符（▀▄█）以当前前景色作墨色，体积小但依赖终端配色。
   */
  color?: boolean;
  /** 仅 `color: false` 时有意义：翻转墨色（浅色模块当墨）。 */
  invert?: boolean;
}

const ESC = '\u001b[';
const BLACK_BG = `${ESC}48;2;0;0;0m`;
const WHITE_BG = `${ESC}48;2;255;255;255m`;
const RESET = `${ESC}0m`;

/** 渲染为终端可打印字符画。 */
export function qrToTerminal(qr: QrCode, opts: TerminalOptions = {}): string {
  const margin = opts.margin ?? 2;
  const color = opts.color ?? true;
  const invert = opts.invert ?? false;
  const size = qr.size + margin * 2;
  const lines: string[] = [];

  const dark = (x: number, y: number): boolean => {
    const d = isDark(qr, x - margin, y - margin);
    return invert ? !d : d;
  };

  if (color) {
    for (let y = 0; y < size; y++) {
      let line = '';
      let current: boolean | null = null;
      for (let x = 0; x < size; x++) {
        const d = dark(x, y);
        if (d !== current) {
          line += d ? BLACK_BG : WHITE_BG;
          current = d;
        }
        line += '  '; // 两格宽，模块接近正方形（终端字符高宽比约 2:1）
      }
      lines.push(line + RESET);
    }
    return lines.join('\n');
  }

  // 半块模式：一次两行，▀ = 上半深、▄ = 下半深、█ = 全深、空格 = 全浅
  for (let y = 0; y < size; y += 2) {
    let line = '';
    for (let x = 0; x < size; x++) {
      const top = dark(x, y);
      const bottom = y + 1 < size ? dark(x, y + 1) : false;
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(line);
  }
  return lines.join('\n');
}
