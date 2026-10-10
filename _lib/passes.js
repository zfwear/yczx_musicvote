/**
 * 口令凭证（测试口令 / 游客口令）。
 *
 * 与班级口令同一套存储机制（PBKDF2 哈希 + HMAC 查找索引 + AES 可查看密文），
 * 但凭证是后台**生成**的一条独立记录，可以带有效期、可以作废，
 * 登录后签发的会话通过 sessions.pass_id 与凭证关联 ——
 * 作废凭证时能按列精确撤销它签发过的全部会话。
 *
 * 两种 kind：
 *   · test  —— 测试口令：登录后拥有完整投稿与投票权限（role='test'）；
 *   · guest —— 游客口令：登录后只读（role='guest'，复用整套 denyGuest 闸门）。
 *
 * 环境变量 GUEST_PASSWORD 那条老路**原样保留**：判定顺序是
 * 班级口令 → 口令凭证 → 环境变量游客 → 调试登录。
 */

import { randomReadableCode } from './crypto.js';

/** 会话 role 取值：与 _lib/auth.js 的 GUEST_ROLE 保持一致。 */
export const PASS_KINDS = ['test', 'guest'];

/** 凭证在登录响应里给前端看的身份名。 */
export const PASS_LABELS = {
  test: '测试口令',
  guest: '游客模式',
};

/** 生成一条人类可读的凭证口令（12 位，无易混字符，可直接口头转达）。 */
export function generatePassToken() {
  return randomReadableCode(12);
}

/**
 * 凭证当前是否可用（未作废、未过期）。
 * expires_at 为空 = 长期有效；比较用字符串字典序（本库时间列统一格式）。
 */
export function passIsUsable(row, nowSql = null) {
  if (!row) return false;
  if (Number(row.revoked) === 1) return false;
  const expires = String(row.expires_at || '').trim();
  if (!expires) return true;
  const now = nowSql || sqlNow();
  return expires > now;
}

/**
 * 凭证签发的会话还能活多少秒。
 * 上限与普通学生会话一致（24h）；凭证带有效期时取"剩余时间"，
 * 这样会话**天然活不过凭证**（续期逻辑对 pass_id 会话也不生效，见 auth.js）。
 */
export function passSessionTtlSeconds(row, nowMs = Date.now()) {
  const expires = String((row && row.expires_at) || '').trim();
  if (!expires) return 24 * 60 * 60;
  const at = Date.parse(`${expires.replace(' ', 'T')}Z`);
  if (!Number.isFinite(at)) return 24 * 60 * 60;
  const remaining = Math.floor((at - nowMs) / 1000);
  return remaining > 0 ? Math.min(24 * 60 * 60, remaining) : 0;
}

/** 库内统一的当前时间串（YYYY-MM-DD HH:MM:SS，UTC，与 datetime('now') 同形）。 */
export function sqlNow() {
  return new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

/**
 * 按查找索引找出可用凭证。
 * 登录热路径：一条等值查询解决；expired/revoked 都不算命中。
 * 查不到表（015 未执行）返回 null，登录流程照常走后续分支。
 */
export async function findUsablePassByLookup(env, lookup) {
  try {
    const row = await env.DB.prepare(
      `SELECT id, kind, label, expires_at, revoked
         FROM access_passes
        WHERE token_lookup = ?`
    ).bind(lookup).first();
    return passIsUsable(row) ? row : null;
  } catch (err) {
    if (/no such table/i.test(String((err && err.message) || ''))) return null;
    throw err;
  }
}

/** 凭证是否存在的可读说法（后台报错用）。 */
export function passKindLabel(kind) {
  return PASS_LABELS[kind] || kind;
}
