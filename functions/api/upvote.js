import { readJson, error, json } from '../../_lib/http.js';
import { requireSession } from '../../_lib/auth.js';
import { parsePositiveInt } from '../../_lib/validate.js';
import { changedRows } from '../../_lib/db.js';

/**
 * 给"待审核"的歌曲投票。
 *
 * 说明：这个接口在交接前**根本不存在**（仓库里没有 functions/api/upvote.js），
 * 但 index.html 一直在调用 /api/upvote，所以主页的"投票"按钮实际是 404。
 * 这里按原有业务语义补上，并顺手补了防重复投票：
 * 旧设计没有做任何限制，连点一百次就是一百票。
 */
export async function onRequestPost(context) {
  const { request, env } = context;

  const auth = await requireSession(env, request, 'class');
  if (!auth.ok) return auth.response;
  const classId = auth.session.subject_id;

  const parsed = await readJson(request);
  if (!parsed.ok) return error(parsed.error, 400);

  const songId = parsePositiveInt(parsed.value.id, { field: '歌曲' });
  if (!songId.ok) return error(songId.error, 400);

  // 只能投本班待审核的歌。
  const song = await env.DB.prepare(
    "SELECT id FROM songs WHERE id = ? AND status = 'pending' AND class_id = ?"
  ).bind(songId.value, classId).first();
  if (!song) return error('这首歌不在待审核列表中', 404);

  // 同一班级对同一首歌只能投一次，靠唯一索引原子保证（并发也只能成功一次）。
  const claim = await env.DB.prepare(
    'INSERT OR IGNORE INTO upvote_logs (class_id, song_id) VALUES (?, ?)'
  ).bind(classId, songId.value).run();

  if (changedRows(claim) !== 1) {
    return error('你已经给这首歌投过票啦', 429);
  }

  await env.DB.prepare(
    "UPDATE songs SET votes = votes + 1 WHERE id = ? AND status = 'pending'"
  ).bind(songId.value).run();

  return json({ ok: true });
}
