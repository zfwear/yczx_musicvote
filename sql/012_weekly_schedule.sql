-- ============================================================
--  012_weekly_schedule.sql
--  每周歌单（一周 6 首，整周每天都播这 6 首）
--
--  背景（投稿须知第 1 条 + 用户澄清）：
--    "一周总共 6 首音乐，每天都是播放这 6 首，不是每天新的 6 首"
--    其中 中午放学 = 3 首含歌词的音乐，下午上学 = 3 首纯音乐。
--
--  所以一周只有 6 个位置，一周之内天天重复播这 6 首；下周换一批。
--  这也意味着**歌曲消耗较快**，所以接口支持一次排好几周。
--
--  week_start 是那一周的周一（YYYY-MM-DD）。
--
--  在 D1 控制台执行（需先执行完 001 ~ 011）。
-- ============================================================

CREATE TABLE IF NOT EXISTS weekly_playlist (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  week_start TEXT NOT NULL,
  period     TEXT NOT NULL,
  position   INTEGER NOT NULL,
  song_id    INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_weekly_slot
  ON weekly_playlist(week_start, period, position);

CREATE INDEX IF NOT EXISTS idx_weekly_start ON weekly_playlist(week_start);
