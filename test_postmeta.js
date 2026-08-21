// getPostMeta now opens a real tab and runs extractPostDetails (same as Deep
// Scrape). Here we verify (a) normalizeDate and (b) that extractPostDetails
// reads the exact date from a rendered post page — the two pieces getPostMeta
// depends on. (The tab-opening itself is the same proven path as Deep Scrape.)
const { chromium } = require('playwright');
const fs = require('fs');
const src = fs.readFileSync('chrome-scraper-extension/background/service_worker.js','utf8');

// --- normalizeDate unit test (pure) ---
const i = src.indexOf('function normalizeDate'); const j = src.indexOf('\n}\n', i);
eval(src.slice(i, j+2).replace('function normalizeDate','global.normalizeDate = function'));
let pass=0, fail=0;
const t=(n,g,e)=>{const ok=g===e;console.log((ok?'✓':'❌')+' '+n+' → '+g);ok?pass++:fail++;};
t('ISO datetime → date', normalizeDate('2024-03-15T10:30:00.000Z'), '2024-03-15');
t('plain date', normalizeDate('2024-06-01'), '2024-06-01');
t('Month DD, YYYY', normalizeDate('January 5, 2024'), '2024-01-05');
t('empty', normalizeDate(''), '');

// --- extractPostDetails reads Date from a rendered IG post (via tab) ---
const s2 = src.indexOf('function extractPostDetails(options)');
const e2 = src.indexOf('\n}\n', src.indexOf('return out;', s2));
const fn = src.slice(s2, e2+2);
(async()=>{
  const browser = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args:['--no-sandbox'] });
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  const IG = `<!DOCTYPE html><html><body><time datetime="2024-03-15T10:30:00.000Z">Mar 15</time>
    <script type="application/json">{"taken_at_timestamp":1710498600,"video_duration":45}</script></body></html>`;
  await ctx.route('**/*', r=> r.request().resourceType()==='document'? r.fulfill({status:200,contentType:'text/html',body:IG}) : r.fulfill({status:200,body:''}));
  await page.goto('https://www.instagram.com/reel/abc/',{waitUntil:'domcontentloaded'}).catch(()=>{});
  const res = await page.evaluate((fn)=>{ eval(fn); return extractPostDetails({date:true}); }, fn);
  const nd = normalizeDate(res.Date);
  const ok = nd==='2024-03-15' && String(res.DurationSec)==='45';
  console.log((ok?'✓':'❌')+' extractPostDetails via tab → Date='+res.Date+' ('+nd+') DurationSec='+res.DurationSec);
  ok?pass++:fail++;
  await browser.close();
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})();
