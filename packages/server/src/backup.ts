/**
 * 备份与恢复。
 *
 * 备份：`VACUUM INTO` 生成一致性快照（先 WAL checkpoint），写 sha256 与 manifest，
 * 可选把 mediaDir 整个目录拷贝一份。
 *
 * 恢复：默认 `dryRun` 只校验（SQLite 魔术头 + sha256 + `PRAGMA quick_check` + 行数），
 * 非 dryRun 才真正替换数据库：先把当前库备份成 `.bak-<时间戳>`，删掉 `-wal`/`-shm`，
 * 再拷回快照；调用方拿到 `reopened` 后必须换掉手里的 Db 实例。
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AppConfig } from '../../core/src/config.ts';
import type { ScopedLogger } from '../../core/src/logger.ts';
import { sha256File } from './media.ts';
import { HttpError } from './http.ts';
import { Db, openDatabase } from '../../db/src/index.ts';

export interface BackupCounts {
  sessions: number;
  messages: number;
  media: number;
  accounts: number;
  jobs: number;
  logs: number;
  schemaVersion: number;
}

export interface VerifyResult {
  ok: boolean;
  sha256: string;
  sha256Expected: string | null;
  sha256Ok: boolean | null;
  quickCheck: string;
  headerOk: boolean;
  counts: BackupCounts;
  errors: string[];
  /** `errors` 的别名（apps/cli 用这个字段名打印问题清单）。 */
  problems: string[];
}

export interface BackupManifest {
  format: 'qqarchive-backup/1';
  kind: string;
  createdAt: string;
  sourceDbPath: string;
  snapshot: string;
  sha256: string;
  sizeBytes: number;
  count: BackupCounts;
  media: { included: boolean; dir: string | null; files: number; bytes: number };
  verify: { quickCheck: string; ok: boolean };
  version: string;
}

export interface BackupOptions {
  db: Db;
  config: AppConfig;
  logger: ScopedLogger;
  /** 缺省时用 ''（CLI 不传，不写进 manifest 的 version 字段意义不大）。 */
  version?: string;
  /** 'manual' | 'auto' | 其它标签，写入 manifest。 */
  kind?: string;
  /** `kind` 的别名（apps/cli 用 `--label`）。 */
  label?: string;
  /** 是否连媒体目录一起打包（默认 false）。 */
  includeMedia?: boolean;
  /** 是否在快照上跑 quick_check + 计数校验（默认取 config.backup.verify）。 */
  verify?: boolean;
}

export interface BackupResult {
  /** 是否整体成功（快照生成 + 可选校验通过）。 */
  ok: boolean;
  /** 快照文件路径（`snapshotPath` 的别名，apps/cli 用这个名字）。 */
  path: string;
  snapshotPath: string;
  manifestPath: string;
  sha256: string;
  /** `sha256` 的别名（apps/cli 打印「清单 sha256」）。 */
  manifestSha256: string;
  sizeBytes: number;
  /** `sizeBytes` 的别名（apps/cli 打印 MB）。 */
  dbSizeBytes: number;
  counts: BackupCounts;
  messageCount: number;
  mediaCount: number;
  mediaIncluded: boolean;
  mediaFiles: number;
  mediaBytes: number;
  verify: VerifyResult | null;
  problems: string[];
}

export interface RestoreOptions {
  db: Db;
  config: AppConfig;
  logger: ScopedLogger;
  /** 快照文件路径（.db），或它的 .manifest.json，或备份目录。 */
  backupPath: string;
  dryRun?: boolean;
  /** 非 dryRun 时顺带把 manifest 里的媒体目录拷回 mediaDir。 */
  restoreMedia?: boolean;
  loggerScope?: string;
}

export interface RestoreResult {
  /** 校验是否通过（dryRun 下即演练结论）。 */
  ok: boolean;
  dryRun: boolean;
  snapshotPath: string;
  manifestPath: string | null;
  sha256: string;
  sha256Expected: string | null;
  verify: VerifyResult;
  currentCounts: BackupCounts | null;
  backupOfCurrent: string | null;
  /** 快照 manifest 里声明的消息/媒体数。 */
  manifestMessageCount: number;
  manifestMediaCount: number;
  /** 当前数据库里实际的消息/媒体数（被替换前的现状）。 */
  actualMessageCount: number;
  actualMediaCount: number;
  mediaRestored: number;
  /** 非 dryRun 且真正替换后给出落点信息，否则 null。 */
  applied: { to: string; backupOfOld: string | null } | null;
  problems: string[];
  warnings: string[];
  reopened: Db | null;
}

const SQLITE_HEADER = 'SQLite format 3\u0000';

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function scalar(db: DatabaseSync, sql: string): number {
  try {
    const row = db.prepare(sql).get() as Record<string, unknown> | undefined;
    if (!row) return 0;
    const v = Object.values(row)[0];
    if (typeof v === 'number') return v;
    if (typeof v === 'bigint') return Number(v);
    return 0;
  } catch {
    return 0;
  }
}

function countTable(db: DatabaseSync, table: string): number {
  return scalar(db, `SELECT COUNT(*) FROM ${table}`);
}

/** 读快照的计数与 schema 版本（表不存在算 0）。 */
export function readCounts(db: DatabaseSync): BackupCounts {
  return {
    sessions: countTable(db, 'sessions'),
    messages: countTable(db, 'messages'),
    media: countTable(db, 'media'),
    accounts: countTable(db, 'accounts'),
    jobs: countTable(db, 'import_jobs'),
    logs: countTable(db, 'logs'),
    schemaVersion: scalar(db, 'SELECT MAX(version) FROM schema_migrations'),
  };
}

function headerOk(path: string): boolean {
  try {
    const head = readFileSync(path, { encoding: 'utf8', flag: 'r' }).slice(0, 16);
    return head === SQLITE_HEADER;
  } catch {
    return false;
  }
}

function openReadOnly(path: string): DatabaseSync {
  return new DatabaseSync(path, { readOnly: true });
}

/** 校验一个快照文件：魔术头 + sha256 + quick_check + 计数。 */
export async function verifySnapshot(path: string, sha256Expected: string | null = null): Promise<VerifyResult> {
  const errors: string[] = [];
  const hOk = headerOk(path);
  if (!hOk) errors.push('不是 SQLite 数据库文件（魔术头不匹配）');
  let sha = '';
  try {
    sha = await sha256File(path);
  } catch (err) {
    errors.push(`sha256 计算失败：${(err as Error).message}`);
  }
  const shaOk = sha256Expected === null ? null : sha256Expected === sha;
  if (shaOk === false) errors.push('sha256 与 manifest 不一致（快照被改动或损坏）');

  let quickCheck = 'not-run';
  let counts: BackupCounts = { sessions: 0, messages: 0, media: 0, accounts: 0, jobs: 0, logs: 0, schemaVersion: 0 };
  if (hOk) {
    let handle: DatabaseSync | null = null;
    try {
      handle = openReadOnly(path);
      const rows = handle.prepare('PRAGMA quick_check').all() as Array<Record<string, unknown>>;
      const values = rows.map((r) => String(Object.values(r)[0]));
      quickCheck = values.join('; ') || 'ok';
      if (quickCheck !== 'ok') errors.push(`quick_check 未通过：${quickCheck}`);
      counts = readCounts(handle);
    } catch (err) {
      quickCheck = `error: ${(err as Error).message}`;
      errors.push(`打开快照失败：${(err as Error).message}`);
    } finally {
      try {
        handle?.close();
      } catch {
        /* ignore */
      }
    }
  }
  return {
    ok: errors.length === 0,
    sha256: sha,
    sha256Expected,
    sha256Ok: shaOk,
    quickCheck,
    headerOk: hOk,
    counts,
    errors,
    problems: [...errors],
  };
}

function escapeSqlLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** 生成一致性快照（VACUUM INTO）并写 manifest。 */
export async function createBackup(opts: BackupOptions): Promise<BackupResult> {
  const { db, config, logger } = opts;
  const backupDir = resolve(config.storage.backupDir);
  mkdirSync(backupDir, { recursive: true });
  const kind = opts.kind ?? opts.label ?? 'manual';
  const name = `archive-${kind}-${stamp()}`;
  const snapshotPath = join(backupDir, `${name}.db`);
  const manifestPath = join(backupDir, `${name}.manifest.json`);

  try {
    db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch (err) {
    logger.warn('备份前 WAL checkpoint 失败（继续用 VACUUM INTO）', { error: (err as Error).message });
  }

  let done = false;
  try {
    db.raw.prepare('VACUUM INTO ?').run(snapshotPath);
    done = true;
  } catch (err) {
    logger.warn('VACUUM INTO 参数化失败，回退到字面量 SQL', { error: (err as Error).message });
  }
  if (!done) {
    db.raw.exec(`VACUUM INTO ${escapeSqlLiteral(snapshotPath)}`);
  }
  if (!existsSync(snapshotPath)) throw new HttpError(500, 'INTERNAL', 'VACUUM INTO 未生成快照文件');

  const sizeBytes = statSync(snapshotPath).size;
  const sha = await sha256File(snapshotPath);

  let mediaFiles = 0;
  let mediaBytes = 0;
  let mediaDir: string | null = null;
  if (opts.includeMedia && existsSync(config.storage.mediaDir)) {
    mediaDir = join(backupDir, `${name}.media`);
    cpSync(config.storage.mediaDir, mediaDir, { recursive: true, errorOnExist: false, force: true });
    const measured = Db.measureDir(mediaDir);
    mediaFiles = measured.files;
    mediaBytes = measured.bytes;
  }

  const wantVerify = opts.verify ?? config.backup.verify;
  const verify = wantVerify ? await verifySnapshot(snapshotPath, sha) : null;
  if (verify && !verify.ok) {
    // 不抛异常：调用方（CLI/接口）根据 ok 与 problems 决定如何报告。
    logger.error('备份校验失败', { snapshotPath, problems: verify.problems });
  }

  const counts = verify
    ? verify.counts
    : (() => {
        const h = openReadOnly(snapshotPath);
        try {
          return readCounts(h);
        } finally {
          h.close();
        }
      })();

  const manifest: BackupManifest = {
    format: 'qqarchive-backup/1',
    kind,
    createdAt: new Date().toISOString(),
    sourceDbPath: resolve(config.storage.dbPath),
    snapshot: basename(snapshotPath),
    sha256: sha,
    sizeBytes,
    count: counts,
    media: { included: mediaDir !== null, dir: mediaDir === null ? null : basename(mediaDir), files: mediaFiles, bytes: mediaBytes },
    verify: { quickCheck: verify?.quickCheck ?? 'skipped', ok: verify?.ok ?? true },
    version: opts.version ?? '',
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  logger.info('备份完成', { snapshotPath, sizeBytes, sha256: sha.slice(0, 12), mediaFiles, verify: manifest.verify.ok });

  // 未一起打包时，媒体体积仍按当前媒体目录实测，便于 CLI 展示。
  let reportedMediaBytes = mediaBytes;
  if (mediaDir === null && existsSync(config.storage.mediaDir)) {
    try {
      reportedMediaBytes = Db.measureDir(config.storage.mediaDir).bytes;
    } catch {
      reportedMediaBytes = 0;
    }
  }
  const problems = verify ? [...verify.problems] : [];
  return {
    ok: verify ? verify.ok : true,
    path: snapshotPath,
    snapshotPath,
    manifestPath,
    sha256: sha,
    manifestSha256: sha,
    sizeBytes,
    dbSizeBytes: sizeBytes,
    counts,
    messageCount: counts.messages,
    mediaCount: counts.media,
    mediaIncluded: mediaDir !== null,
    mediaFiles,
    mediaBytes: reportedMediaBytes,
    verify,
    problems,
  };
}

export interface PruneResult {
  /** 被删除的备份快照路径（对应 DB 行也一并删除）。 */
  removed: string[];
  /** 保留下来的份数。 */
  kept: number;
}

/**
 * 把备份目录里**实际存在**但 `backups` 表里没有记录的快照补登记回去。
 *
 * 为什么需要这一步：快照由 `VACUUM INTO` 生成，而它的登记行是**在快照之后**写进当前库的，
 * 因此快照本身不可能包含自己这一行。一旦用这份快照做过恢复（恢复 = 用快照替换当前库），
 * 那次备份的登记行就随旧库一起没了 —— 磁盘上有文件、表里没记录。影响不只是列表少一条：
 * `pruneBackups()` 只遍历表里的行，这些「孤儿快照」永远不会被保留策略裁剪，会在磁盘上无限堆积。
 *
 * 以文件系统为准对账：目录里有、表里没有的补一行；元数据优先取同名 `.manifest.json`
 * （kind / createdAt / sha256 / 条数），没有 manifest 时退化为文件名与 mtime。
 * 只认 `archive-*.db` 这一命名，避免把备份目录里的其它文件当成快照。
 *
 * 行里存的是**绝对路径**，所以数据目录被整体搬走（换机器、换盘、改 `storage.dataDir`）后，
 * 老行的路径会失效。这种情况按**文件名**认领：同一个快照只认一次，把老行改指到新位置，
 * 而不是又补一行出来 —— 否则「最后一次备份」会出现同名重复项，保留策略也会算错份数。
 */
export function reconcileBackups(opts: { db: Db; backupDir: string; logger?: ScopedLogger }): { added: number; repointed: number } {
  const { db, logger } = opts;
  const backupDir = resolve(opts.backupDir);
  if (!existsSync(backupDir)) return { added: 0, repointed: 0 };

  let entries: string[];
  try {
    entries = readdirSync(backupDir);
  } catch (err) {
    logger?.warn('读取备份目录失败，跳过对账', { backupDir, error: (err as Error).message });
    return { added: 0, repointed: 0 };
  }

  const rows = db.listBackups(1000);
  const byPath = new Map(rows.map((r) => [resolve(r.path), r]));
  const byName = new Map(rows.map((r) => [basename(r.path), r]));
  let added = 0;
  let repointed = 0;
  for (const name of entries) {
    if (!name.startsWith('archive-') || !name.endsWith('.db')) continue;
    const snapshot = join(backupDir, name);
    const existing = byPath.get(snapshot) ?? byName.get(name);
    if (existing) {
      if (resolve(existing.path) !== snapshot) {
        try {
          db.repointBackup(existing.id, snapshot);
          repointed += 1;
          logger?.info('备份记录改指到新位置（数据目录已搬迁）', { from: existing.path, to: snapshot });
        } catch (err) {
          logger?.warn('改指备份路径失败（保留原记录）', { id: existing.id, error: (err as Error).message });
        }
      }
      continue;
    }

    const manifestPath = join(backupDir, `${name.replace(/\.db$/, '')}.manifest.json`);
    let kind = 'unknown';
    let createdAt = new Date().toISOString();
    let sizeBytes = 0;
    let dbSha256: string | null = null;
    let messageCount = 0;
    let mediaCount = 0;
    let verifyResult: unknown = null;
    try {
      const data = JSON.parse(readFileSync(manifestPath, 'utf8')) as Partial<BackupManifest>;
      if (typeof data.kind === 'string' && data.kind !== '') kind = data.kind;
      if (typeof data.createdAt === 'string' && data.createdAt !== '') createdAt = data.createdAt;
      sizeBytes = typeof data.sizeBytes === 'number' ? data.sizeBytes : 0;
      dbSha256 = typeof data.sha256 === 'string' ? data.sha256 : null;
      messageCount = typeof data.count?.messages === 'number' ? data.count.messages : 0;
      mediaCount = typeof data.count?.media === 'number' ? data.count.media : 0;
      verifyResult = typeof data.verify === 'object' && data.verify !== null ? data.verify : null;
    } catch {
      // manifest 缺失或损坏：用文件名与 mtime 兜底，仍然把快照登记回来（宁可信息少，不可漏账）
      const m = /^archive-([a-z]+)-/.exec(name);
      if (m?.[1]) kind = m[1];
      try {
        createdAt = statSync(snapshot).mtime.toISOString();
        sizeBytes = statSync(snapshot).size;
      } catch {
        /* 读不到就保留默认值 */
      }
    }

    try {
      const id = db.registerExistingBackup({ path: snapshot, kind, createdAt, sizeBytes, messageCount, mediaCount, dbSha256, verifyResult });
      if (id !== null) {
        added += 1;
        logger?.info('对账补登记备份快照', { snapshot, kind, createdAt });
      }
    } catch (err) {
      logger?.warn('对账补登记失败（跳过该快照）', { snapshot, error: (err as Error).message });
    }
  }
  return { added, repointed };
}

/**
 * 保留份数裁剪：按 DB 里 `backups` 的 id 倒序保留最近 `keep` 份，
 * 更旧的连同它的 `.db` / `.manifest.json` / `.media` 目录一起删除，并删掉对应 DB 行。
 *
 * - 只处理**备份目录内**的文件，且用 `basename` 校验，绝不对目录外的路径动手；
 * - `keep <= 0` 视为「不裁剪」直接返回（配置校验已保证 >= 1，这里再兜一层）；
 * - 正在恢复中的快照可以放进 `protect` 避免被删；
 * - 文件删除失败不抛错（只记录），避免因为一个占用中的文件让备份任务整体失败。
 */
export function pruneBackups(opts: {
  db: Db;
  backupDir: string;
  keep: number;
  logger?: ScopedLogger;
  /** 额外保护、不参与裁剪的快照绝对路径（例如刚生成的那一份）。 */
  protect?: string[];
}): PruneResult {
  const { db, backupDir, keep, logger } = opts;
  if (!Number.isFinite(keep) || keep <= 0) return { removed: [], kept: 0 };

  // 先把目录里没登记的孤儿快照对账回来，否则它们既不会被裁剪、也永远不会出现在保留计数里。
  reconcileBackups({ db, backupDir, ...(logger === undefined ? {} : { logger }) });

  const protect = new Set((opts.protect ?? []).map((p) => resolve(p)));
  const rows = db.listBackups(1000);
  const survivors = rows.slice(0, keep).map((r) => resolve(r.path));
  const keepSet = new Set([...survivors, ...protect]);

  const removed: string[] = [];
  let kept = 0;
  for (const row of rows) {
    const snapshot = resolve(row.path);
    if (keepSet.has(snapshot)) {
      kept += 1;
      continue;
    }
    // 安全边界：只删备份目录内的文件。
    const inside = dirname(snapshot) === resolve(backupDir);
    if (!inside) {
      logger?.warn('跳过裁剪：快照不在备份目录内', { snapshot });
      kept += 1;
      continue;
    }
    try {
      rmSync(snapshot, { force: true });
      const manifest = `${snapshot.replace(/\.db$/, '')}.manifest.json`;
      if (existsSync(manifest)) rmSync(manifest, { force: true });
      const media = `${snapshot.replace(/\.db$/, '')}.media`;
      if (existsSync(media)) rmSync(media, { recursive: true, force: true });
      db.deleteBackup(row.id);
      removed.push(snapshot);
      logger?.info('裁剪旧备份', { snapshot, keep });
    } catch (err) {
      logger?.warn('裁剪旧备份失败（保留记录）', { snapshot, error: (err as Error).message });
      kept += 1;
    }
  }
  return { removed, kept };
}

/** 把备份路径（文件 / manifest / 目录）解析成 { snapshotPath, manifestPath }。 */
export function resolveBackupReference(input: string): { snapshotPath: string; manifestPath: string | null } {
  if (typeof input !== 'string' || input.trim() === '') throw new HttpError(400, 'BAD_REQUEST', '备份路径为空');
  if (!isAbsolute(input)) throw new HttpError(400, 'BAD_REQUEST', '备份路径必须是绝对路径');
  let p = resolve(input);
  if (!existsSync(p)) throw new HttpError(404, 'NOT_FOUND', `备份不存在：${p}`);
  const st = statSync(p);
  if (st.isDirectory()) {
    // CLI 用法是 `restore <备份目录>`：取目录里文件名最新的 .db 快照。
    const dbs = readdirSync(p)
      .filter((f) => f.endsWith('.db'))
      .sort();
    const newest = dbs[dbs.length - 1];
    if (newest === undefined) throw new HttpError(400, 'BAD_REQUEST', `备份目录里没有 .db 快照：${p}`);
    const snap = join(p, newest);
    const man = join(p, `${newest.slice(0, -3)}.manifest.json`);
    return { snapshotPath: snap, manifestPath: existsSync(man) ? man : null };
  }
  if (extname(p) === '.json' || p.endsWith('.manifest.json')) {
    let parsed: BackupManifest;
    try {
      parsed = JSON.parse(readFileSync(p, 'utf8')) as BackupManifest;
    } catch (err) {
      throw new HttpError(400, 'BAD_REQUEST', `manifest 解析失败：${(err as Error).message}`);
    }
    if (parsed === null || typeof parsed !== 'object' || typeof parsed.snapshot !== 'string') {
      throw new HttpError(400, 'BAD_REQUEST', 'manifest 缺少 snapshot 字段');
    }
    const snap = join(dirname(p), parsed.snapshot);
    return { snapshotPath: snap, manifestPath: p };
  }
  if (p.endsWith('.db')) {
    // 直接传快照文件时，顺手找同名的 manifest。没有它就无法用清单里的 sha256 校验，
    // 也不知道媒体目录叫什么 —— `--restore-media` 会**静默什么都不做**。
    // （真实踩过：数据库恢复成功、媒体一个都没回来，命令却只报"通过"。）
    const man = `${p.slice(0, -3)}.manifest.json`;
    if (existsSync(man)) return { snapshotPath: p, manifestPath: man };
  }
  return { snapshotPath: p, manifestPath: null };
}

/** 恢复（默认只校验）。 */
export async function restoreBackup(opts: RestoreOptions): Promise<RestoreResult> {
  const { db, config, logger } = opts;
  const dryRun = opts.dryRun ?? true;
  const warnings: string[] = [];
  const ref = resolveBackupReference(opts.backupPath);
  if (!existsSync(ref.snapshotPath)) {
    throw new HttpError(404, 'NOT_FOUND', `快照文件不存在：${ref.snapshotPath}`);
  }

  let expected: string | null = null;
  let manifestCount: BackupCounts | null = null;
  let mediaRef: { dir: string | null; included: boolean } = { dir: null, included: false };
  if (ref.manifestPath) {
    try {
      const m = JSON.parse(readFileSync(ref.manifestPath, 'utf8')) as BackupManifest;
      expected = typeof m.sha256 === 'string' ? m.sha256 : null;
      if (m.count && typeof m.count === 'object') manifestCount = m.count;
      if (m.media && typeof m.media === 'object') {
        mediaRef = { dir: m.media.dir ?? null, included: Boolean(m.media.included) };
      }
    } catch (err) {
      warnings.push(`manifest 读取失败（只用快照本身校验）：${(err as Error).message}`);
    }
  }

  const verify = await verifySnapshot(ref.snapshotPath, expected);
  if (!verify.headerOk) throw new HttpError(400, 'BAD_REQUEST', '目标不是 SQLite 数据库文件');
  if (verify.sha256Ok === false) {
    throw new HttpError(400, 'BAD_REQUEST', '快照 sha256 与 manifest 不一致，拒绝恢复（文件已损坏或被改动）');
  }
  if (verify.quickCheck !== 'ok') {
    throw new HttpError(400, 'BAD_REQUEST', `快照 quick_check 未通过：${verify.quickCheck}`);
  }

  const currentCounts = (() => {
    try {
      return readCountsFromDb(db);
    } catch {
      return null;
    }
  })();

  const result: RestoreResult = {
    ok: verify.ok,
    dryRun,
    snapshotPath: ref.snapshotPath,
    manifestPath: ref.manifestPath,
    sha256: verify.sha256,
    sha256Expected: expected,
    verify,
    currentCounts,
    backupOfCurrent: null,
    manifestMessageCount: (manifestCount ?? verify.counts).messages,
    manifestMediaCount: (manifestCount ?? verify.counts).media,
    actualMessageCount: currentCounts?.messages ?? 0,
    actualMediaCount: currentCounts?.media ?? 0,
    mediaRestored: 0,
    applied: null,
    problems: [...verify.problems, ...warnings],
    warnings,
    reopened: null,
  };
  if (dryRun) {
    logger.info('恢复演练（dryRun）通过', { snapshotPath: ref.snapshotPath, counts: verify.counts });
    return result;
  }

  const target = resolve(config.storage.dbPath);
  mkdirSync(dirname(target), { recursive: true });
  try {
    db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    /* ignore */
  }
  db.close();

  let backupOfCurrent: string | null = null;
  if (existsSync(target)) {
    backupOfCurrent = `${target}.bak-${stamp()}`;
    copyFileSync(target, backupOfCurrent);
    result.backupOfCurrent = backupOfCurrent;
  }
  for (const suffix of ['-wal', '-shm']) {
    const side = `${target}${suffix}`;
    if (existsSync(side)) {
      try {
        rmSync(side, { force: true });
      } catch (err) {
        warnings.push(`删除 ${basename(side)} 失败：${(err as Error).message}`);
      }
    }
  }
  copyFileSync(ref.snapshotPath, target);

  let mediaRestored = 0;
  if (opts.restoreMedia) {
    if (!mediaRef.included || mediaRef.dir === null || ref.manifestPath === null) {
      // 请求了恢复媒体、却没有任何媒体可恢复时必须**说出来**：静默返回"通过"会让人
      // 以为媒体也回来了（真实踩过：删掉 52 个媒体文件后恢复，媒体目录仍是空的）。
      warnings.push(
        '请求了恢复媒体，但这份备份里没有媒体：'
          + (ref.manifestPath === null ? '找不到同名 .manifest.json' : 'manifest 未声明 media.included/media.dir')
          + '。数据库已恢复、媒体未恢复 —— 需要媒体请用 `backup --with-media` 重新备份。',
      );
    } else {
      const mediaSrc = join(dirname(ref.manifestPath), mediaRef.dir);
      if (existsSync(mediaSrc)) {
        mkdirSync(resolve(config.storage.mediaDir), { recursive: true });
        cpSync(mediaSrc, resolve(config.storage.mediaDir), { recursive: true, force: true });
        mediaRestored = Db.measureDir(resolve(config.storage.mediaDir)).files;
      } else {
        warnings.push(`manifest 声明的媒体目录不存在：${mediaSrc}`);
      }
    }
  }

  const reopened = openDatabase({ path: target });
  result.applied = { to: target, backupOfOld: backupOfCurrent };
  result.mediaRestored = mediaRestored;
  result.reopened = reopened;
  // `problems` 在函数前段就拼好了，而上面这段媒体逻辑还会往 warnings 里追加内容；
  // 不重新拼一次，那些警告就会被静默丢掉（真实踩过：请求恢复媒体、实际没恢复，命令却只说"通过"）。
  result.problems = [...verify.problems, ...warnings];
  logger.warn('数据库已从备份恢复', {
    snapshotPath: ref.snapshotPath,
    target,
    backupOfCurrent,
    messages: verify.counts.messages,
    mediaRestored,
  });
  return result;
}

function readCountsFromDb(db: Db): BackupCounts {
  const q = (sql: string): number => {
    try {
      const row = db.raw.prepare(sql).get() as Record<string, unknown> | undefined;
      return row ? Number(Object.values(row)[0]) : 0;
    } catch {
      return 0;
    }
  };
  return {
    sessions: q('SELECT COUNT(*) FROM sessions'),
    messages: q('SELECT COUNT(*) FROM messages'),
    media: q('SELECT COUNT(*) FROM media'),
    accounts: q('SELECT COUNT(*) FROM accounts'),
    jobs: q('SELECT COUNT(*) FROM import_jobs'),
    logs: q('SELECT COUNT(*) FROM logs'),
    schemaVersion: q('SELECT MAX(version) FROM schema_migrations'),
  };
}
