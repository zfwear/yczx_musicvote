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
  const orderBy = status.value === 'pending'
    ? 'ORDER BY CAST(s.is_reported AS INTEGER) DESC, s.created_at DESC, s.id DESC'
    : 'ORDER BY s.created_at DESC, s.id DESC';

  const { results } = await env.DB.prepare(
    `SELECT s.id,
            s.title,
            s.artist,
            CAST(s.votes AS INTEGER)       AS votes,
            CAST(s.class_id AS INTEGER)    AS class_id,
            CAST(s.category_id AS INTEGER) AS category_id,
            CAST(s.is_reported AS INTEGER) AS is_reported,
            s.created_at,
            c.name AS category_name
       FROM songs s
       JOIN categories c ON s.category_id = c.id
      WHERE s.status = ?
      ${orderBy}
      LIMIT 100`
  ).bind(status.value).all();

  return json(results || []);
}
