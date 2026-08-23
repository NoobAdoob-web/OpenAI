// Test the correlation engine: build rows where offer-posts get more comments
// and "MAK" mentions get more views, then verify buildInsights surfaces them.
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args:['--no-sandbox'] });
  const page = await browser.newPage();
  const fs=require('fs');
  const js=fs.readFileSync('chrome-scraper-extension/popup/popup.js','utf8');
  await page.setContent('<body></body>');

  // Extract just the functions we need by evaluating the whole file's function decls.
  // Easiest: eval the file in a stubbed env where DOM/chrome calls aren't triggered
  // (buildInsights/topKeyword/numFmt/secFmt are pure function declarations).
  const result = await page.evaluate((js)=>{
    // Provide stubs so top-level references don't throw when the script defines listeners
    window.chrome = { runtime:{ getManifest:()=>({version:'x'}), onMessage:{addListener:()=>{}}, sendMessage:()=>{}, connect:()=>({}) }, tabs:{query:async()=>[{id:1}],connect:()=>({}),sendMessage:async()=>({})}, downloads:{download:()=>{}}, scripting:{executeScript:async()=>[{}]} };
    document.addEventListener = ()=>{}; // prevent bootstrap
    const s=document.createElement('script'); s.textContent=js; document.body.appendChild(s);

    // Build dataset: 10 posts.
    // - 4 posts mention "MAK" brand → high views
    // - 4 posts mention offer/discount → high comments
    const rows = [];
    const mk = (caption, views, likes, comments) => ({ Caption:caption, 'Views (number)':String(views), 'Likes (number)':String(likes), 'Comments (number)':String(comments), 'Shares (number)':'0' });
    // MAK brand posts (high views ~1M), low-ish comments
    rows.push(mk('MAK Lubricants keeps your engine strong', 1000000, 5000, 100));
    rows.push(mk('New MAK oil launch event', 1200000, 6000, 120));
    rows.push(mk('MAK performance range explained', 900000, 4000, 90));
    rows.push(mk('Why MAK is the best choice', 1100000, 5500, 110));
    // Offer posts (high comments ~2000), lower views
    rows.push(mk('Flat 50% OFF this week only! Grab the discount', 300000, 3000, 2000));
    rows.push(mk('Mega SALE — offer ends tonight, comment to win', 250000, 2500, 2200));
    rows.push(mk('Special discount deal inside, limited offer', 280000, 2800, 1900));
    rows.push(mk('Biggest sale of the year, up to 70% off', 320000, 3200, 2100));
    // filler
    rows.push(mk('A nice sunset view from the hills', 200000, 1500, 80));
    rows.push(mk('Team outing photos from last weekend', 180000, 1400, 70));

    const insights = buildInsights(rows);
    const kw = topKeyword(rows);
    return { insights, kw };
  }, js);

  console.log('Top keyword:', result.kw);
  console.log('Insights:');
  result.insights.forEach(s=>console.log('  •', s));

  const joined = result.insights.join(' | ').toLowerCase();
  const hasOfferComments = /offer\/discount get [\d.]+× more comments/.test(joined);
  const hasBrandViews = result.kw==='mak' && /mention “mak” get [\d.]+× more views/i.test(result.insights.join(' | '));
  console.log('\nDetected "offers → more comments":', hasOfferComments);
  console.log('Detected "MAK → more views":', hasBrandViews);
  const ok = hasOfferComments && hasBrandViews;
  console.log('\n'+(ok?'✓ PASS — correlation insights work':'❌ FAIL'));
  await browser.close(); process.exit(ok?0:1);
})();
