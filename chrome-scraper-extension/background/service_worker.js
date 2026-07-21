'use strict';

// In-memory relay state: tabId -> { selector, selectorText, crawlRows, crawlPage, crawlComplete, crawlPages }
// Using chrome.storage.session for persistence across service worker sleep cycles
const STORE_PREFIX = 'ids_tab_';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id ?? msg.tabId;

  if (msg.type === 'pickerSelected') {
    storeTabState(tabId, { selector: msg.selector, selectorText: msg.selectorText });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'crawlProgress') {
    storeTabState(tabId, { crawlRows: msg.allRows, crawlPage: msg.page, crawlComplete: false });
    // Relay to popup (no-op if popup is closed)
    chrome.runtime.sendMessage(msg).catch(() => {});
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'crawlComplete') {
    storeTabState(tabId, {
      crawlRows: msg.allRows,
      crawlPage: msg.pages,
      crawlPages: msg.pages,
      crawlComplete: true
    });
    chrome.runtime.sendMessage(msg).catch(() => {});
    sendResponse({ ok: true });
    return true;
  }

  if (msg.action === 'getTabState') {
    getTabState(msg.tabId).then(state => sendResponse(state || {}));
    return true;
  }

  if (msg.action === 'setTabState') {
    storeTabState(msg.tabId, msg.state).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.action === 'clearTabState') {
    chrome.storage.session.remove(STORE_PREFIX + msg.tabId).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.action === 'startDeepScrape') {
    startDeepScrape(msg).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.action === 'stopDeepScrape') {
    DEEP.active = false;
    sendResponse({ ok: true });
    return true;
  }

  return false;
});

// ══════════════════════════════════════════════════════════════════════════
//  DEEP SCRAPE — opens each post URL in a hidden tab, extracts the fields the
//  user selected, then closes the tab. Uses the user's own logged-in session.
// ══════════════════════════════════════════════════════════════════════════
const DEEP = { active: false };

async function startDeepScrape(msg) {
  const { urls, options, delayMs } = msg;
  const popupTabId = msg.tabId;
  DEEP.active = true;

  const results = {};                       // url -> extracted fields
  const gap = Math.max(800, delayMs || 2500);
  let done = 0;

  for (const url of urls) {
    if (!DEEP.active) break;
    try {
      results[url] = await openAndExtract(url, options);
    } catch (e) {
      results[url] = { _error: String(e).slice(0, 120) };
    }
    done++;
    // Report progress to the popup (no-op if popup is closed)
    chrome.runtime.sendMessage({
      type: 'deepProgress', done, total: urls.length, url, fields: results[url]
    }).catch(() => {});
    if (done < urls.length && DEEP.active) await sleep(gap);
  }

  DEEP.active = false;
  chrome.runtime.sendMessage({ type: 'deepComplete', results, count: done }).catch(() => {});
}

// Open one URL in an inactive tab, wait for it to load + render, run the
// extractor, then close the tab.
async function openAndExtract(url, options) {
  let tab;
  try {
    tab = await chrome.tabs.create({ url, active: false });
  } catch (e) {
    return { _error: 'could not open tab' };
  }
  const tabId = tab.id;
  try {
    await waitForComplete(tabId, 20000);
    await sleep(2500); // let the SPA render like/comment counts

    // Retry extraction up to 3 times if counts haven't rendered yet
    let data = {};
    for (let attempt = 0; attempt < 3; attempt++) {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        func: extractPostDetails,
        args: [options],
      });
      data = res?.result || {};
      const gotSomething = data.Date || data.Likes || data.Comments || data.Shares || data.CommentText;
      if (gotSomething) break;
      await sleep(1500);
    }
    return data;
  } finally {
    try { await chrome.tabs.remove(tabId); } catch (_) {}
  }
}

function waitForComplete(tabId, timeout) {
  return new Promise(resolve => {
    let settled = false;
    const finish = () => { if (!settled) { settled = true; chrome.tabs.onUpdated.removeListener(listener); resolve(); } };
    const listener = (id, info) => { if (id === tabId && info.status === 'complete') finish(); };
    chrome.tabs.onUpdated.addListener(listener);
    // Check current state immediately too
    chrome.tabs.get(tabId).then(t => { if (t.status === 'complete') finish(); }).catch(() => {});
    setTimeout(finish, timeout);
  });
}

// ── The per-post extractor (INJECTED into each post tab) ───────────────────
// Must be fully self-contained — it runs in the target page, not here.
// options: { date, likes, comments, shares, commentText, maxComments }
function extractPostDetails(options) {
  const host = location.hostname;
  const out = {};
  const bodyText = (document.body && document.body.innerText) || '';

  const grab = (re, src) => { const m = (src || bodyText).match(re); return m ? m[1].trim() : ''; };

  // ── Date ──
  if (options.date) {
    const timeEl = document.querySelector('time[datetime]');
    if (timeEl) {
      out.Date = timeEl.getAttribute('datetime') || timeEl.textContent.trim();
    } else if (/youtube/.test(host)) {
      // YouTube: "Premiered Jan 5, 2024" / "Jan 5, 2024" in the info row
      out.Date = grab(/(?:Premiered|Streamed live on|Published on|Uploaded on)?\s*([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})/);
    } else {
      out.Date = grab(/([A-Z][a-z]+\s+\d{1,2},\s+\d{4})/);
    }
  }

  // ── Likes ──
  if (options.likes) {
    if (/youtube/.test(host)) {
      // Like button aria-label: "like this video along with 12,345 other people"
      const likeBtn = document.querySelector(
        'like-button-view-model button, #segmented-like-button button, ' +
        'ytd-toggle-button-renderer button[aria-label*="like"]'
      );
      const al = likeBtn?.getAttribute('aria-label') || '';
      out.Likes = (al.match(/([\d.,]+)\s*(?:other )?(?:people|likes?)/i) || [])[1] || likeBtn?.textContent?.trim() || '';
    } else {
      out.Likes = grab(/([\d.,]+[KMB]?)\s+likes?/i) || grab(/([\d.,]+[KMB]?)\s+reactions?/i);
      // Instagram sometimes: "Liked by X and N others"
      if (!out.Likes) out.Likes = grab(/and\s+([\d.,]+[KMB]?)\s+others?/i);
    }
  }

  // ── Comments (count) ──
  if (options.comments) {
    if (/youtube/.test(host)) {
      out.Comments = grab(/([\d.,]+)\s+Comments/i);
    } else {
      out.Comments = grab(/View all ([\d.,]+[KMB]?)\s+comments/i)
        || grab(/([\d.,]+[KMB]?)\s+comments?/i);
    }
  }

  // ── Shares ──
  if (options.shares) {
    // Instagram & YouTube do not expose a public share count.
    if (!/instagram|youtube/.test(host)) {
      out.Shares = grab(/([\d.,]+[KMB]?)\s+shares?/i);
    } else {
      out.Shares = ''; // not available on these platforms
    }
  }

  // ── Comment text (top N) ──
  if (options.commentText) {
    const max = options.maxComments || 20;
    let nodes = [];
    if (/youtube/.test(host)) {
      nodes = [...document.querySelectorAll('ytd-comment-thread-renderer #content-text, #content-text')];
    } else if (/instagram/.test(host)) {
      // Instagram comment spans (best-effort; structure changes often)
      nodes = [...document.querySelectorAll('ul ul span[dir="auto"], ul li span[dir="auto"]')];
    } else if (/facebook/.test(host)) {
      nodes = [...document.querySelectorAll('div[role="article"] div[dir="auto"]')];
    }
    const texts = nodes
      .map(n => (n.innerText || n.textContent || '').trim())
      .filter(t => t.length > 1)
      .slice(0, max);
    // Separated by " | " because comment text frequently contains commas
    out.CommentText = texts.join('  |  ');
  }

  return out;
}

async function storeTabState(tabId, patch) {
  if (!tabId) return;
  const key = STORE_PREFIX + tabId;
  try {
    const existing = await chrome.storage.session.get(key);
    const current = existing[key] || {};
    await chrome.storage.session.set({ [key]: { ...current, ...patch } });
  } catch (_) {
    // storage.session unavailable in very old Chrome — silently ignore
  }
}

async function getTabState(tabId) {
  if (!tabId) return {};
  const key = STORE_PREFIX + tabId;
  try {
    const result = await chrome.storage.session.get(key);
    return result[key] || {};
  } catch (_) {
    return {};
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
