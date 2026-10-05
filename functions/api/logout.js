import { jsonWithCookies } from '../../_lib/http.js';
import { revokeSession, clearSessionCookies, revokeCurrentDebugSession } from '../../_lib/auth.js';

/**
 * 退出登录：删除服务端会话并清 Cookie。
 *
 * 两种身份（学生 / 管理员）的 Cookie 都要清掉，
 * 避免退出后还留着另一种身份的登录态。
 *
 * 审计报告 A5：如果当前这条学生会话其实是一个**调试会话**
 * （input 管理员密码换来的），光删令牌不够 —— 同一管理员的密码还能
 * 再换一个新的。所以这里连它归属管理员名下的其它调试会话一起撤销，
 * 让"退出登录"对调试身份也是真的结束。
 */
export async function onRequestPost(context) {
  const { request, env } = context;

  if (env && env.DB) {
    try {
      await revokeCurrentDebugSession(env, request);
    } catch {
      // 会话表可能尚未迁移；退出登录本身不应报错。
    }
    try {
      await revokeSession(env, request, null);
    } catch {
      // 同上。
    }
  }

  return jsonWithCookies({ ok: true }, 200, clearSessionCookies(request));
}
