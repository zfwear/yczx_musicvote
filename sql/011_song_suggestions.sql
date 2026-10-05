-- ============================================================
--  011_song_suggestions.sql
--  歌曲建议（"这首不对，换个版本"旁边那个按钮提交的内容）
--
--  学生在试听时如果觉得"锁定的这一版不合适"（例如音质差、
--  不是原唱、是翻唱、纯音乐版本不对），可以按下建议按钮，
--  把意见提到管理员的这首歌上。
--
--  管理员看到建议后自己去别处找合适的版本，本站不负责换源。
--
--  在 D1 控制台执行（需先执行完 001 ~ 010）。
-- ============================================================

CREATE TABLE IF NOT EXISTS song_suggestions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  song_id    INTEGER NOT NULL,
  class_id   INTEGER,
  content    TEXT NOT NULL,
  handled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_suggestions_song ON song_suggestions(song_id, handled_at);
