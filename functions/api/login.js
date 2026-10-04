import { readJson, error, json, clientIp } from '../../_lib/http.js';
import {
  requireDb, createSession, rateLimit, clearRateLimit,
  classPasswordLookup, CLASS_TTL_SECONDS,
} from '../../_lib/auth.js';
import { parseSecret } from '../../_lib/validate.js';
import { verifyPassword, hashPassword } from '../../_lib/crypto.js';

/**
 * 班级口令登录。
 *
 * 与旧版的区别：
 *  - 旧版是 SELECT ... WHERE password = ?，明文等值比较。
 *  - 现在库里存的是加盐 PBKDF2 哈希，用 password_lookup 列做索引定位，
 *    再用 PBKDF2 校验；登录成功签发服务端会话，口令不再出现在后续请求里。
 *  - 登录成功后口令会从"明文/弱哈希"自动升级为 PBKDF2 哈希，
 *    因此不需要提前知道现网口令就能完成迁移。
 */
export async function onRequestPost(context) {
  const { request, env } = context;

  const missing = requireDb(env);
  if (missing) return missing;

  const ip = clientIp(request);
  const limit = await rateLimit(env, `class-login:${ip}`, 10, 900);
  if (!limit.allowed) return error('尝试过于频繁，请 15 分钟后再试', 429);

  const parsed = await readJson(request);
  if (!parsed.ok) return error(parsed.error, 400);

  const secret = parseSecret(parsed.value.password, { min: 4, max: 128, field: '班级口令' });
  if (!secret.ok) return error(secret.error, 400);

  const lookup = await classPasswordLookup(env, secret.value);

  // 常规路径：靠查找索引 O(1) 命中对应班级。
  const hit = await env.DB.prepare(
    'SELECT id, name, password FROM classes WHERE password_lookup = ?'
  ).bind(lookup).first();

  let matched = null;
  let needsUpgrade = false;

  if (hit) {
    const verdict = await verifyPassword(hit.password, secret.value);
    if (verdict.ok) {
      matched = hit;
      needsUpgrade = verdict.needsRehash;
    }
  }

  // 回退路径：迁移前的老数据 password_lookup 为空，逐条校验后顺带回填。
  // 这种行通常只有一两条，一次性升级完就不再走这条路径。
  if (!matched) {
    const { results } = await env.DB.prepare(
      'SELECT id, name, password FROM classes WHERE password_lookup IS NULL'
    ).all();

    for (const candidate of results || []) {
      const verdict = await verifyPassword(candidate.password, secret.value);
      if (verdict.ok) {
        matched = candidate;
        needsUpgrade = true;
        break;
      }
    }
  }

  if (!matched) return error('口令错误', 401);

  if (needsUpgrade) {
    // 若历史上存在两个同口令的班级，回填唯一索引会冲突；
    // 这种情况下保持现状并让本次登录成功，交由管理员去后台清理重复口令。
    try {
      const hashed = await hashPassword(secret.value);
      await env.DB.prepare('UPDATE classes SET password = ?, password_lookup = ? WHERE id = ?')
        .bind(hashed, lookup, matched.id).run();
    } catch {
      /* 升级失败不影响本次登录 */
    }
  }

  const session = await createSession(env, request, {
    subject: 'class',
    subjectId: matched.id,
    ttlSeconds: CLASS_TTL_SECONDS,
  });
  await clearRateLimit(env, `class-login:${ip}`);

  // 令牌只通过 HttpOnly Cookie 下发，不放进响应体，脚本读不到。
  return json(
    { ok: true, class_id: matched.id, class_name: matched.name },
    200,
    { 'Set-Cookie': session.setCookie }
  );
}
