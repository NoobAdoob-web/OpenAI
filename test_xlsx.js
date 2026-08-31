// Generate a real .xlsx in the browser, then validate it with openpyxl:
// opens cleanly, two tabs, ranked order, Rank column, ANALYSIS block, columns
// ordered populated-first, Raw Data keeps scraped order, numbers preserved.
const { chromium } = require('playwright');
const fs = require('fs');
const { execSync } = require('child_process');
(async () => {
  const browser = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args:['--no-sandbox'] });
  const page = await browser.newPage();
  const errs=[]; page.on('pageerror',e=>errs.push(e.message));
  const html=fs.readFileSync('chrome-scraper-extension/popup/popup.html','utf8').replace('<link rel="stylesheet" href="popup.css">','').replace('<script src="popup.js"></script>','');
  const js=fs.readFileSync('chrome-scraper-extension/popup/popup.js','utf8');
  await page.setContent(html);
  await page.evaluate((js)=>{
    // scraped order C,A,B ; Shares blank; distinct from views ranking (A,B,C)
    const headers=['Caption','Views','Views (number)','Shares','Shares (number)','Date','URL'];
    const mk=(cap,v,vn,date)=>({Caption:cap,Views:v,'Views (number)':vn,Shares:'','Shares (number)':'',Date:date,URL:'https://x/'+cap});
    const rows=[mk('C','10K','10000','2024-01-01'),mk('A','2M','2000000','2024-03-01'),mk('B','500K','500000','2024-02-01')];
    window.chrome={ tabs:{ query:async()=>[{id:1,url:'https://www.instagram.com/u/reels/'}], connect:()=>({}), sendMessage:async(t,m)=> m.action==='detect'?{data:{headers,rows},count:1,currentIndex:0}:{ok:true} },
      runtime:{ getManifest:()=>({version:'x'}), sendMessage:async()=>({}), onMessage:{addListener:()=>{}}, connect:()=>({}) }, scripting:{executeScript:async()=>[{}]},
      downloads:{ download:(o)=>{ window.__dlUrl=o.url; window.__dlName=o.filename; } } };
    const s=document.createElement('script'); s.textContent=js; document.body.appendChild(s); document.dispatchEvent(new Event('DOMContentLoaded'));
  }, js);
  await page.waitForTimeout(400);
  const out = await page.evaluate(async ()=>{ document.getElementById('btn-xlsx').click(); await new Promise(r=>setTimeout(r,80)); if(!window.__dlUrl) return null; const buf=await (await fetch(window.__dlUrl)).arrayBuffer(); return { name:window.__dlName, b64:btoa(String.fromCharCode(...new Uint8Array(buf))) }; });
  await browser.close();
  if(errs.length){ console.log('PAGE ERRORS:', errs.join(' | ')); }
  if(!out){ console.log('❌ no download'); process.exit(1); }
  if(!out.name.endsWith('.xlsx')){ console.log('❌ filename not .xlsx:', out.name); process.exit(1); }
  fs.writeFileSync('/tmp/test_out.xlsx', Buffer.from(out.b64,'base64'));

  const py = `
import openpyxl,sys
wb=openpyxl.load_workbook('/tmp/test_out.xlsx')
ok=True
def chk(c,m):
    global ok
    print(('  OK ' if c else '  ❌ ')+m); ok = ok and c
chk(wb.sheetnames==['Top Performers','Raw Data'], 'two tabs: '+str(wb.sheetnames))
tp=[[c.value for c in r] for r in wb['Top Performers'].iter_rows()]
raw=[[c.value for c in r] for r in wb['Raw Data'].iter_rows()]
chk(any(r and r[0]=='ANALYSIS' for r in tp), 'Top Performers has ANALYSIS block')
chk(any(r and r[0]=='Date range' and '2024-01-01 to 2024-03-01' in str(r[1]) for r in tp), 'ANALYSIS has date range')
# header row = first row starting with 'Rank'
hdr=[i for i,r in enumerate(tp) if r and r[0]=='Rank']
chk(len(hdr)==1, 'Top Performers has Rank header')
hi=hdr[0]; header=tp[hi]; data=tp[hi+1:hi+4]
# ranked: first data row Caption should be A (2M)
capc=header.index('Caption')
chk(data[0][capc]=='A' and data[1][capc]=='B' and data[2][capc]=='C', 'Top Performers ranked A,B,C by views')
# Raw Data: scraped order C,A,B ; populated cols before blank Shares
rhdr=raw[0]
chk(rhdr.index('Views')<rhdr.index('Shares'), 'Raw Data: populated (Views) before blank (Shares)')
rcap=rhdr.index('Caption')
chk(raw[1][rcap]=='C' and raw[2][rcap]=='A' and raw[3][rcap]=='B', 'Raw Data keeps scraped order C,A,B')
vn=rhdr.index('Views (number)')
chk(raw[2][vn]==2000000 and isinstance(raw[2][vn],int), 'numeric Views(number) preserved as int')
print('RESULT: PASS' if ok else 'RESULT: FAIL')
sys.exit(0 if ok else 1)
`;
  try { const r=execSync('python3 -c "'+py.replace(/"/g,'\\"')+'"', {encoding:'utf8'}); console.log(r); process.exit(0); }
  catch(e){ console.log(e.stdout||'', e.stderr||''); process.exit(1); }
})();
