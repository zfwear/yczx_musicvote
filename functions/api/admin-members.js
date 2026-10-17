import { readJson, error, json } from '../../_lib/http.js';
import { requireSuper, revokeSessionsByPersonalPass } from '../../_lib/auth.js';
import { parsePositiveInt } from '../../_lib/validate.js';
import {
  PERSONAL_USERNAME_RE, getPersonalById, renamePersonalPass,
  setPersonalBanned, isPersonalBanned,
} from '../../_lib/personal.js';
import { changedRows, isMissingTable } from '../../_lib/db.js';
import { unbindUserDevices, clearUserVotes, renameUserIdentity } from '../../_lib/device.js';

/**
 * 班级人员管理（4.0.0，用户 2026-10-17 确认）。
 *
 * 名单直接复用「个人口令」表 personal_passes：
 *   · 批量增加人员 = 批量创建「班级口令@姓名」登录；
 *   · 编辑 = 只改姓名（调班另走「口令管理」里的重新绑定）；
 *   · 移除 = 真删登录资格，已投票数保留；
 *   · 封禁 = 禁止登录/投票，并清零该姓名已投出的票；
 *   · 解绑设备 = 删除 device_identities 里该姓名的绑定，解决教室共用电脑误伤。
 *
 * 权限：搜索（GET）普通管理员可用；人员变更（POST）仅高级管理员。
 */
const MIGRATION_016 = '数据库尚未执行 016 迁移（缺少个人口令表），请先执行 sql/016_personal_passes.sql';
const MIGRATION_017 = '数据库尚未执行 017 迁移（缺少 banned 字段或设备绑定表），请先执行 sql/017_members_devices.sql';

function migrationError(err) {
  const msg = String((err && err.message) || '');
  if (isMissingTable(err) && /personal/i.test(msg)) return error(MIGRATION_016, 500);
  if (isMissingTable(err) && /device/i.test(msg)) return error(MIGRATION_017, 500);
  if (/no such column.*banned/i.test(msg)) return error(MIGRATION_017, 500);
  return null;
}

/** 姓名规范化：支持数组或“空格/逗号/分号/换行”分隔的字符串。 */
function splitNames(input) {
  if (Array.isArray(input)) return input.map((v) => String(v ?? '').trim());
  return String(input ?? '')
    .split(/[\s,，;；、|]+/)
    .map((v) => v.trim());
}

export async function onRequestGet(context) {
  const { request, env } = context;

  // 年级名单是敏感数据（2026-10-17 用户强调）：搜索也只给高级管理员。
  // 普通管理员连“按关键词试出来”的入口都没有。
  const auth = await requireSuper(env, request);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const q = String(url.searchParams.get('q') || '').trim();
  if (!q) {
    return json({
      ok: true,
      members: [],
      hint: '输入姓名或班级关键词搜索；默认不列出全部人员',
    });
  }
  if (q.length > 40) return error('搜索关键词最多 40 个字符', 400);

  const like = `%${q}%`;
  let rows = [];
  try {
    const res = await env.DB.prepare(
      `SELECT p.id, p.class_id, p.username, p.created_at,
              COALESCE(p.banned, 0) AS banned, c.name AS class_name
         FROM personal_passes p
         LEFT JOIN classes c ON c.id = p.class_id
        WHERE p.class_id > 0 AND (p.username LIKE ? OR c.name LIKE ?)
        ORDER BY c.name ASC, p.username ASC
        LIMIT 60`
    ).bind(like, like).all();
    rows = res.results || [];
  } catch (err) {
    const msg = String((err && err.message) || '');
    if (/no such column.*banned/i.test(msg)) {
      // 017 没跑：仍允许搜索，只是全部按未封禁显示。
      const res = await env.DB.prepare(
        `SELECT p.id, p.class_id, p.username, p.created_at,
                0 AS banned, c.name AS class_name
           FROM personal_passes p
           LEFT JOIN classes c ON c.id = p.class_id
          WHERE p.class_id > 0 AND (p.username LIKE ? OR c.name LIKE ?)
          ORDER BY c.name ASC, p.username ASC
          LIMIT 60`
      ).bind(like, like).all();
      rows = res.results || [];
    } else {
      const mapped = migrationError(err);
      if (mapped) return mapped;
      throw err;
    }
  }

  return json({
    ok: true,
    members: rows.map((row) => ({
      id: Number(row.id),
      class_id: Number(row.class_id),
      class_name: String(row.class_name || ''),
      username: String(row.username || ''),
      banned: Number(row.banned) === 1,
      created_at: String(row.created_at || ''),
    })),
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const auth = await requireSuper(env, request);
  if (!auth.ok) return auth.response;

  const parsed = await readJson(request);
  if (!parsed.ok) return error(parsed.error, 400);
  const data = parsed.value || {};

  try {
    switch (String(data.action || '')) {
      case 'batch_add':
        return await batchAdd(env, data);
      case 'rename':
        return await renameMember(env, data);
      case 'remove':
        return await removeMember(env, data);
      case 'ban':
        return await banMember(env, data);
      case 'unban':
        return await unbanMember(env, data);
      case 'unbind_device':
        return await unbindDevice(env, data);
      default:
        return error('未知操作', 400);
    }
  } catch (err) {
    const mapped = migrationError(err);
    if (mapped) return mapped;
    throw err;
  }
}

async function batchAdd(env, data) {
  const classId = parsePositiveInt(data.class_id, { field: '班级' });
  if (!classId.ok) return error(classId.error, 400);

  const cls = await env.DB.prepare('SELECT id, name FROM classes WHERE id = ?')
    .bind(classId.value).first();
  if (!cls) return error('班级不存在（可能已被删除）', 404);

  const raw = splitNames(data.names);
  const names = [];
  const seen = new Set();
  const invalid = [];
  for (const name of raw) {
    if (!name) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    if (!PERSONAL_USERNAME_RE.test(name)) {
      if (invalid.length < 10) invalid.push(name);
      continue;
    }
    names.push(name);
  }

  if (!names.length) return error('没有可导入的有效姓名（姓名 1~20 位，不含空格和 @）', 400);
  if (names.length > 300) return error('一次最多导入 300 个姓名，请分批操作', 400);

  let added = 0;
  let skipped = 0;
  for (const name of names) {
    const result = await env.DB.prepare(
      'INSERT OR IGNORE INTO personal_passes (class_id, username) VALUES (?, ?)'
    ).bind(classId.value, name).run();
    if (changedRows(result) === 1) added += 1;
    else skipped += 1;
  }

  const parts = [`已为「${cls.name}」新增 ${added} 人`];
  if (skipped) parts.push(`已存在跳过 ${skipped} 人`);
  if (invalid.length) parts.push(`无效姓名 ${invalid.length} 个（${invalid.join('、')}${invalid.length >= 10 ? '…' : ''}）`);
  return json({ ok: true, added, skipped, invalid, message: parts.join('；') });
}

async function renameMember(env, data) {
  const id = parsePositiveInt(data.id, { field: '人员' });
  if (!id.ok) return error(id.error, 400);

  const username = String(data.username ?? '').trim();
  if (!PERSONAL_USERNAME_RE.test(username)) {
    return error('姓名需要是 1 到 20 位的中文、字母、数字、下划线或短横线', 400);
  }

  const row = await getPersonalById(env, id.value);
  if (!row) return error('人员不存在', 404);
  if (Number(row.class_id) <= 0) return error('该人员处于未绑定状态，请先在「口令管理」重新绑定班级', 400);

  const result = await renamePersonalPass(env, id.value, username);
  if (result.missing) return error('人员不存在', 404);
  if (result.conflict) return error('这个姓名在该班级下已存在，请换一个', 409);

  await renameUserIdentity(env, Number(row.class_id), String(row.username), username);
  return json({
    ok: true,
    message: result.unchanged ? '姓名没有变化' : `已改为「${username}」；设备绑定与已投票记录已同步`,
  });
}

async function removeMember(env, data) {
  const id = parsePositiveInt(data.id, { field: '人员' });
  if (!id.ok) return error(id.error, 400);

  const row = await getPersonalById(env, id.value);
  if (!row) return error('人员不存在', 404);

  await env.DB.prepare('DELETE FROM personal_passes WHERE id = ?').bind(id.value).run();
  await revokeSessionsByPersonalPass(env, id.value);
  // 移除后释放设备：否则这台电脑还会被“已不存在的人”占着三天。
  await unbindUserDevices(env, Number(row.class_id), String(row.username));

  return json({
    ok: true,
    message: `已移除「${row.username}」；已投票数保留，设备绑定已释放`,
  });
}

async function banMember(env, data) {
  const id = parsePositiveInt(data.id, { field: '人员' });
  if (!id.ok) return error(id.error, 400);

  const row = await getPersonalById(env, id.value);
  if (!row) return error('人员不存在', 404);

  if (await isPersonalBanned(env, id.value)) {
    return json({ ok: true, message: '该人员已经处于封禁状态' });
  }

  await setPersonalBanned(env, id.value, true);
  await revokeSessionsByPersonalPass(env, id.value);

  // 清零该姓名已投出的票（017 的新票按 username 精确归属；
  // 老票按当前绑定设备指纹兜底）。设备绑定故意保留：封禁期间这台设备
  // 不能马上换姓名继续投；需要放行时由管理员点「解绑设备」。
  const cleared = await clearUserVotes(env, Number(row.class_id), String(row.username));

  return json({
    ok: true,
    removedVotes: cleared.removed,
    songs: cleared.songs,
    message: `已封禁「${row.username}」；清零 ${cleared.removed} 票（涉及 ${cleared.songs} 首歌）`,
  });
}

async function unbanMember(env, data) {
  const id = parsePositiveInt(data.id, { field: '人员' });
  if (!id.ok) return error(id.error, 400);

  const row = await getPersonalById(env, id.value);
  if (!row) return error('人员不存在', 404);

  await setPersonalBanned(env, id.value, false);
  return json({ ok: true, message: `已解封「${row.username}」` });
}

async function unbindDevice(env, data) {
  const id = parsePositiveInt(data.id, { field: '人员' });
  if (!id.ok) return error(id.error, 400);

  const row = await getPersonalById(env, id.value);
  if (!row) return error('人员不存在', 404);

  const removed = await unbindUserDevices(env, Number(row.class_id), String(row.username));
  return json({
    ok: true,
    removed,
    message: removed > 0
      ? `已解绑「${row.username}」的 ${removed} 台设备，这台设备现在可以登录其他姓名`
      : '没有找到该姓名的设备绑定（可能已过期）',
  });
}
