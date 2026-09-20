/**
 * Runs in the page's own JavaScript world so it can see the JSON Instagram
 * already fetches for the pages you open. It reads those responses, it never
 * makes requests of its own.
 *
 * Anything that looks like it contains posts is forwarded to the extension's
 * content script via window.postMessage; all the parsing happens there.
 */
(() => {
  const TAG = 'SAVED_LIBRARY_PAYLOAD';

  // Cheap pre-filter: only forward bodies that plausibly contain posts, so we
  // aren't shipping every analytics ping across the world boundary.
  const looksLikePosts = (text) =>
    text.length > 200 &&
    (text.includes('"shortcode"') || text.includes('"code"')) &&
    (text.includes('image_versions2') ||
      text.includes('display_url') ||
      text.includes('thumbnail_src') ||
      text.includes('carousel_media') ||
      text.includes('video_versions'));

  const forward = (url, text) => {
    if (!looksLikePosts(text)) return;
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return; // not JSON (or a streamed fragment) — ignore
    }
    try {
      window.postMessage({ __tag: TAG, url, payload: json }, window.location.origin);
    } catch {
      // Payload could not be structured-cloned. Nothing useful to do.
    }
  };

  // --- fetch ---------------------------------------------------------------
  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function patchedFetch(...args) {
      return originalFetch.apply(this, args).then((response) => {
        try {
          const url = response.url || String(args[0]);
          if (url.includes('instagram.com')) {
            // Read from a clone so the page still gets an unconsumed body.
            response
              .clone()
              .text()
              .then((text) => forward(url, text))
              .catch(() => {});
          }
        } catch {}
        return response;
      });
    };
  }

  // --- XMLHttpRequest ------------------------------------------------------
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
    this.__savedLibraryUrl = url;
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function patchedSend(...args) {
    this.addEventListener('load', () => {
      try {
        const url = String(this.__savedLibraryUrl || '');
        if (!url.includes('instagram.com') && !url.startsWith('/')) return;
        if (this.responseType && this.responseType !== 'text' && this.responseType !== 'json') return;
        const text =
          this.responseType === 'json' ? JSON.stringify(this.response) : this.responseText;
        if (typeof text === 'string') forward(url, text);
      } catch {}
    });
    return originalSend.apply(this, args);
  };
})();
