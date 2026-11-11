/* Post date recovery that needs no network request.
 *
 * Instagram encodes a post's creation time inside its own URL. The shortcode
 * in /p/<code>/ or /reel/<code>/ is the numeric media id written in a
 * URL-safe base64 alphabet, and the top 41 bits of that id are the creation
 * time in milliseconds since Instagram's epoch. So the grid already tells us
 * when every post was published - we just have to read it.
 *
 * This matters because Instagram's grid DOM carries no date at all, and its
 * API only sometimes does. Measured on a real 204-row export, dates arrived
 * for about 7% of rows. This takes that to 100%, offline, instantly.
 *
 * YouTube has no equivalent trick, but its grid prints a relative date on
 * every video ("5 days ago"), so that is parsed here too.
 *
 * Shared by the content script (to decide when a scroll has passed the user's
 * date cutoff) and the popup (to fill the Date column).
 */
(function (root) {
  'use strict';

  var ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

  // Verified against the published shortcode<->id test vectors.
  var IG_EPOCH_MS = 1314220021721;

  function shortcodeToId(sc) {
    if (!sc || typeof sc !== 'string') return null;
    var n = 0n;
    for (var i = 0; i < sc.length; i++) {
      var v = ALPHA.indexOf(sc[i]);
      if (v < 0) return null;
      n = n * 64n + BigInt(v);
    }
    return n;
  }

  /* Instagram shortcodes are 11 characters (older ones 10). Anything far off
   * that is not a post code - guard against matching profile or tag paths. */
  function igDateFromShortcode(sc) {
    if (!sc || sc.length < 5 || sc.length > 12) return null;
    var id = shortcodeToId(sc);
    if (id === null) return null;
    var ms = Number((id >> 23n) + BigInt(IG_EPOCH_MS));
    // Sanity window: Instagram launched in 2010; reject anything implausible
    // rather than emit a date from 1970 or 2090.
    if (!isFinite(ms) || ms < 1262304000000 || ms > Date.now() + 86400000 * 2) return null;
    return new Date(ms);
  }

  function igShortcodeFromUrl(url) {
    var m = String(url || '').match(/instagram\.com\/(?:[^/]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
    return m ? m[1] : null;
  }

  function igDateFromUrl(url) {
    return igDateFromShortcode(igShortcodeFromUrl(url));
  }

  // ── YouTube: relative text in the grid ───────────────────────────────────
  var REL_UNITS = {
    second: 1000, minute: 60000, hour: 3600000, day: 86400000,
    week: 604800000, month: 2629800000, year: 31557600000,
  };

  // YouTube renders both the long form ("5 days ago") and, in the grid, a
  // compact one ("5d ago"). Real exports are full of the compact form, so both
  // must parse. Note "m" is minutes but "mo" is months.
  var ABBREV = { s: 'second', m: 'minute', h: 'hour', d: 'day', w: 'week', mo: 'month', y: 'year' };

  /* "5 days ago" or "5d ago" -> a Date, plus how precise that actually is.
   * Streamed and premiered items carry a prefix ("Streamed 3 weeks ago"), so
   * the match is not anchored to the start. */
  function dateFromRelative(text, now) {
    var t = String(text || '');
    var unit = null, qty = null;
    var m = t.match(/(\d+)\s*(second|minute|hour|day|week|month|year)s?\s+ago/i);
    if (m) { qty = Number(m[1]); unit = m[2].toLowerCase(); }
    else {
      // compact: 45m, 20h, 5d, 3w, 2mo, 1y - "mo" must win over "m"
      m = t.match(/(\d+)\s*(mo|[smhdwy])\s+ago/i);
      if (!m) return null;
      qty = Number(m[1]); unit = ABBREV[m[2].toLowerCase()];
      if (!unit) return null;
    }
    var ms = (now || Date.now()) - qty * REL_UNITS[unit];
    return {
      date: new Date(ms),
      // Anything coarser than a day is an estimate, and the UI should say so.
      precision: (unit === 'month' || unit === 'year') ? 'approx' : 'day',
    };
  }

  function ymd(d) {
    if (!d || isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  /* Best available date for a row, cheapest source first. Returns
   * { date, ymd, source, precision } or null. An exact value already on the
   * row always wins - this never overwrites something the API supplied. */
  function resolvePostDate(row, now) {
    if (row && row.Date && /^\d{4}-\d{2}-\d{2}/.test(row.Date)) {
      return { date: new Date(row.Date), ymd: row.Date.slice(0, 10), source: 'existing', precision: 'day' };
    }
    var d = igDateFromUrl(row && row.URL);
    // Checked against 29 dates from real exports: 26 matched to the day. The
    // three that did not were each exactly one day EARLY, at posting times
    // indistinguishable from the ones that matched - i.e. the shortcode
    // carries the media's CREATION time, which for a scheduled post precedes
    // publication. The error is bounded and one-directional, never late, so
    // callers widen the start of a date range by UPLOAD_SKEW_DAYS.
    if (d) return { date: d, ymd: ymd(d), source: 'shortcode', precision: 'upload' };
    var rel = dateFromRelative((row && (row._relativeDate || row.Date)) || '', now);
    if (rel) return { date: rel.date, ymd: ymd(rel.date), source: 'relative', precision: rel.precision };
    return null;
  }

  // How far a shortcode-derived date can precede the published date.
  var UPLOAD_SKEW_DAYS = 1;

  /* Is this row inside the user's window? `from`/`to` are YYYY-MM-DD strings,
   * either may be empty. A date we derived from the shortcode gets the start
   * of the range widened, so a post scheduled the day after upload is not
   * silently dropped. Rows with no date at all are kept and flagged, never
   * discarded - a filter that quietly drops what it could not read is worse
   * than no filter. */
  function inDateRange(resolved, from, to) {
    if (!resolved) return { keep: true, undated: true };
    var pad = resolved.source === 'shortcode' ? UPLOAD_SKEW_DAYS : 0;
    var t = resolved.date.getTime();
    if (from) {
      var lo = new Date(from + 'T00:00:00').getTime() - pad * 86400000;
      if (t < lo) return { keep: false, undated: false };
    }
    if (to) {
      var hi = new Date(to + 'T23:59:59').getTime() + pad * 86400000;
      if (t > hi) return { keep: false, undated: false };
    }
    return { keep: true, undated: false };
  }

  var API = {
    inDateRange: inDateRange,
    UPLOAD_SKEW_DAYS: UPLOAD_SKEW_DAYS,
    shortcodeToId: shortcodeToId,
    igDateFromShortcode: igDateFromShortcode,
    igShortcodeFromUrl: igShortcodeFromUrl,
    igDateFromUrl: igDateFromUrl,
    dateFromRelative: dateFromRelative,
    resolvePostDate: resolvePostDate,
    ymd: ymd,
    IG_EPOCH_MS: IG_EPOCH_MS,
  };

  root.ScrapeSuiteDates = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
