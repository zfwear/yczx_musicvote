/**
 * 自有服务器入口：把 Pages Functions 的处理器原样跑在普通 Node 上。
 *
 * 这一层与 `_lib/sqlite-driver.js` 是一对，合起来构成「迁移到自有服务器」的全部接口：
 *   · 数据库：D1 形状的壳（处理器一行不动）
 *   · 运行时：本文件（`(req,res)` ↔ `onRequest(context)`）
 * 两者都做到位之后，`node server.mjs` 就能在本机/VPS 上跑起整套站点。
 *
 * 它**不引入任何依赖**（Node 24 自带 `node:sqlite`、`fetch`、`Headers`、`Request`、`Response`），
 * 因为依赖越多，搬机器时越容易卡在装不上。
 *
 * 用法：
 *   node server.mjs                     # 默认 8788 端口、数据库 ./data/yczx.db
 *   PORT=9000 DB_FILE=./x.db node server.mjs
 *   node server.mjs --init              # 顺带把 sql/*.sql 全部执行一遍（首次部署用）
 *
 * 环境变量（支持同目录的 `.env` 文件，格式 KEY=VALUE，`#` 开头为注释）：
 *   PORT        监听端口，默认 8788
 *   DB_FILE     SQLite 文件路径，默认 ./data/yczx.db；`:memory:` 表示不落盘
 *   SITE_ROOT   静态文件根。默认使用仓库根，可用环境变量覆盖
 *   （其余同名环境变量原样透传给处理器，例如 AUTH_PEPPER / RECAPTCHA_SECRET /
 *     POW_ENABLED / ALLOWED_HOSTS … 与 Cloudflare 上的名字完全一致）
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSqliteD1 } from './_lib/sqlite-driver.js';
import { resolveRootPage } from './_lib/rootpage.js';

/**
 * Pages Functions 的中间件：域名白名单。
 * 与 Cloudflare 上跑的是**同一份文件**——两条部署路径共用一份策略，
 * 否则迟早分叉成"线上挡、VPS 上不挡"。
 *
 * 这里用 `import.meta.url` 而不是下面那个 `HERE` 常量：`HERE` 在文件更下方才声明，
 * 在它之前引用会踩 TDZ（实测：`Cannot access 'HERE' before initialization`，
 * 而报错位置看起来像"路径拼错了"，很容易往错的方向查）。
 */
const MIDDLEWARE = await import(new URL('./functions/_middleware.js', import.meta.url).href);

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ---------------- .env ---------------- */

/** 极简 .env 解析：不引依赖，够用即可。已存在的进程环境变量优先（部署时更好覆盖）。 */
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // 去掉成对的引号
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const dotenv = loadDotEnv(path.join(HERE, '.env'));
const envOf = (name, dflt) => {
  const v = process.env[name] !== undefined ? process.env[name] : dotenv[name];
  return v === undefined || v === '' ? dflt : v;
};

// systemd credentials are exposed as protected file paths; handlers need the secret value.
const configuredPepper = envOf('AUTH_PEPPER', '');
const credentialPepperPath = path.join(process.env.CREDENTIALS_DIRECTORY || '', 'auth-pepper');
const pepperPath = fs.existsSync(configuredPepper)
  ? configuredPepper
  : fs.existsSync(credentialPepperPath) ? credentialPepperPath : '';
const AUTH_PEPPER = pepperPath
  ? fs.readFileSync(pepperPath, 'utf8').trim()
  : configuredPepper;

/* ---------------- 静态文件 ---------------- */

/** 静态文件默认与项目根一致；SITE_ROOT 仅用于自定义部署目录。 */
function pickSiteRoot() {
  const explicit = envOf('SITE_ROOT', '');
  return explicit ? path.resolve(HERE, explicit) : HERE;
}

const SITE_ROOT = pickSiteRoot();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

/**
 * 把 URL 映射到磁盘文件，并**挡住目录穿越**。
 * 返回 null 表示"不该由静态服务处理"。
 */
function resolveStatic(urlPath) {
  // `decodeURIComponent` 对 `%zz` / `%` 这类非法序列会抛 URIError。
  // 它是**远程可控**的（客户端随便就能发一个 `/%zz`），而这里在
  // 请求处理函数里、没有任何 try —— 抛出去就是未处理的 Promise rejection，
  // Node 15+ 默认直接**结束进程**。一个普通 GET 就能把服务打挂。
  let rel;
  try {
    rel = decodeURIComponent(String(urlPath).split('?')[0]);
  } catch {
    return null;                       // 解不开就当"不该由静态服务处理" → 404
  }
  // NUL 以及其它控制字符：path 相关 API 对它们会抛 ERR_INVALID_ARG_VALUE
  if (/[\u0000-\u001f]/.test(rel)) return null;
  if (rel.endsWith('/')) rel += 'index.html';

  /**
   * 敏感文件黑名单（2026-10-08 补，审计指出）。
   *
   * 静态根默认是仓库根，因此必须阻止后端目录和运行时文件被静态暴露。
   * 那一刻静态服务就对着**整个仓库**：`GET /.env` 会把 `AUTH_PEPPER`、
   * `RECAPTCHA_SECRET` 原样发出去，`/data/yczx.db` 能把整库下载走。
   * `resolveStatic` 只检查"是否落在静态根之内"，对这类文件毫无防备。
   *
   * 这里按**路径段**判断，所以 `sub/.env`、`data/x.db` 也挡得住。
   */
  const SENSITIVE_DIRS = new Set(['sql', '_lib', 'functions', 'data', 'node_modules', '.git']);
  const parts = rel.split('/').filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    if (seg.startsWith('.')) return null;                       // .env / .git / .gitignore …
    if (SENSITIVE_DIRS.has(seg)) return null;                   // sql/ _lib/ functions/ data/ …
    if (/\.(db|sqlite|sqlite3|db-wal|db-shm)$/i.test(seg)) return null;
    if (i === parts.length - 1 && /^(server\.mjs|_headers|_routes\.json)$/.test(seg)) return null;
  }

  const full = path.resolve(SITE_ROOT, '.' + rel);
  // 必须仍在静态根之内 —— `..` 拼出来的路径一律拒绝
  if (full !== SITE_ROOT && !full.startsWith(SITE_ROOT + path.sep)) return null;
  // 用一次 statSync（包 try）代替 existsSync + statSync：
  // 后者在"存在但读不了"（EACCES）或两个调用之间被删掉时会抛，
  // 同样会变成未处理异常。
  try {
    if (!fs.statSync(full).isFile()) return null;
  } catch {
    return null;
  }
  return full;
}

/* ---------------- _headers（CSP 等安全头） ---------------- */

/**
 * 读 `_headers` 并解析成规则列表。
 *
 * 为什么要在这里也实现一遍：那份 `_headers` 是**Cloudflare Pages 专有**的配置文件，
 * Node 服务器不认它。不实现的话，搬到 VPS 上会**静默丢掉整个 CSP**——
 * 页面照样打开，只是 XSS 防线没了，没有任何报错。
 *
 * 只支持本项目实际用到的两种写法：
 *   `/*`      → 所有路径
 *   `/abc`    → 精确路径；`/abc/*` → 前缀
 */
function loadHeaderRules() {
  const candidates = [path.join(SITE_ROOT, '_headers'), path.join(HERE, '_headers')];
  const file = candidates.find((f) => fs.existsSync(f));
  if (!file) return [];
  const rules = [];
  let current = null;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trimEnd();       // 注释
    if (!line.trim()) continue;
    if (!/^\s/.test(line)) {                              // 顶格 = 路径
      current = { pattern: line.trim(), headers: {} };
      current.regex = patternToRegExp(current.pattern);   // 预先编译（见下面的说明）
      rules.push(current);
      continue;
    }
    const m = /^\s+([A-Za-z0-9-]+):\s*(.+)$/.exec(line);   // 缩进 = 头
    if (m && current) current.headers[m[1]] = m[2].trim();
  }
  return rules;
}

const HEADER_RULES = loadHeaderRules();

/**
 * 把 `_headers` 的路径模式编译成正则。
 *
 * 2026-10-08 修：原来只认三种写法 —— `/*`、精确相等、以及 `前缀/*`
 * （`endsWith('/*') ? startsWith(...)`）。于是 `_headers` 里那条
 * `/assets/*.png` **永远匹配不上**（它既不是 `/*`、也不以 `/*` 结尾），
 * 声明了 7 天图片缓存却从来没生效过，而这件事**不会报任何错**。
 * 现在支持 `*` 出现在任意位置（`*` 按 Pages 的语义跨 `/` 匹配）。
 */
function patternToRegExp(pattern) {
  const src = String(pattern)
    .split('*')
    .map((part) => part.replace(/[\\^$+.()|[\]{}?]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${src}$`);
}

/** 把匹配到的站点级响应头并进去（**不覆盖**处理器自己设的头）。 */
function withSiteHeaders(headers, pathname) {
  // ⚠️ 键比较必须**忽略大小写**（2026-10-08 修）：处理器用 `Headers` 设的是小写键
  // （`x-content-type-options`），而 `_headers` 里写的是 `X-Content-Type-Options`
  // —— 用 `headers[k] === undefined` 判重永远为真，于是同一个头会被下发两次
  // （大小写不同的两条）。值一样时浏览器看不出问题，但只要哪天处理器设了
  // **不同值**的 CSP/X-Frame-Options，就会下发两条互相冲突的头。
  const seen = new Set(Object.keys(headers).map((k) => k.toLowerCase()));
  for (const rule of HEADER_RULES) {
    if (!rule.regex.test(pathname)) continue;
    for (const [k, v] of Object.entries(rule.headers)) {
      const lower = k.toLowerCase();
      if (seen.has(lower)) continue;
      headers[k] = v;
      seen.add(lower);
    }
  }
  return headers;
}

/* ---------------- 处理器加载 ---------------- */

/** 按路径找处理器；找不到返回 null（交给静态服务）。 */
const HANDLER_CACHE = new Map();
async function loadHandler(apiPath) {
  if (HANDLER_CACHE.has(apiPath)) return HANDLER_CACHE.get(apiPath);
  const file = path.join(HERE, 'functions', 'api', `${apiPath}.js`);
  // 只认 [a-z0-9-] 的名字，杜绝 `../` 之类的路径注入
  let mod = null;
  if (/^[a-z0-9-]+$/i.test(apiPath) && fs.existsSync(file)) {
    mod = await import(pathToFileURL(file).href);
  }
  HANDLER_CACHE.set(apiPath, mod);
  return mod;
}

/**
 * 把 URLSearchParams / 字符串体读成字符串（处理器自己会再解析 JSON）。
 *
 * ⚠️ 必须设上限（2026-10-08 补，审计指出）：`readBody` 在**路由之前**就被调用，
 * 也就是连一个不存在的接口都会把请求体整段读进内存。在 Cloudflare 上有平台限制
 * 兜着，自建（直连 server.mjs）时完全没有 —— 一条
 * `curl -X POST --data-binary @10GB http://host:8788/api/login` 就能把进程内存吃满。
 * 本站所有接口的载荷都很小（登录/举报/建议都是几十到几百字节），
 * 所以 64KB 足够宽松，超了直接 413 并断开。
 */
const MAX_BODY_BYTES = 64 * 1024;

async function readBody(req, res) {
  const declared = Number(req.headers['content-length'] || 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    if (res && !res.headersSent) {
      res.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
      res.end('413 请求体过大');
    }
    req.destroy();
    return undefined;
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      // 没有 Content-Length（分块传输）时靠这里兜住
      if (res && !res.headersSent) {
        res.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
        res.end('413 请求体过大');
      }
      req.destroy();
      return undefined;
    }
    chunks.push(chunk);
  }
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

/** 把 Web Response 写回 Node 的 res（并补上 `_headers` 里的站点级安全头）。 */
async function sendResponse(res, response, pathname = '/') {
  const headers = {};
  for (const [k, v] of response.headers.entries()) {
    if (k.toLowerCase() === 'set-cookie') continue;   // 单独处理，可能是多条
    headers[k] = v;
  }
  withSiteHeaders(headers, pathname);

  // ⚠️ 多条 Set-Cookie **必须折进 writeHead 的那个对象**，不能 writeHead 之后再 setHeader ——
  // 那种写法会抛 ERR_HTTP_HEADERS_SENT（实测：登录接口必炸，而静态页与不带 Cookie 的
  // 接口完全看不出问题）。writeHead 的 headers 接受数组，正好用来发多条 Cookie。
  const cookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : (response.headers.get('set-cookie') ? [response.headers.get('set-cookie')] : []);
  if (cookies.length) headers['Set-Cookie'] = cookies;

  res.writeHead(response.status, headers);

  const buf = Buffer.from(await response.arrayBuffer());
  res.end(buf);
}

/* ---------------- 服务器 ---------------- */

const PORT = Number(envOf('PORT', '8788')) || 8788;
const DB_FILE = envOf('DB_FILE', path.join(HERE, 'data', 'yczx.db'));

if (DB_FILE !== ':memory:') {
  fs.mkdirSync(path.dirname(path.resolve(HERE, DB_FILE)), { recursive: true });
}

const DB = createSqliteD1(DB_FILE === ':memory:' ? ':memory:' : path.resolve(HERE, DB_FILE));

/**
 * 首次部署：把 `sql/*.sql` 按文件名顺序跑一遍。
 *
 * ⚠️ **不要**在这里排除 `000_reset_database.sql` —— 我第一版就是这么修的，
 * 结果 `001` 立刻报 `no such table: vote_logs`：因为 `000` **不只是"清库"**，
 * 它同时**创建 6 张基础表**（categories / classes / admins / songs /
 * banned_items / vote_logs），后面的迁移都是在这之上做增补。
 * （这个错是 `_harness/check-init-safe.mjs` 当场抓出来的。）
 *
 * 所以控制"要不要跑"的正确判据不是文件名，而是**库里有没有表结构** ——
 * 见下面的 `schemaExists()`。
 *
 * 另外：迁移文件**不可重复执行**（004/005/006/007/008/009/010 的
 * `ALTER TABLE ADD COLUMN` 重复跑会 `duplicate column name` 并中断），
 * 所以"已有表结构就整体跳过"同时也是可重复执行性的解药。
 */
async function runMigrations() {
  const dir = path.join(HERE, 'sql');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    try {
      await DB.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
      console.log(`  ok    ${f}`);
    } catch (err) {
      console.error(`  FAIL  ${f}：${(err && err.message) || err}`);
      throw err;
    }
  }
  console.log(`迁移完成（${files.length} 个文件）`);
}

/**
 * 库里是否已经存在本项目的表结构。
 *
 * 用"表存不存在"而不是"有没有数据"来判断：
 *   · 看行数会误判 —— 一个把管理员删光、但还留着班级与歌曲的库，行数是 0，
 *     会被当成新库，然后 `000` 的 DROP 就把还活着的班级和歌曲清掉了。
 *   · 看 `sqlite_master` 才反映"这个库到底初始化过没有"。
 */
async function schemaExists() {
  try {
    const row = await DB.prepare(
      `SELECT COUNT(*) AS n FROM sqlite_master
        WHERE type = 'table'
          AND name IN ('admins','songs','classes','system_settings','weekly_playlist')`
    ).first();
    return Number((row && row.n) || 0) > 0;
  } catch {
    return false;   // 连 sqlite_master 都问不到：当它是新库（后续 --init 会自己建表）
  }
}


const server = http.createServer(async (req, res) => {
  // ⚠️ 整体 try/catch 是**必须**的：这是一个 async 回调，抛出去没人接就是
  //    未处理的 Promise rejection，Node 15+ 默认**结束进程**。
  //    实测有两条远程可触发的路径：
  //      · `curl -H 'Host: a b' http://host:8788/` —— WHATWG URL 对 special scheme
  //        的主机禁止空格等字符，`new URL()` 直接抛 TypeError；
  //      · `curl 'http://host:8788/%zz'` —— 见 resolveStatic 里的 decodeURIComponent。
  //    两条都只需一个普通请求、无需认证，就能把进程打挂（守护进程会反复重启）。
  try {
    await handleRequest(req, res);
  } catch (err) {
    console.error(`请求处理异常：${(err && err.stack) || err}`);
    try {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('500');
      } else {
        res.end();
      }
    } catch { /* 响应已经没法写了，只能算了 */ }
  }
});

async function handleRequest(req, res) {
  // URL 只用来取 pathname / query，**不需要真实 Host**。
  // 用固定的 base 而不是 `http://${req.headers.host}`：后者会被一个畸形 Host
  // 头搞成抛异常（见上面 createServer 里的说明）。
  const url = new URL(req.url || '/', 'http://localhost');
  const env = { ...dotenv, ...process.env, AUTH_PEPPER, DB };

  // ⚠️ 请求体**只能读一次**，所以 Request 必须在最前面构造一次、
  //    之后中间件与处理器共用同一个对象。分开构造两次的话，
  //    第二次拿到的会是一个**空体**（现象是"登录时口令永远是空的"）。
  const rawBody = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req, res) : undefined;
  // 超限时 readBody 已经把 413 写出去并断了连接，这里直接收工。
  if (res.headersSent) return;
  const reqHeaders = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach((x) => reqHeaders.append(k, x));
    else if (v !== undefined) reqHeaders.set(k, v);
  }
  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const request = new Request(requestUrl.href, { method: req.method, headers: reqHeaders, body: rawBody });

  // ---- 0) 域名白名单：与 Cloudflare 上跑的是**同一份中间件代码** ----
  // 复用而不是重写，否则两条部署路径迟早会分叉（一边挡一边不挡）。
  const NEXT = Symbol('next');
  let mw;
  try {
    mw = await MIDDLEWARE.onRequest({ request, env, params: {}, next: async () => NEXT });
  } catch (err) {
    console.error('中间件异常：', err);
    mw = NEXT;    // 中间件自己出错时放行 —— 可用性优先，与它的降级策略一致
  }
  if (mw !== NEXT) {
    await sendResponse(res, mw, url.pathname);
    return;
  }

  // 记录**原始请求路径**：下面的根路径分发会改写 url.pathname
  //（'/' → '/landing.html'），308 判断必须看原始形态，否则会把改写结果再跳一次。
  const requestedPath = url.pathname;

  // ---- 0.5) 根路径分发：与 Cloudflare 上中间件包的那层 next 是**同一个判定** ----
  // 已登录（学生侧会话有效）→ index.html；未登录 → landing.html。
  // 判定来自 _lib/rootpage.js（两个入口共用一份，结论必然一致）。
  // 这里改写 url.pathname 而不是直接读文件：让下面第 2 步的静态服务
  // （含 _headers 安全头、缓存头、流式读取）原样接管，不复制第二份。
  if ((url.pathname === '/' || url.pathname === '/index.html')
      && req.method === 'GET'
      && String(req.headers.accept || '').includes('text/html')) {
    let page = 'landing';
    try { page = await resolveRootPage(env, request); } catch { /* 判不出来就给发布页 */ }
    url.pathname = page === 'app' ? '/index.html' : '/landing.html';
  }

  // ---- 1) /api/* → 交付处理器原样调用 ----
  if (url.pathname.startsWith('/api/')) {
    const name = url.pathname.slice('/api/'.length).replace(/\/+$/, '');
    const mod = await loadHandler(name).catch(() => null);
    const exportName = { GET: 'onRequestGet', POST: 'onRequestPost', PUT: 'onRequestPut', DELETE: 'onRequestDelete' }[req.method];

    if (!mod || !exportName || typeof mod[exportName] !== 'function') {
      const headers = withSiteHeaders({ 'Content-Type': 'application/json; charset=utf-8' }, url.pathname);
      res.writeHead(405, headers);
      res.end(JSON.stringify({ error: '不支持的请求方法或接口' }));
      return;
    }

    try {
      const response = await mod[exportName]({
        request,
        env,
        params: {},
        next: async () => new Response('Not Found', { status: 404 }),
      });
      await sendResponse(res, response, url.pathname);
    } catch (err) {
      console.error('处理器异常：', err);
      const headers = withSiteHeaders({ 'Content-Type': 'application/json; charset=utf-8' }, url.pathname);
      res.writeHead(500, headers);
      res.end(JSON.stringify({ error: '服务器内部错误' }));
    }
    return;
  }

  // ---- 1.5) 模拟 Cloudflare Pages 的"去扩展名"行为（本地必须和线上一致）----
  //
  // Cloudflare Pages 会把 `/login.html` 308 到 `/login`，`/index.html` 到 `/`。
  // 本地不模拟的话，**依赖地址形态的前端问题在本地永远测不出来** ——
  // 2026-10-10 线上"点按钮没反应"事故正是这样漏过去的：路由写的是
  // `path.endsWith('login.html')`，线上地址是 `/login`，整段路由不匹配。
  // 判定一律用**原始请求路径**（requestedPath），不受根路径分发改写的干扰。
  if (req.method === 'GET' && /\.html$/i.test(requestedPath)) {
    const clean = requestedPath.replace(/\.html$/i, '');
    const target = clean === '/index' ? '/' : clean;
    res.writeHead(308, { Location: target + url.search, 'Cache-Control': 'no-store' });
    res.end();
    return;
  }
  // 反向映射：无扩展名的 `/login` → 内部服务 `/login.html`（文件存在才算）。
  // 跳过 '/'（它由上面的根路径分发决定给发布页还是主页）。
  if (requestedPath !== '/' && !/\/[^/]*\.[^/]*$/.test(requestedPath)) {
    const candidate = requestedPath.replace(/\/+$/, '') + '.html';
    if (resolveStatic(candidate)) url.pathname = candidate;
  }

  // ---- 2) 其它 → 静态文件 ----
  const file = resolveStatic(url.pathname);
  if (!file) {
    const headers = withSiteHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }, url.pathname);
    res.writeHead(404, headers);
    res.end('404');
    return;
  }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const headers = withSiteHeaders({ 'Content-Type': type }, url.pathname);

  // 针对静态资产（JS/CSS/图片/字体）提供智能响应头配置
  // 注意：用户指示当前阶段测试优先，暂不开启长期静态缓存，后续阶段可自动开启
  if (!Object.keys(headers).some((k) => k.toLowerCase() === 'cache-control')) {
    if (/\.(png|jpg|jpeg|gif|webp|svg|ico|woff2)$/i.test(file)) {
      headers['Cache-Control'] = 'public, max-age=604800'; // 媒体资源安全保留一周
    } else {
      headers['Cache-Control'] = 'no-store';   // 本地预览：永远不缓存，避免"改了没生效"的假象
    }
  }
  res.writeHead(200, headers);
  // ⚠️ 必须挂 error 监听：读不了的**已存在**文件（EACCES、或在这两行之间被删掉）
  //    会让流异步抛错，没人接就是未处理异常 → 进程退出。
  const stream = fs.createReadStream(file);
  stream.on('error', (err) => {
    console.error(`静态文件读取失败：${file} —— ${(err && err.message) || err}`);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end();
  });
  stream.pipe(res);
}

// ---- `--init` 的两道闸 ----
//
// 为什么要有闸：这套迁移文件**不可重复执行**（`ALTER TABLE ADD COLUMN`
// 会 `duplicate column name`），而文档里推荐的容器写法是
// `CMD ["node","server.mjs","--init"]` + `restart: unless-stopped` ——
// 也就是**每次重启都会跑一遍**。所以必须能识别"这库已经初始化过了"。
//
// 要真的重来一遍：删掉数据库文件，或者显式加 `--force-reset`
// （后者会连 `000_reset_database.sql` 一起跑，把库清空重建 —— 是**故意**要清库时才用）。
if (process.argv.includes('--init')) {
  const FORCE = process.argv.includes('--force-reset');
  const exists = await schemaExists();
  if (FORCE) {
    console.warn('⚠️  --force-reset：会执行 000_reset_database.sql，把整库清空重建。');
    await runMigrations();
  } else if (exists) {
    // 关键的一道闸：迁移文件不可重复执行（ALTER TABLE ADD COLUMN 会
    // duplicate column name），而文档推荐的容器写法是每次重启都跑 --init。
    // 没有这道闸，第二次启动就会先执行 000 的 DROP TABLE —— 静默清空整库。
    console.log('跳过迁移：库里已经有本项目的表结构。');
    console.log('  迁移文件不可重复执行，所以这里不重跑（旧行为会先执行 000 把整库清空）。');
    console.log('  要真的重新初始化：删掉数据库文件，或加 --force-reset（会清空全部数据）。');
  } else {
    await runMigrations();
  }
}

server.listen(PORT, () => {
  console.log(`已启动：http://127.0.0.1:${PORT}`);
  console.log(`  静态根：${SITE_ROOT}`);
  console.log(`  数据库：${DB_FILE}`);
});
