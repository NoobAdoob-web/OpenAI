'use strict';

// ── State ──────────────────────────────────────────────────────────────────
let tabId = null;
let currentData = { headers: [], rows: [] }; // current-page detection
let exportRows = [];                          // rows to export (grows during crawl)
let exportHeaders = [];
let crawling = false;
let endpointMeta = { key: '', loading: false, done: false }; // first/last exact-date fetch
let pageUrl = '';                              // active tab URL (for review crawl)
let reviewCrawling = false;

// ── Bootstrap ──────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  try { $('version-badge').textContent = 'v' + chrome.runtime.getManifest().version; } catch (_) {}

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab.id;
  pageUrl = tab.url || '';

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
      maybeFetchEndpoints();
      toggleReviewSection();
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
  const h = Number(row['Helpful (number)']); if (h) return h;   // reviews: most-helpful first
  const l = Number(row['Likes (number)']); if (l) return l;
  const c = Number(row['Comments (number)']); if (c) return c;
  const rt = Number(row['Rating (number)']); if (rt) return rt;  // reviews with no helpful votes → by rating
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

// Move columns that have at least one value to the front, and fully-blank
// columns (not available for this platform/output, e.g. Shares on Instagram)
// to the end — keeping each group's original order.
function orderByPopulated(headers, rows) {
  const isBlank = h => rows.every(r => {
    const v = r[h];
    return v === undefined || v === null || String(v).trim() === '';
  });
  const filled = [], empty = [];
  headers.forEach(h => (isBlank(h) ? empty : filled).push(h));
  return [...filled, ...empty];
}

// ── Analysis (works on basic-scrape data: views + dates) ──────────────────
// Parse the many date formats we collect into a real Date (or null):
//   ISO "2024-03-15", "2024-03-15T..", "January 1, 2024", relative "2 days ago",
//   "2d" / "3w" / "1mo" / "1y" (LinkedIn/YouTube short + long forms).
function parseDateLoose(s) {
  if (!s) return null;
  s = String(s).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  if (/[A-Za-z]+\s+\d{1,2},\s*\d{4}/.test(s)) { const d = Date.parse(s); if (!isNaN(d)) return new Date(d); }
  // relative — longest unit tokens first so "mo" beats "m"
  m = s.toLowerCase().match(/(\d+)\s*(seconds?|sec|minutes?|min|hours?|hr|days?|weeks?|months?|mo|years?|yr|[smhdwy])\b/);
  if (m) {
    const n = +m[1], u = m[2];
    const MS = {
      s: 1e3, sec: 1e3, second: 1e3, seconds: 1e3,
      m: 6e4, min: 6e4, minute: 6e4, minutes: 6e4,
      h: 36e5, hr: 36e5, hour: 36e5, hours: 36e5,
      d: 864e5, day: 864e5, days: 864e5,
      w: 6048e5, week: 6048e5, weeks: 6048e5,
      mo: 2629746e3, month: 2629746e3, months: 2629746e3,
      y: 31556952e3, yr: 31556952e3, year: 31556952e3, years: 31556952e3,
    };
    const ms = MS[u]; if (ms) return new Date(Date.now() - n * ms);
  }
  return null;
}

function fmtDate(d) {
  if (!d || isNaN(d)) return '';
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function median(nums) {
  if (!nums.length) return 0;
  const a = [...nums].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : Math.round((a[mid - 1] + a[mid]) / 2);
}

function computeAnalysis(rows) {
  const views = rows.map(r => Number(r['Views (number)'])).filter(v => v > 0);
  const dates = rows.map(r => parseDateLoose(r['Date'])).filter(Boolean);
  dates.sort((a, b) => a - b);
  const earliest = dates[0] || null, latest = dates[dates.length - 1] || null;
  const spanDays = earliest && latest ? Math.max(1, Math.round((latest - earliest) / 864e5)) : 0;

  const total = views.reduce((s, v) => s + v, 0);
  const durSecs = rows.map(r => Number(r['Duration (sec)'])).filter(v => v > 0);

  // Best post = highest views
  let best = null, bestV = -1;
  rows.forEach(r => { const v = Number(r['Views (number)']) || 0; if (v > bestV) { bestV = v; best = r; } });

  return {
    count: rows.length,
    withViews: views.length,
    earliest: fmtDate(earliest),
    latest: fmtDate(latest),
    spanDays,
    totalViews: total,
    avgViews: views.length ? Math.round(total / views.length) : 0,
    medianViews: median(views),
    postsPerWeek: spanDays ? +(rows.length / (spanDays / 7)).toFixed(1) : 0,
    avgDurationSec: durSecs.length ? Math.round(durSecs.reduce((s, v) => s + v, 0) / durSecs.length) : 0,
    topCaption: (best && (best['Caption'] || best['URL'])) || '',
    topViews: bestV > 0 ? bestV : 0,
    // Endpoint posts by scraped order (first = most recent, last = oldest loaded)
    firstPostDate: fmtDate(parseDateLoose(rows[0] && rows[0]['Date'])) || (rows[0] && rows[0]['Date']) || '',
    lastPostDate: fmtDate(parseDateLoose(rows[rows.length - 1] && rows[rows.length - 1]['Date'])) || (rows[rows.length - 1] && rows[rows.length - 1]['Date']) || '',
  };
}

function numFmt(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'K';
  return String(n);
}

function secFmt(sec) {
  sec = Math.round(sec) || 0; if (sec <= 0) return '—';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const p = n => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}

// Text insight pointers from whatever metrics are present (views/likes/etc).
// ── Insight engine ────────────────────────────────────────────────────────
// Cross-analyses captions/content against engagement (views/likes/comments/
// shares) and surfaces PATTERNS, e.g. "Posts that mention an offer get 2.1x
// more comments". Works on views alone (basic scrape); likes/comments/shares
// comparisons unlock once those columns are present (deep scrape / LinkedIn).
const STOPWORDS = new Set(('the a an and or of to in on for with your you our we is are was be by ' +
  'this that these those it its at as from up out so no not do does can will just get got now new all ' +
  'more most very how why what when who your youre they them their there here have has had he she his her ' +
  'i im me my we us also then than into over under about after before best good great today day').split(' '));

function buildInsights(rows) {
  const out = [];
  const num = (r, k) => Number(r[k]) || 0;
  const capText = r => String(r['Caption'] || '').replace(/\s+/g, ' ').trim();
  const short = r => { const c = capText(r) || String(r['URL'] || ''); return c ? (c.length > 46 ? c.slice(0, 46) + '…' : c) : '(no caption)'; };
  const avg = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
  const N = rows.length;

  // ── Headline highlights (always) ──
  const maxBy = key => rows.reduce((b, r) => (num(r, key) > num(b, key) ? r : b), rows[0]);
  if (rows.some(r => num(r, 'Views (number)') > 0)) {
    const r = maxBy('Views (number)');
    out.push(`Most viewed: “${short(r)}” — ${numFmt(num(r, 'Views (number)'))} views`);
  }
  if (rows.some(r => num(r, 'Likes (number)') > 0)) {
    const r = maxBy('Likes (number)');
    out.push(`Most liked: “${short(r)}” — ${numFmt(num(r, 'Likes (number)'))} likes`);
  }
  if (rows.some(r => num(r, 'Comments (number)') > 0)) {
    const r = maxBy('Comments (number)');
    out.push(`Most comments: “${short(r)}” — ${numFmt(num(r, 'Comments (number)'))}`);
  }

  // ── Pattern analysis (needs a handful of posts to be meaningful) ──
  if (N < 6) {
    out.push('Scrape/scroll more posts (6+) to unlock content-pattern insights.');
    return out;
  }

  const METRICS = [['views', 'Views (number)'], ['comments', 'Comments (number)'],
                   ['likes', 'Likes (number)'], ['shares', 'Shares (number)']];

  // Compare a group (predicate true) vs the rest; return a candidate insight
  // for EACH metric that differs meaningfully (so both "more views" and "fewer
  // comments" style stories can surface for the same group).
  function compareGroup(pred, label) {
    const inG = rows.filter(pred), rest = rows.filter(r => !pred(r));
    if (inG.length < 3 || rest.length < 2) return [];
    const cands = [];
    for (const [name, key] of METRICS) {
      const gv = inG.map(r => num(r, key)).filter(v => v > 0);
      const rv = rest.map(r => num(r, key)).filter(v => v > 0);
      if (gv.length < 3 || rv.length < 3) continue;
      const ga = avg(gv), ra = avg(rv);
      if (!ga || !ra) continue;
      const ratio = ga / ra, strength = Math.abs(Math.log(ratio));
      if (ratio >= 1.35 || ratio <= 0.74) {
        const cmp = ratio >= 1 ? `${ratio.toFixed(1)}× more` : `${(1 / ratio).toFixed(1)}× fewer`;
        cands.push({ label, strength,
          text: `Posts that ${label} get ${cmp} ${name} (avg ${numFmt(Math.round(ga))} vs ${numFmt(Math.round(ra))}).` });
      }
    }
    return cands;
  }

  const dims = [];
  const has = re => r => re.test(capText(r));
  dims.push([has(/\b(sale|off|discount|offer|deal|deals|free|save|flat|cashback|coupon|promo|% ?off|lowest price|price drop|₹|\brs\.?\b)\b/i), 'mention an offer/discount']);
  dims.push([has(/\b(diwali|holi|eid|christmas|new year|navratri|dussehra|rakhi|onam|pongal|festival|festive|wishes|greetings|happy|shubh)\b/i), 'have a festive/greeting theme']);
  dims.push([has(/\?/), 'ask a question']);
  dims.push([r => ((capText(r).match(/#/g) || []).length >= 4), 'use 4+ hashtags']);
  dims.push([r => capText(r).length >= 150, 'have longer captions (150+ chars)']);
  dims.push([r => capText(r).length > 0 && capText(r).length <= 40, 'have short captions (≤40 chars)']);
  dims.push([has(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u), 'use emojis']);
  dims.push([has(/@\w/), 'tag/mention an account']);
  dims.push([has(/\b(link in bio|shop now|buy now|click|dm|comment below|tag a|share this|follow us|swipe|watch till)\b/i), 'include a call-to-action']);
  dims.push([r => num(r, 'Duration (sec)') > 0 && num(r, 'Duration (sec)') <= 15, 'are short videos (≤15s)']);
  dims.push([r => num(r, 'Duration (sec)') >= 60, 'are longer videos (60s+)']);
  // OCR content type (only if OCR was run)
  ['Offer-led', 'Product-led', 'Festive'].forEach(ct => {
    if (rows.some(r => r['Content Type'] === ct)) dims.push([r => r['Content Type'] === ct, `have ${ct} creatives (image text)`]);
  });
  // Most common keyword across captions (surfaces brand/product/theme names)
  const kw = topKeyword(rows);
  if (kw) {
    const kwRe = new RegExp('\\b' + kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
    dims.push([r => kwRe.test(capText(r)), `mention “${kw}”`]);
  }

  const found = [];
  for (const [pred, label] of dims) found.push(...compareGroup(pred, label));
  found.sort((a, b) => b.strength - a.strength);

  // Add strongest-first, but at most 2 insights per group (label) so variety
  // stays high and one dimension can't dominate.
  const perLabel = {};
  const seen = new Set();
  for (const f of found) {
    if (out.length >= 8) break;
    if (seen.has(f.text)) continue;
    perLabel[f.label] = (perLabel[f.label] || 0);
    if (perLabel[f.label] >= 2) continue;
    perLabel[f.label]++;
    seen.add(f.text);
    out.push(f.text);
  }

  if (found.length === 0) out.push('No strong content patterns yet — try scraping more posts (and Deep Scrape for likes/comments).');
  return out;
}

// Most frequent non-stopword appearing across captions (document frequency),
// used to surface a brand/product/theme keyword to correlate against metrics.
function topKeyword(rows) {
  const df = new Map();
  rows.forEach(r => {
    const text = String(r['Caption'] || '').toLowerCase()
      .replace(/https?:\/\/\S+/g, ' ').replace(/[#@][\w.]+/g, ' ');
    const words = new Set((text.match(/[a-z][a-z'&-]{2,}/g) || []));
    words.forEach(w => { if (!STOPWORDS.has(w) && w.length >= 3) df.set(w, (df.get(w) || 0) + 1); });
  });
  const N = rows.length;
  let best = null;
  df.forEach((c, w) => { if (c >= 3 && c <= N - 2 && (!best || c > best.c)) best = { w, c }; });
  return best ? best.w : '';
}

function isReviewData() {
  const h = currentHeaders();
  return h.includes('Rating (number)') && h.includes('Reviewer');
}

function renderAnalysis() {
  const box = $('analysis-box');
  const ins = $('analysis-insights');
  if (!exportRows.length) { box.style.display = 'none'; ins.style.display = 'none'; return; }
  if (isReviewData()) { renderReviewAnalysis(box, ins); return; }
  const a = computeAnalysis(exportRows);
  const range = a.earliest && a.latest
    ? (a.earliest === a.latest ? a.earliest : `${a.earliest} → ${a.latest}`)
    : 'n/a';
  const item = (label, val, wide) =>
    `<div class="an-item${wide ? ' an-wide' : ''}"><span class="an-label">${label}</span><span class="an-val" title="${String(val).replace(/"/g, '')}">${val}</span></div>`;

  box.innerHTML =
    item('Posts', a.count) +
    item('Date range', range, true) +
    (a.firstPostDate ? item('First post', a.firstPostDate) : '') +
    (a.lastPostDate ? item('Last post', a.lastPostDate) : '') +
    (a.spanDays ? item('Span', `${a.spanDays} days`) : '') +
    (a.postsPerWeek ? item('Posts / week', a.postsPerWeek) : '') +
    (a.withViews ? item('Avg views', numFmt(a.avgViews)) : '') +
    (a.withViews ? item('Median views', numFmt(a.medianViews)) : '') +
    (a.withViews ? item('Total views', numFmt(a.totalViews)) : '') +
    (a.avgDurationSec ? item('Avg duration', secFmt(a.avgDurationSec)) : '');
  box.style.display = 'grid';

  const pointers = buildInsights(exportRows);
  if (pointers.length) {
    ins.innerHTML = '<div class="in-title">Content Insights</div><ul>' +
      pointers.map(p => `<li>${p.replace(/</g, '&lt;')}</li>`).join('') + '</ul>';
    ins.style.display = 'block';
  } else {
    ins.style.display = 'none';
  }
}

// Review-specific analysis: rating breakdown, avg rating, % verified, most helpful.
function renderReviewAnalysis(box, ins) {
  const rows = exportRows;
  const ratings = rows.map(r => Number(r['Rating (number)'])).filter(v => v > 0);
  const avg = ratings.length ? (ratings.reduce((s, v) => s + v, 0) / ratings.length) : 0;
  const verified = rows.filter(r => /^y/i.test(String(r['Verified'] || ''))).length;
  const dist = [5, 4, 3, 2, 1].map(star => ratings.filter(v => Math.round(v) === star).length);
  const helpfulTop = rows.reduce((b, r) => (Number(r['Helpful (number)']) > Number((b || {})['Helpful (number)'] || -1) ? r : b), null);
  const item = (label, val, wide) =>
    `<div class="an-item${wide ? ' an-wide' : ''}"><span class="an-label">${label}</span><span class="an-val" title="${String(val).replace(/"/g, '')}">${val}</span></div>`;

  box.innerHTML =
    item('Reviews', rows.length) +
    (avg ? item('Avg rating', `${avg.toFixed(2)} / 5`) : '') +
    (rows.length ? item('Verified', `${Math.round(100 * verified / rows.length)}%`) : '') +
    item('5★ / 4★ / 3★', `${dist[0]} / ${dist[1]} / ${dist[2]}`, true) +
    item('2★ / 1★', `${dist[3]} / ${dist[4]}`, true);
  box.style.display = 'grid';

  const pointers = [];
  if (avg) pointers.push(`Average rating: ${avg.toFixed(2)}/5 across ${ratings.length} reviews.`);
  const pos = ratings.filter(v => v >= 4).length, neg = ratings.filter(v => v <= 2).length;
  if (ratings.length) pointers.push(`${Math.round(100 * pos / ratings.length)}% positive (4–5★) · ${Math.round(100 * neg / ratings.length)}% negative (1–2★).`);
  if (helpfulTop && Number(helpfulTop['Helpful (number)']) > 0) {
    const t = (helpfulTop['Title'] || helpfulTop['Review'] || '').slice(0, 60);
    pointers.push(`Most helpful review (${helpfulTop['Helpful (number)']} votes): “${t}…” — ${helpfulTop['Rating (number)']}★`);
  }
  if (pointers.length) {
    ins.innerHTML = '<div class="in-title">Review Insights</div><ul>' +
      pointers.map(p => `<li>${p.replace(/</g, '&lt;')}</li>`).join('') + '</ul>';
    ins.style.display = 'block';
  } else { ins.style.display = 'none'; }
}

function setAnalysisNote(msg, cls) {
  const el = $('analysis-note');
  if (!msg) { el.style.display = 'none'; return; }
  el.textContent = msg;
  el.className = 'analysis-note' + (cls ? ' ' + cls : '');
  el.style.display = 'block';
}

// Fetch exact posting dates (+ duration) for the FIRST and LAST post so the
// date range is accurate. Runs once per dataset; warns the user it may be slow.
function maybeFetchEndpoints() {
  if (isReviewData()) return;   // reviews don't have per-post pages to open
  const urls = exportRows.map(r => r['URL']).filter(u => u && /^https?:/.test(u));
  if (urls.length < 1) return;
  const firstU = urls[0], lastU = urls[urls.length - 1];
  const key = firstU + '|' + lastU;
  if (key === endpointMeta.key) return;                 // already done for this dataset
  endpointMeta = { key, loading: true, done: false };
  setAnalysisNote('Opening the first & last post in the background to read their exact dates — this can take 10–20 seconds. Please wait…', 'loading');

  const targets = firstU === lastU ? [firstU] : [firstU, lastU];
  chrome.runtime.sendMessage({ action: 'getPostMeta', urls: targets }).then(resp => {
    endpointMeta.loading = false; endpointMeta.done = true;
    let got = false;
    if (resp && resp.ok && resp.meta) {
      got = applyMeta(firstU, resp.meta[firstU]) | applyMeta(lastU, resp.meta[lastU]);
    }
    setAnalysisNote(got ? '' : 'Couldn’t fetch exact dates — showing dates from the grid instead.', '');
    renderAnalysis();
  }).catch(() => {
    endpointMeta.loading = false;
    setAnalysisNote('Couldn’t fetch exact dates — showing dates from the grid instead.', '');
  });
}

function applyMeta(url, meta) {
  if (!meta) return 0;
  const row = exportRows.find(r => r['URL'] === url);
  if (!row) return 0;
  let changed = 0;
  if (meta.date) { row['Date'] = meta.date; changed = 1; }
  if (meta.durationSec && !row['Duration (sec)']) {
    row['Duration (sec)'] = String(meta.durationSec);
    row['Duration'] = secFmt(meta.durationSec);
    changed = 1;
  }
  return changed;
}

// Render the preview as the ranked (Top Performers) view.
function refreshPreview() {
  if (!exportRows.length) return;
  renderPreview(buildRanked(orderByPopulated(currentHeaders(), exportRows), exportRows));
  renderAnalysis();
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
  $('btn-review-start').addEventListener('click', onReviewStart);
  $('btn-review-stop').addEventListener('click', onReviewStop);
}

// ── Review collection by star (Amazon) ────────────────────────────────────
// Derive the product-reviews base URL from the active tab's Amazon URL.
function amazonReviewBase() {
  if (!/amazon\./i.test(pageUrl)) return '';
  const asin = pageUrl.match(/\/(?:dp|gp\/product|product-reviews|gp\/aw\/d|gp\/aw\/reviews)\/([A-Z0-9]{10})/i);
  if (!asin) return '';
  let host = 'www.amazon.com';
  try { host = new URL(pageUrl).host; } catch (_) {}
  return `https://${host}/product-reviews/${asin[1]}/`;
}

function toggleReviewSection() {
  const show = isReviewData() && !!amazonReviewBase();
  $('review-section').style.display = show ? '' : 'none';
  // The infinite-scroll "Load more posts" box isn't useful on review pages
  $('scrape-section').style.display = isReviewData() ? 'none' : '';
}

async function onReviewStart() {
  if (reviewCrawling) return;
  const base = amazonReviewBase();
  if (!base) { setReviewStatus('Open an Amazon product/reviews page first.', 'error'); return; }

  const targets = {
    five_star: parseInt($('rev-5').value) || 0,
    four_star: parseInt($('rev-4').value) || 0,
    three_star: parseInt($('rev-3').value) || 0,
    two_star: parseInt($('rev-2').value) || 0,
    one_star: parseInt($('rev-1').value) || 0,
  };
  const total = Object.values(targets).reduce((s, v) => s + v, 0);
  if (total === 0) { setReviewStatus('Set at least one star target (0 = skip).', 'error'); return; }

  const maxPagesPerStar = parseInt($('rev-maxpages').value) || 20;
  reviewCrawling = true;
  $('btn-review-start').style.display = 'none';
  $('btn-review-stop').style.display = 'inline-flex';
  setReviewStatus(`Starting… collecting up to ${total} reviews`);

  await chrome.runtime.sendMessage({ action: 'startReviewCrawl', tabId, base, targets, maxPagesPerStar, delayMs: 1500 }).catch(() => {});
}

async function onReviewStop() {
  await chrome.runtime.sendMessage({ action: 'stopReviewCrawl', tabId }).catch(() => {});
  endReviewCrawl();
  setReviewStatus(`Stopped — ${exportRows.length} reviews collected`);
}

function endReviewCrawl() {
  reviewCrawling = false;
  $('btn-review-stop').style.display = 'none';
  $('btn-review-start').style.display = 'inline-flex';
}

function setReviewStatus(msg, cls = '') {
  const el = $('review-status');
  el.textContent = msg;
  el.className = 'crawl-status' + (cls ? ' ' + cls : '');
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
      maybeFetchEndpoints();
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

    if (msg.type === 'reviewProgress') {
      setReviewStatus(`Collecting ${msg.star}★ — ${msg.got}/${msg.target} (total ${msg.total}, page ${msg.page})`);
    }

    if (msg.type === 'reviewComplete') {
      endReviewCrawl();
      if (msg.rows && msg.rows.length) {
        exportRows = msg.rows;
        exportHeaders = currentData.headers.length ? currentData.headers : Object.keys(msg.rows[0]);
      }
      setReviewStatus(`✓ Done — ${exportRows.length} reviews collected`, 'done');
      updateExportButtons();
      $('badge-rows').textContent = exportRows.length;
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
  const { headers, rows } = buildRanked(orderByPopulated(currentHeaders(), exportRows), exportRows);

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

  function worksheet(name, headers, rows, summaryPairs) {
    let s = ` <Worksheet ss:Name="${x(name)}">\n  <Table>\n`;
    // Optional analysis block at the very top (Top Performers tab)
    if (summaryPairs && summaryPairs.length) {
      s += `   <Row><Cell ss:StyleID="t"><Data ss:Type="String">ANALYSIS</Data></Cell></Row>\n`;
      summaryPairs.forEach(([label, val]) => {
        s += '   <Row>\n';
        s += `    <Cell ss:StyleID="s"><Data ss:Type="String">${x(label)}</Data></Cell>\n`;
        const type = isNum(val) ? 'Number' : 'String';
        s += `    <Cell><Data ss:Type="${type}">${x(val)}</Data></Cell>\n`;
        s += '   </Row>\n';
      });
      s += '   <Row></Row>\n'; // blank spacer before the table
    }
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

  const rawHeaders = orderByPopulated(currentHeaders(), exportRows);
  const ranked = buildRanked(rawHeaders, exportRows);

  // Analysis block for the Top Performers tab
  const a = computeAnalysis(exportRows);
  const summaryPairs = [
    ['Posts', a.count],
    ['Date range', (a.earliest && a.latest) ? (a.earliest === a.latest ? a.earliest : `${a.earliest} to ${a.latest}`) : 'n/a'],
  ];
  if (a.firstPostDate) summaryPairs.push(['Date of first post', a.firstPostDate]);
  if (a.lastPostDate) summaryPairs.push(['Date of last post', a.lastPostDate]);
  if (a.spanDays) summaryPairs.push(['Span (days)', a.spanDays]);
  if (a.postsPerWeek) summaryPairs.push(['Posts per week', a.postsPerWeek]);
  if (a.withViews) {
    summaryPairs.push(['Total views', a.totalViews]);
    summaryPairs.push(['Average views', a.avgViews]);
    summaryPairs.push(['Median views', a.medianViews]);
  }
  if (a.avgDurationSec) summaryPairs.push(['Average duration', secFmt(a.avgDurationSec)]);
  // Text insight pointers
  buildInsights(exportRows).forEach((p, i) => summaryPairs.push([i === 0 ? 'Insights' : '', p.slice(0, 220)]));

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
  <Style ss:ID="t">
   <Font ss:Bold="1" ss:Size="12" ss:Color="#137333"/>
  </Style>
  <Style ss:ID="s">
   <Font ss:Bold="1" ss:Color="#33691E"/>
  </Style>
 </Styles>
${worksheet('Top Performers', ranked.headers, ranked.rows, summaryPairs)}${worksheet('Raw Data', rawHeaders, exportRows)}</Workbook>`;

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
