import { readJson, error, json } from '../../_lib/http.js';
import { requireSession, requireStaff, rateLimit } from '../../_lib/auth.js';
import { parsePositiveInt, sanitizeText } from '../../_lib/validate.js';
import { changedRows, isMissingTable } from '../../_lib/db.js';

/**
 * 歌曲建议。
 *
 * 场景：学生在试听"点歌时锁定的那一版"时觉得不合适
 * （音质差、不是原唱、版本不对、纯音乐版本不对…），
 * 按「这首不对？换个版本」旁边的「建议」按钮把意见提给管理员。
 *
 * 管理员看到建议后自己去别处找合适的版本，本站不负责换源。
 *
 * GET  —— 管理员按歌曲查看建议（带班级与原因明细）
 * POST —— 学生提交一条建议
 */

const MAX_LIST = 100;
const MIGRATION_HINT =
  '数据库尚未执行 011 迁移（缺少歌曲建议表），'
  + '请先在 D1 控制台执行 sql/011_song_suggestions.sql';

export async function onRequestGet(context) {
  const { request, env } = context;

  const auth = await requireStaff(env, request);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const songId = parsePositiveInt(url.searchParams.get('song_id'), { field: '歌曲' });
  if (!songId.ok) return error(songId.error, 400);

  try {
    const { results } = await env.DB.prepare(
      `SELECT s.id, s.content, s.created_at, cl.name AS class_name
         FROM song_suggestions s
         LEFT JOIN classes cl ON cl.id = s.class_id
        WHERE s.song_id = ? AND s.handled_at IS NULL
        ORDER BY s.id DESC
        LIMIT ${MAX_LIST}`
    ).bind(songId.value).all();

    return json({ suggestions: results || [] });
  } catch (err) {
    if (isMissingTable(err)) return error(MIGRATION_HINT, 500);
    throw err;
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const auth = await requireSession(env, request, 'class');
  if (!auth.ok) return auth.response;

  const flood = await rateLimit(env, `suggest:${auth.session.subject_id}`, 20, 3600);
  if (!flood.allowed) return error('建议提得有点频繁，请稍后再试', 429);

  const parsed = await readJson(request);
  if (!parsed.ok) return error(parsed.error, 400);
  const data = parsed.value;

  const songId = parsePositiveInt(data.song_id, { field: '歌曲' });
  if (!songId.ok) return error(songId.error, 400);

  const content = sanitizeText(data.content, { maxLength: 120, field: '建议内容' });
  if (!content.ok) return error(content.error, 400);

  const song = await env.DB.prepare('SELECT id FROM songs WHERE id = ?').bind(songId.value).first();
  if (!song) return error('这首歌不存在', 404);

  try {
    await env.DB.prepare(
      `INSERT INTO song_suggestions (song_id, class_id, content)
       VALUES (?, ?, ?)`
    ).bind(songId.value, auth.session.subject_id, content.value).run();
  } catch (err) {
    if (isMissingTable(err)) return error(MIGRATION_HINT, 500);
    throw err;
  }

  return json({ ok: true, message: '建议已提交，管理员会在后台看到' });
}

/** 管理员标记某首歌的建议为已处理。 */
export async function onRequestPut(context) {
  const { request, env } = context;

  const auth = await requireStaff(env, request);
  if (!auth.ok) return auth.response;

  const parsed = await readJson(request);
  if (!parsed.ok) return error(parsed.error, 400);

  const songId = parsePositiveInt(parsed.value.song_id, { field: '歌曲' });
  if (!songId.ok) return error(songId.error, 400);

  try {
    const result = await env.DB.prepare(
      "UPDATE song_suggestions SET handled_at = datetime('now') WHERE song_id = ? AND handled_at IS NULL"
    ).bind(songId.value).run();

    return json({ ok: true, handled: changedRows(result), message: '建议已标记为处理' });
  } catch (err) {
    if (isMissingTable(err)) return error(MIGRATION_HINT, 500);
    throw err;
  }
}
