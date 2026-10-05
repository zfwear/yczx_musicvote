import { readJson, error, json, clientIp, header } from '../../_lib/http.js';
import { requireSession, rateLimit } from '../../_lib/auth.js';
import { parsePositiveInt, parseFingerprint } from '../../_lib/validate.js';
import { changedRows, lastRowId, isMissingColumn } from '../../_lib/db.js';
import { verifyRecaptcha } from '../../_lib/recaptcha.js';
import { verifyTrackToken } from '../../_lib/tracktoken.js';
import { parseRequestId } from '../../_lib/idempotency.js';

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
 *
 * 之后又修了两条审计遗留问题：
 *  A7 音源一致性：title / artist / track_id 以前是**各查各的格式**，
 *     没有任何东西保证三者属于同一首歌。现在搜索接口会下发一张签名的
 *     选曲凭据（见 _lib/tracktoken.js），提交时带上就以凭据内容为准。
 *     过渡期的"没带凭据就走老规则"兼容分支已经删除（vote.html 会带上凭据），
 *     所以**没有有效凭据就点不了歌**，A7 不再是 opt-in。
 *  A8 原子流程：以前是"先占每周额度、再插歌"，插歌失败才补偿；
 *     中途异常会留下"没歌却消耗了额度"。现在两步放进同一个 batch（事务），
 *     并且**逐步检查影响行数**做补偿 —— 条件更新影响 0 行不是 SQL 错误，
 *     不显式检查就会被当成成功。
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

  // 人机校验（reCAPTCHA v3）。没配密钥时直接放行；详见 _lib/recaptcha.js。
  const human = await verifyRecaptcha(env, data.recaptcha_token, { ip });
  if (!human.ok) return error(human.error, 403);

  const fingerprint = parseFingerprint(data.fingerprint);
  if (!fingerprint.ok) return error(fingerprint.error, 400);

  // 可选的幂等请求标识：不传时行为与以前完全一致。
  const requestId = parseRequestId(data.request_id);
  if (!requestId.ok) return error(requestId.error, 400);

  // ---- 歌名 / 歌手 / 音源 id：一律以服务端签发的选曲凭据为准（A7 闭环） ----
  //
  // 为什么"以凭据为准"而不是"比对是否一致"：
  //   凭据是搜索接口对"这一首候选"的签名背书，歌名/歌手/音源 id 在签名时
  //   就已经绑定在一起。以它为准，客户端就没有任何机会把这几个字段拆开重组
  //   （比如歌名填一首热门的、音源 id 指向另一首）。
  //   请求体里那三个字段仍然照旧接收，但**只用于出问题时对照排查**，
  //   一个字节都不会入库。
  //
  // 为什么现在是**强制**的（兼容分支已经按计划删除）：
  //   过渡期这里曾经保留"没带凭据就按老规则各自校验三个字段"的分支，
  //   那是为了不让线上旧版 vote.html 立刻全部点歌失败。
  //   vote.html 已经改成提交 track_token（两处选曲入口都会带上凭据），
  //   所以兼容分支的历史使命结束了。留着反而是个洞：攻击者只要不带凭据，
  //   就能退回"三字段各查各的格式"，A7 又变成 opt-in。
  //   现在没有凭据 = 没真的选过一首，直接拒绝。
  //
  // 凭据字段名：正名是 track_token（与 track_id / recaptcha_token 同一命名风格），
  // 同时接受 trackToken / token 两种写法 —— 三者语义完全相同、不会互相歧义。
  //
  // 「字段不存在」与「字段是空串」都算"没带凭据"；
  // 但**字段存在却不是字符串**属于客户端把参数写错了，也按"凭据不正确"报错。
  let rawToken = '';
  for (const field of ['track_token', 'trackToken', 'token']) {
    const value = data[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') {
      return error('选曲凭据不正确，请重新搜索并选一首再提交', 400);
    }
    if (!value.trim()) continue;
    rawToken = value.trim();
    break;
  }

  // 三种失败原因（缺失 / 过期 / 被篡改）对用户的意义不同，分别说清楚 ——
  // 但**绝不静默降级**：静默降级会让"防篡改"形同虚设，
  // 攻击者只要塞一张坏凭据，服务端就退回老路。
  if (!rawToken) {
    return error('缺少选曲凭据：请先点「搜索歌曲」，从搜索结果里选一首再提交', 400);
  }

  const verified = await verifyTrackToken(env, rawToken);
  if (!verified.ok) return error(verified.error, 400);

  // verifyTrackToken 内部已经用入库标准（sanitizeText / parseTrackId）收敛过一遍，
  // 这里直接采用，不再接受请求体里的同名字段。
  //
  // 注意：调试模式同样要求凭据 —— 调试模式要放开的是"每周限次"和"查重"，
  // 不是"音源一致性"。凭据里本来就带音源 id，调试时也一样能选歌。
  const title = { ok: true, value: verified.value.title };
  const artist = { ok: true, value: verified.value.artist };
  const trackId = { ok: true, value: verified.value.trackId };

  const category = parsePositiveInt(data.category_id ?? 2, { field: '分类', max: 100000 });
  if (!category.ok) return error(category.error, 400);

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
  // 注意：这一步在调试模式分支**之前**，所以正式提交与调试提交都要过这一关。
  // 对带凭据的请求同样生效 —— 凭据内容也要照常过违禁词，
  // 否则"签过名的内容"就成了绕开黑名单的通道。
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

  // ---- 幂等重放：这一次提交其实已经成功过（A8） ----
  //
  // 放在黑名单与分类校验**之后**：那些是"当前策略"，策略变了就该按新策略答复，
  // 不能拿"上次通过了"当挡箭牌。放在真正写入**之前**：重放不该再占一次名额。
  //
  // 判定依据完全来自已有的去重记录，不需要额外的幂等表：
  //   ① 这台设备（ip + 指纹）在本周期内已经占过名额 —— 说明它已经提交过一次；
  //   ② 库里已经有同名同歌手的歌 —— 说明那次的歌确实落库了。
  // 两条同时成立，就是"同一个 request_id 的第二次到达"最合理的解释。
  // 单条查询搞定，避免多花一次往返。
  if (requestId.value) {
    const replay = await env.DB.prepare(
      `SELECT
         (SELECT 1 FROM vote_logs
           WHERE ip = ? AND fingerprint = ?
             AND datetime(created_at) > datetime('now', ?)) AS claimed,
         (SELECT 1 FROM songs WHERE title = ? AND artist = ?) AS exists_song`
    ).bind(ip, fingerprint.value, `-${DEDUP_WINDOW_DAYS} days`, title.value, artist.value).first();

    if (replay && replay.claimed && replay.exists_song) {
      // 说清楚"没有再记一次"：counted=false 表示这次没有产生任何新的副作用。
      return json({
        ok: true,
        duplicate: true,
        counted: false,
        message: '这次点歌之前已经提交成功了（幂等重放，未重复计入）',
      });
    }
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

  // ---- 原子写入：插歌 + 占名额 ----
  const params = {
    classId,
    title: title.value,
    artist: artist.value,
    categoryId: category.value,
    trackId: trackId.value,
    ip,
    fingerprint: fingerprint.value,
    userAgent: header(request, 'User-Agent', 300),
  };

  let outcome;
  try {
    outcome = await insertAndClaim(env, params, { withTrack: true });
  } catch (err) {
    if (!isMissingColumn(err)) throw err;
    // 009 还没执行：退回不含 track_id 的写法。
    // 语句顺序保证了此时**什么都没写进去**（见 insertAndClaim 的说明）。
    outcome = await insertAndClaim(env, params, { withTrack: false });
  }

  const inserted = changedRows(outcome.insert);
  const claimed = changedRows(outcome.claim);

  if (inserted === 1 && claimed === 1) return json({ ok: true });

  // ---- 有一半没生效：必须把已经生效的那一半撤掉 ----
  // 这就是"条件更新影响 0 行不是 SQL 错误"的具体体现：
  // batch 会正常返回，只有 meta.changes 会告诉我们某一步其实没做成。

  if (inserted === 1 && claimed === 0) {
    // 歌插进去了，名额没抢到：要么设备本周已经点过，要么并发请求刚把名额拿走。
    // 撤掉刚插入的这首歌，回到请求前的状态，再按"本周已点过"答复。
    // 不撤的话，用户会看到失败、却发现自己少了一周额度 —— 正是要修的毛病。
    const rollback = await env.DB.prepare('DELETE FROM songs WHERE id = ?')
      .bind(lastRowId(outcome.insert)).run();
    if (changedRows(rollback) !== 1) {
      // 补偿也失败了：如实报错，不要假装只是"本周已点过"。
      return error('提交未生效，且插入的歌曲未能撤回，请联系管理员核查（请勿重复提交）', 500);
    }
    return error('您本周已经点过歌啦，每人每周只能点一次哦！', 429);
  }

  if (claimed === 1) {
    // 歌没插进去（同名同歌手已存在）→ 把刚占掉的名额还回去，
    // 否则用户白白浪费一周。
    const claimedId = lastRowId(outcome.claim);
    if (claimedId > 0) {
      const rollback = await env.DB.prepare('DELETE FROM vote_logs WHERE id = ?')
        .bind(claimedId).run();
      if (changedRows(rollback) !== 1) {
        return error('提交未生效，且本周名额未能释放，请联系管理员核查', 500);
      }
    }
    return error('这首歌已经在待审核队列里啦', 400);
  }

  // inserted === 0 且 claimed === 0：两条都没生效，没有任何副作用。
  return error('这首歌已经在待审核队列里啦', 400);
}

/**
 * 插歌 + 占名额，两条语句放进同一个 batch。
 *
 * 为什么用 batch：D1 的 batch 在**一个事务里**顺序执行，正常路径上不会
 * 出现"只占了名额没插歌"或"只插了歌没占名额"的中间状态。
 *
 * 但 batch 不是万能的，两点必须记住：
 *  1. `WHERE NOT EXISTS (...)` 这类条件语句**影响 0 行不算失败**，
 *     batch 照样返回成功。所以调用方必须逐条检查 meta.changes（下面返回原始结果）。
 *  2. 检测到没成功之后，batch 已经提交了（部分语句可能已生效），
 *     只能在应用层做**补偿**（删除已经写进去的那一半）。
 *
 * 语句顺序是刻意的：**先插歌、后占名额**。
 *  · 若 009 迁移没跑，第一条语句就因为 no such column 失败，
 *    此时名额还没被占用 —— 不会出现"没歌却消耗了额度"。若反过来先占名额，
 *    第一条失败时名额已经不干净了（事务能回滚，但本地 D1 替身与异常路径
 *    未必，靠事务兜底不如靠顺序）。
 *  · 反过来"歌插了、名额没占到"的补偿是删歌，删歌比"把名额还回去"更安全：
 *    名额记录是用户唯一凭证，误删影响一周；歌曲被误删只是白提交一次。
 */
async function insertAndClaim(env, params, { withTrack }) {
  const insertSql = withTrack
    ? `INSERT INTO songs (class_id, title, artist, category_id, status, track_id)
       SELECT ?, ?, ?, ?, 'pending', ?
        WHERE NOT EXISTS (
              SELECT 1 FROM songs WHERE title = ? AND artist = ?
        )`
    : `INSERT INTO songs (class_id, title, artist, category_id, status)
       SELECT ?, ?, ?, ?, 'pending'
        WHERE NOT EXISTS (
              SELECT 1 FROM songs WHERE title = ? AND artist = ?
        )`;

  const insertParams = withTrack
    ? [params.classId, params.title, params.artist, params.categoryId, params.trackId,
       params.title, params.artist]
    : [params.classId, params.title, params.artist, params.categoryId,
       params.title, params.artist];

  // 原子占名额：检查与写入合成一条语句，杜绝并发穿透。
  const claimSql =
    `INSERT INTO vote_logs (class_id, ip, fingerprint, user_agent)
     SELECT ?, ?, ?, ?
      WHERE NOT EXISTS (
            SELECT 1 FROM vote_logs
             WHERE ip = ? AND fingerprint = ?
               AND datetime(created_at) > datetime('now', ?)
      )`;

  const results = await env.DB.batch([
    env.DB.prepare(insertSql).bind(...insertParams),
    env.DB.prepare(claimSql).bind(
      params.classId,
      params.ip,
      params.fingerprint,
      params.userAgent,
      params.ip,
      params.fingerprint,
      `-${DEDUP_WINDOW_DAYS} days`
    ),
  ]);

  return { insert: results[0], claim: results[1] };
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
