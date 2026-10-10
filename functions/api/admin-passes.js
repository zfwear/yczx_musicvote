import { readJson, error, json } from '../../_lib/http.js';
import { requireStaff, revokeSessionsByPass, authPepper, hasPrivatePepper } from '../../_lib/auth.js';
import { parsePositiveInt, sanitizeText } from '../../_lib/validate.js';
import { hashPassword, encryptSecret, decryptSecret } from '../../_lib/crypto.js';
import { changedRows } from '../../_lib/db.js';
import { classPasswordLookup } from '../../_lib/auth.js';
import { generatePassToken, PASS_KINDS } from '../../_lib/passes.js';

/**
 * 口令凭证管理（测试口令 / 游客口令）。
 *
 * 2026-10-10 需求：游客口令原先只有环境变量 GUEST_PASSWORD 一条，
 * 后台没有任何生成入口；再加上要发放"带计时期限的测试口令"，
 * 口令种类多了，管理从「系统设置」里拆出来，单独成页。
 *
 * GET  —— 列出全部凭证（配了私有 AUTH_PEPPER 时附明文，便于再次分发）
 * POST —— create / revoke / delete
 *
 * 权限：requireStaff（普通管理员及以上）。发放临时口令是广播站的日常工作，
 * 不需要高级管理员亲自操作；班级口令那套 super 限制保持不变。
 */

/** 生成凭证时最多重试几次撞唯一索引（12 位随机码撞上的概率约等于零）。 */
const MAX_INSERT_RETRY = 3;
const MAX_EXPIRES_DAYS = 3650;

export async function onRequestGet(context) {
  const { request, env } = context;

  const auth = await requireStaff(env, request);
  if (!auth.ok) return auth.response;

  const canView = hasPrivatePepper(env);
  const pepper = authPepper(env);

  let rows;
  try {
    ({ results: rows } = await env.DB.prepare(
      `SELECT id, kind, label, expires_at, revoked, created_at, last_used_at, token_encrypted
         FROM access_passes
        ORDER BY id DESC
        LIMIT 500`
    ).all());
  } catch (err) {
    if (/no such table/i.test(String((err && err.message) || ''))) {
      return error('数据库尚未执行 015 迁移（缺少 access_passes 表），请先执行 sql/015_access_passes_and_limits.sql', 500);
    }
    throw err;
  }

  const passes = [];
  for (const row of rows || []) {
    const item = {
      id: row.id,
      kind: row.kind,
      label: row.label || '',
      expires_at: row.expires_at || null,
      revoked: Number(row.revoked) === 1,
      created_at: row.created_at,
      last_used_at: row.last_used_at || null,
    };
    // 明文只有在配了私有密钥时才解得开也才发得出去 —— 与班级口令同一政策。
    if (canView && row.token_encrypted) {
      item.token = await decryptSecret(pepper, row.token_encrypted);
    }
    passes.push(item);
  }

  return json({ ok: true, canView, passes });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const auth = await requireStaff(env, request);
  if (!auth.ok) return auth.response;

  const parsed = await readJson(request);
  if (!parsed.ok) return error(parsed.error, 400);
  const data = parsed.value;

  try {
    if (data.action === 'create') return await createPass(env, data);
    if (data.action === 'revoke') return await revokePass(env, data);
    if (data.action === 'delete') return await deletePass(env, data);
    return error('未知操作', 400);
  } catch (err) {
    if (/no such table/i.test(String((err && err.message) || ''))) {
      return error('数据库尚未执行 015 迁移（缺少 access_passes 表），请先执行 sql/015_access_passes_and_limits.sql', 500);
    }
    throw err;
  }
}

async function createPass(env, data) {
  const kind = String(data.kind || '').trim();
  if (!PASS_KINDS.includes(kind)) return error('口令类型只能是 test（测试口令）或 guest（游客口令）', 400);

  let label = '';
  if (typeof data.label === 'string' && data.label.trim()) {
    const parsed = sanitizeText(data.label, { maxLength: 40, field: '备注' });
    if (!parsed.ok) return error(parsed.error, 400);
    label = parsed.value;
  }

  // 有效期：空 = 长期有效；给了就是 1 ~ 3650 天。
  // 测试口令前端默认填 7 天；这里不强制 —— 长期测试口令是管理员的自由。
  let expiresAt = null;
  const rawDays = data.expires_days;
  if (rawDays !== '' && rawDays !== null && rawDays !== undefined) {
    const days = Number(rawDays);
    if (!Number.isInteger(days) || days < 1 || days > MAX_EXPIRES_DAYS) {
      return error(`有效天数需要是 1 到 ${MAX_EXPIRES_DAYS} 之间的整数，留空表示长期有效`, 400);
    }
    const row = await env.DB.prepare(
      `SELECT datetime('now', ?) AS at`
    ).bind(`+${days} days`).first();
    expiresAt = row && row.at ? String(row.at) : null;
  }

  // 生成 → 哈希 → 入库。查找索引是唯一索引：万一随机码撞上已有口令
  // （概率约等于零）就换一个再试，而不是把"内部错误"甩给管理员。
  let lastErr = null;
  for (let attempt = 0; attempt < MAX_INSERT_RETRY; attempt++) {
    const token = generatePassToken();
    const lookup = await classPasswordLookup(env, token);
    const hashed = await hashPassword(token);
    const encrypted = await encryptSecret(authPepper(env), token);

    try {
      await env.DB.prepare(
        `INSERT INTO access_passes (kind, label, token_hash, token_lookup, token_encrypted, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(kind, label, hashed, lookup, encrypted, expiresAt).run();

      // 回读 id：前端生成后立即可作废/删除，不必先刷新列表
      const inserted = await env.DB.prepare(
        'SELECT id FROM access_passes WHERE token_lookup = ?'
      ).bind(lookup).first();

      return json({
        ok: true,
        id: inserted ? inserted.id : null,
        kind,
        label,
        expires_at: expiresAt,
        token,
        message: (kind === 'test' ? '测试口令' : '游客口令') + '已生成，请立即复制保存。',
      });
    } catch (err) {
      if (!/unique|constraint/i.test(String((err && err.message) || ''))) throw err;
      lastErr = err;
    }
  }
  throw lastErr || new Error('生成失败');
}

/** 作废：凭证立即可用性归零，并用 sessions.pass_id 精确撤销它签发过的会话。 */
async function revokePass(env, data) {
  const id = parsePositiveInt(data.id, { field: '凭证' });
  if (!id.ok) return error(id.error, 400);

  const result = await env.DB.prepare(
    'UPDATE access_passes SET revoked = 1 WHERE id = ?'
  ).bind(id.value).run();
  if (changedRows(result) === 0) return error('凭证不存在', 404);

  const revokedSessions = await revokeSessionsByPass(env, id.value);
  return json({ ok: true, revokedSessions, message: '口令已作废，相关登录已全部失效' });
}

/** 彻底删除：行与它签发的会话一起消失。 */
async function deletePass(env, data) {
  const id = parsePositiveInt(data.id, { field: '凭证' });
  if (!id.ok) return error(id.error, 400);

  const revokedSessions = await revokeSessionsByPass(env, id.value);
  const result = await env.DB.prepare('DELETE FROM access_passes WHERE id = ?').bind(id.value).run();
  if (changedRows(result) === 0) return error('凭证不存在', 404);

  return json({ ok: true, revokedSessions, message: '口令已删除，相关登录已全部失效' });
}
