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
 *   SITE_ROOT   静态文件根。默认自动判断：有 public/ 就用 public/，否则用仓库根
 *   （其余同名环境变量原样透传给处理器，例如 AUTH_PEPPER / RECAPTCHA_SECRET /
 *     POW_ENABLED / ALLOWED_HOSTS … 与 Cloudflare 上的名字完全一致）
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSqliteD1 } from './_lib/sqlite-driver.js';

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

/* ---------------- 静态文件 ---------------- */

/** 只在 public/ 存在时才用它 —— 前端分离前后这一行都不用改。 */
function pickSiteRoot() {
  const explicit = envOf('SITE_ROOT', '');
  if (explicit) return path.resolve(HERE, explicit);
  const pub = path.join(HERE, 'public');
  return fs.existsSync(pub) ? pub : HERE;
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
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel.endsWith('/')) rel += 'index.html';
  const full = path.resolve(SITE_ROOT, '.' + rel);
  // 必须仍在静态根之内 —— `..` 拼出来的路径一律拒绝
  if (full !== SITE_ROOT && !full.startsWith(SITE_ROOT + path.sep)) return null;
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
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
      rules.push(current);
      continue;
    }
    const m = /^\s+([A-Za-z0-9-]+):\s*(.+)$/.exec(line);   // 缩进 = 头
    if (m && current) current.headers[m[1]] = m[2].trim();
  }
  return rules;
}

const HEADER_RULES = loadHeaderRules();

/** 把匹配到的站点级响应头并进去（不覆盖处理器自己设的头）。 */
function withSiteHeaders(headers, pathname) {
  for (const rule of HEADER_RULES) {
    const hit = rule.pattern === '/*'
      || rule.pattern === pathname
      || (rule.pattern.endsWith('/*') && pathname.startsWith(rule.pattern.slice(0, -1)));
    if (!hit) continue;
    for (const [k, v] of Object.entries(rule.headers)) {
      if (headers[k] === undefined) headers[k] = v;
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

/** 把 URLSearchParams / 字符串体读成字符串（处理器自己会再解析 JSON）。 */
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
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

/** 首次部署：把 sql/*.sql 按文件名顺序全跑一遍（迁移本身是幂等的）。 */
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const env = { ...dotenv, ...process.env, DB };

  // ⚠️ 请求体**只能读一次**，所以 Request 必须在最前面构造一次、
  //    之后中间件与处理器共用同一个对象。分开构造两次的话，
  //    第二次拿到的会是一个**空体**（现象是"登录时口令永远是空的"）。
  const rawBody = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : undefined;
  const reqHeaders = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach((x) => reqHeaders.append(k, x));
    else if (v !== undefined) reqHeaders.set(k, v);
  }
  const request = new Request(url.href, { method: req.method, headers: reqHeaders, body: rawBody });

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

  // ---- 2) 其它 → 静态文件 ----
  const file = resolveStatic(url.pathname);
  if (!file) {
    const headers = withSiteHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }, url.pathname);
    res.writeHead(404, headers);
    res.end('404');
    return;
  }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const headers = withSiteHeaders(
    { 'Content-Type': type, 'Cache-Control': 'no-cache' }, url.pathname
  );
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
});

if (process.argv.includes('--init')) {
  await runMigrations();
}

server.listen(PORT, () => {
  console.log(`已启动：http://127.0.0.1:${PORT}`);
  console.log(`  静态根：${SITE_ROOT}`);
  console.log(`  数据库：${DB_FILE}`);
});
