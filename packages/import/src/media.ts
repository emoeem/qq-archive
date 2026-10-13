/**
 * 媒体归档：内容寻址 + 原子落盘 + 完整性校验。
 *
 * 目录布局（`root` = config.storage.mediaDir）：
 *
 *   <root>/<kind>/<yyyy>/<mm>/<sha256 前 2 位>/<sha256>.<ext>
 *   <root>/.incoming/<sha256(url+目标身份)>.part   ← 下载/拷贝中转，成功即 rename 走人
 *   <root>/.incoming/<file>.part.meta.json         ← 断点续传状态 sidecar（成功即删）
 *   <root>/thumbs/<kind>/<sha2>/<sha256>.jpg
 *
 * 硬规则（来自架构契约）：
 *  - 先写 `.part` 再 `rename`，同目录同文件系统，rename 是原子的；
 *  - 文件不存在 / URL 404 → `status='missing'` + failReason，**绝不写占位文件**；
 *  - 同一个内容只落一份（sha256 内容寻址），重复来源只更新元数据；
 *  - 大文件流式处理，`maxBytes` 上限在流里强制，超限立即中断且不留残渣；
 *  - 下载中断可续传：`.part` 路径按候选确定性生成，旁边持久化 sidecar，
 *    重试时用 `Range` + `If-Range` 续传，sha256 始终覆盖完整重组后的文件。
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { closeSync, createReadStream, createWriteStream, existsSync, openSync, readSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { dirname, resolve, sep } from 'node:path';
import type { MediaKind, MediaStatus, ScopedLogger } from '../../core/src/index.ts';
// MediaInput / MediaRow 定义在 db 包（core 只放领域类型）；type-only 导入不会产生运行时循环。
import type { MediaInput, MediaRow } from '../../db/src/index.ts';
import {
  DEFAULT_EXT_BY_KIND,
  canHaveThumb,
  extFromUrl,
  extOfName,
  filenameFromUrl,
  mediaRelPath,
  mimeForExt,
  normalizeFilename,
} from './media-util.ts';
import { sha256Hex } from '../../core/src/index.ts';

/** 默认单文件上限：512 MiB。 */
export const DEFAULT_MAX_MEDIA_BYTES = 512 * 1024 * 1024;
/** 默认下载超时：60 秒（整个响应体）。 */
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60_000;
/** 默认 ffmpeg 可执行文件名（走 PATH）。 */
export const DEFAULT_FFMPEG = 'ffmpeg';
/** 默认启用 HTTP Range 断点续传。 */
export const DEFAULT_RESUME = true;
/** 续传状态 sidecar 的后缀（紧跟在 `.part` 后面）。 */
const SIDECAR_SUFFIX = '.meta.json';

export interface ArchiveCandidate {
  kind: MediaKind;
  /** 本地文件路径（最高优先级）。 */
  localPath?: string | null;
  /** http(s) 下载地址（次优先级）。 */
  url?: string | null;
  filename?: string | null;
  declaredSize?: number | null;
  width?: number | null;
  height?: number | null;
  duration?: number | null;
}

export interface ArchiveOutcome {
  status: MediaStatus;
  /** 始终产出，可直接交给 `db.upsertMedia`（present 与 missing 都产）。 */
  media: MediaInput;
  /** missing/corrupt 时的可读原因。 */
  reason?: string;
}

/**
 * `ensureThumb` 需要的最小输入：已入库的 `MediaRow` 与刚归档、尚未入库的 `MediaInput`
 * 都能满足，因此归档流程可以就地生成缩略图，无需先写库再回查。
 */
export interface ThumbSource {
  status: MediaStatus;
  kind: MediaKind;
  sha256: string;
  relPath: string;
}

export interface HttpResponseLike {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  /** 跟随重定向后的最终 url（可选；真实 fetch 会带，测试假实现可不带）。 */
  url?: string | null;
  body: {
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>;
      cancel?(): Promise<void>;
    };
  } | null;
}

export type FetchLike = (
  url: string,
  init: { signal: AbortSignal; redirect: 'follow'; headers?: Record<string, string> },
) => Promise<HttpResponseLike>;

export interface MediaArchiverOptions {
  /** 媒体根目录（绝对路径优先）。 */
  root: string;
  logger: ScopedLogger;
  /** 单文件上限（字节）。 */
  maxBytes?: number;
  downloadTimeoutMs?: number;
  /** ffmpeg 可执行文件路径；不存在时缩略图返回 null（可选依赖）。 */
  ffmpegPath?: string;
  /** 注入 fetch（测试用），默认全局 fetch。 */
  fetchImpl?: FetchLike;
  /** 允许下载的协议，默认 http/https。 */
  allowProtocols?: string[];
  /**
   * 是否启用 HTTP Range 断点续传（默认 true）。
   * 关闭后退化为「每次从头下载」，中断不会保留 `.part` 残片。
   */
  resume?: boolean;
  /** 注入时钟（测试用）。 */
  now?: () => Date;
}

class MediaTooLargeError extends Error {
  readonly limit: number;
  readonly size: number;
  constructor(limit: number, size: number) {
    super(`媒体大小 ${size} 字节超过上限 ${limit} 字节`);
    this.name = 'MediaTooLargeError';
    this.limit = limit;
    this.size = size;
  }
}

const HASH_CHUNK = 1 << 20; // 1 MiB

/**
 * 断点续传状态 sidecar（`<file>.part.meta.json`）的内容。
 * `written` 只是最近一次已知的写入字节数快照；真正决定 Range 起点的是 `.part` 的
 * **实际大小**（进程被强杀时 sidecar 可能落后于磁盘）。
 */
interface ResumeState {
  /** 原始请求 url（用于判断 sidecar 是否属于本次候选）。 */
  url: string;
  /** 跟随重定向后的最终 url。 */
  finalUrl: string;
  /** 强校验器：ETag（优先用于 If-Range）。 */
  etag: string | null;
  /** 弱校验器：Last-Modified（ETag 缺失时的兜底）。 */
  lastModified: string | null;
  /** 已知总大小（Content-Range 的 total / Content-Length），未知为 null。 */
  totalBytes: number | null;
  /** 已写入字节数快照。 */
  written: number;
}

/** 解析 `Content-Range: bytes start-end/total`；total 为 `*` 时返回 null。 */
function parseContentRange(
  value: string | null,
): { start: number; end: number; total: number | null } | null {
  if (!value) return null;
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(value.trim());
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  const total = m[3] === '*' ? null : Number(m[3]);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (total !== null && !Number.isFinite(total)) return null;
  return { start, end, total };
}

/**
 * 从响应头推断「完整文件」的总字节数：
 *  - 206：优先 Content-Range 的 total，缺失时退化为 `offset + Content-Length`；
 *  - 200：Content-Length 即为总大小。
 * 无法确定（没有 Content-Length、也没有 total）时返回 null，交给流式计数兜底。
 */
function totalBytesFromHeaders(res: HttpResponseLike, offset: number): number | null {
  const rawLen = res.headers.get('content-length');
  const len = rawLen === null || rawLen === '' ? null : Number(rawLen);
  if (res.status === 206) {
    const cr = parseContentRange(res.headers.get('content-range'));
    if (cr && cr.total !== null) return cr.total;
    return len !== null && Number.isFinite(len) ? offset + len : null;
  }
  return len !== null && Number.isFinite(len) ? len : null;
}

/** 响应上的最终 url（重定向后）；假 fetch 不提供时退回请求 url。 */
function responseUrl(res: HttpResponseLike, fallback: string): string {
  return typeof res.url === 'string' && res.url.length > 0 ? res.url : fallback;
}

/**
 * 把文件前 `length` 字节喂给哈希。续传时先把已落盘的残片读回来，
 * 这样最终 sha256 覆盖的是完整重组文件，而不是只覆盖续传的那一段。
 */
async function hashExistingFile(
  hash: ReturnType<typeof createHash>,
  file: string,
  length: number,
): Promise<void> {
  const stream = createReadStream(file, { highWaterMark: HASH_CHUNK });
  let read = 0;
  try {
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const take = Math.min(buf.length, length - read);
      if (take <= 0) break;
      hash.update(buf.subarray(0, take));
      read += take;
      if (read >= length) break;
    }
  } finally {
    stream.destroy();
  }
  if (read !== length) {
    throw new Error(`续传残片长度不符：期望 ${length} 字节，实际 ${read}`);
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class MediaArchiver {
  readonly root: string;
  readonly maxBytes: number;
  readonly downloadTimeoutMs: number;
  readonly ffmpegPath: string;
  /** ffmpeg 可用性缓存：`null` 表示尚未探测。 */
  private ffmpegAvailable: boolean | null = null;
  private readonly logger: ScopedLogger;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly allowProtocols: string[];
  private readonly now: () => Date;
  private readonly resumeEnabled: boolean;

  constructor(opts: MediaArchiverOptions) {
    this.root = resolve(opts.root);
    this.logger = opts.logger;
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_MEDIA_BYTES;
    this.downloadTimeoutMs = opts.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
    this.ffmpegPath = opts.ffmpegPath ?? DEFAULT_FFMPEG;
    this.fetchImpl = opts.fetchImpl;
    this.allowProtocols = opts.allowProtocols ?? ['http:', 'https:'];
    this.now = opts.now ?? (() => new Date());
    this.resumeEnabled = opts.resume ?? DEFAULT_RESUME;
  }

  // ------------------------------------------------------------ 路径安全

  /** 相对路径 → 绝对路径；越界（`../`）或非法输入返回 null。 */
  absOf(relPath: string | null | undefined): string | null {
    if (!relPath || typeof relPath !== 'string') return null;
    if (relPath.includes('\0')) return null;
    const abs = resolve(this.root, relPath);
    if (abs !== this.root && !abs.startsWith(this.root + sep)) return null;
    return abs;
  }

  private incomingDir(): string {
    return resolve(this.root, '.incoming');
  }

  /**
   * 按 (url, 目标身份) 生成确定性的 `.part` 路径：同一候选重试时能找回同一个残片，
   * 这是 Range 续传的前提。文件名是内容的 sha256，不含任何用户输入，不存在路径注入。
   */
  private tempPathFor(url: string | undefined, meta: IngestMeta): string {
    const key = sha256Hex(
      JSON.stringify({
        url: url ?? null,
        localPath: meta.localPath ?? null,
        kind: meta.kind,
        ext: meta.ext,
        filename: meta.filename ?? null,
      }),
    );
    return resolve(this.incomingDir(), `${key}.part`);
  }

  /** 续传状态 sidecar：与 `.part` 同目录，仅多一个后缀。 */
  private sidecarPath(tmp: string): string {
    return `${tmp}${SIDECAR_SUFFIX}`;
  }

  /**
   * 读取并校验续传状态：sidecar 与 `.part` 必须同时存在、`.part` 非空、记录的 url 匹配。
   * 已写入字节数以 `.part` 的**实际大小**为准，保证 Range 起点与磁盘内容严格一致。
   */
  private async readResumeState(
    sidecar: string,
    url: string,
    tmp: string,
  ): Promise<ResumeState | null> {
    if (!existsSync(sidecar) || !existsSync(tmp)) return null;
    let size: number;
    try {
      const st = await stat(tmp);
      if (!st.isFile() || st.size === 0) return null;
      size = st.size;
    } catch {
      return null;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(sidecar, 'utf8'));
    } catch {
      return null;
    }
    if (!raw || typeof raw !== 'object') return null;
    const rec = raw as Partial<ResumeState>;
    if (rec.url !== url) return null;
    return {
      url,
      finalUrl: typeof rec.finalUrl === 'string' ? rec.finalUrl : url,
      etag: typeof rec.etag === 'string' ? rec.etag : null,
      lastModified: typeof rec.lastModified === 'string' ? rec.lastModified : null,
      totalBytes: typeof rec.totalBytes === 'number' ? rec.totalBytes : null,
      written: size,
    };
  }

  /** 持久化续传状态；只是加速缓存，写失败不影响下载主流程。 */
  private async writeResumeState(sidecar: string, state: ResumeState): Promise<void> {
    try {
      await mkdir(dirname(sidecar), { recursive: true });
      await writeFile(sidecar, JSON.stringify(state), 'utf8');
    } catch {
      /* 忽略：下次从头下载即可 */
    }
  }

  /** 丢弃残片与 sidecar（超限 / 416 / 不可信 Content-Range 时调用）。 */
  private async discardPartial(tmp: string, sidecar: string): Promise<void> {
    await rm(tmp, { force: true }).catch(() => undefined);
    await rm(sidecar, { force: true }).catch(() => undefined);
  }

  private nowDate(): Date {
    return this.now();
  }

  // ---------------------------------------------------------------- 归档

  /**
   * 归档一个候选资源。
   * 优先级：localPath（本地文件）→ url（http 下载）。两者都失败 → missing（不写占位文件）。
   */
  async archive(candidate: ArchiveCandidate): Promise<ArchiveOutcome> {
    const kind = candidate.kind;
    const localPath = candidate.localPath ?? undefined;
    const url = candidate.url ?? undefined;
    const rawName = candidate.filename ?? filenameFromUrl(url) ?? undefined;
    const filename = normalizeFilename(rawName, DEFAULT_EXT_BY_KIND[kind]) ?? undefined;
    const ext = extOfName(filename) ?? extFromUrl(url) ?? DEFAULT_EXT_BY_KIND[kind];
    const reasons: string[] = [];

    const meta = {
      kind,
      ext,
      filename,
      url,
      localPath,
      declaredSize: candidate.declaredSize ?? undefined,
      width: candidate.width ?? undefined,
      height: candidate.height ?? undefined,
      duration: candidate.duration ?? undefined,
    };

    if (localPath) {
      const result = await this.ingestLocal(localPath, meta);
      if ('outcome' in result) return result.outcome;
      reasons.push(result.reason);
    }
    if (url) {
      const result = await this.ingestUrl(url, meta);
      if ('outcome' in result) return result.outcome;
      reasons.push(result.reason);
    }
    if (!localPath && !url) reasons.push('无可用来源（既无 localPath 也无 url）');

    const reason = reasons.join('；');
    this.logger.debug('媒体缺失', { kind, filename, url, localPath, reason });
    return this.missingOutcome(meta, reason);
  }

  /**
   * 归档**已经在内存里的字节**（例如 OneBot `/get_image` 返回的 base64）。
   *
   * 与 `archive()` 汇合到同一个 `commit()`：内容寻址、原子 rename、sha256 校验、
   * 缩略图生成全部一致，所以「直链过期后用 OneBot 接口重取」不需要第二套落盘逻辑。
   * 超过 `maxBytes` 按 missing 处理，不写占位文件、不留残渣。
   */
  async archiveBytes(
    data: Uint8Array,
    candidate: {
      kind: MediaKind;
      filename?: string;
      url?: string;
      declaredSize?: number;
      width?: number;
      height?: number;
      duration?: number;
    },
  ): Promise<ArchiveOutcome> {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const kind = candidate.kind;
    const url = candidate.url ?? undefined;
    const rawName = candidate.filename ?? filenameFromUrl(url) ?? undefined;
    const filename = normalizeFilename(rawName, DEFAULT_EXT_BY_KIND[kind]) ?? undefined;
    const ext = extOfName(filename) ?? extFromUrl(url) ?? DEFAULT_EXT_BY_KIND[kind];
    const declaredSize = candidate.declaredSize ?? buf.length;

    if (buf.length > this.maxBytes) {
      return this.missingOutcome(
        { kind, ext, filename, url, declaredSize: buf.length },
        `字节来源 ${buf.length} 字节，超过单文件上限 ${this.maxBytes}`,
      );
    }
    if (buf.length === 0) {
      return this.missingOutcome({ kind, ext, filename, url, declaredSize }, '字节来源为空');
    }

    // 与 URL 续传的 `.part` 分开命名空间：字节来源没有续传语义，绝不能复用
    // 一个可能残留 sidecar 的下载残片，否则 commit 会把半截下载当成完整内容 rename 走。
    const key = sha256Hex(JSON.stringify({ bytes: true, kind, ext, filename: filename ?? null }));
    const tmp = resolve(this.incomingDir(), `${key}.bytes.part`);
    try {
      await mkdir(dirname(tmp), { recursive: true });
      await writeFile(tmp, buf);
    } catch (err) {
      return this.missingOutcome(
        { kind, ext, filename, url, declaredSize: buf.length },
        `写中转文件失败：${errText(err)}`,
      );
    }

    const meta = {
      kind,
      ext,
      filename,
      url,
      declaredSize,
      width: candidate.width,
      height: candidate.height,
      duration: candidate.duration,
    };
    return this.commit({ tmp, sha256: sha256Hex(buf), size: buf.length, ...meta });
  }

  /** 批量归档；单个失败不影响其它（每个都返回 outcome，不抛错）。 */
  async archiveAll(candidates: ArchiveCandidate[]): Promise<ArchiveOutcome[]> {
    const out: ArchiveOutcome[] = [];
    for (const c of candidates) out.push(await this.archive(c));
    return out;
  }

  private async ingestLocal(
    localPath: string,
    meta: IngestMeta,
  ): Promise<{ outcome: ArchiveOutcome } | { reason: string }> {
    let size: number;
    try {
      const st = await stat(localPath);
      if (!st.isFile()) return { reason: `本地路径不是文件：${localPath}` };
      size = st.size;
    } catch (err) {
      return { reason: `本地文件不可读：${localPath}（${errText(err)}）` };
    }
    if (size === 0) return { reason: `本地文件为空：${localPath}` };
    if (size > this.maxBytes) {
      return { reason: `本地文件 ${size} 字节超过上限 ${this.maxBytes} 字节：${localPath}` };
    }
    const tmp = this.tempPathFor(undefined, meta);
    const written = await this.writeHashed(createReadStream(localPath, { highWaterMark: HASH_CHUNK }), tmp);
    if (!written.ok) {
      // 本地读取没有「续传」概念：失败即清掉残片（writeHashed 只报告，不代删）。
      await rm(tmp, { force: true }).catch(() => undefined);
      return { reason: `读取本地文件失败：${localPath}（${written.reason}）` };
    }
    return { outcome: await this.commit({ ...meta, tmp, sha256: written.sha256, size: written.size }) };
  }

  private async ingestUrl(
    url: string,
    meta: IngestMeta,
  ): Promise<{ outcome: ArchiveOutcome } | { reason: string }> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { reason: `URL 非法：${url}` };
    }
    if (!this.allowProtocols.includes(parsed.protocol)) {
      return { reason: `协议不允许下载：${parsed.protocol}（${url}）` };
    }
    const fetchImpl = this.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
    if (!fetchImpl) return { reason: '当前运行环境没有 fetch，无法下载' };

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.downloadTimeoutMs);

    const tmp = this.tempPathFor(url, meta);
    const sidecar = this.sidecarPath(tmp);
    try {
      // 只有 sidecar 与 `.part` 同时存在、且记录的 url 匹配，才复用残片续传。
      let resume: ResumeState | null = this.resumeEnabled
        ? await this.readResumeState(sidecar, url, tmp)
        : null;

      // 最多两轮：第二轮用于 416 或不可信 Content-Range 时「丢弃残片、重头下载」。
      for (let attempt = 0; attempt < 2; attempt++) {
        const reusable = attempt === 0 ? resume : null;
        const offset = reusable !== null ? reusable.written : 0;
        const validators = reusable !== null ? (reusable.etag ?? reusable.lastModified) : null;
        const headers: Record<string, string> = {};
        if (reusable !== null) {
          headers['range'] = `bytes=${offset}-`;
          // 有强校验器时带 If-Range：远端文件变了就整体重下，绝不把残片拼上去。
          if (validators !== null) headers['if-range'] = validators;
        }

        const res = await fetchImpl(url, { signal: controller.signal, redirect: 'follow', headers });

        if (res.status === 416) {
          // Range 不可满足（残片比远端当前还长等）→ 丢弃残片重头来。
          await this.discardPartial(tmp, sidecar);
          resume = null;
          continue;
        }
        if (!res.ok) return { reason: `HTTP ${res.status}：${url}` };

        // 206 必须能校验 Content-Range，否则残片起点不可信 → 丢弃重头来。
        let effectiveOffset = offset;
        if (res.status === 206) {
          const cr = parseContentRange(res.headers.get('content-range'));
          if (!cr || cr.start !== offset) {
            await this.discardPartial(tmp, sidecar);
            resume = null;
            continue;
          }
        } else {
          // 200：服务端忽略 Range（或首次下载）→ 截断残片，重头下载。
          effectiveOffset = 0;
        }

        // maxBytes 按「总大小」判断：206 取 Content-Range 的 total（缺失时 offset+Content-Length），
        // 200 取 Content-Length。已知超限直接拒绝并清理，连 body 都不读。
        const total = totalBytesFromHeaders(res, effectiveOffset);
        if (total !== null && total > this.maxBytes) {
          await this.discardPartial(tmp, sidecar);
          return {
            reason:
              res.status === 206
                ? `远端总大小 ${total} 超过上限 ${this.maxBytes} 字节：${url}`
                : `Content-Length ${total} 超过上限 ${this.maxBytes} 字节：${url}`,
          };
        }

        const state: ResumeState = {
          url,
          finalUrl: responseUrl(res, url),
          etag: res.headers.get('etag'),
          lastModified: res.headers.get('last-modified'),
          totalBytes: total,
          written: effectiveOffset,
        };
        if (!res.body) {
          if (this.resumeEnabled && effectiveOffset > 0) {
            await this.writeResumeState(sidecar, state);
          } else {
            await this.discardPartial(tmp, sidecar);
          }
          return { reason: `响应没有 body：${url}` };
        }
        // 读 body 前先落盘续传状态：即便进程被强杀，重试也知道校验器与目标 url。
        if (this.resumeEnabled) await this.writeResumeState(sidecar, state);

        const written = await this.writeHashed(streamFromWebBody(res.body), tmp, controller, {
          offset: effectiveOffset,
        });
        if (!written.ok) {
          if (written.tooLarge || !this.resumeEnabled) {
            await this.discardPartial(tmp, sidecar);
          } else {
            // 中断可续传：保留 `.part`，把已写入字节数记回 sidecar。
            await this.writeResumeState(sidecar, { ...state, written: written.partial });
          }
          return { reason: `下载失败：${url}（${written.reason}）` };
        }
        // 成功：先删 sidecar 再原子提交，避免残留状态指向已 rename 走的文件。
        await rm(sidecar, { force: true }).catch(() => undefined);
        return {
          outcome: await this.commit({ ...meta, tmp, sha256: written.sha256, size: written.size }),
        };
      }
      return { reason: `续传重试仍失败：${url}` };
    } catch (err) {
      if (timedOut) {
        if (!this.resumeEnabled) await this.discardPartial(tmp, sidecar);
        return { reason: `下载超时（${this.downloadTimeoutMs}ms）：${url}` };
      }
      if (!this.resumeEnabled) await this.discardPartial(tmp, sidecar);
      return { reason: `下载异常：${url}（${errText(err)}）` };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 流式写 `.part` 并同时计算 sha256；超过 maxBytes 立刻中断。
   *
   * 失败时**不删除** `.part`（由调用方决定保留续传还是清理），`partial` 是中断时
   * 磁盘上的实际字节数。`opts.offset > 0` 表示在已有残片后追加：先把残片读回来喂给
   * 同一个哈希，于是 sha256 始终覆盖「完整重组后的文件」，而不是只覆盖续传的那一段。
   */
  private async writeHashed(
    source: AsyncIterable<Uint8Array>,
    tmp: string,
    controller?: AbortController,
    opts: { offset?: number } = {},
  ): Promise<
    | { ok: true; sha256: string; size: number }
    | { ok: false; reason: string; partial: number; tooLarge: boolean }
  > {
    const offset = opts.offset ?? 0;
    try {
      await mkdir(dirname(tmp), { recursive: true });
    } catch (err) {
      return { ok: false, reason: `无法创建中转目录：${errText(err)}`, partial: offset, tooLarge: false };
    }
    const hash = createHash('sha256');
    let size = offset;
    let out: ReturnType<typeof createWriteStream> | null = null;
    try {
      if (offset > 0) await hashExistingFile(hash, tmp, offset);
      out = createWriteStream(tmp, { flags: offset > 0 ? 'a' : 'w' });
      for await (const chunk of source) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const next = size + buf.length;
        if (next > this.maxBytes) throw new MediaTooLargeError(this.maxBytes, next);
        size = next;
        hash.update(buf);
        if (!out.write(buf)) await once(out, 'drain');
      }
      await new Promise<void>((res, rej) => {
        out!.once('error', rej);
        out!.end(() => res());
      });
      return { ok: true, sha256: hash.digest('hex'), size };
    } catch (err) {
      controller?.abort();
      // 不能直接 destroy：那样会丢掉仍在写缓冲里的字节，`.part` 的长度就不再等于
      // 已写入/已哈希的字节数，续传起点会错。用 end() 把已接受的字节刷到磁盘再关。
      if (out) {
        await new Promise<void>((res) => {
          out!.once('error', () => res());
          out!.once('close', () => res());
          out!.end();
        });
      }
      return { ok: false, reason: errText(err), partial: size, tooLarge: err instanceof MediaTooLargeError };
    }
  }

  /** `.part` → 内容寻址最终路径（原子 rename；已存在则直接复用并丢弃临时文件）。 */
  private async commit(p: {
    tmp: string;
    sha256: string;
    size: number;
    kind: MediaKind;
    ext: string;
    declaredSize?: number;
    filename?: string;
    url?: string;
    localPath?: string;
    width?: number;
    height?: number;
    duration?: number;
  }): Promise<ArchiveOutcome> {
    const relPath = mediaRelPath(p.kind, p.sha256, this.nowDate(), p.ext);
    const abs = this.absOf(relPath);
    if (!abs) {
      await rm(p.tmp, { force: true }).catch(() => undefined);
      return this.missingOutcome(
        {
          kind: p.kind,
          ext: p.ext,
          filename: p.filename,
          url: p.url,
          localPath: p.localPath,
          declaredSize: p.size,
        },
        `生成的目标路径越界：${relPath}`,
      );
    }
    if (existsSync(abs)) {
      await rm(p.tmp, { force: true }).catch(() => undefined);
    } else {
      try {
        await mkdir(dirname(abs), { recursive: true });
        await rename(p.tmp, abs);
      } catch (err) {
        await rm(p.tmp, { force: true }).catch(() => undefined);
        return this.missingOutcome(
          {
            kind: p.kind,
            ext: p.ext,
            filename: p.filename,
            url: p.url,
            localPath: p.localPath,
            declaredSize: p.size,
          },
          `落盘失败：${errText(err)}`,
        );
      }
    }
    const media: MediaInput = {
      sha256: p.sha256,
      kind: p.kind,
      size: p.size,
      relPath,
      ext: p.ext,
      mime: mimeForExt(p.ext),
      status: 'present',
      originUrl: p.url ?? null,
      originPath: p.localPath ?? null,
      failReason: null,
    };
    if (p.width !== undefined) media.width = p.width;
    if (p.height !== undefined) media.height = p.height;
    if (p.duration !== undefined) media.duration = p.duration;
    // 缩略图在唯一的汇合点生成：导入（runImport / linkBatchMedia）与采集
    // （packages/collect 的 MediaArchiverLike.archive）都走 archive() → commit()，
    // 所以挂在这里两条链路都不会漏。生成失败或本机没有 ffmpeg 只是没有 thumbPath，
    // 绝不影响归档结果本身。
    const thumbRel = await this.ensureThumb({
      status: 'present',
      kind: media.kind,
      sha256: media.sha256,
      relPath: media.relPath,
    });
    if (thumbRel !== null) media.thumbPath = thumbRel;
    this.logger.debug('媒体落盘', { relPath, size: p.size, kind: p.kind, thumb: thumbRel });
    return { status: 'present', media };
  }

  /**
   * 缺失/损坏占位：**不创建任何文件**，但产出一条可入库的 media 记录。
   * sha256 由来源标识派生（同一来源重复导入稳定），保证幂等且可统计。
   */
  missingOutcome(
    meta: {
      kind: MediaKind;
      ext?: string;
      filename?: string;
      url?: string;
      localPath?: string;
      declaredSize?: number;
    },
    reason: string,
  ): ArchiveOutcome {
    const identity = JSON.stringify({
      kind: meta.kind,
      filename: meta.filename ?? null,
      url: meta.url ?? null,
      localPath: meta.localPath ?? null,
      size: meta.declaredSize ?? null,
    });
    const sha256 = sha256Hex(`missing\u0000${identity}`);
    const ext = meta.ext ?? DEFAULT_EXT_BY_KIND[meta.kind];
    const relPath = mediaRelPath(meta.kind, sha256, this.nowDate(), ext);
    const media: MediaInput = {
      sha256,
      kind: meta.kind,
      size: meta.declaredSize ?? 0,
      relPath,
      ext,
      mime: mimeForExt(ext),
      status: 'missing',
      originUrl: meta.url ?? null,
      originPath: meta.localPath ?? null,
      failReason: reason.slice(0, 500),
    };
    return { status: 'missing', media, reason };
  }

  // ---------------------------------------------------------------- 校验

  /**
   * 校验一个已归档文件：
   *  - 路径越界 / 文件不存在 → `missing`
   *  - 文件存在但 sha256 不匹配 → `corrupt`
   *  - 匹配 → `present`
   */
  verify(relPath: string, expectedSha256: string): 'present' | 'corrupt' | 'missing' {
    const abs = this.absOf(relPath);
    if (!abs || !existsSync(abs)) return 'missing';
    let fd: number | null = null;
    try {
      const hash = createHash('sha256');
      fd = openSync(abs, 'r');
      const buf = Buffer.alloc(1 << 20);
      for (;;) {
        const n = readSync(fd, buf, 0, buf.length, null);
        if (n <= 0) break;
        hash.update(buf.subarray(0, n));
      }
      const actual = hash.digest('hex');
      return actual === expectedSha256.toLowerCase() ? 'present' : 'corrupt';
    } catch {
      return 'missing';
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          /* 忽略关闭失败 */
        }
      }
    }
  }

  /** 校验并回写 db 状态（可选便利方法）。 */
  verifyAndReport(media: MediaRow): 'present' | 'corrupt' | 'missing' {
    return this.verify(media.relPath, media.sha256);
  }

  // -------------------------------------------------------------- 缩略图

  /**
   * 生成缩略图（图片 / 视频抽帧）。ffmpeg 缺失或失败时返回 null —— 缩略图是可选增强，
   * 绝不能因为 ffmpeg 不存在而让导入失败。
   */
  async ensureThumb(media: ThumbSource): Promise<string | null> {
    if (media.status !== 'present') return null;
    if (!canHaveThumb(media.kind)) return null;
    const srcAbs = this.absOf(media.relPath);
    if (!srcAbs || !existsSync(srcAbs)) return null;
    const thumbRel = `thumbs/${media.kind}/${media.sha256.slice(0, 2)}/${media.sha256}.jpg`;
    const thumbAbs = this.absOf(thumbRel);
    if (!thumbAbs) return null;
    if (existsSync(thumbAbs)) return thumbRel;
    // ffmpeg 可用性只探测一次并缓存：批量导入时不能对每个媒体都 spawn 一次 `-version`。
    if (this.ffmpegAvailable === null) this.ffmpegAvailable = await this.hasFfmpeg();
    if (!this.ffmpegAvailable) return null;
    try {
      await mkdir(dirname(thumbAbs), { recursive: true });
    } catch {
      return null;
    }
    const args =
      media.kind === 'image'
        ? [
            '-hide_banner',
            '-loglevel',
            'error',
            '-y',
            '-i',
            srcAbs,
            '-frames:v',
            '1',
            '-vf',
            'scale=min(320\\,iw):-2',
            '-q:v',
            '4',
            thumbAbs,
          ]
        : [
            '-hide_banner',
            '-loglevel',
            'error',
            '-y',
            '-ss',
            '0',
            '-i',
            srcAbs,
            '-frames:v',
            '1',
            '-vf',
            'scale=min(320\\,iw):-2',
            '-q:v',
            '4',
            thumbAbs,
          ];
    try {
      await new Promise<void>((res, rej) => {
        execFile(
          this.ffmpegPath,
          args,
          { timeout: 30_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
          (err) => (err ? rej(err) : res()),
        );
      });
    } catch {
      await rm(thumbAbs, { force: true }).catch(() => undefined);
      return null;
    }
    return existsSync(thumbAbs) ? thumbRel : null;
  }

  /** 缩略图是否可用（不生成，只探测二进制是否存在）。 */
  async hasFfmpeg(): Promise<boolean> {
    try {
      await new Promise<void>((res, rej) => {
        execFile(this.ffmpegPath, ['-version'], { timeout: 10_000 }, (err) => (err ? rej(err) : res()));
      });
      return true;
    } catch {
      return false;
    }
  }
}

interface IngestMeta {
  kind: MediaKind;
  ext: string;
  filename?: string;
  url?: string;
  localPath?: string;
  declaredSize?: number;
  width?: number;
  height?: number;
  duration?: number;
}

/** 把 WHATWG ReadableStream body 包成异步字节流（不需要把响应体读进内存）。 */
async function* streamFromWebBody(body: {
  getReader(): {
    read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>;
    cancel?(): Promise<void>;
  };
}): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) yield value;
    }
  } catch (err) {
    // 读取中断（超时/网络错误）时主动释放连接；忽略取消失败
    try {
      await reader.cancel?.();
    } catch {
      /* 忽略 */
    }
    throw err;
  }
}
