const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
  const fs = require('fs');
  const contentScript = fs.readFileSync('chrome-scraper-extension/content/content.js', 'utf8');
  const context = await browser.newContext();
  const page = await context.newPage();
  const HTML = `<!DOCTYPE html><html><body><div class="grid" style="width:900px">
    ${[...Array(6)].map((_,i)=>`<div class="card" style="width:280px;height:200px;display:inline-block"><a href="/article/${i}"><img src="https://x/${i}.jpg" style="width:280px;height:150px"></a><h3>Headline ${i}</h3></div>`).join('')}
  </div></body></html>`;
  await context.route('**/*', route => route.request().resourceType()==='document' ? route.fulfill({status:200,contentType:'text/html',body:HTML}) : route.fulfill({status:200,body:''}));
  await page.goto('https://www.ndtv.com/', { waitUntil:'domcontentloaded' }).catch(()=>{});

  await page.evaluate((cs) => {
    let onConnectCb=null;
    window.__connect = () => { const port={name:'ids-popup', onDisconnect:{addListener:(cb)=>{port._dc=cb;}}, disconnect(){this._dc&&this._dc();}}; onConnectCb&&onConnectCb(port); return port; };
    window.chrome = { runtime: { onMessage:{addListener:(fn)=>{window.__L__=fn;}}, onConnect:{addListener:(fn)=>{onConnectCb=fn;}}, sendMessage:()=>{} }, storage:{session:{get:async()=>({}),set:async()=>{},remove:async()=>{}}} };
    try { eval(cs); } catch(e){ window.__boot=e.message; }
  }, contentScript);
  await page.waitForTimeout(400);

  // The highlight box is the overlay with z-index 2147483645
  const boxDisplay = async () => page.evaluate(() => {
    const box = [...document.documentElement.children].find(el => el.style && el.style.zIndex === '2147483645');
    return box ? box.style.display : 'NO BOX';
  });

  const onLoad = await boxDisplay();
  await page.evaluate(async () => { window.__port = window.__connect(); await new Promise(r => window.__L__({action:'detect',tabId:1},{},r)); });
  await page.waitForTimeout(200);
  const afterOpen = await boxDisplay();
  await page.evaluate(() => window.__port.disconnect());
  await page.waitForTimeout(100);
  const afterClose = await boxDisplay();

  const c1 = onLoad==='none', c2 = afterOpen==='block', c3 = afterClose==='none';
  console.log('Border on page load    :', onLoad, c1?'✓ (no border)':'❌ should be none');
  console.log('Border after popup open :', afterOpen, c2?'✓ (border shown)':'❌ should be block');
  console.log('Border after popup close:', afterClose, c3?'✓ (border cleared)':'❌ should be none');
  const ok = c1&&c2&&c3;
  console.log('\n' + (ok ? '✓ PASS — highlight only shows while the popup is open' : '❌ FAIL'));
  await browser.close();
  process.exit(ok?0:1);
})();
