import { error, json } from '../../_lib/http.js';
import { requireAdmin } from '../../_lib/auth.js';
import { parseEnum } from '../../_lib/validate.js';

/**
 * 后台歌曲列表。
 *
 * 旧版 **完全没有认证**：任何人直接访问 /api/admin-list?status=pending
 * 就能拿到全部内部数据（审计报告第 5 条）。现在要求管理员会话。
 *
 * 待审核列表把被举报的排在最前面，方便管理员优先处理。
 * 所有数值列 CAST 成 INTEGER，堵死从"数字字段"打进来的注入。
 *
 * 调试模式（is_debug=1）的处理：
 *   · 列表里会标注 is_debug，前端显示「调试模式」徽标；
 *   · 但如果这首歌与某首正式歌曲（is_debug=0）同名同歌手，
 *     就**不显示** —— 调试时会反复提交同一首歌，不隐藏会刷屏。
 */
export async function onRequestGet(context) {
  const { request, env } = context;

  const auth = await requireAdmin(env, request);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const status = parseEnum(
    url.searchParams.get('status') || 'pending',
    ['pending', 'approved', 'rejected'],
    { field: 'status' }
  );
  if (!status.ok) return error(status.error, 400);

  // ORDER BY 取自白名单分支，不含用户输入。
  //
  // 待审核：**票数为主、分类权重为辅**，与学生端待审核榜用同一套综合分：
  //   综合分 = 票数 × (100 + 分类权重)
  // 被举报的仍排在最前（需要优先处理，且它们本来也会进举报收件箱），
  // 其余按综合分排。
  const orderBy = status.value === 'pending'
    ? `ORDER BY CAST(s.is_reported AS INTEGER) DESC,
               (CAST(s.votes AS INTEGER) * (100 + CAST(c.weight AS INTEGER))) DESC,
               CAST(s.votes AS INTEGER) DESC,
               s.id DESC`
    : 'ORDER BY s.created_at DESC, s.id DESC';

  const selectWithDebug = `
    SELECT s.id, s.title, s.artist, s.track_id,
           CAST(s.votes AS INTEGER)       AS votes,
           CAST(s.class_id AS INTEGER)    AS class_id,
           CAST(s.category_id AS INTEGER) AS category_id,
           CAST(s.is_reported AS INTEGER) AS is_reported,
           CAST(s.is_debug AS INTEGER)    AS is_debug,
           s.created_at,
           c.name AS category_name
      FROM songs s
      JOIN categories c ON s.category_id = c.id
     WHERE s.status = ?
       AND NOT (
             CAST(s.is_debug AS INTEGER) = 1
         AND EXISTS (
               SELECT 1 FROM songs o
                WHERE o.title = s.title
                  AND o.artist = s.artist
                  AND CAST(o.is_debug AS INTEGER) = 0
             )
       )
     ${orderBy}
     LIMIT 100`;

  // 006 迁移未执行时没有 is_debug 列，退回不含调试标记的查询，
  // 保证后台始终能打开。
  const selectPlain = `
    SELECT s.id, s.title, s.artist, s.track_id,
           CAST(s.votes AS INTEGER)       AS votes,
           CAST(s.class_id AS INTEGER)    AS class_id,
           CAST(s.category_id AS INTEGER) AS category_id,
           CAST(s.is_reported AS INTEGER) AS is_reported,
           0                              AS is_debug,
           s.created_at,
           c.name AS category_name
      FROM songs s
      JOIN categories c ON s.category_id = c.id
     WHERE s.status = ?
     ${orderBy}
     LIMIT 100`;

  try {
    const { results } = await env.DB.prepare(selectWithDebug).bind(status.value).all();
    return json(results || []);
  } catch (err) {
    if (!/no such column/i.test(String((err && err.message) || ''))) throw err;
    const { results } = await env.DB.prepare(selectPlain).bind(status.value).all();
    return json((results || []).map((row) => ({ ...row, is_debug: 0 })));
  }
}
