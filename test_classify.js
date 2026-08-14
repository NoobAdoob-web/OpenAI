// Unit-test the pure classifier + language detection from the worker file
const fs = require('fs');
const src = fs.readFileSync('chrome-scraper-extension/background/service_worker.js','utf8');
// pull the two functions out and eval them
const g = (name) => { const i=src.indexOf('function '+name); const j=src.indexOf('\n}\n', i); return src.slice(i, j+2); };
eval(g('detectLanguage'));
eval(g('classifyContent'));

let pass=0, fail=0;
const t=(name,got,exp)=>{ const ok=got===exp; console.log((ok?'✓':'❌')+' '+name+` → got "${got}"`+(ok?'':` (exp "${exp}")`)); ok?pass++:fail++; };

console.log('== Content type ==');
t('Flat 50% off sale',      classifyContent('FLAT 50% OFF SALE. Shop now!'), 'Offer-led');
t('Discount coupon',        classifyContent('Use coupon SAVE20 for extra discount'), 'Offer-led');
t('Rupee price',            classifyContent('Now at ₹499 only'), 'Offer-led');
t('Diwali greetings',       classifyContent('Happy Diwali! Wishing you joy'), 'Festive');
t('Eid wishes',             classifyContent('Eid Mubarak to all'), 'Festive');
t('Product launch',         classifyContent('Introducing the all-new MAK engine oil'), 'Product-led');
t('Feature blurb',          classifyContent('Superior protection. Available now in stores'), 'Product-led');
t('Plain info',             classifyContent('Soil productivity map of Kerala'), 'Informational');

console.log('\n== Language ==');
t('English high conf',      detectLanguage('FLAT 50% OFF SALE', 92), 'English');
t('Hindi devanagari',       detectLanguage('नमस्ते दोस्तों खुशखबरी', 88), 'Hindi');
t('Low-conf garbage',       detectLanguage('xzq ~~ ||', 30), 'Regional / Other');
t('Empty',                  detectLanguage('', 0), '');

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
