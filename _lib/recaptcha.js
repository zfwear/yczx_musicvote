/**
 * Google reCAPTCHA v3 校验。
 *
 * ⚠️ 默认走 **www.recaptcha.net**，不是 www.google.com。
 *
 * 实测（中国大陆网络）：
 *   www.google.com/recaptcha/api.js   → 超时（被墙）
 *   www.recaptcha.net/recaptcha/api.js → HTTP 200，约 200ms
 *
 * recaptcha.net 是 Google 官方为这类地区提供的备用域名，功能完全一致。
 * 如果这里用了 google.com，学生的浏览器加载不出脚本、拿不到 token，
 * 整个投稿都会被拦下 —— 所以域名是这套功能能不能用的关键。
 * 需要时可用 RECAPTCHA_BASE 覆盖。
 *
 * 两个密钥都从环境变量读，**不写进仓库**：
 *   RECAPTCHA_SITE_KEY   站点密钥（公开，会下发给前端）
 *   RECAPTCHA_SECRET     密钥（保密，只在服务端使用）
 *
 * 可用性优先的降级策略（避免"墙一抖全校都投不了稿"）：
 *   1. 没配 RECAPTCHA_SECRET       → 完全不启用，直接放行
 *   2. 前端没拿到 token（脚本被墙） → 默认放行；设 RECAPTCHA_STRICT=1 可改成拒绝
 *   3. token 无效 或 分数低于阈值   → 拒绝
 *   4. 校验服务本身不可达           → 放行（网络抖动不该让功能全挂）
 */

export const DEFAULT_RECAPTCHA_BASE = 'https://www.recaptcha.net';

export function recaptchaBase(env) {
  const raw = String((env && env.RECAPTCHA_BASE) || '').trim();
  return (raw || DEFAULT_RECAPTCHA_BASE).replace(/\/+$/, '');
}

/** 是否启用了人机校验（配了密钥才算启用）。 */
export function recaptchaEnabled(env) {
  return Boolean(env && String(env.RECAPTCHA_SECRET || '').trim());
}

/**
 * 校验前端拿到的 token。
 * 返回 { ok:true } 表示放行（可能带 skipped 标记），{ ok:false, error } 表示拒绝。
 */
export async function verifyRecaptcha(env, token, { ip } = {}) {
  if (!recaptchaEnabled(env)) return { ok: true, skipped: true };

  const secret = String(env.RECAPTCHA_SECRET).trim();
  const strict = String((env && env.RECAPTCHA_STRICT) || '') === '1';
  const value = String(token == null ? '' : token).trim();

  if (!value) {
    // 前端没拿到 token —— 多半是脚本被网络挡住了。
    return strict
      ? { ok: false, error: '人机校验未通过（未取到校验令牌），请刷新页面重试' }
      : { ok: true, skipped: true };
  }

  const body = new URLSearchParams({ secret, response: value });
  if (ip) body.set('remoteip', ip);

  try {
    const res = await fetch(`${recaptchaBase(env)}/recaptcha/api/siteverify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    const data = await res.json();

    if (!data || data.success !== true) {
      return { ok: false, error: '人机校验未通过，请刷新页面后重试' };
    }

    // v3 会给出 0~1 的分数，越低越像机器人
    const min = Number((env && env.RECAPTCHA_MIN_SCORE) || 0.5);
    if (typeof data.score === 'number' && Number.isFinite(min) && data.score < min) {
      return { ok: false, error: '人机校验分数过低，请稍后再试' };
    }

    return { ok: true, score: typeof data.score === 'number' ? data.score : null };
  } catch (err) {
    // 校验服务不可达：可用性优先
    return { ok: true, skipped: true, error: String((err && err.message) || err) };
  }
}
