const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  });
  const fs = require('fs');
  const contentScript = fs.readFileSync('chrome-scraper-extension/content/content.js', 'utf8');
  let pass = 0, fail = 0;

  async function run(name, url, html, check) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    // Intercept the target URL and any subresource, serve our fixture HTML at the REAL hostname
    await context.route('**/*', route => {
      const u = route.request().url();
      if (route.request().resourceType() === 'document') {
        route.fulfill({ status: 200, contentType: 'text/html', body: html });
      } else {
        route.fulfill({ status: 200, body: '' });
      }
    });
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(()=>{});

    const result = await page.evaluate((cs) => {
      window.chrome = { runtime: { onMessage: { addListener: (fn) => { window.__L__ = fn; } }, sendMessage: () => {} }, storage: { session: { get: async()=>({}), set: async()=>{}, remove: async()=>{} } } };
      try { eval(cs); } catch (e) { return { bootError: e.message }; }
      return { ok: true };
    }, contentScript);

    if (result.bootError) { console.log(`\n===== ${name} =====\n❌ FAIL boot: ${result.bootError}`); fail++; await context.close(); return; }
    await page.waitForTimeout(200);
    const resp = await page.evaluate(async () => new Promise(res => {
      if (!window.__L__) { res({ error: 'no listener' }); return; }
      window.__L__({ action: 'detect', tabId: 1 }, {}, res);
    }));
    console.log(`\n===== ${name} =====`);
    if (errors.length) console.log('  page errors:', errors.slice(0,2).join(' | '));
    const ok = check(resp);
    ok ? pass++ : fail++;
    await context.close();
  }

  const YT = `<!DOCTYPE html><html><body><div id="contents">
    ${[
      ['Big Breaking News Today','1.2M views','2 days ago','/watch?v=aaa111'],
      ['Election Special Coverage','845K views','5 days ago','/watch?v=bbb222'],
      ['Market Update Live','23K views','1 week ago','/watch?v=ccc333'],
    ].map(([t,v,d,u])=>`<ytd-rich-item-renderer>
      <a id="video-title" title="${t}" href="${u}">${t}</a>
      <a id="thumbnail" href="${u}"><img src="https://i.ytimg.com/x.jpg"></a>
      <div id="metadata-line"><span class="inline-metadata-item">${v}</span><span class="inline-metadata-item">${d}</span></div>
    </ytd-rich-item-renderer>`).join('')}
  </div></body></html>`;

  await run('YouTube /@channel/videos', 'https://www.youtube.com/@AajTakRadio/videos', YT, (r) => {
    const rows = r.data?.rows||[];
    const ok = rows.length===3 && rows[0].Views==='1.2M' && rows[0].Date==='2 days ago' && rows[0].Caption==='Big Breaking News Today' && rows[0].URL.includes('watch?v=aaa111');
    console.log(ok?`✓ PASS ${rows.length} videos, cols: ${r.data.headers.join(', ')}`:'❌ FAIL', JSON.stringify(rows[0]));
    return ok;
  });

  const IG = `<!DOCTYPE html><html><body><main role="main"><div>
    ${[
      ['/reel/RA111/','322K','Reel about cricket'],
      ['/reel/RB222/','45.7K','Travel vlog Kerala'],
      ['/reel/RC333/','1.2M','Cooking recipe'],
    ].map(([u,v,alt])=>`<div class="card">
      <a href="${u}"></a>
      <img src="https://ig.test/x.jpg" alt="Photo by user on January 1, 2024. ${alt}">
      <span>${v}</span>
    </div>`).join('')}
  </div></main></body></html>`;

  await run('Instagram /user/reels/', 'https://www.instagram.com/databandarr/reels/', IG, (r) => {
    const rows = r.data?.rows||[];
    const ok = rows.length===3 && rows[0].Views==='322K' && rows[0].URL.includes('/reel/RA111/') && rows.every(x=>x.Thumbnail);
    console.log(ok?`✓ PASS ${rows.length} reels, cols: ${r.data.headers.join(', ')}`:'❌ FAIL', JSON.stringify(rows[0]));
    return ok;
  });

  const FB = `<!DOCTYPE html><html><head><style>.t{width:200px;height:350px;display:inline-block}</style></head><body><div role="main">
    ${[['/reel/111','9.6K'],['/reel/222','14K'],['/reel/333','894K']].map(([u,v])=>`<div class="cell">
      <a href="${u}"></a><div class="t" style="background-image:url('https://fb.test/x.jpg')"></div><span>${v}</span>
    </div>`).join('')}
  </div></body></html>`;

  await run('Facebook /page/reels/', 'https://www.facebook.com/BPCLMAKLubes/reels/', FB, (r) => {
    const rows = r.data?.rows||[];
    const ok = rows.length===3 && rows[0].Views==='9.6K' && rows[0].URL.includes('/reel/111') && rows[0].Thumbnail.includes('fb.test');
    console.log(ok?`✓ PASS ${rows.length} reels, cols: ${r.data.headers.join(', ')}`:'❌ FAIL', JSON.stringify(rows[0]));
    return ok;
  });

  const LI = `<!DOCTYPE html><html><body>
    ${[
      ['urn:li:activity:111','Excited to announce our new product launch! Big milestone.','2d','1,234','89','15'],
      ['urn:li:activity:222','Reflecting on an amazing year of growth.','1w','567','42','8'],
    ].map(([urn,cap,date,likes,comments,reposts])=>`<div class="feed-shared-update-v2" data-urn="${urn}">
      <div class="update-components-actor__sub-description">${date} • Edited</div>
      <div class="update-components-text">${cap}</div>
      <div class="social-details-social-counts">
        <span class="social-details-social-counts__reactions-count">${likes}</span>
        <li><button>${comments} comments</button></li>
        <li><button>${reposts} reposts</button></li>
      </div>
    </div>`).join('')}
  </body></html>`;

  await run('LinkedIn feed', 'https://www.linkedin.com/feed/', LI, (r) => {
    const rows = r.data?.rows||[];
    const ok = rows.length===2 && rows[0].Likes==='1,234' && rows[0].Comments==='89' && rows[0].Shares==='15' && rows[0].Date==='2d' && rows[0].Caption.includes('product launch') && rows[0].URL.includes('activity:111');
    console.log(ok?`✓ PASS ${rows.length} posts, cols: ${r.data.headers.join(', ')}`:'❌ FAIL', JSON.stringify(rows[0]));
    return ok;
  });

  console.log(`\n${'='.repeat(52)}\nRESULT: ${pass} passed, ${fail} failed\n${'='.repeat(52)}`);
  await browser.close();
  process.exit(fail?1:0);
})();
