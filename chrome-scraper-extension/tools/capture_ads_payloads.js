/* Capture the real API payloads behind Meta Ad Library / Google Ads Transparency
 * Center, so parsers can be written against actual data instead of guesswork.
 *
 * HOW TO USE
 *   1. Open one of these in Chrome, logged in as normal:
 *        https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=IN&q=samsung
 *        https://adstransparency.google.com/?region=IN
 *   2. F12 -> Console. Chrome may refuse the first paste; type  allow pasting  then Enter.
 *   3. Paste this whole file, press Enter. You should see: [capture] armed.
 *   4. Scroll the results for ~15-20 seconds so the page loads more pages of ads.
 *   5. Run:  __ssCapture.save()
 *      A .json file downloads. Send that file over.
 *
 * WHAT IT DOES / DOES NOT DO
 *   - Reads only responses the page itself requested. It issues no requests of its own.
 *   - Nothing is uploaded anywhere. save() writes a local file, that is all.
 *   - Request bodies and headers are NOT recorded, so no tokens or cookies are captured.
 *   - Long responses are truncated (see MAX_CHARS) to keep the file sendable.
 *   - scrub() removes obvious account identifiers before writing. It is best-effort:
 *     please skim the file before sending it.
 */
(function () {
  if (window.__ssCapture) { console.log('[capture] already armed'); return; }

  var MAX_CHARS = 400000;   // per response
  var MAX_HITS = 80;        // total responses kept
  var hits = [];

  // Only these URLs are of interest. Everything else is ignored outright.
  function wanted(url) {
    return /\/api\/graphql|\/graphql\/?($|\?)|ads\/library|ad_library|\/anji\/_\/rpc\/|SearchCreatives|SearchAds|adstransparency/i.test(url);
  }

  function scrub(text) {
    return String(text)
      .replace(/"(access_token|fb_dtsg|jazoest|__user|lsd|spin_t|__spin_t|session_id|csrf[^"]*)"\s*:\s*"[^"]*"/gi, '"$1":"<removed>"')
      .replace(/([?&](?:access_token|__user|fb_dtsg|lsd|jazoest|authuser)=)[^&"'\s]*/gi, '$1<removed>');
  }

  function record(url, status, body) {
    if (hits.length >= MAX_HITS || !wanted(url)) return;
    var text = String(body == null ? '' : body);
    if (!text) return;
    hits.push({
      url: String(url).split('?')[0],       // query string dropped on purpose
      status: status,
      truncated: text.length > MAX_CHARS,
      length: text.length,
      body: scrub(text.slice(0, MAX_CHARS)),
    });
    console.log('[capture] kept', hits.length, String(url).split('?')[0]);
  }

  // ── fetch ────────────────────────────────────────────────────────────────
  var origFetch = window.fetch;
  window.fetch = function () {
    var args = arguments;
    var url = (args[0] && args[0].url) || args[0] || '';
    return origFetch.apply(this, args).then(function (res) {
      if (wanted(url)) {
        // clone() so the page still gets to read its own response
        try { res.clone().text().then(function (t) { record(url, res.status, t); }, function () {}); }
        catch (e) {}
      }
      return res;
    });
  };

  // ── XMLHttpRequest ───────────────────────────────────────────────────────
  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__ssUrl = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var xhr = this;
    if (wanted(xhr.__ssUrl || '')) {
      xhr.addEventListener('load', function () {
        try { record(xhr.__ssUrl, xhr.status, xhr.responseText); } catch (e) {}
      });
    }
    return origSend.apply(this, arguments);
  };

  window.__ssCapture = {
    get count() { return hits.length; },
    peek: function (i) { return hits[i || 0]; },
    clear: function () { hits = []; console.log('[capture] cleared'); },
    save: function () {
      if (!hits.length) {
        console.warn('[capture] nothing captured yet - scroll the results, then try again');
        return;
      }
      var out = {
        site: location.hostname,
        page: location.pathname,
        capturedAt: new Date().toISOString(),
        note: 'Request bodies and headers were never recorded. Responses are scrubbed and truncated.',
        responses: hits,
      };
      var blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'ads-capture-' + location.hostname + '-' + Date.now() + '.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      console.log('[capture] saved', hits.length, 'responses');
    },
  };

  console.log('[capture] armed. Scroll the ad results, then run: __ssCapture.save()');
})();
