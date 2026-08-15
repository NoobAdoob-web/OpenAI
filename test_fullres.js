// Unit-test getFullResImage's URL parsing (pure string logic, no network)
const fs = require('fs');
const src = fs.readFileSync('chrome-scraper-extension/background/service_worker.js','utf8');
const i = src.indexOf('async function getFullResImage');
const j = src.indexOf('\n}\n', i);
let body = src.slice(i, j+2);
// stub fetch to feed fixture HTML
let FIXTURE = '';
global.fetch = async () => ({ ok:true, text: async () => FIXTURE });
eval('global.getFullResImage = ' + body.replace('async function getFullResImage','async function'));

(async () => {
  let pass=0, fail=0;
  const t = async (name, url, fixture, check) => { FIXTURE = fixture; const r = await getFullResImage(url); const ok = check(r); console.log((ok?'✓':'❌')+' '+name+' → '+r); ok?pass++:fail++; };

  await t('YouTube watch → maxres', 'https://www.youtube.com/watch?v=aBc123XyZ', '', r => r==='https://i.ytimg.com/vi/aBc123XyZ/maxresdefault.jpg');
  await t('YouTube shorts → maxres', 'https://www.youtube.com/shorts/QQ99ww11', '', r => r==='https://i.ytimg.com/vi/QQ99ww11/maxresdefault.jpg');
  await t('IG og:image', 'https://www.instagram.com/reel/abc/',
    '<html><head><meta property="og:image" content="https://scontent.cdninstagram.com/v/full123.jpg?a=1&amp;b=2"></head></html>',
    r => r==='https://scontent.cdninstagram.com/v/full123.jpg?a=1&b=2');
  await t('IG display_url fallback', 'https://www.instagram.com/p/xyz/',
    '<html><body><script>{"display_url":"https:\\/\\/scontent.cdn\\/hi\\u0026res.jpg"}</script></body></html>',
    r => r==='https://scontent.cdn/hi&res.jpg');
  await t('FB og:image reversed attrs', 'https://www.facebook.com/reel/111',
    '<meta content="https://fb.cdn/cover.jpg" property="og:image">',
    r => r==='https://fb.cdn/cover.jpg');
  await t('No image found', 'https://www.instagram.com/p/none/', '<html><head></head></html>', r => r==='');

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail?1:0);
})();
