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
