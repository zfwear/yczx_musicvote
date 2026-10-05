import { readJson, error, json, clientIp } from '../../_lib/http.js';
import { requireSession, rateLimit } from '../../_lib/auth.js';
import { parsePositiveInt, parseFingerprint } from '../../_lib/validate.js';
import { changedRows } from '../../_lib/db.js';
import { verifyRecaptcha } from '../../_lib/recaptcha.js';

/**
 * 给"待审核"的歌曲投票。
 *
 * 两个语义要点：
 *  1. 全校共用一份榜单 —— 只要歌在待审核池里，任何班级口令登录的学生都能投，
 *     不限于"自己班点的那首"。
 *  2. 去重按**设备指纹**，不是按班级口令。旧实现用 (class_id, song_id) 唯一约束，
 *     在只有一个班级口令时会退化成"全校每首歌只能投一票"，显然不对；
 *     改成按设备后才是"每人一票"的本意。
 */
export async function onRequestPost(context) {
  const { request, env } = context;

  const auth = await requireSession(env, request, 'class');
  if (!auth.ok) return auth.response;
  const classId = auth.session.subject_id;

  const ip = clientIp(request);
  const flood = await rateLimit(env, `upvote:${ip}`, 200, 3600);
  if (!flood.allowed) return error('投票过于频繁，请稍后再试', 429);

  const parsed = await readJson(request);
  if (!parsed.ok) return error(parsed.error, 400);

  // 人机校验（reCAPTCHA v3）。没配密钥时直接放行；详见 _lib/recaptcha.js。
  const human = await verifyRecaptcha(env, parsed.value.recaptcha_token, { ip });
  if (!human.ok) return error(human.error, 403);

  const songId = parsePositiveInt(parsed.value.id, { field: '歌曲' });
  if (!songId.ok) return error(songId.error, 400);

  const fingerprint = parseFingerprint(parsed.value.fingerprint);
  if (!fingerprint.ok) return error(fingerprint.error, 400);

  const song = await env.DB.prepare(
    "SELECT id FROM songs WHERE id = ? AND status = 'pending'"
  ).bind(songId.value).first();
  if (!song) return error('这首歌不在待审核列表中', 404);

  // 原子占位：同一设备对同一首歌只能投一次，并发也只能成功一次。
  const claim = await env.DB.prepare(
    'INSERT OR IGNORE INTO upvote_logs (class_id, song_id, fingerprint) VALUES (?, ?, ?)'
  ).bind(classId, songId.value, fingerprint.value).run();

  if (changedRows(claim) !== 1) return error('你已经给这首歌投过票啦', 429);

  await env.DB.prepare(
    "UPDATE songs SET votes = votes + 1 WHERE id = ? AND status = 'pending'"
  ).bind(songId.value).run();

  return json({ ok: true });
}
