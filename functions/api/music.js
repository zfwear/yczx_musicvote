import { error, json, clientIp } from '../../_lib/http.js';
import { requireSession, rateLimit, rateLimitOnce, countBudget } from '../../_lib/auth.js';
import { sanitizeText } from '../../_lib/validate.js';
import { signTrackToken } from '../../_lib/tracktoken.js';

/**
 * 音源中转代理（试听）。
 *
 * ⚠️ 安全约束：**客户端永远无法指定上游地址。**
 *    客户端只能传"关键词"或"歌曲 id"，上游地址由服务端决定。
 *    否则这个接口会立刻变成任何人都能用的开放代理 / SSRF 跳板。
 *
 * 音源选型参考了开源校园广播站点歌系统 VoiceHub
 * (github.com/laoshuikaixue/VoiceHub) 的 musicSources.ts，并逐个实测：
 *   ✅ api.qijieya.cn/meting/   可用，302 跳转到可播放音频（完整歌曲）
 *   ✅ api.injahow.cn/meting/   可用，同上
 *   ❌ api.ygking.top           域名已失效
 *   ❌ music-api.gdstudio.xyz   连接超时
 *   ❌ api.bilibili.com         412，需要 WBI 签名，必须自建服务
 *   ✅ itunes.apple.com         官方 30 秒试听，无需 key（兜底）
 *
 * 策略：默认 'auto' —— Meting 与苹果**并行**发起，优先采用 Meting（完整歌曲），
 *      拿不到就自动用苹果官方试听兜底。任何一家挂掉都不会让功能失效。
 *
 * 歌曲 id 带音源前缀（mt-xxx / ap-xxx），这样播放时不必猜测该用哪家，
 * 也避免两家的数字 id 互相撞车。
 *
 * A7（音源一致性）：搜索结果里每个候选都会额外带一张**服务端签名的
 * 短期选曲凭据**（`token`）。点歌时把它一起提交，服务端就能确认
 * "歌名 + 歌手 + 音源 id"确实来自同一次搜索、属于同一首歌。
 * 详见 _lib/tracktoken.js 与 functions/api/vote.js。
 *
 * 环境变量（全部可选，不配也能用）：
 *   MUSIC_PROVIDER    'auto'（默认）| 'meting' | 'apple'
 *   MUSIC_API_BASE    覆盖 Meting 上游根地址
 *   MUSIC_STOREFRONT  苹果商店地区，默认 hk（cn 商店不通过接口提供歌曲）
 */

const SEARCH_TIMEOUT_MS = 6000;
const AUDIO_TIMEOUT_MS = 15000;
const MAX_RESULTS = 8;
const MAX_FIELD_LENGTH = 120;

/* ------------------------------------------------------------------
 * 上游调用的资源护栏（审计 C3）
 *
 * 为什么必须有：下游只要拿到一个 50MB 的响应体，或者一个"连上了但
 * 一直不吐字节"的连接，这个 Worker 就会一直占着 CPU 与内存 ——
 * 免费套餐下这是最容易被上游拖垮的地方。所以：
 *   · 搜索类响应体上限 512KB（正常几百字节到几十 KB），解析前先卡住
 *   · 音频转发上限 12MB，超了就断开而不是整首吞进内存
 *   · 解析（读取 body）也在同一个时限之内："fetch 返回了"不等于
 *     "数据到了"，超时必须覆盖到 body 读完，否则慢速响应体可以无限拖时间
 * ------------------------------------------------------------------ */
const SEARCH_BODY_LIMIT = 512 * 1024;
const AUDIO_BODY_LIMIT = 12 * 1024 * 1024;

/* ------------------------------------------------------------------
 * 搜索编排的参数（审计 C3）
 * ------------------------------------------------------------------ */
/** 搜索结果缓存时长：降级阶段会用同一个关键词再搜一次，必须复用而不是重发。 */
const SEARCH_CACHE_TTL_MS = 120 * 1000;
/** 最多缓存多少关键词（Worker isolate 内存有限，必须有上限）。 */
const SEARCH_CACHE_MAX = 200;
/** "优先源等待窗口"：优先源在这段时间内没给出**合规**结果就先返回别家的。 */
const PREFERRED_GRACE_MS = 900;
/** 单个音源连续失败几次进入熔断。 */
const SOURCE_FAILURE_THRESHOLD = 3;
/** 熔断冷却时长：给故障源一点恢复时间，又不至于让它长时间不可用。 */
const SOURCE_COOLDOWN_MS = 90 * 1000;
/**
 * "满足条件"的最低相似度。
 *
 * 为什么不能只看"有没有结果"：一个查不到歌名的音源经常返回一堆
 * 名字完全不相关的歌（模糊匹配兜底）。那种结果即使"非空"也不该
 * 抢先返回。所以只有结果的相似度过线，才算"首个可用的结果"。
 */
const MIN_TITLE_SCORE = 0.5;

const DEFAULT_METING_BASES = [
  'https://api.qijieya.cn/meting/',
  'https://api.injahow.cn/meting/',
];
const DEFAULT_STOREFRONTS = ['hk', 'tw', 'us'];

/** 苹果返回的部分容器格式浏览器认不出来，统一成标准 MIME。 */
const AUDIO_MIME_MAP = {
  'audio/x-m4p': 'audio/mp4',
  'audio/x-m4a': 'audio/mp4',
  'audio/mp4a-latm': 'audio/mp4',
};

function clip(value, max = MAX_FIELD_LENGTH) {
  return String(value ?? '').slice(0, max);
}

function providerMode(env) {
  const raw = env && typeof env.MUSIC_PROVIDER === 'string' ? env.MUSIC_PROVIDER.trim().toLowerCase() : '';
  if (raw === 'meting' || raw === 'apple') return raw;
  return 'auto';
}

function metingBases(env) {
  const configured = env && typeof env.MUSIC_API_BASE === 'string' ? env.MUSIC_API_BASE.trim() : '';
  if (configured) return [configured.replace(/\/+$/, '') + '/'];
  return DEFAULT_METING_BASES;
}

function storefronts(env) {
  const configured = env && typeof env.MUSIC_STOREFRONT === 'string' ? env.MUSIC_STOREFRONT.trim() : '';
  if (!configured) return DEFAULT_STOREFRONTS;
  return [configured, ...DEFAULT_STOREFRONTS.filter((c) => c !== configured)];
}

/**
 * 带**完整时限**与**响应体上限**的上游请求。
 *
 * 审计 C3 指出的坑：早先的写法是
 *     const res = await fetch(...); clearTimeout(timer); return res;
 * 超时计时器在 fetch 返回时就被清掉了，可此时 body 还没有读 ——
 * 一个"握上手就慢慢吐字节"的上游可以让读取阶段无限期挂着。而且
 * 响应体多大完全不设防，一个畸形/恶意的上游可以直接把内存撑爆。
 *
 * 所以改成：计时器活到**读出 body 之后**（由调用方 finally 里的
 * { body, cleanup } 收尾），并且在读取过程中逐块累加字节数，
 * 超过上限立即 abort。
 *
 * @returns {Promise<{res: Response, body: any, cleanup: () => void} | null>} 失败/超限返回 null
 */
async function fetchBounded(url, options = {}, {
  timeoutMs = SEARCH_TIMEOUT_MS,
  limit = SEARCH_BODY_LIMIT,
  parse = 'json',
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const cleanup = () => clearTimeout(timer);

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: { 'User-Agent': 'yczx-musicvote/1.0', ...(options.headers || {}) },
    });

    // 先看声明的长度：能提前拒绝就没必要真的去读。
    const declared = Number(res.headers.get('Content-Length'));
    if (Number.isFinite(declared) && declared > limit) return null;

    const text = await readBodyLimited(res, limit);
    if (text === null) return null;

    if (parse === 'text') return { res, body: text, cleanup };
    try {
      return { res, body: JSON.parse(text), cleanup };
    } catch {
      return null;
    }
  } catch {
    // 网络错误 / 超时 / 被 abort：一律当作"这个源这次没结果"
    return null;
  }
}

/**
 * 逐块读取响应体，超过上限返回 null。
 *
 * 为什么不直接用 res.text()：那样等于把上游声明的长度当成真的，
 * 分块传输（chunked）或撒谎的 Content-Length 都能把内存吃光。
 * 这里边读边数，同时受上面的超时计时器约束（abort 会打断读取）。
 */
async function readBodyLimited(res, limit) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    const text = await res.text();
    return text.length > limit ? null : text;
  }

  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value ? value.byteLength : 0;
      if (total > limit) {
        try { await reader.cancel(); } catch { /* 已经在关了 */ }
        return null;
      }
      if (value) chunks.push(value);
    }
  } catch {
    return null;
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(merged);
}

/* ======================= 音源健康度与短期缓存 ======================= */

/**
 * 音源熔断表。
 *
 * 为什么放在模块作用域：Worker 的 isolate 会被同一批请求复用，
 * 所以"这个源刚刚连续失败了 3 次"能传给下一个请求 —— 这正是要的效果，
 * 让一个已经挂掉的源在冷却期内不再拖慢每一次搜索。
 * isolate 被回收后自然归零，不会永久封杀。
 */
const sourceHealth = new Map();

function sourceCircuitOpen(name, now = Date.now()) {
  const entry = sourceHealth.get(name);
  if (!entry) return false;
  if (entry.until > now) return true;
  // 冷却结束：放它再试，但保留失败计数，连续失败会更快再次熔断
  entry.until = 0;
  return false;
}

function sourceMarkFailure(name, now = Date.now()) {
  const entry = sourceHealth.get(name) || { failures: 0, until: 0 };
  entry.failures += 1;
  if (entry.failures >= SOURCE_FAILURE_THRESHOLD) entry.until = now + SOURCE_COOLDOWN_MS;
  sourceHealth.set(name, entry);
}

function sourceMarkHealthy(name) {
  sourceHealth.set(name, { failures: 0, until: 0 });
}

/**
 * 搜索结果短期缓存。
 *
 * 两个作用，都不是"优化"而是"正确性/额度"：
 *   · 降级阶段第三步（模糊搜索）与第二步（只按歌名）关键词完全相同，
 *     没有缓存就会对同一关键词把上游再打一遍 —— 白白消耗上游配额，
 *     也会让"降级"这件事变慢一倍。
 *   · 用户连着点两次搜索（很常见，觉得没反应）不必再打一趟上游。
 */
const searchCache = new Map();

function cacheGet(key, now = Date.now()) {
  const hit = searchCache.get(key);
  if (!hit) return null;
  if (hit.expires <= now) {
    searchCache.delete(key);
    return null;
  }
  return hit.songs;
}

function cacheSet(key, songs, now = Date.now()) {
  // 只缓存有结果的：把"空结果"也缓存住会让一次上游抖动影响好几分钟
  if (!songs || !songs.length) return;
  searchCache.set(key, { songs, expires: now + SEARCH_CACHE_TTL_MS });
  if (searchCache.size > SEARCH_CACHE_MAX) {
    // Map 保证插入顺序，删掉最旧的那一批即可
    const drop = searchCache.size - SEARCH_CACHE_MAX;
    let i = 0;
    for (const k of searchCache.keys()) {
      searchCache.delete(k);
      if (++i >= drop) break;
    }
  }
}

/** 正在进行的同关键词搜索：并发请求合并成一次上游调用。 */
const inflightSearch = new Map();

/* ======================= Meting（完整歌曲） ======================= */

function normalizeMeting(payload) {
  const list = Array.isArray(payload) ? payload : [];
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object' || !item.name) continue;
    // Meting 返回的 url 形如 .../?server=netease&type=url&id=123456
    const match = String(item.url || '').match(/[?&]id=([A-Za-z0-9_-]+)/);
    if (!match) continue;
    out.push({
      id: `mt-${match[1]}`,
      name: clip(item.name),
      artist: clip(item.artist),
      album: clip(item.album || ''),
      duration: Number(item.duration) || 0,
      source: '网易云',
    });
    if (out.length >= MAX_RESULTS) break;
  }
  return out;
}

async function metingSearch(base, keywords) {
  const url = `${base}?server=netease&type=search&id=${encodeURIComponent(keywords)}`;
  const got = await fetchBounded(url, {}, { parse: 'json' });
  if (!got) return [];
  // 无论解析结果怎么样都要收尾计时器（否则 abort 计时器会一直挂着）
  got.cleanup();
  return normalizeMeting(got.body);
}

async function metingResolve(base, songId) {
  const url = `${base}?server=netease&type=url&id=${encodeURIComponent(songId)}`;

  // redirect: 'manual' —— 只要 Location，不要真的把音频下载下来。
  // 只用一次请求：3xx 时读 Location，200 时读 body（少数实现直接返回 URL 文本）。
  const got = await fetchBounded(url, { redirect: 'manual' }, { parse: 'text' });
  if (!got) return null;
  const { res, body, cleanup } = got;
  cleanup();

  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('Location');
    return location && /^https?:\/\//i.test(location) ? location : null;
  }
  if (!res.ok) return null;

  const text = String(body || '').trim();
  if (/^https?:\/\//i.test(text)) return text;
  try {
    const parsed = JSON.parse(text);
    const direct = parsed && (parsed.url || parsed.data);
    if (typeof direct === 'string' && /^https?:\/\//i.test(direct)) return direct;
  } catch {
    /* 忽略 */
  }
  return null;
}

/* ======================= 苹果官方 30 秒试听 ======================= */

function normalizeApple(payload) {
  const list = payload && Array.isArray(payload.results) ? payload.results : [];
  const out = [];
  for (const item of list) {
    if (!item || !item.trackId || !item.trackName || !item.previewUrl) continue;
    out.push({
      id: `ap-${clip(item.trackId, 40)}`,
      name: clip(item.trackName),
      artist: clip(item.artistName),
      album: clip(item.collectionName),
      duration: item.trackTimeMillis ? Math.round(Number(item.trackTimeMillis) / 1000) : 0,
      source: '苹果 30 秒试听',
    });
    if (out.length >= MAX_RESULTS) break;
  }
  return out;
}

async function appleSearch(keywords, storefront) {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(keywords)}`
    + `&country=${encodeURIComponent(storefront)}&media=music&entity=song&limit=${MAX_RESULTS}`;
  const got = await fetchBounded(url, {}, { parse: 'json' });
  if (!got) return [];
  got.cleanup();
  return normalizeApple(got.body);
}

async function appleResolve(trackId) {
  const url = `https://itunes.apple.com/lookup?id=${encodeURIComponent(trackId)}&entity=song`;
  const got = await fetchBounded(url, {}, { parse: 'json' });
  if (!got) return null;
  got.cleanup();

  const payload = got.body;
  const item = payload && Array.isArray(payload.results) ? payload.results[0] : null;
  const direct = item && item.previewUrl;
  return typeof direct === 'string' && /^https:\/\//i.test(direct) ? direct : null;
}

/* ======================= 搜索编排 ======================= */

/**
 * 歌名匹配度（0~1）。
 *
 * 用**覆盖率**而不是布尔判断：候选名里包含查询词的比例越高越可信。
 * 「七里香」搜出「七里香 (Live)」= 1；搜出「七里香外传：某某长篇」= 0.3 ——
 * 后者属于"沾边但明显不是"，不该被当成可用结果抢先返回。
 */
function matchScore(candidate, title) {
  const a = String(candidate || '').toLowerCase().replace(/\s+/g, '');
  const b = String(title || '').toLowerCase().replace(/\s+/g, '');
  if (!b) return 1;
  if (!a) return 0;
  if (a === b) return 1;
  if (a.includes(b)) return b.length / Math.max(a.length, 1);
  if (b.includes(a)) return a.length / Math.max(b.length, 1);
  return 0;
}

/** 保留原有的布尔语义（三级降级里"是否算匹配上"的判断）。 */
function matchesTitle(candidate, title) {
  const a = String(candidate || '').toLowerCase().replace(/\s+/g, '');
  const b = String(title || '').toLowerCase().replace(/\s+/g, '');
  if (!b) return true;
  return a.includes(b) || b.includes(a);
}

/** 把最像查询词的那一首排到第一位 —— 前端默认播第一个候选。 */
function rankByRelevance(songs, title) {
  return songs
    .map((song) => ({ song, score: matchScore(song.name, title) }))
    .sort((x, y) => y.score - x.score);
}

/** 一个音源的所有候选中，与查询词最接近的相似度。 */
function bestScore(songs, title) {
  let best = 0;
  for (const song of songs) {
    const score = matchScore(song.name, title);
    if (score > best) best = score;
  }
  return best;
}

/**
 * 一个关键词要问哪些音源。
 *
 * ⚠️ 优先级于 2026-10-05 调整过。原因是实测发现学生"搜不到想要的歌"：
 *
 *   搜「七里香」——
 *     · 苹果官方   → 第一条就是 七里香 / **周杰倫**（原唱）
 *     · 网易云抓取 → 第一条是 七里香 / **Xai小爱**（翻唱），整页都是无名翻唱
 *
 *   原设计把 Meting 排在前面，理由是"完整歌曲优于 30 秒试听"。
 *   但点歌场景里**歌手对不对远比时长重要** —— 学生要的是周杰伦那首，
 *   审核老师听到翻唱也会直接驳回。而且 Meting 是第三方抓取，
 *   苹果是官方接口（更稳、不会突然失效），30 秒试听对审核完全够用。
 *
 *   所以现在**苹果优先（order 0）**，Meting 退为兜底：
 *   苹果目录里没有的歌（部分华语冷门曲）仍能从 Meting 找到。
 *   想改回去就设 MUSIC_PROVIDER=meting。
 */
function buildSources(env, keywords) {
  const mode = providerMode(env);
  const sources = [];

  if (mode !== 'meting') {
    storefronts(env).forEach((cc, index) => {
      sources.push({
        name: `apple:${cc}`,
        // 多个 storefront 之间也要有先后：hk 的华语覆盖最好，放最前
        order: index,
        resolve: () => appleSearch(keywords, cc),
      });
    });
  }
  if (mode !== 'apple') {
    const storefrontCount = mode === 'meting' ? 0 : storefronts(env).length;
    metingBases(env).forEach((base, index) => {
      sources.push({
        name: `meting:${hostOf(base)}:${index}`,
        // 排在所有苹果源之后：只在苹果找不到时才用
        order: storefrontCount + index,
        resolve: () => metingSearch(base, keywords),
      });
    });
  }

  return sources;
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return String(url).slice(0, 40); }
}

/** 同一个关键词正在搜索时，后来者复用它，不再重复打上游。 */
function searchKeyFor(env, keywords) {
  const mode = providerMode(env);
  const bases = mode === 'apple' ? '' : metingBases(env).join(',');
  const stores = mode === 'meting' ? '' : storefronts(env).join(',');
  return `${keywords}\u0000${mode}\u0000${bases}\u0000${stores}`;
}

/**
 * 一次关键词搜索。
 *
 * 旧实现是 `await Promise.all(所有音源)` 再按优先级挑第一个有结果的 ——
 * 问题是**必须等最慢的那个**：一个上游挂起 6 秒，苹果那边 200ms 就返回了
 * 也要干等。审计同时提醒：**不能简单换成 Promise.race** ——
 * 先返回的那个经常是"空结果"（某个源没收录），race 会直接选到空。
 *
 * 现在的策略是"首个**满足条件**的结果优先 + 优先源等待窗口"：
 *   · 各音源并行发起，谁先返回一个**相似度过线**的结果就先采用（抢先返回
 *     空结果的源不会被选中，因为空结果永远不满足条件）；
 *   · 优先源（Meting）额外获得 PREFERRED_GRACE_MS 的等待窗口：
 *     苹果 200ms 就回来了也要先等一等，毕竟完整歌曲比 30 秒片段好；
 *     优先源没来就先用苹果，用户体验不被慢源拖住；
 *   · 所有源都返回但没有一个"过线"的，退而求其次用最像的那个（有胜于无）。
 */
async function searchOnce(env, keywords) {
  // 1) 短期缓存：降级阶段会用同一个关键词再搜一次，必须复用
  const cacheKey = searchKeyFor(env, keywords);
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  // 2) 正在进行的同关键词搜索：合并成一次上游调用
  const inflight = inflightSearch.get(cacheKey);
  if (inflight) return inflight;

  const run = (async () => {
    const sources = buildSources(env, keywords);
    if (!sources.length) return [];

    const now = Date.now();
    const settled = [];
    let done = 0;

    // 熔断中的源这一轮直接不发（既不加长尾延迟，也不再消耗上游）
    const live = sources.filter((source) => {
      if (sourceCircuitOpen(source.name, now)) {
        settled.push({ source, songs: [] });
        done += 1;
        return false;
      }
      return true;
    });

    // 3) 每个源跑完就立刻结算 —— 不等其它源
    await new Promise((resolve) => {
      if (!live.length) { resolve(); return; }

      let bestGood = null;          // 第一个"过线"的结果
      let graceTimer = null;
      let finished = false;

      const finish = () => {
        if (finished) return;
        finished = true;
        if (graceTimer) clearTimeout(graceTimer);
        resolve();
      };

      const accept = (source, songs) => {
        settled.push({ source, songs });
        done += 1;

        if (songs.length) {
          sourceMarkHealthy(source.name);
          const inGrace = Date.now() - now < PREFERRED_GRACE_MS;
          // 优先源在等待窗口内返回：直接用（order 0 本来就是首选）
          if (source.order === 0 || !inGrace) {
            if (!bestGood || source.order < bestGood.source.order) bestGood = { source, songs };
          }
          const good = bestScore(songs, keywords) >= MIN_TITLE_SCORE;
          if (!bestGood && good && source.order === 0) bestGood = { source, songs };
          // 过线 且 不是"还该等优先源"的情况 -> 立刻返回
          if (good && (!inGrace || source.order === 0)) { finish(); return; }
        } else {
          sourceMarkFailure(source.name);
        }

        if (done >= live.length) finish();
      };

      for (const source of live) {
        Promise.resolve()
          .then(() => source.resolve())
          .then((songs) => accept(source, Array.isArray(songs) ? songs : []))
          .catch(() => {
            sourceMarkFailure(source.name);
            accept(source, []);
          });
      }

      // 优先源等待窗口：到点了就用已经拿到的结果，不再干等
      graceTimer = setTimeout(() => { if (bestGood) finish(); }, PREFERRED_GRACE_MS);
    });

    // 4) 选结果：过线的优先源 > 过线的其它源 > 最像的那个
    const ordered = settled.slice().sort((a, b) => a.source.order - b.source.order);

    let chosen = null;
    for (const entry of ordered) {
      if (!entry.songs.length) continue;
      if (bestScore(entry.songs, keywords) >= MIN_TITLE_SCORE) { chosen = entry.songs; break; }
    }
    if (!chosen) {
      let best = null;
      for (const entry of ordered) {
        if (!entry.songs.length) continue;
        const score = bestScore(entry.songs, keywords);
        if (!best || score > best.score) best = { score, songs: entry.songs };
      }
      chosen = best ? best.songs : [];
    }

    const ranked = rankByRelevance(chosen, keywords).map((x) => x.song);
    cacheSet(cacheKey, ranked);
    return ranked;
  })();

  inflightSearch.set(cacheKey, run);
  try {
    return await run;
  } finally {
    inflightSearch.delete(cacheKey);
  }
}

/** 三级降级：歌名+歌手 → 歌名 → 模糊（不做歌名过滤）。 */
async function searchWithFallback(env, title, artist) {
  const attempts = [];
  if (artist) attempts.push({ keywords: `${title} ${artist}`, filter: true, tier: '歌名+歌手' });
  attempts.push({ keywords: title, filter: true, tier: '歌名' });
  attempts.push({ keywords: title, filter: false, tier: '模糊搜索' });

  for (const attempt of attempts) {
    // searchOnce 内部有短期缓存，所以第二、三级用同一个关键词时不会重打上游
    const songs = await searchOnce(env, attempt.keywords);
    if (!songs.length) continue;
    const filtered = attempt.filter ? songs.filter((s) => matchesTitle(s.name, title)) : songs;
    if (filtered.length) return { tier: attempt.tier, songs: filtered };
  }
  return { tier: null, songs: [] };
}

/* ======================= 选曲凭据（A7） ======================= */

/**
 * 给搜索结果里的每个候选附一张服务端签名的短期选曲凭据。
 *
 * 为什么必须由服务端签：
 *   候选的歌名/歌手/音源 id 是这次搜索的**事实**。前端把用户选中的那首
 *   提交回来时，服务端只靠字段格式无法判断"这三个值是不是同一首歌"。
 *   签一张凭据，就把"这三者同源"变成可验证的事实（见 _lib/tracktoken.js）。
 *
 * 为什么签名失败不应该让搜索失败：
 *   凭据只是防篡改的加强层，不是搜索功能本身。极端情况下（密钥不可用等）
 *   签不出来，就返回 token: null，前端会退回老流程 ——
 *   总比"整个试听/搜索都用不了"要好。
 */
async function attachTrackTokens(env, songs) {
  return Promise.all(songs.map(async (song) => {
    let token = null;
    try {
      token = await signTrackToken(env, {
        title: song.name,
        artist: song.artist,
        trackId: song.id,
      });
    } catch {
      token = null;
    }
    // 同一个值给两个键：`token` 是正名，`track_token` 与请求体里的
    // 字段名对齐（也和 track_id / recaptcha_token 的命名风格一致）。
    // 凭据是这一轮新加的字段，前后端谁先改都可能对不上名字，
    // 两个键都带只是省一次"命名没对齐"的返工；等约定统一后删掉一个即可。
    return { ...song, token, track_token: token };
  }));
}

/* ======================= 音频转发 ======================= */

async function resolveAudioUrl(env, prefixedId) {
  const separator = prefixedId.indexOf('-');
  if (separator < 0) return null;
  const prefix = prefixedId.slice(0, separator);
  const realId = prefixedId.slice(separator + 1);
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(realId)) return null;

  if (prefix === 'ap') return appleResolve(realId);

  if (prefix === 'mt') {
    for (const base of metingBases(env)) {
      const url = await metingResolve(base, realId);
      if (url) return url;
    }
    return null;
  }

  return null;
}

async function proxyAudio(env, prefixedId, request) {
  const directUrl = await resolveAudioUrl(env, prefixedId);
  if (!directUrl) return error('这首暂时没有可试听的片段，换一首试试', 404);

  const headers = {};
  const range = request.headers.get('Range');
  if (range) headers.Range = range;

  let upstream;
  try {
    upstream = await fetchUpstream(directUrl, { headers, redirect: 'follow' }, AUDIO_TIMEOUT_MS);
  } catch {
    return error('音源获取超时，请稍后再试', 504);
  }
  if (!upstream.ok && upstream.status !== 206) return error('音源获取失败', 502);
  if (!upstream.body) return error('音源返回了空内容', 502);

  // 绝不把上游的 Content-Type 原样透传：
  // 否则上游若返回 text/html，就等于在我们自己的域名下渲染了别人控制的页面。
  const upstreamType = (upstream.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (upstreamType && !/^(audio\/|application\/octet-stream|application\/vnd\.apple\.mpegurl)/.test(upstreamType)) {
    return error('上游返回的不是音频内容', 502);
  }
  const safeType = AUDIO_MIME_MAP[upstreamType]
    || (/^audio\//.test(upstreamType) ? upstreamType : 'audio/mpeg');

  const out = new Headers();
  out.set('Content-Type', safeType);
  out.set('X-Content-Type-Options', 'nosniff');
  out.set('Cache-Control', 'public, max-age=3600');
  out.set('Accept-Ranges', upstream.headers.get('Accept-Ranges') || 'bytes');

  for (const name of ['Content-Length', 'Content-Range', 'ETag', 'Last-Modified']) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }

  return new Response(upstream.body, { status: upstream.status, headers: out });
}

/* ======================= 入口 ======================= */

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  // 配置自检：只返回模式名，不泄露任何上游地址。
  if (url.searchParams.get('status') === '1') {
    return json({ configured: true, provider: providerMode(env) });
  }

  // 学生或管理员都可以试听（后台审核时也需要听一下）。
  // 传 null 表示两种会话都接受。
  const auth = await requireSession(env, request, null);
  if (!auth.ok) return auth.response;

  const ip = clientIp(request);
  const limit = await rateLimit(env, `music:${ip}`, 120, 3600);
  if (!limit.allowed) return error('试听请求过于频繁，请稍后再试', 429);

  const playId = (url.searchParams.get('play') || '').trim();
  if (playId) {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(playId)) return error('歌曲 id 不正确', 400);
    return proxyAudio(env, playId, request);
  }

  const title = sanitizeText(url.searchParams.get('q') || '', { maxLength: 60, field: '搜索关键词' });
  if (!title.ok) return error(title.error, 400);

  let artist = null;
  const rawArtist = url.searchParams.get('artist');
  if (rawArtist) {
    const parsedArtist = sanitizeText(rawArtist, { maxLength: 60, field: '歌手' });
    if (parsedArtist.ok) artist = parsedArtist.value;
  }

  try {
    const { tier, songs } = await searchWithFallback(env, title.value, artist);
    // 每个候选都带上签名的选曲凭据：前端选中哪首就把哪张凭据带回去，
    // vote.js 校验通过后**以凭据内容为准**，杜绝"歌名是一首、音源是另一首"。
    const results = await attachTrackTokens(env, songs);
    return json({ provider: providerMode(env), tier, results });
  } catch {
    return error('音源服务暂时不可用，请稍后再试', 502);
  }
}
