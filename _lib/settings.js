/**
 * 系统设置读写（system_settings 表）。
 *
 * 目前只有一个键：投票上限（vote_cap）。
 *
 * 语义：**超过上限的那部分票不计入票数** —— 票照收，但学生端显示、
 * 待审核榜排序、正式榜排序都用封顶后的值（即"有效票数"）。
 * 这样即使有人刷票，数字也不会离谱到超过"全校人数"这种不可能的数值，
 * 榜单顺序也不会被刷票量主导。
 *
 * 排序用的表达式见 effectiveVotesExpr()：它必须出现在 ORDER BY 与
 * LIMIT 之前，而不是等取完数据再在应用层改数字（A6 修的就是这个）。
 */

import { isMissingTable } from './db.js';

export const SETTING_VOTE_CAP = 'vote_cap';
export const SETTING_REPORT_THRESHOLD = 'report_threshold';
/**
 * 「暂停接收投稿」开关（2026-10-07 用户要求，以按钮形式给管理员）。
 *
 * 为什么要有它：广播站的排期是有节奏的 —— 一周的 6 首排满之后再收投稿，
 * 只会让待审核列表堆一堆下一周用不上的歌；考试周、放假前后也需要临时停收。
 * 以前只能靠"把班级口令换掉"或让管理员盯着，都不是办法。
 *
 * 取值：'1' = 暂停，其它（含没配过）= 正常接收。**默认必须是"正常接收"** ——
 * 表不存在（007 没跑）时 getSetting 会返回 fallback，所以默认值只能是"不收着"，
 * 否则一次迁移没跑就会把全校的投稿功能关掉。
 */
export const SETTING_SUBMISSIONS_PAUSED = 'submissions_paused';

/** 举报进入收件箱所需的"被举报次数"阈值。默认 3，可后台调整。 */
export const DEFAULT_REPORT_THRESHOLD = 3;

/** 读一个设置；表不存在（迁移没跑）时返回默认值，不抛异常。 */
export async function getSetting(env, key, fallback = null) {
  try {
    const row = await env.DB.prepare('SELECT value FROM system_settings WHERE key = ?')
      .bind(key).first();
    return row ? row.value : fallback;
  } catch (err) {
    if (isMissingTable(err)) return fallback;
    throw err;
  }
}

export async function setSetting(env, key, value) {
  await env.DB.prepare(
    `INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  ).bind(key, String(value)).run();
}

/**
 * 取投票上限。返回 0 表示**不限制**。
 */
export async function getVoteCap(env) {
  const raw = await getSetting(env, SETTING_VOTE_CAP, '');
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/**
 * 「有效票数」的 SQL 表达式 —— 票数封顶必须参与**排序与截取**。
 *
 * 为什么需要它（审计遗留问题 A6）：
 *   旧实现是"先按原始票数排序、截取前 50 条，再把显示票数改成封顶值"。
 *   结果是刷到 9999 票的歌**照样占据榜单前几位**，封顶只改了数字，
 *   排序结果仍然由刷票量决定 —— 等于封顶形同虚设。
 *   所以排序表达式、截取前的排序键都必须用 MIN(votes, cap)。
 *
 * cap <= 0 表示不限制，直接用原始票数。
 *
 * cap 直接内联进 SQL 而不是占一个 `?`：它已经由 getVoteCap() 收敛成
 * 0 或正整数（非法值一律当 0），内联可以避免每个查询都要数一遍
 * 绑定参数的先后顺序 —— 那种错位非常难排查，而这里没有任何注入面。
 *
 * CAST 成 INTEGER 是老规矩：SQLite 是动态类型，数值列理论上可能存进文本，
 * 而这些值会被拼进 HTML 与 JS 调用，强制转整数从根上断掉此类问题。
 */
export function effectiveVotesExpr(cap) {
  const raw = 'CAST(s.votes AS INTEGER)';
  if (!Number.isInteger(cap) || cap <= 0) return raw;
  return `MIN(${raw}, ${cap})`;
}

/** 把一组带 votes 的行按上限封顶（票照收，但不作数）。 */
export function applyVoteCap(rows, cap) {
  if (!cap || cap <= 0) return rows;
  return rows.map((row) => {
    const raw = Number(row.votes);
    if (!Number.isFinite(raw) || raw <= cap) return row;
    return { ...row, votes: cap, votes_raw: Math.trunc(raw), votes_capped: 1 };
  });
}

/** 取举报进收件箱的阈值。 */
export async function getReportThreshold(env) {
  const raw = await getSetting(env, SETTING_REPORT_THRESHOLD, '');
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 2 && n <= 20) return n;
  return DEFAULT_REPORT_THRESHOLD;
}

/**
 * 现在是否**暂停接收投稿**。
 *
 * 读不到（system_settings 表还没建）时返回 false ——
 * 也就是"照常接收"。理由见 SETTING_SUBMISSIONS_PAUSED 的注释：
 * 默认值落在"不影响正常使用"的那一侧。
 */
export async function isSubmissionsPaused(env) {
  const raw = await getSetting(env, SETTING_SUBMISSIONS_PAUSED, '');
  return String(raw) === '1';
}
