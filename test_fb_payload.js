/* Tests the network-payload parser against a REAL Facebook Reels response.
 *
 * The fixture is six complete profile_reel_node objects captured from a live
 * Samsung India page, so this proves the parser works on Facebook's actual
 * shape - not on a hand-written approximation of it.
 */
const fs = require('fs');
const vm = require('vm');

let pass = 0, fail = 0;
const ok = (n, c, extra) => { if (c) { console.log('  PASS', n); pass++; } else { console.log('  FAIL', n, extra || ''); fail++; } };

// Load net_hook.js the way the browser does: as a script in a window.
const src = fs.readFileSync('chrome-scraper-extension/content/net_hook.js', 'utf8');
const sandbox = {
  console,
  postMessage() {}, addEventListener() {},
  fetch() { return Promise.resolve(); },
  location: { href: 'https://www.facebook.com/SamsungIndia/reels/' },
  XMLHttpRequest: function () {},
};
sandbox.XMLHttpRequest.prototype = { open() {}, send() {} };
sandbox.window = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

ok('hook installs', sandbox.__SS_NET_HOOK__ === true);
ok('parser is reachable for testing', typeof sandbox.__SS_NET_PARSE__ === 'function');

const fixture = JSON.parse(fs.readFileSync('chrome-scraper-extension/tools/fixtures/fb_reel_nodes.json', 'utf8'));
const body = JSON.stringify({ data: { node: { aggregated_fb_shorts: { edges: fixture.nodes } } } });
const items = sandbox.__SS_NET_PARSE__(body);

console.log(`\n  parsed ${items.length} items from ${fixture.nodes.length} real reel nodes`);

// Keep only items keyed by a reel permalink id - that is what the content
// script can actually match a row against.
const byReel = new Map();
items.forEach(it => { if (/^\d{10,}$/.test(it.code)) byReel.set(it.code, it); });
const reels = [...byReel.values()];

ok('one item per reel, keyed by the permalink id', reels.length >= fixture.nodes.length,
  `${reels.length} reels from ${fixture.nodes.length} nodes`);

const withDate = reels.filter(r => r.taken > 0);
const withCaption = reels.filter(r => r.caption);
const withDur = reels.filter(r => r.duration > 0);
const withViews = reels.filter(r => r.views !== '' && r.views !== null);

ok('every reel has a creation date', withDate.length === reels.length,
  `${withDate.length}/${reels.length}`);
ok('every reel has a duration', withDur.length === reels.length,
  `${withDur.length}/${reels.length}`);
ok('every reel has a view count', withViews.length === reels.length,
  `${withViews.length}/${reels.length}`);
ok('most reels have a caption', withCaption.length >= Math.ceil(reels.length * 0.5),
  `${withCaption.length}/${reels.length}`);

// Dates must be sane, not epoch-zero or far-future.
const ymd = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const dates = withDate.map(r => ymd(r.taken)).sort();
ok('dates fall in a plausible range', dates.every(d => d >= '2020-01-01' && d <= '2027-01-01'),
  JSON.stringify(dates));

// The abbreviated view count must come back as a number, not "37K".
ok('abbreviated view counts are converted to numbers',
  withViews.every(r => typeof r.views === 'number' && r.views > 0),
  JSON.stringify(withViews.map(r => r.views)));
ok('view counts are realistic for a large page',
  withViews.every(r => r.views >= 100 && r.views < 1e9),
  JSON.stringify(withViews.map(r => r.views)));

// Durations are seconds, not milliseconds.
ok('durations are seconds, not milliseconds',
  withDur.every(r => r.duration > 0 && r.duration < 3600),
  JSON.stringify(withDur.map(r => Math.round(r.duration))));

console.log('\n  sample of what the parser now recovers:');
reels.slice(0, 4).forEach(r => {
  console.log(`    ${r.code}  ${ymd(r.taken)}  ${String(Math.round(r.duration)).padStart(3)}s  ` +
    `${String(r.views).padStart(8)} views  ${JSON.stringify((r.caption || '').slice(0, 44))}`);
});

// The abbreviation parser itself, including the cases that matter.
const abbrev = (v) => {
  const probe = JSON.stringify({ permalink_url: '/reel/1234567890123/', play_count_reduced: v, creation_time: 1793796313 });
  const got = sandbox.__SS_NET_PARSE__(probe);
  return got.length ? got[0].views : null;
};
console.log('\n  abbreviated count parsing');
ok('"37K" -> 37000', abbrev('37K') === 37000, String(abbrev('37K')));
ok('"1.2M" -> 1200000', abbrev('1.2M') === 1200000, String(abbrev('1.2M')));
ok('"149" -> 149', abbrev('149') === 149, String(abbrev('149')));
ok('"1,234" -> 1234', abbrev('1,234') === 1234, String(abbrev('1,234')));
ok('garbage -> no view count', abbrev('lots') === '' || abbrev('lots') === null, String(abbrev('lots')));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
