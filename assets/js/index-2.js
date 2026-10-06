
// 所有来自后端的数据必须经这里转义后才能拼进 innerHTML，
// 否则歌名里的 <img src=x onerror=...> 会被浏览器当代码执行。
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

    '.ui-title{margin:0 0 8px;font-size:17px;font-weight:700;color:var(--ink);letter-spacing:.3px}',
    '.ui-msg{margin:0 0 16px;font-size:14px;line-height:1.65;color:var(--ink-2);white-space:pre-wrap;word-break:break-word}',
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
    '.ui-btn-ghost{color:var(--ink-2);background:linear-gradient(180deg,#fff,#eef2f7);border:1px solid #dbe3ec;',
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
  }, 2600);
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

// 数字字段一律强制转整数，避免 "1);uiAlert(1)//" 这类从 id / 票数打进来的注入。
function safeInt(value) { const n = Number(value); return Number.isFinite(n) ? Math.trunc(n) : 0; }

/* ---------------- 请求去重 ----------------
   借鉴自 VoiceHub 的 useRequestDedup：按 URL 缓存**进行中**的 Promise，
   同一个 URL 在短时间内只发一次；失败立刻清除，绝不把错误也缓存住。

   为什么需要它（实测过的问题）：主页启动时 boot() 先探一次榜单、
   loadPending() 紧接着又拉一次同样的数据，等于每次进主页白跑一个请求。
   校园网共用出口、免费套餐有额度，这种白跑是纯浪费。

   与"缓存"的区别：这里缓存的是 Promise，所以两个并发调用方共享**同一次**请求，
   而不是"第二个拿到旧数据"。1.5 秒窗口只用于把紧随其后的重复调用合并掉。 */
const _inflight = new Map();
const DEDUP_WINDOW_MS = 1500;

function getJson(url){
  const now = Date.now();
  const hit = _inflight.get(url);
  if(hit && now - hit.at < DEDUP_WINDOW_MS) return hit.promise;

  const promise = fetch(url).then((res) => {
    // 请求结束后留一个很短的窗口，让紧随其后的重复调用复用这次结果；
    // 窗口过期由上面的时间判断处理，这里不做定时器（少一个定时器少一处泄漏）。
    return res;
  }, (err) => {
    // 失败必须立刻清除：否则弱网下 1.5 秒内重试会一直拿到同一个失败的 Promise。
    _inflight.delete(url);
    throw err;
  });

  _inflight.set(url, { promise, at: now });
  return promise;
}

let currentMobileTab = 'pending';

/**
 * 回到口令页。
 *
 * @param {string} [reason] 为什么回到这里。会话过期时会传一句说明 ——
 *   旧实现是**静默切回**，用户只看到自己"突然被踢回登录页"，
 *   会以为是网络抽风或自己点错了，于是反复重试。
 */
function showGate(reason){
  document.getElementById('gate').style.display = 'block';
  document.getElementById('app').style.display = 'none';
  const msg = document.getElementById('gateMsg');
  if(msg){
    if(reason){ msg.style.color = '#b45309'; msg.textContent = reason; }
    else { msg.style.color = ''; msg.textContent = ''; }
  }
}
function showApp(){
  document.getElementById('gate').style.display = 'none';
  document.getElementById('app').style.display = 'block';

  // 规定放在显眼位置，免责声明放页脚；两者都从常量渲染，避免和后台的副本走样。
  renderRules();
  renderDisclaimer();
}

/* ---------------- 游客模式（只读身份） ----------------
   身份只有两个来源，都来自服务端，**不做"试一次写操作看是否 403"的探测**：
     · 登录成功时的响应体（guest / role 字段）—— 当场就知道，零额外请求；
     · 已有会话刷新页面时的 GET /api/me —— 一次只读请求。
   探测式判断为什么不行：那会平白发一次注定失败的写请求，
   而且用户会先看到"操作失败"再看到按钮变灰，两件事自相矛盾。
   注意：前端这套只是体验层，真正拦住游客的是各写接口里的 denyGuest()。
*/
let isGuestMode = false;

/**
 * 会话恢复时问一次当前身份；取不到就按"不是游客"处理（见下方说明）。
 *
 * 这里刻意**不**走 getJson 去重：它每次页面加载只跑一次，没有重复可合并；
 * 而且"身份只来自 /api/me 与登录响应"这条约束被测试钉在 fetch('/api/me')
 * 这个字面量上（防止有人改成"试一次写操作看是否 403"）。
 */
async function loadIdentity(){
  try {
    const r = await fetch('/api/me');
    if(!r.ok) return false;
    const me = await r.json();
    return !!me.isGuest;
  } catch(e) {
    // 网络抖动时**不**把正常学生当成游客 —— 反了会让他在弱网下连投稿都点不了；
    // 而"漏认游客"的后果只是按钮没灰，服务端照样会 403，代价小得多。
    return false;
  }
}

/** 置灰一个按钮，并把"为什么不能点"写进 title（读屏与悬停都能得到原因）。 */
function setDisabledWithReason(button, disabled, reason){
  if(!button) return;
  button.disabled = !!disabled;
  button.setAttribute('aria-disabled', disabled ? 'true' : 'false');
  if(disabled) button.title = reason;
  else button.removeAttribute('title');
}

/**
 * 把当前身份套用到界面上。
 * @param {boolean} isGuest
 */
function applyGuestMode(isGuest){
  isGuestMode = !!isGuest;

  const notice = document.getElementById('guestNotice');
  if(notice) notice.hidden = !isGuestMode;

  // 「去投稿」是 <a>：disabled 属性对链接无效，所以三层一起上 ——
  // 去掉 href（不能点、也进不了 Tab 顺序）+ disabled/aria-disabled（辅助技术读得到）
  // + CSS 的 pointer-events:none（鼠标与触控都点不到）。
  const goVote = document.getElementById('goVoteBtn');
  if(goVote){
    if(isGuestMode){
      goVote.removeAttribute('href');
      goVote.setAttribute('disabled', '');
      goVote.setAttribute('aria-disabled', 'true');
      goVote.setAttribute('title', '游客模式只能查看排行，不能投稿');
    } else {
      goVote.setAttribute('href', '/vote.html');
      goVote.removeAttribute('disabled');
      goVote.removeAttribute('aria-disabled');
      goVote.removeAttribute('title');
    }
  }

  // 已经渲染出来的投票 / 举报按钮跟着变。
  // 注意选择器刻意避开带 data-audition 的「试听」按钮 —— 试听是只读的，
  // 榜单里本来就有它，游客禁掉会让"看排行"变得很别扭。
  document.querySelectorAll('.btn-upvote[data-report]').forEach((btn) =>
    setDisabledWithReason(btn, isGuestMode, '游客模式只能查看排行，不能举报'));
  document.querySelectorAll('.btn-upvote.act-primary').forEach((btn) =>
    setDisabledWithReason(btn, isGuestMode, '游客模式只能查看排行，不能投票'));
}

/**
 * 渲染时就带上禁用属性。
 * 为什么不在渲染完再逐个改：按钮是异步渲染的，先可点、后置灰之间
 * 存在一个能被点到的窗口；直接渲染成禁用态就没有这个空档。
 */
function guestDisabledAttrs(reason){
  return isGuestMode ? ` disabled aria-disabled="true" title="${reason}"` : '';
}

/**
 * 设备指纹 —— 投票去重用。
 * 按"设备"而不是"班级口令"去重：同一个口令是全年级共用的，
 * 若按口令去重会退化成"每个口令对每首歌只能投一票"。
 * 刻意不使用 localStorage / Cookie，清缓存不会把限制重置。
 */
let cachedFingerprint = null;
async function deviceFingerprint(){
  if(cachedFingerprint) return cachedFingerprint;

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

  if(window.crypto && window.crypto.subtle){
    try {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
      cachedFingerprint = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
      return cachedFingerprint;
    } catch(e) {}
  }

  let out = '';
  for(let seed = 0; seed < 4; seed++){
    let h = (0x811c9dc5 ^ (seed * 0x9e3779b1)) >>> 0;
    for(let i = 0; i < raw.length; i++){ h ^= raw.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    out += h.toString(16).padStart(8, '0');
  }
  cachedFingerprint = out;
  return cachedFingerprint;
}

async function checkPw(){
  const pw = document.getElementById('pw').value.trim();
  const msg = document.getElementById('gateMsg');
  if(!pw){ msg.textContent = '请输入口令'; return; }
  msg.textContent = '验证中...';
  try {
    // 口令只在这一个请求里出现；服务端签发 HttpOnly 会话 Cookie，
    // 后续所有请求都不再携带口令。旧版把口令塞进 sessionStorage
    // 并反复拼进 URL，一旦有 XSS 就会被直接读走。
    // 人机校验令牌（reCAPTCHA v3）：拿不到就是空串，后端默认放行。
    // 登录是所有功能的入口，不能因为 Google 不可达就把全校挡在外面。
    const rcToken = await recaptchaToken('login');
    const r = await fetch('/api/login', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({password: pw, recaptcha_token: rcToken})});
    const d = await r.json();
    if(r.ok){
      document.getElementById('pw').value = '';
      msg.textContent = '';
      // 游客身份来自登录响应，不必再多打一次 /api/me。
      // 必须在 showApp / loadPending **之前**套用：loadPending 渲染时
      // 就要按身份决定投票与举报按钮是否禁用（见 guestDisabledAttrs）。
      applyGuestMode(!!d.guest);
      showApp();
      // 公告与榜单并行拉；公告的返回值里带着弹窗公告（popups），
      // 要先拿到它才能排"须知 -> 弹窗"这个先后顺序。
      const announcementsTask = loadAnnouncements();
      loadPending();
      loadApproved();
      // 首次进入弹一次规定须知 —— 但游客不弹：那段话讲的是投稿规则与每周额度，
      // 对一个连投稿按钮都点不了的人只会造成误解（他没法"投稿前先看一遍"）。
      // 须知关掉**之后**再弹公告（用户要求弹窗公告"作为初始弹窗后面一个弹窗"），
      // 所以这里是**串行**的：等公告数据 + 等须知弹窗都结束，再依次弹公告。
      if(!d.guest){
        const firstVisit = maybeShowFirstVisitNotice();
        Promise.all([announcementsTask, firstVisit]).then(([popups]) => showPopupAnnouncements(popups));
      }
      // 主页公告已加载，登录页公告不用再占位
      const gateBox = document.getElementById('gateAnnounceBox');
      if(gateBox) gateBox.innerHTML = '';
      // 用管理员身份登录时进入调试模式：点歌不限次数、不查重
      if(d.debug){
        uiAlert('已进入调试模式：\n\n· 点歌不限次数（不占用每周额度）\n· 同一首歌可以反复提交\n· 提交的歌会在后台标注「调试模式」\n· 与已有正式歌曲重复的调试歌曲不会显示在审核列表里');
      }
    } else { msg.textContent = d.error || '口令错误'; }
  } catch(e) { msg.textContent = '网络错误'; }
}

function switchMobileTab(tab){
  currentMobileTab = tab;
  const setClass = (id, cls) => { const el = document.getElementById(id); if(el) el.className = cls; };
  setClass('tabPending', tab === 'pending' ? 'active' : '');
  setClass('tabApproved', tab === 'approved' ? 'active' : '');
  setClass('pendingCol', tab === 'pending' ? 'col active' : 'col');
  setClass('approvedCol', tab === 'approved' ? 'col active' : 'col');
}

/**
 * 待审核榜：数据缓存 + 单卡渲染。
 *
 * 拆成两层之后，"投一票"只需要替换那一张卡片，不必重建整个列表 ——
 * 这才有可能做到"投票不打断正在播放的试听"（旧实现整块重绘会把 <audio> 一起拆掉）。
 * @type {Array<object>}
 */
let pendingSongs = [];

/** 生成一张待审核卡片。id 用于就地替换，所以卡片外层必须带 data-song。 */
function renderPendingCard(s){
  const id = safeInt(s.id);
  // 两层结构（见样式块「视觉重构 · 第一档」）：
  //   上层：歌名 / 歌手·分类（可换行收缩）+ 票数（固定，锁一行）
  //   下层：试听（次要）· 举报（安静）· 投票（主要）
  // 举报刻意做得最不显眼 —— 它不该和「投票」抢注意力。
  return `
      <div class="rank-card" data-song="${id}">
        <div class="rank-top">
          <div class="song-main">
            <h3>${escapeHtml(s.title)}</h3>
            <p>${escapeHtml(s.artist)} · <span style="color:var(--brand);">${escapeHtml(s.category_name)}</span></p>
          </div>
          <span class="song-votes" title="当前票数"><b class="rank-votes">${safeInt(s.votes)}</b><span style="font-size:12px;color:var(--ink-4);">票</span></span>
        </div>
        <div class="song-acts">
          <button class="btn-upvote act-secondary" data-audition="${id}" data-title="${escapeHtml(s.title)}" data-artist="${escapeHtml(s.artist)}" data-track="${escapeHtml(s.track_id || '')}" onclick="auditionFromButton(this)">试听</button>
          <button class="btn-upvote act-quiet" data-report="${id}" onclick="reportFromButton(this)"${guestDisabledAttrs('游客模式只能查看排行，不能举报')}>举报</button>
          <button class="btn-upvote act-primary" onclick="upvote(${id}, this)"${guestDisabledAttrs('游客模式只能查看排行，不能投票')}>投票</button>
        </div>
      </div>
      <div id="audition-${id}"></div>`;
}

/** 整榜渲染（含外层白色列表容器）。只在首次加载 / 显式刷新时走这里。 */
function renderPendingList(){
  const box = document.getElementById('pendingList');
  if(!box) return;
  if(!pendingSongs.length){
    box.innerHTML = '<p style="text-align:center;color:var(--ink-4);padding:20px 0;">暂无待审核歌曲</p>';
    return;
  }
  // 外层套一个白色列表容器：整个列表只有一个圆角与一条边框，行与行之间用
  // 轻分隔线区分（第三档）—— 比"每首歌一个浮起的大盒子"更紧凑、更像音乐列表。
  box.innerHTML = '<div class="list-panel">' + pendingSongs.map(renderPendingCard).join('') + '</div>';
}

/**
 * 就地更新一首歌的卡片 —— 只替换那一张，不碰别的行。
 * 这正是"投票不打断试听"的关键：其他行的 <audio> 元素压根没被动过。
 */
function patchPendingCard(songId){
  const s = pendingSongs.find((x) => safeInt(x.id) === safeInt(songId));
  if(!s) return;
  const host = document.querySelector('#pendingList [data-song="' + safeInt(songId) + '"]');
  if(!host) return;

  const wasOpen = document.getElementById('audition-' + safeInt(songId));
  const openHtml = wasOpen ? wasOpen.innerHTML : '';

  host.insertAdjacentHTML('beforebegin', renderPendingCard(s));
  const fresh = document.querySelector('#pendingList [data-song="' + safeInt(songId) + '"]');
  host.remove();

  // 把原来打开着的试听面板搬回来（内容本来就是这一首的，没必要重新加载音源）
  if(fresh && openHtml){
    const panel = fresh.nextElementSibling;
    if(panel && panel.id === 'audition-' + safeInt(songId)){
      panel.innerHTML = openHtml;
      panel.dataset.open = '1';
    }
  }
}

async function loadPending(){
  const box = document.getElementById('pendingList');
  if(!box) return;
  try {
    // 不再传 class_id 与 password：班级身份由服务端会话决定，客户端伪造不了。
    const res = await getJson('/api/rank?status=pending');
    if(res.status === 401){ showGate('登录已过期（学生会话有效期 1 天），请重新输入班级口令。'); return; }
    const list = await res.json();
    if(!Array.isArray(list) || !list.length){ pendingSongs = []; renderPendingList(); return; }
    pendingSongs = list;
    renderPendingList();
  } catch(e) { box.innerHTML = '<p style="text-align:center;color:var(--danger);">网络错误</p>'; }
}

/* ---------------- 正式榜上的「已加入排期」徽章 ---------------- */

/** 本地日期（YYYY-MM-DD）。与后端一样，只用于算出"哪一周"，不写库。 */
function rankToday(){
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

/** 某天所在那一周的周一（按 UTC 算，与 /api/schedule 的归一化口径一致）。 */
function rankMondayOf(dateStr){
  const d = new Date(dateStr + 'T00:00:00Z');
  const dow = d.getUTCDay();                 // 0 = 周日
  d.setUTCDate(d.getUTCDate() - (dow === 0 ? 6 : dow - 1));
  return d.toISOString().slice(0, 10);
}

/** 周一往后偏移 n 周。 */
function rankShiftWeeks(monday, n){
  const d = new Date(monday + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n * 7);
  return d.toISOString().slice(0, 10);
}

/** 本周一。 */
function rankThisMonday(){ return rankMondayOf(rankToday()); }

/**
 * 「已加入排期」徽章要用的 song_id → week_start 映射。
 *
 * 为什么不去改 /api/rank 的响应：正式榜的响应形状是**敏感**的
 * （有测试断言它完全不含 votes 字段），往里加字段迟早会踩到别的东西。
 * 所以这里**并发**再拉一次 /api/schedule —— 学生本来就有权限读它，
 * 整个正式榜因此只多出**一个**请求，一次取回 上周 / 本周 / 下周 三周，
 * 正好覆盖徽章要判断的范围（上周的不会被标，它已从正式榜移出）。
 *
 * 请求失败时返回空映射：榜单照常显示，只是没有徽章。
 */
async function scheduleWeekMap(){
  try {
    const res = await fetch('/api/schedule?week_start='
      + encodeURIComponent(rankShiftWeeks(rankThisMonday(), -1)) + '&weeks=3');
    if(!res.ok) return new Map();
    const d = await res.json();
    const map = new Map();
    for(const week of (d.weeklies || [])){
      for(const slot of (week.slots || [])){
        if(slot && slot.song_id !== null && slot.song_id !== undefined){
          map.set(safeInt(slot.song_id), week.weekStart);
        }
      }
    }
    return map;
  } catch(e) { return new Map(); }
}

async function loadApproved(){
  const box = document.getElementById('approvedList');
  if(!box) return;
  try {
    // 正式榜后端不下发票数字段，所以这里也不显示票数。
    // 排期徽章的数据与榜单**并发**取（只多这一个请求，见 scheduleWeekMap）。
    const [res, schedMap] = await Promise.all([
      fetch('/api/rank?status=approved'),
      scheduleWeekMap(),
    ]);
    if(res.status === 401){ showGate(); return; }
    const list = await res.json();
    if(!Array.isArray(list) || !list.length){ box.innerHTML = '<p style="text-align:center;color:var(--ink-4);padding:20px 0;">暂无已通过歌曲</p>'; return; }
    const thisMonday = rankThisMonday();
    const nextMonday = rankShiftWeeks(thisMonday, 1);
    box.innerHTML = list.map((s, i) => {
      const id = safeInt(s.id);
      // 正式榜不放票数（后端查询里根本不带 votes 字段）。
      // 结构改成两层之后，操作区只剩一个「试听」，和左边的信息形成主次，
      // 不再出现"一个按钮孤零零挤在右边"的样子。
      // 「已加入排期 · 本周 / 下周」：只在**本周或下周**的排期里才显示；
      // 上周以及更早的歌已经被 /api/rank 移出正式榜，本来也看不到。
      const schedWeek = schedMap.get(id) || '';
      const schedLabel = schedWeek === thisMonday ? '本周' : (schedWeek === nextMonday ? '下周' : '');
      return `
      <div class="rank-card" data-song="${id}">
        <div class="rank-top">
          <div class="song-main">
            <h3><span class="rank-no" aria-hidden="true"></span>${escapeHtml(s.title)}${schedLabel ? `<span class="sched-badge">已加入排期 · ${schedLabel}</span>` : ''}</h3>
            <p>${escapeHtml(s.artist)} · <span style="color:var(--brand);">${escapeHtml(s.category_name)}</span></p>
          </div>
        </div>
        <div class="song-acts">
          <button class="btn-upvote act-secondary" data-audition="${id}" data-title="${escapeHtml(s.title)}" data-artist="${escapeHtml(s.artist)}" data-track="${escapeHtml(s.track_id || '')}" onclick="auditionFromButton(this)">试听</button>
        </div>
      </div>
      <div id="audition-${id}"></div>
    `;
    }).join('');
    box.innerHTML = '<div class="list-panel">' + box.innerHTML + '</div>';
  } catch(e) { box.innerHTML = '<p style="text-align:center;color:var(--danger);">网络错误</p>'; }
}

/**
 * 退出登录。
 *
 * /api/logout 会把**两种身份**的 Cookie 一起清掉（学生与管理员），
 * 并删除服务端会话。所以退出后要重新输入口令。
 */
async function logoutUser(){
  if(!await uiConfirm('确认退出登录吗？\n\n退出后需要重新输入班级口令。\n管理员身份与学生身份的登录态会一起清除。')) return;

  try {
    await fetch('/api/logout', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' });
  } catch(e) {
    // 网络失败也照样回登录页；服务端会话到期后会自然失效
  }

  // 回到未登录状态（刷新一次拿全新的 Cookie 状态）
  location.href = '/';
}

/* ---------------- 公告 ---------------- */

/**
 * 登录页公告（scope='gate'）。
 * 这条路径**不需要登录** —— 它就是给还没进系统的人看的，
 * 所以只取已上架的 gate 类公告，主页公告不会漏到这里。
 */
async function loadGateAnnouncements(){
  const box = document.getElementById('gateAnnounceBox');
  if(!box) return;
  try {
    const res = await fetch('/api/announcements?scope=gate');
    if(!res.ok){ box.innerHTML = ''; return; }
    const data = await res.json();
    const list = Array.isArray(data.announcements) ? data.announcements : [];
    if(!list.length){ box.innerHTML = ''; return; }

    box.innerHTML = `
      <div style="margin-top:18px;padding-top:14px;border-top:1px dashed rgba(2,132,199,0.3);text-align:left;">
        ${list.map(a => `
          <div style="margin-bottom:12px;">
            <p style="margin:0 0 4px;font-size:13px;font-weight:700;color:var(--brand-ink);">${escapeHtml(a.title)}</p>
            <p style="margin:0;font-size:13px;line-height:1.7;color:var(--ink-2);white-space:pre-wrap;">${escapeHtml(a.content)}</p>
            <p style="margin:4px 0 0;font-size:11px;color:var(--ink-4);">${escapeHtml(a.created_at)}</p>
          </div>
        `).join('')}
      </div>
    `;
  } catch(e) { box.innerHTML = ''; }
}

/**
 * 弹窗式公告的条数上限由服务端控制（见 functions/api/announcements.js）。
 *
 * 这里**不再用一个模块级变量缓存**它 —— 早先那版把 `popups` 存进变量、
 * 再由 `showPopupAnnouncements()` 去读，结果是一个竞态：
 * 登录路径里 `loadAnnouncements()` 与"首次须知弹窗"是并发的，学生点得快时
 * 须知已经关掉、而 `popups` 还没写进来，第二次弹窗就**永远不出现**。
 * 改成 `loadAnnouncements()` **把结果返回出来**，弹窗直接用返回值 ——
 * 没有共享状态，就没有那个竞态。
 */
async function loadAnnouncements(){
  const box = document.getElementById('announceBox');
  try {
    const res = await getJson('/api/announcements');
    if(!res.ok){ if(box) box.innerHTML = ''; return []; }
    const data = await res.json();
    const popups = Array.isArray(data.popups) ? data.popups : [];
    if(!box) return popups;
    const list = Array.isArray(data.announcements) ? data.announcements : [];
    if(!list.length){ box.innerHTML = ''; return popups; }
    box.innerHTML = list.map(a => `
      <div class="panel" style="background:rgba(2,132,199,0.06);border-color:rgba(2,132,199,0.22);">
        <div class="rank-info">
          <h3 style="color:var(--brand-ink);margin:0 0 6px;font-size:15px;">${escapeHtml(a.title)}</h3>
          <p style="margin:0;white-space:pre-wrap;color:var(--ink-2);font-size:13px;line-height:1.7;">${escapeHtml(a.content)}</p>
          <p style="font-size:12px;color:var(--ink-4);margin:6px 0 0;">${a.created_by_name ? escapeHtml(a.created_by_name) + ' · ' : ''}${escapeHtml(a.created_at)}</p>
        </div>
      </div>
    `).join('');
    return popups;
  } catch(e) {
    if(box) box.innerHTML = '';
    return [];
  }
}

/* ---------------- 试听 ---------------- */

/**
 * 音源 P0-1：`<audio>` 的失败兜底。
 *
 * 为什么必须有：`/api/music?play=` 失败时返回的是 **JSON**（404 无试听片段 /
 * 502 音源地址不可信 / 502 上游不是音频 / 504 音源超时），`<audio>` 拿到这种
 * 响应只会**静默失败** —— 用户看到的就是"按了播放键什么都没发生"。
 * 所以这里监听 error / stalled，在播放器就地渲染一张说明条 + 一个退路按钮。
 */
function audioFallbackHint(audio){
  if(!audio || audio.dataset.fallbackShown === '1') return;
  audio.dataset.fallbackShown = '1';

  const box = audio.parentElement;
  if(!box) return;

  // 同一容器里只留一张提示条（重复触发时不会叠成一堆）
  const old = box.querySelector('.audio-fallback');
  if(old) old.remove();

  const hint = document.createElement('div');
  hint.className = 'cand-hint';
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
    const next = document.createElement('audio');
    next.controls = true;
    next.preload = 'metadata';
    next.style.width = '100%';
    next.dataset.trackId = track;
    // 加一个一次性参数，绕开浏览器对这 URL 的失败记忆
    next.src = '/api/music?play=' + encodeURIComponent(track) + '&retry=' + Date.now();
    audio.replaceWith(next);
    bindAudioFallback(next);
    next.play().catch(() => { /* 可能被自动播放策略拦截，忽略 */ });
  });
  hint.appendChild(retry);

  box.appendChild(hint);
}

/**
 * 给一个 `<audio>` 挂上失败兜底。trackId 只是给「重试」按钮用的，
 * 服务端仍然自己决定上游地址（客户端无法指定音源）。
 */
function bindAudioFallback(audio){
  if(!audio) return audio;
  if(audio.dataset.fallbackBound === '1') return audio;
  audio.dataset.fallbackBound = '1';

  // 主动监听：错误立刻提示，不用等用户去点播放
  audio.addEventListener('error', () => audioFallbackHint(audio));
  // stalled 只在真的断了（networkState=3 NO_SOURCE）时提示，
  // 否则正常缓冲也会触发，会误报
  audio.addEventListener('stalled', () => {
    if(audio.networkState === 3) audioFallbackHint(audio);
  });
  return audio;
}

// 用 data-* 传参而不是把歌名拼进 onclick 的 JS 字符串里：
// 歌名里若出现反斜杠等字符，拼字符串可能把引号转义掉造成注入。
// data 属性由浏览器解码，天然安全。
function auditionFromButton(button){
  audition(button.dataset.audition, button.dataset.title, button.dataset.artist, button.dataset.track);
}

/**
 * 音源 P0-3：挂播放器之前先问一次"这一版到底有没有音频"。
 *
 * 返回 true = 可以播（或无法判断，放行）；false = 确认播不出来。
 * `?check=` 只做一次重定向探测并复用 10 分钟缓存，不会触发音频转发。
 * 探测本身失败时服务端回 null（不确定），这里一律按"放行"处理 ——
 * 探测抖动不该把本来能听的歌挡掉。
 */
async function checkPlayable(trackId){
  if(!trackId) return true;
  try {
    const r = await fetch('/api/music?check=' + encodeURIComponent(trackId));
    if(!r.ok) return true;
    const d = await r.json();
    return d.playable !== false;
  } catch(e) {
    return true;
  }
}

async function audition(songId, title, artist, trackId){
  const host = document.getElementById('audition-' + safeInt(songId));
  if(!host) return;

  // 再点一次收起
  if(host.dataset.open === '1'){
    host.dataset.open = '0';
    host.innerHTML = '';
    return;
  }
  host.dataset.open = '1';

  // 点歌时锁定了音源 id：直接播当初选的那一版，不用重新搜索挑版本。
  // 历史数据没有这个字段，才退回"搜索 + 候选列表"的老流程。
  if(trackId){
    host.innerHTML = '<p class="cand-hint" style="text-align:center;margin:8px 0;">正在检查这一版能不能播…</p>';
    const playable = await checkPlayable(trackId);
    // 检查期间用户可能已经收起或换了别的歌
    if(host.dataset.open !== '1') return;

    if(!playable){
      host.innerHTML = '<p class="cand-hint" style="text-align:center;margin:8px 0;">'
        + '这一版暂时播不出来（可能是版权限制），换一个版本试试</p>'
        + '<p style="text-align:center;margin:8px 0;"><button data-title="' + escapeHtml(title) + '" data-artist="' + escapeHtml(artist) + '" data-song="' + safeInt(songId) + '" onclick="searchAlternatives(this)" '
        + 'style="width:auto;padding:7px 14px;font-size:13px;margin:0;">换个版本</button></p>';
      return;
    }

    host.innerHTML = directTrackPanelHtml(songId, title, artist, trackId);
    const audio = host.querySelector('audio');
    if(audio){
      // 失败兜底必须紧贴播放器挂上：`<audio>` 的 error 可能在插入 DOM 的
      // 下一帧就触发，晚挂一步就永远看不到提示（就是"点了没反应"）。
      // 按这个顺序也是为了让「每处 <audio> 附近都有失败处理」这条源码守卫
      // 能在很近的窗口里同时看到 <audio> 与绑定语句。
      bindAudioFallback(audio);
      audio.play().catch(() => { /* 浏览器可能拦截自动播放，忽略 */ });
    }
    return;
  }

  // 历史数据（009 迁移之前提交的歌）没有锁定音源，只能退回"搜索 + 候选列表"。
  // 这句话必须说清楚"现在听到的不一定就是收录的那一版"，
  // 否则学生会以为搜出来的第一个候选就是榜上记录的那一首。
  host.innerHTML = '<p style="text-align:center;color:var(--ink-4);font-size:13px;margin:8px 0;">这首歌没有锁定音源，正在按歌名搜索…</p>';

  try {
    let url = '/api/music?q=' + encodeURIComponent(title || '');
    if(artist) url += '&artist=' + encodeURIComponent(artist);
    const r = await fetch(url);
    const d = await r.json();
    if(!r.ok){
      host.innerHTML = '<p style="text-align:center;color:var(--danger);font-size:13px;margin:8px 0;">' + escapeHtml(d.error || '搜索失败') + '</p>';
      return;
    }
    const list = Array.isArray(d.results) ? d.results : [];
    if(!list.length){
      host.innerHTML = '<p style="text-align:center;color:var(--ink-4);font-size:13px;margin:8px 0;">没找到可试听的版本</p>';
      return;
    }
    host.innerHTML = auditionPanelHtml(songId, list);
  } catch(e) {
    host.innerHTML = '<p style="text-align:center;color:var(--danger);font-size:13px;margin:8px 0;">网络错误</p>';
  }
}

/**
 * 直接播放"点歌时锁定的那一版"。
 *
 * 这是默认路径：学生点歌时必须从搜索结果里选一首，音源 id 被一起存了下来。
 * 所以这里不需要搜索，也不需要让用户再挑一次 —— 点的哪版就听哪版。
 * 底部留一个「换一个版本」，找不到合适的时还能搜别的。
 */
function directTrackPanelHtml(songId, title, artist, trackId){
  const id = safeInt(songId);

  return `
    <div class="aud-panel">
      <div class="cand-head">
        <div class="aud-title">正在试听 · ${escapeHtml(title)}</div>
        <button class="cand-quiet" onclick="closeAudition(${id})">收起 ▲</button>
      </div>
      <div class="aud-sub cand-hint">
        ${escapeHtml(artist)}　·　点歌时锁定的音源，直接播放这一版
      </div>

      <div class="aud-slot">
        <audio controls preload="metadata" data-track-id="${escapeHtml(trackId)}" src="/api/music?play=${encodeURIComponent(trackId)}" style="width:100%;"></audio>
      </div>

      <div class="cand-hint cand-acts">
        <button class="cand-quiet" data-title="${escapeHtml(title)}" data-artist="${escapeHtml(artist)}" data-song="${id}" onclick="searchAlternatives(this)">这首不对？换个版本</button>
        <button class="cand-quiet" data-title="${escapeHtml(title)}" data-artist="${escapeHtml(artist)}" data-song="${id}" onclick="suggestFromButton(this)">提建议给管理员</button>
      </div>
    </div>
  `;
}

/** 从"直接播放"切回"搜索候选列表"。 */
function searchAlternatives(button){
  const songId = safeInt(button.dataset.song);
  const host = document.getElementById('audition-' + songId);
  if(host) host.dataset.open = '0';
  audition(songId, button.dataset.title, button.dataset.artist, '');
}

/**
 * 对这首歌提建议（版本不合适 / 音质差 / 不是原唱…）。
 * 内容会出现在管理员后台这首歌上；最终换哪一版由管理员决定。
 */
async function suggestFromButton(button){
  const songId = safeInt(button.dataset.song);
  const title = button.dataset.title || '';
  if(!songId) return;

  const text = await uiPrompt(
    '对「' + title + '」提个建议：\n\n'
    + '例如：这一版音质差 / 不是原唱 / 是翻唱 / 纯音乐版本不对\n'
    + '管理员会在后台看到这条建议。',
    '',
    '提建议给管理员',
    '最多 120 字'
  );
  if(text === null) return;

  const content = String(text).trim();
  if(!content){ uiAlert('建议内容不能为空'); return; }

  try {
    // 人机校验令牌（reCAPTCHA v3，无感）。没启用时是空串。
    const rcToken = await recaptchaToken('suggest');
    const r = await fetch('/api/suggest', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({song_id: songId, content: content, recaptcha_token: rcToken})
    });
    const d = await r.json().catch(() => ({}));
    if(r.ok){ uiToast(d.message || '建议已提交', 'ok'); }
    else { uiAlert(d.error || '提交失败'); }
  } catch(e) { uiAlert('网络错误'); }
}

function playFromButton(button){
  playTrack(button.dataset.track, button.dataset.song);
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
 * 试听候选面板：**顶部一个固定播放器 + 下面一份音乐列表**。
 *
 * 早期版本是把 <audio> 追加到列表末尾，点最后一首时播放条会跑到很下面，
 * 非常难用。现在播放器固定在面板顶部，点任意一行都只替换它的内容。
 */
function auditionPanelHtml(songId, list){
  const id = safeInt(songId);

  const rows = list.map((s, index) => `
    <div data-track-row="${escapeHtml(s.id)}" style="flex-wrap:wrap;">
      <span class="cand-no">${index + 1}</span>
      <div>
        <div class="cand-name">${escapeHtml(s.name)}</div>
        <div class="cand-sub">${escapeHtml(s.artist)}${s.album ? ' · ' + escapeHtml(s.album) : ''}${s.source ? ' · ' + escapeHtml(s.source) : ''}</div>
      </div>
      <span class="cand-dur">${escapeHtml(formatDuration(s.duration))}</span>
      <button data-track="${escapeHtml(s.id)}" data-song="${id}" onclick="playFromButton(this)">播放</button>
    </div>
  `).join('');

  return `
    <div class="cand-panel">
      <div class="cand-head">
        <div class="cand-title">试听候选 · ${list.length} 个</div>
        <button class="cand-quiet" onclick="closeAudition(${id})">收起 ▲</button>
      </div>
      <div class="cand-hint">以下为搜索到的候选版本，不是榜单上的歌曲</div>

      <div class="cand-player" id="audition-player-${id}">
        <div class="cand-hint" style="padding:0;">点下面任意一行的「播放」开始试听</div>
      </div>

      <div class="cand-rows">${rows}</div>
    </div>
  `;
}

function closeAudition(songId){
  const host = document.getElementById('audition-' + safeInt(songId));
  if(!host) return;
  host.dataset.open = '0';
  host.innerHTML = '';
}

/**
 * 播放某一首候选。
 * 播放器固定在面板顶部，这里只替换它的内容并高亮对应行，不再往列表末尾追加。
 */
function playTrack(trackId, songId){
  const id = safeInt(songId);
  const host = document.getElementById('audition-' + id);
  const slot = document.getElementById('audition-player-' + id);
  if(!host || !slot || !trackId) return;

  host.querySelectorAll('[data-track-row]').forEach((row) => {
    row.style.background = row.dataset.trackRow === trackId ? 'rgba(14,165,233,0.14)' : 'transparent';
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

/* ============================================================
   投稿与投票规定 / 免责声明
   —— 规定同时是审核依据；后台也有一个展开入口看同一份内容。
   ============================================================ */

const RULES = [
  '中午放学播放 3 首含歌词的音乐，下午上学播放 3 首纯音乐。',
  '不出现含有日语或韩语的歌曲，尽量避免小语种歌曲；英语歌曲可以投稿，但播放比例较小。',
  '歌词积极向上，减少情爱类型；不出现政治敏感、脏话等违规内容；不出现有特殊含义的歌曲（如校歌、国歌）。',
  '歌手无违法犯罪行为。',
  '不出现 rap，以及底噪、低音、高音过大的歌曲；音游、二次元相关歌曲请尽量少投稿。',
  '投稿的歌曲将交由广播站老师和分管校长审核，审核通过后会安排在相应时间播放。学校审核较严格，如未通过请谅解。',
  '参与投稿即表明“我已阅读投稿须知并知晓该歌曲可能无法播出”，审核不通过的歌曲将被驳回。',
  '本系统仅提供音乐搜索与播放管理功能，不存储任何音乐文件。所有音乐内容均来自第三方音乐平台，版权归原平台及版权方所有。投稿时请遵守相关音乐平台的服务条款、尊重音乐作品版权；我们鼓励支持正版音乐，在官方平台购买和收听喜爱的作品。',
  '最终解释权归盐中之声广播站所有。',
];

const DISCLAIMER = [
  '本页面由江苏省盐城中学盐中之声广播站学生社团自主搭建与维护，是校内投稿工具，非学校官方信息发布渠道，与学校教务、宣传等部门的正式信息无关。',
  '页面展示的歌曲信息与试听音频均来自第三方公开音乐服务，本站不存储、不提供任何音频文件下载，相关著作权归各自权利人所有。试听内容仅用于投稿前确认版本，请勿下载、二次传播或用于商业用途；若权利人认为内容不当，请联系广播站，我们将及时处理。',
  '因第三方服务调整导致的试听失败、音质差异或内容变更，本站不承担责任。',
  '为防范刷票，页面会采集设备特征生成匿名指纹，仅用于限制重复投稿与投票，不用于识别个人身份，也不与任何第三方共享。',
  '请勿利用本页面从事刷票、恶意投稿或其他干扰正常校园广播秩序的行为。',
];

function rulesListHtml(){
  return RULES.map((t, i) =>
    '<div style="display:flex;gap:8px;padding:5px 0;font-size:13px;line-height:1.6;color:var(--ink-2);">'
    + '<span style="flex:0 0 auto;color:var(--brand);font-weight:700;">' + (i + 1) + '.</span>'
    + '<span>' + escapeHtml(t) + '</span></div>'
  ).join('');
}

/**
 * 须知面板是否展开 —— 默认展开。
 * 声明必须放在 renderRules 之前：之前踩过"暂时性死区"的坑，
 * 虽然后者是运行时才调用，但放前面就不必依赖调用时机。
 */
let rulesOpen = true;

function renderRules(){
  const box = document.getElementById('rulesBox');
  if(!box) return;

  // 默认**展开**（用户要求）：投稿须知是审核依据，藏着容易让人直接跳过不读。
  // 点标题仍可收起 —— 老用户看腻了就折起来，不占地方。
  // 另外首次进入还会弹一次确认（见 maybeShowFirstVisitNotice）。
  const open = rulesOpen;

  box.innerHTML = `
    <div class="panel">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;cursor:pointer;"
           onclick="toggleRules()">
        <h3 style="margin:0;color:var(--brand-ink);font-size:15px;">投稿须知</h3>
        <button type="button" class="rules-toggle" id="rulesToggle" aria-expanded="${open ? 'true' : 'false'}" aria-controls="rulesBody">${open ? '收起' : '展开'}</button>
      </div>
      <p style="margin:6px 0 0;font-size:13px;color:var(--ink-3);">审核按此须知执行，投稿前请先过一遍</p>
      <div id="rulesBody" style="display:${open ? 'block' : 'none'};margin-top:10px;border-top:1px solid var(--line-soft);padding-top:8px;">
        ${rulesListHtml()}
      </div>
    </div>
  `;
}

/** 展开/收起须知面板。 */
function toggleRules(force){
  const body = document.getElementById('rulesBody');
  const label = document.getElementById('rulesToggle');
  if(!body) return;
  rulesOpen = force === undefined ? body.style.display === 'none' : !!force;
  body.style.display = rulesOpen ? 'block' : 'none';
  if(label){
    label.textContent = rulesOpen ? '收起' : '展开';
    // 无障碍：折叠控件的状态要说出来，不能只靠文字变化
    label.setAttribute('aria-expanded', rulesOpen ? 'true' : 'false');
  }
}

function renderDisclaimer(){
  const box = document.getElementById('disclaimerBox');
  if(!box) return;

  box.innerHTML = `
    <div style="margin-top:20px;padding-top:14px;border-top:1px solid rgba(148,163,184,0.28);text-align:left;">
      <p style="font-size:11px;font-weight:700;color:var(--ink-3);margin:0 0 6px;letter-spacing:1px;">免责声明</p>
      ${DISCLAIMER.map((t) =>
        '<p style="font-size:11px;line-height:1.7;color:var(--ink-4);margin:0 0 6px;">' + escapeHtml(t) + '</p>'
      ).join('')}
    </div>
  `;
}

/**
 * 首次进入时弹一次规定须知。
 *
 * **返回 Promise**：弹窗公告（`showPopupAnnouncements`）要等这一条关掉之后
 * 才作为"第二个弹窗"冒出来（用户明确要求"在登录进去的时候会作为初始弹窗
 * 后面一个弹窗，第二个冒出来"）。不返回 Promise 的话两个模态框会同时插进 DOM、
 * 叠在一起 —— 那不是"先后两个"，是一团糟。
 */
async function maybeShowFirstVisitNotice(){
  const KEY = 'yczx_rules_seen_v1';
  let seen = null;
  try { seen = localStorage.getItem(KEY); } catch(e) { /* 隐私模式下不可用 */ }
  if(seen) return;

  await uiDialog({
    title: '投稿前请先看一遍投稿须知',
    // 那句"知晓该歌曲可能无法播出"原本**塞在按钮文案里**，18 个字在 390px 上折成两行，
    // 按钮显得又高又笨（用户反馈"那个知道了按钮位置不对"）。
    // 同一句话放进正文更合适：按钮只留一个干脆的动作词。
    message: '本页是盐中之声广播站的校内投稿工具，非学校官方发布渠道。\n\n投稿每周限一首，须从搜索结果里选歌；违禁词会被直接拦下；投稿将由广播站老师和分管校长审核。\n\n投稿即表示已知晓：审核不通过的歌曲会被驳回，个别歌曲也可能因版权限制而无法播出。\n\n完整须知可在首页「投稿须知」里展开查看，页面底部有免责声明。',
    okText: '我已阅读，知道了',
    cancelText: '',
  });
  try { localStorage.setItem(KEY, '1'); } catch(e) { /* 忽略 */ }
  // 顺手把规定展开一次，方便他直接看到全文
  toggleRules(true);
}

/* ---------------- 弹窗式公告 ----------------
   管理员发一条 scope='popup' 的公告，学生**登录后**会看到一个模态框
   （排在"首次投稿须知"之后，第二个冒出来）。UI 与须知弹窗完全一致 ——
   用的就是同一个 uiDialog。

   为什么每台设备只弹一次（按公告 id 记在 localStorage）：
   这是个模态框，每次切页面/刷新都弹一遍会让人没法用页面。
   要"重新提醒一次"就再发一条新公告（id 不同 -> 会重新弹）。 */

/** 记住哪些弹窗公告已经看过（存 id 列表，最多留 20 个）。 */
function popupSeenIds(){
  try {
    const raw = localStorage.getItem('yczx_announce_popup_seen');
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.map((x) => String(x)) : [];
  } catch(e) { return []; }
}

function markPopupSeen(id){
  try {
    const list = popupSeenIds();
    const value = String(id);
    if(list.includes(value)) return;
    // 只留最近 20 条：公告删了之后这些 id 再也不会出现，
    // 不清就会一直涨（localStorage 有配额，涨满了写不进去会连带影响别的键）。
    const next = list.concat([value]).slice(-20);
    localStorage.setItem('yczx_announce_popup_seen', JSON.stringify(next));
  } catch(e) { /* 隐私模式下写不了：那就每次弹，不影响功能 */ }
}

/**
 * 依次弹出还没看过的弹窗公告。
 *
 * **串行**：`await` 每一条，后一条等前一条关掉才出现 ——
 * 同时插三个模态框会全部叠在一起，学生以为自己把页面点坏了。
 *
 * @param {Array} list `/api/announcements` 返回的 `popups`（由调用方传入，
 *        不经共享变量 —— 那会引入"须知关得比公告到得快"的竞态）。
 */
async function showPopupAnnouncements(list){
  const items = Array.isArray(list) ? list : [];
  if(!items.length) return;

  const seen = popupSeenIds();
  for(const a of items){
    if(!a || a.id === undefined || a.id === null) continue;
    if(seen.includes(String(a.id))) continue;
    // eslint-disable-next-line no-await-in-loop
    await uiDialog({
      title: a.title || '广播站公告',
      message: (a.content || '') + (a.created_by_name || a.created_at
        ? '\n\n—— ' + [a.created_by_name, a.created_at].filter(Boolean).join(' · ')
        : ''),
      okText: '知道了',
      cancelText: '',
    });
    markPopupSeen(a.id);
  }
}

/* ---------------- 举报 ---------------- */

/**
 * 举报待审核的歌。
 * 只有被多个班级举报、并且仍在待审核池里的歌，才会进入管理员的举报收件箱 ——
 * 所以这里明确告诉学生"一个人举报不会立刻有人看到"。
 */
async function reportFromButton(button){
  const id = safeInt(button.dataset.report);
  if(!id) return;

  const reason = await uiPrompt('举报的原因（选填，例如：内容不合适 / 与歌名不符）', '');
  if(reason === null) return;   // 点了取消

  if(!await uiConfirm('确认举报这首歌吗？\n\n同一首歌被多个班级举报后，才会出现在管理员的举报收件箱里。')) return;

  try {
    // 人机校验令牌（reCAPTCHA v3，无感）。没启用时是空串。
    const rcToken = await recaptchaToken('report');
    const r = await fetch('/api/report', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({id: id, reason: reason.trim(), recaptcha_token: rcToken})
    });
    const d = await r.json();
    if(r.ok){
      // 同理：举报只影响这首歌自己的显示状态，没必要重绘整榜。
      const song = pendingSongs.find((x) => safeInt(x.id) === safeInt(id));
      if(song) song.is_reported = 1;
      uiToast('已提交举报，感谢反馈', 'ok');
    }
    else { uiAlert(d.error || '举报失败'); }
  } catch(e) { uiAlert('网络错误'); }
}

async function upvote(id, btn){  if(!await uiConfirm('确认给这首歌投一票吗？')) return;
  // 算 PoW 可能要几百毫秒到几秒：期间把按钮置灰并换文案，
  // 与别处禁用按钮同一套做法（disabled + 文案），免得学生以为没点上。
  const idleText = btn ? btn.textContent : '';
  if(btn){ btn.disabled = true; btn.textContent = '正在校验…'; }
  try {
    const fingerprint = await deviceFingerprint();
    // 人机校验令牌（reCAPTCHA v3，无感）。没启用时是空串。
    const rcToken = await recaptchaToken('upvote');
    // 工作量证明答案（默认关闭时是 null）。算不出来 / 没启用都传 null，
    // 由后端按开关决定：功能开着才会校验。
    const proof = await powProof('upvote');
    const r = await fetch('/api/upvote', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({id: safeInt(id), fingerprint: fingerprint, recaptcha_token: rcToken, pow: proof})});
    const d = await r.json();
    if(r.ok){
      // 借鉴 VoiceHub 的做法：动作接口返回结果后，前端**只更新受影响的数据**，
      // 不把整个列表重新拉一遍。这里票数 +1 是确定的（服务端已经确认计入），
      // 所以直接改内存与那一张卡片即可 —— 其他行的试听播放器不受影响。
      const song = pendingSongs.find((x) => safeInt(x.id) === safeInt(id));
      if(song){
        song.votes = safeInt(song.votes) + 1;
        patchPendingCard(id);
      }
      uiToast('投票成功', 'ok');
    }
    else { uiAlert(d.error || '操作失败'); }
  } catch(e) { uiAlert('网络错误'); }
  finally {
    if(btn){
      btn.textContent = idleText;
      // 恢复成"当前身份该有的样子"：游客模式下它本来就该是灰的
      setDisabledWithReason(btn, isGuestMode, '游客模式只能查看排行，不能投票');
    }
  }
}

// 启动：用一次探测请求判断会话是否还有效，有效就直接进主页。
// 这条探测是**读**接口（榜单），与"试写操作看 403"是两回事。
(async function boot(){
  // 登录页公告要先加载 —— 还没登录时也要能看到
  loadGateAnnouncements();

  try {
    const r = await getJson('/api/rank?status=pending');
    if(r.ok){
      // 先问清身份再渲染：loadPending 渲染投票/举报按钮时就要用这个状态。
      const guest = await loadIdentity();
      applyGuestMode(guest);
      showApp();
      const announcementsTask = loadAnnouncements();
      loadPending();
      loadApproved();
      // 会话还在、直接进主页的情况下也算"首次进入"（游客同样不弹，理由同上）
      if(!guest){
        const firstVisit = maybeShowFirstVisitNotice();
        Promise.all([announcementsTask, firstVisit]).then(([popups]) => showPopupAnnouncements(popups));
      }
    } else { showGate(); }
  } catch(e) { showGate(); }
})();