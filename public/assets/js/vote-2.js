
// 试听结果来自外部音源接口，属于不可信内容，必须转义后才能拼进 innerHTML。
function escapeHtml(str) { return String(str ?? '').replace(/[&<>'"]/g, tag => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'}[tag] || tag)); }

/* ============================================================
   页面内弹窗 / 轻提示
   —— 替代浏览器原生 alert / confirm / prompt。
   原生弹窗样式无法控制、在手机上尤其难看，这里统一自绘。
   样式由 JS 注入 <style>，不改动页面自身的样式块。
   ============================================================ */

function uiStyles(){
  if(document.getElementById('uiKitStyle')) return;
  const s = document.createElement('style');
  s.id = 'uiKitStyle';
  s.textContent = [
    '@keyframes uiFadeIn{from{opacity:0}to{opacity:1}}',
    '@keyframes uiFadeOut{from{opacity:1}to{opacity:0}}',
    '@keyframes uiPopIn{from{opacity:0;transform:translateY(16px) scale(.96)}to{opacity:1;transform:translateY(0) scale(1)}}',
    '@keyframes uiToastIn{from{opacity:0;transform:translate(-50%,14px)}to{opacity:1;transform:translate(-50%,0)}}',
    '@keyframes uiSheen{from{background-position:-140% 0}to{background-position:240% 0}}',

    '.ui-overlay{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;',
    '  background:rgba(15,23,42,.42);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);animation:uiFadeIn .2s ease}',
    '.ui-overlay.ui-closing{animation:uiFadeOut .16s ease forwards}',

    '.ui-box{width:100%;max-width:380px;padding:22px;border-radius:20px;',
    '  background:rgba(255,255,255,.97);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);',
    '  border:1px solid rgba(255,255,255,.92);',
    '  box-shadow:0 24px 60px -14px rgba(15,23,42,.42),inset 0 1px 0 rgba(255,255,255,.9);',
    '  animation:uiPopIn .26s cubic-bezier(.2,.9,.3,1.15)}',

    '.ui-title{margin:0 0 8px;font-size:17px;font-weight:700;color:#0f172a;letter-spacing:.3px}',
    '.ui-msg{margin:0 0 16px;font-size:14px;line-height:1.65;color:#475569;white-space:pre-wrap;word-break:break-word}',
    '.ui-input{width:100%;box-sizing:border-box;padding:12px;margin:0 0 16px;font-size:15px;border-radius:12px;',
    '  border:1px solid #dbe3ec;background:rgba(248,250,252,.95);color:#1e293b;transition:border-color .18s,box-shadow .18s}',
    '.ui-input:focus{outline:none;border-color:#38bdf8;box-shadow:0 0 0 3px rgba(56,189,248,.22)}',

    '.ui-actions{display:flex;gap:10px;justify-content:flex-end}',

    /* 按钮统一带一点立体感：内高光 + 投影，按下时下沉 */
    '.ui-btn{width:auto;flex:0 0 auto;margin:0;padding:11px 20px;font-size:14px;font-weight:600;border:0;border-radius:12px;',
    '  cursor:pointer;transition:transform .14s cubic-bezier(.2,.9,.3,1.2),box-shadow .18s,filter .18s}',
    '.ui-btn:active{transform:translateY(1px) scale(.985)}',
    '.ui-btn-primary{color:#fff;background:linear-gradient(180deg,#38bdf8,#0284c7);',
    '  box-shadow:0 6px 16px -4px rgba(2,132,199,.55),inset 0 1px 0 rgba(255,255,255,.45)}',
    '.ui-btn-primary:hover{filter:brightness(1.06);box-shadow:0 8px 20px -4px rgba(2,132,199,.6),inset 0 1px 0 rgba(255,255,255,.5)}',
    '.ui-btn-danger{color:#fff;background:linear-gradient(180deg,#fb7185,#e11d48);',
    '  box-shadow:0 6px 16px -4px rgba(225,29,72,.5),inset 0 1px 0 rgba(255,255,255,.4)}',
    '.ui-btn-danger:hover{filter:brightness(1.06)}',
    '.ui-btn-ghost{color:#475569;background:linear-gradient(180deg,#fff,#eef2f7);border:1px solid #dbe3ec;',
    '  box-shadow:0 4px 12px -4px rgba(15,23,42,.16),inset 0 1px 0 rgba(255,255,255,.9)}',
    '.ui-btn-ghost:hover{color:#0f172a}',

    '.ui-toast{position:fixed;left:50%;bottom:34px;z-index:10000;transform:translateX(-50%);',
    '  max-width:min(88vw,420px);padding:13px 20px;border-radius:999px;font-size:14px;font-weight:600;color:#fff;',
    '  background:rgba(15,23,42,.9);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);',
    '  box-shadow:0 12px 30px -8px rgba(15,23,42,.5);animation:uiToastIn .28s cubic-bezier(.2,.9,.3,1.15);',
    '  transition:opacity .3s ease,transform .3s ease;word-break:break-word;text-align:center}',
    '.ui-toast-ok{background:linear-gradient(180deg,#34d399,#059669);box-shadow:0 12px 30px -8px rgba(5,150,105,.55)}',
    '.ui-toast-err{background:linear-gradient(180deg,#fb7185,#e11d48);box-shadow:0 12px 30px -8px rgba(225,29,72,.55)}',
    '.ui-toast.ui-hide{opacity:0;transform:translate(-50%,12px)}',
    /* ---- 设计层 v2 · 弹窗与轻提示 ---- */
    ".ui-actions{flex-wrap:wrap}",
    ".ui-actions .ui-btn{width:auto;max-width:100%;box-sizing:border-box;flex:0 1 auto}",
    ".ui-actions-single{display:block}",
    ".ui-actions-single .ui-btn{display:block;width:100%;box-sizing:border-box;padding:11px 12px;text-align:center}",
    ".ui-overlay{box-sizing:border-box}",
    ".ui-overlay{background:rgba(15,23,42,.40);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)}",
    ".ui-overlay.ui-closing{animation:uiFadeOut .18s var(--ease,ease) forwards}",
    ".ui-box{background:var(--surface,#fff);border:1px solid var(--line,#e2e8f0);border-radius:var(--r-xl,20px);box-shadow:var(--shadow-pop,0 18px 44px -18px rgba(15,23,42,.34))}",
    ".ui-title{font-size:17px;font-weight:680}",
    ".ui-msg{font-size:14.5px;line-height:1.7;color:var(--ink-3,#475569)}",
    ".ui-input{background:var(--surface-2,#f8fafc);color:var(--ink,#0f172a);border:1px solid var(--line-strong,#cbd5e1);border-radius:var(--r-ctl,10px)}",
    ".ui-input:focus{border-color:var(--brand,#0284c7);box-shadow:var(--ring,0 0 0 3px rgba(2,132,199,.3))}",
    ".ui-btn{min-height:42px;padding:10px 18px;border-radius:var(--r-ctl,10px);font-weight:640;letter-spacing:.02em;transition:background-color .14s var(--ease,ease),border-color .14s var(--ease,ease),color .14s var(--ease,ease),transform .14s var(--ease,ease)}",
    ".ui-btn:active{transform:translateY(1px)}",
    ".ui-btn-primary{background:var(--brand,#0369a1);box-shadow:none}",
    ".ui-btn-primary:hover{filter:none;background:var(--brand-strong,#075985)}",
    ".ui-btn-danger{background:var(--danger,#e11d48);box-shadow:none}",
    ".ui-btn-danger:hover{filter:none;opacity:.92}",
    ".ui-btn-ghost{background:var(--surface-2,#f1f5f9);border:1px solid var(--line,#e2e8f0);color:var(--ink-2,#334155);box-shadow:none}",
    ".ui-btn-ghost:hover{background:var(--surface-3,#e8edf3);color:var(--ink,#0f172a)}",
    ".ui-toast{background:var(--ink,#0f172a);box-shadow:0 14px 32px -10px rgba(15,23,42,.45)}",
    ".ui-toast-ok{background:var(--success,#059669)}",
    ".ui-toast-err{background:var(--danger,#e11d48)}",
    "@media(prefers-reduced-motion:reduce){.ui-overlay,.ui-box,.ui-toast{animation:none !important}}",
    "/* ---- 设计层 v2 · 弹窗与轻提示 ---- */ */",
  ].join('\n');
  document.head.appendChild(s);
}

/** 对话框：resolve(true/false)；带输入框时 resolve(字符串/null)。 */
function uiDialog(opt){
  uiStyles();
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'ui-overlay';

    const box = document.createElement('div');
    box.className = 'ui-box';

    const title = document.createElement('h3');
    title.className = 'ui-title';
    title.textContent = opt.title || '提示';
    box.appendChild(title);

    if(opt.message){
      const p = document.createElement('p');
      p.className = 'ui-msg';
      p.textContent = opt.message;
      box.appendChild(p);
    }

    let input = null;
    if(opt.input){
      input = document.createElement('input');
      input.className = 'ui-input';
      input.type = opt.inputType || 'text';
      input.value = opt.inputValue || '';
      input.placeholder = opt.inputPlaceholder || '';
      box.appendChild(input);
    }

    const actions = document.createElement('div');
    // 没有取消按钮 = 提示型弹窗（只有「知道了」这一个动作），
    // 用整行居中而不是挤在右下角 —— 用户反馈过「这个按钮位置看着很难受」。
    actions.className = 'ui-actions' + (opt.cancelText === '' ? ' ui-actions-single' : '');

    let settled = false;
    const close = (result) => {
      if(settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey);
      overlay.classList.add('ui-closing');
      setTimeout(() => overlay.remove(), 150);
      resolve(result);
    };
    const cancelResult = () => (opt.input ? null : false);

    if(opt.cancelText !== ''){
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'ui-btn ui-btn-ghost';
      cancel.textContent = opt.cancelText || '取消';
      cancel.onclick = () => close(cancelResult());
      actions.appendChild(cancel);
    }

    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'ui-btn ' + (opt.danger ? 'ui-btn-danger' : 'ui-btn-primary');
    ok.textContent = opt.okText || '确定';
    ok.onclick = () => close(opt.input ? input.value : true);
    actions.appendChild(ok);

    box.appendChild(actions);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    function onKey(e){
      if(e.key === 'Escape'){ e.preventDefault(); close(cancelResult()); }
      else if(e.key === 'Enter'){
        // 有输入框时只在输入框里回车才提交，避免误触
        if(opt.input && document.activeElement !== input) return;
        e.preventDefault();
        close(opt.input ? input.value : true);
      }
    }
    document.addEventListener('keydown', onKey);

    overlay.addEventListener('mousedown', (e) => {
      if(e.target === overlay) close(cancelResult());
    });

    setTimeout(() => { (input || ok).focus(); }, 40);
  });
}

function uiAlert(message, title){
  return uiDialog({ title: title || '提示', message: message, okText: '知道了', cancelText: '' });
}
function uiConfirm(message, title, opts){
  return uiDialog(Object.assign(
    { title: title || '请确认', message: message, okText: '确定', cancelText: '取消' },
    opts || {}
  ));
}
function uiPrompt(message, value, title, placeholder){
  return uiDialog({
    title: title || '请输入', message: message, input: true,
    inputValue: value || '', inputPlaceholder: placeholder || '',
    okText: '确定', cancelText: '取消',
  });
}

/** 右下角轻提示，不打断操作。 */
function uiToast(message, kind){
  uiStyles();
  const t = document.createElement('div');
  t.className = 'ui-toast' + (kind === 'ok' ? ' ui-toast-ok' : kind === 'err' ? ' ui-toast-err' : '');
  t.textContent = message;
  document.body.appendChild(t);
  setTimeout(() => {
    t.classList.add('ui-hide');
    setTimeout(() => t.remove(), 320);
  }, 2400);
}

/* ============================================================
   人机校验（Google reCAPTCHA v3）
   —— 站点密钥与域名都由后端 /api/config 下发，前端不写死任何密钥。
   —— 脚本加载失败（例如网络到不了 Google）时返回空串，
      由后端按策略处理，避免"校验挂了全校都投不了稿"。
   ============================================================ */

let recaptchaConfig = null;

async function getRecaptchaConfig(){
  if(recaptchaConfig) return recaptchaConfig;
  try {
    const r = await fetch('/api/config');
    const d = r.ok ? await r.json() : {};
    recaptchaConfig = (d && d.recaptcha) || { enabled: false };
  } catch(e) {
    recaptchaConfig = { enabled: false };
  }
  return recaptchaConfig;
}

/** 取一个 reCAPTCHA v3 token；拿不到就返回空串。 */
async function recaptchaToken(action){
  const cfg = await getRecaptchaConfig();
  if(!cfg.enabled || !cfg.siteKey) return '';

  const base = (cfg.base || 'https://www.recaptcha.net').replace(/\/+$/, '');

  try {
    if(!window.grecaptcha){
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = base + '/recaptcha/api.js?render=' + encodeURIComponent(cfg.siteKey);
        s.async = true;
        s.defer = true;
        s.onload = resolve;
        s.onerror = () => reject(new Error('recaptcha script blocked'));
        document.head.appendChild(s);
        // 被墙时 onerror 可能不触发，兜一个超时
        setTimeout(() => reject(new Error('recaptcha timeout')), 6000);
      });
    }
    // 注意：ready + execute 这一段**也必须兜超时**，理由和上面不同：
    // 实测发现，**站点密钥无效时 execute 既不 resolve 也不 reject**，就那么卡着。
    // 少了这道闸，点提交 / 登录会永远停在"正在校验…" —— 那比"拿不到令牌"糟糕得多
    // （拿不到令牌至少后端会按 RECAPTCHA_STRICT 决定放行还是拒绝，默认放行）。
    return await Promise.race([
      (async () => {
        await new Promise((resolve) => window.grecaptcha.ready(resolve));
        return await window.grecaptcha.execute(cfg.siteKey, { action: action || 'submit' });
      })(),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error('recaptcha token timeout')), 5000)),
    ]) || '';
  } catch(e) {
    // 拿不到 token：交给后端决定放行还是拒绝
    return '';
  }
}

/* ============================================================
   浏览器端工作量证明（PoW）—— 与 reCAPTCHA 并列的第二道，默认关闭。
   开关与难度由后端 /api/config 的 pow 下发（配置里没有就当没启用）。
   可用性优先：拿不到谜题、算不出来、超过 6 秒，一律返回 null，
   后端只在功能开启时才校验 —— 算不出来不能让学生投不了票。
   ============================================================ */

let powConfig = null;

async function getPowConfig(){
  if(powConfig) return powConfig;
  try {
    const r = await fetch('/api/config');
    const d = r.ok ? await r.json() : {};
    powConfig = (d && d.pow) || { enabled: false };
  } catch(e) {
    powConfig = { enabled: false };
  }
  return powConfig;
}

/** 摘要按十六进制位算，前 target 位是不是全 0。 */
function powDigestOk(buffer, target){
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for(let i = 0; i < bytes.length && hex.length < target.length; i++){
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex.slice(0, target.length) === target;
}

/**
 * 取谜题时要带的本机标识（存 localStorage，一次生成长期复用）。
 *
 * 为什么必须有它：/api/pow 不需要登录，服务端只能靠这个 `cid` 认出"这是同一台设备"。
 * 不带的话限流会退化成按 IP —— 而校园网全校共用一个出口 IP，
 * 等于**全校共享 120 次/小时的取谜题额度**，正常学生会被同学挡住。
 * 它只是限流分桶用的、能伪造，不是身份凭据（真正的去重还是设备指纹）。
 */
function powClientId(){
  try {
    let id = localStorage.getItem('yczx_pow_cid');
    if(!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id)){
      id = '';
      const bytes = new Uint8Array(12);
      crypto.getRandomValues(bytes);
      for(let i = 0; i < bytes.length; i++) id += bytes[i].toString(16).padStart(2, '0');
      localStorage.setItem('yczx_pow_cid', id);
    }
    return id;
  } catch(e) {
    return '';
  }
}

/** 解一道谜题：返回 { challenge, nonce }；任何一步失败都返回 null。 */
async function powProof(action){
  const cfg = await getPowConfig();
  if(!cfg.enabled) return null;
  // 老浏览器 / file:// 下 crypto.subtle 可能不存在 —— 直接当"算不出来"（放行）
  if(!window.crypto || !crypto.subtle || typeof crypto.subtle.digest !== 'function') return null;

  try {
    const cid = powClientId();
    const r = await fetch('/api/pow?action=' + encodeURIComponent(action || 'vote')
      + (cid ? '&cid=' + encodeURIComponent(cid) : ''));
    if(!r.ok) return null;
    const d = await r.json();
    if(!d || d.enabled !== true || !d.challenge) return null;

    const challenge = String(d.challenge);
    const difficulty = Math.max(0, Math.min(8, Number(d.difficulty) || 0));
    const target = '0'.repeat(difficulty);
    // 上限 10 秒：后端给谜题 300 秒有效期（见 _lib/pow.js），这里只是别让页面无限算下去。
    // 难度 3 在手机上通常 0.2 秒内出结果，这个上限是给极慢机型的兜底。
    const deadline = Date.now() + 10000;
    const enc = new TextEncoder();
    let nonce = 0;

    // 分片计算：每 2000 次让出一次主线程，弱机型也不会把页面卡死。
    // 刻意**不用 Web Worker / Blob**：本站 CSP 是 script-src 'self' 'unsafe-inline'，
    // 没有放行 worker-src blob:，用 Worker 会直接失败。
    while(Date.now() < deadline){
      for(let i = 0; i < 2000; i++){
        const digest = await crypto.subtle.digest('SHA-256', enc.encode(challenge + ':' + nonce));
        if(powDigestOk(digest, target)) return { challenge: challenge, nonce: String(nonce) };
        nonce++;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return null;
  } catch(e) {
    return null;
  }
}


// 设备指纹：用于"每人每周一次"的去重，替代旧版可被"换个 User-Agent"绕过的方案。
// 刻意不使用 localStorage / Cookie，这样清缓存不会把限制重置；
// 采集的是设备与浏览器本身的稳定特征（屏幕、时区、CPU 核数、Canvas / WebGL 差异）。
async function deviceFingerprint(){
  const nav = navigator, scr = window.screen || {};
  let canvasSig = 'no-canvas';
  try {
    const c = document.createElement('canvas');
    c.width = 220; c.height = 44;
    const ctx = c.getContext('2d');
    if(ctx){
      ctx.textBaseline = 'top'; ctx.font = '14px "Arial"';
      ctx.fillStyle = '#f60'; ctx.fillRect(0, 0, 110, 22);
      ctx.fillStyle = '#069'; ctx.fillText('盐中之声 yczx', 2, 3);
      ctx.strokeStyle = 'rgba(102,204,0,.7)';
      ctx.beginPath(); ctx.arc(58, 22, 15, 0, Math.PI * 2); ctx.stroke();
      canvasSig = c.toDataURL();
    }
  } catch(e) {}
  let glSig = 'no-webgl';
  try {
    const c2 = document.createElement('canvas');
    const gl = c2.getContext('webgl') || c2.getContext('experimental-webgl');
    if(gl){
      const info = gl.getExtension('WEBGL_debug_renderer_info');
      glSig = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    }
  } catch(e) {}
  let tz = '';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch(e) {}
  const raw = [nav.userAgent || '', nav.platform || '', nav.language || '', (nav.languages || []).join(','),
    nav.hardwareConcurrency || '', nav.maxTouchPoints || '',
    (scr.width || 0) + 'x' + (scr.height || 0) + 'x' + (scr.colorDepth || 0),
    window.devicePixelRatio || 0, tz, canvasSig, glSig].join('|');
  // 优先用 WebCrypto；http 等非安全上下文没有 crypto.subtle 时降级为确定性哈希。
  if(window.crypto && window.crypto.subtle){
    try {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
      return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    } catch(e) {}
  }
  let out = '';
  for(let seed = 0; seed < 4; seed++){
    let h = (0x811c9dc5 ^ (seed * 0x9e3779b1)) >>> 0;
    for(let i = 0; i < raw.length; i++){ h ^= raw.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    out += h.toString(16).padStart(8, '0');
  }
  return out;
}

/* ---------------- 游客模式（只读身份） ----------------
   身份来自 GET /api/me（服务端会话），**不做"试一次投稿看是否 403"的探测**：
   那会平白发一次注定失败的写请求，用户还得先填完表单才知道不行。
   注意：前端这套只是体验层，真正拦住游客的是 /api/vote 里的 denyGuest()，
   任何人都能绕过页面直接 POST。
*/
let isGuestMode = false;

/** 游客：禁掉提交并说明原因；搜索与试听**保持可用**（它们只是只读地听歌）。 */
function blockGuestSubmit(){
  isGuestMode = true;

  const btn = document.getElementById('submitVoteBtn');
  if(btn){
    btn.disabled = true;
    btn.setAttribute('aria-disabled', 'true');
    btn.title = '游客模式只能查看排行，不能投稿';
  }

  const msg = document.getElementById('msg');
  if(msg){
    msg.style.color = '#075985';
    msg.textContent = '当前为游客模式：只能查看排行，不能投稿（试听仍然可用）。请点下方「返回主页」查看排行。';
  }
}

/* ---------------- 暂停接收投稿（管理员用按钮开关） ----------------
   状态来自公开的 GET /api/config（submit.paused）。前端这套只是**让学生打开就知道**，
   真正拦住提交的是 /api/vote 的 POST 闸门 —— 绕过页面直接 POST 一样会被 403。
   与游客模式的处理刻意保持同一个形状（先说明原因、再置灰按钮），
   这样"为什么点不了"永远有一句人话在页面上。
*/
let submitPaused = false;

function applySubmitPaused(paused){
  submitPaused = paused === true;
  const notice = document.getElementById('pausedNotice');
  if(notice){
    notice.style.display = submitPaused ? 'block' : 'none';
    // 一句话说完（2026-10-07 用户要求）：横幅只需要**结论**，不需要解释。
    // 原来后半句在讲"还能做什么"，读起来像在安慰，反而把"现在投不了"这条
    // 关键信息稀释掉了；页面宽度也该留给表单本身。
    notice.textContent = submitPaused ? '广播站现在暂停接收投稿。' : '';
  }
  const btn = document.getElementById('submitVoteBtn');
  if(btn && submitPaused){
    btn.disabled = true;
    btn.setAttribute('aria-disabled', 'true');
    btn.title = '广播站现在暂停接收投稿';
  }
}

/** 普通学生 / 调试身份：解开提交按钮。 */
function enableSubmit(){
  isGuestMode = false;

  const btn = document.getElementById('submitVoteBtn');
  if(btn){
    // 注意：停收期间**不能**因为"不是游客"就把按钮解开 —— 两件事互不覆盖。
    btn.disabled = submitPaused;
    btn.removeAttribute('aria-disabled');
    btn.removeAttribute('title');
    if(submitPaused) applySubmitPaused(true);
  }
}

async function vote(){
  // 游客自检放在**最前面**（读表单之前）：游客根本不该走进后面的校验分支 ——
  // 否则他会看到"还只是搜索关键词"这类与身份无关的提示，反而更困惑。
  // 按钮已经是 disabled，但脚本 / 键盘 / 旧版缓存页面仍可能调到这个函数，
  // 所以这里再拦一次并给同样一句人话（服务端还会 403 兜底）。
  if(isGuestMode){
    const guestMsg = document.getElementById('msg');
    if(guestMsg){
      guestMsg.style.color = '#075985';
      guestMsg.textContent = '当前为游客模式：只能查看排行，不能投稿。请点下方「返回主页」查看排行。';
    }
    return;
  }

  // 暂停接收投稿：同样放在读表单之前。按钮已经是灰的，但脚本 / 键盘 /
  // 旧版缓存页面仍可能调到这个函数（服务端还会 403 兜底）。
  if(submitPaused){
    const pausedMsg = document.getElementById('msg');
    if(pausedMsg){
      pausedMsg.style.color = '#b45309';
      pausedMsg.textContent = '广播站现在暂停接收投稿，请稍后再来。';
    }
    return;
  }

  const title = document.getElementById('title').value.trim();
  const artist = document.getElementById('artist').value.trim();
  const category = document.getElementById('category').value;
  const trackId = document.getElementById('trackId').value.trim();
  // A7：选曲凭据与音源 id 是同时写入的一对，缺了任何一个都说明"没真的选过一首"。
  const trackToken = document.getElementById('trackToken').value.trim();
  const msg = document.getElementById('msg');

  // 必须从搜索结果里选一首，把音源 id 一起提交 ——
  // 这样这首歌上榜后，任何人点「试听」直接播当初选的那一版。
  if(!trackId){
    // 区分两种情况，别再说"请先输入歌名"（框里明明有字，用户会困惑）：
    //   框里有字 → 那是搜索关键词，还没选歌
    //   框里没字 → 真的什么都没输入
    msg.style.color = '#e11d48';
    msg.textContent = title
      ? '「' + title + '」还只是搜索关键词，请在搜索结果里点一下「选这首」'
      : '请在上面输入歌名或歌手，搜索后从结果里选一首';
    return;
  }

  if(!title || !artist){
    msg.style.color = '#e11d48';
    msg.textContent = '选中的歌曲信息不完整，请重新搜索并选一首';
    return;
  }

  // 凭据缺失也要在前端就拦下并说清楚，别让用户提交完才看到服务端报错。
  // （服务端同样强制要求凭据，这里只是提前一步给人话。）
  if(!trackToken){
    msg.style.color = '#e11d48';
    msg.textContent = '选曲凭据缺失（可能是页面停留太久或列表是旧版）。请重新点「搜索歌曲」并选一首再提交';
    return;
  }

  // 选完之后又手动改了框里的字：此时 trackId 还指向原来那首，
  // 直接提交会出现"显示的是一首、实际锁定的音源是另一首"。
  const picked = document.getElementById('picked').textContent || '';
  if(picked && !picked.includes(title)){
    msg.style.color = '#e11d48';
    msg.textContent = '你改动了歌名，请重新搜索并点「选这首」确认一次，避免锁定到错误的音源';
    return;
  }

  if(!await uiConfirm('确认提交这首歌吗？\n歌名：' + title + '\n歌手：' + artist)) return;

  msg.style.color = '#0284c7'; msg.textContent = '提交中...';
  // 算 PoW 可能要几百毫秒到几秒：按钮置灰 + 换文案，让人看得出在忙。
  const submitBtn = document.getElementById('submitVoteBtn');
  if(submitBtn){ submitBtn.disabled = true; submitBtn.textContent = '正在校验…'; }
  try {
    // 不再传 password / class_id：登录态由 HttpOnly 会话 Cookie 自动携带，
    // 班级身份由服务端决定，客户端无从伪造。
    const fingerprint = await deviceFingerprint();
    // 人机校验令牌（reCAPTCHA v3，无感）。没启用时是空串。
    const rcToken = await recaptchaToken('vote');
    // 工作量证明答案（默认关闭时是 null）。算不出来 / 没启用都传 null，
    // 由后端按开关决定：功能开着才会校验。
    const proof = await powProof('vote');
    const r = await fetch('/api/vote', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        title,
        artist,
        category_id: category,
        fingerprint,
        track_id: trackId,
        // A7：带上服务端签发的选曲凭据。带凭据时后端**以凭据里的内容为准**，
        // 上面那三个字段只是老版接口的兼容字段（也方便出问题时对照排查）。
        track_token: trackToken,
        recaptcha_token: rcToken,
        pow: proof,
      })
    });
    const d = await r.json();
    if(r.ok){
      // 调试模式会返回专门的提示文案
      const okText = d.message || '点歌成功！等待管理员审核';
      msg.style.color = '#059669';
      msg.textContent = okText;
      clearPicked();

      /*
       * 广播站反馈：原来只在行内写一行绿字，**太不明显**，容易以为没提交成功。
       * 改成明确的弹窗，确认后回主页 —— 一眼看到结果，也顺势结束这次操作。
       * 弹窗失败（例如被浏览器拦下）也必须回主页，不能卡在投稿页。
       */
      try {
        await uiAlert(okText + '\n\n管理员审核通过后会安排播出。', '投稿成功');
      } catch(e) { /* 弹窗出问题也要继续 */ }
      location.href = '/';
      return;
    } else if(r.status === 401){
      /*
       * 会话过期：**提示清楚，并等用户按下按钮再回登录页**。
       * 旧写法只在行内写一行红字、1.2 秒后自动跳 —— 用户既没有可点的东西，
       * 也来不及看清，感觉像"页面自己跑了"。现在改成明确的弹窗，
       * 按下「去登录」才跳；弹窗本身出问题也照样跳，不把人卡在投稿页。
       */
      msg.style.color = '#e11d48';
      msg.textContent = '登录已过期，请重新输入班级口令。';
      try {
        await uiAlert('登录已过期（学生会话有效期 1 天）。\n\n点「去登录」重新输入班级口令即可继续。', '需要重新登录');
      } catch(e) { /* 弹窗出问题也要继续 */ }
      location.href = '/';
      return;
    } else {
      msg.style.color = '#e11d48'; msg.textContent = d.error || '出错了';
    }
  } catch(e) { msg.style.color = '#e11d48'; msg.textContent = '网络错误'; }
  finally {
    // 恢复成"当前状态该有的样子"：停收期间不能因为一次提交失败就把按钮解开
    if(submitBtn){
      submitBtn.textContent = '提交点歌';
      submitBtn.disabled = submitPaused;
      if(submitPaused) submitBtn.setAttribute('aria-disabled', 'true');
      else submitBtn.removeAttribute('aria-disabled');
    }
  }
}

/** 清空已选中的那一首。 */
function clearPicked(){
  document.getElementById('title').value = '';
  document.getElementById('artist').value = '';
  document.getElementById('trackId').value = '';
  document.getElementById('trackToken').value = '';
  document.getElementById('picked').textContent = '';
}

/* ---------------- 退出登录 ---------------- */

// /api/logout 会把学生与管理员两种身份一起清掉，退出后要重新输入口令。
async function logoutUser(){
  if(!await uiConfirm('确认退出登录吗？\n\n退出后需要重新输入班级口令。\n管理员身份与学生身份的登录态会一起清除。')) return;

  try {
    await fetch('/api/logout', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' });
  } catch(e) {
    // 网络失败也照样回登录页；服务端会话到期后会自然失效
  }
  location.href = '/';
}

/* ---------------- 试听 ---------------- */

// 「先试听一下」：直接用歌名框里的关键词搜一遍，本质上和「搜索歌曲」同一个来源。
// 区别只是结果面板不同（这里的面板不含「选这首」也行——其实也带了）。
// 后端已做三级降级：歌名+歌手 → 只按歌名 → 模糊搜索，输入不全时也能找到。
async function auditionInput(){
  const box = document.getElementById('auditionBox');
  const keyword = document.getElementById('title').value.trim();
  const artist = document.getElementById('artist').value.trim();

  // 再点一次收起
  if(box.dataset.open === '1'){
    box.dataset.open = '0';
    box.innerHTML = '';
    return;
  }
  if(!keyword){
    box.dataset.open = '1';
    box.innerHTML = '<p class="sub" style="color:#b45309;">请在上面那个框里输入歌名或歌手（输一部分就行），再试听。</p>';
    document.getElementById('title').focus();
    return;
  }

  // 与搜索按钮同一套序号：试听也会作废上一次还没回来的搜索
  const seq = abortMusicSearch();
  box.dataset.open = '1';
  box.innerHTML = '<p class="sub">正在搜索音源…</p>';

  try {
    let url = '/api/music?q=' + encodeURIComponent(keyword);
    // 只有真的选定了某首歌时才带上歌手（此时 artist 是选中结果填的），
    // 否则它只是上次选中的残留，会把搜索范围限死。
    const hasPicked = document.getElementById('trackId').value.trim() !== '';
    if(hasPicked && artist) url += '&artist=' + encodeURIComponent(artist);
    const r = await fetch(url, { signal: musicSearchSignal() });
    const d = await r.json();
    // 已经不是最新一次 —— 丢弃这次响应（旧结果不许覆盖新结果）
    if(!__musicSearchCurrent(seq)) return;
    if(!r.ok){
      box.innerHTML = '<p class="sub" style="color:#e11d48;">' + escapeHtml(d.error || '搜索失败') + '</p>';
      return;
    }
    const list = Array.isArray(d.results) ? d.results : [];
    if(!list.length){
      box.innerHTML = '<p class="sub">没找到可试听的版本，换个写法再试试</p>';
      return;
    }
    box.innerHTML = candidatePanelHtml(
      '试听候选',
      '点「选这首」会把这首歌的歌名歌手填进上面的表单，不会自动提交',
      list, 'auditionBox', true
    );
  } catch(e) {
    if(isAbortError(e) || !__musicSearchCurrent(seq)) return;
    box.innerHTML = '<p class="sub" style="color:#e11d48;">网络错误</p>';
  }
}

/* ---------------- 模糊搜索 ---------------- */

/**
 * 搜索歌曲。
 *
 * 歌名框本身就是搜索框：在里面输入关键词（歌名或歌手的一部分都行），
 * 回车或点「搜索歌曲」就会搜。后端做了三级降级
 * （歌名+歌手 → 只按歌名 → 模糊搜索），所以输「七里」也能找到「七里香」。
 *
 * 注意：歌手框是只读的（那是"已选中"的展示位），所以搜索只用歌名框的内容。
 */
async function searchSongs(){
  const box = document.getElementById('searchBox');
  const keyword = document.getElementById('title').value.trim();

  if(!keyword){
    box.innerHTML = '<p class="sub" style="color:#b45309;">请在上面那个框里输入歌名或歌手（输一部分就行），再搜索。</p>';
    document.getElementById('title').focus();
    return;
  }

  // 作废上一次搜索（中止它在飞的请求），并登记这一次的序号
  const seq = abortMusicSearch();
  box.innerHTML = '<p class="sub">正在搜索…</p>';

  try {
    const r = await fetch('/api/music?q=' + encodeURIComponent(keyword), { signal: musicSearchSignal() });
    const d = await r.json();
    // 已经不是最新一次搜索 —— 这次响应作废，绝不写 DOM
    if(!__musicSearchCurrent(seq)) return;
    if(!r.ok){
      box.innerHTML = '<p class="sub" style="color:#e11d48;">' + escapeHtml(d.error || '搜索失败') + '</p>';
      return;
    }
    const list = Array.isArray(d.results) ? d.results : [];
    if(!list.length){
      box.innerHTML = '<p class="sub">没搜到。试试只输歌名，或者换个写法。</p>';
      return;
    }
    box.innerHTML = candidatePanelHtml(
      '搜索候选',
      '点「选这首」会填进上面的表单，不会自动提交',
      list, 'searchBox', true
    );
  } catch(e) {
    // 是我们自己中止的：不报错（用户已经发起了新的一次搜索）
    if(isAbortError(e) || !__musicSearchCurrent(seq)) return;
    box.innerHTML = '<p class="sub" style="color:#e11d48;">网络错误</p>';
  }
}

/* ---------------- 音乐搜索：取消旧请求 + 只认最新 ---------------- */

/**
 * 搜索的音源查询会有"先发后到"的问题：用户改词再搜时，
 * 第一次的响应可能比第二次晚回来，把新结果覆盖成旧结果。
 *
 * 两道防线一起用：
 *   · _musicSearchAbort —— 发起新搜索前中止上一次还在飞的请求（省一次网络往返）；
 *   · _musicSearchSeq  —— 响应回来时核对"我还是不是最新那次"，不是就整段丢弃。
 *     只靠中止不够：请求可能已经到达服务端、abort 不保证不 resolve。
 *
 * 为什么两个入口（搜索按钮 / 试听按钮）共用一套序号：
 *   它们显示在页面上的两个不同面板里，但都是"依据当前输入的一次查询"。
 *   共用之后，点试听会顺带作废上一次搜索的过期响应，反之亦然 ——
 *   否则会出现"试听面板显示的是刚才搜索的结果"这种更混乱的状态。
 */
let _musicSearchSeq = 0;
let _musicSearchAbort = null;

/** 正在进行的搜索是不是"当前这一次"。 */
function __musicSearchCurrent(seq){
  return seq === _musicSearchSeq;
}

/** 作废上一次搜索：中止它在飞的请求。 */
function abortMusicSearch(){
  if(_musicSearchAbort){
    try { _musicSearchAbort.abort(); } catch(e) { /* 已经结束了 */ }
    _musicSearchAbort = null;
  }
  _musicSearchSeq += 1;
  return _musicSearchSeq;
}

/** 给这次搜索造一个可中止的 signal；不支持 AbortController 时返回 undefined（照常发请求）。 */
function musicSearchSignal(){
  if(typeof AbortController !== 'function') return undefined;
  _musicSearchAbort = new AbortController();
  return _musicSearchAbort.signal;
}

/** 主动中止会抛 AbortError —— 那不是"网络错误"，不该弹给用户看。 */
function isAbortError(err){
  return Boolean(err) && (err.name === 'AbortError' || err.code === 20);
}

/** 秒 -> m:ss */
function formatDuration(seconds){
  const total = Number(seconds);
  if(!Number.isFinite(total) || total <= 0) return '';
  const m = Math.floor(total / 60);
  const s = Math.round(total % 60);
  return m + ':' + String(s).padStart(2, '0');
}

/**
 * 把选中的歌填进表单。
 *
 * 除了歌名歌手，还会把**音源 id 记进隐藏字段 trackId** —— 提交时一起带上，
 * 这首歌上榜后任何人点「试听」就直接播当初锁定的这一版，不会播成别的版本。
 * 用 data-* 传参，避免歌名里的特殊字符破坏 onclick。
 */
function pickSong(button){
  const name = button.dataset.name || '';
  const artist = button.dataset.artist || '';
  const track = button.dataset.track || '';
  // A7：候选自带的选曲凭据。它由搜索接口签发，里面已经绑定了
  // "这首歌名 + 这个歌手 + 这个音源 id"，提交时一并带上，
  // 服务端就以凭据内容为准 —— 客户端再没有机会把三者拆开重组。
  // 后端签名失败时它是空串（老流程），此时提交会被拦下并提示重新搜索。
  const token = button.dataset.token || '';

  // 歌名框同时也是搜索框，选中后就把完整歌名写回去 ——
  // 这样用户看到的"框里的字"始终等于"将要提交的歌"。
  document.getElementById('title').value = name;
  document.getElementById('artist').value = artist;
  document.getElementById('trackId').value = track;
  document.getElementById('trackToken').value = token;
  document.getElementById('picked').textContent =
    track ? ('已选中：' + name + ' - ' + artist + '（提交后就锁定这一版音源）') : '';

  // 另一个面板如果开着，一起收掉，避免两个列表同时占着屏幕
  for(const id of ['searchBox', 'auditionBox']){
    if(id === button.dataset.clear) continue;
    const other = document.getElementById(id);
    if(other && other.dataset.open === '1'){ closeCandidatePanel(id); }
  }

  const box = document.getElementById(button.dataset.clear || 'searchBox');
  if(!box) return;
  delete box.dataset.open;
  box.innerHTML = '<p class="sub" style="color:#059669;">已选中「' + escapeHtml(name) + '」</p>'
    + '<p class="sub" style="color:var(--ink-3);">想换一首的话，直接改上面框里的关键词重新搜即可。</p>';
}

/**
 * 音源 P0-1：`<audio>` 的失败兜底。
 *
 * `/api/music?play=` 失败时返回的是 JSON（404 全部音源都取不到 / 502 地址不可信 /
 * 502 不是音频 / 504 超时），`<audio>` 只会静默失败 —— 表现就是"点了没反应"。
 * 这里监听 error / stalled，就地给一条说明 + 一个重试按钮。
 *
 * 2026-10-07 修掉"兜底提示**叠成五张卡**"的 bug（用户截图里一眼可见）。
 *    根因有两层，两层都得治：
 *      1. `hint` 是 **appendChild** 到播放器槽里的，而清空只清 `.audio-fallback`
 *         那一个类 —— 只要有一次没被清掉（或类名变了），就会往上垒；
 *      2. 更关键：点「重试这一版」会 `replaceWith(next)` 换掉 audio，**但旧的 audio
 *         还在加载中**！旧节点被替换后它的 error/stalled 仍会触发，而它的
 *         `parentElement` 已经是 null（或指向同一个 box），于是又 append 一张。
 *         点几次就垒几张 —— 正是截图里那五张。
 *    治法是**结构性的**：改成"槽里只允许有一个播放器 + 最多一条提示"，
 *    每次渲染先把槽整个重建（`slot.innerHTML = ''`），并且**先取消旧播放器的加载**
 *    （`audio.removeAttribute('src'); audio.load();`）再替换 —— 断开在途请求，
 *    旧节点就再也不会冒事件出来。
 */
function audioFallbackHint(audio){
  if(!audio || audio.dataset.fallbackShown === '1') return;
  audio.dataset.fallbackShown = '1';

  const slot = audio.parentElement;
  if(!slot) return;

  // 结构性保证：一个槽里只留一个播放器 + 一条提示。
  // 不用 querySelector 找旧的删 —— 那依赖类名，改名或漏一次就垒起来。
  Array.from(slot.querySelectorAll('.audio-fallback')).forEach((el) => el.remove());
  Array.from(slot.querySelectorAll('audio')).forEach((el) => { if(el !== audio) el.remove(); });

  const hint = document.createElement('div');
  hint.className = 'audio-fallback cand-hint';
  hint.style.cssText = 'margin-top:8px;';

  const text = document.createElement('span');
  text.textContent = '这一版暂时播不出来（可能是版权限制或音源抖动），换一个版本试试';
  hint.appendChild(text);

  const retry = document.createElement('button');
  retry.type = 'button';
  retry.textContent = '重试这一版';
  retry.className = 'audio-fallback-retry';
  retry.style.cssText = 'width:auto;padding:7px 14px;font-size:12px;margin:8px 0 0;';
  retry.addEventListener('click', () => {
    const track = audio.dataset.trackId || '';
    if(!track) return;
    replacePlayerWith(audio, '/api/music?play=' + encodeURIComponent(track) + '&retry=' + Date.now());
  });
  hint.appendChild(retry);

  slot.appendChild(hint);
}

/**
 * 换掉一个播放器，**并断开旧的那个**。
 *
 * `audio.removeAttribute('src'); audio.load();` 这两步是必须的：
 * 只做 `replaceWith` 的话，旧节点上已经发出的音频请求还在跑，
 * 它随后触发的 error/stalled 会再冒一次事件 —— 每点一次重试就多一张提示卡
 * （这正是用户截图里"五张重试卡"的成因）。先把 src 摘掉并 load() 一次，
 * 浏览器会中止那次加载，旧节点从此安静。
 */
function replacePlayerWith(audio, src){
  const next = document.createElement('audio');
  next.controls = true;
  next.preload = 'metadata';
  next.style.width = '100%';
  next.dataset.trackId = audio.dataset.trackId || '';
  next.src = src;
  audio.replaceWith(next);
  try {
    audio.removeAttribute('src');
    audio.load();
  } catch(e) { /* 旧节点已经脱离文档，忽略 */ }
  bindAudioFallback(next);
  next.play().catch(() => { /* 可能被自动播放策略拦截，忽略 */ });
  return next;
}

function bindAudioFallback(audio){
  if(!audio) return audio;
  if(audio.dataset.fallbackBound === '1') return audio;
  audio.dataset.fallbackBound = '1';
  audio.addEventListener('error', () => audioFallbackHint(audio));
  audio.addEventListener('stalled', () => {
    if(audio.networkState === 3) audioFallbackHint(audio);
  });
  return audio;
}

/**
 * 候选面板：**顶部一个固定播放器 + 下面一份音乐列表**。
 *
 * 早期版本把 <audio> 追加到列表末尾，点最后一首时播放条会跑到很下面。
 * 现在播放器固定在面板顶部，点任意一行都只替换它的内容并高亮该行。
 */
function candidatePanelHtml(title, hint, list, boxId, withPick){
  const rows = list.map((s, index) => `
    <div class="cand-row" data-track-row="${escapeHtml(s.id)}" style="flex-wrap:wrap;">
      <span class="cand-no">${index + 1}</span>
      <div>
        <div class="cand-name">${escapeHtml(s.name)}</div>
        <div class="cand-sub">${escapeHtml(s.artist)}${s.album ? ' · ' + escapeHtml(s.album) : ''}</div>
      </div>
      <span class="cand-dur">${escapeHtml(formatDuration(s.duration))}</span>
      <div class="cand-acts">
        ${withPick
          ? `<button data-name="${escapeHtml(s.name)}" data-artist="${escapeHtml(s.artist)}" data-track="${escapeHtml(s.id)}" data-token="${escapeHtml(s.track_token || s.token || '')}" data-clear="${boxId}" onclick="pickSong(this)">选这首</button>`
          : ''}
        ${s.playable === false
          ? '<button class="cand-noop" type="button" disabled title="这一版暂时取不到音频，但照样可以选它投稿">无试听</button>'
          : `<button data-track="${escapeHtml(s.id)}" data-target="${boxId}" onclick="playFromButton(this)">播放</button>`}
      </div>
    </div>
  `).join('');

  return `
    <div class="cand-panel">
      <div class="cand-head">
        <div class="cand-title">${escapeHtml(title)} · ${list.length} 个</div>
        <button class="cand-quiet" onclick="closeCandidatePanel('${boxId}')">收起 ▲</button>
      </div>
      <div class="cand-hint">${escapeHtml(hint)}</div>

      <div class="cand-player" id="player-${boxId}">
        <div class="cand-hint" style="padding:0;">点下面任意一行的「播放」开始试听；标着「无试听」的也照样可以选</div>
      </div>

      <div class="cand-rows">${rows}</div>
    </div>
  `;
}

function closeCandidatePanel(boxId){
  const box = document.getElementById(boxId);
  if(!box) return;
  box.dataset.open = '0';
  box.innerHTML = '';
}

function playFromButton(button){
  playTrack(button.dataset.track, button.dataset.target || 'auditionBox');
}

/** 播放器固定在面板顶部，只替换它的内容，不再往列表末尾追加。 */
function playTrack(trackId, boxId){
  const box = document.getElementById(boxId);
  const slot = document.getElementById('player-' + boxId);
  if(!box || !slot || !trackId) return;

  box.querySelectorAll('[data-track-row]').forEach((row) => {
    row.style.background = row.dataset.trackRow === trackId ? 'rgba(14,165,233,0.14)' : 'transparent';
  });

  // 换曲之前先把**上一个播放器断开**：只做 slot.innerHTML='' 的话，
  // 旧节点上在途的音频请求还在跑，它随后触发的 error/stalled 会再冒一次事件，
  // 于是"点了几个不同的版本"就攒出几张失败提示卡（用户截图里是五张）。
  // 摘掉 src 再 load() 一次，浏览器会中止加载，旧节点从此安静。
  Array.from(slot.querySelectorAll('audio')).forEach((old) => {
    try { old.removeAttribute('src'); old.load(); } catch(e) { /* 已脱离文档，忽略 */ }
  });

  slot.innerHTML = '<div class="cand-hint" style="margin-bottom:6px;">正在试听</div>';

  const audio = document.createElement('audio');
  audio.controls = true;
  audio.preload = 'metadata';
  audio.dataset.trackId = trackId;
  audio.src = '/api/music?play=' + encodeURIComponent(trackId);
  audio.style.width = '100%';
  slot.appendChild(audio);
  bindAudioFallback(audio);
  audio.play().catch(() => { /* 浏览器可能拦截自动播放，忽略 */ });
}

// 进页面先确认会话仍有效（替代旧版读取 sessionStorage 里保存的口令），
// 并顺便问清"是不是游客" —— 游客在**进来时就**知道不能投稿，
// 而不是填完表单才被服务端拒掉。
(async function(){
  let guest = false;
  try {
    const r = await fetch('/api/me');
    if(r.status === 401){ uiAlert('请先回主页输入口令登录！'); location.href = '/'; return; }
    if(r.ok){
      const me = await r.json();
      guest = !!me.isGuest;
    }
  } catch(e) {
    // 身份没取到（网络抖动）：不挡人，交给服务端的硬闸门。
    // 反过来（取不到就按游客处理）会让正常学生在弱网下连投稿都点不了，
    // 而"漏认游客"最坏也只是按钮没灰 —— 服务端照样 403。
  }

  if(guest) blockGuestSubmit();
  else enableSubmit();

  // 顺便问一次"现在收不收投稿"。与身份是两个独立的轴，所以单独问、不要混进上面那段。
  // 取不到就不显示提示（弱网下不该让学生看到一个假的"停收"横幅），
  // 服务端的闸门照旧兜底。
  try {
    const cr = await fetch('/api/config');
    if(cr.ok){
      const cfg = await cr.json();
      if(cfg && cfg.submit) applySubmitPaused(cfg.submit.paused === true);
    }
  } catch(e) { /* 取不到就按"正常接收"处理 */ }
})();
