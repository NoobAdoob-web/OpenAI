const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
  const fs = require('fs');
  const cs = fs.readFileSync('chrome-scraper-extension/content/content.js', 'utf8');
  let pass=0, fail=0;
  async function run(name, url, html, check) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await ctx.route('**/*', r => r.request().resourceType()==='document' ? r.fulfill({status:200,contentType:'text/html',body:html}) : r.fulfill({status:200,body:''}));
    await page.goto(url,{waitUntil:'domcontentloaded'}).catch(()=>{});
    await page.evaluate((c)=>{ window.chrome={runtime:{onMessage:{addListener:(fn)=>{window.__L__=fn;}},onConnect:{addListener:()=>{}},sendMessage:()=>{}},storage:{session:{get:async()=>({}),set:async()=>{},remove:async()=>{}}}}; try{eval(c);}catch(e){window.__b=e.message;} }, cs);
    await page.waitForTimeout(200);
    const resp = await page.evaluate(async ()=> new Promise(res=>{ if(!window.__L__){res({error:'no listener',b:window.__b});return;} window.__L__({action:'detect',tabId:1},{},res); }));
    console.log(`\n===== ${name} =====`);
    const rows = resp.data?.rows||[];
    const ok = check(rows);
    console.log(ok?'✓ PASS':'❌ FAIL', JSON.stringify(rows.map(r=>({url:r.URL,date:r.Date,views:r.Views}))));
    ok?pass++:fail++; await ctx.close();
  }

  // IG reels grid: tiles show only views (no alt caption/date). Embedded JSON has taken_at.
  // taken_at 1710498600 = 2024-03-15 ; 1712000000 = 2024-04-01
  const IG_REELS = `<!DOCTYPE html><html><body><main role="main"><div>
    <div class="card"><a href="/reel/CODE111/"></a><img src="https://ig/t1.jpg"><span>322K</span></div>
    <div class="card"><a href="/reel/CODE222/"></a><img src="https://ig/t2.jpg"><span>45K</span></div>
    <div class="card"><a href="/reel/CODE333/"></a><img src="https://ig/t3.jpg"><span>1.2M</span></div>
  </div></main>
  <script type="application/json">{"items":[
    {"code":"CODE111","taken_at":1710498600,"play_count":322000},
    {"code":"CODE222","taken_at":1712000000,"play_count":45000},
    {"code":"CODE333","taken_at":1700000000,"play_count":1200000}
  ]}</script></body></html>`;
  await run('IG REELS grid — date from embedded JSON', 'https://www.instagram.com/user/reels/', IG_REELS, rows => {
    return rows.length===3 && rows[0].Date==='2024-03-15' && rows[1].Date==='2024-04-01' && rows[0].Views==='322K';
  });

  // IG posts grid: alt has date already
  const IG_POSTS = `<!DOCTYPE html><html><body><main role="main"><div>
    <div class="card"><a href="/p/PA/"></a><img src="https://ig/p1.jpg" alt="Photo by brand on May 20, 2024. May be an image of text."></div>
    <div class="card"><a href="/p/PB/"></a><img src="https://ig/p2.jpg" alt="Photo by brand on June 1, 2024."></div>
    <div class="card"><a href="/p/PC/"></a><img src="https://ig/p3.jpg" alt="Photo by brand on July 4, 2024."></div>
  </div></main></body></html>`;
  await run('IG POSTS grid — date from alt text', 'https://www.instagram.com/user/', IG_POSTS, rows => {
    return rows.length===3 && rows[0].Date==='May 20, 2024' && rows[1].Date==='June 1, 2024';
  });

  console.log(`\n${'='.repeat(46)}\nRESULT: ${pass} passed, ${fail} failed\n${'='.repeat(46)}`);
  await browser.close();
  process.exit(fail?1:0);
})();
