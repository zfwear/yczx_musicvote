
(async function applyBeian(){
  const year = document.getElementById('beianYear');
  if(year) year.textContent = new Date().getFullYear();
  try {
    const r = await fetch('/api/config');
    if(!r.ok) return;
    const b = (await r.json()).beian;
    if(!b) return;
    const holder = document.getElementById('beianHolder');
    if(holder && b.holder) holder.textContent = b.holder;
    const icp = document.getElementById('beianIcp');
    if(icp && b.icp){ icp.textContent = b.icp; icp.href = 'https://beian.miit.gov.cn/'; }
    const gongan = document.getElementById('beianGongan');
    const gonganText = document.getElementById('beianGonganText');
    if(gongan && b.gongan && gonganText){
      gonganText.textContent = b.gongan;
      const code = String(b.gongan).replace(/[^0-9]/g, '');
      gongan.href = 'https://beian.mps.gov.cn/#/query/webSearch?code=' + encodeURIComponent(code);
    }
  } catch(e) { /* 取不到就用页面里写死的值 */ }
})();
