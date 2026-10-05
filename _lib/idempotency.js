/**
 * 幂等请求标识（审计遗留问题 A8）。
 *
 * 为什么需要它：
 *   网络抖动、用户连点、客户端自动重试，都会让同一个"点歌 / 投票"动作
 *   在服务端出现两次。服务端本来就靠唯一性约束防重复计数
 *   （点歌：vote_logs 的周期占位；投票：upvote_logs 的 (指纹, 歌曲) 唯一索引），
 *   但那种去重对客户端表现为**报错**：重试的客户端分不清
 *   "我这次没成功" 还是 "上一次其实已经成功了" ——
 *   于是它只能再试一次，拿到第二个错误，用户看到"你已经点过了"这种莫名其妙的提示。
 *
 * 契约：
 *   客户端可以带一个自己生成的 `request_id`（同一逻辑请求重试时保持不变）。
 *   服务端的语义是：
 *     · 不带 request_id  → 行为与以前完全一样（老前端不受影响）；
 *     · 带了 request_id  → 当这次动作已经生效时，返回**成功**
 *       （响应里带 `duplicate: true`、`counted: false` 说清楚"没有再记一次"），
 *       而不是报"你已经点过了"。
 *   request_id 合法性有格式要求，非法值直接 400 —— 客户端把幂等标识写错
 *   属于编程错误，静默忽略它比报错更危险（会让人以为幂等生效了）。
 *
 * 为什么没有专门的幂等表：
 *   新增一张表要走一份新的 sql/0xx 迁移，而这次修复不允许改 sql/ 目录。
 *   好在**已有的去重记录本身就是**"这次动作已经发生过"的权威证据：
 *     · 点歌：这台设备在本周期内已经占过名额（vote_logs）+ 同名同歌手的歌已存在（songs）；
 *     · 投票：这台设备对这首歌已经有了投票记录（upvote_logs 的唯一索引）。
 *   两种情况下目标状态都已经达成，返回成功不会造成任何重复计数。
 *
 * 已知边界（诚实写下来）：
 *   服务端没有存 request_id，因此无法区分"重放同一个 request_id"
 *   与"这台设备真的又点了一次"。但如上所述，这两种情况下的目标状态
 *   完全相同，返回成功都不会让副作用增加一次 —— 区别只在文案。
 *   真正的防重复靠的还是唯一索引，request_id 只是把"重试的结果"变友好。
 */

/** 长度取 8~64：既能容纳 UUID / 时间戳+随机串，又不给超长串留空间。 */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * 解析可选的幂等请求标识。
 *
 * @returns {{ok: true, value: string} | {ok: false, error: string}}
 *   value 为空串表示"客户端没带"，调用方据此走老路径。
 */
export function parseRequestId(raw) {
  // 没传 / 空值都视为"不带"：老前端不传这个字段，行为必须保持原样。
  if (raw === null || raw === undefined || raw === '') return { ok: true, value: '' };
  if (typeof raw !== 'string') return { ok: false, error: '请求标识不正确' };

  const value = raw.trim();
  if (!value) return { ok: true, value: '' };
  if (!REQUEST_ID_PATTERN.test(value)) return { ok: false, error: '请求标识不正确' };
  return { ok: true, value };
}

/** 导出给测试使用。 */
export const __internals = { REQUEST_ID_PATTERN };
