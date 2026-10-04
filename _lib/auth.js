/**
 * 服务端会话与限流。
 *
 * 这是本次安全升级的核心：把"每次请求都携带静态口令"改成
 * "登录一次 → 换一个短期会话令牌 → 后续请求只证明持有令牌"。
 *
 *  - 令牌本身不落库，库里只存 SHA-256 摘要。库被读出也无法直接冒用会话。
 *  - 令牌通过 HttpOnly Cookie 下发（脚本读不到，XSS 也偷不走），
 *    同时接受 Authorization: Bearer，便于命令行与自动化调用。
 *  - 会话有明确有效期，可撤销。
 */

import { randomToken, sha256Hex, hmacHex } from './crypto.js';
import {
  parseCookies, serializeCookie, isSecureRequest, clientIp, header, error,
} from './http.js';

export const SESSION_COOKIE = 'yczx_session';

/**
 * 班级口令查找索引用的私钥。
 * 生产环境请在 Pages → Settings → Environment variables 里配置 AUTH_PEPPER，
 * 未配置时会退回下面这个占位值（功能正常，但失去了"库泄露也无法反推口令"的额外保护）。
 */
export const DEFAULT_PEPPER = 'yczx-please-set-AUTH_PEPPER-env-var';
export const PEPPER_IS_DEFAULT = Symbol('default-pepper');

export function authPepper(env) {
  const configured = env && typeof env.AUTH_PEPPER === 'string' ? env.AUTH_PEPPER.trim() : '';
  return configured || DEFAULT_PEPPER;
}

/** 计算的班级口令查找值。 */
export async function classPasswordLookup(env, password) {
  return hmacHex(authPepper(env), password);
}

/** 管理员会话 12 小时；学生会话 30 天（学生是每周点一次，会话要够长）。 */
export const ADMIN_TTL_SECONDS = 12 * 60 * 60;
export const CLASS_TTL_SECONDS = 30 * 24 * 60 * 60;

/** D1 绑定缺失时给出明确错误，而不是让异常冒泡成 500 堆栈。 */
export function requireDb(env) {
  if (!env || !env.DB) {
    return error('服务端数据库未绑定（缺少 D1 绑定 DB）', 500);
  }
  return null;
}

/** 取出请求携带的令牌：优先 Authorization 头，其次 Cookie。 */
function presentedToken(request) {
  const auth = request.headers.get('Authorization') || '';
  if (auth.startsWith('Bearer ')) {
    const t = auth.slice(7).trim();
    if (t) return t;
  }
  return parseCookies(request)[SESSION_COOKIE] || '';
}

/**
 * 建立会话。
 * @returns {Promise<{token: string, maxAge: number, setCookie: string}>}
 */
export async function createSession(env, request, { subject, subjectId, role = null, ttlSeconds }) {
  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);

  await env.DB.prepare(
    `INSERT INTO sessions (token_hash, subject, subject_id, role, ip, user_agent, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now', ?))`
  ).bind(
    tokenHash,
    subject,
    subjectId,
    role,
    clientIp(request),
    header(request, 'User-Agent', 300),
    `+${Math.floor(ttlSeconds)} seconds`
  ).run();

  // 顺手清理过期会话，避免表无限增长（失败不影响登录）。
  try {
    await env.DB.prepare(
      `DELETE FROM sessions WHERE datetime(expires_at) <= datetime('now')`
    ).run();
  } catch { /* 清理是尽力而为 */ }

  return {
    token,
    maxAge: ttlSeconds,
    setCookie: serializeCookie(SESSION_COOKIE, token, {
      maxAge: ttlSeconds,
      secure: isSecureRequest(request),
      httpOnly: true,
      sameSite: 'Lax',
    }),
  };
}

/** 读取当前会话，无效/过期返回 null。 */
export async function readSession(env, request) {
  const token = presentedToken(request);
  if (!token) return null;

  const tokenHash = await sha256Hex(token);
  try {
    const row = await env.DB.prepare(
      `SELECT id, subject, subject_id, role, expires_at
         FROM sessions
        WHERE token_hash = ? AND datetime(expires_at) > datetime('now')`
    ).bind(tokenHash).first();

    return row || null;
  } catch (err) {
    // 迁移没跑的时候 sessions 表不存在。这是交接场景下最容易踩的坑，
    // 单独识别出来给一句人能看懂的提示，而不是抛 500 堆栈。
    if (/no such table/i.test(String((err && err.message) || ''))) {
      const wrapped = new Error('数据库尚未执行安全升级迁移');
      wrapped.migrationRequired = true;
      throw wrapped;
    }
    throw err;
  }
}

/**
 * 受保护接口的统一入口。
 * @returns {Promise<{ok: true, session: object} | {ok: false, response: Response}>}
 */
export async function requireSession(env, request, subject) {
  const missing = requireDb(env);
  if (missing) return { ok: false, response: missing };

  let session;
  try {
    session = await readSession(env, request);
  } catch (err) {
    if (err && err.migrationRequired) {
      return {
        ok: false,
        response: error(
          '数据库尚未执行安全升级迁移，请先在 D1 控制台执行 sql/001_security_upgrade.sql',
          500
        ),
      };
    }
    throw err;
  }

  if (!session) {
    return { ok: false, response: error('登录已过期，请重新登录', 401) };
  }
  if (subject && session.subject !== subject) {
    return { ok: false, response: error('无权限执行该操作', 403) };
  }
  return { ok: true, session };
}

/** 管理员接口专用：要求是管理员会话，并且（可选）满足角色要求。 */
export async function requireAdmin(env, request, allowedRoles = null) {
  const result = await requireSession(env, request, 'admin');
  if (!result.ok) return result;
  if (allowedRoles && !allowedRoles.includes(result.session.role)) {
    return { ok: false, response: error('当前角色无权执行该操作', 403) };
  }
  return result;
}

/**
 * 高级管理员专属操作。
 * 只有高级管理员能生成邀请口令、管理其他管理员、改班级口令与分类权重。
 */
export async function requireSuper(env, request) {
  return requireAdmin(env, request, ['super']);
}

/** 普通管理员及以上（审核歌单、黑名单、发公告）。 */
export async function requireStaff(env, request) {
  return requireAdmin(env, request, ['super', 'admin']);
}

/** 撤销当前会话（退出登录）。 */
export async function revokeSession(env, request) {
  const token = presentedToken(request);
  if (!token) return;
  const tokenHash = await sha256Hex(token);
  await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
}

/** 清空 Cookie 的头。 */
export function clearSessionCookie(request) {
  return serializeCookie(SESSION_COOKIE, '', {
    maxAge: 0,
    secure: isSecureRequest(request),
    httpOnly: true,
    sameSite: 'Lax',
  });
}

/**
 * 固定窗口限流。
 * @returns {Promise<{allowed: boolean, count: number}>}
 */
export async function rateLimit(env, bucket, limit, windowSeconds) {
  const modifier = `-${Math.floor(windowSeconds)} seconds`;
  try {
    await env.DB.prepare(
      `INSERT INTO rate_limits (bucket, count, window_start)
       VALUES (?, 1, datetime('now'))
       ON CONFLICT(bucket) DO UPDATE SET
         count = CASE
           WHEN datetime(window_start) <= datetime('now', ?) THEN 1
           ELSE count + 1
         END,
         window_start = CASE
           WHEN datetime(window_start) <= datetime('now', ?) THEN datetime('now')
           ELSE window_start
         END`
    ).bind(bucket, modifier, modifier).run();

    const row = await env.DB.prepare('SELECT count FROM rate_limits WHERE bucket = ?')
      .bind(bucket).first();
    const count = row ? Number(row.count) : 1;
    return { allowed: count <= limit, count };
  } catch {
    // 限流表不可用时放行，但不能因此让正常业务挂掉。
    return { allowed: true, count: 0 };
  }
}

/** 登录成功后清掉失败计数。 */
export async function clearRateLimit(env, bucket) {
  try {
    await env.DB.prepare('DELETE FROM rate_limits WHERE bucket = ?').bind(bucket).run();
  } catch { /* 尽力而为 */ }
}
