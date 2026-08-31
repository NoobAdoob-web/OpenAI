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
    window.chrome={
      tabs:{ query:async()=>[{id:1}], connect:()=>({}), sendMessage:async(t,m)=>{
        if(m.action==='detect') return {data:{headers:['Caption','Views','Views (number)','Likes','Likes (number)','Comments','Comments (number)','Duration (sec)','Date','URL'],rows:[
          {Caption:'newest',Views:'2M','Views (number)':'2000000',Likes:'100K','Likes (number)':'100000',Comments:'5K','Comments (number)':'5000','Duration (sec)':'30',Date:'2 days ago',URL:'https://www.instagram.com/reel/NEW/'},
          {Caption:'mid',Views:'500K','Views (number)':'500000',Likes:'40K','Likes (number)':'40000',Comments:'1K','Comments (number)':'1000','Duration (sec)':'90',Date:'',URL:'https://www.instagram.com/reel/MID/'},
          {Caption:'oldest',Views:'800K','Views (number)':'800000',Likes:'10K','Likes (number)':'10000',Comments:'2K','Comments (number)':'2000','Duration (sec)':'45',Date:'',URL:'https://www.instagram.com/reel/OLD/'}]},count:1,currentIndex:0};
        return {ok:true};
      }},
      runtime:{ getManifest:()=>({version:'2.3.0'}),
        sendMessage:async(m)=>{
          if(m.action==='getPostMeta'){
            // simulate exact-date fetch: NEW=2024-03-20, OLD=2023-11-01
            const meta={};
            meta['https://www.instagram.com/reel/NEW/']={date:'2024-03-20',durationSec:''};
            meta['https://www.instagram.com/reel/OLD/']={date:'2023-11-01',durationSec:''};
            return {ok:true, meta};
          }
          return {};
        }, onMessage:{addListener:()=>{}}, connect:()=>({}) },
      scripting:{executeScript:async()=>[{}]}, downloads:{download:(o)=>{window.__dl=o;}} };
    const s=document.createElement('script'); s.textContent=js; document.body.appendChild(s); document.dispatchEvent(new Event('DOMContentLoaded'));
  }, js);
  await page.waitForTimeout(600); // allow endpoint fetch to resolve

  const state = await page.evaluate(()=>{
    const items={}; document.querySelectorAll('#analysis-box .an-item').forEach(el=>{items[el.querySelector('.an-label').textContent]=el.querySelector('.an-val').textContent;});
    const insights=[...document.querySelectorAll('#analysis-insights li')].map(li=>li.textContent);
    const note=document.getElementById('analysis-note');
    return {items, insights, noteVisible: note.style.display!=='none', noteText: note.textContent};
  });
  console.log('Date range:', state.items['Date range']);
  console.log('First post:', state.items['First post'], '| Last post:', state.items['Last post']);
  console.log('Insights:'); state.insights.forEach(s=>console.log('  -',s));
  console.log('Note after fetch (should be hidden):', state.noteVisible);

  // (Excel content validated in test_xlsx.js.)
  const rangeOk = state.items['Date range']==='2023-11-01 → 2024-03-20';
  const insightsOk = state.insights.some(s=>s.includes('Most viewed')&&s.includes('newest')) && state.insights.some(s=>s.includes('Most liked'));
  const ok = rangeOk && state.items['First post']==='2024-03-20' && state.items['Last post']==='2023-11-01' && insightsOk && !state.noteVisible && errs.length===0;
  if(errs.length) console.log('ERRORS:', errs.join(' | '));
  console.log(ok?'✓ PASS — endpoint dates + insights work':'❌ FAIL');
  await browser.close(); process.exit(ok?0:1);
})();
