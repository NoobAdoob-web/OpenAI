const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-web-security'],
  });
  const fs = require('fs');
  const contentScript = fs.readFileSync('chrome-scraper-extension/content/content.js', 'utf8');

  let pass = 0, fail = 0;

  async function run(name, html, check) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));
    await page.setContent(html);
    // Inject stub + content script together via evaluate (reliable, no CSP issue)
    const result = await page.evaluate((cs) => {
      window.chrome = {
        runtime: { onMessage: { addListener: (fn) => { window.__IDS_LISTENER__ = fn; } }, sendMessage: () => {} },
        storage: { session: { get: async()=>({}), set: async()=>{}, remove: async()=>{} } },
      };
      // Run the content script
      try { eval(cs); } catch (e) { return { bootError: e.message }; }
      return { injected: true };
    }, contentScript);

    if (result.bootError) {
      console.log(`\n===== ${name} =====\n❌ FAIL: content script threw during bootstrap: ${result.bootError}`);
      fail++; await page.close(); return;
    }
    await page.waitForTimeout(300);
    const resp = await page.evaluate(async () => new Promise((resolve) => {
      if (!window.__IDS_LISTENER__) { resolve({ error: 'LISTENER NEVER REGISTERED' }); return; }
      window.__IDS_LISTENER__({ action: 'detect', tabId: 1 }, {}, resolve);
    }));
    console.log(`\n===== ${name} =====`);
    if (errors.length) console.log('  (page errors:', errors.join(' | '), ')');
    const ok = check(resp);
    ok ? pass++ : fail++;
    await page.close();
  }

  const IG = `<!DOCTYPE html><html><body><div role="main"><div class="a"><div class="b"><div class="c"><div class="grid">
    ${[...Array(6)].map((_,i)=>`<div class="card-${i}x"><a href="/reel/R${i}/"></a><img src="https://ig.test/${i}.jpg" alt="Reel ${i}"></div>`).join('')}
  </div></div></div></div></div></body></html>`;

  const FB = `<!DOCTYPE html><html><head><style>.t{width:200px;height:350px;display:inline-block}</style></head><body><div role="main"><div class="x"><div class="reel-grid">
    ${[...Array(5)].map((_,i)=>`<div class="cell-${i}"><a href="/reel/${i}"></a><div class="t" style="background-image:url('https://fb.test/${i}.jpg')"></div><span>${i}0K views</span></div>`).join('')}
  </div></div></div></body></html>`;

  const TABLE = `<!DOCTYPE html><html><body><table><thead><tr><th>Name</th><th>Age</th><th>City</th></tr></thead><tbody>
    <tr><td>Alice</td><td>30</td><td>NYC</td></tr><tr><td>Bob</td><td>25</td><td>LA</td></tr><tr><td>Carol</td><td>35</td><td>SF</td></tr>
  </tbody></table></body></html>`;

  const EMPTY = `<!DOCTYPE html><html><body><div><p>Just text</p><button>Click</button></div></body></html>`;

  const PRODUCTS = `<!DOCTYPE html><html><body><div class="products">
    ${[1,2,3,4].map(i=>`<div class="product"><img src="https://s.test/p${i}.jpg" alt="Product ${i}"><a href="/p/${i}">Product ${i}</a><span class="price">$${i}9.99</span></div>`).join('')}
  </div></body></html>`;

  await run('TEST 1: Instagram hashed classes + sibling a/img', IG, (r) => {
    if (r.error) { console.log('❌ FAIL:', r.error); return false; }
    const ok = r.data && r.data.rows.length === 6;
    console.log(ok ? `✓ PASS: ${r.data.rows.length} rows [${r.data.headers.join(', ')}]` : '❌ FAIL: '+JSON.stringify(r).slice(0,150));
    return ok;
  });
  await run('TEST 2: Facebook CSS background-image grid', FB, (r) => {
    if (r.error) { console.log('❌ FAIL:', r.error); return false; }
    const ok = r.data && r.data.rows.length === 5 && r.data.headers.includes('Thumbnail');
    console.log(ok ? `✓ PASS: ${r.data.rows.length} rows [${r.data.headers.join(', ')}] thumb=${r.data.rows[0].Thumbnail}` : '❌ FAIL: '+JSON.stringify(r).slice(0,150));
    return ok;
  });
  await run('TEST 3: Standard HTML table', TABLE, (r) => {
    if (r.error) { console.log('❌ FAIL:', r.error); return false; }
    const ok = r.data && r.data.rows.length === 3 && r.data.headers.includes('Name');
    console.log(ok ? `✓ PASS: ${r.data.rows.length} rows [${r.data.headers.join(', ')}]` : '❌ FAIL: '+JSON.stringify(r).slice(0,150));
    return ok;
  });
  await run('TEST 4: Empty page (no data) — must not crash', EMPTY, (r) => {
    if (r.error) { console.log('❌ FAIL:', r.error, '(listener must register even with no data!)'); return false; }
    const ok = r.data && r.data.rows.length === 0;
    console.log(ok ? '✓ PASS: 0 rows, listener registered, no crash' : '⚠️  unexpected: '+JSON.stringify(r).slice(0,150));
    return ok;
  });
  await run('TEST 5: E-commerce product cards', PRODUCTS, (r) => {
    if (r.error) { console.log('❌ FAIL:', r.error); return false; }
    const ok = r.data && r.data.rows.length === 4;
    console.log(ok ? `✓ PASS: ${r.data.rows.length} products [${r.data.headers.join(', ')}]` : '❌ FAIL: '+JSON.stringify(r).slice(0,150));
    return ok;
  });

  console.log(`\n${'='.repeat(50)}\nRESULT: ${pass} passed, ${fail} failed\n${'='.repeat(50)}`);
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
})();
