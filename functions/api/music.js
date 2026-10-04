import { error, json, clientIp } from '../../_lib/http.js';
import { requireSession, rateLimit } from '../../_lib/auth.js';
import { sanitizeText } from '../../_lib/validate.js';

/**
 * 第三方音源中转代理。
 *
 * ⚠️ 最重要的安全约束：**客户端永远无法指定上游地址。**
 *    客户端只能传"关键词"或"歌曲 id"，上游地址只从环境变量 MUSIC_API_BASE 读取。
 *    如果允许客户端传 URL，这个接口立刻会变成一个任何人都能用的开放代理 /
 *    SSRF 跳板（可以拿它去打内网、也可以拿它洗流量）。代码里有对应的回归测试。
 *
 * 环境变量：
 *   MUSIC_API_BASE   必填。第三方音乐 API 的根地址，例如 https://music-api.example.com
 *                    未配置时接口返回 503，前端按钮显示"试听暂不可用"，不会崩页。
 *
 * 接口：
 *   GET /api/music?status=1                       查询是否已配置（无需登录，仅返回布尔值）
 *   GET /api/music?q=歌名&artist=歌手              搜索，按 歌名+歌手 → 歌名 → 模糊 三级降级
 *   GET /api/music?play=<id>                      转发音频流，支持 Range（拖动进度条必需）
 *
 * 不同第三方的响应结构差异很大，normalizeSongs() 里兼容了几种常见形态；
 * 如果你的供应商结构不同，只需要改那一个函数。
 */

const UPSTREAM_TIMEOUT_MS = 8000;
const MAX_RESULTS = 8;
const MAX_FIELD_LENGTH = 120;

function clip(value, max = MAX_FIELD_LENGTH) {
  return String(value ?? '').slice(0, max);
}

/** 读取已配置的上游根地址；未配置返回空串。 */
function upstreamBase(env) {
  const raw = env && typeof env.MUSIC_API_BASE === 'string' ? env.MUSIC_API_BASE.trim() : '';
  return raw.replace(/\/+$/, '');
}

async function fetchUpstream(url, options = {}, timeoutMs = UPSTREAM_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'yczx-musicvote/1.0', ...(options.headers || {}) },
    });
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------- 响应归一化 ------------------------- */

function pickArtist(item) {
  if (Array.isArray(item.artists)) {
    return item.artists.map((a) => (a && a.name) || '').filter(Boolean).join('、');
  }
  if (Array.isArray(item.ar)) {
    return item.ar.map((a) => (a && a.name) || '').filter(Boolean).join('、');
  }
  if (item.artist) return String(item.artist);
  if (item.singer) return String(item.singer);
  return '';
}

function normalizeSongs(payload) {
  let list = [];
  if (Array.isArray(payload)) list = payload;
  else if (payload && Array.isArray(payload.data)) list = payload.data;
  else if (payload && payload.result && Array.isArray(payload.result.songs)) list = payload.result.songs;
  else if (payload && Array.isArray(payload.songs)) list = payload.songs;
  else if (payload && Array.isArray(payload.results)) list = payload.results;

  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const id = item.id ?? item.song_id ?? item.songId;
    const name = item.name ?? item.title ?? item.songname;
    if (id === undefined || id === null || !name) continue;

    out.push({
      id: clip(id, 40),
      name: clip(name),
      artist: clip(pickArtist(item)),
      album: clip((item.album && (item.album.name || item.album)) || item.albumName || ''),
      duration: Number(item.duration ?? item.dt ?? item.interval ?? 0) || 0,
      url: typeof item.url === 'string' ? item.url : '',
    });
    if (out.length >= MAX_RESULTS) break;
  }
  return out;
}

/** 歌名宽松匹配：忽略大小写与空白。 */
function matchesTitle(candidate, title) {
  const a = String(candidate || '').toLowerCase().replace(/\s+/g, '');
  const b = String(title || '').toLowerCase().replace(/\s+/g, '');
  if (!b) return true;
  return a.includes(b) || b.includes(a);
}

async function upstreamSearch(base, keywords) {
  const url = `${base}/search?keywords=${encodeURIComponent(keywords)}&limit=${MAX_RESULTS}`;
  let res;
  try {
    res = await fetchUpstream(url);
  } catch {
    return { ok: false };
  }
  if (!res.ok) return { ok: false };
  try {
    return { ok: true, songs: normalizeSongs(await res.json()) };
  } catch {
    return { ok: false };
  }
}

/**
 * 三级降级搜索：解决用户输入不全的问题。
 *   1) 歌名 + 歌手（最精确）
 *   2) 只按歌名
 *   3) 模糊：直接采用上游返回，不再做歌名过滤
 */
async function searchWithFallback(base, title, artist) {
  const attempts = [];
  if (artist) attempts.push({ keywords: `${title} ${artist}`, filter: true, tier: '歌名+歌手' });
  attempts.push({ keywords: title, filter: true, tier: '歌名' });
  attempts.push({ keywords: title, filter: false, tier: '模糊搜索' });

  let lastTier = null;
  for (const attempt of attempts) {
    const result = await upstreamSearch(base, attempt.keywords);
    if (!result.ok) continue;
    lastTier = attempt.tier;
    const songs = attempt.filter
      ? result.songs.filter((s) => matchesTitle(s.name, title))
      : result.songs;
    if (songs.length) return { tier: attempt.tier, songs };
  }
  return { tier: lastTier, songs: [] };
}

/* ------------------------- 音频转发 ------------------------- */

async function resolveAudioUrl(base, playId) {
  const url = `${base}/song/url?id=${encodeURIComponent(playId)}`;
  let res;
  try {
    res = await fetchUpstream(url);
  } catch {
    return null;
  }
  if (!res.ok) return null;

  let payload;
  try {
    payload = await res.json();
  } catch {
    return null;
  }

  const item = Array.isArray(payload && payload.data)
    ? payload.data[0]
    : (payload && payload.data) || payload;
  const direct = item && (item.url || item.src);
  return typeof direct === 'string' && /^https:\/\//i.test(direct) ? direct : null;
}

async function proxyAudio(base, playId, request) {
  const directUrl = await resolveAudioUrl(base, playId);
  if (!directUrl) return error('该歌曲暂时没有可用音源', 404);

  const headers = {};
  const range = request.headers.get('Range');
  if (range) headers.Range = range;

  let upstream;
  try {
    upstream = await fetchUpstream(directUrl, { headers }, 15000);
  } catch {
    return error('音源获取超时，请稍后再试', 504);
  }
  if (!upstream.ok && upstream.status !== 206) return error('音源获取失败', 502);
  if (!upstream.body) return error('音源返回了空内容', 502);

  // 关键：绝不把上游的 Content-Type 原样透传。
  // 否则上游如果返回 text/html，就等于在我们自己的域名下渲染了别人控制的页面，
  // 那就变成了一个"存到我们域名上的 XSS"。这里只允许音频类型。
  const upstreamType = upstream.headers.get('Content-Type') || '';
  if (upstreamType && !/^(audio\/|application\/octet-stream|application\/vnd\.apple\.mpegurl)/i.test(upstreamType)) {
    return error('上游返回的不是音频内容', 502);
  }

  const out = new Headers();
  out.set('Content-Type', /^audio\//i.test(upstreamType) ? upstreamType : 'audio/mpeg');
  out.set('X-Content-Type-Options', 'nosniff');
  out.set('Cache-Control', 'public, max-age=3600');
  out.set('Accept-Ranges', upstream.headers.get('Accept-Ranges') || 'bytes');

  for (const name of ['Content-Length', 'Content-Range', 'ETag', 'Last-Modified']) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }

  return new Response(upstream.body, { status: upstream.status, headers: out });
}

/* ------------------------- 入口 ------------------------- */

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const base = upstreamBase(env);

  // 配置自检：只返回一个布尔值，方便部署后直接浏览器验证，不泄露任何信息。
  if (url.searchParams.get('status') === '1') {
    return json({ configured: Boolean(base) });
  }

  const auth = await requireSession(env, request, 'class');
  if (!auth.ok) return auth.response;

  if (!base) {
    return error('试听功能未配置（缺少 MUSIC_API_BASE 环境变量）', 503);
  }

  const ip = clientIp(request);
  const limit = await rateLimit(env, `music:${ip}`, 120, 3600);
  if (!limit.allowed) return error('试听请求过于频繁，请稍后再试', 429);

  const playId = (url.searchParams.get('play') || '').trim();
  if (playId) {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(playId)) return error('歌曲 id 不正确', 400);
    return proxyAudio(base, playId, request);
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
    const { tier, songs } = await searchWithFallback(base, title.value, artist);
    return json({ tier, results: songs });
  } catch {
    return error('音源服务暂时不可用，请稍后再试', 502);
  }
}
