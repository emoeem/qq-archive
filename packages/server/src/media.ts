/**
 * 媒体文件访问的安全与流式辅助。
 *
 * 硬性规则（ARCHITECTURE 第 6 节）：
 *  - 路径**只能**来自数据库的 `rel_path` / `thumb_path`，绝不接受用户传入的文件路径；
 *  - `resolve(mediaDir, relPath)` 的结果必须以 `mediaDir + sep` 开头，否则 400；
 *  - 文件存在时再做一次 realpath 校验，防止符号链接逃逸。
 */
import { createHash } from 'node:crypto';
import { createReadStream, realpathSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { HttpError, mimeForPath } from './http.ts';

/** `p` 是否等于 `root` 或位于 `root` 之下。 */
export function withinRoot(root: string, p: string): boolean {
  const r = resolve(root);
  const target = resolve(p);
  return target === r || target.startsWith(r.endsWith(sep) ? r : r + sep);
}

/** 由数据库里的相对路径解析出绝对路径；越界/空/含 NUL 一律 400。 */
export function resolveSafePath(root: string, rel: string, what = '媒体'): string {
  if (typeof rel !== 'string' || rel.trim() === '') throw new HttpError(400, 'BAD_REQUEST', `${what}路径为空`);
  if (rel.includes('\0')) throw new HttpError(400, 'BAD_REQUEST', `${what}路径含非法字符`);
  const rootAbs = resolve(root);
  const abs = resolve(rootAbs, rel);
  if (!withinRoot(rootAbs, abs)) throw new HttpError(400, 'BAD_REQUEST', `${what}路径越界`);
  if (abs === rootAbs) throw new HttpError(400, 'BAD_REQUEST', `${what}路径非法`);
  return abs;
}

/** 文件存在时校验其真实路径仍在 root 内（符号链接逃逸防护）。 */
export function assertRealPathWithin(root: string, abs: string, what = '媒体'): void {
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    return; // 文件不存在：由调用方按 404 处理
  }
  let rootReal: string;
  try {
    rootReal = realpathSync(resolve(root));
  } catch {
    rootReal = resolve(root);
  }
  if (!withinRoot(rootReal, real)) throw new HttpError(400, 'BAD_REQUEST', `${what}路径越界（符号链接）`);
}

export function isRegularFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export function fileSize(p: string): number {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}

/** 流式计算文件 sha256。 */
export function sha256File(p: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(p);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk as Buffer));
    stream.on('end', () => resolvePromise(hash.digest('hex')));
  });
}

/** 媒体内容类型：优先用入库的 mime，其次按 rel_path 扩展名推断。 */
export function mimeForMedia(mime: string | null | undefined, relPath: string): string {
  if (mime && /^[\w.+-]+\/[\w.+-]+$/.test(mime)) return mime;
  return mimeForPath(relPath) ?? 'application/octet-stream';
}

/** 展示用文件名：rel_path 末段，或回退到 `media-<id>.<ext>`。 */
export function displayNameOf(relPath: string, id: number): string {
  const base = relPath.split('/').filter(Boolean).pop();
  return base && base.length > 0 ? base : `media-${id}`;
}
