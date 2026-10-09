import { error } from '../_lib/http.js';
import { hmacHex } from '../_lib/crypto.js';
import { DEFAULT_PEPPER } from '../_lib/auth.js';
import { resolveRootPage } from '../_lib/rootpage.js';

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
 * 防重定向死循环的 URL 标记 + "来过正确域名"的 Cookie。
 *
 * ## 为什么需要它们（2026-10-08 线上事故）
 * 实测发生过 `ERR_TOO_MANY_REDIRECTS`，站点**整个打不开**。链路是：
 * 浏览器 → `vote.yzstu.top` → **阿里云 ESA**（`server: ESA` / `eagleid` /
 * `via: ens-cache…` 是它的标志）→ 回源 Cloudflare Pages 时**把 Host 改写成
 * 源站主机名** → 中间件看到的主机既不是 `vote.yzstu.top` 也不在白名单里
 * → 302 跳到 `vote.yzstu.top` → 又回 ESA → 又被改写 → **永远跳不完**。
 *
 * 关键：**源站分不清"经网关来的正常用户"和"直接访问源站的人"**，
 * 所以任何只看"看到的主机名"的逻辑都可能成环。标记跟着**跳转目标 URL** 走，
 * 不受源站看到什么影响，所以能一跳终止。
 * Cookie 则是给页面里后续的 `fetch` 用的（标记只在页面 URL 上，
 * `/api/*` 不带它 —— 这就是"页面能开、接口全 403、页面上多一行红字"的原因）。
 *
 * ## ⚠️ 必须签名，而且必须说清它**不是**安全边界
 * 第一版把标记写成固定字符串 `?__dsh_host=ok`、Cookie 写成 `=1`，
 * 结果是**任何人手打这四个字符就能整条绕过白名单**，并在源站域名上留住
 * 一个 7 天的 Cookie。审计当场指出：注释里"直接访问源站域名永远不会挂到
 * 这个 Cookie"这句话是**假的**（测试恰好没带标记参数，所以还是绿的）。
 * 现在两者都是 **HMAC 签名值**，凭空构造不出来。
 *
 * 但仍要如实说明它的**残留弱点**（不要把它当安全边界用）：
 *   签名值是**会发出去的** —— 任何未登录的人请求一次非白名单域名，
 *   都会从 302 的 `Location` 里拿到一个合法签名，然后可以在该域名上重放。
 *   这是"既要能跳转、又要在被改写 Host 的网关后面活下来"的固有代价。
 *   真的要挡住 `*.pages.dev` 这条路，**必须在网关/边缘那一层按真实 Host 拦**
 *   （ESA 看得见真实 Host；或者干脆不把源站域名暴露出去）。
 */
const LOOP_MARKER = '__dsh_host';
const HOST_OK_COOKIE = 'dsh_host_ok';

/** 签名用的密钥：优先 AUTH_PEPPER，没配就用公开占位值。 */
function markerPepper(env) {
  const configured = env && typeof env.AUTH_PEPPER === 'string' ? env.AUTH_PEPPER.trim() : '';
  return configured || DEFAULT_PEPPER;
}

/** 与 canonical host 绑定的签名值（截断到 16 字符就够防手打）。 */
async function hostMarkerFor(env, target) {
  return (await hmacHex(markerPepper(env), `dsh-host-ok:${target}`)).slice(0, 16);
}

/** 常量时间比较两份十六进制签名（避免用 `===` 泄露前缀匹配长度）。 */
function sameSignature(a, b) {
  const x = String(a == null ? '' : a);
  const y = String(b == null ? '' : b);
  if (x.length !== y.length || x.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/** 请求 URL 上是不是带着**本服务器签发的**标记。 */
async function hasValidMarker(request, env, target) {
  let value;
  try {
    value = new URL(request.url).searchParams.get(LOOP_MARKER);
  } catch {
    return false;
  }
  if (!value) return false;
  return sameSignature(value, await hostMarkerFor(env, target));
}

/** 浏览器是不是带着**本服务器签发的**"来过正确域名"Cookie。 */
async function hasHostOkCookie(request, env, target) {
  const raw = request.headers.get('cookie') || '';
  const want = await hostMarkerFor(env, target);
  return String(raw).split(';').some((p) => {
    const t = p.trim();
    if (!t.startsWith(`${HOST_OK_COOKIE}=`)) return false;
    return sameSignature(t.slice(HOST_OK_COOKIE.length + 1), want);
  });
}

/**
 * 放行的同时，往响应上挂一个签名过的"来过正确域名" Cookie。
 *
 * 只在**标记校验通过**这条路上挂：那一刻浏览器请求的域名（也就是 Cookie 的作用域）
 * 正是我们的跳转目标。而"直接访问源站域名"那条路只会拿到 302，
 * 不会在源站域名上留下这个 Cookie。
 */
async function withHostOkCookie(response, request, env, target) {
  if (await hasHostOkCookie(request, env, target)) return response;   // 已经有了
  const out = new Response(response.body, response);
  out.headers.append('Set-Cookie',
    `${HOST_OK_COOKIE}=${await hostMarkerFor(env, target)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`);
  return out;
}


/** 去掉端口号，统一小写。`vote.yzstu.top:443` / `VOTE.YZSTU.TOP` 都要能匹配。 */
function normalizeHost(raw) {
  let host = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!host) return '';
  // 尾点：`vote.yzstu.top.` 是合法的 FQDN 写法，与不带点是同一个主机。
  // 不剥掉的话白名单匹配会失败 —— 白多一跳 302；而 `xxx.pages.dev.` 更糟：
  // `isPreviewHost` 认不出来，历史上那正是重定向死循环的入口之一。
  if (host.endsWith('.') && !host.endsWith(']')) host = host.slice(0, -1);
  // IPv6 形如 [::1]:8788
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end > 0 ? host.slice(0, end + 1) : host;
  }
  // 不带方括号的 IPv6（`::1`、`2001:db8::1`）：冒号不止一个，**不能**按"端口"截断。
  // 原来一律走 lastIndexOf(':')，于是 `::1` 被切成 `:` ——
  // `LOCAL_HOSTS` 里的 `'::1'` 永远匹配不上，本机调试会被莫名 302 走。
  if ((host.match(/:/g) || []).length > 1) return host;
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

/**
 * 重定向目标：CANONICAL_HOST 优先，否则白名单第一个。
 *
 * ⚠️ 配置的 CANONICAL_HOST **必须自己也在白名单里**才采用（2026-10-08 修）。
 * 原来无条件采用它，于是 `CANONICAL_HOST=https://vote.yzstu.top` 这种
 * 很自然的写法会被 normalizeHost 截成 `https` —— 目标成了 `https`，
 * 而它不在白名单里，下一段的降级逻辑就把**整道闸关掉了**（一个都不拦）。
 * 现在配错就退回白名单第一个，降级逻辑只作为最后一道兜底。
 */
function canonicalHost(env, allowed) {
  const raw = normalizeHost((env && env.CANONICAL_HOST) || '');
  const list = allowed && allowed.length ? allowed : DEFAULT_ALLOWED;
  if (raw && list.includes(raw)) return raw;
  return list[0];
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

/**
 * 对外入口。
 *
 * 结构：hostGate 只负责"这个域名放不放行"，放行的方式是调用 next()。
 * 这里把一个**包了一层**的 next 传进去 —— 命中根路径导航请求时，
 * 先按会话把 `/` 分发成应用主页或发布页（见 _lib/rootpage.js），
 * 没命中才落到平台默认的静态命中。
 *
 * 为什么做成包 next 而不是在 hostGate 里到处插：hostGate 有**七个**放行出口
 * （本机、预览、白名单直配、转发头、签名标记、Host-OK Cookie、应急开关），
 * 逐个插等于同一逻辑抄七遍，漏一个就是"有的入口有发布页、有的入口没有"。
 * 包在 next 上，所有出口天然共用。
 *
 * env.ASSETS 只有 Cloudflare Pages 给；自建 server.mjs 没有这个绑定，
 * 会走到 fallback（context.next()），由 server.mjs 自己的同一段逻辑分发 ——
 * 判定模块是同一份（resolveRootPage），两边结论必然一致。
 */
export async function onRequest(context) {
  const { request, env, next } = context;

  const nextWithRootRouting = async () => {
    let path = '';
    try { path = new URL(request.url).pathname; } catch { /* 拿不到就按普通路径走 */ }
    if ((path === '/' || path === '/index.html')
        && request.method === 'GET'
        && isNavigation(request)
        && env && env.ASSETS) {
      const page = await resolveRootPage(env, request);
      try {
        return await env.ASSETS.fetch(new URL(page === 'app' ? '/index.html' : '/landing.html', request.url));
      } catch {
        // ASSETS 意外不可用：退回默认静态命中，总比 500 好
      }
    }
    return next();
  };

  return hostGate({ ...context, next: nextWithRootRouting });
}

async function hostGate(context) {
  const { request, env, next } = context;

  /**
   * `/api/health` 例外：**从任何域名都必须能访问**。
   *
   * 为什么单开这个口子（2026-10-08 的教训，不是随手加的）：
   *   那天站点报 HTTP 525 —— **ESA 回源到 Cloudflare 的 TLS 握手失败**。
   *   而"源站到底还活着吗"这件事当时**没法直接问**：
   *   直接访问源站域名 `yczx-musicvote.pages.dev/api/health` 被这道闸挡成 403，
   *   只能从 403 的正文里反推"源站是活的"。绕了一圈。
   *
   *   健康检查的内容只有版本号、时间、以及"源站看到的主机名"——
   *   **不含任何数据、任何密钥**。放开它不会泄露什么，
   *   却能让"源站活着吗 / 卡在哪一层"变成**一条 curl 就能回答**的问题。
   *
   * 注意：只放开**这一个路径**。页面与其它接口仍然按白名单挡。
   */
  let earlyPath = '';
  try { earlyPath = new URL(request.url).pathname; } catch { /* 拿不到就算了 */ }
  if (earlyPath === '/api/health' || earlyPath === '/api/health/') return next();

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
  // ⚠️ "本机 / 预览域名"这两条**只按 candidates 判**（2026-10-08 修）。
  //    原来判的是 `all`（合并了转发头），于是
  //    `curl -H 'X-Forwarded-Host: localhost'` 就能免掉整道白名单 ——
  //    连白名单是什么都不用知道。转发头是请求方可控的，不能拿来授予"本机特权"。
  if (candidates.some((h) => LOCAL_HOSTS.has(h))) return next();
  if (String((env && env.ALLOW_PREVIEWS) || '').trim() === '1'
      && candidates.some((h) => isPreviewHost(h))) return next();

  const allowed = allowedHosts(env);
  if (allowed === null) return next();                        // ALLOWED_HOSTS=*：应急开关
  if (allowed.includes(candidates[0])) return next();          // 直接匹配：最可信
  if (forwarded.some((h) => allowed.includes(h))) return next(); // 网关改写 Host，但原始域名是对的

  const target = canonicalHost(env, allowed);

  // 目标域名自己都不在白名单里：跳过去只会被再跳一次 → **必然死循环**。
  //
  // 2026-10-08 修：这里原来对**所有**请求 `return next()`（整道闸静默关闭，
  // 连 API 的 403 都没了）。审计指出：`CANONICAL_HOST` 写成
  // `https://vote.yzstu.top` 这种很自然的写法就会被 normalizeHost 截成 `https`，
  // 于是"一个都不拦"。现在降级**只对页面导航**生效 ——
  // 宁可让人看到页面（不至于对着错误页发呆），但接口仍然照拦。
  if (!allowed.includes(target)) {
    if (isNavigation(request)) return next();
    const seenBad = all.length ? all.join(' / ') : '(空)';
    return error(`本站只允许通过 ${allowed.join(' / ')} 访问（本次请求看到的域名：${seenBad}）`, 403);
  }

  // 这次请求是不是"被我们自己跳过一次了"（签名校验，见 LOOP_MARKER 的说明）。
  // 是的话**必须放行**，否则就是那个把整站跳死的循环。
  if (await hasValidMarker(request, env, target)) {
    return withHostOkCookie(await next(), request, env, target);
  }

  // 已经带着"来过正确域名"的 Cookie：放行。
  // 这条是为**页面里后续发出的 fetch**准备的 —— 标记只挂在页面 URL 上，
  // `/api/*` 请求不带它，只能靠 Cookie 认出来。
  if (await hasHostOkCookie(request, env, target)) return next();

  if (!isNavigation(request)) {
    // 诊断信息：把**看到的主机名**写进错误里。这个功能第一次上线就让整站打不开，
    // 而原因（"源站到底看到的是哪个主机名"）从外部完全看不出来 ——
    // 所以宁可写进响应，下次一眼就能定位。这里没有敏感信息。
    const seen = all.length ? all.join(' / ') : '(空)';
    return error(`本站只允许通过 ${target} 访问（本次请求看到的域名：${seen}）`, 403);
  }

  // 保留路径与查询串，跳到正确域名，**并且一定带上签名标记**。
  //
  // 2026-10-08 修：原来只在"看到的主机名像 `*.pages.dev`"时才带标记。
  // 审计指出那是个隐患：只要网关改写成**别的**名字（自有 VPS 上
  // `proxy_set_header Host <内网名>`、CDN 回源 Host 配错），
  // "302 不带标记 → 又被改写 → 再 302"就会永远循环 —— 与线上事故一模一样。
  // 现在无条件带标记：任何被改写 Host 的部署都能一跳终止。
  let url;
  try {
    const src = new URL(request.url);
    src.searchParams.set(LOOP_MARKER, await hostMarkerFor(env, target));
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
