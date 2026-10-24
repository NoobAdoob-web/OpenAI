/* Self-contained HTML insights report for an ad-library run.
 *
 * Output constraints, matched to the reference report and to MV3:
 *   - no <script> anywhere, so the file is inert wherever it is opened
 *   - one <style>, inline SVG icons, images as data URIs
 *   - no external fetches, so it renders offline and inside the extension
 * Charts are CSS bar rows; nothing is bundled and nothing is evaluated.
 */

const RPT_ESC = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const ICONS = {
  users: '<circle cx="7.2" cy="8" r="2.6"/><path d="M2.5 17c0-2.8 2.1-4.4 4.7-4.4s4.7 1.6 4.7 4.4"/><circle cx="15.2" cy="8.4" r="2.1"/><path d="M13.6 12.7c1.9.2 3.6 1.6 3.6 4.3"/>',
  video: '<rect x="2.3" y="4.5" width="11.4" height="11" rx="2.2"/><path d="m13.7 8.7 4-2.4v7.4l-4-2.4"/>',
  layers: '<path d="M10 2.5 2.5 6.7 10 10.9l7.5-4.2Z"/><path d="m2.5 10.3 7.5 4.2 7.5-4.2M2.5 13.9l7.5 4.2 7.5-4.2"/>',
  tag: '<path d="M3 3h6.2L17 10.8 10.8 17 3 9.2V3Z"/><circle cx="6.6" cy="6.6" r="1.1"/>',
  globe: '<circle cx="10" cy="10" r="7.5"/><path d="M2.5 10h15M10 2.5c2 2.2 3 4.8 3 7.5s-1 5.3-3 7.5c-2-2.2-3-4.8-3-7.5s1-5.3 3-7.5Z"/>',
  cursor: '<path d="m4 3 12 5.5-5 1.7L8.8 16 4 3Z"/>',
  spark: '<path d="M10 2.5 11.8 8l5.7 2-5.7 2-1.8 5.5L8.2 12 2.5 10l5.7-2Z"/>',
  calendar: '<rect x="2.8" y="4.2" width="14.4" height="13" rx="2"/><path d="M2.8 8.2h14.4M6.5 2.5v3.4M13.5 2.5v3.4"/>',
  grid: '<rect x="2.6" y="2.6" width="6" height="6" rx="1.4"/><rect x="11.4" y="2.6" width="6" height="6" rx="1.4"/><rect x="2.6" y="11.4" width="6" height="6" rx="1.4"/><rect x="11.4" y="11.4" width="6" height="6" rx="1.4"/>',
};

const icon = name => `<svg class="ai-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" ` +
  `stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ICONS.grid}</svg>`;

function statCard(label, value, tone) {
  return `<div class="ai-stat"><div class="ai-stat-label">${RPT_ESC(label)}</div>` +
    `<div class="ai-stat-value ${tone || ''}">${RPT_ESC(value)}</div></div>`;
}

/* A bar-chart card. Bars are scaled to the largest value, not to the total,
 * so a long tail stays readable. */
function barSection(title, iconName, entries, limit) {
  const list = (entries || []).slice(0, limit || 8);
  if (!list.length) return '';
  const max = Math.max(...list.map(e => e[1]), 1);
  const rows = list.map(([label, n]) =>
    `<div class="ai-bar-row"><div class="ai-bar-label"><span>${RPT_ESC(label)}</span><b>${n}</b></div>` +
    `<div class="ai-bar-track"><div class="ai-bar-fill" style="width:${(n / max * 100).toFixed(2)}%"></div></div></div>`
  ).join('');
  return `<div class="ai-section"><div class="ai-section-head">${icon(iconName)}<h2>${RPT_ESC(title)}</h2></div>` +
    `<div class="ai-card">${rows}</div></div>`;
}

function galleryCard(row, dataUri) {
  const tags = [row.Status, row['Asset type'], row['Type of creative'], row['Creative Language']]
    .filter(Boolean)
    .map(t => `<span class="ai-tag${t === row['Type of creative'] ? ' category' : ''}">${RPT_ESC(t)}</span>`)
    .join('');
  const signal = row['Campaign Signals']
    ? `<div class="ai-tag-row"><span class="ai-tag category">${RPT_ESC(row['Campaign Signals'])}</span></div>` : '';
  const offers = row['Offer Signals']
    ? `<div class="ai-tag-row">${String(row['Offer Signals']).split(',').map(s => s.trim()).filter(Boolean)
        .map(s => `<span class="ai-tag offer">${RPT_ESC(s)}</span>`).join('')}</div>` : '';
  const dur = row['Creative Duration']
    ? `<div class="ai-gvideo">${icon('video')} ${RPT_ESC(row['Creative Duration'])}</div>` : '';
  const img = dataUri
    ? `<img src="${dataUri}" loading="lazy" alt="">`
    : `<div class="ai-gnoimg">no screenshot</div>`;
  const link = row.__links && row.__links['Ad Preview Link'];
  const copy = row.Description || row['Image Text'] || '';
  return `<div class="ai-gcard">${img}<div class="ai-gmeta">` +
    `<div class="ai-gname">${RPT_ESC(row.Brand || '')}</div>` +
    `<div class="ai-tag-row">${tags}</div>${signal}${offers}` +
    `<div class="ai-gdate">${RPT_ESC(row.Date || '')}</div>` +
    `<div class="ai-gcopy">${RPT_ESC(copy)}</div>` +
    `<div class="ai-gdomain">${RPT_ESC(row['Landing Page'] || '')}</div>${dur}` +
    (link ? `<a class="ai-glink" href="${RPT_ESC(link)}" target="_blank" rel="noopener noreferrer">Open in Ad Library</a>` : '') +
    `</div></div>`;
}

const REPORT_CSS = `
:root{--bg:#0f1115;--panel:#171a21;--card:#1d212a;--line:#272c37;--txt:#e8eaf0;--dim:#949cad;--accent:#6c8cff;--ok:#3ecf8e;--offer:#ffb55c}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--txt);font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.ai-report-header{padding:28px 24px 20px;border-bottom:1px solid var(--line);background:var(--panel)}
.ai-report-header h1{margin:0;font-size:22px;letter-spacing:-.2px}
.ai-report-header p{margin:6px 0 0;color:var(--dim);font-size:13px}
.ai-report-body{padding:20px 24px 48px;max-width:1180px;margin:0 auto}
.ai-stats-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:22px}
.ai-stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.ai-stat-label{color:var(--dim);font-size:12px;text-transform:uppercase;letter-spacing:.06em}
.ai-stat-value{font-size:24px;font-weight:650;margin-top:4px}
.ai-stat-value.ok{color:var(--ok)}
.ai-grid-2{display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:16px}
.ai-section{min-width:0}
.ai-section-head{display:flex;align-items:center;gap:8px;margin:18px 0 10px}
.ai-section-head h2{margin:0;font-size:15px;font-weight:600}
.ai-icon{width:18px;height:18px;color:var(--accent);flex:none}
.ai-card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.ai-bar-row+.ai-bar-row{margin-top:12px}
.ai-bar-label{display:flex;justify-content:space-between;gap:12px;font-size:13px;margin-bottom:5px}
.ai-bar-label span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ai-bar-label b{color:var(--dim);font-weight:600;flex:none}
.ai-bar-track{height:7px;background:#11141a;border-radius:4px;overflow:hidden}
.ai-bar-fill{height:100%;background:linear-gradient(90deg,var(--accent),#9a7bff);border-radius:4px}
.ai-gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:14px}
.ai-gcard{background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden;display:flex;flex-direction:column}
/* Creatives arrive in every shape (square, 4:5, 9:16). Normalise the tile so
   the grid stays even; the full-size screenshot is still in the workbook. */
.ai-gcard img{width:100%;display:block;background:#0b0d11;aspect-ratio:4/5;object-fit:cover;object-position:top}
.ai-gnoimg{padding:34px 0;text-align:center;color:var(--dim);font-size:12px;background:#0b0d11}
.ai-gmeta{padding:12px 13px;display:flex;flex-direction:column;gap:7px}
.ai-gname{font-weight:600}
.ai-tag-row{display:flex;flex-wrap:wrap;gap:5px}
.ai-tag{font-size:11px;padding:2px 7px;border-radius:5px;background:#232834;color:var(--dim);border:1px solid var(--line)}
.ai-tag.category{color:var(--accent);border-color:#2f3a5c}
.ai-tag.offer{color:var(--offer);border-color:#4a3a22}
.ai-gdate{font-size:12px;color:var(--dim)}
.ai-gcopy{font-size:12.5px;line-height:1.45}
.ai-gdomain{font-size:12px;color:var(--accent);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ai-gvideo{display:flex;align-items:center;gap:5px;font-size:12px;color:var(--dim)}
.ai-glink{font-size:12px;color:var(--accent);text-decoration:none}
.ai-glink:hover{text-decoration:underline}
.ai-foot{margin-top:34px;padding-top:16px;border-top:1px solid var(--line);color:var(--dim);font-size:12px}
@media print{body{background:#fff;color:#111}.ai-stat,.ai-card,.ai-gcard{background:#fff;border-color:#ddd}}
`;

/* rows   — the ad rows, already carrying derived columns
 * a      — the result of computeAdsAnalysis(rows)
 * images — optional map of row index → data URI for the screenshot        */
function buildAdsReportHtml(rows, a, images, opts) {
  const o = opts || {};
  const when = o.generatedAt || new Date().toLocaleString();
  const title = o.title || 'ScrapeSuite — Insights Report';
  const imgs = images || {};

  const stats = [
    statCard('Total ads', a.count),
    statCard('Active', a.active, 'ok'),
    statCard('Inactive', a.inactive),
    statCard('Video creatives', a.video),
    statCard('Image creatives', a.image),
    statCard('Date range', a.dateRange),
  ].join('');

  const sections = [
    barSection('Advertisers scraped', 'users', a.brands),
    barSection('Video vs display', 'video', a.assetTypes),
    barSection('Type of creative (product vertical)', 'layers', a.verticals),
    barSection('Campaign signals', 'tag', a.campaigns),
    barSection('Language breakdown', 'globe', a.languages),
    barSection('Top CTAs', 'cursor', a.ctas),
    barSection('Top landing domains', 'globe', a.domains),
    barSection('Offer signals detected', 'spark', a.offers, 10),
    barSection('Posting cadence (by quarter)', 'calendar', a.cadence, 12),
  ].filter(Boolean).join('');

  const gallery = rows.map((r, i) => galleryCard(r, imgs[i])).join('');

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${RPT_ESC(title)}</title><style>${REPORT_CSS}</style></head><body>` +
    `<div class="ai-report-header"><h1>${RPT_ESC(title)}</h1>` +
    `<p>Generated ${RPT_ESC(when)} · ${a.count} ads analysed</p></div>` +
    `<div class="ai-report-body">` +
    `<div class="ai-stats-row">${stats}</div>` +
    `<div class="ai-grid-2">${sections}</div>` +
    `<div class="ai-section"><div class="ai-section-head">${icon('grid')}` +
    `<h2>All creatives (${rows.length})</h2></div><div class="ai-gallery">${gallery}</div></div>` +
    `<div class="ai-foot">Derived columns (type of creative, campaign signals, offer signals, ` +
    `language) are produced on-device from the ad's own text. Where the text gives no clear ` +
    `signal the report says so rather than guessing.</div>` +
    `</div></body></html>`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildAdsReportHtml, barSection, galleryCard, RPT_ESC };
}
