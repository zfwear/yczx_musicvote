import { json } from '../../_lib/http.js';
import { revokeSession, clearSessionCookie } from '../../_lib/auth.js';

/** 退出登录：删除服务端会话并清 Cookie。 */
export async function onRequestPost(context) {
  const { request, env } = context;

  if (env && env.DB) {
    try {
      await revokeSession(env, request);
    } catch {
      // 会话表可能尚未迁移；退出登录本身不应报错。
    }
  }

  return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie(request) });
}
