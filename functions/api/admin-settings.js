export async function onRequestPost(context) {
  const { request, env } = context;
  const data = await request.json();
  const action = data.action;
  const password = (data.password || '').trim();

  const admin = await env.DB.prepare('SELECT id FROM admins WHERE password = ?').bind(password).first();
  if (!admin) {
    return new Response(JSON.stringify({ error: '无权限' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }

  if (action === 'update_class_password') {
    const newPw = (data.new_password || '').trim();
    if (!newPw) return new Response(JSON.stringify({ error: '新口令不能为空' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    await env.DB.prepare('UPDATE classes SET password = ? WHERE id = 1').bind(newPw).run();
    return new Response(JSON.stringify({ ok: true, message: '班级口令已修改' }), { headers: { 'Content-Type': 'application/json' } });
  }

  if (action === 'add_banned') {
    const type = data.type || 'artist';
    const keyword = (data.keyword || '').trim();
    const reason = (data.reason || '管理员封禁').trim();
    const expire_at = data.expire_at || '2099-12-31 23:59:59';
    if (!keyword) return new Response(JSON.stringify({ error: '关键词不能为空' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    await env.DB.prepare('INSERT INTO banned_items (type, keyword, reason, expire_at) VALUES (?, ?, ?, ?)').bind(type, keyword, reason, expire_at).run();
    return new Response(JSON.stringify({ ok: true, message: '已加入黑名单' }), { headers: { 'Content-Type': 'application/json' } });
  }

  if (action === 'delete_banned') {
    const id = data.id;
    await env.DB.prepare('DELETE FROM banned_items WHERE id = ?').bind(id).run();
    return new Response(JSON.stringify({ ok: true, message: '已移除黑名单' }), { headers: { 'Content-Type': 'application/json' } });
  }

  return new Response(JSON.stringify({ error: '未知操作' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestGet(context) {
  const { env } = context;
  const { results } = await env.DB.prepare('SELECT * FROM banned_items ORDER BY id DESC').all();
  return new Response(JSON.stringify(results), { headers: { 'Content-Type': 'application/json' } });
}
