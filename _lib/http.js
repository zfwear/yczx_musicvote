/**
 * HTTP 响应 / Cookie / 客户端信息 工具。
 *
 * 所有 JSON 响应都强制带上 no-store 与 nosniff，避免凭证类响应被缓存，
 * 也避免浏览器对响应体做内容嗅探。
 */

export const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

/** 统一的 JSON 响应。 */
export function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

/** 统一的错误响应。 */
export function error(message, status = 400, extraHeaders = {}) {
  return json({ error: message }, status, extraHeaders);
}

/**
 * 带多个 Set-Cookie 的 JSON 响应。
 * 普通对象没法承载同名的多个头（会互相覆盖），所以这里用 Headers.append。
 */
export function jsonWithCookies(body, status, cookies) {
  const headers = new Headers(JSON_HEADERS);
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(JSON.stringify(body), { status, headers });
}

/** 解析 Cookie 头。 */
export function parseCookies(request) {
  const header = request.headers.get('Cookie') || '';
  const out = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    if (!key) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      out[key] = decodeURIComponent(raw);
    } catch {
      out[key] = raw;
    }
  }
  return out;
}

/** 生成 Set-Cookie 头。secure 由调用方按请求协议决定，方便本地 http 调试。 */
export function serializeCookie(name, value, options = {}) {
  const {
    maxAge,
    secure = true,
    httpOnly = true,
    sameSite = 'Lax',
    path = '/',
  } = options;

  let cookie = `${name}=${encodeURIComponent(value)}; Path=${path}; SameSite=${sameSite}`;
  if (httpOnly) cookie += '; HttpOnly';
  if (secure) cookie += '; Secure';
  if (typeof maxAge === 'number') cookie += `; Max-Age=${Math.floor(maxAge)}`;
  return cookie;
}

export function isSecureRequest(request) {
  try {
    return new URL(request.url).protocol === 'https:';
  } catch {
    return true;
  }
}

/**
 * 取客户端 IP。
 * cf-connecting-ip 由 Cloudflare 边缘写入并覆盖客户端伪造值，可以信任；
 * 其余头只在本地测试时作为回退。
 */
export function clientIp(request) {
  const cf = request.headers.get('cf-connecting-ip');
  if (cf) return cf.trim();
  const xff = request.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return 'unknown';
}

/** 限制长度的请求头读取。 */
export function header(request, name, maxLength = 300) {
  return (request.headers.get(name) || '').slice(0, maxLength);
}

/* ---------------------- 限流的身份键 ---------------------- */

/** 把一个任意字符串拍成安全的 bucket 片段（限流表里存的就是这个）。 */
function tokenOf(value, maxLength = 64) {
  return String(value ?? '').replace(/[^\w:.-]/g, '').slice(0, maxLength);
}

/**
 * 「按最强可用身份」限流的键。
 *
 * 为什么不能按 IP（审计 C6 遗留问题，本轮修）：
 *   校园网几百个学生共用同一个出口 IP。按 IP 限流 = 全校共用一份额度 ——
 *   一个人刷，全校被 429。这不是"更安全"，是把可用性让给了攻击者：
 *   他只要把额度打满，正常学生就投不了票。
 *
 * 身份优先级（强 → 弱）：
 *   1. 设备指纹 fingerprint —— 最接近"一个人"，投票/举报已经在用同一套；
 *   2. 设备/客户端的 clientId（localStorage 里的随机串）—— 指纹取不到时的近似；
 *   3. 会话 id —— 每台设备登录后各有一条会话，比 class_id 细；
 *   4. class_id（subject_id）—— 至少把"某个班的会话"和别的班分开；
 *   5. IP —— 最后兜底（连会话都没有的路径才用得上）。
 *
 * 注意：客户端能伪造 fingerprint/clientId，所以这不是防攻击的硬边界 ——
 * 它的作用是**公平**（不让人替全校吃额度）。真正的滥用上限由
 * rateLimitIp() 那道宽松的 IP 兜底 + 各接口自己的去重（设备指纹唯一索引）来守。
 *
 * @param {Request} request
 * @param {{kind?: string, fingerprint?: string, clientId?: string, session?: object}} opts
 */
export function rateKey(request, opts = {}) {
  const kind = tokenOf(opts.kind || 'rl', 24);
  const fingerprint = tokenOf(opts.fingerprint, 64);
  const clientId = tokenOf(opts.clientId, 64);
  const session = opts.session || null;

  if (fingerprint) return `${kind}:fp:${fingerprint}`;
  if (clientId) return `${kind}:cid:${clientId}`;
  if (session && Number.isInteger(Number(session.id)) && Number(session.id) > 0) {
    return `${kind}:sid:${Number(session.id)}`;
  }
  if (session && Number.isInteger(Number(session.subject_id))) {
    return `${kind}:cls:${Number(session.subject_id)}`;
  }
  return `${kind}:ip:${tokenOf(clientIp(request), 45)}`;
}

/** IP 兜底限流的键（宽松、只防"一个出口疯狂刷"）。 */
export function rateIpKey(request, kind) {
  return `${tokenOf(kind || 'rl', 24)}:ip:${tokenOf(clientIp(request), 45)}`;
}

/** 安全地读取 JSON 请求体。 */
export async function readJson(request) {
  const type = request.headers.get('Content-Type') || '';
  if (!type.toLowerCase().includes('application/json')) {
    return { ok: false, error: '请求格式不正确' };
  }
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { ok: false, error: '请求格式不正确' };
    }
    return { ok: true, value: body };
  } catch {
    return { ok: false, error: '请求格式不正确' };
  }
}
