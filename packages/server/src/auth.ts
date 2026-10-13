/**
 * 认证：配置里的 `server.token` ⇄ 短时 accessToken。
 *
 * - 登录用**常量时间比较**校验 `server.token`（先 sha256 再 timingSafeEqual，长度恒定）。
 * - accessToken = `base64url(payload).base64url(hmac-sha256(payload))`，签名密钥由 `server.token` 派生，
 *   payload 含 `{sub, iat, exp, jti}`；校验时同样常量时间比较签名。
 * - 另发一个随机 refreshToken（DB 只保存其 sha256，见 `settings` 表的 `auth.refresh_sessions`），
 *   用于在 accessToken 过期后换取新的 accessToken —— 对应 ARCHITECTURE 第 6 节认证语义。
 */
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { sha256Hex } from '../../core/src/ids.ts';
import type { AppConfig } from '../../core/src/config.ts';
import type { Db } from '../../db/src/index.ts';

export interface AccessPayload {
  sub: string;
  iat: number;
  exp: number;
  jti: string;
}

const REFRESH_KEY = 'auth.refresh_sessions';
const MAX_REFRESH_SESSIONS = 20;

/** 常量时间字符串比较（长度不同也不会抛异常：先各自 sha256）。 */
export function constantTimeEqual(a: string, b: string): boolean {
  const da = createHash('sha256').update(String(a), 'utf8').digest();
  const db = createHash('sha256').update(String(b), 'utf8').digest();
  return timingSafeEqual(da, db);
}

/** 由 `server.token` 派生 HMAC 签名密钥。 */
export function deriveSigningKey(serverToken: string): Buffer {
  return createHash('sha256').update(`qqarchive/access-token/v1\u0000${serverToken}`, 'utf8').digest();
}

/** 签发 accessToken。 */
export function signAccessToken(key: Buffer, payload: AccessPayload): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = createHmac('sha256', key).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/** 校验 accessToken；失败返回 null（不区分「格式错」与「过期」，避免泄露细节）。 */
export function verifyAccessToken(key: Buffer, token: string, now = Date.now()): AccessPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const body = parts[0];
  const sig = parts[1];
  if (body === undefined || sig === undefined || body === '' || sig === '') return null;
  const expected = createHmac('sha256', key).update(body).digest('base64url');
  if (!constantTimeEqual(sig, expected)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const p = parsed as Record<string, unknown>;
  if (typeof p.sub !== 'string' || typeof p.jti !== 'string') return null;
  if (typeof p.iat !== 'number' || typeof p.exp !== 'number') return null;
  if (!Number.isFinite(p.exp) || p.exp <= now) return null;
  return { sub: p.sub, iat: p.iat, exp: p.exp, jti: p.jti };
}

/** 生成一对新的 accessToken / refreshToken。 */
export function issueSession(
  cfg: AppConfig,
  key: Buffer,
  db: Db,
): { accessToken: string; refreshToken: string; payload: AccessPayload; accessTtlSec: number; sessionTtlSec: number } {
  const sessionTtlSec = Math.max(60, cfg.server.sessionTtlSec);
  // accessToken 短时（最多 12 小时），refreshToken 覆盖整个会话有效期。
  const accessTtlSec = Math.min(sessionTtlSec, 12 * 3600);
  const now = Date.now();
  const payload: AccessPayload = { sub: 'admin', iat: now, exp: now + accessTtlSec * 1000, jti: randomUUID() };
  const accessToken = signAccessToken(key, payload);
  const refreshToken = randomBytes(32).toString('base64url');
  saveRefreshToken(db, refreshToken, sessionTtlSec);
  return { accessToken, refreshToken, payload, accessTtlSec, sessionTtlSec };
}

interface RefreshEntry {
  sha: string;
  exp: number;
}

function loadRefreshEntries(db: Db): RefreshEntry[] {
  const raw = db.getSetting(REFRESH_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const now = Date.now();
    return parsed.filter(
      (e): e is RefreshEntry =>
        e !== null &&
        typeof e === 'object' &&
        typeof (e as RefreshEntry).sha === 'string' &&
        typeof (e as RefreshEntry).exp === 'number' &&
        (e as RefreshEntry).exp > now,
    );
  } catch {
    return [];
  }
}

function saveRefreshEntries(db: Db, entries: RefreshEntry[]): void {
  db.setSetting(REFRESH_KEY, JSON.stringify(entries.slice(-MAX_REFRESH_SESSIONS)));
}

/** 记录一个 refreshToken（只存 sha256）。 */
export function saveRefreshToken(db: Db, token: string, ttlSec: number): void {
  const entries = loadRefreshEntries(db);
  entries.push({ sha: sha256Hex(token), exp: Date.now() + ttlSec * 1000 });
  saveRefreshEntries(db, entries);
}

/**
 * 校验并**消费** refreshToken（轮换语义：用过即作废）。
 * 比对同样走常量时间。
 */
export function takeRefreshToken(db: Db, token: string): boolean {
  const entries = loadRefreshEntries(db);
  const sha = sha256Hex(token);
  let hit = false;
  const rest: RefreshEntry[] = [];
  for (const e of entries) {
    if (!hit && constantTimeEqual(e.sha, sha)) {
      hit = true;
      continue;
    }
    rest.push(e);
  }
  if (hit) saveRefreshEntries(db, rest);
  return hit;
}

/** 注销后拉黑的 jti（内存级；重启即失效，accessToken 本身只有数小时寿命）。 */
export function revokeJti(revoked: Map<string, number>, jti: string, exp: number): void {
  const now = Date.now();
  for (const [k, v] of revoked) if (v <= now) revoked.delete(k);
  revoked.set(jti, exp);
}

export function isRevoked(revoked: Map<string, number>, jti: string): boolean {
  const exp = revoked.get(jti);
  if (exp === undefined) return false;
  if (exp <= Date.now()) {
    revoked.delete(jti);
    return false;
  }
  return true;
}

/** 极简登录失败限流（每 IP 每分钟 10 次），防止本机被脚本爆破。 */
export class LoginThrottle {
  private fails = new Map<string, { count: number; until: number }>();

  /** 是否允许尝试。 */
  allowed(ip: string): boolean {
    const rec = this.fails.get(ip);
    if (!rec) return true;
    if (rec.until > Date.now()) return false;
    return true;
  }

  fail(ip: string): void {
    const now = Date.now();
    const rec = this.fails.get(ip);
    if (!rec || rec.until <= now) {
      this.fails.set(ip, { count: 1, until: 0 });
      return;
    }
    const count = rec.count + 1;
    this.fails.set(ip, { count, until: count >= 10 ? now + 60_000 : 0 });
  }

  succeed(ip: string): void {
    this.fails.delete(ip);
  }
}
