export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const classId = url.searchParams.get('class_id') || 1;

  const { results } = await env.DB.prepare(
    `SELECT s.title, s.artist, s.votes, c.name as category_name 
     FROM songs s
     JOIN categories c ON s.category_id = c.id
     WHERE s.status = 'approved' AND s.class_id = ?
     ORDER BY c.weight DESC, s.votes DESC LIMIT 50`
  ).bind(classId).all();

  return new Response(JSON.stringify(results), {
    headers: { 'Content-Type': 'application/json' }
  });
}
