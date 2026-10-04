export async function onRequestPost(context) {
  const { request, env } = context;
  const data = await request.json();
  const id = data.id;
  const type = data.type;
  const password = (data.password || '').trim();

  const admin = await env.DB.prepare('SELECT id FROM admins WHERE password = ?').bind(password).first();
  if (!admin) {
    return new Response(JSON.stringify({ error: '无权限' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }

  let newStatus = 'pending';
  if (type === 'approve') newStatus = 'approved';
  if (type === 'reject') newStatus = 'rejected';
  if (type === 'restore') newStatus = 'pending';

  await env.DB.prepare('UPDATE songs SET status = ? WHERE id = ?').bind(newStatus, id).run();

  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
}
