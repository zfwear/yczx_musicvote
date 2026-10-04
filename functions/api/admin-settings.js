import { readJson, error, json } from '../../_lib/http.js';
import { requireAdmin, classPasswordLookup, authPepper, DEFAULT_PEPPER } from '../../_lib/auth.js';
import { sanitizeText, parsePositiveInt, parseEnum, parseSecret } from '../../_lib/validate.js';
import { hashPassword, verifyPassword } from '../../_lib/crypto.js';
import { changedRows } from '../../_lib/db.js';

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

  const auth = await requireAdmin(env, request);
  if (!auth.ok) return auth.response;

  const classes = await env.DB.prepare(
    'SELECT id, name FROM classes ORDER BY id ASC'
  ).all();
  const banned = await env.DB.prepare(
    'SELECT id, type, keyword, reason, expire_at FROM banned_items ORDER BY id DESC LIMIT 200'
  ).all();
  const categories = await env.DB.prepare(
    'SELECT id, name, CAST(weight AS INTEGER) AS weight FROM categories ORDER BY weight DESC, id ASC'
  ).all();

  return json({
    classes: classes.results || [],
    banned: banned.results || [],
    categories: categories.results || [],
    security: {
      // 提示运维是否配置了 AUTH_PEPPER。没配置功能照常，但少一层保护。
      pepperConfigured: authPepper(env) !== DEFAULT_PEPPER,
      adminUsername: null,
    },
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const auth = await requireAdmin(env, request);
  if (!auth.ok) return auth.response;

  const parsed = await readJson(request);
  if (!parsed.ok) return error(parsed.error, 400);
  const data = parsed.value;

  switch (data.action) {
    case 'add_class':
      return addClass(env, data);
    case 'delete_class':
      return deleteClass(env, auth.session, data);
    case 'update_class_password':
      return updateClassPassword(env, data);
    case 'add_banned':
      return addBanned(env, data);
    case 'delete_banned':
      return deleteBanned(env, data);
    case 'update_category_weight':
      return updateCategoryWeight(env, data);
    case 'change_admin_password':
      return changeAdminPassword(env, auth.session, data);
    default:
      return error('未知操作', 400);
  }
}

/* ------------------------- 班级口令管理 ------------------------- */

async function addClass(env, data) {
  const name = sanitizeText(data.name, { maxLength: 30, field: '班级名称' });
  if (!name.ok) return error(name.error, 400);

  const password = parseSecret(data.password, { min: 6, max: 128, field: '班级口令' });
  if (!password.ok) return error(password.error, 400);

  // 加盐哈希无法用等值查询定位，所以额外存一列 HMAC 查找索引。
  const lookup = await classPasswordLookup(env, password.value);
  const hashed = await hashPassword(password.value);

  try {
    await env.DB.prepare(
      'INSERT INTO classes (name, password, password_lookup) VALUES (?, ?, ?)'
    ).bind(name.value, hashed, lookup).run();
  } catch (err) {
    if (isUniqueViolation(err)) return error('该口令已被其他班级使用，请换一个', 409);
    return error('添加失败：数据库结构可能尚未迁移（缺少 password_lookup 列）', 500);
  }

  return json({ ok: true, message: '已添加班级口令' });
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

async function updateClassPassword(env, data) {
  const id = parsePositiveInt(data.id, { field: '班级' });
  if (!id.ok) return error(id.error, 400);

  const password = parseSecret(data.new_password, { min: 6, max: 128, field: '新口令' });
  if (!password.ok) return error(password.error, 400);

  const lookup = await classPasswordLookup(env, password.value);
  const hashed = await hashPassword(password.value);

  try {
    const result = await env.DB.prepare(
      'UPDATE classes SET password = ?, password_lookup = ? WHERE id = ?'
    ).bind(hashed, lookup, id.value).run();

    if (changedRows(result) === 0) return error('班级不存在', 404);
  } catch (err) {
    if (isUniqueViolation(err)) return error('该口令已被其他班级使用，请换一个', 409);
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
