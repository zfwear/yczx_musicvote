import { readJson, error, json } from '../../_lib/http.js';
import { requireStaff } from '../../_lib/auth.js';
import { parsePositiveInt } from '../../_lib/validate.js';
import { getReportThreshold, DEFAULT_REPORT_THRESHOLD } from '../../_lib/settings.js';
import { changedRows, isMissingColumn } from '../../_lib/db.js';

/**
 * 举报收件箱。
 *
 * 规则：**只有被多次举报、且仍然有效的举报才会进来。**
 *   · 多次：同一首歌被不同班级举报的次数 >= 阈值（默认 3，后台可调）
 *   · 有效：歌还在待审核池里（status='pending'），且该举报未被处理过
 *
 * 这样一个人随手举报一次不会打扰管理员；多人反映的才会浮上来。
 *
 * 管理员点「标记已处理」后，这首歌的所有未处理举报都会记上 handled_at，
 * 从此不再出现在收件箱，同时清掉歌曲上的「已被举报」标记。
 */

const MAX_INBOX = 50;

export async function onRequestGet(context) {
  const { request, env } = context;

  const auth = await requireStaff(env, request);
  if (!auth.ok) return auth.response;

  const threshold = await getReportThreshold(env);

  let rows = [];
  let available = true;

  try {
    const res = await env.DB.prepare(
      `SELECT s.id AS song_id, s.title, s.artist, s.status,
              CAST(s.votes AS INTEGER) AS votes,
              c.name AS category_name,
              COUNT(r.id) AS report_count,
              MIN(r.created_at) AS first_at,
              MAX(r.created_at) AS last_at
         FROM report_logs r
         JOIN songs s ON s.id = r.song_id
         JOIN categories c ON s.category_id = c.id
        WHERE r.handled_at IS NULL
          AND s.status = 'pending'
        GROUP BY s.id
       HAVING COUNT(r.id) >= ?
        ORDER BY report_count DESC, last_at DESC
        LIMIT ${MAX_INBOX}`
    ).bind(threshold).all();
    rows = res.results || [];
  } catch (err) {
    // 008 未执行时没有 handled_at 列：不要让后台打不开，返回空收件箱 + 提示
    if (!isMissingColumn(err)) throw err;
    available = false;
  }

  // 拉出每条举报的明细（哪个班举报的、什么理由、什么时候）
  const bySong = new Map();
  if (rows.length) {
    const ids = rows
      .map((row) => Number(row.song_id))
      .filter((n) => Number.isInteger(n) && n > 0);

    if (ids.length) {
      const placeholders = ids.map(() => '?').join(',');
      const detailRes = await env.DB.prepare(
        `SELECT r.song_id, r.reason, r.created_at, cl.name AS class_name
           FROM report_logs r
           LEFT JOIN classes cl ON cl.id = r.class_id
          WHERE r.handled_at IS NULL AND r.song_id IN (${placeholders})
          ORDER BY r.created_at DESC`
      ).bind(...ids).all();

      for (const item of detailRes.results || []) {
        const key = Number(item.song_id);
        if (!bySong.has(key)) bySong.set(key, []);
        bySong.get(key).push({
          reason: item.reason || '',
          class_name: item.class_name || '',
          created_at: item.created_at,
        });
      }
    }
  }

  return json({
    threshold,
    defaultThreshold: DEFAULT_REPORT_THRESHOLD,
    available,
    reports: rows.map((row) => ({
      song_id: Number(row.song_id),
      title: row.title,
      artist: row.artist,
      votes: Number(row.votes) || 0,
      category_name: row.category_name,
      report_count: Number(row.report_count) || 0,
      first_at: row.first_at,
      last_at: row.last_at,
      details: bySong.get(Number(row.song_id)) || [],
    })),
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const auth = await requireStaff(env, request);
  if (!auth.ok) return auth.response;

  const parsed = await readJson(request);
  if (!parsed.ok) return error(parsed.error, 400);
  const data = parsed.value;

  if (data.action !== 'handle') return error('未知操作', 400);

  const songId = parsePositiveInt(data.song_id, { field: '歌曲' });
  if (!songId.ok) return error(songId.error, 400);

  let handled = 0;
  try {
    const result = await env.DB.prepare(
      "UPDATE report_logs SET handled_at = datetime('now') WHERE song_id = ? AND handled_at IS NULL"
    ).bind(songId.value).run();
    handled = changedRows(result);
  } catch (err) {
    if (isMissingColumn(err)) {
      return error('数据库尚未执行 008 迁移（缺少 handled_at 列），请先执行 sql/008_report_inbox.sql', 500);
    }
    throw err;
  }

  // 顺手清掉歌曲上的「已被举报」标记
  await env.DB.prepare('UPDATE songs SET is_reported = 0 WHERE id = ?').bind(songId.value).run();

  return json({
    ok: true,
    handled,
    message: `已标记为处理（${handled} 条举报）`,
  });
}
