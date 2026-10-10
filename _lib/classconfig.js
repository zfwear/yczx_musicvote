/**
 * 班级维度与全站维度的投稿/投票限制（2026-10-10 需求）。
 *
 * 三道闸的分工（投稿走 ①②③，投票只走 ①）：
 *   ① 班级暂停：classes.paused = 1 → 该班不能投票、不能投稿；
 *   ② 班级上限：已投 ≥ vote_limit / 已投 ≥ submit_limit → 拦截；
 *   ③ 全站投稿上限：全站累计投稿 ≥ submit_cap → 拦截投稿。
 *
 * 通用约定（与 denyGuest / isSubmissionsPaused 同一套哲学）：
 *   · 这些检查都放在读请求体、限流与任何写入**之前**，
 *     被拒的请求不留下限流计数，更不落库；
 *   · 配置缺失 / 迁移没跑 / 人数没填 → 一律按"不限制"处理，
 *     配置坏了不能把正常用户挡在门外（只会少一道闸，不会多拦一个人）。
 */

import { evalLimit } from './limits.js';
import { getSetting, SETTING_SUBMIT_CAP } from './settings.js';

/** 班级行缺失列的统一判据。 */
function isMissingColumnError(err) {
  return /no such column|has no column named/i.test(String((err && err.message) || ''));
}

/**
 * 读一个班级的限制配置。
 * @returns {Promise<{found:boolean, paused:boolean, voteLimit:number, submitLimit:number, memberCount:number|null}>}
 *   found=false 表示班级不存在或查询失败（此时不做任何班级级拦截）。
 */
export async function getClassLimits(env, classId) {
  const id = Number(classId);
  if (!Number.isInteger(id) || id <= 0) {
    return { found: false, paused: false, voteLimit: 0, submitLimit: 0, memberCount: null };
  }
  try {
    const row = await env.DB.prepare(
      'SELECT name, member_count, vote_limit, submit_limit, paused FROM classes WHERE id = ?'
    ).bind(id).first();
    if (!row) return { found: false, paused: false, voteLimit: 0, submitLimit: 0, memberCount: null };
    const memberCount = row.member_count === null || row.member_count === undefined
      ? null
      : Number(row.member_count);
    return {
      found: true,
      paused: Number(row.paused) === 1,
      voteLimit: evalLimit(row.vote_limit, memberCount),
      submitLimit: evalLimit(row.submit_limit, memberCount),
      memberCount: Number.isFinite(memberCount) ? memberCount : null,
    };
  } catch (err) {
    if (isMissingColumnError(err)) {
      // 015 未执行：班级存在，但没有任何新配置 —— 全部按默认放行。
      return { found: true, paused: false, voteLimit: 0, submitLimit: 0, memberCount: null };
    }
    throw err;
  }
}

/** 全站累计投稿数（不含调试投稿；songs 表没有 is_debug 列时统计全部）。 */
export async function countGlobalSubmissions(env) {
  try {
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM songs WHERE COALESCE(is_debug, 0) = 0"
    ).first();
    return Number((row && row.n) || 0);
  } catch (err) {
    if (isMissingColumnError(err)) {
      const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM songs').first();
      return Number((row && row.n) || 0);
    }
    return 0;                                     // 表都没有：按 0 处理，不拦
  }
}

/** 读全局投稿上限（0 = 不限制）。 */
export async function getSubmitCapRaw(env) {
  return String(await getSetting(env, SETTING_SUBMIT_CAP, '') || '').trim();
}

/**
 * 全站投稿上限的有效数值（x = 全站有效班级总人数，即填了人数的班级之和）。
 * @returns {Promise<{cap:number, raw:string, totalMembers:number}>}
 */
export async function getSubmitCap(env) {
  const raw = await getSubmitCapRaw(env);
  let totalMembers = 0;
  let membersKnown = false;
  try {
    const row = await env.DB.prepare(
      'SELECT SUM(COALESCE(member_count, 0)) AS n, COUNT(*) AS c FROM classes'
    ).first();
    totalMembers = Number((row && row.n) || 0);
    membersKnown = Number((row && row.c) || 0) > 0;
  } catch { /* classes 表不可用时 x 按 0 处理 → 表达式上限求值为 0（不限制） */ }
  return { cap: evalLimit(raw, totalMembers), raw, totalMembers, membersKnown };
}

/** 某班级累计投稿数（不含调试投稿）。 */
export async function countClassSubmissions(env, classId) {
  const id = Number(classId);
  if (!Number.isInteger(id) || id <= 0) return 0;
  try {
    const row = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM songs WHERE class_id = ? AND COALESCE(is_debug, 0) = 0'
    ).bind(id).first();
    return Number((row && row.n) || 0);
  } catch (err) {
    if (isMissingColumnError(err)) {
      const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM songs WHERE class_id = ?')
        .bind(id).first();
      return Number((row && row.n) || 0);
    }
    return 0;
  }
}

/** 某班级累计投票数（upvote_logs 按班级记录）。 */
export async function countClassVotes(env, classId) {
  const id = Number(classId);
  if (!Number.isInteger(id) || id <= 0) return 0;
  try {
    const row = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM upvote_logs WHERE class_id = ?'
    ).bind(id).first();
    return Number((row && row.n) || 0);
  } catch {
    return 0;
  }
}
