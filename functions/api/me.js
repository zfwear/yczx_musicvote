import { json } from '../../_lib/http.js';
import { requireSession, isGuestSession, GUEST_CLASS_NAME, GUEST_ROLE } from '../../_lib/auth.js';

/**
 * 当前身份（学生端）。
 *
 * 存在意义：**让前端"问一次"就知道自己是谁，而不是"试一次写操作看会不会 403"。**
 * 为什么不做后者：
 *   · 探测式判断会在服务端留下一次注定失败的写请求（计数、日志都是噪音），
 *     用户也会先看到一个"操作失败"再看到置灰，体验自相矛盾；
 *   · 写接口将来若增加"限次"之类的前置检查，探测还可能真的消耗掉额度；
 *   · 语义上"我是什么身份"和"我能不能做这件事"本就该分开问。
 *
 * GET 返回 {ok:true, role, isGuest, className}；**未登录返回 401**。
 *
 * 只看班级这一侧（subject='class'）：本接口服务的是学生端页面，
 * 管理员身份请用 /api/admin-* 那边的接口自证，两边不混。
 * 顺带说明为什么 role 对普通学生返回 'class' 而不是 null ——
 * 学生没有"额外角色"这个概念，回一个明确的字串比回 null 更好用。
 */
export async function onRequestGet(context) {
  const { request, env } = context;

  const auth = await requireSession(env, request, 'class');
  if (!auth.ok) return auth.response;

  const session = auth.session;
  const storedRole = String(session.role || '').trim().toLowerCase();
  const isGuest = isGuestSession(session);

  // 身份名优先取"已知的特殊身份"，其次才去 classes 表查真实班级名。
  // 游客与调试会话的 subject_id 都是 0（不属于任何班级），
  // 若照样去查 classes 会查到 null，UI 上就会空一块。
  let className = '';
  if (isGuest) {
    className = GUEST_CLASS_NAME;
  } else if (storedRole === 'debug') {
    className = '调试模式';
  } else {
    const row = await env.DB.prepare('SELECT name FROM classes WHERE id = ?')
      .bind(session.subject_id).first();
    className = row && row.name ? String(row.name) : '';
  }

  return json({
    ok: true,
    role: isGuest ? GUEST_ROLE : (storedRole || 'class'),
    isGuest,
    className,
  });
}
