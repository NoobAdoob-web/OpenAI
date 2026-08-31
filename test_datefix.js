const { chromium } = require('playwright');
const fs=require('fs');
(async () => {
  const browser = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args:['--no-sandbox'] });
  let pass=0, fail=0;

  // 1) extractPostDetails date from JSON-LD datePublished (no <time datetime>, no taken_at)
  const worker=fs.readFileSync('chrome-scraper-extension/background/service_worker.js','utf8');
  const s=worker.indexOf('function extractPostDetails(options)'); const e=worker.indexOf('\n}\n', worker.indexOf('return out;', s));
  const fn=worker.slice(s,e+2);
  async function ig(html){
    const ctx=await browser.newContext(); const page=await ctx.newPage();
    await ctx.route('**/*', r=> r.request().resourceType()==='document'? r.fulfill({status:200,contentType:'text/html',body:html}) : r.fulfill({status:200,body:''}));
    await page.goto('https://www.instagram.com/reel/abc/',{waitUntil:'domcontentloaded'}).catch(()=>{});
    const res=await page.evaluate((fn)=>{ eval(fn); return extractPostDetails({date:true}); }, fn);
    await ctx.close(); return res.Date;
  }
  const d1 = await ig(`<html><head><script type="application/ld+json">{"@type":"VideoObject","datePublished":"2024-03-15T10:00:00.000Z"}</script></head><body>reel</body></html>`);
  const t1 = /^2024-03-15/.test(d1);
  console.log((t1?'✓':'❌')+' IG date via JSON-LD datePublished →', d1); t1?pass++:fail++;
  const d2 = await ig(`<html><body><time title="March 20, 2024">3d</time></body></html>`);
  const t2 = /March 20, 2024|2024-03-20/.test(d2);
  console.log((t2?'✓':'❌')+' IG date via <time title> →', d2); t2?pass++:fail++;
  const d3 = await ig(`<html><body><script>window._d={"taken_at_timestamp":1710498600}</script></body></html>`);
  const t3 = d3==='2024-03-15';
  console.log((t3?'✓':'❌')+' IG date via taken_at_timestamp →', d3); t3?pass++:fail++;

  // 2) popup samples multiple posts (first/middle/last) and shows Sampled dates
  const html=fs.readFileSync('chrome-scraper-extension/popup/popup.html','utf8').replace('<link rel="stylesheet" href="popup.css">','').replace('<script src="popup.js"></script>','');
  const js=fs.readFileSync('chrome-scraper-extension/popup/popup.js','utf8');
  const p=await browser.newPage(); const errs=[]; p.on('pageerror',e=>errs.push(e.message));
  await p.setContent(html);
  await p.evaluate((js)=>{
    const headers=['Caption','Views','Views (number)','Date','URL'];
    const rows=[]; for(let i=0;i<10;i++) rows.push({Caption:'p'+i,Views:'1K','Views (number)':'1000',Date:'',URL:'https://www.instagram.com/reel/R'+i+'/'});
    window.__sent=[];
    window.chrome={ tabs:{ query:async()=>[{id:1,url:'https://www.instagram.com/user/reels/'}], connect:()=>({}), sendMessage:async(t,m)=> m.action==='detect'?{data:{headers,rows},count:1,currentIndex:0}:{ok:true} },
      runtime:{ getManifest:()=>({version:'x'}), sendMessage:async(m)=>{ window.__sent.push(m);
        if(m.action==='getPostMeta'){ const meta={}; m.urls.forEach((u,idx)=>{ meta[u]={date:'2024-0'+((idx%9)+1)+'-15',durationSec:''}; }); return {ok:true,meta}; }
        return {}; }, onMessage:{addListener:()=>{}}, connect:()=>({}) }, scripting:{executeScript:async()=>[{}]}, downloads:{download:()=>{}} };
    const sc=document.createElement('script'); sc.textContent=js; document.body.appendChild(sc); document.dispatchEvent(new Event('DOMContentLoaded'));
  }, js);
  await p.waitForTimeout(500);
  const st = await p.evaluate(()=>{
    const sent=window.__sent.find(m=>m.action==='getPostMeta');
    const items={}; document.querySelectorAll('#analysis-box .an-item').forEach(el=>{items[el.querySelector('.an-label').textContent]=el.querySelector('.an-val').textContent;});
    return { sentUrls: sent?sent.urls:[], items };
  });
  console.log('\n== popup sampling ==');
  console.log('Sampled URL count:', st.sentUrls.length, '(indices should be first/middle/last)');
  console.log('Sampled dates item:', st.items['Sampled dates']);
  console.log('Date range:', st.items['Date range']);
  const t4 = st.sentUrls.length===5 && st.sentUrls.includes('https://www.instagram.com/reel/R0/') && st.sentUrls.includes('https://www.instagram.com/reel/R9/')
    && !!st.items['Sampled dates'] && st.items['Sampled dates'].split('•').length>=4 && errs.length===0;
  console.log((t4?'✓ PASS':'❌ FAIL')+' popup samples first/middle/last & shows sampled dates', errs.length?('err:'+errs.join('|')):'');
  t4?pass++:fail++;

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  await browser.close(); process.exit(fail?1:0);
})();
