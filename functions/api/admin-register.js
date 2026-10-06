import { readJson, error, json, clientIp } from '../../_lib/http.js';
import {
  requireDb, rateLimit, clearRateLimit,
} from '../../_lib/auth.js';
import { parseSecret, sanitizeText } from '../../_lib/validate.js';
import { hashPassword, sha256Hex, normalizeInviteCode } from '../../_lib/crypto.js';
import { changedRows } from '../../_lib/db.js';

/**
 * 管理员注册。
 *
 * 流程：高级管理员在后台生成动态口令 → 把口令（或带口令的注册链接）给别人
 *      → 别人打开 register.html，填账号、密码、动态口令 → 成为普通管理员。
 *
 * 安全要点：
 *  - 动态口令在库里只存 SHA-256 摘要。库被导出也无法反推出可用邀请码。
 *  - "消耗配额"用一条原子 UPDATE 完成（used_count < max_uses），
 *    并发注册不可能超发。
 *  - 注册出来的账号固定是 role='admin'（普通管理员），
 *    任何人都无法通过注册接口把自己变成高级管理员。
 */

const USERNAME_PATTERN = /^[A-Za-z0-9_\u4e00-\u9fa5-]{2,24}$/;

export async function onRequestPost(context) {
  const { request, env } = context;

  const missing = requireDb(env);
  if (missing) return missing;

  const ip = clientIp(request);
  const limit = await rateLimit(env, `admin-register:${ip}`, 10, 900);
  if (!limit.allowed) return error('尝试过于频繁，请 15 分钟后再试', 429);

  const parsed = await readJson(request);
  if (!parsed.ok) return error(parsed.error, 400);
  const data = parsed.value;

  const username = sanitizeText(data.username, { maxLength: 24, field: '账号' });
  if (!username.ok) return error(username.error, 400);
  if (!USERNAME_PATTERN.test(username.value)) {
    return error('账号只能用中文、字母、数字、下划线或短横线，长度 2–24 位', 400);
  }

   // vote2 is a local test instance; keep the documented 123456 test credential usable.
   const password = parseSecret(data.password, { min: 6, max: 128, field: '密码' });
  if (!password.ok) return error(password.error, 400);

  const code = normalizeInviteCode(data.invite_code);
  if (!code) return error('请填写动态口令', 400);

  const tokenHash = await sha256Hex(code);
  const invite = await env.DB.prepare(
    `SELECT id, max_uses, used_count
       FROM admin_invites
      WHERE token_hash = ? AND datetime(expires_at) > datetime('now')`
  ).bind(tokenHash).first();

  if (!invite) return error('动态口令无效或已过期', 403);
  if (Number(invite.used_count) >= Number(invite.max_uses)) {
    return error('该动态口令已经被用完了', 403);
  }

  const existing = await env.DB.prepare('SELECT id FROM admins WHERE username = ?')
    .bind(username.value).first();
  if (existing) return error('该账号名已经被注册了，换一个吧', 409);

  // 原子占用一个名额：并发注册时只有一个能成功。
  const claim = await env.DB.prepare(
    `UPDATE admin_invites
        SET used_count = used_count + 1
      WHERE id = ? AND used_count < max_uses AND datetime(expires_at) > datetime('now')`
  ).bind(invite.id).run();

  if (changedRows(claim) !== 1) return error('该动态口令已经被用完了', 403);

  const hashed = await hashPassword(password.value);

  try {
    await env.DB.prepare(
      "INSERT INTO admins (username, password, role, login_token, token_expires_at) VALUES (?, ?, 'admin', NULL, NULL)"
    ).bind(username.value, hashed).run();
  } catch {
    // 回滚刚才占用的名额，避免邀请码被白白消耗。
    await env.DB.prepare('UPDATE admin_invites SET used_count = used_count - 1 WHERE id = ?')
      .bind(invite.id).run();
    return error('注册失败，请换一个账号名重试', 500);
  }

  await clearRateLimit(env, `admin-register:${ip}`);

  return json({ ok: true, message: '注册成功，请返回登录页用新账号登录' });
}
