/* Instant Data Scraper – content script */
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
  let _tabId = null; // set by popup on first message

  // ─── Bootstrap ───────────────────────────────────────────────────────────
  createOverlays();
  checkPendingCrawl();
  detect();

  // ─── Detection ───────────────────────────────────────────────────────────
  function detect() {
    candidates = buildCandidates();
    currentIndex = 0;
    if (candidates.length > 0) {
      currentData = extractData(candidates[0]);
      showHighlight(candidates[0].element);
    } else {
      currentData = { headers: [], rows: [] };
      hideHighlight();
    }
  }

  function buildCandidates() {
    const results = [];
    const usedEls = new Set();

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

    // Sort best first, skip root elements
    return results
      .filter(c => c.element !== document.body && c.element !== document.documentElement)
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
      return candidate.type === 'table'
        ? extractTable(candidate.element)
        : extractList(candidate.items || [...candidate.element.children].filter(visible));
    } catch (_) {
      return { headers: [], rows: [] };
    }
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
          : vid ? (vid.getAttribute('poster') || vid.getAttribute('src') || '') : '';
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

    // Check for images/video: item itself or any descendant
    const hasImg = sample.some(el =>
      el.tagName === 'IMG' || el.tagName === 'VIDEO' ||
      el.querySelector('img, video')
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

  function getLeafEls(el, depth = 0) {
    if (depth > 5) return [];
    const out = [];
    for (const child of el.children) {
      if (child.children.length === 0) {
        if (child.textContent.trim() || child.tagName === 'IMG') out.push(child);
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
      if (child.children.length === 0) {
        const text = child.tagName === 'IMG'
          ? (child.alt || child.getAttribute('src') || '')
          : child.innerText?.trim().replace(/\s+/g, ' ') || '';
        if (text || child.tagName === 'IMG') out.push(text);
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

  let _highlightedEl = null;

  function showHighlight(el) {
    _highlightedEl = el;
    updateHighlightPos();
    highlightBox.style.display = 'block';
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

  // ─── Message Listener ────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.tabId) _tabId = msg.tabId;

    switch (msg.action) {
      case 'ping':
        sendResponse({ ok: true });
        break;

      case 'detect':
        detect();
        if (candidates.length > 0) {
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
})();
