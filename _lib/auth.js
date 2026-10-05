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
  rateKey, rateIpKey,
} from './http.js';

/**
 * 会话 Cookie。
 *
 * ⚠️ 学生与管理员**必须用两个不同的 Cookie 名**。
 * 早期版本共用一个 `yczx_session`，结果是同一个浏览器里登录后台会
 * 直接顶掉学生的登录（反之亦然）—— 表现为"用户端点试听提示无权限"，
 * 因为服务端看到的是管理员身份，而试听接口要求学生会话。
 */
export const SESSION_COOKIES = {
  class: 'yczx_class_session',
  admin: 'yczx_admin_session',
};

/** 兼容旧 Cookie 名（仅供清理，不再签发）。 */
export const LEGACY_SESSION_COOKIE = 'yczx_session';

function cookieNameFor(subject) {
  return SESSION_COOKIES[subject] || SESSION_COOKIES.class;
}

/**
 * 班级口令查找索引与密文的私钥。
 *
 * 生产环境请在 Pages → Settings → Environment variables 里配置 AUTH_PEPPER。
 *
 * ⚠️ 审计报告 A2：未配置时会退回下面这个**公开的**占位值。
 *    "口令已加密保存"这句话，只有在 AUTH_PEPPER 是私有值时才成立 ——
 *    否则任何人拿到密文都能解开，加密等于没做。
 *
 * 所以：
 *   · 查找索引 authPepper() 仍然退回默认值 —— 否则没配密钥的部署会直接登不进去，
 *     这是可用性与安全性的取舍，且查找索引本身不还原口令。
 *   · **可查看口令（AES-GCM 解密）功能必须要求真的配了私钥**，
 *     没配就整个禁用（见 admin-settings.js 的 canViewPasswords）。
 */
export const DEFAULT_PEPPER = 'yczx-please-set-AUTH_PEPPER-env-var';
export const PEPPER_IS_DEFAULT = Symbol('default-pepper');

export function authPepper(env) {
  const configured = env && typeof env.AUTH_PEPPER === 'string' ? env.AUTH_PEPPER.trim() : '';
  return configured || DEFAULT_PEPPER;
}

/** 是否真的配置了私有密钥（而不是在用公开占位值）。 */
export function hasPrivatePepper(env) {
  return authPepper(env) !== DEFAULT_PEPPER;
}

/**
 * "列不存在"的两种报错形态。
 *
 * 不同 SQLite 实现说法不一样：
 *   · Cloudflare D1：       no such column: debug_admin_id
 *   · 本机 node:sqlite：    table sessions has no column named debug_admin_id
 * 迁移进度不同的部署要靠这个判断来降级，写窄了就会在本地测试里漏判。
 */
function isMissingColumnError(err) {
  return /no such column|has no column named/i.test(String((err && err.message) || ''));
}

/** "表不存在"（对应某个迁移还没执行）。 */
function isMissingTableError(err) {
  return /no such table/i.test(String((err && err.message) || ''));
}

/** 计算的班级口令查找值。 */
export async function classPasswordLookup(env, password) {
  return hmacHex(authPepper(env), password);
}

/* --------------------- 游客模式（环境变量 GUEST_PASSWORD） --------------------- */

/** 游客在 sessions.role 里的取值。 */
export const GUEST_ROLE = 'guest';
/** 游客在界面上显示的身份名（它不属于任何班级，所以不能拿 classes.name）。 */
export const GUEST_CLASS_NAME = '游客模式';
/** 游客碰写操作时的统一说法；前端置灰的提示文字与它保持一致。 */
export const GUEST_DENY_MESSAGE = '游客模式只能查看排行，不能投稿';

/**
 * 游客口令。
 *
 * 为什么用环境变量而不是往 classes 表里插一行：
 *   游客在业务上根本没有班级归属。一旦混进 classes 表，后台的班级列表、
 *   年级人数汇总、口令批量生成都会多出一个假的"班级"，还可能被管理员
 *   误删或误改；更要紧的是"没配就等于关闭"这条安全默认值就没法落地了
 *   （表里有一行就意味着永久开启）。放在环境变量里，它就是一条**独立口令**：
 *   删掉变量，整个游客模式干净地消失，数据库里一个字节都不留。
 */
export function guestPassword(env) {
  return env && typeof env.GUEST_PASSWORD === 'string' ? env.GUEST_PASSWORD.trim() : '';
}

/**
 * 游客模式是否启用。
 *
 * **默认关闭**：只有真的配了非空 GUEST_PASSWORD 才算启用。
 * 即"忘记配这个变量"的结果是功能不存在，而不是悄悄开了一个只读后门。
 */
export function guestLoginEnabled(env) {
  return guestPassword(env).length > 0;
}

/**
 * 是不是游客会话。
 *
 * 游客复用**学生那一侧**的会话与 Cookie（subject='class'）：前端整套
 * 排行 / 试听 / 设备指纹逻辑都建立在这个会话上，另起一套 Cookie 只会让
 * 每个页面都要分叉。区分身份只靠 role='guest'；subject_id 恒为 0，
 * 语义与调试模式一致 —— "不属于任何真实班级"。
 */
export function isGuestSession(session) {
  return Boolean(session)
    && session.subject === 'class'
    && String(session.role || '').toLowerCase() === GUEST_ROLE;
}

/**
 * 写接口的游客闸门。
 *
 * 用途：在 vote / upvote / report / suggest 等写接口里，紧跟 requireSession
 * 之后调用。**是游客就返回 403 响应，不是游客返回 null。**
 *
 * 为什么必须放在服务端、而且放在最前面：
 *   前端置灰只是体验，任何人都能直接 curl 这些接口。所以写接口必须自己拦；
 *   放在读取请求体、限流计数与任何 INSERT 之前，是为了让被拒的请求
 *   **连副作用都不产生**（不占限流额度、不留数据库痕迹），测试也据此断言。
 *
 * @param {object|null} session readSession/requireSession 拿到的会话行
 * @param {string} [message] 给游客看的中文提示
 * @returns {Response|null} 403 响应，或 null（放行）
 */
export function denyGuest(session, message = GUEST_DENY_MESSAGE) {
  if (!isGuestSession(session)) return null;
  return error(message, 403);
}

/**
 * 调试登录（在学生端口令框里输入「管理员账号:密码」）的服务端开关。
 *
 * 审计报告 A5：原实现**任何时候都生效**，等于生产环境一直开着一个
 * "拿管理员密码就能在学生端无限点歌、而且跳过每周额度与查重"的后门。
 *
 * 这里改成**默认关闭**：只有显式设置 DEBUG_LOGIN=1
 * （也接受 true / yes / on）才启用，生产环境什么都不用配就是关的。
 * 即"忘记配置"的结果是安全的那一侧，而不是相反。
 */
export function debugLoginEnabled(env) {
  const raw = String((env && env.DEBUG_LOGIN) || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/**
 * 会话有效期。
 *
 * 管理员：12 小时。后台是"做事的地方"，权限大，短一点更安全。
 *
 * 学生：**1 天，且每次打开页面自动续期**（滑动窗口，见 refreshSessionOnUse）。
 *   语义要分清楚 ——
 *     · **班级口令**：长期留存，除非管理员在后台显式删除，否则永不主动清除
 *       （库里没有任何地方会删 classes 行，只有 UPDATE 改口令）。
 *     · **设备上的会话**：只留 1 天。一天没打开过网页就要重新输口令；
 *       只要这天里打开过，就自动续到"再往后 1 天"。
 *   为什么是 1 天：学生一周来点一两次歌，会话太长等于口令长期挂在设备上；
 *   太短又天天要输口令。1 天 + 滑动续期正好是"常用的人不用重输，
 *   长期不用的设备自动失效"。
 */
export const ADMIN_TTL_SECONDS = 12 * 60 * 60;
export const CLASS_TTL_SECONDS = 24 * 60 * 60;

/**
 * 续期节流：同一会话**每小时最多续一次**。
 *
 * 为什么需要节流：续期是一次 UPDATE。学生一分钟里翻五个页面就写五次库，
 * 而 Cloudflare 免费套餐的 CPU/写入额度是有限的 —— 用不必要的写入换来的
 * "更精确的过期时间"没有任何收益（反正都要等一天才过期）。
 * 1 小时的粒度意味着：会话实际有效期在 24~25 小时之间，体感上没差别。
 */
const SESSION_REFRESH_INTERVAL_SECONDS = 60 * 60;

/** D1 绑定缺失时给出明确错误，而不是让异常冒泡成 500 堆栈。 */
export function requireDb(env) {
  if (!env || !env.DB) {
    return error('服务端数据库未绑定（缺少 D1 绑定 DB）', 500);
  }
  return null;
}

/** 取出候选令牌：Authorization 头优先，其次是对应身份的 Cookie。 */
function presentedTokens(request, subject) {
  const out = [];

  const auth = request.headers.get('Authorization') || '';
  if (auth.startsWith('Bearer ')) {
    const token = auth.slice(7).trim();
    if (token) out.push(token);
  }

  const cookies = parseCookies(request);
  if (subject) {
    const value = cookies[cookieNameFor(subject)];
    if (value) out.push(value);
  } else {
    // 不限身份时两种都看，学生会话优先
    for (const name of [SESSION_COOKIES.class, SESSION_COOKIES.admin]) {
      if (cookies[name]) out.push(cookies[name]);
    }
  }

  return out;
}

/**
 * 建立会话。
 *
 * debugAdminId：调试会话（subject='class' 且 role='debug'）专用 ——
 * 记录"这个调试身份是从哪个管理员账号换来的"。审计报告 A5 指出，
 * 原实现把 subject_id 写成 0、也不记管理员 ID，导致管理员改密 / 删号 /
 * 登出时**没有任何办法找出并撤销**这些调试会话。落库之后，
 * revokeDebugSessions() 才能按管理员 ID 一次性清干净。
 *
 * @returns {Promise<{token: string, maxAge: number, setCookie: string}>}
 */
export async function createSession(
  env, request, { subject, subjectId, role = null, ttlSeconds, debugAdminId = null }
) {
  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const expiresAt = `+${Math.floor(ttlSeconds)} seconds`;

  // 只有真的建立调试会话时才写 debug_admin_id，普通会话的 INSERT 保持原样。
  if (debugAdminId === null || debugAdminId === undefined) {
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
      expiresAt
    ).run();
  } else {
    try {
      await env.DB.prepare(
        `INSERT INTO sessions (token_hash, subject, subject_id, role, debug_admin_id, ip, user_agent, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', ?))`
      ).bind(
        tokenHash,
        subject,
        subjectId,
        role,
        debugAdminId,
        clientIp(request),
        header(request, 'User-Agent', 300),
        expiresAt
      ).run();
    } catch (err) {
      // 013 迁移还没执行（sessions 里没有 debug_admin_id 列）：
      // 退回老写法。少记一个 ID 只是"撤销不精确"，总比让人连调试都进不去好；
      // 真正要紧的开关是 debugLoginEnabled()，那个不受这里影响。
      if (!isMissingColumnError(err)) throw err;
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
        expiresAt
      ).run();
    }
  }

  // 顺手清理过期会话，避免表无限增长（失败不影响登录）。
  try {
    await env.DB.prepare(
      `DELETE FROM sessions WHERE datetime(expires_at) <= datetime('now')`
    ).run();
  } catch { /* 清理是尽力而为 */ }

  return {
    token,
    maxAge: ttlSeconds,
    setCookie: serializeCookie(cookieNameFor(subject), token, {
      maxAge: ttlSeconds,
      secure: isSecureRequest(request),
      httpOnly: true,
      sameSite: 'Lax',
    }),
  };
}

/**
 * 读取当前会话，无效/过期返回 null。
 *
 * 返回行的字段：id / subject / subject_id / role / expires_at，
 * 以及 013 之后才有的 debug_admin_id（调试会话的归属管理员）。
 *
 * 顺带做**滑动续期**：只要这次请求带着有效会话，就把过期时间推到"从现在起
 * 再一个完整有效期"（见 refreshSessionOnUse）。所以"学生只在打开网页时被续期"
 * 这件事不需要前端做任何事 —— 页面一打开就会请求 /api/rank 或 /api/me，
 * 那两次请求就会把会话续上。
 */
export async function readSession(env, request, subject = null) {
  const tokens = presentedTokens(request, subject);
  if (!tokens.length) return null;

  try {
    for (const token of tokens) {
      const tokenHash = await sha256Hex(token);
      let row;
      try {
        row = await env.DB.prepare(
          `SELECT id, subject, subject_id, role, debug_admin_id, expires_at, user_agent
             FROM sessions
            WHERE token_hash = ? AND datetime(expires_at) > datetime('now')`
        ).bind(tokenHash).first();
      } catch (err) {
        // 013 迁移还没执行（没有 debug_admin_id 列）：退回旧查询，
        // 让迁移进度不同的部署都还能正常登录。
        if (!isMissingColumnError(err)) throw err;
        row = await env.DB.prepare(
          `SELECT id, subject, subject_id, role, expires_at, user_agent
             FROM sessions
            WHERE token_hash = ? AND datetime(expires_at) > datetime('now')`
        ).bind(tokenHash).first();
      }
      if (!row) continue;

      // 审计报告 A5：调试会话是"借用管理员密码换来的"。如果那个管理员
      // 账号已经被删掉，这个调试会话就没有归属了 —— 直接当作无效并清掉，
      // 不让它继续以调试身份点歌。查不到表（尚未迁移）时按原样放行，
      // 这只是一层补充防线，不是主防线。
      if (isDebugSession(row)) {
        const ownerId = debugAdminIdOf(row);
        if (ownerId) {
          try {
            const owner = await env.DB.prepare('SELECT id FROM admins WHERE id = ?')
              .bind(ownerId).first();
            if (!owner) {
              await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(row.id).run();
              continue;
            }
          } catch { /* admins 表不存在等异常：忽略这层检查 */ }
        }
      }

      await refreshSessionOnUse(env, row);
      return row;
    }
    return null;
  } catch (err) {
    // 迁移没跑的时候 sessions 表不存在。这是交接场景下最容易踩的坑，
    // 单独识别出来给一句人能看懂的提示，而不是抛 500 堆栈。
    if (isMissingTableError(err)) {
      const wrapped = new Error('数据库尚未执行安全升级迁移');
      wrapped.migrationRequired = true;
      throw wrapped;
    }
    throw err;
  }
}

/**
 * 从 sessions.user_agent 里读出"最近一次活动时间"。
 *
 * 为什么借用这一列：续期需要知道"上次续期是什么时候"才能节流，否则每个请求
 * 都要写一次库。而新增一列意味着**必须有新迁移**，可已有站点按增量补丁的习惯
 * 是"只覆盖文件、不跑 SQL" —— 那样这列不存在，节流就会静默失效
 *（表现为每请求一次写一次库，正是我们要避免的）。
 *
 * sessions.user_agent 在全项目里**只写不读**（没有任何查询或界面用到它），
 * 所以把"设备信息 + 最近活动时间"一起放进去是安全的：
 *   · 设备信息保留（出问题时还能看是谁的会话）；
 *   · 不引入任何迁移，部署零风险。
 * 格式：`<原始 UA>‖<ISO 时间>`；没有时间戳时返回 null（表示"从没续过"）。
 */
const SESSION_SEEN_SEP = '‖';

function lastSeenAtOf(session) {
  const raw = String((session && session.user_agent) || '');
  const at = raw.lastIndexOf(SESSION_SEEN_SEP);
  if (at < 0) return null;
  const stamp = raw.slice(at + SESSION_SEEN_SEP.length).trim();
  return /^\d{4}-\d{2}-\d{2}T/.test(stamp) ? stamp : null;
}

/** 把"设备信息 + 最近活动时间"重新拼回去。 */
function withLastSeen(userAgent, isoNow) {
  const raw = String(userAgent || '');
  const at = raw.lastIndexOf(SESSION_SEEN_SEP);
  const device = at >= 0 ? raw.slice(0, at) : raw;
  return `${device.slice(0, 200)}${SESSION_SEEN_SEP}${isoNow}`;
}

/**
 * 滑动续期：会话被用到时，把过期时间推到"从现在起再一个完整有效期"。
 *
 * 需求原话是「会话在设备上的留存时间为一天，在再次打开网页时刷新」——
 * 这里就是那句话的服务端实现：
 *   · 打开页面 → 前端必然发一次 /api/rank 或 /api/me → readSession → 这里续期；
 *   · 一天没打开 → 会话自然过期（查询条件 datetime(expires_at) > now 不成立），
 *     下次进来要重新输口令。
 *
 * 三个刻意的设计：
 *   1. **节流**：同一会话每小时最多写一次（SESSION_REFRESH_INTERVAL_SECONDS）。
 *      续期是一次 UPDATE；一分钟里翻五个页面写五次库毫无收益，
 *      而免费套餐的写入额度要留给真正要做的事。
 *   2. **只续不缩**：新过期时间取 MAX(原过期时间, now + 有效期)。
 *      即使遇到时钟抖动或并发，也绝不会缩短会话 —— "把人踢下线"
 *      不该由一次续期逻辑顺手做掉。
 *   3. **失败一律忽略**：续期是体验优化，它失败不该让正常请求失败。
 *      会话是否有效最终由那次查询的 expires_at > now 决定，不依赖这里。
 */
async function refreshSessionOnUse(env, row) {
  const id = Number(row && row.id);
  if (!Number.isInteger(id) || id <= 0) return;

  // 节流：距上次续期不到一小时就什么都不做（连库都不碰）
  const lastSeen = lastSeenAtOf(row);
  if (lastSeen) {
    const ageSeconds = (Date.now() - Date.parse(lastSeen)) / 1000;
    if (Number.isFinite(ageSeconds) && ageSeconds < SESSION_REFRESH_INTERVAL_SECONDS) return;
  }

  try {
    const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, '');
    await env.DB.prepare(
      `UPDATE sessions
          SET expires_at = datetime(
                MAX(datetime(expires_at), datetime('now', '+${CLASS_TTL_SECONDS} seconds'))
              ),
              user_agent = ?
        WHERE id = ?
          AND datetime(expires_at) > datetime('now')`
    ).bind(withLastSeen(row.user_agent, nowIso), id).run();
  } catch {
    /* 见函数说明：续期失败不影响本次请求 */
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
    session = await readSession(env, request, subject);
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

/**
 * 角色归一化。
 *
 * 历史背景：旧系统的 admins.role 可能是空的，那个年代只有一个管理员、
 * 权限是全部，所以早期实现把空值当成高级管理员。
 *
 * 但"不确定时给最高权限"违反默认拒绝原则（审计报告 A3），
 * 所以现在**空值和无法识别的值一律按最低权限（普通管理员）处理**。
 * 历史空角色请执行 sql/013_debug_login_hardening.sql 一次性补齐。
 */
export function normalizeRole(role) {
  const value = String(role ?? '').trim().toLowerCase();
  if (value === 'super') return 'super';
  return 'admin';                     // 空值 / admin / 任何无法识别的值
}

/** 管理员接口专用：要求是管理员会话，并且（可选）满足角色要求。 */
export async function requireAdmin(env, request, allowedRoles = null) {
  const result = await requireSession(env, request, 'admin');
  if (!result.ok) return result;

  // 角色以数据库**当前**值为准，而不是登录那一刻缓存在会话里的值。
  // 否则给账号补上角色之后，旧会话仍按老角色判断 ——
  // 这正是"高级管理员发公告却报无权限"的原因。
  //
  // 但要看清楚两种"查不到"的区别（审计报告 A3）：
  //   · 账号已不存在  → 必须**拒绝**。删除账号与撤销会话是两步，
  //                     如果撤销失败，这里继续放行就等于留了一个后门。
  //   · 查询本身报错  → 也必须**拒绝**，不能拿缓存里的旧角色接着用。
  const row = await env.DB.prepare('SELECT role FROM admins WHERE id = ?')
    .bind(result.session.subject_id).first();

  if (!row) {
    await revokeSession(env, request, 'admin').catch(() => {});
    // 审计报告 A5：账号没了，它换出去的调试会话也一并清掉。
    // 删除账号（admin-accounts.js）只撤 subject='admin' 的会话，
    // 这里补上调试会话这一半，避免"删了账号、学生端还能无限点歌"。
    await revokeDebugSessions(env, result.session.subject_id).catch(() => {});
    return { ok: false, response: error('账号已失效，请重新登录', 401) };
  }

  const role = normalizeRole(row.role);
  result.session.role = role;

  if (allowedRoles && !allowedRoles.includes(role)) {
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

/** 撤销会话（退出登录）。subject 为 null 时把两种身份的令牌都撤销。 */
export async function revokeSession(env, request, subject = null) {
  for (const token of presentedTokens(request, subject)) {
    const tokenHash = await sha256Hex(token);
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
  }
}

/* --------------------- 调试会话（审计报告 A5） --------------------- */

/**
 * 是不是"调试会话"。
 *
 * 调试会话沿用 class 这一侧（学生端 Cookie），但 role 写 'debug'，subject_id=0。
 * 这里**只看 role**：vote.js / rank.js 判断调试身份用的就是 role === 'debug'，
 * 所以绝不能把管理员 ID 编码进 role（那会把两个文件一起弄坏）。
 * 归属管理员另存 sessions.debug_admin_id（见 sql/013）。
 */
export function isDebugSession(session) {
  return Boolean(session)
    && session.subject === 'class'
    && String(session.role || '').toLowerCase() === 'debug';
}

/**
 * 取调试会话的归属管理员 ID。
 *
 * 013 之前建的会话没有 debug_admin_id 列，退回从 role 里解析
 * （兼容早期可能写成 "debug:12" 的历史数据）；两者都没有就返回 null。
 */
export function debugAdminIdOf(session) {
  if (!session) return null;

  const explicit = Number(session.debug_admin_id);
  if (Number.isInteger(explicit) && explicit > 0) return explicit;

  const match = /^debug:(\d+)$/.exec(String(session.role || '').trim());
  return match ? Number(match[1]) : null;
}

/**
 * 撤销某个管理员名下的**全部调试会话**。
 *
 * 用途：管理员改密 / 删号 / 登出时，那些用他的密码在学生会话里换来的
 * "调试身份"必须跟着失效 —— 否则改完密码，旧调试会话还能继续无限点歌。
 *
 * @param {object} env
 * @param {number} adminId 归属管理员 ID
 * @param {{exceptSessionId?: number}} [opts] 保留某条会话（改密时保留当前会话）
 */
export async function revokeDebugSessions(env, adminId, { exceptSessionId = null } = {}) {
  const id = Number(adminId);
  if (!Number.isInteger(id) || id <= 0) return 0;

  const keep = Number.isInteger(Number(exceptSessionId)) && Number(exceptSessionId) > 0
    ? Number(exceptSessionId)
    : null;
  const keepClause = keep === null ? '' : ' AND id <> ?';

  // 013 之后：按归属列精确匹配。
  try {
    const stmt = env.DB.prepare(
      `DELETE FROM sessions WHERE debug_admin_id = ?${keepClause}`
    );
    const result = keep === null
      ? await stmt.bind(id).run()
      : await stmt.bind(id, keep).run();
    return Number((result && result.meta && result.meta.changes) || 0);
  } catch (err) {
    // 013 还没执行（没有 debug_admin_id 列）：退回按 role 文本匹配，
    // 至少能清掉"写死在 role 里"的那部分，而不是整个功能报错。
    if (!isMissingColumnError(err)) throw err;
  }

  try {
    const stmt = env.DB.prepare(
      `DELETE FROM sessions WHERE subject = 'class' AND role = ?${keepClause}`
    );
    const result = keep === null
      ? await stmt.bind(`debug:${id}`).run()
      : await stmt.bind(`debug:${id}`, keep).run();
    return Number((result && result.meta && result.meta.changes) || 0);
  } catch (err) {
    if (isMissingTableError(err)) return 0;
    throw err;
  }
}

/**
 * 撤销**当前请求所携带的那一条**调试会话。
 *
 * 登出时用：学生端的退出登录清的是 class 这个 Cookie，
 * 顺手把这条调试会话也删掉，避免"点了退出、服务端还留着 2 小时的调试身份"。
 *
 * @returns {Promise<object|null>} 被删掉的那条会话（没有则 null）
 */
export async function revokeCurrentDebugSession(env, request) {
  let session;
  try {
    session = await readSession(env, request, 'class');
  } catch {
    return null;                  // 会话表都还没有，谈不上撤销
  }
  if (!isDebugSession(session)) return null;

  try {
    await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(session.id).run();
  } catch (err) {
    if (isMissingTableError(err)) return session;
    throw err;
  }

  // 有归属管理员的话，把他名下其它调试会话一起清掉（同一管理员可能开了多个设备）。
  const adminId = debugAdminIdOf(session);
  if (adminId) await revokeDebugSessions(env, adminId).catch(() => {});

  return session;
}

/** 清空 Cookie 的头：两种身份 + 旧名字一起清，避免残留。 */
export function clearSessionCookies(request) {
  const secure = isSecureRequest(request);
  return [SESSION_COOKIES.class, SESSION_COOKIES.admin, LEGACY_SESSION_COOKIE]
    .map((name) => serializeCookie(name, '', {
      maxAge: 0,
      secure,
      httpOnly: true,
      sameSite: 'Lax',
    }));
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

/**
 * 当前时间落在第几个窗口（从纪元起算的窗口序号）。
 *
 * 把窗口编号写进 bucket 名里，是为了让"同一实体在不同窗口"天然是
 * 两条不同的记录：旧窗口的行不会被新窗口读到，于是不需要定时清理，
 * 也不会出现"上一小时用满、这一小时刚开头就被算成已用满"的错判。
 * （固定窗口限流用 datetime 比较来做同样的事，但它必须先 INSERT
 * 再 UPDATE，没法用"是否插入成功"判断第一次。）
 */
function timeBucket(windowSeconds, now = Date.now()) {
  const size = Math.max(1, Math.floor(windowSeconds));
  return Math.floor(now / 1000 / size);
}

/**
 * 「同一件事只计一次」的限流。
 *
 * 与 rateLimit 的区别：那条把**每一次调用**都算一个额度，这条只在
 * 同一个 bucket + item 组合**本窗口内第一次**出现时才计数。
 *
 * 用途（审计 C6）：音频是分段拉取的 —— 放一首歌浏览器会发十几个
 * Range 请求，还可能因为拖动进度条再发一批。它们属于**同一次人工试听**，
 * 按"每次请求一个额度"计会让正常使用凭空放大十几倍，把整个出口 IP
 * 的额度吃光。这里把 (会话, 音源 id) 在本窗口内折叠成一次。
 *
 * 实现要点：bucket 里带上时间桶编号（见 timeBucket），旧窗口的行
 * 自然就是另一条记录，不需要清理也不会互相干扰 —— 所以这里可以放心
 * 用 INSERT OR IGNORE + meta.changes 判断"是不是第一次"。
 *
 * @returns {Promise<{first: boolean, allowed: boolean, count: number}>}
 */
export async function rateLimitOnce(env, bucket, item, limit, windowSeconds) {
  const key = `${bucket}|${item}|${timeBucket(windowSeconds)}`;
  try {
    const inserted = await env.DB.prepare(
      'INSERT OR IGNORE INTO rate_limits (bucket, count, window_start) VALUES (?, 1, datetime(\'now\'))'
    ).bind(key).run();

    // 插进去了就是本窗口第一次
    if (Number((inserted && inserted.meta && inserted.meta.changes) || 0) > 0) {
      return { first: true, allowed: true, count: 1 };
    }

    const row = await env.DB.prepare('SELECT count FROM rate_limits WHERE bucket = ?')
      .bind(key).first();
    const count = row ? Number(row.count) : 1;
    return { first: false, allowed: count <= limit, count };
  } catch {
    // 限流表不可用时放行 —— 和 rateLimit 一样，不能因为限流表挂了就让人用不了。
    return { first: true, allowed: true, count: 0 };
  }
}

/**
 * 粗粒度的"全站资源预算"计数器。
 *
 * 用途（审计 C6）：细粒度配额管的是"每个会话能搜多少次"，
 * 但整个站点（Cloudflare 免费额度、上游音源）也需要一层总量保护 ——
 * 比如有人用脚本开几百个会话轮流刷。这里按小时统计全站调用次数。
 * 只做加法，不关心是谁，所以一次 UPDATE 就够。
 */
export async function countBudget(env, name, windowSeconds) {
  const key = `budget:${name}|${timeBucket(windowSeconds)}`;
  try {
    await env.DB.prepare(
      `INSERT INTO rate_limits (bucket, count, window_start)
       VALUES (?, 1, datetime('now'))
       ON CONFLICT(bucket) DO UPDATE SET count = count + 1`
    ).bind(key).run();
    const row = await env.DB.prepare('SELECT count FROM rate_limits WHERE bucket = ?')
      .bind(key).first();
    return row ? Number(row.count) : 1;
  } catch {
    return 0;                      // 取不到就不拦（限流表不可用时不该让业务挂掉）
  }
}

/** 登录成功后清掉失败计数。 */
export async function clearRateLimit(env, bucket) {
  try {
    await env.DB.prepare('DELETE FROM rate_limits WHERE bucket = ?').bind(bucket).run();
  } catch { /* 尽力而为 */ }
}

/**
 * 写接口的统一限流闸门：**按身份**限额 + **按 IP** 一道宽松兜底。
 *
 * 为什么要有这一层（本轮修的问题）：
 *   原来 vote / upvote / report / music 都写成 `rateLimit(env, 'vote:' + ip, 30, 3600)` ——
 *   校园网共用出口 IP，于是全校共用 30 次额度。一个人（或一个脚本）把额度打满，
 *   正常学生全部收到 429。按 IP 限流在这里不是安全，是把可用性交给了攻击者。
 *
 * 两道限流的分工：
 *   · 身份额度（identKey）：这是**公平**用的 —— 每台设备/每一条会话各有一份，
 *     别人刷不爆你的额度。客户端能伪造身份键，所以它**不是**防滥用的硬边界。
 *   · IP 兜底（rateKey 里的 ip 那一道）：这才是**防滥用**用的 —— 阈值放得很宽，
 *     只挡"一个出口的脚本疯狂刷"，正常一个班甚至一个年级都不会碰到。
 *   两道都超了才拒绝：任何一道还有余量就放行。
 *
 * @param {object} env
 * @param {Request} request
 * @param {{kind: string, limit: number, windowSeconds: number, ipLimit?: number,
 *          fingerprint?: string, clientId?: string, session?: object, message?: string}} opts
 * @returns {Promise<Response|null>} 429 响应，或 null（放行）
 */
export async function guardRate(env, request, opts) {
  const {
    kind, limit, windowSeconds,
    ipLimit = Math.max(limit * 8, 600),
    fingerprint, clientId, session,
    message = '操作过于频繁，请稍后再试',
  } = opts;

  const identityBucket = rateKey(request, { kind, fingerprint, clientId, session });
  const identity = await rateLimit(env, identityBucket, limit, windowSeconds);

  // IP 兜底只在身份额度已经用完时才查 —— 省一次数据库往返（免费套餐 CPU 预算有限）。
  // 代价是"身份额度够用时完全不看 IP"，这正是我们想要的：正常流量永不触碰兜底阈值。
  if (identity.allowed) return null;

  const ipBucket = rateIpKey(request, kind);
  if (ipBucket === identityBucket) {
    // 连身份都没有（既无指纹也无会话），已经退化成按 IP —— 不必再查一遍。
    return error(message, 429);
  }

  const backstop = await rateLimit(env, ipBucket, ipLimit, windowSeconds);
  if (backstop.allowed) return null;
  return error(message, 429);
}
