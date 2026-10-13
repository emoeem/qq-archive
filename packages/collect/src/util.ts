/** OneBot 响应解析用的小工具（不做任何 I/O）。 */

/** 可注入的 fetch 类型：与全局 fetch 完全一致，测试可传假实现。 */
export type FetchLike = typeof globalThis.fetch;

/** 把 unknown 收窄为普通对象（数组/ null 都返回 null）。 */
export function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** 把 unknown 收窄为数组。 */
export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** 把 unknown 转成字符串；空串/null/undefined 返回 undefined。 */
export function str(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v);
  return s === '' ? undefined : s;
}

/** 把 unknown 转成有限数字；非法值返回 undefined。 */
export function num(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** 稳定的错误文本。 */
export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
