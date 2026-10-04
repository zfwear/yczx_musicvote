import { readJson, error, json } from '../../_lib/http.js';
import {
  requireStaff, requireSuper, classPasswordLookup, authPepper, DEFAULT_PEPPER,
} from '../../_lib/auth.js';
import { sanitizeText, parsePositiveInt, parseEnum, parseSecret } from '../../_lib/validate.js';
import { hashPassword, verifyPassword, encryptSecret, decryptSecret } from '../../_lib/crypto.js';
import {
  getVoteCap, setSetting, SETTING_VOTE_CAP, getSetting,
} from '../../_lib/settings.js';
import { changedRows, isMissingTable } from '../../_lib/db.js';

const DEFAULT_EXPIRY = '2099-12-31 23:59:59';
const EXPIRY_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/** 判断是否为唯一索引冲突（用于给出"口令重复"这种可读提示）。 */
function isUniqueViolation(err) {
  return /unique|constraint/i.test(String((err && err.message) || ''));
}

/**
 * 系统设置。
 *
 * 修掉的问题：
 *  - 旧版 GET 分支**完全没有认证**，任何人访问 /api/admin-settings
 *    就能拿到全部黑名单（审计报告第 5 条）。现在读和写都要求管理员会话。
 *  - 旧版只支持修改 id=1 那一条班级口令。现在支持添加 / 删除 / 逐个改口令。
 *  - 新增管理员改密，方便出事之后轮换凭证。
 */
export async function onRequestGet(context) {
  const { request, env } = context;

  const auth = await requireStaff(env, request);
  if (!auth.ok) return auth.response;

  const isSuper = auth.session.role === 'super';
  const pepper = authPepper(env);

  // 班级列表。逐级降级，保证任何迁移进度下后台都打得开：
  // 007 之前没有 grade / member_count，005 之前没有 password_encrypted。
  let classRows = [];
  let canViewPasswords = false;
  let hasClassMeta = false;

  const ATTEMPTS = [
    { sql: 'SELECT id, name, grade, member_count, password_encrypted FROM classes ORDER BY grade ASC, id ASC', vault: true, meta: true },
    { sql: 'SELECT id, name, grade, member_count, NULL AS password_encrypted FROM classes ORDER BY grade ASC, id ASC', vault: false, meta: true },
    { sql: 'SELECT id, name, NULL AS grade, NULL AS member_count, password_encrypted FROM classes ORDER BY id ASC', vault: true, meta: false },
    { sql: 'SELECT id, name, NULL AS grade, NULL AS member_count, NULL AS password_encrypted FROM classes ORDER BY id ASC', vault: false, meta: false },
  ];

  for (const attempt of ATTEMPTS) {
    try {
      const res = await env.DB.prepare(attempt.sql).all();
      classRows = res.results || [];
      canViewPasswords = attempt.vault;
      hasClassMeta = attempt.meta;
      break;
    } catch (err) {
      if (!/no such column/i.test(String((err && err.message) || ''))) throw err;
    }
  }

  const classes = [];
  for (const row of classRows) {
    const count = row.member_count === null || row.member_count === undefined
      ? null
      : Number(row.member_count);
    const item = {
      id: row.id,
      name: row.name,
      grade: row.grade || '',
      member_count: Number.isFinite(count) ? count : null,
    };
    // 口令明文只回给高级管理员；普通管理员拿不到。
    if (isSuper) {
      item.password = row.password_encrypted
        ? await decryptSecret(pepper, row.password_encrypted)
        : null;
    }
    classes.push(item);
  }

  const voteCap = await getVoteCap(env);
  const voteCapRaw = await getSetting(env, SETTING_VOTE_CAP, '');
  const totalMembers = classes.reduce((sum, c) => sum + (c.member_count || 0), 0);

  const banned = await env.DB.prepare(
    'SELECT id, type, keyword, reason, expire_at FROM banned_items ORDER BY id DESC LIMIT 200'
  ).all();
  const categories = await env.DB.prepare(
    'SELECT id, name, CAST(weight AS INTEGER) AS weight FROM categories ORDER BY weight DESC, id ASC'
  ).all();

  return json({
    classes,
    banned: banned.results || [],
    categories: categories.results || [],
    vote: {
      cap: voteCap,                 // 0 表示不限制
      capConfigured: voteCap > 0,
      capRaw: String(voteCapRaw || ''),
      totalMembers,                 // 按班级人数汇总出来的全校人数，供管理员参考
    },
    security: {
      // 提示运维是否配置了 AUTH_PEPPER。没配置功能照常，但少一层保护。
      pepperConfigured: pepper !== DEFAULT_PEPPER,
      // 是否已执行 005（能查看口令）；未执行时只能看到"无法查看"
      canViewPasswords,
      // 是否已执行 007（年级 / 人数 / 投票上限）
      hasClassMeta,
      // 前端据此决定是否显示"高级管理员专属"的几块设置。
      role: auth.session.role,
      isSuper,
    },
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const parsed = await readJson(request);
  if (!parsed.ok) return error(parsed.error, 400);
  const data = parsed.value;

  // 权限分级：普通管理员只被允许维护黑名单；
  // 班级口令、分类权重、管理员改密都属于高级管理员专属。
  const STAFF_ACTIONS = new Set(['add_banned', 'delete_banned']);
  const auth = STAFF_ACTIONS.has(data.action)
    ? await requireStaff(env, request)
    : await requireSuper(env, request);
  if (!auth.ok) return auth.response;

  switch (data.action) {
    case 'add_class':
      return addClass(env, data);
    case 'delete_class':
      return deleteClass(env, auth.session, data);
    case 'delete_classes':
      return deleteClasses(env, data);
    case 'update_class_password':
      return updateClassPassword(env, data);
    case 'add_banned':
      return addBanned(env, data);
    case 'delete_banned':
      return deleteBanned(env, data);
    case 'update_category_weight':
      return updateCategoryWeight(env, data);
    case 'set_vote_cap':
      return setVoteCap(env, data);
    case 'update_class_info':
      return updateClassInfo(env, data);
    case 'change_admin_password':
      return changeAdminPassword(env, auth.session, data);
    default:
      return error('未知操作', 400);
  }
}

/**
 * 写班级口令：哈希用于校验，AES-GCM 密文用于管理员查看。
 * 005 迁移未执行时自动退回只写哈希的旧写法，功能不受影响（只是看不到口令）。
 */
async function writeClassSecret(env, { id = null, name, plain }) {
  const lookup = await classPasswordLookup(env, plain);
  const hashed = await hashPassword(plain);
  const encrypted = await encryptSecret(authPepper(env), plain);

  if (id === null) {
    try {
      await env.DB.prepare(
        'INSERT INTO classes (name, password, password_lookup, password_encrypted) VALUES (?, ?, ?, ?)'
      ).bind(name, hashed, lookup, encrypted).run();
      return { ok: true };
    } catch (err) {
      if (/no such column/i.test(String((err && err.message) || ''))) {
        // 还没执行 005：退回旧写法
        await env.DB.prepare(
          'INSERT INTO classes (name, password, password_lookup) VALUES (?, ?, ?)'
        ).bind(name, hashed, lookup).run();
        return { ok: true, noVault: true };
      }
      return { ok: false, err };
    }
  }

  try {
    await env.DB.prepare(
      'UPDATE classes SET password = ?, password_lookup = ?, password_encrypted = ? WHERE id = ?'
    ).bind(hashed, lookup, encrypted, id).run();
    return { ok: true };
  } catch (err) {
    if (/no such column/i.test(String((err && err.message) || ''))) {
      await env.DB.prepare(
        'UPDATE classes SET password = ?, password_lookup = ? WHERE id = ?'
      ).bind(hashed, lookup, id).run();
      return { ok: true, noVault: true };
    }
    return { ok: false, err };
  }
}

/* ------------------------- 班级口令管理 ------------------------- */

async function addClass(env, data) {
  const name = sanitizeText(data.name, { maxLength: 30, field: '班级名称' });
  if (!name.ok) return error(name.error, 400);

  const password = parseSecret(data.password, { min: 6, max: 128, field: '班级口令' });
  if (!password.ok) return error(password.error, 400);

  const meta = parseClassMeta(data);
  if (meta.error) return error(meta.error, 400);

  // 批量生成时很容易撞名，先查一下给出可读提示，而不是默默建一堆同名班级。
  const duplicate = await env.DB.prepare('SELECT id FROM classes WHERE name = ?')
    .bind(name.value).first();
  if (duplicate) return error(`班级「${name.value}」已经存在了`, 409);

  const result = await writeClassSecret(env, { name: name.value, plain: password.value });
  if (!result.ok) {
    if (isUniqueViolation(result.err)) return error('该口令已被其他班级使用，请换一个', 409);
    return error('添加失败：数据库结构可能尚未迁移', 500);
  }

  // 年级 / 人数：007 未执行时静默跳过，不影响添加口令
  if (meta.grade || meta.memberCount !== null) {
    try {
      await env.DB.prepare('UPDATE classes SET grade = ?, member_count = ? WHERE name = ?')
        .bind(meta.grade, meta.memberCount, name.value).run();
    } catch (err) {
      if (!/no such column/i.test(String((err && err.message) || ''))) throw err;
    }
  }

  return json({ ok: true, message: '已添加班级口令' });
}

/** 解析年级与人数（都可选）。 */
function parseClassMeta(data) {
  let grade = '';
  if (typeof data.grade === 'string' && data.grade.trim()) {
    const parsed = sanitizeText(data.grade, { maxLength: 20, field: '年级' });
    if (!parsed.ok) return { error: parsed.error };
    grade = parsed.value;
  }

  let memberCount = null;
  const raw = data.member_count;
  if (raw !== '' && raw !== null && raw !== undefined) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 10000) {
      return { error: '人数需要是 0 到 10000 之间的整数' };
    }
    memberCount = n;
  }

  return { grade, memberCount };
}

/**
 * 设置投票上限。
 * 0 表示不限制；大于 0 时，**超出上限的那部分票不计入票数**
 * （票照收，但学生端显示与正式榜排序都用封顶后的值）。
 */
async function setVoteCap(env, data) {
  const raw = data.cap === '' || data.cap === null || data.cap === undefined ? 0 : Number(data.cap);
  if (!Number.isInteger(raw) || raw < 0 || raw > 1000000) {
    return error('投票上限需要是 0 到 1000000 之间的整数（0 表示不限制）', 400);
  }

  try {
    await setSetting(env, SETTING_VOTE_CAP, raw);
  } catch (err) {
    if (isMissingTable(err)) {
      return error('数据库尚未执行 007 迁移（缺少 system_settings 表），请先执行 sql/007_class_grade_and_vote_cap.sql', 500);
    }
    throw err;
  }

  return json({
    ok: true,
    cap: raw,
    message: raw > 0
      ? `已设置投票上限为 ${raw} 票，超出部分不计入票数`
      : '已取消投票上限（票数不再封顶）',
  });
}

/** 修改某个班级的年级与人数。 */
async function updateClassInfo(env, data) {
  const id = parsePositiveInt(data.id, { field: '班级' });
  if (!id.ok) return error(id.error, 400);

  const meta = parseClassMeta(data);
  if (meta.error) return error(meta.error, 400);

  try {
    const result = await env.DB.prepare(
      'UPDATE classes SET grade = ?, member_count = ? WHERE id = ?'
    ).bind(meta.grade, meta.memberCount, id.value).run();
    if (changedRows(result) === 0) return error('班级不存在', 404);
  } catch (err) {
    if (/no such column/i.test(String((err && err.message) || ''))) {
      return error('数据库尚未执行 007 迁移（缺少 grade / member_count 列），请先执行 sql/007_class_grade_and_vote_cap.sql', 500);
    }
    throw err;
  }

  return json({ ok: true, message: '已保存该班级的年级与人数' });
}

async function deleteClass(env, session, data) {
  const id = parsePositiveInt(data.id, { field: '班级' });
  if (!id.ok) return error(id.error, 400);

  const total = await env.DB.prepare('SELECT COUNT(*) AS n FROM classes').first();
  if (Number(total && total.n) <= 1) {
    return error('至少要保留一个班级口令，否则将无法登录', 400);
  }

  const result = await env.DB.prepare('DELETE FROM classes WHERE id = ?').bind(id.value).run();
  if (changedRows(result) === 0) return error('班级不存在', 404);

  // 被删班级的会话立即失效（其歌曲记录保留，便于追溯历史）。
  await env.DB.prepare("DELETE FROM sessions WHERE subject = 'class' AND subject_id = ?")
    .bind(id.value).run();

  return json({ ok: true, message: '已删除该班级口令' });
}

/**
 * 批量删除班级口令。
 * 无论批量生成过多少随机口令，都能一次清掉；
 * 但**始终至少保留一个**，否则全校都登不进来。
 */
async function deleteClasses(env, data) {
  const raw = Array.isArray(data.ids) ? data.ids : [];
  const ids = [];
  for (const value of raw) {
    const parsed = parsePositiveInt(value, { field: '班级' });
    if (parsed.ok && !ids.includes(parsed.value)) ids.push(parsed.value);
  }

  if (!ids.length) return error('请先勾选要删除的班级', 400);
  if (ids.length > 200) return error('一次最多删除 200 个班级', 400);

  const total = await env.DB.prepare('SELECT COUNT(*) AS n FROM classes').first();
  const totalCount = Number(total && total.n) || 0;
  if (totalCount - ids.length < 1) {
    return error(`当前共 ${totalCount} 个班级口令，至少要保留 1 个否则将无法登录，请少选几个`, 400);
  }

  const placeholders = ids.map(() => '?').join(',');
  const result = await env.DB.prepare(`DELETE FROM classes WHERE id IN (${placeholders})`)
    .bind(...ids).run();
  const deleted = changedRows(result);

  await env.DB.prepare(
    `DELETE FROM sessions WHERE subject = 'class' AND subject_id IN (${placeholders})`
  ).bind(...ids).run();

  return json({ ok: true, deleted, message: `已删除 ${deleted} 个班级口令` });
}

async function updateClassPassword(env, data) {
  const id = parsePositiveInt(data.id, { field: '班级' });
  if (!id.ok) return error(id.error, 400);

  const password = parseSecret(data.new_password, { min: 6, max: 128, field: '新口令' });
  if (!password.ok) return error(password.error, 400);

  const exists = await env.DB.prepare('SELECT id FROM classes WHERE id = ?').bind(id.value).first();
  if (!exists) return error('班级不存在', 404);

  const result = await writeClassSecret(env, { id: id.value, plain: password.value });
  if (!result.ok) {
    if (isUniqueViolation(result.err)) return error('该口令已被其他班级使用，请换一个', 409);
    return error('修改失败', 500);
  }

  // 改了口令就让该班级所有旧会话失效，防止旧口令持有者继续使用。
  await env.DB.prepare("DELETE FROM sessions WHERE subject = 'class' AND subject_id = ?")
    .bind(id.value).run();

  return json({ ok: true, message: '口令已更新，原登录状态已失效' });
}

/* ------------------------- 黑名单管理 ------------------------- */

async function addBanned(env, data) {
  const type = parseEnum(data.type, ['artist', 'title'], { field: '类型', fallback: 'artist' });
  const keyword = sanitizeText(data.keyword, { maxLength: 40, field: '关键词' });
  if (!keyword.ok) return error(keyword.error, 400);

  let reason = '管理员封禁';
  if (typeof data.reason === 'string' && data.reason.trim()) {
    const parsed = sanitizeText(data.reason, { maxLength: 60, field: '原因' });
    if (!parsed.ok) return error(parsed.error, 400);
    reason = parsed.value;
  }

  let expireAt = DEFAULT_EXPIRY;
  if (typeof data.expire_at === 'string' && data.expire_at.trim()) {
    const value = data.expire_at.trim();
    if (!EXPIRY_PATTERN.test(value)) return error('过期时间格式应为 YYYY-MM-DD HH:MM:SS', 400);
    expireAt = value;
  }

  await env.DB.prepare(
    'INSERT INTO banned_items (type, keyword, reason, expire_at) VALUES (?, ?, ?, ?)'
  ).bind(type.value, keyword.value, reason, expireAt).run();

  return json({ ok: true, message: '已加入黑名单' });
}

async function deleteBanned(env, data) {
  const id = parsePositiveInt(data.id, { field: '记录' });
  if (!id.ok) return error(id.error, 400);

  const result = await env.DB.prepare('DELETE FROM banned_items WHERE id = ?').bind(id.value).run();
  if (changedRows(result) === 0) return error('记录不存在', 404);

  return json({ ok: true, message: '已移出黑名单' });
}

/* ------------------------- 管理员改密 ------------------------- */

async function changeAdminPassword(env, session, data) {
  const current = parseSecret(data.current_password, { min: 1, max: 128, field: '当前密码' });
  if (!current.ok) return error(current.error, 400);

  const next = parseSecret(data.new_password, { min: 8, max: 128, field: '新密码' });
  if (!next.ok) return error(next.error, 400);

  if (current.value === next.value) return error('新密码不能与当前密码相同', 400);

  const admin = await env.DB.prepare('SELECT id, password FROM admins WHERE id = ?')
    .bind(session.subject_id).first();
  if (!admin) return error('账号不存在', 404);

  const verdict = await verifyPassword(admin.password, current.value);
  if (!verdict.ok) return error('当前密码不正确', 401);

  const hashed = await hashPassword(next.value);
  await env.DB.prepare('UPDATE admins SET password = ? WHERE id = ?')
    .bind(hashed, admin.id).run();

  // 保留当前会话，踢掉其它所有管理员会话 —— 密码轮换往往意味着怀疑凭证已泄露。
  await env.DB.prepare(
    "DELETE FROM sessions WHERE subject = 'admin' AND subject_id = ? AND id <> ?"
  ).bind(admin.id, session.id).run();

  return json({ ok: true, message: '密码已更新，其它设备上的登录已失效' });
}

/* ------------------------- 分类权重管理 ------------------------- */

/**
 * 修改分类权重 —— 直接决定"正式榜单"的排序。
 * 权重是整数（0–1000），权重越大排越前；同权重内再按票数降序。
 */
async function updateCategoryWeight(env, data) {
  const id = parsePositiveInt(data.id, { field: '分类' });
  if (!id.ok) return error(id.error, 400);

  const weight = Number(data.weight);
  if (!Number.isInteger(weight) || weight < 0 || weight > 1000) {
    return error('权重必须是 0 到 1000 之间的整数', 400);
  }

  const result = await env.DB.prepare('UPDATE categories SET weight = ? WHERE id = ?')
    .bind(weight, id.value).run();
  if (changedRows(result) === 0) return error('分类不存在', 404);

  return json({ ok: true, message: '权重已更新，正式榜单排序立即生效' });
}
