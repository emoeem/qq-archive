/**
 * web/lib.js 的类型声明。
 * TS（tests/web.test.ts）以 NodeNext 解析 `../web/lib.js` 时会落到本文件。
 */

export declare const PLACEHOLDER: '—';
export declare const ROUTES: string[];
export declare const DEFAULT_ROUTE: 'overview';

export type StatusTone = 'ok' | 'bad' | 'warn' | 'run' | 'info' | 'muted';

export declare function isFiniteNumber(n: unknown): n is number;
export declare function formatTime(ts: number | null | undefined): string;
export declare function formatIso(value: number | string | null | undefined): string;
export declare function formatRelative(ts: number | null | undefined, now?: number): string;
export declare function formatBytes(n: number | null | undefined): string;
/** 计数千分位；非有限数值（含字符串等畸形输入）返回 '—'，故入参按 unknown 声明。 */
export declare function formatCount(n: unknown): string;
export declare function formatDuration(seconds: number | null | undefined): string;
export declare function chatTypeLabel(t: string | null | undefined): string;
export declare function msgTypeLabel(t: string | null | undefined): string;
export declare function mediaKindLabel(k: string | null | undefined): string;
export declare function mediaKindIcon(k: string | null | undefined): string;
export declare function mediaStatusLabel(s: string | null | undefined): string;
export declare function jobStatusLabel(s: string | null | undefined): string;
export declare function logLevelLabel(l: string | null | undefined): string;
export declare function buildUrl(
  path: string,
  params?: Record<string, string | number | boolean | null | undefined> | null,
): string;
export declare function escapeHtml(s: unknown): string;
export declare function truncate(s: unknown, n: number): string;
export declare function statusClass(status: string | null | undefined): StatusTone;
export declare function parseHash(hash: string | null | undefined): {
  route: string;
  params: Record<string, string>;
  fallback: boolean;
};
export declare function pageCount(total: number | null | undefined, pageSize: number | null | undefined): number;
export declare function clampPage(
  page: number | null | undefined,
  total: number | null | undefined,
  pageSize: number | null | undefined,
): number;
export declare function jobProgress(job: unknown): number;

/** 定时器实现（可注入假实现用于单测）。 */
export interface RefreshTimers {
  setInterval: (fn: () => void, ms: number) => number;
  clearInterval: (id: number) => void;
}

export interface RefreshControllerOptions {
  /** 取当前刷新间隔（毫秒）；0 或负数表示不启动。 */
  getIntervalMs: () => number;
  /** 当前是否应该刷新（例如"还在这个页面上"）；返回 false 时控制器自行停止。 */
  isActive: () => boolean;
  /** 是否临时跳过这一轮（例如标签页在后台）而不停止定时器。 */
  isPaused?: () => boolean;
  /** 定时器实现；缺省用全局 setInterval/clearInterval。 */
  timers?: RefreshTimers;
}

export interface RefreshHandlers {
  onTick?: () => void;
  [key: string]: unknown;
}

export interface RefreshController {
  /** 注册回调；`start()` 不会清掉它（曾经因为 start 里调 stop 把回调清掉导致自动刷新空转）。 */
  setHandlers(handlers: RefreshHandlers | null | undefined): void;
  start(): void;
  stop(): void;
  isRunning(): boolean;
}

export declare function createRefreshController(opts: RefreshControllerOptions): RefreshController;
