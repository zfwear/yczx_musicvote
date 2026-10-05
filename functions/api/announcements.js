import { readJson, error, json } from '../../_lib/http.js';
import { requireSession, requireAdmin } from '../../_lib/auth.js';
import { parsePositiveInt, parseEnum, sanitizeText, sanitizeMultiline } from '../../_lib/validate.js';
import { changedRows, isMissingTable } from '../../_lib/db.js';

/**
 * 公告区。
 *
 * 读取：班级会话或管理员会话都可以（首页要给学生看）。
 *       管理员带 ?all=1 时可以拿到全部公告（含已下架的），用于后台管理；
 *       这一条路径**明确要求管理员会话**，不参与"学生 / 管理员自动挑选"。
 * 写入：普通管理员及以上都能发公告（这是用户明确指定的权限）。
 */

const MAX_ACTIVE_LIST = 20;
const MAX_ADMIN_LIST = 100;
// 登录页公告是给还没进来的人看的，条数不宜多，否则把口令框挤下去
const MAX_GATE_LIST = 5;

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
  const url = new URL(request.url);

  // 登录页公告（scope='gate'）必须**未登录也能读** —— 它就是给
  // 还没进系统的人看的。所以这条路径不要求会话，但只返回 gate 那一类，
  // 且只返回已上架的，不会泄露主页公告。
  const wantsGate = url.searchParams.get('scope') === 'gate';
  if (wantsGate) {
    const { results } = await env.DB.prepare(
      `SELECT id, title, content, created_at
         FROM announcements
        WHERE CAST(is_active AS INTEGER) = 1 AND scope = 'gate'
        ORDER BY id DESC
        LIMIT ${MAX_GATE_LIST}`
    ).all();
    return json({ announcements: results || [], scope: 'gate' });
  }

  // all=1 是后台管理用的（要看到已下架的公告）。
  //
  // 审计报告 B3：原实现走的是 requireSession(env, request, null) ——
  // 不限身份时会**优先挑学生会话**（见 _lib/auth.js 的 presentedTokens），
  // 于是同时登录了学生和管理员的人打开后台，拿到的是"只含已上架"的列表，
  // 下架的公告在管理界面里凭空消失。
  //
  // 所以 all=1 明确要求**管理员会话**：不看学生会话，也不需要靠自动挑选。
  // 普通管理员即可（读公告是 staff 权限），用 requireAdmin 得到的
  // session.role 也是数据库里的当前角色。
  const wantsAll = url.searchParams.get('all') === '1';

  if (wantsAll) {
    const admin = await requireAdmin(env, request, ['super', 'admin']);
    if (!admin.ok) return admin.response;

    const { results } = await env.DB.prepare(
      `SELECT id, title, content, created_by_name, COALESCE(scope, 'app') AS scope,
              CAST(is_active AS INTEGER) AS is_active, created_at, updated_at
         FROM announcements
        ORDER BY CAST(is_active AS INTEGER) DESC, id DESC
        LIMIT ${MAX_ADMIN_LIST}`
    ).all();
    return json({ announcements: results || [] });
  }

  // 普通读取：班级身份或管理员身份都放行（首页要给学生看）。
  const auth = await requireSession(env, request, null);
  if (!auth.ok) return auth.response;

  const { results } = await env.DB.prepare(
    `SELECT id, title, content, created_by_name, created_at
       FROM announcements
      WHERE CAST(is_active AS INTEGER) = 1
        AND COALESCE(scope, 'app') = 'app'
      ORDER BY id DESC
      LIMIT ${MAX_ACTIVE_LIST}`
  ).all();

  return json({ announcements: results || [] });
}

async function handlePost(context) {
  const { request, env } = context;

  const auth = await requireAdmin(env, request, ['super', 'admin']);
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

  // scope：gate = 登录页（未登录可见），app = 主页（登录后可见）
  const scope = parseEnum(data.scope, ['gate', 'app'], { field: '公告类型', fallback: 'app' });
  if (!scope.ok) return error(scope.error, 400);

  const admin = await env.DB.prepare('SELECT username FROM admins WHERE id = ?')
    .bind(session.subject_id).first();

  try {
    await env.DB.prepare(
      `INSERT INTO announcements (title, content, created_by, created_by_name, is_active, scope)
       VALUES (?, ?, ?, ?, 1, ?)`
    ).bind(fields.title, fields.content, session.subject_id, (admin && admin.username) || '', scope.value).run();
  } catch (err) {
    // 010 未执行时没有 scope 列：退回只写主页公告
    if (!/no such column/i.test(String((err && err.message) || ''))) throw err;
    await env.DB.prepare(
      `INSERT INTO announcements (title, content, created_by, created_by_name, is_active)
       VALUES (?, ?, ?, ?, 1)`
    ).bind(fields.title, fields.content, session.subject_id, (admin && admin.username) || '').run();
  }

  return json({
    ok: true,
    message: scope.value === 'gate' ? '登录页公告已发布（未登录也能看到）' : '公告已发布',
  });
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
