/**
 * 合并转发（forward）内容展开。
 *
 * 背景：OneBot 的 `forward` 段只带一个 `id`，消息正文里只有一个 `[合并转发]` 占位符
 * （见 `cq.ts` 的 `applySegment`）。真实聊天里转发常常承载了整段对话与图片，只留占位符
 * 等于这部分内容**根本没被归档** —— 与「防丢失」的目标直接冲突。
 *
 * 这里做的事：
 *  1. 沿 `get_forward_msg` 把子消息树拉下来（受 `maxDepth` / `maxNodes` 双重限流，防爆）；
 *  2. 子消息的正文 / 发送者 / 时间写进 `extra.forward` —— `messages.extra` 有落库
 *     （见 `packages/db/src/index.ts` 的 `insertMessages`），所以这些内容真的存得住；
 *  3. 子消息里的媒体资源**平铺**进父消息的 `resources`，复用父消息既有的归档与
 *     `message_media` 入库通路；每个节点记下 `resourceRange`，Web 端据此还原归属。
 *
 * 为什么不给子消息单独建 `messages` 行：转发子消息没有独立的 OneBot 消息 id，
 * 单独建行会产生无法去重、游标无法推进的假消息。挂在父消息上是可逆且幂等的。
 *
 * 本模块是**纯逻辑**（只依赖注入的 `fetchForward`），不碰 HTTP、不碰数据库，便于单测。
 */
import type { MessageElement, ResourceRef } from '../../core/src/index.ts';
import type { ForwardNode } from './types.ts';

/** 默认最大嵌套深度（1 = 只展开一层）。 */
export const DEFAULT_FORWARD_DEPTH = 3;

/** 默认单条转发的子消息节点上限。 */
export const DEFAULT_FORWARD_MAX_NODES = 200;

/** 单个转发子消息（写进 `extra.forward.messages[*]`）。 */
export interface StoredForwardNode {
  /** 子消息发送者 QQ 号（尽力保留）。 */
  senderUin?: string;
  senderName?: string;
  /** 毫秒时间戳；源数据没有时是 0。 */
  ts: number;
  /** 归一化后的消息类型（text / image / audio / …）。 */
  msgType: string;
  /** 可读正文。 */
  text: string;
  /** 子消息的原始消息段（保留未知段，不静默丢弃）。 */
  elements?: MessageElement[];
  /**
   * 本节点的资源在**父消息 `resources` 数组**中的下标区间 `[start, end)`。
   * 该区间的下标同时就是 `message_media.ordinal`，因此 Web 端可以据此把
   * 已归档媒体精确还原到转发里的哪一条子消息。无资源时该字段缺省。
   */
  resourceRange?: [number, number];
  /** 嵌套的子转发（该子消息自身也是合并转发，且未达深度上限）。 */
  forward?: StoredForward;
  /** 达到深度上限时保留 id，供人工追溯；内容不再展开。 */
  forwardId?: string;
  /** 与 `forwardId` 配对：表示「有嵌套转发但被深度上限截断」。 */
  forwardTruncated?: boolean;
}

/** 一层转发（写进 `extra.forward`）。 */
export interface StoredForward {
  /** 源数据里的转发 id。 */
  id: string;
  /** 本层及所有嵌套层合计的子消息条数。 */
  count: number;
  messages: StoredForwardNode[];
  /** 因触到 `maxNodes` / `maxDepth` 预算而提前收手。 */
  truncated?: boolean;
}

export interface ExpandForwardOptions {
  /** 拉取一层转发；失败应当抛出，由调用方决定是否降级。 */
  fetchForward: (id: string) => Promise<ForwardNode[]>;
  /** 要展开的转发 id。 */
  forwardId: string;
  /** 父消息已有的资源（会原样保留在返回数组最前面）。 */
  ownResources?: ResourceRef[];
  /** 最大嵌套深度（1 = 只展开一层）。默认 `DEFAULT_FORWARD_DEPTH`。 */
  maxDepth?: number;
  /** 整棵树最多接受多少个子消息节点。默认 `DEFAULT_FORWARD_MAX_NODES`。 */
  maxNodes?: number;
}

export interface ExpandedForward {
  /** 平铺后的资源（原有资源 + 转发内资源，按 URL / 路径 / 文件名去重）。 */
  resources: ResourceRef[];
  /** 写进 `extra.forward` 的结构。 */
  forward: StoredForward;
}

/**
 * 资源去重键。
 *
 * 同一条图片在转发里被多次引用很常见；优先按 url 去重，其次本地路径，
 * 再次「类型+文件名+大小」，都没有时退化到结构化指纹。去重保证
 * `resources` 与 `message_media.ordinal` 一一对应、不重复归档。
 */
export function resourceDedupKey(ref: ResourceRef): string {
  if (ref.url) return `u:${ref.url}`;
  if (ref.localPath) return `p:${ref.localPath}`;
  const name = ref.filename ?? '';
  if (name) return `f:${ref.kind}:${name}:${ref.size ?? ''}`;
  return `j:${JSON.stringify(ref)}`;
}

/**
 * 展开一棵合并转发，返回平铺后的资源与可落库的结构。
 *
 * 只读且幂等：同样的 `forwardId` + 同样的远端内容 → 同样的结构。
 * 递归深度由 `maxDepth` 封顶，节点总数由 `maxNodes` 封顶；触顶时在结构里
 * 显式标记 `truncated`，而不是静默少存。
 */
export async function expandForward(opts: ExpandForwardOptions): Promise<ExpandedForward> {
  const maxDepth = Math.max(1, Math.floor(opts.maxDepth ?? DEFAULT_FORWARD_DEPTH));
  const maxNodes = Math.max(1, Math.floor(opts.maxNodes ?? DEFAULT_FORWARD_MAX_NODES));
  const resources: ResourceRef[] = opts.ownResources ? [...opts.ownResources] : [];
  const seen = new Set<string>(resources.map(resourceDedupKey));
  const budget = { left: maxNodes };

  const forward = await walkForward(opts.fetchForward, opts.forwardId, 1, maxDepth, budget, resources, seen);
  return { resources, forward };
}

async function walkForward(
  fetchForward: (id: string) => Promise<ForwardNode[]>,
  forwardId: string,
  depth: number,
  maxDepth: number,
  budget: { left: number },
  resources: ResourceRef[],
  seen: Set<string>,
): Promise<StoredForward> {
  const nodes = await fetchForward(forwardId);
  const messages: StoredForwardNode[] = [];
  let truncated = false;

  for (const node of nodes) {
    if (budget.left <= 0) {
      truncated = true;
      break;
    }
    budget.left -= 1;

    // 先收集资源：resourceRange 记的是**平铺后父消息 resources 的下标**。
    const start = resources.length;
    for (const ref of node.resources ?? []) {
      const key = resourceDedupKey(ref);
      if (seen.has(key)) continue;
      seen.add(key);
      resources.push(ref);
    }

    const item: StoredForwardNode = {
      ts: Number.isFinite(node.ts) ? Math.round(node.ts) : 0,
      msgType: node.msgType || 'other',
      text: node.text ?? '',
    };
    if (node.senderUin) item.senderUin = node.senderUin;
    if (node.senderName) item.senderName = node.senderName;
    if (node.elements && node.elements.length) item.elements = node.elements;
    if (resources.length > start) item.resourceRange = [start, resources.length];

    if (node.forwardId) {
      if (depth < maxDepth) {
        const child = await walkForward(fetchForward, node.forwardId, depth + 1, maxDepth, budget, resources, seen);
        item.forward = child;
        // 截断必须冒泡到顶层：调用方（runner）只看顶层 truncated 来决定是否告警，
        // 深层被砍掉却不冒泡等于「静默少存」。
        if (child.truncated) truncated = true;
      } else {
        // 深度到顶：内容不展开，但把 id 留下，避免「静默丢失」。
        item.forwardId = node.forwardId;
        item.forwardTruncated = true;
        truncated = true;
      }
    }
    messages.push(item);
  }

  let count = messages.length;
  for (const m of messages) if (m.forward) count += m.forward.count;
  const out: StoredForward = { id: forwardId, count, messages };
  if (truncated) out.truncated = true;
  return out;
}
