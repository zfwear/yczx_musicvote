export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const status = url.searchParams.get('status') || 'pending';

  const { results } = await env.DB.prepare(
    `SELECT s.id, s.title, s.artist, s.votes, s.class_id, c.name as category_name 
     FROM songs s
     JOIN categories c ON s.category_id = c.id
     WHERE s.status = ?
     ORDER BY s.created_at DESC LIMIT 100`
  ).bind(status).all();

  return new Response(JSON.stringify(results), {
    headers: { 'Content-Type': 'application/json' }
  });
}
