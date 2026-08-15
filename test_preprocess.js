const http=require('http'),fs=require('fs'),path=require('path');
const { chromium }=require('playwright');
const ROOT=path.resolve('chrome-scraper-extension');
const types={'.html':'text/html','.js':'text/javascript','.wasm':'application/wasm','.gz':'application/gzip'};
const server=http.createServer((req,res)=>{let p=path.join(ROOT,decodeURIComponent(req.url.split('?')[0]));fs.readFile(p,(e,b)=>{if(e){res.writeHead(404);res.end();return;}res.writeHead(200,{'Content-Type':types[path.extname(p)]||'application/octet-stream'});res.end(b);});});
server.listen(0, async ()=>{
  const port=server.address().port;
  const browser=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome',args:['--no-sandbox']});
  const page=await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/_harness.html`,{waitUntil:'load'});

  const result = await page.evaluate(async (port)=>{
    // Simulate a SMALL, low-res reel thumbnail (~260px wide) with colored text on a busy bg
    function makeThumb(){
      const c=document.createElement('canvas'); c.width=260;c.height=200; const x=c.getContext('2d');
      // busy gradient background
      const g=x.createLinearGradient(0,0,260,200); g.addColorStop(0,'#1b3a2f'); g.addColorStop(1,'#0d47a1');
      x.fillStyle=g; x.fillRect(0,0,260,200);
      x.fillStyle='#ffd54f'; x.font='bold 26px Arial'; x.fillText('FLAT 50% OFF',12,60);
      x.fillStyle='#ffffff'; x.font='bold 20px Arial'; x.fillText('MEGA SALE',12,110);
      return c.toDataURL('image/png');
    }
    const dataUrl=makeThumb();

    function loadImage(src){return new Promise((r,j)=>{const i=new Image();i.onload=()=>r(i);i.onerror=j;i.src=src;});}
    async function preprocess(du){
      const img=await loadImage(du); const longest=Math.max(img.width,img.height)||1;
      const scale=Math.min(4,Math.max(1,1600/longest)); const w=Math.round(img.width*scale),h=Math.round(img.height*scale);
      const c=document.createElement('canvas'); c.width=w;c.height=h; const x=c.getContext('2d',{willReadFrequently:true});
      x.imageSmoothingEnabled=true;x.imageSmoothingQuality='high'; x.drawImage(img,0,0,w,h);
      const id=x.getImageData(0,0,w,h),d=id.data,contrast=1.5;
      for(let i=0;i<d.length;i+=4){let g=0.299*d[i]+0.587*d[i+1]+0.114*d[i+2];g=(g-128)*contrast+128;g=g<0?0:g>255?255:g;d[i]=d[i+1]=d[i+2]=g;}
      x.putImageData(id,0,0); return c;
    }

    const opts={workerPath:`http://127.0.0.1:${port}/tesseract/worker.min.js`,corePath:`http://127.0.0.1:${port}/tesseract/tesseract-core-simd-lstm.wasm.js`,langPath:`http://127.0.0.1:${port}/tesseract/lang/`,workerBlobURL:false,gzip:true};
    const w=await Tesseract.createWorker(['eng','hin'],1,opts);
    const raw=await w.recognize(dataUrl);
    const pre=await w.recognize(await preprocess(dataUrl));
    await w.terminate();
    return { raw:{text:raw.data.text.trim().replace(/\n/g,' '),conf:Math.round(raw.data.confidence)}, pre:{text:pre.data.text.trim().replace(/\n/g,' '),conf:Math.round(pre.data.confidence)} };
  }, port);

  console.log('RAW  (no preprocess):', JSON.stringify(result.raw));
  console.log('PRE  (preprocessed) :', JSON.stringify(result.pre));
  const norm=s=>s.toUpperCase().replace(/[^A-Z0-9]/g,'');
  const preHits = ['50','OFF','SALE','FLAT','MEGA'].filter(k=>norm(result.pre.text).includes(k)).length;
  const rawHits = ['50','OFF','SALE','FLAT','MEGA'].filter(k=>norm(result.raw.text).includes(k)).length;
  console.log(`Keyword hits — raw:${rawHits}/5  preprocessed:${preHits}/5`);
  const ok = preHits >= rawHits && preHits >= 3;
  console.log('\n'+(ok?'✓ PASS — preprocessing keeps/improves accuracy on small thumbnails':'❌ FAIL'));
  await browser.close(); server.close(); process.exit(ok?0:1);
});
