/**
 * 浏览器端 PoW（工作量证明）防刷票。
 *
 * 定位：reCAPTCHA 之外**再加一道**人机成本，不是替换它。默认关闭。
 *
 * 为什么要有它：
 *   reCAPTCHA v3 依赖 Google 的域名。大陆网络下脚本经常加载不出来，
 *   而 _lib/recaptcha.js 的策略是"可用性优先"—— 脚本被墙就放行。
 *   于是在那段时间里，写接口实际上没有任何人机成本。PoW 完全在站内闭环：
 *   谜题由 /api/pow 下发，学生在浏览器里算 nonce，服务端只做一次校验。
 *   脚本要照样刷，就得为每一次提交付出一份可观的 CPU 时间。
 *
 * 环境变量（Cloudflare Pages 的 Variables and Secrets）：
 *   POW_ENABLED    只有恰好等于 '1' 才启用（与 DEBUG_LOGIN 同一风格），默认关闭
 *   POW_DIFFICULTY 要求哈希开头的十六进制 0 的个数，默认 3；只接受 3~6 的整数
 *   POW_SECRET     签名密钥；没配就退回 AUTH_PEPPER；两个都没有 -> 整个功能自动关闭
 *   POW_EMERGENCY_OFF 紧急关闭：设成 '1' 时整个功能立刻停用（不必删密钥），
 *                     用于线上出问题时几秒内恢复服务。默认不配。
 *
 * 为什么没有密钥就宁可不启用：
 *   谜题必须由服务端签名，否则客户端可以自己造一个"难度 0"的谜题，
 *   闸门等于不存在。没有密钥就签不出可信的谜题，也就谈不上防降级 ——
 *   与其开一个能被绕过的闸门，不如直接返回 enabled:false 让前端跳过。
 *   后端也不依赖前端自觉：verifyPow 在功能关闭时返回 skipped 放行。
 *
 * 单次校验的 CPU 预算（免费套餐 10ms CPU）：
 *   只做一次 HMAC-SHA256（验签）+ 一次 SHA-256（验工作量），**没有循环**，
 *   与 reCAPTCHA 那一次网络请求相比可以忽略。
 *
 * 签名覆盖了什么（这是"客户端挑不了简单难度"的原因）：
 *   sig = HMAC-SHA256(secret, 'pow|' + action + '|' + difficulty + '|' + exp + '|' + challenge)
 *   action、difficulty、过期时间、谜题本体全部绑在同一个签名里，
 *   改动任何一个字节都会让验签失败。
 */

import { hmacHex, randomToken } from './crypto.js';

/**
 * 默认难度：哈希开头要有 3 个十六进制 0（平均约 2^12 = 4096 次尝试）。
 *
 * ⚠️ 这个值**从 4 降到 3**（2026-10-07 实测后改的），原因是移动端的真实速度：
 *   · 本机（桌面 V8 + 原生 WebCrypto）实测难度 4 要约 2.2 秒 / 10 万次尝试；
 *   · 手机浏览器普遍慢 3~10 倍 → 难度 4 在旧机型上要 10~20 秒，**学生直接以为卡死了**；
 *   · 而难度 3 只要约 4096 次尝试，手机上通常 0.2 秒以内，几乎无感。
 * 难度 3 的防刷效果弱一些（脚本成本从"约 6.5 万次哈希"降到"约 4 千次"），
 * 但它仍然把"每个请求都要花 CPU"这件事立住了 —— 而真正的去重与限流是设备指纹
 * 与 guardRate 那两道（见 README）。**宁可低一点、别把正常学生挡在门外。**
 * 想加严：设 POW_DIFFICULTY=4（并亲手在旧手机上试一次再决定）。
 */
const DEFAULT_DIFFICULTY = 3;
/** 允许的难度区间：太低拦不住脚本，太高会让弱机型算不完。 */
const MIN_DIFFICULTY = 3;
const MAX_DIFFICULTY = 6;
/**
 * 谜题有效期（秒）。
 *
 * ⚠️ 从 120 提到 300，理由是"谜题是**在点击提交之后**才取的"：
 *   点提交 → 取谜题（1 次网络往返）→ 在浏览器里算 → 再提交。
 *   慢手机 + 弱网下这一段可能超出 120 秒，而超时的表现是**403 且文案是
 *   "校验已过期，请刷新页面重试"** —— 学生会以为站点坏了。
 * 放宽到 300 秒的代价是"一个解可以在 5 分钟内被重用"，
 * 而那个窗口本来就靠设备指纹去重与限流兜着（见 README 里的边界说明）。
 */
const CHALLENGE_TTL_SECONDS = 300;
/** 谜题版本前缀，将来换算法时可以并存。 */
const POW_VERSION = 'v1';
/** 签名串的域分隔前缀：同一个密钥复用在别处时不会互相牵连。 */
const SIGN_PREFIX = 'pow';
/** 段长上限：客户端送来的东西一律先量长度再看内容，避免无谓的解析开销。 */
const MAX_SEGMENT = 128;
const MAX_PROOF_LENGTH = 400;
const MAX_NONCE_LENGTH = 128;

/** 拒绝时的统一文案：不告诉对方到底哪一步没过。 */
const REFUSE = { ok: false, error: '防刷校验未通过，请刷新页面重试' };

const encoder = new TextEncoder();

function readEnv(env, name) {
  return String((env && env[name]) || '').trim();
}

/**
 * 签名密钥：优先 POW_SECRET，其次 AUTH_PEPPER；都没有时返回空串。
 *
 * 导出是为了让 config.js 能判断"密钥到底配了没" —— 那是运维排查
 * "POW_ENABLED=1 却不生效"时最需要的一条信息。
 */
export function powSecret(env) {
  return readEnv(env, 'POW_SECRET') || readEnv(env, 'AUTH_PEPPER');
}

/**
 * 是否启用 PoW。
 * 必须同时满足：
 *   1. POW_ENABLED 恰好为 '1'
 *   2. 未被 POW_EMERGENCY_OFF=1 紧急关闭
 *   3. 能拿到密钥（POW_SECRET 或 AUTH_PEPPER 至少配一个）
 */
export function powEnabled(env) {
  if (readEnv(env, 'POW_ENABLED') !== '1') return false;
  // 紧急开关：设成 '1' 时整个功能立刻停用，返回 false —— 语义与"从没启用"一致。
  // 用途：上线后发现大面积"算不出来"、上游抖动、或某个机型集中报错，
  //      运维改一个变量再部署就能几秒内恢复服务，不必动 POW_ENABLED 或删密钥。
  // 为什么不直接改 POW_ENABLED=0：那会丢掉"曾经开过"这件事，
  //      事后排查时无法区分"从没部署过"与"上线后紧急关掉了"。
  if (readEnv(env, 'POW_EMERGENCY_OFF') === '1') return false;
  return powSecret(env).length > 0;
}

/**
 * 生效难度：只接受 3~6 的整数，其它值（含 99 / 0 / 小数 / 空串）一律回落到 3。
 * 难度是签名覆盖的字段，所以这里收敛一次，客户端就没有"自己挑难度"的余地。
 */
export function powDifficulty(env) {
  const raw = readEnv(env, 'POW_DIFFICULTY');
  if (!/^\d+$/.test(raw)) return DEFAULT_DIFFICULTY;
  const value = Number(raw);
  if (value < MIN_DIFFICULTY || value > MAX_DIFFICULTY) return DEFAULT_DIFFICULTY;
  return value;
}

/** action 白名单：只认 vote / upvote，其它一律当 vote。 */
export function normalizePowAction(action) {
  const value = String(action == null ? '' : action).trim();
  return value === 'upvote' ? 'upvote' : 'vote';
}

/** 把 action / difficulty / exp / challenge 绑成一个签名。 */
async function signChallenge(secret, action, difficulty, exp, challenge) {
  return hmacHex(
    secret,
    `${SIGN_PREFIX}|${action}|${difficulty}|${exp}|${challenge}`
  );
}

/** 长度恒定的比较：签名比对不按字符提前返回。 */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * 签发一个谜题。
 *
 * 未启用（含"配了 POW_ENABLED=1 但没有密钥"）时返回 null —— 调用方应先看
 * powEnabled()，不要把 null 当谜题发出去。
 *
 * @returns {Promise<{challenge: string, difficulty: number, expiresIn: number}|null>}
 */
export async function issuePowChallenge(env, { action } = {}) {
  if (!powEnabled(env)) return null;

  const act = normalizePowAction(action);
  const difficulty = powDifficulty(env);
  const expiresIn = CHALLENGE_TTL_SECONDS;
  const exp = Math.floor(Date.now() / 1000) + expiresIn;

  // 16 字节 = 128 bit 随机：既猜不到别人拿到的谜题，也没法预先算好一批通用解 ——
  // 每个谜题的解都不一样，所以"解一次、反复用"只在这个谜题的有效期内成立。
  const challenge = randomToken(16);
  const sig = await signChallenge(powSecret(env), act, difficulty, exp, challenge);

  return {
    challenge: [POW_VERSION, act, difficulty, exp, challenge, sig].join('.'),
    difficulty,
    expiresIn,
  };
}

/**
 * 校验前端提交的 { challenge, nonce }。
 *
 * 返回 { ok:true } 放行（可能带 skipped 标记），{ ok:false, error } 拒绝。
 * 校验顺序：功能未启用 -> 形状 -> action -> 难度 -> 过期 -> 签名 -> 工作量。
 *
 * @param {object} env
 * @param {{challenge?: string, nonce?: string}} proof
 * @param {{action?: string}} opts
 */
export async function verifyPow(env, proof, { action } = {}) {
  // 功能没启用（默认状态）：放行，并带上 skipped 让调用方/测试看得见原因。
  if (!powEnabled(env)) return { ok: true, skipped: true };

  const act = normalizePowAction(action);

  // ---- 形状不对：没带、不是对象、不是字符串、太长 ----
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) return REFUSE;
  const rawChallenge = typeof proof.challenge === 'string' ? proof.challenge.trim() : '';
  const nonce = typeof proof.nonce === 'string' ? proof.nonce.trim() : '';
  if (!rawChallenge || rawChallenge.length > MAX_PROOF_LENGTH) return REFUSE;
  if (!nonce || nonce.length > MAX_NONCE_LENGTH) return REFUSE;

  const parts = rawChallenge.split('.');
  if (parts.length !== 6) return REFUSE;
  const [version, proofAction, rawDifficulty, rawExp, challenge, sig] = parts;
  if (version !== POW_VERSION) return REFUSE;
  if (!challenge || challenge.length > MAX_SEGMENT) return REFUSE;
  if (!sig || sig.length > MAX_SEGMENT) return REFUSE;

  // ---- action 绑定：给 vote 签的谜题不能拿到 upvote 上用（反之亦然） ----
  if (proofAction !== act) return REFUSE;

  // ---- 难度：只认服务端当前配置的那一档，且必须在合法区间 ----
  // 客户端把 difficulty 改小会直接踩到签名（下一条），这里再挡一次"区间外"。
  if (!/^\d+$/.test(rawDifficulty)) return REFUSE;
  const difficulty = Number(rawDifficulty);
  if (difficulty < MIN_DIFFICULTY || difficulty > MAX_DIFFICULTY) return REFUSE;
  if (difficulty !== powDifficulty(env)) return REFUSE;

  // ---- 过期：不给无限期的谜题 ----
  if (!/^\d+$/.test(rawExp)) return REFUSE;
  const exp = Number(rawExp);
  if (Math.floor(Date.now() / 1000) > exp) {
    return { ok: false, error: '校验已过期，请刷新页面重试' };
  }

  // ---- 签名：action / difficulty / exp / challenge 一起验 ----
  // 这是"客户端自己挑简单难度"过不去的关：难度是签名覆盖的字段，
  // 把 4 改成 1 会让 sig 对不上；换个自己的 challenge 也一样签不出来。
  const expected = await signChallenge(powSecret(env), act, difficulty, exp, challenge);
  if (!timingSafeEqual(expected, sig)) return REFUSE;

  // ---- 工作量：SHA-256(challenge + ':' + nonce) 开头要有 difficulty 个十六进制 0 ----
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`${challenge}:${nonce}`));
  const bytes = new Uint8Array(digest);
  let leading = 0;
  for (let i = 0; i < bytes.length && leading < difficulty; i++) {
    if (bytes[i] === 0) { leading += 2; continue; }
    if (bytes[i] < 16) leading += 1;
    break;
  }
  if (leading < difficulty) return REFUSE;

  return { ok: true, action: act, difficulty };
}
