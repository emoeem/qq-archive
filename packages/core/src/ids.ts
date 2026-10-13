import { createHash } from 'node:crypto';

/** 计算十六进制 sha256。 */
export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

/** 对字符串做规范化，用于生成稳定键（去首尾空白、统一小写 hex、压缩空白）。 */
function canonical(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value).trim();
  return s.replace(/\s+/g, ' ');
}

/**
 * 生成稳定的会话键：`<chatType>:<peerUid>`。
 *
 * 同一账号下，会话键在重复导入之间必须完全一致，否则会产生重复会话。
 */
export function sessionKeyOf(chatType: string, peerUid: string): string {
  const t = canonical(chatType) || 'other';
  const p = canonical(peerUid);
  if (!p) throw new Error('sessionKeyOf: peerUid 不能为空');
  return `${t}:${p}`;
}

/**
 * 生成稳定消息键。
 *
 * 优先使用源数据里的真实消息 id（跨导入稳定）；若源数据没有 id，
 * 则用「时间戳 + 发送者 + 正文 + 资源指纹」的内容哈希兜底 —— 这能保证
 * 同一份文件重复导入不会产生重复行，也能让不同导出文件的同一条消息归并。
 */
export function messageKeyOf(input: {
  msgId?: string | null;
  ts: number;
  senderUid?: string | null;
  senderUin?: string | null;
  text?: string | null;
  resources?: Array<{ kind?: string; filename?: string; size?: number; url?: string }> | undefined;
  seq?: string | null;
}): string {
  const msgId = canonical(input.msgId);
  if (msgId) return `id:${msgId}`;

  const resFingerprint = (input.resources ?? [])
    .map((r) => `${canonical(r.kind)}|${canonical(r.filename)}|${r.size ?? ''}|${canonical(r.url)}`)
    .join(';');
  const seed = [
    input.ts,
    canonical(input.senderUid),
    canonical(input.senderUin),
    canonical(input.text),
    canonical(input.seq),
    resFingerprint,
  ].join('\u0001');
  return `h:${sha256Hex(seed).slice(0, 40)}`;
}

/**
 * 生成安全文件名：去掉路径分隔符与危险字符，保留扩展名，长度受限。
 * 结果永远不会是 `.`/`..`，不会包含 `/`、`\`、NUL。
 */
export function safeFilename(name: string, fallbackExt = ''): string {
  let out = String(name ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/]/g, '_')
    .replace(/^\.+/, '_')
    .trim();
  out = out.replace(/\s+/g, ' ').slice(0, 180);
  if (!out) out = 'unnamed';
  if (!/\.[A-Za-z0-9]{1,8}$/.test(out) && fallbackExt) {
    const ext = fallbackExt.replace(/^\./, '');
    if (ext) out = `${out}.${ext}`;
  }
  return out;
}

/** 时间戳转 `YYYY-MM-DD HH:mm:ss`（本地时区）。 */
export function formatTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** `YYYY-MM-DD HH:mm:ss` 转毫秒时间戳；无法解析返回 null。 */
export function parseTimeString(s: string | null | undefined): number | null {
  if (!s) return null;
  const trimmed = String(s).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(trimmed);
  if (m) {
    const [, y, mo, da, h, mi, se] = m;
    const d = new Date(Number(y), Number(mo) - 1, Number(da), Number(h ?? '0'), Number(mi ?? '0'), Number(se ?? '0'));
    const t = d.getTime();
    return Number.isFinite(t) ? t : null;
  }
  const n = Number(trimmed);
  if (Number.isFinite(n) && n > 0) return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
  const p = Date.parse(trimmed);
  return Number.isFinite(p) ? p : null;
}

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;

/**
 * 为 FTS5（unicode61）生成可检索文本。
 *
 * 中文/日文/韩文没有空格，unicode61 会把整段中文当成一个 token，导致子串搜不到。
 * 这里对 CJK 连续段做**二元切分**（bigram），英文数字保持原样：
 *   「你好世界」→「你好 好世 世界」，搜「世界」命中，搜「好世」也命中。
 * 单字 CJK 段原样保留，保证「好」也能搜到。
 */
export function buildSearchText(text: string): string {
  if (!text) return '';
  const out: string[] = [];
  let cjk = '';
  let word = '';
  const flushCjk = () => {
    if (cjk) {
      out.push(bigrams(cjk));
      cjk = '';
    }
  };
  const flushWord = () => {
    if (word) {
      out.push(word);
      word = '';
    }
  };
  for (const ch of text) {
    if (CJK.test(ch)) {
      flushWord();
      cjk += ch;
    } else if (/[0-9A-Za-z_]/.test(ch)) {
      flushCjk();
      word += ch;
    } else {
      // 空白与标点：同时结束 CJK 段与西文词
      flushCjk();
      flushWord();
    }
  }
  flushCjk();
  flushWord();
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * 把一段连续 CJK 文本切成二元组。
 *
 * 只产出 bigram，**不附加整段**：查询侧用 AND 连接各个二元组，若索引里多了一个
 * 整段 token 而查询里也有，就会出现「索引没有该整段 ⇒ AND 失配」的假阴性。
 * 单字 CJK 段原样保留（由查询侧决定是否退化为 LIKE）。
 */
export function bigrams(seg: string): string {
  if (seg.length <= 1) return seg;
  const out: string[] = [];
  for (let i = 0; i < seg.length - 1; i++) out.push(seg.slice(i, i + 2));
  return out.join(' ');
}


/** 关键词检索计划：要么走 FTS5 二元索引，要么退化为字面 LIKE。 */
export type SearchPlan =
  | { mode: 'fts'; query: string }
  | { mode: 'like'; reason: 'single-cjk-char' | 'empty' };

/** 判断关键词里是否存在长度为 1 的 CJK 连续段（无法用 bigram 索引命中）。 */
export function hasSingleCjkRun(keyword: string): boolean {
  let run = 0;
  for (const ch of keyword) {
    if (CJK.test(ch)) run++;
    else {
      if (run === 1) return true;
      run = 0;
    }
  }
  return run === 1;
}

/**
 * 生成检索计划。
 *
 * `buildSearchText` 已完成切分（CJK→二元组、西文→整词），这里把每个 token 单独加引号
 * 再用 AND 连接：
 *  - 逐 token 加引号 ⇒ `AND`/`OR`/`NOT`/`*`/`(` 等语法字符不会被解释；
 *  - 用 AND 而不是整体短语 ⇒ 二元组之间无需位置相邻，子串搜索才成立。
 * 单字 CJK（如「唱」）没有对应 bigram，必须退化为 LIKE，否则永远搜不到。
 */
export function escapeFtsQuery(query: string): string {
  return buildSearchText(query)
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '')}"`)
    .join(' AND ');
}

/** 决定一次检索走 FTS 还是 LIKE。 */
export function planSearch(keyword: string): SearchPlan {
  const kw = (keyword ?? '').trim();
  if (!kw) return { mode: 'like', reason: 'empty' };
  if (hasSingleCjkRun(kw)) return { mode: 'like', reason: 'single-cjk-char' };
  const q = escapeFtsQuery(kw);
  if (!q) return { mode: 'like', reason: 'empty' };
  return { mode: 'fts', query: q };
}


/** HTML 转义（用于在服务端生成高亮片段）。 */
export function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
