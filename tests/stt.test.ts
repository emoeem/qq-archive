/**
 * 语音转文字（STT）测试。
 *
 * 两条原则：
 *  1. **绝不真的 spawn** ffmpeg / whisper-cli —— 全部通过注入的 `exec` 假执行器，
 *     这样测试在没装 whisper 的机器上也能跑，且不会为了断言去跑几百 MB 的模型。
 *  2. 流水线测试用**真数据库**（`:memory:` + 真迁移），验证
 *     `media` → `media_transcripts` 的整条链路真的落库，而不是断言一个 mock 被调过。
 *
 * 真机链路（真的 amr → ffmpeg → whisper large-v3-turbo → 中文文本）另有独立证据，
 * 见最终报告；这里覆盖的是代码路径与边界。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  DEFAULT_TRANSCRIBE_LIMIT,
  MAX_TRANSCRIBE_LIMIT,
  WhisperCliTranscriber,
  isEnglishOnlyModel,
  normalizeTranscript,
  transcribePending,
  type ExecFn,
  type SttLikeConfig,
} from '../packages/stt/src/index.ts';
import { openDatabase, type Db } from '../packages/db/src/index.ts';
import { createLogger } from '../packages/core/src/index.ts';

const MODEL = '/opt/models/ggml-large-v3-turbo.bin';
const logger = createLogger({ level: 'error', console: false }).child('stt-test');
const BINARY = 'whisper-cli';

/* ------------------------------------------------------------------ */
/* 假执行器                                                            */
/* ------------------------------------------------------------------ */

interface ExecCall {
  cmd: string;
  args: string[];
}

interface FakeExec {
  exec: ExecFn;
  calls: ExecCall[];
  /** 最后一次 ffmpeg `-i` 的输入路径（即被转写的原音频）。 */
  lastInput: () => string;
  /** whisper 的 `-of` 输出前缀（测试据此伪造 `${outBase}.txt`）。 */
  outBase: () => string;
}

/**
 * 假执行器：默认成功；`onCall` 可以按 (cmd, args) 返回退出码或抛错（模拟 spawn 失败）。
 * 同时记录调用，供断言真实参数。
 */
function fakeExec(
  onCall?: (cmd: string, args: string[]) => { code?: number; stdout?: string; stderr?: string } | 'throw' | undefined,
): FakeExec {
  const calls: ExecCall[] = [];
  let lastInput = '';
  let outBase = '';
  const exec: ExecFn = async (cmd, args) => {
    calls.push({ cmd, args });
    const of = args.indexOf('-of');
    if (of >= 0) outBase = args[of + 1] ?? '';
    const i = args.indexOf('-i');
    if (i >= 0) lastInput = args[i + 1] ?? '';
    const r = onCall?.(cmd, args);
    if (r === 'throw') throw new Error(`spawn ${cmd} ENOENT`);
    return { code: r?.code ?? 0, stdout: r?.stdout ?? '', stderr: r?.stderr ?? '' };
  };
  return { exec, calls, lastInput: () => lastInput, outBase: () => outBase };
}

/** 记录真实创建过的临时目录，测试结束时清理。 */
const tmpRoots: string[] = [];
function makeTmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'qq-archive-stt-test-'));
  tmpRoots.push(d);
  return d;
}
process.on('exit', () => {
  for (const d of tmpRoots) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* 清理失败无所谓 */
    }
  }
});

/** 取「真正转码/转写」那两次调用（跳过 probe 的 `-version` / `--help`）。 */
function transcodeCalls(calls: ExecCall[]): { ffmpeg: ExecCall | undefined; whisper: ExecCall | undefined } {
  return {
    ffmpeg: calls.find((c) => c.cmd === 'ffmpeg' && c.args.includes('-i')),
    whisper: calls.find((c) => c.cmd === BINARY && c.args.includes('-m')),
  };
}

/* ------------------------------------------------------------------ */
/* normalizeTranscript / isEnglishOnlyModel                            */
/* ------------------------------------------------------------------ */

test('stt: normalizeTranscript 去掉时间戳前缀、合并空白、丢弃非语音占位', () => {
  const r = normalizeTranscript(
    '[00:00:00.000 --> 00:00:02.000]  你好\n[00:00:02.000 --> 00:00:04.000]   世界  \n',
  );
  assert.equal(r.text, '你好\n世界');
  assert.equal(r.segments, 2);
});

test('stt: normalizeTranscript 把静音/音乐占位当作空文本，但仍算出 0 段', () => {
  assert.deepEqual(normalizeTranscript('[BLANK_AUDIO]\n(music)\n[ Silence ]\n'), { text: '', segments: 0 });
  assert.deepEqual(normalizeTranscript(''), { text: '', segments: 0 });
  assert.deepEqual(normalizeTranscript('   \n\t\n'), { text: '', segments: 0 });
});

test('stt: normalizeTranscript 合并行内连续空白但保留换行', () => {
  const r = normalizeTranscript('你好\u00a0\u00a0  世界\n\n第二行\t\t内容\n');
  assert.equal(r.text, '你好 世界\n第二行 内容');
  assert.equal(r.segments, 2);
});

test('stt: normalizeTranscript 不误杀看起来像占位但其实是内容的中文行', () => {
  const r = normalizeTranscript('[音乐]很好听\n');
  assert.equal(r.text, '[音乐]很好听');
  assert.equal(r.segments, 1);
});

test('stt: isEnglishOnlyModel 认出 *.en.bin 与 -en. 形式，中英混排模型不误判', () => {
  assert.equal(isEnglishOnlyModel('/x/ggml-small.en.bin'), true);
  assert.equal(isEnglishOnlyModel('/x/for-tests-ggml-tiny.en.bin'), true);
  assert.equal(isEnglishOnlyModel('/x/ggml-base-en-ggml.bin'), true);
  assert.equal(isEnglishOnlyModel('/x/ggml-large-v3-turbo.bin'), false);
  assert.equal(isEnglishOnlyModel('/x/ggml-large-v3.bin'), false);
});

/* ------------------------------------------------------------------ */
/* probe                                                               */
/* ------------------------------------------------------------------ */

test('stt: probe 在没配置模型时直接判不可用，且不 spawn 任何进程', async () => {
  const f = fakeExec();
  const t = new WhisperCliTranscriber({}, { exec: f.exec, tmpDir: makeTmpRoot() });
  const a = await t.probe();
  assert.equal(a.available, false);
  assert.match(a.reason, /未配置 stt\.model/);
  assert.equal(a.engine, 'whisper-cli');
  assert.equal(f.calls.length, 0, '没模型就不该去 spawn');
});

test('stt: probe 在模型文件不存在时报出确切路径', async () => {
  const f = fakeExec();
  const t = new WhisperCliTranscriber(
    { model: '/nope/ggml-x.bin' },
    { exec: f.exec, tmpDir: makeTmpRoot(), fileExists: () => false },
  );
  const a = await t.probe();
  assert.equal(a.available, false);
  assert.match(a.reason, /模型文件不存在：\/nope\/ggml-x\.bin/);
  assert.equal(f.calls.length, 0);
});

test('stt: probe 在 ffmpeg 不可用 / whisper-cli 不可用时分别报出原因', async () => {
  const ff = fakeExec((cmd) => (cmd === 'ffmpeg' ? 'throw' : {}));
  const t1 = new WhisperCliTranscriber(
    { model: MODEL },
    { exec: ff.exec, tmpDir: makeTmpRoot(), fileExists: (p) => p === MODEL },
  );
  const a1 = await t1.probe();
  assert.equal(a1.available, false);
  assert.match(a1.reason, /ffmpeg 不可用（ffmpeg）/);

  const wh = fakeExec((cmd) => (cmd === BINARY ? 'throw' : {}));
  const t2 = new WhisperCliTranscriber(
    { model: MODEL },
    { exec: wh.exec, tmpDir: makeTmpRoot(), fileExists: (p) => p === MODEL },
  );
  const a2 = await t2.probe();
  assert.equal(a2.available, false);
  assert.match(a2.reason, /whisper-cli 不可用（whisper-cli）/);
});

test('stt: probe 对英文专用模型给出警告但仍判可用', async () => {
  const f = fakeExec();
  const t = new WhisperCliTranscriber(
    { model: '/opt/models/ggml-small.en.bin' },
    { exec: f.exec, tmpDir: makeTmpRoot(), fileExists: () => true },
  );
  const a = await t.probe();
  assert.equal(a.available, true);
  assert.equal(a.warnings.length, 1);
  assert.match(a.warnings[0]!, /英文专用版/);
});

test('stt: probe 结果被缓存，第二次不再 spawn（force 可强制重探）', async () => {
  const f = fakeExec();
  const t = new WhisperCliTranscriber(
    { model: MODEL },
    { exec: f.exec, tmpDir: makeTmpRoot(), fileExists: (p) => p === MODEL },
  );
  await t.probe();
  const afterFirst = f.calls.length;
  assert.equal(afterFirst, 2, '第一次探测应跑 ffmpeg -version 与 whisper-cli --help');
  await t.probe();
  assert.equal(f.calls.length, afterFirst, '第二次必须走缓存');
  await t.probe(true);
  assert.equal(f.calls.length, afterFirst + 2, 'force 应重新探测');
});

/* ------------------------------------------------------------------ */
/* transcribe                                                          */
/* ------------------------------------------------------------------ */

test('stt: transcribe 用真实参数调用 ffmpeg/whisper，并从 .txt 读回结果', async () => {
  const f = fakeExec();
  const t = new WhisperCliTranscriber(
    { model: MODEL, language: 'zh', threads: 4 },
    {
      exec: f.exec,
      tmpDir: makeTmpRoot(),
      fileExists: (p) => p === MODEL || p === `${f.outBase()}.txt`,
      readText: () => '  大家好，这是一段中文语音。  \n',
    },
  );
  const r = await t.transcribe({ path: '/media/9a/voice.amr', durationSec: 12 });

  assert.equal(r.text, '大家好，这是一段中文语音。');
  assert.equal(r.segments, 1);
  assert.equal(r.engine, 'whisper-cli');
  assert.equal(r.model, MODEL);
  assert.equal(r.language, 'zh');
  assert.ok(r.elapsedMs >= 0);

  const { ffmpeg, whisper } = transcodeCalls(f.calls);
  assert.ok(ffmpeg, '必须调用 ffmpeg 转码');
  assert.equal(ffmpeg!.args[ffmpeg!.args.indexOf('-i') + 1], '/media/9a/voice.amr');
  assert.equal(ffmpeg!.args[ffmpeg!.args.indexOf('-ar') + 1], '16000');
  assert.equal(ffmpeg!.args[ffmpeg!.args.indexOf('-ac') + 1], '1');
  assert.equal(ffmpeg!.args[ffmpeg!.args.indexOf('-c:a') + 1], 'pcm_s16le');

  assert.ok(whisper, '必须调用 whisper-cli');
  assert.equal(whisper!.args[whisper!.args.indexOf('-m') + 1], MODEL);
  assert.equal(whisper!.args[whisper!.args.indexOf('-l') + 1], 'zh');
  assert.ok(whisper!.args.includes('-otxt'));
  assert.ok(whisper!.args.includes('-nt'), '必须带 -nt，否则文本会混进时间戳');
  assert.equal(whisper!.args[whisper!.args.indexOf('-t') + 1], '4');
  assert.ok(!whisper!.args.includes('--vad'), '没配 VAD 模型时不应传 --vad');
});

test('stt: transcribe 按请求覆盖语言，并在配置了 VAD 时传 --vad/-vm', async () => {
  const f = fakeExec();
  const t = new WhisperCliTranscriber(
    { model: MODEL, language: 'zh', vadModel: '/opt/models/ggml-silero-v5.1.2.bin' },
    {
      exec: f.exec,
      tmpDir: makeTmpRoot(),
      fileExists: (p) => p === MODEL || p === `${f.outBase()}.txt`,
      readText: () => 'hello\n',
    },
  );
  const r = await t.transcribe({ path: '/media/a.amr', language: 'en' });
  assert.equal(r.language, 'en');
  const { whisper } = transcodeCalls(f.calls);
  assert.equal(whisper!.args[whisper!.args.indexOf('-l') + 1], 'en');
  assert.ok(whisper!.args.includes('--vad'));
  assert.equal(whisper!.args[whisper!.args.indexOf('-vm') + 1], '/opt/models/ggml-silero-v5.1.2.bin');
});

test('stt: transcribe 在音频超长时直接拒绝，不启动任何转码进程', async () => {
  const f = fakeExec();
  const t = new WhisperCliTranscriber(
    { model: MODEL, maxDurationSec: 30 },
    { exec: f.exec, tmpDir: makeTmpRoot(), fileExists: () => true },
  );
  await assert.rejects(() => t.transcribe({ path: '/media/long.amr', durationSec: 600 }), /超过 stt\.maxDurationSec=30s/);
  const { ffmpeg, whisper } = transcodeCalls(f.calls);
  assert.equal(ffmpeg, undefined, '超长音频不该进入 ffmpeg');
  assert.equal(whisper, undefined);
});

test('stt: transcribe 在不可用时抛出带原因的错误', async () => {
  const f = fakeExec();
  const t = new WhisperCliTranscriber({}, { exec: f.exec, tmpDir: makeTmpRoot() });
  await assert.rejects(() => t.transcribe({ path: '/media/a.amr' }), /语音转写不可用：未配置 stt\.model/);
});

test('stt: transcribe 在 ffmpeg / whisper 退出码非 0 时抛出可读错误（含 stderr 末尾）', async () => {
  const ffBad = fakeExec((cmd, args) =>
    cmd === 'ffmpeg' && args.includes('-i') ? { code: 1, stderr: 'Invalid data found when processing input' } : {},
  );
  const t1 = new WhisperCliTranscriber(
    { model: MODEL },
    { exec: ffBad.exec, tmpDir: makeTmpRoot(), fileExists: (p) => p === MODEL },
  );
  await assert.rejects(() => t1.transcribe({ path: '/media/bad.amr' }), /ffmpeg 转码失败（退出码 1）：Invalid data found/);

  const whBad = fakeExec((cmd, args) =>
    cmd === BINARY && args.includes('-m') ? { code: 2, stderr: 'failed to load model' } : {},
  );
  const t2 = new WhisperCliTranscriber(
    { model: MODEL },
    {
      exec: whBad.exec,
      tmpDir: makeTmpRoot(),
      fileExists: (p) => p === MODEL,
    },
  );
  await assert.rejects(() => t2.transcribe({ path: '/media/bad.amr' }), /whisper-cli 转写失败（退出码 2）：failed to load model/);
});

test('stt: transcribe 在 -otxt 文件缺失时回落到 stdout —— 并识别静音为空文本', async () => {
  const f = fakeExec((cmd, args) =>
    cmd === BINARY && args.includes('-m') ? { code: 0, stdout: '来自标准输出的一句话\n' } : {},
  );
  const t = new WhisperCliTranscriber(
    { model: MODEL },
    { exec: f.exec, tmpDir: makeTmpRoot(), fileExists: (p) => p === MODEL },
  );
  const r = await t.transcribe({ path: '/media/a.amr' });
  assert.equal(r.text, '来自标准输出的一句话');
  assert.equal(r.segments, 1);

  const silent = fakeExec((cmd, args) =>
    cmd === BINARY && args.includes('-m') ? { code: 0, stdout: '[BLANK_AUDIO]\n' } : {},
  );
  const t2 = new WhisperCliTranscriber(
    { model: MODEL },
    { exec: silent.exec, tmpDir: makeTmpRoot(), fileExists: (p) => p === MODEL },
  );
  const r2 = await t2.transcribe({ path: '/media/silent.amr' });
  assert.equal(r2.text, '');
  assert.equal(r2.segments, 0);
});

/* ------------------------------------------------------------------ */
/* transcribePending（真数据库）                                        */
/* ------------------------------------------------------------------ */

interface PipelineEnv {
  db: Db;
  mediaDir: string;
  f: FakeExec;
  transcriber: WhisperCliTranscriber;
  /** 删掉某个媒体文件，用来模拟「行还在库里但文件已丢」。 */
  remove: (relPath: string) => void;
  close: () => void;
}

/**
 * 搭一个真库 + 真 transcriber（假 exec）的环境。
 *
 * 媒体文件是**真的写到磁盘上**的 —— 这样 `transcribePending` 走的是生产默认的
 * `existsSync`，而不是被注入的桩函数；`create: false` 用来造「库里有行、盘上没文件」。
 */
function pipelineEnv(
  media: Array<{
    sha: string;
    kind: 'audio' | 'image' | 'video';
    relPath: string;
    duration?: number | null;
    status?: 'present' | 'missing';
    create?: boolean;
  }>,
  onExec?: (cmd: string, args: string[]) => { code?: number; stdout?: string; stderr?: string } | 'throw' | undefined,
  over: Partial<SttLikeConfig> = {},
): PipelineEnv {
  const db = openDatabase({ path: ':memory:', logger });
  const mediaDir = makeTmpRoot();

  for (const m of media) {
    db.upsertMedia({
      sha256: m.sha.repeat(64).slice(0, 64),
      kind: m.kind,
      size: 4096,
      relPath: m.relPath,
      ext: '.amr',
      duration: m.duration ?? 8,
      status: m.status ?? 'present',
    });
    if (m.create !== false && m.status !== 'missing') {
      const abs = join(mediaDir, m.relPath);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, Buffer.from('fake-amr-bytes'));
    }
  }

  const f = fakeExec(onExec);
  const transcriber = new WhisperCliTranscriber(
    { model: MODEL, language: 'zh', threads: 4, ...over },
    {
      exec: f.exec,
      tmpDir: makeTmpRoot(),
      // 只伪造「模型存在」与「whisper 写了 .txt」这两件与引擎有关的事；
      // 媒体文件存在性走生产默认的 existsSync。
      fileExists: (p: string) => p === MODEL || p.endsWith('.txt'),
      readText: () =>
        f.lastInput().endsWith('silent.amr') ? '[BLANK_AUDIO]\n' : '这是一段中文语音转写。\n',
    },
  );
  return {
    db,
    mediaDir,
    f,
    transcriber,
    remove: (relPath: string) => rmSync(join(mediaDir, relPath), { force: true }),
    close: () => db.close(),
  };
}

test('stt pipeline: 真库端到端 —— 待转写音频被转写并写入 media_transcripts，缺失文件被跳过', async () => {
  const env = pipelineEnv([
    { sha: 'a', kind: 'audio', relPath: 'audio/present.amr' },
    { sha: 'b', kind: 'audio', relPath: 'audio/missing.amr', create: false },
    { sha: 'c', kind: 'image', relPath: 'image/pic.jpg' },
    { sha: 'd', kind: 'audio', relPath: 'audio/already-missing.amr', status: 'missing' },
  ]);
  try {
    const stats = await transcribePending(env.transcriber, env.db, {
      mediaDir: env.mediaDir,
      limit: 10,
      logger,
    });
    assert.equal(stats.candidates, 2, '只该拿到 present 的 audio（image 与 status=missing 被 SQL 过滤）');
    assert.equal(stats.transcribed, 1);
    assert.equal(stats.skipped, 1, '文件不在盘上 → skipped，且不写库');
    assert.equal(stats.failed, 0);

    const rows = env.db.listUntranscribedAudio(10);
    assert.equal(rows.length, 1, '缺失文件必须留在待转写队列里，等文件恢复后重试');
    assert.equal(rows[0]!.relPath, 'audio/missing.amr');

    assert.equal(env.db.listUntranscribedAudio(10).length, 1, '只有缺失文件仍在待办队列');
    const t = env.db.getTranscript(1);
    assert.ok(t, '转写结果必须真的落库');
    assert.equal(t!.text, '这是一段中文语音转写。');
    assert.equal(t!.engine, 'whisper-cli');
    assert.equal(t!.model, MODEL);
    assert.equal(t!.language, 'zh');
    assert.ok(t!.elapsedMs !== null);
    assert.deepEqual(env.db.transcriptStats().total, 1);
  } finally {
    env.close();
  }
});

test('stt pipeline: 静音转出空文本也会落库（避免每次重跑 whisper）', async () => {
  const env = pipelineEnv([{ sha: 'a', kind: 'audio', relPath: 'audio/silent.amr' }]);
  try {
    const stats = await transcribePending(env.transcriber, env.db, { mediaDir: env.mediaDir, limit: 5, logger });
    assert.equal(stats.candidates, 1);
    assert.equal(stats.empty, 1);
    assert.equal(stats.transcribed, 0);
    const t = env.db.getTranscript(1);
    assert.ok(t, '空文本也必须落一行');
    assert.equal(t!.text, '');
    assert.equal(env.db.listUntranscribedAudio(5).length, 0, '空结果不应留在待办队列');
    // 第二轮应无候选，且不产生重复行
    const second = await transcribePending(env.transcriber, env.db, { mediaDir: env.mediaDir, limit: 5, logger });
    assert.equal(second.candidates, 0);
    assert.equal(env.db.transcriptStats().total, 1);
  } finally {
    env.close();
  }
});

test('stt pipeline: 路径越界（../）的媒体行被跳过，绝不读媒体根以外的文件', async () => {
  // create: false —— 这个 relPath 解析后落在媒体根之外，绝不能让测试去写它
  const env = pipelineEnv([{ sha: 'a', kind: 'audio', relPath: '../../etc/passwd', create: false }]);
  const warns: string[] = [];
  try {
    const stats = await transcribePending(env.transcriber, env.db, {
      mediaDir: env.mediaDir,
      limit: 5,
      logger: { warn: (m) => warns.push(String(m)) },
    });
    assert.equal(stats.skipped, 1);
    assert.equal(stats.transcribed, 0);
    assert.equal(env.db.transcriptStats().total, 0, '越界文件绝不能产生转写行');
    const { ffmpeg } = transcodeCalls(env.f.calls);
    assert.equal(ffmpeg, undefined, '越界路径不该进 ffmpeg');
    assert.ok(warns.some((w) => w.includes('路径越界')));
  } finally {
    env.close();
  }
});

test('stt pipeline: 单条失败不影响其它条目，错误进 errors 且失败条目不落库', async () => {
  // 让 bad.amr 的 whisper 调用失败：ffmpeg 的 -i 参数记录了当前处理的是哪一条，
  // 闭包把它记下来，等 whisper 那次调用时判断。
  let current = '';
  const env = pipelineEnv(
    [
      { sha: 'a', kind: 'audio', relPath: 'audio/good.amr' },
      { sha: 'b', kind: 'audio', relPath: 'audio/bad.amr' },
      { sha: 'c', kind: 'audio', relPath: 'audio/after.amr' },
    ],
    (cmd, args) => {
      const i = args.indexOf('-i');
      if (i >= 0) current = args[i + 1] ?? '';
      if (cmd === BINARY && args.includes('-m') && current.endsWith('bad.amr')) {
        return { code: 1, stdout: '', stderr: 'CUDA out of memory' };
      }
      return undefined;
    },
  );
  try {
    const stats = await transcribePending(env.transcriber, env.db, { mediaDir: env.mediaDir, limit: 10, logger });
    assert.equal(stats.candidates, 3);
    assert.equal(stats.transcribed, 2, '失败的那条不能阻止后面的条目');
    assert.equal(stats.failed, 1);
    assert.equal(stats.errors.length, 1);
    assert.match(stats.errors[0]!.error, /whisper-cli 转写失败（退出码 1）/);
    assert.equal(env.db.transcriptStats().total, 2);
    // 失败的那一行仍留在待办队列
    const pending = env.db.listUntranscribedAudio(10);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.relPath, 'audio/bad.amr');
  } finally {
    env.close();
  }
});

test('stt pipeline: continueOnError=false 时首条失败即停', async () => {
  let current = '';
  const env = pipelineEnv(
    [
      { sha: 'a', kind: 'audio', relPath: 'audio/bad.amr' },
      { sha: 'b', kind: 'audio', relPath: 'audio/good.amr' },
    ],
    (cmd, args) => {
      const i = args.indexOf('-i');
      if (i >= 0) current = args[i + 1] ?? '';
      if (cmd === BINARY && args.includes('-m') && current.endsWith('bad.amr')) {
        return { code: 1, stdout: '', stderr: 'boom' };
      }
      return undefined;
    },
  );
  try {
    const stats = await transcribePending(env.transcriber, env.db, {
      mediaDir: env.mediaDir,
      limit: 10,
      continueOnError: false,
      logger,
    });
    assert.equal(stats.failed, 1);
    assert.equal(stats.transcribed, 0, '首条失败后不应继续处理第二条');
    assert.equal(env.db.transcriptStats().total, 0);
  } finally {
    env.close();
  }
});

test('stt pipeline: limit 生效并被钳制在合法区间', async () => {
  const env = pipelineEnv([
    { sha: 'a', kind: 'audio', relPath: 'audio/1.amr' },
    { sha: 'b', kind: 'audio', relPath: 'audio/2.amr' },
    { sha: 'c', kind: 'audio', relPath: 'audio/3.amr' },
  ]);
  try {
    const one = await transcribePending(env.transcriber, env.db, { mediaDir: env.mediaDir, limit: 1, logger });
    assert.equal(one.candidates, 1);
    assert.equal(one.transcribed, 1);

    const rest = await transcribePending(env.transcriber, env.db, { mediaDir: env.mediaDir, limit: 10, logger });
    assert.equal(rest.candidates, 2);

    // limit=0/负数 → 至少 1；超大 → 不超过 MAX
    const clampLow = await transcribePending(env.transcriber, env.db, { mediaDir: env.mediaDir, limit: 0, logger });
    assert.equal(clampLow.candidates, 0, '三条都已转写，所以候选为 0');

    assert.equal(DEFAULT_TRANSCRIBE_LIMIT, 50);
    assert.ok(MAX_TRANSCRIBE_LIMIT >= DEFAULT_TRANSCRIBE_LIMIT);
    assert.equal(env.db.transcriptStats().total, 3);
  } finally {
    env.close();
  }
});

test('stt pipeline: onProgress 逐条回调，状态与最终统计一致', async () => {
  const env = pipelineEnv([
    { sha: 'a', kind: 'audio', relPath: 'audio/good.amr' },
    { sha: 'b', kind: 'audio', relPath: 'audio/silent.amr' },
  ]);
  env.remove('audio/good.amr');
  const seen: Array<{ index: number; total: number; status: string }> = [];
  try {
    await transcribePending(env.transcriber, env.db, {
      mediaDir: env.mediaDir,
      limit: 5,
      logger,
      onProgress: (ev) => seen.push({ index: ev.index, total: ev.total, status: ev.status }),
    });
    assert.equal(seen.length, 2);
    assert.deepEqual(
      seen.map((s) => s.status),
      ['skipped', 'empty'],
    );
    assert.deepEqual(
      seen.map((s) => s.index),
      [1, 2],
    );
    assert.ok(seen.every((s) => s.total === 2));
  } finally {
    env.close();
  }
});

/* ------------------------------------------------------------------ */
/* Db 层（转写的持久化契约）                                            */
/* ------------------------------------------------------------------ */

test('stt db: upsertTranscript 幂等覆盖、getTranscripts 批量取、deleteTranscript 与统计一致', () => {
  const db = openDatabase({ path: ':memory:', logger });
  try {
    const a = db.upsertMedia({ sha256: 'a'.repeat(64), kind: 'audio', size: 10, relPath: 'audio/a.amr' });
    const b = db.upsertMedia({ sha256: 'b'.repeat(64), kind: 'audio', size: 10, relPath: 'audio/b.amr' });
    const img = db.upsertMedia({ sha256: 'c'.repeat(64), kind: 'image', size: 10, relPath: 'image/c.jpg' });

    assert.equal(db.getTranscript(a.id), null);
    db.upsertTranscript({ mediaId: a.id, text: '第一版', engine: 'whisper-cli', model: MODEL, language: 'zh', segments: 1, elapsedMs: 100 });
    db.upsertTranscript({ mediaId: a.id, text: '第二版（覆盖）', engine: 'whisper-cli', model: MODEL, language: 'zh', segments: 2, elapsedMs: 200 });
    const got = db.getTranscript(a.id);
    assert.equal(got!.text, '第二版（覆盖）');
    assert.equal(got!.segments, 2);
    assert.equal(got!.elapsedMs, 200);
    assert.equal(db.transcriptStats().total, 1, '同一 media 不能产生两行');

    db.upsertTranscript({ mediaId: img.id, text: '', engine: 'whisper-cli', model: MODEL });
    const batch = db.getTranscripts([a.id, b.id, img.id]);
    assert.equal(batch.size, 2);
    assert.equal(batch.get(a.id)!.text, '第二版（覆盖）');
    assert.equal(batch.get(img.id)!.text, '');
    assert.equal(batch.get(b.id), undefined);

    // listUntranscribedAudio 只认 audio 且排除已有转写的
    const pending = db.listUntranscribedAudio(10);
    assert.deepEqual(
      pending.map((p) => p.relPath),
      ['audio/b.amr'],
    );

    // listMedia 带上转写文本，并且 keyword 能搜到语音内容
    const hit = db.listMedia({ keyword: '覆盖' });
    assert.equal(hit.items.length, 1);
    assert.equal(hit.items[0]!.id, a.id);
    assert.equal(hit.items[0]!.transcript, '第二版（覆盖）');
    const byTranscribed = db.listMedia({ transcribed: false });
    assert.deepEqual(
      byTranscribed.items.map((i) => i.relPath),
      ['audio/b.amr'],
    );
    const emptyTranscript = db.listMedia({ transcribed: true });
    assert.equal(emptyTranscript.items.length, 2, '空文本也算已转写');

    const stats = db.transcriptStats();
    assert.equal(stats.total, 2);
    assert.equal(stats.chars, '第二版（覆盖）'.length);
    // node:sqlite 返回的是 null-prototype 对象，deepEqual 比字面量会失败 → 逐字段断言
    assert.equal(stats.engines.length, 1);
    assert.equal(stats.engines[0]!.engine, 'whisper-cli');
    assert.equal(stats.engines[0]!.count, 2);

    assert.equal(db.deleteTranscript(a.id), 1);
    assert.equal(db.deleteTranscript(a.id), 0);
    assert.equal(db.transcriptStats().total, 1);
    // 删掉转写后 a 必须回到待办队列（b 本来就在），image 行永远不进来
    assert.deepEqual(
      db
        .listUntranscribedAudio(10)
        .map((p) => p.relPath)
        .sort(),
      ['audio/a.amr', 'audio/b.amr'],
    );
  } finally {
    db.close();
  }
});

test('stt db: 删除 media 行时级联删除转写（ON DELETE CASCADE）', () => {
  const db = openDatabase({ path: ':memory:', logger });
  try {
    const m = db.upsertMedia({ sha256: 'd'.repeat(64), kind: 'audio', size: 10, relPath: 'audio/d.amr' });
    db.upsertTranscript({ mediaId: m.id, text: '待删', engine: 'whisper-cli' });
    assert.equal(db.transcriptStats().total, 1);
    db.raw.prepare('DELETE FROM media WHERE id = ?').run(m.id);
    assert.equal(db.transcriptStats().total, 0, '外键级联必须生效');
  } finally {
    db.close();
  }
});
