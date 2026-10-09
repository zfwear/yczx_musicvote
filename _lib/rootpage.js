/**
 * 根路径该给谁看。
 *
 * 访客打开 `/` 时有两种"对的那一页"：
 *   · 已登录（学生侧会话有效，含游客/调试身份）→ 应用主页 index.html
 *   · 没登录 → 发布页 landing.html
 *
 * 为什么做成**服务端分发**而不是页面脚本跳转：旧流程是访客先拿到应用页、
 * 渲染、跑脚本、查会话、再 location.replace 到发布页 —— 白屏加闪烁全来自
 * 这一下多余的往返，而且首屏内容取决于脚本跑得多快。分发在服务器就决定好，
 * 浏览器第一次请求拿到的就是最终那一页。
 *
 * 为什么单独成一个模块：Cloudflare（functions/_middleware.js）与自建
 * server.mjs 是**两个入口**，两边必须给出完全一致的结论 ——
 * 判定写两份迟早分叉成"线上给发布页、本地给应用页"。
 */
import { readSession } from './auth.js';

/**
 * @returns {Promise<'app'|'landing'>} 'app' = 应用主页；'landing' = 发布页
 */
export async function resolveRootPage(env, request) {
  if (!env || !env.DB) return 'landing';
  try {
    // 只认学生这一侧的会话：管理员后台有自己的入口（/admin.html），
    // 不该因为浏览器里留着管理员 Cookie 就把 `/` 当成已登录主页。
    const session = await readSession(env, request, 'class');
    return session ? 'app' : 'landing';
  } catch {
    // 库还没迁移 / 短暂不可用：给发布页。它是纯静态、一定渲染得出来；
    // 把一个可能报错的页面甩给访客才是最差的选择。
    return 'landing';
  }
}
