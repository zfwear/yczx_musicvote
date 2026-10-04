import { readJson, error, json } from '../../_lib/http.js';
import { requireSuper } from '../../_lib/auth.js';
import {
  randomReadableCode, formatInviteCode, sha256Hex, normalizeInviteCode,
} from '../../_lib/crypto.js';
import { parsePositiveInt, parseEnum, sanitizeText } from '../../_lib/validate.js';
import { changedRows, isMissingTable } from '../../_lib/db.js';

const MIGRATION_HINT =
  '数据库尚未执行 003 迁移（缺少动态口令表），'
  + '请先在 D1 控制台执行 sql/003_multi_admin_and_announcements.sql';

/**
 * 动态口令（管理员邀请码）管理 —— 仅高级管理员可用。
 *
 * 设计要点：
 *  - 口令在库里只存 SHA-256 摘要，因此**只在生成那一刻返回一次明文**，
 *    之后无论谁（包括你自己）都无法再从数据库里读出来。这是刻意的：
 *    邀请码能换来管理员权限，明文落库等于给数据库泄露多加一条利用路径。
 *  - 生成时用人类可读字母表（去掉 0/O、1/I/L），排成 XXXX-XXXX-XXXX，
 *    方便当面念给同学或写在纸上。
 *  - 支持设使用次数与有效期，过期/用尽即自动失效。
 */

const MAX_USES_LIMIT = 50;
const MAX_TTL_DAYS = 90;
const CODE_LENGTH = 12;

function toSqlDateTime(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} `
    + `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

export async function onRequestGet(context) {
  try {
    return await handleGet(context);
  } catch (err) {
    if (isMissingTable(err)) return error(MIGRATION_HINT, 500);
    throw err;
  }
}

async function handleGet(context) {
  const { request, env } = context;

  const auth = await requireSuper(env, request);
  if (!auth.ok) return auth.response;

  const { results } = await env.DB.prepare(
    `SELECT id, created_by_name, note,
            CAST(max_uses AS INTEGER)   AS max_uses,
            CAST(used_count AS INTEGER) AS used_count,
            expires_at, created_at,
            CASE WHEN datetime(expires_at) > datetime('now')
                  AND CAST(used_count AS INTEGER) < CAST(max_uses AS INTEGER)
                 THEN 1 ELSE 0 END AS is_usable
       FROM admin_invites
      ORDER BY id DESC
      LIMIT 100`
  ).all();

  return json({ invites: results || [] });
}

export async function onRequestPost(context) {
  try {
    return await handlePost(context);
  } catch (err) {
    if (isMissingTable(err)) return error(MIGRATION_HINT, 500);
    throw err;
  }
}

async function handlePost(context) {
  const { request, env } = context;

  const auth = await requireSuper(env, request);
  if (!auth.ok) return auth.response;

  const parsed = await readJson(request);
  if (!parsed.ok) return error(parsed.error, 400);
  const data = parsed.value;

  if (data.action === 'create') return createInvite(env, auth.session, data);
  if (data.action === 'revoke') return revokeInvite(env, data);

  return error('未知操作', 400);
}

async function createInvite(env, session, data) {
  const maxUses = parsePositiveInt(data.max_uses ?? 1, { field: '可用次数', max: MAX_USES_LIMIT });
  if (!maxUses.ok) return error(`可用次数需为 1 到 ${MAX_USES_LIMIT} 之间的整数`, 400);

  const days = parsePositiveInt(data.expires_days ?? 7, { field: '有效天数', max: MAX_TTL_DAYS });
  if (!days.ok) return error(`有效天数需为 1 到 ${MAX_TTL_DAYS} 之间的整数`, 400);

  let note = '';
  if (typeof data.note === 'string' && data.note.trim()) {
    const parsedNote = sanitizeText(data.note, { maxLength: 30, field: '备注' });
    if (!parsedNote.ok) return error(parsedNote.error, 400);
    note = parsedNote.value;
  }

  const code = randomReadableCode(CODE_LENGTH);
  const tokenHash = await sha256Hex(normalizeInviteCode(code));
  const expiresAt = toSqlDateTime(new Date(Date.now() + days.value * 86400000));

  const admin = await env.DB.prepare('SELECT username FROM admins WHERE id = ?')
    .bind(session.subject_id).first();

  await env.DB.prepare(
    `INSERT INTO admin_invites (token_hash, created_by, created_by_name, note, max_uses, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(tokenHash, session.subject_id, (admin && admin.username) || '', note, maxUses.value, expiresAt).run();

  return json({
    ok: true,
    // 明文只在这一刻返回，之后再也查不到 —— 前端必须提示立即复制
    code,
    formatted: formatInviteCode(code),
    max_uses: maxUses.value,
    expires_at: expiresAt,
  });
}

async function revokeInvite(env, data) {
  const id = parsePositiveInt(data.id, { field: '记录' });
  if (!id.ok) return error(id.error, 400);

  const result = await env.DB.prepare('DELETE FROM admin_invites WHERE id = ?')
    .bind(id.value).run();
  if (changedRows(result) === 0) return error('记录不存在', 404);

  return json({ ok: true, message: '已作废该动态口令' });
}
