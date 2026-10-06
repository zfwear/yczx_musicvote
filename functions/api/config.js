import { json } from '../../_lib/http.js';
import { recaptchaEnabled, recaptchaBase } from '../../_lib/recaptcha.js';
import { powEnabled, powDifficulty } from '../../_lib/pow.js';
import { isSubmissionsPaused } from '../../_lib/settings.js';

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

    /**
     * 浏览器端 PoW（防刷票的第二道，默认关闭）。
     *
     * 只下发"开没开"和"难度"——难度本来就会随谜题一起给前端，
     * 不是秘密；密钥（POW_SECRET / AUTH_PEPPER）永远不会出现在这里。
     * 前端看到 enabled:false 就跳过取谜题与计算，一切照旧。
     */
    pow: {
      enabled: powEnabled(env),
      difficulty: powDifficulty(env),
    },

    // 备案号与版权主体：由环境变量下发，页面上先放写死的值，取到就替换 ——
    // 改这些不用改代码、也不用重新部署。
    // 江苏管局要求"版权所有"的单位名称必须与备案主体一致，所以单独留了一个变量。
    beian: {
      icp: String((env && env.ICP_BEIAN) || '').trim(),
      gongan: String((env && env.GONGAN_BEIAN) || '').trim(),
      holder: String((env && env.COPYRIGHT_HOLDER) || '').trim(),
    },

    /**
     * 「是否暂停接收投稿」——**故意放在公开配置里**。
     *
     * 学生端要能在**打开页面时**就知道现在停收了，而不是填完表单、点提交
     * 才吃一个 403。这个信息本身不敏感（谁都能试着提交一次看出来），
     * 而"填完才被拒"是实实在在的体验损失。
     * 注意它只是**提示**：真正的闸门在 vote.js 的 POST 里，
     * 绕过页面直接 POST 一样会被拦。
     */
    submit: {
      paused: await isSubmissionsPaused(env),
    },
  });
}
