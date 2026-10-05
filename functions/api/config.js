import { json } from '../../_lib/http.js';
import { recaptchaEnabled, recaptchaBase } from '../../_lib/recaptcha.js';

/**
 * 公开的前端配置。**不需要登录** —— 登录页也要用。
 *
 * 只下发**公开**信息：reCAPTCHA 的站点密钥本来就是给前端用的。
 * 密钥（RECAPTCHA_SECRET）永远不会出现在这里。
 */
export async function onRequestGet(context) {
  const { env } = context;

  return json({
    recaptcha: {
      enabled: recaptchaEnabled(env),
      siteKey: recaptchaEnabled(env) ? String((env && env.RECAPTCHA_SITE_KEY) || '') : '',
      // 前端按这个域名加载 api.js（默认 recaptcha.net，google.com 在大陆不可达）
      base: recaptchaBase(env),
    },
  });
}
