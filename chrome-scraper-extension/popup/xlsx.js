/* OOXML (.xlsx) writer.
 *
 * Split out of popup.js so it can be unit-tested in Node without a DOM — see
 * test_xlsx_writer.js. Loaded before popup.js in popup.html.
 *
 * Two entry points:
 *   buildXlsx(names, sheetXmls)  — the original string-only path, unchanged.
 *   buildWorkbook(sheets)        — adds embedded images, external hyperlinks,
 *                                  column widths and row heights, which the ad
 *                                  library export needs (a screenshot per row,
 *                                  plus the ad-preview and landing-page links).
 */

const _xEsc = v => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');

// Column index (0-based) → spreadsheet letters (0→A, 26→AA)
function colLetter(n) {
  let s = ''; n++;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// A cell: numeric (pure integer/decimal) → <v>, else inline string. styleIdx
// applies a cellXfs style (1=header, 2=title, 3=label, 4=link).
function cellXml(ref, val, styleIdx) {
  const s = styleIdx ? ` s="${styleIdx}"` : '';
  const str = String(val ?? '');
  if (str.trim() !== '' && /^-?\d+(\.\d+)?$/.test(str) && str.length < 16) {
    return `<c r="${ref}"${s}><v>${str}</v></c>`;
  }
  if (str === '') return `<c r="${ref}"${s}/>`;
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${_xEsc(str)}</t></is></c>`;
}

function buildSheetXml(headers, rows, summaryPairs) {
  let body = '', r = 1;
  const row = cells => { body += `<row r="${r}">${cells}</row>`; r++; };
  if (summaryPairs && summaryPairs.length) {
    row(cellXml('A' + r, 'ANALYSIS', 2));
    summaryPairs.forEach(([label, val]) => { row(cellXml('A' + r, label, 3) + cellXml('B' + r, val, 0)); });
    row(''); // blank spacer
  }
  row(headers.map((h, i) => cellXml(colLetter(i) + r, h, 1)).join(''));
  rows.forEach(rowObj => { row(headers.map((h, i) => cellXml(colLetter(i) + r, rowObj[h] ?? '', 0)).join('')); });
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Rich sheets: images, hyperlinks, widths, heights
// ═══════════════════════════════════════════════════════════════════════════

const EMU_PER_PX = 9525;   // OOXML English Metric Units
const PT_PER_PX = 0.75;    // row heights are in points

/* A sheet spec:
 *   { name, headers, rows, summaryPairs?, imageColumn?, colWidths? }
 * Per-row extras live on the row object under keys the exporter never writes
 * as columns:
 *   row.__links  = { 'Ad Preview Link': 'https://…', 'Landing Page': 'https://…' }
 *   row.__image  = { bytes: Uint8Array, ext: 'jpeg'|'png', w, h }
 */
function buildRichSheet(spec, sheetIndex, mediaSink) {
  const headers = spec.headers;
  const imgColIdx = spec.imageColumn ? headers.indexOf(spec.imageColumn) : -1;

  let body = '', r = 1;
  const links = [];   // { ref, target }
  const anchors = []; // { colIdx, rowIdx, w, h, rel }

  const emit = (cells, attrs) => { body += `<row r="${r}"${attrs || ''}>${cells}</row>`; r++; };

  if (spec.summaryPairs && spec.summaryPairs.length) {
    emit(cellXml('A' + r, spec.title || 'ANALYSIS', 2));
    spec.summaryPairs.forEach(([label, val]) => {
      emit(cellXml('A' + r, label, 3) + cellXml('B' + r, val, 0));
    });
    emit('');
  }

  if (headers.length) emit(headers.map((h, i) => cellXml(colLetter(i) + r, h, 1)).join(''));

  (spec.rows || []).forEach(rowObj => {
    const img = rowObj.__image;
    const rowIdx = r - 1;                      // 0-based, for the drawing anchor
    let attrs = '';
    if (img && imgColIdx >= 0) {
      attrs = ` ht="${(img.h * PT_PER_PX).toFixed(2)}" customHeight="1"`;
      const rel = mediaSink(img);
      anchors.push({ colIdx: imgColIdx, rowIdx, w: img.w, h: img.h, rel });
    }
    const cells = headers.map((h, i) => {
      const ref = colLetter(i) + r;
      const target = rowObj.__links && rowObj.__links[h];
      if (target) {
        links.push({ ref, target });
        return cellXml(ref, rowObj[h] ?? '', 4);
      }
      return cellXml(ref, rowObj[h] ?? '', 0);
    }).join('');
    emit(cells, attrs);
  });

  // <cols> must precede <sheetData>; <hyperlinks> and <drawing> must follow it,
  // in that order, or Excel rejects the part.
  let cols = '';
  if (spec.colWidths) {
    const parts = Object.keys(spec.colWidths).map(name => {
      const i = headers.indexOf(name);
      if (i < 0) return '';
      return `<col min="${i + 1}" max="${i + 1}" width="${spec.colWidths[name]}" customWidth="1"/>`;
    }).join('');
    if (parts) cols = `<cols>${parts}</cols>`;
  }

  const sheetRels = [];
  let hyperXml = '';
  if (links.length) {
    hyperXml = '<hyperlinks>' + links.map(l => {
      const id = `rIdL${sheetRels.length + 1}`;
      sheetRels.push({ id, type: 'hyperlink', target: l.target, external: true });
      return `<hyperlink ref="${l.ref}" r:id="${id}"/>`;
    }).join('') + '</hyperlinks>';
  }

  let drawingXml = '', drawingPart = null;
  if (anchors.length) {
    const id = `rIdD`;
    sheetRels.push({ id, type: 'drawing', target: `../drawings/drawing${sheetIndex}.xml` });
    drawingXml = `<drawing r:id="${id}"/>`;
    drawingPart = buildDrawing(anchors, sheetIndex);
  }

  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"` +
    ` xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `${cols}<sheetData>${body}</sheetData>${hyperXml}${drawingXml}</worksheet>`;

  return { xml, sheetRels, drawingPart };
}

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function buildDrawing(anchors, sheetIndex) {
  const rels = [];
  const body = anchors.map((a, i) => {
    const rid = `rId${i + 1}`;
    rels.push(`<Relationship Id="${rid}" Type="${REL}/image" Target="../media/${a.rel}"/>`);
    const cx = Math.round(a.w * EMU_PER_PX), cy = Math.round(a.h * EMU_PER_PX);
    return `<xdr:oneCellAnchor>` +
      `<xdr:from><xdr:col>${a.colIdx}</xdr:col><xdr:colOff>19050</xdr:colOff>` +
      `<xdr:row>${a.rowIdx}</xdr:row><xdr:rowOff>19050</xdr:rowOff></xdr:from>` +
      `<xdr:ext cx="${cx}" cy="${cy}"/>` +
      `<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${i + 1}" name="Creative ${i + 1}"/><xdr:cNvPicPr/></xdr:nvPicPr>` +
      `<xdr:blipFill><a:blip xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" r:embed="${rid}"/>` +
      `<a:stretch xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:fillRect/></a:stretch></xdr:blipFill>` +
      `<xdr:spPr><a:xfrm xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
      `<a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
      `<a:prstGeom xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>` +
      `</xdr:pic><xdr:clientData/></xdr:oneCellAnchor>`;
  }).join('');

  return {
    index: sheetIndex,
    xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"` +
      ` xmlns:r="${REL}">${body}</xdr:wsDr>`,
    relsXml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`,
  };
}

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="5"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><b/><sz val="12"/><color rgb="FF137333"/><name val="Calibri"/></font><font><b/><name val="Calibri"/></font><font><u/><color rgb="FF1A73E8"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1A73E8"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

/* Full package assembly for rich sheets. Returns the zipped bytes. */
function buildWorkbook(sheets) {
  const media = [];   // { name, bytes }
  const seen = new Map();
  const mediaSink = (img) => {
    // Identical screenshots (rare, but possible) are stored once.
    const key = img.bytes.length + ':' + img.w + 'x' + img.h;
    if (seen.has(key)) return seen.get(key);
    const name = `image${media.length + 1}.${img.ext || 'jpeg'}`;
    media.push({ name, bytes: img.bytes });
    seen.set(key, name);
    return name;
  };

  const built = sheets.map((s, i) => buildRichSheet(s, i + 1, mediaSink));

  const sheetsMeta = sheets.map((s, i) =>
    `<sheet name="${_xEsc(s.name).slice(0, 31)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('');
  const wbRels = sheets.map((_, i) =>
    `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
    + `<Relationship Id="rId${sheets.length + 1}" Type="${REL}/styles" Target="styles.xml"/>`;

  const exts = new Set(media.map(m => m.name.split('.').pop()));
  const defaults = [...exts].map(e =>
    `<Default Extension="${e}" ContentType="image/${e === 'jpg' ? 'jpeg' : e}"/>`).join('');
  const overrides = sheets.map((_, i) =>
    `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
    + built.filter(b => b.drawingPart).map(b =>
      `<Override PartName="/xl/drawings/drawing${b.drawingPart.index}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`).join('');

  const enc = new TextEncoder();
  const files = [];
  const text = (name, s) => files.push({ name, data: enc.encode(s) });

  text('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${defaults}<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${overrides}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`);
  text('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  text('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL}"><sheets>${sheetsMeta}</sheets></workbook>`);
  text('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${wbRels}</Relationships>`);
  text('xl/styles.xml', STYLES_XML);

  built.forEach((b, i) => {
    text(`xl/worksheets/sheet${i + 1}.xml`, b.xml);
    if (b.sheetRels.length) {
      const rels = b.sheetRels.map(rl =>
        `<Relationship Id="${rl.id}" Type="${REL}/${rl.type}" Target="${_xEsc(rl.target)}"${rl.external ? ' TargetMode="External"' : ''}/>`).join('');
      text(`xl/worksheets/_rels/sheet${i + 1}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`);
    }
    if (b.drawingPart) {
      text(`xl/drawings/drawing${b.drawingPart.index}.xml`, b.drawingPart.xml);
      text(`xl/drawings/_rels/drawing${b.drawingPart.index}.xml.rels`, b.drawingPart.relsXml);
    }
  });

  media.forEach(m => files.push({ name: `xl/media/${m.name}`, data: m.bytes }));

  return zipStore(files);
}

// Assemble the OOXML package parts and zip them into a real .xlsx.
function buildXlsx(sheetNames, sheetXmls) {
  const sheetsMeta = sheetNames.map((n, i) => `<sheet name="${_xEsc(n).slice(0, 31)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('');
  const wbRels = sheetNames.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
    + `<Relationship Id="rId${sheetNames.length + 1}" Type="${REL}/styles" Target="styles.xml"/>`;
  const overrides = sheetNames.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('');

  const files = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${overrides}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL}"><sheets>${sheetsMeta}</sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${wbRels}</Relationships>`],
    ['xl/styles.xml', STYLES_XML],
  ];
  sheetXmls.forEach((xml, i) => files.push([`xl/worksheets/sheet${i + 1}.xml`, xml]));

  const enc = new TextEncoder();
  return zipStore(files.map(([name, content]) => ({ name, data: enc.encode(content) })));
}

// ── Minimal ZIP writer (store / no compression) ───────────────────────────
const _CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
  return t;
})();
function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = _CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function zipStore(files) {
  const u16 = n => [n & 255, (n >> 8) & 255];
  const u32 = n => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const crc = crc32(f.data), len = f.data.length;
    const local = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(crc), ...u32(len), ...u32(len), ...u16(nameBytes.length), ...u16(0)]);
    parts.push(local, nameBytes, f.data);
    const cd = new Uint8Array([0x50, 0x4b, 0x01, 0x02, ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(crc), ...u32(len), ...u32(len), ...u16(nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset)]);
    central.push(cd, nameBytes);
    offset += local.length + nameBytes.length + len;
  }
  let cdSize = 0; central.forEach(c => cdSize += c.length);
  const end = new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(cdSize), ...u32(offset), ...u16(0)]);
  const all = [...parts, ...central, end];
  let total = 0; all.forEach(a => total += a.length);
  const out = new Uint8Array(total);
  let p = 0; all.forEach(a => { out.set(a, p); p += a.length; });
  return out;
}

// Node test harness only; in the extension these are plain globals.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildWorkbook, buildXlsx, buildSheetXml, colLetter, cellXml, zipStore, crc32 };
}
