-- ============================================================
--  001_security_upgrade.sql
--  盐城中学广播站点歌系统 · 安全升级迁移
--
--  在 Cloudflare 控制台 → Workers & Pages → D1 → (你的库) → Console
--  里整段粘贴执行一次。
--
--  ⚠️ 本脚本只需执行一次。ALTER TABLE 不支持 IF NOT EXISTS，
--     重复执行会在对应行报 "duplicate column name"，属正常现象。
-- ============================================================

-- ---------- 1. 会话表：取代"每次请求都传密码" ----------
-- 只存令牌的 SHA-256 摘要，数据库泄露也无法直接冒用会话。
CREATE TABLE IF NOT EXISTS sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash  TEXT NOT NULL UNIQUE,
  subject     TEXT NOT NULL,              -- 'admin' | 'class'
  subject_id  INTEGER NOT NULL,           -- admins.id 或 classes.id
  role        TEXT,
  ip          TEXT,
  user_agent  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_token  ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

-- ---------- 2. 限流表：登录爆破 / 接口洪泛防护 ----------
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket        TEXT PRIMARY KEY,
  count         INTEGER NOT NULL DEFAULT 0,
  window_start  TEXT NOT NULL
);

-- ---------- 3. 投票指纹：把 IP+UA 查重升级为设备指纹查重 ----------
ALTER TABLE vote_logs ADD COLUMN fingerprint TEXT;

CREATE INDEX IF NOT EXISTS idx_vote_logs_ip ON vote_logs(ip, created_at);
CREATE INDEX IF NOT EXISTS idx_vote_logs_fp ON vote_logs(fingerprint, created_at);

-- ---------- 4. 多班级口令：查找索引列 ----------
-- password 列改存加盐 PBKDF2 哈希后无法用等值查询定位班级，
-- 因此额外存一列 HMAC(服务端私钥, 口令) 专门用于索引。
-- 私钥在环境变量 AUTH_PEPPER 中，不在数据库里。
ALTER TABLE classes ADD COLUMN password_lookup TEXT;

-- 唯一索引有两个作用：
--   1. 禁止两个班级用同一个口令（否则登录时无法确定该算哪个班）；
--   2. 让"口令重复"变成数据库层保证，而不是应用层的竞态检查。
-- SQLite 的唯一索引允许多个 NULL，因此尚未升级的旧行不会互相冲突。
CREATE UNIQUE INDEX IF NOT EXISTS idx_classes_lookup ON classes(password_lookup);

-- ---------- 5. 重复投票约束：防止一个人反复点同一首歌 ----------
CREATE TABLE IF NOT EXISTS upvote_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id    INTEGER NOT NULL,
  song_id     INTEGER NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_upvote_unique ON upvote_logs(class_id, song_id);

-- ---------- 6. 榜单查询索引 ----------
CREATE INDEX IF NOT EXISTS idx_songs_status ON songs(class_id, status, votes);
