/* Tests product detection, including against the captions from five real
 * exports - so "it works" means it works on the data users actually produce,
 * not on examples chosen to suit the code. */
const P = require('./chrome-scraper-extension/content/products.js');

let pass = 0, fail = 0;
const ok = (n, c, extra) => { if (c) { console.log('  PASS', n); pass++; } else { console.log('  FAIL', n, extra || ''); fail++; } };
const has = (text, name) => P.detectProducts(text).some(p => P.key(p) === P.key(name));

console.log('the rule that matters: a qualifier makes a DIFFERENT product');
ok('S26 and S26 FE are not the same product',
  !has('Meet the Galaxy S26 FE', 'Galaxy S26'), JSON.stringify(P.detectProducts('Meet the Galaxy S26 FE')));
ok('S26 FE detected as its own product', has('Meet the Galaxy S26 FE', 'Galaxy S26 FE'));
ok('S26 Ultra detected as its own product', has('Meet the Galaxy S26 Ultra', 'Galaxy S26 Ultra'));
ok('plain S26 still detected when nothing qualifies it',
  has('Meet the Galaxy S26 today', 'Galaxy S26'), JSON.stringify(P.detectProducts('Meet the Galaxy S26 today')));

console.log('\nhashtags');
ok('#GalaxyZFold8 splits correctly', has('#GalaxyZFold8', 'Galaxy Z Fold8'));
ok('#GalaxyZFold8Ultra splits digit->capital', has('#GalaxyZFold8Ultra', 'Galaxy Z Fold8 Ultra'),
  JSON.stringify(P.detectProducts('#GalaxyZFold8Ultra')));
ok('a slogan hashtag is NOT a product',
  !P.detectProducts('#WelcomeToGalaxyS').length, JSON.stringify(P.detectProducts('#WelcomeToGalaxyS')));
ok('#Samsung alone is not a product', !P.detectProducts('#Samsung #India').length);

console.log('\nrunning text');
ok('single-letter series marker survives (Galaxy Z Flip8)',
  has('How to Use Mirror View | Galaxy Z Flip8 | Samsung', 'Galaxy Z Flip8'),
  JSON.stringify(P.detectProducts('How to Use Mirror View | Galaxy Z Flip8 | Samsung')));
ok('a trailing lone letter is not glued on',
  !has('Galaxy S26 FE I love the colour', 'Galaxy S26 FE I'),
  JSON.stringify(P.detectProducts('Galaxy S26 FE I love the colour')));
ok('"Welcome to Galaxy S..." yields no product',
  !P.detectProducts('Welcome to the world of Galaxy').length);

console.log('\nfeatures and sub-brands are not products');
ok('Galaxy AI is excluded - it spans every device',
  !has('Powered by Galaxy AI', 'Galaxy AI'), JSON.stringify(P.detectProducts('Powered by Galaxy AI')));
ok('bare "Samsung Galaxy" is excluded', !has('Samsung Galaxy Smartphones', 'Samsung Galaxy'));

console.log('\nlines with no model number');
ok('Galaxy A Series', has('Galaxy A Series | How do I fix my boss’s face?', 'Galaxy A Series'));
ok('SmartThings Pro', has('SmartThings Pro: Smarter Control', 'SmartThings Pro'));
ok('bare "TV" counts as a television', has('Samsung Vision AI TV', 'Television'));
ok('washing machine', has('Our new front load washing machine', 'Washing machine'));

console.log('\nmerging: same product, two spellings');
const disc = P.discoverProducts([
  { Caption: 'Galaxy S26 FE launch' }, { Caption: 'S26 FE in stores now' },
  { Caption: 'Galaxy S26 Ultra launch' },
]);
const names = disc.products.map(p => p.name);
ok('"S26 FE" folds into "Galaxy S26 FE"',
  names.includes('Galaxy S26 FE') && !names.includes('S26 FE'), JSON.stringify(names));
ok('merged count adds up', (disc.products.find(p => p.name === 'Galaxy S26 FE') || {}).count === 2,
  JSON.stringify(disc.products));
ok('S26 Ultra stays separate from S26 FE', names.includes('Galaxy S26 Ultra'), JSON.stringify(names));

console.log('\nunmatched rows are surfaced, not swallowed');
const u = P.discoverProducts([{ Caption: 'Samsung Week is back' }, { Caption: 'Galaxy S26 FE' }]);
ok('unmatched counted', u.unmatched === 1, String(u.unmatched));
ok('total reported', u.total === 2);

// ── Against the real exports ─────────────────────────────────────────────
console.log('\nreal captions from five live exports');
const REAL = require('./chrome-scraper-extension/tools/fixtures/real_captions.json');
const r = P.discoverProducts(REAL.captions.map(c => ({ Caption: c })));
const rate = r.unmatched / r.total;
ok('at least 80% of captions yield a product', rate <= 0.20,
  `${r.unmatched}/${r.total} unmatched (${Math.round(rate * 100)}%)`);
ok('the top product is a real product, not a feature',
  !/galaxy ai|^samsung$|^galaxy$/i.test(r.products[0].name), r.products[0].name);
ok('S26 FE discovered and merged', r.products.some(p => p.name === 'Galaxy S26 FE' && p.count >= 7),
  JSON.stringify(r.products.slice(0, 3)));
ok('no product name contains a stray trailing capital',
  !r.products.some(p => /\s[A-Z]$/.test(p.name)), JSON.stringify(r.products.map(p => p.name)));
ok('no slogan leaked in as a product',
  !r.products.some(p => /welcome|celebrate|festive|discover/i.test(p.name)),
  JSON.stringify(r.products.map(p => p.name)));

console.log(`\n   discovered: ${r.products.map(p => p.name + '(' + p.count + ')').join(', ')}`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
