import { readJson, error, json, clientIp, header } from '../../_lib/http.js';
import { requireSession, rateLimit } from '../../_lib/auth.js';
import { sanitizeText, parsePositiveInt, parseFingerprint, parseTrackId } from '../../_lib/validate.js';
import { changedRows, lastRowId } from '../../_lib/db.js';

/** 查重窗口：每人每周一次。 */
const DEDUP_WINDOW_DAYS = 7;

/**
 * 点歌提交。
 *
 * 修掉了旧版四个问题：
 *  1. 旧版只检查口令字段非空，从不校验口令合法性 —— 任意非空字符串都能点歌。
 *     现在必须有有效的班级会话，班级身份取自服务端。
 *  2. class_id / category_id 由客户端随意指定 —— 现在 class_id 来自会话，
 *     category_id 必须真实存在于 categories 表。
 *  3. 黑名单 SQL 的 AND/OR 优先级写错，且 LIKE 方向反了（在歌手名后加一个
 *     字符即可绕过）—— 现在用 instr 做字面包含匹配。
 *  4. "先查重再写入"存在并发穿透（两个并发请求都能通过检查）——
 *     现在把检查与写入合并成单条原子语句。
 */
export async function onRequestPost(context) {
  const { request, env } = context;

  const auth = await requireSession(env, request, 'class');
  if (!auth.ok) return auth.response;
  const classId = auth.session.subject_id;
  // 调试模式（用管理员身份在学生端登录）不走每周限次、不查重
  const isDebug = auth.session.role === 'debug';

  const ip = clientIp(request);
  const flood = await rateLimit(env, `vote:${ip}`, 30, 3600);
  if (!flood.allowed) return error('提交过于频繁，请稍后再试', 429);

  const parsed = await readJson(request);
  if (!parsed.ok) return error(parsed.error, 400);
  const data = parsed.value;

  // 入库前先收敛成安全纯文本（纵深防御，不是唯一防线）。
  const title = sanitizeText(data.title, { maxLength: 60, field: '歌名' });
  if (!title.ok) return error(title.error, 400);

  const artist = sanitizeText(data.artist, { maxLength: 60, field: '歌手' });
  if (!artist.ok) return error(artist.error, 400);

  const category = parsePositiveInt(data.category_id ?? 2, { field: '分类', max: 100000 });
  if (!category.ok) return error(category.error, 400);

  const fingerprint = parseFingerprint(data.fingerprint);
  if (!fingerprint.ok) return error(fingerprint.error, 400);

  // 点歌时锁定的那一版音源。前端强制"必须从搜索结果里选一首"，
  // 所以这里也要求带上；调试模式允许省略（方便压测提交逻辑）。
  const trackId = parseTrackId(data.track_id);
  if (!trackId.ok) return error(trackId.error, 400);
  if (!isDebug && !trackId.value) {
    return error('请先点「搜索歌曲」，从列表里选一首再提交', 400);
  }

  const categoryRow = await env.DB.prepare('SELECT id FROM categories WHERE id = ?')
    .bind(category.value).first();
  if (!categoryRow) return error('分类不存在', 400);

  // ---- 违禁词过滤 ----
  // 黑名单里只有"违禁词"，没有"封某首歌"这种条目：把歌名与歌手拼成一条字符串
  // 做字面包含匹配，词出现在哪一边都算命中，所以没法靠"只封歌名"绕过。
  //
  // 旧写法有两个 bug：`keyword LIKE '%歌手%'` 方向是反的（拿关键词去匹配歌手，
  // 等于永远匹配不上），而且 AND 优先级高于 OR 让过期时间只作用于一个分支。
  // 现在统一用 instr 做字面包含，两个问题一起解决。
  //
  // 注意：这一步在音源 id 与调试模式分支**之前**，所以带没带 track_id 都要过这一关。
  const banned = await env.DB.prepare(
    `SELECT keyword, reason FROM banned_items
      WHERE datetime(expire_at) > datetime('now')
        AND instr(lower(?), lower(keyword)) > 0
      LIMIT 1`
  ).bind(`${title.value} ${artist.value}`).first();
  if (banned) {
    const why = banned.reason ? `：${banned.reason}` : '';
    return error(`包含违禁词「${banned.keyword}」${why}`, 403);
  }

  // ---- 调试模式：不限次数、不查重 ----
  // 黑名单仍然生效（方便验证黑名单规则），但跳过"每周一次"和重复检查。
  // 提交的歌标记 is_debug=1，后台审核列表会显示「调试模式」。
  if (isDebug) {
    const result = await insertSongCompat(env, {
      classId: 0,
      title: title.value,
      artist: artist.value,
      categoryId: category.value,
      isDebug: true,
      trackId: trackId.value,
    });
    if (!result.ok) throw result.err;

    return json({
      ok: true,
      debug: true,
      message: '调试模式：已提交（不占用每周额度、不查重）',
    });
  }

  // ---- 友好的重复提示（非原子，只为文案）----
  // 全校共用一份榜单，所以查重是**全校范围**的：不同班级点同一首歌也算重复。
  const existing = await env.DB.prepare(
    'SELECT status FROM songs WHERE title = ? AND artist = ?'
  ).bind(title.value, artist.value).first();
  if (existing) {
    if (existing.status === 'pending') return error('这首歌已经在待审核队列里啦', 400);
    if (existing.status === 'approved') return error('这首歌已经进曲库啦，快去投票吧', 400);
    if (existing.status === 'rejected') return error('该歌曲在往期审核中已被过滤', 400);
  }

  // ---- 原子占名额：检查与写入合成一条语句，杜绝并发穿透 ----
  const claim = await env.DB.prepare(
    `INSERT INTO vote_logs (class_id, ip, fingerprint, user_agent)
     SELECT ?, ?, ?, ?
      WHERE NOT EXISTS (
            SELECT 1 FROM vote_logs
             WHERE ip = ? AND fingerprint = ?
               AND datetime(created_at) > datetime('now', ?)
      )`
  ).bind(
    classId,
    ip,
    fingerprint.value,
    header(request, 'User-Agent', 300),
    ip,
    fingerprint.value,
    `-${DEDUP_WINDOW_DAYS} days`
  ).run();

  if (changedRows(claim) !== 1) {
    return error('您本周已经点过歌啦，每人每周只能点一次哦！', 429);
  }

  // ---- 原子插歌：同一首歌的并发重复提交由 NOT EXISTS 拦下 ----
  // class_id 只用于标注"这是哪个班点的"，不参与查重与可见性判断。
  // track_id 记下点歌时锁定的那一版音源，之后点「试听」直接播它。
  const atomicSql = (cols, placeholders) =>
    `INSERT INTO songs (class_id, title, artist, category_id, status${cols})
     SELECT ?, ?, ?, ?, 'pending'${placeholders}
      WHERE NOT EXISTS (
            SELECT 1 FROM songs WHERE title = ? AND artist = ?
      )`;

  let inserted;
  try {
    inserted = await env.DB.prepare(atomicSql(', track_id', ', ?'))
      .bind(classId, title.value, artist.value, category.value, trackId.value, title.value, artist.value)
      .run();
  } catch (err) {
    if (!/no such column/i.test(String((err && err.message) || ''))) throw err;
    // 009 还没执行：退回不含 track_id 的写法
    inserted = await env.DB.prepare(atomicSql('', ''))
      .bind(classId, title.value, artist.value, category.value, title.value, artist.value)
      .run();
  }

  if (changedRows(inserted) !== 1) {
    // 没插进去就把刚占掉的名额还回去，否则用户白白浪费一周。
    const claimedId = lastRowId(claim);
    if (claimedId > 0) {
      await env.DB.prepare('DELETE FROM vote_logs WHERE id = ?').bind(claimedId).run();
    }
    return error('这首歌已经在待审核队列里啦', 400);
  }

  return json({ ok: true });
}

/**
 * 插入一首歌（调试模式用，不需要查重）。
 *
 * 迁移进度不同可用列不同（006 的 is_debug、009 的 track_id），
 * 从"最全"往"最简"依次尝试，保证任何迁移进度下都能提交。
 */
async function insertSongCompat(env, { classId, title, artist, categoryId, isDebug, trackId }) {
  const variants = [
    [`INSERT INTO songs (class_id, title, artist, category_id, status, is_debug, track_id)
      VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      [classId, title, artist, categoryId, isDebug ? 1 : 0, trackId]],
    [`INSERT INTO songs (class_id, title, artist, category_id, status, is_debug)
      VALUES (?, ?, ?, ?, 'pending', ?)`,
      [classId, title, artist, categoryId, isDebug ? 1 : 0]],
    [`INSERT INTO songs (class_id, title, artist, category_id, status, track_id)
      VALUES (?, ?, ?, ?, 'pending', ?)`,
      [classId, title, artist, categoryId, trackId]],
    [`INSERT INTO songs (class_id, title, artist, category_id, status)
      VALUES (?, ?, ?, ?, 'pending')`,
      [classId, title, artist, categoryId]],
  ];

  let lastError = null;
  for (const [sql, params] of variants) {
    try {
      await env.DB.prepare(sql).bind(...params).run();
      return { ok: true };
    } catch (err) {
      lastError = err;
      // 只有"列不存在"才继续降级；其它错误（约束冲突等）直接返回
      if (!/no such column/i.test(String((err && err.message) || ''))) {
        return { ok: false, err };
      }
    }
  }
  return { ok: false, err: lastError };
}
