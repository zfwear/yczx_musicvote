
/* 备案号与版权主体若在环境变量里配了（ICP_BEIAN / GONGAN_BEIAN / COPYRIGHT_HOLDER），
   就用它覆盖页面里写死的这组 —— 改内容不必改代码、也不用重新部署。 */
(async function applyBeian(){
  const year = document.getElementById('beianYear');
  if(year) year.textContent = new Date().getFullYear();

  try {
    const r = await fetch('/api/config');
    if(!r.ok) return;
    const cfg = await r.json();

    // 顺便处理"是否暂停接收投稿"（同一个响应里就有，不必再多发一次请求）。
    // 只做提示：「去投稿」仍然可点，点歌页会说明暂停中。
    // 取不到时保持隐藏 —— 弱网下不该让人看到一个假的"停收"横幅。
    const notice = document.getElementById('pausedNotice');
    if(notice && cfg.submit && cfg.submit.paused === true){
      // 与点歌页保持同一句话（2026-10-07 用户要求只留结论）
      notice.textContent = '广播站现在暂停接收投稿。';
      notice.hidden = false;
    }

    const b = cfg.beian;
    if(!b) return;

    const holder = document.getElementById('beianHolder');
    if(holder && b.holder) holder.textContent = b.holder;

    const icp = document.getElementById('beianIcp');
    if(icp && b.icp){
      icp.textContent = b.icp;
      icp.href = 'https://beian.miit.gov.cn/';
    }

    const gongan = document.getElementById('beianGongan');
    const gonganText = document.getElementById('beianGonganText');
    if(gongan && b.gongan && gonganText){
      gonganText.textContent = b.gongan;
      // 公安备案查询页要求的 code 就是备案号里的数字部分
      const code = String(b.gongan).replace(/[^0-9]/g, '');
      gongan.href = 'https://beian.mps.gov.cn/#/query/webSearch?code=' + encodeURIComponent(code);
    }
  } catch(e) { /* 取不到就用页面里写死的值 */ }
})();
