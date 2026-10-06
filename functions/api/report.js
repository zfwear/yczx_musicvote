import { readJson, error, json, clientIp } from '../../_lib/http.js';
import { requireSession, guardRate, denyGuest } from '../../_lib/auth.js';
import { parsePositiveInt, parseFingerprint, sanitizeText } from '../../_lib/validate.js';
import { changedRows } from '../../_lib/db.js';
import { verifyRecaptcha } from '../../_lib/recaptcha.js';

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

  // 游客模式：只读，不能举报。拦在读请求体与占位之前 ——
  // 被拒的请求不会写 report_logs，也不会把 is_reported 置起来。
  const guestDenied = denyGuest(auth.session, '游客模式只能查看排行，不能举报');
  if (guestDenied) return guestDenied;

  const classId = auth.session.subject_id;

  const parsed = await readJson(request);
  if (!parsed.ok) return error(parsed.error, 400);

  // 限流按设备指纹（读完请求体才知道），IP 只留宽松兜底。
  // 旧写法 `report:${ip}` = 全校共用 60 次/小时；而举报本身已有
  // report_logs 的 (class_id, song_id) 唯一索引做原子占位，所以这里只是防洪。
  const fingerprint = parseFingerprint(parsed.value.fingerprint);
  const flood = await guardRate(env, request, {
    kind: 'report',
    limit: 20,
    windowSeconds: 3600,
    fingerprint: fingerprint.ok ? fingerprint.value : '',
    clientId: typeof parsed.value.client_id === 'string' ? parsed.value.client_id : '',
    session: auth.session,
    message: '操作过于频繁，请稍后再试',
  });
  if (flood) return flood;

  // 人机校验（reCAPTCHA v3，2026-10-07 补）。没配密钥时直接放行；详见 _lib/recaptcha.js。
  // 位置：限流之后、占位与置位之前 —— 被拒的举报不会写 report_logs，
  // 也不会把 is_reported 顶起来（与上面的游客拦截同一个道理）。
  const human = await verifyRecaptcha(env, parsed.value.recaptcha_token, { ip: clientIp(request) });
  if (!human.ok) return error(human.error, 403);

  const songId = parsePositiveInt(parsed.value.id, { field: '歌曲' });
  if (!songId.ok) return error(songId.error, 400);

  let reason = '';
  if (typeof parsed.value.reason === 'string' && parsed.value.reason.trim()) {
    const parsedReason = sanitizeText(parsed.value.reason, { maxLength: 60, field: '举报原因' });
    if (!parsedReason.ok) return error(parsedReason.error, 400);
    reason = parsedReason.value;
  }

  // 全校共用一份榜单：只要歌在待审核池里就能举报，不限于"自己班"点的。
  const song = await env.DB.prepare(
    "SELECT id FROM songs WHERE id = ? AND status = 'pending'"
  ).bind(songId.value).first();
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
