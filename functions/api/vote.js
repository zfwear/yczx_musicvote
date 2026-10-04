export async function onRequestPost(context) {
  const { request, env } = context;
  const data = await request.json();
  const title = (data.title || '').trim();
  const artist = (data.artist || '').trim();
  const classId = data.class_id || 1;
  const categoryId = data.category_id || 2;

  if (!title || !artist) {
    return new Response(JSON.stringify({ error: '歌名和歌手不能为空' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const banned = await env.DB.prepare(
    `SELECT reason FROM banned_items 
     WHERE (type='artist' AND keyword LIKE ?) OR (type='title' AND keyword LIKE ?)
     AND expire_at > datetime('now')`
  ).bind(`%${artist}%`, `%${title}%`).first();

  if (banned) {
    return new Response(JSON.stringify({ error: `该歌曲或歌手已被过滤：${banned.reason || '违规'}` }), { status: 403, headers: { 'Content-Type': 'application/json' } });
  }

  const exist = await env.DB.prepare(
    'SELECT status FROM songs WHERE title = ? AND artist = ? AND class_id = ?'
  ).bind(title, artist, classId).first();

  if (exist) {
    if (exist.status === 'pending') return new Response(JSON.stringify({ error: '这首歌已经在待审核队列里啦' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    if (exist.status === 'approved') return new Response(JSON.stringify({ error: '这首歌已经进曲库啦，快去投票吧' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    if (exist.status === 'rejected') return new Response(JSON.stringify({ error: '该歌曲在往期审核中已被过滤' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  await env.DB.prepare(
    'INSERT INTO songs (class_id, title, artist, category_id, status) VALUES (?, ?, ?, ?, "pending")'
  ).bind(classId, title, artist, categoryId).run();

  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
}
