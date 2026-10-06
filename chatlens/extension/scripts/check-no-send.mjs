// Release check for rule S1: scan the BUILT package for forbidden send calls.
// The code checker (lint) catches them in our source; this catches anything a
// dependency might have pulled in. Only code that runs inside WhatsApp Web
// (content scripts) is scanned for the Enter key: the side panel's React
// library legitimately contains the word "Enter" and cannot reach WhatsApp.
import { FORBIDDEN_NAMES, FORBIDDEN_STRINGS } from '../lint-rules/no-send.js';
import { builtFiles } from './build-files.mjs';

const problems = [];
for (const { path, text } of builtFiles()) {
  for (const s of [...FORBIDDEN_NAMES, ...FORBIDDEN_STRINGS]) if (text.includes(s)) problems.push(`${path}: contains "${s}"`);
  if (path.includes('content-scripts')) {
    for (const re of [/new KeyboardEvent/, /["'`](Numpad)?Enter["'`]/, /\.click\(\)/]) {
      if (re.test(text)) problems.push(`${path}: matches ${re}`);
    }
  }
}
if (problems.length) {
  console.error('NO-SEND CHECK FAILED (rule S1):\n' + problems.join('\n'));
  process.exit(1);
}
console.log('No-send check passed: no send calls, no simulated Enter, no programmatic clicks.');
