export async function onRequestPost(context) {
  const { request, env } = context;
  const data = await request.json();
  const title = (data.title || '').trim();
  const artist = (data.artist || '').trim();
  const classId = data.class_id || 1;
  const categoryId = data.category_id || 2;
  const pw = (data.password || '').trim();

  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const ua = request.headers.get('user-agent') || 'unknown';

  if (!pw) {
    return new Response(JSON.stringify({ error: '请先登录口令' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }
  if (!title || !artist) {
    return new Response(JSON.stringify({ error: '歌名和歌手不能为空' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const recentVote = await env.DB.prepare(
    `SELECT id FROM vote_logs WHERE ip = ? AND user_agent = ? AND datetime(created_at) > datetime('now', '-7 days') LIMIT 1`
  ).bind(ip, ua).first();

  if (recentVote) {
    return new Response(JSON.stringify({ error: '您本周已经点过歌啦，每人每周只能点一次哦！' }), { status: 429, headers: { 'Content-Type': 'application/json' } });
  }

  const banned = await env.DB.prepare(
    `SELECT reason FROM banned_items WHERE (type='artist' AND keyword LIKE ?) OR (type='title' AND keyword LIKE ?) AND expire_at > datetime('now')`
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

  await env.DB.prepare(
    'INSERT INTO vote_logs (class_id, ip, user_agent) VALUES (?, ?, ?)'
  ).bind(classId, ip, ua).run();

  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
}
