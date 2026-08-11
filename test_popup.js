const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const fs = require('fs');
  const html = fs.readFileSync('chrome-scraper-extension/popup/popup.html','utf8')
    .replace('<link rel="stylesheet" href="popup.css">','')
    .replace('<script src="popup.js"></script>','');
  const js = fs.readFileSync('chrome-scraper-extension/popup/popup.js','utf8');

  let sentAction = null;
  await page.setContent(html);
  await page.evaluate((js) => {
    window.__sent = [];
    window.chrome = {
      tabs: {
        query: async () => [{ id: 1 }],
        connect: () => ({ }),
        sendMessage: async (tid, msg) => { window.__sent.push(msg); 
          if (msg.action==='detect') return { data:{ headers:['Caption','Views','URL'], rows:[{Caption:'a',Views:'1K',URL:'https://x/1'},{Caption:'b',Views:'2K',URL:'https://x/2'}] }, count:1, currentIndex:0 };
          return { ok:true };
        },
      },
      runtime: { sendMessage: async () => ({}), onMessage: { addListener: () => {} }, connect: () => ({}) },
      scripting: { executeScript: async () => [{}] },
      downloads: { download: () => {} },
    };
    const s = document.createElement('script'); s.textContent = js; document.body.appendChild(s); document.dispatchEvent(new Event('DOMContentLoaded'));
  }, js);
  await page.waitForTimeout(400);

  // Which UI is showing?
  const state = await page.evaluate(() => ({
    mainVisible: document.getElementById('main-ui').style.display !== 'none',
    startBtnText: document.getElementById('btn-start-crawl')?.textContent.trim(),
    startBtnDisabled: document.getElementById('btn-start-crawl')?.disabled,
    scrollsInput: !!document.getElementById('input-scrolls'),
    helpBox: !!document.getElementById('help-box'),
    hasLocateNext: !!document.getElementById('btn-locate-next'),
  }));
  console.log('main-ui visible     :', state.mainVisible);
  console.log('Start button label  :', JSON.stringify(state.startBtnText));
  console.log('Start btn disabled  :', state.startBtnDisabled);
  console.log('scrolls input exists:', state.scrollsInput);
  console.log('help box exists     :', state.helpBox);
  console.log('locate-next removed :', !state.hasLocateNext);

  // Click Start scraping and verify it sends startInfiniteScroll
  await page.click('#btn-start-crawl');
  await page.waitForTimeout(200);
  const sent = await page.evaluate(() => window.__sent.filter(m => m.action==='startInfiniteScroll'));
  console.log('Start → sent startInfiniteScroll:', sent.length>0, sent[0]?JSON.stringify(sent[0]):'');

  const ok = state.mainVisible && state.startBtnText==='▶ Start scraping' && !state.startBtnDisabled
    && state.scrollsInput && state.helpBox && !state.hasLocateNext && sent.length>0 && errors.length===0;
  if (errors.length) console.log('PAGE ERRORS:', errors.join(' | '));
  console.log('\n' + (ok ? '✓ PASS — popup restructured correctly' : '❌ FAIL'));
  await browser.close();
  process.exit(ok?0:1);
})();
