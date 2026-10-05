import { readJson, error, json, clientIp } from '../../_lib/http.js';
import { requireSession, guardRate, denyGuest } from '../../_lib/auth.js';
import { parsePositiveInt, parseFingerprint } from '../../_lib/validate.js';
import { changedRows } from '../../_lib/db.js';
import { verifyRecaptcha } from '../../_lib/recaptcha.js';
import { parseRequestId } from '../../_lib/idempotency.js';

/**
 * 给"待审核"的歌曲投票。
 *
 * 两个语义要点：
 *  1. 全校共用一份榜单 —— 只要歌在待审核池里，任何班级口令登录的学生都能投，
 *     不限于"自己班点的那首"。
 *  2. 去重按**设备指纹**，不是按班级口令。旧实现用 (class_id, song_id) 唯一约束，
 *     在只有一个班级口令时会退化成"全校每首歌只能投一票"，显然不对；
 *     改成按设备后才是"每人一票"的本意。
 *
 * A8 原子流程（本次修复）：
 *   旧实现是"先插投票记录、再 UPDATE 票数"，而且**从不检查 UPDATE 的结果**。
 *   如果 UPDATE 因为并发或状态变化没影响到任何行（`WHERE ... status='pending'`
 *   在歌曲刚被审核掉的瞬间就不匹配了），就会留下
 *   "这台设备显示已投过、票数却没涨" 的坏状态 —— 用户再也投不了，票也没算。
 *   现在：UPDATE 影响行数必须是 1，否则**回滚刚插入的投票记录**并明确报错。
 *   失败绝不报假成功。
 *
 *   这里刻意**不用** env.DB.batch()：batch 会把两条语句都执行，
 *   而 `INSERT OR IGNORE` 在重复投票时是"成功返回、影响 0 行"——
 *   那样 UPDATE 照样会把票数 +1，变成一次投票算两票。
 *   所以占位与计数之间必须有条件依赖，只能一步一步来并各自检查。
 */
export async function onRequestPost(context) {
  const { request, env } = context;

  const auth = await requireSession(env, request, 'class');
  if (!auth.ok) return auth.response;

  // 游客模式：只读，不能投票。与投稿同理 —— 拦在读请求体与占位之前，
  // 被拒的请求不会写 upvote_logs，也不会把票数 +1。
  const guestDenied = denyGuest(auth.session, '游客模式只能查看排行，不能投票');
  if (guestDenied) return guestDenied;

  const classId = auth.session.subject_id;

  const ip = clientIp(request);

  const parsed = await readJson(request);
  if (!parsed.ok) return error(parsed.error, 400);

  // 人机校验（reCAPTCHA v3）。没配密钥时直接放行；详见 _lib/recaptcha.js。
  const human = await verifyRecaptcha(env, parsed.value.recaptcha_token, { ip });
  if (!human.ok) return error(human.error, 403);

  const songId = parsePositiveInt(parsed.value.id, { field: '歌曲' });
  if (!songId.ok) return error(songId.error, 400);

  const fingerprint = parseFingerprint(parsed.value.fingerprint);
  if (!fingerprint.ok) return error(fingerprint.error, 400);

  // 可选的幂等请求标识：不传时行为与以前完全一致（老前端还在跑）。
  const requestId = parseRequestId(parsed.value.request_id);
  if (!requestId.ok) return error(requestId.error, 400);

  // 限流：按**设备指纹**计额度（读完请求体才知道指纹，所以放在这里）。
  //
  // 旧写法是把出口 IP 直接拼进桶名、200 次/小时 —— 校园网全校共用一个出口，
  // 一个人刷满，全年级都投不了票。现在每台设备 30 次/小时（投票本身还有
  // upvote_logs 的唯一索引去重，正常学生一小时内不可能投 30 次），
  // IP 只留 600/小时 的宽松兜底（那一道是防脚本，不是防同学）。
  // ⚠️ 不要在桶名里直接拼 IP —— 有测试专门扫这个写法（连注释里的示例也会命中）。
  const flood = await guardRate(env, request, {
    kind: 'upvote',
    limit: 30,
    windowSeconds: 3600,
    fingerprint: fingerprint.value,
    clientId: typeof parsed.value.client_id === 'string' ? parsed.value.client_id : '',
    session: auth.session,
    message: '投票过于频繁，请稍后再试',
  });
  if (flood) return flood;

  const song = await env.DB.prepare(
    "SELECT id FROM songs WHERE id = ? AND status = 'pending'"
  ).bind(songId.value).first();
  if (!song) return error('这首歌不在待审核列表中', 404);

  // 原子占位：同一设备对同一首歌只能投一次，并发也只能成功一次。
  const claim = await env.DB.prepare(
    'INSERT OR IGNORE INTO upvote_logs (class_id, song_id, fingerprint) VALUES (?, ?, ?)'
  ).bind(classId, songId.value, fingerprint.value).run();

  if (changedRows(claim) !== 1) {
    // 没抢到占位：要么是真的重复投票，要么是客户端把同一次请求重试了一遍。
    //
    // 带 request_id 时按"重放"答复：目标状态（这台设备对这首歌的投票
    // 已经记录过）已经成立，返回成功不会多算一票 —— 响应里 counted:false
    // 明确说明这次没有产生新的副作用，所以不是"报假成功"。
    // 不带 request_id 时保持老行为（429），老前端的提示文案不变。
    //
    // 这里能这样答复的前提是不变量：**投票记录存在 ⇔ 票数已经加过**。
    // 下面的 UPDATE 失败会立刻删掉记录，正是为了守住这条不变量。
    if (requestId.value) {
      return json({
        ok: true,
        duplicate: true,
        counted: false,
        message: '这次投票之前已经记录过了（幂等重放，未重复计票）',
      });
    }
    return error('你已经给这首歌投过票啦', 429);
  }

  // 关键：一定要检查票数是否真的加上了（A8）。
  // 条件更新影响 0 行**不是 SQL 错误**，它只是"没有匹配的行"——
  // 不检查的话，上面那条投票记录就变成了一张空头支票。
  const counted = await env.DB.prepare(
    "UPDATE songs SET votes = votes + 1 WHERE id = ? AND status = 'pending'"
  ).bind(songId.value).run();

  if (changedRows(counted) !== 1) {
    // 歌曲在我们确认它还在待审核池之后被审核掉（或删除）了，这次投票没有计入。
    // 必须把占位记录撤掉，否则这台设备就再也投不了这首歌，
    // 而票数也没涨 —— 这正是审计里"已投过但没加票"的那个坏状态。
    const rollback = await env.DB.prepare(
      'DELETE FROM upvote_logs WHERE fingerprint = ? AND song_id = ?'
    ).bind(fingerprint.value, songId.value).run();

    if (changedRows(rollback) !== 1) {
      // 回滚也失败：如实暴露不一致（返回 500），不要假装只是"歌曲状态变了"。
      return error('投票未计入，且投票记录回滚失败，请联系管理员核查', 500);
    }
    return error('这首歌的状态刚刚发生了变化（可能已被审核），本次投票没有计入，请刷新后重试', 409);
  }

  return json({ ok: true, counted: true });
}
