/* Tests post-date recovery.
 *
 * The shortcode -> media id step is checked against the published test
 * vectors from an independent implementation, so this is not our own code
 * agreeing with itself. The epoch is pinned by a real post whose date is
 * externally knowable: DCF76aqtL2Y is MLB's World Series trophy photoshoot,
 * and the 2024 World Series ended 2024-10-30.
 */
const D = require('./chrome-scraper-extension/content/post_dates.js');

let pass = 0, fail = 0;
const ok = (n, c, extra) => { if (c) { console.log('  PASS', n); pass++; } else { console.log('  FAIL', n, extra || ''); fail++; } };

console.log('shortcode -> media id (vectors from an independent implementation)');
[
  [1724590456043472323n, 'Bfu-eHrgAXD'],
  [2448037011284432259n, 'CH5LLEGnhWD'],
  [1032176n, 'D7_w'],
  [1056959166906215431n, '6rEsMliawH'],
  [2461113606337266768n, 'CInockRnQRQ'],
  [1n, 'B'],
].forEach(([want, sc]) => {
  ok(`${sc} -> ${want}`, D.shortcodeToId(sc) === want, String(D.shortcodeToId(sc)));
});

console.log('\nepoch pinned by a post with an externally knowable date');
const mlb = D.igDateFromShortcode('DCF76aqtL2Y');
ok('MLB World Series trophy post decodes to Nov 2024',
  D.ymd(mlb) === '2024-11-08', D.ymd(mlb));
ok('...which is after the 2024 World Series ended (2024-10-30)',
  mlb.getTime() > new Date('2024-10-30').getTime(), D.ymd(mlb));

console.log('\nshortcode era ordering (B~2017-18, C~2020-21, D~2024+)');
const era = ['BWsP42nAHbD', 'Bfu-eHrgAXD', 'CG53Utagki0', 'CH5LLEGnhWD', 'DCF76aqtL2Y']
  .map(s => ({ s, t: D.igDateFromShortcode(s).getTime() }));
ok('decoded dates increase with shortcode era',
  era.every((e, i) => i === 0 || e.t > era[i - 1].t),
  JSON.stringify(era.map(e => e.s + '=' + D.ymd(new Date(e.t)))));

console.log('\nurl parsing');
ok('/p/ url', D.ymd(D.igDateFromUrl('https://www.instagram.com/p/DCF76aqtL2Y/')) === '2024-11-08');
ok('/reel/ url', D.ymd(D.igDateFromUrl('https://www.instagram.com/mlb/reel/DCF76aqtL2Y/')) === '2024-11-08');
ok('url with query string',
  D.ymd(D.igDateFromUrl('https://www.instagram.com/p/DCF76aqtL2Y/?img_index=1')) === '2024-11-08');
ok('profile url yields nothing', D.igDateFromUrl('https://www.instagram.com/samsungindia/') === null);
ok('non-instagram url yields nothing', D.igDateFromUrl('https://youtube.com/watch?v=abc') === null);
ok('empty input is safe', D.igDateFromUrl('') === null && D.igDateFromUrl(null) === null);

console.log('\nguards against nonsense output');
ok('absurdly long code rejected', D.igDateFromShortcode('ZZZZZZZZZZZZZZZZ') === null);
ok('future-dated code rejected', D.igDateFromShortcode('ZZZZZZZZZZZ') === null,
  String(D.igDateFromShortcode('ZZZZZZZZZZZ')));
ok('invalid alphabet rejected', D.igDateFromShortcode('abc$def!ghi') === null);

console.log('\nyoutube relative dates');
const NOW = new Date('2026-11-03T12:00:00Z').getTime();
const rel = (t) => D.dateFromRelative(t, NOW);
ok('"5 days ago"', D.ymd(rel('5 days ago').date) === '2026-10-29', D.ymd(rel('5 days ago').date));
ok('"1 day ago"', D.ymd(rel('1 day ago').date) === '2026-11-02', D.ymd(rel('1 day ago').date));
ok('"3 weeks ago"', D.ymd(rel('3 weeks ago').date) === '2026-10-13', D.ymd(rel('3 weeks ago').date));
ok('"Streamed 2 hours ago" tolerated', rel('Streamed 2 hours ago') !== null);
ok('day-level is marked precise', rel('5 days ago').precision === 'day');
ok('month-level is marked approximate', rel('3 months ago').precision === 'approx');
ok('year-level is marked approximate', rel('2 years ago').precision === 'approx');
ok('no match returns null', rel('yesterday') === null);

console.log('\nresolvePostDate picks the best source');
ok('existing exact date is never overwritten',
  D.resolvePostDate({ Date: '2025-01-02', URL: 'https://www.instagram.com/p/DCF76aqtL2Y/' }).source === 'existing');
ok('instagram url resolves with no network',
  D.resolvePostDate({ URL: 'https://www.instagram.com/p/DCF76aqtL2Y/' }).ymd === '2024-11-08');
ok('resolved instagram date is marked exact',
  D.resolvePostDate({ URL: 'https://www.instagram.com/p/DCF76aqtL2Y/' }).precision === 'exact');
ok('youtube row falls back to the relative string',
  D.resolvePostDate({ URL: 'https://youtube.com/watch?v=x', _relativeDate: '5 days ago' }, NOW).source === 'relative');
ok('row with nothing usable returns null',
  D.resolvePostDate({ URL: 'https://example.com/x' }) === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
