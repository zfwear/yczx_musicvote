import { error, json } from '../../_lib/http.js';
import { requireSession } from '../../_lib/auth.js';
import { parseEnum } from '../../_lib/validate.js';
import { getVoteCap, applyVoteCap, effectiveVotesExpr } from '../../_lib/settings.js';
import { isMissingColumn, isMissingTable } from '../../_lib/db.js';

/**
 * 榜单查询（学生端）—— 双榜单分离。
 *
 *   待审核榜 (pending)：按票数从高到低，前端可投票；返回 votes 与 is_reported。
 *   正式榜   (approved)：先按分类权重（纯音乐100 > 中文歌80 > 英文歌50 > 小语种30），
 *                        再按票数从高到低。**响应里完全不含 votes 字段**——
 *                        票数在服务端就不下发，F12 看 Network 也拿不到。
 *
 * ⚠️ 票数一律用「有效票数」= MIN(votes, 投票上限)（上限为 0 表示不限）。
 *    排序、截取、显示三处必须是同一个值，否则封顶就只是遮数字（A6）。
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

  // 投票上限：票数封顶必须**参与排序与截取**（A6）。
  //
  // 旧实现先按原始票数排好序、截了前 50 条，再把显示票数改成封顶值 ——
  // 刷到 9999 票的歌照样霸榜，封顶只是个显示层的假象。
  // 现在排序键直接用「有效票数」= MIN(votes, cap)，cap=0 表示不限。
  //
  // 代价说明：这里多一次 system_settings 的主键查询（getVoteCap）。
  // 它是单行等值查询，比"榜单被刷票结果带偏"划算得多；
  // 免费套餐的 CPU 预算主要花在 PBKDF2 上，这一条查询不构成压力。
  const cap = await getVoteCap(env);
  const effectiveVotes = effectiveVotesExpr(cap);

  // 学生榜不该显示调试模式提交的歌（审计 A5）：
  // 调试会话能不限次、不查重地写真实歌曲表，那些歌只是拿来压测的，
  // 混进学生榜单会让人以为真有人投了。
  // 006 迁移没跑时没有 is_debug 列，所以先探一下再决定要不要加这个条件。
  let notDebugClause = '';
  try {
    await env.DB.prepare('SELECT is_debug FROM songs LIMIT 1').first();
    notDebugClause = 'AND (s.is_debug IS NULL OR CAST(s.is_debug AS INTEGER) = 0)';
  } catch (err) {
    if (!isMissingColumn(err)) throw err;
    // 没有这一列：老库照常工作，只是没法过滤调试歌
  }

  if (status.value === 'pending') {
    // 待审核榜排序：**票数为主，分类权重为辅**。
    //
    // 综合分 = 有效票数 × (100 + 分类权重)
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
        WHERE s.status = 'pending' ${notDebugClause}
        ORDER BY (${effectiveVotes} * (100 + CAST(c.weight AS INTEGER))) DESC,
                 ${effectiveVotes} DESC,
                 s.id DESC
        LIMIT 50`
    ).all();

    // 显示层仍然走 applyVoteCap：票数封顶后还要带出 votes_raw / votes_capped
    // 供后台与学生端排查（前端依赖这两个字段）。排序已经在 SQL 里用掉了
    // 有效票数，这里只是把"超限"这件事如实标注出来。
    return json(applyVoteCap(results || [], cap));
  }

  // 正式榜：不含 votes。
  // 排序同样用有效票数 —— 否则"票数封顶"在正式榜上完全没有意义。
  //
  // 另外：**已经播过的排期歌曲从这里移出**（用户要求："对于上周已经播放过的
  // 排期歌曲，从正式榜里面移出"）。语义按"那一周是否已经过完"判断：
  //   · 本周的歌**不移**——它正在播，榜上还要标「已加入排期 · 本周」；
  //   · 上周及更早的**移出**——那一轮已经放完，留在榜上只会越积越多。
  // 依赖 012 的 weekly_playlist；**没跑那一版迁移时必须优雅退化**
  // （退回没有这条排除的查询），否则整个排行页会 500。
  const baseSql = `SELECT s.id,
            s.title,
            s.artist,
            s.status,
            s.track_id,
            c.name AS category_name,
            CAST(c.weight AS INTEGER) AS category_weight
       FROM songs s
       JOIN categories c ON s.category_id = c.id
      WHERE s.status = 'approved' ${notDebugClause}`;
  const orderSql = `ORDER BY CAST(c.weight AS INTEGER) DESC,
               ${effectiveVotes} DESC,
               s.id ASC
       LIMIT 50`;
  const playedClause = ` AND s.id NOT IN (
          SELECT CAST(song_id AS INTEGER) FROM weekly_playlist
           WHERE song_id IS NOT NULL AND week_start < ?)`;

  let results;
  try {
    ({ results } = await env.DB.prepare(`${baseSql}${playedClause} ${orderSql}`)
      .bind(mondayOf(new Date().toISOString().slice(0, 10))).all());
  } catch (err) {
    if (!isMissingTable(err)) throw err;
    // 012 还没执行：没有排期表，也就谈不上"播过的歌"，退回原查询
    ({ results } = await env.DB.prepare(`${baseSql} ${orderSql}`).all());
  }

  return json(results || []);
}

/**
 * 某天所在那一周的周一（UTC），YYYY-MM-DD。
 *
 * 与 `functions/api/schedule.js` 里的同名函数口径**必须一致** ——
 * 两边算出来的周一差一天，"上周的歌退出正式榜"就会提前或推迟一天生效。
 * 都用 UTC 是为了不受运行时区影响（Worker 跑在什么时区不由我们决定）。
 */
function mondayOf(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const dow = d.getUTCDay();               // 0 = 周日
  d.setUTCDate(d.getUTCDate() - (dow === 0 ? 6 : dow - 1));
  return d.toISOString().slice(0, 10);
}
