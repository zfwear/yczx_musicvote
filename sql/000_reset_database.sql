-- ============================================================
--  重置 D1：清空全部数据与结构，回到"全新未迁移"状态
--
--  用途：之前已经执行过 001~009（或部分执行），现在想从头再来一遍。
--
--  ⚠️ 这会删掉**所有**数据：歌曲、投票、班级口令、管理员、公告、
--     举报、黑名单、所有设置。不可恢复。
--
--  用法：
--    1. 在 D1 控制台粘贴执行本文件全部内容
--    2. 再粘贴执行「操作.txt」的全部内容（99 行，001~009 全量）
--    3. 用 admin / admin888 登录后台，班级口令 yczx2026
--    4. 立刻改掉这两个弱口令
--
--  注意：只 DROP 不重建是不够的 —— 操作.txt 里只有 001~009 的
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

INSERT INTO classes (id, name, password) VALUES (1, '默认班级', 'yczx2026');

INSERT INTO admins (id, username, password, role) VALUES (1, 'admin', 'admin888', 'super');
