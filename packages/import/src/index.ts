/**
 * `@qqarchive/import` 的门面（对应 docs/ARCHITECTURE.md 第 4 节）。
 *
 * 契约：
 *   detectFormat(filePath, head?) → 'qce-json' | 'qce-jsonl' | 'qce-txt' | 'generic-jsonl' | 'unknown'
 *   importFile(ctx)               → ImportStats（只解析，不碰数据库）
 *   runImport(opts)               → ImportStats（解析 + 写消息 + 写媒体 + 建关联）
 *   listImporters()               → [{ name, formats }]
 *   MediaArchiver                 → 内容寻址媒体归档
 *
 * CLI 与 server 都应该走 `runImport()`（它把 message_media 回填那段接线封在包里），
 * 只有需要自定义写库策略时才直接用 `importFile()`。
 */
export { detectFormat, detectFormatFromText, readFileHead, DEFAULT_HEAD_BYTES } from './detect.ts';
export type { DetectOptions } from './detect.ts';

export { importFile, resolveImportFormat, runImport } from './run.ts';
export type { RunImportOptions } from './run.ts';

export {
  DEFAULT_DOWNLOAD_TIMEOUT_MS,
  DEFAULT_FFMPEG,
  DEFAULT_MAX_MEDIA_BYTES,
  MediaArchiver,
} from './media.ts';
export type {
  ArchiveCandidate,
  ArchiveOutcome,
  FetchLike,
  HttpResponseLike,
  MediaArchiverOptions,
} from './media.ts';

export { IMPORTERS, importerForFormat, listImporters } from './importers/index.ts';
export { GenericJsonlImporter } from './importers/generic-jsonl.ts';
export { QceJsonImporter } from './importers/qce-json.ts';
export { QceJsonlImporter } from './importers/qce-jsonl.ts';
export { QceTxtImporter } from './importers/qce-txt.ts';

export {
  DEFAULT_BATCH_SIZE,
  DETECTED_FORMATS,
  ImportAbortedError,
  ImportRun,
  MAX_IMPORT_ERRORS,
  MAX_MESSAGE_BYTES,
  addImportError,
  createImportStats,
  readBatchOutcome,
  sessionFromHint,
} from './importer.ts';
export type {
  ImportBatchOutcome,
  ImportContext,
  ImportProgress,
  ImportStats,
  Importer,
  MediaResolver,
  ResolvedMediaSource,
  SessionHint,
} from './importer.ts';

export {
  applyChatInfo,
  asArray,
  asBool,
  asNumber,
  asRecord,
  asString,
  collectExtra,
  defaultSession,
  elementsFromContent,
  extractForwardId,
  extractReply,
  inferMessageType,
  mapChatType,
  mapQceMessage,
  MAX_RAW_CHARS,
  mentionsFromContent,
  resolveTs,
  resourceExt,
  resourceKinds,
  resourcesFromContent,
  sessionFromChatInfo,
} from './qce-map.ts';
export type { MapMessageContext } from './qce-map.ts';
export { looksNormalizedLike, mapNormalizedLike } from './normalized-map.ts';
export {
  DEFAULT_EXT_BY_KIND,
  extFromUrl,
  extOfName,
  filenameFromUrl,
  isArchivableKind,
  kindFromType,
  mediaRelPath,
  mimeForExt,
  MIME_BY_EXT,
  normalizeExt,
  normalizeFilename,
} from './media-util.ts';
export { looksLikeChatTxt, parseTxtLine, parseTxtTime } from './txt-parse.ts';
export type { ParsedTxtHeader, ParsedTxtLine, ParsedTxtMessage } from './txt-parse.ts';
