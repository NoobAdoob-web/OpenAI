/* ScrapeSuite – network hook (runs in the PAGE's MAIN world at document_start)
 *
 * Why this exists: on an Instagram/Facebook reels or posts GRID, the tile in the
 * DOM only carries a thumbnail and a view count — the post copy (caption) is not
 * rendered anywhere on the grid. But the page itself fetches that data from its
 * own API/GraphQL endpoints as you scroll. This hook observes those JSON
 * responses (read-only) and forwards the per-post fields we need — caption,
 * upload timestamp, video duration and counts — to the content script.
 *
 * It only reads responses the page has already requested for the logged-in user;
 * it does not issue requests of its own and sends nothing off the device.
 */
(function () {
  'use strict';
  if (window.__SS_NET_HOOK__) return;
  window.__SS_NET_HOOK__ = true;

  var MAX_ITEMS = 400;   // per response, keeps the walk bounded
  var MAX_DEPTH = 14;

  // This hook runs at document_start, but the content script that consumes the
  // data only loads at document_idle. Anything posted in between would be lost,
  // and the two run in separate JS worlds so a shared window property is not an
  // option. So we buffer everything and replay it when the content script says
  // it is ready.
  var BUFFER = Object.create(null);

  function remember(items) {
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it || !it.code) continue;
      var prev = BUFFER[it.code];
      if (!prev) { BUFFER[it.code] = it; continue; }
      var keys = ['caption', 'taken', 'duration', 'views', 'likes', 'comments'];
      for (var k = 0; k < keys.length; k++) {
        var key = keys[k], v = it[key];
        var empty = (v === '' || v === 0 || v === null || v === undefined);
        var prevEmpty = (prev[key] === '' || prev[key] === 0 || prev[key] === undefined);
        if (!empty && prevEmpty) prev[key] = v;
      }
    }
  }
  function flushAll() {
    var all = [];
    for (var c in BUFFER) all.push(BUFFER[c]);
    if (all.length) { try { window.postMessage({ __scrapesuite: 'net', items: all }, '*'); } catch (_) {} }
  }
  // The content script pings when it boots (and before each detect).
  window.addEventListener('message', function (e) {
    if (e.source !== window) return;
    var d = e.data;
    if (d && d.__scrapesuite === 'ready') flushAll();
  }, false);

  function textOfCaption(o) {
    var c = o.caption;
    if (typeof c === 'string') return c;
    if (c && typeof c.text === 'string') return c.text;
    if (o.edge_media_to_caption && o.edge_media_to_caption.edges &&
        o.edge_media_to_caption.edges[0] && o.edge_media_to_caption.edges[0].node &&
        typeof o.edge_media_to_caption.edges[0].node.text === 'string') {
      return o.edge_media_to_caption.edges[0].node.text;
    }
    if (o.caption_text && typeof o.caption_text === 'string') return o.caption_text;
    if (o.title && typeof o.title === 'string' && o.title.length > 12) return o.title;
    if (o.message && typeof o.message === 'string') return o.message;
    if (o.message && o.message.text && typeof o.message.text === 'string') return o.message.text;
    return '';
  }
  function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : null; }
  function pick() {
    for (var i = 0; i < arguments.length; i++) { var v = num(arguments[i]); if (v !== null) return v; }
    return null;
  }

  // Walk any JSON looking for objects that look like a media/post node.
  function collect(obj, out, depth) {
    if (!obj || out.length >= MAX_ITEMS || depth > MAX_DEPTH) return;
    if (Array.isArray(obj)) {
      for (var i = 0; i < obj.length; i++) collect(obj[i], out, depth + 1);
      return;
    }
    if (typeof obj !== 'object') return;

    var code = obj.code || obj.shortcode || obj.short_code;
    var id = obj.pk || obj.id || obj.post_id || obj.video_id;
    if ((typeof code === 'string' && code) || (typeof id === 'string' && /^\d{6,}$/.test(id))) {
      var caption = textOfCaption(obj);
      var taken = pick(obj.taken_at, obj.taken_at_timestamp, obj.device_timestamp,
                       obj.publish_time, obj.creation_time, obj.created_time);
      var dur = pick(obj.video_duration, obj.video_duration_seconds, obj.duration,
                     obj.playable_duration_in_ms ? obj.playable_duration_in_ms / 1000 : null);
      var views = pick(obj.play_count, obj.view_count, obj.video_play_count,
                       obj.ig_play_count, obj.video_view_count);
      var likes = pick(obj.like_count,
                       obj.edge_liked_by && obj.edge_liked_by.count,
                       obj.edge_media_preview_like && obj.edge_media_preview_like.count);
      var comments = pick(obj.comment_count,
                          obj.edge_media_to_comment && obj.edge_media_to_comment.count,
                          obj.edge_media_to_parent_comment && obj.edge_media_to_parent_comment.count);
      if (caption || taken || dur || views !== null || likes !== null || comments !== null) {
        out.push({
          code: (typeof code === 'string' && code) ? code : String(id),
          caption: caption || '',
          taken: taken || 0,
          duration: dur || 0,
          views: views === null ? '' : views,
          likes: likes === null ? '' : likes,
          comments: comments === null ? '' : comments
        });
      }
    }
    for (var k in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      try { collect(obj[k], out, depth + 1); } catch (_) {}
    }
  }

  function scan(text) {
    if (!text || text.length < 40) return;
    if (text.indexOf('caption') < 0 && text.indexOf('taken_at') < 0 &&
        text.indexOf('play_count') < 0 && text.indexOf('shortcode') < 0) return;
    var data = null;
    try { data = JSON.parse(text); }
    catch (_) {
      // Some endpoints prefix JSON with a guard like "for (;;);"
      var i = text.indexOf('{');
      if (i > 0 && i < 24) { try { data = JSON.parse(text.slice(i)); } catch (__) { return; } }
      else return;
    }
    var out = [];
    try { collect(data, out, 0); } catch (_) {}
    if (out.length) {
      remember(out);
      try { window.postMessage({ __scrapesuite: 'net', items: out }, '*'); } catch (_) {}
    }
  }

  // ── patch fetch ────────────────────────────────────────────────────────────
  try {
    var of = window.fetch;
    if (typeof of === 'function') {
      window.fetch = function () {
        var p = of.apply(this, arguments);
        try {
          p.then(function (res) {
            try {
              var ct = (res && res.headers && res.headers.get) ? (res.headers.get('content-type') || '') : '';
              if (/json|javascript|text\/plain/i.test(ct)) {
                res.clone().text().then(scan).catch(function () {});
              }
            } catch (_) {}
            return res;
          }).catch(function () {});
        } catch (_) {}
        return p;
      };
    }
  } catch (_) {}

  // ── patch XMLHttpRequest ───────────────────────────────────────────────────
  try {
    var oOpen = XMLHttpRequest.prototype.open;
    var oSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function () { return oOpen.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function () {
      try {
        this.addEventListener('load', function () {
          try {
            if (this.responseType === '' || this.responseType === 'text') scan(this.responseText);
          } catch (_) {}
        });
      } catch (_) {}
      return oSend.apply(this, arguments);
    };
  } catch (_) {}
})();
