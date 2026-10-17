/* New Vote2 client: a small, dependency-free UI layer over the existing API. */
window.__appJsLoaded = true;
const $ = (s, root=document) => root.querySelector(s);
const $$ = (s, root=document) => [...root.querySelectorAll(s)];

/* 版本一致性守卫：页面 HTML 与 app.js 必须同批次上传。
   只传一半（比如新页面配旧脚本、或反之）时，页面会"点了没反应"——
   这里直接把它变成一条看得懂的提示。 */
const APP_VER = '4.0.0';
{
  const pageVer = document.body && document.body.dataset ? document.body.dataset.appVer : '';
  if (pageVer && pageVer !== APP_VER) {
    const bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:999;padding:10px 16px;background:#B45309;color:#fff;font:13px/1.5 -apple-system,"Microsoft YaHei",sans-serif;text-align:center;';
    bar.textContent = '页面与脚本版本不一致（页面 ' + pageVer + ' / 脚本 ' + APP_VER + '）：本站是分文件部署的，请把交付包里的全部文件一起上传；本地预览请 Ctrl+F5 强制刷新。';
    (document.body || document.documentElement).appendChild(bar);
  }
}
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
/* 边缘缓存通行证（v3.6.2，见后端 _lib/auth.js 的 gatedCache）：
   登录后服务端通过 X-Cache-Key 响应头下发一个当天有效的签名（_k），存在本地；
   之后所有 GET 请求自动带上它 —— 带通行证才允许进 ESA 共享缓存（20ms 级），
   没登录的人拿不到它，也就读不到缓存里的榜单/公告/排期。速度与门槛两头都要。 */
const edgeKeyGet = () => { try { return localStorage.getItem('edge_k') || ''; } catch { return ''; } };
const edgeKeySave = (v) => { try { if (v) localStorage.setItem('edge_k', v); } catch { /* 存不下就算了 */ } };
const api = async (url, options={}) => { const {quiet401=false,...init}=options;
  let target=url;
  try{ if(url.startsWith('/api/')&&(!init.method||init.method==='GET')){const k=edgeKeyGet();if(k)target=url+(url.includes('?')?'&':'?')+'_k='+encodeURIComponent(k);} }catch{}
  let r; try{ r=await fetch(target,{credentials:'same-origin',headers:{'Content-Type':'application/json',...(init.headers||{})},...init}); }catch(err){ throw new Error('连不上后台服务——若你是"直接双击打开页面"预览的，请改用 server.mjs 启动本地服务器（见交付说明）'); }
  try{const nk=r.headers.get('X-Cache-Key');if(nk)edgeKeySave(nk);}catch{/* 读不到头就算了 */}
  let d={}; try{d=await r.json();}catch{} if(r.status===401){
  /* 登录/探测类请求（quiet401）保留服务端的具体原因：
     登录口令错就是「口令错误」，管理员密码错就是「账号或密码错误」，
     不能一律改写成「登录已过期」。这里必须放在后台 401 分支之前 ——
     登录表单本身也在 admin-page 里，放后面会把密码错误误报成会话过期。 */
  if(quiet401) throw new Error(d.error||'登录已过期，请重新登录');
  /* 4.0.0 前后台分离：后台接口 401 只回后台登录表单，
     绝不跳前台登录页，也不调用 /api/logout（那会连学生会话一起清掉）。 */
  if(document.body&&document.body.classList.contains('admin-page')){
    try{const sc=$('#adminScreen'),wk=$('#adminWork'),am=$('#adminMessage');if(wk)wk.hidden=true;if(sc)sc.hidden=false;if(am)am.textContent='后台会话已过期，请重新登录后台。';}catch{}
    setTimeout(()=>{api.sessionPrompted=false;},3000);
    throw new Error('后台登录已过期，请重新登录');
  }
  if(!api.sessionPrompted){api.sessionPrompted=true;toast('登录已过期，请重新登录');if(await uiConfirm('需要重新登录。\n按「回到登录页」重新输入口令，按「留在本页」继续浏览。',{title:'登录已过期',ok:'回到登录页',cancel:'留在本页'})){/* 先把服务端会话与两种身份的 Cookie 一起清掉（logout 幂等，永远 200）——
   这一步就是"登出后再登录提示会话过期、只能手动清 Cookie"那类死锁的解药：
   回到登录页之前凭证已经被主动作废，不会留着一份过期的旧会话继续捣乱。 */
    try{await fetch('/api/logout',{method:'POST',credentials:'same-origin'});}catch{}try{sessionStorage.setItem('loginNotice','登录已过期，请重新输入班级口令。');}catch{}location.href='/login';return;}setTimeout(()=>{api.sessionPrompted=false;},3000);}throw new Error('登录已过期，请重新登录');}if(!r.ok) throw new Error(d.error||('请求失败（HTTP '+r.status+'）')); return d; };
const toast = (text) => { const n=document.createElement('div'); n.className='toast'; n.textContent=text; document.body.append(n); setTimeout(()=>n.remove(),2600); };
/* 弹窗公告用的对话框：复用 app.css 的 .glass-dialog（zip 自己的样式）。
   用 <dialog> 而不是原生 alert —— 不阻塞渲染、手机上不会丑，而且能 await 成串行。 */
function announceDialog(title, content){
  return new Promise((resolve)=>{
    const d=document.createElement('dialog');
    d.className='glass-dialog notice-dialog';
    const h=document.createElement('h2'); h.textContent=title||'公告';
    const p=document.createElement('p'); p.className='notice-body'; p.textContent=content||'';
    const b=document.createElement('button'); b.type='button'; b.className='btn primary'; b.textContent='知道了';
    b.onclick=()=>d.close();
    d.append(h,p,b);
    d.addEventListener('close',()=>{d.remove();resolve();});
    document.body.append(d);
    if(typeof d.showModal==='function') d.showModal(); else d.setAttribute('open','');
  });
}{try{const n=sessionStorage.getItem('loginNotice');if(n){sessionStorage.removeItem('loginNotice');setTimeout(()=>toast(n),260);}}catch{}}
/* 自绘对话框：替代浏览器原生 alert/confirm —— 与站点同一套视觉，且可 await。 */
function uiDialog(opts){
  const {title='请确认', message='', ok='确定', cancel='取消', danger=false} = opts||{};
  return new Promise((resolve)=>{
    const d=document.createElement('dialog');
    d.className='rl-confirm';
    const h=document.createElement('h2'); h.textContent=title;
    const p=document.createElement('p'); p.textContent=message;
    const actions=document.createElement('div'); actions.className='dialog-actions';
    let settled=false;
    const done=(v)=>{ if(settled)return; settled=true; try{d.close();}catch{} d.remove(); resolve(v); };
    if(cancel){ const c=document.createElement('button'); c.type='button'; c.className='btn quiet'; c.textContent=cancel; c.onclick=()=>done(false); actions.append(c); }
    const b=document.createElement('button'); b.type='button'; b.className='btn '+(danger?'danger':'primary'); b.textContent=ok; b.onclick=()=>done(true); actions.append(b);
    d.append(h,p,actions);
    d.addEventListener('cancel',(e)=>{ e.preventDefault(); done(false); });
    d.addEventListener('click',(e)=>{ if(e.target===d) done(false); });
    document.body.append(d);
    if(typeof d.showModal==='function') d.showModal(); else d.setAttribute('open','');
  });
}
const uiConfirm=(message,opts={})=>uiDialog({...opts,message});
const uiAlert=(message,opts={})=>uiDialog({...opts,message,cancel:null,ok:opts.ok||'知道了'});
/* 移动端抽屉导航：汉堡开合；遮罩、关闭按钮、Esc、点了抽屉里的链接都收起。
   用事件委托，nav() 每次重绘（innerHTML 替换）后不用重新绑定。 */
function navDrawer(open){const on=open===undefined?!document.body.classList.contains('nav-open'):!!open;document.body.classList.toggle('nav-open',on);const b=document.querySelector('[data-burger]');if(b)b.setAttribute('aria-expanded',String(on));}
document.addEventListener('click',e=>{const t=e.target;if(!t||!t.closest)return;if(t.closest('[data-burger]')){navDrawer();return;}if(t.closest('[data-nav-backdrop]')||t.closest('[data-nav-close]')){navDrawer(false);return;}if(document.body.classList.contains('nav-open')&&t.closest('.topbar .actions a[href]'))navDrawer(false);});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&document.body.classList.contains('nav-open'))navDrawer(false);});
/* 试听播放器生命周期：同一时刻只留一个在播（开新的就停旧的）；
   弹窗关闭时把里面的播放器 pause+归零，不再后台继续放。 */
const livePlayers=new Set();
function stopAllPlayers(){for(const a of livePlayers){try{a.pause();a.currentTime=0;}catch{}}livePlayers.clear();}
function registerPlayer(audio){if(!audio)return;livePlayers.add(audio);audio.addEventListener('play',()=>{for(const a of livePlayers){if(a!==audio)try{a.pause();}catch{}}});}
function stopPlayersIn(root){if(!root)return;root.querySelectorAll('audio').forEach(a=>{try{a.pause();a.currentTime=0;}catch{}});}
/* 入场动效：纯 CSS（app.css 的 .reveal-in / revealUp），不再依赖第三方动画库。
   原来为这一处淡入要每个页面下载并解析 72KB 的动画库脚本，不值；
   观感保持一致（淡入 + 上移 14px + 每元素错开 50ms），尊重系统的减少动效设置。 */
const reveal = (els) => { if(matchMedia('(prefers-reduced-motion: reduce)').matches)return;let i=0;for(const el of els){el.style.setProperty('--reveal-delay',(i++*50)+'ms');el.classList.add('reveal-in');} };
const verificationLines = ['正在借你的 CPU 烤小饼干喵～','正在偷偷啃一口你的处理器，嗷呜——真香喵！','算力香香的，本喵正在大口嚼碎谜题喵～','借用一点点算力当零食，嚼完马上放行喵！','正在用你的手机算力搓小鱼干喵～','正在你的芯片里踩奶，稍等一下下喵～','悄悄薅一撮你的算力羊毛，立刻就好喵！','CPU 正在飞速运转，本喵正在呼呼帮你吹凉散热喵～','嚼嚼嚼……正在消化这个复杂的数学谜题喵！','正在向你的设备征收一点点猫猫通行费喵～','嗅嗅……本喵正在闻闻你是不是机器小偷喵～','侦探喵出动！正在用放大镜看你是不是人类喵～','机器人走开！本喵正在设立安全猫爪结界喵！','正在检查你的“纯正两脚兽”身份认证喵～','正在启动猫眼雷达，全方位扫描可疑脚本喵～','嘟嘟嘟！正在拦截偷渡的网络小机器人喵～','本喵正在扒拉你的数据包，看有没有藏坏心思喵！','正在给你盖一枚特批的“善良人类”肉垫印章喵～','超凶警告！本喵正在认真站岗查房喵～','警报解除中……本喵正在确认你的通行安全等级喵～','正在让你的电脑帮本喵做一道很难的高数题喵～','谜题正在解开中，猫猫头都要想秃了喵！','魔法阵启动中……嗡嗡嗡——正在注入猫猫灵力喵！','你的设备正在拼命转圈圈解题，本喵给它加个油喵～','正在做一道算不清楚的猫罐头数学题，再等三秒喵！','正在向喵星总服务器发送解谜报告喵～','哔哔哔——你的 CPU 正在奋力出汗，马上搞定喵！','谜题马上攻克！本喵先伸个懒腰准备发通行证喵～','算力拼图最后一块拼接中，不要眨眼喵～','验证通过倒计时中，准备好迎接本喵的热情招待了吗喵～'];
let verificationCount=0,verificationTimer,verificationNode,lastVerificationIndex=-1;
function beginVerification(){if(!verificationNode){verificationNode=document.createElement('div');verificationNode.className='verification-note';verificationNode.setAttribute('role','status');verificationNode.setAttribute('aria-live','polite');verificationNode.innerHTML='<span class="verification-paw" aria-hidden="true"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke-dasharray="40 14"/></svg></span><span data-verification-line></span>';document.body.append(verificationNode);}verificationCount++;if(verificationTimer)return;const rotate=()=>{let i;do{i=Math.floor(Math.random()*verificationLines.length);}while(i===lastVerificationIndex);lastVerificationIndex=i;verificationNode.querySelector('[data-verification-line]').textContent=verificationLines[i];};rotate();verificationNode.hidden=false;verificationTimer=setInterval(rotate,2200);}
function endVerification(){verificationCount=Math.max(0,verificationCount-1);if(verificationCount||!verificationNode)return;clearInterval(verificationTimer);verificationTimer=undefined;verificationNode.hidden=true;}
async function withVerification(task){beginVerification();try{return await task();}finally{endVerification();}}
let cachedFingerprint;
async function fingerprint(){if(cachedFingerprint)return cachedFingerprint;const n=navigator,s=screen||{};let canvas='no-canvas',webgl='no-webgl';try{const c=document.createElement('canvas');c.width=220;c.height=44;const x=c.getContext('2d');if(x){x.font='14px Arial';x.fillText('radio vote2',2,4);x.arc(60,20,12,0,Math.PI*2);x.stroke();canvas=c.toDataURL();}}catch{}try{const gl=document.createElement('canvas').getContext('webgl');if(gl){const info=gl.getExtension('WEBGL_debug_renderer_info');webgl=String(info?gl.getParameter(info.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER));}}catch{}const raw=[n.userAgent||'',n.platform||'',n.language||'',(n.languages||[]).join(','),n.hardwareConcurrency||'',n.maxTouchPoints||'',`${s.width||0}x${s.height||0}x${s.colorDepth||0}`,devicePixelRatio||0,Intl.DateTimeFormat().resolvedOptions().timeZone||'',canvas,webgl].join('|');try{const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw));cachedFingerprint=[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');}catch{let out='';for(let seed=0;seed<4;seed++){let h=(0x811c9dc5^(seed*0x9e3779b1))>>>0;for(let i=0;i<raw.length;i++){h^=raw.charCodeAt(i);h=Math.imul(h,0x01000193)>>>0;}out+=h.toString(16).padStart(8,'0');}cachedFingerprint=out;}return cachedFingerprint;}
let recaptchaConfig,powConfig;
/* ---------- 留存加载（SWR 缓存层，v3.6.1）----------
   手机上"慢"的大头不是下载（JS/CSS 已 immutable 长缓存），而是每次进页面
   都要等 1~2 轮 API 往返才出内容。榜单 / 公告 / 排期 / 站点配置这类
   "读多写少"的数据，把上一次的响应留在 localStorage：
     · get()   —— 直接取上次响应（不管多旧），用于"先直出、再刷新"；
     · fresh() —— 只取 TTL 内的响应，命中就连网络都不发（省 D1 读取）；
     · set()   —— 带时间戳写入。
   管理员后台的数据一律**不进**这层（审核必须实时）。
   键带 v1 前缀：以后响应形状变了换前缀即可，不会读出旧结构；
   window.__swrHits 供 e2e 验证"缓存真的直出了"。 */
const apiCache = (() => {
  const P = 'yczxc_v1_';
  const raw = (k) => { try { return JSON.parse(localStorage.getItem(P + k)); } catch { return null; } };
  const hit = () => { window.__swrHits = (window.__swrHits || 0) + 1; };
  return {
    get(k) { const v = raw(k); if (v) { hit(); return v.d; } return null; },
    fresh(k, ttl) { const v = raw(k); if (v && v._t && Date.now() - v._t < ttl) { hit(); return v.d; } return null; },
    set(k, d) { try { localStorage.setItem(P + k, JSON.stringify({ _t: Date.now(), d })); } catch { /* 配额满就算了 */ } },
  };
})();

/* /api/config 全页共享：一次会话内每个页面只发一次。
   原来首页/投稿页自己 fetch 一份、人机校验再 fetch 一份；现在统一走
   siteConfig() 的单例 Promise，多处的调用合并成一次网络往返。
   v3.6.1 起带 60 秒本地缓存（留存加载）：二次打开零网络往返；
   代价是管理员切主题后，老访客最迟 60 秒内跟进（首次访问即时生效）。 */
let siteConfigPromise = null;
const siteConfig = () => { if(siteConfigPromise) return siteConfigPromise;
  const cached = apiCache.fresh('config', 60000);
  siteConfigPromise = cached
    ? Promise.resolve(cached)
    : api('/api/config',{quiet401:true}).then(d=>{apiCache.set('config',d);return d;}).catch(()=>null);
  return siteConfigPromise; };
async function clientConfig(){if(!recaptchaConfig||!powConfig){const d=(await siteConfig())||{};recaptchaConfig=d.recaptcha||{enabled:false};powConfig=d.pow||{enabled:false};}return{recaptcha:recaptchaConfig,pow:powConfig};}
/* 站点主题：后台「主题」页设置的全站外观，存服务端（system_settings 表）。
   先用 localStorage 缓存值即时上色（防刷新闪回默认），再用服务端真值纠正 ——
   管理员换主题后，所有访客下一次打开任何页面就是新主题。
   五套键位（MD3 项目 决策 2）：'' 默认 / mono 黑白 / mint 薄荷青 /
   beige 暖米棕 / lavender 薰衣草浅紫；个人口令用户另有"个人主题"叠加在上，
   见 applyPersonalTheme（个人优先级更高，仅本人生效）。
   校徽（ico.svg）与公安备案徽标是独立图片，主题变量不作用于图片，任何主题下保持原样。 */
const SITE_THEME_KEYS=['','mono','mint','beige','lavender','marrs','klein','cream','gold','taro','xuan'];
/* 预设主题卡片元数据：后台「主题」页与个人偏好页共用。
   4.0.0：旧五套保留 + 参考图六套（后三套是深色）。 */
const THEME_PRESETS=[
  {key:'',name:'默认主题',desc:'冷调蓝，白天浅色、夜间跟随系统深色。',swatch:['#FFFFFF','#E5E7EB','#2563EB','#111827']},
  {key:'mono',name:'黑白主题',desc:'白纸黑字的单色观感，不含彩色；校徽保持原样。',swatch:['#FFFFFF','#E4E4E4','#141414','#0A0A0A']},
  {key:'mint',name:'薄荷青主题',desc:'低饱和清新青，柔和干净，卡片浅青底色。',swatch:['#F2FAF7','#E3F4EE','#0B8571','#12332C']},
  {key:'beige',name:'暖米棕主题',desc:'暖米色背景，低饱和棕强调色，柔和护眼，安静氛围感。',swatch:['#FAF5EC','#F1E7D6','#8F6238','#3A2E22']},
  {key:'lavender',name:'薰衣草浅紫主题',desc:'低饱和淡紫色，浅灰紫卡片，柔和不艳俗。',swatch:['#F7F5FC','#ECE7F8','#7565B0','#2F2A44']},
  {key:'marrs',name:'马尔斯绿 × 玫瑰粉',desc:'墨绿主色配玫瑰粉点缀，清爽、安静，适合白天。',swatch:['#F4FBF9','#CFE8E3','#01847F','#F9D2E4']},
  {key:'klein',name:'克莱因蓝 × 蒂芙尼蓝',desc:'高饱和克莱因蓝主色，蒂芙尼蓝作点缀，校园广播的经典蓝。',swatch:['#F3F6FF','#D6E2FF','#002CB0','#66D4C8']},
  {key:'cream',name:'奶油黄 × 薰衣草',desc:'奶油黄底配薰衣草紫，柔和暖调，适合长时间阅读。',swatch:['#FFFEF0','#F0EBD0','#7B5FA6','#BE96CD']},
  {key:'gold',name:'荣耀金 × 曜石黑',desc:'深色主题：曜石黑底、荣耀金强调，舞台与电台的质感。',swatch:['#000000','#2A2A2A','#FFD700','#FFF8DC']},
  {key:'taro',name:'香芋紫 × 墨黑',desc:'深色主题：墨黑底配香芋紫，安静、低刺激，夜间友好。',swatch:['#0B0C10','#2A2B36','#C98EFF','#F3E9FF']},
  {key:'xuan',name:'玄青 × 燕领红',desc:'深色主题：玄青灰底配燕领红，克制但有力量。',swatch:['#1E1E1E','#3A3A3A','#FC6315','#FFF1E8']},
];
function applySiteTheme(t){t=SITE_THEME_KEYS.includes(t)?t:'';if(t)document.documentElement.dataset.theme=t;else delete document.documentElement.dataset.theme;try{localStorage.setItem('site_theme',t);}catch{}}
(async()=>{try{applySiteTheme(localStorage.getItem('site_theme')||'');const d=await siteConfig();applySiteTheme(d&&typeof d.theme==='string'?d.theme:'');}catch{}})();
/* 个人主题（MD3 项目 决策 11~14，仅个人口令用户）：预设复用同一套 data-theme
   CSS；自定义配色把 4 个颜色写成 <html> 行内变量（优先级最高，天然盖住预设）。
   与全局主题的关系：先全局后个人、个人优先；没保存过就跟随全局。
   下面的 IIFE 用本地缓存先上色（防刷新闪回），真值由 session() 后的
   syncPersonalTheme 校正。对比度公式与后端 /api/prefs 一致（4.5:1 双组）。 */
function personalLum(hex){const n=parseInt(String(hex).slice(1),16);const c=[(n>>16)&255,(n>>8)&255,n&255].map(v=>{const x=v/255;return x<=0.03928?x/12.92:Math.pow((x+0.055)/1.055,2.4);});return 0.2126*c[0]+0.7152*c[1]+0.0722*c[2];}
function personalContrast(a,b){const l1=personalLum(a),l2=personalLum(b);const hi=Math.max(l1,l2),lo=Math.min(l1,l2);return (hi+0.05)/(lo+0.05);}
const personalMix=(a,b,t)=>{const pa=[1,3,5].map(i=>parseInt(a.slice(i,i+2),16)),pb=[1,3,5].map(i=>parseInt(b.slice(i,i+2),16));return '#'+pa.map((v,i)=>Math.round(v+(pb[i]-v)*t).toString(16).padStart(2,'0')).join('');};
const PERSONAL_VARS=['--primary','--primary-hover','--primary-soft','--on-primary','--title','--secondary','--muted','--page','--card','--line','--line-soft','--fill','--fill-strong','--nav-active','--track','--outline','--focus-ring'];
function clearPersonalVars(){const s=document.documentElement.style;for(const k of PERSONAL_VARS)s.removeProperty(k);s.colorScheme='';}
function applyPersonalTheme(p){const root=document.documentElement;if(!p)return;
  if(p.mode==='custom'&&p.colors&&/^#[0-9a-fA-F]{6}$/.test(String(p.colors.primary||''))){
    const c=p.colors;clearPersonalVars();delete root.dataset.theme;
    const darkText=personalLum(c.text)<personalLum(c.bg);
    const s=root.style;
    s.setProperty('--primary',c.primary);
    s.setProperty('--primary-hover',personalMix(c.primary,'#000000',0.14));
    s.setProperty('--primary-soft',personalMix(c.primary,'#FFFFFF',0.86));
    s.setProperty('--on-primary',personalLum(c.primary)<0.4?'#FFFFFF':'#111827');
    s.setProperty('--page',c.bg);
    s.setProperty('--card',c.card);
    s.setProperty('--body',c.text);
    s.setProperty('--title',darkText?personalMix(c.text,'#000000',0.3):personalMix(c.text,'#FFFFFF',0.3));
    s.setProperty('--secondary',personalMix(c.text,c.bg,0.35));
    s.setProperty('--muted',personalMix(c.text,c.bg,0.55));
    s.setProperty('--line',personalMix(c.card,c.text,0.18));
    s.setProperty('--line-soft',personalMix(c.card,c.text,0.08));
    s.setProperty('--fill',personalMix(c.card,c.text,0.06));
    s.setProperty('--fill-strong',personalMix(c.card,c.text,0.12));
    s.setProperty('--nav-active',personalMix(c.primary,'#FFFFFF',0.88));
    s.setProperty('--track',personalMix(c.card,c.text,0.06));
    s.setProperty('--outline',personalMix(c.card,c.text,0.24));
    s.setProperty('--focus-ring','0 0 0 3px '+c.primary+'29');
    s.colorScheme=personalLum(c.bg)<0.4?'dark':'light';
    return;
  }
  clearPersonalVars();
  const preset=SITE_THEME_KEYS.includes(String(p.preset||''))?String(p.preset||''):'';
  if(preset)root.dataset.theme=preset;else delete root.dataset.theme;
}
(async()=>{try{const meCached=sessionCached();if(meCached&&meCached.personal)applyPersonalTheme(apiCache.get('prefs'));}catch{}})();
/* 页面预取（v3.6.1）：进站空闲时把前台三个页面提前拉进 HTTP 缓存，
   点导航时省一次整页下载（JS/CSS 早已长缓存，剩下的延迟主要就是文档本身）。
   浏览器开了"省流"或 2G 类慢网时不做，别跟学生抢流量；后台页签切换不换页，无此需求。 */
try{
  const conn=navigator.connection;
  if(!(conn&&(conn.saveData||/^(slow-)?2g$/.test(conn.effectiveType||'')))){
    /* Chromium 系用 Speculation Rules（预取优先级更高、保留更久）；其它浏览器忽略不报错 */
    const sr=document.createElement('script');sr.type='speculationrules';
    sr.textContent=JSON.stringify({prefetch:[{source:'list',urls:['/vote','/schedule','/suggest','/preferences'],eagerness:'moderate'}]});
    document.head.append(sr);
    const idle=window.requestIdleCallback||((fn)=>setTimeout(fn,1500));
    idle(()=>{for(const u of ['/vote','/schedule','/suggest','/preferences']){const l=document.createElement('link');l.rel='prefetch';l.href=u;document.head.append(l);}});
  }
}catch{}
/* 人机校验的两个外域提前握手（DNS+TLS）：真到投稿/投票提交那一刻，
   recaptcha 脚本不用再从零建连接 —— 第一次提交能快好几秒。 */
(async()=>{try{const c=await siteConfig();if(c&&c.recaptcha&&c.recaptcha.enabled){
  for(const h of [c.recaptcha.base||'https://www.recaptcha.net','https://www.gstatic.cn']){
    const l=document.createElement('link');l.rel='preconnect';l.href=h;l.crossOrigin='';document.head.append(l);
  }
}}catch{}})();
async function recaptchaToken(action){return withVerification(async()=>{const{recaptcha:c}=await clientConfig();if(!c.enabled||!c.siteKey)return'';try{if(!window.grecaptcha)await new Promise((resolve,reject)=>{const s=document.createElement('script');s.src=(c.base||'https://www.recaptcha.net')+'/recaptcha/api.js?render='+encodeURIComponent(c.siteKey);s.onload=resolve;s.onerror=reject;document.head.append(s);setTimeout(()=>reject(Error('timeout')),6000);});return await Promise.race([new Promise(resolve=>grecaptcha.ready(()=>grecaptcha.execute(c.siteKey,{action}).then(resolve))),new Promise(resolve=>setTimeout(()=>resolve(''),5000))])||'';}catch{return'';}});}
async function powProof(action){return withVerification(async()=>{const{pow:p}=await clientConfig();if(!p.enabled||!crypto.subtle)return null;try{let cid=localStorage.getItem('vote2_pow_cid');if(!cid||!/^[A-Za-z0-9_-]{8,64}$/.test(cid)){cid=crypto.randomUUID().replaceAll('-','');localStorage.setItem('vote2_pow_cid',cid);}const r=await api(`/api/pow?action=${encodeURIComponent(action)}&cid=${encodeURIComponent(cid)}`);if(!r.enabled||!r.challenge)return null;const work=r.challenge.split('.')[4];if(!work)return null;const enc=new TextEncoder(),target='0'.repeat(Number(r.difficulty)||0),until=Date.now()+10000;for(let nonce=0;Date.now()<until;nonce++){const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(`${work}:${nonce}`)));let hex='';for(const b of hash){hex+=b.toString(16).padStart(2,'0');if(hex.length>=target.length)break;}if(hex.startsWith(target))return{challenge:r.challenge,nonce:String(nonce)};if(nonce%1500===0)await new Promise(resolve=>setTimeout(resolve,0));}return null;}catch{return null;}});}

async function bootGate(){
  const form=$('#gateForm'), msg=$('#gateMessage'), input=$('#gatePassword');
  input.focus();
  form.addEventListener('submit',async e=>{
    e.preventDefault();
    const b=$('button[type=submit]',form);
    b.disabled=true;msg.textContent='正在验证…';
    try{
      /* 4.0.0：正式登录必须带姓名。设备-姓名绑定在服务端登录时落库，
         所以这里把设备指纹一起送过去（拿不到指纹也不阻断，服务端会跳过绑定）。 */
      const [recaptcha_token,fp]=await Promise.all([recaptchaToken('login'),fingerprint().catch(()=> '')]);
      const d=await api('/api/login',{method:'POST',quiet401:true,body:JSON.stringify({password:input.value,recaptcha_token,fingerprint:fp||''})});
      sessionStorage.setItem('className',d.class_name||'');
      if(d.need_name){
        /* 用户 2026-10-17 确认：纯班级口令给两个选择——
           回登录页重输（留在本页、清空输入框），或以游客身份进入只读浏览。 */
        const retry=await uiDialog({
          title:'需要姓名登录',
          message:'正式登录需要「班级口令@姓名」。\n按「重新输入」回到登录框；按「游客浏览」以只读身份进入，不能投票、投稿或举报。',
          ok:'重新输入',
          cancel:'游客浏览',
        });
        if(retry){input.value='';input.focus();msg.textContent='请用「班级口令@姓名」重新登录';return;}
      }
      location.href='/';
    }catch(err){msg.textContent=err.message;}finally{b.disabled=false;}
  });
}
async function session(){ /* v3.6.2 me 直出：成功的身份存本地，下次打开先按它渲染、再后台校正
  （未登录/会话失效时 api 层的 401 流程照旧弹"登录已过期"；直出只是省掉"等 me 回来才敢画页面"的空白）。
  拿到 401 时把缓存清成 null：否则每次打开都会先闪一下已登录界面、再弹一次过期框。 */
  try{const me=await api('/api/me',{quiet401:true});window.__me=me;apiCache.set('me',me);if(me&&me.personal)void syncPersonalTheme();return me;}catch{try{apiCache.set('me',null);apiCache.set('prefs',null);}catch{}return null;} }
/* 个人主题同步（MD3 项目）：把本人配色拉回来应用；60 秒内用本地缓存（留存加载同款机制），
   拿不到就维持当前外观（全局主题照常）。 */
async function syncPersonalTheme(){try{const cached=apiCache.fresh('prefs',60000);if(cached){applyPersonalTheme(cached);return;}const d=await api('/api/prefs',{quiet401:true});apiCache.set('prefs',d);applyPersonalTheme(d);}catch{}}
/** 上次成功拿到、且不太旧（24 小时）的身份 —— 用于首屏直出，不发给服务端。 */
function sessionCached(){return apiCache.fresh('me',24*3600*1000);}
/* 首屏直出：有缓存身份就先按它画（零等待），返回 true；没有就让调用方照旧 await。 */
function paintNavFromCachedMe(){const me=sessionCached();if(!me)return null;window.__me=me;return me;}
/* 班级/全站上限的**体验层**预判：打开页面就知道还能不能投/能不能投稿。
   服务端在 vote / upvote 接口里有同样的闸门 —— 这里只是为了别让学生
   填完表单才吃一个 403。kind='vote' 看投票侧，kind='submit' 看投稿侧。 */
function classBlockReason(kind){
  const me=window.__me||{};
  const L=me.limits;
  if(L){
    if(L.paused)return'本班级已被暂停投稿与投票，请联系广播站管理员';
    if(kind==='vote'&&L.voteLimit>0&&L.voteUsed>=L.voteLimit)return'本班级参与投票人数已达上限，暂时无法继续投票';
    if(kind==='submit'&&L.submitLimit>0&&L.submitUsed>=L.submitLimit)return'本班级投稿数量已达上限，暂时无法继续投稿';
  }
  const g=me.globalSubmit;
  if(kind==='submit'&&g&&g.cap>0&&g.used>=g.cap)return'站点投稿总数量已达上限，暂无法提交投稿';
  return'';
}
function nav(name){const guest=document.body.classList.contains('guest-mode');const link=(href,label,cls='')=>`<a class="btn${cls}" href="${href}">${label}</a>`;const submit=guest?'':link('/vote','投稿一首',' primary');const home=link('/','返回首页');const sched=link('/schedule','本周排期');const suggest=link('/suggest','版本建议');
  /* 「个性化」（MD3 项目 决策 10）：仅个人口令用户可见，PC 端位于「本周排期」与
     「版本建议」之间；移动端它在 .nav-links 里，随既有抽屉机制自动收进侧边菜单。 */
  const me0=window.__me||{};const personalLink=(me0&&me0.personal&&me0.personal.username)?link('/preferences','个性化'):'';
  const sets={home:[submit,sched,personalLink,suggest],vote:[home,sched,personalLink,suggest],schedule:[submit,home,personalLink,suggest],suggest:[submit,sched,personalLink,home],preferences:[submit,home,sched,suggest],admin:[home,sched,suggest]};const links=(sets[name]||sets.home).filter(Boolean).join('');
  /* 移动端（≤768px）：汉堡按钮 + 抽屉式侧边导航（.actions 整块变成抽屉，遮罩在其下）。
     桌面端这三个新元素全部 display:none，DOM 多了几项、画面一字不变。 */
  return `<header class="topbar"><button class="nav-burger" type="button" data-burger aria-label="打开导航" aria-expanded="false"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/></svg></button><a class="brand" href="/"><img class="brand-mark" src="/assets/ico.svg" alt="盐中之声徽标"><div><strong>盐中之声</strong><small>RadioLight</small></div></a><div class="actions"><button class="btn quiet nav-drawer-close" type="button" data-nav-close aria-label="收起导航">关闭</button><nav class="nav-links">${links}</nav><button class="btn quiet" data-logout>退出</button></div><div class="nav-backdrop" data-nav-backdrop aria-hidden="true"></div></header>`;}
/** 身份行的统一画法（me 直出与真值共用；游客要一眼看出、暂停要当场说明）。 */
function paintIdentity(me){let t=me.className||'已登录';if(me.isGuest)t='【游客状态】游客模式 · 只能浏览与试听';else{if(me.personal&&me.personal.username)t=t+' · '+me.personal.username;/* 个人口令身份后缀（决策 13） */if(me.limits&&me.limits.paused)t=t+'（班级已暂停投稿与投票）';}$('#identity').textContent=t;if(me.isGuest){const g=$('#guest');if(g){g.hidden=false;g.innerHTML='【游客状态】可以浏览榜单和试听，但不能投稿、投票或举报。 <a href="/login">用「班级口令@姓名」重新登录</a>';}}}
async function home(){
  const root=$('#app');
  /* v3.6.2 me 直出：上次成功登录过的话，先按缓存身份把外壳画出来（零等待），
     真正的 /api/me 在后台跑 —— 网络慢时学生也是"立刻看到页面"而不是干等。
     me 回来后重画一遍校正（身份基本不变，等于无感）；未登录/过期时照旧跳发布页/弹续登。 */
  const cached=paintNavFromCachedMe();
  const mePromise=session();
  if(cached){
    root.hidden=false;document.body.classList.toggle('guest-mode',cached.isGuest);$('#nav').innerHTML=nav('home');$('[data-logout]').onclick=logout;
    paintIdentity(cached);
  }
  const me=await mePromise;
  if(!me){
    // 未登录：送去发布页；若站点是"分文件没传全"的状态（缺 landing/login），
    // 也要给出看得懂的提示，而不是白屏或点了没反应。
    const exists=async(u)=>{try{const r=await fetch(u,{method:'HEAD'});return r.ok;}catch{return false;}};
    if(await exists('/landing')){location.replace('/landing');return;}
    if(await exists('/login')){location.replace('/login');return;}
    document.body.innerHTML='<div class="shell"><div class="gate" style="margin:48px auto;max-width:520px"><h1>站点部署不完整</h1><p>缺少 landing.html / login.html：本次是"发布页 + 登录页"新结构，请把交付包里的<strong>全部</strong>文件一起上传（共 8 个 html + assets/css/app.css + assets/js/app.js）。</p></div></div>';
    return;
  }
  root.hidden=false;document.body.classList.toggle('guest-mode',me.isGuest);$('#nav').innerHTML=nav('home');$('[data-logout]').onclick=logout;
  paintIdentity(me);
  const voteBlock=classBlockReason('vote');if(voteBlock)window.__voteBlockReason=voteBlock;
  /* 投稿须知与免责声明固定在页面底部（与电脑端同一份 DOM、同一个位置）。
     2026-10-10 曾把手机端的这两个折叠块搬进抽屉菜单，但用户反馈在抽屉里
     点开后再点别的就"消失"了（节点跟着抽屉收起）—— 2026-10-11 按用户要求
     撤销搬动，恢复为页面最底部的静态折叠块，任何视口都不再挪动。 */
  /* v3.6.1 留存加载：榜单缓存先直出（不 await、不等网络），公告/配置并发取，
     全部完成后再做入场动效。弹窗公告也不再挡住榜单 —— 原来要点完「知道了」才渲染列表。 */
  const ranksDone=loadRanks();
  const annJob=(async()=>{const c=apiCache.fresh('ann_app',300000);if(c)return c;try{const d=await api('/api/announcements');apiCache.set('ann_app',d);return d;}catch{return{announcements:[],popups:[]};}})();
  const [cfg,ads]=await Promise.all([siteConfig().then(x=>x||{}),annJob]);if(cfg.submit?.paused){$('#pausedNotice').hidden=false;}
  const adList=ads.announcements||[];$('#announcements').innerHTML=adList.length?('<div class="section-title"><h2>广播站公告</h2></div>'+adList.map(a=>`<article class="announcement"><p class="kicker">广播站公告</p><h3>${esc(a.title)}</h3><p>${esc(a.content)}</p></article>`).join('')):'';for(const a of ads.popups||[]){if(sessionStorage.getItem('popup_'+a.id))continue;await announceDialog(a.title,a.content);sessionStorage.setItem('popup_'+a.id,'1');}await ranksDone;reveal($$('.panel,.hero,.announcement'));
}
async function loadGateAnnouncements(){try{const d=await api('/api/announcements?scope=gate');$('#gateAnnouncements').innerHTML=(d.announcements||[]).map(a=>`<article class="announcement"><b>${esc(a.title)}</b><p>${esc(a.content)}</p></article>`).join('');}catch{}}
/* 4.0.0：榜单默认只展示前 6 首，底部展开/收起；状态按“待审核/正式曲库”各自记住。 */
const RANK_PAGE_SIZE=6;
const rankExpanded={pending:false,approved:false};
async function loadRanks(fresh){/* 留存加载（v3.6.1）：上一次的榜单先直出（零等待），再并发取最新替换；绑定保持原样。
  v3.6.2：接口在边缘有 20 秒缓存，投票/举报后的重拉带 fresh=true 追加 `?_=时间戳`
  —— publicCache 见到 `_` 会退回 no-store，票数即时可见（平时的浏览走缓存，20ms 级）。 */
  const bust=fresh?('&_='+Date.now()):'';
  const guestMode=document.body.classList.contains('guest-mode');const voteBlock=window.__voteBlockReason||classBlockReason('vote');const voteAttr=guestMode?'disabled title="游客状态：只能浏览与试听"':(voteBlock?`disabled title="${esc(voteBlock)}"`:'');
  const bindSongActions=()=>{$$('[data-vote]').forEach(b=>b.onclick=()=>vote(b.dataset.vote));$$('[data-report]').forEach(b=>b.onclick=()=>reportSong(b.dataset.report));$$('[data-preview]').forEach(b=>b.onclick=()=>preview(b.dataset.preview,b.dataset.title,b.dataset.artist,$(`#player-${b.dataset.song}`)));};
  const renderBox=(status,rows)=>{
    const box=$(`#${status}List`);if(!box)return;
    const all=Array.isArray(rows)?rows:[];
    const open=!!rankExpanded[status];
    const shown=open?all:all.slice(0,RANK_PAGE_SIZE);
    box.innerHTML=shown.length?shown.map(song=>`<article class="song"><div><h3>${esc(song.title)}</h3><p>${esc(song.artist)} · ${esc(song.category_name||'音乐')}</p><div class="song-actions">${status==='pending'?`<button class="btn" data-vote="${song.id}" ${voteAttr}><span data-vote-label>支持这首</span></button><button class="btn" data-report="${song.id}" ${guestMode?'disabled title="游客状态：只能浏览与试听"':''}>举报</button>`:''}<button class="btn quiet" data-preview="${esc(song.track_id||'')}" data-song="${song.id}" data-title="${esc(song.title)}" data-artist="${esc(song.artist||'')}">试听</button></div><div class="inline-player" id="player-${song.id}"></div></div><div class="song-side">${status==='pending'?`<span class="votes">${Number(song.votes||0)} 票</span>`:'<span class="muted">正式曲库</span>'}</div></article>`).join(''):'<p class="muted">目前还没有曲目，等你来点亮榜单。</p>';
    if(all.length>RANK_PAGE_SIZE){
      const more=document.createElement('div');more.className='list-more';
      const btn=document.createElement('button');btn.type='button';btn.className='btn quiet';btn.dataset.expand=status;btn.setAttribute('data-expand',status);
      btn.textContent=open?`收起，只看前 ${RANK_PAGE_SIZE} 首`:`展开全部（共 ${all.length} 首）`;
      btn.onclick=()=>{stopAllPlayers();rankExpanded[status]=!open;renderBox(status,all);};
      more.append(btn);box.append(more);
    }
    bindSongActions();
  };
  const cached={pending:apiCache.get('rank_pending'),approved:apiCache.get('rank_approved')};
  for(const s of ['pending','approved'])if(cached[s])renderBox(s,cached[s]);
  const fetched=await Promise.all(['pending','approved'].map(async status=>{try{const d=await api(`/api/rank?status=${status}${bust}`);const rows=Array.isArray(d)?d:[];apiCache.set('rank_'+status,rows);return{status,rows,err:null};}catch(e){return{status,rows:null,err:e};}}));
  for(const f of fetched){if(f.rows){renderBox(f.status,f.rows);continue;}if(!cached[f.status]){const box=$(`#${f.status}List`);if(box)box.innerHTML=`<p class="message">${esc(f.err.message)}</p>`;}}$$('[data-rank-tab]').forEach(b=>b.onclick=()=>{$$('[data-rank-tab]').forEach(t=>t.classList.toggle('active',t===b));$$('[data-rank-panel]').forEach(p=>p.hidden=p.dataset.rankPanel!==b.dataset.rankTab);});}
async function reportSong(id){if(!await uiConfirm('确认举报这首歌曲？',{title:'举报歌曲',ok:'确认举报'}))return;try{const[fp,recaptcha_token]=await Promise.all([fingerprint(),recaptchaToken('report')]);await api('/api/report',{method:'POST',body:JSON.stringify({id:Number(id),reason:'',fingerprint:fp,client_id:fp,recaptcha_token})});toast('举报已提交');}catch(e){toast(e.message);}}
async function preview(track,title,artist,container){if(!container)return;stopAllPlayers();container.innerHTML='<span class="muted">正在准备试听…</span>';try{let id=track;if(!id){const d=await api(`/api/music?q=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}`);id=(d.results||[]).find(x=>x.id)?.id;}if(!id){container.innerHTML='<span class="muted">没有可试听的音源</span>';return;}const check=await api(`/api/music?check=${encodeURIComponent(id)}`);if(check.playable===false){container.innerHTML='<span class="muted">该版本暂时无法试听</span>';return;}container.innerHTML=`<audio controls autoplay preload="none" src="/api/music?play=${encodeURIComponent(id)}"></audio>`;registerPlayer(container.querySelector('audio'));}catch(e){container.innerHTML=`<span class="message">${esc(e.message)} <button class="btn" data-retry>重试</button></span>`;container.querySelector('[data-retry]').onclick=()=>preview(track,title,artist,container);}}
async function vote(id){const block=classBlockReason('vote');if(block){toast(block);return;}const b=$(`[data-vote="${id}"]`);if(b){b.disabled=true;b.querySelector('[data-vote-label]').textContent='正在提交…';}try{const[fp,recaptcha_token,pow]=await Promise.all([fingerprint(),recaptchaToken('upvote'),powProof('upvote')]);const r=await api('/api/upvote',{method:'POST',body:JSON.stringify({id:Number(id),fingerprint:fp,client_id:fp,recaptcha_token,pow,request_id:crypto.randomUUID?.()||String(Date.now())})});toast(r.duplicate?'这次投票已记录，没有重复计票':'投票成功');await loadRanks(true);/* 自己的票要立刻看到：绕开边缘缓存 */}catch(e){toast(e.message);}finally{if(b&&b.isConnected){b.disabled=false;b.querySelector('[data-vote-label]').textContent='支持这首';}}}
async function logout(){try{apiCache.set('me',null);apiCache.set('prefs',null);}catch{}/* 主动退出也要清掉直出缓存（含个人配色），否则回首页会先闪已登录界面 *//* 4.0.0：只退学生会话，不影响同一浏览器里的后台登录 */await fetch('/api/logout?subject=class',{method:'POST',credentials:'same-origin'});location.href='/';}
/* 后台退出：只退管理员会话，回后台登录页；不碰学生身份。 */
async function adminLogout(){try{apiCache.set('me',null);apiCache.set('prefs',null);}catch{}await fetch('/api/logout?subject=admin',{method:'POST',credentials:'same-origin'});location.href='/admin7318434';}
function renderTrackChoices(tracks,container,onPick){container.innerHTML=tracks.map((x,i)=>`<article class="song track-option"><div><b>${esc(x.name||x.title)}</b><small class="muted">${esc(x.artist||'未知歌手')} · ${esc(x.album||'')}</small><div class="song-actions"><button class="btn primary" type="button" data-pick="${i}">选择此版本</button><button class="btn quiet" type="button" data-track-preview="${i}">试听版本</button></div><div id="result-player-${i}"></div></div><span class="muted">${esc(x.source||'')}${x.duration?` · ${Math.floor(x.duration/60)}:${String(x.duration%60).padStart(2,'0')}`:''}${x.playable===false?' · 暂不可播':x.playable===true?' · 可试听':''}</span></article>`).join('');$$('[data-pick]',container).forEach(b=>b.onclick=()=>onPick(tracks[Number(b.dataset.pick)]));$$('[data-track-preview]',container).forEach(b=>b.onclick=()=>{const x=tracks[Number(b.dataset.trackPreview)];preview(x.id,x.name||x.title,x.artist,$(`#result-player-${b.dataset.trackPreview}`,container));});}
async function votePage(){
  $('#nav').innerHTML=nav('vote');$('[data-logout]').onclick=logout;
  const me=await session();if(!me){location.href='/';return;}
  /* 游客也能打开投稿页浏览曲目与试听，但提交按钮置灰 —— 需求只要求
     "写入类功能禁用、按钮置灰"，不再把游客一脚踢回首页。 */
  document.body.classList.toggle('guest-mode',me.isGuest);
  const submitBlock=classBlockReason('submit');
  const cfg=(await siteConfig())||{};if(cfg.submit?.paused){$('#voteMessage').textContent='广播站现在暂停接收投稿。';$('#submitPaused').hidden=false;$('#submitForm button[type=submit]').disabled=true;}
  const submitBtn=$('#submitForm button[type=submit]');
  if(me.isGuest){submitBtn.disabled=true;submitBtn.title='游客状态：只能浏览与试听，不能投稿';if(!cfg.submit?.paused)$('#voteMessage').textContent='当前是【游客状态】：可以浏览与试听，不能投稿。';}
  else if(submitBlock){submitBtn.disabled=true;submitBtn.title=submitBlock;if(!cfg.submit?.paused)$('#voteMessage').textContent=submitBlock+'。';}
  $('#category').innerHTML=(cfg.categories||[]).map(c=>`<option value="${Number(c.id)}">${esc(c.name)}</option>`).join('');
  const form=$('#submitForm'),search=$('#searchForm'),results=$('#results'),dialog=$('#trackDialog'),message=$('#searchMessage');
  $('[data-close-track-dialog]').onclick=()=>dialog.close();dialog.addEventListener('click',e=>{if(e.target===dialog)dialog.close();});
  /* 弹窗一关就把试听停掉：原生 <audio> 不随弹窗隐藏暂停，不这样做会"关了还在放"。 */
  dialog.addEventListener('close',()=>stopAllPlayers());
  search.addEventListener('submit',async e=>{e.preventDefault();const query=$('#query').value.trim();message.textContent='正在搜索歌曲…';try{const d=await api('/api/music?q='+encodeURIComponent(query)),tracks=d.results||[];if(!tracks.length){message.textContent='没有找到歌曲，请换个关键词试试。';return;}message.textContent=`找到 ${tracks.length} 个版本，请在弹窗中选择。`;$('#trackDialogQuery').textContent=`搜索：${query}`;renderTrackChoices(tracks,results,x=>{form.__selected=x;$('#picked').textContent=`已选择：${x.name||x.title} · ${x.artist||''}`;message.textContent='已选择版本，可以提交投稿。';dialog.close();});dialog.showModal();}catch(err){message.textContent=err.message;}});
  form.addEventListener('submit',async e=>{e.preventDefault();const block=classBlockReason('submit');if(block){$('#voteMessage').textContent=block+'。';return;}const x=form.__selected;if(!x){$('#voteMessage').textContent='请先搜索并选择一首歌曲';return;}try{const[fp,recaptcha_token,pow]=await Promise.all([fingerprint(),recaptchaToken('vote'),powProof('vote')]);await api('/api/vote',{method:'POST',body:JSON.stringify({title:x.name||x.title,artist:x.artist||'',track_id:x.id,category_id:Number($('#category').value),track_token:x.track_token||x.token||'',fingerprint:fp,client_id:fp,recaptcha_token,pow,request_id:crypto.randomUUID?.()||String(Date.now())})});toast('投稿成功，等待审核');setTimeout(()=>location.href='/',900);}catch(err){$('#voteMessage').textContent=err.message;}});
}
async function suggestionsPage(){const me=await session();if(!me){location.href='/';return;}document.body.classList.toggle('guest-mode',me.isGuest);$('#nav').innerHTML=nav('suggest');$('[data-logout]').onclick=logout;const search=$('#suggestSearch'),results=$('#suggestResults'),form=$('#suggestForm');if(me.isGuest){$('#suggestMessage').textContent='当前是【游客状态】：可以浏览，不能提交建议。';form.hidden=true;}search.onsubmit=async e=>{e.preventDefault();try{const d=await api('/api/rank?status=pending');const q=$('#suggestQuery').value.trim().toLowerCase(),rows=(Array.isArray(d)?d:[]).filter(s=>`${s.title} ${s.artist}`.toLowerCase().includes(q));results.innerHTML=rows.map(s=>`<button class="song" type="button" data-select-suggest="${s.id}" data-title="${esc(s.title)}" data-artist="${esc(s.artist)}"><span><b>${esc(s.title)}</b><small class="muted">${esc(s.artist)}</small></span><span>选择</span></button>`).join('')||'<p class="muted">榜单中没有匹配歌曲。</p>';$$('[data-select-suggest]').forEach(b=>b.onclick=()=>{form.dataset.songId=b.dataset.selectSuggest;$('#suggestPicked').textContent=`已选择：${b.dataset.title} · ${b.dataset.artist}`;});}catch(err){results.innerHTML=`<p class="message">${esc(err.message)}</p>`;}};form.onsubmit=async e=>{e.preventDefault();if(!form.dataset.songId)return;try{const recaptcha_token=await recaptchaToken('suggest');await api('/api/suggest',{method:'POST',body:JSON.stringify({song_id:Number(form.dataset.songId),content:$('#suggestContent').value,recaptcha_token})});$('#suggestMessage').textContent='版本建议已提交。';form.reset();delete form.dataset.songId;}catch(err){$('#suggestMessage').textContent=err.message;}};}
/* 排期页共用的小工具：把 ISO 日期说成人话（"10月5日"）。用户反馈排期页的
   原始日期与"该周"这类说法不好懂 —— 前台与后台的周标题统一在这里生成。 */
const cnDay=(iso)=>{const d=new Date(iso+'T00:00:00Z');return (d.getUTCMonth()+1)+'月'+d.getUTCDate()+'日';};
const cnRange=(w)=>cnDay(w.weekStart)+'至'+cnDay(w.weekEnd);
async function schedule(){ $('#nav').innerHTML=nav('schedule'); $('[data-logout]').onclick=logout; const box=$('#weeks');
  /* 渲染抽成 paint()：留存加载（v3.6.1）先画缓存里上一次的排期（零等待、不做动画），
     网络回来再画最新的；任何一处出错都保持与旧行为一致的报错文案。 */
  const paint=(d,revealNow)=>{ try{
    /* "今天"按中国时区（UTC+8）的日历日算，与后端 chinaToday 同一口径 ——
       按 UTC 直取的话，北京周一 0~8 点之间会把本周算成上周。 */
    const cn=new Date(Date.now()+8*3600*1000),day=cn.getUTCDay(),thisWeek=new Date(cn);thisWeek.setUTCDate(cn.getUTCDate()-(day===0?6:day-1));
    /* 排期现在是可配置的：模式（上下午都有/仅上午）+ 每时段数量。
       接口没带 schedule（老部署）时回落 3+3，与旧行为一字不差。 */
    const sc=d.schedule||{mode:'both',noonCount:3,afternoonCount:3};
    const active=sc.mode==='noon'?['noon']:['noon','afternoon'];
    const countOf=p=>Number(p==='noon'?sc.noonCount:sc.afternoonCount)||3;
    const needs=d.needsMigration?`<p class="notice">排期数据尚未初始化：${esc(d.hint||'请在数据库执行 012 迁移')}（页面先按空排期显示）</p>`:'';
    const summary=sc.mode==='noon'
      ?`广播站周一到周五中午播出 ${countOf('noon')} 首有歌词的歌（当前是「仅上午」模式，下午不播）。同一批歌一整周循环，下周一换一批新的。`
      :`广播站周一到周五播出：中午 ${countOf('noon')} 首有歌词的歌、下午 ${countOf('afternoon')} 首纯音乐，一周共 ${countOf('noon')+countOf('afternoon')} 首。同一批歌一整周循环，下周一换一批新的。`;
    const guide=`今天是 ${cnDay(cn.toISOString().slice(0,10))}（周${'日一二三四五六'[day]}）。下面从上到下：上周（已播完）、本周（正在播放）、下周（还没到）。`;
    box.innerHTML=`<p class="notice schedule-notice">${summary}${guide}</p>`+needs+(d.weeklies||[]).map((w,i)=>{const tag=i===1?'本周':i===0?'上周':'下周';const note=i===1?'正在播放':i===0?'已播完':'还没到';return `<article class="week ${i===1?'current':''}"><h2>${tag}（${esc(cnRange(w))}）<span class="muted">${note}</span></h2>${active.map(p=>`<div class="slot-title">${p==='noon'?'中午放学 · 含歌词':'下午上学 · 纯音乐'}</div>${Array.from({length:countOf(p)},(_,k)=>slot(w,p,k+1)).join('')}`).join('')}</article>`;}).join('');
    if(revealNow)reveal($$('.week'));
  }catch(e){ box.innerHTML=`<p class="message">加载排期失败：${esc(e.message)}</p>`; } };
  let ck=null;
  try{
    const cn=new Date(Date.now()+8*3600*1000),day=cn.getUTCDay(),thisWeek=new Date(cn);thisWeek.setUTCDate(cn.getUTCDate()-(day===0?6:day-1));
    const from=new Date(thisWeek);from.setUTCDate(from.getUTCDate()-7);
    ck='sched_'+from.toISOString().slice(0,10)+'_3';
    const cached=apiCache.get(ck);
    if(cached)paint(cached,false);/* 留存直出 */
    if(!cached||!apiCache.fresh(ck,90000)){/* 90 秒内视为新鲜：连网络都不发；过期则后台刷新替换 */
      const d=await api('/api/schedule?week_start='+from.toISOString().slice(0,10)+'&weeks=3');
      apiCache.set(ck,d);paint(d,true);
    }
  }catch(e){ if(!ck||!apiCache.get(ck))box.innerHTML=`<p class="message">加载排期失败：${esc(e.message)}</p>`; } }
function slot(w,p,n){const x=(w.slots||[]).find(s=>s.period===p&&Number(s.position)===n); return `<div class="slot"><b>${n}</b><div>${x?esc(x.title):'待排歌曲'}<span>${x?esc(x.artist||''):'等待管理员安排'}</span></div></div>`;}
async function admin(){ $('#nav').innerHTML=nav('admin'); document.body.classList.add('admin-page'); $$('[data-logout]').forEach(b=>b.onclick=adminLogout); const form=$('#adminLogin'), msg=$('#adminMessage');
  /* 后台侧边栏（视口宽度判定，不看设备型号）：
     ≤768px  —— #adminTabs 这一**同一个节点**搬进顶栏抽屉（完全复用前台抽屉交互），
                抽屉即「后台专属菜单」：页签在最上，前台三个链接挪到页签之后（CSS order）；
     >768px  —— 搬回 .admin-layout 原位（≥1024 是固定侧栏，769~1024 由 CSS 同样分栏）。
     只搬动 + 切 class，不复制 DOM、不新增元素；从窄拉宽越过 768 时顺手关掉抽屉。 */
  if(!window.__adminDrawerWired){
    window.__adminDrawerWired=true;
    const tabs=$('#adminTabs');
    if(tabs){
      const anchor=document.createElement('span');
      anchor.hidden=true;
      tabs.parentNode.insertBefore(anchor,tabs);
      const place=()=>{
        if(matchMedia('(max-width: 768px)').matches){
          const a=document.querySelector('.topbar .actions');
          if(a&&!a.contains(tabs)){tabs.classList.add('in-drawer');a.appendChild(tabs);}
        }else{
          if(tabs.classList.contains('in-drawer')){
            tabs.classList.remove('in-drawer');
            anchor.parentNode.insertBefore(tabs,anchor);
          }
          document.body.classList.remove('nav-open');
        }
      };
      matchMedia('(max-width: 768px)').addEventListener('change',place);
      place();
    }
  }
  const enterWork=async()=>{$('#adminScreen').hidden=true;$('#adminWork').hidden=false;await adminView('pending');};
  form.addEventListener('submit',async e=>{e.preventDefault();try{await withVerification(()=>api('/api/admin-login',{method:'POST',quiet401:true,body:JSON.stringify({username:$('#adminName').value,password:$('#adminPassword').value})}));await enterWork();}catch(err){msg.textContent=err.message;}});
  $('#adminTabs').addEventListener('click',e=>{const b=e.target.closest('[data-view]');if(!b)return;$$('#adminTabs [data-view]').forEach(x=>x.classList.toggle('active',x===b));adminView(b.dataset.view);/* ≤768 抽屉形态：选中页签即收起抽屉（对齐前台"点链接即离开抽屉"的体验；桌面端 nav-open 本就不存在，无副作用） */document.body.classList.remove('nav-open');});
  $('#adminRefresh').onclick=()=>adminView($('#adminTabs .active')?.dataset.view||'pending');
  /* 会话还在就直接进工作台：注册后自动登录、或刷新页面时不用再登一次。
     探测失败（401/403，含只带学生会话的情况）才显示登录表单。
     v3.6.2 后台入口提速：探测（admin-settings）与「待审核」列表**并行发出**
     —— 原来是"先探会话、再拉列表"两段串行回源（各 0.4~2 秒，跨国链路下
     打开后台要干等两轮）；现在一轮并行搞定，列表与设置结果留给
     adminView('pending') 直接复用（见 adminList 的 bootList 分支）。 */
  try{
    const [settings,list]=await Promise.all([
      api('/api/admin-settings',{quiet401:true}),
      api('/api/admin-list?status=pending',{quiet401:true}),
    ]);
    window.__adminBootSettings=settings;
    window.__adminBootList=Array.isArray(list)?list:null;
    await enterWork();
  }catch{ window.__adminBootSettings=null;window.__adminBootList=null; } }
async function adminView(view){const titles={pending:'待审核歌曲',approved:'已通过歌曲',rejected:'回收站',schedule:'排期管理',banned:'违禁词库',settings:'系统设置',reports:'举报收件箱',announcements:'公告管理',suggestions:'版本建议',accounts:'管理员账号',invites:'管理员邀请码',members:'班级管理',classes:'班级口令管理',passes:'口令管理',theme:'主题'};$('#adminTitle').textContent=titles[view]||'管理工作台';$('#reportInbox').innerHTML='';
  /* 关键体验修复（用户反馈"切换页签时短暂残留上一个页面的内容"）：
     发请求之前先把列表区清成骨架条。各视图自己的防串台守卫只拦"迟到数据
     覆盖新页面"，拦不住"旧数据还没回来时旧内容一直挂着"——必须在这里清。 */
  $('#adminRows').innerHTML='<div class="admin-skeleton" aria-hidden="true"><div class="skel"></div><div class="skel"></div><div class="skel"></div><div class="skel"></div><div class="skel"></div></div>';
  if(['pending','approved','rejected'].includes(view))return adminList(view);if(view==='schedule')return adminSchedule();if(view==='members')return adminMembers();if(view==='classes')return adminClasses();if(view==='passes')return adminPasses();if(view==='banned')return adminBanned();if(view==='reports')return adminReports();if(view==='announcements')return adminAnnouncements();if(view==='suggestions')return adminSuggestions();if(view==='accounts')return adminAccounts();if(view==='invites')return adminInvites();if(view==='theme')return adminTheme();return adminSettings();}
/* 三个审核页签共享的内存缓存（v3.6.1 管理员提速）：
   待审核 / 已通过 / 回收站互切时先直出上一次的数据（零等待），再拉最新替换；
   第一次渲染完顺手把另外两个页签的数据预热好。审核动作成功后同步改缓存、
   把那一行就地移除，不再整列表重拉重绘 —— 审核一首歌就是一次接口往返的时间。 */
const adminRowsCache = {};
async function adminList(status){const box=$('#adminRows');
  const renderRows=(rows,cats)=>{
    /* 回收站顶部的一键清空：接口（admin-action 的 empty_recycle）本来就有，
       旧后台（admin7318434 之前的 admin.html 时代）也有入口，新前端一直没接上。
       2026-10-11 用户要求补回。清空前必须确认 —— 不可恢复。 */
    const recycleBar=status==='rejected'&&rows.length?`<div class="toolbar"><button class="btn danger" id="emptyRecycle" type="button">一键清空回收站</button><span class="muted" id="recycleCountText">回收站共 ${rows.length} 首；清空会连同投票、举报与建议记录一起永久删除，不可恢复。</span></div>`:'';
    box.innerHTML=recycleBar+(rows.length?rows.map(x=>`<article class="admin-row admin-song"><div class="admin-song-info"><b>${esc(x.title)}</b><div class="muted">${esc(x.artist)} · ${esc(x.category_name||'')} · ${Number(x.votes||0)} 票 ${x.is_reported?'· 被举报':''} ${x.playable===false?'· 当前版本无音频':''} ${x.is_debug?'· 调试投稿':''}</div><div class="song-actions"><button class="btn quiet" data-preview="${esc(x.track_id||'')}" data-song="${x.id}" data-title="${esc(x.title)}" data-artist="${esc(x.artist||'')}">试听已选版本</button>${status!=='rejected'?`<select class="input category-select" data-category-song="${x.id}">${cats.map(c=>`<option value="${c.id}" ${Number(c.id)===Number(x.category_id)?'selected':''}>${esc(c.name)}</option>`).join('')}</select><button class="btn quiet" data-update-category="${x.id}">改分类</button>`:''}</div><div class="inline-player" id="admin-player-${x.id}"></div></div><div class="actions">${status==='pending'?`<button class="btn primary" data-action="approve" data-id="${x.id}">通过</button><button class="btn quiet" data-clear-report="${x.id}">清除举报标记</button><button class="btn quiet" data-vote-detail="${x.id}" data-vote-title="${esc(x.title)}">查看具体投票</button><button class="btn" data-action="reject" data-id="${x.id}">移入回收站</button>`:status==='rejected'?`<button class="btn" data-action="restore" data-id="${x.id}">恢复</button><button class="btn danger" data-delete-song="${x.id}">彻底删除</button>`:''}${status==='approved'?`<button class="btn" data-action="reject" data-id="${x.id}">移入回收站</button><button class="btn" data-add-song="${x.id}">加入排期</button>`:''}</div></article>`).join(''):'<p class="muted">这里暂时没有歌曲。</p>');
    bindAll();
  };
  /* 就地移除：按钮立刻置灰（防连点）→ 缓存同步增删 → 行淡出消失 → 更新回收站计数与空态 */
  const removeRowLive=(btn,dest)=>{const row=btn.closest('.admin-row');if(!row)return;const id=Number(btn.dataset.id);
    row.querySelectorAll('button,select').forEach(x=>{x.disabled=true;});
    const rowData=(adminRowsCache[status]||{rows:[]}).rows.find(x=>Number(x.id)===id);
    for(const s of ['pending','approved','rejected']){const c=adminRowsCache[s];if(c)c.rows=c.rows.filter(x=>Number(x.id)!==id);}
    if(dest&&rowData){const dc=adminRowsCache[dest];if(dc)dc.rows.unshift(rowData);}
    const done=()=>{try{stopPlayersIn(row);}catch{}row.remove();const n=$('#adminRows').querySelectorAll('.admin-row').length;const rcT=$('#recycleCountText');if(rcT)rcT.textContent=`回收站共 ${n} 首；清空会连同投票、举报与建议记录一起永久删除，不可恢复。`;if(!n&&$('#emptyRecycle'))$('#emptyRecycle').remove();if(!n)box.insertAdjacentHTML('beforeend','<p class="muted">这里暂时没有歌曲。</p>');};
    if(matchMedia('(prefers-reduced-motion: reduce)').matches)done();else{row.classList.add('leaving');setTimeout(done,190);}
  };
  const bindAll=()=>{
    const emptyBtn=$('#emptyRecycle');
    if(emptyBtn)emptyBtn.onclick=async()=>{const n=adminRowsCache[status]?adminRowsCache[status].rows.length:0;if(!await uiConfirm(`清空回收站？将永久删除全部 ${n} 首歌，及其投票、举报与建议记录。此操作不可恢复。`,{title:'清空回收站',ok:'全部清空',danger:true}))return;try{const r=await api('/api/admin-action',{method:'POST',body:JSON.stringify({type:'empty_recycle'})});toast(r.deleted!=null?`回收站已清空，共删除 ${r.deleted} 首`:'回收站已清空');delete adminRowsCache[status];adminList(status);}catch(e){toast(e.message);}};
    $$('#adminRows [data-action]').forEach(b=>b.onclick=async()=>{try{await api('/api/admin-action',{method:'POST',body:JSON.stringify({type:b.dataset.action,id:Number(b.dataset.id)})});toast('操作已完成');/* 通过/移入回收站/恢复：那一行就地消失（去往的目标页签缓存同步补上），不再整列表重拉 */const dest=b.dataset.action==='approve'?'approved':b.dataset.action==='reject'?'rejected':b.dataset.action==='restore'?'pending':null;removeRowLive(b,dest);/* 待审核页的举报收件箱跟着后台刷新，不挡列表 */if(status==='pending'&&b.dataset.action!=='clear_report')renderReportInbox();}catch(e){toast(e.message);}});
    $$('#adminRows [data-add-song]').forEach(b=>b.onclick=async()=>{try{const d=await api('/api/schedule',{method:'POST',body:JSON.stringify({action:'add_song',song_id:Number(b.dataset.addSong)})});toast(d.message||'已加入排期');}catch(e){toast(e.message);}});
    $$('#adminRows [data-delete-song]').forEach(b=>b.onclick=async()=>{if(!await uiConfirm('永久删除这首歌及其相关记录？',{title:'彻底删除',ok:'永久删除',danger:true}))return;try{await api('/api/admin-action',{method:'POST',body:JSON.stringify({type:'delete',id:Number(b.dataset.deleteSong)})});toast('歌曲已永久删除');removeRowLive(b,null);}catch(e){toast(e.message);}});
    $$('#adminRows [data-clear-report]').forEach(b=>b.onclick=async()=>{try{await api('/api/admin-action',{method:'POST',body:JSON.stringify({type:'clear_report',id:Number(b.dataset.clearReport)})});toast('举报标记已清除');delete adminRowsCache[status];adminList(status);}catch(e){toast(e.message);}});
    $$('#adminRows [data-update-category]').forEach(b=>b.onclick=async()=>{try{await api('/api/admin-update',{method:'POST',body:JSON.stringify({id:Number(b.dataset.updateCategory),category_id:Number($(`[data-category-song="${b.dataset.updateCategory}"]`).value)})});toast('分类已更新');}catch(e){toast(e.message);}});
    $$('#adminRows [data-preview]').forEach(b=>b.onclick=()=>preview(b.dataset.preview,b.dataset.title,b.dataset.artist,$(`#admin-player-${b.dataset.song}`)));
    $$('#adminRows [data-vote-detail]').forEach(b=>b.onclick=()=>adminSongVotes(b.dataset.voteDetail,b.dataset.voteTitle));
  };
  try{
    /* v3.6.2：后台入口探测时并行预取的「待审核」列表与设置，这里直接复用 ——
       打开后台只花一段并行回源的时间（见 admin() 的说明）。 */
    if(status==='pending'&&window.__adminBootList){
      const bootList=window.__adminBootList;const bootCats=(window.__adminBootSettings&&window.__adminBootSettings.categories)||[];
      window.__adminBootList=null;window.__adminBootSettings=null;
      if(($('#adminTabs .active')?.dataset.view||'pending')!==status)return;
      adminRowsCache[status]={t:Date.now(),rows:bootList,cats:bootCats};
      renderRows(bootList,bootCats);
      renderReportInbox();
      /* 预热：把另外两个页签的数据提前拉好（复用同一份分类配置） */
      if(!window.__adminWarm){window.__adminWarm=true;
        ['approved','rejected'].forEach(s=>{api('/api/admin-list?status='+s).then(d=>{adminRowsCache[s]={t:Date.now(),rows:Array.isArray(d)?d:[],cats:bootCats};}).catch(()=>{});});
      }
      return;
    }
    /* 留存：互切页签先直出上一次的数据（零等待） */
    const cachedEntry=adminRowsCache[status];
    if(cachedEntry)renderRows(cachedEntry.rows,cachedEntry.cats||[]);
    /* 列表与分类配置互不依赖，并发取 */
    const [rows,cfg]=await Promise.all([api('/api/admin-list?status='+status),api('/api/admin-settings').catch(()=>({categories:[]}))]);
    const cats=cfg.categories||[];
    /* 慢响应守卫：用户已切到别的页签时，这次迟到的旧列表不许覆盖新视图（登录后立刻点页签时必现） */
    if(($('#adminTabs .active')?.dataset.view||'pending')!==status)return;
    adminRowsCache[status]={t:Date.now(),rows,cats};
    renderRows(rows,cats);
    if(status==='pending')renderReportInbox();
    /* 预热：首次进审核区时，把另外两个页签的数据提前拉好（分类配置一并带上，
       免得切过去第一帧的分类下拉是空的） */
    if(!window.__adminWarm){window.__adminWarm=true;
      ['pending','approved','rejected'].filter(s=>s!==status).forEach(s=>{api('/api/admin-list?status='+s).then(d=>{adminRowsCache[s]={t:Date.now(),rows:Array.isArray(d)?d:[],cats};}).catch(()=>{});});
    }
  }catch(e){box.innerHTML=`<p class="message">${esc(e.message)}</p>`;} }
/* 审核页「查看具体投票」（4.0.0）：按班级汇总票数与参与设备数，人工核查刷票。 */
async function adminSongVotes(id,title){
  const dlg=$('#adminDialog'),content=$('#dialogContent');
  content.innerHTML='<p class="muted">正在加载投票明细…</p>';
  try{
    const d=await api('/api/admin-action?id='+Number(id));
    const rows=Array.isArray(d.rows)?d.rows:[];
    content.innerHTML=`<h2>${esc((d.song&&d.song.title)||title||'歌曲')} · 投票明细</h2>
      <p class="muted">共 ${Number(d.total)||0} 票 · 按投票班级汇总；「未归属/已重置」是历史上重置名额时留下的记录。</p>
      ${rows.length?`<div class="vote-detail-wrap"><table class="vote-detail"><thead><tr><th>班级</th><th>票数</th><th>参与设备</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${esc(r.class_name)}</td><td>${Number(r.votes)||0}</td><td>${Number(r.voters)||0}</td></tr>`).join('')}</tbody></table></div>`:'<p class="muted">这首歌还没有投票记录。</p>'}
      <div class="dialog-actions"><button class="btn primary" type="button" data-close-vote-detail>关闭</button></div>`;
    const close=content.querySelector('[data-close-vote-detail]');if(close)close.onclick=()=>dlg.close();
    dlg.showModal();
  }catch(e){
    content.innerHTML=`<p class="message">${esc(e.message)}</p><div class="dialog-actions"><button class="btn primary" type="button" data-close-vote-detail>关闭</button></div>`;
    const close=content.querySelector('[data-close-vote-detail]');if(close)close.onclick=()=>dlg.close();
    dlg.showModal();
  }
}
async function adminSchedule(){const box=$('#adminRows');try{
  /* 排期窗口固定三周：上周 / 本周 / 下周（2026-10-11 用户要求「有且只有」）。
     上周已播完只作展示；「自动安排」只排本周与下周，不会改动上周。
     "今天"与前台排期页、后端同一口径：中国时区（UTC+8）的日历日。 */
  const cn=new Date(Date.now()+8*3600*1000),dow=cn.getUTCDay(),monday=new Date(cn);
  monday.setUTCDate(cn.getUTCDate()-(dow===0?6:dow-1));
  const thisMonday=monday.toISOString().slice(0,10);
  const nextMonday=(()=>{const d2=new Date(monday);d2.setUTCDate(d2.getUTCDate()+7);return d2.toISOString().slice(0,10);})();
  const lastMonday=(()=>{const d2=new Date(monday);d2.setUTCDate(d2.getUTCDate()-7);return d2.toISOString().slice(0,10);})();
  const [cfg,d,approved]=await Promise.all([
    api('/api/admin-settings'),
    /* `&_=` 强制新鲜：排期接口在边缘有 60 秒缓存，管理员编辑后必须立刻看到新排期
       （publicCache 见到 `_` 会退回 no-store，见 _lib/http.js）。 */
    api('/api/schedule?week_start='+lastMonday+'&weeks=3&_='+Date.now()),
    api('/api/admin-list?status=approved'),
  ]);
  if($('#adminTabs .active')?.dataset.view!=='schedule')return;
  const cats=cfg.categories||[];
  const pool=Array.isArray(approved)?approved:[];
  const sc=d.schedule||{mode:'both',noonCount:3,afternoonCount:3};
  const active=sc.mode==='noon'?['noon']:['noon','afternoon'];
  const countOf=p=>Number(p==='noon'?sc.noonCount:sc.afternoonCount)||3;
  const periodTitle=p=>p==='noon'?'中午放学 · 含歌词':'下午上学 · 纯音乐';
  const songOptions=selected=>`<option value="">选择已通过的歌曲…</option>${pool.map(x=>`<option value="${x.id}" ${Number(selected)===Number(x.id)?'selected':''}>${esc(x.title)}${x.artist?` · ${esc(x.artist)}`:''}</option>`).join('')}`;

  box.innerHTML=`
    <div class="toolbar">
      <label class="field">播放模式
        <select class="input" id="scheduleMode">
          <option value="both" ${sc.mode!=='noon'?'selected':''}>上下午都有</option>
          <option value="noon" ${sc.mode==='noon'?'selected':''}>仅上午</option>
        </select></label>
      <label class="field">限定分类<select class="input" id="scheduleCategory"><option value="">全部分类</option>${cats.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label>
      <button class="btn primary" id="autofill">自动安排本周与下周</button>
    </div>
    <div class="toolbar">
      <label class="field">中午每周数量<input class="input" type="number" id="noonCount" min="1" max="12" value="${countOf('noon')}"></label>
      ${active.includes('afternoon')?`<label class="field">下午每周数量<input class="input" type="number" id="afternoonCount" min="1" max="12" value="${countOf('afternoon')}"></label>`:''}
      <button class="btn" id="saveCounts">保存数量（减少时末尾退回待排）</button>
    </div>
    <p class="muted">这里就是正式播出表，从上到下是上周（已播完）、本周（正在播）、下周（还没播）。「自动安排」把本周和下周一次排满，不会动上周；每首已排的歌旁有「上移 / 下移 / 移除」，卡片底部两行可以「替换该曲目」或「插入到此位」，插入后后面的歌顺次后移。播放模式与每周数量对所有周生效。</p>
    <div class="schedule-grid admin-schedule">${(d.weeklies||[]).map(w=>{
      const label=w.weekStart===thisMonday?'本周':w.weekStart===nextMonday?'下周':'上周';
      return `
      <article class="week" data-week="${esc(w.weekStart)}">
        <div class="panel-head"><h3>${label} <span class="muted">${esc(cnRange(w))}</span></h3><button class="btn quiet" data-clear-week="${esc(w.weekStart)}" data-week-label="${label}">清空${label}</button></div>
        ${active.map(period=>{
          const count=countOf(period);
          const slots=Array.from({length:count},(_,k)=>k+1);
          const filledCount=slots.filter(pos=>((w.slots||[]).find(s=>s.period===period&&Number(s.position)===pos)||{}).title).length;
          return `<h4 class="slot-title">${periodTitle(period)}（已排 ${filledCount}/${count}）</h4>${slots.map(pos=>{
            const s=(w.slots||[]).find(v=>v.period===period&&Number(v.position)===pos);
            return `<div class="slot"><b>${pos}</b><div>${s&&s.title?`${esc(s.title)}<span>${esc(s.artist||'')}${s.is_custom&&s.source?` · ${esc(s.source)}`:''}</span>`:'待排歌曲'}</div>${s&&s.title?`<span class="slot-actions"><button class="btn quiet" data-slot-up="${esc(w.weekStart)}|${period}|${pos}" ${pos<=1?'disabled':''}>上移</button><button class="btn quiet" data-slot-down="${esc(w.weekStart)}|${period}|${pos}" ${pos>=count?'disabled':''}>下移</button><button class="btn quiet" data-clear-slot="${esc(w.weekStart)}|${period}|${pos}">移除</button></span>`:''}</div>`;
          }).join('')}
          <div class="slot"><b>改</b><div class="slot-edit">
            <select class="input" data-edit-pos="${esc(w.weekStart)}|${period}">${slots.filter(pos=>((w.slots||[]).find(s=>s.period===period&&Number(s.position)===pos)||{}).title).map(pos=>`<option value="${pos}">第 ${pos} 首</option>`).join('')||'<option value="">（本周该时段还没有已排曲目）</option>'}</select>
            <select class="input" data-edit-song="${esc(w.weekStart)}|${period}">${songOptions('')}</select>
            <button class="btn quiet" data-edit-save="${esc(w.weekStart)}|${period}">替换该曲目</button>
          </div></div>
          <div class="slot"><b>插</b><div class="slot-edit">
            <select class="input" data-insert-song="${esc(w.weekStart)}|${period}">${songOptions('')}</select>
            <input class="input" type="number" min="1" max="${count}" value="${Math.min(filledCount+1,count)}" data-insert-pos="${esc(w.weekStart)}|${period}" aria-label="插入位置">
            <button class="btn quiet" data-insert-save="${esc(w.weekStart)}|${period}">插入到此位</button>
          </div></div>`;
        }).join('')}
      </article>`;}).join('')}</div>`;

  const reload=()=>adminSchedule();
  const post=async body=>{const r=await api('/api/schedule',{method:'POST',body:JSON.stringify(body)});toast(r.message||'排期已更新');};

  $('#autofill').onclick=async()=>{const week_start=thisMonday,weeks=2;const affected=new Set([week_start,nextMonday]);const occupied=(d.weeklies||[]).filter(w=>affected.has(w.weekStart)).flatMap(w=>w.slots||[]).filter(s=>s.song_id||s.title);if(occupied.length&&!await uiConfirm(`本周与下周已有 ${occupied.length} 个排期位置。自动安排会覆盖这些内容（上周不动），继续吗？`,{title:'覆盖已有排期',ok:'继续自动安排'}))return;try{const body={action:'autofill',week_start,weeks};if($('#scheduleCategory').value)body.category_id=Number($('#scheduleCategory').value);const r=await api('/api/schedule',{method:'POST',body:JSON.stringify(body)});toast(r.message||'排期已更新');reload();}catch(e){toast(e.message);}};

  $('#scheduleMode').onchange=async e=>{
    const mode=e.target.value;
    if(mode==='noon'&&!await uiConfirm('切到「仅上午」后，本周的下午排期会整段退回待排；其它周的下午排期保留，切回后原样恢复。继续吗？',{title:'切换播放模式',ok:'切换为仅上午'})){reload();return;}
    try{await post({action:'set_mode',mode,week_start:thisMonday});reload();}catch(err){toast(err.message);reload();}
  };

  $('#saveCounts').onclick=async()=>{
    try{
      const weekStart=thisMonday;
      const noon=Number($('#noonCount').value);
      if(!Number.isInteger(noon)||noon<1||noon>12){toast('中午数量需要是 1 到 12 的整数');return;}
      await post({action:'set_block_count',period:'noon',count:noon,week_start:weekStart});
      const afternoonInput=$('#afternoonCount');
      if(afternoonInput){const afternoon=Number(afternoonInput.value);if(!Number.isInteger(afternoon)||afternoon<1||afternoon>12){toast('下午数量需要是 1 到 12 的整数');return;}await post({action:'set_block_count',period:'afternoon',count:afternoon,week_start:weekStart});}
      reload();
    }catch(err){toast(err.message);}
  };

  $$('[data-clear-week]').forEach(b=>b.onclick=async()=>{const wl=b.dataset.weekLabel||'这一周';if(!await uiConfirm(`清空${wl}（${b.dataset.clearWeek} 那一周）的全部排期？清掉的位置会退回待排。`,{title:'清空'+wl+'排期',ok:'清空',danger:true}))return;try{await post({action:'clear_week',week_start:b.dataset.clearWeek});reload();}catch(e){toast(e.message);}});
  $$('[data-clear-slot]').forEach(b=>b.onclick=async()=>{const [week_start,period,position]=b.dataset.clearSlot.split('|');try{await post({action:'clear_slot',week_start,period,position:Number(position)});reload();}catch(e){toast(e.message);}});
  $$('[data-slot-up]').forEach(b=>b.onclick=async()=>{const [week_start,period,position]=b.dataset.slotUp.split('|');try{await post({action:'move_slot',week_start,period,from:Number(position),to:Number(position)-1});reload();}catch(e){toast(e.message);}});
  $$('[data-slot-down]').forEach(b=>b.onclick=async()=>{const [week_start,period,position]=b.dataset.slotDown.split('|');try{await post({action:'move_slot',week_start,period,from:Number(position),to:Number(position)+1});reload();}catch(e){toast(e.message);}});
  $$('[data-edit-save]').forEach(b=>b.onclick=async()=>{
    const key=b.dataset.editSave,[week_start,period]=key.split('|');
    const posSel=$(`[data-edit-pos="${key}"]`,box),songSel=$(`[data-edit-song="${key}"]`,box);
    if(!posSel.value){toast('该时段还没有可替换的曲目');return;}
    if(!songSel.value){toast('请选择要替换成的歌曲');return;}
    try{await post({action:'set_slot',week_start,period,position:Number(posSel.value),song_id:Number(songSel.value)});reload();}catch(e){toast(e.message);}
  });
  $$('[data-insert-save]').forEach(b=>b.onclick=async()=>{
    const key=b.dataset.insertSave,[week_start,period]=key.split('|');
    const songSel=$(`[data-insert-song="${key}"]`,box),posInput=$(`[data-insert-pos="${key}"]`,box);
    if(!songSel.value){toast('请选择要插入的歌曲');return;}
    try{await post({action:'insert_slot',week_start,period,position:Number(posInput.value||1),song_id:Number(songSel.value)});reload();}catch(e){toast(e.message);}
  });
}catch(e){box.innerHTML=`<p class="message">${esc(e.message)}</p>`;}}
/* 班级管理（独立视图，2026-10-10）：新增班级、编辑配置（人数 / 上限表达式）、
   暂停与恢复、修改口令。上限支持两种写法：固定数字（52）或 x*比例（x=本班人数）。
   2026-10-11 按用户要求：「系统设置」里的旧班级卡片已删除，班级口令的增加与
   修改只保留在这里 —— 本页是班级与班级口令的唯一管理入口。 */
async function adminClasses(){const box=$('#adminRows');try{
  const d=await api('/api/admin-settings');
  if($('#adminTabs .active')?.dataset.view!=='classes')return;
  const isSuper=d.security?.isSuper===true;
  if(!isSuper){box.innerHTML='<p class="notice">班级管理（含班级口令的新增与修改）仅向高级管理员开放。</p>';return;}
  const classes=d.classes||[];
  const canView=!!d.security?.canViewPasswords;
  const limitHint='两种写法：固定数字（如 52）或 x*比例（x = 本班人数，如 x*0.25）；留空不限制';
  box.innerHTML=`<div class="settings-grid">
    <section class="settings-card"><h3>新增班级</h3>
      <form id="classAddForm" class="settings-form">
        <input class="input" id="newClassName" maxlength="30" placeholder="班级名称" required>
        <input class="input" id="newClassPassword" type="password" minlength="6" placeholder="初始口令（至少 6 位）" required>
        <input class="input" id="newClassGrade" maxlength="20" placeholder="年级（选填，如高一）">
        <input class="input" id="newClassCount" type="number" min="0" max="10000" placeholder="班级人数（选填）">
        <input class="input" id="newClassVoteLimit" placeholder="投票上限：如 52 或 如 x*0.25（选填）">
        <input class="input" id="newClassSubmitLimit" placeholder="投稿上限：如 52 或 如 x*0.25（选填）">
        <button class="btn primary">添加班级</button>
      </form>
      <p class="muted">${limitHint}。达到上限的班级会被拦截投票 / 投稿；暂停的班级不能投票与投稿但仍可浏览。</p>
    </section>
    ${classes.map(c=>`<section class="settings-card">
      <div class="settings-class-head"><b>${esc(c.name)}</b><span class="muted">${esc(c.grade||'未设年级')} · ${c.member_count==null?'未填写人数':`${Number(c.member_count)} 人`}</span>${c.paused?'<span class="muted">（已暂停）</span>':''}${canView&&c.password?`<span class="muted">当前口令：${esc(c.password)}</span>`:''}</div>
      <div class="settings-form"><button class="btn quiet" type="button" data-batch-add="${c.id}" data-class-name="${esc(c.name)}">批量增加人员</button><span class="muted">新增人员即可用「班级口令@姓名」登录</span></div>
      <form class="settings-form" data-class-info="${c.id}">
        <input class="input" maxlength="20" value="${esc(c.grade||'')}" aria-label="年级" placeholder="年级">
        <input class="input" type="number" min="0" max="10000" value="${c.member_count==null?'':Number(c.member_count)}" aria-label="人数" placeholder="人数">
        <input class="input" value="${esc(c.vote_limit||'')}" aria-label="投票上限" placeholder="投票上限：如 52 或 如 x*0.25">
        <input class="input" value="${esc(c.submit_limit||'')}" aria-label="投稿上限" placeholder="投稿上限：如 52 或 如 x*0.25">
        <button class="btn quiet">保存配置</button>
      </form>
      <form class="settings-form" data-class-password="${c.id}">
        <input class="input" type="password" minlength="6" placeholder="修改班级口令">
        <button class="btn quiet">更新口令</button>
      </form>
      <div class="settings-form">
        <button class="btn ${c.paused?'':'danger'}" type="button" data-toggle-pause="${c.id}" data-paused="${c.paused?0:1}" data-class-name="${esc(c.name)}">${c.paused?'恢复班级':'暂停班级'}</button>
        <button class="btn danger" type="button" data-delete-class="${c.id}" data-class-name="${esc(c.name)}">删除班级</button>
      </div>
    </section>`).join('')||'<p class="muted">尚无班级。</p>'}
  </div>`;

  $('#classAddForm').onsubmit=async e=>{e.preventDefault();try{
    const r=await api('/api/admin-settings',{method:'POST',body:JSON.stringify({action:'add_class',name:$('#newClassName').value,password:$('#newClassPassword').value,grade:$('#newClassGrade').value,member_count:$('#newClassCount').value,vote_limit:$('#newClassVoteLimit').value,submit_limit:$('#newClassSubmitLimit').value})});
    toast(r.message||'班级已添加');adminClasses();
  }catch(err){toast(err.message);}};

  $$('[data-class-info]',box).forEach(f=>f.onsubmit=async e=>{e.preventDefault();const inputs=$$('input',f);try{
    const r=await api('/api/admin-settings',{method:'POST',body:JSON.stringify({action:'update_class_info',id:Number(f.dataset.classInfo),grade:inputs[0].value,member_count:inputs[1].value,vote_limit:inputs[2].value,submit_limit:inputs[3].value})});
    toast(r.message||'班级配置已保存');adminClasses();
  }catch(err){toast(err.message);}});

  $$('[data-class-password]',box).forEach(f=>f.onsubmit=async e=>{e.preventDefault();try{
    const r=await api('/api/admin-settings',{method:'POST',body:JSON.stringify({action:'update_class_password',id:Number(f.dataset.classPassword),new_password:$('input',f).value})});
    toast(r.message||'口令已更新');adminClasses();
  }catch(err){toast(err.message);}});

  $$('[data-toggle-pause]',box).forEach(b=>b.onclick=async()=>{
    const pausing=b.dataset.paused==='1';
    if(pausing&&!await uiConfirm(`暂停「${b.dataset.className}」？该班级用户将不能投票与投稿（仍可浏览）。`,{title:'暂停班级',ok:'暂停',danger:true}))return;
    try{
      const r=await api('/api/admin-settings',{method:'POST',body:JSON.stringify({action:'set_class_paused',id:Number(b.dataset.togglePause),paused:pausing?1:0})});
      toast(r.message||'已更新');adminClasses();
    }catch(err){toast(err.message);}
  });

  $$('[data-delete-class]',box).forEach(b=>b.onclick=async()=>{
    if(!await uiConfirm(`确认删除「${b.dataset.className}」？该班级会话将立即失效。`,{title:'删除班级',ok:'删除',danger:true}))return;
    try{
      const r=await api('/api/admin-settings',{method:'POST',body:JSON.stringify({action:'delete_class',id:Number(b.dataset.deleteClass)})});
      toast(r.message||'班级已删除');adminClasses();
    }catch(err){toast(err.message);}
  });

  /* 4.0.0：批量增加人员（弹窗内可粘贴表格并转换）。 */
  $$('[data-batch-add]',box).forEach(b=>b.onclick=()=>openBatchAdd(Number(b.dataset.batchAdd),b.dataset.className));
}catch(e){box.innerHTML=`<p class="message">${esc(e.message)}</p>`;}}

/* ---------- 4.0.0 班级人员管理（独立视图） ---------- */

/** 把粘贴的表格/多行文本整理成姓名数组：支持制表符、换行、逗号、分号、竖线、空格。
 *  有表头时优先取「姓名」列；没有表头时取第一个像姓名的单元格，
 *  避免把「高一1班」「序号」这类元数据也当成人员。 */
function parseNameTable(text){
  const headerLike=/^(姓名|名字|学生姓名|学生|成员姓名|序号|学号|班级|年级|性别|备注|身份证|电话)$/;
  const nameHeader=/^(姓名|名字|学生姓名|学生|成员姓名)$/;
  const otherHeader=/^(序号|学号|班级|年级|性别|备注|身份证|电话)$/;
  const looksLikeName=/^[\u4e00-\u9fa5A-Za-z0-9_-]{1,20}$/;
  const metaLike=/班|年级|学号|序号|性别|电话|备注|身份/;
  const out=[];
  let nameCol=-1;

  for(const rawLine of String(text||'').split(/\r?\n/)){
    const line=rawLine.trim();
    if(!line)continue;
    const tabular=/\t|[,，;；|]/.test(line);
    const cells=tabular?line.split(/\t|[,，;；|]/).map(s=>s.trim()).filter(Boolean):line.split(/\s+/).filter(Boolean);
    if(!cells.length)continue;

    // 表头：识别「姓名」在第几列；后续行只取那一列。
    const headerIdx=cells.findIndex(c=>nameHeader.test(c));
    if(headerIdx>=0&&cells.some(c=>otherHeader.test(c))){nameCol=headerIdx;continue;}

    if(nameCol>=0&&nameCol<cells.length&&cells[nameCol]&&!headerLike.test(cells[nameCol])){
      out.push(cells[nameCol]);continue;
    }

    // 没有表头：纯空格分隔的一行当作多个姓名；带制表符/逗号的多列行
    // 只取第一个像姓名、且不含班级/年级等元数据的单元格。
    if(!tabular){out.push(...cells.filter(c=>!headerLike.test(c)));continue;}
    if(cells.length===1){out.push(cells[0]);continue;}
    const plausible=cells.filter(c=>looksLikeName.test(c)&&!/^\d+$/.test(c)&&!metaLike.test(c));
    if(plausible.length===cells.length)out.push(...plausible);
    else if(plausible.length)out.push(plausible[0]);
  }
  return [...new Set(out.map(s=>s.trim()).filter(s=>s&&!headerLike.test(s)))];
}

/** 批量增加人员弹窗（班级口令管理页每个班级卡片上的入口）。 */
function openBatchAdd(classId,className){
  const dlg=$('#adminDialog'),content=$('#dialogContent');
  content.innerHTML=`<h2>批量增加人员 · ${esc(className)}</h2>
    <p class="muted">直接输入「姓名一 姓名二 姓名三」，空格分隔；也可以把表格整段粘贴进来，点「转换表格」自动整理。表格会优先识别「姓名」列。</p>
    <textarea class="input" id="batchNames" rows="7" placeholder="张三 李四 王五"></textarea>
    <div class="form-actions"><button class="btn quiet" type="button" id="batchConvert">转换表格</button><span class="muted" id="batchCount"></span></div>
    <div class="dialog-actions"><button class="btn quiet" type="button" id="batchCancel">取消</button><button class="btn primary" type="button" id="batchSubmit">批量增加</button></div>`;
  const ta=$('#batchNames',content), count=$('#batchCount',content);
  const refresh=()=>{const n=parseNameTable(ta.value).length;count.textContent=n?`待导入 ${n} 人`:'输入姓名后点转换';};
  $('#batchConvert',content).onclick=()=>{const names=parseNameTable(ta.value);ta.value=names.join(' ');refresh();toast(`已转换成 ${names.length} 个姓名`);};
  ta.addEventListener('input',refresh);refresh();
  $('#batchCancel',content).onclick=()=>dlg.close();
  $('#batchSubmit',content).onclick=async()=>{
    const names=parseNameTable(ta.value);
    if(!names.length){toast('请先输入姓名');return;}
    if(names.length>300){toast('一次最多 300 人，请分批导入');return;}
    const btn=$('#batchSubmit',content);btn.disabled=true;btn.textContent='正在导入…';
    try{
      const r=await api('/api/admin-members',{method:'POST',body:JSON.stringify({action:'batch_add',class_id:classId,names})});
      toast(r.message||'已导入');dlg.close();adminClasses();
    }catch(e){toast(e.message);btn.disabled=false;btn.textContent='批量增加';}
  };
  dlg.showModal();
  setTimeout(()=>ta.focus(),50);
}

/** 班级人员页：搜索才出结果；选中后右侧执行编辑/移除/封禁/解绑设备。 */
async function adminMembers(){
  const box=$('#adminRows');
  // 年级名单是敏感数据：连搜索入口都只给高级管理员。
  try{
    const cfg=await api('/api/admin-settings');
    if(!cfg.security||cfg.security.isSuper!==true){
      box.innerHTML='<p class="notice">班级人员名单仅高级管理员可查看；普通管理员仍可管理测试口令与游客口令。</p>';
      return;
    }
  }catch(e){box.innerHTML=`<p class="message">${esc(e.message)}</p>`;return;}
  const state={q:'',rows:[],selected:null};
  box.innerHTML=`<div class="toolbar">
      <label class="field">搜索人员<input class="input" id="memberSearch" maxlength="40" placeholder="输入姓名或班级关键词"></label>
      <button class="btn primary" id="memberSearchBtn" type="button">搜索</button>
    </div>
    <p class="muted">默认不列出全部人员；名单与「个人口令」是同一份数据。新增人员请到「班级口令管理」用「批量增加人员」。</p>
    <div class="member-layout">
      <div id="memberList" class="member-list"><p class="muted">输入关键词后显示搜索结果。</p></div>
      <section class="panel member-actions" id="memberActions"></section>
    </div>`;
  const list=$('#memberList'),actions=$('#memberActions'),input=$('#memberSearch');

  const paintActions=()=>{
    const sel=state.selected;
    if(!sel){actions.innerHTML='<h3>人员操作</h3><p class="muted">先在左侧搜索并选择一名人员。</p>';return;}
    actions.innerHTML=`<h3>${esc(sel.username)}</h3>
      <p class="muted">${esc(sel.class_name)} · ${sel.banned?'已封禁':'正常'}</p>
      <div class="actions">
        <button class="btn" type="button" data-member-edit>编辑姓名</button>
        <button class="btn danger" type="button" data-member-remove>移除</button>
        <button class="btn ${sel.banned?'':'danger'}" type="button" data-member-ban>${sel.banned?'解封':'封禁'}</button>
        <button class="btn" type="button" data-member-unbind>解绑设备</button>
      </div>
      <p class="muted">封禁会清零该姓名已投出的票；移除只删除登录资格、保留票数。教室共用电脑被误绑时点「解绑设备」。</p>`;
    const edit=actions.querySelector('[data-member-edit]');
    const remove=actions.querySelector('[data-member-remove]');
    const ban=actions.querySelector('[data-member-ban]');
    const unbind=actions.querySelector('[data-member-unbind]');
    if(edit)edit.onclick=()=>openMemberRename(sel,()=>search());
    if(remove)remove.onclick=async()=>{
      if(!await uiConfirm(`移除「${sel.username}」？移除后不能再用这个姓名登录；已投票数保留，设备绑定会释放。`,{title:'移除人员',ok:'移除',danger:true}))return;
      try{const r=await api('/api/admin-members',{method:'POST',body:JSON.stringify({action:'remove',id:sel.id})});toast(r.message||'已移除');search();}catch(e){toast(e.message);}
    };
    if(ban)ban.onclick=async()=>{
      if(sel.banned){
        if(!await uiConfirm(`解封「${sel.username}」？解封后可重新登录和投票。`,{title:'解封人员',ok:'解封'}))return;
        try{const r=await api('/api/admin-members',{method:'POST',body:JSON.stringify({action:'unban',id:sel.id})});toast(r.message||'已解封');search();}catch(e){toast(e.message);}
      }else{
        if(!await uiConfirm(`封禁「${sel.username}」？该姓名不能登录和投票，且**已投出的票会被清零**（涉及多台设备）。此操作会改动票数。`,{title:'封禁人员',ok:'封禁并清零',danger:true}))return;
        try{const r=await api('/api/admin-members',{method:'POST',body:JSON.stringify({action:'ban',id:sel.id})});toast(r.message||'已封禁');search();}catch(e){toast(e.message);}
      }
    };
    if(unbind)unbind.onclick=async()=>{
      if(!await uiConfirm(`解绑「${sel.username}」名下的全部设备？解绑后这些设备可以登录其他姓名。`,{title:'解绑设备',ok:'解绑'}))return;
      try{const r=await api('/api/admin-members',{method:'POST',body:JSON.stringify({action:'unbind_device',id:sel.id})});toast(r.message||'已解绑');search();}catch(e){toast(e.message);}
    };
  };

  const paintList=()=>{
    if(!state.rows.length){list.innerHTML=`<p class="muted">${state.q?'没有匹配的人员。':'输入关键词后显示搜索结果。'}</p>`;return;}
    list.innerHTML=state.rows.map(m=>`<button type="button" class="member-item ${state.selected&&Number(state.selected.id)===Number(m.id)?'active':''}" data-member-id="${m.id}">
      <span><b>${esc(m.username)}</b><small>${esc(m.class_name)}${m.banned?' · 已封禁':''}</small></span>
      <span class="member-state">${m.banned?'已封禁':'正常'}</span>
    </button>`).join('');
    $$('[data-member-id]',list).forEach(b=>b.onclick=()=>{
      state.selected=state.rows.find(m=>Number(m.id)===Number(b.dataset.memberId))||null;
      paintList();paintActions();
    });
  };

  const search=async()=>{
    const q=input.value.trim();state.q=q;
    if(!q){toast('请输入姓名或班级关键词');input.focus();return;}
    list.innerHTML='<p class="muted">正在搜索…</p>';state.selected=null;paintActions();
    try{
      const d=await api('/api/admin-members?q='+encodeURIComponent(q));
      state.rows=Array.isArray(d.members)?d.members:[];
      paintList();paintActions();
    }catch(e){list.innerHTML=`<p class="message">${esc(e.message)}</p>`;}
  };

  $('#memberSearchBtn').onclick=search;
  input.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();search();}});
  paintActions();
}

/** 编辑人员弹窗：只改姓名；附带「移除人员」按钮。 */
function openMemberRename(member,done){
  const dlg=$('#adminDialog'),content=$('#dialogContent');
  content.innerHTML=`<h2>编辑人员</h2>
    <p class="muted">${esc(member.class_name)} · 当前姓名 ${esc(member.username)}</p>
    <div class="field"><label for="memberNewName">新姓名</label><input id="memberNewName" class="input" maxlength="20" value="${esc(member.username)}"></div>
    <div class="dialog-actions">
      <button class="btn quiet" type="button" data-cancel>取消</button>
      <button class="btn primary" type="button" data-save>保存</button>
      <button class="btn danger" type="button" data-remove>移除人员</button>
    </div>`;
  const input=$('#memberNewName',content);
  const close=()=>dlg.close();
  content.querySelector('[data-cancel]').onclick=close;
  content.querySelector('[data-save]').onclick=async()=>{
    const username=input.value.trim();
    if(!username){toast('姓名不能为空');return;}
    try{
      const r=await api('/api/admin-members',{method:'POST',body:JSON.stringify({action:'rename',id:member.id,username})});
      toast(r.message||'已保存');close();if(done)done();
    }catch(e){toast(e.message);}
  };
  content.querySelector('[data-remove]').onclick=async()=>{
    if(!await uiConfirm(`移除「${member.username}」？移除后不能再用这个姓名登录；已投票数保留。`,{title:'移除人员',ok:'移除',danger:true}))return;
    try{
      const r=await api('/api/admin-members',{method:'POST',body:JSON.stringify({action:'remove',id:member.id})});
      toast(r.message||'已移除');close();if(done)done();
    }catch(e){toast(e.message);}
  };
  dlg.showModal();
  setTimeout(()=>{input.focus();input.select();},50);
}

/* 口令管理（独立视图，2026-10-10）：生成 / 作废 / 删除 测试口令与游客口令。
   用户在前台现有的登录框里直接输入这些口令即可 —— 不新增游客登录按钮。 */
async function adminPasses(){const box=$('#adminRows');try{
  const d=await api('/api/admin-passes');
  if($('#adminTabs .active')?.dataset.view!=='passes')return;
  const passes=d.passes||[];
  box.innerHTML=`<div class="settings-grid">
    <section class="settings-card"><h3>生成测试口令</h3>
      <p class="muted">登录后拥有完整投稿与投票权限；到期自动失效。</p>
      <form id="testPassForm" class="settings-form">
        <input class="input" id="testPassLabel" maxlength="40" placeholder="备注（如：周五演示）">
        <input class="input" id="testPassToken" maxlength="32" placeholder="自定义口令（选填，留空则随机生成）">
        <input class="input" type="number" id="testPassDays" min="1" max="3650" value="7" placeholder="有效天数（默认 7）">
        <button class="btn primary">生成测试口令</button>
      </form>
    </section>
    <section class="settings-card"><h3>生成游客口令</h3>
      <p class="muted">登录后只能浏览榜单与试听，不能投稿、投票或举报。</p>
      <form id="guestPassForm" class="settings-form">
        <input class="input" id="guestPassLabel" maxlength="40" placeholder="备注（选填）">
        <input class="input" id="guestPassToken" maxlength="32" placeholder="自定义口令（选填，留空则随机生成）">
        <input class="input" type="number" id="guestPassDays" min="1" max="3650" placeholder="有效天数（留空=长期）">
        <button class="btn primary">生成游客口令</button>
      </form>
    </section>
  </div>
  <div id="newPass"></div>
  <p class="muted">自定义口令：6 到 32 位的字母、数字、短横线或下划线（区分大小写），想用更好记的口令就填它；已被占用时会提示换一个。备注、有效期与口令内容都可以自定义。</p>
  <p class="muted">口令在生成时完整显示一次${d.canView?'，之后也可在列表里查看':''}；用户在登录框输入口令后，页面会显示【游客状态】或测试身份。</p>
  ${passes.map(p=>`<div class="admin-row"><div><b>${p.kind==='test'?'测试口令':'游客口令'}${p.label?` · ${esc(p.label)}`:''}</b>
    <div class="muted">${p.token?`口令：${esc(p.token)}`:'口令不可查看（未配置 AUTH_PEPPER，仅生成时显示一次）'} · ${p.expires_at?`有效期至 ${esc(p.expires_at)}`:'长期有效'} · ${p.revoked?'已作废':'有效'}${p.last_used_at?` · 最近使用 ${esc(p.last_used_at)}`:''}</div></div>
    <div class="actions">${p.token?`<button class="btn quiet" data-copy-pass="${p.id}" data-token="${esc(p.token)}">复制口令</button>`:''}${p.revoked?'':`<button class="btn" data-revoke-pass="${p.id}">作废</button>`}<button class="btn danger" data-delete-pass="${p.id}">删除</button></div></div>`).join('')||'<p class="muted">还没有口令凭证。</p>'}`;

  const showNew=(kind,r)=>{
    $('#newPass').innerHTML=`<p class="notice">新的${kind==='test'?'测试口令':'游客口令'}：<strong>${esc(r.token)}</strong>（${r.expires_at?`有效期至 ${esc(r.expires_at)}`:'长期有效'}）—— 请立即复制分发。</p>`;
    navigator.clipboard?.writeText(r.token).catch(()=>{});
  };
  $('#testPassForm').onsubmit=async e=>{e.preventDefault();try{
    const r=await api('/api/admin-passes',{method:'POST',body:JSON.stringify({action:'create',kind:'test',label:$('#testPassLabel').value,token:$('#testPassToken').value,expires_days:$('#testPassDays').value})});
    await adminPasses();showNew('test',r);
  }catch(err){toast(err.message);}};
  $('#guestPassForm').onsubmit=async e=>{e.preventDefault();try{
    const r=await api('/api/admin-passes',{method:'POST',body:JSON.stringify({action:'create',kind:'guest',label:$('#guestPassLabel').value,token:$('#guestPassToken').value,expires_days:$('#guestPassDays').value})});
    await adminPasses();showNew('guest',r);
  }catch(err){toast(err.message);}};

  $$('[data-copy-pass]',box).forEach(b=>b.onclick=()=>{navigator.clipboard?.writeText(b.dataset.token).then(()=>toast('口令已复制')).catch(()=>toast(b.dataset.token));});
  $$('[data-revoke-pass]',box).forEach(b=>b.onclick=async()=>{
    if(!await uiConfirm('作废这条口令？它签发的所有登录会立即失效。',{title:'作废口令',ok:'作废',danger:true}))return;
    try{const r=await api('/api/admin-passes',{method:'POST',body:JSON.stringify({action:'revoke',id:Number(b.dataset.revokePass)})});toast(r.message||'已作废');adminPasses();}catch(err){toast(err.message);}
  });
  $$('[data-delete-pass]',box).forEach(b=>b.onclick=async()=>{
    if(!await uiConfirm('彻底删除这条口令？它签发的所有登录会立即失效。',{title:'删除口令',ok:'删除',danger:true}))return;
    try{const r=await api('/api/admin-passes',{method:'POST',body:JSON.stringify({action:'delete',id:Number(b.dataset.deletePass)})});toast(r.message||'已删除');adminPasses();}catch(err){toast(err.message);}
  });

  /* ---- 个人口令（MD3 项目 决策 8/9/10）：嵌在同一个「口令管理」页，不新建页面 ---- */
  const pbox=document.createElement('section');pbox.className='pref-section';pbox.innerHTML=personalSectionHtml(d);box.append(pbox);if(!d.personalForbidden)wirePersonalSection(pbox,d);
}catch(e){box.innerHTML=`<p class="message">${esc(e.message)}</p>`;}}

/* ---- 个人口令区（管理员「口令管理」内嵌；MD3 项目 决策 8/9/10） ---- */

/** 未绑定态显示的前缀（与后端 _lib/personal.js 的 UNBOUND_PREFIX 一致）。 */
const UNBOUND_PREFIX_UI='yczxuser';

function personalSectionHtml(d){
  if(d.personalForbidden){
    return `<h3>个人口令</h3><p class="muted">班级人员名单仅高级管理员可查看；测试口令与游客口令仍可在本页管理。</p>`;
  }
  const rows=d.personalPasses||[];
  if(d.personalReady===false){
    return `<h3>个人口令</h3><p class="muted">数据库尚未执行 016 迁移（缺少个人口令表）。在 D1 控制台执行 sql/016_personal_passes.sql 后，本区即可使用。</p>`;
  }
  const classes=d.classes||[];
  const classOptions=classes.map(c=>`<option value="${c.id}">${esc(c.name)}${c.password?'（口令 '+esc(c.password)+'）':''}</option>`).join('');
  const example=classes.length&&classes[0].password?esc(classes[0].password)+'@李三':'g15@李三';
  return `<h3>个人口令</h3>
  <p class="muted">绑定一条班级口令 + 一个用户名；登录时输入「班级口令@用户名」（例：${example}）。用户名仅管理员录入、同一班级内唯一；班级口令改名后所有前缀自动跟随。班级被删除时，其下个人口令自动转为未绑定状态（显示 yczxuser@用户名、暂不可登录），在本区重新绑定到新班级即可恢复。</p>
  <form id="personalForm" class="settings-form">
    <select class="input" id="personalClass" required aria-label="绑定班级">${classOptions||'<option value="">（没有可用班级）</option>'}</select>
    <input class="input" id="personalName" maxlength="20" placeholder="用户名（1~20 位，可用中文）" required>
    <button class="btn primary">创建个人口令</button>
  </form>
  <div id="personalList" class="class-settings-list">${rows.map(p=>personalRowHtml(p)).join('')||'<p class="muted">还没有个人口令。</p>'}</div>`;
}

function personalRowHtml(p){
  const label=p.unbound?`${UNBOUND_PREFIX_UI}@${p.username}`:(p.prefix?`${p.prefix}@${p.username}`:`（${p.class_name||'班级口令'}）@${p.username}`);
  const canCopy=!p.unbound&&!!p.prefix;
  const note=p.unbound?'未绑定（原班级已被删除）：重新绑定后即可登录':`绑定班级：${p.class_name||'未知'}`;
  return `<div class="admin-row" data-personal-row="${p.id}"><div><b>${esc(label)}</b>
    <div class="muted">${esc(note)} · 创建于 ${esc(p.created_at||'')}${!p.unbound&&!p.prefix?' · 口令不可查看（未配置 AUTH_PEPPER），请用班级管理里的当前口令拼接':''}</div></div>
    <div class="actions">${canCopy?`<button class="btn quiet" data-copy-personal="${p.id}">复制登录标识</button>`:''}<button class="btn" data-rebind-personal="${p.id}">重新绑定</button><button class="btn danger" data-del-personal="${p.id}">删除</button></div></div>`;
}

function wirePersonalSection(root,d){
  const form=$('#personalForm',root);
  if(form)form.onsubmit=async e=>{e.preventDefault();try{const r=await api('/api/admin-passes',{method:'POST',body:JSON.stringify({action:'create_personal',class_id:Number($('#personalClass',root).value),username:$('#personalName',root).value})});toast(r.message||'个人口令已创建');adminPasses();}catch(err){toast(err.message);}};
  const cls=(d.classes||[]).map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('');
  $$('[data-copy-personal]',root).forEach(b=>b.onclick=()=>{
    const p=(d.personalPasses||[]).find(x=>String(x.id)===b.dataset.copyPersonal);const t=p&&p.prefix?`${p.prefix}@${p.username}`:'';
    if(!t){toast('口令不可查看，无法复制完整登录标识');return;}
    navigator.clipboard?.writeText(t).then(()=>toast('登录标识已复制')).catch(()=>toast(t));
  });
  $$('[data-rebind-personal]',root).forEach(b=>b.onclick=()=>{
    const row=b.closest('[data-personal-row]');if(!row)return;const actions=$('.actions',row);if(!actions||actions.querySelector('.rebind-box'))return;
    actions.innerHTML=`<span class="rebind-box" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center"><select class="input" style="min-width:150px" aria-label="绑定到班级">${cls}</select><button class="btn primary" type="button" data-rebind-ok>绑定</button><button class="btn quiet" type="button" data-rebind-cancel>取消</button></span>`;
    $('[data-rebind-cancel]',actions).onclick=()=>adminPasses();
    $('[data-rebind-ok]',actions).onclick=async()=>{const sel=$('select',actions);try{const r=await api('/api/admin-passes',{method:'POST',body:JSON.stringify({action:'rebind_personal',id:Number(row.dataset.personalRow),class_id:Number(sel.value)})});toast(r.message||'已重新绑定');adminPasses();}catch(err){toast(err.message);}};
  });
  $$('[data-del-personal]',root).forEach(b=>b.onclick=async()=>{
    if(!await uiConfirm('删除这条个人口令？它签发的登录会立即失效；该用户名的配色记录会保留（同名重建可读回）。',{title:'删除个人口令',ok:'删除',danger:true}))return;
    try{const r=await api('/api/admin-passes',{method:'POST',body:JSON.stringify({action:'delete_personal',id:Number(b.dataset.delPersonal)})});toast(r.message||'已删除');adminPasses();}catch(err){toast(err.message);}
  });
}

/* 主题页（MD3 项目起扩到五套预设，决策 2）：
   '' 默认 / mono 黑白 / mint 薄荷青 / beige 暖米棕 / lavender 薰衣草浅紫。
   存 system_settings.site_theme（007 已有的表，无需新迁移）。
   点卡片立即在本页生效（直接改 <html> 的 data-theme），同时写入服务端 ——
   学生端、后台所有访客下一次打开页面由 app.js 启动逻辑应用新主题。
   校徽（ico.svg）与公安备案徽标是独立图片文件，不参与变量换色，任何主题下保持原样。
   个人口令用户可在「个性化」页自选自己的主题与配色，只对本人生效、不动这里。 */
async function adminTheme(){const box=$('#adminRows');try{const d=(await siteConfig())||{};if(($('#adminTabs .active')?.dataset.view||'theme')!=='theme')return;/* 迟到的旧响应不许覆盖已切换的视图 */const current=SITE_THEME_KEYS.includes(d.theme)?d.theme:'';
box.innerHTML=`<p class="muted">主题对全站生效：学生端、后台与发布页都会换外观。校徽与公安备案徽标不参与换色，任何主题下保持原样。个人口令用户在「个性化」页自选的主题/配色只对本人生效，不影响这里。</p>
  <div class="theme-grid">
    ${THEME_PRESETS.map(t=>`<button type="button" class="theme-card ${current===t.key?'active':''}" data-set-theme="${t.key||'default'}">
      <span class="swatch" aria-hidden="true">${t.swatch.map(c=>`<span style="background:${c}"></span>`).join('')}</span>
      <b>${t.name}</b>
      <span class="muted">${t.desc}</span>
      ${current===t.key?'<span class="now">当前使用</span>':''}
    </button>`).join('')}
  </div>`;
$$('[data-set-theme]',box).forEach(b=>b.onclick=async()=>{const raw=b.dataset.setTheme;/* 默认主题沿用老写法 default（服务端与旧测试都认它），提交时还原成 '' */const theme=raw==='default'?'':raw;try{const r=await api('/api/admin-settings',{method:'POST',body:JSON.stringify({action:'set_theme',theme})});toast(r.message||'主题已更新');applySiteTheme(theme);
/* 配置有 60 秒本地缓存（留存加载）—— 把缓存里的 theme 同步改掉并作废单例，
   下面的重渲染与后续 siteConfig() 才能拿到新主题，卡片「当前使用」才标得对。 */
const cc=apiCache.get('config');if(cc)apiCache.set('config',{...cc,theme});siteConfigPromise=null;adminTheme();}catch(e){toast(e.message);}});
}catch(e){box.innerHTML=`<p class="message">${esc(e.message)}</p>`;}}

async function adminBanned(){const box=$('#adminRows');try{const d=await api('/api/admin-settings');if(($('#adminTabs .active')?.dataset.view||'banned')!=='banned')return;/* 迟到的旧响应不许覆盖已切换的视图 */box.innerHTML=`<form id="bannedForm" class="toolbar"><label class="field">违禁词<input class="input" id="bannedWord" maxlength="12" required></label><label class="field">原因<input class="input" id="bannedReason" maxlength="60" placeholder="管理员封禁"></label><label class="field">失效时间<input class="input" type="date" id="bannedExpiry"></label><button class="btn primary">加入词库</button></form><p class="muted">命中规则会拦截包含该词的歌名或歌手；未设置日期时默认长期有效。</p><div>${(d.banned||[]).map(x=>`<div class="admin-row"><div><b>${esc(x.keyword)}</b><div class="muted">${esc(x.reason||'管理员封禁')} · 至 ${esc(x.expire_at||'长期')}</div></div><button class="btn" data-remove-ban="${x.id}">移除</button></div>`).join('')||'<p class="muted">词库目前为空。</p>'}</div>`;$('#bannedForm').onsubmit=async e=>{e.preventDefault();try{const expiry=$('#bannedExpiry').value;const body={action:'add_banned',keyword:$('#bannedWord').value,reason:$('#bannedReason').value};if(expiry)body.expire_at=expiry+' 23:59:59';await api('/api/admin-settings',{method:'POST',body:JSON.stringify(body)});toast('违禁词已加入');adminBanned();}catch(err){toast(err.message);}};$$('[data-remove-ban]').forEach(b=>b.onclick=async()=>{try{await api('/api/admin-settings',{method:'POST',body:JSON.stringify({action:'delete_banned',id:Number(b.dataset.removeBan)})});adminBanned();}catch(e){toast(e.message);}});}catch(e){box.innerHTML=`<p class="message">${esc(e.message)}</p>`;}}
async function adminSettings(){const box=$('#adminRows');try{const d=await api('/api/admin-settings');if(($('#adminTabs .active')?.dataset.view||'settings')!=='settings')return;/* 迟到的旧响应不许覆盖已切换的视图 */const isSuper=d.security?.isSuper===true;const classes=d.classes||[];const memberTotal=classes.reduce((n,c)=>n+(Number(c.member_count)||0),0);const missingCounts=classes.some(c=>c.member_count==null);box.innerHTML=`<div class="settings-grid"><section class="settings-card"><h3>安全状态与修改密码</h3><p class="muted">${d.security?.pepperConfigured?'私有 AUTH_PEPPER 已配置，班级口令索引受保护。':esc(d.security?.canViewPasswordsReason||'未确认私有 AUTH_PEPPER 配置。')}</p><p class="muted">当前身份：${isSuper?'高级管理员':'普通管理员'}。</p><form id="adminPasswordForm" class="settings-form"><input class="input" type="password" id="currentAdminPassword" autocomplete="current-password" placeholder="当前管理员密码" required><input class="input" type="password" id="newAdminPassword" minlength="8" autocomplete="new-password" placeholder="新密码（至少 8 位）" required><button class="btn primary">修改我的密码</button></form></section><section class="settings-card"><h3>投稿入口</h3><p class="muted">${d.submit?.paused?'当前暂停接收投稿':'当前正常接收投稿'}</p><button class="btn ${d.submit?.paused?'':'primary'}" id="toggleSubmissions">${d.submit?.paused?'恢复接收':'暂停接收'}</button></section>${isSuper?`<section class="settings-card"><h3>投票上限</h3><p class="muted">按全校人数汇总：${memberTotal} 人${missingCounts?'；有班级尚未填写人数':''}。0 表示不限。</p><form id="capForm" class="settings-form"><input class="input" type="number" min="0" max="1000000" id="voteCap" value="${Number(d.vote?.cap||0)}"><button class="btn quiet" type="button" id="fillMemberTotal">填入全校人数</button><button class="btn primary">保存上限</button></form></section><section class="settings-card"><h3>全站投稿总量上限</h3><p class="muted">当前累计投稿 ${Number(d.submitCap?.used||0)} 份。${d.submitCap?.raw?`已设上限 ${esc(d.submitCap.raw)}${Number(d.submitCap.cap)?`（有效值 ${Number(d.submitCap.cap)} 份）`:''}。`:'未设置（不限制）。'}达到上限后投稿入口自动关闭；投票不受此项影响。</p><form id="submitCapForm" class="settings-form"><input class="input" id="submitCapInput" value="${esc(d.submitCap?.raw||'')}" placeholder="如 100，或 如 x*0.25（x=全校有效班级总人数）"><button class="btn primary">保存上限</button><button class="btn quiet" type="button" id="clearSubmitCap">清空关闭</button></form></section><section class="settings-card"><h3>举报收件箱阈值</h3><p class="muted">同一首歌被不同班级达到此数量后进入待审核页收件箱。</p><form id="thresholdForm" class="settings-form"><input class="input" type="number" min="2" max="20" id="reportThreshold" value="${Number(d.report?.threshold||3)}"><button class="btn primary">保存阈值</button></form></section><section class="settings-card"><h3>分类排序权重</h3><p class="muted">权重越高，正式榜中该分类越靠前。</p>${(d.categories||[]).map(c=>`<form class="admin-row weight-form" data-category="${c.id}"><b>${esc(c.name)}</b><input class="input weight-input" type="number" min="0" max="1000" value="${Number(c.weight)||0}"><button class="btn">更新</button></form>`).join('')||'<p class="muted">没有分类配置。</p>'}</section>`:''}</div>`;$('#adminPasswordForm').onsubmit=async e=>{e.preventDefault();try{const r=await api('/api/admin-settings',{method:'POST',body:JSON.stringify({action:'change_admin_password',current_password:$('#currentAdminPassword').value,new_password:$('#newAdminPassword').value})});toast(r.message||'密码已更新');e.currentTarget.reset();}catch(err){toast(err.message);}};$('#toggleSubmissions').onclick=async()=>{try{await api('/api/admin-settings',{method:'POST',body:JSON.stringify({action:'set_submissions_paused',paused:!d.submit?.paused})});await adminSettings();}catch(e){toast(e.message);}};if(!isSuper)return;$('#fillMemberTotal').onclick=()=>{if(!memberTotal){toast('尚未填写班级人数');return;}$('#voteCap').value=String(memberTotal);};$('#capForm').onsubmit=e=>{e.preventDefault();settingsPost({action:'set_vote_cap',cap:Number($('#voteCap').value)});};$('#submitCapForm').onsubmit=e=>{e.preventDefault();settingsPost({action:'set_submit_cap',cap:$('#submitCapInput').value});};$('#clearSubmitCap').onclick=()=>{settingsPost({action:'set_submit_cap',cap:''});};$('#thresholdForm').onsubmit=e=>{e.preventDefault();settingsPost({action:'set_report_threshold',threshold:Number($('#reportThreshold').value)});};$$('.weight-form').forEach(f=>f.onsubmit=e=>{e.preventDefault();settingsPost({action:'update_category_weight',id:Number(f.dataset.category),weight:Number($('.weight-input',f).value)});});}catch(e){box.innerHTML=`<p class="message">${esc(e.message)}</p>`;}}
async function settingsPost(body){try{const d=await api('/api/admin-settings',{method:'POST',body:JSON.stringify(body)});toast(d.message||'设置已保存');adminSettings();}catch(e){toast(e.message);}}
async function renderReportInbox(){const box=$('#reportInbox');try{const d=await api('/api/admin-reports');{const av=$('#adminTabs .active')?.dataset.view;if(av&&av!=='pending'&&av!=='reports')return;}/* 迟到的旧响应不许覆盖已切换的视图 */box.innerHTML=`<section class="inbox"><h3>待处理举报 · 阈值 ${Number(d.threshold)||3}</h3>${d.available===false?'<p class="muted">举报收件箱需先执行数据库迁移 008。</p>':''}${(d.reports||[]).map(r=>`<article class="report-card"><b>${esc(r.title)} · ${Number(r.report_count)} 次举报</b><p class="muted">${esc(r.artist)} · ${esc(r.category_name)} · 最近 ${esc(r.last_at)}</p><ul>${(r.details||[]).map(x=>`<li>${esc(x.class_name||'未知班级')}${x.reason?`：${esc(x.reason)}`:''} · ${esc(x.created_at)}</li>`).join('')}</ul><button class="btn primary" data-handle-report="${r.song_id}">标记已处理</button></article>`).join('')||'<p class="muted">目前没有达到阈值的待处理举报。</p>'}</section>`;$$('[data-handle-report]').forEach(b=>b.onclick=async()=>{try{await api('/api/admin-reports',{method:'POST',body:JSON.stringify({action:'handle',song_id:Number(b.dataset.handleReport)})});toast('举报已处理');renderReportInbox();}catch(e){toast(e.message);}});}catch(e){box.innerHTML=`<p class="message">举报收件箱：${esc(e.message)}</p>`;}}
async function adminReports(){const box=$('#adminRows');box.innerHTML='<p class="muted">举报详情显示在待审核页的收件箱中。</p>';await renderReportInbox();}
async function showSuggestions(id){const dlg=$('#adminDialog'),content=$('#dialogContent');try{/* 建议列表与歌曲信息互不依赖，并发取 */const [d,data]=await Promise.all([api(`/api/suggest?song_id=${Number(id)}`),api('/api/admin-list?status=pending')]);const song=data.find(x=>Number(x.id)===Number(id));content.innerHTML=`<h2>${esc(song?.title||'歌曲')} · 版本建议</h2>${(d.suggestions||[]).map(x=>`<article class="suggestion-card"><b>${esc(x.class_name||'未知班级')}</b><p>${esc(x.content)}</p><small class="muted">${esc(x.created_at)}</small></article>`).join('')||'<p class="muted">暂无待处理建议</p>'}<button class="btn primary" id="handleSuggestions">标记全部已处理</button>`;dlg.showModal();$('#handleSuggestions').onclick=async()=>{try{await api('/api/suggest',{method:'PUT',body:JSON.stringify({song_id:Number(id)})});dlg.close();toast('建议已处理');adminView('suggestions');}catch(e){toast(e.message);}};}catch(e){toast(e.message);}}
/* 4.0.0（用户 2026-10-17）：版本建议页直接列建议内容 + 歌曲名；
   没有待处理建议的歌不出现；用户端 /suggest 页面保持原样。 */
async function adminSuggestions(){
  const box=$('#adminRows');
  try{
    const d=await api('/api/suggest?all=1');
    if(($('#adminTabs .active')?.dataset.view||'suggestions')!=='suggestions')return;
    const rows=Array.isArray(d.suggestions)?d.suggestions:[];
    if(!rows.length){box.innerHTML='<p class="muted">当前没有待处理的版本建议。</p>';return;}
    const groups=new Map();
    for(const r of rows){
      const key=String(r.song_id);
      if(!groups.has(key))groups.set(key,{song_id:r.song_id,title:r.song_title||'歌曲已删除',artist:r.song_artist||'',items:[]});
      groups.get(key).items.push(r);
    }
    box.innerHTML=[...groups.values()].map(g=>`<article class="suggestion-card suggestion-group">
      <div class="suggestion-head">
        <div><b>${esc(g.title)}</b>${g.artist?`<span class="muted">${esc(g.artist)}</span>`:''}</div>
        <button class="btn quiet" type="button" data-handle-suggest-song="${g.song_id}">全部标记已处理</button>
      </div>
      ${g.items.map(x=>`<div class="suggestion-item">
        <p>${esc(x.content)}</p>
        <small class="muted">${esc(x.class_name||'未知班级')} · ${esc(x.created_at)}</small>
        <button class="btn quiet" type="button" data-handle-suggest-id="${x.id}">标记已处理</button>
      </div>`).join('')}
    </article>`).join('');
    $$('[data-handle-suggest-id]').forEach(b=>b.onclick=async()=>{
      try{await api('/api/suggest',{method:'PUT',body:JSON.stringify({id:Number(b.dataset.handleSuggestId)})});toast('建议已处理');adminSuggestions();}catch(e){toast(e.message);}
    });
    $$('[data-handle-suggest-song]').forEach(b=>b.onclick=async()=>{
      if(!await uiConfirm('把这首歌的全部待处理建议标记为已处理？',{title:'标记已处理',ok:'全部标记'}))return;
      try{await api('/api/suggest',{method:'PUT',body:JSON.stringify({song_id:Number(b.dataset.handleSuggestSong)})});toast('建议已处理');adminSuggestions();}catch(e){toast(e.message);}
    });
  }catch(e){box.innerHTML=`<p class="message">${esc(e.message)}</p>`;}
}
async function adminAnnouncements(){const box=$('#adminRows');try{const d=await api('/api/announcements?all=1');if(($('#adminTabs .active')?.dataset.view||'announcements')!=='announcements')return;/* 迟到的旧响应不许覆盖已切换的视图 */box.innerHTML=`<form id="announcementForm" class="settings-card"><h3>发布公告</h3><input class="input" id="announcementTitle" maxlength="40" placeholder="公告标题" required><textarea class="input" id="announcementContent" maxlength="500" placeholder="公告内容" required></textarea><select class="input" id="announcementScope"><option value="app">首页公告</option><option value="gate">登录页公告</option><option value="popup">登录后弹窗</option></select><button class="btn primary">发布</button></form>${(d.announcements||[]).map(a=>`<article class="admin-row"><div><b>${esc(a.title)} ${a.is_active?'':'（已下架）'}</b><p>${esc(a.content)}</p><small class="muted">${esc(a.scope||'app')} · ${esc(a.created_at)}</small></div><div class="actions"><button class="btn" data-toggle-ann="${a.id}" data-active="${a.is_active?0:1}">${a.is_active?'下架':'上架'}</button><button class="btn danger" data-delete-ann="${a.id}">删除</button></div></article>`).join('')}`;$('#announcementForm').onsubmit=async e=>{e.preventDefault();try{await api('/api/announcements',{method:'POST',body:JSON.stringify({action:'create',title:$('#announcementTitle').value,content:$('#announcementContent').value,scope:$('#announcementScope').value})});toast('公告已发布');adminAnnouncements();}catch(err){toast(err.message);}};$$('[data-toggle-ann]').forEach(b=>b.onclick=async()=>{try{await api('/api/announcements',{method:'POST',body:JSON.stringify({action:'toggle',id:Number(b.dataset.toggleAnn),is_active:Number(b.dataset.active)})});adminAnnouncements();}catch(e){toast(e.message);}});$$('[data-delete-ann]').forEach(b=>b.onclick=async()=>{if(!await uiConfirm('删除此公告？',{title:'删除公告',ok:'删除',danger:true}))return;try{await api('/api/announcements',{method:'POST',body:JSON.stringify({action:'delete',id:Number(b.dataset.deleteAnn)})});adminAnnouncements();}catch(e){toast(e.message);}});}catch(e){box.innerHTML=`<p class="message">${esc(e.message)}</p>`;}}
async function adminAccounts(){const box=$('#adminRows');try{const d=await api('/api/admin-accounts');if(($('#adminTabs .active')?.dataset.view||'accounts')!=='accounts')return;/* 迟到的旧响应不许覆盖已切换的视图 */box.innerHTML=(d.admins||[]).map(a=>`<article class="admin-row"><b>${esc(a.username)} · ${esc(a.role)}</b>${Number(a.id)===Number(d.currentId)?'<span class="muted">当前账号</span>':a.role==='super'?'<span class="muted">受保护的高级管理员</span>':`<form class="actions" data-reset-admin="${a.id}"><input class="input" type="password" minlength="8" placeholder="新密码" required><button class="btn" type="submit">重置密码</button><button class="btn danger" type="button" data-delete-admin="${a.id}">删除账号</button></form>`}</article>`).join('');$$('[data-reset-admin]').forEach(f=>f.onsubmit=async e=>{e.preventDefault();try{await api('/api/admin-accounts',{method:'POST',body:JSON.stringify({action:'reset_password',id:Number(f.dataset.resetAdmin),new_password:$('input',f).value})});toast('密码已重置');adminAccounts();}catch(err){toast(err.message);}});$$('[data-delete-admin]').forEach(b=>b.onclick=async()=>{if(!await uiConfirm('删除该管理员并注销其会话？',{title:'删除管理员',ok:'删除',danger:true}))return;try{await api('/api/admin-accounts',{method:'POST',body:JSON.stringify({action:'delete',id:Number(b.dataset.deleteAdmin)})});adminAccounts();}catch(e){toast(e.message);}});}catch(e){box.innerHTML=`<p class="notice">此视图仅向高级管理员开放。</p>`;}}
async function adminInvites(){const box=$('#adminRows');try{const d=await api('/api/admin-invites');if(($('#adminTabs .active')?.dataset.view||'invites')!=='invites')return;/* 迟到的旧响应不许覆盖已切换的视图 */box.innerHTML=`<form id="inviteForm" class="toolbar"><label class="field">可用次数<input class="input" type="number" id="inviteUses" min="1" max="50" value="1"></label><label class="field">有效天数<input class="input" type="number" id="inviteDays" min="1" max="90" value="7"></label><label class="field">备注<input class="input" id="inviteNote" maxlength="30"></label><button class="btn primary">生成邀请码</button></form><div id="newInvite"></div>${(d.invites||[]).map(i=>`<div class="admin-row"><div><b>${esc(i.note||'管理员邀请码')}</b><div class="muted">${Number(i.used_count)}/${Number(i.max_uses)} 次 · ${esc(i.expires_at)} · ${i.is_usable?'有效':'已失效'}</div></div><button class="btn danger" data-revoke-invite="${i.id}">作废</button></div>`).join('')}`;$('#inviteForm').onsubmit=async e=>{e.preventDefault();try{const r=await api('/api/admin-invites',{method:'POST',body:JSON.stringify({action:'create',max_uses:Number($('#inviteUses').value),expires_days:Number($('#inviteDays').value),note:$('#inviteNote').value})});box.querySelector('#newInvite').innerHTML=`<p class="notice">新邀请码仅显示这一次：<strong>${esc(r.formatted)}</strong>，请立即复制保存。</p>`;await navigator.clipboard?.writeText(r.formatted).catch(()=>{});toast('邀请码已生成；此明文仅显示一次');}catch(err){toast(err.message);}};$$('[data-revoke-invite]').forEach(b=>b.onclick=async()=>{if(!await uiConfirm('作废此邀请码？',{title:'作废邀请码',ok:'作废',danger:true}))return;try{await api('/api/admin-invites',{method:'POST',body:JSON.stringify({action:'revoke',id:Number(b.dataset.revokeInvite)})});adminInvites();}catch(e){toast(e.message);}});}catch(e){box.innerHTML=`<p class="notice">此视图仅向高级管理员开放。</p>`;}}
async function register(){const f=$('#registerForm'),m=$('#registerMessage');
  /* 前端预检（与后端同一条规则，但先说给用户听，不用等一次网络往返）：
     账号字符集 / 密码强度 / 两次一致。服务端仍会再查一遍 —— 这里只是体验。 */
  const ruleUser=/^[A-Za-z0-9_\u4e00-\u9fa5-]{2,24}$/;
  const weak=(pwd)=>{if(pwd.length<8)return'密码至少 8 位';const kinds=(/[A-Za-z]/.test(pwd)?1:0)+(/\d/.test(pwd)?1:0)+(/[^A-Za-z0-9]/.test(pwd)?1:0);return kinds<2?'密码需包含字母、数字、符号中的至少两类':'';};
  f.addEventListener('submit',async e=>{e.preventDefault();const username=$('#registerName').value.trim(),password=$('#registerPassword').value,password2=$('#registerPassword2').value;
    if(!ruleUser.test(username)){m.textContent='账号只能用中文、字母、数字、下划线或短横线，长度 2–24 位';return;}
    const w=weak(password);if(w){m.textContent=w;return;}
    if(password!==password2){m.textContent='两次输入的密码不一致';return;}
    try{await api('/api/admin-register',{method:'POST',body:JSON.stringify({username,password,password2,invite_code:$('#invite').value})});
      m.textContent='注册成功，正在为你自动登录…';
      try{await api('/api/admin-login',{method:'POST',body:JSON.stringify({username,password})});m.textContent='注册成功，已自动登录，正在进入后台…';setTimeout(()=>location.href='/admin7318434',700);}
      catch{toast('注册成功，请用新账号登录');setTimeout(()=>location.href='/admin7318434',900);}
    }catch(err){m.textContent=err.message;}});}
if(!document.querySelector('.recaptcha-disclosure')){const note=document.createElement('p');note.className='recaptcha-disclosure';note.innerHTML='本网站使用 Google reCAPTCHA 保护服务，适用 Google <a href="https://policies.google.com/privacy" target="_blank" rel="noreferrer">隐私权政策</a>与<a href="https://policies.google.com/terms" target="_blank" rel="noreferrer">服务条款</a>。';
  /* 挂到页脚**里面**（原来是挂到 .shell，排在页脚之后 —— 于是它成了整页
     最后一个元素，把备案行顶离页面底端；发布页上这个问题在电脑端尤其明显）。 */
  ((document.querySelector('#beianFooter')||document.querySelector('.shell'))?.append(note));}
/* 登录页：已正式登录直接进主页；游客身份**留在登录页**——
   4.0.0 起纯班级口令会先拿到只读游客会话，必须允许他在这里用
   「班级口令@姓名」重新登录，不能一脚送回首页。 */
async function loginPage(){
  document.body.classList.remove('guest-mode');
  const me=await session();
  if(me&&!me.isGuest){location.replace('/');return;}
  const gate=$('#gateView');if(gate)gate.hidden=false;
  await loadGateAnnouncements();
  bootGate();
  if(me&&me.isGuest){
    const msg=$('#gateMessage');
    if(msg)msg.textContent='当前是游客浏览身份；输入「班级口令@姓名」可正式登录。';
  }
}

/* 偏好设置页（MD3 项目 决策 3/11/12/13/15）：独立页面 /preferences.html，仅个人口令可访问。
   非个人身份：内置弹窗讲清原因后带回首页（服务端 /api/prefs 还会再拦一道 —— 前端拦截
   只是体验）。页面自身也套个人主题（切了立刻看到效果）。 */
async function preferencesPage(){
  $('#nav').innerHTML=nav('preferences');$$('[data-logout]').forEach(b=>b.onclick=logout);
  const me=await session();
  if(!me){location.replace('/login');return;}
  if(!me.personal||!me.personal.username){
    await uiAlert('偏好设置仅个人口令可用。\n班级用户请用「班级口令@用户名」的形式登录后再访问。',{title:'无法访问',ok:'回到首页'});
    location.replace('/');return;
  }
  const root=$('#prefRoot');if(!root)return;
  let state={mode:'preset',preset:'',colors:null};
  try{const d=await api('/api/prefs');state={mode:d.mode||'preset',preset:d.preset||'',colors:d.colors||null};apiCache.set('prefs',state);}catch(e){toast(e.message);}
  renderPrefs(root,state,me);
}

function paletteValue(state,k){
  const c=state.colors||{};
  const def={primary:'#2563EB',bg:'#FFFFFF',card:'#FAFAFA',text:'#111827'};
  return /^#[0-9a-fA-F]{6}$/.test(String(c[k]||''))?c[k]:def[k];
}

/* ---------- 4.0.0 自研调色板（不使用浏览器原生 color picker） ----------
   每个颜色给「色相 / 饱和 / 亮度」三条滑块 + 色块预览。
   这是用户总纲的硬要求：手机端也要能自由调色，不能调起系统取色器。 */
function prefHexToRgb(hex){const n=parseInt(String(hex).slice(1),16);return [(n>>16)&255,(n>>8)&255,n&255];}
function prefRgbToHex(r,g,b){return '#'+[r,g,b].map(v=>Math.max(0,Math.min(255,Math.round(v))).toString(16).padStart(2,'0')).join('');}
function prefHexToHsl(hex){
  const [r0,g0,b0]=prefHexToRgb(hex).map(v=>v/255);
  const max=Math.max(r0,g0,b0),min=Math.min(r0,g0,b0),l=(max+min)/2;
  let h=0,s=0;
  if(max!==min){
    const d=max-min;
    s=l>0.5?d/(2-max-min):d/(max+min);
    if(max===r0)h=(g0-b0)/d+(g0<b0?6:0);
    else if(max===g0)h=(b0-r0)/d+2;
    else h=(r0-g0)/d+4;
    h*=60;
  }
  return {h:Math.round(h),s:Math.round(s*100),l:Math.round(l*100)};
}
function prefHslToHex(h,s,l){
  h=((Number(h)%360)+360)%360;s=Math.max(0,Math.min(100,Number(s)))/100;l=Math.max(0,Math.min(100,Number(l)))/100;
  const c=(1-Math.abs(2*l-1))*s,x=c*(1-Math.abs((h/60)%2-1)),m=l-c/2;
  let r=0,g=0,b=0;
  if(h<60){r=c;g=x;}else if(h<120){r=x;g=c;}else if(h<180){g=c;b=x;}else if(h<240){g=x;b=c;}else if(h<300){r=x;b=c;}else{r=c;b=x;}
  return prefRgbToHex((r+m)*255,(g+m)*255,(b+m)*255);
}
function paletteFieldHtml(state,k,label){
  const hex=paletteValue(state,k),hsl=prefHexToHsl(hex);
  return `<div class="palette-field" data-palette-key="${k}">
    <div class="palette-field-head"><span>${label}</span><code data-hex="${k}">${hex}</code></div>
    <span class="palette-preview" data-preview="${k}" style="background:${hex}" aria-hidden="true"></span>
    <label class="palette-slider"><span>色相</span><input type="range" min="0" max="360" value="${hsl.h}" data-hsl="h" data-key="${k}"></label>
    <label class="palette-slider"><span>饱和</span><input type="range" min="0" max="100" value="${hsl.s}" data-hsl="s" data-key="${k}"></label>
    <label class="palette-slider"><span>亮度</span><input type="range" min="0" max="100" value="${hsl.l}" data-hsl="l" data-key="${k}"></label>
  </div>`;
}

function renderPrefs(root,state,me){
  const presetOf=state.mode==='custom'?null:state.preset;
  const who=((me.className||'')+' · '+me.personal.username).replace(/^ · /,'');
  const colors={
    primary:paletteValue(state,'primary'),
    bg:paletteValue(state,'bg'),
    card:paletteValue(state,'card'),
    text:paletteValue(state,'text'),
  };
  root.innerHTML=`
  <section class="pref-section">
    <h2>预设主题</h2>
    <p class="muted">点卡片立即生效，只对你自己（${esc(who)}）生效，不影响全局站点主题与班级设置。</p>
    <div class="theme-grid pref-grid">
      ${THEME_PRESETS.map(t=>`<button type="button" class="theme-card ${presetOf===t.key?'active':''}" data-pick-preset="${t.key}">
        <span class="bar" aria-hidden="true">${t.swatch.map(c=>`<span style="background:${c}"></span>`).join('')}</span>
        <b>${t.name}</b>
        <span class="muted">${t.desc}</span>
        ${presetOf===t.key?'<span class="now">当前使用</span>':''}
      </button>`).join('')}
    </div>
  </section>
  <section class="pref-section">
    <h2>自定义调色</h2>
    <p class="muted">用下面自研的色相/饱和/亮度滑块调色（不会调起浏览器自带取色器）。对比度只提示、不阻止保存；调好后点保存才会切换。</p>
    <div class="palette-grid">
      ${[['primary','主色'],['bg','页面背景色'],['card','卡片底色'],['text','正文文字颜色']].map(([k,label])=>paletteFieldHtml(state,k,label)).join('')}
    </div>
    <p class="contrast-note" id="contrastNote"></p>
    <div class="palette-actions">
      <button class="btn primary" id="savePalette">保存并使用自定义配色</button>
      <span class="pref-state">${state.mode==='custom'?'当前：自定义配色使用中':'当前：使用预设主题'}</span>
    </div>
  </section>`;
  const note=$('#contrastNote',root);
  const paintContrast=()=>{
    const r1=personalContrast(colors.text,colors.bg),r2=personalContrast(colors.text,colors.card);
    const low=r1<4.5||r2<4.5;
    note.classList.toggle('low',low);
    note.textContent=`正文/页面背景 ${r1.toFixed(2)}:1 · 正文/卡片底 ${r2.toFixed(2)}:1`+(low?'（低于 4.5，仅提示，仍可应用）':'（达到 4.5:1）');
  };
  $$('[data-hsl]',root).forEach(inp=>inp.oninput=()=>{
    const k=inp.dataset.key;
    const box=root.querySelector(`[data-palette-key="${k}"]`);
    if(!box)return;
    const h=Number(box.querySelector('[data-hsl="h"]').value);
    const s=Number(box.querySelector('[data-hsl="s"]').value);
    const l=Number(box.querySelector('[data-hsl="l"]').value);
    const hex=prefHslToHex(h,s,l);
    colors[k]=hex;
    box.querySelector('[data-hex]').textContent=hex;
    box.querySelector('[data-preview]').style.background=hex;
    paintContrast();
  });
  paintContrast();
  $$('[data-pick-preset]',root).forEach(b=>b.onclick=async()=>{
    const preset=b.dataset.pickPreset;
    applyPersonalTheme({mode:'preset',preset});
    try{await api('/api/prefs',{method:'POST',body:JSON.stringify({mode:'preset',preset})});apiCache.set('prefs',{mode:'preset',preset,colors:null});toast('主题已切换');renderPrefs(root,{mode:'preset',preset,colors:null},me);}
    catch(e){toast(e.message);}
  });
  $('#savePalette',root).onclick=async()=>{
    const r1=personalContrast(colors.text,colors.bg),r2=personalContrast(colors.text,colors.card);
    if(r1<4.5||r2<4.5){
      const go=await uiConfirm(`对比度偏低：正文/页面背景 ${r1.toFixed(2)}:1，正文/卡片底 ${r2.toFixed(2)}:1。\n低于 4.5 只作提示，仍可应用。要保存这套配色吗？`,{title:'对比度提示',ok:'仍然应用',cancel:'返回调整'});
      if(!go)return;
    }
    try{
      const d=await api('/api/prefs',{method:'POST',body:JSON.stringify({mode:'custom',colors})});
      applyPersonalTheme({mode:'custom',colors});apiCache.set('prefs',{mode:'custom',preset:'',colors});
      toast(d.message||'自定义配色已保存');
      renderPrefs(root,{mode:'custom',preset:'',colors},me);
      if(d.warning)await uiAlert(d.warning,{title:'对比度提示',ok:'知道了'});
    }catch(e){toast(e.message);}
  };
}
/* 路由。两个必须知道的事实：
   ① 先看**页面身份**再按路径分发：服务端（中间件/server.mjs）会把发布页直接挂在 `/` 上
      给未登录访客，此时 location.pathname 是 '/' 但页面是 landing.html。
   ② **Cloudflare Pages 会把 `/login.html` 这类地址 308 成 `/login`（去掉 .html）**。
      2026-10-10 的线上事故就是它：路由原来写 `path.endsWith('login.html')`，
      在 `/login` 上全都不匹配 —— 登录框不显示、按钮事件没绑上，
      点按钮只剩原生表单提交、又被 CSP 的 form-action 'none' 静默拦掉，
      表现就是"点按钮压根没反应"。所以这里把两种形态归一化后再分发。 */
const isLandingBody=document.body.classList.contains('landing-page');
const path=location.pathname;
const pageName=(path.replace(/\/+$/,'/').split('/').pop()||'index').replace(/\.html$/i,'')||'index';
if(isLandingBody){/* 发布页：纯静态，无需脚本 */} else if(pageName==='index')home(); else if(pageName==='landing'){/* 显式路径进来的发布页 */} else if(pageName==='login')loginPage(); else if(pageName==='vote')votePage(); else if(pageName==='schedule')schedule(); else if(pageName==='admin7318434')admin(); else if(pageName==='register')register();else if(pageName==='suggest')suggestionsPage();else if(pageName==='preferences')preferencesPage();
;

/* 投稿须知与免责声明原文（2026-10-08 从旧前端补回；页面上的可见内容与此同源）*/
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
