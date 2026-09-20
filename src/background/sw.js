import { upsertPosts, getPosts, patchPost, countPosts, clearLibrary, setMeta, getMeta } from '../lib/db.js';
import { filesFor } from '../lib/naming.js';

/** Files downloaded at once. Kept low deliberately — see PACE_MS. */
const CONCURRENCY = 2;
/**
 * Gap between starting one file and the next. This is the single most
 * important setting in the extension: downloading a thousand files as fast as
 * the network allows is exactly what gets an account rate-limited. Human pace.
 */
const PACE_MS = 700;

// --- download queue --------------------------------------------------------

const queue = {
  files: [],            // {shortcode, url, filename} still to start
  remaining: new Map(), // shortcode -> files not yet settled
  failures: new Map(),  // shortcode -> first error seen for that post
  inFlight: new Map(),  // chrome download id -> file
  active: 0,
  running: false,
  cancelled: false,
  total: 0,
  completed: 0,
  failed: 0,
  startedAt: null,
  label: '',
};

function resetQueue() {
  queue.files = [];
  queue.remaining.clear();
  queue.failures.clear();
  queue.inFlight.clear();
  queue.active = 0;
  queue.running = false;
  queue.cancelled = false;
  queue.total = 0;
  queue.completed = 0;
  queue.failed = 0;
  queue.startedAt = null;
  queue.label = '';
}

async function startDownloads(shortcodes) {
  if (queue.running) return { ok: false, reason: 'busy' };
  if (!shortcodes?.length) return { ok: false, reason: 'nothing-selected' };
  const posts = await getPosts(shortcodes);
  if (!posts.length) return { ok: false, reason: 'nothing-selected' };

  resetQueue();
  for (const post of posts) {
    const files = filesFor(post);
    if (!files.length) continue;
    queue.files.push(...files);
    queue.remaining.set(post.shortcode, files.length);
  }
  queue.total = queue.files.length;
  queue.running = true;
  queue.startedAt = Date.now();
  queue.label = `${posts.length} post${posts.length === 1 ? '' : 's'}`;

  pump();
  return { ok: true, total: queue.total, posts: posts.length };
}

function pump() {
  if (!queue.running || queue.cancelled) return;

  while (queue.active < CONCURRENCY && queue.files.length) {
    const file = queue.files.shift();
    queue.active++;
    chrome.downloads.download(
      { url: file.url, filename: file.filename, conflictAction: 'uniquify' },
      (downloadId) => {
        if (chrome.runtime.lastError || downloadId === undefined) {
          onFileFailed(file, chrome.runtime.lastError?.message || 'Download could not start');
        } else {
          queue.inFlight.set(downloadId, file);
        }
      }
    );
    // Stagger the next start rather than firing the whole batch at once.
    if (queue.files.length) {
      setTimeout(pump, PACE_MS);
      return;
    }
  }

  finishIfDone();
}

async function settlePost(shortcode) {
  const left = (queue.remaining.get(shortcode) ?? 1) - 1;
  queue.remaining.set(shortcode, left);
  if (left > 0) return;

  const error = queue.failures.get(shortcode) || null;
  await patchPost(shortcode, {
    downloadedAt: error ? null : Date.now(),
    downloadError: error,
  });
}

function onFileDone(file) {
  queue.active = Math.max(0, queue.active - 1);
  queue.completed++;
  settlePost(file.shortcode);
  pump();
}

function onFileFailed(file, message) {
  queue.active = Math.max(0, queue.active - 1);
  queue.failed++;
  if (!queue.failures.has(file.shortcode)) {
    // A 403 here almost always means the signed CDN link has expired rather
    // than anything being wrong — the fix is a re-scan, so say so.
    const expired = /403|forbidden|server failed|network/i.test(message || '');
    queue.failures.set(
      file.shortcode,
      expired ? 'Link expired — re-scan this collection, then download again' : message || 'Download failed'
    );
  }
  settlePost(file.shortcode);
  pump();
}

function finishIfDone() {
  if (queue.files.length || queue.active > 0) return;
  queue.running = false;
  setMeta('lastDownloadAt', Date.now());
}

chrome.downloads.onChanged.addListener((delta) => {
  const file = queue.inFlight.get(delta.id);
  if (!file) return;
  if (delta.state?.current === 'complete') {
    queue.inFlight.delete(delta.id);
    onFileDone(file);
  } else if (delta.state?.current === 'interrupted') {
    queue.inFlight.delete(delta.id);
    onFileFailed(file, delta.error?.current || 'Interrupted');
  }
});

function cancelDownloads() {
  queue.cancelled = true;
  queue.files = [];
  for (const id of queue.inFlight.keys()) chrome.downloads.cancel(id, () => void chrome.runtime.lastError);
  queue.inFlight.clear();
  queue.active = 0;
  queue.running = false;
  return { ok: true };
}

function status() {
  return {
    running: queue.running,
    total: queue.total,
    completed: queue.completed,
    failed: queue.failed,
    pending: queue.files.length + queue.active,
    label: queue.label,
    startedAt: queue.startedAt,
  };
}

// --- messaging -------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case 'posts:add': {
        const result = await upsertPosts(message.posts);
        await setMeta('lastScanAt', Date.now());
        sendResponse({ ok: true, ...result, libraryCount: await countPosts() });
        break;
      }
      case 'stats': {
        sendResponse({
          ok: true,
          count: await countPosts(),
          lastScanAt: await getMeta('lastScanAt'),
          lastDownloadAt: await getMeta('lastDownloadAt'),
        });
        break;
      }
      case 'download:start':
        sendResponse(await startDownloads(message.shortcodes || []));
        break;
      case 'download:status':
        sendResponse({ ok: true, ...status() });
        break;
      case 'download:cancel':
        sendResponse(cancelDownloads());
        break;
      case 'library:clear':
        await clearLibrary();
        sendResponse({ ok: true });
        break;
      case 'dashboard:open':
        chrome.tabs.create({ url: chrome.runtime.getURL('src/dashboard/dashboard.html') });
        sendResponse({ ok: true });
        break;
      default:
        sendResponse({ ok: false, reason: 'unknown-message' });
    }
  })();
  return true; // keep the channel open for the async reply
});

// --- right-click: save one post -------------------------------------------

const MENU_ID = 'saved-library-capture';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: 'Save this post to my library',
      contexts: ['link', 'image', 'video', 'page'],
      documentUrlPatterns: ['https://www.instagram.com/*'],
    });
  });
});

function notify(tabId, text) {
  chrome.tabs.sendMessage(tabId, { type: 'toast', text }, () => void chrome.runtime.lastError);
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: 'capture:here', info }, async (response) => {
    if (chrome.runtime.lastError || !response) return;
    if (!response.ok) {
      notify(
        tab.id,
        response.reason === 'not-loaded'
          ? "Couldn't read that post — open it, then try again"
          : "That doesn't look like a post"
      );
      return;
    }
    await upsertPosts([response.post]);
    const started = await startDownloads([response.post.shortcode]);
    notify(tab.id, started.ok ? 'Saved — downloading now' : 'Saved to your library');
  });
});
