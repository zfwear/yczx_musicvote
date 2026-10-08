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

/**
 * `add_song` 往后找几周。
 *
 * 「加入排期」是管理员在某一首歌上点一下，期望是"尽快播出去"，
 * 不是"排到天荒地老"。所以从本周起往后最多试 4 周；4 周都放不下就
 * 如实报错让他自己决定 —— 继续往后铺只会把歌排到一个月以后，
 * 那时候这首歌还流不流行都难说。
 */
const ADD_SONG_MAX_WEEKS = 4;

/** 时段的中文名，用在给人看的 message 里。 */
const PERIOD_LABELS = {
  noon: '中午放学（含歌词）',
  afternoon: '下午上学（纯音乐）',
};

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

/** 本周一（按 UTC 算，与 mondayOf 同一套口径）。 */
function thisMonday() {
  return mondayOf(new Date().toISOString().slice(0, 10));
}

/** 「本周 / 下周 / 再下一周 / N 周后」——给人看的相对说法。 */
function relativeWeekLabel(offset) {
  if (offset === 0) return '本周';
  if (offset === 1) return '下周';
  if (offset === 2) return '再下一周';
  return `${offset} 周后`;
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
    // 老库没跑 012 迁移时**不要整页报错**：照常返回空的三周，
    // 页面能打开（显示"待排歌曲"），再附 needsMigration 让前端提示管理员。
    if (isMissingTable(err)) {
      const out = [];
      for (let i = 0; i < weeks; i++) {
        const ws = addWeeks(start, i);
        out.push({ weekStart: ws, weekEnd: addDays(ws, 4), slots: [] });
      }
      return json({
        weekStart: start,
        weeks,
        perWeek: PER_WEEK * PERIODS.length,
        periods: PERIODS,
        weeklies: out,
        needsMigration: true,
        hint: MIGRATION_HINT,
      });
    }
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
    if (data.action === 'add_song') return await addSong(env, data);
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
 * 一键排期。
 *
 * 规则（2026-10-07 用户明确要求，与原实现有三处不同）：
 *
 *   1. **相邻两周不重复**：同一首歌不能同时出现在第 N 周与第 N±1 周。
 *      注意**不是"全局不重复"** —— 隔开一周的老歌可以再用。
 *      原实现把"所有周排过的歌"全排除掉，几周之后就没歌可排了。
 *   2. **歌不够就留「待排」**（song_id = NULL），**不拿别的歌凑**：
 *      中午只放含歌词的、下午只放纯音乐的，本类别用完了就空着。
 *      原实现有两个凑数动作都与这条相反：跨类别补位、不够时循环复用旧歌。
 *   3. 一次排期内每首歌只用一次（所以相邻两周必然不重复）。
 *
 * 一周 6 个位置：中午放学 3 首含歌词 + 下午上学 3 首纯音乐。
 *
 * 2026-10-07 追加：可选 `category_id`（正整数）**按音乐类型筛选候选**。
 *   它与"中午 / 下午"的类别分工是**叠加**关系，不是替代关系：
 *   给了 `category_id = 2`（中文歌）之后，中午那 3 个位置只有中文歌可排，
 *   而下午需要纯音乐 —— 候选里一首纯音乐都没有，于是**下午整段留「待排」**。
 *   这不是 bug，是这个筛选的必然结果，所以 message 里必须把它说清楚，
 *   否则管理员会以为排期坏了。
 */
async function autofill(env, data) {
  const from = parseDate(data.week_start, '起始周');
  if (!from.ok) return error(from.error, 400);

  // 只在**真的给了值**的时候才校验：空串 / null / undefined 一律当"没筛"。
  // 这样前端"全部"那一项可以安全地不带这个字段，
  // 而 0、-1、1.5、'abc' 这些给了的非法值必须报 400。
  const rawCategory = data.category_id === undefined || data.category_id === null
    ? ''
    : String(data.category_id).trim();
  let categoryId = 0;
  let categoryName = '';
  if (rawCategory !== '') {
    const parsed = parsePositiveInt(rawCategory, { field: '音乐类型' });
    if (!parsed.ok) return error(parsed.error, 400);
    categoryId = parsed.value;

    const row = await env.DB.prepare('SELECT id, name FROM categories WHERE id = ?')
      .bind(categoryId).first();
    if (!row) return error('没有这个音乐类型', 400);
    categoryName = String(row.name || '').trim() || `#${categoryId}`;
  }

  const weeksRaw = Number(data.weeks || 1);
  const weeks = Number.isInteger(weeksRaw) && weeksRaw >= 1 && weeksRaw <= MAX_WEEKS ? weeksRaw : 1;
  const start = mondayOf(from.value);
  const lastWeek = addWeeks(start, weeks - 1);

  // 相邻两周不重复：只把**紧邻排期范围的上下两周**里已排的歌算作"被占用"。
  // 为什么不把范围内的周也算进来：那几周**马上要被覆盖**，它们现有的内容
  // 不该挡住这一次排期（否则"重排同一周"会莫名其妙地排不出东西）。
  const { results: usedRows } = await env.DB.prepare(
    `SELECT DISTINCT CAST(song_id AS INTEGER) AS id FROM weekly_playlist
      WHERE song_id IS NOT NULL AND week_start IN (?, ?)`
  ).bind(addWeeks(start, -1), addWeeks(lastWeek, 1)).all();
  const alreadyUsed = new Set((usedRows || []).map((r) => Number(r.id)));

  // 候选：已通过的歌，按正式榜规则排序（分类权重降序 → 票数降序）。
  // 给了 category_id 就**只留这一类** —— 这是筛选，不是"加权"，别的类别不参与。
  const { results: songRows } = await env.DB.prepare(
    `SELECT s.id, s.category_id
       FROM songs s
       JOIN categories c ON s.category_id = c.id
      WHERE s.status = 'approved'${categoryId ? ' AND s.category_id = ?' : ''}
      ORDER BY CAST(c.weight AS INTEGER) DESC, CAST(s.votes AS INTEGER) DESC, s.id ASC`
  ).bind(...(categoryId ? [categoryId] : [])).all();

  const all = songRows || [];
  const withLyrics = all.filter((s) => Number(s.category_id) !== 1);
  const instrumental = all.filter((s) => Number(s.category_id) === 1);

  let cursorLyric = 0;
  let cursorInst = 0;
  let filled = 0;
  let empty = 0;
  const total = weeks * PERIODS.length * PER_WEEK;

  const pick = (list, cursorName) => {
    // 从游标往后找一首没被占用的；`% list.length` 只是防止越界，不是"从头再来"。
    for (let i = 0; i < list.length; i++) {
      const idx = (cursorName === 'lyric' ? cursorLyric : cursorInst) + i;
      const s = list[idx % list.length];
      if (s && !alreadyUsed.has(s.id)) {
        if (cursorName === 'lyric') cursorLyric = idx + 1;
        else cursorInst = idx + 1;
        alreadyUsed.add(s.id);
        return { id: s.id };
      }
    }
    // 这一类别的歌用完了 → 返回 null，调用方把这个位置留成「待排」。
    // 原实现这里会**从头循环复用**旧歌，用户明确要求改成留空。
    return null;
  };

  for (let w = 0; w < weeks; w++) {
    const weekStart = addWeeks(start, w);

    for (const period of PERIODS) {
      for (let pos = 1; pos <= PER_WEEK; pos++) {
        const isNoon = period === 'noon';
        // **只用本类别**：中午只放含歌词的、下午只放纯音乐的。
        // 本类别没歌了就留「待排」—— 不再跨类别补位（用户要求"歌不够就填待排"）。
        const picked = pick(isNoon ? withLyrics : instrumental, isNoon ? 'lyric' : 'inst');

        if (picked) filled += 1;
        else empty += 1;

        await env.DB.prepare(
          `INSERT INTO weekly_playlist (week_start, period, position, song_id, updated_at)
           VALUES (?, ?, ?, ?, datetime('now'))
           ON CONFLICT(week_start, period, position)
           DO UPDATE SET song_id = excluded.song_id, updated_at = datetime('now')`
        ).bind(weekStart, period, pos, picked ? picked.id : null).run();
      }
    }
  }

  /*
   * message 要如实说清两件事：
   *   1. 本次一共填了几个位置、几个留成「待排」；
   *   2. 如果带了 category_id，**另一个时段没歌可排**是这个筛选的必然结果，
   *      不是排期坏了 —— 必须点名说出来，否则管理员会以为出 bug 了。
   */
  const scopeNote = categoryId
    ? `；本次只用了分类「${categoryName}」的歌`
      + (withLyrics.length === 0
        ? `，所以${PERIOD_LABELS.noon}没有含歌词的歌可排，那 3 个位置全部留成「待排」`
        : '')
      + (instrumental.length === 0
        ? `，所以${PERIOD_LABELS.afternoon}没有纯音乐可排，那 3 个位置全部留成「待排」`
        : '')
      + '。'
    : '';

  return json({
    ok: true,
    weekStart: start,
    weeks,
    filled,
    empty,
    total,
    message: `已排好 ${weeks} 周，共 ${filled}/${total} 个位置`
      + (empty
        ? `；有 ${empty} 个位置留成「待排」—— 已通过、且属于该时段的歌不够了。`
          + '（本次排期内每首歌只用一次，所以相邻两周不会重复；'
          + '等审核通过更多歌之后再排一次即可，那时隔开一周的老歌可以再用。）'
        : '，且相邻两周没有重复曲目。')
      + scopeNote,
  });
}

/**
 * 把一首歌加入排期（后台「已通过」页签上每首歌一个「加入排期」按钮）。
 *
 * 请求：`{ action: 'add_song', song_id: <id> }`
 *
 * 规则（用户原话推导，逐条照做）：
 *   1. **目标周**：从**本周**开始往后找，放进**最早的、有空位的**那一周。
 *      本周满了就下周，下周也满了就再往后 —— 最多找 4 周（ADD_SONG_MAX_WEEKS）。
 *   2. **位置**：由歌曲的 category_id 决定时段（纯音乐 1 → afternoon，
 *      其余含歌词 → noon），放进该时段里**第一个 song_id 为空的位置**（1 → 3）。
 *      已有的行 `song_id IS NULL` 也算空位，直接覆盖它。
 *   3. **相邻两周不重复**：这首歌若已出现在目标周的**前一周或后一周**，
 *      这一周就不能放，继续往后找。同一周里当然也不能出现两次。
 *   4. **只能排已通过审核的歌**（与 set_slot 同一套判据）。
 *   5. 4 周都放不下 → 400 + 一句人话，**分清**是"该时段排满了"还是
 *      "相邻周已经有这首歌" —— 这两种情况管理员要做的事完全不同。
 */
async function addSong(env, data) {
  const songId = parsePositiveInt(data.song_id, { field: '歌曲' });
  if (!songId.ok) return error(songId.error, 400);

  const song = await env.DB.prepare(
    "SELECT id, title, category_id FROM songs WHERE id = ? AND status = 'approved'"
  ).bind(songId.value).first();
  if (!song) return error('只能排已通过审核的歌', 400);

  // 纯音乐（category_id = 1）排下午；含歌词的排中午。与 autofill 同一套分工。
  const isInstrumental = Number(song.category_id) === 1;
  const period = isInstrumental ? 'afternoon' : 'noon';
  const periodLabel = PERIOD_LABELS[period];

  const start = thisMonday();
  // 候选周（0 ~ 3）连同它们各自的相邻周一次取回来，在内存里判断 ——
  // 6 周最多也就 36 行，比"每周查一次"要省得多，也更好读。
  const { results: rows } = await env.DB.prepare(
    `SELECT week_start, period, position, CAST(song_id AS INTEGER) AS song_id
       FROM weekly_playlist
      WHERE week_start >= ? AND week_start < ?`
  ).bind(addWeeks(start, -1), addWeeks(start, ADD_SONG_MAX_WEEKS + 1)).all();

  /** week_start → 该周的行。 */
  const byWeek = new Map();
  for (const row of rows || []) {
    if (!byWeek.has(row.week_start)) byWeek.set(row.week_start, []);
    byWeek.get(row.week_start).push(row);
  }
  const weekRows = (ws) => byWeek.get(ws) || [];
  const weekHasSong = (ws) => weekRows(ws).some((r) => Number(r.song_id) === songId.value);

  /** 该周此时段里第一个空位（没有行、或 song_id 为 NULL）。没有则返回 0。 */
  const firstFreePosition = (ws) => {
    const taken = new Set(
      weekRows(ws)
        .filter((r) => r.period === period && r.song_id !== null && r.song_id !== undefined)
        .map((r) => Number(r.position))
    );
    for (let pos = 1; pos <= PER_WEEK; pos++) if (!taken.has(pos)) return pos;
    return 0;
  };

  const fullWeeks = [];        // 该时段 3 个位置都占着
  const adjacentWeeks = [];    // 前后相邻的一周里已经有这首歌
  const duplicateWeeks = [];   // 这一周里就已经有这首歌了

  for (let offset = 0; offset < ADD_SONG_MAX_WEEKS; offset++) {
    const weekStart = addWeeks(start, offset);
    const label = relativeWeekLabel(offset);

    // 同一周内不能出现两次 —— 再点一次「加入排期」不该把它排两遍。
    if (weekHasSong(weekStart)) {
      duplicateWeeks.push(`${weekStart}（${label}）`);
      continue;
    }

    // 相邻两周不重复：判据是**前后相邻的那整周**（不限于同一时段）。
    if (weekHasSong(addWeeks(weekStart, -1)) || weekHasSong(addWeeks(weekStart, 1))) {
      adjacentWeeks.push(`${weekStart}（${label}）`);
      continue;
    }

    const position = firstFreePosition(weekStart);
    if (!position) {
      fullWeeks.push(`${weekStart}（${label}）`);
      continue;
    }

    await env.DB.prepare(
      `INSERT INTO weekly_playlist (week_start, period, position, song_id, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(week_start, period, position)
       DO UPDATE SET song_id = excluded.song_id, updated_at = datetime('now')`
    ).bind(weekStart, period, position, songId.value).run();

    const title = String(song.title || '').trim();
    return json({
      ok: true,
      week_start: weekStart,
      period,
      position,
      message: `已把${title ? `《${title}》` : '这首歌'}排到 ${weekStart}（${label}）`
        + `的${periodLabel}第 ${position} 首。`,
    });
  }

  // 4 周都放不下 —— 把两种原因分开说，别让管理员去猜。
  const reasons = [];
  if (fullWeeks.length) reasons.push(`${fullWeeks.join('、')} 的${periodLabel}已经排满 3 首`);
  if (adjacentWeeks.length) {
    reasons.push(`${adjacentWeeks.join('、')} 的前后相邻一周里已经有这首歌（相邻两周不能重复）`);
  }
  if (duplicateWeeks.length) reasons.push(`${duplicateWeeks.join('、')} 里本来就有这首歌，不能排两遍`);

  return error(
    `从本周（${start}）起往后 ${ADD_SONG_MAX_WEEKS} 周都放不下这首歌：`
    + `${reasons.join('；')}。请先腾出一个位置、或换一首歌再试。`,
    400
  );
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
