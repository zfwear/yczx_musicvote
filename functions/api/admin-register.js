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

/**
 * 密码强度：至少 8 位，且至少包含「字母 / 数字 / 符号」中的两类。
 *
 * 为什么在服务端再查一遍（前端也会查）：直接 curl 接口可以完全绕过前端，
 * 前端校验只是体验，这一条才是真正的边界。规则刻意保持与前端提示一字不差，
 * 免得出现"页面说能注册、服务端说不行"的错位。
 */
export function checkPasswordStrength(value) {
  const pwd = String(value ?? '');
  let kinds = 0;
  if (/[A-Za-z]/.test(pwd)) kinds += 1;
  if (/\d/.test(pwd)) kinds += 1;
  if (/[^A-Za-z0-9]/.test(pwd)) kinds += 1;
  if (pwd.length < 8) return { ok: false, error: '密码至少 8 位' };
  if (kinds < 2) return { ok: false, error: '密码需包含字母、数字、符号中的至少两类' };
  return { ok: true };
}

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
   const password = parseSecret(data.password, { min: 8, max: 128, field: '密码' });
  if (!password.ok) return error(password.error, 400);
  const strength = checkPasswordStrength(password.value);
  if (!strength.ok) return error(strength.error, 400);

  // 确认密码：页面表单永远带这一位；不一致直接拦在前面，别等人家注册完才发现打错了。
  // 直接调 API 的旧调用方可以不带 —— 只有**带来了**才要求对得上。
  if (data.password2 !== undefined && data.password2 !== null && String(data.password2) !== password.value) {
    return error('两次输入的密码不一致', 400);
  }

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
