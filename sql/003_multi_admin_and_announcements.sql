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
