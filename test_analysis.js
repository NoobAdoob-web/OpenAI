const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args:['--no-sandbox'] });
  const page = await browser.newPage();
  const errs=[]; page.on('pageerror',e=>errs.push(e.message));
  const fs=require('fs');
  const html=fs.readFileSync('chrome-scraper-extension/popup/popup.html','utf8').replace('<link rel="stylesheet" href="popup.css">','').replace('<script src="popup.js"></script>','');
  const js=fs.readFileSync('chrome-scraper-extension/popup/popup.js','utf8');
  await page.setContent(html);
  await page.evaluate((js)=>{
    window.chrome={
      tabs:{ query:async()=>[{id:1}], connect:()=>({}), sendMessage:async(t,m)=>{
        if(m.action==='detect') return {data:{headers:['Caption','Views','Views (number)','Duration (sec)','Date','URL'],rows:[
          {Caption:'A',Views:'10K','Views (number)':'10000','Duration (sec)':'30',Date:'2024-01-01',URL:'https://x/1'},
          {Caption:'B',Views:'2M','Views (number)':'2000000','Duration (sec)':'60',Date:'2024-03-15',URL:'https://x/2'},
          {Caption:'C',Views:'500K','Views (number)':'500000','Duration (sec)':'90',Date:'2024-02-10',URL:'https://x/3'}]},count:1,currentIndex:0};
        return {ok:true};
      }},
      runtime:{ getManifest:()=>({version:'2.2.0'}), sendMessage:async()=>({}), onMessage:{addListener:()=>{}}, connect:()=>({}) },
      scripting:{executeScript:async()=>[{}]}, downloads:{download:(o)=>{window.__dl=o;}} };
    const s=document.createElement('script'); s.textContent=js; document.body.appendChild(s); document.dispatchEvent(new Event('DOMContentLoaded'));
  }, js);
  await page.waitForTimeout(400);

  // Analysis panel visible + content
  const panel = await page.evaluate(()=>{
    const box=document.getElementById('analysis-box');
    const items={}; box.querySelectorAll('.an-item').forEach(el=>{ items[el.querySelector('.an-label').textContent]=el.querySelector('.an-val').textContent; });
    return { visible: box.style.display!=='none', items };
  });
  console.log('Panel visible:', panel.visible);
  console.log('Items:', JSON.stringify(panel.items));

  // (Excel ANALYSIS block / date range validated in test_xlsx.js.)
  const dr = panel.items['Date range'];
  const ok = panel.visible && dr==='2024-01-01 → 2024-03-15' && panel.items['Posts']==='3' && errs.length===0;
  if(errs.length) console.log('ERRORS:', errs.join(' | '));
  console.log('\n'+(ok?'✓ PASS — analysis panel + date range work':'❌ FAIL'));
  await browser.close(); process.exit(ok?0:1);
})();
