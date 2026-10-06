// End-to-end smoke test: loads the BUILT extension into Chromium, opens a fake
// WhatsApp Web page, drives the side panel and takes screenshots.
// Run after `npm run build`: node tests/e2e/smoke.mjs
// Needs Playwright (set PLAYWRIGHT_PATH if it isn't importable as "playwright").
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const { chromium } = await import(process.env.PLAYWRIGHT_PATH ?? 'playwright');
const ext = resolve('.output/chrome-mv3');
const outDir = resolve('tests/e2e/screenshots');
mkdirSync(outDir, { recursive: true });
const fake = readFileSync(resolve('tests/e2e/fake-whatsapp.html'), 'utf8');

const ctx = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
const requests = [];
ctx.on('request', (r) => requests.push(r.url()));
await ctx.route('https://web.whatsapp.com/**', (route) => route.fulfill({ contentType: 'text/html', body: fake }));

const wa = await ctx.newPage();
await wa.goto('https://web.whatsapp.com/');
await wa.waitForFunction(() => window.__fakeReady === true);

let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host;
const [waTab] = await sw.evaluate(() => chrome.tabs.query({ url: 'https://web.whatsapp.com/*' }));

// In real use the side panel sits next to the WhatsApp tab. Here it is opened
// as its own page, so point its "active tab" lookup at the WhatsApp tab.
const panel = await ctx.newPage();
await panel.addInitScript((tab) => {
  chrome.tabs.query = async () => [tab];
}, waTab);
await panel.setViewportSize({ width: 380, height: 900 });
await panel.goto(`chrome-extension://${extId}/sidepanel.html`);

const fail = (msg) => {
  console.error('SMOKE TEST FAILED:', msg);
  process.exit(1);
};
const expectText = async (text) => {
  try {
    await panel.getByText(text, { exact: false }).first().waitFor({ timeout: 10000 });
  } catch {
    await panel.screenshot({ path: `${outDir}/failure.png`, fullPage: true });
    fail(`did not see "${text}"`);
  }
};

await expectText('Ready');
await expectText("Found WhatsApp Web's data");
await expectText('Read members of the open group');
await expectText('Read messages in the open chat · 4 messages');
await panel.getByRole('button', { name: 'Check poll' }).click();
await expectText("6 members · 4 voted · 2 haven't voted · 1 voted, then left");
const notVoted = await panel.locator('.people li').allInnerTexts();
if (notVoted.length !== 2 || !notVoted[0].startsWith('Priya') || !notVoted[1].startsWith('Rahul')) fail(`wrong "haven't voted" list: ${notVoted}`);
await panel.screenshot({ path: `${outDir}/poll-check.png`, fullPage: true });

await panel.getByRole('button', { name: 'Voted, left (1)' }).click();
await expectText('Vikram');

await panel.getByRole('button', { name: 'Measure' }).click();
await expectText('Loaded in WhatsApp Web right now: 6 messages in 2 chats.');
await expectText('Stored on this computer: 253 messages in 2 chats.');
await expectText('Text is readable.');

// The poll result must survive the 2-second status refresh.
await panel.waitForTimeout(4500);
await expectText("6 members · 4 voted · 2 haven't voted");

await panel.getByRole('button', { name: 'Copy diagnostics' }).click();
const diag = await panel.locator('textarea').inputValue();
for (const secret of ['Gaurav', 'Priya', 'electrician', '919800', 'Coming on Sunday']) {
  if (diag.includes(secret)) fail(`diagnostics leaked "${secret}" (rule P1)`);
}
await panel.screenshot({ path: `${outDir}/coverage-and-diagnostics.png`, fullPage: true });

const outside = requests.filter((u) => !u.startsWith('https://web.whatsapp.com/') && !u.startsWith('chrome-extension://'));
if (outside.length) fail(`unexpected network requests: ${outside.join(', ')}`);

console.log('Smoke test passed. Screenshots in tests/e2e/screenshots/');
await ctx.close();
