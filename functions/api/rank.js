import { error, json } from '../../_lib/http.js';
import { requireSession } from '../../_lib/auth.js';
import { parseEnum } from '../../_lib/validate.js';

/**
 * 榜单查询（学生端）—— 双榜单分离。
 *
 *   待审核榜 (pending)：按票数从高到低，前端可投票；返回 votes 与 is_reported。
 *   正式榜   (approved)：先按分类权重（纯音乐100 > 中文歌80 > 英文歌50 > 小语种30），
 *                        再按票数从高到低。**响应里完全不含 votes 字段**——
 *                        票数在服务端就不下发，F12 看 Network 也拿不到，
 *                        比"前端隐藏"可靠得多。
 *
 * 同时修掉旧版三个问题：
 *  1. 口令放在 URL 查询串里 → 现在用会话 Cookie，URL 中不再有凭证。
 *  2. 只校验"口令存在"、不校验它属于哪个班级 → class_id 直接取自会话，
 *     客户端传什么都被忽略，跨班级读取被彻底挡住。
 *  3. status 未做白名单 → 传 rejected 会泄露回收站，现在只允许 approved/pending。
 *
 * 数值列一律 CAST 成 INTEGER：SQLite 是动态类型，数值列理论上可能存进文本，
 * 而这些值会被拼进 HTML 与 JS 调用，强制转整数可从根上断掉此类注入。
 */
export async function onRequestGet(context) {
  const { request, env } = context;

  const auth = await requireSession(env, request, 'class');
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const status = parseEnum(
    url.searchParams.get('status') || 'approved',
    ['approved', 'pending'],
    { field: 'status' }
  );
  if (!status.ok) return error(status.error, 400);

  const classId = auth.session.subject_id;

  if (status.value === 'pending') {
    const { results } = await env.DB.prepare(
      `SELECT s.id,
              s.title,
              s.artist,
              s.status,
              CAST(s.votes AS INTEGER)       AS votes,
              CAST(s.is_reported AS INTEGER) AS is_reported,
              c.name AS category_name
         FROM songs s
         JOIN categories c ON s.category_id = c.id
        WHERE s.status = 'pending' AND s.class_id = ?
        ORDER BY CAST(s.votes AS INTEGER) DESC, s.id DESC
        LIMIT 50`
    ).bind(classId).all();

    return json(results || []);
  }

  // 正式榜：不含 votes
  const { results } = await env.DB.prepare(
    `SELECT s.id,
            s.title,
            s.artist,
            s.status,
            c.name AS category_name,
            CAST(c.weight AS INTEGER) AS category_weight
       FROM songs s
       JOIN categories c ON s.category_id = c.id
      WHERE s.status = 'approved' AND s.class_id = ?
      ORDER BY CAST(c.weight AS INTEGER) DESC,
               CAST(s.votes AS INTEGER) DESC,
               s.id ASC
      LIMIT 50`
  ).bind(classId).all();

  return json(results || []);
}
