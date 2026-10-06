// Release check for rule P2: the built extension may talk only to
// web.whatsapp.com (and, from Phase 4, the licence server and payment pages).
// It fails on any network function and on any web address not listed below.
import { builtFiles } from './build-files.mjs';

const ALLOWED_HOSTS = ['web.whatsapp.com'];

// Addresses that appear inside libraries as plain labels and are never fetched:
// XML namespace names (React), React's error-help link, JSON-schema IDs (zod).
const LABELS_NOT_FETCHED = [/^https?:\/\/www\.w3\.org\//, /^https:\/\/react\.dev\/errors\//, /^https?:\/\/json-schema\.org\//];

const NETWORK_APIS = [/\bfetch\(/, /XMLHttpRequest/, /new WebSocket/, /sendBeacon/, /new EventSource/, /importScripts\(/];

const problems = [];
const notes = new Set();
for (const { path, text } of builtFiles()) {
  for (const re of NETWORK_APIS) if (re.test(text)) problems.push(`${path}: uses a network function (${re})`);
  for (const url of text.match(/https?:\/\/[^\s"'`)<>\\]+/g) ?? []) {
    if (LABELS_NOT_FETCHED.some((re) => re.test(url))) continue;
    let host;
    try {
      host = new URL(url).hostname;
    } catch {
      // A code template, not a real address (zod builds one to validate URLs).
      // Listed so a human sees it; it does not fail the check.
      notes.add(`${path}: address template ${url}`);
      continue;
    }
    if (!ALLOWED_HOSTS.includes(host)) problems.push(`${path}: unexpected address ${url}`);
  }
}
if (problems.length) {
  console.error('NETWORK CHECK FAILED (rule P2):\n' + [...new Set(problems)].join('\n'));
  process.exit(1);
}
for (const n of notes) console.log(`note: ${n}`);
console.log(`Network check passed: no network functions; only ${ALLOWED_HOSTS.join(', ')} is addressed.`);
