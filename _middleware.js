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

/**
 * "我已经为这个请求跳过一次了"的标记（2026-10-08 加的，用于**彻底杜绝重定向死循环**）。
 *
 * 为什么必须有它：实测发生过 `ERR_TOO_MANY_REDIRECTS`，站点**整个打不开**。
 * 链路是：浏览器 → `vote.yzstu.top` → **阿里云 ESA**（站点前面确实有一层，
 * 响应头里的 `server: ESA` / `eagleid` / `via: ens-cache…` 是它的标志）
 * → 回源到 Cloudflare Pages 时**把 Host 改成了源站主机名** → 中间件看到的主机
 * 既不是 `vote.yzstu.top` 也不在白名单里 → 302 跳到 `vote.yzstu.top`
 * → 又回到 ESA → 又看到源站主机名 → **永远跳不完**。
 *
 * 关键在于：**源站无法分辨"经 ESA 来的正常用户"和"直接访问源站的人"**，
 * 所以只要跳转目标本身也可能被改写，任何基于"看到的主机名"的判断都可能成环。
 * 标记则不受影响 —— 它跟着**跳转目标 URL** 走，不依赖源站看到什么。
 *
 * 作用范围刻意收窄：只在"看到的主机名看着像源站主机（*.pages.dev）"时才加标记，
 * 因为那才是**无法分辨**的情况。正常配置下（ESA 回源 Host 正确）根本不会跳转，
 * 地址栏里也就不会出现这个参数。
 */
const LOOP_MARKER = '__dsh_host';
const LOOP_MARKER_VALUE = 'ok';

/**
 * "这台浏览器已经通过正确域名进来过"的 Cookie。
 *
 * 为什么光有 URL 标记还不够（2026-10-08 实测踩到）：标记只跟着**页面导航**走。
 * 页面打开之后前端会去请求 `/api/config`、`/api/me` —— 那些是 fetch，
 * **不带页面 URL 上的参数**，于是又被判成"域名不认识"，拿到 403。
 * 实测现象就是：页面正常显示、但页面上多出一行红字
 * 「本站只允许通过 vote.yzstu.top 访问（本次请求看到的域名：yczx-musicvote.pages.dev）」。
 *
 * 所以标记放行时要**顺手把状态记在浏览器上**，让后续的 /api/* 也能过。
 *
 * 为什么用 Cookie 而不是别的：
 *   · Cookie 的作用域是**浏览器视角的域名**。跳转目标是 `vote.yzstu.top`，
 *     所以这个 Cookie 属于 `vote.yzstu.top`，**不会发给 `*.pages.dev`** ——
 *     "直接访问源站域名"依然被挡住，需求没有被削弱。
 *   · 不用 Referer：我们自己发的 `_headers` 里有 `Referrer-Policy: no-referrer`，
 *     浏览器根本不会带 Referer，这条路走不通。
 */
const HOST_OK_COOKIE = 'dsh_host_ok';

/** 浏览器是否已经带着"来过正确域名"的 Cookie。 */
function hasHostOkCookie(request) {
  const raw = request.headers.get('cookie') || '';
  return String(raw).split(';').some((p) => p.trim() === `${HOST_OK_COOKIE}=1`);
}

/**
 * 放行的同时，往响应上挂一个"来过正确域名"的 Cookie。
 *
 * 只在**标记放行**这一条路上挂：那一刻浏览器请求的域名（也就是 Cookie 的作用域）
 * 正是我们的跳转目标 `vote.yzstu.top`。而"直接访问源站域名"那条路只会 302，
 * 永远不会在源站域名上挂到这个 Cookie —— 所以那条路依旧被挡。
 */
function withHostOkCookie(response, request) {
  if (hasHostOkCookie(request)) return response;   // 已经有了，不用重复挂
  const out = new Response(response.body, response);
  out.headers.append('Set-Cookie',
    `${HOST_OK_COOKIE}=1; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`);
  return out;
}


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

  /**
   * 这个请求"可能是哪个域名"。**会把所有线索都收集起来**，而不是只信一个。
   *
   * 为什么要收集多个：实测发现站点前面有一层阿里云 ESA，它回源时会把 Host
   * 改写成源站主机名。此时"源站看到的主机名"根本反映不了用户实际访问的是谁，
   * 而 `X-Forwarded-Host` / `X-Original-Host` 这类头往往还留着原始域名。
   */
  const candidates = [];
  const pushHost = (v) => {
    const h = normalizeHost(v);
    if (h && !candidates.includes(h)) candidates.push(h);
  };
  try { pushHost(new URL(request.url).hostname); } catch { /* 拿不到就算了 */ }
  pushHost(request.headers.get('host'));

  /**
   * 代理/网关留下的"原始域名"线索。
   *
   * ⚠️ 这类头**请求方可以自己伪造**。采信它等于允许"自己声明自己是谁"。
   * 之所以还是采信：站点实测就在 ESA 后面，而 ESA 把 Host 改写成了源站主机名 ——
   * 不采信这些头的话，源站**没有任何办法**分辨"经网关来的正常用户"和
   * "直接访问源站的人"，只能二选一：要么整站跳死，要么整站放行。
   * 这个门槛要防的是"学生走错门"，不是"有人蓄意伪造请求头"，
   * 所以做了这个取舍。真要硬挡，应该在 ESA 那一层按真实 Host 拦（它看得见）。
   */
  const forwarded = [];
  for (const name of ['x-forwarded-host', 'x-original-host', 'x-real-host']) {
    const raw = request.headers.get(name);
    if (!raw) continue;
    // 可能是逗号分隔的链，取**最后一个**（离源站最近的那一跳写的）
    const parts = String(raw).split(',');
    const last = normalizeHost(parts[parts.length - 1]);
    if (last && !forwarded.includes(last)) forwarded.push(last);
  }

  // 拿不到任何主机线索：宁可放行也不要把正常流量挡死（这种请求本来也进不来）
  if (!candidates.length && !forwarded.length) return next();

  const all = [...candidates, ...forwarded];
  if (all.some((h) => LOCAL_HOSTS.has(h))) return next();
  if (String((env && env.ALLOW_PREVIEWS) || '').trim() === '1'
      && all.some((h) => isPreviewHost(h))) return next();

  const allowed = allowedHosts(env);
  if (allowed === null) return next();                        // ALLOWED_HOSTS=*：应急开关
  if (allowed.includes(candidates[0])) return next();          // 直接匹配：最可信
  if (forwarded.some((h) => allowed.includes(h))) return next(); // 网关改写 Host，但原始域名是对的

  const target = canonicalHost(env, allowed);

  // 目标域名自己都不在白名单里：跳过去只会被再跳一次 → **必然死循环**。
  // 这种情况下宁可放行 —— 把整站跳死比"少拦一个域名"严重得多。
  if (!allowed.includes(target)) return next();

  // 这次请求是不是"被我们自己跳过一次了"。
  // 是的话**必须放行**，否则就是那个把整站跳死的循环（见 LOOP_MARKER 的说明）。
  let marked = false;
  try { marked = new URL(request.url).searchParams.get(LOOP_MARKER) === LOOP_MARKER_VALUE; }
  catch { /* 拿不到 URL 就当没标记 */ }
  if (marked) return withHostOkCookie(await next(), request);

  // 已经带着"来过正确域名"的 Cookie：放行。
  // 这条是为**页面里后续发出的 fetch**准备的 —— 标记只挂在页面 URL 上，
  // /api/* 请求不带它，只能靠 Cookie 认出来。
  if (hasHostOkCookie(request)) return next();

  if (!isNavigation(request)) {
    // 诊断信息：把**看到的主机名**写进错误里。这个功能第一次上线就让整站打不开，
    // 而原因（"源站到底看到的是哪个主机名"）从外部完全看不出来 ——
    // 所以宁可写进响应，下次一眼就能定位。这里没有敏感信息。
    const seen = all.length ? all.join(' / ') : '(空)';
    return error(`本站只允许通过 ${target} 访问（本次请求看到的域名：${seen}）`, 403);
  }

  // 保留路径与查询串，跳到正确域名。
  // **只有"看到的主机名像源站主机（*.pages.dev）"时才带标记** ——
  // 那正是源站无法分辨、可能成环的情况。正常配置下不会走到这里，
  // 地址栏里也就不会多出任何参数。
  let url;
  try {
    const src = new URL(request.url);
    if (candidates.some(isPreviewHost)) src.searchParams.set(LOOP_MARKER, LOOP_MARKER_VALUE);
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
