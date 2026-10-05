import { readJson, error, json } from '../../_lib/http.js';
import { requireSuper, revokeDebugSessions } from '../../_lib/auth.js';
import { parsePositiveInt, parseSecret } from '../../_lib/validate.js';
import { hashPassword } from '../../_lib/crypto.js';
import { changedRows } from '../../_lib/db.js';

/**
 * 管理员账号列表与处置 —— 仅高级管理员可用。
 *
 * 保护规则（这几条是硬性的，避免把自己锁死）：
 *  - 不能删除自己
 *  - 不能删除或重置另一个高级管理员
 *  - 注册接口永远只会产生 role='admin'，所以高级管理员只能是你本人
 */

export async function onRequestGet(context) {
  const { request, env } = context;

  const auth = await requireSuper(env, request);
  if (!auth.ok) return auth.response;

  const { results } = await env.DB.prepare(
    "SELECT id, username, role FROM admins ORDER BY CASE WHEN role = 'super' THEN 0 ELSE 1 END, id ASC"
  ).all();

  return json({
    admins: results || [],
    currentId: auth.session.subject_id,
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const auth = await requireSuper(env, request);
  if (!auth.ok) return auth.response;

  const parsed = await readJson(request);
  if (!parsed.ok) return error(parsed.error, 400);
  const data = parsed.value;

  if (data.action === 'delete') return deleteAdmin(env, auth.session, data);
  if (data.action === 'reset_password') return resetPassword(env, data);

  return error('未知操作', 400);
}

async function loadTarget(env, data) {
  const id = parsePositiveInt(data.id, { field: '管理员' });
  if (!id.ok) return { error: id.error };
  const target = await env.DB.prepare('SELECT id, username, role FROM admins WHERE id = ?')
    .bind(id.value).first();
  if (!target) return { error: '管理员不存在' };
  return { target };
}

async function deleteAdmin(env, session, data) {
  const loaded = await loadTarget(env, data);
  if (loaded.error) return error(loaded.error, 404);

  const { target } = loaded;
  if (target.id === session.subject_id) return error('不能删除你自己的账号', 400);
  if (target.role === 'super') return error('不能删除高级管理员', 403);

  await env.DB.prepare('DELETE FROM admins WHERE id = ?').bind(target.id).run();
  // 顺手注销他所有在线会话，避免删了账号还能继续操作。
  await env.DB.prepare("DELETE FROM sessions WHERE subject = 'admin' AND subject_id = ?")
    .bind(target.id).run();
  // 还要撤销他换来的**调试会话**（审计 A5）。
  // 调试会话走的是 subject='class' 那一侧，上面那条按 subject='admin' 的删除够不着它；
  // 不显式清理的话，被删掉的管理员留下的调试身份还能继续写真实数据，
  // 直到 2 小时自然过期。requireAdmin 里虽有兜底，但这里清掉更干净、也更早。
  await revokeDebugSessions(env, target.id);

  return json({ ok: true, message: `已删除管理员「${target.username}」` });
}

async function resetPassword(env, data) {
  const loaded = await loadTarget(env, data);
  if (loaded.error) return error(loaded.error, 404);

  const { target } = loaded;
  if (target.role === 'super') return error('不能重置高级管理员的密码', 403);

  const next = parseSecret(data.new_password, { min: 8, max: 128, field: '新密码' });
  if (!next.ok) return error(next.error, 400);

  const hashed = await hashPassword(next.value);
  const result = await env.DB.prepare('UPDATE admins SET password = ? WHERE id = ?')
    .bind(hashed, target.id).run();
  if (changedRows(result) === 0) return error('管理员不存在', 404);

  await env.DB.prepare("DELETE FROM sessions WHERE subject = 'admin' AND subject_id = ?")
    .bind(target.id).run();
  // 改密后同理：调试会话也要跟着失效（审计 A5）
  await revokeDebugSessions(env, target.id);

  return json({ ok: true, message: `已重置「${target.username}」的密码，其登录状态已失效` });
}
