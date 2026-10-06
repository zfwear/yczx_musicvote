import { json, error } from '../../_lib/http.js';
import { rateLimit } from '../../_lib/auth.js';
import { powEnabled, powDifficulty, normalizePowAction, issuePowChallenge } from '../../_lib/pow.js';

/**
 * 下发 PoW 谜题。
 *
 * 三条设计要点：
 *  1. **不需要登录**。点歌/投票接口本身要登录，但拿谜题允许在登录前进行 ——
 *     谜题里没有任何身份信息，也不涉及任何数据，只是"请你先算一道题"。
 *     登录态下的学生走的是同一个入口，不需要两套。
 *  2. **必须限流**。这是站内唯一一个"不登录就能反复调用"的接口 ——
 *     签一个谜题要花一次 HMAC，不设闸门就等于给脚本开了一个免费资源口子。
 *  3. **功能关闭时也回 200 + enabled:false**，不报错 ——
 *     前端据此跳过即可，不该因为"这个功能没开"而让页面以为出了故障。
 *
 * 只导出 onRequestGet：Pages Functions 对没有对应处理器的请求方法
 * 自动返回 405，所以这里不需要额外写 onRequest。
 */

/**
 * 每台设备（拿不到 cid 时按 IP）每小时能取几次谜题。
 *
 * 定 30 的理由：正常学生点歌、投票各取一次，失败重试几次，30 次远远用不完；
 * 而脚本要刷谜题就会被按在这里。调大它之前先读下面那段"两道怎么配合"。
 */
const POW_LIMIT_PER_DEVICE = 30;
/**
 * 一个出口 IP 每小时的总上限。
 *
 * ⚠️ 这个值必须**明显大于** `POW_LIMIT_PER_DEVICE`，否则校园网（全校一个出口 IP）
 * 里只要有一个人把设备额度用满，第二个人就被挡 —— 那就变成"全校共享 30 次"。
 * 这里给 300：正常校园流量（点歌 + 投票各一两次 × 几百人）远远不到，
 * 而一个脚本农场会被按住。
 */
const POW_LIMIT_PER_IP = 300;
export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  /**
   * 限流：**两道各自独立生效，任一道超了就拒**（每台 30/小时、每个出口 IP 300/小时）。
   *
   * ⚠️ 这里**故意不用 `guardRate()`**，改直调 `rateLimit()` —— 踩了两次才想通：
   *
   * 【坑一】第一版没读任何身份信号，`rateKey()` 退化按 IP，而校园网全校共用一个出口 IP：
   *   等于**全校共享一份额度**，启用 PoW 后正常学生会被同学挡在门外。
   *   修法：前端带一个本机随机 `cid`（存 localStorage，见 vote.html 的 `powClientId()`）。
   *
   * 【坑二，更隐蔽】改用 `guardRate()` 之后配额**依然不生效**。实测（每台 30 / 兜底 30）：
   *   第 31 次请求身份桶 count=31（已超）→ 它去查 IP 桶 → IP 桶 **count=1**（放行）。
   *   原因是 `guardRate` 只在"身份额度已经用完"之后才查 IP 桶，所以 IP 桶**天然比身份桶小**，
   *   而它的语义是"**两道都超才拒绝，任何一道有余量就放行**"——
   *   那道兜底永远有余量、永远把身份额度顶掉。**两道都查过、任一道超就拒**才是这里要的。
   *
   * 【为什么两道都要】
   *   · 只留每台 30：`cid` 是客户端自己报的，脚本每次换一个 cid 就绕过了 ——
   *     等于没限。所以必须有 IP 那一道兜住"同一出口换身份刷"。
   *   · 只留每 IP 300：校园网全校一个出口，等于全校共享 300 次，
   *     一个人刷就能把同学挡在门外。所以必须有每台那一道保公平。
   *   两道一起，才是"既拦脚本、又不让学生互相顶掉"。
   */
  const rawCid = (url.searchParams.get('cid') || '').trim();
  const clientId = /^[A-Za-z0-9_-]{8,64}$/.test(rawCid) ? rawCid : '';
  const ip = (request.headers.get('cf-connecting-ip') || 'unknown').slice(0, 45);

  // 身份那一道：有 cid 按设备，没有就退化成按 IP（老前端 / 直接打接口，行为不更宽松）
  const deviceBucket = clientId ? `pow:cid:${clientId}` : `pow:ip:${ip}`;
  const ipBucket = `pow:ip:${ip}`;

  const device = await rateLimit(env, deviceBucket, POW_LIMIT_PER_DEVICE, 3600);
  if (!device.allowed) return error('请求过于频繁，请稍后再试', 429);

  // IP 那一道：桶与身份桶相同时不重复查（省一次往返）
  if (ipBucket !== deviceBucket) {
    const byIp = await rateLimit(env, ipBucket, POW_LIMIT_PER_IP, 3600);
    if (!byIp.allowed) return error('请求过于频繁，请稍后再试', 429);
  }

  let action = 'vote';
  try {
    action = normalizePowAction(url.searchParams.get('action'));
  } catch {
    action = 'vote';
  }

  if (!powEnabled(env)) {
    return json({
      ok: true,
      enabled: false,
      action,
      challenge: '',
      difficulty: powDifficulty(env),
      expiresIn: 0,
    });
  }

  const issued = await issuePowChallenge(env, { action });

  // 启用状态下签不出来，只可能是密钥在这两步之间被摘掉了：
  // 按"关闭"答复（前端会跳过），可用性优先。
  if (!issued) {
    return json({
      ok: true,
      enabled: false,
      action,
      challenge: '',
      difficulty: powDifficulty(env),
      expiresIn: 0,
    });
  }

  return json({
    ok: true,
    enabled: true,
    action,
    challenge: issued.challenge,
    difficulty: issued.difficulty,
    expiresIn: issued.expiresIn,
  });
}
