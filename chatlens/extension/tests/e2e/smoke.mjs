// End-to-end test of the poll check: loads the BUILT extension into Chromium,
// opens fake WhatsApp Web pages (four variants), clicks "Check votes" like a
// user and checks the exact lists. Run after `npm run build`: npm run smoke
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const { chromium } = await import(process.env.PLAYWRIGHT_PATH ?? 'playwright');
const ext = resolve('.output/chrome-mv3');
const outDir = resolve('tests/e2e/screenshots');
mkdirSync(outDir, { recursive: true });
const fake = readFileSync(resolve('tests/e2e/fake-whatsapp.html'), 'utf8');

let failures = 0;

async function scenario(variant, run) {
  const ctx = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  const requests = [];
  ctx.on('request', (r) => requests.push(r.url()));
  await ctx.route('https://web.whatsapp.com/**', (route) => route.fulfill({ contentType: 'text/html', body: fake }));

  const wa = await ctx.newPage();
  await wa.goto(`https://web.whatsapp.com/?variant=${variant}`);
  await wa.waitForFunction(() => window.__fakeReady === true);

  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  const [waTab] = await sw.evaluate(() => chrome.tabs.query({ url: 'https://web.whatsapp.com/*' }));

  // In real use the side panel sits next to the WhatsApp tab. Here it is its
  // own page, so point its "active tab" lookup at the WhatsApp tab.
  const panel = await ctx.newPage();
  await panel.addInitScript((tab) => {
    chrome.tabs.query = async () => [tab];
  }, waTab);
  await panel.setViewportSize({ width: 380, height: 1000 });
  await panel.goto(`chrome-extension://${extId}/sidepanel.html`);

  const see = async (text) => {
    try {
      await panel.getByText(text, { exact: false }).first().waitFor({ timeout: 8000 });
    } catch {
      throw new Error(`did not see "${text}"`);
    }
  };
  const list = () => panel.locator('.people li').allInnerTexts();

  try {
    await run({ panel, see, list, wa });
    if (await wa.evaluate(() => window.__momentOpened === true)) throw new Error('opened a module that must never be opened (WAWebMoment-*)');
    const outside = requests.filter((u) => !u.startsWith('https://web.whatsapp.com/') && !u.startsWith('chrome-extension://'));
    if (outside.length) throw new Error(`unexpected network requests: ${outside.join(', ')}`);
    await panel.screenshot({ path: `${outDir}/${variant}.png`, fullPage: true });
    console.log(`PASS  ${variant}`);
  } catch (e) {
    failures++;
    await panel.screenshot({ path: `${outDir}/${variant}-FAILED.png`, fullPage: true });
    console.error(`FAIL  ${variant}: ${e.message}`);
  } finally {
    await ctx.close();
  }
}

// Phone numbers appear next to names only when WhatsApp shows them; compare names and options.
const flat = (xs) => xs.map((x) => x.replace(/\s+/g, ' ').replace(/ \+\d+$/, '').trim());
const expectList = async (list, expected, what) => {
  const got = flat(await list());
  if (JSON.stringify(got) !== JSON.stringify(expected)) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
};

async function fullPollCheck({ panel, see, list }, sourcesText) {
  await see('Found polls in this chat');
  await see('Sunday Cricket Club');
  const pollCount = await panel.locator('select option').count();
  if (pollCount !== 2) throw new Error(`expected 2 polls in the picker, got ${pollCount} (vote messages must not be listed)`);
  // Newest poll is preselected.
  const selected = await panel.locator('select').evaluate((s) => s.options[s.selectedIndex].text);
  if (!selected.startsWith('Coming on Sunday?')) throw new Error(`wrong poll preselected: ${selected}`);
  await panel.getByRole('button', { name: 'Check votes' }).click();
  await see("6 members · 4 voted · 2 haven't voted · 1 voted, then left");
  await see(sourcesText);
  // Votes by option count current members only (Vikram left, so he isn't in "Yes").
  const optionCounts = flat(await panel.locator('.options li').allInnerTexts());
  if (JSON.stringify(optionCounts) !== JSON.stringify(['Yes 3', 'No 1'])) throw new Error(`Votes by option: got ${JSON.stringify(optionCounts)}`);
  await expectList(list, ['Priya', '~ Rahul'], "Haven't voted");
  await panel.getByRole('button', { name: 'Voted (4)' }).click();
  await expectList(list, ['Gaurav Yes', 'Hansika No', 'Rahul Yes', 'You Yes'], 'Voted');
  await panel.getByRole('button', { name: 'Voted, then left (1)' }).click();
  await expectList(list, ['Vikram'], 'Voted, then left');
  // The result must survive the background status refresh.
  await panel.getByRole('button', { name: "Haven't voted (2)" }).click();
  await panel.waitForTimeout(3000);
  await see("6 members · 4 voted · 2 haven't voted");
  // Details for Claude must never contain names or numbers (rule P1).
  await panel.getByRole('button', { name: 'Copy details for Claude' }).click();
  const details = await panel.locator('textarea').inputValue();
  for (const secret of ['Gaurav', 'Priya', 'Sunday', 'Coming', '919800', '770000']) {
    if (details.includes(secret)) throw new Error(`details leaked "${secret}"`);
  }
}

await scenario('modern', (t) => fullPollCheck(t, 'Votes read from two places in WhatsApp Web, and they agree.'));
await scenario('encrypted', async ({ panel, see, list }) => {
  await see('Found polls in this chat');
  await panel.getByRole('button', { name: 'Check votes' }).click();
  await see("7 members · 4 voted · 3 haven't voted · 1 voted, then left");
  await see('Votes could be read from one place only.');
  const optionCounts = flat(await panel.locator('.options li').allInnerTexts());
  if (JSON.stringify(optionCounts) !== JSON.stringify(['Yes 3', 'No 1'])) throw new Error(`Votes by option: got ${JSON.stringify(optionCounts)}`);
  await expectList(list, ['Neha', 'Priya', '~ Rahul'], "Haven't voted");
  // Tapping an option lists the people who picked it; tapping it again closes the list.
  await panel.locator('.options button', { hasText: 'Yes' }).click();
  await see('Picked “Yes” (3)');
  await expectList(list, ['Gaurav', 'Rahul', 'You'], 'Picked Yes');
  await panel.locator('.options button', { hasText: 'No' }).click();
  await expectList(list, ['Hansika'], 'Picked No');
  await panel.locator('.options button', { hasText: 'No' }).click();
  await expectList(list, ['Neha', 'Priya', '~ Rahul'], "Haven't voted (after closing an option)");
  await panel.getByRole('button', { name: 'Voted (4)' }).click();
  await expectList(list, ['Gaurav Yes', 'Hansika No', 'Rahul Yes', 'You Yes'], 'Voted');
});
await scenario('legacy', (t) => fullPollCheck(t, 'Votes could be read from one place only.'));
// No database converter here, so the database route is (correctly) dropped as unreadable.
await scenario('mixed', (t) => fullPollCheck(t, 'Votes could be read from one place only.'));
await scenario('unreadable', async ({ see, panel }) => {
  await see('Found polls in this chat');
  await panel.getByRole('button', { name: 'Check votes' }).click();
  await see("Couldn't read the votes on this poll from WhatsApp Web.");
  if (await panel.locator('.people li').count()) throw new Error('showed a list although votes were unreadable');
});
await scenario('dm', async ({ see, panel }) => {
  await see('The open chat is not a group. Open a group that has a poll.');
  if (await panel.getByRole('button', { name: 'Check votes' }).count()) throw new Error('Check votes shown outside a group');
});

if (failures) {
  console.error(`${failures} scenario(s) failed. Screenshots in tests/e2e/screenshots/`);
  process.exit(1);
}
console.log('All poll scenarios passed. Screenshots in tests/e2e/screenshots/');
