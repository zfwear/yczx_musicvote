import { readJson, error, json } from '../../_lib/http.js';
import { requireStaff } from '../../_lib/auth.js';
import { parsePositiveInt, parseEnum } from '../../_lib/validate.js';
import { changedRows } from '../../_lib/db.js';

/** 审核动作：通过 / 拒绝 / 恢复。 */
const NEXT_STATUS = {
  approve: 'approved',
  reject: 'rejected',
  restore: 'pending',
};

/**
 * 后台审核与回收站处置。
 *
 * 注意区分两个概念（它们是完全独立的两套数据）：
 *   · 回收站 = songs 表里 status='rejected' 的歌曲。可以恢复、可以彻底删除。
 *   · 黑名单 = banned_items 表。是"禁止再提交某歌手/某歌名"的规则，
 *     跟某首歌在不在回收站毫无关系。黑名单在 admin-settings 里管理。
 *
 * 永久删除会连同这首歌的举报记录、投票记录一起清掉，避免留下孤儿数据。
 */
export async function onRequestPost(context) {
  const { request, env } = context;

  const auth = await requireStaff(env, request);
  if (!auth.ok) return auth.response;

  const parsed = await readJson(request);
  if (!parsed.ok) return error(parsed.error, 400);

  const allowed = [...Object.keys(NEXT_STATUS), 'clear_report', 'delete', 'empty_recycle'];
  const action = parseEnum(parsed.value.type, allowed, { field: '操作' });
  if (!action.ok) return error(action.error, 400);

  // 清空回收站不需要 id，先处理。
  if (action.value === 'empty_recycle') {
    const result = await env.DB.prepare("DELETE FROM songs WHERE status = 'rejected'").run();
    await env.DB.prepare(
      `DELETE FROM report_logs
        WHERE song_id NOT IN (SELECT id FROM songs)`
    ).run();
    return json({ ok: true, deleted: changedRows(result) });
  }

  const id = parsePositiveInt(parsed.value.id, { field: '歌曲' });
  if (!id.ok) return error(id.error, 400);

  if (action.value === 'clear_report') {
    const cleared = await env.DB.prepare('UPDATE songs SET is_reported = 0 WHERE id = ?')
      .bind(id.value).run();
    if (changedRows(cleared) === 0) return error('歌曲不存在', 404);
    return json({ ok: true, action: 'clear_report' });
  }

  if (action.value === 'delete') {
    const song = await env.DB.prepare('SELECT id, title FROM songs WHERE id = ?')
      .bind(id.value).first();
    if (!song) return error('歌曲不存在', 404);

    await env.DB.prepare('DELETE FROM songs WHERE id = ?').bind(id.value).run();
    // 清掉关联数据，避免留下无主记录
    await env.DB.prepare('DELETE FROM report_logs WHERE song_id = ?').bind(id.value).run();
    await env.DB.prepare('DELETE FROM upvote_logs WHERE song_id = ?').bind(id.value).run();

    return json({ ok: true, message: `已彻底删除「${song.title}」` });
  }

  const nextStatus = NEXT_STATUS[action.value];

  const result = await env.DB.prepare('UPDATE songs SET status = ? WHERE id = ?')
    .bind(nextStatus, id.value).run();

  if (changedRows(result) === 0) return error('歌曲不存在', 404);

  return json({ ok: true, status: nextStatus });
}
