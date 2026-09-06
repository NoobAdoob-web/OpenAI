/* ScrapeSuite – content script */
(function () {
  'use strict';

  // Guard: only init once per page
  if (window.__IDS_INIT__) return;
  window.__IDS_INIT__ = true;

  // ─── State ───────────────────────────────────────────────────────────────
  let candidates = [];
  let currentIndex = 0;
  let currentData = { headers: [], rows: [] };

  let highlightBox = null;
  let pickerBox = null;
  let pickerActive = false;
  let crawlActive = false;
  let _tabId = null;        // set by popup on first message
  let _highlightedEl = null; // MUST be declared here (before bootstrap) — see note below
  let popupOpen = false;    // true only while the extension popup is open
  let _scriptBlobCache = null; // cached page <script> text (used during bootstrap detect → TDZ-safe here)

  // Per-post metadata harvested from the page's OWN api/graphql responses by
  // content/net_hook.js (MAIN world). Keyed by shortcode / post id. This is how
  // we get the post copy (caption) on a reels/posts GRID, where the caption is
  // never rendered into the tile. Declared here to stay TDZ-safe.
  const POST_META = new Map();

  // Module constants — MUST be declared before bootstrap (which calls detect →
  // buildCandidates → extractSocialRows). A `const` used before its declaration
  // line executes throws a temporal-dead-zone ReferenceError, so they live here.
  // Each metric has a raw display column ("322K") and a numeric column ("322000")
  // so the exported sheet is analysis-ready without manual conversion.
  const SOCIAL_COLUMNS = [
    'Caption',
    'Duration', 'Duration (sec)',
    'Views', 'Views (number)',
    'Likes', 'Likes (number)',
    'Comments', 'Comments (number)',
    'Shares', 'Shares (number)',
    'Date', 'URL', 'Thumbnail'
  ];
  const NUM_RE = /^[\d][\d.,]*\s*[KMB]?$/i;  // "1,234", "12.3K", "4.5M", "893K"

  // Product-review columns (Amazon / Flipkart). Declared here (before bootstrap)
  // to stay TDZ-safe, same as SOCIAL_COLUMNS.
  const REVIEW_COLUMNS = [
    'Rating', 'Rating (number)', 'Title', 'Review', 'Reviewer',
    'Date', 'Verified', 'Helpful', 'Helpful (number)', 'Variant', 'Product', 'URL'
  ];

  // ─── Bootstrap ───────────────────────────────────────────────────────────
  // Register the message listener FIRST, before anything that could throw.
  // If detection/overlay code throws during bootstrap, the listener must still
  // exist so the popup can talk to us. (A previous TDZ bug on _highlightedEl
  // crashed the whole script here and left the listener unregistered, which is
  // why pages WITH detectable data wrongly showed "No data detected".)
  registerMessageListener();
  registerPopupConnection();
  try { registerNetHookListener(); } catch (e) { console.warn('IDS net hook listener failed', e); }
  try { createOverlays(); } catch (e) { console.warn('IDS createOverlays failed', e); }
  try { checkPendingCrawl(); } catch (e) { console.warn('IDS checkPendingCrawl failed', e); }
  try { detect(); } catch (e) { console.warn('IDS initial detect failed', e); }

  // ─── Post metadata from the page's own API responses ─────────────────────
  // content/net_hook.js runs in the page's MAIN world and forwards per-post
  // fields it sees in the site's own JSON responses. We merge them into
  // POST_META, preferring the first non-empty value we ever saw for a field.
  function registerNetHookListener() {
    window.addEventListener('message', (e) => {
      if (e.source !== window) return;
      const d = e.data;
      if (!d || d.__scrapesuite !== 'net' || !Array.isArray(d.items)) return;
      for (const it of d.items) {
        if (!it || !it.code) continue;
        const prev = POST_META.get(it.code) || {};
        const merged = { ...prev };
        for (const k of ['caption', 'taken', 'duration', 'views', 'likes', 'comments']) {
          const v = it[k];
          const empty = v === '' || v === 0 || v === null || v === undefined;
          const prevEmpty = merged[k] === '' || merged[k] === 0 || merged[k] === undefined;
          if (!empty && prevEmpty) merged[k] = v;
        }
        POST_META.set(it.code, merged);
      }
    }, false);
    pingNetHook();
  }

  // Ask the MAIN-world hook to replay everything it captured before we loaded.
  function pingNetHook() {
    try { window.postMessage({ __scrapesuite: 'ready' }, '*'); } catch (_) {}
  }

  // Unix seconds → YYYY-MM-DD
  function tsToDate(ts) {
    const n = Number(ts);
    if (!n || !isFinite(n)) return '';
    const ms = n > 1e12 ? n : n * 1000;
    try { return new Date(ms).toISOString().slice(0, 10); } catch (_) { return ''; }
  }

  // Fill Caption / Date / Duration / counts on a row from POST_META.
  // Only fills fields the grid did not already provide.
  function applyPostMeta(row, key) {
    if (!key) return;
    const m = POST_META.get(key);
    if (!m) return;
    if (!row.Caption && m.caption) {
      row.Caption = String(m.caption).replace(/\s+/g, ' ').trim().slice(0, 2000);
    }
    if (!row.Date && m.taken) row.Date = tsToDate(m.taken);
    if (!row.Duration && m.duration) {
      row.Duration = secToClock(m.duration);
      row['Duration (sec)'] = String(Math.round(m.duration));
    }
    // Counts from the API are EXACT (85700), where the grid only shows a
    // rounded "85.7K". Keep the grid text for display, but let the exact value
    // drive the numeric column used for analysis.
    const exact = (v) => v !== '' && v != null;
    if (exact(m.views))    { if (!row.Views) row.Views = String(m.views);       row['Views (number)']    = String(m.views); }
    if (exact(m.likes))    { if (!row.Likes) row.Likes = String(m.likes);       row['Likes (number)']    = String(m.likes); }
    if (exact(m.comments)) { if (!row.Comments) row.Comments = String(m.comments); row['Comments (number)'] = String(m.comments); }
  }

  // ─── Detection ───────────────────────────────────────────────────────────
  function detect() {
    try {
      candidates = buildCandidates();
    } catch (e) {
      console.warn('IDS buildCandidates failed', e);
      candidates = [];
    }
    currentIndex = 0;
    if (candidates.length > 0) {
      currentData = extractData(candidates[0]);
      // Only draw the highlight box while the popup is open (see popupOpen).
      if (popupOpen) { try { showHighlight(candidates[0].element); } catch (_) {} }
    } else {
      currentData = { headers: [], rows: [] };
      try { hideHighlight(); } catch (_) {}
    }
  }

  function buildCandidates() {
    const results = [];
    const usedEls = new Set();

    // ── 0a. Product reviews (Amazon / Flipkart) ──────────────────────────
    try {
      const rp = detectReviewPlatform();
      if (rp) {
        const rev = extractReviews(rp);
        if (rev && rev.rows.length > 0) {
          results.push({
            element: rev.container || document.body,
            type: 'reviews',
            platform: rp,
            _reviews: rev,
            score: 2e9,               // reviews win even over social
            rows: rev.rows.length,
            cols: rev.headers.length
          });
        }
      }
    } catch (e) { console.warn('IDS review extract failed', e); }

    // ── 0. Social platform extraction (YouTube / Instagram / Facebook / LinkedIn)
    // Highest priority: if we're on a known social platform, extract semantic
    // fields (Views, Likes, Comments, Shares, Date, Caption, URL) directly.
    try {
      const platform = detectPlatform();
      if (platform) {
        const soc = extractSocialRows(platform);
        if (soc && soc.rows.length > 0) {
          results.push({
            element: soc.container || document.body,
            type: 'social',
            platform,
            _social: soc,
            score: 1e9,               // always win over generic detection
            rows: soc.rows.length,
            cols: soc.headers.length
          });
        }
      }
    } catch (e) { console.warn('IDS social extract failed', e); }

    // ── 1. HTML <table> elements ──────────────────────────────────────────
    document.querySelectorAll('table').forEach(table => {
      if (!visible(table)) return;
      const trs = [...table.querySelectorAll('tr')];
      if (trs.length < 2) return;
      const cols = Math.max(...trs.map(r => r.querySelectorAll('td,th').length));
      if (cols < 1) return;
      results.push({ element: table, type: 'table', score: trs.length * cols * 2, rows: trs.length, cols });
      usedEls.add(table);
    });

    // ── 2. Repeated sibling patterns ─────────────────────────────────────
    // Collect candidate parent containers
    const containers = new Set();
    const REPEATING_SELECTORS = [
      'ul', 'ol',
      '[class*="list"]', '[class*="grid"]', '[class*="results"]',
      '[class*="items"]', '[class*="cards"]', '[class*="feed"]',
      'main', 'section', 'article', 'tbody'
    ];
    document.querySelectorAll(REPEATING_SELECTORS.join(',')).forEach(el => {
      if (visible(el)) containers.add(el);
    });
    // Also walk up from commonly-repeating child tags
    document.querySelectorAll('li, article, [class*="item"], [class*="card"], [class*="product"], [class*="result"], [class*="row"]').forEach(el => {
      if (visible(el) && el.parentElement) containers.add(el.parentElement);
    });

    // ── 2b. Role-based containers (Instagram tabpanel, ARIA feeds/lists) ──
    document.querySelectorAll('[role="tabpanel"], [role="feed"], [role="list"], [role="main"]').forEach(el => {
      if (visible(el)) containers.add(el);
    });

    // ── 3. Image/video grids — direct detection, bypasses sig_of grouping ──
    // Walk up from every img/video to find the CLOSEST ancestor with 3+ media-
    // containing children. Adds that container straight to results so hashed/
    // unique CSS class names (Instagram, TikTok, Facebook) can't break detection.
    // Uses notHidden() not visible() for media elements because lazy-loaded
    // images have src="" → 0×0 bbox and would fail visible().
    {
      // hasMedia: true if element IS or CONTAINS an img, video, or CSS background-image
      function hasMedia(el) {
        if (el.tagName === 'IMG' || el.tagName === 'VIDEO') return true;
        if (el.querySelector('img, video')) return true;
        try {
          const bg = window.getComputedStyle(el).backgroundImage;
          if (bg && bg !== 'none' && bg.startsWith('url(')) return true;
        } catch (_) {}
        // Check direct children for background-image (Facebook reel cards)
        return [...el.children].some(c => {
          try {
            const bg = window.getComputedStyle(c).backgroundImage;
            return bg && bg !== 'none' && bg.startsWith('url(');
          } catch (_) { return false; }
        });
      }

      const seenMediaContainers = new Set();

      // Walk from every img/video upward
      document.querySelectorAll('img, video').forEach(media => {
        if (!notHidden(media)) return;
        let el = media.parentElement;
        for (let i = 0; i < 14 && el && el !== document.body; i++, el = el.parentElement) {
          if (!notHidden(el) || seenMediaContainers.has(el) || usedEls.has(el)) continue;
          const mediaChildren = [...el.children].filter(hasMedia);
          if (mediaChildren.length >= 3) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 || r.height > 0) {
              seenMediaContainers.add(el);
              usedEls.add(el);
              const avgF = mediaChildren.reduce((s, c) => s + countLeaves(c), 0) / mediaChildren.length;
              results.push({
                element: el,
                type: 'list',
                items: mediaChildren,
                score: mediaChildren.length * Math.max(avgF, 1),
                rows: mediaChildren.length,
                cols: Math.round(Math.max(avgF, 1))
              });
              break;
            }
          }
        }
      });

      // ── 3b. CSS background-image grids (Facebook reels, some news sites) ──
      // Walk from every element that has a background-image URL — covers sites
      // that render thumbnails purely via CSS without any <img> tag.
      document.querySelectorAll('*').forEach(el => {
        if (!notHidden(el) || seenMediaContainers.has(el) || usedEls.has(el)) return;
        try {
          const bg = window.getComputedStyle(el).backgroundImage;
          if (!bg || bg === 'none' || !bg.startsWith('url(')) return;
        } catch (_) { return; }
        // Walk up to find a parent with 3+ bg-image children
        let cur = el.parentElement;
        for (let i = 0; i < 14 && cur && cur !== document.body; i++, cur = cur.parentElement) {
          if (!notHidden(cur) || seenMediaContainers.has(cur) || usedEls.has(cur)) continue;
          const bgKids = [...cur.children].filter(hasMedia);
          if (bgKids.length >= 3) {
            const r = cur.getBoundingClientRect();
            if (r.width > 0 || r.height > 0) {
              seenMediaContainers.add(cur);
              usedEls.add(cur);
              const avgF = bgKids.reduce((s, c) => s + countLeaves(c), 0) / bgKids.length;
              results.push({
                element: cur,
                type: 'list',
                items: bgKids,
                score: bgKids.length * Math.max(avgF, 1),
                rows: bgKids.length,
                cols: Math.round(Math.max(avgF, 1))
              });
              break;
            }
          }
        }
      });
    }

    // Recursively find the first level of repeating children inside any container.
    // Depth 12 handles Instagram-style deeply-nested grids (role="main" → 8 wrapper divs → grid).
    // Also falls back to media-children grouping when sig_of hashes differ across items.
    function processAsContainer(parent, depth) {
      if (depth > 12 || usedEls.has(parent)) return;
      if (parent === document.body || parent === document.documentElement) return;

      const children = [...parent.children].filter(visible);
      if (children.length === 0) return;

      // Group children by structural signature (tag + top classes)
      const groups = new Map();
      children.forEach(child => {
        const sig = sig_of(child);
        if (!groups.has(sig)) groups.set(sig, []);
        groups.get(sig).push(child);
      });

      let dominated = false;
      groups.forEach(group => {
        if (group.length < 3 || usedEls.has(parent)) return;
        const avgFields = group.reduce((s, el) => s + countLeaves(el), 0) / group.length;
        if (avgFields < 0.5) return;
        usedEls.add(parent);
        dominated = true;
        results.push({
          element: parent,
          type: 'list',
          items: group,
          score: group.length * Math.max(avgFields, 1),
          rows: group.length,
          cols: Math.round(Math.max(avgFields, 1))
        });
      });

      // Fallback: sig_of grouping failed (hashed class names) — try grouping by media children
      if (!dominated && !usedEls.has(parent)) {
        const mediaKids = children.filter(c =>
          c.tagName === 'IMG' || c.tagName === 'VIDEO' || c.querySelector('img, video')
        );
        if (mediaKids.length >= 3) {
          usedEls.add(parent);
          dominated = true;
          const avgF = mediaKids.reduce((s, c) => s + countLeaves(c), 0) / mediaKids.length;
          results.push({
            element: parent,
            type: 'list',
            items: mediaKids,
            score: mediaKids.length * Math.max(avgF, 1),
            rows: mediaKids.length,
            cols: Math.round(Math.max(avgF, 1))
          });
        }
      }

      // No group found → drill deeper into each child
      if (!dominated) {
        children.forEach(child => processAsContainer(child, depth + 1));
      }
    }

    containers.forEach(parent => processAsContainer(parent, 0));

    // ── 4. Safety net: walk up from every img/video, group by parent ──────
    // Absolute last resort — works for any grid regardless of link structure.
    // Uses notHidden() instead of visible() so lazy-loaded (src="") images are
    // not skipped. The PARENT is checked for a real rendered bounding box.
    if (results.length === 0) {
      const mediaParentMap = new Map();
      document.querySelectorAll('img, video').forEach(media => {
        if (!notHidden(media)) return;
        let el = media.parentElement;
        for (let i = 0; i < 12 && el && el !== document.body; i++, el = el.parentElement) {
          const parent = el.parentElement;
          if (!parent || parent === document.body) break;
          const mediaSibs = [...parent.children].filter(c =>
            c.tagName === 'IMG' || c.tagName === 'VIDEO' || c.querySelector('img, video')
          );
          const pr = parent.getBoundingClientRect();
          if (mediaSibs.length >= 3 && (pr.width > 0 || pr.height > 0) && !mediaParentMap.has(parent)) {
            mediaParentMap.set(parent, mediaSibs);
            break;
          }
        }
      });

      mediaParentMap.forEach((items, parent) => {
        if (usedEls.has(parent)) return;
        usedEls.add(parent);
        const avgF = items.reduce((s, el) => s + countLeaves(el), 0) / items.length;
        results.push({
          element: parent,
          type: 'list',
          items,
          score: items.length * Math.max(avgF, 1),
          rows: items.length,
          cols: Math.round(Math.max(avgF, 1))
        });
      });
    }

    // Sort best first, skip root elements — but never drop a social candidate
    // (its container can legitimately be <body> when posts are top-level).
    return results
      .filter(c => c.type === 'social' || c.type === 'reviews' || (c.element !== document.body && c.element !== document.documentElement))
      .sort((a, b) => b.score - a.score)
      .slice(0, 30);
  }

  function sig_of(el) {
    const cls = [...el.classList].slice(0, 3).join(' ');
    return el.tagName + '|' + cls;
  }

  function visible(el) {
    if (!el) return false;
    try {
      const s = window.getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    } catch (_) { return false; }
  }

  // Lighter check: not hidden by CSS, regardless of dimensions.
  // Use for media elements (img/video) that may be lazy-loaded (src="" → 0x0).
  function notHidden(el) {
    if (!el) return false;
    try {
      const s = window.getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
    } catch (_) { return false; }
  }

  function countLeaves(el, depth = 0) {
    if (depth > 8) return 0;
    let n = 0;
    for (const c of el.children) {
      if (c.tagName === 'IMG' || c.tagName === 'VIDEO') { n++; continue; } // media = data
      if (c.tagName === 'A' && c.getAttribute('href')) { n++; continue; }  // links = data
      if (c.children.length === 0 && c.textContent.trim()) n++;
      else n += countLeaves(c, depth + 1);
    }
    return n || (el.querySelector('img, video, a[href]') ? 1 : 0) || (el.textContent.trim() ? 1 : 0);
  }

  // ─── Extraction ──────────────────────────────────────────────────────────
  function extractData(candidate) {
    if (!candidate) return { headers: [], rows: [] };
    try {
      if (candidate.type === 'social') {
        // Re-extract fresh each call so infinite-scroll picks up new items
        const soc = extractSocialRows(candidate.platform);
        return { headers: soc.headers, rows: soc.rows };
      }
      if (candidate.type === 'reviews') {
        const rev = extractReviews(candidate.platform);
        return { headers: rev.headers, rows: rev.rows };
      }
      return candidate.type === 'table'
        ? extractTable(candidate.element)
        : extractList(candidate.items || [...candidate.element.children].filter(visible));
    } catch (_) {
      return { headers: [], rows: [] };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  PRODUCT REVIEWS  (Amazon · Flipkart)
  // ═══════════════════════════════════════════════════════════════════════
  function detectReviewPlatform() {
    const h = location.hostname;
    if (/(^|\.)amazon\./.test(h)) return 'amazon';
    if (/(^|\.)flipkart\.com/.test(h)) return 'flipkart';
    return null;
  }

  function emptyReviewRow() {
    const r = {}; REVIEW_COLUMNS.forEach(c => { r[c] = ''; }); return r;
  }

  function extractReviews(platform) {
    let rows = [], container = null;
    try {
      if (platform === 'amazon') { const o = extractAmazonReviews(); rows = o.rows; container = o.container; }
      else if (platform === 'flipkart') { const o = extractFlipkartReviews(); rows = o.rows; container = o.container; }
    } catch (e) { console.warn('IDS review extractor error', e); }

    // Dedupe (reviewer + first 60 chars of review) and drop empty
    const seen = new Set();
    rows = rows.filter(r => {
      if (!(r.Review || r.Title)) return false;
      const key = (r.Reviewer || '') + '|' + (r.Review || r.Title || '').slice(0, 60);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { headers: REVIEW_COLUMNS.slice(), rows, container };
  }

  // ── Amazon (stable data-hook attributes) ────────────────────────────────
  function extractAmazonReviews() {
    const items = [...document.querySelectorAll('[data-hook="review"], li[data-hook="review"]')];
    const product = (document.querySelector('[data-hook="product-link"], #productTitle, a.product-title, [data-hook="cr-product-title"]')?.textContent
      || document.title.replace(/\s*[:|-].*$/, '')).trim();

    const rows = items.map(it => {
      const row = emptyReviewRow();
      const ratingTxt = (it.querySelector('[data-hook="review-star-rating"] .a-icon-alt, [data-hook="cmps-review-star-rating"] .a-icon-alt')?.textContent
        || it.querySelector('i[class*="a-star"] .a-icon-alt')?.textContent || '').trim();
      row.Rating = ratingTxt;                                    // "4.0 out of 5 stars"
      const rm = ratingTxt.match(/([\d.]+)\s*out of\s*5/i); if (rm) row['Rating (number)'] = rm[1];

      const titleEl = it.querySelector('[data-hook="review-title"]');
      if (titleEl) {
        const spans = [...titleEl.querySelectorAll('span')].map(s => s.textContent.trim()).filter(t => t && !/out of 5/i.test(t) && !/^\d+(\.\d)?$/.test(t));
        row.Title = (spans.pop() || titleEl.textContent.trim()).replace(/\s+/g, ' ');
      }
      row.Review = ((it.querySelector('[data-hook="review-body"]') || {}).innerText || '').trim().replace(/\s+/g, ' ');
      row.Reviewer = (it.querySelector('.a-profile-name')?.textContent || '').trim();
      const dateTxt = (it.querySelector('[data-hook="review-date"]')?.textContent || '').trim();
      const dm = dateTxt.match(/on\s+(.+)$/i); row.Date = dm ? dm[1].trim() : dateTxt;
      row.Verified = it.querySelector('[data-hook="avp-badge"]') ? 'Yes' : '';
      const helpful = (it.querySelector('[data-hook="helpful-vote-statement"]')?.textContent || '').trim();
      row.Helpful = helpful;
      const hm = helpful.replace(/,/g, '').match(/(\d+)/); if (hm) row['Helpful (number)'] = hm[1]; else if (/one|a person/i.test(helpful)) row['Helpful (number)'] = '1';
      row.Variant = (it.querySelector('[data-hook="format-strip"], .review-format-strip')?.textContent || '').trim().replace(/\s+/g, ' ');
      row.Product = product;
      const link = it.querySelector('[data-hook="review-title"]');
      row.URL = link && link.getAttribute('href') ? makeAbsolute(link.getAttribute('href')) : location.href.split('?')[0];
      return row;
    });

    const container = items[0]?.closest('#cm_cr-review_list, .reviews-content, [data-hook="reviews-medley-footer"]') || items[0]?.parentElement || null;
    return { rows, container };
  }

  // ── Flipkart (obfuscated classes → structural heuristic; best-effort) ────
  function extractFlipkartReviews() {
    const product = (document.querySelector('h1 span, ._35KyD6, .B_NuCI')?.textContent || document.title.replace(/\s*[|-].*$/, '')).trim();

    // A review card contains a rating badge (a lone 1–5, often with a star) and
    // a longer text block. Find rating badges, then walk up to the card.
    const badges = [...document.querySelectorAll('div, span')].filter(e => {
      const t = e.textContent.trim();
      if (!/^[1-5](\.\d)?$/.test(t)) return false;
      // must look like a rating chip: small, has a star icon nearby or star-ish class
      const cls = e.className || '';
      return /star|rating|XQDdHH|_3LWZlK|_1lRcqv/i.test(cls) || e.querySelector('svg, img') || /star|rating/i.test((e.parentElement?.className) || '');
    });

    const cards = [];
    const seenCard = new Set();
    badges.forEach(b => {
      let el = b;
      for (let i = 0; i < 6 && el; i++, el = el.parentElement) {
        const txt = (el.innerText || '').trim();
        if (txt.length > 40 && el.querySelectorAll('div,span,p').length >= 3) {
          if (!seenCard.has(el)) { seenCard.add(el); cards.push({ card: el, rating: b.textContent.trim() }); }
          break;
        }
      }
    });

    const rows = cards.map(({ card, rating }) => {
      const row = emptyReviewRow();
      row.Rating = rating + ' out of 5';
      row['Rating (number)'] = rating;
      // Title = a short bold-ish line; Review = the longest text block
      const texts = [...card.querySelectorAll('div, p, span')]
        .map(e => (e.children.length === 0 ? (e.innerText || '').trim() : ''))
        .filter(t => t.length > 0);
      const longest = texts.filter(t => t.length > 20).sort((a, b) => b.length - a.length)[0] || '';
      row.Review = longest.replace(/\s+/g, ' ').slice(0, 4000);
      const shortLines = texts.filter(t => t.length > 3 && t.length <= 60 && t !== longest && !/^[1-5](\.\d)?$/.test(t));
      row.Title = (shortLines[0] || '').replace(/\s+/g, ' ');
      // Reviewer / Date: Flipkart shows "Certified Buyer", a name, and a month/year
      const nameEl = card.querySelector('p[class*="_2sc7ZR"], ._2NsDsF, .álgn');
      row.Reviewer = (nameEl?.textContent || '').trim();
      const dm = (card.innerText || '').match(/([A-Z][a-z]{2,},?\s*\d{4}|\d{1,2}\s+[A-Z][a-z]{2,},?\s*\d{4})/);
      row.Date = dm ? dm[1] : '';
      row.Verified = /Certified Buyer/i.test(card.innerText || '') ? 'Yes' : '';
      const up = (card.innerText || '').match(/(\d[\d,]*)\s*\n?\s*(?:people|)\s*(?:found|)/i);
      row.Product = product;
      row.URL = location.href.split('?')[0];
      return row;
    });

    const container = cards[0]?.card?.parentElement || null;
    return { rows, container };
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  SOCIAL MEDIA EXTRACTION  (YouTube · Instagram · Facebook · LinkedIn)
  //  Produces a fixed schema so the Excel/CSV always has the same columns.
  //  (SOCIAL_COLUMNS and NUM_RE are declared in the top state block to avoid
  //   a temporal-dead-zone crash when bootstrap runs before this point.)
  // ═══════════════════════════════════════════════════════════════════════

  function detectPlatform() {
    const h = location.hostname;
    if (/youtube\.com|youtu\.be/.test(h)) return 'youtube';
    if (/instagram\.com/.test(h)) return 'instagram';
    if (/facebook\.com|fb\.com|fb\.watch/.test(h)) return 'facebook';
    if (/linkedin\.com/.test(h)) return 'linkedin';
    return null;
  }

  function emptyRow() {
    const r = {};
    SOCIAL_COLUMNS.forEach(c => { r[c] = ''; });
    return r;
  }

  function extractSocialRows(platform) {
    let rows = [];
    let container = null;
    try {
      if (platform === 'youtube')   { const o = extractYouTube();   rows = o.rows; container = o.container; }
      else if (platform === 'instagram') { const o = extractInstagram(); rows = o.rows; container = o.container; }
      else if (platform === 'facebook')  { const o = extractFacebook();  rows = o.rows; container = o.container; }
      else if (platform === 'linkedin')  { const o = extractLinkedIn();  rows = o.rows; container = o.container; }
    } catch (e) { console.warn('IDS platform extractor error', e); }

    // Dedupe by URL (fallback to caption) and drop totally-empty rows
    const seen = new Set();
    rows = rows.filter(r => {
      const hasData = r.URL || r.Caption || r.Views || r.Likes || r.Comments;
      if (!hasData) return false;
      const key = r.URL || r.Caption || JSON.stringify(r);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Fill numeric columns from the raw display columns (322K → 322000).
    // An exact count already taken from the site's own API (e.g. 85700 rather
    // than the grid's rounded "85.7K") is kept as-is.
    rows.forEach(r => {
      r['Views (number)']    = r['Views (number)']    || parseCountToNumber(r.Views);
      r['Likes (number)']    = r['Likes (number)']    || parseCountToNumber(r.Likes);
      r['Comments (number)'] = r['Comments (number)'] || parseCountToNumber(r.Comments);
      r['Shares (number)']   = r['Shares (number)']   || parseCountToNumber(r.Shares);
    });

    return { headers: SOCIAL_COLUMNS.slice(), rows, container };
  }

  // Convert a human count string to an absolute integer string.
  //   "322K" → "322000"   "1.2M" → "1200000"   "1,234" → "1234"
  //   "1.2M views" → "1200000"   "" → ""
  function parseCountToNumber(s) {
    if (s === null || s === undefined || s === '') return '';
    const t = String(s).trim().replace(/,/g, '');
    const m = t.match(/([\d]+(?:\.[\d]+)?)\s*([KMB])?/i);
    if (!m) return '';
    let n = parseFloat(m[1]);
    if (isNaN(n)) return '';
    const suf = (m[2] || '').toUpperCase();
    if (suf === 'K') n *= 1e3;
    else if (suf === 'M') n *= 1e6;
    else if (suf === 'B') n *= 1e9;
    return String(Math.round(n));
  }

  // ── Embedded-date helpers (basic grid: recover upload date from page JSON) ──
  // Instagram/Facebook ship each post's upload timestamp inside the profile
  // page's own <script> JSON. We read it so the DATE column fills on the grid,
  // without needing Deep Scrape. (_scriptBlobCache is declared in the top state
  // block above so bootstrap detect() can use it without a TDZ error.)
  function pageScriptBlob() {
    if (_scriptBlobCache !== null) return _scriptBlobCache;
    let b = '';
    try {
      document.querySelectorAll('script:not([src])').forEach(s => { b += '\n' + (s.textContent || ''); });
    } catch (_) {}
    _scriptBlobCache = b;
    return b;
  }

  function unixToDateStr(n) {
    const num = parseInt(n, 10);
    if (!num) return '';
    const ms = num < 1e12 ? num * 1000 : num; // seconds vs milliseconds
    try { return new Date(ms).toISOString().slice(0, 10); } catch (_) { return ''; }
  }

  // Format seconds as a clock string: 83 → "1:23", 3725 → "1:02:05"
  function secToClock(sec) {
    sec = Math.round(Number(sec) || 0);
    if (sec <= 0) return '';
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const p = n => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
  }
  // "1:23" → 83 seconds
  function clockToSec(clock) {
    const parts = String(clock).split(':').map(Number);
    if (parts.some(isNaN)) return '';
    return String(parts.reduce((acc, n) => acc * 60 + n, 0));
  }

  // Find a video duration (in seconds) near a post's code/id in the page JSON.
  // Handles seconds and millisecond keys used by IG/FB/YouTube.
  function findDurationNear(blob, token) {
    if (!blob || !token) return '';
    const ti = blob.indexOf('"' + token + '"');
    if (ti < 0) return '';
    const re = /"(video_duration|length_in_second|playable_duration_in_ms|durationInSeconds|lengthSeconds|approxDurationMs)":"?([\d.]+)"?/g;
    let m, best = null, bestDist = Infinity;
    while ((m = re.exec(blob)) !== null) {
      const d = Math.abs(m.index - ti);
      if (d < bestDist) { bestDist = d; best = m; }
      if (m.index > ti && d > bestDist && bestDist < 400) break;
    }
    if (!best || bestDist > 800) return '';
    let sec = parseFloat(best[2]);
    if (/_ms$|DurationMs$/i.test(best[1])) sec /= 1000; // ms → s
    return sec > 0 ? sec : '';
  }

  // Find the upload timestamp CLOSEST (by index distance) to a post's code/id
  // token in the page JSON — so adjacent posts don't all grab the first date.
  function findTimestampNear(blob, token) {
    if (!blob || !token) return '';
    const ti = blob.indexOf('"' + token + '"');
    if (ti < 0) return '';
    const re = /"(?:taken_at_timestamp|taken_at|creation_time|publish_time|created_time|device_timestamp)":(\d{9,13})/g;
    let m, best = null, bestDist = Infinity;
    while ((m = re.exec(blob)) !== null) {
      const d = Math.abs(m.index - ti);
      if (d < bestDist) { bestDist = d; best = m[1]; }
      if (m.index > ti && d > bestDist && bestDist < 400) break; // moving away, good enough
    }
    // Only trust a timestamp that sits within the same JSON object (~800 chars)
    return best && bestDist < 800 ? unixToDateStr(best) : '';
  }

  // ── Shared count helpers ───────────────────────────────────────────────
  function isCountText(t) {
    t = t.trim();
    return t.length > 0 && t.length < 12 && NUM_RE.test(t);
  }

  // Scan a card for number-like leaves and classify them by nearby SVG/aria labels.
  // hint = 'views' means an unlabeled single number is treated as a view count (reels).
  function grabCounts(card, hint) {
    const res = { views: '', likes: '', comments: '', shares: '' };
    if (!card) return res;

    const leaves = [...card.querySelectorAll('span, div, strong, em')]
      .filter(e => e.children.length === 0 && isCountText(e.textContent));

    const unlabeled = [];
    leaves.forEach(e => {
      const txt = e.textContent.trim();
      // Look for a label from a nearby svg[aria-label] or aria-label attribute
      let label = '';
      const scopes = [e, e.parentElement, e.parentElement?.parentElement,
                      e.previousElementSibling, e.nextElementSibling].filter(Boolean);
      for (const s of scopes) {
        const svg = s.matches?.('svg[aria-label]') ? s : s.querySelector?.('svg[aria-label]');
        const al = svg?.getAttribute('aria-label') || s.getAttribute?.('aria-label') || '';
        if (al) { label = al.toLowerCase(); break; }
      }
      if (/view|play|watch/.test(label) && !res.views) res.views = txt;
      else if (/like|reaction|react/.test(label) && !res.likes) res.likes = txt;
      else if (/comment/.test(label) && !res.comments) res.comments = txt;
      else if (/share|repost|send/.test(label) && !res.shares) res.shares = txt;
      else unlabeled.push(txt);
    });

    // Positional fallback for unlabeled numbers
    if (unlabeled.length) {
      if (hint === 'views' && !res.views) { res.views = unlabeled.shift(); }
      if (!res.likes && unlabeled.length) res.likes = unlabeled.shift();
      if (!res.comments && unlabeled.length) res.comments = unlabeled.shift();
      if (!res.shares && unlabeled.length) res.shares = unlabeled.shift();
    }
    return res;
  }

  // ── YouTube ────────────────────────────────────────────────────────────
  // /@channel/videos — grid gives Title, Views, Upload date, URL, Thumbnail.
  // Handles BOTH the old (#video-title / #metadata-line) and the new 2024
  // yt-lockup-view-model layout, which dropped those IDs entirely.
  // (Likes / comments / shares are only on the individual watch page.)
  function extractYouTube() {
    let items = [...document.querySelectorAll(
      'ytd-rich-item-renderer, ytd-grid-video-renderer, ytd-video-renderer, ' +
      'ytm-rich-item-renderer, ytd-reel-item-renderer, yt-lockup-view-model'
    )];
    // New layout nests yt-lockup-view-model inside ytd-rich-item-renderer —
    // if both matched, keep the innermost (lockup) to avoid duplicates.
    if (items.some(i => i.tagName && i.tagName.toLowerCase() === 'yt-lockup-view-model')) {
      items = items.filter(i => {
        const t = i.tagName.toLowerCase();
        if (t === 'yt-lockup-view-model') return true;
        return !i.querySelector('yt-lockup-view-model');
      });
    }
    let container = items[0]?.parentElement || null;

    const rows = items.map(it => {
      const row = emptyRow();

      // ── Link (watch/shorts) — most reliable anchor ──
      const linkEl = it.querySelector('a#video-title-link, a#thumbnail, a[href*="/watch"], a[href*="/shorts/"]');
      row.URL = linkEl?.href || '';

      // ── Title — try known ids, new lockup class, headings, then link attrs ──
      const titleEl = it.querySelector(
        '#video-title, #video-title-link, a#video-title, ' +
        '.yt-lockup-metadata-view-model-wiz__title, ' +
        'h3 a, h3 span, [role="text"]'
      );
      row.Caption = (
        titleEl?.getAttribute('title') ||
        titleEl?.textContent ||
        linkEl?.getAttribute('title') ||
        linkEl?.getAttribute('aria-label') || ''
      ).trim().replace(/\s+/g, ' ');

      // ── Thumbnail ──
      const img = it.querySelector('img');
      row.Thumbnail = img?.src || img?.getAttribute('data-thumb') || '';

      // ── Views + Date — scan every short text node in the item ──
      // Works regardless of the metadata container's class names.
      const bits = [...it.querySelectorAll('span, yt-formatted-string, div')]
        .filter(e => e.children.length === 0)
        .map(e => e.textContent.trim())
        .filter(t => t && t.length < 40);
      bits.forEach(m => {
        if (/view/i.test(m) && !row.Views) row.Views = m.replace(/\s*views?/i, '').trim();
        else if (/\bago\b|Premiered|Streamed/i.test(m) && !row.Date) row.Date = m.replace(/^(Premiered|Streamed live on)\s*/i, '').trim();
        // Duration badge on the thumbnail, e.g. "10:23" or "1:02:05"
        else if (!row.Duration && /^\d{1,2}:\d{2}(:\d{2})?$/.test(m)) {
          row.Duration = m; row['Duration (sec)'] = clockToSec(m);
        }
      });

      // ── Fallback: parse aria-label ("… 1,234,567 views 2 days ago") ──
      const aria = linkEl?.getAttribute('aria-label') || titleEl?.getAttribute('aria-label') || '';
      if (!row.Views) { const vm = aria.match(/([\d,]+)\s*views?/i); if (vm) row.Views = vm[1]; }
      if (!row.Date)  { const dm = aria.match(/(\d+\s+(?:hour|day|week|month|year)s?\s+ago)/i); if (dm) row.Date = dm[1]; }

      return row;
    });

    return { rows, container };
  }

  // ── Instagram ──────────────────────────────────────────────────────────
  // /user/reels/ or /user/  — grid gives Views (reels) or Likes+Comments
  // (posts, on hover), URL, Thumbnail, and partial caption from img alt.
  function extractInstagram() {
    const isReels = /\/reels\/?/.test(location.pathname);
    const anchors = [...document.querySelectorAll('a[href*="/reel/"], a[href*="/p/"], a[href*="/tv/"]')];
    let container = anchors[0]?.closest('main, [role="main"]') || anchors[0]?.parentElement || null;
    const blob = pageScriptBlob();  // for embedded upload dates

    const rows = anchors.map(a => {
      const href = a.getAttribute('href') || '';
      if (!href) return null;
      const row = emptyRow();
      row.URL = makeAbsolute(href);

      // The visual card is usually the anchor or a wrapping div containing the img
      const card = a.closest('div[class]') || a.parentElement || a;
      const img = a.querySelector('img') || card.querySelector('img');
      row.Thumbnail = img?.src || bgImageUrl(card) || '';

      // Caption (grid best-effort) — reels tiles often have no img alt, so pull
      // from several sources. Deep Scrape later replaces this with the FULL
      // caption from the post page. Sources: img alt, img aria-label, the anchor's
      // aria-label/title, then any longer text node inside the tile.
      const alt = img?.getAttribute('alt')
        || img?.getAttribute('aria-label')
        || a.getAttribute('aria-label')
        || a.getAttribute('title') || '';
      let cap = cleanIgAlt(alt);
      if (!cap) {
        const txt = [...card.querySelectorAll('span, div')]
          .map(e => (e.children.length === 0 ? e.textContent.trim() : ''))
          .filter(t => t.length > 8 && !/^[\d.,]+[KMB]?$/.test(t) && !/^\d/.test(t));
        if (txt.length) cap = txt.sort((a, b) => b.length - a.length)[0].slice(0, 300);
      }
      row.Caption = cap;
      // Date: (1) alt text "... on January 1, 2024.", else (2) upload timestamp
      // from the page's embedded JSON, matched by the post's shortcode.
      const dm = alt.match(/on\s+([A-Z][a-z]+\s+\d{1,2},\s+\d{4})/);
      if (dm) row.Date = dm[1];
      const cm = href.match(/\/(?:reel|p|tv)\/([^/?]+)/);
      if (cm) {
        // Post copy / date / duration captured from Instagram's own API
        // responses (the grid tile itself carries none of this).
        applyPostMeta(row, cm[1]);
        if (!row.Date) row.Date = findTimestampNear(blob, cm[1]);
        if (!row.Duration) {
          const dsec = findDurationNear(blob, cm[1]);
          if (dsec) { row.Duration = secToClock(dsec); row['Duration (sec)'] = String(Math.round(dsec)); }
        }
      }

      const counts = grabCounts(card, isReels ? 'views' : null);
      row.Views = counts.views;
      row.Likes = counts.likes;
      row.Comments = counts.comments;
      row.Shares = counts.shares;
      // Instagram posts (non-reels) show likes+comments; if we only found one
      // unlabeled number on a non-reels grid, it is the like count.
      if (!isReels && !row.Likes && row.Views) { row.Likes = row.Views; row.Views = ''; }

      return row;
    }).filter(Boolean);

    return { rows, container };
  }

  // Instagram alt text looks like "Photo by NAME on January 01, 2024. May be
  // an image of ...". Strip the boilerplate; keep any useful remainder.
  function cleanIgAlt(alt) {
    if (!alt) return '';
    // Strip Instagram's auto-generated accessibility boilerplate:
    //   "Photo by NAME on January 1, 2024. May be an image of ..."
    let s = alt
      .replace(/^(Photo|Video|Reel)\s+(shared\s+)?by\s+.*?\son\s+[A-Z][a-z]+\s+\d{1,2},\s+\d{4}\.\s*/i, '')
      .replace(/^(Photo|Video|Reel)\s+(shared\s+)?by\s+[^.]*\.\s*/i, '')
      .replace(/^May be an?\s+(image|photo|video)\s+of\s*/i, '')
      .trim();
    return s.length > 1 ? s : alt.trim();
  }

  // ── Facebook ───────────────────────────────────────────────────────────
  // /page/reels/ — grid gives Views, URL, Thumbnail (background-image).
  function extractFacebook() {
    const anchors = [...document.querySelectorAll('a[href*="/reel/"], a[href*="/watch"], a[href*="/videos/"]')];
    let container = anchors[0]?.closest('[role="main"]') || anchors[0]?.parentElement || null;
    const blob = pageScriptBlob();  // for embedded upload dates

    const rows = anchors.map(a => {
      const href = a.getAttribute('href') || '';
      if (!href) return null;
      const row = emptyRow();
      row.URL = makeAbsolute(href.split('?')[0]);

      const card = a.closest('div[class]') || a.parentElement || a;
      const img = card.querySelector('img');
      row.Thumbnail = (img?.src) || bgImageUrl(card) || '';
      row.Caption = (img?.getAttribute('alt') || '').trim();

      const counts = grabCounts(card, 'views');
      row.Views = counts.views;
      row.Likes = counts.likes;
      row.Comments = counts.comments;
      row.Shares = counts.shares;

      // Upload date + duration from embedded JSON, matched by the reel/video id
      const idm = href.match(/\/(?:reel|videos)\/(\d+)/) || href.match(/[?&]v=(\d+)/);
      if (idm) {
        // Post copy / date / duration from Facebook's own API responses
        applyPostMeta(row, idm[1]);
        row.Date = row.Date || findTimestampNear(blob, idm[1]);
        if (!row.Duration) {
          const dsec = findDurationNear(blob, idm[1]);
          if (dsec) { row.Duration = secToClock(dsec); row['Duration (sec)'] = String(Math.round(dsec)); }
        }
      }
      return row;
    }).filter(Boolean);

    return { rows, container };
  }

  // ── LinkedIn ───────────────────────────────────────────────────────────
  // Feed / activity — richest grid: Caption, Reactions, Comments, Reposts,
  // relative Date, and post URL (built from the activity URN).
  function extractLinkedIn() {
    const posts = [...document.querySelectorAll(
      '.feed-shared-update-v2, div.feed-shared-update-v2, [data-urn*="urn:li:activity"], .occludable-update'
    )];
    let container = posts[0]?.parentElement || null;

    const rows = posts.map(post => {
      const row = emptyRow();

      // URL from activity URN
      let urn = post.getAttribute('data-urn') || '';
      if (!/activity/.test(urn)) {
        const child = post.querySelector('[data-urn*="urn:li:activity"]');
        urn = child?.getAttribute('data-urn') || '';
      }
      if (urn) row.URL = `https://www.linkedin.com/feed/update/${urn}/`;

      // Caption
      const cap = post.querySelector(
        '.update-components-text, .feed-shared-update-v2__description, ' +
        '.feed-shared-text, .update-components-update-v2__commentary'
      );
      row.Caption = (cap?.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 500);

      // Date (relative, e.g. "2d", "1w") — from the actor sub-description
      const sub = post.querySelector(
        '.update-components-actor__sub-description, .feed-shared-actor__sub-description, time'
      );
      if (sub) {
        const t = (sub.innerText || sub.textContent || '').trim();
        const m = t.match(/(\d+\s*(?:s|m|h|d|w|mo|y|hour|day|week|month|year)s?)\b/i);
        row.Date = m ? m[1] : t.split('•')[0].trim().slice(0, 30);
      }

      // Social counts
      const counts = post.querySelector('.social-details-social-counts');
      if (counts) {
        const react = counts.querySelector(
          '.social-details-social-counts__reactions-count, .social-details-social-counts__social-proof-fallback-number'
        );
        row.Likes = (react?.innerText || '').trim();
        [...counts.querySelectorAll('li, button, span')].forEach(el => {
          const t = (el.innerText || '').trim();
          if (/comment/i.test(t) && !row.Comments) { const m = t.match(/[\d.,]+/); if (m) row.Comments = m[0]; }
          if (/repost/i.test(t) && !row.Shares)   { const m = t.match(/[\d.,]+/); if (m) row.Shares = m[0]; }
        });
      }
      return row;
    }).filter(r => r.Caption || r.URL || r.Likes);

    return { rows, container };
  }

  function extractTable(table) {
    let headers = [];
    const rows = [];

    // Collect headers from <thead> or first row of <th>s
    const theadCells = [...table.querySelectorAll('thead th, thead td')];
    if (theadCells.length > 0) {
      headers = theadCells.map(cellText);
    } else {
      const firstRow = table.querySelector('tr');
      if (firstRow) {
        const ths = [...firstRow.querySelectorAll('th')];
        if (ths.length > 0) {
          headers = ths.map(cellText);
        } else {
          headers = [...firstRow.querySelectorAll('td')].map((td, i) => cellText(td) || `Col ${i + 1}`);
        }
      }
    }

    // Collect data rows
    table.querySelectorAll('tr').forEach(tr => {
      if (tr.closest('thead')) return;
      const cells = [...tr.querySelectorAll('td, th')];
      if (cells.length === 0) return;
      // skip pure-header rows (all th) that match the header we already captured
      if (cells.every(c => c.tagName === 'TH') && rows.length === 0) return;

      // Auto-extend headers if needed
      while (headers.length < cells.length) headers.push(`Col ${headers.length + 1}`);

      const row = {};
      cells.forEach((cell, j) => { row[uniqueKey(headers, j)] = cellText(cell); });
      rows.push(row);
    });

    return { headers: dedup(headers), rows };
  }

  function extractList(items) {
    if (!items || items.length === 0) return { headers: [], rows: [] };

    // Detect structural "special" fields present in the items (URL, Thumbnail, Description)
    const specialFields = detectSpecialFields(items);

    // Build text-leaf headers from the first item
    const leafEls = getLeafEls(items[0]);
    const textHeaders = leafEls.map((el, i) => labelFor(el, i));
    const allHeaders = dedup([...specialFields, ...textHeaders]);

    const rows = items.map(item => {
      const row = {};

      // Populate special fields
      if (specialFields.includes('URL')) {
        // Try inside item first, then look at sibling links in the parent card
        const a = (item.tagName === 'A' ? item : null)
          || item.querySelector('a[href]')
          || item.parentElement?.querySelector('a[href]');
        row['URL'] = a ? makeAbsolute(a.getAttribute('href') || '') : '';
      }
      if (specialFields.includes('Thumbnail')) {
        const img = (item.tagName === 'IMG' ? item : null)
          || item.querySelector('img[src]')
          || item.querySelector('img');
        const vid = !img && ((item.tagName === 'VIDEO' ? item : null)
          || item.querySelector('video[poster]')
          || item.querySelector('video'));
        row['Thumbnail'] = img
          ? (img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('srcset')?.split(' ')[0] || '')
          : vid ? (vid.getAttribute('poster') || vid.getAttribute('src') || '')
          : bgImageUrl(item);  // Facebook-style: thumbnail is a CSS background-image
      }
      if (specialFields.includes('Description')) {
        const img = (item.tagName === 'IMG' ? item : null)
          || item.querySelector('img[alt]')
          || item.querySelector('img');
        row['Description'] = img ? (img.alt?.trim() || '') : '';
      }

      // Populate text leaf fields (skip keys already claimed by special fields)
      const leaves = getLeafVals(item);
      textHeaders.forEach((h, i) => {
        if (!(h in row)) row[h] = leaves[i] ?? '';
      });

      return row;
    });

    // Drop columns that are blank for every row
    const liveHeaders = allHeaders.filter(h => rows.some(r => r[h]));
    const cleanRows = rows.map(r => {
      const out = {};
      liveHeaders.forEach(h => { out[h] = r[h]; });
      return out;
    });

    return { headers: liveHeaders.length ? liveHeaders : allHeaders, rows: cleanRows };
  }

  function detectSpecialFields(items) {
    const fields = [];
    const sample = items.slice(0, 5);

    // Check for links: inside item, item itself, OR sibling inside the same card parent
    const hasLink = sample.some(el => {
      if (el.tagName === 'A' && el.getAttribute('href')) return true;
      if (el.querySelector('a[href]')) return true;
      // Instagram overlay-link: <a> is a sibling of <img> inside the card wrapper
      const p = el.parentElement;
      return p && p.querySelector('a[href]');
    });
    if (hasLink) fields.push('URL');

    // Check for images/video/background-image: item itself or any descendant
    const hasImg = sample.some(el =>
      el.tagName === 'IMG' || el.tagName === 'VIDEO' ||
      el.querySelector('img, video') || bgImageUrl(el)
    );
    if (hasImg) {
      fields.push('Thumbnail');
      const imgs = sample.flatMap(el =>
        el.tagName === 'IMG' ? [el] : [...el.querySelectorAll('img')]
      );
      if (imgs.some(img => img.alt && img.alt.trim().length > 2)) {
        fields.push('Description');
      }
    }

    return fields;
  }

  function makeAbsolute(href) {
    if (!href) return '';
    if (href.startsWith('http')) return href;
    if (href.startsWith('//')) return location.protocol + href;
    if (href.startsWith('/')) return location.origin + href;
    return '';
  }

  // Extract the url(...) from a CSS background-image on the element or its
  // first descendant that has one (Facebook renders reel thumbnails this way).
  function bgImageUrl(el, depth = 0) {
    if (!el || depth > 4) return '';
    try {
      const bg = window.getComputedStyle(el).backgroundImage;
      const m = bg && bg.match(/url\((['"]?)(.*?)\1\)/);
      if (m && m[2] && !m[2].startsWith('data:')) return m[2];
    } catch (_) {}
    for (const c of el.children) {
      const u = bgImageUrl(c, depth + 1);
      if (u) return u;
    }
    return '';
  }

  // Text leaves only — <img>/<video> are excluded because they are already
  // captured by the Thumbnail/Description special fields (avoids duplicate cols).
  function getLeafEls(el, depth = 0) {
    if (depth > 5) return [];
    const out = [];
    for (const child of el.children) {
      if (child.tagName === 'IMG' || child.tagName === 'VIDEO') continue;
      if (child.children.length === 0) {
        if (child.textContent.trim()) out.push(child);
      } else {
        out.push(...getLeafEls(child, depth + 1));
      }
    }
    return out;
  }

  function getLeafVals(el, depth = 0) {
    if (depth > 5) return [];
    const out = [];
    for (const child of el.children) {
      if (child.tagName === 'IMG' || child.tagName === 'VIDEO') continue;
      if (child.children.length === 0) {
        const text = child.innerText?.trim().replace(/\s+/g, ' ') || '';
        if (text) out.push(text);
      } else {
        out.push(...getLeafVals(child, depth + 1));
      }
    }
    return out;
  }

  function labelFor(el, idx) {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();
    const dataLabel = el.getAttribute('data-label');
    if (dataLabel) return dataLabel.trim();
    // Derive from class names
    for (const cls of el.classList) {
      const readable = cls.replace(/[-_]/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
      if (readable.length > 1 && readable.length < 40 && !/^\d/.test(readable)) {
        return readable.charAt(0).toUpperCase() + readable.slice(1);
      }
    }
    // Preceding <label>
    const prev = el.previousElementSibling;
    if (prev && prev.tagName === 'LABEL') return prev.textContent.trim();
    // Tag-based defaults
    if (el.tagName === 'IMG') return 'Image';
    if (el.tagName === 'A') return 'Link';
    return `Field ${idx + 1}`;
  }

  function cellText(el) {
    return el.innerText?.trim().replace(/\s+/g, ' ') || '';
  }

  function dedup(arr) {
    const seen = {};
    return arr.map(v => {
      if (!seen[v]) { seen[v] = 1; return v; }
      seen[v]++;
      return `${v} ${seen[v]}`;
    });
  }

  function uniqueKey(headers, idx) {
    return headers[idx] !== undefined ? headers[idx] : `Col ${idx + 1}`;
  }

  // ─── Overlays ─────────────────────────────────────────────────────────────
  function createOverlays() {
    highlightBox = makeOverlay('3px solid #ff6600', 'rgba(255,102,0,0.08)', 2147483645);
    pickerBox = makeOverlay('2px solid #1a73e8', 'rgba(26,115,232,0.15)', 2147483646);

    window.addEventListener('scroll', () => updateHighlightPos(), { passive: true });
    window.addEventListener('resize', () => updateHighlightPos(), { passive: true });
  }

  function makeOverlay(border, bg, zIndex) {
    const el = document.createElement('div');
    el.style.cssText = [
      'position:fixed', 'pointer-events:none', `z-index:${zIndex}`,
      `border:${border}`, `background:${bg}`,
      'border-radius:3px', 'display:none', 'box-sizing:border-box',
      'transition:top .1s,left .1s,width .1s,height .1s'
    ].join(';');
    document.documentElement.appendChild(el);
    return el;
  }

  function showHighlight(el) {
    _highlightedEl = el;
    updateHighlightPos();
    if (highlightBox) highlightBox.style.display = 'block';
  }

  function hideHighlight() {
    _highlightedEl = null;
    if (highlightBox) highlightBox.style.display = 'none';
  }

  function updateHighlightPos() {
    if (!_highlightedEl || !highlightBox) return;
    try {
      const r = _highlightedEl.getBoundingClientRect();
      highlightBox.style.top = r.top + 'px';
      highlightBox.style.left = r.left + 'px';
      highlightBox.style.width = r.width + 'px';
      highlightBox.style.height = r.height + 'px';
    } catch (_) {}
  }

  // ─── Picker ───────────────────────────────────────────────────────────────
  function startPicker() {
    pickerActive = true;
    document.body.style.cursor = 'crosshair';
    document.addEventListener('mouseover', onPickerOver, true);
    document.addEventListener('mouseout', onPickerOut, true);
    document.addEventListener('click', onPickerClick, true);
    document.addEventListener('keydown', onPickerKey, true);
  }

  function stopPicker() {
    pickerActive = false;
    document.body.style.cursor = '';
    document.removeEventListener('mouseover', onPickerOver, true);
    document.removeEventListener('mouseout', onPickerOut, true);
    document.removeEventListener('click', onPickerClick, true);
    document.removeEventListener('keydown', onPickerKey, true);
    if (pickerBox) pickerBox.style.display = 'none';
  }

  function onPickerOver(e) {
    e.stopPropagation();
    const r = e.target.getBoundingClientRect();
    pickerBox.style.top = r.top + 'px';
    pickerBox.style.left = r.left + 'px';
    pickerBox.style.width = r.width + 'px';
    pickerBox.style.height = r.height + 'px';
    pickerBox.style.display = 'block';
  }

  function onPickerOut(e) { e.stopPropagation(); }

  function onPickerClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const selector = cssSelector(e.target);
    const text = e.target.textContent.trim().slice(0, 60);
    stopPicker();
    chrome.runtime.sendMessage({ type: 'pickerSelected', selector, selectorText: text, tabId: _tabId });
  }

  function onPickerKey(e) {
    if (e.key === 'Escape') { stopPicker(); chrome.runtime.sendMessage({ type: 'pickerCancelled' }); }
  }

  function cssSelector(el) {
    if (!el || el === document.body) return 'body';
    if (el.id) return '#' + CSS.escape(el.id);

    const path = [];
    let cur = el;
    while (cur && cur !== document.body && path.length < 6) {
      if (cur.id) { path.unshift('#' + CSS.escape(cur.id)); break; }
      let part = cur.tagName.toLowerCase();
      const cls = [...cur.classList]
        .filter(c => c.length < 40 && !/^(active|hover|focus|selected|is-|has-)/.test(c))
        .slice(0, 2);
      if (cls.length) part += '.' + cls.map(c => CSS.escape(c)).join('.');
      const sibs = cur.parentElement
        ? [...cur.parentElement.children].filter(s => s.tagName === cur.tagName)
        : [];
      if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(cur) + 1})`;
      path.unshift(part);
      cur = cur.parentElement;
    }
    return path.join(' > ');
  }

  // ─── Crawling ─────────────────────────────────────────────────────────────
  async function startCrawl(nextSelector, maxPages) {
    crawlActive = true;
    const allRows = [...currentData.rows];
    let page = 1;

    sendProgress(page, allRows);

    while (crawlActive && page < maxPages) {
      const nextEl = document.querySelector(nextSelector);
      if (!nextEl || !visible(nextEl)) break;
      if (nextEl.disabled || nextEl.getAttribute('aria-disabled') === 'true') break;

      const isNavigating = nextEl.tagName === 'A'
        && nextEl.href
        && !nextEl.href.startsWith('javascript:')
        && !nextEl.target
        && !nextEl.href.startsWith('#');

      if (isNavigating) {
        // Store state so the next page's content script can continue
        const state = {
          active: true,
          page: page + 1,
          maxPages,
          nextSelector,
          candidateIndex: currentIndex,
          tabId: _tabId,
          rows: allRows
        };
        try {
          await chrome.storage.session.set({ [`ids_crawl_${_tabId}`]: state });
        } catch (_) {
          // Fallback: sessionStorage (same tab only)
          try { sessionStorage.setItem('__ids_crawl__', JSON.stringify(state)); } catch (_) {}
        }
        nextEl.click();
        return; // content script will re-init on new page
      }

      // AJAX pagination: click and wait for content to change
      const snapshot = JSON.stringify(currentData.rows.slice(0, 3));
      nextEl.click();
      await waitForChange(snapshot);

      page++;

      // Re-detect at same candidate position
      const fresh = buildCandidates();
      const idx = Math.min(currentIndex, fresh.length - 1);
      if (idx >= 0) {
        const newData = extractData(fresh[idx]);
        const rowSet = new Set(allRows.map(r => JSON.stringify(r)));
        newData.rows.forEach(row => {
          const k = JSON.stringify(row);
          if (!rowSet.has(k)) { rowSet.add(k); allRows.push(row); }
        });
        currentData = newData;
        candidates = fresh;
      }

      sendProgress(page, allRows);
    }

    crawlActive = false;
    chrome.runtime.sendMessage({ type: 'crawlComplete', allRows, pages: page }).catch(() => {});
  }

  // ─── Infinite scroll crawl ────────────────────────────────────────────────
  async function startInfiniteScrollCrawl(maxScrolls) {
    crawlActive = true;
    const allRows = [...currentData.rows];
    let scroll = 1;
    let staleCount = 0;

    sendProgress(scroll, allRows);

    while (crawlActive && scroll <= maxScrolls) {
      const prevSize = allRows.length;

      // Scroll window and any scrollable container to the bottom
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
      const scroller = findScrollContainer();
      if (scroller) scroller.scrollTop = scroller.scrollHeight;

      // Wait for new items to appear in the DOM
      await waitForNewItems(prevSize);
      scroll++;

      // Re-detect at same candidate position and merge new rows
      const fresh = buildCandidates();
      const idx = Math.min(currentIndex, fresh.length - 1);
      if (idx >= 0) {
        const newData = extractData(fresh[idx]);
        const rowSet = new Set(allRows.map(r => JSON.stringify(r)));
        newData.rows.forEach(row => {
          const k = JSON.stringify(row);
          if (!rowSet.has(k)) { rowSet.add(k); allRows.push(row); }
        });
        currentData = newData;
        candidates = fresh;
      }

      sendProgress(scroll, allRows);

      if (allRows.length === prevSize) {
        staleCount++;
        if (staleCount >= 3) break; // No new content after 3 consecutive scrolls
      } else {
        staleCount = 0;
      }
    }

    crawlActive = false;
    chrome.runtime.sendMessage({ type: 'crawlComplete', allRows, pages: scroll }).catch(() => {});
  }

  async function waitForNewItems(currentCount, timeout = 7000) {
    return new Promise(resolve => {
      const timer = setTimeout(() => { obs.disconnect(); resolve(); }, timeout);
      const obs = new MutationObserver(() => {
        const fresh = buildCandidates();
        const idx = Math.min(currentIndex, fresh.length - 1);
        if (idx < 0) return;
        if (extractData(fresh[idx]).rows.length > currentCount) {
          obs.disconnect();
          clearTimeout(timer);
          setTimeout(resolve, 500); // Extra wait for lazy-loaded images / React renders
        }
      });
      obs.observe(document.body, { childList: true, subtree: true });
    });
  }

  function findScrollContainer() {
    const candidates = [
      document.querySelector('[role="main"]'),
      document.querySelector('main'),
      ...document.querySelectorAll('[style*="overflow"]'),
    ].filter(el => el && el !== document.body && el.scrollHeight > el.clientHeight + 100);
    return candidates[0] || null;
  }

  function sendProgress(page, allRows) {
    chrome.runtime.sendMessage({ type: 'crawlProgress', page, allRows }).catch(() => {});
  }

  async function waitForChange(snapshot, timeout = 8000) {
    return new Promise(resolve => {
      const timer = setTimeout(() => { obs.disconnect(); resolve(); }, timeout);
      const obs = new MutationObserver(() => {
        const fresh = buildCandidates();
        const idx = Math.min(currentIndex, fresh.length - 1);
        if (idx < 0) return;
        const newSnap = JSON.stringify(extractData(fresh[idx]).rows.slice(0, 3));
        if (newSnap !== snapshot) {
          obs.disconnect();
          clearTimeout(timer);
          setTimeout(resolve, 400);
        }
      });
      obs.observe(document.body, { childList: true, subtree: true, characterData: true });
    });
  }

  // Called on page load to resume a cross-page crawl
  async function checkPendingCrawl() {
    let state = null;
    try {
      const res = await chrome.storage.session.get('__ids_crawl_pending__');
      // Try tab-specific key; we don't know our tabId yet, so check sessionStorage as fallback
      const raw = sessionStorage.getItem('__ids_crawl__');
      if (raw) {
        state = JSON.parse(raw);
        sessionStorage.removeItem('__ids_crawl__');
      }
    } catch (_) {}
    if (!state || !state.active) return;

    _tabId = state.tabId;

    await pageReady();
    await sleep(600);

    detect();
    currentIndex = Math.min(state.candidateIndex, candidates.length - 1);
    currentData = extractData(candidates[currentIndex] || candidates[0]);

    const allRows = state.rows || [];
    const rowSet = new Set(allRows.map(r => JSON.stringify(r)));
    (currentData.rows || []).forEach(row => {
      const k = JSON.stringify(row);
      if (!rowSet.has(k)) { rowSet.add(k); allRows.push(row); }
    });

    sendProgress(state.page, allRows);

    if (state.page >= state.maxPages) {
      chrome.runtime.sendMessage({ type: 'crawlComplete', allRows, pages: state.page }).catch(() => {});
      return;
    }

    // Continue crawl (will set sessionStorage again if navigating)
    crawlActive = true;
    const nextEl = document.querySelector(state.nextSelector);
    if (!nextEl || !visible(nextEl)) {
      chrome.runtime.sendMessage({ type: 'crawlComplete', allRows, pages: state.page }).catch(() => {});
      return;
    }

    // Update current data and keep crawling
    currentData = { headers: currentData.headers, rows: allRows };
    startCrawl(state.nextSelector, state.maxPages);
  }

  function pageReady() {
    return new Promise(resolve => {
      if (document.readyState === 'complete') resolve();
      else window.addEventListener('load', resolve, { once: true });
    });
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ─── Popup connection tracking ───────────────────────────────────────────
  // The popup opens a port when it launches; when it closes, the port
  // disconnects. We only show the orange highlight box while the popup is open,
  // so ordinary browsing never gets a border drawn on the page.
  function registerPopupConnection() {
    try {
      chrome.runtime.onConnect.addListener(port => {
        if (port.name !== 'ids-popup') return;
        popupOpen = true;
        // Re-highlight the current candidate now that the popup is open
        if (candidates.length > 0) {
          try { showHighlight(candidates[currentIndex]?.element || candidates[0].element); } catch (_) {}
        }
        port.onDisconnect.addListener(() => {
          popupOpen = false;
          try { hideHighlight(); } catch (_) {}
          if (pickerActive) { try { stopPicker(); } catch (_) {} }
        });
      });
    } catch (_) {}
  }

  // ─── Message Listener ────────────────────────────────────────────────────
  // Wrapped in a hoisted function so bootstrap can register it FIRST, before
  // any code that might throw. This guarantees the popup can always reach us.
  function registerMessageListener() {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.tabId) _tabId = msg.tabId;

    switch (msg.action) {
      case 'ping':
        sendResponse({ ok: true });
        break;

      case 'detect':
        // A 'detect' only ever comes from the popup → the popup is open.
        popupOpen = true;
        try { detect(); } catch (e) { console.warn('IDS detect failed', e); }
        if (candidates.length > 0) {
          try { showHighlight(candidates[currentIndex]?.element || candidates[0].element); } catch (_) {}
          sendResponse({ data: currentData, count: candidates.length, currentIndex });
        } else {
          // SPA (Instagram/React/Vue): content may still be rendering.
          // Retry at 800ms, 2000ms, and 4000ms before giving up.
          (async () => {
            for (const delay of [800, 1200, 2000]) {
              await sleep(delay);
              detect();
              if (candidates.length > 0) break;
            }
            if (candidates.length > 0) {
              try { showHighlight(candidates[currentIndex]?.element || candidates[0].element); } catch (_) {}
            }
            sendResponse({ data: currentData, count: candidates.length, currentIndex });
          })();
        }
        break;

      case 'nextCandidate':
        if (candidates.length > 0) {
          currentIndex = (currentIndex + 1) % candidates.length;
          currentData = extractData(candidates[currentIndex]);
          showHighlight(candidates[currentIndex].element);
        }
        sendResponse({ data: currentData, count: candidates.length, currentIndex });
        break;

      case 'getData':
        sendResponse({ data: currentData });
        break;

      case 'startPicker':
        startPicker();
        sendResponse({ ok: true });
        break;

      case 'stopPicker':
        stopPicker();
        sendResponse({ ok: true });
        break;

      case 'startCrawl':
        startCrawl(msg.nextSelector, msg.maxPages || 100);
        sendResponse({ ok: true });
        break;

      case 'startInfiniteScroll':
        startInfiniteScrollCrawl(msg.maxScrolls || 100);
        sendResponse({ ok: true });
        break;

      case 'stopCrawl':
        crawlActive = false;
        sendResponse({ ok: true });
        break;

      case 'hideHighlight':
        hideHighlight();
        sendResponse({ ok: true });
        break;

      default:
        sendResponse({ ok: false, error: 'unknown action' });
    }
    return true;
    });
  }
})();
