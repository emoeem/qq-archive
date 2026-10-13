/**
 * 语音转文字（STT）包。
 *
 * 目前只有一个引擎：whisper.cpp 的官方 CLI（`whisper-cli`）。
 * 详见 `./whisper.ts` 顶部注释里的真实边界说明。
 */
export * from './whisper.ts';
export * from './pipeline.ts';
