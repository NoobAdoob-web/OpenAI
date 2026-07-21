const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  });
  const fs = require('fs');
  const contentScript = fs.readFileSync('chrome-scraper-extension/content/content.js', 'utf8');
  const stub = `window.chrome = { runtime: { onMessage: { addListener: (fn) => { window.__IDS_LISTENER__ = fn; } }, sendMessage: () => {} }, storage: { session: { get: async()=>({}), set: async()=>{}, remove: async()=>{} } };`;

  async function run(name, html, check) {
    const page = await browser.newPage();
    await page.setContent(html);
    await page.addScriptTag({ content: stub });
    await page.addScriptTag({ content: contentScript });
    await page.waitForTimeout(300);
    const result = await page.evaluate(async () => new Promise((resolve) => {
      if (!window.__IDS_LISTENER__) { resolve({ error: 'LISTENER NEVER REGISTERED' }); return; }
      window.__IDS_LISTENER__({ action: 'detect', tabId: 1 }, {}, resolve);
    }));
    console.log(`\n===== ${name} =====`);
    check(result);
    await page.close();
  }

  // Test 3: standard HTML table
  await run('TEST 3: Standard HTML <table>', `<table>
    <thead><tr><th>Name</th><th>Age</th><th>City</th></tr></thead>
    <tbody>
      <tr><td>Alice</td><td>30</td><td>NYC</td></tr>
      <tr><td>Bob</td><td>25</td><td>LA</td></tr>
      <tr><td>Carol</td><td>35</td><td>SF</td></tr>
    </tbody></table>`, (r) => {
    if (r.error) return console.log('❌ FAIL:', r.error);
    if (r.data && r.data.rows.length === 3 && r.data.headers.includes('Name'))
      console.log(`✓ PASS: ${r.data.rows.length} rows, headers: ${r.data.headers.join(', ')}`);
    else console.log('❌ FAIL:', JSON.stringify(r).slice(0,200));
  });

  // Test 4: empty page (no data) — must NOT crash, listener must register, returns empty
  await run('TEST 4: Empty page (no detectable data)', `<div><p>Just some text</p><button>Click</button></div>`, (r) => {
    if (r.error) return console.log('❌ FAIL:', r.error, '(listener should still register!)');
    if (r.data && r.data.rows.length === 0)
      console.log('✓ PASS: correctly returns 0 rows, listener registered fine');
    else console.log('⚠️  detected something unexpected:', JSON.stringify(r).slice(0,150));
  });

  // Test 5: product-card list (e-commerce style)
  await run('TEST 5: E-commerce product cards', `<div class="products">
    ${[1,2,3,4].map(i=>`<div class="product"><img src="https://s.test/p${i}.jpg" alt="Product ${i}"><a href="/p/${i}">Product ${i}</a><span class="price">$${i}9.99</span></div>`).join('')}
  </div>`, (r) => {
    if (r.error) return console.log('❌ FAIL:', r.error);
    if (r.data && r.data.rows.length === 4)
      console.log(`✓ PASS: ${r.data.rows.length} products, headers: ${r.data.headers.join(', ')}`);
    else console.log('❌ FAIL:', JSON.stringify(r).slice(0,200));
  });

  await browser.close();
})();
