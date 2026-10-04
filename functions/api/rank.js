export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const classId = url.searchParams.get('class_id') || 1;
  const status = url.searchParams.get('status') || 'approved';
  const password = url.searchParams.get('password') || '';

  // 1. 验证口令，不合法直接拒绝
  const classRow = await env.DB.prepare('SELECT id FROM classes WHERE password = ?').bind(password).first();
  if (!classRow) {
    return new Response(JSON.stringify({ error: '口令无效，请重新登录' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }

  // 2. 验证通过后，才返回数据
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.title, s.artist, s.votes, s.status, c.name as category_name 
     FROM songs s
     JOIN categories c ON s.category_id = c.id
     WHERE s.status = ? AND s.class_id = ?
     ORDER BY c.weight DESC, s.votes DESC LIMIT 50`
  ).bind(status, classId).all();

  return new Response(JSON.stringify(results), { headers: { 'Content-Type': 'application/json' } });
}
