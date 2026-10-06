/**
 * 输入校验。
 *
 * 这里是纵深防御，不是唯一防线：真正的 XSS 防线是前端渲染时转义 +
 * Content-Security-Policy。但把所有不可信文本在入库前先收敛成"安全纯文本"，
 * 可以让历史脏数据和任何将来漏掉转义的渲染点都不至于直接变成可执行脚本。
 *
 * 因此：凡是来自用户的字符串，一律经过 sanitizeText() 才能落库。
 */

const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;
const TAG_START = /[<>]/;

/**
 * 收敛为安全纯文本。
 *  - 去掉控制字符（含 \u0000，避免截断类问题）
 *  - 合并连续空白
 *  - 长度上限
 *  - 拒绝 < 和 >
 *
 * 注意：这里不做 HTML 实体转义。转义必须发生在渲染时，否则会出现
 * "存进去是 &lt;，显示出来是 &amp;lt;" 的双重转义问题。
 */
export function sanitizeText(input, { maxLength = 60, field = '输入' } = {}) {
  if (typeof input !== 'string') return { ok: false, error: `${field}格式不正确` };
  const value = input.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  if (!value) return { ok: false, error: `${field}不能为空` };
  if (value.length > maxLength) return { ok: false, error: `${field}太长了（最多 ${maxLength} 个字符）` };
  if (TAG_START.test(value)) return { ok: false, error: `${field}不能包含 < 或 >` };
  return { ok: true, value };
}

/**
 * 解析正整数 ID。用于所有会把数字拼进 HTML 属性 / SQL 参数的位置，
 * 杜绝 "1);alert(1)//" 这类从数字字段打进来的注入。
 */
export function parsePositiveInt(input, { field = '参数', max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = typeof input === 'number' ? input : Number(String(input ?? '').trim());
  if (!Number.isInteger(n) || n <= 0 || n > max) return { ok: false, error: `${field}不正确` };
  return { ok: true, value: n };
}

/** 白名单取值。 */
export function parseEnum(input, allowed, { field = '参数', fallback = null } = {}) {
  const value = typeof input === 'string' ? input.trim() : input;
  if (allowed.includes(value)) return { ok: true, value };
  if (fallback !== null) return { ok: true, value: fallback };
  return { ok: false, error: `${field}不正确` };
}

/**
 * 校验前端上报的浏览器指纹。
 * 前端算好的是 hex 摘要，这里只接受定长十六进制，避免把任意长字符串写进库。
 */
export function parseFingerprint(input) {
  if (typeof input !== 'string') return { ok: false, error: '指纹缺失' };
  const value = input.trim().toLowerCase();
  if (!/^[0-9a-f]{16,64}$/.test(value)) return { ok: false, error: '指纹格式不正确' };
  return { ok: true, value };
}

/** 口令类字段：只做长度和类型检查，绝不改写内容。 */
export function parseSecret(input, { min = 6, max = 128, field = '口令' } = {}) {
  if (typeof input !== 'string') return { ok: false, error: `${field}格式不正确` };
  const value = input.trim();
  if (value.length < min) return { ok: false, error: `${field}至少 ${min} 位` };
  if (value.length > max) return { ok: false, error: `${field}最多 ${max} 位` };
  return { ok: true, value };
}

/**
 * 多行文本（公告内容用）。
 * 与 sanitizeText 的区别是**保留换行**，只把每行内部的多余空白压掉，
 * 并且限制连续空行不超过两行。同样拒绝 < 与 >。
 */
export function sanitizeMultiline(input, { maxLength = 500, field = '内容' } = {}) {
  if (typeof input !== 'string') return { ok: false, error: `${field}格式不正确` };

  const value = input
    .replace(/\r\n?/g, '\n')
    // 只保留换行与制表符，其余控制字符一律去掉
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!value) return { ok: false, error: `${field}不能为空` };
  if (value.length > maxLength) return { ok: false, error: `${field}太长了（最多 ${maxLength} 个字符）` };
  if (TAG_START.test(value)) return { ok: false, error: `${field}不能包含 < 或 >` };
  return { ok: true, value };
}

/**
 * 违禁词的长度上限。
 *
 * 黑名单是"词"的清单，**不是"封某一首歌"的工具**，所以限制单个词的长度：
 * 一整首歌名基本都会超过这个长度，粘不进来；正常违禁词
 * （脏话、敏感词、不许出现的歌手名片段）都远在范围内。
 */
export const BANNED_KEYWORD_MAX = 12;

/** 违禁词校验：短、可读、不含标签字符。 */
export function parseBannedKeyword(raw, { maxLength = BANNED_KEYWORD_MAX } = {}) {
  const text = sanitizeText(raw, { maxLength: 200, field: '违禁词' });
  if (!text.ok) return text;

  if (text.value.length > maxLength) {
    return {
      ok: false,
      error: `违禁词最多 ${maxLength} 个字。黑名单是用来封违禁词的，不是用来封某一首歌的 —— `
        + '要下架某首歌，请到「待审核 / 回收站」里处理。',
    };
  }
  return text;
}

/**
 * 音源标识（点歌时锁定的那一版）。
 *
 * 形如 `ap-1234567890`（苹果）/ `mt-2712018330`（网易云、Meting、GD 形状的中转）
 * / `mg-600902000006889366`（咪咕的 contentId）。
 * 它会被拼进 `/api/music?play=...` 交给上游，所以严格收窄字符集，
 * 杜绝任何意外的 URL 注入。
 * 空值合法（历史数据没有这个字段），表示前端要走"搜索候选"的老流程。
 *
 * ⚠️ 2026-10-07 修：这个白名单**漏了 `mg-`**，于是加了咪咕源之后，
 *   咪咕的候选在搜索结果里**点「选这首」时拿不到选曲凭据**（`signTrackToken` 里
 *   `parseTrackId` 不通过 → 返回 null → 前端 `data-token` 是空串），
 *   学生一提交就被自己的前端拦住并显示「选曲凭据缺失（可能是页面停留太久
 *   或列表是旧版）」—— 报错文案还把矛头指向"停留太久"，完全指错了方向。
 *
 *   教训：**加音源必须同时加这个白名单**。为了不再漏第四次，这里的注释里
 *   写明"前缀清单有三个使用点"：
 *     1. 本函数（凭据签发与提交校验）；
 *     2. `functions/api/music.js` 的 `resolveAudioUrl` / `audioRoutes`（播放解析）；
 *     3. `_lib/playable.js` 的 `neteaseIdOf`（只认 mt-，因为只有 mt- 是网易云 id）。
 *   加新前缀时三处都要看一遍，并有测试盯着（`api.test.mjs` 的"音源前缀"那一组）。
 */
const TRACK_ID_PATTERN = /^(ap|mt|mg)-[A-Za-z0-9_-]{1,64}$/;

export function parseTrackId(raw) {
  if (raw === null || raw === undefined || raw === '') return { ok: true, value: '' };
  if (typeof raw !== 'string') return { ok: false, error: '音源标识不合法' };

  const value = raw.trim();
  if (!value) return { ok: true, value: '' };

  if (!TRACK_ID_PATTERN.test(value)) {
    return { ok: false, error: '音源标识不合法' };
  }
  return { ok: true, value };
}
