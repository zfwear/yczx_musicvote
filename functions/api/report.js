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
 *    一个班对同一首歌同时只能有一条举报，占位成功才置 is_reported=1，
 *    因此刷举报无法把一首歌反复顶到管理员列表最前面。
 *  - 另外叠加按 IP 的限流，防止换班轮流刷。
 *
 * ⚠️ 2026-10-08 修：**处理过之后必须能再报**。
 * 收件箱的判据是"`handled_at IS NULL` 的举报行数 >= 阈值"，
 * 而管理员点「标记已处理」会把这首歌**所有**未处理行都写上 handled_at。
 * 原来的写法是占位失败就一律 429「你已经举报过这首歌啦」——
 * 于是等每个班都报过一轮、管理员处理过一轮之后，这首歌
 * **再过分也不会重新浮上来**，收件箱功能等于一次性用完就废。
 * 现在：占位失败时再看一眼那条旧举报 —— **已被处理过就把它重新打开**
 * （handled_at 置回 NULL、刷新原因与时间），当作一次新的举报。
 * 这样只改代码、不动表结构，也不影响"同时只有一条未处理举报"的原子性。
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

  if (changedRows(claim) !== 1) {
    // 已经有这个班对这首歌的举报行了。两种情况要分开处理：
    //   · 还是**未处理**的 → 保持原样：429，别让人反复刷同一件事；
    //   · 已经**被处理过** → 重新打开它（见文件开头那段说明）。
    // 注意 008 之前没有 handled_at 列，读不到就按"未处理"处理 —— 那种部署
    // 本来也用不了收件箱（admin-reports 会提示去跑 008），行为与原来一致。
    let existing = null;
    try {
      existing = await env.DB.prepare(
        'SELECT id, handled_at FROM report_logs WHERE class_id = ? AND song_id = ?'
      ).bind(classId, songId.value).first();
    } catch {
      return error('你已经举报过这首歌啦', 429);
    }
    const handled = existing && existing.handled_at !== null && existing.handled_at !== undefined;
    if (!handled) return error('你已经举报过这首歌啦', 429);

    await env.DB.prepare(
      `UPDATE report_logs
          SET handled_at = NULL, reason = ?, created_at = datetime('now')
        WHERE id = ?`
    ).bind(reason, existing.id).run();
  }

  await env.DB.prepare('UPDATE songs SET is_reported = 1 WHERE id = ?')
    .bind(songId.value).run();

  return json({ ok: true });
}
