const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args:['--no-sandbox'] });
  const fs=require('fs');
  let pass=0, fail=0;

  // 1) Self-contained extractAmazonReviewsPage (from worker) against a fixture
  const worker=fs.readFileSync('chrome-scraper-extension/background/service_worker.js','utf8');
  const s=worker.indexOf('function extractAmazonReviewsPage'); const e=worker.indexOf('\n}\n', worker.indexOf('return items.map', s));
  const fn=worker.slice(s, e+2);
  const ctx=await browser.newContext(); const page=await ctx.newPage();
  const AMZ=`<!DOCTYPE html><html><head><title>Acme - Amazon</title></head><body><a data-hook="product-link">Acme Earbuds</a>
    ${[['5.0','Loved it','Amazing sound','Priya','on 2 April 2024','avp','40 people found this helpful'],
       ['5.0','Superb','Great buy','Ravi','on 5 April 2024','avp','12 people found this helpful']].map(([r,t,b,w,d,a,h])=>`
      <div data-hook="review"><span class="a-profile-name">${w}</span>
        <i data-hook="review-star-rating"><span class="a-icon-alt">${r} out of 5 stars</span></i>
        <a data-hook="review-title" href="/gp/customer-reviews/R${w}"><span>${r} out of 5 stars</span><span>${t}</span></a>
        <span data-hook="review-date">Reviewed in India ${d}</span>${a?'<span data-hook="avp-badge">Verified Purchase</span>':''}
        <span data-hook="review-body"><span>${b}</span></span><span data-hook="helpful-vote-statement">${h}</span></div>`).join('')}
  </body></html>`;
  await ctx.route('**/*', r=> r.request().resourceType()==='document'? r.fulfill({status:200,contentType:'text/html',body:AMZ}) : r.fulfill({status:200,body:''}));
  await page.goto('https://www.amazon.in/product-reviews/B0ABCDEF/?filterByStar=five_star&pageNumber=1',{waitUntil:'domcontentloaded'}).catch(()=>{});
  const rows=await page.evaluate((fn)=>{ eval(fn); return extractAmazonReviewsPage(); }, fn);
  const ok1 = rows.length===2 && rows[0].Title==='Loved it' && rows[0]['Rating (number)']==='5.0' && rows[0]['Helpful (number)']==='40' && rows[0].Reviewer==='Priya' && rows[0].Verified==='Yes';
  console.log('== self-contained extractor ==\n', (ok1?'✓ PASS':'❌ FAIL'), JSON.stringify(rows[0]));
  ok1?pass++:fail++;
  await ctx.close();

  // 2) Popup: review section shows on Amazon + Start sends correct targets/base
  const html=fs.readFileSync('chrome-scraper-extension/popup/popup.html','utf8').replace('<link rel="stylesheet" href="popup.css">','').replace('<script src="popup.js"></script>','');
  const js=fs.readFileSync('chrome-scraper-extension/popup/popup.js','utf8');
  const p2=await browser.newPage();
  const errs=[]; p2.on('pageerror',e=>errs.push(e.message));
  await p2.setContent(html);
  await p2.evaluate((js)=>{
    const headers=['Rating','Rating (number)','Title','Review','Reviewer','Date','Verified','Helpful','Helpful (number)','Variant','Product','URL'];
    const rows=[{Rating:'5 out of 5','Rating (number)':'5',Title:'t',Review:'b',Reviewer:'X',Date:'2024',Verified:'Yes',Helpful:'1','Helpful (number)':'1',Variant:'',Product:'Acme',URL:'https://amazon.in/p'}];
    window.__sent=[];
    window.chrome={ tabs:{ query:async()=>[{id:1, url:'https://www.amazon.in/dp/B0ABCDEFGH/'}], connect:()=>({}), sendMessage:async(t,m)=> m.action==='detect'?{data:{headers,rows},count:1,currentIndex:0}:{ok:true} },
      runtime:{ getManifest:()=>({version:'x'}), sendMessage:async(m)=>{window.__sent.push(m);return {};}, onMessage:{addListener:()=>{}}, connect:()=>({}) }, scripting:{executeScript:async()=>[{}]}, downloads:{download:()=>{}} };
    const s=document.createElement('script'); s.textContent=js; document.body.appendChild(s); document.dispatchEvent(new Event('DOMContentLoaded'));
  }, js);
  await p2.waitForTimeout(300);
  const secVisible = await p2.evaluate(()=>document.getElementById('review-section').style.display!=='none');
  const scrapeHidden = await p2.evaluate(()=>document.getElementById('scrape-section').style.display==='none');
  await p2.fill('#rev-5','30'); await p2.fill('#rev-4','0'); await p2.fill('#rev-3','0'); await p2.fill('#rev-2','10'); await p2.fill('#rev-1','5');
  await p2.click('#btn-review-start');
  await p2.waitForTimeout(100);
  const sent = await p2.evaluate(()=>window.__sent.find(m=>m.action==='startReviewCrawl'));
  console.log('\n== popup review crawl ==');
  console.log('Section visible on Amazon:', secVisible, '| scrape hidden:', scrapeHidden);
  console.log('Sent:', JSON.stringify(sent));
  const ok2 = secVisible && scrapeHidden && sent && sent.base==='https://www.amazon.in/product-reviews/B0ABCDEFGH/' && sent.targets.five_star===30 && sent.targets.two_star===10 && sent.targets.one_star===5 && sent.targets.four_star===0 && errs.length===0;
  console.log(ok2?'✓ PASS':'❌ FAIL', errs.length?('errors: '+errs.join(' | ')):'');
  ok2?pass++:fail++;

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  await browser.close(); process.exit(fail?1:0);
})();
