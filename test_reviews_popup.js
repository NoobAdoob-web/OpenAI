const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args:['--no-sandbox'] });
  const page = await browser.newPage();
  const errs=[]; page.on('pageerror',e=>errs.push(e.message));
  const fs=require('fs');
  const html=fs.readFileSync('chrome-scraper-extension/popup/popup.html','utf8').replace('<link rel="stylesheet" href="popup.css">','').replace('<script src="popup.js"></script>','');
  const js=fs.readFileSync('chrome-scraper-extension/popup/popup.js','utf8');
  await page.setContent(html);
  await page.evaluate((js)=>{
    const headers=['Rating','Rating (number)','Title','Review','Reviewer','Date','Verified','Helpful','Helpful (number)','Variant','Product','URL'];
    const mk=(rn,title,help,ver)=>({Rating:rn+' out of 5','Rating (number)':rn,Title:title,Review:title+' body',Reviewer:'X',Date:'2024',Verified:ver?'Yes':'','Helpful':help,'Helpful (number)':help,Variant:'','Product':'Acme',URL:'https://amazon.in/p'});
    const rows=[mk('4','Great value','15',true),mk('5','Loved it','40',true),mk('2','Not durable','3',false)];
    window.chrome={ tabs:{ query:async()=>[{id:1}], connect:()=>({}), sendMessage:async(t,m)=> m.action==='detect'?{data:{headers,rows},count:1,currentIndex:0}:{ok:true} },
      runtime:{ getManifest:()=>({version:'x'}), sendMessage:async()=>({}), onMessage:{addListener:()=>{}}, connect:()=>({}) }, scripting:{executeScript:async()=>[{}]}, downloads:{download:(o)=>{window.__dl=o;}} };
    const s=document.createElement('script'); s.textContent=js; document.body.appendChild(s); document.dispatchEvent(new Event('DOMContentLoaded'));
  }, js);
  await page.waitForTimeout(300);

  const st = await page.evaluate(()=>{
    const headers=[...document.querySelectorAll('#preview-table thead th')].map(t=>t.textContent);
    const row1=[...document.querySelectorAll('#preview-table tbody tr:first-child td')].map(t=>t.textContent);
    const anItems={}; document.querySelectorAll('#analysis-box .an-item').forEach(el=>{anItems[el.querySelector('.an-label').textContent]=el.querySelector('.an-val').textContent;});
    const insTitle=document.querySelector('#analysis-insights .in-title')?.textContent;
    const ins=[...document.querySelectorAll('#analysis-insights li')].map(li=>li.textContent);
    return {headers,row1,anItems,insTitle,ins};
  });
  console.log('Header[0]:', st.headers[0], '| ranked row1 title:', st.row1[st.headers.indexOf('Title')]);
  console.log('Analysis:', JSON.stringify(st.anItems));
  console.log('Insights title:', st.insTitle); st.ins.forEach(s=>console.log('  •',s));

  // Ranked by Helpful → row1 should be "Loved it" (40 helpful)
  const rankOk = st.headers[0]==='Rank' && st.row1[st.headers.indexOf('Title')]==='Loved it';
  const anaOk = st.anItems['Reviews']==='3' && st.anItems['Avg rating']==='3.67 / 5' && st.anItems['Verified']==='67%';
  const insOk = st.insTitle==='Review Insights' && st.ins.some(s=>s.includes('Average rating')) && st.ins.some(s=>s.includes('Most helpful'));
  const ok = rankOk && anaOk && insOk && errs.length===0;
  if(errs.length) console.log('ERRORS:', errs.join(' | '));
  console.log('\nRank by helpful:', rankOk, '| Review analysis:', anaOk, '| Review insights:', insOk);
  console.log(ok?'✓ PASS — review ranking + analysis':'❌ FAIL');
  await browser.close(); process.exit(ok?0:1);
})();
