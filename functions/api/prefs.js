import { readJson, error, json } from '../../_lib/http.js';
import { requireSession } from '../../_lib/auth.js';
import { getPersonalById, getPrefs, savePrefs } from '../../_lib/personal.js';
import { SITE_THEMES } from '../../_lib/settings.js';

/**
 * 个人配色（MD3 项目，用户决策 14/15）。
 *
 *   GET  —— 读当前个人口令用户的配色；非个人口令一律 403。
 *   POST —— 保存 { mode:'preset', preset } 或 { mode:'custom', colors:{primary,bg,card,text} }。
 *
 * 三条硬约束（对应已确认的决策）：
 *   · **仅个人口令可用**：班级口令/测试/游客身份都拿不到也写不进（前端还做了
 *     整页拦截，这里是服务端真正的闸门）；
 *   · 只写"这个用户自己"的 (class_id, username) 行，**不碰全局站点主题
 *     （system_settings.site_theme），也不碰任何班级设置** —— 主题三层隔离；
 *   · 自定义配色在服务端**再算一遍对比度**（正文 vs 页面背景、正文 vs 卡片底，
 *     与前端同一套公式）。4.0.0 起只返回 warning，**不阻止保存** ——
 *     用户总纲要求“仅给出对比度提示，不禁止应用主题”。
 *
 * 模式互斥（决策 12）：保存预设主题时把自定义配色清空；保存自定义配色时
 * preset 清空。互斥由这里统一保证，前端只负责展示。
 */
const HEX = /^#[0-9a-fA-F]{6}$/;
const MIN_RATIO = 4.5;

/** WCAG 相对亮度（与前端 app.js 的 personalContrast 同一实现）。 */
function lum(hex) {
  const n = parseInt(String(hex).slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

function ratio(a, b) {
  const l1 = lum(a);
  const l2 = lum(b);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

/** 取"当前登录者是不是个人口令 + 是哪一条"；不是就返回 403。 */
async function personalOf(env, request) {
  const auth = await requireSession(env, request, 'class');
  if (!auth.ok) return { error: auth.response };
  const passId = Number(auth.session.personal_pass_id || 0);
  if (!(passId > 0)) return { error: error('偏好设置仅个人口令可用', 403) };
  const pass = await getPersonalById(env, passId);
  if (!pass) return { error: error('个人口令已失效，请重新登录', 401) };
  return { pass };
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const who = await personalOf(env, request);
  if (who.error) return who.error;

  const row = await getPrefs(env, who.pass.class_id, who.pass.username);
  let colors = null;
  if (row && row.colors) {
    try { colors = JSON.parse(row.colors); } catch { colors = null; }
  }
  return json({
    ok: true,
    mode: (row && row.mode) || 'preset',
    preset: (row && row.preset) || '',
    colors,
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const who = await personalOf(env, request);
  if (who.error) return who.error;

  const parsed = await readJson(request);
  if (!parsed.ok) return error(parsed.error, 400);
  const data = parsed.value || {};
  const mode = String(data.mode || '');

  if (mode === 'preset') {
    const preset = String(data.preset ?? '').trim();
    if (!SITE_THEMES.includes(preset)) return error('主题名称不认识', 400);
    // 互斥：切到预设即清空自定义配色（决策 12）。
    await savePrefs(env, who.pass.class_id, who.pass.username, 'preset', preset, '');
    return json({ ok: true, mode: 'preset', preset, colors: null, message: '主题已保存' });
  }

  if (mode === 'custom') {
    const c = data.colors || {};
    for (const k of ['primary', 'bg', 'card', 'text']) {
      if (!HEX.test(String(c[k] || ''))) return error('颜色值需要是 #RRGGBB 格式', 400);
    }
    // 4.0.0（用户总纲）：对比度只提示、不阻止保存。
    // 仍然在服务端算一遍（前端可能被绕过/关闭 JS），低对比度时把具体比值
    // 放进 warning 返回，前端展示给用户参考；颜色照常落库。
    const r1 = ratio(c.text, c.bg);
    const r2 = ratio(c.text, c.card);
    const warning = (r1 < MIN_RATIO || r2 < MIN_RATIO)
      ? `对比度偏低（建议 ≥${MIN_RATIO}:1）：正文/页面背景 ${r1.toFixed(2)}、正文/卡片底 ${r2.toFixed(2)}。`
        + '已按你的选择保存，可随时回来调整。'
      : '';
    const colors = { primary: String(c.primary), bg: String(c.bg), card: String(c.card), text: String(c.text) };
    await savePrefs(env, who.pass.class_id, who.pass.username, 'custom', '', JSON.stringify(colors));
    return json({
      ok: true,
      mode: 'custom',
      preset: '',
      colors,
      warning,
      message: warning ? '自定义配色已保存（对比度偏低，仅提示）' : '自定义配色已保存',
    });
  }

  return error('mode 只能是 preset 或 custom', 400);
}
