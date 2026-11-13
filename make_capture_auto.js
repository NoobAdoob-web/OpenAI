/* Regenerates tools/capture_facebook_auto.js = the capture tool plus a
 * runner, so a user can paste one file and type nothing afterwards. */
const fs = require('fs');
const src = fs.readFileSync('chrome-scraper-extension/tools/capture_ads_payloads.js', 'utf8');
fs.writeFileSync('chrome-scraper-extension/tools/capture_facebook_auto.js', src + `
/* ── Auto-run ──────────────────────────────────────────────────────────────
 * Generated file: the capture tool above, plus a runner, so the whole job is
 * one paste with nothing to type afterwards.
 * Regenerate with: node make_capture_auto.js
 */
window.__ssCapture.autoRun(25);
`);
console.log('regenerated tools/capture_facebook_auto.js');
