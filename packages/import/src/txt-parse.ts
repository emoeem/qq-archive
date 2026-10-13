/**
 * QCE / 常见聊天记录导出的 **TXT** 文本行解析（尽力而为）。
 *
 * 真实世界里的 txt 导出至少有下面几种写法（本解析器全部支持）：
 *
 *   1. `[2024-01-02 03:04:05] 昵称(123456): 内容`
 *   2. `[2024/01/02 03:04] 昵称<123456>：内容`
 *   3. `2024-01-02 03:04:05 昵称(123456): 内容`
 *   4. `[12:30:05] 昵称(123456): 内容`
 *   5. `昵称(123456): 内容`                       （无时间）
 *   6. `昵称(123456)`                             （发送者单独一行，正文在下一行）
 *
 * 解析不出来的一律返回 `null`，由调用方决定「续接到上一条」还是「计入 errors」。
 */
import { parseTimeString } from '../../core/src/index.ts';

export interface ParsedTxtMessage {
  kind: 'message';
  /** 原始时间文本（`2024-01-02 03:04:05`），没有则为 null。 */
  timeText: string | null;
  /** 毫秒时间戳，解析不出为 null。 */
  ts: number | null;
  senderName: string;
  senderUin: string | null;
  text: string;
}

export interface ParsedTxtHeader {
  kind: 'header';
  timeText: string | null;
  ts: number | null;
  senderName: string;
  senderUin: string;
}

export type ParsedTxtLine = ParsedTxtMessage | ParsedTxtHeader;

/** `[时间] 其余内容`。 */
const RE_BRACKET_TIME = /^\[(?<time>[^\]]{1,40})\]\s*(?<rest>[\s\S]*)$/;
/** `2024-01-02 03:04[:05] 其余内容` / `2024/01/02 03:04 其余内容`。 */
const RE_LEAD_DATE_TIME =
  /^(?<time>\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?)\s+(?<rest>[\s\S]*)$/;
/** `03:04[:05] 其余内容`（只有时间）。 */
const RE_LEAD_TIME_ONLY = /^(?<time>\d{1,2}:\d{2}(?::\d{2})?)\s+(?<rest>[\s\S]*)$/;
/** `昵称(123456)` / `昵称(123456): 内容` —— 带 QQ 号，信号最强。 */
const RE_SENDER_WITH_UIN =
  /^(?<name>[\s\S]{1,80}?)\s*[（(<](?<uin>\d{4,12})[）)>]\s*[:：]?\s*(?<text>[\s\S]*)$/;
/** `昵称: 内容`（昵称里不含 `:`）。 */
const RE_SENDER_PLAIN = /^(?<name>[\s\S]{1,80}?)\s*[:：]\s*(?<text>[\s\S]*)$/;

/** 把 txt 里的时间文本转成毫秒时间戳（支持 `/` 分隔，复用 core 的解析器）。 */
export function parseTxtTime(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const normalized = String(raw).trim().replace(/\//g, '-').replace(/\./g, '-');
  const ms = parseTimeString(normalized);
  return ms !== null && Number.isFinite(ms) ? ms : null;
}

function groups(m: RegExpExecArray): Record<string, string | undefined> {
  return (m.groups ?? {}) as Record<string, string | undefined>;
}

/**
 * 解析一行 txt。识别不出「这一行属于谁」时返回 null。
 * 注意：返回 `header` 表示这一行只给出发送者，正文在后续行里。
 */
export function parseTxtLine(line: string): ParsedTxtLine | null {
  const raw = line.replace(/\r$/, '');
  if (raw.trim().length === 0) return null;

  let timeText: string | null = null;
  let rest = raw;

  const bracket = RE_BRACKET_TIME.exec(raw);
  if (bracket) {
    timeText = groups(bracket).time ?? null;
    rest = groups(bracket).rest ?? '';
  } else {
    const lead = RE_LEAD_DATE_TIME.exec(raw);
    if (lead) {
      timeText = groups(lead).time ?? null;
      rest = groups(lead).rest ?? '';
    } else {
      const timeOnly = RE_LEAD_TIME_ONLY.exec(raw);
      if (timeOnly) {
        timeText = groups(timeOnly).time ?? null;
        rest = groups(timeOnly).rest ?? '';
      }
    }
  }

  const withUin = RE_SENDER_WITH_UIN.exec(rest);
  if (withUin) {
    const g = groups(withUin);
    const name = (g.name ?? '').trim();
    const uin = g.uin ?? null;
    const text = g.text ?? '';
    if (name.length === 0) return null;
    if (text.trim().length === 0) {
      // 「昵称(QQ号)」独占一行 → 发送者标题行
      if (uin === null) return null;
      return {
        kind: 'header',
        timeText,
        ts: parseTxtTime(timeText),
        senderName: name,
        senderUin: uin,
      };
    }
    return {
      kind: 'message',
      timeText,
      ts: parseTxtTime(timeText),
      senderName: name,
      senderUin: uin,
      text,
    };
  }

  const plain = RE_SENDER_PLAIN.exec(rest);
  if (plain) {
    const g = groups(plain);
    const name = (g.name ?? '').trim();
    if (name.length === 0) return null;
    // 纯 `xxx: yyy` 只在「看起来像人/机器人名」时接受，避免把 JSON/代码行的残余当消息
    if (/^[\s"'{}\[\],]+$/.test(name)) return null;
    return {
      kind: 'message',
      timeText,
      ts: parseTxtTime(timeText),
      senderName: name,
      senderUin: null,
      text: g.text ?? '',
    };
  }

  return null;
}

/**
 * 判断一段文本是否「像聊天记录 txt」。
 * 强信号：行首有可解析的时间，或发送者带 `(QQ号)`。弱信号：至少两行 `昵称: 内容`。
 */
export function looksLikeChatTxt(lines: readonly string[]): boolean {
  let matched = 0;
  let strong = 0;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const parsed = parseTxtLine(line);
    if (parsed === null) continue;
    matched += 1;
    if (parsed.ts !== null || parsed.senderUin !== null) strong += 1;
    if (strong >= 1 && matched >= 2) return true;
    if (matched >= 8) break;
  }
  return strong >= 1 && matched >= 1;
}
