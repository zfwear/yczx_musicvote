import { jsonWithCookies } from '../../_lib/http.js';
import { revokeSession, clearSessionCookies } from '../../_lib/auth.js';

/**
 * 退出登录：删除服务端会话并清 Cookie。
 *
 * 两种身份（学生 / 管理员）的 Cookie 都要清掉，
 * 避免退出后还留着另一种身份的登录态。
 */
export async function onRequestPost(context) {
  const { request, env } = context;

  if (env && env.DB) {
    try {
      await revokeSession(env, request, null);
    } catch {
      // 会话表可能尚未迁移；退出登录本身不应报错。
    }
  }

  return jsonWithCookies({ ok: true }, 200, clearSessionCookies(request));
}
