# 云之声点歌台 · 前端接口契约

写给**只改前端**的人：你调哪个地址、带什么、会拿回什么、什么情况下会失败。

- 生产域名：`vote.yzstu.top`
- 路由：`_routes.json` 是 `include: ["/*"]` + `exclude: ["/assets/*"]` —— **除 `/assets/` 下的静态图片外，所有请求（含 HTML 页面）都会进 Functions**，因此 `functions/_middleware.js` 对页面与接口都生效，见 1.0。
- 所有响应都是 JSON（`/api/music?play=` 除外，那是音频字节流）
- **没有 CORS**：响应里没有 `Access-Control-Allow-Origin`，所以只能同源调用（页面与接口同一个域名）
- 本文只描述**代码里能读出来的行为**。凡是代码里没有的约束，一律写"代码里未找到约束"，不编。
- 文末 `<!-- 出处：… -->` 里的行号是**写作当时的快照**。⚠️ 写作期间仓库里有另一个进程在**并发编辑**：`functions/api/music.js` 从 107,916 字节涨到 114,696 字节（新增 `artistTokensOf()`、`FRAGMENT_RATIO`，并改写了 `artistFitScore` / `isFragmentCandidate` 的排序细节），`_routes.json` 被改成 `include: ["/*"]`，并新出现了 `functions/_middleware.js`。因此 **`music.js` 的行号最易漂移，请以函数名 / 常量名为准**。其余 21 个 handler 与全部 `_lib/*.js` 的字节数与写作时一致。

---

## 0. 30 秒速查表

| 方法 | 路径 | 要不要登录 | 一句话作用 |
|---|---|---|---|
| GET | `/api/config` | 完全公开 | 下发 reCAPTCHA / PoW 开关、备案号、是否暂停投稿 |
| GET | `/api/pow` | 完全公开 | 下发一道 PoW 谜题（功能没开时回 `enabled:false`） |
| POST | `/api/login` | 完全公开 | 班级口令 / 游客口令 / 调试口令登录，签发学生会话 Cookie |
| POST | `/api/admin-login` | 完全公开 | 管理员登录，签发管理员会话 Cookie |
| POST | `/api/admin-register` | 完全公开（凭邀请码） | 用动态口令注册一个**普通**管理员 |
| POST | `/api/logout` | 完全公开 | 撤销会话并清掉两个身份的 Cookie |
| GET | `/api/announcements?scope=gate` | 完全公开 | 登录页公告（未登录可见） |
| GET | `/api/music?status=1` | 完全公开 | 音源配置自检，只回 provider 名 |
| GET | `/api/music?probe=1` | 完全公开 | 逐源自检（能不能搜到 / 能不能取到音频）+ 构建号 |
| GET | `/api/me` | 班级会话 | 当前身份（`role` / `isGuest` / `className`） |
| GET | `/api/rank` | 班级会话 | 榜单：`status=approved` 正式榜（不含票数）/ `status=pending` 待审核榜 |
| GET | `/api/music?q=…` | 班级或管理员 | 搜索歌曲候选（带选曲凭据 `track_token`） |
| GET | `/api/music?check=<id>` | 班级或管理员 | 只问"这一版能不能出音频"，不取音频 |
| GET | `/api/music?play=<id>` | 班级或管理员 | 取音频字节流（支持 `Range`，用于 `<audio>` 试听） |
| GET | `/api/schedule` | 班级或管理员 | 从某一周起连续读若干周的歌单 |
| GET | `/api/announcements` | 班级或管理员 | 首页公告 + 弹窗公告 |
| POST | `/api/vote` | 班级会话（游客 403） | 点歌提交（**必须**带 `track_token`） |
| POST | `/api/upvote` | 班级会话（游客 403） | 给待审核歌曲投票 |
| POST | `/api/report` | 班级会话（游客 403） | 举报待审核歌曲 |
| POST | `/api/suggest` | 班级会话（游客 403） | 学生对某首歌提版本建议 |
| GET | `/api/suggest?song_id=` | 管理员（普通/高级） | 按歌曲读建议明细 |
| PUT | `/api/suggest` | 管理员（普通/高级） | 把某首歌的建议标记为已处理 |
| GET | `/api/admin-list?status=` | 管理员（普通/高级） | 后台歌曲列表（含 `playable` 标记） |
| POST | `/api/admin-action` | 管理员（普通/高级） | 审核通过 / 拒绝 / 恢复 / 清举报 / 删除 / 清空回收站 |
| GET | `/api/admin-reports` | 管理员（普通/高级） | 举报收件箱（达到阈值的才进来） |
| POST | `/api/admin-reports` | 管理员（普通/高级） | 把某首歌的举报标记为已处理 |
| POST | `/api/admin-update` | 管理员（普通/高级） | 改某首歌的分类 |
| GET | `/api/admin-settings` | 管理员（普通/高级） | 读班级 / 黑名单 / 分类 / 开关等全部设置 |
| POST | `/api/admin-settings` | 按 `action` 分：多数仅高级，3 个给普通 | 班级口令、黑名单、权重、投票上限、暂停投稿、举报阈值、班级投票/投稿上限、暂停班级、全站投稿上限、改自己密码 |
| GET | `/api/admin-passes` | 管理员（普通/高级） | 测试口令 / 游客口令列表（配私有 AUTH_PEPPER 时附明文） |
| POST | `/api/admin-passes` | 管理员（普通/高级） | 生成 / 作废 / 删除 测试口令、游客口令 |
| POST | `/api/announcements` | 管理员（普通/高级） | 发 / 改 / 上下架 / 删公告 |
| POST | `/api/schedule` | 管理员（普通/高级） | 排某一周 / 连续排多周 / 指定位置 / 清空 / 播放模式 / 每周数量 / 任意位置插入 / 时段内移动 |
| GET | `/api/admin-accounts` | **仅高级管理员** | 管理员账号列表 |
| POST | `/api/admin-accounts` | **仅高级管理员** | 删除管理员 / 重置他人密码 |
| GET | `/api/admin-invites` | **仅高级管理员** | 动态口令（邀请码）列表 |
| POST | `/api/admin-invites` | **仅高级管理员** | 生成 / 作废动态口令 |

端点合计：`functions/api/` 下 23 个文件共导出 **32 个处理器**（GET/POST/PUT 分开计）。`/api/music` 一个处理器内含 5 种模式，本表按模式拆开列出。

<!-- 出处：functions/api/admin-list.js:39, admin-register.js:25, admin-invites.js:35,66, admin-login.js:21, config.js:12, admin-action.js:28, announcements.js:32,41, admin-accounts.js:16,32, admin-reports.js:22,105, admin-update.js:7, vote.js:38, pow.js:37, admin-settings.js:58,173, upvote.js:32, logout.js:15, music.js:2171 (onRequestGet), me.js:21, schedule.js:58,122, report.js:17, suggest.js:25,52,108, login.js:27, rank.js:28, _routes.json:1-5 -->

**关于 405**：Pages Functions 对"没有导出对应处理器的请求方法"自动返回 405。例如 `/api/vote` 只有 POST，用 GET 打它是 405，不是 404，也不是本文列的任何一条错误文案。

**关于域名**：上表全部接口的前提是"你用 `vote.yzstu.top` 访问"。从 `*.pages.dev` 预览域名打 `fetch` 会在**进到任何一个 handler 之前**就拿到 `403` `{"error":"本站只允许通过 vote.yzstu.top 访问"}` —— 详见 **1.0**。

<!-- 出处：functions/api/pow.js:17-19, functions/_middleware.js:92-134 -->

---

## 1. 前端必须知道的全局约定

### 1.0 域名白名单（全站最先执行）

`functions/_middleware.js` 在**任何 handler 之前**执行，只允许通过白名单域名访问本站。

| 情况 | 行为 |
|---|---|
| Host 在 `ALLOWED_HOSTS` 里（**默认只有 `vote.yzstu.top`**） | 放行 |
| Host 是 `localhost` / `127.0.0.1` / `::1` / `[::1]` | **永远放行**（本机 wrangler 调试用） |
| `ALLOWED_HOSTS=*` | 全部放行（应急开关，等价于关掉这个功能） |
| `ALLOW_PREVIEWS=1` 且 Host 是 `*.pages.dev`（或 `pages.dev`） | 放行 |
| 其它 Host + **页面导航** | `302` 跳到 `https://<CANONICAL_HOST><pathname><search>`（目标默认取白名单第一项，即 `vote.yzstu.top`），带 `Cache-Control: no-store` |
| 其它 Host + **fetch / XHR** | `403` `{"error":"本站只允许通过 <目标域名> 访问"}` |

判定"是不是页面导航"的顺序：`sec-fetch-dest: document` → `sec-fetch-mode: navigate` → 老浏览器退回看 `Accept` 里含不含 `text/html`。

**对前端最要紧的一条**：如果从 `xxx.pages.dev` 预览地址打开页面，页面本身会被 302 跳到正式域名，而**所有 `fetch('/api/…')` 会直接拿到 `403` 与那句中文错误**。要么在正确域名上开发，要么请部署方临时设 `ALLOW_PREVIEWS=1`，或把该预览域名加进 `ALLOWED_HOSTS`。

为什么两个文件必须一起改：`_routes.json` 原本是 `include: ["/api/*"]`，那时只有 API 会进 Functions、HTML 页面根本不经过中间件；现在它是 `include: ["/*"]` + `exclude: ["/assets/*"]`，页面与接口都过中间件，静态图片用 `exclude` 省掉函数调用。

<!-- 出处：functions/_middleware.js:37-134, _routes.json:1-5 -->

### 1.1 请求头与响应头

| 项 | 值 |
|---|---|
| 请求 `Content-Type` | 凡是有 JSON 体的 POST/PUT **必须是** `application/json`（可带 `; charset=utf-8`）。判定方式是 `Content-Type` 里包含 `application/json`（大小写不敏感） |
| 不满足时的返回 | `400` + `{"error":"请求格式不正确"}`；body 不是 JSON、或解析出来不是对象（数组/null/字符串）也是同一条 |
| 响应 `Content-Type` | `application/json; charset=utf-8`（音频模式除外） |
| 响应缓存头 | `Cache-Control: no-store, no-cache, must-revalidate`，`X-Content-Type-Options: nosniff`，`Referrer-Policy: no-referrer` |
| 凭证 | 会话靠 Cookie 自动携带，前端**不需要**手动加 `Authorization`（但服务端也接受 `Authorization: Bearer <token>`，命令行/自动化可用） |

`POST /api/logout` 不读请求体，所以它不发 `Content-Type` 也能成功（现有前端就是 `body:'{}'` 或干脆不带 body）。

<!-- 出处：_lib/http.js:8-13,16-26,152-166, _lib/auth.js:207-229, functions/api/logout.js:15-31, index.html:1961 -->

### 1.2 限流：真实的桶与额度

限流的**身份键**按"最强可用身份"取，优先级（强 → 弱）：`fingerprint` → `client_id` → 会话 id → `class_id`（subject_id）→ IP。也就是说：请求体里带了合法 `fingerprint`，额度就按设备算；什么都没带才退化成按 IP。

`guardRate()` 是"两道一起用，**任一道还有余量就放行**"：
- 身份额度用完 → 才去查 IP 桶；
- IP 桶也超了 → `429`。

IP 兜底默认值是 `max(limit * 8, 600)`（可被调用方显式覆盖）。

| 接口 | 桶 kind | 身份额度 | IP 兜底额度 | 超限返回 |
|---|---|---|---|---|
| `POST /api/login` | `class-login:{ip}:{口令摘要前16位}` | 10 次 / 900 秒 | 另一桶 `class-login-ip:{ip}`：40 次 / 900 秒 | `429` `{"error":"尝试过于频繁，请 15 分钟后再试"}`；IP 桶超限是 `429` `{"error":"该网络登录尝试过于频繁，请稍后再试"}` |
| `POST /api/admin-login` | `admin-login:{ip}` | 8 次 / 900 秒 | 无（这是唯一一道） | `429` `{"error":"尝试过于频繁，请 15 分钟后再试"}` |
| `POST /api/admin-register` | `admin-register:{ip}` | 10 次 / 900 秒 | 无（唯一一道） | `429` `{"error":"尝试过于频繁，请 15 分钟后再试"}` |
| `GET /api/pow` | `pow:cid:{cid}`（没有合法 `cid` 时退化成 `pow:ip:{ip}`） | 30 次 / 3600 秒 | 另一桶 `pow:ip:{ip}`：300 次 / 3600 秒 | `429` `{"error":"请求过于频繁，请稍后再试"}` |
| `POST /api/vote` | `vote` | 30 次 / 3600 秒 | 600 次 / 3600 秒（默认 `max(30*8,600)`） | `429` `{"error":"提交过于频繁，请稍后再试"}` |
| `POST /api/upvote` | `upvote` | 30 次 / 3600 秒 | 600 次 / 3600 秒 | `429` `{"error":"投票过于频繁，请稍后再试"}` |
| `POST /api/report` | `report` | 20 次 / 3600 秒 | 600 次 / 3600 秒 | `429` `{"error":"操作过于频繁，请稍后再试"}` |
| `POST /api/suggest` | `suggest` | 20 次 / 3600 秒 | 600 次 / 3600 秒 | `429` `{"error":"建议提得有点频繁，请稍后再试"}` |
| `/api/music`（`q` / `check` / `play` 三种模式共用第一道） | `music` | 240 次 / 3600 秒 | 1200 次 / 3600 秒（显式指定） | `429` `{"error":"试听请求过于频繁，请稍后再试"}` |
| `/api/music?play=` 额外一道 | `audio:{会话id}\|{音源id}`，同一小时同一首歌**只计一次** | 60 次 / 3600 秒 | 同上一道 | `429` `{"error":"试听请求过于频繁，请稍后再试"}` |
| `/api/music?q=` 额外收紧 | 全站计数 `budget:music-search` 超过 **2000 次/小时**时启用 `music-search-tight` | 20 次 / 3600 秒 | 60 次 / 3600 秒 | `429` `{"error":"搜索过于频繁，请稍后再试"}` |

补充说明：
- `/api/pow` **不使用** `guardRate()`，它直调 `rateLimit()`，所以是"两道各自独立生效，任一道超了就拒"（与别处的语义相反）。这是刻意的：`guardRate` 的兜底桶永远有余量，会把设备额度顶掉。
- `POST /api/suggest` 的限流发生在**读请求体之前**，所以请求体格式不对时额度也已经被扣过一次。
- 限流表本身不可用（`rate_limits` 表查不动）时**一律放行**，不会因为限流表挂了就让业务不可用。
- 管理员接口（`/api/admin-*`）与 `/api/schedule`、`/api/announcements` **代码里未找到限流**。

<!-- 出处：_lib/auth.js:697-722,755-775,785-799,829-853, _lib/http.js:129-149, functions/api/login.js:41-58, admin-login.js:28-29, admin-register.js:32-33, pow.js:22-36,63-78, vote.js:78-88, upvote.js:76-85, report.js:36-46, suggest.js:64-72, music.js:2298-2313,2354-2369,2371 起 -->

### 1.3 可用性优先的降级行为（重要）

设计取向是"**宁可放行，也不让全校因为第三方不可达而用不了**"。所以下面这些情况**不会**报错，而是直接跳过校验：

#### reCAPTCHA（`recaptcha_token`）

| 情况 | 服务端行为 |
|---|---|
| 没配 `RECAPTCHA_SECRET` | 整个功能不启用，**放行**（`skipped`）。`/api/config` 里 `recaptcha.enabled=false` |
| 配了密钥，但请求里没带 `recaptcha_token`（或空串），且 `RECAPTCHA_STRICT` 不是 `'1'` | **放行**（`skipped`）。默认就是这个行为 |
| 配了密钥，没带 token，且 `RECAPTCHA_STRICT=1` | 拒绝：`403` `{"error":"人机校验未通过（未取到校验令牌），请刷新页面重试"}` |
| token 无效（siteverify 返回 `success !== true`） | 拒绝：`403` `{"error":"人机校验未通过，请刷新页面后重试"}` |
| 分数低于 `RECAPTCHA_MIN_SCORE`（默认 `0.5`） | 拒绝：`403` `{"error":"人机校验分数过低，请稍后再试"}` |
| 校验服务本身不可达（网络异常） | **放行**（`skipped`） |

前端从 `/api/config` 的 `recaptcha.siteKey` 与 `recaptcha.base` 加载脚本；`base` 默认 `https://www.recaptcha.net`（不是 `www.google.com`，后者在大陆不可达），CSP 里已放行该域名。

#### 浏览器端 PoW（`pow`）

开启条件（三者同时满足）：`POW_ENABLED` 恰好等于 `'1'`、`POW_EMERGENCY_OFF` 不是 `'1'`、并且能拿到密钥（`POW_SECRET` 或 `AUTH_PEPPER` 至少配一个）。

| 情况 | `/api/pow` 的返回 | 写接口校验时的行为 |
|---|---|---|
| 未启用（含上述任一条件不满足） | `200` `{ok:true, enabled:false, action, challenge:"", difficulty, expiresIn:0}` | **放行**（`skipped`），前端把 `pow` 传 `null` 也没关系 |
| 已启用但这次签不出谜题（密钥中途被摘掉） | 同上，按"关闭"答复 | 同上 |
| 已启用，请求里没带 `pow` / 形状不对 | `200` `{ok:true, enabled:true, action, challenge:"v1.…", difficulty, expiresIn:300}` | 拒绝：`403` `{"error":"人机校验未通过，请刷新页面重试"}` |
| 已启用，谜题已过期 | 同上 | 拒绝：`403` `{"error":"校验已过期，请刷新页面重试"}` |
| 已启用，签名不对 / 难度被改 / 工作量不足 / action 不匹配 | 同上 | 拒绝：`403` `{"error":"人机校验未通过，请刷新页面重试"}` |

要点：
- 谜题有效期 **300 秒**（`expiresIn`）；有效难度只接受 3~6 的整数，默认 **3**；协议里 `action` 只认 `'upvote'`，其它一切值都归为 `'vote'`。
- 给 `vote` 签的谜题不能拿到 `upvote` 上用（反之亦然）。
- 校验方式是 `SHA-256(challenge + ':' + nonce)` 的十六进制开头要有 `difficulty` 个 `0`。
- `/api/pow` 的 `cid` 参数必须是 `/^[A-Za-z0-9_-]{8,64}$/`，否则被忽略并按 IP 分桶（老前端 / 直接打接口的行为**不会更宽松**）。

<!-- 出处：_lib/recaptcha.js:26-31,34-36,42-83, _lib/pow.js:89-121,123-135,153-171,183-238, functions/api/pow.js:63-120, music.js 无关, _headers:22-27 -->

---

## 2. 认证

### 2.1 会话 Cookie

| Cookie 名 | 谁用 | 属性 | 有效期（`Max-Age`） |
|---|---|---|---|
| `yczx_class_session` | 学生 / 游客 / 调试身份 / 口令凭证 | `HttpOnly`、`SameSite=Lax`、`Path=/`、`Secure`（仅当请求是 https） | 学生与游客 **86400 秒（1 天）**；调试身份 **7200 秒（2 小时）**；**口令凭证会话 = `min(24h, 凭证剩余有效期)`，且不滑动续期** |
| `yczx_admin_session` | 管理员 | 同上 | **43200 秒（12 小时）** |
| `yczx_session` | 旧名字 | 只在下线登录时被**清空**，不再签发 | — |

- 令牌本身是 32 字节随机串，库里只存 SHA-256 摘要；令牌**只通过 `Set-Cookie` 下发，不放进任何响应体**。
- 学生与管理员**必须**是两个不同的 Cookie 名：同一个浏览器里登录后台不会顶掉学生的登录，反之亦然。
- 服务端也接受 `Authorization: Bearer <token>`（`Authorization` 头优先于 Cookie）。

### 2.2 滑动续期

学生与游客的会话是滑动窗口：**只要这次请求带着有效会话，过期时间就推到"从现在起再一个完整有效期"**，但同一会话**每小时最多续一次**。新过期时间取 `MAX(原过期时间, now + 86400 秒)`，只续不缩。前端什么都不用做 —— 打开页面时的 `/api/rank` 或 `/api/me` 就会把它续上。

注意一处代码事实：续期语句里写死的增量是 `CLASS_TTL_SECONDS`（86400 秒），**对管理员会话也一样**（`refreshSessionOnUse` 不区分身份）。也就是说管理员会话在"被用到"之后，过期时间会被推到 `now + 24 小时`，而不是签发时的 12 小时。

### 2.3 怎么登录 / 登出

- 学生登录：`POST /api/login`，body `{password, recaptcha_token?}`。响应体里带 `class_id` / `class_name`，同时 `Set-Cookie: yczx_class_session=…`。
- 管理员登录：`POST /api/admin-login`，body `{username, password}`。响应体 `{ok:true, role, username}`，同时 `Set-Cookie: yczx_admin_session=…`。
  - ⚠️ 这里的 `role` 是数据库里的**原始值**（可能是 `'super'`、`'admin'`、也可能是空串或别的历史值），没有经过归一化。服务端判定权限时用的是 `normalizeRole()`：只有 `'super'` 算高级管理员，**空值和一切无法识别的值都按普通管理员处理**。前端要判断"是不是高级管理员"，请用 `role === 'super'`。
- 登出：`POST /api/logout`。它删除服务端会话行，并用 `Max-Age=0` 清掉 `yczx_class_session`、`yczx_admin_session`、`yczx_session` 三个 Cookie。**不需要登录态**，也**不会**因为未登录而报错，永远回 `200 {"ok":true}`。

### 2.4 会话过期 / 身份不符时接口返回什么

| 情况 | 状态码 | 响应体 | 前端该做什么 |
|---|---|---|---|
| 没带令牌、令牌无效、会话已过期 | `401` | `{"error":"登录已过期，请重新登录"}` | 清掉前端内存里的身份状态、提示重新输口令；现有 `vote.html` 的做法是弹窗提示 + 用户点确认后回登录页 |
| 会话存在但身份不对（例如拿学生会话打管理员接口） | `403` | `{"error":"无权限执行该操作"}` | 说明前端串了身份，不要自动跳登录页 |
| 管理员账号已被删除（会话还在） | `401` | `{"error":"账号已失效，请重新登录"}` | 回管理员登录页 |
| 角色不够（普通管理员打高级管理员接口） | `403` | `{"error":"当前角色无权执行该操作"}` | 提示权限不足 |
| 数据库还没跑安全迁移（`sessions` 表不存在） | `500` | `{"error":"数据库尚未执行安全升级迁移，请先在 D1 控制台执行 sql/001_security_upgrade.sql"}` | 这是部署问题，不是前端问题 |
| D1 绑定缺失 | `500` | `{"error":"服务端数据库未绑定（缺少 D1 绑定 DB）"}` | 同上 |

### 2.5 游客身份 vs 班级身份 vs 口令凭证

游客**复用学生那一侧**的 Cookie（`yczx_class_session`）与整套会话机制，`subject_id` 恒为 `0`（与调试身份同义："不属于任何真实班级"）。区别只在 `role`：

| | 班级学生 | 游客（环境变量） | **游客口令** | **测试口令** | 调试身份 |
|---|---|---|---|---|---|
| `sessions.role` | `null`（`/api/me` 里回 `'class'`） | `'guest'` | `'guest'` | `'test'` | `'debug'` |
| `subject_id` | 真实班级 id | `0` | `0` | `0` | `0` |
| `/api/me` 的 `role` | `'class'` | `'guest'` | `'guest'` | `'test'` | `'debug'` |
| `className` | 真实班级名 | `'游客模式'` | `'游客模式'` | `'测试口令'` | `'调试模式'` |
| 怎么进来 | 输入班级口令 | 输入 `GUEST_PASSWORD`（环境变量） | 后台「口令管理」生成，输入登录框 | 后台「口令管理」生成，输入登录框 | 输入 `管理员账号:密码`（需 `DEBUG_LOGIN=1` 且该管理员是 `super`） |

口令凭证存放在 `access_passes` 表（015 迁移），登录判定顺序是
「班级口令 → 口令凭证（`token_lookup` HMAC 索引）→ `GUEST_PASSWORD` → 调试登录」。
凭证会话的有效期 = `min(24 小时, 凭证剩余有效期)`，且**不参与滑动续期**（到期即失效）；
**作废 / 删除凭证会立即撤销它签发过的全部会话**（`sessions.pass_id` 精确反查）。
测试口令拥有与班级学生完全相同的写权限（投票、投稿）；游客口令与 `GUEST_PASSWORD`
游客走同一条 `denyGuest` 闸门。

游客模式**默认关闭**：只有部署方配了非空 `GUEST_PASSWORD` 才存在。判定顺序是「班级口令 → 游客口令 → 调试登录」，所以班级口令永远优先于游客口令。

**游客能做什么**：`/api/rank`、`/api/me`、`/api/announcements`、`/api/schedule`、`/api/music`（搜索 / 试听 / 校验）—— 只读的全部放行。

**游客被拒的操作**（全部是 `403`，且**排在读请求体、限流与任何写入之前**，所以被拒的请求不留任何副作用、也不占额度）：

| 接口 | 状态码 | 文案 |
|---|---|---|
| `POST /api/vote` | `403` | `游客模式只能查看排行，不能投稿` |
| `POST /api/upvote` | `403` | `游客模式只能查看排行，不能投票` |
| `POST /api/report` | `403` | `游客模式只能查看排行，不能举报` |
| `POST /api/suggest` | `403` | `游客模式只能查看排行，不能提建议` |
| `POST /api/schedule` | `403` | `游客模式只能查看排行，不能排期` |

游客进不去 `requireStaff` 那些接口（`/api/admin-*`、`/api/suggest` 的 GET/PUT），会先撞上 `403` `{"error":"无权限执行该操作"}` 或 `401`。

<!-- 出处：_lib/auth.js:27-33,89-154,166-169,186-187,197,242-315,328-386,439-464,470-497,509-560,563-568,580-600,681-691, _lib/http.js:58-72, functions/api/login.js:109-147,149-161,197-201,204-263, me.js:21-50, logout.js:15-31, admin-login.js:73-85, vote.js:41-63, upvote.js:35-41, report.js:20-26, suggest.js:55-62, schedule.js:122-136 -->

---

## 3. 公开接口（不需要任何登录）

### 3.1 `GET /api/config`

**身份**：完全公开（登录页也要用）。**限流**：代码里未找到限流。

**请求**：无参数、无 body。

**响应 `200`**：

```jsonc
{
  "recaptcha": {
    "enabled": true,          // 是否配了 RECAPTCHA_SECRET
    "siteKey": "…",           // enabled 为 false 时是空串
    "base": "https://www.recaptcha.net"  // 加载 api.js 的域名，可用 RECAPTCHA_BASE 覆盖
  },
  "pow": {
    "enabled": true,          // 是否启用 PoW（要同时满足三个条件，见 1.3）
    "difficulty": 3,          // 3~6，非法配置一律回落到 3
    "emergencyOff": false,    // 是否被 POW_EMERGENCY_OFF=1 紧急关闭
    "secretConfigured": true  // 有没有配 POW_SECRET 或 AUTH_PEPPER
  },
  "beian": { "icp": "…", "gongan": "…", "holder": "…" },
  "submit": { "paused": false }   // 是否暂停接收投稿；这只是提示，真正的闸门在 vote.js
}
```

`beian` 三个值来自环境变量 `ICP_BEIAN` / `GONGAN_BEIAN` / `COPYRIGHT_HOLDER`，没配就是空串。

**失败**：无（不依赖数据库）。

<!-- 出处：functions/api/config.js:12-64 -->

### 3.2 `GET /api/pow`

**身份**：完全公开（谜题里没有任何身份信息）。**限流**：每设备 30/小时、每出口 IP 300/小时（见 1.2）。

**请求 query**：

| 参数 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `action` | string | 否 | 只认 `'upvote'`；`'vote'` 以及**其它任何值**都归为 `'vote'`（默认 `'vote'`） |
| `cid` | string | 否 | 必须匹配 `/^[A-Za-z0-9_-]{8,64}$/`，否则被忽略并按 IP 分桶。前端从 `localStorage` 里取的随机串，用来把"设备额度"和"全校共用的出口 IP"分开 |

**响应 `200`（已启用）**：`{ok:true, enabled:true, action:"vote", challenge:"v1.<action>.<difficulty>.<exp>.<challenge>.<sig>", difficulty:3, expiresIn:300}`

**响应 `200`（未启用）**：`{ok:true, enabled:false, action, challenge:"", difficulty, expiresIn:0}` —— 前端看到 `enabled !== true` 就跳过取谜题与计算。

**失败**：`429` `{"error":"请求过于频繁，请稍后再试"}`（两道任一道超限）。

<!-- 出处：functions/api/pow.js:37-121, _lib/pow.js:153-171 -->

### 3.3 `POST /api/login`

**身份**：完全公开。**限流**：两道（见 1.2）。

**请求 body**：

| 字段 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `password` | string | **是** | 去首尾空白后长度 **4~128**；不做别的改写。可以是班级口令、游客口令，或（`DEBUG_LOGIN=1` 时）`账号:密码` / `账号 密码` 形态的调试口令 |
| `recaptcha_token` | string | 否 | 不传时按 1.3 的降级表处理（默认放行） |

**响应 `200`**（三种形态）：

```jsonc
// 普通班级
{ "ok": true, "class_id": 12, "class_name": "高一(3)班" }
// 游客（环境变量口令）
{ "ok": true, "class_id": 0, "class_name": "游客模式", "guest": true, "role": "guest" }
// 游客口令 / 测试口令（后台「口令管理」生成，v3.4.0）
{ "ok": true, "class_id": 0, "class_name": "游客模式", "guest": true, "role": "guest" }
{ "ok": true, "class_id": 0, "class_name": "测试口令", "test": true, "role": "test" }
// 调试身份（管理员账号:密码换来）
{ "ok": true, "class_id": 0, "class_name": "调试模式", "debug": true }
```

三种情况都会 `Set-Cookie: yczx_class_session=…`。

**失败**：

| 状态码 | 文案 | 触发条件 |
|---|---|---|
| `400` | `请求格式不正确` | 不是 `application/json`、body 不是对象 |
| `400` | `班级口令格式不正确` | `password` 不是字符串 |
| `400` | `班级口令至少 4 位` | 去空白后短于 4 |
| `400` | `班级口令最多 128 位` | 长于 128 |
| `429` | `尝试过于频繁，请 15 分钟后再试` | 同一 IP + 同一口令 900 秒内第 11 次 |
| `429` | `该网络登录尝试过于频繁，请稍后再试` | 同一 IP 900 秒内第 41 次 |
| `403` | `人机校验未通过，请刷新页面后重试` / `人机校验未通过（未取到校验令牌），请刷新页面重试` / `人机校验分数过低，请稍后再试` | 见 1.3 |
| `401` | `口令错误` | 班级口令、游客口令、调试口令**都不匹配**。刻意不区分账号是否存在 |
| `500` | `服务端数据库未绑定（缺少 D1 绑定 DB）` | 部署问题 |

顺序上要注意：**`password` 长度校验（400）在限流之前**，所以输入 3 个字符得到的是 `400 班级口令至少 4 位`，而不是 401。

<!-- 出处：functions/api/login.js:27-202 -->

### 3.4 `POST /api/admin-login`

**身份**：完全公开。**限流**：`admin-login:{ip}` 8 次 / 900 秒。

**请求 body**：

| 字段 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `username` | string | **是** | 去首尾空白后非空且长度 **≤ 32** |
| `password` | string | **是** | 长度 **1~128** |

**响应 `200`**：`{ok:true, role:"super"|"admin"|…, username:"…"}` + `Set-Cookie: yczx_admin_session=…`。`role` 是数据库原始值（见 2.3）。

**失败**：

| 状态码 | 文案 |
|---|---|
| `400` | `请求格式不正确` |
| `429` | `尝试过于频繁，请 15 分钟后再试` |
| `401` | `账号或密码错误`（账号不存在时也走等价的一次哈希开销，不暴露账号是否存在） |
| `403` | `这是公开仓库里的示例口令，任何人都知道，已被拒绝登录。请先按 README 的「部署后必做」设置你自己的管理员密码（一条 SQL 即可），然后再登录。` |

`403` 那条的触发条件是：密码恰好等于示例口令 `admin888`，且没有显式配置 `ALLOW_DEFAULT_ADMIN_PASSWORD`。

**⚠️ 这个接口不校验 `recaptcha_token`**，代码里没有引用它。

<!-- 出处：functions/api/admin-login.js:21-86, _lib/defaults.js:20-34 -->

### 3.5 `POST /api/admin-register`

**身份**：完全公开，但必须持有有效的动态口令（邀请码）。**限流**：`admin-register:{ip}` 10 次 / 900 秒。

**请求 body**：

| 字段 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `username` | string | **是** | 先按 `maxLength 24` 收敛（去控制字符、合并空白、去 `<` `>`），再要求匹配 `/^[A-Za-z0-9_\u4e00-\u9fa5-]{2,24}$/`（中文/字母/数字/下划线/短横线） |
| `password` | string | **是** | 长度 **8~128** |
| `invite_code` | string | **是** | 会被归一化：转大写 + 去掉所有非 `[A-Z0-9]` 字符，所以 `XXXX-XXXX-XXXX` 与 `xxxxxxxxxxxx` 等价；归一化后为空则拒绝 |

**响应 `200`**：`{ok:true, message:"注册成功，请返回登录页用新账号登录"}`。
注册出来的账号**固定**是 `role='admin'`（普通管理员）—— 任何人都无法通过这个接口把自己变成高级管理员。

**失败**：

| 状态码 | 文案 |
|---|---|
| `400` | `请求格式不正确` |
| `400` | `账号格式不正确` / `账号不能为空` / `账号太长了（最多 24 个字符）` / `账号不能包含 < 或 >` |
| `400` | `账号只能用中文、字母、数字、下划线或短横线，长度 2–24 位` |
| `400` | `密码至少 8 位` / `密码最多 128 位` / `密码格式不正确` |
| `400` | `请填写动态口令` |
| `403` | `动态口令无效或已过期` |
| `403` | `该动态口令已经被用完了` |
| `409` | `该账号名已经被注册了，换一个吧` |
| `500` | `注册失败，请换一个账号名重试`（插入失败时会把刚占用的名额退回） |
| `429` | `尝试过于频繁，请 15 分钟后再试` |

**⚠️ 这个接口不校验 `recaptcha_token`**。

<!-- 出处：functions/api/admin-register.js:25-92, _lib/crypto.js:167-173, _lib/validate.js:24-31,63-69 -->

### 3.6 `POST /api/logout`

**身份**：完全公开（未登录也能调成功）。**请求 body**：不读。

**响应 `200`**：`{ok:true}`，并附带三个清空 Cookie（`Max-Age=0`）：`yczx_class_session`、`yczx_admin_session`、`yczx_session`。

**副作用**：删除当前请求携带的会话行；如果这条学生会话其实是**调试会话**，会连同该管理员名下的其它调试会话一起撤销。

**失败**：代码里未找到失败分支（`env.DB` 不存在时也照样回 200）。

<!-- 出处：functions/api/logout.js:15-31, _lib/auth.js:563-568,658-679,681-691 -->

### 3.7 `GET /api/announcements?scope=gate`

**身份**：完全公开 —— 它就是给还没进系统的人看的。**限流**：代码里未找到限流。

**请求 query**：`scope=gate`（精确匹配字符串 `'gate'`）。

**响应 `200`**：`{announcements:[{id, title, content, created_at}], scope:"gate"}`，最多 **5** 条，只含已上架（`is_active=1`）且 `scope='gate'` 的。

`GET /api/announcements` 的其它两种模式见 5.12。

**失败**：`500` `数据库尚未执行 003 迁移（缺少公告表），请先在 D1 控制台执行 sql/003_multi_admin_and_announcements.sql`。

<!-- 出处：functions/api/announcements.js:32-39,50-67 -->

### 3.8 `GET /api/music?status=1`

**身份**：完全公开。**限流**：代码里未找到限流（这一分支排在鉴权与限流之前）。

**响应 `200`**：`{configured:true, provider:"auto"|"meting"|"apple"}`。只回模式名，不泄露任何上游地址。

<!-- 出处：functions/api/music.js:2171-2175 (onRequestGet 的 status 分支) -->

### 3.9 `GET /api/music?probe=1`

**身份**：完全公开。**限流**：代码里未找到限流（同样排在鉴权与限流之前）。这是运维用的自检口子，**前端正常流程不要调它** —— 它会对每个音源真发请求，很慢。

**响应 `200`**：

```jsonc
{
  "build": "2026-10-07-d+migu-first",  // 线上跑的是哪份代码，排查"改了没生效"专用
  "provider": "auto",
  "migu":     { "ok": true, "count": 20, "resolvable": true, "bytes": 4123456, "durationSeconds": 270, "hint": "…" },
  "apple":    { "ok": true, "count": 20, "hint": "官方 30 秒试听" },
  "netease":  { "ok": true, "count": 20, "playableProbe": true, "hint": "…" },
  "gdstudio": { "ok": true, "count": 20, "bases": 1, "detail": [ { "index": 0, "ok": true, "count": 20, "resolvable": true } ] },
  "verdict": "at-least-one-source-works"   // 或 "all-sources-unreachable"
}
```

任一段抛异常时那一段变成 `{ok:false, count:0, error:"unreachable"}`；`resolvable` / `playableProbe` 可能是 `null`（探测失败）。注意 `gdstudio` 这个键名现在装的是**中转源（Meting 形状）**的探测结果，与名字不完全对应。

详细的模式说明见第 6 节。

<!-- 出处：functions/api/music.js:2178-2292 (probe 分支) -->

---

## 4. 学生端接口（班级会话）

这一节所有接口都要求**学生的班级会话**（`subject='class'`）。游客持有同一个 Cookie，所以能进只读接口，写接口会被 `denyGuest` 拦下（见 2.5）。

### 4.1 `GET /api/me`

**身份**：班级会话（游客可读）。**限流**：代码里未找到限流。

**请求**：无参数。

**响应 `200`**：

```jsonc
{
  "ok": true,
  "role": "class" | "guest" | "test" | "debug",  // 普通学生是 "class"；测试口令是 "test"
  "isGuest": false,
  "className": "高一(3)班",                 // 游客/游客口令是 "游客模式"，测试口令是 "测试口令"，调试身份是 "调试模式"
  // 仅真实班级会话才带的拦截信息（游客/测试/调试为 null）：
  "limits": {
    "paused": false,        // 本班是否被管理员暂停（暂停 = 投稿投票都拦）
    "voteLimit": 0,         // 0 = 不限；>0 = 本班投票达到该值后 upvote 403
    "voteUsed": 3,          // 本班当前累计投票数
    "submitLimit": 0,       // 0 = 不限；>0 = 本班投稿达到该值后 vote 403
    "submitUsed": 1         // 本班当前累计投稿数
  },
  // 仅非游客非调试的会话下发（全站投稿总量上限的预判信息）：
  "globalSubmit": { "cap": 100, "used": 42 }   // cap=0 表示未启用
}
```

**失败**：`401` `{"error":"登录已过期，请重新登录"}`。

用途说明：**让前端"问一次"就知道自己是谁，而不是"试一次写操作看会不会 403"**。判断该不该置灰按钮请用这个接口的 `isGuest` 与 `limits`，不要去试写操作。

<!-- 出处：functions/api/me.js:21-50 -->

### 4.2 `GET /api/rank`

**身份**：班级会话（游客可读）。**限流**：代码里未找到限流。

**请求 query**：

| 参数 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `status` | string | 否 | 只认 `'approved'` 与 `'pending'`，默认 `'approved'`；其它值返回 400 |

**响应 `200`（`status=approved`，正式榜）**：直接是一个数组，最多 **50** 条：

```jsonc
[
  {
    "id": 12, "title": "晴天", "artist": "周杰伦",
    "status": "approved",
    "track_id": "mg-600902000006889366",  // 可能为 null / 空（009 迁移前的老数据）
    "category_name": "中文歌",
    "category_weight": 80
  }
]
```

⚠️ **正式榜的响应里完全没有 `votes` 字段** —— 票数在服务端就不下发。排序是「分类权重降序 → 有效票数降序 → id 升序」，而权重与有效票数都在 SQL 里用掉了，不下发。

**响应 `200`（`status=pending`，待审核榜）**：数组，最多 **50** 条：

```jsonc
[
  {
    "id": 34, "title": "雨爱", "artist": "杨丞琳",
    "status": "pending",
    "track_id": "mt-2712018330",
    "votes": 12,             // 已按投票上限封顶后的值
    "is_reported": 0,        // 1 = 被举报过
    "category_weight": 80,
    "category_name": "中文歌",
    // 仅当原始票数超过上限时才会多出这两个字段：
    "votes_raw": 99,
    "votes_capped": 1
  }
]
```

- 排序综合分 = `有效票数 × (100 + 分类权重)`，其中**有效票数 = `MIN(votes, 投票上限)`**（上限为 0 表示不限）。`votes_raw` / `votes_capped` **只在票数被截断时出现**，前端按"有没有这两个键"判断即可。
- 榜单是**全校共用**的，不按班级过滤：歌曲记录里的 `class_id` 只标注"是哪个班点的"，不参与可见性。
- 调试身份提交的歌（`is_debug=1`）不会出现在学生榜上。

**失败**：`401`（会话过期）；`400` `{"error":"status不正确"}`。

<!-- 出处：functions/api/rank.js:28-125, _lib/settings.js:57-61,81-95 -->

### 4.3 `POST /api/vote` —— 点歌提交

**身份**：班级会话。**游客 → `403`**（文案见 2.5）。**限流**：`vote` 30/小时 + IP 600/小时。

**这个接口是本项目校验最密的写接口**。校验顺序（前端按这个顺序处理错误体验最好）：

1. 会话（401）
2. 游客闸门（403）
3. 「暂停接收投稿」闸门（403）
4. 读请求体（400）
5. 限流（429）
6. reCAPTCHA（403）
7. PoW（403）
8. `fingerprint` 格式（400）
9. `request_id` 格式（400）
10. **选曲凭据 `track_token`（400）** ← 强制，没有凭据就点不了歌
11. `category_id`（400）
12. 违禁词（403）
13. 库内查重（400）
14. 每周一次名额（429）

**请求 body**：

| 字段 | 类型 | 必填 | 约束与说明 |
|---|---|---|---|
| `fingerprint` | string | **是** | 浏览器指纹 hex 摘要，必须匹配 `/^[0-9a-f]{16,64}$/`（会被转小写）。用于限流身份键与"每人每周一次"的去重 |
| `track_token` | string | **是** | 选曲凭据。也接受别名 `trackToken` 与 `token`（三者语义完全相同，按这个顺序取第一个非空字符串）。**字段存在但不是字符串**会直接 400。格式 `v1.<base64url>.<base64url>`，最长 1024 字符，有效期 **2 小时** |
| `category_id` | number | 否 | 正整数，`≤ 100000`，默认 `2`。必须真实存在于 `categories` 表，否则 400 |
| `recaptcha_token` | string | 否 | 见 1.3 降级表 |
| `pow` | object | 否 | `{challenge: string, nonce: string}`；功能未启用时传 `null` 即可。`challenge` ≤ 400 字符、`nonce` ≤ 128 字符 |
| `request_id` | string | 否 | 幂等键，必须匹配 `/^[A-Za-z0-9_-]{8,64}$/`。不传 / 空串 = 走老行为；格式非法 = 400 |
| `client_id` | string | 否 | 仅用于限流身份键（`fingerprint` 缺位时的近似身份）。服务端只检查它是不是字符串，**不校验格式与长度** |
| `title` / `artist` / `track_id` | — | 否 | **接收但完全不用**：最终入库的歌名/歌手/音源 id 一律取自 `track_token` 里的内容。现有前端仍会带上，只用于排查时对照 |

**关于 `track_token`（很重要）**：
- 它**不是可选**的。"没带凭据走老规则"的兼容分支已被删除，所以**没有有效凭据就点不了歌**。
- 服务端**以凭据内容为准**：请求体里的 `title` / `artist` / `track_id` 一个字节都不会入库。所以前端不需要（也不能）靠这三个字段影响结果。
- 从哪里拿：`GET /api/music?q=…` 的每个候选都带 `token` 与 `track_token`（同一个值，两个键）。把用户选中那条的凭据存起来提交即可。
- 凭据内容在入库前**照常**重新过一遍 `sanitizeText` / 违禁词 / 音源前缀白名单，签名不等于免检。

**响应 `200`**：

```jsonc
{ "ok": true }                                    // 正常提交
{ "ok": true, "debug": true, "message": "调试模式：已提交（不占用每周额度、不查重）" }
{ "ok": true, "duplicate": true, "counted": false, "message": "这次点歌之前已经提交成功了（幂等重放，未重复计入）" }
```

第三种只在**带了 `request_id`** 且服务端判断"这次动作其实已经生效过"时出现。`counted:false` 明确表示**没有产生任何新的副作用**。

**失败**：

| 状态码 | 文案 | 条件 |
|---|---|---|
| `401` | `登录已过期，请重新登录` | 会话无效 |
| `403` | `游客模式只能查看排行，不能投稿` | 游客 |
| `403` | `广播站现在暂停接收投稿，请稍后再来` | 管理员按下了「暂停接收投稿」（调试身份同样被拦） |
| `403` | `本班级已被暂停投稿与投票，请联系广播站管理员` | 班级管理页暂停了本班（调试身份不拦） |
| `403` | `本班级投稿数量已达上限，暂时无法继续投稿` | 本班投稿数达到「班级投稿上限」（0/空 = 不限） |
| `403` | `站点投稿总数量已达上限，暂无法提交投稿` | 全站累计投稿达到「全站投稿总量上限」。**双重校验先班级后全站**，先命中的先报 |
| `400` | `请求格式不正确` | 非 JSON / body 不是对象 |
| `429` | `提交过于频繁，请稍后再试` | 限流 |
| `403` | `人机校验未通过，请刷新页面后重试` / `人机校验未通过（未取到校验令牌），请刷新页面重试` / `人机校验分数过低，请稍后再试` | reCAPTCHA |
| `403` | `人机校验未通过，请刷新页面重试` / `校验已过期，请刷新页面重试` | PoW |
| `400` | `指纹缺失` / `指纹格式不正确` | `fingerprint` |
| `400` | `请求标识不正确` | `request_id` 格式非法 |
| `400` | `选曲凭据不正确，请重新搜索并选一首再提交` | 凭据不是字符串 / 空 / 超过 1024 字符 |
| `400` | `选曲凭据格式不正确，请重新搜索并选一首再提交` | 分段数不是 3 / 版本前缀不是 `v1` / base64 解不开 |
| `400` | `选曲凭据校验失败，请重新搜索并选一首再提交` | 签名不匹配 |
| `400` | `选曲凭据内容已损坏，请重新搜索并选一首再提交` | JSON 解不开 / 不是对象 / 缺 `e` |
| `400` | `选曲凭据已过期，请重新搜索并选一首再提交` | 超过 2 小时 |
| `400` | `选曲凭据内容不合法，请重新搜索并选一首再提交` | 凭据里的歌名/歌手/音源 id 过不了入库校验 |
| `400` | `缺少选曲凭据：请先点「搜索歌曲」，从搜索结果里选一首再提交` | 完全没带凭据 |
| `400` | `分类不正确` / `分类不存在` | `category_id` |
| `403` | `包含违禁词「<关键词>」<：原因>` | 歌名+歌手拼起来命中黑名单（`reason` 为空时没有冒号那一段） |
| `400` | `这首歌已经在待审核队列里啦` | 同名同歌手已在 pending |
| `400` | `这首歌已经进曲库啦，快去投票吧` | 同名同歌手已 approved |
| `400` | `该歌曲在往期审核中已被过滤` | 同名同歌手已 rejected |
| `429` | `您本周已经点过歌啦，每人每周只能点一次哦！` | 这台设备（`ip` + `fingerprint`）7 天内已占过名额。**注意是 429 而不是 400** |
| `500` | `提交未生效，且插入的歌曲未能撤回，请联系管理员核查（请勿重复提交）` | 补偿失败 |
| `500` | `提交未生效，且本周名额未能释放，请联系管理员核查` | 补偿失败 |

**调试身份（`role='debug'`）的差异**：跳过"每周一次"和查重，提交的歌标记 `is_debug=1`；仍然过违禁词，**仍然要求选曲凭据**。

**去重语义**：每周一次是按 `(ip, fingerprint)` 计的，7 天窗口；查重是**全校范围**的 `(title, artist)`。

<!-- 出处：functions/api/vote.js:38-310,332-375,377-413, _lib/validate.js:24-31,37-41,55-60,63-69,141-153, _lib/tracktoken.js:40,123-140,151-213, _lib/idempotency.js:37,45-54, _lib/auth.js:151-154, _lib/settings.js:112-114 -->

### 4.4 `POST /api/upvote` —— 投票

**身份**：班级会话。**游客 → `403` `游客模式只能查看排行，不能投票`**。**限流**：`upvote` 30/小时 + IP 600/小时。

**请求 body**：

| 字段 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `id` | number | **是** | 歌曲 id，正整数（`> 0`，`≤ Number.MAX_SAFE_INTEGER`） |
| `fingerprint` | string | **是** | `/^[0-9a-f]{16,64}$/`。**去重按指纹，不是按班级** —— 一台设备对一首歌只能投一次 |
| `recaptcha_token` | string | 否 | 见 1.3 |
| `pow` | object | 否 | `{challenge, nonce}`，`action` 必须是 `'upvote'` |
| `request_id` | string | 否 | `/^[A-Za-z0-9_-]{8,64}$/` |
| `client_id` | string | 否 | 仅用于限流身份键 |

校验顺序：会话 → 游客 → 读 body → **reCAPTCHA → PoW** → `id` → `fingerprint` → `request_id` → **限流** → 歌曲存在 → 占位 → 计数。

**响应 `200`**：

```jsonc
{ "ok": true, "counted": true }                     // 正常，票数已 +1
{ "ok": true, "duplicate": true, "counted": false, "message": "这次投票之前已经记录过了（幂等重放，未重复计票）" }
```

第二种只在带了 `request_id` 时出现（没带时同样的情形返回的是下面的 429）。

**失败**：

| 状态码 | 文案 |
|---|---|
| `401` | `登录已过期，请重新登录` |
| `403` | `游客模式只能查看排行，不能投票` |
| `403` | `本班级已被暂停投稿与投票，请联系广播站管理员`（班级管理页暂停了本班；调试身份不拦） |
| `403` | `本班级投票数已达上限，暂时无法继续投票`（达到「班级投票上限」；0/空 = 不限。**投票没有全站上限**，只有班级维度） |
| `400` | `请求格式不正确` |
| `403` | `人机校验未通过，请刷新页面后重试` / `人机校验未通过（未取到校验令牌），请刷新页面重试` / `人机校验分数过低，请稍后再试` |
| `403` | `人机校验未通过，请刷新页面重试` / `校验已过期，请刷新页面重试`（PoW） |
| `400` | `歌曲不正确` / `指纹缺失` / `指纹格式不正确` / `请求标识不正确` |
| `429` | `投票过于频繁，请稍后再试` |
| `404` | `这首歌不在待审核列表中` |
| `429` | `你已经给这首歌投过票啦`（**没带** `request_id` 时的重复投票） |
| `409` | `这首歌的状态刚刚发生了变化（可能已被审核），本次投票没有计入，请刷新后重试` |
| `500` | `投票未计入，且投票记录回滚失败，请联系管理员核查` |

<!-- 出处：functions/api/upvote.js:32-141 -->

### 4.5 `POST /api/report` —— 举报

**身份**：班级会话。**游客 → `403` `游客模式只能查看排行，不能举报`**。**限流**：`report` 20/小时 + IP 600/小时（限流排在读 body 之前之后均有涉及，实际顺序：会话 → 游客 → 读 body → 限流 → reCAPTCHA → 校验 → 占位）。

**请求 body**：

| 字段 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `id` | number | **是** | 歌曲 id，正整数 |
| `reason` | string | 否 | 举报原因，按 `sanitizeText` 收敛：`maxLength 60`、不能为空串、不能含 `<` `>`。为空 / 不传 / 不是非空字符串都不报错，落库为空串 |
| `fingerprint` | string | 否 | 只用于限流身份键。格式非法时**不报错**，只是退化成按会话/ IP 计额度 |
| `client_id` | string | 否 | 只用于限流身份键 |
| `recaptcha_token` | string | 否 | 见 1.3 |

**没有** `pow`、**没有** `request_id`、**没有** `track_token`。

**响应 `200`**：`{ok:true}`。

**失败**：

| 状态码 | 文案 |
|---|---|
| `401` / `403` | 见上 |
| `400` | `请求格式不正确` |
| `429` | `操作过于频繁，请稍后再试`（限流） |
| `403` | reCAPTCHA 三种文案 |
| `400` | `歌曲不正确` / `举报原因太长了（最多 60 个字符）` / `举报原因不能包含 < 或 >` |
| `404` | `这首歌不在待审核列表中` |
| `429` | `你已经举报过这首歌啦`（同一**班级**对同一首歌只能举报一次） |

**去重语义与投票不同**：举报用 `report_logs` 的 `(class_id, song_id)` 唯一索引占位，所以是"一个班一次"，不是"一台设备一次"。

<!-- 出处：functions/api/report.js:17-81 -->

### 4.6 `POST /api/suggest` —— 提版本建议

**身份**：班级会话。**游客 → `403` `游客模式只能查看排行，不能提建议`**。**限流**：`suggest` 20/小时（身份键退化到会话维度，因为这个接口没读 `fingerprint`）+ IP 600/小时。

⚠️ 限流发生在**读请求体之前**，所以 body 格式错误时额度也已经扣过了。

**请求 body**：

| 字段 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `song_id` | number | **是** | 歌曲 id，正整数；歌必须存在 |
| `content` | string | **是** | 建议内容，`sanitizeText`：`maxLength 120`、非空、不能含 `<` `>` |
| `recaptcha_token` | string | 否 | 见 1.3 |

**没有** `pow` / `request_id` / `track_token` / `fingerprint`。

**响应 `200`**：`{ok:true, message:"建议已提交，管理员会在后台看到"}`。

**失败**：

| 状态码 | 文案 |
|---|---|
| `401` / `403` | 见上 |
| `429` | `建议提得有点频繁，请稍后再试` |
| `400` | `请求格式不正确` |
| `403` | reCAPTCHA 三种文案 |
| `400` | `歌曲不正确` / `建议内容不能为空` / `建议内容太长了（最多 120 个字符）` / `建议内容不能包含 < 或 >` / `建议内容格式不正确` |
| `404` | `这首歌不存在` |
| `500` | `数据库尚未执行 011 迁移（缺少歌曲建议表），请先在 D1 控制台执行 sql/011_song_suggestions.sql` |

<!-- 出处：functions/api/suggest.js:52-105 -->

---

## 5. 管理员接口

### 5.0 权限分级一览

| 级别 | 判定函数 | 含义 |
|---|---|---|
| 管理员（普通及以上） | `requireAdmin()`（不限角色）/ `requireStaff()`（`super` + `admin`） | 登录了管理员会话即可 |
| 高级管理员 | `requireSuper()`（只认 `super`） | |

**角色以数据库当前值为准，不是登录时缓存在会话里的值**。所以给账号加上 `super` 之后，旧会话立刻按新角色生效。空值与任何无法识别的角色值一律按**普通管理员**处理。

<!-- 出处：_lib/auth.js:499-560 -->

### 5.1 `GET /api/admin-list`

**身份**：管理员（普通/高级皆可）。**限流**：代码里未找到限流。

**请求 query**：

| 参数 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `status` | string | 否 | 只认 `'pending'` / `'approved'` / `'rejected'`，默认 `'pending'` |

**响应 `200`**：数组，最多 **100** 条：

```jsonc
[
  {
    "id": 34, "title": "雨爱", "artist": "杨丞琳",
    "track_id": "mg-600902000006889366",   // 列不存在时补 NULL，字段集合始终稳定
    "votes": 12,
    "class_id": 3, "category_id": 1,
    "is_reported": 0,
    "is_debug": 0,                          // 1 = 调试模式提交
    "created_at": "2026-10-07 12:00:00",
    "category_name": "纯音乐",
    "playable": true                        // true / false / null，见下
  }
]
```

- `playable` 三种取值语义不能混：`true` 确认能播 / `false` 确认**所有**路都拿不到音频 / `null` **不确定**（前端不要标"无音频"）。它是服务端**一次问完**的（带 10 分钟缓存 + 条数上限 + 总截止时间），前端不要自己逐条去问 `/api/music?check=`。
- 排序：`pending` 时「被举报的优先 → 综合分（有效票数 × (100+权重)）降序 → 有效票数降序 → id 降序」；其它状态按 `created_at` 降序。
- 调试模式（`is_debug=1`）的歌，若与某首正式歌同名同歌手，则**不显示**（避免刷屏）。

**失败**：`401` / `403`（见 2.4）；`400` `{"error":"status不正确"}`。

<!-- 出处：functions/api/admin-list.js:39-132, _lib/playable.js:190-234 -->

### 5.2 `POST /api/admin-action`

**身份**：`requireStaff`（普通/高级皆可）。

**请求 body**：

| 字段 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `type` | string | **是** | 白名单：`approve` / `reject` / `restore` / `clear_report` / `delete` / `empty_recycle` |
| `id` | number | 除 `empty_recycle` 外**必填** | 歌曲 id，正整数 |

**响应 `200`**：

| `type` | 响应 | 效果 |
|---|---|---|
| `approve` | `{ok:true, status:"approved"}` | 进入正式榜 |
| `reject` | `{ok:true, status:"rejected"}` | 进回收站 |
| `restore` | `{ok:true, status:"pending"}` | 回到待审核 |
| `clear_report` | `{ok:true, action:"clear_report"}` | 清掉 `is_reported` 标记 |
| `delete` | `{ok:true, message:"已彻底删除「<歌名>」"}` | 彻底删除，并清理投票/举报/建议/周歌单引用 + 扫一遍历史孤儿记录 |
| `empty_recycle` | `{ok:true, deleted:<条数>}` | 清空全部 `status='rejected'` 的歌 + 同样的引用清理与孤儿清扫 |

**失败**：`400` `未知操作` 相关的是 `{"error":"操作不正确"}`（`type` 不在白名单）；`400` `{"error":"歌曲不正确"}`；`404` `{"error":"歌曲不存在"}`。

<!-- 出处：functions/api/admin-action.js:28-171 -->

### 5.3 `GET /api/admin-reports`

**身份**：`requireStaff`。

**请求**：无参数。

**响应 `200`**：

```jsonc
{
  "threshold": 3,              // 当前阈值（2~20）
  "defaultThreshold": 3,
  "available": true,           // false = 008 迁移没跑，收件箱不可用（此时 reports 为空）
  "reports": [
    {
      "song_id": 34, "title": "雨爱", "artist": "杨丞琳",
      "votes": 12, "category_name": "中文歌",
      "report_count": 4,
      "first_at": "…", "last_at": "…",
      "details": [ { "reason": "不是原唱", "class_name": "高一(3)班", "created_at": "…" } ]
    }
  ]
}
```

只有「未被处理 + 歌仍在 pending + 举报班级数 ≥ `threshold`」的歌才会进来，最多 **50** 首。

<!-- 出处：functions/api/admin-reports.js:22-103, _lib/settings.js:98-103 -->

### 5.4 `POST /api/admin-reports`

**身份**：`requireStaff`。

**请求 body**：`{action:"handle", song_id:<正整数>}`（`action` 必须是 `handle`）。

**响应 `200`**：`{ok:true, handled:<条数>, message:"已标记为处理（<条数> 条举报）"}`，并顺手清掉歌曲上的 `is_reported`。

**失败**：`400` `{"error":"未知操作"}`（`action` 不对）；`400` `{"error":"歌曲不正确"}`；`500` `{"error":"数据库尚未执行 008 迁移（缺少 handled_at 列），请先执行 sql/008_report_inbox.sql"}`。

<!-- 出处：functions/api/admin-reports.js:105-141 -->

### 5.5 `POST /api/admin-update`

**身份**：`requireAdmin`（**不限**角色）。改某首歌的分类。

**请求 body**：`{id:<正整数>, category_id:<正整数>}`，两者都必填；`category_id` 必须真实存在于 `categories`。

**响应 `200`**：`{ok:true}`。

**失败**：`400` `{"error":"歌曲不正确"}` / `{"error":"分类不正确"}` / `{"error":"分类不存在"}`；`404` `{"error":"歌曲不存在"}`。

<!-- 出处：functions/api/admin-update.js:7-33 -->

### 5.6 `GET /api/admin-settings`

**身份**：`requireStaff`（普通/高级都能读；只有高级管理员能看到班级口令明文）。**限流**：代码里未找到限流。

**响应 `200`**：

```jsonc
{
  "classes": [
    { "id": 1, "name": "高一(3)班", "grade": "高一", "member_count": 50, "password": null }
  ],
  "banned": [ { "id": 3, "type": "keyword", "keyword": "某某", "reason": "管理员封禁", "expire_at": "2099-12-31 23:59:59" } ],
  "categories": [ { "id": 1, "name": "纯音乐", "weight": 100 } ],
  "currentAdminId": 1,
  "vote": { "cap": 50, "capConfigured": true, "capRaw": "50", "totalMembers": 300 },
  "report": { "threshold": 3, "defaultThreshold": 3 },
  "submit": { "paused": false },
  "security": {
    "pepperConfigured": true,
    "canViewPasswords": true,
    "canViewPasswordsReason": "",
    "hasClassMeta": true,
    "role": "super",
    "isSuper": true
  }
}
```

要点：
- `classes[].password` **只对高级管理员出现**，且只在 `security.canViewPasswords === true` 时才是明文（否则是 `null`）。普通管理员的 `classes[]` 里没有 `password` 键。
- `canViewPasswords` 要求部署方真的配了私有 `AUTH_PEPPER`；没配时整个功能禁用，`canViewPasswordsReason` 给出中文原因。
- `vote.cap === 0` 表示不限制；`vote.capRaw` 是原始设置值（字符串）。
- `currentAdminId` 是**当前登录管理员自己**的 id，用来判断列表里"哪一行是我"。
- `security.hasClassMeta` 表示 007 迁移（年级/人数/投票上限）是否已跑；`false` 时 `classes[].grade` 是 `''`、`member_count` 是 `null`。

**失败**：`401` / `403`。

<!-- 出处：functions/api/admin-settings.js:58-171 -->

### 5.7 `POST /api/admin-settings`

**身份**：**按 `action` 分**：

- `add_banned`、`delete_banned`、`change_admin_password` → `requireStaff`（普通管理员即可）
- **其它所有 `action`** → `requireSuper`（仅高级管理员）

未知 `action` 由高级管理员分支处理，返回 `400` `{"error":"未知操作"}`。

**请求 body**：`{action: "<下面之一>", …}`。

| `action` | 权限 | 其余字段 | 响应 / 失败 |
|---|---|---|---|
| `add_class` | super | `name`（string，`sanitizeText` maxLength 30）、`password`（string，6~128）、`grade`（string，可选，maxLength 20）、`member_count`（number，可选，整数 0~10000） | `200 {ok:true, message:"已添加班级口令"}`；`409` 班级同名 `班级「X」已经存在了`；`409` 口令被占用（一段多行长文案，说明"所有班共用一个口令"在数据库层不成立）；`500 添加失败：数据库结构可能尚未迁移` |
| `delete_class` | super | `id`（正整数） | `200 {ok:true, message:"已删除该班级口令"}`（同时让该班会话全部失效）；`400 至少要保留一个班级口令，否则将无法登录`；`404 班级不存在` |
| `delete_classes` | super | `ids`（数组，最多 200 个正整数，自动去重） | `200 {ok:true, deleted:N, message:"已删除 N 个班级口令"}`；`400 请先勾选要删除的班级` / `一次最多删除 200 个班级` / `当前共 N 个班级口令，至少要保留 1 个否则将无法登录，请少选几个` |
| `update_class_password` | super | `id`、`new_password`（6~128） | `200 {ok:true, message:"口令已更新，原登录状态已失效"}`；`404 班级不存在`；`409 该口令已被其他班级使用，请换一个`；`500 修改失败` |
| `add_banned` | **staff** | `keyword`（必填，**最多 12 字**）、`reason`（可选，maxLength 60，默认 `管理员封禁`）、`expire_at`（可选，必须匹配 `^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$`，默认 `2099-12-31 23:59:59`） | `200 {ok:true, message:"已把违禁词「X」加入黑名单"}`；`400 违禁词最多 12 个字。黑名单是用来封违禁词的，不是用来封某一首歌的 —— 要下架某首歌，请到「待审核 / 回收站」里处理。`；`400 过期时间格式应为 YYYY-MM-DD HH:MM:SS` |
| `delete_banned` | **staff** | `id` | `200 {ok:true, message:"已移出黑名单"}`；`404 记录不存在` |
| `update_category_weight` | super | `id`、`weight`（整数 0~1000） | `200 {ok:true, message:"权重已更新，正式榜单排序立即生效"}`；`400 权重必须是 0 到 1000 之间的整数`；`404 分类不存在` |
| `set_vote_cap` | super | `cap`（整数 0~1000000；`''` / `null` / 不传 都当 0） | `200 {ok:true, cap, message}`；`400 投票上限需要是 0 到 1000000 之间的整数（0 表示不限制）`；`500 …尚未执行 007 迁移…` |
| `set_submissions_paused` | super | `paused`（`true` / `1` / `'1'` 算暂停，其余算恢复） | `200 {ok:true, paused, message}`；`500 …尚未执行 007 迁移…` |
| `set_report_threshold` | super | `threshold`（整数 2~20） | `200 {ok:true, threshold, message:"已设置：被 N 个以上班级举报的歌才会进入收件箱"}`；`400 举报阈值需要是 2 到 20 之间的整数` |
| `update_class_info` | super | `id`、`grade`（可选，maxLength 20）、`member_count`（可选，整数 0~10000） | `200 {ok:true, message:"已保存该班级的年级与人数"}`；`404 班级不存在`；`500 …尚未执行 007 迁移（缺少 grade / member_count 列）…` |
| `set_class_limits` | super | `id`、`vote_limit`（`''`=不限 / `^\d{1,7}$` / `x*系数`，系数 1~3 位小数）、`submit_limit`（同左） | `200 {ok:true, message:"已保存该班级的投票与投稿上限"}`。表达式 `x` = 本班人数。需要 015 迁移的 `vote_limit`/`submit_limit` 列 |
| `set_class_paused` | super | `id`、`paused`（truthy=暂停） | `200 {ok:true, paused, message}`。暂停后该班投票投稿都是 403，**不杀已有会话**（前端用 `/api/me` 的 `limits.paused` 预判） |
| `set_submit_cap` | super | `cap`（`''`=关闭 / 固定数字 / `x*系数`，x=全站有效班级总人数） | `200 {ok:true, message}`。写入 `system_settings.submit_cap`；全站累计投稿 ≥ 上限后 `/api/vote` 403 |
| `change_admin_password` | **staff** | `current_password`（1~128）、`new_password`（8~128，不能与当前相同） | `200 {ok:true, message:"密码已更新，其它设备上的登录已失效"}`；`400 新密码不能与当前密码相同`；`401 当前密码不正确`；`404 账号不存在`。**只作用于会话本人**：函数内部用会话里的 id 定位账号，前端传什么 id 都没用 |

`member_count` 的非法值统一回 `400 人数需要是 0 到 10000 之间的整数`。所有 `parsePositiveInt` 失败都回 `400 {"error":"<字段>不正确"}`。

**权限不够时**：`403` `{"error":"当前角色无权执行该操作"}`。

<!-- 出处：functions/api/admin-settings.js:173-224,269-646, _lib/validate.js:105-117 -->

### 5.8 `POST /api/announcements`

**身份**：`requireAdmin(env, request, ['super','admin'])`（普通管理员及以上）。**限流**：代码里未找到限流。

**请求 body**：`{action, …}`，`action` ∈ `create` / `update` / `toggle` / `delete`，否则 `400 {"error":"未知操作"}`。

**字段约束**（`create` 与 `update` 共用）：

| 字段 | 类型 | 约束 |
|---|---|---|
| `title` | string | **必填**，`sanitizeText` maxLength 40 |
| `content` | string | **必填**，多行文本 `sanitizeMultiline` maxLength 500（保留换行，连续空行最多两行） |
| `scope` | string | 可选，只认 `'gate'` / `'app'` / `'popup'`，**非法值回落到 `'app'`**（不报错） |
| `id` | number | `update` / `toggle` / `delete` 必填，正整数 |
| `is_active` | number\|string\|bool | `toggle` 必填，白名单 `[0, 1, '0', '1', true, false]` |

**响应 `200`**：

| `action` | 响应 |
|---|---|
| `create` | `{ok:true, message}` —— `scope='gate'` 时是「登录页公告已发布（未登录也能看到）」，`scope='popup'` 时是「弹窗公告已发布（学生登录后会看到，点「知道了」关闭）」，否则「公告已发布」 |
| `update` | `{ok:true, message:"公告已更新"}` |
| `toggle` | `{ok:true, message:"公告已上架"}` 或 `{ok:true, message:"公告已下架"}` |
| `delete` | `{ok:true, message:"公告已删除"}` |

**失败**：`400` 各种字段错误（`公告标题不能为空` / `公告内容太长了（最多 500 个字符）` / `公告标题不能包含 < 或 >` …）；`400 状态不正确`（`is_active` 非法）；`400 公告不正确`（`id` 非法）；`404 公告不存在`；`500` 003 迁移提示。

<!-- 出处：functions/api/announcements.js:137-245 -->

### 5.9 `POST /api/schedule`

**身份**：`requireStaff`（普通/高级皆可）。

游客的专门文案：先跑 `requireStaff`，**再**认一次游客身份 —— 如果同时持有管理员 Cookie 的浏览器（一边登后台一边开着游客会话）仍然能正常排期，不会被误伤。如果确实是游客会话，返回 `403` `{"error":"游客模式只能查看排行，不能排期"}`；否则回 `requireStaff` 的标准 401/403。

**请求 body**：`{action, …}`，`action` ∈ `autofill` / `set_slot` / `clear_slot` / `clear_week` / `set_mode` / `set_block_count` / `insert_slot` / `move_slot`，否则 `400 {"error":"未知操作"}`。

日期字段统一要求 `^\d{4}-\d{2}-\d{2}$` 且是**有效日期**（会做 `toISOString` 回读校验），失败文案 `周起始日格式应为 YYYY-MM-DD` / `周起始日不是有效日期`（`autofill` 用的是「起始周」）。日期会按 UTC 折算到**所在周的周一**。

| `action` | 字段 | 响应 |
|---|---|---|
| `autofill` | `week_start`（必填日期）、`weeks`（可选整数 1~12，默认 1；非法值静默按 1 处理） | `200 {ok:true, weekStart, weeks, filled, total, reused, message}`。一周 6 首（中午 3 首含歌词 + 下午 3 首纯音乐）。默认排除已排过的歌；歌不够时允许重复并在 `message` 里如实报告 `reused` |
| `set_slot` | `week_start`（也接受别名 `date`，必填）、`period`（必填，只认 `'noon'` / `'afternoon'`）、`position`（必填正整数，**最大 3**）、`song_id`（必填正整数，歌必须 `status='approved'`） | `200 {ok:true, message:"已排入该位置"}`；`400 只能排已通过审核的歌`；`400 时段不正确` / `位置不正确` / `歌曲不正确` |
| `clear_slot` | `week_start`、`period`、`position`（同 `set_slot`） | `200 {ok:true, message:"已清空该位置"}`；`404 这个位置还不存在` |
| `clear_week` | `week_start`（必填日期） | `200 {ok:true, deleted:<条数>, message:"已清空这一周"}` |
| `set_mode` | `mode`（`'both'`=上下午 / `'noon'`=仅上午）、`week_start`（可选） | `200 {ok:true, mode, released}`。切到 `noon` 时把 **`week_start` 那一周**的下午排期整段退回待排（其它周保留，`released` = 退回条数）；公共接口随之只返回 `periods:["noon"]` |
| `set_block_count` | `period`、`count`（1~12）、`week_start` | `200 {ok:true, count, released}`。**只减不增**：当前已排 > count 时从**末尾**退回（`released` 条），已排 ≤ count 时不补位 |
| `insert_slot` | `week_start`、`period`、`position`、`song_id`（必须 approved，或排期自定义歌） | `200 {ok:true}`。插入到第 `position` 位，**其后曲目整体后移一位**；该时段已满（≥ 当前配置数量）时 `400 已排满`。实现是整段重写（batch 事务），不会出现半插状态 |
| `move_slot` | `week_start`、`period`、`from`、`to` | `200 {ok:true}`。同一时段内把第 `from` 位移动到第 `to` 位，其余顺序相应让位 |

`500 数据库尚未执行 012 迁移（缺少每周歌单表），请先在 D1 控制台执行 sql/012_weekly_schedule.sql` 覆盖整段。

`GET /api/schedule` 的响应（5.13）新增：`schedule: {mode, noonCount, afternoonCount}`（播放模式与每周数量配置，缺省 both/3/3）；`periods` 与 `perWeek` 随模式变化（仅上午时 `periods:["noon"]`）。

<!-- 出处：functions/api/schedule.js:122-152,160-313 -->

### 5.10 `GET /api/suggest?song_id=`

**身份**：`requireStaff`。

**请求 query**：`song_id` **必填**，正整数（游客连门都进不去，不需要额外处理）。

**响应 `200`**：`{suggestions:[{id, content, created_at, class_name}]}`，只含 `handled_at IS NULL` 的，按 id 降序，最多 **100** 条。

**失败**：`400 {"error":"歌曲不正确"}`；`401`/`403`；`500` 011 迁移提示。

<!-- 出处：functions/api/suggest.js:20-50 -->

### 5.11 `PUT /api/suggest`

**身份**：`requireStaff`。

**请求 body**：`{song_id:<正整数>}`（必填）。**这个方法不校验 reCAPTCHA**（管理员已经过一整轮登录鉴权）。

**响应 `200`**：`{ok:true, handled:<被更新的行数>, message:"建议已标记为处理"}`。`handled` 可能是 `0`（该歌本来就没有未处理建议），这不是错误。

**失败**：`400 {"error":"歌曲不正确"}`；`500` 011 迁移提示。

<!-- 出处：functions/api/suggest.js:107-130 -->

### 5.12 `GET /api/announcements`（另外两种模式）

**模式二：`?all=1`（后台管理用）**

- **身份**：明确要求**管理员会话**（`requireAdmin(env, request, ['super','admin'])`）。这一条路径**不看学生会话**，否则"同时登录学生与管理员"的浏览器会拿到只含已上架的列表，下架的公告在管理界面里凭空消失。
- **响应 `200`**：`{announcements:[{id, title, content, created_by_name, scope, is_active, created_at, updated_at}]}`，含已下架，`is_active` 降序、id 降序，最多 **100** 条。

**模式三：无参数（首页）**

- **身份**：班级会话**或**管理员会话（`requireSession(env, request, null)`），游客也可以。
- **响应 `200`**：

```jsonc
{
  "announcements": [ { "id": 1, "title": "…", "content": "…", "created_by_name": "admin", "created_at": "…" } ],
  "popups":        [ { "id": 5, "title": "…", "content": "…", "created_by_name": "admin", "created_at": "…" } ]
}
```

- `announcements` 只含 `is_active=1` 且 `scope='app'` 的，最多 **20** 条；
- `popups` 只含 `is_active=1` 且 `scope='popup'` 的，最多 **3** 条，按 id **升序**；
- 两类**一起返回**是刻意的：前端要在"首次进入须知弹窗关掉之后"紧接着弹它，这是一个**时序要求**，单开接口会变成两个并发请求谁先回来不一定。前端自己排队即可。
- 若 010 迁移没跑（没有 `scope` 列），`popups` 一律是 `[]`，普通公告照常返回（不会整段 500）。

<!-- 出处：functions/api/announcements.js:50-135 -->

### 5.13 `GET /api/schedule`

**身份**：`requireSession(env, request, null)` —— 班级会话**或**管理员会话（游客也可以）。**限流**：代码里未找到限流。

**请求 query**：

| 参数 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `week_start` | string | 否 | `^\d{4}-\d{2}-\d{2}$` 且有效日期；默认今天。会被折算到所在周的周一 |
| `weeks` | number | 否 | 整数 1~12，默认 4；**非法值静默按 4 处理**（不报错） |

**响应 `200`**：

```jsonc
{
  "weekStart": "2026-10-05",
  "weeks": 4,
  "perWeek": 6,
  "periods": ["noon", "afternoon"],
  "weeklies": [
    {
      "weekStart": "2026-10-05",
      "weekEnd": "2026-10-09",      // 周五
      "slots": [
        { "week_start": "2026-10-05", "period": "noon", "position": 1,
          "song_id": 34, "title": "雨爱", "artist": "杨丞琳",
          "track_id": "mt-2712018330", "category_name": "中文歌" }
      ]
    }
  ]
}
```

没有歌的周也会被补出来（`slots: []`），前端可以直接渲染。

**失败**：`400` `起始周格式应为 YYYY-MM-DD` / `起始周不是有效日期`；`401`；`500` 012 迁移提示。

<!-- 出处：functions/api/schedule.js:18-56,58-120 -->

---

### 5.14 `GET /api/admin-accounts`

**身份**：**仅高级管理员**（`requireSuper`）。**限流**：代码里未找到限流。

**请求**：无参数。

**响应 `200`**：

```jsonc
{
  "admins": [ { "id": 1, "username": "admin", "role": "super" }, { "id": 3, "username": "张三", "role": "admin" } ],
  "currentId": 1                      // 当前登录管理员自己的 id
}
```

排序：`role = 'super'` 的排最前，其余按 id 升序。

**失败**：`401`（会话过期 / 账号已失效）；`403` `{"error":"当前角色无权执行该操作"}`（普通管理员）。

<!-- 出处：functions/api/admin-accounts.js:16-30 -->

### 5.15 `POST /api/admin-accounts`

**身份**：**仅高级管理员**。**限流**：代码里未找到限流。

**请求 body**：`{action, …}`，`action` ∈ `delete` / `reset_password`，否则 `400 {"error":"未知操作"}`。

| `action` | 字段 | 响应 / 失败 |
|---|---|---|
| `delete` | `id`（必填，正整数） | `200 {ok:true, message:"已删除管理员「<用户名>」"}`。同时删除该管理员的 `subject='admin'` 会话**以及他换出去的调试会话**，所以被删账号立刻失效。失败：`400 不能删除你自己的账号`；`403 不能删除高级管理员`；`404 管理员不存在` |
| `reset_password` | `id`（必填，正整数）、`new_password`（必填，8~128） | `200 {ok:true, message:"已重置「<用户名>」的密码，其登录状态已失效"}`。失败：`403 不能重置高级管理员的密码`；`404 管理员不存在`；`400 新密码至少 8 位` / `新密码最多 128 位` / `新密码格式不正确` |

三条**硬性保护规则**（避免把管理员自己锁死）：不能删除自己、不能删除另一个高级管理员、不能重置高级管理员的密码。注册接口永远只会产生 `role='admin'`，所以高级管理员只能由部署时的 SQL 指定。

**改自己的密码走的是另一个接口**（`POST /api/admin-settings` 的 `change_admin_password`），普通管理员即可，见 5.7。

<!-- 出处：functions/api/admin-accounts.js:32-99, _lib/auth.js:612-648 -->

### 5.16 `GET /api/admin-invites`

**身份**：**仅高级管理员**。**限流**：代码里未找到限流。

**请求**：无参数。

**响应 `200`**：`{invites:[{id, created_by_name, note, max_uses, used_count, expires_at, created_at, is_usable}]}`，按 id 降序，最多 **100** 条。`is_usable` 是服务端算出来的：`1` = 未过期且 `used_count < max_uses`，`0` = 已失效。

**失败**：`401` / `403`；`500` `数据库尚未执行 003 迁移（缺少动态口令表），请先在 D1 控制台执行 sql/003_multi_admin_and_announcements.sql`。

**注意**：列表里**没有**明文的动态口令 —— 库里只存 SHA-256 摘要，所以除了生成的那一刻，**谁都查不出明文**（见 5.17）。

<!-- 出处：functions/api/admin-invites.js:9-11,35-64 -->

### 5.17 `POST /api/admin-invites`

**身份**：**仅高级管理员**。**限流**：代码里未找到限流。

**请求 body**：`{action, …}`，`action` ∈ `create` / `revoke`，否则 `400 {"error":"未知操作"}`。

**`action: "create"`**：

| 字段 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `max_uses` | number | 否 | 正整数 **1~50**，默认 `1` |
| `expires_days` | number | 否 | 正整数 **1~90**，默认 `7` |
| `note` | string | 否 | 备注，`sanitizeText` maxLength 30；不传或空则存空串 |

响应 `200`：

```jsonc
{
  "ok": true,
  "code": "K7QM3XP9RT2W",              // 明文，**只在这一刻返回一次**
  "formatted": "K7QM-3XP9-RT2W",        // 人类可读形态（4-4-4），方便念给同学或写在纸上
  "max_uses": 1,
  "expires_at": "2026-10-13 08:00:00"   // UTC 时间字符串
}
```

失败：`400 可用次数需为 1 到 50 之间的整数` / `有效天数需为 1 到 90 之间的整数` / `备注太长了（最多 30 个字符）` 等。

**`action: "revoke"`**：字段 `id`（必填正整数）→ `200 {ok:true, message:"已作废该动态口令"}`；失败 `400 记录不正确` / `404 记录不存在`。

**前端必须注意的两点**：
1. `code` / `formatted` **只返回一次** —— 生成之后数据库里只有摘要，界面上再也读不出来。所以必须提示用户（或自动复制）立即保存。
2. 邀请码本身是 12 位、人类可读字母表（去掉了 `0/O`、`1/I/L`）。注册接口会把它归一化成"纯大写字母数字"，所以用户输入时**带不带短横线都行**（`K7QM-3XP9-RT2W` 与 `k7qm3xp9rt2w` 等价）。

用它注册出来的账号固定是普通管理员（见 3.5）。

<!-- 出处：functions/api/admin-invites.js:25-27,66-136, _lib/crypto.js:157-173, functions/api/admin-register.js:48-51,79-81 -->

### 5.18 `GET /api/admin-passes` / `POST /api/admin-passes` —— 测试口令与游客口令（v3.4.0）

**身份**：`requireStaff`（普通管理员及以上 —— 发临时口令是广播站日常工作，不必高级管理员亲自操作）。**限流**：代码里未找到限流。

**GET 响应 `200`**：

```jsonc
{
  "ok": true,
  "canView": true,          // 配了私有 AUTH_PEPPER 才能解出明文
  "passes": [
    { "id": 3, "kind": "test", "label": "演示", "expires_at": "2026-10-18 00:00:00" | null,
      "revoked": false, "created_at": "…", "last_used_at": "…" | null,
      "token": "ABCD2345EFGH" }   // 仅 canView 时才有；长期凭证明文便于再次分发
  ]                          // 最多 500 条，id 降序
}
```

**POST `action: "create"`**：`kind`（必填，只认 `test` / `guest`）、`label`（可选，maxLength 40）、`expires_days`（可选，1~3650，留空 = 长期有效）。
响应 `200`：`{ok:true, id, kind, label, expires_at, token, message}`。
**`token` 是 12 位人类可读随机码（去 `0/O/1/I/L`），只在这一刻返回**；库里只有 PBKDF2 哈希 + HMAC 查找索引 + AES 密文。

**POST `action: "revoke"`**：`id` 必填 → `200 {ok:true, revokedSessions, message}`。作废后口令不能再登录，**它签发过的全部会话立即失效**（`sessions.pass_id` 反查删除）。

**POST `action: "delete"`**：`id` 必填 → 行与相关会话一起删除。

失败：`400 口令类型只能是 test（测试口令）或 guest（游客口令）` / `有效天数需要是 1 到 3650 之间的整数，留空表示长期有效` / `凭证不正确`；`404 凭证不存在`；`500` 015 迁移提示（缺 access_passes 表）。

学生侧怎么用：拿 `token` 在**首页班级口令输入框**直接登录（`POST /api/login`），响应带 `guest:true, role:'guest'`（游客口令）或 `test:true, role:'test'`（测试口令），`class_id` 为 `0`、`class_name` 为「游客模式」/「测试口令」。过期/作废的口令登录回 `401 口令错误`。

## 6. `/api/music` 专篇

它是**搜索 + 取播放地址**的代理。**客户端永远无法指定上游地址** —— 你只能传"关键词"或"音源 id"，上游由服务端决定。否则它立刻变成任何人都能用的开放代理 / SSRF 跳板。

### 6.1 五种模式与分发顺序

处理器是 `onRequestGet`（**只有 GET**，没有 POST/PUT）。模式由 query 参数决定，**按下面的顺序短路**，前面的命中就不会看后面的：

| 顺序 | 参数 | 身份 | 限流 | 作用 |
|---|---|---|---|---|
| 1 | `?status=1` | 公开 | 无 | 配置自检：`{configured:true, provider}` |
| 2 | `?probe=1` | 公开 | 无 | 逐源自检 + 构建号 |
| 3 | 其它一切 | `requireSession(env, request, null)`（班级**或**管理员，游客可以） | `music` 240/小时 + IP 1200/小时 | 见下 |
| 3a | `?check=<id>` | 同上 | 同上 | 惰性可播性校验 |
| 3b | `?play=<id>` | 同上 | 同上 + `rateLimitOnce` 60/小时 | 转发音频字节流 |
| 3c | `?q=<关键词>`（以及 `&artist=`） | 同上 | 同上 + 全站预算收紧 | 搜索候选 |

如果同时传了多个（例如 `?check=x&play=y`），**只有第一个命中的生效**（`check` 排在 `play` 前面，`play` 排在 `q` 前面）。`status` / `probe` 最优先。都不传时走 `q` 分支，而空关键词会变成 `400 搜索关键词不能为空`。

<!-- 出处：functions/api/music.js:2171-2176,2192,2298-2313,2328,2354,2371（onRequestGet 内的模式分发） -->

### 6.2 `?q=` —— 搜索候选

**请求 query**：

| 参数 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `q` | string | **是** | `sanitizeText` maxLength **60**，非空，不能含 `<` `>` |
| `artist` | string | 否 | `sanitizeText` maxLength 60。**校验失败时静默忽略**（不报错，只是没有歌手线索）。它只影响排序，不参与过滤 |

**响应 `200`**：

```jsonc
{
  "provider": "auto",          // auto | meting | apple（由 MUSIC_PROVIDER 决定）
  "tier": "歌名+歌手",          // "歌名+歌手" | "歌名" | "模糊搜索" | null
  "results": [ /* 候选对象，见 6.5 */ ]
}
```

`tier` 是"这次结果是在第几级尝试里拿到的"：先试「歌名 + 歌手」，再试「歌名」，最后试不做标题过滤的「模糊搜索」；都没有就是 `null` + 空数组。

**失败**：

| 状态码 | 文案 |
|---|---|
| `400` | `请求格式不正确` 之外：`搜索关键词不能为空` / `搜索关键词太长了（最多 60 个字符）` / `搜索关键词不能包含 < 或 >` / `搜索关键词格式不正确` |
| `429` | `试听请求过于频繁，请稍后再试`（第一道）／`搜索过于频繁，请稍后再试`（全站预算收紧后那道） |
| `401` | `登录已过期，请重新登录` |
| `502` | `音源服务暂时不可用，请稍后再试`（搜索编排整体抛异常时） |

<!-- 出处：functions/api/music.js:2371 起（q 分支）, _lib/validate.js:24-31 -->

### 6.3 `?check=<id>` —— 惰性可播性校验

**目的**：点「试听」**之前**就知道这一版有没有音频，**根本不挂必然失败的播放器**。它**不会**触发任何音频转发，只做一次重定向探测（带 10 分钟缓存）。

**请求 query**：`check` 必须匹配 `/^[A-Za-z0-9_-]{1,40}$/`，否则 `400 {"error":"歌曲 id 不正确"}`。

**响应 `200`**（三种形状）：

```jsonc
{ "ok": true, "playable": true }                  // mt- / mg-：确认能出音频
{ "ok": true, "playable": false }                 // mt- / mg-：确认拿不到音频
{ "ok": true, "playable": null }                  // mt- / mg-：不确定；或前缀不是 ap/mt/mg
{ "ok": true, "playable": true, "complete": false }  // ap-（苹果）：一定能出音频，但只有 30 秒
```

- 判定按前缀分派：`ap-` 直接回 `{playable:true, complete:false}`（不探测）；`mt-` / `mg-` 走 `trackPlayable()`（与搜索结果、审核列表、播放解析**完全同一条链**）；其它前缀回 `playable:null`。
- `playable: false` ≠ 不能选，只是不能试听。
- **`complete: false` 与 `playable: true` 必须并存** —— 苹果那条能出音频（`playable` 该是 `true`），但只有 30 秒，而候选上带的 `duration` 是整曲时长。把这两件事压成一个布尔值必然错一种。

<!-- 出处：functions/api/music.js:2322-2352（check 分支）, _lib/playable.js:35-52 -->

### 6.4 `?play=<id>` —— 取音频（转发）

**请求 query**：`play` 必须匹配 `/^[A-Za-z0-9_-]{1,40}$/`，否则 `400 {"error":"歌曲 id 不正确"}`。

**请求头**：`Range` 会被**原样透传**给上游（浏览器播放音频会发十几个 Range 请求，拖动进度条还会再来一批）。

**响应**：**不是 JSON**，是音频字节流：
- 状态码沿用上游的 `200` 或 `206`；
- `Content-Type` 只允许 `audio/*`、`application/octet-stream`、`application/vnd.apple.mpegurl`（几个 `audio/x-m4p` 之类的会被统一成 `audio/mp4`，其余非 `audio/` 的落成 `audio/mpeg`）；
- 会带上 `Cache-Control: public, max-age=3600`、`X-Content-Type-Options: nosniff`、`Accept-Ranges`，以及上游的 `Content-Length` / `Content-Range` / `ETag` / `Last-Modified`（有就带）。
- **绝不原样透传上游的 `Content-Type`**：上游若返回 `text/html`，等于在我们自己的域名下渲染别人控制的页面。

**限流**：除了 `music` 那道 240/小时，`?play=` 还有一道折叠计数 —— 同一会话对**同一个音源 id** 在一小时窗口内**只计一次**（60/小时）。它折叠的是**计数**，不是请求本身：每个 Range 请求仍然照常转发，否则播放器会卡住。

**失败**：

| 状态码 | 文案 |
|---|---|
| `400` | `歌曲 id 不正确` |
| `429` | `试听请求过于频繁，请稍后再试`（两道限流任一超限） |
| `404` | `这一版暂时播不出来，换一个版本试试`（候选链逐条验真后没有一条能出音频） |
| `504` | `音源获取超时，请稍后再试` |
| `502` | `音源地址不可信，已拒绝转发` / `音源获取失败` / `音源返回了空内容` / `上游返回的不是音频内容` |

<!-- 出处：functions/api/music.js:2092-2138 (proxyAudio),2354-2369（play 分支） -->

### 6.5 候选对象：每个字段的含义

搜索结果的每个候选：

| 字段 | 类型 | 含义 |
|---|---|---|
| `id` | string | **音源 id**，带前缀。见下面的前缀表 |
| `name` | string | 歌名，服务端截断到 **120** 字符 |
| `artist` | string | 歌手。多歌手用 ` / ` 连接 |
| `album` | string | 专辑名，可能为空串 |
| `duration` | number | **整曲**时长（秒）；`0` 表示上游没给。咪咕搜索响应里没有时长字段，是靠"取链"那一步顺手量出来回填的 |
| `source` | string | 来源展示名：`'咪咕音乐'` / `'网易云'` / `'苹果 30 秒试听'` |
| `rank` | object | 排序依据，**新增字段、纯附加信息**，前端可以完全不认：`{score, clean, artistFit, durationPenalty}`。排序出问题时用来查"它输在哪个键上" |
| `token` | string \| null | 服务端签发的**选曲凭据**，见下 |
| `track_token` | string \| null | 与 `token` **同一个值**（两个键都带，只是省一次命名没对齐的返工）。提交点歌时用这个字段名 |
| `playable` | boolean | **只在确认拿不到音频时才出现**（值为 `false`）。字段不存在 = 未标记 / 不确定，**前端不要标"无音频"** |
| `complete` | boolean | **只在"能出音频但不是完整曲子"时才出现**（值为 `false`，目前只有苹果 30 秒片段） |

候选池上限 **40** 条（两个源各取 20 条，合并去重后截取）。去重键是"歌名 + 歌手"（归一化空白与大小写）。排序依次是：标题干净度 → 与查询词相似度 → 歌手吻合度 → 片段惩罚 → 源优先级。

**候选上的 `playable` 只探最前面的 8 条**（并发 4、总截止 1800ms），剩下的保持"未标记"。这是刻意的收窄：一次搜索最多 40 条，全探一遍就是 40+ 次上游请求；未探到的候选播放时那条链**照样会验真并逐路回退**，所以不会出现"标着能播却播不出来"。

#### 音源 id 前缀

| 前缀 | 上游 | 怎么解析成播放地址 | 特点 |
|---|---|---|---|
| `mg-<contentId>` | **咪咕**（`app.c.nf.migu.cn` 搜索 / `c.musicapp.migu.cn` 取链） | 只走咪咕自己的接口（`miguResolve`），响应是加扰二进制，服务端解码后取 `data.url` 并剥查询串、升级 https | 排在候选第一位（去重时它优先）。官方 CDN 直链，原唱命中率高、给完整整曲 |
| `mt-<id>` | **网易云**。注意：这个前缀同时被"网易云官方直连搜索"和"中转源（Meting 形状）搜索"使用 | 候选链：先试 `netease-outer`（`https://music.163.com/song/media/outer/url?id=<数字id>.mp3`，仅当 id 是纯数字 `\d{1,20}` 时才进链），再逐个试配置的中转源基址 | `mt-` 在 `_lib/playable.js` 里**专门表示"网易云歌曲 id"**（`neteaseIdOf` 只认 `mt-` 且只认纯数字）。非纯数字的 `mt-` 会跳过官方那条路，只问中转源 |
| `ap-<trackId>` | **苹果 iTunes**（`itunes.apple.com`，按 hk / tw / us 依次问） | `appleResolve` → `lookup` 接口取官方 `previewUrl`；**不参与验真**（官方片段必有音频） | 原唱准，但**只有 30 秒**。所以它是"原唱目录的补充"，不是主源 |

前缀白名单的唯一来源是 `/^(ap|mt|mg)-[A-Za-z0-9_-]{1,64}$/`。**加新音源必须同时改三处**（凭据签发与提交校验、`resolveAudioUrl` / `audioRoutes`、`_lib/playable.js` 的 `neteaseIdOf`），否则会出现"候选能搜到、但点「选这首」拿不到凭据"这类问题。

#### `track_token` 是干什么的

**问题**：搜索结果里每个候选都带音源 id，前端把"歌名 + 歌手 + 音源 id"一起提交。服务端曾经**分别**校验这三个字段的格式，从来没有验证过"这三者是同一首歌" —— 于是手工构造请求就能让库里出现「歌名是 A、音源 id 指向 B」的记录：榜上显示 A，点试听播出来的却是 B。

**做法**：搜索接口在返回候选的同时，为每个候选签一张**短期凭据**：

```
v1.<base64url(payload)>.<base64url(HMAC-SHA256)>
payload = {"t":歌名, "a":歌手, "k":音源id, "e":过期时间戳(秒)}
```

- 签名密钥：`TRACK_TOKEN_SECRET`，没配就退回 `AUTH_PEPPER`；
- 有效期：**2 小时**（`TRACK_TOKEN_TTL_SECONDS = 2 * 60 * 60`）；
- 最长 1024 字符；
- 只有"歌名 / 歌手能过 `sanitizeText`（各 maxLength 60）**且**音源 id 匹配前缀白名单"的候选才会签发；签不出来时是 `null`，此时前端走老流程（但**点歌会被拒**，因为投票接口强制要求凭据）。
- 前端的用法：用户在候选列表里点了「选这首」，把那条候选的 `track_token`（或 `token`）存起来，提交 `/api/vote` 时作为 `track_token` 字段带上。服务端校验签名与有效期后，**以凭据里的内容为准**。

**它是不是一条安全边界**：单靠它不算。部署方没配 `AUTH_PEPPER` 时，退回的是源码里的公开默认值，任何人都能自己签一张。所以它的定位是**完整性校验**（把"三者必须同源"变成服务端可验证的事实），真正的安全防线仍然是入库前的 `sanitizeText` / 违禁词 / 会话校验 —— 那些在 `vote.js` 里对凭据内容**照常重新执行一遍**。

<!-- 出处：functions/api/music.js:33-44,52-64,103-123,1329-1376 (buildSources),1768-1782 (attachTrackTokens),1918-1949 (audioRoutes),1967-2020 (resolveAudioDetailed),2059-2071 (trackPlayable),582-628,733-777,830-857,868-936,1040-1121 (mergeCandidates), _lib/playable.js:50-52,70-79,85-133,145-176,293-333, _lib/tracktoken.js:19-40,45-46,74-85,123-140,151-213, _lib/validate.js:119-153 -->

### 6.6 上游与涉及的环境变量

上游主机（全部由服务端决定，客户端只能传关键词或 id）：

| 主机 | 用途 |
|---|---|
| `app.c.nf.migu.cn` | 咪咕搜索 |
| `c.musicapp.migu.cn` | 咪咕取播放地址 |
| `music.163.com`（`/api/search/get/web`、`/song/media/outer/url`） | 网易云官方搜索与播放地址 |
| `itunes.apple.com`（`/search`、`/lookup`） | 苹果搜索与试听片段 |
| `api.qijieya.cn/meting/` | 默认唯一的中转源（Meting 形状）。其可用性随时间变化，不要假设它活着 |

环境变量（都可不配）：

| 变量 | 作用 |
|---|---|
| `MUSIC_PROVIDER` | `'auto'`（默认）/ `'meting'`（关掉苹果与咪咕）/ `'apple'`（只留苹果） |
| `MUSIC_API_BASE` | 覆盖中转源根地址（**替换**内置默认值，不是追加） |
| `MUSIC_STOREFRONT` | 苹果商店地区，默认 `hk` |

音频转发的信任边界（前端不需要处理，但要知道失败文案的来由）：重定向**逐跳校验**，每一跳的目标主机必须来自可信集合（配置里的中转源基址 + 苹果 storefront）；最终跳只允许 https 公网 URL；会拒绝 IP 字面量形式的私网/保留地址与 `localhost` / `.local` / `.internal` 后缀。它**不做 DNS 解析**，所以挡不住"可信域名被劫持后解析到内网"。

<!-- 出处：functions/api/music.js:46-50,103-123,134-163,1329-1376,1382-1565（SSRF 与逐跳校验）,582-586,733-736,830-832,918-935 -->

---

## 7. 字段约束速查（来自 `_lib/validate.js`）

这一节的函数是各接口字段约束的**真实来源**，错误文案是模板化生成的，前端可以按前缀识别。

| 函数 | 规则 | 错误文案模板 |
|---|---|---|
| `sanitizeText(input, {maxLength=60, field})` | 去控制字符 → 合并连续空白 → trim；非空；长度 ≤ maxLength；**不能含 `<` 或 `>`**。不做 HTML 实体转义 | `<字段>格式不正确` / `<字段>不能为空` / `<字段>太长了（最多 N 个字符）` / `<字段>不能包含 < 或 >` |
| `sanitizeMultiline(input, {maxLength=500, field})` | 同上但**保留换行**，只压缩每行内部空白，连续空行压到最多两行 | 同上 |
| `parsePositiveInt(input, {field, max})` | `Number(...)` 后必须是整数、`> 0`、`≤ max`（默认 `Number.MAX_SAFE_INTEGER`）。字符串会被 `Number()` 转换，所以 `"12"` 合法 | `<字段>不正确` |
| `parseEnum(input, allowed, {field, fallback})` | `allowed.includes(value)`；给了 `fallback` 时非法值回落到 fallback 且**不报错** | `<字段>不正确` |
| `parseFingerprint(input)` | 去空白转小写后必须匹配 `/^[0-9a-f]{16,64}$/` | `指纹缺失` / `指纹格式不正确` |
| `parseSecret(input, {min=6, max=128, field})` | 必须是字符串；`trim()` 后长度在 `[min, max]`；**不改写内容**（返回的是 trim 后的值） | `<字段>格式不正确` / `<字段>至少 N 位` / `<字段>最多 N 位` |
| `parseBannedKeyword(raw)` | 先按 `sanitizeText(maxLength 200)` 收敛，再要求长度 ≤ **12** | `违禁词最多 12 个字。黑名单是用来封违禁词的，不是用来封某一首歌的 —— 要下架某首歌，请到「待审核 / 回收站」里处理。` |
| `parseTrackId(raw)` | 空值合法（返回空串）。否则必须匹配 `/^(ap\|mt\|mg)-[A-Za-z0-9_-]{1,64}$/` | `音源标识不合法` |
| `parseRequestId(raw)` | 空值/`null`/`undefined` 合法（表示"没带"）。否则必须匹配 `/^[A-Za-z0-9_-]{8,64}$/` | `请求标识不正确` |

各接口实际传入的 `min` / `maxLength` 分散在调用点，本文各端点处已逐个列出。已知的取值：

- 班级口令登录：`min 4, max 128`
- 管理员登录密码：`min 1, max 128`
- 管理员注册 / 新增管理员密码 / 重置密码 / 改密的新密码：`min 8, max 128`
- 新增班级口令 / 改班级口令：`min 6, max 128`
- 改密的当前密码：`min 1, max 128`
- 班级名称 `maxLength 30`、年级 `maxLength 20`、公告标题 `maxLength 40`、公告内容 `maxLength 500`、举报原因 `maxLength 60`、建议内容 `maxLength 120`、邀请码备注 `maxLength 30`、搜索关键词与歌手 `maxLength 60`

<!-- 出处：_lib/validate.js:24-153, _lib/idempotency.js:36-54, functions/api/login.js:38, admin-login.js:36, admin-register.js:39,45, admin-settings.js:272,275,333,512,541,591,594, announcements.js:157,160, report.js:59, suggest.js:88, admin-invites.js:100, music.js:2371,2377 -->

---

## 8. 未确认清单（诚实记录）

以下内容我**没有**从代码里确认，不要当成契约：

1. **线上部署实际配置的环境变量值**（`MUSIC_PROVIDER`、`MUSIC_API_BASE`、`MUSIC_STOREFRONT`、`RECAPTCHA_STRICT`、`RECAPTCHA_MIN_SCORE`、`POW_ENABLED`、`POW_DIFFICULTY`、`GUEST_PASSWORD`、`DEBUG_LOGIN`、`AUTH_PEPPER`、`ALLOW_DEFAULT_ADMIN_PASSWORD`）。代码里只有默认值与开关语义，实际取值只能看 Cloudflare 后台。运行时可以用 `GET /api/config` 看 reCAPTCHA / PoW 的有效状态。
2. **`rate_limits` 表是否已建**（各迁移文件我只读了文件名与用途，没有逐个核对 `sql/000_reset_database.sql` 的建表语句）。限流表不可用时服务端**一律放行**，所以这个不影响契约的正确性，只影响限流是否真的生效。
3. **苹果各 storefront 的实际命中差异** —— 代码里 `hk / tw / us` 的顺序与"cn 商店不通过接口提供歌曲"是注释里的说明，我没有实测。
4. **`mt-` 前缀下"中转源返回的 id 是什么形态"**：`normalizeMeting` 从 `item.url` 的 `?id=` 参数里取，正则允许 `[A-Za-z0-9_-]`，所以**可能是非纯数字**。代码只保证了"非纯数字时跳过网易云官方那条路"，具体各中转源返回什么形态我没有实测数据。
5. **`/api/music?probe=1` 的 `bytes` 指标对应多少码率算"完整曲子"** —— 代码里的判据是"不低于 96kbps 反算出的体积"（在 `probeAudioSource` 里），但 `?probe=1` 那段本身只回字节数、不回结论。这个阈值我只在注释与那一处代码里看到，没有逐行核对全部边界。
6. **`sessions.user_agent` 列被复用存"设备信息‖最近活动时间"** —— 代码注释明确写"全项目只写不读"，我按注释采信，没有全仓库逐文件核对是否有别的读取点。
7. **`Function` 层对未导出方法的 405 行为**：依据是 `functions/api/pow.js` 里的注释（"Pages Functions 对没有对应处理器的请求方法自动返回 405"），我没有在本地跑起来验证。
8. **`admin-settings` GET 在 `classes` 查询四种降级尝试全部失败时**的行为：代码里 `for` 循环结束后 `classRows` 保持 `[]`、`canViewPasswords` 保持 `false`，不会报错；但那是"四种列组合都不存在"的极端情况，我没有构造过。
9. **`/api/report` 的实际执行顺序**：`guardRate` 在 `readJson` **之后**、`verifyRecaptcha` **之前**（`report.js:37` 与 `report.js:30`），我按代码行号顺序记录；而 `suggest.js` 的 `guardRate` 在 `readJson` **之前**。两者不一致，但都是代码事实，不是笔误。
