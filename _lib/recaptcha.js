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
/**
 * 允许签发令牌的域名（**服务端自己校验**，2026-10-08 加）。
 *
 * 为什么必须自己校验：
 *   2026-10-08 协作者在 reCAPTCHA 控制台把「验证 reCAPTCHA 解决方案的来源」
 *   取消勾选了。Google 文档对这个开关的说明是：
 *     "Verify that the reCAPTCHA solutions originate from whitelisted domains.
 *      **If disabled, you are required to check the hostname on your server
 *      when verifying a solution.**"
 *   也就是说：**校验域名这件事从 Google 转移到了我们服务器身上。**
 *
 *   实测证实了口子（`_harness/probe-recaptcha-origin-off.mjs`）：
 *   用一个**白名单外**的域名（example.com）加载我们这个**公开的**站点密钥、
 *   签一个令牌，siteverify 返回 `success: true, hostname: "example.com"`。
 *   也就是说，只要有人把我们的站点密钥嵌到自己的网页上，签出来的令牌我们都会认。
 *
 *   同时还实测到：**siteverify 仍然返回 `hostname`** —— 所以完全可以自己校验，
 *   把防护补回来（这就是下面 checkHostname 做的事）。
 *
 * 域名来源优先级：
 *   1. `RECAPTCHA_ALLOWED_HOSTS`（专门给这个用的，逗号分隔）
 *   2. `ALLOWED_HOSTS`（复用中间件那份白名单，语义一致：哪些域名能用本站）
 *   3. 默认 `vote.yzstu.top`
 *   任意一处写成 `*` 表示**不校验**（应急开关，与中间件的 `*` 一致）。
 *
 * 匹配规则与 reCAPTCHA 自己的语义一致：**填了 example.com 就等于也认它的子域名**。
 */
const DEFAULT_RECAPTCHA_HOSTS = ['vote.yzstu.top'];

/**
 * ⚠️ 这里**故意没有** "本机地址永远放行" 那种例外（原来是有的，2026-10-08 去掉）。
 *
 * 为什么必须去掉：这道域名校验是**唯一**还认得出"别人拿我们公开的站点密钥、
 * 在自己网页上签令牌"的防线（控制台里"验证来源"已被关掉）。
 * 而 `localhost` 是**任何人都能声明**的主机名 —— 攻击者只要在本机起一个页面、
 * 嵌入我们的站点密钥，签出来的 token 里 `hostname` 就是 `localhost`，
 * 于是这道防线被一句话绕开。审计当场指出了这一点。
 *
 * 本机联调要放行的话，请**显式加进白名单**（这才是"知情同意"）：
 *   RECAPTCHA_ALLOWED_HOSTS=vote.yzstu.top,localhost
 */

/** 去端口、转小写。 */
function normalizeHost(raw) {
  let host = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!host) return '';
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end > 0 ? host.slice(0, end + 1) : host;
  }
  const colon = host.lastIndexOf(':');
  return colon > 0 ? host.slice(0, colon) : host;
}

/**
 * 解析允许的域名清单。
 * 返回 `null` 表示"不校验"（应急开关）。
 */
export function recaptchaAllowedHosts(env) {
  const pick = (v) => String((env && env[v]) || '').trim();
  const raw = pick('RECAPTCHA_ALLOWED_HOSTS') || pick('ALLOWED_HOSTS');
  if (raw === '*') return null;
  const list = (raw || DEFAULT_RECAPTCHA_HOSTS.join(','))
    .split(',')
    .map(normalizeHost)
    .filter(Boolean);
  if (list.includes('*')) return null;
  return list.length ? list : DEFAULT_RECAPTCHA_HOSTS.slice();
}

/**
 * 令牌是不是从允许的域名签发的。
 * 与 reCAPTCHA 控制台的语义一致：登记 `yzstu.top` 就等于也认 `vote.yzstu.top`。
 */
export function isAllowedTokenHost(hostname, allowed) {
  if (allowed === null) return true;                 // 应急开关：不校验
  const host = normalizeHost(hostname);
  if (!host) return false;                           // 拿不到域名：**宁可拒绝**（见下）
  // 没有 localhost 例外 —— 那是可被任何人声明的主机名，见文件开头那段说明。
  return allowed.some((a) => host === a || host.endsWith('.' + a));
}

export async function verifyRecaptcha(env, token, { ip } = {}) {
  if (!recaptchaEnabled(env)) return { ok: true, skipped: true };

  const secret = String(env.RECAPTCHA_SECRET).trim();
  const strict = String((env && env.RECAPTCHA_STRICT) || '') === '1';
  const value = String(token == null ? '' : token).trim();

  if (!value) {
    // 前端没拿到 token —— 多半是脚本被网络挡住了。
    console.warn('[recaptcha] token_missing strict=' + strict);
    return strict
      ? { ok: false, reason: 'token_missing', error: '人机校验未通过（未取到校验令牌），请刷新页面重试' }
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
      const codes = Array.isArray(data && data['error-codes'])
        ? data['error-codes'].filter((code) => /^[a-z_]+$/.test(code)).join(',')
        : 'invalid_response';
      console.warn('[recaptcha] rejected codes=' + codes);
      return { ok: false, reason: codes || 'rejected', error: '人机校验未通过，请刷新页面后重试' };
    }

    // v3 会给出 0~1 的分数，越低越像机器人
    const min = Number((env && env.RECAPTCHA_MIN_SCORE) || 0.5);
    if (typeof data.score === 'number' && Number.isFinite(min) && data.score < min) {
      console.warn('[recaptcha] rejected reason=low_score score=' + data.score);
      return { ok: false, reason: 'low_score', error: '人机校验分数过低，请稍后再试' };
    }

    // 域名校验（因为控制台里那个开关已经被关掉了，这里必须自己来）。
    const allowed = recaptchaAllowedHosts(env);
    if (!isAllowedTokenHost(data.hostname, allowed)) {
      console.warn('[recaptcha] rejected reason=hostname host=' + String(data.hostname || 'missing'));
      // 拿不到 hostname 时也走这条：**宁可拒绝**。
      // 理由：这是"别人拿我们公开的站点密钥去自己网站上签发令牌"的唯一防线，
      // 而实测（probe-recaptcha-origin-off.mjs）证明 siteverify 一定会返回 hostname。
      // 真要应急，把 RECAPTCHA_ALLOWED_HOSTS 设成 `*` 即可整体关掉这道校验。
      return {
        ok: false,
        error: '人机校验未通过，请刷新页面后重试',
        reason: 'hostname',
        hostname: data.hostname == null ? null : String(data.hostname),
      };
    }

    return { ok: true, score: typeof data.score === 'number' ? data.score : null };
  } catch (err) {
    console.warn('[recaptcha] verification_unavailable error=' + String((err && err.name) || 'Error'));
    // 校验服务不可达：可用性优先
    return { ok: true, skipped: true, error: String((err && err.message) || err) };
  }
}
