import { readJson, error, json, clientIp } from '../../_lib/http.js';
import {
  requireDb, createSession, rateLimit, clearRateLimit, ADMIN_TTL_SECONDS,
} from '../../_lib/auth.js';
import { parseSecret } from '../../_lib/validate.js';
import { verifyPassword, hashPassword } from '../../_lib/crypto.js';

/**
 * 管理员登录。
 *
 * 与旧版的区别：
 *  - 旧版是 WHERE username = ? AND password = ?，明文比较；现在校验加盐 PBKDF2 哈希。
 *  - 旧版登录成功后只返回 { ok, role }，**没有建立任何服务端会话**，
 *    导致后续每个管理接口只能继续用静态密码当通行证（审计报告第 4 条）。
 *    现在登录成功签发短期会话，后续接口统一校验会话与角色。
 *  - 旧的 login_token（动态口令）只在登录这一步生效，语义保留，仍然作为
 *    登录时的附加校验；但真正的授权改由会话承担。
 *  - 增加失败限流，账号不存在时也做一次等价开销的哈希，降低枚举与爆破空间。
 */
export async function onRequestPost(context) {
  const { request, env } = context;

  const missing = requireDb(env);
  if (missing) return missing;

  const ip = clientIp(request);
  const limit = await rateLimit(env, `admin-login:${ip}`, 8, 900);
  if (!limit.allowed) return error('尝试过于频繁，请 15 分钟后再试', 429);

  const parsed = await readJson(request);
  if (!parsed.ok) return error(parsed.error, 400);
  const data = parsed.value;

  const username = typeof data.username === 'string' ? data.username.trim() : '';
  const password = parseSecret(data.password, { min: 1, max: 128, field: '密码' });

  // 统一的失败响应，不暴露"账号是否存在"。
  const denied = () => error('账号或密码错误', 401);
  if (!username || username.length > 32 || !password.ok) return denied();

  const admin = await env.DB.prepare(
    'SELECT id, username, password, role, login_token, token_expires_at FROM admins WHERE username = ?'
  ).bind(username).first();

  if (!admin) {
    // 让"用户不存在"也付出一次哈希开销，抹平可被利用的时序差异。
    await hashPassword(password.value);
    return denied();
  }

  const verdict = await verifyPassword(admin.password, password.value);
  if (!verdict.ok) return denied();

  // 保留了原有的动态口令语义：配置了就要求登录时一并提供。
  if (admin.login_token) {
    const provided = typeof data.token === 'string' ? data.token.trim() : '';
    if (admin.token_expires_at && new Date(admin.token_expires_at) < new Date()) {
      return error('动态口令已过期', 401);
    }
    if (provided !== admin.login_token) {
      return error('动态口令错误', 401);
    }
  }

  if (verdict.needsRehash) {
    const hashed = await hashPassword(password.value);
    await env.DB.prepare('UPDATE admins SET password = ? WHERE id = ?').bind(hashed, admin.id).run();
  }

  const session = await createSession(env, request, {
    subject: 'admin',
    subjectId: admin.id,
    role: admin.role,
    ttlSeconds: ADMIN_TTL_SECONDS,
  });
  await clearRateLimit(env, `admin-login:${ip}`);

  return json(
    { ok: true, role: admin.role, username: admin.username },
    200,
    { 'Set-Cookie': session.setCookie }
  );
}
