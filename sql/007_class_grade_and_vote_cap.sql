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
