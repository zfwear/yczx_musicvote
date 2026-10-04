-- ============================================================
--  002_reports_and_reset.sql
--  举报系统 + 凭证重置
--
--  在 D1 控制台整段粘贴执行。
--  前置条件：请先执行 001_security_upgrade.sql
--
--  ⚠️ 只需执行一次。其中 CREATE ... IF NOT EXISTS 可重复执行，
--     但 UPDATE 会每次都把口令重置回下面这两个值。
-- ============================================================

-- ---------- 1. 举报系统 ----------
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

-- ---------- 2. 凭证重置（夺回控制权）----------
-- 这里写入的是**预计算好的 PBKDF2-SHA256 哈希**，明文一天都不会落库。
-- 最终效果与"UPDATE ... SET password='admin888'"完全一致：
--   管理员用  admin / admin888   登录
--   班级口令用 yczx2026          登录
--
-- 哈希参数：pbkdf2 sha256 迭代=10000
UPDATE admins
   SET password = 'pbkdf2$sha256$10000$XQv0koEu0Rmqzkel0g7z6Q$OXSAhGck4sEZauETM3CeHLdUPh8EeeqSJYJdAdSq_wo'
 WHERE username = 'admin';

-- password_lookup 故意留 NULL：
-- 这样无论你是否配置了 AUTH_PEPPER 环境变量，首次登录都会走回退路径，
-- 用真实私钥重新计算并回填，绝不会因为私钥不一致而把自己锁在门外。
UPDATE classes
   SET password = 'pbkdf2$sha256$10000$KmRXUIalqvuh8pxJHE6pNQ$ZYICfGsFcE6FCX37d2WPuKen8fUlstmOM881Pu-mRBI',
       password_lookup = NULL
 WHERE id = 1;

-- ---------- 3. 执行结果自检 ----------
-- 下面这条查询应当返回：password 以 pbkdf2$sha256$ 开头，
-- 且结果里看不到 admin888 / yczx2026 这两个明文。
SELECT username,
       CASE WHEN password LIKE 'pbkdf2$%' THEN '已哈希' ELSE '仍是明文' END AS admin_state
  FROM admins;

SELECT id, name,
       CASE WHEN password LIKE 'pbkdf2$%' THEN '已哈希' ELSE '仍是明文' END AS class_state
  FROM classes;
