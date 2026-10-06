import { json } from '../../_lib/http.js';

/**
 * 健康检查。**不需要登录**（监控与负载均衡本来就不会带会话）。
 *
 * 为什么单独做一个：搬到自有服务器之后会有反代 / 进程守护 / 探活脚本，
 * 它们需要一条"便宜、稳定、不碰数据库"的路径来判断实例是否活着。
 * 拿 `/api/config` 当探针是不合适的 —— 它会去查 `system_settings`，
 * 于是"数据库迁移没跑"会被报成"服务挂了"，排查方向直接被带偏。
 *
 * 所以这里**故意不查库**：只要进程还能处理请求就回 200。
 * 数据库的健康状况由 `/api/config`（它会读一次设置表）那一侧反映，
 * 两件事分开看，才不会互相掩盖。
 *
 * 注意：它是**唯一**被域名白名单中间件放行的接口（见 `functions/_middleware.js`
 * 开头那段说明）。这是有意的 —— 2026-10-08 那次 ESA 回源 TLS 挂掉（HTTP 525）时，
 * "源站到底还活着吗"从外部没法直接问，因为直连源站的 health 也被挡成了 403，
 * 只能从 403 正文里反推。放开这一个**不含任何数据**的接口，
 * 就能让"源站活着吗 / 卡在哪一层"变成一条 curl 就能回答的问题。
 *
 * 页面与其它接口仍然按白名单拦（非白名单域名的 fetch 会拿到 403）。
 */
export async function onRequestGet(context) {
  const request = context && context.request;

  /**
   * 把"源站这次看到的域名"一并报出来（2026-10-08 加的）。
   *
   * 为什么值得占一行：那次整站打不开（ERR_TOO_MANY_REDIRECTS），根因是
   * 站点前面有一层网关（阿里云 ESA）回源时**把 Host 改写成了源站主机名**，
   * 于是中间件认不出 `vote.yzstu.top`、一直往正确域名上跳，跳到死循环。
   * 而"源站到底看到了什么主机名"**从外部完全看不出来** —— 那次是靠
   * 逐个头去猜才定位的。把它放进健康检查，以后一条 curl 就能看见。
   *
   * 这几个值都不是敏感信息（就是请求自己带的域名），公开没有风险。
   */
  const seen = [];
  const push = (v) => {
    const h = String(v == null ? '' : v).trim().toLowerCase();
    if (h && !seen.includes(h)) seen.push(h);
  };
  try { push(new URL(request.url).hostname); } catch { /* 拿不到就算了 */ }
  if (request) {
    push(request.headers.get('host'));
    for (const name of ['x-forwarded-host', 'x-original-host', 'x-real-host']) {
      const raw = request.headers.get(name);
      if (raw) {
        const parts = String(raw).split(',');
        push(parts[parts.length - 1]);
      }
    }
  }

  return json({
    ok: true,
    // 前端与运维靠这个字段确认"部署的到底是哪一版"（页脚也显示同一个号）
    version: '1.1.1',
    // 给监控一个"服务在动"的信号；不含任何配置或数据
    time: new Date().toISOString(),
    // 诊断用：源站实际看到的主机名（含网关留下的转发头）
    seenHost: seen,
  });
}
