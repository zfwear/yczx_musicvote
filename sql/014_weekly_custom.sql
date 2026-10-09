-- ============================================================
--  014_weekly_custom.sql
--  排期支持「手动录入的外部歌曲」
--
--  背景（2026-10-09 测试反馈）：
--    排期原先只能从已审核的歌曲里选（weekly_playlist.song_id → songs.id）。
--    广播站有时要排**临时歌曲 / 外部音源**（比如比赛录音、老师指定的曲子），
--    这些不会出现在曲库里，没法排。三列可空字段就是给它们留的位置：
--      song_id 有值        → 曲库里的歌（老行为，一字不变）
--      song_id 为空 + custom_title 有值 → 手动录入的外部歌曲
--    读取端用 COALESCE 的思路合并（见 functions/api/schedule.js 的 GET），
--    不需要动任何已有行。
--
--  在 D1 控制台执行（需先执行完 001 ~ 013）。
--  server.mjs 的 --init 会自动跑（列已存在时报错也不影响已有部署，
--  代码侧对"列不存在"做了降级）。
-- ============================================================

ALTER TABLE weekly_playlist ADD COLUMN custom_title  TEXT;
ALTER TABLE weekly_playlist ADD COLUMN custom_artist TEXT;
ALTER TABLE weekly_playlist ADD COLUMN custom_source TEXT;
