import { readJson, error, json } from '../../_lib/http.js';
import {
  requireStaff, requireSuper, classPasswordLookup, authPepper, DEFAULT_PEPPER, hasPrivatePepper,
  isDebugSession, revokeDebugSessions,
} from '../../_lib/auth.js';
import { sanitizeText, parsePositiveInt, parseSecret, parseBannedKeyword } from '../../_lib/validate.js';
import { hashPassword, verifyPassword, encryptSecret, decryptSecret } from '../../_lib/crypto.js';
import {
  getVoteCap, setSetting, SETTING_VOTE_CAP, getSetting,
  getReportThreshold, SETTING_REPORT_THRESHOLD, DEFAULT_REPORT_THRESHOLD,
  isSubmissionsPaused, SETTING_SUBMISSIONS_PAUSED,
} from '../../_lib/settings.js';
import { changedRows, isMissingTable } from '../../_lib/db.js';

const DEFAULT_EXPIRY = '2099-12-31 23:59:59';
const EXPIRY_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/** 判断是否为唯一索引冲突（用于给出"口令重复"这种可读提示）。 */
function isUniqueViolation(err) {
  return /unique|constraint/i.test(String((err && err.message) || ''));
}

/**
 * 库里是否已经有 password_lookup 列（001 迁移是否跑过）。
 *
 * 极端情况下（只跑了 base schema、没跑 001）这张表还没有查找索引列，
 * 那时"共用口令"本来也无法成立，但预检查的 SQL 会因为缺列直接抛错。
 * 探一下，把这种部署交回给 writeClassSecret 的旧逻辑处理，
 * 而不是让添加班级变成一个 500。
 */
async function classLookupColumnExists(env) {
  try {
    await env.DB.prepare('SELECT password_lookup FROM classes LIMIT 1').first();
    return true;
  } catch (err) {
    return !/no such column|has no column named/i.test(String((err && err.message) || ''));
  }
}

/** 「所有班共用一个口令」为什么不能成立的统一说法（前端会直接显示）。 */
function sharedPasswordMessage(ownerName, password) {
  return `口令「${password}」${ownerName ? `已经被班级「${ownerName}」占用` : '已被其他班级占用'}，不能再用。\n\n`
    + '批量生成里的「所有班共用一个口令」因此无法成立：班级口令在库里存的是'
    + '「口令 → 查找值」这类唯一索引，同一个口令只能对应一个班，'
    + '否则登录时无法判断该算哪个班。\n\n'
    + '请改用「每班一个随机口令」，或把每班口令改成互不相同的值。';
}

/**
 * 系统设置。
 *
 * 修掉的问题：
 *  - 旧版 GET 分支**完全没有认证**，任何人访问 /api/admin-settings
 *    就能拿到全部黑名单（审计报告第 5 条）。现在读和写都要求管理员会话。
 *  - 旧版只支持修改 id=1 那一条班级口令。现在支持添加 / 删除 / 逐个改口令。
 *  - 新增管理员改密，方便出事之后轮换凭证。
 */
export async function onRequestGet(context) {
  const { request, env } = context;

  const auth = await requireStaff(env, request);
  if (!auth.ok) return auth.response;

  const isSuper = auth.session.role === 'super';
  const pepper = authPepper(env);

  // 班级列表。逐级降级，保证任何迁移进度下后台都打得开：
  // 007 之前没有 grade / member_count，005 之前没有 password_encrypted。
  let classRows = [];
  let canViewPasswords = false;
  let hasClassMeta = false;

  const ATTEMPTS = [
    { sql: 'SELECT id, name, grade, member_count, password_encrypted FROM classes ORDER BY grade ASC, id ASC', vault: true, meta: true },
    { sql: 'SELECT id, name, grade, member_count, NULL AS password_encrypted FROM classes ORDER BY grade ASC, id ASC', vault: false, meta: true },
    { sql: 'SELECT id, name, NULL AS grade, NULL AS member_count, password_encrypted FROM classes ORDER BY id ASC', vault: true, meta: false },
    { sql: 'SELECT id, name, NULL AS grade, NULL AS member_count, NULL AS password_encrypted FROM classes ORDER BY id ASC', vault: false, meta: false },
  ];

  for (const attempt of ATTEMPTS) {
    try {
      const res = await env.DB.prepare(attempt.sql).all();
      classRows = res.results || [];
      // 审计报告 A2：只有真的配了私有 AUTH_PEPPER 才允许解密查看口令。
      // 否则密文是用**公开的**占位密钥加的，能解开等于没加密 ——
      // 与其给出虚假的安全感，不如整个禁用这个功能。
      canViewPasswords = attempt.vault && hasPrivatePepper(env);
      hasClassMeta = attempt.meta;
      break;
    } catch (err) {
      if (!/no such column/i.test(String((err && err.message) || ''))) throw err;
    }
  }

  const classes = [];
  for (const row of classRows) {
    const count = row.member_count === null || row.member_count === undefined
      ? null
      : Number(row.member_count);
    const item = {
      id: row.id,
      name: row.name,
      grade: row.grade || '',
      member_count: Number.isFinite(count) ? count : null,
    };
    // 口令明文只回给高级管理员；普通管理员拿不到。
    if (isSuper) {
      item.password = row.password_encrypted
        ? await decryptSecret(pepper, row.password_encrypted)
        : null;
    }
    classes.push(item);
  }

  const voteCap = await getVoteCap(env);
  const voteCapRaw = await getSetting(env, SETTING_VOTE_CAP, '');
  const totalMembers = classes.reduce((sum, c) => sum + (c.member_count || 0), 0);

  const reportThreshold = await getReportThreshold(env);

  const banned = await env.DB.prepare(
    'SELECT id, type, keyword, reason, expire_at FROM banned_items ORDER BY id DESC LIMIT 200'
  ).all();
  const categories = await env.DB.prepare(
    'SELECT id, name, CAST(weight AS INTEGER) AS weight FROM categories ORDER BY weight DESC, id ASC'
  ).all();

  return json({
    classes,
    banned: banned.results || [],
    categories: categories.results || [],
    // 当前登录管理员自己的 ID。
    // 前端本来是从 /api/admin-accounts（仅高级管理员可读）里取这个值的，
    // 于是普通管理员拿不到它、也就分不出"这一行是不是我自己"。
    // 改密对普通管理员开放之后（审计报告 B1），这个 ID 必须随手可得，
    // 所以在这里一并下发：它本来就在调用者自己的会话里，不泄露任何新信息。
    currentAdminId: auth.session.subject_id,
    vote: {
      cap: voteCap,                 // 0 表示不限制
      capConfigured: voteCap > 0,
      capRaw: String(voteCapRaw || ''),
      totalMembers,                 // 按班级人数汇总出来的全校人数，供管理员参考
    },
    report: {
      threshold: reportThreshold,   // 举报进入收件箱所需的最少举报次数
      defaultThreshold: DEFAULT_REPORT_THRESHOLD,
    },
    // 「暂停接收投稿」的当前状态：前端据此决定两个按钮哪个是可用态。
    submit: {
      paused: await isSubmissionsPaused(env),
    },
    security: {
      // 是否配置了私有的 AUTH_PEPPER。
      pepperConfigured: pepper !== DEFAULT_PEPPER,
      // 是否允许"查看班级口令"。
      // 审计报告 A2：没配私有密钥时，密文是用公开占位密钥加的，
      // 能解开等于没加密 —— 所以直接禁用，而不是给一个虚假的安全感。
      canViewPasswords,
      canViewPasswordsReason: canViewPasswords
        ? ''
        : (pepper === DEFAULT_PEPPER
          ? '未配置 AUTH_PEPPER（正在使用公开的占位密钥），为避免"看起来加密、实际可被任何人解开"，查看口令功能已禁用。'
          : '数据库缺少 password_encrypted 列，请先执行 sql/005_class_password_vault.sql。'),
      // 是否已执行 007（年级 / 人数 / 投票上限）
      hasClassMeta,
      // 前端据此决定是否显示"高级管理员专属"的几块设置。
      role: auth.session.role,
      isSuper,
    },
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const parsed = await readJson(request);
  if (!parsed.ok) return error(parsed.error, 400);
  const data = parsed.value;

  // 权限分级：
  //   · 普通管理员：维护黑名单，以及**改自己的密码**（审计报告 B1 ——
  //     前端对所有管理员都显示改密表单，后端却只放给高级管理员，
  //     等于普通管理员根本无法自行轮换凭证）。
  //   · 高级管理员：班级口令、分类权重、投票上限、重置他人的密码。
  //
  // 注意 `change_admin_password` 只作用于**会话本人**（函数内部用
  // session.subject_id 定位账号，不接受前端传 ID），所以开放给普通
  // 管理员不会带来越权；重置别人的密码仍然只有高级管理员能做，
  // 走的是另一个接口 admin-accounts.js 的 reset_password。
  const STAFF_ACTIONS = new Set(['add_banned', 'delete_banned', 'change_admin_password']);
  const auth = STAFF_ACTIONS.has(data.action)
    ? await requireStaff(env, request)
    : await requireSuper(env, request);
  if (!auth.ok) return auth.response;

  switch (data.action) {
    case 'add_class':
      return addClass(env, data);
    case 'delete_class':
      return deleteClass(env, auth.session, data);
    case 'delete_classes':
      return deleteClasses(env, data);
    case 'update_class_password':
      return updateClassPassword(env, data);
    case 'add_banned':
      return addBanned(env, data);
    case 'delete_banned':
      return deleteBanned(env, data);
    case 'update_category_weight':
      return updateCategoryWeight(env, data);
    case 'set_vote_cap':
      return setVoteCap(env, data);
    case 'set_submissions_paused':
      return setSubmissionsPaused(env, data);
    case 'set_report_threshold':
      return setReportThreshold(env, data);
    case 'update_class_info':
      return updateClassInfo(env, data);
    case 'change_admin_password':
      return changeAdminPassword(env, auth.session, data);
    default:
      return error('未知操作', 400);
  }
}

/**
 * 写班级口令：哈希用于校验，AES-GCM 密文用于管理员查看。
 * 005 迁移未执行时自动退回只写哈希的旧写法，功能不受影响（只是看不到口令）。
 */
async function writeClassSecret(env, { id = null, name, plain }) {
  const lookup = await classPasswordLookup(env, plain);
  const hashed = await hashPassword(plain);
  const encrypted = await encryptSecret(authPepper(env), plain);

  if (id === null) {
    try {
      await env.DB.prepare(
        'INSERT INTO classes (name, password, password_lookup, password_encrypted) VALUES (?, ?, ?, ?)'
      ).bind(name, hashed, lookup, encrypted).run();
      return { ok: true };
    } catch (err) {
      if (/no such column/i.test(String((err && err.message) || ''))) {
        // 还没执行 005：退回旧写法
        await env.DB.prepare(
          'INSERT INTO classes (name, password, password_lookup) VALUES (?, ?, ?)'
        ).bind(name, hashed, lookup).run();
        return { ok: true, noVault: true };
      }
      return { ok: false, err };
    }
  }

  try {
    await env.DB.prepare(
      'UPDATE classes SET password = ?, password_lookup = ?, password_encrypted = ? WHERE id = ?'
    ).bind(hashed, lookup, encrypted, id).run();
    return { ok: true };
  } catch (err) {
    if (/no such column/i.test(String((err && err.message) || ''))) {
      await env.DB.prepare(
        'UPDATE classes SET password = ?, password_lookup = ? WHERE id = ?'
      ).bind(hashed, lookup, id).run();
      return { ok: true, noVault: true };
    }
    return { ok: false, err };
  }
}

/* ------------------------- 班级口令管理 ------------------------- */

async function addClass(env, data) {
  const name = sanitizeText(data.name, { maxLength: 30, field: '班级名称' });
  if (!name.ok) return error(name.error, 400);

  const password = parseSecret(data.password, { min: 6, max: 128, field: '班级口令' });
  if (!password.ok) return error(password.error, 400);

  const meta = parseClassMeta(data);
  if (meta.error) return error(meta.error, 400);

  // 批量生成时很容易撞名，先查一下给出可读提示，而不是默默建一堆同名班级。
  const duplicate = await env.DB.prepare('SELECT id FROM classes WHERE name = ?')
    .bind(name.value).first();
  if (duplicate) return error(`班级「${name.value}」已经存在了`, 409);

  // 审计报告 B2：「所有班共用一个口令」在数据库层根本立不住 ——
  // 口令索引列 password_lookup = HMAC(私钥, 口令) 上建了**唯一索引**
  // （见 sql/001_security_upgrade.sql 里的 idx_classes_lookup）：同一个口令
  // 必然算出同一个查找值，第二个班插入时就会撞唯一索引。
  //
  // 更糟的是原实现会把它翻译成"该口令已被其他班级使用，请换一个"，
  // 让按"共用口令"批量生成的人以为是偶发冲突，于是一个个改成随机口令。
  // 这里改成**写入前主动拒绝**，并且把"为什么不行"直接说清楚：
  // 这不是可以绕过的限制，而是"口令即身份"的必然结果。
  const hasLookupColumn = await classLookupColumnExists(env);
  if (hasLookupColumn) {
    const lookup = await classPasswordLookup(env, password.value);
    const sameLookup = await env.DB.prepare(
      'SELECT name FROM classes WHERE password_lookup = ? LIMIT 1'
    ).bind(lookup).first();
    if (sameLookup) {
      return error(sharedPasswordMessage(sameLookup.name, password.value), 409);
    }
  }

  const result = await writeClassSecret(env, { name: name.value, plain: password.value });
  if (!result.ok) {
    // 走到这里说明是并发插入撞上了唯一索引（上面的预检查漏过去了），
    // 兜底文案与上面一致，避免两处说法不一样。
    if (isUniqueViolation(result.err)) {
      return error(sharedPasswordMessage(null, password.value), 409);
    }
    return error('添加失败：数据库结构可能尚未迁移', 500);
  }

  // 年级 / 人数：007 未执行时静默跳过，不影响添加口令
  if (meta.grade || meta.memberCount !== null) {
    try {
      await env.DB.prepare('UPDATE classes SET grade = ?, member_count = ? WHERE name = ?')
        .bind(meta.grade, meta.memberCount, name.value).run();
    } catch (err) {
      if (!/no such column/i.test(String((err && err.message) || ''))) throw err;
    }
  }

  return json({ ok: true, message: '已添加班级口令' });
}

/** 解析年级与人数（都可选）。 */
function parseClassMeta(data) {
  let grade = '';
  if (typeof data.grade === 'string' && data.grade.trim()) {
    const parsed = sanitizeText(data.grade, { maxLength: 20, field: '年级' });
    if (!parsed.ok) return { error: parsed.error };
    grade = parsed.value;
  }

  let memberCount = null;
  const raw = data.member_count;
  if (raw !== '' && raw !== null && raw !== undefined) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 10000) {
      return { error: '人数需要是 0 到 10000 之间的整数' };
    }
    memberCount = n;
  }

  return { grade, memberCount };
}

/**
 * 设置投票上限。
 * 0 表示不限制；大于 0 时，**超出上限的那部分票不计入票数**
 * （票照收，但学生端显示与正式榜排序都用封顶后的值）。
 */
async function setVoteCap(env, data) {
  const raw = data.cap === '' || data.cap === null || data.cap === undefined ? 0 : Number(data.cap);
  if (!Number.isInteger(raw) || raw < 0 || raw > 1000000) {
    return error('投票上限需要是 0 到 1000000 之间的整数（0 表示不限制）', 400);
  }

  try {
    await setSetting(env, SETTING_VOTE_CAP, raw);
  } catch (err) {
    if (isMissingTable(err)) {
      return error('数据库尚未执行 007 迁移（缺少 system_settings 表），请先执行 sql/007_class_grade_and_vote_cap.sql', 500);
    }
    throw err;
  }

  return json({
    ok: true,
    cap: raw,
    message: raw > 0
      ? `已设置投票上限为 ${raw} 票，超出部分不计入票数`
      : '已取消投票上限（票数不再封顶）',
  });
}

/**
 * 暂停 / 继续接收投稿（用户要求，以按钮形式给管理员）。
 *
 * 只写一个 system_settings 开关，**不需要任何数据库迁移**；
 * 真正的拦截在 vote.js 的 POST 里（前端按钮只是提示，绕过页面直接 POST 才是真实攻击面）。
 * 表还没建（007 没跑）时给一条能照着做的错误，而不是 500。
 */
async function setSubmissionsPaused(env, data) {
  const paused = data.paused === true || data.paused === 1 || data.paused === '1';
  try {
    await setSetting(env, SETTING_SUBMISSIONS_PAUSED, paused ? '1' : '0');
  } catch (err) {
    if (isMissingTable(err)) {
      return error('数据库尚未执行 007 迁移（缺少 system_settings 表），请先执行 sql/007_class_grade_and_vote_cap.sql', 500);
    }
    throw err;
  }

  return json({
    ok: true,
    paused,
    message: paused
      ? '已暂停接收投稿：学生仍可查看榜单与排期，但提交会被拒绝'
      : '已恢复接收投稿',
  });
}

/**
 * 设置举报进入收件箱的阈值。
 * 只有被 >= 阈值的不同班级举报、且仍在待审核池里的歌，才会出现在收件箱。
 */
async function setReportThreshold(env, data) {
  const raw = Number(data.threshold);
  if (!Number.isInteger(raw) || raw < 2 || raw > 20) {
    return error('举报阈值需要是 2 到 20 之间的整数', 400);
  }

  try {
    await setSetting(env, SETTING_REPORT_THRESHOLD, raw);
  } catch (err) {
    if (isMissingTable(err)) {
      return error('数据库尚未执行 007 迁移（缺少 system_settings 表），请先执行 sql/007_class_grade_and_vote_cap.sql', 500);
    }
    throw err;
  }

  return json({
    ok: true,
    threshold: raw,
    message: `已设置：被 ${raw} 个以上班级举报的歌才会进入收件箱`,
  });
}

/** 修改某个班级的年级与人数。 */async function updateClassInfo(env, data) {
  const id = parsePositiveInt(data.id, { field: '班级' });
  if (!id.ok) return error(id.error, 400);

  const meta = parseClassMeta(data);
  if (meta.error) return error(meta.error, 400);

  try {
    const result = await env.DB.prepare(
      'UPDATE classes SET grade = ?, member_count = ? WHERE id = ?'
    ).bind(meta.grade, meta.memberCount, id.value).run();
    if (changedRows(result) === 0) return error('班级不存在', 404);
  } catch (err) {
    if (/no such column/i.test(String((err && err.message) || ''))) {
      return error('数据库尚未执行 007 迁移（缺少 grade / member_count 列），请先执行 sql/007_class_grade_and_vote_cap.sql', 500);
    }
    throw err;
  }

  return json({ ok: true, message: '已保存该班级的年级与人数' });
}

async function deleteClass(env, session, data) {
  const id = parsePositiveInt(data.id, { field: '班级' });
  if (!id.ok) return error(id.error, 400);

  const total = await env.DB.prepare('SELECT COUNT(*) AS n FROM classes').first();
  if (Number(total && total.n) <= 1) {
    return error('至少要保留一个班级口令，否则将无法登录', 400);
  }

  const result = await env.DB.prepare('DELETE FROM classes WHERE id = ?').bind(id.value).run();
  if (changedRows(result) === 0) return error('班级不存在', 404);

  // 被删班级的会话立即失效（其歌曲记录保留，便于追溯历史）。
  await env.DB.prepare("DELETE FROM sessions WHERE subject = 'class' AND subject_id = ?")
    .bind(id.value).run();

  return json({ ok: true, message: '已删除该班级口令' });
}

/**
 * 批量删除班级口令。
 * 无论批量生成过多少随机口令，都能一次清掉；
 * 但**始终至少保留一个**，否则全校都登不进来。
 */
async function deleteClasses(env, data) {
  const raw = Array.isArray(data.ids) ? data.ids : [];
  const ids = [];
  for (const value of raw) {
    const parsed = parsePositiveInt(value, { field: '班级' });
    if (parsed.ok && !ids.includes(parsed.value)) ids.push(parsed.value);
  }

  if (!ids.length) return error('请先勾选要删除的班级', 400);
  if (ids.length > 200) return error('一次最多删除 200 个班级', 400);

  const total = await env.DB.prepare('SELECT COUNT(*) AS n FROM classes').first();
  const totalCount = Number(total && total.n) || 0;
  if (totalCount - ids.length < 1) {
    return error(`当前共 ${totalCount} 个班级口令，至少要保留 1 个否则将无法登录，请少选几个`, 400);
  }

  const placeholders = ids.map(() => '?').join(',');
  const result = await env.DB.prepare(`DELETE FROM classes WHERE id IN (${placeholders})`)
    .bind(...ids).run();
  const deleted = changedRows(result);

  await env.DB.prepare(
    `DELETE FROM sessions WHERE subject = 'class' AND subject_id IN (${placeholders})`
  ).bind(...ids).run();

  return json({ ok: true, deleted, message: `已删除 ${deleted} 个班级口令` });
}

async function updateClassPassword(env, data) {
  const id = parsePositiveInt(data.id, { field: '班级' });
  if (!id.ok) return error(id.error, 400);

  const password = parseSecret(data.new_password, { min: 6, max: 128, field: '新口令' });
  if (!password.ok) return error(password.error, 400);

  const exists = await env.DB.prepare('SELECT id FROM classes WHERE id = ?').bind(id.value).first();
  if (!exists) return error('班级不存在', 404);

  const result = await writeClassSecret(env, { id: id.value, plain: password.value });
  if (!result.ok) {
    if (isUniqueViolation(result.err)) return error('该口令已被其他班级使用，请换一个', 409);
    return error('修改失败', 500);
  }

  // 改了口令就让该班级所有旧会话失效，防止旧口令持有者继续使用。
  await env.DB.prepare("DELETE FROM sessions WHERE subject = 'class' AND subject_id = ?")
    .bind(id.value).run();

  return json({ ok: true, message: '口令已更新，原登录状态已失效' });
}

/* ------------------------- 黑名单管理 ------------------------- */

async function addBanned(env, data) {
  // 黑名单只收"违禁词"。type 列保留是为了兼容历史数据，但**不参与匹配**：
  // 匹配时歌名与歌手拼在一起看，所以封不了"某一首歌"。
  const keyword = parseBannedKeyword(data.keyword);
  if (!keyword.ok) return error(keyword.error, 400);

  let reason = '管理员封禁';
  if (typeof data.reason === 'string' && data.reason.trim()) {
    const parsed = sanitizeText(data.reason, { maxLength: 60, field: '原因' });
    if (!parsed.ok) return error(parsed.error, 400);
    reason = parsed.value;
  }

  let expireAt = DEFAULT_EXPIRY;
  if (typeof data.expire_at === 'string' && data.expire_at.trim()) {
    const value = data.expire_at.trim();
    if (!EXPIRY_PATTERN.test(value)) return error('过期时间格式应为 YYYY-MM-DD HH:MM:SS', 400);
    expireAt = value;
  }

  // 存 'keyword' 是语义正确的写法；万一线上表带了老 CHECK 约束，退回 'artist'。
  try {
    await env.DB.prepare(
      "INSERT INTO banned_items (type, keyword, reason, expire_at) VALUES ('keyword', ?, ?, ?)"
    ).bind(keyword.value, reason, expireAt).run();
  } catch (err) {
    await env.DB.prepare(
      "INSERT INTO banned_items (type, keyword, reason, expire_at) VALUES ('artist', ?, ?, ?)"
    ).bind(keyword.value, reason, expireAt).run();
  }

  return json({ ok: true, message: `已把违禁词「${keyword.value}」加入黑名单` });
}

async function deleteBanned(env, data) {
  const id = parsePositiveInt(data.id, { field: '记录' });
  if (!id.ok) return error(id.error, 400);

  const result = await env.DB.prepare('DELETE FROM banned_items WHERE id = ?').bind(id.value).run();
  if (changedRows(result) === 0) return error('记录不存在', 404);

  return json({ ok: true, message: '已移出黑名单' });
}

/* ------------------------- 管理员改密 ------------------------- */

/**
 * 改密。
 *
 * 审计报告 B1：这里**只改会话本人的密码**（下方按 session.subject_id 定位
 * 账号，前端传什么 id 都没用），因此普通管理员也能用 —— 前端本来就给
 * 所有人显示改密表单。重置**他人**密码是另一条路（admin-accounts.js
 * 的 reset_password），仍然只允许高级管理员。
 *
 * 必须验证当前密码：会话 Cookie 被 XSS/借用的设备捡到时，
 * 不应该能直接把账号锁死。
 */
async function changeAdminPassword(env, session, data) {
  const current = parseSecret(data.current_password, { min: 1, max: 128, field: '当前密码' });
  if (!current.ok) return error(current.error, 400);

  const next = parseSecret(data.new_password, { min: 8, max: 128, field: '新密码' });
  if (!next.ok) return error(next.error, 400);

  if (current.value === next.value) return error('新密码不能与当前密码相同', 400);

  const admin = await env.DB.prepare('SELECT id, password FROM admins WHERE id = ?')
    .bind(session.subject_id).first();
  if (!admin) return error('账号不存在', 404);

  const verdict = await verifyPassword(admin.password, current.value);
  if (!verdict.ok) return error('当前密码不正确', 401);

  const hashed = await hashPassword(next.value);
  await env.DB.prepare('UPDATE admins SET password = ? WHERE id = ?')
    .bind(hashed, admin.id).run();

  // 保留当前会话，踢掉其它所有管理员会话 —— 密码轮换往往意味着怀疑凭证已泄露。
  await env.DB.prepare(
    "DELETE FROM sessions WHERE subject = 'admin' AND subject_id = ? AND id <> ?"
  ).bind(admin.id, session.id).run();

  // 审计报告 A5：还要撤掉这个管理员换出去的**调试会话**。
  // 调试会话在学生端（subject='class'），上面那条 DELETE 碰不到它；
  // 一个调试会话能在 2 小时内不限次数、不查重地往真实歌曲表写记录，
  // 改完密码却留着它，等于密码白改。
  await revokeDebugSessions(env, admin.id, {
    exceptSessionId: isDebugSession(session) ? session.id : null,
  }).catch(() => { /* 013 未执行等情况不影响改密本身 */ });

  return json({ ok: true, message: '密码已更新，其它设备上的登录已失效' });
}

/* ------------------------- 分类权重管理 ------------------------- */

/**
 * 修改分类权重 —— 直接决定"正式榜单"的排序。
 * 权重是整数（0–1000），权重越大排越前；同权重内再按票数降序。
 */
async function updateCategoryWeight(env, data) {
  const id = parsePositiveInt(data.id, { field: '分类' });
  if (!id.ok) return error(id.error, 400);

  const weight = Number(data.weight);
  if (!Number.isInteger(weight) || weight < 0 || weight > 1000) {
    return error('权重必须是 0 到 1000 之间的整数', 400);
  }

  const result = await env.DB.prepare('UPDATE categories SET weight = ? WHERE id = ?')
    .bind(weight, id.value).run();
  if (changedRows(result) === 0) return error('分类不存在', 404);

  return json({ ok: true, message: '权重已更新，正式榜单排序立即生效' });
}
