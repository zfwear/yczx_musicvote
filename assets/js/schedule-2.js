
function escapeHtml(str) { return String(str ?? '').replace(/[&<>'"]/g, tag => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'}[tag] || tag)); }
function safeInt(value) { const n = Number(value); return Number.isFinite(n) ? Math.trunc(n) : 0; }

const PERIOD_LABELS = { noon: '中午放学（含歌词）', afternoon: '下午上学（纯音乐）' };
const PERIOD_ORDER = ['noon', 'afternoon'];
/**
 * 一次展示的周数：**上周 + 本周 + 下周，就这三周**（用户要求）。
 *
 * 为什么不再往后翻：排期只对"最近要播的几周"有意义 —— 上周用于回看，
 * 本周是正在播的，下周是马上要用的。再往后的排期没排、也没人看，
 * 却要每次多打一次数据库与一次往返（免费额度就是这么被刷掉的）。
 * 所以「继续往后看」这个入口整个取消，**按钮已从 DOM 里删掉**（不是隐藏）——
 * 留一个恒隐藏的死元素，只会让下一个接手的人以为它还有用。
 */
const SHOW_WEEKS = 3;

function todayStr(){
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function mondayOf(dateStr){
  const d = new Date(dateStr + 'T00:00:00Z');
  const dow = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - (dow === 0 ? 6 : dow - 1));
  return d.toISOString().slice(0, 10);
}
function addWeeks(monday, n){
  const d = new Date(monday + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n * 7);
  return d.toISOString().slice(0, 10);
}

/** 一周的卡片：上周 / 本周 / 下周。 */
function weekCard(w, thisMonday){
  const isThis = w.weekStart === thisMonday;
  const isNext = w.weekStart === addWeeks(thisMonday, 1);
  const isPrev = w.weekStart === addWeeks(thisMonday, -1);
  const tag = isThis ? '<span class="tag">本周</span>'
    : isNext ? '<span class="tag">下周</span>'
    : isPrev ? '<span class="tag">上周</span>' : '';

  const grouped = new Map();
  for(const s of (w.slots || [])){
    if(!grouped.has(s.period)) grouped.set(s.period, []);
    grouped.get(s.period).push(s);
  }

  const body = PERIOD_ORDER.map(period => {
    const list = (grouped.get(period) || []).sort((a, b) => safeInt(a.position) - safeInt(b.position));
    const rows = [];
    for(let pos = 1; pos <= 3; pos++){
      const hit = list.find(x => safeInt(x.position) === pos);
      rows.push(`<div class="slot">
        <span class="idx">${pos}.</span>
        ${hit && hit.title
          ? `<span>${escapeHtml(hit.title)}</span><span class="meta">${escapeHtml(hit.artist || '')} · ${escapeHtml(hit.category_name || '')}</span>`
          : '<span class="empty">（待排）</span>'}
      </div>`);
    }
    return `<div class="period">${PERIOD_LABELS[period] || period}</div>${rows.join('')}`;
  }).join('');

  return `<div class="card">
    <h3>${escapeHtml(w.weekStart)} ~ ${escapeHtml(w.weekEnd)} ${tag}<span class="range">整周循环播放</span></h3>
    ${body}
  </div>`;
}

/**
 * 会话过期时的就地引导。
 *
 * 为什么不直接 location.href = '/'：这个页面是"看每周歌单"的只读页，
 * 用户点「继续往后看」或刚进来时会遇到会话过期。直接跳走会打断
 * 已经渲染出来的内容，用户也来不及看清为什么跳。
 * 所以就地插一张卡说明情况，**按下按钮才去登录页**。
 *
 * 注意：这个页面没有 uiAlert（那套自绘弹窗只在 index/vote/admin 里），
 * 所以这里用最朴素的 DOM 构造，不依赖别的页面注入的助手。
 */
function showLoginGuide(message){
  const box = document.getElementById('scheduleBox');
  if(!box) return;
  const card = document.createElement('div');
  card.className = 'card';

  const title = document.createElement('h3');
  title.textContent = '需要重新登录';
  card.appendChild(title);

  const p = document.createElement('p');
  p.textContent = message;
  card.appendChild(p);

  const go = document.createElement('button');
  go.type = 'button';
  go.className = 'more';
  go.textContent = '去登录';
  go.style.display = 'block';
  go.onclick = function(){ location.href = '/'; };
  card.appendChild(go);

  box.innerHTML = '';
  box.appendChild(card);
}

/**
 * 拉取并渲染排期：**只取上周 / 本周 / 下周三周**，一次请求搞定。
 *
 * 与旧版的差别：旧版是"首次取 4 周 + 每点一次再取 4 周（上限 12 周）"。
 * 现在入口整个取消 —— 三周足够覆盖"回看上周、看本周、准备下周"，
 * 而且这一次请求就是全部，不再有分页状态要维护。
 */
async function loadSchedule(){
  const box = document.getElementById('scheduleBox');

  // 从"上周一"开始取三周：上周 + 本周 + 下周
  const from = addWeeks(mondayOf(todayStr()), -1);

  try {
    const r = await fetch('/api/schedule?week_start=' + encodeURIComponent(from) + '&weeks=' + SHOW_WEEKS);
    if(r.status === 401){
      // 就地提示 + 按下按钮才去登录页（这个页面没有 uiAlert，见 showLoginGuide 的说明）
      showLoginGuide('登录已过期（学生会话有效期 1 天），请回主页重新输入班级口令。');
      return;
    }
    const d = await r.json();
    if(!r.ok){
      box.innerHTML = '<p class="sub" style="text-align:center;">' + escapeHtml(d.error || '加载失败') + '</p>';
      return;
    }

    const thisMonday = mondayOf(todayStr());
    const list = d.weeklies || [];
    box.innerHTML = list.length
      ? list.map(w => weekCard(w, thisMonday)).join('')
      : '<p class="sub" style="text-align:center;">这三周还没有排期</p>';
  } catch(e) {
    box.innerHTML = '<p class="sub" style="text-align:center;">网络错误</p>';
  }
}

(async function boot(){
  try {
    const r = await fetch('/api/rank?status=approved');
    if(r.status === 401){
      // 就地提示 + 按下按钮才去登录页（这个页面没有 uiAlert，见 showLoginGuide 的说明）
      showLoginGuide('登录已过期（学生会话有效期 1 天），请回主页重新输入班级口令。');
      return;
    }
  } catch(e) { /* 网络错误也照常试一次 */ }
  loadSchedule();
})();
