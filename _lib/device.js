/**
 * 设备-姓名绑定（4.0.0，用户 2026-10-17 确认的规则）。
 *
 * 规则原话：
 *   「同设备登一个姓名，但是一个姓名可以登录不同设备；
 *     设备姓名绑定在登录时就锁定，三天后解锁，每次投票这个设备只能登录一个名字。」
 *
 * 落地方式：
 *   · 表 device_identities 主键 (fingerprint, class_id)：
 *     一台设备在同一个班里只能有一个姓名；不同班级互不影响。
 *   · expires_at = 绑定时刻 + 3 天。同一姓名再次登录**不续期** ——
 *     “三天后解锁”是从第一次绑定开始算的固定窗口，不是滑动窗口；
 *     否则一个常用设备会把窗口无限续下去，别人永远等不到解锁。
 *   · 一个姓名没有唯一约束：同一姓名可以在多台设备上登录、投票。
 *   · 登录时先落绑定，投票时再校验一次（防止老会话/换指纹绕过）。
 *
 * 迁移未执行（017 没跑）时所有函数都降级为“不处理”，登录与投票
 * 不因此报错 —— 与项目里其它增量功能的降级方式一致。
 */

import { isMissingTable, changedRows } from './db.js';

/** 绑定锁定天数。 */
export const DEVICE_BIND_DAYS = 3;

/** SQLite 的 datetime('now') 是 UTC 的 `YYYY-MM-DD HH:MM:SS`，补成 ISO 再比较。 */
function expiresAtMs(value) {
  const raw = String(value || '').trim();
  if (!raw) return 0;
  const iso = raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z';
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * 登录/投票时确保这台设备在本班绑定的是这个姓名。
 *
 * @returns {Promise<{ok:boolean, bound?:boolean, skipped?:boolean, conflict?:boolean, current?:string}>}
 *   conflict=true 表示设备近三天绑定的是另一个姓名，调用方应拒绝。
 */
export async function ensureDeviceIdentity(env, { fingerprint, classId, username }) {
  const fp = String(fingerprint || '').trim();
  const cid = Number(classId);
  const name = String(username || '').trim();
  if (!fp || !Number.isInteger(cid) || cid <= 0 || !name) return { ok: true, skipped: true };

  try {
    const row = await env.DB.prepare(
      'SELECT username, expires_at FROM device_identities WHERE fingerprint = ? AND class_id = ?'
    ).bind(fp, cid).first();

    if (row) {
      const current = String(row.username || '');
      const expired = expiresAtMs(row.expires_at) <= Date.now();
      if (!expired && current !== name) {
        return { ok: false, conflict: true, current };
      }
      if (expired) {
        await env.DB.prepare(
          `UPDATE device_identities
              SET username = ?, bound_at = datetime('now'), expires_at = datetime('now', ?)
            WHERE fingerprint = ? AND class_id = ?`
        ).bind(name, `+${DEVICE_BIND_DAYS} days`, fp, cid).run();
      }
      return { ok: true, bound: true };
    }

    await env.DB.prepare(
      `INSERT INTO device_identities (fingerprint, class_id, username, bound_at, expires_at)
       VALUES (?, ?, ?, datetime('now'), datetime('now', ?))`
    ).bind(fp, cid, name, `+${DEVICE_BIND_DAYS} days`).run();
    return { ok: true, bound: true };
  } catch (err) {
    const msg = String((err && err.message) || '');
    if (isMissingTable(err) || /no such column/i.test(msg)) return { ok: true, skipped: true };
    // 并发插入撞主键：重新读一次，同一姓名算成功，不同姓名算冲突。
    if (/unique|constraint/i.test(msg)) {
      try {
        const again = await env.DB.prepare(
          'SELECT username FROM device_identities WHERE fingerprint = ? AND class_id = ?'
        ).bind(fp, cid).first();
        if (again && String(again.username) === name) return { ok: true, bound: true };
        return { ok: false, conflict: true, current: String((again && again.username) || '') };
      } catch { return { ok: true, skipped: true }; }
    }
    throw err;
  }
}

/** 管理员解绑一个姓名名下的全部设备；返回删除行数。 */
export async function unbindUserDevices(env, classId, username) {
  const cid = Number(classId);
  const name = String(username || '').trim();
  if (!Number.isInteger(cid) || cid <= 0 || !name) return 0;
  try {
    const result = await env.DB.prepare(
      'DELETE FROM device_identities WHERE class_id = ? AND username = ?'
    ).bind(cid, name).run();
    return changedRows(result);
  } catch (err) {
    if (isMissingTable(err)) return 0;
    throw err;
  }
}

/** 改名时同步设备绑定与投票记录里的姓名。 */
export async function renameUserIdentity(env, classId, oldName, newName) {
  const cid = Number(classId);
  const from = String(oldName || '').trim();
  const to = String(newName || '').trim();
  if (!Number.isInteger(cid) || cid <= 0 || !from || !to) return;
  try {
    await env.DB.prepare(
      'UPDATE device_identities SET username = ? WHERE class_id = ? AND username = ?'
    ).bind(to, cid, from).run();
  } catch (err) {
    if (!isMissingTable(err)) throw err;
  }
  try {
    await env.DB.prepare(
      'UPDATE upvote_logs SET username = ? WHERE class_id = ? AND username = ?'
    ).bind(to, cid, from).run();
  } catch (err) {
    if (!/no such column|no such table/i.test(String((err && err.message) || ''))) throw err;
  }
}

/**
 * 封禁时清零这个姓名投出的票。
 *
 * 归属判定顺序：
 *   1. upvote_logs.username = 姓名（017 之后的新票，最准确）；
 *   2. 017 之前的老票 username 为 NULL —— 用该姓名当前绑定的设备指纹
 *      兜底删除（同一设备在本班曾经投过的票）。这是“能确定”的最大范围；
 *      设备绑定过期后旧指纹无法再归属，不猜、不误删。
 *
 * 删除投票行的同时按首歌扣减 songs.votes，最后用 MAX(0, …) 防止
 * 历史上已被重置/封顶的票把票数扣成负数。
 *
 * @returns {Promise<{removed:number, songs:number}>}
 */
export async function clearUserVotes(env, classId, username) {
  const cid = Number(classId);
  const name = String(username || '').trim();
  if (!Number.isInteger(cid) || cid <= 0 || !name) return { removed: 0, songs: 0 };

  let fingerprints = [];
  try {
    const { results } = await env.DB.prepare(
      'SELECT fingerprint FROM device_identities WHERE class_id = ? AND username = ?'
    ).bind(cid, name).all();
    fingerprints = (results || []).map((r) => String(r.fingerprint || '')).filter(Boolean);
  } catch (err) {
    if (!isMissingTable(err)) throw err;
  }

  const clauses = ['username = ?'];
  const binds = [cid, name];
  if (fingerprints.length) {
    clauses.push(`(username IS NULL AND fingerprint IN (${fingerprints.map(() => '?').join(',')}))`);
    binds.push(...fingerprints);
  }

  let rows = [];
  try {
    const res = await env.DB.prepare(
      `SELECT id, song_id FROM upvote_logs
        WHERE class_id = ? AND (${clauses.map((c) => `(${c})`).join(' OR ')})`
    ).bind(...binds).all();
    rows = res.results || [];
  } catch (err) {
    const msg = String((err && err.message) || '');
    if (!/no such column|no such table/i.test(msg)) throw err;
    // 017 只跑了一半（没有 username 列）：退回按当前绑定指纹清。
    if (!fingerprints.length) return { removed: 0, songs: 0 };
    try {
      const res = await env.DB.prepare(
        `SELECT id, song_id FROM upvote_logs
          WHERE class_id = ? AND fingerprint IN (${fingerprints.map(() => '?').join(',')})`
      ).bind(cid, ...fingerprints).all();
      rows = res.results || [];
    } catch { return { removed: 0, songs: 0 }; }
  }

  if (!rows.length) return { removed: 0, songs: 0 };

  const perSong = new Map();
  for (const row of rows) {
    const sid = Number(row.song_id);
    if (!Number.isInteger(sid) || sid <= 0) continue;
    perSong.set(sid, (perSong.get(sid) || 0) + 1);
  }

  // D1 单条 SQL 变量上限 100：按 90 一批删。
  const ids = rows.map((r) => Number(r.id)).filter((n) => Number.isInteger(n) && n > 0);
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    try {
      await env.DB.prepare(
        `DELETE FROM upvote_logs WHERE id IN (${chunk.map(() => '?').join(',')})`
      ).bind(...chunk).run();
    } catch (err) {
      if (!isMissingTable(err)) throw err;
      break;
    }
  }

  for (const [sid, count] of perSong) {
    await env.DB.prepare(
      'UPDATE songs SET votes = MAX(0, CAST(votes AS INTEGER) - ?) WHERE id = ?'
    ).bind(count, sid).run();
  }

  return { removed: ids.length, songs: perSong.size };
}
