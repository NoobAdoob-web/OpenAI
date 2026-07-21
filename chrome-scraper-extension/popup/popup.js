'use strict';

// ── State ──────────────────────────────────────────────────────────────────
let tabId = null;
let currentData = { headers: [], rows: [] }; // current-page detection
let exportRows = [];                          // rows to export (grows during crawl)
let exportHeaders = [];
let nextSelector = null;
let crawling = false;
let infiniteScrollMode = false;

// ── Bootstrap ──────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab.id;

  await ensureContentScript();
  await restoreTabState();     // check for saved selector / crawl data
  await detectPage();
  bindUI();
  listenMessages();
});

// ── Ensure content script is injected ────────────────────────────────────
async function ensureContentScript() {
  try {
    await chrome.tabs.sendMessage(tabId, { action: 'ping', tabId });
  } catch (_) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content/content.js'] });
      await sleep(200);
    } catch (err) {
      console.warn('Content script injection failed:', err);
    }
  }
}

// ── Restore persisted state (selector set before popup was closed) ────────
async function restoreTabState() {
  try {
    const state = await chrome.runtime.sendMessage({ action: 'getTabState', tabId });
    if (!state) return;

    if (state.selector) {
      nextSelector = state.selector;
      showSelector(state.selector, state.selectorText);
    }
    if (state.crawlRows && state.crawlRows.length > 0) {
      exportRows = state.crawlRows;
      if (state.crawlComplete) {
        setStatus(`Complete — ${exportRows.length} rows from ${state.crawlPages ?? '?'} pages`, 'done');
      } else {
        setStatus(`Page ${state.crawlPage ?? '?'} — ${exportRows.length} rows collected`, '');
      }
      updateExportButtons();
    }
  } catch (_) {}
}

// ── Detect data on the active tab ────────────────────────────────────────
async function detectPage() {
  show('loading-state');
  try {
    const res = await chrome.tabs.sendMessage(tabId, { action: 'detect', tabId });
    if (res && res.data && res.data.rows.length > 0) {
      currentData = res.data;
      if (exportRows.length === 0) {
        exportRows = [...currentData.rows];
        exportHeaders = currentData.headers;
      }
      renderPreview(currentData);
      updateCandidateLabel(res.currentIndex + 1, res.count);
      show('main-ui');
    } else {
      show('empty-state');
    }
  } catch (_) {
    show('empty-state');
  }
}

// ── Render preview table ──────────────────────────────────────────────────
function renderPreview(data) {
  const { headers, rows } = data;
  if (!rows.length) { show('empty-state'); return; }

  $('badge-rows').textContent = rows.length;
  $('badge-cols').textContent = headers.length;

  const table = $('preview-table');
  table.innerHTML = '';

  // <thead>
  const thead = document.createElement('thead');
  const tr = document.createElement('tr');
  headers.forEach(h => {
    const th = document.createElement('th');
    th.textContent = h || '(empty)';
    th.title = h;
    tr.appendChild(th);
  });
  thead.appendChild(tr);
  table.appendChild(thead);

  // <tbody> — show first 10 rows
  const tbody = document.createElement('tbody');
  rows.slice(0, 10).forEach(row => {
    const tr = document.createElement('tr');
    headers.forEach(h => {
      const td = document.createElement('td');
      const v = row[h] ?? '';
      td.textContent = v;
      td.title = v;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  const footer = $('preview-footer');
  footer.textContent = rows.length > 10
    ? `Showing 10 of ${rows.length} rows`
    : `${rows.length} row${rows.length !== 1 ? 's' : ''} total`;
}

// ── UI bindings ────────────────────────────────────────────────────────────
function bindUI() {
  $('btn-try-another').addEventListener('click', onTryAnother);
  $('btn-locate-next').addEventListener('click', onLocateNext);
  $('btn-infinite-scroll').addEventListener('click', onInfiniteScrollToggle);
  $('btn-clear-selector').addEventListener('click', onClearSelector);
  $('btn-start-crawl').addEventListener('click', onStartCrawl);
  $('btn-stop-crawl').addEventListener('click', onStopCrawl);
  $('btn-csv').addEventListener('click', downloadCSV);
  $('btn-xlsx').addEventListener('click', downloadXLSX);
  $('deep-toggle').addEventListener('change', onDeepToggle);
  $('btn-deep-start').addEventListener('click', onDeepStart);
  $('btn-deep-stop').addEventListener('click', onDeepStop);
}

// ── Deep Scrape ──────────────────────────────────────────────────────────
let deepRunning = false;

function onDeepToggle() {
  $('deep-options').style.display = $('deep-toggle').checked ? '' : 'none';
}

async function onDeepStart() {
  if (deepRunning) return;

  // Collect post URLs from the rows we already have
  const urls = exportRows.map(r => r['URL']).filter(u => u && /^https?:/.test(u));
  if (urls.length === 0) {
    setDeepStatus('No post links found. Detect/scroll a social profile first.', 'error');
    return;
  }

  const options = {
    date: $('deep-date').checked,
    likes: $('deep-likes').checked,
    comments: $('deep-comments').checked,
    shares: $('deep-shares').checked,
    commentText: $('deep-commenttext').checked,
    maxComments: 20,
  };
  if (!options.date && !options.likes && !options.comments && !options.shares && !options.commentText) {
    setDeepStatus('Pick at least one field to collect.', 'error');
    return;
  }

  const maxPosts = parseInt($('deep-max').value) || 50;
  const delayMs = (parseInt($('deep-delay').value) || 3) * 1000;
  const targetUrls = urls.slice(0, maxPosts);

  deepRunning = true;
  $('btn-deep-start').style.display = 'none';
  $('btn-deep-stop').style.display = 'inline-flex';
  setDeepStatus(`Starting… ${targetUrls.length} posts to open`);

  // Ensure "Comment Text" column exists in export if requested
  if (options.commentText && !exportHeaders.includes('Comment Text')) {
    exportHeaders = insertBefore(exportHeaders, 'URL', 'Comment Text');
  }

  await chrome.runtime.sendMessage({
    action: 'startDeepScrape',
    tabId,
    urls: targetUrls,
    options,
    delayMs,
  }).catch(() => {});
}

async function onDeepStop() {
  await chrome.runtime.sendMessage({ action: 'stopDeepScrape', tabId }).catch(() => {});
  endDeep();
  setDeepStatus(`Stopped — ${countEnriched()} posts enriched`, '');
}

function endDeep() {
  deepRunning = false;
  $('btn-deep-stop').style.display = 'none';
  $('btn-deep-start').style.display = 'inline-flex';
}

function applyDeepResult(url, fields) {
  const row = exportRows.find(r => r['URL'] === url);
  if (!row || !fields) return;
  if (fields.Date)     row['Date'] = fields.Date;
  if (fields.Likes)    { row['Likes'] = fields.Likes; row['Likes (number)'] = toNum(fields.Likes); }
  if (fields.Comments) { row['Comments'] = fields.Comments; row['Comments (number)'] = toNum(fields.Comments); }
  if (fields.Shares)   { row['Shares'] = fields.Shares; row['Shares (number)'] = toNum(fields.Shares); }
  if (fields.CommentText) row['Comment Text'] = fields.CommentText;
}

function countEnriched() {
  return exportRows.filter(r => r['Likes'] || r['Comments'] || r['Shares'] || r['Comment Text']).length;
}

function toNum(s) {
  if (!s) return '';
  const t = String(s).replace(/,/g, '').trim();
  const m = t.match(/([\d]+(?:\.[\d]+)?)\s*([KMB])?/i);
  if (!m) return '';
  let n = parseFloat(m[1]);
  if (isNaN(n)) return '';
  const suf = (m[2] || '').toUpperCase();
  if (suf === 'K') n *= 1e3; else if (suf === 'M') n *= 1e6; else if (suf === 'B') n *= 1e9;
  return String(Math.round(n));
}

function insertBefore(arr, before, item) {
  const i = arr.indexOf(before);
  if (i < 0) return [...arr, item];
  return [...arr.slice(0, i), item, ...arr.slice(i)];
}

function setDeepStatus(msg, cls = '') {
  const el = $('deep-status');
  el.textContent = msg;
  el.className = 'crawl-status' + (cls ? ' ' + cls : '');
}

async function onTryAnother() {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { action: 'nextCandidate', tabId });
    if (res && res.data && res.data.rows.length > 0) {
      currentData = res.data;
      exportRows = [...currentData.rows];
      exportHeaders = currentData.headers;
      renderPreview(currentData);
      updateCandidateLabel(res.currentIndex + 1, res.count);
      updateExportButtons();
      setStatus('');
    }
  } catch (_) {}
}

async function onLocateNext() {
  const btn = $('btn-locate-next');
  const isActive = btn.classList.contains('active');

  if (isActive) {
    await chrome.tabs.sendMessage(tabId, { action: 'stopPicker', tabId }).catch(() => {});
    btn.classList.remove('active');
    btn.textContent = '⊕ Locate Next Button';
    return;
  }

  await chrome.tabs.sendMessage(tabId, { action: 'startPicker', tabId }).catch(() => {});
  btn.classList.add('active');
  btn.textContent = '✕ Cancel';
  // Popup will close when user clicks on the page; picker result arrives via background message
  window.close();
}

function onClearSelector() {
  nextSelector = null;
  $('selector-display').textContent = 'Not set';
  $('selector-display').classList.remove('set');
  $('btn-clear-selector').style.display = 'none';
  $('btn-start-crawl').disabled = true;
  chrome.runtime.sendMessage({ action: 'setTabState', tabId, state: { selector: null, selectorText: null } }).catch(() => {});
}

function onInfiniteScrollToggle() {
  infiniteScrollMode = !infiniteScrollMode;
  const btn = $('btn-infinite-scroll');
  const locateBtn = $('btn-locate-next');

  if (infiniteScrollMode) {
    btn.classList.add('active');
    btn.textContent = '✓ Infinite Scroll ON';
    locateBtn.disabled = true;
    $('selector-display').textContent = 'Infinite scroll mode active';
    $('selector-display').className = 'selector-display set';
    $('btn-clear-selector').style.display = 'none';
    $('btn-start-crawl').disabled = false;
  } else {
    btn.classList.remove('active');
    btn.textContent = '↓ Infinite Scroll';
    locateBtn.disabled = false;
    if (nextSelector) {
      showSelector(nextSelector, null);
    } else {
      $('selector-display').textContent = 'Not set';
      $('selector-display').className = 'selector-display';
      $('btn-start-crawl').disabled = true;
    }
  }
}

async function onStartCrawl() {
  if (crawling) return;
  if (!infiniteScrollMode && !nextSelector) return;

  const maxPages = parseInt($('input-max-pages').value) || 100;

  crawling = true;
  exportRows = [...currentData.rows];
  exportHeaders = currentData.headers;

  $('btn-start-crawl').style.display = 'none';
  $('btn-stop-crawl').style.display = 'inline-flex';
  updateExportButtons();

  if (infiniteScrollMode) {
    setStatus(`Scrolling… ${exportRows.length} rows loaded`);
    await chrome.tabs.sendMessage(tabId, {
      action: 'startInfiniteScroll',
      tabId,
      maxScrolls: maxPages
    }).catch(() => {});
  } else {
    setStatus(`Crawling page 1… ${exportRows.length} rows`);
    await chrome.tabs.sendMessage(tabId, {
      action: 'startCrawl',
      tabId,
      nextSelector,
      maxPages
    }).catch(() => {});
  }
}

async function onStopCrawl() {
  await chrome.tabs.sendMessage(tabId, { action: 'stopCrawl', tabId }).catch(() => {});
  endCrawl();
  setStatus(`Stopped — ${exportRows.length} rows collected`);
}

function endCrawl() {
  crawling = false;
  $('btn-stop-crawl').style.display = 'none';
  $('btn-start-crawl').style.display = 'inline-flex';
}

// ── Message listener (for progress / crawl-complete from background) ──────
function listenMessages() {
  chrome.runtime.onMessage.addListener(msg => {
    if (msg.type === 'pickerSelected') {
      nextSelector = msg.selector;
      showSelector(msg.selector, msg.selectorText);
    }

    if (msg.type === 'pickerCancelled') {
      $('btn-locate-next').classList.remove('active');
      $('btn-locate-next').textContent = '⊕ Locate Next Button';
    }

    if (msg.type === 'crawlProgress') {
      exportRows = msg.allRows || exportRows;
      if (!exportHeaders.length && currentData.headers.length) exportHeaders = currentData.headers;
      const label = infiniteScrollMode ? `Scroll ${msg.page}` : `Page ${msg.page}`;
      setStatus(`${label}… ${exportRows.length} rows collected`);
      updateExportButtons();
      $('badge-rows').textContent = exportRows.length;
    }

    if (msg.type === 'crawlComplete') {
      exportRows = msg.allRows || exportRows;
      endCrawl();
      setStatus(`Complete — ${exportRows.length} rows from ${msg.pages} page${msg.pages !== 1 ? 's' : ''}`, 'done');
      updateExportButtons();
      $('badge-rows').textContent = exportRows.length;
      // Refresh preview with all accumulated rows
      if (exportRows.length > 0 && currentData.headers.length > 0) {
        renderPreview({ headers: currentData.headers, rows: exportRows });
      }
    }

    if (msg.type === 'deepProgress') {
      applyDeepResult(msg.url, msg.fields);
      const errNote = msg.fields && msg.fields._error ? ` (last: ${msg.fields._error})` : '';
      setDeepStatus(`Deep scraping… ${msg.done}/${msg.total} posts${errNote}`);
      updateExportButtons();
      // Live-refresh the preview so the user sees fields filling in
      renderPreview({ headers: exportHeaders.length ? exportHeaders : currentData.headers, rows: exportRows });
    }

    if (msg.type === 'deepComplete') {
      // Apply any results not already applied
      if (msg.results) Object.keys(msg.results).forEach(u => applyDeepResult(u, msg.results[u]));
      endDeep();
      setDeepStatus(`✓ Done — ${msg.count} posts opened, ${countEnriched()} enriched`, 'done');
      updateExportButtons();
      renderPreview({ headers: exportHeaders.length ? exportHeaders : currentData.headers, rows: exportRows });
    }
  });
}

// ── Selector display ─────────────────────────────────────────────────────
function showSelector(sel, text) {
  const el = $('selector-display');
  el.textContent = text ? `${text} (${sel})` : sel;
  el.title = sel;
  el.classList.add('set');
  $('btn-clear-selector').style.display = 'inline-flex';
  $('btn-start-crawl').disabled = false;
}

// ── Export buttons ────────────────────────────────────────────────────────
function updateExportButtons() {
  const has = exportRows.length > 0;
  $('btn-csv').disabled = !has;
  $('btn-xlsx').disabled = !has;
}

// ── CSV download ──────────────────────────────────────────────────────────
function downloadCSV() {
  const headers = exportHeaders.length ? exportHeaders : currentData.headers;
  const rows = exportRows;
  if (!rows.length) return;

  const esc = v => {
    const s = String(v ?? '');
    return (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r'))
      ? '"' + s.replace(/"/g, '""') + '"'
      : s;
  };

  const lines = [
    headers.map(esc).join(','),
    ...rows.map(row => headers.map(h => esc(row[h])).join(','))
  ];

  triggerDownload(
    '﻿' + lines.join('\r\n'),   // BOM for Excel UTF-8 recognition
    'text/csv;charset=utf-8',
    `scraped_data_${ts()}.csv`
  );
}

// ── Excel (SpreadsheetML) download ────────────────────────────────────────
function downloadXLSX() {
  const headers = exportHeaders.length ? exportHeaders : currentData.headers;
  const rows = exportRows;
  if (!rows.length) return;

  const x = v => String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const isNum = v => v !== '' && v !== null && v !== undefined && !isNaN(Number(v));

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Styles>
  <Style ss:ID="h">
   <Font ss:Bold="1" ss:Color="#FFFFFF"/>
   <Interior ss:Color="#1A73E8" ss:Pattern="Solid"/>
  </Style>
  <Style ss:ID="e">
   <Interior ss:Color="#F8F9FA" ss:Pattern="Solid"/>
  </Style>
 </Styles>
 <Worksheet ss:Name="Sheet1">
  <Table>\n`;

  // Header row
  xml += '   <Row>\n';
  headers.forEach(h => {
    xml += `    <Cell ss:StyleID="h"><Data ss:Type="String">${x(h)}</Data></Cell>\n`;
  });
  xml += '   </Row>\n';

  // Data rows
  rows.forEach((row, i) => {
    const style = i % 2 === 1 ? ' ss:StyleID="e"' : '';
    xml += '   <Row>\n';
    headers.forEach(h => {
      const v = row[h] ?? '';
      const type = isNum(v) ? 'Number' : 'String';
      xml += `    <Cell${style}><Data ss:Type="${type}">${x(v)}</Data></Cell>\n`;
    });
    xml += '   </Row>\n';
  });

  xml += `  </Table>
 </Worksheet>
</Workbook>`;

  triggerDownload(xml, 'application/vnd.ms-excel;charset=utf-8', `scraped_data_${ts()}.xls`);
}

function triggerDownload(content, mimeType, filename) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename, saveAs: false }, () => {
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }

function show(id) {
  ['loading-state', 'empty-state', 'main-ui'].forEach(sid => {
    document.getElementById(sid).style.display = sid === id ? '' : 'none';
  });
}

function setStatus(msg, cls = '') {
  const el = $('crawl-status');
  el.textContent = msg;
  el.className = 'crawl-status' + (cls ? ' ' + cls : '');
}

function updateCandidateLabel(current, total) {
  $('candidate-label').textContent = total > 1 ? `Table ${current} of ${total}` : '';
}

function ts() { return new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
