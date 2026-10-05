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
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS rate_limits;
DROP TABLE IF EXISTS upvote_logs;
DROP TABLE IF EXISTS report_logs;
DROP TABLE IF EXISTS admin_invites;
DROP TABLE IF EXISTS announcements;
DROP TABLE IF EXISTS system_settings;
DROP TABLE IF EXISTS song_suggestions;
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
