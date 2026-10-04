import { readJson, error, json, clientIp } from '../../_lib/http.js';
import { requireSession, rateLimit } from '../../_lib/auth.js';
import { parsePositiveInt, sanitizeText } from '../../_lib/validate.js';
import { changedRows } from '../../_lib/db.js';

/**
 * 学生举报待审核歌曲。
 *
 * 设计要点：
 *  - 必须持有本班会话，且只能举报本班处于 pending 状态的歌。
 *  - 用 report_logs 的唯一索引 (class_id, song_id) 做**原子占位**：
 *    一个班级对同一首歌只能举报一次，占位成功才置 is_reported=1，
 *    因此刷举报无法把一首歌反复顶到管理员列表最前面。
 *  - 另外叠加按 IP 的限流，防止换班轮流刷。
 */
export async function onRequestPost(context) {
  const { request, env } = context;

  const auth = await requireSession(env, request, 'class');
  if (!auth.ok) return auth.response;
  const classId = auth.session.subject_id;

  const ip = clientIp(request);
  const flood = await rateLimit(env, `report:${ip}`, 60, 3600);
  if (!flood.allowed) return error('操作过于频繁，请稍后再试', 429);

  const parsed = await readJson(request);
  if (!parsed.ok) return error(parsed.error, 400);

  const songId = parsePositiveInt(parsed.value.id, { field: '歌曲' });
  if (!songId.ok) return error(songId.error, 400);

  let reason = '';
  if (typeof parsed.value.reason === 'string' && parsed.value.reason.trim()) {
    const parsedReason = sanitizeText(parsed.value.reason, { maxLength: 60, field: '举报原因' });
    if (!parsedReason.ok) return error(parsedReason.error, 400);
    reason = parsedReason.value;
  }

  const song = await env.DB.prepare(
    "SELECT id FROM songs WHERE id = ? AND status = 'pending' AND class_id = ?"
  ).bind(songId.value, classId).first();
  if (!song) return error('这首歌不在待审核列表中', 404);

  // 原子占位：并发或重复举报都只会成功一次。
  const claim = await env.DB.prepare(
    'INSERT OR IGNORE INTO report_logs (class_id, song_id, reason) VALUES (?, ?, ?)'
  ).bind(classId, songId.value, reason).run();

  if (changedRows(claim) !== 1) return error('你已经举报过这首歌啦', 429);

  await env.DB.prepare('UPDATE songs SET is_reported = 1 WHERE id = ?')
    .bind(songId.value).run();

  return json({ ok: true });
}
