const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args:['--no-sandbox'] });
  const page = await browser.newPage();
  const errs=[]; page.on('pageerror',e=>errs.push(e.message));
  const fs=require('fs');
  const html=fs.readFileSync('chrome-scraper-extension/popup/popup.html','utf8').replace('<link rel="stylesheet" href="popup.css">','').replace('<script src="popup.js"></script>','');
  const js=fs.readFileSync('chrome-scraper-extension/popup/popup.js','utf8');
  await page.setContent(html);

  let captured = null;
  await page.evaluate((js)=>{
    window.__dl = null;
    window.chrome={
      tabs:{ query:async()=>[{id:1}], connect:()=>({}), sendMessage:async(t,m)=>{
        if(m.action==='detect') return {data:{headers:['Caption','Views','Views (number)','URL'],rows:[
          {Caption:'low',   Views:'10K', 'Views (number)':'10000',  URL:'https://x/1'},
          {Caption:'high',  Views:'2M',  'Views (number)':'2000000',URL:'https://x/2'},
          {Caption:'mid',   Views:'500K','Views (number)':'500000', URL:'https://x/3'},
        ]},count:1,currentIndex:0};
        return {ok:true};
      }},
      runtime:{ getManifest:()=>({version:'2.1.0'}), sendMessage:async()=>({}), onMessage:{addListener:()=>{}}, connect:()=>({}) },
      scripting:{executeScript:async()=>[{}]},
      downloads:{ download:(opts)=>{ window.__dl = opts; } },
    };
    const s=document.createElement('script'); s.textContent=js; document.body.appendChild(s); document.dispatchEvent(new Event('DOMContentLoaded'));
  }, js);
  await page.waitForTimeout(300);

  // Preview should be ranked: header has Rank, first data row = "high" (2M)
  const preview = await page.evaluate(()=>({
    headers:[...document.querySelectorAll('#preview-table thead th')].map(t=>t.textContent),
    row1:[...document.querySelectorAll('#preview-table tbody tr:first-child td')].map(t=>t.textContent),
  }));
  console.log('Preview headers[0]:', preview.headers[0], '| row1:', preview.row1.join(' | '));

  // Trigger Excel download and read the blob content
  const xml = await page.evaluate(async ()=>{
    document.getElementById('btn-xlsx').click();
    await new Promise(r=>setTimeout(r,50));
    const url = window.__dl && window.__dl.url;
    if(!url) return null;
    const resp = await fetch(url); return await resp.text();
  });

  const hasBothTabs = xml && xml.includes('ss:Name="Top Performers"') && xml.includes('ss:Name="Raw Data"');
  // In Top Performers tab, the first data row should be the 2M post (Rank 1)
  const topIdx = xml.indexOf('Top Performers');
  const rawIdx = xml.indexOf('Raw Data');
  const topSection = xml.slice(topIdx, rawIdx);
  const rankedFirstIsHigh = topSection.indexOf('high') < topSection.indexOf('low') && topSection.indexOf('high') < topSection.indexOf('mid');
  // Raw tab preserves scraped order: low, high, mid
  const rawSection = xml.slice(rawIdx);
  const rawOrderOk = rawSection.indexOf('low') < rawSection.indexOf('high') && rawSection.indexOf('high') < rawSection.indexOf('mid');

  console.log('Two tabs present:', hasBothTabs);
  console.log('Top Performers ranked (high first):', rankedFirstIsHigh);
  console.log('Raw Data keeps scraped order (low,high,mid):', rawOrderOk);
  if(errs.length) console.log('ERRORS:', errs.join(' | '));

  const ok = preview.headers[0]==='Rank' && preview.row1[1]==='high' && hasBothTabs && rankedFirstIsHigh && rawOrderOk && !errs.length;
  console.log('\n'+(ok?'✓ PASS — ranking + two-tab Excel works':'❌ FAIL'));
  await browser.close(); process.exit(ok?0:1);
})();
