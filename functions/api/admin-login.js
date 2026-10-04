export async function onRequestPost(context) {
  const { request, env } = context;
  const data = await request.json();
  const username = (data.username || '').trim();
  const password = (data.password || '').trim();
  const token = (data.token || '').trim();

  const admin = await env.DB.prepare(
    'SELECT id, username, password, role, login_token, token_expires_at FROM admins WHERE username = ? AND password = ?'
  ).bind(username, password).first();

  if (!admin) {
    return new Response(JSON.stringify({ error: '账号或密码错误' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }

  if (admin.login_token && admin.token_expires_at) {
    const now = new Date();
    const expires = new Date(admin.token_expires_at);
    if (now > expires) {
      return new Response(JSON.stringify({ error: '动态口令已过期' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }
    if (token !== admin.login_token) {
      return new Response(JSON.stringify({ error: '动态口令错误' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }
  }

  return new Response(JSON.stringify({ ok: true, role: admin.role }), { headers: { 'Content-Type': 'application/json' } });
}
