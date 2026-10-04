/**
 * 密码哈希与令牌工具。
 *
 * 设计要点：
 *  1. 绝不存储明文口令。数据库里存的是自描述字符串：
 *       pbkdf2$sha256$<迭代次数>$<salt>$<hash>
 *     迭代次数写在字符串里，所以以后想调高成本，老口令依然能验证通过。
 *  2. PBKDF2-SHA256 是 WebCrypto 里唯一可用的慢哈希。Argon2id 更强，但
 *     Cloudflare Workers 的 crypto.subtle 不提供实现，且免费套餐不允许引入
 *     原生模块，因此这里用 PBKDF2 作为工程上的最优解。
 *  3. 兼容旧的明文口令：验证通过后由调用方写回哈希（transparent rehash），
 *     这样不需要提前知道现网密码就能完成迁移。
 */

const encoder = new TextEncoder();

/**
 * PBKDF2 迭代次数。
 *
 * 这个值是被平台**硬约束**决定的，不是随手选的：
 *
 *   Cloudflare Workers / Pages Functions 免费套餐：单次请求 CPU 时间上限 **10 ms**，
 *   超出即返回 Error 1102（Worker exceeded resource limits）。
 *   好消息是"等待 D1 查询"不计入 CPU 时间，所以 CPU 基本只花在 PBKDF2 上。
 *
 * 本机实测（见 _harness/bench.mjs）：
 *     5,000 → 1.14 ms      20,000 → 3.81 ms
 *    10,000 → 2.04 ms      25,000 → 4.75 ms
 *    15,000 → 2.91 ms      50,000 → 9.17 ms  ← 已越过 10ms 红线
 *
 * 取 10,000：即使走到最贵的那条路径（管理员改密要"校验一次 + 新哈希一次"，
 * 首次登录迁移旧明文也要两次），总耗时也只有约 4 ms，不到预算的一半。
 * 文档说明超额只是"偶发容忍"，一旦持续超限就会被终止，所以必须留足余量。
 *
 * 📌 升级到付费套餐后，把这里改成 210000（OWASP 建议值）即可：
 *    迭代次数写在每条哈希字符串里，旧口令下次登录会自动按新成本重新哈希，
 *    不需要重置任何人的密码。
 */
export const PBKDF2_ITERATIONS = 10000;

const SALT_BYTES = 16;
const KEY_BYTES = 32;

/** Uint8Array -> base64url（无填充） */
function bytesToB64url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url -> Uint8Array */
function b64urlToBytes(str) {
  const normalized = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** 长度恒定的比较，避免按字节提前返回导致的时序侧信道。 */
function timingSafeEqualBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function timingSafeEqualString(a, b) {
  return timingSafeEqualBytes(encoder.encode(a), encoder.encode(b));
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, KEY_BYTES * 8
  );
  return new Uint8Array(bits);
}

/** 生成新的口令哈希字符串。 */
export async function hashPassword(password, iterations = PBKDF2_ITERATIONS) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await pbkdf2(password, salt, iterations);
  return `pbkdf2$sha256$${iterations}$${bytesToB64url(salt)}$${bytesToB64url(hash)}`;
}

/**
 * 校验口令。
 * @returns {{ok: boolean, needsRehash: boolean}}
 *   needsRehash 为 true 表示这条记录还是旧格式（明文/弱哈希），
 *   登录成功后调用方应当立刻写回 hashPassword() 的结果。
 */
export async function verifyPassword(stored, password) {
  const fail = { ok: false, needsRehash: false };
  if (typeof stored !== 'string' || stored.length === 0) return fail;
  if (typeof password !== 'string' || password.length === 0) return fail;

  const parts = stored.split('$');

  // 旧格式：明文。
  if (parts.length === 1) {
    const ok = timingSafeEqualString(stored, password);
    return { ok, needsRehash: ok };
  }

  // 弱格式：sha256$<salt>$<hash>（无迭代）。验证通过后同样升级。
  if (parts.length === 3 && parts[0] === 'sha256') {
    const salt = parts[1];
    const actual = await sha256Hex(salt + password);
    const ok = timingSafeEqualString(actual, parts[2]);
    return { ok, needsRehash: ok };
  }

  // 当前格式：pbkdf2$sha256$<iters>$<salt>$<hash>
  if (parts.length === 5 && parts[0] === 'pbkdf2' && parts[1] === 'sha256') {
    const iterations = Number(parts[2]);
    if (!Number.isInteger(iterations) || iterations <= 0 || iterations > 5_000_000) return fail;
    let salt;
    let expected;
    try {
      salt = b64urlToBytes(parts[3]);
      expected = b64urlToBytes(parts[4]);
    } catch {
      return fail;
    }
    const actual = await pbkdf2(password, salt, iterations);
    const ok = timingSafeEqualBytes(actual, expected);
    return { ok, needsRehash: ok && iterations !== PBKDF2_ITERATIONS };
  }

  return fail;
}

/** 生成密码学安全的随机令牌（默认 32 字节 = 256 bit）。 */
export function randomToken(byteLength = 32) {
  return bytesToB64url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

/**
 * 生成"人类可读"的随机码，用于管理员邀请口令。
 *
 * 字母表刻意剔除了 0/O、1/I/L 等易混字符 —— 邀请码是要靠嘴念、靠手抄
 * 转达给别人的，31 个符号取 12 位约等于 2^59 种组合，足够抗爆破。
 */
const READABLE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function randomReadableCode(length = 12) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = '';
  for (let i = 0; i < length; i++) {
    out += READABLE_ALPHABET[bytes[i] % READABLE_ALPHABET.length];
  }
  return out;
}

/** 归一化用户输入的邀请码：忽略大小写、空格与分隔符。 */
export function normalizeInviteCode(value) {
  return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** 把 12 位邀请码排成 XXXX-XXXX-XXXX，便于抄写。 */
export function formatInviteCode(code) {
  return String(code ?? '').replace(/(.{4})(?=.)/g, '$1-');
}

/** SHA-256 十六进制摘要。用于把会话令牌变成不可逆的存储值。 */
export async function sha256Hex(input) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  const bytes = new Uint8Array(digest);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

/**
 * HMAC-SHA256(secret, message) -> hex。
 *
 * 用途：班级口令的"查找索引"。加盐哈希没法用 SQL 等值查询（同一个口令每次
 * 哈希都不同），而班级口令本身就是身份标识、没有用户名可以先定位。如果登录时
 * 对每个班级各跑一次 PBKDF2，班级一多就会超 CPU 预算。
 *
 * 所以额外存一列 password_lookup = HMAC(服务端私钥, 口令)：
 *  - 用它做 O(1) 索引查询；
 *  - 真正的口令校验仍然走加盐 PBKDF2；
 *  - 私钥存在环境变量 AUTH_PEPPER 里、不在数据库中，
 *    因此即使数据库被整个导出，也无法离线爆破这一列反推口令。
 */
export async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  const bytes = new Uint8Array(signature);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

/** 导出给测试使用。 */
export const __internals = { bytesToB64url, b64urlToBytes, timingSafeEqualBytes };

/* ============================================================
   可查看的凭据保险箱（AES-GCM）
   ============================================================

   为什么需要它：
   班级口令是要**发到各个班**的，管理员必须随时能查到"高一(3)班的口令是什么"。
   如果只存 PBKDF2 哈希，管理员自己也拿不回来，那就没法分发了。

   所以班级口令存两份：
     · password            加盐 PBKDF2 哈希 —— 登录校验用，不可逆
     · password_encrypted  AES-GCM 密文   —— 仅用于管理员查看

   密钥由 AUTH_PEPPER 派生，**存在环境变量里而不是数据库里**。
   因此只拿到数据库（没有环境变量）依然解不开这些密文，
   比直接存明文强得多。

   ⚠️ 前提：必须配置 AUTH_PEPPER。不配置时会退回源码里的默认值，
      等于任何人都能解开密文 —— 后台会明确提示这一点。
   ============================================================ */

const VAULT_SALT = 'yczx-secret-vault-v1';
const VAULT_ITERATIONS = 1000;

async function vaultKey(pepper) {
  const material = await crypto.subtle.importKey(
    'raw', encoder.encode(pepper), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: encoder.encode(VAULT_SALT), iterations: VAULT_ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/** 加密一个可查看凭据，返回 v1.<iv>.<密文>。 */
export async function encryptSecret(pepper, plain) {
  const key = await vaultKey(pepper);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, encoder.encode(String(plain))
  );
  return `v1.${bytesToB64url(iv)}.${bytesToB64url(new Uint8Array(cipher))}`;
}

/** 解密；密钥不对或数据损坏时返回 null，不抛异常。 */
export async function decryptSecret(pepper, stored) {
  if (typeof stored !== 'string' || !stored.startsWith('v1.')) return null;
  const parts = stored.split('.');
  if (parts.length !== 3) return null;
  try {
    const key = await vaultKey(pepper);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64urlToBytes(parts[1]) },
      key,
      b64urlToBytes(parts[2])
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}
