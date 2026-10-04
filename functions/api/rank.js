export async function onRequestPost(context) {
  const { request, env } = context;
  const data = await request.json();
  const title  = (data.title || '').trim();
  const artist = (data.artist || '').trim();
  const pw     = (data.password || '').trim();

  const CORRECT = 'yczx2026'; // 必须和上面 login.js 一模一样！

  if (pw !== CORRECT) {
    return new Response(JSON.stringify({ error: '口令失效，请重新进入' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (!title || !artist) {
    return new Response(JSON.stringify({ error: '歌名和歌手不能为空' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  await env.DB.prepare(
    `INSERT INTO songs (title, artist, votes) VALUES (?, ?, 1)
     ON CONFLICT(title, artist) DO UPDATE SET votes = votes + 1`
  ).bind(title, artist).run();

  const row = await env.DB.prepare(
    'SELECT votes FROM songs WHERE title = ? AND artist = ?'
  ).bind(title, artist).first();

  return new Response(JSON.stringify({
    title, artist, votes: row ? row.votes : 1
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
}