ALTER TABLE weekly_playlist ADD COLUMN status TEXT NOT NULL DEFAULT 'scheduled';
ALTER TABLE weekly_playlist ADD COLUMN played_at TEXT;
ALTER TABLE weekly_playlist ADD COLUMN type TEXT; -- 若 songs 表没有类型字段，用它分组
CREATE INDEX IF NOT EXISTS idx_weekly_song ON weekly_playlist(song_id, week_start);
