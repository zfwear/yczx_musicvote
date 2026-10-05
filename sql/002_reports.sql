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
