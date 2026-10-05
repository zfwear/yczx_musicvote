/**
 * 选曲凭据（审计遗留问题 A7：音源一致性）。
 *
 * 问题是什么：
 *   /api/music 的搜索结果里，每个候选都带一个音源 id（ap-xxx / mt-xxx）。
 *   前端把"歌名 + 歌手 + 音源 id"一起提交给 /api/vote，但服务端**分别**
 *   校验这三个字段的格式，从来没有验证过"这三者是同一首歌"。
 *   于是手工构造一个请求，就能让库里出现「歌名是 A、音源 id 指向 B」
 *   的记录 —— 榜上显示 A，点试听播出来的却是 B。
 *
 * 怎么解决：
 *   搜索接口在返回候选的同时，为每个候选签一张**短期凭据**：
 *       v1.<base64url(payload)>.<base64url(HMAC-SHA256)>
 *   payload 里就带着这一首的歌名/歌手/音源 id 与过期时间。
 *   提交点歌时带上这张凭据，服务端校验签名与有效期之后，
 *   **以凭据里的内容为准** —— 歌名、歌手、音源 id 三者必然属于同一首，
 *   客户端无法把它们拆开重组。
 *
 * 密钥来自哪里：
 *   优先 environment variable `TRACK_TOKEN_SECRET`；没配就退回 `AUTH_PEPPER`
 *   （与班级口令查找索引、可查看密文同一个私钥）。
 *   不额外要求新环境变量，是为了不改动部署配置也能生效。
 *
 * 这是不是一条安全边界？
 *   **单靠它不算。** 如果部署方没配 AUTH_PEPPER，退回的是源码里的公开默认值，
 *   任何人都能自己签一张凭据。所以它的定位是"完整性校验"：
 *   它把"三者必须同源"变成服务端可验证的事实，而不是把安全性押在签名上。
 *   真正的安全防线仍然是入库前的 sanitizeText / 违禁词 / 会话校验，
 *   这些在 vote.js 里对凭据内容**照常重新执行一遍**。
 *
 * 有效期：
 *   2 小时。与调试模式会话同样长 —— 学生可能搜完歌、听几个候选、
 *   想一会儿再提交。凭据过期会被明确拒绝（不做静默降级），
 *   所以不能定得太短，否则正常用户会被误伤。
 */

import { authPepper } from './auth.js';
import { sanitizeText, parseTrackId } from './validate.js';

export const TRACK_TOKEN_TTL_SECONDS = 2 * 60 * 60;

/** 凭据版本前缀。将来换格式时靠它区分，不必改函数名。 */
const VERSION = 'v1';

/** 一张凭据最多这么长；超过直接判非法，避免拿超长串做无谓的 HMAC。 */
const MAX_TOKEN_LENGTH = 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToB64url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToBytes(str) {
  const normalized = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** 长度恒定的比较，避免按字节提前返回泄露签名信息（与 crypto.js 同一手法）。 */
function timingSafeEqualBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * 签名密钥。专用变量优先，否则复用 AUTH_PEPPER。
 *
 * 单独留一个 TRACK_TOKEN_SECRET 的意义：万一以后要换 AUTH_PEPPER
 * （换它会让已有班级口令全部失效），选曲凭据的密钥可以独立轮换。
 */
function secretFor(env) {
  const dedicated = env && typeof env.TRACK_TOKEN_SECRET === 'string'
    ? env.TRACK_TOKEN_SECRET.trim()
    : '';
  return dedicated || authPepper(env);
}

/**
 * CryptoKey 缓存。
 *
 * 为什么值得缓存：一次搜索最多 8 个候选，逐个 importKey 纯属浪费 ——
 * 免费套餐单次请求只有 10ms CPU（见 _lib/crypto.js 的说明），
 * 一点点开销都要省。缓存键就是密钥本身（它本来就在这个 isolate 的内存里），
 * 同一部署下最多一条记录。
 */
const keyCache = new Map();

function hmacKey(secret) {
  let cached = keyCache.get(secret);
  if (!cached) {
    cached = crypto.subtle.importKey(
      'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    keyCache.set(secret, cached);
  }
  return cached;
}

async function hmacBytes(secret, message) {
  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return new Uint8Array(signature);
}

/**
 * 为一首候选歌签一张选曲凭据。
 *
 * 歌名/歌手/音源 id 先按"入库标准"收敛一遍：收敛不过去的候选**不发凭据**
 * （返回 null），前端拿不到凭据就走老流程，不会因此报错。
 * 这样凭据里的内容天然就是可入库的内容，vote.js 不必再为它做额外清洗。
 *
 * @returns {Promise<string|null>} 凭据；该候选不适合签名时返回 null。
 */
export async function signTrackToken(env, { title, artist, trackId, now = Date.now() } = {}) {
  const cleanTitle = sanitizeText(title, { maxLength: 60, field: '歌名' });
  const cleanArtist = sanitizeText(artist, { maxLength: 60, field: '歌手' });
  const cleanTrack = parseTrackId(trackId);

  if (!cleanTitle.ok || !cleanArtist.ok || !cleanTrack.ok || !cleanTrack.value) return null;

  const payload = JSON.stringify({
    t: cleanTitle.value,
    a: cleanArtist.value,
    k: cleanTrack.value,
    e: Math.floor(now / 1000) + TRACK_TOKEN_TTL_SECONDS,
  });

  const body = `${VERSION}.${bytesToB64url(encoder.encode(payload))}`;
  const signature = bytesToB64url(await hmacBytes(secretFor(env), body));
  return `${body}.${signature}`;
}

/**
 * 校验一张选曲凭据。
 *
 * 失败时返回**具体原因**："格式不对"和"过期了"对用户的意义不同，
 * 而且 A7 明确要求凭据无效时明确报错、不许静默降级回"按字段各自校验"的老路。
 *
 * @returns {Promise<{ok: true, value: {title: string, artist: string, trackId: string}}
 *                  | {ok: false, error: string}>}
 */
export async function verifyTrackToken(env, token, { now = Date.now() } = {}) {
  const bad = (error) => ({ ok: false, error });

  if (typeof token !== 'string') return bad('选曲凭据不正确，请重新搜索并选一首再提交');
  const value = token.trim();
  if (!value || value.length > MAX_TOKEN_LENGTH) {
    return bad('选曲凭据不正确，请重新搜索并选一首再提交');
  }

  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) {
    return bad('选曲凭据格式不正确，请重新搜索并选一首再提交');
  }

  let presented;
  try {
    presented = b64urlToBytes(parts[2]);
  } catch {
    return bad('选曲凭据格式不正确，请重新搜索并选一首再提交');
  }

  // 先验签，再解析内容 —— 顺序很重要：未经验证的内容一个字节都不该被信任。
  const expected = await hmacBytes(secretFor(env), `${parts[0]}.${parts[1]}`);
  if (!timingSafeEqualBytes(presented, expected)) {
    return bad('选曲凭据校验失败，请重新搜索并选一首再提交');
  }

  let payload;
  try {
    payload = JSON.parse(decoder.decode(b64urlToBytes(parts[1])));
  } catch {
    return bad('选曲凭据内容已损坏，请重新搜索并选一首再提交');
  }
  if (!payload || typeof payload !== 'object') {
    return bad('选曲凭据内容已损坏，请重新搜索并选一首再提交');
  }

  const expiresAt = Number(payload.e);
  if (!Number.isFinite(expiresAt)) {
    return bad('选曲凭据内容已损坏，请重新搜索并选一首再提交');
  }
  if (expiresAt * 1000 <= now) {
    return bad('选曲凭据已过期，请重新搜索并选一首再提交');
  }

  // 签名通过不代表内容一定可用：内容里可能有控制字符、超长字段或非法音源 id
  // （例如部署方用了公开的默认密钥，别人自己签了一张）。所以照常收敛一遍。
  const cleanTitle = sanitizeText(payload.t, { maxLength: 60, field: '歌名' });
  const cleanArtist = sanitizeText(payload.a, { maxLength: 60, field: '歌手' });
  const cleanTrack = parseTrackId(payload.k);
  if (!cleanTitle.ok || !cleanArtist.ok || !cleanTrack.ok || !cleanTrack.value) {
    return bad('选曲凭据内容不合法，请重新搜索并选一首再提交');
  }

  return {
    ok: true,
    value: {
      title: cleanTitle.value,
      artist: cleanArtist.value,
      trackId: cleanTrack.value,
    },
  };
}

/** 导出给测试使用。 */
export const __internals = { bytesToB64url, b64urlToBytes, secretFor };
