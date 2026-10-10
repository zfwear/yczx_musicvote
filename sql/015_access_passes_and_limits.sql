-- ============================================================
--  015_access_passes_and_limits.sql
--  口令凭证（测试口令 / 游客口令）+ 班级投稿投票上限 + 班级暂停
--
--  背景（2026-10-10 需求）：
--    1. 游客口令原先只有环境变量 GUEST_PASSWORD 一条、后台没有生成入口；
--       另外还要一种"测试口令"：限时发放、登录后拥有完整投稿与投票权限。
--       口令种类变多，管理入口单独成一个后台页面（口令管理）。
--    2. 班级要能配置 投票上限 / 投稿上限（固定数字或 x*0.25 表达式，
--       x 为本班人数），并能整体暂停 / 恢复。
--
--  设计要点：
--    · access_passes 与 classes 的口令同一套机制：
--        token_hash      PBKDF2 加盐哈希（登录校验用，不可逆）
--        token_lookup    HMAC(私钥, 口令) 查找索引（O(1) 定位，唯一）
--        token_encrypted AES-GCM 密文（管理员查看用；未配私钥则不可看）
--    · expires_at 为空 = 长期有效；格式与库内其它时间列一致
--      （YYYY-MM-DD HH:MM:SS，字典序即时序）。
--    · sessions.pass_id：口令凭证签发的会话带着凭证 ID ——
--      作废/删除凭证时能按列精确撤销会话；续期逻辑也会跳过这类会话，
--      保证会话活不过凭证有效期。
--
--  在 D1 控制台执行（需先执行完 001 ~ 014）。
--  server.mjs 的 --init 会自动跑；旧部署按增量补丁执行本文件即可。
-- ============================================================

-- ---------- 1. 口令凭证表 ----------
CREATE TABLE IF NOT EXISTS access_passes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT NOT NULL,              -- 'test' | 'guest'
  label           TEXT NOT NULL DEFAULT '',   -- 备注（如"高二课间演示"）
  token_hash      TEXT NOT NULL,              -- PBKDF2 哈希
  token_lookup    TEXT NOT NULL,              -- HMAC 查找索引（唯一）
  token_encrypted TEXT,                       -- AES-GCM 密文，管理员可查看
  expires_at      TEXT,                       -- NULL = 长期有效
  revoked         INTEGER NOT NULL DEFAULT 0, -- 1 = 已作废
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at    TEXT
);

-- 同一口令只能是一条凭证（否则登录时无法确定是哪一条）。
CREATE UNIQUE INDEX IF NOT EXISTS idx_access_passes_lookup ON access_passes(token_lookup);
CREATE INDEX IF NOT EXISTS idx_access_passes_kind ON access_passes(kind, revoked);

-- ---------- 2. 会话带上凭证 ID ----------
ALTER TABLE sessions ADD COLUMN pass_id INTEGER;

-- ---------- 3. 班级：上限表达式与暂停 ----------
-- 存原始表达式字符串：'52'（固定数字）或 'x*0.25'（x=本班人数）。
-- 空串 / NULL = 不限制（保持原有行为）。
ALTER TABLE classes ADD COLUMN vote_limit   TEXT;
ALTER TABLE classes ADD COLUMN submit_limit TEXT;
-- 1 = 暂停（该班用户不能投票、投稿）；默认 0 = 正常。
ALTER TABLE classes ADD COLUMN paused INTEGER NOT NULL DEFAULT 0;
