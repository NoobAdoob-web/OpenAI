// Test the content script's detection logic against realistic DOM fixtures
// that mimic Instagram reels, Facebook reels (bg-image), and hashed classes.
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage();

  const fs = require('fs');
  const contentScript = fs.readFileSync('chrome-scraper-extension/content/content.js', 'utf8');

  // Build a fake page that mimics the three problem cases
  const html = `<!DOCTYPE html><html><body>
    <div id="root" role="main">
      <div class="xvbhtw8 x1ejq31n"><!-- wrapper 1 -->
        <div class="x7r5mf7 x1c4vz4f"><!-- wrapper 2 -->
          <div class="x78zum5 xdt5ytf"><!-- wrapper 3 -->
            <div class="grid-hash-9f2a1"><!-- ACTUAL GRID -->
              <!-- Instagram-style: <a> sibling of <img>, hashed unique classes -->
              <div class="card-a1b2"><a href="/reel/AAA111/"></a><img src="https://ig.test/1.jpg" alt="Reel one"></div>
              <div class="card-c3d4"><a href="/reel/BBB222/"></a><img src="https://ig.test/2.jpg" alt="Reel two"></div>
              <div class="card-e5f6"><a href="/reel/CCC333/"></a><img src="https://ig.test/3.jpg" alt="Reel three"></div>
              <div class="card-g7h8"><a href="/reel/DDD444/"></a><img src="https://ig.test/4.jpg" alt="Reel four"></div>
              <div class="card-i9j0"><a href="/reel/EEE555/"></a><img src="https://ig.test/5.jpg" alt="Reel five"></div>
              <div class="card-k1l2"><a href="/reel/FFF666/"></a><img src="https://ig.test/6.jpg" alt="Reel six"></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </body></html>`;

  await page.setContent(html);

  // Inject content script — but it calls chrome.runtime which doesn't exist in raw page.
  // Stub a minimal chrome API so the script runs.
  await page.addScriptTag({ content: `
    window.chrome = {
      runtime: {
        onMessage: { addListener: (fn) => { window.__IDS_LISTENER__ = fn; } },
        sendMessage: () => {},
      },
      storage: { session: { get: async()=>({}), set: async()=>{}, remove: async()=>{} } },
    };
  `});

  // Now inject the content script
  await page.addScriptTag({ content: contentScript });
  await page.waitForTimeout(500);

  // Simulate popup sending 'detect'
  const result = await page.evaluate(async () => {
    return new Promise((resolve) => {
      if (!window.__IDS_LISTENER__) { resolve({ error: 'LISTENER NEVER REGISTERED (script crashed!)' }); return; }
      window.__IDS_LISTENER__({ action: 'detect', tabId: 1 }, {}, (resp) => {
        resolve(resp);
      });
    });
  });

  console.log('\n===== TEST 1: Instagram-style hashed classes + sibling <a>/<img> =====');
  if (result.error) {
    console.log('❌ FAIL:', result.error);
  } else if (result.data && result.data.rows.length > 0) {
    console.log(`✓ PASS: detected ${result.data.rows.length} rows, ${result.data.headers.length} cols`);
    console.log('  Headers:', result.data.headers.join(', '));
    console.log('  Row 1:', JSON.stringify(result.data.rows[0]));
    console.log('  Candidates found:', result.count);
  } else {
    console.log('❌ FAIL: no rows detected', JSON.stringify(result).slice(0,200));
  }

  await browser.close();
})();
