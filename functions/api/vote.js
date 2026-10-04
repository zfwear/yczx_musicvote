import { readJson, error, json, clientIp, header } from '../../_lib/http.js';
import { requireSession, rateLimit } from '../../_lib/auth.js';
import { sanitizeText, parsePositiveInt, parseFingerprint } from '../../_lib/validate.js';
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

  const categoryRow = await env.DB.prepare('SELECT id FROM categories WHERE id = ?')
    .bind(category.value).first();
  if (!categoryRow) return error('分类不存在', 400);

  // ---- 黑名单 ----
  // 旧写法：(type='artist' AND keyword LIKE ?) OR (type='title' AND keyword LIKE ?) AND expire_at > now
  // AND 优先级高于 OR，导致过期时间只作用于 title 分支；而且 `keyword LIKE '%歌手%'`
  // 是拿关键词去匹配歌手，方向是反的。这里改成 instr 字面包含，两个问题一起解决。
  const banned = await env.DB.prepare(
    `SELECT reason FROM banned_items
      WHERE datetime(expire_at) > datetime('now')
        AND (
              (type = 'artist' AND instr(lower(?), lower(keyword)) > 0)
           OR (type = 'title'  AND instr(lower(?), lower(keyword)) > 0)
        )
      LIMIT 1`
  ).bind(artist.value, title.value).first();
  if (banned) return error(`该歌曲或歌手已被过滤：${banned.reason || '违规'}`, 403);

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
  const inserted = await env.DB.prepare(
    `INSERT INTO songs (class_id, title, artist, category_id, status)
     SELECT ?, ?, ?, ?, 'pending'
      WHERE NOT EXISTS (
            SELECT 1 FROM songs WHERE title = ? AND artist = ?
      )`
  ).bind(classId, title.value, artist.value, category.value, title.value, artist.value).run();

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
