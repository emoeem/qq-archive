/**
 * qce-txt 导入器：纯文本聊天记录（尽力而为，绝不静默丢行）。
 *
 * 至少支持两种真实写法：
 *
 *  A. 单行式（第三方工具常见）
 *       [2024-01-02 03:04:05] 张三(123456): 你好
 *       2024/01/02 03:04 李四<654321>：在的
 *
 *  B. 块式（qq-chat-exporter 的 txt 导出）
 *       聊天名称: 某某群
 *       聊天类型: 群聊
 *       参与人数: 42
 *       ================================
 *       [1]
 *       张三:
 *       时间: 2024-01-02 03:04:05
 *       类型: type_1
 *       内容: 你好（过长内容会被换行，续行带缩进）
 *       资源: 1 个文件
 *         - image: a.jpg
 *       提及: 李四
 *       回复: 2024-01-02 03:04:00 李四 - 在的
 *
 * 块式与单行式的判别靠「是否顶格」：QCE 的字段标签顶格，被折行的正文带缩进。
 *
 * txt 天然丢信息（没有 uid / 没有资源直链），所以：
 *  - 没有时间戳的消息按 `failed` 记录（连同原文片段），不伪造时间；
 *  - 资源只有文件名时按 `missing` 处理（由 MediaArchiver 记录 fail_reason），不生成占位文件；
 *  - 认不出的行进 errors，不静默丢。
 */
import type {
  MediaKind,
  MessageElement,
  NormalizedMessage,
  ResourceRef,
} from '../../../core/src/index.ts';
import { messageKeyOf } from '../../../core/src/index.ts';
import type {
  ImportContext,
  ImportStats,
  Importer,
  DetectedFormat,
  SessionHint,
} from '../importer.ts';
import { ImportRun, sessionFromHint } from '../importer.ts';
import { fileLineStream } from '../json-stream.ts';
import { inferMessageType } from '../qce-map.ts';
import { kindFromType } from '../media-util.ts';
import { parseTxtLine, parseTxtTime } from '../txt-parse.ts';
import type { ParsedTxtLine, ParsedTxtMessage } from '../txt-parse.ts';
import { preview } from './generic-jsonl.ts';

/** 只作为会话/统计信息的标签，不产出消息。 */
const HEADER_LABELS = new Set([
  '聊天名称',
  '聊天类型',
  '参与人数',
  '导出时间',
  '消息总数',
  '时间范围',
  '导出人',
  '导入时间',
  '群名称',
  '群号',
  '账号',
]);

/** 块式导出里的字段标签。 */
const FIELD_LABELS = new Set(['时间', '时间戳', '内容', '消息', '类型', '资源', '提及', '回复']);

/** 出现在「发送者」位置时必然是标签而不是昵称的词。 */
const RESERVED_SENDER_NAMES = new Set([
  ...HEADER_LABELS,
  ...FIELD_LABELS,
  '昵称',
  '发送者',
  '姓名',
  'QQ号',
  '文件',
  '合并转发',
]);

const RE_LABEL = /^([^:：]{1,16})\s*[:：]\s*([\s\S]*)$/;
const RE_INDEX = /^\[(\d{1,12})\]\s*$/;
const RE_BANNER = /^[=\-_*~#]{3,}$/;
const RE_FOOTER = /^(导出完成|导出结束|总计导出|全文完|End of|--+\s*END)/i;
const RE_RESOURCE_ITEM = /^\s*[-•*]\s*([^\s:：]{1,16})\s*[:：]\s*(.+?)\s*$/;

/** 内容里的整条占位标记（QCE txt 对无文本消息的写法）。 */
const CONTENT_MARKERS: Array<{
  re: RegExp;
  kind?: MediaKind;
  system?: boolean;
  face?: boolean;
}> = [
  { re: /^\[图片(消息)?\]$/, kind: 'image' },
  { re: /^\[视频(消息)?\]$/, kind: 'video' },
  { re: /^\[(语音|音频)(消息)?\]$/, kind: 'audio' },
  { re: /^\[文件(消息)?\]$/, kind: 'file' },
  { re: /^\[(表情|动画表情|贴纸)(消息)?\]$/, face: true },
  { re: /^\[系统消息\]$/, system: true },
  { re: /^\[(无文本内容|空消息|其他消息)\]$/ },
];

export interface TxtContentMarker {
  kind?: MediaKind;
  system?: boolean;
  face?: boolean;
  cleanText: string;
}

/** 识别 `[图片消息]` 之类的占位标记；普通文本原样返回。 */
export function parseTxtContentMarker(text: string): TxtContentMarker {
  const trimmed = text.trim();
  for (const marker of CONTENT_MARKERS) {
    if (!marker.re.test(trimmed)) continue;
    const out: TxtContentMarker = { cleanText: '' };
    if (marker.kind !== undefined) out.kind = marker.kind;
    if (marker.system !== undefined) out.system = marker.system;
    if (marker.face !== undefined) out.face = marker.face;
    return out;
  }
  return { cleanText: text };
}

/** 从中文/英文类型词推断资源种类。 */
export function kindFromTxtWord(word: string): MediaKind {
  const w = word.trim().toLowerCase();
  if (w.includes('图片') || w.includes('图像') || w.includes('表情')) return 'image';
  if (w.includes('视频') || w.includes('短片')) return 'video';
  if (w.includes('语音') || w.includes('音频') || w.includes('录音')) return 'audio';
  if (w.includes('文件') || w.includes('文档')) return 'file';
  return kindFromType(w);
}

/** `聊天类型` 的中文值 → ChatType。 */
function chatTypeFromText(value: string): SessionHint['chatType'] | undefined {
  const v = value.trim();
  if (v.length === 0) return undefined;
  if (v.includes('群')) return 'group';
  if (v.includes('临时')) return 'temp';
  if (v.includes('私') || v.includes('好友') || v.includes('单聊')) return 'private';
  return undefined;
}

interface TxtBlock {
  index?: string;
  timeText?: string;
  ts: number | null;
  senderName?: string;
  senderUin?: string;
  typeText?: string;
  text: string;
  resources: ResourceRef[];
  mentions: Array<{ uid?: string; name?: string }>;
  replyPreview?: string;
  /** 认不出的行（收尾时计入 errors）。 */
  unknown: string[];
}

function newBlock(): TxtBlock {
  return { ts: null, text: '', resources: [], mentions: [], unknown: [] };
}

export class QceTxtImporter implements Importer {
  readonly name = 'qce-txt';
  readonly formats: DetectedFormat[] = ['qce-txt'];

  async run(ctx: ImportContext): Promise<ImportStats> {
    const source = ctx.source ?? 'qce-txt';
    const run = new ImportRun(ctx, this.name);
    const hint: SessionHint = { ...ctx.sessionHint };
    const syncSession = (): void => {
      run.setSession(sessionFromHint(ctx.accountUid, source, hint));
    };
    syncSession();

    let block = newBlock();
    let section: 'none' | 'content' | 'resources' | 'mentions' | 'reply' = 'none';
    /** 直接产出一条完整消息（单行式）。 */
    const emitSingle = async (parsed: ParsedTxtMessage): Promise<void> => {
      if (parsed.ts === null || parsed.ts <= 0) {
        run.recordFailure(`缺少可解析的时间戳（原文：${preview(parsed.text)}）`);
        return;
      }
      const single: TxtBlock = {
        ts: parsed.ts,
        text: parsed.text,
        senderName: parsed.senderName,
        resources: [],
        mentions: [],
        unknown: [],
      };
      if (parsed.senderUin !== null) single.senderUin = parsed.senderUin;
      if (parsed.timeText !== null) single.timeText = parsed.timeText;
      await run.push(buildMessage(single, parseTxtContentMarker(parsed.text)));
    };
    /** 收尾当前块并把认不出的行记为错误。 */
    const flush = async (): Promise<void> => {
      const pending = block;
      block = newBlock();
      section = 'none';
      for (const line of pending.unknown) {
        run.recordFailure(`无法解析的文本行：${preview(line)}`);
      }
      const cleaned = parseTxtContentMarker(pending.text);
      const hasBody =
        cleaned.cleanText.trim().length > 0 ||
        pending.resources.length > 0 ||
        cleaned.kind !== undefined ||
        cleaned.face === true ||
        cleaned.system === true;
      if (!hasBody) return;
      if (pending.ts === null || !Number.isFinite(pending.ts) || pending.ts <= 0) {
        run.recordFailure(
          `缺少可解析的时间戳（时间字段=${pending.timeText ?? '无'}，内容=${preview(pending.text)}）`,
        );
        return;
      }
      await run.push(buildMessage(pending, cleaned));
    };

    for await (const line of fileLineStream(ctx.filePath)) {
      if (run.limitReached) break;
      run.checkAbort();
      const raw = line.replace(/\r$/, '');
      if (raw.trim().length === 0) continue;
      const trimmed = raw.trim();
      if (RE_FOOTER.test(trimmed) || RE_BANNER.test(trimmed)) continue;
      const indented = /^[ \t]/.test(raw);

      // ---------- 顶格：索引 / 头部标签 / 字段标签 ----------
      if (!indented) {
        const index = RE_INDEX.exec(trimmed);
        if (index) {
          await flush();
          block.index = (index[1] ?? '').trim();
          continue;
        }
        const label = RE_LABEL.exec(raw);
        const labelKey = label?.[1]?.trim() ?? '';
        if (label && HEADER_LABELS.has(labelKey)) {
          const value = (label[2] ?? '').trim();
          if (labelKey === '聊天名称' || labelKey === '群名称') {
            if (value.length > 0) hint.name = value;
          } else if (labelKey === '聊天类型') {
            const ct = chatTypeFromText(value);
            if (ct !== undefined) hint.chatType = ct;
          } else if (labelKey === '参与人数') {
            const n = Number(value.replace(/[^\d]/g, ''));
            if (Number.isFinite(n) && n > 0) hint.memberCount = n;
          } else if (labelKey === '群号' || labelKey === '账号') {
            const digits = value.replace(/[^\d]/g, '');
            if (digits.length >= 4) hint.peerUin = digits;
          }
          syncSession();
          continue;
        }
        if (label && FIELD_LABELS.has(labelKey)) {
          const value = label[2] ?? '';
          if (labelKey === '时间' || labelKey === '时间戳') {
            if (block.text.length > 0 || block.resources.length > 0) await flush();
            block.timeText = value.trim();
            block.ts = parseTxtTime(value);
          } else if (labelKey === '内容' || labelKey === '消息') {
            block.text = value;
            section = 'content';
          } else if (labelKey === '类型') {
            block.typeText = value.trim();
            section = 'none';
          } else if (labelKey === '资源') {
            section = 'resources';
          } else if (labelKey === '提及') {
            for (const name of value.split(/[,，、;；]/)) {
              const name2 = name.trim();
              if (name2.length > 0) block.mentions.push({ name: name2 });
            }
            section = 'mentions';
          } else {
            block.replyPreview = value.trim();
            section = 'reply';
          }
          continue;
        }
      }

      // ---------- 缩进续行 / 资源条目 ----------
      if (section === 'content' && indented) {
        block.text = `${block.text}\n${raw.replace(/^[ \t]{1,4}/, '')}`;
        continue;
      }
      if (section === 'resources' || section === 'mentions' || section === 'reply') {
        const item = RE_RESOURCE_ITEM.exec(raw);
        if (section === 'resources' && item) {
          const filename = (item[2] ?? '').trim();
          const ref: ResourceRef = { kind: kindFromTxtWord(item[1] ?? '') };
          if (filename.length > 0) ref.filename = filename;
          block.resources.push(ref);
          continue;
        }
        if (section === 'mentions' && indented) {
          for (const name of raw.split(/[,，、;；]/)) {
            const name2 = name.replace(/^\s*[-•*]\s*/, '').trim();
            if (name2.length > 0) block.mentions.push({ name: name2 });
          }
          continue;
        }
        if (section === 'reply' && indented) {
          block.replyPreview = `${block.replyPreview ?? ''}\n${trimmed}`.trim();
          continue;
        }
      }

      // ---------- 单行式消息 / 发送者标题行 ----------
      const parsed = parseTxtLine(raw);
      if (parsed) {
        if (RESERVED_SENDER_NAMES.has(parsed.senderName)) {
          block.unknown.push(raw);
          continue;
        }
        if (
          parsed.kind === 'header' ||
          (parsed.kind === 'message' && parsed.text.trim().length === 0 && parsed.ts === null)
        ) {
          await flush();
          block.senderName = parsed.senderName;
          if (parsed.kind === 'header') block.senderUin = parsed.senderUin;
          else if (parsed.senderUin !== null) block.senderUin = parsed.senderUin;
          if (parsed.ts !== null) block.ts = parsed.ts;
          if (parsed.timeText !== null) block.timeText = parsed.timeText;
          continue;
        }
        await flush();
        await emitSingle(parsed);
        continue;
      }

      block.unknown.push(raw);
    }

    await flush();
    return run.finish();
  }
}

/** 组装一条 NormalizedMessage。 */
function buildMessage(block: TxtBlock, cleaned: TxtContentMarker): NormalizedMessage {
  const elements: MessageElement[] = [];
  if (cleaned.face === true) elements.push({ type: 'face', data: {} });
  const resources = [...block.resources];
  if (cleaned.kind !== undefined) resources.push({ kind: cleaned.kind });
  const system = cleaned.system === true;
  const text = cleaned.cleanText;
  const ts = block.ts ?? 0;

  const msgType = inferMessageType({
    explicit: block.typeText,
    elements,
    resources,
    text,
    system,
  });

  const message: NormalizedMessage = {
    msgKey: messageKeyOf({
      msgId: undefined,
      ts,
      senderUin: block.senderUin,
      text,
      resources,
      seq: block.index ?? null,
    }),
    ts,
    direction: system ? 'system' : 'in',
    msgType,
    text,
  };
  if (block.index !== undefined) message.seq = block.index;
  if (block.senderUin !== undefined) message.senderUin = block.senderUin;
  if (block.senderName !== undefined) message.senderName = block.senderName;
  if (system) message.system = true;
  if (elements.length > 0) message.elements = elements;
  if (block.mentions.length > 0) message.mentions = block.mentions;
  if (block.replyPreview !== undefined && block.replyPreview.length > 0) {
    message.reply = { preview: block.replyPreview.slice(0, 500) };
  }
  if (resources.length > 0) message.resources = resources;

  const extra: Record<string, unknown> = {};
  if (block.timeText !== undefined) extra.time = block.timeText;
  if (block.typeText !== undefined) extra.qceType = block.typeText;
  if (block.replyPreview !== undefined) extra.replyRaw = block.replyPreview.slice(0, 500);
  if (Object.keys(extra).length > 0) message.extra = extra;
  return message;
}
