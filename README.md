# 盐城中学 · 盐中之声 每日点歌系统

Cloudflare Pages + Pages Functions + D1，无需服务器、无需付费。

> **本次改动的重要约定**：前端 HTML 与 CSS **没有被重写**。
> 三个页面的 `<style>` 块与原版逐字节相同，CSS 类名、DOM 结构与排版保持原样；
> 只修改了页面内 `<script>` 的逻辑代码，并按约定补上了原脚本本就在查找、
> 但 HTML 里缺失的 `#pendingList` / `#approvedList` 两个容器。
> 这条约定由测试强制保证（见下文"测试"一节）。

---

## 一、部署步骤（三步）

### 1. 整体替换仓库内容

把本目录下**全部文件**覆盖到仓库根目录，然后提交，Cloudflare 会自动重新部署。

> ⚠️ 必须整体替换。`assets/` 里原有的 `Image_*.png`、`zf1.png` 是历史资源，
> 本包已包含它们；只上传部分文件会把旧图删掉。

### 2. 在 D1 控制台依次执行两份 SQL

Cloudflare 控制台 → Workers & Pages → D1 → 你的数据库 → Console。
`D:\zfff\操作.txt` 里已经把两段 SQL 合并成一次可直接粘贴的内容，
也可以分别执行仓库里的两个文件：

| 顺序 | 文件 | 作用 | 注意 |
|---|---|---|---|
| 1 | `sql/001_security_upgrade.sql` | 会话表、限流表、投票指纹列、口令查找索引、防重复投票表 | **只能执行一次**，重跑会报 `duplicate column name: fingerprint`，属正常 |
| 2 | `sql/002_reports_and_reset.sql` | 举报表 + **把管理员和班级口令重置为已知值** | 执行完会自动打印自检表 |

自检结果里 `admin_state` / `class_state` 应显示 **"已哈希"**。
重置写入的是**预先算好的 PBKDF2 哈希**，明文不落库，但效果一样：
管理员用 `admin` / `admin888`，班级口令用 `yczx2026`。

### 3. 配置环境变量（建议但非必需）

Cloudflare Pages → 你的项目 → Settings → Environment variables：

| 变量名 | 是否必需 | 说明 |
|---|---|---|
| `AUTH_PEPPER` | 建议 | 任意随机字符串。作为班级口令查找索引的服务端私钥，**存在这里而不是数据库里**，因此即使数据库被整个导出也无法反推班级口令。不配置功能正常，后台"系统设置"会显示状态。 |
| `MUSIC_API_BASE` | 可选 | 第三方音乐 API 根地址。**不配置时试听功能会提示"未配置"，不影响其它功能。** |

`DB` 绑定沿用你原有配置，未改动。

---

## 二、修掉了什么

### 1. 存储型 XSS（最高危，群友就是靠它改掉管理员密码）

**原来的问题**：`admin.html` 用 `innerHTML` 拼接 `${s.title}` / `${s.artist}`，
用户提交的 `<img src=x onerror=...>` 会被浏览器当 HTML 执行；
而登录成功后密码被明文写进 `sessionStorage`，XSS 一执行就能读走。

**修复分两层：**

1. **渲染层（主要防线）**：`index.html` 与 `admin.html` 的 `<script>` 顶部加上
   `escapeHtml()`，并把**所有**来自后端的文本字段（歌名、歌手、分类名、班级名、
   黑名单关键词、举报原因……）逐个包裹；数值字段（id、票数、班级号、分类号）
   一律经 `safeInt()` 强制转整数后才拼进 HTML，堵死
   `onclick="action(1);alert(1)//"` 这类从"数字字段"打进来的注入。
2. **输入层（纵深防御）**：`vote.js` 入库前拒绝含 `<` `>` 的内容、剥离控制字符、限长。

**关于 CSP 的实话**：`_headers` 里提供了 `Content-Security-Policy`
（`default-src 'none'`、`frame-ancestors 'none'`、`object-src 'none'` 等）。
但因为按约定保留了页面内联 `<script>` 与 `onclick` 属性，
`script-src` **必须放开 `'unsafe-inline'`**，所以它只能挡住"外链注入"，
**挡不住页面内联脚本注入** —— 真正的防线是上面第 1 条的转义。
若将来愿意把脚本移到 `/assets/*.js` 外链文件、并去掉 `onclick` 属性，
就可以把 `script-src` 收紧为 `'self'`，那时 CSP 才会成为硬防线。

> 顺带修掉一个此前没人发现的 bug：原主页 JS 往 `pendingList` / `approvedList`
> 写内容，但 HTML 里只有 `rankList`，`switchMobileTab()` 引用的元素也全不存在，
> 所以主页必然抛 `TypeError`、"加载中…"永不消失。
> 现已按约定补上这两个容器（复用原有 CSS 类名，未引入任何新样式）。

### 2. 明文口令（审计报告第 2 条）

- `admins` / `classes` 的 `password` 列改存 **PBKDF2-SHA256（随机盐 + 10,000 次迭代）**，
  自描述格式 `pbkdf2$sha256$迭代$盐$摘要`。
- **旧数据无需手工迁移**：首次登录时自动识别旧的明文/弱哈希，验证通过后立刻写回哈希。
- 为什么不是裸 SHA-256：SHA-256 是"快哈希"，每秒能算上亿次，存口令等于没设防；
  PBKDF2 同族但带迭代，专门用来抗离线爆破。
- 迭代次数取 10,000 是受平台硬约束：Cloudflare **免费套餐单次请求 CPU 上限 10ms**，
  实测 25,000 次要 4.75ms、50,000 次要 9.17ms 已越线；10,000 次约 2.8ms，
  即使管理员改密走"校验 + 重新哈希"两次的路径也只有约 5.6ms。
  升级付费套餐后把 `_lib/crypto.js` 里的 `PBKDF2_ITERATIONS` 改成 `210000` 即可，
  旧口令会在下次登录时自动按新成本重新哈希，无需重置任何人的密码。

### 3. 鉴权形同虚设（审计报告第 4、5 条）

| 原问题 | 现状 |
|---|---|
| `admin-list.js` 无任何认证，任何人可读全部内部数据 | 要求管理员会话，未登录返回 401 |
| `admin-settings.js` 的 GET 无认证，任何人可读黑名单 | 同上 |
| `vote.js` **只检查口令字段非空，从不校验口令是否合法** | 必须有有效班级会话；`class_id` 取自服务端 |
| 后台写接口用 `WHERE password = ?` 当权限校验 | 统一校验管理员会话 + 角色 |
| `admin-login` 登录成功不签发任何会话，动态口令形同虚设 | 登录签发 12 小时会话；动态口令语义保留 |
| 登录接口无失败限制 | 按 IP 限流（登录 15 分钟 10 次） |
| `rank.js` 只验证"口令存在"，不校验属于哪个班级 | `class_id` 取自会话，跨班读取被彻底挡住 |
| `status` 参数未做白名单，可读回收站 | 只允许 `approved` / `pending` |

**会话令牌通过 HttpOnly Cookie 下发，不放进响应体、不进 `sessionStorage`。**
这一点是对原始需求的刻意调整：群友正是靠 XSS 读 `sessionStorage` 里的密码才改掉了
管理员账号；HttpOnly Cookie 脚本读不到。后端同时接受 `Authorization: Bearer`，
将来想改回前端持令牌，只需改前端几行。

### 4. 防刷票（审计报告第 5 条最后一项）

- 查重从 `IP + User-Agent` 改为 **设备指纹（7 天）**，并叠加同 IP 限流。
- **群友指出的"换 UA 即重置"已失效**：UA 不再参与查重。
- 指纹采集 UA、平台、语言、时区、屏幕、CPU 核数、`devicePixelRatio`、
  Canvas 绘制差异、WebGL 渲染器，本地 SHA-256。
  **刻意不使用 localStorage / Cookie**，所以清缓存不会重置。
- 为什么没把 IP 写进查重条件：校园网是同一个出口 IP，若把 IP 作为等值条件，
  **同班第二个同学就点不了歌**。IP 现在只用于限流。
- 并发穿透也一并修掉：原来的"先查询再写入"存在竞态，两个并发请求都能通过检查。
  现在把检查与写入合并成单条原子 SQL（`INSERT ... SELECT ... WHERE NOT EXISTS`）。

### 5. 其他一并修掉的问题

| 问题 | 修复 |
|---|---|
| 班级口令放在 URL 查询串里（会进访问日志） | 改用会话 Cookie，URL 中不再有凭证 |
| 黑名单 SQL 的 `AND`/`OR` 优先级写错，过期时间失效 | 加括号修正优先级 |
| 黑名单 `LIKE` 方向反了，歌手名后加一个字符即可绕过 | 改用 `instr()` 字面包含匹配 |
| `upvote.js` **根本不存在**，主页"投票"按钮实际是 404 | 补上接口，并加"每班每首歌只能投一次"的唯一约束 |
| `category_id` 可由客户端随意指定 | 校验必须真实存在于 `categories` |
| `type` 参数未做白名单 | 改成枚举校验 |
| 页面引用的 `/assets/school-badge.png`、`/assets/radio-logo.png` **实际不存在** | 补齐这两个文件（HTML 一个字没改，图片就正常显示了） |

---

## 三、新增功能

| 功能 | 位置 |
|---|---|
| **双榜单** —— 待审核榜按票数降序、可投票；正式榜按分类权重→票数排序，**且响应体里完全不含 `votes` 字段**（服务端就不下发，F12 也看不到） | `rank.js` + 主页脚本 |
| **多班级口令** —— 添加 / 删除 / 单独改口令，口令唯一且以哈希保存；删除最后一个会被拒绝 | `admin-settings.js` + 后台"班级口令列表" |
| **分类权重管理** —— 后台直接改数值，正式榜排序立即生效 | 后台"分类权重" |
| **定时拉黑** —— 可选 30 / 90 / 365 天或长期，到期自动解禁 | 后台"添加违禁名单" |
| **举报系统** —— 学生可举报待审核歌曲，被举报的在后台排最前并标红；每班每首只能举报一次（唯一索引原子占位）；管理员可"清除举报" | `report.js` + 后台 |
| **防重提示** —— 在待审核池提示"已在队列"，已通过提示"已进曲库"，回收站提示"往期已被过滤" | `vote.js` |
| **管理员改密** —— 每改一次踢掉其它设备所有会话 | 后台"修改管理员密码" |
| **试听接口** —— 三级降级搜索（歌名+歌手 → 歌名 → 模糊）+ 带 `Range` 转发的音频代理 | `music.js` |
| **二次确认** —— 点歌、投票、审核、拒绝、恢复、改口令、删班级、加黑名单全部带 `confirm` | 页面脚本 |

> **关于试听与举报的前端入口**：后端接口 `music.js` / `report.js` 已全部就绪并有测试覆盖，
> 但**我没有在歌曲卡片上加"试听"和"举报"按钮** —— 那会改变你现在看到的界面。
> 你说一句，我按现有卡片结构加上去（复用 `.rank-card` 与 `.btn-upvote` 的写法，不引入新样式）。

---

## 四、免费套餐相关的关键优化

**`_routes.json` 只让 `/api/*` 走 Functions。**
没有它时，**每一个图片 / CSS / JS 请求都会消耗一次 Functions 调用额度**
（免费 10 万次/天）。加上之后静态资源走无限免费的静态通道，
这是"长期稳定运行"的关键一环。

另外 `PBKDF2_ITERATIONS` 按 10ms CPU 上限调校，`_harness/bench.mjs` 可随时重新测量。

---

## 五、文件清单

```
index.html / vote.html / admin.html     三个页面（CSS 与 DOM 保持原版，仅改 <script>）
_headers                                安全响应头 + CSP（含局限说明）
_routes.json                            只让 /api/* 走 Functions

assets/school-badge.png                 校徽（补齐原 HTML 已在引用的文件名）
assets/radio-logo.png                   盐中之声插画（同上）
assets/Image_*.png  zf1.png             历史资源，原样保留

_lib/crypto.js                          PBKDF2 哈希、HMAC 查找值、随机令牌
_lib/auth.js                            会话签发/校验/撤销、限流、口令查找索引
_lib/http.js                            统一 JSON 响应、Cookie、客户端 IP
_lib/validate.js                        输入收敛、整数强转、指纹格式校验
_lib/db.js                              D1 结果处理

functions/api/login.js                  班级口令登录
functions/api/logout.js                 退出登录
functions/api/rank.js                   双榜单（class_id 取自会话）
functions/api/vote.js                   点歌（指纹查重 + 原子占位）
functions/api/upvote.js                 投票（原本缺失）
functions/api/report.js                 举报（新增）
functions/api/admin-login.js            管理员登录
functions/api/admin-list.js             后台列表（原本无认证）
functions/api/admin-action.js           审核 / 清除举报
functions/api/admin-update.js           修改分类
functions/api/admin-settings.js         多口令 / 分类权重 / 黑名单 / 改密
functions/api/music.js                  音源代理（新增）

sql/001_security_upgrade.sql            结构迁移（只能执行一次）
sql/002_reports_and_reset.sql           举报表 + 凭证重置
```

> `_lib/` 放在仓库根目录（不在 `functions/` 内），这是 Cloudflare 官方文档
> 支持的共享模块写法。它会同时作为静态文件被访问，但内容本身就是公开源码，
> 没有秘密；所有密钥都来自环境变量。

---

## 六、已知问题与限制

1. **`sql/001` 不可重复执行。** SQLite 的 `ALTER TABLE` 不支持 `IF NOT EXISTS`，
   第二次执行会在该行报 `duplicate column name: fingerprint`，说明已迁移过。
2. **管理员口令目前仍是已公开的弱口令 `admin888` / `yczx2026`**
   （夺回控制权的必要步骤，因为原密码已被改掉）。
   **请登录后立刻在后台改成强口令**，这两个入口本次已一并做好。
3. **CSP 的 `script-src` 因为保留内联脚本而不得不放开 `'unsafe-inline'`**，
   挡不住内联脚本注入。当前主要防线是转义。收紧的前提是脚本外链化，需你点头。
4. **无账号体系时"每人每周一次"无法做到绝对。** 换设备、换网络仍可再点一次。
   指纹方案把成本抬高了很多，且不会误伤同一校园网下的其他同学。
5. **`MUSIC_API_BASE` 未指定具体供应商。** 现在交付的是可配置代理 + 优雅降级，
   `normalizeSongs()` 里兼容了几种常见响应结构。告诉我用的是哪家 API
   （或给个文档链接），我可以把适配层写死成对应格式。
6. **试听功能会消耗 Functions 调用额度**（音频经代理转发，每段 Range 请求算一次调用）。
7. **本机环境无法验证线上部署结果。** 交付前已用本地 D1 兼容测试脚手架跑通
   **112 项测试**（含真实执行两份迁移 SQL、CSS/DOM 未改动的逐字节比对、
   XSS 载荷渲染测试、音源代理的 SSRF 回归、17 个 JS 文件语法检查），
   但生产环境部署是否变绿、`vote.yzstu.top` 是否正常，需要你在控制台确认。

---

## 七、本地测试

测试脚手架在 `_harness/`，**不在交付包内**（它不属于网站，不应部署）。

```powershell
$env:ELECTRON_RUN_AS_NODE='1'
& "D:\dsh\DSH Desktop\DSH Desktop.exe" "_harness\run.mjs"
```

它做三件事：用 `node:sqlite` 起一个 D1 兼容库、**真实执行两份迁移 SQL**、
直接调用 `functions/api/*.js` 里的处理器断言行为。

其中**前端约束测试**专门守住"不得改动界面"这条约定：
把当前页面的 `<style>` 块与 `_harness/original/` 里的原版逐字节比对，
并核对所有 CSS 类名、DOM 结构；`index.html` 只允许出现被批准的
`#pendingList` / `#approvedList` 两处新增。任何人改动样式或结构都会立刻失败。
