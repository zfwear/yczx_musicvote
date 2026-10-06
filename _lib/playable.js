/**
 * 「这一版到底能不能播」。
 *
 * 为什么单独成一个模块（2026-10-07）：
 *   同一个判断有**两个**使用方，而且必须给出完全一致的结论：
 *     · `functions/api/music.js` —— 搜索时给候选打 `playable` 标记、`?check=<id>` 惰性校验、
 *       以及 `?play=<id>` 真正取音频；
 *     · `functions/api/admin-list.js` —— 审核列表要告诉管理员"学生锁定的这一版播不出来"。
 *   各写一套就会出现"学生端能播、审核端说不能"这种最难查的分歧。
 *
 * ⚠️ 2026-10-07 的第二版（用户反馈"我能找到资源免费的音乐也显示无音频"）：
 *   第一版把判据写成"网易云 outer/url 有没有 302 到 m*.music.126.net"，
 *   于是产生**大量假阴性**：
 *     · outer/url 这一条路拿不到 ≠ 这首歌没音频。GD Studio（现在是**首选源**）
 *       用 `types=url` 常常能拿到同一首歌的完整音频；
 *     · 只要响应不是"标准的那一种 302"，旧代码就一律记 false —— 包括
 *       "没有 Location"、"跳到了别的域名"、"返回 200"，这些其实都只是**不确定**。
 *   现在改两条，方向都是**宁可说"不确定"也不冤枉歌**：
 *     1. 只有在**亲眼看到"跳回 music.163.com 自己的页面"**（版权受限的特征）
 *        时才记 false；其余一切异常（无 Location / 未知域名 / 非 3xx）都记 null。
 *     2. 记 false 之后**再问一遍中转源**（由调用方注入 `fallback`，见下面的参数说明）——
 *        任一条路拿得到音频就算能播。
 *
 * 三种返回值，语义不能混：
 *   true  —— 确认能出音频
 *   false —— 确认**所有**路都拿不到音频（才允许打"无音频"标记）
 *   null  —— 不确定（探测失败 / 超时 / 不认识的情况）：任何一方都不该当成"没音频"
 */

/** 探测结果的缓存时长。翻来覆去搜同一首歌、审核列表反复加载时不必重复探。 */
const PLAYABLE_TTL_MS = 10 * 60 * 1000;
/** 缓存条目上限（Worker isolate 内存有限）。 */
const PLAYABLE_MAX = 400;

const playableCache = new Map();      // id -> { ok: boolean|null, at: number }

function cached(id) {
  const hit = playableCache.get(id);
  if (hit && Date.now() - hit.at < PLAYABLE_TTL_MS) return hit.ok;
  return null;
}

function remember(id, ok) {
  if (playableCache.size > PLAYABLE_MAX) {
    const keys = Array.from(playableCache.keys()).slice(0, 100);
    for (const k of keys) playableCache.delete(k);
  }
  playableCache.set(id, { ok, at: Date.now() });
}

/** 网易云播放地址：outer/url 会 302 跳到真实 CDN 直链（完整歌曲）。 */
export function neteaseOuterUrl(songId) {
  return `https://music.163.com/song/media/outer/url?id=${encodeURIComponent(songId)}.mp3`;
}

/** 从 `mt-123456` 这种带前缀的音源 id 里取出网易云数字 id；不是就返回 ''。 */
export function neteaseIdOf(trackId) {
  const m = /^mt-(\d{1,20})$/.exec(String(trackId || ''));
  return m ? m[1] : '';
}

/**
 * 网易云这一条路能不能出音频（只看这一条，不代表整首歌没音频）。
 * @returns {Promise<boolean|null>} true=能拿到，false=**确定**被版权挡住，null=不确定
 */
export async function probeNeteasePlayable(songId) {
  const hit = cached(songId);
  if (hit !== null) return hit;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500);
  try {
    const first = await fetch(neteaseOuterUrl(songId), {
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        'User-Agent': 'yczx-musicvote/1.0',
        Referer: 'https://music.163.com/',
        Cookie: 'appver=2.0.2',
      },
    });
    const status = first.status;
    const location = first.headers.get('Location') || '';
    try { await first.body?.cancel(); } catch { /* 重定向响应没有 body */ }

    // 是 3xx 吗？不是就没法判断（网易云有时直接回 200 或 403），交给上层当"不确定"。
    if (!(status >= 300 && status < 400)) return null;
    if (!location) return null;

    let host = '';
    try { host = new URL(location, neteaseOuterUrl(songId)).host; } catch { return null; }

    // 唯一敢下结论"拿不到"的情况：**跳回了 music.163.com 自己的页面**
    //（受版权限制的歌就是这个表现 —— 实测 Beyond《海阔天空》、米津玄師《Lemon》）。
    if (/(^|\.)music\.163\.com$/.test(host) || /(^|\.)163\.com$/.test(host)) {
      remember(songId, false);
      return false;
    }

    // 跳到网易云自家的 CDN（m*.music.126.net 之类）→ 能播。
    if (/(^|\.)126\.net$/.test(host)) {
      remember(songId, true);
      return true;
    }

    // 跳到了别的域名：可能是没那么标准的 CDN，也可能是别的东西 —— 我们**不认识**，
    // 所以返回 null（不确定），而不是像旧代码那样一口咬定"没音频"。
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 一个音源 id 能不能播。
 *
 * @param {string} trackId 形如 `mt-123456` / `ap-789`
 * @param {(numericId: string) => Promise<string|null>} [fallback]
 *        网易云那条路明确拿不到时，再问一遍别的路（中转源）用的回调 ——
 *        由调用方注入，因为"怎么问中转源"的逻辑在 music.js 里（metingResolve），
 *        这里不该重复实现一份 URL 解析。
 * @returns {Promise<boolean|null>}
 */
export async function trackPlayable(trackId, fallback) {
  const id = String(trackId || '');
  // 苹果给的是官方 previewUrl，一定有音频。
  if (/^ap-/.test(id)) return true;

  const numeric = neteaseIdOf(id);
  if (numeric) {
    const netease = await probeNeteasePlayable(numeric);
    if (netease !== false) return netease;         // true 或 null 都照原样返回
    // 网易云明确拿不到：还有别的路可走吗？（GD Studio 现在就是首选源）
    if (typeof fallback === 'function') {
      try {
        const url = await fallback(numeric);
        if (url) return true;
      } catch { /* 中转源本身出错：不确定，不能因此说"没音频" */ }
      return false;                                 // 中转源都问了、都没有 -> 确认拿不到
    }
    return false;
  }

  // 非数字 id（GD / Meting 自己的 id）：只能靠中转源问。
  if (typeof fallback === 'function') {
    try {
      const url = await fallback(id);
      if (url) return true;
      return false;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 给一批音源 id 批量问"能不能播"，返回 `Map<trackId, boolean|null>`。
 *
 * 给审核列表用：管理员一眼要看到"哪几首播不出来"，所以**服务端一次问完**，
 * 而不是让前端对每张卡片各发一个请求 —— 那会撞上试听接口的额度，
 * 一个列表就把管理员的额度烧掉一大半。
 *
 * 边界都是刻意设的：
 *   · 最多探 `limit` 条：列表可能有几百条历史数据，不能让一次列表加载去打几百个上游；
 *   · 有总截止时间：到点还没探完的一律 null（不确定），列表照常快速返回；
 *   · 已有缓存结论的直接用，不占用 limit 名额。
 */
export async function playableMapForIds(trackIds, { resolve, limit = 40, concurrency = 6, deadlineMs = 2500 } = {}) {
  const out = new Map();
  const targets = [];
  for (const id of trackIds) {
    const key = String(id || '');
    if (!key || out.has(key)) continue;
    if (/^ap-/.test(key)) { out.set(key, true); continue; }
    targets.push(key);
  }

  const queue = targets.slice(0, limit);
  for (const key of targets.slice(limit)) out.set(key, null);

  const deadline = Date.now() + deadlineMs;
  const worker = async () => {
    while (queue.length && Date.now() < deadline) {
      const key = queue.shift();
      // eslint-disable-next-line no-await-in-loop
      const ok = await resolve(key);
      out.set(key, ok);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));

  for (const key of targets) if (!out.has(key)) out.set(key, null);
  return out;
}

/**
 * 并发过滤网易云候选：给"确认拿不到音频"的候选打 `playable: false` 标记。
 *
 * ⚠️ 这里**从不删除**候选，只打标记。
 *
 * 为什么（用户反馈："搜索雨爱居然只能出 DJ 版"）：有些歌的**原唱**
 * 受版权限制拿不到音频，直接删掉整条会让原唱**从列表里消失**，
 * 学生只能看到翻唱/DJ 版，以为"系统搜不到原唱"。打标记则由前端显示"无试听"。
 *
 * 2026-10-07（用户："无音频的是能入选的"）：打了标记的候选**仍然可以选**，
 * 只是不能试听；审核界面会明确告诉管理员"这一版没有音频"。
 */
export async function keepPlayableNetease(songs, { resolve } = {}) {
  if (!Array.isArray(songs) || !songs.length) return songs;
  const targets = songs.filter((s) => /^mt-/.test(String(s.id || '')));
  if (!targets.length) return songs;

  const verdicts = await playableMapForIds(targets.map((s) => s.id), {
    resolve: resolve || ((id) => probeNeteasePlayable(neteaseIdOf(id))),
    limit: targets.length,          // 搜索候选本来就只有几十条
    concurrency: 6,
    deadlineMs: 4000,               // 别把搜索拖慢
  });

  return songs.map((s) => (verdicts.get(String(s.id)) === false ? { ...s, playable: false } : s));
}
