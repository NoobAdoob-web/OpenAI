const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const ROOT = path.resolve('chrome-scraper-extension');
const types = {'.html':'text/html','.js':'text/javascript','.wasm':'application/wasm','.gz':'application/gzip'};
const server = http.createServer((req,res)=>{
  let p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(p,(e,buf)=>{ if(e){res.writeHead(404);res.end();return;} res.writeHead(200,{'Content-Type':types[path.extname(p)]||'application/octet-stream'}); res.end(buf); });
});
server.listen(0, async () => {
  const port = server.address().port;
  const browser = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args:['--no-sandbox'] });
  const page = await browser.newPage();
  page.on('console',m=>{});
  await page.goto(`http://127.0.0.1:${port}/tesseract/ocr-poc.html`, {waitUntil:'load'});
  const out = await page.waitForFunction(()=> window.__result || window.__err, {timeout:120000}).then(h=>h.jsonValue()).catch(()=> 'TIMEOUT');
  const res = await page.evaluate(()=>({r:window.__result,e:window.__err}));
  console.log('RESULT:', JSON.stringify(res));
  await browser.close(); server.close();
  const text=(res.r&&res.r.text||'').toUpperCase();
  const ok = text.includes('50') && (text.includes('OFF')||text.includes('SALE')||text.includes('FLAT'));
  console.log(ok? '\n✓ PASS — Tesseract OCR works from local files' : '\n❌ FAIL');
  process.exit(ok?0:1);
});
