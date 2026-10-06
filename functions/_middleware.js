import { error } from '../_lib/http.js';

/**
 * 只允许通过**指定域名**访问（用户要求：其他途径断掉）。
 *
 * 为什么需要它：
 *   · 站点同时挂在 `vote.yzstu.top` 与 `xxx.pages.dev` 上，两个地址都能打开。
 *   · 但备案主体、版权行、以及 reCAPTCHA 的**站点密钥域名绑定**都只认
 *     `vote.yzstu.top` —— 学生从 pages.dev 那个地址进来，人机校验一律失败，
 *     还会让人以为"站点坏了"。
 *   · 所以非白名单域名一律挡掉，并尽量把人送到正确的地址上。
 *
 * ⚠️ 光有这个文件**不够**：`_routes.json` 原来是 `include: ["/api/*"]`，
 *    也就是只有 /api/* 才会进 Functions —— HTML 页面根本不经过中间件。
 *    必须同时把 `_routes.json` 改成 `include: ["/*"]`（静态资源用 exclude 放行，
 *    省掉没必要的函数调用）。两处是一对，改一处等于没改。
 *
 * 环境变量：
 *   ALLOWED_HOSTS   逗号分隔的白名单域名。默认 `vote.yzstu.top`。
 *                   设成 `*` 表示**全部放行**（应急开关，等价于关掉这个功能）。
 *   CANONICAL_HOST  重定向的目标域名。默认取白名单里的第一个。
 *   ALLOW_PREVIEWS  设成 `1` 时额外放行 `*.pages.dev`（含预览部署）。
 *                   默认**不放行** —— 但协作时如果想给同事看预览，就设它，
 *                   或者把具体那个预览域名加进 ALLOWED_HOSTS。
 *
 * 两类请求的处理刻意不同：
 *   · **页面导航**（浏览器直接打开）→ 302 跳到正确域名。
 *     硬拒会让人对着一个错误页发呆；送去正确地址既满足"只能从这里访问"，
 *     又不至于让学生以为站点挂了。
 *   · **其它请求**（fetch / XHR 打 API）→ 403 JSON。
 *     302 对 POST 会被浏览器改成 GET 重发，语义就变了；而且从别的源
 *     调 API 本来就该拒。
 *
 * 本机开发不受影响：`localhost` / `127.0.0.1` 永远放行（wrangler pages dev 用得上）。
 */

/** 默认白名单：生产只认这一个域名。 */
const DEFAULT_ALLOWED = ['vote.yzstu.top'];

/** 本机开发地址，永远放行 —— 否则本地起 wrangler 就全被挡了。 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** 去掉端口号，统一小写。`vote.yzstu.top:443` / `VOTE.YZSTU.TOP` 都要能匹配。 */
function normalizeHost(raw) {
  let host = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!host) return '';
  // IPv6 形如 [::1]:8788
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end > 0 ? host.slice(0, end + 1) : host;
  }
  const colon = host.lastIndexOf(':');
  return colon > 0 ? host.slice(0, colon) : host;
}

/**
 * 读白名单。
 * 返回 `null` 表示"全部放行"（应急开关）。
 */
function allowedHosts(env) {
  const raw = String((env && env.ALLOWED_HOSTS) || '').trim();
  if (raw === '*') return null;
  const list = (raw || DEFAULT_ALLOWED.join(','))
    .split(',')
    .map((s) => normalizeHost(s))
    .filter(Boolean);
  return list.length ? list : DEFAULT_ALLOWED.slice();
}

/** 重定向目标：CANONICAL_HOST 优先，否则白名单第一个。 */
function canonicalHost(env, allowed) {
  const raw = normalizeHost((env && env.CANONICAL_HOST) || '');
  if (raw) return raw;
  return allowed && allowed.length ? allowed[0] : DEFAULT_ALLOWED[0];
}

/** 预览域名（`*.pages.dev`，含 `<hash>.<project>.pages.dev`）。 */
function isPreviewHost(host) {
  return host === 'pages.dev' || host.endsWith('.pages.dev');
}

/** 这次请求是不是"浏览器在导航"（决定重定向还是 403）。 */
function isNavigation(request) {
  const dest = request.headers.get('sec-fetch-dest');
  if (dest) return dest === 'document';
  const mode = request.headers.get('sec-fetch-mode');
  if (mode) return mode === 'navigate';
  // 老浏览器没有 sec-fetch-*：退回看 Accept。
  return String(request.headers.get('accept') || '').includes('text/html');
}

export async function onRequest(context) {
  const { request, env, next } = context;

  let host = '';
  try {
    host = normalizeHost(new URL(request.url).hostname);
  } catch { /* 拿不到就当空 */ }
  if (!host) host = normalizeHost(request.headers.get('host'));

  // 拿不到 Host：宁可放行也不要把正常流量挡死（这种请求本来也进不来）
  if (!host) return next();

  if (LOCAL_HOSTS.has(host)) return next();
  if (String((env && env.ALLOW_PREVIEWS) || '').trim() === '1' && isPreviewHost(host)) return next();

  const allowed = allowedHosts(env);
  if (allowed === null) return next();                       // ALLOWED_HOSTS=*
  if (allowed.includes(host)) return next();

  const target = canonicalHost(env, allowed);

  if (!isNavigation(request)) {
    return error(`本站只允许通过 ${target} 访问`, 403);
  }

  // 保留路径与查询串，跳到正确域名
  let url;
  try {
    const src = new URL(request.url);
    url = `https://${target}${src.pathname}${src.search}`;
  } catch {
    url = `https://${target}/`;
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: url,
      // 别让中间层的缓存把这个跳转钉住
      'Cache-Control': 'no-store',
    },
  });
}
