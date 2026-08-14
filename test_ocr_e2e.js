const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const ROOT = path.resolve('chrome-scraper-extension');
const types = {'.html':'text/html','.js':'text/javascript','.wasm':'application/wasm','.gz':'application/gzip'};
const server = http.createServer((req,res)=>{ let p=path.join(ROOT, decodeURIComponent(req.url.split('?')[0])); fs.readFile(p,(e,b)=>{ if(e){res.writeHead(404);res.end();return;} res.writeHead(200,{'Content-Type':types[path.extname(p)]||'application/octet-stream'}); res.end(b); }); });

// classifier/lang from worker
const src = fs.readFileSync('chrome-scraper-extension/background/service_worker.js','utf8');
const g = (n)=>{const i=src.indexOf('function '+n);const j=src.indexOf('\n}\n',i);return src.slice(i,j+2);};

server.listen(0, async ()=>{
  const port = server.address().port;
  const browser = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args:['--no-sandbox'] });
  const page = await browser.newPage();
  // Minimal harness page that loads tesseract and mimics ocr.js recognize
  await page.goto(`http://127.0.0.1:${port}/tesseract/tesseract.min.js`).catch(()=>{});
  await page.setContent('<body></body>');
  await page.addScriptTag({ url: `http://127.0.0.1:${port}/tesseract/tesseract.min.js` });

  async function ocr(text){
    return await page.evaluate(async ({txt, port})=>{
      const c=document.createElement('canvas'); c.width=680;c.height=160;
      const x=c.getContext('2d'); x.fillStyle='#fff';x.fillRect(0,0,680,160);
      x.fillStyle='#000'; x.font='bold 44px Arial'; x.fillText(txt,15,95);
      const url=c.toDataURL('image/png');
      const w=await Tesseract.createWorker(['eng','hin'],1,{
        workerPath:`http://127.0.0.1:${port}/tesseract/worker.min.js`,
        corePath:`http://127.0.0.1:${port}/tesseract/tesseract-core-simd-lstm.wasm.js`,
        langPath:`http://127.0.0.1:${port}/tesseract/lang/`, workerBlobURL:false, gzip:true });
      const {data}=await w.recognize(url); await w.terminate();
      return { text:(data.text||'').trim(), conf:Math.round(data.confidence||0) };
    }, {txt:text, port});
  }

  // Node-side classify
  eval(g('detectLanguage')); eval(g('classifyContent'));

  let pass=0, fail=0;
  const cases = [
    { img:'FLAT 50% OFF SALE', wantType:'Offer-led', wantLang:'English' },
    { img:'Happy Diwali Wishes', wantType:'Festive', wantLang:'English' },
    { img:'Introducing New MAK Oil', wantType:'Product-led', wantLang:'English' },
  ];
  for(const cse of cases){
    const r = await ocr(cse.img);
    const lang = detectLanguage(r.text, r.conf);
    const type = classifyContent(r.text);
    const ok = lang===cse.wantLang && type===cse.wantType;
    console.log(`${ok?'✓':'❌'} img="${cse.img}" → OCR="${r.text}" conf=${r.conf} | Type=${type} Lang=${lang}`);
    ok?pass++:fail++;
  }
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  await browser.close(); server.close();
  process.exit(fail?1:0);
});
