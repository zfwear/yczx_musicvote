-- ============================================================
-- 016 · 个人口令 + 个人配色（2026-10-14，MD3 项目 批次②③④）
--
-- 全部按用户已确认的决策设计（见交接文档 2e 节）：
--
-- 个人口令：绑定一条班级口令 + 一个管理员录入的用户名。
--   登录标识 = 「班级口令@用户名」（例：g15@lisan），登录时实时拼接，
--   **库里只存 class_id + username** —— 管理员改班级口令内容后，
--   所有个人口令的前缀自动跟随，无需批量更新。
--   班级被删除时：个人口令置为未绑定态（class_id 变为 0；若 0 已被
--   同名占用则取"原 class_id 的负值"，唯一索引不撞车），登录标识显示为
--   yczxuser@用户名、**暂不可登录**；管理员在后台重新绑定到新班级后恢复。
--   删除个人口令 = 真删（登录立即失效）；**配色记录保留**。
--
-- 个人配色：主键 = (class_id, username)，**不是个人口令 id** ——
--   删除个人口令后配色保留，同名重建能读回旧配色；重新绑定时由后端
--   把配色行迁移到新班级键下。模式互斥：preset（预设主题）/ custom（自定义）。
--
-- 会话标记：sessions.personal_pass_id 记录"这次登录来自哪条个人口令"：
--   /api/me 靠它告诉前端"我是个人用户"（显示个性化入口与身份后缀）；
--   删除 / 重新绑定 / 班级被删 时按它精确撤销这些登录。
--
-- 执行方式：D1 控制台整段执行一次（幂等，可重复跑；ALTER 列已存在会报
--   duplicate column name，属正常，忽略即可）。
-- ============================================================

CREATE TABLE IF NOT EXISTS personal_passes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id   INTEGER NOT NULL,              -- 0 或负数 = 未绑定（班级已被删除）
  username   TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_personal_passes_class_user
  ON personal_passes(class_id, username);

CREATE TABLE IF NOT EXISTS personal_prefs (
  class_id   INTEGER NOT NULL,
  username   TEXT    NOT NULL,
  mode       TEXT    NOT NULL DEFAULT 'preset',   -- 'preset' | 'custom'
  preset     TEXT    NOT NULL DEFAULT '',         -- '' | 'mono' | 'mint' | 'beige' | 'lavender'
  colors     TEXT    NOT NULL DEFAULT '',         -- JSON: {primary,bg,card,text}
  updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (class_id, username)
);

ALTER TABLE sessions ADD COLUMN personal_pass_id INTEGER;
