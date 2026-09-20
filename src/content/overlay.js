/**
 * The little panel that appears on your Saved pages. Its whole job is the
 * "scan" — scrolling the page at a human pace so Instagram loads your saves,
 * while collect.js reads the metadata that comes back.
 *
 * No media is downloaded during a scan. Scanning 2,000 posts costs a few
 * megabytes of text, not gigabytes of video.
 */
(() => {
  /** Pause between scroll steps. Slow on purpose — this mimics a person. */
  const SCROLL_PAUSE_MS = 1300;
  /** Stop after this many scrolls in a row produce nothing new. */
  const IDLE_LIMIT = 6;

  let panel = null;
  let scanning = false;
  let lastPath = null;

  const onSavedPage = () => /^\/[^/]+\/saved\b/.test(location.pathname);

  function collectionName() {
    const m = location.pathname.match(/^\/[^/]+\/saved\/?([^/]*)/);
    const slug = decodeURIComponent(m?.[1] || '').trim();
    if (!slug || slug === 'all-posts') return 'All Posts';
    return slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function toast(text) {
    document.getElementById('saved-library-toast')?.remove();
    const el = document.createElement('div');
    el.id = 'saved-library-toast';
    el.textContent = text;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3600);
  }

  function render() {
    if (!panel) return;
    const found = window.__savedLibrary?.added || 0;
    panel.querySelector('.sl-collection').textContent = `Collection: ${collectionName()}`;
    panel.querySelector('.sl-count').textContent = String(found);
    panel.querySelector('.sl-scan').textContent = scanning ? 'Stop scanning' : 'Scan this collection';
    panel.querySelector('.sl-scan').className = scanning ? 'sl-scan sl-secondary' : 'sl-scan sl-primary';
    panel.querySelector('.sl-hint').textContent = scanning
      ? 'Scrolling your saves. Leave this tab open.'
      : 'Scanning reads captions only — no files are downloaded yet.';
  }

  function build() {
    if (panel) return;
    panel = document.createElement('div');
    panel.id = 'saved-library-panel';
    panel.innerHTML = `
      <button class="sl-min" type="button" title="Hide">–</button>
      <div class="sl-head"><span class="sl-dot"></span><span class="sl-title">Saved Library</span></div>
      <div class="sl-body">
        <div class="sl-collection"></div>
        <div class="sl-count">0</div>
        <div class="sl-count-label">posts found in this scan</div>
        <button type="button" class="sl-scan sl-primary">Scan this collection</button>
        <button type="button" class="sl-open sl-secondary">Open my library</button>
        <div class="sl-hint"></div>
      </div>`;
    document.body.appendChild(panel);

    panel.querySelector('.sl-scan').addEventListener('click', () => (scanning ? stopScan() : startScan()));
    panel.querySelector('.sl-open').addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'dashboard:open' }, () => void chrome.runtime.lastError);
    });
    panel.querySelector('.sl-min').addEventListener('click', () => {
      panel.classList.toggle('sl-collapsed');
      panel.querySelector('.sl-min').textContent = panel.classList.contains('sl-collapsed') ? '+' : '–';
    });

    if (window.__savedLibrary) window.__savedLibrary.onChange = render;
    render();
  }

  function remove() {
    stopScan();
    panel?.remove();
    panel = null;
  }

  async function startScan() {
    if (scanning) return;
    scanning = true;
    render();

    let idle = 0;
    let lastCount = window.__savedLibrary?.added || 0;
    let lastHeight = 0;

    while (scanning && idle < IDLE_LIMIT) {
      window.scrollBy(0, Math.round(window.innerHeight * 0.85));
      await sleep(SCROLL_PAUSE_MS);
      render();

      const count = window.__savedLibrary?.added || 0;
      const height = document.documentElement.scrollHeight;
      if (count > lastCount || height > lastHeight) {
        lastCount = count;
        lastHeight = height;
        idle = 0;
      } else {
        idle++;
      }
    }

    const total = window.__savedLibrary?.added || 0;
    if (scanning) toast(`Scan finished — ${total} post${total === 1 ? '' : 's'} in your library`);
    scanning = false;
    render();
  }

  function stopScan() {
    scanning = false;
    render();
  }

  function sync() {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    if (onSavedPage()) {
      if (document.body) build();
      else document.addEventListener('DOMContentLoaded', build, { once: true });
      render();
    } else {
      remove();
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'toast') toast(msg.text);
  });

  // Instagram is a single-page app, so watch for navigation rather than relying
  // on page loads.
  setInterval(sync, 700);
  sync();
})();
