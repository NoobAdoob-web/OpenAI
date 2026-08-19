'use strict';

// ── State ──────────────────────────────────────────────────────────────────
let tabId = null;
let currentData = { headers: [], rows: [] }; // current-page detection
let exportRows = [];                          // rows to export (grows during crawl)
let exportHeaders = [];
let crawling = false;

// ── Bootstrap ──────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  try { $('version-badge').textContent = 'v' + chrome.runtime.getManifest().version; } catch (_) {}

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab.id;

  await ensureContentScript();
  openHighlightPort();         // tells the page to show the highlight only while open
  await restoreTabState();     // check for saved selector / crawl data
  await detectPage();
  bindUI();
  listenMessages();
});

// Open a port to the content script. While this port is alive the page shows
// the orange highlight box; when the popup closes the port disconnects and the
// content script removes the border. Keeps ordinary browsing border-free.
function openHighlightPort() {
  try { chrome.tabs.connect(tabId, { name: 'ids-popup' }); } catch (_) {}
}

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

    if (state.crawlRows && state.crawlRows.length > 0) {
      exportRows = state.crawlRows;
      if (state.crawlComplete) {
        setStatus(`Complete — ${exportRows.length} rows collected`, 'done');
      } else {
        setStatus(`${exportRows.length} rows collected`, '');
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
      refreshPreview();
      updateCandidateLabel(res.currentIndex + 1, res.count);
      show('main-ui');
      updateExportButtons();
      recomputeInvestment();
    } else {
      show('empty-state');
    }
  } catch (_) {
    show('empty-state');
  }
}

// ── Ranking (top performers) ──────────────────────────────────────────────
// Primary metric = Views, else Likes, else Comments (so LinkedIn ranks by
// likes, video platforms by views). Returns a NEW headers/rows with a Rank
// column, sorted best-first; the original exportRows keep their scraped order.
function primaryMetric(row) {
  const v = Number(row['Views (number)']); if (v) return v;
  const l = Number(row['Likes (number)']); if (l) return l;
  const c = Number(row['Comments (number)']); if (c) return c;
  return -1; // no metric → sorts last, stably
}

function buildRanked(headers, rows) {
  const indexed = rows.map((r, i) => ({ r, i, m: primaryMetric(r) }));
  indexed.sort((a, b) => (b.m - a.m) || (a.i - b.i)); // desc, stable on ties
  const rankedRows = indexed.map((o, k) => Object.assign({ 'Rank': String(k + 1) }, o.r));
  return { headers: ['Rank', ...headers], rows: rankedRows };
}

function currentHeaders() {
  return exportHeaders.length ? exportHeaders : currentData.headers;
}

// Render the preview as the ranked (Top Performers) view.
function refreshPreview() {
  if (!exportRows.length) return;
  renderPreview(buildRanked(currentHeaders(), exportRows));
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
  $('btn-start-crawl').addEventListener('click', onStartCrawl);
  $('btn-stop-crawl').addEventListener('click', onStopCrawl);
  $('btn-csv').addEventListener('click', downloadCSV);
  $('btn-xlsx').addEventListener('click', downloadXLSX);
  $('deep-toggle').addEventListener('change', onDeepToggle);
  $('btn-deep-start').addEventListener('click', onDeepStart);
  $('btn-deep-stop').addEventListener('click', onDeepStop);
  $('input-cpv').addEventListener('input', recomputeInvestment);
  $('ocr-toggle').addEventListener('change', onOcrToggle);
  $('btn-ocr-start').addEventListener('click', onOcrStart);
  $('btn-ocr-stop').addEventListener('click', onOcrStop);
}

// ── Image OCR ────────────────────────────────────────────────────────────
let ocrRunning = false;
const OCR_COLUMNS = ['Image Text', 'Content Type', 'Image Language'];

function onOcrToggle() {
  $('ocr-options').style.display = $('ocr-toggle').checked ? '' : 'none';
}

async function onOcrStart() {
  if (ocrRunning) return;

  // Build the work list from rows that have a thumbnail image
  const items = exportRows
    .filter(r => r['Thumbnail'] && /^https?:/.test(r['Thumbnail']) && r['URL'])
    .map(r => ({ key: r['URL'], thumb: r['Thumbnail'] }));
  if (items.length === 0) {
    setOcrStatus('No images found. Scrape a profile with thumbnails first.', 'error');
    return;
  }

  const max = parseInt($('ocr-max').value) || 50;
  const target = items.slice(0, max);

  // Ensure the OCR columns exist (appended after Thumbnail)
  if (!exportHeaders.length && currentData.headers.length) exportHeaders = [...currentData.headers];
  OCR_COLUMNS.forEach(c => { if (!exportHeaders.includes(c)) exportHeaders.push(c); });

  ocrRunning = true;
  $('btn-ocr-start').style.display = 'none';
  $('btn-ocr-stop').style.display = 'inline-flex';
  setOcrStatus(`Starting… ${target.length} images to read`);

  await chrome.runtime.sendMessage({ action: 'startOcr', tabId, items: target }).catch(() => {});
}

async function onOcrStop() {
  await chrome.runtime.sendMessage({ action: 'stopOcr', tabId }).catch(() => {});
  endOcr();
  setOcrStatus(`Stopped — ${countOcr()} images read`, '');
}

function endOcr() {
  ocrRunning = false;
  $('btn-ocr-stop').style.display = 'none';
  $('btn-ocr-start').style.display = 'inline-flex';
}

function applyOcrResult(key, fields) {
  const row = exportRows.find(r => r['URL'] === key);
  if (!row || !fields) return;
  row['Image Text'] = fields.ImageText || '';
  row['Content Type'] = fields.ContentType || '';
  row['Image Language'] = fields.Language || '';
}

function countOcr() {
  return exportRows.filter(r => r['Content Type']).length;
}

function setOcrStatus(msg, cls = '') {
  const el = $('ocr-status');
  el.textContent = msg;
  el.className = 'crawl-status' + (cls ? ' ' + cls : '');
}

// ── Cost per view → Expected Investment column ───────────────────────────
function recomputeInvestment() {
  const cpv = parseFloat($('input-cpv').value);
  const has = Number.isFinite(cpv) && cpv > 0;

  if (has) {
    if (!exportHeaders.length && currentData.headers.length) exportHeaders = [...currentData.headers];
    if (!exportHeaders.includes('Expected Investment')) {
      exportHeaders = insertAfter(exportHeaders, 'Views (number)', 'Expected Investment');
    }
    exportRows.forEach(r => {
      const views = Number(r['Views (number)']) || toNum(r['Views']) || 0;
      r['Expected Investment'] = views ? +(cpv * views).toFixed(2) : '';
    });
  } else {
    // CPV cleared → drop the column and its values
    exportHeaders = exportHeaders.filter(h => h !== 'Expected Investment');
    exportRows.forEach(r => { delete r['Expected Investment']; });
  }
  refreshPreview();
}

function insertAfter(arr, after, item) {
  const i = arr.indexOf(after);
  if (i < 0) return [...arr, item];
  return [...arr.slice(0, i + 1), item, ...arr.slice(i + 1)];
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
  // Full caption from the post's own page beats the grid's alt-text fragment
  if (fields.Caption && fields.Caption.length > (row['Caption'] || '').length) row['Caption'] = fields.Caption;
  if (fields.Duration && !row['Duration']) { row['Duration'] = fields.Duration; if (fields.DurationSec) row['Duration (sec)'] = fields.DurationSec; }
  if (fields.Date)     row['Date'] = fields.Date;
  if (fields.Likes)    { row['Likes'] = fields.Likes; row['Likes (number)'] = toNum(fields.Likes); }
  if (fields.Comments) { row['Comments'] = fields.Comments; row['Comments (number)'] = toNum(fields.Comments); }
  if (fields.Shares)   { row['Shares'] = fields.Shares; row['Shares (number)'] = toNum(fields.Shares); }
  // Deep scrape also confirms the view count from the post page (fills gaps)
  if (fields.Views && !row['Views (number)']) { row['Views'] = fields.Views; row['Views (number)'] = toNum(fields.Views); }
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
      refreshPreview();
      updateCandidateLabel(res.currentIndex + 1, res.count);
      updateExportButtons();
      recomputeInvestment();
      setStatus('');
    }
  } catch (_) {}
}

async function onStartCrawl() {
  if (crawling) return;

  const maxScrolls = parseInt($('input-scrolls').value) || 20;

  crawling = true;
  exportRows = [...currentData.rows];
  exportHeaders = currentData.headers;

  $('btn-start-crawl').style.display = 'none';
  $('btn-stop-crawl').style.display = 'inline-flex';
  updateExportButtons();

  setStatus(`Scrolling… ${exportRows.length} rows loaded`);
  await chrome.tabs.sendMessage(tabId, {
    action: 'startInfiniteScroll',
    tabId,
    maxScrolls
  }).catch(() => {});
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
    if (msg.type === 'crawlProgress') {
      exportRows = msg.allRows || exportRows;
      if (!exportHeaders.length && currentData.headers.length) exportHeaders = currentData.headers;
      setStatus(`Scroll ${msg.page}… ${exportRows.length} rows collected`);
      updateExportButtons();
      $('badge-rows').textContent = exportRows.length;
      recomputeInvestment();
    }

    if (msg.type === 'crawlComplete') {
      exportRows = msg.allRows || exportRows;
      endCrawl();
      setStatus(`Complete — ${exportRows.length} rows collected`, 'done');
      updateExportButtons();
      $('badge-rows').textContent = exportRows.length;
      recomputeInvestment();
    }

    if (msg.type === 'deepProgress') {
      applyDeepResult(msg.url, msg.fields);
      const errNote = msg.fields && msg.fields._error ? ` (last: ${msg.fields._error})` : '';
      setDeepStatus(`Deep scraping… ${msg.done}/${msg.total} posts${errNote}`);
      updateExportButtons();
      recomputeInvestment();  // also live-refreshes the preview
    }

    if (msg.type === 'deepComplete') {
      // Apply any results not already applied
      if (msg.results) Object.keys(msg.results).forEach(u => applyDeepResult(u, msg.results[u]));
      endDeep();
      setDeepStatus(`✓ Done — ${msg.count} posts opened, ${countEnriched()} enriched`, 'done');
      updateExportButtons();
      recomputeInvestment();  // also refreshes the preview
    }

    if (msg.type === 'ocrProgress') {
      applyOcrResult(msg.key, msg.fields);
      const errNote = msg.fields && msg.fields._err ? ` (last: ${msg.fields._err})` : '';
      setOcrStatus(`Reading images… ${msg.done}/${msg.total}${errNote}`);
      refreshPreview();
    }

    if (msg.type === 'ocrComplete') {
      endOcr();
      setOcrStatus(`✓ Done — ${countOcr()} images read`, 'done');
      refreshPreview();
    }
  });
}

// ── Export buttons ────────────────────────────────────────────────────────
function updateExportButtons() {
  const has = exportRows.length > 0;
  $('btn-csv').disabled = !has;
  $('btn-xlsx').disabled = !has;
}

// ── CSV download (ranked "Top Performers" view) ───────────────────────────
function downloadCSV() {
  if (!exportRows.length) return;
  const { headers, rows } = buildRanked(currentHeaders(), exportRows);

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

// ── Excel (SpreadsheetML) download — two tabs ─────────────────────────────
//   Tab 1 "Raw Data"        : exactly as scraped
//   Tab 2 "Top Performers"  : ranked (Rank column, sorted by performance)
function downloadXLSX() {
  if (!exportRows.length) return;

  const x = v => String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const isNum = v => v !== '' && v !== null && v !== undefined && !isNaN(Number(v));

  function worksheet(name, headers, rows) {
    let s = ` <Worksheet ss:Name="${x(name)}">\n  <Table>\n`;
    s += '   <Row>\n';
    headers.forEach(h => { s += `    <Cell ss:StyleID="h"><Data ss:Type="String">${x(h)}</Data></Cell>\n`; });
    s += '   </Row>\n';
    rows.forEach((row, i) => {
      const style = i % 2 === 1 ? ' ss:StyleID="e"' : '';
      s += '   <Row>\n';
      headers.forEach(h => {
        const v = row[h] ?? '';
        const type = isNum(v) ? 'Number' : 'String';
        s += `    <Cell${style}><Data ss:Type="${type}">${x(v)}</Data></Cell>\n`;
      });
      s += '   </Row>\n';
    });
    s += '  </Table>\n </Worksheet>\n';
    return s;
  }

  const rawHeaders = currentHeaders();
  const ranked = buildRanked(rawHeaders, exportRows);

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
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
${worksheet('Top Performers', ranked.headers, ranked.rows)}${worksheet('Raw Data', rawHeaders, exportRows)}</Workbook>`;

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
