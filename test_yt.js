const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
  const fs = require('fs');
  const contentScript = fs.readFileSync('chrome-scraper-extension/content/content.js', 'utf8');
  let pass = 0, fail = 0;

  async function run(name, url, html, check) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await context.route('**/*', route => route.request().resourceType()==='document' ? route.fulfill({status:200,contentType:'text/html',body:html}) : route.fulfill({status:200,body:''}));
    await page.goto(url, { waitUntil:'domcontentloaded' }).catch(()=>{});
    const result = await page.evaluate((cs) => {
      window.chrome = { runtime: { onMessage: { addListener: (fn)=>{window.__L__=fn;} }, sendMessage: () => {} }, storage: { session: { get: async()=>({}), set: async()=>{}, remove: async()=>{} } } };
      try { eval(cs); } catch(e){ return {bootError:e.message}; }
      return {};
    }, contentScript);
    await page.waitForTimeout(200);
    const resp = await page.evaluate(async () => new Promise(res => { if(!window.__L__){res({error:'no listener'});return;} window.__L__({action:'detect',tabId:1},{},res); }));
    console.log(`\n===== ${name} =====`);
    const ok = check(resp);
    console.log(ok ? '✓ PASS' : '❌ FAIL', JSON.stringify((resp.data?.rows||[])[0]||resp));
    ok ? pass++ : fail++;
    await context.close();
  }

  // OLD layout
  const OLD = `<!DOCTYPE html><html><body><div id="contents">
    ${[['Old Layout Video','1.2M views','2 days ago','/watch?v=old1']].map(([t,v,d,u])=>`
      <ytd-rich-item-renderer>
        <a id="video-title" title="${t}" href="${u}">${t}</a>
        <a id="thumbnail" href="${u}"><img src="https://i.ytimg.com/x.jpg"></a>
        <div id="metadata-line"><span class="inline-metadata-item">${v}</span><span class="inline-metadata-item">${d}</span></div>
      </ytd-rich-item-renderer>`).join('')}
  </div></body></html>`;
  await run('YouTube OLD layout', 'https://www.youtube.com/@x/videos', OLD, r => {
    const x=(r.data?.rows||[])[0]||{};
    return x.Caption==='Old Layout Video' && x.Views==='1.2M' && x.Date==='2 days ago' && x.URL.includes('old1');
  });

  // NEW yt-lockup-view-model layout (2024)
  const NEW = `<!DOCTYPE html><html><body><div id="contents">
    ${[['Breaking News Today','845K views','5 days ago','/watch?v=new1'],
       ['Market Update Live','23K views','1 week ago','/watch?v=new2'],
       ['Election Coverage','1.5M views','3 hours ago','/watch?v=new3']].map(([t,v,d,u])=>`
      <ytd-rich-item-renderer>
        <yt-lockup-view-model>
          <a class="yt-lockup-view-model-wiz__content-image" href="${u}"><img src="https://i.ytimg.com/${u}.jpg"></a>
          <div class="yt-lockup-metadata-view-model-wiz__title-and-metadata">
            <h3><a class="yt-lockup-metadata-view-model-wiz__title" href="${u}" title="${t}"><span>${t}</span></a></h3>
            <div class="yt-content-metadata-view-model-wiz__metadata-row">
              <span class="yt-content-metadata-view-model-wiz__metadata-text">${v}</span>
              <span class="yt-content-metadata-view-model-wiz__metadata-text">${d}</span>
            </div>
          </div>
        </yt-lockup-view-model>
      </ytd-rich-item-renderer>`).join('')}
  </div></body></html>`;
  await run('YouTube NEW lockup layout', 'https://www.youtube.com/@x/videos', NEW, r => {
    const rows=r.data?.rows||[];
    const x=rows[0]||{};
    return rows.length===3 && x.Caption==='Breaking News Today' && x.Views==='845K' && x.Date==='5 days ago' && x.URL.includes('new1');
  });

  console.log(`\n${'='.repeat(46)}\nRESULT: ${pass} passed, ${fail} failed\n${'='.repeat(46)}`);
  await browser.close();
  process.exit(fail?1:0);
})();
