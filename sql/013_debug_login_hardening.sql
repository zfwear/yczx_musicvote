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
