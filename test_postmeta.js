const fs=require('fs');
const src=fs.readFileSync('chrome-scraper-extension/background/service_worker.js','utf8');
const i=src.indexOf('async function fetchPostMeta'); const j=src.indexOf('\n}\n', src.indexOf('return { date, durationSec', i));
let body=src.slice(i,j+2);
let FIX=''; global.fetch=async()=>({ok:true,text:async()=>FIX});
eval('global.fetchPostMeta='+body.replace('async function fetchPostMeta','async function'));
(async()=>{
  let pass=0,fail=0; const t=async(n,url,html,chk)=>{FIX=html;const r=await fetchPostMeta(url);const ok=chk(r);console.log((ok?'✓':'❌')+' '+n+' → '+JSON.stringify(r));ok?pass++:fail++;};
  // IG: taken_at_timestamp 1710498600 = 2024-03-15 ; video_duration 62.5 → 63
  await t('IG date+dur','https://www.instagram.com/reel/a/','<script>{"taken_at_timestamp":1710498600,"video_duration":62.5}</script>', r=>r.date==='2024-03-15'&&r.durationSec===63);
  // FB creation_time 1704883200 = 2024-01-10 ; playable_duration_in_ms 95000 → 95
  await t('FB date+dur','https://www.facebook.com/reel/1','<script>{"creation_time":1704883200,"playable_duration_in_ms":95000}</script>', r=>r.date==='2024-01-10'&&r.durationSec===95);
  // YT publishDate + lengthSeconds
  await t('YT date+dur','https://www.youtube.com/watch?v=a','<script>{"publishDate":"2024-05-20","lengthSeconds":"623"}</script>', r=>r.date==='2024-05-20'&&r.durationSec===623);
  // YT ISO duration meta fallback
  await t('YT ISO dur','https://www.youtube.com/watch?v=b','<meta itemprop="datePublished" content="2024-06-01"><meta itemprop="duration" content="PT1H2M5S">', r=>r.date==='2024-06-01'&&r.durationSec===3725);
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})();
