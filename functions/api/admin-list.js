import { error, json } from '../../_lib/http.js';
import { requireAdmin } from '../../_lib/auth.js';
import { parseEnum } from '../../_lib/validate.js';
import { getVoteCap, effectiveVotesExpr } from '../../_lib/settings.js';
import { playableMapForIds } from '../../_lib/playable.js';
// 跨路由复用同一个判断（含"问中转源"那一步）：见 music.js 里 trackPlayable 的说明。
// 两份实现迟早会给出不一致的结论，而"学生端能播、审核端说不能"是最难查的一类分歧。
import { trackPlayable } from './music.js';

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
 *
 * 关于 track_id（A7）：
 *   后端审核的「试听」必须播"学生提交时锁定的那一版"，所以这里一定要带上
 *   track_id；前端拿到就直接播，拿不到（历史数据 / 009 迁移没跑）才回退搜索。
 *   为了让"迁移只跑了一半"的库也能打开后台，下面按列是否存在逐个降级，
 *   而不是让一个多余的列把整个列表打成 500。
 *
 * 关于 playable（2026-10-07 用户要求"在审核界面跟管理员说明没有音频"）：
 *   `playable: false` 表示**学生锁定的这一版确认播不出音频**（网易云受版权限制的
 *   原唱居多）。管理员一眼要看到"哪几首听不了"，所以这里由**服务端**一次问完
 *   （`_lib/playable.js`，带 10 分钟缓存），而不是让前端对每张卡片各发一个请求 ——
 *   那会撞上试听接口的额度，一个列表就把管理员的额度烧掉一大半。
 *   三种取值语义不能混：true 能播 / false 确认不能播 / **null 不确定**（前端别标）。
 *   探测有条数上限与总截止时间，到点没探完的一律 null，列表照常快速返回。
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

  // 票数封顶参与排序（A6）：待审核列表与学生端待审核榜必须用同一套综合分，
  // 否则同两首歌在两个页面上的先后顺序会不一样，管理员看到的就是错的信息。
  // 注意这里与学生端一样用「有效票数」= MIN(votes, cap)，而不是原始票数。
  const cap = await getVoteCap(env);
  const effectiveVotes = effectiveVotesExpr(cap);

  const orderBy = status.value === 'pending'
    ? `ORDER BY CAST(s.is_reported AS INTEGER) DESC,
               (${effectiveVotes} * (100 + CAST(c.weight AS INTEGER))) DESC,
               ${effectiveVotes} DESC,
               s.id DESC`
    : 'ORDER BY s.created_at DESC, s.id DESC';

  // 迁移进度不同，可用列不同：006 的 is_debug、009 的 track_id。
  // 从"最全"往"最简"降级尝试，保证任何迁移进度下后台都能打开。
  const variants = [
    { isDebug: true, trackId: true },
    { isDebug: true, trackId: false },
    { isDebug: false, trackId: true },
    { isDebug: false, trackId: false },
  ];

  let lastError = null;
  for (const variant of variants) {
    try {
      const { results } = await env.DB.prepare(buildSelect(variant, orderBy))
        .bind(status.value).all();
      const rows = results || [];
      const playable = await playableMapForIds(rows.map((r) => r.track_id), {
        resolve: (id) => trackPlayable(env, id),
      });
      return json(rows.map((row) => ({ ...row, playable: playable.get(String(row.track_id)) ?? null })));
    } catch (err) {
      lastError = err;
      // 只有"列不存在"才继续降级；其它错误（语法、权限等）直接抛出去
      if (!/no such column/i.test(String((err && err.message) || ''))) throw err;
    }
  }
  throw lastError;
}

/**
 * 拼出后台列表查询。
 *
 * 缺失的列用常量补位（track_id 补 NULL、is_debug 补 0），
 * 这样返回给前端的字段集合是稳定的：前端不必按迁移进度写分支。
 * ORDER BY 由 orderBy 传入，取值来自上面的白名单分支，不含用户输入。
 */
function buildSelect({ isDebug, trackId }, orderBy) {
  const trackColumn = trackId ? 's.track_id' : 'NULL';
  const debugColumn = isDebug ? 'CAST(s.is_debug AS INTEGER)' : '0';
  const hideDebugDuplicates = isDebug
    ? `
       AND NOT (
             CAST(s.is_debug AS INTEGER) = 1
         AND EXISTS (
               SELECT 1 FROM songs o
                WHERE o.title = s.title
                  AND o.artist = s.artist
                  AND CAST(o.is_debug AS INTEGER) = 0
             )
       )`
    : '';

  return `
    SELECT s.id, s.title, s.artist, ${trackColumn} AS track_id,
           CAST(s.votes AS INTEGER)       AS votes,
           CAST(s.class_id AS INTEGER)    AS class_id,
           CAST(s.category_id AS INTEGER) AS category_id,
           CAST(s.is_reported AS INTEGER) AS is_reported,
           ${debugColumn}                 AS is_debug,
           s.created_at,
           c.name AS category_name
      FROM songs s
      JOIN categories c ON s.category_id = c.id
     WHERE s.status = ?
     ${hideDebugDuplicates}
     ${orderBy}
     LIMIT 100`;
}
