/**
 * Loads the background service worker with the Chrome APIs stubbed out and
 * drives its message handler, to catch anything it references but never
 * declares. Run with: node tests/worker.test.mjs
 */
import assert from 'node:assert/strict';

const listeners = { message: null, installed: null, downloadChanged: null, menuClicked: null };
const downloads = [];

globalThis.chrome = {
  runtime: {
    lastError: null,
    onMessage: { addListener: (fn) => (listeners.message = fn) },
    onInstalled: { addListener: (fn) => (listeners.installed = fn) },
    getURL: (path) => `chrome-extension://test/${path}`,
  },
  downloads: {
    onChanged: { addListener: (fn) => (listeners.downloadChanged = fn) },
    download: (options, cb) => {
      downloads.push(options);
      cb?.(downloads.length);
    },
    cancel: (_id, cb) => cb?.(),
  },
  contextMenus: {
    removeAll: (cb) => cb?.(),
    create: () => {},
    onClicked: { addListener: (fn) => (listeners.menuClicked = fn) },
  },
  tabs: { create: () => {}, sendMessage: () => {} },
};
globalThis.indexedDB = { open: () => ({}) };

await import('../src/background/sw.js');

const ask = (message) =>
  new Promise((resolve) => {
    const handled = listeners.message(message, {}, resolve);
    assert.equal(handled, true, 'the handler must keep the reply channel open');
  });

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('the worker registers all of its listeners on load', () => {
  assert.ok(listeners.message, 'message listener');
  assert.ok(listeners.downloadChanged, 'download listener');
  assert.ok(listeners.menuClicked, 'context menu listener');
  assert.ok(listeners.installed, 'install listener');
});

test('reporting status works before anything has been downloaded', async () => {
  const status = await ask({ type: 'download:status' });
  assert.equal(status.ok, true);
  assert.deepEqual(
    { running: status.running, total: status.total, completed: status.completed, failed: status.failed },
    { running: false, total: 0, completed: 0, failed: 0 }
  );
});

test('cancelling when idle is harmless', async () => {
  assert.deepEqual(await ask({ type: 'download:cancel' }), { ok: true });
});

test('downloading nothing is refused rather than crashing', async () => {
  const result = await ask({ type: 'download:start', shortcodes: [] });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'nothing-selected');
});

test('unknown messages get a clean answer', async () => {
  assert.deepEqual(await ask({ type: 'nonsense' }), { ok: false, reason: 'unknown-message' });
});

test('a download event for an unknown file is ignored', () => {
  listeners.downloadChanged({ id: 999, state: { current: 'complete' } });
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
