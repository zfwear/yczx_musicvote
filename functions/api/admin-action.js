import { readJson, error, json } from '../../_lib/http.js';
import { requireStaff } from '../../_lib/auth.js';
import { parsePositiveInt, parseEnum } from '../../_lib/validate.js';
import { changedRows } from '../../_lib/db.js';

/** 审核动作：通过 / 拒绝 / 恢复。 */
const NEXT_STATUS = {
  approve: 'approved',
  reject: 'rejected',
  restore: 'pending',
};

/**
 * 后台审核与回收站处置。
 *
 * 注意区分两个概念（它们是完全独立的两套数据）：
 *   · 回收站 = songs 表里 status='rejected' 的歌曲。可以恢复、可以彻底删除。
 *   · 黑名单 = banned_items 表。是"禁止再提交某歌手/某歌名"的规则，
 *     跟某首歌在不在回收站毫无关系。黑名单在 admin-settings 里管理。
 *
 * 永久删除会连同这首歌的关联记录一起清掉，避免留下孤儿数据。
 * 审计报告 B4：单首删除与「清空回收站」**必须共用同一套清理逻辑** ——
 * 原来单首删会清投票 + 举报，清空回收站只清举报，于是批量清空之后
 * upvote_logs / song_suggestions / weekly_playlist 里全是已经不存在
 * 的歌曲 id：建议列表点进去是空歌、周歌单位置上留着幽灵条目，
 * 而且这些脏数据的量会随着"攒一批再清"越来越大。
 */
export async function onRequestPost(context) {
  const { request, env } = context;

  const auth = await requireStaff(env, request);
  if (!auth.ok) return auth.response;

  const parsed = await readJson(request);
  if (!parsed.ok) return error(parsed.error, 400);

  const allowed = [...Object.keys(NEXT_STATUS), 'clear_report', 'delete', 'empty_recycle'];
  const action = parseEnum(parsed.value.type, allowed, { field: '操作' });
  if (!action.ok) return error(action.error, 400);

  // 清空回收站不需要 id，先处理。
  if (action.value === 'empty_recycle') {
    const ids = await selectRejectedIds(env);
    const result = await env.DB.prepare("DELETE FROM songs WHERE status = 'rejected'").run();

    // 先删歌再清关联：万一中间失败，也只是留下孤儿记录（可以被下次清理捡走），
    // 反过来先清关联再删歌则可能删掉"其实没删成"的歌的投票与建议。
    await cleanSongReferences(env, ids);

    // 兜底扫一遍历史孤儿记录（指向已不存在的歌的行）——
    // 即使这一轮没有 rejected 的歌也照扫，脏数据不会越攒越多。
    await sweepOrphanSongReferences(env);

    return json({ ok: true, deleted: changedRows(result) });
  }

  const id = parsePositiveInt(parsed.value.id, { field: '歌曲' });
  if (!id.ok) return error(id.error, 400);

  if (action.value === 'clear_report') {
    const cleared = await env.DB.prepare('UPDATE songs SET is_reported = 0 WHERE id = ?')
      .bind(id.value).run();
    if (changedRows(cleared) === 0) return error('歌曲不存在', 404);
    return json({ ok: true, action: 'clear_report' });
  }

  if (action.value === 'delete') {
    const song = await env.DB.prepare('SELECT id, title FROM songs WHERE id = ?')
      .bind(id.value).first();
    if (!song) return error('歌曲不存在', 404);

    await env.DB.prepare('DELETE FROM songs WHERE id = ?').bind(id.value).run();
    await cleanSongReferences(env, [id.value]);
    await sweepOrphanSongReferences(env);

    return json({ ok: true, message: `已彻底删除「${song.title}」` });
  }

  const nextStatus = NEXT_STATUS[action.value];

  const result = await env.DB.prepare('UPDATE songs SET status = ? WHERE id = ?')
    .bind(nextStatus, id.value).run();

  if (changedRows(result) === 0) return error('歌曲不存在', 404);

  return json({ ok: true, status: nextStatus });
}

/** 取回收站里全部歌曲 id（清空前的快照，用来清关联记录）。 */
async function selectRejectedIds(env) {
  const { results } = await env.DB.prepare(
    "SELECT id FROM songs WHERE status = 'rejected'"
  ).all();
  return (results || [])
    .map((row) => Number(row.id))
    .filter((id) => Number.isInteger(id) && id > 0);
}

/**
 * 清理一批歌曲 id 在各个关联表里的记录 —— 单首删除与清空回收站共用。
 *
 * 用 song_id IN (...) 分批处理：D1 的 SQL 变量数上限是 100，
 * 而"清空回收站"可能一次涉及上百首，所以按 90 一批切开来发。
 * 关联表的名字集中在 SONG_CHILD_TABLES 里，以后再加表只改这一处。
 */
const SONG_CHILD_TABLES = ['upvote_logs', 'report_logs', 'song_suggestions'];

async function cleanSongReferences(env, ids) {
  const list = ids.map(Number).filter((id) => Number.isInteger(id) && id > 0);
  if (!list.length) return;

  const BATCH = 90;

  for (let i = 0; i < list.length; i += BATCH) {
    const chunk = list.slice(i, i + BATCH);
    const placeholders = chunk.map(() => '?').join(',');

    for (const table of SONG_CHILD_TABLES) {
      await runTolerant(env, `DELETE FROM ${table} WHERE song_id IN (${placeholders})`, chunk);
    }

    // 周歌单只是"某个位置排了这首歌"，把引用清空即可 ——
    // schedule.js 本来就支持 song_id 为 NULL 的空位，不需要删掉整行。
    await runTolerant(
      env,
      `UPDATE weekly_playlist SET song_id = NULL, updated_at = datetime('now')
        WHERE song_id IN (${placeholders})`,
      chunk
    );
  }
}

/**
 * 清掉"指向一首已经不在 songs 里的歌"的历史孤儿记录。
 *
 * 为什么需要它：以前的版本清空回收站时只清举报、单首删除也只清举报与投票，
 * 所以 song_suggestions、weekly_playlist 以及更早的 upvote_logs 里
 * 已经攒下了一批指向不存在歌曲的行。删除动作顺手扫一遍，
 * 这些脏数据就不会一直挂在建议列表 / 周歌单里。
 *
 * 用 NOT EXISTS 而不是 NOT IN：这几张表的 song_id 都是 NOT NULL，
 * 两者语义一致，但 NOT EXISTS 让 SQLite 能走 songs 的主键做半连接，
 * 不必为每一行重建一份子查询结果 —— 免费套餐的 CPU 预算经不起后者。
 */
async function sweepOrphanSongReferences(env) {
  for (const table of SONG_CHILD_TABLES) {
    await runTolerant(
      env,
      `DELETE FROM ${table}
        WHERE NOT EXISTS (SELECT 1 FROM songs WHERE songs.id = ${table}.song_id)`
    );
  }
}

/**
 * 执行一条"表可能还没建"的语句。
 *
 * 交付包是分步迁移的（001 ~ 013），有的人可能还停在 010：
 * song_suggestions(011) / weekly_playlist(012) 不存在时整条语句会报
 * no such table，而"删除歌曲"不该因此失败 —— 跳过即可，
 * 其它错误照旧抛出去，不能把真正的问题吞掉。
 */
async function runTolerant(env, sql, params = []) {
  try {
    const stmt = env.DB.prepare(sql);
    await (params.length ? stmt.bind(...params) : stmt).run();
  } catch (err) {
    if (/no such table/i.test(String((err && err.message) || ''))) return;
    throw err;
  }
}
