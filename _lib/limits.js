/**
 * 上限表达式的解析与求值。
 *
 * 后台允许两种写法（二选一）：
 *   · 固定数字： `52`
 *   · 比例表达式：`x*0.25`，x 代入"人数"（本班人数或全站有效班级总人数）
 *
 * 刻意**不做**通用表达式求值：输入来自管理后台，但求值必须发生在
 * 学生端请求的热路径上，eval / Function 一概不能出现。
 * 这里只认一个形状 —— `x*<数字>`（可带空格、大小写均可），
 * 其它任何写法都是 400，而不是"试着算一算"。
 */

/** 匹配固定数字（正整数；0 表示不限制，与全局 vote_cap 同一口径）。 */
const FIXED_PATTERN = /^\d{1,7}$/;

/** 匹配 x*系数（系数 0 ~ 1000，最多三位小数）。 */
const EXPR_PATTERN = /^[xX]\s*\*\s*(\d{1,3}(?:\.\d{1,3})?)$/;

/**
 * 校验上限表达式。
 * @returns {{ok:true, value:string} | {ok:false, error:string}}
 *   value 是收敛后的规范写法（去空格；固定数字去掉前导 0）。
 */
export function parseLimitExpr(raw, { field = '上限' } = {}) {
  const text = String(raw == null ? '' : raw).trim();
  // 空 = 不限制（"清空关闭"就走这条路）
  if (!text) return { ok: true, value: '' };

  if (FIXED_PATTERN.test(text)) {
    return { ok: true, value: String(Number(text)) };
  }

  const match = EXPR_PATTERN.exec(text);
  if (match) {
    const factor = Number(match[1]);
    if (!(factor > 0)) return { ok: false, error: `${field}表达式的系数必须大于 0` };
    return { ok: true, value: `x*${match[1]}` };
  }

  return {
    ok: false,
    error: `${field}只支持两种写法：固定数字（如 52），或 x*比例（如 x*0.25，x 为人数）`,
  };
}

/**
 * 把表达式代入 x 求出有效上限。
 * 返回 0 表示不限制（空串 / 非法存储值 / x 无效都落在这一侧 ——
 * 配置坏了不该把全班挡在门外，只会少一道拦截）。
 *
 * 小数结果不做取整：比较用的是"已用数量 ≥ 上限"，11.25 的含义
 * 自然就是"第 12 次起拦截"，无需约定进位方式。
 */
export function evalLimit(expr, x) {
  const text = String(expr == null ? '' : expr).trim();
  if (!text) return 0;
  if (FIXED_PATTERN.test(text)) return Number(text);
  const match = EXPR_PATTERN.exec(text);
  if (!match) return 0;
  const head = Number(x);
  if (!Number.isFinite(head) || head <= 0) return 0;
  const value = head * Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : 0;
}
