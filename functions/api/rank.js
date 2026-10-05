import { error, json } from '../../_lib/http.js';
import { requireSession } from '../../_lib/auth.js';
import { parseEnum } from '../../_lib/validate.js';
import { getVoteCap, applyVoteCap } from '../../_lib/settings.js';

/**
 * 榜单查询（学生端）—— 双榜单分离。
 *
 *   待审核榜 (pending)：按票数从高到低，前端可投票；返回 votes 与 is_reported。
 *   正式榜   (approved)：先按分类权重（纯音乐100 > 中文歌80 > 英文歌50 > 小语种30），
 *                        再按票数从高到低。**响应里完全不含 votes 字段**——
 *                        票数在服务端就不下发，F12 看 Network 也拿不到。
 *
 * ⚠️ 关于"多班级口令"的语义（这里踩过一次坑，记下来）：
 *    多个班级口令是**多把进同一系统的钥匙**，不是多租户。
 *    全校共用同一份榜单，所以查询**不按 class_id 过滤**。
 *    早期版本按会话里的 class_id 过滤，导致"新加一个班级口令后用它登录，
 *    榜单是空的"——因为所有历史歌曲都属于第一个班级。
 *    歌曲记录里的 class_id 只用于标注"是哪个班点的"，不参与可见性判断。
 *
 * 数值列一律 CAST 成 INTEGER：SQLite 是动态类型，数值列理论上可能存进文本，
 * 而这些值会被拼进 HTML 与 JS 调用，强制转整数可从根上断掉此类注入。
 */
export async function onRequestGet(context) {
  const { request, env } = context;

  // 会话只用来证明"你是通过口令进来的学生"，不参与数据过滤。
  const auth = await requireSession(env, request, 'class');
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const status = parseEnum(
    url.searchParams.get('status') || 'approved',
    ['approved', 'pending'],
    { field: 'status' }
  );
  if (!status.ok) return error(status.error, 400);

  if (status.value === 'pending') {
    // 待审核榜排序：**票数为主，分类权重为辅**。
    //
    // 综合分 = 票数 × (100 + 分类权重)
    //   （整数乘法，避免浮点误差；等价于「票数 × (1 + 权重/100)」）
    //
    // 效果：
    //   · 同权重之间比票数，票多的一定在前 —— 票数仍是主要因素；
    //   · 权重相当于给票数加一个放大系数：权重 100 ≈ 票数翻倍，
    //     权重 30 ≈ 票数 ×1.3；
    //   · 所以「票数特别多但权重很低」的歌会排得靠前，但压不过
    //     「票数略少、权重拉满」的歌 —— 不会直接霸占第一位。
    const { results } = await env.DB.prepare(
      `SELECT s.id,
              s.title,
              s.artist,
              s.status,
              s.track_id,
              CAST(s.votes AS INTEGER)       AS votes,
              CAST(s.is_reported AS INTEGER) AS is_reported,
              CAST(c.weight AS INTEGER)      AS category_weight,
              c.name AS category_name
         FROM songs s
         JOIN categories c ON s.category_id = c.id
        WHERE s.status = 'pending'
        ORDER BY (CAST(s.votes AS INTEGER) * (100 + CAST(c.weight AS INTEGER))) DESC,
                 CAST(s.votes AS INTEGER) DESC,
                 s.id DESC
        LIMIT 50`
    ).all();

    // 超过上限的票不计入票数：票照收，但显示与排序都用封顶后的值。
    const cap = await getVoteCap(env);
    return json(applyVoteCap(results || [], cap));
  }

  // 正式榜：不含 votes
  const { results } = await env.DB.prepare(
    `SELECT s.id,
            s.title,
            s.artist,
            s.status,
            s.track_id,
            c.name AS category_name,
            CAST(c.weight AS INTEGER) AS category_weight
       FROM songs s
       JOIN categories c ON s.category_id = c.id
      WHERE s.status = 'approved'
      ORDER BY CAST(c.weight AS INTEGER) DESC,
               CAST(s.votes AS INTEGER) DESC,
               s.id ASC
      LIMIT 50`
  ).all();

  return json(results || []);
}
