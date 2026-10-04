export async function onRequestPost(context) {
  const { request, env } = context;
  const data = await request.json();
  const pw = (data.password || '').trim();

  const row = await env.DB.prepare('SELECT id, name FROM classes WHERE password = ?').bind(pw).first();
  if (row) {
    return new Response(JSON.stringify({ ok: true, class_id: row.id, class_name: row.name }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
  return new Response(JSON.stringify({ error: '口令错误' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' }
  });
}
