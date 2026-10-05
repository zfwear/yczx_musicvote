import { error, json } from '../../_lib/http.js';
import { requireSession, guardRate, rateLimitOnce, countBudget } from '../../_lib/auth.js';
import { sanitizeText } from '../../_lib/validate.js';
import { signTrackToken } from '../../_lib/tracktoken.js';

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
 *   1. `apple:<storefront>` —— 苹果官方 iTunes 搜索接口，按 hk / tw / us 依次。
 *      官方 30 秒试听，无需 key，最稳；负责"找得到原唱"。
 *   2. `meting:<host>` —— GD Studio / Meting 形状的中转，**优先源**。
 *      2026-10-07 按用户要求从末位提上来；默认第一个基址就是用户指定的
 *      `music.gdstudio.org`。给完整歌曲，覆盖面比网易云官方公开接口宽。
 *   3. `netease-native` —— 网易云官方公开接口。给完整歌曲；
 *      公开搜索接口隐藏主流版权曲，版权受限曲拿不到音频（探测为 false）。
 *   默认基址见 DEFAULT_METING_BASES，其可用性随时间变化，不要假设它活着。
 *   `MUSIC_PROVIDER=meting` 会关掉苹果源（于是中转源成为第一位）、
 *   `=apple` 会关掉网易云与 Meting。
 *
 * 歌曲 id 带音源前缀（mt-<数字> / ap-<数字>），这样播放时不必猜测该用哪家，
 * 也避免两家的数字 id 互相撞车。`?check=` 只对 `mt-` 有意义（苹果必有音频）。
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
const MUSIC_BUILD = '2026-10-07-b+gdstudio-org';

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
  // 实测过的一批公共音源（清单来自 VoiceHub 的 musicSources.ts，逐个实测筛选）。
  // 2026-10-05 结论：
  //   ✅ music-api.gdstudio.xyz   搜索 + 播放地址都可用（完整歌曲 320kbps）
  //   ❌ api.qijieya.cn/meting/   type=search 返回空、type=url 返回空
  //   ❌ api.injahow.cn/meting/   type=search 报 unknown type、type=url 返回空
  //   ❌ api.ygking.top           域名已无法解析
  //   ⚠️ api.vkeys.cn/v2/music    搜索可用（QQ 音乐、原唱准）但 url 恒为 null，不能播
  // 所以默认只留 GD Studio。要换成自建 Meting，设 MUSIC_API_BASE 即可。
  //
  // 2026-10-07 追加 `music.gdstudio.org`（用户指定接入的"音源 API"）：
  //   · 域名本身活着（Cloudflare，首页 200），与 music-api.gdstudio.xyz 同属 GD Studio；
  //   · 本机实测它的 `?types=search&...` 回 `401 {"detail":"Invalid request."}`，
  //     只有 `?types=playlist` 回 `200 []`。用户明确要求接入，所以照办、放在第一位。
  //   · 为什么放第一位也不冒险：搜索侧它是**并行的一路**，返回空只是少一路候选，
  //     不会拖长尾（所有源都受 MERGE_DEADLINE_MS 约束）；播放侧 metingResolve
  //     逐基址回退，它取不到地址就自动落到下一个基址。GD Studio 家的两套参数
  //     形状由 isGdStudio() 按域名自动分派，这里不需要再写任何分派逻辑。
  'https://music.gdstudio.org/api.php',
  'https://music-api.gdstudio.xyz/api.php',
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

/** 网易云播放地址：outer/url 会 302 跳到真实 CDN 直链（完整歌曲）。 */
function neteaseResolveUrl(songId) {
  return `https://music.163.com/song/media/outer/url?id=${encodeURIComponent(songId)}.mp3`;
}

/* ---------------- 网易云候选的"可播性"过滤 ----------------

   为什么需要它（实测数据）：网易云**受版权限制的歌**（原唱居多：
   Beyond《海阔天空》、米津玄師《Lemon》、逃跑计划《夜空中最亮的星》…）
   的 outer/url 会 **302 回它自己的首页**，拿不到任何音频。
   实测 21 个候选里有 5 个是这种（约 1/4）。

   不滤掉的后果最糟：学生看到《海阔天空 / Beyond》很自然地选它、提交、
   入库存下这个 id，**以后谁都播不出来** —— 用户的原话就是"点了却放不了"。
   所以宁可少给几个候选，也不给一个点了不能用的。

   做法：搜索后并发探一次（只取响应头，不读 body），能出音频的才留下。
   · 只对网易云候选做（苹果那边给的是官方 previewUrl，一定有音频）；
   · 并发 4 路 + 总超时 1.8 秒，避免把搜索拖慢；
   · 结果按 id 缓存 10 分钟，翻来覆去搜同一首歌不会反复探测；
   · 探测本身失败（超时/网络抖动）时**保留**该候选 —— 宁可偶尔给一个
     放不出来的，也不要在网络不稳时把搜索结果清空。 */

const NETEASE_PLAYABLE_TTL_MS = 10 * 60 * 1000;
const NETEASE_PLAYABLE_MAX = 400;
const neteasePlayable = new Map();      // id -> { ok: boolean, at: number }

function neteasePlayableCached(id) {
  const hit = neteasePlayable.get(id);
  if (hit && Date.now() - hit.at < NETEASE_PLAYABLE_TTL_MS) return hit.ok;
  return null;
}

function rememberPlayable(id, ok) {
  if (neteasePlayable.size > NETEASE_PLAYABLE_MAX) {
    // 简单的容量控制：清掉最早的一批（Worker isolate 内存有限）
    const keys = Array.from(neteasePlayable.keys()).slice(0, 100);
    for (const k of keys) neteasePlayable.delete(k);
  }
  neteasePlayable.set(id, { ok, at: Date.now() });
}

/** 探一次"这个 id 到底能不能出音频"。返回 true=能播，false=拿不到音频，null=探测失败（不确定）。 */
async function probeNeteasePlayable(songId) {
  const cached = neteasePlayableCached(songId);
  if (cached !== null) return cached;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500);
  try {
    // 第 1 跳：outer/url（看它把我们导向哪）
    const first = await fetch(neteaseResolveUrl(songId), {
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'User-Agent': 'yczx-musicvote/1.0', Referer: 'https://music.163.com/', Cookie: 'appver=2.0.2' },
    });
    const location = first.headers.get('Location') || '';
    try { await first.body?.cancel(); } catch { /* 重定向响应没有 body */ }

    // 关键判据：受版权限制时它跳回自己首页（含 404 / music.163.com/song 之类），
    // 而不是跳到 m*.music.126.net 这种 CDN。
    if (!location) { rememberPlayable(songId, false); return false; }
    const target = new URL(location, neteaseResolveUrl(songId)).href;
    let host = '';
    try { host = new URL(target).host; } catch { /* 非法 Location */ }
    if (!/(^|\.)music\.126\.net$/.test(host)) {
      rememberPlayable(songId, false);
      return false;
    }
    rememberPlayable(songId, true);
    return true;
  } catch {
    // 超时/网络问题：不确定，交给调用方保留候选
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 并发过滤网易云候选：只留下"确认能播"的。
 * 探测失败的（不确定）保留，避免网络抖动时把结果清空。
 */
async function keepPlayableNetease(songs) {
  const targets = songs.filter((s) => /^mt-\d+$/.test(String(s.id || '')));
  if (!targets.length) return songs;

  const verdicts = new Map();
  const queue = targets.slice();
  const CONCURRENCY = 6;
  const deadline = Date.now() + 4000;

  const worker = async () => {
    while (queue.length && Date.now() < deadline) {
      const song = queue.shift();
      const id = String(song.id).slice(3);
      // eslint-disable-next-line no-await-in-loop
      const ok = await probeNeteasePlayable(id);
      verdicts.set(song.id, ok);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));

  // ⚠️ 这里**不再删除**不可播的候选，只给它打一个 `playable=false` 标记。
  //
  // 为什么（用户反馈："搜索雨爱居然只能出 DJ 版"）：有些歌的**原唱**
  // 受版权限制拿不到音频（实测网易云的杨丞琳《雨爱》outer/url 会 302
  // 回它自己首页），而苹果目录里没有这一版。直接删掉整条会让原唱
  // **从列表里消失**，学生只能看到翻唱/DJ 版，以为"系统搜不到原唱"。
  // 打标记则由前端显示"暂无试听"——知情比消失好。
  return songs.map((s) => {
    const v = verdicts.get(s.id);
    if (v === false) return { ...s, playable: false };
    return s;
  });
}

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
 */
function artistFitScore(candidateArtist, queryArtist) {
  const q = String(queryArtist || '').trim().toLowerCase();
  if (!q) return 0;
  const c = String(candidateArtist || '').toLowerCase();
  if (!c) return 0;
  if (c === q) return 2;
  if (c.includes(q) || q.includes(c)) return 1;
  return -1;
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
    const bases = metingBases(env);

    /**
     * 中转源（GD Studio 等）：**排在苹果之后、网易云官方接口之前**。
     *
     * 2026-10-07 由用户要求"优先用 GD Studio 这个 API"后从末位提上来。
     * 为什么提一级、而不是提到最前（这个位置是权衡过的，改之前先读）：
     *   · 提到网易云官方之前 —— 两者其实都是"网易云抓取"，但中转站的覆盖面
     *     更宽（官方公开搜索接口会隐藏主流版权曲），候选质量不差且更全，
     *     所以让它先说话是纯收益。
     *   · 不提到苹果之前 —— 苹果是**官方目录**，是"搜周杰伦能出周杰倫原唱"
     *     的唯一保证；第三方抓取排到它前面，就会退回"搜七里香出来的是无名
     *     翻唱"那个已经修过一轮的老问题上（见本文件顶部与 mergeCandidates 的说明）。
     *   想让它**连苹果也压过去**（完全以中转源为准）不需要改这里，设
     *   `MUSIC_PROVIDER=meting` 即可 —— 那个模式下没有苹果源，它就是第一位。
     *
     * order 同时也是**去重时的胜出顺序**：同名同歌手的条目只有第一条能进候选池，
     * 所以把中转源提前意味着"同一首歌同时被中转站与官方接口搜到时，用中转站那条"。
     * 这正好是我们要的：中转站给的是完整歌曲，官方接口常常只给片段。
     */
    bases.forEach((base, index) => {
      sources.push({
        name: `meting:${hostOf(base)}:${index}`,
        order: storefrontCount + index,
        resolve: () => metingSearch(base, keywords),
      });
    });

    // 网易云官方接口直连：排在苹果与中转源之后，负责"官方那条路能拿到时的兜底与补充"。
    sources.push({
      name: 'netease-native',
      order: storefrontCount + bases.length,
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
    //    再过一道"网易云候选能不能播"的过滤（见 keepPlayableNetease）。
    const merged = mergeCandidates(settled, titleForMatch || keywords, artist);
    const ranked = await keepPlayableNetease(merged);
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
  const attempts = [];
  if (artist) attempts.push({ keywords: `${title} ${artist}`, filter: true, tier: '歌名+歌手' });
  attempts.push({ keywords: title, filter: true, tier: '歌名' });
  attempts.push({ keywords: title, filter: false, tier: '模糊搜索' });

  for (const attempt of attempts) {
    // searchOnce 内部有短期缓存，所以第二、三级用同一个关键词时不会重打上游。
    // artist 传进去只影响**排序**（歌手吻合的候选更靠前），不影响搜索词。
    const songs = await searchOnce(env, attempt.keywords, artist, matchAgainst);
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

  // 网易云官方接口：**纯数字 id** 才可能是它（网易云歌曲 id 都是数字）。
  //
  // 这里为什么能安全地"先猜网易云"：mt- 前缀同时被三种源使用，
  // 而它们的 id 形态不同 ——
  //   · 网易云官方  → 纯数字（如 mt-2712018330）
  //   · GD Studio   → 带字母的 url_id（如 mt-ab12cd34）
  //   · Meting      → 数字，但它是自建服务、用户自己配的
  // 所以对纯数字 id：先按网易云官方解析；万一那是自建 Meting 的 id，
  // 我们的代理会把"打不开的地址"变成一次失败的转发并报 502 ——
  // 不会更糟（原本它也未必可用），而常见情况（公共中转站全挂、
  // 只有官方接口活着）下这是唯一能播的路。
  // 历史数据的兼容性：009 之前入库的 track_id 是这三家的混合，
  // 但**试听失败只是提示重试**，不会破坏数据，所以不为此加新表列。
  if (prefix === 'mt' && /^\d{1,20}$/.test(realId)) {
    return neteaseResolveUrl(realId);
  }

  if (prefix === 'mt') {
    for (const base of metingBases(env)) {
      const url = await metingResolve(base, realId);
      if (url) return url;
    }
    return null;
  }

  return null;
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
    const report = { build: MUSIC_BUILD, provider: providerMode(env), apple: null, netease: null, gdstudio: null };
    const keyword = '七里香';

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
     * GD Studio / 中转源：逐个配置基址试一次搜索，再拿第一条候选试一次"能不能取到播放地址"。
     *
     * 为什么值得单独报：用户指定接入的 `music.gdstudio.org` 在本机探测时回
     * `401 {"detail":"Invalid request."}`，但**本机通不代表 Cloudflare 出口通、
     * 本机不通也不代表出口不通**（上游常按来源 IP 分别对待）。所以给它一个
     * 能在真实部署上直接看结论的口子。
     *
     * 口径与上面两段一致：只回**序号 / 通不通 / 几条候选 / 能否取到地址**，
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
      verdict: (report.apple && report.apple.ok) || (report.netease && report.netease.ok) || (report.gdstudio && report.gdstudio.ok)
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

    if (/^mt-\d+$/.test(checkId)) {
      const realId = checkId.slice(3);
      const playable = await probeNeteasePlayable(realId);
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
