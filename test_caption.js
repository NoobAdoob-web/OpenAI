const { chromium } = require('playwright');
const fs = require('fs');
const worker = fs.readFileSync('chrome-scraper-extension/background/service_worker.js', 'utf8');
const start = worker.indexOf('function extractPostDetails(options)');
const end = worker.indexOf('\n}\n', worker.indexOf('return out;', start));
const fnSrc = worker.slice(start, end + 2);

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
  let pass=0, fail=0;
  async function run(name, url, html, check) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await ctx.route('**/*', r => r.request().resourceType()==='document' ? r.fulfill({status:200,contentType:'text/html',body:html}) : r.fulfill({status:200,body:''}));
    await page.goto(url,{waitUntil:'domcontentloaded'}).catch(()=>{});
    const res = await page.evaluate(({fn,opts})=>{ eval(fn); return extractPostDetails(opts); }, {fn:fnSrc, opts:{date:true,likes:true,comments:true,shares:true}});
    console.log(`\n===== ${name} =====`);
    const ok = check(res); console.log(ok?'✓ PASS':'❌ FAIL', JSON.stringify(res));
    ok?pass++:fail++; await ctx.close();
  }

  // IG REEL page — caption in edge_media_to_caption, plus all metrics
  const IG_REEL = `<!DOCTYPE html><html><head><meta property="og:description" content="fallback"></head><body>
    <script type="application/json">{"items":[{"edge_media_to_caption":{"edges":[{"node":{"text":"Amazing sunset at the beach \\ud83c\\udf05 #travel #reels"}}]},"edge_media_preview_like":{"count":12345},"edge_media_to_comment":{"count":678},"video_view_count":98000,"taken_at_timestamp":1710498600}]}</script>
  </body></html>`;
  await run('IG REEL: caption + views + likes + comments', 'https://www.instagram.com/reel/abc/', IG_REEL,
    r => r.Caption.includes('Amazing sunset') && r.Views==='98000' && r.Likes==='12345' && r.Comments==='678');

  // IG POST page — caption + likes + comments (no views for image post)
  const IG_POST = `<!DOCTYPE html><html><body>
    <script type="application/json">{"edge_media_to_caption":{"edges":[{"node":{"text":"Our new product line is here!"}}]},"edge_media_preview_like":{"count":4500},"edge_media_to_comment":{"count":120}}</script>
  </body></html>`;
  await run('IG POST: caption + likes + comments', 'https://www.instagram.com/p/xyz/', IG_POST,
    r => r.Caption==='Our new product line is here!' && r.Likes==='4500' && r.Comments==='120');

  // FB post — message caption + reactions/comments/shares
  const FB = `<!DOCTYPE html><html><body>
    <script type="application/json">{"message":{"text":"Big announcement today!"},"feedback":{"reaction_count":{"count":9600},"comment_count":{"total_count":456},"share_count":{"count":89}},"creation_time":1704883200}</script>
  </body></html>`;
  await run('FB post: caption + reactions + comments + shares', 'https://www.facebook.com/reel/111', FB,
    r => r.Caption==='Big announcement today!' && r.Likes==='9600' && r.Comments==='456' && r.Shares==='89');

  // YouTube — title as caption
  const YT = `<!DOCTYPE html><html><head><title>My Great Video - YouTube</title></head><body>
    <script>var d={"title":{"runs":[{"text":"How to Analyze Social Media"}]},"accessibilityText":"45,678 likes","viewCount":"1234567"};</script>
  </body></html>`;
  await run('YouTube: title as caption + likes + views', 'https://www.youtube.com/watch?v=abc', YT,
    r => r.Caption==='How to Analyze Social Media' && r.Likes==='45,678' && r.Views==='1234567');

  console.log(`\n${'='.repeat(46)}\nRESULT: ${pass} passed, ${fail} failed\n${'='.repeat(46)}`);
  await browser.close();
  process.exit(fail?1:0);
})();
