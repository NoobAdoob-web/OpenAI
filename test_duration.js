const { chromium } = require('playwright');
const fs = require('fs');
const worker = fs.readFileSync('chrome-scraper-extension/background/service_worker.js','utf8');
const start = worker.indexOf('function extractPostDetails(options)');
const end = worker.indexOf('\n}\n', worker.indexOf('return out;', start));
const fnSrc = worker.slice(start, end+2);
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
  let pass=0, fail=0;
  async function run(name,url,html,check){
    const ctx=await browser.newContext(); const page=await ctx.newPage();
    await ctx.route('**/*', r=> r.request().resourceType()==='document'? r.fulfill({status:200,contentType:'text/html',body:html}) : r.fulfill({status:200,body:''}));
    await page.goto(url,{waitUntil:'domcontentloaded'}).catch(()=>{});
    const res=await page.evaluate(({fn,opts})=>{eval(fn);return extractPostDetails(opts);},{fn:fnSrc,opts:{date:true,likes:true,comments:true,shares:true}});
    console.log(`\n== ${name} ==`); const ok=check(res); console.log(ok?'✓ PASS':'❌ FAIL', JSON.stringify({Duration:res.Duration,DurationSec:res.DurationSec}));
    ok?pass++:fail++; await ctx.close();
  }
  await run('IG reel duration (video_duration 62.5s)', 'https://www.instagram.com/reel/a/',
    `<html><body><script type="application/json">{"video_duration":62.5,"edge_media_preview_like":{"count":10}}</script></body></html>`,
    r=> r.Duration==='1:03' && r.DurationSec==='63');
  await run('FB reel duration (playable_duration_in_ms 95000)', 'https://www.facebook.com/reel/1',
    `<html><body><script type="application/json">{"playable_duration_in_ms":95000,"feedback":{"reaction_count":{"count":5}}}</script></body></html>`,
    r=> r.Duration==='1:35' && r.DurationSec==='95');
  await run('YouTube duration (lengthSeconds 623)', 'https://www.youtube.com/watch?v=a',
    `<html><body><script>var d={"lengthSeconds":"623","viewCount":"100"};</script></body></html>`,
    r=> r.Duration==='10:23' && r.DurationSec==='623');
  await run('YouTube duration (approxDurationMs 3725000)', 'https://www.youtube.com/watch?v=b',
    `<html><body><script>var d={"approxDurationMs":"3725000"};</script></body></html>`,
    r=> r.Duration==='1:02:05' && r.DurationSec==='3725');
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  await browser.close(); process.exit(fail?1:0);
})();
