/**
 * 系统设置读写（system_settings 表）。
 *
 * 目前只有一个键：投票上限（vote_cap）。
 *
 * 语义：**超过上限的那部分票不计入票数** —— 票照收，但学生端显示与
 * 正式榜排序都用封顶后的值。这样即使有人刷票，数字也不会离谱到
 * 超过"全校人数"这种不可能的数值。
 */

import { isMissingTable } from './db.js';

export const SETTING_VOTE_CAP = 'vote_cap';

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

/** 把一组带 votes 的行按上限封顶（票照收，但不作数）。 */
export function applyVoteCap(rows, cap) {
  if (!cap || cap <= 0) return rows;
  return rows.map((row) => {
    const raw = Number(row.votes);
    if (!Number.isFinite(raw) || raw <= cap) return row;
    return { ...row, votes: cap, votes_raw: Math.trunc(raw), votes_capped: 1 };
  });
}
