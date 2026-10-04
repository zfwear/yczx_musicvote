import { readJson, error, json } from '../../_lib/http.js';
import { requireAdmin } from '../../_lib/auth.js';
import { parsePositiveInt } from '../../_lib/validate.js';
import { changedRows } from '../../_lib/db.js';

/** 修改歌曲分类。 */
export async function onRequestPost(context) {
  const { request, env } = context;

  const auth = await requireAdmin(env, request);
  if (!auth.ok) return auth.response;

  const parsed = await readJson(request);
  if (!parsed.ok) return error(parsed.error, 400);

  const id = parsePositiveInt(parsed.value.id, { field: '歌曲' });
  if (!id.ok) return error(id.error, 400);

  const categoryId = parsePositiveInt(parsed.value.category_id, { field: '分类' });
  if (!categoryId.ok) return error(categoryId.error, 400);

  // 旧版直接把客户端给的 category_id 写库，可以写入不存在的分类。
  const categoryRow = await env.DB.prepare('SELECT id FROM categories WHERE id = ?')
    .bind(categoryId.value).first();
  if (!categoryRow) return error('分类不存在', 400);

  const result = await env.DB.prepare('UPDATE songs SET category_id = ? WHERE id = ?')
    .bind(categoryId.value, id.value).run();

  if (changedRows(result) === 0) return error('歌曲不存在', 404);

  return json({ ok: true });
}
