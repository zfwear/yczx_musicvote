/**
 * 公开仓库带来的一个直接后果：
 *
 * 仓库是开源的 → 里面的"示例默认口令"是**全世界都知道**的。
 * 那么任何一份「克隆下来、建了库、忘了改口令」的部署，
 * 都等于把管理员后台挂在公网上等人用 admin / admin888 登录。
 * 换成人话：**公开仓库里的默认口令不能是能用的口令。**
 *
 * 所以这里的策略是**默认拒绝**：
 *   · 没配 ALLOW_DEFAULT_ADMIN_PASSWORD 时，用示例口令登录管理员会被拒绝，
 *     并提示去 README 按步骤设置自己的口令；
 *   · 只有显式打开这个开关（本地测试 / 演练）才放行。
 *
 * 为什么不"允许登录但强制改密"：那需要在后台前端加一整套
 * "未改密状态"的界面逻辑，而拒绝 + 一条 SQL 已经能解决问题，
 * 复杂度低得多，也更不容易被绕过。
 */

/** 000_reset_database.sql 里的示例管理员口令。改了那边记得同步这里。 */
export const SEED_ADMIN_PASSWORD = 'admin888';

/** 000_reset_database.sql 里的示例班级口令。 */
export const SEED_CLASS_PASSWORD = 'yczx2026';

/** 输入的明文是不是"公开仓库里的示例管理员口令"。 */
export function isSeedAdminPassword(plain) {
  return String(plain == null ? '' : plain) === SEED_ADMIN_PASSWORD;
}

/**
 * 输入的明文是不是"公开仓库里的示例**班级**口令"。
 *
 * 2026-10-08 补：这条防线原先**只有管理员侧有**。
 * `SEED_CLASS_PASSWORD` 一直导出了却**全仓库没有任何地方使用它** ——
 * 也就是跑完迁移之后，任何知道这个公开仓库的人都能用 `yczx2026` 登录学生端：
 * 读榜单、投票、举报、提建议、点歌。管理员进不去、学生端却门户大开，
 * 这个**不对称**比"两个都开着"更糟 —— 因为没人会意识到还要改它。
 */
export function isSeedClassPassword(plain) {
  return String(plain == null ? '' : plain) === SEED_CLASS_PASSWORD;
}

/** 是否显式允许使用示例口令（本地测试 / 演练用，生产不要开）。 */
export function allowSeedCredentials(env) {
  const raw = env && env.ALLOW_DEFAULT_ADMIN_PASSWORD;
  const value = String(raw == null ? '' : raw).trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}
