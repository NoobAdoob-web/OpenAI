/**
 * Receives raw payloads from the page-world interceptor, finds anything that
 * looks like a post, and normalises it into the shape the library stores.
 *
 * Instagram changes its response shapes fairly often, so nothing here depends
 * on a fixed path. We walk the whole object looking for post-shaped nodes and
 * read each field through a list of fallbacks.
 */
(() => {
  const TAG = 'SAVED_LIBRARY_PAYLOAD';
  const MAX_DEPTH = 12;

  /** Posts seen anywhere on instagram.com, kept for the right-click action. */
  const seen = new Map(); // shortcode -> normalised post
  /** Shortcodes already sent to the library this page-load (avoids re-sending). */
  const sent = new Set();

  const api = {
    added: 0,
    onChange: null,
    get(shortcode) {
      return seen.get(shortcode) || null;
    },
  };
  window.__savedLibrary = api;

  // --- where are we? -------------------------------------------------------

  function savedContext() {
    // /<user>/saved/            -> All Posts
    // /<user>/saved/<slug>/<id>/ -> that collection
    const m = location.pathname.match(/^\/[^/]+\/saved\/?([^/]*)/);
    if (!m) return null;
    const slug = decodeURIComponent(m[1] || '').trim();
    if (!slug || slug === 'all-posts') return 'All Posts';
    return slug
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  // --- normalising ---------------------------------------------------------

  const isPostNode = (n) =>
    n &&
    typeof n === 'object' &&
    !Array.isArray(n) &&
    (typeof n.shortcode === 'string' || typeof n.code === 'string') &&
    (n.image_versions2 ||
      n.display_url ||
      n.thumbnail_src ||
      n.carousel_media ||
      n.video_versions ||
      n.edge_sidecar_to_children);

  function bestCandidate(list) {
    if (!Array.isArray(list) || !list.length) return null;
    return list.reduce((a, b) => ((b?.width || 0) > (a?.width || 0) ? b : a));
  }

  function imageOf(node) {
    const c = bestCandidate(node?.image_versions2?.candidates);
    if (c?.url) return { kind: 'image', url: c.url, width: c.width, height: c.height };
    const url = node?.display_url || node?.thumbnail_src || node?.display_src;
    return url ? { kind: 'image', url, width: node?.dimensions?.width, height: node?.dimensions?.height } : null;
  }

  function videoOf(node) {
    const v = bestCandidate(node?.video_versions);
    if (v?.url) return { kind: 'video', url: v.url, width: v.width, height: v.height };
    if (node?.video_url) return { kind: 'video', url: node.video_url };
    return null;
  }

  function childrenOf(node) {
    if (Array.isArray(node?.carousel_media)) return node.carousel_media;
    const edges = node?.edge_sidecar_to_children?.edges;
    if (Array.isArray(edges)) return edges.map((e) => e?.node).filter(Boolean);
    return [];
  }

  function captionOf(node) {
    if (typeof node?.caption?.text === 'string') return node.caption.text;
    if (typeof node?.caption === 'string') return node.caption;
    const edge = node?.edge_media_to_caption?.edges?.[0]?.node?.text;
    if (typeof edge === 'string') return edge;
    return '';
  }

  function ownerOf(node) {
    const o = node?.user || node?.owner || {};
    return {
      username: o.username || node?.username || '',
      fullName: o.full_name || '',
    };
  }

  function countOf(...values) {
    for (const v of values) {
      if (typeof v === 'number') return v;
      if (typeof v?.count === 'number') return v.count;
    }
    return null;
  }

  function normalise(node) {
    const shortcode = node.shortcode || node.code;
    if (!shortcode) return null;

    const kids = childrenOf(node);
    let media = [];

    if (kids.length) {
      for (const kid of kids) {
        const m = videoOf(kid) || imageOf(kid);
        if (m) media.push(m);
      }
    } else {
      const v = videoOf(node);
      if (v) media.push(v);
      const i = imageOf(node);
      if (i && !v) media.push(i);
    }
    media = media.filter((m) => m && typeof m.url === 'string');
    if (!media.length) return null;

    const isVideo = media.some((m) => m.kind === 'video');
    const type = kids.length > 1 ? 'carousel' : isVideo ? 'video' : 'image';
    const owner = ownerOf(node);
    const takenAt =
      node.taken_at ||
      node.taken_at_timestamp ||
      node.device_timestamp ||
      null;

    return {
      shortcode,
      url: `https://www.instagram.com/p/${shortcode}/`,
      type,
      caption: captionOf(node),
      username: owner.username,
      fullName: owner.fullName,
      takenAt: typeof takenAt === 'number' ? (takenAt > 1e12 ? Math.round(takenAt / 1000) : takenAt) : null,
      thumbUrl: (imageOf(kids[0] || node) || media[0]).url,
      media,
      likeCount: countOf(node.like_count, node.edge_media_preview_like),
      commentCount: countOf(node.comment_count, node.edge_media_to_comment),
      viewCount: countOf(node.play_count, node.view_count, node.video_view_count),
      isVideo,
    };
  }

  function walk(value, found, depth = 0) {
    if (!value || typeof value !== 'object' || depth > MAX_DEPTH) return found;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, found, depth + 1);
      return found;
    }
    if (isPostNode(value)) {
      const post = normalise(value);
      if (post) found.push(post);
      // A carousel's children are not separate posts, so don't descend into them.
      for (const [key, child] of Object.entries(value)) {
        if (key === 'carousel_media' || key === 'edge_sidecar_to_children') continue;
        walk(child, found, depth + 1);
      }
      return found;
    }
    for (const child of Object.values(value)) walk(child, found, depth + 1);
    return found;
  }

  // --- intake --------------------------------------------------------------

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__tag !== TAG) return;

    let posts = [];
    try {
      posts = walk(data.payload, []);
    } catch {
      return;
    }
    if (!posts.length) return;

    const collection = savedContext();
    for (const post of posts) seen.set(post.shortcode, post);

    // Only posts discovered while browsing the Saved pages enter the library
    // automatically. Everything else stays in memory for the right-click action.
    if (!collection) return;

    const fresh = posts.filter((p) => !sent.has(p.shortcode));
    if (!fresh.length) return;
    for (const p of fresh) sent.add(p.shortcode);

    const now = Date.now();
    const records = fresh.map((p) => ({ ...p, collection, source: 'saved', firstSeen: now }));

    chrome.runtime.sendMessage({ type: 'posts:add', posts: records }, () => {
      if (chrome.runtime.lastError) return; // service worker asleep; next batch retries
      api.added = sent.size;
      api.onChange?.(api.added);
    });
  });

  // --- right-click capture -------------------------------------------------

  let lastRightClicked = null;
  document.addEventListener(
    'contextmenu',
    (e) => {
      lastRightClicked = e.target;
    },
    true
  );

  function shortcodeFromUrl(url) {
    const m = String(url || '').match(/instagram\.com\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
    return m ? m[1] : null;
  }

  function resolveShortcode(info) {
    return (
      shortcodeFromUrl(info?.linkUrl) ||
      shortcodeFromUrl(lastRightClicked?.closest?.('a')?.href) ||
      shortcodeFromUrl(location.href) ||
      shortcodeFromUrl(info?.pageUrl)
    );
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== 'capture:here') return;
    const shortcode = resolveShortcode(msg.info);
    if (!shortcode) {
      sendResponse({ ok: false, reason: 'no-post' });
      return;
    }
    const post = seen.get(shortcode);
    if (!post) {
      sendResponse({ ok: false, reason: 'not-loaded' });
      return;
    }
    sendResponse({
      ok: true,
      post: { ...post, collection: 'Right-click saves', source: 'manual', firstSeen: Date.now() },
    });
  });
})();
