const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errs=[]; page.on('pageerror',e=>errs.push(e.message));
  const fs=require('fs');
  const html=fs.readFileSync('chrome-scraper-extension/popup/popup.html','utf8').replace('<link rel="stylesheet" href="popup.css">','').replace('<script src="popup.js"></script>','');
  const js=fs.readFileSync('chrome-scraper-extension/popup/popup.js','utf8');
  await page.setContent(html);
  await page.evaluate((js)=>{
    window.chrome={ tabs:{ query:async()=>[{id:1}], connect:()=>({}), sendMessage:async(t,m)=>{
      if(m.action==='detect') return {data:{headers:['Caption','Views','Views (number)','URL'],rows:[
        {Caption:'a',Views:'10K','Views (number)':'10000',URL:'https://x/1'},
        {Caption:'b',Views:'2M','Views (number)':'2000000',URL:'https://x/2'},
        {Caption:'c',Views:'',        'Views (number)':'',URL:'https://x/3'}
      ]},count:1,currentIndex:0};
      return {ok:true};
    }}, runtime:{sendMessage:async()=>({}),onMessage:{addListener:()=>{}},connect:()=>({})}, scripting:{executeScript:async()=>[{}]}, downloads:{download:()=>{}} };
    const s=document.createElement('script'); s.textContent=js; document.body.appendChild(s); document.dispatchEvent(new Event('DOMContentLoaded'));
  }, js);
  await page.waitForTimeout(400);

  // Enter CPV = 0.3
  await page.fill('#input-cpv','0.3');
  await page.waitForTimeout(150);
  const out = await page.evaluate(()=>{
    // read the preview header + a couple rows via the module's exportRows through DOM
    const headers=[...document.querySelectorAll('#preview-table thead th')].map(th=>th.textContent);
    const rows=[...document.querySelectorAll('#preview-table tbody tr')].map(tr=>[...tr.querySelectorAll('td')].map(td=>td.textContent));
    return {headers, rows};
  });
  const invIdx = out.headers.indexOf('Expected Investment');
  console.log('Header has Expected Investment:', invIdx>=0);
  console.log('Header order:', out.headers.join(' | '));
  // Preview is now RANKED by views, so row1 = the 2M post, row2 = the 10K post
  const r0=out.rows[0], r1=out.rows[1], r2=out.rows[2];
  console.log('Row1 (2,000,000 × 0.3):', r0[invIdx]);
  console.log('Row2 (10000 × 0.3):', r1[invIdx]);
  console.log('Row3 (no views):', JSON.stringify(r2[invIdx]));

  const ok = invIdx>=0 && r0[invIdx]==='600000' && r1[invIdx]==='3000' && (r2[invIdx]===''||r2[invIdx]==null) && errs.length===0;

  // Now clear CPV → column should disappear
  await page.fill('#input-cpv','');
  await page.waitForTimeout(150);
  const cleared = await page.evaluate(()=> [...document.querySelectorAll('#preview-table thead th')].map(th=>th.textContent).includes('Expected Investment'));
  console.log('After clearing CPV, column removed:', !cleared);

  if(errs.length) console.log('ERRORS:', errs.join(' | '));
  console.log('\n'+((ok && !cleared)?'✓ PASS — CPV computes Expected Investment correctly':'❌ FAIL'));
  await browser.close(); process.exit((ok && !cleared)?0:1);
})();
