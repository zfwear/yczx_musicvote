import { readJson, error, json, clientIp } from '../../_lib/http.js';
import {
  requireDb, createSession, rateLimit, clearRateLimit,
  classPasswordLookup, authPepper, CLASS_TTL_SECONDS,
  debugLoginEnabled, normalizeRole,
} from '../../_lib/auth.js';
import { parseSecret } from '../../_lib/validate.js';
import { verifyPassword, hashPassword, encryptSecret } from '../../_lib/crypto.js';

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

  // 3) 调试模式。
  //    在班级口令框里输入「管理员账号 + 空格或冒号 + 管理员密码」，
  //    例如 admin:admin888。通过后拿到一个调试用的学生会话：
  //    点歌不限次数、不查重，提交的歌在后台标注「调试模式」。
  //    注意顺序：正常班级口令优先，口令真不对时才走这条路。
  //
  //    审计报告 A5：这条路必须有生产开关（DEBUG_LOGIN=1，默认关），
  //    而且只给高级管理员用 —— 它等价于"拿管理员密码在学生端开无限点歌"，
  //    写进真实歌曲表的东西是不能当作只读调试看的。
  if (!matched) {
    const debugResponse = await tryDebugLogin(env, request, secret.value);
    if (debugResponse) return debugResponse;
  }

  if (!matched) return error('口令错误', 401);

  if (needsUpgrade) {
    // 若历史上存在两个同口令的班级，回填唯一索引会冲突；
    // 这种情况下保持现状并让本次登录成功，交由管理员去后台清理重复口令。
    try {
      const hashed = await hashPassword(secret.value);
      // 顺手把 005 的"可查看密文"也补上 —— 否则这个班的口令虽然已经
      // 升级成哈希了，管理员在后台仍然看不到、没法分发（要再手动重设一次）。
      const encrypted = await encryptSecret(authPepper(env), secret.value);

      try {
        await env.DB.prepare(
          'UPDATE classes SET password = ?, password_lookup = ?, password_encrypted = ? WHERE id = ?'
        ).bind(hashed, lookup, encrypted, matched.id).run();
      } catch (err) {
        // 005 还没执行（没有 password_encrypted 列）：退回只写哈希
        if (!/no such column/i.test(String((err && err.message) || ''))) throw err;
        await env.DB.prepare('UPDATE classes SET password = ?, password_lookup = ? WHERE id = ?')
          .bind(hashed, lookup, matched.id).run();
      }
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

/** 调试模式的会话有效期：短一些，2 小时足够调试。 */
const DEBUG_TTL_SECONDS = 2 * 60 * 60;

/**
 * 尝试按调试模式登录。
 * 解析 "账号:密码" 或 "账号 密码"，拿管理员表校验。
 * 失败返回 null（调用方统一回"口令错误"，不暴露账号是否存在）。
 *
 * 审计报告 A5，三道收紧：
 *   1. **生产默认关闭**：只有 DEBUG_LOGIN=1（或 true/yes/on）才启用。
 *      没配就是关的，"忘记配环境变量"落在安全的那一侧。
 *   2. **只允许高级管理员（role='super'）**：普通管理员没有这个能力。
 *   3. **会话记录归属管理员 ID**（sessions.debug_admin_id，见 sql/013），
 *      这样改密 / 删号 / 登出时才能按管理员把调试会话一起撤销 ——
 *      原来 subject_id 恒为 0，撤都撤不掉。
 *
 * 注意：本函数不返回"调试模式已关闭"这类信息，关闭时与口令错误
 * 完全同形（都是 null → 401），避免对外暴露部署配置。
 */
async function tryDebugLogin(env, request, raw) {
  // 没有开关就整条路都不存在，连正则都不跑。
  if (!debugLoginEnabled(env)) return null;

  // 账号里不允许出现分隔符，密码取剩余全部内容（密码里可以有冒号/空格）
  const match = String(raw).match(/^([^\s:：]{1,32})\s*[\s:：]\s*(.+)$/);
  if (!match) return null;

  const username = match[1];
  const password = match[2].trim();
  if (!password) return null;

  // role 一起取出来：调试身份比普通学生权限高（不限次、不查重），
  // 只能由高级管理员换取，普通管理员即使密码正确也不放行。
  const admin = await env.DB.prepare(
    'SELECT id, username, password, role FROM admins WHERE username = ?'
  ).bind(username).first();
  if (!admin) return null;

  // 角色按数据库当前值判断；空值 / 无法识别的值按最低权限处理（normalizeRole）。
  if (normalizeRole(admin.role) !== 'super') return null;

  const verdict = await verifyPassword(admin.password, password);
  if (!verdict.ok) return null;

  // 调试会话仍然走"班级"这一侧（学生会话 Cookie），role='debug' 是
  // vote.js / rank.js 判断调试身份的唯一依据，不能改；
  // 归属管理员记在独立列里，不污染 role。
  const session = await createSession(env, request, {
    subject: 'class',
    subjectId: 0,             // 0 表示"不属于任何班级"，即调试身份
    role: 'debug',
    debugAdminId: admin.id,
    ttlSeconds: DEBUG_TTL_SECONDS,
  });

  return json(
    { ok: true, class_id: 0, class_name: '调试模式', debug: true },
    200,
    { 'Set-Cookie': session.setCookie }
  );
}
