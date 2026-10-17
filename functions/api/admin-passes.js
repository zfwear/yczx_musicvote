import { readJson, error, json } from '../../_lib/http.js';
import {
  requireStaff, revokeSessionsByPass, revokeSessionsByPersonalPass, authPepper, hasPrivatePepper,
} from '../../_lib/auth.js';
import { parsePositiveInt, sanitizeText } from '../../_lib/validate.js';
import { hashPassword, encryptSecret, decryptSecret } from '../../_lib/crypto.js';
import { changedRows } from '../../_lib/db.js';
import { classPasswordLookup } from '../../_lib/auth.js';
import { generatePassToken, PASS_KINDS } from '../../_lib/passes.js';
import {
  PERSONAL_USERNAME_RE, createPersonalPass, deletePersonalPass, rebindPersonalPass,
} from '../../_lib/personal.js';

/**
 * 口令凭证管理（测试口令 / 游客口令）。
 *
 * 2026-10-10 需求：游客口令原先只有环境变量 GUEST_PASSWORD 一条，
 * 后台没有任何生成入口；再加上要发放"带计时期限的测试口令"，
 * 口令种类多了，管理从「系统设置」里拆出来，单独成页。
 *
 * GET  —— 列出全部凭证（配了私有 AUTH_PEPPER 时附明文，便于再次分发）
 * POST —— create / revoke / delete
 *
 * 权限：requireStaff（普通管理员及以上）。发放临时口令是广播站的日常工作，
 * 不需要高级管理员亲自操作；班级口令那套 super 限制保持不变。
 */

/** 生成凭证时最多重试几次撞唯一索引（12 位随机码撞上的概率约等于零）。 */
const MAX_INSERT_RETRY = 3;
const MAX_EXPIRES_DAYS = 3650;

export async function onRequestGet(context) {
  const { request, env } = context;

  const auth = await requireStaff(env, request);
  if (!auth.ok) return auth.response;

  const canView = hasPrivatePepper(env);
  const pepper = authPepper(env);
  const isSuper = auth.session.role === 'super';

  let rows;
  try {
    ({ results: rows } = await env.DB.prepare(
      `SELECT id, kind, label, expires_at, revoked, created_at, last_used_at, token_encrypted
         FROM access_passes
        ORDER BY id DESC
        LIMIT 500`
    ).all());
  } catch (err) {
    if (/no such table/i.test(String((err && err.message) || ''))) {
      return error('数据库尚未执行 015 迁移（缺少 access_passes 表），请先执行 sql/015_access_passes_and_limits.sql', 500);
    }
    throw err;
  }

  const passes = [];
  for (const row of rows || []) {
    const item = {
      id: row.id,
      kind: row.kind,
      label: row.label || '',
      expires_at: row.expires_at || null,
      revoked: Number(row.revoked) === 1,
      created_at: row.created_at,
      last_used_at: row.last_used_at || null,
    };
    // 明文只有在配了私有密钥时才解得开也才发得出去 —— 与班级口令同一政策。
    if (canView && row.token_encrypted) {
      item.token = await decryptSecret(pepper, row.token_encrypted);
    }
    passes.push(item);
  }

  // ---- 个人口令（MD3 项目）：绑定班级 + 管理员录入的用户名 ----
  //
  // 前缀 =「班级当前口令」的明文（只在配了私有 AUTH_PEPPER 时解得开，与
  // 测试/游客口令同一政策）；解不开就只显示班级名，前端把复制按钮藏起来。
  // personalReady=false 表示 016 迁移未执行 —— 前端提示"先执行迁移"。
  let personalPasses = [];
  let classes = [];
  let personalReady = true;
  let personalForbidden = false;
  if (!isSuper) {
    // 年级名单是敏感数据（2026-10-17 用户强调）：普通管理员可以管理
    // 测试/游客口令，但看不到个人口令的用户名，也拿不到班级人员名单。
    personalForbidden = true;
  } else {
    try {
      const { results: prows } = await env.DB.prepare(
        `SELECT p.id, p.class_id, p.username, p.created_at,
                c.name AS class_name, c.password_encrypted AS class_enc
           FROM personal_passes p LEFT JOIN classes c ON c.id = p.class_id
          ORDER BY p.id DESC LIMIT 500`
      ).all();
      for (const row of prows || []) {
        let prefix = null;
        if (canView && row.class_enc) {
          try { prefix = await decryptSecret(pepper, row.class_enc); } catch { prefix = null; }
        }
        personalPasses.push({
          id: row.id,
          class_id: Number(row.class_id) || 0,
          class_name: row.class_name || null,
          username: row.username,
          created_at: row.created_at,
          prefix,
          unbound: Number(row.class_id) <= 0,
        });
      }
      const { results: cls } = await env.DB.prepare('SELECT id, name, password_encrypted FROM classes ORDER BY id').all();
      for (const c of cls || []) {
        let pw = null;
        if (canView && c.password_encrypted) {
          try { pw = await decryptSecret(pepper, c.password_encrypted); } catch { pw = null; }
        }
        classes.push({ id: c.id, name: c.name, password: pw });
      }
    } catch (err) {
      if (/no such table/i.test(String((err && err.message) || ''))) {
        personalReady = false;      // 016 未执行：个人口令功能整体不可用
      } else {
        throw err;
      }
    }
  }

  return json({
    ok: true, canView, passes,
    personalPasses, classes, personalReady, personalForbidden,
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const auth = await requireStaff(env, request);
  if (!auth.ok) return auth.response;

  const parsed = await readJson(request);
  if (!parsed.ok) return error(parsed.error, 400);
  const data = parsed.value;

  // 年级名单是敏感数据：普通管理员可以发放测试/游客口令，但不能新增、
  // 删除、重新绑定个人口令（那等于间接改写年级名单）。
  const personalAction = ['create_personal', 'delete_personal', 'rebind_personal'].includes(String(data.action || ''));
  if (personalAction && auth.session.role !== 'super') {
    return error('个人口令管理仅高级管理员可用', 403);
  }

  try {
    if (data.action === 'create') return await createPass(env, data);
    if (data.action === 'revoke') return await revokePass(env, data);
    if (data.action === 'delete') return await deletePass(env, data);
    if (data.action === 'create_personal') return await createPersonal(env, data);
    if (data.action === 'delete_personal') return await deletePersonal(env, data);
    if (data.action === 'rebind_personal') return await rebindPersonal(env, data);
    return error('未知操作', 400);
  } catch (err) {
    if (/no such table/i.test(String((err && err.message) || ''))) {
      if (/personal/i.test(String((err && err.message) || ''))) {
        return error('数据库尚未执行 016 迁移（缺少个人口令表），请先执行 sql/016_personal_passes.sql', 500);
      }
      return error('数据库尚未执行 015 迁移（缺少 access_passes 表），请先执行 sql/015_access_passes_and_limits.sql', 500);
    }
    throw err;
  }
}

async function createPass(env, data) {
  const kind = String(data.kind || '').trim();
  if (!PASS_KINDS.includes(kind)) return error('口令类型只能是 test（测试口令）或 guest（游客口令）', 400);

  let label = '';
  if (typeof data.label === 'string' && data.label.trim()) {
    const parsed = sanitizeText(data.label, { maxLength: 40, field: '备注' });
    if (!parsed.ok) return error(parsed.error, 400);
    label = parsed.value;
  }

  // 自定义口令（2026-10-12 用户要求"口令可自定义"）：给了就用管理员指定的
  // 字符串，不给则随机生成。字符集刻意收窄为字母/数字/短横线/下划线（6~32 位）
  // —— 口令要学生自己在登录框手打，太怪或太长都发不出去；区分大小写。
  // 与班级口令分属两张表：就算自定义口令恰好和某个班级口令相同，登录时
  // 也只会先命中班级口令那一个身份，不会串权限。
  let customToken = null;
  if (typeof data.token === 'string' && data.token.trim()) {
    const value = data.token.trim();
    if (!/^[A-Za-z0-9_-]{6,32}$/.test(value)) {
      return error('自定义口令需要是 6 到 32 位的字母、数字、短横线或下划线', 400);
    }
    customToken = value;
  }

  // 有效期：空 = 长期有效；给了就是 1 ~ 3650 天。
  // 测试口令前端默认填 7 天；这里不强制 —— 长期测试口令是管理员的自由。
  let expiresAt = null;
  const rawDays = data.expires_days;
  if (rawDays !== '' && rawDays !== null && rawDays !== undefined) {
    const days = Number(rawDays);
    if (!Number.isInteger(days) || days < 1 || days > MAX_EXPIRES_DAYS) {
      return error(`有效天数需要是 1 到 ${MAX_EXPIRES_DAYS} 之间的整数，留空表示长期有效`, 400);
    }
    const row = await env.DB.prepare(
      `SELECT datetime('now', ?) AS at`
    ).bind(`+${days} days`).first();
    expiresAt = row && row.at ? String(row.at) : null;
  }

  // 生成 → 哈希 → 入库。查找索引是唯一索引：万一随机码撞上已有口令
  // （概率约等于零）就换一个再试，而不是把"内部错误"甩给管理员。
  // 自定义口令撞上时**不能**偷偷换码 —— 那是管理员点名要的字符串，
  // 必须原样告诉他"已被占用，换一个"。
  let lastErr = null;
  for (let attempt = 0; attempt < MAX_INSERT_RETRY; attempt++) {
    const token = customToken || generatePassToken();
    const lookup = await classPasswordLookup(env, token);
    const hashed = await hashPassword(token);
    const encrypted = await encryptSecret(authPepper(env), token);

    try {
      await env.DB.prepare(
        `INSERT INTO access_passes (kind, label, token_hash, token_lookup, token_encrypted, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(kind, label, hashed, lookup, encrypted, expiresAt).run();

      // 回读 id：前端生成后立即可作废/删除，不必先刷新列表
      const inserted = await env.DB.prepare(
        'SELECT id FROM access_passes WHERE token_lookup = ?'
      ).bind(lookup).first();

      return json({
        ok: true,
        id: inserted ? inserted.id : null,
        kind,
        label,
        expires_at: expiresAt,
        token,
        message: (kind === 'test' ? '测试口令' : '游客口令') + '已生成，请立即复制保存。',
      });
    } catch (err) {
      if (!/unique|constraint/i.test(String((err && err.message) || ''))) throw err;
      if (customToken) {
        return error('这个自定义口令已被占用，请换一个再试', 409);
      }
      lastErr = err;
    }
  }
  throw lastErr || new Error('生成失败');
}

/** 作废：凭证立即可用性归零，并用 sessions.pass_id 精确撤销它签发过的会话。 */
async function revokePass(env, data) {
  const id = parsePositiveInt(data.id, { field: '凭证' });
  if (!id.ok) return error(id.error, 400);

  const result = await env.DB.prepare(
    'UPDATE access_passes SET revoked = 1 WHERE id = ?'
  ).bind(id.value).run();
  if (changedRows(result) === 0) return error('凭证不存在', 404);

  const revokedSessions = await revokeSessionsByPass(env, id.value);
  return json({ ok: true, revokedSessions, message: '口令已作废，相关登录已全部失效' });
}

/** 彻底删除：行与它签发的会话一起消失。 */
async function deletePass(env, data) {
  const id = parsePositiveInt(data.id, { field: '凭证' });
  if (!id.ok) return error(id.error, 400);

  const revokedSessions = await revokeSessionsByPass(env, id.value);
  const result = await env.DB.prepare('DELETE FROM access_passes WHERE id = ?').bind(id.value).run();
  if (changedRows(result) === 0) return error('凭证不存在', 404);

  return json({ ok: true, revokedSessions, message: '口令已删除，相关登录已全部失效' });
}

/* --------------------- 个人口令（MD3 项目，2026-10-14） --------------------- */

/** 创建个人口令（决策 2/5/6/7）：必须绑定一条已存在的班级口令 + 管理员录入的用户名。 */
async function createPersonal(env, data) {
  const classId = parsePositiveInt(data.class_id, { field: '绑定班级' });
  if (!classId.ok) return error(classId.error, 400);

  const username = String(data.username ?? '').trim();
  if (!PERSONAL_USERNAME_RE.test(username)) {
    return error('用户名需要是 1 到 20 位的中文、字母、数字、下划线或短横线', 400);
  }

  const cls = await env.DB.prepare('SELECT id, name FROM classes WHERE id = ?').bind(classId.value).first();
  if (!cls) return error('绑定的班级口令不存在（班级可能已被删除）', 404);

  const created = await createPersonalPass(env, classId.value, username);
  if (!created.ok && created.conflict) return error('这个用户名在该班级下已存在，请换一个', 409);

  return json({
    ok: true,
    id: created.row ? created.row.id : null,
    class_name: cls.name,
    username,
    message: '个人口令已创建：登录时输入「班级口令@用户名」',
  });
}

/** 删除个人口令（决策 9）：真删、登录立即失效；配色记录保留（同名重建读回）。 */
async function deletePersonal(env, data) {
  const id = parsePositiveInt(data.id, { field: '个人口令' });
  if (!id.ok) return error(id.error, 400);

  const row = await deletePersonalPass(env, id.value);
  if (!row) return error('个人口令不存在', 404);

  const revokedSessions = await revokeSessionsByPersonalPass(env, id.value);
  return json({ ok: true, revokedSessions, message: '个人口令已删除；该用户名的配色记录已保留（同名重建可读回）' });
}

/** 重新绑定（决策 8）：未绑定态恢复 / 换班；前缀自动替换，旧登录一并撤销。 */
async function rebindPersonal(env, data) {
  const id = parsePositiveInt(data.id, { field: '个人口令' });
  if (!id.ok) return error(id.error, 400);
  const classId = parsePositiveInt(data.class_id, { field: '绑定班级' });
  if (!classId.ok) return error(classId.error, 400);

  const cls = await env.DB.prepare('SELECT id, name FROM classes WHERE id = ?').bind(classId.value).first();
  if (!cls) return error('要绑定的班级口令不存在', 404);

  const moved = await rebindPersonalPass(env, id.value, classId.value);
  if (!moved) return error('个人口令不存在', 404);

  const revokedSessions = await revokeSessionsByPersonalPass(env, id.value);
  return json({
    ok: true,
    class_name: cls.name,
    revokedSessions,
    message: `已绑定到「${cls.name}」，登录标识已同步更新`,
  });
}
