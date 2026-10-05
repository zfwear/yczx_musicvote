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
