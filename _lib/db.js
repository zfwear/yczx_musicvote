/**
 * D1 结果处理小工具。
 *
 * D1 的 run() 返回 D1Result，受影响行数在 meta.changes。
 * "先原子占位、再判断是否抢到" 是本项目防并发穿透的核心手法，
 * 因此把读取 changes 的逻辑集中在这里，避免各处写错。
 */

/** 取出受影响行数；结果形状异常时返回 0（视作"没抢到"）。 */
export function changedRows(result) {
  const value = result && result.meta ? result.meta.changes : undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** 取出自增主键；取不到返回 0。 */
export function lastRowId(result) {
  const value = result && result.meta ? result.meta.last_row_id : undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 判断错误是否为"表不存在"。
 * 用来把"迁移没跑"翻译成人能看懂的提示，而不是甩一个 500 堆栈给管理员。
 */
export function isMissingTable(err) {
  return /no such table/i.test(String((err && err.message) || ''));
}

/**
 * 判断错误是否为"列不存在"（迁移只跑了一半）。
 *
 * ⚠️ 两种实现的说法不同，正则必须同时认（2026-10-09 修）：
 *   · Cloudflare D1：   no such column: custom_title
 *   · 本机 node:sqlite：table weekly_playlist has no column named custom_title
 * 只认前一种时，**本机 server.mjs 上的降级会静默失效** ——
 * "014 还没执行"的部署不会退回老 SQL，而是直接 500。
 */
export function isMissingColumn(err) {
  return /no such column|has no column named/i.test(String((err && err.message) || ''));
}
