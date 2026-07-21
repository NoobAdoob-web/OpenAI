const { chromium } = require('playwright');
const fs = require('fs');
const worker = fs.readFileSync('chrome-scraper-extension/background/service_worker.js', 'utf8');
// Extract extractPostDetails source (from decl to the matching closing brace at col 0)
const start = worker.indexOf('function extractPostDetails(options)');
const end = worker.indexOf('\n}\n', worker.indexOf('return out;', start));
const fnSrc = worker.slice(start, end + 2);

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
  let pass = 0, fail = 0;

  async function run(name, url, html, options, check) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await context.route('**/*', route => route.request().resourceType()==='document' ? route.fulfill({status:200,contentType:'text/html',body:html}) : route.fulfill({status:200,body:''}));
    await page.goto(url, { waitUntil:'domcontentloaded' }).catch(()=>{});
    const result = await page.evaluate(({fn, opts}) => { eval(fn); return extractPostDetails(opts); }, { fn: fnSrc, opts: options });
    console.log(`\n===== ${name} =====`);
    const ok = check(result);
    console.log(ok ? '✓ PASS' : '❌ FAIL', JSON.stringify(result));
    ok ? pass++ : fail++;
    await context.close();
  }
  const ALL = {date:true,likes:true,comments:true,shares:true};

  // 1. Facebook post — embedded JSON (the real reliable source)
  const FB_JSON = `<!DOCTYPE html><html><body><div>content</div>
    <script type="application/json">{"feedback":{"reaction_count":{"count":9600},"comment_count":{"total_count":456},"share_count":{"count":89}},"creation_time":1704883200,"video_view_count":152000}</script>
  </body></html>`;
  await run('Facebook post (embedded JSON)', 'https://www.facebook.com/reel/111', FB_JSON, ALL,
    r => r.Likes==='9600' && r.Comments==='456' && r.Shares==='89' && r.Date==='2024-01-10' && r.Views==='152000');

  // 2. Facebook reel — NO json, icon+number via aria-label (scanCount fallback)
  const FB_ICON = `<!DOCTYPE html><html><body>
    <div class="bar">
      <div class="act"><div role="button" aria-label="Like">♥</div><span>9.6K</span></div>
      <div class="act"><div role="button" aria-label="Comment">💬</div><span>456</span></div>
      <div class="act"><div role="button" aria-label="Share">↗</div><span>89</span></div>
    </div>
  </body></html>`;
  await run('Facebook reel (icon+number, no word)', 'https://www.facebook.com/reel/222', FB_ICON, ALL,
    r => r.Likes==='9.6K' && r.Comments==='456' && r.Shares==='89');

  // 3. Instagram reel — embedded JSON
  const IG_JSON = `<!DOCTYPE html><html><body>
    <script type="application/json">{"items":[{"edge_media_preview_like":{"count":12345},"edge_media_to_comment":{"count":678},"taken_at_timestamp":1710498600,"video_view_count":50000}]}</script>
  </body></html>`;
  await run('Instagram reel (embedded JSON)', 'https://www.instagram.com/reel/abc/', IG_JSON, ALL,
    r => r.Likes==='12345' && r.Comments==='678' && r.Date==='2024-03-15' && r.Shares==='' && r.Views==='50000');

  // 4. YouTube — embedded ytInitialData style
  const YT_JSON = `<!DOCTYPE html><html><body>
    <script>var ytInitialData = {"accessibilityText":"45,678 likes","commentCount":{"simpleText":"2,341"},"publishDate":"2024-01-05","viewCount":"1234567"};</script>
  </body></html>`;
  await run('YouTube watch (embedded JSON)', 'https://www.youtube.com/watch?v=abc', YT_JSON, ALL,
    r => r.Likes==='45,678' && r.Comments==='2,341' && r.Date==='2024-01-05' && r.Shares==='' && r.Views==='1234567');

  // 5. Instagram <time datetime> present (date gold standard)
  const IG_TIME = `<!DOCTYPE html><html><body>
    <time datetime="2024-05-20T08:00:00.000Z">May 20</time>
    <script type="application/json">{"edge_media_preview_like":{"count":999}}</script>
  </body></html>`;
  await run('Instagram date via <time>', 'https://www.instagram.com/reel/xyz/', IG_TIME, {date:true,likes:true},
    r => r.Date==='2024-05-20T08:00:00.000Z' && r.Likes==='999');

  // 6. Comment text
  const YTC = `<!DOCTYPE html><html><body>
    <ytd-comment-thread-renderer><div id="content-text">Great video!</div></ytd-comment-thread-renderer>
    <ytd-comment-thread-renderer><div id="content-text">Very helpful, thanks</div></ytd-comment-thread-renderer>
  </body></html>`;
  await run('YouTube comment text', 'https://www.youtube.com/watch?v=xyz', YTC, {commentText:true, maxComments:20},
    r => r.CommentText.includes('Great video!') && r.CommentText.includes('Very helpful'));

  console.log(`\n${'='.repeat(46)}\nRESULT: ${pass} passed, ${fail} failed\n${'='.repeat(46)}`);
  await browser.close();
  process.exit(fail?1:0);
})();
