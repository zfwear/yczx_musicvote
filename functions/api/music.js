import { error, json, clientIp } from '../../_lib/http.js';
import { requireSession, rateLimit } from '../../_lib/auth.js';
import { sanitizeText } from '../../_lib/validate.js';

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
 * 环境变量（全部可选，不配也能用）：
 *   MUSIC_PROVIDER    'auto'（默认）| 'meting' | 'apple'
 *   MUSIC_API_BASE    覆盖 Meting 上游根地址
 *   MUSIC_STOREFRONT  苹果商店地区，默认 hk（cn 商店不通过接口提供歌曲）
 */

const SEARCH_TIMEOUT_MS = 6000;
const AUDIO_TIMEOUT_MS = 15000;
const MAX_RESULTS = 8;
const MAX_FIELD_LENGTH = 120;

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

async function fetchUpstream(url, options = {}, timeoutMs = SEARCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: { 'User-Agent': 'yczx-musicvote/1.0', ...(options.headers || {}) },
    });
  } finally {
    clearTimeout(timer);
  }
}

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
  try {
    const res = await fetchUpstream(url);
    if (!res.ok) return [];
    return normalizeMeting(await res.json());
  } catch {
    return [];
  }
}

async function metingResolve(base, songId) {
  const url = `${base}?server=netease&type=url&id=${encodeURIComponent(songId)}`;
  let res;
  try {
    // redirect: 'manual' —— 只要 Location，不要真的把音频下载下来
    res = await fetchUpstream(url, { redirect: 'manual' });
  } catch {
    return null;
  }

  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('Location');
    return location && /^https?:\/\//i.test(location) ? location : null;
  }
  if (!res.ok) return null;

  // 少数实现不跳转，而是直接返回 URL 文本或 JSON
  try {
    const text = (await res.text()).trim();
    if (/^https?:\/\//i.test(text)) return text;
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
  try {
    const res = await fetchUpstream(url);
    if (!res.ok) return [];
    return normalizeApple(await res.json());
  } catch {
    return [];
  }
}

async function appleResolve(trackId) {
  const url = `https://itunes.apple.com/lookup?id=${encodeURIComponent(trackId)}&entity=song`;
  try {
    const res = await fetchUpstream(url);
    if (!res.ok) return null;
    const payload = await res.json();
    const item = payload && Array.isArray(payload.results) ? payload.results[0] : null;
    const direct = item && item.previewUrl;
    return typeof direct === 'string' && /^https:\/\//i.test(direct) ? direct : null;
  } catch {
    return null;
  }
}

/* ======================= 搜索编排 ======================= */

function matchesTitle(candidate, title) {
  const a = String(candidate || '').toLowerCase().replace(/\s+/g, '');
  const b = String(title || '').toLowerCase().replace(/\s+/g, '');
  if (!b) return true;
  return a.includes(b) || b.includes(a);
}

/**
 * 一次关键词搜索：多音源**并行**发起，按优先级取第一个有结果的。
 * 并行是为了不让"某个音源挂掉"拖慢整体响应。
 */
async function searchOnce(env, keywords) {
  const mode = providerMode(env);

  const tasks = [];
  if (mode !== 'apple') {
    for (const base of metingBases(env)) {
      tasks.push({ order: 0, run: () => metingSearch(base, keywords) });
    }
  }
  if (mode !== 'meting') {
    for (const cc of storefronts(env)) {
      tasks.push({ order: 1, run: () => appleSearch(keywords, cc) });
    }
  }

  const settled = await Promise.all(tasks.map(async (task) => {
    try {
      return { order: task.order, songs: await task.run() };
    } catch {
      return { order: task.order, songs: [] };
    }
  }));

  settled.sort((a, b) => a.order - b.order);
  for (const result of settled) {
    if (result.songs.length) return result.songs;
  }
  return [];
}

/** 三级降级：歌名+歌手 → 歌名 → 模糊（不做歌名过滤）。 */
async function searchWithFallback(env, title, artist) {
  const attempts = [];
  if (artist) attempts.push({ keywords: `${title} ${artist}`, filter: true, tier: '歌名+歌手' });
  attempts.push({ keywords: title, filter: true, tier: '歌名' });
  attempts.push({ keywords: title, filter: false, tier: '模糊搜索' });

  for (const attempt of attempts) {
    const songs = await searchOnce(env, attempt.keywords);
    if (!songs.length) continue;
    const filtered = attempt.filter ? songs.filter((s) => matchesTitle(s.name, title)) : songs;
    if (filtered.length) return { tier: attempt.tier, songs: filtered };
  }
  return { tier: null, songs: [] };
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
    return json({ provider: providerMode(env), tier, results: songs });
  } catch {
    return error('音源服务暂时不可用，请稍后再试', 502);
  }
}
