import { error, json } from '../../_lib/http.js';
import { requireSession, guardRate, rateLimitOnce, countBudget } from '../../_lib/auth.js';
import { sanitizeText } from '../../_lib/validate.js';
import { signTrackToken } from '../../_lib/tracktoken.js';
import { neteaseOuterUrl, probeNeteasePlayable, keepPlayableNetease, trackPlayable as probeTrackPlayable } from '../../_lib/playable.js';

/**
 * 音源中转代理（试听 / 搜索 / 可播性校验）。
 *
 * ⚠️ 安全约束：**客户端永远无法指定上游地址。**
 *    客户端只能传"关键词"、"歌曲 id"或"要校验的 id"，上游地址由服务端决定。
 *    否则这个接口会立刻变成任何人都能用的开放代理 / SSRF 跳板。
 *
 * 本文件只描述**当前行为**，以 `buildSources()`（见下方）为唯一依据。
 * 历史上这里写过一版"哪家可用/哪家已废"的清单，它与代码不符、误导过接手的人，
 * 所以已经删掉；要判断某家源此刻行不行，看 `/api/music?probe=1` 的 `verdict`。
 *
 * 当前音源与顺序（`auto` 模式，由 buildSources 决定）：
 *   1. `mg-` 咪咕 —— **第一位**。官方 CDN 直链，一次 fetch + 一次字节还原；
 *      实测**原唱命中且给完整整曲**（4.12MB / 270s）。用户 2026-10-07 的验收标准
 *      "原唱都能听到完整曲子"只有它同时满足。
 *   2. `meting:<host>` —— 测试还活着的中转（默认只剩 qijieya）。搜索排得不准，
 *      但**播放**能给完整 320kbps，连网易云官方拿不到的版权曲都能拿到 —— 当播放兜底。
 *   3. `ap-` 苹果官方 iTunes —— 原唱准，但**只有 30 秒**，所以它是"原唱目录的补充"，
 *      不是主源。按 hk / tw / us 依次问。
 *   4. `mt-` 网易云官方直连 —— 接口最稳（从不变），但公开搜索接口隐藏主流版权曲。
 *   默认基址见 DEFAULT_METING_BASES，其可用性随时间变化，不要假设它活着。
 *   `MUSIC_PROVIDER=apple` 只留苹果、`=meting` 会关掉苹果与咪咕。
 *   ⚠️ 排序只决定**并列时的先后**：结果始终是**合并所有源**，
 *   而且先去重、再按"标题干净度 → 相似度 → 歌手吻合 → 源优先级"排 ——
 *   所以"某个源排第一"不等于"它的翻唱会顶掉别家的原唱"。
 *
 * 歌曲 id 带音源前缀（`mg-<contentId>` / `mt-<数字>` / `ap-<数字>`），
 * 这样播放时不必猜测该用哪家，也避免两家的数字 id 互相撞车。
 *
 * ⚠️ 前缀语义不能混（踩过一次就会全错）：`mt-` 在 `_lib/playable.js` 里
 * **专门表示"网易云歌曲 id"**（`neteaseIdOf` 只认 mt-，并拿它去拼 outer/url）。
 * 把咪咕的 contentId 也写成 `mt-`，那串 id 会被当成网易云 id 去探测，
 * 结果**全部候选被判成"拿不到音频"**。所以咪咕必须有独立前缀 `mg-`。
 *
 * A7（音源一致性）：搜索结果里每个候选都会额外带一张**服务端签名的
 * 短期选曲凭据**（`token`）。点歌时把它一起提交，服务端就能确认
 * "歌名 + 歌手 + 音源 id"确实来自同一次搜索、属于同一首歌。
 * 详见 _lib/tracktoken.js 与 functions/api/vote.js。
 *
 * 环境变量（全部可选，不配也能用）：
 *   MUSIC_PROVIDER    'auto'（默认）| 'meting' | 'apple'
 *   MUSIC_API_BASE    覆盖 Meting 上游根地址（**替换**内置默认值，不是追加）
 *   MUSIC_STOREFRONT  苹果商店地区，默认 hk（cn 商店不通过接口提供歌曲）
 */

const SEARCH_TIMEOUT_MS = 6000;
const AUDIO_TIMEOUT_MS = 15000;
/**
 * 候选池上限（用户要求"把所有可能的结果都列出来"，所以比原来的 8 放宽很多）。
 *
 * 怎么定的：两个源各取 SOURCE_FETCH_LIMIT 条，合并去重后最多留 MAX_RESULTS 条。
 *   40 条 ≈ 手机上翻 6~7 屏，足够学生挑到想要的版本；
 *   再多也没意义 —— 教师审核与学生点歌都不需要看第 41 条之后的翻唱。
 * 上限同时也是**上游客量保护**：候选越多，"可播性过滤"要发的探测请求越多。
 */
const SOURCE_FETCH_LIMIT = 20;
const MAX_RESULTS = 40;
const MAX_FIELD_LENGTH = 120;

/**
 * 这一份 music.js 的构建标识。
 *
 * 为什么要有它：排查"改了没生效"时，最费时间的一步是**确认线上跑的是哪份代码**。
 * 有了这个常量，打开 `/api/music?probe=1` 就能看到它 ——
 * 数字不对就说明部署的不是这一包，不必再猜别的可能。
 * 每次改动本文件时把它 +1（或改日期），交付时与版本号保持一致。
 */
const MUSIC_BUILD = '2026-10-07-d+migu-first';

/* ------------------------------------------------------------------
 * 上游调用的资源护栏（审计 C3）
 *
 * 为什么必须有：下游只要拿到一个 50MB 的响应体，或者一个"连上了但
 * 一直不吐字节"的连接，这个 Worker 就会一直占着 CPU 与内存 ——
 * 免费套餐下这是最容易被上游拖垮的地方。所以：
 *   · 搜索类响应体上限 512KB（正常几百字节到几十 KB），解析前先卡住
 *   · 音频转发上限 12MB（`AUDIO_BODY_LIMIT`，只作用于 `?play=` 的转发），
 *     超了就断开而不是整首吞进内存
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
/** 单个音源连续失败几次进入熔断。 */
const SOURCE_FAILURE_THRESHOLD = 3;
/** 熔断冷却时长：给故障源一点恢复时间，又不至于让它长时间不可用。 */
const SOURCE_COOLDOWN_MS = 90 * 1000;

const DEFAULT_METING_BASES = [
  /**
   * 2026-10-07 复测结论（本机直连，`_harness\probe-sources-live.mjs`）：
   *   ❌ music.gdstudio.org          `?types=search` 回 401 Invalid request（拿不到候选）
   *   ❌ music-api.gdstudio.xyz      **已被劫持**：任何路径都 200 跳 m.baidu.com（停靠页）
   *   ✅ api.qijieya.cn/meting/      server=netease 搜索可用，type=url 给完整 320kbps
   *   其它（injahow / ygking / lsky / moeyao / liumingye）全部不可用。
   *
   * 所以默认清单里**只留 qijieya**（实测唯一还活着的中转），GD Studio 两台一并移除：
   * 留着它们不是"多一层兜底"，而是每次搜索都白发两个请求、再等一次超时。
   * 谁的两台基址恢复了，用 `MUSIC_API_BASE` 就能把它们换回来（那是**替换**语义）。
   *
   * 为什么它排在中转位而不是第一位：qijieya 的 netease 通道**搜索质量差**
   *（实测搜「七里香 周杰伦」第一条是翻唱《刀马旦》，搜「晴天」第一条是《刀马旦》）——
   * 它只是把网易云的接口转出来，网易云公开接口隐藏主流版权曲这个毛病它一样有。
   * 它的价值在**播放**：网易云官方 `outer/url` 对版权受限曲拿不到音频，
   * 而它自带 cookie，同一首能给完整 320kbps。所以顺序是"咪咕（原唱准）→
   * 网易云官方（搜索稳）→ qijieya（拿音频）"，三者**合并**，不是谁顶掉谁。
   */
  'https://api.qijieya.cn/meting/',
];

/**
 * GD Studio 与 Meting 的参数形状完全不同：
 *   Meting     ?server=netease&type=search&id=<关键词> / ?type=url&id=<id>
 *   GD Studio  ?types=search&source=netease&name=<关键词> / ?types=url&source=netease&id=<id>
 * 所以按 base 分派，而不是把两套参数硬塞进一个函数。
 */
function isGdStudio(base) {
  return /gdstudio/i.test(base);
}
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
  decode,
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

    // parse:'bytes' 走二进制读取，**解码交给调用方**（自定义 decode）。
    // 为什么需要它：咪咕那个播放接口回的是**加扰二进制**，
    // 预先按 UTF-8 解一遍就是有损的（非法字节会被换成 U+FFFD，再也还原不回来），
    // 于是解密必然失败、表现成"咪咕能搜到却一首都播不了"。
    if (parse === 'bytes') {
      const bytes = await readBytesLimited(res, limit);
      if (bytes === null) return null;
      return { res, body: decode ? decode(bytes) : bytes, cleanup };
    }

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

/**
 * 逐块读取响应体为**原始字节**，超过上限返回 null。
 *
 * 与 readBodyLimited 的区别只有一个，但很关键：**不做任何解码**。
 * 给咪咕那个回加扰二进制的接口用 —— 先按 UTF-8 解一遍会把非法字节换成 U+FFFD，
 * 那种损坏是不可逆的，之后无论怎么解密都拿不到 URL。
 */
async function readBytesLimited(res, limit) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    try {
      const buf = await res.arrayBuffer();
      const all = new Uint8Array(buf);
      return all.byteLength > limit ? null : all;
    } catch {
      return null;
    }
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
  return merged;
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
    if (out.length >= SOURCE_FETCH_LIMIT) break;
  }
  return out;
}

/**
 * GD Studio 的搜索。
 *
 * 返回形状与 Meting 不同（artist 是数组、id 在 url_id），
 * 所以归一化成内部统一形状，下游（凭据签发、试听、入库）完全不用改。
 *
 * 注意：GD Studio 与 Meting 一样是**网易云**，搜出来的原唱准确度不如苹果 ——
 * 那条"七里香 → 无名翻唱"的问题它同样存在。所以它只做**兜底**：
 * 苹果目录里没有的歌（部分华语冷门曲）才落到这里。
 */
/* ---- GD Studio 家族的**形状适配层** ----
 *
 * 为什么单拎一层出来（2026-10-07，用户要求接入 music.gdstudio.org 时新增）：
 *   同一个"GD Studio"现在有两个基址在跑 —— 老的 `music-api.gdstudio.xyz`
 *   （裸数组）与新的 `music.gdstudio.org`。实测新基址的后端是 FastAPI
 *   （错误体形如 `{"detail":"Invalid request."}`），这类实现常把结果包一层
 *   `data` / `result`，歌曲字段也可能沿用上游（网易云）的 `artists[].name`
 *   而不是 GD 自己的 `artist: string[]`。
 *
 *   适配层的作用就一句：**不管外面套了几层信封，把候选规规矩矩地交出来。**
 *   认不出来一律当空结果 —— 与旧代码 `Array.isArray(body) ? body : []` 完全一致，
 *   所以老基址的行为一个字节都没变，新基址的多种形状也能直接吃下。
 *
 * 注意：这里只做"形状归一"，**不做任何地址改写** —— 客户端依旧无法指定上游。
 */

/** 把几种常见的响应信封拆成数组。 */
function unwrapGdList(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['data', 'result', 'songs', 'list']) {
    const value = payload[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') {
      // 再深一层：{ data: { songs: [...] } } / { result: { songs: [...] } }
      for (const inner of ['songs', 'list', 'data']) {
        if (Array.isArray(value[inner])) return value[inner];
      }
    }
  }
  return [];
}

/** 歌手：GD 形状是 `artist: string[]`，网易云原生形状是 `artists: [{name}]`。 */
function gdArtistOf(item) {
  if (Array.isArray(item.artist)) {
    return item.artist
      .map((a) => (a && typeof a === 'object' ? a.name : a))
      .filter(Boolean)
      .join(' / ');
  }
  if (typeof item.artist === 'string' && item.artist) return item.artist;
  if (Array.isArray(item.artists)) {
    return item.artists.map((a) => (a && a.name) || a).filter(Boolean).join(' / ');
  }
  return '';
}

/** 专辑：GD 形状是字符串，网易云原生形状是 `{ name }`。 */
function gdAlbumOf(item) {
  if (item.album && typeof item.album === 'object') return item.album.name || '';
  return typeof item.album === 'string' ? item.album : '';
}

/**
 * 时长（秒）。
 *
 * 两个基址的单位不一样：老基址不给时长，新基址若沿用网易云形状则给**毫秒**。
 * 用 10000 当分界：正常歌曲的毫秒值必然远大于它（最短的整曲也有 30 秒 = 30000），
 * 而秒值必然远小于它（一小时的曲子也才 3600）。这样两边都判得准。
 */
function gdDurationOf(item) {
  const raw = Number(item && item.duration);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.round(raw > 10000 ? raw / 1000 : raw);
}

/** 把几种常见的响应信封拆成一个 URL 字符串。 */
function unwrapGdUrl(payload) {
  if (typeof payload === 'string') return payload.trim();
  if (!payload || typeof payload !== 'object') return null;
  for (const key of ['url', 'data', 'src', 'link']) {
    const value = payload[key];
    if (typeof value === 'string' && value) return value.trim();
    if (value && typeof value === 'object') {
      for (const inner of ['url', 'src', 'link']) {
        if (typeof value[inner] === 'string' && value[inner]) return value[inner].trim();
      }
    }
  }
  return null;
}

async function gdstudioSearch(base, keywords) {
  const url = `${base}?types=search&source=netease&name=${encodeURIComponent(keywords)}`
    + `&count=${SOURCE_FETCH_LIMIT}&pages=1`;
  const got = await fetchBounded(url, {}, { parse: 'json' });
  if (!got) return [];
  got.cleanup();

  const list = unwrapGdList(got.body);
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object' || !item.name) continue;
    const rawId = String(item.url_id || item.id || '');
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(rawId)) continue;
    out.push({
      id: `mt-${rawId}`,
      name: clip(item.name),
      artist: clip(gdArtistOf(item)),
      album: clip(gdAlbumOf(item)),
      duration: gdDurationOf(item),
      source: '网易云',
    });
    if (out.length >= SOURCE_FETCH_LIMIT) break;
  }
  return out;
}

/**
 * GD Studio 的播放地址。返回真实音频直链（老基址实测 320kbps 完整歌曲）。
 *
 * 这里用 `parse: 'text'` 而不是 `'json'`：新版基址有直接回**一行 URL 文本**的可能，
 * 用 json 解析会整条丢掉。读到文本后先试 JSON，失败就把原文当 URL —— 两种都认。
 */
async function gdstudioResolve(base, songId) {
  const url = `${base}?types=url&source=netease&id=${encodeURIComponent(songId)}&br=320`;
  const got = await fetchBounded(url, {}, { parse: 'text' });
  if (!got) return null;
  got.cleanup();

  let payload = got.body;
  const text = String(payload || '').trim();
  if (text.startsWith('{') || text.startsWith('[')) {
    try { payload = JSON.parse(text); } catch { /* 不是合法 JSON：下面按纯文本 URL 处理 */ }
  }

  const direct = unwrapGdUrl(payload);
  return typeof direct === 'string' && /^https?:\/\//i.test(direct) ? direct : null;
}

/* ======================= 咪咕（原唱 + 完整整曲，第一顺位） =======================

   为什么接它（用户 2026-10-07 的验收标准是"**原唱都能听到完整曲子**"）：
     实测各源对同一个查询的表现（`_harness\probe-source-quality.mjs`，六首歌）：

     | 源 | 原唱命中 | 能拿到完整音频 |
     |---|---|---|
     | 咪咕 | ✅ 目录里就是原唱（晴天/七里香/雨爱/起风了/孤勇者/海阔天空 全中） | ✅ 完整整曲（实测 4.12MB / 270s，128kbps） |
     | qijieya 中转 | ⚠️ 搜索排不准（第一条常是翻唱），但拿到的音频完整 | ✅ 完整 320kbps |
     | 网易云官方 | ❌ 公开接口**隐藏主流版权曲**（搜七里香全是翻唱） | ⚠️ 版权受限曲拿不到 |
     | 苹果 iTunes | ✅ 原唱准 | ❌ **只有 30 秒** —— 不满足"完整曲子" |

     所以"原唱 + 完整"同时成立的只有咪咕。它是**官方 CDN 直链**，
     一次 fetch + 一次 O(n) 字节还原，没有第三方中转、没有 key、没有 cookie，
     正好落在免费套餐 10ms CPU 预算里。

   实现出处：VoiceHub `server/api/native-api/migu/playurl.get.ts`（GPL-3.0）的算法，
   按本项目的**流式转发**模型重写（VoiceHub 是把整个 ArrayBuffer 读进来再解密，
   这里只需要解密那一小段 JSON 信封，音频本身照旧流式转发、不进内存）。

   ⚠️ 三个必须知道的边界：
     1. **返回的不是 JSON，是私有加扰二进制**，魔数 0xAB 0xCD 0x01，第 4 字节是异或步长。
        认不出魔数就一律当失败（宁可少一个候选，也不要把乱码解析成 URL）。
     2. `auditionsLength: 60` 这个字段**实测不影响拿到的音频**：返回的直链是完整整曲
        （已用 `Range: bytes=0-0` 读 `Content-Range` 反算验证：4317311 字节 / 270 秒 = 128kbps）。
        但它是上游的"试听"标记，**将来可能变成真的 60 秒**，所以：
        换源或发现用户反馈"只有一小段"时第一件事就是重新量一次总字节数。
     3. `toneFlag` 只影响上游挑哪一档音质；匿名请求实测一律给 PQ（128kbps）。
        要升档得先改 URL 路径再 HEAD 探测（VoiceHub 的 `QUALITY_FALLBACK_CHAIN`），
        本项目不做 —— 多一次上游往返去赌一个可能 404 的高码率地址，不划算。

   关于歌词/封面的字段（`lrcUrl` / `imgItems`）：本项目的候选面板不展示它们，不收。 */

/** 一次搜索最多问咪咕要多少条（与 SOURCE_FETCH_LIMIT 对齐，一次请求拿满）。 */
const MIGU_PAGE_SIZE = 20;

function miguSearchUrl(keywords, pageSize) {
  return 'https://app.c.nf.migu.cn/MIGUM2.0/v1.0/content/search_all.do'
    + `?text=${encodeURIComponent(keywords)}&pageNo=1&pageSize=${pageSize}`
    + '&searchSwitch=%7B%22song%22%3A1%7D';
}

/** 咪咕的歌曲 id 就是 contentId（长数字串），加 `mg-` 前缀避免与网易云数字 id 撞车。 */
function miguContentIdOf(trackId) {
  const m = /^mg-(\d{1,24})$/.exec(String(trackId || ''));
  return m ? m[1] : '';
}

async function miguSearch(keywords) {
  const url = miguSearchUrl(keywords, MIGU_PAGE_SIZE);
  const got = await fetchBounded(url, {
    // channel 是上游要求的渠道号（VoiceHub 用 014X031），缺了会回错误体
    headers: { channel: '014X031', Referer: 'https://music.migu.cn/' },
  }, { parse: 'json' });
  if (!got) return [];
  got.cleanup();

  const items = (got.body && got.body.songResultData && got.body.songResultData.result) || [];
  const out = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const contentId = String(item.contentId || '');
    const name = String(item.name || item.songName || '').trim();
    if (!name || !/^\d{1,24}$/.test(contentId)) continue;
    // 歌手：优先 singers 数组（实测字段），退回单数字符串形态
    const singers = Array.isArray(item.singers) ? item.singers : [];
    const artist = singers.length
      ? singers.map((s) => (s && typeof s === 'object' ? s.name : s)).filter(Boolean).join(' / ')
      : String(item.singer || item.singerName || '');
    const albums = Array.isArray(item.albums) ? item.albums : [];
    const album = albums.length ? String((albums[0] && albums[0].name) || '') : '';
    out.push({
      id: `mg-${contentId}`,
      name: clip(name),
      artist: clip(artist),
      album: clip(album),
      duration: miguDurationOf(item.duration),
      source: '咪咕音乐',
    });
    if (out.length >= SOURCE_FETCH_LIMIT) break;
  }
  return out;
}

/**
 * 时长（秒）。咪咕给的是**毫秒**（实测晴天 270000）。
 * 与 gdDurationOf 用同一个分界：正常歌曲的毫秒值必然远大于 10000，
 * 秒值必然远小于它。判错的代价只是候选行上少一个时长，不影响可播性。
 */
function miguDurationOf(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value > 10000 ? value / 1000 : value);
}

/** 上游协议里硬编码的加扰密钥（不是我们的秘密，VoiceHub 里同样是明文）。 */
const MIGU_SCRAMBLE_KEY = 'Jk8qzuePiJ1qE3mDYhLQ3T73DtDoAhLP';

/**
 * 咪咕返回的私有加扰还原（VoiceHub `decode()` 的等价实现，逐字节相同）。
 *
 * 算法：跳过 4 字节头，剩余每个字节 `(密文 + step - 密钥[i % 密钥长]) & 0xff`。
 * 纯 O(n) 字节运算，信封只有 1~4KB，落在免费套餐 10ms CPU 预算里。
 * 密钥是上游协议常量，**不是我们的秘密**（VoiceHub 里也是硬编码的明文）。
 *
 * ⚠️ 踩过的坑（写这条测试时抓到的，第一版就是这么错的）：
 *   循环上界写成 `i < key.length * 2`（64）而不是 `i < out.length`，
 *   于是**只还原了前 64 个字节**、后面全是 0，JSON.parse 报
 *   "Bad control character in string literal"。
 *   真实信封有 1~4KB，所以那样写等于**咪咕一首都解不出来** ——
 *   而"解密失败"在调用方看起来和"这首歌没音频"一模一样，极难排查。
 *   上界只能是输出长度。
 */
function miguDecode(bytes, key) {
  if (!key || bytes.length < 4) return null;
  if (bytes[0] !== 0xab || bytes[1] !== 0xcd || bytes[2] !== 0x01) return null;
  const step = bytes[3];
  const out = new Uint8Array(bytes.length - 4);
  const keyLength = key.length;
  for (let i = 0; i < out.length; i++) {
    out[i] = (bytes[4 + i] + step - key.charCodeAt(i % keyLength)) & 0xff;
  }
  return out;
}

/** 加扰还原后的字节 -> 字符串。信封是 JSON，用 TextDecoder 一次解出来最省。 */
function miguTextOf(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return '';
  }
}

/**
 * 咪咕播放地址。
 * @returns {Promise<string|null>} 真实音频直链（已剥掉查询串、已升级 https）
 */
async function miguResolve(contentId) {
  if (!/^\d{1,24}$/.test(String(contentId || ''))) return null;
  const url = 'https://c.musicapp.migu.cn/strategy/listen-url/h5/v2.4'
    + `?contentId=${encodeURIComponent(contentId)}`
    + `&copyrightId=&resourceType=2&netType=01&toneFlag=PQ&scene=`
    + `&lowerQualityContentId=${encodeURIComponent(contentId)}`;

  // parse:'bytes' —— 响应体是加扰二进制，交给 JSON.parse 只会整条丢掉，
  // 而先按 UTF-8 解一遍又会把字节损坏掉（见 readBytesLimited 的说明）。
  const got = await fetchBounded(url, {
    headers: {
      birth: 'h5page',
      channel: '014X031',
      Referer: 'https://y.migu.cn/',
      'location-data': '30.6698676660,104.1229614820',
      'location-info': '',
    },
  }, {
    parse: 'bytes',
    timeoutMs: 8000,
    limit: 64 * 1024,
    decode: (bytes) => miguDecode(bytes, MIGU_SCRAMBLE_KEY),
  });
  if (!got) return null;
  const { body: plain, cleanup } = got;
  cleanup();

  if (!plain) return null;
  let payload = null;
  try { payload = JSON.parse(miguTextOf(plain)); } catch { return null; }
  const data = payload && payload.data;
  const direct = data && typeof data.url === 'string' ? data.url : '';
  if (!/^https?:\/\//i.test(direct)) return null;

  // 剥查询串 + 升级 https：上游给的常是 http + 带鉴权查询串，
  // 查询串对音频本体没影响（VoiceHub 同样先剥再替换），而 http 在页面上会被
  // upgrade-insecure-requests 拦成混合内容。
  return direct.split('?')[0].replace(/^http:/i, 'https:');
}

async function metingSearch(base, keywords) {
  if (isGdStudio(base)) return gdstudioSearch(base, keywords);
  const url = `${base}?server=netease&type=search&id=${encodeURIComponent(keywords)}`;
  const got = await fetchBounded(url, {}, { parse: 'json' });
  if (!got) return [];
  // 无论解析结果怎么样都要收尾计时器（否则 abort 计时器会一直挂着）
  got.cleanup();
  return normalizeMeting(got.body);
}

/* ======================= 网易云「官方接口」直连源 =======================

   为什么要有它（2026-10 实测）：
     公共中转站基本全军覆没 —— music-api.gdstudio.xyz 连接超时、
     api.qijieya.cn / api.injahow.cn 返回空、api.ygking.top 域名失效。
     但**各平台自己的公开接口还能用**，不需要任何 key、也不需要自建服务。
     VoiceHub 走的正是这条路（server/api/native-api/*），这里按同样思路直连，
     不依赖任何第三方中转。

   实测结论（2026-10-05，本机直连）：
     · 网易云搜索 api/search/get/web   ✅ 200，返回 JSON
     · 网易云播放 song/media/outer/url ✅ 302 跳到 m*.music.126.net，**完整歌曲 MP3**
     · QQ 音乐 搜索 client_search_cp   ✅ 200，原唱排序很准（七里香 → 周杰伦）
     · QQ 音乐 播放 vkey               ❌ result:104003、purl 为空 → 版权限制，不能播
     · 咪咕搜索                        ❌ 返回 HTML 页面（接口已废弃）
     · 苹果 iTunes                     ✅ 200，原唱准，但只有 30 秒试听片段

   ⚠️ 已知边界（写下来免得以后误判）：网易云**公开搜索接口隐藏了主流版权曲**
   （搜「七里香 周杰伦」返回的全是翻唱，没有周杰倫原唱）。所以两个源各有分工：
     · 原唱准确性靠**苹果源**（它的目录里有周杰倫）；
     · 完整时长靠**网易云源**（outer/url 给的是整首歌）。
   两个源并存、结果合并，比只留一个可靠得多。 */

/** 网易云搜索：官方公开接口，不需要 key。 */
async function neteaseSearch(keywords) {
  const url = 'https://music.163.com/api/search/get/web'
    + `?s=${encodeURIComponent(keywords)}&type=1&offset=0&total=true&limit=${SOURCE_FETCH_LIMIT}`;
  const got = await fetchBounded(url, {
    headers: { Referer: 'https://music.163.com/', Cookie: 'appver=2.0.2' },
  }, { parse: 'json' });
  if (!got) return [];
  got.cleanup();

  const list = (got.body && got.body.result && got.body.result.songs) || [];
  const out = [];
  for (const item of list) {
    if (!item || !item.id || !item.name) continue;
    const id = String(item.id);
    if (!/^\d{1,20}$/.test(id)) continue;
    const artists = Array.isArray(item.artists) ? item.artists : [];
    out.push({
      id: `mt-${id}`,
      name: clip(item.name),
      artist: clip(artists.map((a) => a && a.name).filter(Boolean).join(' / ')),
      album: clip((item.album && item.album.name) || ''),
      duration: Math.round((Number(item.duration) || 0) / 1000),
      source: '网易云',
    });
    if (out.length >= SOURCE_FETCH_LIMIT) break;
  }
  return out;
}

/* ---------------- 网易云候选的"可播性" ----------------

   探测与缓存已经抽到 `_lib/playable.js`（2026-10-07），因为现在有**两个**使用方，
   而且必须给出完全一致的结论：
     · 本文件 —— 搜索时给候选打 `playable` 标记、以及 `?check=<id>` 惰性校验；
     · `admin-list.js` —— 审核列表要告诉管理员"学生锁定的这一版播不出来"。
   两边各写一套就会出现"学生端说能播、审核端说不能"这种最难查的分歧。
   判据、三种返回值（true / false / null）与缓存策略都写在那边的文件头上。 */

async function metingResolve(base, songId) {
  if (isGdStudio(base)) return gdstudioResolve(base, songId);
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
    if (out.length >= SOURCE_FETCH_LIMIT) break;
  }
  return out;
}

async function appleSearch(keywords, storefront) {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(keywords)}`
    + `&country=${encodeURIComponent(storefront)}&media=music&entity=song&limit=${SOURCE_FETCH_LIMIT}`;
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

/**
 * 从用户输入里拆出"歌名"部分（用于过滤与排序）。
 *
 * 为什么必须拆（这是"搜《雨爱》只出 DJ 版"的真正成因）：
 *   前端把**歌名框里的整段文字**当查询词发过来。学生写「雨爱 杨丞琳」时，
 *   查询词就是 `雨爱 杨丞琳`，而过滤用的是 `候选名.includes(查询词)`：
 *     · 《雨爱》(杨丞琳原唱) → "雨爱".includes("雨爱 杨丞琳") = false → **被刷掉**
 *     · 《雨爱 (DJ版)》      → 同样 false
 *     · 只有标题里**真的含有"雨爱 杨丞琳"这串字**的冷门翻唱才活下来
 *   于是表现就是"明明搜原唱，出来的全是翻唱/DJ"。
 *
 * 拆法：按空格、中点、斜杠等分隔符切，取第一段当歌名。
 *   · 歌名本身可能含空格（"Merry Christmas Mr. Lawrence"），
 *     所以只有在"确实有多段"且第一段不太短时才切；
 *   · 完整查询词仍然用于**搜索**（上游需要"歌名 + 歌手"才排得准）。
 */
function titlePartOf(raw) {
  const value = String(raw || '').trim();
  if (!value) return value;
  const parts = value.split(/[\s·・/|,，]+/).filter(Boolean);
  if (parts.length < 2) return value;
  if (parts[0].length < 2) return value;      // 第一段太短（如 "a love song"）就不拆
  return parts[0];
}

/**
 * 从用户输入里拆出"可能是歌手"的部分（与 titlePartOf 互为反面）。
 *
 * 为什么需要它（用户反馈："我在这里搜一首雨爱，居然第一个原唱没有"）：
 *   前端把**歌名框里的整段文字**当查询词发过来（`q=雨爱 杨丞琳`），而那个独立的
 *   歌手字段是只读的 —— 只有"选这首"才会填进去。所以学生手动打了歌手时，
 *   服务端**完全收不到歌手信号**，于是《雨爱》的原唱和一堆同名翻唱在排序里
 *   完全并列（干净度一样、相似度一样、歌手吻合度都是 0），最后只能靠
 *   "源优先级"分先后 —— 翻唱就这么顶到了原唱前面。
 *
 * 用途仅限**排序加分**，绝不用于过滤：猜错了最坏是没加分，
 * 不会因为"我猜的歌手和这首歌对不上"而把结果筛掉。
 */
function artistHintOf(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  const parts = value.split(/[\s·・/|,，]+/).filter(Boolean);
  if (parts.length < 2) return '';
  // 「七里香 周杰伦」-> 周杰伦；「Merry Christmas Mr. Lawrence」这类第一段就带空格的
  // 外文歌名也会走到这里，但那种情况下"歌手线索"只是个噪音串，对不上就不加分。
  return clip(parts.slice(1).join(' '));
}

/**
 * 把多个音源的结果**合并**成一个候选池（而不是只留第一个达标的源）。
 *
 * 为什么必须合并（这是"搜不到歌"的主要成因之一）：
 *   旧逻辑是"第一个相似度过线的源就定胜负"，苹果排在最前、又总是很快返回，
 *   于是后面的网易云源**永远不会出现在候选里** —— 学生因此看不到完整歌曲，
 *   只能听 30 秒片段。两个源的价值本来就不同：
 *     · 苹果：原唱准（目录里有周杰倫），但只有 30 秒；
 *     · 网易云：完整歌曲，但公开搜索接口隐藏了主流版权曲（原唱排名差）。
 *   合并之后学生两边都能选，这才是"搜得到 + 听得到"。
 *
 * 排序规则（顺序很讲究，改动前先读下面这段）：
 *   1. **标题干净度**（titleCleanliness）—— 这是"搜雨爱全是 DJ 版"的根治点：
 *      原唱标题就是《雨爱》，而《雨爱 (DJ版)》《雨爱 (男版)》《雨爱 (Live)》
 *      的**歌名相似度完全相同**（都是"包含查询词"），只按相似度排的话
 *      谁先返回谁在前，DJ 版就会顶上来。所以这里先按"标题里没有
 *      版本/翻唱标记"排序 —— 原唱必然最干净，排第一。
 *   2. 与查询词的相似度。
 *   3. **歌手吻合度**：查询里带了歌手（"雨爱 杨丞琳"）时，歌手匹配的候选更靠前；
 *      注意"查询里没写歌手"时**不加分也不减分**，否则会把没填歌手的歌手全压到后面。
 *   4. 源优先级（苹果 order 0 优先）。
 *
 * @param {Array<{source: object, songs: Array}>} settled 各源的结果
 * @param {string} keywords 查询词
 * @param {string} [artist] 学生填的歌手（可为空）
 */
function mergeCandidates(settled, keywords, artist) {
  const ordered = settled.slice()
    .filter((e) => e && Array.isArray(e.songs) && e.songs.length)
    .sort((a, b) => a.source.order - b.source.order);

  const seen = new Set();
  const pool = [];

  for (const entry of ordered) {
    for (const song of entry.songs) {
      // 去重键：**歌名 + 歌手**（归一化空白与大小写）。
      //
      // ⚠️ 为什么不能只用"标题"去重：繁体/简体是不同字符，同一首歌在
      // 不同苹果店面里会以《雨愛》与《雨爱》两个形态出现，只比标题会漏掉。
      // 加上歌手之后，《雨愛》/楊丞琳 与 《雨爱》/杨丞琳 仍然是两个 key
      // （字符不同）—— 这是**有意保留**的：它们确实是两个不同店面的条目，
      // 最终候选池限制在 MAX_RESULTS 条，重复项会被挤到后面，不影响使用。
      const key = `${String(song.name || '').toLowerCase().replace(/\s+/g, '')}`
        + `|${String(song.artist || '').toLowerCase().replace(/\s+/g, '')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pool.push({
        song,
        order: entry.source.order,
        score: matchScore(song.name, keywords),
        clean: titleCleanliness(song.name),
        artistFit: artistFitScore(song.artist, artist),
      });
    }
  }

  pool.sort((a, b) => {
    if (b.clean !== a.clean) return b.clean - a.clean;    // 1. 标题干净度（原唱优先）
    if (b.score !== a.score) return b.score - a.score;    // 2. 与查询词的相似度
    if (b.artistFit !== a.artistFit) return b.artistFit - a.artistFit;  // 3. 歌手吻合
    return a.order - b.order;                             // 4. 源优先级
  });

  return pool.slice(0, MAX_RESULTS).map((x) => x.song);
}

/**
 * 标题干净度：**原唱标题通常就是干净的歌名**，而翻唱/改编会带括号标记。
 *
 * 这是"搜《雨爱》只能出 DJ 版"的根治点 —— 实测网易云搜索「雨爱」时
 * 第 1 条就是杨丞琳原唱、第 3 条才是 DJ 版，但旧排序只看歌名相似度，
 * 而《雨爱》《雨爱 (DJ版)》《雨爱 (男版)》的相似度**完全一样**，
 * 于是谁先返回谁在前。改成先看"标题里有没有版本标记"之后，
 * 原唱必然排第一。
 *
 * 评分：
 *   100  标题里连多余的空格都没有（最干净）/ 查不到标记时也归到这一档
 *    80  只是多了空白
 *    40  带"版本类"标记（Live / 伴奏 / 纯音乐版本…）
 *     0  带"翻唱改编类"标记（DJ / 翻唱 / 女版 / 男版 / 钢琴版…）
 *   -40 带"内容不合格类"标记（鬼畜 / 恶搞…）
 */
const VERSION_MARK = /(live|现场|伴奏|instrumental|remix|混音|版\b|version|acoustic|不插电)/i;
const COVER_MARK = /(dj|翻唱|女版|男版|童声|钢琴|吉他|古筝|纯音乐|清唱|和声|口琴|小提琴|慢摇|串烧|改编|片段|副歌|剪辑|抖音|快手|1\.1x|加速|慢速|升调|降调|cover|karaoke)/i;
const BAD_MARK = /(鬼畜|恶搞|整活|土味|精神小伙)/i;

function titleCleanliness(name) {
  const raw = String(name || '');
  const compact = raw.replace(/\s+/g, '');
  // 只看"歌名本体"之外的部分，避免把歌名里本来就有的词（如《雨天》里的"天"）误判
  const tail = compact.replace(/[（(【\[].*?[)）】\]]/g, '');
  const extras = compact.slice(tail.length);

  if (BAD_MARK.test(compact)) return -40;
  if (COVER_MARK.test(extras) || COVER_MARK.test(tail.replace(/^[^（(【\[]*/, ''))) return 0;
  if (VERSION_MARK.test(extras)) return 40;
  if (raw !== compact) return 80;
  return 100;
}

/**
 * 歌手吻合度：查询里带了歌手时才算分；没带时一律 0（不加不减）。
 *
 * 为什么"没带歌手时不减分"很重要：学生点歌经常只输歌名，
 * 而网易云的候选里不少作者名是空的/杂名 —— 如果那种情况给低分，
 * 会把本来对的结果压到翻唱后面。
 *
 * ⚠️ 2026-10-07 改了两处（都是为了修"搜雨爱时原唱排在翻唱后面"）：
 *   1. **包含即满分**（原来给 1 分，只有完全相等才给 2）。学生写
 *      「雨爱 杨丞琳」而候选是「李之谦 / 杨丞琳」时，包含关系就是最强信号，
 *      给半分等于把原唱和翻唱又拉平了。
 *   2. **不再给不相干的候选扣分（原来的 -1）**，改用"查询里的字有多少出现在
 *      候选里"的覆盖率，≥0.6 给 1 分、否则 0 分。原因是扣分对"简繁差异"
 *      完全失效：「周杰伦」（学生输入）与「周杰倫」（苹果目录里的写法）
 *      一个字都对不上，扣分会让**原唱和翻唱一起沉底**，等于没排。
 *      覆盖率则能救回来：周杰伦 vs 周杰倫 命中 2/3 = 0.67 → 加分，
 *      而「Xai小爱」= 0 → 不加分，原唱就浮上来了。
 * 这个"按字数覆盖率"的写法是**刻意的近似**：它不做真正的简繁转换
 *（那需要一张完整对照表），只在排序上做让步 —— 排错了顶多是顺序不理想，
 * 而真做转换要维护的数据量和出错面都大得多。
 */
function artistFitScore(candidateArtist, queryArtist) {
  const q = String(queryArtist || '').trim().toLowerCase().replace(/\s+/g, '');
  if (!q) return 0;
  const c = String(candidateArtist || '').toLowerCase().replace(/\s+/g, '');
  if (!c) return 0;
  if (c === q) return 2;
  if (c.includes(q) || q.includes(c)) return 2;

  let hit = 0;
  for (const ch of q) if (c.includes(ch)) hit += 1;
  return hit / q.length >= 0.6 ? 1 : 0;
}

/**
 * 一个关键词要问哪些音源。
 *
 * ⚠️ 优先级改过四次，改之前先读完这段（每次改动的原因都不同，别把它们混起来）：
 *
 *   2026-10-05「苹果优先」：实测搜「七里香」时苹果第一条是 周杰倫（原唱），
 *     而网易云抓取整页都是无名翻唱。点歌场景里**歌手对不对远比时长重要**，
 *     所以当时把官方目录排到第一。
 *
 *   2026-10-07「中转源优先」：用户明确要求"优先使用 music.gdstudio.org 这个 API
 *     找歌"，于是把 GD Studio 提到最前。
 *
 *   2026-10-07 晚「咪咕优先」（现在这一版）：**那两台 GD Studio 基址都已经不可用了**
 *     （实测：.org 回 401、.xyz 被劫持跳百度），"排第一"已经没有意义。
 *     同时用户把验收标准说清楚了：**原唱都能听到完整曲子**，而且
 *     "哪个最稳定选哪个，原唱完整这条优先级更高"。
 *     按这两条实测（`_harness\probe-source-quality.mjs`，六首歌逐源对比）：
 *       · **咪咕**是唯一"原唱命中 + 完整整曲"同时成立的源，而且是官方 CDN 直链，
 *         没有第三方中转、没有 key —— 所以它排 order 0。
 *       · 苹果原唱也准，但**只有 30 秒**，不满足"完整曲子"，只能当原唱目录的补充。
 *       · 网易云官方搜索稳（接口从不变），可公开接口**隐藏主流版权曲**，
 *         搜「七里香」第一条是翻唱 —— 排在中转源之前是因为它**最不会挂**。
 *       · qijieya 中转搜索质量差（同样是网易云），但**播放**能给完整 320kbps，
 *         连官方拿不到的版权曲都能拿到 —— 所以它主要当"播放兜底"。
 *
 *   order 同时也是**去重时的胜出顺序**：同名同歌手的条目只有第一条能进候选池。
 *   咪咕排最前，意味着"同一首歌同时被咪咕和网易云搜到时用咪咕那条" ——
 *   咪咕给的是完整整曲、且目录里就是原唱，这正是用户要的。
 *   想让苹果独占，设 `MUSIC_PROVIDER=apple`。
 */
function buildSources(env, keywords) {
  const mode = providerMode(env);
  const sources = [];
  let next = 0;

  // 1) 咪咕：原唱命中率最高、给完整整曲（见上面 migu 那一节的实测表）。
  if (mode !== 'apple') {
    sources.push({
      name: 'migu',
      order: next++,
      resolve: () => miguSearch(keywords),
    });
  }

  // 2) 中转源（默认只剩实测可用的 qijieya）：搜索一般，但**播放**给完整 320kbps。
  if (mode !== 'apple') {
    metingBases(env).forEach((base) => {
      sources.push({
        name: `meting:${hostOf(base)}:${sources.length}`,
        order: next++,
        resolve: () => metingSearch(base, keywords),
      });
    });
  }

  // 3) 苹果官方目录：原唱准，但只有 30 秒（`MUSIC_PROVIDER=apple` 时它是唯一的一个）。
  //    多个 storefront 之间也有先后：hk 的华语覆盖最好，放最前。
  if (mode !== 'meting') {
    storefronts(env).forEach((cc) => {
      sources.push({
        name: `apple:${cc}`,
        order: next++,
        resolve: () => appleSearch(keywords, cc),
      });
    });
  }

  // 4) 网易云官方直连：接口最稳，负责"官方那条路能拿到时的补充"。
  if (mode !== 'apple') {
    sources.push({
      name: 'netease-native',
      order: next++,
      resolve: () => neteaseSearch(keywords),
    });
  }

  return sources;
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return String(url).slice(0, 40); }
}

/* ======================= 音频代理的上游信任边界（审计 A9） =======================

   问题：音频地址是**上游返回**的（Meting 的 JSON 里有 url 字段，苹果那边也拿
   它给的地址），我们并不生产这个地址。旧代码用 `redirect: 'follow'` 直接去取，
   于是最终连到哪台主机完全由上游说了算 —— 上游（或它被攻破后的返回内容）
   可以把我们导向任意主机，甚至内网地址（169.254.169.254 这类云元数据地址）。
   这就是 SSRF：我们的函数成了别人探测内网的跳板。

   修法（两条一起才成立）：
     1. **逐跳校验**：自己跟随重定向，每一跳的目标主机都必须来自可信集合
        （配置里的 Meting 基址 + 苹果 storefront），不在集合里就拒绝。
        用 redirect:'manual' 而不是 'follow'，因为跟随后就再也看不到中间跳了。
     2. **拒绝内网/保留地址**（见下面的 isPrivateIp）。
        ⚠️ 这条的**实际能力边界**：它只检查目标主机名是不是一个 IP **字面量**
        或明确的本地后缀（localhost / .local / .internal），**不做 DNS 解析**。
        也就是说"可信域名被劫持后解析到 169.254.169.254"这种情形它挡不住 ——
        Workers 运行时没有同步 DNS 查询可用来做这件事。真正的第二道防线是
        第 1 条：中间跳必须是可信域名，且最终跳只允许 https 公网 URL。

   为什么允许"可信集合之外"的 https 主机作为最终跳：上游音源经常把音频
   放在自己的 CDN 上，硬性白名单会把正常试听全部打断（那就从"不安全"变成
   "不可用"）。所以最终跳放宽到"https + 公网地址"，而**中间跳必须可信** ——
   中间跳才是能任意指定的那一环。 */

/** IP 字面量是否属于"内网 / 保留"地址（含 IPv6 的本地与私有段）。 */
function isPrivateIp(host) {
  const h = String(host || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;

  // IPv6
  if (h.includes(':')) {
    if (h === '::1' || h === '::') return true;
    if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;          // fc00::/7 唯一本地
    if (/^fe[89ab][0-9a-f]:/.test(h)) return true;          // fe80::/10 链路本地
    const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);     // IPv4 映射
    if (v4) return isPrivateIp(v4[1]);
    return false;
  }

  // IPv4 字面量
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;                                     // 域名：交给下面的解析判断
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;                  // 链路本地（云元数据）
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;        // 运营商级 NAT
  if (a >= 224) return true;                                // 组播 / 保留
  return false;
}

/** 允许作为**中间跳**的主机集合：配置里的 Meting 基址 + 苹果 storefront + 已知官方域。 */
function trustedAudioHosts(env) {
  const hosts = new Set();
  /**
   * 收进可信集合。**要同时接受"完整 URL"和"裸域名"两种输入** ——
   * 这是个踩过的坑：`new URL('music.163.com')` 会抛 TypeError（没有协议），
   * 而它被 catch 静默吞掉，于是那几个裸域名**从来没进过集合**，
   * 表现为"网易云能搜到、一播就报音源地址不可信"。
   * 静默的 catch 是最难查的一类 bug，所以这里显式区分两种形态。
   */
  const add = (value) => {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return;
    if (raw.includes('://')) {
      try { hosts.add(new URL(raw).host); } catch { /* 配置项本身不合法就跳过 */ }
      return;
    }
    // 裸域名（可带端口）：去掉路径部分后直接收下
    const host = raw.split('/')[0];
    if (/^[a-z0-9.-]+(:\d+)?$/.test(host)) hosts.add(host);
  };
  for (const base of metingBases(env)) add(base);
  for (const store of storefronts(env)) add(store);
  // 苹果的官方音频域（试听片段与转移后的 CDN）
  for (const host of ['audio-ssl.itunes.apple.com', 'itunes.apple.com', 'mzstatic.com']) add(host);
  // 网易云官方接口与它的音频 CDN —— outer/url 会 302 到 m*.music.126.net。
  // 少了这两条，网易云源能搜到却播不了（中间跳会被判成不可信主机）。
  for (const host of ['music.163.com', 'music.126.net', '126.net']) add(host);
  // GD Studio 家的音频转发域（出现在它自己播放器的 player.js 里）。
  // GD 的 url 接口有时把音频交给它中转，那一跳必须在这个集合里 ——
  // 否则会被 A9 的逐跳校验拦成"音源地址不可信"（502），表现为"搜得到、播不了"。
  // 只收这一个具体主机，不写成 *.gdstudio.org：信任面越小越好。
  add('music-proxy.gdstudio.org');
  return hosts;
}

/** 主机是否可信（含子域）。 */
function isTrustedHost(host, trusted) {
  const h = String(host || '').toLowerCase();
  if (!h) return false;
  if (trusted.has(h)) return true;
  for (const t of trusted) {
    if (!t.includes('.')) continue;
    if (h.endsWith('.' + t)) return true;                   // *.mzstatic.com 这类
  }
  return false;
}

/**
 * 允许作为**最终跳**：默认要求 https + 非内网地址。
 *
 * 例外：**可信域名的音频 CDN 允许 http** —— 网易云的 outer/url 实测就跳到
 * `http://m801.music.126.net/...`（它至今没上 https）。如果一律要求 https，
 * 网易云源就会"搜得到、播不了"。所以按来源放宽：
 *   · 主机的**顶级域**在可信集合里（music.126.net 等）→ 允许 http；
 *   · 其它主机                            → 必须是 https（拒绝明文与降级）。
 * 这样"安全性来自我们对这个域名来源的既有信任"，而不是"随便哪个 http 都放行"。
 *
 * @param {string} rawUrl
 * @param {Set<string>} trusted 可信主机集合（来自配置与已知官方域）
 */
function isAllowedFinalUrl(rawUrl, trusted = new Set()) {
  let target;
  try { target = new URL(rawUrl); } catch { return false; }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') return false;
  if (target.username || target.password) return false;      // 带凭据的 URL 直接拒绝
  if (isPrivateIp(target.hostname)) return false;
  if (target.protocol === 'http:' && !isTrustedHost(target.host, trusted)) return false;
  return true;
}

/**
 * 取音频上游响应：**自己跟随重定向，逐跳校验**。
 *
 * @returns {Promise<Response|null>} null 表示"中途被安全策略拦下"（调用方给 502）
 */
async function fetchAudioUpstream(env, url, headers, timeoutMs) {
  const trusted = trustedAudioHosts(env);
  let target = url;

  for (let hop = 0; hop < 4; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(target, {
        // 关键：manual —— 跟随后就看不到中间跳了，也就没法校验它
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'User-Agent': 'yczx-musicvote/1.0', ...headers },
      });
    } finally {
      clearTimeout(timer);
    }

    const isRedirect = res.status >= 300 && res.status < 400;
    if (!isRedirect) {
      // 最终跳：非内网地址；http 只允许可信域名（见 isAllowedFinalUrl 的说明）
      if (!isAllowedFinalUrl(res.url || target, trusted)) {
        try { await res.body?.cancel(); } catch { /* 已经关了 */ }
        return null;
      }
      // 声明长度离谱的直接拒绝（防"畸形上游把资源吃光"）
      const declared = Number(res.headers.get('Content-Length'));
      if (Number.isFinite(declared) && declared > AUDIO_BODY_LIMIT) {
        try { await res.body?.cancel(); } catch { /* 已经在关了 */ }
        return null;
      }
      return res;
    }

    const location = res.headers.get('Location');
    try { await res.body?.cancel(); } catch { /* 重定向响应没有 body 要读 */ }
    if (!location) return null;

    let next;
    try { next = new URL(location, target).href; } catch { return null; }

    // 中间跳必须是可信主机 —— 这是能被人为指定的那一环，必须卡住
    let nextHost = '';
    try { nextHost = new URL(next).host; } catch { return null; }
    if (!isTrustedHost(nextHost, trusted)) return null;

    target = next;
  }

  return null;                       // 跳太多：要么是环，要么是有人在牵我们的鼻子
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
 * 历史演变（三次改动，都是为了"搜得到 + 听得到"）：
 *   第一版 `await Promise.all(所有源)` 再挑第一个有结果的 —— 必须等最慢的那个，
 *   一个上游挂起 6 秒，苹果 200ms 就回来了也要干等。
 *   第二版"首个**过线**结果优先 + 优先源等待窗口" —— 快是快了，但
 *   **苹果总是最快、又总是过线**，于是合并前的第三版暴露了问题：
 *   网易云的完整歌曲永远进不了候选，学生只能听 30 秒片段。
 *   第三版（现在）**合并所有源**：等到 MERGE_DEADLINE_MS 或所有源都返回，
 *   然后交给 mergeCandidates 去重排序。
 *
 * 为什么敢等：候选只有 8 条，两个主源（苹果、网易云）实测都在 1 秒内返回；
 * 真正会挂起的只有那些已经失效的第三方中转站，而它们**熔断之后就不再发了**。
 * 所以"等"的代价只在冷启动的头几次，换来的是原唱与完整版都能选。
 */

/** 合并模式下的最长等待：到点就用已经拿到的结果，绝不无限等。 */
const MERGE_DEADLINE_MS = 2500;

async function searchOnce(env, keywords, artist, titleForMatch) {
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

    // 3) 收集所有源的结果，等到"全部返回"或"合并截止时间"
    await new Promise((resolve) => {
      if (!live.length) { resolve(); return; }

      let deadlineTimer = null;
      let finished = false;

      const finish = () => {
        if (finished) return;
        finished = true;
        if (deadlineTimer) clearTimeout(deadlineTimer);
        resolve();
      };

      const accept = (source, songs) => {
        settled.push({ source, songs });
        done += 1;

        // 音源 P0-4：**"搜到 0 条"不是源故障。**
        //
        // 原来这里写的是 `songs.length ? sourceMarkHealthy() : sourceMarkFailure()`，
        // 于是连搜三个冷门歌名就会把一个完全健康的源熔断 90 秒 ——
        // 表现是"刚才还能搜，现在搜不到了"，而用户完全不知道为什么。
        // 上游**正常返回空结果**恰恰说明它活着：它听懂了，只是没有这首歌。
        // 只有真的报错（下面的 catch）才算失败，那个分支里单独记账。
        if (songs.length) sourceMarkHealthy(source.name);

        // 合并模式：不再"第一个过线就收工"，而是等齐所有源（或到截止时间）
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

      // 截止时间：到点就用已经拿到的结果，绝不无限等（挂掉的源由熔断在下一轮剔除）
      deadlineTimer = setTimeout(finish, MERGE_DEADLINE_MS);
    });

    // 4) 选结果：**合并所有源**（见 mergeCandidates 的说明），
    //    再过一道"这一版能不能播"的过滤（见 keepPlayableNetease）。
    //
    //    判据注入的是**和播放完全同一条链**（resolveAudioUrl）——
    //    咪咕走它自己的接口、mt- 走"网易云 -> 中转源"，这正是"说能播就得真能播"的前提。
    //    注入真值（而不是 trackPlayable 的三态）是刻意的：这里的语义只有
    //    "这条路拿不到音频"要被标出来；探测本身出错不算"没音频"（见 playable.js 的三种返回值）。
    const merged = mergeCandidates(settled, titleForMatch || keywords, artist);
    const ranked = await keepPlayableNetease(merged, {
      resolve: async (trackId) => {
        try {
          return Boolean(await resolveAudioUrl(env, trackId));
        } catch {
          return null;                    // 探测出错 -> 不确定，不打"无音频"标记
        }
      },
    });
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

/**
 * 三级降级：歌名+歌手 → 歌名 → 模糊（不做歌名过滤）。
 *
 * @param {string} title    完整查询词（用于打上游）
 * @param {string} artist   学生填的歌手（可为空）
 * @param {string} [titleForMatch] 真正用于"算不算匹配上"的歌名。
 *   前端把歌名框整段文字当 q 传来，所以「雨爱 杨丞琳」这样的查询必须拆出
 *   「雨爱」再过滤 —— 否则原唱《雨爱》会因为不包含"雨爱 杨丞琳"而被刷掉，
 *   只剩标题里恰好含那串字的翻唱（这就是"只出 DJ 版"的成因）。
 */
async function searchWithFallback(env, title, artist, titleForMatch) {
  // 关键：过滤/排序一律用**拆出来的歌名**。调用方没传时这里自己拆一次
  //（少一层依赖 —— 无论谁调用 searchWithFallback 都不会再犯"整段当歌名"的错）。
  const matchAgainst = String(titleForMatch || titlePartOf(title) || title || '');
  // 歌手线索：优先用前端填的那个字段（选过歌才有）；没有就从查询词里拆
  //（学生手打「雨爱 杨丞琳」时，那个只读字段是空的 —— 见 artistHintOf 的说明）。
  // 它**只影响排序**，不参与过滤，所以猜错不会把结果筛没。
  const artistForRank = String(artist || artistHintOf(title) || '');

  const attempts = [];
  if (artist) attempts.push({ keywords: `${title} ${artist}`, filter: true, tier: '歌名+歌手' });
  attempts.push({ keywords: title, filter: true, tier: '歌名' });
  attempts.push({ keywords: title, filter: false, tier: '模糊搜索' });

  for (const attempt of attempts) {
    // searchOnce 内部有短期缓存，所以第二、三级用同一个关键词时不会重打上游。
    // artist 传进去只影响**排序**（歌手吻合的候选更靠前），不影响搜索词。
    const songs = await searchOnce(env, attempt.keywords, artistForRank, matchAgainst);
    if (!songs.length) continue;
    const filtered = attempt.filter ? songs.filter((s) => matchesTitle(s.name, matchAgainst)) : songs;
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

  // 咪咕：contentId 是长数字串，走它自己的 official CDN（实测完整整曲）。
  // 与 mt- 分开成两个前缀是**必要的**，不是命名洁癖：mt- 的数字 id 语义是
  // "网易云歌曲 id"，_lib/playable.js 会拿它去拼 outer/url（neteaseIdOf 只认 mt-）。
  // 若把咪咕也写成 mt-，那串 contentId 会被当成网易云 id 去探测，**必然全部判成
  // 拿不到音频**，于是所有咪咕候选都被标上"无音频"。
  if (prefix === 'mg') return miguResolve(realId);

  // 网易云官方接口：**纯数字 id** 才可能是它（网易云歌曲 id 都是数字）。
  //
  // mt- 前缀同时被几种源使用，而它们的 id 形态不同 ——
  //   · 网易云官方  → 纯数字（如 mt-2712018330）
  //   · GD Studio   → 通常也是网易云的数字 url_id，偶尔带字母
  //   · Meting      → 数字，但它是自建服务、用户自己配的
  // 所以纯数字 id 先按网易云官方解析。
  //
  // ⚠️ 2026-10-07 修掉一个"搜得到却播不了、还被标成无音频"的成因：
  //   旧代码对纯数字 id **直接返回网易云那条地址就完事**。可网易云对受版权
  //   限制的歌只会把你导回它自己的页面（拿不到音频），而此时**中转源往往是
  //   能拿到的**（用户原话："我能找到资源免费的音乐也显示无音频"，
  //   举的例子是《希望有羽毛和翅膀》）。所以：
  //     先看探测结论（搜索时已经探过，命中 10 分钟缓存，几乎不花时间）；
  //     网易云明确拿不到 -> 逐个问中转源；都拿不到才把网易云那条交回去，
  //     让转发层给出统一的失败提示（总比返回 null 变成"这首歌不存在"诚实）。
  if (prefix === 'mt' && /^\d{1,20}$/.test(realId)) {
    if (await probeNeteasePlayable(realId) !== false) return neteaseOuterUrl(realId);
    const viaRelay = await metingResolveAny(env, realId);
    return viaRelay || neteaseOuterUrl(realId);
  }

  if (prefix === 'mt') {
    return metingResolveAny(env, realId);
  }

  return null;
}

/**
 * 逐个问中转源要直链，返回第一个拿到的。
 *
 * 抽出来是为了两处共用同一条顺序：**播放解析**（resolveAudioUrl）与
 * **可播性判断**（trackPlayable）—— 判断和播放必须走同一批源，
 * 否则又会出现"说能播却播不了"或反过来的分歧。
 */
async function metingResolveAny(env, songId) {
  for (const base of metingBases(env)) {
    // eslint-disable-next-line no-await-in-loop
    const url = await metingResolve(base, songId);
    if (url) return url;
  }
  return null;
}

/**
 * 「这个音源 id 到底能不能播」——**导出给 admin-list.js 复用**。
 *
 * 为什么让它住在这里而不是 _lib/playable.js：判断必须包含"问中转源 / 问咪咕"这一步，
 * 而"怎么问"（miguResolve / metingResolve / 各家的参数形状）就在本文件里。
 * 把 URL 解析逻辑复制一份到 _lib 里，迟早会出现两边判据不一致 —— 那正是
 * 这次假阴性的教训（判据只覆盖了一条路，于是把能播的歌标成"无音频"）。
 *
 * 咪咕单独走一条：它的 contentId 不适用"网易云那条路"的判据（见 resolveAudioUrl
 * 里 mg- 那段的说明），直接问它自己的接口即可。
 */
export async function trackPlayable(env, trackId) {
  const contentId = miguContentIdOf(trackId);
  if (contentId) {
    try {
      return Boolean(await miguResolve(contentId));
    } catch {
      return null;                          // 探测本身出错 -> 不确定，不能判成"没音频"
    }
  }
  // 历史（009 迁移之前的）track_id 带的是别的形状，统一交给探测链：
  // 它自己会按前缀决定用哪条路，这里传的是"非 mt- 就只问中转源"的老语义。
  return probeTrackPlayable(trackId, (id) => metingResolveAny(env, id));
}

/**
 * 音频上游请求：**只要响应，不读 body**。
 *
 * 为什么不能复用 fetchBounded：那个函数是为了"搜索结果"设计的 ——
 * 它会把 body 整个读进内存再 JSON.parse。音频不能这么干：
 * 一首 30 秒试听就有 1~2MB，Meting 的完整歌曲更大，
 * 全读进内存既浪费又容易撞上免费套餐的内存/CPU 预算。
 * 音频必须**流式转发**给浏览器。
 *
 * 超时只覆盖"连上并拿到响应头"这一段。一旦开始转发就不能再用总时限 ——
 * 大文件本来就要慢慢传，用总时限掐断会把正常播放打断。
 * 卡死的连接由浏览器自己超时/取消（客户端断开会传递到这里的 signal）。
 *
 * ⚠️ 历史教训：这个函数曾经叫 fetchUpstream，在某次重构里被改名成 fetchBounded
 * 但**漏改了调用点**，导致音频代理每次都抛 ReferenceError、被 catch 吞掉后
 * 报成"音源获取超时" —— 表现就是**试听一首也放不出来**。
 * 那条"调用的助手必须真的存在"的测试现在守着 fetchAudioUpstream（本轮 A9 的替身）。
 */

async function proxyAudio(env, prefixedId, request) {
  const directUrl = await resolveAudioUrl(env, prefixedId);
  if (!directUrl) return error('这首暂时没有可试听的片段，换一首试试', 404);

  const headers = {};
  const range = request.headers.get('Range');
  if (range) headers.Range = range;

  let upstream;
  try {
    // 审计 A9：不再用 redirect:'follow' —— 改成逐跳校验（见 fetchAudioUpstream）。
    upstream = await fetchAudioUpstream(env, directUrl, headers, AUDIO_TIMEOUT_MS);
  } catch {
    return error('音源获取超时，请稍后再试', 504);
  }
  // fetchAudioUpstream 返回 null = 重定向跳到了不可信主机（或最终不是 https/公网）
  if (!upstream) return error('音源地址不可信，已拒绝转发', 502);
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

/**
 * 只发一个 Range 请求量出音频**总字节数**（给 `?probe=1` 用）。
 *
 * 为什么需要一个专门的"量体积"函数：判断"拿到的是完整整曲还是几十秒试听"
 * 靠听是听不出来的（`auditionsLength` 这类字段也不可信）——
 * 唯一可靠的办法是读 `Content-Range: bytes 0-0/<总字节>`，
 * 再和歌曲时长反算码率。128kbps 左右就是完整曲子；明显偏低就是片段。
 *
 * 只读 1 个字节，不下载音频内容。
 */
async function probeAudioSize(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      headers: { Range: 'bytes=0-0', 'User-Agent': 'yczx-musicvote/1.0', Referer: 'https://y.migu.cn/' },
      signal: controller.signal,
    });
    const contentRange = res.headers.get('Content-Range') || '';
    const total = Number((contentRange.match(/\/(\d+)/) || [])[1]) || 0;
    try { await res.body?.cancel(); } catch { /* 只要头部，body 立刻关掉 */ }
    return { status: res.status, bytes: total, contentType: res.headers.get('Content-Type') || '' };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  // 配置自检：只返回模式名，不泄露任何上游地址。
  if (url.searchParams.get('status') === '1') {
    return json({ configured: true, provider: providerMode(env) });
  }
  /**
   * 音源自检：`/api/music?probe=1`
   *
   * 为什么需要它：免费套餐的出口在 Cloudflare 侧，**本机测通不代表部署后也通**
   * （上游可能对数据中心 IP 另有策略）。所以给一个能从真实部署上一键验证的口子：
   * 部署完打开这个地址，就能看到"苹果能不能搜到 / 网易云能不能搜到、能不能拿到音频"。
   *
   * 还带一个 `build` 版本号：**用来确认线上跑的到底是哪一份代码** ——
   * 排查"改了没生效"时，第一件事就是看这个数字，而不是猜。
   *
   * 安全：只回结论、计数与版本号，不回任何上游地址、id、歌名；不需要登录
   * （它不泄露用户数据，而"能直接打开"正是它的价值）。
   */
  if (url.searchParams.get('probe') === '1') {
    const report = { build: MUSIC_BUILD, provider: providerMode(env), migu: null, apple: null, netease: null, gdstudio: null };
    const keyword = '七里香';

    /**
     * 咪咕：**现在排第一位，所以它的自检也排第一位**。
     *
     * 口径和别的源一样：只回"搜到几条 / 第一条能不能取到并量到音频字节数"，
     * 不回 contentId、不回歌名。`bytes` 是关键指标 —— 它是**实测到的整曲总字节数**，
     * 拿它和时长反算就能一眼看出拿到的是完整曲子（128kbps 左右）还是几十秒的试听片段。
     * 数字明显偏小（比如不到 1MB）就说明上游把"试听"变成真的了 —— 那时要重新选源。
     *
     * 为什么值得专门量：本机测通不代表 Cloudflare 出口也通（上游常按来源 IP 分别对待），
     * 而咪咕是官方 CDN、对境外数据中心 IP 的态度无法从本机推断。
     * 部署完打开 `?probe=1` 就能看到这一节，不必靠猜。
     */
    try {
      const songs = await miguSearch(keyword);
      let resolvable = null;
      let measured = null;
      const first = songs.find((s) => /^mg-\d{1,24}$/.test(String(s.id || '')));
      if (first) {
        const url = await miguResolve(miguContentIdOf(first.id));
        resolvable = Boolean(url);
        if (url) measured = await probeAudioSize(url);
      }
      report.migu = {
        ok: songs.length > 0,
        count: songs.length,
        resolvable,
        bytes: measured && measured.bytes ? measured.bytes : null,
        durationSeconds: first ? first.duration : null,
        hint: '官方 CDN 直链；bytes 是实测整曲总字节数（与时长反算即可判断是否完整曲子）',
      };
    } catch {
      report.migu = { ok: false, count: 0, error: 'unreachable' };
    }

    // 苹果
    try {
      const songs = await appleSearch(keyword, storefronts(env)[0]);
      report.apple = { ok: songs.length > 0, count: songs.length, hint: '官方 30 秒试听' };
    } catch {
      report.apple = { ok: false, count: 0, error: 'unreachable' };
    }

    // 网易云：搜索 + 取一个候选验证能否真拿到音频
    try {
      const songs = await neteaseSearch(keyword);
      let playable = null;
      const first = songs.find((s) => /^mt-\d+$/.test(String(s.id || '')));
      if (first) {
        const ok = await probeNeteasePlayable(String(first.id).slice(3));
        playable = ok;                       // true/false/null(探测失败)
      }
      report.netease = {
        ok: songs.length > 0,
        count: songs.length,
        playableProbe: playable,
        hint: '官方接口；playableProbe=true 表示能拿到完整音频',
      };
    } catch {
      report.netease = { ok: false, count: 0, error: 'unreachable' };
    }

    /**
     * 中转源（Meting 形状）：逐个配置基址试一次搜索，再拿第一条候选试一次
     * "能不能取到播放地址"。默认清单里现在只剩实测可用的 qijieya，
     * 谁被 `MUSIC_API_BASE` 换成自建基址，这一节就报那台的结果。
     *
     * 口径与上面几段一致：只回**序号 / 通不通 / 几条候选 / 能否取到地址**，
     * 不回域名、不回 id、不回歌名 —— 所以它仍然可以公开访问。
     */
    try {
      const bases = metingBases(env);
      const detail = [];
      let total = 0;
      for (let index = 0; index < bases.length; index++) {
        // 顺序探测（基址只有个位数），失败不影响后面的基址
        // eslint-disable-next-line no-await-in-loop
        const songs = await metingSearch(bases[index], keyword);
        total += songs.length;
        let resolvable = null;
        const first = songs.find((s) => /^mt-[A-Za-z0-9_-]{1,40}$/.test(String(s.id || '')));
        if (first) {
          // eslint-disable-next-line no-await-in-loop
          resolvable = Boolean(await metingResolve(bases[index], String(first.id).slice(3)));
        }
        detail.push({ index, ok: songs.length > 0, count: songs.length, resolvable });
      }
      report.gdstudio = { ok: total > 0, count: total, bases: bases.length, detail };
    } catch {
      report.gdstudio = { ok: false, count: 0, error: 'unreachable' };
    }

    return json({
      ...report,
      verdict: (report.migu && report.migu.ok)
        || (report.apple && report.apple.ok)
        || (report.netease && report.netease.ok)
        || (report.gdstudio && report.gdstudio.ok)
        ? 'at-least-one-source-works'
        : 'all-sources-unreachable',
    });
  }

  // 学生或管理员都可以试听（后台审核时也需要听一下）。
  // 传 null 表示两种会话都接受。
  const auth = await requireSession(env, request, null);
  if (!auth.ok) return auth.response;

  const limit = await guardRate(env, request, {
    kind: 'music',
    limit: 240,                         // 每台设备/每条会话每小时 240 次
    windowSeconds: 3600,
    // IP 兜底比旧值（按 IP 120/小时）宽得多：旧写法等于全校共用 120 次试听额度。
    // 现在 1200 只挡"一个出口的脚本疯狂拉音频"，正常上课时间段的试听远够用。
    ipLimit: 1200,
    session: auth.session,
    message: '试听请求过于频繁，请稍后再试',
  });
  if (limit) return limit;

  /**
   * 音源 P0-3：惰性可播性校验 `?check=<trackId>`。
   *
   * 目的：点「试听」之前就知道这一版有没有音频，**根本不挂必然失败的播放器**。
   * 零数据库迁移：复用 probeNeteasePlayable 与它自带的 10 分钟缓存。
   *
   * 位置很讲究：排在 guardRate 之后、play 分支之前 ——
   *   1. 不能排在限流之前，否则它就成了免费的探测入口；
   *   2. 不能排在 play 之后，否则会被 play 分支吞掉；
   *   3. 它**不会**触发任何音频转发，只做一次重定向探测。
   *
   * 只回结论，不回任何上游地址或 id（与 probe 同一条口径）。
   */
  const checkId = (url.searchParams.get('check') || '').trim();
  if (checkId) {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(checkId)) return error('歌曲 id 不正确', 400);

    // 苹果给的是官方 previewUrl，必有音频；其它前缀来源无法判断 -> null（放行）
    if (/^ap-/.test(checkId)) return json({ ok: true, playable: true });

    // 咪咕与 mt- 都交给 trackPlayable —— 它内部按前缀分派：
    // mg- 问咪咕自己的接口，mt- 走"网易云 -> 中转源"那条链。
    // ⚠️ 这里原本写的是 `if (/^mt-/.test(checkId))`，把 mg- 漏在外面会静默滑到
    //    最后那个 `playable: null`（"不确定"）—— 表现是"咪咕的歌点了没反应也不报错"，
    //    所以判据必须覆盖所有会带 ?check= 的前缀。
    if (/^(mt|mg)-/.test(checkId)) {
      // 判据与搜索结果、审核列表、播放解析**完全同一条链**（见 trackPlayable）
      const playable = await trackPlayable(env, checkId);
      return json({ ok: true, playable });
    }

    return json({ ok: true, playable: null });
  }

  const playId = (url.searchParams.get('play') || '').trim();
  if (playId) {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(playId)) return error('歌曲 id 不正确', 400);

    // 审计 C6：音频是**分段拉取**的 —— 放一首歌浏览器会发十几个 Range 请求，
    // 拖动进度条还会再来一批。它们属于同一次人工试听，按"每请求一个额度"
    // 计会让正常使用凭空放大十几倍，把整个出口的额度吃光。
    // 这里把 (会话, 音源 id) 在本小时窗口内折叠成一次计数。
    // 注意：折叠的是**计数**，不是请求本身 —— 每个 Range 请求仍然照常转发，
    // 否则播放器会卡住（这条限流绝不能变成拦请求）。
    const who = Number.isInteger(Number(auth.session.id)) ? Number(auth.session.id) : 0;
    const folded = await rateLimitOnce(env, `audio:${who}`, playId, 60, 3600);
    if (!folded.allowed) return error('试听请求过于频繁，请稍后再试', 429);

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

  /**
   * 拆出"歌名"部分用于过滤与排序（见 titlePartOf 的说明）。
   * 前端把歌名框整段文字当查询词发来，所以「雨爱 杨丞琳」必须拆成「雨爱」，
   * 否则原唱《雨爱》会被自己的过滤条件刷掉 —— 那就是"只出 DJ 版"的成因。
   */
  const titleForMatch = titlePartOf(title.value);

  // 审计 C6 的全站预算。
  //
  // 这里**必须有实际作用**，否则就是死代码（这个仓库最忌讳"写了没接线"）。
  // 它拦的位置很讲究：搜索真的会打上游（苹果 / Meting），
  // 而细粒度额度管的是"谁搜了多少"，管不了"整个站点一小时被搜了多少次" ——
  // 有人开几百个会话轮流搜就能绕过前者。
  //
  // 用法是**超预算时收紧限流**，而不是直接拒绝：拒绝搜索会让正常学生
  // 连歌都选不了（可用性代价远大于收益）；收紧之后每人每小时的搜索次数
  // 从 120 降到 20，仍然够正常点一首歌，但脚本刷的收益被压到很低。
  const siteSearches = await countBudget(env, 'music-search', 3600);
  if (siteSearches > 2000) {
    const tight = await guardRate(env, request, {
      kind: 'music-search-tight',
      limit: 20,
      windowSeconds: 3600,
      session: auth.session,
      ipLimit: 60,
      message: '搜索过于频繁，请稍后再试',
    });
    if (tight) return tight;
  }

  try {
    // 搜索用**完整查询词**（上游靠"歌名+歌手"才排得准），
    // 过滤与排序用**拆出来的歌名**（否则"雨爱 杨丞琳"会把原唱自己刷掉）。
    const { tier, songs } = await searchWithFallback(env, title.value, artist, titleForMatch);
    // 每个候选都带上签名的选曲凭据：前端选中哪首就把哪张凭据带回去，
    // vote.js 校验通过后**以凭据内容为准**，杜绝"歌名是一首、音源是另一首"。
    const results = await attachTrackTokens(env, songs);
    return json({ provider: providerMode(env), tier, results });
  } catch {
    return error('音源服务暂时不可用，请稍后再试', 502);
  }
}
