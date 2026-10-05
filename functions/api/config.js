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

    // 备案号与版权主体：由环境变量下发，页面上先放写死的值，取到就替换 ——
    // 改这些不用改代码、也不用重新部署。
    // 江苏管局要求"版权所有"的单位名称必须与备案主体一致，所以单独留了一个变量。
    beian: {
      icp: String((env && env.ICP_BEIAN) || '').trim(),
      gongan: String((env && env.GONGAN_BEIAN) || '').trim(),
      holder: String((env && env.COPYRIGHT_HOLDER) || '').trim(),
    },
  });
}
