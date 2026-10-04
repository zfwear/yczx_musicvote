import { readJson, error, json } from '../../_lib/http.js';
import { requireAdmin } from '../../_lib/auth.js';
import { parsePositiveInt, parseEnum } from '../../_lib/validate.js';
import { changedRows } from '../../_lib/db.js';

/** 审核动作：通过 / 拒绝 / 恢复。 */
const NEXT_STATUS = {
  approve: 'approved',
  reject: 'rejected',
  restore: 'pending',
};

/**
 * 后台审核。
 *
 * 旧版用 `SELECT id FROM admins WHERE password = ?` 当权限校验，
 * 且 type 未做白名单（传任意值都会落回 pending）。现在统一走管理员会话 + 白名单。
 *
 * 额外提供 clear_report：管理员处理完举报后复位 is_reported，
 * 否则被举报的歌会永远顶在列表最前面。
 */
export async function onRequestPost(context) {
  const { request, env } = context;

  const auth = await requireAdmin(env, request);
  if (!auth.ok) return auth.response;

  const parsed = await readJson(request);
  if (!parsed.ok) return error(parsed.error, 400);

  const id = parsePositiveInt(parsed.value.id, { field: '歌曲' });
  if (!id.ok) return error(id.error, 400);

  const allowed = [...Object.keys(NEXT_STATUS), 'clear_report'];
  const action = parseEnum(parsed.value.type, allowed, { field: '操作' });
  if (!action.ok) return error(action.error, 400);

  if (action.value === 'clear_report') {
    const cleared = await env.DB.prepare('UPDATE songs SET is_reported = 0 WHERE id = ?')
      .bind(id.value).run();
    if (changedRows(cleared) === 0) return error('歌曲不存在', 404);
    return json({ ok: true, action: 'clear_report' });
  }

  const nextStatus = NEXT_STATUS[action.value];

  const result = await env.DB.prepare('UPDATE songs SET status = ? WHERE id = ?')
    .bind(nextStatus, id.value).run();

  if (changedRows(result) === 0) return error('歌曲不存在', 404);

  return json({ ok: true, status: nextStatus });
}
