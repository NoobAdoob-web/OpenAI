const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args:['--no-sandbox'] });
  const fs=require('fs');
  const contentScript=fs.readFileSync('chrome-scraper-extension/content/content.js','utf8');
  let pass=0, fail=0;

  // Realistic Amazon reviews DOM (data-hook attributes)
  const AMZ = `<!DOCTYPE html><html><body>
    <a data-hook="product-link">Acme Wireless Earbuds</a>
    <div id="cm_cr-review_list">
      ${[
        ['4.0','Great value','Sound is crisp and battery lasts long.','Rahul','Reviewed in India on 12 March 2024','avp','15 people found this helpful','Colour: Black'],
        ['5.0','Loved it','Best earbuds under 2000, highly recommend!','Priya','Reviewed in India on 2 April 2024','avp','40 people found this helpful','Colour: White'],
        ['2.0','Not durable','Stopped working after a month.','Amit','Reviewed in India on 1 February 2024','','3 people found this helpful','Colour: Black'],
      ].map(([r,t,b,who,date,avp,help,fmt])=>`
      <li data-hook="review">
        <span class="a-profile-name">${who}</span>
        <i data-hook="review-star-rating"><span class="a-icon-alt">${r} out of 5 stars</span></i>
        <a data-hook="review-title" href="/gp/customer-reviews/R${who}"><span>${r} out of 5 stars</span><span>${t}</span></a>
        <span data-hook="review-date">${date}</span>
        ${avp?'<span data-hook="avp-badge">Verified Purchase</span>':''}
        <span data-hook="format-strip">${fmt}</span>
        <span data-hook="review-body"><span>${b}</span></span>
        <span data-hook="helpful-vote-statement">${help}</span>
      </li>`).join('')}
    </div>
  </body></html>`;

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await ctx.route('**/*', r=> r.request().resourceType()==='document'? r.fulfill({status:200,contentType:'text/html',body:AMZ}) : r.fulfill({status:200,body:''}));
  await page.goto('https://www.amazon.in/product-reviews/B0ABCDEF/',{waitUntil:'domcontentloaded'}).catch(()=>{});
  const resp = await page.evaluate((cs)=>{
    window.chrome={ runtime:{ onMessage:{addListener:(fn)=>{window.__L__=fn;}}, onConnect:{addListener:()=>{}}, sendMessage:()=>{} }, storage:{session:{get:async()=>({}),set:async()=>{},remove:async()=>{}}} };
    try{ eval(cs); }catch(e){ return {boot:e.message}; }
    return new Promise(res=>window.__L__({action:'detect',tabId:1},{},res));
  }, contentScript);

  const rows = resp.data?.rows || [];
  console.log('== Amazon reviews ==');
  console.log('Detected rows:', rows.length, '| cols:', (resp.data?.headers||[]).length);
  console.log('Row1:', JSON.stringify(rows[0]));
  const ok1 = rows.length===3
    && rows[0].Rating.includes('4.0 out of 5') && rows[0]['Rating (number)']==='4.0'
    && rows[0].Title==='Great value' && rows[0].Review.includes('crisp')
    && rows[0].Reviewer==='Rahul' && rows[0].Date==='12 March 2024'
    && rows[0].Verified==='Yes' && rows[0]['Helpful (number)']==='15'
    && rows[0].Variant.includes('Black') && rows[0].Product==='Acme Wireless Earbuds';
  console.log(ok1?'✓ PASS extraction':'❌ FAIL extraction'); ok1?pass++:fail++;
  await ctx.close();

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  await browser.close(); process.exit(fail?1:0);
})();
