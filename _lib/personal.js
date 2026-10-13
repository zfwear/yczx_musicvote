/**
 * 个人口令 + 个人配色（MD3 项目，2026-10-14 用户确认的 19 项决策）。
 *
 * 设计要点（每条都对应一个用户决策，改动前先读这段）：
 *  · 登录标识 = 「班级口令@用户名」，**库里只存 (class_id, username)** ——
 *    管理员改班级口令内容后前缀自动跟随，无需批量更新（决策 5/8）；
 *  · 用户名允许中文等（决策 5），**不能含 @ 与空白**，1~20 位：
 *    登录解析按第一个 @ 拆分才没有歧义；
 *  · 同一班级内用户名唯一（决策 6）；
 *  · 无独立密码：知道班级口令即可登录任一已知用户名（决策 7）；
 *  · 班级被删 → 个人口令置为"未绑定态"（class_id<=0，登录标识显示
 *    yczxuser@用户名，暂不可登录），管理员在后台重新绑定（决策 8）；
 *    class_id 用 0 表示"普通未绑定"，负数表示"原班级 id 的负值"——
 *    两个班都删且各有一条同名口令时，唯一索引 (class_id, username) 不会撞车；
 *  · 删除个人口令 = 真删（登录立即失效）；**配色记录保留**，
 *    键是 (class_id, username) 而非口令 id —— 同名重建能读回旧配色（决策 9）；
 *    重新绑定时把配色行迁移到新班级键下；
 *  · 016 未执行的部署：所有函数不抛"no such table"，按"功能不存在"降级。
 */
import { isMissingTable } from './db.js';

/** 用户名：中文、字母、数字、下划线、短横线；1~20 位（决策 5）。 */
export const PERSONAL_USERNAME_RE = /^[\u4e00-\u9fa5A-Za-z0-9_-]{1,20}$/;

/** 未绑定态在登录标识里显示的前缀（保留前缀，不允许被当作真实班级口令使用）。 */
export const UNBOUND_PREFIX = 'yczxuser';

const COLS = 'id, class_id, username, created_at';

/**
 * 解析「班级口令@用户名」。
 * 约定：按**第一个** @ 拆分；前缀、后缀都非空，且后缀不再含 @（用户名禁止 @）。
 * 返回 null 表示"这不像个人口令"，调用方照旧走其它登录路径。
 */
export function parsePersonalLogin(secret) {
  const s = String(secret ?? '');
  const at = s.indexOf('@');
  if (at <= 0 || at === s.length - 1) return null;
  const prefix = s.slice(0, at);
  const username = s.slice(at + 1);
  if (!prefix || !username || username.includes('@')) return null;
  return { prefix, username };
}

/** 按（班级 id + 用户名）找一条个人口令；016 未执行/查不到都是 null。 */
export async function findPersonalByClassAndName(env, classId, username) {
  try {
    return await env.DB.prepare(`SELECT ${COLS} FROM personal_passes WHERE class_id = ? AND username = ?`)
      .bind(Number(classId), String(username)).first();
  } catch (err) {
    if (isMissingTable(err)) return null;
    throw err;
  }
}

/** 未绑定态里按用户名找（class_id <= 0，含负值）；用于 yczxuser@xxx 的提示语。 */
export async function findUnboundByName(env, username) {
  try {
    return await env.DB.prepare(`SELECT ${COLS} FROM personal_passes WHERE class_id <= 0 AND username = ? ORDER BY id LIMIT 1`)
      .bind(String(username)).first();
  } catch (err) {
    if (isMissingTable(err)) return null;
    throw err;
  }
}

/** 按 id 取一条个人口令（会话校验/后台操作用）。 */
export async function getPersonalById(env, id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  return await env.DB.prepare(`SELECT ${COLS} FROM personal_passes WHERE id = ?`).bind(n).first();
}

/** 唯一索引撞车（D1 与 node:sqlite 的报错文案都覆盖）。 */
const isUniqueError = (err) => /unique|constraint/i.test(String((err && err.message) || ''));

/** 创建：调用方先校验班级存在与用户名格式；这里只管唯一冲突与落库。 */
export async function createPersonalPass(env, classId, username) {
  try {
    await env.DB.prepare('INSERT INTO personal_passes (class_id, username) VALUES (?, ?)')
      .bind(Number(classId), String(username)).run();
  } catch (err) {
    if (isUniqueError(err)) return { ok: false, conflict: true };
    throw err;
  }
  const row = await env.DB.prepare(`SELECT ${COLS} FROM personal_passes WHERE class_id = ? AND username = ?`)
    .bind(Number(classId), String(username)).first();
  return { ok: true, row };
}

/** 真删除（登录撤销由调用方做）；配色记录不动（决策 9）。 */
export async function deletePersonalPass(env, id) {
  const row = await getPersonalById(env, id);
  if (!row) return null;
  await env.DB.prepare('DELETE FROM personal_passes WHERE id = ?').bind(Number(id)).run();
  return row;
}

/** 把配色行从 (fromClass, username) 搬到 (toClass, username)；同键直接返回。 */
async function migratePrefs(env, fromClass, toClass, username) {
  if (Number(fromClass) === Number(toClass)) return;
  try {
    // 目标键已存在（新班级里已有同名记录）时，以"这一个人的旧记录"覆盖它。
    await env.DB.prepare(
      `INSERT OR REPLACE INTO personal_prefs (class_id, username, mode, preset, colors, updated_at)
       SELECT ?, username, mode, preset, colors, updated_at FROM personal_prefs WHERE class_id = ? AND username = ?`
    ).bind(Number(toClass), Number(fromClass), String(username)).run();
    await env.DB.prepare('DELETE FROM personal_prefs WHERE class_id = ? AND username = ?')
      .bind(Number(fromClass), String(username)).run();
  } catch (err) {
    if (!isMissingTable(err)) throw err;
  }
}

/** 重新绑定到新班级（后台操作）；返回旧记录（含 oldClassId），不存在返回 null。 */
export async function rebindPersonalPass(env, id, newClassId) {
  const row = await getPersonalById(env, id);
  if (!row) return null;
  const oldClassId = Number(row.class_id);
  await env.DB.prepare('UPDATE personal_passes SET class_id = ? WHERE id = ?').bind(Number(newClassId), id).run();
  await migratePrefs(env, oldClassId, Number(newClassId), row.username);
  return { ...row, oldClassId };
}

/**
 * 班级被删除时的联动（决策 8）：把该班全部个人口令与配色置为未绑定态。
 * 目标键 (0, username) 被占用时改用负值（-原 class_id），唯一索引不撞车。
 * 返回被影响的个人口令 id 列表（调用方据此撤销登录）。
 */
export async function unbindPersonalOfClass(env, classId) {
  const cid = Number(classId);
  const ids = [];
  try {
    const { results } = await env.DB.prepare('SELECT id, username FROM personal_passes WHERE class_id = ?').bind(cid).all();
    for (const row of results || []) {
      try {
        await env.DB.prepare('UPDATE personal_passes SET class_id = 0 WHERE id = ?').bind(row.id).run();
      } catch (err) {
        if (!isUniqueError(err)) throw err;
        await env.DB.prepare('UPDATE personal_passes SET class_id = -? WHERE id = ?').bind(cid, row.id).run();
      }
      ids.push(Number(row.id));
    }
    const { results: prefsRows } = await env.DB.prepare('SELECT username FROM personal_prefs WHERE class_id = ?').bind(cid).all();
    for (const row of prefsRows || []) {
      try {
        await env.DB.prepare('UPDATE personal_prefs SET class_id = 0 WHERE class_id = ? AND username = ?')
          .bind(cid, row.username).run();
      } catch (err) {
        if (!isUniqueError(err)) throw err;
        await env.DB.prepare('UPDATE personal_prefs SET class_id = -? WHERE class_id = ? AND username = ?')
          .bind(cid, cid, row.username).run();
      }
    }
  } catch (err) {
    if (!isMissingTable(err)) throw err;
  }
  return ids;
}

/** 读配色；没有记录/016 未执行都返回 null。 */
export async function getPrefs(env, classId, username) {
  try {
    return await env.DB.prepare('SELECT mode, preset, colors, updated_at FROM personal_prefs WHERE class_id = ? AND username = ?')
      .bind(Number(classId), String(username)).first();
  } catch (err) {
    if (isMissingTable(err)) return null;
    throw err;
  }
}

/** 写配色（upsert）。 */
export async function savePrefs(env, classId, username, mode, preset, colorsJson) {
  await env.DB.prepare(
    `INSERT INTO personal_prefs (class_id, username, mode, preset, colors, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(class_id, username) DO UPDATE SET
       mode = excluded.mode, preset = excluded.preset, colors = excluded.colors, updated_at = datetime('now')`
  ).bind(Number(classId), String(username), String(mode), String(preset || ''), String(colorsJson || '')).run();
}
