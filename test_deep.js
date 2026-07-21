// Test the per-post extractor function against realistic post-page fixtures.
// We test extractPostDetails() directly (the injected function) since it's the
// core logic; the chrome.tabs orchestration is thin glue around it.
const { chromium } = require('playwright');

// Pull extractPostDetails source out of the worker file
const fs = require('fs');
const worker = fs.readFileSync('chrome-scraper-extension/background/service_worker.js', 'utf8');
const start = worker.indexOf('function extractPostDetails(options)');
const fnSrc = worker.slice(start, worker.indexOf('\n}\n', start) + 2);

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
  let pass = 0, fail = 0;

  async function run(name, url, html, options, check) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await context.route('**/*', route => route.request().resourceType()==='document' ? route.fulfill({status:200,contentType:'text/html',body:html}) : route.fulfill({status:200,body:''}));
    await page.goto(url, { waitUntil:'domcontentloaded' }).catch(()=>{});
    const result = await page.evaluate(({fn, opts}) => {
      eval(fn);
      return extractPostDetails(opts);
    }, { fn: fnSrc, opts: options });
    console.log(`\n===== ${name} =====`);
    const ok = check(result);
    console.log(ok ? '✓ PASS' : '❌ FAIL', JSON.stringify(result));
    ok ? pass++ : fail++;
    await context.close();
  }

  // YouTube watch page
  const YT = `<!DOCTYPE html><html><body>
    <ytd-watch-metadata>
      <like-button-view-model><button aria-label="like this video along with 45,678 other people">45K</button></like-button-view-model>
      <div id="info"><span>Premiered Jan 5, 2024</span></div>
    </ytd-watch-metadata>
    <ytd-comments-header-renderer><h2>2,341 Comments</h2></ytd-comments-header-renderer>
  </body></html>`;
  await run('YouTube watch page', 'https://www.youtube.com/watch?v=abc', YT,
    {date:true,likes:true,comments:true,shares:true},
    r => r.Likes==='45,678' && r.Comments==='2,341' && r.Date.includes('Jan 5, 2024') && r.Shares==='');

  // Instagram reel page
  const IG = `<!DOCTYPE html><html><body>
    <article>
      <time datetime="2024-03-15T10:30:00.000Z">March 15, 2024</time>
      <section><span>12,345 likes</span></section>
      <div>View all 678 comments</div>
    </article>
  </body></html>`;
  await run('Instagram reel page', 'https://www.instagram.com/reel/abc/', IG,
    {date:true,likes:true,comments:true,shares:true},
    r => r.Likes==='12,345' && r.Comments==='678' && r.Date.includes('2024-03-15') && r.Shares==='');

  // Facebook reel page
  const FB = `<!DOCTYPE html><html><body>
    <div>
      <abbr>January 10, 2024</abbr>
      <span>3.2K reactions</span>
      <span>456 comments</span>
      <span>89 shares</span>
    </div>
  </body></html>`;
  await run('Facebook reel page', 'https://www.facebook.com/reel/123', FB,
    {date:true,likes:true,comments:true,shares:true},
    r => r.Likes==='3.2K' && r.Comments==='456' && r.Shares==='89' && r.Date.includes('January 10, 2024'));

  // Comment text (YouTube)
  const YTC = `<!DOCTYPE html><html><body>
    <ytd-comment-thread-renderer><div id="content-text">Great video!</div></ytd-comment-thread-renderer>
    <ytd-comment-thread-renderer><div id="content-text">Very helpful, thanks</div></ytd-comment-thread-renderer>
  </body></html>`;
  await run('YouTube comment text', 'https://www.youtube.com/watch?v=xyz', YTC,
    {commentText:true, maxComments:20},
    r => r.CommentText.includes('Great video!') && r.CommentText.includes('Very helpful'));

  console.log(`\n${'='.repeat(46)}\nRESULT: ${pass} passed, ${fail} failed\n${'='.repeat(46)}`);
  await browser.close();
  process.exit(fail?1:0);
})();
