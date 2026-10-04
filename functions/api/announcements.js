import { readJson, error, json } from '../../_lib/http.js';
import { requireSession, requireStaff } from '../../_lib/auth.js';
import { parsePositiveInt, parseEnum, sanitizeText, sanitizeMultiline } from '../../_lib/validate.js';
import { changedRows, isMissingTable } from '../../_lib/db.js';

/**
 * 公告区。
 *
 * 读取：班级会话或管理员会话都可以（首页要给学生看）。
 *       管理员带 ?all=1 时可以拿到全部公告（含已下架的），用于后台管理。
 * 写入：普通管理员及以上都能发公告（这是用户明确指定的权限）。
 */

const MAX_ACTIVE_LIST = 20;
const MAX_ADMIN_LIST = 100;

const MIGRATION_HINT =
  '数据库尚未执行 003 迁移（缺少公告表），'
  + '请先在 D1 控制台执行 sql/003_multi_admin_and_announcements.sql';

export async function onRequestGet(context) {
  try {
    return await handleGet(context);
  } catch (err) {
    if (isMissingTable(err)) return error(MIGRATION_HINT, 500);
    throw err;
  }
}

export async function onRequestPost(context) {
  try {
    return await handlePost(context);
  } catch (err) {
    if (isMissingTable(err)) return error(MIGRATION_HINT, 500);
    throw err;
  }
}

async function handleGet(context) {
  const { request, env } = context;

  // subject 传 null：班级身份或管理员身份都放行。
  const auth = await requireSession(env, request, null);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const wantsAll = url.searchParams.get('all') === '1' && auth.session.subject === 'admin';

  const { results } = wantsAll
    ? await env.DB.prepare(
      `SELECT id, title, content, created_by_name,
              CAST(is_active AS INTEGER) AS is_active, created_at, updated_at
         FROM announcements
        ORDER BY CAST(is_active AS INTEGER) DESC, id DESC
        LIMIT ${MAX_ADMIN_LIST}`
    ).all()
    : await env.DB.prepare(
      `SELECT id, title, content, created_by_name, created_at
         FROM announcements
        WHERE CAST(is_active AS INTEGER) = 1
        ORDER BY id DESC
        LIMIT ${MAX_ACTIVE_LIST}`
    ).all();

  return json({ announcements: results || [] });
}

async function handlePost(context) {
  const { request, env } = context;

  const auth = await requireStaff(env, request);
  if (!auth.ok) return auth.response;

  const parsed = await readJson(request);
  if (!parsed.ok) return error(parsed.error, 400);
  const data = parsed.value;

  if (data.action === 'create') return createAnnouncement(env, auth.session, data);
  if (data.action === 'update') return updateAnnouncement(env, data);
  if (data.action === 'toggle') return toggleAnnouncement(env, data);
  if (data.action === 'delete') return deleteAnnouncement(env, data);

  return error('未知操作', 400);
}

/** 把标题与正文一起校验，失败时返回 {error}。 */
function parseFields(data, { requireAll = true } = {}) {
  const title = sanitizeText(data.title, { maxLength: 40, field: '公告标题' });
  if (!title.ok) return { error: title.error };

  const content = sanitizeMultiline(data.content, { maxLength: 500, field: '公告内容' });
  if (!content.ok) return { error: content.error };

  if (requireAll && (!title.value || !content.value)) return { error: '标题和内容都不能为空' };
  return { title: title.value, content: content.value };
}

async function createAnnouncement(env, session, data) {
  const fields = parseFields(data);
  if (fields.error) return error(fields.error, 400);

  const admin = await env.DB.prepare('SELECT username FROM admins WHERE id = ?')
    .bind(session.subject_id).first();

  await env.DB.prepare(
    `INSERT INTO announcements (title, content, created_by, created_by_name, is_active)
     VALUES (?, ?, ?, ?, 1)`
  ).bind(fields.title, fields.content, session.subject_id, (admin && admin.username) || '').run();

  return json({ ok: true, message: '公告已发布' });
}

async function updateAnnouncement(env, data) {
  const id = parsePositiveInt(data.id, { field: '公告' });
  if (!id.ok) return error(id.error, 400);

  const fields = parseFields(data);
  if (fields.error) return error(fields.error, 400);

  const result = await env.DB.prepare(
    `UPDATE announcements
        SET title = ?, content = ?, updated_at = datetime('now')
      WHERE id = ?`
  ).bind(fields.title, fields.content, id.value).run();

  if (changedRows(result) === 0) return error('公告不存在', 404);
  return json({ ok: true, message: '公告已更新' });
}

async function toggleAnnouncement(env, data) {
  const id = parsePositiveInt(data.id, { field: '公告' });
  if (!id.ok) return error(id.error, 400);

  const active = parseEnum(data.is_active, [0, 1, '0', '1', true, false], { field: '状态' });
  if (!active.ok) return error(active.error, 400);
  const value = (active.value === 1 || active.value === '1' || active.value === true) ? 1 : 0;

  const result = await env.DB.prepare(
    `UPDATE announcements SET is_active = ?, updated_at = datetime('now') WHERE id = ?`
  ).bind(value, id.value).run();

  if (changedRows(result) === 0) return error('公告不存在', 404);
  return json({ ok: true, message: value === 1 ? '公告已上架' : '公告已下架' });
}

async function deleteAnnouncement(env, data) {
  const id = parsePositiveInt(data.id, { field: '公告' });
  if (!id.ok) return error(id.error, 400);

  const result = await env.DB.prepare('DELETE FROM announcements WHERE id = ?')
    .bind(id.value).run();
  if (changedRows(result) === 0) return error('公告不存在', 404);

  return json({ ok: true, message: '公告已删除' });
}
