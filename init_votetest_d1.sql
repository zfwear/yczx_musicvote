
-- FILE: sql/000_reset_database.sql
-- ============================================================
--  重置 D1：清空全部数据与结构，回到"全新未迁移"状态
--
--  用途：之前已经执行过 001~013（或部分执行），现在想从头再来一遍。
--
--  ⚠️ 这会删掉**所有**数据：歌曲、投票、班级口令、管理员、公告、
--     举报、黑名单、所有设置。不可恢复。
--
--  用法：
--    1. 在 D1 控制台粘贴执行本文件全部内容
--    2. 再粘贴执行「操作.txt」的全部内容（121 行，001~013 全量）
--    3. **先把自己的口令写进 admins 表再用它登录** —— 本文件种的是示例口令，
--       而 functions/api/admin-login.js 默认 403 拒绝示例口令，
--       照旧文档用 admin / admin888 登录会被直接挡在门外：
--         UPDATE admins SET password = '你自己的新口令' WHERE username = 'admin';
--         DELETE FROM sessions WHERE subject = 'admin';
--       （明文会在首次登录成功后自动升级为 PBKDF2 哈希。）
--       班级口令 yczx2026 同样是公开示例，登录后到「系统设置 → 班级管理」改掉。
--
--  注意：只 DROP 不重建是不够的 —— 操作.txt 里只有 001~013 的
--        ALTER / CREATE TABLE，它**不会**创建 categories / classes /
--        admins / songs / banned_items / vote_logs 这 6 张原始表，
--        也不会插入初始分类与账号。所以下面把原始结构一并建回来。
-- ============================================================

-- ---------- 1. 删掉全部表 ----------
--
-- ⚠️ 这份清单必须覆盖**项目里全部 15 张表**。2026-10-08 补上了漏掉的
--    `weekly_playlist` —— 漏掉它的后果不是"少清一张表"那么简单：
--    `songs` 被 DROP 重建后自增 id 从 1 重排，而残留的排期行里
--    `song_id` 指向的是**已经被删掉的旧歌**，于是那些 id **正好复用**到新歌身上，
--    rank.js 会把刚提交的新歌误判成"上周已播"、从正式榜踢出去。
--    （以后新增表时，记得同步这里。）
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS rate_limits;
DROP TABLE IF EXISTS upvote_logs;
DROP TABLE IF EXISTS report_logs;
DROP TABLE IF EXISTS admin_invites;
DROP TABLE IF EXISTS announcements;
DROP TABLE IF EXISTS system_settings;
DROP TABLE IF EXISTS song_suggestions;
DROP TABLE IF EXISTS weekly_playlist;
DROP TABLE IF EXISTS songs;
DROP TABLE IF EXISTS classes;
DROP TABLE IF EXISTS admins;
DROP TABLE IF EXISTS categories;
DROP TABLE IF EXISTS banned_items;
DROP TABLE IF EXISTS vote_logs;

-- ---------- 2. 重建 6 张原始表 ----------
CREATE TABLE categories (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  name    TEXT NOT NULL,
  weight  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE classes (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  name      TEXT NOT NULL,
  password  TEXT NOT NULL
);

CREATE TABLE admins (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  username          TEXT NOT NULL UNIQUE,
  password          TEXT NOT NULL,
  role              TEXT NOT NULL DEFAULT 'admin',
  login_token       TEXT,
  token_expires_at  TEXT
);

CREATE TABLE songs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id     INTEGER NOT NULL DEFAULT 1,
  title        TEXT NOT NULL,
  artist       TEXT NOT NULL,
  category_id  INTEGER NOT NULL DEFAULT 2,
  status       TEXT NOT NULL DEFAULT 'pending',
  votes        INTEGER NOT NULL DEFAULT 0,
  is_reported  INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE banned_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT NOT NULL,
  keyword    TEXT NOT NULL,
  reason     TEXT,
  expire_at  TEXT NOT NULL DEFAULT '2099-12-31 23:59:59'
);

CREATE TABLE vote_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id    INTEGER,
  ip          TEXT,
  user_agent  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------- 3. 写回初始数据 ----------
INSERT INTO categories (id, name, weight) VALUES
  (1, '纯音乐', 100),
  (2, '中文歌', 80),
  (3, '英文歌', 50),
  (4, '小语种', 30);

-- 直接种**哈希**而不是明文：这样全新库里也不会出现明文口令。
-- 这些哈希对应的是**公开仓库里的示例口令**，登录接口默认拒绝它们；
-- 部署后请先按上面第 3 条把自己的口令写进 admins 表。
INSERT INTO classes (id, name, password) VALUES (1, '默认班级', 'pbkdf2$sha256$10000$Ak16rPAHsG-XYirVxG0rPw$mADM-DGetFOtyRzgToJFTZh6SQ8BvZycRAegJmWKYZs');

INSERT INTO admins (id, username, password, role) VALUES (1, 'admin', 'pbkdf2$sha256$10000$3R6Dqa5y-ybLtISqx2KExQ$3TIhWDXvQaQF1v9xFCnExFWdzwBZjW2wwEsvAIodgjQ', 'super');


-- FILE: sql/001_security_upgrade.sql
-- ============================================================
--  001_security_upgrade.sql
--  盐城中学广播站点歌系统 · 安全升级迁移
--
--  在 Cloudflare 控制台 → Workers & Pages → D1 → (你的库) → Console
--  里整段粘贴执行一次。
--
--  ⚠️ 本脚本只需执行一次。ALTER TABLE 不支持 IF NOT EXISTS，
--     重复执行会在对应行报 "duplicate column name"，属正常现象。
-- ============================================================

-- ---------- 1. 会话表：取代"每次请求都传密码" ----------
-- 只存令牌的 SHA-256 摘要，数据库泄露也无法直接冒用会话。
CREATE TABLE IF NOT EXISTS sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash  TEXT NOT NULL UNIQUE,
  subject     TEXT NOT NULL,              -- 'admin' | 'class'
  subject_id  INTEGER NOT NULL,           -- admins.id 或 classes.id
  role        TEXT,
  ip          TEXT,
  user_agent  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_token  ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

-- ---------- 2. 限流表：登录爆破 / 接口洪泛防护 ----------
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket        TEXT PRIMARY KEY,
  count         INTEGER NOT NULL DEFAULT 0,
  window_start  TEXT NOT NULL
);

-- ---------- 3. 投票指纹：把 IP+UA 查重升级为设备指纹查重 ----------
ALTER TABLE vote_logs ADD COLUMN fingerprint TEXT;

CREATE INDEX IF NOT EXISTS idx_vote_logs_ip ON vote_logs(ip, created_at);
CREATE INDEX IF NOT EXISTS idx_vote_logs_fp ON vote_logs(fingerprint, created_at);

-- ---------- 4. 多班级口令：查找索引列 ----------
-- password 列改存加盐 PBKDF2 哈希后无法用等值查询定位班级，
-- 因此额外存一列 HMAC(服务端私钥, 口令) 专门用于索引。
-- 私钥在环境变量 AUTH_PEPPER 中，不在数据库里。
ALTER TABLE classes ADD COLUMN password_lookup TEXT;

-- 唯一索引有两个作用：
--   1. 禁止两个班级用同一个口令（否则登录时无法确定该算哪个班）；
--   2. 让"口令重复"变成数据库层保证，而不是应用层的竞态检查。
-- SQLite 的唯一索引允许多个 NULL，因此尚未升级的旧行不会互相冲突。
CREATE UNIQUE INDEX IF NOT EXISTS idx_classes_lookup ON classes(password_lookup);

-- ---------- 5. 重复投票约束：防止一个人反复点同一首歌 ----------
CREATE TABLE IF NOT EXISTS upvote_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id    INTEGER NOT NULL,
  song_id     INTEGER NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_upvote_unique ON upvote_logs(class_id, song_id);

-- ---------- 6. 榜单查询索引 ----------
CREATE INDEX IF NOT EXISTS idx_songs_status ON songs(class_id, status, votes);


-- FILE: sql/002_reports.sql
-- ============================================================
--  002_reports.sql
--  举报系统
--
--  在 D1 控制台整段粘贴执行。
--  前置条件：请先执行 001_security_upgrade.sql
--
--  这个脚本**只建表建索引**，可以安全重复执行。
--
--  注意：历史说明（为什么这里不再重置口令）
--  ------------------------------------------------------------
--  这个文件以前叫 002_reports_and_reset.sql，里面除了建表，还有两条
--  `UPDATE` 把管理员口令和 1 号班级口令重置成**固定的、预计算好的哈希**。
--  当时的用途是"忘记密码时夺回控制权"。
--
--  但那样做有个根本问题：**哈希写在仓库里 = 口令是公开的**。
--  换成哈希存储并不会让一个已经公开的口令重新变成秘密。
--  而且它跟着正常迁移流程一起跑，所以：
--    · 每次重跑迁移，都会把已经改过的口令**再打回公开默认值**；
--    · 重置之后也没有撤销既有会话。
--
--  验收标准（审计 A1）：**正常执行或重跑数据库迁移，
--  不得把现有账号改回公开默认密码。**
--  所以那两条 UPDATE 已经删除。
--
--  忘记密码怎么办？→ 见 README.md 的「忘记管理员密码怎么办」一节。
--  原则是：重置用的口令必须由**你自己生成**，不能是仓库里的固定值。
-- ============================================================

-- ---------- 举报系统 ----------
-- 未审核歌曲可被学生举报；管理员列表会把 is_reported=1 的排在最前面优先处理。
CREATE TABLE IF NOT EXISTS report_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id    INTEGER NOT NULL,
  song_id     INTEGER NOT NULL,
  reason      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 唯一索引：同一个班级对同一首歌只能举报一次。
-- 举报接口靠它做原子占位，因此刷举报无法把一首歌反复顶到最前面。
CREATE UNIQUE INDEX IF NOT EXISTS idx_report_unique ON report_logs(class_id, song_id);

CREATE INDEX IF NOT EXISTS idx_songs_reported ON songs(status, is_reported);

-- ---------- 执行结果自检 ----------
-- 应当返回两行（admins / classes），用来确认现有口令**没有**被这次迁移改动过。
-- 期望：password 列仍然是 pbkdf2$... 开头（或者你自己设置的任何值），
--       不应该出现任何来自仓库的固定口令。
SELECT 'admins' AS tbl, COUNT(*) AS rows_total,
       SUM(CASE WHEN password LIKE 'pbkdf2$%' THEN 1 ELSE 0 END) AS hashed
  FROM admins
UNION ALL
SELECT 'classes', COUNT(*),
       SUM(CASE WHEN password LIKE 'pbkdf2$%' THEN 1 ELSE 0 END)
  FROM classes;


-- FILE: sql/003_multi_admin_and_announcements.sql
-- ============================================================
--  003_multi_admin_and_announcements.sql
--  多管理员系统 + 公告区
--
--  在 D1 控制台执行（需先执行完 001 与 002）。
-- ============================================================

-- ---------- 1. 管理员邀请口令（动态口令）----------
-- 高级管理员生成，别人拿它到注册页注册成为普通管理员。
-- 与密码同样只存哈希：即使数据库被导出，也无法反推出可用的邀请码。
CREATE TABLE IF NOT EXISTS admin_invites (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash       TEXT NOT NULL UNIQUE,
  created_by       INTEGER NOT NULL,
  created_by_name  TEXT,
  note             TEXT,
  max_uses         INTEGER NOT NULL DEFAULT 1,
  used_count       INTEGER NOT NULL DEFAULT 0,
  expires_at       TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_admin_invites_hash ON admin_invites(token_hash);

-- ---------- 2. 公告 ----------
CREATE TABLE IF NOT EXISTS announcements (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  title            TEXT NOT NULL,
  content          TEXT NOT NULL,
  created_by       INTEGER,
  created_by_name  TEXT,
  is_active        INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_announcements_active ON announcements(is_active, id DESC);

-- ---------- 3. 账号查询索引 ----------
-- 注意：这里刻意**不**建 UNIQUE 索引。
-- 因为如果现网 admins 表里已经存在同名账号，唯一索引会创建失败并中断
-- 整段脚本。用户名唯一性改由注册接口在应用层校验。
CREATE INDEX IF NOT EXISTS idx_admins_username ON admins(username);

-- ---------- 4. 把现有 admin 账号提升为高级管理员 ----------
-- 你就是这个账号。只有高级管理员能生成邀请口令、管理其他管理员。
UPDATE admins SET role = 'super' WHERE username = 'admin';

-- ---------- 5. 自检 ----------
SELECT id, username, role,
       CASE WHEN password LIKE 'pbkdf2$%' THEN '已哈希' ELSE '仍是明文' END AS password_state
  FROM admins;


-- FILE: sql/004_shared_board.sql
-- ============================================================
--  004_shared_board.sql
--  全站共用一份榜单 + 投票按设备去重
--
--  修掉两个语义错误：
--   1. 榜单曾经按"登录用的班级口令"过滤，导致新加一个班级口令后
--      用它登录会看不到已有歌曲。改为全校共用一份榜单。
--   2. 投票去重原本是"每个班级口令对每首歌只能投一次"，
--      在只有一个班级口令时就退化成了"全校每首歌只能一票"。
--      改为按设备指纹去重，符合"每人一票"的本意。
--
--  在 D1 控制台执行（需先执行完 001 / 002 / 003）。
-- ============================================================

ALTER TABLE upvote_logs ADD COLUMN fingerprint TEXT;

-- 换掉旧的 (class_id, song_id) 唯一约束
DROP INDEX IF EXISTS idx_upvote_unique;

CREATE INDEX IF NOT EXISTS idx_upvote_song ON upvote_logs(song_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_upvote_fp_unique ON upvote_logs(fingerprint, song_id);


-- FILE: sql/005_viewable_class_passwords.sql
-- ============================================================
--  005_viewable_class_passwords.sql
--  让管理员能查看并分发班级口令
--
--  背景：班级口令是要发到各个班去的，管理员必须能随时查到它。
--        只存 PBKDF2 哈希的话，管理员自己也拿不回来，就没法分发了。
--
--  做法：口令存两份
--         · password            加盐 PBKDF2 哈希，登录校验用（不可逆）
--         · password_encrypted  AES-GCM 密文，仅用于管理员查看
--        密钥由 AUTH_PEPPER 派生，存在环境变量里，不在数据库中。
--        所以只拿到数据库（没有环境变量）依然解不开。
--
--  ⚠️ 已有的班级口令无法自动补上密文（哈希不可逆）。
--     执行本迁移后，请到后台把需要分发的班级口令**逐个重置一次**，
--     或者用「一键批量生成班级口令」重新生成一批。
--
--  在 D1 控制台执行（需先执行完 001 ~ 004）。
-- ============================================================

ALTER TABLE classes ADD COLUMN password_encrypted TEXT;


-- FILE: sql/006_debug_mode.sql
-- ============================================================
--  006_debug_mode.sql
--  调试模式：用管理员身份在学生端不限次数点歌
--
--  用法：在学生端（主页）的"班级口令"输入框里输入
--          「管理员账号 空格或冒号 管理员密码」
--        例如  admin:admin888   或   admin admin888
--        通过后即进入调试模式：
--          · 点歌不限次数（不占用"每人每周一次"额度）
--          · 不查重（同一首歌可以反复提交，方便测试）
--          · 提交的歌会标记 is_debug=1，在后台审核列表里显示「调试模式」
--          · 与已有正式歌曲重复的调试歌曲，**不会显示在审核列表里**（避免刷屏）
--
--  在 D1 控制台执行（需先执行完 001 ~ 005）。
-- ============================================================

ALTER TABLE songs ADD COLUMN is_debug INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_songs_debug ON songs(is_debug, status);


-- FILE: sql/007_class_grade_and_vote_cap.sql
-- ============================================================
--  007_class_grade_and_vote_cap.sql
--  班级年级 / 人数，以及投票数封顶
--
--  背景：
--   班级要能填「年级」与「人数」（管理员输入）。
--   投票数有一个上限（可单独设一个全校总人数，也可按年级汇总）。
--   **超过上限的那部分票不计入票数** —— 票照收，但不作数：
--   学生端显示的票数与正式榜排序都用封顶后的值，避免刷票把数字刷得离谱。
--
--  在 D1 控制台执行（需先执行完 001 ~ 006）。
-- ============================================================

-- 年级（如「高一」），用于后台分组展示与批量设置
ALTER TABLE classes ADD COLUMN grade TEXT;

-- 班级人数，管理员填写；用于按年级汇总出全校总人数
ALTER TABLE classes ADD COLUMN member_count INTEGER;

-- 简单的键值设置表，目前用来存「投票上限」
CREATE TABLE IF NOT EXISTS system_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_classes_grade ON classes(grade);


-- FILE: sql/008_report_inbox.sql
-- ============================================================
--  008_report_inbox.sql
--  举报收件箱
--
--  规则：**只有被多次举报、且仍然有效的举报才会进收件箱。**
--    · 多次：同一首歌被不同班级举报的次数 >= 阈值（默认 3，可在后台调整）
--    · 有效：歌还在待审核池里（status='pending'），且该举报尚未被处理
--  所以一个人随手举报一次不会打扰管理员；多人反映的才会浮上来。
--
--  handled_at 记录管理员处理这条举报的时间；已处理的就不再出现在收件箱。
--
--  在 D1 控制台执行（需先执行完 001 ~ 007）。
-- ============================================================

ALTER TABLE report_logs ADD COLUMN handled_at TEXT;

CREATE INDEX IF NOT EXISTS idx_report_unhandled ON report_logs(handled_at, song_id);


-- FILE: sql/009_song_track_id.sql
-- ============================================================
--  009_song_track_id.sql
--  记住"点歌时锁定的那一版音源"
--
--  背景：
--    学生点歌必须从搜索结果里选一首，前端会把选中那首的音源 id
--    （形如 ap-1234567890 或 mt-xxxx）随点歌一起提交、存进这一列。
--    之后这首歌出现在榜上，任何人点「试听」就**直接播放当初锁定的那一版**，
--    不再重新搜索再让用户挑 —— 避免"点的是一版、听的是另一版"。
--
--    历史数据这一列是空的，前端会自动退回"搜索 + 候选列表"的老流程。
--
--  在 D1 控制台执行（需先执行完 001 ~ 008）。
-- ============================================================

ALTER TABLE songs ADD COLUMN track_id TEXT;


-- FILE: sql/010_gate_announcements.sql
-- ============================================================
--  010_gate_announcements.sql
--  登录页公告（与登录后看到的公告分开）
--
--  背景：登录页（输入班级口令那一步）之前是一大片空白，
--        需要一个能放说明/通知的地方。但它和登录后主页的公告
--        用途不同，所以用 scope 区分，两套互不干扰：
--
--    scope = 'gate'  登录页公告：**未登录也能看**，所以只能放
--                    不需要保密的内容（欢迎语、使用说明、值班安排等）
--    scope = 'app'   主页公告：登录后才看得到（默认值，兼容历史数据）
--
--  在 D1 控制台执行（需先执行完 001 ~ 009）。
-- ============================================================

ALTER TABLE announcements ADD COLUMN scope TEXT NOT NULL DEFAULT 'app';

CREATE INDEX IF NOT EXISTS idx_announcements_scope ON announcements(scope, is_active);


-- FILE: sql/011_song_suggestions.sql
-- ============================================================
--  011_song_suggestions.sql
--  歌曲建议（"这首不对，换个版本"旁边那个按钮提交的内容）
--
--  学生在试听时如果觉得"锁定的这一版不合适"（例如音质差、
--  不是原唱、是翻唱、纯音乐版本不对），可以按下建议按钮，
--  把意见提到管理员的这首歌上。
--
--  管理员看到建议后自己去别处找合适的版本，本站不负责换源。
--
--  在 D1 控制台执行（需先执行完 001 ~ 010）。
-- ============================================================

CREATE TABLE IF NOT EXISTS song_suggestions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  song_id    INTEGER NOT NULL,
  class_id   INTEGER,
  content    TEXT NOT NULL,
  handled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_suggestions_song ON song_suggestions(song_id, handled_at);


-- FILE: sql/012_weekly_schedule.sql
-- ============================================================
--  012_weekly_schedule.sql
--  每周歌单（一周 6 首，整周每天都播这 6 首）
--
--  背景（投稿须知第 1 条 + 用户澄清）：
--    "一周总共 6 首音乐，每天都是播放这 6 首，不是每天新的 6 首"
--    其中 中午放学 = 3 首含歌词的音乐，下午上学 = 3 首纯音乐。
--
--  所以一周只有 6 个位置，一周之内天天重复播这 6 首；下周换一批。
--  这也意味着**歌曲消耗较快**，所以接口支持一次排好几周。
--
--  week_start 是那一周的周一（YYYY-MM-DD）。
--
--  在 D1 控制台执行（需先执行完 001 ~ 011）。
-- ============================================================

CREATE TABLE IF NOT EXISTS weekly_playlist (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  week_start TEXT NOT NULL,
  period     TEXT NOT NULL,
  position   INTEGER NOT NULL,
  song_id    INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_weekly_slot
  ON weekly_playlist(week_start, period, position);

CREATE INDEX IF NOT EXISTS idx_weekly_start ON weekly_playlist(week_start);


-- FILE: sql/013_debug_login_hardening.sql
-- ============================================================
--  013_debug_login_hardening.sql
--  调试登录与生产隔离（审计报告 A5）
--
--  在 Cloudflare 控制台 → Workers & Pages → D1 → (你的库) → Console
--  里整段粘贴执行一次。需先执行完 001 ~ 012。
--
--  注意：本脚本只需执行一次。ALTER TABLE 不支持 IF NOT EXISTS，
--     重复执行会在这一行报 "duplicate column name"，属正常现象；
--     后面的 CREATE INDEX 用的是 IF NOT EXISTS，可以重复执行。
-- ============================================================

-- ---------- 1. 调试会话的归属管理员 ----------
--
--  背景：在学生端输入「管理员账号:密码」可以进入调试模式（不限次数、
--  不查重地往真实歌曲表写记录）。原实现把 sessions.subject_id 写成 0，
--  于是**没有任何字段**能回答"这个调试会话是谁换来的" ——
--  管理员改密 / 被删号 / 登出时，只能撤销 subject='admin' 的会话，
--  这些 subject='class' 的调试会话会一直活到 2 小时自然过期。
--
--  这里补一列记下归属管理员：
--    · 改密 / 登出 / 删号时按 debug_admin_id 一次性撤销；
--    · 账号被删后残留的调试会话会被 readSession() 判定为无主并清掉。
--
--  注意：**没有**把管理员 ID 编码进 role。role='debug' 是
--  functions/api/vote.js 与 rank.js 判断调试身份的唯一依据，
--  改它的格式会把调试模式整个弄坏，所以归属信息单独占一列。
ALTER TABLE sessions ADD COLUMN debug_admin_id INTEGER;

-- 撤销是"按管理员查"，量很小（调试会话只有 2 小时寿命、数量是个位数），
-- 这个索引只是让 DELETE 走索引而不是全表扫，属于顺手加的。
CREATE INDEX IF NOT EXISTS idx_sessions_debug_admin
  ON sessions(debug_admin_id);

-- ---------- 2. 自检 ----------
-- 下面的查询在"列已加好"时不会报错；若报 no such column，
-- 说明上面的 ALTER 没执行成功，请单独重跑那一条。
-- 目前库里应当**没有**调试会话残留（有的话是升级前 2 小时内建的，
-- 它们没有归属管理员，会自然过期，也可以直接 DELETE FROM sessions
-- WHERE subject = 'class' AND role = 'debug' 清掉）。
SELECT COUNT(*) AS debug_sessions
  FROM sessions
 WHERE subject = 'class' AND role = 'debug';

-- ---------- 3. 部署后请做的一件事（代码之外）----------
--  调试登录现在**默认关闭**。确认真的需要时，再到
--  Pages → Settings → Environment variables 里加：
--      DEBUG_LOGIN = 1
--  并且只有 role='super' 的高级管理员能换到调试身份。


UPDATE admins SET password = 'pbkdf20000-gHzIIaFZ0u4tCg' WHERE username = 'admin';
UPDATE classes SET password = 'pbkdf20000-Rm_nKywZ83Kj1w', password_lookup = '8fa1adcdd2859e812089542d18b6aa62f9c57b0312ed0d1f94b82d179ce63879', password_encrypted = 'v1.Dom10967YM5kvhlM.aTPwlEVP2a70PXSO-z5IkuWxXvMwOMQp9wYh' WHERE id = 1;
