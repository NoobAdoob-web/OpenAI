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
    // IG reels-style: Views/Views(number)/Date/URL/Thumbnail populated; Likes/Comments/Shares blank
    const headers=['Caption','Duration','Duration (sec)','Views','Views (number)','Likes','Likes (number)','Comments','Comments (number)','Shares','Shares (number)','Date','URL','Thumbnail'];
    const mk=(cap,v,vn,date,url)=>{ const r={}; headers.forEach(h=>r[h]=''); r.Caption=cap; r.Views=v; r['Views (number)']=vn; r.Date=date; r.URL=url; r.Thumbnail='t.jpg'; return r; };
    const rows=[mk('a','2M','2000000','2024-03-01','https://x/1'),mk('b','500K','500000','2024-02-01','https://x/2'),mk('c','800K','800000','2024-01-01','https://x/3')];
    window.chrome={ tabs:{ query:async()=>[{id:1}], connect:()=>({}), sendMessage:async(t,m)=> m.action==='detect'?{data:{headers,rows},count:1,currentIndex:0}:{ok:true} },
      runtime:{ getManifest:()=>({version:'x'}), sendMessage:async()=>({}), onMessage:{addListener:()=>{}}, connect:()=>({}) }, scripting:{executeScript:async()=>[{}]}, downloads:{download:(o)=>{window.__dl=o;}} };
    const s=document.createElement('script'); s.textContent=js; document.body.appendChild(s); document.dispatchEvent(new Event('DOMContentLoaded'));
  }, js);
  await page.waitForTimeout(400);

  const previewHeaders = await page.evaluate(()=>[...document.querySelectorAll('#preview-table thead th')].map(t=>t.textContent));
  console.log('Preview header order:', previewHeaders.join(' | '));

  // Populated (Views, Date, URL, Thumbnail, Caption) must come before blank (Likes, Comments, Shares, Duration)
  const idx = h => previewHeaders.indexOf(h);
  const populatedMax = Math.max(idx('Views'), idx('Views (number)'), idx('Date'), idx('URL'), idx('Thumbnail'), idx('Caption'));
  const blankMin = Math.min(idx('Likes'), idx('Comments'), idx('Shares'), idx('Duration'), idx('Duration (sec)'), idx('Likes (number)'));
  console.log('Rank first:', previewHeaders[0]==='Rank');
  console.log('Max populated index:', populatedMax, '| Min blank index:', blankMin);

  // (Excel Raw Data column order — Views before blank Shares — validated in test_xlsx.js.)
  const ok = previewHeaders[0]==='Rank' && populatedMax < blankMin && errs.length===0;
  if(errs.length) console.log('ERRORS:', errs.join(' | '));
  console.log('\n'+(ok?'✓ PASS — populated columns first, blank columns last':'❌ FAIL'));
  await browser.close(); process.exit(ok?0:1);
})();
