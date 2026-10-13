/**
 * `@qq-archive/qr` —— 零依赖 QR Code 编码与渲染。
 *
 * 用于把 NapCat 返回的登录二维码（URL）渲染成 PNG / SVG / 终端字符画，
 * 以及把 2FA 助手 URL 之类的短链直接转成可扫图。
 */
export type { EccLevel, QrCode, EncodeOptions } from './encode.ts';
export {
  encodeQr,
  reedSolomonDivisor,
  reedSolomonRemainder,
  rawDataModules,
  totalCodewords,
  numDataCodewords,
} from './encode.ts';
export type { RenderOptions, TerminalOptions } from './render.ts';
export { qrToPng, qrToPngDataUrl, qrToSvg, qrToTerminal } from './render.ts';
