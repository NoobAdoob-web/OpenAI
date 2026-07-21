const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage();
  const fs = require('fs');
  const contentScript = fs.readFileSync('chrome-scraper-extension/content/content.js', 'utf8');

  // Facebook reels: thumbnails are CSS background-image on divs, links are <a>, no <img>
  const html = `<!DOCTYPE html><html><head><style>
    .thumb { width:200px; height:350px; display:inline-block; }
  </style></head><body>
    <div role="main">
      <div class="x1n2onr6"><div class="x1 q"><div class="reel-grid">
        <div class="cell-91"><a href="/reel/111"></a><div class="thumb" style="background-image:url('https://fb.test/a.jpg')"></div><span>9.6K views</span></div>
        <div class="cell-92"><a href="/reel/222"></a><div class="thumb" style="background-image:url('https://fb.test/b.jpg')"></div><span>14K views</span></div>
        <div class="cell-93"><a href="/reel/333"></a><div class="thumb" style="background-image:url('https://fb.test/c.jpg')"></div><span>10K views</span></div>
        <div class="cell-94"><a href="/reel/444"></a><div class="thumb" style="background-image:url('https://fb.test/d.jpg')"></div><span>894K views</span></div>
        <div class="cell-95"><a href="/reel/555"></a><div class="thumb" style="background-image:url('https://fb.test/e.jpg')"></div><span>8.7K views</span></div>
      </div></div></div>
    </div>
  </body></html>`;

  await page.setContent(html);
  await page.addScriptTag({ content: `
    window.chrome = { runtime: { onMessage: { addListener: (fn) => { window.__IDS_LISTENER__ = fn; } }, sendMessage: () => {} },
      storage: { session: { get: async()=>({}), set: async()=>{}, remove: async()=>{} } } };
  `});
  await page.addScriptTag({ content: contentScript });
  await page.waitForTimeout(500);

  const result = await page.evaluate(async () => {
    return new Promise((resolve) => {
      if (!window.__IDS_LISTENER__) { resolve({ error: 'LISTENER NEVER REGISTERED' }); return; }
      window.__IDS_LISTENER__({ action: 'detect', tabId: 1 }, {}, resolve);
    });
  });

  console.log('\n===== TEST 2: Facebook-style CSS background-image grid (no <img>) =====');
  if (result.error) console.log('❌ FAIL:', result.error);
  else if (result.data && result.data.rows.length >= 5) {
    console.log(`✓ PASS: detected ${result.data.rows.length} rows, ${result.data.headers.length} cols`);
    console.log('  Headers:', result.data.headers.join(', '));
    console.log('  Row 1:', JSON.stringify(result.data.rows[0]));
  } else {
    console.log('❌ FAIL: expected 5 rows, got', result.data ? result.data.rows.length : 0);
    console.log('  ', JSON.stringify(result).slice(0,300));
  }
  await browser.close();
})();
