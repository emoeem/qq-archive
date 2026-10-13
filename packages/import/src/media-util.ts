/**
 * 平台无关的 MIME / 扩展名 / 媒体种类推断。
 *
 * 归档侧只做「保守推断」：拿不到就返回 null / 'file'，绝不为了好看而瞎猜（例如把 .bin 猜成图片）。
 * 真正权威的 mime 由 web 层用扩展名兜底展示。
 */
import type { MediaKind } from '../../core/src/index.ts';
import { safeFilename } from '../../core/src/index.ts';

/** 常见扩展名 → MIME。键一律小写、不带点。 */
export const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpe: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  heic: 'image/heic',
  heif: 'image/heif',
  avif: 'image/avif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
  flv: 'video/x-flv',
  wmv: 'video/x-ms-wmv',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
  ts: 'video/mp2t',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/opus',
  flac: 'audio/flac',
  amr: 'audio/amr',
  ape: 'audio/x-ape',
  silk: 'audio/silk',
  slk: 'audio/silk',
  wma: 'audio/x-ms-wma',
  pdf: 'application/pdf',
  txt: 'text/plain',
  log: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  md: 'text/markdown',
  zip: 'application/zip',
  rar: 'application/vnd.rar',
  '7z': 'application/x-7z-compressed',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  bz2: 'application/x-bzip2',
  apk: 'application/vnd.android.package-archive',
  exe: 'application/vnd.microsoft.portable-executable',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  db: 'application/octet-stream',
  bin: 'application/octet-stream',
};

/** 每种媒体种类的默认扩展名（当文件名与 URL 都推不出扩展名时使用）。 */
export const DEFAULT_EXT_BY_KIND: Record<MediaKind, string> = {
  image: 'jpg',
  video: 'mp4',
  audio: 'm4a',
  file: 'bin',
  other: 'bin',
};

const KIND_ALIASES: Record<string, MediaKind> = {
  image: 'image',
  img: 'image',
  photo: 'image',
  picture: 'image',
  pic: 'image',
  sticker: 'image',
  emoji: 'image',
  market_face: 'image',
  video: 'video',
  short_video: 'video',
  tiny_video: 'video',
  video_file: 'video',
  audio: 'audio',
  voice: 'audio',
  record: 'audio',
  ptt: 'audio',
  amr: 'audio',
  silk: 'audio',
  file: 'file',
  doc: 'file',
  document: 'file',
  archive: 'file',
  other: 'other',
};

/** 源数据里的 type 字段 → 归档的 MediaKind（未知一律 'file'）。 */
export function kindFromType(type: unknown): MediaKind {
  if (typeof type !== 'string') return 'file';
  return KIND_ALIASES[type.trim().toLowerCase()] ?? 'file';
}

/** 该 media kind 是否值得下载/归档（'other' 视为 file）。 */
export function isArchivableKind(kind: MediaKind): boolean {
  return kind === 'image' || kind === 'video' || kind === 'audio' || kind === 'file';
}

/** 归一化扩展名：去掉点、只留字母数字、限长 8，非法返回 null。 */
export function normalizeExt(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = String(raw).trim().toLowerCase().replace(/^\.+/, '');
  if (!/^[a-z0-9]{1,8}$/.test(cleaned)) return null;
  return cleaned;
}

/** 从文件名取扩展名（不查表，纯字符串）。 */
export function extOfName(name: string | null | undefined): string | null {
  if (!name) return null;
  const base = String(name).replace(/[?#].*$/, '');
  const idx = base.lastIndexOf('.');
  if (idx <= 0 || idx === base.length - 1) return null;
  return normalizeExt(base.slice(idx + 1));
}

/** 从 URL 取扩展名（会剥掉 query/hash）。 */
export function extFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  let path = String(url);
  try {
    path = new URL(path).pathname;
  } catch {
    // 不是合法 URL（相对路径等），退化为手动剥离
    path = path.replace(/[?#].*$/, '');
  }
  return extOfName(path);
}

/** 扩展名 → MIME，未知返回 null。 */
export function mimeForExt(ext: string | null | undefined): string | null {
  const e = normalizeExt(ext);
  if (!e) return null;
  return MIME_BY_EXT[e] ?? null;
}

/** 从 URL 的 pathname 取一个像样的文件名（解码 %XX）。 */
export function filenameFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    path = String(url).replace(/[?#].*$/, '');
  }
  const seg = path.split('/').filter(Boolean).pop();
  if (!seg) return null;
  let decoded = seg;
  try {
    decoded = decodeURIComponent(seg);
  } catch {
    decoded = seg;
  }
  return decoded.length > 0 ? decoded : null;
}

/** 用 `safeFilename` 归一化一个「想落盘的名字」，并保证带上扩展名。 */
export function normalizeFilename(
  name: string | null | undefined,
  fallbackExt: string,
): string | null {
  if (!name) return null;
  const cleaned = String(name).trim();
  if (!cleaned) return null;
  return safeFilename(cleaned, fallbackExt);
}

/**
 * 内容寻址相对路径：`<kind>/<yyyy>/<mm>/<sha256 前 2 位>/<sha256>.<ext>`。
 * 全部使用本地时区的年月，便于运维按目录清理。
 */
export function mediaRelPath(kind: MediaKind, sha256: string, at: Date, ext: string): string {
  const yyyy = String(at.getFullYear()).padStart(4, '0');
  const mm = String(at.getMonth() + 1).padStart(2, '0');
  const e = normalizeExt(ext) ?? DEFAULT_EXT_BY_KIND[kind];
  return `${kind}/${yyyy}/${mm}/${sha256.slice(0, 2)}/${sha256}.${e}`;
}

/** 图片 / 视频之外不生成缩略图。 */
export function canHaveThumb(kind: MediaKind): boolean {
  return kind === 'image' || kind === 'video';
}
