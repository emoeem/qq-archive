/**
 * 采集侧过滤规则（纯函数，无 IO）。
 *
 * 设计前提：这是一个**防丢失**系统，过滤默认只"少看点"，不"少存点" ——
 * 命中规则的消息默认照样入库，只打 `filtered` 标记（详见 `FiltersConfig` 的注释）。
 * `drop: true` 时才真的跳过存储，那时消息连库都不进，只在采集统计里计数。
 *
 * 匹配语义（刻意保持简单、可预测、可解释）：
 *  - 关键词：**子串**匹配，大小写不敏感（`toLowerCase` 后 includes）；
 *  - 发送者：QQ 号 / uid / 昵称 **任一相等**即命中（大小写不敏感，去空白）；
 *  - 类型：与消息的 `msgType` 精确相等（小写比较）；
 *  - 三条规则是「或」的关系，任一条命中即视为过滤，理由里记下命中的那一条。
 */
import type { FiltersConfig } from '../../core/src/config.ts';

/** 一条待判断的消息里与过滤有关的最小信息。 */
export interface FilterableMessage {
  msgType: string;
  text?: string;
  senderUin?: string;
  senderUid?: string;
  senderName?: string;
}

export interface FilterVerdict {
  /** 是否命中过滤规则。 */
  filtered: boolean;
  /** 人可读的命中理由（写进 `messages.filter_reason`，便于事后解释"为什么这条被过滤了"）。 */
  reason: string | null;
}

const NO_MATCH: FilterVerdict = { filtered: false, reason: null };

/** 归一化用于比较的字符串：去首尾空白 + 转小写。 */
function norm(v: string | undefined | null): string {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

/**
 * 判断一条消息是否命中过滤规则。
 *
 * 传入的 `filters` 应当是已归一化的（`filtersConfigOf(cfg)` 的产物）；
 * `enabled=false` 或规则为空时恒返回"未命中"，调用方无需另行判断。
 */
export function matchMessageFilter(msg: FilterableMessage, filters: FiltersConfig): FilterVerdict {
  if (!filters.enabled) return NO_MATCH;

  const text = norm(msg.text);
  if (text !== '') {
    for (const kw of filters.excludeKeywords) {
      const needle = norm(kw);
      if (needle !== '' && text.includes(needle)) {
        return { filtered: true, reason: `关键词命中「${kw}」` };
      }
    }
  }

  const senders = [norm(msg.senderUin), norm(msg.senderUid), norm(msg.senderName)].filter((s) => s !== '');
  if (senders.length > 0) {
    for (const who of filters.excludeSenders) {
      const needle = norm(who);
      if (needle !== '' && senders.includes(needle)) {
        return { filtered: true, reason: `发送者在排除名单里「${who}」` };
      }
    }
  }

  const type = norm(msg.msgType);
  for (const t of filters.excludeTypes) {
    if (norm(t) === type && type !== '') {
      return { filtered: true, reason: `消息类型「${msg.msgType}」在排除名单里` };
    }
  }

  return NO_MATCH;
}

/**
 * 批量判断，返回 `{ msgKey, verdict }[]` 形式便于调用方直接消费。
 *
 * 抽出来是为了让 runner 侧只调用一次；纯函数，便于单测覆盖。
 */
export function matchMessageFilters<T extends FilterableMessage & { msgKey: string }>(
  msgs: T[],
  filters: FiltersConfig,
): Map<string, FilterVerdict> {
  const out = new Map<string, FilterVerdict>();
  if (!filters.enabled) return out;
  for (const m of msgs) {
    const v = matchMessageFilter(m, filters);
    if (v.filtered) out.set(m.msgKey, v);
  }
  return out;
}

/** 过滤规则的摘要描述（用于启动日志与 `doctor` 输出，便于确认"到底配生效了没有"）。 */
export function describeFilters(filters: FiltersConfig): string {
  if (!filters.enabled) return '过滤未启用';
  const parts: string[] = [];
  if (filters.excludeKeywords.length > 0) parts.push(`关键词 ×${filters.excludeKeywords.length}`);
  if (filters.excludeSenders.length > 0) parts.push(`发送者 ×${filters.excludeSenders.length}`);
  if (filters.excludeTypes.length > 0) parts.push(`类型 ×${filters.excludeTypes.length}`);
  const mode = filters.drop ? '跳过存储' : '仅标记（仍入库）';
  return `过滤已启用：${parts.join('、') || '无规则'}；命中后 ${mode}`;
}
