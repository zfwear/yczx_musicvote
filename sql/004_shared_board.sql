-- ============================================================
--  004_shared_board.sql
--  全站共用一份榜单 + 投票按设备去重
--
--  修掉两个语义错误：
--   1. 榜单曾经按"登录用的班级口令"过滤，导致新加一个班级口令后
--      用它登录会看不到已有歌曲。改为全校共用一份榜单。
--   2. 投票去重原本是"每个班级口令对每首歌只能投一次"，
--      在只有一个班级口令时就退化成了"全校每首歌只能一票"。
--      改为按设备指纹去重，符合"每人一票"的本意。
--
--  在 D1 控制台执行（需先执行完 001 / 002 / 003）。
-- ============================================================

ALTER TABLE upvote_logs ADD COLUMN fingerprint TEXT;

-- 换掉旧的 (class_id, song_id) 唯一约束
DROP INDEX IF EXISTS idx_upvote_unique;

CREATE INDEX IF NOT EXISTS idx_upvote_song ON upvote_logs(song_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_upvote_fp_unique ON upvote_logs(fingerprint, song_id);
