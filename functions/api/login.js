import { readJson, error, json, clientIp } from '../../_lib/http.js';
import {
  requireDb, createSession, rateLimit, clearRateLimit,
  classPasswordLookup, authPepper, CLASS_TTL_SECONDS,
  debugLoginEnabled, normalizeRole,
  guestPassword, guestLoginEnabled, GUEST_ROLE, GUEST_CLASS_NAME,
} from '../../_lib/auth.js';
import { parseSecret } from '../../_lib/validate.js';
import { verifyPassword, hashPassword, encryptSecret } from '../../_lib/crypto.js';
import { verifyRecaptcha } from '../../_lib/recaptcha.js';
import { isSeedClassPassword, allowSeedCredentials } from '../../_lib/defaults.js';
import { findUsablePassByLookup, passSessionTtlSeconds, PASS_LABELS } from '../../_lib/passes.js';

/**
 * 班级口令登录。
 *
 * 与旧版的区别：
 *  - 旧版是 SELECT ... WHERE password = ?，明文等值比较。
 *  - 现在库里存的是加盐 PBKDF2 哈希，用 password_lookup 列做索引定位，
 *    再用 PBKDF2 校验；登录成功签发服务端会话，口令不再出现在后续请求里。
 *  - 登录成功后口令会从"明文/弱哈希"自动升级为 PBKDF2 哈希，
 *    因此不需要提前知道现网口令就能完成迁移。
 *
 * 同一个入口还承担几种"非班级"身份（顺序：班级 → 口令凭证 → 环境变量游客 → 调试）：
 *  - 口令凭证：后台「口令管理」生成的测试口令（限时、完整权限，role='test'）
 *    与游客口令（只读，role='guest'），见 _lib/passes.js；
 *  - 游客：配了环境变量 GUEST_PASSWORD 时，它是一条独立口令，
 *    登录后拿到只读会话（role='guest'）。不配就等于这个入口没有。
 *  - 调试：DEBUG_LOGIN=1 且用高级管理员的"账号:密码"。
 */
export async function onRequestPost(context) {
  const { request, env } = context;

  const missing = requireDb(env);
  if (missing) return missing;

  const ip = clientIp(request);

  const parsed = await readJson(request);
  if (!parsed.ok) return error(parsed.error, 400);

  const secret = parseSecret(parsed.value.password, { min: 4, max: 128, field: '班级口令' });
  if (!secret.ok) return error(secret.error, 400);

  // ---- 公开仓库防线：示例班级口令默认拒绝 ----
  //
  // 2026-10-08 补上。这条防线**管理员侧一直有**（admin-login.js 的
  // isSeedAdminPassword），学生侧却是空的 —— `SEED_CLASS_PASSWORD` 在
  // `_lib/defaults.js` 里导出了却全仓库没人用。后果是：跑完迁移之后，
  // 任何知道这个公开仓库的人都能用 `yczx2026` 登录学生端
  // （读榜单、投票、举报、点歌）。**管理员进不去、学生端门户大开**，
  // 这种不对称比"两个都开着"更危险 —— 没人会意识到还要改它。
  //
  // 位置刻意放在**任何数据库查询与限流之前**：被拒的请求一行都不碰库。
  // 开关沿用同一个环境变量（本地测试已统一打开），见 _lib/defaults.js。
  if (isSeedClassPassword(secret.value) && !allowSeedCredentials(env)) {
    return error(
      '这是公开仓库里的示例班级口令，任何人都知道，已被拒绝登录。'
      + '请先按 README 的「部署后必做」把班级口令改成自己的（后台即可改），然后再登录。',
      403
    );
  }

  // ---- 登录限流：口令进 URL 之前就要做，但**必须按"这个口令"分桶** ----
  //
  // 旧写法是 `class-login:${ip}`，10 次/15 分钟 —— 校园网整个学校共用一个出口 IP，
  // 于是只要几个人打错口令，**全校都登不进去**（表现为"刚开学大家都在输口令，
  // 一半人报 429"）。这不是更安全，是把可用性交给了任何一个手滑的人。
  //
  // 现在的分桶键是 `ip + 口令摘要`：
  //   · 同一个口令反复试 → 10 次就 429 —— 这才是暴力破解要防的那件事；
  //   · 不同口令各错一次 → 各算一次，不会互相顶掉（NAT 公平性）；
  //   · 摘要用 authPepper 派生，攻击者无法从 bucket 名反推口令内容。
  // 另外那 40 次/15 分钟的 IP 兜底挡的是"一个出口狂试几百个不同口令"。
  const secretKey = (await classPasswordLookup(env, secret.value)).slice(0, 16);
  const loginBucket = `class-login:${ip}:${secretKey}`;
  const limit = await rateLimit(env, loginBucket, 10, 900);
  if (!limit.allowed) return error('尝试过于频繁，请 15 分钟后再试', 429);

  const ipFlood = await rateLimit(env, `class-login-ip:${ip}`, 40, 900);
  if (!ipFlood.allowed) return error('该网络登录尝试过于频繁，请稍后再试', 429);

  // ---- 人机校验（reCAPTCHA v3，2026-10-07 补） ----
  //
  // 为什么登录也要加：这是**唯一一个不登录就能反复调用、且直接对着口令**的入口，
  // 撞库成本最低。位置刻意放在两道限流**之后**、任何数据库查询**之前**：
  //   · 限流是本地计数，便宜；人机校验要打一次 Google，是网络开销 ——
  //     让限流先挡掉明显的洪水更划算；
  //   · 但必须排在查 classes 表之前，被拒的请求一行都不碰数据库。
  //
  // 默认 RECAPTCHA_STRICT=0：拿不到令牌（校园网挡了 Google、或密钥配错）时**放行**。
  // 也就是说这一条**不会**因为 Google 不可达就把全校挡在登录外面 ——
  // 这一点对登录尤其重要，它是所有功能的入口。
  const human = await verifyRecaptcha(env, parsed.value.recaptcha_token, { ip });
  if (!human.ok) {
    console.warn('[recaptcha] endpoint=login rejected reason=' + String(human.reason || 'verification'));
    return error(human.error, 403);
  }

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

  // 2.4) 口令凭证（后台「口令管理」生成的测试口令 / 游客口令）。
  //
  // 判定顺序仍然是「班级口令优先」：真实班级压过一切临时身份。
  // 凭证按与班级口令同一把 HMAC 做等值定位（O(1)），再查
  // revoked / expires_at —— 已作废或已过期的凭证不命中，
  // 落下去就是普通的"口令错误"，不向外界泄露"这里曾经有过一条口令"。
  //
  // 会话有效期限定在"凭证剩余有效期"之内（passSessionTtlSeconds），
  // 且这类会话不参与滑动续期（见 auth.js）——限时口令到点即停。
  // 测试口令 role='test' 拥有完整投稿与投票权限；游客口令 role='guest'
  // 是只读身份，各写接口里的 denyGuest() 是真正的闸门。
  if (!matched) {
    const pass = await findUsablePassByLookup(env, lookup);
    if (pass) {
      const ttl = passSessionTtlSeconds(pass);
      if (ttl > 0) {
        const role = pass.kind === 'guest' ? GUEST_ROLE : 'test';
        const session = await createSession(env, request, {
          subject: 'class',
          subjectId: 0,
          role,
          ttlSeconds: ttl,
          passId: pass.id,
        });
        await clearRateLimit(env, loginBucket);
        try {
          await env.DB.prepare('UPDATE access_passes SET last_used_at = datetime(\'now\') WHERE id = ?')
            .bind(pass.id).run();
        } catch { /* 记录用不上就不管 */ }

        return json(
          {
            ok: true,
            class_id: 0,
            class_name: PASS_LABELS[pass.kind] || '临时身份',
            guest: pass.kind === 'guest',
            test: pass.kind === 'test',
            role,
          },
          200,
          { 'Set-Cookie': session.setCookie }
        );
      }
    }
  }

  // 2.5) 游客模式（环境变量 GUEST_PASSWORD）。
  //
  // 判定顺序刻意是「班级口令 → 游客口令 → 调试登录」：
  //   · 班级口令优先 —— 真实班级永远压过游客，一个班的口令哪怕和游客口令
  //     写成同一个字串，也仍然按班级身份登录（不会被降级成游客）；
  //   · 游客口令排在调试登录之前，是因为它就是一条**普通口令**，
  //     不该被"账号:密码"的正则再解释一遍（那条路只认管理员表）。
  //
  // 比较方式：两边都过一遍同一把 HMAC（classPasswordLookup），再比摘要。
  // 直接 `===` 比原始口令会泄露长度与前缀信息；比 HMAC 摘要则不会
  // （摘要由私钥派生，攻击者无法从摘要反推口令），与班级口令的查找索引同一套路。
  //
  // 没有配 GUEST_PASSWORD 时这一段整体不成立 —— 游客模式默认关闭。
  if (!matched && guestLoginEnabled(env)) {
    const guestLookup = await classPasswordLookup(env, guestPassword(env));

    if (lookup === guestLookup) {
      // 会话落在**学生**这一侧（subject='class'）：前端整套排行与试听逻辑
      // 都建立在它之上，另起一套 Cookie 只会让每个页面都要分叉。
      // subject_id 用 0 —— 与调试模式同义："不属于任何真实班级"。
      // 真正拦住游客写操作的是各写接口里的 denyGuest()，不是这里的 role 本身。
      const session = await createSession(env, request, {
        subject: 'class',
        subjectId: 0,
        role: GUEST_ROLE,
        ttlSeconds: CLASS_TTL_SECONDS,
      });
      // 登录成功：把这个口令的失败计数清掉（按 (ip, 口令) 分桶，见上面）
      await clearRateLimit(env, loginBucket);

      // guest / role 一并回给前端，让它**立刻**知道要置灰哪些按钮，
      // 不必再多打一次 /api/me。
      return json(
        { ok: true, class_id: 0, class_name: GUEST_CLASS_NAME, guest: true, role: GUEST_ROLE },
        200,
        { 'Set-Cookie': session.setCookie }
      );
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
  await clearRateLimit(env, loginBucket);

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
