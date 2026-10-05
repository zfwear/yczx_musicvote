import { readJson, error, json } from '../../_lib/http.js';
import { requireSession, requireStaff, isGuestSession, readSession } from '../../_lib/auth.js';
import { parsePositiveInt, parseEnum } from '../../_lib/validate.js';
import { changedRows, isMissingTable } from '../../_lib/db.js';

/**
 * 每周歌单。
 *
 * 用户澄清的语义：**一周总共 6 首**，整周每天都播这 6 首（不是每天换 6 首）。
 *   中午放学 = 3 首含歌词的音乐
 *   下午上学 = 3 首纯音乐
 * 下周换一批，所以歌消耗得比较快 —— 接口支持一次排好几周。
 *
 * GET  —— 从某一周起，往后连续读若干周（学生与管理员都能看）
 * POST —— 管理员：排某一周 / 连续排多周 / 指定某个位置 / 清空
 */

const PERIODS = ['noon', 'afternoon'];
const PER_WEEK = 3;                  // 每个时段 3 首 → 一周 6 首
const MAX_WEEKS = 12;                // 一次最多排/看 12 周

const MIGRATION_HINT =
  '数据库尚未执行 012 迁移（缺少每周歌单表），'
  + '请先在 D1 控制台执行 sql/012_weekly_schedule.sql';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(raw, field = '日期') {
  const value = String(raw == null ? '' : raw).trim();
  if (!DATE_PATTERN.test(value)) return { ok: false, error: `${field}格式应为 YYYY-MM-DD` };
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
    return { ok: false, error: `${field}不是有效日期` };
  }
  return { ok: true, value };
}

/** 取某天所在那一周的周一（按 UTC 算，避免受运行时区影响）。 */
function mondayOf(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const dow = d.getUTCDay();               // 0=周日
  d.setUTCDate(d.getUTCDate() - (dow === 0 ? 6 : dow - 1));
  return d.toISOString().slice(0, 10);
}

function addWeeks(monday, n) {
  const d = new Date(`${monday}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n * 7);
  return d.toISOString().slice(0, 10);
}

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export async function onRequestGet(context) {
  const { request, env } = context;

  const auth = await requireSession(env, request, null);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const from = parseDate(
    url.searchParams.get('week_start') || new Date().toISOString().slice(0, 10),
    '起始周'
  );
  if (!from.ok) return error(from.error, 400);

  const weeksRaw = Number(url.searchParams.get('weeks') || 4);
  const weeks = Number.isInteger(weeksRaw) && weeksRaw >= 1 && weeksRaw <= MAX_WEEKS ? weeksRaw : 4;

  const start = mondayOf(from.value);
  const end = addWeeks(start, weeks);      // 不含

  try {
    const { results } = await env.DB.prepare(
      `SELECT w.week_start, w.period, w.position,
              CAST(w.song_id AS INTEGER) AS song_id,
              s.title, s.artist, s.track_id,
              c.name AS category_name
         FROM weekly_playlist w
         LEFT JOIN songs s      ON s.id = w.song_id
         LEFT JOIN categories c ON s.category_id = c.id
        WHERE w.week_start >= ? AND w.week_start < ?
        ORDER BY w.week_start ASC,
                 CASE w.period WHEN 'noon' THEN 0 ELSE 1 END,
                 w.position ASC`
    ).bind(start, end).all();

    // 把行按周组织好，并把"没有歌"的周也补出来，前端好渲染
    const byWeek = new Map();
    for (const row of results || []) {
      if (!byWeek.has(row.week_start)) byWeek.set(row.week_start, []);
      byWeek.get(row.week_start).push(row);
    }

    const out = [];
    for (let i = 0; i < weeks; i++) {
      const ws = addWeeks(start, i);
      out.push({
        weekStart: ws,
        weekEnd: addDays(ws, 4),          // 周五
        slots: byWeek.get(ws) || [],
      });
    }

    return json({
      weekStart: start,
      weeks,
      perWeek: PER_WEEK * PERIODS.length,
      periods: PERIODS,
      weeklies: out,
    });
  } catch (err) {
    if (isMissingTable(err)) return error(MIGRATION_HINT, 500);
    throw err;
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const auth = await requireStaff(env, request);
  if (!auth.ok) {
    // 排期本来就是管理员专属（requireStaff），游客拿的是学生会话，
    // 理论上进不来。但这里要把话说明白：游客真正去做这件事时如果只看到
    // 「登录已过期，请重新登录」，他会以为重新登录就能排期 —— 于是反复试。
    // 所以先认一下"是不是游客"，是的话给一句准确的 403。
    // 注意顺序：**先 requireStaff 再认游客**，这样同时持有管理员 Cookie 的
    // 浏览器（一边登录后台、一边开着游客会话）仍然正常排期，不会被误伤。
    const classSession = await readSession(env, request, 'class').catch(() => null);
    if (isGuestSession(classSession)) return error('游客模式只能查看排行，不能排期', 403);
    return auth.response;
  }

  const parsed = await readJson(request);
  if (!parsed.ok) return error(parsed.error, 400);
  const data = parsed.value;

  try {
    if (data.action === 'autofill') return await autofill(env, data);
    if (data.action === 'set_slot') return await setSlot(env, data);
    if (data.action === 'clear_slot') return await clearSlot(env, data);
    if (data.action === 'clear_week') return await clearWeek(env, data);
    return error('未知操作', 400);
  } catch (err) {
    if (isMissingTable(err)) return error(MIGRATION_HINT, 500);
    throw err;
  }
}

/**
 * 排期。
 *
 * 一周 6 首（中午 3 含歌词 + 下午 3 纯音乐），默认把**已排过的歌**排除在外，
 * 这样连着排好几周也不会重复；歌不够时再从用过的里面按顺序补，并如实报告。
 */
async function autofill(env, data) {
  const from = parseDate(data.week_start, '起始周');
  if (!from.ok) return error(from.error, 400);

  const weeksRaw = Number(data.weeks || 1);
  const weeks = Number.isInteger(weeksRaw) && weeksRaw >= 1 && weeksRaw <= MAX_WEEKS ? weeksRaw : 1;
  const start = mondayOf(from.value);

  // 已经排过的歌（所有周）——避免跨周重复
  const { results: usedRows } = await env.DB.prepare(
    'SELECT DISTINCT CAST(song_id AS INTEGER) AS id FROM weekly_playlist WHERE song_id IS NOT NULL'
  ).all();
  const alreadyUsed = new Set((usedRows || []).map((r) => Number(r.id)));

  // 候选：已通过的歌，按正式榜规则排序（分类权重降序 → 票数降序）
  const { results: songRows } = await env.DB.prepare(
    `SELECT s.id, s.category_id
       FROM songs s
       JOIN categories c ON s.category_id = c.id
      WHERE s.status = 'approved'
      ORDER BY CAST(c.weight AS INTEGER) DESC, CAST(s.votes AS INTEGER) DESC, s.id ASC`
  ).all();

  const all = songRows || [];
  const withLyrics = all.filter((s) => Number(s.category_id) !== 1);
  const instrumental = all.filter((s) => Number(s.category_id) === 1);

  let cursorLyric = 0;
  let cursorInst = 0;
  let filled = 0;
  let reused = 0;
  const total = weeks * PERIODS.length * PER_WEEK;

  const pick = (list, cursorName) => {
    // 先从没用过的里面找；找不到就从头再来（允许重复），并记一笔
    for (let i = 0; i < list.length; i++) {
      const idx = (cursorName === 'lyric' ? cursorLyric : cursorInst) + i;
      const s = list[idx % list.length];
      if (s && !alreadyUsed.has(s.id)) {
        if (cursorName === 'lyric') cursorLyric = idx + 1;
        else cursorInst = idx + 1;
        alreadyUsed.add(s.id);
        return { id: s.id, isReuse: false };
      }
    }
    // 全用过了：按游标顺序取一个（重复使用）
    const s = cursorName === 'lyric'
      ? withLyrics[cursorLyric % Math.max(1, withLyrics.length)]
      : instrumental[cursorInst % Math.max(1, instrumental.length)];
    if (cursorName === 'lyric') cursorLyric += 1;
    else cursorInst += 1;
    return s ? { id: s.id, isReuse: true } : null;
  };

  for (let w = 0; w < weeks; w++) {
    const weekStart = addWeeks(start, w);

    for (const period of PERIODS) {
      for (let pos = 1; pos <= PER_WEEK; pos++) {
        const isNoon = period === 'noon';
        const primary = isNoon ? withLyrics : instrumental;
        const secondary = isNoon ? instrumental : withLyrics;

        // 优先本类；本类空了再从另一类补，保证位置被填满
        let picked = pick(primary.length ? primary : secondary, isNoon ? 'lyric' : 'inst');
        if (!picked) picked = pick(secondary, isNoon ? 'inst' : 'lyric');

        if (picked) {
          filled += 1;
          if (picked.isReuse) reused += 1;
        }

        await env.DB.prepare(
          `INSERT INTO weekly_playlist (week_start, period, position, song_id, updated_at)
           VALUES (?, ?, ?, ?, datetime('now'))
           ON CONFLICT(week_start, period, position)
           DO UPDATE SET song_id = excluded.song_id, updated_at = datetime('now')`
        ).bind(weekStart, period, pos, picked ? picked.id : null).run();
      }
    }
  }

  return json({
    ok: true,
    weekStart: start,
    weeks,
    filled,
    total,
    reused,
    message: `已排好 ${weeks} 周，共 ${filled}/${total} 个位置`
      + (reused
        ? `；已通过的歌不够覆盖这么多周，有 ${reused} 个位置重复使用了曲目 —— 建议先审核通过更多歌，或减少一次排的周数。`
        : '，且各周之间没有重复曲目。'),
  });
}

async function setSlot(env, data) {
  const date = parseDate(data.week_start || data.date, '周起始日');
  if (!date.ok) return error(date.error, 400);
  const weekStart = mondayOf(date.value);

  const period = parseEnum(data.period, PERIODS, { field: '时段' });
  if (!period.ok) return error(period.error, 400);

  const position = parsePositiveInt(data.position, { field: '位置', max: PER_WEEK });
  if (!position.ok) return error(position.error, 400);

  const songId = parsePositiveInt(data.song_id, { field: '歌曲' });
  if (!songId.ok) return error(songId.error, 400);

  const song = await env.DB.prepare(
    "SELECT id FROM songs WHERE id = ? AND status = 'approved'"
  ).bind(songId.value).first();
  if (!song) return error('只能排已通过审核的歌', 400);

  await env.DB.prepare(
    `INSERT INTO weekly_playlist (week_start, period, position, song_id, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(week_start, period, position)
     DO UPDATE SET song_id = excluded.song_id, updated_at = datetime('now')`
  ).bind(weekStart, period.value, position.value, songId.value).run();

  return json({ ok: true, message: '已排入该位置' });
}

async function clearSlot(env, data) {
  const date = parseDate(data.week_start || data.date, '周起始日');
  if (!date.ok) return error(date.error, 400);

  const period = parseEnum(data.period, PERIODS, { field: '时段' });
  if (!period.ok) return error(period.error, 400);

  const position = parsePositiveInt(data.position, { field: '位置', max: PER_WEEK });
  if (!position.ok) return error(position.error, 400);

  const result = await env.DB.prepare(
    "UPDATE weekly_playlist SET song_id = NULL, updated_at = datetime('now') WHERE week_start = ? AND period = ? AND position = ?"
  ).bind(mondayOf(date.value), period.value, position.value).run();

  if (changedRows(result) === 0) return error('这个位置还不存在', 404);
  return json({ ok: true, message: '已清空该位置' });
}

async function clearWeek(env, data) {
  const date = parseDate(data.week_start, '周起始日');
  if (!date.ok) return error(date.error, 400);
  const weekStart = mondayOf(date.value);

  const result = await env.DB.prepare(
    'DELETE FROM weekly_playlist WHERE week_start = ?'
  ).bind(weekStart).run();

  return json({ ok: true, deleted: changedRows(result), message: '已清空这一周' });
}
