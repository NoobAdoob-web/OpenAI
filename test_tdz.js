const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args:['--no-sandbox'] });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const warns=[]; page.on('console',m=>{ if(m.type()==='warning'||m.type()==='error') warns.push(m.text()); });
  page.on('pageerror',e=>warns.push('PAGEERROR: '+e.message));
  const fs=require('fs');
  const cs=fs.readFileSync('chrome-scraper-extension/content/content.js','utf8');
  // Instagram reels grid fixture with embedded taken_at JSON (exercises pageScriptBlob during bootstrap)
  const IG = `<!DOCTYPE html><html><body><main role="main"><div>
    <div class="card"><a href="/reel/CODE111/"></a><img src="https://ig/t1.jpg"><span>322K</span></div>
    <div class="card"><a href="/reel/CODE222/"></a><img src="https://ig/t2.jpg"><span>45K</span></div>
    <div class="card"><a href="/reel/CODE333/"></a><img src="https://ig/t3.jpg"><span>1.2M</span></div>
  </div></main>
  <script type="application/json">{"items":[{"code":"CODE111","taken_at":1710498600},{"code":"CODE222","taken_at":1712000000},{"code":"CODE333","taken_at":1700000000}]}</script></body></html>`;
  await ctx.route('**/*', r=> r.request().resourceType()==='document'? r.fulfill({status:200,contentType:'text/html',body:IG}) : r.fulfill({status:200,body:''}));
  await page.goto('https://www.instagram.com/samsungindia/?hl=en',{waitUntil:'domcontentloaded'}).catch(()=>{});

  // Eval content script — this runs the BOOTSTRAP detect() (where the TDZ used to throw)
  const resp = await page.evaluate(async (cs)=>{
    let L=null;
    window.chrome={ runtime:{ onMessage:{addListener:(fn)=>{L=fn;}}, onConnect:{addListener:()=>{}}, sendMessage:()=>{}, getManifest:()=>({version:'x'}) }, storage:{session:{get:async()=>({}),set:async()=>{},remove:async()=>{}}} };
    try { eval(cs); } catch(e){ return {bootThrew:e.message}; }
    // Also trigger a detect and read rows
    const r = await new Promise(res=>{ if(!L){res({noListener:true});return;} L({action:'detect',tabId:1},{},res); });
    return { rows: (r.data&&r.data.rows)||[], count:r.count };
  }, cs);

  await page.waitForTimeout(100);
  const tdz = warns.filter(w=>/_scriptBlobCache|before initialization/.test(w));
  console.log('Bootstrap threw:', resp.bootThrew||'no');
  console.log('_scriptBlobCache / TDZ warnings:', tdz.length ? tdz : 'NONE ✓');
  console.log('Detected rows:', resp.rows.length, '| first date:', resp.rows[0] && resp.rows[0].Date);
  const ok = !resp.bootThrew && tdz.length===0 && resp.rows.length===3 && resp.rows[0].Date==='2024-03-15';
  console.log('\n'+(ok?'✓ PASS — no TDZ, social extraction works on Instagram':'❌ FAIL'));
  await browser.close(); process.exit(ok?0:1);
})();
