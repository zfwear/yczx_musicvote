

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

// 普通管理员能做什么：审核歌单、维护黑名单、发公告。
// 不能管理其他管理员，也不能改班级口令与分类权重 —— 那些只有高级管理员能做。

function setMsg(text, color){
  const el = document.getElementById('regMsg');
  el.textContent = text || '';
  el.style.color = color || '#e11d48';
}

async function doRegister(){
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  const password2 = document.getElementById('password2').value;
  const code = document.getElementById('inviteCode').value.trim();

  if(!username || !password){ setMsg('账号和密码都要填'); return; }
  if(password.length < 8){ setMsg('密码至少 8 位'); return; }
  if(password !== password2){ setMsg('两次输入的密码不一致'); return; }
  if(!code){ setMsg('请填写高级管理员给你的动态口令'); return; }

  const button = document.getElementById('regBtn');
  button.disabled = true;
  setMsg('提交中...', '#0284c7');

  try {
    const r = await fetch('/api/admin-register', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({username: username, password: password, invite_code: code})
    });
    const d = await r.json();
    if(r.ok){
      setMsg('注册成功！3 秒后跳转到登录页…', '#059669');
      setTimeout(() => { location.href = '/admin.html'; }, 3000);
      return;
    }
    setMsg(d.error || '注册失败');
  } catch(e) {
    setMsg('网络错误');
  }
  button.disabled = false;
}

// 支持高级管理员直接把带口令的链接发给别人：/register.html?code=XXXX-XXXX-XXXX
(function boot(){
  try {
    const preset = new URLSearchParams(location.search).get('code');
    if(preset){ document.getElementById('inviteCode').value = preset; }
  } catch(e) { /* 忽略 */ }

  ['username','password','password2','inviteCode'].forEach((id) => {
    document.getElementById(id).addEventListener('keydown', (event) => {
      if(event.key === 'Enter') doRegister();
    });
  });
})();
