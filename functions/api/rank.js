export async function onRequestGet(context) {
  const { env } = context;
  const { results } = await env.DB.prepare(
    'SELECT title, artist, votes FROM songs ORDER BY votes DESC LIMIT 50'
  ).all();

  return new Response(JSON.stringify(results), {
    headers: { 'Content-Type': 'application/json' }
  });
}
