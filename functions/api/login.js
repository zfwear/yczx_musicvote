export async function onRequestPost(context) {
  const { request } = context;
  const data = await request.json();
  const pw = (data.password || '').trim();

  // 这是你的默认口令，去这里改！
  const CORRECT = 'yczx2026';

  if (pw === CORRECT) {
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
  return new Response(JSON.stringify({ error: '口令错误，请重新输入' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' }
  });
}