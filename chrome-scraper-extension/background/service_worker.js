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

  return false;
});

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
