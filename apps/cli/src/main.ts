#!/usr/bin/env node
/**
 * QQ 归档系统命令行入口。
 *
 * 用法：
 *   qq-archive serve                    启动归档服务（API + 网页）
 *   qq-archive import <文件|目录> [...]  导入聊天记录导出文件
 *   qq-archive collect [--once]         运行采集（默认按配置定时循环）
 *   qq-archive backup [--no-verify]     立即备份（数据库 + 媒体清单 + 校验）
 *   qq-archive restore <备份目录> [--apply]  恢复演练（默认 dry-run）
 *   qq-archive verify                   校验全部媒体文件的 sha256
 *   qq-archive login                    扫码登录 QQ（在终端直接显示二维码）
 *   qq-archive doctor                   环境自检（配置/依赖/权限/磁盘/ffmpeg）
 *   qq-archive token                    打印管理令牌（用于登录网页）
 *   qq-archive stats                    打印归档统计
 *   qq-archive --help / --version
 *
 * 约定：所有命令都尊重 `QQ_ARCHIVE_CONFIG` 指向的配置文件；CLI 参数优先于配置。
 */
import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { resolve, join, basename, sep } from 'node:path';
import { loadConfig, validateConfig, createLogger, sttConfigOf, logsConfigOf, filtersConfigOf, type AppConfig } from '../../../packages/core/src/index.ts';
import { openDatabase, type Db } from '../../../packages/db/src/index.ts';
import type { ExecFn, TranscribeProgress } from '../../../packages/stt/src/index.ts';

const VERSION = '0.1.0';
const BOOT_LOGGER_SCOPE = 'cli';

/** 全局可变状态：db 与 logger 在 main 里建立，命令结束后释放。 */
export interface Ctx {
  config: AppConfig;
  configPath: string;
  db: Db;
  logger: ReturnType<typeof createLogger>;
  stop: Array<() => Promise<void> | void>;
  /** server.token 是本次运行临时生成的（未能写回配置）：跨进程不可复现，必须告警。 */
  tokenTemporary: boolean;
}

function usage(): string {
  return `QQ 聊天记录归档系统 v${VERSION}

用法: qq-archive <命令> [选项]

命令:
  serve                     启动归档服务（HTTP API + 网页管理界面）
    --host <地址>           覆盖监听地址（默认取配置，默认 127.0.0.1）
    --port <端口>           覆盖监听端口
  import <路径...>          导入导出文件（.json/.jsonl/.txt），目录则递归扫描
    --account <uid>         归属账号标识（默认 default）
    --format <名称>         强制指定格式（qce-json|qce-jsonl|qce-txt|generic-jsonl）
    --limit <n>             每个文件最多导入 n 条（调试用）
    --no-media              跳过媒体归档
  collect                   运行采集
    --once                  只跑一轮后退出（默认按配置定时循环）
  backup                    立即备份（默认只备份数据库）
    --no-verify             跳过完整性校验
    --label <文本>          备份备注
    --with-media            连 media/ 媒体目录一起打包（恢复时才能连媒体一起还原）
  restore <备份目录或快照>  恢复演练（默认 dry-run，只校验不动数据）
    --apply                 真正执行恢复（会先把当前库另存为 .bak）
    --restore-media         --apply 时把清单里记录的媒体目录一起拷回
  verify                    重新校验所有媒体文件的 sha256
  purge --session <id|名称> 删除一个会话（默认只演练，--yes 才真删；--media 连孤儿媒体文件一起删）
  purge --all               删除全部归档数据（同样默认只演练）
  collector <setup|status>  采集端（NapCat）容器编排：自动拉镜像、起容器、读出 token
    --write-config          把读到的 token 与地址写进 config.json（写前自动备份）
    --name <名字>           容器名（默认 napcat-qq）
    --onebot-port <端口>    OneBot 端口（默认 3000）
    --webui-port <端口>     WebUI 端口（默认 6099）
    --data-dir <路径>       NapCat 数据目录（默认 ~/napcat/data）
  refilter                  按当前的 filters 规则重算**已有消息**的过滤标记
                            （只改标记，绝不删除；改了规则之后跑一次即可）
  login                     QQ 扫码登录（驱动 NapCat WebUI，二维码直接画在终端）
    --list                  只列出可快捷登录的账号，不做登录动作
    --uin <账号>            不扫码，用本地已保存的登录态直接上线
    --no-wait               打印二维码后立即退出（默认轮询等待登录成功）
    --timeout <秒>          等待登录的超时秒数（默认 180）
  doctor                    环境自检并输出报告
  token                     打印网页登录令牌
  stats                     打印归档统计
  logs [--limit n]          打印最近日志
  transcribe                转写尚未处理的语音（whisper.cpp，需 stt.enabled=true）
    --limit <n>             本次最多转写 n 条（默认 50，最多 1000）
    --lang <代码>           转写语言（默认取 stt.language）
    --media <id>            只转写指定媒体 ID 的一条语音
    --json                  以 JSON 输出结果（脚本可直接解析）
  全局选项（可放在命令之前或之后）:
  --config <路径>           指定配置文件（默认取 QQ_ARCHIVE_CONFIG，再默认 ./config.json）
                            相对路径（dataDir/mediaDir/dbPath 等）按**配置文件所在目录**解析
  --help, -h                显示帮助
  --version, -V             显示版本

环境变量:
  QQ_ARCHIVE_CONFIG         配置文件路径（默认 ./config.json）
  QQ_ARCHIVE_DATA_DIR       数据目录
  QQ_ARCHIVE_HOST / _PORT   监听地址与端口
  QQ_ARCHIVE_TOKEN          管理令牌
  QQ_ARCHIVE_COLLECTOR_*    采集配置覆盖（URL/TOKEN/INTERVAL/KIND）
`;
}

/** 极简参数解析：`--k v`、`--k=v`、`--flag`，未知选项报错。 */
/**
 * 极简参数解析：`--k v`、`--k=v`、`--flag`。
 *
 * 命令是**第一个不以 `-` 开头的 token**，所以全局选项可以写在命令之前或之后：
 *   `qq-archive import f.json --config /etc/qq.json`
 *   `qq-archive --config /etc/qq.json import f.json`
 * 两种写法等价。旧的「命令必须是 argv[0]」写法会让前一种把 `--config` 当成命令名。
 */
export function parseArgs(argv: string[]): { command: string; args: string[]; flags: Record<string, string | boolean> } {
  const args: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let command = '';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 2) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else if (a.startsWith('-') && a.length > 1) {
      const key = a.slice(1);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else if (command === '') {
      command = a;
    } else {
      args.push(a);
    }
  }
  // 没有任何命令时的兜底：无参数 → 帮助；`--version`/`-V` → 交给 main() 打印版本。
  // 之前这里无条件写成 `--help`，于是 `qq-archive --version` 会先命中 main() 里的
  // `command === '--help'` 分支，**打印整篇用法而不是版本号**。
  if (command === '') {
    const versionFlag = flags.version === true || flags.V === true;
    command = versionFlag ? '' : flags.help === true ? 'help' : '--help';
  }
  return { command, args, flags };
}

async function buildCtx(configPath?: string): Promise<Ctx> {
  const loaded = loadConfig(configPath);
  const cfg = loaded.config;
  const problems = validateConfig(cfg);
  if (problems.length > 0) {
    for (const p of problems) process.stderr.write(`配置错误: ${p}\n`);
    if (!process.env.QQ_ARCHIVE_ALLOW_BAD_CONFIG) {
      process.stderr.write('（设置 QQ_ARCHIVE_ALLOW_BAD_CONFIG=1 可忽略并继续）\n');
      process.exit(2);
    }
  }
  // 日志落库（仅 warn/error，避免日志表被噪声淹没）。`db` 用闭包延迟取：sink 在构造 logger
  // 时就得装好，但真正写入发生在第一条 warn/error，那时 db 必然已经打开。
  // `scope === 'db'` 的不落库 —— 数据库自己出问题时写日志会再次触发同一个失败的写入。
  let db: Db | undefined;
  const logger = createLogger({
    level: (process.env.QQ_ARCHIVE_LOG_LEVEL as 'debug') ?? 'info',
    dir: cfg.storage.logDir,
    dbSink: (e) => {
      if (e.scope === 'db' || e.scope.startsWith('db.') || e.scope.endsWith('.db')) return;
      db?.appendLog(e);
    },
  });
  db = openDatabase({ path: cfg.storage.dbPath, logger: logger.child('db') });
  // 数据库日志保留策略（`logs.dbKeepDays`，0 = 不清理）。放在启动时做一次：
  // 这类清理只有在进程真的起来时才有意义，长期跑的服务重启频率远高于一天一次。
  try {
    const keepDays = logsConfigOf(cfg).dbKeepDays;
    if (keepDays > 0) {
      const pruned = db.pruneLogs(keepDays);
      if (pruned > 0) logger.child('cli').info(`已清理 ${pruned} 条超过 ${keepDays} 天的数据库日志`, { pruned, keepDays });
    }
  } catch (err) {
    logger.child('cli').warn('数据库日志清理失败（不影响启动）', { error: (err as Error).message });
  }
  const ctx: Ctx = { config: cfg, configPath: loaded.path, db, logger, stop: [], tokenTemporary: loaded.tokenGenerated };
  return ctx;
}

async function disposeCtx(ctx: Ctx): Promise<void> {
  for (const s of ctx.stop.reverse()) {
    try {
      await s();
    } catch {
      /* 关闭流程中的错误不覆盖主错误 */
    }
  }
  ctx.db.close();
  await ctx.logger.close();
}

/* ------------------------------------------------------------------ */
/* 命令实现                                                            */
/* ------------------------------------------------------------------ */

async function cmdServe(ctx: Ctx, flags: Record<string, string | boolean>): Promise<number> {
  const cfg = ctx.config;
  if (flags.host) cfg.server.host = String(flags.host);
  if (flags.port) cfg.server.port = Number(flags.port);
  const { createServer } = await import('../../../packages/server/src/index.ts');
  const { CollectRunner } = await import('../../../packages/collect/src/index.ts');
  const { MediaArchiver } = await import('../../../packages/import/src/media.ts');

  const log = ctx.logger.child('serve');
  const archiver = new MediaArchiver({
    root: cfg.storage.mediaDir,
    maxBytes: cfg.collector.maxMediaBytes,
    logger: log.child('media'),
  });

  let collect: InstanceType<typeof CollectRunner> | undefined;
  if (cfg.collector.kind === 'onebot' && cfg.collector.baseUrl) {
    const { OneBotCollector } = await import('../../../packages/collect/src/index.ts');
    const collector = new OneBotCollector({ baseUrl: cfg.collector.baseUrl, token: cfg.collector.token });
    collect = new CollectRunner({
      db: ctx.db,
      collector,
      archiver,
      config: cfg.collector,
      logger: log.child('collect'),
      filters: filtersConfigOf(cfg),
    });
    // **不由 CLI 启动**：交给 server 启动并持有句柄，网页上的「开始/停止采集」才控制得了它。
    // 之前 CLI 自己 start()、server 只有 runOnce，于是界面上既看不到运行状态也停不掉。
  }

  // `import.meta.dirname` = <repo>/apps/cli/src，要回到仓库根需要**三层**（与 packages 的
  // `../../../packages/...` 同一基准）。写成 `../..` 会得到 <repo>/apps，于是静态前端
  // 永远从 <repo>/apps/web 找 → GET / 恒 404，网页界面根本打不开。
  const repoRoot = resolve(import.meta.dirname, '../../..');
  const webIndex = join(repoRoot, 'web', 'index.html');
  if (!existsSync(webIndex)) {
    // 静默 404 是最难排查的形态：这里直接把「找的是哪个目录」说出来。
    process.stderr.write(
      `警告：未找到网页界面文件 ${webIndex}；服务仍会启动，但 GET / 会返回 404。\n` +
        `      （若你把项目放在别处，请确认 web/ 与 apps/ 在同一层；也可从仓库根目录启动。）\n`,
    );
  }

  const { server, close } = await createServer({
    config: cfg,
    db: ctx.db,
    logger: log,
    repoRoot,
    version: VERSION,
    startedAt: Date.now(),
    ...(collect ? { collect } : {}),
  });
  ctx.stop.push(async () => {
    // 采集循环由 server 持有（见上面注释），它的 close() 会负责停掉
    await close();
  });

  await new Promise<void>((resolveP, rejectP) => {
    server.once('error', rejectP);
    server.listen(cfg.server.port, cfg.server.host, () => resolveP());
  });
  const shown = cfg.server.host === '0.0.0.0' || cfg.server.host === '::' ? '127.0.0.1' : cfg.server.host;
  process.stdout.write(
    `\n  QQ 归档系统已启动\n` +
      `  网页界面:  http://${shown}:${cfg.server.port}/\n` +
      `  健康检查:  http://${shown}:${cfg.server.port}/api/health\n` +
      (ctx.tokenTemporary
        ? `  登录令牌:  ${cfg.server.token}  ← 临时令牌（未写入 ${ctx.configPath}，重启即变，建议尽快写入配置）\n`
        : `  登录令牌:  qq-archive token\n`) +
      `  数据目录:  ${cfg.storage.dataDir}\n` +
      `  监听:      ${cfg.server.host}:${cfg.server.port}${cfg.server.host === '127.0.0.1' ? '（仅本机可访问）' : ''}\n\n` +
      `  按 Ctrl+C 停止\n\n`,
  );
  await new Promise<void>((res) => {
    const shutdown = () => {
      process.stdout.write('\n正在停止…\n');
      // 停机必须**有界**。`server.close()` 会等所有连接结束，而浏览器可能长时间占着连接
      // （正在播的 <video> 媒体流、归档管理页的 SSE 进度流）；在途采集轮次也可能还在等上游。
      // 实测：真实运行中的实例收到 SIGTERM 后 20 秒仍未退出，只能靠 systemd 的
      // TimeoutStopSec（默认 90 秒）SIGKILL 收场 —— 那段时间服务不接新请求、端口也不释放。
      // 这里给一段优雅期，超时就强制断开剩余连接并在 0.5 秒后退出，保证停机时间可预期。
      const graceMs = shutdownGraceMs();
      const watchdog = setTimeout(() => {
        process.stderr.write(`优雅停机超过 ${graceMs} ms，强制断开剩余连接后退出。\n`);
        try {
          closeAllConnections(server);
        } catch {
          /* 尽力而为，失败也要退出 */
        }
        setTimeout(() => process.exit(0), 500);
      }, graceMs);
      watchdog.unref();
      res();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
  return 0;
}

/** 优雅停机宽限期（毫秒）。测试可用 `QQ_ARCHIVE_SHUTDOWN_GRACE_MS` 调小以免拖慢用例。 */
function shutdownGraceMs(): number {
  const raw = Number(process.env.QQ_ARCHIVE_SHUTDOWN_GRACE_MS ?? '');
  if (Number.isFinite(raw) && raw > 0) return Math.min(raw, 120_000);
  return 10_000;
}

/** 断开服务端所有存活连接（Node ≥ 18.2 才有；老运行时上静默跳过）。 */
function closeAllConnections(srv: { closeAllConnections?: () => void }): void {
  srv.closeAllConnections?.();
}

/** 递归收集待导入文件。 */
async function collectFiles(paths: string[]): Promise<string[]> {
  const out: string[] = [];
  const exts = new Set(['.json', '.jsonl', '.txt', '.ndjson']);
  for (const p of paths) {
    const abs = resolve(p);
    if (!existsSync(abs)) throw new Error(`路径不存在: ${abs}`);
    const st = await stat(abs);
    if (st.isDirectory()) {
      const entries = await readdir(abs, { withFileTypes: true });
      const nested: string[] = [];
      for (const e of entries) nested.push(join(abs, e.name));
      out.push(...(await collectFiles(nested)));
    } else if (exts.has(abs.slice(abs.lastIndexOf('.')).toLowerCase())) {
      out.push(abs);
    }
  }
  return out;
}

async function cmdImport(ctx: Ctx, args: string[], flags: Record<string, string | boolean>): Promise<number> {
  if (args.length === 0) {
    process.stderr.write('用法: qq-archive import <文件或目录> [...]\n');
    return 2;
  }
  const { runImport } = await import('../../../packages/import/src/index.ts');
  const { MediaArchiver } = await import('../../../packages/import/src/media.ts');
  const log = ctx.logger.child('import');
  const accountUid = String(flags.account ?? 'default');
  const files = await collectFiles(args);
  if (files.length === 0) {
    process.stderr.write('没有找到 .json/.jsonl/.txt 文件\n');
    return 2;
  }
  const withMedia = flags['no-media'] !== true;
  const archiver = withMedia
    ? new MediaArchiver({ root: ctx.config.storage.mediaDir, maxBytes: ctx.config.collector.maxMediaBytes, logger: log.child('media') })
    : undefined;

  let totalInserted = 0;
  let totalDuplicate = 0;
  let totalFailed = 0;
  let totalMediaSaved = 0;
  let totalMediaMissing = 0;
  let failures = 0;

  for (const file of files) {
    const jobId = ctx.db.createJob({
      kind: 'import',
      format: flags.format ? String(flags.format) : undefined,
      accountUid,
      sourcePath: file,
      options: { limit: flags.limit ?? null, media: withMedia },
    });
    ctx.db.updateJob(jobId, { status: 'running', startedAt: new Date().toISOString() });
    process.stdout.write(`\n▶ 导入 ${basename(file)}\n`);
    try {
      // 统一走 packages/import 的高层入口 `runImport()`：它负责
      // 「解析 → insertMessages → upsertMedia → linkMessageMedia」整条接线。
      //
      // 这里以前是自己调 `importFile()` + `onBatch` 手写消息落库，**漏掉了媒体落库**：
      // 媒体文件确实被归档到磁盘，但 `media` 表恒为 0 行、`message_media` 没有任何关联，
      // 于是 `stats` 显示「媒体 0 / 0」、Web 媒体页永远空白、`/api/media/:id/raw` 无从索引。
      // 与 server 的 `/api/import`（走 runImport）行为不一致，必须共用同一实现。
      const stats = await runImport({
        filePath: file,
        db: ctx.db,
        accountUid,
        logger: log,
        batchId: jobId,
        source: 'import',
        ...(withMedia ? {} : { skipMedia: true }),
        ...(archiver ? { archiver } : {}),
        ...(flags.limit ? { limit: Number(flags.limit) } : {}),
        ...(flags.format ? { forceFormat: String(flags.format) } : {}),
      });
      totalInserted += stats.inserted;
      totalDuplicate += stats.duplicate;
      totalFailed += stats.failed;
      totalMediaSaved += stats.mediaSaved;
      totalMediaMissing += stats.mediaMissing;
      ctx.db.updateJob(jobId, {
        status: stats.failed > 0 && stats.inserted === 0 ? 'failed' : 'done',
        totalItems: stats.totalItems,
        processed: stats.totalItems,
        inserted: stats.inserted,
        duplicate: stats.duplicate,
        failed: stats.failed,
        mediaSaved: stats.mediaSaved,
        mediaMissing: stats.mediaMissing,
        progress: 100,
        finishedAt: new Date().toISOString(),
        stats: stats as unknown,
        ...(stats.errors.length ? { error: stats.errors.slice(0, 10).join('; ') } : {}),
      });
      process.stdout.write(
        `  格式 ${stats.format}｜解析 ${stats.totalItems}｜新增 ${stats.inserted}｜重复 ${stats.duplicate}｜失败 ${stats.failed}\n` +
          `  媒体 归档 ${stats.mediaSaved} 次｜缺失 ${stats.mediaMissing}｜耗时 ${stats.durationMs}ms\n`,
      );
      if (stats.errors.length) {
        process.stdout.write(`  前若干错误:\n`);
        for (const e of stats.errors.slice(0, 5)) process.stdout.write(`    - ${e}\n`);
      }
    } catch (err) {
      failures++;
      const msg = err instanceof Error ? err.message : String(err);
      ctx.db.updateJob(jobId, { status: 'failed', error: msg, finishedAt: new Date().toISOString() });
      ctx.db.appendLog({ level: 'error', scope: 'import', message: `导入失败 ${file}: ${msg}` });
      process.stderr.write(`  ✖ 导入失败: ${msg}\n`);
    }
  }

  const media = ctx.db.mediaStats();
  process.stdout.write(
    `\n汇总：文件 ${files.length}｜新增 ${totalInserted}｜重复 ${totalDuplicate}｜失败 ${totalFailed}｜` +
      `文件级失败 ${failures}\n` +
      `媒体：归档 ${totalMediaSaved} 次｜缺失 ${totalMediaMissing} 次｜` +
      `媒体表 ${media.present} 已保存 / ${media.total} 总数（缺失 ${media.missing}），占用 ${(media.bytes / 1024 / 1024).toFixed(2)} MB\n` +
      `数据库现有消息 ${ctx.db.stats().messages} 条。\n`,
  );
  return failures > 0 ? 1 : 0;
}

async function cmdCollect(ctx: Ctx, flags: Record<string, string | boolean>): Promise<number> {
  const cfg = ctx.config;
  if (cfg.collector.kind !== 'onebot') {
    process.stderr.write('采集未启用：请在配置里把 collector.kind 设为 "onebot" 并设置 collector.baseUrl。\n');
    return 2;
  }
  const { OneBotCollector, CollectRunner } = await import('../../../packages/collect/src/index.ts');
  const { MediaArchiver } = await import('../../../packages/import/src/media.ts');
  const log = ctx.logger.child('collect');
  const collector = new OneBotCollector({ baseUrl: cfg.collector.baseUrl, token: cfg.collector.token });
  const probe = await collector.probe();
  if (!probe.ok) {
    const reason = probe.error ?? '未知错误';
    // 这个失败用户会在终端里看到，但终端会滚走 —— 同时记进运行日志，
    // 网页「归档管理 → 运行日志与错误」才查得到「为什么某一轮没采到」。
    log.error('采集端不可用', { baseUrl: cfg.collector.baseUrl, error: reason });
    process.stderr.write(`采集端不可用: ${reason}\n`);
    process.stderr.write(`请确认 OneBot 实现（NapCat 等）已在 ${cfg.collector.baseUrl} 运行。\n`);
    return 3;
  }
  process.stdout.write(`已连接采集端：${probe.nickname ?? ''} (${probe.uin ?? '未知 QQ'})\n`);
  const archiver = new MediaArchiver({ root: cfg.storage.mediaDir, maxBytes: cfg.collector.maxMediaBytes, logger: log.child('media') });
  const runner = new CollectRunner({
    db: ctx.db,
    collector,
    archiver,
    config: cfg.collector,
    logger: log,
    filters: filtersConfigOf(cfg),
  });

  if (flags.once) {
    const round = await runner.runOnce();
    // 转发只在真的展开过 / 真的失败过时才占一行，避免正常轮次出现无意义的「转发：0」。
    const forwardLine =
      round.forwardMessages || round.forwardFailed
        ? `转发：展开子消息 ${round.forwardMessages ?? 0}｜拉取失败 ${round.forwardFailed ?? 0}\n`
        : '';
    if (round.forwardFailed) {
      process.stdout.write('  提示：转发拉取失败已降级为占位，消息本身仍已归档；可稍后重跑补齐。\n');
    }
    // 过滤只在真的有命中时才占一行；并明确写出"标记"与"跳过存储"的区别，
    // 免得用户看到「过滤 3」就以为少存了 3 条（默认情况它们都在库里）。
    const filterLine =
      round.filtered || round.dropped
        ? `过滤：命中 ${round.filtered ?? 0}${round.dropped ? `（其中跳过存储 ${round.dropped}）` : '（已入库并标记，未丢弃）'}\n`
        : '';
    process.stdout.write(
      `\n一轮采集完成：会话 ${round.sessions}｜拉取 ${round.fetched}｜新增 ${round.inserted}｜重复 ${round.duplicate}｜失败 ${round.failed}\n` +
        `媒体：保存 ${round.mediaSaved}｜缺失 ${round.mediaMissing}\n` +
        filterLine +
        forwardLine,
    );
    for (const e of round.errors.slice(0, 10)) process.stdout.write(`  ! ${e.session}: ${e.error}\n`);
    return round.failed > 0 && round.inserted === 0 ? 1 : 0;
  }
  const stop = runner.start();
  ctx.stop.push(stop);
  process.stdout.write(`定时采集已启动（每 ${cfg.collector.intervalSec}s 一轮）。按 Ctrl+C 停止。\n`);
  await new Promise<void>((res) => {
    process.once('SIGINT', () => res());
    process.once('SIGTERM', () => res());
  });
  return 0;
}

/**
 * 扫码登录：驱动 NapCat WebUI 完成 QQ 登录。
 *
 * 刻意**不**经过本项目的 HTTP API —— 二维码 URL 本身就是一份登录凭据，
 * 由本机 CLI 直连 NapCat，凭据只出现在这台机器的终端里，不经过网络、不进日志。
 */
async function cmdLogin(ctx: Ctx, flags: Record<string, string | boolean>): Promise<number> {
  const napcat = ctx.config.collector.napcat;
  if (!napcat || napcat.token === '') {
    process.stderr.write(
      '尚未配置 NapCat WebUI：请在配置文件的 collector.napcat 里填写 webuiUrl 与 token。\n' +
        'token 取自 NapCat 的 config/webui.json —— 注意这是 NapCat WebUI 的 token，\n' +
        '与 OneBot 的 access token 不是同一个。\n',
    );
    return 2;
  }

  const { NapCatWebUi } = await import('../../../packages/collect/src/index.ts');
  const { encodeQr, qrToTerminal } = await import('../../../packages/qr/src/index.ts');
  const client = new NapCatWebUi({ webuiUrl: napcat.webuiUrl, token: napcat.token, probeRange: napcat.probeRange });

  let baseUrl: string;
  try {
    baseUrl = await client.connect();
  } catch (err) {
    process.stderr.write(`连接 NapCat WebUI 失败: ${err instanceof Error ? err.message : String(err)}\n`);
    process.stderr.write(`请确认 NapCat 正在运行并已开启 WebUI（配置地址 ${napcat.webuiUrl}）。\n`);
    return 3;
  }
  process.stdout.write(`已连接 NapCat WebUI：${baseUrl}\n`);

  const status = await client.getLoginStatus();
  if (status.isLogin) {
    process.stdout.write(`QQ 已登录${status.uin ? `：${status.uin}` : ''}，无需扫码。\n`);
    return 0;
  }

  // ── --list：只列出 NapCat 记住的本地登录态，不做任何登录动作 ──
  if (flags.list === true) {
    const accounts = await client.listQuickLogin();
    if (accounts.length === 0) {
      process.stdout.write('没有可快捷登录的账号（首次使用请先用手机扫码登录一次）。\n');
      return 0;
    }
    process.stdout.write('可快捷登录的账号：\n');
    for (const a of accounts) {
      process.stdout.write(`  ${a.uin}${a.nickname ? `  ${a.nickname}` : ''}${a.isQuickLogin === false ? '（当前不可用）' : ''}\n`);
    }
    return 0;
  }

  // ── --uin <账号>：不扫码，直接用本地登录态上线 ──
  const uin = typeof flags.uin === 'string' ? flags.uin.trim() : '';
  if (uin !== '') {
    if (!/^\d{4,12}$/.test(uin)) {
      process.stderr.write(`uin 非法: ${uin}\n`);
      return 2;
    }
    const result = await client.quickLogin(uin);
    if (result.ok) {
      process.stdout.write(`已触发账号 ${uin} 的快捷登录。\n`);
    } else if (result.alreadyLoggedIn) {
      // 这是 NapCat 的正常回执，不是故障：账号已在登录流程中。
      process.stdout.write(`账号 ${uin} 已在登录流程中${result.message ? `：${result.message}` : ''}\n`);
    } else {
      process.stderr.write(`账号 ${uin} 快捷登录失败${result.message ? `：${result.message}` : ''}\n`);
      return 1;
    }
  } else {
    // ── 默认：把二维码画在终端里 ──
    const qr = await client.getLoginQrcode();
    process.stdout.write('\n请用手机 QQ 扫描下面的二维码，并在手机上确认登录：\n\n');
    process.stdout.write(`${qrToTerminal(encodeQr(qr.url, { ecc: 'M' }), { margin: 2 })}\n\n`);
    process.stdout.write('二维码约 2 分钟失效；登录成功后本命令会自动退出。\n');
  }

  if (flags['no-wait'] === true) return 0;

  const timeoutSec = typeof flags.timeout === 'string' ? Number(flags.timeout) : 180;
  const budget = Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec : 180;
  const deadline = Date.now() + budget * 1000;
  let dots = 0;
  process.stdout.write('等待登录');
  while (Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 3000));
    const now = await client.getLoginStatus();
    if (now.isLogin) {
      process.stdout.write(`\r登录成功${now.uin ? `：${now.uin}` : ''}。                          \n`);
      return 0;
    }
    dots = (dots + 1) % 4;
    process.stdout.write(`\r等待登录${'.'.repeat(dots)}${' '.repeat(3 - dots)}`);
  }
  process.stdout.write('\r等待超时：仍未检测到登录（二维码可能已失效，重新运行本命令即可）。\n');
  return 1;
}

async function cmdBackup(ctx: Ctx, flags: Record<string, string | boolean>): Promise<number> {
  const { createBackup, pruneBackups } = await import('../../../packages/server/src/backup.ts');
  const log = ctx.logger.child('backup');
  const kind = flags.label ? String(flags.label) : 'manual';
  // `--with-media`：把 media/ 整目录一起打包到快照旁边（默认只备份数据库，媒体往往很大）。
  // 与 `restore --apply --restore-media` 是一对 —— 只备份数据库的包里没有媒体可恢复。
  const includeMedia = flags['with-media'] === true;
  const res = await createBackup({
    db: ctx.db,
    config: ctx.config,
    logger: log,
    verify: flags['no-verify'] !== true,
    includeMedia,
    label: flags.label ? String(flags.label) : undefined,
  });

  // 必须入库：网页「归档管理」的「最后一次备份时间」与备份列表读的是 backups 表。
  // 早期版本 CLI 只生成快照文件、不写表，于是命令行做的备份在网页上完全看不见
  // （磁盘上有 .db、backups 表 0 行、/api/stats 的 lastBackupAt 恒为 null）。
  const rowId = ctx.db.createBackup({ path: res.snapshotPath, kind });
  ctx.db.finishBackup(rowId, {
    status: res.ok ? 'done' : 'failed',
    sizeBytes: res.sizeBytes,
    messageCount: res.messageCount,
    mediaCount: res.mediaCount,
    dbSha256: res.sha256,
    verifyResult: res.verify ? (res.verify.ok ? 'ok' : res.verify.problems.join('; ')) : 'skipped',
    ...(res.ok ? {} : { error: `备份校验失败：${res.problems.join('；')}` }),
  });

  // 保留份数裁剪：`backup.keep` 必须真的生效，否则备份目录会无限增长。
  const pruned = pruneBackups({
    db: ctx.db,
    backupDir: ctx.config.storage.backupDir,
    keep: ctx.config.backup.keep,
    logger: log,
    protect: [res.snapshotPath],
  });

  process.stdout.write(
    `\n备份${res.ok ? '完成' : '失败'}：${res.path}\n` +
      `  数据库 ${(res.dbSizeBytes / 1024 / 1024).toFixed(2)} MB｜消息 ${res.messageCount} 条｜媒体 ${res.mediaCount} 个（${(res.mediaBytes / 1024 / 1024).toFixed(2)} MB）\n` +
      `  清单 sha256 ${res.manifestSha256?.slice(0, 16) ?? '-'}…｜校验 ${res.verify?.ok ? '通过' : res.verify ? '失败' : '跳过'}\n` +
      (res.verify && !res.verify.ok ? `  校验问题: ${res.verify.problems.slice(0, 5).join('; ')}\n` : '') +
      (pruned.removed.length > 0
        ? `  已按 backup.keep=${ctx.config.backup.keep} 裁剪旧备份 ${pruned.removed.length} 份\n`
        : ''),
  );
  return res.ok ? 0 : 1;
}

async function cmdRestore(ctx: Ctx, args: string[], flags: Record<string, string | boolean>): Promise<number> {
  if (args.length === 0) {
    process.stderr.write('用法: qq-archive restore <备份目录或快照> [--apply] [--restore-media]\n');
    return 2;
  }
  const { restoreBackup } = await import('../../../packages/server/src/backup.ts');
  const log = ctx.logger.child('restore');
  const apply = flags.apply === true;
  // `--restore-media` 以前只被 parseArgs 收下、cmdRestore 从不读取 —— 一个"看着有、实际不生效"的开关。
  // 现在真的透传给 restoreBackup：非 dry-run 时把 manifest 里记录的媒体目录一起拷回。
  const restoreMedia = flags['restore-media'] === true;
  if (restoreMedia && !apply) {
    process.stdout.write('提示：--restore-media 只在真正恢复（--apply）时才有意义，dry-run 不会动媒体。\n');
  }
  const res = await restoreBackup({
    db: ctx.db,
    config: ctx.config,
    logger: log,
    backupPath: resolve(args[0]!),
    dryRun: !apply,
    restoreMedia,
  });
  process.stdout.write(
    `\n恢复${res.dryRun ? '演练（dry-run，未修改任何数据）' : '已执行'}：${res.ok ? '通过' : '失败'}\n` +
      `  清单消息 ${res.manifestMessageCount}｜清单媒体 ${res.manifestMediaCount}\n` +
      `  实际消息 ${res.actualMessageCount}｜实际媒体 ${res.actualMediaCount}\n` +
      (res.applied ? `  已恢复数据库到 ${res.applied.to}\n  原库备份在 ${res.applied.backupOfOld}\n` : '') +
      (apply && !restoreMedia ? '  媒体未一起恢复（加 --restore-media 可以连媒体一起拷回）\n' : '') +
      (res.problems.length ? `  问题:\n${res.problems.map((p: string) => `    - ${p}`).join('\n')}\n` : ''),
  );
  return res.ok ? 0 : 1;
}

/**
 * `qq-archive purge`：清除已归档的内容。
 *
 * 设计原则：**默认只演练**。删除是不可逆的，所以必须显式 `--yes` 才真的动手，
 * 且动手前把"将删什么、还剩什么"列清楚。可选 `--media` 顺带删掉不再被任何消息引用的媒体文件
 * （只删媒体根目录内的文件；仍在被引用的图绝不会被删）。
 */
async function cmdPurge(ctx: Ctx, flags: Record<string, string | boolean>): Promise<number> {
  const log = ctx.logger.child('purge');
  const yes = flags.yes === true;
  const withMedia = flags.media === true;
  const all = flags.all === true;
  const sessionArg = typeof flags.session === 'string' ? flags.session : undefined;

  if (!all && sessionArg === undefined) {
    process.stderr.write(
      '用法:\n' +
        '  qq-archive purge --session <id|名称> [--yes] [--media]   删除一个会话\n' +
        '  qq-archive purge --all [--yes] [--media]                  删除全部归档数据\n' +
        '默认只演练（列出会删什么），加 --yes 才真正执行。\n',
    );
    return 2;
  }
  if (all && sessionArg !== undefined) {
    process.stderr.write('--all 与 --session 不能同时使用。\n');
    return 2;
  }

  if (all) {
    const stats = ctx.db.stats();
    process.stdout.write(
      `\n将要删除**全部**归档数据：\n` +
        `  会话 ${stats.sessions} 个｜消息 ${stats.messages} 条｜媒体 ${stats.mediaTotal} 个（${(stats.mediaBytes / 1048576).toFixed(1)} MB）\n` +
        `  媒体文件：${withMedia ? '会一并删除' : '保留在磁盘上（加 --media 才删）'}\n` +
        `  备份文件不受影响（在 ${ctx.config.storage.backupDir}）\n`,
    );
    if (!yes) {
      process.stdout.write('\n演练结束：未删除任何内容。确认无误请加 --yes 重跑。\n');
      return 0;
    }
    const res = ctx.db.wipeAll();
    let media = { deleted: 0, bytes: 0 } as { deleted: number; bytes: number };
    if (withMedia) media = ctx.db.deleteOrphanMediaFiles(ctx.config.storage.mediaDir, false);
    log.warn('已清除全部归档数据', { messages: res.messages, sessions: res.sessions, mediaDeleted: media.deleted });
    process.stdout.write(
      `\n已清除：消息 ${res.messages} 条｜会话 ${res.sessions} 个｜媒体行 ${res.media} 个\n` +
        (withMedia ? `媒体文件 ${media.deleted} 个（${(media.bytes / 1048576).toFixed(1)} MB）已删除\n` : '媒体文件仍保留在磁盘上\n'),
    );
    return 0;
  }

  // 按 id 或名称定位会话
  const numeric = sessionArg !== undefined && /^\d+$/.test(sessionArg) ? Number(sessionArg) : null;
  let session = numeric !== null ? ctx.db.getSession(numeric) : null;
  if (session === null) {
    const matches = ctx.db.listSessions({ keyword: sessionArg ?? '', pageSize: 20 }).items;
    if (matches.length === 0) {
      process.stderr.write(`没有找到匹配的会话：${sessionArg}\n`);
      return 1;
    }
    if (matches.length > 1) {
      process.stderr.write(`匹配到 ${matches.length} 个会话，请用 id 指定其一：\n`);
      for (const m of matches.slice(0, 10)) {
        process.stderr.write(`  #${m.id}  ${m.name ?? m.peerUid}  （${m.messageCount} 条）\n`);
      }
      return 2;
    }
    session = matches[0] ?? null;
  }
  if (session === null) {
    process.stderr.write(`没有找到会话：${sessionArg}\n`);
    return 1;
  }

  const sid = session.id;
  const counts = ctx.db.raw
    .prepare(
      `SELECT (SELECT COUNT(*) FROM messages WHERE session_id = ?) AS messages,
              (SELECT COUNT(DISTINCT media_id) FROM message_media WHERE message_id IN (SELECT id FROM messages WHERE session_id = ?)) AS media`,
    )
    .get(sid, sid) as { messages: number; media: number };

  process.stdout.write(
    `\n将要删除会话 #${sid}「${session.name ?? session.peerUid}」：\n` +
      `  消息 ${counts.messages} 条｜涉及媒体 ${counts.media} 个（仅解除关联，文件默认保留）\n` +
      `  采集游标会保留：之后若重新采集该会话，会从上次位置继续，而不是从头回填\n` +
      (withMedia ? '  另外会删除**不再被任何消息引用**的媒体文件\n' : ''),
  );
  if (!yes) {
    process.stdout.write('\n演练结束：未删除任何内容。确认无误请加 --yes 重跑。\n');
    return 0;
  }
  const res = ctx.db.deleteSession(sid);
  let media = { deleted: 0, bytes: 0 };
  if (withMedia) media = ctx.db.deleteOrphanMediaFiles(ctx.config.storage.mediaDir, false);
  log.warn('已删除会话', { sessionId: sid, messages: res.messages, mediaDeleted: media.deleted });
  process.stdout.write(
    `\n已删除：消息 ${res.messages} 条｜解除媒体关联 ${res.mediaUnlinked} 个\n` +
      (withMedia ? `不再被引用的媒体文件 ${media.deleted} 个（${(media.bytes / 1048576).toFixed(1)} MB）已删除\n` : ''),
  );
  return 0;
}

/* ------------------------------------------------------------------ */
/* 采集端容器编排（`qq-archive collector …`）                            */
/* ------------------------------------------------------------------ */

/**
 * 为什么这里只是"编排"而不是"集成"：
 *
 * NapCat 不是能塞进我们进程里的库 —— 实测容器里跑的是
 * `Xvfb`（虚拟显示器）+ `/opt/QQ/qq`（**官方 QQ 客户端本体**，Electron）+ NapCat 的注入加载器，
 * 镜像 1.5 GB。把它打包进本项目的发布包意味着：
 *   1. 再分发闭源的官方 QQ 客户端（其许可不允许），并再分发 NapCat（其自定义许可禁止发布修改版）；
 *   2. 让归档进程持有你的 QQ 登录会话 —— 出问题时连"谁在碰我的账号"都分不清；
 *   3. 与 QQ 版本强绑定：客户端一升级，整个归档工具跟着失效。
 * 因此本项目只通过 loopback 的公开 HTTP 接口与它互操作（不分发、不修改）。
 * 但**安装与编排**完全可以自动化 —— 这就是这个命令做的事。
 */
interface RuntimeInfo {
  cmd: string;
  kind: 'podman' | 'docker';
}

/** 采集端默认值（与 docs/QUICKSTART.md 里实测过的那套参数一致）。 */
const COLLECTOR_DEFAULTS = {
  name: 'napcat-qq',
  image: 'docker.io/mlikiowa/napcat-docker:latest',
  onebotPort: 3000,
  webuiPort: 6099,
};

async function detectContainerRuntime(): Promise<RuntimeInfo | { error: string }> {
  const { spawnSync } = await import('node:child_process');
  for (const kind of ['podman', 'docker'] as const) {
    const r = spawnSync(kind, ['--version'], { encoding: 'utf8' });
    if (r.status === 0) return { cmd: kind, kind };
  }
  return {
    error:
      '没有找到 podman 或 docker。采集端（NapCat）需要跑官方 QQ 客户端 + 虚拟显示器，\n' +
      '  只能以容器方式运行。请先安装其中之一：\n' +
      '    Arch:   sudo pacman -S podman\n' +
      '    Debian: sudo apt install podman\n' +
      '    其它:   https://podman.io/docs/installation',
  };
}

async function cmdCollector(ctx: Ctx, args: string[], flags: Record<string, string | boolean>): Promise<number> {
  const action = args[0] ?? 'status';
  const { spawnSync } = await import('node:child_process');
  const run = (cmd: string, argv: string[]): { ok: boolean; out: string } => {
    const r = spawnSync(cmd, argv, { encoding: 'utf8' });
    return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
  };

  const rt = await detectContainerRuntime();
  if ('error' in rt) {
    process.stderr.write(`${rt.error}\n`);
    return 2;
  }
  const cmd = rt.cmd;
  const name = typeof flags.name === 'string' ? flags.name : COLLECTOR_DEFAULTS.name;
  const onebotPort = typeof flags['onebot-port'] === 'string' ? Number(flags['onebot-port']) : COLLECTOR_DEFAULTS.onebotPort;
  const webuiPort = typeof flags['webui-port'] === 'string' ? Number(flags['webui-port']) : COLLECTOR_DEFAULTS.webuiPort;
  const dataDir =
    typeof flags['data-dir'] === 'string' ? resolve(String(flags['data-dir'])) : resolve(process.env.HOME ?? '.', 'napcat/data');

  if (action !== 'setup' && action !== 'status') {
    process.stderr.write('用法: qq-archive collector <setup|status> [选项]\n');
    return 2;
  }
  if (action === 'setup') {
    if (!Number.isInteger(onebotPort) || onebotPort < 1 || onebotPort > 65535) {
      process.stderr.write(`--onebot-port 非法：${String(flags['onebot-port'])}\n`);
      return 2;
    }
    if (!Number.isInteger(webuiPort) || webuiPort < 1 || webuiPort > 65535) {
      process.stderr.write(`--webui-port 非法：${String(flags['webui-port'])}\n`);
      return 2;
    }
    if (onebotPort === webuiPort) {
      process.stderr.write('OneBot 端口与 WebUI 端口不能相同。\n');
      return 2;
    }
  }

  const exists = run(cmd, ['container', 'exists', name]).ok;
  const running = exists && run(cmd, ['inspect', '-f', '{{.State.Running}}', name]).out.trim() === 'true';
  const imageLocal = run(cmd, ['image', 'exists', COLLECTOR_DEFAULTS.image]).ok;

  if (action === 'status') {
    process.stdout.write(
      `容器运行时：${rt.kind}（${cmd}）\n` +
        `容器 ${name}：${exists ? (running ? '运行中' : '已创建但未运行') : '不存在'}\n` +
        `镜像：${imageLocal ? '已下载' : '未下载（首次 setup 会自动拉取，约 1.5 GB）'}\n` +
        `数据目录：${dataDir}${existsSync(dataDir) ? '' : '（尚未创建）'}\n` +
        `OneBot 端口：http://127.0.0.1:${onebotPort}　WebUI 端口：http://127.0.0.1:${webuiPort}\n`,
    );
    return 0;
  }

  /* ---------------------------- setup ---------------------------- */
  const { mkdirSync } = await import('node:fs');
  for (const sub of ['config', 'qq', 'plugins']) mkdirSync(join(dataDir, sub), { recursive: true });

  if (!exists) {
    if (!imageLocal) {
      process.stdout.write(`首次使用，正在拉取镜像（约 1.5 GB，来自 NapCat 官方镜像仓库）：\n  ${COLLECTOR_DEFAULTS.image}\n`);
      const pull = run(cmd, ['pull', COLLECTOR_DEFAULTS.image]);
      if (!pull.ok) {
        process.stderr.write(`拉取镜像失败：\n${pull.out}\n`);
        return 1;
      }
    }
    const argv = [
      'run', '-d', '--name', name, '--restart', 'unless-stopped',
      '-p', `127.0.0.1:${onebotPort}:3000`,
      '-p', `127.0.0.1:${webuiPort}:6099`,
      '-v', `${join(dataDir, 'config')}:/app/napcat/config`,
      '-v', `${join(dataDir, 'qq')}:/app/.config/QQ`,
      '-v', `${join(dataDir, 'plugins')}:/app/napcat/plugins`,
      COLLECTOR_DEFAULTS.image,
    ];
    process.stdout.write(`创建容器：\n  ${cmd} ${argv.join(' ')}\n`);
    const created = run(cmd, argv);
    if (!created.ok) {
      process.stderr.write(`创建容器失败：\n${created.out}\n`);
      return 1;
    }
  } else if (!running) {
    process.stdout.write(`容器 ${name} 已存在但未运行，正在启动…\n`);
    const started = run(cmd, ['start', name]);
    if (!started.ok) {
      process.stderr.write(`启动失败：\n${started.out}\n`);
      return 1;
    }
  } else {
    process.stdout.write(`容器 ${name} 已在运行，跳过创建（本命令是幂等的）。\n`);
  }

  // 等 OneBot 端口起来：未带 token 时 NapCat 会回 403，说明服务已在监听
  process.stdout.write('等待 OneBot 服务就绪…');
  let up = false;
  for (let i = 0; i < 30; i += 1) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const res = await fetch(`http://127.0.0.1:${onebotPort}/get_login_info`, { signal: AbortSignal.timeout(2000) });
      if (res.status === 403 || res.ok) {
        up = true;
        break;
      }
    } catch {
      /* 还没起来 */
    }
    process.stdout.write('.');
  }
  process.stdout.write('\n');
  if (!up) {
    // 全新容器里 OneBot 端口**本来就**不会立刻开：NapCat 要等 QQ 登录成功后才启动 OneBot 服务。
    // 所以先看一眼 WebUI 端口 —— 它先于 QQ 登录就绪。据此给出准确的下一步，而不是让人去翻日志。
    let webuiUp = false;
    try {
      const res = await fetch(`http://127.0.0.1:${webuiPort}/`, { signal: AbortSignal.timeout(2000) });
      webuiUp = res.status > 0;
    } catch {
      webuiUp = false;
    }
    if (webuiUp) {
      process.stdout.write(
        `OneBot 端口 ${onebotPort} 尚未就绪，但 WebUI（${webuiPort}）已经可用。\n` +
          '  这是**正常**的：NapCat 要先登录 QQ，才会启动 OneBot 服务。\n' +
          '  请先完成下面的第 1 步（扫码登录），之后这条命令才会探测到端口，token 也才会生成。\n',
      );
    } else {
      process.stdout.write(
        `端口 ${onebotPort} 与 ${webuiPort} 都还没就绪，容器可能启动失败，可看日志：\n  ${cmd} logs --tail 50 ${name}\n`,
      );
    }
  }

  // 从挂载出来的配置里读两个 token —— 这一步最容易填错，能自动就自动
  const found = await readNapcatTokens(dataDir);
  if (found.onebotToken !== null) {
    process.stdout.write(`已从 ${found.onebotTokenFrom} 读到 OneBot access token。\n`);
  } else {
    process.stdout.write('尚读不到 OneBot access token：通常是还没有 QQ 账号登录过（登录后 NapCat 才会生成 onebot11_<QQ号>.json）。\n');
  }

  const writeConfig = flags['write-config'] === true;
  if (writeConfig && found.onebotToken !== null) {
    const bak = await writeCollectorTokens(ctx, found, onebotPort, webuiPort);
    process.stdout.write(bak === null ? '配置写入失败（详见日志）。\n' : `已写入 config.json，原文件备份在 ${bak}。\n`);
  } else if (found.onebotToken !== null) {
    process.stdout.write('提示：加 --write-config 可以自动把这些值写进 config.json。\n');
  }

  const step = writeConfig ? 2 : 3;
  process.stdout.write(
    '\n下一步：\n' +
      `  1) 登录 QQ：打开 http://127.0.0.1:${webuiPort} 扫码，或运行 qq-archive login\n` +
      (writeConfig ? '' : '  2) 把 OneBot 的 token 填进 config.json 的 collector.token（或重跑并加 --write-config）\n') +
      `  ${step}) 验证采集：qq-archive collect --once\n`,
  );
  return 0;
}

/** 从 NapCat 挂载出来的目录里读 token（onebot11_<uin>.json 与 webui.json）。 */
export async function readNapcatTokens(dataDir: string): Promise<{
  onebotToken: string | null;
  onebotTokenFrom: string;
  webuiToken: string | null;
}> {
  const { readFileSync, readdirSync } = await import('node:fs');
  let onebotToken: string | null = null;
  let onebotTokenFrom = '';
  try {
    const cfgDir = join(dataDir, 'config');
    const file = readdirSync(cfgDir)
      .filter((f) => /^onebot11_.*\.json$/.test(f))
      .sort()[0];
    if (file !== undefined) {
      const parsed = JSON.parse(readFileSync(join(cfgDir, file), 'utf8')) as {
        network?: { httpServers?: Array<{ token?: string; enable?: boolean }> };
      };
      const server = (parsed.network?.httpServers ?? []).find(
        (s) => s.enable !== false && typeof s.token === 'string' && s.token !== '',
      );
      if (server?.token !== undefined && server.token !== '') {
        onebotToken = server.token;
        onebotTokenFrom = file;
      }
    }
  } catch {
    /* 读不到就当没有 */
  }
  let webuiToken: string | null = null;
  try {
    const webui = JSON.parse(readFileSync(join(dataDir, 'config', 'webui.json'), 'utf8')) as { token?: string };
    if (typeof webui.token === 'string' && webui.token !== '') webuiToken = webui.token;
  } catch {
    /* webui.json 可能还没生成 */
  }
  return { onebotToken, onebotTokenFrom, webuiToken };
}

/**
 * 把采集端参数写进 config.json。**写之前先备份**（`.bak-<时间戳>`），且只改这几个字段，
 * 其余内容原样保留。
 */
async function writeCollectorTokens(
  ctx: Ctx,
  tokens: { onebotToken: string | null; webuiToken: string | null },
  onebotPort: number,
  webuiPort: number,
): Promise<string | null> {
  const { readFileSync, writeFileSync, copyFileSync } = await import('node:fs');
  try {
    const path = ctx.configPath;
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
    const bak = `${path}.bak-${stamp}`;
    copyFileSync(path, bak);

    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const collector = (raw.collector && typeof raw.collector === 'object' ? raw.collector : {}) as Record<string, unknown>;
    collector.kind = 'onebot';
    collector.baseUrl = `http://127.0.0.1:${onebotPort}`;
    if (tokens.onebotToken !== null) collector.token = tokens.onebotToken;
    if (tokens.webuiToken !== null) {
      const napcat = (collector.napcat && typeof collector.napcat === 'object' ? collector.napcat : {}) as Record<string, unknown>;
      napcat.webuiUrl = `http://127.0.0.1:${webuiPort}`;
      napcat.token = tokens.webuiToken;
      collector.napcat = napcat;
    }
    raw.collector = collector;
    writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    return bak;
  } catch (err) {
    ctx.logger.child('collector').warn('写入采集端配置失败', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

async function cmdRefilter(ctx: Ctx, flags: Record<string, string | boolean>): Promise<number> {
  const { matchMessageFilter, describeFilters } = await import('../../../packages/collect/src/index.ts');
  const filters = filtersConfigOf(ctx.config);

  if (!filters.enabled) {
    // 关掉过滤后重算 = 没有规则命中任何消息 = 清空所有标记。这是可逆的
    // （重新启用规则再跑一次就回来了），所以直接做，而不是让用户卡在"命令说可以但实际拒绝"。
    process.stdout.write(
      '过滤未启用：本次重算会**清空所有**过滤标记（只改标记，不删除任何消息）。\n' +
        '重新启用 filters.enabled 再跑一次即可恢复标记。\n',
    );
  } else {
    process.stdout.write(`按当前规则重算已有消息的过滤标记：${describeFilters(filters)}\n`);
    if (filters.drop) {
      process.stdout.write(
        '  注意：drop=true 只影响**之后**的采集。已经入库的消息不会被删除 —— 重算只改标记。\n',
      );
    }
  }

  const batchSize = flags['batch'] ? Number(flags['batch']) : 2000;
  const limit = Number.isFinite(batchSize) && batchSize > 0 ? Math.min(Math.floor(batchSize), 20_000) : 2000;

  let cursor = 0;
  let scanned = 0;
  let flagged = 0;
  let unflagged = 0;
  for (;;) {
    const rows = ctx.db.listMessagesForFilter({ afterId: cursor, limit });
    if (rows.length === 0) break;
    const updates: Array<{ id: number; filtered: boolean; reason: string | null }> = [];
    for (const r of rows) {
      const verdict = matchMessageFilter(
        {
          msgType: r.msgType,
          text: r.text,
          ...(r.senderUin === null ? {} : { senderUin: r.senderUin }),
          ...(r.senderUid === null ? {} : { senderUid: r.senderUid }),
          ...(r.senderName === null ? {} : { senderName: r.senderName }),
        },
        filters,
      );
      // 只在结果真的变了的时候写库：重跑一次命令不该产生任何写入。
      if (verdict.filtered && (!r.filtered || r.filterReason !== verdict.reason)) {
        updates.push({ id: r.id, filtered: true, reason: verdict.reason });
        flagged += 1;
      } else if (!verdict.filtered && r.filtered) {
        updates.push({ id: r.id, filtered: false, reason: null });
        unflagged += 1;
      }
    }
    if (updates.length > 0) ctx.db.setMessageFilterFlags(updates);
    scanned += rows.length;
    cursor = rows[rows.length - 1]!.id;
    process.stdout.write(`\r  已扫描 ${scanned} 条…`);
  }
  process.stdout.write(
    `\r扫描完成：共 ${scanned} 条消息｜新标记 ${flagged} 条｜取消标记 ${unflagged} 条\n` +
      '（标记只影响网页默认显示与搜索；消息本身、导出、媒体关联都没动）\n',
  );
  return 0;
}

async function cmdVerify(ctx: Ctx): Promise<number> {
  const { MediaArchiver } = await import('../../../packages/import/src/media.ts');
  const archiver = new MediaArchiver({
    root: ctx.config.storage.mediaDir,
    maxBytes: ctx.config.collector.maxMediaBytes,
    logger: ctx.logger.child('verify'),
  });
  const all: Array<{ id: number; relPath: string; sha256: string; status: string }> = [];
  let page = 1;
  for (;;) {
    const res = ctx.db.listMedia({ page, pageSize: 200 });
    all.push(...res.items.map((r) => ({ id: r.id, relPath: r.relPath, sha256: r.sha256, status: r.status })));
    if (all.length >= res.total || res.items.length === 0) break;
    page++;
  }
  let present = 0;
  let missing = 0;
  let corrupt = 0;
  for (const row of all) {
    const status = await archiver.verify(row.relPath, row.sha256);
    if (status === 'present') present++;
    else if (status === 'missing') missing++;
    else corrupt++;
    if (status !== row.status) {
      ctx.db.markMediaStatus(row.id, status, status === 'corrupt' ? 'sha256 校验不一致' : null);
      ctx.db.appendLog({ level: 'warn', scope: 'verify', message: `媒体状态变更 ${row.id}: ${row.status} → ${status}` });
    }
  }
  process.stdout.write(`\n媒体校验完成：共 ${all.length}｜正常 ${present}｜缺失 ${missing}｜损坏 ${corrupt}\n`);
  return corrupt > 0 ? 1 : 0;
}

async function cmdDoctor(ctx: Ctx): Promise<number> {
  const cfg = ctx.config;
  const problems: string[] = [];
  const ok: string[] = [];
  const check = (cond: boolean, good: string, bad: string) => (cond ? ok.push(good) : problems.push(bad));

  check(existsSync(cfg.storage.dataDir), `数据目录存在: ${cfg.storage.dataDir}`, `数据目录不存在: ${cfg.storage.dataDir}`);
  const health = ctx.db.health();
  check(health.ok, `数据库可读写，schema v${health.schemaVersion}（最新 v${(await import('../../../packages/db/src/migrations.ts')).LATEST_VERSION}）`, '数据库不可用');
  if (ctx.tokenTemporary) {
    // 之前这里只看长度：自动生成的临时令牌长度必然合格，于是永远显示「✓ 管理令牌已设置」，
    // 把一个「令牌不可复现、网页登录必然失败」的错误状态报成了绿灯。
    problems.push(
      `管理令牌未写入配置文件：当前使用的是临时令牌（每次启动都不同，qq-archive token 也对不上运行中的服务）。` +
        `请把 server.token 写入 ${ctx.configPath}`,
    );
  } else {
    check(cfg.server.token.length >= 16, `管理令牌已设置（${cfg.server.token.length} 字符）`, '管理令牌过短或缺失');
  }
  const remote = !['127.0.0.1', 'localhost', '::1'].includes(cfg.server.host);
  if (remote) ok.push(`注意：监听 ${cfg.server.host}，非本机可访问，请确保已配置强令牌与防火墙`);
  else ok.push('默认仅本机可访问（127.0.0.1）');

  // ffmpeg（可选）
  try {
    const { execFile } = await import('node:child_process');
    const ff = await new Promise<boolean>((res) => {
      execFile('ffmpeg', ['-version'], (err) => res(!err));
    });
    if (ff) ok.push('ffmpeg 可用（视频缩略图/转码已启用）');
    else problems.push('ffmpeg 不可用（可选）：视频缩略图功能将降级，图片与文件归档不受影响');
  } catch {
    problems.push('ffmpeg 不可用（可选）');
  }

  // 语音转写（可选）：whisper-cli 在 PATH 上就必须提一句，不能静默忽略。
  const stt = sttConfigOf(cfg);
  const onPath = (name: string): boolean =>
    (process.env.PATH ?? '')
      .split(':')
      .some((dir) => dir.length > 0 && existsSync(join(dir, name)));
  if (stt.enabled) {
    try {
      const { WhisperCliTranscriber } = await import('../../../packages/stt/src/index.ts');
      const availability = await new WhisperCliTranscriber(stt, { logger: ctx.logger.child('stt') }).probe();
      if (availability.available) {
        ok.push(`语音转写可用：${availability.engine}（模型 ${availability.model}）`);
        for (const w of availability.warnings) ok.push(`语音转写提示：${w}`);
      } else {
        problems.push(`语音转写不可用：${availability.reason}`);
      }
    } catch (e) {
      problems.push(`语音转写引擎加载失败：${e instanceof Error ? e.message : String(e)}`);
    }
  } else if (onPath('whisper-cli')) {
    ok.push('语音转写未启用（检测到 whisper-cli；设置 stt.enabled = true 后可用 `qq-archive transcribe`）');
  } else {
    ok.push('语音转写未启用（未检测到 whisper-cli）');
  }

  // 磁盘空间
  try {
    const { statfs } = await import('node:fs/promises');
    const st = await statfs(cfg.storage.dataDir);
    const freeGb = (st.bavail * st.bsize) / 1e9;
    if (freeGb < cfg.alert.diskLowGb) problems.push(`磁盘剩余空间不足：${freeGb.toFixed(2)} GB < ${cfg.alert.diskLowGb} GB`);
    else ok.push(`磁盘剩余空间 ${freeGb.toFixed(1)} GB`);
  } catch {
    problems.push('无法读取磁盘空间统计');
  }

  // 采集端
  if (cfg.collector.kind === 'onebot') {
    try {
      const { OneBotCollector } = await import('../../../packages/collect/src/index.ts');
      const c = new OneBotCollector({ baseUrl: cfg.collector.baseUrl, token: cfg.collector.token });
      const probe = await c.probe();
      check(probe.ok, `采集端可用：${probe.nickname ?? ''} (${probe.uin ?? ''})`, `采集端不可用：${probe.error ?? '连接失败'}（${cfg.collector.baseUrl}）`);
    } catch (e) {
      problems.push(`采集适配器加载失败：${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    ok.push('采集未启用（collector.kind = none）；仍可用 import 导入导出文件');
  }

  const stats = ctx.db.stats();
  process.stdout.write(`\n环境自检报告\n${'─'.repeat(52)}\n`);
  for (const o of ok) process.stdout.write(`  ✓ ${o}\n`);
  for (const p of problems) process.stdout.write(`  ! ${p}\n`);
  process.stdout.write(
    `${'─'.repeat(52)}\n  归档现状：会话 ${stats.sessions}｜消息 ${stats.messages}｜媒体 ${stats.mediaPresent}/${stats.mediaTotal}｜` +
      `数据库 ${(ctx.db.fileSize() / 1024 / 1024).toFixed(2)} MB\n  配置文件：${ctx.configPath}\n\n`,
  );
  return problems.length > 0 ? 1 : 0;
}

async function cmdStats(ctx: Ctx): Promise<number> {
  const s = ctx.db.stats();
  const media = ctx.db.mediaStats();
  process.stdout.write(
    `\n归档统计\n${'─'.repeat(44)}\n` +
      `  账号        ${s.accounts}\n` +
      `  会话        ${s.sessions}（群 ${s.groups} / 私聊 ${s.privates}）\n` +
      `  消息        ${s.messages}（今日 ${s.messagesToday}）\n` +
      `  媒体        ${media.present} 已保存 / ${media.total} 总数（缺失 ${media.missing}、损坏 ${media.corrupt}）\n` +
      `  媒体占用    ${(media.bytes / 1024 / 1024).toFixed(2)} MB\n` +
      `  最近消息    ${s.lastMessageAt ? new Date(s.lastMessageAt).toLocaleString('zh-CN') : '无'}\n` +
      `  最近采集    ${s.lastCollectAt ?? '从未'}\n` +
      `  最近备份    ${s.lastBackupAt ?? '从未'}（${s.lastBackupStatus ?? '-'}）\n` +
      `  任务        待处理 ${s.pendingJobs} / 失败 ${s.failedJobs}\n\n`,
  );
  return 0;
}

async function cmdToken(ctx: Ctx): Promise<number> {
  process.stdout.write(`${ctx.config.server.token}\n`);
  if (ctx.tokenTemporary) {
    // 这个值只对「本进程」有效：serve 在另一个进程里跑，它的临时令牌与这里不同。
    // 静默打印会让用户拿一个永远登录不上的令牌去试，必须说清楚。
    process.stderr.write(
      '注意：配置文件里没有 server.token，上面这个令牌是本次运行临时生成的，' +
        '每次启动都会变，**无法用于登录正在运行的服务**。\n' +
        `请写入配置文件后重启：  ${ctx.configPath}\n`,
    );
    return 1;
  }
  return 0;
}

async function cmdLogs(ctx: Ctx, flags: Record<string, string | boolean>): Promise<number> {
  const limit = Number(flags.limit ?? 30);
  const page = ctx.db.listLogs({ limit, ...(flags.level ? { level: flags.level as 'warn' } : {}) });
  for (const l of page.items.reverse()) {
    process.stdout.write(`${l.ts} ${l.level.toUpperCase().padEnd(5)} [${l.scope}] ${l.message}\n`);
  }
  return 0;
}

/* ------------------------------------------------------------------ */
/** `transcribe` 的可注入依赖：测试用假 exec 避免真的起 whisper/ffmpeg，用 out/err 捕获输出。 */
export interface TranscribeCliOptions {
  exec?: ExecFn;
  out?: (chunk: string) => void;
  err?: (chunk: string) => void;
}

export async function cmdTranscribe(
  ctx: Ctx,
  flags: Record<string, string | boolean>,
  options: TranscribeCliOptions = {},
): Promise<number> {
  const { WhisperCliTranscriber, transcribePending } = await import('../../../packages/stt/src/index.ts');
  const stt = sttConfigOf(ctx.config);
  const asJson = flags.json === true;
  const out = options.out ?? ((chunk: string) => void process.stdout.write(chunk));
  const err = options.err ?? ((chunk: string) => void process.stderr.write(chunk));

  if (!stt.enabled) {
    // 不静默降级为「0 条待转写」：那会让用户以为任务跑完了，其实开关根本没开。
    err('语音转写未启用：请在配置文件里设置 stt.enabled = true（或环境变量 QQ_ARCHIVE_STT_ENABLED=1）后重试。\n');
    return 2;
  }

  const transcriber = new WhisperCliTranscriber(stt, {
    logger: ctx.logger.child('stt'),
    ...(options.exec === undefined ? {} : { exec: options.exec }),
  });
  // 先探测：模型/二进制/ffmpeg 缺一不可，不可用就把原因原样打出来并返回非零。
  const availability = await transcriber.probe();
  if (!availability.available) {
    err(`语音转写不可用：${availability.reason}\n`);
    return 1;
  }
  for (const w of availability.warnings) err(`警告：${w}\n`);

  // --media <id>：只转一条（走 transcriber.transcribe，与批量共用同一套边界检查）。
  if (flags.media !== undefined) {
    const id = Number(flags.media);
    const row = Number.isInteger(id) ? ctx.db.getMedia(id) : null;
    if (!row) {
      err(`媒体不存在：${String(flags.media)}\n`);
      return 1;
    }
    if (row.kind !== 'audio') {
      err(`媒体 ${id} 不是语音（kind=${row.kind}），无法转写。\n`);
      return 1;
    }
    if (row.status !== 'present') {
      err(`媒体 ${id} 的文件状态是 ${row.status}，无法转写。\n`);
      return 1;
    }
    // 与批量路径同一套边界：rel_path 逾越媒体根（../）直接拒绝，绝不读根以外的文件。
    const mediaRoot = resolve(ctx.config.storage.mediaDir);
    const abs = resolve(mediaRoot, row.relPath);
    if (abs !== mediaRoot && !abs.startsWith(mediaRoot + sep)) {
      err(`媒体 ${id} 的 rel_path 越界（${row.relPath}），拒绝转写。\n`);
      return 1;
    }
    try {
      const result = await transcriber.transcribe({
        path: abs,
        language: typeof flags.lang === 'string' ? flags.lang : typeof flags.language === 'string' ? flags.language : stt.language,
        durationSec: row.duration ?? null,
      });
      ctx.db.upsertTranscript({
        mediaId: id,
        text: result.text,
        language: result.language,
        engine: result.engine,
        model: result.model,
        segments: result.segments,
        elapsedMs: result.elapsedMs,
      });
      if (asJson) {
        out(`${JSON.stringify({ mediaId: id, relPath: row.relPath, ...result })}\n`);
      } else {
        out(
          `\n转写完成：媒体 ${id}（${row.relPath}）\n` +
            `  语言 ${result.language}｜分段 ${result.segments}｜用时 ${(result.elapsedMs / 1000).toFixed(1)}s｜字数 ${result.text.length}\n` +
            `  正文：${result.text.length > 0 ? result.text : '（无语音内容）'}\n\n`,
        );
      }
      return 0;
    } catch (e) {
      err(`转写失败：${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
  }

  // 批量：把 --limit / --lang 交给 pipeline；它会做 [1, MAX] 截断与逐条容错。
  const stats = await transcribePending(transcriber, ctx.db, {
    mediaDir: ctx.config.storage.mediaDir,
    limit: flags.limit !== undefined ? Number(flags.limit) : undefined,
    language: typeof flags.lang === 'string' ? flags.lang : typeof flags.language === 'string' ? flags.language : stt.language,
    // --json 时 stdout 必须只含 JSON，进度行会污染管道（jq 解析失败），因此改到 stderr。
    ...(asJson
      ? {}
      : {
          onProgress: (ev: TranscribeProgress) => {
            const label = ev.status === 'ok' ? '完成' : ev.status === 'empty' ? '无内容' : ev.status === 'skipped' ? '跳过' : '失败';
            const tail = ev.error ? `（${ev.error}）` : '';
            out(`  [${ev.index}/${ev.total}] 媒体 ${ev.mediaId} ${label}${tail} ${ev.relPath}\n`);
          },
        }),
    logger: ctx.logger.child('stt'),
  });

  if (asJson) {
    out(`${JSON.stringify(stats)}\n`);
  } else {
    out(
      `\n语音转写完成\n${'─'.repeat(44)}\n` +
        `  候选        ${stats.candidates}\n` +
        `  成功        ${stats.transcribed}\n` +
        `  无语音内容  ${stats.empty}\n` +
        `  跳过        ${stats.skipped}\n` +
        `  失败        ${stats.failed}\n` +
        `  用时        ${(stats.elapsedMs / 1000).toFixed(1)}s\n`,
    );
    for (const item of stats.errors) out(`  ! 媒体 ${item.mediaId}：${item.error}\n`);
    out('\n');
  }
  return stats.failed === 0 ? 0 : 1;
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

export async function main(argv: string[]): Promise<number> {
  const { command, args, flags } = parseArgs(argv);
  // 版本判断必须在帮助之前：`--version` / `-V` 不能退化成打印用法。
  if (flags.version || flags.V || command === '--version' || command === '-V') {
    process.stdout.write(`qq-archive ${VERSION}\n`);
    return 0;
  }
  if (flags.help || command === '' || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(usage());
    return 0;
  }

  const known = new Set(['serve', 'import', 'collect', 'backup', 'restore', 'verify', 'refilter', 'collector', 'purge', 'doctor', 'token', 'stats', 'logs', 'login', 'transcribe']);
  if (!known.has(command)) {
    process.stderr.write(`未知命令: ${command}\n\n${usage()}`);
    return 2;
  }

  const ctx = await buildCtx(typeof flags.config === 'string' ? flags.config : undefined);
  // `--json` 时 stdout 必须是纯 JSON（usage 里承诺「脚本可直接解析」），因此跳过这行 INFO。
  if (!flags.json) ctx.logger.child(BOOT_LOGGER_SCOPE).info(`执行命令 ${command}`, { configPath: ctx.configPath });
  try {
    switch (command) {
      case 'serve':
        return await cmdServe(ctx, flags);
      case 'import':
        return await cmdImport(ctx, args, flags);
      case 'collect':
        return await cmdCollect(ctx, flags);
      case 'backup':
        return await cmdBackup(ctx, flags);
      case 'restore':
        return await cmdRestore(ctx, args, flags);
      case 'verify':
        return await cmdVerify(ctx);
      case 'refilter':
        return await cmdRefilter(ctx, flags);
      case 'collector':
        return await cmdCollector(ctx, args, flags);
      case 'purge':
        return await cmdPurge(ctx, flags);
      case 'doctor':
        return await cmdDoctor(ctx);
      case 'token':
        return await cmdToken(ctx);
      case 'stats':
        return await cmdStats(ctx);
      case 'logs':
        return await cmdLogs(ctx, flags);
      case 'login':
        return await cmdLogin(ctx, flags);
      case 'transcribe':
        return await cmdTranscribe(ctx, flags);
      default:
        return 2;
    }
  } finally {
    await disposeCtx(ctx);
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename);
if (isMain) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.stack ?? err.message : String(err);
      process.stderr.write(`\n致命错误: ${msg}\n`);
      process.exitCode = 1;
    });
}
