/**
 * Tests the post normaliser in src/content/collect.js against the two response
 * shapes Instagram has used. Run with:  node tests/normalize.test.mjs
 *
 * collect.js is a content script, not a module, so we load it into a sandbox
 * with the handful of browser APIs it touches stubbed out.
 */
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'src', 'content', 'collect.js'), 'utf8');

function loadCollector(pathname) {
  const sent = [];
  const listeners = {};

  const windowStub = {
    addEventListener: (type, handler) => {
      listeners[type] = handler;
    },
    location: { pathname, href: `https://www.instagram.com${pathname}` },
  };

  const context = {
    window: windowStub,
    location: windowStub.location,
    document: { addEventListener() {} },
    chrome: {
      runtime: {
        lastError: null,
        sendMessage: (message, callback) => {
          sent.push(message);
          callback?.();
        },
        onMessage: { addListener() {} },
      },
    },
  };
  context.window.window = windowStub;
  createContext(context);
  runInContext(source, context);

  return {
    sent,
    api: () => windowStub.__savedLibrary,
    deliver(payload) {
      listeners.message({
        source: windowStub,
        data: { __tag: 'SAVED_LIBRARY_PAYLOAD', url: 'https://www.instagram.com/api/v1/feed/saved/', payload },
      });
    },
  };
}

// --- fixtures --------------------------------------------------------------

/** Newer private-API shape: items[] with code / image_versions2 / video_versions. */
const apiShape = {
  items: [
    {
      media: {
        code: 'Cx1video',
        taken_at: 1700000000,
        caption: { text: 'How we cut CAC by 40% 🎯\n\nFull breakdown in comments' },
        user: { username: 'growthmarketer', full_name: 'Growth Marketer' },
        like_count: 1820,
        comment_count: 64,
        play_count: 51000,
        image_versions2: {
          candidates: [
            { url: 'https://cdn.example/thumb_small.jpg', width: 240, height: 240 },
            { url: 'https://cdn.example/thumb_big.jpg', width: 1080, height: 1080 },
          ],
        },
        video_versions: [
          { url: 'https://cdn.example/video_low.mp4', width: 480 },
          { url: 'https://cdn.example/video_hd.mp4', width: 1080 },
        ],
      },
    },
    {
      media: {
        code: 'Cx2carousel',
        taken_at: 1700100000,
        caption: { text: '7 hooks that work' },
        user: { username: 'copychief', full_name: 'Copy Chief' },
        carousel_media: [
          { image_versions2: { candidates: [{ url: 'https://cdn.example/c1.jpg', width: 1080 }] } },
          { image_versions2: { candidates: [{ url: 'https://cdn.example/c2.jpg', width: 1080 }] } },
          {
            image_versions2: { candidates: [{ url: 'https://cdn.example/c3.jpg', width: 1080 }] },
            video_versions: [{ url: 'https://cdn.example/c3.mp4', width: 1080 }],
          },
        ],
      },
    },
  ],
};

/** Older GraphQL shape: edges/nodes with shortcode / display_url. */
const graphqlShape = {
  data: {
    user: {
      edge_saved_media: {
        edges: [
          {
            node: {
              shortcode: 'Gq1photo',
              taken_at_timestamp: 1699000000,
              display_url: 'https://cdn.example/photo.jpg',
              thumbnail_src: 'https://cdn.example/photo_thumb.jpg',
              dimensions: { width: 1080, height: 1350 },
              owner: { username: 'designstudio', full_name: 'Design Studio' },
              edge_media_to_caption: { edges: [{ node: { text: 'Packaging refresh for a tea brand' } }] },
              edge_media_preview_like: { count: 402 },
              edge_media_to_comment: { count: 11 },
            },
          },
          {
            node: {
              shortcode: 'Gq2sidecar',
              taken_at_timestamp: 1699500000,
              display_url: 'https://cdn.example/side.jpg',
              owner: { username: 'designstudio' },
              edge_sidecar_to_children: {
                edges: [
                  { node: { display_url: 'https://cdn.example/s1.jpg' } },
                  { node: { display_url: 'https://cdn.example/s2.jpg', is_video: true, video_url: 'https://cdn.example/s2.mp4' } },
                ],
              },
            },
          },
        ],
      },
    },
  },
};

// --- tests -----------------------------------------------------------------

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('reads the newer API shape, picking the highest-quality media', () => {
  const c = loadCollector('/marketer/saved/all-posts/');
  c.deliver(apiShape);

  assert.equal(c.sent.length, 1);
  const posts = c.sent[0].posts;
  assert.equal(posts.length, 2, 'carousel children must not become separate posts');

  const video = posts.find((p) => p.shortcode === 'Cx1video');
  assert.equal(video.type, 'video');
  assert.equal(video.media.length, 1);
  assert.equal(video.media[0].url, 'https://cdn.example/video_hd.mp4', 'should pick the widest video');
  assert.equal(video.thumbUrl, 'https://cdn.example/thumb_big.jpg', 'should pick the widest thumbnail');
  assert.equal(video.username, 'growthmarketer');
  assert.equal(video.fullName, 'Growth Marketer');
  assert.equal(video.takenAt, 1700000000);
  assert.match(video.caption, /cut CAC by 40%/);
  assert.equal(video.likeCount, 1820);
  assert.equal(video.commentCount, 64);
  assert.equal(video.viewCount, 51000);
  assert.equal(video.url, 'https://www.instagram.com/p/Cx1video/');

  const carousel = posts.find((p) => p.shortcode === 'Cx2carousel');
  assert.equal(carousel.type, 'carousel');
  assert.equal(carousel.media.length, 3, 'every carousel slide is a file');
  assert.equal(carousel.media[2].kind, 'video', 'a video slide downloads as video, not its poster');
  assert.equal(carousel.media[2].url, 'https://cdn.example/c3.mp4');
});

test('reads the older GraphQL shape', () => {
  const c = loadCollector('/marketer/saved/all-posts/');
  c.deliver(graphqlShape);

  const posts = c.sent[0].posts;
  assert.equal(posts.length, 2);

  const photo = posts.find((p) => p.shortcode === 'Gq1photo');
  assert.equal(photo.type, 'image');
  assert.equal(photo.media[0].url, 'https://cdn.example/photo.jpg');
  assert.equal(photo.caption, 'Packaging refresh for a tea brand');
  assert.equal(photo.username, 'designstudio');
  assert.equal(photo.takenAt, 1699000000);
  assert.equal(photo.likeCount, 402);
  assert.equal(photo.commentCount, 11);

  const sidecar = posts.find((p) => p.shortcode === 'Gq2sidecar');
  assert.equal(sidecar.type, 'carousel');
  assert.equal(sidecar.media.length, 2);
  assert.equal(sidecar.media[1].url, 'https://cdn.example/s2.mp4');
});

test('tags posts with the collection taken from the page URL', () => {
  const c = loadCollector('/marketer/saved/design-inspo/17901234567/');
  c.deliver(graphqlShape);
  for (const post of c.sent[0].posts) {
    assert.equal(post.collection, 'Design Inspo');
    assert.equal(post.source, 'saved');
    assert.ok(post.firstSeen > 0);
  }
});

test('the plain saved URL is treated as All Posts', () => {
  const c = loadCollector('/marketer/saved/');
  c.deliver(apiShape);
  assert.equal(c.sent[0].posts[0].collection, 'All Posts');
});

test('browsing outside Saved adds nothing to the library', () => {
  const c = loadCollector('/explore/');
  c.deliver(apiShape);
  assert.equal(c.sent.length, 0, 'only Saved pages populate the library');
  assert.ok(c.api().get('Cx1video'), 'but the post stays available for right-click saving');
});

test('the same post is never sent twice in one page session', () => {
  const c = loadCollector('/marketer/saved/all-posts/');
  c.deliver(apiShape);
  c.deliver(apiShape);
  assert.equal(c.sent.length, 1, 'a repeated payload should be ignored');
});

test('payloads with no usable media are skipped', () => {
  const c = loadCollector('/marketer/saved/all-posts/');
  c.deliver({ items: [{ media: { code: 'NoMedia', image_versions2: { candidates: [] } } }] });
  assert.equal(c.sent.length, 0);
});

test('survives junk without throwing', () => {
  const c = loadCollector('/marketer/saved/all-posts/');
  for (const junk of [null, {}, [], { items: null }, { a: { b: { c: 'x' } } }]) c.deliver(junk);
  assert.equal(c.sent.length, 0);
});

// --- runner ----------------------------------------------------------------

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${name}`);
    console.log(`       ${error.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
