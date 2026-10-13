/**
 * 语音转文字（STT）：whisper.cpp 适配器。
 *
 * ## 为什么是「外部进程」而不是纯 JS
 * 语音识别需要模型权重与解码器，没有可用的纯 JS 实现。本机可用的开源方案是
 * whisper.cpp 的官方 CLI（`whisper-cli`）。因此本模块**不绑定任何 npm 依赖**，
 * 只负责：
 *   1. 探测 `whisper-cli` / `ffmpeg` / ggml 模型是否真的存在（`probe()`）；
 *   2. 把任意 ffmpeg 能解的音频（QQ 语音是 `amr`，部分版本是 `silk`）转成
 *      16kHz 单声道 wav；
 *   3. 调 `whisper-cli` 拿纯文本；
 *   4. 清理临时目录。
 *
 * ## 真实边界（必须如实告知）
 *  - **必须装 whisper.cpp 与 ggml 模型**，否则 `probe()` 返回不可用，`transcribe()`
 *    抛错。这不影响归档主流程：STT 默认关闭（`stt.enabled=false`）。
 *  - 模型必须是**多语言**版本。`ggml-*-*.en.bin` 是英文专用模型，喂中文语音会
 *    得到近乎空的输出（本仓库实测确认），`probe()` 会对 `.en.bin` 给出警告。
 *  - 转写质量取决于模型与音频质量；QQ 语音常见 8kHz AMR，属于窄带，识别率
 *    明显低于宽带录音。转写文本是**辅助检索**用途，不是逐字准确稿。
 *  - 本模块只处理「已经从 QQ 拉下来并归档到磁盘」的音频文件，不联网、不上传。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 引擎标识（写入数据库，便于将来并存其它引擎）。 */
export const WHISPER_ENGINE = 'whisper-cli';

/** 16kHz 单声道是 whisper 的训练采样率，转码到别处会掉识别率。 */
export const WHISPER_SAMPLE_RATE = 16_000;

/** 子进程执行结果。 */
export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 子进程执行选项。 */
export interface ExecOptions {
  timeoutMs: number;
}

/** 可注入的执行器（测试用假实现，生产走 `defaultExec`）。 */
export type ExecFn = (cmd: string, args: string[], opts: ExecOptions) => Promise<ExecResult>;

/** 默认执行器：`spawn` + 超时强杀 + 收集 stdout/stderr。 */
export const defaultExec: ExecFn = (cmd, args, opts) =>
  new Promise<ExecResult>((resolvePromise, rejectPromise) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      rejectPromise(new Error(`命令超时（${opts.timeoutMs}ms）：${cmd} ${args.slice(0, 3).join(' ')}`));
    }, opts.timeoutMs);
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on('error', (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(err);
    });
    child.on('close', (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ code: code ?? -1, stdout, stderr });
    });
  });

/** 可用性探测结果。 */
export interface SttAvailability {
  available: boolean;
  /** 不可用原因；可用时为空串。 */
  reason: string;
  engine: string;
  binary: string;
  ffmpeg: string;
  model: string;
  /** 非致命的提醒（例如模型是英文专用版）。 */
  warnings: string[];
}

/** 一次转写请求。 */
export interface TranscribeRequest {
  /** 音频文件路径（任意 ffmpeg 能解的形式：amr / silk / mp3 / ogg / wav…）。 */
  path: string;
  /** 覆盖配置里的语言。 */
  language?: string;
  /** 已知音频时长（秒）；给出且超过 `maxDurationSec` 时直接拒绝，不启动进程。 */
  durationSec?: number | null;
}

/** 转写结果。 */
export interface TranscriptResult {
  /** 纯文本；静音/纯噪声时可能是空串（空串也会被调用方入库，避免每次重跑）。 */
  text: string;
  language: string;
  engine: string;
  model: string;
  /** 非空片段数（whisper 输出的有效行数）。 */
  segments: number;
  /** 本次转写耗时（毫秒，含 ffmpeg 转码）。 */
  elapsedMs: number;
}

/**
 * 与 `SttConfig` 结构兼容的最小配置（刻意不 import core，保持包依赖最小）。
 */
export interface SttLikeConfig {
  binary: string;
  ffmpeg: string;
  model: string;
  language: string;
  vadModel: string;
  threads: number;
  timeoutMs: number;
  maxDurationSec: number;
}

/** 构造参数：在配置之上再允许注入执行器/临时目录/文件探测，便于测试。 */
export interface WhisperCliOptions {
  exec?: ExecFn;
  /** 临时目录根；默认 `os.tmpdir()`。 */
  tmpDir?: string;
  /** 文件存在性探测；默认 `fs.existsSync`。 */
  fileExists?: (path: string) => boolean;
  /** 读取文本文件；默认 `fs.readFileSync(utf8)`。 */
  readText?: (path: string) => string;
  logger?: { warn: (message: string, data?: unknown) => void };
}

const DEFAULTS: SttLikeConfig = {
  binary: 'whisper-cli',
  ffmpeg: 'ffmpeg',
  model: '',
  language: 'zh',
  vadModel: '',
  threads: 4,
  timeoutMs: 600_000,
  maxDurationSec: 600,
};

/**
 * whisper 对静音/噪声的占位输出，不算正文。
 *
 * 注意括号**内侧**的空格：whisper.cpp 实际会输出 `[ Silence ]`、`[ Music ]`
 * 这种带空格的形式，若不容忍内侧空白，静音片段会被当成正文存进库里。
 */
const NON_SPEECH = /^[[(]\s*(?:blank_?audio|silence|music|inaudible|no speech|background noise|bgm|applause|laughter|sound effect)\s*[)\]]$/i;

/**
 * 规整 whisper 的输出文本。
 *
 *  - 去掉可能残留的 `[00:00:00.000 --> 00:00:02.000]` 时间戳前缀（`-nt` 下不该有，
 *    但不同版本/参数组合会带出来）；
 *  - 丢掉 `[BLANK_AUDIO]`、`(music)` 这类非语音占位；
 *  - 合并行内连续空白，去掉每行首尾空白。
 */
export function normalizeTranscript(raw: string): { text: string; segments: number } {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\[[\d:.,\s>-]+\]\s*/, '').trim())
    .filter((line) => line.length > 0 && !NON_SPEECH.test(line));
  const text = lines
    .map((line) => line.replace(/[ \t\u00a0\u200b]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n')
    .trim();
  return { text, segments: lines.length };
}

/** 取 stderr 末尾若干字符，避免把整段日志塞进错误消息。 */
function tail(text: string, max = 400): string {
  const s = text.trim();
  return s.length <= max ? s : `…${s.slice(-max)}`;
}

/**
 * 英文专用模型文件名识别。
 *
 * whisper.cpp 官方发布的 `ggml-<size>.en.bin` 只支持英文；用它转中文会得到
 * 近乎空的输出，这是最容易踩的坑，所以在探测阶段就提醒。
 */
export function isEnglishOnlyModel(path: string): boolean {
  return /\.en\.bin$/i.test(path) || /[-.]en[-.]/i.test(path);
}

/** whisper.cpp 适配器。 */
export class WhisperCliTranscriber {
  readonly engine = WHISPER_ENGINE;
  private readonly cfg: SttLikeConfig;
  private readonly exec: ExecFn;
  private readonly tmpDir: string;
  private readonly fileExists: (path: string) => boolean;
  private readonly readText: (path: string) => string;
  private readonly logger: { warn: (message: string, data?: unknown) => void } | undefined;
  private cached: SttAvailability | null = null;

  constructor(config: Partial<SttLikeConfig> = {}, options: WhisperCliOptions = {}) {
    this.cfg = { ...DEFAULTS, ...config };
    this.exec = options.exec ?? defaultExec;
    this.tmpDir = options.tmpDir ?? tmpdir();
    this.fileExists = options.fileExists ?? existsSync;
    this.readText = options.readText ?? ((path) => readFileSync(path, 'utf8'));
    this.logger = options.logger;
  }

  /** 当前生效的配置快照（只读用途）。 */
  get config(): Readonly<SttLikeConfig> {
    return this.cfg;
  }

  /**
   * 探测可执行文件与模型是否就绪。结果会缓存；`force` 可强制重新探测。
   *
   * 探测只跑 `--help` / `-version`，不加载模型，因此很快。
   */
  async probe(force = false): Promise<SttAvailability> {
    if (this.cached !== null && !force) return this.cached;
    const base: SttAvailability = {
      available: false,
      reason: '',
      engine: this.engine,
      binary: this.cfg.binary,
      ffmpeg: this.cfg.ffmpeg,
      model: this.cfg.model,
      warnings: [],
    };

    if (this.cfg.model.trim().length === 0) {
      this.cached = { ...base, reason: '未配置 stt.model：语音转文字需要一个本地 ggml 模型文件' };
      return this.cached;
    }
    if (!this.fileExists(this.cfg.model)) {
      this.cached = { ...base, reason: `模型文件不存在：${this.cfg.model}` };
      return this.cached;
    }

    const warnings: string[] = [];
    if (isEnglishOnlyModel(this.cfg.model)) {
      warnings.push(
        `模型 ${this.cfg.model} 看起来是英文专用版（*.en.bin），中文语音会得到近乎空的输出；请换多语言模型。`,
      );
    }

    const ffmpeg = await this.spawnable(this.cfg.ffmpeg, ['-hide_banner', '-version']);
    if (!ffmpeg.spawned) {
      this.cached = { ...base, warnings, reason: `ffmpeg 不可用（${this.cfg.ffmpeg}）：${ffmpeg.error}` };
      return this.cached;
    }
    const binary = await this.spawnable(this.cfg.binary, ['--help']);
    if (!binary.spawned) {
      this.cached = { ...base, warnings, reason: `whisper-cli 不可用（${this.cfg.binary}）：${binary.error}` };
      return this.cached;
    }

    this.cached = { ...base, available: true, warnings };
    for (const w of warnings) this.logger?.warn(w);
    return this.cached;
  }

  /**
   * 转写一个音频文件。
   *
   * 抛错场景：STT 未就绪、音频超过 `maxDurationSec`、ffmpeg 转码失败、
   * whisper 退出码非 0、命令超时。
   */
  async transcribe(req: TranscribeRequest): Promise<TranscriptResult> {
    const availability = await this.probe();
    if (!availability.available) throw new Error(`语音转写不可用：${availability.reason}`);

    const language = (req.language ?? this.cfg.language).trim() || 'auto';
    const duration = req.durationSec ?? null;
    if (duration !== null && this.cfg.maxDurationSec > 0 && duration > this.cfg.maxDurationSec) {
      throw new Error(
        `音频时长 ${duration.toFixed(1)}s 超过 stt.maxDurationSec=${this.cfg.maxDurationSec}s，跳过`,
      );
    }

    const started = Date.now();
    const work = mkdtempSync(join(this.tmpDir, 'qq-archive-stt-'));
    const wav = join(work, 'audio.wav');
    const outBase = join(work, 'out');
    try {
      const ffArgs = [
        '-hide_banner',
        '-nostdin',
        '-y',
        '-i',
        req.path,
        '-ar',
        String(WHISPER_SAMPLE_RATE),
        '-ac',
        '1',
        '-c:a',
        'pcm_s16le',
        '-f',
        'wav',
        wav,
      ];
      const ff = await this.exec(this.cfg.ffmpeg, ffArgs, { timeoutMs: this.cfg.timeoutMs });
      if (ff.code !== 0) {
        throw new Error(`ffmpeg 转码失败（退出码 ${ff.code}）：${tail(ff.stderr)}`);
      }

      const args = ['-m', this.cfg.model, '-f', wav, '-l', language, '-otxt', '-of', outBase, '-nt'];
      if (this.cfg.threads > 0) args.push('-t', String(this.cfg.threads));
      if (this.cfg.vadModel.trim().length > 0) args.push('--vad', '-vm', this.cfg.vadModel);

      const wh = await this.exec(this.cfg.binary, args, { timeoutMs: this.cfg.timeoutMs });
      if (wh.code !== 0) {
        throw new Error(`whisper-cli 转写失败（退出码 ${wh.code}）：${tail(wh.stderr)}`);
      }

      const txtPath = `${outBase}.txt`;
      const raw = this.fileExists(txtPath) ? this.readText(txtPath) : wh.stdout;
      const { text, segments } = normalizeTranscript(raw);
      return {
        text,
        segments,
        language,
        engine: this.engine,
        model: this.cfg.model,
        elapsedMs: Date.now() - started,
      };
    } finally {
      try {
        rmSync(work, { recursive: true, force: true });
      } catch {
        // 临时目录清理失败不应掩盖真正的错误。
      }
    }
  }

  /** 判断可执行文件能否被 `spawn`（不关心退出码：`--help` 有的版本返回 1）。 */
  private async spawnable(cmd: string, args: string[]): Promise<{ spawned: boolean; error: string }> {
    try {
      await this.exec(cmd, args, { timeoutMs: Math.min(this.cfg.timeoutMs, 30_000) });
      return { spawned: true, error: '' };
    } catch (err) {
      return { spawned: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

/** 用 `SttConfig`（结构兼容）构造适配器。 */
export function transcriberFromConfig(
  config: SttLikeConfig,
  options: WhisperCliOptions = {},
): WhisperCliTranscriber {
  return new WhisperCliTranscriber(config, options);
}
