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
// Strategy: read the numbers from the page's EMBEDDED JSON first (the most
// reliable source — Meta/YouTube ship engagement data inside <script> tags),
// then fall back to an aria-label / icon DOM scan, then to plain text.
// options: { date, likes, comments, shares, commentText, maxComments }
function extractPostDetails(options) {
  const host = location.hostname;
  const out = {};

  // ── Build a searchable blob of all inline JSON + the rendered HTML ──
  let scriptBlob = '';
  try {
    const scripts = document.querySelectorAll(
      'script[type="application/json"], script[type="application/ld+json"], script:not([src])'
    );
    for (const s of scripts) scriptBlob += '\n' + (s.textContent || '');
  } catch (_) {}
  const htmlBlob = (document.documentElement && document.documentElement.outerHTML) || '';
  const blob = scriptBlob + '\n' + htmlBlob;
  const bodyText = (document.body && document.body.innerText) || '';

  // firstMatch: try each regex against a source, return the first capture group
  const firstMatch = (patterns, src) => {
    src = src || blob;
    for (const re of patterns) {
      const m = src.match(re);
      if (m && m[1] != null && String(m[1]).length) return String(m[1]);
    }
    return '';
  };

  const unixToDate = (n) => {
    const num = parseInt(n, 10);
    if (!num) return '';
    const ms = num < 1e12 ? num * 1000 : num; // seconds vs ms
    try { return new Date(ms).toISOString().slice(0, 10); } catch (_) { return ''; }
  };

  const isFB = /facebook|fb\.com|fb\.watch/.test(host);
  const isIG = /instagram/.test(host);
  const isYT = /youtube|youtu\.be/.test(host);

  // ═══════════════════ DATE ═══════════════════
  if (options.date) {
    // 1) <time datetime> is the gold standard (Instagram, some others)
    const timeEl = document.querySelector('time[datetime]');
    if (timeEl && timeEl.getAttribute('datetime')) {
      out.Date = timeEl.getAttribute('datetime');
    } else if (isFB) {
      const ts = firstMatch([
        /"creation_time":(\d{9,13})/, /"publish_time":(\d{9,13})/,
        /"created_time":(\d{9,13})/, /"taken_at":(\d{9,13})/
      ]);
      out.Date = ts ? unixToDate(ts) : firstMatch([/([A-Z][a-z]+ \d{1,2}, \d{4})/], bodyText);
    } else if (isIG) {
      const ts = firstMatch([/"taken_at_timestamp":(\d{9,13})/, /"taken_at":(\d{9,13})/]);
      out.Date = ts ? unixToDate(ts) : (timeEl?.textContent?.trim() || '');
    } else if (isYT) {
      out.Date = firstMatch([
        /"publishDate":"(\d{4}-\d{2}-\d{2})/, /"uploadDate":"(\d{4}-\d{2}-\d{2})/,
        /"dateText":\{"simpleText":"([^"]+)"/
      ]) || firstMatch([/(?:Premiered |Streamed live on |Published on |)([A-Z][a-z]{2} \d{1,2}, \d{4})/], bodyText);
    } else {
      out.Date = firstMatch([/([A-Z][a-z]+ \d{1,2}, \d{4})/], bodyText);
    }
  }

  // ═══════════════════ LIKES / REACTIONS ═══════════════════
  if (options.likes) {
    if (isFB) {
      out.Likes = firstMatch([
        /"reaction_count":\{"count":(\d+)/,
        /"i18n_reaction_count":"([\d.,KMB]+)"/,
        /"reactors":\{[^}]*"count":(\d+)/,
        /"reaction_count":\{[^}]*"count":(\d+)/,
      ]);
    } else if (isIG) {
      out.Likes = firstMatch([
        /"edge_media_preview_like":\{"count":(\d+)/,
        /"edge_liked_by":\{"count":(\d+)/,
        /"like_count":(\d+)/,
      ]);
    } else if (isYT) {
      out.Likes = firstMatch([
        /"accessibilityText":"([\d,]+) likes"/,
        /"label":"([\d,]+) likes"/,
        /"likeCount":"(\d+)"/,
        /"defaultText":\{[^}]*"accessibilityData":\{"label":"([\d,]+) likes/,
      ]);
    }
    // Fallback: aria-labels / visible text
    if (!out.Likes) out.Likes = scanCount(['like', 'reaction', 'react']) || firstMatch([/([\d.,]+[KMB]?)\s+(?:likes?|reactions?)/i], bodyText);
  }

  // ═══════════════════ COMMENTS (count) ═══════════════════
  if (options.comments) {
    if (isFB) {
      out.Comments = firstMatch([
        /"comment_count":\{"total_count":(\d+)/,
        /"comment_count":\{[^}]*"count":(\d+)/,
        /"comments":\{[^}]*"total_count":(\d+)/,
        /"total_comment_count":(\d+)/,
      ]);
    } else if (isIG) {
      out.Comments = firstMatch([
        /"edge_media_to_comment":\{"count":(\d+)/,
        /"edge_media_to_parent_comment":\{"count":(\d+)/,
        /"comment_count":(\d+)/,
      ]);
    } else if (isYT) {
      out.Comments = firstMatch([
        /"commentCount":\{"simpleText":"([\d,]+)"/,
        /"commentCount":"(\d+)"/,
        /"contextualInfo":\{"runs":\[\{"text":"([\d,]+)"/,
      ]);
    }
    if (!out.Comments) out.Comments = scanCount(['comment']) || firstMatch([/([\d.,]+[KMB]?)\s+comments?/i, /View all ([\d.,]+[KMB]?)\s+comments/i], bodyText);
  }

  // ═══════════════════ SHARES ═══════════════════
  if (options.shares) {
    if (isIG || isYT) {
      out.Shares = ''; // not publicly exposed on these platforms
    } else if (isFB) {
      out.Shares = firstMatch([
        /"share_count":\{"count":(\d+)/,
        /"i18n_share_count":"([\d.,KMB]+)"/,
        /"reshares":\{[^}]*"count":(\d+)/,
        /"share_count_reduced":"([\d.,KMB]+)"/,
      ]) || scanCount(['share', 'send']) || firstMatch([/([\d.,]+[KMB]?)\s+shares?/i], bodyText);
    } else {
      out.Shares = firstMatch([/([\d.,]+[KMB]?)\s+shares?/i], bodyText);
    }
  }

  // ═══════════════════ VIEWS (bonus — reels/videos) ═══════════════════
  // Deep scrape can also confirm/fill the view count from the post page.
  {
    let v = '';
    if (isFB) v = firstMatch([/"video_view_count":(\d+)/, /"play_count":(\d+)/, /"view_count":(\d+)/]);
    else if (isIG) v = firstMatch([/"video_view_count":(\d+)/, /"play_count":(\d+)/, /"video_play_count":(\d+)/]);
    else if (isYT) v = firstMatch([/"viewCount":"(\d+)"/, /"viewCount":\{"simpleText":"([\d,]+)/]);
    if (v) out.Views = v;
  }

  // ═══════════════════ DURATION ═══════════════════
  {
    const clock = (sec) => {
      sec = Math.round(Number(sec) || 0);
      if (sec <= 0) return '';
      const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
      const p = n => String(n).padStart(2, '0');
      return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
    };
    let sec = '';
    if (isIG) { const d = firstMatch([/"video_duration":([\d.]+)/]); if (d) sec = parseFloat(d); }
    else if (isFB) {
      const ms = firstMatch([/"playable_duration_in_ms":(\d+)/]);
      const s = firstMatch([/"length_in_second":(\d+)/, /"playable_duration":(\d+)/]);
      if (ms) sec = parseInt(ms, 10) / 1000; else if (s) sec = parseInt(s, 10);
    } else if (isYT) {
      const ls = firstMatch([/"lengthSeconds":"(\d+)"/]);
      const ms = firstMatch([/"approxDurationMs":"(\d+)"/]);
      const lt = firstMatch([/"lengthText":\{[^}]*"simpleText":"([\d:]+)"/]);
      if (ls) sec = parseInt(ls, 10);
      else if (ms) sec = parseInt(ms, 10) / 1000;
      else if (lt) { out.Duration = lt; out.DurationSec = String(lt.split(':').reduce((a, n) => a * 60 + (+n), 0)); }
    }
    if (sec) { out.Duration = clock(sec); out.DurationSec = String(Math.round(sec)); }
  }

  // ═══════════════════ CAPTION (ALWAYS — the key fix) ═══════════════════
  // The full caption lives in the post's embedded JSON regardless of whether
  // it's a post or a reel, so deep scrape gets it consistently for both.
  {
    // decode a JSON string body (handles \n, \", \uXXXX escapes)
    const dec = (raw) => { try { return JSON.parse('"' + raw + '"'); } catch (_) { return raw.replace(/\\n/g, ' ').replace(/\\"/g, '"'); } };
    const S = '((?:[^"\\\\]|\\\\.)*)'; // a JSON string body with escapes
    let cap = '';
    if (isIG) {
      cap = firstMatch([
        new RegExp('"edge_media_to_caption":\\{"edges":\\[\\{"node":\\{"text":"' + S + '"'),
        new RegExp('"caption":\\{[^}]*"text":"' + S + '"'),
        new RegExp('"caption":"' + S + '"'),
        new RegExp('"accessibility_caption":"' + S + '"'),
      ]);
    } else if (isFB) {
      cap = firstMatch([
        new RegExp('"message":\\{"text":"' + S + '"'),
        new RegExp('"title":\\{"text":"' + S + '"'),
        new RegExp('"description":\\{"text":"' + S + '"'),
      ]);
    } else if (isYT) {
      cap = firstMatch([
        new RegExp('"title":\\{"runs":\\[\\{"text":"' + S + '"'),
        new RegExp('"title":\\{"simpleText":"' + S + '"'),
        new RegExp('"videoPrimaryInfoRenderer":\\{"title":\\{"runs":\\[\\{"text":"' + S + '"'),
      ]);
      if (!cap && document.title) cap = document.title.replace(/\s*-\s*YouTube\s*$/, '');
    }
    // Universal fallbacks that work on any platform's post page
    if (!cap) {
      const og = document.querySelector('meta[property="og:description"], meta[property="og:title"], meta[name="description"]');
      cap = og?.getAttribute('content') || '';
    }
    if (cap) out.Caption = dec(cap).trim().replace(/\s+/g, ' ').slice(0, 2000);
  }

  // ═══════════════════ COMMENT TEXT (top N) ═══════════════════
  if (options.commentText) {
    const max = options.maxComments || 20;
    let nodes = [];
    if (isYT) {
      nodes = [...document.querySelectorAll('ytd-comment-thread-renderer #content-text, #content-text')];
    } else if (isIG) {
      nodes = [...document.querySelectorAll('ul ul span[dir="auto"], ul li span[dir="auto"]')];
    } else if (isFB) {
      nodes = [...document.querySelectorAll('div[role="article"] div[dir="auto"], [aria-label="Comment"] ~ div div[dir="auto"]')];
    }
    const texts = nodes
      .map(n => (n.innerText || n.textContent || '').trim())
      .filter(t => t.length > 1)
      .slice(0, max);
    out.CommentText = texts.join('  |  ');
  }

  return out;

  // ── DOM helper: find a count near an icon/button whose aria-label matches ──
  // Handles Facebook reels where the number sits under a heart/comment/share
  // icon with NO adjacent word (so text-regex fails but aria-labels work).
  function scanCount(keywords) {
    const kw = new RegExp(keywords.join('|'), 'i');
    const isNum = (t) => /^[\d][\d.,]*\s*[KMB]?$/i.test((t || '').trim());
    // Candidate action elements: things with an aria-label mentioning the action
    const candidates = [...document.querySelectorAll(
      '[aria-label], [role="button"], a[href], div[role="button"]'
    )].filter(el => {
      const al = (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '');
      return kw.test(al);
    });
    for (const el of candidates) {
      // (a) the number may be baked into the aria-label itself
      const al = el.getAttribute('aria-label') || '';
      const m = al.match(/([\d.,]+\s*[KMB]?)/);
      if (m && isNum(m[1])) return m[1].replace(/\s/g, '');
      // (b) or a nearby sibling / descendant holds the number
      const scope = el.parentElement || el;
      const nums = [...scope.querySelectorAll('span, div')]
        .filter(n => n.children.length === 0 && isNum(n.textContent));
      if (nums.length) return nums[0].textContent.trim();
    }
    return '';
  }
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
