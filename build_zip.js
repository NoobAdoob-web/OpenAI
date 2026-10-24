/* Builds the Chrome Web Store upload package.
 *
 * Ships only what the extension actually loads. Development material (docs,
 * the console capture tool, test fixtures) and modules that are built but not
 * yet wired to any UI are excluded: unreferenced files in a package invite
 * reviewer questions and add nothing for users.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SRC = path.resolve('chrome-scraper-extension');
const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
const OUT = path.resolve(`ScrapeSuite-v${manifest.version}.zip`);

// Development-only, or not referenced by any page yet.
const EXCLUDE = [
  'docs/*', 'tools/*',
  'popup/ads_analysis.js',   // wired in the v2.12 ad-library release
  'popup/ads_report.js',
  'STORE_SUBMISSION.txt', 'CHANGELOG.txt', 'README.txt',
  'icons/icon.svg',          // unreferenced, and an SVG icon once broke install

];

// Every file an HTML page or the manifest actually references must be present.
function referenced() {
  const want = new Set(['manifest.json']);
  const add = p => want.add(p.replace(/^\.?\//, ''));
  (manifest.content_scripts || []).forEach(cs => (cs.js || []).forEach(add));
  if (manifest.background && manifest.background.service_worker) add(manifest.background.service_worker);
  Object.values(manifest.icons || {}).forEach(add);
  Object.values((manifest.action || {}).default_icon || {}).forEach(add);
  if ((manifest.action || {}).default_popup) add(manifest.action.default_popup);
  for (const html of ['popup/popup.html', 'offscreen/ocr.html']) {
    const full = path.join(SRC, html);
    if (!fs.existsSync(full)) continue;
    add(html);
    const t = fs.readFileSync(full, 'utf8');
    for (const m of t.matchAll(/(?:src|href)="([^"]+)"/g)) {
      if (/^(https?:|data:)/.test(m[1])) continue;
      add(path.posix.normalize(path.posix.join(path.posix.dirname(html), m[1])));
    }
  }
  return want;
}

if (fs.existsSync(OUT)) fs.unlinkSync(OUT);
const args = ['-r', '-q', OUT, '.'];
EXCLUDE.forEach(p => { args.push('-x', p); });
execFileSync('zip', args, { cwd: SRC });

// Verify, rather than assume, that nothing referenced got excluded.
const listed = execFileSync('unzip', ['-Z1', OUT], { encoding: 'utf8' })
  .split('\n').map(s => s.trim()).filter(Boolean);
const inZip = new Set(listed);
const missing = [...referenced()].filter(f => !inZip.has(f));

console.log(`ScrapeSuite v${manifest.version}`);
console.log(`  ${OUT}`);
console.log(`  ${(fs.statSync(OUT).size / 1048576).toFixed(2)} MB, ${listed.length} files`);
if (missing.length) {
  console.log('  MISSING referenced files:', missing.join(', '));
  process.exit(1);
}
console.log('  every referenced file present');
