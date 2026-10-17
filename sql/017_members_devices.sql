-- ============================================================
-- 017 · 班级人员封禁 + 设备-姓名绑定（4.0.0）
--
-- 需求（2026-10-17 用户确认）：
--   1. 姓名登录必须绑定设备：同一设备同一班级只能登一个姓名，
--      登录时锁定，三天后自动解锁；一个姓名可以登录不同设备。
--   2. 封禁人员时清零他已投出的票（票数同步扣减）。
--   3. 管理端「班级管理」按姓名搜索、改名、移除、封禁/解封、解绑设备。
--
-- 设计要点：
--   · personal_passes.banned：0/1。封禁只阻止之后登录与投票，
--     已投的票按下方 upvote_logs.username 精确回滚。
--   · upvote_logs.username：投票时记录个人口令的姓名。
--     老数据这一列是 NULL，无法回溯归属；封禁时只清能确定的票。
--   · device_identities：主键 (fingerprint, class_id)，同一设备在不同
--     班级互不影响；username 允许重复（一个姓名可以登录多台设备）。
--     expires_at = 绑定时刻 + 3 天；到期后同一设备可以改绑其他姓名。
--
-- 执行方式：D1 控制台整段执行一次。
-- ⚠️ ALTER TABLE 重复执行会报 duplicate column name，属正常，忽略即可；
--    请确认三列都已存在后再继续使用 4.0.0。
-- ============================================================

ALTER TABLE personal_passes ADD COLUMN banned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE personal_passes ADD COLUMN banned_at TEXT;
ALTER TABLE upvote_logs ADD COLUMN username TEXT;

CREATE TABLE IF NOT EXISTS device_identities (
  fingerprint TEXT    NOT NULL,
  class_id    INTEGER NOT NULL,
  username    TEXT    NOT NULL,
  bound_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT    NOT NULL,
  PRIMARY KEY (fingerprint, class_id)
);

CREATE INDEX IF NOT EXISTS idx_device_identities_user
  ON device_identities(class_id, username);

CREATE INDEX IF NOT EXISTS idx_upvote_class_user
  ON upvote_logs(class_id, username);
