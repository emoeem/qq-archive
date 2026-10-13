/**
 * 批量转写流水线。
 *
 * 本文件只做「取出待转写的音频 → 调引擎 → 写回结果」这一件事，**刻意不 import
 * packages/db / packages/core**：调用方（CLI、HTTP 服务）直接把自己的
 * 数据库对象传进来即可 —— 只要它在结构上满足 `TranscriptSink`。
 * 这样 STT 不会把 db 依赖扩散出去，单测也不需要真数据库。
 *
 * 关键语义（防丢失/可重跑）：
 *  - 转写成功（含「静音、转出来是空串」）都会写一行 → 下次不会重复跑 whisper；
 *  - 文件不在盘上时**不写行**，计入 skipped，文件恢复后还能再跑；
 *  - 单条失败默认继续跑下一条，失败详情进 `errors`，绝不静默吞掉。
 */
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';

import type { WhisperCliTranscriber, WhisperCliOptions } from './whisper.ts';
import { transcriberFromConfig, type SttLikeConfig } from './whisper.ts';

export const DEFAULT_TRANSCRIBE_LIMIT = 50;
export const MAX_TRANSCRIBE_LIMIT = 1000;

/** 一条待转写音频（`media` 表里够用的最小投影）。 */
export interface PendingAudio {
  id: number;
  relPath: string;
  size?: number | null;
  duration?: number | null;
}

/** 调用方提供的持久化端口；`packages/db` 的 `Db` 结构上直接满足。 */
export interface TranscriptSink {
  listUntranscribedAudio(limit: number): PendingAudio[];
  upsertTranscript(input: {
    mediaId: number;
    text: string;
    language?: string | null;
    engine: string;
    model?: string | null;
    segments?: number;
    elapsedMs?: number | null;
  }): void;
}

export interface TranscribeBatchOptions {
  /** 媒体根目录；`relPath` 相对它解析。 */
  mediaDir: string;
  /** 本轮最多处理多少条，默认 `DEFAULT_TRANSCRIBE_LIMIT`。 */
  limit?: number;
  /** 覆盖配置里的语言（例如 `--lang en`）。 */
  language?: string;
  /** 单条失败是否继续，默认 true。 */
  continueOnError?: boolean;
  onProgress?: (ev: TranscribeProgress) => void;
  logger?: { warn: (message: string, data?: unknown) => void };
  /** 文件存在性探测（测试注入）。 */
  fileExists?: (path: string) => boolean;
}

export interface TranscribeProgress {
  index: number;
  total: number;
  mediaId: number;
  relPath: string;
  status: 'ok' | 'empty' | 'skipped' | 'failed';
  text?: string;
  language?: string;
  segments?: number;
  elapsedMs?: number;
  error?: string;
}

export interface TranscribeBatchStats {
  /** 本轮从库里取出的候选数。 */
  candidates: number;
  /** 真正写入了非空文本的条数。 */
  transcribed: number;
  /** 写入了空文本（静音/无语音）的条数 —— 也算处理过。 */
  empty: number;
  failed: number;
  /** 文件缺失或路径越界，未写库。 */
  skipped: number;
  elapsedMs: number;
  errors: Array<{ mediaId: number; error: string }>;
}

/**
 * 把 `relPath` 解析成绝对路径，并确保它真的落在 `mediaDir` 里。
 * 越界（`..`/绝对路径外逃）返回 null —— 宁可跳过，也不去读媒体根以外的文件。
 */
function resolveInside(mediaDir: string, relPath: string): string | null {
  const root = resolve(mediaDir);
  const abs = isAbsolute(relPath) ? resolve(relPath) : resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + sep)) return null;
  return abs;
}

/**
 * 按 `limit` 取一批「还没转写的音频」，逐条转写并写回。
 *
 * 注意：`limit` 限制的是**本轮候选数**，而不是「必须成功多少条」——
 * 文件缺失被跳过的条数会占用候选名额，下一轮才能轮到别的音频。
 * 这样设计是为了避免「一条永远缺失的音频卡住整个队列」。
 */
export async function transcribePending(
  transcriber: WhisperCliTranscriber,
  sink: TranscriptSink,
  opts: TranscribeBatchOptions,
): Promise<TranscribeBatchStats> {
  const started = Date.now();
  const limit = Math.min(
    MAX_TRANSCRIBE_LIMIT,
    Math.max(1, Math.floor(opts.limit ?? DEFAULT_TRANSCRIBE_LIMIT)),
  );
  const fileExists = opts.fileExists ?? ((p: string) => existsSync(p));
  const continueOnError = opts.continueOnError !== false;

  const stats: TranscribeBatchStats = {
    candidates: 0,
    transcribed: 0,
    empty: 0,
    failed: 0,
    skipped: 0,
    elapsedMs: 0,
    errors: [],
  };

  const pending = sink.listUntranscribedAudio(limit);
  stats.candidates = pending.length;

  for (let i = 0; i < pending.length; i++) {
    const row = pending[i]!;
    const abs = resolveInside(opts.mediaDir, row.relPath);
    const emit = (ev: Omit<TranscribeProgress, 'index' | 'total' | 'mediaId' | 'relPath'>) =>
      opts.onProgress?.({ index: i + 1, total: pending.length, mediaId: row.id, relPath: row.relPath, ...ev });

    if (abs === null) {
      stats.skipped++;
      const error = '媒体路径越界，已跳过（不写库）';
      opts.logger?.warn(`语音转写跳过 media#${row.id}：${error}`, { relPath: row.relPath });
      emit({ status: 'skipped', error });
      continue;
    }
    if (!fileExists(abs)) {
      stats.skipped++;
      const error = '文件不在盘上，已跳过（不写库，待文件恢复后可重试）';
      opts.logger?.warn(`语音转写跳过 media#${row.id}：${error}`, { path: abs });
      emit({ status: 'skipped', error });
      continue;
    }

    try {
      const result = await transcriber.transcribe({
        path: abs,
        language: opts.language,
        durationSec: row.duration ?? null,
      });
      sink.upsertTranscript({
        mediaId: row.id,
        text: result.text,
        language: result.language,
        engine: result.engine,
        model: result.model,
        segments: result.segments,
        elapsedMs: result.elapsedMs,
      });
      const isEmpty = result.text.trim().length === 0;
      if (isEmpty) stats.empty++;
      else stats.transcribed++;
      emit({
        status: isEmpty ? 'empty' : 'ok',
        text: result.text,
        language: result.language,
        segments: result.segments,
        elapsedMs: result.elapsedMs,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      stats.failed++;
      stats.errors.push({ mediaId: row.id, error });
      opts.logger?.warn(`语音转写失败 media#${row.id}（不影响其它条目）`, { error });
      emit({ status: 'failed', error });
      if (!continueOnError) break;
    }
  }

  stats.elapsedMs = Date.now() - started;
  return stats;
}

/**
 * 用配置构造默认引擎的便捷入口：等价于 `transcriberFromConfig(config, options)`
 * 再交给 `transcribePending`，供 CLI/服务一行调用。
 */
export function engineFromConfig(
  config: SttLikeConfig,
  options: WhisperCliOptions = {},
): WhisperCliTranscriber {
  return transcriberFromConfig(config, options);
}
